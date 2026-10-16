// @vitest-environment jsdom
// Real StoreProvider -> catalog wrappers -> client. Only fetch is controlled;
// decoded fixture claims select responses and do not prove API authorization.
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from './store'
import { saveTokens } from './api/client'
import { forgetLocally } from './api/auth'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const token = (sub: number, sid: number, serial = 0) => `header.${btoa(JSON.stringify({ sub: id(sub), sid: id(sid), serial }))}.signature`
const A = { accessToken: token(1, 2), refreshToken: 'favorite-refresh-A' }
const B = { accessToken: token(3, 4), refreshToken: 'favorite-refresh-B' }
const NEW_SID = { accessToken: token(1, 5), refreshToken: 'favorite-refresh-new-sid' }
const A_RENEWED = { accessToken: token(1, 2, 1), refreshToken: 'favorite-refresh-A-renewed' }
const B_RENEWED = { accessToken: token(3, 4, 1), refreshToken: 'favorite-refresh-B-renewed' }
const NEW_RENEWED = { accessToken: token(1, 5, 1), refreshToken: 'favorite-refresh-new-sid-renewed' }
const WA = { id: id(10), date: '2027-06-14', title: 'A wedding', tz: 'Europe/Moscow', role: 'couple' }
const WB = { id: id(11), date: '2028-07-15', title: 'B wedding', tz: 'Asia/Novosibirsk', role: 'couple' }
const TARGET = id(30), OTHER = id(31), A_OTHER = id(32), B_OTHER = id(33)
type Mode = 'PUT' | 'DELETE'
type Actor = 'A' | 'B' | 'new-sid'
type Store = ReturnType<typeof useStore>
type Call = { path: string; method: string; rawBody: string | null; authorization: string | null; response?: Response }
let bridge: Store | null = null
const snapshots: string[][] = []
function Probe() {
  const store = useStore()
  useEffect(() => { bridge = store; snapshots.push([...store.favorites]) }, [store])
  return <>
    <output data-testid="favorites">{JSON.stringify(store.favorites)}</output>
    <output data-testid="bootstrap">{JSON.stringify({ wedding: store.weddingId, date: store.weddingDate, state: store.weddingsState, slots: store.slotsState })}</output>
    <button onClick={() => store.toggleFav(TARGET)}>target heart</button>
    <button onClick={() => store.toggleFav(OTHER)}>other heart</button>
  </>
}
function deferred<T>() {
  let finish!: (value: T) => void, settled = false
  const promise = new Promise<T>(resolve => { finish = resolve })
  return { promise, resolve(value: T) { if (!settled) { settled = true; finish(value) } } }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = () => new Response(null, { status: 204 })
const refusal = (status: number) => json({ error: { code: status === 401 ? 'unauthorized' : 'internal', message: 'Controlled favorite response' } }, status)
const initial = (mode: Mode) => mode === 'PUT' ? [A_OTHER] : [A_OTHER, TARGET]
const bInitial = (mode: Mode) => mode === 'PUT' ? [B_OTHER, TARGET] : [B_OTHER]
const favorites = (): string[] => JSON.parse(screen.getByTestId('favorites').textContent!) as string[]
const bootstrap = () => JSON.parse(screen.getByTestId('bootstrap').textContent!) as { wedding: string | null; date: string | null; state: string; slots: string }
const stored = () => localStorage.getItem('tt_fav')
const auth = () => localStorage.getItem('tt_auth')
const actorOf = (authorization: string | null): Actor | null => {
  if ([A, A_RENEWED].some(t => authorization === `Bearer ${t.accessToken}`)) return 'A'
  if ([B, B_RENEWED].some(t => authorization === `Bearer ${t.accessToken}`)) return 'B'
  if ([NEW_SID, NEW_RENEWED].some(t => authorization === `Bearer ${t.accessToken}`)) return 'new-sid'
  return null
}
let active: ReturnType<typeof network> | null = null
function network(mode: Mode, options: { holdFirst?: boolean; emptyMembership?: boolean; emptyFavorites?: boolean } = {}) {
  const first = deferred<Response>(), calls: Call[] = [], unexpected: string[] = []
  let firstHeld = false
  const writes = () => calls.filter(c => c.method === 'PUT' || c.method === 'DELETE')
  const refreshes = () => calls.filter(c => c.path === '/auth/refresh')
  const send = (call: Call, response: Response) => { call.response = response; return response }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const call: Call = { path: url.pathname.replace(/^\/api(?=\/)/, '') + url.search, method: init?.method ?? 'GET', rawBody: init?.body == null ? null : String(init.body), authorization: new Headers(init?.headers).get('authorization') }
    calls.push(call)
    const unexpectedRoute = () => { unexpected.push(`${call.method} ${call.path} ${call.authorization}`); return send(call, refusal(500)) }
    if (call.path === '/auth/refresh' && call.method === 'POST') {
      const body: unknown = call.rawBody === null ? null : JSON.parse(call.rawBody)
      const refresh = (body as { refreshToken?: string } | null)?.refreshToken
      const renewed = refresh === A.refreshToken ? A_RENEWED : refresh === B.refreshToken ? B_RENEWED : refresh === NEW_SID.refreshToken ? NEW_RENEWED : null
      return renewed ? send(call, json(renewed)) : unexpectedRoute()
    }
    const actor = actorOf(call.authorization)
    if (!actor) return unexpectedRoute()
    if ((call.method === 'PUT' || call.method === 'DELETE') && [TARGET, OTHER].some(v => call.path === `/me/favorites/${v}`)) {
      // A stale replay under B is recorded, not silently rejected by the fixture.
      if ((options.holdFirst ?? true) && !firstHeld) { firstHeld = true; return send(call, await first.promise) }
      return send(call, ok())
    }
    if (call.method !== 'GET' || call.rawBody !== null) return unexpectedRoute()
    const wedding = actor === 'B' ? WB : WA
    if (call.path === '/weddings') return send(call, json(options.emptyMembership ? [] : [wedding]))
    if (call.path === '/me/favorites') {
      const ids = options.emptyFavorites ? [] : actor === 'B' ? bInitial(mode) : initial(mode)
      return send(call, json(ids.map(vendor => ({ id: vendor, name: 'Fixture favorite' }))))
    }
    if (!options.emptyMembership && call.path === `/weddings/${wedding.id}`) return send(call, json(wedding))
    if (!options.emptyMembership && call.path === `/weddings/${wedding.id}/slots`) return send(call, json([]))
    return unexpectedRoute()
  }))
  const result = { first, calls, unexpected, writes, refreshes }
  active = result
  return result
}
function open() { return render(<StoreProvider><Probe /></StoreProvider>) }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function ready(h: ReturnType<typeof network>, tokens = A, mode: Mode = 'PUT', from = 0) {
  const actor = actorOf(`Bearer ${tokens.accessToken}`)!, wedding = actor === 'B' ? WB : WA
  const paths = ['/weddings', `/weddings/${wedding.id}`, `/weddings/${wedding.id}/slots`, '/me/favorites']
  await waitFor(() => {
    for (const path of paths) expect(h.calls.slice(from).some(c => c.method === 'GET' && c.path === path && c.authorization === `Bearer ${tokens.accessToken}` && c.response?.bodyUsed)).toBe(true)
    expect(bootstrap()).toEqual({ wedding: wedding.id, date: wedding.date, state: 'ready', slots: 'ready' })
    expect(favorites()).toEqual(actor === 'B' ? bInitial(mode) : initial(mode))
    expect(stored()).toBe(JSON.stringify(favorites()))
  })
  await flush()
}
async function click(h: ReturnType<typeof network>, count: number, vendor = TARGET) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: vendor === TARGET ? 'target heart' : 'other heart' })) })
  await waitFor(() => expect(h.writes()).toHaveLength(count))
}
async function release(h: ReturnType<typeof network>, response: Response) {
  await act(async () => { h.first.resolve(response) })
  await waitFor(() => expect(response.bodyUsed).toBe(true))
  await flush()
}
async function switchTo(h: ReturnType<typeof network>, tokens: typeof A, mode: Mode) {
  const from = h.calls.length
  await act(async () => { saveTokens(tokens) })
  await ready(h, tokens, mode, from)
}
function exactWire(call: Call, mode: Mode, accessToken = A.accessToken) {
  expect({ path: call.path, method: call.method, body: call.rawBody, authorization: call.authorization }).toEqual({ path: `/me/favorites/${TARGET}`, method: mode, body: mode === 'PUT' ? '{}' : null, authorization: `Bearer ${accessToken}` })
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); bridge = null; snapshots.length = 0; active = null
  saveTokens(A)
  localStorage.setItem('tt_wedding_id', JSON.stringify(WA.id))
})
afterEach(async () => {
  try {
    cleanup(); active?.first.resolve(ok()); await flush()
    expect(active?.unexpected ?? []).toEqual([])
  } finally { vi.unstubAllGlobals() }
})

