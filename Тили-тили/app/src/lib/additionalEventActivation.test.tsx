// @vitest-environment jsdom
// Independent SOURCE-authored regressions: real pages/Store/components/client.
// Only fetch and Date.now are controlled; this proves no native ACL or booking.
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider, useStore } from './store'
import { saveTokens } from './api/client'
import type { components } from './api/schema'
import type { OfferRequest } from './api/offers'
import type { ShortlistEntry } from './api/shortlist'
import { setI18nLang } from './i18n'
import { OfferRequestComposer } from '@/components/OfferRequestComposer'
import { OfferAcceptance } from '@/components/OfferAcceptance'
import { OfferSummary } from '@/components/OfferSummary'
import { VendorDetail } from '@/pages/Search'
import { SlotDetail } from '@/pages/Wedding'
import { Deal } from '@/pages/Tools'
import { VendorDeals } from '@/pages/VendorApp'
import { Compare } from '@/pages/Smart'

const id = (n: number) => `82000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), MAIN = id(2), EXTRA = id(3), EV = id(4), MAIN_EV = id(5), V = id(6), OLD_V = id(7), P = id(8), D = id(9), OLD_D = id(10), ENTRY = id(11), REQUEST = id(12), OFFER = id(13)
const MAIN_DATE = '2030-06-14', EXTRA_DATE = '2030-08-15'
type Context = components['schemas']['SlotProgramEvent']
const event = (patch: Partial<Context> = {}): Context => ({ id: EV, name: 'Ужин дополнительного дня', kind: 'second_day', date: EXTRA_DATE, timeZone: 'Pacific/Kiritimati', location: 'Второй зал', isMain: false, ...patch })
const pin = (e: Context) => ({ id: e.id, date: e.date, timeZone: e.timeZone })
const token = (sub: number, sid: number, serial = 0) => `header.${btoa(JSON.stringify({ sub: id(sub), sid: id(sid), serial }))}.signature`
const A = { accessToken: token(90, 91), refreshToken: 'activation-A-refresh' }
const B = { accessToken: token(92, 93), refreshToken: 'activation-B-refresh' }
const RENEWED = { accessToken: token(90, 91, 1), refreshToken: 'activation-A-renewed' }
const wedding = { id: W, title: 'Основная свадьба', date: MAIN_DATE, tz: 'Pacific/Honolulu', role: 'couple', city: { name: 'Уфа', region: 'Башкортостан' } }
const vendor = { id: V, name: 'Студия дополнительного дня', categoryId: 'photo', city: 'Уфа', bookingMode: 'legacy_day' as const, priceFrom: { amount: 150000, currency: 'RUB' as const }, rating: 4.9, reviewsCount: 3, verified: false, hasVideo: false, photoUrl: null, about: 'Синтетическая анкета', phone: null, gallery: [], media: [], packages: [{ id: P, name: 'Съёмка ужина', price: { amount: 150000, currency: 'RUB' as const }, includes: ['Репортаж'] }] }
type QuotedRequest = OfferRequest & { offer: Extract<NonNullable<OfferRequest['offer']>, { kind: 'offer' }> }
function offered(context = event()): QuotedRequest {
  return { id: REQUEST, status: 'open', weddingDate: context.date, programEvent: context, guests: 60, city: 'Уфа', wishes: 'Ужин', createdAt: '2030-01-01T10:00:00.000Z',
    offer: { id: OFFER, requestId: REQUEST, kind: 'offer', packageId: null, title: 'Сохранённая съёмка ужина', price: { amount: 314159, currency: 'RUB' }, includes: ['Репортаж'], message: null, validUntil: '2099-12-31', comparisonTerms: null } }
}
function entry(context = event()): ShortlistEntry {
  return { id: ENTRY, slotId: EXTRA, position: 1, createdAt: '2030-01-01T10:00:00.000Z', available: true, occupancy: context.date ? 'free' : null,
    availabilityObservation: context.date ? { source: 'legacy_day', date: context.date, checkedAt: '2030-06-14T10:30:00.000Z' } : null, vendor, request: offered(context) }
}
// Independently controlled current GET facts; never derived from a saved quote.
const serverMainEvent = (): components['schemas']['WeddingEvent'] => ({ id: MAIN_EV, name: 'Основная церемония', kind: 'ceremony',
  date: MAIN_DATE, timeZone: 'Pacific/Honolulu', location: 'Основной зал', isMain: true, rsvpDeadline: null })
function implicitMainEntry(): ShortlistEntry {
  return { ...entry(), slotId: MAIN,
    availabilityObservation: { source: 'legacy_day', date: MAIN_DATE, checkedAt: '2030-06-14T10:30:00.000Z' },
    request: offered({ id: MAIN_EV, name: 'Основная церемония', kind: 'ceremony', date: MAIN_DATE,
      timeZone: 'Pacific/Honolulu', location: 'Основной зал', isMain: true }) }
}
type Door = 'book' | 'external' | 'advance' | 'request' | 'accept' | 'replace'
type Call = { method: string; path: string; query: string; rawBody: string | null; headers: Headers; response?: Response }
const json = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Synthetic expired access' } }, 401)
function held<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void, settled = false
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, get settled() { return settled }, resolve(value: T) { if (!settled) { settled = true; resolve(value) } }, reject(reason: Error) { if (!settled) { settled = true; reject(reason) } } }
}
type Network = ReturnType<typeof network>
let active: Network | null = null
let bridge: ReturnType<typeof useStore> | null = null
function network(door: Door = 'book', main = false, implicitMain = false, comparison = false, mainDate: string | null = MAIN_DATE) {
  let current: Context | null | undefined = event(), firstPending = false
  const pending = held<Response>(), calls: Call[] = [], unexpected: string[] = []
  let mainRecord = { ...serverMainEvent(), date: mainDate }
  const currentWedding = { ...wedding, date: mainDate }
  const selected = main ? MAIN : EXTRA
  const path = door === 'advance' ? `/deals/${D}` : door === 'request' ? `/weddings/${W}/slots/${selected}/offer-requests`
    : door === 'accept' ? `/weddings/${W}/offers/${OFFER}/accept` : `/weddings/${W}/slots/${selected}/${door}`
  const slots = () => [
    { id: MAIN, categoryId: 'photo', label: 'Фотограф основной церемонии', tileState: 'empty', deal: null,
      ...(implicitMain ? {} : { programEvent: { ...event(), id: MAIN_EV, date: mainDate, timeZone: wedding.tz, isMain: true, name: 'Основная церемония' } }) },
    { id: EXTRA, categoryId: 'photo', label: 'Фотограф дополнительного ужина', tileState: door === 'replace' ? 'booked' : door === 'advance' ? 'hold' : 'empty', programEvent: current,
      deal: door === 'replace' ? { id: OLD_D, state: 'booked', vendor: { id: OLD_V, name: 'Прежняя студия' }, price: { amount: 246800, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } }
        : door === 'advance' ? { id: D, state: 'negotiating', vendor: { id: V, name: vendor.name }, price: { amount: 150000, currency: 'RUB' } } : null },
  ].map(s => door === 'advance' && main ? { ...s, deal: s.id === MAIN ? { id: D, state: 'negotiating', vendor: { id: V, name: vendor.name }, price: { amount: 150000, currency: 'RUB' } } : null } : s)
  const writes = () => calls.filter(c => c.path === path && c.method === (door === 'advance' ? 'PATCH' : 'POST'))
  const success = () => door === 'request' ? json({ results: [{ entryId: ENTRY, status: 'sent', requestId: REQUEST }] }, 201)
    : json({ id: selected, categoryId: 'photo', label: 'Фотограф', tileState: 'booked', programEvent: main && mainDate === null ? slots()[0]!.programEvent : current, deal: { id: D, state: 'booked', vendor: door === 'external' ? null : { id: V, name: vendor.name }, price: { amount: 150000, currency: 'RUB' } } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://localhost'), p = u.pathname.replace(/^\/api/, '')
    const call: Call = { method: init?.method ?? 'GET', path: p, query: u.search, rawBody: init?.body == null ? null : String(init.body), headers: new Headers(init?.headers) }
    calls.push(call)
    const queryKeys = [...u.searchParams.keys()]
    const onlyQuery = (names: string[]) => queryKeys.every(k => names.includes(k) && u.searchParams.getAll(k).length === 1 && u.searchParams.get(k) !== '')
    let response: Response
    if (call.method === 'POST' && p === '/auth/refresh' && !u.search) {
      const saved = JSON.parse(localStorage.getItem('tt_auth')!) as typeof A
      response = json(saved.refreshToken === A.refreshToken ? RENEWED : { ...B, accessToken: token(92, 93, 1) })
    } else if (p === path && !u.search && call.method === (door === 'advance' ? 'PATCH' : 'POST')) {
      response = firstPending && writes().length === 1 ? await pending.promise : success()
    } else if (call.method === 'GET') {
      if (p === '/weddings' && !u.search) response = json([currentWedding])
      else if (p === `/weddings/${W}` && !u.search) response = json(currentWedding)
      else if (p === `/weddings/${W}/slots` && !u.search) response = json(slots())
      else if (implicitMain && p === `/weddings/${W}/events` && !u.search && call.rawBody === null) response = json([mainRecord])
      else if (p === '/me/favorites' && !u.search) response = json([])
      else if (p === '/catalog/categories' && !u.search) response = json([{ id: 'photo', title: 'Фотограф', icon: '📷' }])
      else if (p === `/catalog/vendors/${V}` && !u.search) response = json(vendor)
      else if (p === `/catalog/vendors/${V}/availability` && onlyQuery(['month']) && u.searchParams.has('month')) response = json({ busyDates: [], holdDates: [] })
      else if (p === `/catalog/vendors/${V}/reviews` && onlyQuery(['limit', 'cursor'])) response = json({ items: [], nextCursor: null })
      else if (p === '/catalog/vendors' && onlyQuery(['categoryId', 'city', 'date', 'limit'])) response = json({ items: [], nextCursor: null })
      else if (p === `/vendors/${V}/booking-policy` && !u.search) response = json({ mode: 'legacy_day', revision: '0' })
      else if ((p === `/weddings/${W}/slots/${MAIN}/shortlist` || p === `/weddings/${W}/slots/${EXTRA}/shortlist`) && !u.search) response = json(implicitMain ? [implicitMainEntry()] : comparison ? [entry(current ?? event()), {
        id: id(14), slotId: EXTRA, position: 2, createdAt: '2030-01-01T10:00:00.000Z', available: true,
        occupancy: null, availabilityObservation: null, vendor: { ...vendor, id: id(15), name: 'Вторая студия ужина' },
      }] : ['replace', 'request', 'accept'].includes(door) ? [entry(current ?? event())] : [])
      else if (p === `/deals/${D}/events` && !u.search) response = json([])
      else if (door === 'advance' && p === `/deals/${D}/event-moves` && !u.search && call.rawBody === null) response = json([])
      else if (door === 'replace' && p === `/deals/${OLD_D}/order/resource-commitments` && !u.search && call.rawBody === null) response = json({ revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' } satisfies components['schemas']['OrderResourceCommitmentView'])
      else if (p === '/vendor/deals' && !u.search) response = json({ items: [{ id: D, state: 'booked', coupleName: 'Пара дополнительного ужина', weddingDate: MAIN_DATE, programEvent: current }], expected: { amount: 0, currency: 'RUB' } })
      else { unexpected.push(`${call.method} ${p}${u.search}`); response = json({ error: { code: 'unexpected_test_route', message: 'Unexpected fetch boundary' } }, 500) }
    } else { unexpected.push(`${call.method} ${p}${u.search}`); response = json({ error: { code: 'unexpected_test_route', message: 'Unexpected fetch boundary' } }, 500) }
    call.response = response
    return response
  }))
  const result = { calls, unexpected, pending, path, selected, writes, holdFirst: () => { firstPending = true }, setContext: (next: typeof current) => { current = next },
    refreshes: () => calls.filter(c => c.path === '/auth/refresh'),
    setMainEvent: (patch: Partial<Context>) => { mainRecord = { ...mainRecord, ...patch } },
    mainReads: () => calls.filter(c => c.method === 'GET' && c.path === `/weddings/${W}/events` && !c.query),
    freshBReads: () => calls.filter(c => c.headers.get('authorization') === `Bearer ${B.accessToken}` && c.method === 'GET' && ['/weddings', `/weddings/${W}`, `/weddings/${W}/slots`, '/me/favorites'].includes(c.path)) }
  active = result
  return result
}
function Probe() {
  const store = useStore()
  useEffect(() => { bridge = store }, [store])
  return <aside><output data-testid="real-store">{JSON.stringify({ wedding: store.weddingId, phase: store.slotsState, slots: store.slots })}</output>
    <button onClick={store.refreshSlots}>Перечитать реальные позиции</button></aside>
}
function mountPage(door: Door, main = false, initial?: Context, mainDate: string | null = MAIN_DATE) {
  const h = network(door, main, false, false, mainDate), selected = main ? MAIN : EXTRA
  if (initial) h.setContext(initial)
  const route = door === 'advance' ? '/deal/' + D : ['external', 'request', 'accept'].includes(door) ? `/wedding/slot/${selected}` : door === 'replace' ? `/vendor/${V}?replaceSlot=${EXTRA}` : `/vendor/${V}?slotId=${selected}`
  const page = <Routes><Route path="/vendor/:id" element={<VendorDetail />} /><Route path="/wedding/slot/:id" element={<SlotDetail />} /><Route path="/deal/:id" element={<Deal />} /></Routes>
  const view = render(<MemoryRouter initialEntries={[route]}><StoreProvider><Probe />{page}</StoreProvider></MemoryRouter>)
  return { ...h, view }
}
function mountImplicitMain(patch: Partial<Context> = {}) {
  const h = network('accept', true, true); h.setMainEvent(patch)
  const view = render(<MemoryRouter initialEntries={[`/wedding/slot/${MAIN}`]}><StoreProvider><Probe />
    <Routes><Route path="/wedding/slot/:id" element={<SlotDetail />} /></Routes></StoreProvider></MemoryRouter>)
  return { ...h, view }
}
async function readyMain(h: Network) {
  await readyStore()
  await waitFor(() => {
    expect(h.mainReads().length).toBeGreaterThan(0)
    expect(h.mainReads().every(c => c.response?.bodyUsed)).toBe(true)
  })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  expect(bridge?.slots.find(s => s.id === MAIN)).toBeTruthy()
  expect(Object.hasOwn(bridge!.slots.find(s => s.id === MAIN)!, 'programEvent')).toBe(false)
}
async function readyStore() { await waitFor(() => expect(JSON.parse(screen.getByTestId('real-store').textContent!).phase).toBe('ready')) }
async function clickEnabled(name: string | RegExp) {
  const button = await screen.findByRole('button', { name })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
}
async function startPage(door: Door) {
  await readyStore()
  if (door === 'external') {
    const open = screen.queryByRole('button', { name: 'Добавить своего специалиста' })
    if (open) fireEvent.click(open)
    fireEvent.change(await screen.findByPlaceholderText('Имя / название (напр. Фотограф Ирек)'), { target: { value: 'Свой фотограф' } })
    fireEvent.change(screen.getByPlaceholderText('Цена, ₽'), { target: { value: '1700' } })
    await clickEnabled('Добавить в команду')
  } else if (door === 'request') {
    await clickEnabled(/^Запросить предложение/); await clickEnabled('Отправить запрос')
  } else if (door === 'accept') await clickEnabled(/^Принять предложение:/)
  else await clickEnabled(door === 'advance' ? 'Согласовать бронирование' : door === 'replace' ? 'Заменить в свадьбе' : 'Добавить в свадьбу')
}
function assertWrite(call: Call, h: Network, expected: Context | null) {
  expect(call.path).toBe(h.path); expect(call.query).toBe('')
  expect(call.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`)
  expect(call.headers.get('idempotency-key')).toBeTruthy()
  expect(call.headers.get('x-program-event-context')).toBe(expected ? JSON.stringify(pin(expected)) : null)
}
async function release(h: Network, response: Response) {
  await act(async () => { h.pending.resolve(response) })
  await waitFor(() => expect(response.bodyUsed).toBe(true))
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
function mountOffer(kind: 'request' | 'accept', extra = true) {
  const h = network(kind, !extra), changed = vi.fn()
  let current = extra ? event() : event({ id: MAIN_EV, date: MAIN_DATE, timeZone: wedding.tz, isMain: true }), quote = offered(current)
  const tree = (): ReactNode => <MemoryRouter>{kind === 'request' ? <OfferRequestComposer weddingId={W} slotId={h.selected} entries={[{ ...entry(current), slotId: h.selected }]}
    currentWeddingDate={current.date} weddingTz={current.timeZone} canRequest={!!current.timeZone && (extra || !!current.date)}
    eventContextKey={JSON.stringify(current)} programEventContext={extra && current.timeZone ? { id: current.id, date: current.date, timeZone: current.timeZone } : undefined} onChanged={changed} />
    : <><OfferSummary request={quote} currentWeddingDate={current.date} weddingTz={current.timeZone} /><OfferAcceptance weddingId={W} request={quote}
      currentWeddingDate={current.date} weddingTz={current.timeZone} currentProgramEvent={current} canAccept={!!current.timeZone && (extra || !!current.date)}
      eventContextKey={JSON.stringify(current)} programEventContext={extra && current.timeZone ? { id: current.id, date: current.date, timeZone: current.timeZone } : undefined} onChanged={changed} /></>}</MemoryRouter>
  const view = render(tree())
  const update = async (next: Context, nextQuote = quote) => { await act(async () => { current = next; quote = nextQuote; view.rerender(tree()) }) }
  const click = async () => {
    if (kind === 'request') { const open = screen.queryByRole('button', { name: /^Запросить предложение/ }); if (open) fireEvent.click(open); await clickEnabled('Отправить запрос') }
    else await clickEnabled(/^Принять предложение:/)
  }
  return { ...h, view, changed, click, update }
}
beforeEach(() => {
  active = null; bridge = null
  localStorage.clear(); sessionStorage.clear(); setI18nLang('ru'); saveTokens(A)
  localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify(MAIN_DATE)); localStorage.setItem('tt_onboarded', '1')
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-06-14T10:30:00.000Z'))
})
afterEach(async () => {
  cleanup()
  if (active && !active.pending.settled) await act(async () => { active!.pending.resolve(json({ error: { code: 'test_disposed', message: 'Disposed pending response' } }, 503)) })
  saveTokens(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); bridge = null
  expect(active?.unexpected ?? []).toEqual([])
})

