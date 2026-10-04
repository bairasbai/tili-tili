import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import Fastify from 'fastify'
import { CONTRACT_SCHEMAS, ref, type ContractSchemaName } from '../src/contract/schemas.generated.js'
import { readSchemas, render, toJsonSchema, OUT_FILE } from '../scripts/gen-schemas.mjs'

const NAMES = Object.keys(CONTRACT_SCHEMAS.definitions) as ContractSchemaName[]

describe('схемы контракта', () => {
  it('все схемы компилируются валидатором', async () => {
    // Fastify компилирует схемы маршрутов на ready(). Если конвертация из
    // OpenAPI оставила что-то, чего AJV не понимает, это вылезет здесь,
    // а не на первом запросе в проде.
    const app = Fastify({ logger: false })
    app.addSchema(CONTRACT_SCHEMAS)
    for (const name of NAMES) {
      app.post(`/t/${name}`, { schema: { body: ref(name) } }, async () => ({ ok: true }))
    }
    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })

  it('ShortlistEntry принимает обезличенный tombstone, но не пропавшие поля', async () => {
    const app = Fastify({ logger: false })
    app.addSchema(CONTRACT_SCHEMAS)
    app.post('/shortlist', { schema: { body: ref('ShortlistEntry') } }, async () => ({ ok: true }))
    await app.ready()

    const tombstone = {
      id: '11111111-1111-4111-8111-111111111111',
      slotId: '22222222-2222-4222-8222-222222222222',
      position: 2,
      createdAt: '2026-09-27T01:00:00.000Z',
      available: null,
      occupancy: null,
      availabilityObservation: null,
      vendor: null,
    }
    expect((await app.inject({ method: 'POST', url: '/shortlist', payload: tombstone })).statusCode).toBe(200)
    const missingVendor: Omit<typeof tombstone, 'vendor'> & { vendor?: null } = { ...tombstone }
    delete missingVendor.vendor
    expect((await app.inject({ method: 'POST', url: '/shortlist', payload: missingVendor })).statusCode).toBe(400)
    const missingObservation: Omit<typeof tombstone, 'availabilityObservation'> & { availabilityObservation?: null } = { ...tombstone }
    delete missingObservation.availabilityObservation
    expect((await app.inject({ method: 'POST', url: '/shortlist', payload: missingObservation })).statusCode).toBe(400)
    await app.close()
  })

  it('валидация действительно отвергает мусор', async () => {
    const app = Fastify({ logger: false })
    app.addSchema(CONTRACT_SCHEMAS)
    app.post('/money', { schema: { body: ref('Money') } }, async () => ({ ok: true }))
    await app.ready()

    const good = await app.inject({ method: 'POST', url: '/money', payload: { amount: 8500000, currency: 'RUB' } })
    expect(good.statusCode).toBe(200)

    // Деньги — целые копейки. Строка и дробь должны отлетать.
    const bad = await app.inject({ method: 'POST', url: '/money', payload: { amount: 'сто', currency: 'RUB' } })
    expect(bad.statusCode).toBe(400)

    const noCurrency = await app.inject({ method: 'POST', url: '/money', payload: { amount: 1 } })
    expect(noCurrency.statusCode).toBe(400)

    await app.close()
  })
})

describe('конвертация OpenAPI → JSON Schema', () => {
  it('nullable превращается в тип с null', () => {
    expect(toJsonSchema({ type: 'string', nullable: true })).toEqual({ type: ['string', 'null'] })
  })

  it('nullable рядом с $ref разворачивается в anyOf', () => {
    expect(toJsonSchema({ $ref: '#/components/schemas/Deal', nullable: true })).toEqual({
      anyOf: [{ $ref: 'contract#/definitions/Deal' }, { type: 'null' }],
    })
  })

  it('ссылки переписаны на идентификатор документа', () => {
    expect(toJsonSchema({ $ref: '#/components/schemas/Money' })).toEqual({
      $ref: 'contract#/definitions/Money',
    })
  })

  it('example выбрасывается — AJV его не знает', () => {
    expect(toJsonSchema({ type: 'string', example: 'x' })).toEqual({ type: 'string' })
  })

  it('файл на диске совпадает с генератором', () => {
    const actual = fs.readFileSync(OUT_FILE, 'utf8').split('\r\n').join('\n')
    expect(actual).toBe(render(readSchemas()))
  })
})
