import { randomUUID } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderTerms } from './OrderTerms'
import type { OrderCatalog, OrderTermsView, PublishedOrderTerms, WeddingOrder } from '@/lib/api/orders'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang, t } from '@/lib/i18n'

const DEAL = randomUUID(), WEDDING = randomUUID(), SLOT = randomUUID(), MAIN = randomUUID(), ASSIGN = randomUUID(), TERM = randomUUID(), USER = randomUUID(), SESSION = randomUUID()
type Call = { path: string; method: string; body: Record<string, unknown> | null; headers: Headers }
type Reply = { body?: unknown; status?: number; down?: boolean }
const token = (sub = USER, sid = SESSION, suffix = 'first') => `header.${btoa(JSON.stringify({ sub, sid }))}.${suffix}`
const freshOrder = (): WeddingOrder => ({ dealId: DEAL, schemaVersion: 1, version: '7', source: 'structured', brief: null, parts: [], assignments: [] })
const freshCatalog = (): OrderCatalog => ({ weddingId: WEDDING, primarySlotId: SLOT, actorRole: 'couple', draftEditable: true, timeZone: 'Asia/Yekaterinburg', assignmentTimeZones: [], eligiblePositions: [], executionKinds: ['timed_service', 'supply', 'rental', 'deliverable', 'appointment'],
  category: { categoryId: 'photo', label: 'Фотограф', autoAssign: false, suggestedKinds: ['timed_service', 'deliverable'], fields: [
    { key: 'photographer', label: 'Имя фотографа', type: 'string', group: 'core', maxLength: 200 },
    { key: 'helpers', label: 'Количество помощников', type: 'integer', group: 'optional', min: 0, max: 10 },
    { key: 'prints', label: 'Нужна печать', type: 'boolean', group: 'optional' },
    { key: 'shots', label: 'Важные кадры', type: 'string_array', group: 'optional', maxItems: 10, maxLength: 200 },
    { key: 'meetingDate', label: 'Дата встречи', type: 'date', group: 'optional' },
  ] } })
const snapshot = (): Record<string, unknown> => ({ schemaVersion: 1, weddingId: WEDDING, dealId: DEAL, categoryId: 'photo', source: 'legacy', sourceOrderVersion: '3', legacyContext: { mainEvent: { id: MAIN, name: 'Свадебный день', date: '2027-06-14', timeZone: 'Europe/Moscow', location: 'Сохранённый зал' } },
  brief: { categoryId: 'photo', values: { photographer: 'Мария из сохранённой редакции', helpers: 0, prints: false, shots: ['Церемония', 'Первый танец'], meetingDate: '2027-06-13' } },
  assignments: [{ id: ASSIGN, slotId: SLOT, version: '2', source: 'structured', label: 'Утренняя съёмка', event: { id: MAIN, name: 'Церемония', kind: 'ceremony', date: '2027-06-14', timeZone: 'Europe/Moscow', location: 'Сохранённый парк' } }], parts: [],
  economics: { amount: '9007199254740993', amountKnown: true, currency: 'RUB', performer: { vendor: { id: randomUUID(), userId: randomUUID(), name: 'Сохранённая студия', categoryId: 'photo' }, externalName: null, externalPhone: null }, package: { id: randomUUID(), titleSnapshot: 'Сохранённый пакет', includesSnapshot: ['Галерея из сохранённого пакета'] } } })
