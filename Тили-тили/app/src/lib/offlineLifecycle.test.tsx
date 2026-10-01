// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DayX } from '@/pages/Smart'
import { OfflineBanner } from '@/components/chrome'
import { StoreProvider } from './store'
import { OFFLINE_DAY_KEY } from './offlineDay'
import { saveTokens } from './api/client'

const token = (userId = 'u1', sessionId = 's1') => `e30.${btoa(JSON.stringify({ sub: userId, sid: sessionId }))}.test`
const authenticate = (userId = 'u1', sessionId = 's1') => saveTokens({ accessToken: token(userId, sessionId), refreshToken: `r-${sessionId}` })
const block = { id: 'b1', name: 'Saved ceremony', startsAt: '2027-06-14T11:00:00Z', endsAt: '2027-06-14T13:00:00Z', eventId: 'e1', location: 'Hall' }
const event = { id: 'e1', name: 'Ceremony', timeZone: 'Asia/Yekaterinburg', date: '2027-06-14', kind: 'main' }
const wedding = { id: 'w1', date: '2027-06-14', tz: 'Europe/Moscow', members: [{ user: { id: 'u1', name: 'Person' }, role: 'couple' }] }
const saved = () => ({ schema: 2, scope: { userId: 'u1', sessionId: 's1' }, role: 'couple', weddingId: 'w1', savedAt: '2027-06-14T10:00:00Z', etag: '"7"', weddingDate: '2027-06-14', weddingTimeZone: 'Europe/Moscow', timeline: [block], events: [event], planBActivatedAt: null, team: [] })
function setup(status = 200, options: { contextStatus?: number; contextEtag?: string; memberRole?: string; noMember?: boolean; timeline?: typeof block[]; slots?: unknown[] } = {}) {
  let currentStatus = status
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!
    if (path === '/weddings/w1/events' && options.contextStatus) return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Context access removed' } }), { status: options.contextStatus, headers: { 'content-type': 'application/json' } })
    if (path === '/weddings/w1/timeline' && currentStatus !== 200) {
      if (currentStatus === 0) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Access removed' } }), { status: currentStatus, headers: { 'content-type': 'application/json' } })
    }
    const routes: Record<string, unknown> = {
      '/weddings': [{ ...wedding, role: 'couple' }], '/weddings/w1': { ...wedding, members: options.noMember ? [] : [{ ...wedding.members[0], role: options.memberRole ?? 'couple' }] },
      '/weddings/w1/slots': options.slots ?? [], '/me/favorites': [], '/users/me': { id: 'u1', name: 'Person', isStaff: false, push: {}, quietHours: null },
      '/weddings/w1/timeline': options.timeline ?? [block], '/weddings/w1/events': [event], '/weddings/w1/planb': { checklist: [], activatedAt: null },
    }
    return new Response(JSON.stringify(routes[path] ?? {}), { headers: { 'content-type': 'application/json', etag: path.endsWith('/events') ? options.contextEtag ?? '"7"' : '"7"' } })
  })
  vi.stubGlobal('fetch', fetcher)
  return { fetcher, status: (next: number) => { currentStatus = next } }
}
const open = () => render(<MemoryRouter><StoreProvider><DayX /></StoreProvider></MemoryRouter>)

