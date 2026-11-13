import { randomInt, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { loadConfig } from '../src/config.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const accessSecret = 'a'.repeat(48)
const policyVersion = '2026-09-02'
const sample = {
  id: 'synthetic-couple', audience: 'couple', title: 'Пробный каталог',
  price: { amount: 12345, currency: 'RUB' }, periodDays: 30, limits: ['Предел из условий'],
  expiryTerms: 'Чтение и выгрузка', refundTerms: 'Условия из каталога',
}
const path = '/users/me/service-plans'

describe('WP11 service plan catalog configuration', () => {
  it('is empty by default and preserves only catalog fields', () => {
    expect(loadConfig({}).servicePlans).toEqual([])
    const raw = JSON.stringify([{ ...sample, providerKey: 'omitted', price: { ...sample.price, private: 'omitted' } }])
    expect(loadConfig({ SERVICE_PLANS_JSON: raw }).servicePlans).toEqual([sample])
  })

  it.each([
    ['invalid JSON', '{'],
    ['duplicate ids', JSON.stringify([sample, sample])],
    ['unknown audience', JSON.stringify([{ ...sample, audience: 'guest' }])],
    ['fractional minor units', JSON.stringify([{ ...sample, price: { amount: 10.5, currency: 'RUB' } }])],
    ['unsupported currency', JSON.stringify([{ ...sample, price: { amount: 10, currency: 'USD' } }])],
    ['missing period', JSON.stringify([{ ...sample, periodDays: undefined }])],
    ['missing limits', JSON.stringify([{ ...sample, limits: [] }])],
    ['blank expiry terms', JSON.stringify([{ ...sample, expiryTerms: ' ' }])],
    ['missing refund terms', JSON.stringify([{ ...sample, refundTerms: undefined }])],
  ])('rejects %s', (_name, raw) => {
    expect(() => loadConfig({ SERVICE_PLANS_JSON: raw })).toThrow('SERVICE_PLANS_JSON: некорректный каталог тарифов')
  })
})

describe.skipIf(!databaseUrl)('WP11 HTTP catalog and guest access', () => {
  it('serves a read-only catalog with a live consent and leaves guest RSVP available', async () => {
    const plans = loadConfig({ SERVICE_PLANS_JSON: JSON.stringify([sample]) }).servicePlans
    const app = await buildApp({ env: 'test', databaseUrl: databaseUrl!, redisUrl: null,
      jwtAccessSecret: accessSecret, jwtRefreshSecret: 'b'.repeat(48), policyVersion, servicePlans: plans })
    try {
      await app.ready()
      const userId = randomUUID(), sessionId = randomUUID()
      await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',
        [userId, '+79' + String(randomInt(100000000, 999999999)), 'WP11'])
      await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
      const headers = { authorization: 'Bearer ' + await signAccessToken(accessSecret, { sub: userId, sid: sessionId }) }
      expect((await app.inject({ url: path })).statusCode).toBe(401)
      expect((await app.inject({ url: path, headers })).statusCode).toBe(403)
      const consent = await app.inject({ method: 'POST', url: '/users/me/consent', headers, payload: { adult: true, policyVersion } })
      expect(consent.statusCode, consent.body).toBe(201)
      const listed = await app.inject({ url: path, headers })
      expect(listed.statusCode, listed.body).toBe(200)
      expect(listed.headers['cache-control']).toBe('no-store')
      expect(listed.json()).toEqual({ plans: [sample] })

      const wedding = await app.inject({ method: 'POST', url: '/weddings', headers,
        payload: { partnerName: 'Партнёр', city: { name: 'Уфа', region: 'Башкортостан' } } })
      expect(wedding.statusCode, wedding.body).toBe(201)
      const guests = `/weddings/${wedding.json().id}/guests`
      const guest = await app.inject({ method: 'POST', url: guests, headers, payload: { name: 'Гость WP11' } })
      expect(guest.statusCode, guest.body).toBe(201)
      const issued = await app.inject({ method: 'POST', url: `${guests}/${guest.json().id}/invite-link`, headers })
      expect(issued.statusCode, issued.body).toBe(200)
      const redeemed = await app.inject({ url: '/invite/' + (issued.json().url as string).split('/').pop() })
      expect(redeemed.statusCode, redeemed.body).toBe(200)
      const token = redeemed.json().guestToken as string
      expect((await app.inject({ url: path, headers: { authorization: 'Bearer ' + token } })).statusCode).toBe(401)
      const rsvp = await app.inject({ url: '/rsvp/' + token })
      expect(rsvp.statusCode, rsvp.body).toBe(200)
      expect(rsvp.json().guestName).toBe('Гость WP11')
      const decline = await app.inject({ method: 'POST', url: '/rsvp/' + token, payload: { status: 'no' } })
      expect(decline.statusCode, decline.body).toBe(200)
      expect((await app.inject({ url: '/rsvp/' + token })).json().status).toBe('no')
    } finally {
      await app.close()
    }
  })
})
