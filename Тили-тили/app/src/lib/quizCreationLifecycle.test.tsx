// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Quiz from '@/pages/Quiz'
import { StoreProvider, useStore } from './store'
import { saveTokens } from './api/client'
import { setI18nLang, t } from './i18n'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tokens = (sub = 'person-a', sid = 'session-a', revision = 'one') => ({
  accessToken: `head.${btoa(JSON.stringify({ sub, sid }))}.${revision}`,
  refreshToken: `refresh-${sub}-${sid}-${revision}`,
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
type Call = { method: string; path: string; authorization: string | null; online: boolean; body: unknown }
let online = true
let calls: Call[] = []
let patches: ReturnType<typeof deferred<Response>>[] = []
let posts: ReturnType<typeof deferred<Response>>[] = []
let lists: ReturnType<typeof deferred<Response>>[] = []
let refreshes: ReturnType<typeof deferred<Response>>[] = []
let deferPost = false
let deferList = false

beforeEach(() => {
  localStorage.clear(); setI18nLang('ru')
  online = true; calls = []; patches = []; posts = []; lists = []; refreshes = []
  deferPost = false; deferList = false
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    const method = init?.method ?? 'GET'
    const authorization = new Headers(init?.headers).get('authorization')
    calls.push({ method, path, authorization, online, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === '/users/me' && method === 'PATCH') {
      const response = deferred<Response>(); patches.push(response); return response.promise
    }
    if (path === '/users/me' && method === 'GET') return Promise.resolve(json({
      id: authorization === `Bearer ${tokens('person-b', 'session-b').accessToken}` ? 'person-b' : 'person-a',
      name: 'Profile name',
    }))
    if (path === '/auth/refresh') {
      const response = deferred<Response>(); refreshes.push(response); return response.promise
    }
    if (path === '/weddings' && method === 'POST') {
      if (deferPost) { const response = deferred<Response>(); posts.push(response); return response.promise }
      return Promise.resolve(json({ id: 'old-attempt-wedding' }, 201))
    }
    if (path === '/weddings' && method === 'GET' && deferList) {
      const response = deferred<Response>(); lists.push(response); return response.promise
    }
    if (path === '/weddings' || path === '/me/favorites' || path.endsWith('/slots')) return Promise.resolve(json([]))
    if (path.startsWith('/weddings/')) return Promise.resolve(json({ date: null, members: [] }))
    throw new Error(`Unexpected fixture request ${method} ${path}`)
  }))
  saveTokens(tokens())
})
afterEach(() => {
  cleanup(); saveTokens(null); vi.unstubAllGlobals(); vi.restoreAllMocks()
  localStorage.clear(); setI18nLang('ru')
})

