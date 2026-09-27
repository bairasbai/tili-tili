import { lockFinanceAccess,lockDeal,recordPayment } from '../payments/model.js'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, unauthorized } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { notify } from '../notify/notify.js'
import { rolesSeeing } from '../chats/access.js'
import { openLead } from '../vendor/leads.js'
import type { Queryable } from '../plugins/db.js'
import { withIdempotency } from '../deals/idempotency.js'
import { cancelDeal } from '../deals/cancel.js'
import { CREATED_AT_US } from './chats.js'
import {
  DEAL_COLUMNS,
  DEAL_JOINS,
  holdVendorDate,
  loadSlot,
  loadSlots,
  toSlot,
  type SlotRow,
} from '../deals/repo.js'
import { HOLD_HOURS } from '../deals/state.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER
const MONEY_SCHEMA = {
  type: 'object',
  required: ['amount', 'currency'],
  additionalProperties: false,
  properties: {
    amount: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
    currency: { type: 'string', enum: ['RUB'] },
  },
} as const

const EXTERNAL_TTL_DAYS = 30

/**
 * Цена сделки при заведении — больше нуля.
 *
 * Ноль проходил схему (`minimum: 0`) и дальше жил как цена: проверка
 * переплаты в оплате отключена условием `price > 0`, и сделка с ценой 0
 * принимала любые суммы без предела — ERR-0039 с нулём вместо `null`
 * (D2-05, R-53). Схема оставлена общей с `PATCH /deals`, где ноль законен:
 * там он назначается явно и оплату закрывает `no_price`.
 */
function assertPositivePrice(amount: number): void {
  if (amount <= 0) throw new AppError(422, 'bad_amount', 'Цена сделки должна быть больше нуля')
}

