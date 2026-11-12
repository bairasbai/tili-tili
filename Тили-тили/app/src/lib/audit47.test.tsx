// @vitest-environment jsdom
/*
 * Корзина 1 после сверки планов (2026-09-18) — фронт.
 *
 *  П1 подсказки §3.14 с сервера: главная показывает первую, бюджет — лимит категории, мозаика — дефицит/блокирующий слот.
 *  Д1 карточка сделки подрядчика: строка списка открывает `/vendor-app/deals/:id` — статус, оплаты, договор, журнал, чат; спор → POST /complaints.
 *  З1 заполненность анкеты — с сервера (`completeness`): процент и «не хватает»; без ответа — прочерк.
 *  К2 описание категории из справочника — под шапкой `/search/:catId`.
 *  Р1 `plural` в EN считает по Intl.PluralRules: 21 — форма множественного числа.
 * Харнесс `serve` — из audit45/46.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { plural } from '@/lib/utils'
import { setI18nLang } from '@/lib/i18n'

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
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)

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
  localStorage.setItem('tt_city', JSON.stringify('Уфа'))
}
const vendorSignedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }
const SLOT = (id: string, categoryId: string, label: string) => ({ id, categoryId, label, deal: null, tileState: 'empty' })
const BUDGET = {
  total: { amount: 100_000_000, currency: 'RUB' }, spent: { amount: 11_000_000, currency: 'RUB' }, reserve: { amount: 10_000_000, currency: 'RUB' },
  categories: [{ id: 'b4', title: 'Развлечения и декор', planned: { amount: 11_800_000, currency: 'RUB' }, fromSlots: 11_000_000, color: '#D9CCE3', live: 'Пион', items: [] }],
}
const TIPS = {
  items: [
    { kind: 'deficit', title: 'Свободных «Флорист» на вашу дату: 3', body: 'До свадьбы меньше 8 месяцев — бронируйте', link: '/search/florist', categoryId: 'florist' },
    { kind: 'budget', title: '«Развлечения и декор» — 93 % лимита', body: 'Обещано 110 000 ₽ из 118 000 ₽ — зафиксируйте состав', link: '/wedding/budget', categoryId: 'b4' },
  ],
}
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [SLOT('s-florist', 'florist', 'Флорист')],
  '/weddings/w1/budget': BUDGET,
  '/weddings/w1/tips': TIPS,
  '/weddings/w1/tasks': [],
  '/weddings/w1/guests': [],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/catalog/categories': [{ id: 'florist', title: 'Флорист', icon: '🌸', vendorsCount: 3, description: 'Букет, бутоньерки, оформление стола. Договоритесь о доставке.' }],
  '/catalog/vendors': { items: [], nextCursor: null },
  ...over,
})

describe('корзина 1: подсказки §3.14 с сервера', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('П1: главная показывает первую серверную подсказку и ведёт по её ссылке', async () => {
    const calls = serve(base())
    const r = await open('/home', 'Свободных «Флорист» на вашу дату: 3')
    expect(calls.some(c => c.path === '/weddings/w1/tips')).toBe(true)
    fireEvent.click(screen.getByText(/Свободных «Флорист»/).closest('button')!)
    await waitFor(() => expect(text(r)).toContain('Флорист'), { timeout: 4000 })
  })

  it('FR-063: главная учитывает последствия, дату и исключает выполненные задачи', async () => {
    const blocker = (title: string, referenceDate: string | null) => ({
      kind: 'blocking_slot', title, body: 'Нужен флорист', link: '/search/florist',
      priority: { reason: 'blocks_timeline', referenceDate },
    })
    const task = (id: string, title: string, due: string | null, done = false) => ({ id, title, due, done })
    serve(base({
      '/weddings/w1/tips': { items: [
        { ...TIPS.items[0], priority: { reason: 'limited_candidates', referenceDate: '2027-06-01' } },
        blocker('Блок без даты', null),
        blocker('Более поздний блок', '2027-06-14'),
        blocker('Ближайший блок', '2027-06-12'),
      ] },
      '/weddings/w1/tasks': [
        task('unknown', 'Задача без срока', null),
        task('later', 'Поздняя задача', '2027-06-13'),
        task('complete', 'Закрытая задача', '2027-06-01', true),
        task('soon', 'Ближайшая задача', '2027-06-10'),
      ],
    }))
    const r = await open('/home', 'Ближайший блок')
    expect(text(r)).toContain('Сначала закройте этот слот, чтобы блок тайминга состоялся.')
    expect(text(r)).toContain('Блок запланирован на 12 июня 2027')
    expect(text(r)).not.toContain('Более поздний блок')
    expect(text(r)).not.toContain('Закрытая задача')
    const tasks = screen.getAllByRole('button', { name: /Ближайшая задача|Поздняя задача|Задача без срока/ })
    expect(tasks.map(row => row.textContent)).toEqual([
      'Ближайшая задача10.06.2027', 'Поздняя задача13.06.2027', 'Задача без срока',
    ])
  })

  it('FR-063: отметки пары скрывают подсказки после открытия и позволяют вернуть их', async () => {
    const first = 'a'.repeat(64), second = 'b'.repeat(64)
    type Decision = { state: 'resolved' | 'not_applicable' | null; revision: number }
    const decisions = new Map<string, Decision>([[first, { state: null, revision: 0 }], [second, { state: null, revision: 0 }]])
    const change = (id: string) => (call: Call) => {
      const body = call.body as Decision
      const decision = decisions.get(id)!
      expect(call.method).toBe('PUT')
      expect(body.revision).toBe(decision.revision)
      decisions.set(id, { state: body.state, revision: decision.revision + 1 })
      return withStatus(204, '', '')
    }
    const calls = serve(base({
      '/weddings/w1/tips': () => ({ items: [first, second].map((id, i) => ({
        ...TIPS.items[i], id, decision: decisions.get(id), title: i === 0 ? 'Первая подсказка' : 'Вторая подсказка',
      })) }),
      [`/weddings/w1/tips/${first}/decision`]: change(first),
      [`/weddings/w1/tips/${second}/decision`]: change(second),
    }))
    const r = await open('/home', 'Первая подсказка')
    expect(calls.some(call => call.url === '/weddings/w1/tips?view=home')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Уже решено' }))
    await screen.findByRole('button', { name: /Вторая подсказка/ })
    fireEvent.click(screen.getByRole('button', { name: 'Не относится' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Не относится' })).toBeNull())
    r.unmount()
    await open('/home', 'Скрытые подсказки')
    expect(screen.queryByRole('button', { name: /Тиль: Первая подсказка/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Тиль: Вторая подсказка/ })).toBeNull()
    fireEvent.click(screen.getByText('Скрытые подсказки'))
    expect(screen.getByText('Уже решено')).toBeTruthy()
    expect(screen.getByText('Не относится')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть подсказку «Первая подсказка»' }))
    await screen.findByRole('button', { name: /Тиль: Первая подсказка/ })
    expect(decisions.get(first)).toEqual({ state: null, revision: 2 })
    expect(decisions.get(second)).toEqual({ state: 'not_applicable', revision: 1 })
  })

  it('П1: бюджет — лимит категории с сервера (85 %), своего порога 80 % больше нет', async () => {
    serve(base())
    const r = await open('/wedding/budget', '93 % лимита')
    expect(text(r)).not.toContain('Проверьте, всё ли учтено')
  })

  it('FR006: главная открывает неделю и ведёт к выбранной задаче', async () => {
    const task = '88888888-8888-4888-8888-888888888888'
    serve(base({
      '/weddings/w1/week': { range: { startsOn: '2027-06-14', endsOn: '2027-06-20', today: '2027-06-14', timeZone: 'Europe/Moscow' },
        readOnly: false, items: [
          { kind: 'task', id: task, title: 'Проверить список гостей', due: '2027-06-14', responsible: 'member', responsibleName: 'Аня', href: `/wedding/checklist?task=${task}` },
          { kind: 'payment', id: 'p1', title: 'Оплатить зал', due: '2027-06-15', responsible: 'couple', responsibleName: null, amount: null, href: '/wedding/payments?installment=p1' },
          { kind: 'guest_reply', id: 'e1', title: 'Второй день', due: '2027-06-16', responsible: 'guest', responsibleName: null, pendingCount: 3, href: '/wedding/events/e1/rsvp' },
          { kind: 'terms', id: 't1', title: 'Фотограф', due: null, responsible: 'performer', responsibleName: 'Мастерская', href: '/wedding/week/terms/deal' },
        ] },
      '/weddings/w1/tasks': [{ id: task, title: 'Проверить список гостей', due: '2027-06-14', done: false, custom: true, dueMode: 'fixed' }],
      '/weddings/w1/members': [],
    }))
    await open('/home', 'На этой неделе')
    fireEvent.click(screen.getByRole('link', { name: 'На этой неделе' }))
    const taskLink = await screen.findByRole('link', { name: /Проверить список гостей/ })
    expect(taskLink.textContent).toContain('Аня')
    expect(screen.getByRole('link', { name: /Оплатить зал/ }).textContent).toContain('Сумма уточняется')
    expect(screen.getByRole('link', { name: /Второй день/ }).textContent).toContain('Без ответа — 3')
    expect(screen.getByRole('link', { name: /Неподтверждённые условия/ }).getAttribute('href')).toBe('/wedding/week/terms/deal')
    expect(screen.getByRole('heading', { name: 'Без срока' })).toBeTruthy()
    fireEvent.click(taskLink)
    expect(await screen.findByRole('button', { name: /Проверить список гостей/, expanded: true })).toBeTruthy()
  })

  it('П1: мозаика — дефицит категории вместо общего «пустой слот»', async () => {
    serve(base())
    const r = await open('/wedding', 'Свободных «Флорист» на вашу дату: 3')
    expect(text(r)).not.toContain('подобрать свободных под ваш бюджет')
  })

  it('П1: без поводов — прежняя общая подсказка на главной', async () => {
    serve(base({ '/weddings/w1/tips': { items: [] } }))
    const r = await open('/home', 'Добавьте гостей')
    expect(text(r)).not.toContain('Свободных')
  })

  it('К2: описание категории из справочника — под шапкой списка', async () => {
    serve(base())
    const r = await open('/search/florist', 'Флорист')
    expect(text(r)).toContain('Букет, бутоньерки, оформление стола')
  })
})

describe('корзина 1: кабинет подрядчика', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PROFILE = { id: 'v1', name: 'Студия «Пион»', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false, priceFrom: { amount: 4_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0, packages: [], gallery: [], about: '', phone: null, published: true, mediaRights: true }
  const DEAL = {
    id: 'd1', coupleName: 'Аня ♥ Боря', weddingDate: '2027-06-14', price: { amount: 8_000_000, currency: 'RUB' }, packageName: 'Полный день', state: 'paid_deposit',
    holdUntil: null, busRoutes: [], paid: { amount: 3_000_000, currency: 'RUB' }, chatId: 'ch1',
    contract: { id: 'doc1', templateCode: 'photographer', version: 2, status: 'sent', createdAt: '2026-09-01T10:00:00.000Z' },
  }
  const cabinet = (over: Routes = {}): Routes => ({
    '/weddings': [],
    '/vendor/profile': PROFILE,
    '/vendor/updates': [], '/vendor/leads': [], '/vendor/calendar': [], '/vendor/reviews': [],
    '/vendor/deals': { expected: { amount: 5_000_000, currency: 'RUB' }, items: [DEAL] },
    '/deals/d1/events': [{ id: 'e1', kind: 'state', fromState: 'booked', toState: 'paid_deposit', by: 'couple', at: '2026-09-02T10:00:00.000Z', note: null }],
    '/chats': [],
    '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
    '/me/favorites': [], '/users/me': ME,
    '/complaints': (c: Call) => (c.method === 'POST' ? withStatus(201, '', '') : withStatus(405, 'x', 'x')),
    ...over,
  })

  it('Д1: строка сделки открывает карточку — статус, оплаты, договор, журнал, чат; спор → POST /complaints {deal}', async () => {
    vendorSignedIn()
    const calls = serve(cabinet())
    const r = await open('/vendor-app/deals', 'Аня ♥ Боря')
    fireEvent.click(screen.getByText('Аня ♥ Боря').closest('button')!)
    await waitFor(() => expect(text(r)).toContain('Что происходило'), { timeout: 4000 })
    expect(text(r)).toContain('Аванс получен')
    expect(text(r)).toMatch(/30\D000 ₽/)
    expect(text(r)).toMatch(/50\D000 ₽/)
    expect(text(r)).toContain('Редакция 2')
    expect(text(r)).toContain('отправлен')
    expect(text(r)).toContain('Аванс внесён')
    expect(text(r)).toContain('Полный день')
    expect(screen.getByText('Написать паре').closest('button')!.hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByText('Открыть спор'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Пожаловаться' })).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Не пришёл или не выполнил'))
    fireEvent.click(screen.getByText('Отправить жалобу'))
    await waitFor(() => expect(posts(calls, '/complaints')).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, '/complaints')[0]!.body).toMatchObject({ targetKind: 'deal', targetId: 'd1', category: 'no_show' })
  })

  it('Д1b: без чата кнопка «Написать паре» закрыта и названа честно; без договора — «Договора пока нет»', async () => {
    vendorSignedIn()
    serve(cabinet({ '/vendor/deals': { expected: { amount: 0, currency: 'RUB' }, items: [{ ...DEAL, chatId: null, contract: null, paid: { amount: 0, currency: 'RUB' } }] } }))
    const r = await open('/vendor-app/deals/d1', 'Что происходило')
    expect(text(r)).toContain('Пара ещё не писала')
    expect(screen.getByText('Пара ещё не писала').closest('button')!.hasAttribute('disabled')).toBe(true)
    expect(text(r)).toContain('Договора пока нет')
  })

  it('З1: заполненность — с сервера; без ответа прочерк, а не ноль', async () => {
    vendorSignedIn()
    serve(cabinet({ '/vendor/profile': { ...PROFILE, completeness: { pct: 50, missing: ['phone', 'packages'] } } }))
    const r = await open('/vendor-app', 'Заполненность анкеты')
    expect(text(r)).toContain('50%')
    expect(text(r)).toContain('Не хватает: рабочего телефона, пакетов услуг')
    cleanup(); vi.unstubAllGlobals(); vendorSignedIn()
    serve(cabinet())
    const r2 = await open('/vendor-app', 'Заполненность анкеты')
    expect(text(r2)).toContain('Заполненность анкеты—')
    expect(text(r2)).not.toContain('0%')
  })
})

describe('корзина 1: plural по Intl', () => {
  afterEach(() => setI18nLang('ru'))
  it('Р1: в EN 21 и 5 — форма «many», 1 — «one»; в RU прежнее правило', () => {
    setI18nLang('en')
    expect(plural(1, 'guest', 'guests', 'guests')).toBe('guest')
    expect(plural(21, 'guest', 'guests_few', 'guests')).toBe('guests')
    expect(plural(5, 'guest', 'guests_few', 'guests')).toBe('guests')
    setI18nLang('ru')
    expect(plural(21, 'гость', 'гостя', 'гостей')).toBe('гость')
    expect(plural(3, 'гость', 'гостя', 'гостей')).toBe('гостя')
    expect(plural(12, 'гость', 'гостя', 'гостей')).toBe('гостей')
  })
})
