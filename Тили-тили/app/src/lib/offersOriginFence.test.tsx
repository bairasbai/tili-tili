// @vitest-environment jsdom
// Only fetch is controlled. Both components, offers wrappers and API client are real.
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferRequestComposer } from '@/components/OfferRequestComposer'
import { OfferAcceptance } from '@/components/OfferAcceptance'
import { saveTokens } from '@/lib/api/client'
import type { ShortlistEntry } from '@/lib/api/shortlist'
import type { OfferRequest } from '@/lib/api/offers'
import { setI18nLang } from '@/lib/i18n'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), W2 = id(2), S = id(3), S2 = id(4), E = id(5), E2 = id(6), O = id(7), O2 = id(8), R = id(9), V = id(10)
const DATE = '2027-06-14', WISHES = 'Исходные пожелания'
const token = (sub: number, sid: number, serial = 0) => `header.${btoa(JSON.stringify({ sub: id(sub), sid: id(sid), serial }))}.signature`
const A = { accessToken: token(20, 30), refreshToken: 'synthetic-refresh-A' }
const B = { accessToken: token(21, 31), refreshToken: 'synthetic-refresh-B' }
const SAME_USER_NEW_SESSION = { accessToken: token(20, 32), refreshToken: 'synthetic-refresh-A-new-session' }
const entry = (entryId = E, slotId = S): ShortlistEntry => ({
  id: entryId, slotId, position: 1, createdAt: '2026-10-16T09:00:00.000Z', available: true,
  availabilityObservation: { source: 'legacy_day', date: DATE, checkedAt: '2026-10-16T09:00:00.000Z' }, occupancy: 'free',
  vendor: { id: V, name: 'Студия исходной попытки', categoryId: 'photo', city: 'Уфа', priceFrom: null, rating: null,
    reviewsCount: 0, photoUrl: null, verified: false, hasVideo: false, packages: [] },
})
const offered = (): OfferRequest => ({
  id: R, status: 'open', weddingDate: DATE, guests: 60, city: 'Уфа', wishes: WISHES, createdAt: '2026-10-16T09:00:00.000Z',
  offer: { id: O, requestId: R, kind: 'offer', packageId: null, title: 'Сохранённые условия', price: { amount: 1234567, currency: 'RUB' },
    includes: ['Репортаж'], message: null, comparisonTerms: null, validUntil: '2099-12-31' },
})

type Kind = 'request' | 'accept'
type Call = { method: string; path: string; rawBody: string | null; body: unknown; headers: Headers }
function held<T>() {
  let done!: (value: T) => void, fail!: (error: Error) => void, settled = false
  const promise = new Promise<T>((resolve, reject) => { done = resolve; fail = reject })
  return { promise, get settled() { return settled }, resolve(value: T) { if (!settled) { settled = true; done(value) } },
    reject(error: Error) { if (!settled) { settled = true; fail(error) } } }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Expired synthetic access' } }, 401)
const bodyFor = (entries: ShortlistEntry[]) => ({ entryIds: entries.map(e => e.id), wishes: WISHES, budgetHint: { amount: 1200000, currency: 'RUB' } })
function successBody(kind: Kind, call: Call) {
  return kind === 'request'
    ? { results: (call.body as { entryIds: string[] }).entryIds.map(entryId => ({ entryId, status: 'sent', requestId: R })) }
    : { id: S, categoryId: 'photo', label: 'Фото', tileState: 'booked', deal: { id: id(50), state: 'booked', price: { amount: 1234567, currency: 'RUB' } } }
}

let activeNetwork: ReturnType<typeof network> | null = null
function network(kind: Kind, holdSecond = false) {
  const initial = held<Response>(), second = held<Response>(), calls: Call[] = [], unexpected: string[] = []
  const writes = () => calls.filter(c => c.path !== '/auth/refresh')
  const refreshes = () => calls.filter(c => c.path === '/auth/refresh')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    const rawBody = init?.body == null ? null : String(init.body)
    const call: Call = { method: init?.method ?? 'GET', path, rawBody, body: rawBody === null ? null : JSON.parse(rawBody), headers: new Headers(init?.headers) }
    calls.push(call)
    if (path === '/auth/refresh' && call.method === 'POST') {
      const current = JSON.parse(localStorage.getItem('tt_auth')!) as typeof A
      const claims = JSON.parse(atob(current.accessToken.split('.')[1]!)) as { sub: string; sid: string }
      return json({ accessToken: `header.${btoa(JSON.stringify({ ...claims, serial: 1 }))}.signature`, refreshToken: current.refreshToken + '-renewed' })
    }
    const target = kind === 'request' ? /^\/weddings\/[^/]+\/slots\/[^/]+\/offer-requests$/ : /^\/weddings\/[^/]+\/offers\/[^/]+\/accept$/
    if (call.method === 'POST' && target.test(path)) {
      if (writes().length === 1) return initial.promise
      if (writes().length === 2 && holdSecond) return second.promise
      return json(successBody(kind, call), kind === 'request' ? 201 : 200)
    }
    unexpected.push(`${call.method} ${path}`)
    return json({ error: { code: 'unexpected_test_route', message: 'Unexpected fetch boundary' } }, 500)
  }))
  const result = { initial, second, calls, unexpected, writes, refreshes }
  activeNetwork = result
  return result
}

