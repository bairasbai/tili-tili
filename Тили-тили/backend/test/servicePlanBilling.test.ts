import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { loadConfig } from '../src/config.js'
import { requiresWeddingPlan } from '../src/service-plans/access.js'
import { seedUntrackedSlotDeal } from './helpers/dayFixture.js'
import { MANUAL_PROVIDER, claimServicePayment, openServiceOrder, servicePlanAccess, settleServiceOrder, type VerifiedPayment } from '../src/service-plans/orders.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const accessSecret = 'a'.repeat(48)
const policyVersion = '2026-09-02'
const adminPath = '/admin/service-plans'
const catalogPath = '/users/me/service-plan-offers'
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

  it('reviews Sber transfers with and without a receipt copy, atomically and once', async () => {
    const buyerId = randomUUID()
    const buyer = await user(buyerId, false)
    const config = {
      env: 'test' as const, databaseUrl: databaseUrl!, redisUrl: null,
      jwtAccessSecret: accessSecret, jwtRefreshSecret: 'b'.repeat(48), policyVersion,
      servicePriceOperatorIds: [operatorId, nonStaffId],
      servicePlanManualCheckoutEnabled: true,
      servicePlanManualTransfer: {
        url: 'https://www.sberbank.com/sms/pbpn?requisiteNumber=79990000000',
        qrJpegBase64: '/9gg/9k=',
      },
    }
    const checkout = await buildApp(config)
    try {
      const db = checkout.db!
      const orderPath = '/users/me/service-plan-orders'
      const reviewPath = adminPath + '/manual-orders'
      const catalog = (await checkout.inject({ url: catalogPath, headers: buyer })).json()
      expect(catalog.manualCheckoutAvailable).toBe(true)
      expect(catalog.manualTransfer).toBeUndefined()
      const create = async (code: 'wedding' | 'vendor_month', targetId: string, saveReceiptCopy: boolean) => {
        const plan = catalog.plans.find((entry: { code: string }) => entry.code === code)
        const response = await checkout.inject({
          method: 'POST', url: orderPath, headers: buyer,
          payload: {
            code, targetId, priceId: plan.price.id, termsVersion: plan.checkoutTerms.version,
            termsHash: plan.checkoutTerms.hash, manual: { saveReceiptCopy, receiptEmail: 'buyer@example.invalid' },
          },
        })
        expect(response.statusCode, response.body).toBe(200)
        return response.json().order
      }
      const wedding = await checkout.inject({ method: 'POST', url: '/weddings', headers: buyer,
        payload: { partnerName: 'Партнёр', city: { name: 'Уфа', region: 'Башкортостан' } } })
      expect(wedding.statusCode, wedding.body).toBe(201)
      const targetId = wedding.json().id as string
      const first = await create('wedding', targetId, true)
      expect(first.manual).toMatchObject({ saveReceiptCopy: true, submittedAt: null, receiptUrl: null,
        transfer: { url: 'https://www.sberbank.com/sms/pbpn?requisiteNumber=79990000000' } })
      const paused = await buildApp({ ...config, servicePlanManualCheckoutEnabled: false })
      try {
        const pausedCatalog = (await paused.inject({ url: catalogPath, headers: buyer })).json()
        expect(pausedCatalog.manualCheckoutAvailable).toBeUndefined()
        for (const [path, getOrder] of [
          [orderPath + '/' + first.id, (body: { manual?: object }) => body],
          [orderPath + '/pending/wedding/' + targetId, (body: { order?: object }) => body.order],
          [orderPath + '/manual/wedding/' + targetId, (body: { orders: object[] }) => body.orders[0]],
        ] as const) {
          const response = await paused.inject({ url: path, headers: buyer })
          expect(response.statusCode, response.body).toBe(200)
          expect(getOrder(response.json())).toMatchObject({ manual: { saveReceiptCopy: true } })
          expect(response.body).not.toContain('qrJpegBase64')
        }
      } finally {
        await paused.close()
      }
      const report = { method: 'POST', url: orderPath + '/' + first.id + '/report-transfer', headers: buyer } as const
      expect((await checkout.inject({ ...report, headers: nonStaff })).statusCode).toBe(404)
      const reports = await Promise.all([checkout.inject(report), checkout.inject(report)])
      expect(reports.map(item => item.statusCode)).toEqual([200, 200])
      expect(reports[0].json().manual.submittedAt).toBe(reports[1].json().manual.submittedAt)
      expect(reports[0].json().manual.transfer).toBeUndefined()
      const notified = await db.query('select user_id from notifications where link = $1', [
        '/admin/service-plans?manualOrder=' + first.id,
      ])
      expect(notified.rows).toEqual([{ user_id: operatorId }])
      const scope = { code: 'wedding', targetId } as const
      expect(await servicePlanAccess(db, scope)).toBe(false)
      const paidAt = new Date()
      const bankOperation = randomUUID()
      const receiptUrl = 'https://lknpd.nalog.ru/api/v1/receipt/123456789012/test-' + randomUUID() + '/print'
      const evidence = { amount: first.amount, bankOperation, paidAt: paidAt.toISOString(), receiptDelivered: true }
      const confirm = (orderId: string, payload: object, headers = operator) => checkout.inject({
        method: 'POST', url: reviewPath + '/' + orderId + '/confirm', headers, payload,
      })
      expect((await confirm(first.id, { ...evidence, receiptUrl }, unlistedStaff)).statusCode).toBe(403)
      expect((await confirm(first.id, { ...evidence, receiptUrl }, nonStaff)).statusCode).toBe(403)
      expect((await confirm(first.id, { ...evidence, receiptDelivered: false, receiptUrl })).statusCode).toBe(422)
      expect((await confirm(first.id, { ...evidence, amount: first.amount + 1, receiptUrl })).statusCode).toBe(409)
      expect((await confirm(first.id, evidence)).statusCode).toBe(409)
      expect((await confirm(first.id, { ...evidence, paidAt: '2000-01-01T12:00:00Z', receiptUrl })).statusCode).toBe(409)
      expect((await confirm(first.id, { ...evidence, receiptUrl: 'https://example.invalid/receipt' })).statusCode).toBe(422)
      await expect(settleServiceOrder(db, {
        orderId: first.id, paymentId: bankOperation, provider: MANUAL_PROVIDER, amount: first.amount,
        currency: 'RUB', refundedAmount: 0, state: 'paid', paidAt,
      })).rejects.toMatchObject({ statusCode: 409 })
      const revokedSessionId = randomUUID()
      await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',
        [revokedSessionId, operatorId, randomUUID()])
      const revokedOperator = { authorization: 'Bearer ' + await signAccessToken(accessSecret, {
        sub: operatorId, sid: revokedSessionId,
      }) }
      let revokedConfirmation: ReturnType<typeof confirm> | undefined
      let confirmations: ReturnType<typeof confirm>[] = []
      await db.tx(async withdrawal => {
        await withdrawal.query("set local lock_timeout = '2s'")
        await withdrawal.query('select id from weddings where id = $1 for update', [targetId])
        const identity = await withdrawal.query<{ pid: number }>('select pg_backend_pid() as pid')
        revokedConfirmation = confirm(first.id, { ...evidence, receiptUrl }, revokedOperator)
        const deadline = Date.now() + 5000
        let waiting = false
        while (!waiting && Date.now() < deadline) {
          const blocked = await db.query(`
            select 1 from pg_stat_activity where datname = current_database()
              and $1::integer = any(pg_blocking_pids(pid))
          `, [identity.rows[0]!.pid])
          waiting = Boolean(blocked.rowCount)
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(waiting).toBe(true)
        // Account withdrawal must still be able to lock the owner while the
        // confirmations wait on the wedding.
        await withdrawal.query('select id from users where id = $1 for update', [buyerId])
        const revoke = await checkout.inject({ method: 'DELETE',
          url: '/users/me/sessions/' + revokedSessionId, headers: operator })
        expect(revoke.statusCode, revoke.body).toBe(204)
        confirmations = [
          confirm(first.id, { ...evidence, receiptUrl }), confirm(first.id, { ...evidence, receiptUrl }),
        ]
      })
      expect((await revokedConfirmation!).statusCode).toBe(401)
      const results = await Promise.all(confirmations)
      expect(results.map(item => item.statusCode), results.map(item => item.body).join('\n')).toEqual([200, 200])
      expect(await servicePlanAccess(db, scope)).toBe(true)
      const saved = (await checkout.inject({ url: orderPath + '/' + first.id, headers: buyer })).json()
      expect(saved).toMatchObject({ state: 'paid', manual: { receiptUrl } })
      expect((await checkout.inject({ url: orderPath + '/' + first.id, headers: nonStaff })).statusCode).toBe(404)
      await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",
        [targetId, nonStaffId])
      const partnerScope = await checkout.inject({ url: orderPath + '/manual/wedding/' + targetId, headers: nonStaff })
      expect(partnerScope.json()).toEqual({ active: true, orders: [] })
      expect((await db.query('select id from notifications where user_id = $1 and link = $2', [
        buyerId, '/settings?serviceOrder=' + first.id,
      ])).rowCount).toBe(1)

      const vendorId = randomUUID()
      await db.query("insert into vendors(id,user_id,category_id,name) values($1,$2,'photo','WP11 Manual')",
        [vendorId, buyerId])
      const month = await create('vendor_month', vendorId, false)
      const monthEvidence = { ...evidence, amount: month.amount, paidAt: new Date().toISOString() }
      const reused = await confirm(month.id, monthEvidence)
      expect(reused.statusCode, reused.body).toBe(409)
      const unpaid = (await checkout.inject({ url: orderPath + '/' + month.id, headers: buyer })).json()
      expect(unpaid).toMatchObject({ state: 'pending', manual: { submittedAt: null, receiptUrl: null } })
      const activated = await confirm(month.id, { ...monthEvidence, bankOperation: randomUUID() })
      expect(activated.statusCode, activated.body).toBe(200)
      const completed = activated.json().order
      expect(completed).toMatchObject({ state: 'paid', manual: { saveReceiptCopy: false, receiptUrl: null } })
      expect(Date.parse(completed.accessFrom)).toBeGreaterThan(Date.parse(monthEvidence.paidAt))
      const renewal = await create('vendor_month', vendorId, false)
      const renewed = await confirm(renewal.id, { ...monthEvidence, paidAt: new Date().toISOString(), bankOperation: randomUUID() })
      expect(renewed.statusCode, renewed.body).toBe(200)
      expect(renewed.json().order.accessFrom).toBe(completed.accessUntil)
      const history = await checkout.inject({ url: orderPath + '/manual/vendor_month/' + vendorId, headers: buyer })
      expect(history.json().active).toBe(true)
      expect(history.json().orders.map((entry: { id: string }) => entry.id)).toEqual([renewal.id, month.id])
      const abandoned = await create('vendor_month', vendorId, true)
      const close = { method: 'POST', url: reviewPath + '/' + abandoned.id + '/close', headers: operator,
        payload: { noTransferReceived: true } } as const
      expect((await checkout.inject({ ...close, headers: nonStaff })).statusCode).toBe(403)
      expect((await checkout.inject({ ...close, payload: { noTransferReceived: false } })).statusCode).toBe(422)
      const closed = await checkout.inject(close)
      expect(closed.statusCode, closed.body).toBe(200)
      expect(closed.json()).toMatchObject({ order: { state: 'canceled' }, receiptEmail: null })
      const next = await create('vendor_month', vendorId, true)
      expect(next.id).not.toBe(abandoned.id)
      await db.query('update users set deleted_at = statement_timestamp() where id = $1', [buyerId])
      const hiddenContact = await checkout.inject({ url: reviewPath + '?orderId=' + next.id, headers: operator })
      expect(hiddenContact.json().reviews[0].receiptEmail).toBeNull()
      expect((await confirm(next.id, {
        ...monthEvidence, paidAt: new Date().toISOString(), bankOperation: randomUUID(),
        receiptUrl: receiptUrl.replace('/test-', '/erased-'),
      })).json().error.code).toBe('service_owner_changed')
      await db.query('update service_plan_orders set customer_id = null where id = $1', [next.id])
      const erased = await db.query('select receipt_email from service_plan_manual_orders where order_id = $1', [next.id])
      expect(erased.rows).toEqual([{ receipt_email: null }])
    } finally {
      await checkout.close()
    }
  })
})

