import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify, errors } from 'jose'
import { conflict, validationFailed } from '../errors.js'

export interface ProgramReadClaims {
  weddingId: string; vendorId: string; userId: string; sessionId: string; version: string; digest: string
}
const key = (secret: string) => createHash('sha256').update(`tili-vendor-program-read\n${secret}`).digest()
export const programDigest = (snapshot: unknown) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
export const PROGRAM_READ_TTL_SECONDS = 600
export async function signProgramRead(secret: string, claims: ProgramReadClaims, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  return new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: 'tili-vendor-program-read' }).setIssuer('tili-tili').setAudience('tili-vendor-program-read')
    .setIssuedAt(iat).setExpirationTime(iat + PROGRAM_READ_TTL_SECONDS).sign(key(secret))
}
export async function verifyProgramRead(secret: string, token: string, now: Date): Promise<ProgramReadClaims> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: 'tili-vendor-program-read', currentDate: now,
    })
    if (protectedHeader.typ !== 'tili-vendor-program-read'
      || !['weddingId','vendorId','userId','sessionId','version','digest'].every(k => typeof payload[k] === 'string')
      || !/^\d+$/.test(payload.version as string) || !/^[0-9a-f]{64}$/.test(payload.digest as string)) throw new Error('Missing read claims')
    return payload as unknown as ProgramReadClaims
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw conflict('program_read_expired', 'Снимок устарел — откройте программу заново')
    throw validationFailed({ readToken: 'нужен действующий серверный снимок программы' })
  }
}
