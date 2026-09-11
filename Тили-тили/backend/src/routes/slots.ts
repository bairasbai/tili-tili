import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { notify } from '../notify/notify.js'
import { rolesSeeing } from '../chats/access.js'
import { openLead } from '../vendor/leads.js'
import type { Queryable } from '../plugins/db.js'
import { withIdempotency } from '../deals/idempotency.js'
import {
  DEAL_COLUMNS,
  DEAL_JOINS,
  holdVendorDate,
  loadSlot,
  loadSlots,
  releaseVendorDate,
  toSlot,
  type SlotRow,
} from '../deals/repo.js'
import { COMMITTED, HOLD_HOURS, assertTransition, type DealState } from '../deals/state.js'

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
   * Отмена сделки в слоте — одна дверь для брони и для своего подрядчика.
   *
   * Состояние читается `for update`: два одновременных «Отменить» с разными
   * ключами иначе оба видели `booked`, оба писали событие `booked → cancelled`
   * и оба слали подрядчику «Сделка отменена» (D2-06, R-187). Переход
   * проверяется той же машиной, что у `PATCH /deals`: из `done` отменять
   * нельзя — услуга оказана и оплачена, а здесь до этого можно было, и
   * плитка выполненной работы пустела (D2-02, R-102).
   */
  async function cancelDealInSlot(client: Queryable, slotId: string, dealId: string, actorId: string): Promise<void> {
    const { rows } = await client.query<{ state: DealState }>('select state from deals where id = $1 for update', [
      dealId,
    ])
    const state = rows[0]!.state
    if (state === 'cancelled') throw conflict('already_cancelled', 'Сделка уже отменена')
    assertTransition(state, 'cancelled')

    await client.query(`update deals set state = 'cancelled', cancelled_at = now() where id = $1`, [dealId])
    await client.query(
      `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
       values ($1, $2, $3, 'cancelled', $4)`,
      [uuidv7(), dealId, state, actorId],
    )
    // Слот освобождается, дата возвращается подрядчику. Ручную отметку
    // «занято» не трогаем — её ставил он сам.
    await client.query('update slots set deal_id = null where id = $1', [slotId])
    await releaseVendorDate(client, dealId)
    await revokeSlotInvites(client, slotId)
  }

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

  async function weddingDate(client: Queryable, weddingId: string): Promise<string | null> {
    const { rows } = await client.query<{ date: string | null }>(
      'select date::text as date from weddings where id = $1',
      [weddingId],
    )
    return rows[0]?.date ?? null
  }

  /* ── мозаика ──────────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/slots', async (request) =>
    loadSlots(db(), request.member!.weddingId, seesMoney(request.member!.role)),
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

      return withIdempotency(db(), request, reply, 'slots.book', async () => {
        const result = await db().tx(async (client) => {
          await slotOf(client, weddingId, slotId)

          const { rows: vendor } = await client.query<{ id: string }>(
            `select v.id from vendors v join users u on u.id = v.user_id and u.deleted_at is null
              where v.id = $1 and v.published_at is not null`,
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
            const { rows: pkg } = new RegExp(UUID_ID.pattern).test(body.packageId)
              ? await client.query('select 1 from vendor_packages where id = $1 and vendor_id = $2', [
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
          const date = await weddingDate(client, weddingId)
          if (date) await holdVendorDate(client, body.vendorId, date, dealId, weddingId)
          return (await loadSlot(client, slotId, true))!
        })
        return { status: 200, body: result }
      })
    },
  )

  /* ── отмена ───────────────────────────────────────────────────────── */
  app.post('/weddings/:weddingId/slots/:slotId/cancel', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }

    return withIdempotency(db(), request, reply, 'slots.cancel', async () => {
      const result = await db().tx(async (client) => {
        const slot = await slotOf(client, weddingId, slotId)
        if (!slot.deal_id) throw conflict('slot_empty', 'В этом слоте нечего отменять')
        await cancelDealInSlot(client, slotId, slot.deal_id, request.caller!.userId)
        return (await loadSlot(client, slotId, true))!
      })
      return { status: 200, body: result }
    })
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

      return withIdempotency(db(), request, reply, 'slots.pay', async () => {
        const result = await db().tx(async (client) => {
          const slot = await slotOf(client, weddingId, slotId)
          if (!slot.deal_id) throw conflict('slot_empty', 'В этом слоте нет сделки')

          /* `for update`: два одновременных «Оплатить» с разными ключами
           * иначе оба читали одну и ту же сумму «уже оплачено», оба проходили
           * проверку переплаты и оба записывались — деньги сверх цены
           * (R-49: «прочитали, убедились, записали» — не защита). Блокировка
           * строки сделки ставит второго в очередь за первым. */
          const { rows } = await client.query<{ state: DealState; price: string | null }>(
            'select state, price::text as price from deals where id = $1 for update',
            [slot.deal_id],
          )
          const deal = rows[0]!
          if (!COMMITTED.includes(deal.state)) {
            throw conflict('not_booked', 'Оплатить можно только забронированную сделку')
          }
          /* Без цены платить нечего: сумма без договорённости — просто число,
           * и проверить переплату не по чему. Ноль — та же пустота: цена 0
           * назначается через `PATCH /deals`, и оплата «в счёт нуля» была бы
           * оплатой без предела (ERR-0039 с нулём вместо `null`, D2-05). */
          const price = deal.price === null ? null : Number(deal.price)
          if (price === null || price <= 0) {
            throw conflict('no_price', 'У сделки не указана цена — сначала договоритесь о сумме')
          }

          const amount = body.amount?.amount ?? price
          if (amount <= 0) throw new AppError(422, 'bad_amount', 'Сумма оплаты должна быть больше нуля')

          const { rows: paid } = await client.query<{ total: string }>(
            `select coalesce(sum(amount), 0)::text as total from payments
              where deal_id = $1 and status <> 'cancelled' and kind <> 'refund'`,
            [slot.deal_id],
          )
          const already = Number(paid[0]!.total)
          if (already + amount > price) {
            throw conflict('overpay', `Сумма оплат превысила цену сделки: уже ${already}, цена ${price}`)
          }

          await client.query(
            `insert into payments (id, deal_id, kind, amount, currency, status)
             values ($1, $2, $3, $4, 'RUB', 'recorded')`,
            [uuidv7(), slot.deal_id, already + amount >= price ? 'balance' : 'deposit', amount],
          )

          // Эквайринга в MVP нет: запись фиксирует факт, деньги ходят между
          // парой и подрядчиком напрямую (План §3.2). Состояние сделки
          // двигается вперёд только на первой оплате.
          if (deal.state === 'booked') {
            assertTransition(deal.state, 'paid_deposit')
            await client.query(`update deals set state = 'paid_deposit' where id = $1`, [slot.deal_id])
            await client.query(
              `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
               values ($1, $2, $3, 'paid_deposit', $4)`,
              [uuidv7(), slot.deal_id, deal.state, request.caller!.userId],
            )
          }
          return (await loadSlot(client, slotId, true))!
        })
        return { status: 200, body: result }
      })
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
        await slotOf(client, weddingId, slotId)
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
      await cancelDealInSlot(client, slotId, slot.deal_id!, request.caller!.userId)
    })
    return reply.code(204).send()
  })

  app.post('/weddings/:weddingId/slots/:slotId/external/invite', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }

    const slot = await slotOf(db(), weddingId, slotId)
    if (!slot.deal_id) throw notFound('Сначала добавьте своего подрядчика в слот')

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
  app.get('/guest-vendor/:token', async (request) => {
    const { token } = request.params as { token: string }
    const { rows } = await db().query<{ slot_id: string; wedding_id: string; deal_id: string | null; date: string | null }>(
      `select i.slot_id, i.wedding_id, s.deal_id, w.date::text as date
         from external_invites i
         join weddings w on w.id = i.wedding_id
         join slots s on s.id = i.slot_id
        where i.token = $1 and i.revoked_at is null and i.expires_at > now() and w.cancelled_at is null`,
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
      `select id, name, location, starts_at, ends_at, who, icon, outdoor
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
      `select id, chat_id, sender_id, text, attachments, created_at
         from messages
        where chat_id = $1
          and ($2::text is null or (created_at, id) < ($2::timestamptz, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [chatId, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    return buildPage(rows.map(toMessage), page.limit, (m) => encodeCursor(m.sentAt, m.id))
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
      return reply.code(201).send(message)
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
        where i.token = $1 and i.revoked_at is null and i.expires_at > now()
          and w.cancelled_at is null and w.archived_at is null`,
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
})

interface MessageRow {
  id: string
  chat_id: string
  sender_id: string | null
  text: string
  attachments: { url?: string } | null
  created_at: Date
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
})
