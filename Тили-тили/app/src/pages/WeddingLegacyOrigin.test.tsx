// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotDetail } from './Wedding'
import { StoreProvider, useStore } from '@/lib/store'
import { saveTokens } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = id(1), W2 = id(2), S = id(3), S2 = id(4), D = id(5), V = id(6), S3 = id(7), S4 = id(8)
const token = (user = 10, sid = 20, serial = 'original') => `header.${btoa(JSON.stringify({ sub: id(user), sid: id(sid) }))}.${serial}`
const A = { accessToken: token(), refreshToken: 'synthetic-refresh-A' }
const B = { accessToken: token(11, 21), refreshToken: 'synthetic-refresh-B' }
const renewed = { accessToken: token(10, 20, 'renewed'), refreshToken: 'synthetic-refresh-A-renewed' }
const invitation = 'https://example.invalid/synthetic-original-invite'
type Action = 'cancel' | 'external-create' | 'external-delete' | 'invite' | 'unmark'
type Boundary = 'actor' | 'session' | 'A-B-A' | 'wedding' | 'slot' | 'unmount'
type Call = { path: string; method: string; raw: string | null; body: unknown; headers: Headers }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Synthetic expired access' } }, 401)
const settle = () => new Promise<void>(done => setTimeout(done, 0))

