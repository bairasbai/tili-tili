import { taskRoutes } from './tasks.js'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { AppError, conflict, gone, notFound, quotaExceeded, validationFailed } from '../errors.js'
import { isCheckViolation, type Queryable } from '../plugins/db.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { withIdempotency } from '../deals/idempotency.js'
import { guestByToken, type GuestCaller } from '../guests/access.js'
import { personCount } from './guests.js'
import { messagePage, notifyOthers, toMessage } from './chats.js'
import { notifyWedding } from '../notify/notify.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import { plural } from '../text/plural.js'
import { assertRealDate, isRealDate } from '../wedding/dates.js'
import { COMMITTED, type DealState } from '../deals/state.js'

/** Повтор рассылки в это окно считается тем же нажатием. */
const DEBOUNCE_SECONDS = 30

/* Замок на пару «свадьба + действие» для дебаунса рассылки (класс R-271):
 * строки, которую можно запереть, ещё нет — именно её отсутствие и проверяется. */
const BROADCAST_LOCK = 4_210_004

const MONEY_MAX = Number.MAX_SAFE_INTEGER

/** Дата-время тайминга: `2027-06-14T09:00:00.000Z` или со смещением `+03:00`. */
const ISO_MOMENT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Момент тайминга с проверкой до базы.
 *
 * Схема тела знала только `type: string`, и «вчера» или 30 февраля доходили
 * до `$5::timestamptz` — PostgreSQL роняет такой запрос, человек получает
 * 500, в журнал летит ложная авария (D2-12, класс R-103/ERR-0088).
 * Календарность даты проверяет общий помощник (`isRealDate`), остальное —
 * `Date.parse`: одного его мало, V8 читает 30 февраля как 2 марта.
 *
 * Пустая строка — «время ещё не назначено»: так экран возвращает `null`,
 * полученный из GET (`startsAt: e.startsAt ?? ''`), и до этой проверки такой
 * блок тоже падал в 500 при любом сохранении тайминга без даты свадьбы.
 */
function momentOrNull(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  const m = ISO_MOMENT.exec(value)
  if (!m || !isRealDate(m[1]!) || Number.isNaN(Date.parse(value))) {
    throw validationFailed({ [field]: 'ожидается дата-время вида 2027-06-14T09:00:00Z' })
  }
  return value
}

/**
 * Сделка перевозчика, к которой пара привязывает маршрут (фича 006).
 *
 * Перевозчик в системе — подрядчик: сделка в слоте «Транспорт». Маршрут может
 * ссылаться только на сделку ЭТОЙ свадьбы (чужой `dealId` — 422, как любое
 * негодное поле: 404 здесь выдал бы перебором, какие сделки существуют), в
 * слоте категории `transport` (свой перевозчик, заведённый в «Прочее», не
 * годится — 422 `not_transport` с подсказкой, куда его завести) и живую:
 * отменённая — 409 `deal_cancelled`, а кандидат или переговоры — 409
 * `deal_not_booked` (фича 014, A3): маршрут «везёт перевозчик X» — обещание
 * гостям, и давать его за подрядчика, который ещё ничего не подтвердил,
 * нельзя (R-174). Категория и принадлежность — кросс-табличные, CHECK их
 * не выразить.
 *
 * Общая для `POST` и `PATCH …/logistics/buses`; живёт на уровне модуля, а не
 * внутри обработчика: правило одно, а дверей две.
 */
async function carrierDeal(db: Queryable, weddingId: string, dealId: string): Promise<void> {
  /* Строка сделки под замком: параллельная отмена (`PATCH /deals` →
   * `detachBusRoutes`) иначе проходила между проверкой и записью маршрута,
   * и маршрут оставался с отменённой сделкой (ревью 015). */
  const { rows } = await db.query<{ category_id: string; state: string }>(
    `select s.category_id, d.state from deals d join slots s on s.id = d.slot_id
      where d.id = $1 and d.wedding_id = $2 for update of d`,
    [dealId, weddingId],
  )
  if (rows.length === 0) throw validationFailed({ dealId: 'сделка не найдена в этой свадьбе' })
  if (rows[0]!.category_id !== 'transport') {
    throw new AppError(
      422,
      'not_transport',
      'Перевозчик заводится в слоте «Транспорт» — свяжите маршрут с транспортной сделкой',
      { dealId: 'сделка не в слоте «Транспорт»' },
    )
  }
  if (rows[0]!.state === 'cancelled') {
    throw conflict('deal_cancelled', 'Сделка с перевозчиком отменена — выберите другую или оставьте маршрут без перевозчика')
  }
  if (!COMMITTED.includes(rows[0]!.state as DealState)) {
    throw conflict('deal_not_booked', 'Перевозчик ещё не забронирован — сначала подтвердите сделку, потом привяжите маршрут')
  }
}

/**
 * Гость дня X — по той же ссылке, что и остальные `/join/{t}/…` (фича 009).
 *
 * Мёртвая ссылка здесь — 410, а не 401 (контракт v0.32.0, как у
 * `/guest-vendor/{token}`): ссылка была и отозвана или истекла, и экрану
 * гостя нужно «попросите пару прислать новую», а не приглашение войти.
 * Ответ на «нет такого токена» и «свадьба отменена» один и тот же — по коду
 * не должно быть видно, существовал ли токен (как в `guestByToken`).
 */
async function guestOfDay(db: Queryable, token: string): Promise<GuestCaller> {
  try {
    return await guestByToken(db, token)
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) {
      throw gone('Ссылка недействительна: отозвана или истекла — попросите пару прислать новую')
    }
    throw error
  }
}

