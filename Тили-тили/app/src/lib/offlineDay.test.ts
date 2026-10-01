// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OFFLINE_DAY_KEY, recallDay, rememberDay, reconcileOfflineDay, type OfflineDay } from './offlineDay'
import { forgetOfflineDay, offlineGeneration, offlineScope } from './offlineAccess'
import { api, reportConsentOutdated, saveTokens, url } from './api/client'
import { cancelWedding } from './api/wedding'

const scope = { userId: 'u1', sessionId: 's1' }
const token = (userId = 'u1', sessionId = 's1', extra = {}) => `e30.${btoa(JSON.stringify({ sub: userId, sid: sessionId, ...extra }))}.test`
const snapshot = (): OfflineDay => ({ schema: 2, scope, role: 'couple', weddingId: 'w1', savedAt: '2027-06-14T10:00:00Z',
  etag: '"12"', weddingDate: '2027-06-14', weddingTimeZone: 'Europe/Moscow', timeline: [{ id: 'b1', name: 'Ceremony', startsAt: '2027-06-14T11:00:00Z', endsAt: null, eventId: 'e1', location: null }],
  events: [{ id: 'e1', name: 'Ceremony day', timeZone: 'Asia/Yekaterinburg' }], planBActivatedAt: null,
  team: [{ id: 's1', label: 'Photo', vendor: 'Person', vendorId: 'v1', phone: '+79990000001' }] })

describe('minimal versioned offline snapshot isolation', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it.each(['couple', 'helper', 'coordinator'] as const)('round-trips actual permitted %s snapshot without tokens or extra fields', role => {
    const value = { ...snapshot(), role, readToken: 'secret-proof', finance: { amount: 1 }, timeline: [{ ...snapshot().timeline[0]!, who: 'private-contact', price: 1 }] }
    rememberDay(value, offlineGeneration())
    expect(recallDay('w1', scope)?.role).toBe(role)
    const raw = localStorage.getItem(OFFLINE_DAY_KEY)!
    expect(raw).not.toMatch(/secret-proof|finance|private-contact|price/)
    expect(recallDay('w1', scope)?.events[0]?.timeZone).toBe('Asia/Yekaterinburg')
  })
  it.each([{ userId: 'other', sessionId: 's1' }, { userId: 'u1', sessionId: 'other' }, null])('does not read a different or absent namespace: %j', other => {
    rememberDay(snapshot(), offlineGeneration())
    expect(recallDay('w1', other)).toBeNull()
    expect(recallDay('other', scope)).toBeNull()
  })
  it.each([
    { schema: undefined }, { etag: null }, { etag: 'W/"12"' }, { savedAt: 'not-time' }, { role: 'vendor' },
    { scope: {} }, { timeline: [{ ...snapshot().timeline[0], startsAt: 'not-time' }] }, { team: [{ id: 's', label: 'Photo', phone: 42 }] },
    { timeline: [snapshot().timeline[0], snapshot().timeline[0]] }, { events: [snapshot().events[0], snapshot().events[0]] },
  ])('rejects unknown legacy or malformed persisted fields: %j', change => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify({ ...snapshot(), ...change }))
    expect(recallDay('w1', scope)).toBeNull()
  })
  it('a late request cannot restore data after an access cleanup', () => {
    const started = offlineGeneration()
    rememberDay(snapshot(), started); forgetOfflineDay('w1'); rememberDay(snapshot(), started)
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
    rememberDay(snapshot(), offlineGeneration())
    expect(recallDay('w1', scope)?.etag).toBe('"12"')
  })
  it('denial of a different wedding does not erase this snapshot', () => {
    rememberDay(snapshot(), offlineGeneration()); forgetOfflineDay('other')
    expect(recallDay('w1', scope)).not.toBeNull()
  })
  it('same user/session token refresh keeps the snapshot; a different session or logout clears it', () => {
    saveTokens({ accessToken: token(), refreshToken: 'r1' }); rememberDay(snapshot(), offlineGeneration())
    saveTokens({ accessToken: token('u1', 's1', { exp: 123 }), refreshToken: 'r2' })
    expect(recallDay('w1', scope)).not.toBeNull()
    saveTokens({ accessToken: token('u1', 's2'), refreshToken: 'r3' })
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
    rememberDay(snapshot(), offlineGeneration()); saveTokens(null)
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('token metadata provides a namespace only and rejects malformed or incomplete payloads', () => {
    expect(offlineScope(token())).toEqual(scope)
    for (const value of [null, 'a', 'e30.invalid.test', `e30.${btoa(JSON.stringify({ sub: 'u1' }))}.test`]) expect(offlineScope(value)).toBeNull()
  })
  it('disabled storage never crashes the screen or invents a persisted copy', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    expect(() => { rememberDay(snapshot(), offlineGeneration()); forgetOfflineDay() }).not.toThrow()
    expect(recallDay('w1', scope)).toBeNull()
  })
  it.each([{ list: [] }, { list: [{ id: 'w1', role: 'helper' }] }])('actual membership list removes disappeared wedding or changed role: %j', ({ list }) => {
    rememberDay(snapshot(), offlineGeneration()); reconcileOfflineDay(list, scope)
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('actual same-role membership retains the snapshot, failure does not supply an empty membership list', () => {
    rememberDay(snapshot(), offlineGeneration()); reconcileOfflineDay([{ id: 'w1', role: 'couple' }], scope)
    expect(recallDay('w1', scope)).not.toBeNull()
  })
  it.each(['confirmation_required', 'cancelled'])('only actual executed cancellation clears the copy: %s', async state => {
    rememberDay(snapshot(), offlineGeneration())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state }), { headers: { 'content-type': 'application/json' } })))
    expect((await cancelWedding('w1')).state).toBe(state)
    expect(localStorage.getItem(OFFLINE_DAY_KEY) !== null).toBe(state !== 'cancelled')
    vi.unstubAllGlobals()
  })
  it('a confirmed outdated consent revokes the offline copy independently of the current route', () => {
    rememberDay(snapshot(), offlineGeneration()); reportConsentOutdated()
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('a final read401 with no account token clears the copy without pretending the server is down', async () => {
    rememberDay(snapshot(), offlineGeneration()); localStorage.removeItem('tt_auth')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'No access' } }), { status: 401, headers: { 'content-type': 'application/json' } })))
    await expect(api.get(url('/weddings/{weddingId}/timeline', { weddingId: 'w1' }))).rejects.toMatchObject({ status: 401 })
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
    vi.unstubAllGlobals()
  })
})
