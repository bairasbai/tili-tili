// @vitest-environment jsdom
// Controlled fetch only: Store, SlotDetail, offer forms/wrappers/client are real.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from './store'
import { saveTokens } from './api/client'
import { setI18nLang } from './i18n'
import { SlotDetail } from '@/pages/Wedding'

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), S = id(2), S2 = id(3), LEGACY = id(4), EVENT = id(5), ENTRY = id(6), VENDOR = id(7), OFFER = id(8), REQUEST = id(9)
const MAIN_DATE = '2030-06-14', EVENT_DATE = '2030-06-15'
const MAIN_TZ = 'Pacific/Honolulu', EVENT_TZ = 'Pacific/Kiritimati'
const token = (serial: number) => `header.${btoa(JSON.stringify({ sub: id(20), sid: id(30), serial }))}.signature`
const A = { accessToken: token(1), refreshToken: 'r0-synthetic-refresh-A' }
const RENEWED = { accessToken: token(2), refreshToken: 'r0-synthetic-refresh-A-renewed' }
type Context = { id: string; name: string; kind: string; date: string | null; timeZone: string | null; location: string | null; isMain: boolean }
const context = (patch: Partial<Context> = {}): Context => ({ id: EVENT, name: 'Дополнительная церемония', kind: 'ceremony', date: EVENT_DATE, timeZone: EVENT_TZ, location: 'Зал дополнительного события', isMain: false, ...patch })
type Call = { method: string; path: string; body: unknown; raw: string | null; headers: Headers }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Synthetic expired original' } }, 401)
const settle = () => new Promise<void>(done => setTimeout(done, 0))

function network(options: { programEvent?: Context | null; requestProgramEvent?: Context | null; implicit?: boolean; requestDate?: string; validUntil?: string; hold?: 'accept' | 'request' } = {}) {
  let event = options.programEvent === undefined ? context() : options.programEvent
  // Saved request material is captured once, independently from later actual
  // slot/event updates. NULL is explicit historical legacy material only.
  const requestProgramEvent = options.implicit || options.requestProgramEvent === null
    ? null : Object.freeze({ ...(options.requestProgramEvent ?? event ?? context()) })
  let accepted = false
  const calls: Call[] = [], unexpected: string[] = [], original = deferred<Response>()
  const vendor = { id: VENDOR, name: 'Исполнитель церемонии', categoryId: 'photo', city: 'Уфа', priceFrom: null, rating: null, reviewsCount: 0, photoUrl: null, verified: false, hasVideo: false, packages: [] }
  const offered = () => ({ id: REQUEST, status: 'open', weddingDate: options.requestDate ?? EVENT_DATE, programEvent: requestProgramEvent, guests: 60, city: 'Уфа', wishes: 'Сохранённые пожелания', createdAt: '2029-01-01T10:00:00.000Z', offer: { id: OFFER, requestId: REQUEST, kind: 'offer', packageId: null, title: 'Условия дополнительной церемонии', price: { amount: 1234567, currency: 'RUB' }, includes: ['Репортаж'], comparisonTerms: null, message: null, validUntil: options.validUntil ?? '2099-12-31' } })
  const slot = (slotId = S) => ({ id: slotId, categoryId: 'photo', label: slotId === S ? 'Выбранная дополнительная позиция' : 'Соседняя позиция', tileState: accepted && slotId === S ? 'booked' : 'empty', prebooked: false,
    ...(slotId === LEGACY || (slotId === S && options.implicit) ? {} : { programEvent: slotId === S ? event : context({ id: id(15), date: '2030-06-16', timeZone: 'Europe/Moscow' }) }),
    deal: accepted && slotId === S ? { id: id(40), state: 'booked', vendor: { ...vendor, name: 'Бронь старого контекста' }, price: { amount: 1234567, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } } : null })
  const isWrite = (c: Call) => c.method === 'POST' && (c.path.endsWith('/accept') || c.path.endsWith('/offer-requests'))
  const writes = () => calls.filter(isWrite), refreshes = () => calls.filter(c => c.path === '/auth/refresh')
  const success = (kind: 'accept' | 'request') => {
    if (kind === 'accept') { accepted = true; return json(slot()) }
    return json({ results: [{ entryId: ENTRY, status: 'sent', requestId: REQUEST }] }, 201)
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, ''), raw = init?.body == null ? null : String(init.body)
    const call: Call = { path, method: init?.method ?? 'GET', raw, body: raw === null ? null : JSON.parse(raw), headers: new Headers(init?.headers) }; calls.push(call)
    if (path === '/auth/refresh' && call.method === 'POST') return json(RENEWED)
    if (isWrite(call)) {
      const kind = path.endsWith('/accept') ? 'accept' : 'request'
      if (options.hold === kind && writes().length === 1) return original.promise
      return success(kind)
    }
    if (call.method === 'GET' && path === '/weddings') return json([{ id: W, role: 'couple', title: 'Основная свадьба', date: MAIN_DATE, tz: MAIN_TZ }])
    if (call.method === 'GET' && path === `/weddings/${W}`) return json({ id: W, title: 'Основная свадьба', date: MAIN_DATE, tz: MAIN_TZ })
    if (call.method === 'GET' && path === `/weddings/${W}/slots`) return json([slot(), slot(S2), slot(LEGACY)])
    if (call.method === 'GET' && path === `/weddings/${W}/slots/${S}/shortlist`) return json([{ id: ENTRY, slotId: S, position: 1, createdAt: '2029-01-01T10:00:00.000Z', available: true, availabilityObservation: { source: 'legacy_day', date: options.requestDate ?? EVENT_DATE, checkedAt: '2030-06-14T10:00:00.000Z' }, occupancy: 'free', vendor, request: offered() }])
    if (call.method === 'GET' && path === '/me/favorites') return json([])
    if (call.method === 'GET' && path === '/health') return json({ status: 'ok' })
    unexpected.push(`${call.method} ${path}`); return json({ error: { code: 'unexpected_test_route', message: 'Unregistered test fetch' } }, 500)
  }))
  return { calls, unexpected, original, writes, refreshes, success, setEvent: (next: Context | null) => { event = next }, slotReads: () => calls.filter(c => c.method === 'GET' && c.path === `/weddings/${W}/slots`) }
}

