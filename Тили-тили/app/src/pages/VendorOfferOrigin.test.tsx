// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorOfferRequests } from './VendorExtras'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const R1 = id(1), R2 = id(2), R3 = id(3), V = id(4), P1 = id(5), P2 = id(6), O = id(7)
const originalWishes = 'Личные пожелания первого запроса', helperWishes = 'Второй независимый запрос', updatedWishes = 'Текущая версия первого запроса'
const token = (user = 10, sid = 20, serial = 'original') => `header.${btoa(JSON.stringify({ sub: id(user), sid: id(sid) }))}.${serial}`
const A = { accessToken: token(), refreshToken: 'synthetic-vendor-refresh-A' }
const B = { accessToken: token(11, 21), refreshToken: 'synthetic-vendor-refresh-B' }
const renewed = { accessToken: token(10, 20, 'renewed'), refreshToken: 'synthetic-vendor-refresh-A-renewed' }
type Mode = 'package' | 'custom' | 'decline'
type Boundary = 'actor' | 'session' | 'A-B-A' | 'unmount'
type TargetChange = 'request' | 'offer' | 'date' | 'closed'
type Call = { path: string; method: string; raw: string | null; body: unknown; headers: Headers }
type RequestFixture = { id: string; status: 'open' | 'closed'; weddingDate: string; guests: number; city: string; wishes: string; createdAt: string; closeReason?: string; offer?: { id: string; requestId: string; kind: 'offer'; title: string; price: { amount: number; currency: 'RUB' }; includes: string[]; validUntil: string } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Synthetic original access expired' } }, 401)
const settle = () => new Promise<void>(done => setTimeout(done, 0))
const request = (requestId: string, wishes: string): RequestFixture => ({ id: requestId, status: 'open', weddingDate: '2027-06-14', guests: 60, city: 'Уфа', wishes, createdAt: '2026-10-16T10:00:00.000Z' })
const profile = { id: V, name: 'Синтетическая компания', categoryId: 'photo', packages: [
  { id: P1, name: 'Первый пакет', price: { amount: 250000, currency: 'RUB' }, includes: ['8 часов'] },
  { id: P2, name: 'Второй пакет', price: { amount: 350000, currency: 'RUB' }, includes: ['10 часов'] },
] }
function server(options: { holdRead?: string; holdRefresh?: boolean } = {}) {
  const original = deferred<Response>(), privateRead = deferred<Response>(), refreshRead = deferred<Response>(), calls: Call[] = []
  let records = [request(R1, originalWishes), request(R2, helperWishes)], nextChange: TargetChange | null = null
  const isWrite = (c: Call) => c.method === 'POST' && /^\/vendor\/offer-requests\/[^/]+\/offers$/.test(c.path)
  const applyChange = () => {
    if (!nextChange) return
    const first: RequestFixture = { ...records[0]!, wishes: updatedWishes }
    if (nextChange === 'request') first.id = R3
    if (nextChange === 'offer') first.offer = { id: O, requestId: R1, kind: 'offer', title: 'Новая сохранённая редакция', price: { amount: 300000, currency: 'RUB' }, includes: ['Новый состав'], validUntil: '2027-06-20' }
    if (nextChange === 'date') first.weddingDate = '2027-06-15'
    if (nextChange === 'closed') { first.status = 'closed'; first.closeReason = 'removed' }
    records = [first, records[1]!]; nextChange = null
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body == null ? null : String(init.body)
    const call: Call = { path: String(input).replace(/^\/api/, '').split('?')[0]!, method: init?.method ?? 'GET', raw, body: raw ? JSON.parse(raw) : null, headers: new Headers(init?.headers) }; calls.push(call)
    if (call.path === '/auth/refresh') return options.holdRefresh ? refreshRead.promise : json((call.body as { refreshToken: string }).refreshToken === A.refreshToken ? renewed : { accessToken: token(11, 21, 'renewed'), refreshToken: 'synthetic-B-consumed' })
    if (isWrite(call)) {
      if (call.path === `/vendor/offer-requests/${R1}/offers` && calls.filter(c => isWrite(c) && c.path === call.path).length === 1) return original.promise
      if (call.path === `/vendor/offer-requests/${R2}/offers`) applyChange()
      return json({ id: id(50), kind: 'offer', requestId: call.path.split('/')[3] })
    }
    if (options.holdRead === call.path && calls.filter(c => c.method === 'GET' && c.path === call.path).length === 1) return privateRead.promise
    if (call.path === '/vendor/offer-requests') return json(call.headers.get('authorization') === `Bearer ${B.accessToken}` ? [] : records)
    if (call.path === '/vendor/profile') return json(call.headers.get('authorization') === `Bearer ${B.accessToken}` ? { ...profile, id: id(40), name: 'Другая компания' } : profile)
    return json([])
  }))
  return { calls, original, privateRead, refreshRead, changeOnHelperSuccess: (change: TargetChange) => { nextChange = change }, writes: () => calls.filter(isWrite), refreshes: () => calls.filter(c => c.path === '/auth/refresh'), requestReads: () => calls.filter(c => c.method === 'GET' && c.path === '/vendor/offer-requests') }
}
const mount = () => render(<MemoryRouter initialEntries={['/vendor-app/offer-requests']}><VendorOfferRequests /></MemoryRouter>)
async function editor(wishes = originalWishes) {
  const article = (await screen.findByText(wishes)).closest('article')
  expect(article).not.toBeNull(); return within(article!)
}
async function clickReply(mode: Mode, wishes = originalWishes) {
  const q = await editor(wishes)
  const open = q.queryByRole('button', { name: 'Изменить ответ' }) ?? q.queryByRole('button', { name: 'Ответить' })
  if (open) fireEvent.click(open)
  fireEvent.click(q.getByRole('button', { name: mode === 'package' ? 'Пакет' : mode === 'custom' ? 'Своё предложение' : 'Отказ' }))
  if (mode === 'decline') fireEvent.change(q.getByPlaceholderText('Причина отказа'), { target: { value: 'Синтетическая причина отказа' } })
  else {
    if (mode === 'custom') {
      fireEvent.change(q.getByPlaceholderText('Название предложения'), { target: { value: 'Явный состав работы' } })
      fireEvent.change(q.getByPlaceholderText('Что входит — по пункту в строке'), { target: { value: 'Первый результат\nВторой результат' } })
    }
    fireEvent.change(q.getByLabelText('Цена предложения, ₽'), { target: { value: '2500' } })
    fireEvent.change(q.getByLabelText('Действует до'), { target: { value: '2027-06-20' } })
    fireEvent.change(q.getByPlaceholderText('Сообщение паре (необязательно)'), { target: { value: 'Синтетический ответ' } })
  }
  const button = q.getByRole('button', { name: mode === 'decline' ? 'Отправить отказ' : 'Отправить предложение' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button)
}
const expectedBody = (mode: Mode) => mode === 'decline' ? { kind: 'decline', message: 'Синтетическая причина отказа' } : {
  kind: 'offer', ...(mode === 'package' ? { packageId: P1 } : { title: 'Явный состав работы', includes: ['Первый результат', 'Второй результат'] }),
  price: { amount: 250000, currency: 'RUB' }, message: 'Синтетический ответ', validUntil: '2027-06-20',
}
async function changeBoundary(which: Boundary, mounted: ReturnType<typeof mount>) {
  await act(async () => {
    if (which === 'actor') saveTokens(B)
    else if (which === 'session') saveTokens({ accessToken: token(10, 22), refreshToken: 'synthetic-other-sid' })
    else if (which === 'A-B-A') { saveTokens(B); saveTokens(A) }
    else mounted.unmount()
    await settle()
  })
}
beforeEach(() => { localStorage.clear(); saveTokens(A); setI18nLang('ru') })
afterEach(() => { cleanup(); saveTokens(null); vi.unstubAllGlobals() })

describe.each<Mode>(['package', 'custom', 'decline'])('mounted vendor %s real-client origin', mode => {
  it.each<Boundary>(['actor', 'session', 'A-B-A', 'unmount'])('does not refresh or retry an old reply after %s', async which => {
    const h = server(), mounted = mount(); await clickReply(mode)
    expect(h.writes()).toHaveLength(1); expect(h.writes()[0]!.body).toEqual(expectedBody(mode))
    expect(h.writes()[0]!.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`)
    await changeBoundary(which, mounted); const reads = h.requestReads().length, response = unauthorized()
    await act(async () => { h.original.resolve(response); await settle() })
    expect(h.refreshes().map(c => c.body)).toEqual([]); expect(h.writes()).toHaveLength(1); expect(h.requestReads()).toHaveLength(reads)
    expect(response.bodyUsed || response.body?.locked).toBeTruthy()
    if (which === 'actor') expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
  })
  it('retains one same-sub/sid refresh and exact reply bytes/key', async () => {
    const h = server(); mount(); await clickReply(mode)
    await act(async () => { h.original.resolve(unauthorized()); await settle() })
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    expect(h.refreshes().map(c => c.body)).toEqual([{ refreshToken: A.refreshToken }])
    const [first, retry] = h.writes()
    expect(first!.path).toBe(`/vendor/offer-requests/${R1}/offers`); expect(first!.body).toEqual(expectedBody(mode))
    expect(retry!.path).toBe(first!.path); expect(retry!.raw).toBe(first!.raw)
    expect(first!.headers.get('Idempotency-Key')).toBeTruthy(); expect(retry!.headers.get('Idempotency-Key')).toBe(first!.headers.get('Idempotency-Key'))
    expect(retry!.headers.get('authorization')).toBe(`Bearer ${renewed.accessToken}`)
    await waitFor(() => expect(h.requestReads().length).toBeGreaterThan(1))
  })
  it('does not publish a held200 result or reload private requests after an actor change during its body', async () => {
    const h = server(), mounted = mount(); await clickReply(mode)
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c } }), { headers: { 'content-type': 'application/json' } })
    await act(async () => { h.original.resolve(response); await settle() }); await waitFor(() => expect(response.bodyUsed).toBe(true))
    await changeBoundary('actor', mounted); const reads = h.requestReads().length
    await act(async () => { stream.enqueue(new TextEncoder().encode('{}')); stream.close(); await settle() })
    expect(h.requestReads()).toHaveLength(reads); expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
  })
})
it.each<TargetChange>(['request', 'offer', 'date', 'closed'])('R2 success reloads changed R1 %s before its held401; old R1 cannot replay', async change => {
  const h = server(); mount(); await clickReply('package')
  h.changeOnHelperSuccess(change); await clickReply('package', helperWishes)
  await screen.findByText(updatedWishes); expect(h.writes()).toHaveLength(2)
  const reads = h.requestReads().length
  await act(async () => { h.original.resolve(unauthorized()); await settle() })
  expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(2); expect(h.requestReads()).toHaveLength(reads)
  expect(h.writes().map(c => c.path)).toEqual([`/vendor/offer-requests/${R1}/offers`, `/vendor/offer-requests/${R2}/offers`])
})
it('a selected package change while R1 is pending invalidates its held401 origin', async () => {
  const h = server(); mount(); await clickReply('package')
  fireEvent.change((await editor()).getByLabelText('Пакет'), { target: { value: P2 } })
  await act(async () => { h.original.resolve(unauthorized()); await settle() })
  expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1)
})
it('a changed date brought by R2 cannot receive the held200 success of an old R1', async () => {
  const h = server(); mount(); await clickReply('package')
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c } }), { headers: { 'content-type': 'application/json' } })
  await act(async () => { h.original.resolve(response); await settle() }); await waitFor(() => expect(response.bodyUsed).toBe(true))
  h.changeOnHelperSuccess('date'); await clickReply('package', helperWishes); await screen.findByText(updatedWishes)
  const reads = h.requestReads().length
  await act(async () => { stream.enqueue(new TextEncoder().encode('{}')); stream.close(); await settle() })
  expect(h.requestReads()).toHaveLength(reads); expect(h.writes()).toHaveLength(2)
  expect((await editor(updatedWishes)).getByText(updatedWishes)).toBeTruthy()
})
it.each(['/vendor/profile', '/vendor/offer-requests'])('the real private %s GET401 cannot consume B refresh', async path => {
  const h = server({ holdRead: path }); mount()
  await waitFor(() => expect(h.calls.some(c => c.path === path)).toBe(true))
  await act(async () => { saveTokens(B); h.privateRead.resolve(unauthorized()); await settle() })
  expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(0)
  expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
  expect(h.calls.filter(c => c.path === path && c.headers.get('authorization') === `Bearer ${A.accessToken}`)).toHaveLength(1)
})
it('a late same-origin refresh response cannot retry R1 or overwrite B', async () => {
  const h = server({ holdRefresh: true }), mounted = mount(); await clickReply('package')
  await act(async () => { h.original.resolve(unauthorized()); await settle() }); await waitFor(() => expect(h.refreshes()).toHaveLength(1))
  await changeBoundary('actor', mounted)
  await act(async () => { h.refreshRead.resolve(json(renewed)); await settle() })
  expect(h.writes()).toHaveLength(1); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
})
it('unchanged manual retry after response loss keeps the exact reply body/key', async () => {
  const h = server(); mount(); await clickReply('package')
  await act(async () => { h.original.reject(new TypeError('Synthetic response loss')); await settle() })
  await clickReply('package'); await waitFor(() => expect(h.writes()).toHaveLength(2))
  expect(h.writes()[1]!.raw).toBe(h.writes()[0]!.raw)
  expect(h.writes()[1]!.headers.get('Idempotency-Key')).toBe(h.writes()[0]!.headers.get('Idempotency-Key'))
})
it.each<TargetChange>(['request', 'date'])('a %s change after uncertainty starts a new key for the newly observed target', async change => {
  const h = server(); mount(); await clickReply('package')
  await act(async () => { h.original.reject(new TypeError('Synthetic response loss')); await settle() })
  const key = h.writes()[0]!.headers.get('Idempotency-Key')
  h.changeOnHelperSuccess(change); await clickReply('package', helperWishes); await screen.findByText(updatedWishes)
  await clickReply('package', updatedWishes); await waitFor(() => expect(h.writes()).toHaveLength(3))
  expect(h.writes()[2]!.path).toBe(`/vendor/offer-requests/${change === 'request' ? R3 : R1}/offers`)
  expect(h.writes()[2]!.body).toEqual(expectedBody('package')); expect(h.writes()[2]!.headers.get('Idempotency-Key')).not.toBe(key)
})

it('vendor package keeps the uncertain key when a trailing-space message edit normalizes to the identical wire body', async () => {
  const h = server(); mount(); const q = await editor()
  const open = q.queryByRole('button', { name: 'Ответить' })
  if (open) { expect((open as HTMLButtonElement).disabled).toBe(false); fireEvent.click(open) }
  const mode = q.getByRole('button', { name: 'Пакет' })
  expect((mode as HTMLButtonElement).disabled).toBe(false); fireEvent.click(mode)
  const price = q.getByLabelText('Цена предложения, ₽'), date = q.getByLabelText('Действует до')
  expect((price as HTMLInputElement).disabled).toBe(false); expect((date as HTMLInputElement).disabled).toBe(false)
  fireEvent.change(price, { target: { value: '2500' } }); fireEvent.change(date, { target: { value: '2027-06-20' } })
  const message = q.getByPlaceholderText('Сообщение паре (необязательно)')
  expect((message as HTMLTextAreaElement).disabled).toBe(false); fireEvent.change(message, { target: { value: 'foo' } })
  const submit = q.getByRole('button', { name: 'Отправить предложение' })
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(submit)
  await waitFor(() => expect(h.writes()).toHaveLength(1))
  const first = h.writes()[0]!
  expect(first.method).toBe('POST'); expect(first.path).toBe(`/vendor/offer-requests/${R1}/offers`)
  expect(first.body).toEqual({ ...expectedBody('package'), message: 'foo' })
  expect(first.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`)
  expect(first.headers.get('Idempotency-Key')).toBeTruthy(); expect((submit as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { h.original.reject(new TypeError('Synthetic response loss')); await settle() })
  await q.findByRole('alert')
  const retry = q.getByRole('button', { name: 'Отправить предложение' })
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
  expect(h.writes()).toHaveLength(1); expect(h.refreshes()).toHaveLength(0)
  fireEvent.change(message, { target: { value: 'foo ' } })
  expect((message as HTMLTextAreaElement).value).toBe('foo ')
  const reads = h.requestReads().length
  expect((retry as HTMLButtonElement).disabled).toBe(false); fireEvent.click(retry)
  await waitFor(() => expect(h.writes()).toHaveLength(2))
  await waitFor(() => expect(h.requestReads().length).toBeGreaterThan(reads))
  const second = h.writes()[1]!
  expect(second.method).toBe('POST'); expect(second.path).toBe(first.path)
  expect(second.raw).toBe(first.raw); expect(second.body).toEqual(first.body)
  expect(second.headers.get('authorization')).toBe(first.headers.get('authorization'))
  expect(h.refreshes()).toHaveLength(0); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(A)
  expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'))
})
