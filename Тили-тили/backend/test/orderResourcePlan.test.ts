import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import { lockOrderContext, type OrderActor } from '../src/orders/context.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart, patchOrderPart, cancelOrderPart, type OrderInput } from '../src/orders/model.js'
import { createResource, createCapacityWindow, retireResource } from '../src/resources/model.js'
import { inviteStaff, acceptStaffInvite, revokeStaff, type StaffRole } from '../src/vendor/staff.js'
import { loadOrderResourcePlan, saveOrderResourcePlan, readResourcePlanSource, type ResourcePlanLineInput } from '../src/orders/resource-plan.js'
import { canonicalTermsJson, publishOrderTerms, loadOrderTerms, acceptOrderTerms, type TermsView } from '../src/orders/terms.js'
import { rescheduleWedding } from '../src/wedding/reschedule.js'

const DATABASE = process.env.TEST_DATABASE_URL
const START = '2027-06-14T10:00:00+03:00', END = '2027-06-14T11:00:00+03:00'
const POLICY = '2026-09-02'
const proof = { secret: 'synthetic-resource-plan-terms-proof-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ' }

describe.skipIf(!DATABASE)('private immutable resource plans with actual PostgreSQL guards; no reservations', () => {
  let db: Db
  const users: string[] = [], vendors: string[] = [], weddings: string[] = [], resources: string[] = []
  const witnesses: { change: string; holder: number; waiter: number; waitEvent: string | null }[] = []
  const phone = String(randomInt(100_000, 999_999)); let sequence = 0

  beforeAll(async () => {
    const target = new URL(DATABASE!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_resource_plan_20260930_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    db = createDb(DATABASE!)
    expect((await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name).toBe(target.pathname.slice(1))
  })
  afterAll(async () => {
    if (!db) return
    try {
      process.stdout.write(`RESOURCE_PLAN_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      // Delete weddings first: actual immutable history must cascade without
      // manually removing revisions or bypassing their deletion protection.
      for (const id of weddings) await db.query('delete from weddings where id=$1', [id])
      await db.query('delete from vendor_resources where id=any($1::uuid[])', [resources])
      for (const id of vendors) await db.query('delete from vendors where id=$1', [id])
      for (const id of users) await db.query('delete from users where id=$1', [id])
    } finally { await db.close() }
  })
  async function actor(): Promise<OrderActor> {
    const userId = randomUUID(), sessionId = randomUUID(); users.push(userId)
    await db.query("insert into users(id,phone,name) values($1,$2,'Synthetic resource plan actor')", [userId, `+79${phone}${String(++sequence).padStart(3, '0')}`])
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await db.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    return { userId, sessionId, policyVersion: POLICY }
  }
  async function staff(vendorId: string, owner: OrderActor, role: StaffRole) {
    const person = await actor()
    // These are actual domain calls by synthetic principals, not a claim of
    // consent or invitation acceptance by a real human.
    const invitation = await db.tx(c => inviteStaff(c, { vendorId, actor: owner, role, targetUserId: person.userId }))
    const accepted = await db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: person }))
    return { person, id: accepted.id, version: accepted.version }
  }
  async function fixture() {
    const couple = await actor(), partner = await actor(), helper = await actor(), owner = await actor()
    const weddingId = randomUUID(), vendorId = randomUUID(), slotId = randomUUID(), dealId = randomUUID()
    weddings.push(weddingId); vendors.push(vendorId)
    await db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic private plan','2027-06-14','Europe/Moscow',$3)", [weddingId, couple.userId, randomUUID()])
    for (const person of [couple, partner]) await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, person.userId])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [weddingId, helper.userId])
    await db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic plan company',now())", [vendorId, owner.userId])
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Flower order')", [slotId, weddingId])
    await db.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price,package_title_snapshot,package_includes_snapshot) values($1,$2,$3,$4,'booked',9007199254740993,'Inherited package','[\"Frozen bouquet\"]'::jsonb)", [dealId, weddingId, slotId, vendorId])
    await db.query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
    await db.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2)", [vendorId, dealId])
    await db.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,'2027-06-19','manual')", [vendorId])
    await db.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',12000,'recorded','cash','private')", [randomUUID(), dealId])
    const eventId = (await db.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    const base = { weddingId, dealId, actor: couple }
    const assigned = await db.tx(c => createOrderAssignment(c, { ...base, expectedVersion: '1', slotId, programEventId: eventId, label: 'Actual draft duty' }))
    const assignmentId = assigned.assignments[0]!.id
    const order = await db.tx(c => createOrderPart(c, { ...base, expectedVersion: assigned.version, assignmentId,
      kind: 'timed_service', title: 'Flower installation', details: {} }))
    const partId = order.parts[0]!.id
    const manager = await staff(vendorId, owner, 'resource_manager'), worker = await staff(vendorId, owner, 'worker')
    const make = async (kind: 'equipment' | 'person' | 'capacity', label: string, extra: { personUserId?: string; staffMemberId?: string; capacityUnit?: string } = {}) => {
      const resource = await db.tx(c => createResource(c, { vendorId, actor: owner, kind, label, ...extra })); resources.push(resource.id); return resource
    }
    const kit = await make('equipment', 'Same visible kit'), otherKit = await make('equipment', 'Same visible kit')
    const person = await make('person', 'Accepted worker', { personUserId: worker.person.userId, staffMemberId: worker.id })
    const capacity = await make('capacity', 'Production capacity', { capacityUnit: 'bouquets' })
    const window = await db.tx(c => createCapacityWindow(c, { vendorId, actor: owner, resourceId: capacity.id,
      startsAt: '2027-06-12T00:00:00Z', endsAt: '2027-06-18T23:00:00Z', capacity: 10 }))
    // Synthetic pre-existing occupancy is a preservation control, not a booking.
    await db.query('update resource_capacity_windows set used=3,legacy_used=3 where id=$1', [window.id])
    const timelineVersion = (await db.query<{ version: string }>('select timeline_version::text as version from weddings where id=$1', [weddingId])).rows[0]!.version
    const inherited = { syntheticInheritedFixture: true, sourceVersion: timelineVersion, blocks: [] }
    await db.query('insert into vendor_program_acknowledgments(wedding_id,vendor_id,user_id,session_id,version,digest,program_snapshot) values($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [weddingId, vendorId, owner.userId, owner.sessionId, timelineVersion, createHash('sha256').update(JSON.stringify(inherited)).digest('hex'), JSON.stringify(inherited)])
    return { weddingId, dealId, slotId, eventId, assignmentId, partId, vendorId, couple, partner, helper, owner, manager, worker, kit, otherKit, person, capacity, window }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const input = (f: Fixture, actor = f.owner): OrderInput => ({ weddingId: f.weddingId, dealId: f.dealId, actor })
  const line = (f: Fixture, patch: Partial<ResourcePlanLineInput> = {}): ResourcePlanLineInput => ({ partId: f.partId, resourceId: f.kit.id, capacityWindowId: null,
    quantity: 1, startsAt: START, endsAt: END, timeZone: 'Europe/Moscow', setupMinutes: 30, teardownMinutes: 40, travelBeforeMinutes: 10, travelAfterMinutes: 20, ...patch })
  const capacityLine = (f: Fixture, patch: Partial<ResourcePlanLineInput> = {}) => line(f, { resourceId: f.capacity.id, capacityWindowId: f.window.id, quantity: 2, ...patch })
  const load = (f: Fixture, actor = f.couple) => db.tx(c => loadOrderResourcePlan(c, input(f, actor)))
  const head = async (f: Fixture, client: Queryable = db) => (await client.query<{ version: string; revision: string; id: string | null }>(
    'select version::text,resource_plan_revision::text as revision,resource_plan_id as id from deal_orders where wedding_id=$1 and deal_id=$2', [f.weddingId, f.dealId])).rows[0]!
  async function writeInput(f: Fixture, lines: ResourcePlanLineInput[], actor = f.owner) {
    const before = await head(f)
    return { ...input(f, actor), expectedVersion: before.version, expectedPlanRevision: before.revision, lines }
  }
  async function save(f: Fixture, lines = [line(f)], actor = f.owner) {
    const command = await writeInput(f, lines, actor)
    return db.tx(c => saveOrderResourcePlan(c, command))
  }
  async function plans(f: Fixture, client: Queryable = db) {
    return (await client.query('select * from deal_resource_plan_versions where wedding_id=$1 and deal_id=$2 order by version', [f.weddingId, f.dealId])).rows
  }
  async function state(f: Fixture) {
    return { head: await head(f), plans: await plans(f), audit: (await db.query('select * from audit_log where entity_id=$1 order by id', [f.dealId])).rows }
  }
  async function ledger(f: Fixture) {
    const result = await Promise.all([
      db.query('select * from deals where id=$1', [f.dealId]), db.query('select * from payments where deal_id=$1 order by id', [f.dealId]),
      db.query('select * from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId]),
      db.query('select * from vendor_program_acknowledgments where wedding_id=$1 order by version,digest', [f.weddingId]),
      db.query('select * from wedding_events where wedding_id=$1 order by id', [f.weddingId]),
      db.query('select * from timeline_events where wedding_id=$1 order by id', [f.weddingId]),
      db.query('select * from vendor_resources where vendor_id=$1 order by id', [f.vendorId]),
      db.query('select w.* from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id where r.vendor_id=$1 order by w.id', [f.vendorId]),
      db.query('select * from deal_terms_receipts where wedding_id=$1 order by id', [f.weddingId]),
    ])
    return result.map(r => r.rows)
  }
  async function denied(f: Fixture, action: () => Promise<unknown>, status: number | null = null) {
    const before = await state(f), money = await ledger(f)
    if (status === null) await expect(action()).rejects.toMatchObject({ statusCode: expect.any(Number) })
    else await expect(action()).rejects.toMatchObject({ statusCode: status })
    expect(await state(f)).toEqual(before); expect(await ledger(f)).toEqual(money)
  }
  async function source(f: Fixture) {
    return db.tx(async c => { const context = await lockOrderContext(c, f.weddingId, f.dealId, f.couple, false)
      await c.query('select deal_id from deal_orders where wedding_id=$1 and deal_id=$2 for share', [f.weddingId, f.dealId])
      return readResourcePlanSource(c, { weddingId: f.weddingId, dealId: f.dealId, vendorId: context.vendorId }) })
  }

  it('initial empty state and explicit initial clearing create no invented revision, audit or reservation', async () => {
    const f = await fixture(), before = await state(f), money = await ledger(f)
    expect(await load(f)).toMatchObject({ revision: '0', canEdit: false, current: null, editorLines: null, source: 'current', reservation: 'not_reserved', history: [] })
    expect(await load(f, f.owner)).toMatchObject({ canEdit: true, current: null, editorLines: [], reservation: 'not_reserved' })
    expect((await save(f, [])).revision).toBe('0'); expect(await state(f)).toEqual(before); expect(await ledger(f)).toEqual(money)
  })
  it('owner saves exact buffers and pair receives safe immutable facts without private resource, person or window UUIDs', async () => {
    const f = await fixture(), before = await ledger(f), previous = await head(f)
    const saved = await save(f, [line(f), line(f, { resourceId: f.person.id }), capacityLine(f)])
    expect(saved).toMatchObject({ orderVersion: String(BigInt(previous.version) + 1n), revision: '1', source: 'current', canEdit: true, reservation: 'not_reserved' })
    const pair = await load(f, f.partner)
    expect(pair).toMatchObject({ revision: '1', canEdit: false, editorLines: null, source: 'current', reservation: 'not_reserved' })
    expect(pair.current?.lines[0]).toMatchObject({ partId: f.partId, assignmentId: f.assignmentId, programEventId: f.eventId,
      label: 'Same visible kit', kind: 'equipment', unit: null, quantity: 1, startsAt: '2027-06-14T07:00:00.000Z', endsAt: '2027-06-14T08:00:00.000Z',
      timeZone: 'Europe/Moscow', setupMinutes: 30, teardownMinutes: 40, travelBeforeMinutes: 10, travelAfterMinutes: 20,
      occupiedStartsAt: '2027-06-14T06:20:00.000Z', occupiedEndsAt: '2027-06-14T09:00:00.000Z', window: null })
    expect(pair.current?.lines[2]).toMatchObject({ kind: 'capacity', quantity: 2, unit: 'bouquets', window: { startsAt: '2027-06-12T00:00:00.000Z', endsAt: '2027-06-18T23:00:00.000Z' } })
    const exposed = JSON.stringify(pair)
    for (const id of [f.kit.id, f.person.id, f.capacity.id, f.window.id, f.worker.id, f.worker.person.userId, f.owner.userId]) expect(exposed).not.toContain(id)
    for (const key of ['resourceId', 'conflictIdentity', 'capacityWindowId', 'personUserId', 'staffMemberId', 'partVersion', 'assignmentVersion', 'used', 'capacity']) expect(pair.current?.lines[0]).not.toHaveProperty(key)
    expect(await ledger(f)).toEqual(before)
  })
  it('actual couple and vendor owner can read; couple/helper/manager/stranger cannot write private staffing facts', async () => {
    const f = await fixture(); await save(f)
    for (const person of [f.couple, f.partner]) await denied(f, () => save(f, [line(f)], person), 403)
    for (const person of [f.helper, f.manager.person, await actor()]) {
      await denied(f, () => load(f, person), 404); await denied(f, () => save(f, [line(f)], person), 404)
    }
    expect((await load(f, f.owner)).editorLines).toEqual([{ ...line(f), startsAt: '2027-06-14T07:00:00.000Z', endsAt: '2027-06-14T08:00:00.000Z' }])
  })
  it('actual company owner who is also a couple member can edit without granting ordinary couple or manager ownership', async () => {
    const f = await fixture()
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.weddingId, f.owner.userId])
    expect((await load(f, f.owner)).canEdit).toBe(true)
    expect(await save(f)).toMatchObject({ canEdit: true, revision: '1', reservation: 'not_reserved' })
    await denied(f, () => save(f, [line(f)], f.couple), 403)
    await denied(f, () => save(f, [line(f)], f.manager.person), 404)
  })
  it.each(['deleted', 'revoked', 'withdrawn', 'outdated'] as const)('current principal %s is denied without private mutation', async change => {
    const f = await fixture()
    if (change === 'deleted') await db.query('update users set deleted_at=now() where id=$1', [f.owner.userId])
    if (change === 'revoked') await db.query('update sessions set revoked_at=now() where id=$1', [f.owner.sessionId])
    if (change === 'withdrawn') await db.query('update consents set withdrawn_at=now() where user_id=$1', [f.owner.userId])
    const person = change === 'outdated' ? { ...f.owner, policyVersion: 'different-current-policy' } : f.owner
    await denied(f, () => save(f, [line(f)], person), change === 'withdrawn' || change === 'outdated' ? 403 : 401)
  })
  it('exact versions and simultaneous commands produce one immutable revision and one order advance', async () => {
    const f = await fixture(), command = await writeInput(f, [line(f)]), before = await head(f)
    const results = await Promise.allSettled([db.tx(c => saveOrderResourcePlan(c, command)), db.tx(c => saveOrderResourcePlan(c, command))])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } })
    expect(await plans(f)).toHaveLength(1); expect(await head(f)).toMatchObject({ revision: '1', version: String(BigInt(before.version) + 1n) })
    const fresh = await writeInput(f, [line(f)])
    await denied(f, () => db.tx(c => saveOrderResourcePlan(c, { ...fresh, expectedPlanRevision: '0' })), 409)
  })
  it('identical normalized facts are a no-op; same visible label with another resource ID creates another revision', async () => {
    const f = await fixture(), first = await save(f), before = await state(f)
    expect((await save(f, [line(f, { startsAt: '2027-06-14T07:00:00Z', endsAt: '2027-06-14T08:00:00Z' })])).current).toEqual(first.current)
    expect(await state(f)).toEqual(before)
    const second = await save(f, [line(f, { resourceId: f.otherKit.id })])
    expect(second.revision).toBe('2'); expect(second.current?.lines).toEqual(first.current?.lines)
    expect(second.current?.planRevisionId).not.toBe(first.current?.planRevisionId)
    const rows = await plans(f); expect(rows[0]!.private_digest).not.toBe(rows[1]!.private_digest)
    expect(createHash('sha256').update(JSON.stringify(first.current)).digest('hex')).not.toBe(createHash('sha256').update(JSON.stringify(second.current)).digest('hex'))
    expect((await load(f)).history).toHaveLength(2)
  })
  it('clearing preserves nonempty historical revision; repeated empty clearing is a no-op', async () => {
    const f = await fixture(), first = await save(f), cleared = await save(f, [])
    expect(cleared).toMatchObject({ revision: '2', current: { lines: [] }, editorLines: [], reservation: 'not_reserved' })
    expect((await load(f)).history.find(p => p.planRevisionId === first.current?.planRevisionId)).toEqual(first.current)
    const before = await state(f); expect((await save(f, [])).revision).toBe('2'); expect(await state(f)).toEqual(before)
  })
  it.each([
    ['zero quantity', { quantity: 0 }], ['fraction', { quantity: 1.5 }], ['overflow', { quantity: 2_147_483_648 }],
    ['equipment count', { quantity: 2 }], ['missing offset', { startsAt: '2027-06-14T10:00:00' }], ['invalid date', { startsAt: '2027-02-30T10:00:00Z' }],
    ['reversed', { endsAt: '2027-06-14T06:00:00Z' }], ['zero duration', { endsAt: START }], ['bad zone', { timeZone: 'Invalid/Calendar' }],
    ['missing zone', { timeZone: '' }], ['negative setup', { setupMinutes: -1 }], ['fractional teardown', { teardownMinutes: 0.5 }],
    ['excess travel', { travelAfterMinutes: 1441 }], ['window on equipment', { capacityWindowId: randomUUID() }],
  ] as const)('rejects explicit invalid plan: %s', async (_name, patch) => {
    const f = await fixture(); await denied(f, () => save(f, [line(f, patch)]), 422)
  })
  it('all fields are mandatory, extra private/financial fields and duplicate semantic lines are refused', async () => {
    const f = await fixture()
    for (const field of ['capacityWindowId', 'quantity', 'timeZone', 'setupMinutes', 'travelBeforeMinutes'] as const) {
      const incomplete = { ...line(f) }; delete (incomplete as Partial<ResourcePlanLineInput>)[field]
      await denied(f, () => save(f, [incomplete]), 422)
    }
    await denied(f, () => save(f, [{ ...line(f), price: '1' } as ResourcePlanLineInput]), 422)
    await denied(f, () => save(f, [line(f), line(f, { startsAt: '2027-06-14T07:00:00Z', endsAt: '2027-06-14T08:00:00Z' })]), 422)
    await denied(f, () => save(f, Array.from({ length: 101 }, (_, i) => line(f, { setupMinutes: i }))), 422)
  })
  it('capacity requires its own window covering setup and travel; person requires quantity one', async () => {
    const f = await fixture()
    await denied(f, () => save(f, [capacityLine(f, { capacityWindowId: null })]), 422)
    await denied(f, () => save(f, [line(f, { resourceId: f.person.id, quantity: 2 })]), 422)
    const narrow = await db.tx(c => createCapacityWindow(c, { vendorId: f.vendorId, actor: f.owner, resourceId: f.capacity.id,
      startsAt: '2027-06-20T07:00:00Z', endsAt: '2027-06-20T08:00:00Z', capacity: 4 }))
    await denied(f, () => save(f, [capacityLine(f, { capacityWindowId: narrow.id, startsAt: '2027-06-20T07:00:00Z', endsAt: '2027-06-20T08:00:00Z' })]), 422)
    const other = await fixture()
    await denied(f, () => save(f, [capacityLine(f, { capacityWindowId: other.window.id })]), 422)
    await denied(f, () => save(f, [line(f, { resourceId: other.kit.id })]), 422)
    await denied(f, () => save(f, [line(f, { partId: other.partId })]), 422)
    await denied(f, () => db.tx(c => loadOrderResourcePlan(c, { ...input(f), dealId: other.dealId })), 404)
  })
  it('production before delivery, rental across days and unassigned deliverable are explicit plans without clipping or inference', async () => {
    const f = await fixture()
    async function part(kind: 'supply' | 'rental' | 'deliverable', details: unknown, assignmentId: string | null) {
      const current = await head(f)
      const order = await db.tx(c => createOrderPart(c, { ...input(f, f.couple), expectedVersion: current.version, kind, title: kind, details, assignmentId }))
      return order.parts.at(-1)!.id
    }
    const supply = await part('supply', { quantity: 20, unit: 'bouquets', windowStartsAt: START, windowEndsAt: END }, f.assignmentId)
    const rental = await part('rental', { quantity: 12, unit: 'chairs', handoverAt: '2027-06-13T10:00:00Z', returnAt: '2027-06-16T10:00:00Z' }, f.assignmentId)
    const deliverable = await part('deliverable', { items: ['Report'], dueAt: '2027-07-01T12:00:00Z' }, null)
    const saved = await save(f, [capacityLine(f, { partId: supply, startsAt: '2027-06-12T10:00:00Z', endsAt: '2027-06-12T12:00:00Z', quantity: 4 }),
      line(f, { partId: rental, startsAt: '2027-06-13T10:00:00Z', endsAt: '2027-06-16T10:00:00Z' }),
      line(f, { partId: deliverable, startsAt: '2027-06-25T09:00:00Z', endsAt: '2027-06-25T10:00:00Z' })])
    expect(saved.current?.lines[0]).toMatchObject({ quantity: 4, startsAt: '2027-06-12T10:00:00.000Z' })
    expect(saved.current?.lines[1]).toMatchObject({ startsAt: '2027-06-13T10:00:00.000Z', endsAt: '2027-06-16T10:00:00.000Z' })
    expect(saved.current?.lines[2]).toMatchObject({ assignmentId: null, programEventId: null })
    expect(saved.reservation).toBe('not_reserved')
  })
  it('capacity used/capacity and resource-only version changes do not rewrite history, make the plan stale or claim remaining availability', async () => {
    const f = await fixture(), saved = await save(f, [capacityLine(f)])
    await db.query('update resource_capacity_windows set capacity=20,used=19,legacy_used=19,version=version+1 where id=$1', [f.window.id])
    await db.query('update vendor_resources set version=version+1 where id=$1', [f.capacity.id])
    const before = await state(f), money = await ledger(f)
    expect(await source(f)).toEqual({ plan: saved.current, source: 'current' })
    expect((await save(f, [capacityLine(f)])).revision).toBe('1'); expect(await state(f)).toEqual(before); expect(await ledger(f)).toEqual(money)
  })
  it.each(['part', 'assignment', 'label', 'window'] as const)('material %s drift marks current source invalid while preserving immutable public history', async change => {
    const f = await fixture(), saved = await save(f, [capacityLine(f)])
    if (change === 'part') await db.query('update order_parts set version=version+1 where id=$1', [f.partId])
    if (change === 'assignment') await db.query('update order_assignments set version=version+1 where id=$1', [f.assignmentId])
    if (change === 'label') await db.query("update vendor_resources set label='Changed production' where id=$1", [f.capacity.id])
    if (change === 'window') await db.query("update resource_capacity_windows set ends_at='2027-06-18T22:00:00Z' where id=$1", [f.window.id])
    const view = await load(f)
    expect(view.source).toBe('invalid'); expect(view.history.find(p => p.planRevisionId === saved.current?.planRevisionId)).toEqual(saved.current)
    expect((await plans(f))[0]!.public_snapshot).toEqual(saved.current)
  })
  it('canonical event date changes do not infer or rewrite the explicit absolute production interval', async () => {
    const f = await fixture(), saved = await save(f)
    // Terms independently fingerprint event dates. This private draft binds
    // the scoped event identity but does not infer its explicit time window.
    await db.tx(async c => { await lockOrderContext(c, f.weddingId, f.dealId, f.couple)
      await rescheduleWedding(c, f.weddingId, '2027-06-15', f.couple.userId) })
    expect(await source(f)).toEqual({ plan: saved.current, source: 'current' })
  })
  it('real part edit invalidates old source; explicit owner save creates new history without rewriting old public facts', async () => {
    const f = await fixture(), saved = await save(f), current = await head(f)
    await db.tx(c => patchOrderPart(c, { ...input(f, f.couple), expectedVersion: current.version, partId: f.partId,
      expectedPartVersion: '1', details: { location: 'New actual installation place' } }))
    expect((await source(f)).source).toBe('invalid')
    const updated = await save(f)
    expect(updated.revision).toBe('2'); expect(updated.current?.lines).toEqual(saved.current?.lines)
    expect(updated.history.find(p => p.planRevisionId === saved.current?.planRevisionId)).toEqual(saved.current)
  })
  it('cancelled actual part cannot be selected again; original plan history and financial root remain', async () => {
    const f = await fixture(), saved = await save(f), money = await ledger(f), current = await head(f)
    await db.tx(c => cancelOrderPart(c, { ...input(f, f.couple), expectedVersion: current.version, partId: f.partId, expectedPartVersion: '1' }))
    expect((await source(f)).source).toBe('invalid'); await denied(f, () => save(f), 422)
    expect((await load(f)).history.find(p => p.planRevisionId === saved.current?.planRevisionId)).toEqual(saved.current)
    expect(await ledger(f)).toEqual(money)
  })
  it('cancelled deal is read-only history and grants no owner write or editor resource IDs', async () => {
    const f = await fixture(), saved = await save(f)
    await db.query("update deals set state='cancelled' where id=$1", [f.dealId])
    expect(await load(f, f.owner)).toMatchObject({ canEdit: false, editorLines: null, current: saved.current, reservation: 'not_reserved' })
    await denied(f, () => save(f), 403)
  })
  it.each(['retired', 'resource_missing', 'person_deleted', 'membership_revoked', 'company_blocked'] as const)('%s gives unavailable source, never a live rewrite of stored public facts', async change => {
    const f = await fixture(), saved = await save(f, [line(f, { resourceId: f.person.id })])
    if (change === 'retired') await db.tx(c => retireResource(c, { vendorId: f.vendorId, actor: f.owner, resourceId: f.person.id, expectedVersion: f.person.version }))
    if (change === 'resource_missing') await db.query('delete from vendor_resources where id=$1', [f.person.id])
    if (change === 'person_deleted') await db.query('update users set deleted_at=now() where id=$1', [f.worker.person.userId])
    if (change === 'membership_revoked') await db.tx(c => revokeStaff(c, { vendorId: f.vendorId, actor: f.owner, memberId: f.worker.id, expectedVersion: f.worker.version }))
    if (change === 'company_blocked') await db.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
    const view = await load(f)
    expect(view.source).toBe('unavailable'); expect(view.history.find(p => p.planRevisionId === saved.current?.planRevisionId)).toEqual(saved.current)
    expect((await plans(f))[0]!.public_snapshot).toEqual(saved.current)
  })
  it('real SQL division failure at audit insertion rolls back already inserted revision and advanced head', async () => {
    const f = await fixture(), before = await state(f), money = await ledger(f), command = await writeInput(f, [line(f)])
    let witnessed = false
    await expect(db.tx(async c => saveOrderResourcePlan({ async query<R extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (/^\s*insert\s+into\s+audit_log\b/i.test(sql) && values?.[0] === f.owner.userId && values?.[2] === f.dealId) {
        expect(await plans(f, c)).toHaveLength(1); expect((await head(f, c)).revision).toBe('1'); witnessed = true
        return c.query<R>('select 1 / $1::integer as deliberate_local_failure', [0])
      }
      return c.query<R>(sql, values)
    } }, command))).rejects.toMatchObject({ code: '22012' })
    expect(witnessed).toBe(true); expect(await state(f)).toEqual(before); expect(await ledger(f)).toEqual(money)
    expect((await save(f)).revision).toBe('1')
  })

  async function insertClone(c: Queryable, f: Fixture, original: QueryResultRow, patch: { payload?: string; digest?: string; publicSnapshot?: unknown; vendorId?: string } = {}) {
    const h = await head(f, c), id = randomUUID(), revision = String(BigInt(h.revision) + 1n), orderVersion = String(BigInt(h.version) + 1n)
    const payload = patch.payload ?? original.private_payload as string
    const snapshot = JSON.parse(payload) as unknown
    const publicSnapshot = { ...((patch.publicSnapshot ?? original.public_snapshot) as Record<string, unknown>), planRevisionId: id, revision }
    await c.query(`insert into deal_resource_plan_versions(id,wedding_id,deal_id,vendor_id,version,source_order_version,private_payload,private_snapshot,private_digest,public_snapshot,created_by)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)`, [id, f.weddingId, f.dealId, patch.vendorId ?? f.vendorId, revision, orderVersion,
      payload, JSON.stringify(snapshot), patch.digest ?? createHash('sha256').update(payload).digest('hex'), JSON.stringify(publicSnapshot), f.owner.userId])
    return { id, revision, orderVersion }
  }
  it('actual immutable update, direct actor clearing, direct delete and foreign head binding are refused atomically', async () => {
    const f = await fixture(), other = await fixture(); await save(f); await save(other)
    const before = await state(f), own = (await head(f)).id!, foreign = (await head(other)).id!
    for (const [sql, params] of [
      ["update deal_resource_plan_versions set private_digest=repeat('0',64) where id=$1", [own]],
      ['update deal_resource_plan_versions set created_by=null where id=$1', [own]],
      ['update deal_resource_plan_versions set created_by=$2 where id=$1', [own, f.partner.userId]],
      ['delete from deal_resource_plan_versions where id=$1', [own]],
      ['update deal_orders set resource_plan_id=$2,resource_plan_revision=resource_plan_revision+1,version=version+1 where deal_id=$1', [f.dealId, foreign]],
    ] as const) {
      await expect(db.tx(c => c.query(sql, params))).rejects.toMatchObject({ code: '23514' }); expect(await state(f)).toEqual(before)
    }
    await save(f, [line(f, { resourceId: f.otherKit.id })]); const latest = await state(f)
    await expect(db.query('update deal_orders set resource_plan_id=$2,resource_plan_revision=1,version=version+1 where deal_id=$1', [f.dealId, own])).rejects.toMatchObject({ code: '23514' })
    expect(await state(f)).toEqual(latest)
  })
  it('next immutable revision without head advance really inserts then fails at COMMIT with no surviving orphan', async () => {
    const f = await fixture(); await save(f)
    const before = await state(f), original = (await plans(f))[0]!
    let inserted = false
    await expect(db.tx(async c => {
      await insertClone(c, f, original); expect(await plans(f, c)).toHaveLength(2); inserted = true
      // No immediate flush: the commit executed by the real Db transaction
      // must enforce the deferred integrity guard.
    })).rejects.toMatchObject({ code: '23514', message: 'resource plan revision must commit with its advanced order head' })
    expect(inserted).toBe(true); expect(await state(f)).toEqual(before)
  })
  it('digest, public projection, schema and vendor mismatches are rejected by real SQL before commit', async () => {
    const f = await fixture(), other = await fixture(); await save(f)
    const before = await state(f), original = (await plans(f))[0]!
    const patches = [
      { digest: '0'.repeat(64) }, { publicSnapshot: { ...(original.public_snapshot as Record<string, unknown>), lines: [] } },
      { payload: '{"lines":[]}', publicSnapshot: { lines: [] } }, { vendorId: other.vendorId },
    ]
    for (const patch of patches) {
      await expect(db.tx(c => insertClone(c, f, original, patch))).rejects.toMatchObject({ code: '23514' })
      expect(await state(f)).toEqual(before)
    }
  })
  it('supported SQL shape with an extra private field cannot be exposed as a validated current or history projection', async () => {
    const f = await fixture(); await save(f)
    const original = (await plans(f))[0]!, before = await state(f)
    const payload = (original.private_payload as string).replace(/("partVersion":"[1-9]\d*",)/, `$1"personUserId":"${f.worker.person.userId}",`)
    expect(payload).not.toBe(original.private_payload)
    // Deliberately corrupt source, confined to a transaction rolled back after
    // the actual loader. No trigger/constraint is disabled and no consent is seeded.
    const rollback = new Error('Rollback contained malformed historical source')
    await expect(db.tx(async c => {
      const revision = await insertClone(c, f, original, { payload })
      await c.query('update deal_orders set version=$3,resource_plan_revision=$4,resource_plan_id=$5 where wedding_id=$1 and deal_id=$2',
        [f.weddingId, f.dealId, revision.orderVersion, revision.revision, revision.id])
      await c.query('set constraints all immediate')
      const view = await loadOrderResourcePlan(c, input(f, f.couple))
      expect(view.source).toBe('invalid'); expect(view.current).toBeNull(); expect(view.history).toHaveLength(1)
      expect(JSON.stringify(view)).not.toContain(f.worker.person.userId); throw rollback
    })).rejects.toBe(rollback)
    expect(await state(f)).toEqual(before)
  })
  it('deleting a synthetic former author clears attribution only; whole wedding deletion erases immutable history naturally', async () => {
    const f = await fixture(), saved = await save(f), original = (await plans(f))[0]!
    // Synthetic historical ownership change on this fixture only. This does
    // not certify a production company-transfer workflow or current-owner
    // erasure. The old author now has no vendor/deal ownership dependency.
    await db.query('update vendors set user_id=$2 where id=$1', [f.vendorId, f.partner.userId])
    await db.query('delete from users where id=$1', [f.owner.userId])
    const remaining = (await plans(f))[0]!
    expect(remaining).toEqual({ ...original, created_by: null })
    expect(await load(f)).toMatchObject({ source: 'current', current: saved.current })
    await db.tx(async c => { await c.query('delete from weddings where id=$1', [f.weddingId]); await c.query('set constraints all immediate') })
    expect(await plans(f)).toEqual([]); expect((await db.query('select deal_id from deal_orders where deal_id=$1', [f.dealId])).rows).toEqual([])
  })

  const terms = (f: Fixture, person = f.couple, termsId?: string) => db.tx(c => loadOrderTerms(c, { ...input(f, person), ...(termsId ? { termsId } : {}) }, proof))
  async function publish(f: Fixture, person = f.couple) {
    const current = await head(f), revision = (await db.query<{ revision: string }>('select terms_revision::text as revision from deal_orders where deal_id=$1', [f.dealId])).rows[0]!.revision
    return db.tx(c => publishOrderTerms(c, { ...input(f, person), expectedOrderVersion: current.version, expectedTermsRevision: revision }))
  }
  async function accept(f: Fixture, person: OrderActor, read?: TermsView) {
    const loaded = read ?? await terms(f, person), selected = loaded.selected!
    expect(loaded.readToken).toBeTypeOf('string')
    return db.tx(c => acceptOrderTerms(c, { ...input(f, person), termsId: selected.id, expectedTermsVersion: selected.version,
      digest: selected.digest, readToken: loaded.readToken! }, proof))
  }
  it('actual old schema1 agreement survives schema2 proposal, exact plan FK and both sides actual new acceptance', async () => {
    const f = await fixture(), before = (await ledger(f)).slice(0, -1)
    const old = await publish(f); expect(old.selected?.snapshot.schemaVersion).toBe(1)
    expect((await db.query('select resource_plan_id from deal_terms_versions where id=$1', [old.proposedTermsId])).rows[0]!.resource_plan_id).toBeNull()
    await accept(f, f.couple); const oldAgreed = await accept(f, f.owner)
    expect(oldAgreed.agreedTermsId).toBe(old.proposedTermsId)
    const oldReceipts = oldAgreed.selected!.receipts
    expect(oldReceipts.map(r => r.party).sort()).toEqual(['customer', 'performer'])
    const planned = await save(f), proposed = await publish(f)
    expect(proposed).toMatchObject({ revision: '2', agreedTermsId: old.proposedTermsId, readToken: null })
    expect(proposed.selected?.snapshot).toMatchObject({ schemaVersion: 2, resourcePlan: planned.current, economics: { amount: '9007199254740993' } })
    expect(proposed.selected?.receipts).toEqual([])
    expect((await db.query('select resource_plan_id from deal_terms_versions where id=$1', [proposed.proposedTermsId])).rows[0]!.resource_plan_id).toBe(planned.current!.planRevisionId)
    const publicPlan = JSON.stringify(proposed.selected!.snapshot.resourcePlan)
    for (const id of [f.kit.id, f.person.id, f.capacity.id, f.window.id, f.worker.person.userId, f.worker.id]) expect(publicPlan).not.toContain(id)
    await accept(f, f.couple); const agreed = await accept(f, f.owner)
    expect(agreed.agreedTermsId).toBe(proposed.proposedTermsId)
    expect(agreed.selected?.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ party: 'customer', userId: f.couple.userId, sessionId: f.couple.sessionId }),
      expect.objectContaining({ party: 'performer', userId: f.owner.userId, sessionId: f.owner.sessionId }),
    ]))
    expect((await terms(f, f.couple, old.proposedTermsId!)).selected?.receipts).toEqual(oldReceipts)
    expect((await ledger(f)).slice(0, -1)).toEqual(before)
  })
  it('same-label resource replacement makes existing proposal stale and creates distinct terms without inherited acceptance', async () => {
    const f = await fixture(); await save(f); const first = await publish(f)
    await accept(f, f.couple); const agreed = await accept(f, f.owner), receipts = agreed.selected!.receipts
    await save(f, [line(f, { resourceId: f.otherKit.id })])
    const stale = await terms(f)
    expect(stale.selected?.freshness).toBe('stale'); expect(stale.readToken).toBeNull(); expect(stale.selected?.receipts).toEqual(receipts)
    const second = await publish(f)
    expect(second.agreedTermsId).toBe(first.proposedTermsId); expect(second.selected?.receipts).toEqual([])
    expect(second.selected?.digest).not.toBe(first.selected?.digest)
    expect(second.selected?.snapshot.resourcePlan).not.toEqual(first.selected?.snapshot.resourcePlan)
    expect(second.acceptedByCaller).toBe(false)
  })
  it('changing used/capacity does not stale agreed facts; actual terms acceptance still promises no reservation', async () => {
    const f = await fixture(); await save(f, [capacityLine(f)]); const published = await publish(f)
    await accept(f, f.couple)
    await db.query('update resource_capacity_windows set capacity=20,used=19,legacy_used=19,version=version+1 where id=$1', [f.window.id])
    const before = (await ledger(f)).slice(0, -1), loaded = await terms(f, f.owner)
    expect(loaded.selected?.freshness).toBe('current'); expect(loaded.selected?.digest).toBe(published.selected?.digest)
    expect((await accept(f, f.owner, loaded)).agreedTermsId).toBe(published.proposedTermsId)
    expect((await load(f)).reservation).toBe('not_reserved'); expect((await ledger(f)).slice(0, -1)).toEqual(before)
  })
  it('retired resource preserves terms history but issues no read proof and denies publish/old proof acceptance', async () => {
    const f = await fixture(); await save(f); await publish(f)
    const read = await terms(f, f.couple), before = await ledger(f)
    await db.tx(c => retireResource(c, { vendorId: f.vendorId, actor: f.owner, resourceId: f.kit.id, expectedVersion: f.kit.version }))
    const historical = await terms(f)
    expect(historical.selected?.freshness).toBe('unavailable'); expect(historical.readToken).toBeNull()
    await expect(publish(f)).rejects.toMatchObject({ statusCode: 409, code: 'terms_performer_unavailable' })
    await expect(accept(f, f.couple, read)).rejects.toMatchObject({ statusCode: 409, code: 'terms_source_changed' })
    expect((await db.query('select id from deal_terms_receipts where deal_id=$1', [f.dealId])).rows).toEqual([])
    const after = await ledger(f); expect(after.slice(0, 6)).toEqual(before.slice(0, 6)); expect(after[7]).toEqual(before[7])
  })
  it('invalid current resource source keeps prior terms readable but blocks publication and proof issuance', async () => {
    const f = await fixture(); await save(f); const published = await publish(f)
    await db.query('update order_parts set version=version+1 where id=$1', [f.partId])
    const historical = await terms(f)
    expect(historical.selected?.id).toBe(published.selected?.id); expect(historical.selected?.freshness).toBe('invalid'); expect(historical.readToken).toBeNull()
    await expect(publish(f)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('dual couple/vendor owner acceptance remains customer-side and never fabricates a second performer receipt', async () => {
    const f = await fixture()
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.weddingId, f.owner.userId])
    await save(f); await publish(f, f.owner)
    const accepted = await accept(f, f.owner)
    expect(accepted.selected?.receipts).toHaveLength(1); expect(accepted.selected?.receipts[0]).toMatchObject({ party: 'customer', userId: f.owner.userId })
    expect(accepted.agreedTermsId).toBeNull()
  })
  it('real SQL terms insertion rejects a private plan leak or a foreign immutable plan binding', async () => {
    const f = await fixture(), other = await fixture(); await save(f); await save(other)
    const actual = await publish(f), original = actual.selected!, ownPlan = (await load(f)).current!, foreignPlan = (await load(other)).current!
    for (const plan of [{ ...ownPlan, lines: ownPlan.lines.map(p => ({ ...p, resourceId: f.kit.id })) }, foreignPlan]) {
      const snapshot = { ...original.snapshot, resourcePlan: plan }, payload = canonicalTermsJson(snapshot), digest = createHash('sha256').update(payload).digest('hex')
      await expect(db.tx(c => c.query(`insert into deal_terms_versions(id,wedding_id,deal_id,version,source_order_version,source_fingerprint,canonical_payload,snapshot,digest,published_by,published_side,resource_plan_id)
        values($1,$2,$3,2,$4,$5,$6,$7::jsonb,$5,$8,'customer',$9)`,
      [randomUUID(), f.weddingId, f.dealId, original.sourceOrderVersion, digest, payload, JSON.stringify(snapshot), f.couple.userId, plan.planRevisionId]))).rejects.toMatchObject({ code: '23514' })
    }
    expect((await db.query('select id from deal_terms_versions where deal_id=$1', [f.dealId])).rows).toEqual([{ id: original.id }])
  })

  async function waited(change: string, blocker: string, params: readonly unknown[], mutation: (c: Queryable) => Promise<unknown>, action: (c: Queryable) => Promise<unknown>) {
    let release!: () => void, locked!: () => void, started!: () => void, holderPid = 0, waiterPid = 0
    const permission = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { locked = r }), entered = new Promise<void>(r => { started = r })
    const holder = db.tx(async c => { holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query(blocker, params); locked(); await permission; await mutation(c) })
    await ready
    const waiter = db.tx(async c => { waiterPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid; started(); return action(c) })
    const result = waiter.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    try {
      await entered
      let witness: { wait_event: string | null } | undefined
      for (let attempt = 0; attempt < 60; attempt++) {
        witness = (await db.query<{ wait_event: string | null }>('select wait_event from pg_stat_activity where pid=$1 and wait_event_type=\'Lock\' and $2=any(pg_blocking_pids(pid))', [waiterPid, holderPid])).rows[0]
        if (witness) break
        await new Promise<void>(r => setTimeout(r, 25))
      }
      expect(witness, `${change}: actual waiter ${waiterPid} must be blocked by ${holderPid}`).toBeDefined()
      witnesses.push({ change, holder: holderPid, waiter: waiterPid, waitEvent: witness!.wait_event })
      release(); await holder
      return await result
    } finally { release(); await holder; await result }
  }
  it.each(['session', 'consent', 'role', 'account'] as const)('after real wedding wait, current %s change denies stale principal and saves nothing', async change => {
    const f = await fixture(), before = await state(f), command = await writeInput(f, [line(f)], change === 'role' ? f.couple : f.owner)
    const result = await waited(change, 'select id from weddings where id=$1 for update', [f.weddingId], async c => {
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.owner.sessionId])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [f.owner.userId])
      if (change === 'role') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.weddingId, f.couple.userId])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [f.owner.userId])
    }, c => saveOrderResourcePlan(c, command))
    expect(result).toMatchObject({ ok: false, error: { statusCode: change === 'consent' ? 403 : change === 'role' ? 404 : 401 } })
    expect(await state(f)).toEqual(before)
  })
  it.each(['retirement', 'membership'] as const)('actual %s while waiting on company prevents saving an unavailable selected person', async change => {
    const f = await fixture(), before = await state(f), command = await writeInput(f, [line(f, { resourceId: f.person.id })])
    const result = await waited(change, 'select id from vendors where id=$1 for update', [f.vendorId], c => change === 'retirement'
      ? retireResource(c, { vendorId: f.vendorId, actor: f.owner, resourceId: f.person.id, expectedVersion: f.person.version })
      : revokeStaff(c, { vendorId: f.vendorId, actor: f.owner, memberId: f.worker.id, expectedVersion: f.worker.version }), c => saveOrderResourcePlan(c, command))
    expect(result).toMatchObject({ ok: false, error: { statusCode: 409, code: 'resource_plan_unavailable' } }); expect(await state(f)).toEqual(before)
  })
})
