import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disposablePgPort } from './disposablePgPort.js'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { OrderActor } from '../src/orders/context.js'
import type { Queryable } from '../src/plugins/db.js'
import { holdVendorDate } from '../src/deals/repo.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart } from '../src/orders/model.js'
import { saveOrderResourcePlan } from '../src/orders/resource-plan.js'
import { publishOrderTerms, loadOrderTerms, acceptOrderTerms } from '../src/orders/terms.js'
import { createResource, createCapacityWindow } from '../src/resources/model.js'
import { setAvailabilityPolicy } from '../src/resources/policy.js'
import { commitAgreedOrderResources, loadOrderResourceCommitments } from '../src/resources/commitments.js'
import { assertLegacyDateBookingAllowed, lockLegacyBookingCompanies } from '../src/resources/booking-boundary.js'
import { rescheduleWedding } from '../src/wedding/reschedule.js'

const DATABASE = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'actual-resource-booking-boundary-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DATE = '2027-06-14', NEW_DATE = '2027-06-16'
const proof = { secret: SECRET }
type Response = { statusCode: number; body: string; json<T>(): T }

describe.skipIf(!DATABASE)('resource policy boundaries on actual registered booking/calendar/reschedule doors', () => {
  let app: FastifyInstance
  const users = new Set<string>(), vendors = new Set<string>(), weddings = new Set<string>(), resources = new Set<string>()
  const witnesses: { change: string; holder: number; waiter: number; waitEvent: string | null; query: string; holderIdentity?: NativeIdentity; workerIdentity?: NativeIdentity }[] = []
  const prefix = String(randomInt(100_000, 999_999)); let sequence = 0
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.username, 'codex_test'); assert.equal(target.port, disposablePgPort())
    assert(['/tili_ecosystem_allocations_20260930_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'resource-booking-boundary-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query<{ address: string; port: number; name: string; principal: string }>(
      'select host(inet_server_addr()) address,inet_server_port() port,current_database() name,current_user principal')).rows[0]!
    expect(['127.0.0.1', '::1']).toContain(live.address); expect(live.port).toBe(Number(disposablePgPort()))
    expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
  })
  afterAll(async () => {
    if (!app) return
    try {
      process.stdout.write(`RESOURCE_BOOKING_BOUNDARY_PG_WAITS count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      process.stdout.write(`RESOURCE_BOOKING_BOUNDARY_FIXTURE_MANIFEST ${JSON.stringify({ database: new URL(DATABASE!).pathname.slice(1),
        users: [...users], vendors: [...vendors], weddings: [...weddings], resources: [...resources] })}\n`)
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      await app.db!.query('delete from vendor_resources where id=any($1::uuid[])', [[...resources]])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      await app.db!.query('delete from resource_conflict_keys where identity=any($1::uuid[])', [[...users, ...resources]])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function actor() {
    const userId = randomUUID(), sessionId = randomUUID(); users.add(userId)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic booking boundary actor')", [userId, `+79${prefix}${String(++sequence).padStart(4, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    return { userId, sessionId, policyVersion: POLICY, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const principal = (a: Actor): OrderActor => ({ userId: a.userId, sessionId: a.sessionId, policyVersion: a.policyVersion })
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor, key = randomUUID()) => ({ ...auth(a), 'idempotency-key': key })
  async function fixture(date: string | null = DATE) {
    const pair = await actor(), owner = await actor(), helper = await actor(), weddingId = randomUUID(), vendorId = randomUUID(), slotId = randomUUID()
    weddings.add(weddingId); vendors.add(vendorId)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic booking boundary wedding',$3,'Europe/Moscow',$4)", [weddingId, pair.userId, date, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper')", [weddingId, pair.userId, helper.userId])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic boundary florist',now())", [vendorId, owner.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Actual floral order position')", [slotId, weddingId])
    const equipment = await app.db!.tx(c => createResource(c, { vendorId, actor: principal(owner), kind: 'equipment', label: 'Actual boundary vase set' })); resources.add(equipment.id)
    const capacity = await app.db!.tx(c => createResource(c, { vendorId, actor: principal(owner), kind: 'capacity', label: 'Actual boundary production', capacityUnit: 'compositions' })); resources.add(capacity.id)
    const window = await app.db!.tx(c => createCapacityWindow(c, { vendorId, actor: principal(owner), resourceId: capacity.id,
      startsAt: '2027-06-12T00:00:00Z', endsAt: '2027-06-18T23:00:00Z', capacity: 10 }))
    return { pair, owner, helper, weddingId, vendorId, slotId, equipment, capacity, window }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const book = (f: Fixture, selected = f.pair, key = randomUUID()) => app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`,
    headers: idem(selected, key), payload: { vendorId: f.vendorId, price: { amount: 15000, currency: 'RUB' } } })
  const manual = (f: Fixture, dates: string[], status: 'busy' | 'free', selected = f.owner) => app.inject({ method: 'POST', url: '/vendor/calendar/busy',
    headers: auth(selected), payload: { dates, status } })
  const patchDeal = (f: Fixture, dealId: string, state: string, selected = f.pair) => app.inject({ method: 'PATCH', url: `/deals/${dealId}`,
    headers: idem(selected), payload: { state, price: { amount: 17000, currency: 'RUB' } } })
  const reschedule = (f: Fixture) => app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/reschedule`, headers: idem(f.pair), payload: { date: NEW_DATE } })
  async function mode(f: Fixture, selected: 'resources' | 'legacy_day', expected = '0') {
    return app.db!.tx(c => setAvailabilityPolicy(c, { vendorId: f.vendorId, actor: principal(f.owner), mode: selected, expectedRevision: expected }))
  }
  async function rawDeal(f: Fixture, state = 'contacted') {
    const id = randomUUID()
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price,package_title_snapshot,package_includes_snapshot) values($1,$2,$3,$4,$5,15000,'Actual inherited quote',$6::jsonb)",
      [id, f.weddingId, f.slotId, f.vendorId, state, JSON.stringify(['Five flower compositions'])])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [f.slotId, id])
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',1000,'recorded','cash','private')", [randomUUID(), id])
    return id
  }
  async function validLedger(f: Fixture) {
    const policy = await mode(f, 'resources'), dealId = await rawDeal(f, 'candidate')
    const eventId = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [f.weddingId])).rows[0]!.id
    const input = { weddingId: f.weddingId, dealId, actor: principal(f.pair) }
    const assigned = await app.db!.tx(c => createOrderAssignment(c, { ...input, expectedVersion: '1', slotId: f.slotId, programEventId: eventId, label: 'Actual delivery duty' }))
    const order = await app.db!.tx(c => createOrderPart(c, { ...input, expectedVersion: assigned.version, assignmentId: assigned.assignments[0]!.id,
      kind: 'supply', title: 'Five actual flower compositions', details: { quantity: 5, unit: 'compositions' } }))
    const saved = await app.db!.tx(c => saveOrderResourcePlan(c, { ...input, actor: principal(f.owner), expectedVersion: order.version,
      expectedPlanRevision: '0', lines: [{ partId: order.parts[0]!.id, resourceId: f.capacity.id, capacityWindowId: f.window.id, quantity: 5,
        startsAt: '2027-06-13T07:00:00Z', endsAt: '2027-06-13T09:00:00Z', timeZone: 'Europe/Moscow', setupMinutes: 10, teardownMinutes: 15, travelBeforeMinutes: 20, travelAfterMinutes: 25 }] }))
    await app.db!.tx(c => publishOrderTerms(c, { ...input, expectedOrderVersion: saved.orderVersion, expectedTermsRevision: '0' }))
    for (const person of [f.pair, f.owner]) {
      const party = { ...input, actor: principal(person) }, read = await app.db!.tx(c => loadOrderTerms(c, party, proof)), selected = read.selected!
      expect(read.readToken).toBeTypeOf('string')
      await app.db!.tx(c => acceptOrderTerms(c, { ...party, termsId: selected.id, expectedTermsVersion: selected.version, digest: selected.digest, readToken: read.readToken! }, proof))
    }
    const terms = await app.db!.tx(c => loadOrderTerms(c, input, proof))
    expect(terms.agreedTermsId).toBe(terms.selected!.id)
    expect(new Set(terms.selected!.receipts.map(r => r.userId)).size).toBe(2)
    expect(new Set(terms.selected!.receipts.map(r => r.sessionId)).size).toBe(2)
    await app.db!.tx(c => commitAgreedOrderResources(c, { ...input, expectedOrderVersion: saved.orderVersion, expectedCommitmentRevision: '0',
      termsId: terms.selected!.id, expectedTermsVersion: terms.selected!.version, termsDigest: terms.selected!.digest,
      planRevisionId: saved.current!.planRevisionId, expectedPolicyRevision: policy.revision }))
    return { dealId, input, policyRevision: policy.revision }
  }
  async function offer(f: Fixture) {
    const entry = randomUUID()
    await app.db!.query('insert into slot_shortlist(id,slot_id,vendor_id,position,added_by) values($1,$2,$3,1,$4)', [entry, f.slotId, f.vendorId, f.pair.userId])
    const request = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/offer-requests`, headers: idem(f.pair), payload: { entryIds: [entry] } })
    expect(request.statusCode, request.body).toBe(201)
    const requestId = request.json().results[0].requestId as string
    const reply = await app.inject({ method: 'POST', url: `/vendor/offer-requests/${requestId}/offers`, headers: idem(f.owner),
      payload: { kind: 'offer', title: 'Actual bouquet offer', price: { amount: 15000, currency: 'RUB' }, includes: ['Five compositions'], validUntil: '2027-06-13' } })
    expect(reply.statusCode, reply.body).toBe(201)
    return { offerId: reply.json().id as string, requestId }
  }
  const acceptOffer = (f: Fixture, offerId: string, key = randomUUID()) => app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/offers/${offerId}/accept`, headers: idem(f.pair, key) })
  async function snapshot(f: Fixture, c: Queryable = app.db!) {
    const ids = [f.pair.userId, f.owner.userId, f.helper.userId]
    const reads = [
      () => c.query('select * from weddings where id=$1', [f.weddingId]),
      () => c.query('select * from wedding_events where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select * from timeline_events where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select * from tasks where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select * from slots where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select * from deals where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select p.* from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1 order by p.id', [f.weddingId]),
      () => c.query('select e.* from deal_events e join deals d on d.id=e.deal_id where d.wedding_id=$1 order by e.id', [f.weddingId]),
      () => c.query('select * from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId]),
      () => c.query('select * from leads where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select r.* from offer_requests r join slots s on s.id=r.slot_id where s.wedding_id=$1 order by r.id', [f.weddingId]),
      () => c.query('select o.* from offers o join offer_requests r on r.id=o.request_id join slots s on s.id=r.slot_id where s.wedding_id=$1 order by o.id', [f.weddingId]),
      () => c.query('select * from notifications where user_id=any($1::uuid[]) order by id', [ids]),
      () => c.query('select * from idempotency_keys where user_id=any($1::uuid[]) order by key', [ids]),
      () => c.query('select * from deal_orders where wedding_id=$1 order by deal_id', [f.weddingId]),
      () => c.query('select * from deal_resource_commitments where wedding_id=$1 order by deal_id', [f.weddingId]),
      () => c.query('select * from deal_resource_commitment_versions where wedding_id=$1 order by deal_id,revision', [f.weddingId]),
      () => c.query('select * from resource_allocations where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select * from deal_resource_commitment_members where wedding_id=$1 order by version_id,line_index', [f.weddingId]),
      () => c.query('select * from vendor_resources where vendor_id=$1 order by id', [f.vendorId]),
      () => c.query('select w.* from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id where r.vendor_id=$1 order by w.id', [f.vendorId]),
      () => c.query('select * from vendor_availability_policy where vendor_id=$1', [f.vendorId]),
      () => c.query('select * from audit_log where actor_id=any($1::uuid[]) or entity_id=$2 order by id', [ids, f.weddingId]),
      () => c.query('select * from vendor_program_acknowledgments where wedding_id=$1 order by vendor_id,version,digest', [f.weddingId]),
    ]
    const result = []
    for (const read of reads) result.push((await read()).rows)
    return result
  }
  function error(response: Response, code: string, status = 409) {
    expect(response.statusCode, response.body).toBe(status)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code)
  }
  async function refused(f: Fixture, action: () => Promise<Response>, code = 'resource_booking_required', status = 409) {
    const before = await snapshot(f), response = await action(); error(response, code, status); expect(await snapshot(f)).toEqual(before)
    for (const id of [f.equipment.id, f.capacity.id, f.window.id, f.owner.userId]) expect(response.body).not.toContain(id)
  }

  it.each([DATE, null])('catalog DATE-only book with wedding date %s refuses resource policy without a financial/notification mutation', async date => {
    const f = await fixture(date); await mode(f, 'resources'); await refused(f, () => book(f))
  })
  it.each([DATE, null])('actual offer acceptance with wedding date %s refuses resource policy, preserving request version and original offer', async date => {
    const f = await fixture(date), actual = await offer(f); await mode(f, 'resources')
    await refused(f, () => acceptOffer(f, actual.offerId))
  })
  it.each(['contacted', 'negotiating'] as const)('every first committed PATCH from %s refuses before financial price/state changes', async initial => {
    const f = await fixture(), deal = await rawDeal(f, initial); await mode(f, 'resources')
    for (const committed of ['booked', 'paid_deposit', 'done']) await refused(f, () => patchDeal(f, deal, committed))
  })
  it('first committed PATCH remains guarded even without a wedding date', async () => {
    const f = await fixture(null), deal = await rawDeal(f); await mode(f, 'resources')
    for (const committed of ['booked', 'paid_deposit', 'done']) await refused(f, () => patchDeal(f, deal, committed))
  })
  it('lowest actual holdVendorDate and both common guard interfaces enforce resource policy', async () => {
    const f = await fixture(), deal = await rawDeal(f); await mode(f, 'resources'); const before = await snapshot(f)
    await expect(app.db!.tx(c => holdVendorDate(c, f.vendorId, DATE, deal, f.weddingId))).rejects.toMatchObject({ statusCode: 409, code: 'resource_booking_required' })
    await expect(app.db!.tx(async c => { await lockLegacyBookingCompanies(c, [f.vendorId, f.vendorId]); await assertLegacyDateBookingAllowed(c, f.vendorId) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'resource_booking_required' })
    expect(await snapshot(f)).toEqual(before)
  })
  it.each(['absent', 'explicit_legacy'] as const)('ordinary %s policy still permits actual catalog booking/date hold/cancellation', async policy => {
    const f = await fixture()
    if (policy === 'explicit_legacy') { const changed = await mode(f, 'resources'); await mode(f, 'legacy_day', changed.revision) }
    const booked = await book(f); expect(booked.statusCode, booked.body).toBe(200)
    expect((await app.db!.query('select date::text,source from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([{ date: DATE, source: 'deal' }])
    const cancelled = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/cancel`, headers: idem(f.pair) })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect((await app.db!.query('select date from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([])
  })
  it('ordinary legacy actual offer acceptance remains bookable with one original request and deal', async () => {
    const f = await fixture(), actual = await offer(f), accepted = await acceptOffer(f, actual.offerId)
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect((await app.db!.query('select accepted_at,deal_id from offers where id=$1', [actual.offerId])).rows[0]!.accepted_at).toBeInstanceOf(Date)
    expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1', [f.weddingId])).rows[0]!.n).toBe(1)
  })
  it('policy downgrade leaves a REAL accepted live ledger protected from manual busy/free and lowest DATE hold', async () => {
    const f = await fixture(), ledger = await validLedger(f); await mode(f, 'legacy_day', ledger.policyRevision)
    for (const status of ['busy', 'free'] as const) await refused(f, () => manual(f, [DATE, NEW_DATE], status))
    const before = await snapshot(f)
    await expect(app.db!.tx(c => holdVendorDate(c, f.vendorId, NEW_DATE, ledger.dealId, f.weddingId))).rejects.toMatchObject({ statusCode: 409, code: 'resource_booking_required' })
    expect(await snapshot(f)).toEqual(before)
    expect(await app.db!.tx(c => loadOrderResourceCommitments(c, ledger.input))).toMatchObject({ revision: '1', state: 'reserved' })
  })
  it('policy downgrade with live allocations still guards new catalog/offer/first-committed doors, including a null date', async () => {
    const f = await fixture(), ledger = await validLedger(f); await mode(f, 'legacy_day', ledger.policyRevision)
    const created = await fixture(null)
    // Another actual wedding selects the SAME existing company. The spare
    // synthetic company's rows remain in our UUID cleanup manifest.
    const other = { ...created, vendorId: f.vendorId, owner: f.owner, equipment: f.equipment, capacity: f.capacity, window: f.window }
    const originalBeforeBook = await snapshot(f)
    await refused(other, () => book(other)); expect(await snapshot(f)).toEqual(originalBeforeBook)
    const pending = await offer(other), original = await snapshot(f)
    await refused(other, () => acceptOffer(other, pending.offerId))
    const candidate = await rawDeal(other)
    for (const committed of ['booked', 'paid_deposit', 'done']) await refused(other, () => patchDeal(other, candidate, committed))
    expect(await snapshot(f)).toEqual(original)
  })
  it('an existing resource-booked financial root can advance paid/done without release or a new DATE hold', async () => {
    const f = await fixture(), ledger = await validLedger(f)
    const rows = (await app.db!.query('select * from resource_allocations where deal_id=$1', [ledger.dealId])).rows
    const financialSnapshot = async () => {
      // Compare every deal column except the two intended transition fields,
      // plus complete payment/installment rows, including their versions.
      const deal = (await app.db!.query("select to_jsonb(d)-'state'-'done_at' financial from deals d where id=$1", [ledger.dealId])).rows
      const money = (await app.db!.query('select * from payments where deal_id=$1 order by id', [ledger.dealId])).rows
      const installments = (await app.db!.query('select * from payment_installments where deal_id=$1 order by id', [ledger.dealId])).rows
      return { deal, money, installments }
    }
    const financial = await financialSnapshot()
    for (const state of ['paid_deposit', 'done']) {
      if (state === 'done') {
        await refused(f, () => patchDeal(f, ledger.dealId, state), 'price_locked')
        expect(await financialSnapshot()).toEqual(financial)
      }
      const changed = await app.inject({ method: 'PATCH', url: `/deals/${ledger.dealId}`, headers: idem(f.pair), payload: { state } })
      expect(changed.statusCode, changed.body).toBe(200)
      const actual = (await app.db!.query('select state,price::text,currency,done_at from deals where id=$1', [ledger.dealId])).rows[0]!
      expect(actual).toMatchObject({ state, price: '15000', currency: 'RUB' })
      if (state === 'done') expect(actual.done_at).toBeInstanceOf(Date)
      else expect(actual.done_at).toBeNull()
      expect(await financialSnapshot()).toEqual(financial)
      expect((await app.db!.query('select * from resource_allocations where deal_id=$1', [ledger.dealId])).rows).toEqual(rows)
      expect((await app.db!.query('select date from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([])
      expect((await app.db!.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 5 }])
    }
  })
  it.each(['busy', 'free'] as const)('manual %s is guarded for explicit resource policy even before any allocation exists', async status => {
    const f = await fixture(); await mode(f, 'resources'); await refused(f, () => manual(f, [DATE, NEW_DATE], status))
  })
  it('ordinary legacy manual batch stays atomic and manual free preserves an actual deal-held day', async () => {
    const f = await fixture(), booked = await book(f); expect(booked.statusCode, booked.body).toBe(200)
    expect((await manual(f, [NEW_DATE, '2027-06-17'], 'busy')).statusCode).toBe(204)
    expect((await manual(f, [DATE, NEW_DATE, '2027-06-17'], 'free')).statusCode).toBe(204)
    expect((await app.db!.query('select date::text,source from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId])).rows).toEqual([{ date: DATE, source: 'deal' }])
  })
  it('helper booking and a principal without a company are rejected without exposing selected private identities', async () => {
    const f = await fixture()
    await refused(f, () => book(f, f.helper), 'forbidden', 403)
    const stranger = await actor(), before = await snapshot(f), response = await manual(f, [DATE], 'busy', stranger)
    error(response, 'forbidden', 403); expect(await snapshot(f)).toEqual(before)
    for (const id of [f.equipment.id, f.capacity.id, f.window.id, f.owner.userId]) expect(response.body).not.toContain(id)
  })
  it.each(['post', 'patch', 'kernel'] as const)('open resource-backed %s reschedule currently refuses all mutations until explicit reagreement exists', async door => {
    const f = await fixture(), ledger = await validLedger(f), before = await snapshot(f)
    if (door === 'post') error(await reschedule(f), 'resource_reschedule_requires_agreement')
    if (door === 'patch') error(await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}`, headers: auth(f.pair), payload: { date: NEW_DATE, style: 'Should roll back' } }), 'resource_reschedule_requires_agreement')
    if (door === 'kernel') await expect(app.db!.tx(c => rescheduleWedding(c, f.weddingId, NEW_DATE, f.pair.userId))).rejects.toMatchObject({ statusCode: 409, code: 'resource_reschedule_requires_agreement' })
    expect(await snapshot(f)).toEqual(before)
    expect(await app.db!.tx(c => loadOrderResourceCommitments(c, ledger.input))).toMatchObject({ state: 'reserved' })
  })
  it('ordinary legacy reschedule still moves the actual held day and preserves payment records', async () => {
    const f = await fixture(), booked = await book(f); expect(booked.statusCode, booked.body).toBe(200)
    const deal = booked.json().deal.id as string
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',1000,'recorded','cash','private')", [randomUUID(), deal])
    const money = (await app.db!.query('select * from payments where deal_id=$1 order by id', [deal])).rows
    const moved = await reschedule(f); expect(moved.statusCode, moved.body).toBe(200)
    expect((await app.db!.query('select date::text from weddings where id=$1', [f.weddingId])).rows).toEqual([{ date: NEW_DATE }])
    expect((await app.db!.query('select date::text from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([{ date: NEW_DATE }])
    expect((await app.db!.query('select * from payments where deal_id=$1 order by id', [deal])).rows).toEqual(money)
  })

  type NativeIdentity = { pid: number; birth: string; tx: string; xid: string }
  type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
  const reflect = <T>(work: Promise<T>): Promise<Outcome<T>> => work.then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
  async function nativeIdentity(c: Queryable): Promise<NativeIdentity> {
    return (await c.query<NativeIdentity>(`select pg_backend_pid() pid,backend_start::text birth,
      xact_start::text tx,txid_current()::text xid from pg_stat_activity where pid=pg_backend_pid()`)).rows[0]!
  }
  async function observeWait(change: string, holder: NativeIdentity, worker: () => NativeIdentity | undefined,
    sql: string, deadline: number, finished: () => boolean) {
    while (Date.now() < deadline && !finished()) {
      const current = worker()
      if (current) {
        const rows = (await app.db!.query<{ pid: number; wait_event: string | null; query: string }>(`
          select a.pid,a.wait_event,a.query from pg_stat_activity a join pg_stat_activity h on h.pid=$7
          where a.datname=current_database() and a.usename=current_user and a.pid=$1
            and a.backend_start::text=$2 and a.xact_start::text=$3 and a.backend_xid::text=$4
            and a.state='active' and a.wait_event_type='Lock' and a.query=$5
            and $7=any(pg_blocking_pids(a.pid))
            and not exists(select 1 from unnest(pg_blocking_pids(a.pid)) blocker(pid) where blocker.pid<>$7)
            and h.backend_start::text=$8 and h.xact_start::text=$9
            and h.backend_xid::text=$6 and h.datname=current_database() and h.usename=current_user
            and h.state='idle in transaction'`, [current.pid,current.birth,current.tx,
          String(BigInt(current.xid) % 4294967296n),sql,String(BigInt(holder.xid) % 4294967296n),
          holder.pid,holder.birth,holder.tx])).rows
        expect(rows.length).toBeLessThanOrEqual(1)
        if (rows[0]) {
          const row = rows[0]
          witnesses.push({ change, holder: holder.pid, waiter: row.pid, waitEvent: row.wait_event, query: row.query, holderIdentity: holder, workerIdentity: current })
          return row
        }
      }
      await new Promise<void>(r => setTimeout(r, 25))
    }
    throw new Error(change + ': exact worker PID/birth/TX/SQL did not wait on the still-held fixture transaction')
  }
  type TrackedClaim = { userId: string; route: 'slots.book' | 'offers.accept'; key: string }
  async function waitedHttp(f: Fixture, change: string, lock: string, values: readonly unknown[],
    mutate: (c: Queryable) => Promise<unknown>, action: () => Promise<Response>, claim?: TrackedClaim,
    extraActors: readonly Actor[] = []) {
    const db = app.db!, originalTx = db.tx
    const invoke = <T>(work: (c: Queryable) => Promise<T>): Promise<T> => originalTx.call(db, work) as Promise<T>
    let release!: () => void, signal!: () => void, holderStamp: NativeIdentity | undefined, worker: NativeIdentity | undefined
    let expected: unknown, armed = true, captures = 0, done = false
    const scopedKey = claim ? `${claim.userId}:${claim.route}:${claim.key}` : null
    const previousKeys = claim ? (await snapshot(f))[13]! : null
    if (previousKeys) expect(previousKeys.some(row => row.key === scopedKey)).toBe(false)
    const permission = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { signal = r })
    const holder = reflect(invoke(async c => {
      await prepareLegacyCalendarScope(c, { weddingIds: [f.weddingId], vendorIds: [f.vendorId],
        personIds: [f.owner.userId, ...extraActors.map(a => a.userId)],
        extraAccountIds: extraActors.map(a => a.userId), actor: principal(f.pair), mode: claim ? 'write' : 'erase' })
      await c.query(lock, values); holderStamp = await nativeIdentity(c); signal(); await permission
      await mutate(c)
      const current = await snapshot(f, c)
      if (claim) {
        const keys = current[13]!, tracked = keys.filter(row => row.key === scopedKey)
        expect(tracked).toHaveLength(1)
        expect(tracked[0]).toMatchObject({ key: scopedKey, user_id: claim.userId, route: claim.route, status: null, body: null })
        expect(tracked[0]!.request_hash).toMatch(/^[a-f0-9]{64}$/)
        current[13] = keys.filter(row => row.key !== scopedKey)
        expect(current[13]).toEqual(previousKeys)
      }
      expected = current
    }))
    let http: Promise<Outcome<Response>> | undefined, failed = false, primary: unknown
    const cleanup: unknown[] = []
    let returned: { response: Response; expected: unknown; query: string } | undefined
    try {
      await Promise.race([ready, holder.then(result => {
        if (!result.ok) throw result.error
        throw new Error(change + ': holder ended before ready')
      })])
      const deadline = Date.now() + 3000
      db.tx = <T>(work: (c: Queryable) => Promise<T>): Promise<T> => {
        if (!armed) return invoke(work)
        armed = false; captures++
        return invoke(async c => { worker = await nativeIdentity(c); return work(c) })
      }
      http = reflect(action()).then(result => { done = true; return result })
      const observed = await observeWait(change, holderStamp!, () => worker,
        'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope', deadline, () => done)
      expect(captures).toBe(1)
      release()
      const held = await holder; if (!held.ok) throw held.error
      const response = await http; if (!response.ok) throw response.error
      if (claim) expect((await db.query('select * from idempotency_keys where key=$1', [scopedKey])).rows).toEqual([])
      returned = { response: response.value, expected, query: observed.query }
    } catch (error) { failed = true; primary = error }
    finally {
      release()
      const held = await holder; if (!held.ok) cleanup.push(held.error)
      if (http) { const result = await http; if (!result.ok) cleanup.push(result.error) }
      db.tx = originalTx
    }
    if (failed || cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, change + ': primary/drain failure')
    return returned!
  }
  it.each(['session', 'consent', 'account', 'owner', 'blocked'] as const)('real manual-calendar HTTP wait rechecks current %s before changing any day', async change => {
    const f = await fixture(), newOwner = change === 'owner' ? await actor() : null
    const lock = change === 'account' ? 'select id from users where id=$1 for update' : change === 'session' ? 'select id from sessions where id=$1 for update' :
      change === 'consent' ? 'select id from consents where user_id=$1 for update' : 'select id from vendors where id=$1 for update'
    const id = change === 'account' || change === 'consent' ? f.owner.userId : change === 'session' ? f.owner.sessionId : f.vendorId
    const outcome = await waitedHttp(f, `manual current ${change}`, lock, [id], async c => {
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.owner.sessionId])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [f.owner.userId])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [f.owner.userId])
      if (change === 'owner') await c.query('update vendors set user_id=$2 where id=$1', [f.vendorId, newOwner!.userId])
      if (change === 'blocked') await c.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
    }, () => manual(f, [DATE, NEW_DATE], 'busy'), undefined, newOwner ? [newOwner] : [])
    expect(outcome.response.statusCode, outcome.response.body).toBe(change === 'session' || change === 'account' ? 401 : change === 'consent' ? 403 : change === 'blocked' ? 404 : 409)
    expect(await snapshot(f)).toEqual(outcome.expected)
    for (const privateId of [f.capacity.id, f.window.id]) expect(outcome.response.body).not.toContain(privateId)
  })
  it.each(['catalog', 'offer'] as const)('actual %s waits for company policy and then refuses without consuming the request or making a deal', async door => {
    const f = await fixture(), actual = door === 'offer' ? await offer(f) : null, key = randomUUID()
    const outcome = await waitedHttp(f, `${door} policy changed`, 'select id from vendors where id=$1 for update', [f.vendorId],
      c => setAvailabilityPolicy(c, { vendorId: f.vendorId, actor: principal(f.owner), mode: 'resources', expectedRevision: '0' }),
      () => actual ? acceptOffer(f, actual.offerId, key) : book(f, f.pair, key),
      { userId: f.pair.userId, route: door === 'offer' ? 'offers.accept' : 'slots.book', key })
    error(outcome.response, 'resource_booking_required'); expect(await snapshot(f)).toEqual(outcome.expected)
  })
  it('actual catalog owner change first refuses stale scope, then a fresh operation books the current live owner', async () => {
    const f = await fixture(), next = await actor(), key = randomUUID()
    const outcome = await waitedHttp(f, 'catalog owner binding changed', 'select id from vendors where id=$1 for update', [f.vendorId],
      c => c.query('update vendors set user_id=$2 where id=$1', [f.vendorId, next.userId]), () => book(f, f.pair, key),
      { userId: f.pair.userId, route: 'slots.book', key }, [next])
    expect(outcome.query).toBe('select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope')
    error(outcome.response, 'calendar_scope_changed'); expect(await snapshot(f)).toEqual(outcome.expected)
    for (const privateId of [f.vendorId, f.owner.userId, next.userId, f.capacity.id, f.window.id]) expect(outcome.response.body).not.toContain(privateId)
    const fresh = await book(f, f.pair, randomUUID())
    expect(fresh.statusCode, fresh.body).toBe(200)
    expect((await app.db!.query('select user_id from vendors where id=$1', [f.vendorId])).rows).toEqual([{ user_id: next.userId }])
    expect((await app.db!.query('select vendor_id,state,price::text,currency from deals where wedding_id=$1', [f.weddingId])).rows)
      .toEqual([{ vendor_id: f.vendorId, state: 'booked', price: '15000', currency: 'RUB' }])
    expect((await app.db!.query('select date::text,source from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows)
      .toEqual([{ date: DATE, source: 'deal' }])
  })
  it('manual multi-day actual SQL timeout rolls back the first new day instead of leaving a partial batch', async () => {
    const f = await fixture(), second = '2027-06-17', db = app.db!, originalTx = db.tx
    expect((await manual(f, [second], 'busy')).statusCode).toBe(204)
    const invoke = <T>(work: (c: Queryable) => Promise<T>): Promise<T> => originalTx.call(db, work) as Promise<T>
    const timeout = (await db.query<{ value: string }>("select current_setting('statement_timeout') value")).rows[0]!.value
    expect(timeout).toMatch(/^(15s|15000ms)$/)
    const before = await snapshot(f), suffix = randomUUID().replaceAll('-', '')
    const functionName = 'boundary_timeout_' + suffix, triggerName = 'boundary_timeout_' + suffix
    expect(functionName).toMatch(/^boundary_timeout_[a-f0-9]{32}$/)
    const procedure = 'public.' + functionName + '()'
    const keys = (await db.query<{ a: number; b: number }>('select hashtext($1) a,hashtext($2) b',
      ['resource-booking-boundary-timeout/' + suffix, f.vendorId + '/' + second])).rows[0]!
    expect(keys.a).not.toBe(176387)
    const catalog = () => db.query(`select t.oid::text,t.tgname,t.tgenabled,t.tgisinternal,
      pg_get_triggerdef(t.oid,true) definition,t.tgfoid::text function_oid
      from pg_trigger t where t.tgrelid='public.vendor_busy_dates'::regclass order by t.oid`).then(r => r.rows)
    const beforeCatalog = await catalog()
    expect((await db.query('select oid from pg_proc where oid=to_regprocedure($1)', [procedure])).rows).toEqual([])
    expect(beforeCatalog.some(row => row.tgname === triggerName)).toBe(false)
    const functionDDL = `create function public.${functionName}() returns trigger language plpgsql as $boundary$
      begin
        if NEW.vendor_id='${f.vendorId}'::uuid and NEW.date='${second}'::date and NEW.source='manual' then
          perform pg_advisory_xact_lock(${keys.a},${keys.b});
        end if;
        return NEW;
      end $boundary$`
    const insertSQL = "insert into vendor_busy_dates (vendor_id, date, source) values ($1, $2::date, 'manual') on conflict (vendor_id, date) do nothing"
    let createdFunction: unknown, createdTrigger: unknown, functionCreated = false, triggerCreated = false
    let release!: () => void, ready!: () => void, holderStamp: NativeIdentity | undefined, worker: NativeIdentity | undefined
    let holder: Promise<Outcome<void>> | undefined, http: Promise<Outcome<Response>> | undefined
    let firstRows: unknown, secondSQL: string | undefined, rawTimeout: unknown, armed = true, captures = 0, done = false
    let failed = false, primary: unknown
    const cleanup: unknown[] = []
    const permission = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { ready = r })
    const ownFunction = () => db.query(`select p.oid::text,p.proowner::text,p.prolang::text,p.prorettype::text,
      pg_get_functiondef(p.oid) definition from pg_proc p where p.oid=to_regprocedure($1)`, [procedure]).then(r => r.rows)
    const ownTrigger = () => db.query(`select t.oid::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) definition,
      t.tgfoid::text function_oid from pg_trigger t
      where t.tgrelid='public.vendor_busy_dates'::regclass and t.tgname=$1`, [triggerName]).then(r => r.rows)
    try {
      await db.query(functionDDL); functionCreated = true; createdFunction = await ownFunction()
      expect(createdFunction).toHaveLength(1)
      await db.query(`create trigger ${triggerName} before insert on public.vendor_busy_dates
        for each row execute function public.${functionName}()`)
      triggerCreated = true; createdTrigger = await ownTrigger(); expect(createdTrigger).toHaveLength(1)
      holder = reflect(invoke(async c => {
        holderStamp = await nativeIdentity(c)
        await c.query('select pg_advisory_xact_lock($1,$2)', [keys.a, keys.b]); ready()
        let released = false; void permission.then(() => { released = true })
        while (!released) {
          await Promise.race([permission, new Promise<void>(r => setTimeout(r, 1000))])
          if (!released) await c.query('select 1')
        }
      }))
      await Promise.race([started, holder.then(result => {
        if (!result.ok) throw result.error
        throw new Error('SQL timeout holder ended before ready')
      })])
      const deadline = Date.now() + 3000
      db.tx = <T>(work: (c: Queryable) => Promise<T>): Promise<T> => {
        if (!armed) return invoke(work)
        armed = false; captures++
        return invoke(async c => {
          worker = await nativeIdentity(c)
          const originalQuery = c.query, bound = originalQuery.bind(c) as Queryable['query']
          c.query = async <R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) => {
            const isInsert = text.replace(/\s+/g, ' ').trim() === insertSQL && values?.[0] === f.vendorId
            if (isInsert && values?.[1] === second) {
              expect(firstRows).toEqual([{ vendor_id: f.vendorId, date: NEW_DATE, source: 'manual' }])
              secondSQL = text
            }
            try {
              const result = await bound<R>(text, values)
              if (isInsert && values?.[1] === NEW_DATE) {
                firstRows = (await bound('select vendor_id,date::text,source from vendor_busy_dates where vendor_id=$1 and date=$2::date', [f.vendorId, NEW_DATE])).rows
                expect(firstRows).toEqual([{ vendor_id: f.vendorId, date: NEW_DATE, source: 'manual' }])
              }
              return result
            } catch (error) {
              if (isInsert && values?.[1] === second) rawTimeout = error
              throw error
            }
          }
          try { return await work(c) } finally { c.query = originalQuery }
        })
      }
      http = reflect(manual(f, [NEW_DATE, second], 'busy')).then(result => { done = true; return result })
      while (!secondSQL && Date.now() < deadline && !done) await new Promise<void>(r => setTimeout(r, 10))
      expect(secondSQL).toBeTypeOf('string')
      await observeWait('manual second-day SQL statement_timeout', holderStamp!, () => worker, secondSQL!, deadline, () => done)
      expect(captures).toBe(1)
      const response = await http; if (!response.ok) throw response.error
      expect(response.value.statusCode, response.value.body).toBe(500)
      expect(rawTimeout).toMatchObject({ code: '57014' })
      expect(firstRows).toEqual([{ vendor_id: f.vendorId, date: NEW_DATE, source: 'manual' }])
      release(); const held = await holder; if (!held.ok) throw held.error
      expect(await snapshot(f)).toEqual(before)
    } catch (error) { failed = true; primary = error }
    finally {
      release()
      if (holder) { const result = await holder; if (!result.ok) cleanup.push(result.error) }
      if (http) { const result = await http; if (!result.ok) cleanup.push(result.error) }
      db.tx = originalTx
      try {
        if (triggerCreated) {
          expect(await ownTrigger()).toEqual(createdTrigger)
          await db.query('drop trigger ' + triggerName + ' on public.vendor_busy_dates')
        }
        if (functionCreated) {
          expect(await ownFunction()).toEqual(createdFunction)
          await db.query('drop function ' + procedure)
        }
        expect(await catalog()).toEqual(beforeCatalog)
        expect(await ownFunction()).toEqual([])
      } catch (error) { cleanup.push(error) }
    }
    if (failed || cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'SQL timeout primary/drain/own-DDL cleanup failure')
    // Manual calendar has no idempotency-key contract; repeat the identical real operation.
    expect((await manual(f, [NEW_DATE, second], 'busy')).statusCode).toBe(204)
    expect((await db.query('select date::text from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId])).rows)
      .toEqual([{ date: NEW_DATE }, { date: second }])
  }, 35_000)

})