describe('favorite writes own session, mount and latest per-vendor intent', () => {
  for (const mode of ['PUT', 'DELETE'] as const) {
    it.each(['actor', 'new-sid', 'logout', 'unmount', 'observed-A-B-A'] as const)(`${mode}: held original 401 after %s cannot refresh, replay or roll back a retired action`, async boundary => {
      const h = network(mode), view = open(); await ready(h, A, mode)
      await click(h, 1); exactWire(h.writes()[0]!, mode)
      if (boundary === 'actor') await switchTo(h, B, mode)
      else if (boundary === 'new-sid') await switchTo(h, NEW_SID, mode)
      else if (boundary === 'logout') {
        await act(async () => { forgetLocally() })
        await waitFor(() => expect(favorites()).toEqual([])); await flush()
      } else if (boundary === 'unmount') { view.unmount(); await flush() }
      else {
        const from = h.calls.length
        // Storage is already A again, but both observed event payloads retire A's old action.
        for (const [oldValue, newValue] of [[A, B], [B, A]]) await act(async () => {
          window.dispatchEvent(new StorageEvent('storage', { key: 'tt_auth', oldValue: JSON.stringify(oldValue), newValue: JSON.stringify(newValue), storageArea: localStorage }))
        })
        await ready(h, A, mode, from)
      }
      const saved = { auth: auth(), favorites: stored(), ui: boundary === 'unmount' ? null : favorites() }, calls = h.calls.length, frames = snapshots.length
      await release(h, refusal(401))
      expect(h.refreshes()).toEqual([])
      expect(h.calls.slice(calls)).toEqual([])
      expect(h.writes()).toHaveLength(1)
      expect({ auth: auth(), favorites: stored(), ui: boundary === 'unmount' ? null : favorites() }).toEqual(saved)
      expect(snapshots.slice(frames).every(row => JSON.stringify(row) === JSON.stringify(saved.ui))).toBe(true)
    })

    it(`${mode}: late 500 cannot roll back fresh B data for the same vendor`, async () => {
      const h = network(mode); open(); await ready(h, A, mode); await click(h, 1)
      await switchTo(h, B, mode)
      expect(favorites().includes(TARGET)).toBe(mode === 'PUT')
      const saved = stored(), frames = snapshots.length
      await release(h, refusal(500))
      expect(favorites()).toEqual(bInitial(mode)); expect(stored()).toBe(saved)
      expect(snapshots.slice(frames).every(row => JSON.stringify(row) === saved)).toBe(true)
      expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toEqual([])
    })

    it.each(['actor', 'unmount'] as const)(`${mode}: retained render callback after %s has no optimism, storage or network authority`, async boundary => {
      const h = network(mode, { holdFirst: false }), view = open(); await ready(h, A, mode)
      const retained = bridge!.toggleFav
      if (boundary === 'actor') await switchTo(h, B, mode)
      else { view.unmount(); await flush() }
      const saved = stored(), calls = h.calls.length, frames = snapshots.length
      const ui = boundary === 'actor' ? favorites() : null
      await act(async () => { retained(TARGET) }); await flush()
      expect(stored()).toBe(saved); expect(h.calls.slice(calls)).toEqual([])
      expect(snapshots.slice(frames)).toEqual([])
      if (ui) expect(favorites()).toEqual(ui)
    })

    it(`${mode}: first error in three same-vendor taps cannot undo the latest successful intent`, async () => {
      const h = network(mode); open(); await ready(h, A, mode)
      await click(h, 1); await click(h, 2); await click(h, 3)
      expect(h.writes().map(c => c.method)).toEqual(mode === 'PUT' ? ['PUT', 'DELETE', 'PUT'] : ['DELETE', 'PUT', 'DELETE'])
      const expected = mode === 'PUT' ? [A_OTHER, TARGET] : [A_OTHER]
      expect(favorites()).toEqual(expected); expect(stored()).toBe(JSON.stringify(expected))
      await release(h, refusal(500))
      expect(favorites()).toEqual(expected); expect(stored()).toBe(JSON.stringify(expected)); expect(h.refreshes()).toEqual([])
    })

    it(`${mode}: obsolete 401 after a newer same-vendor intent does not refresh or replay`, async () => {
      const h = network(mode); open(); await ready(h, A, mode)
      await click(h, 1); await click(h, 2)
      const expected = initial(mode), saved = stored(), calls = h.calls.length
      expect(favorites()).toEqual(expected)
      await release(h, refusal(401))
      expect(h.refreshes()).toEqual([]); expect(h.calls.slice(calls)).toEqual([])
      expect(favorites()).toEqual(expected); expect(stored()).toBe(saved)
    })

    it(`${mode}: unchanged sub/sid refreshes once and replays the exact method, path and body`, async () => {
      const h = network(mode); open(); await ready(h, A, mode); await click(h, 1)
      exactWire(h.writes()[0]!, mode)
      await release(h, refusal(401))
      await waitFor(() => expect(h.writes()).toHaveLength(2))
      expect(h.refreshes()).toHaveLength(1)
      expect(h.refreshes()[0]!.rawBody).toBe(JSON.stringify({ refreshToken: A.refreshToken }))
      exactWire(h.writes()[1]!, mode, A_RENEWED.accessToken)
      expect(JSON.parse(auth()!)).toEqual(A_RENEWED)
      const expected = mode === 'PUT' ? [A_OTHER, TARGET] : [A_OTHER]
      expect(favorites()).toEqual(expected); expect(stored()).toBe(JSON.stringify(expected))
    })

    it(`${mode}: same-sub/sid token renewal preserves the current action's real 500 rollback`, async () => {
      const h = network(mode); open(); await ready(h, A, mode); await click(h, 1)
      await act(async () => { saveTokens(A_RENEWED) }); await flush()
      expect(favorites().includes(TARGET)).toBe(mode === 'PUT')
      await release(h, refusal(500))
      expect(favorites()).toEqual(initial(mode)); expect(stored()).toBe(JSON.stringify(initial(mode)))
      expect(JSON.parse(auth()!)).toEqual(A_RENEWED); expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toEqual([])
    })

    it(`${mode}: current 500 rolls back only its own vendor and preserves a later different-vendor write`, async () => {
      const h = network(mode); open(); await ready(h, A, mode)
      await click(h, 1); await click(h, 2, OTHER)
      expect(h.writes()[1]!.path).toBe(`/me/favorites/${OTHER}`); expect(h.writes()[1]!.method).toBe('PUT')
      await release(h, refusal(500))
      expect([...favorites()].sort()).toEqual([...initial(mode), OTHER].sort())
      expect(stored()).toBe(JSON.stringify(favorites())); expect(h.writes()).toHaveLength(2); expect(h.refreshes()).toEqual([])
    })
  }

  it('retained guest callback cannot become a registered action; a fresh empty-state callback can', async () => {
    saveTokens(null); localStorage.removeItem('tt_wedding_id')
    const h = network('PUT', { holdFirst: false, emptyMembership: true, emptyFavorites: true }); open()
    await waitFor(() => expect(bridge).not.toBeNull()); expect(favorites()).toEqual([])
    const guest = bridge!.toggleFav
    await act(async () => { saveTokens(B) })
    await waitFor(() => {
      expect(bootstrap().state).toBe('ready'); expect(bootstrap().wedding).toBeNull(); expect(favorites()).toEqual([])
      for (const path of ['/weddings', '/me/favorites']) expect(h.calls.some(c => c.path === path && c.authorization === `Bearer ${B.accessToken}` && c.response?.bodyUsed)).toBe(true)
    })
    await flush(); const saved = stored(), calls = h.calls.length, frames = snapshots.length
    await act(async () => { guest(TARGET) }); await flush()
    expect(stored()).toBe(saved); expect(favorites()).toEqual([]); expect(h.calls.slice(calls)).toEqual([]); expect(snapshots.slice(frames)).toEqual([])
    await click(h, 1); expect(favorites()).toEqual([TARGET]); expect(stored()).toBe(JSON.stringify([TARGET]))
    exactWire(h.writes()[0]!, 'PUT', B.accessToken)
  })

  it('guest hearts stay local and use no private API', async () => {
    saveTokens(null); localStorage.removeItem('tt_wedding_id')
    const h = network('PUT', { holdFirst: false }); open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'target heart' })) })
    expect(favorites()).toEqual([TARGET]); expect(stored()).toBe(JSON.stringify([TARGET]))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'target heart' })) })
    expect(favorites()).toEqual([]); expect(stored()).toBe('[]'); expect(h.calls).toEqual([])
  })

  it('current rapid different-vendor clicks preserve both hearts', async () => {
    const h = network('PUT', { holdFirst: false }); open(); await ready(h)
    // Same task: this is a normal current render's callback, not a retired one.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'target heart' }))
      fireEvent.click(screen.getByRole('button', { name: 'other heart' }))
    })
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    expect([...favorites()].sort()).toEqual([A_OTHER, TARGET, OTHER].sort()); expect(stored()).toBe(JSON.stringify(favorites()))
    expect(h.writes().map(c => [c.method, c.path])).toEqual([
      ['PUT', `/me/favorites/${TARGET}`], ['PUT', `/me/favorites/${OTHER}`],
    ])
    expect(h.refreshes()).toEqual([])
  })

  it('current rapid same-vendor clicks preserve the second opposite intent', async () => {
    const h = network('PUT', { holdFirst: false }); open(); await ready(h)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'target heart' }))
      fireEvent.click(screen.getByRole('button', { name: 'target heart' }))
    })
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    expect(h.writes().map(c => [c.method, c.path])).toEqual([
      ['PUT', `/me/favorites/${TARGET}`], ['DELETE', `/me/favorites/${TARGET}`],
    ])
    expect(favorites()).toEqual(initial('PUT')); expect(stored()).toBe(JSON.stringify(initial('PUT'))); expect(h.refreshes()).toEqual([])
  })
})
