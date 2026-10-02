// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EventRsvp from '@/pages/EventRsvp'
import Invite from '@/pages/Invite'
import { setI18nLang } from './i18n'
import type { EventRsvpCouplePerson, EventRsvpDeadline, EventRsvpPerson, EventRsvpRequest } from './api/eventRsvp'

/*
 * T012 — срок ответа и персональный RSVP дополнительных мероприятий.
 *
 * Гостевые тесты бьют по /rsvp/{token}/events* — тот же единый блок «Ваши
 * мероприятия» в Invite.tsx, что и информационная карточка основного события
 * (покрыта отдельно в eventInvitations.test.tsx, здесь не трогается): основное
 * мероприятие — без кнопок, с указателем на форму ответа ниже; дополнительные —
 * полноценные карточки со сроком и персональным RSVP. Тесты пары бьют по
 * /weddings/{id}/events/{id}/rsvp* (новый экран EventRsvp.tsx).
 */

const store = vi.hoisted(() => ({ weddingId: 'w1' as string | null }))
vi.mock('./store', () => ({ useStore: () => store }))

type Call = { path: string; method: string; body: unknown; headers: Headers }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const refusal = (status: number, code = 'error', message = 'Server refusal') => json({ error: { code, message } }, status)
const button = (name: string | RegExp, within_?: HTMLElement) =>
  (within_ ? within(within_) : screen).getByRole('button', { name }) as HTMLButtonElement
const pressed = (name: string, within_?: HTMLElement) => (within_ ? within(within_) : screen).getByRole('button', { name }).getAttribute('aria-pressed')

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  store.weddingId = 'w1'
  setI18nLang('ru')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

/* ── Гость ────────────────────────────────────────────────────────────── */

type GuestPersonFixture = { guestId: string; name: string; status: EventRsvpPerson['status']; source: EventRsvpPerson['source']; version: string; request: EventRsvpRequest | null }
type GuestFixtureState = { people: GuestPersonFixture[]; calls: Call[] }

function guestFixture(options: {
  deadlineState?: 'open' | 'closed' | 'none'
  zone?: string
  people?: GuestPersonFixture[]
  answers?: (call: Call, state: GuestFixtureState) => Promise<Response> | Response
  requests?: (call: Call, state: GuestFixtureState) => Promise<Response> | Response
  events?: (call: Call, state: GuestFixtureState) => Promise<Response> | Response
} = {}) {
  const people = options.people ?? [
    { guestId: 'g1', name: 'Марина', status: 'unknown' as const, source: null, version: '0', request: null },
    { guestId: 'g2', name: 'Спутник', status: 'unknown' as const, source: null, version: '0', request: null },
  ]
  const zone = options.zone ?? 'Europe/Moscow'
  const deadline: EventRsvpDeadline = options.deadlineState === 'closed'
    ? { date: '2026-10-01', timeZone: zone, state: 'closed', closesAt: '2026-10-02T00:00:00.000Z' }
    : options.deadlineState === 'none'
      ? { date: null, timeZone: null, state: 'none', closesAt: null }
      : { date: '2026-12-31', timeZone: zone, state: 'open', closesAt: '2027-01-01T00:00:00.000Z' }
  const event = { id: 'e1', name: 'Second day', kind: 'second_day' as const, date: '2026-12-30', timeZone: zone, location: 'Дача', isMain: false, rsvpDeadline: deadline.date }
  const state: GuestFixtureState = { people: structuredClone(people), calls: [] }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    const call: Call = { path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    state.calls.push(call)
    if (path === '/auth/refresh') return refusal(401, 'unauthorized')
    if (path === '/rsvp/token' && call.method === 'GET') return json({ guestName: 'Марина', status: 'pending', wedding: { title: 'Наша свадьба', date: null, venue: null, inviteThemeId: 0 }, events: [] })
    if (path === '/rsvp/token/events' && call.method === 'GET') {
      if (options.events) return options.events(call, state)
      return json({ events: [{ event, deadline, people: state.people }] })
    }
    if (path === '/rsvp/token/events/e1/answers' && call.method === 'PUT') {
      if (options.answers) return options.answers(call, state)
      const body = call.body as { answers: Array<{ guestId: string; status: 'attending' | 'declined'; expectedVersion: string }> }
      for (const a of body.answers) {
        const p = state.people.find(x => x.guestId === a.guestId)
        if (p) { p.status = a.status; p.source = 'guest_response'; p.version = String(Number(p.version) + 1) }
      }
      return json({ people: state.people })
    }
    if (path === '/rsvp/token/events/e1/requests' && call.method === 'POST') {
      if (options.requests) return options.requests(call, state)
      const body = call.body as { guestId: string; requestedStatus: 'attending' | 'declined'; comment?: string }
      return json({
        id: 'req1', guestId: body.guestId, requestedStatus: body.requestedStatus, state: 'pending',
        comment: body.comment ?? null, decisionNote: null, createdAt: '2026-10-02T10:00:00.000Z', decidedAt: null, version: '1',
      }, 201)
    }
    return refusal(404, 'unexpected')
  }))
  return state
}

