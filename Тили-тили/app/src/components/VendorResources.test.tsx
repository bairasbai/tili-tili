import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorResources } from './VendorResources'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import type { VendorAvailabilityPolicy, VendorResource, VendorResourceOptions, ResourceCapacityWindow } from '@/lib/api/resources'

type Call = { path: string; method: string; body: Record<string, unknown> | null; headers: Headers }
type Reply = { body?: unknown; status?: number; down?: boolean }
const resource = (patch: Partial<VendorResource> = {}): VendorResource => ({ id: 'r1', kind: 'equipment', label: 'Проектор', version: '1',
  personUserId: null, staffMemberId: null, capacityUnit: null, retiredAt: null, source: 'current', unavailableReason: null, windows: [], ...patch })
const window = (patch: Partial<ResourceCapacityWindow> = {}): ResourceCapacityWindow => ({ id: 'cw1', startsAt: '2027-06-14T07:00:20.123Z', endsAt: '2027-06-14T08:00:30.456Z', capacity: 10, used: 0, version: '4', ...patch })
const capacity = (windows: ResourceCapacityWindow[] = []) => resource({ kind: 'capacity', label: 'Порции кухни', capacityUnit: 'порции', windows })
const options = (patch: Partial<VendorResourceOptions> = {}): VendorResourceOptions => ({ vendorId: 'v1', actorRole: 'owner', persons: [
  { userId: 'owner', name: null, staffMemberId: null }, { userId: 'worker', name: 'Анна', staffMemberId: 'm1' }], ...patch })
const policy = (patch: Partial<VendorAvailabilityPolicy> = {}): VendorAvailabilityPolicy => ({ vendorId: 'v1', mode: 'legacy_day', revision: '3', changedBy: null, changedAt: null,
  legacyObligations: { unresolved: true, manualDays: 2, dealDays: 3, unknownDays: 1, committedDeals: 4, negotiatingDeals: 5, reason: 'unresolved_legacy_obligations' }, ...patch })