export async function dayRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  await taskRoutes(app)

  /* ── тайминг ──────────────────────────────────────────────────────── */
  interface EventRow {
    id: string
    name: string
    location: string | null
    starts_at: Date | null
    ends_at: Date | null
    who: string | null
    icon: string | null
    outdoor: boolean
    for_guests: boolean
  }
  /* Одни колонки на все чтения тайминга: список, ответ `PUT`, автоплан. Пока
   * их перечисляли в каждом запросе, новая колонка (`for_guests`, фича 009)
   * означала бы четыре правки — и одна забытая отдавала бы блок без признака. */
  const EVENT_COLUMNS = 'id, name, location, starts_at, ends_at, who, icon, outdoor, for_guests'
  const toEvent = (r: EventRow) => ({
    id: r.id,
    name: r.name,
    location: r.location,
    startsAt: r.starts_at?.toISOString() ?? null,
    endsAt: r.ends_at?.toISOString() ?? null,
    who: r.who,
    icon: r.icon,
    outdoor: r.outdoor,
    /* Видят ли блок гости в день X (`GET /join/{t}/day`, фича 009). Признак
     * хранит база и по умолчанию ставит «да»: программа праздника — норма,
     * «сборы невесты» пара снимает галочкой. */
    forGuests: r.for_guests,
  })
  const timelineEtag = (version: number) => `"timeline-${version}"`

  app.get('/weddings/:weddingId/timeline', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const [{ rows }, { rows: state }] = await Promise.all([
      db().query<EventRow>(
        `select ${EVENT_COLUMNS} from timeline_events where wedding_id = $1 order by sort, starts_at`,
        [weddingId],
      ),
      db().query<{ timeline_version: number }>('select timeline_version from weddings where id = $1', [weddingId]),
    ])
    reply.header('ETag', timelineEtag(state[0]!.timeline_version))
    return rows.map(toEvent)
  })

  app.put(
    '/weddings/:weddingId/timeline',
    {
      schema: {
        body: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: {
              id: UUID_ID,
              name: { type: 'string', minLength: 1, maxLength: 200 },
              location: { type: 'string', nullable: true, maxLength: 300 },
              startsAt: { type: 'string', nullable: true },
              endsAt: { type: 'string', nullable: true },
              who: { type: 'string', nullable: true, maxLength: 300 },
              icon: { type: 'string', nullable: true, maxLength: 16 },
              outdoor: { type: 'boolean', default: false },
              // Пропущено — виден: как у колонки в базе и у блока без галочки.
              forGuests: { type: 'boolean', default: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const events = request.body as {
        id?: string
        name: string
        location?: string | null
        startsAt?: string | null
        endsAt?: string | null
        who?: string | null
        icon?: string | null
        outdoor?: boolean
        forGuests?: boolean
      }[]

      // Время проверяется ДО базы: иначе «вчера» и 30 февраля доходят до
      // `::timestamptz`, и человек получает 500 вместо отказа (D2-12).
      const moments = events.map((e, i) => ({
        startsAt: momentOrNull(e.startsAt, `${i}.startsAt`),
        endsAt: momentOrNull(e.endsAt, `${i}.endsAt`),
      }))

      const suppliedIds = events.flatMap((event) => (event.id ? [event.id] : []))
      if (new Set(suppliedIds).size !== suppliedIds.length) {
        throw validationFailed({ id: 'Один и тот же блок тайминга передан несколько раз' })
      }

      const result = await db().tx(async (client) => {
        // Aggregate-lock сериализует full replace, Day-X shift и перенос даты.
        // На T005 эта же строка станет CAS-точкой для If-Match.
        await client.query('select id from weddings where id = $1 for update', [weddingId])
        const { rows: current } = await client.query<{ id: string }>(
          'select id from timeline_events where wedding_id = $1',
          [weddingId],
        )
        const currentIds = new Set(current.map((row) => row.id))
        const keptIds: string[] = []

        let sort = 0
        for (const [i, e] of events.entries()) {
          const id = e.id ?? uuidv7()
          if (e.id && !currentIds.has(e.id)) {
            // Не различаем «удалён» и «принадлежит другой свадьбе»: чужой ID
            // не должен становиться oracle для межсвадебной изоляции.
            throw conflict('timeline_event_stale', 'Тайминг уже изменился — обновите страницу и повторите правку')
          }

          if (e.id) {
            await client.query(
              `update timeline_events
                  set name = $3, location = $4, starts_at = $5::timestamptz, ends_at = $6::timestamptz,
                      who = $7, icon = $8, outdoor = $9, for_guests = $10, sort = $11
                where id = $1 and wedding_id = $2`,
              [
                id,
                weddingId,
                e.name,
                e.location ?? null,
                moments[i]!.startsAt,
                moments[i]!.endsAt,
                e.who ?? null,
                e.icon ?? null,
                e.outdoor ?? false,
                e.forGuests ?? true,
                sort,
              ],
            )
          } else {
            await client.query(
              `insert into timeline_events (id, wedding_id, name, location, starts_at, ends_at, who, icon, outdoor, for_guests, sort)
               values ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10,$11)`,
              [
                id,
                weddingId,
                e.name,
                e.location ?? null,
                moments[i]!.startsAt,
                moments[i]!.endsAt,
                e.who ?? null,
                e.icon ?? null,
                e.outdoor ?? false,
                e.forGuests ?? true,
                sort,
              ],
            )
          }
          keptIds.push(id)
          sort += 1
        }

        // Семантика endpoint остаётся full replacement: пропущенный ID удалён.
        await client.query(
          'delete from timeline_events where wedding_id = $1 and not (id = any($2::uuid[]))',
          [weddingId, keptIds],
        )

        const { rows: versionRows } = await client.query<{ timeline_version: number }>(
          'update weddings set timeline_version = timeline_version + 1 where id = $1 returning timeline_version',
          [weddingId],
        )
        // Тайминг переписали целиком — подрядчику приезжать к другому часу.
        await noteVendorUpdate(client, weddingId, 'timeline', 'Тайминг дня обновлён')
        const { rows } = await client.query<EventRow>(
          `select ${EVENT_COLUMNS} from timeline_events where wedding_id = $1 order by sort`,
          [weddingId],
        )
        return { events: rows.map(toEvent), version: versionRows[0]!.timeline_version }
      })
      reply.header('ETag', timelineEtag(result.version))
      return result.events
    },
  )

  app.post('/weddings/:weddingId/timeline/autogen', async (request) => {
    const weddingId = request.member!.weddingId
    const { rows: current } = await db().query<EventRow>(
      `select ${EVENT_COLUMNS} from timeline_events where wedding_id = $1 order by sort`,
      [weddingId],
    )
    const { rows: team } = await db().query<{ label: string; performer: string | null }>(
      `select s.label, coalesce(ven.name, d.external_name) as performer
         from deals d join slots s on s.id = d.slot_id
         left join vendors ven on ven.id = d.vendor_id
        where d.wedding_id = $1 and d.state = any($2)`,
      [weddingId, COMMITTED],
    )

    // Кто за что отвечает — из забронированной команды. Черновик, а не
    // применение: контракт обещает предпросмотр, и переписывать тайминг
    // без спроса нельзя.
    const events = current.map((e) => ({
      ...toEvent(e),
      who: e.who ?? (team.map((t) => `${t.label}: ${t.performer ?? ''}`).join(' · ') || null),
    }))

    const conflicts: string[] = []
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!
      const cur = events[i]!
      if (prev.endsAt && cur.startsAt && new Date(cur.startsAt) < new Date(prev.endsAt)) {
        conflicts.push(`«${cur.name}» начинается раньше, чем заканчивается «${prev.name}»`)
      }
    }
    if (team.length === 0) conflicts.push('Команда ещё не забронирована — план собран без исполнителей')
    return { events, conflicts }
  })

  /* ── логистика: автобусы ──────────────────────────────────────────── */
  interface BusRow {
    id: string
    name: string
    pickup: string | null
    departs: string | null
    seats: number
    taken: number
    deal_id: string | null
    carrier: string | null
    carrier_vendor_id: string | null
    carrier_state: string | null
  }
  const toBus = (r: BusRow) => ({
    id: r.id,
    name: r.name,
    from: r.pickup,
    time: r.departs?.slice(0, 5) ?? null,
    seats: r.seats,
    taken: r.taken,
    dealId: r.deal_id,
    carrier: r.carrier,
  })

  /* Маршрут — работа перевозчика глазами гостей, и имя перевозчика берётся из
   * его сделки (фича 006): анкета из каталога или свой подрядчик. Отмена
   * сделки её строку не удаляет (`state = 'cancelled'`), поэтому `SET NULL`
   * у FK не срабатывает — «перевозчик убран» решается здесь: отменённая
   * сделка не считается сделкой маршрута, `dealId` и `carrier` — null, а
   * маршрут и записи гостей остаются. Телефон и цена сюда не идут: то же
   * читает гость. */
  const BUS_SELECT = `
    select r.id, r.name, r.pickup, r.departs::text as departs, r.seats, r.taken,
           d.id as deal_id, coalesce(v.name, d.external_name) as carrier,
           d.vendor_id as carrier_vendor_id, d.state as carrier_state
      from bus_routes r
      left join deals d on d.id = r.deal_id and d.state <> 'cancelled'
      left join vendors v on v.id = d.vendor_id`

  const busesOf = async (client: Queryable, weddingId: string) => {
    const { rows } = await client.query<BusRow>(
      `${BUS_SELECT} where r.wedding_id = $1 order by r.departs nulls last, r.name`,
      [weddingId],
    )
    return rows.map(toBus)
  }

  /**
   * Заметка перевозчику из каталога: «пара добавила/изменила маршрут».
   *
   * Тот же механизм, что у рассадки (`vendor_updates`, §13.2), но адресат
   * один — подрядчик по сделке маршрута, а не все забронированные: декоратору
   * автобус пары не нужен. Общий `noteVendorUpdate` рассылает всем, поэтому
   * строка пишется здесь тем же оператором (одна неподтверждённая на вид и
   * свадьбу — правки сливаются, как у рассадки). Вид — `transport` (фича
   * 014, миграция 1760400000000): до неё писалось под видом `timeline`, и
   * карточка не могла назвать событие своим словом.
   * Своему подрядчику (без анкеты) писать некуда; кандидату, который ещё
   * ничего не обещал, — незачем, как и в `noteVendorUpdate`.
   */
  const noteCarrier = async (client: Queryable, weddingId: string, row: BusRow, verb: 'добавила' | 'изменила') => {
    if (!row.carrier_vendor_id || !COMMITTED.includes(row.carrier_state as DealState)) return
    const seats = `${row.seats} ${plural(row.seats, 'место', 'места', 'мест')}`
    const time = row.departs ? `, сбор ${row.departs.slice(0, 5)}` : ''
    await client.query(
      `insert into vendor_updates (id, vendor_id, wedding_id, kind, text) values ($1,$2,$3,'transport',$4)
       on conflict (vendor_id, wedding_id, kind) where ack_at is null
       do update set text = excluded.text, created_at = now()`,
      [uuidv7(), row.carrier_vendor_id, weddingId, `Пара ${verb} маршрут «${row.name}» — ${seats}${time}`],
    )
  }

  /* Чтения не было вовсе: маршрут заводился и удалялся, но не показывался.
     `taken` считает сервер атомарно при записи гостя — клиенту его взять
     больше неоткуда. */
  app.get('/weddings/:weddingId/logistics/buses', async (request) => busesOf(db(), request.member!.weddingId))

  app.post(
    '/weddings/:weddingId/logistics/buses',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'seats'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            from: { type: 'string', maxLength: 300 },
            time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
            seats: { type: 'integer', minimum: 1, maximum: 500 },
            taken: { type: 'integer' },
            // Сделка перевозчика уходит в колонку uuid; `null` — маршрут без перевозчика.
            dealId: { ...UUID_ID, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const body = request.body as { name: string; from?: string; time?: string; seats: number; dealId?: string | null }
      const id = uuidv7()
      const created = await db().tx(async (client) => {
        if (body.dealId) await carrierDeal(client, weddingId, body.dealId)
        await client.query(
          `insert into bus_routes (id, wedding_id, name, pickup, departs, seats, deal_id)
           values ($1,$2,$3,$4,$5::time,$6,$7)`,
          [id, weddingId, body.name, body.from ?? null, body.time ?? null, body.seats, body.dealId ?? null],
        )
        const { rows } = await client.query<BusRow>(`${BUS_SELECT} where r.id = $1`, [id])
        await noteCarrier(client, weddingId, rows[0]!, 'добавила')
        return rows[0]!
      })
      return reply.code(201).send(toBus(created))
    },
  )

  /* До фичи 006 маршрут можно было только завести и удалить: опечатка во
   * времени сбора стоила записей гостей — они уходили вместе с маршрутом. */
  app.patch(
    '/weddings/:weddingId/logistics/buses/:busId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            // Точку сбора и время можно снять (`null`) — «ещё не назначено», как у нового маршрута.
            from: { type: 'string', maxLength: 300, nullable: true },
            time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', nullable: true },
            seats: { type: 'integer', minimum: 1, maximum: 500 },
            // `null` снимает перевозчика (R-17): пропуск и очистка — разные намерения.
            dealId: { ...UUID_ID, nullable: true },
          },
        },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      const { busId } = request.params as { busId: string }
      if (!isUuid(busId)) throw notFound('Маршрут не найден')
      const body = request.body as { name?: string; from?: string; time?: string; seats?: number; dealId?: string | null }
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)

      return db().tx(async (client) => {
        /* Строка маршрута под замком: гость садится в ту же секунду через
         * `POST /join/{t}/shuttle`, и без блокировки «мест меньше занятых»
         * иначе проверялось бы по устаревшему `taken` (R-49). Заодно 404 —
         * чужой маршрут дальше не пускаем. */
        const { rows: locked } = await client.query<{ taken: number }>(
          'select taken from bus_routes where id = $1 and wedding_id = $2 for update',
          [busId, weddingId],
        )
        if (locked.length === 0) throw notFound('Маршрут не найден')
        const taken = locked[0]!.taken
        /* Места считаются в персонах (гость «с +1» — двое). Правило держит
         * CHECK `bus_taken_bounded`; ранний отказ здесь — ради текста с числом. */
        const busFull = () =>
          conflict('bus_full', `Занято ${taken} ${plural(taken, 'персона', 'персоны', 'персон')} — меньше мест не поставить`)
        if (body.seats !== undefined && body.seats < taken) throw busFull()
        if (body.dealId) await carrierDeal(client, weddingId, body.dealId)

        try {
          await client.query(
            `update bus_routes set
               name = coalesce($3, name),
               pickup = case when $4 then $5 else pickup end,
               departs = case when $6 then $7::time else departs end,
               seats = coalesce($8, seats),
               deal_id = case when $9 then $10::uuid else deal_id end
             where id = $1 and wedding_id = $2`,
            [
              busId,
              weddingId,
              body.name ?? null,
              has('from'),
              body.from ?? null,
              has('time'),
              body.time ?? null,
              body.seats ?? null,
              has('dealId'),
              body.dealId ?? null,
            ],
          )
        } catch (error) {
          // Страховка: правило держит база, и её отказ — тот же 409, а не 500.
          if (isCheckViolation(error, 'bus_taken_bounded')) throw busFull()
          throw error
        }
        const { rows } = await client.query<BusRow>(`${BUS_SELECT} where r.id = $1`, [busId])
        await noteCarrier(client, weddingId, rows[0]!, 'изменила')
        return toBus(rows[0]!)
      })
    },
  )

  app.delete('/weddings/:weddingId/logistics/buses/:busId', async (request, reply) => {
    const { busId } = request.params as { busId: string }
    if (!isUuid(busId)) throw notFound('Маршрут не найден')
    const res = await db().query('delete from bus_routes where id = $1 and wedding_id = $2', [
      busId,
      request.member!.weddingId,
    ])
    if (res.rowCount === 0) throw notFound('Маршрут не найден')
    return reply.code(204).send()
  })

  /* ── логистика: отели ─────────────────────────────────────────────── */
  const toHotel = (r: {
    id: string
    name: string
    rooms: number
    booked: number
    price: string | null
    currency: string
    deadline: string | null
    promo: string | null
  }) => ({
    id: r.id,
    name: r.name,
    rooms: r.rooms,
    booked: r.booked,
    price: r.price === null ? null : { amount: Number(r.price), currency: r.currency },
    deadline: r.deadline,
    promo: r.promo,
  })

  /* Симметрично автобусам. Гость видит те же блоки по своему токену
     (`/join/:guestToken/hotels`), пара — здесь. */
  app.get('/weddings/:weddingId/logistics/hotels', async (request) => {
    const { rows } = await db().query(
      `select id, name, rooms, booked, price::text as price, currency, deadline::text as deadline, promo
         from hotel_blocks where wedding_id = $1 order by deadline nulls last, name`,
      [request.member!.weddingId],
    )
    return rows.map((r) => toHotel(r as never))
  })

  app.post(
    '/weddings/:weddingId/logistics/hotels',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'rooms'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            rooms: { type: 'integer', minimum: 1, maximum: 500 },
            booked: { type: 'integer' },
            price: {
              type: 'object',
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
                currency: { type: 'string', enum: ['RUB'] },
              },
            },
            deadline: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            promo: { type: 'string', maxLength: 60 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string
        rooms: number
        price?: { amount: number }
        deadline?: string
        promo?: string
      }
      // Бронь до 30 февраля не наступает никогда — а PostgreSQL на такой
      // дате роняет запрос, и человек видит 500 вместо отказа.
      if (body.deadline) assertRealDate(body.deadline, 'deadline')
      const id = uuidv7()
      await db().query(
        `insert into hotel_blocks (id, wedding_id, name, rooms, price, currency, deadline, promo)
         values ($1,$2,$3,$4,$5,'RUB',$6::date,$7)`,
        [
          id,
          request.member!.weddingId,
          body.name,
          body.rooms,
          body.price?.amount ?? null,
          body.deadline ?? null,
          body.promo ?? null,
        ],
      )
      const { rows } = await db().query(
        'select id, name, rooms, booked, price::text as price, currency, deadline::text as deadline, promo from hotel_blocks where id = $1',
        [id],
      )
      return reply.code(201).send(toHotel(rows[0] as never))
    },
  )

  app.delete('/weddings/:weddingId/logistics/hotels/:hotelId', async (request, reply) => {
    const { hotelId } = request.params as { hotelId: string }
    if (!isUuid(hotelId)) throw notFound('Блок не найден')
    const res = await db().query('delete from hotel_blocks where id = $1 and wedding_id = $2', [
      hotelId,
      request.member!.weddingId,
    ])
    if (res.rowCount === 0) throw notFound('Блок не найден')
    return reply.code(204).send()
  })

  /**
   * Массовая рассылка: факт, дебаунс и собственно оповещение.
   *
   * Идемпотентности мало: второе нажатие приходит со СВОИМ ключом, и по ключу
   * оно новое. Защищает окно в 30 секунд.
   *
   * Кому доходит на самом деле. Команде свадьбы — уведомлением в приложении,
   * прямо сейчас. Гостям — нечем: аккаунта у них нет, нужны SMS или почта,
   * и это записано в «Хвостах». Поэтому в ответе два числа, а не одно:
   * `recipients` — сколько человек касается рассылка, `notified` — скольким
   * она ушла. Одно число здесь было бы обещанием, которого сервер не держит.
   */
  async function broadcast(
    weddingId: string,
    action: string,
    recipients: number,
    message: string,
    actorId: string | null = null,
  ) {
    // Журнал рассылок нужен для дебаунса и разбора жалоб, а не навсегда:
    // таблица растёт от каждого нажатия и сама себя не чистит.
    await db().query("delete from broadcasts where created_at < now() - interval '90 days'")

    /* Счёт предыдущей рассылки и вставка новой — в одной транзакции за замком
     * пары «свадьба + действие» (F-RL3-06, класс ERR-0271 / R-271). Два нажатия
     * «Разослать» подряд — обычное дело в день X, и оба видели пустой журнал:
     * гости получали две одинаковые рассылки, а дебаунс в 30 секунд был бумажным.
     * Уведомление команды — после фиксации, чтобы не держать замок на время разбора
     * получателей и не обещать строку, которой может не быть. */
    const claimed = await db().tx(async (client) => {
      await client.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [
        BROADCAST_LOCK,
        `${weddingId}:${action}`,
      ])
      const { rows } = await client.query<{ id: string }>(
        `select id from broadcasts
          where wedding_id = $1 and action = $2 and created_at > now() - ($3 || ' seconds')::interval
          order by created_at desc limit 1`,
        [weddingId, action, String(DEBOUNCE_SECONDS)],
      )
      if (rows[0]) return { id: rows[0].id, fresh: false }
      const fresh = uuidv7()
      await client.query('insert into broadcasts (id, wedding_id, action, recipients) values ($1,$2,$3,$4)', [
        fresh,
        weddingId,
        action,
        recipients,
      ])
      return { id: fresh, fresh: true }
    })
    if (!claimed.fresh) return { broadcastId: claimed.id, recipients, notified: 0, debounced: true }
    const id = claimed.id
    /* Команда узнаёт сразу: это её работа — встретить гостей на точке
     * сбора и добрать голоса за меню. Автор нажатия себе не пишет. */
    const notified = await notifyWedding(db(), weddingId, actorId, {
      kind: 'guest',
      title: 'Рассылка гостям',
      body: message,
      link: '/guests',
    })
    return { broadcastId: id, recipients, notified, debounced: false }
  }

  app.post('/weddings/:weddingId/logistics/notify-pickup', async (request, reply) => {
    const weddingId = request.member!.weddingId
    return withIdempotency(db(), request, reply, 'logistics.notify', async () => {
      const { rows } = await db().query<{ n: string }>(
        `select count(*)::text as n from bus_bookings b
           join guests g on g.id = b.guest_id
          where g.wedding_id = $1`,
        [weddingId],
      )
      const n = Number(rows[0]!.n)
      /* Текст — правда (R-172/R-174): канала до гостей нет, «разосланы»
       * было обещанием, которого сервер не держит. Число — со склонением,
       * «1 гостей» читалось как поломка данных (ERR-0145). */
      return {
        status: 202,
        body: await broadcast(
          weddingId,
          'notify-pickup',
          n,
          `Команда уведомлена о точках сбора: в автобусах ${n} ${plural(n, 'гость', 'гостя', 'гостей')}; ` +
            'гостям доставки пока нет — передайте точки сбора сами',
          request.caller!.userId,
        ),
      }
    })
  })

  /* ── меню ─────────────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/menu-poll', async (request) => {
    const weddingId = request.member!.weddingId
    const { rows: poll } = await db().query<{ question: string; sent_at: Date | null }>(
      'select question, sent_at from menu_polls where wedding_id = $1',
      [weddingId],
    )
    const { rows: options } = await db().query<{ id: string; name: string; icon: string | null; votes: string }>(
      `select o.id, o.name, o.icon,
              (select count(*)::text from menu_votes v where v.option_id = o.id) as votes
         from menu_options o where o.wedding_id = $1 order by o.sort, o.name`,
      [weddingId],
    )
    // Кейтерингу нужны ПОРЦИИ, а не строки списка: «Ольга +1» — два
    // человека за столом и две порции. Считаем на сервере, чтобы разные
    // экраны не получили разных ответов (ERR-0012 ровно про это).
    const { rows: guests } = await db().query<{ status: string }>(
      'select rsvp as status from guests where wedding_id = $1',
      [weddingId],
    )
    return {
      question: poll[0]?.question ?? 'Что будете на горячее?',
      sentAt: poll[0]?.sent_at?.toISOString() ?? null,
      expectedPortions: personCount(guests),
      options: options.map((o) => ({ id: o.id, name: o.name, icon: o.icon, votes: Number(o.votes) })),
    }
  })

  app.put(
    '/weddings/:weddingId/menu-poll',
    {
      schema: {
        body: {
          type: 'object',
          required: ['options'],
          additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 200 },
            sentAt: { type: 'string', nullable: true },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: {
                  // Пустой `id` — новое блюдо; заполненный уходит в запрос
                  // по колонке uuid, поэтому формат проверяется схемой.
                  id: UUID_ID,
                  name: { type: 'string', minLength: 1, maxLength: 120 },
                  icon: { type: 'string', maxLength: 16 },
                  votes: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      const body = request.body as { question?: string; options: { id?: string; name: string; icon?: string }[] }

      return db().tx(async (client) => {
        await client.query(
          `insert into menu_polls (wedding_id, question) values ($1, coalesce($2, 'Что будете на горячее?'))
           on conflict (wedding_id) do update set question = coalesce($2, menu_polls.question)`,
          [weddingId, body.question ?? null],
        )
        // Блюда, которых больше нет в опросе, удаляются вместе с голосами
        // за них: голос за исчезнувшее блюдо считать некуда.
        const keep = body.options.map((o) => o.id).filter((id): id is string => Boolean(id))
        await client.query(
          `delete from menu_options where wedding_id = $1 and (cardinality($2::uuid[]) = 0 or not (id = any($2::uuid[])))`,
          [weddingId, keep],
        )
        let sort = 0
        for (const o of body.options) {
          if (o.id) {
            /* Условие по свадьбе обязательно. Без него пара, приславшая
             * идентификатор чужого блюда, переписывает меню в ЧУЖОЙ свадьбе:
             * запрос шёл только по `id`. Соседние маршруты этого файла
             * ограничены свадьбой все до одного — здесь строка выпала
             * (ERR-0105). Ноль строк — блюдо не наше, и это не ошибка
             * клиента, а попытка выйти за свою свадьбу. */
            const touched = await client.query(
              'update menu_options set name = $3, icon = $4, sort = $5 where id = $1 and wedding_id = $2',
              [o.id, weddingId, o.name, o.icon ?? null, sort++],
            )
            if (touched.rowCount === 0) throw notFound('Блюдо не найдено')
          } else {
            await client.query('insert into menu_options (id, wedding_id, name, icon, sort) values ($1,$2,$3,$4,$5)', [
              uuidv7(),
              weddingId,
              o.name,
              o.icon ?? null,
              sort++,
            ])
          }
        }
        const { rows } = await client.query<{ id: string; name: string; icon: string | null }>(
          'select id, name, icon from menu_options where wedding_id = $1 order by sort',
          [weddingId],
        )
        const { rows: q } = await client.query<{ question: string; sent_at: Date | null }>(
          'select question, sent_at from menu_polls where wedding_id = $1',
          [weddingId],
        )
        /* §13.2: кейтеринг закупает по итогам опроса. Список блюд
         * поменялся — это его работа, а не внутреннее дело пары. */
        await noteVendorUpdate(
          client,
          weddingId,
          'menu',
          `Опрос меню изменён: ${rows.map((o) => o.name).join(' · ')}`,
        )
        return {
          question: q[0]!.question,
          /* Правка блюд не отменяет того, что опрос уже рассылали:
           * пустое поле здесь означало бы «ещё не отправляли», и пара
           * послала бы напоминание второй раз. */
          sentAt: q[0]!.sent_at?.toISOString() ?? null,
          options: rows.map((o) => ({ id: o.id, name: o.name, icon: o.icon, votes: 0 })),
        }
      })
    },
  )

  app.post('/weddings/:weddingId/menu-poll/remind', async (request, reply) => {
    const weddingId = request.member!.weddingId
    return withIdempotency(db(), request, reply, 'menu.remind', async () => {
      const { rows } = await db().query<{ n: string }>(
        `select count(*)::text as n from guests g
          where g.wedding_id = $1 and g.rsvp = 'yes'
            and not exists (select 1 from menu_votes v where v.guest_id = g.id)`,
        [weddingId],
      )
      await db().query(
        `insert into menu_polls (wedding_id, sent_at) values ($1, now())
         on conflict (wedding_id) do update set sent_at = now()`,
        [weddingId],
      )
      const n = Number(rows[0]!.n)
      return {
        status: 202,
        body: await broadcast(
          weddingId,
          'menu-remind',
          n,
          `Напоминание о меню: ${n} ${plural(n, 'гость', 'гостя', 'гостей')} ещё не ${plural(n, 'выбрал', 'выбрали', 'выбрали')} блюдо; ` +
            'гостям доставки пока нет — напомните им сами',
          request.caller!.userId,
        ),
      }
    })
  })

  /* ── гостевые пути ────────────────────────────────────────────────── */
  app.post(
    '/join/:guestToken/shuttle',
    {
      schema: {
        body: {
          type: 'object',
          required: ['busId'],
          additionalProperties: false,
          properties: { busId: UUID_ID, guestId: UUID_ID },
        },
      },
    },
    async (request) => {
      const { guestToken } = request.params as { guestToken: string }
      const { busId, guestId } = request.body as { busId: string; guestId?: string }
      const guest = await guestByToken(db(), guestToken)

      return db().tx(async (client) => {
        /* New 020 clients pass guestId and book exactly one person. A legacy
         * client has no guestId; for compatibility its old single action
         * applies to the whole invitation (the former +1 semantics), but the
         * database still stores one row/seat per real person. */
        const { rows: selected } = await client.query<{ id: string }>(
          guestId
            ? `select id from guests where id = $1 and party_id = $2 order by id for update`
            : `select id from guests where party_id = $1 order by id for update`,
          guestId ? [guestId, guest.partyId] : [guest.partyId],
        )
        if (selected.length === 0) throw notFound('Человек не входит в это приглашение')
        const memberIds = selected.map((row) => row.id)

        /* Lock every involved route in stable id order before moving seats.
         * This is the same parent order for one person and a whole family. */
        await client.query(
          `select r.id from bus_routes r
            where r.wedding_id = $2
              and (
                r.id = $1
                or r.id in (
                  select b.bus_id from bus_bookings b
                   where b.guest_id = any($3::uuid[])
                )
              )
            order by r.id for update`,
          [busId, guest.weddingId, memberIds],
        )
        const { rows: exists } = await client.query<{ seats: number; taken: number }>(
          'select seats, taken from bus_routes where id = $1 and wedding_id = $2',
          [busId, guest.weddingId],
        )
        if (!exists[0]) throw notFound('Маршрут не найден')

        /* Each selected person rides one bus. Moving the family frees all old
         * routes first; their counters are maintained by the trigger. */
        await client.query(
          `delete from bus_bookings b using bus_routes r
            where b.bus_id = r.id
              and b.guest_id = any($1::uuid[])
              and r.wedding_id = $2
              and b.bus_id <> $3`,
          [memberIds, guest.weddingId, busId],
        )

        const { rows: current } = await client.query<{ seats: number; taken: number }>(
          'select seats, taken from bus_routes where id = $1',
          [busId],
        )
        const { rows: alreadyRows } = await client.query<{ n: string }>(
          'select count(*)::text as n from bus_bookings where bus_id = $1 and guest_id = any($2::uuid[])',
          [busId, memberIds],
        )
        const missing = memberIds.length - Number(alreadyRows[0]!.n)
        if (current[0]!.taken + missing > current[0]!.seats) {
          throw conflict('bus_full', 'Мест в этом автобусе не осталось')
        }

        let booked
        try {
          booked = await client.query(
            `insert into bus_bookings (bus_id, guest_id)
             select $1, x.id from unnest($2::uuid[]) as x(id)
             on conflict do nothing`,
            [busId, memberIds],
          )
        } catch (error) {
          if (isCheckViolation(error, 'bus_taken_bounded')) {
            throw conflict('bus_full', 'Мест в этом автобусе не осталось')
          }
          throw error
        }

        await client.query(
          `update guests set transfer = 'need' where id = any($1::uuid[])`,
          [memberIds],
        )
        const { rows } = await client.query<{ taken: number; seats: number }>(
          'select taken, seats from bus_routes where id = $1',
          [busId],
        )
        return {
          guestId: guestId ?? guest.guestId,
          guestIds: memberIds,
          busId,
          alreadyBooked: booked.rowCount === 0,
          ...rows[0]!,
        }
      })
    },
  )

  app.post(
    '/join/:guestToken/hotels',
    {
      schema: {
        body: {
          type: 'object',
          required: ['hotelId'],
          additionalProperties: false,
          properties: { hotelId: UUID_ID },
        },
      },
    },
    async (request) => {
      const { guestToken } = request.params as { guestToken: string }
      const { hotelId } = request.body as { hotelId: string }
      const guest = await guestByToken(db(), guestToken)

      return db().tx(async (client) => {
        /* Тот же порядок замков, что у автобуса: строка гостя, затем оба
         * блока — целевой и прежний — в порядке `id` (ревью 015: у отелей
         * замков не было вовсе, взаимный переезд двух гостей давал deadlock). */
        await client.query('select 1 from guest_parties where id = $1 for update', [guest.partyId])
        await client.query(
          `select h.id from hotel_blocks h
            where h.wedding_id = $2
              and (h.id = $1 or h.id in (select b.hotel_id from hotel_bookings b where b.party_id = $3))
            order by h.id for update`,
          [hotelId, guest.weddingId, guest.partyId],
        )
        /* Дедлайн блока — до какого дня отель держит номера по брони пары
         * (Бизнес-логика §12.1). День дедлайна ещё открыт, следующий — нет;
         * «сегодня» считается по поясу свадьбы, как дата свадьбы у отзывов
         * (`reviews.ts`), а не по часам сервера (D3-15). */
        const { rows: block } = await client.query<{ deadline: string | null; closed: boolean }>(
          `select h.deadline::text as deadline,
                  (h.deadline is not null
                   and h.deadline < (now() at time zone coalesce(w.tz, 'Europe/Moscow'))::date) as closed
             from hotel_blocks h join weddings w on w.id = h.wedding_id
            where h.id = $1 and h.wedding_id = $2`,
          [hotelId, guest.weddingId],
        )
        if (block.length === 0) throw notFound('Блок не найден')
        if (block[0]!.closed) {
          throw conflict('deadline_passed', `Бронь в этом блоке закрылась ${block[0]!.deadline} — спросите у пары, как быть`)
        }

        // Гость живёт в ОДНОМ отеле: смена блока освобождает прежний номер.
        await client.query(
          `delete from hotel_bookings b using hotel_blocks h
            where b.hotel_id = h.id and b.party_id = $1 and h.wedding_id = $2 and b.hotel_id <> $3`,
          [guest.partyId, guest.weddingId, hotelId],
        )

        let booked
        try {
          booked = await client.query(
            'insert into hotel_bookings (hotel_id, guest_id, party_id) values ($1,$2,$3) on conflict do nothing',
            [hotelId, guest.guestId, guest.partyId],
          )
        } catch (error) {
          if (isCheckViolation(error, 'hotel_booked_bounded')) {
            throw conflict('hotel_full', 'Свободных номеров в этом блоке не осталось')
          }
          throw error
        }
        const { rows } = await client.query<{ booked: number; rooms: number }>(
          'select booked, rooms from hotel_blocks where id = $1',
          [hotelId],
        )
        return { partyId: guest.partyId, hotelId, alreadyBooked: booked.rowCount === 0, ...rows[0]! }
      })
    },
  )

  /* Гость видит маршруты и то, куда он уже записан. Раньше путь был только на
     запись, и `busId` гостю брать было неоткуда. */
  app.get('/join/:guestToken/shuttle', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestByToken(db(), guestToken)
    // Те же маршруты, что у пары, с именем перевозчика: гость ищет автобус
    // на точке сбора по нему (фича 006, В4). Телефона и цены в `BusRoute` нет.
    const routes = await busesOf(db(), guest.weddingId)
    const { rows: members } = await db().query<{ guest_id: string; name: string; bus_id: string | null }>(
      `select g.id as guest_id, g.name,
              (select b.bus_id from bus_bookings b where b.guest_id = g.id limit 1) as bus_id
         from guests g where g.party_id = $1 order by g.party_position, g.created_at, g.id`,
      [guest.partyId],
    )
    return {
      myBusId: members.find((m) => m.guest_id === guest.guestId)?.bus_id ?? null,
      members: members.map((m) => ({ guestId: m.guest_id, name: m.name, myBusId: m.bus_id })),
      routes,
    }
  })

  /* Варианты блюд задаёт пара — гостю их надо показать, иначе он голосует
     вслепую. `chosenOptionId` возвращает его собственный выбор. */
  app.get('/join/:guestToken/menu-vote', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestByToken(db(), guestToken)
    const { rows: poll } = await db().query<{ question: string }>(
      'select question from menu_polls where wedding_id = $1',
      [guest.weddingId],
    )
    /* Варианты привязаны к свадьбе, а не к опросу: отдельной таблицы опросов
       с идентификатором нет — `menu_polls` хранит один вопрос на свадьбу. */
    const { rows: options } = await db().query<{ id: string; name: string }>(
      'select id, name from menu_options where wedding_id = $1 order by sort, name',
      [guest.weddingId],
    )
    const { rows: members } = await db().query<{ guest_id: string; name: string; option_id: string | null }>(
      `select g.id as guest_id, g.name,
              (select v.option_id from menu_votes v where v.guest_id = g.id limit 1) as option_id
         from guests g where g.party_id = $1 order by g.party_position, g.created_at, g.id`,
      [guest.partyId],
    )
    return {
      question: poll[0]?.question ?? '',
      options,
      chosenOptionId: members.find((m) => m.guest_id === guest.guestId)?.option_id ?? null,
      members: members.map((m) => ({ guestId: m.guest_id, name: m.name, chosenOptionId: m.option_id })),
    }
  })

  /* Команда свадьбы глазами гостя: только имя и категория тех, кто
     забронирован. Нужна для отзыва — `vendorId` гостю взять больше неоткуда.
     Денег и телефонов здесь нет: гость их не видел и видеть не должен. */
  app.get('/join/:guestToken/team', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestByToken(db(), guestToken)
    const { rows } = await db().query<{ vendor_id: string; name: string; category_id: string }>(
      `select v.id as vendor_id, v.name, v.category_id
         from deals d
         join slots s on s.id = d.slot_id
         join vendors v on v.id = d.vendor_id
        where s.wedding_id = $1 and d.state = any($2::text[])
        order by v.name`,
      [guest.weddingId, COMMITTED],
    )
    /* Дата нужна форме отзыва: до свадьбы отзыв не принимается, и сказать об
       этом надо до заполнения, а не отказом после отправки. Пояс — тот же,
       по которому `reviews.ts` считает «день прошёл» (фича 005): без него
       гость во Владивостоке видел «ещё не прошла» по своим часам и получал
       отказ, или наоборот — форму до срока. Пустой пояс свадьбы там значит
       Europe/Moscow, поэтому и здесь он же, а не `null`. */
    const { rows: wedding } = await db().query<{ date: string | null; tz: string }>(
      `select to_char(date, 'YYYY-MM-DD') as date, coalesce(tz, 'Europe/Moscow') as tz
         from weddings where id = $1`,
      [guest.weddingId],
    )
    return {
      weddingId: guest.weddingId,
      weddingDate: wedding[0]?.date ?? null,
      tz: wedding[0]?.tz ?? 'Europe/Moscow',
      vendors: rows.map((r) => ({ vendorId: r.vendor_id, name: r.name, categoryId: r.category_id })),
    }
  })

  /* `mine` — где у гостя номер (фича 005): без признака он не видел своей
     брони, и тап по другому блоку переносил её молча (D3-15). Считается по
     `hotel_bookings` — той же таблице, из которой список пары берёт `hotelId`
     гостя, расходиться нечему. Только здесь: паре в её списке этого поля
     нет, оно про гостя, а не про блок. */
  app.get('/join/:guestToken/hotels', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestByToken(db(), guestToken)
    const { rows } = await db().query<{ mine: boolean }>(
      `select h.id, h.name, h.rooms, h.booked, h.price::text as price, h.currency,
              h.deadline::text as deadline, h.promo,
              exists(select 1 from hotel_bookings b where b.hotel_id = h.id and b.party_id = $2) as mine
         from hotel_blocks h where h.wedding_id = $1 order by h.name`,
      [guest.weddingId, guest.partyId],
    )
    return rows.map((r) => ({ ...toHotel(r as never), mine: r.mine }))
  })

  app.post(
    '/join/:guestToken/menu-vote',
    {
      schema: {
        body: {
          type: 'object',
          required: ['optionId'],
          additionalProperties: false,
          properties: { optionId: UUID_ID, guestId: UUID_ID },
        },
      },
    },
    async (request) => {
      const { guestToken } = request.params as { guestToken: string }
      const { optionId, guestId } = request.body as { optionId: string; guestId?: string }
      const guest = await guestByToken(db(), guestToken)

      const memberIds = await db().tx(async (client) => {
        const { rows: option } = await client.query(
          'select 1 from menu_options where id = $1 and wedding_id = $2',
          [optionId, guest.weddingId],
        )
        if (option.length === 0) throw notFound('Такого блюда нет в опросе')

        /* New client: one named person. Legacy client: apply the old single
         * household choice to every person materialized from the invitation.
         * This keeps pre-020 UI behaviour while storing one vote per person. */
        const { rows: selected } = await client.query<{ id: string }>(
          guestId
            ? 'select id from guests where id = $1 and party_id = $2 order by id for update'
            : 'select id from guests where party_id = $1 order by id for update',
          guestId ? [guestId, guest.partyId] : [guest.partyId],
        )
        if (selected.length === 0) throw notFound('Человек не входит в это приглашение')
        const ids = selected.map((row) => row.id)
        await client.query(
          `insert into menu_votes (guest_id, option_id)
           select x.id, $2 from unnest($1::uuid[]) as x(id)
           on conflict (guest_id) do update set option_id = excluded.option_id, at = now()`,
          [ids, optionId],
        )
        await client.query(
          'update guests set menu_option_id = $2 where id = any($1::uuid[])',
          [ids, optionId],
        )
        return ids
      })
      return { guestId: guestId ?? guest.guestId, guestIds: memberIds, optionId }
    },
  )

  /* ── день X глазами гостя (фича 009) ──────────────────────────────── */
  interface GuestDayRow {
    date: string | null
    tz: string
    venue: string | null
    dress_code: string | null
    dress_note: string | null
    /** Чат дня X свадьбы: заводит база при создании свадьбы. */
    chat_id: string | null
    opens_at: Date | null
    closes_at: Date | null
    /** Канун наступил по поясу места: с этого дня гостю уходит телефон координатора. */
    eve_reached: boolean
  }

  /**
   * Свадьба и окно её чата дня для гостя.
   *
   * Начало окна — `chats.opens_at`, 09:00 кануна по поясу места: его считает
   * база (`day_chat_opens_at`) и пересчитывает при переносе даты — второй
   * формулы здесь нет. Конец — 23:59:59 дня ПОСЛЕ свадьбы по тому же поясу
   * (спека, FR-004): назавтра гости ещё пишут «спасибо» и ищут забытое.
   * Пояс — как у остальных гостевых путей: пустой значит Москву.
   */
  const guestDayOf = async (weddingId: string): Promise<GuestDayRow> => {
    const { rows } = await db().query<GuestDayRow>(
      `select to_char(w.date, 'YYYY-MM-DD') as date, coalesce(w.tz, 'Europe/Moscow') as tz,
              w.venue, w.dress_code, w.dress_note, c.id as chat_id, c.opens_at,
              case when w.date is null then null
                   else ((w.date + 1) + time '23:59:59') at time zone coalesce(w.tz, 'Europe/Moscow') end as closes_at,
              coalesce((now() at time zone coalesce(w.tz, 'Europe/Moscow'))::date >= w.date - 1, false) as eve_reached
         from weddings w
         left join chats c on c.wedding_id = w.id and c.kind = 'day'
        where w.id = $1`,
      [weddingId],
    )
    return rows[0]!
  }

  /* Открыт ли чат гостям сейчас. Даты нет — окна нет: «накануне свадьбы»
   * без свадьбы не наступает (как в `assertOpen`). */
  const guestChatWindow = (day: GuestDayRow, now = Date.now()) => ({
    open:
      day.opens_at !== null && day.closes_at !== null &&
      day.opens_at.getTime() <= now && now <= day.closes_at.getTime(),
    opensAt: day.opens_at?.toISOString() ?? null,
    closesAt: day.closes_at?.toISOString() ?? null,
  })

  /**
   * Вне окна — 423 `chat_closed_for_guests` с `details.opensAt`: доступ не
   * запрещён, он ещё не наступил (или уже прошёл), и экрану гостя нужна
   * дата — «откроется 13 июня», а не «нет доступа». Тело — руками, как 409
   * `wedding_exists` в `weddings.ts`: единый формат ошибки (`errors.ts`)
   * поля `details` не знает.
   */
  const chatClosedForGuests = (reply: FastifyReply, window: ReturnType<typeof guestChatWindow>, tz: string) => {
    /* Срок — словами в поясе места («13 июня в 09:00»): текст уходит гостю на
     * экран как есть, а сырой ISO там читать некому. Неизвестный пояс не
     * роняет ответ — тогда без пояса. */
    const when = (iso: string) => {
      const opts = { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' } as const
      try {
        return new Intl.DateTimeFormat('ru-RU', { ...opts, timeZone: tz }).format(new Date(iso))
      } catch {
        return new Intl.DateTimeFormat('ru-RU', opts).format(new Date(iso))
      }
    }
    const message = !window.opensAt
      ? 'Чат дня откроется накануне свадьбы — пара ещё не назначила дату'
      : Date.now() < Date.parse(window.opensAt)
        ? `Чат дня откроется ${when(window.opensAt)} — накануне свадьбы`
        : 'Чат дня закрыт — свадьба прошла'
    return reply.code(423).send({
      error: {
        code: 'chat_closed_for_guests',
        message,
        details: { opensAt: window.opensAt, closesAt: window.closesAt },
      },
    })
  }

  /* Всё, что нужно гостю в день X, одним запросом (План §8.8): программа —
   * только блоки «для гостей»; свой стол; свой автобус с перевозчиком;
   * координатор с телефоном — он для того и назначен, «не жениха» (решение
   * владельца В2: всегда, но с кануна — до него телефон участника команды
   * гостю не уходит, и ворота эти держит сервер, а не только экран, который
   * до кануна раздела не показывает); окно чата. Телефона пары здесь нет. */
  app.get('/join/:guestToken/day', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestOfDay(db(), guestToken)
    const day = await guestDayOf(guest.weddingId)
    const { rows: timeline } = await db().query<EventRow>(
      `select ${EVENT_COLUMNS} from timeline_events where wedding_id = $1 and for_guests order by sort, starts_at`,
      [guest.weddingId],
    )
    const { rows: table } = await db().query<{ name: string }>(
      'select t.name from guests g join tables t on t.id = g.table_id where g.id = $1',
      [guest.guestId],
    )
    // Тот же маршрут, что видит пара, — с перевозчиком, без телефона и цены.
    const { rows: bus } = await db().query<BusRow>(
      `${BUS_SELECT} join bus_bookings b on b.bus_id = r.id where b.guest_id = $1 and r.wedding_id = $2 limit 1`,
      [guest.guestId, guest.weddingId],
    )
    // Мягко удалённый аккаунт в команде не считается (R-224).
    const { rows: coordinator } = await db().query<{ name: string | null; phone: string }>(
      `select u.name, u.phone from wedding_members m join users u on u.id = m.user_id
        where m.wedding_id = $1 and m.role = 'coordinator' and u.deleted_at is null
        order by m.joined_at limit 1`,
      [guest.weddingId],
    )
    return {
      date: day.date,
      tz: day.tz,
      venue: day.venue,
      dressCode: day.dress_code,
      dressNote: day.dress_note,
      timeline: timeline.map(toEvent),
      table: table[0] ? { name: table[0].name } : null,
      bus: bus[0] ? toBus(bus[0]) : null,
      coordinator: day.eve_reached && coordinator[0] ? { name: coordinator[0].name, phone: coordinator[0].phone } : null,
      chat: guestChatWindow(day),
    }
  })

  /* Та же лента, что у пары и команды (`GET /chats/{id}/messages`), только по
   * токену гостя и в окне дня. Отметки «прочитано» нет — она на пользователя,
   * а у гостя его нет. */
  app.get('/join/:guestToken/day-chat/messages', async (request, reply) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestOfDay(db(), guestToken)
    const day = await guestDayOf(guest.weddingId)
    const window = guestChatWindow(day)
    if (!window.open || !day.chat_id) return chatClosedForGuests(reply, window, day.tz)

    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    const rows = await messagePage(db(), day.chat_id, page)
    // Курсор — по микросекундам строки, как в `GET /chats/{id}/messages` (D4-23).
    const paged = buildPage(rows, page.limit, (r) => encodeCursor(r.created_at_us, r.id))
    return { items: paged.items.map((r) => toMessage(r, 'day', { guestId: guest.guestId })), nextCursor: paged.nextCursor }
  })

  app.post(
    '/join/:guestToken/day-chat/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      const { guestToken } = request.params as { guestToken: string }
      const { text } = request.body as { text: string }
      const guest = await guestOfDay(db(), guestToken)
      const day = await guestDayOf(guest.weddingId)
      const window = guestChatWindow(day)
      if (!window.open || !day.chat_id) return chatClosedForGuests(reply, window, day.tz)
      const chatId = day.chat_id

      /* Автор — гость из списка: `sender_id` пуст, `guest_id` — его строка.
       * Что у реплики не бывает двух авторов, держит CHECK `messages_one_author`
       * (§5 п. 11), а не обработчик. Реплика идёт в ОБЩИЙ чат дня (решение
       * владельца В3): пара, команда и подрядчики видят её с именем гостя. */
      const id = uuidv7()
      const { rows } = await db().query<{ created_at: Date }>(
        'insert into messages (id, chat_id, sender_id, guest_id, text) values ($1,$2,null,$3,$4) returning created_at',
        [id, chatId, guest.guestId, text],
      )
      const message = {
        id,
        chatId,
        senderId: null,
        text,
        attachmentUrl: null,
        sentAt: rows[0]!.created_at.toISOString(),
        system: false,
        guestName: guest.name,
        // Всем по живому каналу — без признака; автору в ответе — своя (фича 014).
        mine: null as boolean | null,
      }
      // Сначала живому каналу, потом уведомление — как у реплики участника.
      await app.realtime.publish({ chatId, type: 'message', actorId: `guest:${guest.guestId}`, payload: { message } })
      // Команде — тем же путём и тем же получателям, что от участника; автора-пользователя нет.
      await notifyOthers(db(), chatId, guest.weddingId, 'day', null, text)
      return reply.code(201).send({ ...message, mine: true })
    },
  )

  /* ── альбом ───────────────────────────────────────────────────────── */
  const toPhoto = (r: { id: string; url: string; approved: boolean; created_at: Date }) => ({
    id: r.id,
    url: r.url,
    approved: r.approved,
    createdAt: r.created_at.toISOString(),
  })

  app.get('/weddings/:weddingId/album', async (request) => {
    const weddingId = request.member?.weddingId ?? request.guest!.weddingId
    // Паре видны все кадры, гостю — только одобренные: до модерации
    // в альбоме может оказаться что угодно.
    const onlyApproved = !request.member
    const { rows } = await db().query(
      `select id, url, approved, created_at from album_photos
        where wedding_id = $1 ${onlyApproved ? 'and approved' : ''} order by created_at desc`,
      [weddingId],
    )
    return rows.map((r) => toPhoto(r as never))
  })

  app.post(
    '/weddings/:weddingId/album',
    {
      schema: {
        body: {
          type: 'object',
          required: ['fileUrl', 'consent'],
          additionalProperties: false,
          properties: {
            fileUrl: { type: 'string', maxLength: 500, pattern: '^https?://[^ ]+$' },
            consent: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { fileUrl: string; consent: boolean }
      const guest = request.guest
      if (!guest) throw new AppError(401, 'unauthorized', 'Нужна ссылка-приглашение')

      // Согласие на публикацию — явное действие, а не предустановленная
      // галочка: кадр попадёт в чужой альбом.
      if (!body.consent) throw new AppError(422, 'consent_required', 'Нужно согласие на публикацию кадра в альбоме')

      /* Строка гостя под замком — ПЕРВОЙ, как у резерва подарка (`gifts.ts`,
       * R-49/R-271): предел кадров на гостя иначе «читаем — сравниваем —
       * пишем», и параллельный залп вставок одного гостя каждая видит
       * «меньше предела» и проходит вся разом (класс ERR-0271/R-271,
       * сиблинг SA-02). */
      const id = uuidv7()
      const { rows } = await db().tx(async (client) => {
        await client.query('select 1 from guests where id = $1 for update', [guest.guestId])
        const { rows: mine } = await client.query<{ n: string }>(
          'select count(*)::text as n from album_photos where wedding_id = $1 and uploaded_by = $2',
          [guest.weddingId, guest.guestId],
        )
        if (Number(mine[0]!.n) >= app.appConfig.albumMaxPerGuest) {
          throw quotaExceeded('album_limit', `Больше ${app.appConfig.albumMaxPerGuest} кадров от одного гостя не принимаем`)
        }
        await client.query(
          'insert into album_photos (id, wedding_id, url, approved, uploaded_by) values ($1,$2,$3,false,$4)',
          [id, guest.weddingId, body.fileUrl, guest.guestId],
        )
        return client.query('select id, url, approved, created_at from album_photos where id = $1', [id])
      })
      return reply.code(201).send(toPhoto(rows[0] as never))
    },
  )

  /* «Одобрить все» одним запросом (план миграции §2.3): по кадру — сотня
   * запросов на альбом из сотни фото, и обрыв посередине оставлял альбом
   * наполовину одобренным. Считаем только те, что сменили состояние: повтор
   * отвечает нулём, а не «сто одобрено» заново. */
  app.patch(
    '/weddings/:weddingId/album',
    {
      schema: {
        body: {
          type: 'object',
          required: ['approved'],
          additionalProperties: false,
          properties: { approved: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const { approved } = request.body as { approved: boolean }
      const res = await db().query('update album_photos set approved = $2 where wedding_id = $1 and approved <> $2', [
        request.member!.weddingId,
        approved,
      ])
      return { updated: res.rowCount ?? 0 }
    },
  )

  app.patch(
    '/weddings/:weddingId/album/:photoId',
    {
      schema: {
        body: {
          type: 'object',
          required: ['approved'],
          additionalProperties: false,
          properties: { approved: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const { photoId } = request.params as { photoId: string }
      const { approved } = request.body as { approved: boolean }
      if (!isUuid(photoId)) throw notFound('Кадр не найден')
      const res = await db().query('update album_photos set approved = $3 where id = $1 and wedding_id = $2', [
        photoId,
        request.member!.weddingId,
        approved,
      ])
      if (res.rowCount === 0) throw notFound('Кадр не найден')
      const { rows } = await db().query('select id, url, approved, created_at from album_photos where id = $1', [
        photoId,
      ])
      return toPhoto(rows[0] as never)
    },
  )
}
