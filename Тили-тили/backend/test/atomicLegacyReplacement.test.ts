import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import type { OrderDto } from '../src/orders/model.js'
import type { ResourcePlanView } from '../src/orders/resource-plan.js'
import type { TermsView } from '../src/orders/terms.js'
import { setAvailabilityPolicy } from '../src/resources/policy.js'
import { disposablePgPort } from './disposablePgPort.js'

const DATABASE = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02', DATE = '2027-06-14'
const SECRET = 'atomic-legacy-http-real-pg-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
type Reply = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }
type State = 'candidate' | 'contacted' | 'negotiating' | 'booked' | 'paid_deposit'
type Slot = { id: string; deal: { id: string; state: string; vendor?: { id: string }; price?: { amount: number }; packageName?: string; packageIncludes?: string[] } }
type Body = { expectedSelectedDealId: string; expectedSelectedDealState: State; vendorId: string; packageId?: string; price: { amount: number; currency: string }; expectedPolicyRevision: string }

// This suite requires a real guarded database. Missing configuration is a
// failure, never a skipped green gate. Root alone runs it serially.
describe.sequential('registered atomic legacy replacement with actual PostgreSQL', () => {
  let app: FastifyInstance, guarded = false
  const users = new Set<string>(), vendors = new Set<string>(), weddings = new Set<string>(), resources = new Set<string>()
  type WaitBase = { change: string; waiter: number; event: string | null; query: string }
  const waits: (WaitBase & ({ holder: number } | { root: number; directBlockers: number[]; path: number[] }))[] = []
  const prefix = String(randomInt(100_000, 999_999)); let sequence = 0
  beforeAll(async () => {
    assert(DATABASE, 'TEST_DATABASE_URL is required for the actual atomic replacement witness')
    assert.equal(process.env.DATABASE_URL, DATABASE); assert.equal(disposablePgPort(), '15432')
    const target = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.username, 'codex_test'); assert.equal(target.port, disposablePgPort()); assert.equal(target.search, ''); assert.equal(target.hash, '')
    assert(['/tili_ecosystem_atomic_replace_20260930_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    app = await buildApp({ env: 'test', databaseUrl: DATABASE, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'atomic-replacement-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name,current_user principal')).rows[0]!
    expect(['127.0.0.1', '::1']).toContain(live.address); expect(live.port).toBe(Number(disposablePgPort())); expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
    guarded = true
  })
  afterAll(async () => {
    if (!app) return
    try {
      if (!guarded) return
      process.stdout.write(`ATOMIC_LEGACY_REPLACEMENT_PG_WAITS count=${waits.length} ${JSON.stringify(waits)}\n`)
      process.stdout.write(`ATOMIC_LEGACY_REPLACEMENT_FIXTURE_MANIFEST ${JSON.stringify({ database: new URL(DATABASE!).pathname.slice(1), users: [...users], vendors: [...vendors], weddings: [...weddings], resources: [...resources] })}\n`)
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      await app.db!.query('delete from vendor_resources where id=any($1::uuid[])', [[...resources]])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      await app.db!.query('delete from resource_conflict_keys where identity=any($1::uuid[])', [[...users, ...resources]])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function actor() {
    assert(guarded)
    const id = randomUUID(), session = randomUUID(); users.add(id)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic atomic replacement actor')", [id, `+79${prefix}${String(++sequence).padStart(4, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, session, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const headers = (a: Actor, key: string | null = randomUUID()) => ({ ...a.headers, ...(key === null ? {} : { 'idempotency-key': key }) })
  function ok<T>(r: Reply): T { expect(r.statusCode, r.body).toBe(200); return r.json<T>() }
  function error(r: Reply, code: string, status = 409) { expect(r.statusCode, r.body).toBe(status); expect(r.json<{ error: { code: string } }>().error.code).toBe(code) }
  function vendorField(r: Reply) { const fields = r.json<{ error: { fields: Record<string, string> } }>().error.fields; expect(Object.keys(fields)).toEqual(['vendorId']); expect(fields.vendorId).toBeTypeOf('string'); expect(fields.vendorId!.length).toBeGreaterThan(0) }
  async function company() {
    const owner = await actor(), id = randomUUID(), packageId = randomUUID(); vendors.add(id)
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic atomic florist',now())", [id, owner.id])
    await app.db!.query("insert into vendor_packages(id,vendor_id,name,price,items) values($1,$2,'Actual five bouquets',24000,$3::jsonb)", [packageId, id, JSON.stringify(['Five bouquets', 'Delivery'])])
    return { id, owner, packageId }
  }
  type Company = Awaited<ReturnType<typeof company>>
  async function wedding(pair: Actor, date: string | null = DATE) {
    const id = randomUUID(), slot = randomUUID(); weddings.add(id)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic atomic replacement wedding',$3,'Europe/Moscow',$4)", [id, pair.id, date, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [id, pair.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Actual floral position')", [slot, id])
    return { id, slot }
  }
  async function resource(c: Company) {
    const capacity = ok<{ id: string }>(await app.inject({ method: 'POST', url: `/vendors/${c.id}/resources`, headers: headers(c.owner), payload: { kind: 'capacity', label: 'Private bouquet production', capacityUnit: 'bouquets' } })); resources.add(capacity.id)
    const window = ok<{ id: string }>(await app.inject({ method: 'POST', url: `/vendors/${c.id}/resources/${capacity.id}/windows`, headers: headers(c.owner), payload: { startsAt: '2027-06-12T00:00:00Z', endsAt: '2027-06-18T23:00:00Z', capacity: 10 } }))
    return { capacity: capacity.id, window: window.id }
  }
  async function mode(c: Company, value: 'resources' | 'legacy_day', revision = '0') {
    return ok<{ revision: string }>(await app.inject({ method: 'PATCH', url: `/vendors/${c.id}/availability-policy`, headers: headers(c.owner), payload: { mode: value, expectedRevision: revision } }))
  }
  const book = (pair: Actor, w: { id: string; slot: string }, c: Company) => app.inject({ method: 'POST', url: `/weddings/${w.id}/slots/${w.slot}/book`, headers: headers(pair), payload: { vendorId: c.id, packageId: c.packageId, price: { amount: 15000, currency: 'RUB' } } })
  async function ledger(pair: Actor, w: { id: string; slot: string }, c: Company) {
    const r = await resource(c), policy = await mode(c, 'resources')
    const prepared = ok<{ dealId: string; orderVersion: string }>(await app.inject({ method: 'POST', url: `/weddings/${w.id}/slots/${w.slot}/resource-order`, headers: headers(pair), payload: { vendorId: c.id, packageId: c.packageId, expectedSelectedDealId: null, expectedPolicyRevision: policy.revision } }))
    const path = `/deals/${prepared.dealId}/order`
    const order = ok<OrderDto>(await app.inject({ method: 'POST', url: `${path}/parts`, headers: headers(c.owner), payload: { expectedVersion: prepared.orderVersion, kind: 'deliverable', assignmentId: null, title: 'Actual bouquet delivery', details: { dueAt: '2027-06-15T12:00:00Z' } } }))
    const plan = ok<ResourcePlanView>(await app.inject({ method: 'PATCH', url: `${path}/resource-plan`, headers: headers(c.owner), payload: { expectedVersion: order.version, expectedPlanRevision: '0', lines: [{ partId: order.parts[0]!.id, resourceId: r.capacity, capacityWindowId: r.window, quantity: 5, startsAt: '2027-06-13T07:00:00Z', endsAt: '2027-06-13T09:00:00Z', timeZone: 'Europe/Moscow', setupMinutes: 10, teardownMinutes: 15, travelBeforeMinutes: 20, travelAfterMinutes: 25 }] } }))
    const published = ok<TermsView>(await app.inject({ method: 'POST', url: `${path}/terms/proposals`, headers: headers(pair), payload: { expectedOrderVersion: plan.orderVersion, expectedTermsRevision: '0' } }))
    expect(published.selected!.snapshot.schemaVersion).toBe(2); expect(published.selected!.snapshot.resourcePlan).toEqual(plan.current)
    for (const person of [pair, c.owner]) {
      const read = ok<TermsView>(await app.inject({ url: `${path}/terms`, headers: person.headers })); expect(read.readToken).toBeTypeOf('string')
      ok(await app.inject({ method: 'POST', url: `${path}/terms/${read.selected!.id}/accept`, headers: headers(person), payload: { expectedTermsVersion: read.selected!.version, digest: read.selected!.digest, readToken: read.readToken } }))
    }
    const accepted = ok<TermsView>(await app.inject({ url: `${path}/terms`, headers: pair.headers })), selected = accepted.selected!
    expect(accepted.agreedTermsId).toBe(selected.id); expect(selected.receipts.map(p => p.party).sort()).toEqual(['customer', 'performer'])
    expect(new Set(selected.receipts.map(p => p.userId)).size).toBe(2); expect(new Set(selected.receipts.map(p => p.sessionId)).size).toBe(2)
    ok(await app.inject({ method: 'POST', url: `${path}/resource-commitments`, headers: headers(pair), payload: { expectedOrderVersion: plan.orderVersion, expectedCommitmentRevision: '0', termsId: selected.id, expectedTermsVersion: selected.version, termsDigest: selected.digest, planRevisionId: plan.current!.planRevisionId, expectedPolicyRevision: policy.revision } }))
    expect((await app.db!.query('select used from resource_capacity_windows where id=$1', [r.window])).rows).toEqual([{ used: 5 }])
    return { deal: prepared.dealId, policyRevision: policy.revision, ...r }
  }
  async function fixture(options: { date?: string | null; external?: boolean; resourceOld?: boolean; paid?: boolean } = {}) {
    const pair = await actor(), helper = await actor(), coordinator = await actor(), pseudoVendor = await actor(), stranger = await actor()
    const old = await company(), next = await company(), third = await company(), w = await wedding(pair, options.date === undefined ? DATE : options.date)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper'),($1,$3,'coordinator'),($1,$4,'vendor')", [w.id, helper.id, coordinator.id, pseudoVendor.id])
    let oldDeal: string, oldLedger: Awaited<ReturnType<typeof ledger>> | null = null
    if (options.resourceOld) { oldLedger = await ledger(pair, w, old); oldDeal = oldLedger.deal }
    else if (options.external) oldDeal = ok<Slot>(await app.inject({ method: 'POST', url: `/weddings/${w.id}/slots/${w.slot}/external`, headers: pair.headers, payload: { vendorName: 'Actual external florist', phone: '+79990008888', price: { amount: 15000, currency: 'RUB' } } })).deal.id
    else oldDeal = ok<Slot>(await book(pair, w, old)).deal.id
    if (!options.resourceOld) {
      const path = `/deals/${oldDeal}/order`, initial = ok<OrderDto>(await app.inject({ url: path, headers: pair.headers }))
      const event = (await app.db!.query('select id from wedding_events where wedding_id=$1 and is_main', [w.id])).rows[0]!.id as string
      const assigned = ok<OrderDto>(await app.inject({ method: 'POST', url: `${path}/assignments`, headers: headers(pair), payload: { expectedVersion: initial.version, slotId: w.slot, programEventId: event, label: 'Actual old ceremony duty' } }))
      const drafted = ok<OrderDto>(await app.inject({ method: 'POST', url: `${path}/parts`, headers: headers(pair), payload: { expectedVersion: assigned.version, kind: 'supply', assignmentId: assigned.assignments[0]!.id, title: 'Actual old delivery duty', details: { quantity: 5, unit: 'bouquets' } } }))
      // Preserve a real published immutable historical source, without
      // claiming that this legacy draft was accepted by two humans.
      ok(await app.inject({ method: 'POST', url: `${path}/terms/proposals`, headers: headers(pair), payload: { expectedOrderVersion: drafted.version, expectedTermsRevision: '0' } }))
    }
    if (options.paid) ok(await app.inject({ method: 'POST', url: `/weddings/${w.id}/slots/${w.slot}/pay`, headers: headers(pair), payload: { amount: { amount: 1000, currency: 'RUB' } } }))
    // Own synthetic side-effect rows test actual cancellation semantics and
    // rollback, not a claim that an issued external link belongs to a catalogue vendor.
    const invite = randomUUID(), bus = randomUUID()
    await app.db!.query("insert into external_invites(token,wedding_id,slot_id,expires_at,program_deal_id) values($1,$2,$3,now()+interval '1 day',$4)", [invite, w.id, w.slot, oldDeal])
    await app.db!.query("insert into bus_routes(id,wedding_id,name,seats,deal_id) values($1,$2,'Synthetic route cancellation pointer',12,$3)", [bus, w.id, oldDeal])
    const guest = randomUUID()
    await app.db!.query("insert into guests(id,wedding_id,name,rsvp_token) values($1,$2,'Synthetic retained passenger',$3)", [guest, w.id, randomUUID()])
    await app.db!.query('insert into bus_bookings(bus_id,guest_id) values($1,$2)', [bus, guest])
    await app.db!.query("insert into payment_installments(id,deal_id,title,amount,due) values($1,$2,'Actual retained obligation',15000,'2027-06-14')", [randomUUID(), oldDeal])
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',200,'recorded','cash','private'),($3,$2,'refund',100,'recorded','cash','private')", [randomUUID(), oldDeal, randomUUID()])
    const requestIds = [randomUUID(), randomUUID()]
    for (const [index, c] of [next, third].entries()) {
      await app.db!.query("insert into offer_requests(id,slot_id,vendor_id,wedding_date,created_by,wishes) values($1,$2,$3,$4,$5,'Synthetic pending quote')", [requestIds[index], w.slot, c.id, options.date === undefined ? DATE : options.date, pair.id])
      await app.db!.query("insert into offers(id,request_id,kind,title,price,valid_until,created_by) values($1,$2,'offer','Synthetic existing quote',24000,'2027-06-01',$3)", [randomUUID(), requestIds[index], c.owner.id])
    }
    const accountIds = [pair, helper, coordinator, pseudoVendor, stranger, old.owner, next.owner, third.owner].map(a => a.id)
    return { pair, helper, coordinator, pseudoVendor, stranger, old, next, third, wedding: w.id, slot: w.slot, oldDeal, oldLedger, invite, bus, requestIds, accountIds, weddingIds: [w.id], companyIds: [old.id, next.id, third.id], state: options.paid ? 'paid_deposit' as State : 'booked' as State }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const body = (f: Fixture, c = f.next): Body => ({ expectedSelectedDealId: f.oldDeal, expectedSelectedDealState: f.state, vendorId: c.id, packageId: c.packageId, price: { amount: 24000, currency: 'RUB' }, expectedPolicyRevision: '0' })
  const replace = (f: Fixture, payload: object = body(f), person = f.pair, key: string | null = randomUUID(), weddingId = f.wedding, slot = f.slot) => app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${slot}/replace`, headers: headers(person, key), payload })
  const cacheKey = (f: Fixture, key: string) => `${f.pair.id}:slots.replace:${key}`
  function privateFree(f: Fixture, r: Reply) { for (const id of [...f.accountIds, ...resources]) expect(r.body).not.toContain(id); for (const field of ['resourceId', 'personUserId', 'capacityWindowId', 'allocationId', 'sessionId']) expect(r.body).not.toContain(`"${field}":`) }
  async function snapshot(f: Fixture, c: Queryable = app.db!, transientKey?: string) {
    const ws = f.weddingIds, cs = f.companyIds, us = f.accountIds
    const tables = [
      ['weddings', 'id=any($1::uuid[])', [ws]], ['wedding_events', 'wedding_id=any($1::uuid[])', [ws]], ['wedding_members', 'wedding_id=any($1::uuid[])', [ws]],
      ['slots', 'wedding_id=any($1::uuid[])', [ws]], ['deals', 'wedding_id=any($1::uuid[])', [ws]],
      ['payments', 'deal_id in(select id from deals where wedding_id=any($1::uuid[]))', [ws]], ['payment_installments', 'deal_id in(select id from deals where wedding_id=any($1::uuid[]))', [ws]], ['deal_events', 'deal_id in(select id from deals where wedding_id=any($1::uuid[]))', [ws]],
      ['timeline_events', 'wedding_id=any($1::uuid[])', [ws]], ['tasks', 'wedding_id=any($1::uuid[])', [ws]], ['guests', 'wedding_id=any($1::uuid[])', [ws]], ['event_guest_participation', 'wedding_id=any($1::uuid[])', [ws]], ['bus_routes', 'wedding_id=any($1::uuid[])', [ws]], ['bus_bookings', 'bus_id in(select id from bus_routes where wedding_id=any($1::uuid[]))', [ws]],
      ['external_invites', 'wedding_id=any($1::uuid[])', [ws]], ['chats', 'wedding_id=any($1::uuid[])', [ws]], ['leads', 'wedding_id=any($1::uuid[])', [ws]],
      ['slot_shortlist', 'slot_id in(select id from slots where wedding_id=any($1::uuid[]))', [ws]], ['offer_requests', 'slot_id in(select id from slots where wedding_id=any($1::uuid[]))', [ws]], ['offers', 'request_id in(select r.id from offer_requests r join slots s on s.id=r.slot_id where s.wedding_id=any($1::uuid[]))', [ws]],
      ['deal_orders', 'wedding_id=any($1::uuid[])', [ws]], ['order_assignments', 'wedding_id=any($1::uuid[])', [ws]], ['order_parts', 'wedding_id=any($1::uuid[])', [ws]], ['deal_terms_versions', 'wedding_id=any($1::uuid[])', [ws]], ['deal_terms_receipts', 'wedding_id=any($1::uuid[])', [ws]], ['deal_resource_plan_versions', 'wedding_id=any($1::uuid[])', [ws]],
      ['deal_resource_commitments', 'wedding_id=any($1::uuid[])', [ws]], ['deal_resource_commitment_versions', 'wedding_id=any($1::uuid[])', [ws]], ['deal_resource_commitment_members', 'wedding_id=any($1::uuid[])', [ws]], ['resource_allocations', 'wedding_id=any($1::uuid[]) or vendor_id=any($2::uuid[])', [ws, cs]],
      ['vendor_busy_dates', 'vendor_id=any($1::uuid[])', [cs]], ['vendor_availability_policy', 'vendor_id=any($1::uuid[])', [cs]], ['vendor_resources', 'vendor_id=any($1::uuid[])', [cs]], ['resource_capacity_windows', 'resource_id in(select id from vendor_resources where vendor_id=any($1::uuid[]))', [cs]], ['resource_conflict_keys', 'identity=any($1::uuid[]) or identity in(select id from vendor_resources where vendor_id=any($2::uuid[]))', [us, cs]],
      ['users', 'id=any($1::uuid[])', [us]], ['sessions', 'user_id=any($1::uuid[])', [us]], ['consents', 'user_id=any($1::uuid[])', [us]], ['vendors', 'id=any($1::uuid[])', [cs]], ['vendor_packages', 'vendor_id=any($1::uuid[])', [cs]], ['notifications', 'user_id=any($1::uuid[])', [us]], ['audit_log', 'actor_id=any($1::uuid[])', [us]],
      ['idempotency_keys', transientKey === undefined ? 'user_id=any($1::uuid[])' : 'user_id=any($1::uuid[]) and key<>$2', transientKey === undefined ? [us] : [us, transientKey]],
    ] as const
    const result: unknown[] = []
    for (const [table, where, values] of tables) result.push((await c.query(`select to_jsonb(t) row from ${table} t where ${where} order by to_jsonb(t)::text`, values)).rows)
    return result
  }
  async function refused(f: Fixture, action: () => Promise<Reply>, code: string, status = 409) { const before = await snapshot(f), r = await action(); error(r, code, status); privateFree(f, r); expect(await snapshot(f)).toEqual(before); return r }
  async function retainedMoney(f: Fixture) {
    return { deal: (await app.db!.query("select to_jsonb(d)-'state'-'cancelled_at'-'cancel_reason'-'negotiating_until' row from deals d where id=$1", [f.oldDeal])).rows,
      payments: (await app.db!.query('select to_jsonb(p) row from payments p where deal_id=$1 order by id', [f.oldDeal])).rows,
      program: (await app.db!.query('select to_jsonb(e) row from wedding_events e where wedding_id=$1 order by id', [f.wedding])).rows }
  }
  async function positive(f: Fixture, r: Reply, target = f.next) {
    const selected = ok<Slot>(r); expect(selected.id).toBe(f.slot); expect(selected.deal.id).not.toBe(f.oldDeal)
    expect(selected.deal).toMatchObject({ state: 'booked', vendor: { id: target.id }, price: { amount: 24000 }, packageName: 'Actual five bouquets', packageIncludes: ['Five bouquets', 'Delivery'] })
    const roots = (await app.db!.query('select id,state,vendor_id,price::text from deals where wedding_id=$1 order by id', [f.wedding])).rows
    expect(roots).toHaveLength(2); expect(roots.find(d => d.id === f.oldDeal)).toMatchObject({ state: 'cancelled' }); expect(roots.find(d => d.id === selected.deal.id)).toMatchObject({ state: 'booked', vendor_id: target.id, price: '24000' })
    expect((await app.db!.query('select deal_id from slots where id=$1', [f.slot])).rows).toEqual([{ deal_id: selected.deal.id }])
    expect((await app.db!.query('select date::text,source,deal_id from vendor_busy_dates where vendor_id=$1', [target.id])).rows).toEqual([{ date: DATE, source: 'deal', deal_id: selected.deal.id }])
    expect((await app.db!.query("select from_state,to_state from deal_events where deal_id=$1 and to_state='cancelled'", [f.oldDeal])).rows).toEqual([{ from_state: f.state, to_state: 'cancelled' }])
    expect((await app.db!.query('select from_state,to_state from deal_events where deal_id=$1', [selected.deal.id])).rows).toEqual([{ from_state: null, to_state: 'booked' }])
    expect((await app.db!.query('select state from leads where wedding_id=$1 and vendor_id=$2', [f.wedding, target.id])).rows).toEqual([{ state: 'won' }])
    expect((await app.db!.query('select deal_id from bus_routes where id=$1', [f.bus])).rows).toEqual([{ deal_id: null }])
    expect((await app.db!.query('select revoked_at is not null revoked from external_invites where token=$1', [f.invite])).rows).toEqual([{ revoked: true }])
    return selected
  }

  it.each([false, true])('one registered replacement atomically cancels old and books new while preserving old money/program (paid=%s)', async paid => {
    const f = await fixture({ paid }), before = await retainedMoney(f)
    const oldTerms = (await app.db!.query('select * from deal_terms_versions where deal_id=$1 order by id', [f.oldDeal])).rows
    const version = (await app.db!.query('select version::text from deal_orders where deal_id=$1', [f.oldDeal])).rows[0]!.version as string
    const passengers = (await app.db!.query('select * from bus_bookings where bus_id=$1', [f.bus])).rows
    await positive(f, await replace(f)); expect(await retainedMoney(f)).toEqual(before)
    expect((await app.db!.query('select * from deal_terms_versions where deal_id=$1 order by id', [f.oldDeal])).rows).toEqual(oldTerms)
    expect((await app.db!.query('select version::text from deal_orders where deal_id=$1', [f.oldDeal])).rows).toEqual([{ version: (BigInt(version)+1n).toString() }])
    expect((await app.db!.query('select cancelled_at is not null cancelled from order_parts where deal_id=$1', [f.oldDeal])).rows).toEqual([{ cancelled: true }])
    expect((await app.db!.query('select cancelled_at is not null cancelled from order_assignments where deal_id=$1', [f.oldDeal])).rows).toEqual([{ cancelled: true }])
    expect((await app.db!.query('select * from bus_bookings where bus_id=$1', [f.bus])).rows).toEqual(passengers)
    expect((await app.db!.query('select date from vendor_busy_dates where vendor_id=$1', [f.old.id])).rows).toEqual([])
    expect((await app.db!.query('select state from leads where vendor_id=$1 and wedding_id=$2', [f.old.id, f.wedding])).rows).toEqual([{ state: 'replied' }])
    expect((await app.db!.query('select vendor_id,status,close_reason from offer_requests where id=any($1::uuid[]) order by vendor_id', [f.requestIds])).rows).toEqual([f.next, f.third].sort((a,b) => a.id.localeCompare(b.id)).map(c => ({ vendor_id: c.id, status: 'closed', close_reason: c.id === f.next.id ? 'booked' : 'booked_other' })))
  })
  it('external old contract keeps its original contact and payment history while the actual catalogue booking replaces it', async () => { const f = await fixture({ external: true, paid: true }), before = await retainedMoney(f); await positive(f, await replace(f)); expect(await retainedMoney(f)).toEqual(before) })
  it('a same-key retry replays one new root; changed body and stale new-key intent cannot cancel the new selection', async () => {
    const f = await fixture(), key = randomUUID(), initial = await replace(f, body(f), f.pair, key); await positive(f, initial)
    const before = await snapshot(f), replay = await replace(f, body(f), f.pair, key); expect(replay.statusCode).toBe(200); expect(replay.headers['idempotent-replay']).toBe('true'); expect(replay.json()).toEqual(initial.json()); expect(await snapshot(f)).toEqual(before)
    await refused(f, () => replace(f, { ...body(f), price: { amount: 25000, currency: 'RUB' } }, f.pair, key), 'idempotency_key_reused')
    await refused(f, () => replace(f), 'resource_order_slot_changed')
  })
  it.each(['manual', 'another_wedding'] as const)('busy new company %s retains exact old DATE, financial/draft/history/lead/bus/invite/cache rows', async busy => {
    const f = await fixture()
    if (busy === 'manual') expect((await app.inject({ method: 'POST', url: '/vendor/calendar/busy', headers: f.next.owner.headers, payload: { dates: [DATE], status: 'busy' } })).statusCode).toBe(204)
    else { const other = await wedding(f.stranger); f.weddingIds.push(other.id); ok(await book(f.stranger, other, f.next)) }
    await refused(f, () => replace(f), 'date_taken')
  })
  it.each(['missing', 'foreign'] as const)('a %s package cannot destroy the old contract', async kind => { const f = await fixture(); await refused(f, () => replace(f, { ...body(f), packageId: kind === 'missing' ? randomUUID() : f.old.packageId }), 'unknown_package', 422) })
  it.each(['unpublished', 'blocked', 'erased'] as const)('a currently %s new company refuses replacement before financial mutation', async change => {
    const f = await fixture()
    if (change === 'unpublished') await app.db!.query('update vendors set published_at=null where id=$1', [f.next.id])
    if (change === 'blocked') await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.next.id])
    if (change === 'erased') await app.db!.query('update users set deleted_at=now() where id=$1', [f.next.owner.id])
    await refused(f, () => replace(f), 'not_found', 404)
  })
  it('date absent means explicitly unresolved booking, not an inferred calendar day', async () => { const f = await fixture({ date: null }); await refused(f, () => replace(f), 'booking_date_required') })
  it('same contractor refuses a false replacement rather than manufacturing another root', async () => { const f = await fixture(); await refused(f, () => replace(f, body(f, f.old)), 'validation_failed', 422) })
  it('a company from a different service category cannot replace this floral position', async () => { const f = await fixture(); await app.db!.query("update vendors set category_id='photo' where id=$1", [f.next.id]); vendorField(await refused(f, () => replace(f), 'validation_failed', 422)) })
  it('existing public book preserves intentional cross-category compatibility and the original selected contract', async () => {
    const f = await fixture({ paid: true }), photoSlot = randomUUID()
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Actual empty photo position')", [photoSlot, f.wedding])
    // audit29/prod6 intentionally book one catalogue company across categories.
    // This old door keeps that contract; the new replacement door is stricter.
    const before = await snapshot(f) as { row: Record<string, unknown> }[][], money = await retainedMoney(f)
    const selected = ok<Slot>(await book(f.pair, { id: f.wedding, slot: photoSlot }, f.next))
    expect(selected.id).toBe(photoSlot); expect(selected.deal.id).not.toBe(f.oldDeal)
    expect(selected.deal).toMatchObject({ state: 'booked', vendor: { id: f.next.id }, price: { amount: 15000 }, packageName: 'Actual five bouquets', packageIncludes: ['Five bouquets', 'Delivery'] })
    expect((await app.db!.query('select category_id,deal_id from slots where id=$1', [photoSlot])).rows).toEqual([{ category_id: 'photo', deal_id: selected.deal.id }])
    expect((await app.db!.query('select category_id from vendors where id=$1', [f.next.id])).rows).toEqual([{ category_id: 'florist' }])
    expect((await app.db!.query('select deal_id from slots where id=$1', [f.slot])).rows).toEqual([{ deal_id: f.oldDeal }])
    expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1', [f.wedding])).rows).toEqual([{ n: 2 }])
    expect((await app.db!.query('select date::text,source,deal_id from vendor_busy_dates where vendor_id=$1', [f.next.id])).rows).toEqual([{ date: DATE, source: 'deal', deal_id: selected.deal.id }])
    expect(await retainedMoney(f)).toEqual(money)
    const after = await snapshot(f)
    // All pre-existing complete rows stay unchanged; only the explicitly empty
    // target slot changes, while the new booking legitimately adds new rows.
    for (const [index, rows] of before.entries()) expect(after[index]).toEqual(expect.arrayContaining(index === 3 ? rows.filter(r => r.row.id !== photoSlot) : rows))
  })
  it.each(['candidate', 'contacted', 'negotiating'] as const)('a real selected %s financial root can be cancelled and replaced', async state => {
    const f = await fixture(); await app.db!.query('update deals set state=$2 where id=$1', [f.oldDeal, state]); f.state = state
    const before = await retainedMoney(f); await positive(f, await replace(f)); expect(await retainedMoney(f)).toEqual(before)
  })
  it.each(['selected', 'state', 'done', 'cancelled'] as const)('stale or closed old %s refuses with whole-row rollback', async change => {
    const f = await fixture()
    if (change === 'done') await app.db!.query("update deals set state='done' where id=$1", [f.oldDeal])
    if (change === 'cancelled') ok(await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${f.slot}/cancel`, headers: headers(f.pair) }))
    await refused(f, () => replace(f, { ...body(f), ...(change === 'selected' ? { expectedSelectedDealId: randomUUID() } : change === 'state' ? { expectedSelectedDealState: 'negotiating' } : {}) }), change === 'selected' || change === 'cancelled' ? 'resource_order_slot_changed' : 'resource_order_source_changed')
  })
  it.each(['helper', 'coordinator', 'pseudoVendor', 'stranger'] as const)('current %s cannot use the replacement door', async role => { const f = await fixture(); await refused(f, () => replace(f, body(f), f[role]), role === 'stranger' ? 'not_found' : 'forbidden', role === 'stranger' ? 404 : 403) })
  it('a foreign scoped slot cannot be substituted into the own wedding path', async () => { const f = await fixture(), other = await wedding(f.stranger); f.weddingIds.push(other.id); await refused(f, () => replace(f, body(f), f.pair, randomUUID(), f.wedding, other.slot), 'not_found', 404) })
  it('conflicting prebooked selection refuses without erasing the retained original contract', async () => { const f = await fixture(); await app.db!.query('update slots set deal_id=null,prebooked_at=now() where id=$1', [f.slot]); await refused(f, () => replace(f), 'resource_order_slot_changed') })
  it('a selected additional-event position cannot silently become a day-wide legacy booking', async () => {
    const f = await fixture(), event = randomUUID()
    await app.db!.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone) values($1,$2,'Actual second-day program','second_day','2027-06-15','Europe/Moscow')", [event, f.wedding])
    await app.db!.query('update slots set program_event_id=$2 where id=$1', [f.slot, event])
    await refused(f, () => replace(f), 'additional_event_booking_pending')
  })
  it('a foreign active draft assignment on the selected position survives the rejected replacement rollback', async () => {
    const f = await fixture(), otherSlot = randomUUID(), otherDeal = randomUUID(), assignment = randomUUID()
    const existing = ok<OrderDto>(await app.inject({ url: `/deals/${f.oldDeal}/order`, headers: f.pair.headers })), own = existing.assignments[0]!
    ok(await app.inject({ method: 'POST', url: `/deals/${f.oldDeal}/order/assignments/${own.id}/cancel`, headers: headers(f.pair), payload: { expectedVersion: existing.version, expectedAssignmentVersion: own.version } }))
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Synthetic historical root position')", [otherSlot, f.wedding])
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'candidate',12000)", [otherDeal, f.wedding, otherSlot, f.third.id])
    // Valid scoped historical SQL fixture; the current assignment HTTP door
    // would refuse creation over an already selected different deal.
    await app.db!.query("insert into order_assignments(id,wedding_id,deal_id,slot_id,program_event_id,source,label,created_by) select $1,$2,$3,$4,id,'structured','Synthetic historical competing assignment',$5 from wedding_events where wedding_id=$2 and is_main", [assignment, f.wedding, otherDeal, f.slot, f.pair.id])
    await refused(f, () => replace(f), 'slot_assigned')
  })
  it.each(['zero', 'negative', 'fraction', 'currency', 'noncanonical_revision', 'overflow_revision', 'closed_state', 'actor_override', 'bad_package'] as const)('invalid %s input cannot cause any mutation', async kind => {
    const f = await fixture(), payload: Record<string, unknown> = { ...body(f) }
    if (kind === 'zero' || kind === 'negative' || kind === 'fraction') payload.price = { amount: kind === 'zero' ? 0 : kind === 'negative' ? -1 : 1.5, currency: 'RUB' }
    if (kind === 'currency') payload.price = { amount: 24000, currency: 'USD' }
    if (kind === 'noncanonical_revision') payload.expectedPolicyRevision = '00'
    if (kind === 'overflow_revision') payload.expectedPolicyRevision = '9223372036854775808'
    if (kind === 'closed_state') payload.expectedSelectedDealState = 'done'
    if (kind === 'actor_override') payload.actorId = f.old.owner.id
    if (kind === 'bad_package') payload.packageId = 'not-a-uuid'
    await refused(f, () => replace(f, payload), 'validation_failed', 422)
  })
  it('missing required Idempotency-Key refuses without cancelling old', async () => { const f = await fixture(); await refused(f, () => replace(f, body(f), f.pair, null), 'idempotency_key_required', 400) })
  it('an omitted package stays omitted and no package snapshot is invented for the new root', async () => {
    const f = await fixture(), command = body(f), before = await retainedMoney(f); delete command.packageId
    const selected = ok<Slot>(await replace(f, command)); expect(selected.deal.id).not.toBe(f.oldDeal)
    expect((await app.db!.query('select vendor_id,state,price::text,package_id,package_title_snapshot,package_includes_snapshot from deals where id=$1', [selected.deal.id])).rows).toEqual([{ vendor_id: f.next.id, state: 'booked', price: '24000', package_id: null, package_title_snapshot: null, package_includes_snapshot: null }])
    expect(await retainedMoney(f)).toEqual(before)
  })
  it('an explicitly chosen legacy policy revision is accepted, and an obsolete policy revision refuses before cancellation', async () => {
    const f = await fixture(); await resource(f.next); const enabled = await mode(f.next, 'resources'), legacy = await mode(f.next, 'legacy_day', enabled.revision)
    await refused(f, () => replace(f), 'order_version_conflict'); await positive(f, await replace(f, { ...body(f), expectedPolicyRevision: legacy.revision }))
  })
  it.each(['archived', 'cancelled'] as const)('a completed cache refuses an actual now-%s wedding scope', async change => {
    const f = await fixture(), key = randomUUID(); await positive(f, await replace(f, body(f), f.pair, key))
    await app.db!.query(change === 'archived' ? 'update weddings set archived_at=now() where id=$1' : 'update weddings set cancelled_at=now() where id=$1', [f.wedding])
    await refused(f, () => replace(f, body(f), f.pair, key), 'not_found', 404)
  })
  it.each(['new_mode', 'old_mode', 'old_ledger', 'old_downgrade', 'new_downgrade'] as const)('resource refusal %s preserves every actual old promise and counter', async kind => {
    const f = await fixture({ resourceOld: kind === 'old_ledger' || kind === 'old_downgrade' })
    let revision = '0'
    if (kind === 'new_mode' || kind === 'old_mode') { const target = kind === 'new_mode' ? f.next : f.old; await resource(target); const changed = await mode(target, 'resources'); if (kind === 'new_mode') revision = changed.revision }
    if (kind === 'old_downgrade') await mode(f.old, 'legacy_day', f.oldLedger!.policyRevision)
    if (kind === 'new_downgrade') { const other = await wedding(f.stranger); f.weddingIds.push(other.id); const held = await ledger(f.stranger, other, f.next); revision = (await mode(f.next, 'legacy_day', held.policyRevision)).revision }
    await refused(f, () => replace(f, { ...body(f), expectedPolicyRevision: revision }), 'resource_booking_required')
  })
  it('another old same-wedding holder retains the old company DATE and won lead after replacement', async () => {
    const f = await fixture(), secondSlot = randomUUID()
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Second actual service position')", [secondSlot, f.wedding])
    const holder = ok<Slot>(await book(f.pair, { id: f.wedding, slot: secondSlot }, f.old)), before = (await app.db!.query('select * from deals where id=$1', [holder.deal.id])).rows
    const originalDay = (await app.db!.query('select deal_id from vendor_busy_dates where vendor_id=$1', [f.old.id])).rows[0]!.deal_id; expect(originalDay).toBe(f.oldDeal)
    const result = ok<Slot>(await replace(f)); expect(result.deal.vendor?.id).toBe(f.next.id)
    expect((await app.db!.query('select date::text,source,deal_id from vendor_busy_dates where vendor_id=$1', [f.old.id])).rows).toEqual([{ date: DATE, source: 'deal', deal_id: holder.deal.id }])
    expect((await app.db!.query('select * from deals where id=$1', [holder.deal.id])).rows).toEqual(before); expect((await app.db!.query('select state from leads where vendor_id=$1 and wedding_id=$2', [f.old.id, f.wedding])).rows).toEqual([{ state: 'won' }])
  })
  it('a real SQL failure after observed cancellation rolls back all side effects and releases the exact claim', async () => {
    const f = await fixture(), before = await snapshot(f), db = app.db!, original = db.tx, forward = db.tx.bind(db); let cancelled = false, sqlstate: string | undefined
    db.tx = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => forward<T>(async c => {
      const wrapped: Queryable = { query: async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
        const result = await c.query<R>(sql, values)
        if (!cancelled && /update deals set state\s*=\s*'cancelled'/.test(sql) && values?.includes(f.oldDeal)) {
          expect((await c.query('select state from deals where id=$1', [f.oldDeal])).rows).toEqual([{ state: 'cancelled' }]); cancelled = true
          try { await c.query('select 1/0') } catch (e) { sqlstate = (e as { code?: string }).code; throw e }
        }
        return result
      } }
      return action(wrapped)
    })
    try { const r = await replace(f); expect(r.statusCode, r.body).toBe(500); privateFree(f, r); expect(cancelled).toBe(true); expect(sqlstate).toBe('22012'); expect(await snapshot(f)).toEqual(before) }
    finally { db.tx = original }
  })

  async function observe(change: string, holder: number, count = 1) {
    let observed: { pid: number; wait_event: string | null; query: string }[] = []
    for (let attempt = 0; attempt < 120; attempt++) {
      observed = (await app.db!.query<{ pid: number; wait_event: string | null; query: string }>(`select pid,wait_event,query from pg_stat_activity where datname=current_database()
        and pid<>pg_backend_pid() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) order by pid`, [holder])).rows
      if (observed.length === count) break
      await new Promise<void>(done => setTimeout(done, 25))
    }
    expect(observed, `${change}: exact live PostgreSQL waiters`).toHaveLength(count)
    for (const row of observed) waits.push({ change, holder, waiter: row.pid, event: row.wait_event, query: row.query })
    return observed
  }
  async function observeConcurrentWeddingTree(root: number) {
    type Row = { pid: number; state: string; wait_event_type: string | null; wait_event: string | null; blockers: number[]; query: string }
    const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ')
    const command = 'select id from weddings where id=$1 for update'
    let observed: (Row & { path: number[] })[] = []
    for (let attempt = 0; attempt < 120; attempt++) {
      // PostgreSQL can queue the second row-lock request behind the first.
      // Every edge below comes from this one actual activity snapshot.
      const graph = (await app.db!.query<Row>(`select pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,query
        from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
        and (wait_event_type='Lock' or pid=$1) order by pid`, [root])).rows
      const holder = graph.find(row => row.pid === root)
      const byPid = new Map(graph.map(row => [row.pid, row]))
      const pathToRoot = (pid: number, visited: ReadonlySet<number>): number[] | null => {
        if (visited.has(pid) || visited.size >= 64) return null
        if (pid === root) return holder && holder.state === 'idle in transaction'
          && normalize(holder.query) === 'select id from weddings where id=$1 for update' ? [root] : null
        const row = byPid.get(pid)
        if (!row || row.wait_event_type !== 'Lock' || normalize(row.query) !== command) return null
        const next = new Set(visited); next.add(pid)
        for (const blocker of row.blockers) {
          const rest = pathToRoot(blocker, next)
          if (rest) return [pid, ...rest]
        }
        return null
      }
      observed = graph.flatMap(row => {
        if (row.pid === root || row.wait_event_type !== 'Lock' || normalize(row.query) !== command) return []
        const path = pathToRoot(row.pid, new Set<number>())
        return path ? [{ ...row, path }] : []
      })
      if (observed.length === 2) break
      await new Promise<void>(done => setTimeout(done, 25))
    }
    expect(observed, 'concurrent distinct choices: exact actual weddings FOR UPDATE blocking tree').toHaveLength(2)
    expect(new Set(observed.map(row => row.pid)).size).toBe(2)
    for (const row of observed) waits.push({ change: 'concurrent distinct choices', root, directBlockers: row.blockers,
      path: row.path, waiter: row.pid, event: row.wait_event, query: row.query })
    return observed
  }
  async function waited(f: Fixture, change: string, lock: string, values: readonly unknown[], mutate: (c: Queryable) => Promise<unknown>, payload: object = body(f), replayKey?: string, action?: (key: string) => Promise<Reply>, route = 'slots.replace') {
    let release!: () => void, signal!: () => void, holderPid = 0, expected: unknown
    const permission = new Promise<void>(done => { release = done }), ready = new Promise<void>(done => { signal = done })
    const key = replayKey ?? randomUUID(), tracked = `${f.pair.id}:${route}:${key}`
    const holder = app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query(lock, values); signal(); await permission; await mutate(c)
      const claim = (await c.query('select status,body from idempotency_keys where key=$1', [tracked])).rows
      if (replayKey === undefined) {
        // Early auth/member waits can occur before claim insertion. At most
        // this exact tracked key may be transient; all other rows stay visible.
        expect(claim.length).toBeLessThanOrEqual(1)
        if (claim[0]) expect(claim).toEqual([{ status: null, body: null }])
        expected = await snapshot(f, c, tracked)
      } else { expect(claim).toHaveLength(1); expect(claim[0]!.status).toBe(200); expected = await snapshot(f, c) }
    })
    await Promise.race([ready, holder.then(() => { throw new Error(`${change}: holder completed before authorization wait`) })])
    const request = action ? action(key) : replace(f, payload, f.pair, key)
    try {
      const witness = (await observe(change, holderPid))[0]!
      release(); await holder; const response = await request
      if (replayKey === undefined) expect((await app.db!.query('select status,body from idempotency_keys where key=$1', [tracked])).rows).toEqual([])
      return { response, expected, query: witness.query }
    } finally { release(); await holder; await request }
  }
  it.each(['session', 'consent', 'account', 'membership', 'role'] as const)('current %s revocation after an observed PostgreSQL wait cannot cancel old', async change => {
    const f = await fixture()
    const lock = change === 'session' ? 'select id from sessions where id=$1 for update' : change === 'consent' ? 'select id from consents where user_id=$1 for update' : change === 'account' ? 'select id from users where id=$1 for update' : 'select user_id from wedding_members where wedding_id=$1 and user_id=$2 for update'
    const values = change === 'session' ? [f.pair.session] : change === 'consent' || change === 'account' ? [f.pair.id] : [f.wedding, f.pair.id]
    const outcome = await waited(f, `replacement ${change}`, lock, values, async c => {
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.pair.session])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [f.pair.id])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [f.pair.id])
      if (change === 'membership') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.pair.id])
      if (change === 'role') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.wedding, f.pair.id])
    })
    error(outcome.response, change === 'session' || change === 'account' ? 'unauthorized' : change === 'membership' ? 'not_found' : 'forbidden', change === 'session' || change === 'account' ? 401 : change === 'membership' ? 404 : 403)
    privateFree(f, outcome.response); expect(await snapshot(f)).toEqual(outcome.expected)
  })
  it.each(['session', 'consent', 'account', 'membership', 'role'] as const)('a completed cache cannot bypass current %s after its actual authorization wait', async change => {
    const f = await fixture(), key = randomUUID(); await positive(f, await replace(f, body(f), f.pair, key))
    const lock = change === 'session' ? 'select id from sessions where id=$1 for update' : change === 'consent' ? 'select id from consents where user_id=$1 for update' : change === 'account' ? 'select id from users where id=$1 for update' : 'select user_id from wedding_members where wedding_id=$1 and user_id=$2 for update'
    const values = change === 'session' ? [f.pair.session] : change === 'consent' || change === 'account' ? [f.pair.id] : [f.wedding, f.pair.id]
    const outcome = await waited(f, `replacement replay ${change}`, lock, values, async c => {
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.pair.session])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [f.pair.id])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [f.pair.id])
      if (change === 'membership') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.pair.id])
      if (change === 'role') await c.query("update wedding_members set role='coordinator' where wedding_id=$1 and user_id=$2", [f.wedding, f.pair.id])
    }, body(f), key)
    error(outcome.response, change === 'session' || change === 'account' ? 'unauthorized' : change === 'membership' ? 'not_found' : 'forbidden', change === 'session' || change === 'account' ? 401 : change === 'membership' ? 404 : 403)
    expect(outcome.response.headers['idempotent-replay']).toBeUndefined(); privateFree(f, outcome.response); expect(await snapshot(f)).toEqual(outcome.expected)
  })
  it.each(['blocked', 'unpublished', 'erased_owner', 'changed_owner', 'changed_category', 'missing_package', 'resources_policy', 'policy_revision'] as const)('current new-company %s after a real source wait refuses with exact old rollback', async change => {
    const f = await fixture(), newOwner = change === 'changed_owner' ? await actor() : null
    if (newOwner) f.accountIds.push(newOwner.id)
    let revision = '0'
    if (change === 'resources_policy' || change === 'policy_revision') { await resource(f.next); const enabled = await mode(f.next, 'resources'); revision = (await mode(f.next, 'legacy_day', enabled.revision)).revision }
    // Actual policy writers pin company UPDATE before policy UPDATE. Hold that
    // same company mutex so mutation never fabricates an inverse lock cycle.
    const lock = change === 'missing_package' ? 'select id from vendor_packages where id=$1 for update' : change === 'erased_owner' ? 'select id from users where id=$1 for update' : 'select id from vendors where id=$1 for update'
    const values = [change === 'missing_package' ? f.next.packageId : change === 'erased_owner' ? f.next.owner.id : f.next.id]
    const outcome = await waited(f, `replacement source ${change}`, lock, values, async c => {
      if (change === 'blocked') await c.query('update vendors set blocked_at=now() where id=$1', [f.next.id])
      if (change === 'unpublished') await c.query('update vendors set published_at=null where id=$1', [f.next.id])
      if (change === 'erased_owner') await c.query('update users set deleted_at=now() where id=$1', [f.next.owner.id])
      if (change === 'changed_owner') await c.query('update vendors set user_id=$2 where id=$1', [f.next.id, newOwner!.id])
      if (change === 'changed_category') await c.query("update vendors set category_id='photo' where id=$1", [f.next.id])
      if (change === 'missing_package') await c.query('delete from vendor_packages where id=$1', [f.next.packageId])
      if (change === 'resources_policy' || change === 'policy_revision') {
        const enabled = await setAvailabilityPolicy(c, { vendorId: f.next.id, actor: { userId: f.next.owner.id, sessionId: f.next.owner.session, policyVersion: POLICY }, mode: 'resources', expectedRevision: revision })
        if (change === 'policy_revision') await setAvailabilityPolicy(c, { vendorId: f.next.id, actor: { userId: f.next.owner.id, sessionId: f.next.owner.session, policyVersion: POLICY }, mode: 'legacy_day', expectedRevision: enabled.revision })
      }
    }, { ...body(f), expectedPolicyRevision: revision })
    const code = change === 'missing_package' ? 'unknown_package' : change === 'changed_category' ? 'validation_failed' : change === 'changed_owner' ? 'resource_source_changed' : change === 'resources_policy' ? 'resource_booking_required' : change === 'policy_revision' ? 'order_version_conflict' : 'not_found'
    error(outcome.response, code, change === 'missing_package' || change === 'changed_category' ? 422 : change === 'changed_owner' || change === 'resources_policy' || change === 'policy_revision' ? 409 : 404)
    if (change === 'changed_category') vendorField(outcome.response)
    privateFree(f, outcome.response); expect(await snapshot(f)).toEqual(outcome.expected)
    expect(outcome.query).toMatch(change === 'missing_package' ? /vendor_packages/ : change === 'erased_owner' ? /users/ : /vendors/)
  })
  it('existing public book retains intentional compatibility after an actual company-category wait', async () => {
    const f = await fixture({ paid: true }), empty = randomUUID(), key = randomUUID(), tracked = `${f.pair.id}:slots.book:${key}`, money = await retainedMoney(f)
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Actual empty floral position')", [empty, f.wedding])
    let release!: () => void, ready!: () => void, holderPid = 0, before: { row: Record<string, unknown> }[][] = []
    const permission = new Promise<void>(done => { release = done }), acquired = new Promise<void>(done => { ready = done })
    const holder = app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query('select id from vendors where id=$1 for update', [f.next.id]); ready(); await permission
      await c.query("update vendors set category_id='photo' where id=$1", [f.next.id])
      expect((await c.query('select status,body from idempotency_keys where key=$1', [tracked])).rows).toEqual([{ status: null, body: null }])
      before = await snapshot(f, c, tracked) as { row: Record<string, unknown> }[][]
    })
    await acquired
    const request = app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${empty}/book`, headers: headers(f.pair, key), payload: { vendorId: f.next.id, packageId: f.next.packageId, price: { amount: 24000, currency: 'RUB' } } })
    try {
      const observed = await observe('public book compatible current category', holderPid); expect(observed[0]!.query).toMatch(/vendors/)
      release(); await holder; const response = await request, selected = ok<Slot>(response)
      expect(selected.id).toBe(empty); expect(selected.deal.id).not.toBe(f.oldDeal)
      expect(selected.deal).toMatchObject({ state: 'booked', vendor: { id: f.next.id }, price: { amount: 24000 }, packageName: 'Actual five bouquets', packageIncludes: ['Five bouquets', 'Delivery'] })
      expect((await app.db!.query('select category_id from vendors where id=$1', [f.next.id])).rows).toEqual([{ category_id: 'photo' }])
      expect((await app.db!.query('select category_id,deal_id from slots where id=$1', [empty])).rows).toEqual([{ category_id: 'florist', deal_id: selected.deal.id }])
      expect((await app.db!.query('select deal_id from slots where id=$1', [f.slot])).rows).toEqual([{ deal_id: f.oldDeal }])
      expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1', [f.wedding])).rows).toEqual([{ n: 2 }])
      expect((await app.db!.query('select date::text,source,deal_id from vendor_busy_dates where vendor_id=$1', [f.next.id])).rows).toEqual([{ date: DATE, source: 'deal', deal_id: selected.deal.id }])
      expect((await app.db!.query('select status,body from idempotency_keys where key=$1', [tracked])).rows).toEqual([{ status: 200, body: response.json() }])
      expect(await retainedMoney(f)).toEqual(money)
      const after = await snapshot(f)
      // Keep every pre-existing row, including the actual changed profile;
      // exclude only the one target slot and the explicitly tracked NULL claim.
      for (const [index, rows] of before.entries()) expect(after[index]).toEqual(expect.arrayContaining(index === 3 ? rows.filter(r => r.row.id !== empty) : rows))
    } finally { release(); await holder; await request }
  })
  it('two concurrent choices for one selected slot produce exactly one cancellation and one new root', async () => {
    const f = await fixture(), financial = await retainedMoney(f); let release!: () => void, ready!: () => void, holderPid = 0
    const permission = new Promise<void>(done => { release = done }), acquired = new Promise<void>(done => { ready = done })
    const holder = app.db!.tx(async c => { holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid; await c.query('select id from weddings where id=$1 for update', [f.wedding]); ready(); await permission })
    await acquired; const first = replace(f), second = replace(f, body(f, f.third))
    const early: Record<string, { state: string; status?: number; body?: string }> = { first: { state: 'pending' }, second: { state: 'pending' } }
    const diagnosticBody = (r: Reply) => r.body.replace(/("(?:authorization|accessToken|refreshToken|readToken|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]').slice(0, 4096)
    for (const [name, request] of [['first', first], ['second', second]] as const) void request.then(
      r => { early[name] = { state: 'settled', status: r.statusCode, body: diagnosticBody(r) } },
      () => { early[name] = { state: 'rejected' } },
    )
    try {
      try { await observeConcurrentWeddingTree(holderPid) }
      catch (failure) {
        // Capture the actual graph before releasing the holder. A request may
        // wait on another waiter or have answered early; neither is inferred.
        const graph = (await app.db!.query(`select pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,left(query,2048) query
          from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
          and (wait_event_type='Lock' or pid=$1) order by pid`, [holderPid])).rows
        process.stdout.write(`ATOMIC_LEGACY_CONCURRENT_WAIT_DIAGNOSTIC ${JSON.stringify({ root: holderPid, expectedWeddingTreeWaiters: 2, graph, earlyResponses: early })}\n`)
        throw failure
      }
      release(); await holder
      const results = await Promise.all([first, second]); expect(results.map(r => r.statusCode).sort()).toEqual([200, 409])
      const success = results.find(r => r.statusCode === 200)!, refused = results.find(r => r.statusCode === 409)!; error(refused, 'resource_order_slot_changed')
      const winner = ok<Slot>(success); expect([f.next.id, f.third.id]).toContain(winner.deal.vendor!.id)
      expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1', [f.wedding])).rows).toEqual([{ n: 2 }])
      expect((await app.db!.query("select count(*)::int n from deal_events where deal_id=$1 and to_state='cancelled'", [f.oldDeal])).rows).toEqual([{ n: 1 }])
      expect((await app.db!.query('select deal_id from slots where id=$1', [f.slot])).rows).toEqual([{ deal_id: winner.deal.id }]); expect(await retainedMoney(f)).toEqual(financial)
    } finally { release(); await holder; await first; await second }
  })
  it('a concurrent duplicate key cannot execute another cancellation while the first actual command waits', async () => {
    const f = await fixture(), key = randomUUID(), tracked = cacheKey(f, key), baseline = await snapshot(f); let release!: () => void, ready!: () => void, holderPid = 0
    const permission = new Promise<void>(done => { release = done }), acquired = new Promise<void>(done => { ready = done })
    const holder = app.db!.tx(async c => { holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid; await c.query('select id from weddings where id=$1 for update', [f.wedding]); ready(); await permission })
    await acquired; const first = replace(f, body(f), f.pair, key)
    try {
      await observe('concurrent same-key claim', holderPid)
      expect((await app.db!.query('select status,body from idempotency_keys where key=$1', [tracked])).rows).toEqual([{ status: null, body: null }])
      const duplicate = await replace(f, body(f), f.pair, key); error(duplicate, 'idempotency_in_progress')
      expect(await snapshot(f, app.db!, tracked)).toEqual(baseline)
      release(); await holder; const result = await first; await positive(f, result)
      const beforeReplay = await snapshot(f), replay = await replace(f, body(f), f.pair, key); expect(replay.json()).toEqual(result.json()); expect(replay.headers['idempotent-replay']).toBe('true'); expect(await snapshot(f)).toEqual(beforeReplay)
    } finally { release(); await holder; await first }
  })
  it('two opposite replacements of already held foreign DATEs refuse without releasing either original wedding promise', async () => {
    const a = await fixture(), b = await fixture()
    for (const f of [a, b]) { f.weddingIds = [...new Set([...a.weddingIds, ...b.weddingIds])]; f.accountIds = [...new Set([...a.accountIds, ...b.accountIds])]; f.companyIds = [...new Set([...a.companyIds, ...b.companyIds])] }
    const baseline = await snapshot(a); let release!: () => void, ready!: () => void, holderPid = 0
    const permission = new Promise<void>(done => { release = done }), acquired = new Promise<void>(done => { ready = done })
    const holder = app.db!.tx(async c => { holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid; await c.query('select id from vendors where id=any($1::uuid[]) order by id for update', [[a.old.id, b.old.id]]); ready(); await permission })
    await acquired; const first = replace(a, body(a, b.old)), second = replace(b, body(b, a.old))
    try {
      await observe('opposite foreign DATE choices', holderPid, 2); release(); await holder
      error(await first, 'date_taken'); error(await second, 'date_taken'); expect(await snapshot(a)).toEqual(baseline)
    } finally { release(); await holder; await first; await second }
  })
})
