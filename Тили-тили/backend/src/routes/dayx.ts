import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { notifyWedding } from '../notify/notify.js'
import { timelineShiftRoutes } from '../timeline/routes.js'

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

  await timelineShiftRoutes(app)

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

      return withIdempotency(db(), request, reply, 'planb-activate', async (tx) => {
        // Ответ — из транзакции действия, рассылка — после (D2-13), как у сдвига тайминга.
        const result = await tx(async (client) => {
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
          // Как и у сдвига: кого касается — число подтвердивших «да».
          return { status: 200, body: { scenario, guestsAffected: Number(guests[0]!.n) } }
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

        return result
      })
    },
  )
}
