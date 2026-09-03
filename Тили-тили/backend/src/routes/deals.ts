import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { withIdempotency } from '../deals/idempotency.js'
import {
  DEAL_COLUMNS,
  DEAL_JOINS,
  expireHolds,
  holdVendorDate,
  releaseVendorDate,
  toDeal,
  type DealRow,
} from '../deals/repo.js'
import { DEAL_STATES, HOLD_HOURS, assertTransition, type DealState } from '../deals/state.js'

export async function dealRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /**
   * Сделка своей свадьбы и роль в ней.
   *
   * Путь `/deals/{id}` не содержит weddingId, поэтому матрица доступа его
   * не покрывает — проверка живёт здесь. Без неё чужой идентификатор сделки
   * даёт полный доступ к чужой брони.
   */
  async function dealForCouple(client: Queryable, dealId: string, userId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(dealId)) throw notFound('Сделка не найдена')
    const { rows } = await client.query<{
      id: string
      wedding_id: string
      slot_id: string
      state: DealState
      vendor_id: string | null
      price: string | null
      role: string
    }>(
      `select d.id, d.wedding_id, d.slot_id, d.state, d.vendor_id, d.price::text as price, m.role
         from deals d
         join wedding_members m on m.wedding_id = d.wedding_id and m.user_id = $2
         join weddings w on w.id = d.wedding_id and w.archived_at is null
        where d.id = $1`,
      [dealId, userId],
    )
    const deal = rows[0]
    // Чужая сделка — 404, а не 403: по кодам ответа не должно быть видно,
    // какие идентификаторы существуют.
    if (!deal) throw notFound('Сделка не найдена')
    if (deal.role !== 'couple') throw new AppError(403, 'forbidden', 'Сделками распоряжается только пара')
    return deal
  }

  app.patch(
    '/deals/:dealId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['state'],
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: [...DEAL_STATES] },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { dealId } = request.params as { dealId: string }
      const body = request.body as { state: DealState; note?: string }
      const userId = request.caller!.userId

      return withIdempotency(db(), request, reply, 'deals.patch', async () => {
        const result = await db().tx(async (client) => {
          const deal = await dealForCouple(client, dealId, userId)
          await expireHolds(client, deal.wedding_id)

          const { rows: fresh } = await client.query<{ state: DealState }>('select state from deals where id = $1', [
            dealId,
          ])
          const from = fresh[0]!.state
          assertTransition(from, body.state)

          const sets: string[] = ['state = $2']
          const args: unknown[] = [dealId, body.state]

          if (body.state === 'negotiating') {
            // Мягкая бронь — срок, а не состояние: 72 часа с этой минуты.
            sets.push(`negotiating_until = now() + interval '${HOLD_HOURS} hours'`)
          } else {
            sets.push('negotiating_until = null')
          }
          if (body.state === 'booked') sets.push('booked_at = now()')
          if (body.state === 'done') sets.push('done_at = now()')
          if (body.state === 'cancelled') sets.push('cancelled_at = now()')

          await client.query(`update deals set ${sets.join(', ')} where id = $1`, args)

          // Дата подрядчика занимается ровно тогда, когда сделка становится
          // бронью, и освобождается при отмене. Держать её на переговорах
          // значит блокировать чужие свадьбы под несуществующую договорённость.
          if (body.state === 'booked' && deal.vendor_id) {
            const { rows: w } = await client.query<{ date: string | null }>(
              'select date::text as date from weddings where id = $1',
              [deal.wedding_id],
            )
            if (w[0]?.date) {
              await holdVendorDate(client, deal.vendor_id, w[0].date, dealId, deal.wedding_id)
            }
          }
          if (body.state === 'cancelled') {
            await client.query('update slots set deal_id = null where deal_id = $1', [dealId])
            await releaseVendorDate(client, dealId)
          }

          await client.query(
            `insert into deal_events (id, deal_id, from_state, to_state, actor_id, note)
             values ($1, $2, $3, $4, $5, $6)`,
            [uuidv7(), dealId, from, body.state, userId, body.note ?? null],
          )

          const { rows: out } = await client.query<DealRow>(
            `select ${DEAL_COLUMNS} from deals d ${DEAL_JOINS} where d.id = $1`,
            [dealId],
          )
          return toDeal(out[0]!, true)
        })
        return { status: 200, body: result }
      })
    },
  )
}