function Probe() {
  const { slots, slotsState, refreshSlots } = useStore(), { id: selected } = useParams()
  return <><output data-testid="slot-read-state">{slotsState}</output><output data-testid="store-slots">{JSON.stringify(slots)}</output><output data-testid="selected-slot">{selected}</output><button onClick={refreshSlots}>Тест: свежий контекст позиции</button></>
}
function mount(detail = true) {
  return render(<MemoryRouter initialEntries={[`/wedding/slot/${S}`]}><StoreProvider><Routes><Route path="/wedding/slot/:id" element={<><Probe />{detail && <SlotDetail />}</>} /></Routes></StoreProvider></MemoryRouter>)
}
async function ready() { await waitFor(() => expect(screen.getByTestId('slot-read-state').textContent).toBe('ready')) }
const storeSlots = () => JSON.parse(screen.getByTestId('store-slots').textContent!) as { id: string; categoryId: string; programEvent?: Context | null }[]
async function clickEnabled(name: string | RegExp) { const b = await screen.findByRole('button', { name }); await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(b) }
async function changeContext(h: ReturnType<typeof network>, next: Context) {
  const reads = h.slotReads().length; h.setEvent(next); fireEvent.click(screen.getByRole('button', { name: 'Тест: свежий контекст позиции' }))
  await waitFor(() => expect(h.slotReads().length).toBeGreaterThan(reads)); await act(async () => { await settle(); await settle() })
}
let active: ReturnType<typeof network> | null = null
beforeEach(() => {
  localStorage.clear(); saveTokens(A); localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify(MAIN_DATE)); setI18nLang('ru')
  // Honolulu is still June14; Kiritimati is already June15. Real timers stay live.
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-06-14T10:30:00.000Z'))
})
afterEach(() => { cleanup(); saveTokens(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); if (active) expect(active.unexpected).toEqual([]); active = null })
const serve = (options: Parameters<typeof network>[0] = {}) => { active = network(options); return active }

