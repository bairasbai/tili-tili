import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { withIdempotency } from '../deals/idempotency.js'
import { cancelDeal } from '../deals/cancel.js'
import { lockBookingActor, lockBookingReplay } from '../deals/book.js'
import { DEAL_COLUMNS, DEAL_JOINS, expireHolds, holdVendorDate, toDeal, type DealRow } from '../deals/repo.js'
import { COMMITTED, DEAL_STATES, HOLD_HOURS, assertTransition, type DealState } from '../deals/state.js'
import { assertLegacyDateBookingAllowed } from '../resources/booking-boundary.js'

/**
 * После аванса сумма фиксируется: деньги уже перешли, и молчаливая правка
 * сметы задним числом развела бы платёж и договор. Отменённая сделка
 * не правится по той же причине, по какой не правится закрытая книга.
 */
const PRICE_LOCKED = new Set<DealState>(['paid_deposit', 'done', 'cancelled'])

/** Копейки в человеческую строку для записи в журнал сделки. */
const rubles = (amount: number) => `${new Intl.NumberFormat('ru-RU').format(Math.round(amount / 100))} ₽`

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
    if (!isUuid(dealId)) throw notFound('Сделка не найдена')
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

  /**
   * Журнал сделки: что и когда произошло.
   *
   * События писались с самого начала и не читались нигде — при споре «мы
   * договаривались на другую сумму» доказательство лежало в базе и никому не
   * показывалось.
   *
   * Видят обе стороны: пара и подрядчик. Автор назван ролью, а не именем —
   * ни пара, ни подрядчик не получают отсюда чужой идентификатор.
   */
  app.get(
    '/deals/:dealId/events',
    /* Формат идентификатора проверяет схема: 422 — про формат, 404 — про
       содержимое. Путь контракта не имеет права отвечать 404 на кривой id,
       иначе «адреса нет» и «сделки нет» сливаются в один ответ. */
    {
      /* Журнал — часть сделки: тот же вход, что и у правки. Без этого
         `request.caller` пуст, и путь падает пятисоткой вместо отказа. */
      preHandler: app.requireConsent,
      schema: { params: { type: 'object', required: ['dealId'], properties: { dealId: UUID_ID } } },
    },
    async (request) => {
    const { dealId } = request.params as { dealId: string }
    const userId = request.caller!.userId

    /* Две ветки — два разных права, и имена у них разные нарочно.
     *
     * Первая отдаёт роль участника свадьбы, и среди ролей есть `vendor` —
     * подрядчик, принятый ПОДР-ссылкой в команду. Вторая говорит «это
     * подрядчик ИМЕННО ЭТОЙ сделки». Пока обе назывались `vendor`, участник
     * с ролью `vendor` проходил проверку ниже как сторона сделки и читал
     * журнал сумм любой сделки свадьбы — чужой ему коллеги (D1-04). */
    const { rows: access } = await db().query<{ side: string }>(
      `select m.role as side from deals d
         join wedding_members m on m.wedding_id = d.wedding_id and m.user_id = $2
        where d.id = $1
       union all
       select 'deal_vendor' as side from deals d
         join vendors v on v.id = d.vendor_id and v.user_id = $2
        where d.id = $1`,
      [dealId, userId],
    )
    // Чужая сделка — 404: по кодам ответа не должно быть видно, какие
    // идентификаторы существуют.
    if (access.length === 0) throw notFound('Сделка не найдена')
    /* Журнал — деньги: «сумма изменена: 100 000 ₽ → 80 000 ₽» лежит в нём
     * текстом. Помощник и координатор денег не видят нигде (§6, ERR-0026),
     * а здесь до 2026-09-06 видели: проверка спрашивала «участник ли»,
     * а не «пара ли». Им 403, не 404: сделку они и так знают по мозаике.
     * Участник с ролью `vendor` — такой же не-пара: суммы чужой сделки
     * ему не положены, как и помощнику. */
    if (!access.some((a) => a.side === 'couple' || a.side === 'deal_vendor')) {
      throw new AppError(403, 'forbidden', 'Журнал сделки видят пара и подрядчик — в нём суммы')
    }

    const { rows } = await db().query<{
      id: string
      kind: string
      from_state: string | null
      to_state: string
      note: string | null
      at: Date
      by: string | null
    }>(
      `select e.id, e.kind, e.from_state, e.to_state, e.note, e.at,
              case
                when e.actor_id is null then 'system'
                when exists(select 1 from vendors v where v.id = d.vendor_id and v.user_id = e.actor_id) then 'vendor'
                else 'couple'
              end as by
         from deal_events e join deals d on d.id = e.deal_id
        where e.deal_id = $1
        order by e.at`,
      [dealId],
    )
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      fromState: r.from_state,
      toState: r.to_state,
      by: r.by,
      note: r.note,
      at: r.at.toISOString(),
    }))
  },
  )

  app.patch(
    '/deals/:dealId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          // Одно из двух обязательно: пустая правка — это не правка.
          anyOf: [{ required: ['state'] }, { required: ['price'] }],
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: [...DEAL_STATES] },
            price: {
              type: 'object',
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                currency: { type: 'string', enum: ['RUB'] },
              },
            },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { dealId } = request.params as { dealId: string }
      const body = request.body as { state?: DealState; price?: { amount: number }; note?: string }
      const userId = request.caller!.userId

      return withIdempotency(db(), request, reply, 'deals.patch', (tx) =>
        tx(async (client) => {
          const deal = await dealForCouple(client, dealId, userId)

          /* Строка свадьбы — `for update` и ПЕРВОЙ: отмена также меняет
           * назначения программы и её ревизию, без повышения share-замка.
           * Дата читается ниже, чтобы
           * занять её у подрядчика, а перенос (`rescheduleWedding`) держит
           * свадьбу `for update` и двигает занятость по открытым броням. Без
           * замка переход в бронь между чтением даты и записью занимал у
           * подрядчика день, которого у свадьбы уже нет (ревью 015, D2/D3).
           * Порядок «свадьба → сделка» — тот же, что у переноса: обратный
           * давал бы взаимную блокировку. */
          const { rows: w } = await client.query<{ date: string | null }>(
            'select date::text as date from weddings where id = $1 and archived_at is null and cancelled_at is null for update',
            [deal.wedding_id],
          )
          if (!w[0]) throw notFound('Свадьба не найдена')
          await lockBookingActor(client, { weddingId: deal.wedding_id, actorId: userId,
            sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion })
          await expireHolds(client, deal.wedding_id)

          /* `for update`: два одновременных перехода читали одно состояние и
           * оба проходили `assertTransition` — две записи в журнале и два
           * уведомления об одном событии. Второй ждёт первого и видит уже
           * новое состояние (R-49). Цена — тем же чтением: `dealForCouple`
           * читал её до замка, и две правки суммы подряд писали в журнал
           * «изменена: 100 000 → 80 000» обе — вторая от той же старой
           * суммы (ревью 015, D6). */
          const { rows: fresh } = await client.query<{ state: DealState; price: string | null }>(
            'select state, price::text as price from deals where id = $1 for update',
            [dealId],
          )
          const from = fresh[0]!.state
          if (body.state && COMMITTED.includes(body.state) && !COMMITTED.includes(from) && deal.vendor_id) {
            await assertLegacyDateBookingAllowed(client, deal.vendor_id)
          }

          /* Смена цены без смены состояния — отдельный случай, и журнал
           * это различает: рассылка берёт заголовок из `to_state` и на
           * общей записи объявила бы «сделка забронирована» на правку сметы. */
          if (body.price !== undefined) {
            if (PRICE_LOCKED.has(from)) {
              throw conflict(
                'price_locked',
                from === 'cancelled'
                  ? 'Сделка отменена — менять сумму не в чем'
                  : 'После внесения аванса сумма фиксируется',
              )
            }
            /* Цены не было — это `null`, а не ноль: `Number(null)` даёт 0, и
             * «назначить 0 ₽» сделке без цены выглядело как «ничего не
             * изменилось» — ни записи, ни события, а в ответе так и стояло
             * `null` при том, что клиент просил ноль (D2-16, R-178). */
            const was = fresh[0]!.price === null ? null : Number(fresh[0]!.price)
            if (was !== body.price.amount) {
              await client.query('update deals set price = $2 where id = $1', [dealId, body.price.amount])
              await client.query(
                `insert into deal_events (id, deal_id, from_state, to_state, actor_id, note, kind)
                 values ($1, $2, $3, $3, $4, $5, 'price')`,
                [
                  uuidv7(),
                  dealId,
                  from,
                  userId,
                  body.note ??
                    (was === null
                      ? `Сумма назначена: ${rubles(body.price.amount)}`
                      : `Сумма изменена: ${rubles(was)} → ${rubles(body.price.amount)}`),
                ],
              )
            }
          }

          if (body.state === undefined) {
            const { rows: only } = await client.query<DealRow>(
              `select ${DEAL_COLUMNS} from deals d ${DEAL_JOINS} where d.id = $1`,
              [dealId],
            )
            return { status: 200, body: toDeal(only[0]!, true) }
          }

          /* Отмена — через единственную дверь `cancelDeal` (F1, ARB-1 = A):
           * повторная отмена отвечает `already_cancelled`, а не общим
           * `bad_transition` ниже, и все побочные эффекты (дата, слот,
           * маршруты, лид, ссылки слота) идут одним и тем же кодом у всех
           * четырёх HTTP-дверей. */
          if (body.state === 'cancelled') {
            await cancelDeal(client, dealId, { actorId: userId, sessionId: request.caller!.sessionId,
              policyVersion: app.appConfig.policyVersion, note: body.note ?? null })
            const { rows: out } = await client.query<DealRow>(
              `select ${DEAL_COLUMNS} from deals d ${DEAL_JOINS} where d.id = $1`,
              [dealId],
            )
            return { status: 200, body: toDeal(out[0]!, true) }
          }

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

          await client.query(`update deals set ${sets.join(', ')} where id = $1`, args)

          /* Дата подрядчика занимается при первом входе в обязательство —
           * в любое из `COMMITTED`, а не только в `booked`: переход вперёд
           * через ступень разрешён (`negotiating → paid_deposit`), и сделка,
           * миновавшая `booked`, деньги обещала, а дату не держала — её
           * забирала другая пара (D2-07). Освобождается при отмене. Держать
           * дату на переговорах значит блокировать чужие свадьбы под
           * несуществующую договорённость. */
          if (COMMITTED.includes(body.state) && !COMMITTED.includes(from) && deal.vendor_id) {
            // Дата — из чтения под замком свадьбы выше.
            if (w[0]?.date) {
              await holdVendorDate(client, deal.vendor_id, w[0].date, dealId, deal.wedding_id)
            }
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
          return { status: 200, body: toDeal(out[0]!, true) }
        }),
        true, async client => {
          const deal = await dealForCouple(client, dealId, userId)
          await lockBookingReplay(client, { weddingId: deal.wedding_id, dealId, actorId: userId,
            sessionId: request.caller!.sessionId, policyVersion: app.appConfig.policyVersion })
        },
      )
    },
  )
}
