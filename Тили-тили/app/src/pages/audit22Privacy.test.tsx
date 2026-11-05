// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTokens } from '@/lib/api/client'
import { StoreProvider } from '@/lib/store'
import { Settings } from './Account'
import { Chat, Us } from './Us'

// The real components, store, useApi, auth wrappers and HTTP client run here.
// Only browser push/WS and the HTTP boundary are synthetic; no real network.
const push = vi.hoisted(() => ({ disable: vi.fn(), all: vi.fn(), enable: vi.fn(), state: vi.fn() }))
vi.mock('@/lib/push', () => ({
  pushSupported: () => false,
  devicePushState: push.state,
  disableDevicePush: push.disable,
  disableAllDevicePush: push.all,
  enableDevicePush: push.enable,
}))

const tokens = (sub: string, sid: string) => ({ accessToken: `e30.${btoa(JSON.stringify({ sub, sid, exp: 2100000000 }))}.audit22`, refreshToken: `${sub}-${sid}-refresh` })
const a = tokens('audit-user-a', 'audit-session-a'), b = tokens('audit-user-b', 'audit-session-b')
const profileA = { id: 'audit-user-a', name: 'Private profile A', phone: '+79990000001', push: { tasks: true, chats: true, deals: true, tips: true } }
const profileB = { ...profileA, id: 'audit-user-b', name: 'Private profile B', phone: '+79990000002' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
type Call = { path: string; method: string; authorization: string | null; body: BodyInit | null | undefined }
let calls: Call[] = []
let responseOverride: ((call: Call) => Promise<Response> | Response | undefined) | null = null

class Socket {
  static instances: Socket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  close = vi.fn()
  readonly url: string
  constructor(url: string) { this.url = url; Socket.instances.push(this) }
}

function setupFetch() {
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^.*?\/api/, ''), method = init?.method ?? 'GET'
    const call = { path, method, authorization: new Headers(init?.headers).get('authorization'), body: init?.body }
    calls.push(call)
    const override = responseOverride?.(call)
    if (override) return override
    if (path === '/users/me' && method === 'GET') return json(call.authorization === `Bearer ${a.accessToken}` ? profileA : profileB)
    if (path === '/users/me' && method === 'PATCH') return json({ ...profileA, ...JSON.parse(String(init?.body)) })
    if (method !== 'GET') return new Response(null, { status: 204 })
    if (path === '/weddings') return json([])
    if (path === '/users/me/sessions') return json([{ id: 'a-other-session', device: 'A private laptop', current: false }])
    if (path === '/users/me/push-subscriptions') return json([{ id: 'a-push', endpointHost: 'A private push host', mine: false }])
    if (path === '/chats') return json([{ id: 'private-chat', weddingId: 'w-a', title: 'A private chat', kind: 'team', unread: 0 }])
    if (path.startsWith('/chats/private-chat/messages')) return json({ items: [{ id: 'm-a', text: 'Private message A', senderId: 'audit-user-a', sentAt: '2027-06-14T09:00:00Z' }], nextCursor: 'older-page' })
    return json([])
  }))
}
function mount(node: React.ReactNode, route: string) {
  return render(<MemoryRouter initialEntries={[route]}><StoreProvider><Routes>
    <Route path="/settings" element={node} /><Route path="/us/chats/:id" element={node} /><Route path="/us" element={node} />
    <Route path="/auth" element={<p>Sign in route</p>} /><Route path="/" element={<p>Home route</p>} />
  </Routes></StoreProvider></MemoryRouter>)
}
async function boundary(mode: 'logout' | 'switch' | 'ABA' | 'storage' | 'storageABA') {
  await act(async () => {
    if (mode === 'storage' || mode === 'storageABA') {
      const oldValue = localStorage.getItem('tt_auth'), newValue = JSON.stringify(b)
      localStorage.setItem('tt_auth', newValue)
      // Both other-tab writes completed before this queued event is delivered.
      // Current storage is A again, while oldValue/newValue still prove A→B.
      if (mode === 'storageABA') localStorage.setItem('tt_auth', JSON.stringify(a))
      const event = new Event('storage'); Object.assign(event, { key: 'tt_auth', storageArea: localStorage, oldValue, newValue })
      window.dispatchEvent(event)
    } else { saveTokens(mode === 'logout' ? null : b); if (mode === 'ABA') saveTokens(a) }
  })
}
const writes = () => calls.filter(call => call.method !== 'GET')
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); saveTokens(a); calls = []; responseOverride = null; Socket.instances = []
  push.disable.mockReset().mockResolvedValue(undefined); push.all.mockReset().mockResolvedValue(undefined)
  push.enable.mockReset().mockResolvedValue(undefined); push.state.mockReset().mockResolvedValue('off')
  setupFetch()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); saveTokens(null) })

