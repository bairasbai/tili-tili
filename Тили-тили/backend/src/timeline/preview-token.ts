import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify, errors } from 'jose'
import { conflict, validationFailed } from '../errors.js'
import type { RequestedShiftScope } from './snapshot.js'

export interface ShiftClaims {
  weddingId: string; userId: string; sessionId: string; version: string
  scope: RequestedShiftScope; minutes: number; digest: string
}
const key = (secret: string) => createHash('sha256').update(`tili-timeline-shift\n${secret}`).digest()
export const shiftDigest = (plan: unknown) => createHash('sha256').update(JSON.stringify(plan)).digest('hex')
export const SHIFT_PREVIEW_TTL_SECONDS = 600
export async function signShiftPreview(secret: string, claims: ShiftClaims, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: 'tili-timeline-shift' })
    .setIssuedAt(iat).setExpirationTime(iat + SHIFT_PREVIEW_TTL_SECONDS)
    .setIssuer('tili-tili').setAudience('tili-timeline-shift').sign(key(secret))
}
export async function verifyShiftPreview(secret: string, token: string, now: Date): Promise<ShiftClaims> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: 'tili-timeline-shift', currentDate: now,
    })
    if (protectedHeader.typ !== 'tili-timeline-shift' || typeof payload.weddingId !== 'string'
      || typeof payload.userId !== 'string' || typeof payload.sessionId !== 'string'
      || typeof payload.version !== 'string' || typeof payload.digest !== 'string'
      || typeof payload.minutes !== 'number' || !payload.scope || typeof payload.scope !== 'object') throw new Error('Missing claims')
    return payload as unknown as ShiftClaims
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw conflict('shift_preview_expired', 'Предпросмотр истёк — получите новый')
    throw validationFailed({ previewToken: 'нужен действующий серверный предпросмотр сдвига' })
  }
}