type Code = 'wedding' | 'vendor_month'
type Headers = Record<string, string>

describe('T005 tariff operation policy', () => {
  it('enables checks only with an explicit server flag', () => {
    expect(loadConfig({}).servicePlanAccessEnforced).toBe(false)
    expect(loadConfig({ SERVICE_PLAN_ACCESS_ENFORCED: 'true' }).servicePlanAccessEnforced).toBe(true)
  })

  it.each([
    ['POST', '/weddings/:weddingId/tasks', true],
    ['PUT', '/weddings/:weddingId/timeline', true],
    ['POST', '/weddings/:weddingId/slots/:slotId/resource-order', true],
    ['GET', '/weddings/:weddingId/tasks', false],
    ['GET', '/weddings/:weddingId/payment-schedule/export', false],
    ['POST', '/weddings/:weddingId/guests/:guestId/invite-link', false],
    ['PUT', '/weddings/:weddingId/events/:eventId/rsvp/:guestId', false],
    ['POST', '/weddings/:weddingId/planb/activate', false],
    ['POST', '/weddings/:weddingId/timeline/shift', false],
    ['POST', '/weddings/:weddingId/slots/:slotId/cancel', false],
    ['POST', '/weddings/:weddingId/cancel', false],
    ['DELETE', '/weddings/:weddingId/album/:photoId', false],
    ['POST', '/rsvp/:guestToken', false],
  ] as const)('%s %s requires a plan=%s', (method, route, needsPlan) => {
    expect(requiresWeddingPlan(method, route)).toBe(needsPlan)
  })
})

