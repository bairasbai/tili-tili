// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Invite from '@/pages/Invite'
import { saveTokens } from './api/client'
import { getGuestDay, saveGuestToken } from './api/guest'
import { setI18nLang } from './i18n'

// Exercise the real Invite/client with server-shaped, version-bound response fixtures.
const TOKEN = 'PRIVATE-GUEST-TOKEN'
const SOURCE = '9007199254740993'
const CAPTURED = '2027-06-13T06:00:00.123456Z'
const NAME = 'Permitted MAIN ceremony'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
})
const denied = () => json({ error: { code: 'gone', message: 'Guest link revoked' } }, 410)
const day = (name = NAME, sourceVersion = SOURCE) => ({
  date: '2027-06-14', tz: 'Asia/Yekaterinburg', sourceVersion, capturedAt: CAPTURED,
  venue: 'PRIVATE LIVE VENUE', dressCode: null, dressNote: 'PRIVATE DRESS NOTE',
  timeline: [{ id: 'main-block', name, startsAt: '2027-06-14T08:00:00.000Z', endsAt: '2027-06-14T08:30:00.000Z', location: 'Captured main hall', forGuests: true }],
  table: { name: 'PRIVATE TABLE' }, bus: { name: 'PRIVATE BUS', time: '12:00', carrier: 'PRIVATE CARRIER' },
  coordinator: { name: 'PRIVATE COORDINATOR', phone: '+79991234567' },
  chat: { open: true, opensAt: '2027-06-13T04:00:00.000Z', closesAt: '2027-06-15T18:59:59.000Z' },
})
const rsvp = {
  guestName: 'PRIVATE GUEST NAME', status: 'pending',
  wedding: { title: 'PRIVATE WEDDING TITLE', date: '2027-06-14', tz: 'Asia/Yekaterinburg', city: { name: 'PRIVATE CITY' }, inviteText: 'PRIVATE INVITATION TEXT', inviteThemeId: 0 },
  events: [{ id: 'additional', name: 'PRIVATE ADDITIONAL EVENT', isMain: false, date: '2027-06-15', timeZone: 'Asia/Yekaterinburg' }],
}
type Call = { path: string; method: string; headers: Headers }
function serve() {
  const calls: Call[] = []
  let down = false, code = 200, dayCode: number | null = null, current = day(), hold: Promise<Response> | null = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!
    calls.push({ path, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
    if (down) throw new TypeError('Failed to fetch')
    if (path === '/rsvp/' + TOKEN || path === '/join/' + TOKEN + '/day') {
      const status = path.endsWith('/day') ? dayCode ?? code : code
      if (status === 410) return denied()
      if (status === 503) return json({ error: { code: 'unavailable', message: 'Temporarily unavailable' } }, 503)
      if (path.endsWith('/day')) return hold ?? json(current, 200, { etag: `"${current.sourceVersion}"` })
      return json(rsvp)
    }
    if (path === '/rsvp/' + TOKEN + '/events') return json({ events: [] })
    if (path === '/join/' + TOKEN + '/menu-vote') return json({ question: '', options: [] })
    if (path === '/join/' + TOKEN + '/shuttle') return json({ routes: [] })
    if (path === '/join/' + TOKEN + '/hotels') return json([])
    throw new Error('Unexpected fixture request ' + path)
  }))
  return {
    calls, status: (value: number) => { code = value },
    dayStatus: (value: number) => { dayCode = value },
    replace: (name: string, version: string) => { current = day(name, version) },
    hold: (value: Promise<Response> | null) => { hold = value },
    offline: () => { down = true; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); fireEvent(window, new Event('offline')) },
    online: () => { down = false; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); fireEvent(window, new Event('online')) },
  }
}
const open = () => render(<MemoryRouter initialEntries={['/invite']}><Routes><Route path="/invite" element={<Invite />} /></Routes></MemoryRouter>)
const storedValues = (exclude: string[] = []) => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
  .filter(key => !exclude.includes(key)).map(key => localStorage.getItem(key) ?? '').join('')
