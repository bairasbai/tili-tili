// @vitest-environment jsdom
// Real StoreProvider, wrappers and API client; only the fetch boundary is controlled.
import { StrictMode, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from './store'
import { saveTokens } from './api/client'
import { forgetLocally } from './api/auth'
import { offlineGeneration, offlineScope } from './offlineAccess'
import { OFFLINE_DAY_KEY, recallDay, rememberDay, type OfflineDay } from './offlineDay'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const token = (sub: number, sid: number, serial = 0) => `header.${btoa(JSON.stringify({ sub: id(sub), sid: id(sid), serial }))}.signature`
const A = { accessToken: token(1, 2), refreshToken: 'bootstrap-refresh-A' }
const B = { accessToken: token(3, 4), refreshToken: 'bootstrap-refresh-B' }
const NEW_SESSION = { accessToken: token(1, 5), refreshToken: 'bootstrap-refresh-A-new-session' }
const A_RENEWED = { accessToken: token(1, 2, 1), refreshToken: 'bootstrap-refresh-A-renewed' }
const WA = { id: id(10), title: 'Private A wedding', date: '2027-06-14', tz: 'Europe/Moscow', role: 'couple' as const }
const WB = { id: id(11), title: 'Private B wedding', date: '2028-07-15', tz: 'Asia/Novosibirsk', role: 'couple' as const }
const WNEW = { ...WB, id: id(12), title: 'Newly created wedding in current session' }
const WLATE = { ...WA, id: id(13), title: 'Stale list must not return' }
const DATE_LATE = '2044-12-31', SLOT_LATE = id(23), FAV_LATE = id(33)
const ENDPOINTS = ['list', 'wedding', 'slots', 'favorites'] as const
type Endpoint = typeof ENDPOINTS[number]
type Call = { path: string; method: string; rawBody: string | null; headers: Headers }
type Snapshot = { wedding: string | null; date: string | null; weddings: string; slotsState: string; slots: ReturnType<typeof useStore>['slots']; favorites: string[] }
let bridge: ReturnType<typeof useStore> | null = null
const snapshots: Snapshot[] = []
function Probe() {
  const store = useStore()
  useEffect(() => {
    bridge = store
    snapshots.push({ wedding: store.weddingId, date: store.weddingDate, weddings: store.weddingsState, slotsState: store.slotsState, slots: store.slots, favorites: store.favorites })
  }, [store])
  return <output data-testid="store">{JSON.stringify({ wedding: store.weddingId, date: store.weddingDate, weddings: store.weddingsState, slotsState: store.slotsState, slots: store.slots, favorites: store.favorites })}</output>
}
function state(): Snapshot { return JSON.parse(screen.getByTestId('store').textContent!) as Snapshot }
function held<T>() {
  let finish!: (value: T) => void, fail!: (reason: Error) => void, settled = false
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject })
  return { promise, get settled() { return settled }, resolve(value: T) { if (!settled) { settled = true; finish(value) } }, reject(reason: Error) { if (!settled) { settled = true; fail(reason) } } }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Synthetic expired access' } }, 401)
