// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { disableDevicePush, enableDevicePush } from './push'
import { saveTokens } from './api/client'

const credential = (owner: string) => ({ accessToken: `header.${btoa(JSON.stringify({ sub: owner, sid: owner + '-session' }))}.signature`, refreshToken: 'synthetic-' + owner })
const A = credential('A'), B = credential('B')
function held<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r }), resolve: (value: T) => resolve(value) } }
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); saveTokens(A); vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'AQID') })
afterEach(() => { saveTokens(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear() })
it.each(['registration', 'subscription', 'unsubscribe', 'permission', 'subscribe'])('FE02 actual push helper never continues as B after held %s browser step', async stage => {
  const gate = held<unknown>(), enabling = stage === 'permission' || stage === 'subscribe'
  let paused = false
  const pause = () => { paused = true; return gate.promise }
  const sub = { endpoint: 'https://push.example.invalid/audit22', toJSON: () => ({ endpoint: 'https://push.example.invalid/audit22', keys: { p256dh: 'synthetic', auth: 'synthetic' } }),
    unsubscribe: vi.fn(() => stage === 'unsubscribe' ? pause() : Promise.resolve(true)) }
  const reg = { active: {}, pushManager: {
    getSubscription: vi.fn(() => stage === 'subscription' ? pause() : Promise.resolve(stage === 'subscribe' ? null : sub)),
    subscribe: vi.fn(() => stage === 'subscribe' ? pause() : Promise.resolve(sub)),
  } }
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => stage === 'registration' ? pause() : Promise.resolve(reg), ready: Promise.resolve(reg) } })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: () => stage === 'permission' ? pause() : Promise.resolve('granted') })
  const fetcher = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher)
  const pending = (enabling ? enableDevicePush() : disableDevicePush()).then(() => null, error => error)
  await vi.waitFor(() => expect(paused).toBe(true))
  saveTokens(B)
  gate.resolve(stage === 'registration' ? reg : stage === 'subscription' || stage === 'subscribe' ? sub : stage === 'permission' ? 'granted' : true)
  await pending
  expect(fetcher).not.toHaveBeenCalled()
  if (stage === 'registration' || stage === 'subscription') expect(sub.unsubscribe).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem('tt_auth') ?? 'null')).toEqual(B)
})
it.each([false, true])('FE02 actual push same-owner positive control enable=%s reaches exactly one server action', async enable => {
  const sub = { endpoint: 'https://push.example.invalid/audit22', toJSON: () => ({ endpoint: 'https://push.example.invalid/audit22', keys: { p256dh: 'synthetic', auth: 'synthetic' } }), unsubscribe: vi.fn(async () => true) }
  const reg = { active: {}, pushManager: { getSubscription: async () => sub } }
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => reg, ready: Promise.resolve(reg) } })
  vi.stubGlobal('PushManager', class {}); vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' })
  const fetcher = vi.fn(async () => new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher)
  if (enable) await enableDevicePush(); else await disableDevicePush()
  expect(fetcher).toHaveBeenCalledTimes(1)
  const init = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(init[1].method).toBe(enable ? 'POST' : 'DELETE')
  expect(new Headers(init[1].headers).get('Authorization')).toBe('Bearer ' + A.accessToken)
})
