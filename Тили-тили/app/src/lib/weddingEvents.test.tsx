// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WeddingEvents from '@/pages/WeddingEvents'
import type { WeddingEvent } from './api/weddingEvents'
import { setI18nLang } from './i18n'

const store = vi.hoisted(() => ({ weddingId: 'w1' as string | null }))
vi.mock('./store', () => ({ useStore: () => store }))
type Call = { path: string; method: string; body: Record<string, unknown> | null; headers: Headers }
const main: WeddingEvent = { id: 'main', name: 'Main', kind: 'ceremony', date: '2027-06-14', timeZone: 'Europe/Moscow', location: 'Main hall', isMain: true }
const extra: WeddingEvent = { id: 'extra', name: 'Second', kind: 'second_day', date: null, timeZone: null, location: null, isMain: false }
const json = (body: unknown, status = 200, etag: string | null = '"1"') => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
})
const refusal = (status: number, code = 'timeline_conflict', message = 'Real refusal') => json({ error: { code, message } }, status)
function fixture(options: { role?: string; etag?: string | null; events?: WeddingEvent[]; read?: () => Promise<Response>; members?: () => Promise<Response>; write?: (call: Call) => Promise<Response> } = {}) {
  const state = { events: options.events ?? [main, extra], version: options.etag === undefined ? '"1"' : options.etag, role: options.role ?? 'couple', calls: [] as Call[] }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    state.calls.push(call)
    if (call.path === '/auth/refresh') return refusal(401, 'unauthorized', 'Refresh expired')
    if (call.path === '/weddings') return options.members ? options.members() : json([{ id: store.weddingId, role: state.role }])
    if (call.method === 'GET' && call.path.endsWith('/events')) return options.read ? options.read() : json(state.events, 200, state.version)
    if (call.method !== 'GET' && call.path.includes('/events')) {
      if (options.write) return options.write(call)
      state.version = '"2"'
      if (call.method === 'DELETE') { state.events = state.events.filter(e => !call.path.endsWith('/' + e.id)); return new Response(null, { status: 204 }) }
      if (call.method === 'PATCH') { const found = state.events.find(e => call.path.endsWith('/' + e.id))!; const changed = { ...found, ...call.body } as WeddingEvent; state.events = state.events.map(e => e.id === found.id ? changed : e); return json(changed) }
      const created = { ...call.body, id: 'created', isMain: false } as WeddingEvent
      state.events = [...state.events, created]; return json(created, 201)
    }
    return refusal(404, 'unexpected', 'Unexpected route')
  }))
  return state
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const writes = (state: ReturnType<typeof fixture>) => state.calls.filter(c => c.method !== 'GET')
function open() { return render(<MemoryRouter><WeddingEvents /></MemoryRouter>) }
async function loaded() { await screen.findByText('Main', { exact: true }); await waitFor(() => expect(button('Добавить мероприятие').disabled).toBe(false)) }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }) }
function editExtra() { fireEvent.click(button('Изменить мероприятие: Second')) }
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  store.weddingId = 'w1'; setI18nLang('ru'); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('event management through the versioned API', () => {
  it('creates unknown metadata as null using this exact list version, then rereads', async () => {
    const state = fixture(); open(); await loaded()
    fireEvent.click(button('Добавить мероприятие')); change('Название мероприятия', '  New event  ')
    fireEvent.click(button('Сохранить'))
    await screen.findByText('Мероприятие сохранено'); await screen.findByText('New event', { exact: true })
    expect(writes(state)).toHaveLength(1)
    expect(writes(state)[0]).toMatchObject({ method: 'POST', path: '/weddings/w1/events', body: { name: 'New event', kind: 'other', date: null, timeZone: null, location: null } })
    expect(writes(state)[0]!.headers.get('If-Match')).toBe('"1"')
    expect(state.calls.filter(c => c.method === 'GET' && c.path.endsWith('/events'))).toHaveLength(2)
  })
  it('shows unknown values honestly and does not allow deleting the main event', async () => {
    fixture(); open(); await loaded()
    const row = screen.getByTestId('wedding-event-extra')
    expect(row.textContent).toContain('Дата не задана'); expect(row.textContent).toContain('Часовой пояс не задан'); expect(row.textContent).toContain('Место не задано')
    expect(screen.queryByRole('button', { name: 'Удалить мероприятие: Main' })).toBeNull()
  })
  it('PATCH changes only the intended field, preserving historical zone and raw location', async () => {
    const state = fixture({ events: [main, { ...extra, timeZone: 'Historical/Unknown', location: '  Historical hall  ' }] }); open(); await loaded(); editExtra()
    change('Название мероприятия', 'Renamed'); fireEvent.click(button('Сохранить'))
    await screen.findByText('Renamed', { exact: true })
    expect(writes(state)[0]!.body).toEqual({ name: 'Renamed' })
    expect(state.events[1]!.timeZone).toBe('Historical/Unknown'); expect(state.events[1]!.location).toBe('  Historical hall  ')
  })
  it('clears independently known metadata explicitly as null', async () => {
    const state = fixture({ events: [main, { ...extra, date: '2027-06-15', timeZone: 'UTC', location: 'Hall' }] }); open(); await loaded(); editExtra()
    change('Дата', ''); change('Часовой пояс', ''); change('Место мероприятия', ''); fireEvent.click(button('Сохранить'))
    await screen.findByText('Мероприятие сохранено')
    expect(writes(state)[0]!.body).toEqual({ date: null, timeZone: null, location: null })
  })
  it('keeps main date out of PATCH and links to the existing wedding-date flow', async () => {
    const state = fixture(); open(); await loaded(); fireEvent.click(button('Изменить мероприятие: Main'))
    expect(screen.queryByLabelText('Дата', { exact: true })).toBeNull()
    expect(screen.getByRole('link', { name: 'Дата свадьбы' }).getAttribute('href')).toBe('/us')
    change('Название мероприятия', 'Main renamed'); fireEvent.click(button('Сохранить'))
    await screen.findByText('Мероприятие сохранено'); expect(writes(state)[0]!.body).toEqual({ name: 'Main renamed' })
  })
  it.each(['helper', 'coordinator', 'unknown'])('allows read only for %s', async role => {
    const state = fixture({ role }); open(); await screen.findByText('Second', { exact: true })
    expect(screen.queryByRole('button', { name: 'Добавить мероприятие' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Изменить мероприятие/ })).toBeNull(); expect(writes(state)).toHaveLength(0)
  })
  it('does not enable writes while the actual role request is pending', async () => {
    let release!: (res: Response) => void
    fixture({ members: () => new Promise(resolve => { release = resolve }) }); open()
    await waitFor(() => expect(release).toBeTypeOf('function'))
    expect(screen.queryByRole('button', { name: 'Добавить мероприятие' })).toBeNull()
    release(json([{ id: 'w1', role: 'helper' }])); await screen.findByText('Second', { exact: true })
    expect(screen.queryByRole('button', { name: 'Добавить мероприятие' })).toBeNull()
  })
  it('requires an actual ETag instead of inventing one', async () => {
    const state = fixture({ etag: null }); open(); await screen.findByText('Обновите мероприятия перед сохранением')
    expect(button('Добавить мероприятие').disabled).toBe(true); fireEvent.click(button('Добавить мероприятие'))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(writes(state)).toHaveLength(0)
  })
  it.each([401, 403, 404, 410, 500])('shows read refusal %s instead of a false empty list', async status => {
    fixture({ read: async () => refusal(status, 'refusal', 'Read refused') }); open()
    await screen.findByText(status === 401 ? 'Сессия истекла — войдите снова' : status >= 500 ? 'Сервер недоступен. Попробуйте позже' : 'Read refused')
    expect(screen.queryByText('Мероприятий пока нет')).toBeNull(); expect(screen.queryByText('Second', { exact: true })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Добавить мероприятие' })).toBeNull()
  })
  it('does not silently discard a conflict draft or automatically resubmit', async () => {
    const state = fixture({ write: async () => { state.version = '"2"'; state.events = [main, { ...extra, name: 'Changed elsewhere' }]; return refusal(409) } }); open(); await loaded(); editExtra()
    change('Название мероприятия', 'My draft'); fireEvent.click(button('Сохранить')); await screen.findByText('Real refusal')
    expect((screen.getByLabelText('Название мероприятия') as HTMLInputElement).value).toBe('My draft'); expect(button('Сохранить').disabled).toBe(true)
    fireEvent.click(button('Сохранить')); expect(writes(state)).toHaveLength(1)
    await waitFor(() => expect(button('Открыть свежую версию').disabled).toBe(false)); fireEvent.click(button('Открыть свежую версию'))
    expect((screen.getByLabelText('Название мероприятия') as HTMLInputElement).value).toBe('Changed elsewhere')
    expect(writes(state)).toHaveLength(1)
  })
  it('keeps an ambiguous network write blocked until explicit fresh opening', async () => {
    const state = fixture({ write: async () => { throw new TypeError('offline') } }); open(); await loaded(); editExtra()
    change('Название мероприятия', 'Network draft'); fireEvent.click(button('Сохранить')); await screen.findByText('Сервер недоступен. Попробуйте позже')
    expect(button('Сохранить').disabled).toBe(true); expect(writes(state)).toHaveLength(1)
    expect((screen.getByLabelText('Название мероприятия') as HTMLInputElement).value).toBe('Network draft'); expect(screen.queryByText('Мероприятие сохранено')).toBeNull()
  })
  it('keeps editable validation errors and does not claim success', async () => {
    const state = fixture({ write: async () => refusal(422, 'validation', 'Check the place') }); open(); await loaded(); editExtra()
    change('Место мероприятия', 'Bad place'); fireEvent.click(button('Сохранить')); await screen.findByText('Check the place')
    expect(button('Сохранить').disabled).toBe(false); expect(screen.queryByText('Мероприятие сохранено')).toBeNull(); expect(writes(state)).toHaveLength(1)
  })
  it('removes private list and editor after a write refusal followed by lost read access', async () => {
    let denied = false
    const state = fixture({ read: async () => denied ? refusal(403, 'forbidden', 'Access withdrawn') : json([main, extra]),
      write: async () => { denied = true; return refusal(403, 'forbidden', 'Access withdrawn') } })
    open(); await loaded(); editExtra(); change('Название мероприятия', 'Forbidden draft'); fireEvent.click(button('Сохранить'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); await screen.findByText('Access withdrawn')
    expect(screen.queryByText('Second', { exact: true })).toBeNull(); expect(screen.queryByText('Мероприятие сохранено')).toBeNull(); expect(writes(state)).toHaveLength(1)
  })
  it('does not treat a success response without the accepted event ID as saved', async () => {
    const state = fixture({ write: async () => json({}) }); open(); await loaded(); editExtra(); change('Название мероприятия', 'Unconfirmed')
    fireEvent.click(button('Сохранить')); await screen.findByText('Сервер не подтвердил сохранение мероприятия')
    expect(screen.queryByText('Мероприятие сохранено')).toBeNull(); expect(button('Сохранить').disabled).toBe(true); expect(writes(state)).toHaveLength(1)
  })
  it('confirms DELETE with captured ETag, rereads only after successful204', async () => {
    const state = fixture(); open(); await loaded(); fireEvent.click(button('Удалить мероприятие: Second'))
    expect(within(screen.getByRole('dialog')).getByText('Second', { exact: true })).toBeTruthy(); expect(writes(state)).toHaveLength(0)
    fireEvent.click(button('Удалить')); await screen.findByText('Мероприятие удалено')
    await waitFor(() => expect(screen.queryByTestId('wedding-event-extra')).toBeNull())
    expect(writes(state)[0]).toMatchObject({ method: 'DELETE', path: '/weddings/w1/events/extra' }); expect(writes(state)[0]!.headers.get('If-Match')).toBe('"1"')
  })
  it('does not hide a populated event when deletion is refused', async () => {
    const state = fixture({ write: async () => refusal(409, 'event_in_use', 'Move its blocks first') }); open(); await loaded(); fireEvent.click(button('Удалить мероприятие: Second')); fireEvent.click(button('Удалить'))
    await screen.findByText('Move its blocks first'); expect(screen.getByTestId('wedding-event-extra')).toBeTruthy()
    expect(screen.queryByText('Мероприятие удалено')).toBeNull(); expect(button('Удалить').disabled).toBe(true); expect(writes(state)).toHaveLength(1)
  })
  it('blocks duplicate submission and drops late acceptance after wedding switches', async () => {
    let release!: (res: Response) => void
    const state = fixture({ write: () => new Promise(resolve => { release = resolve }) }); const view = open(); await loaded(); editExtra()
    change('Название мероприятия', 'Late draft'); const save = button('Сохранить'); fireEvent.click(save); fireEvent.click(save)
    expect(writes(state)).toHaveLength(1); expect(button('Закрыть').disabled).toBe(true)
    store.weddingId = 'w2'; view.rerender(<MemoryRouter><WeddingEvents /></MemoryRouter>); await loaded()
    release(json({ ...extra, name: 'Late draft' })); await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('Мероприятие сохранено')).toBeNull()
    expect(writes(state)[0]!.path).toBe('/weddings/w1/events/extra')
  })
  it('blocks writes offline and forces fresh reading on reconnect', async () => {
    const state = fixture(); open(); await loaded(); editExtra(); change('Название мероприятия', 'Draft')
    fireEvent(window, new Event('offline')); expect(button('Сохранить').disabled).toBe(true); fireEvent.click(button('Сохранить')); expect(writes(state)).toHaveLength(0)
    state.version = '"2"'; fireEvent(window, new Event('online')); await screen.findByText('Перед повторным изменением откройте свежую версию')
    expect(button('Сохранить').disabled).toBe(true); expect((screen.getByLabelText('Название мероприятия') as HTMLInputElement).value).toBe('Draft')
  })
  it('reports lost list membership without write controls', async () => {
    fixture({ members: async () => json([]) }); open(); await screen.findByText('Свадьба больше недоступна')
    expect(screen.queryByText('Мероприятий пока нет')).toBeNull(); expect(screen.queryByRole('button', { name: 'Добавить мероприятие' })).toBeNull()
  })
  it('translates the form and success into English', async () => {
    setI18nLang('en'); fixture(); open(); await screen.findByText('Second', { exact: true })
    fireEvent.click(button('Add event')); change('Event name', 'English event'); fireEvent.click(button('Save'))
    await screen.findByText('Event saved'); expect(screen.queryByText('Мероприятие сохранено')).toBeNull()
  })
})
