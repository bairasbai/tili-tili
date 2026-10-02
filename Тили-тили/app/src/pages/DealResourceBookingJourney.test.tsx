// @vitest-environment jsdom
/* Independent controlled DOM witnesses: registered Deal, real store, router and
 * HTTP wrappers. Synthetic HTTP receipts do not prove PG or human consent. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Deal } from '@/pages/Tools'
import { StoreProvider, useStore } from '@/lib/store'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import type { ServerSlot, SlotDeal } from '@/lib/api/slots'
import type { OrderCatalog, OrderTermsView, ResourceCommitmentView, ResourceCommitmentWrite, ResourcePlanView, WeddingOrder } from '@/lib/api/orders'

const id = (n: number) => `18000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), W2 = id(2), D = id(3), D2 = id(4), S = id(5), V = id(6), T = id(7), PLAN = id(8), PART = id(9)
const POLICY = `/vendors/${V}/booking-policy`, PATCH = `/deals/${D}`, COMMIT = `${PATCH}/order/resource-commitments`
const CTA = 'Согласовать бронирование', PANEL = 'Бронь ресурсов заказа', BOOK = 'Забронировать заказ и ресурсы по согласованному плану'
const wedding = { id: W, title: 'Анна и Борис', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: id(10), name: 'Анна' }, role: 'couple' }] }
type Call = { method: string; path: string; body: unknown; headers: Headers }
type Reply = { status: number; body: unknown }
type Handler = (call: Call) => unknown | Promise<unknown>
type Network = Record<string, unknown | Handler>
const failure = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } })
const isReply = (value: unknown): value is Reply => typeof value === 'object' && value !== null && 'status' in value && 'body' in value && typeof value.status === 'number'
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let unexpected: string[] = []

function fixtures(initial: NonNullable<SlotDeal['state']> = 'negotiating') {
  const financial: SlotDeal = { id: D, state: initial, vendor: { id: V, name: 'Цветочная мастерская' }, price: { amount: 300000, currency: 'RUB' }, paid: { amount: initial === 'paid_deposit' || initial === 'done' ? 300000 : 0, currency: 'RUB' }, packageName: 'Букеты для церемонии', packageIncludes: ['Доставка букетов'] }
  const slot: ServerSlot = { id: S, categoryId: 'flowers', label: 'Цветы', tileState: 'hold', deal: financial }
  const order: WeddingOrder = { dealId: D, schemaVersion: 1, version: '2', source: 'structured', brief: null, assignments: [], parts: [{ id: PART, kind: 'deliverable', version: '1', source: 'structured', assignmentId: null, title: 'Букеты для церемонии', details: { items: null, dueAt: null, recipient: null, reviewProcess: null }, cancelledAt: null }] }
  const catalog: OrderCatalog = { weddingId: W, primarySlotId: S, actorRole: 'couple', draftEditable: true, dealState: initial, vendorId: V, timeZone: null, assignmentTimeZones: [], eligiblePositions: [], category: { categoryId: 'flowers', label: 'Цветы', autoAssign: false, fields: [], suggestedKinds: ['deliverable'] }, executionKinds: ['deliverable'] }
  const current: NonNullable<ResourcePlanView['current']> = { planRevisionId: PLAN, revision: '1', lines: [{ partId: PART, assignmentId: null, programEventId: null, label: 'Изготовление букетов', kind: 'capacity', quantity: 10, unit: 'букеты', startsAt: '2027-06-10T07:00:00Z', endsAt: '2027-06-10T08:00:00Z', timeZone: 'Europe/Moscow', setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0, occupiedStartsAt: '2027-06-10T07:00:00Z', occupiedEndsAt: '2027-06-10T08:00:00Z', window: { startsAt: '2027-06-10T00:00:00Z', endsAt: '2027-06-11T00:00:00Z' } }] }
  const plan: ResourcePlanView = { orderVersion: order.version, revision: '1', canEdit: false, reservation: 'not_reserved', current, editorLines: null, source: 'current', history: [current] }
  const digest = 'c'.repeat(64)
  const selected: NonNullable<OrderTermsView['selected']> = { id: T, version: '1', sourceOrderVersion: order.version, sourceFingerprint: digest, digest, snapshot: { schemaVersion: 2, weddingId: W, dealId: D, source: 'structured', categoryId: 'flowers', sourceOrderVersion: order.version, legacyContext: { mainEvent: null }, brief: null, assignments: [], parts: order.parts.map(p => ({ id: p.id, kind: p.kind, version: p.version, source: p.source, title: p.title, assignmentId: p.assignmentId, details: p.details })), economics: { amount: '300000', amountKnown: true, currency: 'RUB', performer: { vendor: { id: V, userId: id(11), name: 'Цветочная мастерская', categoryId: 'flowers' }, externalName: null, externalPhone: null }, package: { id: null, titleSnapshot: null, includesSnapshot: null } }, resourcePlan: structuredClone(current) }, publishedBy: id(11), publishedSide: 'performer', publishedAt: '2027-01-01T10:00:00Z', freshness: 'current', receipts: [{ id: id(20), party: 'customer', userId: id(10), sessionId: id(30), digest, acceptedAt: '2027-01-02T10:00:00Z' }, { id: id(21), party: 'performer', userId: id(11), sessionId: id(31), digest, acceptedAt: '2027-01-03T10:00:00Z' }], acceptedByCaller: true }
  const terms: OrderTermsView = { revision: '1', proposedTermsId: T, agreedTermsId: T, history: [selected], selected, acceptedByCaller: true, readToken: 'synthetic-reader-token-never-persist' }
  let commitment: ResourceCommitmentView = { revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' }
  const transition = (state: NonNullable<SlotDeal['state']>) => { financial.state = state; catalog.dealState = state; slot.tileState = state === 'paid_deposit' || state === 'done' ? 'paid' : state === 'booked' ? 'booked' : state === 'cancelled' ? 'empty' : 'hold'; return slot }
  const reserve = () => { transition('booked'); commitment = { revision: '1', state: 'reserved', termsId: T, planRevisionId: PLAN, reservation: 'reserved' }; plan.reservation = 'reserved'; return commitment }
  const routes: Network = {
    '/weddings': [{ ...wedding, role: 'couple' }, { ...wedding, id: W2, role: 'couple' }],
    [`/weddings/${W}`]: wedding, [`/weddings/${W2}`]: { ...wedding, id: W2 },
    [`/weddings/${W}/slots`]: () => [slot, { ...slot, id: id(56), deal: { ...financial, id: D2, vendor: { id: V, name: 'Второй заказ той же мастерской' } } }], [`/weddings/${W2}/slots`]: () => [{ ...slot, deal: { ...financial, id: D2 } }], '/me/favorites': [],
    [`${PATCH}/events`]: [], [`/deals/${D2}/events`]: [],
    [POLICY]: { mode: 'resources', revision: '7' },
    [`${PATCH}/order`]: () => order, [`${PATCH}/order/catalog`]: () => catalog,
    [`${PATCH}/order/terms`]: () => terms, [`${PATCH}/order/resource-plan`]: () => plan, [COMMIT]: () => commitment,
    [`PATCH ${PATCH}`]: (call: Call) => transition((call.body as { state: NonNullable<SlotDeal['state']> }).state),
    [`POST /weddings/${W}/slots/${S}/pay`]: () => { financial.paid = { amount: 300000, currency: 'RUB' }; return transition('paid_deposit') },
    [`POST /weddings/${W}/slots/${S}/cancel`]: () => transition('cancelled'),
    [`POST ${COMMIT}`]: reserve,
  }
  return { routes, slot, financial, order, catalog, plan, terms, transition }
}
function serve(routes: Network) {
  const calls: Call[] = []; unexpected = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
    const call: Call = { method: init?.method ?? 'GET', path, body: init?.body == null ? null : JSON.parse(String(init.body)) as unknown, headers: new Headers(init?.headers) }
    calls.push(call)
    const route = routes[`${call.method} ${path}`] ?? (call.method === 'GET' ? routes[path] : undefined)
    if (route === undefined) { unexpected.push(`${call.method} ${path}`); return new Response(JSON.stringify(failure(404, 'not_found', 'Неизвестный тестовый маршрут').body), { status: 404 }) }
    const value = typeof route === 'function' ? await (route as Handler)(call) : route
    return new Response(JSON.stringify(isReply(value) ? value.body : value), { status: isReply(value) ? value.status : 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function ScopeControls() {
  const store = useStore(), nav = useNavigate()
  return <aside aria-label="Тестовый контекст">
    <output aria-label="Текущая сделка">{store.slots.find(s => s.id === S)?.dealState ?? ''}</output>
    <button onClick={() => store.setWeddingId(W2)}>Другая свадьба</button>
    <button onClick={store.refreshSlots}>Перечитать сделку</button>
    <button onClick={() => nav(`/deal/${D2}`)}>Другой заказ</button>
    <button onClick={() => { saveTokens(null); store.forgetSession() }}>Выход из сессии</button>
    <button onClick={() => saveTokens({ accessToken: 'new-subject-session', refreshToken: 'new-subject-refresh' })}>Новая сессия</button>
  </aside>
}
function mount(overrides: Network = {}, state: NonNullable<SlotDeal['state']> = 'negotiating') {
  const f = fixtures(state), calls = serve({ ...f.routes, ...overrides })
  const view = render(<MemoryRouter initialEntries={[`/deal/${D}`]}><StoreProvider><ScopeControls /><Routes>
    <Route path="/deal/:id" element={<Deal />} /><Route path="/wedding" element={<p>Моя свадьба</p>} />
  </Routes></StoreProvider></MemoryRouter>)
  return { ...view, ...f, calls }
}
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET')
const policyCalls = (calls: Call[]) => calls.filter(c => c.path === POLICY)
const panel = () => screen.getByText(PANEL).closest('details') as HTMLDetailsElement
async function action(name = CTA) { const b = await screen.findByRole('button', { name }); await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false)); return b }
async function idle() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
beforeEach(() => {
  unexpected = []; localStorage.clear(); sessionStorage.clear(); setI18nLang('ru')
  localStorage.setItem('tt_onboarded', '1'); localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify(wedding.date))
  saveTokens({ accessToken: 'synthetic-couple-session', refreshToken: 'synthetic-refresh' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); setI18nLang('ru'); expect(unexpected).toEqual([]) })

describe('ordinary financial card reaches deliberate resource booking', () => {
  it('keeps optional readers collapsed and performs no policy polling, writes or automatic agreement on arrival', async () => {
    const h = mount(); await action(); await screen.findByText('Пока ничего не происходило'); await idle()
    expect(panel().open).toBe(false); expect(policyCalls(h.calls)).toEqual([]); expect(writes(h.calls)).toEqual([])
    expect(screen.queryByText('Бронь держится 72 часа')).toBeNull()
    expect(h.calls.filter(c => c.path.includes('/order'))).toEqual([])
    expect(screen.queryByRole('button', { name: 'Забронировано' })).toBeNull()
  })
  it('resources policy opens the existing reader without PATCH, consent, payment or booking writes', async () => {
    const h = mount(); fireEvent.click(await action()); await screen.findByText('Ресурсы не зарезервированы')
    expect(panel().open).toBe(true); expect(screen.getAllByText(PANEL)).toHaveLength(1); expect(writes(h.calls)).toEqual([])
    expect(h.calls.some(c => c.path === COMMIT && c.method === 'GET')).toBe(true)
    expect(screen.getByLabelText('Текущая сделка').textContent).toBe('negotiating')
    expect(screen.getByRole('button', { name: BOOK })).toBeTruthy()
    expect(localStorage.getItem('synthetic-reader-token-never-persist')).toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toContain('synthetic-reader-token-never-persist')
  })
  it('only a second explicit action sends the proved resource commitment and refreshes the financial card from GET', async () => {
    const h = mount(); fireEvent.click(await action()); fireEvent.click(await action(BOOK))
    await screen.findByText('Запрос обработан. Показана актуальная бронь.'); await waitFor(() => expect(screen.getByLabelText('Текущая сделка').textContent).toBe('booked'))
    const command = { expectedOrderVersion: '2', expectedCommitmentRevision: '0', termsId: T, expectedTermsVersion: '1', termsDigest: 'c'.repeat(64), planRevisionId: PLAN, expectedPolicyRevision: '7' } satisfies ResourceCommitmentWrite
    expect(writes(h.calls).map(c => ({ path: c.path, body: c.body }))).toEqual([{ path: COMMIT, body: command }])
    expect(writes(h.calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy()
    expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(await action('✓ Отметить оплату')).toBeTruthy()
  })
  it('missing performer acceptance keeps the resource order unbooked without inventing agreement', async () => {
    const h = mount(); h.terms.selected!.receipts.pop(); fireEvent.click(await action()); await screen.findByText('Ресурсы не зарезервированы')
    expect(panel().open).toBe(true); expect(screen.queryByRole('button', { name: BOOK })).toBeNull(); expect(writes(h.calls)).toEqual([])
  })
  it('current legacy policy retains state-only financial PATCH and real slot refresh', async () => {
    const h = mount({ [POLICY]: { mode: 'legacy_day', revision: '0' } }); fireEvent.click(await action())
    await action('✓ Отметить оплату'); expect(policyCalls(h.calls)).toHaveLength(1)
    expect(writes(h.calls).map(c => ({ method: c.method, path: c.path, body: c.body }))).toEqual([{ method: 'PATCH', path: PATCH, body: { state: 'booked' } }])
    expect(writes(h.calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(panel().open).toBe(false)
    expect(h.financial.price?.amount).toBe(300000); expect(h.financial.paid?.amount).toBe(0)
  })
  it.each([null, { mode: 'future_mode', revision: '7' }, { mode: 'resources', revision: '07' }, { mode: 'legacy_day', revision: '-1' }, { mode: 'resources', revision: '9223372036854775808' }, failure(503, 'unavailable', 'Недоступно')])('unconfirmed policy %j makes no writes and remains retryable', async invalid => {
    let attempts = 0; const h = mount({ [POLICY]: () => ++attempts === 1 ? invalid : { mode: 'legacy_day', revision: '0' } })
    fireEvent.click(await action()); await screen.findByRole('alert'); expect(writes(h.calls)).toEqual([]); expect(panel().open).toBe(false)
    fireEvent.click(await action()); await action('✓ Отметить оплату'); expect(attempts).toBe(2); expect(writes(h.calls)).toHaveLength(1)
  })
  it('network loss during policy checking is retryable without a booking write', async () => {
    let attempts = 0; const h = mount({ [POLICY]: () => { if (++attempts === 1) throw new TypeError('Failed to fetch'); return { mode: 'resources', revision: '7' } } })
    fireEvent.click(await action()); await screen.findByRole('alert'); expect(writes(h.calls)).toEqual([])
    fireEvent.click(await action()); await screen.findByText('Ресурсы не зарезервированы'); expect(panel().open).toBe(true); expect(writes(h.calls)).toEqual([])
  })
  it('fresh resource_booking_required refusal reveals the reader without claiming a successful day booking', async () => {
    const h = mount({ [POLICY]: { mode: 'legacy_day', revision: '0' }, [`PATCH ${PATCH}`]: failure(409, 'resource_booking_required', 'Нужна бронь ресурсов') })
    fireEvent.click(await action()); await screen.findByText('Ресурсы не зарезервированы')
    expect(panel().open).toBe(true); expect(writes(h.calls).map(c => ({ path: c.path, body: c.body }))).toEqual([{ path: PATCH, body: { state: 'booked' } }])
    expect(screen.getByLabelText('Текущая сделка').textContent).toBe('negotiating'); expect(screen.queryByRole('button', { name: '✓ Отметить оплату' })).toBeNull()
  })
  it('an unrelated financial refusal stays an error instead of opening the reservation reader', async () => {
    const h = mount({ [POLICY]: { mode: 'legacy_day', revision: '0' }, [`PATCH ${PATCH}`]: failure(409, 'price_locked', 'Цена зафиксирована') })
    fireEvent.click(await action()); await screen.findByRole('alert'); expect(panel().open).toBe(false); expect(writes(h.calls)).toHaveLength(1)
    expect(screen.getByLabelText('Текущая сделка').textContent).toBe('negotiating')
  })
  it('double taps while actual policy response is pending send one read and no writes', async () => {
    const slow = deferred<unknown>(); const h = mount({ [POLICY]: () => slow.promise }); const b = await action()
    fireEvent.click(b); fireEvent.click(b); await waitFor(() => expect(policyCalls(h.calls)).toHaveLength(1)); expect((b as HTMLButtonElement).disabled).toBe(true)
    await act(async () => slow.resolve({ mode: 'resources', revision: '7' })); await screen.findByText('Ресурсы не зарезервированы'); expect(writes(h.calls)).toEqual([])
  })
  it.each(['helper', 'coordinator', null])('fresh membership %j overrides remembered money visibility before policy or writes', async role => {
    let reads = 0
    const h = mount({ '/weddings': () => ++reads === 1 ? [{ ...wedding, role: 'couple' }] : role === null ? [] : [{ ...wedding, role }] })
    fireEvent.click(await action()); await screen.findByRole('alert')
    expect(reads).toBe(2); expect(policyCalls(h.calls)).toEqual([]); expect(writes(h.calls)).toEqual([]); expect(panel().open).toBe(false)
  })
  it.each([403, 404, 410])('policy HTTP %s refuses action without leaking private server error identity', async status => {
    const h = mount({ [POLICY]: failure(status, 'not_allowed', 'Доступ закрыт') }); fireEvent.click(await action()); await screen.findByRole('alert')
    expect(writes(h.calls)).toEqual([]); expect(panel().open).toBe(false); expect(h.calls.filter(c => c.path.includes('/order'))).toEqual([])
  })
})

describe('current authority wins over late policy replies', () => {
  it.each(['Другая свадьба', 'Другой заказ', 'Выход из сессии', 'Новая сессия'])('late resources response after %s cannot open a private reader or write', async boundary => {
    const slow = deferred<unknown>(); const h = mount({ [POLICY]: () => slow.promise })
    fireEvent.click(await action()); await waitFor(() => expect(policyCalls(h.calls)).toHaveLength(1)); fireEvent.click(screen.getByRole('button', { name: boundary }))
    if (boundary === 'Другая свадьба') await screen.findByText('Сделка не найдена')
    if (boundary === 'Другой заказ') await screen.findByText('Второй заказ той же мастерской')
    await act(async () => slow.resolve({ mode: 'resources', revision: '7' })); await idle()
    expect(writes(h.calls)).toEqual([]); expect(h.calls.filter(c => c.path.includes('/order'))).toEqual([])
    expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull(); expect(screen.queryByRole('button', { name: BOOK })).toBeNull()
    const summary = screen.queryByText(PANEL); if (summary) expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false)
  })
  it.each(['Другая свадьба', 'Другой заказ', 'Выход из сессии', 'Новая сессия'])('late legacy response after %s cannot PATCH the former deal', async boundary => {
    const slow = deferred<unknown>(); const h = mount({ [POLICY]: () => slow.promise })
    fireEvent.click(await action()); await waitFor(() => expect(policyCalls(h.calls)).toHaveLength(1)); fireEvent.click(screen.getByRole('button', { name: boundary }))
    await act(async () => slow.resolve({ mode: 'legacy_day', revision: '0' })); await idle(); expect(writes(h.calls)).toEqual([])
  })
  it.each(['resources', 'legacy_day'])('current helper projection after a policy wait blocks the late %s action', async mode => {
    const slow = deferred<unknown>(); const h = mount({ [POLICY]: () => slow.promise })
    fireEvent.click(await action()); await waitFor(() => expect(policyCalls(h.calls)).toHaveLength(1))
    delete h.financial.price; delete h.financial.paid
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать сделку' })); await screen.findByText('Только просмотр — шаги, оплату и отмену делает пара')
    await act(async () => slow.resolve({ mode, revision: '7' })); await idle()
    expect(writes(h.calls)).toEqual([]); expect(screen.queryByText(PANEL)).toBeNull(); expect(h.calls.filter(c => c.path.includes('/order'))).toEqual([])
  })
  it('state changes during policy await cannot advance a now cancelled financial deal', async () => {
    const slow = deferred<unknown>(); const h = mount({ [POLICY]: () => slow.promise })
    fireEvent.click(await action()); await waitFor(() => expect(policyCalls(h.calls)).toHaveLength(1)); h.transition('cancelled')
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать сделку' })); await screen.findByText('Заказ отменён')
    await act(async () => slow.resolve({ mode: 'legacy_day', revision: '0' })); await idle(); expect(writes(h.calls)).toEqual([])
  })
  it.each(['resources', 'legacy_day'])('same deal identity projected under a new wedding cannot consume late %s authorization', async mode => {
    const slow = deferred<unknown>(), other = fixtures()
    const h = mount({ [POLICY]: () => slow.promise, [`/weddings/${W2}/slots`]: [other.slot] })
    fireEvent.click(await action()); await waitFor(() => expect(policyCalls(h.calls)).toHaveLength(1)); fireEvent.click(screen.getByRole('button', { name: 'Другая свадьба' }))
    await waitFor(() => expect(h.calls.some(c => c.path === `/weddings/${W2}/slots`)).toBe(true)); await action()
    await act(async () => slow.resolve({ mode, revision: '7' })); await idle()
    expect(writes(h.calls)).toEqual([]); expect(panel().open).toBe(false); expect(h.calls.filter(c => c.path.includes('/order'))).toEqual([])
  })
})

describe('existing financial and journal paths retain their meaning', () => {
  it.each([['candidate', 'Написали', 'contacted'], ['contacted', 'Переговоры', 'negotiating'], ['paid_deposit', 'Выполнено', 'done']] as const)('ordinary %s advances to %s without querying booking policy', async (initial, label, next) => {
    const h = mount({}, initial); fireEvent.click(await action(label)); await waitFor(() => expect(screen.getByLabelText('Текущая сделка').textContent).toBe(next))
    expect(writes(h.calls).map(c => ({ path: c.path, body: c.body }))).toEqual([{ path: PATCH, body: { state: next } }]); expect(policyCalls(h.calls)).toEqual([])
  })
  it('booked payment uses the real pay endpoint, preserves price and never rebooks resources', async () => {
    const h = mount({}, 'booked'); fireEvent.click(await action('✓ Отметить оплату')); await action('Выполнено')
    expect(writes(h.calls).map(c => ({ path: c.path, body: c.body }))).toEqual([{ path: `/weddings/${W}/slots/${S}/pay`, body: {} }]); expect(policyCalls(h.calls)).toEqual([])
    expect(h.financial.price?.amount).toBe(300000); expect(h.financial.paid?.amount).toBe(300000)
  })
  it('cancellation waits for explicit confirmation and uses the original slot cancel API', async () => {
    const h = mount({}, 'booked'); fireEvent.click(await action('Отменить сделку')); expect(writes(h.calls)).toEqual([])
    fireEvent.click(await action('Точно отменить?')); await screen.findByText('Моя свадьба')
    expect(writes(h.calls).map(c => ({ path: c.path, body: c.body }))).toEqual([{ path: `/weddings/${W}/slots/${S}/cancel`, body: {} }]); expect(policyCalls(h.calls)).toEqual([])
  })
  it('done exposes neither cancellation nor a second completion action', async () => {
    const h = mount({}, 'done'); await screen.findByText('Работа выполнена — отмена невозможна')
    expect(screen.queryByRole('button', { name: 'Отменить сделку' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Выполнено' })).toBeNull(); expect(writes(h.calls)).toEqual([])
  })
  it.each(['negotiating', 'booked', 'paid_deposit'].flatMap(state => ['helper', 'coordinator'].map(role => [state as NonNullable<SlotDeal['state']>, role] as const)))('a %s deal with current %s projection hides money, policy, payment and cancel actions', async (state, role) => {
    const f = fixtures(state); delete f.financial.price; delete f.financial.paid
    const h = mount({ [`/weddings/${W}/slots`]: [f.slot], '/weddings': [{ ...wedding, role }] }, state)
    await screen.findByText('Только просмотр — шаги, оплату и отмену делает пара'); expect(screen.getByText('Суммы и оплаты по сделке видит только пара.')).toBeTruthy()
    for (const label of [CTA, '✓ Отметить оплату', 'Выполнено', 'Отменить сделку']) expect(screen.queryByRole('button', { name: label })).toBeNull()
    expect(screen.queryByText(PANEL)).toBeNull(); expect(writes(h.calls)).toEqual([]); expect(policyCalls(h.calls)).toEqual([])
  })
  it('initial null→candidate journal event says draft created while a real return retains its prior state label', async () => {
    const events = [{ id: id(40), kind: 'state', fromState: null, toState: 'candidate', by: 'couple', at: '2027-01-01T10:00:00Z', note: null }, { id: id(41), kind: 'state', fromState: 'contacted', toState: 'candidate', by: 'couple', at: '2027-01-02T10:00:00Z', note: null }]
    const h = mount({ [`${PATCH}/events`]: events }, 'candidate'); const created = await screen.findByText('Создан черновик заказа')
    const journal = created.closest('.card') as HTMLElement
    expect(within(journal).getAllByText('Создан черновик заказа')).toHaveLength(1); expect(within(journal).getAllByText('Не связывались')).toHaveLength(1)
    expect(writes(h.calls)).toEqual([]); expect(policyCalls(h.calls)).toEqual([])
  })
})
