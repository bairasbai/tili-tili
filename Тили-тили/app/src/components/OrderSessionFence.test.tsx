import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderDraft } from './OrderDraft'
import { OrderResourcePlan } from './OrderResourcePlan'
import { OrderTerms } from './OrderTerms'
import { OrderResourceCommitments } from './OrderResourceCommitments'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { StoreProvider } from '@/lib/store'
import { Deal } from '@/pages/Tools'
import type { OrderCatalog, OrderTermsView, ResourceCommitmentView, ResourcePlanView, WeddingOrder } from '@/lib/api/orders'

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const deal = id(1), wedding = id(2), vendor = id(3), part = id(4), term = id(5), planId = id(6), resourceId = id(7), windowId = id(8), digest = 'a'.repeat(64)
const token = (user = 10, session = 30, suffix = 'original') => `header.${btoa(JSON.stringify({ sub: id(user), sid: id(session) }))}.${suffix}`
const tokensA = { accessToken: token(), refreshToken: 'refresh-A' }
const tokensB = { accessToken: token(11, 31), refreshToken: 'refresh-B' }
type Kind = 'draft' | 'plan' | 'terms' | 'commitment'
type Call = { path: string; method: string; body: unknown; rawBody: BodyInit | null | undefined; headers: Headers }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function held<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function fixtures(kind: Kind) {
  const order: WeddingOrder = { dealId: deal, version: '2', schemaVersion: 1, source: 'structured', brief: null, assignments: [], parts: [{ id: part, kind: 'deliverable', version: '1', source: 'structured', assignmentId: null, title: 'Личная работа', details: { items: null, dueAt: null, recipient: null, reviewProcess: null }, cancelledAt: null }] }
  const catalog: OrderCatalog = { weddingId: wedding, primarySlotId: id(9), actorRole: kind === 'plan' ? 'vendor' : 'couple', draftEditable: true, dealState: 'candidate', vendorId: vendor, timeZone: 'Europe/Moscow', assignmentTimeZones: [], eligiblePositions: [], category: { categoryId: 'flowers', label: 'Цветы', autoAssign: false, fields: [], suggestedKinds: ['deliverable'] }, executionKinds: ['deliverable'] }
  const line = { partId: part, resourceId, capacityWindowId: windowId, quantity: 10, startsAt: '2027-06-10T07:00:00Z', endsAt: '2027-06-10T08:00:00Z', timeZone: 'Europe/Moscow', setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0 }
  const current: NonNullable<ResourcePlanView['current']> = { planRevisionId: planId, revision: '1', lines: [{ partId: part, assignmentId: null, programEventId: null, label: 'Букеты', kind: 'capacity', quantity: 10, unit: 'букеты', startsAt: line.startsAt, endsAt: line.endsAt, timeZone: line.timeZone, setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0, occupiedStartsAt: line.startsAt, occupiedEndsAt: line.endsAt, window: { startsAt: '2027-06-10T00:00:00Z', endsAt: '2027-06-11T00:00:00Z' } }] }
  const plan: ResourcePlanView = { orderVersion: '2', revision: '1', canEdit: kind === 'plan', reservation: 'not_reserved', current, editorLines: kind === 'plan' ? [line] : null, source: 'current', history: [current] }
  const selected: NonNullable<OrderTermsView['selected']> = { id: term, version: '1', sourceOrderVersion: '2', sourceFingerprint: digest, digest, snapshot: { schemaVersion: 2, weddingId: wedding, dealId: deal, source: 'structured', categoryId: 'flowers', sourceOrderVersion: '2', legacyContext: { mainEvent: null }, brief: null, assignments: [], parts: order.parts.map(p => ({ id: p.id, kind: p.kind, version: p.version, source: p.source, title: p.title, assignmentId: p.assignmentId, details: p.details })), economics: { amount: null, amountKnown: false, currency: 'RUB', performer: { vendor: { id: vendor, userId: id(11), name: 'Компания', categoryId: 'flowers' }, externalName: null, externalPhone: null }, package: { id: null, titleSnapshot: null, includesSnapshot: null } }, resourcePlan: structuredClone(current) }, publishedBy: id(11), publishedSide: 'performer', publishedAt: '2027-01-01T10:00:00Z', freshness: 'current', receipts: [{ id: id(20), party: 'customer', userId: id(10), sessionId: id(30), digest, acceptedAt: '2027-01-02T10:00:00Z' }, { id: id(21), party: 'performer', userId: id(11), sessionId: id(31), digest, acceptedAt: '2027-01-03T10:00:00Z' }], acceptedByCaller: true }
  const terms: OrderTermsView = { revision: '1', proposedTermsId: term, agreedTermsId: term, history: [selected], selected, acceptedByCaller: true, readToken: 'reader-A-proof' }
  const commitment: ResourceCommitmentView = { revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' }
  const resources = [{ id: resourceId, kind: 'capacity', label: 'Букеты', version: '1', personUserId: null, staffMemberId: null, capacityUnit: 'букеты', retiredAt: null, source: 'current', unavailableReason: null, windows: [{ id: windowId, startsAt: '2027-06-10T00:00:00Z', endsAt: '2027-06-11T00:00:00Z', capacity: 30, used: 0, version: '1' }] }]
  const read = (path: string) => path === '/vendor/profile' ? { id: vendor } : path.endsWith('/resources') ? resources : path.endsWith('/catalog') ? catalog : path.endsWith('/resource-plan') ? plan : path.endsWith('/resource-commitments') ? commitment : path.includes('/terms') ? terms : path.endsWith('/booking-policy') ? { mode: 'resources', revision: '3' } : order
  const write = (call: Call) => {
    if (kind === 'plan') {
      const body = call.body as { lines: typeof line[] }
      order.version = '3'; plan.orderVersion = '3'; plan.revision = '2'; plan.editorLines = body.lines
      plan.current = { ...current, revision: '2', planRevisionId: id(40), lines: current.lines.map((item, index) => ({ ...item, quantity: body.lines[index]!.quantity })) }; plan.history.push(plan.current)
      return plan
    }
    if (kind === 'draft') { order.version = '3'; order.parts[0]!.cancelledAt = '2027-01-04T10:00:00Z'; return order }
    if (kind === 'commitment') { catalog.dealState = 'booked'; Object.assign(commitment, { revision: '1', state: 'reserved', reservation: 'reserved', termsId: term, planRevisionId: planId }); plan.reservation = 'reserved'; return commitment }
    return terms
  }
  return { read, write, requireAcceptance: () => { selected.receipts = selected.receipts.filter(r => r.party === 'performer'); selected.acceptedByCaller = false; terms.acceptedByCaller = false; terms.agreedTermsId = null } }
}
const labels = { draft: 'Состав заказа', plan: 'План ресурсов заказа', terms: 'Согласование условий', commitment: 'Бронь ресурсов заказа' }
const actions = { draft: 'Убрать работу из черновика', plan: 'Сохранить план ресурсов', terms: 'Предложить текущий состав заказа', commitment: 'Забронировать заказ и ресурсы по согласованному плану' }
function view(kind: Kind, dealId = deal) {
  const component = kind === 'draft' ? <OrderDraft dealId={dealId} initiallyOpen /> : kind === 'plan' ? <OrderResourcePlan dealId={dealId} /> : kind === 'terms' ? <OrderTerms dealId={dealId} /> : <OrderResourceCommitments dealId={dealId} />
  return <MemoryRouter>{component}</MemoryRouter>
}
async function clickWrite(kind: Kind) {
  if (kind !== 'draft') fireEvent.click(screen.getByText(labels[kind]))
  const action = await screen.findByRole('button', { name: actions[kind] })
  if (kind === 'plan') fireEvent.change(screen.getByLabelText('Количество для этого заказа'), { target: { value: '11' } })
  await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(action)
}
function server(kind: Kind, options: { holdRefresh?: boolean; holdRead?: string; acceptTerms?: boolean } = {}) {
  const state = fixtures(kind), initial = held<Response>(), refreshResult = held<Response>(), readResult = held<Response>(), calls: Call[] = [], resumed = { accessToken: token(10, 30, 'renewed'), refreshToken: 'refresh-A-renewed' }
  if (options.acceptTerms) state.requireAcceptance()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, rawBody: init?.body, headers: new Headers(init?.headers) }; calls.push(call)
    if (call.path === '/auth/refresh') return options.holdRefresh ? refreshResult.promise : json((call.body as { refreshToken: string }).refreshToken === tokensB.refreshToken ? { accessToken: token(11, 31, 'renewed'), refreshToken: 'refresh-B-renewed' } : resumed)
    if (call.method === 'GET') return call.path === options.holdRead ? readResult.promise : json(state.read(call.path))
    return calls.filter(c => c.method !== 'GET' && c.path !== '/auth/refresh').length === 1 ? initial.promise : json(state.write(call))
  }))
  return { initial, calls, resumed, refreshResult, readResult, answer: state.write, writes: () => calls.filter(c => c.method !== 'GET' && c.path !== '/auth/refresh'), refreshes: () => calls.filter(c => c.path === '/auth/refresh') }
}
beforeEach(() => { localStorage.clear(); saveTokens(tokensA); localStorage.setItem('tt_wedding_id', JSON.stringify(wedding)); setI18nLang('ru') })
afterEach(() => { cleanup(); saveTokens(null); vi.unstubAllGlobals() })
describe.each<Kind>(['draft', 'plan', 'terms', 'commitment'])('%s real-client original 401 ownership', kind => {
  it('does not refresh B or retry an A write after switching session', async () => {
    const h = server(kind); render(view(kind)); await clickWrite(kind); expect(h.writes()).toHaveLength(1)
    await act(async () => { saveTokens(tokensB) })
    const response = json({ error: { code: 'unauthorized', message: 'unauthorized' } }, 401)
    await act(async () => { h.initial.resolve(response); await new Promise(done => setTimeout(done, 0)) })
    const observed = { refreshBodies: h.refreshes().map(c => c.body), writeAuthorizations: h.writes().map(c => c.headers.get('authorization')) }
    expect(observed, JSON.stringify(observed)).toEqual({ refreshBodies: [], writeAuthorizations: ['Bearer ' + tokensA.accessToken] })
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(tokensB)
    expect(screen.queryByRole('button', { name: /Проверить (сохранение|результат)/ })).toBeNull()
    expect(response.bodyUsed || response.body?.locked).toBeTruthy()
  })
  it('keeps one legitimate same-session refresh and retries identical bytes/key', async () => {
    const h = server(kind); render(view(kind)); await clickWrite(kind)
    await act(async () => { h.initial.resolve(json({ error: { code: 'unauthorized', message: 'unauthorized' } }, 401)) })
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    expect(h.refreshes()).toHaveLength(1); expect(h.refreshes()[0]!.body).toEqual({ refreshToken: tokensA.refreshToken })
    const [original, retry] = h.writes(); expect(retry!.path).toBe(original!.path); expect(retry!.rawBody).toBe(original!.rawBody)
    expect(original!.headers.get('Idempotency-Key')).toBeTruthy(); expect(retry!.headers.get('Idempotency-Key')).toBe(original!.headers.get('Idempotency-Key'))
    expect(retry!.headers.get('authorization')).toBe('Bearer ' + h.resumed.accessToken)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(h.resumed)
  })
  it.each(['unmount', 'deal', 'wedding', 'A-B-A'] as const)('rejects the held original401 after %s', async boundary => {
    const h = server(kind), mounted = render(view(kind)); await clickWrite(kind)
    await act(async () => {
      if (boundary === 'unmount') mounted.unmount()
      else if (boundary === 'deal') mounted.rerender(view(kind, id(99)))
      else if (boundary === 'wedding') localStorage.setItem('tt_wedding_id', JSON.stringify(id(99)))
      else { saveTokens(tokensB); saveTokens(tokensA) }
    })
    await act(async () => { h.initial.resolve(json({}, 401)); await new Promise(done => setTimeout(done, 0)) })
    expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1)
  })
  it('does not re-read private sources after the successful response body crosses a session boundary', async () => {
    const h = server(kind); render(view(kind)); await clickWrite(kind)
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { 'content-type': 'application/json' } })
    await act(async () => { h.initial.resolve(response); await new Promise(done => setTimeout(done, 0)) })
    const priorReads = h.calls.filter(c => c.method === 'GET').length
    await act(async () => { saveTokens(tokensB); stream.enqueue(new TextEncoder().encode(JSON.stringify(h.answer(h.writes()[0]!)))); stream.close() })
    expect(h.calls.filter(c => c.method === 'GET')).toHaveLength(priorReads); expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(tokensB)
  })
  it('does not retry or overwrite B when an A refresh response arrives late', async () => {
    const h = server(kind, { holdRefresh: true }); render(view(kind)); await clickWrite(kind)
    await act(async () => { h.initial.resolve(json({}, 401)) }); await waitFor(() => expect(h.refreshes()).toHaveLength(1))
    await act(async () => { saveTokens(tokensB); h.refreshResult.resolve(json(h.resumed)) })
    expect(h.writes()).toHaveLength(1); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(tokensB)
  })
  it('destroys an uncertain manual retry when the selected wedding changes', async () => {
    const h = server(kind); render(view(kind)); await clickWrite(kind)
    await act(async () => { h.initial.reject(new TypeError('synthetic response lost')) })
    const retry = await screen.findByRole('button', { name: /Проверить (сохранение|результат)/ })
    localStorage.setItem('tt_wedding_id', JSON.stringify(id(99))); fireEvent.click(retry)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Проверить (сохранение|результат)/ })).toBeNull())
    expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
  })
  const privateReads = kind === 'draft' ? ['order', 'order/catalog'] : kind === 'plan' ? ['order', 'order/catalog', 'order/resource-plan'] : kind === 'terms' ? ['order', 'order/catalog', 'order/terms'] : ['order', 'order/catalog', 'order/resource-plan', 'order/terms', 'order/resource-commitments', 'policy']
  it.each(privateReads)('fences private %s GET401 before refreshing the new session', async suffix => {
    const path = suffix === 'policy' ? '/vendors/' + vendor + '/booking-policy' : '/deals/' + deal + '/' + suffix, h = server(kind, { holdRead: path }); render(view(kind))
    if (kind !== 'draft') fireEvent.click(screen.getByText(labels[kind]))
    await waitFor(() => expect(h.calls.some(c => c.path === path)).toBe(true))
    await act(async () => { saveTokens(tokensB); h.readResult.resolve(json({}, 401)); await new Promise(done => setTimeout(done, 0)) })
    expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(0); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(tokensB)
  })
})

