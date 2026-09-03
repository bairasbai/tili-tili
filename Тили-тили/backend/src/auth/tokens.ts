import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import { AppError, unauthorized } from '../errors.js'

/**
 * Access-токен короткий (15 минут) и не проверяется по базе — иначе каждый
 * запрос стоил бы обращения к PostgreSQL. Цена — отозванная сессия живёт
 * до истечения access. Refresh, наоборот, длинный (30 дней), хранится хешем
 * и одноразовый: при обмене старый гасится.
 */
export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

export interface AccessClaims {
  sub: string
  sid: string
  /** Момент истечения, секунды эпохи. Живому соединению он нужен, чтобы
   *  закрыться вовремя: иначе оно переживёт срок действия токена. */
  exp: number
}

const enc = new TextEncoder()

export function accessKey(secret: string): Uint8Array {
  return enc.encode(secret)
}

export async function signAccessToken(
  secret: string,
  // Срок ставит подписывающий, а не вызывающий: `exp` — свойство выданного
  // токена, а не пожелание того, кто его просит.
  claims: Omit<AccessClaims, 'exp'>,
  now: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000)
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TTL_SECONDS)
    .setIssuer('tili-tili')
    .setAudience('tili-tili-app')
    .sign(accessKey(secret))
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey(secret), {
      issuer: 'tili-tili',
      audience: 'tili-tili-app',
      algorithms: ['HS256'], // без этого подошёл бы токен с alg: none
    })
    const sub = payload.sub
    const sid = payload['sid']
    const exp = payload.exp
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof exp !== 'number') {
      throw unauthorized('Токен без обязательных полей')
    }
    return { sub, sid, exp }
  } catch (error) {
    if (error instanceof AppError) throw error
    if (error instanceof joseErrors.JWTExpired) {
      // Отдельный код: фронт по нему молча идёт в /auth/refresh,
      // а не выкидывает человека на экран входа.
      throw new AppError(401, 'token_expired', 'Срок действия токена истёк')
    }
    throw unauthorized('Токен недействителен')
  }
}

/**
 * Refresh — просто случайные 32 байта. JWT здесь не нужен: токен всё равно
 * проверяется по таблице сессий, а подписывать то, что и так лежит в базе,
 * значит платить дважды.
 */
export function createRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * В базе лежит хеш. Соль не нужна и вредна: значение уже 256 бит случайности,
 * а поиск сессии идёт по равенству хеша — с солью пришлось бы перебирать строки.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Сравнение секретов постоянным временем — чтобы не подбирать побайтово. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
