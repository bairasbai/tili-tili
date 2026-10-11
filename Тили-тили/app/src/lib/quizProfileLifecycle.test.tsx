// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Quiz from '@/pages/Quiz'
import { StoreProvider } from './store'
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
type Call = { method: string; path: string; authorization: string | null; online: boolean }
let online = true
let calls: Call[] = []
let pending: ReturnType<typeof deferred<Response>>[] = []
let deferRefresh = false
let pendingRefresh: ReturnType<typeof deferred<Response>>[] = []

beforeEach(() => {
  localStorage.clear()
  online = true; calls = []; pending = []; deferRefresh = false; pendingRefresh = []
  setI18nLang('ru')
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    const method = init?.method ?? 'GET'
    calls.push({ method, path, authorization: new Headers(init?.headers).get('authorization'), online })
    if (path === '/users/me' && method === 'GET') {
      const response = deferred<Response>(); pending.push(response); return response.promise
    }
    if (path === '/auth/refresh') {
      if (deferRefresh) {
        const response = deferred<Response>(); pendingRefresh.push(response); return response.promise
      }
      return Promise.resolve(json({ error: { code: 'unauthorized', message: 'Session expired' } }, 401))
    }
    return Promise.resolve(json([]))
  }))
  saveTokens(tokens())
})
afterEach(() => {
  cleanup(); saveTokens(null); vi.unstubAllGlobals(); vi.restoreAllMocks()
  localStorage.clear(); setI18nLang('ru')
})
const reads = () => calls.filter(c => c.path === '/users/me' && c.method === 'GET')
const own = () => screen.getByRole('textbox', { name: t('Ваше имя') }) as HTMLInputElement
const partner = () => screen.getByRole('textbox', { name: t('Имя партнёра') }) as HTMLInputElement
const create = () => screen.getByRole('button', { name: t('Создать мою свадьбу ✨') }) as HTMLButtonElement
async function mount() {
  const result = render(<MemoryRouter initialEntries={['/quiz']}><StoreProvider><Quiz /></StoreProvider></MemoryRouter>)
  await act(async () => { await Promise.resolve() })
  return result
}
function names() {
  for (let step = 0; step < 8; step++) fireEvent.click(screen.getByRole('button', { name: t('Пропустить вопрос') }))
  expect(own()).toBeTruthy()
}
async function network(value: boolean) {
  await act(async () => { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); await Promise.resolve() })
}
async function reply(index: number, name: string, status = 200) {
  expect(pending[index], 'An actual deferred GET must exist before resolving it').toBeTruthy()
  await act(async () => {
    pending[index]!.resolve(json(status === 200 ? { id: 'profile', name } : { error: { code: 'refused', message: 'Profile refused' } }, status))
    await pending[index]!.promise
  })
}
async function refreshReply() {
  expect(pendingRefresh[0], 'An actual deferred refresh must exist before resolving it').toBeTruthy()
  await act(async () => {
    pendingRefresh[0]!.resolve(json(tokens('person-a', 'session-a', 'refreshed')))
    await pendingRefresh[0]!.promise
  })
}
async function changeIdentity(sub: string, sid: string) {
  await act(async () => { saveTokens(tokens(sub, sid)); await Promise.resolve() })
}
async function queuedABA() {
  const a = JSON.stringify(tokens()), b = JSON.stringify(tokens('person-b', 'session-b'))
  // Cross-tab events can arrive after storage already contains A again.
  localStorage.setItem('tt_auth', a)
  await act(async () => {
    // The project setup can use MemoryStorage, which lacks jsdom's Storage brand.
    for (const [oldValue, newValue] of [[a, b], [b, a]]) {
      const event = new Event('storage')
      Object.assign(event, { key: 'tt_auth', oldValue, newValue, storageArea: localStorage })
      window.dispatchEvent(event)
    }
    await Promise.resolve()
  })
}

