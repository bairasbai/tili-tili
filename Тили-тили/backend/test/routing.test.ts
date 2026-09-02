import { describe, it, expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { CONTRACT_OPERATIONS } from '../src/contract/paths.generated.js'
import { ref } from '../src/contract/schemas.generated.js'
import { AppError } from '../src/errors.js'

const TEST_CONFIG = { env: 'test' as const, databaseUrl: null, redisUrl: null, corsOrigins: [] }

/** :weddingId → значение, чтобы маршрут совпал. */
function fill(url: string): string {
  return url
    .split('/')
    .map((seg) => (seg.startsWith(':') ? 'test-id' : seg))
    .join('/')
}

describe('пути контракта и маршрутизатор Fastify', () => {
  it('нет двух путей одинаковой формы с разными именами параметров', () => {
    // Fastify не умеет держать /gifts/:code и /gifts/:guestToken одновременно —
    // при регистрации второго он падает. Ошибка вылезет на старте сервера
    // и будет выглядеть как поломка бэкенда, хотя причина в контракте.
    const byShape = new Map<string, Set<string>>()
    for (const op of CONTRACT_OPERATIONS) {
      const shape = op.url
        .split('/')
        .map((s) => (s.startsWith(':') ? ':' : s))
        .join('/')
      const key = `${op.method} ${shape}`
      if (!byShape.has(key)) byShape.set(key, new Set())
      byShape.get(key)!.add(op.url)
    }
    const conflicts = [...byShape.entries()]
      .filter(([, urls]) => urls.size > 1)
      .map(([key, urls]) => `${key} → ${[...urls].join(' / ')}`)
    expect(conflicts).toEqual([])
  })

  it('имя параметра в пути одно и то же во всём контракте', () => {
    // /rsvp/{guestToken} и /gifts/{code} для одной и той же сущности — это
    // именно та рассинхронизация, которую закрыло решение владельца.
    const names = new Map<string, Set<string>>()
    for (const op of CONTRACT_OPERATIONS) {
      const segs = op.openapi.split('/')
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!
        if (!seg.startsWith('{')) continue
        const prefix = segs.slice(0, i).join('/')
        if (!names.has(prefix)) names.set(prefix, new Set())
        names.get(prefix)!.add(seg)
      }
    }
    const mixed = [...names.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([prefix, set]) => `${prefix}/ → ${[...set].join(' и ')}`)
    expect(mixed).toEqual([])
  })
})

describe('заглушки и реализованные маршруты', () => {
  it('реализованный путь контракта заглушку не получает', async () => {
    // Это главная страховка этапа 1: если отсев не работает, Fastify падает
    // на старте с FST_ERR_DUPLICATED_ROUTE, а не отдаёт 501 поверх обработчика.
    const op = CONTRACT_OPERATIONS.find((o) => o.method === 'GET')!
    const app = await buildApp(TEST_CONFIG, [
      async (instance) => {
        instance.get(op.url, async () => ({ реализовано: true }))
      },
    ])
    await app.ready()

    const res = await app.inject({ method: 'GET', url: fill(op.url) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ реализовано: true })

    // Соседний путь по-прежнему заглушка — отсев точечный, не отключает всё.
    const other = CONTRACT_OPERATIONS.find((o) => o.url !== op.url)!
    const stub = await app.inject({ method: other.method as 'GET', url: fill(other.url) })
    expect(stub.statusCode).toBe(501)

    await app.close()
  })

  it('заглушки ставятся на все методы, а не только на GET', async () => {
    const methods = new Set(CONTRACT_OPERATIONS.map((o) => o.method))
    expect(methods.size).toBeGreaterThan(1)

    const app = await buildApp(TEST_CONFIG)
    await app.ready()
    for (const method of methods) {
      const op = CONTRACT_OPERATIONS.find((o) => o.method === method)!
      const res = await app.inject({ method: method as 'GET', url: fill(op.url) })
      expect(`${method} → ${res.statusCode}`).toBe(`${method} → 501`)
    }
    await app.close()
  })

  it('известный путь с неизвестным методом — 404, а не 501', async () => {
    const app = await buildApp(TEST_CONFIG)
    await app.ready()
    // /health есть только под GET.
    const res = await app.inject({ method: 'DELETE', url: '/health' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('единый формат ошибки через собранное приложение', () => {
  let app: FastifyInstance

  const build = async () =>
    buildApp(TEST_CONFIG, [
      async (instance) => {
        instance.post('/t/money', { schema: { body: ref('Money') } }, async () => ({ ok: true }))
        instance.get('/t/boom', async () => {
          throw new Error('внутренняя поломка с подробностями драйвера')
        })
        instance.get('/t/app-error', async () => {
          throw new AppError(409, 'date_taken', 'Дата уже занята')
        })
      },
    ])

  it('невалидное тело — 422 с перечнем полей', async () => {
    app = await build()
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/t/money', payload: { amount: 'сто' } })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body.error.code).toBe('validation_failed')
    expect(Object.keys(body.error.fields).length).toBeGreaterThan(0)
    await app.close()
  })

  it('валидное тело проходит', async () => {
    app = await build()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/t/money',
      payload: { amount: 8500000, currency: 'RUB' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('внутренняя ошибка — 500 без подробностей наружу, но с номером запроса', async () => {
    app = await build()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/t/boom' })
    expect(res.statusCode).toBe(500)
    const body = res.json()
    expect(body.error.code).toBe('internal')
    // Текст исключения наружу уходить не должен — он в логе.
    expect(body.error.message).not.toContain('драйвера')
    expect(body.error.message).toMatch(/Идентификатор запроса: \S+/)
    await app.close()
  })

  it('AppError отдаётся своим кодом и статусом', async () => {
    app = await build()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/t/app-error' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: { code: 'date_taken', message: 'Дата уже занята' } })
    await app.close()
  })

  it('битый JSON в теле тоже отдаётся единым форматом', async () => {
    app = await build()
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/t/money',
      headers: { 'content-type': 'application/json' },
      payload: '{не json',
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.json().error).toBeDefined()
    expect(typeof res.json().error.code).toBe('string')
    await app.close()
  })
})

describe('CORS', () => {
  it('разрешённый источник получает заголовок', async () => {
    const app = await buildApp({ ...TEST_CONFIG, corsOrigins: ['https://tili-tili.ru'] })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://tili-tili.ru' },
    })
    expect(res.headers['access-control-allow-origin']).toBe('https://tili-tili.ru')
    await app.close()
  })

  it('чужой источник заголовок не получает', async () => {
    const app = await buildApp({ ...TEST_CONFIG, corsOrigins: ['https://tili-tili.ru'] })
    await app.ready()
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://зло.example' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })
})
