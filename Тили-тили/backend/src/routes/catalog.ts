import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import {
  VENDOR_COLUMNS,
  VENDOR_LIVE_JOIN,
  loadDetail,
  rotateNewcomers,
  toVendor,
  type VendorRow,
} from '../catalog/vendors.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER

/** `2027-06` → границы месяца. Без разбора руками: неверный месяц ловится схемой. */
function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const from = new Date(Date.UTC(y, m - 1, 1))
  const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1))
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  // Каталог — не публичная витрина: и контракт, и матрица доступа раздела 6
  // говорят, что он за входом (у гостя в строке `/catalog/*` стоит «—»).
  // Открытый каталог отдаёт всю базу подрядчиков любому скрипту.
  const authed = { preHandler: app.requireConsent }

  /* ── справочник категорий ─────────────────────────────────────────── */
  app.get('/catalog/categories', authed, async () => {
    const { rows } = await db().query<{ id: string; name: string; icon: string | null; tile: string | null }>(
      'select id, name, icon, tile from categories order by sort, name',
    )
    return rows.map((r) => ({ id: r.id, title: r.name, icon: r.icon, tile: r.tile }))
  })

  /* ── выдача ───────────────────────────────────────────────────────── */
  app.get(
    '/catalog/vendors',
    {
      ...authed,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 100 },
            categoryId: { type: 'string', maxLength: 40 },
            city: { type: 'string', maxLength: 80 },
            radiusKm: { type: 'integer', minimum: 0, maximum: 1000, default: 100 },
            priceMin: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
            priceMax: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            ratingMin: { type: 'number', minimum: 0, maximum: 5 },
            hasVideo: { type: 'boolean' },
            sort: { type: 'string', enum: ['rating', 'price_asc', 'price_desc', 'popular'], default: 'rating' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as {
        q?: string
        categoryId?: string
        city?: string
        priceMin?: number
        priceMax?: number
        date?: string
        ratingMin?: number
        hasVideo?: boolean
        sort?: string
        limit?: number
        cursor?: string
      }
      const page = parsePageQuery(query)

      const where: string[] = ['v.published_at is not null']
      const args: unknown[] = []
      const add = (sql: string, value: unknown) => {
        args.push(value)
        where.push(sql.replace('?', `$${args.length}`))
      }

      if (query.categoryId) add('v.category_id = ?', query.categoryId)
      if (query.city) add('c.name = ?', query.city)
      if (query.priceMin !== undefined) add('v.price_from >= ?', query.priceMin)
      if (query.priceMax !== undefined) add('v.price_from <= ?', query.priceMax)
      if (query.ratingMin !== undefined) add('v.rating >= ?', query.ratingMin)
      if (query.q) add("lower(v.name) like '%' || lower(?) || '%'", query.q)
      if (query.hasVideo) where.push("exists (select 1 from vendor_media m where m.vendor_id = v.id and m.kind = 'video')")
      if (query.date) {
        // Занятого на эту дату в выдаче быть не должно: иначе пара пишет тому,
        // кто заведомо не сможет, и тратит на это день.
        add('not exists (select 1 from vendor_busy_dates b where b.vendor_id = v.id and b.date = ?::date)', query.date)
      }

      const order =
        query.sort === 'price_asc'
          ? 'v.price_from asc nulls last, v.id'
          : query.sort === 'price_desc'
            ? 'v.price_from desc nulls last, v.id'
            : query.sort === 'popular'
              ? 'v.reviews_count desc, v.id'
              : 'v.rating desc nulls last, v.id'

      // Курсор — по паре (значение сортировки, id): у двух анкет совпадает
      // и рейтинг, и цена, и без второго ключа порядок между ними не определён.
      if (page.cursor) {
        args.push(page.cursor.id)
        where.push(`v.id > $${args.length}`)
      }

      args.push(page.limit + 1)
      const { rows } = await db().query<VendorRow>(
        `select ${VENDOR_COLUMNS}
           from vendors v ${VENDOR_LIVE_JOIN} left join cities c on c.id = v.city_id
          where ${where.join(' and ')}
          order by ${order}
          limit $${args.length}`,
        args,
      )

      const result = buildPage(rows.map(toVendor), page.limit, (v) => encodeCursor('v', v.id))

      // Ротация новичков — только на первой странице (см. rotateNewcomers).
      if (!page.cursor) {
        const { rows: fresh } = await db().query<VendorRow>(
          `select ${VENDOR_COLUMNS}
             from vendors v ${VENDOR_LIVE_JOIN} left join cities c on c.id = v.city_id
            where ${where.join(' and ')} and v.reviews_count = 0
            order by v.created_at desc
            limit ${page.limit}`,
          args.slice(0, -1),
        )
        result.items = rotateNewcomers(result.items, page.limit, fresh.map(toVendor))
      }

      return { items: result.items, nextCursor: result.nextCursor }
    },
  )

  /* ── анкета ───────────────────────────────────────────────────────── */
  app.get('/catalog/vendors/:vendorId', authed, async (request) => {
    const { vendorId } = request.params as { vendorId: string }
    if (!/^[0-9a-f-]{36}$/i.test(vendorId)) throw notFound('Анкета не найдена')
    const { rows } = await db().query<VendorRow & { about: string | null }>(
      `select ${VENDOR_COLUMNS}, v.about
         from vendors v ${VENDOR_LIVE_JOIN} left join cities c on c.id = v.city_id
        where v.id = $1 and v.published_at is not null`,
      [vendorId],
    )
    if (!rows[0]) throw notFound('Анкета не найдена')
    return loadDetail(db(), vendorId, rows[0])
  })

  /* ── занятость ────────────────────────────────────────────────────── */
  app.get(
    '/catalog/vendors/:vendorId/availability',
    {
      ...authed,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
        },
      },
    },
    async (request) => {
      const { vendorId } = request.params as { vendorId: string }
      const { month } = request.query as { month?: string }
      if (!/^[0-9a-f-]{36}$/i.test(vendorId)) throw notFound('Анкета не найдена')

      const conditions = ['b.vendor_id = $1']
      const args: unknown[] = [vendorId]
      if (month) {
        const [from, to] = monthRange(month)
        args.push(from, to)
        conditions.push('b.date >= $2::date', 'b.date < $3::date')
      }
      const { rows } = await db().query<{ date: string; source: string }>(
        `select b.date::text as date, b.source from vendor_busy_dates b
          where ${conditions.join(' and ')} order by b.date`,
        args,
      )
      return {
        busyDates: rows.map((r) => r.date),
        // Мягкая бронь появится вместе со сделками на этапе 4: до тех пор
        // список пустой, а не отсутствует.
        holdDates: [],
      }
    },
  )

  /* ── консьерж ─────────────────────────────────────────────────────── */
  app.post(
    '/catalog/concierge',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['categoryId'],
          additionalProperties: false,
          properties: {
            categoryId: { type: 'string', maxLength: 40 },
            city: { type: 'string', maxLength: 80 },
            budget: {
              type: 'object',
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
                currency: { type: 'string', enum: ['RUB'] },
              },
            },
            comment: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        categoryId: string
        city?: string
        budget?: { amount: number }
        comment?: string
      }
      const { rows: cat } = await db().query('select 1 from categories where id = $1', [body.categoryId])
      if (cat.length === 0) throw notFound('Категория не найдена')

      // Каждая заявка — ручная работа человека: он ищет подрядчика и звонит.
      // Вторая открытая заявка по той же категории новой работы не создаёт,
      // а только плодит очередь, за которую платит владелец.
      const { rows: pending } = await db().query(
        `select 1 from concierge_requests
          where user_id = $1 and category_id = $2 and status in ('new','in_progress')`,
        [request.caller!.userId, body.categoryId],
      )
      if (pending.length > 0) {
        throw new AppError(409, 'concierge_pending', 'Заявка по этой категории уже в работе — мы свяжемся в течение суток')
      }

      let cityId: number | null = null
      if (body.city) {
        const { rows } = await db().query<{ id: number }>('select id from cities where name = $1 limit 1', [body.city])
        cityId = rows[0]?.id ?? null
      }

      await db().query(
        `insert into concierge_requests (id, user_id, category_id, city_id, budget, comment)
         values ($1, $2, $3, $4, $5, $6)`,
        [uuidv7(), request.caller!.userId, body.categoryId, cityId, body.budget?.amount ?? null, body.comment ?? null],
      )
      return reply.code(201).send()
    },
  )

  /* ── избранное ────────────────────────────────────────────────────── */
  app.get('/me/favorites', { preHandler: app.requireConsent }, async (request) => {
    const { rows } = await db().query<VendorRow>(
      `select ${VENDOR_COLUMNS}
         from favorites f
         join vendors v on v.id = f.vendor_id
         ${VENDOR_LIVE_JOIN}
         left join cities c on c.id = v.city_id
        where f.user_id = $1
        order by f.created_at desc`,
      [request.caller!.userId],
    )
    return rows.map(toVendor)
  })

  app.put('/me/favorites/:vendorId', { preHandler: app.requireConsent }, async (request, reply) => {
    const { vendorId } = request.params as { vendorId: string }
    if (!/^[0-9a-f-]{36}$/i.test(vendorId)) throw notFound('Анкета не найдена')
    const { rows } = await db().query(
      `select 1 from vendors v ${VENDOR_LIVE_JOIN} where v.id = $1 and v.published_at is not null`,
      [vendorId],
    )
    if (rows.length === 0) throw notFound('Анкета не найдена')

    // Повторное добавление — не ошибка: человек нажал сердечко дважды.
    await db().query('insert into favorites (user_id, vendor_id) values ($1, $2) on conflict do nothing', [
      request.caller!.userId,
      vendorId,
    ])
    return reply.code(204).send()
  })

  app.delete('/me/favorites/:vendorId', { preHandler: app.requireConsent }, async (request, reply) => {
    const { vendorId } = request.params as { vendorId: string }
    await db().query('delete from favorites where user_id = $1 and vendor_id = $2', [
      request.caller!.userId,
      vendorId,
    ])
    // Удаление того, чего нет, — тоже успех: результат ровно тот, которого хотели.
    return reply.code(204).send()
  })
}
