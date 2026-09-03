import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { knownTimeZone } from '../notify/quiet.js'
import { requireRole, type Role } from '../wedding/access.js'
import { weddingCode } from '../wedding/codes.js'
import { SLOT_TEMPLATE, TASK_TEMPLATE, TIMELINE_TEMPLATE } from '../wedding/templates.generated.js'

interface WeddingRow {
  id: string
  title: string
  date: string | null
  city_name: string | null
  city_region: string | null
  venue: string | null
  style: string | null
  guests_planned: number | null
  budget_total: string | null
  currency: string
  tz: string | null
  invite_theme_id: number
  invite_text: string | null
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
function toWedding(w: WeddingRow, members: MemberRow[], role: Role) {
  const seesMoney = role === 'couple'
  return {
    id: w.id,
    title: w.title,
    date: w.date,
    city: w.city_name ? { name: w.city_name, region: w.city_region } : null,
    venue: w.venue,
    style: w.style,
    guestsPlanned: w.guests_planned,
    ...(seesMoney ? { budgetTotal: money(w.budget_total, w.currency) } : {}),
    tz: w.tz,
    inviteThemeId: w.invite_theme_id,
    inviteText: w.invite_text,
    members: members.map((m) => ({
      user: { id: m.user_id, name: m.name ?? '' },
      role: m.role,
      joinedAt: m.joined_at.toISOString(),
    })),
  }
}

/** Задача «за 9 месяцев до» превращается в дату относительно дня свадьбы. */
function dueDate(weddingDate: string | null, monthsBefore: number): string | null {
  if (!weddingDate) return null
  const d = new Date(weddingDate + 'T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() - monthsBefore)
  return d.toISOString().slice(0, 10)
}

function eventAt(weddingDate: string | null, hhmm: string): string | null {
  if (!weddingDate) return null
  return `${weddingDate}T${hhmm}:00Z`
}

export async function weddingRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const loadWedding = async (weddingId: string, role: Role) => {
    const { rows } = await db().query<WeddingRow>(
      `select w.id, w.title, w.date::text as date, c.name as city_name, c.region as city_region,
              w.venue, w.style, w.guests_planned, w.budget_total::text as budget_total, w.currency,
              w.tz, w.invite_theme_id, w.invite_text
         from weddings w left join cities c on c.id = w.city_id
        where w.id = $1 and w.archived_at is null`,
      [weddingId],
    )
    if (!rows[0]) throw notFound('Свадьба не найдена')
    const { rows: members } = await db().query<MemberRow>(
      `select m.user_id, u.name, m.role, m.joined_at
         from wedding_members m join users u on u.id = m.user_id
        where m.wedding_id = $1 order by m.joined_at`,
      [weddingId],
    )
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
      }
      const userId = request.caller!.userId

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

      await db().query(
        `insert into weddings (id, owner_id, title, date, city_id, style, guests_planned,
                               budget_total, currency, invite_code, tz)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
        ],
      )
      await db().query(
        `insert into wedding_members (wedding_id, user_id, role) values ($1, $2, 'couple')`,
        [weddingId, userId],
      )

      // Мозаика, чек-лист и тайминг заводятся сразу: пустая свадьба без
      // 12 слотов — это экран, на котором нечего делать.
      for (const s of SLOT_TEMPLATE) {
        await db().query(
          'insert into slots (id, wedding_id, category_id, label, sort) values ($1, $2, $3, $4, $5)',
          [uuidv7(), weddingId, s.categoryId, s.label, s.sort],
        )
      }
      for (const t of TASK_TEMPLATE) {
        await db().query(
          `insert into tasks (id, wedding_id, title, period, due, source, sort)
           values ($1, $2, $3, $4, $5, 'system', $6)`,
          [uuidv7(), weddingId, t.title, String(t.monthsBefore), dueDate(date, t.monthsBefore), t.sort],
        )
      }
      for (const e of TIMELINE_TEMPLATE) {
        await db().query(
          `insert into timeline_events (id, wedding_id, name, starts_at, ends_at, icon, sort)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [uuidv7(), weddingId, e.name, eventAt(date, e.startsAt), eventAt(date, e.endsAt), e.icon, e.sort],
        )
      }
      await db().query(
        `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'wedding.created', 'wedding', $2)`,
        [userId, weddingId],
      )

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