describe('гость: «Ваши мероприятия» — доп. события со сроком и персональным RSVP (T012)', () => {
  it('основное мероприятие внутри «Ваши мероприятия» остаётся информационным и ведёт к форме ответа ниже, без новых кнопок', async () => {
    localStorage.setItem('tt_guest_token', 'token')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).replace(/^\/api/, '')
      if (path === '/rsvp/token') return json({
        guestName: 'Марина', status: 'pending',
        wedding: { title: 'Наша свадьба', date: null, venue: null, inviteThemeId: 0 },
        events: [{ id: 'main1', name: 'Банкет', kind: 'banquet', date: '2026-12-30', timeZone: 'Europe/Moscow', location: 'Ресторан', isMain: true, guestIds: ['g1'] }],
      })
      if (path === '/rsvp/token/events') return json({ events: [] })
      return refusal(404, 'unexpected')
    }))
    render(<MemoryRouter><Invite /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    expect(within(region).getByText('Банкет')).toBeTruthy()
    expect(within(region).getByRole('link', { name: /Ответ на основную программу/ }).getAttribute('href')).toBe('#main-rsvp')
    expect(within(region).queryByRole('button')).toBeNull() // основное мероприятие — без кнопок ответа
  })

  it('срок открыт: показывает срок, отдельные кнопки на человека, сохраняет пачкой с версиями только изменённых', async () => {
    localStorage.setItem('tt_guest_token', 'token')
    const state = guestFixture({ deadlineState: 'open' })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    /* Регион «Ваши мероприятия» появляется сразу по основному ответу страницы;
       карточка доп. мероприятия — отдельным запросом внутри него, поэтому
       первая проверка его содержимого всегда через find*, а не get*. */
    expect(await within(region).findByText(/Ответить до/)).toBeTruthy()
    expect(within(region).getByText(/включительно/)).toBeTruthy()
    fireEvent.click(button('Марина — Приду', region))
    fireEvent.click(button('Спутник — Не приду', region))
    fireEvent.click(button('Сохранить', region))
    await waitFor(() => expect(pressed('Марина — Приду', region)).toBe('true'))
    const writes = state.calls.filter(c => c.method === 'PUT')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      path: '/rsvp/token/events/e1/answers',
      body: { answers: [{ guestId: 'g1', status: 'attending', expectedVersion: '0' }, { guestId: 'g2', status: 'declined', expectedVersion: '0' }] },
    })
    expect(button('Сохранить', region).disabled).toBe(true)
  })

  /* Хвост T012: гость видел системное имя пояса — «(Europe/Moscow)». Теперь
     пояс словами на языке экрана: город и смещение на дату срока. */
  it('часовой пояс гостю словами: «по московскому времени», «Екатеринбург, UTC+5», а не Europe/Moscow', async () => {
    localStorage.setItem('tt_guest_token', 'token')
    guestFixture({ deadlineState: 'open' })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    let region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    expect((await within(region).findByText(/Ответить до/)).textContent).toMatch(/включительно \(по московскому времени\)$/)
    expect(within(region).getByText('по московскому времени')).toBeTruthy() // строка пояса на карточке
    expect(region.textContent).not.toContain('Europe/Moscow')
    cleanup()

    guestFixture({ deadlineState: 'open', zone: 'Asia/Yekaterinburg' })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    expect((await within(region).findByText(/Ответить до/)).textContent).toMatch(/включительно \(Екатеринбург, UTC\+5\)$/)
    expect(within(region).getByText('Екатеринбург, UTC+5')).toBeTruthy()
    expect(region.textContent).not.toContain('Asia/Yekaterinburg')
    cleanup()

    setI18nLang('en')
    guestFixture({ deadlineState: 'open' })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    region = await screen.findByRole('region', { name: 'Your events' })
    expect((await within(region).findByText(/Respond by/)).textContent).toMatch(/inclusive \(Moscow time\)$/)
  })

  it('срок не задан: явное состояние «none», ответить можно напрямую', async () => {
    localStorage.setItem('tt_guest_token', 'token')
    guestFixture({ deadlineState: 'none' })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    expect(await within(region).findByText('Срок ответа не задан')).toBeTruthy()
    expect(button('Марина — Приду', region)).toBeTruthy()
  })

  it('срок прошёл: кнопки ответа скрыты, доступна только просьба организатору; повтор того же черновика переиспользует Idempotency-Key, изменённый — новый', async () => {
    localStorage.setItem('tt_guest_token', 'token')
    const keys: string[] = []
    let shouldFail = true
    guestFixture({
      deadlineState: 'closed',
      people: [{ guestId: 'g1', name: 'Марина', status: 'unknown', source: null, version: '0', request: null }],
      requests: async call => {
        keys.push(call.headers.get('Idempotency-Key') ?? '')
        if (shouldFail) return refusal(500, 'server_error', 'Временная ошибка')
        const body = call.body as { guestId: string; requestedStatus: 'attending' | 'declined'; comment?: string }
        return json({ id: 'req1', guestId: body.guestId, requestedStatus: body.requestedStatus, state: 'pending', comment: body.comment ?? null, decisionNote: null, createdAt: '2026-10-02T10:00:00.000Z', decidedAt: null, version: '1' }, 201)
      },
    })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    expect(await within(region).findByText('Срок ответа прошёл')).toBeTruthy()
    expect(within(region).queryByRole('button', { name: /Приду$/ })).toBeNull()

    fireEvent.click(button('Попросить организатора изменить ответ', region))
    fireEvent.click(button('Приду', region))
    fireEvent.click(button('Отправить просьбу', region))
    await screen.findByRole('alert')
    fireEvent.click(button('Отправить просьбу', region)) // явный повтор того же черновика
    await waitFor(() => expect(keys).toHaveLength(2))
    expect(keys[1]).toBe(keys[0])

    fireEvent.change(within(region).getByPlaceholderText('Комментарий (необязательно)'), { target: { value: 'Приедем позже' } })
    fireEvent.click(button('Отправить просьбу', region)) // черновик изменился — новый ключ
    await waitFor(() => expect(keys).toHaveLength(3))
    expect(keys[2]).not.toBe(keys[1])

    shouldFail = false
    fireEvent.click(button('Отправить просьбу', region)) // тот же (уже изменённый) черновик — ключ не меняется
    await screen.findByText('Просьба отправлена организатору')
    expect(keys).toHaveLength(4)
    expect(keys[3]).toBe(keys[2])
  })

  it('конфликт версии хранит ровно тот же черновик и блокирует повтор до явного «Открыть свежую версию»', async () => {
    let attempt = 0
    localStorage.setItem('tt_guest_token', 'token')
    const state = guestFixture({
      deadlineState: 'open',
      answers: async (_call, fixtureState) => {
        attempt++
        if (attempt === 1) {
          /* Гонка: чужой ответ (другое устройство семьи) уже записался к серверу, пока наш
             запрос был в пути — следующее перечитывание /events обязано увидеть ИМЕННО это,
             а не наш отклонённый черновик. */
          const marina = fixtureState.people.find(p => p.guestId === 'g1')!
          marina.status = 'attending'; marina.source = 'guest_response'; marina.version = '5'
          return refusal(409, 'version_conflict')
        }
        return json({ people: fixtureState.people })
      },
    })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    await within(region).findByRole('button', { name: 'Марина — Приду' })
    fireEvent.click(button('Марина — Приду', region))
    fireEvent.click(button('Сохранить', region))
    await screen.findByText('Ответ уже изменили — обновите')
    expect(pressed('Марина — Приду', region)).toBe('true')
    expect(button('Сохранить', region).disabled).toBe(true)
    expect(state.calls.filter(c => c.method === 'PUT')).toHaveLength(1)

    await waitFor(() => expect(button('Открыть свежую версию', region).disabled).toBe(false))
    fireEvent.click(button('Открыть свежую версию', region))
    await waitFor(() => expect(pressed('Спутник — Приду', region)).toBe('false'))
    expect(pressed('Марина — Приду', region)).toBe('true')
    expect(state.calls.filter(c => c.method === 'PUT')).toHaveLength(1) // только явный reopen — без повторной отправки
  })

  it('офлайн блокирует сохранение и ничего не отправляет; восстановление связи сам по себе не досылает черновик', async () => {
    localStorage.setItem('tt_guest_token', 'token')
    const state = guestFixture({ deadlineState: 'open' })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    await within(region).findByRole('button', { name: 'Марина — Приду' })
    fireEvent.click(button('Марина — Приду', region))
    fireEvent(window, new Event('offline'))
    await waitFor(() => expect(button('Сохранить', region).disabled).toBe(true))
    fireEvent.click(button('Сохранить', region))
    fireEvent(window, new Event('online'))
    await waitFor(() => expect(button('Сохранить', region).disabled).toBe(false))
    expect(state.calls.filter(c => c.method === 'PUT')).toHaveLength(0)
  })

  it('искажённый ответ сервера (/events) отклоняется, не показывается как пустой список', async () => {
    localStorage.setItem('tt_guest_token', 'token')
    guestFixture({ events: async () => json({ events: [{ event: { id: 'e1' } }] }) })
    render(<MemoryRouter><Invite /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: 'Ваши мероприятия' })
    await waitFor(() => expect(within(region).getByRole('alert')).toBeTruthy())
    // ошибка, а не тихо подставленная рабочая карточка события (retry-кнопка — другое дело, она легитимна)
    expect(within(region).queryByText(/Приду/)).toBeNull()
  })
})