describe('additional activation context through real components/Store/client', () => {
  it.each(['book', 'external', 'advance', 'replace'] as const)('%s sends the exact selected additional precondition, not the first same-category main slot', async door => {
    const h = mountPage(door); await startPage(door)
    await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWrite(h.writes()[0]!, h, event())
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
  })
  it.each(['request', 'accept'] as const)('%s sends exact context using the real offer component and does not resend quote money on accept', async kind => {
    const h = mountPage(kind); await startPage(kind); await waitFor(() => expect(h.writes()).toHaveLength(1))
    assertWrite(h.writes()[0]!, h, event())
    expect(JSON.parse(h.writes()[0]!.rawBody!)).toEqual(kind === 'request' ? { entryIds: [ENTRY] } : {})
    await waitFor(() => expect(h.writes()[0]!.response?.bodyUsed).toBe(true))
  })
  it.each(['request', 'accept'] as const)('old main %s component preserves no-header wire compatibility', async kind => {
    const h = mountOffer(kind, false); await h.click(); await waitFor(() => expect(h.writes()).toHaveLength(1))
    assertWrite(h.writes()[0]!, h, null); await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
  })
  it.each(['book', 'external', 'advance'] as const)('old implicit/main %s has no extra-event header', async door => {
    const h = mountPage(door, true); await startPage(door)
    await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWrite(h.writes()[0]!, h, null)
  })
  it.each(['book', 'external', 'advance'] as const)('%s manual retry after response uncertainty preserves the same body, target and key', async door => {
    const h = mountPage(door); h.holdFirst(); await startPage(door)
    await waitFor(() => expect(h.writes()).toHaveLength(1)); const first = h.writes()[0]!
    await act(async () => { h.pending.reject(new TypeError('Synthetic transport response lost')) })
    await screen.findByText('Сервер недоступен. Попробуйте позже')
    await startPage(door); await waitFor(() => expect(h.writes()).toHaveLength(2))
    const second = h.writes()[1]!; assertWrite(second, h, event())
    expect(second.rawBody).toBe(first.rawBody); expect(second.path).toBe(first.path)
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'))
    expect(h.refreshes()).toHaveLength(0)
  })
  it.each(['book', 'external', 'advance'] as const)('%s held original401 after actor change never refreshes B or replays the old command', async door => {
    const h = mountPage(door); h.holdFirst(); await startPage(door); await waitFor(() => expect(h.writes()).toHaveLength(1))
    await act(async () => { saveTokens(B) }); await readyStore()
    await waitFor(() => {
      expect(new Set(h.freshBReads().map(c => c.path)).size).toBe(4)
      expect(h.freshBReads().every(c => c.response?.bodyUsed)).toBe(true)
    })
    await release(h, unauthorized())
    expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
  })
  it('first-COMMITTED held401 is retired by a changed event context even with the same actor/wedding/DATE', async () => {
    const h = mountPage('advance'); h.holdFirst(); await startPage('advance'); await waitFor(() => expect(h.writes()).toHaveLength(1))
    const next = event({ timeZone: 'Asia/Novosibirsk' }); h.setContext(next)
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать реальные позиции' }))
    await waitFor(() => expect(bridge?.slots.find(s => s.id === EXTRA)?.programEvent).toEqual(next))
    await release(h, unauthorized())
    expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
  })
  it.each(['request', 'accept'] as const)('%s held401 is retired on same-DATE different event ID', async kind => {
    const h = mountOffer(kind); h.holdFirst(); await h.click(); await waitFor(() => expect(h.writes()).toHaveLength(1))
    await h.update(event({ id: id(100), name: 'Другое дополнительное мероприятие' }))
    await release(h, unauthorized())
    expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0); expect(h.changed).not.toHaveBeenCalled()
  })
  it('same subject/session renewal keeps request header/body/key on exactly one refresh and replay', async () => {
    const h = mountOffer('request'); h.holdFirst(); await h.click(); await waitFor(() => expect(h.writes()).toHaveLength(1))
    const first = h.writes()[0]!; await release(h, unauthorized())
    await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
    expect(h.refreshes()).toHaveLength(1); expect(h.writes()).toHaveLength(2)
    const second = h.writes()[1]!
    expect(second.rawBody).toBe(first.rawBody); expect(second.path).toBe(first.path)
    expect(second.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'))
    expect(second.headers.get('x-program-event-context')).toBe(first.headers.get('x-program-event-context'))
    expect(second.headers.get('authorization')).toBe(`Bearer ${RENEWED.accessToken}`)
  })
  it.each(['request', 'accept'] as const)('%s explicit unknown timezone cannot inherit a main/Moscow acquisition context', async kind => {
    const h = mountOffer(kind); await h.update(event({ timeZone: null }))
    if (kind === 'request') expect((screen.getByRole('button', { name: /^Запросить предложение/ }) as HTMLButtonElement).disabled).toBe(true)
    else expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    expect(h.writes()).toHaveLength(0)
  })
  it('stored quote timezone governs expiry even after a same-DATE live timezone change', async () => {
    const h = mountOffer('accept'), stored = offered(event())
    stored.offer = { ...stored.offer!, validUntil: '2030-06-14' }
    await h.update(event({ timeZone: 'Pacific/Honolulu' }), stored)
    expect(screen.getByText('Срок предложения истёк')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    expect(h.writes()).toHaveLength(0)
  })
  it.each([false, true])('vendor primary event date is authoritative (explicit unknown=%s), while weddingDate stays distinct', async unknown => {
    const h = network(); h.setContext(unknown ? event({ date: null, timeZone: null }) : event())
    render(<MemoryRouter><VendorDeals /></MemoryRouter>)
    const row = await screen.findByRole('button', { name: /Пара дополнительного ужина/ })
    expect(row.textContent).toContain(unknown ? 'дата не назначена' : '15 августа 2030')
    expect(row.textContent).not.toContain('14 июня 2030')
    expect(row.textContent).toContain('Ужин дополнительного дня')
    expect(h.writes()).toHaveLength(0)
  })
  it('new implicit main stored7 offer uses an independent current events GET and accepts with no extra header', async () => {
    const h = mountImplicitMain(); await readyMain(h)
    expect(h.mainReads()[0]!.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`)
    await clickEnabled(/^Принять предложение:/)
    await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWrite(h.writes()[0]!, h, null)
    expect(JSON.parse(h.writes()[0]!.rawBody!)).toEqual({})
    await waitFor(() => expect(h.writes()[0]!.response?.bodyUsed).toBe(true))
  })
  it.each(['name', 'timeZone', 'location'] as const)('implicit main current7 %s differs from the saved quote and refuses acceptance', async field => {
    const patch: Partial<Context> = field === 'name' ? { name: 'Изменённая основная церемония' }
      : field === 'timeZone' ? { timeZone: 'Asia/Novosibirsk' } : { location: 'Другой основной зал' }
    const h = mountImplicitMain(patch); await readyMain(h)
    expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    expect(h.writes()).toHaveLength(0); expect(h.refreshes()).toHaveLength(0)
  })
  it('observed implicit main source change retires a held accept401 before refresh or replay', async () => {
    const h = mountImplicitMain(); await readyMain(h); h.holdFirst()
    await clickEnabled(/^Принять предложение:/); await waitFor(() => expect(h.writes()).toHaveLength(1))
    const reads = h.mainReads().length
    h.setMainEvent({ id: id(100) })
    fireEvent.click(screen.getByRole('button', { name: 'Перечитать реальные позиции' }))
    await waitFor(() => {
      expect(h.mainReads().length).toBeGreaterThan(reads)
      expect(h.mainReads().every(c => c.response?.bodyUsed)).toBe(true)
      expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    })
    await release(h, unauthorized())
    expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(A)
  })
  it('stored additional7 with no explicit current7 refuses even when opaque key and triple look current', () => {
    const h = network('accept'), quote = offered()
    render(<MemoryRouter><OfferAcceptance weddingId={W} request={quote} currentWeddingDate={EXTRA_DATE}
      weddingTz="Pacific/Kiritimati" eventContextKey={JSON.stringify(event())} programEventContext={{ id: EV, date: EXTRA_DATE, timeZone: 'Pacific/Kiritimati' }}
      canAccept onChanged={vi.fn()} /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
    expect(h.writes()).toHaveLength(0); expect(h.refreshes()).toHaveLength(0)
  })
  it('historical main NULL snapshot still accepts with no current7 and no extra header', async () => {
    const h = network('accept', true), quote = offered(), changed = vi.fn()
    quote.weddingDate = MAIN_DATE; quote.programEvent = null
    render(<MemoryRouter><OfferAcceptance weddingId={W} request={quote} currentWeddingDate={MAIN_DATE}
      weddingTz="Pacific/Honolulu" canAccept onChanged={changed} /></MemoryRouter>)
    await clickEnabled(/^Принять предложение:/); await waitFor(() => expect(h.writes()).toHaveLength(1))
    assertWrite(h.writes()[0]!, h, null); expect(JSON.parse(h.writes()[0]!.rawBody!)).toEqual({})
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  })
  it('P2a explicit-main NULL-date public DTO keeps catalog booking actionable without an extra header or a calendar date', async () => {
    const h = mountPage('book', true, undefined, null)
    await readyStore()
    await waitFor(() => {
      const slotReads = h.calls.filter(c => c.method === 'GET' && c.path === `/weddings/${W}/slots`)
      expect(slotReads.length).toBeGreaterThanOrEqual(2)
      expect(slotReads.every(c => c.response?.bodyUsed)).toBe(true)
      expect(h.calls.filter(c => c.method === 'GET' && c.path === '/weddings').every(c => c.response?.bodyUsed)).toBe(true)
      expect(bridge?.slots.find(s => s.id === MAIN)?.programEvent).toMatchObject({ id: MAIN_EV, isMain: true, date: null, timeZone: 'Pacific/Honolulu' })
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByText('Проверяем выбранную позицию…')).toBeNull()
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBeNull()
    expect(screen.getByText('Дата не задана')).toBeTruthy()
    const add = screen.getByRole('button', { name: 'Добавить в свадьбу' }) as HTMLButtonElement
    expect(add.disabled, 'Current own-main NULL date must not block its established legacy acquisition').toBe(false)
    fireEvent.click(add); await waitFor(() => expect(h.writes()).toHaveLength(1))
    assertWrite(h.writes()[0]!, h, null)
    expect(h.calls.some(c => /(?:^|[?&])date=/.test(c.query))).toBe(false)
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBeNull()
  })
  it('P2b additional NULL-date context rejects a historical NULL quote snapshot instead of inheriting legacy-main consent', () => {
    const own = event({ date: null }), h = network('accept'), quote = offered(own)
    quote.programEvent = null; quote.weddingDate = null
    render(<MemoryRouter><OfferAcceptance weddingId={W} request={quote} currentWeddingDate={null}
      weddingTz="Pacific/Kiritimati" currentProgramEvent={own} canAccept
      eventContextKey={JSON.stringify(own)} programEventContext={{ id: EV, date: null, timeZone: 'Pacific/Kiritimati' }}
      onChanged={vi.fn()} /></MemoryRouter>)
    const accept = screen.queryByRole('button', { name: /^Принять предложение:/ }) as HTMLButtonElement | null
    expect(accept === null || accept.disabled, 'A NULL historical snapshot belongs to the legacy-main protocol, never to a current additional event').toBe(true)
    if (accept) fireEvent.click(accept)
    expect(h.writes()).toHaveLength(0); expect(h.refreshes()).toHaveLength(0)
  })
  it.each(['book', 'advance', 'replace'] as const)('undated %s sends explicit NULL and its own known timezone, without a main-date query', async door => {
    const own = event({ date: null }), h = mountPage(door, false, own)
    await startPage(door)
    await waitFor(() => expect(h.writes()).toHaveLength(1))
    assertWrite(h.writes()[0]!, h, own)
    expect(JSON.parse(h.writes()[0]!.headers.get('x-program-event-context')!)).toEqual({ id: EV, date: null, timeZone: 'Pacific/Kiritimati' })
    expect(h.calls.some(c => c.query.includes(`date=${MAIN_DATE}`))).toBe(false)
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
  })
  it.each(['request', 'accept'] as const)('undated %s keeps a live candidate actionable while showing calendar availability as unknown', async door => {
    const own = event({ date: null }), h = mountPage(door, false, own)
    await readyStore()
    await screen.findByText('Занятость неизвестна')
    expect(screen.queryByText('Свободен на вашу дату')).toBeNull()
    expect(screen.getByText('Дата ещё не выбрана. Занятость на конкретный день не подтверждена. Первую дату нужно согласовать с исполнителем.')).toBeTruthy()
    await startPage(door); await waitFor(() => expect(h.writes()).toHaveLength(1))
    assertWrite(h.writes()[0]!, h, own)
    expect(JSON.parse(h.writes()[0]!.rawBody!)).toEqual(door === 'accept' ? {} : { entryIds: [ENTRY] })
  })
  it('undated external acquisition remains disabled with a useful next step and makes no write', async () => {
    const h = mountPage('external', false, event({ date: null }))
    await readyStore()
    await screen.findByText('Для своего специалиста сначала укажите дату и часовой пояс мероприятия.')
    const add = screen.getByRole('button', { name: 'Добавить своего специалиста' }) as HTMLButtonElement
    expect(add.disabled).toBe(true); fireEvent.click(add)
    expect(screen.queryByPlaceholderText('Имя / название (напр. Фотограф Ирек)')).toBeNull()
    expect(h.writes()).toHaveLength(0)
  })
  it('undated direct catalog acquisition with unknown timezone stays disabled and never borrows main timezone', async () => {
    const h = mountPage('book', false, event({ date: null, timeZone: null }))
    await readyStore()
    await screen.findByText('Укажите часовой пояс дополнительного мероприятия перед бронированием')
    const add = screen.getByRole('button', { name: 'Добавить в свадьбу' }) as HTMLButtonElement
    expect(add.disabled).toBe(true); fireEvent.click(add)
    expect(h.writes()).toHaveLength(0); expect(h.refreshes()).toHaveLength(0)
  })
  it('undated catalog response uncertainty retains the same explicit NULL intent and idempotency key on manual retry', async () => {
    const own = event({ date: null }), h = mountPage('book', false, own); h.holdFirst()
    await startPage('book'); await waitFor(() => expect(h.writes()).toHaveLength(1))
    const first = h.writes()[0]!
    await act(async () => { h.pending.reject(new TypeError('Synthetic lost undated booking response')) })
    await screen.findByText('Сервер недоступен. Попробуйте позже')
    await clickEnabled('Добавить в свадьбу'); await waitFor(() => expect(h.writes()).toHaveLength(2))
    const retry = h.writes()[1]!
    expect(retry.rawBody).toBe(first.rawBody)
    expect(retry.headers.get('x-program-event-context')).toBe(first.headers.get('x-program-event-context'))
    expect(retry.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'))
    assertWrite(retry, h, own)
  })
  it.each([true, false])('undated Compare preserves unknown availability and permits exact offer acceptance only with its own timezone (known=%s)', async known => {
    const own = event({ date: null, timeZone: known ? 'Pacific/Kiritimati' : null }), h = network('accept', false, false, true)
    h.setContext(own)
    render(<MemoryRouter initialEntries={[`/compare?slot=${EXTRA}&entries=${ENTRY},${id(14)}`]}><StoreProvider><Probe />
      <Routes><Route path="/compare" element={<Compare />} /></Routes></StoreProvider></MemoryRouter>)
    await readyStore(); await screen.findByText('Вторая студия ужина')
    expect(screen.queryByText('Свободен', { exact: true })).toBeNull()
    if (known) {
      await clickEnabled('Принять предложение: Сохранённая съёмка ужина')
      await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWrite(h.writes()[0]!, h, own)
    } else {
      expect(screen.queryByRole('button', { name: /^Принять предложение:/ })).toBeNull()
      expect(h.writes()).toHaveLength(0)
    }
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe(MAIN_DATE)
  })
})
