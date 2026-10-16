import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js'
import { AppError } from '../src/errors.js'
import { guestByToken } from '../src/guests/access.js'
import type { AdditionalSlotDto } from '../src/orders/assignments.js'
import type { Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

const DATABASE = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'additional-slot-native-http-synthetic-secret-'.repeat(2)
const ROUTE = '/weddings/:weddingId/slots/additional'
type Actor = { id: string; session: string; consent: string; token: string }
type Body = { categoryId: string; programEventId: string; label: string }
type Response = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }
type Wait = { pid: number; query: string; wait_event: string; blockers: number[] }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

// Registered HTTP handlers and real PostgreSQL only; fixtures are synthetic,
// not public onboarding, financial agreement or two-human acceptance.
describe.skipIf(!DATABASE)('additional event positions: actual HTTP/PG authority, receipts and rollback', () => {
  let app: FastifyInstance
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>()
  let priorAudits: { key: string; digest: string }[] = [], priorReceipts: { key: string; digest: string }[] = []
  const waits: { change: string; holder: number; waiting: Wait; expired?: Wait; exp?: number;
    verifiedBeforeInvokeAtMs?: number; verifiedAfterWaitAtMs?: number; expiredVerifiedAtMs?: number }[] = []

  async function pins(table: 'audit_log' | 'idempotency_keys', key: 'id' | 'key') {
    return (await app.db!.query<{ key: string; row: string }>(`select ${key}::text as key,to_jsonb(t)::text as row from ${table} t order by ${key}`)).rows
      .map(row => ({ key: row.key, digest: sha(row.row) }))
  }
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_full_20260930_test', '/tili_ecosystem_allocations_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'additional-slot-refresh-synthetic-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select current_database() name,current_user principal,host(inet_server_addr()) address,inet_server_port() port')).rows[0]!
    expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
    expect(['127.0.0.1', '::1']).toContain(live.address); expect(live.port).toBe(Number(disposablePgPort()))
    priorAudits = await pins('audit_log', 'id'); priorReceipts = await pins('idempotency_keys', 'key')
  })
  async function cleanup() {
    await app.db!.query('delete from weddings where id=any($1::uuid[])', [[...weddings]])
    await app.db!.query('delete from vendors where id=any($1::uuid[])', [[...vendors]])
    const owned = [...users]
    for (let offset = 0; offset < owned.length; offset += 32) await app.db!.query('delete from users where id=any($1::uuid[])', [owned.slice(offset, offset + 32)])
  }
  afterEach(async () => { if (app) await cleanup() })
  afterAll(async () => {
    if (!app) return
    try {
      process.stdout.write(`ADDITIONAL_SLOTS_PG_WAITS count=${waits.length} ${JSON.stringify(waits)}\n`)
      const ownAudits = (await app.db!.query<{ id: string }>('select id::text from audit_log where actor_id=any($1::uuid[]) order by id', [[...users]])).rows.map(row => row.id)
      process.stdout.write(`ADDITIONAL_SLOTS_FIXTURE_MANIFEST ${JSON.stringify({ users: [...users], weddings: [...weddings], vendors: [...vendors], retainedAuditIds: ownAudits })}\n`)
      await cleanup()
      for (const [table, ids] of [['users', users], ['weddings', weddings], ['vendors', vendors]] as const) {
        expect((await app.db!.query(`select id from ${table} where id=any($1::uuid[])`, [[...ids]])).rows).toEqual([])
      }
      for (const table of ['sessions', 'consents', 'idempotency_keys', 'notifications']) {
        expect((await app.db!.query(`select user_id from ${table} where user_id=any($1::uuid[])`, [[...users]])).rows).toEqual([])
      }
      const audits = new Map((await pins('audit_log', 'id')).map(row => [row.key, row.digest]))
      const receipts = new Map((await pins('idempotency_keys', 'key')).map(row => [row.key, row.digest]))
      for (const row of priorAudits) expect(audits.get(row.key), 'Prior immutable audit changed').toBe(row.digest)
      for (const row of priorReceipts) expect(receipts.get(row.key), 'Prior receipt changed').toBe(row.digest)
      process.stdout.write('ADDITIONAL_SLOTS_CLEANUP completed=true\n')
    } finally { await app.close() }
  })
  async function actor(): Promise<Actor> {
    const id = randomUUID(), session = randomUUID(), consent = randomUUID()
    let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) inserted = (await app.db!.query(
      "insert into users(id,phone,name) values($1,$2,'Synthetic additional-slot actor') on conflict(phone) do nothing returning id",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])).rowCount === 1
    assert(inserted); users.add(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consent, id, POLICY])
    return { id, session, consent, token: await signAccessToken(SECRET, { sub: id, sid: session }) }
  }
  async function fixture() {
    const couple = await actor(), partner = await actor(), helper = await actor(), coordinator = await actor(), vendor = await actor(), outsider = await actor()
    const wedding = randomUUID(), event = randomUUID(); weddings.add(wedding)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic positions','2027-06-14','Europe/Moscow',$3)", [wedding, couple.id, randomUUID()])
    for (const [person, role] of [[couple, 'couple'], [partner, 'couple'], [helper, 'helper'], [coordinator, 'coordinator'], [vendor, 'vendor']] as const) {
      await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [wedding, person.id, role])
    }
    await app.db!.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Synthetic day two','second_day','2027-06-15','Asia/Novosibirsk',false)", [event, wedding])
    const main = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [wedding])).rows[0]!.id
    return { wedding, event, main, couple, partner, helper, coordinator, vendor, outsider, url: `/weddings/${wedding}/slots/additional` }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const body = (f: Fixture): Body => ({ categoryId: 'photo', programEventId: f.event, label: 'Synthetic second-day photography' })
  const headers = (a: Actor, key: string | null) => ({ authorization: `Bearer ${a.token}`, ...(key === null ? {} : { 'idempotency-key': key }) })
  const post = (f: Fixture, key: string | null = randomUUID(), payload: object = body(f), a = f.couple, url = f.url) =>
    app.inject({ method: 'POST', url, headers: headers(a, key), payload }).then(response => response)
  async function rows(c: Queryable, table: string, where: string, values: readonly unknown[]) {
    return (await c.query<{ row: string }>(`select to_jsonb(t)::text as row from ${table} t where ${where} order by to_jsonb(t)::text`, values)).rows.map(row => row.row)
  }
  async function financial(f: Fixture, c: Queryable = app.db!) {
    const result: { table: string; rows: string[] }[] = []
    for (const table of ['deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_resource_commitments', 'resource_allocations', 'leads']) {
      result.push({ table, rows: await rows(c, table, 'wedding_id=$1', [f.wedding]) })
    }
    for (const table of ['payments', 'payment_installments', 'deal_events', 'deal_terms_versions', 'deal_terms_receipts']) {
      result.push({ table, rows: await rows(c, table, 'deal_id in(select id from deals where wedding_id=$1)', [f.wedding]) })
    }
    result.push({ table: 'vendor_busy_dates', rows: await rows(c, 'vendor_busy_dates', 'deal_id in(select id from deals where wedding_id=$1)', [f.wedding]) })
    return result
  }
  async function state(f: Fixture, c: Queryable = app.db!) {
    return { slots: await rows(c, 'slots', 'wedding_id=$1', [f.wedding]), events: await rows(c, 'wedding_events', 'wedding_id=$1', [f.wedding]),
      shortlist: await rows(c, 'slot_shortlist', 'slot_id in(select id from slots where wedding_id=$1)', [f.wedding]),
      keys: await rows(c, 'idempotency_keys', 'user_id=$1', [f.couple.id]), audit: await rows(c, 'audit_log', 'actor_id=$1', [f.couple.id]), money: await financial(f, c) }
  }
  function created(response: Response, expected: Body): AdditionalSlotDto {
    expect(response.statusCode, response.body).toBe(201); expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ id: expect.any(String), ...expected })
    return response.json<AdditionalSlotDto>()
  }
  async function refused(f: Fixture, request: () => Promise<Response>, status: number, code?: string) {
    const before = await state(f), response = await request()
    expect(response.statusCode, response.body).toBe(status)
    if (code) expect(response.json<{ error: { code: string } }>().error.code).toBe(code)
    expect(await state(f)).toEqual(before)
    return response
  }

  it('creates two event-scoped positions in the same category without changing an existing booking or money', async () => {
    const f = await fixture(), vendorId = randomUUID(), slot = randomUUID(), deal = randomUUID(); vendors.add(vendorId)
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic booked studio',now())", [vendorId, f.vendor.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Inherited booked position')", [slot, f.wedding])
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'booked',9007199254740993)", [deal, f.wedding, slot, vendorId])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slot, deal])
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',12345,'recorded','cash','private')", [randomUUID(), deal])
    await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2)", [vendorId, deal])
    const before = await financial(f), firstBody = { ...body(f), programEventId: f.main, label: 'Main ceremony' }
    const first = created(await post(f, randomUUID(), firstBody), firstBody), second = created(await post(f, randomUUID(), body(f), f.partner), body(f))
    expect(first.id).not.toBe(second.id)
    expect((await app.db!.query('select id,category_id,program_event_id,deal_id from slots where id=any($1::uuid[]) order by id', [[first.id, second.id]])).rows)
      .toEqual([{ id: first.id, category_id: 'photo', program_event_id: f.main, deal_id: null }, { id: second.id, category_id: 'photo', program_event_id: f.event, deal_id: null }].sort((a, b) => a.id.localeCompare(b.id)))
    expect(await financial(f)).toEqual(before)
    const legacy = await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots`, headers: headers(f.couple, null), payload: { categoryId: 'photo' } })
    expect(legacy.statusCode).toBe(409); expect(legacy.json().error).toMatchObject({ code: 'slot_exists', details: { slotId: slot } })
  })
  it('requires a key and a complete valid body, leaving no claim, position or audit on refusal', async () => {
    const f = await fixture()
    await refused(f, () => post(f, null), 400, 'idempotency_key_required')
    await refused(f, () => post(f, 'x'.repeat(201)), 400, 'idempotency_key_too_long')
    for (const payload of [{}, { ...body(f), programEventId: 'invalid' }, { ...body(f), label: '' }, { ...body(f), label: ' '.repeat(3) },
      { ...body(f), label: 'x'.repeat(201) }, { ...body(f), unexpected: true }, { ...body(f), categoryId: 'unknown-category' }]) {
      await refused(f, () => post(f, randomUUID(), payload), 422, 'validation_failed')
    }
  })
  it.each(['helper', 'coordinator', 'vendor', 'outsider'] as const)('refuses current %s without writing a receipt', async role => {
    const f = await fixture(); await refused(f, () => post(f, randomUUID(), body(f), f[role]), role === 'outsider' ? 404 : 403)
  })
  it('refuses a valid guest token, foreign event and inactive wedding', async () => {
    const f = await fixture(), other = await fixture(), guestToken = randomUUID()
    await app.db!.query("insert into guests(id,wedding_id,name,rsvp_token) values($1,$2,'Synthetic guest',$3)", [randomUUID(), f.wedding, guestToken])
    expect((await guestByToken(app.db!, guestToken)).weddingId).toBe(f.wedding)
    await refused(f, () => app.inject({ method: 'POST', url: `${f.url}?guestToken=${guestToken}`, headers: { 'idempotency-key': randomUUID() }, payload: body(f) }).then(r => r), 401)
    await refused(f, () => post(f, randomUUID(), { ...body(f), programEventId: other.event }), 404)
    await app.db!.query('update weddings set cancelled_at=now() where id=$1', [f.wedding])
    await refused(f, () => post(f), 404)
    await app.db!.query('update weddings set cancelled_at=null,archived_at=now() where id=$1', [f.wedding])
    await refused(f, () => post(f), 404)
  })
  it('serializes concurrent exact keys to one position/audit, checks body and actual-URL hashes', async () => {
    const f = await fixture(), key = randomUUID(), before = await financial(f)
    const replies = await Promise.all(Array.from({ length: 6 }, () => post(f, key)))
    const selected = replies.map(r => created(r, body(f)))
    expect(new Set(selected.map(slot => slot.id)).size).toBe(1)
    expect(replies.filter(r => r.headers['idempotent-replay'] === 'true')).toHaveLength(5)
    const saved = await state(f)
    expect(saved.slots).toHaveLength(1); expect(saved.keys).toHaveLength(1); expect(saved.audit).toHaveLength(1)
    expect(saved.money).toEqual(before)
    expect((await app.db!.query('select route,status,body from idempotency_keys where key=$1', [`${f.couple.id}:${ROUTE}:${key}`])).rows)
      .toEqual([{ route: ROUTE, status: 201, body: selected[0] }])
    created(await post(f, key), body(f)); expect(await state(f)).toEqual(saved)
    await refused(f, () => post(f, key, { ...body(f), label: 'Different command' }), 409, 'idempotency_key_reused')
    // PostgreSQL UUID identity is unchanged; the actual HTTP address is different.
    expect(f.wedding.toUpperCase()).not.toBe(f.wedding)
    await refused(f, () => post(f, key, body(f), f.couple, `/weddings/${f.wedding.toUpperCase()}/slots/additional`), 409, 'idempotency_key_reused')
  })
  it('caps concurrent new keys at 100 positions but still allows an exact replay at the cap', async () => {
    const f = await fixture()
    await app.db!.query("insert into slots(id,wedding_id,category_id,program_event_id,label) select gen_random_uuid(),$1,'photo',$2,'Synthetic cap '||n from generate_series(1,99) n", [f.wedding, f.main])
    const keys = [randomUUID(), randomUUID()], replies = await Promise.all(keys.map(key => post(f, key)))
    expect(replies.map(r => r.statusCode).sort()).toEqual([201, 409])
    const index = replies.findIndex(r => r.statusCode === 201), selected = created(replies[index]!, body(f))
    expect(replies.find(r => r.statusCode === 409)!.json().error.code).toBe('slot_limit')
    expect((await app.db!.query('select count(*)::int n from slots where wedding_id=$1', [f.wedding])).rows).toEqual([{ n: 100 }])
    const saved = await state(f)
    expect(saved.keys).toHaveLength(1); expect(saved.audit).toHaveLength(1)
    expect(created(await post(f, keys[index]!), body(f))).toEqual(selected); expect(await state(f)).toEqual(saved)
  })
  async function publishedVendor(category: 'photo' | 'video') {
    const owner = await actor(), id = randomUUID(); vendors.add(id)
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,$3,'Synthetic cap studio',now())", [id, owner.id, category])
    return id
  }
  const shortlist = (f: Fixture, vendor: string, slotId?: string, a = f.couple) => app.inject({ method: 'PUT', url: `/weddings/${f.wedding}/shortlist/${vendor}`,
    headers: headers(a, null), ...(slotId === undefined ? {} : { payload: { slotId } }) }).then(r => r)
  const legacySlot = (f: Fixture, categoryId: string) => app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots`, headers: headers(f.couple, null), payload: { categoryId } }).then(r => r)
  it('preserves legacy shortlist PUT without a payload, but rejects a literal JSON null body', async () => {
    const f = await fixture(), vendor = await publishedVendor('photo'), url = `/weddings/${f.wedding}/shortlist/${vendor}`
    const selected = await app.inject({ method: 'PUT', url, headers: headers(f.couple, null) })
    expect(selected.statusCode, selected.body).toBe(200)
    const saved = await state(f)
    expect(saved.slots).toHaveLength(1); expect(saved.shortlist).toHaveLength(1)
    const repeated = await app.inject({ method: 'PUT', url, headers: headers(f.couple, null) })
    expect(repeated.statusCode, repeated.body).toBe(200); expect(repeated.json().id).toBe(selected.json().id)
    expect(await state(f)).toEqual(saved)
    await refused(f, () => app.inject({ method: 'PUT', url, headers: { ...headers(f.couple, null), 'content-type': 'application/json' }, payload: 'null' }).then(r => r), 422, 'validation_failed')
  })
  it('adds the same vendor to the explicit additional position and the omitted legacy primary independently', async () => {
    const f = await fixture(), vendor = await publishedVendor('photo'), primary = randomUUID()
    await app.db!.query("insert into slots(id,wedding_id,category_id,label,sort) values($1,$2,'photo','Synthetic primary',0)", [primary, f.wedding])
    const additional = created(await post(f), body(f)), before = await financial(f)
    const exact = await shortlist(f, vendor, additional.id)
    expect(exact.statusCode, exact.body).toBe(200)
    expect((await app.db!.query('select slot_id,vendor_id from slot_shortlist where slot_id in(select id from slots where wedding_id=$1)', [f.wedding])).rows)
      .toEqual([{ slot_id: additional.id, vendor_id: vendor }])
    const legacy = await shortlist(f, vendor)
    expect(legacy.statusCode, legacy.body).toBe(200); expect(legacy.json().id).not.toBe(exact.json().id)
    expect((await app.db!.query('select slot_id,vendor_id from slot_shortlist where slot_id in(select id from slots where wedding_id=$1) order by slot_id', [f.wedding])).rows)
      .toEqual([{ slot_id: additional.id, vendor_id: vendor }, { slot_id: primary, vendor_id: vendor }].sort((a, b) => a.slot_id.localeCompare(b.slot_id)))
    const saved = await state(f), helper = await shortlist(f, vendor, additional.id, f.helper)
    expect(helper.statusCode, helper.body).toBe(200); expect(helper.json().id).toBe(exact.json().id)
    expect(await state(f)).toEqual(saved); expect(await financial(f)).toEqual(before)
  })
  it('refuses missing, foreign, malformed and category-mismatched explicit positions without category fallback', async () => {
    const f = await fixture(), other = await fixture(), vendor = await publishedVendor('photo')
    created(await post(f), body(f))
    const foreign = created(await post(other), body(other)), wrong = randomUUID()
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'video','Synthetic video')", [wrong, f.wedding])
    const otherBefore = await state(other)
    for (const [slotId, status] of [[randomUUID(), 404], [foreign.id, 404], [wrong, 422], ['invalid', 422]] as const) {
      await refused(f, () => shortlist(f, vendor, slotId), status)
    }
    expect(await state(other)).toEqual(otherBefore)
  })
  it('keeps the 100-position cap across legacy creation and shortlist while allowing existing-category reuse', async () => {
    const f = await fixture(), video = await publishedVendor('video'), photo = await publishedVendor('photo')
    await app.db!.query("insert into slots(id,wedding_id,category_id,program_event_id,label) select gen_random_uuid(),$1,'photo',$2,'Synthetic cap '||n from generate_series(1,100) n", [f.wedding, f.main])
    await refused(f, () => legacySlot(f, 'video'), 409, 'slot_limit')
    await refused(f, () => shortlist(f, video), 409, 'slot_limit')
    const existing = await refused(f, () => legacySlot(f, 'photo'), 409, 'slot_exists')
    const before = await state(f)
    expect(before.slots.map(raw => (JSON.parse(raw) as { id: string }).id)).toContain(existing.json<{ error: { details: { slotId: string } } }>().error.details.slotId)
    const selected = await shortlist(f, photo)
    expect(selected.statusCode, selected.body).toBe(200)
    const after = await state(f)
    expect(after.slots).toEqual(before.slots); expect(after.slots).toHaveLength(100)
    expect(after.events).toEqual(before.events); expect(after.keys).toEqual(before.keys); expect(after.money).toEqual(before.money)
    expect(after.shortlist).toHaveLength(1)
    expect((JSON.parse(after.shortlist[0]!) as { vendor_id: string }).vendor_id).toBe(photo)
    const explicitId = (JSON.parse(after.shortlist[0]!) as { slot_id: string }).slot_id
    const explicit = await shortlist(f, photo, explicitId)
    expect(explicit.statusCode, explicit.body).toBe(200)
    expect((JSON.parse((await state(f)).shortlist[0]!) as { slot_id: string }).slot_id).toBe(explicitId)
    expect(await state(f)).toEqual(after)
    const reused = await shortlist(f, photo)
    expect(reused.statusCode, reused.body).toBe(200)
    type ObservedEntry = Record<string, unknown> & { availabilityObservation: { checkedAt: string } }
    const originalDto = selected.json<ObservedEntry>(), reusedDto = reused.json<ObservedEntry>()
    for (const entry of [originalDto, reusedDto]) {
      expect(entry.availabilityObservation).not.toBeNull()
      expect(typeof entry.availabilityObservation.checkedAt).toBe('string')
      expect(new Date(entry.availabilityObservation.checkedAt).toISOString()).toBe(entry.availabilityObservation.checkedAt)
    }
    expect(reusedDto).toEqual({ ...originalDto, availabilityObservation: { ...originalDto.availabilityObservation, checkedAt: reusedDto.availabilityObservation.checkedAt } })
    expect(await state(f)).toEqual(after)
  })
  it.each(['legacy', 'shortlist'] as const)('serializes the last available position across additional creation and %s', async path => {
    const f = await fixture(), vendor = path === 'shortlist' ? await publishedVendor('video') : null
    await app.db!.query("insert into slots(id,wedding_id,category_id,program_event_id,label) select gen_random_uuid(),$1,'photo',$2,'Synthetic cap '||n from generate_series(1,99) n", [f.wedding, f.main])
    const money = await financial(f)
    const [additional, legacy] = await Promise.all([post(f), path === 'legacy' ? legacySlot(f, 'video') : shortlist(f, vendor!)])
    if (additional.statusCode === 201) expect(legacy.statusCode, legacy.body).toBe(409)
    else {
      expect(additional.statusCode, additional.body).toBe(409)
      expect(legacy.statusCode, legacy.body).toBe(path === 'legacy' ? 201 : 200)
    }
    const denied = additional.statusCode === 409 ? additional : legacy
    expect(denied.json().error.code).toBe('slot_limit')
    const after = await state(f)
    expect(after.slots).toHaveLength(100); expect(after.money).toEqual(money)
  })
  it.each(['deleted slot', 'changed slot', 'deleted event'] as const)('does not replay a stale %s or recreate its audit', async change => {
    const f = await fixture(), key = randomUUID(), selected = created(await post(f, key), body(f))
    if (change === 'changed slot') await app.db!.query('update slots set program_event_id=$2 where id=$1', [selected.id, f.main])
    else await app.db!.query('delete from slots where id=$1', [selected.id])
    if (change === 'deleted event') await app.db!.query('delete from wedding_events where id=$1', [f.event])
    await refused(f, () => post(f, key), change === 'deleted event' ? 404 : 409)
  })

  async function blockedBy(holder: number): Promise<Wait[]> {
    return (await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
      where datname=current_database() and usename=current_user and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [holder])).rows
  }
  async function waited(change: string, lock: string, values: readonly unknown[], mutate: (client: Queryable) => Promise<unknown>,
    invoke: () => Promise<Response>, blocked?: (holder: number, waiting: Wait) => Promise<void>) {
    let release!: () => void, ready!: () => void, holderPid = 0
    const permitted = new Promise<void>(resolve => { release = resolve }), locked = new Promise<void>(resolve => { ready = resolve })
    const holder = app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query(lock, values); ready(); await permitted; await mutate(c)
    })
    void holder.catch(() => undefined)
    let response: Promise<Response> | undefined
    try {
      await Promise.race([locked, holder.then(() => { throw new Error(`${change}: holder exited before barrier`) })])
      let done = false
      response = invoke().then(result => { done = true; return result }); void response.catch(() => undefined)
      let waiting: Wait[] = []
      const deadline = Date.now() + 3000
      while (!done && Date.now() < deadline) {
        waiting = await blockedBy(holderPid); if (waiting.length) break
        await new Promise<void>(resolve => setTimeout(resolve, 15))
      }
      expect(waiting, `${change}: real registered HTTP request must wait in PG`).toHaveLength(1)
      expect(done).toBe(false); expect(waiting[0]!.blockers).toContain(holderPid)
      waits.push({ change, holder: holderPid, waiting: waiting[0]! })
      await blocked?.(holderPid, waiting[0]!)
      expect(done).toBe(false)
      release(); await holder
      return { response: await response, waiting: waiting[0]! }
    } finally { release(); await Promise.allSettled(response ? [holder, response] : [holder]) }
  }
  for (const mode of ['new', 'replay'] as const) it.each(['member', 'role', 'session', 'consent', 'account'] as const)(`${mode} command rechecks current %s after a witnessed row wait`, async change => {
    const f = await fixture(), key = randomUUID()
    if (mode === 'replay') created(await post(f, key), body(f))
    const before = await state(f)
    const member = change === 'member' || change === 'role'
    const table = member ? 'wedding_members' : change === 'account' ? 'users' : change === 'session' ? 'sessions' : 'consents'
    const values = member ? [f.wedding, f.couple.id] : [change === 'account' ? f.couple.id : change === 'session' ? f.couple.session : f.couple.consent]
    const where = member ? 'wedding_id=$1 and user_id=$2' : 'id=$1'
    const outcome = await waited(`${mode} ${change}`, `select * from ${table} where ${where} for update`, values, async c => {
      if (change === 'member') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', values)
      if (change === 'role') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", values)
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', values)
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where id=$1', values)
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', values)
    }, () => post(f, key))
    expect(outcome.waiting.query).toContain(`from ${table}`); expect(outcome.waiting.query).toContain('for share')
    expect(outcome.response.statusCode, outcome.response.body).toBe(change === 'member' ? 404 : change === 'role' || change === 'consent' ? 403 : 401)
    expect(outcome.response.headers['idempotent-replay']).toBeUndefined(); expect(await state(f)).toEqual(before)
  })
  it.each(['member', 'role', 'session', 'consent'] as const)('explicit shortlist rechecks current %s after a real native wait', async change => {
    const f = await fixture(), vendor = await publishedVendor('photo'), position = created(await post(f), body(f))
    const before = await state(f), member = change === 'member' || change === 'role'
    const table = member ? 'wedding_members' : change === 'session' ? 'sessions' : 'consents'
    const values = member ? [f.wedding, f.couple.id] : [change === 'session' ? f.couple.session : f.couple.consent]
    const where = member ? 'wedding_id=$1 and user_id=$2' : 'id=$1'
    const outcome = await waited(`explicit shortlist ${change}`, `select * from ${table} where ${where} for update`, values, async c => {
      if (change === 'member') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', values)
      if (change === 'role') await c.query("update wedding_members set role='coordinator' where wedding_id=$1 and user_id=$2", values)
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', values)
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where id=$1', values)
    }, () => shortlist(f, vendor, position.id))
    expect(outcome.waiting.query).toContain(`from ${table}`); expect(outcome.waiting.query).toContain('for share')
    expect(outcome.response.statusCode, outcome.response.body).toBe(change === 'member' ? 404 : change === 'session' ? 401 : 403)
    expect(await state(f)).toEqual(before)
  })
  it.each(['new', 'existing'] as const)('explicit shortlist %s result rechecks JWT after a late vendor wait before committing', async mode => {
    const f = await fixture(), vendor = await publishedVendor('photo'), position = created(await post(f), body(f))
    if (mode === 'existing') expect((await shortlist(f, vendor, position.id)).statusCode).toBe(200)
    const before = await state(f)
    let caller = f.couple, exp = 0, verifiedBeforeInvokeAtMs = 0
    const outcome = await waited(`explicit shortlist ${mode} JWT expiry`, 'select id from vendors where id=$1 for update', [vendor], async () => undefined,
      async () => {
        exp = Math.floor(Date.now() / 1000) + 4
        caller = { ...f.couple, token: await signAccessToken(SECRET, { sub: f.couple.id, sid: f.couple.session }, (exp - ACCESS_TTL_SECONDS) * 1000) }
        expect(await verifyAccessToken(SECRET, caller.token)).toEqual({ sub: caller.id, sid: caller.session, exp })
        verifiedBeforeInvokeAtMs = Date.now()
        return shortlist(f, vendor, position.id, caller)
      }, async (holder, waiting) => {
        expect(waiting.query).toContain('for share of u, v')
        expect(await verifyAccessToken(SECRET, caller.token)).toEqual({ sub: caller.id, sid: caller.session, exp })
        const verifiedAfterWaitAtMs = Date.now(), deadline = Date.now() + 6000
        let expiredVerifiedAtMs = 0
        while (Date.now() < deadline) {
          try { await verifyAccessToken(SECRET, caller.token) } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'token_expired' || error.statusCode !== 401) throw error
            expiredVerifiedAtMs = Date.now(); break
          }
          await new Promise<void>(resolve => setTimeout(resolve, 15))
        }
        expect(expiredVerifiedAtMs).toBeGreaterThan(0)
        const expiredWait = await blockedBy(holder)
        expect(expiredWait).toHaveLength(1); expect(expiredWait[0]!.pid).toBe(waiting.pid); expect(expiredWait[0]!.query).toBe(waiting.query)
        Object.assign(waits[waits.length - 1]!, { exp, expired: expiredWait[0]!, verifiedBeforeInvokeAtMs, verifiedAfterWaitAtMs, expiredVerifiedAtMs })
      })
    expect(outcome.response.statusCode, outcome.response.body).toBe(401)
    expect(outcome.response.json<{ error: { code: string } }>().error.code).toBe('token_expired')
    expect(await state(f)).toEqual(before)
    expect((await shortlist(f, vendor, position.id)).statusCode).toBe(200)
  }, 15000)
  it.each(['new', 'replay'] as const)('%s command refuses an already expired JWT without consuming the key', async mode => {
    const f = await fixture(), key = randomUUID()
    if (mode === 'replay') created(await post(f, key), body(f))
    const expired = { ...f.couple, token: await signAccessToken(SECRET, { sub: f.couple.id, sid: f.couple.session }, Date.now() - (ACCESS_TTL_SECONDS + 2) * 1000) }
    await expect(verifyAccessToken(SECRET, expired.token)).rejects.toMatchObject({ statusCode: 401, code: 'token_expired' })
    await refused(f, () => post(f, key, body(f), expired), 401, 'token_expired')
  })
  it.each(['new', 'replay'] as const)('%s command refuses a genuinely expired JWT after a late native wait; rolls back new writes', async mode => {
    const f = await fixture(), key = randomUUID()
    if (mode === 'replay') created(await post(f, key), body(f))
    const before = await state(f), selected = mode === 'replay' ? JSON.parse(before.slots[0]!).id as string : null
    let caller = f.couple, exp = 0, verifiedBeforeInvokeAtMs = 0
    const outcome = await waited(`${mode} JWT expiry`, mode === 'new' ? 'lock table audit_log in share mode' : 'select id from slots where id=$1 for update',
      mode === 'new' ? [] : [selected], async () => undefined, async () => {
        exp = Math.floor(Date.now() / 1000) + 4
        caller = { ...f.couple, token: await signAccessToken(SECRET, { sub: f.couple.id, sid: f.couple.session }, (exp - ACCESS_TTL_SECONDS) * 1000) }
        expect(await verifyAccessToken(SECRET, caller.token)).toEqual({ sub: caller.id, sid: caller.session, exp })
        verifiedBeforeInvokeAtMs = Date.now()
        return post(f, key, body(f), caller)
      }, async (holder, waiting) => {
        expect(waiting.query).toContain(mode === 'new' ? 'insert into audit_log' : 'from slots')
        expect(await verifyAccessToken(SECRET, caller.token)).toEqual({ sub: caller.id, sid: caller.session, exp })
        const verifiedAfterWaitAtMs = Date.now()
        let expired = false, expiredVerifiedAtMs = 0
        const deadline = Date.now() + 6000
        while (Date.now() < deadline) {
          try { await verifyAccessToken(SECRET, caller.token) } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'token_expired' || error.statusCode !== 401) throw error
            expired = true; expiredVerifiedAtMs = Date.now(); break
          }
          await new Promise<void>(resolve => setTimeout(resolve, 15))
        }
        expect(expired).toBe(true)
        const stillWaiting = await blockedBy(holder)
        expect(stillWaiting).toHaveLength(1); expect(stillWaiting[0]!.pid).toBe(waiting.pid)
        expect(stillWaiting[0]!.query).toBe(waiting.query)
        waits[waits.length - 1]!.expired = stillWaiting[0]!
        waits[waits.length - 1]!.exp = exp
        waits[waits.length - 1]!.verifiedBeforeInvokeAtMs = verifiedBeforeInvokeAtMs
        waits[waits.length - 1]!.verifiedAfterWaitAtMs = verifiedAfterWaitAtMs
        waits[waits.length - 1]!.expiredVerifiedAtMs = expiredVerifiedAtMs
      })
    expect(outcome.response.statusCode, outcome.response.body).toBe(401)
    expect(outcome.response.json<{ error: { code: string } }>().error.code).toBe('token_expired')
    expect(outcome.response.headers['idempotent-replay']).toBeUndefined(); expect(await state(f)).toEqual(before)
    const retried = await post(f, key); created(retried, body(f))
    expect(retried.headers['idempotent-replay']).toBe(mode === 'replay' ? 'true' : undefined)
  }, 15000)
})