describe('audit22 FE01 actual Chat privacy', () => {
  it.each(['logout', 'switch', 'ABA', 'storage', 'storageABA'] as const)('destroys loaded history/draft/socket on %s, ignoring already queued WS events', async mode => {
    mount(<Chat />, '/us/chats/private-chat')
    await screen.findByText('Private message A')
    fireEvent.change(screen.getByPlaceholderText('Сообщение…'), { target: { value: 'Unsent private draft A' } })
    const socket = Socket.instances[0]!
    expect(socket).toBeTruthy()
    const queued = socket.onmessage, queuedOpen = socket.onopen
    await boundary(mode)
    expect(screen.queryByText('Private message A')).toBeNull()
    expect(screen.queryByDisplayValue('Unsent private draft A')).toBeNull()
    expect(screen.queryByText('A private chat')).toBeNull()
    expect(socket.close).toHaveBeenCalledOnce()
    const before = calls.length
    await act(async () => { queued?.(new MessageEvent('message', { data: JSON.stringify({ type: 'message', chatId: 'private-chat' }) })); queuedOpen?.() })
    expect(calls).toHaveLength(before)
    expect(screen.queryByText('Private message A')).toBeNull()
  })

  it('does not repopulate private history from a late older-page request', async () => {
    const earlier = deferred<Response>()
    responseOverride = call => call.path.includes('cursor=') ? earlier.promise : undefined
    mount(<Chat />, '/us/chats/private-chat'); await screen.findByText('Private message A')
    fireEvent.click(screen.getByRole('button', { name: 'Показать сообщения раньше' }))
    await waitFor(() => expect(calls.some(call => call.path.includes('cursor='))).toBe(true))
    await boundary('switch')
    await act(async () => { earlier.resolve(json({ items: [{ id: 'older-a', text: 'Late private history A' }], nextCursor: null })) })
    expect(screen.queryByText('Private message A')).toBeNull()
    expect(screen.queryByText('Late private history A')).toBeNull()
  })

  it('clears the UI when a live HTTP read confirms access was revoked', async () => {
    mount(<Chat />, '/us/chats/private-chat'); await screen.findByText('Private message A')
    responseOverride = call => call.path.startsWith('/chats/private-chat/messages') ? json({ error: { code: 'not_found', message: 'Chat access revoked' } }, 404) : undefined
    await act(async () => { Socket.instances[0]!.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'message' }) })) })
    await screen.findByText('Chat access revoked')
    expect(screen.queryByText('Private message A')).toBeNull()
    expect(screen.queryByPlaceholderText('Сообщение…')).toBeNull()
  })
})

