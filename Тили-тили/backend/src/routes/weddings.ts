import type { FastifyInstance } from 'fastify'
import { setTimelineActor } from '../timeline/version.js'
import { AppError, conflict, notFound } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { knownTimeZone } from '../notify/quiet.js'
import { assertWeddingDate } from '../wedding/dates.js'
import { rescheduleWedding } from '../wedding/reschedule.js'
import { requireRole, type Role } from '../wedding/access.js'
import { cancelRequestPending } from './weddingLifecycle.js'
import { weddingCode } from '../wedding/codes.js'
import { ref } from '../contract/schemas.generated.js'
import {
  TASK_TEMPLATE,
  slotTemplate,
  timelineTemplate,
  type PrebookedCategory,
  type WeddingFormat,
  type WeddingPlanner,
} from '../wedding/templates.js'

interface WeddingRow {
  id: string
  title: string
  date: string | null
  city_name: string | null
  city_region: string | null
  venue: string | null
  style: string | null
  format: WeddingFormat | null
  planner: WeddingPlanner | null
  guests_planned: number | null
  budget_total: string | null
  currency: string
  tz: string | null
  invite_theme_id: number
  dress_code: string | null
  dress_note: string | null
  invite_text: string | null
  cancel_requested_by: string | null
  cancel_requested_at: Date | null
}

interface MemberRow {
  user_id: string
  name: string | null
  role: Role
  joined_at: Date
}

/**
 * Потолок суммы — предел точного целого в JSON.
 *
 * `bigint` из PostgreSQL приходит строкой, и `Number()` за этой границей
 * молча округляет: 9007199254740993 превращается в …992. Тогда «потрачено»
 * перестаёт сходиться с суммой сделок, и никто не понимает почему.
 * Поэтому граница стоит на входе, а не проверяется на выходе.
 */
const MAX_MINOR_UNITS = Number.MAX_SAFE_INTEGER

const MONEY_SCHEMA = {
  type: 'object',
  required: ['amount', 'currency'],
  additionalProperties: false,
  properties: {
    amount: { type: 'integer', minimum: 0, maximum: MAX_MINOR_UNITS },
    currency: { type: 'string', enum: ['RUB'] },
  },
} as const

const money = (amount: string | null, currency: string) => {
  if (amount === null) return null
  const value = Number(amount)
  if (!Number.isSafeInteger(value)) {
    // В базу такое попасть не может — проверка на входе стоит. Если попало,
    // значит данные правили мимо API, и отдавать округлённое число нельзя.
    throw new AppError(500, 'money_overflow', 'Сумма в базе выходит за пределы точного числа')
  }
  return { amount: value, currency }
}

/**
 * Помощник и координатор не видят денег НИГДЕ — это правило раздела 6 плана,
 * а не только про раздел «Бюджет». Матрица доступа закрывает пути целиком
 * и на поля повлиять не может: карточку свадьбы им смотреть можно, а сумму
 * бюджета в ней — нет. Поэтому поле вырезается здесь, на сборке ответа.
 */
export function toWedding(w: WeddingRow, members: MemberRow[], role: Role) {
  const seesMoney = role === 'couple'
  return {
    id: w.id,
    title: w.title,
    date: w.date,
    city: w.city_name ? { name: w.city_name, region: w.city_region } : null,
    venue: w.venue,
    style: w.style,
    /* Ответы квиза кодами (фича 018): пусто — вопрос пропущен или свадьба заведена до фичи. */
    format: w.format,
    planner: w.planner,
    guestsPlanned: w.guests_planned,
    ...(seesMoney ? { budgetTotal: money(w.budget_total, w.currency) } : {}),
    /* Кто запросил отмену и когда — только паре, и только пока запрос жив.
     *
     * Это не сведения о свадьбе, а предупреждение второму партнёру: его
     * нажатие «Отменить» не запросит отмену, а ИСПОЛНИТ её — брони отменятся,
     * даты уйдут подрядчикам, вернуть их будет нечем. Без этих полей показать
     * предупреждение фронту нечем, и второй партнёр подтверждал вслепую
     * (ERR-0101). Протухший запрос отдаётся пустым: он и не действует. */
    ...(seesMoney
      ? cancelRequestPending(w.cancel_requested_by, w.cancel_requested_at)
        ? {
            cancelRequestedBy: w.cancel_requested_by,
            cancelRequestedAt: w.cancel_requested_at?.toISOString() ?? null,
          }
        : { cancelRequestedBy: null, cancelRequestedAt: null }
      : {}),
    tz: w.tz,
    inviteThemeId: w.invite_theme_id,
    dressCode: w.dress_code,
    dressNote: w.dress_note,
    inviteText: w.invite_text,
    members: members.map((m) => ({
      user: { id: m.user_id, name: m.name ?? '' },
      role: m.role,
      joinedAt: m.joined_at.toISOString(),
    })),
  }
}

