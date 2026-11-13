import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { components } from '../src/contract/api.generated.js'

const DB = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'offer-pricing-local-test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
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
    const withoutFormula = await call(pair, 'POST', '/deals/' + deal.id + '/order/price-preview', {
      changes: [{ kind: 'delivery', quantity: '2' }],
    })
    expect(withoutFormula.statusCode, withoutFormula.body).toBe(409)
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

  it('считает по ставке до копейки и хранит неизвестную доплату и точный ноль раздельно', async () => {
    const { path, pair, vendor, offerPath } = await fixture()
    const components: Schema['OfferPriceComponents'] = [
      { kind: 'overtime', status: 'separate', amount: null, formula: { unit: 'hour', quantity: '2.5', rate: money(12505) } },
      { kind: 'transfer', status: 'separate', amount: null, formula: { unit: 'trip', quantity: '0', rate: null } },
      { kind: 'printing', status: 'separate', amount: null, formula: { unit: 'item', quantity: '0', rate: money(30) } },
    ]
    const line = components[0]!
    for (const invalid of [
      { ...line, amount: money(31263) },
      { ...line, status: 'included' },
      { ...line, formula: { ...line.formula, quantity: '2.5001' } },
      { ...line, formula: { ...line.formula, rate: money(Number.MAX_SAFE_INTEGER) } },
    ]) {
      const rejected = await call(vendor, 'POST', offerPath, { ...offerBody, priceComponents: [invalid] }, randomUUID())
      expect(rejected.statusCode, rejected.body).toBe(422)
    }
    const response = await call(vendor, 'POST', offerPath, { ...offerBody, priceComponents: components }, randomUUID())
    expect(response.statusCode, response.body).toBe(201)
    const offer = response.json<Extract<Schema['Offer'], { kind: 'offer' }>>()
    expect(offer.priceBreakdown).toMatchObject({
      knownTotal: money(131263),
      components: [{ ...line, amount: money(31263) }, components[1], { ...components[2], amount: money(0) }],
      unknownKinds: expect.arrayContaining(['transfer']),
    })
    expect(offer.priceBreakdown?.unknownKinds).not.toContain('printing')
    const accepted = await call(pair, 'POST', path + '/offers/' + offer.id + '/accept', undefined, randomUUID())
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json<Schema['Slot']>().deal).toMatchObject({ price: offerBody.price, priceBreakdown: offer.priceBreakdown })
  })

  it('сравнивает расчётные позиции принятой брони для обеих сторон без записи денег или условий', async () => {
    const { path, pair, vendor, helper, offerPath } = await fixture()
    const outsider = await user('Чужой исполнитель FR015')
    const priceComponents: Schema['OfferPriceComponents'] = [
      { kind: 'overtime', status: 'separate', amount: null, formula: { unit: 'hour', quantity: '2.5', rate: money(12505) } },
      { kind: 'transfer', status: 'separate', amount: null, formula: { unit: 'trip', quantity: null, rate: money(1000) } },
      { kind: 'printing', status: 'separate', amount: null, formula: { unit: 'person', quantity: '2', rate: money(2000) } },
      { kind: 'lighting', status: 'separate', amount: null, formula: { unit: 'item', quantity: '0', rate: money(Number.MAX_SAFE_INTEGER) } },
      { kind: 'delivery', status: 'included', amount: null },
    ]
    const sent = await call(vendor, 'POST', offerPath, { ...offerBody, priceComponents }, randomUUID())
    expect(sent.statusCode, sent.body).toBe(201)
    const offer = sent.json<Extract<Schema['Offer'], { kind: 'offer' }>>()
    const accepted = await call(pair, 'POST', path + '/offers/' + offer.id + '/accept', undefined, randomUUID())
    expect(accepted.statusCode, accepted.body).toBe(200)
    const deal = accepted.json<Schema['Slot']>().deal!
    const url = '/deals/' + deal.id + '/order/price-preview'
    const snapshot = async () => (await app.db!.query(`select d.price::text, d.state, o.agreed_terms_id, o.proposed_terms_id, p.components,
      (select count(*)::text from payments where deal_id=d.id) as payments,
      (select count(*)::text from deal_terms_versions where deal_id=d.id) as terms,
      (select count(*)::text from deal_events where deal_id=d.id) as journal,
      (select count(*)::text from audit_log where entity_id=d.id) as audit
      from deals d join deal_orders o on o.deal_id=d.id join offer_price_breakdowns p on p.deal_id=d.id where d.id=$1`, [deal.id])).rows[0]
    const before = await snapshot()
    expect(before).toMatchObject({ price: '100000', components: offer.priceBreakdown?.components })
    const changes = [{ kind: 'overtime', quantity: '1.5' }, { kind: 'printing', quantity: '0' }]
    const pairResponse = await call(pair, 'POST', url, { changes })
    expect(pairResponse.statusCode, pairResponse.body).toBe(200)
    expect(pairResponse.headers['cache-control']).toBe('no-store')
    const preview = pairResponse.json<Schema['OrderPriceChangePreview']>()
    expect(preview.current).toEqual(offer.priceBreakdown)
    expect(preview.current.knownTotal).toEqual(money(135263))
    expect(preview.proposed.knownTotal).toEqual(money(118758))
    expect(preview.difference).toEqual(money(-16505))
    expect(preview.proposed.components.find(line => line.kind === 'printing')).toMatchObject({ amount: money(0) })
    const vendorResponse = await call(vendor, 'POST', url, { changes })
    expect(vendorResponse.statusCode, vendorResponse.body).toBe(200)
    expect(vendorResponse.json()).toEqual(preview)
    for (const actor of [helper, outsider]) {
      const denied = await call(actor, 'POST', url, { changes })
      expect(denied.statusCode, denied.body).toBe(404)
    }
    const unknown = await call(pair, 'POST', url, { changes: [{ kind: 'transfer', quantity: '2' }] })
    expect(unknown.statusCode, unknown.body).toBe(200)
    const partial = unknown.json<Schema['OrderPriceChangePreview']>()
    expect(partial.difference).toBeNull()
    expect(partial.proposed.knownTotal).toEqual(money(137263))
    expect(partial.proposed.unknownKinds).not.toContain('transfer')
    const zero = await call(pair, 'POST', url, { changes: [{ kind: 'overtime', quantity: '2.500' }] })
    expect(zero.statusCode, zero.body).toBe(200)
    expect(zero.json().difference).toEqual(money(0))
    for (const invalid of [
      { changes: [...changes, changes[0]] },
      { changes: [{ kind: 'delivery', quantity: '1' }] },
      { changes: [{ kind: 'lighting', quantity: '1' }] },
      { changes: [{ kind: 'lighting', quantity: '2' }] },
    ]) {
      const response = await call(pair, 'POST', url, invalid)
      expect(response.statusCode, response.body).toBe(422)
    }
    expect(await snapshot()).toEqual(before)
  })

  it('применяет отдельную финансовую редакцию один раз и сохраняет оплаты и исходное предложение', async () => {
    const { path, pair, vendor, helper, offerPath } = await fixture()
    const sent = await call(vendor, 'POST', offerPath, { ...offerBody, priceComponents: [
      { kind: 'overtime', status: 'separate', amount: null, formula: { unit: 'hour', quantity: '2.5', rate: money(12505) } },
    ] }, randomUUID())
    expect(sent.statusCode, sent.body).toBe(201)
    const offer = sent.json<Extract<Schema['Offer'], { kind: 'offer' }>>()
    const accepted = await call(pair, 'POST', path + '/offers/' + offer.id + '/accept', undefined, randomUUID())
    expect(accepted.statusCode, accepted.body).toBe(200)
    const deal = accepted.json<Schema['Slot']>().deal!
    const orderPath = '/deals/' + deal.id + '/order', termsPath = orderPath + '/terms'
    const price = async () => (await app.db!.query('select price::text from deals where id=$1', [deal.id])).rows[0].price
    async function review(actor: Actor) {
      const response = await call(actor, 'GET', termsPath)
      expect(response.statusCode, response.body).toBe(200)
      const terms = response.json<Schema['OrderTermsView']>()
      expect(terms.readToken).toBeTruthy()
      return { url: termsPath + '/' + terms.selected!.id + '/accept', terms,
        body: { expectedTermsVersion: terms.selected!.version, digest: terms.selected!.digest, readToken: terms.readToken } }
    }
    async function agree(actor: Actor) {
      const reviewed = await review(actor)
      const response = await call(actor, 'POST', reviewed.url, reviewed.body, randomUUID())
      expect(response.statusCode, response.body).toBe(200)
      return response.json<Schema['OrderTermsView']>()
    }
    const order = (await call(pair, 'GET', orderPath)).json<Schema['WeddingOrder']>()
    const ordinary = await call(pair, 'POST', termsPath + '/proposals', {
      expectedOrderVersion: order.version, expectedTermsRevision: '0',
    }, randomUUID())
    expect(ordinary.statusCode, ordinary.body).toBe(200)
    await agree(pair)
    const original = await agree(vendor)
    const quote = async (quantity: string) => {
      const changes = [{ kind: 'overtime', quantity }]
      const response = await call(pair, 'POST', orderPath + '/price-preview', { changes })
      expect(response.statusCode, response.body).toBe(200)
      const preview = response.json<Schema['OrderPriceChangePreview']>()
      const amendment = preview.amendment!
      expect(amendment).toBeTruthy()
      return { preview, body: {
        expectedAgreementId: amendment.agreementId, expectedOrderVersion: amendment.orderVersion,
        expectedTermsRevision: amendment.termsRevision, expectedAmount: amendment.proposedPrice.amount, changes,
      } }
    }
    const first = await quote('3.5')
    expect(first.preview.amendment).toMatchObject({ currentPrice: money(100000), proposedPrice: money(112505) })
    const proposalPath = termsPath + '/price-proposals'
    expect((await call(helper, 'POST', proposalPath, first.body, randomUUID())).statusCode).toBe(404)
    const badAmount = await call(pair, 'POST', proposalPath, { ...first.body, expectedAmount: 112504 }, randomUUID())
    expect(badAmount.statusCode, badAmount.body).toBe(409)
    const proposed = await call(vendor, 'POST', proposalPath, first.body, randomUUID())
    expect(proposed.statusCode, proposed.body).toBe(200)
    expect(proposed.json().selected).toMatchObject({
      freshness: 'current', receipts: [], snapshot: {
        economics: { amount: '112505' }, priceAmendment: { agreementId: original.agreedTermsId,
          previousPrice: money(100000), difference: money(12505), changes: [
            { kind: 'overtime', unit: 'hour', previousQuantity: '2.5', quantity: '3.5', rate: money(12505) },
          ] },
      },
    })
    expect(await price()).toBe('100000')
    const firstSide = await agree(vendor)
    expect(firstSide.agreedTermsId).toBe(original.agreedTermsId)
    expect(await price()).toBe('100000')
    const final = await review(pair)
    const key = randomUUID()
    const replies = await Promise.all([
      call(pair, 'POST', final.url, final.body, key),
      call(pair, 'POST', final.url, final.body, key),
    ])
    for (const reply of replies) {
      expect(reply.statusCode, reply.body).toBe(200)
      expect(reply.json().agreedTermsId).toBe(final.terms.selected?.id)
      expect(reply.json().selected).toMatchObject({ freshness: 'current', receipts: expect.arrayContaining([
        expect.objectContaining({ party: 'performer' }), expect.objectContaining({ party: 'customer' }),
      ]) })
    }
    expect(await price()).toBe('112505')
    const schedulePath = path + '/payment-schedule'
    const nextYear = new Date().getUTCFullYear() + 1
    const schedule = async () => {
      const response = await call(pair, 'GET', schedulePath + `?from=${nextYear}-01-01&to=${nextYear}-12-31`)
      expect(response.statusCode, response.body).toBe(200)
      return response.json<Schema['PaymentSchedule']>()
    }
    const scheduled = await call(pair, 'POST', schedulePath,
      { dealId: deal.id, title: 'Финальный платёж', due: `${nextYear}-06-01`, amount: money(110000) }, randomUUID())
    expect(scheduled.statusCode, scheduled.body).toBe(201)
    const stage = scheduled.json<Schema['PaymentInstallment']>()
    const second = await quote('2.5')
    expect(second.preview.current.components.find(line => line.kind === 'overtime')?.formula?.quantity).toBe('3.5')
    expect(second.preview.amendment).toMatchObject({ currentPrice: money(112505), proposedPrice: money(100000) })
    const unchanged = (await app.db!.query('select components from offer_price_breakdowns where deal_id=$1', [deal.id])).rows[0]
    expect(unchanged.components).toEqual(offer.priceBreakdown?.components)
    const nextProposal = await call(pair, 'POST', proposalPath, second.body, randomUUID())
    expect(nextProposal.statusCode, nextProposal.body).toBe(200)
    await agree(pair)
    const secondReview = await review(vendor)
    const pay = randomUUID()
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',110000,'recorded','cash','private')", [pay, deal.id])
    const declined = await call(vendor, 'POST', secondReview.url, secondReview.body, randomUUID())
    expect(declined.statusCode, declined.body).toBe(409)
    expect(declined.json().error.code).toBe('price_amendment_payment_review')
    expect(await price()).toBe('112505')
    const records = await app.db!.query("select amount::text from payments where id=$1", [pay])
    expect(records.rows).toEqual([{ amount: '110000' }])
    const counts = await app.db!.query("select count(*)::int as n from deal_events where deal_id=$1 and kind='price'", [deal.id])
    expect(counts.rows).toEqual([{ n: 1 }])
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'refund',20000,'recorded','cash','private')",
      [randomUUID(), deal.id])
    const beforeDecrease = await schedule()
    expect(beforeDecrease.deals.find(entry => entry.id === deal.id)).toMatchObject({
      price: money(112505), recorded: money(90000), needsReview: false,
    })
    const applied = await agree(vendor)
    expect(applied.agreedTermsId).toBe(secondReview.terms.selected?.id)
    expect(applied.history.find(entry => entry.id === original.agreedTermsId)?.receipts).toHaveLength(2)
    expect(await price()).toBe('100000')
    const afterDecrease = await schedule()
    expect(afterDecrease.deals.find(entry => entry.id === deal.id)).toMatchObject({
      price: money(100000), recorded: money(90000), needsReview: true,
    })
    expect(afterDecrease.items.find(item => item.id === stage.id)).toMatchObject({
      amount: stage.amount, due: stage.due, version: stage.version + 1,
    })
    const increase = await quote('4.5')
    expect(increase.preview.amendment?.proposedPrice).toEqual(money(125010))
    const newProposal = await call(pair, 'POST', proposalPath, increase.body, randomUUID())
    expect(newProposal.statusCode, newProposal.body).toBe(200)
    await agree(pair)
    const reviewIncrease = await review(vendor)
    await app.db!.query(`insert into payments(id,deal_id,kind,amount,amount_known,status,payment_method,visibility)
      values($1,$2,'balance',null,false,'recorded','cash','private')`, [randomUUID(), deal.id])
    const unknown = await call(vendor, 'POST', reviewIncrease.url, reviewIncrease.body, randomUUID())
    expect(unknown.statusCode, unknown.body).toBe(409)
    expect(unknown.json().error.code).toBe('price_amendment_payment_review')
    await app.db!.query('update sessions set revoked_at=clock_timestamp() where user_id=$1', [pair.id])
    const revoked = await call(vendor, 'POST', reviewIncrease.url, reviewIncrease.body, randomUUID())
    expect(revoked.statusCode, revoked.body).toBe(409)
    expect(revoked.json().error.code).toBe('price_amendment_source_changed')
    expect(await price()).toBe('100000')
  })
})
