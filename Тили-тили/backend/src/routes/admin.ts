import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, forbidden, notFound } from '../errors.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { VENDOR_COLUMNS, toVendor, type VendorRow } from '../catalog/vendors.js'
import { recomputeRating } from '../reviews/rating.js'
import { notify } from '../notify/notify.js'

/**
 * Админка платформы.
 *
 * Сотрудник — признак `users.is_staff`, и пути, который его выдаёт, нет:
 * «сделай меня админом» — это повышение прав в один запрос, сколько его
 * ни защищай. Признак ставится руками в базе при найме.
 *
 * Каждое обращение к чужому проекту пишется в журнал аудита вместе
 * с причиной (План §19.10 п. 5): поддержка смотрит по обращению пары,
 * а не из любопытства, и это должно быть проверяемо.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  async function requireStaff(request: FastifyRequest): Promise<string> {
    const userId = request.caller!.userId
    const { rows } = await db().query<{ is_staff: boolean }>(
      'select is_staff from users where id = $1 and deleted_at is null',
      [userId],
    )
    // 404 сказал бы, что пути нет, и это была бы неправда; 403 честно
    // говорит «есть, но не для вас» — админка не секрет, доступ к ней секрет.
    if (!rows[0]?.is_staff) throw forbidden('Раздел для сотрудников платформы')
    return userId
  }

  async function audit(actorId: string, action: string, entity: string, entityId: string, diff: unknown) {
    await db().query('insert into audit_log (actor_id, action, entity, entity_id, diff) values ($1,$2,$3,$4,$5)', [
      actorId,
      action,
      entity,
      entityId,
      JSON.stringify(diff),
    ])
  }

  /* ── очередь анкет ────────────────────────────────────────────────── */
  app.get('/admin/moderation/vendors', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    /* Анкеты публикуются сразу, модератор смотрит их потом (§19.2).
     * Очередь — непроверенные, старейшие сверху: SLA считается от подачи. */
    const { rows } = await db().query<VendorRow & { created_at: Date }>(
      `select ${VENDOR_COLUMNS}
         from vendors v join users u on u.id = v.user_id and u.deleted_at is null
         left join cities c on c.id = v.city_id
        where v.moderated_at is null and v.published_at is not null
          and ($1::text is null or (v.created_at, v.id) > ($1::timestamptz, $2::uuid))
        order by v.created_at asc, v.id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    return buildPage(
      rows.map((r) => ({ ...toVendor(r), createdAt: r.created_at.toISOString() })),
      page.limit,
      (v) => encodeCursor(v.createdAt, v.id),
    )
  })

  app.post(
    '/admin/moderation/vendors/:vendorId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['approve', 'reject', 'verify'] },
            reason: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { vendorId } = request.params as { vendorId: string }
      if (!/^[0-9a-f-]{36}$/i.test(vendorId)) throw notFound('Анкета не найдена')
      const body = request.body as { action: 'approve' | 'reject' | 'verify'; reason?: string }

      const sets = {
        // Проверена и остаётся в выдаче.
        approve: 'moderated_at = now()',
        // Снята с публикации: анкета не удаляется — мастер её поправит.
        reject: 'moderated_at = now(), published_at = null',
        // Галочка «проверен». Документы при этом наружу не выходят.
        verify: 'moderated_at = now(), verified_at = now()',
      }[body.action]

      const res = await db().query(`update vendors set ${sets} where id = $1`, [vendorId])
      if (res.rowCount === 0) throw notFound('Анкета не найдена')

      if (body.action === 'verify') {
        await db().query(
          "update vendor_verifications set status = 'approved', checked_at = now() where vendor_id = $1 and status = 'pending'",
          [vendorId],
        )
      }
      if (body.action === 'reject') {
        await db().query(
          "update vendor_verifications set status = 'rejected', checked_at = now() where vendor_id = $1 and status = 'pending'",
          [vendorId],
        )
      }

      await audit(staffId, `vendor.${body.action}`, 'vendor', vendorId, { reason: body.reason ?? null })

      const { rows: owner } = await db().query<{ user_id: string }>('select user_id from vendors where id = $1', [
        vendorId,
      ])
      if (owner[0]) {
        await notify(db(), {
          userId: owner[0].user_id,
          kind: 'system',
          title: { approve: 'Анкета проверена', reject: 'Анкета снята с публикации', verify: 'Вы проверены' }[
            body.action
          ],
          body: body.reason ?? 'Решение модератора',
          link: '/vendor-app',
          // Снятие с публикации — потеря дохода: ждать утра тут нельзя.
          critical: body.action === 'reject',
        })
      }
      return { vendorId, action: body.action }
    },
  )

  /* ── очередь жалоб ────────────────────────────────────────────────── */
  app.get('/admin/complaints', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    const { rows } = await db().query<{
      id: string
      target_kind: string
      target_id: string
      category: string
      text: string | null
      status: string
      created_at: Date
    }>(
      `select id, target_kind, target_id, category, text, status, created_at
         from complaints
        where status = 'new'
          and ($1::text is null or (created_at, id) > ($1::timestamptz, $2::uuid))
        order by created_at asc, id asc
        limit $3`,
      [page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )
    return buildPage(
      rows.map((r) => ({
        id: r.id,
        targetKind: r.target_kind,
        targetId: r.target_id,
        category: r.category,
        text: r.text ?? '',
        status: r.status,
        createdAt: r.created_at.toISOString(),
      })),
      page.limit,
      (c) => encodeCursor(c.createdAt, c.id),
    )
  })

  app.post(
    '/admin/complaints/:complaintId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['dismiss', 'warn', 'downrank', 'block'] },
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { complaintId } = request.params as { complaintId: string }
      if (!/^[0-9a-f-]{36}$/i.test(complaintId)) throw notFound('Жалоба не найдена')
      const body = request.body as { action: 'dismiss' | 'warn' | 'downrank' | 'block'; note?: string }

      const { rows } = await db().query<{ target_kind: string; target_id: string }>(
        `update complaints set status = 'resolved', resolution = $2, note = $3, resolved_at = now()
          where id = $1 and status = 'new'
          returning target_kind, target_id`,
        [complaintId, body.action, body.note ?? null],
      )
      // Повторное решение по разобранной жалобе — не ошибка данных,
      // а гонка двух модераторов: второй должен увидеть, что уже поздно.
      if (rows.length === 0) throw notFound('Жалоба не найдена или уже разобрана')
      const target = rows[0]!

      /* Санкции по возрастанию (§18.2). Предупреждение остаётся в журнале:
       * оно ничего не меняет в выдаче, но следующая жалоба приходит уже
       * не на чистого подрядчика. */
      if (target.target_kind === 'vendor' && body.action === 'downrank') {
        await db().query('update vendors set downranked_at = now() where id = $1', [target.target_id])
      }
      if (target.target_kind === 'vendor' && body.action === 'block') {
        await db().query('update vendors set blocked_at = now() where id = $1', [target.target_id])
      }
      if (target.target_kind === 'review' && (body.action === 'block' || body.action === 'downrank')) {
        // Скрытый отзыв уходит и из показа, и из рейтинга: наказывать
        // подрядчика звёздами за текст, признанный недопустимым, нельзя.
        const { rows: hidden } = await db().query<{ vendor_id: string }>(
          'update reviews set hidden_at = now(), moderated_at = now() where id = $1 returning vendor_id',
          [target.target_id],
        )
        if (hidden[0]) await recomputeRating(db(), hidden[0].vendor_id)
      }

      await audit(staffId, `complaint.${body.action}`, target.target_kind, target.target_id, {
        complaintId,
        note: body.note ?? null,
      })
      return { complaintId, action: body.action }
    },
  )

  /* ── категории и синонимы ─────────────────────────────────────────── */
  app.put(
    '/admin/categories',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            categories: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                required: ['id', 'title'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string', maxLength: 40 },
                  title: { type: 'string', minLength: 1, maxLength: 100 },
                  icon: { type: 'string', maxLength: 16 },
                  sort: { type: 'integer' },
                },
              },
            },
            synonyms: { type: 'object' },
          },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const body = request.body as {
        categories?: { id: string; title: string; icon?: string; sort?: number }[]
        synonyms?: Record<string, string>
      }

      await db().tx(async (client) => {
        for (const c of body.categories ?? []) {
          /* Категории правятся, но не удаляются: на них ссылаются анкеты
           * и слоты. Исчезнувшая категория — это осиротевшая мозаика. */
          await client.query(
            // В базе колонка называется `name`, в контракте — `title`.
            // Переименовывать нечего: справочник читают миграции и фронт.
            `insert into categories (id, name, icon, sort) values ($1,$2,$3,$4)
             on conflict (id) do update set name = excluded.name,
                                            icon = coalesce(excluded.icon, categories.icon),
                                            sort = coalesce(excluded.sort, categories.sort)`,
            [c.id, c.title, c.icon ?? null, c.sort ?? 0],
          )
        }
        if (body.synonyms) {
          await client.query('delete from category_synonyms')
          for (const [word, categoryId] of Object.entries(body.synonyms)) {
            await client.query('insert into category_synonyms (word, category_id) values ($1,$2)', [
              word.toLowerCase(),
              categoryId,
            ])
          }
        }
      })
      await audit(staffId, 'categories.update', 'categories', '00000000-0000-0000-0000-000000000000', {
        categories: body.categories?.length ?? 0,
        synonyms: Object.keys(body.synonyms ?? {}).length,
      })
      return { categories: body.categories?.length ?? 0, synonyms: Object.keys(body.synonyms ?? {}).length }
    },
  )

  /* ── метрики платформы ────────────────────────────────────────────── */
  app.get('/admin/metrics', { preHandler: app.requireConsent }, async (request) => {
    await requireStaff(request)
    const { rows } = await db().query<Record<string, string>>(
      `select
         (select count(*) from users where deleted_at is null)::text as users,
         (select count(*) from weddings where archived_at is null)::text as weddings,
         (select count(*) from vendors v join users u on u.id = v.user_id and u.deleted_at is null
           where v.published_at is not null and v.blocked_at is null)::text as vendors_published,
         (select count(*) from vendors where moderated_at is null and published_at is not null)::text as moderation_queue,
         (select count(*) from complaints where status = 'new')::text as complaints_open,
         (select count(*) from complaints
           where status = 'new' and created_at < now() - interval '24 hours')::text as complaints_overdue,
         (select count(*) from deals where state in ('booked','paid_deposit','done'))::text as deals,
         (select coalesce(sum(price), 0) from deals where state in ('booked','paid_deposit','done'))::text as gmv`,
    )
    const m = rows[0]!

    /* Готовность города к запуску: план считает город готовым от 50 анкет.
     * Список выводится сразу с числом — «готов» без числа нечем оспорить. */
    const { rows: cities } = await db().query<{ city: string; vendors: string }>(
      `select c.name as city, count(*)::text as vendors
         from vendors v join users u on u.id = v.user_id and u.deleted_at is null
         join cities c on c.id = v.city_id
        where v.published_at is not null and v.blocked_at is null
        group by c.name order by count(*) desc limit 20`,
    )

    return {
      users: Number(m.users),
      weddings: Number(m.weddings),
      vendorsPublished: Number(m.vendors_published),
      moderationQueue: Number(m.moderation_queue),
      complaintsOpen: Number(m.complaints_open),
      // SLA модерации — 24 часа (§18.2). Без счётчика просроченных срок
      // существует только на бумаге: нарушение ничем не видно.
      complaintsOverdue: Number(m.complaints_overdue),
      deals: Number(m.deals),
      gmv: { amount: Number(m.gmv), currency: 'RUB' },
      cities: cities.map((c) => ({ city: c.city, vendors: Number(c.vendors), launchReady: Number(c.vendors) >= 50 })),
    }
  })

  /* ── просмотр проекта поддержкой ──────────────────────────────────── */
  app.get(
    '/admin/weddings/:weddingId',
    {
      preHandler: app.requireConsent,
      schema: {
        querystring: {
          type: 'object',
          required: ['reason'],
          additionalProperties: false,
          // Причина обязательна и непустая: «смотрел по обращению» должно
          // быть проверяемо, а пустая строка ничего не подтверждает.
          properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const staffId = await requireStaff(request)
      const { weddingId } = request.params as { weddingId: string }
      if (!/^[0-9a-f-]{36}$/i.test(weddingId)) throw notFound('Свадьба не найдена')
      const { reason } = request.query as { reason: string }

      const { rows } = await db().query<{
        id: string
        title: string
        date: string | null
        city: string | null
        style: string | null
        guests_planned: number | null
        created_at: Date
      }>(
        `select w.id, w.title, w.date::text as date, c.name as city, w.style, w.guests_planned, w.created_at
           from weddings w left join cities c on c.id = w.city_id where w.id = $1`,
        [weddingId],
      )
      if (rows.length === 0) throw notFound('Свадьба не найдена')

      // Запись в журнал ДО ответа: иначе просмотр, оборвавшийся на отдаче,
      // остался бы незамеченным.
      await audit(staffId, 'wedding.view', 'wedding', weddingId, { reason })

      /* Только чтение и только карточка. Ни гостей, ни переписки, ни сумм:
       * поддержке для разбора обращения этого достаточно, а лишнее здесь —
       * это чужая свадьба целиком. */
      const w = rows[0]!
      return {
        id: w.id,
        title: w.title,
        date: w.date,
        city: w.city,
        style: w.style,
        guestsPlanned: w.guests_planned,
        createdAt: w.created_at.toISOString(),
      }
    },
  )
}
