import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyCalendarBoundsHolder, LegacyCalendarBoundsOwner } from './LegacyCalendarBounds'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import type { CalendarBoundsView, CalendarSourceSummary } from '@/lib/api/legacy-calendar'

const wid = '10000000-0000-4000-8000-000000000001', deal = '20000000-0000-4000-8000-000000000001', sourceId = '30000000-0000-4000-8000-000000000001'
const vendor = '40000000-0000-4000-8000-000000000001', version = '50000000-0000-4000-8000-000000000001'
const own = `/weddings/${wid}/deals/${deal}/legacy-calendar`, owner = `/vendors/${vendor}/legacy-calendar/sources`
const source = (): CalendarSourceSummary => ({ sourceId, kind: 'app_day', originDate: '2027-06-14', sourceRevision: '4', inventoryRevision: '3', headRevision: '2', state: 'unresolved', freshness: 'current', scopeCompleteness: 'complete', holderCount: 2, proposedVersionId: version, effectiveVersionId: null, staffingCompleteness: 'declared_complete', conflicted: false, updatedAt: '2026-10-25T12:00:00Z' })
const view = (patch: Partial<CalendarBoundsView> = {}): CalendarBoundsView => ({ source: source(), actorRole: 'customer', acceptedByCaller: false, readToken: 'genuine-controlled-read-token', editor: null,
  proposal: { id: version, version: '3', digest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), inventoryVersionId: '60000000-0000-4000-8000-000000000001', holders: null,
    ownHolder: { id: 'h1', weddingId: wid, dealId: deal, slotId: 's1', label: 'Фотограф', expectedOrderVersion: '7', outcome: 'finite', closureReason: null, accepted: { customer: false, performer: false }, spans: [{ spanMode: 'explicit', localStartsAt: '2027-06-14T12:00:00', localEndsAt: '2027-06-14T14:00:00', startsAt: '2027-06-14T09:00:00Z', endsAt: '2027-06-14T11:00:00Z', suppliedStartsAt: '2027-06-14T12:00:00+03:00', suppliedEndsAt: '2027-06-14T14:00:00+03:00', timeZone: 'Europe/Moscow', originalDate: null, coverage: { preparation: true, travel: true, handover: true, returns: true, remainingWork: true } }] },
    manualBounds: null, staffing: { completeness: 'declared_complete', personIds: null }, createdAt: '2026-10-25T12:00:00Z' },
  history: [], receipts: [{ id: 'r1', party: 'performer', userId: 'p1', sessionId: 'ps', digest: 'a'.repeat(64), acceptedAt: '2026-10-25T12:01:00Z' }],
  readiness: { requiredReceipts: 4, acceptedReceipts: 1, canAccept: true, canActivate: false, hasStaleReceipts: false }, ...patch })
const ownerView = (): CalendarBoundsView => view({ actorRole: 'owner', readToken: null, proposal: null, editor: { sourceFingerprint: 'b'.repeat(64), inventoryVersionId: 'i1', originDate: '2027-06-14', manualOriginalDayOptions: [], holders: [
  { weddingId: wid, dealId: deal, slotId: 's1', label: 'Первый заказ', orderVersion: '7', originalDayOptions: ['2027-06-14'] },
  { weddingId: wid, dealId: '20000000-0000-4000-8000-000000000002', slotId: 's2', label: 'Второй заказ', orderVersion: '8', originalDayOptions: [] }], knownPersons: [{ id: 'p1', name: 'Анна', available: true }], unknownPersonOrigins: [] }, readiness: { requiredReceipts: 4, acceptedReceipts: 0, canAccept: false, canActivate: false, hasStaleReceipts: false } })