async function clickAccept() {
  fireEvent.click(screen.getByText(labels.terms))
  fireEvent.click(await screen.findByText('Подробности сохранённой редакции'))
  const checkbox = await screen.findByRole('checkbox', { name: 'Я ознакомился с этой редакцией и хочу принять её условия' })
  await waitFor(() => expect((checkbox as HTMLInputElement).disabled).toBe(false)); fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: 'Принять эту редакцию' }))
}
it('acceptance readToken cannot be replayed under B after an original401', async () => {
  const h = server('terms', { acceptTerms: true }); render(view('terms')); await clickAccept()
  expect(h.writes()[0]!.body).toEqual({ expectedTermsVersion: '1', digest, readToken: 'reader-A-proof' })
  await act(async () => { saveTokens(tokensB); h.initial.resolve(json({}, 401)); await new Promise(done => setTimeout(done, 0)) })
  expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1)
})
it('same-session acceptance refresh preserves readToken/digest/version/body/key exactly', async () => {
  const h = server('terms', { acceptTerms: true }); render(view('terms')); await clickAccept()
  await act(async () => { h.initial.resolve(json({}, 401)) }); await waitFor(() => expect(h.writes()).toHaveLength(2))
  expect(h.refreshes()).toHaveLength(1); expect(h.writes()[1]!.body).toEqual({ expectedTermsVersion: '1', digest, readToken: 'reader-A-proof' })
  expect(h.writes()[1]!.rawBody).toBe(h.writes()[0]!.rawBody); expect(h.writes()[1]!.headers.get('Idempotency-Key')).toBe(h.writes()[0]!.headers.get('Idempotency-Key'))
})

