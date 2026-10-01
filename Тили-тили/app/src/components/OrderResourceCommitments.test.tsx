import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderResourceCommitments } from './OrderResourceCommitments'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang, t } from '@/lib/i18n'
import type { WeddingOrder, OrderCatalog, OrderTermsView, ResourcePlanView, ResourceCommitmentView, VendorBookingPolicy, ResourceCommitmentWrite } from '@/lib/api/orders'

type Call = { path: string; method: string; body: ResourceCommitmentWrite | null; headers: Headers }
type Reply = { body?: unknown; status?: number; down?: boolean }
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const deal = id(1), wedding = id(2), vendor = id(3), part = id(4), term = id(5), planId = id(6), digest = 'a'.repeat(64)
const book = 'Забронировать заказ и ресурсы по согласованному плану', replace = 'Заменить бронь по новым согласованным условиям', refresh = 'Обновить сведения о брони', retry = 'Проверить результат запроса'
function fixtures() {
  const order: WeddingOrder = { dealId: deal, version: '2', schemaVersion: 1, source: 'structured', brief: null, assignments: [], parts: [{ id: part, kind: 'deliverable', version: '1', source: 'structured', assignmentId: null, title: 'Готовые букеты', details: { items: null, dueAt: null, recipient: null, reviewProcess: null }, cancelledAt: null }] }
  const catalog: OrderCatalog = { weddingId: wedding, primarySlotId: id(7), actorRole: 'couple', draftEditable: true, dealState: 'candidate', vendorId: vendor, timeZone: null, assignmentTimeZones: [], eligiblePositions: [], category: { categoryId: 'flowers', label: 'Цветы', autoAssign: false, fields: [], suggestedKinds: ['deliverable'] }, executionKinds: ['deliverable'] }
  const current: NonNullable<ResourcePlanView['current']> = { planRevisionId: planId, revision: '1', lines: [{ partId: part, assignmentId: null, programEventId: null, label: 'Изготовление букетов', kind: 'capacity', quantity: 10, unit: 'букеты', startsAt: '2027-06-10T07:00:00Z', endsAt: '2027-06-10T08:00:00Z', timeZone: 'Europe/Moscow', setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0, occupiedStartsAt: '2027-06-10T07:00:00Z', occupiedEndsAt: '2027-06-10T08:00:00Z', window: { startsAt: '2027-06-10T00:00:00Z', endsAt: '2027-06-11T00:00:00Z' } }] }
  const plan: ResourcePlanView = { orderVersion: '2', revision: '1', canEdit: false, reservation: 'not_reserved', current, editorLines: null, source: 'current', history: [current] }
  const selected: NonNullable<OrderTermsView['selected']> = { id: term, version: '1', sourceOrderVersion: '2', sourceFingerprint: digest, digest, snapshot: { schemaVersion: 2, weddingId: wedding, dealId: deal, source: 'structured', categoryId: 'flowers', sourceOrderVersion: '2', legacyContext: { mainEvent: null }, brief: null, assignments: [], parts: order.parts.map(p => ({ id: p.id, kind: p.kind, version: p.version, source: p.source, title: p.title, assignmentId: p.assignmentId, details: p.details })), economics: { amount: null, amountKnown: false, currency: 'RUB', performer: { vendor: { id: vendor, userId: id(11), name: 'Цветочная мастерская', categoryId: 'flowers' }, externalName: null, externalPhone: null }, package: { id: null, titleSnapshot: null, includesSnapshot: null } }, resourcePlan: structuredClone(current) }, publishedBy: id(11), publishedSide: 'performer', publishedAt: '2027-01-01T10:00:00Z', freshness: 'current', receipts: [{ id: id(20), party: 'customer', userId: id(10), sessionId: id(30), digest, acceptedAt: '2027-01-02T10:00:00Z' }, { id: id(21), party: 'performer', userId: id(11), sessionId: id(31), digest, acceptedAt: '2027-01-03T10:00:00Z' }], acceptedByCaller: true }
  const terms: OrderTermsView = { revision: '1', proposedTermsId: term, agreedTermsId: term, history: [selected], selected, acceptedByCaller: true, readToken: 'never-store-this-read-token' }
  const commitment: ResourceCommitmentView = { revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' }
  const policy: VendorBookingPolicy = { mode: 'resources', revision: '3' }
  return { order, catalog, plan, terms, commitment, policy }
}
function serve(handler: (c: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { path: String(request).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    calls.push(c); const r = await handler(c); if (r.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function harness(handler?: (c: Call) => Reply | Promise<Reply>) {
  const state = fixtures()
  const get = (c: Call): Reply => ({ body: c.path.endsWith('/booking-policy') ? state.policy : c.path.endsWith('/catalog') ? state.catalog : c.path.endsWith('/resource-plan') ? state.plan : c.path.endsWith('/resource-commitments') ? state.commitment : c.path.endsWith('/terms') ? state.terms : state.order })
  const accept = () => { state.catalog.dealState = 'booked'; state.commitment = { revision: '1', state: 'reserved', reservation: 'reserved', termsId: term, planRevisionId: planId }; state.plan.reservation = 'reserved'; return { body: state.commitment } }
  const calls = serve(c => handler ? handler(c) : c.method === 'GET' ? get(c) : accept())
  return { state, get, accept, calls }
}
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET')
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
async function open() { fireEvent.click(screen.getByText('Бронь ресурсов заказа')); await screen.findByRole('button', { name: refresh }); await waitFor(() => expect(screen.queryByText('Проверяем актуальную бронь…')).toBeNull()) }
function deferred() { let resolve!: (r: Reply) => void; const promise = new Promise<Reply>(r => { resolve = r }); return { resolve, promise } }
function prior(h: ReturnType<typeof harness>) { h.state.catalog.dealState = 'booked'; h.state.commitment = { revision: '4', state: 'reserved', reservation: 'reserved', termsId: id(50), planRevisionId: id(51) } }
beforeEach(() => { localStorage.clear(); saveTokens({ accessToken: 'a', refreshToken: 'r' }); setI18nLang('ru') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('quiet commitment UI through real HTTP wrappers with controlled replies, not PG or human acceptance evidence', () => {
  it('ignores the obsolete StrictMode effect while the active initial read is still pending', async () => {
    const h = harness(), slow = deferred(); let reads = 0
    const calls = serve(c => c.path.endsWith('/resource-commitments') && ++reads === 2 ? slow.promise : h.get(c))
    render(<StrictMode><OrderResourceCommitments dealId={deal} /></StrictMode>)
    fireEvent.click(screen.getByText('Бронь ресурсов заказа'))
    await waitFor(() => expect(reads).toBe(2))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText('Проверяем актуальную бронь…')).toBeTruthy()
    expect(screen.queryByText('Не удалось подтвердить актуальную бронь. Обновите сведения.')).toBeNull()
    expect(screen.getByRole('button', { name: refresh }).hasAttribute('disabled')).toBe(true)
    await act(async () => slow.resolve({ body: h.state.commitment }))
    await screen.findByRole('button', { name: book })
    expect(screen.queryByText('Не удалось подтвердить актуальную бронь. Обновите сведения.')).toBeNull()
    expect(writes(calls)).toHaveLength(0)
  })
  it.each([403, 404])('ignores an obsolete first StrictMode privacy HTTP %s after the active reader succeeds', async status => {
    const h = harness(), obsolete = deferred(); let reads = 0
    const calls = serve(c => c.path.endsWith('/resource-commitments') && ++reads === 1 ? obsolete.promise : h.get(c))
    render(<StrictMode><OrderResourceCommitments dealId={deal} /></StrictMode>)
    fireEvent.click(screen.getByText('Бронь ресурсов заказа'))
    await screen.findByRole('button', { name: book })
    await waitFor(() => expect(screen.queryByText('Проверяем актуальную бронь…')).toBeNull())
    expect(reads).toBe(3)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Ресурсы не зарезервированы')).toBeTruthy()
    await act(async () => obsolete.resolve({ status }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: book }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: refresh }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('Проверяем актуальную бронь…')).toBeNull()
    expect(screen.queryByText('Не удалось подтвердить актуальную бронь. Обновите сведения.')).toBeNull()
    expect(screen.getByText('Ресурсы не зарезервированы')).toBeTruthy()
    expect(writes(calls)).toHaveLength(0)
  })
  it('makes no collapsed requests, polls nothing, and never accepts or books automatically', async () => {
    const h = harness(); render(<OrderResourceCommitments dealId={deal} />); await act(async () => {}); expect(h.calls).toHaveLength(0); await open(); expect(screen.getByRole('button', { name: book })).toBeTruthy()
    const count = h.calls.length; await act(async () => new Promise(r => setTimeout(r, 30))); expect(h.calls).toHaveLength(count); expect(writes(h.calls)).toHaveLength(0)
    expect(h.calls.some(c => c.path.includes('/resources') || c.path.includes('/accept') || c.path.includes('/vendor/profile'))).toBe(false); expect(localStorage.length).toBe(1)
  })
  it('sends precisely seven current proof fields and reads the actual new reservation afterwards', async () => {
    const h = harness(); render(<OrderResourceCommitments dealId={deal} />); await open(); click(book); await screen.findByText('Запрос обработан. Показана актуальная бронь.')
    expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(screen.queryByRole('button', { name: book })).toBeNull()
    expect(writes(h.calls)[0]?.body).toEqual({ expectedOrderVersion: '2', expectedCommitmentRevision: '0', termsId: term, expectedTermsVersion: '1', termsDigest: digest, planRevisionId: planId, expectedPolicyRevision: '3' })
    expect(writes(h.calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(JSON.stringify(writes(h.calls))).not.toContain('never-store-this-read-token')
  })
  it.each(['done', 'cancelled', 'booked', 'paid_deposit'] as const)('does not initially book ledgerless %s', async state => {
    const h = harness(); h.state.catalog.dealState = state; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.queryByRole('button', { name: book })).toBeNull(); expect(screen.queryByRole('button', { name: replace })).toBeNull()
  })
  it.each(['contacted', 'negotiating'] as const)('allows explicit initial reservation for a proved %s candidate', async state => { const h = harness(); h.state.catalog.dealState = state; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByRole('button', { name: book })).toBeTruthy(); expect(writes(h.calls)).toHaveLength(0) })
  it('uses server vendor role only for reading, never a booking action', async () => { const h = harness(); h.state.catalog.actorRole = 'vendor'; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByText('Исполнитель видит бронь. Подтвердить или заменить её может пара.')).toBeTruthy(); expect(screen.queryByRole('button', { name: book })).toBeNull() })
  it.each(['person', 'equipment'] as const)('supports an actual individual %s resource without inventing quantity or capacity', async kind => { const h = harness(), line = h.state.plan.current!.lines[0]!; line.kind = kind; line.quantity = 1; line.unit = null; line.window = null; h.state.terms.selected!.snapshot.resourcePlan = structuredClone(h.state.plan.current); render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByRole('button', { name: book })).toBeTruthy(); expect(writes(h.calls)).toHaveLength(0) })
  it.each(['missing_state', 'missing_vendor', 'no_agreement', 'new_proposal', 'stale', 'schema1', 'wrong_scope', 'wrong_source_version', 'wrong_order_version', 'wrong_plan', 'empty_plan', 'missing_buffer', 'private_line', 'unknown_snapshot', 'wrong_digest', 'single_receipt', 'same_user', 'same_session', 'missing_user', 'missing_session', 'receipt_digest', 'wrong_policy', 'bad_policy_revision', 'unknown_terms', 'invalid_source', 'unavailable_source'] as const)('blocks unsupported proof %s while preserving actual commitment truth', async bad => {
    const h = harness(), s = h.state, selected = s.terms.selected!
    if (bad === 'missing_state') delete s.catalog.dealState
    if (bad === 'missing_vendor') delete s.catalog.vendorId
    if (bad === 'no_agreement') s.terms.agreedTermsId = null
    if (bad === 'new_proposal') s.terms.proposedTermsId = id(99)
    if (bad === 'stale') selected.freshness = 'stale'
    if (bad === 'schema1') selected.snapshot.schemaVersion = 1
    if (bad === 'wrong_scope') selected.snapshot.weddingId = id(99)
    if (bad === 'wrong_source_version') selected.sourceOrderVersion = '1'
    if (bad === 'wrong_order_version') s.plan.orderVersion = '1'
    if (bad === 'wrong_plan') (selected.snapshot.resourcePlan as { planRevisionId: string }).planRevisionId = id(99)
    if (bad === 'empty_plan') s.plan.current!.lines = []
    if (bad === 'missing_buffer') delete (s.plan.current!.lines[0] as unknown as Record<string, unknown>).travelAfterMinutes
    if (bad === 'private_line') (s.plan.current!.lines[0] as unknown as Record<string, unknown>).personUserId = id(999)
    if (bad === 'unknown_snapshot') selected.snapshot.unknownMaterial = 'secret'
    if (bad === 'wrong_digest') selected.sourceFingerprint = 'b'.repeat(64)
    if (bad === 'single_receipt') selected.receipts.pop()
    if (bad === 'same_user') selected.receipts[1]!.userId = selected.receipts[0]!.userId
    if (bad === 'same_session') selected.receipts[1]!.sessionId = selected.receipts[0]!.sessionId
    if (bad === 'missing_user') selected.receipts[1]!.userId = null
    if (bad === 'missing_session') selected.receipts[1]!.sessionId = null
    if (bad === 'receipt_digest') selected.receipts[1]!.digest = 'b'.repeat(64)
    if (bad === 'wrong_policy') s.policy.mode = 'legacy_day'
    if (bad === 'bad_policy_revision') s.policy.revision = '9223372036854775808'
    if (bad === 'unknown_terms') (s.terms as unknown as Record<string, unknown>).unknownProof = true
    if (bad === 'invalid_source') s.plan.source = 'invalid'
    if (bad === 'unavailable_source') s.plan.source = 'unavailable'
    render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByText('Ресурсы не зарезервированы')).toBeTruthy(); expect(screen.queryByRole('button', { name: book })).toBeNull(); expect(writes(h.calls)).toHaveLength(0); expect(document.body.textContent).not.toContain(id(999))
  })
  it('keeps a prior promise separate from the new draft and explicitly replaces it', async () => {
    const h = harness(); prior(h); render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByText('Действует прежняя бронь. Новый план ещё не зарезервирован.')).toBeTruthy(); expect(screen.getByText('Прежняя бронь сохраняется до успешной замены. При конфликте ресурсов она останется действовать.')).toBeTruthy(); expect(writes(h.calls)).toHaveLength(0)
    click(replace); await screen.findByText('Запрос обработан. Показана актуальная бронь.'); expect(writes(h.calls)[0]?.path).toBe('/deals/' + deal + '/order/resource-commitments/replace'); expect(writes(h.calls)[0]?.body?.expectedCommitmentRevision).toBe('4'); expect(screen.queryByText('Действует прежняя бронь. Новый план ещё не зарезервирован.')).toBeNull()
  })
  it('offers explicit replacement for new agreed terms with the same reserved plan', async () => { const h = harness(); prior(h); h.state.catalog.dealState = 'paid_deposit'; h.state.commitment.planRevisionId = planId; h.state.plan.reservation = 'reserved'; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByRole('button', { name: replace })).toBeTruthy(); expect(screen.queryByText('Действует прежняя бронь. Новый план ещё не зарезервирован.')).toBeNull() })
  it.each(['done', 'cancelled'] as const)('preserves a reserved promise but forbids replacement at %s', async state => { const h = harness(); prior(h); h.state.catalog.dealState = state; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(screen.queryByRole('button', { name: replace })).toBeNull() })
  it('renders released as released and never implicitly reserves it again', async () => { const h = harness(); h.state.commitment = { revision: '2', state: 'released', reservation: 'released', termsId: term, planRevisionId: planId }; h.state.plan.reservation = 'released'; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByText('Резерв ресурсов освобождён')).toBeTruthy(); expect(screen.queryByRole('button', { name: book })).toBeNull() })
  it('rechecks source after a policy wait and refuses mixed snapshots', async () => {
    const h = harness(), slow = deferred(); serve(c => c.path.endsWith('/booking-policy') ? slow.promise : h.get(c)); render(<OrderResourceCommitments dealId={deal} />); fireEvent.click(screen.getByText('Бронь ресурсов заказа')); await waitFor(() => expect(screen.getByText('Проверяем актуальную бронь…')).toBeTruthy()); h.state.order.version = '3'; await act(async () => slow.resolve({ body: h.state.policy })); await screen.findByText('Не удалось подтвердить актуальную бронь. Обновите сведения.'); expect(screen.queryByRole('button', { name: book })).toBeNull()
  })
  it('refreshes manually after agreements change in another card without polling', async () => { const h = harness(); h.state.terms.agreedTermsId = null; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.queryByRole('button', { name: book })).toBeNull(); h.state.terms.agreedTermsId = term; click(refresh); await screen.findByRole('button', { name: book }); expect(writes(h.calls)).toHaveLength(0) })
  it('keeps the exact key and body only for a manual retry after network loss', async () => {
    const h = harness(); let n = 0; const calls = serve(c => c.method === 'GET' ? h.get(c) : ++n === 1 ? { down: true } : h.accept()); render(<OrderResourceCommitments dealId={deal} />); await open(); click(book); await screen.findByText('Ответ не получен. Проверьте результат тем же запросом.'); expect(writes(calls)).toHaveLength(1); expect(screen.queryByRole('button', { name: book })).toBeNull(); click(retry); await screen.findByText('Запрос обработан. Показана актуальная бронь.'); expect(writes(calls)).toHaveLength(2); expect(writes(calls)[1]?.body).toEqual(writes(calls)[0]?.body); expect(writes(calls)[1]?.headers.get('Idempotency-Key')).toBe(writes(calls)[0]?.headers.get('Idempotency-Key'))
  })
  it('ignores an obsolete replay response and displays only freshly read commitment', async () => { const h = harness(); const calls = serve(c => { if (c.method === 'GET') return h.get(c); h.accept(); return { body: { revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' } } }); render(<OrderResourceCommitments dealId={deal} />); await open(); click(book); await screen.findByText('Запрос обработан. Показана актуальная бронь.'); expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(writes(calls)).toHaveLength(1) })
  it('conflict does not conceal or release the prior promise', async () => { const h = harness(); prior(h); const calls = serve(c => c.method === 'GET' ? h.get(c) : { status: 409, body: { error: { code: 'capacity_conflict', message: 'internal private identity' } } }); render(<OrderResourceCommitments dealId={deal} />); await open(); click(replace); await screen.findByText('Бронь не изменена. Проверьте актуальный план и согласование условий.'); expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(screen.getByText('Редакция брони: 4')).toBeTruthy(); expect(document.body.textContent).not.toContain('internal private identity'); expect(writes(calls)).toHaveLength(1) })
  it('hides an unconfirmed outcome when fresh reading fails after a successful command', async () => { const h = harness(); let posted = false; serve(c => { if (c.method !== 'GET') { posted = true; return h.accept() } return posted ? { down: true } : h.get(c) }); render(<OrderResourceCommitments dealId={deal} />); await open(); click(book); await screen.findByText('Запрос обработан, но актуальная бронь не подтверждена. Обновите сведения.'); expect(screen.queryByText('Ресурсы зарезервированы')).toBeNull(); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull(); expect(screen.queryByRole('button', { name: retry })).toBeNull() })
  it('public policy 404 blocks action while preserving an authorized existing promise', async () => { const h = harness(); prior(h); serve(c => c.path.endsWith('/booking-policy') ? { status: 404 } : h.get(c)); render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(screen.queryByRole('button', { name: replace })).toBeNull() })
  it.each(['invalid', 'unavailable'] as const)('preserves a previous reserved promise when the new plan source is %s', async source => { const h = harness(); prior(h); h.state.plan.source = source; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(screen.queryByRole('button', { name: replace })).toBeNull() })
  it.each([401, 403, 410])('policy HTTP %s closes private data instead of falling back', async status => { const h = harness(); prior(h); serve(c => c.path.endsWith('/booking-policy') ? { status } : h.get(c)); render(<OrderResourceCommitments dealId={deal} />); fireEvent.click(screen.getByText('Бронь ресурсов заказа')); await screen.findByRole('alert'); expect(screen.queryByText('Ресурсы зарезервированы')).toBeNull() })
  it.each([401, 403, 404, 410])('private HTTP %s closes the reader and late parallel replies cannot restore it', async status => { const h = harness(), slow = deferred(); serve(c => c.path.endsWith('/resource-commitments') ? slow.promise : c.path.endsWith('/terms') ? { status } : h.get(c)); render(<OrderResourceCommitments dealId={deal} />); fireEvent.click(screen.getByText('Бронь ресурсов заказа')); await screen.findByRole('alert'); await act(async () => slow.resolve({ body: h.state.commitment })); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull(); expect(screen.queryByRole('button', { name: refresh })).toBeNull() })
  it('logout during an uncertain mutation destroys the retry and ignores its late response', async () => { const h = harness(), slow = deferred(); const calls = serve(c => c.method === 'GET' ? h.get(c) : slow.promise); render(<OrderResourceCommitments dealId={deal} />); await open(); click(book); await act(async () => saveTokens(null)); await screen.findByRole('alert'); await act(async () => slow.resolve({ down: true })); expect(screen.queryByRole('button', { name: retry })).toBeNull(); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull(); expect(writes(calls)).toHaveLength(1) })
  it('switching deals discards old pending loads and keeps the new deal collapsed', async () => { const h = harness(), slow = deferred(); serve(c => c.path.endsWith('/resource-commitments') ? slow.promise : h.get(c)); const view = render(<OrderResourceCommitments dealId={deal} />); fireEvent.click(screen.getByText('Бронь ресурсов заказа')); view.rerender(<OrderResourceCommitments dealId={id(99)} />); await act(async () => slow.resolve({ body: h.state.commitment })); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull(); expect(document.querySelector('details')?.open).toBe(false) })
  it('does not start further reads after a logout while the first scope read is pending', async () => { const h = harness(), slow = deferred(); const calls = serve(c => c.path.endsWith('/resource-commitments') ? slow.promise : h.get(c)); render(<OrderResourceCommitments dealId={deal} />); fireEvent.click(screen.getByText('Бронь ресурсов заказа')); await waitFor(() => expect(calls).toHaveLength(5)); await act(async () => saveTokens(null)); await act(async () => slow.resolve({ body: h.state.commitment })); expect(calls).toHaveLength(5); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull() })
  it('rejects a private projection accidentally returned to an ordinary couple', async () => { const h = harness(); h.state.plan.editorLines = []; render(<OrderResourceCommitments dealId={deal} />); fireEvent.click(screen.getByText('Бронь ресурсов заказа')); await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: book })).toBeNull() })
  it.each(['extra_field', 'missing_field', 'wrong_reservation', 'unknown_state', 'unscoped_pointer', 'wrong_revision'] as const)('rejects malformed commitment %s rather than inventing truth', async bad => { const h = harness(), c = h.state.commitment as unknown as Record<string, unknown>; if (bad === 'extra_field') c.personUserId = id(999); if (bad === 'missing_field') delete c.termsId; if (bad === 'wrong_reservation') c.reservation = 'reserved'; if (bad === 'unknown_state') c.state = 'available'; if (bad === 'unscoped_pointer') c.planRevisionId = planId; if (bad === 'wrong_revision') c.revision = '1'; render(<OrderResourceCommitments dealId={deal} />); await open(); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull(); expect(screen.queryByRole('button', { name: book })).toBeNull(); expect(document.body.textContent).not.toContain(id(999)) })
  it('server role change while refreshing closes previously loaded private authority', async () => { const h = harness(); render(<OrderResourceCommitments dealId={deal} />); await open(); h.state.catalog.actorRole = 'vendor'; click(refresh); await screen.findByRole('alert'); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull() })
  it('refreshes the parent financial card once only after an authoritative success', async () => { const h = harness(), changed = vi.fn(); render(<OrderResourceCommitments dealId={deal} onChanged={changed} />); await open(); expect(changed).not.toHaveBeenCalled(); click(book); await screen.findByText('Запрос обработан. Показана актуальная бронь.'); expect(changed).toHaveBeenCalledTimes(1); click(refresh); await waitFor(() => expect(screen.queryByText('Проверяем актуальную бронь…')).toBeNull()); expect(changed).toHaveBeenCalledTimes(1); expect(writes(h.calls)).toHaveLength(1) })
  it.each(['409', 'unconfirmed', 'privacy'] as const)('does not refresh the parent after %s', async failure => { const h = harness(), changed = vi.fn(); let posted = false; serve(c => { if (c.method !== 'GET') { posted = true; return failure === '409' ? { status: 409 } : h.accept() } return posted && failure !== '409' ? failure === 'privacy' ? { status: 403 } : { down: true } : h.get(c) }); render(<OrderResourceCommitments dealId={deal} onChanged={changed} />); await open(); click(book); if (failure === 'privacy') await screen.findByRole('alert'); else await screen.findByText(failure === '409' ? 'Бронь не изменена. Проверьте актуальный план и согласование условий.' : 'Запрос обработан, но актуальная бронь не подтверждена. Обновите сведения.'); expect(changed).not.toHaveBeenCalled() })
  it.each(['throw', 'reject'] as const)('contains a parent callback %s without falsifying the confirmed operation', async failure => { const h = harness(), changed = vi.fn(() => { if (failure === 'throw') throw new Error('parent reader failed'); return Promise.reject(new Error('parent reader failed')) }); render(<OrderResourceCommitments dealId={deal} onChanged={changed} />); await open(); click(book); await screen.findByText('Запрос обработан. Показана актуальная бронь.'); expect(changed).toHaveBeenCalledTimes(1); expect(screen.getByText('Ресурсы зарезервированы')).toBeTruthy(); expect(screen.queryByRole('button', { name: retry })).toBeNull(); expect(writes(h.calls)).toHaveLength(1) })
  it('uses wrapping controls at a 320px container in RU and EN without introducing mandatory actions', async () => { const h = harness(); prior(h); const view = render(<div style={{ width: 320 }}><OrderResourceCommitments dealId={deal} /></div>); await open(); expect(screen.getByRole('button', { name: replace }).className).toContain('whitespace-normal'); expect(document.querySelector('details')?.className).toContain('min-w-0'); setI18nLang('en'); view.rerender(<div style={{ width: 320 }}><OrderResourceCommitments dealId={deal} /></div>); expect(screen.getByRole('button', { name: t(replace) }).className).toContain('break-words'); expect(writes(h.calls)).toHaveLength(0) })
})
