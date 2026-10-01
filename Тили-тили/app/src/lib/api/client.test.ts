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
import { api, ApiError, url } from './client'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a0', refreshToken: 'r0' }))
})
afterEach(() => vi.unstubAllGlobals())

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
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        seen.push(`${init?.method} ${input} ${headers.authorization ?? ''}`)
        if (input.endsWith('/auth/refresh')) {
          // Другая вкладка обменяла токен первой и сохранила новую пару.
          localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a1', refreshToken: 'r1' }))
          return json(401, { error: { code: 'refresh_superseded', message: 'уже обменян' } })
        }
        if (headers.authorization === 'Bearer a1') return json(200, { id: 'me' })
        return json(401, { error: { code: 'unauthorized', message: 'истёк' } })
      }),
    )

    const me = await api.get('/users/me')
    expect(me).toEqual({ id: 'me' })
    expect(seen).toEqual(['GET /api/users/me Bearer a0', 'POST /api/auth/refresh ', 'GET /api/users/me Bearer a1'])
    // Хранилище не стёрто: там пара второй вкладки.
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual({ accessToken: 'a1', refreshToken: 'r1' })
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
