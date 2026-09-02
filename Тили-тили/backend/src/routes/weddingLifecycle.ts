import type { FastifyInstance } from 'fastify'
import { AppError, conflict } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { isUniqueViolation } from '../plugins/db.js'
import { withIdempotency } from '../deals/idempotency.js'
import { COMMITTED } from '../deals/state.js'

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

      return withIdempotency(db(), request, reply, 'weddings.reschedule', async () => {
        const result = await db().tx(async (client) => {
          const { rows: w } = await client.query<{ date: string | null }>(
            'select date::text as date from weddings where id = $1',
            [weddingId],
          )
          const oldDate = w[0]?.date ?? null
          if (oldDate === date) return { status: 200 as const, report: { free: [], busy: [] } }

          // Кто из забронированной команды свободен на новую дату, а кто нет.
          // Ответ нужен целиком: пара решает, отменять ли занятого, а не
          // получает «не получилось» без объяснения (План §9.4).
          const { rows: team } = await client.query<{
            deal_id: string
            vendor_id: string | null
            name: string
            busy: boolean
          }>(
            `select d.id as deal_id, d.vendor_id,
                    coalesce(ven.name, d.external_name) as name,
                    exists (
                      select 1 from vendor_busy_dates b
                       where b.vendor_id = d.vendor_id and b.date = $2::date
                         and (b.deal_id is null or b.deal_id <> d.id)
                    ) as busy
               from deals d
               left join vendors ven on ven.id = d.vendor_id
              where d.wedding_id = $1 and d.state = any($3)`,
            [weddingId, date, COMMITTED],
          )

          const busy = team.filter((t) => t.busy).map((t) => t.name)
          const free = team.filter((t) => !t.busy).map((t) => t.name)
          if (busy.length > 0) {
            // Частичный перенос хуже отказа: половина команды осталась
            // на старой дате, и это выясняется в день свадьбы.
            throw new AppError(409, 'team_busy', `Заняты на новую дату: ${busy.join(', ')}`, {
              busy: busy.join(', '),
            })
          }

          await client.query('update weddings set date = $2::date where id = $1', [weddingId, date])
          // Старые даты освобождаются, новые захватываются в той же транзакции.
          await client.query(
            `delete from vendor_busy_dates
              where source = 'deal' and deal_id in (select id from deals where wedding_id = $1)`,
            [weddingId],
          )
          for (const member of team) {
            if (!member.vendor_id) continue
            try {
              await client.query(
                `insert into vendor_busy_dates (vendor_id, date, source, deal_id)
                 values ($1, $2::date, 'deal', $3)`,
                [member.vendor_id, date, member.deal_id],
              )
            } catch (error) {
              if (isUniqueViolation(error)) {
                throw conflict('date_taken', `Дата у «${member.name}» занята`)
              }
              throw error
            }
          }
          // Сроки задач считались от старой даты — сдвигаем на ту же разницу.
          if (oldDate) {
            await client.query(
              `update tasks set due = due + ($2::date - $3::date) where wedding_id = $1 and due is not null`,
              [weddingId, date, oldDate],
            )
            // `date - date` даёт целое число дней, а к timestamptz целое
            // прибавить нельзя — нужен интервал.
            await client.query(
              `update timeline_events
                  set starts_at = starts_at + make_interval(days => ($2::date - $3::date)),
                      ends_at = ends_at + make_interval(days => ($2::date - $3::date))
                where wedding_id = $1`,
              [weddingId, date, oldDate],
            )
          }
          return { status: 200 as const, report: { free, busy } }
        })
        return { status: result.status, body: result.report }
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
        cancelled_at: Date | null
        couples: string
      }>(
        `select w.cancel_requested_by, w.cancelled_at,
                (select count(*)::text from wedding_members m
                  where m.wedding_id = w.id and m.role = 'couple') as couples
           from weddings w where w.id = $1`,
        [weddingId],
      )
      const w = rows[0]!
      if (w.cancelled_at) return { state: 'cancelled' as const }

      const couples = Number(w.couples)
      // Отмена требует подтверждения ОБОИХ партнёров: свадьба — общее решение,
      // и один в ссоре не должен стирать полгода работы двоих.
      if (couples > 1 && w.cancel_requested_by === null) {
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