type Call = { path: string; method: string; body: unknown; headers: Headers }
type Reply = { body?: unknown; status?: number; down?: boolean }
const pending: { resolve: (reply: Reply) => void }[] = []
function deferred() { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(r => { resolve = r }); const item = { resolve }; pending.push(item); return { promise, resolve } }
function serve(handler?: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [], unexpected: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as unknown : null, headers: new Headers(init?.headers) }
    calls.push(call)
    let reply: Reply
    if (handler) reply = await handler(call)
    else if (call.method === 'GET' && call.path === own) reply = { body: { weddingId: wid, dealId: deal, sources: [source()] } }
    else if (call.method === 'GET' && call.path === `${own}/${sourceId}`) reply = { body: view() }
    else { unexpected.push(`${call.method} ${call.path}`); throw new Error('Unexpected controlled route') }
    if (reply.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return { calls, unexpected }
}
const parent = {}
const holder = (p = parent) => <LegacyCalendarBoundsHolder weddingId={wid} dealId={deal} parent={p} />
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
async function open() { fireEvent.click(screen.getByText('Границы прежних календарных обязательств')); await screen.findByText(/^Источников:/) }
async function read() { click('Прочитать текущие границы для согласия'); await screen.findByText(/^Версия границ /) }
const approval = () => screen.getByRole('checkbox', { name: 'Я прочитал точную версию границ, все периоды, пояс и покрытие работ своего заказа' })
const writes = (calls: Call[]) => calls.filter(c => c.method === 'POST')
beforeEach(() => { localStorage.clear(); saveTokens({ accessToken: 'actor-A', refreshToken: 'refresh-A' }); setI18nLang('ru') })
afterEach(async () => { cleanup(); for (const item of pending.splice(0)) item.resolve({ status: 409, body: { error: { code: 'stale', message: 'stale' } } }); await act(async () => {}); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('371 real components and real HTTP client, controlled fetch only', () => {
  it.each([
    { hours: 23, timeZone: 'Europe/Berlin', originalDate: '2027-03-28', localStartsAt: '2027-03-28T00:00:00.000', localEndsAt: '2027-03-29T00:00:00.000', startsAt: '2027-03-27T23:00:00.000Z', endsAt: '2027-03-28T22:00:00.000Z' },
    { hours: 25, timeZone: 'Europe/Berlin', originalDate: '2027-10-31', localStartsAt: '2027-10-31T00:00:00.000', localEndsAt: '2027-11-01T00:00:00.000', startsAt: '2027-10-30T22:00:00.000Z', endsAt: '2027-10-31T23:00:00.000Z' },
    { hours: 23.5, timeZone: 'Australia/Lord_Howe', originalDate: '2027-10-03', localStartsAt: '2027-10-03T00:00:00.000', localEndsAt: '2027-10-04T00:00:00.000', startsAt: '2027-10-02T13:30:00.000Z', endsAt: '2027-10-03T13:00:00.000Z' },
    { hours: 24.5, timeZone: 'Australia/Lord_Howe', originalDate: '2027-04-04', localStartsAt: '2027-04-04T00:00:00.000', localEndsAt: '2027-04-05T00:00:00.000', startsAt: '2027-04-03T13:00:00.000Z', endsAt: '2027-04-04T13:30:00.000Z' },
  ])('shows whole-day duration $hours real hours from authoritative UTC in RU and EN without consent writes', async ({ hours, ...span }) => {
    const material = view(), ownHolder = material.proposal!.ownHolder!
    material.source = { ...material.source, originDate: span.originalDate }
    ownHolder.spans = [{ ...ownHolder.spans[0]!, ...span, spanMode: 'whole_local_day', suppliedStartsAt: span.startsAt, suppliedEndsAt: span.endsAt }]
    const h = serve(call => {
      if (call.method === 'GET' && call.path === own) return { body: { weddingId: wid, dealId: deal, sources: [material.source] } }
      if (call.method === 'GET' && call.path === `${own}/${sourceId}`) return { body: material }
      throw new Error('Unexpected duration route')
    })
    render(holder()); await open(); await read()
    expect(screen.getByText(`Фактическая длительность: ${hours} ч.`)).toBeTruthy()
    expect((approval() as HTMLInputElement).checked).toBe(false); expect(writes(h.calls)).toEqual([])
    cleanup(); setI18nLang('en')
    render(holder()); fireEvent.click(screen.getByText('Bounds of earlier calendar obligations'))
    await screen.findByRole('button', { name: 'Read current bounds to consent' }); click('Read current bounds to consent')
    await screen.findByText(`Actual duration: ${hours} h`)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false); expect(writes(h.calls)).toEqual([])
    expect(h.calls.map(call => [call.method, call.path])).toEqual([
      ['GET', own], ['GET', `${own}/${sourceId}`], ['GET', own], ['GET', `${own}/${sourceId}`],
    ])
  })
  it('loads no private source or read-token before deliberate opening/read; never polls', async () => {
    const h = serve(); render(holder()); await act(async () => {}); expect(h.calls).toHaveLength(0)
    await open(); expect(h.calls.map(c => c.path)).toEqual([own]); expect(screen.queryByRole('checkbox')).toBeNull()
    await read(); expect(h.calls.map(c => c.path)).toEqual([own, `${own}/${sourceId}`]); expect(writes(h.calls)).toEqual([]); expect(h.unexpected).toEqual([])
    expect(screen.getByText(/2027-06-14T12:00:00 — 2027-06-14T14:00:00/)).toBeTruthy(); expect(screen.getByText(/Europe\/Moscow/)).toBeTruthy()
  })
  it('accepts exact version only after checkbox, shows own performer receipt, never auto-activates', async () => {
    const h = serve(call => {
      if (call.method === 'GET' && call.path === own) return { body: { weddingId: wid, dealId: deal, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${own}/${sourceId}`) return { body: view() }
      if (call.method === 'POST' && call.path === `${own}/${sourceId}/accept`) return { body: view({ readToken: null, acceptedByCaller: true, readiness: { requiredReceipts: 4, acceptedReceipts: 4, canAccept: false, canActivate: true, hasStaleReceipts: false } }) }
      throw new Error('Unexpected route')
    })
    render(holder()); await open(); await read(); expect(screen.getByText(/Согласие исполнителя ·/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Принять эту версию границ' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(approval()); click('Принять эту версию границ'); await screen.findByText('Ваше согласие на эту версию уже записано')
    expect(writes(h.calls)).toHaveLength(1); expect(writes(h.calls)[0].body).toEqual({ boundsVersionId: version, expectedVersion: '3', digest: 'a'.repeat(64), readToken: 'genuine-controlled-read-token' })
    expect(writes(h.calls)[0].headers.get('Idempotency-Key')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Активировать границы всей группы' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('uses a separate explicit whole activation command after native readiness', async () => {
    const h = serve(call => {
      if (call.method === 'GET' && call.path === own) return { body: { weddingId: wid, dealId: deal, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${own}/${sourceId}`) return { body: view({ readiness: { requiredReceipts: 4, acceptedReceipts: 4, canAccept: false, canActivate: true, hasStaleReceipts: false } }) }
      if (call.method === 'POST' && call.path === `${own}/${sourceId}/activate`) return { body: view({ readToken: null, source: { ...source(), state: 'finite', effectiveVersionId: version } }) }
      throw new Error('Unexpected route')
    })
    render(holder()); await open(); await read(); expect(writes(h.calls)).toEqual([]); click('Активировать границы всей группы'); await screen.findByText('Есть активированная версия границ')
    expect(writes(h.calls)[0].body).toEqual({ boundsVersionId: version, expectedHeadRevision: '2', expectedSourceFingerprint: 'b'.repeat(64), digest: 'a'.repeat(64) })
  })
  it('retries response loss with the identical immutable body and key', async () => {
    let count = 0
    const h = serve(call => {
      if (call.method === 'GET' && call.path === own) return { body: { weddingId: wid, dealId: deal, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${own}/${sourceId}`) return { body: view() }
      if (call.method === 'POST' && call.path === `${own}/${sourceId}/accept`) return ++count === 1 ? { down: true } : { body: view({ readToken: null, acceptedByCaller: true }) }
      throw new Error('Unexpected route')
    })
    render(holder()); await open(); await read(); fireEvent.click(approval()); click('Принять эту версию границ'); await screen.findByRole('button', { name: 'Повторить ту же календарную попытку' })
    click('Повторить ту же календарную попытку'); await screen.findByText('Ваше согласие на эту версию уже записано')
    const rows = writes(h.calls); expect(rows).toHaveLength(2); expect(rows[0].body).toEqual(rows[1].body); expect(rows[0].headers.get('Idempotency-Key')).toBe(rows[1].headers.get('Idempotency-Key'))
  })
  it('resets approval on equal-material successful re-read and new parent identity', async () => {
    const h = serve(); const mounted = render(holder()); await open(); await read(); fireEvent.click(approval()); expect((approval() as HTMLInputElement).checked).toBe(true)
    click('Прочитать текущие границы для согласия'); await waitFor(() => expect((approval() as HTMLInputElement).checked).toBe(false))
    mounted.rerender(holder({})); expect(screen.queryByRole('checkbox')).toBeNull(); expect(writes(h.calls)).toEqual([])
  })
  it('held old 401 after session A→B neither refreshes B nor restores private contents', async () => {
    const held = deferred()
    const h = serve(call => {
      if (call.method === 'GET' && call.path === own) return { body: { weddingId: wid, dealId: deal, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${own}/${sourceId}`) return held.promise
      throw new Error('Unexpected route, including refresh')
    })
    render(holder()); await open(); click('Прочитать текущие границы для согласия'); await waitFor(() => expect(h.calls).toHaveLength(2))
    act(() => saveTokens({ accessToken: 'actor-B', refreshToken: 'refresh-B' })); await act(async () => { held.resolve({ status: 401, body: { error: { code: 'unauthorized', message: 'Unauthorized' } } }) })
    expect(h.calls).toHaveLength(2); expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByText('Фотограф')).toBeNull()
  })
  it('owner editor never requests a holder read-token and proposes every holder explicitly', async () => {
    const h = serve(call => {
      if (call.method === 'GET' && call.path === owner) return { body: { vendorId: vendor, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${owner}/${sourceId}`) return { body: ownerView() }
      if (call.method === 'POST' && call.path === `${owner}/${sourceId}/proposals`) return { body: ownerView() }
      throw new Error('Unexpected owner route')
    })
    render(<LegacyCalendarBoundsOwner vendorId={vendor} parent={parent} />); await open(); click('Открыть редактор источника'); await screen.findByText('Первый заказ', { exact: false })
    const first = screen.getByRole('group', { name: /Первый заказ/ }), second = screen.getByRole('group', { name: /Второй заказ/ })
    fireEvent.click(within(first).getByRole('checkbox', { name: 'Все календарные работы завершены, оставшихся выездов и возвратов нет' })); fireEvent.click(within(second).getByRole('checkbox', { name: 'Все календарные работы завершены, оставшихся выездов и возвратов нет' }))
    click('Предложить границы всей группы'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writes(h.calls)[0].body).toEqual({ expectedSourceRevision: '4', expectedInventoryRevision: '3', expectedHeadRevision: '2', expectedSourceFingerprint: 'b'.repeat(64), holders: [
      { weddingId: wid, dealId: deal, expectedOrderVersion: '7', outcome: 'calendar_closed', closureReason: 'no_remaining_calendar_engagement', spans: [] },
      { weddingId: wid, dealId: '20000000-0000-4000-8000-000000000002', expectedOrderVersion: '8', outcome: 'calendar_closed', closureReason: 'no_remaining_calendar_engagement', spans: [] }], manualBounds: null, staffing: { completeness: 'unknown', personIds: [] } })
    expect(h.calls.every(c => c.path.startsWith(owner))).toBe(true)
  })
  it('owner finite draft has no implicit zone/UTC; whole-day options come only from native holder data', async () => {
    const h = serve(call => {
      if (call.method === 'GET' && call.path === owner) return { body: { vendorId: vendor, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${owner}/${sourceId}`) return { body: ownerView() }
      throw new Error('No incomplete write allowed')
    })
    render(<LegacyCalendarBoundsOwner vendorId={vendor} parent={parent} />); await open(); click('Открыть редактор источника'); await screen.findByText('Первый заказ', { exact: false })
    const first = within(screen.getByRole('group', { name: /Первый заказ/ })), second = within(screen.getByRole('group', { name: /Второй заказ/ }))
    expect((first.getByLabelText('Часовой пояс IANA') as HTMLInputElement).value).toBe(''); expect((first.getByLabelText('Начало UTC или с явным смещением') as HTMLInputElement).value).toBe('')
    fireEvent.change(first.getByLabelText('Вид периода'), { target: { value: 'whole_local_day' } }); expect(first.getAllByRole('option').some(x => x.textContent === '2027-06-14')).toBe(true)
    expect((second.getByRole('option', { name: 'Целый исходный местный день' }) as HTMLOptionElement).disabled).toBe(true); expect(writes(h.calls)).toEqual([])
  })
  it('reports unknown/loading without a false zero and clears private view after opaque denial', async () => {
    const held = deferred()
    serve(call => call.method === 'GET' && call.path === own ? held.promise : { status: 404, body: { error: { code: 'not_found', message: 'private details' } } })
    render(holder()); fireEvent.click(screen.getByText('Границы прежних календарных обязательств')); await screen.findByText('Загрузка календарных источников…'); expect(screen.queryByText(/^Источников:/)).toBeNull()
    await act(async () => held.resolve({ body: { weddingId: wid, dealId: deal, sources: [source()] } })); click('Прочитать текущие границы для согласия'); await screen.findByText('Доступ изменился. Откройте сведения заново после входа.')
    expect(screen.queryByText('private details')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('renders English controls through the same components without hidden auto-accept', async () => {
    setI18nLang('en'); const h = serve(); render(holder()); fireEvent.click(screen.getByText('Bounds of earlier calendar obligations')); await screen.findByRole('button', { name: 'Read current bounds to consent' }); expect(writes(h.calls)).toEqual([])
  })
  it('proposes finite exact local/UTC/zone and complete staffing without dropping the other holder', async () => {
    const h = serve(call => {
      if (call.method === 'GET' && call.path === owner) return { body: { vendorId: vendor, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${owner}/${sourceId}`) return { body: ownerView() }
      if (call.method === 'POST' && call.path === `${owner}/${sourceId}/proposals`) return { body: ownerView() }
      throw new Error('Unexpected route')
    })
    render(<LegacyCalendarBoundsOwner vendorId={vendor} parent={parent} />); await open(); click('Открыть редактор источника'); await screen.findByText('Первый заказ', { exact: false })
    const first = within(screen.getByRole('group', { name: /Первый заказ/ })), second = within(screen.getByRole('group', { name: /Второй заказ/ }))
    for (const [label, value] of [['Местное начало', '2027-06-14T12:00:00'], ['Местное окончание', '2027-06-14T14:00:00'], ['Начало UTC или с явным смещением', '2027-06-14T12:00:00+03:00'], ['Окончание UTC или с явным смещением', '2027-06-14T14:00:00+03:00'], ['Часовой пояс IANA', 'Europe/Moscow']]) fireEvent.change(first.getByLabelText(label), { target: { value } })
    for (const label of ['Подготовка включена', 'Дорога включена', 'Передача включена', 'Возврат включён', 'Остальные работы включены']) fireEvent.click(first.getByRole('checkbox', { name: label }))
    fireEvent.click(second.getByRole('checkbox', { name: 'Все календарные работы завершены, оставшихся выездов и возвратов нет' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Границы учитывают всех перечисленных людей, включая исторические связи' })); fireEvent.click(screen.getByRole('checkbox', { name: 'Анна' }))
    click('Предложить границы всей группы'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    const body = writes(h.calls)[0].body as { holders: { dealId: string; spans: unknown[] }[]; staffing: unknown; manualBounds: unknown }
    expect(body.holders.map(x => x.dealId)).toEqual([deal, '20000000-0000-4000-8000-000000000002'])
    expect(body.holders[0].spans).toEqual([{ spanMode: 'explicit', localStartsAt: '2027-06-14T12:00:00', localEndsAt: '2027-06-14T14:00:00', startsAt: '2027-06-14T12:00:00+03:00', endsAt: '2027-06-14T14:00:00+03:00', timeZone: 'Europe/Moscow', coverage: { preparation: true, travel: true, handover: true, returns: true, remainingWork: true } }])
    expect(body.staffing).toEqual({ completeness: 'declared_complete', personIds: ['p1'] }); expect(body.manualBounds).toBeNull()
  })
  it('keeps an offline owner draft and retries the exact proposal rather than recapturing or auto-activating', async () => {
    let attempts = 0
    const h = serve(call => {
      if (call.method === 'GET' && call.path === owner) return { body: { vendorId: vendor, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${owner}/${sourceId}`) return { body: ownerView() }
      if (call.method === 'POST' && call.path === `${owner}/${sourceId}/proposals`) return ++attempts === 1 ? { down: true } : { body: ownerView() }
      throw new Error('Unexpected route')
    })
    render(<LegacyCalendarBoundsOwner vendorId={vendor} parent={parent} />); await open(); click('Открыть редактор источника'); await screen.findByText('Первый заказ', { exact: false })
    for (const box of screen.getAllByRole('checkbox', { name: 'Все календарные работы завершены, оставшихся выездов и возвратов нет' })) fireEvent.click(box)
    click('Предложить границы всей группы'); await screen.findByRole('button', { name: 'Повторить ту же календарную попытку' })
    expect(screen.getAllByRole('checkbox', { name: 'Все календарные работы завершены, оставшихся выездов и возвратов нет' }).every(x => (x as HTMLInputElement).checked)).toBe(true)
    expect((screen.getByRole('button', { name: 'Обновить календарные источники' }) as HTMLButtonElement).disabled).toBe(true)
    click('Повторить ту же календарную попытку'); await waitFor(() => expect(writes(h.calls)).toHaveLength(2))
    const rows = writes(h.calls); expect(rows[0].body).toEqual(rows[1].body); expect(rows[0].headers.get('Idempotency-Key')).toBe(rows[1].headers.get('Idempotency-Key')); expect(rows.every(x => x.path.endsWith('/proposals'))).toBe(true)
  })
  it('manual source proposes its own bounds with no fabricated holder or receipt', async () => {
    const manual = ownerView(); manual.source = { ...source(), kind: 'manual_day', holderCount: 0 }; manual.editor!.holders = []; manual.editor!.manualOriginalDayOptions = ['2027-06-14']
    const h = serve(call => {
      if (call.method === 'GET' && call.path === owner) return { body: { vendorId: vendor, sources: [manual.source] } }
      if (call.method === 'GET' && call.path === `${owner}/${sourceId}`) return { body: manual }
      if (call.method === 'POST' && call.path === `${owner}/${sourceId}/proposals`) return { body: manual }
      throw new Error('Unexpected route')
    })
    render(<LegacyCalendarBoundsOwner vendorId={vendor} parent={parent} />); await open(); click('Открыть редактор источника'); await screen.findByText('Известные связи с людьми')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Все календарные работы завершены, оставшихся выездов и возвратов нет' })); click('Предложить границы всей группы'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writes(h.calls)[0].body).toMatchObject({ holders: [], manualBounds: { outcome: 'calendar_closed', closureReason: 'no_remaining_calendar_engagement', spans: [] } }); expect(screen.queryByRole('button', { name: 'Принять эту версию границ' })).toBeNull()
  })
  it('stale receipts and absent read-token remain non-acceptable even with an old valid-looking proposal', async () => {
    const h = serve(call => {
      if (call.method === 'GET' && call.path === own) return { body: { weddingId: wid, dealId: deal, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${own}/${sourceId}`) return { body: view({ readToken: null, readiness: { requiredReceipts: 4, acceptedReceipts: 1, canAccept: false, canActivate: false, hasStaleReceipts: true } }) }
      throw new Error('Unexpected route')
    })
    render(holder()); await open(); await read(); expect((approval() as HTMLInputElement).disabled).toBe(true); expect((screen.getByRole('button', { name: 'Активировать границы всей группы' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Есть устаревшие согласия. Требуется новое предложение и новое чтение.')).toBeTruthy(); expect(writes(h.calls)).toEqual([])
  })
  it('an unmounted held read cannot replace a fresh parent with old private material', async () => {
    const held = deferred()
    const h = serve(call => {
      if (call.method === 'GET' && call.path === own) return { body: { weddingId: wid, dealId: deal, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${own}/${sourceId}`) return held.promise
      throw new Error('Unexpected route')
    })
    const mounted = render(holder()); await open(); click('Прочитать текущие границы для согласия'); await waitFor(() => expect(h.calls).toHaveLength(2)); mounted.rerender(holder({}))
    await act(async () => held.resolve({ body: view() })); expect(screen.queryByText('Фотограф')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull(); expect(writes(h.calls)).toEqual([])
  })
  it('includes a stable historical person in conservative coverage without claiming current employment', async () => {
    const historical = '70000000-0000-4000-8000-000000000001'
    const editorView = ownerView(); editorView.editor!.knownPersons = [{ id: historical, name: null, available: false }]
    const h = serve(call => {
      if (call.method === 'GET' && call.path === owner) return { body: { vendorId: vendor, sources: [source()] } }
      if (call.method === 'GET' && call.path === `${owner}/${sourceId}`) return { body: editorView }
      if (call.method === 'POST' && call.path === `${owner}/${sourceId}/proposals`) return { body: editorView }
      throw new Error('Unexpected historical-person route')
    })
    render(<LegacyCalendarBoundsOwner vendorId={vendor} parent={parent} />)
    await open(); click('Открыть редактор источника'); await screen.findByText('Известные связи с людьми')
    for (const box of screen.getAllByRole('checkbox', { name: 'Все календарные работы завершены, оставшихся выездов и возвратов нет' })) fireEvent.click(box)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Границы учитывают всех перечисленных людей, включая исторические связи' }))
    const person = screen.getByRole('checkbox', { name: 'Участник 1 · Историческая связь' }) as HTMLInputElement
    expect(person.disabled).toBe(false); fireEvent.click(person)
    expect(screen.queryByText(historical)).toBeNull()
    click('Предложить границы всей группы')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writes(h.calls)[0].body).toMatchObject({ staffing: { completeness: 'declared_complete', personIds: [historical] } })
  })

})
