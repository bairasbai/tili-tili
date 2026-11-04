import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, beginLocalSessionAction, saveTokens } from './client'

const tokens = (sub: string, sid: string, revision = 1) => ({
  accessToken: `e30.${btoa(JSON.stringify({ sub, sid, revision, exp: 2100000000 }))}.audit22`,
  refreshToken: `${sub}-${sid}-${revision}-refresh`,
})
const a = tokens('audit-a', 'session-a'), b = tokens('audit-b', 'session-b')
const renewed = tokens('audit-a', 'session-a', 2)
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0))
const outcome = <T,>(pending: Promise<T>) => pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
function change(mode: 'B' | 'ABA' | 'logout' | 'session') {
  saveTokens(mode === 'logout' ? null : mode === 'session' ? tokens('audit-a', 'other-session') : b)
  if (mode === 'ABA') saveTokens(a)
}

beforeEach(() => { localStorage.clear(); saveTokens(a) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); saveTokens(null) })

describe('audit22 FE03: authenticated request keeps its original owner by default', () => {
  it.each(['B', 'ABA', 'logout', 'session'] as const)('does not refresh/replay an old mutation after %s before its original401', async mode => {
    const headers = deferred<Response>(), original = json(401, { error: { code: 'token_expired', message: 'Synthetic expired A request' } })
    const onResponse = vi.fn()
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/auth/refresh')
      ? json(200, mode === 'session' ? tokens('audit-a', 'other-session', 2) : tokens('audit-b', 'session-b', 2))
      : fetcher.mock.calls.length === 1 ? headers.promise : new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    const pending = outcome(api.delete('/users/me', { onResponse }))
    change(mode); const stored = localStorage.getItem('tt_auth')
    headers.resolve(original)
    const result = await pending
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    expect(original.bodyUsed).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
    expect(localStorage.getItem('tt_auth')).toBe(stored)
  })

  it.each([200, 204, 401])('disposes a late default-owned %s before refusing, with no metadata/data publication', async status => {
    const headers = deferred<Response>(), body = deferred<ArrayBuffer>()
    const response = status === 204 ? new Response(null, { status }) : json(status, status === 401 ? { error: { code: 'token_expired' } } : { name: 'A private profile' })
    const drain = vi.spyOn(response, 'arrayBuffer').mockImplementation(() => body.promise), onResponse = vi.fn()
    const fetcher = vi.fn(async () => headers.promise); vi.stubGlobal('fetch', fetcher)
    let settled = false
    const pending = outcome(api.get('/users/me', { onResponse })).then(result => { settled = true; return result })
    try {
      saveTokens(b); headers.resolve(response); await turn()
      expect(drain).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      expect(onResponse).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(1)
      body.resolve(new ArrayBuffer(0))
      expect((await pending).ok).toBe(false)
    } finally { headers.resolve(response); body.resolve(new ArrayBuffer(0)); await pending }
  })

  it('keeps the exact body/key and same-owner token renewal working', async () => {
    const calls: { method: string | undefined; token: string | null; body: BodyInit | null | undefined; key: string | null }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method, token: headers.get('authorization'), body: init?.body, key: headers.get('Idempotency-Key') })
      return String(input).endsWith('/auth/refresh') ? json(200, renewed)
        : calls.length === 1 ? json(401, { error: { code: 'token_expired' } }) : json(200, { id: 'audit-a', name: 'Changed' })
    }); vi.stubGlobal('fetch', fetcher)
    await expect(api.patch('/users/me', { name: 'Changed' }, { idempotencyKey: 'audit22-fixed-intent' })).resolves.toMatchObject({ name: 'Changed' })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({ method: 'PATCH', token: `Bearer ${a.accessToken}`, body: '{"name":"Changed"}', key: 'audit22-fixed-intent' })
    expect(calls[2]).toEqual({ ...calls[0], token: `Bearer ${renewed.accessToken}` })
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(renewed)
  })

  it('keeps an original reader alive through a real same-session renewal storage event', async () => {
    const headers = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async () => headers.promise))
    const pending = api.get('/users/me')
    const oldValue = localStorage.getItem('tt_auth'), newValue = JSON.stringify(renewed)
    localStorage.setItem('tt_auth', newValue)
    const event = new Event('storage')
    Object.assign(event, { key: 'tt_auth', storageArea: localStorage, oldValue, newValue })
    window.dispatchEvent(event)
    headers.resolve(json(200, { id: 'audit-a', name: 'Same owner private profile' }))
    await expect(pending).resolves.toMatchObject({ id: 'audit-a', name: 'Same owner private profile' })
    expect(localStorage.getItem('tt_auth')).toBe(newValue)
  })

  it('does not let a new request join a refresh owned by the previous account', async () => {
    const refresh = deferred<Response>()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/refresh')) return refresh.promise
      const authorization = new Headers(init?.headers).get('authorization')
      return json(401, { error: { code: 'token_expired', message: authorization ?? '' } })
    }); vi.stubGlobal('fetch', fetcher)
    const old = outcome(api.delete('/users/me'))
    await turn(); expect(fetcher).toHaveBeenCalledTimes(2)
    saveTokens(b)
    const next = outcome(api.patch('/users/me', { name: 'B intended name' }))
    refresh.resolve(json(200, renewed))
    const results = await Promise.all([old, next])
    expect(results[0].ok).toBe(false)
    // A's result must never renew, clear, or replay a mutation using B's credentials.
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
    expect(fetcher.mock.calls.filter(call => new Headers(call[1]?.headers).get('authorization') === `Bearer ${renewed.accessToken}`)).toHaveLength(0)
  })

  it('retains explicit-fence priority and disposal failure evidence', async () => {
    const action = beginLocalSessionAction('Explicit audit owner retired'), headers = deferred<Response>()
    const response = new Response(null, { status: 204 }), failure = new TypeError('Synthetic disposal failure')
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(failure)
    vi.stubGlobal('fetch', vi.fn(async () => headers.promise))
    const pending = outcome(api.delete('/users/me', { assertCurrent: action.assertCurrent }))
    try {
      saveTokens(b); headers.resolve(response)
      const result = await pending
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AggregateError)
        expect(result.error.errors[0]).toMatchObject({ message: 'Explicit audit owner retired' })
        expect(result.error.errors[1]).toBe(failure)
      }
    } finally { headers.resolve(response); await pending; action.close() }
  })

  it('keeps auth:false independent of local session changes', async () => {
    const headers = deferred<Response>(), fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { void input; void init; return headers.promise })
    vi.stubGlobal('fetch', fetcher)
    const pending = api.get('/legal/policy', { auth: false })
    saveTokens(b); headers.resolve(json(200, { version: 'public', text: 'Public policy' }))
    await expect(pending).resolves.toMatchObject({ version: 'public' })
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('preserves intentional session_expired and releases local boundary listeners when settled', async () => {
    const added = vi.spyOn(window, 'addEventListener'), removed = vi.spyOn(window, 'removeEventListener')
    const documentAdded = vi.spyOn(document, 'addEventListener'), documentRemoved = vi.spyOn(document, 'removeEventListener')
    const fetcher = vi.fn(async () => json(401, { error: { code: 'unauthorized', message: 'Synthetic ended session' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(api.get('/users/me')).rejects.toMatchObject({ name: 'ApiError', status: 401, code: 'session_expired' })
    expect(localStorage.getItem('tt_auth')).toBeNull()
    for (const [type, listener] of added.mock.calls.filter(call => ['storage', 'focus'].includes(call[0]))) {
      expect(removed.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true)
    }
    for (const [type, listener] of documentAdded.mock.calls.filter(call => call[0] === 'visibilitychange')) {
      expect(documentRemoved.mock.calls.some(call => call[0] === type && call[1] === listener)).toBe(true)
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