/** Условие «участник жив»: мягко удалённый аккаунт в команде не считается и не показывается (R-224). */
const LIVE_MEMBERS_SQL = `select m.user_id, u.name, m.role, m.joined_at
         from wedding_members m join users u on u.id = m.user_id
        where m.wedding_id = $1 and u.deleted_at is null order by m.joined_at`

/** Есть ли в свадьбе $1 другой ЖИВОЙ участник с ролью «пара», кроме $2 — подзапрос для exists(). */
const OTHER_LIVE_COUPLE_SQL = `select 1 from wedding_members o join users u on u.id = o.user_id
                    where o.wedding_id = $1 and o.user_id <> $2 and o.role = 'couple' and u.deleted_at is null`

export async function weddingRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const loadWedding = async (weddingId: string, role: Role) => {
    const { rows } = await db().query<WeddingRow>(
      `select w.id, w.title, w.date::text as date, c.name as city_name, c.region as city_region,
              w.venue, w.style, w.format, w.planner, w.guests_planned, w.budget_total::text as budget_total, w.currency,
              w.tz, w.invite_theme_id, w.invite_text, w.dress_code, w.dress_note,
              w.cancel_requested_by, w.cancel_requested_at
         from weddings w left join cities c on c.id = w.city_id
        where w.id = $1 and w.archived_at is null`,
      [weddingId],
    )
    if (!rows[0]) throw notFound('Свадьба не найдена')
    /* Без мягко удалённых: иначе ушедший партнёр 30 дней стоял бы в команде
     * как активный участник с короной, а его имя — персональные данные
     * удалённого — продолжало отдаваться команде (D1-10). */
    const { rows: members } = await db().query<MemberRow>(LIVE_MEMBERS_SQL, [weddingId])
    return toWedding(rows[0], members, role)
  }

  /* ── мои свадьбы ──────────────────────────────────────────────────── */
  app.get('/weddings', { preHandler: app.requireConsent }, async (request) => {
    // Единственный способ найти свою свадьбу после переустановки приложения:
    // идентификатор жил только в localStorage, и с чистым устройством
    // восстановить его больше неоткуда.
    const { rows } = await db().query<{ id: string; role: Role }>(
      `select w.id, m.role from wedding_members m
         join weddings w on w.id = m.wedding_id
        where m.user_id = $1 and w.archived_at is null
        order by w.created_at desc`,
      [request.caller!.userId],
    )
    const out = []
    for (const row of rows) out.push({ ...(await loadWedding(row.id, row.role)), role: row.role })
    return out
  })

  /* ── создание из квиза ────────────────────────────────────────────── */
  app.post(
    '/weddings',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['partnerName', 'city'],
          additionalProperties: false,
          properties: {
            partnerName: { type: 'string', minLength: 1, maxLength: 120 },
            date: { type: 'string', format: 'date' },
            city: {
              type: 'object',
              required: ['name', 'region'],
              additionalProperties: false,
              properties: { name: { type: 'string' }, region: { type: 'string' } },
            },
            budgetTotal: MONEY_SCHEMA,
            guestsPlanned: { type: 'integer', minimum: 0, maximum: 5000 },
            style: { type: 'string', maxLength: 120 },
            /* Ответы квиза кодами (фича 018) — схемами контракта, а не второй копией списков:
               неизвестный код — 422 с полем, как любое нарушение схемы. */
            format: ref('WeddingFormat'),
            planner: ref('WeddingPlanner'),
            prebooked: { type: 'array', uniqueItems: true, maxItems: 4, items: ref('PrebookedCategory') },
            quizAnswers: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        partnerName: string
        date?: string
        city: { name: string; region: string }
        budgetTotal?: { amount: number; currency: string }
        guestsPlanned?: number
        style?: string
        format?: WeddingFormat
        planner?: WeddingPlanner
        prebooked?: PrebookedCategory[]
      }
      const userId = request.caller!.userId
      const format = body.format ?? null
      const planner = body.planner ?? null
      /* «Уже забронировано вне приложения»: отметка на слоте этой категории и выполненная задача,
         которая означает его бронь. Пустой список («Пока ничего») и пропуск вопроса — одно и то же. */
      const prebooked = new Set<string>(body.prebooked ?? [])

      const { rows: owner } = await db().query<{ name: string | null }>('select name from users where id = $1', [userId])
      const ownName = owner[0]?.name?.trim()
      const title = ownName ? `${ownName} ♥ ${body.partnerName}` : body.partnerName

      const { rows: cityRows } = await db().query<{ id: number; tz: string | null }>(
        'select id, tz from cities where name = $1 and region = $2 limit 1',
        [body.city.name, body.city.region],
      )
      // Город из справочника, а не строкой: иначе «Уфа» и «уфа» станут двумя
      // разными городами, и поиск подрядчиков по городу развалится.
      if (!cityRows[0]) throw notFound(`Город «${body.city.name}» не найден в справочнике`)
      const cityId = cityRows[0].id
      /* Часовой пояс берётся из города, а не остаётся пустым. По нему
       * открывается чат дня X, снимаются тихие часы и считается «после
       * свадьбы»: без него вся страна живёт по Москве, и во Владивостоке
       * чат дня X открывается в день свадьбы после обеда. */
      const cityTz = cityRows[0].tz

      const weddingId = uuidv7()
      const date = body.date ?? null
      if (date) assertWeddingDate(date)

      /* Свадьба и её содержимое заводятся одной транзакцией.
       *
       * Здесь больше тридцати вставок подряд: сама свадьба, пара, 12–15 слотов
       * мозаики, чек-лист и тайминг. Раздельными запросами сбой на середине
       * оставлял свадьбу без части шаблона — например, с восемью слотами
       * вместо двенадцати, — и починить это человеку нечем: маршрута
       * «доложить недостающее» нет, а завести вторую свадьбу вместо кривой
       * он не догадается (ERR-0109). */
      const existing = await db().tx(async (client) => {
        /* Одна живая свадьба на пару (фича 005, В6): вторая заводится после
         * отмены или архива первой. Проверка и вставка — под блокировкой
         * строки человека: два одновременных POST иначе оба видели «свадьбы
         * нет» и заводили две. Ограничением базы «одна живая свадьба на
         * couple» не выразить — участие лежит в `wedding_members`, живость в
         * `weddings`, — поэтому очередь строит `for update` по `users`: второй
         * дожидается первого и видит его свадьбу. */
        await client.query('select id from users where id = $1 for update', [userId])
        const { rows: live } = await client.query<{ id: string }>(
          `select w.id from weddings w
             join wedding_members m on m.wedding_id = w.id
            where m.user_id = $1 and m.role = 'couple' and w.cancelled_at is null and w.archived_at is null
            order by w.created_at desc limit 1`,
          [userId],
        )
        if (live[0]) return live[0].id

        await client.query("select set_config('tili.timeline_actor', $1, true)", [userId])
        await client.query(
          `insert into weddings (id, owner_id, title, date, city_id, style, guests_planned,
                                 budget_total, currency, invite_code, tz, format, planner)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            weddingId,
            userId,
            title,
            date,
            cityId,
            body.style ?? null,
            body.guestsPlanned ?? null,
            body.budgetTotal?.amount ?? null,
            body.budgetTotal?.currency ?? 'RUB',
            weddingCode(),
            cityTz,
            format,
            planner,
          ],
        )
        await client.query(
          `insert into wedding_members (wedding_id, user_id, role) values ($1, $2, 'couple')`,
          [weddingId, userId],
        )

        // Мозаика, чек-лист и тайминг заводятся сразу: пустая свадьба без
        // 12 слотов — это экран, на котором нечего делать. Состав — по
        // формату и «кто планирует» из квиза (фича 018).
        for (const s of slotTemplate(format, planner)) {
          await client.query(
            `insert into slots (id, wedding_id, category_id, label, sort, prebooked_at)
             values ($1, $2, $3, $4, $5, case when $6::boolean then now() end)`,
            [uuidv7(), weddingId, s.categoryId, s.label, s.sort, prebooked.has(s.categoryId)],
          )
        }
        for (const t of TASK_TEMPLATE) {
          /* Срок — той же формулой базы, что и перенос (`reschedule.ts`):
           * JS-арифметика `setUTCMonth` не подрезала число, и «за 3 месяца»
           * от 31 мая давало 31 февраля → 3 марта, а первая дата через
           * перенос — 28 февраля. Одна свадьба получала разные сроки в
           * зависимости от того, назвали дату в квизе или позже (D2-11). */
          /* Задача, чья бронь уже есть вне приложения, заводится выполненной (фича 018). */
          await client.query(
            `insert into tasks (id, wedding_id, title, period, due, source, sort, done_at)
             values ($1, $2, $3, $4, ($5::date - make_interval(months => $6::int))::date, 'system', $7,
                     case when $8::boolean then now() end)`,
            [
              uuidv7(),
              weddingId,
              t.title,
              String(t.monthsBefore),
              date,
              t.monthsBefore,
              t.sort,
              t.categoryId !== undefined && prebooked.has(t.categoryId),
            ],
          )
        }
        await client.query("select set_config('tili.timeline_actor', $1, true)", [userId])
        for (const e of timelineTemplate(format)) {
          // Время шаблона — местное на площадке, а не UTC. Собирали его строкой
          // `${date}T08:00:00Z`, и «сборы невесты в 08:00» в Уфе (+5) выходили
          // на экране в 13:00 — ровно на разницу поясов. Второй день
          // двухдневной свадьбы — следующее число (`dayOffset`, фича 018).
          await client.query(
            `insert into timeline_events (id, wedding_id, name, starts_at, ends_at, icon, sort, duration_minutes, template_start, template_day_offset)
             values ($1, $2, $3,
                     case when $4::date is null then null else ((($4::date + $10::int) + $5::time) at time zone $8) end,
                     case when $4::date is null then null else ((($4::date + $10::int) + $6::time) at time zone $8) end,
                     $7, $9, extract(epoch from ($6::time - $5::time))/60, $5::time, $10::int)`,
            [uuidv7(), weddingId, e.name, date, e.startsAt, e.endsAt, e.icon, cityTz, e.sort, e.dayOffset ?? 0],
          )
        }
        await client.query(
          `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'wedding.created', 'wedding', $2)`,
          [userId, weddingId],
        )
        return null
      })

      if (existing) {
        /* Тело — руками, а не `AppError`: контракт обещает в 409 `details`
         * с идентификатором существующей свадьбы, чтобы клиент мог сразу
         * увести человека к ней, а единый формат ошибки (`errors.ts`)
         * поля `details` не знает. Форма остальных полей — та же. */
        return reply.code(409).send({
          error: {
            code: 'wedding_exists',
            message: 'У вас уже есть свадьба — вторую можно завести после её отмены или завершения.',
            details: { weddingId: existing },
          },
        })
      }

      return reply.code(201).send(await loadWedding(weddingId, 'couple'))
    },
  )

  /* ── карточка ─────────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId', async (request) =>
    loadWedding(request.member!.weddingId, request.member!.role),
  )

  app.patch(
    '/weddings/:weddingId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            date: { type: 'string', format: 'date' },
            city: {
              type: 'object',
              required: ['name', 'region'],
              additionalProperties: false,
              properties: { name: { type: 'string' }, region: { type: 'string' } },
            },
            budgetTotal: MONEY_SCHEMA,
            guestsPlanned: { type: 'integer', minimum: 0, maximum: 5000 },
            style: { type: 'string', maxLength: 120 },
            venue: { type: 'string', maxLength: 200 },
            tz: { type: 'string', maxLength: 64 },
            inviteText: { type: 'string', maxLength: 2000 },
            inviteThemeId: { type: 'integer', minimum: 0, maximum: 9 },
            // `null` снимает значение (контракт: nullable). Однажды написанное
            // «дамы — без белого» иначе гость видел бы вечно (D3-11).
            dressCode: { type: ['string', 'null'], maxLength: 32 },
            dressNote: { type: ['string', 'null'], maxLength: 300 },
          },
        },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      const body = request.body as Record<string, unknown> & {
        city?: { name: string; region: string }
        budgetTotal?: { amount: number }
      }
      /* Для полей, где `null` — законное значение, семантика «поле пришло»,
       * а не `coalesce`: пропущенное не трогается, присланный `null` стирает. */
      const has = (field: string) => Object.prototype.hasOwnProperty.call(body, field)

      let cityId: number | null = null
      let cityTz: string | null = null
      if (body.city) {
        const { rows } = await db().query<{ id: number; tz: string | null }>(
          'select id, tz from cities where name = $1 and region = $2 limit 1',
          [body.city.name, body.city.region],
        )
        if (!rows[0]) throw notFound(`Город «${body.city.name}» не найден в справочнике`)
        cityId = rows[0].id
        // Переехали в другой город — пояс едет вместе с ним. Явно указанный
        // в этом же запросе побеждает: человек мог поправить его сам.
        cityTz = rows[0].tz
      }

      /* Часовой пояс уходит в `AT TIME ZONE` внутри триггера, а неизвестная
       * зона там — ошибка базы, то есть 500 вместо внятного отказа.
       * Проверяем на входе (ERR-0055 — та же беда была у пользователя). */
      if (body.tz !== undefined && knownTimeZone(body.tz as string) !== body.tz) {
        throw new AppError(422, 'unknown_timezone', 'Неизвестный часовой пояс', {
          tz: 'ожидается зона вида Europe/Moscow',
        })
      }
      if (body.date !== undefined) assertWeddingDate(body.date as string)

      /* От даты живут занятость подрядчиков, сроки задач и блоки тайминга.
       * Раньше здесь менялась только колонка: подрядчик оставался занят
       * на дне, которого больше нет, а на настоящий день свадьбы у него
       * в календаре было пусто — и эту дату успевала занять другая пара.
       * Теперь обе двери в это поле ведут в один и тот же перенос.
       *
       * Перенос и остальные поля — одна транзакция, и дату пишет только
       * перенос: до ревью 015 колонка `date` писалась второй раз отдельным
       * запросом, уже без замка свадьбы, — перенос с другого устройства
       * между ними затирался старой датой при сдвинутых задачах (D8). */
      await db().tx(async (client) => {
        if (body.date !== undefined) {
          await rescheduleWedding(client, weddingId, body.date as string, request.caller!.userId)
        }
        await setTimelineActor(client, request.caller!.userId)
        await client.query(
          `update weddings set
             city_id = coalesce($2, city_id),
             budget_total = coalesce($3::bigint, budget_total), guests_planned = coalesce($4, guests_planned),
             style = coalesce($5, style), venue = coalesce($6, venue),
             tz = coalesce($7, $10, tz),
             invite_text = coalesce($8, invite_text), invite_theme_id = coalesce($9, invite_theme_id),
             dress_code = case when $13::boolean then $11::text else dress_code end,
             dress_note = case when $14::boolean then $12::text else dress_note end
           where id = $1`,
          [
            weddingId,
            cityId,
            body.budgetTotal?.amount ?? null,
            (body.guestsPlanned as number) ?? null,
            (body.style as string) ?? null,
            (body.venue as string) ?? null,
            (body.tz as string) ?? null,
            (body.inviteText as string) ?? null,
            (body.inviteThemeId as number) ?? null,
            cityTz,
            (body.dressCode as string | null) ?? null,
            (body.dressNote as string | null) ?? null,
            has('dressCode'),
            has('dressNote'),
          ],
        )
      })
      return loadWedding(weddingId, request.member!.role)
    },
  )

  /* ── команда ──────────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/members', async (request) => {
    const { rows } = await db().query<MemberRow>(LIVE_MEMBERS_SQL, [request.member!.weddingId])
    return rows.map((m) => ({
      user: { id: m.user_id, name: m.name ?? '' },
      role: m.role,
      joinedAt: m.joined_at.toISOString(),
    }))
  })

  app.patch(
    '/weddings/:weddingId/members/:userId',
    {
      schema: {
        params: { type: 'object', required: ['userId'], properties: { userId: UUID_ID } },
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: { role: { type: 'string', enum: ['couple', 'helper', 'coordinator'] } },
        },
      },
    },
    async (request) => {
      requireRole(request, 'couple')
      const weddingId = request.member!.weddingId
      const { userId } = request.params as { userId: string }
      const { role } = request.body as { role: Role }

      /* Понижение пары — одним запросом с условием «есть другой ЖИВОЙ couple»,
       * как у удаления ниже. Раздельная проверка считала мёртвого партнёра за
       * живого (после его `deleted_at` свадьба оставалась без пары) и не была
       * атомарной: два партнёра, понижающие друг друга одновременно, оба
       * проходили (D1-09, R-224). Строка свадьбы берётся `for update`: две
       * смены состава одной команды идут по очереди, и вторая видит первую. */
      const changed = await db().tx(async (client) => {
        await client.query('select id from weddings where id = $1 for update', [weddingId])
        await setTimelineActor(client, request.caller!.userId)
        return client.query(
          `update wedding_members m set role = $3
            where m.wedding_id = $1 and m.user_id = $2
              and ($3 = 'couple' or m.role <> 'couple' or exists (${OTHER_LIVE_COUPLE_SQL}))`,
          [weddingId, userId, role],
        )
      })
      if (changed.rowCount === 0) await explainMissing(weddingId, userId)
      return { ok: true }
    },
  )

  app.delete(
    '/weddings/:weddingId/members/:userId',
    { schema: { params: { type: 'object', required: ['userId'], properties: { userId: UUID_ID } } } },
    async (request, reply) => {
      requireRole(request, 'couple')
      const weddingId = request.member!.weddingId
      const { userId } = request.params as { userId: string }

      // Проверка «остался ли ещё кто-то с ролью couple» и само удаление — одно
      // действие. Раздельно двое участников с этой ролью, удаляющие друг друга
      // одновременно, оба увидели бы «остался» и оба удалили: свадьба стала бы
      // ничьей. Условие NOT EXISTS считается в момент удаления строки, а
      // строка свадьбы под `for update` выстраивает такие удаления в очередь.
      const res = await db().tx(async (client) => {
        await client.query('select id from weddings where id = $1 for update', [weddingId])
        await setTimelineActor(client, request.caller!.userId)
        return client.query(
          `delete from wedding_members m
            where m.wedding_id = $1 and m.user_id = $2
              and (m.role <> 'couple' or exists (${OTHER_LIVE_COUPLE_SQL}))`,
          [weddingId, userId],
        )
      })
      if (res.rowCount === 0) await explainMissing(weddingId, userId)
      return reply.code(204).send()
    },
  )

  /**
   * Свадьба без пары становится ничьей: её нельзя ни редактировать, ни удалить,
   * ни вернуть себе доступ. Проверка в условии запроса, а не в БД: ограничением
   * «хотя бы одна строка с ролью couple» в PostgreSQL не выражается. Здесь —
   * только объяснение отказа: участника нет вовсе или он последняя живая пара.
   */
  async function explainMissing(weddingId: string, userId: string): Promise<never> {
    const { rows } = await db().query<{ present: boolean }>(
      'select true as present from wedding_members where wedding_id = $1 and user_id = $2',
      [weddingId, userId],
    )
    if (rows.length === 0) throw notFound('Участник не найден')
    throw conflict('last_couple', 'Нельзя убрать последнего участника с ролью «пара» — свадьба останется ничьей')
  }
}
