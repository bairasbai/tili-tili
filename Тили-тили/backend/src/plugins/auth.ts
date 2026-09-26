import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import { AppError, forbidden, unauthorized } from '../errors.js'
import { verifyAccessToken, type AccessClaims } from '../auth/tokens.js'
import { createSender, type SmsSender } from '../auth/sms.js'
import { consentState } from '../auth/consent.js'

export interface Caller {
  userId: string
  sessionId: string
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Есть действующий access-токен. Без согласия на ПДн — тоже проходит. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    /** То же плюс действующее согласие (F4, RL-1). Ставится на всё, кроме входа, согласия
     * и allow-list выхода — сессии и отписка от push работают и при устаревшем согласии. */
    requireConsent: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    /** Те же проверки для живого канала: у WebSocket нет ни заголовков, ни reply. */
    authorizeToken: (token: string) => Promise<AccessClaims>
    sms: SmsSender
    appConfig: Config
  }
  interface FastifyRequest {
    caller?: Caller
  }
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) throw unauthorized('Нужен заголовок Authorization: Bearer')
  return header.slice('Bearer '.length).trim()
}

export async function registerAuth(app: FastifyInstance, config: Config): Promise<void> {
  app.decorate('appConfig', config)
  app.decorate(
    'sms',
    createSender(
      {
        provider: config.smsProvider,
        smsAeroEmail: config.smsAeroEmail,
        smsAeroKey: config.smsAeroKey,
        smsAeroSign: config.smsAeroSign,
      },
      config.env,
      app.log,
    ),
  )

  const secret = config.jwtAccessSecret
  // В разработке секрета может не быть — тогда защищённые пути честно отвечают
  // 401 вместо того, чтобы пускать всех. В production конфигурация его требует.
  /**
   * Живая сессия: не отозвана, аккаунт не удалён.
   *
   * Проверяется по базе, а не по токену: иначе «выход со всех устройств»
   * ничего не даёт до истечения access-токена, а это 15 минут чужого
   * доступа после кражи.
   */
  const assertLiveSession = async (claims: AccessClaims): Promise<void> => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    const { rows } = await app.db.query<{ user_id: string; deleted_at: Date | null }>(
      `select s.user_id, u.deleted_at
         from sessions s join users u on u.id = s.user_id
        where s.id = $1 and s.revoked_at is null`,
      [claims.sid],
    )
    const row = rows[0]
    if (!row || row.user_id !== claims.sub) throw unauthorized('Сессия завершена')
    if (row.deleted_at) throw unauthorized('Аккаунт удалён')
  }

  const assertConsent = async (userId: string): Promise<void> => {
    const state = await consentState(app.db!, userId, config.policyVersion)
    if (state === 'none') {
      // 403, а не 401: человек вошёл, но не дал согласия. 401 отправил бы его
      // на повторный вход по кругу — код он получит, а дальше опять 401.
      throw forbidden('Нужно согласие на обработку персональных данных')
    }
    if (state === 'outdated') {
      // Согласие есть, но не под действующей редакцией (F4, RL-1): отдельный
      // код — фронт включает гейт повторного согласия, а не «войдите снова».
      throw new AppError(403, 'consent_outdated', 'Мы обновили документы — подтвердите новую редакцию, чтобы продолжить')
    }
  }

  const requireAuth = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!secret) throw unauthorized('Сервер не настроен для проверки токенов')
    const claims = await verifyAccessToken(secret, bearer(request))
    await assertLiveSession(claims)
    request.caller = { userId: claims.sub, sessionId: claims.sid }
  }

  const requireConsent = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(request, reply)
    await assertConsent(request.caller!.userId)
  }

  /**
   * То же самое для живого канала: у WebSocket нет ни заголовков, ни reply,
   * но проверки обязаны быть теми же. Отдельная копия проверок разошлась бы
   * с основной на первой же правке.
   */
  const authorizeToken = async (token: string): Promise<AccessClaims> => {
    if (!secret) throw unauthorized('Сервер не настроен для проверки токенов')
    const claims = await verifyAccessToken(secret, token)
    await assertLiveSession(claims)
    await assertConsent(claims.sub)
    return claims
  }

  app.decorate('requireAuth', requireAuth)
  app.decorate('requireConsent', requireConsent)
  app.decorate('authorizeToken', authorizeToken)
}
