import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import pg from 'pg'
import type { FastifyRequest } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import type { Caller } from '../src/plugins/auth.js'
import { type OrderActor, lockOrderContext } from '../src/orders/context.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { lockResourceScope } from '../src/resources/model.js'
import { lockVendorProgramAccess } from '../src/vendor/program-access.js'
import { inviteStaff, acceptStaffInvite, declineStaffInvite, revokeStaff, updateStaffRole, listStaff,
  lockStaffMember, createStaffDuty, revokeStaffDuty, lockStaffDuty, type StaffRole, type StaffDutyRole } from '../src/vendor/staff.js'

const DB = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
interface Actor extends OrderActor { consentId: string }
describe.skipIf(!DB)('company staff: actual PostgreSQL consent, scoped work and revocation', () => {
  let db: Db
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    assert(['tili_ecosystem_staff_20260930_test', 'tili_ecosystem_full_20260930_test'].includes(target.pathname.slice(1)))
    db = createDb(DB!)
    const actual = (await db.query<{ name: string; address: string; port: number }>('select current_database() as name,host(inet_server_addr()) as address,inet_server_port() as port')).rows[0]!
    assert.equal(actual.name, target.pathname.slice(1)); assert.equal(actual.port, Number(disposablePgPort()))
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(actual.address))
  })
  afterAll(async () => {
    if (!db) return
    try {
      // Only this file's generated fixture IDs; append-only audit evidence stays.
      for (const id of weddings) await db.query('delete from weddings where id=$1', [id])
      for (const id of users) await db.query('delete from users where id=$1', [id])
    } finally { await db.close() }
  })
  async function actor(label: string): Promise<Actor> {
    const sessionId = randomUUID(), consentId = randomUUID()
    let userId: string | undefined
    // Synthetic test principals, not a claim that a real human consented.
    for (let attempt = 0; attempt < 8; attempt++) {
      userId = (await db.query<{ id: string }>('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id', [randomUUID(), '+79' + randomInt(100_000_000, 999_999_999), 'Synthetic staff ' + label])).rows[0]?.id
      if (userId) break
    }
    if (!userId) throw new Error(`Synthetic staff fixture could not allocate a unique phone after 8 attempts (${label})`)
    users.push(userId)
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await db.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    return { userId, sessionId, consentId, policyVersion: POLICY }
  }
  async function fixture() {
    const owner = await actor('owner'), worker = await actor('worker'), outsider = await actor('outsider'), couple = await actor('couple'), helper = await actor('helper'), coordinator = await actor('coordinator')
    const vendorId = randomUUID(), weddingId = randomUUID(), dealId = randomUUID(), slotId = randomUUID(), secondEvent = randomUUID(); weddings.push(weddingId)
    await db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic staff company',now())", [vendorId, owner.userId])
    await db.query("insert into weddings(id,owner_id,title,date,tz,invite_code,venue) values($1,$2,'Staff operational fixture','2027-06-14','Europe/Moscow',$3,'Private venue')", [weddingId, couple.userId, randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper'),($1,$4,'coordinator')", [weddingId, couple.userId, helper.userId, coordinator.userId])
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photographer')", [slotId, weddingId])
    await db.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'booked',9007199254740993)", [dealId, weddingId, slotId, vendorId])
    await db.query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
    await db.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2)", [vendorId, dealId])
    await db.query("insert into payments(id,deal_id,kind,amount,status) values($1,$2,'deposit',12345,'recorded')", [randomUUID(), dealId])
    await db.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,location) values($1,$2,'Second day','second_day','2027-06-15',null,'Other actual venue')", [secondEvent, weddingId])
    const main = (await db.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    const version = (await db.query<{ version: string }>('select timeline_version::text as version from weddings where id=$1', [weddingId])).rows[0]!.version
    // Inherited synthetic program history tests preservation only. No human proof.
    const snapshot = { syntheticInheritedFixture: true, blocks: [] }, digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    await db.query('insert into vendor_program_acknowledgments(wedding_id,vendor_id,user_id,session_id,version,digest,program_snapshot) values($1,$2,$3,$4,$5,$6,$7::jsonb)', [weddingId, vendorId, owner.userId, owner.sessionId, version, digest, JSON.stringify(snapshot)])
    return { owner, worker, outsider, couple, helper, coordinator, vendorId, weddingId, dealId, slotId, main, secondEvent }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const scope = (f: Fixture, a = f.owner) => ({ vendorId: f.vendorId, actor: a })
  const workScope = (f: Fixture, a = f.owner) => ({ ...scope(f, a), weddingId: f.weddingId, dealId: f.dealId })
  const invite = (f: Fixture, role: StaffRole = 'worker', targetUserId = f.worker.userId) => db.tx(c => inviteStaff(c, { ...scope(f), role, targetUserId }))
  async function active(f: Fixture, role: StaffRole = 'worker') {
    const invitation = await invite(f, role)
    const membership = await db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker }))
    return { invitation, membership }
  }
  const createDuty = (f: Fixture, memberId: string, role: StaffDutyRole = 'performer') => db.tx(c => createStaffDuty(c, { ...workScope(f), memberId, programEventId: f.main, role, label: 'Photograph ceremony' }))
  const operational = (f: Fixture, dutyId: string, a = f.worker) => db.tx(c => lockStaffDuty(c, { ...workScope(f, a), programEventId: f.main, dutyId }))
  const auditCount = async (id: string) => Number((await db.query<{ n: string }>('select count(*)::text as n from audit_log where entity_id=$1', [id])).rows[0]!.n)
  async function preserved(f: Fixture) {
    return (await db.query(`select
      (select jsonb_agg(to_jsonb(d) order by d.id) from deals d where d.wedding_id=$1) as deals,
      (select jsonb_agg(to_jsonb(p) order by p.id) from payments p where p.deal_id=$2) as payments,
      (select jsonb_agg(to_jsonb(b) order by b.date) from vendor_busy_dates b where b.vendor_id=$3) as busy,
      (select jsonb_agg(to_jsonb(a) order by a.user_id) from vendor_program_acknowledgments a where a.wedding_id=$1) as receipts,
      (select to_jsonb(w) from weddings w where w.id=$1) as wedding`, [f.weddingId, f.dealId, f.vendorId])).rows[0]
  }

  it('invites with a random secret, stores only its hash, uses seven DB-clock days and creates no acceptance', async () => {
    const f = await fixture(), before = await preserved(f), invitation = await invite(f)
    expect(invitation).toMatchObject({ state: 'invited', version: '1', acceptedAt: null, userId: f.worker.userId })
    expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const raw = (await db.query('select *,extract(epoch from invite_expires_at-created_at) as ttl from vendor_staff_members where id=$1', [invitation.id])).rows[0]!
    expect(raw.invite_token_hash).toBe(createHash('sha256').update(invitation.token).digest('hex'))
    expect(Number(raw.ttl)).toBeGreaterThan(604_790); expect(Number(raw.ttl)).toBeLessThan(604_810)
    expect(raw.accepted_session_id).toBeNull()
    expect(JSON.stringify((await db.query('select diff from audit_log where entity_id=$1', [invitation.id])).rows)).not.toContain(invitation.token)
    expect(await preserved(f)).toEqual(before)
    const another = await db.tx(c => inviteStaff(c, { ...scope(f), role: 'worker' }))
    expect(another.token).not.toBe(invitation.token)
    await expect(operational(f, randomUUID())).rejects.toMatchObject({ statusCode: 404 })
  })
  it.each(['worker', 'outsider', 'couple', 'helper', 'coordinator'] as const)('only the actual vendor owner invites, not %s', async who => {
    const f = await fixture()
    await expect(db.tx(c => inviteStaff(c, { ...scope(f, f[who]), role: 'worker' }))).rejects.toMatchObject({ statusCode: 403 })
    expect((await db.query('select id from vendor_staff_members where vendor_id=$1', [f.vendorId])).rowCount).toBe(0)
  })
  it('requires a live target, distinct owner and supported member role', async () => {
    const f = await fixture()
    for (const targetUserId of [f.owner.userId, randomUUID()]) await expect(invite(f, 'worker', targetUserId)).rejects.toMatchObject({ statusCode: 422 })
    await expect(db.tx(c => inviteStaff(c, { ...scope(f), role: 'boss' as StaffRole }))).rejects.toMatchObject({ statusCode: 422 })
    await db.query('update users set deleted_at=now() where id=$1', [f.worker.userId])
    await expect(invite(f)).rejects.toMatchObject({ statusCode: 422 })
  })
  it('targeted acceptance requires the target; open acceptance binds one actual person and preserves the stored receipt on retry', async () => {
    const f = await fixture(), invitation = await invite(f)
    await expect(db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.outsider }))).rejects.toMatchObject({ statusCode: 410 })
    const first = await db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker }))
    expect(first).toMatchObject({ userId: f.worker.userId, state: 'active', version: '2' })
    const raw = (await db.query('select accepted_session_id,accepted_at from vendor_staff_members where id=$1', [first.id])).rows[0]!, n = await auditCount(first.id)
    expect(raw.accepted_session_id).toBe(f.worker.sessionId)
    const newSession = randomUUID()
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [newSession, f.worker.userId, randomUUID()])
    expect(await db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: { ...f.worker, sessionId: newSession } }))).toEqual(first)
    expect((await db.query('select accepted_session_id,accepted_at from vendor_staff_members where id=$1', [first.id])).rows[0]).toEqual(raw)
    expect(await auditCount(first.id)).toBe(n)
    await expect(db.tx(c => declineStaffInvite(c, { token: invitation.token, actor: f.worker }))).rejects.toMatchObject({ statusCode: 410 })
    const open = await db.tx(c => inviteStaff(c, { ...scope(f), role: 'resource_manager' }))
    await expect(db.tx(c => acceptStaffInvite(c, { token: open.token, actor: f.owner }))).rejects.toMatchObject({ statusCode: 403 })
    const accepted = await db.tx(c => acceptStaffInvite(c, { token: open.token, actor: f.outsider }))
    expect(accepted).toMatchObject({ userId: f.outsider.userId, role: 'resource_manager', state: 'active' })
    await expect(db.tx(c => acceptStaffInvite(c, { token: open.token, actor: f.couple }))).rejects.toMatchObject({ statusCode: 410 })
  })
  it('does not duplicate current memberships when a person uses another open invite', async () => {
    const f = await fixture(); await active(f)
    await expect(invite(f)).rejects.toMatchObject({ code: 'staff_member_exists' })
    const open = await db.tx(c => inviteStaff(c, { ...scope(f), role: 'worker' }))
    await expect(db.tx(c => acceptStaffInvite(c, { token: open.token, actor: f.worker }))).rejects.toMatchObject({ code: 'staff_member_exists' })
    expect((await db.query('select state from vendor_staff_members where id=$1', [open.id])).rows[0]?.state).toBe('invited')
  })
  it('explicit decline is bound to the actual caller, retries are noops and cannot turn into acceptance', async () => {
    const f = await fixture(), invitation = await db.tx(c => inviteStaff(c, { ...scope(f), role: 'worker' }))
    const first = await db.tx(c => declineStaffInvite(c, { token: invitation.token, actor: f.worker })), n = await auditCount(first.id)
    expect(first).toMatchObject({ state: 'declined', userId: f.worker.userId, acceptedAt: null, version: '2' })
    expect(await db.tx(c => declineStaffInvite(c, { token: invitation.token, actor: f.worker }))).toEqual(first)
    expect(await auditCount(first.id)).toBe(n)
    expect((await db.query('select accepted_session_id from vendor_staff_members where id=$1', [first.id])).rows[0]?.accepted_session_id).toBeNull()
    for (const actor of [f.worker, f.outsider]) await expect(db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor }))).rejects.toMatchObject({ statusCode: 410 })
    await expect(db.tx(c => declineStaffInvite(c, { token: invitation.token, actor: f.outsider }))).rejects.toMatchObject({ statusCode: 410 })
  })
  it('expired or revoked invitation never accepts; accepted membership does not inherit a seven-day employment limit', async () => {
    const f = await fixture(), invitation = await invite(f)
    await db.query("update vendor_staff_members set invite_expires_at=clock_timestamp()-interval '1 second' where id=$1", [invitation.id])
    for (const fn of [acceptStaffInvite, declineStaffInvite]) await expect(db.tx(c => fn(c, { token: invitation.token, actor: f.worker }))).rejects.toMatchObject({ statusCode: 410 })
    const revoked = await db.tx(c => revokeStaff(c, { ...scope(f), memberId: invitation.id, expectedVersion: '1' }))
    await expect(db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker }))).rejects.toMatchObject({ statusCode: 410 })
    const { invitation: next, membership } = await active(f)
    await db.query("update vendor_staff_members set invite_expires_at=clock_timestamp()-interval '8 days' where id=$1", [next.id])
    expect((await db.tx(c => lockStaffMember(c, scope(f, f.worker)))).id).toBe(membership.id)
    expect(revoked.revokedAt).not.toBeNull()
  })
  it.each(['session', 'wrong_session', 'consent', 'policy', 'account'] as const)('rechecks current %s on acceptance and accepted replay', async what => {
    const f = await fixture(), { invitation, membership } = await active(f)
    let caller = f.worker
    if (what === 'session') await db.query('update sessions set revoked_at=now() where id=$1', [caller.sessionId])
    if (what === 'wrong_session') caller = { ...caller, sessionId: f.outsider.sessionId }
    if (what === 'consent') await db.query('update consents set withdrawn_at=now() where id=$1', [caller.consentId])
    if (what === 'policy') caller = { ...caller, policyVersion: 'not-current' }
    if (what === 'account') await db.query('update users set deleted_at=now() where id=$1', [caller.userId])
    await expect(db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: caller }))).rejects.toMatchObject({ statusCode: ['consent', 'policy'].includes(what) ? 403 : 401 })
    expect((await db.query('select version::text from vendor_staff_members where id=$1', [membership.id])).rows[0]?.version).toBe('2')
  })
  it.each(['session', 'wrong_session', 'consent', 'policy', 'account'] as const)('refuses first acceptance with invalid actual %s and stores no receipt', async what => {
    const f = await fixture(), invitation = await invite(f)
    let caller = f.worker
    if (what === 'session') await db.query('update sessions set revoked_at=now() where id=$1', [caller.sessionId])
    if (what === 'wrong_session') caller = { ...caller, sessionId: f.outsider.sessionId }
    if (what === 'consent') await db.query('update consents set withdrawn_at=now() where id=$1', [caller.consentId])
    if (what === 'policy') caller = { ...caller, policyVersion: 'not-current' }
    if (what === 'account') await db.query('update users set deleted_at=now() where id=$1', [caller.userId])
    await expect(db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: caller }))).rejects.toMatchObject({ statusCode: ['consent', 'policy'].includes(what) ? 403 : 401 })
    expect((await db.query('select state,accepted_at,accepted_session_id,version::text from vendor_staff_members where id=$1', [invitation.id])).rows[0]).toEqual({ state: 'invited', accepted_at: null, accepted_session_id: null, version: '1' })
  })
  it.each(['invited', 'active', 'declined'] as const)('erasing a %s recipient cannot transfer their token to another human', async state => {
    const f = await fixture(), invitation = await invite(f)
    if (state === 'active') await db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker }))
    if (state === 'declined') await db.tx(c => declineStaffInvite(c, { token: invitation.token, actor: f.worker }))
    await db.query('delete from users where id=$1', [f.worker.userId])
    const row = (await db.query('select user_id,invite_target_user_id,invite_binding_known,state from vendor_staff_members where id=$1', [invitation.id])).rows[0]!
    expect(row).toEqual({ user_id: null, invite_target_user_id: f.worker.userId, invite_binding_known: true, state })
    for (const fn of [acceptStaffInvite, declineStaffInvite]) await expect(db.tx(c => fn(c, { token: invitation.token, actor: f.outsider }))).rejects.toMatchObject({ statusCode: 410 })
  })
  it('unknown inherited invitation binding fails closed and targeting cannot be rewritten', async () => {
    const f = await fixture(), token = randomUUID().replaceAll('-', '') + 'abcdefghijk', id = randomUUID()
    // Synthetic legacy unaccepted invitation, not an accepted employee fixture.
    await db.query("insert into vendor_staff_members(id,vendor_id,invite_token_hash,invite_expires_at,invited_by) values($1,$2,$3,clock_timestamp()+interval '1 day',$4)", [id, f.vendorId, createHash('sha256').update(token).digest('hex'), f.owner.userId])
    for (const fn of [acceptStaffInvite, declineStaffInvite]) await expect(db.tx(c => fn(c, { token, actor: f.worker }))).rejects.toMatchObject({ statusCode: 410 })
    const invitation = await invite(f)
    await expect(db.query('update vendor_staff_members set invite_target_user_id=$2 where id=$1', [invitation.id, f.outsider.userId])).rejects.toMatchObject({ code: '23514' })
    await expect(db.query('update vendor_staff_members set invite_binding_known=false where id=$1', [invitation.id])).rejects.toMatchObject({ code: '23514' })
    expect((await db.query('select state,accepted_at from vendor_staff_members where id=$1', [id])).rows[0]).toEqual({ state: 'invited', accepted_at: null })
  })
  it('company ownership is checked now, not remembered from invitation creation', async () => {
    const f = await fixture(), { membership } = await active(f), duty = await createDuty(f, membership.id)
    await db.query('update vendors set user_id=$2 where id=$1', [f.vendorId, f.outsider.userId])
    for (const fn of [revokeStaff, updateStaffRole]) await expect(db.tx(c => fn(c, { ...scope(f), memberId: membership.id, expectedVersion: '2', role: 'resource_manager' }))).rejects.toMatchObject({ statusCode: 403 })
    expect((await db.tx(c => listStaff(c, scope(f, f.outsider)))).map(m => m.id)).toContain(membership.id)
    expect((await operational(f, duty.id)).id).toBe(duty.id)
    await db.tx(c => revokeStaff(c, { ...scope(f, f.outsider), memberId: membership.id, expectedVersion: '2' }))
    await expect(operational(f, duty.id)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('owner lists narrow history; an accepted worker lists only themselves and other wedding roles cannot see the crew', async () => {
    const f = await fixture(), { membership } = await active(f)
    await invite(f, 'worker', f.outsider.userId)
    const ownerList = await db.tx(c => listStaff(c, scope(f)))
    expect(ownerList).toHaveLength(2)
    const mine = await db.tx(c => listStaff(c, scope(f, f.worker)))
    expect(mine).toEqual([membership])
    for (const row of ownerList) expect(Object.keys(row).sort()).toEqual(['id', 'vendorId', 'userId', 'role', 'state', 'version', 'expiresAt', 'acceptedAt', 'revokedAt'].sort())
    for (const person of [f.outsider, f.couple, f.helper, f.coordinator]) await expect(db.tx(c => listStaff(c, scope(f, person)))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('role change has exact versions/noops, preserves acceptance and duties, and revokes manager resource access immediately', async () => {
    const f = await fixture(), { membership } = await active(f, 'resource_manager'), duty = await createDuty(f, membership.id), before = await preserved(f)
    await db.tx(c => lockResourceScope(c, scope(f, f.worker)))
    await expect(db.tx(c => updateStaffRole(c, { ...scope(f, f.worker), memberId: membership.id, expectedVersion: '2', role: 'worker' }))).rejects.toMatchObject({ statusCode: 403 })
    const changed = await db.tx(c => updateStaffRole(c, { ...scope(f), memberId: membership.id, expectedVersion: '2', role: 'worker' })), n = await auditCount(membership.id)
    expect(changed).toMatchObject({ role: 'worker', version: '3', acceptedAt: membership.acceptedAt })
    expect(await db.tx(c => updateStaffRole(c, { ...scope(f), memberId: membership.id, expectedVersion: '3', role: 'worker' }))).toEqual(changed)
    expect(await auditCount(membership.id)).toBe(n)
    await expect(db.tx(c => updateStaffRole(c, { ...scope(f), memberId: membership.id, expectedVersion: '2', role: 'resource_manager' }))).rejects.toMatchObject({ code: 'staff_version_conflict' })
    await expect(db.tx(c => lockResourceScope(c, scope(f, f.worker)))).rejects.toMatchObject({ statusCode: 403 })
    await expect(db.tx(c => lockStaffMember(c, { ...scope(f, f.worker), requiredRole: 'resource_manager' }))).rejects.toMatchObject({ statusCode: 403 })
    expect((await operational(f, duty.id)).memberRole).toBe('worker')
    expect(await preserved(f)).toEqual(before)
  })
  it('membership revocation is versioned, retry is a noop and keeps actual duties/acceptance/history/money', async () => {
    const f = await fixture(), { invitation, membership } = await active(f), duty = await createDuty(f, membership.id), before = await preserved(f)
    const revoked = await db.tx(c => revokeStaff(c, { ...scope(f), memberId: membership.id, expectedVersion: '2' })), n = await auditCount(membership.id)
    expect(revoked).toMatchObject({ state: 'revoked', version: '3', acceptedAt: membership.acceptedAt })
    expect(await db.tx(c => revokeStaff(c, { ...scope(f), memberId: membership.id, expectedVersion: '3' }))).toEqual(revoked)
    expect(await auditCount(membership.id)).toBe(n)
    await expect(db.tx(c => revokeStaff(c, { ...scope(f), memberId: membership.id, expectedVersion: '2' }))).rejects.toMatchObject({ code: 'staff_version_conflict' })
    await expect(operational(f, duty.id)).rejects.toMatchObject({ statusCode: 403 })
    await expect(db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker }))).rejects.toMatchObject({ statusCode: 410 })
    expect((await db.query('select revoked_at from vendor_staff_duties where id=$1', [duty.id])).rows[0]?.revoked_at).toBeNull()
    expect(await preserved(f)).toEqual(before)
  })
  it('pending membership has no operational access or assignable duty; role cannot be changed into implicit acceptance', async () => {
    const f = await fixture(), invitation = await invite(f)
    await expect(createDuty(f, invitation.id)).rejects.toMatchObject({ statusCode: 403 })
    await expect(db.tx(c => lockStaffMember(c, scope(f, f.worker)))).rejects.toMatchObject({ statusCode: 403 })
    await expect(db.tx(c => updateStaffRole(c, { ...scope(f), memberId: invitation.id, expectedVersion: '1', role: 'resource_manager' }))).rejects.toMatchObject({ statusCode: 403 })
    expect((await db.query('select state from vendor_staff_members where id=$1', [invitation.id])).rows[0]?.state).toBe('invited')
  })
  it('projects only the assigned actual event, including its genuinely unknown time zone, and grants no private-order authority', async () => {
    const f = await fixture(), { membership } = await active(f, 'resource_manager')
    const duty = await db.tx(c => createStaffDuty(c, { ...workScope(f), memberId: membership.id, programEventId: f.secondEvent, role: 'delivery', label: 'Deliver frames' }))
    const result = await db.tx(c => lockStaffDuty(c, { ...workScope(f, f.worker), dutyId: duty.id, programEventId: f.secondEvent }))
    expect(result.event).toEqual({ name: 'Second day', date: '2027-06-15', timeZone: null, location: 'Other actual venue' })
    expect(Object.keys(result).sort()).toEqual([...Object.keys(duty), 'event', 'memberRole'].sort())
    await expect(db.tx(c => lockOrderContext(c, f.weddingId, f.dealId, f.worker))).rejects.toMatchObject({ statusCode: 404 })
    // Transport shape only; existing production program ACL executes actual PG.
    // Membership does not turn the worker into the owner for program read/ack.
    const caller: Caller = { userId: f.worker.userId, sessionId: f.worker.sessionId }
    const request = { caller } as FastifyRequest
    for (const write of [false, true]) await expect(db.tx(c => lockVendorProgramAccess(c, request, f.weddingId, write, f.vendorId))).rejects.toMatchObject({ statusCode: 404 })
    await expect(db.tx(c => createStaffDuty(c, { ...workScope(f, f.worker), memberId: membership.id, programEventId: f.main, role: 'performer', label: 'Unauthorized assignment' }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(operational(f, duty.id)).rejects.toMatchObject({ statusCode: 404 })
    for (const outsider of [f.owner, f.outsider, f.couple, f.helper, f.coordinator]) await expect(db.tx(c => lockStaffDuty(c, { ...workScope(f, outsider), dutyId: duty.id, programEventId: f.secondEvent }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('checks exact company/order/event/member and assignment event instead of relying on a deferred FK', async () => {
    const f = await fixture(), other = await fixture(), { membership } = await active(f), otherMember = await active(other)
    const order = await db.tx(c => createOrderAssignment(c, { weddingId: f.weddingId, dealId: f.dealId, actor: f.couple, expectedVersion: '1', slotId: f.slotId, programEventId: f.main, label: 'Actual ceremony position' }))
    const assignmentId = order.assignments[0]!.id
    for (const patch of [{ memberId: otherMember.membership.id }, { programEventId: other.main }, { assignmentId: randomUUID() }, { programEventId: f.secondEvent, assignmentId }, { dealId: other.dealId }]) {
      await expect(db.tx(c => createStaffDuty(c, { ...workScope(f), memberId: membership.id, programEventId: f.main, role: 'performer', label: 'Scope test', ...patch }))).rejects.toMatchObject({ statusCode: ('assignmentId' in patch || 'programEventId' in patch) ? 422 : 404 })
    }
    const duty = await db.tx(c => createStaffDuty(c, { ...workScope(f), memberId: membership.id, programEventId: f.main, assignmentId, role: 'performer', label: 'Attached assignment' }))
    expect((await operational(f, duty.id)).assignmentId).toBe(assignmentId)
    await db.query('update order_assignments set cancelled_at=now() where id=$1', [assignmentId])
    await expect(operational(f, duty.id)).rejects.toMatchObject({ statusCode: 422 })
    await expect(db.tx(c => createStaffDuty(c, { ...workScope(f), memberId: membership.id, programEventId: f.main, assignmentId, role: 'backup', label: 'Cancelled position' }))).rejects.toMatchObject({ statusCode: 422 })
  })
  it('validates human duty label/role and duplicate live duties without touching finance', async () => {
    const f = await fixture(), { membership } = await active(f), before = await preserved(f)
    for (const patch of [{ label: '' }, { label: 'x'.repeat(201) }, { label: 'Bad\u0000label' }, { role: 'finance' as StaffDutyRole }]) await expect(db.tx(c => createStaffDuty(c, { ...workScope(f), memberId: membership.id, programEventId: f.main, role: 'performer', label: 'Normal', ...patch }))).rejects.toMatchObject({ statusCode: 422 })
    await createDuty(f, membership.id)
    await expect(createDuty(f, membership.id)).rejects.toMatchObject({ code: 'staff_duty_exists' })
    await createDuty(f, membership.id, 'backup')
    expect(await preserved(f)).toEqual(before)
  })
  it('duty cancellation uses the exact child version, has a real noop and does not erase the assignment or membership', async () => {
    const f = await fixture(), { membership } = await active(f), duty = await createDuty(f, membership.id), before = await preserved(f)
    await expect(db.tx(c => revokeStaffDuty(c, { ...workScope(f, f.worker), dutyId: duty.id, expectedVersion: '1' }))).rejects.toMatchObject({ statusCode: 403 })
    const cancelled = await db.tx(c => revokeStaffDuty(c, { ...workScope(f), dutyId: duty.id, expectedVersion: '1' })), n = await auditCount(duty.id)
    expect(cancelled.version).toBe('2'); expect(cancelled.revokedAt).not.toBeNull()
    expect(await db.tx(c => revokeStaffDuty(c, { ...workScope(f), dutyId: duty.id, expectedVersion: '2' }))).toEqual(cancelled)
    expect(await auditCount(duty.id)).toBe(n)
    await expect(db.tx(c => revokeStaffDuty(c, { ...workScope(f), dutyId: duty.id, expectedVersion: '1' }))).rejects.toMatchObject({ code: 'staff_version_conflict' })
    await expect(operational(f, duty.id)).rejects.toMatchObject({ statusCode: 404 })
    expect((await db.tx(c => lockStaffMember(c, scope(f, f.worker)))).id).toBe(membership.id)
    expect(await preserved(f)).toEqual(before)
  })
  it.each(['archived', 'cancelled', 'deal_cancelled', 'blocked', 'owner_deleted', 'member_deleted'] as const)('actual %s stops operational work and new assignments', async state => {
    const f = await fixture(), { membership } = await active(f), duty = await createDuty(f, membership.id)
    if (state === 'archived') await db.query('update weddings set archived_at=now() where id=$1', [f.weddingId])
    if (state === 'cancelled') await db.query('update weddings set cancelled_at=now() where id=$1', [f.weddingId])
    if (state === 'deal_cancelled') await db.query("update deals set state='cancelled' where id=$1", [f.dealId])
    if (state === 'blocked') await db.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
    if (state === 'owner_deleted') await db.query('update users set deleted_at=now() where id=$1', [f.owner.userId])
    if (state === 'member_deleted') await db.query('update users set deleted_at=now() where id=$1', [f.worker.userId])
    await expect(operational(f, duty.id)).rejects.toMatchObject({ statusCode: state === 'member_deleted' ? 401 : 404 })
    await expect(createDuty(f, membership.id, 'backup')).rejects.toMatchObject({ statusCode: state === 'owner_deleted' ? 401 : state === 'member_deleted' ? 403 : 404 })
  })
  it('deleted staff identity stays historical but never becomes another user’s access', async () => {
    const f = await fixture(), { membership } = await active(f), duty = await createDuty(f, membership.id)
    await db.query('delete from users where id=$1', [f.worker.userId])
    const historical = (await db.query('select state,user_id,accepted_at,accepted_session_id from vendor_staff_members where id=$1', [membership.id])).rows[0]!
    expect(historical).toMatchObject({ state: 'active', user_id: null, accepted_session_id: null }); expect(historical.accepted_at).not.toBeNull()
    await expect(operational(f, duty.id)).rejects.toMatchObject({ statusCode: 401 })
    await expect(operational(f, duty.id, f.outsider)).rejects.toMatchObject({ statusCode: 403 })
    await expect(createDuty(f, membership.id, 'backup')).rejects.toMatchObject({ statusCode: 403 })
  })

  async function blockedWitness(f: Fixture, operation: (c: Queryable) => Promise<unknown>, mutate: (c: Queryable) => Promise<unknown>, status: number, lock: 'wedding' | 'vendor' = 'wedding') {
    const blocker = new pg.Client({ connectionString: DB! }); await blocker.connect()
    let operationPromise: Promise<unknown> | undefined
    try {
      await blocker.query('begin')
      await blocker.query(lock === 'wedding' ? 'select id from weddings where id=$1 for update' : 'select id from vendors where id=$1 for update', [lock === 'wedding' ? f.weddingId : f.vendorId])
      let publishPid!: (pid: number) => void
      const pidPromise = new Promise<number>(resolve => { publishPid = resolve })
      operationPromise = db.tx(async c => { const pid = (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid; publishPid(pid); return operation(c) })
      // Attach a rejection handler before releasing the blocker to avoid a stray rejected promise.
      const outcome = operationPromise.then(value => ({ value }), error => ({ error: error as { statusCode: number } }))
      const pid = await pidPromise, deadline = Date.now() + 2500
      let observed = false
      while (Date.now() < deadline) {
        const state = (await db.query<{ blocked: boolean }>("select wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0 as blocked from pg_stat_activity where pid=$1", [pid])).rows[0]
        if (state?.blocked) { observed = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(observed, 'Actual PostgreSQL wait must be observed before revocation').toBe(true)
      await mutate(blocker); await blocker.query('commit')
      expect(await outcome).toMatchObject({ error: { statusCode: status } })
    } finally {
      await blocker.query('rollback').catch(() => undefined)
      if (operationPromise) await operationPromise.catch(() => undefined)
      await blocker.end()
    }
  }
  it.each(['membership', 'duty', 'staff_account', 'owner_account', 'session', 'consent', 'company', 'deal', 'assignment'] as const)('a real wedding-lock wait rechecks %s revocation before revealing the task', async cause => {
    const f = await fixture(), { membership } = await active(f)
    let assignmentId: string | undefined
    if (cause === 'assignment') {
      const order = await db.tx(c => createOrderAssignment(c, { weddingId: f.weddingId, dealId: f.dealId, actor: f.couple, expectedVersion: '1', slotId: f.slotId, programEventId: f.main, label: 'Actual assignment' }))
      assignmentId = order.assignments[0]!.id
    }
    const duty = await db.tx(c => createStaffDuty(c, { ...workScope(f), memberId: membership.id, programEventId: f.main, ...(assignmentId ? { assignmentId } : {}), role: 'performer', label: 'Private operational task' }))
    await blockedWitness(f, c => lockStaffDuty(c, { ...workScope(f, f.worker), dutyId: duty.id, programEventId: f.main }), async c => {
      if (cause === 'membership') await revokeStaff(c, { ...scope(f), memberId: membership.id, expectedVersion: '2' })
      if (cause === 'duty') await revokeStaffDuty(c, { ...workScope(f), dutyId: duty.id, expectedVersion: '1' })
      if (cause === 'staff_account') await c.query('update users set deleted_at=now() where id=$1', [f.worker.userId])
      if (cause === 'owner_account') await c.query('update users set deleted_at=now() where id=$1', [f.owner.userId])
      if (cause === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.worker.sessionId])
      if (cause === 'consent') await c.query('update consents set withdrawn_at=now() where id=$1', [f.worker.consentId])
      if (cause === 'company') await c.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
      if (cause === 'deal') await c.query("update deals set state='cancelled' where id=$1", [f.dealId])
      if (cause === 'assignment') await c.query('update order_assignments set cancelled_at=now() where id=$1', [assignmentId!])
    }, cause === 'session' || cause === 'staff_account' ? 401 : cause === 'membership' || cause === 'consent' ? 403 : cause === 'assignment' ? 422 : 404)
  })
  it.each(['role', 'session', 'consent', 'membership'] as const)('a real company-lock wait checks fresh %s before manager access', async cause => {
    const f = await fixture(), { membership } = await active(f, 'resource_manager')
    await blockedWitness(f, c => lockStaffMember(c, { ...scope(f, f.worker), requiredRole: 'resource_manager' }), async c => {
      if (cause === 'role') await updateStaffRole(c, { ...scope(f), memberId: membership.id, expectedVersion: '2', role: 'worker' })
      if (cause === 'membership') await revokeStaff(c, { ...scope(f), memberId: membership.id, expectedVersion: '2' })
      if (cause === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.worker.sessionId])
      if (cause === 'consent') await c.query('update consents set withdrawn_at=now() where id=$1', [f.worker.consentId])
    }, cause === 'session' ? 401 : 403, 'vendor')
  })
  it('company-lock waiting acceptance uses the expiry after the wait and never stores a late receipt', async () => {
    const f = await fixture(), invitation = await invite(f)
    await blockedWitness(f, c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker }), c => c.query("update vendor_staff_members set invite_expires_at=clock_timestamp()-interval '1 second' where id=$1", [invitation.id]), 410, 'vendor')
    expect((await db.query('select state,accepted_at,accepted_session_id,version::text from vendor_staff_members where id=$1', [invitation.id])).rows[0]).toEqual({ state: 'invited', accepted_at: null, accepted_session_id: null, version: '1' })
  })
  it.each(['session', 'consent'] as const)('owner %s revocation during company wait blocks a write and even its noop replay', async cause => {
    const f = await fixture(), { membership } = await active(f)
    await blockedWitness(f, c => updateStaffRole(c, { ...scope(f), memberId: membership.id, expectedVersion: '2', role: 'worker' }),
      c => cause === 'session' ? c.query('update sessions set revoked_at=now() where id=$1', [f.owner.sessionId]) : c.query('update consents set withdrawn_at=now() where id=$1', [f.owner.consentId]), cause === 'session' ? 401 : 403, 'vendor')
    expect((await db.query('select role,version::text from vendor_staff_members where id=$1', [membership.id])).rows[0]).toEqual({ role: 'worker', version: '2' })
  })
  it('owner change during company wait fails closed instead of locking the newly found account in reverse order', async () => {
    const f = await fixture(); await active(f, 'resource_manager')
    await blockedWitness(f, c => lockStaffMember(c, { ...scope(f, f.worker), requiredRole: 'resource_manager' }),
      c => c.query('update vendors set user_id=$2 where id=$1', [f.vendorId, f.outsider.userId]), 409, 'vendor')
    expect((await db.tx(c => listStaff(c, scope(f, f.outsider)))).map(m => m.userId)).toContain(f.worker.userId)
  })
  it('rejects malformed tokens, IDs and versions without changing membership or acceptance', async () => {
    const f = await fixture(), { invitation, membership } = await active(f), n = await auditCount(membership.id)
    for (const token of ['', 'x'.repeat(10000), 'contains/invalidchars', 'A'.repeat(43)]) await expect(db.tx(c => acceptStaffInvite(c, { token, actor: f.worker }))).rejects.toMatchObject({ statusCode: 410 })
    for (const expectedVersion of ['0', '-1', '1.0', '', '2'.repeat(20)]) await expect(db.tx(c => revokeStaff(c, { ...scope(f), memberId: membership.id, expectedVersion }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(db.tx(c => revokeStaff(c, { ...scope(f), memberId: 'bad-id', expectedVersion: '2' }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(db.tx(c => lockStaffMember(c, { ...scope(f, f.worker), requiredRole: 'boss' as StaffRole }))).rejects.toMatchObject({ statusCode: 422 })
    expect(await db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker }))).toEqual(membership)
    expect(await auditCount(membership.id)).toBe(n)
  })
  async function failAudit(id: string, action: string, execute: () => Promise<unknown>) {
    const suffix = randomUUID().replaceAll('-', ''), fn = 'staff_audit_' + suffix, trigger = 'staff_audit_' + suffix
    assert.match(id, /^[0-9a-f-]{36}$/); assert.match(action, /^vendor\.staff\.[a-z_]+$/)
    try {
      await db.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
        if NEW.entity_id='${id}'::uuid and NEW.action='${action}' then raise exception 'Synthetic scoped staff audit witness' using errcode='23514'; end if; return NEW; end $$`)
      await db.query(`create trigger ${trigger} before insert on audit_log for each row execute function ${fn}()`)
      await expect(execute()).rejects.toMatchObject({ code: '23514' })
    } finally {
      await db.query(`drop trigger if exists ${trigger} on audit_log`)
      await db.query(`drop function if exists ${fn}()`)
    }
  }
  it('audit failure atomically rolls back explicit acceptance, version and stored session receipt', async () => {
    const f = await fixture(), invitation = await invite(f), before = (await db.query('select * from vendor_staff_members where id=$1', [invitation.id])).rows[0], finance = await preserved(f), n = await auditCount(invitation.id)
    await failAudit(invitation.id, 'vendor.staff.accepted', () => db.tx(c => acceptStaffInvite(c, { token: invitation.token, actor: f.worker })))
    expect((await db.query('select * from vendor_staff_members where id=$1', [invitation.id])).rows[0]).toEqual(before)
    expect(await auditCount(invitation.id)).toBe(n); expect(await preserved(f)).toEqual(finance)
  })
  it('audit failure atomically rolls back duty cancellation and membership role change', async () => {
    const f = await fixture(), { membership } = await active(f), duty = await createDuty(f, membership.id), finance = await preserved(f), n = await auditCount(duty.id)
    await failAudit(duty.id, 'vendor.staff.duty_revoked', () => db.tx(c => revokeStaffDuty(c, { ...workScope(f), dutyId: duty.id, expectedVersion: '1' })))
    expect((await operational(f, duty.id)).version).toBe('1'); expect(await auditCount(duty.id)).toBe(n)
    await failAudit(membership.id, 'vendor.staff.role_changed', () => db.tx(c => updateStaffRole(c, { ...scope(f), memberId: membership.id, expectedVersion: '2', role: 'resource_manager' })))
    expect(await db.tx(c => lockStaffMember(c, scope(f, f.worker)))).toEqual(membership)
    expect(await preserved(f)).toEqual(finance)
  })
  it('audit failure rolls back membership revocation and explicit decline without leaving a phantom decision', async () => {
    const f = await fixture(), { membership } = await active(f), duty = await createDuty(f, membership.id), finance = await preserved(f), n = await auditCount(membership.id)
    await failAudit(membership.id, 'vendor.staff.revoked', () => db.tx(c => revokeStaff(c, { ...scope(f), memberId: membership.id, expectedVersion: '2' })))
    expect(await db.tx(c => lockStaffMember(c, scope(f, f.worker)))).toEqual(membership)
    expect((await operational(f, duty.id)).version).toBe('1'); expect(await auditCount(membership.id)).toBe(n)
    const invitation = await invite(f, 'worker', f.outsider.userId)
    await failAudit(invitation.id, 'vendor.staff.declined', () => db.tx(c => declineStaffInvite(c, { token: invitation.token, actor: f.outsider })))
    expect((await db.query('select state,accepted_at,version::text from vendor_staff_members where id=$1', [invitation.id])).rows[0]).toEqual({ state: 'invited', accepted_at: null, version: '1' })
    expect(await preserved(f)).toEqual(finance)
  })
})