async function warm(control: ReturnType<typeof serve>) {
  open(); await screen.findByText(NAME)
  expect(control.calls.some(c => c.path === '/join/' + TOKEN + '/day')).toBe(true)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
function readonlyCopy() {
  expect(screen.getByText(NAME)).toBeTruthy()
  expect(document.body.textContent).toContain('Офлайн-копия')
  expect(document.body.textContent).toContain('Актуальность и доступ не проверены')
  expect(document.body.textContent).toContain(SOURCE)
  expect(screen.queryByRole('button', { name: 'Открыть чат дня' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Открыть приглашение' })).toBeNull()
  expect(document.querySelector('a[href^="tel:"]')).toBeNull()
  for (const hidden of ['PRIVATE GUEST NAME', 'PRIVATE WEDDING TITLE', 'PRIVATE INVITATION TEXT', 'PRIVATE ADDITIONAL EVENT', 'PRIVATE LIVE VENUE', 'PRIVATE COORDINATOR', '+79991234567', 'PRIVATE TABLE', 'PRIVATE BUS', 'PRIVATE DRESS NOTE']) {
    expect(document.body.textContent).not.toContain(hidden)
  }
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); saveTokens(null); saveGuestToken(TOKEN); setI18nLang('ru')
  vi.stubGlobal('crypto', webcrypto); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-06-13T12:00:00.000Z'))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('T009 guest MAIN day offline lifecycle through the real Invite and API client', () => {
  it.each(['anonymous', 'registered'] as const)('%s cold offline reload restores only saved MAIN program beyond RSVP gate, without HTTP or authority', async kind => {
    if (kind === 'registered') saveTokens({ accessToken: 'e30.' + btoa(JSON.stringify({ sub: 'registered-user', sid: 'registered-session' })) + '.test', refreshToken: 'registered-refresh' })
    const control = serve(); await warm(control)
    control.offline(); cleanup(); const previous = control.calls.length; open()
    await screen.findByText(NAME)
    readonlyCopy(); expect(control.calls).toHaveLength(previous)
    const cache = storedValues(['tt_guest_token', 'tt_auth', 'tt_lang'])
    expect(cache).toContain(SOURCE); expect(cache).toContain(CAPTURED)
    expect(cache).not.toContain(TOKEN); expect(cache).not.toContain('+79991234567'); expect(cache).not.toContain('PRIVATE INVITATION TEXT')
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('cold reload on network 5xx preserves a labelled stale minimal program instead of treating outage as link denial', async () => {
    const control = serve(); await warm(control); cleanup(); control.status(503); open()
    await screen.findByText(NAME)
    readonlyCopy(); expect(localStorage.getItem('tt_guest_token')).toBe(TOKEN)
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('reconnect keeps copy read-only until fresh GET completes and never replays RSVP, chat or booking writes', async () => {
    const control = serve(); await warm(control); control.offline(); cleanup(); open()
    await screen.findByText(NAME); readonlyCopy()
    let finish!: (response: Response) => void
    control.hold(new Promise(resolve => { finish = resolve })); const previous = control.calls.length; control.online()
    await waitFor(() => expect(control.calls.slice(previous).some(c => c.path === '/join/' + TOKEN + '/day')).toBe(true))
    readonlyCopy(); expect(control.calls.slice(previous).every(c => c.method === 'GET')).toBe(true)
    finish(json(day('Fresh MAIN program', '9007199254740994'), 200, { etag: '"9007199254740994"' }))
    await screen.findByText('Fresh MAIN program')
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('known 410 on a concurrent same guest-day read prevents late older day data from appearing or being saved', async () => {
    const control = serve(); let finish!: (response: Response) => void
    control.hold(new Promise(resolve => { finish = resolve })); open()
    await waitFor(() => expect(control.calls.some(c => c.path === '/join/' + TOKEN + '/day')).toBe(true))
    control.status(410)
    await expect(getGuestDay(TOKEN)).rejects.toMatchObject({ status: 410 })
    await act(async () => { finish(json(day(), 200, { etag: `"${SOURCE}"` })); await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(screen.queryByText(NAME)).toBeNull()
    expect(storedValues()).not.toContain(NAME)
    control.offline(); cleanup(); open(); expect(screen.queryByText(NAME)).toBeNull()
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it.each(['replacement', 'removal'] as const)('%s of the guest token withdraws the old visible copy without granting the new token cached access', async action => {
    const control = serve(); await warm(control); control.offline()
    const next = action === 'replacement' ? 'OTHER-GUEST-TOKEN' : null
    saveGuestToken(next)
    fireEvent(window, new StorageEvent('storage', { key: 'tt_guest_token', oldValue: TOKEN, newValue: next ?? '' }))
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    if (action === 'removal') expect(document.body.textContent).toContain('Нужна ссылка из приглашения')
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('a cold known 410 remains a hard link denial with no invented program and no mutation', async () => {
    const control = serve(); control.status(410); open()
    await screen.findByText('Ссылка больше не действует')
    expect(screen.queryByText(NAME)).toBeNull()
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
    expect(control.calls.some(c => c.path === '/join/' + TOKEN + '/day')).toBe(false)
  })
  it('unavailable WebCrypto never creates a token-containing namespace fallback', async () => {
    vi.stubGlobal('crypto', undefined); const control = serve(); await warm(control)
    control.offline(); cleanup(); open()
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    const copies = storedValues(['tt_guest_token'])
    expect(copies).not.toContain(TOKEN); expect(copies).not.toContain(NAME)
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('observed A→B→A cannot revive the earlier visible or persisted MAIN copy', async () => {
    const control = serve(); await warm(control); control.offline()
    await act(async () => { saveGuestToken('OTHER'); saveGuestToken(TOKEN) })
    await waitFor(() => expect(screen.queryByText(NAME)).toBeNull())
    expect(storedValues(['tt_guest_token'])).not.toContain(NAME)
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('removal while the cold namespace hash is pending prevents late restoration', async () => {
    const control = serve(); await warm(control); cleanup(); control.offline()
    let finish!: (value: ArrayBuffer) => void
    const digest = vi.fn(() => new Promise<ArrayBuffer>(resolve => { finish = resolve }))
    vi.stubGlobal('crypto', { subtle: { digest } }); open()
    await waitFor(() => expect(digest).toHaveBeenCalled())
    await act(async () => { saveGuestToken(null); finish(new Uint8Array(32).buffer) })
    expect(screen.queryByText(NAME)).toBeNull()
    expect(document.body.textContent).toContain('Нужна ссылка из приглашения')
    expect(storedValues(['tt_guest_token'])).not.toContain(NAME)
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('without WebCrypto a warm offline transition hides live contacts and RSVP/chat actions', async () => {
    vi.stubGlobal('crypto', undefined); const control = serve(); await warm(control); control.offline()
    await screen.findByText('Нет связи. Сохранённой программы на этом устройстве нет.')
    expect(screen.queryByText(NAME)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Приду' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Открыть чат дня' })).toBeNull()
    expect(document.querySelector('a[href^="tel:"]')).toBeNull()
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('English offline copy keeps version/time provenance and read-only warning visible', async () => {
    setI18nLang('en'); const control = serve(); await warm(control); control.offline(); cleanup(); open()
    await screen.findByText(NAME)
    expect(document.body.textContent).toContain('Offline copy')
    expect(document.body.textContent).toContain('Current version and access have not been verified.')
    expect(document.body.textContent).toContain('Server snapshot time')
    expect(document.body.textContent).toContain('Schedule version')
    expect(document.body.textContent).toContain(SOURCE)
    expect(document.body.textContent).toContain(CAPTURED)
    expect(document.querySelector('a[href^="tel:"]')).toBeNull()
    expect(control.calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('a day-only known 410 closes the reader without an automatic RSVP/day retry loop', async () => {
    const control = serve(); control.dayStatus(410); open()
    await screen.findByText('Ссылка больше не действует')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(control.calls.filter(call => call.path === '/join/' + TOKEN + '/day')).toHaveLength(1)
    expect(control.calls.filter(call => call.path === '/rsvp/' + TOKEN)).toHaveLength(1)
    expect(screen.queryByText(NAME)).toBeNull()
    expect(control.calls.every(call => call.method === 'GET')).toBe(true)
  })
})
