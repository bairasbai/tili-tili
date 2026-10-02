// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EventInvitations from '@/pages/EventInvitations'
import Invite from '@/pages/Invite'
import { setI18nLang } from './i18n'
import type { EventInvitationRoster } from './api/weddingEvents'

const store = vi.hoisted(() => ({ weddingId: 'w1' as string | null }))
vi.mock('./store', () => ({ useStore: () => store }))
const initial: EventInvitationRoster = {
  event: { id: 'e1', name: 'Second day', kind: 'second_day', date: null, location: null, timeZone: null, isMain: false, rsvpDeadline: null },
  people: [{ guestId: 'g1', name: 'Марина', invited: true }, { guestId: 'g2', name: 'Спутник', invited: false }],
}
const json = (body: unknown, status = 200, etag: string | null = '"1"') => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
})
const refusal = (status: number, code = 'timeline_conflict') => json({ error: { code, message: 'Server refusal' } }, status)
type Call = { path: string; method: string; body: { guestIds?: string[] } | null; headers: Headers }
function fixture(options: { role?: string; etag?: string | null; roster?: EventInvitationRoster; read?: () => Promise<Response>; membership?: () => Promise<Response>; write?: (call: Call) => Promise<Response> } = {}) {
  const state = { roster: structuredClone(options.roster ?? initial), version: options.etag === undefined ? '"1"' : options.etag, role: options.role ?? 'couple', calls: [] as Call[] }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    state.calls.push(call)
    if (call.path === '/auth/refresh') return refusal(401, 'unauthorized')
    if (call.path === '/weddings') return options.membership ? options.membership() : json([{ id: store.weddingId, role: state.role }])
    if (call.path.endsWith('/invitations')) {
      if (call.method === 'GET') return options.read ? options.read() : json(state.roster, 200, state.version)
      if (options.write) return options.write(call)
      state.roster.people = state.roster.people.map(p => ({ ...p, invited: call.body!.guestIds!.includes(p.guestId) }))
      state.version = '"2"'; return json(state.roster, 200, state.version)
    }
    return refusal(404, 'unexpected')
  }))
  return state
}
const writes = (state: ReturnType<typeof fixture>) => state.calls.filter(c => c.method === 'PUT')
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement
const component = () => <MemoryRouter initialEntries={['/wedding/events/e1/invitations']}><Routes><Route path="/wedding/events/:eventId/invitations" element={<EventInvitations />} /></Routes></MemoryRouter>
async function edit() { await screen.findByText('Second day'); await waitFor(() => expect(button('Изменить состав').disabled).toBe(false)); fireEvent.click(button('Изменить состав')) }
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  store.weddingId = 'w1'; setI18nLang('ru'); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('individual event roster from captured actual client requests', () => {
  it('reads separate-person flags and saves only the captured chosen IDs/version, then rereads', async () => {
    const state = fixture(); render(component()); await edit()
    expect(checkbox('Марина').checked).toBe(true); expect(checkbox('Спутник').checked).toBe(false)
    fireEvent.click(checkbox('Марина')); fireEvent.click(checkbox('Спутник')); fireEvent.click(button('Сохранить'))
    await screen.findByText('Состав приглашённых сохранён')
    expect(writes(state)).toHaveLength(1)
    expect(writes(state)[0]).toMatchObject({ method: 'PUT', path: '/weddings/w1/events/e1/invitations', body: { guestIds: ['g2'] } })
    expect(writes(state)[0]!.headers.get('If-Match')).toBe('"1"')
    await waitFor(() => expect(checkbox('Спутник').disabled).toBe(true))
    expect(checkbox('Марина').checked).toBe(false)
    expect(state.calls.filter(c => c.method === 'GET' && c.path.endsWith('/invitations'))).toHaveLength(2)
  })
  it('unchanged form cannot write and explicit empty selection is sent as []', async () => {
    const state = fixture(); render(component()); await edit()
    expect(button('Сохранить').disabled).toBe(true)
    fireEvent.click(checkbox('Марина')); fireEvent.click(button('Сохранить'))
    await screen.findByText('Состав приглашённых сохранён'); expect(writes(state)[0]!.body).toEqual({ guestIds: [] })
  })
  it('main is read-only and links to the existing guest list', async () => {
    fixture({ roster: { ...initial, event: { ...initial.event, isMain: true } } }); render(component()); await screen.findByText('Second day')
    expect(screen.queryByRole('button', { name: 'Изменить состав' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Гости' }).getAttribute('href')).toBe('/wedding/guests')
  })
  for (const role of ['helper', 'coordinator', 'unknown']) it(`${role} sees no private people even if roster response arrives`, async () => {
    const state = fixture({ role }); render(component()); await screen.findByText('Состав приглашённых ведёт пара')
    expect(screen.queryByText('Марина')).toBeNull(); expect(screen.queryByRole('button', { name: 'Изменить состав' })).toBeNull(); expect(writes(state)).toEqual([])
  })
  it('does not reveal private people before membership arrives', async () => {
    let finish!: (r: Response) => void
    fixture({ membership: () => new Promise(resolve => { finish = resolve }) }); render(component())
    await waitFor(() => expect(finish).toBeTypeOf('function')); expect(screen.queryByText('Марина')).toBeNull()
    finish(json([{ id: 'w1', role: 'couple' }])); await screen.findByText('Марина')
  })
  for (const status of [401, 403, 404, 500]) it(`read ${status} is not an empty roster or saved success`, async () => {
    fixture({ read: async () => refusal(status, status === 401 ? 'unauthorized' : 'not_found') }); render(component())
    if (status === 403) await screen.findByText('Server refusal')
    else await screen.findByRole('alert')
    expect(screen.queryByText('Гостей пока нет')).toBeNull()
    expect(screen.queryByText('Состав приглашённых сохранён')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('missing ETag disables editing', async () => {
    fixture({ etag: null }); render(component()); await screen.findByText('Second day')
    expect(button('Изменить состав').disabled).toBe(true); expect(screen.getByText('Обновите мероприятия перед сохранением')).toBeTruthy()
  })
  it('missing invited flag is an invalid read, not an unchecked checkbox', async () => {
    fixture({ read: async () => json({ ...initial, people: [{ guestId: 'g1', name: 'Марина' }] }) })
    render(component()); await screen.findByText('Состав приглашённых не подтверждён сервером')
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByText('Гостей пока нет')).toBeNull()
  })
  it('conflict preserves the exact draft and blocks automatic rebase/retry until explicit fresh opening', async () => {
    let attempt = 0
    const state = fixture({ write: async () => { if (++attempt === 1) { state.roster.people[0]!.invited = false; state.version = '"2"'; return refusal(409) } return json({ ...state.roster, people: state.roster.people.map(p => ({ ...p, invited: true })) }) } })
    render(component()); await edit(); fireEvent.click(checkbox('Спутник')); fireEvent.click(button('Сохранить'))
    await screen.findByText('Перед повторным изменением откройте свежую версию')
    expect(checkbox('Марина').checked).toBe(true); expect(checkbox('Спутник').checked).toBe(true)
    expect(button('Сохранить').disabled).toBe(true); expect(writes(state)).toHaveLength(1)
    await waitFor(() => expect(button('Открыть свежую версию').disabled).toBe(false)); fireEvent.click(button('Открыть свежую версию'))
    expect(checkbox('Марина').checked).toBe(false); expect(checkbox('Спутник').checked).toBe(false)
    fireEvent.click(checkbox('Марина')); fireEvent.click(checkbox('Спутник')); fireEvent.click(button('Сохранить'))
    await screen.findByText('Состав приглашённых сохранён'); expect(writes(state)[1]!.headers.get('If-Match')).toBe('"2"')
  })
  it('ambiguous network result retains the draft without a success or automatic second write', async () => {
    const state = fixture({ write: async () => { throw new TypeError('connection lost') } }); render(component()); await edit()
    fireEvent.click(checkbox('Спутник')); fireEvent.click(button('Сохранить')); await screen.findByText('Перед повторным изменением откройте свежую версию')
    expect(checkbox('Спутник').checked).toBe(true); expect(button('Сохранить').disabled).toBe(true); expect(writes(state)).toHaveLength(1)
    expect(screen.queryByText('Состав приглашённых сохранён')).toBeNull()
  })
  it('validation keeps the draft editable, mismatched acceptance is not saved', async () => {
    let attempts = 0
    const state = fixture({ write: async () => ++attempts === 1 ? refusal(422, 'validation_failed') : json(initial) })
    render(component()); await edit(); fireEvent.click(checkbox('Спутник')); fireEvent.click(button('Сохранить'))
    await screen.findByRole('alert'); expect(checkbox('Спутник').checked).toBe(true); expect(button('Сохранить').disabled).toBe(false)
    fireEvent.click(button('Сохранить')); await screen.findByText('Состав приглашённых не подтверждён сервером')
    expect(screen.queryByText('Состав приглашённых сохранён')).toBeNull(); expect(writes(state)).toHaveLength(2)
  })
  it('refetch after lost role removes private draft and actions', async () => {
    const state = fixture({ write: async () => { state.role = 'helper'; return refusal(403, 'forbidden') } })
    render(component()); await edit(); fireEvent.click(checkbox('Спутник')); fireEvent.click(button('Сохранить'))
    await screen.findByText('Состав приглашённых ведёт пара'); expect(screen.queryByText('Марина')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('double click submits once and late old-wedding acceptance never appears in a new wedding', async () => {
    let finish!: (r: Response) => void
    const state = fixture({ write: () => new Promise(resolve => { finish = resolve }) }), ui = render(component())
    await edit(); fireEvent.click(checkbox('Спутник')); const save = button('Сохранить'); fireEvent.click(save); fireEvent.click(save)
    expect(writes(state)).toHaveLength(1)
    store.weddingId = 'w2'; ui.rerender(component()); await screen.findByText('Second day')
    finish(json({ ...initial, people: initial.people.map(p => ({ ...p, invited: true })) }))
    await waitFor(() => expect(screen.queryByText('Состав приглашённых сохранён')).toBeNull())
  })
  it('offline stops writes and reconnect rereads without rebasing old draft', async () => {
    const state = fixture(); render(component()); await edit(); fireEvent.click(checkbox('Спутник'))
    fireEvent(window, new Event('offline')); expect(button('Сохранить').disabled).toBe(true)
    state.version = '"2"'; fireEvent(window, new Event('online'))
    await screen.findByText('Перед повторным изменением откройте свежую версию')
    expect(checkbox('Спутник').checked).toBe(true); expect(writes(state)).toEqual([])
  })
  it('English names and saved acceptance use the real same request', async () => {
    setI18nLang('en'); const state = fixture(); render(component()); await screen.findByText('Second day')
    await waitFor(() => expect(button('Edit invitees').disabled).toBe(false)); fireEvent.click(button('Edit invitees'))
    fireEvent.click(checkbox('Спутник')); fireEvent.click(button('Save')); await screen.findByText('Invitees saved'); expect(writes(state)[0]!.body).toEqual({ guestIds: ['g1', 'g2'] })
  })
})

/* T012: «Ваши мероприятия» теперь один блок — основное мероприятие (здесь его
   нет в ответе /rsvp/{token}, только доп.) информационное без кнопок, а доп.
   мероприятия несут личный срок/ответ из отдельного /rsvp/{token}/events и
   потому теперь ЕСТЬ кнопки — другое дерево, другой тест (eventRsvp.test.tsx);
   здесь по-прежнему проверяется только то, что это ровно СВОИ приглашённые
   события/персоны этой семьи, а легаси-ответ остаётся main-only. */
for (const lang of ['ru', 'en'] as const) it(`guest ${lang} shows only returned personal events/subset, legacy answer is explicitly main-only`, async () => {
  setI18nLang(lang); localStorage.setItem('tt_guest_token', 'private-token')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path.endsWith('/rsvp/private-token/events')) return json({ events: [{
      event: initial.event,
      deadline: { date: null, timeZone: null, state: 'none', closesAt: null },
      people: [{ guestId: 'g2', name: 'Спутник', status: 'unknown', source: null, version: '0', request: null }],
    }] })
    if (path.includes('/rsvp/')) return json({
      partyId: 'p1', guestName: 'Марина', status: 'pending', members: [
        { guestId: 'g1', name: 'Марина', status: 'pending' }, { guestId: 'g2', name: 'Спутник', status: 'pending' },
      ], wedding: { title: 'Our wedding', date: null, venue: null, inviteThemeId: 0 }, events: [],
    })
    return refusal(404)
  }))
  render(<MemoryRouter><Invite /></MemoryRouter>)
  const region = await screen.findByRole('region', { name: lang === 'ru' ? 'Ваши мероприятия' : 'Your events' })
  // регион появляется с основным ответом страницы; карточка доп. мероприятия — отдельным запросом внутри него
  expect(await within(region).findByText('Second day')).toBeTruthy()
  expect(within(region).getByText('Спутник')).toBeTruthy(); expect(within(region).queryByText('Марина')).toBeNull()
  expect(within(region).getByText(lang === 'ru' ? 'Часовой пояс не задан' : 'Time zone not set')).toBeTruthy()
  expect(screen.getByText(lang === 'ru' ? 'Ответ на основную программу' : 'Response for the main program')).toBeTruthy()
  // T012: доп. (не основное) мероприятие теперь несёт личный ответ — кнопки есть.
  expect(within(region).queryAllByRole('button').length).toBeGreaterThan(0)
})
