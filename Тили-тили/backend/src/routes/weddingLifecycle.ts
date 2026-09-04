import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { COMMITTED } from '../deals/state.js'
import { assertWeddingDate } from '../wedding/dates.js'
import { rescheduleWedding } from '../wedding/reschedule.js'

/**
 * Сколько живёт запрос на отмену, пока его не подтвердил второй партнёр.
 *
 * Столько же, сколько мягкая бронь: 72 часа — срок решения, которое двое
 * принимают не одновременно, но в рамках одного разговора. Дальше запрос
 * протухает, и следующее нажатие снова просит подтверждения, а не отменяет.
 */
export const CANCEL_CONFIRM_HOURS = 72

/**
 * Жив ли запрос на отмену. Чистая функция — чтобы срок проверялся тестом,
 * а не только живым прогоном с базой.
 */
export function cancelRequestPending(
  requestedBy: string | null,
  requestedAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (requestedBy === null || requestedAt === null) return false
  return now.getTime() - requestedAt.getTime() < CANCEL_CONFIRM_HOURS * 3_600_000
}

export async function weddingLifecycleRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /* ── перенос даты ─────────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/reschedule',
    {
      schema: {
        body: {
          type: 'object',
          required: ['date'],
          additionalProperties: false,
          properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { date } = request.body as { date: string }
      assertWeddingDate(date)

      return withIdempotency(db(), request, reply, 'weddings.reschedule', async () => {
        /* Вся работа — в одной транзакции: между освобождением старых дат
         * и захватом новых другая пара успевает занять подрядчика. */
        const report = await db().tx((client) => rescheduleWedding(client, weddingId, date))
        return { status: 200 as const, body: report }
      })
    },
  )

  /* ── отмена свадьбы ───────────────────────────────────────────────── */
  app.post('/weddings/:weddingId/cancel', async (request) => {
    const weddingId = request.member!.weddingId
    const userId = request.caller!.userId

    return db().tx(async (client) => {
      const { rows } = await client.query<{
        cancel_requested_by: string | null
        cancel_requested_at: Date | null
        cancelled_at: Date | null
        couples: string
      }>(
        `select w.cancel_requested_by, w.cancel_requested_at, w.cancelled_at,
                (select count(*)::text from wedding_members m
                  where m.wedding_id = w.id and m.role = 'couple') as couples
           from weddings w where w.id = $1`,
        [weddingId],
      )
      const w = rows[0]!
      if (w.cancelled_at) return { state: 'cancelled' as const }

      /* Запрос на отмену протухает.
       *
       * Без срока `cancel_requested_by` стоял в базе вечно, и колонка
       * `cancel_requested_at` писалась, но не читалась НИГДЕ. Отсюда сценарий:
       * в январе один партнёр в ссоре нажал «Отменить», получил «нужно
       * подтверждение второго», остыл и забыл. В июне второй открывает тот же
       * экран — и первое же нажатие стирает свадьбу: брони отменяются, даты
       * уходят подрядчикам, слоты чистятся. Второй партнёр при этом ничего
       * не подтверждал осознанно: с его стороны код идёт сразу в исполнение,
       * а поля запроса в карточку свадьбы не отдаются, и показать «первый уже
       * запросил» фронт не может.
       *
       * Срок тот же, что у мягкой брони: 72 часа — столько живёт решение,
       * которое двое принимают не одновременно, но в рамках одного разговора.
       */
      const pending = cancelRequestPending(w.cancel_requested_by, w.cancel_requested_at)

      const couples = Number(w.couples)
      // Отмена требует подтверждения ОБОИХ партнёров: свадьба — общее решение,
      // и один в ссоре не должен стирать полгода работы двоих.
      if (couples > 1 && !pending) {
        // Протухший запрос перезаписывается новым: отсчёт идёт заново.
        await client.query('update weddings set cancel_requested_by = $2, cancel_requested_at = now() where id = $1', [
          weddingId,
          userId,
        ])
        return { state: 'confirmation_required' as const, requestedBy: userId }
      }
      if (couples > 1 && w.cancel_requested_by === userId) {
        return { state: 'confirmation_required' as const, requestedBy: userId }
      }

      const { rows: cancelled } = await client.query<{ id: string; state: string }>(
        `update deals set state = 'cancelled', cancelled_at = now(), cancel_reason = 'cancelled_by_couple'
          where wedding_id = $1 and state = any($2) returning id, state`,
        [weddingId, COMMITTED],
      )
      for (const deal of cancelled) {
        await client.query(
          `insert into deal_events (id, deal_id, from_state, to_state, actor_id, note)
           values ($1, $2, $3, 'cancelled', $4, 'свадьба отменена')`,
          [uuidv7(), deal.id, deal.state, userId],
        )
      }
      await client.query(
        `delete from vendor_busy_dates
          where source = 'deal' and deal_id in (select id from deals where wedding_id = $1)`,
        [weddingId],
      )
      await client.query('update slots set deal_id = null where wedding_id = $1', [weddingId])
      // Архив на 12 месяцев, а не удаление: пара возвращается чаще, чем кажется
      // (План §19.1).
      await client.query('update weddings set cancelled_at = now(), archived_at = now() where id = $1', [weddingId])
      await client.query(
        `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'wedding.cancelled', 'wedding', $2)`,
        [userId, weddingId],
      )
      return { state: 'cancelled' as const, cancelledDeals: cancelled.length }
    })
  })
}
