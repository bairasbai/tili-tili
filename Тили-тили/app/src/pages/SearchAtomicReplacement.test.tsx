// @vitest-environment jsdom
// Controlled HTTP evidence for the actual Router, Store and API client.
// This suite does not certify PostgreSQL rollback, locking or idempotency.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from '@/lib/store'
import { saveTokens } from '@/lib/api/client'
import type { ServerSlot } from '@/lib/api/slots'
import { VendorDetail } from '@/pages/Search'

const W = '11111111-1111-4111-8111-111111111111'
const W2 = '22222222-2222-4222-8222-222222222222'
const S = '33333333-3333-4333-8333-333333333333'
const OLD = '4444444a-4444-4444-8444-444444444444'
const NEW = '55555555-5555-4555-8555-555555555555'
const V1 = '66666666-6666-4666-8666-666666666666'
const V2 = '77777777-7777-4777-8777-777777777777'
const V3 = '88888888-8888-4888-8888-888888888888'
const P1 = '99999999-9999-4999-8999-999999999999'
const P2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SLOT_PATH = `/weddings/${W}/slots`
const REPLACE_PATH = `${SLOT_PATH}/${S}/replace`
const POLICY_PATH = `/vendors/${V2}/booking-policy`
const COMMIT_PATH = `/deals/${OLD}/order/resource-commitments`
const wedding = { id: W, title: 'Свадьба', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [] }
const oldSlot = { id: S, categoryId: 'photo', label: 'Фотограф', tileState: 'booked', deal: { id: OLD, state: 'booked', vendor: { id: V1, name: 'Первый фотограф' }, price: { amount: 250000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } } } satisfies ServerSlot
const newSlot = { ...oldSlot, deal: { ...oldSlot.deal, id: NEW, vendor: { id: V2, name: 'Второй фотограф' } } }
const vendor = { id: V2, name: 'Второй фотограф', categoryId: 'photo', city: 'Уфа', rating: 4.8, reviewsCount: 0, priceFrom: { amount: 250000, currency: 'RUB' }, packages: [
  { id: P1, name: 'Полный день', price: { amount: 250000, currency: 'RUB' }, includes: ['Восемь часов'] },
  { id: P2, name: 'Короткий день', price: { amount: 100000, currency: 'RUB' }, includes: ['Три часа'] },
], gallery: [], media: [] }
const noCommit = { revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' }
const expectedBody = { expectedSelectedDealId: OLD, expectedSelectedDealState: 'booked', vendorId: V2, packageId: P1, price: { amount: 250000, currency: 'RUB' }, expectedPolicyRevision: '5' }
type Call = { method: string; path: string; body: unknown; headers: Headers; signal: AbortSignal | null | undefined }
type Stage = 'roles' | 'slots' | 'policy' | 'commitments'
type Reply = unknown | Response
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const refusal = () => response({ error: { code: 'slot_taken', message: 'На эту дату уже есть бронь' } }, 409)
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
let bridge: { navigate: ReturnType<typeof useNavigate>; store: ReturnType<typeof useStore> }
function Controls() { const navigate = useNavigate(), store = useStore(); useEffect(() => { bridge = { navigate, store } }, [navigate, store]); return null }
let unexpected: string[] = []

function mount(initialSlot: ServerSlot = oldSlot) {
  const calls: Call[] = []
  const state = { slot: initialSlot, role: 'couple', policy: { mode: 'legacy_day', revision: '5' }, commit: noCommit }
  let hold: { stage: Stage; pending: ReturnType<typeof deferred<Reply>> } | null = null
  let write: (call: Call) => Reply | Promise<Reply> = refusal
  const stages: Record<string, Stage> = { '/weddings': 'roles', [SLOT_PATH]: 'slots', [POLICY_PATH]: 'policy', [COMMIT_PATH]: 'commitments' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!
    const call = { method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(String(init.body)) as unknown : null, headers: new Headers(init?.headers), signal: init?.signal }
    calls.push(call)
    if (call.method === 'POST' && path === REPLACE_PATH) { const reply = await write(call); return reply instanceof Response ? reply : response(reply) }
    if (call.method !== 'GET') { unexpected.push(`${call.method} ${path}`); throw new Error(`UNEXPECTED ${call.method} ${path}`) }
    if (hold && stages[path] === hold.stage) { const pending = hold.pending; hold = null; const reply = await pending.promise; return reply instanceof Response ? reply : response(reply) }
    let value: unknown
    if (path === '/weddings') value = [{ ...wedding, role: state.role }, { ...wedding, id: W2, role: 'couple' }]
    else if (path === `/weddings/${W}` || path === `/weddings/${W2}`) value = wedding
    else if (path === SLOT_PATH || path === `/weddings/${W2}/slots`) value = [state.slot]
    else if (path === `/weddings/${W}/slots/${S}/shortlist` || path === `/weddings/${W2}/slots/${S}/shortlist`) value = [V2, V3].map((id, i) => ({ id: `candidate-${i}`, slotId: S, position: i + 1, available: true, occupancy: 'free', vendor: { ...vendor, id, bookingMode: 'legacy_day' } }))
    else if (path === POLICY_PATH || path === `/vendors/${V3}/booking-policy`) value = state.policy
    else if (path === COMMIT_PATH) value = state.commit
    else if (path === `/catalog/vendors/${V2}` || path === `/catalog/vendors/${V3}`) value = { ...vendor, id: path.endsWith(V3) ? V3 : V2 }
    else if (path === `/catalog/vendors/${V2}/availability` || path === `/catalog/vendors/${V3}/availability`) value = { busyDates: [], holdDates: [] }
    else if (path === `/catalog/vendors/${V2}/reviews` || path === `/catalog/vendors/${V3}/reviews`) value = { items: [], nextCursor: null }
    else if (path === '/catalog/categories') value = [{ id: 'photo', title: 'Фотограф', icon: '📷' }]
    else if (path === '/catalog/vendors') value = { items: [], nextCursor: null }
    else if (path === '/me/favorites') value = []
    else if (path === '/vendor/profile') return response({ error: { code: 'not_found', message: 'Нет анкеты' } }, 404)
    else { unexpected.push(`${call.method} ${path}`); throw new Error(`UNEXPECTED ${call.method} ${path}`) }
    return response(value)
  }))
  const view = render(<MemoryRouter initialEntries={[`/vendor/${V2}?replaceSlot=${S}`]}><StoreProvider><Controls /><Routes><Route path="/vendor/:id" element={<VendorDetail />} /><Route path="/away" element={<p>Другой экран</p>} /></Routes></StoreProvider></MemoryRouter>)
  return { ...view, calls, state, writes: () => calls.filter(c => c.method !== 'GET'), setWrite: (f: typeof write) => { write = f }, hold: (stage: Stage) => { const pending = deferred<Reply>(); hold = { stage, pending }; return pending } }
}
async function start(view: ReturnType<typeof mount>) {
  const button = await screen.findByRole('button', { name: 'Заменить в свадьбе' })
  await waitFor(() => expect(view.calls.filter(c => c.path === POLICY_PATH)).toHaveLength(1))
  return button
}
const readCount = (view: ReturnType<typeof mount>, path: string) => view.calls.filter(c => c.method === 'GET' && c.path === path).length
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
beforeEach(() => {
  unexpected = []; localStorage.clear(); localStorage.setItem('tt_onboarded', '1'); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); expect(unexpected).toEqual([]) })

