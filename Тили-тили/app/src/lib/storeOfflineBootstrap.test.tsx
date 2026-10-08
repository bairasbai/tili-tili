// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from './store'
import { useServerHealth } from './api/health'
import { saveTokens } from './api/client'
import { offlineGeneration, offlineScope } from './offlineAccess'
import { OFFLINE_DAY_KEY, recallDay, rememberDay, type OfflineDay } from './offlineDay'

const WEDDING = { id: 'own-bootstrap', title: 'Unrelated account wedding', date: '2027-06-14', tz: 'Europe/Moscow', role: 'couple' }
const jwt = (sid = 'session-A') => 'e30.' + btoa(JSON.stringify({ sub: 'account', sid })) + '.test'
type Call = { path: string; method: string }
function serve() {
  const calls: Call[] = []
  let list: unknown = [WEDDING], listStatus = 200
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    calls.push({ path, method: options?.method ?? 'GET' })
    if (!navigator.onLine) throw new TypeError('Failed to fetch')
    const body = path === '/health' ? { status: 'ok' } : path === '/weddings' ? list
      : path === '/weddings/own-bootstrap' ? WEDDING : path === '/weddings/own-bootstrap/slots' || path === '/me/favorites' ? [] : null
    if (body === null) throw new Error('Unexpected fixture path ' + path)
    return new Response(JSON.stringify(body), { status: path === '/weddings' ? listStatus : 200, headers: { 'content-type': 'application/json' } })
  }))
  return { calls, list: (value: unknown, status = 200) => { list = value; listStatus = status } }
}
function Probe() {
  const store = useStore(), health = useServerHealth()
  return <div><p data-testid="health">{health}</p><p data-testid="weddings">{store.weddingsState}</p>
    <p data-testid="wedding">{store.weddingId ?? 'none'}</p><p data-testid="slots">{store.slotsState}</p>
    <p data-testid="date">{store.weddingDate ?? 'none'}</p><button onClick={() => store.setWeddingId('new-wedding-B')}>Select new wedding B</button></div>
}
const open = () => render(<StrictMode><StoreProvider><Probe /></StoreProvider></StrictMode>)
const connect = (online: boolean) => { vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online); fireEvent(window, new Event(online ? 'online' : 'offline')) }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); saveTokens(null)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('cold offline actual StoreProvider and health automatic reads', () => {
  it.each(['anonymous', 'registered'] as const)('%s cold offline makes zero API attempts', async mode => {
    if (mode === 'registered') {
      saveTokens({ accessToken: jwt(), refreshToken: 'registered-refresh' })
      localStorage.setItem('tt_wedding_id', JSON.stringify(WEDDING.id)); localStorage.setItem('tt_wedding_date', JSON.stringify('2027-01-01'))
    }
    const control = serve(); open(); await flush()
    expect(control.calls).toEqual([])
    expect(screen.getByTestId('health').textContent).toBe('unknown')
    expect(control.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it.each(['anonymous', 'registered'] as const)('%s reconnect resumes actual read-only bootstrap/health', async mode => {
    if (mode === 'registered') saveTokens({ accessToken: jwt(), refreshToken: 'registered-refresh' })
    const control = serve(); open(); await flush(); connect(true)
    await waitFor(() => expect(screen.getByTestId('health').textContent).toBe('up'))
    if (mode === 'registered') {
      await waitFor(() => expect(screen.getByTestId('weddings').textContent).toBe('ready'))
      await waitFor(() => expect(screen.getByTestId('slots').textContent).toBe('ready'))
      await waitFor(() => expect(control.calls.some(call => call.path === '/me/favorites')).toBe(true))
      expect(control.calls.filter(call => call.path === '/weddings')).toHaveLength(1)
      expect(screen.getByTestId('date').textContent).toBe(WEDDING.date)
    } else expect(control.calls.map(call => call.path)).toEqual(['/health'])
    expect(control.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it('reconnect rechecks a remembered wedding cancellation and clears its date without replaying mutations', async () => {
    saveTokens({ accessToken: jwt(), refreshToken: 'registered-refresh' }); connect(true)
    const control = serve(); open()
    await waitFor(() => expect(screen.getByTestId('weddings').textContent).toBe('ready'))
    await waitFor(() => expect(screen.getByTestId('date').textContent).toBe(WEDDING.date))
    connect(false); await flush(); const before = control.calls.length; control.list([]); connect(true)
    await waitFor(() => expect(screen.getByTestId('wedding').textContent).toBe('none'))
    await waitFor(() => expect(screen.getByTestId('date').textContent).toBe('none'))
    expect(control.calls.slice(before).some(call => call.path === '/weddings')).toBe(true)
    expect(control.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it('logout while offline does not bootstrap the old account on reconnect', async () => {
    saveTokens({ accessToken: jwt(), refreshToken: 'registered-refresh' })
    localStorage.setItem('tt_wedding_id', JSON.stringify(WEDDING.id)); const control = serve(); open(); await flush()
    saveTokens(null); fireEvent(window, new StorageEvent('storage', { key: 'tt_auth', oldValue: 'old', newValue: null })); connect(true)
    await waitFor(() => expect(screen.getByTestId('wedding').textContent).toBe('none'))
    expect(control.calls.filter(call => call.path !== '/health')).toEqual([])
    expect(offlineScope(null)).toBeNull()
  })
  it('online StrictMode still shares one startup wedding-list promise', async () => {
    saveTokens({ accessToken: jwt(), refreshToken: 'registered-refresh' }); connect(true)
    const control = serve(); open()
    await waitFor(() => expect(screen.getByTestId('slots').textContent).toBe('ready'))
    expect(control.calls.filter(call => call.path === '/weddings')).toHaveLength(1)
    expect(screen.getByTestId('date').textContent).toBe(WEDDING.date)
  })
  it('a list read completed while offline cannot restore a wedding before the fresh reconnect read', async () => {
    saveTokens({ accessToken: jwt(), refreshToken: 'registered-refresh' }); connect(true)
    let finish!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const control = serve(), actualFetch = globalThis.fetch
    let held = true
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      if (String(input) === '/api/weddings' && held) return pending
      return actualFetch(input, options)
    }))
    open(); await flush(); connect(false); await flush()
    await act(async () => { finish(new Response(JSON.stringify([WEDDING]), { headers: { 'content-type': 'application/json' } })) })
    expect(screen.getByTestId('wedding').textContent).toBe('none')
    held = false; control.list([]); connect(true)
    await waitFor(() => expect(screen.getByTestId('weddings').textContent).toBe('ready'))
    expect(screen.getByTestId('wedding').textContent).toBe('none')
    expect(control.calls.filter(call => call.path === '/weddings')).toHaveLength(1)
  })
  it('an already scheduled health timer observes actual offline status and unmount cancels its successor', async () => {
    connect(true); vi.useFakeTimers()
    const control = serve()
    function Health() { return <p>{useServerHealth()}</p> }
    const view = render(<Health />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(control.calls).toHaveLength(1)
    /* Сеть пропала раньше React-события: очередь таймера тоже обязана её проверить. */
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(control.calls).toHaveLength(1)
    connect(true); await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(control.calls).toHaveLength(2)
    view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(control.calls).toHaveLength(2)
  })
  it.each([['previous wedding', [WEDDING]], ['empty list', []]])('ordinary new-wedding selection does not replay the stale %s startup membership into a valid B copy', async (_label, list) => {
    saveTokens({ accessToken: jwt(), refreshToken: 'registered-refresh' }); connect(true)
    const control = serve(); control.list(list)
    const actualFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
      const path = String(input)
      if (path.startsWith('/api/weddings/new-wedding-B')) return Promise.resolve(new Response(JSON.stringify(path.endsWith('/slots') ? [] : { ...WEDDING, id: 'new-wedding-B' }), { headers: { 'content-type': 'application/json' } }))
      return actualFetch(input, options)
    }))
    open(); await waitFor(() => expect(screen.getByTestId('weddings').textContent).toBe('ready'))
    const scope = offlineScope(jwt())!
    const snapshot: OfflineDay = { schema: 2, scope, role: 'couple', weddingId: 'new-wedding-B', savedAt: '2027-06-14T10:00:00Z', etag: '"12"', weddingDate: WEDDING.date, weddingTimeZone: WEDDING.tz, timeline: [{ id: 'B-block', name: 'New legitimate B program', startsAt: '2027-06-14T11:00:00Z', endsAt: null, eventId: null, location: null }], events: [], planBActivatedAt: null, team: [] }
    /* Действительная копия той же сессии могла прийти из другой вкладки после
       create/join: публичный setter не выдаёт старому списку новую authority. */
    rememberDay(snapshot, offlineGeneration()); expect(recallDay('new-wedding-B', scope)).toEqual(snapshot)
    const saved = localStorage.getItem(OFFLINE_DAY_KEY)
    fireEvent.click(screen.getByRole('button', { name: 'Select new wedding B' }))
    await waitFor(() => expect(screen.getByTestId('wedding').textContent).toBe('new-wedding-B')); await flush()
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBe(saved)
    expect(recallDay('new-wedding-B', scope)).toEqual(snapshot)
    expect(control.calls.filter(call => call.path === '/weddings')).toHaveLength(1)
  })
})
