import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderResourcePlan } from './OrderResourcePlan'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import type { OrderCatalog, WeddingOrder, ResourcePlanView, ResourcePlanLineInput, ResourcePlanWrite } from '@/lib/api/orders'
import type { VendorResource } from '@/lib/api/resources'

type Call = { path: string; method: string; body: ResourcePlanWrite | null; headers: Headers }
type Reply = { body?: unknown; status?: number; down?: boolean }
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const deal = id(1), wedding = id(2), vendor = id(3), part = id(4), res = id(5), win = id(6), assignment = id(7), event = id(8)
const zeros = { setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0 }
const input = (patch: Partial<ResourcePlanLineInput> = {}): ResourcePlanLineInput => ({ partId: part, resourceId: res, capacityWindowId: win, quantity: 10, startsAt: '2027-06-14T07:00:20.123Z', endsAt: '2027-06-14T08:00:30.456Z', timeZone: 'Europe/Moscow', ...zeros, ...patch })
const resource = (patch: Partial<VendorResource> = {}): VendorResource => ({ id: res, kind: 'capacity', label: 'Изготовление букетов', version: '1', personUserId: null, staffMemberId: null, capacityUnit: 'букеты', retiredAt: null, source: 'current', unavailableReason: null, windows: [{ id: win, startsAt: '2027-06-13T00:00:00Z', endsAt: '2027-06-20T00:00:00Z', capacity: 30, used: 28, version: '1' }], ...patch })
const order = (): WeddingOrder => ({ dealId: deal, version: '1', schemaVersion: 1, source: 'structured', brief: null, assignments: [], parts: [{ id: part, kind: 'deliverable', version: '1', source: 'structured', assignmentId: null, title: 'Обработка галереи', details: { items: null, dueAt: '2027-07-14T07:00:00Z', recipient: null, reviewProcess: null }, cancelledAt: null }] })
const catalog = (role: OrderCatalog['actorRole'] = 'vendor'): OrderCatalog => ({ weddingId: wedding, primarySlotId: id(9), actorRole: role, draftEditable: true, timeZone: 'Asia/Yekaterinburg', assignmentTimeZones: [], eligiblePositions: [], category: { categoryId: 'photo', label: 'Фотограф', autoAssign: false, fields: [], suggestedKinds: ['timed_service', 'deliverable'] }, executionKinds: ['timed_service', 'supply', 'rental', 'deliverable', 'appointment'] })
const empty = (edit = true): ResourcePlanView => ({ orderVersion: '1', revision: '0', canEdit: edit, reservation: 'not_reserved', current: null, editorLines: edit ? [] : null, source: 'current', history: [] })
function publicPlan(lines: ResourcePlanLineInput[], revision = '1'): NonNullable<ResourcePlanView['current']> {
  return { planRevisionId: id(100 + Number(revision)), revision, lines: lines.map(line => ({ partId: line.partId, assignmentId: null, programEventId: null, label: 'Изготовление букетов', kind: line.capacityWindowId ? 'capacity' : 'equipment', quantity: line.quantity, unit: line.capacityWindowId ? 'букеты' : null, startsAt: line.startsAt, endsAt: line.endsAt, timeZone: line.timeZone, setupMinutes: line.setupMinutes, teardownMinutes: line.teardownMinutes, travelBeforeMinutes: line.travelBeforeMinutes, travelAfterMinutes: line.travelAfterMinutes, occupiedStartsAt: new Date(Date.parse(line.startsAt) - (line.setupMinutes + line.travelBeforeMinutes) * 60000).toISOString(), occupiedEndsAt: new Date(Date.parse(line.endsAt) + (line.teardownMinutes + line.travelAfterMinutes) * 60000).toISOString(), window: line.capacityWindowId ? { startsAt: '2027-06-13T00:00:00Z', endsAt: '2027-06-20T00:00:00Z' } : null })) }
}
function present(lines = [input()], edit = true): ResourcePlanView { const p = publicPlan(lines); return { ...empty(edit), revision: '1', current: p, editorLines: edit ? lines : null, history: [p] } }
function serve(handler: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(request).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    calls.push(call); const r = await handler(call); if (r.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function harness(plan = empty(), role: OrderCatalog['actorRole'] = 'vendor', handler?: (call: Call) => Reply | Promise<Reply>) {
  const state = { order: order(), catalog: catalog(role), plan, resources: [resource()], profile: { id: vendor } }
  const get = (c: Call): Reply => ({ body: c.path === '/vendor/profile' ? state.profile : c.path.endsWith('/resources') ? state.resources : c.path.endsWith('/catalog') ? state.catalog : c.path.endsWith('/resource-plan') ? state.plan : state.order })
  const accept = (body: ResourcePlanWrite): Reply => { state.order.version = (BigInt(state.order.version) + 1n).toString(); const rev = (BigInt(state.plan.revision) + 1n).toString(), current = publicPlan(body.lines, rev); current.lines.forEach((line, index) => { const aId = state.order.parts.find(p => p.id === line.partId)?.assignmentId ?? null, own = body.lines[index]!, resource = state.resources.find(r => r.id === own.resourceId)!, window = resource.windows.find(w => w.id === own.capacityWindowId); line.assignmentId = aId; line.programEventId = state.order.assignments.find(a => a.id === aId)?.programEventId ?? null; line.kind = resource.kind; line.label = resource.label; line.unit = resource.capacityUnit; line.window = window ? { startsAt: window.startsAt, endsAt: window.endsAt } : null }); state.plan = { ...state.plan, orderVersion: state.order.version, revision: rev, current, editorLines: body.lines, history: [...state.plan.history, current] }; return { body: state.plan } }
  const calls = serve(c => c.method !== 'GET' ? handler ? handler(c) : accept(c.body!) : get(c))
  return { state, get, accept, calls }
}
function deferred() { let resolve!: (r: Reply) => void; const promise = new Promise<Reply>(r => { resolve = r }); return { resolve, promise } }
const view = (dealId = deal) => <MemoryRouter><OrderResourcePlan dealId={dealId} /></MemoryRouter>
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET')
function write(calls: Call[], n = 0): Call { const c = writes(calls)[n]; if (!c) throw new Error('Missing actual-client controlled write'); return c }
async function open(edit = true) { fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByText('Ресурсы не зарезервированы'); if (edit) await screen.findByRole('button', { name: 'Добавить ресурс в план' }) }
function draft(z = 'Europe/Moscow', start = '2027-06-14T10:00', end = '2027-06-14T11:00') {
  click('Добавить ресурс в план'); change('Работа для ресурса', part); change('Ресурс компании для этой работы', res); change('Часовой пояс периода использования', z); change('Окно мощности для работы', win); change('Количество для этого заказа', '10'); change('Начало использования', start); change('Окончание использования', end); fireEvent.click(screen.getByText('Подготовка, демонтаж и дорога')); click('Дополнительное время не требуется')
}
const denied = (status = 403): Reply => ({ status, body: { error: { code: 'private_internal_id', message: 'Secret person ' + id(999) } } })
beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); setI18nLang('ru') })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('optional resource planning through actual HTTP wrappers; controlled replies are not PG or booking evidence', () => {
  it('is quiet when collapsed, never polls, and the ordinary pair never reads company resources', async () => {
    const h = harness(empty(false), 'couple'); render(view()); await act(async () => {}); expect(h.calls).toHaveLength(0)
    expect(screen.queryByText('План ресурсов ещё не указан')).toBeNull(); await open(false)
    expect(h.calls.map(c => c.path).sort()).toEqual(['/deals/' + deal + '/order', '/deals/' + deal + '/order/catalog', '/deals/' + deal + '/order/resource-plan'])
    expect(screen.queryByRole('button', { name: 'Добавить ресурс в план' })).toBeNull(); await act(async () => new Promise(r => setTimeout(r, 25))); expect(h.calls).toHaveLength(3)
  })
  it('waits for actual authority and company data before showing an editor', async () => {
    const slow = deferred(), h = harness(); serve(c => c.path.endsWith('/resources') ? slow.promise : h.get(c)); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа'))
    await screen.findByText('Проверяем сведения плана…'); expect(screen.queryByRole('button', { name: 'Добавить ресурс в план' })).toBeNull()
    await act(async () => slow.resolve({ body: h.state.resources })); await screen.findByRole('button', { name: 'Добавить ресурс в план' })
  })
  it('uses canEdit for a vendor owner who is also a couple, without inventing a second party receipt', async () => {
    const h = harness(empty(), 'couple'); render(view()); await open(); expect(h.calls.some(c => c.path === '/vendors/' + vendor + '/resources')).toBe(true)
    draft(); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]?.resourceId).toBe(res)
    expect(h.calls.some(c => c.path.includes('/terms/'))).toBe(false)
  })
  it('shows every frozen public fact to the pair without UUID inputs or company identity data', async () => {
    const line = input({ setupMinutes: 5, teardownMinutes: 6, travelBeforeMinutes: 7, travelAfterMinutes: 8 }), h = harness(present([line], false), 'couple')
    render(view()); await open(false)
    for (const label of ['Подготовка до работы, минут', 'Демонтаж после работы, минут', 'Дорога до работы, минут', 'Дорога после работы, минут', 'Полный период с подготовкой и дорогой', 'Выбранное окно мощности', 'Europe/Moscow']) expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain(res); expect(document.body.textContent).not.toContain(win); expect(document.body.textContent).not.toContain(id(999)); expect(document.querySelector('input,select')).toBeNull(); expect(h.calls).toHaveLength(3)
  })
  it.each(['private_resource', 'private_person', 'private_staff', 'wrong_occupied', 'missing_buffer', 'missing_window', 'bad_zone', 'bad_quantity', 'extra_top', 'unknown_reservation', 'bad_head', 'unknown_source'] as const)('rejects malformed/privacy-sensitive %s instead of rendering it', async invalid => {
    const p = present([input()], false), l = p.current!.lines[0]! as unknown as Record<string, unknown>, raw = p as unknown as Record<string, unknown>
    if (invalid === 'private_resource') l.resourceId = id(999)
    if (invalid === 'private_person') l.personUserId = id(999)
    if (invalid === 'private_staff') l.staffMemberId = id(999)
    if (invalid === 'wrong_occupied') l.occupiedStartsAt = '2027-06-14T08:00:00Z'
    if (invalid === 'missing_buffer') delete l.travelAfterMinutes
    if (invalid === 'missing_window') l.window = null
    if (invalid === 'bad_zone') l.timeZone = 'Made/Up'
    if (invalid === 'bad_quantity') l.quantity = 0
    if (invalid === 'extra_top') raw.internalPerson = id(999)
    if (invalid === 'unknown_reservation') raw.reservation = 'available'
    if (invalid === 'bad_head') raw.revision = '2'
    if (invalid === 'unknown_source') raw.source = 'available'
    harness(p, 'couple'); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByRole('alert')
    expect(screen.queryByText('Изготовление букетов')).toBeNull(); expect(screen.queryByText('План ресурсов ещё не указан')).toBeNull(); expect(document.body.textContent).not.toContain(id(999))
  })
  describe.each(['reserved', 'released'] as const)('controlled current-edition %s projection, not evidence of a real booking', reservation => {
    const label = reservation === 'reserved' ? 'Ресурсы этой редакции зарезервированы' : 'Бронь ресурсов этой редакции снята'
    it.each(['current', 'invalid', 'unavailable'] as const)('keeps a safe accepted history with %s source without inventing release or availability', async source => {
      const h = harness({ ...present([input()], false), reservation, source }, 'couple')
      render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByText(label)
      expect(screen.getAllByText('Изготовление букетов').length).toBeGreaterThan(0)
      expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull()
      expect(screen.queryAllByRole('alert')).toHaveLength(source === 'current' ? 0 : 1)
      for (const privateId of [res, win, vendor, id(999)]) expect(document.body.textContent).not.toContain(privateId)
      expect(document.querySelector('input,select')).toBeNull()
      expect(h.calls.map(c => c.path).sort()).toEqual(['/deals/' + deal + '/order', '/deals/' + deal + '/order/catalog', '/deals/' + deal + '/order/resource-plan'])
      expect(writes(h.calls)).toHaveLength(0)
    })
    it('allows independently proved owner editing without turning it into a reservation action', async () => {
      const h = harness({ ...present(), reservation }, 'couple')
      render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByText(label)
      await screen.findByRole('button', { name: 'Добавить ресурс в план' })
      expect(screen.getByLabelText('Количество для этого заказа')).toHaveProperty('value', '10')
      expect(h.calls.some(c => c.path === '/vendors/' + vendor + '/resources')).toBe(true)
      expect(h.calls.some(c => c.path.includes('/terms/') || c.path.includes('/resource-commitments'))).toBe(false)
      expect(writes(h.calls)).toHaveLength(0)
    })
    it.each(['resource', 'person', 'staff', 'conflict_identity', 'top_private', 'editor_private'] as const)('still refuses %s leakage despite reservation status', async leak => {
      const p = { ...present([input()], false), reservation }, raw = p as unknown as Record<string, unknown>, line = p.current!.lines[0]! as unknown as Record<string, unknown>
      if (leak === 'resource') line.resourceId = id(999)
      if (leak === 'person') line.personUserId = id(999)
      if (leak === 'staff') line.staffMemberId = id(999)
      if (leak === 'conflict_identity') line.conflictIdentity = id(999)
      if (leak === 'top_private') raw.internalPerson = id(999)
      if (leak === 'editor_private') p.editorLines = [input()]
      const h = harness(p, 'couple'); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByRole('alert')
      expect(screen.queryByText(label)).toBeNull(); expect(screen.queryByText('Изготовление букетов')).toBeNull()
      expect(document.body.textContent).not.toContain(id(999)); expect(document.body.textContent).not.toContain(res)
      expect(document.querySelector('input,select')).toBeNull(); expect(h.calls).toHaveLength(3)
    })
    it.each(['missing_current', 'zero_revision', 'empty_plan'] as const)('does not claim a reservation for %s even when the remaining shape is valid', async bad => {
      const p = { ...present(bad === 'empty_plan' ? [] : [input()], false), reservation }
      if (bad === 'missing_current') { p.current = null; p.source = 'invalid' }
      if (bad === 'zero_revision') { p.revision = '0'; p.current = null; p.history = []; p.source = 'current' }
      const h = harness(p, 'couple'); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByRole('alert')
      expect(screen.queryByText(label)).toBeNull(); expect(screen.queryByText('План ресурсов ещё не указан')).toBeNull()
      expect(screen.queryByText('План очищен. Ресурсы не указаны.')).toBeNull(); expect(writes(h.calls)).toHaveLength(0)
    })
  })
  it.each([null, 2, 'booked', ''] as const)('refuses unsupported reservation value %s without granting editing', async invalid => {
    const p = present([input()], false); (p as unknown as Record<string, unknown>).reservation = invalid
    harness(p, 'couple'); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByRole('alert')
    expect(screen.queryByText('Изготовление букетов')).toBeNull(); expect(document.querySelector('input,select')).toBeNull()
  })
  it.each(['reserved', 'released'] as const)('a newer not_reserved projection never borrows the older %s history status', async previous => {
    const p = present([input()], false), old = p.current!, newer = publicPlan([input({ quantity: 11 })], '2')
    p.revision = '2'; p.current = newer; p.history = [newer, old]
    const h = harness({ ...present([input()], false), reservation: previous }, 'couple')
    const oldStatus = previous === 'reserved' ? 'Ресурсы этой редакции зарезервированы' : 'Бронь ресурсов этой редакции снята'
    render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByText(oldStatus)
    h.state.plan = p; click('Обновить сведения плана'); await screen.findByText('Ресурсы не зарезервированы')
    // The previous status was actually rendered. A fresh controlled response
    // now describes a newer draft; safe history cannot grant it an old status.
    expect(screen.getAllByText('Изготовление букетов').length).toBeGreaterThan(0)
    expect(screen.queryByText(previous === 'reserved' ? 'Ресурсы этой редакции зарезервированы' : 'Бронь ресурсов этой редакции снята')).toBeNull()
    expect(h.calls).toHaveLength(6); expect(writes(h.calls)).toHaveLength(0)
  })
  it('after a controlled successful save trusts the fresh reserved GET and never reports false unreserved status', async () => {
    const h = harness(present()); let accepted = false, patchReservation: ResourcePlanView['reservation'] | undefined
    const calls = serve(c => {
      if (c.method !== 'GET') { const reply = h.accept(c.body!); patchReservation = h.state.plan.reservation; accepted = true; return reply }
      if (accepted && c.path.endsWith('/resource-plan')) h.state.plan = { ...h.state.plan, reservation: 'reserved' }
      return h.get(c)
    })
    render(view()); await open(); change('Количество для этого заказа', '11'); click('Сохранить план ресурсов')
    await screen.findByText('Ресурсы этой редакции зарезервированы')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Добавить ресурс в план' })).toHaveProperty('disabled', false))
    expect(patchReservation).toBe('not_reserved'); expect(writes(calls)).toHaveLength(1)
    const patchIndex = calls.findIndex(c => c.method === 'PATCH')
    expect(calls.slice(patchIndex + 1).filter(c => c.method === 'GET' && c.path.endsWith('/resource-plan'))).toHaveLength(2)
    expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull()
    expect(screen.queryByText('План сохранён. Ресурсы не зарезервированы.')).toBeNull()
    await screen.findByText('План сохранён.')
  })
  it('closes an ordinary pair reader if private editor lines leak in the response', async () => {
    harness({ ...present([input()], false), editorLines: [input()] }, 'couple'); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.'); expect(screen.queryByText('Изготовление букетов')).toBeNull()
  })
  it.each(['invalid', 'unavailable'] as const)('preserves safe history while explaining %s source honestly', async source => {
    harness({ ...present([input()], false), source }, 'couple'); render(view()); await open(false); expect(screen.getAllByText('Изготовление букетов').length).toBeGreaterThan(0); expect(screen.getByRole('alert')).toBeTruthy()
  })
  it('loads actual owner resources and rechecks private order authority after a company wait', async () => {
    const later = deferred(), h = harness(), calls = serve(c => c.path.endsWith('/resources') ? later.promise : h.get(c)); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа'))
    await waitFor(() => expect(calls.some(c => c.path.endsWith('/resources'))).toBe(true)); h.state.plan = empty(false)
    await act(async () => later.resolve({ body: h.state.resources })); await screen.findByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.'); expect(screen.queryByRole('button', { name: 'Добавить ресурс в план' })).toBeNull()
  })
  it.each(['wrong_order', 'wrong_version', 'bad_profile', 'bad_resource', 'bad_window'] as const)('does not create editing defaults from %s', async bad => {
    const h = harness()
    if (bad === 'wrong_order') h.state.order.dealId = id(99)
    if (bad === 'wrong_version') h.state.plan.orderVersion = '2'
    if (bad === 'bad_profile') h.state.profile.id = 'unknown'
    if (bad === 'bad_resource') h.state.resources[0]!.source = 'free' as VendorResource['source']
    if (bad === 'bad_window') h.state.resources[0]!.windows[0]!.used = 31
    render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'Добавить ресурс в план' })).toBeNull()
  })
  it('saves an unassigned deliverable with explicitly chosen resource, interval and zeros; no dueAt/timezone inference', async () => {
    const h = harness(); render(view()); await open(); click('Добавить ресурс в план')
    const zoneSelect = screen.getByLabelText('Часовой пояс периода использования') as HTMLSelectElement
    expect(zoneSelect).toHaveProperty('value', ''); expect(Array.from(zoneSelect.options).slice(1, 3).map(o => o.value)).toEqual(['Europe/Moscow', 'Asia/Yekaterinburg']); expect(screen.getByLabelText('Начало использования')).toHaveProperty('value', '')
    change('Работа для ресурса', part); change('Ресурс компании для этой работы', res); change('Часовой пояс периода использования', 'Europe/Moscow'); change('Окно мощности для работы', win); change('Количество для этого заказа', '10'); change('Начало использования', '2027-06-14T10:00'); change('Окончание использования', '2027-06-14T11:00')
    click('Сохранить план ресурсов'); await screen.findByRole('alert'); expect(writes(h.calls)).toHaveLength(0)
    fireEvent.click(screen.getByText('Подготовка, демонтаж и дорога')); click('Дополнительное время не требуется'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.')
    expect(write(h.calls).body).toEqual({ expectedVersion: '1', expectedPlanRevision: '0', lines: [input({ startsAt: '2027-06-14T07:00:00.000Z', endsAt: '2027-06-14T08:00:00.000Z' })] }); expect(write(h.calls).headers.get('Idempotency-Key')).toBeTruthy()
    expect(localStorage.length).toBe(1); expect(write(h.calls).body?.lines[0]).not.toHaveProperty('programEventId')
  })
  it.each(['person', 'equipment'] as const)('selects an actual %s resource with quantity1 and no capacity window', async kind => {
    const h = harness(); h.state.resources = [resource({ kind, capacityUnit: null, windows: [], personUserId: kind === 'person' ? id(99) : null })]; render(view()); await open(); click('Добавить ресурс в план'); change('Работа для ресурса', part); change('Ресурс компании для этой работы', res); change('Часовой пояс периода использования', 'Europe/Moscow'); change('Начало использования', '2027-06-14T10:00'); change('Окончание использования', '2027-06-14T11:00'); fireEvent.click(screen.getByText('Подготовка, демонтаж и дорога')); click('Дополнительное время не требуется'); click('Сохранить план ресурсов')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(write(h.calls).body?.lines[0]).toMatchObject({ resourceId: res, quantity: 1, capacityWindowId: null }); expect(document.body.textContent).not.toContain(id(99))
  })
  it.each(['quantity_zero', 'quantity_fraction', 'quantity_huge', 'buffer_missing', 'buffer_fraction', 'buffer_huge', 'end_before', 'no_zone', 'window_bounds'] as const)('refuses invalid %s without HTTP writes', async bad => {
    const h = harness(); render(view()); await open(); draft()
    if (bad === 'quantity_zero') change('Количество для этого заказа', '0')
    if (bad === 'quantity_fraction') change('Количество для этого заказа', '1.5')
    if (bad === 'quantity_huge') change('Количество для этого заказа', '2147483648')
    if (bad === 'buffer_missing') change('Дорога после работы, минут', '')
    if (bad === 'buffer_fraction') change('Дорога после работы, минут', '0.5')
    if (bad === 'buffer_huge') change('Дорога после работы, минут', '1441')
    if (bad === 'end_before') change('Окончание использования', '2027-06-14T09:00')
    if (bad === 'no_zone') change('Часовой пояс периода использования', '')
    if (bad === 'window_bounds') change('Начало использования', '2027-06-12T10:00')
    click('Сохранить план ресурсов'); await screen.findByRole('alert'); expect(writes(h.calls)).toHaveLength(0)
  })
  it('includes all four explicitly chosen buffers, and checks the full occupied period against the window', async () => {
    const h = harness(); h.state.resources[0]!.windows[0]!.startsAt = '2027-06-14T06:59:00Z'; const rendered = render(view()); await open(); draft(); change('Подготовка до работы, минут', '1'); change('Дорога до работы, минут', '1'); click('Сохранить план ресурсов'); await screen.findByRole('alert'); expect(writes(h.calls)).toHaveLength(0)
    change('Дорога до работы, минут', '0'); change('Демонтаж после работы, минут', '2'); change('Дорога после работы, минут', '3'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]).toMatchObject({ setupMinutes: 1, teardownMinutes: 2, travelBeforeMinutes: 0, travelAfterMinutes: 3 })
    const windows = screen.getByLabelText('Окно мощности для работы') as HTMLSelectElement
    expect(Array.from(windows.options).find(o => o.value === win)?.textContent).toContain('Учтено в обязательствах: 28')
    setI18nLang('en'); rendered.rerender(view())
    const countedWindow = Array.from(windows.options).find(o => o.value === win)?.textContent
    expect(countedWindow).toContain('Recorded in commitments: 28'); expect(countedWindow).toContain('30'); expect(countedWindow).not.toContain('Got it')
  })
  it('allows production before a delivery window without inferring supply units or clipping to the event day', async () => {
    const h = harness(); h.state.order.assignments = [{ id: assignment, slotId: id(9), programEventId: event, version: '1', source: 'structured', label: 'Доставка', cancelledAt: null }]; h.state.order.parts = [{ id: part, kind: 'supply', version: '1', assignmentId: assignment, source: 'structured', title: 'Доставка цветов', cancelledAt: null, details: { quantity: 100, unit: 'стебли', windowStartsAt: '2027-06-18T07:00:00Z', windowEndsAt: '2027-06-18T09:00:00Z', location: null, recipient: null, substitutions: null } }]
    render(view()); await open(); draft('Europe/Moscow', '2027-06-14T10:00', '2027-06-16T11:00'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]).toMatchObject({ quantity: 10, endsAt: '2027-06-16T08:00:00.000Z' })
  })
  it('requires explicit autumn occurrence and rejects nonexistent spring time', async () => {
    const h = harness(); h.state.resources[0]!.windows[0] = { ...h.state.resources[0]!.windows[0]!, startsAt: '2027-01-01T00:00:00Z', endsAt: '2028-01-01T00:00:00Z' }; render(view()); await open(); draft('Europe/Berlin', '2027-03-28T02:30', '2027-03-28T04:00'); expect(screen.getByText('Такого местного времени нет из-за перевода часов. Выберите другое время.')).toBeTruthy(); click('Сохранить план ресурсов'); expect(writes(h.calls)).toHaveLength(0)
    change('Начало использования', '2027-10-31T02:30'); change('Окончание использования', '2027-10-31T03:30'); click('Сохранить план ресурсов'); expect(writes(h.calls)).toHaveLength(0); change('Какое повторение времени выбрать: Начало использования', '60'); click('Сохранить план ресурсов'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(write(h.calls).body?.lines[0]?.startsAt).toBe('2027-10-31T01:30:00.000Z')
  })
  it('keeps exact original seconds/milliseconds when changing only quantity', async () => {
    const h = harness(present()); render(view()); await open(); change('Количество для этого заказа', '11'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]).toMatchObject({ startsAt: input().startsAt, endsAt: input().endsAt, quantity: 11 })
  })
  it('editing start alone preserves the untouched end seconds/milliseconds', async () => {
    const h = harness(present()); render(view()); await open(); change('Начало использования', '2027-06-14T10:15'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]).toMatchObject({ startsAt: '2027-06-14T07:15:00.000Z', endsAt: input().endsAt })
  })
  it('handles actual rental across multiple dates using a single explicitly covering capacity window', async () => {
    const h = harness(); h.state.order.assignments = [{ id: assignment, slotId: id(9), programEventId: event, version: '1', source: 'structured', label: 'Аренда на праздник', cancelledAt: null }]; h.state.order.parts = [{ id: part, kind: 'rental', assignmentId: assignment, version: '1', source: 'structured', title: 'Стулья на три дня', cancelledAt: null, details: { quantity: 100, unit: 'стулья', handoverAt: '2027-06-14T07:00:00Z', returnAt: '2027-06-16T08:00:00Z', location: null, recipient: null, condition: null, depositTerms: null } }]; h.state.resources = [resource({ label: 'Стулья', capacityUnit: 'стулья' })]
    render(view()); await open(); draft('Europe/Moscow', '2027-06-14T10:00', '2027-06-16T11:00'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]).toMatchObject({ startsAt: '2027-06-14T07:00:00.000Z', endsAt: '2027-06-16T08:00:00.000Z' })
  })
  it('plans an actual photographer timed_service using an explicitly selected person, without inheriting part times', async () => {
    const h = harness(); h.state.order.assignments = [{ id: assignment, slotId: id(9), programEventId: event, version: '1', source: 'structured', label: 'Церемония', cancelledAt: null }]; h.state.order.parts = [{ id: part, kind: 'timed_service', assignmentId: assignment, version: '1', source: 'structured', title: 'Съёмка церемонии', cancelledAt: null, details: { startsAt: '2027-06-14T09:00:00Z', endsAt: '2027-06-14T12:00:00Z', setupMinutes: 30, teardownMinutes: null, travelMinutes: 60, location: null } }]; h.state.resources = [resource({ kind: 'person', label: 'Фотограф Анна', capacityUnit: null, windows: [], personUserId: id(99) })]
    render(view()); await open(); click('Добавить ресурс в план'); change('Работа для ресурса', part); change('Ресурс компании для этой работы', res); expect(screen.getByLabelText('Начало использования')).toHaveProperty('value', ''); change('Часовой пояс периода использования', 'Europe/Moscow'); change('Начало использования', '2027-06-14T11:00'); change('Окончание использования', '2027-06-14T15:00'); fireEvent.click(screen.getByText('Подготовка, демонтаж и дорога')); click('Дополнительное время не требуется'); change('Дорога до работы, минут', '25'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]).toMatchObject({ quantity: 1, setupMinutes: 0, travelBeforeMinutes: 25, startsAt: '2027-06-14T08:00:00.000Z' })
  })
  it('same-key retry can complete a lost response and a later edited intention gets a new key', async () => {
    let attempts = 0; const h = harness(empty(), 'vendor', c => ++attempts === 1 ? { down: true } : h.accept(c.body!)); render(view()); await open(); draft(); click('Сохранить план ресурсов'); await screen.findByRole('button', { name: 'Проверить сохранение плана' }); click('Проверить сохранение плана'); await screen.findByText('План сохранён.'); expect(write(h.calls, 1).headers.get('Idempotency-Key')).toBe(write(h.calls).headers.get('Idempotency-Key')); expect(write(h.calls, 1).body).toEqual(write(h.calls).body); change('Количество для этого заказа', '11'); click('Сохранить план ресурсов'); await waitFor(() => expect(writes(h.calls)).toHaveLength(3)); expect(write(h.calls, 2).headers.get('Idempotency-Key')).not.toBe(write(h.calls).headers.get('Idempotency-Key'))
  })
  it('company identity changing on explicit refresh clears the old reader before fetching another company', async () => {
    const h = harness(present()); render(view()); await open(); h.state.profile.id = id(90); click('Обновить сведения плана'); await screen.findByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.'); expect(h.calls.some(c => c.path === '/vendors/' + id(90) + '/resources')).toBe(false); expect(screen.queryByLabelText('Количество для этого заказа')).toBeNull()
  })
  it('a revoked editor on explicit refresh loses all old private data', async () => {
    const h = harness(present()); render(view()); await open(); h.state.catalog.actorRole = 'couple'; h.state.plan = present([input()], false); click('Обновить сведения плана'); await screen.findByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.'); expect(screen.queryByText('Изготовление букетов')).toBeNull()
  })
  it('a malformed pair projection on refresh also erases the previous owner editor and its draft', async () => {
    const h = harness(present()); render(view()); await open(); change('Количество для этого заказа', '17'); h.state.catalog.actorRole = 'couple'; h.state.plan = { ...present([input()], false), editorLines: [input()] }; click('Обновить сведения плана'); await screen.findByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.'); expect(screen.queryByLabelText('Количество для этого заказа')).toBeNull(); expect(screen.queryByText('Изготовление букетов')).toBeNull(); expect(screen.queryByRole('button', { name: 'Обновить сведения плана' })).toBeNull()
  })
  it('rejects mismatched live part/assignment scope rather than showing a current confirmed plan', async () => {
    const h = harness(present([input()], false), 'couple'); h.state.order.parts[0]!.cancelledAt = '2027-01-01T00:00:00Z'; render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByRole('alert'); expect(screen.queryByText('Изготовление букетов')).toBeNull()
  })
  it('accepts equivalent frozen facts regardless of JSON object property order', async () => {
    const p = present([input()], false); p.history[0] = { lines: p.current!.lines, revision: p.current!.revision, planRevisionId: p.current!.planRevisionId }; harness(p, 'couple'); render(view()); await open(false); expect(screen.getAllByText('Изготовление букетов').length).toBeGreaterThan(0)
  })
  it('same-labelled distinct resources remain distinct selections and material intentions', async () => {
    const h = harness(present()); h.state.resources.push(resource({ id: id(56), windows: [{ ...resource().windows[0]!, id: id(57) }] })); render(view()); await open(); expect(screen.getByRole('option', { name: /№1/ })).toBeTruthy(); expect(screen.getByRole('option', { name: /№2/ })).toBeTruthy(); change('Ресурс компании для этой работы', id(56)); change('Окно мощности для работы', id(57)); change('Количество для этого заказа', '10'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body?.lines[0]).toMatchObject({ resourceId: id(56), capacityWindowId: id(57) }); expect(h.state.plan.revision).toBe('2'); expect(h.state.plan.current!.planRevisionId).not.toBe(h.state.plan.history[0]!.planRevisionId); expect(document.body.textContent).not.toContain(id(56))
  })
  it('a200 containing the old different editor intention does not claim the new plan was saved', async () => {
    const h = harness(present(), 'vendor', () => ({ body: h.state.plan })); render(view()); await open(); change('Количество для этого заказа', '11'); click('Сохранить план ресурсов'); await screen.findByText('Не удалось подтвердить план ресурсов. Попробуйте ещё раз.'); expect(screen.queryByText('План сохранён.')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить сохранение плана' })).toBeNull()
  })
  it('unmounting before a write resolves suppresses its follow-up reads', async () => {
    const later = deferred(), h = harness(empty(), 'vendor', () => later.promise), rendered = render(view()); await open(); draft(); click('Сохранить план ресурсов'); const count = h.calls.length; rendered.unmount(); await act(async () => later.resolve(h.accept(write(h.calls).body!))); expect(h.calls).toHaveLength(count)
  })
  it('prevents busy button/Enter duplicates and explicitly retries the same immutable body/key after response loss', async () => {
    const later = deferred(), h = harness(empty(), 'vendor', () => later.promise); render(view()); await open(); draft(); click('Сохранить план ресурсов'); fireEvent.submit(screen.getByRole('button', { name: 'Сохранить план ресурсов' }).closest('form')!); await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(screen.getByLabelText('Количество для этого заказа').closest('fieldset')?.parentElement?.closest('fieldset')?.disabled).toBe(true)
    await act(async () => later.resolve({ down: true })); await screen.findByRole('button', { name: 'Проверить сохранение плана' }); expect(screen.getByLabelText('Количество для этого заказа').closest('fieldset')?.parentElement?.closest('fieldset')?.disabled).toBe(true)
    const before = write(h.calls); click('Проверить сохранение плана'); await waitFor(() => expect(writes(h.calls)).toHaveLength(2)); expect(write(h.calls, 1).headers.get('Idempotency-Key')).toBe(before.headers.get('Idempotency-Key')); expect(write(h.calls, 1).body).toEqual(before.body)
  })
  it('retains entered draft after409 but requires fresh GET and review before a new intention key', async () => {
    let failed = true
    const h = harness(empty(), 'vendor', c => { if (failed) { failed = false; h.state.order.version = '2'; h.state.plan.orderVersion = '2'; return denied(409) }; return h.accept(c.body!) }); render(view()); await open(); draft(); change('Количество для этого заказа', '12'); click('Сохранить план ресурсов'); await screen.findByText('Сведения изменились. Обновите их и проверьте введённый план.'); expect(screen.getByLabelText('Количество для этого заказа')).toHaveProperty('value', '12'); click('Обновить сведения плана'); await screen.findByRole('button', { name: 'Проверил обновлённые сведения' }); expect(screen.getByRole('button', { name: 'Сохранить план ресурсов' })).toHaveProperty('disabled', true)
    click('Проверил обновлённые сведения'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls, 1).body?.expectedVersion).toBe('2'); expect(write(h.calls, 1).body?.lines[0]?.quantity).toBe(12); expect(write(h.calls, 1).headers.get('Idempotency-Key')).not.toBe(write(h.calls).headers.get('Idempotency-Key'))
  })
  it('after successful write and lost refresh retries GET only, with no fabricated save confirmation', async () => {
    let unread = false; const h = harness(); const calls = serve(c => { if (c.method !== 'GET') { unread = true; return h.accept(c.body!) }; return unread ? { down: true } : h.get(c) }); render(view()); await open(); draft(); click('Сохранить план ресурсов'); await screen.findByText('Не удалось подтвердить план ресурсов. Попробуйте ещё раз.'); expect(screen.queryByText('План сохранён.')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить сохранение плана' })).toBeNull(); unread = false; click('Обновить сведения плана'); await screen.findByRole('button', { name: 'Проверил обновлённые сведения' }); expect(writes(calls)).toHaveLength(1)
  })
  it('does not call malformed200 saved and offers only fresh reads', async () => {
    const h = harness(empty(), 'vendor', () => ({ body: { reservation: 'reserved' } })); render(view()); await open(); draft(); click('Сохранить план ресурсов'); await screen.findByText('Не удалось подтвердить план ресурсов. Попробуйте ещё раз.'); expect(screen.queryByText('План сохранён.')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить сохранение плана' })).toBeNull(); expect(writes(h.calls)).toHaveLength(1)
  })
  it('allows explicit clearing with exact current revision and keeps safe historical facts', async () => {
    const h = harness(present()); render(view()); await open(); click('Убрать строку плана'); click('Сохранить план ресурсов'); await screen.findByText('План сохранён.'); expect(write(h.calls).body).toEqual({ expectedVersion: '1', expectedPlanRevision: '1', lines: [] }); expect(screen.getAllByText('Изготовление букетов').length).toBeGreaterThan(0); expect(screen.getAllByText('План очищен. Ресурсы не указаны.').length).toBeGreaterThan(0)
  })
  it('does not offer cancelled parts or unavailable resources, and prevents exact duplicate semantic lines', async () => {
    const h = harness(); h.state.order.parts.push({ ...h.state.order.parts[0]!, id: id(44), title: 'Отменённая работа', cancelledAt: '2027-01-01T00:00:00Z' }); h.state.resources.push(resource({ id: id(55), label: 'Отключённый ресурс', source: 'unavailable', unavailableReason: 'retired', retiredAt: '2027-01-01T00:00:00Z' })); render(view()); await open(); draft(); expect(screen.queryByRole('option', { name: 'Отменённая работа' })).toBeNull(); expect(screen.queryByRole('option', { name: /Отключённый ресурс/ })).toBeNull()
    click('Добавить ресурс в план'); const boxes = screen.getAllByRole('group', { name: /Ресурс плана/ }), box = within(boxes[1]!); const set = (name: string, value: string) => fireEvent.change(box.getByLabelText(name), { target: { value } }); set('Работа для ресурса', part); set('Ресурс компании для этой работы', res); set('Часовой пояс периода использования', 'Europe/Moscow'); set('Окно мощности для работы', win); set('Количество для этого заказа', '10'); set('Начало использования', '2027-06-14T10:00'); set('Окончание использования', '2027-06-14T11:00'); fireEvent.click(box.getByRole('button', { name: 'Дополнительное время не требуется' })); click('Сохранить план ресурсов'); await screen.findByRole('alert'); expect(writes(h.calls)).toHaveLength(0)
  })
  it('a late sibling403 erases private data even after another read has failed first', async () => {
    const late = deferred(), h = harness(), calls = serve(c => c.path.endsWith('/catalog') ? late.promise : c.path.endsWith('/resource-plan') ? { down: true } : h.get(c)); render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByRole('alert'); await act(async () => late.resolve(denied())); await screen.findByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.'); expect(screen.queryByRole('button', { name: 'Обновить сведения плана' })).toBeNull(); expect(calls.some(c => c.path === '/vendor/profile')).toBe(false)
  })
  it('privacy refusal during a write clears the reader instead of retaining a retry body', async () => {
    harness(present(), 'vendor', () => denied()); render(view()); await open(); change('Количество для этого заказа', '11'); click('Сохранить план ресурсов'); await screen.findByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.'); expect(screen.queryByText('Изготовление букетов')).toBeNull(); expect(screen.queryByLabelText('Количество для этого заказа')).toBeNull(); expect(document.body.textContent).not.toContain(id(999))
  })
  it('session change clears draft and a late pending write cannot reopen it or start follow-up reads', async () => {
    const late = deferred(), h = harness(empty(), 'vendor', () => late.promise); render(view()); await open(); draft(); click('Сохранить план ресурсов'); const count = h.calls.length; act(() => saveTokens({ accessToken: 'other-session', refreshToken: 'other-refresh' })); await screen.findByText('Сессия изменилась — откройте заказ после входа заново'); await act(async () => late.resolve(h.accept(write(h.calls).body!))); expect(h.calls).toHaveLength(count); expect(screen.queryByLabelText('Количество для этого заказа')).toBeNull(); expect(screen.queryByText('План сохранён.')).toBeNull()
  })
  it('changing deals remounts a quiet reader and ignores late old privacy results', async () => {
    const late = deferred(), h = harness(); serve(c => c.path.includes(deal) && c.path.endsWith('/catalog') ? late.promise : h.get(c)); const rendered = render(view()); fireEvent.click(screen.getByText('План ресурсов заказа')); await screen.findByText('Проверяем сведения плана…'); rendered.rerender(view(id(20))); await act(async () => late.resolve(denied())); expect(screen.queryByText('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.')).toBeNull(); expect(screen.queryByText('Ресурсы не зарезервированы')).toBeNull()
  })
  it('uses labelled keyboard controls and wrapping layout without claiming jsdom physical browser evidence', async () => {
    harness(); render(<div style={{ width: 320 }}>{view()}</div>); await open(); draft(); expect(screen.getByText('План ресурсов заказа').closest('details')?.className).toContain('min-w-0'); for (const el of document.querySelectorAll('input,select')) expect(el.className).toContain('min-w-0'); expect(screen.getByLabelText('Начало использования')).toHaveProperty('type', 'datetime-local'); expect(screen.queryByLabelText(/UUID|ISO|JSON/)).toBeNull()
  })
})
