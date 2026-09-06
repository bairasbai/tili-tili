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
import { api, ApiError } from './client'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a0', refreshToken: 'r0' }))
})
afterEach(() => vi.unstubAllGlobals())

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
