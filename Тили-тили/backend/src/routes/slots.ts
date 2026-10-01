import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { notify } from '../notify/notify.js'
import { rolesSeeing } from '../chats/access.js'
import type { Queryable } from '../plugins/db.js'
import { withIdempotency } from '../deals/idempotency.js'
import { cancelDeal } from '../deals/cancel.js'
import { replaceLegacySlotBooking, type ReplaceLegacySlotInput } from '../deals/replace.js'
import { bookVendor, lockBookingActor, lockBookingContext, lockBookingReplay } from '../deals/book.js'
import { lockFinanceAccess, lockDeal, recordPayment } from '../payments/model.js'
import { CREATED_AT_US } from './chats.js'
import {
  DEAL_COLUMNS,
  DEAL_JOINS,
  SLOT_COLUMNS,
  loadSlot,
  loadSlots,
  toSlot,
  type SlotRow,
} from '../deals/repo.js'
import { HOLD_HOURS, assertTransition, type DealState } from '../deals/state.js'
import { lockTimelineForRequest } from '../timeline/version.js'
import { assertExternalLinkNotExpired, lockExternalProgramAccess } from '../vendor/external-program-access.js'

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
          const context = await lockBookingContext(client, {
            weddingId,
            slotId,
            actorId: request.caller!.userId,
            sessionId: request.caller!.sessionId,
            policyVersion: app.appConfig.policyVersion,
          })
          await bookVendor(client, context, {
            performer: {
              kind: 'catalog',
              vendorId: body.vendorId,
              ...(body.packageId === undefined ? {} : { packageId: body.packageId }),
            },
            price: body.price.amount,
          })
          return { status: 200, body: (await loadSlot(client, slotId, true))! }
        }),
        true, client => lockBookingReplay(client, { weddingId, slotId, actorId: request.caller!.userId,
          sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion }),
      )
    },
  )

  /* ── отмена ───────────────────────────────────────────────────────── */
  app.post('/weddings/:weddingId/slots/:slotId/replace', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['expectedSelectedDealId', 'expectedSelectedDealState', 'vendorId', 'price', 'expectedPolicyRevision'],
      properties: {
        expectedSelectedDealId: UUID_ID,
        expectedSelectedDealState: { type: 'string', enum: ['candidate', 'contacted', 'negotiating', 'booked', 'paid_deposit'] },
        vendorId: UUID_ID, packageId: { type: 'string', maxLength: 40 },
        price: { ...MONEY_SCHEMA, properties: { ...MONEY_SCHEMA.properties,
          amount: { ...MONEY_SCHEMA.properties.amount, minimum: 1 } } },
        expectedPolicyRevision: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 19 },
      },
    } },
  }, async (request, reply) => {
    const weddingId = request.member!.weddingId, { slotId } = request.params as { slotId: string }
    const body = request.body as Pick<ReplaceLegacySlotInput, 'expectedSelectedDealId' | 'expectedSelectedDealState' |
      'vendorId' | 'packageId' | 'expectedPolicyRevision'> & { price: { amount: number } }
    const principal = { weddingId, slotId, actorId: request.caller!.userId,
      sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion }
    return withIdempotency(db(), request, reply, 'slots.replace', tx => tx(async client => {
      await replaceLegacySlotBooking(client, { ...principal, ...body, price: body.price.amount })
      return { status: 200, body: (await loadSlot(client, slotId, true))! }
    }), true, client => lockBookingReplay(client, principal))
  })

  app.post('/weddings/:weddingId/slots/:slotId/cancel', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }

    return withIdempotency(db(), request, reply, 'slots.cancel', (tx) =>
      tx(async (client) => {
        const slot = await slotOf(client, weddingId, slotId)
        if (!slot.deal_id) throw conflict('slot_empty', 'В этом слоте нечего отменять')
        await cancelDeal(client, slot.deal_id, { actorId: request.caller!.userId,
          sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion })
        return { status: 200, body: (await loadSlot(client, slotId, true))! }
      }),
      true, client => lockBookingReplay(client, { weddingId, slotId, actorId: request.caller!.userId,
        sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion }),
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

          await lockFinanceAccess(client, weddingId, request.caller!.userId)
          const deal = await lockDeal(client, weddingId, slot.deal_id)
          await recordPayment(client, deal, request.caller!.userId, body.amount?.amount)
          return { status: 200, body: (await loadSlot(client, slotId, true))! }
        }),
        true, client => lockBookingReplay(client, { weddingId, slotId, actorId: request.caller!.userId,
          sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion }),
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
        const context = await lockBookingContext(client, {
          weddingId,
          slotId,
          actorId: request.caller!.userId,
          sessionId: request.caller!.sessionId,
          policyVersion: app.appConfig.policyVersion,
        })
        await bookVendor(client, context, {
          performer: {
            kind: 'external',
            name: body.vendorName,
            ...(body.phone === undefined ? {} : { phone: body.phone }),
          },
          price: body.price.amount,
        })
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

    const completed = await db().tx(async client => {
      const live = await client.query('select id from weddings where id=$1 and archived_at is null and cancelled_at is null for update', [weddingId])
      if (!live.rows[0]) throw notFound('Свадьба не найдена')
      await lockBookingActor(client, { weddingId, actorId: request.caller!.userId,
        sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion })
      const current = (await client.query<{ deal_id: string | null }>('select deal_id from slots where id=$1 and wedding_id=$2 for update', [slotId, weddingId])).rows[0]
      if (!current || current.deal_id !== slot.deal_id) throw conflict('external_deal_changed', 'Заказ изменился — обновите позицию')
      const deal = (await client.query<{ state: DealState; external_name: string | null }>(
        'select state,external_name from deals where id=$1 and wedding_id=$2 for update', [current.deal_id, weddingId])).rows[0]
      if (!deal?.external_name) throw notFound('В этом слоте не свой подрядчик')
      if (deal.state === 'done') {
        // Completed work keeps its financial/history rows. Only this explicit
        // access withdrawal commits before returning the transition refusal.
        await revokeSlotInvites(client, slotId)
        return true
      }
      // Ordinary cancellation and access revocation share one transaction:
      // an audit/DB failure must not leave a live deal with revoked links.
      await cancelDeal(client, slot.deal_id!, { actorId: request.caller!.userId,
        sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion })
      return false
    })
    if (completed) assertTransition('done', 'cancelled')
    return reply.code(204).send()
  })

  /**
   * «Нет, ещё ищем» — снять отметку «уже забронировано вне приложения» (фича 018).
   *
   * Пара ответила в квизе, что подрядчик найден, а потом передумала: слот
   * становится обычным пустым. Идемпотентно — слот без отметки тоже 204:
   * повтор нажатия на плохой связи не должен читаться как ошибка. Права — как
   * у брони (матрица `slots/:slotId/…`, DELETE только паре); чужой слот — 404
   * через `slotOf`, как у остальных дверей слота.
   */
  app.delete('/weddings/:weddingId/slots/:slotId/prebooked', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }
    await slotOf(db(), weddingId, slotId)
    await db().query('update slots set prebooked_at = null where id = $1 and wedding_id = $2', [slotId, weddingId])
    return reply.code(204).send()
  })

  app.post('/weddings/:weddingId/slots/:slotId/external/invite', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }
    const invitation = await db().tx(async client => {
      await lockTimelineForRequest(client, request, true)
      const slot = await slotOf(client, weddingId, slotId)
      if (!slot.deal_id) throw notFound('Сначала добавьте своего подрядчика в слот')
      /* Ссылка — только своему подрядчику: у каталожного есть кабинет и чат
       * по анкете, а ссылка в слот с ним открывала бы постороннему слот,
       * тайминг и переписку (ревью 015, D5). 409, а не 404: слот и сделка
       * есть, не тот вид сделки. */
      const { rows: kind } = await client.query<{ external: boolean; state: string }>(
        'select (external_name is not null and vendor_id is null) as external,state from deals where id = $1 for share',
        [slot.deal_id],
      )
      if (!kind[0]?.external) throw conflict('not_external', 'Ссылка выдаётся только своему подрядчику — у каталожного есть кабинет')
      if (!['booked', 'paid_deposit', 'done'].includes(kind[0].state)) throw notFound('Подрядчика в слоте больше нет — ссылка закрыта')

      // 128 бит случайности: токен лежит в ссылке и не читается вслух,
      // поэтому длина здесь важнее удобства (план §6, правило 5).
      const token = randomBytes(16).toString('base64url')
      const issued = await client.query<{ program_identity: string }>(
        `insert into external_invites (token, wedding_id, slot_id, program_deal_id, created_at, expires_at)
         values ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + ($5 || ' days')::interval)
         returning program_identity`,
        [token, weddingId, slotId, slot.deal_id, String(EXTERNAL_TTL_DAYS)],
      )
      await client.query('update deals set current_program_invite_id=$3 where wedding_id=$1 and id=$2',
        [weddingId, slot.deal_id, issued.rows[0]!.program_identity])
      const { rows } = await client.query<{ expires_at: Date }>(
        'select expires_at from external_invites where token = $1',
        [token],
      )
      return {
        token,
        url: `https://tili-tili.ru/guest-vendor/${token}`,
        expiresAt: rows[0]!.expires_at.toISOString(),
      }
    })
    // A deferred constraint can fail at COMMIT after all callback queries.
    // Do not expose a token until its transaction actually committed.
    return reply.code(201).send(invitation)
  })

  /* ── кабинет своего подрядчика ────────────────────────────────────── */
  app.get('/guest-vendor/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    reply.header('cache-control', 'no-store')
    return db().tx(async client => {
      // The invite update lock prevents concurrent accepted_at lock upgrades.
      const access = await lockExternalProgramAccess(client, token, false, true)
      const { rows: slotRows } = await client.query<SlotRow>(
        `select ${SLOT_COLUMNS}, ${DEAL_COLUMNS}
           from slots s left join deals d on d.id = s.deal_id ${DEAL_JOINS}
          where s.id = $1 and s.wedding_id=$2`,
        [access.slotId, access.weddingId],
      )
      // Legacy reader must not bypass the assigned-only versioned program projection.
      const { rows: timeline } = await client.query(
        `select e.id,e.name,e.location,e.starts_at,e.ends_at,null::text as who,e.icon,e.outdoor,e.for_guests
           from timeline_events e where e.wedding_id=$1 and exists (
             select 1 from timeline_assignments a where a.wedding_id=e.wedding_id and a.event_id=e.id and a.deal_id=$2)
           order by e.sort,e.starts_at`,
        [access.weddingId, access.dealId],
      )
      const chatId = await externalChatId(client, access.weddingId, access.slotId, access.dealId)
      await client.query('update external_invites set accepted_at=coalesce(accepted_at,clock_timestamp()) where token=$1 and wedding_id=$2', [token, access.weddingId])
      await assertExternalLinkNotExpired(client, access.expiresAt)
      return {
        weddingDate: access.date,
        slot: toSlot(slotRows[0]!, true),
        chatId,
        timeline: timeline.map((r) => toTimelineEvent(r as TimelineRow)),
        holdHours: HOLD_HOURS,
      }
    })
  })

  /* ── переписка своего подрядчика с парой ──────────────────────────── */
  app.get('/guest-vendor/:token/messages', async (request, reply) => {
    const { token } = request.params as { token: string }
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    reply.header('cache-control', 'no-store')
    return db().tx(async client => {
      const access = await lockExternalProgramAccess(client, token, false)
      /* Чат — по сделке, история в нём своя целиком: реплики прежнего
       * подрядчика того же слота лежат в его чате и сюда не попадают
       * (ERR-0219). Фильтр «не старше текущей сделки», который держал это до
       * миграции, снят — дата не ключ. */
      const chatId = await externalChatId(client, access.weddingId, access.slotId, access.dealId)

      const { rows } = await client.query<MessageRow>(
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
      await assertExternalLinkNotExpired(client, access.expiresAt)
      return { items: paged.items.map(toMessage), nextCursor: paged.nextCursor }
    })
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
      const committed = await db().tx(async client => {
        const access = await lockExternalProgramAccess(client, token, false)
        const chatId = await externalChatId(client, access.weddingId, access.slotId, access.dealId)

        /* Отправитель пустой: аккаунта у своего подрядчика нет, а выдумывать
         * ему пользователя значило бы завести половину учётной записи —
         * с правами, входом и восстановлением, которых у него не будет.
         * В этом виде чата системных записей не бывает, поэтому пустой
         * отправитель читается однозначно (контракт, Message.senderId). */
        const id = uuidv7()
        const { rows } = await client.query<{ created_at: Date }>(
          'insert into messages (id, chat_id, sender_id, text, created_at) values ($1,$2,null,$3,clock_timestamp()) returning created_at',
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

        /* Получатели — только те, кому чат external виден по матрице,
         * не все участники свадьбы: тело не должно утекать помощнику (ERR-0106). */
        const { rows: members } = await client.query<{ user_id: string }>(
          'select user_id from wedding_members where wedding_id = $1 and role = any($2)',
          [access.weddingId, rolesSeeing('external')],
        )
        await assertExternalLinkNotExpired(client, access.expiresAt)
        return { message, members, tz: access.tz }
      })
      const { message, members, tz } = committed
      const { chatId } = message
      // Publish only a committed message, never a later rolled-back denial.
      await app.realtime.publish({ chatId, type: 'message', actorId: 'external', payload: { message } })
      for (const m of members) {
        await notify(db(), {
          userId: m.user_id,
          kind: 'chat',
          title: 'Сообщение от своего подрядчика',
          body: text.length > 120 ? `${text.slice(0, 119)}…` : text,
          link: `/chats/${chatId}`,
        }, new Date(), tz)
      }
      return reply.code(201).send({ ...message, mine: true })
    },
  )

  /**
   * Чат сделки со своим подрядчиком: заводится вместе с ней, но у сделок,
   * заведённых до появления чатов, его может не быть. Создаём по требованию,
   * чтобы старая ссылка не открывалась в кабинет без переписки. Ключ —
   * сделка, не слот: второй чат на неё не заведётся, а чат прежнего
   * подрядчика того же слота остаётся его (ERR-0219).
   */
  async function externalChatId(client: Queryable, weddingId: string, slotId: string, dealId: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
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
