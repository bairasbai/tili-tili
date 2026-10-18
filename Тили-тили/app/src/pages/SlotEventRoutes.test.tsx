// @vitest-environment jsdom
// SOURCE-only regression authoring: real pages/Store/client; only HTTP and clock
// are controlled. No claim about native ACL, inventory or booking is made here.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from '@/lib/store'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import { Compare } from '@/pages/Smart'
import { VendorDetail, VendorList } from '@/pages/Search'

const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), MAIN = id(2), EXTRA = id(3), MAIN_EVENT = id(4), EXTRA_EVENT = id(5)
const V = id(6), V2 = id(7), E1 = id(8), E2 = id(9), MISSING = id(10)
const MAIN_DATE = '2030-06-14', EXTRA_DATE = '2030-08-15'
const MAIN_TZ = 'Pacific/Honolulu', EXTRA_TZ = 'Pacific/Kiritimati'
type Context = { id: string; name: string; kind: string; date: string | null; timeZone: string | null; location: string | null; isMain: boolean }
const event = (patch: Partial<Context> = {}): Context => ({ id: EXTRA_EVENT, name: 'Ужин после церемонии', kind: 'dinner', date: EXTRA_DATE, timeZone: EXTRA_TZ, location: 'Второй зал', isMain: false, ...patch })
const wedding = { id: W, title: 'Основная свадьба', date: MAIN_DATE, tz: MAIN_TZ, city: { name: 'Уфа', region: 'Башкортостан' } }
const vendor = { id: V, name: 'Фотограф ужина', categoryId: 'photo', city: 'Уфа', priceFrom: { amount: 1357900, currency: 'RUB' }, rating: 4.9, reviewsCount: 3, verified: false, hasVideo: false, photoUrl: null, bookingMode: 'legacy_day', about: 'Синтетическая анкета', phone: null, gallery: [], media: [], packages: [] }
type Call = { method: string; path: string; query: URLSearchParams; raw: string | null }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function network(options: { context?: Context | null; compare?: boolean; replacement?: boolean } = {}) {
  let context = options.context === undefined ? event() : options.context
  const calls: Call[] = [], unexpected: string[] = []
  const slots = () => [
    { id: MAIN, categoryId: 'photo', label: 'Фотограф основной церемонии', tileState: 'empty', deal: null,
      programEvent: { id: MAIN_EVENT, name: 'Церемония', kind: 'ceremony', date: MAIN_DATE, timeZone: MAIN_TZ, location: 'Первый зал', isMain: true } },
    { id: EXTRA, categoryId: 'photo', label: 'Фотограф дополнительного ужина', tileState: options.replacement ? 'booked' : 'empty', programEvent: context,
      deal: options.replacement ? { id: id(30), state: 'booked', vendor: { id: id(31), name: 'Предыдущий фотограф' }, price: { amount: 2468000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } } : null },
  ]
  const entry = (entryId: string, vendorId: string, title: string) => ({ id: entryId, slotId: EXTRA, position: entryId === E1 ? 1 : 2, createdAt: '2029-01-01T10:00:00.000Z', available: true, occupancy: 'free',
    availabilityObservation: { source: 'legacy_day', date: EXTRA_DATE, checkedAt: '2030-06-14T10:00:00.000Z' },
    vendor: { ...vendor, id: vendorId, name: title }, request: { id: id(entryId === E1 ? 40 : 41), status: 'open', weddingDate: EXTRA_DATE, guests: 60, city: 'Уфа', wishes: 'Ужин', createdAt: '2029-01-01T10:00:00.000Z',
      offer: { id: id(entryId === E1 ? 42 : 43), requestId: id(entryId === E1 ? 40 : 41), kind: 'offer', packageId: null, title: `Условия ${title}`, price: { amount: 1357900, currency: 'RUB' }, includes: ['Репортаж'], message: null, validUntil: '2030-06-14' } } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'), path = url.pathname.replace(/^\/api/, '')
    const call = { method: init?.method ?? 'GET', path, query: url.searchParams, raw: init?.body == null ? null : String(init.body) }; calls.push(call)
    if (call.method === 'GET') {
      if (path === '/weddings') return json([{ ...wedding, role: 'couple' }])
      if (path === `/weddings/${W}`) return json(wedding)
      if (path === `/weddings/${W}/slots`) return json(slots())
      if (path === '/me/favorites') return json([])
      if (path === '/health') return json({ status: 'ok' })
      if (path === '/catalog/categories') return json([{ id: 'photo', title: 'Фотограф', icon: '📷' }])
      if (path === '/catalog/vendors') return json({ items: [vendor], nextCursor: null })
      if (path === `/catalog/vendors/${V}` || path === `/catalog/vendors/${V2}`) return json({ ...vendor, id: path.endsWith(V2) ? V2 : V })
      if (path === `/catalog/vendors/${V}/availability` || path === `/catalog/vendors/${V2}/availability`) return json({ busyDates: [], holdDates: [] })
      if (path === `/catalog/vendors/${V}/reviews` || path === `/catalog/vendors/${V2}/reviews`) return json({ items: [], nextCursor: null })
      if (path === `/vendors/${V}/booking-policy` || path === `/vendors/${V2}/booking-policy`) return json({ mode: 'legacy_day', revision: '7' })
      if (path === '/vendor/profile') return json({ error: { code: 'not_found', message: 'Анкета не найдена' } }, 404)
      if (path === `/weddings/${W}/slots/${EXTRA}/shortlist`) return json(options.compare ? [entry(E1, V, 'Первый ответ'), entry(E2, V2, 'Второй ответ')] : [])
      if (path === `/weddings/${W}/slots/${MAIN}/shortlist`) return json([])
    }
    unexpected.push(`${call.method} ${path}`)
    return json({ error: { code: 'unexpected_test_route', message: 'Незарегистрированный тестовый запрос' } }, 500)
  }))
  return { calls, unexpected, setContext: (next: Context | null) => { context = next }, slotReads: () => calls.filter(c => c.path === `/weddings/${W}/slots`) }
}