describe('audit22 FE02 actual Settings keeps one permanent origin', () => {
  it.each(['switch', 'ABA', 'storage', 'storageABA'] as const)('retires delete/withdraw/profile/device controls on %s', async mode => {
    mount(<Settings />, '/settings'); await screen.findByText(profileA.name); await screen.findByText('A private laptop')
    fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт и все данные' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отозвать согласие на обработку данных' }))
    fireEvent.click(screen.getByRole('button', { name: 'Снять push на всех устройствах' }))
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
    fireEvent.change(screen.getByDisplayValue(profileA.name), { target: { value: 'Unsent A name' } })
    const staleDelete = screen.getByRole('button', { name: 'Подтвердить удаление — данные сотрутся' })
    const staleWithdraw = screen.getByRole('button', { name: 'Подтвердить отзыв согласия' })
    const staleName = screen.getByRole('button', { name: 'Готово' })
    const staleSession = screen.getByRole('button', { name: 'Завершить' })
    const stalePush = screen.getByRole('button', { name: 'Снять на всех устройствах?' })
    await boundary(mode)
    expect(screen.queryByText(profileA.phone)).toBeNull()
    expect(screen.queryByText('A private laptop')).toBeNull()
    expect(screen.queryByText('A private push host')).toBeNull()
    expect(screen.queryByDisplayValue('Unsent A name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Подтвердить удаление — данные сотрутся' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Подтвердить отзыв согласия' })).toBeNull()
    for (const button of [staleDelete, staleWithdraw, staleName, staleSession, stalePush]) fireEvent.click(button)
    expect(writes()).toHaveLength(0)
    expect(push.all).not.toHaveBeenCalled()
  })

  it('does not let a late profile save restore A after account switch', async () => {
    const saved = deferred<Response>()
    responseOverride = call => call.path === '/users/me' && call.method === 'PATCH' ? saved.promise : undefined
    mount(<Settings />, '/settings'); await screen.findByText(profileA.name)
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
    fireEvent.change(screen.getByDisplayValue(profileA.name), { target: { value: 'A pending name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    await boundary('switch')
    await act(async () => { saved.resolve(json({ ...profileA, name: 'A pending name' })) })
    expect(screen.queryByText('A pending name')).toBeNull()
    expect(screen.queryByText(profileA.phone)).toBeNull()
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
  })

  it('does not publish a held initial profile read after switching away and back', async () => {
    const profile = deferred<Response>()
    responseOverride = call => call.path === '/users/me' && call.method === 'GET' ? profile.promise : undefined
    mount(<Settings />, '/settings')
    await waitFor(() => expect(calls.some(call => call.path === '/users/me')).toBe(true))
    await boundary('ABA')
    await act(async () => { profile.resolve(json(profileA)) })
    expect(screen.queryByText(profileA.name)).toBeNull()
    expect(screen.queryByText(profileA.phone)).toBeNull()
  })

  it.each(['delete', 'withdraw'] as const)('late successful %s does not clear B tokens, disable B push or navigate', async kind => {
    const completed = deferred<Response>()
    responseOverride = call => call.method === 'DELETE' && call.path === (kind === 'delete' ? '/users/me' : '/users/me/consent') ? completed.promise : undefined
    mount(<Settings />, '/settings'); await screen.findByText(profileA.name)
    fireEvent.click(screen.getByRole('button', { name: kind === 'delete' ? 'Удалить аккаунт и все данные' : 'Отозвать согласие на обработку данных' }))
    fireEvent.click(screen.getByRole('button', { name: kind === 'delete' ? 'Подтвердить удаление — данные сотрутся' : 'Подтвердить отзыв согласия' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    await boundary('switch')
    await act(async () => { completed.resolve(new Response(null, { status: 204 })) })
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
    expect(push.disable).not.toHaveBeenCalled()
    expect(screen.queryByText('Home route')).toBeNull(); expect(screen.queryByText('Sign in route')).toBeNull()
    expect(writes()).toHaveLength(1)
  })

  it.each(['here', 'all'] as const)('does not continue a %s-device signout after its delayed push step changes owner', async kind => {
    const pushRemoved = deferred<void>()
    push.disable.mockImplementation(() => pushRemoved.promise)
    mount(<Settings />, '/settings'); await screen.findByText(profileA.name)
    fireEvent.click(screen.getByRole('button', { name: kind === 'here' ? 'Выйти только с этого устройства' : 'Выйти со всех устройств' }))
    await waitFor(() => expect(push.disable).toHaveBeenCalledOnce())
    await boundary('switch')
    await act(async () => { pushRemoved.resolve(undefined) })
    expect(writes()).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
    expect(screen.queryByText('Sign in route')).toBeNull()
  })
})

it.each(['switch', 'storageABA'] as const)('audit22 FE02 Us signout never continues under B after the delayed A push step (%s)', async mode => {
  const pushRemoved = deferred<void>()
  push.disable.mockImplementation(() => pushRemoved.promise)
  mount(<Us />, '/us')
  const oldAction = await screen.findByRole('button', { name: 'Выйти из аккаунта' })
  fireEvent.click(oldAction)
  await waitFor(() => expect(push.disable).toHaveBeenCalledOnce())
  await boundary(mode)
  expect(oldAction.isConnected).toBe(false)
  await act(async () => { pushRemoved.resolve(undefined) })
  expect(writes()).toHaveLength(0)
  expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(mode === 'storageABA' ? a : b)
  expect(screen.queryByText('Sign in route')).toBeNull()
})
