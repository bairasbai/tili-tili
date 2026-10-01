import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify, errors } from 'jose'
import { AppError, conflict, validationFailed } from '../errors.js'
import { isUuid } from '../ids.js'

export interface TermsProofOptions { secret: string }
export interface TermsReadClaims {
  purpose: 'order-terms-read'; weddingId: string; dealId: string; termsId: string;
  version: string; digest: string; userId: string; sessionId: string; policyVersion: string
}
export const TERMS_READ_TTL_SECONDS = 600
function key(secret: string): Buffer {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || new Set(secret).size < 12) {
    throw new AppError(503, 'terms_proof_unavailable', 'Подтверждение версии условий недоступно')
  }
  return createHash('sha256').update(`tili-order-terms-read\n${secret}`).digest()
}
export function assertTermsProofAvailable(options: TermsProofOptions): void { key(options?.secret) }
export async function signOrderTermsRead(secret: string, claims: TermsReadClaims, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: 'order-terms-read' }).setIssuer('tili-tili').setAudience('order-terms-read')
    .setIssuedAt(iat).setExpirationTime(iat + TERMS_READ_TTL_SECONDS).sign(key(secret))
}
export async function verifyOrderTermsRead(secret: string, token: string, now: Date): Promise<TermsReadClaims> {
  const signingKey = key(secret)
  try {
    if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid proof')
    const { payload, protectedHeader } = await jwtVerify(token, signingKey, {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: 'order-terms-read', currentDate: now,
    })
    if (protectedHeader.typ !== 'order-terms-read' || payload.purpose !== 'order-terms-read' ||
      !['weddingId', 'dealId', 'termsId', 'userId', 'sessionId'].every(k => isUuid(payload[k])) ||
      typeof payload.version !== 'string' || !/^[1-9]\d{0,18}$/.test(payload.version) ||
      typeof payload.digest !== 'string' || !/^[0-9a-f]{64}$/.test(payload.digest) ||
      typeof payload.policyVersion !== 'string' || !payload.policyVersion || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
      payload.exp <= payload.iat || payload.exp - payload.iat > TERMS_READ_TTL_SECONDS || payload.iat > Math.floor(now.getTime() / 1000)) throw new Error('Invalid claims')
    return payload as unknown as TermsReadClaims
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw conflict('terms_read_expired', 'Версия подтверждения устарела — откройте условия снова')
    throw validationFailed({ readToken: 'Нужно действующее подтверждение именно этой версии условий' })
  }
}
