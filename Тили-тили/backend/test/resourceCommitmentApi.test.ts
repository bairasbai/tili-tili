import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { disposablePgPort } from './disposablePgPort.js'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import type { OrderDto } from '../src/orders/model.js'
import type { ResourcePlanView, ResourcePlanLineInput } from '../src/orders/resource-plan.js'
import type { TermsView } from '../src/orders/terms.js'
import type { ResourceOrderPreparationResult } from '../src/orders/resource-order.js'
import type { CommitmentView } from '../src/resources/commitments.js'

const DATABASE = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'registered-commitment-http-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
type Reply = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }
type CommitBody = { expectedOrderVersion: string; expectedCommitmentRevision: string; termsId: string;
  expectedTermsVersion: string; termsDigest: string; planRevisionId: string; expectedPolicyRevision: string }

describe.skipIf(!DATABASE)('registered resource preparation and agreed commitment API with actual PostgreSQL', () => {
  let app: FastifyInstance
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>(), resources = new Set<string>()
  const waits: { change: string; holder: number; waiter: number; event: string | null; query: string }[] = []
  const prefix = String(randomInt(100_000, 999_999)); let sequence = 0
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_full_20260930_test', '/tili_ecosystem_allocations_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'registered-commitment-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name,current_user principal')).rows[0]!
    expect(['127.0.0.1', '::1']).toContain(live.address); expect(live.port).toBe(Number(disposablePgPort()))
    expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
  })
  afterEach(async () => {
    if (!app) return
    // Keep every owned ID for the final survivor oracle; each case creates fresh fixtures.
    // Whole-wedding cascades retain the native immutable-history deletion guards.
    const started = Date.now()
    await app.db!.query('delete from weddings where id=any($1::uuid[])', [[...weddings]])
    await app.db!.query('delete from vendor_resources where id=any($1::uuid[])', [[...resources]])
    await app.db!.query('delete from vendors where id=any($1::uuid[])', [[...vendors]])
    await app.db!.query('delete from resource_conflict_keys where identity=any($1::uuid[])', [[...users, ...resources]])
    const ownedUsers = [...users]
    for (let offset = 0; offset < ownedUsers.length; offset += 32) {
      await app.db!.query('delete from users where id=any($1::uuid[])', [ownedUsers.slice(offset, offset + 32)])
    }
    process.stdout.write(`RESOURCE_COMMITMENT_API_CASE_CLEANUP ${JSON.stringify({ completed: true, elapsedMs: Date.now() - started })}\n`)
  })
  afterAll(async () => {
    if (!app) return
    try {
      process.stdout.write(`RESOURCE_COMMITMENT_API_PG_WAITS count=${waits.length} ${JSON.stringify(waits)}\n`)
      process.stdout.write(`RESOURCE_COMMITMENT_API_FIXTURE_MANIFEST ${JSON.stringify({ database: new URL(DATABASE!).pathname.slice(1),
        users: [...users], weddings: [...weddings], vendors: [...vendors], resources: [...resources] })}\n`)
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      await app.db!.query('delete from vendor_resources where id=any($1::uuid[])', [[...resources]])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      await app.db!.query('delete from resource_conflict_keys where identity=any($1::uuid[])', [[...users, ...resources]])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
      for (const [table, ids] of [['weddings', weddings], ['vendor_resources', resources], ['vendors', vendors], ['users', users]] as const) {
        expect((await app.db!.query<{ remaining: number }>(`select count(*)::int remaining from ${table} where id=any($1::uuid[])`, [[...ids]])).rows[0]!.remaining, table).toBe(0)
      }
      expect((await app.db!.query<{ remaining: number }>('select count(*)::int remaining from resource_conflict_keys where identity=any($1::uuid[])', [[...users, ...resources]])).rows[0]!.remaining).toBe(0)
    } finally { await app.close() }
  })
  async function actor() {
    const id = randomUUID(), session = randomUUID(); users.add(id)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic commitment API actor')", [id, `+79${prefix}${String(++sequence).padStart(4, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, session, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const headers = (a: Actor, key: string | null = randomUUID()) => ({ ...a.headers, ...(key === null ? {} : { 'idempotency-key': key }) })
  function ok<T>(r: Reply): T { expect(r.statusCode, r.body).toBe(200); return r.json<T>() }
  function error(r: Reply, code: string, status = 409) {
    expect(r.statusCode, r.body).toBe(status); expect(r.json<{ error: { code: string } }>().error.code).toBe(code)
  }
  async function fixture() {
    const pair = await actor(), owner = await actor(), helper = await actor(), manager = await actor(), pseudoVendor = await actor(), stranger = await actor()
    const wedding = randomUUID(), vendor = randomUUID(), slot = randomUUID(), packageId = randomUUID()
    weddings.add(wedding); vendors.add(vendor)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic commitment API wedding','2027-06-14','Europe/Moscow',$3)", [wedding, pair.id, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper'),($1,$4,'vendor')", [wedding, pair.id, helper.id, pseudoVendor.id])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic commitment studio',now())", [vendor, owner.id])
    // Synthetic current staff history exercises ACL, not invitation UX or a fabricated agreement.
    await app.db!.query(`insert into vendor_staff_members(id,vendor_id,user_id,state,role,invite_token_hash,invite_expires_at,invited_by,accepted_at,accepted_session_id)
      values($1,$2,$3,'active','resource_manager',$4,now()+interval '1 day',$5,now(),$6)`,
    [randomUUID(), vendor, manager.id, createHash('sha256').update(randomUUID()).digest('hex'), owner.id, manager.session])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Actual compositions position')", [slot, wedding])
    await app.db!.query("insert into vendor_packages(id,vendor_id,name,price,items) values($1,$2,'Actual five compositions',15000,$3::jsonb)", [packageId, vendor, JSON.stringify(['Five compositions', 'Delivery'])])
    const equipment = ok<{ id: string; version: string }>(await app.inject({ method: 'POST', url: `/vendors/${vendor}/resources`, headers: headers(owner), payload: { kind: 'equipment', label: 'Private vase set' } })); resources.add(equipment.id)
    const capacity = ok<{ id: string; version: string }>(await app.inject({ method: 'POST', url: `/vendors/${vendor}/resources`, headers: headers(owner), payload: { kind: 'capacity', label: 'Private production capacity', capacityUnit: 'compositions' } })); resources.add(capacity.id)
    const window = ok<{ id: string; version: string }>(await app.inject({ method: 'POST', url: `/vendors/${vendor}/resources/${capacity.id}/windows`, headers: headers(owner),
      payload: { startsAt: '2027-06-12T00:00:00Z', endsAt: '2027-06-18T23:00:00Z', capacity: 10 } }))
    const policy = ok<{ revision: string }>(await app.inject({ method: 'PATCH', url: `/vendors/${vendor}/availability-policy`, headers: headers(owner), payload: { mode: 'resources', expectedRevision: '0' } }))
    return { pair, owner, helper, manager, pseudoVendor, stranger, wedding, vendor, slot, packageId, equipment, capacity, window, policy }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const prepareBody = (f: Fixture) => ({ vendorId: f.vendor, packageId: f.packageId, expectedSelectedDealId: null as string | null, expectedPolicyRevision: f.policy.revision })
  const prepare = (f: Fixture, selected = f.pair, key: string | null = randomUUID(), payload: object = prepareBody(f), wedding = f.wedding, slot = f.slot) =>
    app.inject({ method: 'POST', url: `/weddings/${wedding}/slots/${slot}/resource-order`, headers: headers(selected, key), payload })
  const policyRead = (f: Fixture, selected = f.stranger) => app.inject({ url: `/vendors/${f.vendor}/booking-policy`, headers: selected.headers })
  const root = (deal: string) => `/deals/${deal}/order`
  const readCommit = (f: Fixture, deal: string, selected = f.pair) => app.inject({ url: `${root(deal)}/resource-commitments`, headers: selected.headers })
  const readPlan = (f: Fixture, deal: string, selected = f.pair) => app.inject({ url: `${root(deal)}/resource-plan`, headers: selected.headers })
  const commit = (f: Fixture, deal: string, body: object, replacement = false, selected = f.pair, key: string | null = randomUUID()) =>
    app.inject({ method: 'POST', url: `${root(deal)}/resource-commitments${replacement ? '/replace' : ''}`, headers: headers(selected, key), payload: body })
  function privateFree(f: Fixture, reply: Reply) {
    for (const id of [f.capacity.id, f.equipment.id, f.window.id, f.owner.id, f.manager.id]) expect(reply.body).not.toContain(id)
    for (const field of ['allocationId', 'resourceId', 'capacityWindowId', 'personUserId', 'staffMemberId', 'conflictIdentity']) expect(reply.body).not.toContain(`"${field}"`)
  }
  function safeCommit(f: Fixture, reply: Reply): CommitmentView {
    const view = ok<CommitmentView>(reply); expect(Object.keys(view).sort()).toEqual(['planRevisionId', 'reservation', 'revision', 'state', 'termsId'])
    privateFree(f, reply); expect(reply.headers['cache-control']).toBe('no-store'); return view
  }
  async function snapshot(f: Fixture, c: Queryable = app.db!) {
    const ids = [f.pair.id, f.owner.id, f.helper.id, f.manager.id, f.pseudoVendor.id, f.stranger.id]
    const tables = [
      ['weddings', 'id=$1', [f.wedding]], ['wedding_events', 'wedding_id=$1', [f.wedding]],
      ['timeline_events', 'wedding_id=$1', [f.wedding]], ['tasks', 'wedding_id=$1', [f.wedding]],
      ['slots', 'wedding_id=$1', [f.wedding]], ['deals', 'wedding_id=$1', [f.wedding]],
      ['payments', 'deal_id in(select id from deals where wedding_id=$1)', [f.wedding]],
      ['payment_installments', 'deal_id in(select id from deals where wedding_id=$1)', [f.wedding]],
      ['deal_events', 'deal_id in(select id from deals where wedding_id=$1)', [f.wedding]],
      ['vendor_busy_dates', 'vendor_id=$1', [f.vendor]], ['leads', 'wedding_id=$1', [f.wedding]],
      ['offer_requests', 'slot_id in(select id from slots where wedding_id=$1)', [f.wedding]],
      ['offers', 'request_id in(select r.id from offer_requests r join slots s on s.id=r.slot_id where s.wedding_id=$1)', [f.wedding]],
      ['notifications', 'user_id=any($1::uuid[])', [ids]], ['idempotency_keys', 'user_id=any($1::uuid[])', [ids]],
      ['deal_orders', 'wedding_id=$1', [f.wedding]], ['order_parts', 'wedding_id=$1', [f.wedding]], ['order_assignments', 'wedding_id=$1', [f.wedding]],
      ['deal_resource_plan_versions', 'wedding_id=$1', [f.wedding]], ['deal_terms_versions', 'wedding_id=$1', [f.wedding]], ['deal_terms_receipts', 'wedding_id=$1', [f.wedding]],
      ['deal_resource_commitments', 'wedding_id=$1', [f.wedding]], ['deal_resource_commitment_versions', 'wedding_id=$1', [f.wedding]],
      ['resource_allocations', 'wedding_id=$1 or vendor_id=$2', [f.wedding, f.vendor]], ['deal_resource_commitment_members', 'wedding_id=$1', [f.wedding]],
      ['vendor_resources', 'vendor_id=$1', [f.vendor]], ['resource_capacity_windows', 'resource_id in(select id from vendor_resources where vendor_id=$1)', [f.vendor]],
      ['vendor_availability_policy', 'vendor_id=$1', [f.vendor]], ['vendor_packages', 'vendor_id=$1', [f.vendor]],
      ['audit_log', 'actor_id=any($1::uuid[]) or entity_id=$2', [ids, f.wedding]],
      ['vendor_program_acknowledgments', 'wedding_id=$1', [f.wedding]],
      ['resource_conflict_keys', 'identity=any($1::uuid[])', [[...ids, f.capacity.id, f.equipment.id]]],
      ['users', 'id=any($1::uuid[])', [ids]], ['sessions', 'user_id=any($1::uuid[])', [ids]], ['consents', 'user_id=any($1::uuid[])', [ids]],
      ['wedding_members', 'wedding_id=$1', [f.wedding]], ['vendors', 'id=$1', [f.vendor]], ['vendor_staff_members', 'vendor_id=$1', [f.vendor]],
    ] as const
    const result: unknown[] = []
    // Static table/where literals only. Stable whole rows include cache NULLs,
    // counters, receipts and immutable histories, with one query per client.
    for (const [table, where, values] of tables) result.push((await c.query(`select to_jsonb(t) row from ${table} t where ${where} order by to_jsonb(t)::text`, values)).rows)
    return result
  }
  async function refused(f: Fixture, action: () => Promise<Reply>, code: string, status = 409) {
    const before = await snapshot(f), reply = await action(); error(reply, code, status); privateFree(f, reply); expect(await snapshot(f)).toEqual(before)
    return reply
  }
  async function money(f: Fixture, deal: string) {
    const financial = (await app.db!.query("select to_jsonb(d)-'state'-'booked_at'-'done_at'-'cancelled_at'-'cancel_reason'-'negotiating_until' financial from deals d where id=$1", [deal])).rows
    const payments = (await app.db!.query('select * from payments where deal_id=$1 order by id', [deal])).rows
    const installments = (await app.db!.query('select * from payment_installments where deal_id=$1 order by id', [deal])).rows
    const program = (await app.db!.query('select * from wedding_events where wedding_id=$1 order by id', [f.wedding])).rows
    return { financial, payments, installments, program }
  }
  async function draft(f: Fixture) {
    const selected = ok<ResourceOrderPreparationResult>(await prepare(f))
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',1000,'recorded','cash','private')", [randomUUID(), selected.dealId])
    const part = ok<OrderDto>(await app.inject({ method: 'POST', url: `${root(selected.dealId)}/parts`, headers: headers(f.owner),
      payload: { expectedVersion: selected.orderVersion, kind: 'deliverable', assignmentId: null, title: 'Actual compositions delivery', details: { dueAt: '2027-06-15T12:00:00Z' } } }))
    return { deal: selected.dealId, partId: part.parts[0]!.id }
  }
  type Draft = Awaited<ReturnType<typeof draft>>
  async function plan(f: Fixture, d: Draft, quantity = 5, day = 13, equipment = false) {
    const current = ok<ResourcePlanView>(await readPlan(f, d.deal, f.owner))
    const line: ResourcePlanLineInput = { partId: d.partId, resourceId: equipment ? f.equipment.id : f.capacity.id,
      capacityWindowId: equipment ? null : f.window.id, quantity: equipment ? 1 : quantity,
      startsAt: `2027-06-${day}T07:00:00Z`, endsAt: `2027-06-${day}T09:00:00Z`, timeZone: 'Europe/Moscow',
      setupMinutes: 10, teardownMinutes: 15, travelBeforeMinutes: 20, travelAfterMinutes: 25 }
    return ok<ResourcePlanView>(await app.inject({ method: 'PATCH', url: `${root(d.deal)}/resource-plan`, headers: headers(f.owner),
      payload: { expectedVersion: current.orderVersion, expectedPlanRevision: current.revision, lines: [line] } }))
  }
  async function agree(f: Fixture, d: Draft, saved: ResourcePlanView, count = 2) {
    const previous = ok<TermsView>(await app.inject({ url: `${root(d.deal)}/terms`, headers: f.pair.headers }))
    const proposed = ok<TermsView>(await app.inject({ method: 'POST', url: `${root(d.deal)}/terms/proposals`, headers: headers(f.pair),
      payload: { expectedOrderVersion: saved.orderVersion, expectedTermsRevision: previous.revision } }))
    expect(proposed.selected!.snapshot.schemaVersion).toBe(2); expect(proposed.selected!.snapshot.resourcePlan).toEqual(saved.current)
    for (const person of [f.pair, f.owner].slice(0, count)) {
      const read = ok<TermsView>(await app.inject({ url: `${root(d.deal)}/terms`, headers: person.headers }))
      expect(read.readToken).toBeTypeOf('string')
      ok<TermsView>(await app.inject({ method: 'POST', url: `${root(d.deal)}/terms/${read.selected!.id}/accept`, headers: headers(person),
        payload: { expectedTermsVersion: read.selected!.version, digest: read.selected!.digest, readToken: read.readToken } }))
    }
    const actual = ok<TermsView>(await app.inject({ url: `${root(d.deal)}/terms`, headers: f.pair.headers }))
    if (count === 2) {
      expect(actual.agreedTermsId).toBe(actual.selected!.id)
      expect(new Set(actual.selected!.receipts.map(r => r.userId)).size).toBe(2)
      expect(new Set(actual.selected!.receipts.map(r => r.sessionId)).size).toBe(2)
      expect(actual.selected!.receipts.map(r => r.party).sort()).toEqual(['customer', 'performer'])
    }
    const body: CommitBody = { expectedOrderVersion: saved.orderVersion, expectedCommitmentRevision: '0', termsId: actual.selected!.id,
      expectedTermsVersion: actual.selected!.version, termsDigest: actual.selected!.digest, planRevisionId: saved.current!.planRevisionId, expectedPolicyRevision: f.policy.revision }
    return body
  }
  async function agreed(f: Fixture, quantity = 5, equipment = false, count = 2) {
    const d = await draft(f), saved = await plan(f, d, quantity, 13, equipment), body = await agree(f, d, saved, count)
    return { ...d, saved, body }
  }

  it('booking policy exposes exactly mode/revision, no-store and no private availability claims', async () => {
    const f = await fixture(), response = await policyRead(f)
    expect(ok(response)).toEqual({ mode: 'resources', revision: '1' }); expect(response.headers['cache-control']).toBe('no-store'); privateFree(f, response)
    await app.db!.query('delete from vendor_availability_policy where vendor_id=$1', [f.vendor])
    expect(ok(await policyRead(f))).toEqual({ mode: 'legacy_day', revision: '0' })
  })
  it.each(['unpublished', 'blocked', 'erased'] as const)('safe policy refuses a currently %s company without exposing its source', async change => {
    const f = await fixture()
    if (change === 'unpublished') await app.db!.query('update vendors set published_at=null where id=$1', [f.vendor])
    if (change === 'blocked') await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendor])
    if (change === 'erased') await app.db!.query('update users set deleted_at=now() where id=$1', [f.owner.id])
    await refused(f, () => policyRead(f), 'not_found', 404)
  })
  it('actual preparation creates one package-backed financial draft and retries without dates, allocations or notifications', async () => {
    const f = await fixture(), key = randomUUID(), before = await snapshot(f), first = await prepare(f, f.pair, key), result = ok<ResourceOrderPreparationResult>(first)
    expect(result).toMatchObject({ state: 'candidate', created: true, orderVersion: '1' }); expect(Object.keys(result).sort()).toEqual(['created', 'dealId', 'orderVersion', 'state'])
    expect(first.headers['cache-control']).toBe('no-store')
    expect(ok(await prepare(f, f.pair, key))).toEqual(result)
    const selected = ok<ResourceOrderPreparationResult>(await prepare(f, f.pair, randomUUID(), { ...prepareBody(f), expectedSelectedDealId: result.dealId }))
    expect(selected).toEqual({ ...result, created: false })
    expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1', [f.wedding])).rows).toEqual([{ n: 1 }])
    expect((await app.db!.query('select price::text,package_id,package_title_snapshot,package_includes_snapshot from deals where id=$1', [result.dealId])).rows)
      .toEqual([{ price: '15000', package_id: f.packageId, package_title_snapshot: 'Actual five compositions', package_includes_snapshot: ['Five compositions', 'Delivery'] }])
    const after = await snapshot(f)
    for (const index of [1, 2, 3, 6, 7, 9, 10, 11, 12, 13, 23, 26]) expect(after[index]).toEqual(before[index])
    expect(safeCommit(f, await readCommit(f, result.dealId))).toEqual({ revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' })
  })
  it('package-free preparation keeps price and package snapshot genuinely NULL', async () => {
    const f = await fixture(), selected = ok<ResourceOrderPreparationResult>(await prepare(f, f.pair, randomUUID(), { ...prepareBody(f), packageId: null }))
    expect((await app.db!.query('select price,package_id,package_title_snapshot,package_includes_snapshot from deals where id=$1', [selected.dealId])).rows)
      .toEqual([{ price: null, package_id: null, package_title_snapshot: null, package_includes_snapshot: null }])
  })
  it('prepared replay reads current draft order/state while immutable selected financial quote survives catalogue changes', async () => {
    const f = await fixture(), key = randomUUID(), selected = ok<ResourceOrderPreparationResult>(await prepare(f, f.pair, key))
    const before = await money(f, selected.dealId)
    ok(await app.inject({ method: 'POST', url: `${root(selected.dealId)}/parts`, headers: headers(f.owner), payload: { expectedVersion: selected.orderVersion, kind: 'deliverable', assignmentId: null, title: 'Actual draft update', details: {} } }))
    await app.db!.query("update vendor_packages set name='Changed catalogue',price=25000,items=$2::jsonb where id=$1", [f.packageId, JSON.stringify(['Changed public quote'])])
    await app.db!.query("update deals set state='contacted' where id=$1", [selected.dealId])
    const current = ok<ResourceOrderPreparationResult>(await prepare(f, f.pair, key))
    expect(current).toEqual({ ...selected, state: 'contacted', orderVersion: '2' }); expect(await money(f, selected.dealId)).toEqual(before)
    const cached = (await app.db!.query('select body from idempotency_keys where user_id=$1 and route=$2', [f.pair.id, '/weddings/:weddingId/slots/:slotId/resource-order'])).rows[0]!.body
    expect(cached).toEqual(selected)
  })
  it('two simultaneous same-key registered preparations produce exactly one selected financial root', async () => {
    const f = await fixture(), key = randomUUID(), responses = await Promise.all([prepare(f, f.pair, key), prepare(f, f.pair, key)])
    const a = ok<ResourceOrderPreparationResult>(responses[0]!), b = ok<ResourceOrderPreparationResult>(responses[1]!)
    expect(a).toEqual(b); expect((await app.db!.query('select id from deals where wedding_id=$1', [f.wedding])).rows).toEqual([{ id: a.dealId }])
  })
  it('preparation does not prune an exact unrelated own actor cache row older than a day', async () => {
    const f = await fixture(), key = `synthetic-unrelated-${randomUUID()}`
    await app.db!.query("insert into idempotency_keys(key,user_id,route,request_hash,status,body,created_at) values($1,$2,'synthetic.private',$3,200,$4::jsonb,now()-interval '2 days')", [key, f.stranger.id, 'a'.repeat(64), JSON.stringify({ private: true })])
    const before = (await app.db!.query('select * from idempotency_keys where key=$1', [key])).rows
    ok(await prepare(f)); expect((await app.db!.query('select * from idempotency_keys where key=$1', [key])).rows).toEqual(before)
  })
  it.each(['actor', 'sessionId', 'policyVersion', 'price', 'dealId'] as const)('preparation rejects untrusted extra %s instead of accepting caller authority/money', async field => {
    const f = await fixture(); await refused(f, () => prepare(f, f.pair, randomUUID(), { ...prepareBody(f), [field]: field === 'price' ? 1 : f.owner.id }), 'validation_failed', 422)
  })
  it.each(['missing_key', 'zero_policy', 'missing_package', 'foreign_slot', 'helper', 'stranger'] as const)('preparation rejects %s before any root/cache/history mutation', async kind => {
    const f = await fixture()
    if (kind === 'missing_key') await refused(f, () => prepare(f, f.pair, null), 'idempotency_key_required', 400)
    if (kind === 'zero_policy') await refused(f, () => prepare(f, f.pair, randomUUID(), { ...prepareBody(f), expectedPolicyRevision: '0' }), 'validation_failed', 422)
    if (kind === 'missing_package') await refused(f, () => prepare(f, f.pair, randomUUID(), { ...prepareBody(f), packageId: randomUUID() }), 'unknown_package', 422)
    if (kind === 'foreign_slot') { const other = await fixture(); await refused(f, () => prepare(f, f.pair, randomUUID(), prepareBody(f), f.wedding, other.slot), 'not_found', 404) }
    if (kind === 'helper') await refused(f, () => prepare(f, f.helper), 'forbidden', 403)
    if (kind === 'stranger') await refused(f, () => prepare(f, f.stranger), 'not_found', 404)
  })
  it.each(['policy_mode', 'policy_revision', 'category', 'foreign_package', 'selected_changed', 'committed_replay', 'different_key_body'] as const)('preparation rechecks current %s and rolls the whole attempt back', async kind => {
    const f = await fixture(), key = randomUUID(), body = prepareBody(f)
    if (kind === 'policy_mode') { ok(await app.inject({ method: 'PATCH', url: `/vendors/${f.vendor}/availability-policy`, headers: headers(f.owner), payload: { mode: 'legacy_day', expectedRevision: '1' } })); await refused(f, () => prepare(f), 'resource_policy_required') }
    if (kind === 'policy_revision') await refused(f, () => prepare(f, f.pair, key, { ...body, expectedPolicyRevision: '2' }), 'order_version_conflict')
    if (kind === 'category') { await app.db!.query("update vendors set category_id='photo' where id=$1", [f.vendor]); await refused(f, () => prepare(f), 'validation_failed', 422) }
    if (kind === 'foreign_package') { const other = await fixture(); await refused(f, () => prepare(f, f.pair, key, { ...body, packageId: other.packageId }), 'unknown_package', 422) }
    if (kind === 'selected_changed') { ok(await prepare(f)); await refused(f, () => prepare(f), 'resource_order_slot_changed') }
    if (kind === 'committed_replay') { const selected = ok<ResourceOrderPreparationResult>(await prepare(f, f.pair, key)); await app.db!.query("update deals set state='booked' where id=$1", [selected.dealId]); await refused(f, () => prepare(f, f.pair, key), 'resource_order_source_changed') }
    if (kind === 'different_key_body') { ok(await prepare(f, f.pair, key)); await refused(f, () => prepare(f, f.pair, key, { ...body, packageId: null }), 'idempotency_key_reused') }
  })
  it('a foreign wedding and a prebooked own position cannot become a resource draft', async () => {
    const f = await fixture(), other = await fixture(), foreignBefore = await snapshot(other)
    await refused(f, () => prepare(f, f.pair, randomUUID(), prepareBody(f), other.wedding, other.slot), 'not_found', 404)
    expect(await snapshot(other)).toEqual(foreignBefore)
    await app.db!.query('update slots set prebooked_at=now() where id=$1', [f.slot])
    await refused(f, () => prepare(f), 'resource_order_slot_changed')
  })
  it.each(['membership', 'session', 'consent', 'company'] as const)('a prepared response cannot bypass revoked current %s on replay', async change => {
    const f = await fixture(), key = randomUUID(); ok(await prepare(f, f.pair, key))
    if (change === 'membership') await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.pair.id])
    if (change === 'session') await app.db!.query('update sessions set revoked_at=now() where id=$1', [f.pair.session])
    if (change === 'consent') await app.db!.query('update consents set withdrawn_at=now() where user_id=$1', [f.pair.id])
    if (change === 'company') await app.db!.query('update vendors set published_at=null where id=$1', [f.vendor])
    await refused(f, () => prepare(f, f.pair, key), change === 'session' ? 'unauthorized' : change === 'consent' ? 'forbidden' : 'not_found', change === 'session' ? 401 : change === 'consent' ? 403 : 404)
  })

  it('real schema2 GET proofs and distinct parties commit one existing financial root without altering money/program', async () => {
    const f = await fixture(), d = await agreed(f), financial = await money(f, d.deal), key = randomUUID()
    const result = safeCommit(f, await commit(f, d.deal, d.body, false, f.pair, key))
    expect(result).toEqual({ revision: '1', state: 'reserved', reservation: 'reserved', termsId: d.body.termsId, planRevisionId: d.body.planRevisionId })
    expect(await money(f, d.deal)).toEqual(financial)
    expect(safeCommit(f, await readCommit(f, d.deal, f.owner))).toEqual(result)
    expect(ok<ResourcePlanView>(await readPlan(f, d.deal))).toMatchObject({ reservation: 'reserved', current: { planRevisionId: d.body.planRevisionId } })
    const beforeRetry = await snapshot(f); expect(safeCommit(f, await commit(f, d.deal, d.body, false, f.pair, key))).toEqual(result); expect(await snapshot(f)).toEqual(beforeRetry)
    expect((await app.db!.query('select id,state,price::text from deals where wedding_id=$1', [f.wedding])).rows).toEqual([{ id: d.deal, state: 'booked', price: '15000' }])
    expect((await app.db!.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 5, legacy_used: 0 }])
    expect((await app.db!.query('select date from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows).toEqual([])
    expect(ok<{ dealState: string; vendorId: string }>(await app.inject({ url: `${root(d.deal)}/catalog`, headers: f.pair.headers }))).toMatchObject({ dealState: 'booked', vendorId: f.vendor })
  })
  it.each([0, 1])('a schema2 proposal with %s actual party acceptances cannot create an allocation or cache success', async count => {
    const f = await fixture(), d = await agreed(f, 5, false, count)
    await refused(f, () => commit(f, d.deal, d.body), 'resource_terms_not_agreed')
  })
  it('an actual customer GET proof cannot stand in for the distinct performer GET proof', async () => {
    const f = await fixture(), d = await agreed(f, 5, false, 0)
    const customerRead = ok<TermsView>(await app.inject({ url: `${root(d.deal)}/terms`, headers: f.pair.headers }))
    await refused(f, () => app.inject({ method: 'POST', url: `${root(d.deal)}/terms/${customerRead.selected!.id}/accept`, headers: headers(f.owner),
      payload: { expectedTermsVersion: customerRead.selected!.version, digest: customerRead.selected!.digest, readToken: customerRead.readToken } }), 'validation_failed', 422)
    await refused(f, () => commit(f, d.deal, d.body), 'resource_terms_not_agreed')
  })
  it('a later actual brief edit makes agreed proof stale even with the latest supplied order version', async () => {
    const f = await fixture(), d = await agreed(f), order = ok<OrderDto>(await app.inject({ method: 'PATCH', url: `${root(d.deal)}/brief`, headers: headers(f.owner),
      payload: { expectedVersion: d.body.expectedOrderVersion, brief: { values: {} } } }))
    await refused(f, () => commit(f, d.deal, { ...d.body, expectedOrderVersion: order.version }), 'resource_terms_source_changed')
  })
  it.each(['expectedOrderVersion', 'expectedCommitmentRevision', 'expectedTermsVersion', 'expectedPolicyRevision', 'termsDigest', 'planRevisionId', 'termsId'] as const)('commit validates exact current %s and atomically rolls back its cache/head attempt', async field => {
    const f = await fixture(), d = await agreed(f), changed: Record<string, unknown> = { ...d.body }
    changed[field] = field.endsWith('Id') ? randomUUID() : field === 'termsDigest' ? 'f'.repeat(64) : '9'
    const code = field === 'termsDigest' ? 'validation_failed' : field === 'planRevisionId' ? 'resource_plan_changed' : field === 'termsId' ? 'resource_terms_not_agreed' : 'order_version_conflict'
    await refused(f, () => commit(f, d.deal, changed), code, field === 'termsDigest' ? 422 : 409)
  })
  it.each(['actor', 'weddingId', 'vendorId', 'resourceId', 'price'] as const)('commit schema refuses extra %s without trusting it as authority', async field => {
    const f = await fixture(), d = await agreed(f); await refused(f, () => commit(f, d.deal, { ...d.body, [field]: f.owner.id }), 'validation_failed', 422)
  })
  it.each(['helper', 'manager', 'pseudoVendor', 'stranger'] as const)('private commitment GET and mutations deny current %s without leaking allocations', async role => {
    const f = await fixture(), d = await agreed(f), denied = f[role]
    await refused(f, () => readCommit(f, d.deal, denied), 'not_found', 404)
    await refused(f, () => commit(f, d.deal, d.body, false, denied), 'not_found', 404)
  })
  it('current exact vendor owner can GET but cannot commit or replace even accepted customer terms', async () => {
    const f = await fixture(), d = await agreed(f)
    expect(safeCommit(f, await readCommit(f, d.deal, f.owner))).toMatchObject({ state: 'not_reserved' })
    for (const replacement of [false, true]) await refused(f, () => commit(f, d.deal, d.body, replacement, f.owner), 'forbidden', 403)
  })
  it('commit requires its key and refuses a reused key with a changed payload while preserving the current promise', async () => {
    const f = await fixture(), d = await agreed(f), key = randomUUID()
    await refused(f, () => commit(f, d.deal, d.body, false, f.pair, null), 'idempotency_key_required', 400)
    safeCommit(f, await commit(f, d.deal, d.body, false, f.pair, key))
    await refused(f, () => commit(f, d.deal, { ...d.body, expectedCommitmentRevision: '1' }, false, f.pair, key), 'idempotency_key_reused')
  })
  it('commitment reads use current exact company owner and retain the pair promise after ownership changes', async () => {
    const f = await fixture(), d = await agreed(f), initial = safeCommit(f, await commit(f, d.deal, d.body))
    await app.db!.query('update vendors set user_id=$2 where id=$1', [f.vendor, f.stranger.id])
    await refused(f, () => readCommit(f, d.deal, f.owner), 'not_found', 404)
    expect(safeCommit(f, await readCommit(f, d.deal, f.stranger))).toEqual(initial)
    expect(safeCommit(f, await readCommit(f, d.deal))).toEqual(initial)
  })
  it('successful commit replay still requires current couple role even when that actor now owns the company', async () => {
    const f = await fixture(), d = await agreed(f), key = randomUUID(); safeCommit(f, await commit(f, d.deal, d.body, false, f.pair, key))
    await app.db!.query('update vendors set user_id=$2 where id=$1', [f.vendor, f.pair.id])
    await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.pair.id])
    expect(safeCommit(f, await readCommit(f, d.deal))).toMatchObject({ state: 'reserved' })
    await refused(f, () => commit(f, d.deal, d.body, false, f.pair, key), 'forbidden', 403)
  })
  it.each(['session', 'membership', 'consent'] as const)('commit cache cannot replay a private success after current %s revocation', async change => {
    const f = await fixture(), d = await agreed(f), key = randomUUID(); safeCommit(f, await commit(f, d.deal, d.body, false, f.pair, key))
    if (change === 'session') await app.db!.query('update sessions set revoked_at=now() where id=$1', [f.pair.session])
    if (change === 'membership') await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.pair.id])
    if (change === 'consent') await app.db!.query('update consents set withdrawn_at=now() where user_id=$1', [f.pair.id])
    await refused(f, () => commit(f, d.deal, d.body, false, f.pair, key), change === 'session' ? 'unauthorized' : change === 'consent' ? 'forbidden' : 'not_found', change === 'session' ? 401 : change === 'consent' ? 403 : 404)
  })
  it('a newer unreserved draft leaves the older real promise visible until explicit agreed replacement, and old cache reads latest reservation', async () => {
    const f = await fixture(), d = await agreed(f), key = randomUUID(), initial = safeCommit(f, await commit(f, d.deal, d.body, false, f.pair, key)), financial = await money(f, d.deal)
    const oldAllocations = (await app.db!.query('select * from resource_allocations where deal_id=$1 order by id', [d.deal])).rows
    const next = await plan(f, d, 3, 14)
    expect(ok<ResourcePlanView>(await readPlan(f, d.deal))).toMatchObject({ reservation: 'not_reserved', current: { planRevisionId: next.current!.planRevisionId } })
    expect(safeCommit(f, await readCommit(f, d.deal))).toEqual(initial)
    expect((await app.db!.query('select * from resource_allocations where deal_id=$1 order by id', [d.deal])).rows).toEqual(oldAllocations)
    const changed = { ...await agree(f, d, next), expectedCommitmentRevision: '1' }
    await refused(f, () => commit(f, d.deal, changed), 'resource_initial_booking_required')
    await refused(f, () => commit(f, d.deal, { ...changed, expectedCommitmentRevision: '2' }, true), 'order_version_conflict')
    const replacementKey = randomUUID(), replaced = safeCommit(f, await commit(f, d.deal, changed, true, f.pair, replacementKey))
    expect(replaced).toMatchObject({ revision: '2', state: 'reserved', planRevisionId: next.current!.planRevisionId }); expect(await money(f, d.deal)).toEqual(financial)
    expect((await app.db!.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 3 }])
    expect((await app.db!.query('select release_reason from resource_allocations where id=$1', [oldAllocations[0]!.id])).rows).toEqual([{ release_reason: 'replaced' }])
    const unchanged = await snapshot(f)
    expect(safeCommit(f, await commit(f, d.deal, d.body, false, f.pair, key))).toEqual(replaced)
    expect(safeCommit(f, await commit(f, d.deal, changed, true, f.pair, replacementKey))).toEqual(replaced)
    expect(await snapshot(f)).toEqual(unchanged)
    expect(ok<ResourcePlanView>(await readPlan(f, d.deal))).toMatchObject({ reservation: 'reserved' })
    const cached = (await app.db!.query('select body from idempotency_keys where key=$1', [`${f.pair.id}:/deals/:dealId/order/resource-commitments:${key}`])).rows[0]!.body
    expect(cached).toEqual(initial)
  })
  it('unchanged resource lines retain their actual allocation row IDs through explicit accepted replacement', async () => {
    const f = await fixture(), d = await agreed(f); safeCommit(f, await commit(f, d.deal, d.body))
    const allocations = (await app.db!.query('select * from resource_allocations where deal_id=$1', [d.deal])).rows
    const order = ok<OrderDto>(await app.inject({ url: root(d.deal), headers: f.owner.headers }))
    ok(await app.inject({ method: 'PATCH', url: `${root(d.deal)}/brief`, headers: headers(f.owner), payload: { expectedVersion: order.version, brief: { values: {} } } }))
    const current = ok<ResourcePlanView>(await readPlan(f, d.deal, f.owner)), changed = { ...await agree(f, d, current), expectedCommitmentRevision: '1' }
    expect(safeCommit(f, await commit(f, d.deal, changed, true))).toMatchObject({ revision: '2' })
    expect((await app.db!.query('select * from resource_allocations where deal_id=$1', [d.deal])).rows).toEqual(allocations)
  })
  it('retired current source makes plan unavailable but preserves its exact actual reserved promise and history', async () => {
    const f = await fixture(), d = await agreed(f), initial = safeCommit(f, await commit(f, d.deal, d.body))
    ok(await app.inject({ method: 'POST', url: `/vendors/${f.vendor}/resources/${f.capacity.id}/retire`, headers: headers(f.owner), payload: { expectedVersion: f.capacity.version } }))
    const before = await snapshot(f)
    expect(ok<ResourcePlanView>(await readPlan(f, d.deal))).toMatchObject({ source: 'unavailable', reservation: 'reserved', current: { planRevisionId: d.body.planRevisionId } })
    expect(safeCommit(f, await readCommit(f, d.deal))).toEqual(initial); expect(await snapshot(f)).toEqual(before)
    await refused(f, () => commit(f, d.deal, { ...d.body, expectedCommitmentRevision: '1' }, true), 'resource_source_changed')
  })
  it('real capacity exhaustion rolls an actual API commit back, preserving the first wedding and allowing exact remaining capacity', async () => {
    const f = await fixture(), first = await agreed(f); safeCommit(f, await commit(f, first.deal, first.body))
    const created = await fixture(), secondScope = { ...created, owner: f.owner, vendor: f.vendor, packageId: f.packageId, capacity: f.capacity, equipment: f.equipment, window: f.window, policy: f.policy }
    const second = await agreed(secondScope, 6), original = await snapshot(f)
    await refused(secondScope, () => commit(secondScope, second.deal, second.body), 'resource_capacity_exhausted')
    expect(await snapshot(f)).toEqual(original)
    const fitting = await plan(secondScope, second, 5), accepted = await agree(secondScope, second, fitting)
    expect(safeCommit(secondScope, await commit(secondScope, second.deal, accepted))).toMatchObject({ revision: '1' })
    expect((await app.db!.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 10 }])
  })
  it('real equipment overlap refuses an accepted second order, then an actual non-overlapping agreed interval succeeds', async () => {
    const f = await fixture(), first = await agreed(f, 1, true); safeCommit(f, await commit(f, first.deal, first.body))
    const created = await fixture(), other = { ...created, owner: f.owner, vendor: f.vendor, packageId: f.packageId,
      equipment: f.equipment, capacity: f.capacity, window: f.window, policy: f.policy }
    const second = await agreed(other, 1, true), original = await snapshot(f)
    await refused(other, () => commit(other, second.deal, second.body), 'resource_booking_conflict'); expect(await snapshot(f)).toEqual(original)
    const later = await plan(other, second, 1, 14, true), accepted = await agree(other, second, later)
    expect(safeCommit(other, await commit(other, second.deal, accepted))).toMatchObject({ state: 'reserved' })
    expect((await app.db!.query('select count(*)::int n from resource_allocations where resource_id=$1 and released_at is null', [f.equipment.id])).rows).toEqual([{ n: 2 }])
  })
  it('registered paid/done transitions preserve actual resource booking and money without creating a legacy date', async () => {
    const f = await fixture(), d = await agreed(f); safeCommit(f, await commit(f, d.deal, d.body)); const financial = await money(f, d.deal)
    const allocations = (await app.db!.query('select * from resource_allocations where deal_id=$1', [d.deal])).rows
    for (const state of ['paid_deposit', 'done']) {
      ok(await app.inject({ method: 'PATCH', url: `/deals/${d.deal}`, headers: headers(f.pair), payload: { state } }))
      expect(await money(f, d.deal)).toEqual(financial); expect(safeCommit(f, await readCommit(f, d.deal))).toMatchObject({ revision: '1', state: 'reserved' })
      expect((await app.db!.query('select * from resource_allocations where deal_id=$1', [d.deal])).rows).toEqual(allocations)
      expect((await app.db!.query('select date from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows).toEqual([])
    }
  })
  it('registered cancellation releases once, preserves payment history and projects released only for the exact selected plan', async () => {
    const f = await fixture(), d = await agreed(f); safeCommit(f, await commit(f, d.deal, d.body)); const financial = await money(f, d.deal)
    ok(await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${f.slot}/cancel`, headers: headers(f.pair) }))
    expect(safeCommit(f, await readCommit(f, d.deal))).toMatchObject({ revision: '2', state: 'released', reservation: 'released', planRevisionId: d.body.planRevisionId })
    expect(ok<ResourcePlanView>(await readPlan(f, d.deal))).toMatchObject({ reservation: 'released' }); expect(await money(f, d.deal)).toEqual(financial)
    expect((await app.db!.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 0 }])
    expect((await app.db!.query('select release_reason from resource_allocations where deal_id=$1', [d.deal])).rows).toEqual([{ release_reason: 'deal_cancelled' }])
    await refused(f, () => app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${f.slot}/cancel`, headers: headers(f.pair) }), 'slot_empty')
    await refused(f, () => app.inject({ method: 'PATCH', url: `/deals/${d.deal}`, headers: headers(f.pair), payload: { state: 'cancelled' } }), 'already_cancelled')
  })
  it('cancelling while a newer unreserved draft exists releases the older promise without claiming that new draft was reserved', async () => {
    const f = await fixture(), d = await agreed(f), initial = safeCommit(f, await commit(f, d.deal, d.body)), newer = await plan(f, d, 3, 14)
    ok(await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${f.slot}/cancel`, headers: headers(f.pair) }))
    expect(safeCommit(f, await readCommit(f, d.deal))).toMatchObject({ state: 'released', planRevisionId: initial.planRevisionId })
    expect(ok<ResourcePlanView>(await readPlan(f, d.deal))).toMatchObject({ reservation: 'not_reserved', current: { planRevisionId: newer.current!.planRevisionId } })
    expect((await app.db!.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 0 }])
  })

  async function waited(f: Fixture, change: string, lock: string, values: readonly unknown[], mutate: (c: Queryable) => Promise<unknown>, action: () => Promise<Reply>) {
    let release!: () => void, signal!: () => void, holderPid = 0, expected: unknown
    const permission = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { signal = r })
    const holder = app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query(lock, values); signal(); await permission; await mutate(c); expected = await snapshot(f, c)
    })
    await Promise.race([ready, holder.then(() => { throw new Error(`${change}: holder exited early`) })])
    const result = action()
    try {
      let observed: { pid: number; wait_event: string | null; query: string }[] = []
      for (let attempt = 0; attempt < 120; attempt++) {
        observed = (await app.db!.query<{ pid: number; wait_event: string | null; query: string }>(`select pid,wait_event,query from pg_stat_activity where datname=current_database()
          and pid<>pg_backend_pid() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [holderPid])).rows
        if (observed.length) break
        await new Promise<void>(r => setTimeout(r, 25))
      }
      expect(observed, `${change}: actual HTTP SQL wait`).toHaveLength(1)
      const witness = observed[0]!
      waits.push({ change, holder: holderPid, waiter: witness.pid, event: witness.wait_event, query: witness.query })
      release(); await holder; return { response: await result, expected, query: witness.query }
    } finally { release(); try { await holder } finally { await result } }
  }
  it.each(['session', 'consent', 'account', 'blocked', 'unpublished', 'erased', 'owner'] as const)('safe policy GET rechecks current %s after an observed real PG wait', async change => {
    const f = await fixture(), next = change === 'owner' ? await actor() : null
    const lock = change === 'session' ? 'select id from sessions where id=$1 for update' : change === 'consent' ? 'select id from consents where user_id=$1 for update' :
      change === 'account' || change === 'erased' ? 'select id from users where id=$1 for update' : 'select id from vendors where id=$1 for update'
    const id = change === 'session' ? f.stranger.session : change === 'consent' || change === 'account' ? f.stranger.id : change === 'erased' ? f.owner.id : f.vendor
    const outcome = await waited(f, `policy ${change}`, lock, [id], async c => {
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.stranger.session])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [f.stranger.id])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [f.stranger.id])
      if (change === 'erased') await c.query('update users set deleted_at=now() where id=$1', [f.owner.id])
      if (change === 'blocked') await c.query('update vendors set blocked_at=now() where id=$1', [f.vendor])
      if (change === 'unpublished') await c.query('update vendors set published_at=null where id=$1', [f.vendor])
      if (change === 'owner') await c.query('update vendors set user_id=$2 where id=$1', [f.vendor, next!.id])
    }, () => policyRead(f))
    error(outcome.response, change === 'session' || change === 'account' ? 'unauthorized' : change === 'consent' ? 'forbidden' : change === 'owner' ? 'resource_source_changed' : 'not_found', change === 'session' || change === 'account' ? 401 : change === 'consent' ? 403 : change === 'owner' ? 409 : 404)
    privateFree(f, outcome.response); expect(await snapshot(f)).toEqual(outcome.expected)
  })
  it.each(['membership', 'session', 'owner'] as const)('prepared cache rechecks %s after its actual PG lock wait and cannot return old money scope', async change => {
    const f = await fixture(), key = randomUUID(); ok(await prepare(f, f.pair, key)); const next = change === 'owner' ? await actor() : null
    const lock = change === 'membership' ? 'select user_id from wedding_members where wedding_id=$1 and user_id=$2 for update' : change === 'session' ? 'select id from sessions where id=$1 for update' : 'select id from vendors where id=$1 for update'
    const values = change === 'membership' ? [f.wedding, f.pair.id] : [change === 'session' ? f.pair.session : f.vendor]
    const outcome = await waited(f, `prepare replay ${change}`, lock, values, async c => {
      if (change === 'membership') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.pair.id])
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.pair.session])
      if (change === 'owner') await c.query('update vendors set user_id=$2 where id=$1', [f.vendor, next!.id])
    }, () => prepare(f, f.pair, key))
    error(outcome.response, change === 'session' ? 'unauthorized' : change === 'owner' ? 'resource_order_source_changed' : 'not_found', change === 'session' ? 401 : change === 'owner' ? 409 : 404)
    privateFree(f, outcome.response); expect(await snapshot(f)).toEqual(outcome.expected)
  })
  it.each(['session', 'membership', 'resource'] as const)('actual resource commit rechecks current %s after PG wait and rolls back head/cache/counter writes', async change => {
    const f = await fixture(), d = await agreed(f)
    const lock = change === 'session' ? 'select id from sessions where id=$1 for update' : change === 'membership' ? 'select user_id from wedding_members where wedding_id=$1 and user_id=$2 for update' : 'select id from vendor_resources where id=$1 for update'
    const values = change === 'membership' ? [f.wedding, f.pair.id] : [change === 'session' ? f.pair.session : f.capacity.id]
    const outcome = await waited(f, `commit ${change}`, lock, values, async c => {
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.pair.session])
      if (change === 'membership') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.pair.id])
      if (change === 'resource') await c.query('update vendor_resources set retired_at=now() where id=$1', [f.capacity.id])
    }, () => commit(f, d.deal, d.body))
    error(outcome.response, change === 'session' ? 'unauthorized' : change === 'membership' ? 'not_found' : 'resource_source_changed', change === 'session' ? 401 : change === 'membership' ? 404 : 409)
    privateFree(f, outcome.response); expect(await snapshot(f)).toEqual(outcome.expected)
  })
})
