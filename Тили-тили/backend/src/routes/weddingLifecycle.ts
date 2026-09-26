import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { withIdempotency } from '../deals/idempotency.js'
import { cancelDeal } from '../deals/cancel.js'
import type { DealState } from '../deals/state.js'
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
 * Что отменяется вместе со свадьбой.
 *
 * Не `COMMITTED`: в нём есть `done`, и отмена свадьбы отменяла уже выполненную
 * работу — подрядчик получал «Сделка отменена» по съёмке, которую провёл
 * полгода назад, а его занятость на тот день снималась, и календарь задним
 * числом показывал день свободным. Контракт обещает ровно две брони: `booked`
 * и `paid_deposit` — их и отменяем, `done` остаётся как было.
 */
export const CANCELLED_WITH_WEDDING: DealState[] = ['booked', 'paid_deposit']

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

      return withIdempotency(db(), request, reply, 'weddings.reschedule', (tx) =>
        /* Вся работа — в одной транзакции: между освобождением старых дат
         * и захватом новых другая пара успевает занять подрядчика. Ответ —
         * из неё же, вместе с записью идемпотентности (D2-13). */
        tx(async (client) => ({
          status: 200,
          body: await rescheduleWedding(client, weddingId, date, request.caller!.userId),
        })),
      )
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
        /* `for update of w` — на строку свадьбы, а не на всю выборку: двое
         * партнёров, нажавших «Отменить» одновременно, оба читали её в
         * READ COMMITTED и оба доходили до записи. В журнале появлялась
         * вторая строка `wedding.cancelled`, а `archived_at` сдвигался —
         * то есть срок хранения архива начинался заново. Второй теперь
         * ждёт первого и выходит по `cancelled_at`.
         *
         * Живые участники считаются отдельным подзапросом: партнёр, мягко
         * удаливший аккаунт, продолжал числиться в `wedding_members`, и
         * оставшийся не мог отменить свадьбу вовсе — каждое нажатие давало
         * `confirmation_required`, а подтвердить было некому. */
        `select w.cancel_requested_by, w.cancel_requested_at, w.cancelled_at,
                (select count(*)::text from wedding_members m
                   join users u on u.id = m.user_id and u.deleted_at is null
                  where m.wedding_id = w.id and m.role = 'couple') as couples
           from weddings w where w.id = $1 for update of w`,
        [weddingId],
      )
      const w = rows[0]!
      /* Страховка, а не рабочий путь: отменённая свадьба уходит в архив, а
       * хук доступа (`memberRole`) архивную не отдаёт вовсе — второй вызов
       * получает 404 раньше, чем доходит сюда. Ветка остаётся на случай
       * изменения матрицы доступа: отмена отменённой не должна отменять
       * сделки по второму разу. */
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

      /* Отбор броней под блокировкой строк, до отмены: from_state в
       * deal_events пишет cancelDeal() (F1) из своего собственного select
       * (deals/cancel.ts) — колонка state в этой выборке сама событие не
       * питает, она лишь часть строки для цикла ниже. */
      const { rows: cancelled } = await client.query<{ id: string; state: string }>(
        `select id, state from deals where wedding_id = $1 and state = any($2) for update`,
        [weddingId, CANCELLED_WITH_WEDDING],
      )
      /* Единственная дверь `cancelDeal` (F1) — та же, что у слота и
       * `PATCH /deals`: снимает дату через `releaseVendorDate` (а не голым
       * `delete`, RF-BE-02 — иначе отменённая сделка забирала день у
       * `done`-сделки того же подрядчика без своей строки в
       * `vendor_busy_dates`), гасит ссылки слота и маршруты автобуса, лид —
       * обратно в работу. `done` не трогается (`CANCELLED_WITH_WEDDING`, :27). */
      for (const deal of cancelled) {
        await cancelDeal(client, deal.id, {
          actorId: userId,
          note: 'свадьба отменена',
          reason: 'cancelled_by_couple',
        })
      }
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
