import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disposablePgPort } from './disposablePgPort.js'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import type { OrderActor } from '../src/orders/context.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart, cancelOrderPart, type OrderInput } from '../src/orders/model.js'
import { loadOrderResourcePlan, saveOrderResourcePlan, type ResourcePlanLineInput } from '../src/orders/resource-plan.js'
import { publishOrderTerms, loadOrderTerms, acceptOrderTerms } from '../src/orders/terms.js'
import { createResource, createCapacityWindow, retireResource } from '../src/resources/model.js'
import { setAvailabilityPolicy } from '../src/resources/policy.js'
import { inviteStaff, acceptStaffInvite, revokeStaff, type StaffRole } from '../src/vendor/staff.js'
import { cancelDeal } from '../src/deals/cancel.js'
import { eraseUser, purgeArchivedWeddings } from '../src/jobs/index.js'
import { commitAgreedOrderResources, replaceAgreedOrderResources, loadOrderResourceCommitments,
  releaseCancelledDealResources, prepareDealResourceRelease, releasePreparedDealResources,
  type CommitResourceInput } from '../src/resources/commitments.js'

const DATABASE = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const START = '2027-06-14T10:00:00+03:00', END = '2027-06-14T11:00:00+03:00'
const proof = { secret: 'synthetic-commitment-proof-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' }