function Witness() {
  const { weddingId, weddingDate, quiz, onboarded } = useStore()
  const location = useLocation(), nav = useNavigate()
  return <><output data-testid="creation-store">{JSON.stringify({ weddingId, weddingDate, quiz, onboarded, path: location.pathname })}</output>
    <button onClick={() => nav('/away')}>Leave Quiz fixture</button></>
}
const state = () => JSON.parse(screen.getByTestId('creation-store').textContent!)
const own = () => screen.getByRole('textbox', { name: t('Ваше имя') }) as HTMLInputElement
const partner = () => screen.getByRole('textbox', { name: t('Имя партнёра') }) as HTMLInputElement
const create = () => screen.getByRole('button', { name: t('Создать мою свадьбу ✨') }) as HTMLButtonElement
const postCalls = () => calls.filter(call => call.method === 'POST' && call.path === '/weddings')
async function mount(strict = false) {
  const content = <MemoryRouter initialEntries={['/quiz']}><StoreProvider><Witness /><Routes>
    <Route path="/quiz" element={<Quiz />} /><Route path="/home" element={<p>Creation home fixture</p>} />
    <Route path="/away" element={<p>Away fixture</p>} />
  </Routes></StoreProvider></MemoryRouter>
  const view = render(strict ? <StrictMode>{content}</StrictMode> : content)
  await act(async () => { await Promise.resolve() })
  return view
}
function names() {
  fireEvent.click(screen.getByRole('button', { name: t('Пропустить вопрос') }))
  fireEvent.click(screen.getByRole('button', { name: t('Пропустить вопрос') }))
  fireEvent.click(screen.getByText('60–100')); fireEvent.click(screen.getByRole('button', { name: t('Далее') }))
  for (let step = 3; step < 8; step++) fireEvent.click(screen.getByRole('button', { name: t('Пропустить вопрос') }))
  fireEvent.change(own(), { target: { value: 'Edited A' } })
  fireEvent.change(partner(), { target: { value: 'Partner A' } })
}
async function startPatch() {
  fireEvent.click(create()); await waitFor(() => expect(patches).toHaveLength(1))
  expect(calls.find(call => call.method === 'PATCH')).toMatchObject({
    path: '/users/me', authorization: `Bearer ${tokens().accessToken}`, body: { name: own().value }, online: true,
  })
}
async function patchReply(body: unknown = { id: 'person-a', name: 'Edited A' }, status = 200) {
  expect(patches[0], 'An actual PATCH must exist before settling its Response').toBeTruthy()
  await act(async () => { patches[0]!.resolve(json(body, status)); await patches[0]!.promise })
}
async function settle(response: ReturnType<typeof deferred<Response>>, body: unknown, status = 200) {
  expect(response, 'An actual request must exist before settling its Response').toBeTruthy()
  await act(async () => { response.resolve(json(body, status)); await response.promise })
}
async function network(value: boolean) {
  await act(async () => { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); await Promise.resolve() })
}
const boundaries = ['logout', 'subject', 'SID', 'queued ABA', 'unmount', 'offline', 'offline then online'] as const
type Boundary = typeof boundaries[number]
async function boundary(kind: Boundary) {
  if (kind === 'offline' || kind === 'offline then online') {
    await network(false)
    if (kind === 'offline then online') await network(true)
    return
  }
  await act(async () => {
    if (kind === 'unmount') fireEvent.click(screen.getByRole('button', { name: 'Leave Quiz fixture' }))
    else if (kind === 'logout') saveTokens(null)
    else if (kind === 'subject') saveTokens(tokens('person-b', 'session-b'))
    else if (kind === 'SID') saveTokens(tokens('person-a', 'session-b'))
    else {
      const a = JSON.stringify(tokens()), b = JSON.stringify(tokens('person-b', 'session-b'))
      localStorage.setItem('tt_auth', a)
      for (const [oldValue, newValue] of [[a, b], [b, a]]) {
        const event = new Event('storage')
        Object.assign(event, { key: 'tt_auth', oldValue, newValue, storageArea: localStorage })
        window.dispatchEvent(event)
      }
    }
    await Promise.resolve()
  })
}
async function startPost() {
  deferPost = true
  await mount(); names(); await startPatch(); await patchReply()
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(postCalls()[0]).toMatchObject({ authorization: `Bearer ${tokens().accessToken}`, online: true,
    body: { partnerName: 'Partner A', guestsPlanned: 60, quizAnswers: { guests: '60–100', date: null } } })
}
function untouched(current: ReturnType<typeof state>, auth: string | null) {
  expect(state()).toEqual(current)
  expect(localStorage.getItem('tt_auth')).toBe(auth)
  expect(localStorage.getItem('tt_onboarded')).not.toBe('1')
  expect(screen.queryByText('Creation home fixture')).toBeNull()
}
const refusal = (code = 'refused', message = 'Current creation refused', details?: unknown) => ({ error: { code, message, ...(details ? { details } : {}) } })

