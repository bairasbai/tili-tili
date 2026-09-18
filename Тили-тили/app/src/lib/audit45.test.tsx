// @vitest-environment jsdom
/*
 * Ревью 015 (фичи 005–014) — фронт.
 *
 *  FA1 смерть сессии (сервер отверг refresh) — стор забывает свадьбу, как при
 *      выходе кнопкой: `tt_wedding_id` стёрт, экран говорит «войдите снова».
 *  FA2 отказ сервера на выходе (4xx) — словами под кнопкой, токены на месте.
 *  FB1 выбранный пакет уходит в бронь (`packageId`).
 *  FB2 мягкая бронь другой пары (`holdDates`) — не «свободен на вашу дату».
 *  FB5 с приглашения гостя есть путь к подаркам (`/gifts`).
 *  FB6 экран свадьбы без свадьбы — «заведите её», а не «0 гостей».
 *  V5  очередь консьержа в панели: телефон в карточке, «Подобрано» — POST {status: done}.
 * Харнесс `serve` — из audit36/audit41.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import Invite from '@/pages/Invite'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
const withStatus = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  ({ __status: status, body: { error: { code, message, ...(details ? { details } : {}) } } })

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const call: Call = { method: init?.method ?? 'GET', path, url: full, body }
    calls.push(call)
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const settle = () => new Promise(resolve => setTimeout(resolve, 60))

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }
const SLOT = (id: string, categoryId: string, label: string) => ({ id, categoryId, label, deal: null, tileState: 'empty' })
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [SLOT('s-photo', 'photo', 'Фотограф')],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/users/me/sessions': [{ id: 'ses1', device: 'Этот телефон', current: true, createdAt: '2026-09-01T10:00:00.000Z' }],
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
  ...over,
})

describe('ревью 015: сессия и выход (FA1, FA2)', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('FA1: сервер отверг refresh — свадьба забыта на устройстве, экран зовёт войти', async () => {
    serve(base({
      '/weddings/w1/guests': withStatus(401, 'token_expired', 'Токен истёк'),
      '/auth/refresh': withStatus(401, 'refresh_expired', 'Сессия истекла'),
    }))
    /* Стор забыл свадьбу — запрос гостей сменился на «войдите»: та же кнопка
       «Войти», что у «сессия истекла», и никакого «свадьбы нет — заведите». */
    const r = await open('/wedding/guests', 'Войдите, чтобы увидеть свою свадьбу')
    expect(text(r)).toContain('Войти')
    expect(text(r)).not.toContain('заведите её')
    await waitFor(() => expect(localStorage.getItem('tt_wedding_id'), 'память стора очищена, как при выходе').toBeNull(), { timeout: 4000 })
    expect(localStorage.getItem('tt_auth')).toBeNull()
  })

  it('FA2: отказ сервера на «Выйти со всех устройств» — словами, токены остаются', async () => {
    serve(base({
      '/users/me/sessions': (c: Call) => (c.method === 'DELETE'
        ? withStatus(409, 'busy', 'Сначала завершите оплату')
        : [{ id: 'ses1', device: 'Этот телефон', current: true, createdAt: '2026-09-01T10:00:00.000Z' }]),
    }))
    const r = await open('/settings', 'Выйти со всех устройств')
    fireEvent.click(screen.getByText('Выйти со всех устройств').closest('button')!)
    await waitFor(() => expect(text(r)).toContain('Сначала завершите оплату'), { timeout: 4000 })
    expect(localStorage.getItem('tt_auth'), 'выход не состоялся — токены на месте').not.toBeNull()
    expect(text(r), 'экран не ушёл на вход').toContain('Выйти со всех устройств')
  })
})

