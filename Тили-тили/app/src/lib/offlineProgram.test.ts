// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, reportConsentOutdated, saveTokens } from './api/client'
import { getGuestVendor, getExternalProgram } from './api/guestVendor'
import { getVendorProgram } from './api/vendor'
import type { VendorProgram } from './api/vendor'
import { cancelWedding } from './api/wedding'
import { externalProgramNamespace, forgetOfflinePrograms, OFFLINE_PROGRAM_KEY, offlineGeneration, offlineScope, registeredProgramNamespace } from './offlineAccess'
import { offlinePrograms, rememberProgram } from './offlineProgram'

const token = (sid = 's1') => `e30.${btoa(JSON.stringify({ sub: 'u1', sid }))}.test`
const scope = () => registeredProgramNamespace(offlineScope(token()))!
const external = 'external:' + 'a'.repeat(64)
function snapshot(weddingId = 'w1') {
  const data: VendorProgram = { weddingId, wedding: 'Own couple', sourceVersion: '7', updatedAt: null, acknowledgedAt: null, requiresAcknowledgment: true, readToken: 'RAW PROOF', expiresAt: '2030-06-01T12:00:00Z', blocks: [
    { id: 'b1', name: 'Own block', startsAt: '2027-06-14T11:00:00Z', endsAt: null, location: null, durationMinutes: null, fixed: false, outdoor: false, travelMinutes: 1.5, bufferMinutes: 0,
      roles: ['responsible'], dependsOn: [], event: { id: 'e1', name: 'Unknown-zone event', date: null, timeZone: null, location: null } },
  ] }
  return { data, etag: '"7"' }
}
const remember = (namespace = scope(), weddingId = 'w1') => rememberProgram(namespace, snapshot(weddingId), offlineGeneration())
const reply = (status: number, body: unknown = { error: { code: 'denied', message: 'Denied' } }) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })))
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto); saveTokens({ accessToken: token(), refreshToken: 'r1' }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('permitted offline program storage', () => {
  it('projects known fields including unknown context without raw proof/chat/finance/notes', () => {
    const value = snapshot()
    Object.assign(value.data, { token: 'LINK SECRET', price: 500, chat: 'PRIVATE CHAT' })
    Object.assign(value.data.blocks[0]!, { who: 'PRIVATE NOTES', foreignDeal: 'OTHER DEAL' })
    rememberProgram(scope(), value, offlineGeneration())
    const raw = localStorage.getItem(OFFLINE_PROGRAM_KEY)!
    for (const secret of ['RAW PROOF', 'LINK SECRET', 'PRIVATE CHAT', 'PRIVATE NOTES', 'OTHER DEAL', 'expiresAt', 'readToken', 'price']) expect(raw).not.toContain(secret)
    const copy = offlinePrograms(scope())[0]!
    expect(copy.program.blocks[0]!.event.timeZone).toBeNull()
    expect(copy.program.blocks[0]!.endsAt).toBeNull()
    expect(copy.program.blocks[0]!.travelMinutes).toBe(1.5)
    expect(copy.etag).toBe('"7"'); expect(Date.parse(copy.savedAt)).not.toBeNaN()
  })
  it('isolates session namespaces and stores several permitted weddings', () => {
    remember(); remember(scope(), 'w2'); remember(external)
    expect(offlinePrograms(scope()).map(e => e.program.weddingId)).toEqual(['w1', 'w2'])
    expect(offlinePrograms(registeredProgramNamespace(offlineScope(token('s2'))))).toEqual([])
    expect(offlinePrograms(null)).toEqual([])
    expect(offlinePrograms(external)).toHaveLength(1)
  })
  it('same-session refresh keeps copies; account/session replacement only clears registered copies', () => {
    remember(); remember(external)
    saveTokens({ accessToken: token(), refreshToken: 'r2' })
    expect(offlinePrograms(scope())).toHaveLength(1)
    saveTokens({ accessToken: token('s2'), refreshToken: 'r3' })
    expect(offlinePrograms(scope())).toEqual([])
    expect(offlinePrograms(external)).toHaveLength(1)
  })
  it('explicit logout removes registered and anonymous copies together', () => {
    remember(); remember(external); saveTokens(null)
    expect(localStorage.getItem(OFFLINE_PROGRAM_KEY)).toBeNull()
  })
  it('known account consent change clears registered but not unrelated anonymous capability', () => {
    remember(); remember(external); reportConsentOutdated()
    expect(offlinePrograms(scope())).toEqual([])
    expect(offlinePrograms(external)).toHaveLength(1)
  })
  it('cleanup generation rejects responses started before removal', () => {
    const generation = offlineGeneration(); forgetOfflinePrograms({ namespace: scope() })
    rememberProgram(scope(), snapshot(), generation)
    expect(offlinePrograms(scope())).toEqual([])
    remember(); expect(offlinePrograms(scope())).toHaveLength(1)
  })
  it('missing/mismatched ETag never fabricates a version or a copy', () => {
    rememberProgram(scope(), { ...snapshot(), etag: null }, offlineGeneration())
    rememberProgram(scope(), { ...snapshot(), etag: '"8"' }, offlineGeneration())
    expect(localStorage.getItem(OFFLINE_PROGRAM_KEY)).toBeNull()
  })
  it.each([
    { field: 'legacy', value: { schema: 0, entries: [] } },
    { field: 'bare', value: snapshot().data },
    { field: 'invalid JSON', value: 'broken' },
  ])('rejects $field persisted shape', ({ value }) => {
    localStorage.setItem(OFFLINE_PROGRAM_KEY, typeof value === 'string' ? value : JSON.stringify(value))
    expect(offlinePrograms(scope())).toEqual([])
  })
  it.each([
    { name: 'invalid instant', mutate: (p: VendorProgram) => { p.blocks[0]!.startsAt = 'not-an-instant' } },
    { name: 'negative buffer', mutate: (p: VendorProgram) => { p.blocks[0]!.bufferMinutes = -1 } },
    { name: 'unknown role', mutate: (p: VendorProgram) => { Object.assign(p.blocks[0]!, { roles: ['foreign'] }) } },
    { name: 'foreign dependency', mutate: (p: VendorProgram) => { p.blocks[0]!.dependsOn = ['hidden-block'] } },
    { name: 'duplicate ID', mutate: (p: VendorProgram) => { p.blocks.push(p.blocks[0]!) } },
  ])('rejects $name instead of saving malformed program', ({ mutate }) => {
    const value = snapshot(); mutate(value.data); rememberProgram(scope(), value, offlineGeneration())
    expect(localStorage.getItem(OFFLINE_PROGRAM_KEY)).toBeNull()
  })
  it('SHA256 scopes links without persisting raw tokens; unavailable SubtleCrypto has no weaker fallback', async () => {
    const one = await externalProgramNamespace('first-link'), again = await externalProgramNamespace('first-link'), two = await externalProgramNamespace('second-link')
    expect(one).toMatch(/^external:[a-f0-9]{64}$/); expect(one).toBe(again); expect(one).not.toBe(two)
    expect(localStorage.length).toBe(1)
    vi.stubGlobal('crypto', {})
    expect(await externalProgramNamespace('first-link')).toBeNull()
  })
  it('disabled reads/writes do not crash or claim an available copy', () => {
    const getItem = vi.fn(() => { throw new DOMException('blocked', 'SecurityError') })
    vi.stubGlobal('localStorage', { getItem, setItem: () => { throw new DOMException('quota', 'QuotaExceededError') }, removeItem: () => {} })
    expect(() => remember()).not.toThrow(); expect(offlinePrograms(scope())).toEqual([])
    expect(getItem).toHaveBeenCalled()
    expect(() => forgetOfflinePrograms()).not.toThrow()
  })
  it.each([401, 403, 404, 410])('unmounted final registered read HTTP%s deletes only matching wedding', async status => {
    remember(); remember(scope(), 'w2'); remember(external); saveTokens(null); remember(); remember(scope(), 'w2'); remember(external)
    reply(status); await expect(getVendorProgram('w1')).rejects.toThrow()
    expect(offlinePrograms(scope()).map(e => e.program.weddingId)).toEqual(['w2'])
    expect(offlinePrograms(external)).toHaveLength(1)
  })
  it('unmounted external legacy refusal clears only the actual hashed link namespace', async () => {
    const namespace = (await externalProgramNamespace('live-link'))!
    remember(namespace); remember(external); remember()
    reply(410); await expect(getGuestVendor('live-link')).rejects.toThrow()
    expect(offlinePrograms(namespace)).toEqual([])
    expect(offlinePrograms(external)).toHaveLength(1); expect(offlinePrograms(scope())).toHaveLength(1)
  })
  it('external refusal when crypto is unavailable clears anonymous copies conservatively, not account copies', async () => {
    remember(external); remember(); vi.stubGlobal('crypto', {})
    reply(410); await expect(getExternalProgram('live-link')).rejects.toThrow()
    expect(offlinePrograms(external)).toEqual([]); expect(offlinePrograms(scope())).toHaveLength(1)
  })
  it.each([409, 422, 429, 501, 503])('HTTP%s never proves access revocation in unmounted read', async status => {
    remember(); reply(status); await expect(getVendorProgram('w1')).rejects.toThrow()
    expect(offlinePrograms(scope())).toHaveLength(1)
  })
  it('registered list authorization refusal removes registered offline links', async () => {
    remember(); remember(external); reply(403); await expect(api.get('/vendor/programs')).rejects.toThrow()
    expect(offlinePrograms(scope())).toEqual([]); expect(offlinePrograms(external)).toHaveLength(1)
  })
  it('actual executed wedding cancellation clears all its copies, not confirmation_required or another wedding', async () => {
    remember(); remember(external); remember(scope(), 'w2')
    reply(200, { state: 'confirmation_required' }); await cancelWedding('w1')
    expect(offlinePrograms(scope())).toHaveLength(2)
    reply(200, { state: 'cancelled' }); await cancelWedding('w1')
    expect(offlinePrograms(scope()).map(e => e.program.weddingId)).toEqual(['w2'])
    expect(offlinePrograms(external)).toEqual([])
  })
})