/* ── Пара и команда свадьбы ───────────────────────────────────────────── */

function coupleFixture(options: {
  role?: string
  event?: Partial<{ id: string; name: string; kind: string; date: string | null; timeZone: string | null; location: string | null; isMain: boolean; rsvpDeadline: string | null }>
  deadline?: EventRsvpDeadline
  people?: EventRsvpCouplePerson[]
  requests?: EventRsvpRequest[]
  roster?: (call: Call) => Promise<Response> | Response
} = {}) {
  const event = { id: 'e1', name: 'Second day', kind: 'second_day', date: '2026-12-30', timeZone: 'Europe/Moscow', location: 'Дача', isMain: false, rsvpDeadline: null as string | null, ...options.event }
  const deadline: EventRsvpDeadline = options.deadline ?? { date: event.rsvpDeadline, timeZone: event.rsvpDeadline ? event.timeZone : null, state: event.rsvpDeadline ? 'open' : 'none', closesAt: event.rsvpDeadline ? `${event.rsvpDeadline}T21:00:00.000Z` : null }
  const people = options.people ?? [
    { guestId: 'g1', name: 'Марина', status: 'unknown' as const, source: null, version: '0', request: null, partyId: 'p1', partyLabel: null },
  ]
  const requests = options.requests ?? []
  const state = {
    eventsEtag: '"1"' as string | null, event: structuredClone(event), deadline: structuredClone(deadline),
    people: structuredClone(people), requests: structuredClone(requests), role: options.role ?? 'couple', calls: [] as Call[],
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    const call: Call = { path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    state.calls.push(call)
    if (path === '/auth/refresh') return refusal(401, 'unauthorized')
    if (path === '/weddings' && call.method === 'GET') return json([{ id: 'w1', role: state.role }])
    if (path === '/weddings/w1/events' && call.method === 'GET') return json([state.event], 200, state.eventsEtag ? { etag: state.eventsEtag } : {})
    if (path === '/weddings/w1/events/e1' && call.method === 'PATCH') {
      const body = call.body as { rsvpDeadline?: string | null }
      state.event.rsvpDeadline = body.rsvpDeadline ?? null
      state.deadline = state.event.rsvpDeadline
        ? { date: state.event.rsvpDeadline, timeZone: state.event.timeZone, state: 'open', closesAt: `${state.event.rsvpDeadline}T21:00:00.000Z` }
        : { date: null, timeZone: null, state: 'none', closesAt: null }
      state.eventsEtag = '"2"'
      return json(state.event, 200, { etag: state.eventsEtag })
    }
    if (path === '/weddings/w1/events/e1/rsvp' && call.method === 'GET') {
      if (options.roster) return options.roster(call)
      return json({ deadline: state.deadline, people: state.people, requests: state.requests })
    }
    if (path.startsWith('/weddings/w1/events/e1/rsvp/') && call.method === 'PUT') {
      const guestId = path.split('/').pop() ?? ''
      const person = state.people.find(p => p.guestId === guestId)
      if (!person) return refusal(404, 'not_found')
      const body = call.body as { status: 'unknown' | 'attending' | 'declined'; expectedVersion: string }
      person.status = body.status
      person.source = 'organizer_correction'
      person.version = String(Number(person.version) + 1)
      return json(person)
    }
    if (/\/rsvp-requests\/[^/]+\/decision$/.test(path) && call.method === 'POST') {
      const requestId = path.split('/').slice(-2, -1)[0]
      const req = state.requests.find(r => r.id === requestId)
      if (!req) return refusal(404, 'not_found')
      const body = call.body as { decision: 'accept' | 'reject'; note?: string; expectedVersion: string }
      req.state = body.decision === 'accept' ? 'accepted' : 'rejected'
      req.decisionNote = body.note ?? null
      req.decidedAt = '2026-10-02T12:00:00.000Z'
      req.version = String(Number(req.version) + 1)
      if (body.decision === 'accept') {
        const person = state.people.find(p => p.guestId === req.guestId)
        if (person) { person.status = req.requestedStatus; person.source = 'organizer_correction'; person.version = String(Number(person.version) + 1) }
      }
      return json({ request: req, person: state.people.find(p => p.guestId === req.guestId) })
    }
    return refusal(404, 'unexpected')
  }))
  return state
}

