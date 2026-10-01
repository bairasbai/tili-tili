import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

describe('configured-origin CORS for existing wedding writes', () => {
  let app: FastifyInstance
  const origin = 'https://fixture-app.invalid'
  const path = '/weddings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/guests/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: null, redisUrl: null,
      jwtAccessSecret: 'a'.repeat(48), corsOrigins: [origin] })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })
  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])('declares %s for the configured app origin and actual request headers', async method => {
    const res = await app.inject({ method: 'OPTIONS', url: path, headers: { origin,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type,idempotency-key,if-match' } })
    expect(res.statusCode, res.body).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(origin)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
    expect(String(res.headers['access-control-allow-methods']).split(',').map(s => s.trim())).toContain(method)
    for (const header of ['authorization', 'content-type', 'idempotency-key', 'if-match']) {
      expect(String(res.headers['access-control-allow-headers'])).toContain(header)
    }
  })
  it('does not allow an unconfigured origin', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: path, headers: {
      origin: 'https://untrusted.invalid', 'access-control-request-method': 'PATCH' } })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
  it('does not grant private wedding authority with a successful preflight', async () => {
    const res = await app.inject({ method: 'PATCH', url: path, headers: { origin }, payload: { phone: null } })
    expect(res.statusCode, res.body).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
    expect(res.body).not.toContain('Seating person')
  })
  it('keeps actual timeline-version headers readable by the configured app', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: path, headers: { origin, 'access-control-request-method': 'PUT' } })
    const exposed = String(res.headers['access-control-expose-headers']).toLowerCase().split(',').map(s => s.trim())
    for (const header of ['etag', 'x-timeline-updated-at', 'x-timeline-updated-by']) expect(exposed).toContain(header)
    expect(String(res.headers['access-control-allow-methods'])).not.toMatch(/TRACE|CONNECT/)
  })
  it('does not allow cross-origin requests when no origin is configured', async () => {
    const closed = await buildApp({ env: 'test', databaseUrl: null, redisUrl: null, corsOrigins: [] })
    try {
      const res = await closed.inject({ method: 'OPTIONS', url: path, headers: { origin, 'access-control-request-method': 'PATCH' } })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    } finally { await closed.close() }
  })
})
