import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { components } from '../src/contract/api.generated.js'

const DB = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'a'.repeat(48)
type Actor = { id: string; token: string }
type Schema = components['schemas']
const money = (amount: number) => ({ amount, currency: 'RUB' as const })
const offerBody = { kind: 'offer', title: 'Съёмка FR013', includes: ['Репортаж'], price: money(100000) }

describe.skipIf(!DB)('FR013: составляющие цены предложения', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => {
    try {
      await app?.db?.query('delete from weddings where id=any($1::uuid[])', [weddings])
      await app?.db?.query('delete from users where id=any($1::uuid[])', [users])
    } finally { await app?.close() }
  })
  async function user(name: string): Promise<Actor> {
    const id = randomUUID(), sid = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`, name])
    users.push(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  function call(actor: Actor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, key?: string) {
    return app.inject({ method, url, payload, headers: {
      authorization: `Bearer ${actor.token}`, ...(key ? { 'idempotency-key': key } : {}),
    } })
  }
  async function fixture() {
    const [pair, helper, vendor] = await Promise.all(['Пара FR013', 'Помощник FR013', 'Исполнитель FR013'].map(user))
    const city = { name: 'Уфа', region: 'Башкортостан' }
    const wedding = await call(pair, 'POST', '/weddings', {
      partnerName: 'Тест цены', city, date: `${new Date().getUTCFullYear() + 1}-06-24`,
    })
    expect(wedding.statusCode, wedding.body).toBe(201)
    const weddingId = wedding.json<{ id: string }>().id
    weddings.push(weddingId)
    const path = '/weddings/' + weddingId
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [weddingId, helper.id])
    const profile = await call(vendor, 'PUT', '/vendor/profile', { name: 'Фотограф FR013', categoryId: 'photo', city, priceFrom: money(100000) })
    expect(profile.statusCode, profile.body).toBe(200)
    expect((await call(vendor, 'POST', '/vendor/profile/publish')).statusCode).toBe(200)
    const added = await call(pair, 'PUT', path + '/shortlist/' + profile.json<{ id: string }>().id)
    expect(added.statusCode, added.body).toBe(200)
    const { id: entryId, slotId } = added.json<{ id: string; slotId: string }>()
    const requested = await call(pair, 'POST', path + '/slots/' + slotId + '/offer-requests', { entryIds: [entryId] }, randomUUID())
    expect(requested.statusCode, requested.body).toBe(201)
    const requestId = requested.json<{ results: { requestId: string }[] }>().results[0]!.requestId
    return { path, pair, helper, vendor, slotId, offerPath: '/vendor/offer-requests/' + requestId + '/offers' }
  }

  it('суммирует известные доплаты и сохраняет снимок принятой версии отдельно от цены договора', async () => {
    const { path, pair, helper, vendor, slotId, offerPath } = await fixture()
    const legacy = await call(vendor, 'POST', offerPath, offerBody, randomUUID())
    expect(legacy.statusCode, legacy.body).toBe(201)
    expect(legacy.json()).not.toHaveProperty('priceBreakdown')
    const lineItems: Schema['OfferPriceComponents'] = [
      { kind: 'packaging', status: 'separate', amount: null },
      { kind: 'delivery', status: 'separate', amount: money(12505) },
      { kind: 'overtime', status: 'unknown', amount: null },
      { kind: 'setup', status: 'included', amount: null },
      { kind: 'teardown', status: 'not_required', amount: null },
      { kind: 'printing', status: 'separate', amount: money(0) },
    ]
    const updated = await call(vendor, 'POST', offerPath, { ...offerBody, priceComponents: lineItems }, randomUUID())
    expect(updated.statusCode, updated.body).toBe(201)
    const saved = updated.json<Extract<Schema['Offer'], { kind: 'offer' }>>()
    const breakdown = saved.priceBreakdown!
    expect(breakdown.knownTotal).toEqual(money(112505))
    expect(breakdown.quotedPrice).toEqual(offerBody.price)
    expect(breakdown.unknownKinds).toEqual(expect.arrayContaining(['packaging', 'overtime', 'transfer']))
    expect(breakdown.unknownKinds).not.toContain('printing')
    expect(breakdown.components).toHaveLength(lineItems.length)

    const shortlist = path + '/slots/' + slotId + '/shortlist'
    const byPair = await call(pair, 'GET', shortlist)
    expect(byPair.statusCode, byPair.body).toBe(200)
    expect(byPair.json()).toEqual([expect.objectContaining({ request: expect.objectContaining({
      offer: expect.objectContaining({ id: saved.id, priceBreakdown: breakdown }),
    }) })])
    const byHelper = await call(helper, 'GET', shortlist)
    expect(byHelper.statusCode, byHelper.body).toBe(200)
    expect(byHelper.json()[0].request).toEqual({ status: 'responded' })
    const cabinet = await call(vendor, 'GET', '/vendor/offer-requests')
    expect(cabinet.json()[0].offer.priceBreakdown).toEqual(breakdown)
    const obsolete = await call(pair, 'POST', path + '/offers/' + legacy.json().id + '/accept', undefined, randomUUID())
    expect(obsolete.json().error.code).toBe('offer_superseded')

    const acceptPath = path + '/offers/' + saved.id + '/accept', acceptKey = randomUUID()
    const accepted = await call(pair, 'POST', acceptPath, undefined, acceptKey)
    expect(accepted.statusCode, accepted.body).toBe(200)
    const deal = accepted.json<Schema['Slot']>().deal!
    expect(deal).toMatchObject({ price: offerBody.price, priceBreakdown: breakdown })
    expect((await call(pair, 'POST', acceptPath, undefined, acceptKey)).json().deal.priceBreakdown).toEqual(breakdown)
    const helperSlot = (await call(helper, 'GET', path + '/slots')).json<Schema['Slot'][]>().find(slot => slot.id === slotId)!
    expect(helperSlot.deal).not.toHaveProperty('priceBreakdown')
    expect((await call(vendor, 'GET', '/vendor/deals')).json().items[0].priceBreakdown).toEqual(breakdown)
    await app.db!.query('delete from offers where id=$1', [saved.id])
    const stored = (await call(pair, 'GET', path + '/slots')).json<Schema['Slot'][]>().find(slot => slot.id === slotId)!
    expect(stored.deal).toMatchObject({ id: deal.id, price: offerBody.price, priceBreakdown: breakdown })
  })

  it('отклоняет дубль, скрытую сумму, переполнение и разбивку при отказе до записи версии', async () => {
    const { vendor, offerPath } = await fixture()
    const line = { kind: 'delivery', status: 'separate', amount: money(1) }
    for (const body of [
      { ...offerBody, priceComponents: [line, { ...line, status: 'unknown', amount: null }] },
      { ...offerBody, priceComponents: [{ ...line, status: 'included' }] },
      { ...offerBody, price: money(Number.MAX_SAFE_INTEGER), priceComponents: [line] },
      { kind: 'decline', message: 'Не могу', priceComponents: [line] },
    ]) {
      const response = await call(vendor, 'POST', offerPath, body, randomUUID())
      expect(response.statusCode, response.body).toBe(422)
    }
    expect((await call(vendor, 'GET', '/vendor/offer-requests')).json()[0]).not.toHaveProperty('offer')
  })
})
