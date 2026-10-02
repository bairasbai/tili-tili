import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { OrderDto } from '../src/orders/model.js'
import type { ResourcePlanView } from '../src/orders/resource-plan.js'
import type { TermsView } from '../src/orders/terms.js'

const DB = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'resource-plan-http-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
interface Actor { id: string; session: string; headers: { authorization: string } }
describe.skipIf(!DB)('registered private resource plan HTTP and real terms acceptance', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = [], resources: string[] = [], vendors: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_resource_plan_20260930_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'resource-plan-http-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address as string)); assert.equal(live.port, Number(disposablePgPort())); assert.equal(live.name, target.pathname.slice(1))
  })
  afterAll(async () => {
    if (!app) return
    try {
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      await app.db!.query('delete from vendor_resources where id=any($1::uuid[])', [resources])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function actor(): Promise<Actor> {
    const id = randomUUID(), session = randomUUID(); users.push(id)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic plan HTTP actor')", [id, '+79' + randomInt(100_000_000, 999_999_999)])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, session, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  async function fixture() {
    const pair = await actor(), owner = await actor(), helper = await actor(), coordinator = await actor(), manager = await actor(), stranger = await actor()
    const wedding = randomUUID(), deal = randomUUID(), slot = randomUUID(), vendor = randomUUID(); weddings.push(wedding); vendors.push(vendor)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Plan HTTP','2027-06-14','Europe/Moscow',$3)", [wedding, pair.id, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper'),($1,$4,'coordinator')", [wedding, pair.id, helper.id, coordinator.id])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic plan studio',now())", [vendor, owner.id])
    // Synthetic accepted history exercises guards; it is not evidence of a human invitation acceptance.
    await app.db!.query(`insert into vendor_staff_members(id,vendor_id,user_id,state,role,invite_token_hash,invite_expires_at,invited_by,accepted_at,accepted_session_id)
      values($1,$2,$3,'active','resource_manager',$4,now()+interval '1 day',$5,now(),$6)`,
    [randomUUID(), vendor, manager.id, createHash('sha256').update(randomUUID()).digest('hex'), owner.id, manager.session])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photographer')", [slot, wedding])
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'booked',9007199254740993)", [deal, wedding, slot, vendor])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slot, deal])
    await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2)", [vendor, deal])
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',12345,'recorded','cash','private')", [randomUUID(), deal])
    const root = `/deals/${deal}/order`, path = `${root}/resource-plan`
    const part = await app.inject({ method: 'POST', url: `${root}/parts`, headers: { ...owner.headers, 'idempotency-key': randomUUID() },
      payload: { expectedVersion: '1', kind: 'deliverable', title: 'Gallery processing', assignmentId: null, details: { dueAt: '2027-07-01T10:00:00Z' } } })
    expect(part.statusCode, part.body).toBe(200)
    const partId = part.json<OrderDto>().parts[0]!.id
    const resource = await app.inject({ method: 'POST', url: `/vendors/${vendor}/resources`, headers: { ...owner.headers, 'idempotency-key': randomUUID() },
      payload: { kind: 'equipment', label: 'Private chosen editing station' } })
    expect(resource.statusCode, resource.body).toBe(200)
    const resourceId = resource.json<{ id: string }>().id; resources.push(resourceId)
    const line = { partId, resourceId, capacityWindowId: null, quantity: 1, startsAt: '2027-06-15T07:00:00Z', endsAt: '2027-06-15T10:00:00Z',
      timeZone: 'Europe/Moscow', setupMinutes: 10, teardownMinutes: 20, travelBeforeMinutes: 0, travelAfterMinutes: 0 }
    const body = { expectedVersion: '2', expectedPlanRevision: '0', lines: [line] }
    return { pair, owner, helper, coordinator, manager, stranger, wedding, deal, vendor, resourceId, root, path, body }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const read = (f: Fixture, user = f.pair) => app.inject({ url: f.path, headers: user.headers })
  const save = (f: Fixture, user = f.owner, key: string | null = randomUUID(), payload: object = f.body) =>
    app.inject({ method: 'PATCH', url: f.path, headers: { ...user.headers, ...(key === null ? {} : { 'idempotency-key': key }) }, payload })
  const view = (r: { statusCode: number; body: string; json<T>(): T }): ResourcePlanView => { expect(r.statusCode, r.body).toBe(200); return r.json<ResourcePlanView>() }
  async function business(f: Fixture) {
    return (await app.db!.query(`select (select to_jsonb(d) from deals d where id=$1) deal,
      (select jsonb_agg(to_jsonb(p) order by id) from payments p where deal_id=$1) payments,
      (select jsonb_agg(to_jsonb(b) order by date) from vendor_busy_dates b where vendor_id=$2) dates,
      (select jsonb_agg(to_jsonb(r) order by id) from vendor_resources r where vendor_id=$2) resources,
      (select jsonb_agg(to_jsonb(w) order by w.id) from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id where r.vendor_id=$2) windows,
      (select jsonb_agg(to_jsonb(e) order by e.id) from wedding_events e where wedding_id=$3) events`, [f.deal, f.vendor, f.wedding])).rows[0]
  }
  it('requires explicit ownership while safe pair reads stay private and no-store', async () => {
    const f = await fixture(), before = await business(f)
    const empty = view(await read(f)); expect(empty).toMatchObject({ canEdit: false, editorLines: null, revision: '0', current: null, reservation: 'not_reserved' })
    const saved = view(await save(f)); expect(saved).toMatchObject({ orderVersion: '3', revision: '1', canEdit: true, reservation: 'not_reserved' })
    const pair = await read(f), publicView = view(pair); expect(pair.headers['cache-control']).toBe('no-store')
    expect(publicView.editorLines).toBeNull(); expect(pair.body).not.toContain(f.resourceId)
    for (const key of ['personUserId', 'staffMemberId', 'conflictIdentity', 'resourceId', 'capacityWindowId']) expect(pair.body).not.toContain(`"${key}"`)
    expect(publicView.current?.lines[0]).toMatchObject({ label: 'Private chosen editing station', occupiedStartsAt: '2027-06-15T06:50:00.000Z', occupiedEndsAt: '2027-06-15T10:20:00.000Z' })
    expect(await business(f)).toEqual(before)
    expect((await save(f, f.pair, randomUUID(), { ...f.body, expectedVersion: '3', expectedPlanRevision: '1' })).statusCode).toBe(403)
    for (const denied of [f.helper, f.coordinator, f.manager, f.stranger]) {
      const response = await read(f, denied); expect(response.statusCode, response.body).toBe(404); expect(response.body).not.toContain('Private chosen editing station')
      expect((await save(f, denied)).statusCode).toBe(404)
    }
  })
  it('same-key response-loss retry and a new-key no-op do not duplicate revisions or order version', async () => {
    const f = await fixture(), key = randomUUID(), before = await business(f), first = await save(f, f.owner, key), replay = await save(f, f.owner, key)
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toEqual(first.json())
    const saved = view(first), noOp = view(await save(f, f.owner, randomUUID(), { ...f.body, expectedVersion: saved.orderVersion, expectedPlanRevision: saved.revision }))
    expect(noOp.current?.planRevisionId).toBe(saved.current?.planRevisionId); expect(noOp.orderVersion).toBe('3')
    expect((await app.db!.query('select count(*)::text n from deal_resource_plan_versions where deal_id=$1', [f.deal])).rows[0]?.n).toBe('1')
    expect((await save(f, f.owner, key, { ...f.body, lines: [] })).statusCode).toBe(409)
    expect(await business(f)).toEqual(before)
  })
  it.each(['missing', 'oversize'] as const)('rejects %s idempotency before changing plan state', async kind => {
    const f = await fixture(), response = await save(f, f.owner, kind === 'missing' ? null : 'x'.repeat(201))
    expect(response.statusCode, response.body).toBe(400); expect(view(await read(f)).revision).toBe('0')
  })
  it('does not replay a successful private response after the owner loses current consent', async () => {
    const f = await fixture(), key = randomUUID(); view(await save(f, f.owner, key))
    await app.db!.query('update consents set withdrawn_at=now() where user_id=$1 and policy_version=$2', [f.owner.id, POLICY])
    const reply = await save(f, f.owner, key); expect(reply.statusCode, reply.body).toBe(403); expect(reply.body).not.toContain(f.resourceId)
    expect(view(await read(f)).revision).toBe('1')
  })
  it('current couple membership cannot replay former company-owner editor data after ownership changes', async () => {
    const f = await fixture(), key = randomUUID()
    // Synthetic dual role and historical ownership change exercise current ACL;
    // they do not claim a production company-transfer workflow.
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.wedding, f.owner.id])
    view(await save(f, f.owner, key))
    await app.db!.query('update vendors set user_id=$2 where id=$1', [f.vendor, f.stranger.id])
    const readAsPair = await read(f, f.owner)
    expect(view(readAsPair)).toMatchObject({ canEdit: false, editorLines: null })
    expect(readAsPair.body).not.toContain(f.resourceId)
    const cached = await save(f, f.owner, key)
    expect(cached.statusCode, cached.body).toBe(403); expect(cached.body).not.toContain(f.resourceId)
    expect(view(await read(f)).revision).toBe('1')
  })
  it.each(['resource', 'window', 'part', 'extra', 'quantity', 'timezone', 'missingBuffer'] as const)('validates %s input through the actual contract and domain', async bad => {
    const f = await fixture(), line: Record<string, unknown> = { ...f.body.lines[0] }
    if (bad === 'resource') line.resourceId = randomUUID()
    if (bad === 'window') line.capacityWindowId = randomUUID()
    if (bad === 'part') line.partId = randomUUID()
    if (bad === 'extra') line.personUserId = f.stranger.id
    if (bad === 'quantity') line.quantity = 1.5
    if (bad === 'timezone') line.timeZone = 'Made/Up'
    if (bad === 'missingBuffer') delete line.travelBeforeMinutes
    const reply = await save(f, f.owner, randomUUID(), { ...f.body, lines: [line] })
    expect(reply.statusCode, reply.body).toBe(422); expect(view(await read(f)).revision).toBe('0')
  })
  it('publishes exact schema2 and records two actual distinct HTTP parties without reserving resources', async () => {
    const f = await fixture(), before = await business(f), saved = view(await save(f))
    const proposal = await app.inject({ method: 'POST', url: `${f.root}/terms/proposals`, headers: { ...f.pair.headers, 'idempotency-key': randomUUID() },
      payload: { expectedOrderVersion: saved.orderVersion, expectedTermsRevision: '0' } })
    expect(proposal.statusCode, proposal.body).toBe(200)
    const proposed = proposal.json<TermsView>(); expect(proposed.readToken).toBeNull()
    expect(proposed.selected?.snapshot).toMatchObject({ schemaVersion: 2, resourcePlan: saved.current }); expect(proposed.selected?.receipts).toEqual([])
    for (const user of [f.pair, f.owner]) {
      const response = await app.inject({ url: `${f.root}/terms`, headers: user.headers }); expect(response.statusCode, response.body).toBe(200)
      const readView = response.json<TermsView>(); expect(readView.readToken).toBeTruthy()
      const receipt = await app.inject({ method: 'POST', url: `${f.root}/terms/${readView.selected!.id}/accept`, headers: { ...user.headers, 'idempotency-key': randomUUID() },
        payload: { expectedTermsVersion: readView.selected!.version, digest: readView.selected!.digest, readToken: readView.readToken } })
      expect(receipt.statusCode, receipt.body).toBe(200)
    }
    const accepted = (await app.inject({ url: `${f.root}/terms`, headers: f.pair.headers })).json<TermsView>()
    expect(accepted.agreedTermsId).toBe(proposed.selected?.id)
    expect(accepted.selected?.receipts.map(r => [r.party, r.userId]).sort()).toEqual([['customer', f.pair.id], ['performer', f.owner.id]])
    expect(await business(f)).toEqual(before)
  })
})