export async function slotRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const seesMoney = (role: string | undefined) => role === 'couple'

  /**
   * Погасить все выданные приглашения своего подрядчика в слоте.
   *
   * Ссылка живёт 30 дней и открывает слот, тайминг и чат слота. Пока её
   * отзывала только дверь «Убрать» (`DELETE …/external`), отмена сделки с
   * экрана сделки (`POST …/cancel`, `PATCH /deals`) оставляла токен прежнего
   * подрядчика живым — а фильтр «не старше текущей сделки» открывал ему
   * переписку пары со СЛЕДУЮЩИМ подрядчиком того же слота (ERR-0242).
   */
  async function revokeSlotInvites(client: Queryable, slotId: string): Promise<void> {
    await client.query('update external_invites set revoked_at = now() where slot_id = $1 and revoked_at is null', [
      slotId,
    ])
  }

  /** Слот этой свадьбы или 404. Проверка по weddingId обязательна: без неё
   *  чужой slotId из другой свадьбы прошёл бы по своей матрице доступа. */
  async function slotOf(client: Queryable, weddingId: string, slotId: string) {
    if (!isUuid(slotId)) throw notFound('Слот не найден')
    const { rows } = await client.query<{ id: string; deal_id: string | null; category_id: string }>(
      'select id, deal_id, category_id from slots where id = $1 and wedding_id = $2',
      [slotId, weddingId],
    )
    if (!rows[0]) throw notFound('Слот не найден')
    return rows[0]
  }

  /**
   * Слот под эксклюзивным замком — до вставки сделки (разведка 019, ERR-0317).
   *
   * Бронь вставляла сделку раньше, чем захватывала слот: внешний ключ `deals.slot_id`
   * ставит на строку слота KEY SHARE, а `update slots set deal_id` (колонка с
   * уникальным индексом) требует FOR UPDATE. Две одновременные брони обе держали
   * KEY SHARE и обе ждали FOR UPDATE — детектор взаимных блокировок убивал одну,
   * пара получала 500 вместо 409 (14 пар из 40 на этой машине). Замок первым —
   * вторая бронь ждёт, видит занятый слот и отвечает 409.
   */
  async function lockEmptySlot(client: Queryable, weddingId: string, slotId: string) {
    if (!isUuid(slotId)) throw notFound('Слот не найден')
    const { rows } = await client.query<{ deal_id: string | null }>(
      'select deal_id from slots where id = $1 and wedding_id = $2 for update',
      [slotId, weddingId],
    )
    if (!rows[0]) throw notFound('Слот не найден')
    if (rows[0].deal_id) throw conflict('slot_taken', 'В этом слоте уже есть сделка — сначала отмените её')
  }

  /**
   * Дата свадьбы для захвата у подрядчика — под замком `for share` строки
   * свадьбы: перенос (`rescheduleWedding`) держит её `for update`, и бронь,
   * прочитавшая дату до переноса и записавшая занятость после, занимала у
   * подрядчика день, которого у свадьбы уже нет (ревью 015, D2). Читается
   * до захвата слота — порядок «свадьба → остальное», как у переноса.
   */
  async function weddingDate(client: Queryable, weddingId: string): Promise<string | null> {
    const { rows } = await client.query<{ date: string | null }>(
      'select date::text as date from weddings where id = $1 for share',
      [weddingId],
    )
    return rows[0]?.date ?? null
  }

  /**
   * Заявитель ещё жив — проверка внутри транзакции брони, под замком `for
   * share` его строки `users` (SA-05, сиблинг ERR-0271 / R-271).
   *
   * `preHandler` (`plugins/auth.ts` `assertLiveSession`) видит `deleted_at`
   * на входе, но между ним и этой транзакцией помещается целое удаление
   * аккаунта: `DELETE /users/me` коммитился, а уже пропущенная бронь
   * заводила сделку на стёртый аккаунт — подрядчику доставалась дата,
   * занятая призраком, а пара её не видела. `for update` на своей строке
   * в удалении и `for share` здесь ставят их в очередь: удаление первым —
   * тут виден `deleted_at` и 401; бронь первой — проверка живых сделок в
   * удалении видит сделку и отвечает 409.
   */
  async function assertCallerLive(client: Queryable, userId: string): Promise<void> {
    const { rows } = await client.query<{ deleted_at: Date | null }>(
      'select deleted_at from users where id = $1 for share',
      [userId],
    )
    if (!rows[0] || rows[0].deleted_at) throw unauthorized('Аккаунт удалён')
  }

  /* ── мозаика ──────────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/slots', async (request) =>
    loadSlots(db(), request.member!.weddingId, seesMoney(request.member!.role)),
  )

  /**
   * Слот категории вне шаблона (фича 014, A1).
   *
   * Шаблон мозаики — 12 категорий, каталог знает 35: аниматора, фейерверк
   * или фотобудку было некуда забронировать — кнопка «Добавить в свадьбу»
   * на их анкетах вела в никуда. Слот заводится пустым, подпись — имя
   * категории из справочника, место — в конец мозаики.
   *
   * Свадьба берётся `for update`: уникального индекса (свадьба, категория)
   * у слотов нет — шаблон его не требовал, — и два одновременных «добавить
   * аниматора» иначе заводили бы два слота. Один слот на категорию — не
   * ограничение базы, а правило мозаики, поэтому и держится здесь, под
   * блокировкой строки свадьбы. Повтор — 409 `slot_exists` с `slotId` в
   * `details`: экран ведёт бронь в существующий слот, а не показывает отказ.
   */
  app.post(
    '/weddings/:weddingId/slots',
    {
      schema: {
        body: {
          type: 'object',
          required: ['categoryId'],
          additionalProperties: false,
          properties: { categoryId: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { categoryId } = request.body as { categoryId: string }

      const result = await db().tx(async (client) => {
        await client.query('select id from weddings where id = $1 for update', [weddingId])
        const { rows: cat } = await client.query<{ name: string }>('select name from categories where id = $1', [
          categoryId,
        ])
        if (!cat[0]) {
          throw new AppError(422, 'validation_failed', 'Такой категории нет', { categoryId: 'категория не найдена' })
        }
        const { rows: existing } = await client.query<{ id: string }>(
          'select id from slots where wedding_id = $1 and category_id = $2 order by sort limit 1',
          [weddingId, categoryId],
        )
        if (existing[0]) return { exists: existing[0].id }

        const id = uuidv7()
        await client.query(
          `insert into slots (id, wedding_id, category_id, label, sort)
           values ($1, $2, $3, $4, (select coalesce(max(sort), 0) + 1 from slots where wedding_id = $2))`,
          [id, weddingId, categoryId, cat[0].name],
        )
        return { slot: (await loadSlot(client, id, true))! }
      })
      if ('exists' in result) {
        /* Тело — руками, как 409 `wedding_exists` в `weddings.ts`: единый
         * формат ошибки (`errors.ts`) поля `details` не знает. */
        return reply.code(409).send({
          error: {
            code: 'slot_exists',
            message: 'Слот этой категории уже есть в мозаике',
            details: { slotId: result.exists },
          },
        })
      }
      return reply.code(201).send(result.slot)
    },
  )

  /* ── бронирование ─────────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/slots/:slotId/book',
    {
      schema: {
        body: {
          type: 'object',
          required: ['vendorId', 'price'],
          additionalProperties: false,
          properties: {
            vendorId: UUID_ID,
            packageId: { type: 'string', maxLength: 40 },
            price: MONEY_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { slotId } = request.params as { slotId: string }
      const body = request.body as { vendorId: string; packageId?: string; price: { amount: number } }
      assertPositivePrice(body.price.amount)

      return withIdempotency(db(), request, reply, 'slots.book', (tx) =>
        tx(async (client) => {
          // Свадьба (её дата — под замком) прежде слота: порядок замков как у переноса.
          const date = await weddingDate(client, weddingId)
          // Затем своя строка `users` — тем же порядком, что и удаление аккаунта.
          await assertCallerLive(client, request.caller!.userId)
          // Затем слот — эксклюзивно и до вставки сделки (ERR-0317).
          await lockEmptySlot(client, weddingId, slotId)

          /* Живая анкета: опубликована и не заблокирована модератором — та же
           * граница, что у каталога (`VENDOR_LIVE_JOIN`). Заблокированную
           * (`block`, §18.2) каталог не показывает, а бронь по прямому
           * идентификатору до ревью 015 проходила — и подрядчик, снятый за
           * мошенничество, получал сделку и дату. Категорию анкеты со слотом
           * нарочно не сверяем: фотограф, который снимает и видео, занимает
           * два слота одной анкетой (ERR-0037) — слот выбирает пара. */
          /* `for share of u`: без замка на строке подрядчика эта проверка
            * ничего не сериализует — удаление его аккаунта не трогает свадьбу,
            * где его бронируют, и оба порядка проходили насквозь (SA-05,
            * сторона подрядчика). */
          const { rows: vendor } = await client.query<{ id: string }>(
            `select v.id from vendors v join users u on u.id = v.user_id and u.deleted_at is null
              where v.id = $1 and v.published_at is not null and v.blocked_at is null
              for share of u`,
            [body.vendorId],
          )
          if (!vendor[0]) throw notFound('Подрядчик не найден')

          /* Пакет, если назван, обязан быть пакетом ЭТОГО подрядчика.
           * Раньше поле принималось и молча ничего не делало — класс
           * ERR-0034 (D2-23): чужой или несуществующий пакет — 422, а не
           * бронь «как будто по пакету». Сделка его помнит (`package_id`,
           * фича 005): кабинет и карточка показывают, что именно продано. */
          if (body.packageId !== undefined) {
            // Колонка uuid: строка не той формы роняет запрос драйвером (R-118).
            /* `for key share`: сохранение анкеты подрядчиком удаляет пакеты, и без замка
             * пакет, прочитанный живым, исчезал до вставки сделки — внешний ключ ронял
             * бронь 500 вместо 422 (разведка 019). Замок держит пакет до коммита брони. */
            const { rows: pkg } = new RegExp(UUID_ID.pattern).test(body.packageId)
              ? await client.query('select 1 from vendor_packages where id = $1 and vendor_id = $2 for key share', [
                  body.packageId,
                  body.vendorId,
                ])
              : { rows: [] }
            if (pkg.length === 0) {
              throw new AppError(422, 'unknown_package', 'Такого пакета у подрядчика нет', {
                packageId: 'пакет не найден у этого подрядчика',
              })
            }
          }

          const dealId = uuidv7()
          await client.query(
            `insert into deals (id, wedding_id, slot_id, vendor_id, state, price, currency, booked_at, package_id)
             values ($1, $2, $3, $4, 'booked', $5, 'RUB', now(), $6)`,
            [dealId, weddingId, slotId, body.vendorId, body.price.amount, body.packageId ?? null],
          )
          // Захват слота условием в UPDATE, а не «прочитали и записали»:
          // два одновременных «Забронировать» иначе оба видят пустой слот,
          // оба вешают на него сделку, и бюджет считает обе.
          const taken = await client.query('update slots set deal_id = $2 where id = $1 and deal_id is null', [
            slotId,
            dealId,
          ])
          if (taken.rowCount === 0) {
            throw conflict('slot_taken', 'В этом слоте уже есть сделка — сначала отмените её')
          }
          await client.query(
            `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
             values ($1, $2, null, 'booked', $3)`,
            [uuidv7(), dealId, request.caller!.userId],
          )
          /* Бронь — это выигранный лид. Заводим его и здесь: пара могла
           * забронировать сразу из каталога, ни разу не написав, и тогда
           * в кабинете подрядчика сделка появилась бы ниоткуда. */
          await openLead(client, weddingId, body.vendorId, null, true)

          // Захват даты — в той же транзакции. Вторая пара упирается
          // в первичный ключ (vendor_id, date) и получает 409, а не «обе
          // забронировали одного фотографа на 14 июня».
          if (date) await holdVendorDate(client, body.vendorId, date, dealId, weddingId)
          return { status: 200, body: (await loadSlot(client, slotId, true))! }
        }),
      )
    },
  )

  /* ── отмена ───────────────────────────────────────────────────────── */
  app.post('/weddings/:weddingId/slots/:slotId/cancel', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }

    return withIdempotency(db(), request, reply, 'slots.cancel', (tx) =>
      tx(async (client) => {
        const slot = await slotOf(client, weddingId, slotId)
        if (!slot.deal_id) throw conflict('slot_empty', 'В этом слоте нечего отменять')
        await cancelDeal(client, slot.deal_id, { actorId: request.caller!.userId })
        return { status: 200, body: (await loadSlot(client, slotId, true))! }
      }),
    )
  })

  /* ── оплата ───────────────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/slots/:slotId/pay',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { amount: MONEY_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { slotId } = request.params as { slotId: string }
      const body = (request.body ?? {}) as { amount?: { amount: number } }

      return withIdempotency(db(), request, reply, 'slots.pay', (tx) =>
        tx(async (client) => {
          const slot = await slotOf(client, weddingId, slotId)
          if (!slot.deal_id) throw conflict('slot_empty', 'В этом слоте нет сделки')

          await lockFinanceAccess(client,weddingId,request.caller!.userId)
          const deal = await lockDeal(client,weddingId,slot.deal_id)
          await recordPayment(client,deal,request.caller!.userId,body.amount?.amount)
          return { status: 200, body: (await loadSlot(client, slotId, true))! }
        }),
      )
    },
  )

  /* ── свой подрядчик ───────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/slots/:slotId/external',
    {
      schema: {
        body: {
          type: 'object',
          required: ['vendorName', 'price'],
          additionalProperties: false,
          properties: {
            vendorName: { type: 'string', minLength: 2, maxLength: 120 },
            price: MONEY_SCHEMA,
            phone: { type: 'string', maxLength: 32 },
          },
        },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      const { slotId } = request.params as { slotId: string }
      const body = request.body as { vendorName: string; price: { amount: number }; phone?: string }
      assertPositivePrice(body.price.amount)

      return db().tx(async (client) => {
        // Свой подрядчик — такая же сделка, и дверь такая же (SA-05).
        await assertCallerLive(client, request.caller!.userId)
        // Слот — эксклюзивно и до вставки сделки, как у каталожной брони (ERR-0317).
        await lockEmptySlot(client, weddingId, slotId)
        // Прежние ссылки слота гаснут до новой сделки: страховка от любого
        // пути отмены, который их не отозвал (ERR-0242).
        await revokeSlotInvites(client, slotId)
        const dealId = uuidv7()
        // Свой подрядчик занимает слот, бюджет и тайминг наравне с каталожным,
        // но даты в чужом календаре не занимает: его календаря у нас нет.
        await client.query(
          `insert into deals (id, wedding_id, slot_id, external_name, external_phone, state, price, currency, booked_at)
           values ($1, $2, $3, $4, $5, 'booked', $6, 'RUB', now())`,
          [dealId, weddingId, slotId, body.vendorName, body.phone ?? null, body.price.amount],
        )
        const taken = await client.query('update slots set deal_id = $2 where id = $1 and deal_id is null', [
          slotId,
          dealId,
        ])
        if (taken.rowCount === 0) {
          throw conflict('slot_taken', 'В этом слоте уже есть сделка — сначала отмените её')
        }
        await client.query(
          `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
           values ($1, $2, null, 'booked', $3)`,
          [uuidv7(), dealId, request.caller!.userId],
        )
        /* Чат заводится вместе с подрядчиком, а не при первом сообщении:
         * иначе пара открывает список чатов, не находит там своего фотографа
         * и пишет ему в мессенджер — то есть мимо приложения (§11).
         * Чат принадлежит СДЕЛКЕ, не слоту: у прежнего подрядчика того же
         * слота остаётся свой (закрытый) чат, у нового — свой, и историю
         * прежнего он не видит (ERR-0219). Второй чат на ту же сделку
         * запрещён индексом; сделка только что заведена — конфликта нет. */
        await client.query(
          `insert into chats (id, wedding_id, kind, slot_id, deal_id) values ($1,$2,'external',$3,$4)`,
          [uuidv7(), weddingId, slotId, dealId],
        )
        return (await loadSlot(client, slotId, true))!
      })
    },
  )

  app.delete('/weddings/:weddingId/slots/:slotId/external', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }

    const slot = await slotOf(db(), weddingId, slotId)
    if (!slot.deal_id) throw notFound('В этом слоте нет своего подрядчика')
    const { rows } = await db().query<{ external_name: string | null }>('select external_name from deals where id = $1', [
      slot.deal_id,
    ])
    if (!rows[0]?.external_name) throw notFound('В этом слоте не свой подрядчик')

    /* Токен гасится ДО перехода и вне транзакции отмены: у выполненной
     * работы сделка остаётся (409 ниже), а доступ убранного подрядчика по
     * ссылке всё равно должен закрыться — иначе его нечем отозвать 30 дней
     * (ревью фиксов, RF-BE-03). */
    await revokeSlotInvites(db(), slotId)

    await db().tx(async (client) => {
      /* Тот же путь, что у отмены брони: состояние под блокировкой и через
       * машину переходов. Раньше состояние здесь не смотрели вовсе, и
       * выполненная работа своего подрядчика снималась с плитки (D2-02). */
      await cancelDeal(client, slot.deal_id!, { actorId: request.caller!.userId })
    })
    return reply.code(204).send()
  })

  app.post('/weddings/:weddingId/slots/:slotId/external/invite', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }

    const slot = await slotOf(db(), weddingId, slotId)
    if (!slot.deal_id) throw notFound('Сначала добавьте своего подрядчика в слот')
    /* Ссылка — только своему подрядчику: у каталожного есть кабинет и чат
     * по анкете, а ссылка в слот с ним открывала бы постороннему слот,
     * тайминг и переписку (ревью 015, D5). 409, а не 404: слот и сделка
     * есть, не тот вид сделки. */
    const { rows: kind } = await db().query<{ external: boolean }>(
      'select (external_name is not null) as external from deals where id = $1',
      [slot.deal_id],
    )
    if (!kind[0]?.external) throw conflict('not_external', 'Ссылка выдаётся только своему подрядчику — у каталожного есть кабинет')

    // 128 бит случайности: токен лежит в ссылке и не читается вслух,
    // поэтому длина здесь важнее удобства (план §6, правило 5).
    const token = randomBytes(16).toString('base64url')
    await db().query(
      `insert into external_invites (token, wedding_id, slot_id, expires_at)
       values ($1, $2, $3, now() + ($4 || ' days')::interval)`,
      [token, weddingId, slotId, String(EXTERNAL_TTL_DAYS)],
    )
    const { rows } = await db().query<{ expires_at: Date }>(
      'select expires_at from external_invites where token = $1',
      [token],
    )
    return reply.code(201).send({
      token,
      url: `https://tili-tili.ru/guest-vendor/${token}`,
      expiresAt: rows[0]!.expires_at.toISOString(),
    })
  })

  /* ── кабинет своего подрядчика ────────────────────────────────────── */
  /**
   * «Ссылка своего подрядчика жива» — одна формулировка на оба пути.
   *
   * Было два предиката, и они расходились: чтение (`GET /guest-vendor/{token}`)
   * не проверяло `archived_at`, а запись (`inviteByToken`) проверяла — гость-подрядчик
   * заархивированной свадьбы открывал живой экран, а любое действие с него
   * получало 410. На HEAD разницы не видно — архивация обычно отзывает
   * ссылки, но два определения одного и того же расходятся со временем
   * всегда (F-RL-2-04, ревью 016).
   */
  const LIVE_INVITE = `i.revoked_at is null and i.expires_at > now()
          and w.cancelled_at is null and w.archived_at is null`

  app.get('/guest-vendor/:token', async (request) => {
    const { token } = request.params as { token: string }
    const { rows } = await db().query<{ slot_id: string; wedding_id: string; deal_id: string | null; date: string | null }>(
      `select i.slot_id, i.wedding_id, s.deal_id, w.date::text as date
         from external_invites i
         join weddings w on w.id = i.wedding_id
         join slots s on s.id = i.slot_id
        where i.token = $1 and ${LIVE_INVITE}`,
      [token],
    )
    const invite = rows[0]
    if (!invite) throw new AppError(410, 'gone', 'Ссылка недействительна: истекла или отозвана')
    const dealId = dealOfInvite(invite.deal_id)

    await db().query('update external_invites set accepted_at = coalesce(accepted_at, now()) where token = $1', [token])

    const { rows: slotRows } = await db().query<SlotRow>(
      `select s.id as slot_id, s.category_id, s.label, s.sort, s.deal_id, ${DEAL_COLUMNS}
         from slots s left join deals d on d.id = s.deal_id ${DEAL_JOINS}
        where s.id = $1`,
      [invite.slot_id],
    )
    /* Тайминг целиком, а не только своя строка: подрядчику нужно знать,
     * когда церемония и когда банкет — иначе он не поймёт, к чему привязан
     * его выход. Гостей, бюджета и остальной команды здесь нет (§11). */
    const { rows: timeline } = await db().query(
      `select id, name, location, starts_at, ends_at, who, icon, outdoor, for_guests
         from timeline_events where wedding_id = $1 order by sort, starts_at`,
      [invite.wedding_id],
    )

    return {
      weddingDate: invite.date,
      slot: toSlot(slotRows[0]!, true),
      chatId: await externalChatId(invite.wedding_id, invite.slot_id, dealId),
      timeline: timeline.map((r) => toTimelineEvent(r as TimelineRow)),
      holdHours: HOLD_HOURS,
    }
  })

  /* ── переписка своего подрядчика с парой ──────────────────────────── */
  app.get('/guest-vendor/:token/messages', async (request) => {
    const { token } = request.params as { token: string }
    const invite = await inviteByToken(token)
    /* Чат — по сделке, история в нём своя целиком: реплики прежнего
     * подрядчика того же слота лежат в его чате и сюда не попадают
     * (ERR-0219). Фильтр «не старше текущей сделки», который держал это до
     * миграции, снят — дата не ключ. */
    const chatId = await externalChatId(invite.wedding_id, invite.slot_id, invite.deal_id)

    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    const { rows } = await db().query<MessageRow>(
      `select m.id, m.chat_id, m.sender_id, m.text, m.attachments, m.created_at, ${CREATED_AT_US}
         from messages m
        where m.chat_id = $1
          and ($2::text is null or (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
        order by m.created_at desc, m.id desc
        limit $4`,
      [chatId, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    // Курсор — по микросекундам строки, как в `GET /chats/{id}/messages` (D4-23).
    const paged = buildPage(rows, page.limit, (r) => encodeCursor(r.created_at_us, r.id))
    return { items: paged.items.map(toMessage), nextCursor: paged.nextCursor }
  })

  app.post(
    '/guest-vendor/:token/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string }
      const { text } = request.body as { text: string }
      const invite = await inviteByToken(token)
      const chatId = await externalChatId(invite.wedding_id, invite.slot_id, invite.deal_id)

      /* Отправитель пустой: аккаунта у своего подрядчика нет, а выдумывать
       * ему пользователя значило бы завести половину учётной записи —
       * с правами, входом и восстановлением, которых у него не будет.
       * В этом виде чата системных записей не бывает, поэтому пустой
       * отправитель читается однозначно (контракт, Message.senderId). */
      const id = uuidv7()
      const { rows } = await db().query<{ created_at: Date }>(
        'insert into messages (id, chat_id, sender_id, text) values ($1,$2,null,$3) returning created_at',
        [id, chatId, text],
      )
      const message = {
        id,
        chatId,
        senderId: null,
        text,
        attachmentUrl: null,
        sentAt: rows[0]!.created_at.toISOString(),
        system: false,
        // Гостей в чате со своим подрядчиком не бывает — имя гостя всегда пустое (фича 009).
        guestName: null,
        // Всем по живому каналу — без признака; автору в ответе — своя (фича 014).
        mine: null as boolean | null,
      }
      await app.realtime.publish({ chatId, type: 'message', actorId: 'external', payload: { message } })

      /* Пара узнаёт о сообщении так же, как о любом другом: подрядчик без
       * аккаунта — не повод молчать в её уведомлениях.
       *
       * Получатели — те, кому чат `external` виден по матрице, а не все
       * участники свадьбы. Помощник его не открывает (403), но получал бы
       * в теле уведомления первые 120 символов переписки — ровно та же
       * утечка, что закрыта в `chats.ts` (ERR-0099). Там я починил место
       * вызова, а не класс, и второе место осталось (ERR-0106). */
      const { rows: members } = await db().query<{ user_id: string }>(
        'select user_id from wedding_members where wedding_id = $1 and role = any($2)',
        [invite.wedding_id, rolesSeeing('external')],
      )
      // Тихие часы по поясу свадьбы, если у получателя свой не задан (RF-BE-04).
      const { rows: tzRow } = await db().query<{ tz: string | null }>('select tz from weddings where id = $1', [
        invite.wedding_id,
      ])
      for (const m of members) {
        await notify(db(), {
          userId: m.user_id,
          kind: 'chat',
          title: 'Сообщение от своего подрядчика',
          body: text.length > 120 ? `${text.slice(0, 119)}…` : text,
          link: `/chats/${chatId}`,
        }, new Date(), tzRow[0]?.tz ?? null)
      }
      return reply.code(201).send({ ...message, mine: true })
    },
  )

  /** Живая ссылка или 410 — общая проверка для всех путей кабинета. */
  async function inviteByToken(
    token: string,
  ): Promise<{ wedding_id: string; slot_id: string; deal_id: string; date: string | null }> {
    const { rows } = await db().query<{ slot_id: string; wedding_id: string; deal_id: string | null; date: string | null }>(
      `select i.slot_id, i.wedding_id, s.deal_id, w.date::text as date
         from external_invites i
         join weddings w on w.id = i.wedding_id
         join slots s on s.id = i.slot_id
        where i.token = $1 and ${LIVE_INVITE}`,
      [token],
    )
    if (!rows[0]) throw new AppError(410, 'gone', 'Ссылка недействительна: истекла или отозвана')
    return { ...rows[0], deal_id: dealOfInvite(rows[0].deal_id) }
  }

  /**
   * Сделка, к которой ведёт ссылка, — текущая сделка слота.
   *
   * Ссылка привязана к слоту, а переписка — к сделке (`chats.deal_id`):
   * без текущей сделки подрядчика в слоте больше нет, и открывать по ссылке
   * нечего. Каждая дверь отмены гасит ссылку сама (ERR-0242); здесь —
   * страховка на случай, если сделка ушла из слота другим путём: 410,
   * а не чат чужой сделки и не 500.
   */
  function dealOfInvite(dealId: string | null): string {
    if (!dealId) throw new AppError(410, 'gone', 'Подрядчика в слоте больше нет — ссылка закрыта')
    return dealId
  }

  /**
   * Чат сделки со своим подрядчиком: заводится вместе с ней, но у сделок,
   * заведённых до появления чатов, его может не быть. Создаём по требованию,
   * чтобы старая ссылка не открывалась в кабинет без переписки. Ключ —
   * сделка, не слот: второй чат на неё не заведётся, а чат прежнего
   * подрядчика того же слота остаётся его (ERR-0219).
   */
  async function externalChatId(weddingId: string, slotId: string, dealId: string): Promise<string> {
    const { rows } = await db().query<{ id: string }>(
      `insert into chats (id, wedding_id, kind, slot_id, deal_id) values ($1,$2,'external',$3,$4)
       on conflict (deal_id) where kind = 'external' do update set kind = 'external'
       returning id`,
      [uuidv7(), weddingId, slotId, dealId],
    )
    return rows[0]!.id
  }
}

interface TimelineRow {
  id: string
  name: string
  location: string | null
  starts_at: string
  ends_at: string | null
  who: string | null
  icon: string | null
  outdoor: boolean
  for_guests: boolean
}

const toTimelineEvent = (r: TimelineRow) => ({
  id: r.id,
  name: r.name,
  location: r.location,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  who: r.who,
  icon: r.icon,
  outdoor: r.outdoor,
  forGuests: r.for_guests,
})

interface MessageRow {
  id: string
  chat_id: string
  sender_id: string | null
  text: string
  attachments: { url?: string } | null
  created_at: Date
  created_at_us: string
}

const toMessage = (r: MessageRow) => ({
  id: r.id,
  chatId: r.chat_id,
  senderId: r.sender_id,
  text: r.text,
  attachmentUrl: r.attachments?.url ?? null,
  sentAt: r.created_at.toISOString(),
  // В чате со своим подрядчиком системных записей не бывает: пустой
  // отправитель здесь — сам подрядчик (контракт, Message.senderId).
  system: false,
  guestName: null,
  // Читает подрядчик без аккаунта: своя реплика — та, где отправитель пуст.
  mine: r.sender_id === null,
})