describe('Atomic legacy replacement · controlled rendered contract', () => {
  it('success sends the exact one command with caller key and fresh reads in order', async () => {
    const view = mount(); view.setWrite(() => { view.state.slot = newSlot; return response(newSlot, 201) })
    const button = await start(view); const before = view.calls.length; fireEvent.click(button)
    expect((await screen.findByRole('status')).textContent).toContain('Подрядчик заменён')
    expect(view.writes()).toHaveLength(1); expect(view.writes()[0]!.body).toEqual(expectedBody)
    expect(view.writes()[0]!.path).toBe(REPLACE_PATH); expect(view.writes()[0]!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i)
    expect(view.writes()[0]!.headers.get('authorization')).toBe('Bearer a')
    expect(view.calls.slice(before, before + 5).map(c => c.path)).toEqual(['/weddings', SLOT_PATH, POLICY_PATH, COMMIT_PATH, REPLACE_PATH])
    await waitFor(() => expect(readCount(view, SLOT_PATH)).toBe(3))
  })
  it('definite refusal keeps the controlled selected root and never uses cancel/book', async () => {
    const view = mount(); fireEvent.click(await start(view))
    expect((await screen.findByRole('alert')).textContent).toContain('На эту дату уже есть бронь')
    await waitFor(() => expect(readCount(view, SLOT_PATH)).toBe(3))
    expect(view.state.slot).toEqual(oldSlot); expect(view.writes().map(c => c.path)).toEqual([REPLACE_PATH])
    expect(screen.queryByRole('status')).toBeNull(); expect(screen.getByRole('alert').textContent).not.toMatch(/Старая бронь уже отменена/)
  })
  it.each(['paid deposit', 'external', 'released resources'])('%s legacy source uses the exact atomic route', async kind => {
    const source: ServerSlot = kind === 'paid deposit' ? { ...oldSlot, tileState: 'paid', deal: { ...oldSlot.deal, state: 'paid_deposit', paid: { amount: 50000, currency: 'RUB' } } }
      : kind === 'external' ? { ...oldSlot, deal: { ...oldSlot.deal, vendor: null, externalName: 'Знакомый фотограф' } } : oldSlot
    const view = mount(source)
    if (kind === 'released resources') view.state.commit = { ...noCommit, revision: '4', state: 'released', reservation: 'released' }
    view.setWrite(() => { view.state.slot = newSlot; return newSlot }); fireEvent.click(await start(view))
    await screen.findByRole('status'); expect(view.writes()).toHaveLength(1)
    expect(view.writes()[0]!.body).toEqual({ ...expectedBody, expectedSelectedDealState: kind === 'paid deposit' ? 'paid_deposit' : 'booked' })
    expect(view.writes()[0]!.path).toBe(REPLACE_PATH)
    expect(readCount(view, COMMIT_PATH)).toBe(kind === 'external' ? 0 : 1)
  })
  it.each(['network', 'timeout', '503', 'in_progress', 'malformed', 'missing_id', 'same_old_id', 'invalid_id', 'whitespace_id', 'uppercase_old_id'] as const)('%s outcome uses manual same-body/key retry and fresh reads without false preservation', async kind => {
    const view = mount(); let attempts = 0
    view.setWrite(() => { attempts++; if (attempts > 1) { view.state.slot = newSlot; return newSlot }
      if (kind === 'network') throw new TypeError('connection lost')
      if (kind === 'timeout') throw new DOMException('aborted', 'AbortError')
      if (kind === '503') return response({ error: { code: 'unavailable', message: 'Недоступно' } }, 503)
      if (kind === 'in_progress') return response({ error: { code: 'idempotency_in_progress', message: 'Подождите' } }, 409)
      if (kind === 'missing_id') return { id: S, deal: { state: 'booked', vendor: { id: V2 } } }
      if (kind === 'same_old_id') return { ...newSlot, deal: { ...newSlot.deal, id: OLD } }
      if (kind === 'invalid_id') return { ...newSlot, deal: { ...newSlot.deal, id: 'not-a-uuid' } }
      if (kind === 'whitespace_id') return { ...newSlot, deal: { ...newSlot.deal, id: ' ' } }
      if (kind === 'uppercase_old_id') return { ...newSlot, deal: { ...newSlot.deal, id: OLD.toUpperCase() } }
      return { id: S, deal: { state: 'booked', vendor: { id: V1 } } }
    })
    fireEvent.click(await start(view)); const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Результат замены пока не подтверждён'); expect(alert.textContent).not.toMatch(/сохранена|отменена/)
    await waitFor(() => expect(readCount(view, SLOT_PATH)).toBe(3))
    await flush(); expect(view.writes()).toHaveLength(1) // No automatic/background retry.
    const before = view.calls.length; fireEvent.click(screen.getByRole('button', { name: 'Проверить и повторить замену' }))
    expect((await screen.findByRole('status')).textContent).toContain('Подрядчик заменён')
    expect(view.writes()).toHaveLength(2); expect(view.writes()[1]!.body).toEqual(view.writes()[0]!.body)
    expect(view.writes()[1]!.headers.get('Idempotency-Key')).toBe(view.writes()[0]!.headers.get('Idempotency-Key'))
    expect(view.calls.slice(before, before + 5).map(c => c.path)).toEqual(['/weddings', SLOT_PATH, POLICY_PATH, COMMIT_PATH, REPLACE_PATH])
  })
  it('response loss may already have changed the root; fresh read prevents a second replacement', async () => {
    const view = mount(); view.setWrite(() => { view.state.slot = newSlot; throw new TypeError('lost success') })
    fireEvent.click(await start(view)); expect((await screen.findByRole('alert')).textContent).not.toMatch(/сохранена|отменена/)
    await waitFor(() => expect(readCount(view, SLOT_PATH)).toBe(3)); await flush()
    expect(view.state.slot).toEqual(newSlot); expect(view.writes()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Проверить и повторить замену' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('the actual client timeout aborts the controlled fetch and offers manual same-key retry', async () => {
    const view = mount(); const button = await start(view); let attempts = 0
    view.setWrite(call => ++attempts === 1 ? new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true })
    }) : newSlot)
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(button); await vi.advanceTimersByTimeAsync(0) })
    expect(view.writes()).toHaveLength(1); expect(view.writes()[0]!.signal?.aborted).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) }); vi.useRealTimers()
    expect(view.writes()[0]!.signal?.aborted).toBe(true)
    expect((await screen.findByRole('alert')).textContent).toContain('Результат замены пока не подтверждён')
    fireEvent.click(screen.getByRole('button', { name: 'Проверить и повторить замену' })); await screen.findByRole('status')
    expect(view.writes()).toHaveLength(2); expect(view.writes()[1]!.body).toEqual(view.writes()[0]!.body)
    expect(view.writes()[1]!.headers.get('Idempotency-Key')).toBe(view.writes()[0]!.headers.get('Idempotency-Key'))
  })
  it('a changed selected root returned by the manual retry fresh read prevents a second write', async () => {
    const view = mount(); view.setWrite(() => response({}, 503)); fireEvent.click(await start(view)); await screen.findByRole('alert')
    await waitFor(() => expect(readCount(view, SLOT_PATH)).toBe(3))
    view.state.slot = newSlot // The rendered Store is still the previous root until this explicit fresh read.
    fireEvent.click(screen.getByRole('button', { name: 'Проверить и повторить замену' }))
    expect((await screen.findByText('Выбранный заказ изменился — обновите позицию')).textContent).toContain('изменился')
    expect(view.writes()).toHaveLength(1)
  })
  it('double click while current role read is pending sends only one command', async () => {
    const view = mount(); const button = await start(view); const pending = view.hold('roles')
    fireEvent.click(button); fireEvent.click(button)
    await flush(); expect(view.writes()).toHaveLength(0)
    pending.resolve([{ ...wedding, role: 'couple' }]); await screen.findByRole('alert')
    expect(view.writes().map(c => c.path)).toEqual([REPLACE_PATH])
  })
  it.each(['helper', 'coordinator', 'vendor', 'missing'])('fresh role %s refuses before policy and write', async role => {
    const view = mount(); const button = await start(view); const pending = view.hold('roles'); fireEvent.click(button)
    pending.resolve(role === 'missing' ? [] : [{ ...wedding, role }])
    expect((await screen.findByRole('alert')).textContent).toContain('Замену брони может подтвердить только пара')
    expect(view.writes()).toEqual([]); expect(readCount(view, POLICY_PATH)).toBe(1)
  })
  it.each(['root', 'state'])('fresh selected %s changed refuses without write', async change => {
    const view = mount(); const button = await start(view)
    view.state.slot = { ...oldSlot, deal: { ...oldSlot.deal, ...(change === 'root' ? { id: NEW } : { state: 'done' }) } }
    fireEvent.click(button); expect((await screen.findByRole('alert')).textContent).toContain('Выбранный заказ изменился')
    expect(view.writes()).toEqual([]); expect(readCount(view, POLICY_PATH)).toBe(1)
  })
  it.each(['new resources', 'old reserved', 'unknown old', 'unknown policy'])('%s precheck refuses without legacy mutation', async kind => {
    const view = mount(); const button = await start(view)
    if (kind === 'new resources') view.state.policy.mode = 'resources'
    if (kind === 'old reserved') view.state.commit = { ...noCommit, revision: '1', state: 'reserved', reservation: 'reserved' }
    if (kind === 'unknown old') view.state.commit = { ...noCommit, state: 'available' }
    if (kind === 'unknown policy') view.state.policy.revision = '01'
    fireEvent.click(button); expect((await screen.findByRole('alert')).textContent).toMatch(/ресурсы|не подтверждена|не подтверждён/)
    expect(view.writes()).toEqual([]); expect(view.state.slot).toEqual(oldSlot)
  })
  it('policy revision change after uncertainty does not silently change the immutable retry command', async () => {
    const view = mount(); view.setWrite(() => response({}, 503)); fireEvent.click(await start(view)); await screen.findByRole('alert')
    await waitFor(() => expect(readCount(view, SLOT_PATH)).toBe(3)); view.state.policy.revision = '6'
    fireEvent.click(screen.getByRole('button', { name: 'Проверить и повторить замену' }))
    expect((await screen.findByText('Способ бронирования изменился — обновите анкету')).textContent).toContain('изменился')
    expect(view.writes()).toHaveLength(1)
  })
  it('changing the package after uncertainty creates a different intent and a fresh caller key', async () => {
    const view = mount(); let attempts = 0; view.setWrite(() => ++attempts === 1 ? response({}, 503) : refusal())
    fireEvent.click(await start(view)); await screen.findByRole('alert'); await waitFor(() => expect(readCount(view, SLOT_PATH)).toBe(3))
    fireEvent.click(screen.getByRole('button', { name: /Короткий день/ })); fireEvent.click(screen.getByRole('button', { name: 'Проверить и повторить замену' }))
    await screen.findByText(/На эту дату уже есть бронь/); expect(view.writes()).toHaveLength(2)
    expect(view.writes()[1]!.body).toEqual({ ...expectedBody, packageId: P2, price: { amount: 100000, currency: 'RUB' } })
    expect(view.writes()[1]!.headers.get('Idempotency-Key')).not.toBe(view.writes()[0]!.headers.get('Idempotency-Key'))
  })
  for (const stage of ['roles', 'slots', 'policy', 'commitments'] as const) {
    for (const change of ['package', 'company', 'wedding', 'root', 'state', 'session', 'logout', 'unmount'] as const) {
      it(`${change} change while ${stage} is awaited cannot send a stale command`, async () => {
        const view = mount(); const button = await start(view); const pending = view.hold(stage); fireEvent.click(button)
        const path = { roles: '/weddings', slots: SLOT_PATH, policy: POLICY_PATH, commitments: COMMIT_PATH }[stage]
        await waitFor(() => expect(readCount(view, path)).toBeGreaterThan(stage === 'commitments' ? 0 : stage === 'roles' ? 2 : 1))
        if (change === 'package') fireEvent.click(screen.getByRole('button', { name: /Короткий день/ }))
        if (change === 'company') act(() => bridge.navigate(`/vendor/${V3}?replaceSlot=${S}`))
        if (change === 'wedding') act(() => bridge.store.setWeddingId(W2))
        if (change === 'root' || change === 'state') {
          view.state.slot = { ...oldSlot, deal: { ...oldSlot.deal, ...(change === 'root' ? { id: NEW } : { state: 'done' }) } }
          const before = readCount(view, SLOT_PATH); act(() => bridge.store.refreshSlots())
          await waitFor(() => expect(readCount(view, SLOT_PATH)).toBeGreaterThan(before)); await flush()
        }
        if (change === 'session') act(() => saveTokens({ accessToken: 'different-session', refreshToken: 'different-refresh' }))
        if (change === 'logout') act(() => { saveTokens(null); bridge.store.forgetSession() })
        if (change === 'unmount') view.unmount()
        await flush()
        pending.resolve(stage === 'roles' ? [{ ...wedding, role: 'couple' }] : stage === 'slots' ? [oldSlot] : stage === 'policy' ? { mode: 'legacy_day', revision: '5' } : noCommit)
        await flush(); await flush()
        expect(view.writes()).toEqual([]); expect(screen.queryByRole('status')).toBeNull()
      })
    }
  }
})