describe('DayX actual offline and access lifecycle', () => {
  beforeEach(() => {
    localStorage.clear(); authenticate()
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(new Date('2027-06-14T12:00:00Z'))
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  })
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('never restores an offline copy after an authoritative HTTP404', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved()))
    setup(404); open()
    await screen.findAllByText('Access removed')
    expect(screen.queryByText('Saved ceremony')).toBeNull()
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('does not label an authoritative reconnect HTTP404 as a server connection failure', async () => {
    const control = setup(); open(); await screen.findByText('● LIVE')
    await waitFor(() => expect(localStorage.getItem(OFFLINE_DAY_KEY)).not.toBeNull())
    fireEvent(window, new Event('offline'))
    await screen.findByText(/Версия снимка/)
    control.status(404); fireEvent(window, new Event('online'))
    await screen.findAllByText('Access removed')
    expect(screen.queryByText('Saved ceremony')).toBeNull()
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
    expect(screen.getByText(/Сохранённой программы нет/)).toBeTruthy()
    expect(screen.queryByText(/Нет связи с сервером/)).toBeNull()
  })
  it('never opens another session copy of the same wedding when network fails', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved()))
    authenticate('u1', 's2'); setup(0); open()
    await screen.findAllByText('Сервер недоступен. Попробуйте позже')
    expect(screen.queryByText('Saved ceremony')).toBeNull()
    await waitFor(() => expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull())
  })
  it('removes LIVE and disables irreversible actions immediately on offline event', async () => {
    setup(); open(); await screen.findByText('● LIVE')
    fireEvent(window, new Event('offline'))
    await waitFor(() => expect(screen.queryByText('● LIVE')).toBeNull())
    expect(screen.getByRole('button', { name: 'Активировать' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Чат дня X' })).toHaveProperty('disabled', true)
  })
  it('uses the captured event zone and revision during a genuine network failure', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved()))
    setup(0); open(); await screen.findByText('Saved ceremony')
    expect(screen.getByText(/Asia\/Yekaterinburg/).textContent).toContain('16:00')
    expect(screen.getByText(/Версия снимка/).textContent).toContain('7')
  })
  it.each([403, 410])('authoritative HTTP%s denies cached data and deletes it', async status => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved())); setup(status); open()
    await screen.findAllByText('Access removed')
    expect(screen.queryByText('Saved ceremony')).toBeNull()
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it.each([409, 422, 429, 501])('HTTP%s is not an offline success or proof of access revocation', async status => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved())); setup(status); open()
    await screen.findAllByText('Access removed')
    expect(screen.queryByText('Saved ceremony')).toBeNull()
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Активировать' })).toHaveProperty('disabled', true)
  })
  it('HTTP503 shows the captured read-only copy, not a current LIVE state', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved())); setup(503); open()
    await screen.findByText('Saved ceremony')
    expect(screen.queryByText('● LIVE')).toBeNull()
    expect(screen.getByRole('button', { name: 'Активировать' })).toHaveProperty('disabled', true)
  })
  it('writes a minimal versioned copy from live responses and can use it without remounting', async () => {
    const control = setup(); open(); await screen.findByText('● LIVE')
    await waitFor(() => expect(localStorage.getItem(OFFLINE_DAY_KEY)).not.toBeNull())
    const copy = JSON.parse(localStorage.getItem(OFFLINE_DAY_KEY)!)
    expect(copy.scope).toEqual({ userId: 'u1', sessionId: 's1' })
    expect(copy.etag).toBe('"7"'); expect(copy.events[0].timeZone).toBe(event.timeZone)
    control.status(0); fireEvent(window, new Event('offline'))
    await screen.findByText(/Версия снимка/)
    expect(screen.getByText('Saved ceremony')).toBeTruthy()
    const calls = control.fetcher.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(control.fetcher.mock.calls).toHaveLength(calls)
  })
  it('different timeline and context revisions never create a persisted snapshot', async () => {
    setup(200, { contextEtag: '"8"' }); open()
    await screen.findByText('Контекст программы другой версии')
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('a late successful timeline cannot restore the copy after a denied context', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved()))
    const control = setup(200, { contextStatus: 403 })
    let release!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).endsWith('/timeline')
      ? new Promise<Response>(resolve => { release = resolve }) : control.fetcher(input)))
    open(); await waitFor(() => expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull())
    expect(control.fetcher.mock.calls.some(([input]) => String(input).endsWith('/events'))).toBe(true)
    await act(async () => { release(new Response(JSON.stringify([block]), { headers: { 'content-type': 'application/json', etag: '"7"' } })) })
    await screen.findAllByText('Saved ceremony')
    await screen.findAllByText('Context access removed')
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
    fireEvent(window, new Event('offline'))
    expect(screen.queryByText('Saved ceremony')).toBeNull()
  })
  it('a known context refusal never starts an automatic retry burst before its state settles', async () => {
    const control = setup()
    let contextReads = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/events')) {
        contextReads++
        if (contextReads <= 3) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Context no longer exists' } }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
      return control.fetcher(input)
    }))
    open(); await screen.findAllByText('Saved ceremony')
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(contextReads).toBe(1)
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('a verified role change discards the former copy and captures only newly read crew', async () => {
    const old = { ...saved(), team: [{ id: 's-old', label: 'Photo', vendor: 'Old contact', phone: '+79990000001' }] }
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(old)); setup(200, { memberRole: 'helper' }); open()
    await screen.findByText('● LIVE')
    await waitFor(() => expect(JSON.parse(localStorage.getItem(OFFLINE_DAY_KEY)!).role).toBe('helper'))
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).not.toContain('Old contact')
    fireEvent(window, new Event('offline'))
    expect(screen.queryByText(/Old contact/)).toBeNull()
  })
  it('a successful wedding response without the session user never retains the old cache', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved())); setup(0, { noMember: true }); open()
    await screen.findAllByText('Сервер недоступен. Попробуйте позже')
    expect(screen.queryByText('Saved ceremony')).toBeNull()
    await waitFor(() => expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull())
  })
  it('reconnection reads again and does not replay an offline action or checkbox', async () => {
    const options = { timeline: [block] }
    const control = setup(200, options); open(); await screen.findByText('● LIVE')
    await waitFor(() => expect(localStorage.getItem(OFFLINE_DAY_KEY)).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Активировать' })); await screen.findByRole('button', { name: 'Подтвердить' })
    fireEvent(window, new Event('offline'))
    const button = screen.getByRole('button', { name: 'Активировать' })
    fireEvent.click(button)
    options.timeline = [{ ...block, name: 'Fresh ceremony' }]
    fireEvent(window, new Event('online')); await screen.findAllByText('Fresh ceremony')
    await waitFor(() => expect(screen.queryByText(/Версия снимка/)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Подтвердить' })).toBeNull()
    expect(control.fetcher.mock.calls.filter(([input]) => String(input).includes('/activate'))).toHaveLength(0)
  })
  it('session replacement while mounted removes old content and cannot reuse the previous crew state', async () => {
    const control = setup(); open(); await screen.findByText('● LIVE')
    await waitFor(() => expect(localStorage.getItem(OFFLINE_DAY_KEY)).not.toBeNull())
    control.status(0)
    await act(async () => { authenticate('u1', 's2') })
    await screen.findAllByText('Сервер недоступен. Попробуйте позже')
    expect(screen.queryByText('Saved ceremony')).toBeNull()
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('storage logout from another tab removes the in-memory offline copy', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(saved())); setup(0); open(); await screen.findByText('Saved ceremony')
    localStorage.clear()
    fireEvent(window, new StorageEvent('storage', { key: null }))
    await waitFor(() => expect(screen.queryByText('Saved ceremony')).toBeNull())
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBeNull()
  })
  it('offline connection status participates in layout and a saved contact has its own wrapped phone line', async () => {
    const copy = { ...saved(), team: [{ id: 's1', label: 'Photo', vendor: 'Long offline crew contact', phone: '+79990000001' }] }
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(copy))
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    setup(0)
    render(<MemoryRouter><StoreProvider><OfflineBanner /><DayX /></StoreProvider></MemoryRouter>)
    const status = await screen.findByTestId('connection-status')
    expect(status.className).not.toContain('fixed')
    expect(status.textContent).toBe('Нет сети — новые данные недоступны')
    await screen.findByText('Saved ceremony')
    const phone = screen.getByText('+79990000001')
    expect(phone.className).toContain('block')
    expect(phone.closest('a')?.getAttribute('href')).toBe('tel:+79990000001')
    expect(phone.closest('a')?.className).not.toContain('whitespace-nowrap')
  })
})
