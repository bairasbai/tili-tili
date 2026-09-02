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

  it('в контракте нет дублей метод+путь', () => {
    const keys = CONTRACT_OPERATIONS.map((o) => `${o.method} ${o.url}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
