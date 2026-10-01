import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { announceDealEvents } from '../src/jobs/index.js'
import type { OrderActor } from '../src/orders/context.js'
import { cancelOrderAssignment, createOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart } from '../src/orders/model.js'
import { prepareCatalogResourceOrder, type ResourceOrderPreparationInput } from '../src/orders/resource-order.js'
import type { Queryable } from '../src/plugins/db.js'
import { createResource } from '../src/resources/model.js'
import { setAvailabilityPolicy } from '../src/resources/policy.js'
import { acceptStaffInvite, inviteStaff } from '../src/vendor/staff.js'
import { disposablePgPort } from './disposablePgPort.js'

const DATABASE = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'synthetic-resource-order-preparation-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DATE = '2027-06-14', BIG_PRICE = '9007199254740993'
const ITEMS = ['Six bouquets', 'Delivery terms are separate']
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
const outcome = <T>(action: Promise<T>): Promise<Outcome<T>> => action.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// Every actor/account/consent below is a synthetic test fixture. Preparing a
// draft never manufactures terms receipts, programme acceptance or allocations.
describe.skipIf(!DATABASE)('actual PostgreSQL catalogue resource-order preparation and registered profile writer', () => {
  let app: FastifyInstance
  const users = new Set<string>(), vendors = new Set<string>(), weddings = new Set<string>(), resources = new Set<string>()
  const waits: { change: string; holder: number; waiter: number; waitEvent: string | null; query: string }[] = []
  const prefix = String(randomInt(100_000, 999_999)); let sequence = 0

  async function liveFence() {
    const target = new URL(DATABASE!)
    const live = (await app.db!.query<{ address: string; port: number; name: string; principal: string }>(
      'select host(inet_server_addr()) address,inet_server_port() port,current_database() name,current_user principal')).rows[0]!
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(live.address)
    expect(live.port).toBe(15432); expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
  }

  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(disposablePgPort(), '15432', 'This independent witness uses only the explicit retained disposable cluster')
    assert.equal(target.port, '15432'); assert.equal(target.username, 'codex_test'); assert.equal(target.password, '')
    assert(['/tili_ecosystem_full_20260930_test', '/tili_ecosystem_allocations_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'resource-order-preparation-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    await liveFence()
  })
  afterAll(async () => {
    if (!app) return
    try {
      await liveFence()
      process.stdout.write(`RESOURCE_ORDER_PREPARATION_PG_WAITS count=${waits.length} ${JSON.stringify(waits)}\n`)
      process.stdout.write(`RESOURCE_ORDER_PREPARATION_FIXTURE_MANIFEST ${JSON.stringify({ database: new URL(DATABASE!).pathname.slice(1),
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
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic resource preparation actor')", [userId, `+79${prefix}${String(++sequence).padStart(4, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    return { userId, sessionId, policyVersion: POLICY, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const principal = (person: Actor): OrderActor => ({ userId: person.userId, sessionId: person.sessionId, policyVersion: person.policyVersion })
  const auth = (person: Actor) => ({ authorization: `Bearer ${person.token}` })
  async function fixture(date: string | null = DATE) {
    const pair = await actor(), owner = await actor(), helper = await actor(), coordinator = await actor(), outsider = await actor()
    const weddingId = randomUUID(), vendorId = randomUUID(), slotId = randomUUID(), packageId = randomUUID()
    weddings.add(weddingId); vendors.add(vendorId)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic resource preparation wedding',$3,'Europe/Moscow',$4)", [weddingId, pair.userId, date, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper'),($1,$4,'coordinator')", [weddingId, pair.userId, helper.userId, coordinator.userId])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic preparation company',now())", [vendorId, owner.userId])
    const eventId = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    await app.db!.query("insert into slots(id,wedding_id,category_id,program_event_id,label) values($1,$2,'florist',$3,'Actual draft position')", [slotId, weddingId, eventId])
    await app.db!.query("insert into vendor_packages(id,vendor_id,name,price,items) values($1,$2,'Synthetic arrangement quote',$3,$4::jsonb)", [packageId, vendorId, BIG_PRICE, JSON.stringify(ITEMS)])
    const equipment = await app.db!.tx(c => createResource(c, { vendorId, actor: principal(owner), kind: 'equipment', label: 'Actual declared vase set' }))
    resources.add(equipment.id)
    const policy = await app.db!.tx(c => setAvailabilityPolicy(c, { vendorId, actor: principal(owner), mode: 'resources', expectedRevision: '0' }))
    return { pair, owner, helper, coordinator, outsider, weddingId, vendorId, slotId, packageId, eventId, equipmentId: equipment.id,
      policyRevision: policy.revision, people: [pair, owner, helper, coordinator, outsider] }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function input(f: Fixture, patch: Partial<ResourceOrderPreparationInput> = {}): ResourceOrderPreparationInput {
    return { weddingId: f.weddingId, slotId: f.slotId, actor: principal(f.pair), vendorId: f.vendorId, packageId: null,
      expectedSelectedDealId: null, expectedPolicyRevision: f.policyRevision, ...patch }
  }
  const prepare = (f: Fixture, patch: Partial<ResourceOrderPreparationInput> = {}) => app.db!.tx(c => prepareCatalogResourceOrder(c, input(f, patch)))
  async function snapshot(f: Fixture, c: Queryable = app.db!) {
    const ids = f.people.map(person => person.userId)
    const reads: [string, string, readonly unknown[]][] = [
      ['users', 'select * from users where id=any($1::uuid[]) order by id', [ids]],
      ['sessions', 'select * from sessions where user_id=any($1::uuid[]) order by id', [ids]],
      ['consents', 'select * from consents where user_id=any($1::uuid[]) order by id', [ids]],
      ['members', 'select * from wedding_members where wedding_id=$1 order by user_id', [f.weddingId]],
      ['wedding', 'select * from weddings where id=$1', [f.weddingId]],
      ['events', 'select * from wedding_events where wedding_id=$1 order by id', [f.weddingId]],
      ['slots', 'select * from slots where wedding_id=$1 order by id', [f.weddingId]],
      ['deals', 'select * from deals where wedding_id=$1 order by id', [f.weddingId]],
      ['orders', 'select * from deal_orders where wedding_id=$1 order by deal_id', [f.weddingId]],
      ['assignments', 'select * from order_assignments where wedding_id=$1 order by id', [f.weddingId]],
      ['parts', 'select * from order_parts where wedding_id=$1 order by id', [f.weddingId]],
      ['terms', 'select * from deal_terms_versions where wedding_id=$1 order by id', [f.weddingId]],
      ['receipts', 'select * from deal_terms_receipts where wedding_id=$1 order by id', [f.weddingId]],
      ['plan', 'select * from deal_resource_plan_versions where wedding_id=$1 order by id', [f.weddingId]],
      ['commitments', 'select * from deal_resource_commitments where wedding_id=$1 order by deal_id', [f.weddingId]],
      ['commitmentVersions', 'select * from deal_resource_commitment_versions where wedding_id=$1 order by id', [f.weddingId]],
      ['commitmentMembers', 'select * from deal_resource_commitment_members where wedding_id=$1 order by version_id,line_index', [f.weddingId]],
      ['allocations', 'select * from resource_allocations where wedding_id=$1 order by id', [f.weddingId]],
      ['payments', 'select p.* from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1 order by p.id', [f.weddingId]],
      ['budget', 'select * from budget_items where wedding_id=$1 order by id', [f.weddingId]],
      ['dealEvents', 'select e.* from deal_events e join deals d on d.id=e.deal_id where d.wedding_id=$1 order by e.id', [f.weddingId]],
      ['busy', 'select * from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId]],
      ['chats', 'select * from chats where wedding_id=$1 order by id', [f.weddingId]],
      ['leads', 'select * from leads where wedding_id=$1 order by id', [f.weddingId]],
      ['requests', 'select r.* from offer_requests r join slots s on s.id=r.slot_id where s.wedding_id=$1 order by r.id', [f.weddingId]],
      ['offers', 'select o.* from offers o join offer_requests r on r.id=o.request_id join slots s on s.id=r.slot_id where s.wedding_id=$1 order by o.id', [f.weddingId]],
      ['notifications', 'select * from notifications where user_id=any($1::uuid[]) order by id', [ids]],
      ['pushAttempts', 'select p.* from notification_push_deliveries p join notifications n on n.id=p.notification_id where n.user_id=any($1::uuid[]) order by p.notification_id,p.subscription_id', [ids]],
      ['policy', 'select * from vendor_availability_policy where vendor_id=$1', [f.vendorId]],
      ['vendor', 'select * from vendors where id=$1', [f.vendorId]],
      ['packages', 'select * from vendor_packages where vendor_id=$1 order by id', [f.vendorId]],
      ['resources', 'select * from vendor_resources where vendor_id=$1 order by id', [f.vendorId]],
      ['windows', 'select w.* from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id where r.vendor_id=$1 order by w.id', [f.vendorId]],
      ['programReceipts', 'select * from vendor_program_acknowledgments where wedding_id=$1 order by vendor_id,version,digest', [f.weddingId]],
      ['audit', 'select * from audit_log where actor_id=any($1::uuid[]) order by id', [ids]],
    ]
    const result: Record<string, QueryResultRow[]> = {}
    for (const [name, sql, values] of reads) result[name] = (await c.query(sql, values)).rows
    return result
  }
  async function financial(dealId: string, c: Queryable = app.db!) {
    return (await c.query('select id,wedding_id,slot_id,vendor_id,state,price::text,currency,package_id,package_title_snapshot,package_includes_snapshot,booked_at,negotiating_until from deals where id=$1', [dealId])).rows[0]!
  }
  async function refused(f: Fixture, action: () => Promise<unknown>, status: number, code?: string) {
    const before = await snapshot(f)
    await expect(action()).rejects.toMatchObject({ statusCode: status, ...(code ? { code } : {}) })
    expect(await snapshot(f)).toEqual(before)
  }
  async function rawSelected(f: Fixture, state: string, packageId: string | null = null) {
    // Synthetic pre-existing financial history, without invented resource proof.
    const dealId = randomUUID()
    await app.db!.query(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,currency,package_id,package_title_snapshot,package_includes_snapshot)
      values($1,$2,$3,$4,$5,$6,'RUB',$7,'Original financial snapshot',$8::jsonb)`, [dealId, f.weddingId, f.slotId, f.vendorId, state, BIG_PRICE, packageId, JSON.stringify(ITEMS)])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [f.slotId, dealId])
    return dealId
  }
  async function liveOffer(f: Fixture) {
    const entryId = randomUUID()
    await app.db!.query('insert into slot_shortlist(id,slot_id,vendor_id,position,added_by) values($1,$2,$3,1,$4)', [entryId, f.slotId, f.vendorId, f.pair.userId])
    const request = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/offer-requests`, headers: { ...auth(f.pair), 'idempotency-key': randomUUID() }, payload: { entryIds: [entryId] } })
    expect(request.statusCode, request.body).toBe(201)
    const requestId = request.json<{ results: { requestId: string }[] }>().results[0]!.requestId
    const offered = await app.inject({ method: 'POST', url: `/vendor/offer-requests/${requestId}/offers`, headers: { ...auth(f.owner), 'idempotency-key': randomUUID() },
      payload: { kind: 'offer', title: 'Actual independent arrangement quote', price: { amount: 15000, currency: 'RUB' }, includes: ITEMS, validUntil: '2027-06-13' } })
    expect(offered.statusCode, offered.body).toBe(201)
  }

  it('creates exactly one unknown-price financial draft while preserving open offers, legacy busy days and every unrelated promise', async () => {
    const f = await fixture(); await liveOffer(f)
    await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual')", [f.vendorId, DATE])
    const before = await snapshot(f), result = await prepare(f), after = await snapshot(f)
    expect(before.requests).toHaveLength(1); expect(before.offers).toHaveLength(1)
    expect(before.leads!.every(row => row.state !== 'won')).toBe(true)
    expect(result).toEqual({ dealId: expect.any(String), orderVersion: '1', state: 'candidate', created: true })
    expect(Object.keys(result).sort()).toEqual(['created', 'dealId', 'orderVersion', 'state'])
    expect(after.deals).toHaveLength(1); expect(after.orders).toHaveLength(1)
    expect(after.slots!.find(row => row.id === f.slotId)?.deal_id).toBe(result.dealId)
    expect(await financial(result.dealId)).toMatchObject({ state: 'candidate', price: null, currency: 'RUB', package_id: null,
      package_title_snapshot: null, package_includes_snapshot: null, booked_at: null, negotiating_until: null })
    expect(after.orders![0]).toMatchObject({ source: 'structured', version: '1', brief: null, proposed_terms_id: null, agreed_terms_id: null,
      resource_plan_id: null, resource_plan_revision: '0' })
    for (const key of ['busy', 'payments', 'budget', 'chats', 'leads', 'requests', 'offers', 'notifications', 'pushAttempts', 'terms', 'receipts', 'assignments', 'parts',
      'plan', 'commitments', 'commitmentVersions', 'commitmentMembers', 'allocations', 'resources', 'windows', 'programReceipts', 'events', 'policy', 'packages']) expect(after[key], key).toEqual(before[key])
    expect(after.dealEvents).toHaveLength(1)
    expect(after.dealEvents![0]).toMatchObject({ deal_id: result.dealId, from_state: null, to_state: 'candidate', actor_id: f.pair.userId, notified_at: expect.any(Date) })
    expect(after.audit!.filter(row => row.action === 'order.resource_order_prepared')).toHaveLength(1)
    expect(after.audit!.find(row => row.action === 'order.resource_order_prepared')).toMatchObject({ actor_id: f.pair.userId, entity: 'order', entity_id: result.dealId,
      diff: { draftOnly: true, slotId: f.slotId, vendorId: f.vendorId, packageId: null, state: 'candidate' } })
  })
  it.each([null, '0', BIG_PRICE, '9223372036854775807'])('snapshots actual optional catalogue bigint price %s without Number or unknown-to-zero conversion', async price => {
    const f = await fixture(); await app.db!.query('update vendor_packages set price=$2 where id=$1', [f.packageId, price])
    const result = await prepare(f, { packageId: f.packageId })
    expect(await financial(result.dealId)).toMatchObject({ price, package_id: f.packageId, package_title_snapshot: 'Synthetic arrangement quote', package_includes_snapshot: ITEMS })
    expect((await snapshot(f)).payments).toEqual([])
  })
  it.each([[DATE, null, null], [null, null, null], [DATE, '2027-06-15', 'Asia/Yekaterinburg'], [null, '2027-06-15', 'Asia/Yekaterinburg']] as const)('allows an extra-event draft with main date %s and actual extra date %s/zone %s', async (date, extraDate, extraZone) => {
    const f = await fixture(date), extra = randomUUID()
    await app.db!.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Synthetic extra second day','second_day',$3,$4,false)", [extra, f.weddingId, extraDate, extraZone])
    await app.db!.query('update slots set program_event_id=$2 where id=$1', [f.slotId, extra])
    const before = await snapshot(f), result = await prepare(f)
    expect(result.state).toBe('candidate')
    const after = await snapshot(f)
    expect(after.events).toEqual(before.events); expect(after.wedding).toEqual(before.wedding)
    const persistedDate = (await app.db!.query('select date::text,time_zone from wedding_events where id=$1', [extra])).rows[0]
    expect(persistedDate).toEqual({ date: extraDate, time_zone: extraZone })
    expect(after.assignments).toEqual([]); expect(after.busy).toEqual([]); expect(after.allocations).toEqual([])
  })
  it('uses actual announceDealEvents without sending an initial draft report, and still delivers an explicitly contacted event', async () => {
    // The full suite shares this guarded synthetic database. Complete its
    // preceding legitimate queue with the actual worker before creating our
    // fixture; do not delete events or mark another fixture processed by SQL.
    const preceding = (await app.db!.query<{ count: number }>('select count(*)::int count from deal_events where notified_at is null')).rows[0]!.count
    expect(preceding).toBeLessThanOrEqual(10_000)
    if (preceding > 0) await announceDealEvents(app, preceding)
    expect((await app.db!.query('select id from deal_events where notified_at is null')).rows).toEqual([])
    const f = await fixture(), prepared = await prepare(f), before = await snapshot(f)
    // With the preceding queue completed, a new suppressed draft is the
    // negative control and an actual contacted transition is the positive.
    expect((await app.db!.query('select id from deal_events where notified_at is null')).rows).toEqual([])
    expect(await announceDealEvents(app)).toBe(0)
    expect(await snapshot(f)).toEqual(before)
    const contacted = await app.inject({ method: 'PATCH', url: `/deals/${prepared.dealId}`,
      headers: { ...auth(f.pair), 'idempotency-key': randomUUID() }, payload: { state: 'contacted' } })
    expect(contacted.statusCode, contacted.body).toBe(200)
    const pending = (await app.db!.query<{ deal_id: string }>('select deal_id from deal_events where notified_at is null')).rows
    expect(pending).toEqual([{ deal_id: prepared.dealId }])
    const beforeAnnounce = await snapshot(f)
    expect(await announceDealEvents(app)).toBe(1)
    const announced = await snapshot(f)
    expect(announced.notifications!.length).toBeGreaterThan(beforeAnnounce.notifications!.length)
    expect(announced.notifications!.some(row => row.user_id === f.owner.userId && row.link === `/deal/${prepared.dealId}`)).toBe(true)
    expect(announced.pushAttempts).toEqual(beforeAnnounce.pushAttempts)
    expect(await announceDealEvents(app)).toBe(0)
    expect(await snapshot(f)).toEqual(announced)
  })
  it.each(['candidate', 'contacted', 'negotiating'] as const)('exact selected %s retry preserves original money, current order version and all audit/events', async state => {
    const f = await fixture(), first = await prepare(f, { packageId: f.packageId })
    await app.db!.query('update deals set state=$2 where id=$1', [first.dealId, state])
    const changed = await app.db!.tx(c => createOrderPart(c, { weddingId: f.weddingId, dealId: first.dealId, actor: principal(f.pair),
      expectedVersion: first.orderVersion, kind: 'deliverable', title: 'Optional design draft', details: { items: ['A design sketch'] } }))
    await app.db!.query("update vendor_packages set name='New catalogue quote',price=42,items='[\"Changed catalogue scope\"]'::jsonb where id=$1", [f.packageId])
    const before = await snapshot(f)
    const result = await prepare(f, { expectedSelectedDealId: first.dealId, packageId: f.packageId })
    expect(result).toEqual({ dealId: first.dealId, orderVersion: changed.version, state, created: false })
    expect(await financial(first.dealId)).toMatchObject({ price: BIG_PRICE, package_title_snapshot: 'Synthetic arrangement quote', package_includes_snapshot: ITEMS })
    expect(await snapshot(f)).toEqual(before)
  })
  it('accepts normalized uppercase UUIDs and a second actual couple member without changing authorization scope', async () => {
    const f = await fixture(), partner = await actor(); f.people.push(partner)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.weddingId, partner.userId])
    const result = await prepare(f, { weddingId: f.weddingId.toUpperCase(), slotId: f.slotId.toUpperCase(), vendorId: f.vendorId.toUpperCase(),
      packageId: f.packageId.toUpperCase(), actor: principal(partner) })
    const before = await snapshot(f)
    expect(await prepare(f, { expectedSelectedDealId: result.dealId.toUpperCase(), packageId: f.packageId.toUpperCase(), actor: principal(f.pair) }))
      .toEqual({ ...result, created: false })
    expect(await snapshot(f)).toEqual(before)
  })
  it('actual company owner who is also a current couple member may prepare a draft without manufacturing a second terms party', async () => {
    const f = await fixture()
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.weddingId, f.owner.userId])
    const prepared = await prepare(f, { actor: principal(f.owner) }), actual = await snapshot(f)
    expect(prepared.created).toBe(true); expect(actual.deals).toHaveLength(1)
    expect(actual.dealEvents![0]).toMatchObject({ actor_id: f.owner.userId, notified_at: expect.any(Date) })
    expect(actual.terms).toEqual([]); expect(actual.receipts).toEqual([]); expect(actual.allocations).toEqual([])
  })
  it.each(['helper', 'coordinator', 'owner', 'outsider'] as const)('current %s does not gain couple financial authority', async who => {
    const f = await fixture(); await refused(f, () => prepare(f, { actor: principal(f[who]) }), who === 'helper' || who === 'coordinator' ? 403 : 404)
  })
  it('actual accepted resource manager can manage a company resource but cannot prepare a private wedding financial root', async () => {
    const f = await fixture(), manager = await actor(); f.people.push(manager)
    const invited = await app.db!.tx(c => inviteStaff(c, { vendorId: f.vendorId, actor: principal(f.owner), role: 'resource_manager', targetUserId: manager.userId }))
    expect((await app.db!.tx(c => acceptStaffInvite(c, { token: invited.token, actor: principal(manager) }))).state).toBe('active')
    const resource = await app.db!.tx(c => createResource(c, { vendorId: f.vendorId, actor: principal(manager), kind: 'equipment', label: 'Actual manager vase set' })); resources.add(resource.id)
    await refused(f, () => prepare(f, { actor: principal(manager) }), 404)
  })
  it.each(['session', 'wrong_session', 'consent', 'policy_version', 'account'] as const)('current invalid actor %s fails before any financial write', async change => {
    const f = await fixture()
    if (change === 'session') await app.db!.query('update sessions set revoked_at=now() where id=$1', [f.pair.sessionId])
    if (change === 'consent') await app.db!.query('update consents set withdrawn_at=now() where user_id=$1', [f.pair.userId])
    if (change === 'account') await app.db!.query('update users set deleted_at=now() where id=$1', [f.pair.userId])
    const actor = { ...principal(f.pair), ...(change === 'wrong_session' ? { sessionId: f.owner.sessionId } : {}), ...(change === 'policy_version' ? { policyVersion: 'old-unaccepted-policy' } : {}) }
    await refused(f, () => prepare(f, { actor }), change === 'consent' || change === 'policy_version' ? 403 : 401)
  })
  it.each(['cancelled_at', 'archived_at'] as const)('closed wedding %s fails without resurrecting a draft', async field => {
    const f = await fixture(); await app.db!.query(`update weddings set ${field}=now() where id=$1`, [f.weddingId])
    await refused(f, () => prepare(f), 404)
  })
  it('foreign wedding/slot and an arbitrary expected selected UUID cannot consume the empty position', async () => {
    const f = await fixture(), other = await fixture()
    await refused(f, () => prepare(f, { slotId: other.slotId }), 404)
    await refused(f, () => prepare(f, { weddingId: other.weddingId }), 404)
    await refused(f, () => prepare(f, { expectedSelectedDealId: randomUUID() }), 409, 'resource_order_slot_changed')
  })
  it.each(['unpublished', 'blocked', 'owner_deleted', 'category', 'policy_absent', 'legacy_policy', 'policy_revision'] as const)('actual vendor source %s fails atomically', async change => {
    const f = await fixture()
    if (change === 'unpublished') await app.db!.query('update vendors set published_at=null where id=$1', [f.vendorId])
    if (change === 'blocked') await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
    if (change === 'owner_deleted') await app.db!.query('update users set deleted_at=now() where id=$1', [f.owner.userId])
    if (change === 'category') await app.db!.query("update vendors set category_id='photo' where id=$1", [f.vendorId])
    if (change === 'policy_absent') await app.db!.query('delete from vendor_availability_policy where vendor_id=$1', [f.vendorId])
    if (change === 'legacy_policy') await app.db!.tx(c => setAvailabilityPolicy(c, { vendorId: f.vendorId, actor: principal(f.owner), mode: 'legacy_day', expectedRevision: f.policyRevision }))
    await refused(f, () => prepare(f, change === 'policy_revision' ? { expectedPolicyRevision: '2' } : {}),
      change === 'category' ? 422 : change === 'policy_absent' || change === 'legacy_policy' || change === 'policy_revision' ? 409 : 404)
  })
  it.each(['missing', 'foreign'] as const)('unknown %s package fails without inventing a quote', async kind => {
    const f = await fixture(), other = kind === 'foreign' ? await fixture() : null
    await refused(f, () => prepare(f, { packageId: other?.packageId ?? randomUUID() }), 422, 'unknown_package')
  })
  it.each(['negative_price', 'bad_items', 'bad_name'] as const)('invalid persisted package %s is refused rather than copied as financial terms', async kind => {
    const f = await fixture()
    if (kind === 'negative_price') await app.db!.query('update vendor_packages set price=-1 where id=$1', [f.packageId])
    if (kind === 'bad_items') await app.db!.query("update vendor_packages set items='[1]'::jsonb where id=$1", [f.packageId])
    if (kind === 'bad_name') await app.db!.query("update vendor_packages set name='' where id=$1", [f.packageId])
    await refused(f, () => prepare(f, { packageId: f.packageId }), 422, 'validation_failed')
  })
  it.each(['booked', 'paid_deposit', 'done', 'cancelled'] as const)('selected committed/closed financial state %s cannot be reset or duplicated', async state => {
    const f = await fixture(), dealId = await rawSelected(f, state)
    await refused(f, () => prepare(f, { expectedSelectedDealId: dealId }), 409, 'resource_order_source_changed')
    await refused(f, () => prepare(f), 409, 'resource_order_slot_changed')
  })
  it('selected vendor/package/null-package mismatch and a prebooked position fail before changing money', async () => {
    const f = await fixture(), first = await prepare(f, { packageId: f.packageId }), other = await fixture()
    await refused(f, () => prepare(f, { expectedSelectedDealId: first.dealId }), 409, 'resource_order_source_changed')
    await refused(f, () => prepare(f, { expectedSelectedDealId: first.dealId, packageId: f.packageId, vendorId: other.vendorId }), 409, 'resource_order_source_changed')
    // Actual slots_prebooked_without_deal requires the live selection to be
    // cleared when a position is now prebooked elsewhere. Keep its old money.
    await app.db!.query('update slots set deal_id=null,prebooked_at=now() where id=$1', [f.slotId])
    await refused(f, () => prepare(f, { expectedSelectedDealId: first.dealId, packageId: f.packageId }), 409, 'resource_order_slot_changed')
    const empty = await fixture(); await app.db!.query('update slots set prebooked_at=now() where id=$1', [empty.slotId])
    await refused(empty, () => prepare(empty), 409, 'resource_order_slot_changed')
  })
  it('active assignment to a different real root refuses preparation; cancelled assignment history remains intact', async () => {
    const f = await fixture(), otherSlot = randomUUID(), dealId = randomUUID()
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Synthetic other root position')", [otherSlot, f.weddingId])
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state) values($1,$2,$3,$4,'candidate')", [dealId, f.weddingId, otherSlot, f.vendorId])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [otherSlot, dealId])
    const assigned = await app.db!.tx(c => createOrderAssignment(c, { weddingId: f.weddingId, dealId, actor: principal(f.pair), expectedVersion: '1', slotId: f.slotId, programEventId: f.eventId, label: 'Actual scoped extra duty' }))
    await refused(f, () => prepare(f), 409, 'slot_assigned')
    await app.db!.tx(c => cancelOrderAssignment(c, { weddingId: f.weddingId, dealId, actor: principal(f.pair), expectedVersion: assigned.version,
      assignmentId: assigned.assignments[0]!.id, expectedAssignmentVersion: assigned.assignments[0]!.version }))
    const before = await snapshot(f), selected = await prepare(f), after = await snapshot(f)
    expect(selected.created).toBe(true); expect(after.assignments).toEqual(before.assignments)
    expect(after.deals).toHaveLength(2)
    expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1 and slot_id=$2', [f.weddingId, f.slotId])).rows[0]!.n).toBe(1)
  })
  it('an active assignment of the exact selected root remains draft scope and does not block an unchanged retry', async () => {
    const f = await fixture(), selected = await prepare(f)
    const assigned = await app.db!.tx(c => createOrderAssignment(c, { weddingId: f.weddingId, dealId: selected.dealId, actor: principal(f.pair),
      expectedVersion: selected.orderVersion, slotId: f.slotId, programEventId: f.eventId, label: 'Actual own delivery scope' }))
    const before = await snapshot(f)
    expect(await prepare(f, { expectedSelectedDealId: selected.dealId })).toEqual({ ...selected, orderVersion: assigned.version, created: false })
    expect(await snapshot(f)).toEqual(before)
    expect(before.deals).toHaveLength(1); expect(before.allocations).toEqual([]); expect(before.receipts).toEqual([])
  })
  it.each([
    ['extra price', (value: ResourceOrderPreparationInput) => ({ ...value, price: { amount: 1 } })],
    ['extra state', (value: ResourceOrderPreparationInput) => ({ ...value, state: 'booked' })],
    ['extra resource facts', (value: ResourceOrderPreparationInput) => ({ ...value, lines: [{ quantity: 1 }] })],
    ['actor authority', (value: ResourceOrderPreparationInput) => ({ ...value, actor: { ...value.actor, role: 'couple' } })],
    ['undefined optional package', (value: ResourceOrderPreparationInput) => ({ ...value, packageId: undefined })],
    ['zero revision', (value: ResourceOrderPreparationInput) => ({ ...value, expectedPolicyRevision: '0' })],
    ['noncanonical revision', (value: ResourceOrderPreparationInput) => ({ ...value, expectedPolicyRevision: '01' })],
    ['decimal revision', (value: ResourceOrderPreparationInput) => ({ ...value, expectedPolicyRevision: '1.0' })],
    ['bigint overflow', (value: ResourceOrderPreparationInput) => ({ ...value, expectedPolicyRevision: '9223372036854775808' })],
  ] as const)('invalid exact domain input %s cannot inject financial facts', async (_label, corrupt) => {
    const f = await fixture()
    await refused(f, () => app.db!.tx(c => prepareCatalogResourceOrder(c, corrupt(input(f)) as unknown as ResourceOrderPreparationInput)), 422)
  })

  async function observeWait(change: string, holder: number, waiter?: number) {
    let found: { pid: number; wait_event: string | null; query: string }[] = []
    for (let attempt = 0; attempt < 120; attempt++) {
      found = (await app.db!.query<{ pid: number; wait_event: string | null; query: string }>(`select pid,wait_event,query from pg_stat_activity
        where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))
          and ($2::integer is null or pid=$2)`, [holder, waiter ?? null])).rows
      if (found.length) break
      await new Promise<void>(done => setTimeout(done, 25))
    }
    expect(found, `${change}: observe a real PostgreSQL row-lock wait before releasing fixture holder`).toHaveLength(1)
    const row = found[0]!
    waits.push({ change, holder, waiter: row.pid, waitEvent: row.wait_event, query: row.query })
    return row
  }
  async function waited(f: Fixture, change: string, lock: string, values: readonly unknown[], mutate: (c: Queryable) => Promise<unknown>, patch: Partial<ResourceOrderPreparationInput> = {}) {
    const release = deferred(), ready = deferred(); let holderPid = 0, waiterPid = 0
    let expected: Awaited<ReturnType<typeof snapshot>> | undefined
    const holder = outcome(app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query(lock, values); ready.resolve(); await release.promise
      await mutate(c); expected = await snapshot(f, c)
    }))
    await Promise.race([ready.promise, holder.then(() => { throw new Error(`${change}: holder exited before its source lock`) })])
    const attempted = outcome(app.db!.tx(async c => {
      waiterPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      return prepareCatalogResourceOrder(c, input(f, patch))
    }))
    try {
      await observeWait(change, holderPid, waiterPid || undefined)
      release.resolve(); expect((await holder).ok).toBe(true)
      return { attempted: await attempted, expected }
    } finally { release.resolve(); await holder; await attempted }
  }
  it.each(['role', 'membership', 'session', 'consent', 'account', 'cancelled'] as const)('real wedding wait rechecks changed %s before selecting any financial root', async change => {
    const f = await fixture()
    const result = await waited(f, `wedding ${change}`, 'select id from weddings where id=$1 for update', [f.weddingId], c => {
      if (change === 'role') return c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.weddingId, f.pair.userId])
      if (change === 'membership') return c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.weddingId, f.pair.userId])
      if (change === 'session') return c.query('update sessions set revoked_at=now() where id=$1', [f.pair.sessionId])
      if (change === 'consent') return c.query('update consents set withdrawn_at=now() where user_id=$1', [f.pair.userId])
      if (change === 'account') return c.query('update users set deleted_at=now() where id=$1', [f.pair.userId])
      return c.query('update weddings set cancelled_at=now() where id=$1', [f.weddingId])
    })
    expect(result.attempted.ok).toBe(false)
    if (!result.attempted.ok) expect(result.attempted.error).toMatchObject({ statusCode: change === 'role' || change === 'consent' ? 403 : change === 'session' || change === 'account' ? 401 : 404 })
    expect(await snapshot(f)).toEqual(result.expected)
  })
  it.each(['owner', 'blocked', 'category', 'publication'] as const)('real company wait rechecks actual %s and fails closed on stale source', async change => {
    const f = await fixture(), next = change === 'owner' ? await actor() : null
    if (next) f.people.push(next)
    const result = await waited(f, `company ${change}`, 'select id from vendors where id=$1 for update', [f.vendorId], c => {
      if (change === 'owner') return c.query('update vendors set user_id=$2 where id=$1', [f.vendorId, next!.userId])
      if (change === 'blocked') return c.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
      if (change === 'category') return c.query("update vendors set category_id='photo' where id=$1", [f.vendorId])
      return c.query('update vendors set published_at=null where id=$1', [f.vendorId])
    })
    expect(result.attempted.ok).toBe(false)
    if (!result.attempted.ok) expect(result.attempted.error).toMatchObject({ statusCode: change === 'owner' ? 409 : change === 'category' ? 422 : 404 })
    expect(await snapshot(f)).toEqual(result.expected)
  })
  it.each(['mode', 'revision'] as const)('real policy wait rechecks %s without using the preliminary company mode', async change => {
    const f = await fixture()
    const result = await waited(f, `policy ${change}`, 'select vendor_id from vendor_availability_policy where vendor_id=$1 for update', [f.vendorId],
      c => c.query(`update vendor_availability_policy set revision=revision+1${change === 'mode' ? ",mode='legacy_day'" : ''} where vendor_id=$1`, [f.vendorId]))
    expect(result.attempted.ok).toBe(false)
    if (!result.attempted.ok) expect(result.attempted.error).toMatchObject({ statusCode: 409, code: change === 'mode' ? 'resource_policy_required' : 'order_version_conflict' })
    expect(await snapshot(f)).toEqual(result.expected)
  })
  it('actual package row wait copies the freshly committed bigint quote instead of a preliminary price', async () => {
    const f = await fixture()
    const result = await waited(f, 'package quote changed', 'select id from vendor_packages where id=$1 for update', [f.packageId],
      c => c.query("update vendor_packages set name='Fresh locked quote',price=9223372036854775807,items='[\"Fresh locked items\"]'::jsonb where id=$1", [f.packageId]), { packageId: f.packageId })
    expect(result.attempted.ok).toBe(true)
    if (result.attempted.ok) expect(await financial(result.attempted.value.dealId)).toMatchObject({ price: '9223372036854775807', package_title_snapshot: 'Fresh locked quote', package_includes_snapshot: ['Fresh locked items'] })
    expect((await snapshot(f)).deals).toHaveLength(1)
  })
  it('actual package deletion after a real row wait refuses an empty-slot preparation without inventing a replacement quote', async () => {
    const f = await fixture()
    const result = await waited(f, 'package deleted', 'select id from vendor_packages where id=$1 for update', [f.packageId],
      c => c.query('delete from vendor_packages where id=$1', [f.packageId]), { packageId: f.packageId })
    expect(result.attempted.ok).toBe(false)
    if (!result.attempted.ok) expect(result.attempted.error).toMatchObject({ statusCode: 422, code: 'unknown_package' })
    expect(await snapshot(f)).toEqual(result.expected)
  })
  it('selected-root row wait reads current contacted state while preserving its exact financial snapshot and version', async () => {
    const f = await fixture(), selected = await prepare(f), original = await financial(selected.dealId)
    const result = await waited(f, 'selected draft state advanced', 'select id from deals where id=$1 for update', [selected.dealId],
      c => c.query("update deals set state='contacted' where id=$1", [selected.dealId]), { expectedSelectedDealId: selected.dealId })
    expect(result.attempted.ok).toBe(true)
    if (result.attempted.ok) expect(result.attempted.value).toEqual({ ...selected, state: 'contacted', created: false })
    expect(await financial(selected.dealId)).toEqual({ ...original, state: 'contacted' })
    expect(await snapshot(f)).toEqual(result.expected)
  })
  it('real selected slot wait rejects a newly prebooked source before touching financial history', async () => {
    const f = await fixture()
    const result = await waited(f, 'slot prebook changed', 'select id from slots where id=$1 for update', [f.slotId],
      c => c.query('update slots set prebooked_at=now() where id=$1', [f.slotId]))
    expect(result.attempted.ok).toBe(false)
    if (!result.attempted.ok) expect(result.attempted.error).toMatchObject({ statusCode: 409, code: 'resource_order_slot_changed' })
    expect(await snapshot(f)).toEqual(result.expected)
  })
  it('a separately held legacy calendar row does not block quiet resource draft preparation or become a new day hold', async () => {
    const f = await fixture()
    await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual')", [f.vendorId, DATE])
    const before = await snapshot(f)
    await app.db!.tx(async holder => {
      await holder.query('select date from vendor_busy_dates where vendor_id=$1 and date=$2 for update', [f.vendorId, DATE])
      const prepared = await app.db!.tx(async client => {
        // A real SQL deadline prevents an accidental calendar wait from
        // turning this positive control into an unbounded test pause.
        await client.query("set local statement_timeout='2s'")
        return prepareCatalogResourceOrder(client, input(f))
      })
      expect(prepared.created).toBe(true)
    })
    const actual = await snapshot(f)
    expect(actual.busy).toEqual(before.busy); expect(actual.policy).toEqual(before.policy)
    expect(actual.allocations).toEqual([]); expect(actual.payments).toEqual([]); expect(actual.deals).toHaveLength(1)
  })
  it('two actual preparations wait on the same wedding and leave exactly one selected financial root/event/audit', async () => {
    const f = await fixture(), ready = deferred(), release = deferred(); let holderPid = 0, waiterPid = 0
    const first = outcome(app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      const prepared = await prepareCatalogResourceOrder(c, input(f)); ready.resolve(); await release.promise; return prepared
    }))
    await Promise.race([ready.promise, first.then(() => { throw new Error('Initial preparation ended before ready') })])
    const second = outcome(app.db!.tx(async c => {
      waiterPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      return prepareCatalogResourceOrder(c, input(f))
    }))
    try {
      await observeWait('two financial preparations', holderPid, waiterPid || undefined); release.resolve()
      const winner = await first, loser = await second
      expect(winner.ok).toBe(true); expect(loser.ok).toBe(false)
      if (!loser.ok) expect(loser.error).toMatchObject({ statusCode: 409, code: 'resource_order_slot_changed' })
      const actual = await snapshot(f)
      expect(actual.deals).toHaveLength(1); expect(actual.dealEvents).toHaveLength(1)
      expect(actual.audit!.filter(row => row.action === 'order.resource_order_prepared')).toHaveLength(1)
      if (winner.ok) expect(actual.slots!.find(row => row.id === f.slotId)?.deal_id).toBe(winner.value.dealId)
    } finally { release.resolve(); await first; await second }
  })
  it('actual SQL failure after preparation has written every row rolls back root, slot, event and audit', async () => {
    const f = await fixture(), before = await snapshot(f)
    let witnessed = false
    await expect(app.db!.tx(async c => {
      const prepared = await prepareCatalogResourceOrder(c, input(f))
      expect((await c.query('select id from deals where id=$1', [prepared.dealId])).rows).toHaveLength(1)
      expect((await c.query('select id from deal_events where deal_id=$1', [prepared.dealId])).rows).toHaveLength(1)
      witnessed = true; await c.query('select 1/0')
    })).rejects.toMatchObject({ code: '22012' })
    expect(witnessed).toBe(true); expect(await snapshot(f)).toEqual(before)
    expect((await prepare(f)).created).toBe(true)
    expect((await snapshot(f)).deals).toHaveLength(1)
  })
  it('a real narrowly conditioned audit trigger fails after the preceding financial writes and rolls the whole transaction back', async () => {
    const f = await fixture(), suffix = randomUUID().replaceAll('-', ''), name = `prep_audit_${suffix}`
    const before = await snapshot(f)
    await app.db!.query(`create function ${name}() returns trigger language plpgsql as $$ begin
      if NEW.action='order.resource_order_prepared' and NEW.actor_id='${f.pair.userId}'::uuid and NEW.diff->>'slotId'='${f.slotId}' then
        raise exception 'synthetic preparation audit witness' using errcode='23514';
      end if; return NEW; end $$`)
    try {
      await app.db!.query(`create trigger ${name} before insert on audit_log for each row execute function ${name}()`)
      await expect(prepare(f)).rejects.toMatchObject({ code: '23514', message: 'synthetic preparation audit witness' })
      expect(await snapshot(f)).toEqual(before)
    } finally {
      await app.db!.query(`drop trigger if exists ${name} on audit_log`)
      await app.db!.query(`drop function if exists ${name}()`)
    }
    expect((await prepare(f)).created).toBe(true)
  })
  it('registered profile package deletion waits before company/package locks and selected retry completes without a deadlock or lost money snapshot', async () => {
    const f = await fixture(), prepared = await prepare(f, { packageId: f.packageId }), original = await financial(prepared.dealId)
    const city = (await app.db!.query<{ name: string; region: string }>('select name,region from cities order by id limit 1')).rows[0]
    assert(city, 'Actual seeded city is required by the registered profile writer')
    const before = await snapshot(f), paused = deferred(), release = deferred(); let retryPid = 0, stopped = false
    const retry = outcome(app.db!.tx(async c => {
      retryPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      // Instrumentation forwards every SQL unchanged to this real connection.
      // Pause after actual wedding/slot/deal/order/account locks, before company.
      const instrumented: Queryable = { query: async <T extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
        if (!stopped && /^select user_id,category_id,published_at,blocked_at from vendors\b/.test(sql)) {
          stopped = true; paused.resolve(); await release.promise
        }
        return c.query<T>(sql, values)
      } }
      return prepareCatalogResourceOrder(instrumented, input(f, { expectedSelectedDealId: prepared.dealId, packageId: f.packageId }))
    }))
    await Promise.race([paused.promise, retry.then(() => { throw new Error('Selected retry ended before reaching its real company wait boundary') })])
    const writer = app.inject({ method: 'PUT', url: '/vendor/profile', headers: auth(f.owner),
      payload: { name: 'Synthetic preparation company', categoryId: 'florist', city: { name: city.name, region: city.region }, packages: [] } })
    try {
      const waited = await observeWait('registered profile deletion versus selected retry', retryPid)
      // Before the writer fix this is DELETE vendor_packages: the company row
      // is already held backwards, and releasing retry exposes a real40P01.
      expect(waited.query).toMatch(/\bselect\b[\s\S]*\b(weddings|deals)\b[\s\S]*\bfor\s+update\b/i)
      release.resolve()
      const read = await retry, written = await writer
      expect(read.ok).toBe(true)
      if (read.ok) expect(read.value).toEqual({ ...prepared, created: false })
      expect(written.statusCode, written.body).toBe(200)
      expect(await financial(prepared.dealId)).toEqual({ ...original, package_id: null })
      const after = await snapshot(f)
      expect(after.deals).toHaveLength(1); expect(after.orders).toHaveLength(1)
      expect(after.slots).toEqual(before.slots); expect(after.dealEvents).toEqual(before.dealEvents)
      expect(after.payments).toEqual(before.payments); expect(after.allocations).toEqual(before.allocations)
      expect(after.audit!.filter(row => row.action === 'order.resource_order_prepared')).toHaveLength(1)
      await refused(f, () => prepare(f, { expectedSelectedDealId: prepared.dealId, packageId: f.packageId }), 409, 'resource_order_source_changed')
      expect(await prepare(f, { expectedSelectedDealId: prepared.dealId, packageId: null })).toEqual({ ...prepared, created: false })
    } finally { release.resolve(); await retry; await writer }
  })
})
