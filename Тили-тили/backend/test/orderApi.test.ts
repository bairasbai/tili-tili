import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import type { OrderDto } from '../src/orders/model.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'order-api-test-only-'.repeat(3)
const POLICY = '2026-09-02'
interface Actor { id: string; session: string; consent: string; headers: { authorization: string } }
type Method = 'POST' | 'PATCH'
describe.skipIf(!DB)('order HTTP contract, current access and transactional replay', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB, 'Do not mix application and test databases')
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort())
    assert.match(decodeURIComponent(target.pathname.slice(1)), /^tili_ecosystem_[a-z][a-z0-9_]{0,25}_20260930_test$/)
    assert.equal(target.search, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'order-api-refresh-test-only-'.repeat(3), policyVersion: POLICY })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) as address,inet_server_port() as port,current_database() as name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address as string))
    assert.equal(live.port, Number(disposablePgPort()))
    assert.equal(live.name, decodeURIComponent(target.pathname.slice(1)))
  })
  afterAll(async () => {
    if (!app) return
    try {
      // Append-only audit rows intentionally survive fixture cleanup; never
      // disable their database guard just to erase synthetic test evidence.
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function actor(label: string): Promise<Actor> {
    const session = randomUUID(), consent = randomUUID()
    let id: string | undefined
    // Synthetic auth fixtures exercise real guards. These rows are not proof
    // that a real human agreed to a contract, program or privacy policy.
    for (let attempt = 0; attempt < 8; attempt++) {
      id = (await app.db!.query<{ id: string }>('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id', [randomUUID(), '+79' + randomInt(100_000_000, 999_999_999), `Synthetic order API ${label}`])).rows[0]?.id
      if (id) break
    }
    if (!id) throw new Error(`Synthetic order API fixture could not allocate a unique phone after 8 attempts (${label})`)
    users.push(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consent, id, POLICY])
    return { id, session, consent, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  async function fixture() {
    const owner = await actor('couple'), vendorOwner = await actor('vendor'), helper = await actor('helper'), coordinator = await actor('coordinator'), outsider = await actor('outsider'), otherVendorOwner = await actor('other vendor')
    const wedding = randomUUID(), vendor = randomUUID(), otherVendor = randomUUID(), slot = randomUUID(), deal = randomUUID(), secondEvent = randomUUID(); weddings.push(wedding)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code,budget_total) values($1,$2,'Synthetic HTTP order','2027-06-14','Europe/Moscow',$3,99000000)", [wedding, owner.id, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper'),($1,$4,'coordinator')", [wedding, owner.id, helper.id, coordinator.id])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic studio',now()),($3,$4,'photo','Other synthetic studio',now())", [vendor, vendorOwner.id, otherVendor, otherVendorOwner.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photographer')", [slot, wedding])
    await app.db!.query(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,package_title_snapshot,package_includes_snapshot)
      values($1,$2,$3,$4,'booked',15000000,'Legacy photographed package','["Full day","Gallery"]')`, [deal, wedding, slot, vendor])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slot, deal])
    await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2)", [vendor, deal])
    await app.db!.query(`insert into payments(id,deal_id,kind,amount,payment_method,visibility,paid_on) values
      ($1,$3,'deposit',2500000,'bank_transfer','private','2026-09-29'),($2,$3,'refund',500000,'bank_transfer','private','2026-09-30')`, [randomUUID(), randomUUID(), deal])
    await app.db!.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Day two','second_day','2027-06-15','Europe/Moscow',false)", [secondEvent, wedding])
    const main = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [wedding])).rows[0]!.id
    return { wedding, vendor, otherVendor, slot, deal, secondEvent, main, owner, vendorOwner, helper, coordinator, outsider, otherVendorOwner, path: `/deals/${deal}/order` }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const read = (f: Fixture, user = f.owner) => app.inject({ url: f.path, headers: user.headers })
  const write = (f: Fixture, user: Actor, method: Method, suffix: string, payload: object, key: string | null = randomUUID()) =>
    app.inject({ method, url: `${f.path}${suffix}`, headers: { ...user.headers, ...(key === null ? {} : { 'idempotency-key': key }) }, payload })
  const brief = (f: Fixture, version = '1', values: object = { photographer: 'Private named photographer' }, user = f.owner, key: string | null = randomUUID()) =>
    write(f, user, 'PATCH', '/brief', { expectedVersion: version, brief: { values } }, key)
  async function assignment(f: Fixture, version = '1', slotId = f.slot, eventId = f.main) {
    const result = await write(f, f.owner, 'POST', '/assignments', { expectedVersion: version, slotId, programEventId: eventId, label: 'Ceremony work' })
    expect(result.statusCode, result.body).toBe(200); return result.json<OrderDto>()
  }
  async function part(f: Fixture, version = '1', title = 'Private gallery') {
    const result = await write(f, f.owner, 'POST', '/parts', { expectedVersion: version, kind: 'deliverable', title, details: { items: ['Gallery'], dueAt: '2027-07-01T12:00:00Z' } })
    expect(result.statusCode, result.body).toBe(200); return result.json<OrderDto>()
  }
  async function state(f: Fixture) {
    return (await app.db!.query(`select to_jsonb(o) as root,
      (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from order_parts p where p.deal_id=$1) as parts,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from order_assignments a where a.deal_id=$1) as assignments,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from audit_log a where a.entity_id=$1) as audit,
      (select coalesce(jsonb_agg(to_jsonb(k) order by k.key),'[]') from idempotency_keys k where k.user_id=any($2::uuid[])) as keys
      from deal_orders o where o.deal_id=$1`, [f.deal, [f.owner.id, f.vendorOwner.id]])).rows[0]
  }
  async function financial(f: Fixture) {
    return (await app.db!.query(`select (select jsonb_agg(to_jsonb(d) order by d.id) from deals d where d.wedding_id=$1) as deals,
      (select jsonb_agg(to_jsonb(p) order by p.id) from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1) as payments,
      (select jsonb_agg(to_jsonb(b) order by b.date) from vendor_busy_dates b where b.vendor_id=$2) as busy`, [f.wedding, f.vendor])).rows[0]
  }
  const expectDenied = (reply: { statusCode: number; body: string }, status: number) => {
    expect(reply.statusCode, reply.body).toBe(status)
    expect(reply.body).not.toContain('Private named photographer')
    expect(reply.body).not.toContain('Private gallery')
  }

  it('GET exposes actual legacy metadata with ETag to couple and exact vendor owner without inventing work or acceptance', async () => {
    const f = await fixture(), before = await financial(f)
    for (const user of [f.owner, f.vendorOwner]) {
      const result = await read(f, user)
      expect(result.statusCode, result.body).toBe(200); expect(result.headers.etag).toBe('"1"')
      expect(result.json()).toEqual({ dealId: f.deal, version: '1', schemaVersion: 1, source: 'legacy', brief: null, assignments: [], parts: [] })
    }
    expect(await financial(f)).toEqual(before)
    expect((await app.db!.query('select 1 from documents where deal_id=$1', [f.deal])).rowCount).toBe(0)
    expect((await app.db!.query('select 1 from vendor_program_acknowledgments where wedding_id=$1', [f.wedding])).rowCount).toBe(0)
  })

  it.each(['helper', 'coordinator', 'outsider', 'otherVendorOwner'] as const)('%s cannot read or mutate private order drafts', async role => {
    const f = await fixture(), before = await state(f)
    expectDenied(await read(f, f[role]), 404)
    expectDenied(await brief(f, '1', {}, f[role]), 404)
    expect(await state(f)).toEqual(before)
  })

  it.each(['helper', 'coordinator', 'outsider', 'otherVendorOwner'] as const)('%s cannot bypass access through a child or assignment endpoint', async role => {
    const f = await fixture(), assigned = await assignment(f), created = await part(f, assigned.version)
    const p = created.parts[0]!, a = created.assignments[0]!, before = await state(f)
    const attempts: [Method, string, object][] = [
      ['POST', '/parts', { expectedVersion: created.version, kind: 'deliverable', title: 'Forbidden', details: {} }],
      ['PATCH', `/parts/${p.id}`, { expectedVersion: created.version, expectedPartVersion: p.version, title: 'Forbidden' }],
      ['POST', `/parts/${p.id}/cancel`, { expectedVersion: created.version, expectedPartVersion: p.version }],
      ['POST', '/assignments', { expectedVersion: created.version, slotId: f.slot, programEventId: f.secondEvent, label: 'Forbidden' }],
      ['POST', `/assignments/${a.id}/cancel`, { expectedVersion: created.version, expectedAssignmentVersion: a.version }],
    ]
    for (const [method, suffix, payload] of attempts) expectDenied(await write(f, f[role], method, suffix, payload), 404)
    expect(await state(f)).toEqual(before)
  })

  it('catalog follows the actual deal category and current party without granting assignment authority or inventing work', async () => {
    const f = await fixture(), finance = await financial(f), before = await state(f)
    for (const [user, actorRole] of [[f.owner, 'couple'], [f.vendorOwner, 'vendor']] as const) {
      const response = await app.inject({ url: `${f.path}/catalog`, headers: user.headers })
      expect(response.statusCode, response.body).toBe(200)
      const metadata = response.json()
      expect(metadata).toMatchObject({ weddingId: f.wedding, primarySlotId: f.slot, actorRole,
        timeZone: 'Europe/Moscow', assignmentTimeZones: [],
        category: { categoryId: 'photo', autoAssign: false, suggestedKinds: ['timed_service', 'deliverable'] } })
      expect(metadata.eligiblePositions).toEqual(actorRole === 'couple' ? [{ slotId: f.slot, programEventId: null, isPrimary: true, label: 'Photographer' }] : [])
      expect(metadata.category.fields.some((field: { key: string }) => field.key === 'deliveryDate')).toBe(true)
      expect(metadata.executionKinds).toEqual(['timed_service', 'supply', 'rental', 'deliverable', 'appointment'])
    }
    for (const user of [f.helper, f.coordinator, f.outsider, f.otherVendorOwner]) {
      expectDenied(await app.inject({ url: `${f.path}/catalog`, headers: user.headers }), 404)
    }
    expect((await app.inject({ url: `${f.path}/catalog` })).statusCode).toBe(401)
    await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendor])
    expectDenied(await app.inject({ url: `${f.path}/catalog`, headers: f.vendorOwner.headers }), 404)
    expect(await financial(f)).toEqual(finance); expect(await state(f)).toEqual(before)
  })

  it('flower shop and installation expose different applicable fields from the server while the old draft stays unknown', async () => {
    const f = await fixture()
    await app.db!.query("update slots set category_id='florist' where id=$1", [f.slot])
    const result = await app.inject({ url: `${f.path}/catalog`, headers: f.owner.headers })
    expect(result.statusCode, result.body).toBe(200)
    const category = result.json().category
    expect(category.categoryId).toBe('florist'); expect(category.autoAssign).toBe(false)
    const shop = category.subtypes.find((subtype: { id: string }) => subtype.id === 'shop')
    const installation = category.subtypes.find((subtype: { id: string }) => subtype.id === 'installation')
    expect(shop.suggestedKinds).toEqual(['supply'])
    expect(shop.fields.some((field: { key: string }) => field.key === 'deliveryPlace')).toBe(true)
    expect(shop.fields.some((field: { key: string }) => field.key === 'installationWindow')).toBe(false)
    expect(installation.suggestedKinds).toEqual(['timed_service', 'supply', 'rental'])
    expect(installation.fields.some((field: { key: string }) => field.key === 'installationWindow')).toBe(true)
    expect((await read(f)).json()).toMatchObject({ source: 'legacy', brief: null, assignments: [], parts: [] })
  })

  it('eligible positions come from exact event/category/financial scope and assigned clocks stay actual', async () => {
    const f = await fixture(), explicit = randomUUID(), legacy = randomUUID(), wrongCategory = randomUUID()
    await app.db!.query(`insert into slots(id,wedding_id,category_id,label,program_event_id) values
      ($1,$4,'photo','Day two position',$5),($2,$4,'photo','Unmapped legacy',null),($3,$4,'venue','Different service',$5)`, [explicit, legacy, wrongCategory, f.wedding, f.secondEvent])
    const assigned = await assignment(f, '1', explicit, f.secondEvent), assignmentId = assigned.assignments[0]!.id
    await app.db!.query('update wedding_events set time_zone=null where id=$1', [f.secondEvent])
    const customer = await app.inject({ url: `${f.path}/catalog`, headers: f.owner.headers })
    expect(customer.statusCode, customer.body).toBe(200)
    expect(customer.json().eligiblePositions).toEqual(expect.arrayContaining([
      { slotId: f.slot, programEventId: null, isPrimary: true, label: 'Photographer' },
      { slotId: explicit, programEventId: f.secondEvent, isPrimary: false, label: 'Day two position' },
    ]))
    expect(customer.json().eligiblePositions).toHaveLength(2)
    expect(customer.json().assignmentTimeZones).toEqual([{ assignmentId, programEventId: f.secondEvent, timeZone: null }])
    const performer = await app.inject({ url: `${f.path}/catalog`, headers: f.vendorOwner.headers })
    expect(performer.statusCode, performer.body).toBe(200)
    expect(performer.json().eligiblePositions).toEqual([])
    expect(performer.json().assignmentTimeZones).toEqual(customer.json().assignmentTimeZones)
  })

  it('requires actual authentication and a session belonging to the current user', async () => {
    const f = await fixture()
    expectDenied(await app.inject({ url: f.path }), 401)
    const wrongSession = await signAccessToken(SECRET, { sub: f.owner.id, sid: f.outsider.session })
    expectDenied(await app.inject({ url: f.path, headers: { authorization: `Bearer ${wrongSession}` } }), 401)
  })

  it('pending couple invitations confer no order access', async () => {
    const f = await fixture()
    await app.db!.query("insert into invites(code,wedding_id,role,created_by,expires_at) values($1,$2,'couple',$3,now()+interval '1 day')", [randomUUID(), f.wedding, f.owner.id])
    expectDenied(await read(f, f.outsider), 404)
  })

  it('vendor access follows exact current profile ownership and blocking', async () => {
    const f = await fixture()
    await app.db!.query('update vendors set user_id=$2 where id=$1', [f.vendor, f.outsider.id])
    expectDenied(await read(f, f.vendorOwner), 404)
    expect((await read(f, f.outsider)).statusCode).toBe(200)
    await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendor])
    expectDenied(await read(f, f.outsider), 404)
    expect((await read(f, f.owner)).statusCode).toBe(200)
  })

  it.each(['archived_at', 'cancelled_at'] as const)('%s wedding denies read and mutation without changing the order', async column => {
    const f = await fixture(), key = randomUUID()
    expect((await brief(f, '1', undefined, f.owner, key)).statusCode).toBe(200)
    await app.db!.query(`update weddings set ${column}=now() where id=$1`, [f.wedding])
    const before = await state(f)
    expectDenied(await read(f), 404); expectDenied(await brief(f), 404)
    expectDenied(await brief(f, '1', undefined, f.owner, key), 404)
    expect(await state(f)).toEqual(before)
  })

  it('cancelled deal remains historical but rejects draft execution and replay', async () => {
    const f = await fixture(), key = randomUUID()
    expect((await brief(f, '1', undefined, f.owner, key)).statusCode).toBe(200)
    await app.db!.query("update deals set state='cancelled',cancelled_at=now() where id=$1", [f.deal])
    const before = await state(f)
    expect((await read(f)).statusCode).toBe(200)
    expectDenied(await brief(f, '1', undefined, f.owner, key), 403)
    expect(await state(f)).toEqual(before)
  })

  it('brief writes and explicit clearing are typed private drafts, with finance and legacy holds unchanged', async () => {
    const f = await fixture(), before = await financial(f)
    const result = await brief(f)
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ version: '2', source: 'structured', brief: { categoryId: 'photo', values: { photographer: 'Private named photographer' } } })
    const cleared = await write(f, f.owner, 'PATCH', '/brief', { expectedVersion: '2', brief: null })
    expect(cleared.statusCode, cleared.body).toBe(200); expect(cleared.json()).toMatchObject({ version: '3', brief: null })
    expect(await financial(f)).toEqual(before)
    expect((await app.db!.query('select 1 from documents where deal_id=$1', [f.deal])).rowCount).toBe(0)
  })

  it('vendor may draft brief and deliverable but cannot create or cancel an event assignment', async () => {
    const f = await fixture()
    expect((await brief(f, '1', {}, f.vendorOwner)).statusCode).toBe(200)
    const added = await write(f, f.vendorOwner, 'POST', '/parts', { expectedVersion: '2', kind: 'deliverable', title: 'Vendor draft', details: {} })
    expect(added.statusCode, added.body).toBe(200)
    const before = await state(f)
    expectDenied(await write(f, f.vendorOwner, 'POST', '/assignments', { expectedVersion: '3', slotId: f.slot, programEventId: f.main, label: 'Move' }), 403)
    expect(await state(f)).toEqual(before)
    const assigned = await assignment(f, '3'), a = assigned.assignments[0]!
    expectDenied(await write(f, f.vendorOwner, 'POST', `/assignments/${a.id}/cancel`, { expectedVersion: assigned.version, expectedAssignmentVersion: a.version }), 403)
  })

  it.each([
    { expectedVersion: '1', brief: { values: {} }, price: 1 },
    { expectedVersion: '1', brief: { values: {}, categoryId: 'florist' } },
    { expectedVersion: '1', brief: { values: { quantity: 1 } } },
    { expectedVersion: '1', brief: { subtypeId: 'shop', values: {} } },
    { expectedVersion: '0', brief: null },
    { expectedVersion: '01', brief: null },
    { expectedVersion: '1', brief: { values: [] } },
  ])('rejects unknown or invalid brief body without mutation %#', async payload => {
    const f = await fixture(), before = await state(f)
    expectDenied(await write(f, f.owner, 'PATCH', '/brief', payload), 422)
    expect(await state(f)).toEqual(before)
  })

  it.each([
    ['supply', { dueAt: '2027-07-01T12:00:00Z' }],
    ['rental', { windowStartsAt: '2027-06-14T12:00:00Z' }],
    ['deliverable', { quantity: 2 }],
    ['timed_service', { recipient: 'Someone' }],
    ['appointment', { items: ['Something'] }],
    ['supply', { quantity: '2' }],
    ['supply', { quantity: 1.5 }],
    ['rental', { quantity: 0 }],
    ['deliverable', { dueAt: '2027-02-30T12:00:00Z' }],
    ['appointment', { startsAt: '2027-06-14T12:00:00Z', endsAt: '2027-06-14T11:00:00Z' }],
  ] as const)('rejects incompatible %s details through real HTTP %#', async (kind, details) => {
    const f = await fixture(), assigned = await assignment(f), before = await state(f)
    const result = await write(f, f.owner, 'POST', '/parts', { expectedVersion: assigned.version, assignmentId: assigned.assignments[0]!.id, kind, title: 'Invalid draft', details })
    expectDenied(result, 422); expect(await state(f)).toEqual(before)
  })

  it('rejects unknown top-level part fields rather than silently stripping prices or kind changes', async () => {
    const f = await fixture(), before = await state(f)
    expectDenied(await write(f, f.owner, 'POST', '/parts', { expectedVersion: '1', kind: 'deliverable', title: 'Draft', details: {}, price: 10 }), 422)
    expect(await state(f)).toEqual(before)
    const added = await part(f), p = added.parts[0]!, after = await state(f)
    expectDenied(await write(f, f.owner, 'PATCH', `/parts/${p.id}`, { expectedVersion: added.version, expectedPartVersion: p.version, kind: 'supply', title: 'Change kind' }), 422)
    expect(await state(f)).toEqual(after)
  })

  it('rejects unknown assignment and cancellation body fields without creating work or silently accepting it', async () => {
    const f = await fixture(), assigned = await assignment(f), created = await part(f, assigned.version)
    const p = created.parts[0]!, a = created.assignments[0]!, before = await state(f)
    const attempts: [string, object][] = [
      ['/assignments', { expectedVersion: created.version, slotId: f.slot, programEventId: f.main, label: 'Invalid', accepted: true }],
      [`/assignments/${a.id}/cancel`, { expectedVersion: created.version, expectedAssignmentVersion: a.version, vendorAccepted: true }],
      [`/parts/${p.id}/cancel`, { expectedVersion: created.version, expectedPartVersion: p.version, refund: 100 }],
    ]
    for (const [suffix, payload] of attempts) expectDenied(await write(f, f.owner, 'POST', suffix, payload), 422)
    expect(await state(f)).toEqual(before)
  })

  it('all five part kinds compose through HTTP without changing the contract, payments, holds or readiness', async () => {
    const f = await fixture(), before = await financial(f); let current = await assignment(f)
    for (const kind of ['timed_service', 'supply', 'rental', 'deliverable', 'appointment'] as const) {
      const result = await write(f, f.owner, 'POST', '/parts', { expectedVersion: current.version, kind, assignmentId: kind === 'deliverable' ? null : current.assignments[0]!.id, title: kind, details: {} })
      expect(result.statusCode, result.body).toBe(200); current = result.json<OrderDto>()
    }
    expect(current.parts).toHaveLength(5)
    expect(current.parts.every(p => p.cancelledAt === null && Object.values(p.details).every(v => v === null))).toBe(true)
    expect(current.parts.every(p => !('acceptedAt' in p) && !('done' in p) && !('ready' in p))).toBe(true)
    expect(await financial(f)).toEqual(before)
  })

  it('requires own live event assignment for working parts and refuses foreign scope', async () => {
    const f = await fixture(), other = await fixture(), foreign = await assignment(other)
    const before = await state(f)
    expectDenied(await write(f, f.owner, 'POST', '/parts', { expectedVersion: '1', kind: 'supply', title: 'Flowers', details: {} }), 422)
    expectDenied(await write(f, f.owner, 'POST', '/parts', { expectedVersion: '1', kind: 'supply', assignmentId: foreign.assignments[0]!.id, title: 'Flowers', details: {} }), 404)
    expectDenied(await write(f, f.owner, 'POST', '/assignments', { expectedVersion: '1', slotId: other.slot, programEventId: f.main, label: 'Foreign slot' }), 404)
    expectDenied(await write(f, f.owner, 'POST', '/assignments', { expectedVersion: '1', slotId: f.slot, programEventId: other.main, label: 'Foreign event' }), 404)
    expect(await state(f)).toEqual(before)
  })

  it('rejects stale root and child versions and validates a partial interval after merging', async () => {
    const f = await fixture(), created = await part(f), p = created.parts[0]!
    const changed = await write(f, f.owner, 'PATCH', `/parts/${p.id}`, { expectedVersion: created.version, expectedPartVersion: '1', title: 'New title' })
    expect(changed.statusCode, changed.body).toBe(200)
    const current = changed.json<OrderDto>(), before = await state(f)
    expectDenied(await brief(f, '1'), 409)
    expectDenied(await write(f, f.owner, 'PATCH', `/parts/${p.id}`, { expectedVersion: current.version, expectedPartVersion: '1', title: 'Stale child' }), 409)
    expectDenied(await write(f, f.owner, 'POST', `/parts/${p.id}/cancel`, { expectedVersion: current.version, expectedPartVersion: '1' }), 409)
    expect(await state(f)).toEqual(before)
    const assigned = await assignment(f, current.version)
    const interval = await write(f, f.owner, 'POST', '/parts', { expectedVersion: assigned.version, assignmentId: assigned.assignments[0]!.id, kind: 'timed_service', title: 'Shoot', details: { startsAt: '2027-06-14T12:00:00Z', endsAt: '2027-06-14T13:00:00Z' } })
    expect(interval.statusCode, interval.body).toBe(200)
    const order = interval.json<OrderDto>(), timed = order.parts.find(row => row.kind === 'timed_service')!
    const stable = await state(f)
    expectDenied(await write(f, f.owner, 'PATCH', `/parts/${timed.id}`, { expectedVersion: order.version, expectedPartVersion: timed.version, details: { endsAt: '2027-06-14T11:00:00Z' } }), 422)
    expect(await state(f)).toEqual(stable)
  })

  it('cancels one part, rejects further editing, and checks exact cancelled child version', async () => {
    const f = await fixture(), created = await part(f), p = created.parts[0]!, beforeFinance = await financial(f)
    const result = await write(f, f.owner, 'POST', `/parts/${p.id}/cancel`, { expectedVersion: created.version, expectedPartVersion: p.version })
    expect(result.statusCode, result.body).toBe(200)
    const cancelled = result.json<OrderDto>(); expect(cancelled.parts[0]?.cancelledAt).toEqual(expect.any(String))
    const stable = await state(f)
    expectDenied(await write(f, f.owner, 'PATCH', `/parts/${p.id}`, { expectedVersion: cancelled.version, expectedPartVersion: '2', title: 'Revive' }), 409)
    expectDenied(await write(f, f.owner, 'POST', `/parts/${p.id}/cancel`, { expectedVersion: cancelled.version, expectedPartVersion: '1' }), 409)
    const again = await write(f, f.owner, 'POST', `/parts/${p.id}/cancel`, { expectedVersion: cancelled.version, expectedPartVersion: '2' })
    expect(again.statusCode, again.body).toBe(200)
    // A successful no-op adds its own replay key; it must not add audit/history.
    expect(again.json<OrderDto>()).toEqual(cancelled)
    expect((await state(f))?.audit).toEqual(stable?.audit)
    expect(await financial(f)).toEqual(beforeFinance)
  })

  it('assignment cancellation preserves another event, cancels dependent parts and preserves legacy money and date hold', async () => {
    const f = await fixture(), before = await financial(f), first = await assignment(f), extraSlot = randomUUID()
    await app.db!.query("insert into slots(id,wedding_id,category_id,label,program_event_id) values($1,$2,'photo','Day two photographer',$3)", [extraSlot, f.wedding, f.secondEvent])
    const second = await assignment(f, first.version, extraSlot, f.secondEvent)
    const a = first.assignments[0]!, b = second.assignments.find(row => row.id !== a.id)!
    const supply = await write(f, f.owner, 'POST', '/parts', { expectedVersion: second.version, assignmentId: a.id, kind: 'supply', title: 'First event delivery', details: { quantity: 2, unit: 'sets' } })
    expect(supply.statusCode, supply.body).toBe(200)
    const afterSupply = supply.json<OrderDto>()
    const followup = await write(f, f.owner, 'POST', '/parts', { expectedVersion: afterSupply.version, assignmentId: b.id, kind: 'timed_service', title: 'Day two work', details: {} })
    expect(followup.statusCode, followup.body).toBe(200)
    const current = followup.json<OrderDto>()
    const cancelledResponse = await write(f, f.owner, 'POST', `/assignments/${a.id}/cancel`, { expectedVersion: current.version, expectedAssignmentVersion: a.version })
    expect(cancelledResponse.statusCode, cancelledResponse.body).toBe(200)
    const cancelled = cancelledResponse.json<OrderDto>()
    expect(cancelled.assignments.find(row => row.id === a.id)?.cancelledAt).toEqual(expect.any(String))
    expect(cancelled.assignments.find(row => row.id === b.id)?.cancelledAt).toBeNull()
    expect(cancelled.parts.find(row => row.title === 'First event delivery')?.cancelledAt).toEqual(expect.any(String))
    expect(cancelled.parts.find(row => row.title === 'Day two work')?.cancelledAt).toBeNull()
    expectDenied(await write(f, f.owner, 'POST', `/assignments/${a.id}/cancel`, { expectedVersion: cancelled.version, expectedAssignmentVersion: a.version }), 409)
    expect(await financial(f)).toEqual(before)
  })

  it('rejects foreign child IDs even with a valid current root version', async () => {
    const f = await fixture(), other = await fixture(), foreignPart = (await part(other)).parts[0]!, foreignAssignment = (await assignment(other, '2')).assignments[0]!, before = await state(f)
    expectDenied(await write(f, f.owner, 'PATCH', `/parts/${foreignPart.id}`, { expectedVersion: '1', expectedPartVersion: '1', title: 'Foreign' }), 404)
    expectDenied(await write(f, f.owner, 'POST', `/assignments/${foreignAssignment.id}/cancel`, { expectedVersion: '1', expectedAssignmentVersion: '1' }), 404)
    expect(await state(f)).toEqual(before)
  })

  it('requires Idempotency-Key and bounds it without claiming a key or changing data', async () => {
    const f = await fixture(), before = await state(f)
    const missing = await brief(f, '1', {}, f.owner, null)
    expectDenied(missing, 400); expect(missing.json().error.code).toBe('idempotency_key_required')
    const long = await brief(f, '1', {}, f.owner, 'k'.repeat(201))
    expectDenied(long, 400); expect(long.json().error.code).toBe('idempotency_key_too_long')
    expect(await state(f)).toEqual(before)
  })

  it('rejects payload and same-route different-path key collisions without replaying private content', async () => {
    const f = await fixture(), other = await fixture(), key = randomUUID()
    // Same actor is legitimately authorized to both roots, so the path hash
    // must reject this collision rather than ACL alone hiding the defect.
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [other.wedding, f.owner.id])
    const first = await brief(f, '1', undefined, f.owner, key)
    expect(first.statusCode, first.body).toBe(200)
    const before = await state(f), foreignBefore = await state(other)
    const changedBody = await brief(f, '1', { photographer: 'Other text' }, f.owner, key)
    expectDenied(changedBody, 409); expect(changedBody.json().error.code).toBe('idempotency_key_reused')
    const otherPath = await brief(other, '1', undefined, f.owner, key)
    expectDenied(otherPath, 409); expect(otherPath.json().error.code).toBe('idempotency_key_reused')
    expect(await state(f)).toEqual(before); expect(await state(other)).toEqual(foreignBefore)
  })

  it('scopes keys to actor and route while preserving exact replay after response loss', async () => {
    const f = await fixture(), key = randomUUID(), first = await brief(f, '1', undefined, f.owner, key)
    expect(first.statusCode, first.body).toBe(200)
    const original = first.json<OrderDto>()
    const changed = await brief(f, '2', { photographer: 'Later draft' }, f.vendorOwner, key)
    expect(changed.statusCode, changed.body).toBe(200)
    const created = await write(f, f.owner, 'POST', '/parts', { expectedVersion: '3', kind: 'deliverable', title: 'Private gallery', details: {} }, key)
    expect(created.statusCode, created.body).toBe(200)
    const beforeReplay = await state(f), finance = await financial(f)
    // Discarding the first response represents client response loss. Retrying
    // its identical request must return the ORIGINAL body, not current version.
    const replay = await brief(f, '1', undefined, f.owner, key)
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toEqual(original)
    expect(await state(f)).toEqual(beforeReplay); expect(await financial(f)).toEqual(finance)
    expect((await read(f)).json<OrderDto>().version).toBe('4')
  })

  it('concurrent retries yield one child, one audit row and one identical saved response', async () => {
    const f = await fixture(), key = randomUUID(), payload = { expectedVersion: '1', kind: 'deliverable', title: 'Private gallery', details: {} }
    const [a, b] = await Promise.all([write(f, f.owner, 'POST', '/parts', payload, key), write(f, f.owner, 'POST', '/parts', payload, key)])
    expect(a.statusCode, a.body).toBe(200); expect(b.statusCode, b.body).toBe(200); expect(a.json()).toEqual(b.json())
    expect((await read(f)).json<OrderDto>().parts).toHaveLength(1)
    expect((await app.db!.query("select 1 from audit_log where entity_id=$1 and action='order.part_created'", [f.deal])).rowCount).toBe(1)
  })

  type Revocation = 'membership' | 'session' | 'consent' | 'vendor_owner'
  async function revoke(client: Queryable, f: Fixture, kind: Revocation) {
    if (kind === 'membership') await client.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.owner.id])
    if (kind === 'session') await client.query('update sessions set revoked_at=now() where id=$1', [f.owner.session])
    if (kind === 'consent') await client.query('update consents set withdrawn_at=now() where id=$1', [f.owner.consent])
    if (kind === 'vendor_owner') await client.query('update vendors set user_id=$2 where id=$1', [f.vendor, f.outsider.id])
  }
  const revocationStatus: Record<Revocation, number> = { membership: 404, session: 401, consent: 403, vendor_owner: 404 }
  it.each(['membership', 'session', 'consent', 'vendor_owner'] as const)('replay after %s revocation does not return a saved private body', async kind => {
    const f = await fixture(), user = kind === 'vendor_owner' ? f.vendorOwner : f.owner, key = randomUUID()
    const first = await brief(f, '1', undefined, user, key)
    expect(first.statusCode, first.body).toBe(200)
    await app.db!.tx(client => revoke(client, f, kind))
    const before = await state(f)
    expectDenied(await brief(f, '1', undefined, user, key), revocationStatus[kind])
    expect(await state(f)).toEqual(before)
  })

  async function duringWeddingLock<T>(f: Fixture, start: () => PromiseLike<T>, change: (client: Queryable) => Promise<void>): Promise<T> {
    let acquired!: (pid: number) => void, release!: () => void, changeNow!: () => void
    const ready = new Promise<number>(resolve => { acquired = resolve })
    const unlock = new Promise<void>(resolve => { release = resolve })
    const mutate = new Promise<void>(resolve => { changeNow = resolve })
    let changed!: () => void
    const didChange = new Promise<void>(resolve => { changed = resolve })
    let shouldChange = false
    const blocker = app.db!.tx(async client => {
      await client.query('select id from weddings where id=$1 for update', [f.wedding])
      acquired((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
      await mutate
      if (shouldChange) await change(client)
      changed(); await unlock
    })
    const pid = await Promise.race([ready, blocker.then(() => { throw new Error('Lock transaction ended before acquisition') })])
    const pending = Promise.resolve(start())
    // Attach an immediate observer; the original promise still reports failure
    // to the caller, while cleanup cannot leave an unhandled HTTP rejection.
    void pending.catch(() => {})
    try {
      const deadline = Date.now() + 5000
      let waiting = false
      while (Date.now() < deadline) {
        const result = await app.db!.query(`select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and $1=any(pg_blocking_pids(pid)) and query like 'select id from weddings where id=$1 and archived_at%'`, [pid])
        if (result.rowCount) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting, 'HTTP must actually enter the locked order wedding query before revocation').toBe(true)
      shouldChange = true; changeNow(); await Promise.race([didChange, blocker])
    } finally {
      changeNow(); release()
      try { await blocker } finally { await pending.catch(() => {}) }
    }
    return await pending
  }

  it.each(['membership', 'session', 'consent', 'vendor_owner'] as const)('rechecks %s after a real lock wait before fresh mutation', async kind => {
    const f = await fixture(), user = kind === 'vendor_owner' ? f.vendorOwner : f.owner, before = await state(f), finance = await financial(f)
    const response = await duringWeddingLock(f, () => brief(f, '1', undefined, user), client => revoke(client, f, kind))
    expectDenied(response, revocationStatus[kind])
    expect(await state(f)).toEqual(before); expect(await financial(f)).toEqual(finance)
  })

  it.each(['membership', 'session', 'consent', 'vendor_owner'] as const)('rechecks %s after a real lock wait before replaying saved content', async kind => {
    const f = await fixture(), user = kind === 'vendor_owner' ? f.vendorOwner : f.owner, key = randomUUID()
    expect((await brief(f, '1', undefined, user, key)).statusCode).toBe(200)
    const before = await state(f)
    const response = await duringWeddingLock(f, () => brief(f, '1', undefined, user, key), client => revoke(client, f, kind))
    expectDenied(response, revocationStatus[kind]); expect(await state(f)).toEqual(before)
  })

  it('audit insert failure rolls back child/root/replay claim using a narrowly scoped real database trigger', async () => {
    const f = await fixture(), key = randomUUID(), token = randomUUID().replaceAll('-', ''), fn = `order_api_fail_${token}`, trigger = `order_api_audit_${token}`
    const before = await state(f), finance = await financial(f)
    // Dedicated test DB only. This trigger rejects one fixture deal/action;
    // every other application audit insert follows its real normal path.
    await app.db!.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if NEW.entity_id='${f.deal}'::uuid and NEW.action='order.part_created' then raise exception 'Synthetic order API audit rejection'; end if;
      return NEW; end $$`)
    try {
      await app.db!.query(`create trigger ${trigger} before insert on audit_log for each row execute function ${fn}()`)
      const response = await write(f, f.owner, 'POST', '/parts', { expectedVersion: '1', kind: 'deliverable', title: 'Private gallery', details: {} }, key)
      expect(response.statusCode, response.body).toBe(500)
      expect(response.body).not.toContain('Synthetic order API audit rejection')
      expect(await state(f)).toEqual(before); expect(await financial(f)).toEqual(finance)
    } finally {
      await app.db!.query(`drop trigger if exists ${trigger} on audit_log`)
      await app.db!.query(`drop function ${fn}()`)
    }
    const retry = await write(f, f.owner, 'POST', '/parts', { expectedVersion: '1', kind: 'deliverable', title: 'Private gallery', details: {} }, key)
    expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json<OrderDto>().parts).toHaveLength(1)
    expect((await app.db!.query("select 1 from audit_log where entity_id=$1 and action='order.part_created'", [f.deal])).rowCount).toBe(1)
  })
})
