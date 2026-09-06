import type { FastifyInstance } from 'fastify'
import { AppError, gone, notFound } from '../errors.js'
import { requireRole, type Role } from '../wedding/access.js'
import { inviteCode, normalizeCode, referralCode } from '../wedding/codes.js'

const INVITE_TTL_DAYS = 7

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const publicUrl = (code: string) => `https://tili-tili.ru/join/${encodeURIComponent(code)}`

  /* ── выдать ссылку ────────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/invites',
    {
      schema: {
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: ['couple', 'helper', 'coordinator', 'vendor'] },
            label: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (request, reply) => {
      requireRole(request, 'couple')
      const weddingId = request.member!.weddingId
      const { role, label } = request.body as { role: Role; label?: string }

      // Коллизия кода почти невозможна, но «почти» на уникальном ключе — это
      // 500 у живого человека. Три попытки закрывают вопрос.
      let code = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        code = inviteCode(role)
        const res = await db().query(
          `insert into invites (code, wedding_id, role, label, created_by, expires_at)
           values ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
           on conflict (code) do nothing`,
          [code, weddingId, role, label ?? null, request.caller!.userId, String(INVITE_TTL_DAYS)],
        )
        if (res.rowCount === 1) break
        code = ''
      }
      if (!code) throw new AppError(503, 'code_collision', 'Не удалось выдать код, попробуйте ещё раз')

      const { rows } = await db().query<{ expires_at: Date }>('select expires_at from invites where code = $1', [code])
      return reply.code(201).send({
        code,
        url: publicUrl(code),
        role,
        label: label ?? null,
        expiresAt: rows[0]!.expires_at.toISOString(),
        used: false,
      })
    },
  )

  /* ── список активных ──────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/invites', async (request) => {
    const { rows } = await db().query<{
      code: string
      role: Role
      label: string | null
      expires_at: Date
      accepted_at: Date | null
    }>(
      `select code, role, label, expires_at, accepted_at from invites
        where wedding_id = $1 and revoked_at is null and expires_at > now()
        order by created_at desc`,
      [request.member!.weddingId],
    )
    // Код — это не «сведения о приглашении», а сам ключ: кто его видит, тот
    // может им воспользоваться. Приглашение с ролью couple в руках помощника
    // означает, что он в один клик становится парой и видит все деньги.
    // Матрица разрешает ему СМОТРЕТЬ список — значит, из списка убран ключ.
    const seesCodes = request.member!.role === 'couple'
    return rows.map((r) => ({
      ...(seesCodes ? { code: r.code, url: publicUrl(r.code) } : {}),
      role: r.role,
      label: r.label,
      expiresAt: r.expires_at.toISOString(),
      used: r.accepted_at !== null,
    }))
  })

  /* ── просмотр приглашения (экран /join/:code) ─────────────────────── */
  app.get('/invites/:code', async (request) => {
    const code = normalizeCode((request.params as { code: string }).code)
    const { rows } = await db().query<{
      code: string
      role: Role
      title: string
      inviter: string | null
      expires_at: Date
      accepted_at: Date | null
      revoked_at: Date | null
    }>(
      `select i.code, i.role, w.title, u.name as inviter, i.expires_at, i.accepted_at, i.revoked_at
         from invites i
         join weddings w on w.id = i.wedding_id
         left join users u on u.id = i.created_by
        where i.code = $1`,
      [code],
    )
    const invite = rows[0]
    // Один и тот же ответ на «нет такого кода», «отозван», «истёк» и «уже
    // использован»: иначе перебором выясняется, какие коды существовали.
    if (!invite || invite.revoked_at || invite.accepted_at || invite.expires_at.getTime() < Date.now()) {
      throw gone('Ссылка недействительна: истекла, отозвана или уже использована')
    }
    return {
      code: invite.code,
      role: invite.role,
      weddingTitle: invite.title,
      inviterName: invite.inviter ?? '',
      expiresAt: invite.expires_at.toISOString(),
    }
  })

  app.delete('/invites/:code', { preHandler: app.requireConsent }, async (request, reply) => {
    const code = normalizeCode((request.params as { code: string }).code)
    // Отозвать может только пара этой свадьбы. Проверка запросом, а не хуком:
    // путь не содержит weddingId, матрица доступа его не покрывает.
    const res = await db().query(
      `update invites i set revoked_at = now()
         where i.code = $1 and i.revoked_at is null
           and exists (select 1 from wedding_members m
                        where m.wedding_id = i.wedding_id and m.user_id = $2 and m.role = 'couple')`,
      [code, request.caller!.userId],
    )
    if (res.rowCount === 0) throw notFound('Приглашение не найдено')
    return reply.code(204).send()
  })

  /* ── принять приглашение ──────────────────────────────────────────── */
  app.post('/invites/:code/accept', { preHandler: app.requireConsent }, async (request) => {
    const code = normalizeCode((request.params as { code: string }).code)
    const userId = request.caller!.userId

    /* Гашение кода и вступление в команду — одна транзакция (R-122).
     * Код одноразовый: погашенный без записи в `wedding_members` — это
     * человек, которого приглашение уже не пустит, а второго кода у него
     * нет. До 2026-09-06 шаги шли тремя отдельными запросами. */
    return db().tx(async (client) => {
      // Одноразовость держится условием `accepted_at is null` прямо в UPDATE:
      // два одновременных перехода по ссылке иначе добавили бы в команду двоих.
      const claimed = await client.query<{ wedding_id: string; role: Role }>(
        `update invites set accepted_by = $2, accepted_at = now()
          where code = $1 and accepted_at is null and revoked_at is null and expires_at > now()
          returning wedding_id, role`,
        [code, userId],
      )
      const invite = claimed.rows[0]
      if (!invite) throw gone('Ссылка недействительна: истекла, отозвана или уже использована')

      const inserted = await client.query<{ role: Role; joined_at: Date }>(
        `insert into wedding_members (wedding_id, user_id, role) values ($1, $2, $3)
         on conflict (wedding_id, user_id) do nothing
         returning role, joined_at`,
        [invite.wedding_id, userId, invite.role],
      )
      if (inserted.rowCount === 0) {
        // Уже в команде — код всё равно погашен. Возвращаем текущее членство,
        // а не ошибку: для человека переход по ссылке сработал.
        const { rows } = await client.query<{ role: Role; joined_at: Date }>(
          'select role, joined_at from wedding_members where wedding_id = $1 and user_id = $2',
          [invite.wedding_id, userId],
        )
        const existing = rows[0]!
        return member(userId, existing.role, existing.joined_at)
      }

      await client.query(
        `insert into audit_log (actor_id, action, entity, entity_id, diff)
         values ($1, 'invite.accepted', 'wedding', $2, $3)`,
        [userId, invite.wedding_id, JSON.stringify({ role: invite.role })],
      )
      return member(userId, inserted.rows[0]!.role, inserted.rows[0]!.joined_at)
    })
  })

  async function member(userId: string, role: Role, joinedAt: Date) {
    const { rows } = await db().query<{ name: string | null }>('select name from users where id = $1', [userId])
    return { user: { id: userId, name: rows[0]?.name ?? '' }, role, joinedAt: joinedAt.toISOString() }
  }

  /* ── реферальная программа ────────────────────────────────────────── */
  app.get('/users/me/referral', { preHandler: app.requireConsent }, async (request) => {
    const userId = request.caller!.userId
    const { rows: existing } = await db().query<{ code: string }>('select code from referrals where owner_id = $1', [
      userId,
    ])

    let code = existing[0]?.code
    if (!code) {
      const { rows: user } = await db().query<{ name: string | null }>('select name from users where id = $1', [userId])
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = referralCode(user[0]?.name ?? null, attempt)
        const res = await db().query(
          'insert into referrals (code, owner_id) values ($1, $2) on conflict do nothing',
          [candidate, userId],
        )
        if (res.rowCount === 1) {
          code = candidate
          break
        }
      }
      if (!code) throw new AppError(503, 'code_collision', 'Не удалось выдать реферальный код')
    }

    const { rows: stats } = await db().query<{ invited: string; earned: string }>(
      `select count(*)::text as invited, coalesce(sum(earned), 0)::text as earned
         from referral_uses where code = $1`,
      [code],
    )
    return {
      code,
      invited: Number(stats[0]!.invited),
      earned: { amount: Number(stats[0]!.earned), currency: 'RUB' },
    }
  })

  app.post('/referral/:code/apply', { preHandler: app.requireConsent }, async (request) => {
    const code = normalizeCode((request.params as { code: string }).code)
    const userId = request.caller!.userId

    const { rows } = await db().query<{ owner_id: string }>('select owner_id from referrals where code = $1', [code])
    const owner = rows[0]
    if (!owner) throw notFound('Такого кода не существует')
    if (owner.owner_id === userId) {
      throw new AppError(409, 'own_code', 'Свой код применить нельзя')
    }

    // «Один раз на аккаунт» — первичный ключ, а не проверка перед вставкой:
    // два одновременных запроса иначе начислили бы бонус дважды.
    const res = await db().query(
      'insert into referral_uses (invited_id, code) values ($1, $2) on conflict (invited_id) do nothing',
      [userId, code],
    )
    if (res.rowCount === 0) throw new AppError(409, 'referral_used', 'Реферальный код уже применён')

    // Начисление идёт после первой сделки приглашённой пары (§3.15) —
    // это этап 4. Здесь только фиксируется, кто кого привёл.
    await db().query(
      `insert into audit_log (actor_id, action, entity, entity_id, diff)
       values ($1, 'referral.applied', 'user', $1, $2)`,
      [userId, JSON.stringify({ code })],
    )
    return { ok: true }
  })
}