      await db().query(
        `update weddings set
           date = coalesce($2::date, date), city_id = coalesce($3, city_id),
           budget_total = coalesce($4::bigint, budget_total), guests_planned = coalesce($5, guests_planned),
           style = coalesce($6, style), venue = coalesce($7, venue),
           tz = coalesce($8, $11, tz),
           invite_text = coalesce($9, invite_text), invite_theme_id = coalesce($10, invite_theme_id)
         where id = $1`,
        [
          weddingId,
          (body.date as string) ?? null,
          cityId,
          body.budgetTotal?.amount ?? null,
          (body.guestsPlanned as number) ?? null,
          (body.style as string) ?? null,
          (body.venue as string) ?? null,
          (body.tz as string) ?? null,
          (body.inviteText as string) ?? null,
          (body.inviteThemeId as number) ?? null,
          cityTz,
        ],
      )
      return loadWedding(weddingId, request.member!.role)
    },
  )

  /* ── команда ──────────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/members', async (request) => {
    const { rows } = await db().query<MemberRow>(
      `select m.user_id, u.name, m.role, m.joined_at
         from wedding_members m join users u on u.id = m.user_id
        where m.wedding_id = $1 order by m.joined_at`,
      [request.member!.weddingId],
    )
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

      if (role !== 'couple') await assertNotLastCouple(weddingId, userId)

      const res = await db().query('update wedding_members set role = $3 where wedding_id = $1 and user_id = $2', [
        weddingId,
        userId,
        role,
      ])
      if (res.rowCount === 0) throw notFound('Участник не найден')
      return { ok: true }
    },
  )

  app.delete('/weddings/:weddingId/members/:userId', async (request, reply) => {
    requireRole(request, 'couple')
    const weddingId = request.member!.weddingId
    const { userId } = request.params as { userId: string }

    // Проверка «остался ли ещё кто-то с ролью couple» и само удаление — одно
    // действие. Раздельно двое участников с этой ролью, удаляющие друг друга
    // одновременно, оба увидели бы «остался» и оба удалили: свадьба стала бы
    // ничьей. Условие NOT EXISTS считается в момент удаления строки.
    const res = await db().query(
      `delete from wedding_members m
        where m.wedding_id = $1 and m.user_id = $2
          and (m.role <> 'couple'
               or exists (select 1 from wedding_members o
                           where o.wedding_id = $1 and o.user_id <> $2 and o.role = 'couple'))`,
      [weddingId, userId],
    )
    if (res.rowCount === 0) {
      const { rows } = await db().query<{ present: boolean }>(
        'select true as present from wedding_members where wedding_id = $1 and user_id = $2',
        [weddingId, userId],
      )
      if (rows.length === 0) throw notFound('Участник не найден')
      throw conflict('last_couple', 'Нельзя убрать последнего участника с ролью «пара» — свадьба останется ничьей')
    }
    return reply.code(204).send()
  })

  /**
   * Свадьба без пары становится ничьей: её нельзя ни редактировать, ни удалить,
   * ни вернуть себе доступ. Проверка тут, а не в БД: ограничением «хотя бы одна
   * строка с ролью couple» в PostgreSQL не выражается.
   */
  async function assertNotLastCouple(weddingId: string, userId: string): Promise<void> {
    const { rows } = await db().query<{ others: string }>(
      `select count(*)::text as others from wedding_members
        where wedding_id = $1 and role = 'couple' and user_id <> $2`,
      [weddingId, userId],
    )
    if (Number(rows[0]!.others) === 0) {
      throw conflict('last_couple', 'Нельзя убрать последнего участника с ролью «пара» — свадьба останется ничьей')
    }
  }
}
