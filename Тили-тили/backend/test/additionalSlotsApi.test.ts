import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js'
import { AppError } from '../src/errors.js'
import { guestByToken } from '../src/guests/access.js'
import type { AdditionalSlotDto } from '../src/orders/assignments.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
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
  it('queues fresh exact keys before completed replays to one position/audit, checks body and actual-URL hashes', async () => {
    const f = await fixture(), key = randomUUID(), before = await financial(f)
    const queued = await prefixRace(f, 'fresh exact key before completed replay', [() => post(f, key), () => post(f, key)], { captureWinner: true })
    const [first, stale] = queued.replies
    assert(first && stale)
    const winner = created(first, body(f))
    expect(first.headers['idempotent-replay']).toBeUndefined()
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json<{ error: { code: string } }>().error.code).toBe('calendar_scope_changed')
    expect(stale.headers['idempotent-replay']).toBeUndefined()
    expect(queued.frames.filter(Boolean)).toHaveLength(1); assert(queued.frames[0])
    sameWhole(await whole(), queued.frames[0])
    const savedWinner = await state(f), retry = await post(f, key)
    expect(created(retry, body(f))).toEqual(winner)
    expect(retry.headers['idempotent-replay']).toBe('true')
    expect(await state(f)).toEqual(savedWinner); sameWhole(await whole(), queued.frames[0])
    // Four completed-cache callers retain the original six successful resolutions:
    // first201 + explicit fresh retry201 + four cached201, with five replay headers.
    const completed = await Promise.all(Array.from({ length: 4 }, () => post(f, key)))
    for (const response of completed) {
      expect(created(response, body(f))).toEqual(winner)
      expect(response.headers['idempotent-replay']).toBe('true')
    }
    expect(await state(f)).toEqual(savedWinner); sameWhole(await whole(), queued.frames[0])
    const replies = [first, retry, ...completed]
    const selected = replies.map(r => created(r, body(f)))
    expect((await app.db!.query('select request_hash from idempotency_keys where key=$1', [`${f.couple.id}:${ROUTE}:${key}`])).rows)
      .toEqual([{ request_hash: sha(`${f.url}\n${JSON.stringify(body(f))}`) }])
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
    const money = await financial(f), keys = [randomUUID(), randomUUID()]
    const outcome = await prefixRace(f, 'last two additional keys', keys.map(key => () => post(f, key)), { captureWinner: true })
    const replies = outcome.replies
    expect(replies.map(r => r.statusCode).sort()).toEqual([201, 409])
    expect(replies[0]!.statusCode).toBe(201)
    const index = replies.findIndex(r => r.statusCode === 201), selected = created(replies[index]!, body(f))
    expect(replies[1]!.json<{ error: { code: string } }>().error.code).toBe('calendar_scope_changed')
    assert(outcome.frames[0]); expect(outcome.frames.filter(Boolean).length).toBe(1)
    const winner = outcome.frames[0]
    sameWhole(await whole(), winner)
    expect((await app.db!.query('select count(*)::int n from slots where wedding_id=$1', [f.wedding])).rows).toEqual([{ n: 100 }])
    const saved = await state(f)
    expect(saved.keys).toHaveLength(1); expect(saved.audit).toHaveLength(1); expect(saved.money).toEqual(money)
    await refused(f, () => post(f, randomUUID()), 409, 'slot_limit')
    sameWhole(await whole(), winner)
    expect(created(await post(f, keys[index]!), body(f))).toEqual(selected); expect(await state(f)).toEqual(saved)
    sameWhole(await whole(), winner)
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
    // The historical category writer really waits on this exact wedding SQL;
    // only the additional-command worker uses the new closed native prefix.
    const oldWedding = path === 'legacy' ? 'select id from weddings where id = $1 for update'
      : 'select archived_at, cancelled_at, tz from weddings where id = $1 for update'
    const outcome = await prefixRace(f, 'last additional versus ' + path,
      [() => path === 'legacy' ? legacySlot(f, 'video') : shortlist(f, vendor!), () => post(f)],
      { captureWinner: true, queries: [oldWedding, CALENDAR_PREFIX] })
    const [legacy, additional] = outcome.replies
    assert(legacy && additional)
    if (additional.statusCode === 201) expect(legacy.statusCode, legacy.body).toBe(409)
    else {
      expect(additional.statusCode, additional.body).toBe(409)
      expect(legacy.statusCode, legacy.body).toBe(path === 'legacy' ? 201 : 200)
    }
    const denied = additional.statusCode === 409 ? additional : legacy
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('calendar_scope_changed')
    assert(outcome.frames[0]); expect(outcome.frames.filter(Boolean).length).toBe(1)
    const winner = outcome.frames[0]
    sameWhole(await whole(), winner)
    const after = await state(f)
    expect(after.slots).toHaveLength(100); expect(after.money).toEqual(money)
    await refused(f, () => post(f, randomUUID()), 409, 'slot_limit')
    sameWhole(await whole(), winner)
    if (path === 'legacy') {
      const repeated = await refused(f, () => legacySlot(f, 'video'), 409, 'slot_exists')
      expect(repeated.json<{ error: { details: { slotId: string } } }>().error.details.slotId)
        .toBe(legacy.json<{ id: string }>().id)
    } else {
      const repeated = await shortlist(f, vendor!)
      expect(repeated.statusCode, repeated.body).toBe(200)
      expect(repeated.json<{ id: string }>().id).toBe(legacy.json<{ id: string }>().id)
    }
    expect(await state(f)).toEqual(after)
    sameWhole(await whole(), winner)
  })
  it.each(['deleted slot', 'changed slot', 'deleted event'] as const)('does not replay a stale %s or recreate its audit', async change => {
    const f = await fixture(), key = randomUUID(), selected = created(await post(f, key), body(f))
    if (change === 'changed slot') await app.db!.query('update slots set program_event_id=$2 where id=$1', [selected.id, f.main])
    else await app.db!.query('delete from slots where id=$1', [selected.id])
    if (change === 'deleted event') await app.db!.query('delete from wedding_events where id=$1', [f.event])
    await refused(f, () => post(f, key), change === 'deleted event' ? 404 : 409)
  })

  const CALENDAR_PREFIX = 'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope'
  type Whole = Record<string, string[]>
  type Identity = { pid: number; backend_start: string; xact_start: string; txid: string; database: string; principal: string }
  type PrefixWait = Wait & { backend_start: string; xact_start: string; xid: string; datname: string; usename: string;
    state: string; wait_event_type: string | null; holder_pid: number; holder_backend_start: string; holder_xact_start: string;
    holder_datname: string; holder_usename: string; holder_state: string }
  type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
  const reflected = <T>(p: Promise<T>): Promise<Outcome<T>> => p.then(value => ({ ok: true, value } as const), error => ({ ok: false, error } as const))
  function signal<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
  async function beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
    const left = deadline - performance.now(); assert(left > 0, 'Additional-slot prefix deadline expired')
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([p, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error('Additional-slot prefix deadline expired')), left)
    })]) } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  async function readySignal<T>(p: Promise<T>, tasks: Promise<Outcome<unknown>>[], deadline: number): Promise<T> {
    const result = await beforeDeadline(Promise.race([p.then(value => ({ ready: true as const, value })),
      ...tasks.map(task => task.then(outcome => ({ ready: false as const, outcome })))]), deadline)
    if (result.ready) return result.value
    if (!result.outcome.ok) throw result.outcome.error
    throw new Error('HTTP or holder completed before its native prefix witness')
  }
  async function identity(c: Queryable): Promise<Identity> {
    const r = (await c.query<Identity>(`select pg_backend_pid() pid,current_database() database,current_user principal,txid_current()::text txid,
      a.backend_start::text backend_start,a.xact_start::text xact_start from pg_stat_activity a where a.pid=pg_backend_pid()`)).rows[0]
    assert(r && Number.isSafeInteger(r.pid) && r.pid > 0 && r.backend_start && r.xact_start && /^[0-9]+$/.test(r.txid)); return r
  }
  async function whole(c: Queryable = app.db!): Promise<Whole> {
    const names = (await c.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename")).rows
    expect(names).toHaveLength(124)
    const result: Whole = {}
    for (const { tablename } of names) { assert(/^[a-z_][a-z0-9_]*$/.test(tablename)); result[tablename] = await rows(c, tablename, 'true', []) }
    return result
  }
  function sameWhole(actual: Whole, expected: Whole) {
    expect(Object.keys(actual)).toEqual(Object.keys(expected))
    for (const name of Object.keys(expected)) expect(JSON.stringify(actual[name]) === JSON.stringify(expected[name]), 'whole literal table ' + name).toBe(true)
  }
  async function prefixActivity(c: Queryable, h: Identity, workers: readonly Identity[]) {
    await c.query('select pg_stat_clear_snapshot()')
    return (await c.query<PrefixWait>(`select a.pid,a.backend_start::text backend_start,a.xact_start::text xact_start,a.backend_xid::text xid,
      a.datname,a.usename,a.state,a.wait_event_type,a.wait_event,a.query,pg_blocking_pids(a.pid) blockers,
      h.pid holder_pid,h.backend_start::text holder_backend_start,h.xact_start::text holder_xact_start,
      h.datname holder_datname,h.usename holder_usename,h.state holder_state
      from pg_stat_activity a join pg_stat_activity h on h.pid=$1 where a.pid=any($2::int[]) order by a.pid`,
    [h.pid, workers.map(w => w.pid)])).rows
  }
  function closedPrefix(activity: PrefixWait[], h: Identity, workers: readonly Identity[], queries: readonly string[]): boolean {
    expect(activity).toHaveLength(workers.length)
    const known = [h.pid, ...workers.map(w => w.pid)]
    for (const w of workers) {
      const r = activity.find(row => row.pid === w.pid); assert(r)
      expect([r.backend_start, r.xact_start, r.datname, r.usename]).toEqual([w.backend_start, w.xact_start, w.database, w.principal])
      expect(BigInt(r.xid)).toBe(BigInt(w.txid) % 4294967296n)
      expect([r.holder_pid, r.holder_backend_start, r.holder_xact_start, r.holder_datname, r.holder_usename])
        .toEqual([h.pid, h.backend_start, h.xact_start, h.database, h.principal])
      if (r.state !== 'active' || r.wait_event_type !== 'Lock' || r.holder_state !== 'idle in transaction'
        || r.query.trim().replace(/\s+/g, ' ') !== queries[workers.indexOf(w)] || !r.blockers.length
        || r.blockers.some(pid => !known.includes(pid) || pid === r.pid)) return false
    }
    const first = activity.find(r => r.pid === workers[0]!.pid)!
    return first.blockers.includes(h.pid) && (workers.length === 1 ||
      (activity.find(r => r.pid === workers[1]!.pid)!.blockers.includes(first.pid) && !first.blockers.includes(workers[1]!.pid)))
  }
  /** Only own armed HTTP transactions: original this, client, callback, result and errors are retained. */
  async function prefixRace(f: Fixture, change: string, commands: (() => Promise<Response>)[],
    options: { lock?: string; values?: readonly unknown[]; erase?: boolean; mutate?: (c: Queryable) => Promise<unknown>;
      blocked?: (holder: number, waiting: Wait) => Promise<void>; captureWinner?: boolean; queries?: readonly string[] } = {}) {
    assert(commands.length === 1 || commands.length === 2)
    const queries = options.queries ?? commands.map(() => CALENDAR_PREFIX); assert.equal(queries.length, commands.length)
    const db = app.db!, original = db.tx, invoke: Db['tx'] = original.bind(db)
    const held = signal<Identity>(), decision = signal<boolean>(), tasks: Promise<Outcome<Response>>[] = [], workers: Identity[] = []
    const frames: (Whole | undefined)[] = [], ended: (Outcome<Response> | undefined)[] = []
    let armed: { signal: ReturnType<typeof signal<Identity>>; index: number } | undefined
    let decided = false, installed = false, holderEnded: Outcome<void> | undefined, captures = 0
    const release = (commit: boolean) => { if (!decided) { decided = true; decision.resolve(commit) } }
    const delegate: Db['tx'] = <T>(body: (c: Queryable) => Promise<T>) => invoke<T>(async c => {
      const current = armed; assert(current, 'Only an armed additional-slot HTTP worker may enter Db.tx')
      armed = undefined; captures++; current.signal.resolve(await identity(c))
      const result = await body(c)
      // Observation only: the successful worker's actual uncommitted winning graph.
      if (options.captureWinner) frames[current.index] = await whole(c)
      return result
    })
    const holder = reflected(invoke(async c => {
      const h = await identity(c)
      await prepareLegacyCalendarScope(c, { weddingIds: [f.wedding],
        actor: { userId: f.couple.id, sessionId: f.couple.session, policyVersion: POLICY }, mode: options.erase ? 'erase' : 'write' })
      if (options.lock) await c.query(options.lock, options.values ?? [])
      held.resolve(h)
      if (await decision.promise) await options.mutate?.(c)
    })).then(outcome => { holderEnded = outcome; return outcome })
    let observer: Promise<Outcome<{ replies: Response[]; waiting: PrefixWait; frames: (Whole | undefined)[] }>> | undefined
    let result: { replies: Response[]; waiting: PrefixWait; frames: (Whole | undefined)[] } | undefined, failure: { error: unknown } | undefined
    try {
      const h = await readySignal(held.promise, [holder], performance.now() + 3000)
      const deadline = performance.now() + 3000 // original 3s budget includes worker identity setup and all queue witnesses
      observer = reflected(invoke(async c => {
        await c.query("set local statement_timeout='1000ms'")
        const o = await identity(c); assert.notEqual(o.pid, h.pid)
        expect([o.database, o.principal]).toEqual([h.database, h.principal])
        db.tx = delegate; installed = true
        let waiting: PrefixWait | undefined
        for (const start of commands) {
          const signalReady = signal<Identity>(), index = tasks.length; armed = { signal: signalReady, index }
          const task = reflected(Promise.resolve(start())).then(outcome => { ended[index] = outcome; return outcome }); tasks.push(task)
          const w = await readySignal(signalReady.promise, [holder, ...tasks], deadline)
          assert(![h.pid, o.pid, ...workers.map(x => x.pid)].includes(w.pid))
          expect([w.database, w.principal]).toEqual([h.database, h.principal]); workers.push(w); expect(captures).toBe(workers.length)
          let witness: PrefixWait[] | undefined
          while (performance.now() < deadline) {
            const early = holderEnded ?? ended.find(x => x !== undefined)
            if (early) { if (!early.ok) throw early.error; throw new Error('Additional-slot work settled before its actual wait') }
            const activity = await prefixActivity(c, h, workers)
            if (closedPrefix(activity, h, workers, queries)) { witness = activity; break }
            await new Promise<void>(yes => setTimeout(yes, 15))
          }
          assert(witness && performance.now() < deadline, 'No closed same-backend calendar-prefix wait within the original 3s budget')
          waiting = witness.find(r => r.pid === w.pid)!
          process.stdout.write('ADDITIONAL_SLOTS_CALENDAR_NATIVE_WAIT ' + JSON.stringify({ change, holder: h, workers: [...workers],
            observer: o, activity: witness, observedMs: performance.now(), deadlineMs: deadline }) + '\n')
        }
        assert(waiting)
        waits.push({ change, holder: h.pid, waiting })
        await options.blocked?.(h.pid, waiting)
        // In particular an expiry delay must still refer to these exact live PID/birth/XID paths.
        expect(closedPrefix(await prefixActivity(c, h, workers), h, workers, queries)).toBe(true)
        release(true)
        const committed = await holder; if (!committed.ok) throw committed.error
        const replies: Response[] = []
        for (const task of tasks) { const outcome = await task; if (!outcome.ok) throw outcome.error; replies.push(outcome.value) }
        return { replies, waiting, frames }
      }))
      const outcome = await observer; if (!outcome.ok) throw outcome.error
      result = outcome.value
    } catch (error) { failure = { error } } finally {
      release(false)
      const all = await Promise.all([holder, ...(observer ? [observer] : []), ...tasks])
      const other = all.flatMap(x => !x.ok && x.error !== failure?.error ? [x.error] : [])
      if (installed) { if (db.tx !== delegate) other.push(new Error('Additional-slot Db.tx observation owner changed')); db.tx = original }
      if (other.length) failure = { error: new AggregateError(failure ? [failure.error, ...other] : other, 'Additional-slot wait or drain failed') }
    }
    if (failure) throw failure.error
    assert(result); return result
  }
  async function waitedPrefix(f: Fixture, change: string, lock: string, values: readonly unknown[], mutate: (c: Queryable) => Promise<unknown>,
    start: () => Promise<Response>, blocked?: (holder: number, waiting: Wait) => Promise<void>, erase = false) {
    const result = await prefixRace(f, change, [start], { lock, values, mutate, blocked, erase })
    return { response: result.replies[0]!, waiting: result.waiting }
  }

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
    const outcome = await waitedPrefix(f, `${mode} ${change}`, `select * from ${table} where ${where} for update`, values, async c => {
      if (change === 'member') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', values)
      if (change === 'role') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", values)
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', values)
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where id=$1', values)
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', values)
    }, () => post(f, key), undefined, change === 'account')
    expect(outcome.waiting.query.trim().replace(/\s+/g, ' ')).toBe(CALENDAR_PREFIX)
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
    const wait = mode === 'replay' ? (...args: Parameters<typeof waited>) => waitedPrefix(f, ...args) : waited
    const outcome = await wait(`${mode} JWT expiry`, mode === 'new' ? 'lock table audit_log in share mode' : 'select id from slots where id=$1 for update',
      mode === 'new' ? [] : [selected], async () => undefined, async () => {
        exp = Math.floor(Date.now() / 1000) + 4
        caller = { ...f.couple, token: await signAccessToken(SECRET, { sub: f.couple.id, sid: f.couple.session }, (exp - ACCESS_TTL_SECONDS) * 1000) }
        expect(await verifyAccessToken(SECRET, caller.token)).toEqual({ sub: caller.id, sid: caller.session, exp })
        verifiedBeforeInvokeAtMs = Date.now()
        return post(f, key, body(f), caller)
      }, async (holder, waiting) => {
        if (mode === 'replay') expect(waiting.query.trim().replace(/\s+/g, ' ')).toBe(CALENDAR_PREFIX)
        else expect(waiting.query).toContain('insert into audit_log')
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
