// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Invite from '@/pages/Invite'
import { saveTokens } from './api/client'
import { getGuestEventDaySnapshot, saveGuestToken } from './api/guest'
import { GUEST_EVENT_OFFLINE_KEY, forgetGuestDay, guestEventReadTicket, recallGuestEvent, rememberGuestEvent, selectGuestEvent } from './guestDayOffline'
import { setI18nLang } from './i18n'

const TOKEN = 'PRIVATE-GUEST-TOKEN'
const selector = { eventId: '1111abcd-1111-4111-8111-111111111111', guestId: '2222abcd-2222-4222-8222-222222222222' }
const other = { eventId: '33333333-3333-4333-8333-333333333333', guestId: '44444444-4444-4444-8444-444444444444' }
const SOURCE = '9007199254740993', CAPTURED = '2027-06-13T06:00:00.123456Z'
const NAME = 'Permitted additional programme'
const route = (scope = selector) => '/invite?' + new URLSearchParams(scope).toString()
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
})
const day = (name = NAME, scope = selector, version = SOURCE) => ({
  programme: { kind: 'additional', ...scope }, date: null, tz: null, sourceVersion: version, capturedAt: CAPTURED,
  venue: 'PRIVATE EVENT LOCATION', dressCode: null, dressNote: null, table: null, bus: null, coordinator: null,
  chat: { open: false, opensAt: null, closesAt: null },
  timeline: [{ id: 'extra-block', name, startsAt: '2027-06-16T08:00:00.000Z', endsAt: null, location: 'Permitted block hall', forGuests: true }],
})
type Call = { path: string; eventId: string | null; guestId: string | null; method: string; headers: Headers }
function serve() {
  const calls: Call[] = []
  let down = false, code = 200, current = day(), hold: Promise<Response> | null = null, closed = false
  let mainStatus = 'no'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace(/^\/api/, '')
    const eventId = url.searchParams.get('eventId'), guestId = url.searchParams.get('guestId')
    calls.push({ path, eventId, guestId, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
    if (down) throw new TypeError('Failed to fetch')
    if (path === '/join/' + TOKEN + '/day' && eventId && guestId) {
      if (code !== 200) return json({ error: { code: code === 410 ? 'gone' : 'not_found', message: code === 410 ? 'Guest link revoked' : 'Selected event refused' } }, code)
      if (hold && eventId === selector.eventId) return hold
      const selected = eventId === selector.eventId ? current : day('Different person/event programme', other)
      return json(selected, 200, { etag: `"${selected.sourceVersion}"` })
    }
    if (path === '/rsvp/' + TOKEN) return json({ guestName: 'PRIVATE PERSON', status: mainStatus,
      wedding: { title: 'PRIVATE WEDDING TITLE', date: null, tz: 'Europe/Moscow', inviteThemeId: 0 }, events: [] })
    if (path === '/rsvp/' + TOKEN + '/events') return json({ events: [{
      event: { id: selector.eventId, name: 'PRIVATE EVENT NAME', kind: 'other', isMain: false, date: null, timeZone: null, location: null },
      deadline: { state: closed ? 'closed' : 'open', date: '2027-06-15', timeZone: 'Europe/Moscow', closesAt: '2027-06-15T21:00:00Z' },
      people: [{ guestId: selector.guestId, name: 'PRIVATE INVITED PERSON', status: 'declined', source: 'guest_response', version: '1', request: null }],
    }] })
    throw new Error('Unexpected fixture request ' + path)
  }))
  return {
    calls, status: (value: number) => { code = value }, mainStatus: (value: string) => { mainStatus = value },
    closed: () => { closed = true }, replace: (name: string, version: string) => { current = day(name, selector, version) },
    hold: (value: Promise<Response> | null) => { hold = value },
    offline: () => { down = true; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); fireEvent(window, new Event('offline')) },
    online: () => { down = false; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); fireEvent(window, new Event('online')) },
  }
}
function Switcher() {
  const nav = useNavigate()
  return <div><button onClick={() => nav(route())}>Select A</button><button onClick={() => nav(route(other))}>Select B</button></div>
}
const open = (entry = route(), controls = false) => render(<MemoryRouter initialEntries={[entry]}>
  {controls && <Switcher />}<Routes><Route path="/invite" element={<Invite />} /></Routes>
</MemoryRouter>)
async function warm() { open(); await screen.findByText(NAME); await waitFor(() => expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toContain(NAME)) }
function readonlyCopy() {
  expect(screen.getByText(NAME)).toBeTruthy()
  expect(document.body.textContent).toContain('Офлайн-копия')
  expect(document.body.textContent).toContain('Актуальность и доступ не проверены.')
  expect(document.body.textContent).toContain(SOURCE); expect(document.body.textContent).toContain(CAPTURED)
  expect(screen.queryByRole('button', { name: 'Приду' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Открыть чат дня' })).toBeNull()
  expect(document.querySelector('a[href^="tel:"]')).toBeNull()
  for (const forbidden of ['PRIVATE PERSON', 'PRIVATE INVITED PERSON', 'PRIVATE EVENT NAME', 'PRIVATE WEDDING TITLE', 'PRIVATE EVENT LOCATION']) expect(document.body.textContent).not.toContain(forbidden)
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); saveTokens(null); saveGuestToken(TOKEN); forgetGuestDay(); selectGuestEvent(null); setI18nLang('ru')
  vi.stubGlobal('crypto', webcrypto); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-13T12:00:00Z'))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); selectGuestEvent(null); setI18nLang('ru') })

describe('selected invited person programme through real Invite and API client', () => {
  it('a valid uppercase UUID deep-link reads and reloads the same canonical selected programme', async () => {
    const upper = { eventId: selector.eventId.toUpperCase(), guestId: selector.guestId.toUpperCase() }
    const control = serve(); open(route(upper)); await screen.findByText(NAME)
    expect(control.calls).toHaveLength(1)
    expect(control.calls[0]).toMatchObject({ eventId: selector.eventId, guestId: selector.guestId })
    control.offline(); cleanup(); open(route(upper)); await screen.findByText(NAME); readonlyCopy()
    expect(control.calls).toHaveLength(1)
  })
  it.each(['anonymous', 'registered'] as const)('%s selected view reads without MAIN RSVP/date/eve gate and cold reload makes no HTTP', async kind => {
    if (kind === 'registered') saveTokens({ accessToken: 'unrelated-account', refreshToken: 'unrelated-refresh' })
    const control = serve(); await warm()
    expect(control.calls).toHaveLength(1)
    expect(control.calls[0]).toMatchObject({ eventId: selector.eventId, guestId: selector.guestId, method: 'GET' })
    expect(control.calls[0]!.headers.has('authorization')).toBe(false)
    expect(screen.getByText('Дата не задана')).toBeTruthy(); expect(screen.getByText('Часовой пояс не задан')).toBeTruthy()
    expect(screen.getByText('2027-06-16T08:00:00.000Z')).toBeTruthy()
    control.offline(); cleanup(); const previous = control.calls.length; open()
    await screen.findByText(NAME); readonlyCopy(); expect(control.calls).toHaveLength(previous)
    const raw = localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)!
    for (const forbidden of [TOKEN, selector.eventId, selector.guestId, 'PRIVATE PERSON', 'PRIVATE EVENT LOCATION']) expect(raw).not.toContain(forbidden)
  })
  it.each(['open', 'closed'] as const)('current invited person can open programme with declined RSVP and %s deadline', async deadline => {
    const control = serve(); if (deadline === 'closed') control.closed()
    open('/invite')
    const button = await screen.findByRole('button', { name: 'Открыть программу — PRIVATE INVITED PERSON' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button); await screen.findByText(NAME)
    expect(control.calls.filter(call => call.path.endsWith('/day'))).toEqual([expect.objectContaining({ eventId: selector.eventId, guestId: selector.guestId })])
    expect(control.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it('reconnect retains a labelled read-only copy until selected fresh GET completes, with no write replay', async () => {
    const control = serve(); await warm(); control.offline(); cleanup(); open(); await screen.findByText(NAME); readonlyCopy()
    let finish!: (value: Response) => void
    control.hold(new Promise(resolve => { finish = resolve })); const previous = control.calls.length; control.online()
    await waitFor(() => expect(control.calls.length).toBe(previous + 1)); readonlyCopy()
    finish(json(day('Fresh selected programme', selector, '9007199254740994'), 200, { etag: '"9007199254740994"' }))
    await screen.findByText('Fresh selected programme')
    expect(screen.queryByText('Офлайн-копия')).toBeNull()
    expect(control.calls.every(call => call.method === 'GET' && !!call.eventId && !!call.guestId)).toBe(true)
  })
  it.each([403, 404, 410])('selected%s withdraws copy, has no automatic retry loop, and cannot be restored cold', async status => {
    const control = serve(); await warm(); control.offline(); cleanup(); open(); await screen.findByText(NAME)
    control.status(status); const previous = control.calls.length; control.online()
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(control.calls).toHaveLength(previous + 1)
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
    control.offline(); cleanup(); open(); expect(screen.queryByText(NAME)).toBeNull()
    expect(control.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it('network503 preserves a labelled minimal copy rather than treating outage as denial', async () => {
    const control = serve(); await warm(); cleanup(); control.status(503); open()
    await screen.findByText(NAME); readonlyCopy()
    expect(localStorage.getItem('tt_guest_token')).toBe(TOKEN)
    expect(control.calls.every(call => call.method === 'GET')).toBe(true)
  })
  it.each(['replacement', 'removal'] as const)('token%s withdraws old selected body and copy immediately', async action => {
    const control = serve(); await warm(); control.offline()
    await act(async () => saveGuestToken(action === 'replacement' ? 'OTHER' : null))
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
    if (action === 'removal') expect(screen.getByText('Нужна ссылка из приглашения')).toBeTruthy()
  })
  it('selected route A→B→A never shows or caches an older pending200', async () => {
    const control = serve(); let finish!: (value: Response) => void
    control.hold(new Promise(resolve => { finish = resolve })); open(route(), true)
    await waitFor(() => expect(control.calls).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Select B' })); await screen.findByText('Different person/event programme')
    fireEvent.click(screen.getByRole('button', { name: 'Select A' }))
    expect(screen.queryByText('Different person/event programme')).toBeNull()
    await waitFor(() => expect(control.calls).toHaveLength(3))
    control.status(404)
    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })
    await act(async () => finish(json(day('Old pending programme'), 200, { etag: `"${SOURCE}"` })))
    expect(screen.queryByText('Old pending programme')).toBeNull()
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).not.toContain('Old pending programme')
    expect(await recallGuestEvent(guestEventReadTicket(TOKEN, other))).not.toBeNull()
  })
  it('a pending cold namespace cannot restore after route/person selection changes', async () => {
    const control = serve(); await warm(); cleanup(); control.offline()
    const pending: ((value: ArrayBuffer) => void)[] = []
    vi.stubGlobal('crypto', { subtle: { digest: () => new Promise<ArrayBuffer>(resolve => { pending.push(resolve) }) } })
    open(route(), true); await waitFor(() => expect(pending.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Select B' }))
    await act(async () => { for (const finish of pending) finish(new Uint8Array(32).buffer) })
    expect(screen.queryByText(NAME)).toBeNull()
  })
  it('another event or person deep-link cannot use the saved opaque selected copy', async () => {
    const control = serve(); await warm(); cleanup(); control.offline(); open(route({ ...selector, guestId: other.guestId }))
    await screen.findByText('Нет связи. Сохранённой программы на этом устройстве нет.')
    expect(screen.queryByText(NAME)).toBeNull(); expect(control.calls).toHaveLength(1)
  })
  it('English selected offline view preserves honest nullable metadata and provenance', async () => {
    const control = serve(); await warm(); cleanup(); control.offline(); setI18nLang('en'); open()
    await screen.findByText(NAME)
    expect(screen.getByText('Event programme')).toBeTruthy()
    expect(screen.getByText('Offline copy')).toBeTruthy()
    expect(screen.getByText('Date not set')).toBeTruthy()
    expect(screen.getByText('Time zone not set')).toBeTruthy()
    expect(document.body.textContent).toContain(CAPTURED); expect(document.body.textContent).toContain(SOURCE)
    expect(document.querySelector('a[href^="tel:"]')).toBeNull()
  })
  it.each(['/invite?eventId=' + selector.eventId, '/invite?eventId=bad&guestId=' + selector.guestId, route() + '&guestId=' + selector.guestId])('invalid selector URL%s stays visible without HTTP or cache authority', async entry => {
    const control = serve(); open(entry)
    expect(screen.getByRole('alert').textContent).toContain('не выбраны корректно')
    expect(control.calls).toHaveLength(0); expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('missing crypto never restores an identity-bearing or raw-token fallback selected copy', async () => {
    vi.stubGlobal('crypto', undefined); const control = serve(); open(); await screen.findByText(NAME)
    control.offline(); cleanup(); open(); await screen.findByText('Нет связи. Сохранённой программы на этом устройстве нет.')
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
    expect(screen.queryByText(NAME)).toBeNull()
  })
  it('confirmed cross-tab removal withdraws the rendered selected copy and fences re-entry', async () => {
    const control = serve(); await warm(); control.offline(); await screen.findByText('Офлайн-копия')
    const oldValue = localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)
    localStorage.removeItem(GUEST_EVENT_OFFLINE_KEY)
    fireEvent(window, new StorageEvent('storage', { key: GUEST_EVENT_OFFLINE_KEY, oldValue, newValue: null }))
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('only allowed minimal data from an injected copy appears, never saved person identity', async () => {
    const control = serve()
    await rememberGuestEvent(guestEventReadTicket(TOKEN, selector), { ...day(), guestName: 'PRIVATE PERSON' }, `"${SOURCE}"`)
    const raw = JSON.parse(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)!) as { entries: Record<string, unknown>[] }
    raw.entries[0]!.guestName = 'PRIVATE PERSON'; localStorage.setItem(GUEST_EVENT_OFFLINE_KEY, JSON.stringify(raw))
    control.offline(); open(); await screen.findByText(NAME); readonlyCopy(); expect(control.calls).toHaveLength(0)
  })
})
