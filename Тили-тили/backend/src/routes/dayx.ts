import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { notifyWedding } from '../notify/notify.js'

/** Насколько можно двигать день за один раз. Больше — это уже не «отстаём». */
const MAX_SHIFT_MINUTES = 240

/** Сценарии плана Б из §13.1: то, что в моках переключается кнопкой. */
const SCENARIOS = ['rain', 'vendor_missing', 'power', 'transport'] as const

export async function dayxRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /* ── сдвиг тайминга ───────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/timeline/shift',
    {
      schema: {
        body: {
          type: 'object',
          required: ['minutes'],
          additionalProperties: false,
          properties: { minutes: { type: 'integer', minimum: -MAX_SHIFT_MINUTES, maximum: MAX_SHIFT_MINUTES } },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { minutes } = request.body as { minutes: number }
      // 422, а не 409: контракт не обещает конфликта, а «ноль минут» —
      // это неверное значение, а не столкновение с чужим действием.
      if (minutes === 0) {
        throw new AppError(422, 'empty_shift', 'Сдвиг на ноль минут ничего не меняет', { minutes: 'не может быть 0' })
      }

      return withIdempotency(db(), request, reply, 'timeline-shift', async () => {
        const result = await db().tx(async (client) => {
          /* Двигаются блоки, которые ЕЩЁ НЕ НАЧАЛИСЬ. Прошедшие не трогаем:
           * церемония, которая уже прошла, не сдвинется от того, что банкет
           * задержался, а в расписании поедет всё. */
          const { rows: moved } = await client.query<{ id: string }>(
            `update timeline_events
                set starts_at = starts_at + make_interval(mins => $2),
                    ends_at = ends_at + make_interval(mins => $2)
              where wedding_id = $1 and starts_at is not null and starts_at > now()
              returning id`,
            [weddingId, minutes],
          )
          await client.query('insert into timeline_shifts (id, wedding_id, minutes, actor_id) values ($1,$2,$3,$4)', [
            uuidv7(),
            weddingId,
            minutes,
            request.caller!.userId,
          ])
          // Факт рассылки — в общий журнал: он же считает получателей
          // и держит дебаунс на массовых действиях (этап 5).
          const { rows: guests } = await client.query<{ n: string }>(
            "select count(*)::text as n from guests where wedding_id = $1 and rsvp = 'yes'",
            [weddingId],
          )
          await client.query(
            'insert into broadcasts (id, wedding_id, action, recipients) values ($1,$2,$3,$4)',
            [uuidv7(), weddingId, 'timeline-shift', Number(guests[0]!.n)],
          )
          return { shifted: moved.length, guests: Number(guests[0]!.n) }
        })

        /* День X критичен: тихие часы его не держат — гости уже в дороге.
         * Подрядчикам тоже: §13.2 требует, чтобы `timeline.shifted` доходил
         * до забронированных, иначе ведущий приедет к прежнему времени. */
        await notifyWedding(
          db(),
          weddingId,
          request.caller!.userId,
          {
            kind: 'system',
            title: 'Тайминг сдвинут',
            body: `День X сдвинут на ${minutes > 0 ? '+' : ''}${minutes} мин`,
            link: '/dayx',
            critical: true,
          },
          new Date(),
          true,
        )

        return { status: 200, body: { minutes, shiftedBlocks: result.shifted, notifiedGuests: result.guests } }
      })
    },
  )

  /* ── план Б ───────────────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/planb/activate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['scenario'],
          additionalProperties: false,
          properties: { scenario: { type: 'string', enum: [...SCENARIOS] } },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { scenario } = request.body as { scenario: string }

      return withIdempotency(db(), request, reply, 'planb-activate', async () => {
        const result = await db().tx(async (client) => {
          /* Запоминаем ТОЛЬКО факт и сценарий. Новой точки сбора в продукте
           * нет нигде — ни в моках, ни в договоре с площадкой её поля не
           * заведено, — и выдумывать её здесь не за чем: план Б в §13.1
           * согласуется заранее, приложение его объявляет. */
          await client.query('update weddings set planb_scenario = $2, planb_at = now() where id = $1', [
            weddingId,
            scenario,
          ])
          const { rows: guests } = await client.query<{ n: string }>(
            "select count(*)::text as n from guests where wedding_id = $1 and rsvp = 'yes'",
            [weddingId],
          )
          await client.query(
            'insert into broadcasts (id, wedding_id, action, recipients) values ($1,$2,$3,$4)',
            [uuidv7(), weddingId, `planb:${scenario}`, Number(guests[0]!.n)],
          )
          return { guests: Number(guests[0]!.n) }
        })

        await notifyWedding(
          db(),
          weddingId,
          request.caller!.userId,
          {
            kind: 'system',
            title: 'Активирован план Б',
            body: 'Сценарий включён — проверьте точку сбора и тайминг',
            link: '/dayx',
            critical: true,
          },
          new Date(),
          true,
        )

        return { status: 200, body: { scenario, notifiedGuests: result.guests } }
      })
    },
  )
}
