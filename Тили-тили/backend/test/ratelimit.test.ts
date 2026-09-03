import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

/**
 * Ограничение частоты на токен — §13.4 и раздел 6 плана.
 *
 * Требование было записано в двух документах и не реализовано нигде.
 * Считается в Redis: счётчик в памяти процесса за балансировщиком означал
 * бы лимит, умноженный на число процессов.
 */
const REDIS = process.env.TEST_REDIS_URL
const live = Boolean(REDIS)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('ограничение частоты', () => {
  let app: FastifyInstance
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: null,
      redisUrl: REDIS ?? null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      rateLimitPerSecond: 3,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  const hit = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/geo/cities?q=Ка', headers, remoteAddress: IP })

  it('поток свыше предела упирается в 429 с Retry-After', async () => {
    const token = `Bearer ${'x'.repeat(40)}-${randomInt(1, 1_000_000)}`
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await hit({ authorization: token })).statusCode)

    // Первые проходят, дальше отказ — и он ВРЕМЕННЫЙ, значит с заголовком:
    // клиент должен знать, что повтор поможет (ERR-0051 про эту разницу).
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0)
    const refused = await hit({ authorization: token })
    expect(refused.statusCode).toBe(429)
    expect(refused.json().error.code).toBe('rate_limited')
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('счёт идёт по токену, а не по адресу', async () => {
    const one = `Bearer ${'a'.repeat(40)}-${randomInt(1, 1_000_000)}`
    const two = `Bearer ${'b'.repeat(40)}-${randomInt(1, 1_000_000)}`
    for (let i = 0; i < 5; i++) await hit({ authorization: one })

    // За одним адресом сидит целый свадебный чат с общим Wi-Fi: сосед
    // не должен получать отказ из-за чужой активности.
    const neighbour = await hit({ authorization: two })
    expect(neighbour.statusCode).not.toBe(429)
  })

  it('проверки здоровья не ограничиваются', async () => {
    const codes: number[] = []
    for (let i = 0; i < 8; i++) {
      codes.push((await app.inject({ method: 'GET', url: '/health', remoteAddress: IP })).statusCode)
    }
    // Их зовёт балансировщик, и отказ ему означает вывод живой машины
    // из ротации.
    expect(codes.every((c) => c === 200)).toBe(true)
  })
})

describe('без Redis ограничителя нет — и это видно', () => {
  it('приложение поднимается и работает', async () => {
    const app = await buildApp({
      env: 'test',
      databaseUrl: null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      rateLimitPerSecond: 1,
    })
    await app.ready()
    try {
      // Счётчик в памяти процесса за балансировщиком был бы ложью:
      // лимит умножился бы на число процессов. Лучше честно без него.
      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
      }
    } finally {
      await app.close()
    }
  })
})