describe('R0 real Store and mounted SlotDetail event context', () => {
  it('preserves explicit object/null and omits programEvent only for implicit legacy slots', async () => {
    const h = serve(); mount(false); await ready()
    const own = storeSlots().find(s => s.id === S)!, legacy = storeSlots().find(s => s.id === LEGACY)!
    expect(own).toMatchObject({ id: S, categoryId: 'photo', programEvent: context() })
    expect(Object.hasOwn(legacy, 'programEvent')).toBe(false)
    await changeContext(h, context({ date: null, timeZone: null })); expect(storeSlots().find(s => s.id === S)?.programEvent).toEqual(context({ date: null, timeZone: null }))
    h.setEvent(null); fireEvent.click(screen.getByRole('button', { name: 'Тест: свежий контекст позиции' }))
    await waitFor(() => expect(storeSlots().find(s => s.id === S)?.programEvent).toBeNull())
  })
  it('uses the selected additional date in real Summary/Acceptance, even with another same-category slot and a different main date', async () => {
    serve(); mount(); await screen.findByText('Условия дополнительной церемонии')
    expect(screen.queryByText('На прежнюю дату — запросите заново')).toBeNull()
    await screen.findByRole('button', { name: 'Принять предложение: Условия дополнительной церемонии' })
    expect(screen.getByTestId('selected-slot').textContent).toBe(S)
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
    expect(storeSlots().find(s => s.id === S2)?.programEvent?.date).toBe('2030-06-16')
  })
  it('expires in the explicit event timezone at the real date boundary rather than the main wedding timezone', async () => {
    serve({ validUntil: '2030-06-14' }); mount(); await screen.findByText('Условия дополнительной церемонии')
    expect(await screen.findByText('Срок предложения истёк')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
  })
  it.each([
    ['unresolved explicit', null], ['unknown date', context({ date: null })], ['unknown timezone', context({ date: MAIN_DATE, timeZone: null })],
  ] as const)('%s cannot borrow main date/timezone to accept the old dated quote', async (_label, programEvent) => {
    serve({ programEvent, requestProgramEvent: _label === 'unknown timezone' ? null : context({ date: MAIN_DATE }), requestDate: MAIN_DATE, validUntil: _label === 'unknown timezone' ? '2030-06-13' : '2099-12-31' }); mount(); await screen.findByText('Условия дополнительной церемонии')
    expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    const request = screen.queryByRole('button', { name: 'Запросить предложение' })
    if (request) expect((request as HTMLButtonElement).disabled).toBe(_label !== 'unknown date')
    if (_label === 'unknown timezone') expect(screen.queryByText('Срок предложения истёк')).toBeNull()
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
  })
  it('a known historical snapshot governs expiry in its saved timezone even when the actual event timezone is unknown', async () => {
    const h = serve({ programEvent: context({ date: MAIN_DATE, timeZone: null }),
      requestProgramEvent: context({ date: MAIN_DATE }), requestDate: MAIN_DATE, validUntil: '2030-06-14' })
    mount(); await screen.findByText('Условия дополнительной церемонии')
    expect(await screen.findByText('Срок предложения истёк')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    expect(h.writes()).toHaveLength(0); expect(h.refreshes()).toHaveLength(0)
    expect(storeSlots().find(s => s.id === S)?.programEvent?.timeZone).toBeNull()
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
  })
  it('retires an actual held401 accept on event date update before refresh/retry, with no stale follow-up UI', async () => {
    const h = serve({ programEvent: context({ date: MAIN_DATE }), requestDate: MAIN_DATE, hold: 'accept' }); mount()
    await clickEnabled('Принять предложение: Условия дополнительной церемонии'); expect(h.writes()).toHaveLength(1)
    const response = unauthorized(); await changeContext(h, context({ date: EVENT_DATE }))
    const reads = h.slotReads().length
    await act(async () => { h.original.resolve(response); await settle(); await settle() })
    expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1); expect(h.slotReads()).toHaveLength(reads)
    expect(response.bodyUsed || response.body?.locked).toBeTruthy(); expect(screen.queryByText('Бронь старого контекста')).toBeNull()
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(A)
  })
  it('does not publish an actual held200 accept or re-read after only the event timezone changes', async () => {
    const h = serve({ programEvent: context({ date: MAIN_DATE, timeZone: MAIN_TZ }), requestDate: MAIN_DATE, hold: 'accept' }); mount()
    await clickEnabled('Принять предложение: Условия дополнительной церемонии'); expect(h.writes()).toHaveLength(1)
    await changeContext(h, context({ date: MAIN_DATE, timeZone: EVENT_TZ })); const reads = h.slotReads().length
    const response = h.success('accept')
    await act(async () => { h.original.resolve(response); await settle(); await settle() })
    expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0); expect(h.slotReads()).toHaveLength(reads)
    expect(response.bodyUsed || response.body?.locked).toBeTruthy(); expect(screen.queryByText('Бронь старого контекста')).toBeNull()
    expect(screen.queryByText('Бронь создана по условиям предложения')).toBeNull()
  })
  it('retains implicit-main same-sub/sid refresh with exact offer path/body/key and no client price/date authority', async () => {
    const h = serve({ implicit: true, requestDate: MAIN_DATE, hold: 'accept' }); mount()
    expect(await screen.findByText('Условия дополнительной церемонии')).toBeTruthy(); expect(screen.queryByText('На прежнюю дату — запросите заново')).toBeNull()
    await clickEnabled('Принять предложение: Условия дополнительной церемонии')
    await act(async () => { h.original.resolve(unauthorized()); await settle() })
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    expect(h.refreshes().map(c => c.body)).toEqual([{ refreshToken: A.refreshToken }])
    const [first, retry] = h.writes(); expect(first).toMatchObject({ method: 'POST', path: `/weddings/${W}/offers/${OFFER}/accept`, body: {} })
    expect(retry!.path).toBe(first!.path); expect(retry!.raw).toBe(first!.raw)
    expect(first!.headers.get('Idempotency-Key')).toBeTruthy(); expect(retry!.headers.get('Idempotency-Key')).toBe(first!.headers.get('Idempotency-Key'))
    expect(first!.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`); expect(retry!.headers.get('authorization')).toBe(`Bearer ${RENEWED.accessToken}`)
    await screen.findByText('Бронь старого контекста')
  })
  it('a changed event context retires an uncertain composer key without adding date/price to the request wire', async () => {
    const h = serve({ programEvent: context({ date: MAIN_DATE }), requestDate: MAIN_DATE, hold: 'request' }); mount()
    await clickEnabled('Запросить предложение'); await clickEnabled('Отправить запрос'); expect(h.writes()).toHaveLength(1)
    await act(async () => { h.original.reject(new TypeError('Synthetic lost response')); await settle() })
    await screen.findByRole('alert')
    const first = h.writes()[0]!; await changeContext(h, context({ date: EVENT_DATE }))
    const send = screen.queryByRole('button', { name: 'Отправить запрос' })
    if (!send) await clickEnabled('Запросить предложение')
    await clickEnabled('Отправить запрос'); await waitFor(() => expect(h.writes()).toHaveLength(2))
    const next = h.writes()[1]!
    expect(first.body).toEqual({ entryIds: [ENTRY] }); expect(next.body).toEqual(first.body)
    expect(next.path).toBe(`/weddings/${W}/slots/${S}/offer-requests`)
    expect(first.headers.get('Idempotency-Key')).toBeTruthy(); expect(next.headers.get('Idempotency-Key')).not.toBe(first.headers.get('Idempotency-Key'))
  })
})