describe('Quiz profile read lifecycle', () => {
  it.each(['ru', 'en'] as const)('authorized cold offline %s sends no profile GET; reconnect prefills the name', async lang => {
    localStorage.setItem('tt_lang', lang); setI18nLang(lang); online = false
    await mount(); names()
    expect(reads()).toHaveLength(0)
    expect(own().value).toBe('')
    await network(true)
    await waitFor(() => expect(reads()).toHaveLength(1))
    await reply(0, '  Anna  ')
    await waitFor(() => expect(own().value).toBe('Anna'))
    expect(partner().value).toBe('')
  })
  it.each([false, true])('guest online=%s sends no profile GET', async connected => {
    saveTokens(null); online = connected
    await mount(); names()
    expect(reads()).toHaveLength(0); expect(own().value).toBe('')
    await network(!connected); await network(true)
    expect(reads()).toHaveLength(0)
  })
  it.each(['Typed', ''])('a delayed online profile never overwrites the own edit %j', async edit => {
    await mount(); names(); expect(reads()).toHaveLength(1)
    fireEvent.change(own(), { target: { value: 'Initial edit' } })
    fireEvent.change(own(), { target: { value: edit } })
    fireEvent.change(partner(), { target: { value: 'Partner' } })
    await reply(0, 'Server name')
    expect(own().value).toBe(edit); expect(create().disabled).toBe(edit === '')
  })
  it('disconnect rejects the delayed response and reconnect fetches the current name', async () => {
    await mount(); names(); await network(false)
    await reply(0, 'Stale offline response'); expect(own().value).toBe('')
    await network(true); await waitFor(() => expect(reads()).toHaveLength(2))
    await reply(1, 'Fresh reconnect'); await waitFor(() => expect(own().value).toBe('Fresh reconnect'))
  })
  it.each(['My edit', ''])('reconnect preserves the own edit %j while refreshing the profile', async edit => {
    await mount(); names(); await reply(0, 'First profile')
    fireEvent.change(own(), { target: { value: edit } })
    await network(false); await network(true)
    await waitFor(() => expect(reads()).toHaveLength(2)); await reply(1, 'Changed profile')
    expect(own().value).toBe(edit)
  })
  it('a confirmed profile stays in memory on disconnect; a disconnected refresh cannot replace it', async () => {
    await mount(); names(); await reply(0, 'Confirmed profile')
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!))
      .some(value => value?.includes('Confirmed profile')), 'The profile prefill must not become a persistent cache').toBe(false)
    await network(false); expect(own().value).toBe('Confirmed profile')
    await network(true); await waitFor(() => expect(reads()).toHaveLength(2))
    await network(false); await reply(1, 'Disconnected refresh')
    expect(own().value).toBe('Confirmed profile')
    await network(true); await waitFor(() => expect(reads()).toHaveLength(3))
    await reply(2, 'Current reconnect'); expect(own().value).toBe('Current reconnect')
  })
  it('queued disconnect/reconnect invalidates the original read even when React batches both events', async () => {
    await mount(); names()
    await act(async () => {
      online = false; window.dispatchEvent(new Event('offline'))
      online = true; window.dispatchEvent(new Event('online'))
      await Promise.resolve()
    })
    await waitFor(() => expect(reads()).toHaveLength(2))
    await reply(0, 'Old connected response'); expect(own().value).toBe('')
    await reply(1, 'Current connected response'); expect(own().value).toBe('Current connected response')
  })
  it('an unmounted read cannot populate the next Quiz instance', async () => {
    const first = await mount(); first.unmount()
    await mount(); names(); expect(reads()).toHaveLength(2)
    await reply(0, 'Unmounted name'); expect(own().value).toBe('')
    await reply(1, 'Current instance'); await waitFor(() => expect(own().value).toBe('Current instance'))
  })
  it.each([['person-b', 'session-a'], ['person-a', 'session-b']])('switch to sub=%s sid=%s clears old profile/edits and rejects its response', async (sub, sid) => {
    await mount(); names()
    fireEvent.change(own(), { target: { value: 'Private A edit' } })
    fireEvent.change(partner(), { target: { value: 'Private A partner' } })
    await changeIdentity(sub, sid)
    await waitFor(() => expect(reads()).toHaveLength(2)); names()
    expect(own().value).toBe(''); expect(partner().value).toBe('')
    await reply(0, 'Private A response'); expect(own().value).toBe('')
    await reply(1, 'B current'); await waitFor(() => expect(own().value).toBe('B current'))
    expect(reads()[1]!.authorization).toBe(`Bearer ${tokens(sub, sid).accessToken}`)
  })
  it('observed same-tab A→B→A invalidates the original read', async () => {
    await mount(); names()
    await act(async () => { saveTokens(tokens('person-b', 'session-b')); saveTokens(tokens()); await Promise.resolve() })
    await waitFor(() => expect(reads()).toHaveLength(2)); names()
    await reply(0, 'Old A'); expect(own().value).toBe('')
    await reply(1, 'New A'); await waitFor(() => expect(own().value).toBe('New A'))
  })
  it('queued cross-tab A→B→A clears already displayed private edits and starts a fresh read', async () => {
    await mount(); names(); await reply(0, 'Old profile A')
    fireEvent.change(own(), { target: { value: 'Old private edit' } })
    await queuedABA(); await waitFor(() => expect(reads()).toHaveLength(2)); names()
    expect(own().value).toBe('')
    await reply(1, 'New profile A'); await waitFor(() => expect(own().value).toBe('New profile A'))
  })
  it('queued cross-tab A→B→A rejects a delayed original response', async () => {
    await mount(); names(); await queuedABA()
    await waitFor(() => expect(reads()).toHaveLength(2)); names()
    await reply(0, 'Old queued A'); expect(own().value).toBe('')
    await reply(1, 'Fresh queued A'); await waitFor(() => expect(own().value).toBe('Fresh queued A'))
  })
  it('same-sub/SID access-token renewal preserves edits and the in-flight read', async () => {
    await mount(); names(); fireEvent.change(partner(), { target: { value: 'Kept partner' } })
    await act(async () => { saveTokens(tokens('person-a', 'session-a', 'renewed')); await Promise.resolve() })
    expect(reads()).toHaveLength(1); expect(partner().value).toBe('Kept partner')
    await reply(0, 'Renewal-safe name'); await waitFor(() => expect(own().value).toBe('Renewal-safe name'))
  })
  it('same-sub/SID renewal preserves a confirmed profile and an explicitly cleared field', async () => {
    await mount(); names(); await reply(0, 'Confirmed profile')
    await act(async () => { saveTokens(tokens('person-a', 'session-a', 'renewed')); await Promise.resolve() })
    expect(own().value).toBe('Confirmed profile'); expect(reads()).toHaveLength(1)
    fireEvent.change(own(), { target: { value: '' } })
    fireEvent.change(partner(), { target: { value: 'Kept partner' } })
    await act(async () => { saveTokens(tokens('person-a', 'session-a', 'renewed-again')); await Promise.resolve() })
    expect(own().value).toBe(''); expect(partner().value).toBe('Kept partner'); expect(reads()).toHaveLength(1)
  })
  it('logout clears a confirmed profile and private edits; logging in starts a fresh read', async () => {
    await mount(); names(); await reply(0, 'Private profile')
    fireEvent.change(own(), { target: { value: 'Private edit' } })
    fireEvent.change(partner(), { target: { value: 'Private partner' } })
    await act(async () => { saveTokens(null); await Promise.resolve() })
    names(); expect(own().value).toBe(''); expect(partner().value).toBe(''); expect(reads()).toHaveLength(1)
    await changeIdentity('person-b', 'session-b')
    await waitFor(() => expect(reads()).toHaveLength(2)); names()
    await reply(1, 'Current person'); expect(own().value).toBe('Current person')
  })
  it.each([403, 404, 410])('current refusal %s clears a previously confirmed profile', async status => {
    await mount(); names(); await reply(0, 'Previously confirmed')
    await network(false); await network(true)
    await waitFor(() => expect(reads()).toHaveLength(2)); await reply(1, '', status)
    expect(own().value).toBe('')
    await network(false); expect(own().value).toBe('')
  })
  it.each([403, 404, 410])('fresh refusal %s prevents an older success resurrecting a profile', async status => {
    await mount(); names(); await network(false); await network(true)
    await waitFor(() => expect(reads()).toHaveLength(2)); await reply(1, '', status)
    await reply(0, 'Old success after denial'); expect(own().value).toBe('')
  })
  it('401 plus refused refresh clears the session and prevents late private data', async () => {
    await mount(); names(); await reply(0, '', 401)
    await waitFor(() => expect(localStorage.getItem('tt_auth')).toBeNull())
    names(); expect(own().value).toBe(''); expect(reads()).toHaveLength(1)
  })
  it.each(['offline', 'unmount'] as const)('a delayed 401 after %s cannot start refresh or another profile GET', async boundary => {
    deferRefresh = true
    const view = await mount(); names()
    if (boundary === 'offline') await network(false)
    else view.unmount()
    await reply(0, '', 401)
    // Settle a wrongly started refresh before asserting, so RED leaves no pending shared refresh.
    if (pendingRefresh.length) await refreshReply()
    expect(calls.filter(call => call.path === '/auth/refresh')).toHaveLength(0)
    expect(reads()).toHaveLength(1)
    expect(reads().filter(call => !call.online)).toHaveLength(0)
  })
  it.each(['offline', 'unmount'] as const)('an already pending successful refresh after %s cannot retry the profile GET', async boundary => {
    deferRefresh = true
    const view = await mount(); names(); await reply(0, '', 401)
    await waitFor(() => expect(pendingRefresh).toHaveLength(1))
    if (boundary === 'offline') await network(false)
    else view.unmount()
    await refreshReply()
    expect(reads()).toHaveLength(1)
    expect(reads().filter(call => !call.online)).toHaveLength(0)
  })
  it.each(['sub', 'SID', 'ABA'] as const)('a delayed 401 after %s change cannot refresh the new principal or retry its profile', async boundary => {
    deferRefresh = true
    await mount(); names()
    if (boundary === 'sub') await changeIdentity('person-b', 'session-a')
    else if (boundary === 'SID') await changeIdentity('person-a', 'session-b')
    else await queuedABA()
    await waitFor(() => expect(reads()).toHaveLength(2)); names()
    await reply(0, '', 401)
    if (pendingRefresh.length) await refreshReply()
    expect(calls.filter(call => call.path === '/auth/refresh')).toHaveLength(0)
    expect(reads()).toHaveLength(2)
    await reply(1, 'Current principal profile'); expect(own().value).toBe('Current principal profile')
  })
  it.each(['sub', 'SID', 'ABA'] as const)('an already pending refresh after %s change cannot retry or replace the current profile', async boundary => {
    deferRefresh = true
    await mount(); names(); await reply(0, '', 401)
    await waitFor(() => expect(pendingRefresh).toHaveLength(1))
    if (boundary === 'sub') await changeIdentity('person-b', 'session-a')
    else if (boundary === 'SID') await changeIdentity('person-a', 'session-b')
    else await queuedABA()
    await waitFor(() => expect(reads()).toHaveLength(2)); names()
    await refreshReply(); expect(reads()).toHaveLength(2)
    await reply(1, 'Current principal profile'); expect(own().value).toBe('Current principal profile')
    expect(reads()[1]!.authorization).toBe(`Bearer ${tokens(boundary === 'sub' ? 'person-b' : 'person-a', boundary === 'SID' ? 'session-b' : 'session-a').accessToken}`)
  })
  it('a successful same-SID refresh retries online with its actual new token and prefills', async () => {
    deferRefresh = true
    await mount(); names(); fireEvent.change(partner(), { target: { value: 'Kept partner' } })
    await reply(0, '', 401); await waitFor(() => expect(pendingRefresh).toHaveLength(1))
    await refreshReply(); await waitFor(() => expect(reads()).toHaveLength(2))
    expect(reads()[1]!.authorization).toBe(`Bearer ${tokens('person-a', 'session-a', 'refreshed').accessToken}`)
    await reply(1, 'Refreshed profile'); expect(own().value).toBe('Refreshed profile')
    expect(partner().value).toBe('Kept partner')
  })
})
