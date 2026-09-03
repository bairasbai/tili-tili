import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
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

export async function slotRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const seesMoney = (role: string | undefined) => role === 'couple'

  /** Слот этой свадьбы или 404. Проверка по weddingId обязательна: без неё
   *  чужой slotId из другой свадьбы прошёл бы по своей матрице доступа. */
  async function slotOf(client: Queryable, weddingId: string, slotId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(slotId)) throw notFound('Слот не найден')
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
            vendorId: { type: 'string', maxLength: 40 },
            packageId: { type: 'string', maxLength: 40 },
            price: MONEY_SCHEMA,
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { slotId } = request.params as { slotId: string }
      const body = request.body as { vendorId: string; price: { amount: number } }

      return withIdempotency(db(), request, reply, 'slots.book', async () => {
        const result = await db().tx(async (client) => {
          await slotOf(client, weddingId, slotId)

          const { rows: vendor } = await client.query<{ id: string }>(
            `select v.id from vendors v join users u on u.id = v.user_id and u.deleted_at is null
              where v.id = $1 and v.published_at is not null`,
            [body.vendorId],
          )
          if (!vendor[0]) throw notFound('Подрядчик не найден')

          const dealId = uuidv7()
          await client.query(
            `insert into deals (id, wedding_id, slot_id, vendor_id, state, price, currency, booked_at)
             values ($1, $2, $3, $4, 'booked', $5, 'RUB', now())`,
            [dealId, weddingId, slotId, body.vendorId, body.price.amount],
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

        const { rows } = await client.query<{ state: DealState }>('select state from deals where id = $1', [
          slot.deal_id,
        ])
        const state = rows[0]!.state
        if (state === 'cancelled') throw conflict('already_cancelled', 'Сделка уже отменена')

        await client.query(
          `update deals set state = 'cancelled', cancelled_at = now() where id = $1`,
          [slot.deal_id],
        )
        await client.query(
          `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
           values ($1, $2, $3, 'cancelled', $4)`,
          [uuidv7(), slot.deal_id, state, request.caller!.userId],
        )
        // Слот освобождается, дата возвращается подрядчику. Ручную отметку
        // «занято» не трогаем — её ставил он сам.
        await client.query('update slots set deal_id = null where id = $1', [slotId])
        await releaseVendorDate(client, slot.deal_id)
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

          const { rows } = await client.query<{ state: DealState; price: string | null }>(
            'select state, price::text as price from deals where id = $1',
            [slot.deal_id],
          )
          const deal = rows[0]!
          if (!COMMITTED.includes(deal.state)) {
            throw conflict('not_booked', 'Оплатить можно только забронированную сделку')
          }
          // Без цены платить нечего: сумма без договорённости — просто число,
          // и проверить переплату не по чему.
          if (deal.price === null) {
            throw conflict('no_price', 'У сделки не указана цена — сначала договоритесь о сумме')
          }

          const amount = body.amount?.amount ?? Number(deal.price)
          if (amount <= 0) throw new AppError(422, 'bad_amount', 'Сумма оплаты должна быть больше нуля')

          const { rows: paid } = await client.query<{ total: string }>(
            `select coalesce(sum(amount), 0)::text as total from payments
              where deal_id = $1 and status <> 'cancelled' and kind <> 'refund'`,
            [slot.deal_id],
          )
          const already = Number(paid[0]!.total)
          const price = Number(deal.price ?? 0)
          if (price > 0 && already + amount > price) {
            throw conflict('overpay', `Сумма оплат превысила цену сделки: уже ${already}, цена ${price}`)
          }

          await client.query(
            `insert into payments (id, deal_id, kind, amount, currency, status)
             values ($1, $2, $3, $4, 'RUB', 'recorded')`,
            [uuidv7(), slot.deal_id, already + amount >= price && price > 0 ? 'balance' : 'deposit', amount],
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

      return db().tx(async (client) => {
        await slotOf(client, weddingId, slotId)
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
        return (await loadSlot(client, slotId, true))!
      })
    },
  )

  app.delete('/weddings/:weddingId/slots/:slotId/external', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }

    await db().tx(async (client) => {
      const slot = await slotOf(client, weddingId, slotId)
      if (!slot.deal_id) throw notFound('В этом слоте нет своего подрядчика')
      const { rows } = await client.query<{ external_name: string | null; state: DealState }>(
        'select external_name, state from deals where id = $1',
        [slot.deal_id],
      )
      if (!rows[0]?.external_name) throw notFound('В этом слоте не свой подрядчик')

      await client.query(`update deals set state = 'cancelled', cancelled_at = now() where id = $1`, [slot.deal_id])
      await client.query(
        `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
         values ($1, $2, $3, 'cancelled', $4)`,
        [uuidv7(), slot.deal_id, rows[0].state, request.caller!.userId],
      )
      await client.query('update slots set deal_id = null where id = $1', [slotId])
      // Выданный гостевой токен аннулируется вместе с подрядчиком: иначе
      // человек, которого убрали из свадьбы, продолжает видеть её данные.
      await client.query('update external_invites set revoked_at = now() where slot_id = $1 and revoked_at is null', [
        slotId,
      ])
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
    const { rows } = await db().query<{ slot_id: string; wedding_id: string; date: string | null }>(
      `select i.slot_id, i.wedding_id, w.date::text as date
         from external_invites i join weddings w on w.id = i.wedding_id
        where i.token = $1 and i.revoked_at is null and i.expires_at > now() and w.cancelled_at is null`,
      [token],
    )
    const invite = rows[0]
    if (!invite) throw new AppError(410, 'gone', 'Ссылка недействительна: истекла или отозвана')

    await db().query('update external_invites set accepted_at = coalesce(accepted_at, now()) where token = $1', [token])

    const { rows: slotRows } = await db().query<SlotRow>(
      `select s.id as slot_id, s.category_id, s.label, s.sort, s.deal_id, ${DEAL_COLUMNS}
         from slots s left join deals d on d.id = s.deal_id ${DEAL_JOINS}
        where s.id = $1`,
      [invite.slot_id],
    )
    // Только дата, свой слот и чат — ничего больше. Ни гостей, ни бюджета,
    // ни остальной команды (§11).
    return {
      weddingDate: invite.date,
      slot: toSlot(slotRows[0]!, true),
      // Чат появится вместе с чатами на этапе 7.
      chatId: null,
      holdHours: HOLD_HOURS,
    }
  })
}
