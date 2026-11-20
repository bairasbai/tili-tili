import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { loadConfig } from '../src/config.js'
import { claimServicePayment, openServiceOrder, servicePlanAccess, settleServiceOrder, type VerifiedPayment } from '../src/service-plans/orders.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const accessSecret = 'a'.repeat(48)
const policyVersion = '2026-09-02'
const adminPath = '/admin/service-plans'
const catalogPath = '/users/me/service-plans'
const operatorId = randomUUID()
const nonStaffId = randomUUID()
const companyOwnerId = randomUUID()

describe('Service price operator configuration', () => {
  it('requires a configured identity and rejects malformed operator IDs', () => {
    expect(loadConfig({}).servicePriceOperatorIds).toEqual([])
    expect(loadConfig({ SERVICE_PRICE_OPERATOR_IDS: operatorId.toUpperCase() }).servicePriceOperatorIds).toEqual([operatorId])
    expect(() => loadConfig({ SERVICE_PRICE_OPERATOR_IDS: 'staff' })).toThrow('SERVICE_PRICE_OPERATOR_IDS')
  })
})

describe.skipIf(!databaseUrl)('WP11 service pricing and orders on PostgreSQL', () => {
  let app: FastifyInstance
  let operator: Record<string, string>
  let unlistedStaff: Record<string, string>
  let nonStaff: Record<string, string>
  let owner: Record<string, string>

  async function user(id: string, staff: boolean) {
    const session = randomUUID()
    await app.db!.query('insert into users(id,phone,name,is_staff) values($1,$2,$3,$4)', [
      id, '+79' + String(randomInt(100000000, 999999999)), 'WP11 test', staff,
    ])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    const headers = { authorization: 'Bearer ' + await signAccessToken(accessSecret, { sub: id, sid: session }) }
    const consent = await app.inject({ method: 'POST', url: '/users/me/consent', headers, payload: { adult: true, policyVersion } })
    expect(consent.statusCode, consent.body).toBe(201)
    return headers
  }

  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: databaseUrl!, redisUrl: null, jwtAccessSecret: accessSecret,
      jwtRefreshSecret: 'b'.repeat(48), policyVersion, servicePriceOperatorIds: [operatorId, nonStaffId] })
    operator = await user(operatorId, true)
    unlistedStaff = await user(randomUUID(), true)
    nonStaff = await user(nonStaffId, false)
    owner = await user(companyOwnerId, false)
  })
  afterAll(async () => { await app?.close() })

  async function priceSnapshot(code: string): Promise<{ expectedVersionId: string | null; expectedActiveVersionId: string | null }> {
    const snapshot = await app.inject({ url: adminPath, headers: operator })
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const plan = snapshot.json().plans.find((item: { code: string }) => item.code === code)
    return { expectedVersionId: plan.latestVersionId, expectedActiveVersionId: plan.activeVersionId }
  }

  it('restricts publication, serializes competing updates, and replaces scheduled prices safely', async () => {
    const wedding = adminPath + '/wedding/prices'
    const offer = { amount: 29900, effectiveAt: null, ...await priceSnapshot('wedding') }
    const submit = (payload: object, headers = operator) => app.inject({ method: 'POST', url: wedding, headers, payload })
    expect((await app.inject({ url: catalogPath })).statusCode).toBe(401)
    expect((await app.inject({ url: adminPath, headers: unlistedStaff })).statusCode).toBe(403)
    expect((await submit(offer, unlistedStaff)).statusCode).toBe(403)
    expect((await submit(offer, nonStaff)).statusCode).toBe(403)
    expect((await submit({ ...offer, amount: 29901 })).statusCode).toBe(422)
    expect((await submit({ ...offer, effectiveAt: '2000-01-01T01:00:00Z' })).statusCode).toBe(422)
    const writes = await Promise.all([submit(offer), submit(offer)])
    expect(writes.map(r => r.statusCode).sort(), writes.map(r => r.body).join('\n')).toEqual([204, 409])
    const active = await app.inject({ url: catalogPath, headers: unlistedStaff })
    const old = active.json().plans.find((p: { code: string }) => p.code === 'wedding')
    expect(old.price.amount).toBe(29900)
    expect(old.checkoutAvailable).toBe(false)
    const first = await submit({ amount: 99000, effectiveAt: '2099-11-20T12:00:00Z', ...await priceSnapshot('wedding') })
    expect(first.statusCode, first.body).toBe(204)
    const admin = (await app.inject({ url: adminPath, headers: operator })).json().plans.find((p: { code: string }) => p.code === 'wedding')
    expect(admin.scheduledVersionId).toBe(admin.latestVersionId)
    expect(admin.activeVersionId).toBe(old.price.id)
    const stale = await submit({ amount: 199000, effectiveAt: null, expectedVersionId: admin.latestVersionId, expectedActiveVersionId: null })
    expect(stale.statusCode, stale.body).toBe(409)
    const replacement = await submit({ amount: 199000, effectiveAt: '2099-11-20T15:00:00Z', ...await priceSnapshot('wedding') })
    expect(replacement.statusCode, replacement.body).toBe(204)
    const result = (await app.inject({ url: adminPath, headers: operator })).json().plans.find((p: { code: string }) => p.code === 'wedding')
    expect(result.history.slice(0, 3).map((v: { amount: number }) => v.amount)).toEqual([199000, 99000, 29900])
    expect(result.scheduledVersionId).not.toBe(admin.scheduledVersionId)
    expect(result.activeVersionId).toBe(old.price.id)
  })

  it('keeps invitations and RSVP available after price publication', async () => {
    const wedding = await app.inject({ method: 'POST', url: '/weddings', headers: owner,
      payload: { partnerName: 'Партнёр', city: { name: 'Уфа', region: 'Башкортостан' } } })
    expect(wedding.statusCode, wedding.body).toBe(201)
    const guests = '/weddings/' + wedding.json().id + '/guests'
    const created = await app.inject({ method: 'POST', url: guests, headers: owner, payload: { name: 'Гость WP11' } })
    expect(created.statusCode, created.body).toBe(201)
    const issued = await app.inject({ method: 'POST', url: guests + '/' + created.json().id + '/invite-link', headers: owner })
    expect(issued.statusCode, issued.body).toBe(200)
    const invite = await app.inject({ url: '/invite/' + String(issued.json().url).split('/').pop() })
    expect(invite.statusCode, invite.body).toBe(200)
    const guest = '/rsvp/' + invite.json().guestToken
    expect((await app.inject({ url: guest })).statusCode).toBe(200)
    const rsvp = await app.inject({ method: 'POST', url: guest, payload: { status: 'no' } })
    expect(rsvp.statusCode, rsvp.body).toBe(200)
    expect((await app.inject({ url: guest })).json().status).toBe('no')
  })

  it('holds the accepted price, processes a payment once, and renews only the scoped cabinet', async () => {
    const plan = 'vendor_month'
    const publication = await app.inject({ method: 'POST', url: adminPath + '/' + plan + '/prices', headers: operator,
      payload: { amount: 19900, effectiveAt: null, ...await priceSnapshot(plan) } })
    expect(publication.statusCode, publication.body).toBe(204)
    const catalog = (await app.inject({ url: catalogPath, headers: owner })).json()
    const oldPrice = catalog.plans.find((p: { code: string }) => p.code === plan).price
    const targetId = randomUUID()
    const db = app.db!
    await db.query("insert into vendors(id,user_id,category_id,name) values($1,$2,'photo','WP11 fixture')", [targetId, companyOwnerId])
    const scope = { code: plan, targetId } as const
    const input = { ...scope, userId: companyOwnerId, priceId: oldPrice.id, provider: 'synthetic',
      terms: { version: 1, text: 'Тестовый месяц доступа и правила возврата' } }
    await expect(openServiceOrder(db, { ...input, userId: nonStaffId })).rejects.toMatchObject({ statusCode: 403 })
    const [first, retry] = await Promise.all([
      openServiceOrder(db, input), openServiceOrder(db, { ...input, targetId: targetId.toUpperCase() }),
    ])
    expect(first.id).toBe(retry.id)
    await claimServicePayment(db, first.id, companyOwnerId)
    const later = await app.inject({ method: 'POST', url: adminPath + '/' + plan + '/prices', headers: operator,
      payload: { amount: 49900, effectiveAt: null, ...await priceSnapshot(plan) } })
    expect(later.statusCode, later.body).toBe(204)
    expect(await servicePlanAccess(db, scope)).toBe(false)
    const paidAt = new Date(Date.now() - 1000)
    const payment = {
      provider: input.provider, orderId: first.id, paymentId: randomUUID(), amount: 19900,
      currency: 'RUB', state: 'paid', paidAt, refundedAmount: 0,
    } satisfies VerifiedPayment
    await expect(settleServiceOrder(db, { ...payment, amount: 49900 })).rejects.toMatchObject({ statusCode: 409 })
    expect(await Promise.all([settleServiceOrder(db, payment), settleServiceOrder(db, payment)])).toEqual(['paid', 'paid'])
    const current = (await db.query<{ access_until: Date }>('select access_until from service_plan_orders where id=$1', [first.id])).rows[0]!
    expect(await servicePlanAccess(db, scope)).toBe(true)
    expect(await servicePlanAccess(db, { ...scope, targetId: randomUUID() })).toBe(false)
    const nextPrice = (await app.inject({ url: catalogPath, headers: owner })).json().plans.find((p: { code: string }) => p.code === plan).price
    const renewal = await openServiceOrder(db, { ...input, priceId: nextPrice.id })
    await claimServicePayment(db, renewal.id, companyOwnerId)
    const second = { ...payment, orderId: renewal.id, paymentId: randomUUID(), amount: 49900 }
    expect(await settleServiceOrder(db, second)).toBe('paid')
    const next = (await db.query<{ access_from: Date }>('select access_from from service_plan_orders where id=$1', [renewal.id])).rows[0]!
    expect(next.access_from).toEqual(current.access_until)
    expect(await settleServiceOrder(db, { ...payment, refundedAmount: 10000 })).toBe('paid')
    expect(await settleServiceOrder(db, { ...payment, state: 'refunded', refundedAmount: payment.amount })).toBe('refunded')
    expect(await servicePlanAccess(db, scope)).toBe(true)
    expect(await settleServiceOrder(db, { ...second, state: 'refunded', refundedAmount: second.amount })).toBe('refunded')
    expect(await settleServiceOrder(db, second)).toBe('refunded')
    expect(await servicePlanAccess(db, scope)).toBe(false)
  })

  it('expires an unopened quote but protects an order sent to the payment provider', async () => {
    const plan = 'vendor_month'
    const db = app.db!
    const vendor = (await db.query<{ id: string }>('select id from vendors where user_id = $1', [companyOwnerId])).rows[0]!
    const { expectedActiveVersionId: priceId } = await priceSnapshot(plan)
    const input = { code: plan, targetId: vendor.id, userId: companyOwnerId, priceId: priceId!, provider: 'synthetic',
      terms: { version: 1, text: 'Тестовый срок оплаты' } } as const
    const first = await openServiceOrder(db, input)
    await db.query(`
      update service_plan_orders set created_at = now() - interval '2 hours', quote_expires_at = now() - interval '1 hour'
      where id = $1`, [first.id])
    await expect(claimServicePayment(db, first.id, companyOwnerId)).rejects.toMatchObject({ statusCode: 409 })
    const second = await openServiceOrder(db, input)
    expect(second.id).not.toBe(first.id)
    await claimServicePayment(db, second.id, companyOwnerId)
    await db.query(`
      update service_plan_orders set created_at = now() - interval '3 hours', quote_expires_at = now() - interval '1 hour',
        provider_requested_at = now() - interval '2 hours' where id = $1`, [second.id])
    const retry = await openServiceOrder(db, input)
    expect(retry.id).toBe(second.id)
  })

  it('starts and checks a wedding order over HTTP using only a test transport', async () => {
    const lookup = new Map<string, VerifiedPayment>()
    const checkout = await buildApp({ env: 'test', databaseUrl: databaseUrl!, redisUrl: null, jwtAccessSecret: accessSecret,
      jwtRefreshSecret: 'b'.repeat(48), policyVersion, servicePriceOperatorIds: [operatorId] }, [], {
      servicePayments: {
        code: 'synthetic_http',
        async ensurePayment(request) {
          const found = lookup.get(request.orderId)
          if (found) return { status: found, confirmationUrl: 'https://example.invalid/checkout' }
          const status: VerifiedPayment = {
            orderId: request.orderId, paymentId: randomUUID(), amount: request.amount,
            provider: 'synthetic_http', currency: 'RUB', state: 'pending', refundedAmount: 0,
          }
          lookup.set(request.orderId, status)
          return { status, confirmationUrl: 'https://example.invalid/checkout' }
        },
        async readPayment(orderId) { return lookup.get(orderId) ?? null },
      },
    })
    try {
      const wedding = await checkout.inject({ method: 'POST', url: '/weddings', headers: operator,
        payload: { partnerName: 'Партнёр', city: { name: 'Уфа', region: 'Башкортостан' } } })
      expect(wedding.statusCode, wedding.body).toBe(201)
      const targetId = wedding.json().id as string
      const { expectedActiveVersionId: priceId } = await priceSnapshot('wedding')
      const published = (await checkout.inject({ url: catalogPath, headers: operator })).json().plans.find((entry: { code: string }) => entry.code === 'wedding')
      const payload = { code: 'wedding', targetId, priceId, termsVersion: 1, termsHash: published.checkoutTerms.hash }
      const start = { method: 'POST', url: '/users/me/service-plan-orders', headers: operator, payload } as const
      expect((await app.inject(start)).statusCode).toBe(501)
      expect((await checkout.inject({ ...start, payload: { ...payload, termsHash: 'a'.repeat(64) } })).statusCode).toBe(409)
      expect((await checkout.inject({ ...start, headers: nonStaff })).statusCode).toBe(403)
      const opened = await checkout.inject(start)
      expect(opened.statusCode, opened.body).toBe(200)
      expect(opened.json().order.state).toBe('pending')
      expect(opened.json().confirmationUrl).toBe('https://example.invalid/checkout')
      const id = opened.json().order.id as string
      const statusUrl = start.url + '/' + id
      const pendingUrl = start.url + '/pending/wedding/' + targetId
      expect((await checkout.inject({ url: pendingUrl, headers: operator })).json().order.id).toBe(id)
      expect((await checkout.inject({ url: pendingUrl, headers: nonStaff })).json().order).toBeNull()
      expect((await checkout.inject({ url: statusUrl, headers: nonStaff })).statusCode).toBe(404)
      expect(await servicePlanAccess(checkout.db!, { code: 'wedding', targetId })).toBe(false)
      lookup.set(id, { ...lookup.get(id)!, state: 'paid', paidAt: new Date(Date.now() - 1000) })
      const status = await checkout.inject({ url: statusUrl, headers: operator })
      expect(status.statusCode, status.body).toBe(200)
      expect(status.json()).toMatchObject({ state: 'paid', amount: 29900, accessUntil: null })
      expect(await servicePlanAccess(checkout.db!, { code: 'wedding', targetId })).toBe(true)
      expect((await checkout.inject(start)).statusCode).toBe(409)

      const contractorId = randomUUID()
      await checkout.db!.query("insert into vendors(id,user_id,category_id,name) values($1,$2,'photo','WP11 HTTP fixture')",
        [contractorId, operatorId])
      const listed = (await checkout.inject({ url: catalogPath, headers: operator })).json().plans
        .find((entry: { code: string }) => entry.code === 'vendor_month')
      const renewalRequest = { code: 'vendor_month', targetId: contractorId, priceId: listed.price.id,
        termsVersion: listed.checkoutTerms.version, termsHash: listed.checkoutTerms.hash }
      const renewal = await checkout.inject({ ...start, payload: renewalRequest })
      expect(renewal.statusCode, renewal.body).toBe(200)
      const renewalId = renewal.json().order.id as string
      const resumeRequest = { ...start, payload: { ...renewalRequest, resumeOrderId: renewalId } }
      await checkout.db!.query('update vendors set user_id = $1 where id = $2', [nonStaffId, contractorId])
      expect((await checkout.inject(resumeRequest)).statusCode).toBe(403)
      await checkout.db!.query('update vendors set user_id = $1 where id = $2', [operatorId, contractorId])
      lookup.set(renewalId, { ...lookup.get(renewalId)!, state: 'paid', paidAt: new Date(Date.now() - 1000) })
      expect((await checkout.inject({ url: start.url + '/' + renewalId, headers: operator })).json().state).toBe('paid')
      const resume = await checkout.inject(resumeRequest)
      expect(resume.statusCode, resume.body).toBe(200)
      expect(resume.json()).toMatchObject({ order: { id: renewalId, state: 'paid' }, confirmationUrl: null })
      const { rows: [orderCount] } = await checkout.db!.query<{ count: string }>(
        'select count(*) from service_plan_orders where target_id = $1', [contractorId],
      )
      expect(orderCount!.count).toBe('1')
    } finally {
      await checkout.close()
    }
  })
})
