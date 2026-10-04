// @vitest-environment jsdom
// Authored unit regressions only. Controlled fetch/day seams are NOT native/API/PWA acceptance.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferComparisonTerms, OfferAvailabilityObservation } from '@/components/OfferComparisonTerms'
import { OfferSummary } from '@/components/OfferSummary'
import type { OfferRequest } from '@/lib/api/offers'
import type { OfferComparisonTerms as Terms } from '@/lib/offerComparisonTerms'
import { StoreProvider } from '@/lib/store'
import { setI18nLang } from '@/lib/i18n'
import { VendorOfferRequests, VendorDealCard } from '@/pages/VendorExtras'
import { Compare } from '@/pages/Smart'
import { Deal } from '@/pages/Tools'

// Only unrelated order/payment child panels and the day hook are isolated.
// FR018 components, pages, API client, normalizer and StoreProvider remain actual modules.
vi.mock('@/lib/useOfferDay', () => ({ useOfferDay: () => '2027-06-14' }))
vi.mock('@/components/OrderDraft', () => ({ OrderDraft: () => null }))
vi.mock('@/components/OrderTerms', () => ({ OrderTerms: () => null }))
vi.mock('@/components/OrderResourcePlan', () => ({ OrderResourcePlan: () => null }))
vi.mock('@/components/OrderResourceCommitments', () => ({ OrderResourceCommitments: () => null }))
vi.mock('@/components/VendorPaymentHistory', () => ({ VendorPaymentHistory: () => null }))

// Independent literal oracle: deliberately does not derive labels/values from implementation fields.
const LABELS = ['Часы и охват услуги', 'Команда в предложении', 'Результат услуги', 'Срок сдачи результата', 'Дополнительные расходы', 'Условия отмены', 'Условия переноса']
const EN_LABELS = ['Service hours and coverage', 'Quoted team', 'Service result', 'Result handover deadline', 'Extra costs', 'Cancellation terms', 'Rescheduling terms']
const QUOTED = {
  hours: 'HOURS_A: 8 quoted hours', team: 'TEAM_A: quoted team', result: 'RESULT_A: literal output',
  delivery: 'DELIVERY_A: handover after event', extras: '0', cancellation: 'CANCEL_A: quoted condition', reschedule: 'RESCHEDULE_A: quoted condition',
} satisfies NonNullable<Terms>
const OTHER = { hours: 'OTHER_H', team: 'OTHER_T', result: 'OTHER_R', delivery: 'OTHER_D', extras: 'OTHER_E', cancellation: 'OTHER_C', reschedule: 'OTHER_S' } satisfies NonNullable<Terms>
const REQUEST: OfferRequest = { id: 'r1', status: 'open', weddingDate: '2027-06-14', guests: 60, city: 'Уфа', wishes: null, createdAt: '2026-10-01T10:00:00Z' }
function fullRequest(terms: Terms): OfferRequest {
  return { ...REQUEST, offer: { id: 'o1', requestId: 'r1', kind: 'offer', packageId: 'p1', title: 'Selected stored offer', price: { amount: 12345, currency: 'RUB' }, includes: ['Quoted service'], message: null, validUntil: '2027-06-21', comparisonTerms: terms } }
}
function expectDefinitions(container: HTMLElement, labels: string[], values: string[]) {
  const rows = [...container.querySelectorAll('dt')]
  expect(rows.map(row => row.textContent)).toEqual(labels)
  expect(rows.map(row => row.nextElementSibling?.tagName)).toEqual(labels.map(() => 'DD'))
  expect(rows.map(row => row.nextElementSibling?.textContent)).toEqual(values)
}

