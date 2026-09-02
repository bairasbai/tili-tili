import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'

interface ProfileRow {
  id: string
  name: string | null
  phone: string
  email: string | null
  lang: string
  tz: string | null
  tasks: boolean
  chats: boolean
  deals: boolean
  tips: boolean
  quiet_from: string
  quiet_to: string
}

/** `22:00:00` из PostgreSQL → `22:00`, как в контракте. */
const hhmm = (t: string) => t.slice(0, 5)

function toProfile(r: ProfileRow) {
  return {
    id: r.id,
    name: r.name ?? '',
    phone: r.phone,
    email: r.email,
    lang: r.lang.trim(),
    tz: r.tz ?? '',
    push: { tasks: r.tasks, chats: r.chats, deals: r.deals, tips: r.tips },
    quietHours: { from: hhmm(r.quiet_from), to: hhmm(r.quiet_to) },
  }
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const loadProfile = async (userId: string) => {
    const { rows } = await db().query<ProfileRow>(
      `select u.id, u.name, u.phone, u.email, u.lang, u.tz,
              coalesce(p.tasks, true) as tasks, coalesce(p.chats, true) as chats,
              coalesce(p.deals, true) as deals, coalesce(p.tips, true) as tips,
              coalesce(p.quiet_from, '22:00')::text as quiet_from,
              coalesce(p.quiet_to, '09:00')::text as quiet_to
         from users u left join notification_prefs p on p.user_id = u.id
        where u.id = $1 and u.deleted_at is null`,
      [userId],
    )
    if (!rows[0]) throw notFound('Пользователь не найден')
    return toProfile(rows[0])
  }

  /* ── согласие на обработку ПДн ────────────────────────────────────── */
  app.post(
    '/users/me/consent',
    {
      // Согласие — единственный защищённый путь без проверки согласия:
      // иначе дать его было бы невозможно.
      preHandler: app.requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['policyVersion'],
          properties: { policyVersion: { type: 'string', minLength: 1, maxLength: 40 } },
        },
      },
    },
    async (request, reply) => {
      const { policyVersion } = request.body as { policyVersion: string }
      if (policyVersion !== app.appConfig.policyVersion) {
        // Иначе в базе окажется подпись под редакцией, которой человек не видел.
        throw new AppError(
          409,
          'policy_version_stale',
          `Текст обновился. Перечитайте и подтвердите редакцию ${app.appConfig.policyVersion}.`,
        )
      }
      await db().query(
        'insert into consents (id, user_id, policy_version, ip) values ($1, $2, $3, $4)',
        [uuidv7(), request.caller!.userId, policyVersion, request.ip || null],
      )
      await db().query(
        `insert into audit_log (actor_id, action, entity, entity_id, diff)
         values ($1, 'consent.given', 'user', $1, $2)`,
        [request.caller!.userId, JSON.stringify({ policyVersion })],
      )
      return reply.code(201).send()
    },
  )

  app.delete('/users/me/consent', { preHandler: app.requireAuth }, async (request, reply) => {
    // Отзыв согласия равносилен удалению аккаунта: без согласия обрабатывать
    // данные нельзя, а без данных сервис не работает.
    const userId = request.caller!.userId
    await db().query('update consents set withdrawn_at = now() where user_id = $1 and withdrawn_at is null', [userId])
    await db().query('update users set deleted_at = now() where id = $1 and deleted_at is null', [userId])
    await db().query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId])
    await db().query(
      `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'consent.withdrawn', 'user', $1)`,
      [userId],
    )
    return reply.code(204).send()
  })

  /* ── профиль ──────────────────────────────────────────────────────── */
  app.get('/users/me', { preHandler: app.requireConsent }, async (request) => loadProfile(request.caller!.userId))

  app.patch(
    '/users/me',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 120 },
            lang: { type: 'string', enum: ['ru', 'en'] },
            tz: { type: 'string', maxLength: 64 },
            push: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tasks: { type: 'boolean' },
                chats: { type: 'boolean' },
                deals: { type: 'boolean' },
                tips: { type: 'boolean' },
              },
            },
            quietHours: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', pattern: '^[0-2][0-9]:[0-5][0-9]$' },
                to: { type: 'string', pattern: '^[0-2][0-9]:[0-5][0-9]$' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const userId = request.caller!.userId
      const body = request.body as {
        name?: string
        lang?: string
        tz?: string
        push?: Partial<Record<'tasks' | 'chats' | 'deals' | 'tips', boolean>>
        quietHours?: { from?: string; to?: string }
      }

      // coalesce, а не сборка SQL строками: пропущенное поле остаётся как было,
      // явный null стирает значение (правило R-17 — очистка это null, не пропуск).
      await db().query(
        `update users set name = coalesce($2, name), lang = coalesce($3, lang), tz = coalesce($4, tz)
          where id = $1 and deleted_at is null`,
        [userId, body.name ?? null, body.lang ?? null, body.tz ?? null],
      )

      if (body.push || body.quietHours) {
        await db().query(
          `insert into notification_prefs (user_id) values ($1) on conflict (user_id) do nothing`,
          [userId],
        )
        await db().query(
          `update notification_prefs
              set tasks = coalesce($2, tasks), chats = coalesce($3, chats),
                  deals = coalesce($4, deals), tips = coalesce($5, tips),
                  quiet_from = coalesce($6::time, quiet_from), quiet_to = coalesce($7::time, quiet_to)
            where user_id = $1`,
          [
            userId,
            body.push?.tasks ?? null,
            body.push?.chats ?? null,
            body.push?.deals ?? null,
            body.push?.tips ?? null,
            body.quietHours?.from ?? null,
            body.quietHours?.to ?? null,
          ],
        )
      }

      return loadProfile(userId)
    },
  )

  app.delete('/users/me', { preHandler: app.requireConsent }, async (request, reply) => {
    const userId = request.caller!.userId
    // Мягкое удаление на 30 дней (План §19.1): человек передумывает чаще,
    // чем кажется, а восстановить стёртую свадьбу неоткуда.
    await db().query('update users set deleted_at = now() where id = $1 and deleted_at is null', [userId])
    await db().query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId])
    await db().query(
      `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'user.deleted', 'user', $1)`,
      [userId],
    )
    return reply.code(204).send()
  })

  /* ── сессии и устройства ──────────────────────────────────────────── */
  app.get('/users/me/sessions', { preHandler: app.requireConsent }, async (request) => {
    const { rows } = await db().query<{ id: string; device: string | null; created_at: Date }>(
      `select id, device, created_at from sessions
        where user_id = $1 and revoked_at is null order by created_at desc`,
      [request.caller!.userId],
    )
    return rows.map((r) => ({
      id: r.id,
      device: r.device ?? 'Неизвестное устройство',
      current: r.id === request.caller!.sessionId,
      createdAt: r.created_at.toISOString(),
    }))
  })

  app.delete('/users/me/sessions', { preHandler: app.requireConsent }, async (request, reply) => {
    // Текущая сессия остаётся: человек нажимает «выйти везде», чтобы выгнать
    // чужого, а не себя. Выгнать себя — это кнопка «выйти».
    await db().query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [
      request.caller!.userId,
      request.caller!.sessionId,
    ])
    return reply.code(204).send()
  })

  app.delete(
    '/users/me/sessions/:sessionId',
    { preHandler: app.requireConsent },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string }
      // Условие по user_id обязательно: без него по чужому идентификатору
      // сессии можно выкинуть постороннего человека.
      const res = await db().query('update sessions set revoked_at = now() where id = $1 and user_id = $2', [
        sessionId,
        request.caller!.userId,
      ])
      if (res.rowCount === 0) throw notFound('Сессия не найдена')
      return reply.code(204).send()
    },
  )

  /* ── экспорт данных (152-ФЗ) ──────────────────────────────────────── */
  app.get('/users/me/export', { preHandler: app.requireConsent }, async (request) => {
    const userId = request.caller!.userId
    const profile = await loadProfile(userId)
    const { rows: consents } = await db().query(
      'select policy_version, given_at, withdrawn_at from consents where user_id = $1 order by given_at',
      [userId],
    )
    const { rows: sessions } = await db().query(
      'select device, created_at, revoked_at from sessions where user_id = $1 order by created_at',
      [userId],
    )
    return {
      exportedAt: new Date().toISOString(),
      profile,
      consents,
      sessions,
      // Свадьбы, гости, сделки добавятся по мере появления — этап 2 и дальше.
    }
  })
}
