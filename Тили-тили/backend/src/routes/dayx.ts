import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { notifyWedding } from '../notify/notify.js'
import { noteVendorUpdate } from '../vendor/updates.js'

/** Насколько можно двигать день за один раз. Больше — это уже не «отстаём». */
const MAX_SHIFT_MINUTES = 240

/** Сценарии плана Б из §13.1: то, что в моках переключается кнопкой. */
const SCENARIOS = ['rain', 'vendor_missing', 'power', 'transport'] as const

/*
 * Ответ сдвига и плана Б (`DayXBroadcast`) говорит, кого это КАСАЕТСЯ —
 * `guestsAffected`, ответившие «да»: команда сообщает им сама. Поля «скольким
 * гостям ушло» (`notifiedGuests`) больше нет: канала до гостей нет (ни SMS,
 * ни почты — «Хвосты»), и оно всегда было нулём — числом, которое ничего не
 * сообщает (D4-18, R-174). Контракт снял его в v0.30.0; появится канал —
 * появится и настоящий счётчик, а не ноль под старым именем.
 */

/**
 * Чек-лист накануне — тот же список, что на экране «План Б» во фронте
 * (app/src/pages/Smart.tsx). Придумывать свой значило бы дать паре два
 * разных списка на одном экране после первой же синхронизации.
 */
const PLANB_CHECKLIST = [
  'Обзвонить всех подрядчиков за 1–2 дня: время и адрес прибытия',
  'Кольца и паспорта — у свидетелей',
  'Алкоголь и реквизит отвезти на площадку накануне вечером',
  'Проверить прогноз погоды и план Б площадки',
  'Запас 15 минут в каждом блоке тайминга',
  'Powerbank, аптечка, швейный набор, присыпка от пятен',
]

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
          await noteVendorUpdate(
            client,
            weddingId,
            'timeline',
            `Тайминг сдвинут на ${minutes > 0 ? '+' : ''}${minutes} мин`,
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

        /* Кого сдвиг КАСАЕТСЯ — `guestsAffected`, то же число, что
         * `recipients` в журнале рассылок: команда сообщает им сама. */
        return {
          status: 200,
          body: { minutes, shiftedBlocks: result.shifted, guestsAffected: result.guests },
        }
      })
    },
  )

  /* ── план Б ───────────────────────────────────────────────────────── */
  /**
   * Чек-лист накануне: сценарий, отметки и прогресс.
   *
   * Пункты заводятся при первом обращении, а не при создании свадьбы:
   * иначе у всех, кто завёл свадьбу раньше, экран остался бы пустым,
   * а миграция с приписыванием строк в чужие данные — не то, что стоит
   * делать ради шести галочек.
   *
   * Отмечаются пункты обычным `PATCH /tasks/{id}`: это задачи, и второй
   * путь для того же действия разошёлся бы с первым при первой же правке.
   */
  app.get('/weddings/:weddingId/planb', async (request) => {
    const weddingId = request.member!.weddingId
    const { rows: w } = await db().query<{ planb_scenario: string | null; planb_at: Date | null }>(
      'select planb_scenario, planb_at from weddings where id = $1',
      [weddingId],
    )

    const { rows: have } = await db().query<{ n: string }>(
      "select count(*)::text as n from tasks where wedding_id = $1 and kind = 'planb'",
      [weddingId],
    )
    if (Number(have[0]!.n) === 0) {
      for (const [i, title] of PLANB_CHECKLIST.entries()) {
        /* `on conflict do nothing` не спасёт — ограничения уникальности
         * по названию нет и быть не должно. Два одновременных открытия
         * экрана разойдутся редко и заметно: дубли видно сразу, а лишний
         * уникальный индекс на текст мешал бы паре завести свой пункт. */
        await db().query(
          `insert into tasks (id, wedding_id, title, source, sort, kind) values ($1,$2,$3,'system',$4,'planb')`,
          [uuidv7(), weddingId, title, i],
        )
      }
    }

    const { rows } = await db().query<{ id: string; title: string; done_at: Date | null }>(
      `select id, title, done_at from tasks
        where wedding_id = $1 and kind = 'planb' order by sort, title`,
      [weddingId],
    )
    return {
      scenario: w[0]?.planb_scenario ?? null,
      activatedAt: w[0]?.planb_at?.toISOString() ?? null,
      checklist: rows.map((r) => ({ id: r.id, title: r.title, done: r.done_at !== null })),
    }
  })

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
        const affected = await db().tx(async (client) => {
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
          // Журнал рассылок хранит, кого сценарий касается, — не кому ушло.
          await client.query(
            'insert into broadcasts (id, wedding_id, action, recipients) values ($1,$2,$3,$4)',
            [uuidv7(), weddingId, `planb:${scenario}`, Number(guests[0]!.n)],
          )
          return Number(guests[0]!.n)
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

        // Как и у сдвига: кого касается — число подтвердивших «да».
        return { status: 200, body: { scenario, guestsAffected: affected } }
      })
    },
  )
}
