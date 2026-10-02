import { createHash, randomInt, randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import { lockOrderWedding, type OrderActor } from '../src/orders/context.js'
import { patchOrderBrief, createOrderPart } from '../src/orders/model.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { canonicalTermsJson, publishOrderTerms, loadOrderTerms, acceptOrderTerms, type TermsView, type PublishTermsInput } from '../src/orders/terms.js'
import { signOrderTermsRead, verifyOrderTermsRead, TERMS_READ_TTL_SECONDS, type TermsReadClaims } from '../src/orders/terms-token.js'

const SECRET = 'test-order-terms-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const proof = { secret: SECRET }, fixed = new Date('2026-09-30T12:00:00Z')
const claims = (): TermsReadClaims => ({ purpose: 'order-terms-read', weddingId: randomUUID(), dealId: randomUUID(), termsId: randomUUID(), version: '1', digest: 'a'.repeat(64), userId: randomUUID(), sessionId: randomUUID(), policyVersion: '2026-09-02' })
describe('order terms canonical payload and scoped proof', () => {
  it('canonicalizes nested object keys while preserving arrays, null and exact money strings', () => {
    expect(canonicalTermsJson({ b: ['9007199254740993', null], a: { z: false, b: 'x' } })).toBe('{"a":{"b":"x","z":false},"b":["9007199254740993",null]}')
    expect(canonicalTermsJson({ z: 1, a: 2 })).toBe(canonicalTermsJson({ a: 2, z: 1 }))
    expect(() => canonicalTermsJson({ missing: undefined })).toThrow()
  })
  it('rejects sparse/cyclic/non-JSON source without executing accessors; repeated ordinary values remain valid', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const sparse = new Array<unknown>(2)
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('Accessor must not run') } })
    for (const invalid of [cyclic, sparse, accessor, { value: Infinity }, { value: 1n }, new Date()]) {
      expect(() => canonicalTermsJson(invalid)).toThrow(expect.objectContaining({ statusCode: 422 }))
    }
    const repeated = { value: 'same' }
    expect(canonicalTermsJson([repeated, repeated])).toBe('[{"value":"same"},{"value":"same"}]')
  })
  it('proof has exact purpose, subject/session/source and finite lifetime', async () => {
    const c = claims(), token = await signOrderTermsRead(SECRET, c, fixed)
    expect(await verifyOrderTermsRead(SECRET, token, fixed)).toMatchObject(c)
    await expect(verifyOrderTermsRead(SECRET, token, new Date(fixed.getTime() + (TERMS_READ_TTL_SECONDS + 1) * 1000))).rejects.toMatchObject({ code: 'terms_read_expired' })
    await expect(verifyOrderTermsRead(SECRET, token, new Date(fixed.getTime() - 1000))).rejects.toMatchObject({ statusCode: 422 })
  })
  it.each(['', 'tiny', 'x'.repeat(64)])('missing or weak secret refuses explicitly %#', async secret => {
    await expect(signOrderTermsRead(secret, claims(), fixed)).rejects.toMatchObject({ statusCode: 503 })
    await expect(verifyOrderTermsRead(secret, 'fake', fixed)).rejects.toMatchObject({ statusCode: 503 })
  })
  it('other purpose/header and unknown signing key cannot be treated as order proof', async () => {
    const c = claims()
    const wrongPurpose = await signOrderTermsRead(SECRET, { ...c, purpose: 'program-read' as TermsReadClaims['purpose'] }, fixed)
    await expect(verifyOrderTermsRead(SECRET, wrongPurpose, fixed)).rejects.toMatchObject({ statusCode: 422 })
    const wrongType = await new SignJWT(c as unknown as Record<string, unknown>).setProtectedHeader({ alg: 'HS256', typ: 'vendor-program-read' }).setIssuer('tili-tili').setAudience('order-terms-read')
      .setIssuedAt(fixed.getTime() / 1000).setExpirationTime(fixed.getTime() / 1000 + 600).sign(createHash('sha256').update(`tili-order-terms-read\n${SECRET}`).digest())
    await expect(verifyOrderTermsRead(SECRET, wrongType, fixed)).rejects.toMatchObject({ statusCode: 422 })
    await expect(verifyOrderTermsRead(SECRET + '-different', await signOrderTermsRead(SECRET, c, fixed), fixed)).rejects.toMatchObject({ statusCode: 422 })
  })
})

