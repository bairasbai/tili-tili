// @vitest-environment jsdom
/* Independent rendered witnesses: real Router, StoreProvider and API client.
 * All people, weddings and HTTP responses below are synthetic fixtures. These
 * tests do not establish PostgreSQL authorization, human consent or booking. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from '@/lib/store'
import { saveTokens } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'
import { VendorCard } from '@/components/chrome'
import { VendorDetail } from '@/pages/Search'
import { Compare } from '@/pages/Smart'

const W = '10000000-0000-4000-8000-000000000001'
const W2 = '10000000-0000-4000-8000-000000000002'
const S = '20000000-0000-4000-8000-000000000001'
const V = '30000000-0000-4000-8000-000000000001'
const V2 = '30000000-0000-4000-8000-000000000002'
const P = '40000000-0000-4000-8000-000000000001'
const P2 = '40000000-0000-4000-8000-000000000002'
const D = '50000000-0000-4000-8000-000000000001'
const OLD = '50000000-0000-4000-8000-000000000002'
const PREP = `/weddings/${W}/slots/${S}/resource-order`
const POLICY = `/vendors/${V}/booking-policy`
const wedding = { id: W, title: 'Анна и Борис', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: '60000000-0000-4000-8000-000000000001', name: 'Анна' }, role: 'couple' }] }
const slot = { id: S, categoryId: 'photo', label: 'Фотограф', tileState: 'empty', deal: null }
const vendor = { id: V, name: 'Студия Анны', categoryId: 'photo', city: 'Уфа', priceFrom: { amount: 150000, currency: 'RUB' }, rating: 4.9, reviewsCount: 3, verified: false, hasVideo: false, photoUrl: null, about: 'Свадебные фотографии', phone: null, gallery: [], media: [], packages: [{ id: P, name: 'Съёмка церемонии', price: { amount: 150000, currency: 'RUB' }, includes: ['Два часа'] }, { id: P2, name: 'Съёмка праздника', price: null, includes: ['По согласованию'] }] }
const policy = { mode: 'resources', revision: '7' } satisfies components['schemas']['VendorBookingPolicy']
const preparation = { dealId: D, state: 'candidate', orderVersion: '1', created: true } satisfies components['schemas']['ResourceOrderPreparationResult']
const noCommitments = { revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' } satisfies components['schemas']['OrderResourceCommitmentView']
type Call = { method: string; path: string; body: unknown; rawBody: string | null; headers: Headers }
type Status = { status: number; body: unknown }
type Handler = (call: Call) => unknown | Promise<unknown>
type Network = Record<string, unknown | Handler>
let activeNetwork: { unexpected: string[] } | null = null
const restoreNavigator: Array<() => void> = []
function navigatorCapability(name: 'share' | 'clipboard', value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, name)
  Object.defineProperty(navigator, name, { configurable: true, writable: true, value })
  restoreNavigator.push(() => {
    if (descriptor) Object.defineProperty(navigator, name, descriptor)
    else Reflect.deleteProperty(navigator, name)
  })
}
const failure = (status: number, code: string, message: string): Status => ({ status, body: { error: { code, message } } })
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const isStatus = (value: unknown): value is Status => typeof value === 'object' && value !== null && 'status' in value && 'body' in value && typeof value.status === 'number'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function serve(overrides: Network = {}) {
  const routes: Network = {
    '/weddings': [{ ...wedding, role: 'couple' }, { ...wedding, id: W2, role: 'couple' }],
    [`/weddings/${W}`]: wedding, [`/weddings/${W2}`]: { ...wedding, id: W2 },
    [`/weddings/${W}/slots`]: [slot], [`/weddings/${W2}/slots`]: [slot],
    '/me/favorites': [], '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
    [`/catalog/vendors/${V}`]: vendor, [`/catalog/vendors/${V2}`]: { ...vendor, id: V2, name: 'Студия Бориса' },
    [`/catalog/vendors/${V}/availability`]: { busyDates: [], holdDates: [] }, [`/catalog/vendors/${V2}/availability`]: { busyDates: [], holdDates: [] },
    [`/catalog/vendors/${V}/reviews`]: { items: [], nextCursor: null }, [`/catalog/vendors/${V2}/reviews`]: { items: [], nextCursor: null },
    '/catalog/vendors': { items: [], nextCursor: null }, '/vendor/profile': failure(404, 'not_found', 'Анкета не найдена'),
    [POLICY]: policy, [`/vendors/${V2}/booking-policy`]: policy,
    [`/weddings/${W}/slots/${S}/shortlist`]: [], [`/weddings/${W2}/slots/${S}/shortlist`]: [],
    [`POST ${PREP}`]: preparation,
    ...overrides,
  }
  const calls: Call[] = []
  const unexpected: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
    const rawBody = init?.body == null ? null : String(init.body)
    const call = { method: init?.method ?? 'GET', path, rawBody, body: rawBody === null ? null : JSON.parse(rawBody) as unknown, headers: new Headers(init?.headers) }
    calls.push(call)
    const reply = routes[`${call.method} ${path}`] ?? (call.method === 'GET' ? routes[path] : undefined)
    if (reply === undefined) { unexpected.push(`${call.method} ${path}`); return json(failure(404, 'not_found', 'Неизвестный тестовый маршрут').body, 404) }
    const value = typeof reply === 'function' ? await (reply as Handler)(call) : reply
    return value instanceof Response ? value : isStatus(value) ? json(value.body, value.status) : json(value)
  }))
  activeNetwork = { unexpected }
  return { calls, unexpected }
}
// Exercise the real store's public scope setters without mocking its context.
function ScopeControls() {
  const store = useStore(), nav = useNavigate()
  return <aside aria-label="Тестовый контроль контекста">
    <output aria-label="Выбранная сделка">{store.slots.find(item => item.id === S)?.dealId ?? ''}</output>
    <button onClick={() => store.setWeddingId(W2)}>Другая свадьба</button>
    <button onClick={store.refreshSlots}>Перечитать выбранную сделку</button>
    <button onClick={() => nav(`/vendor/${V2}`)}>Другая компания</button>
    <button onClick={() => { saveTokens(null); store.forgetSession() }}>Выход из сессии</button>
    <button onClick={() => saveTokens({ accessToken: 'different-subject-session', refreshToken: 'different-refresh' })}>Новая сессия</button>
  </aside>
}
function DealDestination() { const { id } = useParams(); return <p role="status">Открыт заказ {id}</p> }
function mount(overrides: Network = {}, route = `/vendor/${V}`) {
  const network = serve(overrides)
  const view = render(<MemoryRouter initialEntries={[route]}><StoreProvider><ScopeControls /><Routes>
    <Route path="/vendor/:id" element={<VendorDetail />} /><Route path="/deal/:id" element={<DealDestination />} />
    <Route path="/compare" element={<Compare />} /><Route path="/wedding" element={<p>Моя свадьба</p>} />
  </Routes></StoreProvider></MemoryRouter>)
  return { ...view, ...network }
}
const writes = (calls: Call[]) => calls.filter(call => call.method !== 'GET')
const prepCalls = (calls: Call[]) => calls.filter(call => call.path.endsWith('/resource-order') && call.method === 'POST')
async function action(name = 'Подготовить заказ') {
  const button = await screen.findByRole('button', { name })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  return button
}
async function resourceError() { return screen.findByText('Сервер недоступен. Попробуйте позже') }
beforeEach(() => {
  activeNetwork = null
  localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('tt_onboarded', '1'); localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify(wedding.date))
  saveTokens({ accessToken: 'synthetic-couple-session', refreshToken: 'synthetic-refresh' })
})
afterEach(() => {
  cleanup(); restoreNavigator.splice(0).reverse().forEach(restore => restore()); vi.unstubAllGlobals(); localStorage.clear()
  expect(activeNetwork?.unexpected ?? []).toEqual([])
})

describe('vendor location is a profile fact rather than the couple search city', () => {
  it.each([null, ''])('unknown vendor city %j stays unknown even though this wedding and search use Ufa', async city => {
    const view = mount({ [`/catalog/vendors/${V}`]: { ...vendor, city } })
    const heading = await screen.findByRole('heading', { name: vendor.name })
    const location = heading.parentElement?.querySelector('p')
    expect(location).toBeTruthy()
    expect(location?.textContent).toMatch(/город не указан/i)
    expect(location?.textContent).not.toContain('Уфа')
    expect(writes(view.calls)).toEqual([])
  })
  it('a known vendor city is displayed even when it differs from the wedding/search city', async () => {
    const view = mount({ [`/catalog/vendors/${V}`]: { ...vendor, city: 'Москва' } })
    const heading = await screen.findByRole('heading', { name: vendor.name })
    const location = heading.parentElement?.querySelector('p')
    expect(location?.textContent).toContain('Москва')
    expect(location?.textContent).not.toContain('Уфа')
    expect(location?.textContent).not.toMatch(/город не указан/i)
    expect(writes(view.calls)).toEqual([])
  })
  it.each([null, '', 'Москва'])('native sharing preserves the actual profile without inventing the search location (city=%j)', async city => {
    const share = vi.fn<(data: ShareData) => Promise<void>>().mockResolvedValue(undefined)
    navigatorCapability('share', share)
    const view = mount({ [`/catalog/vendors/${V}`]: { ...vendor, city } })
    await screen.findByRole('heading', { name: vendor.name })
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }))
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    const shared = share.mock.calls[0]?.[0]
    expect(shared?.title).toContain(vendor.name)
    expect(shared?.text).toContain('Фотограф')
    expect(shared?.url).toBe(window.location.href)
    expect(`${shared?.title} ${shared?.text}`).not.toContain('Уфа')
    if (city) expect(shared?.text).toContain(city)
    expect(writes(view.calls)).toEqual([])
  })
  it.each([null, '', 'Москва'])('clipboard sharing preserves the same profile facts without native sharing (city=%j)', async city => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined)
    navigatorCapability('share', undefined)
    navigatorCapability('clipboard', { writeText })
    const view = mount({ [`/catalog/vendors/${V}`]: { ...vendor, city } })
    await screen.findByRole('heading', { name: vendor.name })
    fireEvent.click(screen.getByRole('button', { name: 'Поделиться' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const shared = writeText.mock.calls[0]?.[0]
    expect(shared).toContain(vendor.name)
    expect(shared).toContain('Фотограф')
    expect(shared).toContain(window.location.href)
    expect(shared).not.toContain('Уфа')
    if (city) expect(shared).toContain(city)
    expect(await screen.findByRole('button', { name: 'Скопировано' })).toBeTruthy()
    expect(writes(view.calls)).toEqual([])
  })
})

describe('catalogue resource order: deliberate preparation, never a day booking', () => {
  it.each(['candidate', 'contacted', 'negotiating'])('opens the actual returned %s deal without a booking or fabricated success', async state => {
    const view = mount({ [`POST ${PREP}`]: { ...preparation, state } })
    const button = await action()
    expect(writes(view.calls)).toEqual([])
    expect(screen.queryByText('● Свободен на вашу дату')).toBeNull()
    expect(screen.getByText(/Календарь дней не подтверждает их доступность/)).toBeTruthy()
    fireEvent.click(button)
    expect(await screen.findByText(`Открыт заказ ${D}`)).toBeTruthy()
    expect(writes(view.calls).map(call => call.path)).toEqual([PREP])
    expect(prepCalls(view.calls)[0]?.body).toEqual({ vendorId: V, packageId: P, expectedSelectedDealId: null, expectedPolicyRevision: '7' })
    expect(prepCalls(view.calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy()
    expect(screen.queryByText('✓ В моей свадьбе!')).toBeNull()
    expect(view.unexpected).toEqual([])
  })
  it.each([null, []])('accepts an unknown package price or no package without inventing zero (%j)', async packages => {
    const detail = { ...vendor, packages: packages === null ? [{ ...vendor.packages[0], price: null }] : packages }
    const view = mount({ [`/catalog/vendors/${V}`]: detail })
    fireEvent.click(await action())
    await screen.findByText(`Открыт заказ ${D}`)
    expect(prepCalls(view.calls)[0]?.body).toEqual({ vendorId: V, packageId: packages === null ? P : null, expectedSelectedDealId: null, expectedPolicyRevision: '7' })
    expect(writes(view.calls)).toHaveLength(1)
  })
  it('passes the actual selected deal identity, not a made-up empty selection', async () => {
    const view = mount({ [`/weddings/${W}/slots`]: [{ ...slot, tileState: 'candidate', deal: { id: OLD, state: 'candidate', vendor: { id: V2, name: 'Предыдущий кандидат' }, price: null } }] })
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    expect(prepCalls(view.calls)[0]?.body).toEqual({ vendorId: V, packageId: P, expectedSelectedDealId: OLD, expectedPolicyRevision: '7' })
  })
  it('creates a missing category position first and prepares in its real returned slot', async () => {
    const createdSlot = '20000000-0000-4000-8000-000000000009'
    const actualPath = `/weddings/${W}/slots/${createdSlot}/resource-order`
    const view = mount({ [`/weddings/${W}/slots`]: [], [`POST /weddings/${W}/slots`]: { ...slot, id: createdSlot }, [`POST ${actualPath}`]: preparation })
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    expect(writes(view.calls).map(call => ({ path: call.path, body: call.body }))).toEqual([
      { path: `/weddings/${W}/slots`, body: { categoryId: 'photo' } },
      { path: actualPath, body: { vendorId: V, packageId: P, expectedSelectedDealId: null, expectedPolicyRevision: '7' } },
    ])
    expect(view.unexpected).toEqual([])
  })
  it('an already selected order opens its existing identity without preparing or booking again', async () => {
    const view = mount({ [`/weddings/${W}/slots`]: [{ ...slot, tileState: 'candidate', deal: { id: OLD, state: 'candidate', vendor: { id: V, name: vendor.name }, price: null } }] })
    fireEvent.click(await screen.findByRole('button', { name: '✓ В моей свадьбе · открыть сделку' }))
    await screen.findByText(`Открыт заказ ${OLD}`)
    expect(writes(view.calls)).toEqual([])
  })
  it('retains the existing legacy booking action, its chosen price and package', async () => {
    const book = `/weddings/${W}/slots/${S}/book`
    const view = mount({ [POLICY]: { ...policy, mode: 'legacy_day', revision: '0' }, [`POST ${book}`]: { ...slot, tileState: 'booked', deal: { id: D } } })
    expect(await screen.findByText('● Свободен на вашу дату')).toBeTruthy()
    fireEvent.click(await action('Добавить в свадьбу'))
    await screen.findByText('✓ В моей свадьбе!')
    expect(writes(view.calls).map(call => ({ path: call.path, body: call.body }))).toEqual([{ path: book, body: { vendorId: V, packageId: P, price: { amount: 150000, currency: 'RUB' } } }])
    expect(prepCalls(view.calls)).toEqual([])
  })
  it('does not day-book an unknown quote', async () => {
    const view = mount({ [POLICY]: { ...policy, mode: 'legacy_day' }, [`/catalog/vendors/${V}`]: { ...vendor, packages: [{ ...vendor.packages[0], price: null }] } })
    fireEvent.click(await action('Добавить в свадьбу'))
    await screen.findByText('У этого подрядчика не указана цена пакета')
    expect(writes(view.calls)).toEqual([])
  })
  it.each([null, { ...policy, mode: 'future_mode' }, { ...policy, revision: '-1' }, { ...policy, revision: '07' }, failure(503, 'unavailable', 'Сервер недоступен')])('unknown policy %j makes no free-date claim or booking write', async reply => {
    const view = mount({ [POLICY]: reply })
    await screen.findByText('Способ бронирования пока неизвестен — свободная дата не подтверждена')
    expect(screen.queryByText('● Свободен на вашу дату')).toBeNull()
    fireEvent.click(await action('Добавить в свадьбу'))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Добавить в свадьбу' }) as HTMLButtonElement).disabled).toBe(false))
    expect(writes(view.calls)).toEqual([])
  })
  it('rereads a changed legacy policy before acting and prepares instead of booking', async () => {
    let reads = 0
    const view = mount({ [POLICY]: () => ++reads === 1 ? { ...policy, mode: 'legacy_day' } : policy })
    fireEvent.click(await action('Добавить в свадьбу'))
    await screen.findByText(`Открыт заказ ${D}`)
    expect(writes(view.calls).map(call => call.path)).toEqual([PREP])
  })
  it.each(['helper', 'coordinator'])('a current %s can read but cannot select this order', async role => {
    const view = mount({ '/weddings': [{ ...wedding, role }] })
    const button = await screen.findByRole('button', { name: 'Подготовить заказ' })
    await waitFor(() => expect(view.calls.some(call => call.path.endsWith('/shortlist'))).toBe(true))
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button); expect(writes(view.calls)).toEqual([])
  })
  it('awaits the current role instead of acting on a remembered wedding identifier', async () => {
    const roles = deferred<unknown>()
    const view = mount({ '/weddings': () => roles.promise })
    const button = await screen.findByRole('button', { name: 'Подготовить заказ' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button); expect(writes(view.calls)).toEqual([])
    await act(async () => { roles.resolve([{ ...wedding, role: 'couple' }]) })
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    expect(writes(view.calls).map(call => call.path)).toEqual([PREP])
  })
  it('single pending preparation prevents a second pointer or keyboard submission', async () => {
    const held = deferred<unknown>()
    const view = mount({ [`POST ${PREP}`]: () => held.promise })
    const button = await action(); fireEvent.click(button)
    await waitFor(() => expect(prepCalls(view.calls)).toHaveLength(1))
    const busy = screen.getByRole('button', { name: 'Подготавливаем заказ…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(busy); fireEvent.keyDown(busy, { key: 'Enter' })
    expect(prepCalls(view.calls)).toHaveLength(1)
    await act(async () => { held.resolve(preparation) })
    await screen.findByText(`Открыт заказ ${D}`)
  })
})

describe('resource preparation retries and scope boundaries', () => {
  it('replays the exact lost-response body and key even if a new policy revision is read', async () => {
    let attempts = 0, reads = 0
    const view = mount({ [POLICY]: () => ({ ...policy, revision: String(7 + reads++) }), [`POST ${PREP}`]: () => { if (++attempts === 1) throw new TypeError('Synthetic lost response'); return preparation } })
    fireEvent.click(await action()); await resourceError()
    expect(screen.queryByText(`Открыт заказ ${D}`)).toBeNull()
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    const requests = prepCalls(view.calls)
    expect(requests).toHaveLength(2)
    expect(requests[1]?.rawBody).toBe(requests[0]?.rawBody)
    expect(requests[1]?.headers.get('Idempotency-Key')).toBe(requests[0]?.headers.get('Idempotency-Key'))
    expect(writes(view.calls)).toHaveLength(2)
  })
  it('changing the selected package after an uncertain response creates a distinct intention', async () => {
    let attempts = 0
    const view = mount({ [`POST ${PREP}`]: () => { if (++attempts === 1) throw new TypeError('Lost'); return preparation } })
    fireEvent.click(await action()); await resourceError()
    fireEvent.click(screen.getByRole('button', { name: /Съёмка праздника/ }))
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    const requests = prepCalls(view.calls)
    expect(requests[1]?.body).toEqual({ vendorId: V, packageId: P2, expectedSelectedDealId: null, expectedPolicyRevision: '7' })
    expect(requests[1]?.headers.get('Idempotency-Key')).not.toBe(requests[0]?.headers.get('Idempotency-Key'))
  })
  it('a definite stale-selection refusal clears the retry key and shows no success', async () => {
    let attempts = 0
    const view = mount({ [`POST ${PREP}`]: () => ++attempts === 1 ? failure(409, 'selection_changed', 'Выбранная сделка изменилась') : preparation })
    fireEvent.click(await action()); await screen.findByText('Выбранная сделка изменилась')
    expect(screen.queryByText('✓ В моей свадьбе!')).toBeNull()
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    const requests = prepCalls(view.calls)
    expect(requests[1]?.headers.get('Idempotency-Key')).not.toBe(requests[0]?.headers.get('Idempotency-Key'))
  })
  it('a newly selected deal is a new scope rather than a retry of the old selection', async () => {
    let currentSlot: unknown = slot, attempts = 0
    const view = mount({ [`/weddings/${W}/slots`]: () => [currentSlot], [`POST ${PREP}`]: () => { if (++attempts === 1) throw new TypeError('Lost'); return preparation } })
    fireEvent.click(await action()); await resourceError()
    currentSlot = { ...slot, tileState: 'candidate', deal: { id: OLD, state: 'candidate', vendor: { id: V2, name: 'Другой кандидат' }, price: null } }
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать выбранную сделку' }))
    await waitFor(() => expect(screen.getByLabelText('Выбранная сделка').textContent).toBe(OLD))
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    const requests = prepCalls(view.calls)
    expect(requests[1]?.body).toEqual({ vendorId: V, packageId: P, expectedSelectedDealId: OLD, expectedPolicyRevision: '7' })
    expect(requests[1]?.headers.get('Idempotency-Key')).not.toBe(requests[0]?.headers.get('Idempotency-Key'))
  })
  it.each(['Другая свадьба', 'Другая компания', 'Новая сессия', 'Выход из сессии'])('ignores a late successful response after %s', async boundary => {
    const held = deferred<unknown>()
    const view = mount({ [`POST ${PREP}`]: () => held.promise })
    fireEvent.click(await action()); await waitFor(() => expect(prepCalls(view.calls)).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: boundary }))
    await act(async () => { held.resolve(preparation) })
    expect(screen.queryByText(`Открыт заказ ${D}`)).toBeNull()
    expect(screen.queryByText('✓ В моей свадьбе!')).toBeNull()
    expect(prepCalls(view.calls)).toHaveLength(1)
    if (boundary !== 'Выход из сессии') await screen.findByRole('heading', { name: boundary === 'Другая компания' ? 'Студия Бориса' : 'Студия Анны' })
  })
  it('a wedding change drops uncertain preparation and uses the actual new URL/key', async () => {
    const next = `/weddings/${W2}/slots/${S}/resource-order`
    const view = mount({ [`POST ${PREP}`]: () => { throw new TypeError('Lost') }, [`POST ${next}`]: preparation })
    fireEvent.click(await action()); await resourceError()
    fireEvent.click(screen.getByRole('button', { name: 'Другая свадьба' }))
    fireEvent.click(await action()); await screen.findByText(`Открыт заказ ${D}`)
    const requests = prepCalls(view.calls)
    expect(requests.map(call => call.path)).toEqual([PREP, next])
    expect(requests[1]?.headers.get('Idempotency-Key')).not.toBe(requests[0]?.headers.get('Idempotency-Key'))
  })
  it.each(['Другая свадьба', 'Другая компания', 'Новая сессия', 'Выход из сессии'])('a policy response arriving after %s cannot start any write', async boundary => {
    const held = deferred<unknown>(); let reads = 0
    const view = mount({ [POLICY]: () => ++reads === 1 ? policy : held.promise })
    fireEvent.click(await action())
    await waitFor(() => expect(reads).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: boundary }))
    await act(async () => { held.resolve(policy) })
    expect(writes(view.calls)).toEqual([])
    expect(screen.queryByText(`Открыт заказ ${D}`)).toBeNull()
  })
  it.each([{ state: 'candidate' }, { dealId: D, state: 'booked' }])('an unconfirmed reply %j never navigates or claims booking', async reply => {
    const view = mount({ [`POST ${PREP}`]: reply })
    fireEvent.click(await action())
    await screen.findByText('Подготовка заказа пока не подтверждена — обновите сведения')
    expect(screen.queryByText(`Открыт заказ ${D}`)).toBeNull()
    expect(screen.queryByText('✓ В моей свадьбе!')).toBeNull()
    expect(writes(view.calls)).toHaveLength(1)
  })
})

function replacement(overrides: Network = {}) {
  const candidate = { id: '70000000-0000-4000-8000-000000000001', slotId: S, position: 1, createdAt: '2026-09-30T10:00:00Z', available: true, occupancy: 'free', vendor: { ...vendor, bookingMode: 'legacy_day' } }
  return mount({ [POLICY]: { ...policy, mode: 'legacy_day' }, [`/weddings/${W}/slots`]: [{ ...slot, tileState: 'booked', deal: { id: OLD, state: 'booked', vendor: { id: V2, name: 'Прежний подрядчик' }, price: { amount: 270000, currency: 'RUB' } } }], [`/weddings/${W}/slots/${S}/shortlist`]: [candidate], [`/deals/${OLD}/order/resource-commitments`]: noCommitments, ...overrides }, `/vendor/${V}?replaceSlot=${S}`)
}
describe('replacement precheck preserves the existing promise', () => {
  it('a new resources company refuses legacy cancellation before either write', async () => {
    const view = replacement({ [POLICY]: policy })
    fireEvent.click(await action('Заменить в свадьбе'))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('Для замены нужно согласовать ресурсы.')
    expect(writes(view.calls)).toEqual([])
  })
  it('an old reserved resource commitment also blocks a new legacy company', async () => {
    const view = replacement({ [`/deals/${OLD}/order/resource-commitments`]: { ...noCommitments, revision: '1', state: 'reserved', reservation: 'reserved', termsId: '80000000-0000-4000-8000-000000000001', planRevisionId: '90000000-0000-4000-8000-000000000001' } })
    fireEvent.click(await action('Заменить в свадьбе'))
    await screen.findByText('Для замены нужно согласовать ресурсы.')
    expect(writes(view.calls)).toEqual([])
  })
  it.each([null, { state: 'unknown' }, failure(403, 'forbidden', 'Этот заказ вам недоступен')])('unknown old commitment %j cannot silently cancel', async reply => {
    const view = replacement({ [`/deals/${OLD}/order/resource-commitments`]: reply })
    fireEvent.click(await action('Заменить в свадьбе'))
    await screen.findByRole('alert'); expect(writes(view.calls)).toEqual([])
  })
  it('fresh resource policy supersedes the displayed legacy policy before old cancellation', async () => {
    let reads = 0
    const view = replacement({ [POLICY]: () => ++reads === 1 ? { ...policy, mode: 'legacy_day' } : policy })
    fireEvent.click(await action('Заменить в свадьбе'))
    await screen.findByText('Для замены нужно согласовать ресурсы.')
    expect(writes(view.calls)).toEqual([])
  })
  it.each(['Другая свадьба', 'Новая сессия', 'Выход из сессии'])('a late old-commitment read after %s cannot cancel the old promise', async boundary => {
    const held = deferred<unknown>()
    const path = `/deals/${OLD}/order/resource-commitments`
    const view = replacement({ [path]: () => held.promise })
    fireEvent.click(await action('Заменить в свадьбе'))
    await waitFor(() => expect(view.calls.some(call => call.path === path)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: boundary }))
    await act(async () => { held.resolve(noCommitments) })
    expect(writes(view.calls)).toEqual([])
    expect(screen.queryByText('Подрядчик заменён в свадьбе')).toBeNull()
  })
  it('known legacy replacement remains reachable and ordered after its read prechecks', async () => {
    const replace = `/weddings/${W}/slots/${S}/replace`
    const view = replacement({ [`POST ${replace}`]: { ...slot, tileState: 'booked', deal: { id: D, state: 'booked', vendor: { id: V, name: vendor.name }, price: { amount: 150000, currency: 'RUB' } } } })
    fireEvent.click(await action('Заменить в свадьбе'))
    await screen.findByText('Подрядчик заменён в свадьбе')
    expect(writes(view.calls).map(call => call.path)).toEqual([replace])
    const commitmentsIndex = view.calls.findIndex(call => call.path === `/deals/${OLD}/order/resource-commitments`)
    expect(commitmentsIndex).toBeGreaterThan(-1)
    expect(view.calls.findIndex(call => call.path === replace)).toBeGreaterThan(commitmentsIndex)
    expect(writes(view.calls)[0]?.body).toEqual({ expectedSelectedDealId: OLD, expectedSelectedDealState: 'booked', vendorId: V, packageId: P, price: { amount: 150000, currency: 'RUB' }, expectedPolicyRevision: '7' })
    expect(writes(view.calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy()
  })
})

describe('catalogue badges and comparison distinguish day availability from resource mode', () => {
  it.each(['resources', undefined, 'legacy_day'] as const)('a VendorCard with mode %s only claims free day when known legacy', async bookingMode => {
    const network = serve()
    render(<MemoryRouter><StoreProvider><VendorCard v={{ ...vendor, bookingMode }} freeOnDate categoryTitle="Фотограф" onOpen={() => {}} /></StoreProvider></MemoryRouter>)
    await screen.findByText('Студия Анны')
    expect(screen.queryByText('● Свободен на вашу дату') !== null).toBe(bookingMode === 'legacy_day')
    expect(writes(network.calls)).toEqual([])
  })
  it('the actual shortlist comparison suppresses free occupancy for resource and unknown companies with a legacy positive control', async () => {
    // A stale/adversarial legacy occupancy must never override known resource
    // mode. This DOM fixture deliberately challenges that screen boundary.
    const entries = [
      { id: 'e1', slotId: S, position: 1, createdAt: '2026-09-30T10:00:00Z', available: true, occupancy: 'free', vendor: { ...vendor, bookingMode: 'resources' } },
      { id: 'e2', slotId: S, position: 2, createdAt: '2026-09-30T10:00:00Z', available: true, occupancy: 'free', vendor: { ...vendor, id: V2, name: 'Неизвестный способ' } },
      { id: 'e3', slotId: S, position: 3, createdAt: '2026-09-30T10:00:00Z', available: true, occupancy: 'free', vendor: { ...vendor, id: '30000000-0000-4000-8000-000000000003', name: 'Дневная бронь', bookingMode: 'legacy_day' } },
    ]
    const view = mount({ [`/weddings/${W}/slots/${S}/shortlist`]: entries }, `/compare?slot=${S}&entries=e1,e2,e3`)
    const table = await screen.findByRole('table')
    const row = within(table).getByRole('row', { name: /Свободен на вашу дату/ })
    expect(within(row).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['—', '—', 'Свободен'])
    expect(writes(view.calls)).toEqual([])
    expect(view.unexpected).toEqual([])
  })
})
