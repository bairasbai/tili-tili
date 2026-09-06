import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, TooManyRequests, unauthorized } from '../errors.js'
import { uuidv7 } from '../ids.js'
import {
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_HOUR,
  RESEND_AFTER_SECONDS,
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

/**
 * Сколько после обмена прежний refresh считается «второй вкладкой», а не
 * кражей. Вкладки одного браузера расходятся на миллисекунды; десяти секунд
 * хватает с запасом, а вору за это окно достаётся только 401.
 */
export const REFRESH_GRACE_MS = 10_000

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

  /** Новая сессия — новое устройство. Обновление токена сессию не заводит. */
  async function issueTokens(userId: string, device: string | null): Promise<Tokens> {
    const refreshToken = createRefreshToken()
    const sessionId = uuidv7()
    await db().query(
      `insert into sessions (id, user_id, refresh_hash, device, created_at, last_used_at)
       values ($1, $2, $3, $4, now(), now())`,
      [sessionId, userId, hashRefreshToken(refreshToken), device],
    )
    return withUser(userId, sessionId, refreshToken)
  }

  /**
   * Обновление токенов внутри существующей сессии: строка та же, меняется
   * только хеш. Прежний сохраняется — по нему ловится повторное предъявление
   * украденного токена.
   */
  async function rotateTokens(userId: string, sessionId: string, oldHash: string): Promise<Tokens> {
    const refreshToken = createRefreshToken()
    await db().query(
      `update sessions
          set refresh_hash = $2, prev_refresh_hash = $3, rotated_at = now(), last_used_at = now()
        where id = $1`,
      [sessionId, hashRefreshToken(refreshToken), oldHash],
    )
    return withUser(userId, sessionId, refreshToken)
  }

  async function withUser(userId: string, sessionId: string, refreshToken: string): Promise<Tokens> {
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

      // Коды старше часа не нужны ни для проверки, ни для ограничения частоты,
      // а номер телефона — персональные данные: хранить их дольше нельзя.
      // Уборка здесь, а не в кроне: таблица растёт только от этого запроса.
      await db().query("delete from otp_codes where created_at < now() - interval '1 hour'")

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

      // Потолок на все отправки: лимиты на номер и на адрес обходятся списком
      // номеров и ботнетом, а счёт за SMS приходит нам. Срабатывание — авария,
      // а не обычный отказ: в норме до него не доходит.
      const { rows: total } = await db().query<{ sends: string }>(
        `select count(*)::text as sends from otp_codes where created_at > now() - interval '1 hour'`,
      )
      if (Number(total[0]?.sends ?? 0) >= app.appConfig.otpMaxPerHourTotal) {
        request.log.error(
          { sends: Number(total[0]!.sends), limit: app.appConfig.otpMaxPerHourTotal },
          'достигнут часовой потолок отправки кодов — похоже на перебор номеров',
        )
        throw new TooManyRequests(3600, 'Сервис временно не отправляет коды. Попробуйте позже.')
      }

      const ip = clientIp(request)
      if (ip) {
        // Лимит на номер не мешает перебирать номера: по одному коду на тысячу
        // чужих телефонов. Платим мы, а сообщения получают незнакомые люди.
        const { rows: byIp } = await db().query<{ sends: string }>(
          `select count(*)::text as sends from otp_codes
            where ip = $1 and created_at > now() - interval '1 hour'`,
          [ip],
        )
        if (Number(byIp[0]?.sends ?? 0) >= app.appConfig.otpMaxPerIpHour) {
          throw new TooManyRequests(3600, 'Слишком много запросов кода. Попробуйте через час.')
        }
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
        last_used_at: Date
        rotated_at: Date | null
        current: boolean
      }>(
        `select id, user_id, device, revoked_at, last_used_at, rotated_at, (refresh_hash = $1) as current
           from sessions where refresh_hash = $1 or prev_refresh_hash = $1`,
        [hash],
      )
      const session = rows[0]
      if (!session) throw unauthorized('Токен обновления недействителен')

      if (!session.current && session.rotated_at && Date.now() - session.rotated_at.getTime() < REFRESH_GRACE_MS) {
        /* Прежний refresh предъявлен через секунды после обмена — это не
         * вор, а вторая вкладка того же браузера: обе проснулись с одним
         * истёкшим access и обе пошли обновляться, вторая — уже со старым
         * токеном. До 2026-09-06 это считалось кражей и гасило ВСЕ сессии
         * человека за то, что у него открыты две вкладки. Ей отвечаем
         * «уже обменян» без гашения: свежая пара у первой вкладки жива,
         * а хранилище у них общее. Окно короткое: вор со старым токеном
         * внутри него получает ровно то же — ничего. */
        throw new AppError(401, 'refresh_superseded', 'Токен обновления уже обменян — возьмите новый из хранилища')
      }

      if (!session.current) {
        // Предъявлен предыдущий refresh этой сессии. Настоящий владелец так
        // не делает: его клиент уже получил новый. Значит, токен украли —
        // и неизвестно, у кого сейчас свежий. Выводим отовсюду.
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

      // 30 дней бездействия, а не 30 дней с первого входа: created_at теперь
      // хранит настоящее время входа и показывается на экране устройств.
      if (Date.now() - session.last_used_at.getTime() > REFRESH_TTL_SECONDS * 1000) {
        await db().query('update sessions set revoked_at = now() where id = $1', [session.id])
        throw unauthorized('Сессия истекла — войдите заново')
      }

      return rotateTokens(session.user_id, session.id, hash)
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
