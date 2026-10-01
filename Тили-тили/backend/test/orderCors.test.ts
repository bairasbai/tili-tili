import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

describe('actual API CORS preflight for private order writes', () => {
  let app: FastifyInstance
  const origin = 'https://fixture-app.invalid'
  const path = '/deals/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/order/brief'
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: null, redisUrl: null, corsOrigins: [origin] }, [], { tillyModel: null })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })
  it.each(['PATCH', 'PUT', 'DELETE'])('allows declared %s with auth and retry headers from configured origin', async method => {
    const result = await app.inject({ method: 'OPTIONS', url: path, headers: { origin,
      'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type,idempotency-key' } })
    expect(result.statusCode).toBe(204)
    expect(result.headers['access-control-allow-origin']).toBe(origin)
    expect(String(result.headers['access-control-allow-methods']).split(',').map(s => s.trim())).toContain(method)
    expect(String(result.headers['access-control-allow-headers'])).toContain('idempotency-key')
  })
  it('does not allow an unconfigured origin', async () => {
    const result = await app.inject({ method: 'OPTIONS', url: path, headers: { origin: 'https://untrusted.invalid', 'access-control-request-method': 'PATCH' } })
    expect(result.headers['access-control-allow-origin']).toBeUndefined()
  })
  it('preflight permission never grants private order authority', async () => {
    const result = await app.inject({ method: 'PATCH', url: path, headers: { origin, 'idempotency-key': 'fixture-key' }, payload: { expectedVersion: '1', brief: null } })
    expect(result.statusCode).toBe(401)
    expect(result.body).not.toContain('snapshot')
  })
})
