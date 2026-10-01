import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify, errors } from 'jose'
import { conflict, validationFailed } from '../errors.js'
import { PROGRAM_READ_TTL_SECONDS } from './program-token.js'

export interface ExternalProgramClaims {
  weddingId: string; inviteId: string; dealId: string; version: string; digest: string
}
const PURPOSE = 'tili-external-program-read'
const key = (secret: string) => createHash('sha256').update(`${PURPOSE}\n${secret}`).digest()
export async function signExternalProgramRead(secret: string, claims: ExternalProgramClaims, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: PURPOSE }).setIssuer('tili-tili').setAudience(PURPOSE)
    .setIssuedAt(iat).setExpirationTime(iat + PROGRAM_READ_TTL_SECONDS).sign(key(secret))
}
export async function verifyExternalProgramRead(secret: string, token: string, now: Date): Promise<ExternalProgramClaims> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: PURPOSE, currentDate: now,
    })
    if (protectedHeader.typ !== PURPOSE || !['weddingId', 'inviteId', 'dealId', 'version', 'digest'].every(k => typeof payload[k] === 'string')
      || !/^\d+$/.test(payload.version as string) || !/^[0-9a-f]{64}$/.test(payload.digest as string)) throw new Error('Missing external read claims')
    return payload as unknown as ExternalProgramClaims
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw conflict('program_read_expired', 'Снимок устарел — откройте программу заново')
    throw validationFailed({ readToken: 'нужен действующий серверный снимок программы' })
  }
}
