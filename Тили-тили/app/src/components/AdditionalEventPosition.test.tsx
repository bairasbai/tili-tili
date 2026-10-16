// @vitest-environment jsdom
// Rendered UI and real API client; all identities and responses are synthetic.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTokens } from '@/lib/api/client'
import { StoreProvider, useStore } from '@/lib/store'
import { AdditionalEventPosition } from './AdditionalEventPosition'

const W = '10000000-0000-4000-8000-000000000001', W2 = '10000000-0000-4000-8000-000000000002'
const E = '20000000-0000-4000-8000-000000000001', S = '30000000-0000-4000-8000-000000000001'
const path = `/weddings/${W}/slots/additional`
const wedding = { id: W, title: 'Аня и Боря', date: '2027-06-14', members: [], role: 'couple' }
const events = [{ id: E, name: 'Ужин', kind: 'dinner', date: null, timeZone: null, location: null, isMain: false, rsvpDeadline: null }]
const body = { categoryId: 'photo', programEventId: E, label: 'Фотограф ужина' }
const dto = { id: S, ...body }
type Call = { method: string; path: string; body: unknown; raw: string | null; key: string | null; authorization: string | null }
type Reply = unknown | ((call: Call) => unknown | Promise<unknown>)
let unexpected: string[] = []
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function mount(overrides: Record<string, Reply> = {}) {
  const calls: Call[] = []
  const routes: Record<string, Reply> = {
    '/weddings': [wedding, { ...wedding, id: W2 }],
    [`/weddings/${W}`]: wedding, [`/weddings/${W2}`]: { ...wedding, id: W2 },
    [`/weddings/${W}/slots`]: [], [`/weddings/${W2}/slots`]: [], '/me/favorites': [],
    '/catalog/categories': [{ id: 'photo', title: 'Фотограф' }],
    [`/weddings/${W}/events`]: events, [`/weddings/${W2}/events`]: events,
    [`POST ${path}`]: () => json(dto, 201), ...overrides,
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
    const raw = init?.body == null ? null : String(init.body)
    const headers = new Headers(init?.headers)
    const call: Call = { method: init?.method ?? 'GET', path: pathname, raw, body: raw ? JSON.parse(raw) : null, key: headers.get('Idempotency-Key'), authorization: headers.get('authorization') }
    calls.push(call)
    const reply = routes[`${call.method} ${pathname}`] ?? (call.method === 'GET' ? routes[pathname] : undefined)
    if (reply === undefined) { unexpected.push(`${call.method} ${pathname}`); return json({ error: { code: 'unexpected', message: 'Unknown synthetic route' } }, 404) }
    const value = typeof reply === 'function' ? await reply(call) : reply
    return value instanceof Response ? value : json(value)
  }))
  render(<MemoryRouter initialEntries={['/wedding']}><StoreProvider><Controls /><Routes>
    <Route path="/wedding" element={<AdditionalEventPosition />} />
    <Route path="/wedding/slot/:id" element={<Destination />} />
  </Routes></StoreProvider></MemoryRouter>)
  return calls
}
function Controls() {
  const store = useStore()
  return <aside><button onClick={() => store.setWeddingId(W2)}>Другая свадьба</button><button onClick={() => saveTokens({ accessToken: 'new-person', refreshToken: 'new-refresh' })}>Другой аккаунт</button></aside>
}
function Destination() { const { id } = useParams(); return <p>Открыта позиция {id}</p> }
const posts = (calls: Call[]) => calls.filter(c => c.method === 'POST')
async function fill() {
  fireEvent.change(await screen.findByLabelText('Категория позиции'), { target: { value: 'photo' } })
  fireEvent.change(screen.getByLabelText('Мероприятие позиции'), { target: { value: E } })
  fireEvent.change(screen.getByLabelText('Название позиции'), { target: { value: `  ${body.label}  ` } })
}
beforeEach(() => {
  unexpected = []; localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('tt_wedding_id', JSON.stringify(W))
  saveTokens({ accessToken: 'synthetic-person', refreshToken: 'synthetic-refresh' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); expect(unexpected).toEqual([]) })

describe('additional event position', () => {
  it('requires explicit choices and a bounded name, then opens the exact server slot after refreshing', async () => {
    const calls = mount()
    const create = await screen.findByRole('button', { name: 'Создать позицию' })
    expect((create as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Название позиции'), { target: { value: 'x'.repeat(201) } })
    fireEvent.change(screen.getByLabelText('Категория позиции'), { target: { value: 'photo' } })
    fireEvent.change(screen.getByLabelText('Мероприятие позиции'), { target: { value: E } })
    expect((create as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Название позиции') as HTMLInputElement).maxLength).toBe(200)
    await fill(); fireEvent.click(create)
    expect(await screen.findByText(`Открыта позиция ${S}`)).toBeTruthy()
    expect(posts(calls)).toHaveLength(1)
    expect(posts(calls)[0]).toMatchObject({ path, body })
    expect(posts(calls)[0]?.key).toBeTruthy()
    expect(calls.filter(c => c.path === `/weddings/${W}/slots`)).toHaveLength(2)
  })
  it('a lost response only permits a manual retry with the identical key and raw body', async () => {
    let attempt = 0
    const calls = mount({ [`POST ${path}`]: () => { if (++attempt === 1) throw new TypeError('synthetic lost response'); return json(dto, 201) } })
    await fill(); fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    const retry = await screen.findByRole('button', { name: 'Повторить тот же запрос' })
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    expect(posts(calls)).toHaveLength(1)
    expect((screen.getByLabelText('Название позиции') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(retry)
    await screen.findByText(`Открыта позиция ${S}`)
    expect(posts(calls)).toHaveLength(2)
    expect(posts(calls)[1]?.raw).toBe(posts(calls)[0]?.raw)
    expect(posts(calls)[1]?.key).toBe(posts(calls)[0]?.key)
  })
  it('a definite refusal allows editing and creates a new key', async () => {
    let attempt = 0
    const calls = mount({ [`POST ${path}`]: (call: Call) => ++attempt === 1 ? json({ error: { code: 'validation', message: 'Проверьте название' } }, 422) : json({ id: S, ...(call.body as object) }, 201) })
    await fill(); fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    await screen.findByText('Проверьте название')
    expect(screen.queryByRole('button', { name: 'Повторить тот же запрос' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Название позиции'), { target: { value: 'Фотограф церемонии' } })
    fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    await screen.findByText(`Открыта позиция ${S}`)
    expect(posts(calls)).toHaveLength(2)
    expect(posts(calls)[1]?.key).not.toBe(posts(calls)[0]?.key)
    expect(posts(calls)[1]?.body).toEqual({ ...body, label: 'Фотограф церемонии' })
  })
  it.each(['helper', 'coordinator', 'vendor'])('does not grant the %s role a creation form', async role => {
    const calls = mount({ '/weddings': [{ ...wedding, role }] })
    await screen.findByText('Добавлять позиции мероприятия может только пара')
    expect(screen.queryByRole('button', { name: 'Создать позицию' })).toBeNull()
    expect(posts(calls)).toEqual([])
  })
  it('a signed-out remembered wedding does not grant a creation form or a write', async () => {
    saveTokens(null)
    const calls = mount()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: 'Создать позицию' })).toBeNull()
    expect(posts(calls)).toEqual([])
  })
  it('a removed event invalidates a previously filled form before any write', async () => {
    let removed = false
    const calls = mount({ [`/weddings/${W}/events`]: () => removed ? [] : events })
    await fill(); removed = true; fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    await screen.findByText('Категории или мероприятия изменились. Обновите форму.')
    expect(posts(calls)).toEqual([])
    expect((screen.getByRole('button', { name: 'Создать позицию' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('does not grant access before fresh reads or after their failure; refresh can recover', async () => {
    const held = deferred<unknown>(); let categories = 0
    const calls = mount({ '/catalog/categories': () => ++categories === 1 ? held.promise : [{ id: 'photo', title: 'Фотограф' }] })
    expect(screen.queryByRole('button', { name: 'Создать позицию' })).toBeNull()
    await act(async () => held.resolve(json({ error: { code: 'down', message: 'Unavailable' } }, 503)))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Создать позицию' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Обновить форму' }))
    await fill(); expect(posts(calls)).toEqual([])
  })
  it('rejects a revoked couple role immediately before the write', async () => {
    let revoked = false
    const calls = mount({ '/weddings': () => [{ ...wedding, role: revoked ? 'helper' : 'couple' }] })
    await fill(); revoked = true; fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    await screen.findByRole('alert')
    expect(posts(calls)).toEqual([])
    expect(screen.queryByRole('button', { name: 'Создать позицию' })).toBeNull()
  })
  it.each(['Другая свадьба', 'Другой аккаунт'])('an old successful response cannot navigate after %s', async control => {
    const held = deferred<Response>()
    const calls = mount({ [`POST ${path}`]: () => held.promise })
    await fill(); fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: control }))
    await act(async () => held.resolve(json(dto, 201)))
    await screen.findByRole('button', { name: 'Создать позицию' })
    expect(screen.queryByText(`Открыта позиция ${S}`)).toBeNull()
    expect(posts(calls)).toHaveLength(1)
  })
  it.each(['Другая свадьба', 'Другой аккаунт'])('a held original create 401 after %s cannot refresh or retry with the current tokens', async control => {
    const held = deferred<Response>()
    const calls = mount({ [`POST ${path}`]: () => held.promise, 'POST /auth/refresh': { accessToken: 'new-person-rotated', refreshToken: 'new-refresh-rotated' } })
    await fill(); fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    await waitFor(() => expect(calls.filter(c => c.method === 'POST' && c.path === path)).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: control }))
    const currentTokens = localStorage.getItem('tt_auth')
    const unauthorized = json({ error: { code: 'unauthorized', message: 'Expired synthetic access' } }, 401)
    await act(async () => held.resolve(unauthorized))
    await waitFor(() => expect(unauthorized.bodyUsed).toBe(true))
    expect(calls.filter(c => c.path === '/auth/refresh')).toEqual([])
    expect(calls.filter(c => c.method === 'POST' && c.path === path)).toHaveLength(1)
    expect(localStorage.getItem('tt_auth')).toBe(currentTokens)
    expect(screen.queryByText(`Открыта позиция ${S}`)).toBeNull()
  })
  it.each(['Другая свадьба', 'Другой аккаунт'])('a held category-read 401 after %s cannot consume the new context refresh', async control => {
    const held = deferred<Response>(); let reads = 0
    const calls = mount({ '/catalog/categories': () => ++reads === 1 ? held.promise : [{ id: 'photo', title: 'Фотограф' }], 'POST /auth/refresh': { accessToken: 'new-person-rotated', refreshToken: 'new-refresh-rotated' } })
    await waitFor(() => expect(reads).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: control }))
    const currentTokens = localStorage.getItem('tt_auth')
    const unauthorized = json({ error: { code: 'unauthorized', message: 'Expired synthetic access' } }, 401)
    await act(async () => held.resolve(unauthorized))
    await waitFor(() => expect(unauthorized.bodyUsed).toBe(true))
    await screen.findByRole('button', { name: 'Создать позицию' })
    expect(calls.filter(c => c.path === '/auth/refresh')).toEqual([])
    expect(localStorage.getItem('tt_auth')).toBe(currentTokens)
    expect(posts(calls)).toEqual([])
  })
  it('a current same-principal 401 still refreshes and retries the identical create exactly once', async () => {
    // Decoded sub/sid are local fences only; the HTTP fixture grants permission.
    const token = (serial: number) => `header.${btoa(JSON.stringify({ sub: 'synthetic-couple', sid: 'same-synthetic-session', serial }))}.signature`
    saveTokens({ accessToken: token(0), refreshToken: 'refresh-same-0' })
    let attempts = 0
    const calls = mount({ [`POST ${path}`]: () => ++attempts === 1 ? json({ error: { code: 'unauthorized', message: 'Expired synthetic access' } }, 401) : json(dto, 201), 'POST /auth/refresh': { accessToken: token(1), refreshToken: 'refresh-same-1' } })
    await fill(); fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    await screen.findByText(`Открыта позиция ${S}`)
    const creates = calls.filter(c => c.method === 'POST' && c.path === path)
    expect(creates).toHaveLength(2)
    expect(creates[1]?.key).toBe(creates[0]?.key)
    expect(creates[1]?.raw).toBe(creates[0]?.raw)
    expect(creates.map(c => c.authorization)).toEqual([`Bearer ${token(0)}`, `Bearer ${token(1)}`])
    expect(calls.filter(c => c.path === '/auth/refresh').map(c => c.body)).toEqual([{ refreshToken: 'refresh-same-0' }])
  })
  it('after confirmed creation but a failed access read, reopening never creates a second slot', async () => {
    let created = false, deny = false
    const calls = mount({ '/weddings': () => deny ? json({ error: { code: 'forbidden', message: 'Доступ изменился' } }, 403) : [wedding], [`POST ${path}`]: () => { created = true; deny = true; return json(dto, 201) } })
    await fill(); fireEvent.click(screen.getByRole('button', { name: 'Создать позицию' }))
    const retry = await screen.findByRole('button', { name: 'Обновить доступ и открыть позицию' })
    expect(created).toBe(true); expect(posts(calls)).toHaveLength(1)
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false))
    deny = false; fireEvent.click(retry)
    await screen.findByText(`Открыта позиция ${S}`)
    expect(posts(calls)).toHaveLength(1)
  })
})