describe('Quiz creation action lifecycle', () => {
  it('a successful pending A PATCH after switching to B cannot POST or write B Store/navigation', async () => {
    await mount(); names(); await startPatch()
    await act(async () => { saveTokens(tokens('person-b', 'session-b')); await Promise.resolve() })
    const current = state(), auth = localStorage.getItem('tt_auth')
    await patchReply()
    expect(postCalls(), `Forbidden POST bearer/body witness: ${JSON.stringify(postCalls())}`).toHaveLength(0)
    expect(state()).toEqual(current)
    expect(localStorage.getItem('tt_auth')).toBe(auth)
    expect(localStorage.getItem('tt_onboarded')).not.toBe('1')
    expect(screen.queryByText('Creation home fixture')).toBeNull()
  })
  it.each(boundaries)('pending PATCH after %s cannot send the next POST or apply onboarding', async kind => {
    await mount(); names(); await startPatch(); await boundary(kind)
    const current = state(), auth = localStorage.getItem('tt_auth')
    await patchReply()
    expect(postCalls()).toHaveLength(0)
    if (kind === 'offline' || kind === 'offline then online') {
      expect(state()).toMatchObject({ weddingId: null, onboarded: false, path: '/quiz', quiz: { guests: '60–100' } })
      expect(own().value).toBe('Edited A'); expect(partner().value).toBe('Partner A')
      expect(screen.queryByText(t('Создаём…'))).toBeNull()
      expect(create().disabled).toBe(kind === 'offline')
    } else untouched(current, auth)
  })
  it.each(boundaries)('already dispatched POST success after %s never applies its late result', async kind => {
    await startPost(); await boundary(kind)
    const current = state(), auth = localStorage.getItem('tt_auth')
    await settle(posts[0]!, { id: 'late-created' }, 201)
    expect(postCalls()).toHaveLength(1)
    if (kind === 'offline' || kind === 'offline then online') {
      expect(state()).toMatchObject({ weddingId: null, onboarded: false, path: '/quiz', quiz: { guests: '60–100' } })
      expect(own().value).toBe('Edited A'); expect(partner().value).toBe('Partner A')
      expect(screen.queryByText(t('Создаём…'))).toBeNull()
    } else untouched(current, auth)
  })
  it.each(['subject', 'unmount'] as const)('late POST error after %s cannot save the old draft or error', async kind => {
    await startPost(); await boundary(kind)
    const current = state(), auth = localStorage.getItem('tt_auth')
    await settle(posts[0]!, refusal('refused', 'Obsolete error'), 422)
    untouched(current, auth); expect(screen.queryByText('Obsolete error')).toBeNull()
  })
  it('offline creation is disabled while the draft questions remain usable', async () => {
    online = false; await mount()
    names(); expect(create().disabled).toBe(true)
    fireEvent.change(own(), { target: { value: 'Offline edit' } })
    fireEvent.click(create()); expect(calls).toHaveLength(0)
    await network(true); expect(create().disabled).toBe(false); expect(own().value).toBe('Offline edit')
    await startPatch(); await patchReply()
    await waitFor(() => expect(state().path).toBe('/home'))
  })
  it('live offline connectivity blocks the handler before the offline render/event', async () => {
    await mount(); names(); expect(create().disabled).toBe(false)
    const before = calls.length
    online = false; fireEvent.click(create())
    expect(calls).toHaveLength(before); expect(patches).toHaveLength(0); expect(state().onboarded).toBe(false)
    expect(own().value).toBe('Edited A')
  })
  it.each(['PATCH', 'POST'] as const)('late %s 401 after disconnect or unmount sends no refresh/retry', async method => {
    if (method === 'PATCH') { await mount(); names(); await startPatch(); await network(false) }
    else { await startPost(); await boundary('unmount') }
    await settle(method === 'PATCH' ? patches[0]! : posts[0]!, refusal('unauthorized'), 401)
    expect(refreshes).toHaveLength(0)
    expect(patches).toHaveLength(1); expect(postCalls()).toHaveLength(method === 'POST' ? 1 : 0)
    expect(state().onboarded).toBe(false)
  })
  it.each(['PATCH', 'POST'] as const)('late %s 401 after subject change cannot refresh the new principal', async method => {
    if (method === 'PATCH') { await mount(); names(); await startPatch() } else await startPost()
    await boundary('subject'); const current = state(), auth = localStorage.getItem('tt_auth')
    await settle(method === 'PATCH' ? patches[0]! : posts[0]!, refusal('unauthorized'), 401)
    expect(refreshes).toHaveLength(0); untouched(current, auth)
  })
  it.each(['PATCH', 'POST'] as const)('in-flight %s refresh cannot retry across observed offline then reconnect', async method => {
    if (method === 'PATCH') { await mount(); names(); await startPatch() } else await startPost()
    await settle(method === 'PATCH' ? patches[0]! : posts[0]!, refusal('unauthorized'), 401)
    await waitFor(() => expect(refreshes).toHaveLength(1))
    await boundary('offline then online')
    await settle(refreshes[0]!, tokens('person-a', 'session-a', 'refreshed'))
    expect(patches).toHaveLength(1); expect(postCalls()).toHaveLength(method === 'POST' ? 1 : 0)
    expect(state()).toMatchObject({ weddingId: null, onboarded: false, path: '/quiz', quiz: { guests: '60–100' } })
    expect(create().disabled).toBe(false)
  })
  it.each(['PATCH', 'POST'] as const)('in-flight %s refresh cannot retry or replace B credentials', async method => {
    if (method === 'PATCH') { await mount(); names(); await startPatch() } else await startPost()
    await settle(method === 'PATCH' ? patches[0]! : posts[0]!, refusal('unauthorized'), 401)
    await waitFor(() => expect(refreshes).toHaveLength(1))
    await boundary('subject'); const current = state(), auth = localStorage.getItem('tt_auth')
    await settle(refreshes[0]!, tokens('person-a', 'session-a', 'refreshed'))
    expect(patches).toHaveLength(1); expect(postCalls()).toHaveLength(method === 'POST' ? 1 : 0)
    untouched(current, auth)
  })
  // NEW regression v2: real client lifecycle with manufactured deferred fetch Responses.
  it('same SID successful POST refresh retries the original body once and adopts only the accepted wedding', async () => {
    await startPost()
    const originalBody = postCalls()[0]!.body
    await settle(posts[0]!, refusal('unauthorized'), 401)
    await waitFor(() => expect(refreshes).toHaveLength(1))
    expect(patches).toHaveLength(1); expect(postCalls()).toHaveLength(1)
    expect(state()).toMatchObject({ weddingId: null, onboarded: false, path: '/quiz' })
    expect(calls.find(call => call.path === '/auth/refresh')).toMatchObject({
      method: 'POST', authorization: null, body: { refreshToken: tokens().refreshToken }, online: true,
    })
    const renewed = tokens('person-a', 'session-a', 'post-refreshed')
    await settle(refreshes[0]!, renewed)
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(patches).toHaveLength(1); expect(refreshes).toHaveLength(1)
    expect(postCalls().map(call => call.body)).toEqual([originalBody, originalBody])
    expect(postCalls().map(call => call.authorization)).toEqual([
      'Bearer ' + tokens().accessToken, 'Bearer ' + renewed.accessToken,
    ])
    expect(calls.filter(call => call.method === 'PATCH' || call.method === 'POST')
      .map(call => call.method + ' ' + call.path)).toEqual([
      'PATCH /users/me', 'POST /weddings', 'POST /auth/refresh', 'POST /weddings',
    ])
    expect(state()).toMatchObject({ weddingId: null, onboarded: false, path: '/quiz' })
    await settle(posts[1]!, { id: 'same-sid-retried-wedding' }, 201)
    await waitFor(() => expect(state().path).toBe('/home'))
    expect(state()).toMatchObject({ weddingId: 'same-sid-retried-wedding', onboarded: true, quiz: { guests: '60–100' } })
    expect(postCalls()).toHaveLength(2); expect(patches).toHaveLength(1); expect(refreshes).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(renewed)
    expect(JSON.parse(localStorage.getItem('tt_wedding_id')!)).toBe('same-sid-retried-wedding')
    expect(localStorage.getItem('tt_onboarded')).toBe('1')
    expect(screen.getByText('Creation home fixture')).toBeTruthy()
  })
  it('current malformed 201 without a wedding ID retains the draft and names without onboarding or navigation', async () => {
    await startPost()
    const enteredOwn = own().value, enteredPartner = partner().value
    await settle(posts[0]!, {}, 201)
    await waitFor(() => expect(create().disabled).toBe(false))
    expect(state()).toMatchObject({ weddingId: null, weddingDate: null, onboarded: false, path: '/quiz', quiz: { guests: '60–100', date: null } })
    expect(own().value).toBe(enteredOwn); expect(partner().value).toBe(enteredPartner)
    expect(JSON.parse(localStorage.getItem('tt_quiz')!)).toMatchObject({ guests: '60–100', date: null })
    expect(JSON.parse(localStorage.getItem('tt_wedding_id') ?? 'null')).toBeNull()
    expect(localStorage.getItem('tt_onboarded')).not.toBe('1')
    expect(screen.queryByText(t('Создаём…'))).toBeNull()
    expect(screen.queryByText('Creation home fixture')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(t('Что-то пошло не так'))
    expect(postCalls()).toHaveLength(1); expect(patches).toHaveLength(1)
    expect(refreshes).toHaveLength(0); expect(lists).toHaveLength(0)
  })
  // END NEW regression v2.
  it('same SID token renewal permits the pending PATCH and POST with the current bearer', async () => {
    await mount(true); names(); await startPatch()
    await act(async () => { saveTokens(tokens('person-a', 'session-a', 'renewed')); await Promise.resolve() })
    await patchReply(); await waitFor(() => expect(state().path).toBe('/home'))
    expect(postCalls()).toHaveLength(1)
    expect(postCalls()[0]!.authorization).toBe(`Bearer ${tokens('person-a', 'session-a', 'renewed').accessToken}`)
    expect(state()).toMatchObject({ weddingId: 'old-attempt-wedding', onboarded: true, quiz: { guests: '60–100' } })
  })
  it('same SID successful refresh retries PATCH before the one POST', async () => {
    await mount(); names(); await startPatch(); await patchReply(refusal('unauthorized'), 401)
    await waitFor(() => expect(refreshes).toHaveLength(1))
    await settle(refreshes[0]!, tokens('person-a', 'session-a', 'refreshed'))
    await waitFor(() => expect(patches).toHaveLength(2))
    await settle(patches[1]!, { id: 'person-a', name: 'Edited A' })
    await waitFor(() => expect(state().path).toBe('/home'))
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.authorization)).toEqual([
      `Bearer ${tokens().accessToken}`, `Bearer ${tokens('person-a', 'session-a', 'refreshed').accessToken}`,
    ])
    expect(postCalls()).toHaveLength(1)
  })
  it.each(['subject', 'queued ABA', 'unmount', 'offline then online'] as const)('409 recovery GET after %s cannot adopt or navigate', async kind => {
    await startPost(); deferList = true
    await settle(posts[0]!, refusal('wedding_exists', 'Exists', { weddingId: 'current-existing' }), 409)
    await waitFor(() => expect(lists).toHaveLength(1))
    expect(state().weddingId).toBeNull(); expect(state().onboarded).toBe(false)
    await boundary(kind); const current = state(), auth = localStorage.getItem('tt_auth')
    await settle(lists[0]!, [{ id: 'current-existing', role: 'couple', date: '2030-05-06' }])
    if (kind === 'offline then online') {
      expect(state()).toMatchObject({ weddingId: null, onboarded: false, path: '/quiz', quiz: { guests: '60–100' } })
      expect(create().disabled).toBe(false)
    } else untouched(current, auth)
    expect(postCalls()).toHaveLength(1)
  })
  it.each([200, 503])('explicit current owner retry recovers the dispatched wedding through 409, list status %i', async listStatus => {
    await startPost(); await network(false); await settle(posts[0]!, { id: 'already-created-on-server' }, 201)
    expect(state().weddingId).toBeNull(); await network(true)
    expect(postCalls()).toHaveLength(1); expect(own().value).toBe('Edited A')
    deferList = true
    fireEvent.click(create()); await waitFor(() => expect(patches).toHaveLength(2))
    await settle(patches[1]!, { id: 'person-a', name: 'Edited A' })
    await waitFor(() => expect(posts).toHaveLength(2))
    await settle(posts[1]!, refusal('wedding_exists', 'Exists', { weddingId: 'already-created-on-server' }), 409)
    await waitFor(() => expect(lists).toHaveLength(1))
    await settle(lists[0]!, listStatus === 200 ? [{ id: 'already-created-on-server', role: 'couple', date: '2030-05-06' }] : refusal(), listStatus)
    await waitFor(() => expect(state().path).toBe('/home'))
    expect(state()).toMatchObject({ weddingId: 'already-created-on-server', onboarded: true })
    expect(postCalls()).toHaveLength(2)
  })
  it('409 without a current wedding ID stays on Quiz with the current draft/error', async () => {
    await startPost(); await settle(posts[0]!, refusal('wedding_exists', 'No current wedding ID'), 409)
    expect(state()).toMatchObject({ weddingId: null, onboarded: false, path: '/quiz', quiz: { guests: '60–100' } })
    expect(screen.getByText('No current wedding ID')).toBeTruthy(); expect(create().disabled).toBe(false)
  })
  it('unchanged profile name omits PATCH and creates exactly once', async () => {
    await mount(); names(); fireEvent.change(own(), { target: { value: 'Profile name' } })
    fireEvent.click(create()); await waitFor(() => expect(state().path).toBe('/home'))
    expect(patches).toHaveLength(0); expect(postCalls()).toHaveLength(1)
    expect(state().quiz.guests).toBe('60–100')
  })
  it('a current PATCH refusal stops POST and retains the draft and retryable error', async () => {
    await mount(); names(); await startPatch(); await patchReply(refusal(), 422)
    expect(postCalls()).toHaveLength(0); expect(create().disabled).toBe(false)
    expect(state()).toMatchObject({ weddingId: null, onboarded: false, quiz: { guests: '60–100' } })
    expect(screen.getByText('Current creation refused')).toBeTruthy(); expect(own().value).toBe('Edited A')
  })
  it('a current POST refusal retains the draft without onboarding and allows an explicit retry', async () => {
    await startPost(); await settle(posts[0]!, refusal(), 422)
    expect(create().disabled).toBe(false); expect(state().onboarded).toBe(false)
    expect(state().quiz.guests).toBe('60–100'); expect(partner().value).toBe('Partner A')
    expect(screen.getByText('Current creation refused')).toBeTruthy()
  })
})
