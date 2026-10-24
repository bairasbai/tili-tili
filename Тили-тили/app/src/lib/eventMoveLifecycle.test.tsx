// @vitest-environment jsdom
// Independent rendered regressions. Real pages, Store, hooks, API wrappers and
// client; only fetch is controlled. These fixtures prove no native ACL or SQL.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WeddingEventMoves from '@/pages/WeddingEventMoves'
import RootEventMove from '@/pages/RootEventMove'
import { StoreProvider, useStore } from './store'
import { saveTokens } from './api/client'
import type { components } from './api/schema'
import { setI18nLang } from './i18n'

const id = (n: number) => `84000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), EVENT = id(2), MAIN = id(3), DEAL = id(4), PROPOSAL = id(5), VENDOR = id(6), SLOT = id(7)
const ROOT_DIGEST = 'a'.repeat(64), BUNDLE_DIGEST = 'b'.repeat(64), NEW_ROOT_DIGEST = 'c'.repeat(64)
const READ_PROOF = 'synthetic-own-root-read-proof-A', NEW_READ_PROOF = 'synthetic-own-root-read-proof-B'
const SESSION_B_READ_PROOF = 'synthetic-own-root-read-proof-session-B'
const token = (user: number, session: number, revision = 0) => `header.${btoa(JSON.stringify({ sub: id(user), sid: id(session), revision }))}.signature`
const A = { accessToken: token(90, 91), refreshToken: 'move-lifecycle-A-refresh' }
const B = { accessToken: token(92, 93), refreshToken: 'move-lifecycle-B-refresh' }
const RENEWED = { accessToken: token(90, 91, 1), refreshToken: 'move-lifecycle-A-renewed' }
type Target = components['schemas']['EventMoveTarget']
type Proposal = components['schemas']['EventMoveProposal']
type RootView = components['schemas']['EventMoveRootView']
type Receipt = components['schemas']['EventMoveReceipt']
type Door = 'propose' | 'accept' | 'apply' | 'cancel'
type Terminal = 'network' | '401'
// Current event and the requested target are separate independent server/input
// facts. No product constructor or digest function supplies expected values.
const before: Target = { date: '2030-08-15', timeZone: 'Pacific/Kiritimati', location: 'Исходный зал' }
const target: Target = { date: '2030-08-17', timeZone: 'Pacific/Kiritimati', location: 'Новый зал' }
const wedding = { id: W, title: 'Свадьба для lifecycle', date: '2030-06-14', tz: 'Pacific/Honolulu', role: 'couple', city: { name: 'Уфа', region: 'Башкортостан' } }
const eventRecord = (): components['schemas']['WeddingEvent'] => ({ id: EVENT, name: 'Дополнительный ужин', kind: 'second_day', isMain: false, ...before, rsvpDeadline: null })
const mainRecord = (): components['schemas']['WeddingEvent'] => ({ id: MAIN, name: 'Основная церемония', kind: 'ceremony', isMain: true, date: '2030-06-14', timeZone: 'Pacific/Honolulu', location: 'Основной зал', rsvpDeadline: null })
const receipt = (party: Receipt['party']): Receipt => ({ id: id(party === 'customer' ? 20 : 21), party,
  userId: id(party === 'customer' ? 90 : 94), sessionId: id(party === 'customer' ? 91 : 95), digest: ROOT_DIGEST, acceptedAt: '2030-01-01T10:00:00.000Z' })
const proposalRecord = (agreed = true): Proposal => ({ id: PROPOSAL, eventId: EVENT, digest: BUNDLE_DIGEST,
  from: { ...before }, to: { ...target }, status: 'pending', createdAt: '2030-01-01T09:00:00.000Z',
  roots: [{ dealId: DEAL, digest: ROOT_DIGEST, receipts: agreed ? [receipt('customer'), receipt('performer')] : [] }] })
const rootRecord = (): RootView => ({ id: PROPOSAL, eventId: EVENT, dealId: DEAL, digest: ROOT_DIGEST,
  status: 'pending', readToken: READ_PROOF, receipts: [], material: {
    schemaVersion: 1, proposalId: PROPOSAL, dealId: DEAL,
    event: { id: EVENT, name: 'Дополнительный ужин', kind: 'second_day', from: { ...before }, to: { ...target } },
    economics: { amount: 314159, currency: 'RUB', vendorId: VENDOR, packageTitle: 'Репортаж ужина', packageIncludes: ['Два часа съёмки'],
      comparisonTerms: { hours: 'Два часа', team: 'Один фотограф', result: '100 кадров', delivery: '14 дней', extras: 'Проезд включён', cancellation: 'Сохранённый текст отмены', reschedule: 'Только по отдельному согласию' } },
    assignments: [{ id: id(8), slotId: SLOT, eventId: EVENT, label: 'Портреты гостей ужина' }],
    preserved: { price: true, payments: true, paymentDueDates: true, otherEvents: true },
  } })
const collectionPath = `/weddings/${W}/events/${EVENT}/move-proposals`
const rootPath = `/deals/${DEAL}/event-moves/${PROPOSAL}`
const writePath = (door: Door) => door === 'propose' ? collectionPath : door === 'accept' ? `${rootPath}/accept` : `${collectionPath}/${PROPOSAL}/${door}`
const commandLabel = (door: Door) => door === 'propose' ? 'Предложить перенос' : door === 'accept' ? 'Подтвердить перенос своего заказа'
  : door === 'apply' ? 'Применить согласованный перенос' : 'Отменить предложение переноса'
const refreshLabel = (door: Door) => door === 'accept' ? 'Обновить предложение переноса' : 'Обновить предложения переноса'
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Synthetic old access expired' } }, 401)
function held<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void, settled = false
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, get settled() { return settled }, resolve(value: T) { if (!settled) { settled = true; resolve(value) } }, reject(reason: Error) { if (!settled) { settled = true; reject(reason) } } }
}
type Call = { method: string; path: string; query: string; body: string | null; headers: Headers; response?: Response; finished: boolean }
type Network = ReturnType<typeof network>
let active: Network | null = null
function network(door: Door, undated = false) {
  const calls: Call[] = [], unexpected: string[] = [], pending = held<Response>()
  const from: Proposal['from'] = { ...before, date: undated ? null : before.date }
  const proposal = (agreed = true): Proposal => ({ ...proposalRecord(agreed), from: { ...from } })
  const initialRoot = rootRecord()
  let holdFirst = false, currentEvent = { ...eventRecord(), date: from.date }, etag = '"move-v1"'
  let root: RootView = { ...initialRoot, material: { ...initialRoot.material,
    event: { ...initialRoot.material.event, from: { ...from } } } }
  let proposals: Proposal[] = door === 'apply' || door === 'cancel' ? [proposal()] : []
  const writes = () => calls.filter(c => c.method === 'POST' && c.path === writePath(door))
  const reads = () => calls.filter(c => c.method === 'GET' && c.path === (door === 'accept' ? rootPath : collectionPath))
  const success = (call: Call) => {
    if (door === 'propose') { proposals = [proposal(false)]; return json(proposals[0], 201) }
    if (door === 'accept') {
      const accepted = { ...receipt('customer'), digest: root.digest,
        ...(call.headers.get('authorization') === `Bearer ${B.accessToken}` ? { userId: id(92), sessionId: id(93) } : {}) }
      root = { ...root, receipts: [accepted] }
      return json({ id: PROPOSAL, dealId: DEAL, digest: root.digest, receipts: [accepted] })
    }
    proposals = proposals.map((p): Proposal => ({ ...p, status: door === 'apply' ? 'applied' : 'cancelled' }))
    if (door === 'apply') { currentEvent = { ...currentEvent, ...target }; etag = '"move-v2"' }
    return json(proposals[0])
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'), path = url.pathname.replace(/^\/api/, '')
    const call: Call = { method: init?.method ?? 'GET', path, query: url.search, body: init?.body == null ? null : String(init.body), headers: new Headers(init?.headers), finished: false }
    calls.push(call)
    try {
      let response: Response
      if (call.query) {
        unexpected.push(`${call.method} ${path}${call.query}`); response = json({ error: { code: 'unexpected_fixture_query', message: 'Closed fixture query' } }, 500)
      } else if (call.method === 'POST' && path === writePath(door)) {
        response = holdFirst && writes().length === 1 ? await pending.promise : success(call)
      } else if (call.method === 'POST' && path === '/auth/refresh') {
        // Detect forbidden refresh/replay through the real client. Returning a
        // valid response lets count/body/identity assertions expose the breach.
        response = json(RENEWED)
      } else if (call.method === 'GET' && call.body === null) {
        if (path === '/weddings') response = json([wedding])
        else if (path === `/weddings/${W}`) response = json(wedding)
        else if (path === `/weddings/${W}/slots`) response = json([])
        else if (path === '/me/favorites') response = json([])
        else if (path === `/weddings/${W}/events`) response = json([mainRecord(), currentEvent], 200, { etag })
        else if (path === collectionPath) response = json(proposals)
        else if (path === rootPath) response = json(call.headers.get('authorization') === `Bearer ${B.accessToken}` ? { ...root, readToken: SESSION_B_READ_PROOF } : root)
        else { unexpected.push(`${call.method} ${path}`); response = json({ error: { code: 'unexpected_fixture_get', message: 'Closed fixture route' } }, 500) }
      } else { unexpected.push(`${call.method} ${path}`); response = json({ error: { code: 'unexpected_fixture_write', message: 'Closed fixture write' } }, 500) }
      call.response = response
      return response
    } finally { call.finished = true }
  }))
  const result = { calls, writes, reads, pending, unexpected,
    hold: () => { holdFirst = true },
    refreshes: () => calls.filter(c => c.path === '/auth/refresh'),
    changeSource: () => {
      currentEvent = { ...currentEvent, location: 'Изменённый действующий зал' }; etag = '"move-v2"'
      root = { ...root, digest: NEW_ROOT_DIGEST, readToken: NEW_READ_PROOF,
        material: { ...root.material, event: { ...root.material.event, from: { ...from, location: 'Изменённый действующий зал' } } } }
    },
  }
  active = result
  return result
}
function StoreProbe() {
  const store = useStore()
  return <output data-testid="move-real-store">{JSON.stringify({ wedding: store.weddingId, phase: store.slotsState })}</output>
}
function mountPage(door: Door, undated = false) {
  const h = network(door, undated)
  const entry = door === 'accept' ? `/deal/${DEAL}/event-moves/${PROPOSAL}` : `/wedding/events/${EVENT}/move`
  const view = render(<MemoryRouter initialEntries={[entry]}><StoreProvider><StoreProbe /><Routes>
    <Route path="/wedding/events/:eventId/move" element={<WeddingEventMoves />} />
    <Route path="/deal/:dealId/event-moves/:proposalId" element={<RootEventMove />} />
  </Routes></StoreProvider></MemoryRouter>)
  return { ...h, view }
}
async function readyPage(h: Network, door: Door) {
  await waitFor(() => expect(JSON.parse(screen.getByTestId('move-real-store').textContent!).phase).toBe('ready'))
  await screen.findByRole('button', { name: commandLabel(door) })
  await waitFor(() => { expect(h.reads().length).toBeGreaterThan(0); expect(h.reads().every(c => c.response?.bodyUsed)).toBe(true) })
}
const button = (door: Door) => screen.getByRole('button', { name: commandLabel(door) }) as HTMLButtonElement
const disabled = (element: HTMLElement) => element.matches(':disabled')
async function prepare(door: Door) {
  if (door === 'propose') {
    fireEvent.change(screen.getByLabelText('Новая дата'), { target: { value: target.date } })
    fireEvent.change(screen.getByLabelText('Место мероприятия'), { target: { value: target.location } })
  } else if (door === 'accept') {
    const checkbox = screen.getByRole('checkbox', { name: 'Я прочитал все условия переноса этого заказа и согласен с ними' }) as HTMLInputElement
    if (!checkbox.checked) fireEvent.click(checkbox)
  }
  await waitFor(() => expect(disabled(button(door))).toBe(false))
}
async function start(h: Network, door: Door) {
  await readyPage(h, door); await prepare(door); fireEvent.click(button(door))
  await waitFor(() => expect(h.writes()).toHaveLength(1))
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }
async function refreshSame(h: Network, door: Door) {
  const count = h.reads().length
  const refresh = screen.getByRole('button', { name: refreshLabel(door) }) as HTMLButtonElement
  expect(disabled(refresh)).toBe(false)
  fireEvent.click(refresh)
  await waitFor(() => { expect(h.reads()).toHaveLength(count + 1); expect(h.reads().at(-1)?.response?.bodyUsed).toBe(true) })
  await waitFor(() => expect(disabled(screen.getByRole('button', { name: refreshLabel(door) }))).toBe(false))
  await flush()
}
async function release(h: Network, terminal: Terminal) {
  const response = terminal === '401' ? unauthorized() : null
  await act(async () => { if (response) h.pending.resolve(response); else h.pending.reject(new TypeError('Synthetic lost response')) })
  await waitFor(() => expect(h.writes()[0]!.finished).toBe(true))
  if (response) await waitFor(() => expect(response.bodyUsed).toBe(true))
  await flush()
}
function assertWire(call: Call, door: Door, actor = A, currentVersion = '"move-v1"') {
  expect(call.method).toBe('POST'); expect(call.path).toBe(writePath(door)); expect(call.query).toBe('')
  expect(call.headers.get('authorization')).toBe(`Bearer ${actor.accessToken}`)
  expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/i)
  expect(call.headers.get('if-match')).toBe(door === 'propose' ? currentVersion : null)
  expect(JSON.parse(call.body!)).toEqual(door === 'propose' ? target : door === 'accept' ? { digest: ROOT_DIGEST, readToken: actor === B ? SESSION_B_READ_PROOF : READ_PROOF } : { digest: BUNDLE_DIGEST })
  expect(call.headers.get('x-program-event-context')).toBeNull()
}
beforeEach(() => {
  active = null; localStorage.clear(); sessionStorage.clear(); setI18nLang('ru'); saveTokens(A)
  localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify('2030-06-14')); localStorage.setItem('tt_onboarded', '1')
})
afterEach(async () => {
  cleanup()
  if (active && !active.pending.settled) await act(async () => { active!.pending.resolve(json({ error: { code: 'test_disposed', message: 'Disposed pending response' } }, 503)) })
  saveTokens(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear()
  expect(active?.unexpected ?? []).toEqual([])
})

describe('additional-event move rendered lifecycle through real client', () => {
  it.each((['propose', 'accept', 'apply', 'cancel'] as const).flatMap(door => (['network', '401'] as const).map(terminal => ({ door, terminal }))))(
    '$door pending → identical parent refresh → old $terminal settles: releases busy and preserves the uncertain retry identity', async ({ door, terminal }) => {
      const h = mountPage(door); h.hold(); await start(h, door)
      const first = h.writes()[0]!; assertWire(first, door)
      expect(disabled(button(door))).toBe(true)
      await refreshSame(h, door)
      // The old request has not settled: no second write is yet permitted.
      expect(disabled(button(door))).toBe(true); expect(h.writes()).toHaveLength(1)
      await release(h, terminal)
      expect(h.refreshes()).toEqual([]); expect(h.writes()).toHaveLength(1)
      expect(screen.queryByRole('alert')).toBeNull()
      // Behavioral RED on reviewed source: retired finally leaves this exact
      // same-source form permanently busy. Do not remove source retirement.
      await waitFor(() => expect(disabled(button(door))).toBe(false))
      await prepare(door); fireEvent.click(button(door))
      await waitFor(() => expect(h.writes()).toHaveLength(2))
      const retry = h.writes()[1]!; assertWire(retry, door)
      expect(retry.body).toBe(first.body)
      expect(retry.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'))
      await waitFor(() => expect(retry.response?.bodyUsed).toBe(true))
      expect(h.refreshes()).toEqual([])
    },
  )
  it.each(['propose', 'accept'] as const)('%s direct manual retry after a lost response retains key/body without a parent refresh', async door => {
    const h = mountPage(door); h.hold(); await start(h, door)
    const first = h.writes()[0]!; assertWire(first, door)
    await release(h, 'network')
    await screen.findByRole('alert')
    await prepare(door); fireEvent.click(button(door))
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    const retry = h.writes()[1]!; assertWire(retry, door)
    expect(retry.body).toBe(first.body); expect(retry.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'))
    await waitFor(() => expect(retry.response?.bodyUsed).toBe(true)); expect(h.refreshes()).toEqual([])
  })
  it.each(['propose', 'accept'] as const)('%s changed read source retires the held command and late401 cannot refresh/replay it', async door => {
    const h = mountPage(door); h.hold(); await start(h, door)
    const first = h.writes()[0]!
    h.changeSource(); await refreshSame(h, door)
    if (door === 'propose') expect((screen.getByLabelText('Место мероприятия') as HTMLInputElement).value).toBe('Изменённый действующий зал')
    else expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    await release(h, '401')
    expect(h.refreshes()).toEqual([]); expect(h.writes()).toHaveLength(1); expect(screen.queryByRole('alert')).toBeNull()
    await prepare(door); fireEvent.click(button(door))
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    const fresh = h.writes()[1]!
    expect(fresh.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'))
    expect(fresh.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`)
    expect(JSON.parse(fresh.body!)).toEqual(door === 'propose' ? target : { digest: NEW_ROOT_DIGEST, readToken: NEW_READ_PROOF })
    expect(fresh.headers.get('if-match')).toBe(door === 'propose' ? '"move-v2"' : null)
    await waitFor(() => expect(fresh.response?.bodyUsed).toBe(true))
  })
  it.each(['propose', 'accept'] as const)('%s session A → B retires the held command; late401 never refreshes B or sends A intent', async door => {
    const h = mountPage(door); h.hold(); await start(h, door)
    const first = h.writes()[0]!; assertWire(first, door)
    const oldReads = h.reads().length
    await act(async () => { saveTokens(B) })
    await waitFor(() => {
      expect(h.reads().length).toBeGreaterThan(oldReads)
      expect(h.reads().at(-1)?.headers.get('authorization')).toBe(`Bearer ${B.accessToken}`)
      expect(h.reads().at(-1)?.response?.bodyUsed).toBe(true)
    })
    await readyPage(h, door); await release(h, '401')
    expect(h.refreshes()).toEqual([]); expect(h.writes()).toHaveLength(1); expect(screen.queryByRole('alert')).toBeNull()
    await prepare(door); fireEvent.click(button(door))
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    const fresh = h.writes()[1]!; assertWire(fresh, door, B)
    expect(fresh.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'))
    await waitFor(() => expect(fresh.response?.bodyUsed).toBe(true))
    expect(JSON.parse(localStorage.getItem('tt_auth')!).accessToken).toBe(B.accessToken)
  })
  it('proposal records only the exact requested target/If-Match and does not apply or accept a root automatically', async () => {
    const h = mountPage('propose'); await start(h, 'propose'); assertWire(h.writes()[0]!, 'propose')
    const link = await screen.findByRole('link', { name: 'Прочитать и согласовать заказ 1' })
    expect(link.getAttribute('href')).toBe(`/deal/${DEAL}/event-moves/${PROPOSAL}`)
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    expect(disabled(screen.getByRole('button', { name: commandLabel('apply') }))).toBe(true)
    expect(screen.getByText('Исходные условия')).toBeTruthy(); expect(screen.getByText('Предлагаемые условия')).toBeTruthy()
  })
  it('own-root accept requires the read checkbox and sends only its read proof/digest, never price or apply', async () => {
    const h = mountPage('accept'); await readyPage(h, 'accept')
    expect(disabled(button('accept'))).toBe(true); expect(h.writes()).toHaveLength(0)
    expect(screen.getByText('Репортаж ужина')).toBeTruthy(); expect(screen.getByText('Два часа съёмки')).toBeTruthy()
    expect(screen.getByText('Только по отдельному согласию')).toBeTruthy(); expect(screen.getByText('Портреты гостей ужина')).toBeTruthy()
    expect(screen.getByText(/Цена сохраняется/).textContent?.replace(/[\u00a0\u202f]/g, ' ')).toBe('Цена сохраняется: 3 141,59 ₽ RUB')
    await prepare('accept'); fireEvent.click(button('accept')); await waitFor(() => expect(h.writes()).toHaveLength(1))
    assertWire(h.writes()[0]!, 'accept')
    await waitFor(() => { expect(h.reads()).toHaveLength(2); expect(h.reads().at(-1)?.response?.bodyUsed).toBe(true) })
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    expect(screen.getByText(/^Согласие пары:/)).toBeTruthy()
  })
  it.each(['apply', 'cancel'] as const)('%s remains an explicit couple action and sends only the bundle digest', async door => {
    const h = mountPage(door); await readyPage(h, door)
    expect(h.writes()).toHaveLength(0); await prepare(door); fireEvent.click(button(door))
    await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWire(h.writes()[0]!, door)
    await screen.findByRole('heading', { name: door === 'apply' ? 'Перенос применён' : 'Предложение переноса отменено' })
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it('first-date root material shows an unknown source date, requires its own checkbox and posts only the read proof', async () => {
    const h = mountPage('accept', true); await readyPage(h, 'accept')
    expect(screen.getByText(/^Дата не задана · Pacific\/Kiritimati · Исходный зал$/)).toBeTruthy()
    expect(disabled(button('accept'))).toBe(true); expect(h.writes()).toHaveLength(0)
    await prepare('accept'); fireEvent.click(button('accept'))
    await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWire(h.writes()[0]!, 'accept')
    expect(h.calls.filter(c => c.method === 'POST' && c.path.endsWith('/apply'))).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('tt_wedding_date')!)).toBe('2030-06-14')
  })
  it('first-date proposal begins with an empty date field and never submits the main date', async () => {
    const h = mountPage('propose', true); await readyPage(h, 'propose')
    expect((screen.getByLabelText('Новая дата') as HTMLInputElement).value).toBe('')
    expect(disabled(button('propose'))).toBe(true); expect(h.writes()).toHaveLength(0)
    await prepare('propose'); fireEvent.click(button('propose'))
    await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWire(h.writes()[0]!, 'propose')
    expect(JSON.parse(h.writes()[0]!.body!)).toEqual(target)
    expect(h.calls.filter(c => c.method === 'POST' && c.path.endsWith('/apply'))).toHaveLength(0)
  })
  it('all first-date agreements still wait for the separate explicit couple apply', async () => {
    const h = mountPage('apply', true); await readyPage(h, 'apply')
    expect((await screen.findAllByText(/Дата не задана/)).length).toBeGreaterThan(0)
    expect(h.writes()).toHaveLength(0)
    await prepare('apply'); fireEvent.click(button('apply'))
    await waitFor(() => expect(h.writes()).toHaveLength(1)); assertWire(h.writes()[0]!, 'apply')
    await screen.findByRole('heading', { name: 'Перенос применён' })
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
})
