import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, unauthorized } from '../errors.js'
import { uuidv7 } from '../ids.js'
import {
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_HOUR,
  RESEND_AFTER_SECONDS,
  TooManyRequests,
  generateCode,
  hashCode,
  maskPhone,
  normalizePhone,
} from '../auth/otp.js'
import { codeMessage } from '../auth/sms.js'
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from '../auth/tokens.js'

interface Tokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: { id: string; name: string | null; phone: string }
}

function clientIp(request: FastifyRequest): string | null {
  return request.ip || null
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const otpSecret = () => {
    const s = app.appConfig.jwtRefreshSecret ?? app.appConfig.jwtAccessSecret
    if (!s) throw new AppError(503, 'not_configured', 'Сервер не настроен: нет секрета для кодов')
    return s
  }

  /** Новая сессия: refresh в базу хешем, наружу — сам токен. */
  async function issueTokens(userId: string, device: string | null): Promise<Tokens> {
    const refreshToken = createRefreshToken()
    const sessionId = uuidv7()
    await db().query(
      `insert into sessions (id, user_id, refresh_hash, device, created_at, last_used_at)
       values ($1, $2, $3, $4, now(), now())`,
      [sessionId, userId, hashRefreshToken(refreshToken), device],
    )
    const accessToken = await signAccessToken(app.appConfig.jwtAccessSecret!, { sub: userId, sid: sessionId })
    const { rows } = await db().query<{ id: string; name: string | null; phone: string }>(
      'select id, name, phone from users where id = $1',
      [userId],
    )
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, user: rows[0]! }
  }

  /* ── запрос кода ──────────────────────────────────────────────────── */
  app.post(
    '/auth/otp',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone'],
          properties: { phone: { type: 'string', minLength: 1, maxLength: 32 } },
        },
      },
    },
    async (request, reply) => {
      const phone = normalizePhone((request.body as { phone: string }).phone)

      const { rows: recent } = await db().query<{ sends: string; last_at: Date | null }>(
        `select count(*)::text as sends, max(created_at) as last_at
           from otp_codes
          where phone = $1 and created_at > now() - interval '1 hour'`,
        [phone],
      )
      const sends = Number(recent[0]?.sends ?? 0)
      const lastAt = recent[0]?.last_at ?? null

      if (lastAt) {
        const passed = Math.floor((Date.now() - lastAt.getTime()) / 1000)
        if (passed < RESEND_AFTER_SECONDS) {
          throw new TooManyRequests(RESEND_AFTER_SECONDS - passed, 'Код уже отправлен. Подождите немного.')
        }
      }
      if (sends >= MAX_SENDS_PER_HOUR) {
        // Ограничение не столько от перебора, сколько от счёта за SMS:
        // без него чужой номер можно заваливать сообщениями за наши деньги.
        throw new TooManyRequests(3600, 'Слишком много запросов кода на этот номер. Попробуйте через час.')
      }

      const code = generateCode()
      await db().query(
        `insert into otp_codes (id, phone, code_hash, expires_at, ip)
         values ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5)`,
        [uuidv7(), phone, hashCode(otpSecret(), phone, code), String(CODE_TTL_SECONDS), clientIp(request)],
      )

      try {
        await app.sms.send(phone, codeMessage(code))
      } catch (error) {
        request.log.error({ err: error, phone: maskPhone(phone) }, 'не удалось отправить код')
        throw new AppError(502, 'sms_failed', 'Не удалось отправить SMS. Попробуйте ещё раз через минуту.')
      }

      // Ответ одинаков и для нового номера, и для известного: иначе перебором
      // выясняется, кто зарегистрирован в сервисе.
      return reply.code(200).send({ expiresIn: CODE_TTL_SECONDS, resendAfter: RESEND_AFTER_SECONDS })
    },
  )

  /* ── проверка кода ────────────────────────────────────────────────── */
  app.post(
    '/auth/otp/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'code'],
          properties: {
            phone: { type: 'string', minLength: 1, maxLength: 32 },
            code: { type: 'string', minLength: 4, maxLength: 8 },
            device: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as { phone: string; code: string; device?: string }
      const phone = normalizePhone(body.phone)

      const { rows } = await db().query<{ id: string; code_hash: string; attempts: number }>(
        `select id, code_hash, attempts
           from otp_codes
          where phone = $1 and consumed_at is null and expires_at > now()
          order by created_at desc
          limit 1`,
        [phone],
      )
      const otp = rows[0]
      if (!otp) throw unauthorized('Код неверный или устарел. Запросите новый.')
      if (otp.attempts >= MAX_ATTEMPTS) throw new TooManyRequests(60, 'Слишком много попыток. Запросите новый код.')

      if (hashCode(otpSecret(), phone, body.code) !== otp.code_hash) {
        await db().query('update otp_codes set attempts = attempts + 1 where id = $1', [otp.id])
        throw unauthorized('Код неверный или устарел. Запросите новый.')
      }

      // Гасим код до выдачи токенов: два одновременных запроса с одним кодом
      // не должны завести две сессии. Условие consumed_at is null делает
      // обновление атомарным — второй запрос не получит ни одной строки.
      const consumed = await db().query('update otp_codes set consumed_at = now() where id = $1 and consumed_at is null', [
        otp.id,
      ])
      if (consumed.rowCount === 0) throw unauthorized('Код уже использован. Запросите новый.')

      // Регистрация и вход — одно и то же действие. Гонку закрывает
      // уникальность телефона в БД, а не проверка «а есть ли уже такой».
      const { rows: userRows } = await db().query<{ id: string }>(
        `insert into users (id, phone) values ($1, $2)
         on conflict (phone) do update set phone = excluded.phone
         returning id`,
        [uuidv7(), phone],
      )
      const userId = userRows[0]!.id
      await db().query('insert into notification_prefs (user_id) values ($1) on conflict do nothing', [userId])
      await db().query(
        `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'auth.login', 'user', $1)`,
        [userId],
      )

      return issueTokens(userId, body.device ?? request.headers['user-agent'] ?? null)
    },
  )

  /* ── обновление токенов ───────────────────────────────────────────── */
  app.post(
    '/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 16, maxLength: 200 } },
        },
      },
    },
    async (request) => {
      const { refreshToken } = request.body as { refreshToken: string }
      const hash = hashRefreshToken(refreshToken)

      const { rows } = await db().query<{
        id: string
        user_id: string
        device: string | null
        revoked_at: Date | null
        created_at: Date
      }>('select id, user_id, device, revoked_at, created_at from sessions where refresh_hash = $1', [hash])
      const session = rows[0]
      if (!session) throw unauthorized('Токен обновления недействителен')

      if (session.revoked_at) {
        // Погашенный refresh предъявлен второй раз. Либо его украли, либо
        // украли новый — в обоих случаях владельца надо вывести отовсюду
        // и заставить войти заново. Это дешевле, чем оставить вора внутри.
        await db().query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [
          session.user_id,
        ])
        await db().query(
          `insert into audit_log (actor_id, action, entity, entity_id)
           values ($1, 'auth.refresh_reuse', 'session', $2)`,
          [session.user_id, session.id],
        )
        throw unauthorized('Токен обновления уже использован. Все сессии завершены — войдите заново.')
      }

      if (Date.now() - session.created_at.getTime() > REFRESH_TTL_SECONDS * 1000) {
        await db().query('update sessions set revoked_at = now() where id = $1', [session.id])
        throw unauthorized('Сессия истекла — войдите заново')
      }

      await db().query('update sessions set revoked_at = now() where id = $1', [session.id])
      return issueTokens(session.user_id, session.device)
    },
  )

  /* ── OAuth ────────────────────────────────────────────────────────── */
  app.get(
    '/auth/oauth/:provider',
    async () => {
      // Не реализовано намеренно, а не забыто: нужны приложения во ВКонтакте,
      // Яндексе, Google и Telegram — их регистрирует владелец. На экране входа
      // во фронте кнопок OAuth сейчас нет вообще, продукт этим путём не ходит.
      throw new AppError(
        501,
        'oauth_not_configured',
        'Вход через соцсети не подключён: нужны приложения провайдеров. Пока вход по коду из SMS.',
      )
    },
  )
}