describe.skipIf(!databaseUrl)('T005 HTTP enforcement on PostgreSQL', () => {
  let app: FastifyInstance
  let freeApp: FastifyInstance
  const actors: string[] = []
  const weddings: string[] = []
  const vendors: string[] = []
  const prices = new Map<Code, string>()
  const amounts: Record<Code, number> = { wedding: 29900, vendor_month: 19900 }

  beforeAll(async () => {
    const config = { env: 'test' as const, databaseUrl: databaseUrl!, redisUrl: null,
      jwtAccessSecret: accessSecret, jwtRefreshSecret: 'u'.repeat(48), policyVersion }
    app = await buildApp({ ...config, servicePlanAccessEnforced: true })
    freeApp = await buildApp({ ...config, servicePlanAccessEnforced: false })
    await app.ready()
    await freeApp.ready()
  })

  afterAll(async () => {
    try {
      if (app?.db) {
        await app.db.tx(async tx => {
          const published = [...prices.values()]
          await tx.query('delete from service_plan_orders where price_id = any($1::uuid[])', [published])
          await tx.query('delete from service_plan_prices where id = any($1::uuid[])', [published])
          await tx.query('delete from weddings where id = any($1::uuid[])', [weddings])
          await tx.query('delete from vendors where id = any($1::uuid[])', [vendors])
          await tx.query('delete from users where id = any($1::uuid[])', [actors])
        })
      }
    } finally {
      await freeApp?.close()
      await app?.close()
    }
  })

  async function user() {
    const id = randomUUID(), sid = randomUUID()
    actors.push(id)
    await app.db!.query('insert into users(id,phone,name) values ($1,$2,$3)',
      [id, '+79' + randomInt(100000000, 999999999), 'T005 fixture'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values ($1,$2,$3)', [sid, id, randomUUID()])
    const headers = { authorization: 'Bearer ' + await signAccessToken(accessSecret, { sub: id, sid }) }
    const consent = await app.inject({ method: 'POST', url: '/users/me/consent', headers,
      payload: { adult: true, policyVersion } })
    expect(consent.statusCode, consent.body).toBe(201)
    return { id, headers }
  }

  async function order(code: Code, targetId: string, customerId: string) {
    let priceId = prices.get(code)
    if (!priceId) {
      const price = await app.db!.query<{ id: string }>(`
        insert into service_plan_prices(plan_code, revision, amount, published_at, effective_at)
        select $1, coalesce(max(revision), 0)+1, $2, statement_timestamp(), statement_timestamp() + interval '7 days'
        from service_plan_prices where plan_code=$1 returning id
      `, [code, amounts[code]])
      priceId = price.rows[0]!.id
      prices.set(code, priceId)
    }
    const result = await app.db!.query<{ id: string }>(`
      insert into service_plan_orders(plan_code,target_id,customer_id,price_id,amount,terms_version,terms_text,
        quote_expires_at,provider,provider_requested_at)
      values($1,$2,$3,$4,$5,1,'Synthetic T005 order',statement_timestamp()+interval '1 hour','t005_test',statement_timestamp())
      returning id
    `, [code, targetId, customerId, priceId, amounts[code]])
    return result.rows[0]!.id
  }

  async function pay(orderId: string, daysLeft: number | null) {
    await app.db!.query(`
      update service_plan_orders set state='paid', provider_id=id::text,
        paid_at=statement_timestamp() - interval '1 day',
        access_from=statement_timestamp() - interval '2 months',
        access_until=case when $2::int is null then null else statement_timestamp()+($2 * interval '1 day') end
      where id=$1
    `, [orderId, daysLeft])
  }

  async function refund(orderId: string) {
    await app.db!.query("update service_plan_orders set state='refunded', refunded_amount=amount where id=$1", [orderId])
  }

  function denied(result: { statusCode: number; body: string; json: () => unknown }) {
    expect(result.statusCode, result.body).toBe(403)
    expect(result.json()).toMatchObject({ error: { code: 'service_plan_required' } })
  }

  it('unlocks one wedding for both partners and preserves basic and role-bound access', async () => {
    const [owner, partner, helper, outsider] = await Promise.all([user(), user(), user(), user()])
    const created = await app.inject({ method: 'POST', url: '/weddings', headers: owner.headers,
      payload: { partnerName: 'T005', city: { name: 'Уфа', region: 'Башкортостан' } } })
    expect(created.statusCode, created.body).toBe(201)
    const weddingId = created.json().id as string
    weddings.push(weddingId)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper')",
      [weddingId, partner.id, helper.id])
    const base = '/weddings/' + weddingId
    const tasks = base + '/tasks'
    const writeTask = (headers: Headers, instance = app) => instance.inject({ method: 'POST', url: tasks,
      headers, payload: { title: 'Синтетическая задача T005', period: '3' } })
    expect((await app.inject({ url: tasks, headers: owner.headers })).statusCode).toBe(200)
    expect((await writeTask(owner.headers, freeApp)).statusCode).toBe(201)
    expect((await writeTask(outsider.headers)).statusCode).toBe(404)
    const wrongRole = await app.inject({ method: 'PATCH', url: base + '/budget/settings', headers: helper.headers,
      payload: { reserveBps: 150, version: 0 } })
    expect(wrongRole.statusCode, wrongRole.body).toBe(403)
    expect(wrongRole.json().error.code).toBe('forbidden')

    const pending = await order('wedding', weddingId, owner.id)
    denied(await writeTask(owner.headers))
    denied(await writeTask(partner.headers))
    const publishAlbum = () => app.inject({ method: 'PATCH', url: base + '/album', headers: owner.headers, payload: { approved: true } })
    denied(await publishAlbum())
    const missingPhoto = await app.inject({ method: 'PATCH', url: base + '/album/' + randomUUID(),
      headers: owner.headers, payload: { approved: true } })
    expect(missingPhoto.statusCode, missingPhoto.body).toBe(404)
    const unpublish = await app.inject({ method: 'PATCH', url: base + '/album', headers: owner.headers, payload: { approved: false } })
    expect(unpublish.statusCode, unpublish.body).toBe(200)

    const budgetWrite = () => app.inject({ method: 'PATCH', url: base, headers: owner.headers,
      payload: { budgetTotal: { amount: 3600000, currency: 'RUB' } } })
    denied(await budgetWrite())
    const program = await app.inject({ url: base + '/events', headers: owner.headers })
    expect(program.statusCode, program.body).toBe(200)
    const main = program.json().find((event: { isMain: boolean }) => event.isMain)
    const address = await app.inject({ method: 'PATCH', url: base + '/events/' + main.id,
      headers: { ...owner.headers, 'if-match': String(program.headers.etag) }, payload: { location: 'Вход со двора' } })
    expect(address.statusCode, address.body).toBe(200)

    const slots = await app.inject({ url: base + '/slots', headers: owner.headers })
    expect(slots.statusCode, slots.body).toBe(200)
    const slotId = slots.json()[0].id as string
    const { dealId } = await seedUntrackedSlotDeal(app, { weddingId, slotId, state: 'candidate',
      externalName: 'Исполнитель T005', price: 15000 })
    const book = () => app.inject({ method: 'PATCH', url: '/deals/' + dealId,
      headers: { ...owner.headers, 'idempotency-key': randomUUID() }, payload: { state: 'booked' } })
    denied(await book())

    const guests = base + '/guests'
    const guest = await app.inject({ method: 'POST', url: guests, headers: owner.headers, payload: { name: 'Гость T005' } })
    expect(guest.statusCode, guest.body).toBe(201)
    const table = await freeApp.inject({ method: 'POST', url: base + '/tables', headers: owner.headers, payload: { name: 'Стол T005' } })
    expect(table.statusCode, table.body).toBe(201)
    const guestPath = guests + '/' + guest.json().id
    const seat = () => app.inject({ method: 'PATCH', url: guestPath, headers: owner.headers,
      payload: { tableId: table.json().id } })
    denied(await seat())
    const basicGuestEdit = await app.inject({ method: 'PATCH', url: guestPath, headers: owner.headers, payload: { name: 'Гость T005' } })
    expect(basicGuestEdit.statusCode, basicGuestEdit.body).toBe(200)
    const issued = await app.inject({ method: 'POST', url: guests + '/' + guest.json().id + '/invite-link', headers: owner.headers })
    expect(issued.statusCode, issued.body).toBe(200)
    const redeemed = await app.inject({ url: '/invite/' + String(issued.json().url).split('/').pop() })
    expect(redeemed.statusCode, redeemed.body).toBe(200)
    const rsvp = '/rsvp/' + redeemed.json().guestToken
    const reply = await app.inject({ method: 'POST', url: rsvp, payload: { status: 'no' } })
    expect(reply.statusCode, reply.body).toBe(200)

    await pay(pending, null)
    for (const member of [owner, partner]) {
      const saved = await writeTask(member.headers)
      expect(saved.statusCode, saved.body).toBe(201)
    }
    expect((await publishAlbum()).statusCode).toBe(200)
    const paidBudget = await budgetWrite()
    expect(paidBudget.statusCode, paidBudget.body).toBe(200)
    const booked = await book()
    expect(booked.statusCode, booked.body).toBe(200)
    const family = await app.inject({ method: 'POST', url: guests, headers: owner.headers,
      payload: { name: 'Семья T005', plusOne: true } })
    expect(family.statusCode, family.body).toBe(201)
    const familyId = family.json().id as string
    const companion = await app.db!.query<{ id: string }>(`select child.id from guests child
      join guests primary_guest on primary_guest.party_id=child.party_id
      where primary_guest.id=$1 and child.party_position=2`, [familyId])
    const secondTable = await app.inject({ method: 'POST', url: base + '/tables', headers: owner.headers, payload: { name: 'Второй стол' } })
    expect(secondTable.statusCode, secondTable.body).toBe(201)
    const assign = (id: string, tableId: string) => app.inject({ method: 'PATCH', url: guests + '/' + id,
      headers: owner.headers, payload: { tableId } })
    expect((await assign(familyId, table.json().id)).statusCode).toBe(200)
    expect((await assign(companion.rows[0]!.id, secondTable.json().id)).statusCode).toBe(200)
    const budget = await app.inject({ method: 'PATCH', url: base + '/budget/settings', headers: partner.headers,
      payload: { reserveBps: 150, version: 0 } })
    expect(budget.statusCode, budget.body).toBe(200)

    await refund(pending)
    denied(await assign(familyId, table.json().id))
    denied(await writeTask(partner.headers))
    expect((await app.inject({ url: base + '/payment-schedule/export', headers: owner.headers })).statusCode).toBe(200)
    expect((await app.inject({ url: rsvp })).json().status).toBe('no')
    const cancelled = await app.inject({ method: 'PATCH', url: '/deals/' + dealId,
      headers: { ...owner.headers, 'idempotency-key': randomUUID() }, payload: { state: 'cancelled' } })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
  })

  it('applies the active vendor period to writes and preserves existing access after expiry', async () => {
    const [owner, outsider] = await Promise.all([user(), user()])
    const targetId = randomUUID()
    vendors.push(targetId)
    await app.db!.query("insert into vendors(id,user_id,category_id,name) values ($1,$2,'photo','T005 cabinet')", [targetId, owner.id])
    const calendar = '/vendor/calendar'
    const busy = (instance = app) => instance.inject({ method: 'POST', url: calendar + '/busy', headers: owner.headers,
      payload: { dates: ['2027-06-08'], status: 'busy' } })
    const resource = (headers: Headers, key = randomUUID()) => app.inject({ method: 'POST',
      url: '/vendors/' + targetId + '/resources', headers: { ...headers, 'idempotency-key': key },
      payload: { kind: 'equipment', label: 'T005 equipment' } })
    expect((await busy(freeApp)).statusCode).toBe(204)
    const expired = await order('vendor_month', targetId, owner.id)
    await pay(expired, -1)
    denied(await busy())
    const key = randomUUID()
    denied(await resource(owner.headers, key))
    const wrongVendor = await resource(outsider.headers)
    expect(wrongVendor.statusCode, wrongVendor.body).toBe(403)
    expect(wrongVendor.json().error.code).toBe('forbidden')
    const basic = ['/vendor/profile', '/vendor/offer-requests', '/vendor/leads', '/vendor/deals',
      calendar + '?month=2027-06', calendar + '/export?month=2027-06']
    for (const url of basic) {
      const read = await app.inject({ url, headers: owner.headers })
      expect(read.statusCode, url + ' ' + read.body).toBe(200)
    }

    const icsEvent = ['BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20270610', 'DTEND;VALUE=DATE:20270611', 'END:VEVENT']
    const importCalendar = (instance: FastifyInstance, lines: string[]) => instance.inject({ method: 'PUT',
      url: calendar + '/import', headers: owner.headers,
      payload: { timeZone: 'Europe/Moscow', calendar: ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n') } })
    const imported = await importCalendar(freeApp, icsEvent)
    expect(imported.statusCode, imported.body).toBe(200)
    expect(imported.json().count).toBe(1)
    denied(await importCalendar(app, icsEvent))
    const cleared = await importCalendar(app, [])
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(cleared.json().count).toBe(0)
    const unmarked = await app.inject({ method: 'POST', url: calendar + '/busy', headers: owner.headers,
      payload: { dates: ['2027-06-08'], status: 'free' } })
    expect(unmarked.statusCode, unmarked.body).toBe(204)

    const renewal = await order('vendor_month', targetId, owner.id)
    denied(await busy())
    await pay(renewal, 15)
    const saved = await busy()
    expect(saved.statusCode, saved.body).toBe(204)
    const made = await resource(owner.headers, key)
    expect(made.statusCode, made.body).toBe(200)

    await refund(renewal)
    denied(await busy())
    denied(await resource(owner.headers))
    const replay = await resource(owner.headers, key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(made.json())
  })
})
