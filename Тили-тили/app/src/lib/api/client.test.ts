// @vitest-environment jsdom
/*
 * Обмен refresh из двух вкладок.
 *
 * Вкладки одного браузера делят localStorage. Обе просыпаются с истёкшим
 * access и обе идут за новой парой; вторая приходит на сервер уже со старым
 * refresh и получает 401 `refresh_superseded`. До фикса клиент на любом
 * отказе стирал хранилище — и выкидывал ту вкладку, у которой всё было
 * в порядке. Теперь он сначала смотрит, не сменилась ли пара под ним.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api, ApiError, onSessionChanged, saveTokens, url } from './client'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a0', refreshToken: 'r0' }))
})
afterEach(() => vi.unstubAllGlobals())

describe('local private-reader session boundaries', () => {
  const tokens = (sub: string, sid: string, expiry: number) => ({ accessToken: 'header.' + btoa(JSON.stringify({ sub, sid, exp: expiry })) + '.signature', refreshToken: 'refresh-' + expiry })
  it('clears on logout and a different session, but preserves the same session during access renewal', () => {
    saveTokens(tokens('user-a', 'session-a', 1))
    const changed = vi.fn(), stop = onSessionChanged(changed)
    try {
      saveTokens(tokens('user-a', 'session-a', 2)); expect(changed).not.toHaveBeenCalled()
      saveTokens(tokens('user-a', 'session-b', 3)); expect(changed).toHaveBeenCalledTimes(1)
      saveTokens(null); expect(changed).toHaveBeenCalledTimes(2)
    } finally { stop() }
    saveTokens(tokens('user-b', 'session-c', 4)); expect(changed).toHaveBeenCalledTimes(2)
  })
  it('observes another tab clearing credentials and catches a changed account when focus returns', () => {
    saveTokens(tokens('user-a', 'session-a', 1))
    const changed = vi.fn(), stop = onSessionChanged(changed)
    try {
      const oldValue = localStorage.getItem('tt_auth')
      localStorage.removeItem('tt_auth')
      // The suite may use MemoryStorage rather than jsdom's branded Storage.
      const event = new Event('storage')
      Object.assign(event, { key: 'tt_auth', storageArea: localStorage, oldValue, newValue: null })
      window.dispatchEvent(event)
      expect(changed).toHaveBeenCalledTimes(1)
      localStorage.setItem('tt_auth', JSON.stringify(tokens('user-b', 'session-b', 2))); window.dispatchEvent(new Event('focus'))
      expect(changed).toHaveBeenCalledTimes(2)
      window.dispatchEvent(new Event('focus')); expect(changed).toHaveBeenCalledTimes(2)
    } finally { stop() }
  })
})

describe('version-bound snapshots', () => {
  it('sends the captured If-Match on DELETE and accepts its empty 204 response', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(api.delete(url('/weddings/{weddingId}/events/{eventId}', { weddingId: 'w1', eventId: 'e1' }), { ifMatch: '"7"' })).resolves.toBeUndefined()
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('If-Match')).toBe('"7"')
  })
  it('binds each response version to its own data instead of a global cache', async () => {
    let revision = 0
    let submitted: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') submitted = (init.headers as Record<string, string>)['If-Match']
      else revision++
      return new Response(JSON.stringify([{ id: `block-${revision}`, name: 'Block' }]), {
        status: 200, headers: { 'content-type': 'application/json', etag: `"${revision}"` },
      })
    }))
    const path = url('/weddings/{weddingId}/timeline', { weddingId: 'w1' })
    const first = await api.getSnapshot(path)
    const second = await api.getSnapshot(path)
    expect(first.etag).toBe('"1"')
    expect(second.etag).toBe('"2"')
    await api.putSnapshot(path, first.data, { ifMatch: first.etag! })
    expect(submitted).toBe('"1"')
  })

  it('does not fabricate a version when the server supplies none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, [])))
    const result = await api.getSnapshot(url('/weddings/{weddingId}/timeline', { weddingId: 'w1' }))
    expect(result.etag).toBeNull()
    expect(result.data).toEqual([])
  })

  it('retains metadata headers of this successful response alongside its data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), {
      headers: { 'content-type': 'application/json', etag: '"9"', 'X-Timeline-Updated-At': '2026-09-30T10:00:00.000Z', 'X-Timeline-Updated-By': 'actual-author' },
    })))
    const snapshot = await api.getSnapshot(url('/weddings/{weddingId}/timeline', { weddingId: 'w1' }))
    expect(snapshot.etag).toBe('"9"')
    expect(snapshot.headers.get('X-Timeline-Updated-At')).toBe('2026-09-30T10:00:00.000Z')
    expect(snapshot.headers.get('X-Timeline-Updated-By')).toBe('actual-author')
  })

  it('does not retry a conflict against a newer version', async () => {
    const fetcher = vi.fn(async () => json(409, { error: { code: 'timeline_conflict', message: 'Changed' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(api.putSnapshot(url('/weddings/{weddingId}/timeline', { weddingId: 'w1' }), [], { ifMatch: '"1"' }))
      .rejects.toMatchObject({ status: 409, code: 'timeline_conflict' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('refresh, устаревший под другой вкладкой', () => {
  it('берёт пару, которую успела положить другая вкладка, и повторяет запрос с ней', async () => {
    // Unsigned fixture claims identify a same-user/session renewal; never server authentication.
    const credential = (revision: number) => 'header.' + btoa(JSON.stringify({ sub: 'user-a', sid: 'session-a', fixtureRevision: revision })) + '.synthetic'
    const initial = { accessToken: credential(0), refreshToken: 'r0' }
    const renewed = { accessToken: credential(1), refreshToken: 'r1' }
    localStorage.setItem('tt_auth', JSON.stringify(initial))
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        seen.push(`${init?.method} ${input} ${headers.authorization ?? ''}`)
        if (input.endsWith('/auth/refresh')) {
          // Другая вкладка обменяла токен первой и сохранила новую пару.
          localStorage.setItem('tt_auth', JSON.stringify(renewed))
          return json(401, { error: { code: 'refresh_superseded', message: 'уже обменян' } })
        }
        if (headers.authorization === 'Bearer ' + renewed.accessToken) return json(200, { id: 'me' })
        return json(401, { error: { code: 'unauthorized', message: 'истёк' } })
      }),
    )

    const me = await api.get('/users/me')
    expect(me).toEqual({ id: 'me' })
    expect(seen).toEqual(['GET /api/users/me Bearer ' + initial.accessToken, 'POST /api/auth/refresh ', 'GET /api/users/me Bearer ' + renewed.accessToken])
    // Хранилище не стёрто: там пара второй вкладки.
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(renewed)
  })

  it('если пара не менялась, отказ на refresh по-прежнему разлогинивает', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/auth/refresh')) return json(401, { error: { code: 'unauthorized', message: 'вход кончился' } })
        return json(401, { error: { code: 'unauthorized', message: 'истёк' } })
      }),
    )
    await expect(api.get('/users/me')).rejects.toBeInstanceOf(ApiError)
    expect(localStorage.getItem('tt_auth')).toBeNull()
  })
})


describe('empty response completion', () => {
  it.each([204, 205])('keeps the action pending until the empty response finishes (%s)', async status => {
    let finish!: (value: ArrayBuffer) => void
    const body = new Promise<ArrayBuffer>(resolve => { finish = resolve })
    const response = new Response(null, { status })
    vi.spyOn(response, 'arrayBuffer').mockImplementation(() => body)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    let settled = false
    const pending = api.delete('/users/me/push-subscriptions').then(value => { settled = true; return value })
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
    } finally { finish(new ArrayBuffer(0)) }
    await expect(pending).resolves.toBeUndefined()
  })

  it('does not report successful completion if the response stream fails', async () => {
    const response = new Response(null, { status: 204 })
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new TypeError('Synthetic response stream failed'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(api.delete('/users/me/push-subscriptions')).rejects.toThrow('Synthetic response stream failed')
  })

  it('rechecks action ownership after a delayed empty response finishes', async () => {
    let finish!: (value: ArrayBuffer) => void
    const body = new Promise<ArrayBuffer>(resolve => { finish = resolve })
    const response = new Response(null, { status: 204 })
    vi.spyOn(response, 'arrayBuffer').mockImplementation(() => body)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    let changed = false
    const pending = api.delete('/users/me/push-subscriptions', {
      assertCurrent: () => { if (changed) throw new Error('Synthetic action owner changed') },
    })
    const settlement = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    await new Promise(resolve => setTimeout(resolve, 0))
    changed = true
    finish(new ArrayBuffer(0))
    const result = await settlement
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ message: 'Synthetic action owner changed' })
  })
})

import { beginLocalSessionAction, onSessionExpired } from './client'

describe('received response ownership', () => {
  const tokens = (sub: string, sid: string, revision: number) => ({
    accessToken: 'header.' + btoa(JSON.stringify({ sub, sid, revision })) + '.synthetic',
    refreshToken: 'response-owner-' + sub + '-' + revision,
  })
  const a = tokens('response-user-a', 'response-session-a', 1)
  const b = tokens('response-user-b', 'response-session-b', 2)
  const renewed = tokens('response-user-a', 'response-session-a', 3)
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  function watch<T>(pending: Promise<T>) {
    let done = false
    const result = pending.then(value => { done = true; return { ok: true as const, value } }, error => { done = true; return { ok: false as const, error } })
    return { result, isDone: () => done }
  }
  const turn = () => new Promise(resolve => setTimeout(resolve, 0))
  function store(value: typeof a) {
    const oldValue = localStorage.getItem('tt_auth'), newValue = JSON.stringify(value)
    localStorage.setItem('tt_auth', newValue)
    const event = new Event('storage')
    Object.assign(event, { key: 'tt_auth', storageArea: localStorage, oldValue, newValue })
    window.dispatchEvent(event)
  }
  const seed = () => localStorage.setItem('tt_auth', JSON.stringify(a))

  it.each([['B', 204], ['B', 200], ['B', 401], ['ABA', 204], ['ABA', 200], ['ABA', 401]] as const)(
    'disposes stale %s response %s before refusing without callbacks or another request', async (transition, status) => {
      seed()
      const action = beginLocalSessionAction('Response owner changed'), headers = deferred<Response>(), body = deferred<ArrayBuffer>()
      const response = status === 204 ? new Response(null, { status }) : json(status, { private: 'original-user-only' })
      const drain = vi.spyOn(response, 'arrayBuffer').mockImplementation(() => body.promise), onResponse = vi.fn()
      const fetcher = vi.fn(async () => headers.promise); vi.stubGlobal('fetch', fetcher)
      const pending = watch(api.get('/users/me', { assertCurrent: action.assertCurrent, onResponse }))
      try {
        await turn(); expect(fetcher).toHaveBeenCalledTimes(1)
        store(b); if (transition === 'ABA') store(a)
        headers.resolve(response); await turn()
        expect(drain).toHaveBeenCalledTimes(1); expect(pending.isDone()).toBe(false)
        expect(onResponse).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1)
        body.resolve(new ArrayBuffer(0))
        const result = await pending.result
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toMatchObject({ message: 'Response owner changed' })
        expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(transition === 'ABA' ? a : b)
        expect(onResponse).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1)
      } finally { headers.resolve(response); body.resolve(new ArrayBuffer(0)); await pending.result; action.close() }
    },
  )

  it('finishes the original 401 body before starting refresh or replacing its response', async () => {
    seed()
    const body = deferred<ArrayBuffer>(), original = json(401, { error: { code: 'token_expired', message: 'Expired' } })
    const drain = vi.spyOn(original, 'arrayBuffer').mockImplementation(() => body.promise)
    const fetcher = vi.fn(async (input: string) => {
      if (input.endsWith('/auth/refresh')) return json(200, renewed)
      return fetcher.mock.calls.length === 1 ? original : json(200, { id: 'me' })
    }); vi.stubGlobal('fetch', fetcher)
    const pending = watch(api.get('/users/me'))
    try {
      await turn(); expect(drain).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledTimes(1); expect(pending.isDone()).toBe(false)
      body.resolve(new ArrayBuffer(0))
      const result = await pending.result; expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toEqual({ id: 'me' })
      expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/users/me', '/api/auth/refresh', '/api/users/me'])
      expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(renewed)
    } finally { body.resolve(new ArrayBuffer(0)); await pending.result }
  })

  it('does not refresh if disposal of the original 401 fails', async () => {
    seed()
    const original = json(401, { error: { code: 'token_expired' } }), failure = new TypeError('Original401 stream failed')
    vi.spyOn(original, 'arrayBuffer').mockRejectedValue(failure)
    const fetcher = vi.fn(async () => original); vi.stubGlobal('fetch', fetcher)
    await expect(api.get('/users/me')).rejects.toBe(failure)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(a)
  })

  it.each([200, 401])('disposes stale refresh %s before refusing without saving, clearing, logout or retry', async status => {
    seed()
    const headers = deferred<Response>(), body = deferred<ArrayBuffer>()
    const refresh = json(status, status === 200 ? renewed : { error: { code: 'unauthorized', message: 'Old session refused' } })
    const drain = vi.spyOn(refresh, 'arrayBuffer').mockImplementation(() => body.promise), expired = vi.fn(), stop = onSessionExpired(expired)
    const fetcher = vi.fn(async (input: string) => input.endsWith('/auth/refresh') ? headers.promise : json(401, { error: { code: 'token_expired' } }))
    vi.stubGlobal('fetch', fetcher)
    const pending = watch(api.get('/users/me'))
    try {
      await turn(); expect(fetcher).toHaveBeenCalledTimes(2)
      store(b); headers.resolve(refresh); await turn()
      expect(drain).toHaveBeenCalledTimes(1); expect(pending.isDone()).toBe(false)
      expect(expired).not.toHaveBeenCalled(); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
      body.resolve(new ArrayBuffer(0))
      const result = await pending.result; expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatchObject({ message: 'Аккаунт или сессия изменились — повторите действие' })
      expect(fetcher).toHaveBeenCalledTimes(2); expect(expired).not.toHaveBeenCalled()
      expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
    } finally { headers.resolve(refresh); body.resolve(new ArrayBuffer(0)); await pending.result; stop() }
  })

  it('disposes a same-scope superseded refresh before the stored-pair retry', async () => {
    seed()
    const body = deferred<ArrayBuffer>(), refused = json(401, { error: { code: 'refresh_superseded', message: 'Other tab renewed' } })
    const drain = vi.spyOn(refused, 'arrayBuffer').mockImplementation(() => body.promise)
    const fetcher = vi.fn(async (input: string) => {
      if (input.endsWith('/auth/refresh')) { store(renewed); return refused }
      return fetcher.mock.calls.length === 1 ? json(401, { error: { code: 'token_expired' } }) : json(200, { id: 'me' })
    }); vi.stubGlobal('fetch', fetcher)
    const pending = watch(api.get('/users/me'))
    try {
      await turn(); expect(drain).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledTimes(2); expect(pending.isDone()).toBe(false)
      body.resolve(new ArrayBuffer(0))
      const result = await pending.result; expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toEqual({ id: 'me' })
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(renewed)
    } finally { body.resolve(new ArrayBuffer(0)); await pending.result }
  })

  it('consumes a non-JSON success before resolving its existing undefined result', async () => {
    const body = deferred<ArrayBuffer>(), response = new Response('text', { headers: { 'content-type': 'text/plain' } })
    const drain = vi.spyOn(response, 'arrayBuffer').mockImplementation(() => body.promise)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const pending = watch(api.get('/users/me'))
    try {
      await turn(); expect(drain).toHaveBeenCalledTimes(1); expect(pending.isDone()).toBe(false)
      body.resolve(new ArrayBuffer(4)); const result = await pending.result
      expect(result).toEqual({ ok: true, value: undefined })
    } finally { body.resolve(new ArrayBuffer(4)); await pending.result }
  })

  it('does not report non-JSON success if its unread body disposal fails', async () => {
    const response = new Response('text'), failure = new TypeError('NonJSON stream failed')
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(failure)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(api.get('/users/me')).rejects.toBe(failure)
  })

  it('rechecks the action after non-JSON disposal without returning stale success', async () => {
    seed()
    const action = beginLocalSessionAction('Response owner changed'), body = deferred<ArrayBuffer>(), response = new Response('text')
    vi.spyOn(response, 'arrayBuffer').mockImplementation(() => body.promise); vi.stubGlobal('fetch', vi.fn(async () => response))
    const pending = watch(api.get('/users/me', { assertCurrent: action.assertCurrent }))
    try {
      await turn(); expect(pending.isDone()).toBe(false)
      store(b); body.resolve(new ArrayBuffer(4))
      const result = await pending.result; expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatchObject({ message: 'Response owner changed' })
      expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
    } finally { body.resolve(new ArrayBuffer(4)); await pending.result; action.close() }
  })

  it('retains both the privacy refusal and simultaneous actual disposal failure', async () => {
    seed()
    const action = beginLocalSessionAction('Response owner changed'), headers = deferred<Response>(), response = new Response(null, { status: 204 })
    const failure = new TypeError('Stale response stream failed'), onResponse = vi.fn()
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(failure); vi.stubGlobal('fetch', vi.fn(async () => headers.promise))
    const pending = watch(api.get('/users/me', { assertCurrent: action.assertCurrent, onResponse }))
    try {
      await turn(); store(b); headers.resolve(response)
      const result = await pending.result; expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AggregateError)
        expect(result.error.message).toBe('Response owner changed')
        expect(result.error.errors).toHaveLength(2); expect(result.error.errors[0]).toMatchObject({ message: 'Response owner changed' })
        expect(result.error.errors[1]).toBe(failure); expect(result.error.cause).toBe(result.error.errors[0])
      }
      expect(onResponse).not.toHaveBeenCalled(); expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
    } finally { headers.resolve(response); await pending.result; action.close() }
  })

  it.each([204, 205])('does not repeat a completed null-body read when bodyUsed stays false (%s)', async status => {
    const response = new Response(null, { status }), drain = vi.spyOn(response, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(0))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(api.delete('/users/me/push-subscriptions')).resolves.toBeUndefined()
    expect(response.bodyUsed).toBe(false); expect(drain).toHaveBeenCalledTimes(1)
  })

  it('disposes the response before propagating a metadata callback failure', async () => {
    const response = new Response(null, { status: 204 }), body = deferred<ArrayBuffer>(), primary = new Error('Metadata callback refused')
    const drain = vi.spyOn(response, 'arrayBuffer').mockImplementation(() => body.promise)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const pending = watch(api.get('/users/me', { onResponse: () => { throw primary } }))
    try {
      await turn(); expect(drain).toHaveBeenCalledTimes(1); expect(pending.isDone()).toBe(false)
      body.resolve(new ArrayBuffer(0)); const result = await pending.result
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBe(primary)
    } finally { body.resolve(new ArrayBuffer(0)); await pending.result }
  })

  it('does not dispose a JSON body again after the existing parser has consumed it', async () => {
    const response = json(200, { id: 'me' }), drain = vi.spyOn(response, 'arrayBuffer')
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(api.get('/users/me')).resolves.toEqual({ id: 'me' })
    expect(response.bodyUsed).toBe(true); expect(drain).not.toHaveBeenCalled()
  })

  it('preserves the current refresh refusal as session_expired ApiError with one intentional logout', async () => {
    seed()
    const expired = vi.fn(), stop = onSessionExpired(expired)
    const refused = json(401, { error: { code: 'unauthorized', message: 'Session ended' } })
    const fetcher = vi.fn(async (input: string) => input.endsWith('/auth/refresh') ? refused : json(401, { error: { code: 'token_expired' } }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const result = await watch(api.get('/users/me')).result
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ApiError)
        expect(result.error).toMatchObject({ status: 401, code: 'session_expired', message: 'Сессия истекла — войдите снова' })
      }
      expect(refused.bodyUsed).toBe(true); expect(expired).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledTimes(2); expect(localStorage.getItem('tt_auth')).toBeNull()
    } finally { stop() }
  })

  it('keeps stale refresh privacy and disposal failures together without clearing the new principal', async () => {
    seed()
    const headers = deferred<Response>(), refused = json(401, { error: { code: 'unauthorized' } }), failure = new TypeError('Old refresh stream failed')
    vi.spyOn(refused, 'arrayBuffer').mockRejectedValue(failure)
    const expired = vi.fn(), stop = onSessionExpired(expired)
    const fetcher = vi.fn(async (input: string) => input.endsWith('/auth/refresh') ? headers.promise : json(401, { error: { code: 'token_expired' } }))
    vi.stubGlobal('fetch', fetcher)
    const pending = watch(api.get('/users/me'))
    try {
      await turn(); expect(fetcher).toHaveBeenCalledTimes(2)
      store(b); headers.resolve(refused)
      const result = await pending.result; expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AggregateError)
        expect(result.error.message).toBe('Аккаунт или сессия изменились — повторите действие')
        expect(result.error.errors).toHaveLength(2); expect(result.error.errors[1]).toBe(failure)
        expect(result.error.cause).toBe(result.error.errors[0])
      }
      expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual(b)
      expect(fetcher).toHaveBeenCalledTimes(2); expect(expired).not.toHaveBeenCalled()
    } finally { headers.resolve(refused); await pending.result; stop() }
  })
})