it.each(['/vendor/profile', '/vendors/' + vendor + '/resources'])('plan company selector %s cannot refresh B from an old GET401', async path => {
  const h = server('plan', { holdRead: path }); render(view('plan')); fireEvent.click(screen.getByText(labels.plan))
  await waitFor(() => expect(h.calls.some(c => c.path === path)).toBe(true))
  const reads = h.calls.length
  await act(async () => { saveTokens(tokensB); h.readResult.resolve(json({}, 401)); await new Promise(done => setTimeout(done, 0)) })
  expect(h.calls).toHaveLength(reads); expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(0)
})

function Location() { return <output data-testid="location">{useLocation().pathname}</output> }
function cancelServer() {
  const initial = held<Response>(), calls: Call[] = [], resumed = { accessToken: token(10, 30, 'renewed'), refreshToken: 'refresh-A-renewed' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, rawBody: init?.body, headers: new Headers(init?.headers) }; calls.push(call)
    if (call.path === '/auth/refresh') return json((call.body as { refreshToken: string }).refreshToken === tokensB.refreshToken ? { accessToken: token(11, 31, 'renewed'), refreshToken: 'refresh-B-renewed' } : resumed)
    if (call.path.endsWith('/cancel')) return calls.filter(c => c.path.endsWith('/cancel')).length === 1 ? initial.promise : new Response(null, { status: 204 })
    if (call.path === '/weddings') return json([{ id: wedding, title: 'Свадьба', date: '2027-06-14', role: 'couple' }])
    if (call.path === '/weddings/' + wedding) return json({ id: wedding, title: 'Свадьба', date: '2027-06-14', tz: 'Europe/Moscow' })
    if (call.path.endsWith('/slots')) return json([{ id: id(50), categoryId: 'flowers', label: 'Мой заказ', tileState: 'booked', prebooked: false, deal: { id: deal, state: 'booked', vendor: { id: vendor, name: 'Компания' }, price: { amount: 100000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } } }])
    return json([])
  }))
  return { calls, initial, resumed, writes: () => calls.filter(c => c.path.endsWith('/cancel')), refreshes: () => calls.filter(c => c.path === '/auth/refresh') }
}
async function clickCancel() {
  const mounted = render(<MemoryRouter initialEntries={['/deal/' + deal]}><StoreProvider><Location /><Routes><Route path="/deal/:id" element={<Deal />} /><Route path="/wedding" element={<p>Команда</p>} /></Routes></StoreProvider></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить сделку' })); fireEvent.click(screen.getByRole('button', { name: 'Точно отменить?' }))
  return mounted
}
describe('cancel real-client through actual Tools/store/slots', () => {
  it('does not consume B refresh or navigate after held A401', async () => {
    const h = cancelServer(); await clickCancel(); expect(h.writes()).toHaveLength(1)
    await act(async () => { saveTokens(tokensB) })
    await act(async () => { h.initial.resolve(json({ error: { code: 'unauthorized', message: 'unauthorized' } }, 401)); await new Promise(done => setTimeout(done, 0)) })
    const observed = { refreshBodies: h.refreshes().map(c => c.body), writeAuthorizations: h.writes().map(c => c.headers.get('authorization')) }
    expect(observed, JSON.stringify(observed)).toEqual({ refreshBodies: [], writeAuthorizations: ['Bearer ' + tokensA.accessToken] })
    expect(screen.getByTestId('location').textContent).toBe('/deal/' + deal)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(tokensB)
  })
  it('refreshes the current session once, keeps exact cancel intent and navigates after success', async () => {
    const h = cancelServer(); await clickCancel()
    await act(async () => { h.initial.resolve(json({ error: { code: 'unauthorized', message: 'unauthorized' } }, 401)) })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/wedding'))
    expect(h.refreshes()).toHaveLength(1); expect(h.writes()).toHaveLength(2)
    const [original, retry] = h.writes(); expect(retry!.path).toBe(original!.path); expect(retry!.rawBody).toBe(original!.rawBody)
    expect(original!.headers.get('Idempotency-Key')).toBeTruthy(); expect(retry!.headers.get('Idempotency-Key')).toBe(original!.headers.get('Idempotency-Key'))
    expect(retry!.headers.get('authorization')).toBe('Bearer ' + h.resumed.accessToken)
  })
  it.each(['unmount', 'wedding', 'A-B-A'] as const)('does not refresh or retry cancel after %s', async boundary => {
    const h = cancelServer(), mounted = await clickCancel()
    await act(async () => { if (boundary === 'unmount') mounted.unmount(); else if (boundary === 'wedding') localStorage.setItem('tt_wedding_id', JSON.stringify(id(99))); else { saveTokens(tokensB); saveTokens(tokensA) } })
    await act(async () => { h.initial.resolve(json({}, 401)); await new Promise(done => setTimeout(done, 0)) })
    expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1)
    if (boundary !== 'unmount') expect(screen.getByTestId('location').textContent).toBe('/deal/' + deal)
  })
  it('does not refresh slots or navigate when a successful cancel body outlives its selected wedding', async () => {
    const h = cancelServer(); await clickCancel()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { 'content-type': 'application/json' } })
    await act(async () => { h.initial.resolve(response); await new Promise(done => setTimeout(done, 0)) })
    const reads = h.calls.filter(c => c.path.endsWith('/slots')).length
    await act(async () => { localStorage.setItem('tt_wedding_id', JSON.stringify(id(99))); stream.enqueue(new TextEncoder().encode('{}')); stream.close() })
    expect(screen.getByTestId('location').textContent).toBe('/deal/' + deal); expect(h.calls.filter(c => c.path.endsWith('/slots'))).toHaveLength(reads)
    expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
  })
})