const term = (): PublishedOrderTerms => ({ id: TERM, version: '2', sourceOrderVersion: '3', sourceFingerprint: 'a'.repeat(64), digest: 'a'.repeat(64), publishedBy: USER, publishedSide: 'customer', publishedAt: '2026-09-30T10:20:30Z', freshness: 'current', receipts: [], acceptedByCaller: false, snapshot: snapshot() })
function terms(selected = term()): OrderTermsView { return { revision: '2', proposedTermsId: selected.id, agreedTermsId: null, history: [selected], selected, readToken: 'proof-current-user-session', acceptedByCaller: selected.acceptedByCaller } }
const part = (kind: string, details: Record<string, unknown> = {}) => {
  const names: Record<string, string[]> = { timed_service: ['startsAt', 'endsAt', 'location', 'setupMinutes', 'teardownMinutes', 'travelMinutes'], appointment: ['startsAt', 'endsAt', 'location', 'setupMinutes', 'teardownMinutes', 'travelMinutes'], supply: ['quantity', 'unit', 'windowStartsAt', 'windowEndsAt', 'location', 'recipient', 'substitutions'], rental: ['quantity', 'unit', 'handoverAt', 'returnAt', 'location', 'recipient', 'condition', 'depositTerms'], deliverable: ['items', 'dueAt', 'recipient', 'reviewProcess'] }
  return { id: randomUUID(), kind, version: '5', source: 'structured', title: `Сохранённая работа ${kind}`, assignmentId: kind === 'deliverable' ? null : ASSIGN, details: { ...Object.fromEntries((Object.hasOwn(names, kind) ? names[kind] : []).map(name => [name, null])), ...details } }
}
function serve(handler: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, headers: new Headers(init?.headers) }; calls.push(call)
    const reply = await handler(call); if (reply.down) throw new TypeError('Network response lost')
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function harness(initial = terms(), handler?: (call: Call) => Reply | Promise<Reply>) {
  const state = { order: freshOrder(), catalog: freshCatalog(), terms: initial }
  const calls = serve(call => {
    if (handler && call.method !== 'GET') return handler(call)
    if (call.path.endsWith('/catalog')) return { body: state.catalog }
    if (call.path.endsWith('/order')) return { body: state.order }
    const wanted = new URL(call.path, 'http://local').searchParams.get('termsId')
    if (wanted) { const selected = state.terms.history.find(t => t.id === wanted)!; return { body: { ...state.terms, selected, acceptedByCaller: selected.acceptedByCaller, readToken: wanted === state.terms.proposedTermsId ? state.terms.readToken : null } } }
    return { body: state.terms }
  })
  return { state, calls }
}
function deferred() { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(r => { resolve = r }); return { promise, resolve } }
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET')
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const view = (dealId = DEAL) => <OrderTerms dealId={dealId} />
async function open() { fireEvent.click(screen.getByText('Согласование условий')); await screen.findByText('Предложенная редакция', { exact: false }) }
async function details() { fireEvent.click(screen.getByText('Подробности сохранённой редакции')); await waitFor(() => expect((screen.getByLabelText('Я ознакомился с этой редакцией и хочу принять её условия') as HTMLInputElement).disabled).toBe(false)) }
async function approve() { await details(); fireEvent.click(screen.getByLabelText('Я ознакомился с этой редакцией и хочу принять её условия')); click('Принять эту редакцию') }
function displayed(label: string) { const node = screen.getAllByText(label, { exact: true }).find(n => n.tagName === 'DT'); if (!node) throw new Error(`Missing fact ${label}`); return node.parentElement!.querySelector('dd')!.textContent }
const rejection = (status = 403, code = 'forbidden'): Reply => ({ status, body: { error: { code, message: 'Доступ к условиям закрыт' } } })
beforeEach(() => { localStorage.clear(); saveTokens({ accessToken: token(), refreshToken: 'refresh' }); setI18nLang('ru') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

function resourceTerms(kind: 'capacity' | 'person' | 'equipment' = 'capacity') {
  const v = terms(), p = part('supply', { quantity: 20, unit: 'букеты', windowStartsAt: '2027-06-14T07:00:00Z', windowEndsAt: '2027-06-14T08:00:00Z' })
  v.selected!.snapshot.schemaVersion = 2; v.selected!.snapshot.parts = [p]
  v.selected!.snapshot.resourcePlan = { planRevisionId: randomUUID(), revision: '4', lines: [{
    partId: p.id, assignmentId: ASSIGN, programEventId: MAIN, label: 'Производство накануне', kind, quantity: kind === 'capacity' ? 20 : 1, unit: kind === 'capacity' ? 'букеты' : null,
    startsAt: '2027-06-13T07:00:00.000Z', endsAt: '2027-06-13T08:00:00.000Z', timeZone: 'Asia/Yekaterinburg', setupMinutes: 10, teardownMinutes: 20, travelBeforeMinutes: 30, travelAfterMinutes: 40,
    occupiedStartsAt: '2027-06-13T06:20:00.000Z', occupiedEndsAt: '2027-06-13T09:00:00.000Z', window: kind === 'capacity' ? { startsAt: '2027-06-13T06:00:00.000Z', endsAt: '2027-06-13T10:00:00.000Z' } : null,
  }] }
  return v
}
function resourceLine(v: OrderTermsView): Record<string, unknown> { return (v.selected!.snapshot.resourcePlan as { lines: Record<string, unknown>[] }).lines[0]! }

describe('exact schema2 resource promises in the frozen terms reader', () => {
  it.each(['capacity', 'person', 'equipment'] as const)('shows all material %s facts before explicit acceptance with no booking request', async kind => {
    const v = resourceTerms(kind), h = harness(v); render(view()); await open(); await details()
    expect(displayed('Редакция плана ресурсов')).toBe('4')
    expect(displayed('Вид ресурса')).toBe(kind === 'capacity' ? 'Производственная мощность' : kind === 'person' ? 'Человек' : 'Оборудование')
    expect(displayed('Дорога до работы, минут')).toBe('30'); expect(displayed('Дорога после работы, минут')).toBe('40')
    expect(displayed('Занятость от')).toContain('11:20'); expect(displayed('Занятость до')).toContain('14:00')
    if (kind === 'capacity') { expect(displayed('Окно мощности от')).toContain('11:00'); expect(displayed('Окно мощности до')).toContain('15:00') }
    expect(screen.getByText('План ресурсов не является резервом. Занятость проверяется отдельно.')).toBeTruthy()
    const privateId = (v.selected!.snapshot.resourcePlan as { planRevisionId: string }).planRevisionId
    expect(document.body.textContent).not.toContain(privateId)
    fireEvent.click(screen.getByLabelText('Я ознакомился с этой редакцией и хочу принять её условия')); click('Принять эту редакцию')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writes(h.calls)[0].path).toBe(`/deals/${DEAL}/order/terms/${TERM}/accept`)
    expect(writes(h.calls)[0].body).toMatchObject({ expectedTermsVersion: '2', digest: v.selected!.digest })
  })
  it('supports unassigned result processing without manufacturing an event or missing time', async () => {
    const v = resourceTerms('person'), p = part('deliverable', { dueAt: '2027-07-01T10:00:00Z' }); v.selected!.snapshot.parts = [p]
    Object.assign(resourceLine(v), { partId: p.id, assignmentId: null, programEventId: null })
    harness(v); render(view()); await open(); await details(); expect(screen.getAllByText('Без назначения на мероприятие').length).toBeGreaterThan(0)
    expect(screen.getByText('Сохранённая работа deliverable · Производство накануне')).toBeTruthy()
  })
  const invalidResources: [string, (line: Record<string, unknown>) => void][] = [
    ['private account', r => { r.personUserId = randomUUID() }], ['private resource', r => { r.resourceId = randomUUID() }],
    ['private identity', r => { r.conflictIdentity = randomUUID() }], ['private membership', r => { r.staffMemberId = randomUUID() }], ['private window', r => { r.capacityWindowId = randomUUID() }],
    ['foreign part', r => { r.partId = randomUUID() }], ['foreign event', r => { r.programEventId = randomUUID() }], ['foreign assignment', r => { r.assignmentId = randomUUID() }],
    ['missing road buffer', r => { delete r.travelBeforeMinutes }], ['negative road buffer', r => { r.travelAfterMinutes = -1 }], ['hidden occupied span', r => { r.occupiedStartsAt = '2027-06-13T06:00:00.000Z' }],
    ['short capacity window', r => { r.window = { startsAt: '2027-06-13T07:00:00.000Z', endsAt: '2027-06-13T08:00:00.000Z' } }],
    ['missing capacity unit', r => { r.unit = null }], ['missing capacity window', r => { r.window = null }], ['bad timezone', r => { r.timeZone = 'Unknown/Place' }],
    ['fractional quantity', r => { r.quantity = 1.5 }], ['unknown kind', r => { r.kind = 'crew' }], ['individual quantity', r => { r.kind = 'person'; r.quantity = 2; r.unit = null; r.window = null }],
  ]
  it.each(invalidResources)('blocks acceptance for %s rather than silently omitting it', async (_name, corrupt) => {
    const v = resourceTerms(); corrupt(resourceLine(v)); const h = harness(v); render(view()); await open()
    await screen.findByText('Эту редакцию нельзя полностью показать. Принятие недоступно.')
    expect(screen.queryByLabelText('Я ознакомился с этой редакцией и хочу принять её условия')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull()
    expect(writes(h.calls)).toHaveLength(0)
  })
  it('shows explicit clearing as an empty immutable plan instead of a fictitious reservation', async () => {
    const v = resourceTerms(); (v.selected!.snapshot.resourcePlan as { lines: unknown[] }).lines = []
    harness(v); render(view()); await open(); await details(); expect(screen.getByText('Ресурсы не указаны')).toBeTruthy()
    expect(displayed('Редакция плана ресурсов')).toBe('4')
  })
})

describe('optional frozen conditions reader through the actual API client', () => {
  it('stays collapsed without requests, has no polling and opens only order-scoped endpoints', async () => {
    const h = harness(); render(view()); await act(async () => {}); expect(h.calls).toHaveLength(0)
    await open(); expect(h.calls.map(c => c.path).sort()).toEqual([`/deals/${DEAL}/order`, `/deals/${DEAL}/order/catalog`, `/deals/${DEAL}/order/terms`])
    await act(async () => new Promise(r => setTimeout(r, 20))); expect(h.calls).toHaveLength(3)
    expect(screen.getByText('Подробности сохранённой редакции').closest('details')?.open).toBe(false)
  })
  it('keeps loading honest and retries failed GET without invented defaults', async () => {
    let down = true; const calls = serve(c => down ? { down: true } : { body: c.path.endsWith('/catalog') ? freshCatalog() : c.path.endsWith('/order') ? freshOrder() : terms() })
    render(view()); fireEvent.click(screen.getByText('Согласование условий')); await screen.findByRole('alert'); expect(screen.queryByText('Условия ещё не опубликованы')).toBeNull()
    down = false; click('Повторить'); await screen.findByText('Подробности сохранённой редакции'); expect(calls).toHaveLength(6)
  })
  it.each([403, 404, 410])('opening refusal %s hides private snapshots and offers no blind retry', async status => {
    serve(() => rejection(status)); render(view()); fireEvent.click(screen.getByText('Согласование условий')); await screen.findByText('Доступ к условиям закрыт')
    expect(screen.queryByText('Сохранённый пакет')).toBeNull(); expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull()
  })
  it('shows frozen package/performer/brief and never substitutes current draft or live catalog facts', async () => {
    const h = harness(); h.state.order.brief = { categoryId: 'photo', values: { photographer: 'Другой текущий фотограф' } }; render(view()); await open(); await details()
    expect(displayed('Исполнитель')).toBe('Сохранённая студия'); expect(displayed('Пакет этой редакции')).toBe('Сохранённый пакет'); expect(displayed('Имя фотографа')).toBe('Мария из сохранённой редакции')
    expect(displayed('Количество помощников')).toBe('0'); expect(displayed('Нужна печать')).toBe('Нет'); expect(displayed('Важные кадры')).toContain('Первый танец')
    expect(displayed('Дата встречи')).toContain('13 июня 2027'); expect(screen.queryByText('Другой текущий фотограф')).toBeNull()
    expect(document.body.textContent).not.toContain(DEAL); expect(document.body.textContent).not.toContain('2027-06-14T')
  })
  it.each([['9007199254740993', '90\u00a0071\u00a0992\u00a0547\u00a0409,93'], ['0', '0,00']])('formats exact minor-unit amount %s without Number precision loss', async (amount, expected) => {
    const v = terms(); (v.selected!.snapshot.economics as Record<string, unknown>).amount = amount
    harness(v); render(view()); await open(); await details(); expect(displayed('Цена этой редакции')).toContain(expected)
  })
  it('keeps null amount/package/manual facts unknown rather than zero or invented obligation', async () => {
    const v = terms(), s = v.selected!.snapshot, e = s.economics as Record<string, unknown>; e.amount = null; e.amountKnown = false; e.package = { id: null, titleSnapshot: null, includesSnapshot: null }; s.brief = null; s.assignments = []; s.parts = []; s.legacyContext = { mainEvent: null }
    harness(v); render(view()); await open(); await details(); expect(displayed('Цена этой редакции')).toBe('Не указано'); expect(displayed('Пакет этой редакции')).toBe('Не указано')
    expect(screen.getByText('Пожелания не описаны')).toBeTruthy(); expect(screen.getByText('Мероприятия не описаны')).toBeTruthy(); expect(screen.getByText('Работы не описаны')).toBeTruthy()
  })
  const badSnapshots: [string, (s: Record<string, unknown>) => void][] = [
    ['future schema', s => { s.schemaVersion = 3 }], ['schema2 without resource plan', s => { s.schemaVersion = 2 }], ['foreign deal', s => { s.dealId = randomUUID() }], ['foreign wedding', s => { s.weddingId = randomUUID() }],
    ['missing economics', s => { delete s.economics }], ['unknown economics field', s => { (s.economics as Record<string, unknown>).discount = 10 }],
    ['numeric unsafe money', s => { (s.economics as Record<string, unknown>).amount = Number('9007199254740993') }], ['unknown category', s => { s.categoryId = 'florist' }],
    ['unlabelled brief field', s => { s.brief = { categoryId: 'photo', values: { secretUnsupportedObligation: true } } }], ['unknown subtype', s => { s.brief = { categoryId: 'photo', subtypeId: 'made-up', values: {} } }],
    ['package object', s => { ((s.economics as Record<string, unknown>).package as Record<string, unknown>).includesSnapshot = [{ obligation: 'Hidden work' }] }],
    ['missing part field', s => { const p = part('supply'); delete p.details.quantity; s.parts = [p] }], ['invalid interval', s => { s.parts = [part('timed_service', { startsAt: '2027-06-14T12:00:00Z', endsAt: '2027-06-14T11:00:00Z' })] }],
    ['prototype kind', s => { s.parts = [part('__proto__')] }], ['unscoped part', s => { s.parts = [{ ...part('rental'), assignmentId: randomUUID() }] }],
    ['invalid date', s => { ((s.legacyContext as Record<string, unknown>).mainEvent as Record<string, unknown>).date = '2027-02-30' }], ['invalid time zone', s => { ((s.legacyContext as Record<string, unknown>).mainEvent as Record<string, unknown>).timeZone = 'Made/Up' }],
  ]
  it.each(badSnapshots)('fails closed for %s without hiding material facts behind an acceptance control', async (_name, change) => {
    const v = terms(); change(v.selected!.snapshot); const h = harness(v); render(view()); await open(); await screen.findByText('Эту редакцию нельзя полностью показать. Принятие недоступно.')
    expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull(); expect(writes(h.calls)).toHaveLength(0)
  })
  it.each(['timed_service', 'appointment', 'supply', 'rental', 'deliverable'])('presents all %s fields including explicit nulls and manual text', async kind => {
    const v = terms(); v.selected!.snapshot.parts = [part(kind, kind === 'supply' ? { quantity: 12, unit: 'букетов', substitutions: 'Только белые розы', recipient: 'Ирина' } : kind === 'rental' ? { quantity: 2, unit: 'стола', condition: 'Без царапин', depositTerms: 'Ручное условие о залоге', recipient: 'Координатор' } : kind === 'deliverable' ? { items: ['100 фотографий'], recipient: 'Пара', reviewProcess: 'Проверка галереи' } : { startsAt: '2027-06-14T09:30:00Z', endsAt: '2027-06-14T11:30:00Z', setupMinutes: 0, teardownMinutes: 30, travelMinutes: 45, location: 'Сохранённая точка' })]
    harness(v); render(view()); await open(); await details(); expect(screen.getByText(`Сохранённая работа ${kind}`)).toBeTruthy()
    if (kind === 'supply') { expect(displayed('Допустимые замены')).toBe('Только белые розы'); expect(displayed('Количество')).toBe('12'); expect(displayed('Доставка от')).toBe('Не указано') }
    else if (kind === 'rental') { expect(displayed('Описание состояния')).toBe('Без царапин'); expect(displayed('Пожелания по залогу')).toBe('Ручное условие о залоге'); expect(displayed('Возврат')).toBe('Не указано') }
    else if (kind === 'deliverable') { expect(displayed('Что передать')).toBe('100 фотографий'); expect(displayed('Как проверить результат')).toBe('Проверка галереи') }
    else { expect(displayed('Начало')).toContain('12:30:00'); expect(displayed('Подготовка, минут')).toBe('0'); expect(displayed('Демонтаж, минут')).toBe('30'); expect(displayed('Дорога, минут')).toBe('45') }
  })
  it('uses subtype labels only for matching category/fields and retains explicit unknowns', async () => {
    const v = terms(), s = v.selected!.snapshot; s.categoryId = 'florist'; s.brief = { categoryId: 'florist', subtypeId: 'shop', values: { stems: 12, recipient: null } }; ((s.economics as Record<string, unknown>).performer as Record<string, unknown>).vendor = null
    const h = harness(v); h.state.catalog.category = { categoryId: 'florist', label: 'Флорист', autoAssign: false, suggestedKinds: ['supply'], fields: [], subtypes: [{ id: 'shop', label: 'Магазин цветов', suggestedKinds: ['supply'], fields: [{ key: 'stems', label: 'Число цветов', type: 'integer', group: 'core', min: 1 }, { key: 'recipient', label: 'Получатель цветов', type: 'string', group: 'core' }] }] }
    render(view()); await open(); await details(); expect(displayed('Вариант услуги')).toBe('Магазин цветов'); expect(displayed('Число цветов')).toBe('12'); expect(displayed('Получатель цветов')).toBe('Не указано')
  })
  it('subtype definitions replace the generic brief; incompatible generic field cannot be silently accepted', async () => {
    const v = terms(); v.selected!.snapshot.brief = { categoryId: 'photo', subtypeId: 'album', values: { photographer: 'Incompatible generic promise' } }
    const h = harness(v); h.state.catalog.category.subtypes = [{ id: 'album', label: 'Альбом', suggestedKinds: ['deliverable'], fields: [{ key: 'pages', label: 'Страницы альбома', type: 'integer', group: 'core', min: 1 }] }]
    render(view()); await open(); await screen.findByText('Эту редакцию нельзя полностью показать. Принятие недоступно.'); expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull()
  })
  it('unknown assignment zone stays unknown and uses explicit UTC rather than main/current/viewer zone', async () => {
    const v = terms(); const assignments = v.selected!.snapshot.assignments as { event: Record<string, unknown> }[]; assignments[0].event.timeZone = null
    v.selected!.snapshot.parts = [part('appointment', { startsAt: '2027-06-14T09:30:00Z' })]; harness(v); render(view()); await open(); await details()
    expect(displayed('Начало')).toContain('09:30:00'); expect(displayed('Начало')).toContain('Часовой пояс мероприятия не указан; показано UTC'); expect(displayed('Начало')).not.toContain('12:30:00')
  })
  it('renders both saved occurrences of a DST repeated hour with distinct offsets', async () => {
    const v = terms(); (v.selected!.snapshot.assignments as { event: Record<string, unknown> }[])[0].event.timeZone = 'Europe/Berlin'
    v.selected!.snapshot.parts = [part('timed_service', { startsAt: '2027-10-31T00:30:00Z', endsAt: '2027-10-31T01:30:00Z' })]; harness(v); render(view()); await open(); await details()
    expect(displayed('Начало')).toContain('02:30:00'); expect(displayed('Окончание')).toContain('02:30:00'); expect(displayed('Начало')).toContain('GMT+2'); expect(displayed('Окончание')).toContain('GMT+1')
  })
  it('preserves a saved fractional second and offset without showing a raw ISO instant', async () => {
    const v = terms(); v.selected!.snapshot.parts = [part('deliverable', { dueAt: '2027-06-14T09:10:37.123Z' })]; harness(v); render(view()); await open(); await details()
    expect(displayed('Срок передачи')).toContain('12:10:37,123'); expect(displayed('Срок передачи')).not.toContain('2027-06-14T')
  })
  it('requires opening full facts AND explicit checkbox, submits current GET proof once and stores no proof offline', async () => {
    const h = harness(terms(), () => ({ body: { ...h.state.terms, readToken: null } })); const local = vi.spyOn(Storage.prototype, 'setItem'); render(view()); await open()
    expect((screen.getByRole('button', { name: 'Принять эту редакцию' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Я ознакомился с этой редакцией и хочу принять её условия') as HTMLInputElement).disabled).toBe(true)
    await approve(); await screen.findByText('Ответ сохранён. Показана актуальная редакция условий.')
    const written = writes(h.calls); expect(written).toHaveLength(1); expect(written[0].path).toBe(`/deals/${DEAL}/order/terms/${TERM}/accept`)
    expect(written[0].body).toEqual({ expectedTermsVersion: '2', digest: 'a'.repeat(64), readToken: 'proof-current-user-session' }); expect(written[0].headers.get('idempotency-key')).toBeTruthy()
    expect(local.mock.calls.some(args => JSON.stringify(args).includes('proof-current-user-session'))).toBe(false); expect(sessionStorage.length).toBe(0)
    expect((screen.getByLabelText('Я ознакомился с этой редакцией и хочу принять её условия') as HTMLInputElement).checked).toBe(false)
  })
  it('keeps actual side/time attribution, deleted author and other-partner consent distinct from personal acceptance', async () => {
    const v = terms(); v.selected!.receipts = [{ id: randomUUID(), party: 'customer', userId: null, sessionId: null, digest: v.selected!.digest, acceptedAt: '2026-09-30T11:22:33Z' }]
    harness(v); render(view()); await open(); expect(screen.getByText(/Принято со стороны пары/).textContent).toContain('14:22:33'); expect(screen.getByText(/Аккаунт автора удалён/)).toBeTruthy()
    expect(screen.getByText('Ответ вашей стороны уже записан другим участником')).toBeTruthy(); expect(screen.queryByText('Ваше принятие этой редакции записано')).toBeNull(); expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull()
  })
  it('vendor uses only deal endpoints and can accept its own side without wedding-private requests', async () => {
    const h = harness(); h.state.catalog.actorRole = 'vendor'; render(view()); await open(); await details()
    expect(h.calls.every(c => c.path.startsWith('/deals/'))).toBe(true); expect(screen.getByRole('button', { name: 'Принять эту редакцию' })).toBeTruthy()
  })
  it('history selection never borrows current proof or old consent for another proposal', async () => {
    const current = term(), old = { ...term(), id: randomUUID(), version: '1', freshness: 'stale' as const, acceptedByCaller: true, receipts: [{ id: randomUUID(), party: 'customer' as const, userId: USER, sessionId: SESSION, digest: 'a'.repeat(64), acceptedAt: '2026-09-30T11:00:00Z' }] }
    const v = terms(current); v.history.push(old); v.agreedTermsId = old.id; const h = harness(v); render(view()); await open()
    fireEvent.change(screen.getByLabelText('Редакция для просмотра'), { target: { value: old.id } }); await screen.findByText('Ваше принятие этой редакции записано')
    expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull(); expect(h.calls.some(c => c.path.endsWith(`?termsId=${old.id}`))).toBe(true)
    click('Открыть актуальные условия'); await screen.findByLabelText('Я ознакомился с этой редакцией и хочу принять её условия'); expect(screen.queryByText('Ваше принятие этой редакции записано')).toBeNull()
  })
  it.each(['stale', 'invalid', 'unavailable'] as const)('%s source exposes history but no acceptance', async freshness => {
    const v = terms(); v.selected!.freshness = freshness; v.readToken = null; const h = harness(v); render(view()); await open()
    expect(screen.getByRole('alert')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull(); expect(writes(h.calls)).toHaveLength(0)
  })
  it('cancelled draft remains readable while publication and acceptance are absent', async () => {
    const h = harness(); h.state.catalog.draftEditable = false; render(view()); await open()
    expect(screen.getByText(/Заказ закрыт для изменений/)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Предложить текущий состав заказа' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull()
  })
  it('publishes only actual root/revision and fetches a fresh current proposal before any acceptance', async () => {
    const v = terms(); v.history = []; v.selected = null; v.proposedTermsId = null; v.readToken = null; v.revision = '0'
    const h = harness(v, () => { h.state.terms = terms(); return { body: { ...h.state.terms, readToken: null } } }); render(view()); await open(); click('Предложить текущий состав заказа')
    await screen.findByText('Редакция опубликована. Откройте подробности и проверьте её.'); expect(writes(h.calls)[0].body).toEqual({ expectedOrderVersion: '7', expectedTermsRevision: '0' }); expect(h.calls.filter(c => c.method === 'GET')).toHaveLength(6)
    expect((screen.getByRole('button', { name: 'Принять эту редакцию' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it.each(['publish', 'accept'] as const)('%s uncertain response retains exact key/body across collapse; later intention uses a new key', async kind => {
    let attempt = 0; const h = harness(terms(), () => ++attempt === 1 ? { down: true } : { body: { ...h.state.terms, readToken: null } })
    render(view()); await open(); if (kind === 'publish') click('Предложить текущий состав заказа'); else await approve()
    await screen.findByRole('button', { name: 'Проверить результат запроса' }); const first = writes(h.calls)[0]
    fireEvent.click(screen.getByText('Согласование условий')); fireEvent.click(screen.getByText('Согласование условий')); click('Проверить результат запроса')
    await screen.findByText(kind === 'publish' ? 'Редакция опубликована. Откройте подробности и проверьте её.' : 'Ответ сохранён. Показана актуальная редакция условий.')
    expect(writes(h.calls)[1].body).toEqual(first.body); expect(writes(h.calls)[1].headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'))
    if (kind === 'publish') click('Предложить текущий состав заказа'); else await approve()
    await waitFor(() => expect(writes(h.calls)).toHaveLength(3)); expect(writes(h.calls)[2].headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'))
  })
  it('saved old mutation body is followed by latest current GET rather than displayed as current agreement', async () => {
    const old = terms(), h = harness(old, () => { const next = { ...term(), id: randomUUID(), version: '3', snapshot: { ...snapshot(), sourceOrderVersion: '3' } }; h.state.terms = terms(next); h.state.terms.revision = '3'; h.state.terms.readToken = 'new-proof'; return { body: { ...old, readToken: null } } })
    render(view()); await open(); click('Предложить текущий состав заказа'); await screen.findByText(/Редакция опубликована/)
    expect((screen.getByLabelText('Редакция для просмотра') as HTMLSelectElement).value).toBe(h.state.terms.selected!.id); expect(h.calls.filter(c => c.method === 'GET')).toHaveLength(6)
  })
  it('confirmed mutation followed by failed refresh permits only a GET retry, not replay of the already saved action', async () => {
    let written = false, readsDown = true
    const calls = serve(c => {
      if (c.method !== 'GET') { written = true; return { body: { ...terms(), readToken: null } } }
      if (written && readsDown) return { down: true }
      return { body: c.path.endsWith('/catalog') ? freshCatalog() : c.path.endsWith('/order') ? freshOrder() : terms() }
    })
    render(view()); await open(); click('Предложить текущий состав заказа'); await screen.findByText('Сервер недоступен. Попробуйте позже')
    expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить результат запроса' })).toBeNull()
    readsDown = false; click('Открыть актуальные условия'); await screen.findByLabelText('Я ознакомился с этой редакцией и хочу принять её условия'); expect(writes(calls)).toHaveLength(1)
  })
  it.each(['order_version_conflict', 'terms_read_expired'])('%s does not silently retry/accept; fresh read requires renewed details and checkbox', async code => {
    const h = harness(terms(), () => ({ status: 409, body: { error: { code, message: 'Обновите условия' } } })); render(view()); await open(); await approve()
    await screen.findByText('Условия нужно обновить и проверить заново перед новым действием.'); expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull(); expect(writes(h.calls)).toHaveLength(1)
    click('Открыть актуальные условия'); await screen.findByLabelText('Я ознакомился с этой редакцией и хочу принять её условия')
    expect((screen.getByLabelText('Я ознакомился с этой редакцией и хочу принять её условия') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Принять эту редакцию' }) as HTMLButtonElement).disabled).toBe(true); expect(writes(h.calls)).toHaveLength(1)
  })
  it.each([403, 404, 410])('write refusal %s wipes private snapshots, pending proof and replay', async status => {
    harness(terms(), () => rejection(status)); render(view()); await open(); await approve(); await screen.findByText('Доступ к условиям закрыт')
    expect(screen.queryByText('Сохранённый пакет')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить результат запроса' })).toBeNull(); expect(screen.queryByLabelText('Редакция для просмотра')).toBeNull()
  })
  it('role change during refresh hides previous role snapshots without reporting publication success', async () => {
    const h = harness(terms(), () => { h.state.catalog.actorRole = 'vendor'; return { body: { ...h.state.terms, readToken: null } } }); render(view()); await open(); click('Предложить текущий состав заказа')
    await screen.findByText('Доступ к заказу изменился. Откройте раздел заново.'); expect(screen.queryByText('Сохранённый пакет')).toBeNull(); expect(screen.queryByText(/Редакция опубликована/)).toBeNull()
  })
  it('session identity change/logout immediately destroys loaded private state and uncertain replay', async () => {
    const h = harness(terms(), () => ({ down: true })); render(view()); await open(); await approve(); await screen.findByRole('button', { name: 'Проверить результат запроса' })
    act(() => saveTokens(null)); await screen.findByText('Сессия изменилась — откройте заказ после входа заново')
    expect(screen.queryByText('Сохранённый пакет')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить результат запроса' })).toBeNull(); expect(writes(h.calls)).toHaveLength(1)
  })
  it('ordinary refresh of same subject/session retains reader; changed session discards it', async () => {
    harness(); render(view()); await open(); act(() => saveTokens({ accessToken: token(USER, SESSION, 'renewed'), refreshToken: 'new-refresh' }))
    expect(screen.getByText('Подробности сохранённой редакции')).toBeTruthy()
    act(() => saveTokens({ accessToken: token(USER, randomUUID()), refreshToken: 'other-session' })); await screen.findByText('Сессия изменилась — откройте заказ после входа заново')
  })
  it('late write after same-window account switch cannot restore private conditions or replay', async () => {
    const pending = deferred(), h = harness(terms(), () => pending.promise); render(view()); await open(); click('Предложить текущий состав заказа'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    act(() => saveTokens({ accessToken: token(randomUUID(), randomUUID()), refreshToken: 'another-user' })); await screen.findByText('Сессия изменилась — откройте заказ после входа заново')
    await act(async () => pending.resolve({ body: { ...terms(), readToken: null } })); expect(screen.queryByText('Сохранённый пакет')).toBeNull(); expect(h.calls.filter(c => c.method === 'GET')).toHaveLength(3)
  })
  it('late mutation from previous deal cannot repopulate a new private reader or issue old-deal refreshes', async () => {
    const pending = deferred(), nextDeal = randomUUID(), calls = serve(c => c.method !== 'GET' ? pending.promise : { body: c.path.endsWith('/catalog') ? freshCatalog() : c.path.endsWith('/order') ? { ...freshOrder(), dealId: c.path.includes(nextDeal) ? nextDeal : DEAL } : (() => { const v = terms(); v.selected!.snapshot.dealId = c.path.includes(nextDeal) ? nextDeal : DEAL; return v })() })
    const rendered = render(view()); await open(); click('Предложить текущий состав заказа'); await waitFor(() => expect(writes(calls)).toHaveLength(1)); rendered.rerender(view(nextDeal)); await open()
    await act(async () => pending.resolve({ body: { ...terms(), readToken: null } })); expect(screen.queryByText(/Редакция опубликована/)).toBeNull(); expect(calls.filter(c => c.method === 'GET' && c.path.includes(DEAL))).toHaveLength(3)
  })
  it('has labelled native keyboard controls, wrapping layout and no JSON/UUID/ISO editor', async () => {
    harness(); const rendered = render(view()); await open(); await details()
    expect(rendered.container.querySelector('details')?.className).toContain('min-w-0'); expect(screen.getByLabelText('Редакция для просмотра')).toBeTruthy(); expect(screen.getByLabelText('Я ознакомился с этой редакцией и хочу принять её условия').id).toBeTruthy()
    expect(screen.queryByLabelText(/JSON|UUID|ISO/)).toBeNull(); expect(document.body.textContent).not.toContain('Юридическая подпись')
  })
})

describe('FR015 agreed-price availability explanation', () => {
  const protection = 'Цена по согласованным условиям защищена от прямой правки. Изменение цены через новые условия пока недоступно.'
  function agreedDisplay() {
    const selected = term()
    selected.receipts = [
      { id: randomUUID(), party: 'customer', userId: USER, sessionId: SESSION, digest: selected.digest, acceptedAt: '2026-09-30T11:00:00Z' },
      { id: randomUUID(), party: 'performer', userId: randomUUID(), sessionId: randomUUID(), digest: selected.digest, acceptedAt: '2026-09-30T11:01:00Z' },
    ]
    selected.acceptedByCaller = true
    const v = terms(selected)
    v.agreedTermsId = selected.id; v.acceptedByCaller = true; v.readToken = null
    return v
  }
  it.each([
    ['ru', protection],
    ['en', 'The agreed price is protected from direct edits. Changing the price through new terms is not available yet.'],
  ] as const)('FR015 %s names the actual price limitation without adding a price writer', async (lang, message) => {
    setI18nLang(lang)
    const h = harness(agreedDisplay()); render(view())
    fireEvent.click(screen.getByText(t('Согласование условий')))
    await screen.findByText(message)
    expect((screen.getByRole('button', { name: t('Предложить текущий состав заказа') }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: /изменить цену|change.*price/i })).toBeNull()
    expect(writes(h.calls)).toEqual([])
  })
  it('FR015 a new selected draft still explains the old agreed price protection', async () => {
    const current = term(), old = agreedDisplay().selected!
    old.id = randomUUID(); old.version = '1'; old.freshness = 'stale'
    const v = terms(current); v.history.push(old); v.agreedTermsId = old.id
    const h = harness(v); render(view()); await open()
    await screen.findByText(protection)
    expect(writes(h.calls)).toEqual([])
  })
  it('FR015 an unagreed proposal does not claim an agreed price lock', async () => {
    const h = harness(); render(view()); await open()
    expect(screen.queryByText(protection)).toBeNull(); expect(writes(h.calls)).toEqual([])
  })
})