// Observe native body readers without replacing their implementation or result.
// This witnesses actual client consumption, including stale-response disposal.
function observed(response: Response) {
  const text = vi.spyOn(response, 'text'), bytes = vi.spyOn(response, 'arrayBuffer'), parsed = vi.spyOn(response, 'json')
  const started = () => text.mock.calls.length + bytes.mock.calls.length + parsed.mock.calls.length > 0
  const finished = async () => {
    await waitFor(() => expect(started()).toBe(true))
    await act(async () => { await Promise.allSettled([...text.mock.results, ...bytes.mock.results, ...parsed.mock.results].filter(r => r.type === 'return').map(r => r.value)) })
    expect(response.bodyUsed).toBe(true)
  }
  return { response, started, finished }
}

const common = ['actor', 'same-user-new-session', 'A-B-A', 'storage-A-B-A', 'selected-wedding', 'wedding-prop', 'unmount'] as const
const requestBoundaries = [...common, 'slot', 'entries', 'slot-A-B-A', 'entries-A-B-A', 'date', 'time-zone', 'permission', 'permission-A-B-A'] as const
const acceptBoundaries = [...common, 'request', 'offer', 'request-status', 'date', 'time-zone', 'permission', 'offer-A-B-A', 'permission-A-B-A'] as const
type Boundary = typeof requestBoundaries[number] | typeof acceptBoundaries[number]