function Controls() {
  const store = useStore(), location = useLocation(), nav = useNavigate()
  return <aside>
    <output aria-label="Готовность реального Store">{store.slotsState}</output>
    <output aria-label="Текущий адрес">{location.pathname}{location.search}</output>
    <button onClick={store.refreshSlots}>Перечитать контекст события</button>
    <button onClick={() => nav('/search/photo')}>Каталог без позиции</button>
    <button onClick={() => nav(`/search/photo?slotId=${EXTRA}`)}>Каталог дополнительной позиции</button>
    <button onClick={() => nav(`/search/photo?slotId=${MISSING}`)}>Несуществующая позиция</button>
  </aside>
}
let active: ReturnType<typeof network> | null = null
function mount(route: string, options: Parameters<typeof network>[0] = {}) {
  active = network(options)
  render(<MemoryRouter initialEntries={[route]}><StoreProvider><Controls /><Routes>
    <Route path="/compare" element={<Compare />} />
    <Route path="/search/:catId" element={<VendorList />} />
    <Route path="/vendor/:id" element={<VendorDetail />} />
    <Route path="/wedding" element={<p>Команда свадьбы</p>} />
  </Routes></StoreProvider></MemoryRouter>)
  return active
}
async function ready() { await waitFor(() => expect(screen.getByLabelText('Готовность реального Store').textContent).toBe('ready')) }
const catalogue = (h: ReturnType<typeof network>) => h.calls.filter(c => c.path === '/catalog/vendors')
const availability = (h: ReturnType<typeof network>) => h.calls.filter(c => c.path === `/catalog/vendors/${V}/availability`)
const last = <T,>(items: T[]) => items[items.length - 1]

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); setI18nLang('ru')
  localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify(MAIN_DATE)); localStorage.setItem('tt_onboarded', '1')
  saveTokens({ accessToken: `header.${btoa(JSON.stringify({ sub: id(90), sid: id(91) }))}.signature`, refreshToken: 'synthetic-routes-refresh' })
  // Same instant: June14 in Honolulu, June15 in Kiritimati; real timers stay live.
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-06-14T10:30:00.000Z'))
})
afterEach(() => {
  cleanup(); saveTokens(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear()
  if (active) { expect(active.unexpected).toEqual([]); expect(active.calls.filter(c => c.method !== 'GET')).toEqual([]) }
  active = null
})

describe('R0 selected event through real Compare and catalogue/profile routes', () => {
  it('Compare binds both offers to the selected slot date/TZ and preserves that exact slot when opening a profile', async () => {
    const h = mount(`/compare?slot=${EXTRA}&entries=${E1},${E2}`, { compare: true })
    await ready(); await screen.findByText('Условия Первый ответ'); await screen.findByText('Условия Второй ответ')
    expect(screen.queryAllByText('На прежнюю дату — запросите заново')).toHaveLength(0)
    expect(screen.getAllByText('Срок предложения истёк')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    expect(h.calls.filter(c => c.path.endsWith('/shortlist')).map(c => c.path)).toEqual([`/weddings/${W}/slots/${EXTRA}/shortlist`])
    fireEvent.click(screen.getAllByRole('button', { name: 'Открыть анкету' })[0]!)
    await waitFor(() => expect(screen.getByLabelText('Текущий адрес').textContent).toBe(`/vendor/${V}?slotId=${EXTRA}`))
  })

  it('Category sends the explicit event date, while the no-query legacy catalogue retains the main date', async () => {
    const h = mount('/search/photo')
    await ready(); await screen.findByRole('button', { name: new RegExp(vendor.name) })
    await waitFor(() => expect(last(catalogue(h))?.query.get('date')).toBe(MAIN_DATE))
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
    const before = catalogue(h).length
    fireEvent.click(screen.getByRole('button', { name: 'Каталог дополнительной позиции' }))
    await waitFor(() => expect(catalogue(h).length).toBeGreaterThan(before))
    await waitFor(() => expect(last(catalogue(h))?.query.get('date')).toBe(EXTRA_DATE))
  })

  it('a null explicit context and an invalid slot query never acquire the main-date filter or another slot shortlist', async () => {
    const h = mount(`/search/photo?slotId=${EXTRA}`, { context: null })
    await ready(); await screen.findByRole('button', { name: new RegExp(vendor.name) })
    expect(catalogue(h).length).toBeGreaterThan(0)
    expect(catalogue(h).some(c => c.query.has('date'))).toBe(false)
    const before = h.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Несуществующая позиция' }))
    await screen.findByText('Позиция недоступна или относится к другой категории. Выберите её заново в команде.')
    expect(screen.queryByRole('button', { name: 'В кандидаты' })).toBeNull()
    expect(h.calls.slice(before).filter(c => c.path.endsWith('/shortlist'))).toEqual([])
    expect(catalogue(h).some(c => c.query.get('date') === MAIN_DATE)).toBe(false)
  })

  it('an explicit profile uses its event month/date and follows a real same-context reread and subsequent event change', async () => {
    const h = mount(`/vendor/${V}?slotId=${EXTRA}`)
    await ready(); await screen.findByRole('heading', { name: vendor.name })
    await screen.findByRole('heading', { name: /август 2030/i })
    await waitFor(() => expect(last(availability(h))?.query.get('month')).toBe('2030-08'))
    await waitFor(() => expect(last(catalogue(h))?.query.get('date')).toBe(EXTRA_DATE))
    const reads = h.slotReads().length
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать контекст события' }))
    await waitFor(() => expect(h.slotReads().length).toBeGreaterThan(reads)); await ready()
    expect(last(availability(h))?.query.get('month')).toBe('2030-08')
    expect(last(catalogue(h))?.query.get('date')).toBe(EXTRA_DATE)
    h.setContext(event({ date: '2030-09-16', timeZone: 'Europe/Moscow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать контекст события' }))
    await screen.findByRole('heading', { name: /сентябрь 2030/i })
    await waitFor(() => expect(last(availability(h))?.query.get('month')).toBe('2030-09'))
    await waitFor(() => expect(last(catalogue(h))?.query.get('date')).toBe('2030-09-16'))
    expect(screen.getByLabelText('Текущий адрес').textContent).toBe(`/vendor/${V}?slotId=${EXTRA}`)
  })

  it('replaceSlot resolves the requested second position for calendar and similar-vendor queries, without issuing a financial write', async () => {
    const h = mount(`/vendor/${V}?replaceSlot=${EXTRA}`, { replacement: true })
    await ready(); await screen.findByRole('heading', { name: vendor.name })
    await screen.findByRole('heading', { name: /август 2030/i })
    await waitFor(() => expect(last(availability(h))?.query.get('month')).toBe('2030-08'))
    await waitFor(() => expect(last(catalogue(h))?.query.get('date')).toBe(EXTRA_DATE))
    expect(h.calls.filter(c => c.path.endsWith('/shortlist')).every(c => c.path === `/weddings/${W}/slots/${EXTRA}/shortlist`)).toBe(true)
    expect(screen.getByLabelText('Текущий адрес').textContent).toBe(`/vendor/${V}?replaceSlot=${EXTRA}`)
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
  })
})
