import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { CONTRACT_OPERATIONS } from '../src/contract/paths.generated.js'

/**
 * Главный гейт этапа 0: каждый путь контракта должен быть узнан сервером.
 *
 * 404 здесь означает, что контракт вырос, а сервер об этом не знает — ровно тот
 * разрыв, из-за которого фронт неделю чинит несуществующую опечатку.
 */
let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp({ env: 'test', databaseUrl: null, redisUrl: null, corsOrigins: [] })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

/** :weddingId → тестовое значение, чтобы маршрут совпал. */
function fill(url: string): string {
  return url
    .split('/')
    .map((seg) => (seg.startsWith(':') ? 'test-id' : seg))
    .join('/')
}

describe('контракт', () => {
  it('в контракте есть операции', () => {
    expect(CONTRACT_OPERATIONS.length).toBeGreaterThan(0)
  })

  it('ни один путь контракта не отвечает 404', async () => {
    const missing: string[] = []
    for (const op of CONTRACT_OPERATIONS) {
      const res = await app.inject({ method: op.method as 'GET', url: fill(op.url) })
      if (res.statusCode === 404) missing.push(`${op.method} ${op.openapi}`)
    }
    expect(missing).toEqual([])
  })

  it('нереализованные пути отвечают 501 с единым форматом ошибки', async () => {
    const op = CONTRACT_OPERATIONS[0]!
    const res = await app.inject({ method: op.method as 'GET', url: fill(op.url) })
    expect(res.statusCode).toBe(501)
    const body = res.json()
    expect(body.error.code).toBe('not_implemented')
    expect(typeof body.error.message).toBe('string')
  })

  it('несуществующий адрес отвечает 404, а не 501', async () => {
    const res = await app.inject({ method: 'GET', url: '/такого-пути-нет' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('пути этапа 1 больше не заглушки', async () => {
    // Список ведётся руками намеренно: он показывает, что этап действительно
    // сдан, и падает, если регистрация маршрутов сломается при следующей правке.
    const done = [
      'POST /auth/otp',
      'POST /auth/otp/verify',
      'POST /auth/refresh',
      'GET /users/me',
      'PATCH /users/me',
      'DELETE /users/me',
      'POST /users/me/consent',
      'DELETE /users/me/consent',
      'GET /users/me/sessions',
      'DELETE /users/me/sessions',
      'DELETE /users/me/sessions/:sessionId',
      'GET /users/me/export',
      'GET /geo/cities',
      'GET /geo/nearest',
      'GET /weddings',
      'POST /weddings',
      'GET /weddings/:weddingId',
      'PATCH /weddings/:weddingId',
      'GET /weddings/:weddingId/members',
      'PATCH /weddings/:weddingId/members/:userId',
      'DELETE /weddings/:weddingId/members/:userId',
      'GET /weddings/:weddingId/invites',
      'POST /weddings/:weddingId/invites',
      'GET /invites/:code',
      'DELETE /invites/:code',
      'POST /invites/:code/accept',
      'GET /users/me/referral',
      'POST /referral/:code/apply',
    ]
    const stillStub: string[] = []
    for (const key of done) {
      const [method, url] = key.split(' ') as [string, string]
      const res = await app.inject({ method: method as 'GET', url: fill(url) })
      if (res.statusCode === 501) stillStub.push(key)
    }
    expect(stillStub).toEqual([])
  })

  it('OAuth отложен явно: 501, но со своей причиной, а не общей заглушкой', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/oauth/vk' })
    expect(res.statusCode).toBe(501)
    // Не not_implemented: путь не «забыт», а ждёт приложений провайдеров.
    expect(res.json().error.code).toBe('oauth_not_configured')
  })

  it('заглушек остаётся ровно столько, сколько работы впереди', async () => {
    let stub = 0
    for (const op of CONTRACT_OPERATIONS) {
      const res = await app.inject({ method: op.method as 'GET', url: fill(op.url) })
      if (res.statusCode === 501 && res.json().error.code === 'not_implemented') stub++
    }
    // Число падает с каждым этапом. Если оно выросло — что-то отвалилось.
    expect(stub).toBeLessThanOrEqual(CONTRACT_OPERATIONS.length - 28)
  })

  it('в контракте нет дублей метод+путь', () => {
    const keys = CONTRACT_OPERATIONS.map((o) => `${o.method} ${o.url}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