function fixture(kind: Action, slotId: string, changed = false) {
  const external = kind === 'external-delete' || kind === 'invite'
  return {
    id: slotId, categoryId: 'photo', label: slotId === S || slotId === S3 ? 'Первая позиция' : 'Вторая позиция',
    tileState: kind === 'external-create' || kind === 'unmark' ? 'empty' : 'booked', prebooked: kind === 'unmark',
    deal: kind === 'external-create' || kind === 'unmark' ? null : {
      id: changed ? id(51) : slotId === S ? D : id(52), state: 'booked',
      vendor: external ? null : { id: V, name: changed ? 'Новый выбранный исполнитель' : 'Исходный исполнитель' },
      externalName: external ? changed ? 'Новый выбранный исполнитель' : 'Исходный внешний исполнитель' : null,
      externalPhone: external ? '+70000000000' : null,
      price: { amount: 250000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' },
    },
  }
}
function server(kind: Action, holdShortlist = false) {
  const original = deferred<Response>(), privateRead = deferred<Response>(), calls: Call[] = []
  let changed = false
  const completed = new Set<string>()
  const isWrite = (c: Call) => c.path.includes('/slots/') && c.method !== 'GET'
  const success = (slotId = S) => {
    completed.add(slotId)
    if (kind === 'invite') return json({ url: invitation })
    if (kind === 'external-delete' || kind === 'unmark') return new Response(null, { status: 204 })
    return json(kind === 'external-create' ? { ...fixture('external-delete', slotId), deal: { ...fixture('external-delete', slotId).deal!, externalName: 'Новый внешний специалист' } } : { ...fixture(kind, slotId), tileState: 'empty', deal: null })
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body == null ? null : String(init.body)
    const call: Call = { path: String(input).replace(/^\/api/, '').split('?')[0]!, method: init?.method ?? 'GET', raw, body: raw ? JSON.parse(raw) : null, headers: new Headers(init?.headers) }
    calls.push(call)
    if (call.path === '/auth/refresh') return json((call.body as { refreshToken: string }).refreshToken === A.refreshToken ? renewed : { accessToken: token(11, 21, 'renewed'), refreshToken: 'synthetic-B-consumed' })
    if (isWrite(call)) return calls.filter(isWrite).length === 1 ? original.promise : success(call.path.split('/')[4]!)
    if (call.path === '/weddings') return json([W, W2].map(weddingId => ({ id: weddingId, role: 'couple', title: 'Синтетическая свадьба', date: '2027-06-14', tz: 'Europe/Moscow' })))
    if (call.path === `/weddings/${W}` || call.path === `/weddings/${W2}`) return json({ id: call.path.endsWith(W) ? W : W2, title: 'Синтетическая свадьба', date: '2027-06-14', tz: 'Europe/Moscow' })
    if (call.path.endsWith('/slots')) {
      return json((call.path === `/weddings/${W2}/slots` ? [S3, S4] : [S, S2]).map(slotId => {
        const row = fixture(kind, slotId, slotId === S && changed)
        if (completed.has(slotId) && kind === 'external-create') Object.assign(row, { tileState: 'booked', deal: { ...fixture('external-delete', slotId).deal!, externalName: 'Новый внешний специалист' } })
        if (completed.has(slotId) && (kind === 'cancel' || kind === 'external-delete')) Object.assign(row, { tileState: 'empty', deal: null })
        if (completed.has(slotId) && kind === 'unmark') row.prebooked = false
        return row
      }))
    }
    if (holdShortlist && call.path === `/weddings/${W}/slots/${S}/shortlist`) return privateRead.promise
    return json([])
  }))
  return { calls, original, privateRead, success, changeDeal: () => { changed = true }, writes: () => calls.filter(isWrite), refreshes: () => calls.filter(c => c.path === '/auth/refresh'), slotReads: () => calls.filter(c => c.method === 'GET' && c.path.endsWith('/slots')) }
}
function Controls() {
  const nav = useNavigate(), location = useLocation(), { setWeddingId, refreshSlots } = useStore()
  return <><output data-testid="legacy-location">{location.pathname}</output><button onClick={() => setWeddingId(W2)}>Тест: другая свадьба</button><button onClick={() => nav(`/wedding/slot/${S2}`)}>Тест: другая позиция</button><button onClick={refreshSlots}>Тест: перечитать позиции</button></>
}
function mount() {
  return render(<MemoryRouter initialEntries={[`/wedding/slot/${S}`]}><StoreProvider><Controls /><Routes><Route path="/wedding/slot/:id" element={<SlotDetail />} /><Route path="/wedding" element={<p>Команда после подтверждённого действия</p>} /></Routes></StoreProvider></MemoryRouter>)
}
async function enabledClick(name: string) {
  const button = await screen.findByRole('button', { name })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button)
}
async function clickAction(kind: Action) {
  if (kind === 'external-create') {
    await enabledClick('Добавить своего специалиста')
    fireEvent.change(screen.getByPlaceholderText('Имя / название (напр. Фотограф Ирек)'), { target: { value: 'Новый внешний специалист' } })
    fireEvent.change(screen.getByPlaceholderText('Цена, ₽'), { target: { value: '2500' } })
    fireEvent.change(screen.getByPlaceholderText('Телефон'), { target: { value: '+70000000000' } })
    await enabledClick('Добавить в команду')
  } else if (kind === 'cancel' || kind === 'external-delete') {
    await enabledClick(kind === 'cancel' ? 'Отменить бронь' : 'Удалить подрядчика'); await enabledClick('Точно отменить?')
  } else await enabledClick(kind === 'invite' ? 'Создать ссылку-приглашение' : 'Нет, ещё ищем')
}
function expectedWrite(kind: Action, slotId = S) {
  const suffix = kind === 'cancel' ? 'cancel' : kind === 'invite' ? 'external/invite' : kind === 'unmark' ? 'prebooked' : 'external'
  return { path: `/weddings/${W}/slots/${slotId}/${suffix}`, method: kind === 'external-delete' || kind === 'unmark' ? 'DELETE' : 'POST', body: kind === 'external-create' ? { vendorName: 'Новый внешний специалист', price: { amount: 250000, currency: 'RUB' }, phone: '+70000000000' } : kind === 'external-delete' || kind === 'unmark' ? null : {} }
}
async function boundary(which: Boundary, mounted: ReturnType<typeof mount>) {
  await act(async () => {
    if (which === 'actor') saveTokens(B)
    else if (which === 'session') saveTokens({ accessToken: token(10, 22), refreshToken: 'synthetic-other-session' })
    else if (which === 'A-B-A') { saveTokens(B); saveTokens(A) }
    else if (which === 'wedding') fireEvent.click(screen.getByRole('button', { name: 'Тест: другая свадьба' }))
    else if (which === 'slot') fireEvent.click(screen.getByRole('button', { name: 'Тест: другая позиция' }))
    else mounted.unmount()
    await settle()
  })
}
beforeEach(() => { localStorage.clear(); saveTokens(A); localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14')); setI18nLang('ru') })
afterEach(() => { cleanup(); saveTokens(null); vi.unstubAllGlobals() })

describe.each<Action>(['cancel', 'external-create', 'external-delete', 'invite', 'unmark'])('SlotView %s real-client origin', kind => {
  it.each<Boundary>(['actor', 'session', 'A-B-A', 'wedding', 'slot', 'unmount'])('refuses held original401 after %s before consuming refresh or replay', async which => {
    const h = server(kind), mounted = mount(); await clickAction(kind)
    expect(h.writes()).toHaveLength(1); expect(h.writes()[0]).toMatchObject(expectedWrite(kind))
    expect(h.writes()[0]!.headers.get('authorization')).toBe(`Bearer ${A.accessToken}`)
    await boundary(which, mounted)
    const path = screen.queryByTestId('legacy-location')?.textContent, reads = h.slotReads().length, response = unauthorized()
    await act(async () => { h.original.resolve(response); await settle() })
    expect(h.refreshes().map(c => c.body)).toEqual([]); expect(h.writes()).toHaveLength(1)
    expect(h.slotReads()).toHaveLength(reads)
    if (which !== 'unmount') expect(screen.getByTestId('legacy-location').textContent).toBe(path)
    expect(screen.queryByText(invitation)).toBeNull()
    expect(response.bodyUsed || response.body?.locked).toBeTruthy()
    if (which === 'actor') expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
  })
  it('allows one same-sub/sid refresh and exact path/body/key replay with its original UI result', async () => {
    const h = server(kind); mount(); await clickAction(kind)
    await act(async () => { h.original.resolve(unauthorized()); await settle() })
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    expect(h.refreshes().map(c => c.body)).toEqual([{ refreshToken: A.refreshToken }])
    const [first, retry] = h.writes(); expect(first).toMatchObject(expectedWrite(kind)); expect(retry).toMatchObject(expectedWrite(kind))
    expect(retry!.raw).toBe(first!.raw); expect(retry!.headers.get('Idempotency-Key')).toBe(first!.headers.get('Idempotency-Key'))
    if (first!.method === 'POST') expect(first!.headers.get('Idempotency-Key')).toBeTruthy()
    expect(retry!.headers.get('authorization')).toBe(`Bearer ${renewed.accessToken}`)
    if (kind === 'cancel' || kind === 'external-delete') await waitFor(() => expect(screen.getByTestId('legacy-location').textContent).toBe('/wedding'))
    else if (kind === 'invite') await screen.findByText(invitation)
    else if (kind === 'unmark') await waitFor(() => expect(screen.queryByRole('button', { name: 'Нет, ещё ищем' })).toBeNull())
    else await screen.findByText('Новый внешний специалист')
  })
  it('does not release a held200 body into a changed wedding or perform its follow-up read/navigation', async () => {
    const h = server(kind), mounted = mount(); await clickAction(kind)
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c } }), { headers: { 'content-type': 'application/json' } })
    await act(async () => { h.original.resolve(response); await settle() })
    await waitFor(() => expect(response.bodyUsed).toBe(true))
    await boundary('wedding', mounted)
    const reads = h.slotReads().length, path = screen.getByTestId('legacy-location').textContent
    await act(async () => { stream.enqueue(new TextEncoder().encode(JSON.stringify(kind === 'invite' ? { url: invitation } : {}))); stream.close(); await settle() })
    expect(h.slotReads()).toHaveLength(reads); expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1)
    expect(screen.getByTestId('legacy-location').textContent).toBe(path); expect(screen.queryByText(invitation)).toBeNull()
  })
  it('a new slot after an uncertain result cannot inherit the old command path/key', async () => {
    const h = server(kind); mount(); await clickAction(kind)
    await act(async () => { h.original.reject(new TypeError('Synthetic response loss')); await settle() })
    const first = h.writes()[0]!
    fireEvent.click(screen.getByRole('button', { name: 'Тест: другая позиция' }))
    await screen.findByText('Вторая позиция'); await clickAction(kind)
    await waitFor(() => expect(h.writes()).toHaveLength(2))
    expect(h.writes()[1]).toMatchObject(expectedWrite(kind, S2))
    if (first.headers.get('Idempotency-Key')) expect(h.writes()[1]!.headers.get('Idempotency-Key')).not.toBe(first.headers.get('Idempotency-Key'))
  })
})
it.each<Action>(['cancel', 'external-delete'])('pending %s cannot follow a newly selected deal in the same slot', async kind => {
  const h = server(kind); mount(); await clickAction(kind)
  h.changeDeal(); fireEvent.click(screen.getByRole('button', { name: 'Тест: перечитать позиции' }))
  await screen.findByText('Новый выбранный исполнитель')
  await act(async () => { h.original.resolve(unauthorized()); await settle() })
  expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(1)
  expect(screen.getByTestId('legacy-location').textContent).toBe(`/wedding/slot/${S}`)
})
it('the mounted slot shortlist GET401 cannot refresh the newly selected actor', async () => {
  const h = server('cancel', true); mount()
  await waitFor(() => expect(h.calls.some(c => c.path === `/weddings/${W}/slots/${S}/shortlist`)).toBe(true))
  const response = unauthorized()
  await act(async () => { saveTokens(B); h.privateRead.resolve(response); await settle() })
  expect(h.refreshes()).toHaveLength(0); expect(h.writes()).toHaveLength(0)
  expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(B)
})
