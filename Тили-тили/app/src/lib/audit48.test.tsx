// @vitest-environment jsdom
/*
 * Живой обход ролей и кнопок (2026-09-19) — фронт.
 *
 *  О1 онбординг: декоративные пятна не перехватывают нажатия — на 390 px «Далее» и «Пропустить» лежали под ними (ERR-0269).
 *  Б1 главная помощника: бюджет закрыт матрицей (403) — «ведёт пара», а не «не загрузился».
 *  В1 анкета подрядчика, который уже в слоте: CTA «открыть сделку» вместо «Добавить в свадьбу» (409 slot_taken).
 *  В2 «Поделиться» без Web Share подтверждает копирование словом «Скопировано».
 * Харнесс `serve` — из audit45/46/47.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import Home from '@/pages/Home'
import { StoreProvider, useStore } from './store'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
const withStatus = (status: number, code: string, message: string) => ({ __status: status, body: { error: { code, message } } })

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

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  localStorage.setItem('tt_city', JSON.stringify('Уфа'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }
const VENDOR = {
  id: 'v1', name: 'Студия «Пион»', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
  priceFrom: { amount: 4_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0,
  packages: [{ id: 'p1', name: 'Полный день', price: { amount: 9_000_000, currency: 'RUB' }, items: [] }],
}
const DEAL = { id: 'd1', state: 'booked', vendor: VENDOR, externalName: null, externalPhone: null, packageName: 'Полный день', price: { amount: 9_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' }, paidAt: null }
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [{ id: 's-photo', categoryId: 'photo', label: 'Фотограф', deal: null, tileState: 'empty' }],
  '/weddings/w1/budget': { total: { amount: 100_000_000, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, reserve: { amount: 10_000_000, currency: 'RUB' }, categories: [] },
  '/weddings/w1/tips': { items: [] },
  '/weddings/w1/tasks': [],
  '/weddings/w1/guests': [],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📸', vendorsCount: 3 }],
  '/catalog/vendors': { items: [], nextCursor: null },
  '/catalog/vendors/v1': VENDOR,
  '/catalog/vendors/v1/availability': { busyDates: [] },
  '/catalog/vendors/v1/reviews': { items: [], nextCursor: null },
  '/vendor/profile': withStatus(404, 'not_found', 'Анкета ещё не создана'),
  ...over,
})

describe('обход ролей: онбординг', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('О1: декоративные пятна первого экрана не ловят нажатия (pointer-events-none, aria-hidden)', async () => {
    serve({})
    const r = await open('/', 'Далее')
    const blobs = [...r.container.querySelectorAll('div.blur-3xl')]
    expect(blobs.length).toBe(2)
    for (const b of blobs) {
      expect(b.className).toContain('pointer-events-none')
      expect(b.getAttribute('aria-hidden')).toBe('true')
    }
    fireEvent.click(screen.getByRole('button', { name: /Далее/ }))
    await waitFor(() => expect(text(r)).toContain('Один день'), { timeout: 4000 })
  })
})

describe('обход ролей: главная помощника', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it.each(['helper', 'coordinator', 'vendor'])('Б1: роль %s не запрашивает бюджет и tips; переход к бюджету закрыт', async role => {
    const calls = serve(base({
      '/weddings': [{ ...WEDDING, role }],
      '/weddings/w1/budget': withStatus(403, 'forbidden', 'Роль «helper» не имеет доступа к этому разделу'),
      '/weddings/w1/tips': withStatus(403, 'forbidden', 'Роль «helper» не имеет доступа к этому разделу'),
    }))
    const r = await open('/home', 'Бюджет ведёт пара — у вашей роли к нему доступа нет.')
    expect(text(r)).not.toContain('Бюджет не загрузился')
    expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(0)
    expect((screen.getByRole('button', { name: /Бюджет/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Б1: неизвестная роль не запускает финансовые запросы; после ответа пары бюджет загружается', async () => {
    let resolveMembership!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { resolveMembership = resolve })
    const calls = serve(base())
    const respond = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input), 'http://local').pathname.replace(/^\/api/, '') === '/weddings'
        ? pending : respond(input, init)))
    const r = await open('/home', 'Аня ♥ Боря')
    await waitFor(() => expect(calls.some(c => c.path === '/weddings/w1')).toBe(true))
    expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(0)
    expect((screen.getByRole('button', { name: /Бюджет/ }) as HTMLButtonElement).disabled).toBe(true)
    resolveMembership(new Response(JSON.stringify([{ ...WEDDING, role: 'couple' }]), { headers: { 'Content-Type': 'application/json' } }))
    await waitFor(() => expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(2))
    await waitFor(() => expect((screen.getByRole('button', { name: /Бюджет/ }) as HTMLButtonElement).disabled).toBe(false))
    expect(text(r)).not.toContain('Бюджет ведёт пара')
  })

  it('Б1: отказ проверки роли не выдаёт права пары и не запускает финансовые запросы', async () => {
    const calls = serve(base({ '/weddings': withStatus(500, 'internal', 'Сервер упал') }))
    await open('/home', 'Бюджет не загрузился')
    expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(0)
    expect((screen.getByRole('button', { name: /Бюджет/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Б1: смена свадьбы ждёт свежую роль и сразу убирает прежние финансовые данные', async () => {
    let switching = false
    let resolveMembership!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { resolveMembership = resolve })
    const calls = serve(base({
      '/weddings': [{ ...WEDDING, role: 'couple' }, { ...WEDDING, id: 'w2', role: 'couple' }],
      '/weddings/w1/tips': { items: [{ title: 'PRIVATE_BUDGET_TIP', body: 'PRIVATE_BUDGET_BODY' }] },
      '/weddings/w2': { ...WEDDING, id: 'w2' }, '/weddings/w2/slots': [],
      '/weddings/w2/guests': [], '/weddings/w2/tasks': [],
    }))
    const respond = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      switching && new URL(String(input), 'http://local').pathname.replace(/^\/api/, '') === '/weddings'
        ? pending : respond(input, init)))
    function SwitchWedding() {
      const { setWeddingId } = useStore()
      return <><button onClick={() => setWeddingId('w2')}>Switch wedding</button><Home /></>
    }
    const r = render(<MemoryRouter><StoreProvider><SwitchWedding /></StoreProvider></MemoryRouter>)
    await waitFor(() => expect(text(r)).toContain('PRIVATE_BUDGET_TIP'))
    switching = true
    fireEvent.click(screen.getByRole('button', { name: 'Switch wedding' }))
    await waitFor(() => expect(calls.some(c => c.path === '/weddings/w2')).toBe(true))
    expect(text(r)).not.toContain('PRIVATE_BUDGET_TIP')
    expect(calls.filter(c => /\/weddings\/w2\/(budget|tips)$/.test(c.path))).toHaveLength(0)
    expect((screen.getByRole('button', { name: /Бюджет/ }) as HTMLButtonElement).disabled).toBe(true)
    resolveMembership(new Response(JSON.stringify([{ ...WEDDING, id: 'w2', role: 'helper' }]), { headers: { 'Content-Type': 'application/json' } }))
    await waitFor(() => expect(text(r)).toContain('Бюджет ведёт пара — у вашей роли к нему доступа нет.'))
    expect(calls.filter(c => /\/weddings\/w2\/(budget|tips)$/.test(c.path))).toHaveLength(0)
  })

  it('Б1: сетевой отказ на бюджете по-прежнему «не загрузился»', async () => {
    serve(base({ '/weddings/w1/budget': withStatus(500, 'internal', 'Сервер упал') }))
    await open('/home', 'Бюджет не загрузился')
  })
})

describe('обход ролей: команда и бюджет', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it.each(['helper', 'coordinator', 'vendor'].flatMap(role => ['/wedding', '/wedding/budget'].map(route => ({ role, route }))))('$role на $route не запрашивает бюджет и tips', async ({ role, route }) => {
    const calls = serve(base({ '/weddings': [{ ...WEDDING, role }] }))
    await open(route, route === '/wedding' ? 'Наш день' : 'Распределение средств')
    await waitFor(() => expect(screen.getByText('Бюджет ведёт пара — у вашей роли к нему доступа нет.')).toBeTruthy())
    expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(0)
    if (route === '/wedding') expect((screen.getByRole('button', { name: 'Бюджет' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it.each(['/wedding', '/wedding/budget'])('пара на %s получает бюджет и tips после подтверждения роли', async route => {
    const calls = serve(base())
    await open(route, route === '/wedding' ? 'Наш день' : 'Распределение средств')
    await waitFor(() => expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(2))
    if (route === '/wedding') expect((screen.getByRole('button', { name: 'Бюджет' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('команда ждёт подтверждения роли перед финансовыми запросами', async () => {
    let resolveMembership!: (value: Response) => void
    const pending = new Promise<Response>(resolve => { resolveMembership = resolve })
    const calls = serve(base())
    const respond = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(input), 'http://local').pathname.replace(/^\/api/, '') === '/weddings'
        ? pending : respond(input, init)))
    await open('/wedding', 'Наш день')
    expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(0)
    expect((screen.getByRole('button', { name: 'Бюджет' }) as HTMLButtonElement).disabled).toBe(true)
    resolveMembership(new Response(JSON.stringify([{ ...WEDDING, role: 'couple' }]), { headers: { 'Content-Type': 'application/json' } }))
    await waitFor(() => expect(calls.filter(c => /\/weddings\/w1\/(budget|tips)$/.test(c.path))).toHaveLength(2))
  })
})

describe('обход ролей: анкета подрядчика', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('В1: подрядчик уже в слоте — CTA ведёт к сделке, «Добавить в свадьбу» нет', async () => {
    const calls = serve(base({
      '/weddings/w1/slots': [{ id: 's-photo', categoryId: 'photo', label: 'Фотограф', deal: DEAL, tileState: 'booked' }],
      '/deals/d1/events': { items: [] },
    }))
    const r = await open('/vendor/v1', '✓ В моей свадьбе · открыть сделку')
    expect(text(r)).not.toContain('Добавить в свадьбу')
    fireEvent.click(screen.getByText('✓ В моей свадьбе · открыть сделку'))
    await waitFor(() => expect(text(r)).toContain('Сделка'), { timeout: 4000 })
    expect(calls.filter(c => c.method === 'POST' && c.path.endsWith('/book'))).toHaveLength(0)
  })

  it('В1: слот пуст — прежняя кнопка «Добавить в свадьбу»', async () => {
    serve(base())
    const r = await open('/vendor/v1', 'Добавить в свадьбу')
    expect(text(r)).not.toContain('открыть сделку')
  })

  it('В2: «Поделиться» без Web Share копирует и говорит «Скопировано»', async () => {
    serve(base())
    vi.stubGlobal('navigator', { ...navigator, share: undefined, clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    const r = await open('/vendor/v1', 'Поделиться')
    fireEvent.click(screen.getByText('Поделиться'))
    await waitFor(() => expect(text(r)).toContain('Скопировано'), { timeout: 4000 })
  })
})
