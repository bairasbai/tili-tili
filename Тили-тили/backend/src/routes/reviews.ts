import type { FastifyInstance } from 'fastify'
import { AppError, conflict, forbidden, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { isUniqueViolation } from '../plugins/db.js'
import { guestByToken, readGuestToken } from '../guests/access.js'
import { recomputeRating } from '../reviews/rating.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { assertVendorLive } from '../catalog/vendors.js'
import { chatForUser } from '../chats/access.js'

/** Окно на отзыв после завершения сделки (План §18.2). */
const REVIEW_WINDOW_DAYS = 14

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /* ── публичная лента отзывов ──────────────────────────────────────── */
  app.get(
    '/catalog/vendors/:vendorId/reviews',
    {
      preHandler: app.requireConsent,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', enum: ['couple', 'guest', 'all'], default: 'all' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      const { vendorId } = request.params as { vendorId: string }
      if (!isUuid(vendorId)) throw notFound('Подрядчик не найден')
      const query = request.query as { source?: string }
      const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
      const source = query.source ?? 'all'

      /* Лента — часть анкеты, и живость у неё та же, что у карточки
       * (`GET /catalog/vendors/{id}`): заблокированная, снятая или удалённая
       * анкета не читается и по прямой ссылке, неизвестный id — 404, а не
       * `200 []` (D5-20). */
      await assertVendorLive(db(), vendorId)

      /* Столбец `guest_token` не читается: у отзыва гостя видно, что он
       * гостевой, но не кто его оставил (§15 и §9 — одно и то же правило).
       * Скрытые модератором не отдаются и в рейтинг не входят. */
      const { rows } = await db().query<{
        id: string
        source: string
        stars: number
        text: string | null
        reply: string | null
        replied_at: Date | null
        created_at: Date
      }>(
        `select id, source, stars, text, reply, replied_at, created_at
           from reviews
          where vendor_id = $1 and hidden_at is null
            and ($2 = 'all' or source = $2)
            and ($3::text is null or (created_at, id) < ($3::timestamptz, $4::uuid))
          order by created_at desc, id desc
          limit $5`,
        [vendorId, source, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
      )

      return buildPage(
        rows.map((r) => ({
          id: r.id,
          source: r.source,
          // Бейдж рисуется по источнику: у пары договор, у гостя впечатление.
          authorName: r.source === 'guest' ? 'Гость свадьбы' : 'Пара со сделкой',
          rating: r.stars,
          text: r.text ?? '',
          createdAt: r.created_at.toISOString(),
          reply: r.reply ? { text: r.reply, createdAt: (r.replied_at ?? r.created_at).toISOString() } : null,
        })),
        page.limit,
        (r) => encodeCursor(r.createdAt, r.id),
      )
    },
  )

  /* ── отзыв пары ───────────────────────────────────────────────────── */
  app.post(
    '/catalog/vendors/:vendorId/reviews',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['rating', 'text'],
          additionalProperties: false,
          properties: {
            rating: { type: 'integer', minimum: 1, maximum: 5 },
            text: { type: 'string', minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { vendorId } = request.params as { vendorId: string }
      if (!isUuid(vendorId)) throw notFound('Подрядчик не найден')
      const body = request.body as { rating: number; text: string }
      const userId = request.caller!.userId

      /* Право на отзыв — это завершённая сделка, а не желание высказаться.
       * Ищем её сразу с проверкой окна: «отзыв через год» — это уже
       * не впечатление, а сведение счётов (§18.2). */
      const { rows } = await db().query<{ id: string; wedding_id: string; too_late: boolean }>(
        `select d.id, d.wedding_id,
                (coalesce(d.done_at, d.created_at) < now() - make_interval(days => $3)) as too_late
           from deals d
           join wedding_members m on m.wedding_id = d.wedding_id
          where d.vendor_id = $1 and m.user_id = $2 and m.role = 'couple' and d.state = 'done'
          order by coalesce(d.done_at, d.created_at) desc limit 1`,
        [vendorId, userId, REVIEW_WINDOW_DAYS],
      )
      const deal = rows[0]
      // 403, а не 404: подрядчик существует, права на отзыв нет.
      if (!deal) throw forbidden('Отзыв можно оставить только по завершённой сделке')
      if (deal.too_late) {
        throw forbidden(`Отзыв принимается ${REVIEW_WINDOW_DAYS} дней после завершения сделки`)
      }

      try {
        await db().query(
          `insert into reviews (id, vendor_id, wedding_id, deal_id, source, stars, text)
           values ($1,$2,$3,$4,'couple',$5,$6)`,
          [uuidv7(), vendorId, deal.wedding_id, deal.id, body.rating, body.text],
        )
      } catch (error) {
        // Один отзыв на сделку держит уникальный индекс, а не проверка:
        // две одновременные отправки прошли бы обе.
        if (isUniqueViolation(error)) throw conflict('review_exists', 'По этой сделке отзыв уже оставлен')
        throw error
      }
      await recomputeRating(db(), vendorId)
      return reply.code(201).send({ vendorId, rating: body.rating })
    },
  )

  /* ── отзывы гостей ────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/guest-reviews', async (request) => {
    /* Пара видит звёзды и текст, но не автора: столбец `guest_token`
     * не читается вовсе — та же граница, что у резервов подарков (§9). */
    const { rows } = await db().query<{
      id: string
      vendor_id: string
      vendor_name: string | null
      stars: number
      text: string | null
      created_at: Date
    }>(
      `select r.id, r.vendor_id, v.name as vendor_name, r.stars, r.text, r.created_at
         from reviews r left join vendors v on v.id = r.vendor_id
        where r.wedding_id = $1 and r.source = 'guest' and r.hidden_at is null
        order by r.created_at desc`,
      [request.member!.weddingId],
    )
    return rows.map((r) => ({
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      authorName: 'Гость свадьбы',
      rating: r.stars,
      text: r.text ?? '',
      createdAt: r.created_at.toISOString(),
    }))
  })

  app.post(
    '/weddings/:weddingId/guest-reviews',
    {
      schema: {
        body: {
          type: 'object',
          required: ['vendorId', 'stars'],
          additionalProperties: false,
          properties: {
            vendorId: UUID_ID,
            stars: { type: 'integer', minimum: 1, maximum: 5 },
            text: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
    async (request, reply) => {
      const guestToken = readGuestToken(request)
      if (!guestToken) throw new AppError(401, 'unauthorized', 'Нужна ссылка-приглашение')
      const guest = await guestByToken(db(), guestToken)
      const body = request.body as { vendorId: string; stars: number; text?: string }
      const { weddingId } = request.params as { weddingId: string }
      if (guest.weddingId !== weddingId) throw notFound('Свадьба не найдена')

      /* Отзыв гостя — только после свадьбы. До неё он мог бы оценить разве
       * что переписку, а вес у такой оценки тот же, что у настоящей. */
      const { rows: wedding } = await db().query<{ passed: boolean }>(
        `select (w.date is not null and w.date < (now() at time zone coalesce(w.tz, 'Europe/Moscow'))::date) as passed
           from weddings w where w.id = $1`,
        [weddingId],
      )
      if (!wedding[0]?.passed) throw forbidden('Отзыв можно оставить после дня свадьбы')

      // Оценивать можно только тех, кто на этой свадьбе работал.
      const { rows: worked } = await db().query(
        `select 1 from deals d where d.wedding_id = $1 and d.vendor_id = $2
           and d.state in ('booked','paid_deposit','done')`,
        [weddingId, body.vendorId],
      )
      if (worked.length === 0) throw notFound('Этот подрядчик на вашей свадьбе не работал')

      /* Повторная отправка — правка своего же отзыва, а не второй отзыв
       * (так написано в контракте). Уникальный индекс по паре «токен +
       * подрядчик» превращает вставку в обновление. */
      await db().query(
        `insert into reviews (id, vendor_id, wedding_id, source, guest_token, stars, text)
         values ($1,$2,$3,'guest',$4,$5,$6)
         on conflict (guest_token, vendor_id) where guest_token is not null
         do update set stars = excluded.stars, text = excluded.text`,
        [uuidv7(), body.vendorId, weddingId, guestToken, body.stars, body.text ?? null],
      )
      await recomputeRating(db(), body.vendorId)
      return reply.code(201).send({ vendorId: body.vendorId, stars: body.stars })
    },
  )

  /* ── жалобы ───────────────────────────────────────────────────────── */
  app.post(
    '/complaints',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['targetKind', 'targetId', 'category'],
          additionalProperties: false,
          properties: {
            targetKind: { type: 'string', enum: ['vendor', 'review', 'message', 'deal'] },
            targetId: { type: 'string', maxLength: 40 },
            category: { type: 'string', enum: ['fraud', 'content', 'no_show', 'spam'] },
            text: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { targetKind: string; targetId: string; category: string; text?: string }
      if (!isUuid(body.targetId)) throw notFound('Объект жалобы не найден')

      /* Цель жалобы существует, и жаловаться на сделку вправе только её
       * сторона. Без этого очередь модератора принимала мусор по случайным
       * идентификаторам и чужие сделки, к которым жалобщик доступа не имеет
       * (D5-21). Сторона сделки — участник её свадьбы или её подрядчик:
       * «пара не пришла» жалуется подрядчик, «подрядчик пропал» — пара. */
      const targetTable = { vendor: 'vendors', review: 'reviews', message: 'messages', deal: 'deals' }[
        body.targetKind
      ]!
      const { rows: target } = await db().query(`select 1 from ${targetTable} where id = $1`, [body.targetId])
      if (target.length === 0) throw notFound('Объект жалобы не найден')
      if (body.targetKind === 'deal') {
        const { rows: party } = await db().query(
          `select 1 from deals d
            where d.id = $1
              and (exists (select 1 from wedding_members m where m.wedding_id = d.wedding_id and m.user_id = $2)
                   or exists (select 1 from vendors v where v.id = d.vendor_id and v.user_id = $2))`,
          [body.targetId, request.caller!.userId],
        )
        if (party.length === 0) throw forbidden('Жаловаться на сделку может только её сторона')
      }
      /* Жалоба на сообщение — только из чата, который жалобщик видит сам:
       * иначе по идентификатору из чужого уведомления или перебора модератор
       * открывал бы чужую переписку (ревью фиксов, RF-BE-05). Та же матрица,
       * что и доступ к чату: чужой чат — 404, не своя роль — 403. */
      if (body.targetKind === 'message') {
        const { rows: msg } = await db().query<{ chat_id: string }>('select chat_id from messages where id = $1', [
          body.targetId,
        ])
        await chatForUser(db(), msg[0]!.chat_id, request.caller!.userId)
      }

      const res = await db().query(
        `insert into complaints (id, reporter_id, target_kind, target_id, category, text)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (reporter_id, target_kind, target_id) where reporter_id is not null do nothing`,
        [uuidv7(), request.caller!.userId, body.targetKind, body.targetId, body.category, body.text ?? null],
      )
      /* Повтор — то же 201: человек нажал ещё раз, а не подал вторую жалобу.
       * Отказ здесь выглядел бы как «вас не услышали». */
      return reply.code(201).send({ status: 'new', duplicate: res.rowCount === 0 })
    },
  )
}
