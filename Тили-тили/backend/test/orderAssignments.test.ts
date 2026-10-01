import { randomInt, randomUUID } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import { loadOrder, patchOrderBrief, createOrderPart, patchOrderPart, cancelOrderPart, validatePartDetails, type OrderWriteInput } from '../src/orders/model.js'
import { createAdditionalSlot, createOrderAssignment, cancelOrderAssignment } from '../src/orders/assignments.js'
import type { OrderActor } from '../src/orders/context.js'

describe('typed draft parts', () => {
  it.each(['timed_service', 'appointment', 'supply', 'rental', 'deliverable'] as const)('%s has unknown nullable fields without invented fulfillment', kind => {
    const details = validatePartDetails(kind, {})
    expect(Object.values(details).every(v => v === null)).toBe(true)
    expect(details).not.toHaveProperty('done')
  })
  it.each([
    ['supply', { dueAt: '2026-10-01T10:00:00Z' }], ['rental', { quantity: 0 }], ['supply', { quantity: 1.5 }],
    ['rental', { quantity: Number.MAX_SAFE_INTEGER }], ['timed_service', { travelMinutes: -1 }],
    ['timed_service', { startsAt: '2026-02-30T10:00:00Z' }], ['appointment', { startsAt: '2026-10-01T10:00:00' }],
    ['appointment', { startsAt: '2026-10-01T25:00:00Z' }], ['deliverable', { dueAt: '2026-10-01T10:00:00+14:01' }],
    ['timed_service', { startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T10:00:00Z' }],
    ['supply', { windowStartsAt: '2026-10-01T10:00:00Z', windowEndsAt: '2026-10-01T09:00:00Z' }],
    ['rental', { handoverAt: '2026-10-01T10:00:00Z', returnAt: '2026-10-01T09:00:00Z' }],
    ['deliverable', { items: [''] }], ['deliverable', { items: Array.from({ length: 101 }, () => 'Photo') }],
    ['supply', { recipient: { userId: 'not-an-authorized-account' } }],
  ] as const)('rejects incompatible or invalid %s details %#', (kind, details) => {
    expect(() => validatePartDetails(kind, details)).toThrow()
  })
  it('compares interval instants across explicit offsets and allows same-instant rental return', () => {
    expect(validatePartDetails('timed_service', { startsAt: '2026-10-01T10:00:00+03:00', endsAt: '2026-10-01T08:00:00Z' })).toMatchObject({ startsAt: '2026-10-01T10:00:00+03:00' })
    expect(validatePartDetails('rental', { handoverAt: '2026-10-01T10:00:00+03:00', returnAt: '2026-10-01T07:00:00Z' })).toMatchObject({ returnAt: '2026-10-01T07:00:00Z' })
  })
  it('rejects accessor details without evaluating code', () => {
    let called = false
    expect(() => validatePartDetails('supply', { get quantity() { called = true; return 1 } })).toThrow()
    expect(called).toBe(false)
  })
  it('rejects non-enumerable irrelevant fields in a persisted draft validator', () => {
    const details = Object.defineProperty({}, 'dueAt', { value: '2026-10-01T10:00:00Z' })
    expect(() => validatePartDetails('supply', details)).toThrow()
  })
})
const DB = process.env.TEST_DATABASE_URL
describe.skipIf(!DB)('order assignments real database guards', () => {
  let db: Db
  const users: string[] = [], weddings: string[] = []
  beforeAll(() => { db = createDb(DB!) })
  afterAll(async () => {
    for (const id of weddings) await db.query('delete from weddings where id=$1', [id])
    for (const id of users) await db.query('delete from users where id=$1', [id])
    await db.close()
  })
  async function actor(): Promise<OrderActor> {
    const userId = randomUUID(), sessionId = randomUUID(); users.push(userId)
    await db.query("insert into users(id,phone,name) values($1,$2,'Order test')", [userId, '+79' + randomInt(100_000_000, 999_999_999)])
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await db.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(), userId])
    return { userId, sessionId, policyVersion: '2026-09-02' }
  }
  async function fixture() {
    const owner = await actor(), vendorOwner = await actor(), weddingId = randomUUID(), dealId = randomUUID(), slotId = randomUUID(), vendorId = randomUUID(), eventId = randomUUID(); weddings.push(weddingId)
    await db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Order','2026-10-01','Europe/Moscow',$3)", [weddingId, owner.userId, randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    await db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Studio',now())", [vendorId, vendorOwner.userId])
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photo')", [slotId, weddingId])
    await db.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price,package_title_snapshot,package_includes_snapshot) values($1,$2,$3,$4,'booked',15000,'Legacy',$5::jsonb)", [dealId, weddingId, slotId, vendorId, '["old"]'])
    await db.query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
    await db.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2026-10-01','deal',$2)", [vendorId, dealId])
    await db.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Second','other','2026-10-02','Europe/Moscow',false)", [eventId, weddingId])
    const main = (await db.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    return { weddingId, dealId, slotId, vendorId, eventId, main, owner, vendorOwner }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const input = (w: Fixture, expectedVersion = '1'): OrderWriteInput => ({ weddingId: w.weddingId, dealId: w.dealId, actor: w.owner, expectedVersion })
  const load = (w: Fixture) => db.tx(c => loadOrder(c, input(w)))
  const assign = (w: Fixture, version = '1', slotId: string = w.slotId, programEventId: string = w.main) => db.tx(c => createOrderAssignment(c, { ...input(w, version), slotId, programEventId, label: 'Work' }))
  const extra = (w: Fixture, programEventId: string = w.eventId) => db.tx(c => createAdditionalSlot(c, { weddingId: w.weddingId, actor: w.owner, categoryId: 'photo', programEventId, label: 'Second photographer' }))
  it('legacy initialization creates no invented work and retains financial snapshots', async () => {
    const w = await fixture()
    expect(await load(w)).toMatchObject({ version: '1', source: 'legacy', brief: null, parts: [], assignments: [] })
    expect((await db.query('select price::text,package_title_snapshot,package_includes_snapshot from deals where id=$1', [w.dealId])).rows[0]).toEqual({ price: '15000', package_title_snapshot: 'Legacy', package_includes_snapshot: ['old'] })
  })
  it('brief uses primary category, rejects unknown fields, versions only actual changes', async () => {
    const w = await fixture()
    await expect(db.tx(c => patchOrderBrief(c, { ...input(w), brief: { values: { quantity: 10 } } }))).rejects.toMatchObject({ statusCode: 422 })
    const changed = await db.tx(c => patchOrderBrief(c, { ...input(w), brief: { values: {} } }))
    expect(changed).toMatchObject({ version: '2', source: 'structured', brief: { categoryId: 'photo', values: {} } })
    expect((await db.tx(c => patchOrderBrief(c, { ...input(w, '2'), brief: { values: {} } }))).version).toBe('2')
    expect((await db.query("select actor_id from audit_log where entity_id=$1 and action='order.brief_changed'", [w.dealId])).rows).toEqual([{ actor_id: w.owner.userId }])
  })
  it('same category across events is independent; cancellation preserves the root, other parts and legacy hold', async () => {
    const w = await fixture(), first = await assign(w), position = await extra(w), second = await assign(w, first.version, position.id, w.eventId)
    const a = first.assignments[0]!, b = second.assignments.find(row => row.id !== a.id)!
    const partsA = await db.tx(c => createOrderPart(c, { ...input(w, second.version), assignmentId: a.id, kind: 'timed_service', title: 'First', details: {} }))
    const partsB = await db.tx(c => createOrderPart(c, { ...input(w, partsA.version), assignmentId: b.id, kind: 'supply', title: 'Second', details: { quantity: 2, unit: 'sets' } }))
    const cancelled = await db.tx(c => cancelOrderAssignment(c, { ...input(w, partsB.version), assignmentId: a.id, expectedAssignmentVersion: a.version }))
    expect(cancelled.assignments.find(row => row.id === a.id)?.cancelledAt).not.toBeNull()
    expect(cancelled.assignments.find(row => row.id === b.id)?.cancelledAt).toBeNull()
    expect(cancelled.parts.find(row => row.title === 'First')?.cancelledAt).not.toBeNull()
    expect(cancelled.parts.find(row => row.title === 'Second')?.cancelledAt).toBeNull()
    expect((await db.query('select state,price::text from deals where id=$1', [w.dealId])).rows[0]).toEqual({ state: 'booked', price: '15000' })
    expect((await db.query('select deal_id from vendor_busy_dates where vendor_id=$1', [w.vendorId])).rows).toEqual([{ deal_id: w.dealId }])
    expect((await db.query('select count(*)::text n,sum(price)::text total from deals where wedding_id=$1', [w.weddingId])).rows[0]).toEqual({ n: '1', total: '15000' })
    expect((await db.tx(c => cancelOrderAssignment(c, { ...input(w, cancelled.version), assignmentId: a.id, expectedAssignmentVersion: '2' }))).version).toBe(cancelled.version)
  })
  it('two additional positions in the same event are allowed but one position cannot be assigned twice', async () => {
    const w = await fixture(), a = await extra(w), b = await extra(w), first = await assign(w, '1', a.id, w.eventId)
    expect((await assign(w, first.version, b.id, w.eventId)).assignments).toHaveLength(2)
    await expect(assign(w, '3', a.id, w.eventId)).rejects.toMatchObject({ code: 'slot_taken' })
  })
  it('global old empty slot cannot silently become an additional assignment; foreign slot/event and category are denied', async () => {
    const w = await fixture(), other = await fixture(), global = randomUUID()
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Old empty')", [global, w.weddingId])
    await expect(assign(w, '1', global, w.eventId)).rejects.toMatchObject({ statusCode: 422 })
    await expect(assign(w, '1', other.slotId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(assign(w, '1', w.slotId, other.eventId)).rejects.toMatchObject({ statusCode: 404 })
    const slot = await extra(w)
    await expect(assign(w, '1', slot.id, w.main)).rejects.toMatchObject({ statusCode: 422 })
    await db.query("update slots set category_id='video' where id=$1", [slot.id])
    await expect(assign(w, '1', slot.id, w.eventId)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('foreign occupied primary slot is not reassigned even in the same wedding', async () => {
    const w = await fixture(), slot = await extra(w), deal = randomUUID()
    await db.query("insert into deals(id,wedding_id,slot_id,vendor_id,state) values($1,$2,$3,$4,'booked')", [deal, w.weddingId, slot.id, w.vendorId])
    await db.query('update slots set deal_id=$2 where id=$1', [slot.id, deal])
    await expect(assign(w, '1', slot.id, w.eventId)).rejects.toMatchObject({ code: 'slot_taken' })
  })
  it('all five part types compose without new payments, acceptance or inferred assignment', async () => {
    const w = await fixture(), first = await assign(w); let order = first
    for (const kind of ['timed_service', 'appointment', 'supply', 'rental', 'deliverable'] as const) {
      order = await db.tx(c => createOrderPart(c, { ...input(w, order.version), kind, assignmentId: kind === 'deliverable' ? null : first.assignments[0]!.id, title: kind, details: {} }))
    }
    expect(order.parts).toHaveLength(5)
    expect((await db.query('select count(*)::text n from payments where deal_id=$1', [w.dealId])).rows[0]?.n).toBe('0')
    expect((await db.query('select count(*)::text n from documents where deal_id=$1', [w.dealId])).rows[0]?.n).toBe('0')
  })
  it('requires current assignment for working parts and refuses foreign or cancelled scope', async () => {
    const w = await fixture(), other = await fixture(), foreign = await assign(other)
    await expect(db.tx(c => createOrderPart(c, { ...input(w), kind: 'supply', title: 'Supply', details: {} }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(db.tx(c => createOrderPart(c, { ...input(w), kind: 'supply', assignmentId: foreign.assignments[0]!.id, title: 'Supply', details: {} }))).rejects.toMatchObject({ statusCode: 404 })
    const current = await assign(w), a = current.assignments[0]!
    const cancelled = await db.tx(c => cancelOrderAssignment(c, { ...input(w, current.version), assignmentId: a.id, expectedAssignmentVersion: '1' }))
    await expect(db.tx(c => createOrderPart(c, { ...input(w, cancelled.version), kind: 'supply', assignmentId: a.id, title: 'Supply', details: {} }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('part patch preserves its identity/kind, validates merged intervals and refuses stale child writes', async () => {
    const w = await fixture(), order = await db.tx(c => createOrderPart(c, { ...input(w), kind: 'deliverable', title: 'Photos', details: { items: ['Album'] } })), p = order.parts[0]!
    const changed = await db.tx(c => patchOrderPart(c, { ...input(w, order.version), partId: p.id, expectedPartVersion: '1', details: { dueAt: '2026-11-01T10:00:00Z' } }))
    expect(changed.parts[0]).toMatchObject({ id: p.id, kind: 'deliverable', version: '2', details: { items: ['Album'], dueAt: '2026-11-01T10:00:00Z' } })
    await expect(db.tx(c => patchOrderPart(c, { ...input(w, changed.version), partId: p.id, expectedPartVersion: '1', title: 'Stale' }))).rejects.toMatchObject({ statusCode: 409 })
    expect((await db.tx(c => patchOrderPart(c, { ...input(w, changed.version), partId: p.id, expectedPartVersion: '2', details: { items: ['Album'] } }))).version).toBe(changed.version)
    const cancelled = await db.tx(c => cancelOrderPart(c, { ...input(w, changed.version), partId: p.id, expectedPartVersion: '2' }))
    expect(cancelled.parts[0]?.version).toBe('3')
    await expect(db.tx(c => patchOrderPart(c, { ...input(w, cancelled.version), partId: p.id, expectedPartVersion: '3', title: 'Again' }))).rejects.toMatchObject({ code: 'order_part_cancelled' })
  })
  it('vendor owner may draft a brief/part but cannot move positions; team helpers cannot read private drafts', async () => {
    const w = await fixture()
    await db.tx(c => patchOrderBrief(c, { ...input(w), actor: w.vendorOwner, brief: { values: {} } }))
    await expect(db.tx(c => createOrderAssignment(c, { ...input(w, '2'), actor: w.vendorOwner, slotId: w.slotId, programEventId: w.main, label: 'Move' }))).rejects.toMatchObject({ statusCode: 403 })
    await db.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [w.weddingId, w.owner.userId])
    await expect(load(w)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('database itself rejects a cross-wedding assignment and cross-deal part', async () => {
    const w = await fixture(), other = await fixture(), foreign = await assign(other), foreignEmpty = await extra(other)
    await expect(db.query("insert into order_assignments(id,wedding_id,deal_id,slot_id,program_event_id,source,label) values($1,$2,$3,$4,$5,'structured','Bad')", [randomUUID(), w.weddingId, w.dealId, foreignEmpty.id, w.main])).rejects.toMatchObject({ code: '23503' })
    await expect(db.query("insert into order_parts(id,wedding_id,deal_id,assignment_id,kind,source,title,details) values($1,$2,$3,$4,'supply','structured','Bad','{}')", [randomUUID(), w.weddingId, w.dealId, foreign.assignments[0]!.id])).rejects.toMatchObject({ code: '23503' })
  })
  it('concurrent root writers yield one update and one conflict', async () => {
    const w = await fixture(), results = await Promise.allSettled([assign(w), assign(w)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect((await load(w)).assignments).toHaveLength(1)
  })
  it('two different deals competing for one explicit position cannot both win', async () => {
    const w = await fixture(), ownSlot = randomUUID(), anotherDeal = randomUUID(), position = await extra(w)
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Another root')", [ownSlot, w.weddingId])
    await db.query("insert into deals(id,wedding_id,slot_id,vendor_id,state) values($1,$2,$3,$4,'booked')", [anotherDeal, w.weddingId, ownSlot, w.vendorId])
    await db.query('update slots set deal_id=$2 where id=$1', [ownSlot, anotherDeal])
    const results = await Promise.allSettled([assign(w, '1', position.id, w.eventId), db.tx(c => createOrderAssignment(c, { ...input(w), dealId: anotherDeal, slotId: position.id, programEventId: w.eventId, label: 'Competing' }))])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'slot_taken' } })
    expect((await db.query('select count(*)::text n from order_assignments where slot_id=$1 and cancelled_at is null', [position.id])).rows[0]?.n).toBe('1')
  })
  it('atomic audit failure rolls back both child creation and root revision', async () => {
    const w = await fixture()
    await expect(db.tx(c => {
      const failAudit: Queryable = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
        if (/insert into audit_log/.test(sql)) return Promise.reject(new Error('Controlled audit failure'))
        return c.query<T>(sql, values)
      } }
      return createOrderPart(failAudit, { ...input(w), kind: 'deliverable', title: 'Photos', details: {} })
    })).rejects.toThrow('Controlled audit failure')
    expect(await load(w)).toMatchObject({ version: '1', source: 'legacy', parts: [] })
  })
  it('validates an interval again after merging a partial patch', async () => {
    const w = await fixture(), order = await assign(w), created = await db.tx(c => createOrderPart(c, { ...input(w, order.version), assignmentId: order.assignments[0]!.id, kind: 'appointment', title: 'Meeting',
      details: { startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z' } })), part = created.parts[0]!
    await expect(db.tx(c => patchOrderPart(c, { ...input(w, created.version), partId: part.id, expectedPartVersion: '1', details: { endsAt: '2026-10-01T09:00:00Z' } }))).rejects.toMatchObject({ statusCode: 422 })
    expect((await load(w)).version).toBe(created.version)
  })
  it('malformed root/child identifiers and versions fail without database parser errors', async () => {
    const w = await fixture()
    await expect(db.tx(c => createOrderPart(c, { ...input(w), kind: 'supply', title: 'Supply', assignmentId: 'not-an-id', details: {} }))).rejects.toMatchObject({ statusCode: 422 })
    for (const expectedVersion of ['0', '-1', '1.0', '01', '']) await expect(db.tx(c => patchOrderBrief(c, { ...input(w, expectedVersion), brief: null }))).rejects.toMatchObject({ statusCode: 422 })
    expect((await load(w)).version).toBe('1')
  })
  it('explicit position cap is independent of category count and cannot be exceeded', async () => {
    const w = await fixture()
    await db.query("insert into slots(id,wedding_id,category_id,label) select gen_random_uuid(),$1,'photo','Extra' from generate_series(1,99)", [w.weddingId])
    await expect(extra(w)).rejects.toMatchObject({ code: 'slot_limit' })
    expect((await db.query('select count(*)::text n from slots where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe('100')
  })
  it('pending team invite does not authorize a foreign live actor or confer vendor ownership', async () => {
    const w = await fixture(), pending = await actor()
    await db.query("insert into invites(code,wedding_id,role,created_by,expires_at) values($1,$2,'couple',$3,now()+interval '1 day')", [randomUUID(), w.weddingId, w.owner.userId])
    await expect(db.tx(c => loadOrder(c, { ...input(w), actor: pending }))).rejects.toMatchObject({ statusCode: 404 })
    await db.query('update vendors set blocked_at=now() where id=$1', [w.vendorId])
    await expect(db.tx(c => loadOrder(c, { ...input(w), actor: w.vendorOwner }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('wedding erase cascades real structured rows without manual dependency cleanup; individual position/event deletion remains denied', async () => {
    const w = await fixture(), slot = await extra(w), assigned = await assign(w, '1', slot.id, w.eventId)
    await db.tx(c => createOrderPart(c, { ...input(w, assigned.version), assignmentId: assigned.assignments[0]!.id, kind: 'supply', title: 'Flowers', details: { quantity: 20, unit: 'bouquets' } }))
    await expect(db.tx(c => c.query('delete from slots where id=$1', [slot.id]))).rejects.toMatchObject({ code: '23503' })
    await expect(db.tx(c => c.query('delete from wedding_events where id=$1', [w.eventId]))).rejects.toMatchObject({ code: '23503' })
    await expect(db.tx(c => c.query('delete from order_assignments where id=$1', [assigned.assignments[0]!.id]))).rejects.toMatchObject({ code: '23503' })
    await db.tx(c => c.query('delete from weddings where id=$1', [w.weddingId]))
    for (const table of ['slots', 'deals', 'deal_orders', 'order_assignments', 'order_parts', 'wedding_events']) {
      expect((await db.query(`select count(*)::text n from ${table} where wedding_id=$1`, [w.weddingId])).rows[0]?.n).toBe('0')
    }
  })
  it('accepted uppercase UUID input denotes the same primary position and deal', async () => {
    const w = await fixture()
    const order = await db.tx(c => createOrderAssignment(c, { ...input(w), weddingId: w.weddingId.toUpperCase(), dealId: w.dealId.toUpperCase(),
      slotId: w.slotId.toUpperCase(), programEventId: w.main.toUpperCase(), label: 'Main work' }))
    expect(order.assignments[0]).toMatchObject({ slotId: w.slotId, programEventId: w.main })
  })
  it.each(['member_removed', 'session_revoked', 'consent_withdrawn', 'user_deleted', 'wedding_cancelled', 'deal_cancelled'] as const)('rechecks %s after the real wedding lock', async action => {
    const w = await fixture(); let locked!: () => void, attempted!: () => void
    const hasLock = new Promise<void>(r => { locked = r }), hasAttempt = new Promise<void>(r => { attempted = r })
    const holder = db.tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [w.weddingId]); locked(); await hasAttempt
      if (action === 'member_removed') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.owner.userId])
      if (action === 'session_revoked') await c.query('update sessions set revoked_at=now() where id=$1', [w.owner.sessionId])
      if (action === 'consent_withdrawn') await c.query('update consents set withdrawn_at=now() where user_id=$1', [w.owner.userId])
      if (action === 'user_deleted') await c.query('update users set deleted_at=now() where id=$1', [w.owner.userId])
      if (action === 'wedding_cancelled') await c.query('update weddings set cancelled_at=now() where id=$1', [w.weddingId])
      if (action === 'deal_cancelled') await c.query("update deals set state='cancelled' where id=$1", [w.dealId])
    })
    await hasLock
    const waiting = db.tx(c => {
      const observed: Queryable = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
        const result = c.query<T>(sql, values); if (/from weddings/.test(sql)) attempted(); return result
      } }
      return patchOrderBrief(observed, { ...input(w), brief: { values: {} } })
    })
    const outcome = expect(waiting).rejects.toMatchObject({ statusCode: action === 'session_revoked' || action === 'user_deleted' ? 401 : action === 'consent_withdrawn' || action === 'deal_cancelled' ? 403 : 404 })
    await holder; await outcome
    expect((await db.query('select version::text from deal_orders where deal_id=$1', [w.dealId])).rows[0]?.version).toBe('1')
  })
})
