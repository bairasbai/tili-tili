// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DayX } from '@/pages/Smart'
import { StoreProvider } from './store'
import { OFFLINE_DAY_KEY } from './offlineDay'
import { instant, programTime, timelineNow } from './timelineClock'

const wedding = { id: 'w1', title: 'Test', date: '2027-06-14', tz: 'Asia/Yekaterinburg', city: { name: 'Уфа' } }
const block = (id: string, startsAt: string | null, endsAt: string | null, eventId?: string) => ({
  id, name: `Блок ${id}`, startsAt, endsAt, eventId, location: null, forGuests: true,
})
const at = (hour: string) => `2027-06-14T${hour}:00.000Z`
function serve(timeline: unknown[], contexts: unknown[] = [], down = false, denyContexts = false, versions = { timeline: '"1"', contexts: '"1"' }) {
  const routes: Record<string, unknown> = {
    '/weddings': [{ ...wedding, role: 'couple' }], '/weddings/w1': wedding,
    '/weddings/w1/slots': [], '/me/favorites': [],
    '/users/me': { id: 'u1', name: 'Test', isStaff: false, push: {}, quietHours: null },
    '/weddings/w1/timeline': timeline, '/weddings/w1/events': contexts,
    '/weddings/w1/planb': { checklist: [], activatedAt: null },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!
    if (down && ['/weddings/w1/timeline', '/weddings/w1/events', '/weddings/w1'].includes(path)) throw new TypeError('Failed to fetch')
    if (denyContexts && path === '/weddings/w1/events') return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Нет доступа к мероприятиям' } }), { status: 403, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(routes[path] ?? {}), { status: 200, headers: { 'content-type': 'application/json', etag: path.endsWith('/events') ? versions.contexts : versions.timeline } })
  }))
}
async function open(name: string) {
  const view = render(<MemoryRouter><StoreProvider><DayX /></StoreProvider></MemoryRouter>)
  await screen.findAllByText(name)
  return view
}
const panel = (view: ReturnType<typeof render>) => view.container.querySelector('div.rounded-\\[26px\\]') as HTMLElement