function mount(kind: Kind, holdSecond = false) {
  const h = network(kind, holdSecond), changed = vi.fn()
  // Root's agreed optional caller context. Structural extra props are legal on
  // the unchanged component too: RED must expose that it currently ignores them.
  type RequestHostProps = ComponentProps<typeof OfferRequestComposer> & { currentWeddingDate?: string | null; weddingTz?: string | null; canRequest?: boolean }
  let request: RequestHostProps = { weddingId: W, slotId: S, entries: [entry()], currentWeddingDate: DATE, weddingTz: 'Europe/Moscow', canRequest: true, onChanged: changed }
  let acceptance: ComponentProps<typeof OfferAcceptance> = { weddingId: W, request: offered(), currentWeddingDate: DATE, weddingTz: 'Europe/Moscow', canAccept: true, onChanged: changed }
  // Deliberately retain the same component instance across prop changes.
  const tree = () => <MemoryRouter>{kind === 'request' ? <OfferRequestComposer {...request} /> : <OfferAcceptance {...acceptance} />}</MemoryRouter>
  const view = render(tree())
  const rerender = async (change: () => void) => { await act(async () => { change(); view.rerender(tree()) }) }
  const setOffer = (offerId: string) => { const full = acceptance.request as OfferRequest; acceptance = { ...acceptance, request: { ...full, offer: { ...full.offer!, id: offerId } } } }
  async function boundary(name: Boundary) {
    if (name === 'unmount') { view.unmount(); return }
    if (name === 'actor' || name === 'same-user-new-session') {
      await act(async () => { saveTokens(name === 'actor' ? B : SAME_USER_NEW_SESSION) })
      expect(JSON.parse(localStorage.getItem('tt_wedding_id')!)).toBe(W)
      return
    }
    if (name === 'A-B-A') { await act(async () => { saveTokens(B) }); await act(async () => { saveTokens(A) }); return }
    if (name === 'storage-A-B-A') {
      // The storage is A again; queued events still prove the observed detour.
      for (const [oldValue, newValue] of [[A, B], [B, A]]) await act(async () => {
        window.dispatchEvent(new StorageEvent('storage', { key: 'tt_auth', oldValue: JSON.stringify(oldValue), newValue: JSON.stringify(newValue), storageArea: localStorage }))
      })
      expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(A)
      return
    }
    if (name === 'selected-wedding') { await act(async () => { localStorage.setItem('tt_wedding_id', JSON.stringify(W2)) }); return }
    if (name === 'wedding-prop') {
      await rerender(() => {
        localStorage.setItem('tt_wedding_id', JSON.stringify(W2))
        request = { ...request, weddingId: W2, slotId: S2, entries: [entry(E2, S2)] }
        const full = offered(); acceptance = { ...acceptance, weddingId: W2, request: { ...full, id: id(90), offer: { ...full.offer!, id: O2, requestId: id(90) } } }
      }); return
    }
    if (name === 'slot' || name === 'slot-A-B-A') {
      const previous = request
      await rerender(() => { request = { ...request, slotId: S2, entries: [entry(E2, S2)] } })
      if (name === 'slot-A-B-A') await rerender(() => { request = previous })
      return
    }
    if (name === 'entries' || name === 'entries-A-B-A') {
      const previous = request
      await rerender(() => { request = { ...request, entries: [entry(E2)] } })
      if (name === 'entries-A-B-A') await rerender(() => { request = previous })
      return
    }
    if (name === 'offer' || name === 'offer-A-B-A') {
      await rerender(() => setOffer(O2))
      if (name === 'offer-A-B-A') await rerender(() => setOffer(O))
      return
    }
    if (name === 'permission' || name === 'permission-A-B-A') {
      await rerender(() => { if (kind === 'request') request = { ...request, canRequest: false }; else acceptance = { ...acceptance, canAccept: false } })
      if (name === 'permission-A-B-A') await rerender(() => { if (kind === 'request') request = { ...request, canRequest: true }; else acceptance = { ...acceptance, canAccept: true } })
      return
    }
    await rerender(() => {
      const full = acceptance.request as OfferRequest
      if (name === 'request') acceptance = { ...acceptance, request: { ...full, id: id(91), offer: { ...full.offer!, id: O2, requestId: id(91) } } }
      else if (name === 'request-status') acceptance = { ...acceptance, request: { ...full, status: 'closed', closeReason: 'removed' } }
      else if (name === 'date') { if (kind === 'request') request = { ...request, currentWeddingDate: '2027-06-15' }; else acceptance = { ...acceptance, currentWeddingDate: '2027-06-15' } }
      else if (name === 'time-zone') { if (kind === 'request') request = { ...request, weddingTz: 'Asia/Novosibirsk' }; else acceptance = { ...acceptance, weddingTz: 'Asia/Novosibirsk' } }
    })
  }
  async function click() {
    if (kind === 'request') {
      const open = screen.queryByRole('button', { name: /^Запросить предложение/ })
      if (open) fireEvent.click(open)
      fireEvent.change(await screen.findByPlaceholderText('Пожелания к предложению (необязательно)'), { target: { value: WISHES } })
      fireEvent.change(screen.getByLabelText('Ориентир бюджета, ₽ (необязательно)'), { target: { value: '12000' } })
    }
    const button = await screen.findByRole('button', { name: kind === 'request' ? 'Отправить запрос' : /^Принять предложение:/ })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
  }
  async function unchangedRerender() {
    await rerender(() => {
      request = { ...request, entries: request.entries.map(e => ({ ...e, vendor: e.vendor ? { ...e.vendor } : null })) }
      const full = acceptance.request as OfferRequest; acceptance = { ...acceptance, request: { ...full, offer: { ...full.offer! } } }
    })
  }
  return { ...h, view, changed, click, boundary, unchangedRerender, expectedRequest: () => bodyFor(request.entries) }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
  localStorage.clear(); sessionStorage.clear(); saveTokens(A); localStorage.setItem('tt_wedding_id', JSON.stringify(W)); setI18nLang('ru'); activeNetwork = null
})
afterEach(async () => {
  cleanup()
  if (activeNetwork) await act(async () => {
    for (const pending of [activeNetwork!.initial, activeNetwork!.second]) if (!pending.settled) pending.resolve(json({ error: { code: 'test_disposed', message: 'Test disposed' } }, 503))
  })
  saveTokens(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  expect(activeNetwork?.unexpected ?? []).toEqual([])
})

function assertOriginal(h: ReturnType<typeof mount>, kind: Kind) {
  expect(h.writes()).toHaveLength(1)
  const original = h.writes()[0]!
  expect(original.method).toBe('POST')
  expect(original.path).toBe(kind === 'request' ? `/weddings/${W}/slots/${S}/offer-requests` : `/weddings/${W}/offers/${O}/accept`)
  expect(original.headers.get('authorization')).toBe('Bearer ' + A.accessToken)
  expect(original.headers.get('Idempotency-Key')).toBeTruthy()
  expect(original.body).toEqual(kind === 'request' ? bodyFor([entry()]) : {})
  return original
}
function assertNoStaleCompletion(h: ReturnType<typeof mount>, expectedTokens: string | null) {
  const witness = { refresh: h.refreshes().map(c => c.body), writes: h.writes().map(c => ({ path: c.path, authorization: c.headers.get('authorization') })), callbacks: h.changed.mock.calls.length }
  expect(witness, JSON.stringify(witness)).toEqual({ refresh: [], writes: [{ path: h.writes()[0]!.path, authorization: 'Bearer ' + A.accessToken }], callbacks: 0 })
  expect(localStorage.getItem('tt_auth')).toBe(expectedTokens)
  expect(screen.queryByRole('status')).toBeNull()
}

for (const kind of ['request', 'accept'] as const) {
  const boundaries: readonly Boundary[] = kind === 'request' ? requestBoundaries : acceptBoundaries
  describe(`${kind}: real-client origin fence`, () => {
    it.each(boundaries)('held original401 after %s cannot refresh/replay or call a stale UI callback', async boundary => {
      const h = mount(kind); await h.click(); assertOriginal(h, kind)
      await h.boundary(boundary); const currentTokens = localStorage.getItem('tt_auth'), reply = observed(unauthorized())
      await act(async () => { h.initial.resolve(reply.response) }); await reply.finished()
      assertNoStaleCompletion(h, currentTokens)
    })
    it.each(boundaries)('a successful body held across %s cannot publish success or call a stale callback', async boundary => {
      const h = mount(kind); await h.click(); const original = assertOriginal(h, kind)
      let stream!: ReadableStreamDefaultController<Uint8Array>
      const reply = observed(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { 'content-type': 'application/json' } }))
      await act(async () => { h.initial.resolve(reply.response) })
      await waitFor(() => expect(reply.started()).toBe(true)) // The client owns/reads this real body before the boundary.
      await h.boundary(boundary); const currentTokens = localStorage.getItem('tt_auth')
      await act(async () => { stream.enqueue(new TextEncoder().encode(JSON.stringify(successBody(kind, original)))); stream.close() })
      await reply.finished(); assertNoStaleCompletion(h, currentTokens)
    })
    const retryBoundaries: Boundary[] = kind === 'request' ? ['actor', 'A-B-A', 'entries-A-B-A', 'wedding-prop'] : ['actor', 'A-B-A', 'offer', 'permission-A-B-A']
    it.each(retryBoundaries)('transport uncertainty cannot reuse the old key for a new intention after %s', async boundary => {
      const h = mount(kind); await h.click(); const original = assertOriginal(h, kind)
      await act(async () => { h.initial.reject(new TypeError('Synthetic lost response')) })
      await screen.findByRole('alert'); await h.boundary(boundary); await h.click()
      await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
      expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(2)
      const next = h.writes()[1]!
      expect(next.headers.get('Idempotency-Key')).toBeTruthy(); expect(next.headers.get('Idempotency-Key')).not.toBe(original.headers.get('Idempotency-Key'))
      expect(next.body).toEqual(kind === 'request' ? h.expectedRequest() : {})
      expect(next.path).toBe(boundary === 'wedding-prop' ? `/weddings/${W2}/slots/${S2}/offer-requests` : kind === 'request' ? original.path : `/weddings/${W}/offers/${boundary === 'offer' ? O2 : O}/accept`)
      expect(next.headers.get('authorization')).toBe('Bearer ' + (boundary === 'actor' ? B : A).accessToken)
    })
    it('unchanged scope retains the exact uncertain path/body/key through an equivalent rerender', async () => {
      const h = mount(kind); await h.click(); const original = assertOriginal(h, kind)
      await act(async () => { h.initial.reject(new TypeError('Synthetic lost response')) })
      await screen.findByRole('alert'); await h.unchangedRerender(); await h.click()
      await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
      expect(h.writes()).toHaveLength(2); expect(h.refreshes()).toHaveLength(0)
      const retry = h.writes()[1]!
      expect(retry.path).toBe(original.path); expect(retry.rawBody).toBe(original.rawBody)
      expect(retry.headers.get('Idempotency-Key')).toBe(original.headers.get('Idempotency-Key'))
      expect(retry.headers.get('authorization')).toBe('Bearer ' + A.accessToken)
    })
    it('same-sub/sid token renewal performs exactly one refresh and one exact automatic retry', async () => {
      const h = mount(kind); await h.click(); const original = assertOriginal(h, kind), reply = observed(unauthorized())
      await h.unchangedRerender(); await act(async () => { h.initial.resolve(reply.response) }); await reply.finished()
      await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
      expect(h.refreshes()).toHaveLength(1); expect(h.refreshes()[0]!.body).toEqual({ refreshToken: A.refreshToken }); expect(h.writes()).toHaveLength(2)
      const retry = h.writes()[1]!, saved = JSON.parse(localStorage.getItem('tt_auth')!) as typeof A
      expect(retry.path).toBe(original.path); expect(retry.rawBody).toBe(original.rawBody)
      expect(retry.headers.get('Idempotency-Key')).toBe(original.headers.get('Idempotency-Key'))
      expect(retry.headers.get('authorization')).toBe('Bearer ' + saved.accessToken)
      expect(JSON.parse(atob(saved.accessToken.split('.')[1]!))).toMatchObject({ sub: id(20), sid: id(30), serial: 1 })
      expect(saved.refreshToken).toBe(A.refreshToken + '-renewed')
      if (kind === 'accept') expect([original.rawBody, retry.rawBody]).toEqual(['{}', '{}']) // Never resubmit the stored price/package/terms.
    })
    it('an unchanged successful intent really consumes its response and announces exactly once', async () => {
      const h = mount(kind); await h.click(); const original = assertOriginal(h, kind), reply = observed(json(successBody(kind, original), kind === 'request' ? 201 : 200))
      await act(async () => { h.initial.resolve(reply.response) }); await reply.finished()
      await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
      expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
      expect(screen.getByRole('status').textContent).toContain(kind === 'request' ? 'Запрос отправлен' : 'Бронь создана по условиям предложения')
    })
    it('late A body/finally cannot release the genuinely pending B action in the same mounted UI', async () => {
      const h = mount(kind, true); await h.click(); const original = assertOriginal(h, kind)
      let stream!: ReadableStreamDefaultController<Uint8Array>, closed = false
      const reply = observed(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { 'content-type': 'application/json' } }))
      await act(async () => { h.initial.resolve(reply.response) }); await waitFor(() => expect(reply.started()).toBe(true))
      try {
        await h.boundary('actor'); await h.unchangedRerender(); await h.click()
        await waitFor(() => expect(h.writes()).toHaveLength(2))
        const current = h.writes()[1]!
        expect(current.headers.get('authorization')).toBe('Bearer ' + B.accessToken)
        expect(current.headers.get('Idempotency-Key')).not.toBe(original.headers.get('Idempotency-Key'))
        const pendingName = kind === 'request' ? 'Отправляем…' : /^Принять предложение:/
        expect((screen.getByRole('button', { name: pendingName }) as HTMLButtonElement).disabled).toBe(true)
        await act(async () => { stream.enqueue(new TextEncoder().encode(JSON.stringify(successBody(kind, original)))); stream.close(); closed = true })
        await reply.finished()
        expect(h.changed).toHaveBeenCalledTimes(0); expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(2)
        expect(screen.queryByRole('status')).toBeNull()
        expect((screen.getByRole('button', { name: pendingName }) as HTMLButtonElement).disabled).toBe(true)
        expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
        const bReply = observed(json(successBody(kind, current), kind === 'request' ? 201 : 200))
        await act(async () => { h.second.resolve(bReply.response) }); await bReply.finished()
        await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
      } finally {
        if (!closed) {
          await act(async () => { stream.enqueue(new TextEncoder().encode(JSON.stringify(successBody(kind, original)))); stream.close() })
          await reply.finished()
        }
      }
    })
  })
}

