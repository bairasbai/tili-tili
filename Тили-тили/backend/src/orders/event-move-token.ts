import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify, errors } from 'jose'
import { AppError, conflict, validationFailed } from '../errors.js'
import { isUuid } from '../ids.js'

export interface EventMoveReadClaims {
  purpose: 'event-move-read'; weddingId: string; dealId: string; proposalId: string
  digest: string; userId: string; sessionId: string; policyVersion: string
  party: 'customer' | 'performer'
}
export const EVENT_MOVE_READ_TTL_SECONDS = 600
function key(secret: string): Buffer {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || new Set(secret).size < 12) {
    throw new AppError(503, 'event_move_proof_unavailable', 'Подтверждение переноса недоступно')
  }
  return createHash('sha256').update(`tili-event-move-read\n${secret}`).digest()
}
export async function signEventMoveRead(secret: string, claims: EventMoveReadClaims, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: 'event-move-read' }).setIssuer('tili-tili').setAudience('event-move-read')
    .setIssuedAt(iat).setExpirationTime(iat + EVENT_MOVE_READ_TTL_SECONDS).sign(key(secret))
}
export async function verifyEventMoveRead(secret: string, token: string, now: Date): Promise<EventMoveReadClaims> {
  const signingKey = key(secret)
  try {
    if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid proof')
    const { payload, protectedHeader } = await jwtVerify(token, signingKey, {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: 'event-move-read', currentDate: now,
    })
    if (protectedHeader.typ !== 'event-move-read' || payload.purpose !== 'event-move-read'
      || !['weddingId', 'dealId', 'proposalId', 'userId', 'sessionId'].every(k => isUuid(payload[k]))
      || typeof payload.digest !== 'string' || !/^[0-9a-f]{64}$/.test(payload.digest)
      || typeof payload.policyVersion !== 'string' || !payload.policyVersion
      || (payload.party !== 'customer' && payload.party !== 'performer')
      || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
      || payload.exp <= payload.iat || payload.exp - payload.iat > EVENT_MOVE_READ_TTL_SECONDS
      || payload.iat > Math.floor(now.getTime() / 1000)) throw new Error('Invalid claims')
    return payload as unknown as EventMoveReadClaims
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw conflict('event_move_read_expired', 'Откройте предложение переноса снова')
    throw validationFailed({ readToken: 'Нужно прочитать именно эти условия переноса в текущей сессии' })
  }
}