describe('DayX known intervals and actual event clocks', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(at('12:00')))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('never calls ended history LIVE or a nonempty timeline empty', async () => {
    serve([block('old', '2020-01-01T11:00:00Z', '2020-01-01T12:00:00Z')])
    const view = await open('Блок old')
    expect(panel(view).textContent).not.toContain('LIVE')
    expect(panel(view).textContent).not.toContain('Тайминг пуст')
  })
  it('does not invent an end for a started block', async () => {
    serve([block('unknown', at('11:00'), null)])
    const view = await open('Блок unknown')
    expect(panel(view).textContent).not.toContain('LIVE')
    expect(panel(view).textContent).toContain('Текущий блок не определён')
  })
  it('shows every parallel active block, ignoring manual list order', async () => {
    serve([block('a', at('11:00'), at('13:00')), block('b', at('11:30'), at('12:30'))])
    const view = await open('Блок a')
    expect(within(panel(view)).getByText('Блок a')).toBeTruthy()
    expect(within(panel(view)).getByText('Блок b')).toBeTruthy()
    expect(within(panel(view)).getAllByText('● LIVE')).toHaveLength(2)
  })
  it('uses earliest future start rather than manual sort', async () => {
    serve([block('late', at('15:00'), at('16:00')), block('near', at('13:00'), at('14:00'))])
    const view = await open('Блок late')
    expect(panel(view).textContent).toContain('Блок near')
    expect(panel(view).textContent).not.toContain('Блок late')
  })
  it('uses half-open intervals and moves to the next block at its start', async () => {
    serve([block('before', at('11:00'), at('12:00')), block('now', at('12:00'), at('12:01'))])
    const view = await open('Блок before')
    expect(panel(view).textContent).not.toContain('Блок before')
    expect(panel(view).textContent).toContain('Блок now')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await waitFor(() => expect(panel(view).textContent).not.toContain('LIVE'))
  })
  it('shows each event date, zone and full known interval', async () => {
    serve([block('main', at('13:00'), at('14:00'), 'main'), block('party', '2027-06-15T13:00:00Z', '2027-06-15T14:00:00Z', 'party')], [
      { id: 'main', name: 'Свадьба', kind: 'main', date: '2027-06-14', timeZone: 'Asia/Yekaterinburg' },
      { id: 'party', name: 'Второй день', kind: 'custom', date: '2027-06-15', timeZone: 'Europe/Moscow' },
    ])
    await open('Блок party')
    const main = screen.getAllByText('Блок main').at(-1)!.parentElement!
    const party = screen.getAllByText('Блок party').at(-1)!.parentElement!
    expect(main.textContent).toContain('18:00')
    expect(main.textContent).toContain('19:00')
    expect(main.textContent).toContain('Asia/Yekaterinburg')
    expect(party.textContent).toContain('16:00')
    expect(party.textContent).toContain('17:00')
    expect(party.textContent).toContain('15.06.2027')
    expect(party.textContent).toContain('Europe/Moscow')
  })
  it('does not assign wedding zone to an unknown event', async () => {
    serve([block('foreign', at('13:00'), at('14:00'), 'absent')])
    await open('Блок foreign')
    expect(screen.getAllByText(/Часовой пояс неизвестен/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/18:00/)).toBeNull()
  })
  it('offline copy is not a live state and does not guess an unknown captured event zone', async () => {
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: `e30.${btoa(JSON.stringify({ sub: 'u1', sid: 's1' }))}.test`, refreshToken: 'r' }))
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify({ schema: 2, scope: { userId: 'u1', sessionId: 's1' }, role: 'couple', etag: '"1"', weddingDate: wedding.date, weddingTimeZone: wedding.tz, events: [], weddingId: 'w1', savedAt: at('11:00'),
      timeline: [block('cached', at('11:30'), at('13:00'), 'main')], planBActivatedAt: null, team: [] }))
    serve([], [], true)
    const view = await open('Блок cached')
    expect(panel(view).textContent).not.toContain('LIVE')
    expect(panel(view).textContent).toContain('Офлайн-копия')
    expect(screen.getAllByText(/Часовой пояс неизвестен/).length).toBeGreaterThan(0)
  })
  it('surfaces denied event context instead of displaying wedding-local hours', async () => {
    serve([block('denied', at('13:00'), at('14:00'), 'main')], [], false, true)
    await open('Блок denied')
    expect(await screen.findByText('Нет доступа к мероприятиям')).toBeTruthy()
    expect(screen.queryByText(/18:00/)).toBeNull()
    expect(screen.getAllByText(/Часовой пояс неизвестен/).length).toBeGreaterThan(0)
  })
  it('never combines timeline and event contexts from different revisions', async () => {
    const versions = { timeline: '"1"', contexts: '"2"' }
    serve([block('mismatch', at('13:00'), at('14:00'), 'main')], [
      { id: 'main', name: 'Свадьба', kind: 'other', date: '2027-06-14', timeZone: 'Asia/Yekaterinburg' },
    ], false, false, versions)
    await open('Блок mismatch')
    expect(screen.queryAllByText(/18:00/)).toHaveLength(0)
    await screen.findByText('Контекст программы другой версии')
    versions.timeline = '"2"'
    fireEvent.click(screen.getByRole('button', { name: 'Обновить контекст программы' }))
    await waitFor(() => expect(screen.queryByText('Контекст программы другой версии')).toBeNull())
    expect(screen.getAllByText(/18:00/).length).toBeGreaterThan(0)
  })
})

describe('timeline clock boundaries and unknown values', () => {
  it('does not parse missing, invalid or timezone-less timestamps as instants', () => {
    for (const value of [null, undefined, '', 'not a date', '2027-06-14T11:00:00']) expect(instant(value)).toBeNull()
    expect(instant('2027-06-14T11:00:00+05:00')).toBe(Date.parse('2027-06-14T06:00:00Z'))
  })
  it('invalid and zero-length intervals cannot be active or completed', () => {
    for (const end of [null, 'broken', at('10:00'), at('11:00')]) {
      const result = timelineNow([block('invalid', at('11:00'), end)], new Date(at('12:00')))
      expect(result.active).toEqual([])
      expect(result.ended).toBe(false)
    }
  })
  it('invalid or missing IANA zone is not a browser-zone fallback', () => {
    expect(programTime(at('13:00'), null, 'ru')).toBeNull()
    expect(programTime(at('13:00'), 'Not/AZone', 'ru')).toBeNull()
    expect(programTime('broken', 'Europe/Moscow', 'ru')).toBeNull()
  })
  it('uses the actual local calendar day on each side of midnight', () => {
    expect(programTime('2027-06-14T23:30:00Z', 'Asia/Yekaterinburg', 'ru')).toBe('15.06.2027 · 04:30')
    expect(programTime('2027-06-14T23:30:00Z', 'Europe/Moscow', 'en')).toBe('15/06/2027 · 02:30')
  })
})
