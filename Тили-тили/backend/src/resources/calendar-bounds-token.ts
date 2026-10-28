import { createHash } from 'node:crypto'
import { SignJWT, compactVerify } from 'jose'
import { AppError, conflict, validationFailed } from '../errors.js'
import { isUuid } from '../ids.js'

export interface CalendarBoundsReadClaims {
  purpose: 'calendar-bounds-read'
  sourceId: string
  inventoryVersionId: string
  boundsVersionId: string
  version: string
  digest: string
  weddingId: string
  dealId: string
  userId: string
  sessionId: string
  policyVersion: string
}
export interface CalendarBoundsVerifiedReadClaims extends CalendarBoundsReadClaims {
  iss: 'tili-tili'
  aud: 'calendar-bounds-read'
  iat: number
  exp: number
}
export interface CalendarBoundsProofOptions { secret: string }
export const CALENDAR_BOUNDS_READ_TTL_SECONDS = 600

const purpose = 'calendar-bounds-read'
const issuer = 'tili-tili'
const claimKeys = ['purpose', 'sourceId', 'inventoryVersionId', 'boundsVersionId', 'version', 'digest',
  'weddingId', 'dealId', 'userId', 'sessionId', 'policyVersion'] as const
const uuidKeys = ['sourceId', 'inventoryVersionId', 'boundsVersionId', 'weddingId', 'dealId', 'userId', 'sessionId'] as const
const payloadKeys = [...claimKeys, 'iss', 'aud', 'iat', 'exp']

function invalid(): never {
  throw validationFailed({ readToken: 'Нужно действующее подтверждение чтения именно этих границ в текущей сессии' })
}
function unavailable(): never {
  throw new AppError(503, 'calendar_bounds_proof_unavailable', 'Подтверждение границ календаря недоступно')
}
function key(secret: unknown): Buffer {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 || new Set(secret).size < 12) unavailable()
  return createHash('sha256').update(`tili-calendar-bounds-read\n${secret}`).digest()
}
export function assertCalendarBoundsProofAvailable(options: CalendarBoundsProofOptions): void {
  try { key(options?.secret) } catch { unavailable() }
}

/** Snapshot only own data descriptors; no normalization or caller-supplied extra scope. */
function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object') invalid()
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid()
    const own = Reflect.ownKeys(value)
    if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) invalid()
    const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const name of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
      data[name] = descriptor.value
    }
    return data
  } catch { return invalid() }
}
function claimsFrom(value: unknown): CalendarBoundsReadClaims {
  const data = dataObject(value, claimKeys)
  if (data.purpose !== purpose || uuidKeys.some(k => {
    const id = data[k]
    return !isUuid(id) || id.length !== 36 || id !== id.toLowerCase()
  })) invalid()
  const version = data.version
  if (typeof version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(version) ||
    BigInt(version) > 9223372036854775807n || BigInt(version).toString() !== version) invalid()
  if (typeof data.digest !== 'string' || data.digest.length !== 64 || !/^[0-9a-f]{64}$/.test(data.digest) ||
    typeof data.policyVersion !== 'string' || data.policyVersion.length < 1 || data.policyVersion.length > 100) invalid()
  return data as unknown as CalendarBoundsReadClaims
}
function clock(nowDBDate: Date): number {
  try {
    const milliseconds = Date.prototype.getTime.call(nowDBDate)
    const seconds = Math.floor(milliseconds / 1000)
    if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(seconds)) invalid()
    return seconds
  } catch { return invalid() }
}

export async function signCalendarBoundsRead(secret: string, claims: CalendarBoundsReadClaims,
  nowDBDate: Date): Promise<string> {
  const signingKey = key(secret)
  const scope = claimsFrom(claims), iat = clock(nowDBDate)
  const exp = iat + CALENDAR_BOUNDS_READ_TTL_SECONDS
  if (!Number.isSafeInteger(exp)) invalid()
  const token = await new SignJWT(scope as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256', typ: purpose }).setIssuer(issuer).setAudience(purpose)
    .setIssuedAt(iat).setExpirationTime(exp).sign(signingKey)
  if (Buffer.byteLength(token, 'utf8') > 8192) invalid()
  return token
}

export async function verifyCalendarBoundsRead(secret: string, token: string,
  nowDBDate: Date): Promise<CalendarBoundsVerifiedReadClaims> {
  // Configuration errors remain 503 even when an untrusted token is malformed.
  const signingKey = key(secret), now = clock(nowDBDate)
  try {
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > 8192) invalid()
    const verified = await compactVerify(token, signingKey, { algorithms: ['HS256'] })
    const header = dataObject(verified.protectedHeader, ['alg', 'typ'])
    if (header.alg !== 'HS256' || header.typ !== purpose) invalid()
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.payload))
    const data = dataObject(decoded, payloadKeys)
    const scope = claimsFrom(Object.fromEntries(claimKeys.map(k => [k, data[k]])))
    const iat = data.iat, exp = data.exp
    if (data.iss !== issuer || data.aud !== purpose || typeof iat !== 'number' || typeof exp !== 'number' ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat ||
      exp - iat > CALENDAR_BOUNDS_READ_TTL_SECONDS || iat > now) invalid()
    // Only a fully authenticated, correctly scoped token can receive the expired response.
    if (exp <= now) throw conflict('calendar_bounds_read_expired', 'Подтверждение устарело — откройте границы календаря снова')
    return { ...scope, iss: issuer, aud: purpose, iat, exp }
  } catch (error) {
    if (error instanceof AppError && error.code === 'calendar_bounds_read_expired') throw error
    return invalid()
  }
}