describe.skipIf(!DATABASE)('actual PostgreSQL resource commitments kernel; synthetic agreed orders, not public booking acceptance', () => {
  let db: Db
  const users = new Set<string>(), vendors = new Set<string>(), weddings = new Set<string>(), resources = new Set<string>()
  const witnesses: { change: string; holder: number; waiter: number; waitEvent: string | null }[] = []
  const phone = String(randomInt(100_000, 999_999)); let sequence = 0

  beforeAll(async () => {
    const target = new URL(DATABASE!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_allocations_20260930_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    db = createDb(DATABASE!)
    const live = (await db.query<{ name: string; principal: string; address: string; port: number }>(
      'select current_database() name,current_user principal,host(inet_server_addr()) address,inet_server_port() port')).rows[0]!
    expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
    expect(['127.0.0.1', '::1']).toContain(live.address); expect(live.port).toBe(Number(disposablePgPort()))
  })
  afterAll(async () => {
    if (!db) return
    try {
      process.stdout.write(`RESOURCE_COMMITMENTS_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      process.stdout.write(`RESOURCE_COMMITMENTS_FIXTURE_MANIFEST ${JSON.stringify({ database: new URL(DATABASE!).pathname.slice(1),
        users: [...users], vendors: [...vendors], weddings: [...weddings], resources: [...resources] })}\n`)
      // Immutable history is removed only through actual whole-wedding cascade.
      // No triggers, constraints, sessions of others or global tables are changed.
      for (const id of weddings) await db.query('delete from weddings where id=$1', [id])
      await db.query('delete from vendor_resources where id=any($1::uuid[])', [[...resources]])
      for (const id of vendors) await db.query('delete from vendors where id=$1', [id])
      await db.query('delete from resource_conflict_keys where identity=any($1::uuid[])', [[...resources, ...users]])
      for (const id of users) await db.query('delete from users where id=$1', [id])
    } finally { await db.close() }
  })

  async function actor(): Promise<OrderActor> {
    const userId = randomUUID(), sessionId = randomUUID(); users.add(userId)
    await db.query("insert into users(id,phone,name) values($1,$2,'Synthetic commitments actor')", [userId, `+79${phone}${String(++sequence).padStart(4, '0')}`])
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await db.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    return { userId, sessionId, policyVersion: POLICY }
  }
  async function staff(vendorId: string, owner: OrderActor, role: StaffRole, person?: OrderActor) {
    const account = person ?? await actor()
    const invited = await db.tx(c => inviteStaff(c, { vendorId, actor: owner, role, targetUserId: account.userId }))
    const accepted = await db.tx(c => acceptStaffInvite(c, { token: invited.token, actor: account }))
    return { actor: account, id: accepted.id, version: accepted.version }
  }
  async function company(sharedPerson?: OrderActor) {
    const owner = await actor(), vendorId = randomUUID(); vendors.add(vendorId)
    await db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic commitments company',now())", [vendorId, owner.userId])
    const worker = await staff(vendorId, owner, 'worker', sharedPerson), manager = await staff(vendorId, owner, 'resource_manager')
    const make = async (kind: 'equipment' | 'person' | 'capacity', label: string,
      extra: { personUserId?: string; staffMemberId?: string; capacityUnit?: string } = {}) => {
      const resource = await db.tx(c => createResource(c, { vendorId, actor: owner, kind, label, ...extra }))
      resources.add(resource.id); return resource
    }
    const kit = await make('equipment', 'Actual vase set'), otherKit = await make('equipment', 'Actual second vase set')
    const person = await make('person', 'Actual accepted worker', { personUserId: worker.actor.userId, staffMemberId: worker.id })
    const capacity = await make('capacity', 'Actual bouquet production', { capacityUnit: 'bouquets' })
    const window = await db.tx(c => createCapacityWindow(c, { vendorId, actor: owner, resourceId: capacity.id,
      startsAt: '2027-06-12T00:00:00Z', endsAt: '2027-06-18T23:00:00Z', capacity: 10 }))
    const policy = await db.tx(c => setAvailabilityPolicy(c, { vendorId, actor: owner, mode: 'resources', expectedRevision: '0' }))
    return { vendorId, owner, worker, manager, kit, otherKit, person, capacity, window, policyRevision: policy.revision }
  }
  type Company = Awaited<ReturnType<typeof company>>
  async function wedding() {
    const couple = await actor(), partner = await actor(), helper = await actor(), weddingId = randomUUID(); weddings.add(weddingId)
    await db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic commitments wedding','2027-06-14','Europe/Moscow',$3)", [weddingId, couple.userId, randomUUID()])
    for (const p of [couple, partner]) await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, p.userId])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [weddingId, helper.userId])
    const eventId = (await db.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    return { weddingId, couple, partner, helper, eventId }
  }
  type Wedding = Awaited<ReturnType<typeof wedding>>
  async function fixture(options: { company?: Company; wedding?: Wedding; state?: 'candidate' | 'contacted' | 'negotiating' } = {}) {
    const co = options.company ?? await company(), wed = options.wedding ?? await wedding()
    const dealId = randomUUID(), slotId = randomUUID(), initialState = options.state ?? 'candidate'
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Synthetic bouquet position')", [slotId, wed.weddingId])
    await db.query(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,currency,package_title_snapshot,package_includes_snapshot,negotiating_until)
      values($1,$2,$3,$4,$5,9007199254740993,'RUB','Frozen inherited package','["Five compositions"]'::jsonb,
      case when $5='negotiating' then clock_timestamp()+interval '1 hour' else null end)`, [dealId, wed.weddingId, slotId, co.vendorId, initialState])
    await db.query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
    await db.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',12000,'recorded','cash','private')", [randomUUID(), dealId])
    const base = { weddingId: wed.weddingId, dealId, actor: wed.couple }
    const assigned = await db.tx(c => createOrderAssignment(c, { ...base, expectedVersion: '1', slotId, programEventId: wed.eventId, label: 'Actual ceremony delivery duty' }))
    const assignmentId = assigned.assignments[0]!.id
    const order = await db.tx(c => createOrderPart(c, { ...base, expectedVersion: assigned.version, assignmentId,
      kind: 'supply', title: 'Five flower compositions', details: { quantity: 5, unit: 'compositions',
        windowStartsAt: '2027-06-14T07:00:00Z', windowEndsAt: '2027-06-14T08:00:00Z' } }))
    const partId = order.parts[0]!.id
    // This inherited synthetic program acknowledgment is a byte-preservation
    // control, never a substitute for actual new order-terms party receipts.
    const version = (await db.query<{ v: string }>('select timeline_version::text v from weddings where id=$1', [wed.weddingId])).rows[0]!.v
    const inherited = { syntheticInheritedFixture: true, blocks: [] }, digest = createHash('sha256').update(JSON.stringify(inherited)).digest('hex')
    await db.query(`insert into vendor_program_acknowledgments(wedding_id,vendor_id,user_id,session_id,version,digest,program_snapshot)
      values($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict do nothing`, [wed.weddingId, co.vendorId, co.owner.userId, co.owner.sessionId, version, digest, JSON.stringify(inherited)])
    return { ...co, ...wed, dealId, slotId, assignmentId, partId, initialState }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const input = (f: Fixture, principal = f.couple): OrderInput => ({ weddingId: f.weddingId, dealId: f.dealId, actor: principal })
  const line = (f: Fixture, patch: Partial<ResourcePlanLineInput> = {}): ResourcePlanLineInput => ({ partId: f.partId,
    resourceId: f.kit.id, capacityWindowId: null, quantity: 1, startsAt: START, endsAt: END, timeZone: 'Europe/Moscow',
    setupMinutes: 30, teardownMinutes: 40, travelBeforeMinutes: 10, travelAfterMinutes: 20, ...patch })
  const zeroBuffers = { setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0 }
  const capacityLine = (f: Fixture, quantity = 2, patch: Partial<ResourcePlanLineInput> = {}) => line(f,
    { resourceId: f.capacity.id, capacityWindowId: f.window.id, quantity, ...patch })
  const head = async (f: Fixture, c: Queryable = db) => (await c.query<{ version: string; planRevision: string; planId: string | null; termsRevision: string }>(
    `select version::text,resource_plan_revision::text as "planRevision",resource_plan_id as "planId",terms_revision::text as "termsRevision"
      from deal_orders where wedding_id=$1 and deal_id=$2`, [f.weddingId, f.dealId])).rows[0]!
  async function save(f: Fixture, lines: ResourcePlanLineInput[]) {
    const h = await head(f)
    return db.tx(c => saveOrderResourcePlan(c, { ...input(f, f.owner), expectedVersion: h.version, expectedPlanRevision: h.planRevision, lines }))
  }
  async function propose(f: Fixture, lines: ResourcePlanLineInput[]) {
    await save(f, lines); const h = await head(f)
    return db.tx(c => publishOrderTerms(c, { ...input(f), expectedOrderVersion: h.version, expectedTermsRevision: h.termsRevision }))
  }
  async function accept(f: Fixture, principal: OrderActor) {
    const read = await db.tx(c => loadOrderTerms(c, input(f, principal), proof)), selected = read.selected!
    expect(read.readToken).toBeTypeOf('string')
    return db.tx(c => acceptOrderTerms(c, { ...input(f, principal), termsId: selected.id, expectedTermsVersion: selected.version,
      digest: selected.digest, readToken: read.readToken! }, proof))
  }
  async function command(f: Fixture): Promise<CommitResourceInput> {
    const h = await head(f), read = await db.tx(c => loadOrderTerms(c, input(f), proof)), selected = read.selected!
    const current = (await db.query<{ revision: string }>('select revision::text from deal_resource_commitments where deal_id=$1', [f.dealId])).rows[0]
    return { ...input(f), expectedOrderVersion: h.version, expectedCommitmentRevision: current?.revision ?? '0', termsId: selected.id,
      expectedTermsVersion: selected.version, termsDigest: selected.digest, planRevisionId: h.planId!, expectedPolicyRevision: f.policyRevision }
  }
  async function agree(f: Fixture, lines = [line(f)]) {
    const published = await propose(f, lines)
    await accept(f, f.couple); const accepted = await accept(f, f.owner)
    expect(accepted.agreedTermsId).toBe(published.proposedTermsId)
    const receipts = accepted.selected!.receipts
    expect(receipts.map(r => r.party).sort()).toEqual(['customer', 'performer'])
    expect(new Set(receipts.map(r => r.userId)).size).toBe(2); expect(new Set(receipts.map(r => r.sessionId)).size).toBe(2)
    return command(f)
  }
  const commit = (f: Fixture, cmd?: CommitResourceInput) => cmd ? db.tx(c => commitAgreedOrderResources(c, cmd)) :
    command(f).then(current => db.tx(c => commitAgreedOrderResources(c, current)))
  const replace = (cmd: CommitResourceInput) => db.tx(c => replaceAgreedOrderResources(c, cmd))
  async function stable(f: Fixture, c: Queryable = db) {
    const reads = [
      () => c.query('select id,wedding_id,slot_id,vendor_id,price,currency,package_id,package_title_snapshot,package_includes_snapshot from deals where id=$1', [f.dealId]),
      () => c.query('select * from payments where deal_id=$1 order by id', [f.dealId]),
      () => c.query('select * from order_parts where deal_id=$1 order by id', [f.dealId]),
      () => c.query('select * from order_assignments where deal_id=$1 order by id', [f.dealId]),
      () => c.query('select * from wedding_events where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select * from timeline_events where wedding_id=$1 order by id', [f.weddingId]),
      () => c.query('select * from vendor_program_acknowledgments where wedding_id=$1 order by vendor_id,version,digest', [f.weddingId]),
    ]
    const result = []
    // Queryable can be one transaction client: start the next query only after
    // the preceding result, preserving the full original snapshot and order.
    for (const read of reads) result.push(await read())
    return result.map(r => r.rows)
  }
  async function state(f: Fixture, c: Queryable = db) {
    const reads = [
      () => c.query('select * from deal_orders where deal_id=$1', [f.dealId]),
      () => c.query('select * from deal_resource_commitments where deal_id=$1', [f.dealId]),
      () => c.query('select * from deal_resource_commitment_versions where deal_id=$1 order by revision', [f.dealId]),
      () => c.query('select * from resource_allocations where deal_id=$1 order by id', [f.dealId]),
      () => c.query('select * from deal_resource_commitment_members where deal_id=$1 order by version_id,line_index', [f.dealId]),
      () => c.query('select * from deals where id=$1', [f.dealId]),
      () => c.query('select * from deal_events where deal_id=$1 order by id', [f.dealId]),
      () => c.query('select * from leads where wedding_id=$1 and vendor_id=$2 order by id', [f.weddingId, f.vendorId]),
      () => c.query('select * from audit_log where entity_id=$1 order by id', [f.dealId]),
      () => c.query('select id,used,legacy_used from resource_capacity_windows where id=$1', [f.window.id]),
      () => c.query('select * from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId]),
    ]
    const result = []
    for (const read of reads) result.push(await read())
    return result.map(r => r.rows)
  }
  async function allocations(f: Fixture, c: Queryable = db) {
    return (await c.query('select * from resource_allocations where deal_id=$1 order by id', [f.dealId])).rows
  }
  async function refused(f: Fixture, action: () => Promise<unknown>, status: number | null = null) {
    const before = await state(f), business = await stable(f)
    if (status === null) await expect(action()).rejects.toMatchObject({ statusCode: expect.any(Number) })
    else await expect(action()).rejects.toMatchObject({ statusCode: status })
    expect(await state(f)).toEqual(before); expect(await stable(f)).toEqual(business)
  }
  async function cancelAndRelease(f: Fixture) {
    return db.tx(async c => {
      const scope = await prepareDealResourceRelease(c, { weddingId: f.weddingId, dealId: f.dealId })
      // Actual financial source transition, confined to this fixture. This tests
      // the trusted kernel seam, not completion of the public cancellation route.
      await c.query("update deals set state='cancelled',cancelled_at=clock_timestamp(),cancel_reason='Synthetic test cancellation' where id=$1", [f.dealId])
      return releasePreparedDealResources(c, scope, 'deal_cancelled')
    })
  }

  it('initial summary is not reserved and cannot expose private resource/account/window identities', async () => {
    const f = await fixture(), before = await state(f)
    for (const principal of [f.couple, f.partner, f.owner]) {
      const view = await db.tx(c => loadOrderResourceCommitments(c, input(f, principal)))
      expect(view).toEqual({ revision: '0', state: 'not_reserved', termsId: null, planRevisionId: null, reservation: 'not_reserved' })
    }
    expect(await state(f)).toEqual(before)
  })
  it('saving and actually agreeing to a plan still leaves the ledger unreserved until explicit commit', async () => {
    const f = await fixture(); await agree(f, [line(f), capacityLine(f)])
    expect((await db.tx(c => loadOrderResourcePlan(c, input(f)))).reservation).toBe('not_reserved')
    expect(await db.tx(c => loadOrderResourceCommitments(c, input(f)))).toMatchObject({ revision: '0', state: 'not_reserved' })
    expect(await allocations(f)).toEqual([])
    expect((await db.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 0 }])
  })
  it.each(['candidate', 'contacted', 'negotiating'] as const)('actual two-party plan promotes the SAME %s financial root and preserves money/program', async initialState => {
    const f = await fixture({ state: initialState }), cmd = await agree(f, [line(f), capacityLine(f)])
    const business = await stable(f), order = await head(f)
    expect(await commit(f, cmd)).toEqual({ revision: '1', state: 'reserved', termsId: cmd.termsId, planRevisionId: cmd.planRevisionId, reservation: 'reserved' })
    const financial = (await db.query('select * from deals where id=$1', [f.dealId])).rows[0]!
    expect(financial).toMatchObject({ id: f.dealId, state: 'booked', price: '9007199254740993', negotiating_until: null })
    expect(financial.booked_at).toBeInstanceOf(Date)
    expect((await db.query('select from_state,to_state,actor_id from deal_events where deal_id=$1', [f.dealId])).rows)
      .toEqual([{ from_state: initialState, to_state: 'booked', actor_id: f.couple.userId }])
    expect((await db.query('select state,hold_until from leads where vendor_id=$1 and wedding_id=$2', [f.vendorId, f.weddingId])).rows).toEqual([{ state: 'won', hold_until: null }])
    expect((await db.query('select * from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([])
    expect(await stable(f)).toEqual(business); expect(await head(f)).toEqual(order)
    const booked = await allocations(f)
    expect(booked).toHaveLength(2)
    expect(booked.find(r => r.kind === 'equipment')).toMatchObject({ occupied_starts_at: new Date('2027-06-14T06:20:00Z'), occupied_ends_at: new Date('2027-06-14T09:00:00Z'), quantity: 1, released_at: null })
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 2, legacy_used: 0 }])
    const summary = await db.tx(c => loadOrderResourceCommitments(c, input(f, f.partner)))
    for (const id of [f.kit.id, f.capacity.id, f.window.id, f.worker.actor.userId, f.owner.userId]) expect(JSON.stringify(summary)).not.toContain(id)
  })
  it('same accepted retry with initial0 and then current1 are no-ops; stale other revision cannot silently overwrite', async () => {
    const f = await fixture(), cmd = await agree(f)
    await commit(f, cmd); const before = await state(f), business = await stable(f)
    expect(await commit(f, cmd)).toMatchObject({ revision: '1', state: 'reserved' })
    expect(await commit(f)).toMatchObject({ revision: '1', state: 'reserved' })
    expect(await state(f)).toEqual(before); expect(await stable(f)).toEqual(business)
    await refused(f, () => commit(f, { ...cmd, expectedCommitmentRevision: '2' }), 409)
  })
  it('a candidate with an empty selected slot claims that SAME financial root in the actual booking transaction', async () => {
    const f = await fixture(), cmd = await agree(f)
    await db.query('update slots set deal_id=null where id=$1', [f.slotId])
    const business = await stable(f)
    expect(await commit(f, cmd)).toMatchObject({ revision: '1', state: 'reserved' })
    expect((await db.query('select deal_id from slots where id=$1', [f.slotId])).rows).toEqual([{ deal_id: f.dealId }])
    expect((await db.query('select id,state from deals where wedding_id=$1', [f.weddingId])).rows).toEqual([{ id: f.dealId, state: 'booked' }])
    expect(await stable(f)).toEqual(business)
  })
  it.each(['another_deal', 'prebooked'] as const)('an existing %s slot cannot be overwritten by accepted resource terms', async change => {
    const f = await fixture(), cmd = await agree(f)
    if (change === 'prebooked') await db.query('update slots set deal_id=null,prebooked_at=now() where id=$1', [f.slotId])
    else {
      const other = await fixture({ company: f, wedding: f })
      await db.query('update slots set deal_id=null where id=$1', [other.slotId])
      await db.query('update slots set deal_id=$2 where id=$1', [f.slotId, other.dealId])
    }
    await refused(f, () => commit(f, cmd), 409)
  })
  it.each(['owner', 'manager', 'worker', 'helper', 'stranger'] as const)('%s cannot reserve somebody else’s private order', async principal => {
    const f = await fixture(), cmd = await agree(f)
    const selected = principal === 'owner' ? f.owner : principal === 'manager' ? f.manager.actor : principal === 'worker' ? f.worker.actor : principal === 'helper' ? f.helper : await actor()
    await refused(f, () => commit(f, { ...cmd, actor: selected }), principal === 'owner' ? 403 : 404)
  })
  it('another actual couple member can commit, with the real acting member in the financial transition', async () => {
    const f = await fixture(), cmd = await agree(f)
    await commit(f, { ...cmd, actor: f.partner })
    expect((await db.query('select actor_id from deal_events where deal_id=$1', [f.dealId])).rows).toEqual([{ actor_id: f.partner.userId }])
  })
  it('done exact proof retry preserves finite existing promise, but done cannot accept newly agreed work', async () => {
    const f = await fixture(), cmd = await agree(f); await commit(f, cmd)
    await db.query("update deals set state='done',done_at=now() where id=$1", [f.dealId])
    const before = await state(f); expect(await commit(f, cmd)).toMatchObject({ revision: '1', state: 'reserved' }); expect(await state(f)).toEqual(before)
    const changed = await agree(f, [line(f, { resourceId: f.otherKit.id })]); await refused(f, () => replace(changed), 409)
  })
  it.each(['session', 'account', 'consent', 'policy', 'role'] as const)('current actor %s is rechecked even for an exact reserved retry', async change => {
    const f = await fixture(), cmd = await agree(f); await commit(f, cmd)
    if (change === 'session') await db.query('update sessions set revoked_at=now() where id=$1', [f.couple.sessionId])
    if (change === 'account') await db.query('update users set deleted_at=now() where id=$1', [f.couple.userId])
    if (change === 'consent') await db.query('update consents set withdrawn_at=now() where user_id=$1', [f.couple.userId])
    if (change === 'role') await db.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.weddingId, f.couple.userId])
    const stale = change === 'policy' ? { ...cmd, actor: { ...f.couple, policyVersion: 'wrong-current-policy' } } : cmd
    await refused(f, () => commit(f, stale), change === 'session' || change === 'account' ? 401 : change === 'role' ? 404 : 403)
  })
  it.each(['expectedOrderVersion', 'expectedCommitmentRevision', 'expectedTermsVersion', 'expectedPolicyRevision'] as const)('%s requires a precise supplied revision', async key => {
    const f = await fixture(), cmd = await agree(f)
    for (const value of ['-1', '01', '1.5', '', '9223372036854775808']) await refused(f, () => commit(f, { ...cmd, [key]: value }), 422)
    await refused(f, () => commit(f, { ...cmd, [key]: '99' }), 409)
  })
  it('private allocation facts cannot be client supplied or substituted by foreign accepted proof', async () => {
    const f = await fixture(), other = await fixture(), cmd = await agree(f), foreign = await agree(other)
    await refused(f, () => commit(f, { ...cmd, quantity: 1, resourceId: f.otherKit.id } as unknown as CommitResourceInput), 422)
    await refused(f, () => commit(f, { ...cmd, termsId: foreign.termsId }), 409)
    await refused(f, () => commit(f, { ...cmd, planRevisionId: foreign.planRevisionId }), 409)
    await refused(f, () => commit(f, { ...cmd, termsDigest: '0'.repeat(64) }), 422)
  })
  it.each(['none', 'customer_only', 'performer_only'] as const)('%s receipts do not fabricate two-party resource agreement', async receipts => {
    const f = await fixture(); await propose(f, [line(f)])
    if (receipts === 'customer_only') await accept(f, f.couple)
    if (receipts === 'performer_only') await accept(f, f.owner)
    await refused(f, () => commit(f), 409)
    expect(await allocations(f)).toEqual([])
  })
  it('a dual couple/company owner is one actual party and cannot fabricate distinct acceptance', async () => {
    const f = await fixture()
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.weddingId, f.owner.userId])
    await propose(f, [line(f)]); await accept(f, f.owner)
    await refused(f, () => commit(f), 409)
  })
  it('schema1 terms and an explicitly empty schema2 plan cannot reserve imaginary resources', async () => {
    const f = await fixture(), h = await head(f)
    await db.tx(c => publishOrderTerms(c, { ...input(f), expectedOrderVersion: h.version, expectedTermsRevision: h.termsRevision }))
    await accept(f, f.couple); await accept(f, f.owner)
    await refused(f, () => commit(f), 422)
    await save(f, [line(f)]); await agree(f, []); await refused(f, () => commit(f), 409)
  })
  it.each(['retired', 'part_changed', 'owner_changed', 'worker_revoked', 'person_deleted', 'policy_changed'] as const)('%s source cannot become a new resource promise from old terms', async change => {
    const f = await fixture(), cmd = await agree(f, [line(f, { resourceId: f.person.id })])
    if (change === 'retired') await db.tx(c => retireResource(c, { vendorId: f.vendorId, actor: f.owner, resourceId: f.person.id, expectedVersion: f.person.version }))
    if (change === 'part_changed') await db.query('update order_parts set version=version+1 where id=$1', [f.partId])
    if (change === 'owner_changed') await db.query('update vendors set user_id=$2 where id=$1', [f.vendorId, (await actor()).userId])
    if (change === 'worker_revoked') await db.tx(c => revokeStaff(c, { vendorId: f.vendorId, actor: f.owner, memberId: f.worker.id, expectedVersion: f.worker.version }))
    if (change === 'person_deleted') await db.query('update users set deleted_at=now() where id=$1', [f.worker.actor.userId])
    if (change === 'policy_changed') await db.tx(c => setAvailabilityPolicy(c, { vendorId: f.vendorId, actor: f.owner, mode: 'legacy_day', expectedRevision: f.policyRevision }))
    await refused(f, () => commit(f, cmd), change === 'part_changed' ? 422 : 409)
  })
  it.each(['booked', 'paid_deposit', 'done', 'manual_day', 'live_negotiating_other'] as const)('unreconciled %s obligation is preserved and refuses narrower new booking', async obligation => {
    const f = await fixture(), cmd = await agree(f)
    if (obligation === 'manual_day') await db.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,'2027-05-02','manual')", [f.vendorId])
    else if (obligation === 'live_negotiating_other') await fixture({ company: f, state: 'negotiating' })
    else await db.query('update deals set state=$2 where id=$1', [f.dealId, obligation])
    await refused(f, () => commit(f, cmd), 409)
  })
  it('pre-delivery production, complete buffers and cross-night rental keep their finite UTC spans', async () => {
    const f = await fixture(), production = capacityLine(f, 2, { startsAt: '2027-06-13T10:00:00+03:00', endsAt: '2027-06-13T12:00:00+03:00' })
    const rental = line(f, { startsAt: '2027-06-13T22:00:00+03:00', endsAt: '2027-06-15T07:00:00+03:00' })
    await commit(f, await agree(f, [production, rental]))
    const rows = await allocations(f)
    expect(rows.find(r => r.kind === 'capacity')).toMatchObject({ occupied_starts_at: new Date('2027-06-13T06:20:00Z'), occupied_ends_at: new Date('2027-06-13T10:00:00Z') })
    expect(rows.find(r => r.kind === 'equipment')).toMatchObject({ occupied_starts_at: new Date('2027-06-13T18:20:00Z'), occupied_ends_at: new Date('2027-06-15T05:00:00Z') })
  })
  it('capacity counts all inventory in the WHOLE window even for disjoint work times and preserves baseline', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 4)]))
    const foreign = await allocations(f), cmd = await agree(other, [capacityLine(other, 4,
      { startsAt: '2027-06-16T10:00:00+03:00', endsAt: '2027-06-16T11:00:00+03:00' })])
    await expect(commit(other, cmd)).rejects.toMatchObject({ statusCode: 409, code: 'resource_capacity_exhausted' })
    expect(await allocations(f)).toEqual(foreign); expect(await allocations(other)).toEqual([])
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 7, legacy_used: 3 }])
  })
  it('overlaps inside ONE order are rejected rather than guessing how to merge duties', async () => {
    const f = await fixture(), cmd = await agree(f, [line(f), line(f, { startsAt: '2027-06-14T10:30:00+03:00', endsAt: '2027-06-14T11:30:00+03:00' })])
    await refused(f, () => commit(f, cmd), 409)
  })
  it('adjacent equipment periods are allowed, but the four buffers participate in conflict', async () => {
    const f = await fixture(), same = await fixture({ company: f, wedding: f })
    await commit(f, await agree(f, [line(f, { ...zeroBuffers })]))
    await commit(same, await agree(same, [line(same, { ...zeroBuffers, startsAt: END, endsAt: '2027-06-14T12:00:00+03:00' })]))
    const third = await fixture({ company: f }), cmd = await agree(third, [line(third,
      { ...zeroBuffers, startsAt: '2027-06-14T12:00:00+03:00', endsAt: '2027-06-14T13:00:00+03:00', travelBeforeMinutes: 1 })])
    await refused(third, () => commit(third, cmd), 409)
  })

  async function waitForHolder(change: string, holderWork: (c: Queryable) => Promise<unknown>, mutate: (c: Queryable) => Promise<unknown>, action: (c: Queryable) => Promise<unknown>) {
    let release!: () => void, ready!: () => void, entered!: () => void, holderPid = 0, waiterPid = 0
    const permission = new Promise<void>(r => { release = r }), locked = new Promise<void>(r => { ready = r }), started = new Promise<void>(r => { entered = r })
    const holder = db.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await holderWork(c); ready(); await permission; await mutate(c)
    })
    await Promise.race([locked, holder.then(() => { throw new Error(`${change}: holder exited before its ready signal`) })])
    const waiter = db.tx(async c => {
      waiterPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query("set local lock_timeout='8s'"); entered(); return action(c)
    })
    const outcome = waiter.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    try {
      await started
      let witness: { wait_event: string | null } | undefined
      for (let attempt = 0; attempt < 120; attempt++) {
        witness = (await db.query<{ wait_event: string | null }>(`select wait_event from pg_stat_activity where pid=$1
          and wait_event_type='Lock' and $2=any(pg_blocking_pids(pid))`, [waiterPid, holderPid])).rows[0]
        if (witness) break
        await new Promise<void>(r => setTimeout(r, 25))
      }
      expect(witness, `${change}: real pg_blocking_pids witness for ${waiterPid} blocked by ${holderPid}`).toBeDefined()
      witnesses.push({ change, holder: holderPid, waiter: waiterPid, waitEvent: witness!.wait_event })
      release(); await holder; return await outcome
    } finally { release(); await holder; await outcome }
  }
  const noop = async () => undefined
  it('two commits of the same order wait on the real wedding and create one ledger, event and lead', async () => {
    const f = await fixture(), cmd = await agree(f)
    const result = await waitForHolder('same-order commit', c => commitAgreedOrderResources(c, cmd), noop, c => commitAgreedOrderResources(c, cmd))
    expect(result).toMatchObject({ ok: true, value: { revision: '1', state: 'reserved' } })
    expect(await allocations(f)).toHaveLength(1)
    expect((await db.query('select id from deal_events where deal_id=$1', [f.dealId])).rows).toHaveLength(1)
    expect((await db.query('select id from deal_resource_commitment_versions where deal_id=$1', [f.dealId])).rows).toHaveLength(1)
  })
  it('one real account across TWO companies/weddings cannot be promised twice, after an actual conflict-key wait', async () => {
    const shared = await actor(), f = await fixture({ company: await company(shared) }), other = await fixture({ company: await company(shared) })
    const one = await agree(f, [line(f, { resourceId: f.person.id })]), two = await agree(other, [line(other, { resourceId: other.person.id })])
    expect(f.person.id).not.toBe(other.person.id)
    const before = await state(other), business = await stable(other)
    const result = await waitForHolder('global person across companies', c => commitAgreedOrderResources(c, one), noop, c => commitAgreedOrderResources(c, two))
    expect(result).toMatchObject({ ok: false, error: { statusCode: 409, code: 'resource_booking_conflict' } })
    expect(await state(other)).toEqual(before); expect(await stable(other)).toEqual(business)
    expect(await allocations(f)).toHaveLength(1)
  })
  it('same-wedding equipment has no same-wedding overlap exemption after a real concurrent commit wait', async () => {
    const f = await fixture(), other = await fixture({ company: f, wedding: f }), one = await agree(f), two = await agree(other)
    const result = await waitForHolder('same-wedding equipment', c => commitAgreedOrderResources(c, one), noop, c => commitAgreedOrderResources(c, two))
    expect(result).toMatchObject({ ok: false, error: { statusCode: 409, code: 'resource_booking_conflict' } })
    expect(await allocations(f)).toHaveLength(1); expect(await allocations(other)).toHaveLength(0)
  })
  it('last capacity unit with pre-existing baseline goes to only one actual waiter', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=9,legacy_used=9 where id=$1', [f.window.id])
    const one = await agree(f, [capacityLine(f, 1)]), two = await agree(other, [capacityLine(other, 1)])
    const result = await waitForHolder('last whole-window capacity unit', c => commitAgreedOrderResources(c, one), noop, c => commitAgreedOrderResources(c, two))
    expect(result).toMatchObject({ ok: false, error: { statusCode: 409, code: 'resource_capacity_exhausted' } })
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 10, legacy_used: 9 }])
    expect(await allocations(f)).toHaveLength(1); expect(await allocations(other)).toEqual([])
  })
  it.each(['session', 'consent', 'account', 'role', 'membership_deleted'] as const)('actual wedding wait rechecks current actor %s before any promise', async change => {
    const f = await fixture(), cmd = await agree(f), before = await state(f), business = await stable(f)
    const result = await waitForHolder(`current actor ${change}`, c => c.query('select id from weddings where id=$1 for update', [f.weddingId]), async c => {
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.couple.sessionId])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [f.couple.userId])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [f.couple.userId])
      if (change === 'role') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.weddingId, f.couple.userId])
      if (change === 'membership_deleted') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.weddingId, f.couple.userId])
    }, c => commitAgreedOrderResources(c, cmd))
    expect(result).toMatchObject({ ok: false, error: { statusCode: change === 'session' || change === 'account' ? 401 : change === 'consent' ? 403 : 404 } })
    expect(await state(f)).toEqual(before); expect(await stable(f)).toEqual(business)
  })
  it.each(['blocked', 'owner_changed', 'staff_revoked', 'policy_changed'] as const)('actual company wait rechecks %s after the company row becomes visible', async change => {
    const f = await fixture(), cmd = await agree(f, [line(f, { resourceId: f.person.id })]), before = await state(f)
    const newOwner = change === 'owner_changed' ? await actor() : null
    const result = await waitForHolder(`company ${change}`, c => c.query('select id from vendors where id=$1 for update', [f.vendorId]), async c => {
      if (change === 'blocked') await c.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
      if (change === 'owner_changed') await c.query('update vendors set user_id=$2 where id=$1', [f.vendorId, newOwner!.userId])
      if (change === 'staff_revoked') await revokeStaff(c, { vendorId: f.vendorId, actor: f.owner, memberId: f.worker.id, expectedVersion: f.worker.version })
      if (change === 'policy_changed') await c.query("update vendor_availability_policy set mode='legacy_day',revision=revision+1 where vendor_id=$1", [f.vendorId])
    }, c => commitAgreedOrderResources(c, cmd))
    expect(result).toMatchObject({ ok: false, error: { statusCode: change === 'blocked' ? 404 : 409 } }); expect(await state(f)).toEqual(before)
  })
  it('real extra-person account wait rechecks deletion without saving accepted staff work', async () => {
    const f = await fixture(), cmd = await agree(f, [line(f, { resourceId: f.person.id })]), before = await state(f)
    const result = await waitForHolder('selected person account deleted', c => c.query('select id from users where id=$1 for update', [f.worker.actor.userId]),
      c => c.query('update users set deleted_at=now() where id=$1', [f.worker.actor.userId]), c => commitAgreedOrderResources(c, cmd))
    expect(result).toMatchObject({ ok: false, error: { statusCode: 409 } }); expect(await state(f)).toEqual(before)
  })
  it.each(['retired', 'material_changed'] as const)('real final resource wait rechecks %s instead of using its pre-wait projection', async change => {
    const f = await fixture(), cmd = await agree(f), before = await state(f)
    const result = await waitForHolder(`resource ${change}`, c => c.query('select id from vendor_resources where id=$1 for update', [f.kit.id]),
      c => change === 'retired' ? c.query('update vendor_resources set retired_at=now(),version=version+1 where id=$1', [f.kit.id]) :
        c.query("update vendor_resources set label='Changed during actual wait',version=version+1 where id=$1", [f.kit.id]), c => commitAgreedOrderResources(c, cmd))
    expect(result).toMatchObject({ ok: false, error: { statusCode: change === 'material_changed' ? 422 : 409 } }); expect(await state(f)).toEqual(before)
  })
  it('real final window wait sees decreased capacity and preserves its legacy occupancy', async () => {
    const f = await fixture(); await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    const cmd = await agree(f, [capacityLine(f, 2)]), before = await state(f)
    const result = await waitForHolder('capacity decreased while final window blocked', c => c.query('select id from resource_capacity_windows where id=$1 for update', [f.window.id]),
      c => c.query('update resource_capacity_windows set capacity=3,version=version+1 where id=$1', [f.window.id]), c => commitAgreedOrderResources(c, cmd))
    expect(result).toMatchObject({ ok: false, error: { statusCode: 409, code: 'resource_capacity_exhausted' } }); expect(await state(f)).toEqual(before)
  })

  it('failed day-two replacement leaves first-day IDs, original UTC periods, counters and entire old promise intact', async () => {
    const f = await fixture(), day1 = line(f, { ...zeroBuffers }), day2 = line(f,
      { ...zeroBuffers, startsAt: '2027-06-15T10:00:00+03:00', endsAt: '2027-06-15T11:00:00+03:00' })
    await commit(f, await agree(f, [day1, day2, capacityLine(f, 2)]))
    const other = await fixture({ company: f })
    await commit(other, await agree(other, [line(other, { ...zeroBuffers, resourceId: f.otherKit.id,
      startsAt: day2.startsAt, endsAt: day2.endsAt })]))
    const cmd = await agree(f, [day1, { ...day2, resourceId: f.otherKit.id }, capacityLine(f, 2)])
    const old = await allocations(f), foreign = await allocations(other), before = await state(f), business = await stable(f)
    await expect(replace(cmd)).rejects.toMatchObject({ statusCode: 409, code: 'resource_booking_conflict' })
    expect(await state(f)).toEqual(before); expect(await stable(f)).toEqual(business)
    expect(await allocations(f)).toEqual(old); expect(await allocations(other)).toEqual(foreign)
  })
  it('successful replacement preserves unchanged first-day allocation ID and origin proof even after line reordering', async () => {
    const f = await fixture(), day1 = line(f, { ...zeroBuffers }), day2 = line(f,
      { ...zeroBuffers, startsAt: '2027-06-15T10:00:00+03:00', endsAt: '2027-06-15T11:00:00+03:00' })
    await commit(f, await agree(f, [day1, day2, capacityLine(f, 2)]))
    const original = await allocations(f), first = original.find(r => r.kind === 'equipment' && (r.occupied_starts_at as Date).toISOString() === '2027-06-14T07:00:00.000Z')!
    const changed = { ...day2, resourceId: f.otherKit.id }, cmd = await agree(f, [capacityLine(f, 2), changed, day1]), business = await stable(f)
    expect(await replace(cmd)).toMatchObject({ revision: '2', state: 'reserved' })
    const rows = await allocations(f), live = rows.filter(r => r.released_at === null)
    expect(live).toHaveLength(3); expect(live.find(r => r.id === first.id)).toEqual(first)
    expect(live.find(r => r.kind === 'capacity')!.id).toBe(original.find(r => r.kind === 'capacity')!.id)
    expect(rows.filter(r => r.released_at !== null)).toHaveLength(1)
    expect((await db.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 2 }])
    expect(await stable(f)).toEqual(business)
    const before = await state(f); await replace(await command(f)); expect(await state(f)).toEqual(before)
  })
  it.each(['vendor_erased', 'deal_cancelled'] as const)('actual SQL false release reason %s with otherwise valid accepted replacement is refused', async falseReason => {
    const f = await fixture(); await commit(f, await agree(f, [line(f), capacityLine(f, 2)]))
    const cmd = await agree(f, [line(f, { resourceId: f.otherKit.id }), capacityLine(f, 4)])
    const before = await state(f), business = await stable(f); let substituted = false
    // All source facts and new two-party proof come from the real domain. Only
    // the deliberately lying SQL release reason is changed in this negative
    // probe. The real Db.tx COMMIT is required if a guard wrongly permits it.
    await expect(db.tx(c => replaceAgreedOrderResources({ async query<R extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (/^\s*update\s+resource_allocations\b/i.test(sql) && /release_reason\s*=\s*'replaced'/.test(sql)) {
        expect((await c.query('select state,vendor_id from deals where id=$1', [f.dealId])).rows).toEqual([{ state: 'booked', vendor_id: f.vendorId }])
        expect((await c.query(`select v.action,v.state,v.reason,v.terms_id,v.plan_revision_id from deal_resource_commitment_versions v
          join deal_resource_commitments h on h.deal_id=v.deal_id and h.current_version_id=v.previous_version_id
          where v.deal_id=$1 and v.revision=h.revision+1`, [f.dealId])).rows)
          .toEqual([{ action: 'replace', state: 'reserved', reason: null, terms_id: cmd.termsId, plan_revision_id: cmd.planRevisionId }])
        substituted = true
        return c.query<R>(sql.replace(/release_reason\s*=\s*'replaced'/, `release_reason='${falseReason}'`), values)
      }
      return c.query<R>(sql, values)
    } }, cmd))).rejects.toMatchObject({ code: '23514' })
    expect(substituted).toBe(true); expect(await state(f)).toEqual(before); expect(await stable(f)).toEqual(business)
    // The same exact accepted plan must still be usable with the true reason.
    expect(await replace(cmd)).toMatchObject({ revision: '2', state: 'reserved' })
    expect((await allocations(f)).filter(r => r.released_at !== null).map(r => r.release_reason)).toEqual(['replaced', 'replaced'])
  })
  it('resource/staff retirement and draft cancellation leave old UTC allocations reserved until explicit financial release', async () => {
    const f = await fixture(); await commit(f, await agree(f, [line(f, { resourceId: f.person.id }), capacityLine(f)]))
    const booked = await allocations(f), h = await head(f)
    await db.tx(c => cancelOrderPart(c, { ...input(f), expectedVersion: h.version, partId: f.partId, expectedPartVersion: '1' }))
    await db.tx(c => revokeStaff(c, { vendorId: f.vendorId, actor: f.owner, memberId: f.worker.id, expectedVersion: f.worker.version }))
    expect(await allocations(f)).toEqual(booked)
    expect((await db.tx(c => loadOrderResourceCommitments(c, input(f)))).state).toBe('reserved')
    expect(await cancelAndRelease(f)).toMatchObject({ revision: '2', state: 'released' })
    expect((await db.query('select used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 0 }])
  })
  it('financial cancellation releases only own quantity once, retaining foreign allocations, baseline and historical evidence', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 2)])); await commit(other, await agree(other, [capacityLine(other, 4)]))
    const foreign = await allocations(other), business = await stable(f)
    expect(await cancelAndRelease(f)).toMatchObject({ revision: '2', state: 'released', reservation: 'released' })
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 7, legacy_used: 3 }])
    expect(await allocations(other)).toEqual(foreign); expect(await stable(f)).toEqual(business)
    const before = await state(f)
    expect(await db.tx(c => releaseCancelledDealResources(c, input(f, f.partner)))).toMatchObject({ revision: '2', state: 'released' })
    expect(await state(f)).toEqual(before)
    expect((await db.query('select action,reason from deal_resource_commitment_versions where deal_id=$1 order by revision', [f.dealId])).rows)
      .toEqual([{ action: 'commit', reason: null }, { action: 'release', reason: 'deal_cancelled' }])
  })
  it('actual cancelDeal releases ledger once and retains money/program while legitimately cancelling draft duties', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 2)])); await commit(other, await agree(other, [capacityLine(other, 4)]))
    const foreign = await allocations(other), business = await stable(f)
    for (const principal of [f.helper, f.owner, await actor()]) await refused(f, () => db.tx(c => cancelDeal(c, f.dealId,
      { actorId: principal.userId, sessionId: principal.sessionId, policyVersion: principal.policyVersion })), principal === f.helper ? 403 : 404)
    expect(await db.tx(c => cancelDeal(c, f.dealId, { actorId: f.couple.userId, sessionId: f.couple.sessionId,
      policyVersion: f.couple.policyVersion, reason: 'Synthetic actual cancellation' }))).toEqual({ from: 'booked' })
    expect(await db.tx(c => loadOrderResourceCommitments(c, input(f)))).toMatchObject({ revision: '2', state: 'released' })
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 7, legacy_used: 3 }])
    expect(await allocations(other)).toEqual(foreign)
    expect((await stable(f)).filter((_, i) => i !== 2 && i !== 3)).toEqual(business.filter((_, i) => i !== 2 && i !== 3))
    expect((await db.query('select cancelled_at from order_parts where deal_id=$1', [f.dealId])).rows[0]!.cancelled_at).toBeInstanceOf(Date)
    expect((await db.query('select deal_id from slots where id=$1', [f.slotId])).rows).toEqual([{ deal_id: null }])
    await refused(f, () => db.tx(c => cancelDeal(c, f.dealId, { actorId: f.couple.userId, sessionId: f.couple.sessionId,
      policyVersion: f.couple.policyVersion })), 409)
    const before = await state(f); await db.tx(c => releaseCancelledDealResources(c, input(f))); expect(await state(f)).toEqual(before)
  })
  it('live financial root, foreign scope and company actor cannot use the explicit cancellation release door', async () => {
    const f = await fixture(), other = await fixture(); await commit(f, await agree(f))
    await refused(f, () => db.tx(c => releaseCancelledDealResources(c, input(f))), 409)
    await cancelAndRelease(f)
    await refused(f, () => db.tx(c => releaseCancelledDealResources(c, input(f, f.owner))), 403)
    await refused(f, () => db.tx(c => releaseCancelledDealResources(c, { ...input(f), weddingId: other.weddingId })), 404)
  })
  it('prepared release scope is bound to its actual transaction and cannot be reused as a client-supplied lock proof', async () => {
    const f = await fixture(); await commit(f, await agree(f))
    const scope = await db.tx(c => prepareDealResourceRelease(c, { weddingId: f.weddingId, dealId: f.dealId }))
    await refused(f, () => db.tx(c => releasePreparedDealResources(c, scope, 'deal_cancelled')))
  })
  it.each(['commit', 'replace', 'release'] as const)('actual SQL failure AFTER %s writes rolls back ledger, counters, financial state, lead, audit and history', async operation => {
    const f = await fixture(); let cmd = await agree(f, [capacityLine(f, 2), line(f)])
    if (operation !== 'commit') await commit(f, cmd)
    if (operation === 'replace') cmd = await agree(f, [capacityLine(f, 4), line(f, { resourceId: f.otherKit.id })])
    const before = await state(f), business = await stable(f); let inserted = false
    await expect(db.tx(async c => {
      if (operation === 'commit') await commitAgreedOrderResources(c, cmd)
      if (operation === 'replace') await replaceAgreedOrderResources(c, cmd)
      if (operation === 'release') {
        const scope = await prepareDealResourceRelease(c, { weddingId: f.weddingId, dealId: f.dealId })
        await c.query("update deals set state='cancelled',cancelled_at=now() where id=$1", [f.dealId])
        await releasePreparedDealResources(c, scope, 'deal_cancelled')
      }
      expect(await state(f, c)).not.toEqual(before); inserted = true
      await c.query('select 1/$1::integer as deliberate_actual_sql_failure', [0])
    })).rejects.toMatchObject({ code: '22012' })
    expect(inserted).toBe(true); expect(await state(f)).toEqual(before); expect(await stable(f)).toEqual(business)
    // A successful positive control after the actual rollback rules out a
    // fixture that can never legitimately create any commitment.
    if (operation === 'commit') expect(await commit(f, cmd)).toMatchObject({ revision: '1' })
    if (operation === 'replace') expect(await replace(cmd)).toMatchObject({ revision: '2' })
    if (operation === 'release') expect(await cancelAndRelease(f)).toMatchObject({ revision: '2' })
  })

  async function sqlRefused(f: Fixture, sql: string, values: readonly unknown[], code = '23514') {
    const before = await state(f), business = await stable(f)
    await expect(db.tx(c => c.query(sql, values))).rejects.toMatchObject({ code })
    expect(await state(f)).toEqual(before); expect(await stable(f)).toEqual(business)
  }
  it('actual SQL cannot rewrite allocation periods/identity/quantity, erase history, clear a live author or fake window counters', async () => {
    const f = await fixture(); await commit(f, await agree(f, [line(f), capacityLine(f, 2)]))
    const rows = await allocations(f), row = rows.find(r => r.kind === 'equipment')!, capacity = rows.find(r => r.kind === 'capacity')!
    for (const [sql, params] of [
      ["update resource_allocations set occupied_ends_at=occupied_ends_at+interval '1 hour' where id=$1", [row.id]],
      ['update resource_allocations set conflict_identity=$2 where id=$1', [row.id, f.otherKit.id]],
      ['update resource_allocations set resource_id=$2 where id=$1', [row.id, f.otherKit.id]],
      ['update resource_allocations set quantity=quantity+1 where id=$1', [capacity.id]],
      ['delete from resource_allocations where id=$1', [row.id]],
      ['delete from deal_resource_commitment_versions where deal_id=$1', [f.dealId]],
      ['update deal_resource_commitment_versions set created_by=null where deal_id=$1', [f.dealId]],
      ['update resource_capacity_windows set used=used+1 where id=$1', [f.window.id]],
      ['update resource_capacity_windows set legacy_used=legacy_used+1,used=used+1 where id=$1', [f.window.id]],
    ] as const) await sqlRefused(f, sql, params)
  })
  it('direct scoped head/member/foreign proof substitutions cannot commit, preserving a valid positive ledger', async () => {
    const f = await fixture(), other = await fixture(); await commit(f, await agree(f)); await commit(other, await agree(other))
    const own = (await db.query('select * from deal_resource_commitment_versions where deal_id=$1', [f.dealId])).rows[0]!
    const foreign = (await db.query('select * from deal_resource_commitment_versions where deal_id=$1', [other.dealId])).rows[0]!
    for (const [sql, params] of [
      ['update deal_resource_commitments set current_version_id=$2 where deal_id=$1', [f.dealId, foreign.id]],
      ['update deal_resource_commitments set revision=revision+1 where deal_id=$1', [f.dealId]],
      ['update deal_resource_commitment_versions set terms_id=$2 where id=$1', [own.id, foreign.terms_id]],
      ['update deal_resource_commitment_versions set plan_revision_id=$2 where id=$1', [own.id, foreign.plan_revision_id]],
      ['delete from deal_resource_commitment_members where deal_id=$1', [f.dealId]],
      ['update deal_resource_commitment_members set allocation_id=$2 where deal_id=$1', [f.dealId, (await allocations(other))[0]!.id]],
    ] as const) await sqlRefused(f, sql, params)
  })
  async function cloneVersion(c: Queryable, f: Fixture) {
    const old = (await c.query('select v.* from deal_resource_commitments h join deal_resource_commitment_versions v on v.id=h.current_version_id where h.deal_id=$1', [f.dealId])).rows[0]!
    const id = randomUUID(), revision = String(BigInt(old.revision as string) + 1n)
    await c.query(`insert into deal_resource_commitment_versions(id,wedding_id,deal_id,vendor_id,revision,previous_version_id,terms_id,plan_revision_id,policy_revision,action,state,created_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,'replace','reserved',$10)`, [id, f.weddingId, f.dealId, f.vendorId, revision, old.id, old.terms_id, old.plan_revision_id, old.policy_revision, f.couple.userId])
    return { id, revision }
  }
  it.each(['orphan_version', 'missing_members'] as const)('actual COMMIT refuses %s after the evidence INSERT really succeeds', async corruption => {
    const f = await fixture(); await commit(f, await agree(f, [line(f), capacityLine(f)]))
    const before = await state(f); let inserted = false
    await expect(db.tx(async c => {
      const clone = await cloneVersion(c, f)
      expect((await c.query('select id from deal_resource_commitment_versions where id=$1', [clone.id])).rows).toHaveLength(1); inserted = true
      if (corruption === 'missing_members') await c.query('update deal_resource_commitments set revision=$2,current_version_id=$3 where deal_id=$1', [f.dealId, clone.revision, clone.id])
      // Deliberately no SET CONSTRAINTS shortcut: Db.tx executes real COMMIT.
    })).rejects.toMatchObject({ code: '23514' })
    expect(inserted).toBe(true); expect(await state(f)).toEqual(before)
  })
  it('one-way release facts cannot be edited, reopened, released twice or erased after legitimate financial cancellation', async () => {
    const f = await fixture(); await commit(f, await agree(f, [capacityLine(f)])); await cancelAndRelease(f)
    const row = (await allocations(f))[0]!
    for (const [sql, params] of [
      ['update resource_allocations set released_at=null,release_reason=null where id=$1', [row.id]],
      ["update resource_allocations set released_at=released_at+interval '1 second' where id=$1", [row.id]],
      ["update resource_allocations set release_reason='vendor_erased' where id=$1", [row.id]],
      ['delete from resource_allocations where id=$1', [row.id]],
    ] as const) await sqlRefused(f, sql, params)
  })
  it('whole-wedding cascade returns only its live inventory while preserving shared foreign ledger and baseline', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 2)])); await commit(other, await agree(other, [capacityLine(other, 4)]))
    const foreign = await allocations(other), foreignState = await state(other)
    await db.tx(async c => { await c.query('delete from weddings where id=$1', [f.weddingId]); await c.query('set constraints all immediate') })
    expect(await allocations(f)).toEqual([]); expect(await allocations(other)).toEqual(foreign)
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 7, legacy_used: 3 }])
    // The foreign state includes the same shared window counter; only that
    // known availability row changes, all foreign evidence stays byte-equal.
    const after = await state(other); expect(after.filter((_, i) => i !== 9)).toEqual(foreignState.filter((_, i) => i !== 9))
  })
  async function guardActualErasureJob() {
    // eraseUser has an inherited global expired-transport-cache prune. Only
    // execute it when that statement provably has no foreign row to touch.
    expect((await db.query<{ n: number }>("select count(*)::int n from idempotency_keys where created_at<now()-interval '1 day'")).rows[0]!.n).toBe(0)
  }
  it('actual eraseUser of an owner without eligible heir returns only the erased wedding quantity from a shared window', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 2)])); await commit(other, await agree(other, [capacityLine(other, 4)]))
    await db.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.weddingId, f.partner.userId])
    await db.query("update users set deleted_at=now()-interval '31 days' where id=$1", [f.couple.userId])
    const foreign = await allocations(other), foreignBusiness = await stable(other)
    await guardActualErasureJob(); await db.tx(c => eraseUser(c, f.couple.userId))
    expect((await db.query('select id from weddings where id=$1', [f.weddingId])).rows).toEqual([])
    expect((await db.query('select id from users where id=$1', [f.couple.userId])).rows).toEqual([])
    expect(await allocations(f)).toEqual([]); expect(await allocations(other)).toEqual(foreign)
    expect(await stable(other)).toEqual(foreignBusiness)
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 7, legacy_used: 3 }])
  })
  it('actual vendor erase releases its company promises while preserving immutable evidence, finance and another company inventory', async () => {
    const f = await fixture(), sameCompany = await fixture({ company: f }), foreign = await fixture()
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 2)])); await commit(sameCompany, await agree(sameCompany, [capacityLine(sameCompany, 4)]))
    await commit(foreign, await agree(foreign, [capacityLine(foreign, 3)]))
    const foreignState = await state(foreign), foreignBusiness = await stable(foreign)
    const ownBefore = await allocations(f), payments = (await stable(f))[1]
    const plans = (await db.query('select private_payload,private_snapshot,private_digest,public_snapshot from deal_resource_plan_versions where deal_id=$1', [f.dealId])).rows
    await db.query("update users set deleted_at=now()-interval '31 days' where id=$1", [f.owner.userId])
    await guardActualErasureJob(); await db.tx(c => eraseUser(c, f.owner.userId))
    expect((await db.query('select id from vendors where id=$1', [f.vendorId])).rows).toEqual([])
    expect((await db.query('select id from users where id=$1', [f.owner.userId])).rows).toEqual([])
    for (const target of [f, sameCompany]) {
      expect(await db.tx(c => loadOrderResourceCommitments(c, input(target)))).toMatchObject({ revision: '2', state: 'released' })
      expect((await db.query('select vendor_id,external_name,price from deals where id=$1', [target.dealId])).rows)
        .toEqual([{ vendor_id: null, external_name: 'Удалённый подрядчик', price: '9007199254740993' }])
      expect((await allocations(target)).every(row => row.release_reason === 'vendor_erased' && row.released_at instanceof Date)).toBe(true)
    }
    expect((await allocations(f)).map(r => ({ ...r, released_at: null, release_reason: null }))).toEqual(ownBefore)
    expect((await db.query('select private_payload,private_snapshot,private_digest,public_snapshot from deal_resource_plan_versions where deal_id=$1', [f.dealId])).rows).toEqual(plans)
    expect((await stable(f))[1]).toEqual(payments)
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 3, legacy_used: 3 }])
    expect(await state(foreign)).toEqual(foreignState); expect(await stable(foreign)).toEqual(foreignBusiness)
  })
  it('actual eraseUser of an accepted worker preserves historical promises in other companies until explicit cancellation', async () => {
    const worker = await actor(), f = await fixture({ company: await company(worker) }), other = await fixture({ company: await company(worker) })
    await commit(f, await agree(f, [line(f, { resourceId: f.person.id })]))
    await commit(other, await agree(other, [line(other, { resourceId: other.person.id, startsAt: '2027-06-15T10:00:00+03:00', endsAt: '2027-06-15T11:00:00+03:00' })]))
    const first = await allocations(f), second = await allocations(other)
    await db.query("update users set deleted_at=now()-interval '31 days' where id=$1", [worker.userId])
    await guardActualErasureJob(); await db.tx(c => eraseUser(c, worker.userId))
    expect((await db.query('select id from users where id=$1', [worker.userId])).rows).toEqual([])
    expect(await allocations(f)).toEqual(first); expect(await allocations(other)).toEqual(second)
    expect(await db.tx(c => loadOrderResourceCommitments(c, input(f)))).toMatchObject({ state: 'reserved' })
    await cancelAndRelease(f); expect(await allocations(other)).toEqual(second)
  })
  it.each(['vendor_owner', 'selected_worker'] as const)('actual eraseUser %s transaction wins a real wait; stale booking cannot restore the erased source', async erased => {
    const f = await fixture(), cmd = await agree(f, [line(f, { resourceId: f.person.id }), capacityLine(f)])
    const target = erased === 'vendor_owner' ? f.owner : f.worker.actor
    await db.query("update users set deleted_at=now()-interval '31 days' where id=$1", [target.userId])
    await guardActualErasureJob()
    const business = await stable(f), result = await waitForHolder(`actual eraseUser ${erased}`, c => eraseUser(c, target.userId), noop,
      c => commitAgreedOrderResources(c, cmd))
    expect(result).toMatchObject({ ok: false, error: { statusCode: 409 } })
    expect(await allocations(f)).toEqual([])
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 0, legacy_used: 0 }])
    expect((await stable(f)).filter((_, i) => erased === 'vendor_owner' ? i !== 0 && i !== 6 : true))
      .toEqual(business.filter((_, i) => erased === 'vendor_owner' ? i !== 0 && i !== 6 : true))
    expect((await db.query('select id from users where id=$1', [target.userId])).rows).toEqual([])
    expect((await db.query('select state from deals where id=$1', [f.dealId])).rows).toEqual([{ state: 'candidate' }])
  })
  async function purgeApp(onlyWeddingId: string, database: Db = db) {
    // The real job scans eligible archives. Refuse to run if any other eligible
    // archive exists, so actual implementation SQL needs no test-only filtering.
    expect((await db.query<{ n: number }>(`select count(*)::int n from weddings where cancelled_at is not null
      and archived_at<now()-interval '30 days' and id<>$1`, [onlyWeddingId])).rows[0]!.n).toBe(0)
    const errors: unknown[] = []
    const app = { db: database, appConfig: { weddingArchiveDays: 30 }, log: { error: (error: unknown) => { errors.push(error) } } } as unknown as FastifyInstance
    return { app, errors }
  }
  it('actual purgeArchivedWeddings releases only its shared-window quantity; repeat does not fabricate a second purge', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 2)])); await commit(other, await agree(other, [capacityLine(other, 4)]))
    const foreign = await allocations(other), foreignBusiness = await stable(other)
    await db.query("update weddings set cancelled_at=now()-interval '32 days',archived_at=now()-interval '31 days' where id=$1", [f.weddingId])
    const { app, errors } = await purgeApp(f.weddingId)
    expect(await purgeArchivedWeddings(app)).toBe(1); expect(errors).toEqual([])
    expect(await allocations(f)).toEqual([]); expect(await allocations(other)).toEqual(foreign)
    expect(await stable(other)).toEqual(foreignBusiness)
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 7, legacy_used: 3 }])
    expect(await purgeArchivedWeddings(app)).toBe(0); expect(errors).toEqual([])
    expect((await db.query("select id from audit_log where entity_id=$1 and action='wedding.purged'", [f.weddingId])).rows).toHaveLength(1)
  })
  function bindActualJobTransaction(c: Queryable): Db {
    // The job uses this already-open REAL PostgreSQL transaction. Keeping its
    // commit at waitForHolder's boundary lets the other actual job witness the
    // held row lock. No SQL/result/eligibility decision is mocked or rewritten.
    return { query: (sql, values) => c.query(sql, values), tx: action => action(c), ping: async () => true, close: async () => undefined }
  }
  it('two actual archive jobs witness a real wedding wait and release shared capacity only once', async () => {
    const f = await fixture(), other = await fixture({ company: f })
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [f.window.id])
    await commit(f, await agree(f, [capacityLine(f, 2)])); await commit(other, await agree(other, [capacityLine(other, 4)]))
    const foreign = await allocations(other)
    await db.query("update weddings set cancelled_at=now()-interval '32 days',archived_at=now()-interval '31 days' where id=$1", [f.weddingId])
    const result = await waitForHolder('two actual purgeArchivedWeddings jobs', async c => {
      const { app, errors } = await purgeApp(f.weddingId, bindActualJobTransaction(c))
      expect(await purgeArchivedWeddings(app)).toBe(1); expect(errors).toEqual([])
    }, noop, async c => {
      const { app, errors } = await purgeApp(f.weddingId, bindActualJobTransaction(c))
      const purged = await purgeArchivedWeddings(app); expect(errors).toEqual([]); return purged
    })
    expect(result).toEqual({ ok: true, value: 0 }); expect(await allocations(other)).toEqual(foreign)
    expect((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 7, legacy_used: 3 }])
    expect((await db.query("select id from audit_log where entity_id=$1 and action='wedding.purged'", [f.weddingId])).rows).toHaveLength(1)
  })
  it('actual SQL audit failure during initial commit rolls back already-created source-backed allocations', async () => {
    const f = await fixture(), cmd = await agree(f, [capacityLine(f)]), before = await state(f); let witnessed = false
    await expect(db.tx(c => commitAgreedOrderResources({ async query<R extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (/^\s*insert\s+into\s+audit_log\b/i.test(sql) && values?.includes(f.dealId)) {
        expect(await allocations(f, c)).toHaveLength(1); witnessed = true
        return c.query<R>('select 1/$1::integer as deliberate_audit_failure', [0])
      }
      return c.query<R>(sql, values)
    } }, cmd))).rejects.toMatchObject({ code: '22012' })
    expect(witnessed).toBe(true); expect(await state(f)).toEqual(before)
    expect(await commit(f, cmd)).toMatchObject({ revision: '1', state: 'reserved' })
  })
})
