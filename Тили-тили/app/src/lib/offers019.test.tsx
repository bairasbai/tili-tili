// @vitest-environment jsdom
/* T030 / T026–T029 — экранные приёмки запросов и предложений 019. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider } from '@/lib/store'
import { SlotDetail } from '@/pages/Wedding'
import { VendorDetail } from '@/pages/Search'
import { Compare } from '@/pages/Smart'
import { VendorOfferRequests } from '@/pages/VendorExtras'
import { Notifications } from '@/pages/Account'
import { notificationRoute } from '@/lib/api/notifications'
import { setI18nLang } from '@/lib/i18n'

type Reply = unknown | Response | { __status: number; body: unknown }
type Call = { method: string; path: string; body: unknown; key: string | null }
type RouteTable = Record<string, Reply | ((call: Call) => Reply | Promise<Reply>)>

const WEDDING = {
  id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg',
  members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }],
}
const SLOT = { id: 's1', categoryId: 'photo', label: 'Фотограф', tileState: 'empty', deal: null }
const PROFILE = {
  id: 'v1', name: 'Анна Фотограф', categoryId: 'photo', city: 'Уфа', about: 'Снимаю свадьбы',
  priceFrom: { amount: 250000, currency: 'RUB' }, rating: 4.9, reviewsCount: 7,
  photoUrl: null, verified: true, hasVideo: false, published: true, blocked: false,
  gallery: [], media: [],
  packages: [{ id: 'p1', name: 'День целиком', price: { amount: 250000, currency: 'RUB' }, includes: ['8 часов', 'Готовые фото'] }],
}

function entry(id: string, vendorId: string, name: string, position: number, patch: Record<string, unknown> = {}) {
  return {
    id, slotId: 's1', position, createdAt: '2026-09-27T10:00:00.000Z', available: true,
    occupancy: 'free' as const,
    vendor: {
      id: vendorId, name, categoryId: 'photo', city: 'Уфа', priceFrom: { amount: 250000, currency: 'RUB' },
      rating: 4.8, reviewsCount: 5, photoUrl: null, verified: true, hasVideo: false,
      packages: [{ id: `p-${id}`, name: `Пакет ${name}`, price: { amount: 250000, currency: 'RUB' }, includes: ['8 часов'] }],
    },
    ...patch,
  }
}

const E1 = entry('e1', 'v1', 'Анна Фотограф', 1)
const E2 = entry('e2', 'v2', 'Борис Фото', 2)
const REQUEST = {
  id: 'r1', status: 'open' as const, weddingDate: '2027-06-14', guests: 60, city: 'Уфа', wishes: 'Нужен репортаж',
  createdAt: '2026-09-27T10:00:00.000Z', budgetHint: { amount: 300000, currency: 'RUB' as const },
}
const OFFER = {
  id: 'o1', requestId: 'r1', kind: 'offer' as const, packageId: 'p1', title: 'День целиком',
  price: { amount: 250000, currency: 'RUB' as const }, includes: ['8 часов'], message: 'Буду рад!', validUntil: '2027-06-20',
}
type RequestFixture = typeof REQUEST & { offer?: typeof OFFER }

const withStatus = (status: number, body: unknown): Reply => ({ __status: status, body })
const isStatus = (value: unknown): value is { __status: number; body: unknown } =>
  typeof value === 'object' && value !== null && '__status' in value
const json = (body: unknown, status = 200) => new Response(
  status === 204 ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

function serve(routes: RouteTable) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const headers = new Headers(init?.headers)
    const call = { method: init?.method ?? 'GET', path, body, key: headers.get('Idempotency-Key') }
    calls.push(call)
    const route = routes[`${call.method} ${path}`] ?? routes[path]
    if (route === undefined) return Promise.resolve(json({ error: { code: 'not_found', message: `UNEXPECTED ${call.method} ${path}` } }, 404))
    let reply: Reply | Promise<Reply>
    try { reply = typeof route === 'function' ? route(call) : route } catch (error) { return Promise.reject(error) }
    return Promise.resolve(reply).then(value => value instanceof Response ? value : isStatus(value) ? json(value.body, value.__status) : json(value))
  }))
  return calls
}

function baseRoutes(overrides: RouteTable = {}): RouteTable {
  return {
    '/weddings': [{ ...WEDDING, role: 'couple' }],
    '/weddings/w1': WEDDING,
    '/weddings/w1/slots': [SLOT],
    '/weddings/w1/slots/s1/shortlist': [],
    '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
    '/catalog/vendors/v1': PROFILE,
    '/catalog/vendors/v1/availability': { busyDates: [], holdDates: [] },
    '/catalog/vendors/v1/reviews': { items: [], nextCursor: null },
    '/catalog/vendors': { items: [], nextCursor: null },
    '/vendor/profile': PROFILE,
    '/vendor/offer-requests': [],
    '/notifications': [],
    ...overrides,
  }
}

function signedIn() {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  setI18nLang('ru')
}

function mount(route: string, routes: RouteTable) {
  const calls = serve(baseRoutes(routes))
  const view = render(
    <MemoryRouter initialEntries={[route]}>
      <StoreProvider>
        <Routes>
          <Route path="/wedding/slot/:id" element={<SlotDetail />} />
          <Route path="/vendor/:id" element={<VendorDetail />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/vendor-app/offer-requests" element={<VendorOfferRequests />} />
          <Route path="/notifications" element={<Notifications />} />
        </Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
  return { ...view, calls }
}

beforeEach(signedIn)
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('offers019 · запрос пары', () => {
  it('T1: один batch даёт итог по каждому кандидату, пустой бюджет не подставляется', async () => {
    const current = [E1, E2]
    const view = mount('/wedding/slot/s1', {
      '/weddings/w1/slots/s1/shortlist': () => current,
      'POST /weddings/w1/slots/s1/offer-requests': (call: Call) => {
        expect(call.body).toEqual({ entryIds: ['e1', 'e2'], wishes: 'Нужен живой репортаж' })
        expect(call.key).toBeTruthy()
        return { results: [{ entryId: 'e1', status: 'sent', requestId: 'r1' }, { entryId: 'e2', status: 'busy' }] }
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Запросить предложение (2)' }))
    fireEvent.change(screen.getByPlaceholderText('Пожелания к предложению (необязательно)'), { target: { value: 'Нужен живой репортаж' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить запрос' }))
    expect(await screen.findByText(/Анна Фотограф:/)).toBeTruthy()
    expect(screen.getByText(/Борис Фото:/)).toBeTruthy()
    expect(view.container.textContent).toContain('Запрос отправлен')
    expect(view.container.textContent).toContain('Дата занята')
  })

  it('T2: route-specific 409 показывает причины по всем кандидатам', async () => {
    const view = mount('/wedding/slot/s1', {
      '/weddings/w1/slots/s1/shortlist': [E1, E2],
      'POST /weddings/w1/slots/s1/offer-requests': withStatus(409, {
        error: { code: 'no_request_sent', message: 'Ни один запрос не отправлен', details: { results: [
          { entryId: 'e1', status: 'already_open' }, { entryId: 'e2', status: 'unavailable' },
        ] } },
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Запросить предложение (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отправить запрос' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Ни одному кандидату запрос не отправлен')
    expect(view.container.textContent).toContain('Запрос уже открыт')
    expect(view.container.textContent).toContain('Анкета недоступна')
  })

  it('T3: место и сравнение различают предложение, отказ, истёкший срок и прежнюю дату', async () => {
    const offerEntry = entry('e1', 'v1', 'Анна Фотограф', 1, { request: { ...REQUEST, offer: { ...OFFER, validUntil: '2020-01-01' } } })
    const declineEntry = entry('e2', 'v2', 'Борис Фото', 2, { request: { ...REQUEST, id: 'r2', offer: { id: 'o2', requestId: 'r2', kind: 'decline', packageId: null, title: null, price: null, includes: [], message: 'Дата не подходит', validUntil: null } } })
    const oldEntry = entry('e3', 'v3', 'Вера Фото', 3, { request: { ...REQUEST, id: 'r3', weddingDate: '2027-05-01' } })
    const view = mount('/compare?slot=s1&entries=e1,e2,e3', { '/weddings/w1/slots/s1/shortlist': [offerEntry, declineEntry, oldEntry] })
    await screen.findByRole('table')
    expect(view.container.textContent).toContain('Срок предложения истёк')
    expect(view.container.textContent).toContain('День целиком')
    expect(view.container.textContent).toContain('Подрядчик отказался')
    expect(view.container.textContent).toContain('Дата не подходит')
    expect(view.container.textContent).toContain('На прежнюю дату — запросите заново')
  })

  it('T4: в анкете запрос появляется только после добавления в кандидаты', async () => {
    const current: ReturnType<typeof entry>[] = []
    const added = entry('e1', 'v1', 'Анна Фотограф', 1)
    const view = mount('/vendor/v1', {
      '/vendor/profile': withStatus(404, { error: { code: 'not_found', message: 'Анкета не найдена' } }),
      '/catalog/vendors/v1': { ...PROFILE, published: undefined, blocked: undefined },
      '/weddings/w1/slots/s1/shortlist': () => current,
      'PUT /weddings/w1/shortlist/v1': () => { current.push(added); return added },
    })
    expect(await screen.findByRole('button', { name: 'В кандидаты' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Запросить предложение' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'В кандидаты' }))
    expect(await screen.findByRole('button', { name: 'Запросить предложение' })).toBeTruthy()
    expect(view.calls.filter(call => call.method === 'PUT' && call.path === '/weddings/w1/shortlist/v1')).toHaveLength(1)
  })
})

describe('offers019 · кабинет подрядчика', () => {
  it('T5: пакет отправляется с ценой и ключом попытки', async () => {
    let requests: RequestFixture[] = [{ ...REQUEST }]
    const view = mount('/vendor-app/offer-requests', {
      '/vendor/offer-requests': () => requests,
      'POST /vendor/offer-requests/r1/offers': (call: Call) => {
        expect(call.body).toEqual({ kind: 'offer', packageId: 'p1', price: { amount: 250000, currency: 'RUB' } })
        expect(call.key).toBeTruthy()
        requests = [{ ...REQUEST, offer: OFFER }]
        return OFFER
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Отправить предложение' }))
    await waitFor(() => expect(view.calls.filter(call => call.method === 'POST')).toHaveLength(1))
    expect(await screen.findByRole('button', { name: 'Изменить ответ' })).toBeTruthy()
  })

  it('T6: после сетевого обрыва повтор той же формы использует тот же Idempotency-Key', async () => {
    let attempt = 0
    let requests: RequestFixture[] = [{ ...REQUEST }]
    const view = mount('/vendor-app/offer-requests', {
      '/vendor/offer-requests': () => requests,
      'POST /vendor/offer-requests/r1/offers': () => {
        attempt += 1
        if (attempt === 1) return Promise.reject(new TypeError('offline'))
        requests = [{ ...REQUEST, offer: OFFER }]
        return OFFER
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Отправить предложение' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Сервер недоступен. Попробуйте позже')
    fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }))
    await waitFor(() => expect(view.calls.filter(call => call.method === 'POST')).toHaveLength(2))
    const keys = view.calls.filter(call => call.method === 'POST').map(call => call.key)
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
  })

  it('T7: отказ требует объяснение и уходит строгой формой decline', async () => {
    const view = mount('/vendor-app/offer-requests', {
      '/vendor/offer-requests': [{ ...REQUEST }],
      'POST /vendor/offer-requests/r1/offers': (call: Call) => {
        expect(call.body).toEqual({ kind: 'decline', message: 'Уже занят на эту дату' })
        return { id: 'o2', requestId: 'r1', kind: 'decline', packageId: null, title: null, price: null, includes: [], message: 'Уже занят на эту дату', validUntil: null }
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Отказ' }))
    fireEvent.change(screen.getByPlaceholderText('Причина отказа'), { target: { value: 'Уже занят на эту дату' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить отказ' }))
    await waitFor(() => expect(view.calls.some(call => call.method === 'POST')).toBe(true))
  })
})

describe('offers019 · уведомления', () => {
  it('T8: постоянные строки переводятся, реплика чата остаётся авторской, ссылки ведут в нужную роль', async () => {
    setI18nLang('en')
    serve(baseRoutes({
      '/vendor/profile': withStatus(404, { error: { code: 'not_found', message: 'Анкета не найдена' } }),
      '/notifications': [
        { id: 'n1', kind: 'deal', title: 'Новое предложение', body: 'Подрядчик прислал предложение.', link: '/wedding/slot/s1', read: false, createdAt: '2026-09-27T10:00:00.000Z' },
        { id: 'n2', kind: 'chat', title: 'Марина', body: 'Да, конечно', link: null, read: true, createdAt: '2026-09-27T09:00:00.000Z' },
      ],
    }))
    render(<MemoryRouter initialEntries={['/notifications']}><Routes><Route path="/notifications" element={<Notifications />} /></Routes></MemoryRouter>)
    expect(await screen.findByText('New offer')).toBeTruthy()
    expect(screen.getByText('A vendor sent an offer.')).toBeTruthy()
    expect(screen.getByText('Марина')).toBeTruthy()
    expect(screen.getByText('Да, конечно')).toBeTruthy()
    expect(notificationRoute('/wedding/slot/s1')).toBe('/wedding/slot/s1')
    expect(notificationRoute('/vendor/offer-requests', { vendor: true })).toBe('/vendor-app/offer-requests')
    expect(notificationRoute('/vendor/offer-requests')).toBeNull()
  })
})

describe('offers019 · принятие и бронь (US3)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-27T10:00:00Z')) })
  afterEach(() => vi.useRealTimers())
  const acceptPath = 'POST /weddings/w1/offers/o1/accept'
  const offered = () => entry('e1', 'v1', 'Анна Фотограф', 1, { request: { ...REQUEST, offer: OFFER } })
  const booked = { ...SLOT, tileState: 'booked', deal: {
    id: 'deal1', state: 'booked', vendor: { id: 'v1', name: 'Анна Фотограф' },
    price: OFFER.price, paid: { amount: 0, currency: 'RUB' }, packageName: OFFER.title, packageIncludes: OFFER.includes,
  } }

  it.each(['/wedding/slot/s1', '/compare?slot=s1&entries=e1,e2'])('%s: accepts the stored offer, then reloads the slot and requests', async route => {
    let current = [offered(), E2]
    let isBooked = false
    const view = mount(route, {
      '/weddings/w1/slots': () => [isBooked ? booked : SLOT],
      '/weddings/w1/slots/s1/shortlist': () => current,
      [acceptPath]: (call: Call) => {
        expect(call.body).toEqual({}) // No client-controlled price, package or conditions.
        expect(call.key).toBeTruthy()
        isBooked = true
        current = [entry('e1', 'v1', 'Анна Фотограф', 1, { request: { ...REQUEST, status: 'closed', closeReason: 'booked', offer: OFFER } }), E2]
        return booked
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Принять предложение: День целиком' }))
    await screen.findByText('Предложение выбрано')
    expect(screen.queryByRole('button', { name: 'Принять предложение: День целиком' })).toBeNull()
    expect(view.calls.filter(call => `${call.method} ${call.path}` === acceptPath)).toHaveLength(1)
    expect(view.calls.filter(call => call.path === '/weddings/w1/slots').length).toBeGreaterThan(1)
    expect(view.calls.filter(call => call.path === '/weddings/w1/slots/s1/shortlist').length).toBeGreaterThan(1)
  })

  it('lost response retries the identical key, without a second intent', async () => {
    let first = true
    const view = mount('/wedding/slot/s1', {
      '/weddings/w1/slots/s1/shortlist': [offered()],
      [acceptPath]: () => { if (first) { first = false; throw new TypeError('connection lost') } return booked },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Принять предложение: День целиком' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Принять предложение: День целиком' }))
    await waitFor(() => expect(view.calls.filter(call => `${call.method} ${call.path}` === acceptPath)).toHaveLength(2))
    const attempts = view.calls.filter(call => `${call.method} ${call.path}` === acceptPath)
    expect(attempts[0]!.key).toBeTruthy()
    expect(attempts[1]!.key).toBe(attempts[0]!.key)
  })

  it('double tap while pending sends one POST', async () => {
    let resolve: (reply: Reply) => void = () => undefined
    const reply = new Promise<Reply>(done => { resolve = done })
    const view = mount('/wedding/slot/s1', {
      '/weddings/w1/slots/s1/shortlist': [offered()], [acceptPath]: () => reply,
    })
    const button = await screen.findByRole('button', { name: 'Принять предложение: День целиком' })
    fireEvent.click(button); fireEvent.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(view.calls.filter(call => `${call.method} ${call.path}` === acceptPath)).toHaveLength(1)
    resolve(booked)
    await waitFor(() => expect(view.calls.filter(call => call.path === '/weddings/w1/slots').length).toBeGreaterThan(1))
  })

  it.each(['offer_expired', 'offer_stale_date', 'offer_superseded', 'request_closed', 'offer_declined', 'slot_taken', 'date_taken', 'vendor_unavailable'])('409 %s is visible, requires reload and never claims success', async code => {
    const view = mount('/compare?slot=s1&entries=e1,e2', {
      '/weddings/w1/slots/s1/shortlist': [offered(), E2],
      [acceptPath]: withStatus(409, { error: { code, message: 'REFUSAL_CANARY' } }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Принять предложение: День целиком' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('REFUSAL_CANARY')
    expect(alert.textContent!.length).toBeGreaterThan(10)
    expect(screen.queryByText('Бронь создана по условиям предложения')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Принять предложение: День целиком' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Обновить предложения' }))
    await waitFor(() => expect(view.calls.filter(call => call.path === '/weddings/w1/slots/s1/shortlist').length).toBeGreaterThan(1))
  })

  it.each(['helper', 'coordinator'])('%s cannot accept on the slot or comparison', async role => {
    for (const route of ['/wedding/slot/s1', '/compare?slot=s1&entries=e1,e2']) {
      const view = mount(route, {
        '/weddings': [{ ...WEDDING, role }],
        '/weddings/w1/slots/s1/shortlist': [offered(), E2],
      })
      await screen.findByText('День целиком')
      expect(screen.queryByRole('button', { name: /Принять предложение/ })).toBeNull()
      view.unmount()
    }
  })

  it.each(['expired', 'oldDate', 'closed', 'busy', 'unavailable', 'booked'])('%s is not actionable', async state => {
    const request = { ...REQUEST, offer: { ...OFFER, ...(state === 'expired' ? { validUntil: '2020-01-01' } : {}) },
      ...(state === 'oldDate' ? { weddingDate: '2027-05-01' } : {}),
      ...(state === 'closed' ? { status: 'closed', closeReason: 'removed' } : {}),
    }
    mount('/wedding/slot/s1', {
      '/weddings/w1/slots': [state === 'booked' ? booked : SLOT],
      '/weddings/w1/slots/s1/shortlist': [entry('e1', 'v1', 'Анна Фотограф', 1, {
        request, ...(state === 'busy' ? { occupancy: 'busy' } : {}), ...(state === 'unavailable' ? { available: false } : {}),
      })],
    })
    await screen.findByText('День целиком')
    expect(screen.queryByRole('button', { name: /Принять предложение/ })).toBeNull()
  })

  it('validUntil uses the wedding timezone even when the device already crossed midnight', async () => {
    vi.setSystemTime(new Date('2026-09-28T01:00:00Z'))
    mount('/wedding/slot/s1', {
      '/weddings': [{ ...WEDDING, role: 'couple', tz: 'Pacific/Honolulu' }],
      '/weddings/w1/slots/s1/shortlist': [entry('e1', 'v1', 'Анна Фотограф', 1, {
        request: { ...REQUEST, offer: { ...OFFER, validUntil: '2026-09-27' } },
      })],
    })
    expect(await screen.findByRole('button', { name: 'Принять предложение: День целиком' })).toBeTruthy()
    expect(screen.queryByText('Срок предложения истёк')).toBeNull()
  })
})