const pathFor = (endpoint: Endpoint, weddingId = WA.id) => endpoint === 'list' ? '/weddings' : endpoint === 'favorites' ? '/me/favorites' : `/weddings/${weddingId}${endpoint === 'slots' ? '/slots' : ''}`
const slot = (who: 'A' | 'B', late = false) => ({ id: late ? SLOT_LATE : id(who === 'A' ? 20 : 21), categoryId: 'photo', label: who + ' private slot', tileState: 'candidate', deal: { id: id(who === 'A' ? 40 : 41), state: 'candidate', externalName: who + ' private vendor', externalPhone: who === 'A' ? '+79990000001' : '+79990000002' } })
const lateBody = (endpoint: Endpoint) => endpoint === 'list' ? [WLATE] : endpoint === 'wedding' ? { ...WA, date: DATE_LATE } : endpoint === 'slots' ? [slot('A', true)] : [{ id: FAV_LATE, name: 'Private late favorite' }]
const marker = (endpoint: Endpoint) => endpoint === 'list' ? WLATE.id : endpoint === 'wedding' ? DATE_LATE : endpoint === 'slots' ? SLOT_LATE : FAV_LATE
const ownerOf = (access: string | null) => {
  if (!access) return 'anonymous'
  const claims = JSON.parse(atob(access.split('.')[1]!)) as { sub: string; sid: string }
  return claims.sub === id(3) ? 'B' : 'A'
}
let active: ReturnType<typeof network> | null = null
function network(target?: Endpoint, sameWedding = false) {
  const first = held<Response>(), calls: Call[] = [], unexpected: string[] = []
  let heldOnce = false
  const bWedding = sameWedding ? { ...WB, id: WA.id } : WB
  const payload = (call: Call) => {
    const who = ownerOf(call.headers.get('authorization')?.replace(/^Bearer /, '') ?? null)
    const wedding = who === 'B' ? bWedding : WA
    if (call.path === '/weddings') return [wedding]
    if (call.path === '/me/favorites') return [{ id: id(who === 'B' ? 31 : 30), name: who + ' favorite' }]
    if (call.path === `/weddings/${WNEW.id}`) return WNEW
    if (call.path === `/weddings/${WNEW.id}/slots`) return [slot('A')]
    if (call.path === `/weddings/${wedding.id}`) return wedding
    if (call.path === `/weddings/${wedding.id}/slots`) return [slot(who === 'B' ? 'B' : 'A')]
    return undefined
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    const call: Call = { path, method: init?.method ?? 'GET', rawBody: init?.body == null ? null : String(init.body), headers: new Headers(init?.headers) }
    calls.push(call)
    if (path === '/auth/refresh' && call.method === 'POST') {
      const body = JSON.parse(call.rawBody!) as { refreshToken: string }
      if (body.refreshToken === A.refreshToken) return json(A_RENEWED)
      const original = body.refreshToken === B.refreshToken ? B : NEW_SESSION
      const claims = JSON.parse(atob(original.accessToken.split('.')[1]!)) as { sub: string; sid: string }
      return json({ accessToken: `header.${btoa(JSON.stringify({ ...claims, serial: 1 }))}.signature`, refreshToken: body.refreshToken + '-renewed' })
    }
    if (call.method !== 'GET') { unexpected.push(`${call.method} ${path}`); return json({ error: { code: 'unexpected_write', message: 'Read-only bootstrap fixture' } }, 500) }
    if (target && path === pathFor(target) && call.headers.get('authorization') === `Bearer ${A.accessToken}` && !heldOnce) { heldOnce = true; return first.promise }
    const body = payload(call)
    if (body !== undefined) return json(body)
    // A replay of A's old wedding under B is observable but receives no mock ACL approval.
    if (/^\/weddings\//.test(path)) return json({ error: { code: 'forbidden', message: 'Synthetic other wedding' } }, 403)
    unexpected.push(`${call.method} ${path}`); return json({ error: { code: 'unexpected_route', message: 'Unexpected bootstrap route' } }, 500)
  }))
  const result = { first, calls, unexpected, bWedding, targetCalls: () => calls.filter(c => c.path === pathFor(target ?? 'list')), refreshes: () => calls.filter(c => c.path === '/auth/refresh') }
  active = result
  return result
}
function open(strict = false) { const child = <StoreProvider><Probe /></StoreProvider>; return render(strict ? <StrictMode>{child}</StrictMode> : child) }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function arrived(h: ReturnType<typeof network>) { await waitFor(() => expect(h.targetCalls().filter(c => c.headers.get('authorization') === `Bearer ${A.accessToken}`)).toHaveLength(1)) }
async function release(h: ReturnType<typeof network>, response: Response) {
  await act(async () => { h.first.resolve(response) })
  await waitFor(() => expect(response.bodyUsed).toBe(true))
  await flush()
}
async function changeTo(tokens: typeof A | null) { await act(async () => { saveTokens(tokens) }) }
async function observedStorageRoundTrip() {
  // The shared storage is A again; both queued event payloads still prove A→B→A.
  for (const [oldValue, newValue] of [[A, B], [B, A]]) await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'tt_auth', oldValue: JSON.stringify(oldValue), newValue: JSON.stringify(newValue), storageArea: localStorage }))
  })
  expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(A)
}
const privateStorage = () => ['tt_wedding_id', 'tt_wedding_date', 'tt_fav'].map(k => [k, localStorage.getItem(k)])
function noLate(endpoint: Endpoint, from: number) {
  expect(JSON.stringify(snapshots.slice(from))).not.toContain(marker(endpoint))
  expect(JSON.stringify(privateStorage())).not.toContain(marker(endpoint))
}
function streamed(body: unknown) {
  let controller!: ReadableStreamDefaultController<Uint8Array>, finished = false
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), { headers: { 'content-type': 'application/json' } })
  return { response, finish() { if (!finished) { finished = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close() } } }
}
let pendingBody: ReturnType<typeof streamed> | null = null
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); bridge = null; snapshots.length = 0; active = null; pendingBody = null
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  saveTokens(A); localStorage.setItem('tt_wedding_id', JSON.stringify(WA.id)); localStorage.setItem('tt_wedding_date', JSON.stringify('2020-01-01'))
})
afterEach(async () => {
  cleanup(); pendingBody?.finish(); active?.first.resolve(json([])); await flush()
  expect(active?.unexpected ?? []).toEqual([])
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('StoreProvider bootstrap origin across real client/fetch', () => {
  for (const endpoint of ENDPOINTS) {
    it.each(['actor', 'observed-storage-A-B-A'] as const)(`${endpoint}: held original 401 after %s does not refresh or replay old read`, async boundary => {
      const h = network(endpoint); open(); await arrived(h)
      const initial = h.targetCalls()[0]!
      expect(initial.method).toBe('GET'); expect(initial.rawBody).toBeNull(); expect(initial.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`)
      if (boundary === 'observed-storage-A-B-A') await observedStorageRoundTrip()
      else await changeTo(B)
      await flush() // Finish independent fresh-principal reads before releasing the old response.
      const saved = localStorage.getItem('tt_auth'), before = h.calls.length
      await release(h, unauthorized())
      expect(h.refreshes()).toEqual([])
      expect(h.calls.slice(before).filter(c => c.path === initial.path)).toEqual([])
      expect(localStorage.getItem('tt_auth')).toBe(saved)
    })
    it(`${endpoint}: late 200 body cannot publish A data into B memory or storage`, async () => {
      const h = network(endpoint, true), body = pendingBody = streamed(lateBody(endpoint)); open(); await arrived(h)
      await act(async () => { h.first.resolve(body.response) }); await waitFor(() => expect(body.response.bodyUsed).toBe(true))
      await changeTo(B); const from = snapshots.length
      await act(async () => { body.finish() }); await flush()
      noLate(endpoint, from); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
    })
    it(`${endpoint}: unchanged sub/sid refreshes once and replays exact GET once`, async () => {
      const h = network(endpoint); open(); await arrived(h); const original = h.targetCalls()[0]!
      await release(h, unauthorized())
      await waitFor(() => expect(h.targetCalls()).toHaveLength(2))
      expect(h.refreshes()).toHaveLength(1); expect(JSON.parse(h.refreshes()[0]!.rawBody!)).toEqual({ refreshToken: A.refreshToken })
      const retry = h.targetCalls()[1]!
      expect({ path: retry.path, method: retry.method, body: retry.rawBody }).toEqual({ path: original.path, method: original.method, body: original.rawBody })
      expect(retry.headers.get('authorization')).toBe(`Bearer ${A_RENEWED.accessToken}`)
      expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(A_RENEWED)
      await waitFor(() => expect(state().wedding).toBe(WA.id)); expect(h.calls.every(c => c.method === 'GET' || c.path === '/auth/refresh')).toBe(true)
    })
  }
  it('same user in a new session cannot refresh/replay a held old slots read', async () => {
    const h = network('slots'); open(); await arrived(h); await changeTo(NEW_SESSION); await flush(); const before = h.calls.length
    await release(h, unauthorized()); expect(h.refreshes()).toEqual([])
    expect(h.calls.slice(before).filter(c => c.path === pathFor('slots'))).toEqual([])
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(NEW_SESSION)
  })
  it('unmount retires an original 401 without refresh or a new read', async () => {
    const h = network('slots'), view = open(); await arrived(h); view.unmount(); await flush(); const before = h.calls.length
    await release(h, unauthorized()); expect(h.refreshes()).toEqual([]); expect(h.calls.slice(before)).toEqual([])
  })
  it('stale list rejection cannot replace an explicitly adopted B ready state with error', async () => {
    const h = network('list'); open(); await arrived(h)
    await act(async () => { saveTokens(B); bridge!.adoptWeddings([WB]) })
    await waitFor(() => expect(state().wedding).toBe(WB.id)); expect(state().weddings).toBe('ready')
    await act(async () => { h.first.reject(new TypeError('Synthetic lost A response')) }); await flush()
    expect(state().wedding).toBe(WB.id); expect(state().weddings).toBe('ready'); expect(h.refreshes()).toEqual([])
  })
  it('stale slot rejection cannot mark a fresh B snapshot erroneous in the same wedding', async () => {
    const h = network('slots', true); open(); await arrived(h)
    await act(async () => { saveTokens(B); bridge!.adoptWeddings([h.bWedding]); bridge!.refreshSlots() })
    await waitFor(() => expect(state().slots.some(s => s.id === id(21))).toBe(true)); expect(state().slotsState).toBe('ready')
    await act(async () => { h.first.reject(new TypeError('Synthetic late old slots failure')) }); await flush()
    expect(state().slotsState).toBe('ready'); expect(state().slots.map(s => s.id)).toEqual([id(21)]); expect(h.refreshes()).toEqual([])
  })
  it('switching account starts a fresh B bootstrap and removes A memory/local copies', async () => {
    const h = network(); open()
    await waitFor(() => expect(state().favorites).toEqual([id(30)])); await waitFor(() => expect(state().date).toBe(WA.date))
    await changeTo(B)
    await waitFor(() => expect(h.calls.some(c => c.path === '/weddings' && c.headers.get('authorization') === `Bearer ${B.accessToken}`)).toBe(true))
    await waitFor(() => expect(state().wedding).toBe(WB.id)); await waitFor(() => expect(state().date).toBe(WB.date))
    await waitFor(() => expect(state().favorites).toEqual([id(31)])); expect(state().slots.map(s => s.id)).toEqual([id(21)])
    expect(privateStorage()).toEqual([['tt_wedding_id', JSON.stringify(WB.id)], ['tt_wedding_date', JSON.stringify(WB.date)], ['tt_fav', JSON.stringify([id(31)])]])
  })
  it('saveTokens(B) then adoptWeddings(B) in one act retains newly owned B data and offline copy', async () => {
    network(); open(); await waitFor(() => expect(state().favorites).toEqual([id(30)]))
    const copy: OfflineDay = { schema: 2, scope: offlineScope(B.accessToken)!, role: 'couple', weddingId: WB.id, savedAt: '2026-10-16T09:00:00Z', etag: '"31"', weddingDate: WB.date, weddingTimeZone: WB.tz, timeline: [], events: [], planBActivatedAt: null, team: [] }
    await act(async () => { saveTokens(B); rememberDay(copy, offlineGeneration()); bridge!.adoptWeddings([WB]) })
    await waitFor(() => expect(state().date).toBe(WB.date)); await waitFor(() => expect(state().wedding).toBe(WB.id)); await flush()
    expect(recallDay(WB.id, offlineScope(B.accessToken))).toEqual(copy); expect(localStorage.getItem(OFFLINE_DAY_KEY)).not.toBeNull()
    expect(localStorage.getItem('tt_wedding_id')).toBe(JSON.stringify(WB.id)); expect(localStorage.getItem('tt_wedding_date')).toBe(JSON.stringify(WB.date))
  })
  it('logout clears private memory/storage and a late favorites body cannot restore them', async () => {
    const h = network('favorites'), body = pendingBody = streamed(lateBody('favorites')); open(); await arrived(h)
    await act(async () => { h.first.resolve(body.response) }); await waitFor(() => expect(body.response.bodyUsed).toBe(true))
    await act(async () => { forgetLocally(); bridge!.forgetSession() }); const from = snapshots.length
    await act(async () => { body.finish() }); await flush()
    expect(state().wedding).toBeNull(); expect(state().date).toBeNull(); expect(state().slots).toEqual([]); expect(state().favorites).toEqual([])
    expect(privateStorage().every(([, value]) => value === null)).toBe(true); noLate('favorites', from); expect(h.refreshes()).toEqual([])
  })
  it('StrictMode shares one startup list promise and reconnect makes one new read-only membership check', async () => {
    const h = network(); open(true); await waitFor(() => expect(state().slotsState).toBe('ready'))
    expect(h.calls.filter(c => c.path === '/weddings')).toHaveLength(1)
    await act(async () => { vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); fireEvent(window, new Event('offline')) })
    await act(async () => { vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); fireEvent(window, new Event('online')) })
    await waitFor(() => expect(h.calls.filter(c => c.path === '/weddings')).toHaveLength(2)); expect(h.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('pending old startup list cannot erase the offline copy of a newly selected wedding', async () => {
    const h = network('list'); open(); await arrived(h)
    const copy: OfflineDay = { schema: 2, scope: offlineScope(A.accessToken)!, role: 'couple', weddingId: WNEW.id, savedAt: '2026-10-16T09:00:00Z', etag: '"32"', weddingDate: WNEW.date, weddingTimeZone: WNEW.tz, timeline: [], events: [], planBActivatedAt: null, team: [] }
    await act(async () => { bridge!.setWeddingId(WNEW.id); rememberDay(copy, offlineGeneration()) })
    await waitFor(() => expect(state().date).toBe(WNEW.date)); const saved = localStorage.getItem(OFFLINE_DAY_KEY)
    expect(recallDay(WNEW.id, offlineScope(A.accessToken))).toEqual(copy)
    await release(h, json([WA])); expect(state().wedding).toBe(WNEW.id)
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBe(saved); expect(recallDay(WNEW.id, offlineScope(A.accessToken))).toEqual(copy)
    expect(h.calls.filter(c => c.path === '/weddings')).toHaveLength(1)
  })
})

describe('first registered bootstrap preserves a guest draft but rechecks remembered membership', () => {
  it.each(['own-wedding', 'empty-membership'] as const)('%s after anonymous mount replaces an unverified remembered wedding', async membership => {
    saveTokens(null)
    const guest = { date: '2030-03-04', guests: '60', budget: '500000', format: 'guest draft', style: 'guest style', planner: null, booked: [] }
    localStorage.setItem('tt_wedding_id', JSON.stringify(WA.id))
    localStorage.setItem('tt_quiz', JSON.stringify(guest))
    const h = network(), originalFetch = globalThis.fetch
    if (membership === 'empty-membership') vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init)
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
      if (path === '/weddings' && (init?.method ?? 'GET') === 'GET' && new Headers(init?.headers).get('authorization') === `Bearer ${B.accessToken}`) {
        await response.arrayBuffer()
        return json([])
      }
      return response
    }))
    open(); await flush()
    expect(h.calls).toEqual([]); expect(state().wedding).toBe(WA.id)
    expect(bridge!.quiz).toEqual(guest)
    await changeTo(B) // Deliberately no adoptWeddings: the first authenticated read owns reconciliation.
    await waitFor(() => expect(state().weddings).toBe('ready'))
    expect(h.calls.filter(c => c.path === '/weddings' && c.headers.get('authorization') === `Bearer ${B.accessToken}`)).toHaveLength(1)
    expect(bridge!.quiz).toEqual(guest); expect(localStorage.getItem('tt_quiz')).toBe(JSON.stringify(guest))
    expect(state().wedding).toBe(membership === 'own-wedding' ? WB.id : null)
    expect(localStorage.getItem('tt_wedding_id')).toBe(JSON.stringify(membership === 'own-wedding' ? WB.id : null))
    expect(h.refreshes()).toEqual([])
  })
})
