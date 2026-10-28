import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import { AppError } from '../src/errors.js'
import {
  assertCalendarBoundsProofAvailable, CALENDAR_BOUNDS_READ_TTL_SECONDS,
  signCalendarBoundsRead, verifyCalendarBoundsRead,
  type CalendarBoundsProofOptions, type CalendarBoundsReadClaims,
} from '../src/resources/calendar-bounds-token.js'

// Frozen full371 contract D4. This is a pure crypto suite, not actual DB/session consent.
// Synthetic secret is exactly 32 ASCII bytes, with more than 12 distinct characters.
const SECRET = '0123456789ABCDEFGHIJKLMNOPQRSTUV'
const PURPOSE = 'calendar-bounds-read'
const NAMESPACE = 'tili-calendar-bounds-read\n'
const CLOCK = new Date('2001-01-01T00:00:00.987Z')
const EPOCH = 978_307_200
const claims: CalendarBoundsReadClaims = {
  purpose: 'calendar-bounds-read', sourceId: 'a1111111-1111-4111-8111-111111111111',
  inventoryVersionId: 'b2222222-2222-4222-8222-222222222222', boundsVersionId: 'c3333333-3333-4333-8333-333333333333',
  version: '1', digest: 'd'.repeat(64), weddingId: 'd4444444-4444-4444-8444-444444444444',
  dealId: 'e5555555-5555-4555-8555-555555555555', userId: 'f6666666-6666-4666-8666-666666666666',
  sessionId: 'a7777777-7777-4777-8777-777777777777', policyVersion: 'synthetic-policy-2001-01-01',
}
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...claims, iss: 'tili-tili', aud: PURPOSE, iat: EPOCH, exp: EPOCH + 600, ...overrides }
}
// Independent JOSE constructor: never call the module signer to manufacture invalid proofs.
function key(namespace = NAMESPACE, secret = SECRET): Buffer {
  return createHash('sha256').update(namespace + secret).digest()
}
async function wire(value: Record<string, unknown> = payload(), header: Record<string, unknown> = {}, namespace = NAMESPACE): Promise<string> {
  return new SignJWT(value).setProtectedHeader({ alg: 'HS256', typ: PURPOSE, ...header }).sign(key(namespace))
}
async function failure(operation: () => unknown | Promise<unknown>, status = 422, code = 'validation_failed'): Promise<void> {
  let error: unknown
  try { await operation() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(AppError)
  expect(error).toMatchObject({ statusCode: status, code })
}
async function rejectsToken(token: unknown, status = 422, code = 'validation_failed'): Promise<void> {
  await failure(() => verifyCalendarBoundsRead(SECRET, token as string, CLOCK), status, code)
}
async function rejectsPayloads(values: Record<string, unknown>[]): Promise<void> {
  for (const value of values) {
    const token = await wire(value)
    await rejectsToken(token)
  }
}
const UUID_KEYS = ['sourceId', 'inventoryVersionId', 'boundsVersionId', 'weddingId', 'dealId', 'userId', 'sessionId'] as const
async function invalidUuid(field: typeof UUID_KEYS[number]): Promise<void> {
  await rejectsPayloads(['not-a-uuid', claims[field].toUpperCase(), null, 42].map(value => payload({ [field]: value })))
}
const badVersions = ['0', '-1', '01', '+1', '1.0', '1e0', '9223372036854775808', '', 1]
const badDigests = ['d'.repeat(63), 'D'.repeat(64), 'z'.repeat(64), null, 64]
const badPolicies = ['', null, 7, false]

describe('full371 calendar-bounds-read isolated crypto contract', () => {
  it('CBT-P01 signer uses the explicit DB clock and exact closed JWT claims with TTL600', async () => {
    const options: CalendarBoundsProofOptions = { secret: SECRET }
    expect(assertCalendarBoundsProofAvailable(options)).toBeUndefined()
    expect(Buffer.byteLength(SECRET, 'utf8')).toBe(32)
    expect(CALENDAR_BOUNDS_READ_TTL_SECONDS).toBe(600)
    const token = await signCalendarBoundsRead(SECRET, claims, CLOCK)
    const decoded = await jwtVerify(token, key(), {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: PURPOSE, currentDate: CLOCK,
    })
    expect(decoded.protectedHeader).toStrictEqual({ alg: 'HS256', typ: PURPOSE })
    expect(decoded.payload).toStrictEqual(payload())
  })
  it('CBT-P02 verifier accepts an independent valid JWT and returns exact domain plus standard claims', async () => {
    expect(await verifyCalendarBoundsRead(SECRET, await wire(), CLOCK)).toStrictEqual(payload())
  })
  it('CBT-P03 a valid proof remains live just before its DB-clock expiration', async () => {
    const beforeExpiry = new Date('2001-01-01T00:09:59.999Z')
    expect(await verifyCalendarBoundsRead(SECRET, await wire(), beforeExpiry)).toStrictEqual(payload())
  })
  it('CBT-P04 verifier accepts a positive TTL shorter than the signing default', async () => {
    const value = payload({ exp: EPOCH + 1 })
    expect(await verifyCalendarBoundsRead(SECRET, await wire(value), CLOCK)).toStrictEqual(value)
  })
  it('CBT-P05 maximum canonical positive int8 proposal version is supported', async () => {
    const value = payload({ version: '9223372036854775807' })
    expect(await verifyCalendarBoundsRead(SECRET, await wire(value), CLOCK)).toStrictEqual(value)
  })
  it('CBT-P06 a diverse multibyte secret is measured in UTF8 bytes rather than characters', async () => {
    const secret = 'АБВГДЕЖЗИЙКЛМНОП'
    expect(secret.length).toBe(16); expect(Buffer.byteLength(secret, 'utf8')).toBe(32)
    expect(assertCalendarBoundsProofAvailable({ secret })).toBeUndefined()
    const token = await signCalendarBoundsRead(secret, claims, CLOCK)
    const decoded = await jwtVerify(token, key(NAMESPACE, secret), { algorithms: ['HS256'], currentDate: CLOCK })
    expect(decoded.payload).toStrictEqual(payload())
    expect(await verifyCalendarBoundsRead(secret, token, CLOCK)).toStrictEqual(payload())
  })

  const negative: { name: string; run: () => Promise<void> }[] = [
    { name: 'CBT-N01 foreign purpose is rejected despite a valid bounds signature', run: () => rejectsPayloads([payload({ purpose: 'order-terms-read' })]) },
    { name: 'CBT-N02 wrong or broadened audience is rejected', run: () => rejectsPayloads([payload({ aud: 'other' }), payload({ aud: [PURPOSE, 'other'] })]) },
    { name: 'CBT-N03 foreign protected typ is rejected', run: async () => rejectsToken(await wire(payload(), { typ: 'event-move-read' })) },
    { name: 'CBT-N04 wrong issuer is rejected', run: () => rejectsPayloads([payload({ iss: 'other' })]) },
    { name: 'CBT-N05 another HMAC algorithm cannot replace HS256', run: async () => rejectsToken(await wire(payload(), { alg: 'HS384' })) },
    { name: 'CBT-N06 an unsecured alg-none JWT is rejected', run: async () => {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
      await rejectsToken(`${part({ alg: 'none', typ: PURPOSE })}.${part(payload())}.`)
    } },
    { name: 'CBT-N07 old order-terms key namespace cannot sign bounds claims', run: async () => rejectsToken(await wire(payload(), {}, 'tili-order-terms-read\n')) },
    { name: 'CBT-N08 old event-move key namespace cannot sign bounds claims', run: async () => rejectsToken(await wire(payload(), {}, 'tili-event-move-read\n')) },
    { name: 'CBT-N09 a changed signature cannot authenticate an otherwise valid payload', run: async () => {
      const [header, body, signature] = (await wire()).split('.')
      const changed = (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1)
      await rejectsToken(`${header}.${body}.${changed}`)
    } },
    { name: 'CBT-N10 every domain and standard claim is required', run: async () => {
      for (const field of Object.keys(payload())) { const value = payload(); delete value[field]; await rejectsToken(await wire(value)) }
    } },
    { name: 'CBT-N11 extra party or scope claims are rejected rather than trusted', run: () => rejectsPayloads([
      payload({ party: 'customer' }), payload({ vendorId: claims.sourceId }), payload({ policy_version: claims.policyVersion }),
    ]) },
    { name: 'CBT-N12 source identity must be a canonical lowercase UUID', run: () => invalidUuid('sourceId') },
    { name: 'CBT-N13 inventory version identity must be a canonical lowercase UUID', run: () => invalidUuid('inventoryVersionId') },
    { name: 'CBT-N14 bounds version identity must be a canonical lowercase UUID', run: () => invalidUuid('boundsVersionId') },
    { name: 'CBT-N15 wedding identity must be a canonical lowercase UUID', run: () => invalidUuid('weddingId') },
    { name: 'CBT-N16 deal identity must be a canonical lowercase UUID', run: () => invalidUuid('dealId') },
    { name: 'CBT-N17 user identity must be a canonical lowercase UUID', run: () => invalidUuid('userId') },
    { name: 'CBT-N18 session identity must be a canonical lowercase UUID', run: () => invalidUuid('sessionId') },
    { name: 'CBT-N19 version rejects noncanonical or out-of-int8 values', run: () => rejectsPayloads(badVersions.map(version => payload({ version }))) },
    { name: 'CBT-N20 digest requires exactly 64 lowercase hex characters', run: () => rejectsPayloads(badDigests.map(digest => payload({ digest }))) },
    { name: 'CBT-N21 policy version must be a nonempty string', run: () => rejectsPayloads(badPolicies.map(policyVersion => payload({ policyVersion }))) },
    { name: 'CBT-N22 TTL greater than 600 seconds is rejected', run: () => rejectsPayloads([payload({ exp: EPOCH + 601 })]) },
    { name: 'CBT-N23 future-issued proof is rejected against the explicit DB clock', run: () => rejectsPayloads([payload({ iat: EPOCH + 1, exp: EPOCH + 601 })]) },
    { name: 'CBT-N24 zero or reversed validity interval is invalid rather than expired', run: () => rejectsPayloads([
      payload({ exp: EPOCH }), payload({ iat: EPOCH + 10, exp: EPOCH + 5 }),
    ]) },
    { name: 'CBT-N25 timestamps must be finite safe integers with numeric wire types', run: () => rejectsPayloads([
      payload({ iat: Number.MAX_SAFE_INTEGER + 1, exp: Number.MAX_SAFE_INTEGER + 2 }), payload({ exp: Number.MAX_SAFE_INTEGER + 1 }),
      payload({ iat: EPOCH + 0.5 }), payload({ exp: EPOCH + 599.5 }), payload({ iat: String(EPOCH) }),
      payload({ exp: String(EPOCH + 600) }), payload({ iat: null }),
    ]) },
    { name: 'CBT-N26 a fully valid proof expires exactly at its DB-clock expiration', run: async () => {
      await rejectsToken(await wire(payload({ iat: EPOCH - 600, exp: EPOCH })), 409, 'calendar_bounds_read_expired')
    } },
    { name: 'CBT-N27 expired malformed or foreign-purpose proofs remain validation errors', run: () => rejectsPayloads([
      payload({ iat: EPOCH - 600, exp: EPOCH, purpose: 'event-move-read' }),
      payload({ iat: EPOCH - 600, exp: EPOCH, sourceId: 'bad' }), payload({ iat: EPOCH - 600, exp: EPOCH, party: 'customer' }),
    ]) },
    { name: 'CBT-N28 an oversized signed JWT is rejected', run: async () => {
      const token = await wire(payload({ policyVersion: 'synthetic-'.repeat(1_000) }))
      expect(Buffer.byteLength(token, 'utf8')).toBeGreaterThan(8192); await rejectsToken(token)
    } },
    { name: 'CBT-N29 nonstring and malformed serialized tokens are rejected', run: async () => {
      for (const token of [undefined, null, 7, {}, [], '', 'not-a-token', 'a.b.c']) await rejectsToken(token)
    } },
  ]
  it.each(negative)('$name', ({ run }) => run())

  async function unavailable(secret: unknown): Promise<void> {
    await failure(() => assertCalendarBoundsProofAvailable({ secret } as CalendarBoundsProofOptions), 503, 'calendar_bounds_proof_unavailable')
    await failure(() => signCalendarBoundsRead(secret as string, claims, CLOCK), 503, 'calendar_bounds_proof_unavailable')
    await failure(() => verifyCalendarBoundsRead(secret as string, 'invalid', CLOCK), 503, 'calendar_bounds_proof_unavailable')
  }
  it('CBT-C01 a diverse 31-byte secret is unavailable for assert sign and verify', async () => {
    await unavailable('0123456789ABCDEFGHIJKLMNOPQRSTU')
  })
  it('CBT-C02 a long secret with only 11 distinct characters is unavailable', async () => {
    await unavailable('abcdefghijk'.repeat(4))
  })
  it('CBT-C03 absent nonstring and empty configuration is unavailable rather than a token error', async () => {
    for (const secret of [undefined, null, 42, '']) await unavailable(secret)
    await failure(() => assertCalendarBoundsProofAvailable(undefined as unknown as CalendarBoundsProofOptions), 503, 'calendar_bounds_proof_unavailable')
  })

  async function rejectsSign(value: unknown): Promise<void> {
    await failure(() => signCalendarBoundsRead(SECRET, value as CalendarBoundsReadClaims, CLOCK))
  }
  it('CBT-S01 signer rejects missing domain keys before producing a JWT', async () => {
    for (const field of Object.keys(claims)) { const value: Record<string, unknown> = { ...claims }; delete value[field]; await rejectsSign(value) }
  })
  it('CBT-S02 signer rejects extra party scope and caller-supplied standard claims', async () => {
    for (const extra of [{ party: 'performer' }, { vendorId: claims.sourceId }, { iat: EPOCH }, { exp: EPOCH + 600 }, { iss: 'tili-tili' }, { aud: PURPOSE }]) {
      await rejectsSign({ ...claims, ...extra })
    }
  })
  it('CBT-S03 signer rejects invalid or noncanonical UUIDs in every identity field', async () => {
    for (const field of UUID_KEYS) for (const value of ['bad', claims[field].toUpperCase()]) await rejectsSign({ ...claims, [field]: value })
  })
  it('CBT-S04 signer validates version digest and policy rather than signing arbitrary fields', async () => {
    for (const version of badVersions) await rejectsSign({ ...claims, version })
    for (const digest of badDigests) await rejectsSign({ ...claims, digest })
    for (const policyVersion of badPolicies) await rejectsSign({ ...claims, policyVersion })
  })
  it('CBT-S05 signer rejects wrong purpose and nonobject claims', async () => {
    for (const value of [{ ...claims, purpose: 'order-terms-read' }, null, undefined, [], 'claims']) await rejectsSign(value)
  })
})