const DB = process.env.TEST_DATABASE_URL
describe.skipIf(!DB)('immutable terms with real published versions and actual domain acceptance', () => {
  let db: Db
  const users: string[] = [], weddings: string[] = []
  beforeAll(() => { db = createDb(DB!) })
  afterAll(async () => { for (const id of weddings) await db.query('delete from weddings where id=$1', [id]); for (const id of users) await db.query('delete from users where id=$1', [id]); await db.close() })
  async function actor(): Promise<OrderActor> {
    const userId = randomUUID(), sessionId = randomUUID(); users.push(userId)
    await db.query("insert into users(id,phone,name) values($1,$2,'Terms test')", [userId, '+79' + randomInt(100_000_000, 999_999_999)])
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await db.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(), userId])
    return { userId, sessionId, policyVersion: '2026-09-02' }
  }
  async function fixture(external = false) {
    const owner = await actor(), vendorOwner = await actor(), weddingId = randomUUID(), dealId = randomUUID(), slotId = randomUUID(), vendorId = randomUUID(), packageId = randomUUID(); weddings.push(weddingId)
    await db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Terms','2026-10-01','Europe/Moscow',$3)", [weddingId, owner.userId, randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    await db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Terms studio',now())", [vendorId, vendorOwner.userId])
    await db.query("insert into vendor_packages(id,vendor_id,name,price,items) values($1,$2,'Live catalog description',20000,'[\"Live item\"]')", [packageId, vendorId])
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photo')", [slotId, weddingId])
    await db.query("insert into deals(id,wedding_id,slot_id,vendor_id,external_name,state,price,package_id,package_title_snapshot,package_includes_snapshot) values($1,$2,$3,$4,$5,'booked',9007199254740993,$6,'Frozen agreed package',$7::jsonb)",
      [dealId, weddingId, slotId, external ? null : vendorId, external ? 'External contact' : null, external ? null : packageId, '["Frozen item"]'])
    await db.query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
    if (!external) await db.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2026-10-01','deal',$2)", [vendorId, dealId])
    await db.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',12000,'recorded','cash','private')", [randomUUID(), dealId])
    const main = (await db.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    // Synthetic inherited WP03 history is only a preservation fixture. It is not
    // a human read/acceptance claim and is never used to create a terms receipt.
    const version = (await db.query<{ timeline_version: string }>('select timeline_version::text from weddings where id=$1', [weddingId])).rows[0]!.timeline_version
    const historical = { syntheticInheritedFixture: true, sourceVersion: version, blocks: [] }
    const programDigest = createHash('sha256').update(JSON.stringify(historical)).digest('hex')
    if (!external) await db.query('insert into vendor_program_acknowledgments(wedding_id,vendor_id,user_id,session_id,version,digest,program_snapshot) values($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [weddingId, vendorId, vendorOwner.userId, vendorOwner.sessionId, version, programDigest, JSON.stringify(historical)])
    else {
      const inviteId = randomUUID()
      await db.query("insert into external_invites(token,wedding_id,slot_id,expires_at,program_identity,program_deal_id) values($1,$2,$3,clock_timestamp()+interval '1 day',$4,$5)", [randomUUID(), weddingId, slotId, inviteId, dealId])
      await db.query('update deals set current_program_invite_id=$2 where id=$1', [dealId, inviteId])
      await db.query('insert into external_program_acknowledgments(wedding_id,invite_id,deal_id,version,digest,program_snapshot) values($1,$2,$3,$4,$5,$6::jsonb)', [weddingId, inviteId, dealId, version, programDigest, JSON.stringify(historical)])
    }
    return { weddingId, dealId, slotId, vendorId, packageId, main, owner, vendorOwner }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const base = (w: Fixture, actor = w.owner) => ({ weddingId: w.weddingId, dealId: w.dealId, actor })
  const publish = (w: Fixture, patch: Partial<PublishTermsInput> = {}) => db.tx(c => publishOrderTerms(c, { ...base(w), expectedOrderVersion: '1', expectedTermsRevision: '0', ...patch }))
  const load = (w: Fixture, actor = w.owner, termsId?: string) => db.tx(c => loadOrderTerms(c, { ...base(w, actor), ...(termsId ? { termsId } : {}) }, proof))
  const accept = async (w: Fixture, actor = w.owner, view?: TermsView) => {
    const read = view ?? await load(w, actor), term = read.selected!
    return db.tx(c => acceptOrderTerms(c, { ...base(w, actor), termsId: term.id, expectedTermsVersion: term.version, digest: term.digest, readToken: read.readToken! }, proof))
  }
  async function ledger(w: Fixture) {
    return { deal: (await db.query('select state,price::text,currency,package_id,package_title_snapshot,package_includes_snapshot from deals where id=$1', [w.dealId])).rows,
      payments: (await db.query('select * from payments where deal_id=$1 order by id', [w.dealId])).rows,
      holds: (await db.query('select * from vendor_busy_dates where deal_id=$1', [w.dealId])).rows,
      program: (await db.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rows,
      externalProgram: (await db.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rows }
  }
  it('publishes actual immutable legacy facts with bigint string and no fabricated acceptance/work', async () => {
    const w = await fixture(), before = await ledger(w), view = await publish(w)
    expect(view).toMatchObject({ revision: '1', agreedTermsId: null, readToken: null, acceptedByCaller: false })
    expect(view.selected?.snapshot).toMatchObject({ source: 'legacy', sourceOrderVersion: '1', categoryId: 'photo', brief: null, assignments: [], parts: [], economics: { amount: '9007199254740993', amountKnown: true, package: { titleSnapshot: 'Frozen agreed package', includesSnapshot: ['Frozen item'] } } })
    expect(view.selected?.receipts).toEqual([])
    expect((await db.query('select version::text from deal_orders where deal_id=$1', [w.dealId])).rows[0]?.version).toBe('1')
    expect(await ledger(w)).toEqual(before)
    expect((await load(w)).readToken).toBeTypeOf('string')
    expect((await db.query('select count(*)::text n from deal_terms_receipts where deal_id=$1', [w.dealId])).rows[0]?.n).toBe('0')
  })
  it('unknown price/package remains null and live catalog edits do not rewrite the frozen deal snapshot', async () => {
    const w = await fixture()
    await db.query('update deals set price=null,package_title_snapshot=null,package_includes_snapshot=null where id=$1', [w.dealId])
    const first = await publish(w)
    expect(first.selected?.snapshot).toMatchObject({ economics: { amount: null, amountKnown: false, package: { titleSnapshot: null, includesSnapshot: null } } })
    await db.query("update vendor_packages set name='New catalog',price=88000,items='[\"New item\"]' where id=$1", [w.packageId])
    expect((await load(w)).selected?.freshness).toBe('current')
    expect((await publish(w, { expectedTermsRevision: '1' })).revision).toBe('1')
  })
  it('same current content is no-op, exact revision protects simultaneous publication', async () => {
    const w = await fixture(), result = await Promise.allSettled([publish(w), publish(w)])
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(result.find(r => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } })
    const view = await load(w), again = await publish(w, { expectedTermsRevision: '1' })
    expect(again.selected?.id).toBe(view.selected?.id); expect(again.revision).toBe('1')
    expect((await db.query("select count(*)::text n from audit_log where entity_id=$1 and action='order.terms_published'", [w.dealId])).rows[0]?.n).toBe('1')
  })
  it('both real eligible sides accept the exact version; repeated action retains original receipt and author/time', async () => {
    const w = await fixture(), before = await ledger(w); await publish(w)
    const first = await accept(w)
    expect(first).toMatchObject({ agreedTermsId: null, acceptedByCaller: true, readToken: null })
    const again = await accept(w)
    expect(again.selected?.receipts).toEqual(first.selected?.receipts)
    const both = await accept(w, w.vendorOwner)
    expect(both.agreedTermsId).toBe(both.proposedTermsId)
    expect(both.selected?.receipts.map(r => r.party).sort()).toEqual(['customer', 'performer'])
    expect(await ledger(w)).toEqual(before)
  })
  it('a different partner does not become the author of the existing customer acceptance', async () => {
    const w = await fixture(), partner = await actor(); await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [w.weddingId, partner.userId])
    await publish(w); const accepted = await accept(w)
    const other = await accept(w, partner)
    expect(other.acceptedByCaller).toBe(false); expect(other.selected?.receipts).toEqual(accepted.selected?.receipts)
  })
  it('new proposed version keeps old agreed snapshot/receipts without inheriting their consent', async () => {
    const w = await fixture(); await publish(w); await accept(w); const agreed = await accept(w, w.vendorOwner), oldId = agreed.agreedTermsId!
    await db.tx(c => patchOrderBrief(c, { ...base(w), expectedVersion: '1', brief: { values: {} } }))
    const next = await publish(w, { expectedOrderVersion: '2', expectedTermsRevision: '1' })
    expect(next.agreedTermsId).toBe(oldId); expect(next.proposedTermsId).not.toBe(oldId); expect(next.selected?.receipts).toEqual([])
    expect(next.history.find(t => t.id === oldId)?.receipts).toHaveLength(2)
    expect((await load(w, w.owner, oldId)).readToken).toBeNull()
  })
  it.each(['draft', 'price', 'package_snapshot', 'event_date', 'event_zone', 'event_location', 'performer_identity'] as const)('%s source change invalidates prior proof without copying consent', async change => {
    const w = await fixture(); await publish(w); const read = await load(w)
    if (change === 'draft') await db.tx(c => patchOrderBrief(c, { ...base(w), expectedVersion: '1', brief: { values: {} } }))
    if (change === 'price') await db.query('update deals set price=45000 where id=$1', [w.dealId])
    if (change === 'package_snapshot') await db.query("update deals set package_title_snapshot='New terms' where id=$1", [w.dealId])
    if (change === 'event_date') await db.query("update weddings set date='2026-10-03' where id=$1", [w.weddingId])
    if (change === 'event_zone') await db.query("update weddings set tz='Asia/Yekaterinburg' where id=$1", [w.weddingId])
    if (change === 'event_location') await db.query("update weddings set venue='New hall' where id=$1", [w.weddingId])
    if (change === 'performer_identity') await db.query("update vendors set name='Changed studio name' where id=$1", [w.vendorId])
    const fresh = await load(w)
    expect(fresh.selected?.freshness).toBe('stale'); expect(fresh.readToken).toBeNull()
    await expect(accept(w, w.owner, read)).rejects.toMatchObject({ code: 'terms_source_changed' })
    expect(fresh.selected?.receipts).toEqual([])
  })
  it('payment and deal state changes do not masquerade as changed material conditions', async () => {
    const w = await fixture(); await publish(w)
    await db.query("update deals set state='paid_deposit' where id=$1", [w.dealId])
    await db.query("insert into payments(id,deal_id,kind,amount,status) values($1,$2,'balance',3000,'recorded')", [randomUUID(), w.dealId])
    expect((await load(w)).selected?.freshness).toBe('current')
    expect((await accept(w)).acceptedByCaller).toBe(true)
  })
  it('persisted active parts/brief are revalidated and invalid source cannot publish', async () => {
    const w = await fixture(), assigned = await db.tx(c => createOrderAssignment(c, { ...base(w), expectedVersion: '1', slotId: w.slotId, programEventId: w.main, label: 'Photography' }))
    const parts = await db.tx(c => createOrderPart(c, { ...base(w), expectedVersion: assigned.version, assignmentId: assigned.assignments[0]!.id, kind: 'timed_service', title: 'Shoot', details: {} }))
    const valid = await publish(w, { expectedOrderVersion: parts.version })
    expect(valid.selected?.snapshot).toMatchObject({ parts: [{ kind: 'timed_service', details: { startsAt: null, endsAt: null } }] })
    await db.query("update order_parts set details='{\"dueAt\":\"2026-10-01T10:00:00Z\"}' where deal_id=$1", [w.dealId])
    await expect(publish(w, { expectedOrderVersion: parts.version, expectedTermsRevision: '1' })).rejects.toMatchObject({ statusCode: 422 })
    await db.query("update order_parts set details='{}' where deal_id=$1", [w.dealId])
    await db.query("update deal_orders set brief_category_id='photo',brief='{\"madeUp\":true}' where deal_id=$1", [w.dealId])
    await expect(publish(w, { expectedOrderVersion: parts.version, expectedTermsRevision: '1' })).rejects.toMatchObject({ statusCode: 422 })
  })
  it('fingerprint includes active child versions and secondary canonical event facts even if root version is unchanged', async () => {
    const w = await fixture(), event = randomUUID()
    await db.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Second','second_day','2026-10-02','Europe/Moscow',false)", [event, w.weddingId])
    const assignment = await db.tx(c => createOrderAssignment(c, { ...base(w), expectedVersion: '1', slotId: w.slotId, programEventId: event, label: 'Second day' }))
    const parts = await db.tx(c => createOrderPart(c, { ...base(w), expectedVersion: assignment.version, assignmentId: assignment.assignments[0]!.id, kind: 'supply', title: 'Delivery', details: { quantity: 2, unit: 'sets' } }))
    await publish(w, { expectedOrderVersion: parts.version }); const read = await load(w)
    await db.query('update order_parts set version=version+1 where deal_id=$1', [w.dealId])
    expect((await load(w)).selected?.freshness).toBe('stale')
    await expect(accept(w, w.owner, read)).rejects.toMatchObject({ code: 'terms_source_changed' })
    await publish(w, { expectedOrderVersion: parts.version, expectedTermsRevision: '1' })
    await db.query("update wedding_events set location='Another hall' where id=$1", [event])
    expect((await load(w)).selected?.freshness).toBe('stale')
  })
  it('same-party concurrent acceptance preserves exactly one actual receipt', async () => {
    const w = await fixture(); await publish(w); const read = await load(w)
    const results = await Promise.all([accept(w, w.owner, read), accept(w, w.owner, read)])
    expect(results[0]?.selected?.receipts).toEqual(results[1]?.selected?.receipts)
    expect((await load(w)).selected?.receipts).toHaveLength(1)
  })
  it('registered vendor owner may publish; empty/weak proof configuration rejects load/accept without granting receipts', async () => {
    const w = await fixture(), view = await publish(w, { actor: w.vendorOwner })
    expect(view.selected).toMatchObject({ publishedBy: w.vendorOwner.userId, publishedSide: 'performer' })
    await expect(db.tx(c => loadOrderTerms(c, base(w), { secret: '' }))).rejects.toMatchObject({ statusCode: 503 })
    const read = await load(w)
    await expect(db.tx(c => acceptOrderTerms(c, { ...base(w), termsId: read.selected!.id, expectedTermsVersion: '1', digest: read.selected!.digest, readToken: read.readToken! }, { secret: 'short' }))).rejects.toMatchObject({ statusCode: 503 })
    expect((await load(w)).selected?.receipts).toEqual([])
  })
  it('blocked performer makes customer proposal unavailable and gives no new read proof', async () => {
    const w = await fixture(); await publish(w); const read = await load(w)
    await db.query('update vendors set blocked_at=now() where id=$1', [w.vendorId])
    const current = await load(w)
    expect(current.selected?.freshness).toBe('unavailable'); expect(current.readToken).toBeNull()
    await expect(accept(w, w.owner, read)).rejects.toMatchObject({ code: 'terms_source_changed' })
    await expect(publish(w, { expectedTermsRevision: '1' })).rejects.toMatchObject({ code: 'terms_performer_unavailable' })
  })
  it('malformed current draft does not bypass current helper/foreign ACL for history', async () => {
    const w = await fixture(); await publish(w)
    await db.query("update deal_orders set brief_category_id='photo',brief='{\"unknownField\":true}' where deal_id=$1", [w.dealId])
    await db.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [w.weddingId, w.owner.userId])
    await expect(load(w)).rejects.toMatchObject({ statusCode: 404 })
  })
  it.each(['userId', 'sessionId', 'weddingId', 'dealId', 'termsId', 'version', 'digest', 'policyVersion'] as const)('server-signed proof with wrong %s is rejected', async key => {
    const w = await fixture(); await publish(w); const read = await load(w), term = read.selected!, clock = (await db.query<{ now: Date }>('select clock_timestamp() now')).rows[0]!.now
    const original = await verifyOrderTermsRead(SECRET, read.readToken!, clock)
    const value = key === 'version' ? '2' : key === 'digest' ? 'b'.repeat(64) : key === 'policyVersion' ? 'other-policy' : randomUUID()
    const fake = await signOrderTermsRead(SECRET, { ...original, [key]: value }, clock)
    await expect(db.tx(c => acceptOrderTerms(c, { ...base(w), termsId: term.id, expectedTermsVersion: term.version, digest: term.digest, readToken: fake }, proof))).rejects.toMatchObject({ statusCode: 422 })
    expect((await db.query('select count(*)::text n from deal_terms_receipts where deal_id=$1', [w.dealId])).rows[0]?.n).toBe('0')
  })
  it('expired proof, altered body digest/version and superseded proposal cannot accept', async () => {
    const w = await fixture(); await publish(w); const read = await load(w), term = read.selected!, clock = (await db.query<{ now: Date }>('select clock_timestamp() now')).rows[0]!.now
    const original = await verifyOrderTermsRead(SECRET, read.readToken!, clock), expired = await signOrderTermsRead(SECRET, original, new Date(clock.getTime() - 601_000))
    await expect(accept(w, w.owner, { ...read, readToken: expired })).rejects.toMatchObject({ code: 'terms_read_expired' })
    await expect(db.tx(c => acceptOrderTerms(c, { ...base(w), termsId: term.id, expectedTermsVersion: '2', digest: term.digest, readToken: read.readToken! }, proof))).rejects.toMatchObject({ statusCode: 409 })
    await expect(db.tx(c => acceptOrderTerms(c, { ...base(w), termsId: term.id, expectedTermsVersion: '1', digest: '0'.repeat(64), readToken: read.readToken! }, proof))).rejects.toMatchObject({ statusCode: 422 })
    await db.tx(c => patchOrderBrief(c, { ...base(w), expectedVersion: '1', brief: { values: {} } }))
    await publish(w, { expectedOrderVersion: '2', expectedTermsRevision: '1' })
    await expect(accept(w, w.owner, read)).rejects.toMatchObject({ code: 'terms_superseded' })
  })
  it('actual concurrent acceptance from both sides produces exactly two receipts and one agreed version', async () => {
    const w = await fixture(); await publish(w); const customer = await load(w), performer = await load(w, w.vendorOwner)
    const results = await Promise.allSettled([accept(w, w.owner, customer), accept(w, w.vendorOwner, performer)])
    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
    const final = await load(w)
    expect(final.agreedTermsId).toBe(final.proposedTermsId); expect(final.selected?.receipts).toHaveLength(2)
  })
  it('external draft preserves contact facts but never fabricates performer acceptance', async () => {
    const w = await fixture(true), before = await ledger(w), view = await publish(w)
    expect(view.selected?.snapshot).toMatchObject({ economics: { performer: { vendor: null, externalName: 'External contact' } } })
    expect((await accept(w)).agreedTermsId).toBeNull()
    await expect(load(w, w.vendorOwner)).rejects.toMatchObject({ statusCode: 404 })
    expect((await load(w)).selected?.receipts.map(r => r.party)).toEqual(['customer'])
    expect(before.externalProgram).toHaveLength(1); expect(await ledger(w)).toEqual(before)
  })
  it('invalid current draft leaves immutable agreement/history readable but issues no proof and cannot accept', async () => {
    const w = await fixture(); await publish(w); await accept(w); const agreement = await accept(w, w.vendorOwner), original = agreement.selected!
    await db.query("update deal_orders set brief_category_id='photo',brief='{\"unknownField\":true}' where deal_id=$1", [w.dealId])
    const read = await load(w)
    expect(read.readToken).toBeNull(); expect(read.agreedTermsId).toBe(original.id)
    expect(read.selected).toMatchObject({ id: original.id, digest: original.digest, snapshot: original.snapshot, receipts: original.receipts, freshness: 'invalid' })
    await expect(publish(w, { expectedTermsRevision: '1' })).rejects.toMatchObject({ statusCode: 422 })
    await expect(accept(w, w.owner, { ...agreement, readToken: 'not-a-proof' })).rejects.toMatchObject({ statusCode: 422 })
  })
  it('missing source, foreign reader and unaccepted invitation cannot publish or receive proof', async () => {
    const w = await fixture(), other = await fixture()
    await expect(load(w, other.owner)).rejects.toMatchObject({ statusCode: 404 })
    await db.query("insert into invites(code,wedding_id,role,created_by,expires_at) values($1,$2,'couple',$3,now()+interval '1 day')", [randomUUID(), w.weddingId, w.owner.userId])
    await expect(load(w, other.owner)).rejects.toMatchObject({ statusCode: 404 })
    await db.query('delete from deal_orders where deal_id=$1', [w.dealId])
    await expect(publish(w)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('audit failure atomically rolls back publication and acceptance independently', async () => {
    const w = await fixture()
    const failAudit = (c: Queryable): Queryable => ({ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (/insert into audit_log/.test(sql)) return Promise.reject(new Error('Controlled audit failure'))
      return c.query<T>(sql, values)
    } })
    await expect(db.tx(c => publishOrderTerms(failAudit(c), { ...base(w), expectedOrderVersion: '1', expectedTermsRevision: '0' }))).rejects.toThrow('Controlled audit failure')
    expect((await load(w)).history).toHaveLength(0)
    await publish(w); const read = await load(w), term = read.selected!
    await expect(db.tx(c => acceptOrderTerms(failAudit(c), { ...base(w), termsId: term.id, expectedTermsVersion: term.version, digest: term.digest, readToken: read.readToken! }, proof))).rejects.toThrow('Controlled audit failure')
    expect((await load(w)).selected?.receipts).toHaveLength(0)
  })
  it('database protects immutable payload/receipts and exact receipt digest scope', async () => {
    const w = await fixture(); await publish(w); const accepted = await accept(w), term = accepted.selected!, receipt = term.receipts[0]!
    await expect(db.query('update deal_terms_versions set digest=$2 where id=$1', [term.id, '0'.repeat(64)])).rejects.toMatchObject({ code: '23514' })
    await expect(db.query('delete from deal_terms_versions where id=$1', [term.id])).rejects.toMatchObject({ code: '23514' })
    await expect(db.query('update deal_terms_receipts set accepted_at=now() where id=$1', [receipt.id])).rejects.toMatchObject({ code: '23514' })
    await expect(db.query('update deal_terms_receipts set user_id=null where id=$1', [receipt.id])).rejects.toMatchObject({ code: '23514' })
    await expect(db.query('insert into deal_terms_receipts(id,wedding_id,deal_id,terms_id,party,user_id,session_id,digest) values($1,$2,$3,$4,\'performer\',$5,$6,$7)', [randomUUID(), w.weddingId, w.dealId, term.id, w.vendorOwner.userId, w.vendorOwner.sessionId, 'b'.repeat(64)])).rejects.toMatchObject({ code: '23503' })
  })
  it('real session/user deletion clears only FK attribution while retaining immutable content and accepted time', async () => {
    const w = await fixture(), partner = await actor()
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [w.weddingId, partner.userId])
    await publish(w, { actor: partner }); const accepted = await accept(w, partner), term = accepted.selected!, receipt = term.receipts[0]!
    await db.query('delete from sessions where id=$1', [partner.sessionId])
    expect((await load(w)).selected?.receipts[0]).toMatchObject({ userId: partner.userId, sessionId: null, acceptedAt: receipt.acceptedAt })
    await db.query('delete from users where id=$1', [partner.userId])
    const remaining = (await load(w)).selected!
    expect(remaining).toMatchObject({ publishedBy: null, digest: term.digest, snapshot: term.snapshot })
    expect(remaining.receipts[0]).toMatchObject({ userId: null, sessionId: null, acceptedAt: receipt.acceptedAt })
  })
  it('whole wedding erase cascades published terms and real receipts without manual cleanup', async () => {
    const w = await fixture(); await publish(w); await accept(w); await accept(w, w.vendorOwner)
    await db.query('delete from weddings where id=$1', [w.weddingId])
    for (const table of ['deal_terms_versions', 'deal_terms_receipts', 'deal_orders']) expect((await db.query(`select count(*)::text n from ${table} where wedding_id=$1`, [w.weddingId])).rows[0]?.n).toBe('0')
  })
  it.each(['member_removed', 'session_revoked', 'consent_withdrawn', 'user_deleted', 'vendor_blocked', 'wedding_cancelled', 'deal_cancelled'] as const)('rechecks %s after the real wedding lock before accepting', async action => {
    const w = await fixture(); await publish(w); const acceptingActor = action === 'vendor_blocked' ? w.vendorOwner : w.owner, read = await load(w, acceptingActor)
    let locked!: () => void, attempted!: () => void
    const hasLock = new Promise<void>(r => { locked = r }), hasAttempt = new Promise<void>(r => { attempted = r })
    const holder = db.tx(async c => {
      await lockOrderWedding(c, w.weddingId); locked(); await hasAttempt
      if (action === 'member_removed') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.owner.userId])
      if (action === 'session_revoked') await c.query('update sessions set revoked_at=now() where id=$1', [w.owner.sessionId])
      if (action === 'consent_withdrawn') await c.query('update consents set withdrawn_at=now() where user_id=$1', [w.owner.userId])
      if (action === 'user_deleted') await c.query('update users set deleted_at=now() where id=$1', [w.owner.userId])
      if (action === 'vendor_blocked') await c.query('update vendors set blocked_at=now() where id=$1', [w.vendorId])
      if (action === 'wedding_cancelled') await c.query('update weddings set cancelled_at=now() where id=$1', [w.weddingId])
      if (action === 'deal_cancelled') await c.query("update deals set state='cancelled' where id=$1", [w.dealId])
    })
    await hasLock
    const waiting = db.tx(c => {
      const observed: Queryable = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
        const result = c.query<T>(sql, values); if (/from weddings/.test(sql)) attempted(); return result
      } }
      return acceptOrderTerms(observed, { ...base(w, acceptingActor), termsId: read.selected!.id, expectedTermsVersion: read.selected!.version, digest: read.selected!.digest, readToken: read.readToken! }, proof)
    })
    const outcome = expect(waiting).rejects.toMatchObject({ statusCode: action === 'session_revoked' || action === 'user_deleted' ? 401 : action === 'consent_withdrawn' || action === 'deal_cancelled' ? 403 : 404 })
    await holder; await outcome
    expect((await db.query('select count(*)::text n from deal_terms_receipts where deal_id=$1', [w.dealId])).rows[0]?.n).toBe('0')
  })
})
