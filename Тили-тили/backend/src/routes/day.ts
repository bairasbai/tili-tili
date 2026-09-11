import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, quotaExceeded, validationFailed } from '../errors.js'
import { isCheckViolation } from '../plugins/db.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { guestByToken } from '../guests/access.js'
import { personCount } from './guests.js'
import { notifyWedding } from '../notify/notify.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import { plural } from '../text/plural.js'
import { assertRealDate, isRealDate } from '../wedding/dates.js'
import { COMMITTED } from '../deals/state.js'

/** Повтор рассылки в это окно считается тем же нажатием. */
const DEBOUNCE_SECONDS = 30

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

export async function dayRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /* ── чек-лист ─────────────────────────────────────────────────────── */
  const toTask = (r: { id: string; title: string; period: string | null; done_at: Date | null; source: string; due?: string | null }) => ({
    id: r.id,
    title: r.title,
    period: r.period,
    done: r.done_at !== null,
    custom: r.source !== 'system',
    /* Срок считает сервер от даты свадьбы и пересчитывает при переносе.
       Пока даты нет — срока нет, и это честнее выдуманного «через месяц». */
    due: r.due ?? null,
  })

  app.get('/weddings/:weddingId/tasks', async (request) => {
    const { rows } = await db().query<{
      id: string
      title: string
      period: string | null
      done_at: Date | null
      source: string
      due: string | null
    }>(
      `select id, title, period, done_at, source, due::text as due from tasks
        where wedding_id = $1 and kind = 'checklist' order by sort, title`,
      [request.member!.weddingId],
    )
    return rows.map(toTask)
  })

  app.post(
    '/weddings/:weddingId/tasks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'period'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            period: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { title: string; period: string }
      const id = uuidv7()
      const { rows: last } = await db().query<{ n: number }>(
        'select coalesce(max(sort), -1) + 1 as n from tasks where wedding_id = $1',
        [request.member!.weddingId],
      )
      /* Срок своей задачи — по той же формуле, что у переноса даты и у
       * шаблона: «за 3 месяца» от даты свадьбы через `make_interval`
       * (31 мая − 3 мес = 28 февраля, а не 3 марта). Раньше своя задача
       * заводилась без срока, и у свадьбы с датой «Заказать торт · За 3 мес»
       * навсегда оставалась без дедлайна рядом с шаблонными (D2-19а). Период
       * не числом («накануне») — срока нет, и это честнее выдуманного. */
      const months = /^\d+$/.test(body.period) ? Number(body.period) : null
      await db().query(
        `insert into tasks (id, wedding_id, title, period, source, sort, due)
         select $1, $2, $3, $4, 'user', $5,
                case when $6::int is null then null
                     else (w.date - make_interval(months => $6::int))::date end
           from weddings w where w.id = $2`,
        [id, request.member!.weddingId, body.title, body.period, last[0]!.n, months],
      )
      const { rows } = await db().query('select id, title, period, done_at, source, due::text as due from tasks where id = $1', [id])
      return reply.code(201).send(toTask(rows[0] as never))
    },
  )

  app.patch(
    '/weddings/:weddingId/tasks/:taskId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { done: { type: 'boolean' }, title: { type: 'string', minLength: 1, maxLength: 300 } },
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string }
      const body = request.body as { done?: boolean; title?: string }
      if (!isUuid(taskId)) throw notFound('Задача не найдена')
      const res = await db().query(
        `update tasks set
           title = coalesce($3, title),
           done_at = case when $4::boolean is null then done_at
                          when $4 then coalesce(done_at, now()) else null end
         where id = $1 and wedding_id = $2`,
        [taskId, request.member!.weddingId, body.title ?? null, body.done ?? null],
      )
      if (res.rowCount === 0) throw notFound('Задача не найдена')
      // Срок в ответе — контракт `Task.due` обещает его и здесь (ERR-0125 закрыл GET и POST, PATCH пропустили).
      const { rows } = await db().query(
        'select id, title, period, done_at, source, due::text as due from tasks where id = $1',
        [taskId],
      )
      return toTask(rows[0] as never)
    },
  )

  app.delete('/weddings/:weddingId/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    if (!isUuid(taskId)) throw notFound('Задача не найдена')
    // Системные задачи из шаблона не удаляются: чек-лист перестанет быть
    // чек-листом, если из него можно вычеркнуть «забронировать площадку».
    const res = await db().query(
      `delete from tasks where id = $1 and wedding_id = $2 and source <> 'system'`,
      [taskId, request.member!.weddingId],
    )
    if (res.rowCount === 0) {
      const { rows } = await db().query('select source from tasks where id = $1 and wedding_id = $2', [
        taskId,
        request.member!.weddingId,
      ])
      if (rows.length > 0) throw conflict('system_task', 'Задачу из шаблона удалить нельзя — её можно только отметить')
      throw notFound('Задача не найдена')
    }
    return reply.code(204).send()
  })

  /* ── тайминг ──────────────────────────────────────────────────────── */
  const toEvent = (r: {
    id: string
    name: string
    location: string | null
    starts_at: Date | null
    ends_at: Date | null
    who: string | null
    icon: string | null
    outdoor: boolean
  }) => ({
    id: r.id,
    name: r.name,
    location: r.location,
    startsAt: r.starts_at?.toISOString() ?? null,
    endsAt: r.ends_at?.toISOString() ?? null,
    who: r.who,
    icon: r.icon,
    outdoor: r.outdoor,
  })

  app.get('/weddings/:weddingId/timeline', async (request) => {
    const { rows } = await db().query(
      'select id, name, location, starts_at, ends_at, who, icon, outdoor from timeline_events where wedding_id = $1 order by sort, starts_at',
      [request.member!.weddingId],
    )
    return rows.map((r) => toEvent(r as never))
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
              id: { type: 'string' },
              name: { type: 'string', minLength: 1, maxLength: 200 },
              location: { type: 'string', nullable: true, maxLength: 300 },
              startsAt: { type: 'string', nullable: true },
              endsAt: { type: 'string', nullable: true },
              who: { type: 'string', nullable: true, maxLength: 300 },
              icon: { type: 'string', nullable: true, maxLength: 16 },
              outdoor: { type: 'boolean', default: false },
            },
          },
        },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      const events = request.body as {
        name: string
        location?: string | null
        startsAt?: string | null
        endsAt?: string | null
        who?: string | null
        icon?: string | null
        outdoor?: boolean
      }[]

      // Время проверяется ДО базы: иначе «вчера» и 30 февраля доходят до
      // `::timestamptz`, и человек получает 500 вместо отказа (D2-12).
      const moments = events.map((e, i) => ({
        startsAt: momentOrNull(e.startsAt, `${i}.startsAt`),
        endsAt: momentOrNull(e.endsAt, `${i}.endsAt`),
      }))

      return db().tx(async (client) => {
        // Замена целиком: клиент присылает состояние экрана, а не список
        // правок. Дописывание оставило бы удалённые блоки.
        await client.query('delete from timeline_events where wedding_id = $1', [weddingId])
        let sort = 0
        for (const [i, e] of events.entries()) {
          await client.query(
            `insert into timeline_events (id, wedding_id, name, location, starts_at, ends_at, who, icon, outdoor, sort)
             values ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10)`,
            [
              uuidv7(),
              weddingId,
              e.name,
              e.location ?? null,
              moments[i]!.startsAt,
              moments[i]!.endsAt,
              e.who ?? null,
              e.icon ?? null,
              e.outdoor ?? false,
              sort++,
            ],
          )
        }
        // Тайминг переписали целиком — подрядчику приезжать к другому часу.
        await noteVendorUpdate(client, weddingId, 'timeline', 'Тайминг дня обновлён')
        const { rows } = await client.query(
          'select id, name, location, starts_at, ends_at, who, icon, outdoor from timeline_events where wedding_id = $1 order by sort',
          [weddingId],
        )
        return rows.map((r) => toEvent(r as never))
      })
    },
  )

  app.post('/weddings/:weddingId/timeline/autogen', async (request) => {
    const weddingId = request.member!.weddingId
    const { rows: current } = await db().query<{
      id: string
      name: string
      location: string | null
      starts_at: Date | null
      ends_at: Date | null
      who: string | null
      icon: string | null
      outdoor: boolean
    }>(
      'select id, name, location, starts_at, ends_at, who, icon, outdoor from timeline_events where wedding_id = $1 order by sort',
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
  const toBus = (r: {
    id: string
    name: string
    pickup: string | null
    departs: string | null
    seats: number
    taken: number
  }) => ({ id: r.id, name: r.name, from: r.pickup, time: r.departs?.slice(0, 5) ?? null, seats: r.seats, taken: r.taken })

  /* Чтения не было вовсе: маршрут заводился и удалялся, но не показывался.
     `taken` считает сервер атомарно при записи гостя — клиенту его взять
     больше неоткуда. */
  app.get('/weddings/:weddingId/logistics/buses', async (request) => {
    const { rows } = await db().query(
      `select id, name, pickup, departs::text as departs, seats, taken from bus_routes
        where wedding_id = $1 order by departs nulls last, name`,
      [request.member!.weddingId],
    )
    return rows.map((r) => toBus(r as never))
  })

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
            time: { type: 'string', pattern: '^[0-2][0-9]:[0-5][0-9]$' },
            seats: { type: 'integer', minimum: 1, maximum: 500 },
            taken: { type: 'integer' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; from?: string; time?: string; seats: number }
      const id = uuidv7()
      await db().query(
        'insert into bus_routes (id, wedding_id, name, pickup, departs, seats) values ($1,$2,$3,$4,$5::time,$6)',
        [id, request.member!.weddingId, body.name, body.from ?? null, body.time ?? null, body.seats],
      )
      const { rows } = await db().query(
        'select id, name, pickup, departs::text as departs, seats, taken from bus_routes where id = $1',
        [id],
      )
      return reply.code(201).send(toBus(rows[0] as never))
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

    const { rows } = await db().query<{ id: string; created_at: Date }>(
      `select id, created_at from broadcasts
        where wedding_id = $1 and action = $2 and created_at > now() - ($3 || ' seconds')::interval
        order by created_at desc limit 1`,
      [weddingId, action, String(DEBOUNCE_SECONDS)],
    )
    if (rows[0]) return { broadcastId: rows[0].id, recipients, notified: 0, debounced: true }

    const id = uuidv7()
    await db().query('insert into broadcasts (id, wedding_id, action, recipients) values ($1,$2,$3,$4)', [
      id,
      weddingId,
      action,
      recipients,
    ])
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
    const { rows: guests } = await db().query<{ status: string; plus_one: boolean }>(
      'select rsvp as status, plus_one from guests where wedding_id = $1',
      [weddingId],
    )
    return {
      question: poll[0]?.question ?? 'Что будете на горячее?',
      sentAt: poll[0]?.sent_at?.toISOString() ?? null,
      expectedPortions: personCount(guests.map((g) => ({ status: g.status, plusOne: g.plus_one }))),
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
          properties: { busId: UUID_ID },
        },
      },
    },
    async (request) => {
      const { guestToken } = request.params as { guestToken: string }
      const { busId } = request.body as { busId: string }
      const guest = await guestByToken(db(), guestToken)

      // Ответ собирается ВНУТРИ транзакции, а отправляется после неё.
      // `reply.send()` внутри `tx` уходит клиенту до коммита: он видит 200,
      // а данных ещё нет — и если коммит упадёт, ему уже сказали «готово».
      return db().tx(async (client) => {
        /* Сначала строка гостя, потом маршрут — тот же порядок замков, что у
         * `PATCH …/guests/{id}` (гость → брони → триггер маршрута): иначе
         * «не придёт» рукой пары и посадка гостя в ту же секунду взаимно
         * ждали друг друга и одна из сторон получала 500 (RF-BE-06). */
        await client.query('select 1 from guests where id = $1 for update', [guest.guestId])
        /* Маршрут под блокировкой строки: два гостя, садящиеся на последнее
         * место одновременно, иначе оба проходят подсчёт персон ниже (R-49). */
        const { rows: bus } = await client.query<{ seats: number; taken: number }>(
          'select seats, taken from bus_routes where id = $1 and wedding_id = $2 for update',
          [busId, guest.weddingId],
        )
        if (bus.length === 0) throw notFound('Маршрут не найден')

        // Гость едет ОДНИМ автобусом. Пересел на другой рейс — место
        // в прежнем обязано освободиться, иначе водитель ждёт того,
        // кто уехал с другой точки сбора.
        await client.query(
          `delete from bus_bookings b using bus_routes r
            where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2 and b.bus_id <> $3`,
          [guest.guestId, guest.weddingId, busId],
        )

        /* Места считаются в персонах, а не в записях (R-29): гость «с +1»
         * едет вдвоём, и `taken` маршрута — сумма персон по записям: её ведёт
         * триггер (фича 005, миграция 17593…), обработчик персоны не
         * пересчитывает. Ранний отказ здесь, под блокировкой маршрута, —
         * потому что дешевле отката транзакции по `CHECK` ниже; правило
         * держит база (D3-16). */
        const { rows: aboard } = await client.query<{ plus_one: boolean; already: boolean }>(
          `select g.plus_one,
                  exists(select 1 from bus_bookings b where b.bus_id = $1 and b.guest_id = $2) as already
             from guests g where g.id = $2`,
          [busId, guest.guestId],
        )
        // Кто уже едет этим автобусом, повтором записи места не отнимает.
        if (!aboard[0]!.already && bus[0]!.taken + (aboard[0]!.plus_one ? 2 : 1) > bus[0]!.seats) {
          throw conflict('bus_full', 'Мест в этом автобусе не осталось')
        }

        // Счётчик ведёт триггер: строки исчезают и мимо обработчика —
        // удаление гостя уносит запись каскадом. Переполнение по персонам
        // ловит `CHECK bus_taken_bounded`, и оно же откатывает транзакцию.
        let booked
        try {
          booked = await client.query(
            'insert into bus_bookings (bus_id, guest_id) values ($1,$2) on conflict do nothing',
            [busId, guest.guestId],
          )
        } catch (error) {
          if (isCheckViolation(error, 'bus_taken_bounded')) {
            throw conflict('bus_full', 'Мест в этом автобусе не осталось')
          }
          throw error
        }

        const { rows } = await client.query<{ taken: number; seats: number }>(
          'select taken, seats from bus_routes where id = $1',
          [busId],
        )
        if (booked.rowCount === 0) {
          return { busId, alreadyBooked: true, ...rows[0]! }
        }
        await client.query(`update guests set transfer = 'need' where id = $1`, [guest.guestId])
        return { busId, alreadyBooked: false, ...rows[0]! }
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
            where b.hotel_id = h.id and b.guest_id = $1 and h.wedding_id = $2 and b.hotel_id <> $3`,
          [guest.guestId, guest.weddingId, hotelId],
        )

        let booked
        try {
          booked = await client.query(
            'insert into hotel_bookings (hotel_id, guest_id) values ($1,$2) on conflict do nothing',
            [hotelId, guest.guestId],
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
        return { hotelId, alreadyBooked: booked.rowCount === 0, ...rows[0]! }
      })
    },
  )

  /* Гость видит маршруты и то, куда он уже записан. Раньше путь был только на
     запись, и `busId` гостю брать было неоткуда. */
  app.get('/join/:guestToken/shuttle', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestByToken(db(), guestToken)
    const { rows } = await db().query(
      `select id, name, pickup, departs::text as departs, seats, taken from bus_routes
        where wedding_id = $1 order by departs nulls last, name`,
      [guest.weddingId],
    )
    const { rows: mine } = await db().query<{ bus_id: string }>(
      'select bus_id from bus_bookings where guest_id = $1 limit 1',
      [guest.guestId],
    )
    return { myBusId: mine[0]?.bus_id ?? null, routes: rows.map((r) => toBus(r as never)) }
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
    const { rows: mine } = await db().query<{ option_id: string }>(
      'select option_id from menu_votes where guest_id = $1 limit 1',
      [guest.guestId],
    )
    return { question: poll[0]?.question ?? '', options, chosenOptionId: mine[0]?.option_id ?? null }
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
              exists(select 1 from hotel_bookings b where b.hotel_id = h.id and b.guest_id = $2) as mine
         from hotel_blocks h where h.wedding_id = $1 order by h.name`,
      [guest.weddingId, guest.guestId],
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
          properties: { optionId: UUID_ID },
        },
      },
    },
    async (request) => {
      const { guestToken } = request.params as { guestToken: string }
      const { optionId } = request.body as { optionId: string }
      const guest = await guestByToken(db(), guestToken)

      const { rows: option } = await db().query('select 1 from menu_options where id = $1 and wedding_id = $2', [
        optionId,
        guest.weddingId,
      ])
      if (option.length === 0) throw notFound('Такого блюда нет в опросе')

      // Один голос на гостя: первичный ключ по гостю превращает повтор
      // в смену выбора, а не во второй голос. Голос и отметка у гостя —
      // одна транзакция: опрос и список гостей читают их порознь (R-122).
      await db().tx(async (client) => {
        await client.query(
          `insert into menu_votes (guest_id, option_id) values ($1,$2)
           on conflict (guest_id) do update set option_id = excluded.option_id, at = now()`,
          [guest.guestId, optionId],
        )
        await client.query('update guests set menu_option_id = $2 where id = $1', [guest.guestId, optionId])
      })
      return { optionId }
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

      // Каждый кадр — файл в хранилище и работа модератора. Без предела
      // один человек забивает альбом и счёт за хранение.
      const { rows: mine } = await db().query<{ n: string }>(
        'select count(*)::text as n from album_photos where wedding_id = $1 and uploaded_by = $2',
        [guest.weddingId, guest.guestId],
      )
      if (Number(mine[0]!.n) >= app.appConfig.albumMaxPerGuest) {
        throw quotaExceeded('album_limit', `Больше ${app.appConfig.albumMaxPerGuest} кадров от одного гостя не принимаем`)
      }
      // Согласие на публикацию — явное действие, а не предустановленная
      // галочка: кадр попадёт в чужой альбом.
      if (!body.consent) throw new AppError(422, 'consent_required', 'Нужно согласие на публикацию кадра в альбоме')

      const id = uuidv7()
      await db().query(
        'insert into album_photos (id, wedding_id, url, approved, uploaded_by) values ($1,$2,$3,false,$4)',
        [id, guest.weddingId, body.fileUrl, guest.guestId],
      )
      const { rows } = await db().query('select id, url, approved, created_at from album_photos where id = $1', [id])
      return reply.code(201).send(toPhoto(rows[0] as never))
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