const screenAt = () => <MemoryRouter initialEntries={['/wedding/events/e1/rsvp']}><Routes><Route path="/wedding/events/:eventId/rsvp" element={<EventRsvp />} /></Routes></MemoryRouter>

describe('пара: экран ответов мероприятия (T012)', () => {
  it('задаёт срок с If-Match из снимка мероприятий, затем снимает его свежей версией', async () => {
    const state = coupleFixture({})
    render(screenAt())
    await screen.findByText('Срок ответа не задан')
    expect(screen.getAllByText('Second day').length).toBeGreaterThan(0) // заголовок TopBar + заголовок карточки — оба «Second day»

    fireEvent.click(screen.getByRole('button', { name: 'Изменить срок ответа' }))
    fireEvent.change(screen.getByLabelText('Срок ответа'), { target: { value: '2026-12-20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await screen.findByText('Мероприятие сохранено')
    await waitFor(() => expect(state.calls.filter(c => c.method === 'PATCH')).toHaveLength(1))
    let patches = state.calls.filter(c => c.method === 'PATCH')
    expect(patches[0]).toMatchObject({ path: '/weddings/w1/events/e1', body: { rsvpDeadline: '2026-12-20' } })
    expect(patches[0]!.headers.get('If-Match')).toBe('"1"')
    await screen.findByText(/Ответить до/)

    fireEvent.click(screen.getByRole('button', { name: 'Изменить срок ответа' }))
    fireEvent.change(screen.getByLabelText('Срок ответа'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(state.calls.filter(c => c.method === 'PATCH')).toHaveLength(2))
    patches = state.calls.filter(c => c.method === 'PATCH')
    expect(patches[1]).toMatchObject({ body: { rsvpDeadline: null } })
    expect(patches[1]!.headers.get('If-Match')).toBe('"2"')
    await screen.findByText('Срок ответа не задан')
  })

  it('исправляет ответ персоны версией персоны в теле (не If-Match) и показывает источник «внесено организатором»', async () => {
    const state = coupleFixture({ people: [{ guestId: 'g1', name: 'Марина', status: 'unknown', source: null, version: '0', request: null, partyId: 'p1', partyLabel: null }] })
    render(screenAt())
    await screen.findByText('Марина')
    fireEvent.click(screen.getByRole('button', { name: 'Исправить ответ: Марина' }))
    fireEvent.click(screen.getByRole('button', { name: 'Придёт' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(state.calls.some(c => c.method === 'PUT' && c.path === '/weddings/w1/events/e1/rsvp/g1')).toBe(true))
    const put = state.calls.find(c => c.method === 'PUT' && c.path === '/weddings/w1/events/e1/rsvp/g1')!
    expect(put.body).toEqual({ status: 'attending', expectedVersion: '0' })
    expect(put.headers.get('If-Match')).toBeNull()
    await screen.findByText('Внесено организатором')
  })

  it('принимает просьбу гостя: решение несёт версию просьбы, меняет ответ и источник', async () => {
    const state = coupleFixture({
      people: [{ guestId: 'g1', name: 'Марина', status: 'unknown', source: null, version: '0', request: null, partyId: 'p1', partyLabel: null }],
      requests: [{ id: 'req1', guestId: 'g1', requestedStatus: 'attending', state: 'pending', comment: 'Приедем', decisionNote: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: null, version: '1' }],
    })
    render(screenAt())
    await screen.findByText(/Приедем/)
    fireEvent.click(screen.getByRole('button', { name: 'Принять' }))
    await waitFor(() => expect(state.calls.some(c => c.path === '/weddings/w1/events/e1/rsvp-requests/req1/decision')).toBe(true))
    const post = state.calls.find(c => c.path === '/weddings/w1/events/e1/rsvp-requests/req1/decision')!
    expect(post.body).toEqual({ decision: 'accept', expectedVersion: '1' })
    await screen.findByText('Просьба принята')
    await waitFor(() => expect(screen.getByText('Внесено организатором')).toBeTruthy())
  })

  it('отклоняет просьбу гостя с пояснением', async () => {
    const state = coupleFixture({
      people: [{ guestId: 'g1', name: 'Марина', status: 'unknown', source: null, version: '0', request: null, partyId: 'p1', partyLabel: null }],
      requests: [{ id: 'req1', guestId: 'g1', requestedStatus: 'declined', state: 'pending', comment: null, decisionNote: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: null, version: '1' }],
    })
    render(screenAt())
    await screen.findByRole('button', { name: 'Отклонить' })
    fireEvent.change(screen.getByPlaceholderText('Пояснение (необязательно)'), { target: { value: 'Уже посчитали без вас' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }))
    await waitFor(() => expect(state.calls.some(c => c.path === '/weddings/w1/events/e1/rsvp-requests/req1/decision')).toBe(true))
    const post = state.calls.find(c => c.path === '/weddings/w1/events/e1/rsvp-requests/req1/decision')!
    expect(post.body).toEqual({ decision: 'reject', expectedVersion: '1', note: 'Уже посчитали без вас' })
    await screen.findByText(/Просьба отклонена/)
  })

  for (const role of ['helper', 'coordinator']) it(`${role} читает срок/ответы/просьбы, но не правит и не решает`, async () => {
    const state = coupleFixture({
      role,
      people: [{ guestId: 'g1', name: 'Марина', status: 'attending', source: 'guest_response', version: '1', request: null, partyId: 'p1', partyLabel: null }],
      requests: [{ id: 'req1', guestId: 'g1', requestedStatus: 'declined', state: 'pending', comment: null, decisionNote: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: null, version: '1' }],
    })
    render(screenAt())
    await screen.findByText('Марина')
    expect(screen.getByText('Правки доступны только паре')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Исправить ответ/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Изменить срок ответа' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Принять' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Отклонить' })).toBeNull()
    expect(screen.getByText('Просьба ждёт решения')).toBeTruthy()
    expect(state.calls.filter(c => ['PUT', 'PATCH', 'POST'].includes(c.method))).toEqual([])
  })

  it('основное мероприятие: срока нет, объяснение вместо редактора, коррекция недоступна', async () => {
    coupleFixture({
      event: { isMain: true },
      people: [{ guestId: 'g1', name: 'Марина', status: 'unknown', source: 'legacy_main_rsvp', version: '0', request: null, partyId: 'p1', partyLabel: null }],
    })
    render(screenAt())
    await screen.findByText('У основного мероприятия нет срока ответа — за него отвечает основная анкета гостя')
    expect(screen.queryByRole('button', { name: 'Изменить срок ответа' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Исправить ответ/ })).toBeNull()
    expect(screen.getByText('По основному ответу')).toBeTruthy()
  })

  /* Хвост T012: семья из одного человека подписана его же именем, и строка
     читалась «Анна Гостева · Анна Гостева». Подпись семьи — только другая. */
  it('не повторяет имя подписью семьи; другую подпись семьи показывает', async () => {
    coupleFixture({ people: [
      { guestId: 'g1', name: 'Анна Гостева', status: 'unknown', source: null, version: '0', request: null, partyId: 'p1', partyLabel: 'Анна Гостева' },
      { guestId: 'g2', name: 'Пётр', status: 'unknown', source: null, version: '0', request: null, partyId: 'p2', partyLabel: 'Семья Ивановых' },
    ] })
    render(screenAt())
    expect(await screen.findByText('Анна Гостева')).toBeTruthy()
    expect(screen.queryByText(/Анна Гостева · Анна Гостева/)).toBeNull()
    expect(screen.getByText('Пётр · Семья Ивановых')).toBeTruthy()
  })

  it('мероприятие без часового пояса объясняет это и ведёт на правку мероприятия', async () => {
    coupleFixture({ event: { timeZone: null } })
    render(screenAt())
    await screen.findByText('Чтобы задать срок ответа, сначала укажите часовой пояс мероприятия')
    expect(screen.getByRole('link', { name: 'Изменить мероприятие' }).getAttribute('href')).toBe('/wedding/events')
  })

  it('искажённый ответ сервера (roster) отклоняется, не показывается пустым', async () => {
    coupleFixture({ roster: async () => json({ deadline: { date: null }, people: [{}], requests: [] }) })
    render(screenAt())
    await screen.findByText('Снимок ответов не подтверждён сервером')
    expect(screen.queryByText('Гостей пока нет')).toBeNull()
  })
})