function serve(handler: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    calls.push(call); const reply = await handler(call)
    if (reply.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function harness(initial: VendorResource[] = [], handler?: (call: Call) => Reply | Promise<Reply>) {
  const state = { resources: initial, options: options(), policy: policy() }
  const calls = serve(call => {
    if (handler && call.method !== 'GET') return handler(call)
    if (call.path.endsWith('/resource-options')) return { body: state.options }
    if (call.path.endsWith('/availability-policy')) return { body: state.policy }
    return { body: state.resources }
  })
  return { state, calls }
}
function deferred() { let resolve!: (value: Reply) => void; const promise = new Promise<Reply>(r => { resolve = r }); return { resolve, promise } }
const view = (vendorId = 'v1') => <MemoryRouter><VendorResources vendorId={vendorId} /></MemoryRouter>
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET')
function write(calls: Call[], n = 0): Call { const result = writes(calls)[n]; if (!result) throw new Error('Missing controlled HTTP write'); return result }
async function open() { fireEvent.click(screen.getByText('Ресурсы компании')); await screen.findByText(/Необязательный учёт людей/) }
function adding(kind = 'equipment', label = 'Новый проектор') { fireEvent.click(screen.getByText('Добавить ресурс')); change('Вид ресурса', kind); change('Название ресурса', label) }
function windowDraft(zone = 'Europe/Moscow', start = '2027-06-14T10:00', end = '2027-06-14T11:00', quantity = '12') {
  if (zone) change('Часовой пояс для просмотра и новых окон', zone)
  fireEvent.click(screen.getByText('Добавить окно вместимости')); change('Начало окна', start); change('Окончание окна', end); change('Заявленное количество в окне', quantity)
}
const denied = (status: number): Reply => ({ status, body: { error: { code: 'internal_vendor_uuid', message: 'Internal company 123e4567-e89b-12d3-a456-426614174000' } } })
beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); setI18nLang('ru') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('optional resource editor through actual typed HTTP client (controlled replies, not PostgreSQL evidence)', () => {
  it('stays quiet before opening, reads exactly three actual endpoints on demand and does not poll', async () => {
    const h = harness(); render(view()); await act(async () => {})
    expect(h.calls).toHaveLength(0); expect(screen.queryByText('Ресурсы ещё не указаны')).toBeNull()
    await open()
    expect(h.calls.map(c => c.path).sort()).toEqual(['/vendors/v1/availability-policy', '/vendors/v1/resource-options', '/vendors/v1/resources'])
    expect(screen.getByText('Ресурсы ещё не указаны')).toBeTruthy()
    expect(screen.queryByLabelText('Часовой пояс для просмотра и новых окон')).toBeNull()
    await act(async () => new Promise(resolve => setTimeout(resolve, 25))); expect(h.calls).toHaveLength(3)
    expect(document.body.textContent).not.toContain('свободен'); expect(document.body.textContent).not.toContain('забронирован')
  })
  it('does not show partial defaults until all current reads are confirmed', async () => {
    const slow = deferred(); const calls = serve(c => c.path.endsWith('/resources') ? slow.promise : { body: c.path.endsWith('/resource-options') ? options() : policy() })
    render(view()); fireEvent.click(screen.getByText('Ресурсы компании')); await waitFor(() => expect(calls).toHaveLength(3))
    expect(screen.queryByText('Ресурсы ещё не указаны')).toBeNull(); expect(screen.queryByLabelText('Вид ресурса')).toBeNull()
    await act(async () => slow.resolve({ body: [] })); await screen.findByText('Ресурсы ещё не указаны')
  })
  it('retries failed reads without writing and without showing raw server messages', async () => {
    let down = true
    const calls = serve(c => down ? { down: true } : { body: c.path.endsWith('/resource-options') ? options() : c.path.endsWith('/availability-policy') ? policy() : [] })
    render(view()); fireEvent.click(screen.getByText('Ресурсы компании')); await screen.findByRole('button', { name: 'Повторить' })
    expect(screen.queryByText('Ресурсы ещё не указаны')).toBeNull(); down = false; click('Повторить'); await screen.findByText('Ресурсы ещё не указаны')
    expect(writes(calls)).toHaveLength(0)
  })
  it.each(['wrong_company', 'wrong_role', 'bad_quantity', 'bad_version', 'unknown_source', 'missing_counts'] as const)('rejects unconfirmed %s data without rendering editing defaults', async invalid => {
    const opt = options(), pol = policy(), res = capacity([window()])
    if (invalid === 'wrong_company') opt.vendorId = 'foreign'
    if (invalid === 'wrong_role') (opt as unknown as { actorRole: string }).actorRole = 'worker'
    if (invalid === 'bad_quantity') res.windows[0]!.used = 11
    if (invalid === 'bad_version') res.version = '0'
    if (invalid === 'unknown_source') (res as unknown as { source: string }).source = 'free'
    if (invalid === 'missing_counts') delete (pol.legacyObligations as Partial<VendorAvailabilityPolicy['legacyObligations']>).manualDays
    serve(c => ({ body: c.path.endsWith('/resource-options') ? opt : c.path.endsWith('/availability-policy') ? pol : [res] }))
    render(view()); fireEvent.click(screen.getByText('Ресурсы компании')); await screen.findByRole('button', { name: 'Повторить' })
    expect(screen.queryByLabelText('Вид ресурса')).toBeNull(); expect(screen.queryByText('Порции кухни')).toBeNull()
  })
  it('creates human-labelled equipment with a fresh intention key and resets only its completed form', async () => {
    const h = harness([], c => { const result = resource({ id: 'new', label: String(c.body?.label) }); h.state.resources.push(result); return { body: result } })
    render(view()); await open(); adding(); click('Сохранить ресурс'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls).body).toEqual({ kind: 'equipment', label: 'Новый проектор' }); expect(write(h.calls).headers.get('Idempotency-Key')).toBeTruthy()
    expect(screen.getByLabelText('Название ресурса')).toHaveProperty('value', '')
    change('Название ресурса', 'Запасной проектор'); click('Сохранить ресурс'); await waitFor(() => expect(writes(h.calls)).toHaveLength(2))
    expect(write(h.calls, 1).headers.get('Idempotency-Key')).not.toBe(write(h.calls).headers.get('Idempotency-Key'))
  })
  it('selects a real accepted person explicitly and sends exact directory identity instead of UUID input', async () => {
    const h = harness([], c => ({ body: resource({ kind: 'person', label: String(c.body?.label), personUserId: String(c.body?.personUserId), staffMemberId: String(c.body?.staffMemberId) }) }))
    render(view()); await open(); adding('person', 'Фотограф церемонии')
    expect(screen.getByLabelText('Человек из действующей команды')).toHaveProperty('value', '')
    click('Сохранить ресурс'); await screen.findByText('Укажите название и необходимые сведения ресурса'); expect(writes(h.calls)).toHaveLength(0)
    change('Человек из действующей команды', 'worker'); click('Сохранить ресурс'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls).body).toEqual({ kind: 'person', label: 'Фотограф церемонии', personUserId: 'worker', staffMemberId: 'm1' })
    expect(screen.queryByLabelText('UUID')).toBeNull()
  })
  it('selects the actual owner with unknown name and omits staffMemberId instead of fabricating employment', async () => {
    const h = harness([], () => ({ body: resource({ kind: 'person', label: 'Я', personUserId: 'owner', staffMemberId: null }) }))
    render(view()); await open(); adding('person', 'Я'); expect(screen.getByRole('option', { name: 'Владелец компании — имя не указано' })).toBeTruthy()
    change('Человек из действующей команды', 'owner'); click('Сохранить ресурс'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls).body).toEqual({ kind: 'person', label: 'Я', personUserId: 'owner' })
  })
  it('allows the actual resource manager but never offers staff invites, finance or program acceptance', async () => {
    const h = harness(); h.state.options.actorRole = 'resource_manager'; render(view()); await open()
    expect(screen.getByText('Вы управляете ресурсами по принятой роли управляющего')).toBeTruthy()
    for (const name of ['Пригласить сотрудника', 'Подтвердить программу', 'Оплатить']) expect(screen.queryByRole('button', { name })).toBeNull()
  })
  it('person and equipment accounting never asks for a window timezone until actual capacity exists', async () => {
    const h = harness([resource(), resource({ id: 'person', kind: 'person', label: 'Фотограф', personUserId: 'worker', staffMemberId: 'm1' })])
    render(view()); await open(); expect(screen.queryByLabelText('Часовой пояс для просмотра и новых окон')).toBeNull()
    expect(screen.queryByText('Часовой пояс не выбран. Местное время окон пока неизвестно.')).toBeNull()
    h.state.resources.push(capacity()); click('Перечитать сведения'); await screen.findByLabelText('Часовой пояс для просмотра и новых окон')
    expect(screen.getByLabelText('Часовой пояс для просмотра и новых окон')).toHaveProperty('value', '')
  })
  it('creates capacity only with an explicit human unit and does not invent windows or quantities', async () => {
    const h = harness([], c => ({ body: resource({ kind: 'capacity', label: 'Кухня', capacityUnit: String(c.body?.capacityUnit) }) }))
    render(view()); await open(); adding('capacity', 'Кухня'); click('Сохранить ресурс'); await screen.findByText('Укажите название и необходимые сведения ресурса'); expect(writes(h.calls)).toHaveLength(0)
    change('Единица вместимости', 'порции'); click('Сохранить ресурс'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls).body).toEqual({ kind: 'capacity', label: 'Кухня', capacityUnit: 'порции' })
  })
  it('shows unknown units and declared/used zero honestly without calculating free availability', async () => {
    harness([resource({ kind: 'capacity', label: 'Старый ресурс', capacityUnit: null, windows: [window()] })]); render(view()); await open()
    expect(screen.getByText('Единица вместимости: Не указана')).toBeTruthy(); expect(screen.getByText(/Заявлено:.*10.*Учтено в обязательствах:.*0/)).toBeTruthy()
    expect(screen.getByText('Выберите часовой пояс, чтобы увидеть время окна')).toBeTruthy()
    expect(document.body.textContent).not.toContain('2027-06-14T07:00:20.123Z')
  })
  it('keeps retired history visible, hides further edits, and does not reconstruct a missing staff identity', async () => {
    harness([capacity([window()]), resource({ id: 'old', kind: 'person', label: 'Бывший участник', source: 'unavailable', unavailableReason: 'identity_unknown', personUserId: null }),
      resource({ id: 'retired', kind: 'capacity', label: 'Старая кухня', retiredAt: '2026-10-01T00:00:00Z', source: 'unavailable', unavailableReason: 'retired', capacityUnit: 'порции', windows: [window({ id: 'old-window' })] })]); render(view()); await open()
    const old = screen.getByText('Старая кухня').closest('article')!
    expect(within(old).getByText('Выведен из использования')).toBeTruthy(); expect(within(old).queryByRole('button', { name: 'Вывести из использования' })).toBeNull()
    expect(within(old).queryByLabelText('Изменить заявленное количество')).toBeNull(); expect(within(old).getByText(/Учтено в обязательствах/)).toBeTruthy()
    expect(screen.getByText('Личность человека не подтверждена')).toBeTruthy(); expect(screen.getByText('Человек не подтверждён текущим списком')).toBeTruthy()
  })
  it('retires using exact current version, preserves returned history and refreshes only after actual success', async () => {
    const h = harness([resource({ version: '7' })], () => { const result = resource({ version: '8', source: 'unavailable', unavailableReason: 'retired', retiredAt: '2026-10-01T00:00:00Z' }); h.state.resources = [result]; return { body: result } })
    render(view()); await open(); click('Вывести из использования'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls)).toMatchObject({ path: '/vendors/v1/resources/r1/retire', method: 'POST', body: { expectedVersion: '7' } })
    expect(screen.getByText('Выведен из использования')).toBeTruthy()
  })
  it('policy is optional, uses exact revision, leaves old counts visible and skips a no-op', async () => {
    const h = harness([resource()], c => { const result = policy({ mode: c.body?.mode as VendorAvailabilityPolicy['mode'], revision: '4' }); h.state.policy = result; return { body: result } })
    render(view()); await open(); fireEvent.click(screen.getByText('Как учитывать новые обязательства'))
    expect(screen.getByRole('button', { name: 'Сохранить режим учёта' })).toHaveProperty('disabled', true)
    click('Сохранить режим учёта'); expect(writes(h.calls)).toHaveLength(0)
    expect(screen.getByText('Старые обязательства сохраняются при смене режима.')).toBeTruthy()
    expect(screen.getByText('Дни с неизвестным источником').nextElementSibling?.textContent).toBe('1')
    change('Режим учёта новых обязательств', 'resources'); click('Сохранить режим учёта'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls)).toMatchObject({ method: 'PATCH', path: '/vendors/v1/availability-policy', body: { mode: 'resources', expectedRevision: '3' } })
    expect(screen.getByText('Действующие обязательства').nextElementSibling?.textContent).toBe('4')
  })
  it('accepts the actual missing-row policy revision zero and submits its exact first revision without inventing occupied days', async () => {
    const empty = policy({ revision: '0', legacyObligations: { unresolved: false, manualDays: 0, dealDays: 0, unknownDays: 0, committedDeals: 0, negotiatingDeals: 0, reason: null } })
    const h = harness([resource()], c => ({ body: { ...empty, mode: c.body?.mode, revision: '1' } })); h.state.policy = empty
    render(view()); await open(); fireEvent.click(screen.getByText('Как учитывать новые обязательства'))
    expect(screen.getByLabelText('Режим учёта новых обязательств')).toHaveProperty('value', 'legacy_day')
    expect(screen.getByText('Занятые дни вручную').nextElementSibling?.textContent).toBe('0')
    change('Режим учёта новых обязательств', 'resources'); click('Сохранить режим учёта'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls).body).toEqual({ mode: 'resources', expectedRevision: '0' })
  })
  it('a genuinely empty company keeps the server default and requires an actual resource before selecting resource accounting', async () => {
    const h = harness(); h.state.policy = policy({ revision: '0' }); render(view()); await open(); fireEvent.click(screen.getByText('Как учитывать новые обязательства'))
    const select = screen.getByLabelText('Режим учёта новых обязательств')
    expect(select).toHaveProperty('value', 'legacy_day'); expect(within(select).getByRole('option', { name: 'Учёт по ресурсам' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Для учёта по ресурсам сначала укажите действующий ресурс.')).toBeTruthy(); expect(writes(h.calls)).toHaveLength(0)
  })
  it('creates a finite local Moscow window without viewer-zone inference', async () => {
    const h = harness([capacity()], c => ({ body: window({ startsAt: String(c.body?.startsAt), endsAt: String(c.body?.endsAt), capacity: Number(c.body?.capacity), version: '1' }) }))
    render(view()); await open(); windowDraft(); click('Сохранить окно вместимости'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls)).toMatchObject({ path: '/vendors/v1/resources/r1/windows', method: 'POST', body: { startsAt: '2027-06-14T07:00:00.000Z', endsAt: '2027-06-14T08:00:00.000Z', capacity: 12 } })
  })
  it.each(['missing_zone', 'zero', 'negative', 'fraction', 'overflow', 'backwards', 'missing_end'] as const)('refuses a %s window without making an HTTP write', async invalid => {
    const h = harness([capacity()]); render(view()); await open()
    windowDraft(invalid === 'missing_zone' ? '' : 'Europe/Moscow', '2027-06-14T10:00', invalid === 'missing_end' ? '' : invalid === 'backwards' ? '2027-06-14T09:00' : '2027-06-14T11:00', invalid === 'zero' ? '0' : invalid === 'negative' ? '-1' : invalid === 'fraction' ? '1.5' : invalid === 'overflow' ? '2147483648' : '12')
    fireEvent.submit(screen.getByRole('button', { name: 'Сохранить окно вместимости' }).closest('form')!); await screen.findByText(/Выберите часовой пояс, конечный интервал/)
    expect(writes(h.calls)).toHaveLength(0)
  })
  it('refuses the Berlin spring gap instead of normalizing it', async () => {
    const h = harness([capacity()]); render(view()); await open(); windowDraft('Europe/Berlin', '2027-03-28T02:30', '2027-03-28T04:00')
    expect(screen.getByText('Такого местного времени нет из-за перевода часов. Выберите другое время.')).toBeTruthy()
    click('Сохранить окно вместимости'); await screen.findByText(/Выберите часовой пояс, конечный интервал/); expect(writes(h.calls)).toHaveLength(0)
  })
  it('requires explicit occurrences for both ends of an autumn overlap and sends those actual instants', async () => {
    const h = harness([capacity()], c => ({ body: window({ startsAt: String(c.body?.startsAt), endsAt: String(c.body?.endsAt), capacity: 12, version: '1' }) }))
    render(view()); await open(); windowDraft('Europe/Berlin', '2027-10-31T02:15', '2027-10-31T02:45')
    click('Сохранить окно вместимости'); await screen.findByText(/Выберите часовой пояс, конечный интервал/); expect(writes(h.calls)).toHaveLength(0)
    change('Какое повторение времени выбрать: Начало окна', '120'); change('Какое повторение времени выбрать: Окончание окна', '60'); click('Сохранить окно вместимости'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls).body).toEqual({ startsAt: '2027-10-31T00:15:00.000Z', endsAt: '2027-10-31T01:45:00.000Z', capacity: 12 })
  })
  it('changing a zone preserves typed local times but invalidates the old DST occurrence, including changing back', async () => {
    const h = harness([capacity()]); render(view()); await open(); windowDraft('Europe/Berlin', '2027-10-31T02:15', '2027-10-31T03:45')
    change('Какое повторение времени выбрать: Начало окна', '120'); change('Часовой пояс для просмотра и новых окон', 'Europe/Moscow'); change('Часовой пояс для просмотра и новых окон', 'Europe/Berlin')
    expect(screen.getByLabelText('Начало окна')).toHaveProperty('value', '2027-10-31T02:15'); expect(screen.getByLabelText('Какое повторение времени выбрать: Начало окна')).toHaveProperty('value', '')
    click('Сохранить окно вместимости'); await screen.findByText(/Выберите часовой пояс, конечный интервал/); expect(writes(h.calls)).toHaveLength(0)
  })
  it('patches only the capacity with the actual child version; untouched second/millisecond instants never get rewritten', async () => {
    const initial = window({ used: 4 }), h = harness([capacity([initial])], c => ({ body: window({ capacity: Number(c.body?.capacity), used: 4, version: '5' }) }))
    render(view()); await open(); expect(screen.getByRole('button', { name: 'Сохранить количество' })).toHaveProperty('disabled', true)
    change('Изменить заявленное количество', '12'); click('Сохранить количество'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls)).toMatchObject({ method: 'PATCH', path: '/vendors/v1/resources/r1/windows/cw1', body: { expectedVersion: '4', capacity: 12 } })
    expect(write(h.calls).body).not.toHaveProperty('startsAt'); expect(write(h.calls).body).not.toHaveProperty('endsAt')
  })
  it('cannot reduce capacity below already-used obligations or send a no-op', async () => {
    const h = harness([capacity([window({ used: 4 })])]); render(view()); await open(); click('Сохранить количество'); expect(writes(h.calls)).toHaveLength(0)
    change('Изменить заявленное количество', '3'); fireEvent.submit(screen.getByRole('button', { name: 'Сохранить количество' }).closest('form')!); await screen.findByText('Укажите положительное целое число не меньше уже учтённых обязательств'); expect(writes(h.calls)).toHaveLength(0)
  })
  it('double click and Enter cannot duplicate a write; other fields freeze while the response is pending', async () => {
    const reply = deferred(), h = harness([capacity()], () => reply.promise); render(view()); await open(); adding()
    click('Сохранить ресурс'); click('Сохранить ресурс'); fireEvent.submit(screen.getByRole('button', { name: 'Сохранить ресурс' }).closest('form')!)
    expect(writes(h.calls)).toHaveLength(1); expect(screen.getByLabelText('Название ресурса').closest('fieldset')).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Часовой пояс для просмотра и новых окон')).toHaveProperty('disabled', true)
    await act(async () => reply.resolve({ body: resource({ label: 'Новый проектор' }) })); await screen.findByText('Ресурсы сохранены')
  })
  it('response-loss retry retains exactly the same key and body, including after ordinary collapse/reopen', async () => {
    let count = 0; const h = harness([], () => ++count === 1 ? { down: true } : { body: resource({ label: 'Новый проектор' }) })
    render(view()); await open(); adding(); click('Сохранить ресурс'); await screen.findByText('Результат сохранения неизвестен. Повторная проверка отправит то же действие.')
    expect(screen.getByLabelText('Название ресурса').closest('fieldset')).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByText('Ресурсы компании')); await waitFor(() => expect(screen.getByText('Ресурсы компании').closest('details')?.open).toBe(false))
    fireEvent.click(screen.getByText('Ресурсы компании')); await screen.findByRole('button', { name: 'Проверить сохранение ресурса' }); click('Проверить сохранение ресурса'); await screen.findByText('Ресурсы сохранены')
    expect(writes(h.calls)).toHaveLength(2); expect(write(h.calls, 1).body).toEqual(write(h.calls).body); expect(write(h.calls, 1).headers.get('Idempotency-Key')).toBe(write(h.calls).headers.get('Idempotency-Key'))
  })
  it('a confirmed write with failed follow-up GET offers GET-only recovery and does not resend the mutation', async () => {
    let saved = false, readable = false
    const calls = serve(c => {
      if (c.method !== 'GET') { saved = true; return { body: resource({ label: 'Новый проектор' }) } }
      if (saved && !readable) return { down: true }
      return { body: c.path.endsWith('/resource-options') ? options() : c.path.endsWith('/availability-policy') ? policy() : [] }
    })
    render(view()); await open(); adding(); click('Сохранить ресурс'); await screen.findByRole('button', { name: 'Обновить ресурсы' })
    expect(screen.queryByText('Ресурсы сохранены')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить сохранение ресурса' })).toBeNull()
    readable = true; click('Обновить ресурсы'); await screen.findByText('Ресурсы сохранены'); expect(writes(calls)).toHaveLength(1)
  })
  it('a malformed success body is never called saved and subsequent recovery reads only', async () => {
    const h = harness([], () => ({ body: { invalid: true } })); render(view()); await open(); adding(); click('Сохранить ресурс')
    await screen.findByText('Ответ о сохранении не подтверждён. Обновите ресурсы.'); expect(screen.queryByText('Ресурсы сохранены')).toBeNull()
    click('Обновить ресурсы'); await screen.findByText('Сведения обновлены. Ваш ввод сохранён — проверьте его перед новой попыткой.')
    expect(screen.queryByText('Ресурсы сохранены')).toBeNull(); expect(writes(h.calls)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Сохранить ресурс' }).closest('fieldset')).toHaveProperty('disabled', true)
  })
  it.each([409, 422])('freshens a definitive %s rejection, preserves edited inputs, requires review and starts a new intention key', async status => {
    let attempt = 0; const h = harness([capacity([window()])], c => { if (++attempt === 1) { h.state.resources = [capacity([window({ version: '9', capacity: 15, used: 6 })])]; return denied(status) }; return { body: window({ capacity: Number(c.body?.capacity), version: '10', used: 6 }) } })
    render(view()); await open(); change('Изменить заявленное количество', '18'); click('Сохранить количество'); await screen.findByText('Сведения обновлены. Ваш ввод сохранён — проверьте его перед новой попыткой.')
    expect(screen.getByLabelText('Изменить заявленное количество')).toHaveProperty('value', '18'); expect(writes(h.calls)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Сохранить количество' })).toHaveProperty('disabled', true); click('Проверил сведения, продолжить'); click('Сохранить количество'); await screen.findByText('Ресурсы сохранены')
    expect(write(h.calls, 1).body).toEqual({ expectedVersion: '9', capacity: 18 }); expect(write(h.calls, 1).headers.get('Idempotency-Key')).not.toBe(write(h.calls).headers.get('Idempotency-Key'))
    expect(document.body.textContent).not.toContain('123e4567')
  })
  it('a refreshed directory cannot revive a removed person or their old name in the selection', async () => {
    const h = harness([], () => { h.state.options = options({ persons: [options().persons[0]!] }); return denied(409) })
    render(view()); await open(); adding('person', 'Церемония'); change('Человек из действующей команды', 'worker'); click('Сохранить ресурс')
    await screen.findByText('Сведения обновлены. Ваш ввод сохранён — проверьте его перед новой попыткой.')
    expect(screen.queryByRole('option', { name: 'Анна' })).toBeNull(); expect(screen.getByRole('option', { name: 'Выбранный человек недоступен' })).toHaveProperty('disabled', true)
    click('Проверил сведения, продолжить'); click('Сохранить ресурс'); await screen.findByText('Укажите название и необходимые сведения ресурса'); expect(writes(h.calls)).toHaveLength(1)
  })
  it('refresh rebases untouched window drafts but keeps only explicitly edited quantities', async () => {
    const h = harness([capacity([window(), window({ id: 'cw2', startsAt: '2027-06-15T07:00:00Z', endsAt: '2027-06-15T08:00:00Z', capacity: 30, version: '2' })])], () => {
      h.state.resources = [capacity([window({ capacity: 16, version: '5' }), window({ id: 'cw2', startsAt: '2027-06-15T07:00:00Z', endsAt: '2027-06-15T08:00:00Z', capacity: 40, version: '3' })])]; return denied(409)
    })
    render(view()); await open(); const inputs = screen.getAllByLabelText('Изменить заявленное количество'); fireEvent.change(inputs[0]!, { target: { value: '20' } }); fireEvent.click(screen.getAllByRole('button', { name: 'Сохранить количество' })[0]!)
    await screen.findByText('Сведения обновлены. Ваш ввод сохранён — проверьте его перед новой попыткой.')
    expect(screen.getAllByLabelText('Изменить заявленное количество').map(el => (el as HTMLInputElement).value)).toEqual(['20', '40'])
  })
  it('an ordinary explicit read refreshes actual facts without demanding a separate confirmation or performing a write', async () => {
    const h = harness([capacity([window()])]); render(view()); await open(); h.state.resources = [capacity([window({ capacity: 14, version: '5' })])]
    click('Перечитать сведения'); await screen.findByText('Сведения обновлены. Ваш ввод сохранён — проверьте его перед новой попыткой.')
    expect(screen.getByLabelText('Изменить заявленное количество')).toHaveProperty('value', '14')
    expect(screen.queryByRole('button', { name: 'Проверил сведения, продолжить' })).toBeNull(); expect(writes(h.calls)).toHaveLength(0)
  })
  it.each([403, 404, 410])('a private %s write failure removes the editor, entered labels and old responses', async status => {
    const h = harness([resource({ label: 'Личный старый проектор' })], () => denied(status)); render(view()); await open(); adding('equipment', 'Секретное название'); click('Сохранить ресурс')
    await screen.findByRole('alert'); expect(screen.queryByText('Личный старый проектор')).toBeNull(); expect(screen.queryByLabelText('Название ресурса')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Проверить сохранение ресурса' })).toBeNull(); expect(document.body.textContent).not.toContain('123e4567')
    expect(writes(h.calls)).toHaveLength(1)
  })
  it('a private denial during follow-up refresh clears every old snapshot rather than offering retry on the old reply', async () => {
    let revoked = false
    serve(c => { if (c.method !== 'GET') { revoked = true; return { body: resource({ label: 'Новый проектор' }) } }; return revoked ? denied(403) : { body: c.path.endsWith('/resource-options') ? options() : c.path.endsWith('/availability-policy') ? policy() : [resource({ label: 'Приватный исходный ресурс' })] } })
    render(view()); await open(); adding(); click('Сохранить ресурс'); await screen.findByRole('alert')
    expect(screen.queryByText('Приватный исходный ресурс')).toBeNull(); expect(screen.queryByRole('button', { name: 'Обновить ресурсы' })).toBeNull()
  })
  it('a fast failed sibling GET cannot hide a later private denial from another current reader', async () => {
    const late = deferred(); let phase = 0
    serve(c => {
      if (c.method !== 'GET') { phase = 1; return { body: resource({ label: 'Новый проектор' }) } }
      if (phase && c.path.endsWith('/resources')) return { down: true }
      if (phase && c.path.endsWith('/resource-options')) return late.promise
      return { body: c.path.endsWith('/resource-options') ? options() : c.path.endsWith('/availability-policy') ? policy() : [resource({ label: 'Приватный прежний ресурс' })] }
    })
    render(view()); await open(); adding(); click('Сохранить ресурс'); await screen.findByRole('button', { name: 'Обновить ресурсы' })
    await act(async () => late.resolve(denied(403))); await screen.findByRole('alert')
    expect(screen.queryByText('Приватный прежний ресурс')).toBeNull(); expect(screen.queryByLabelText('Название ресурса')).toBeNull()
  })
  it('a late denial from an abandoned company reader cannot close a new company after its own reads succeed', async () => {
    const late = deferred(); let old = 0
    const calls = serve(c => {
      const newCompany = c.path.includes('/v2/')
      if (!newCompany && c.path.endsWith('/resources')) { old++; return { down: true } }
      if (!newCompany && c.path.endsWith('/resource-options')) return late.promise
      return { body: c.path.endsWith('/resource-options') ? options({ vendorId: newCompany ? 'v2' : 'v1' }) : c.path.endsWith('/availability-policy') ? policy({ vendorId: newCompany ? 'v2' : 'v1' }) : [resource({ label: 'Текущая компания' })] }
    })
    const rendered = render(view()); fireEvent.click(screen.getByText('Ресурсы компании')); await screen.findByRole('button', { name: 'Повторить' }); expect(old).toBe(1)
    rendered.rerender(view('v2')); await open(); await screen.findByText('Текущая компания')
    await act(async () => late.resolve(denied(403))); expect(screen.getByText('Текущая компания')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull()
    expect(calls.filter(c => c.path.includes('/v2/'))).toHaveLength(3)
  })
  it('company prop changes clear an uncertain command and late replies cannot paint the previous company', async () => {
    const later = deferred(), h = harness([], () => later.promise), rendered = render(view()); await open(); adding(); click('Сохранить ресурс'); rendered.rerender(view('v2'))
    expect(screen.queryByLabelText('Название ресурса')).toBeNull(); await act(async () => later.resolve({ body: resource({ label: 'Новый проектор' }) }))
    expect(screen.queryByText('Ресурсы сохранены')).toBeNull(); expect(screen.queryByText('Новый проектор')).toBeNull(); expect(h.calls.filter(c => c.path.includes('/v2/'))).toHaveLength(0)
  })
  it('session changes erase private inputs, uncertainty and subsequent old replies', async () => {
    const later = deferred(); harness([resource({ label: 'Приватный проектор' })], () => later.promise); render(view()); await open(); adding(); click('Сохранить ресурс')
    act(() => saveTokens({ accessToken: 'different-person', refreshToken: 'different-refresh' })); await screen.findByText('Сессия истекла — войдите снова')
    expect(screen.queryByText('Приватный проектор')).toBeNull(); expect(screen.queryByLabelText('Название ресурса')).toBeNull()
    await act(async () => later.resolve({ body: resource({ label: 'Новый проектор' }) })); expect(screen.queryByText('Ресурсы сохранены')).toBeNull()
  })
  it('an expired session during a write removes the editor even if refresh rejects before the old request settles', async () => {
    serve(c => c.path === '/auth/refresh' || c.method !== 'GET' ? denied(401) : { body: c.path.endsWith('/resource-options') ? options() : c.path.endsWith('/availability-policy') ? policy() : [resource({ label: 'Приватный проектор' })] })
    render(view()); await open(); adding(); click('Сохранить ресурс'); await screen.findByText('Сессия истекла — войдите снова')
    expect(screen.queryByText('Приватный проектор')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить сохранение ресурса' })).toBeNull()
  })
  it('unmounting a pending writer suppresses its late result and follow-up reads', async () => {
    const later = deferred(), h = harness([], () => later.promise), rendered = render(view()); await open(); adding(); click('Сохранить ресурс'); rendered.unmount()
    await act(async () => later.resolve({ body: resource({ label: 'Новый проектор' }) })); expect(h.calls).toHaveLength(4)
  })
  it('uses labelled keyboard controls and wrap-safe layout at narrow width without asserting jsdom browser geometry', async () => {
    harness([capacity([window()])]); render(<div style={{ width: 320 }}>{view()}</div>); await open(); adding('person')
    expect(screen.getByLabelText('Человек из действующей команды').tagName).toBe('SELECT')
    expect(screen.getByText('Ресурсы компании').closest('details')?.className).toContain('min-w-0')
    for (const element of document.querySelectorAll('input,select')) expect(element.className).toContain('min-w-0')
    expect(screen.queryByLabelText('ISO')).toBeNull(); expect(screen.queryByLabelText('JSON')).toBeNull()
  })
})