type Call = { method: string; path: string; body: unknown; key: string | null }
type Reply = unknown | Response
type RoutesMap = Record<string, Reply | ((call: Call) => Reply | Promise<Reply>)>
const WEDDING = { id: 'w1', title: 'Synthetic wedding', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Europe/Moscow', members: [{ user: { id: 'u1', name: 'Synthetic owner' }, role: 'couple' }] }
const PACKAGE = { id: 'p1', name: 'Catalog package hours 99 CANARY', price: { amount: 250000, currency: 'RUB' }, includes: ['PROFILE_HOURS_CANARY', 'PROFILE_DELIVERY_CANARY'] }
const PROFILE = { id: 'v1', name: 'Synthetic vendor A', categoryId: 'photo', city: 'Уфа', about: 'PROFILE_CONDITION_CANARY', priceFrom: { amount: 250000, currency: 'RUB' }, rating: 4.5, reviewsCount: 2, photoUrl: null, verified: true, hasVideo: false, published: true, blocked: false, bookingMode: 'legacy_day', gallery: [], media: [], packages: [PACKAGE] }
const SLOT = { id: 's1', categoryId: 'photo', label: 'Фотограф', tileState: 'empty', deal: null }
const unexpected: Call[] = []
function response(body: unknown, status = 200) { return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
function serve(overrides: RoutesMap) {
  const routes: RoutesMap = {
    '/weddings': [{ ...WEDDING, role: 'couple' }], '/weddings/w1': WEDDING, '/weddings/w1/slots': [SLOT],
    '/weddings/w1/slots/s1/shortlist': [], '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
    '/me/favorites': [], '/vendor/profile': PROFILE, '/vendor/offer-requests': [], '/deals/d1/events': [],
    ...overrides,
  }
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
    const call = { method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) as unknown : null, key: new Headers(init?.headers).get('Idempotency-Key') }
    calls.push(call)
    const reply = routes[`${call.method} ${path}`] ?? routes[path]
    if (reply === undefined) { unexpected.push(call); return Promise.resolve(response({ error: { code: 'unexpected_unit_route', message: `${call.method} ${path}` } }, 404)) }
    try { return Promise.resolve(typeof reply === 'function' ? reply(call) : reply).then(value => value instanceof Response ? value : response(value)) }
    catch (error) { return Promise.reject(error) }
  }))
  return calls
}
function mount(path: string, routes: RoutesMap = {}) {
  const calls = serve(routes)
  const view = render(<MemoryRouter initialEntries={[path]}><StoreProvider><Routes>
    <Route path="/compare" element={<Compare />} />
    <Route path="/deal/:id" element={<Deal />} />
    <Route path="/vendor-app/offer-requests" element={<VendorOfferRequests />} />
    <Route path="/vendor-app/deals/:id" element={<VendorDealCard />} />
  </Routes></StoreProvider></MemoryRouter>)
  return { ...view, calls }
}
function entry(id: string, position: number, request: unknown, patch: Record<string, unknown> = {}) {
  return { id, slotId: 's1', position, createdAt: '2026-10-01T10:00:00Z', available: true, occupancy: 'free',
    availabilityObservation: { source: 'legacy_day', date: '2027-06-14', checkedAt: '2026-10-01T10:11:12.345Z' },
    vendor: { ...PROFILE, id: `v-${id}`, name: `Vendor ${id}` }, request, ...patch }
}
function snapshotSlot(terms: Terms | undefined, id = 'd1') {
  return { ...SLOT, tileState: 'booked', deal: { id, slotId: 's1', state: 'booked', vendor: PROFILE, price: { amount: 12345, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' }, packageName: 'Stored agreed package', packageIncludes: ['Stored agreed contents'], ...(terms === undefined ? {} : { comparisonTerms: terms }) } }
}
function compareRow(label: string) { const row = screen.getByRole('rowheader', { name: label }).closest('tr'); if (!row) throw Error('Missing comparison row'); return within(row).getAllByRole('cell') }
function posts(calls: Call[]) { return calls.filter(call => call.method === 'POST') }
async function editor(request = REQUEST, profile = PROFILE) {
  const view = mount('/vendor-app/offer-requests', { '/vendor/offer-requests': [request], '/vendor/profile': profile,
    'POST /vendor/offer-requests/r1/offers': response({}, 201) })
  if (request.offer) fireEvent.click(await screen.findByRole('button', { name: 'Изменить ответ' }))
  await screen.findByLabelText(LABELS[0])
  return view
}

beforeEach(() => {
  unexpected.length = 0
  localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('tt_onboarded', '1'); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'unit-a', refreshToken: 'unit-r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1')); localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  setI18nLang('ru')
})
afterEach(() => {
  cleanup()
  try { expect(unexpected).toEqual([]) } finally { vi.unstubAllGlobals(); setI18nLang('ru') }
})

describe('FR018 · actual condition DOM and accepted projection (unit seams)', () => {
  it('D01: each of seven RU labels is paired with its own literal value, including quoted zero', () => {
    const view = render(<OfferComparisonTerms terms={QUOTED} />)
    expectDefinitions(view.container, LABELS, Object.values(QUOTED))
  })
  it('D02: seven EN labels retain their distinct quoted text and zero', () => {
    setI18nLang('en')
    const view = render(<OfferComparisonTerms terms={QUOTED} />)
    expectDefinitions(view.container, EN_LABELS, Object.values(QUOTED))
  })
  it('D03: monetary omission is empty DOM, explicit legacy null is seven unknown conditions', () => {
    const view = render(<OfferComparisonTerms terms={undefined} />)
    expect(view.container.textContent).toBe(''); expect(view.container.querySelector('dl')).toBeNull()
    view.rerender(<OfferComparisonTerms terms={null} />)
    expectDefinitions(view.container, LABELS, LABELS.map(() => 'Неизвестно'))
  })
  it('D04: each explicit null stays unknown without borrowing another known field', () => {
    const names = ['hours', 'team', 'result', 'delivery', 'extras', 'cancellation', 'reschedule'] as const
    const view = render(<OfferComparisonTerms terms={QUOTED} />)
    for (const [index, name] of names.entries()) {
      view.rerender(<OfferComparisonTerms terms={{ ...QUOTED, [name]: null }} />)
      expectDefinitions(view.container, LABELS, Object.values(QUOTED).map((value, at) => at === index ? 'Неизвестно' : value))
    }
  })
  it('D05: quoted markup and newlines remain text; no generated img/script node', () => {
    const literal = '<img src=x onerror="alert(1)">\n<script>quoted()</script>'
    const view = render(<OfferComparisonTerms terms={{ ...QUOTED, hours: literal }} />)
    expectDefinitions(view.container, LABELS, [literal, ...Object.values(QUOTED).slice(1)])
    expect(view.container.querySelector('img,script')).toBeNull()
  })
  it('D06: actual OfferSummary keeps service contents, quoted delivery and offer expiry separate', () => {
    const view = render(<OfferSummary request={fullRequest(QUOTED)} currentWeddingDate="2027-06-14" />)
    expectDefinitions(view.container, LABELS, Object.values(QUOTED))
    expect(screen.getByText('Quoted service', { selector: 'li' })).toBeTruthy()
    expect(view.container.textContent).toContain('Действует до')
    expect(screen.getByText(QUOTED.delivery!)).toBeTruthy()
    expect(view.container.textContent).toContain('123,45')
  })
  it('D07: actual status-only OfferPublic cannot display extra poisoned offer/condition fields', () => {
    const publicPayload = { status: 'responded' as const, offer: fullRequest(OTHER).offer, comparisonTerms: OTHER }
    const view = render(<OfferSummary request={publicPayload} />)
    expect(view.container.textContent).toBe('Подрядчик ответил')
    expect(view.container.querySelector('dt')).toBeNull()
    for (const canary of Object.values(OTHER)) expect(view.container.textContent).not.toContain(canary)
  })
  it('D08: historic whole-null conditions are not reconstructed from title/includes/message/expiry', () => {
    const request = fullRequest(null)
    if (!request.offer || request.offer.kind !== 'offer') throw Error('Invalid controlled offer')
    request.offer.title = '8 hours TITLE_CANARY'; request.offer.includes = ['TEAM_AND_RESULT_CANARY']; request.offer.message = 'DELIVERY_AND_EXTRAS_CANARY'
    const view = render(<OfferSummary request={request} />)
    expectDefinitions(view.container, LABELS, LABELS.map(() => 'Неизвестно'))
    expect(screen.getByText('TEAM_AND_RESULT_CANARY')).toBeTruthy()
  })
  it('D09: actual StoreProvider/Deal renders only the selected stored accepted snapshot', async () => {
    const view = mount('/deal/d1', { '/weddings/w1/slots': [snapshotSlot(QUOTED), { ...snapshotSlot(OTHER, 'd2'), id: 's2' }] })
    await screen.findByText(QUOTED.hours!)
    expectDefinitions(view.container, LABELS, Object.values(QUOTED))
    for (const canary of Object.values(OTHER)) expect(view.container.textContent).not.toContain(canary)
    expect(view.container.textContent).not.toContain('PROFILE_DELIVERY_CANARY')
  })
  it('D10: actual Deal projection preserves omitted nonmoney fields instead of seven null labels', async () => {
    const slot = snapshotSlot(undefined)
    const publicDeal: Record<string, unknown> = { ...slot.deal }
    for (const key of ['price', 'paid', 'packageName', 'packageIncludes']) delete publicDeal[key]
    const view = mount('/deal/d1', { '/weddings': [{ ...WEDDING, role: 'helper' }], '/weddings/w1/slots': [{ ...slot, deal: publicDeal }] })
    await screen.findByText('Суммы и оплаты по сделке видит только пара.')
    expect(view.container.querySelector('dt')).toBeNull()
    for (const label of LABELS) expect(view.container.textContent).not.toContain(label)
  })
  it('D11: actual Deal keeps explicit null unknown even beside stored package contents', async () => {
    const view = mount('/deal/d1', { '/weddings/w1/slots': [snapshotSlot(null)] })
    await screen.findByText('Пакет: Stored agreed package', { selector: 'p' })
    expectDefinitions(view.container, LABELS, LABELS.map(() => 'Неизвестно'))
    expect(view.container.textContent).toContain('Stored agreed contents')
  })
  it('D12: own VendorDealCard selects its exact deal ID and accepted condition snapshot', async () => {
    const own = { id: 'd1', state: 'booked', coupleName: 'Own synthetic couple', weddingDate: '2027-06-14', price: { amount: 12345, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' }, packageName: 'Stored vendor snapshot', packageIncludes: [], comparisonTerms: QUOTED, contract: null, chatId: null }
    const view = mount('/vendor-app/deals/d1', { '/vendor/deals': { items: [{ ...own, id: 'd2', comparisonTerms: OTHER }, own], nextCursor: null } })
    await screen.findByText(QUOTED.hours!)
    expectDefinitions(view.container, LABELS, Object.values(QUOTED))
    for (const canary of Object.values(OTHER)) expect(view.container.textContent).not.toContain(canary)
  })
})

describe('FR018 · actual comparison identities and read observation (controlled API)', () => {
  it('D13: Smart pairs all seven rows with exact selected entry columns; null/zero/public remain distinct', async () => {
    const poisonedPublic = { status: 'responded', offer: fullRequest(OTHER).offer }
    const items = [entry('e3', 3, poisonedPublic), entry('e1', 2, fullRequest(QUOTED)), entry('e2', 1, fullRequest(null)), entry('outside', 0, fullRequest(OTHER))]
    const view = mount('/compare?slot=s1&entries=e1,e2,e3', { '/weddings/w1/slots/s1/shortlist': items })
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').slice(1).map(cell => cell.textContent)).toEqual(['📷Vendor e2', '📷Vendor e1', '📷Vendor e3'])
    for (const [index, label] of LABELS.entries()) expect(compareRow(label).map(cell => cell.textContent)).toEqual(['Неизвестно', Object.values(QUOTED)[index], '—'])
    expect(compareRow('Состав услуги в предложении').map(cell => cell.textContent)).toEqual(['Quoted service', 'Quoted service', '—'])
    for (const canary of Object.values(OTHER)) expect(view.container.textContent).not.toContain(canary)
    expect(view.container.textContent).not.toContain('Vendor outside')
  })
  it('D14: Smart missing selected entry requires reselection, never substitutes an unselected candidate', async () => {
    const view = mount('/compare?slot=s1&entries=e1,e2', { '/weddings/w1/slots/s1/shortlist': [entry('e1', 1, fullRequest(QUOTED)), entry('outside', 2, fullRequest(OTHER))] })
    await screen.findByText('Выбранные кандидаты изменились — отметьте их снова на месте в команде')
    expect(screen.queryByRole('table')).toBeNull()
    for (const canary of Object.values(OTHER)) expect(view.container.textContent).not.toContain(canary)
  })
  it('D15: source/date/read timestamp are separate; resource/unknown columns never promise a free resource', async () => {
    const checkedAt = '2026-10-01T10:11:12.345Z'
    const items = [entry('e1', 1, undefined), entry('e2', 2, undefined, { vendor: { ...PROFILE, id: 'v2', name: 'Resource vendor', bookingMode: 'resources' }, availabilityObservation: null }), entry('e3', 3, undefined, { occupancy: null, availabilityObservation: null })]
    mount('/compare?slot=s1&entries=e1,e2,e3', { '/weddings/w1/slots/s1/shortlist': items })
    await screen.findByRole('table')
    expect(compareRow('Свободен на вашу дату').map(cell => cell.textContent)).toEqual(['Свободен', '—', '—'])
    const cells = compareRow('Актуальность доступности')
    expect(cells[0].textContent).toContain('Календарь дня'); expect(cells[0].textContent).toContain('Дата календаря:'); expect(cells[0].textContent).toContain('Время чтения:')
    expect(cells[0].textContent).toContain('14 июня 2027')
    expect(cells[0].querySelector('time')?.getAttribute('datetime')).toBe(checkedAt)
    expect(cells[0].querySelector('time')?.textContent).toBe(checkedAt)
    expect(cells[0].textContent).toContain('Время чтения не подтверждает доступность отдельных ресурсов')
    expect(cells.slice(1).map(cell => cell.textContent)).toEqual(['Неизвестно', 'Неизвестно'])
    cleanup()
    const direct = render(<OfferAvailabilityObservation observation={undefined} />)
    expect(direct.container.textContent).toBe('Неизвестно'); expect(direct.container.querySelector('time')).toBeNull()
  })
})

describe('FR018 · actual vendor editor submission/intent (controlled API)', () => {
  it('D16: package selection never autofills seven conditions; exactly2000 code points and literal zero submit unchanged price/ID', async () => {
    const second = { id: 'p2', name: 'UNQUOTED profile hours/team/result', price: { amount: 180000, currency: 'RUB' }, includes: ['UNQUOTED fee/cancellation/reschedule'] }
    const view = await editor(REQUEST, { ...PROFILE, packages: [PACKAGE, second] })
    for (const label of LABELS) expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByRole('combobox', { name: 'Пакет' }), { target: { value: 'p2' } })
    for (const label of LABELS) expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe('')
    const values = ['😀'.repeat(2000), QUOTED.team!, QUOTED.result!, QUOTED.delivery!, '0', QUOTED.cancellation!, QUOTED.reschedule!]
    LABELS.forEach((label, index) => fireEvent.change(screen.getByLabelText(label), { target: { value: values[index] } }))
    fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }))
    await waitFor(() => expect(posts(view.calls)).toHaveLength(1))
    expect(posts(view.calls)[0]).toMatchObject({ path: '/vendor/offer-requests/r1/offers', body: { kind: 'offer', packageId: 'p2', price: { amount: 180000, currency: 'RUB' }, comparisonTerms: { ...QUOTED, hours: values[0] } } })
    expect(Object.keys(posts(view.calls)[0].body as object).sort()).toEqual(['comparisonTerms', 'kind', 'packageId', 'price'])
  })
  it('D17: custom offer with blank conditions omits them; title/includes/message are never parsed as conditions', async () => {
    const view = await editor(REQUEST, { ...PROFILE, packages: [] })
    fireEvent.change(screen.getByPlaceholderText('Название предложения'), { target: { value: 'hours/team/title CANARY' } })
    fireEvent.change(screen.getByPlaceholderText('Что входит — по пункту в строке'), { target: { value: 'delivery/extras/services CANARY' } })
    fireEvent.change(screen.getByLabelText('Цена предложения, ₽'), { target: { value: '123.45' } })
    LABELS.forEach(label => fireEvent.change(screen.getByLabelText(label), { target: { value: ' \n ' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }))
    await waitFor(() => expect(posts(view.calls)).toHaveLength(1))
    expect(posts(view.calls)[0].body).toEqual({ kind: 'offer', title: 'hours/team/title CANARY', includes: ['delivery/extras/services CANARY'], price: { amount: 12345, currency: 'RUB' } })
  })
  it('D18: pretrim2001 code points, NUL and unpaired surrogate fail locally with zero POSTs', async () => {
    const view = await editor()
    for (const [value, message] of [[' ' + '😀'.repeat(2000), 'Условие не должно превышать 2000 символов'], ['a\u0000b', 'Условие содержит недопустимые символы'], ['a\ud800b', 'Условие содержит недопустимые символы']]) {
      fireEvent.change(screen.getByLabelText(LABELS[0]), { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }))
      expect((await screen.findByRole('alert')).textContent).toBe(LABELS[0] + ': ' + message)
      expect(posts(view.calls)).toHaveLength(0)
    }
  })
  it('D19: transport-failed same body retries same key; materially changed conditions choose a new intent', async () => {
    const calls = serve({ '/vendor/offer-requests': [REQUEST], 'POST /vendor/offer-requests/r1/offers': () => Promise.reject(new TypeError('Controlled unit transport loss')) })
    const view = render(<MemoryRouter><VendorOfferRequests /></MemoryRouter>)
    await screen.findByLabelText(LABELS[0])
    fireEvent.change(screen.getByLabelText(LABELS[0]), { target: { value: 'first quote' } })
    for (let at = 0; at < 2; at++) {
      fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }))
      await waitFor(() => expect(posts(calls)).toHaveLength(at + 1))
      await screen.findByRole('alert')
      await waitFor(() => expect((screen.getByRole('button', { name: 'Отправить предложение' }) as HTMLButtonElement).disabled).toBe(false))
    }
    expect(posts(calls)[0].key).toBeTruthy(); expect(posts(calls)[1].key).toBe(posts(calls)[0].key)
    expect(posts(calls)[1].body).toEqual(posts(calls)[0].body)
    fireEvent.change(screen.getByLabelText(LABELS[0]), { target: { value: 'materially revised quote' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить предложение' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(3)); await screen.findByRole('alert')
    expect(posts(calls)[2].key).not.toBe(posts(calls)[0].key)
    expect(posts(calls)[2].body).toMatchObject({ comparisonTerms: { hours: 'materially revised quote' } })
    expect(view.container.textContent).not.toContain('Предложение отправлено')
  })
  it('D20: decline preserves strict original body and hides all quoted editor fields', async () => {
    const view = await editor()
    fireEvent.change(screen.getByLabelText(LABELS[4]), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отказ' }))
    for (const label of LABELS) expect(screen.queryByLabelText(label)).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Причина отказа'), { target: { value: '  Controlled decline  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить отказ' }))
    await waitFor(() => expect(posts(view.calls)).toHaveLength(1))
    expect(posts(view.calls)[0].body).toEqual({ kind: 'decline', message: 'Controlled decline' })
  })
})