describe('ревью 015: анкета подрядчика (FB1, FB2) и экран без свадьбы (FB6)', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const VENDOR = {
    id: 'v1', name: 'Студия «Пион»', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
    priceFrom: { amount: 4_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0,
    packages: [
      { id: 'p-small', name: 'Малый', price: { amount: 4_000_000, currency: 'RUB' }, items: [] },
      { id: 'p-big', name: 'Полный день', price: { amount: 9_000_000, currency: 'RUB' }, items: [] },
    ],
  }
  const vendorRoutes = (over: Routes = {}): Routes => base({
    '/catalog/vendors/v1': VENDOR,
    '/catalog/vendors': { items: [], nextCursor: null },
    '/catalog/vendors/v1/availability': { busyDates: [], holdDates: [] },
    '/catalog/vendors/v1/reviews': { items: [], nextCursor: null },
    '/weddings/w1/slots/s-photo/book': SLOT('s-photo', 'photo', 'Фотограф'),
    ...over,
  })

  it('FB1: выбранный пакет уходит в бронь как packageId', async () => {
    const calls = serve(vendorRoutes())
    await open('/vendor/v1', 'Добавить в свадьбу')
    fireEvent.click(screen.getByText('Полный день'))
    fireEvent.click(screen.getByText('Добавить в свадьбу'))
    await waitFor(() => expect(posts(calls, '/weddings/w1/slots/s-photo/book')).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, '/weddings/w1/slots/s-photo/book')[0]!.body).toMatchObject({ vendorId: 'v1', packageId: 'p-big', price: { amount: 9_000_000 } })
  })

  it('FB2: дата под мягкой бронью другой пары — не «свободен на вашу дату»', async () => {
    serve(vendorRoutes({ '/catalog/vendors/v1/availability': { busyDates: [], holdDates: ['2027-06-14'] } }))
    const r = await open('/vendor/v1', 'Добавить в свадьбу')
    await waitFor(() => expect(text(r)).toContain('идут переговоры с другой парой'), { timeout: 4000 })
    expect(text(r)).not.toContain('Свободен на вашу дату')
  })

  it('FB6: экран гостей без свадьбы — «заведите её», а не «0 гостей»', async () => {
    localStorage.removeItem('tt_wedding_id')
    localStorage.removeItem('tt_wedding_date')
    serve(base({ '/weddings': [] }))
    const r = await open('/wedding/guests', 'Свадьбы пока нет — заведите её')
    expect(text(r)).toContain('Завести свадьбу')
    expect(text(r)).not.toMatch(/\b0 гостей|Гостей: 0/)
  })
})

describe('ревью 015: очередь консьержа в панели (V5)', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('список с телефоном пары, «Подобрано» — POST {status: done}, закрытая — 409 словами', async () => {
    const request = { id: 'c1', status: 'new', categoryId: 'firework', categoryName: 'Пиротехника', city: 'Уфа', budget: { amount: 3_000_000, currency: 'RUB' }, comment: 'Салют на 5 минут', phone: '+79170001122', name: 'Алина', createdAt: '2026-09-17T10:00:00.000Z' }
    let closed = false
    const calls = serve(base({
      '/users/me': { ...ME, isStaff: true },
      '/admin/metrics': { users: 1, weddings: 1, vendorsPublished: 0, moderationQueue: 0, verificationQueue: 0, complaintsOpen: 0, complaintsOverdue: 0, deals: 0, gmv: { amount: 0, currency: 'RUB' }, cities: [] },
      '/admin/concierge': () => ({ items: closed ? [] : [request], nextCursor: null }),
      '/admin/concierge/c1': (c: Call) => {
        if (closed) return withStatus(409, 'concierge_closed', 'Заявка уже закрыта')
        closed = true
        return { requestId: 'c1', status: (c.body as { status: string }).status }
      },
    }))
    const r = await open('/admin/concierge', 'Пиротехника')
    expect(text(r)).toContain('+79170001122')
    expect(text(r)).toContain('Алина')
    expect(text(r)).toContain('Салют на 5 минут')
    fireEvent.click(screen.getByText('Подобрано'))
    await waitFor(() => expect(posts(calls, '/admin/concierge/c1')).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, '/admin/concierge/c1')[0]!.body).toEqual({ status: 'done' })
    await waitFor(() => expect(text(r)).toContain('Открытых заявок нет'), { timeout: 4000 })
  })
})

describe('ревью 015: подарки с приглашения (FB5)', () => {
  const page = { guestName: 'Марина', status: 'pending', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 } }
  beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_guest_token', 'tok1') })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('на приглашении есть «Подарки и складчина», ведущая на /gifts', async () => {
    serve({ '/rsvp/tok1': page, '/join/tok1/day': withStatus(423, 'not_yet', 'рано') })
    const r = render(
      <MemoryRouter initialEntries={['/invite']}>
        <Routes>
          <Route path="/invite" element={<Invite />} />
          <Route path="/gifts" element={<p>ЭКРАН ПОДАРКОВ</p>} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(text(r)).toContain('Ждём вас'), { timeout: 4000 })
    await settle()
    fireEvent.click(screen.getByText('Подарки и складчина'))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ПОДАРКОВ'), { timeout: 4000 })
  })
})