it('request keeps the uncertain key when a trailing-space wishes edit normalizes to the identical wire body', async () => {
  const h = mount('request')
  const open = await screen.findByRole('button', { name: /^Запросить предложение/ })
  expect((open as HTMLButtonElement).disabled).toBe(false); fireEvent.click(open)
  const wishes = await screen.findByPlaceholderText('Пожелания к предложению (необязательно)')
  expect((wishes as HTMLTextAreaElement).disabled).toBe(false)
  fireEvent.change(wishes, { target: { value: 'foo' } })
  const submit = screen.getByRole('button', { name: 'Отправить запрос' })
  expect((submit as HTMLButtonElement).disabled).toBe(false); fireEvent.click(submit)
  await waitFor(() => expect(h.writes()).toHaveLength(1))
  const first = h.writes()[0]!
  expect(first.method).toBe('POST'); expect(first.path).toBe(`/weddings/${W}/slots/${S}/offer-requests`)
  expect(first.body).toEqual({ entryIds: [E], wishes: 'foo' })
  expect(first.headers.get('authorization')).toBe('Bearer ' + A.accessToken)
  expect(first.headers.get('Idempotency-Key')).toBeTruthy()
  expect((submit as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { h.initial.reject(new TypeError('Synthetic response loss')) })
  await screen.findByRole('alert')
  const retry = screen.getByRole('button', { name: 'Отправить запрос' })
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
  expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
  fireEvent.change(wishes, { target: { value: 'foo ' } })
  expect((wishes as HTMLTextAreaElement).value).toBe('foo ')
  expect((retry as HTMLButtonElement).disabled).toBe(false); fireEvent.click(retry)
  await waitFor(() => expect(h.writes()).toHaveLength(2))
  await waitFor(() => expect(h.changed).toHaveBeenCalledTimes(1))
  const second = h.writes()[1]!
  expect(second.method).toBe('POST'); expect(second.path).toBe(first.path)
  expect(second.rawBody).toBe(first.rawBody); expect(second.body).toEqual(first.body)
  expect(second.headers.get('authorization')).toBe(first.headers.get('authorization'))
  expect(h.refreshes()).toHaveLength(0); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(A)
  expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'))
})
