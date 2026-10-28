import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disposablePgPort } from './disposablePgPort.js'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import type { ShortlistEntry } from '../src/routes/shortlist.js'

const DATABASE = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'catalogue-booking-mode-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
type Reply = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }
type Card = { id: string; city: string | null; bookingMode: 'legacy_day' | 'resources'; priceFrom: { amount: number; currency: string } | null;
  packages?: { id: string; price: { amount: number; currency: string } | null; includes: string[] }[]; phone?: string | null; published?: boolean; blocked?: boolean }

describe.skipIf(!DATABASE)('actual catalogue booking mode and concurrent first profile account mutex', () => {
  let app: FastifyInstance
  let dbGuarded = false
  const users = new Set<string>(), vendors = new Set<string>(), resources = new Set<string>(), weddings = new Set<string>(), shortlistIds = new Set<string>(), slotIds = new Set<string>()
  const city = { id: -randomInt(1_000_000, 2_000_000_000), name: `Synthetic catalogue city ${randomUUID()}`, region: 'Synthetic catalogue test region' }
  const waits: { change: string; holder: number; waiter: number; event: string | null; query: string }[] = []
  const prefix = String(randomInt(100_000, 999_999)); let sequence = 0
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_full_20260930_test', '/tili_ecosystem_allocations_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'catalogue-booking-mode-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name,current_user principal')).rows[0]!
    expect(['127.0.0.1', '::1']).toContain(live.address); expect(live.port).toBe(Number(disposablePgPort()))
    expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
    expect((await app.db!.query("select id from categories where id='florist'")).rows).toEqual([{ id: 'florist' }])
    dbGuarded = true
    // A named, exact numeric reference fixture: no existing city is overwritten.
    await app.db!.query('insert into cities(id,name,region) values($1,$2,$3)', [city.id, city.name, city.region])
  })
  afterAll(async () => {
    if (!app) return
    if (!dbGuarded) { await app.close(); return }
    try {
      // A failed first-creation assertion can still have created an own profile.
      for (const row of (await app.db!.query<{ id: string }>('select id from vendors where user_id=any($1::uuid[])', [[...users]])).rows) vendors.add(row.id)
      process.stdout.write(`CATALOG_BOOKING_MODE_PG_WAITS count=${waits.length} ${JSON.stringify(waits)}\n`)
      process.stdout.write(`CATALOG_BOOKING_MODE_FIXTURE_MANIFEST ${JSON.stringify({ database: new URL(DATABASE!).pathname.slice(1), users: [...users], vendors: [...vendors], resources: [...resources], weddings: [...weddings], slots: [...slotIds], shortlist: [...shortlistIds], city })}\n`)
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      await app.db!.query('delete from vendor_resources where id=any($1::uuid[])', [[...resources]])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      await app.db!.query('delete from resource_conflict_keys where identity=any($1::uuid[])', [[...resources, ...users]])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
      await app.db!.query('delete from cities where id=$1 and name=$2 and region=$3', [city.id, city.name, city.region])
    } finally { await app.close() }
  })
  async function actor() {
    const id = randomUUID(), session = randomUUID(); users.add(id)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic catalogue mode actor')", [id, `+79${prefix}${String(++sequence).padStart(4, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, session, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  function ok<T>(reply: Reply): T { expect(reply.statusCode, reply.body).toBe(200); return reply.json<T>() }
  function error(reply: Reply, code: string, status: number) { expect(reply.statusCode, reply.body).toBe(status); expect(reply.json<{ error: { code: string } }>().error.code).toBe(code) }
  async function fixture() {
    const owner = await actor(), reader = await actor(), vendor = randomUUID(), packageId = randomUUID(), name = `Synthetic catalogue ${randomUUID()}`
    vendors.add(vendor)
    // NULL city is a valid current catalogue value, not a made-up city string.
    await app.db!.query("insert into vendors(id,user_id,category_id,name,city_id,price_from,published_at,phone) values($1,$2,'florist',$3,null,25000,now(),'+79001234567')", [vendor, owner.id, name])
    await app.db!.query("insert into vendor_packages(id,vendor_id,name,price,items) values($1,$2,'Actual catalogue package',30000,$3::jsonb)", [packageId, vendor, JSON.stringify(['Declared bouquet', 'Delivery'])])
    const equipment = ok<{ id: string }>(await app.inject({ method: 'POST', url: `/vendors/${vendor}/resources`, headers: { ...owner.headers, 'idempotency-key': randomUUID() }, payload: { kind: 'equipment', label: 'Private catalogue vase identity' } })); resources.add(equipment.id)
    const capacity = ok<{ id: string }>(await app.inject({ method: 'POST', url: `/vendors/${vendor}/resources`, headers: { ...owner.headers, 'idempotency-key': randomUUID() }, payload: { kind: 'capacity', label: 'Private catalogue production', capacityUnit: 'bouquets' } })); resources.add(capacity.id)
    const window = ok<{ id: string }>(await app.inject({ method: 'POST', url: `/vendors/${vendor}/resources/${capacity.id}/windows`, headers: { ...owner.headers, 'idempotency-key': randomUUID() },
      payload: { startsAt: '2027-06-12T00:00:00Z', endsAt: '2027-06-18T23:00:00Z', capacity: 10 } }))
    return { owner, reader, vendor, packageId, name, equipment, capacity, window }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const detail = (f: Fixture, reader = f.reader) => app.inject({ url: `/catalog/vendors/${f.vendor}`, headers: reader.headers })
  const list = (f: Fixture, reader = f.reader, sort = 'price_asc') => app.inject({ url: `/catalog/vendors?q=${encodeURIComponent(f.name)}&categoryId=florist&sort=${sort}&limit=100`, headers: reader.headers })
  const mode = (f: Fixture, selected: 'resources' | 'legacy_day', expectedRevision: string) => app.inject({ method: 'PATCH', url: `/vendors/${f.vendor}/availability-policy`,
    headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: { mode: selected, expectedRevision } })
  function privacy(f: Fixture, reply: Reply) {
    for (const id of [f.owner.id, f.owner.session, f.equipment.id, f.capacity.id, f.window.id]) expect(reply.body).not.toContain(id)
    for (const label of ['Private catalogue vase identity', 'Private catalogue production']) expect(reply.body).not.toContain(label)
    // Match JSON property names: bookingMode:"resources" is a public enum,
    // while a "resources": property would expose the private resource list.
    for (const field of ['resources', 'windows', 'personUserId', 'staffMemberId', 'conflictIdentity', 'legacyObligations', 'changedBy', 'used', 'capacity', 'available', 'availableQuantity']) expect(reply.body).not.toContain(`"${field}":`)
    expect(reply.headers['cache-control']).toBe('no-store')
  }
  async function projected(f: Fixture, expected: 'resources' | 'legacy_day', sort = 'price_asc') {
    const d = await detail(f), l = await list(f, f.reader, sort), card = ok<Card>(d), cards = ok<{ items: Card[] }>(l).items
    expect(cards).toHaveLength(1); expect(cards[0]).toMatchObject({ id: f.vendor, city: null, bookingMode: expected, priceFrom: { amount: 25000, currency: 'RUB' } })
    expect(card).toMatchObject({ id: f.vendor, city: null, bookingMode: expected, priceFrom: { amount: 25000, currency: 'RUB' }, phone: null })
    expect(card.packages).toEqual([{ id: f.packageId, name: 'Actual catalogue package', price: { amount: 30000, currency: 'RUB' }, includes: ['Declared bouquet', 'Delivery'] }])
    privacy(f, d); privacy(f, l)
  }
  it('absent policy is legacy_day on real nullable-city catalogue detail and list, preserving actual quote', async () => {
    const f = await fixture(); expect((await app.db!.query('select mode from vendor_availability_policy where vendor_id=$1', [f.vendor])).rows).toEqual([])
    await projected(f, 'legacy_day')
  })
  it('resources and a later explicit legacy update appear in fresh catalogue reads without changing price/packages', async () => {
    const f = await fixture(), resourcesPolicy = ok<{ revision: string }>(await mode(f, 'resources', '0'))
    expect(resourcesPolicy.revision).toBe('1'); await projected(f, 'resources')
    expect(ok<{ revision: string }>(await mode(f, 'legacy_day', resourcesPolicy.revision)).revision).toBe('2'); await projected(f, 'legacy_day')
    expect((await app.db!.query('select price_from::text from vendors where id=$1', [f.vendor])).rows).toEqual([{ price_from: '25000' }])
  })
  it.each(['rating', 'price_asc', 'price_desc', 'popular'])('the actual %s listing uses the same current safe booking mode', async sort => {
    const f = await fixture(); ok(await mode(f, 'resources', '0')); await projected(f, 'resources', sort)
  })
  it('booking mode remains a strategy when capacity has no nominal units left and reveals no private counters', async () => {
    const f = await fixture(); ok(await mode(f, 'resources', '0'))
    await app.db!.query('update resource_capacity_windows set used=10,legacy_used=10 where id=$1', [f.window.id])
    await projected(f, 'resources')
    expect((await app.db!.query('select used,capacity from resource_capacity_windows where id=$1', [f.window.id])).rows).toEqual([{ used: 10, capacity: 10 }])
  })
  it.each(['unpublished', 'blocked', 'deleted_owner'] as const)('adding mode does not expose a currently %s company to another actor', async change => {
    const f = await fixture(); ok(await mode(f, 'resources', '0'))
    if (change === 'unpublished') await app.db!.query('update vendors set published_at=null where id=$1', [f.vendor])
    if (change === 'blocked') await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendor])
    if (change === 'deleted_owner') await app.db!.query('update users set deleted_at=now() where id=$1', [f.owner.id])
    const d = await detail(f), l = await list(f); error(d, 'not_found', 404); privacy(f, d); expect(ok<{ items: Card[] }>(l).items).toEqual([]); privacy(f, l)
    if (change !== 'deleted_owner') {
      const own = ok<Card>(await detail(f, f.owner)); expect(own).toMatchObject({ id: f.vendor, bookingMode: 'resources', published: change !== 'unpublished', blocked: change === 'blocked' })
    }
  })
  it.each(['missing', 'revoked_session', 'withdrawn_consent'] as const)('catalogue detail/list retain current %s authentication boundary', async change => {
    const f = await fixture()
    if (change === 'revoked_session') await app.db!.query('update sessions set revoked_at=now() where id=$1', [f.reader.session])
    if (change === 'withdrawn_consent') await app.db!.query('update consents set withdrawn_at=now() where user_id=$1', [f.reader.id])
    for (const url of [`/catalog/vendors/${f.vendor}`, `/catalog/vendors?q=${encodeURIComponent(f.name)}`]) {
      const reply = await app.inject({ url, ...(change === 'missing' ? {} : { headers: f.reader.headers }) })
      error(reply, change === 'withdrawn_consent' ? 'forbidden' : 'unauthorized', change === 'withdrawn_consent' ? 403 : 401); privacy(f, reply)
    }
  })

  async function wedding(person: Actor, date: string | null = '2027-06-14') {
    const id = randomUUID(), slot = randomUUID(); weddings.add(id); slotIds.add(slot)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic shortlist mode wedding',$3,'Europe/Moscow',$4)", [id, person.id, date, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [id, person.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Actual shortlist floral position')", [slot, id])
    return { wedding: id, slot }
  }
  async function shortlisted(f: Fixture, date: string | null = '2027-06-14') {
    const scope = await wedding(f.reader, date)
    const added = ok<{ id: string; slotId: string }>(await app.inject({ method: 'PUT', url: `/weddings/${scope.wedding}/shortlist/${f.vendor}`, headers: f.reader.headers }))
    expect(added.slotId).toBe(scope.slot); shortlistIds.add(added.id)
    return { ...scope, entryId: added.id }
  }
  type ShortlistScope = Awaited<ReturnType<typeof shortlisted>>
  const shortlist = (f: Fixture, scope: ShortlistScope, person = f.reader) => app.inject({ url: `/weddings/${scope.wedding}/slots/${scope.slot}/shortlist`, headers: person.headers })
  function shortlistVendorPrivacy(f: Fixture, reply: Reply, entry: ShortlistEntry) {
    // entry.available is the existing public live-profile/category flag.
    // Private resource/counter property bans apply to the vendor projection.
    privacy(f, { ...reply, body: JSON.stringify(entry.vendor) })
    for (const id of [f.owner.id, f.owner.session, f.capacity.id, f.equipment.id, f.window.id]) expect(reply.body).not.toContain(id)
    for (const label of ['Private catalogue vase identity', 'Private catalogue production']) expect(reply.body).not.toContain(label)
  }
  async function projectedShortlist(f: Fixture, scope: ShortlistScope, expectedMode: 'legacy_day' | 'resources', occupancy: ShortlistEntry['occupancy'], person = f.reader) {
    const reply = await shortlist(f, scope, person), entries = ok<ShortlistEntry[]>(reply)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry).toMatchObject({ id: scope.entryId, slotId: scope.slot, occupancy, available: true })
    expect(entry.vendor).toMatchObject({ id: f.vendor, city: null, bookingMode: expectedMode, priceFrom: { amount: 25000, currency: 'RUB' } })
    expect(entry.vendor!.packages).toEqual([{ id: f.packageId, name: 'Actual catalogue package', price: { amount: 30000, currency: 'RUB' }, includes: ['Declared bouquet', 'Delivery'] }])
    shortlistVendorPrivacy(f, reply, entry)
  }
  async function manualDay(f: Fixture) {
    const response = await app.inject({ method: 'POST', url: '/vendor/calendar/busy', headers: f.owner.headers, payload: { dates: ['2027-06-14'], status: 'busy' } })
    expect(response.statusCode, response.body).toBe(204)
    expect((await app.db!.query('select date::text,source from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows).toEqual([{ date: '2027-06-14', source: 'manual' }])
  }
  async function negotiationForOtherWedding(f: Fixture) {
    const other = await wedding(f.reader), deal = randomUUID()
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'candidate',30000)", [deal, other.wedding, other.slot, f.vendor])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [other.slot, deal])
    ok(await app.inject({ method: 'PATCH', url: `/deals/${deal}`, headers: { ...f.reader.headers, 'idempotency-key': randomUUID() }, payload: { state: 'negotiating' } }))
    expect((await app.db!.query('select state,negotiating_until>now() as active from deals where id=$1', [deal])).rows).toEqual([{ state: 'negotiating', active: true }])
    expect((await app.db!.query('select date from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows).toEqual([])
    return other
  }
  for (const policy of ['absent', 'explicit_legacy'] as const) {
    it.each(['free', 'held', 'busy'] as const)(`actual shortlist ${policy} policy preserves %s from real legacy sources`, async occupancy => {
      const f = await fixture(), scope = await shortlisted(f)
      if (occupancy === 'held') await negotiationForOtherWedding(f)
      if (occupancy === 'busy') await manualDay(f)
      if (policy === 'explicit_legacy') { ok(await mode(f, 'resources', '0')); ok(await mode(f, 'legacy_day', '1')) }
      await projectedShortlist(f, scope, 'legacy_day', occupancy)
    })
  }
  it.each(['empty', 'manual_busy'] as const)('actual resource shortlist refuses a false date-free/busy promise with a %s calendar', async calendar => {
    const f = await fixture(), scope = await shortlisted(f)
    if (calendar === 'manual_busy') await manualDay(f)
    else expect((await app.db!.query('select date from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows).toEqual([])
    ok(await mode(f, 'resources', '0')); await projectedShortlist(f, scope, 'resources', null)
  })
  it('actual shortlist mode switch reflects current policy and preserves the existing manual day and package price', async () => {
    const f = await fixture(), scope = await shortlisted(f); await manualDay(f)
    const dates = (await app.db!.query('select * from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows
    await projectedShortlist(f, scope, 'legacy_day', 'busy')
    ok(await mode(f, 'resources', '0')); await projectedShortlist(f, scope, 'resources', null)
    ok(await mode(f, 'legacy_day', '1')); await projectedShortlist(f, scope, 'legacy_day', 'busy')
    expect((await app.db!.query('select * from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows).toEqual(dates)
  })
  it('legacy shortlist recognises its own actual booked day as free for continuing that wedding', async () => {
    const f = await fixture(), scope = await shortlisted(f)
    ok(await app.inject({ method: 'POST', url: `/weddings/${scope.wedding}/slots/${scope.slot}/book`, headers: { ...f.reader.headers, 'idempotency-key': randomUUID() }, payload: { vendorId: f.vendor, packageId: f.packageId, price: { amount: 30000, currency: 'RUB' } } }))
    expect((await app.db!.query('select date::text,source from vendor_busy_dates where vendor_id=$1', [f.vendor])).rows).toEqual([{ date: '2027-06-14', source: 'deal' }])
    await projectedShortlist(f, scope, 'legacy_day', 'free')
  })
  it.each(['unpublished', 'blocked', 'deleted_owner'] as const)('actual shortlist keeps a %s entry private and omits booking mode/quote', async change => {
    const f = await fixture(), scope = await shortlisted(f); ok(await mode(f, 'resources', '0'))
    if (change === 'unpublished') await app.db!.query('update vendors set published_at=null where id=$1', [f.vendor])
    if (change === 'blocked') await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendor])
    if (change === 'deleted_owner') await app.db!.query('update users set deleted_at=now() where id=$1', [f.owner.id])
    const reply = await shortlist(f, scope), entry = ok<ShortlistEntry[]>(reply)[0]!
    expect(entry).toMatchObject({ id: scope.entryId, available: false, occupancy: null, vendor: { id: f.vendor, priceFrom: null, packages: [] } })
    expect(Object.hasOwn(entry.vendor!, 'bookingMode')).toBe(false); expect(reply.body).not.toContain('"bookingMode":'); shortlistVendorPrivacy(f, reply, entry)
  })
  it('legacy shortlist with an actual unknown wedding date reports no day occupancy', async () => {
    const f = await fixture(), scope = await shortlisted(f, null); await projectedShortlist(f, scope, 'legacy_day', null)
  })
  it('shortlist GET retains verified current team roles and foreign-scope privacy', async () => {
    const f = await fixture(), scope = await shortlisted(f), helper = await actor(), coordinator = await actor(), vendorRole = await actor(), outsider = await actor()
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper'),($1,$3,'coordinator'),($1,$4,'vendor')", [scope.wedding, helper.id, coordinator.id, vendorRole.id])
    for (const person of [f.reader, helper, coordinator]) await projectedShortlist(f, scope, 'legacy_day', 'free', person)
    error(await shortlist(f, scope, vendorRole), 'forbidden', 403)
    const denied = await shortlist(f, scope, outsider); error(denied, 'not_found', 404)
    for (const id of [f.vendor, f.packageId, scope.entryId, f.capacity.id]) expect(denied.body).not.toContain(id)
    await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [scope.wedding, helper.id])
    error(await shortlist(f, scope, helper), 'not_found', 404)
  })

  const profileBody = (name: string) => ({ name, categoryId: 'florist', city: { name: city.name, region: city.region }, priceFrom: { amount: 25000, currency: 'RUB' },
    packages: [{ name: 'Actual first package', price: { amount: 30000, currency: 'RUB' }, includes: ['Declared bouquet'] }] })
  const saveProfile = (person: Actor, name: string) => app.inject({ method: 'PUT', url: '/vendor/profile', headers: person.headers, payload: profileBody(name) })
  async function state(person: Actor, c: Queryable = app.db!) {
    const result: unknown[] = []
    for (const [table, where] of [
      ['users', 'id=$1'], ['sessions', 'user_id=$1'], ['consents', 'user_id=$1'], ['vendors', 'user_id=$1'],
      ['vendor_packages', 'vendor_id in(select id from vendors where user_id=$1)'], ['vendor_media', 'vendor_id in(select id from vendors where user_id=$1)'],
      ['vendor_availability_policy', 'vendor_id in(select id from vendors where user_id=$1)'], ['vendor_resources', 'vendor_id in(select id from vendors where user_id=$1)'],
      ['idempotency_keys', 'user_id=$1'], ['notifications', 'user_id=$1'], ['audit_log', 'actor_id=$1'],
    ]) result.push((await c.query(`select to_jsonb(t) row from ${table} t where ${where} order by to_jsonb(t)::text`, [person.id])).rows)
    return result
  }
  const PROFILE_PREFIX = 'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope'
  type ProfileIdentity = { pid: number; backend_start: string; xact_start: string; txid: string; database: string; principal: string }
  type ProfileTransaction = ProfileIdentity & { initiallyAbsent: boolean; prefixes: number; forwarded: string[] }
  type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
  const reflect = <T>(task: PromiseLike<T>): Promise<Outcome<T>> => Promise.resolve(task).then(value => ({ ok: true, value } as const), error => ({ ok: false, error } as const))
  function signal<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
  async function by<T>(task: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - performance.now(); assert(remaining > 0, 'Profile native readiness/witness deadline expired')
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([task, new Promise<never>((_yes, no) => { timer = setTimeout(() => no(new Error('Profile native readiness/witness deadline expired')), remaining) })]) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
  async function ready<T>(event: Promise<T>, tasks: readonly Promise<Outcome<unknown>>[], deadline: number): Promise<T> {
    const choice = await by(Promise.race([event.then(value => ({ kind: 'ready' as const, value })), ...tasks.map(task => task.then(outcome => ({ kind: 'ended' as const, outcome })))]), deadline)
    if (choice.kind === 'ready') return choice.value
    if (!choice.outcome.ok) throw choice.outcome.error
    throw new Error('Profile task completed before the required native phase')
  }
  function value<T>(outcome: Outcome<T>): T { if (!outcome.ok) throw outcome.error; return outcome.value }
  async function identity(c: Queryable): Promise<ProfileIdentity> {
    const rows = (await c.query<ProfileIdentity & QueryResultRow>(`select pg_backend_pid() pid,current_database() database,current_user principal,txid_current()::text txid,
      a.backend_start::text backend_start,a.xact_start::text xact_start from pg_stat_activity a where a.pid=pg_backend_pid()`)).rows
    expect(rows).toHaveLength(1); const row = rows[0]!
    assert(Number.isSafeInteger(row.pid) && row.pid > 0 && row.backend_start && row.xact_start && /^[0-9]+$/.test(row.txid)); return row
  }
  async function literalFrame(c: Queryable = app.db!) {
    const tables = (await c.query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename collate \"C\" ")).rows
    expect(tables).toHaveLength(124)
    const frame: Record<string, string[]> = {}
    for (const { name } of tables) frame[name] = (await c.query<{ raw: string }>(`select row_to_json(t)::text raw from public."${name.replaceAll('"', '""')}" t order by row_to_json(t)::text collate "C"`)).rows.map(r => r.raw)
    return frame
  }
  function captureProfile(db: Db, person: Actor, hooks: {
    beforePrefix?: (transaction: ProfileTransaction, index: number) => Promise<void>
    afterPrefix?: (transaction: ProfileTransaction, index: number) => Promise<void>
    afterBody?: (c: Queryable, transaction: ProfileTransaction, index: number) => Promise<void>
  } = {}) {
    const original = db.tx, invoke: Db['tx'] = original.bind(db), transactions: ProfileTransaction[] = []
    const delegate: Db['tx'] = <T>(body: (c: Queryable) => Promise<T>): Promise<T> => invoke(async c => {
      const transaction: ProfileTransaction = { ...await identity(c), initiallyAbsent: false, prefixes: 0, forwarded: [] }, index = transactions.push(transaction) - 1
      const originalQuery = c.query, query = originalQuery.bind(c)
      c.query = async <R extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) => {
        transaction.forwarded.push(sql)
        if (sql === PROFILE_PREFIX) { expect(transaction.initiallyAbsent).toBe(true); expect(transaction.prefixes++).toBe(0); await hooks.beforePrefix?.(transaction, index) }
        const result = await query<R>(sql, values)
        if (sql === 'select id from vendors where user_id=$1' && transaction.prefixes === 0) {
          expect(values?.[0]).toBe(person.id); expect(result.rows).toEqual([]); transaction.initiallyAbsent = true
        }
        if (sql === PROFILE_PREFIX) await hooks.afterPrefix?.(transaction, index)
        return result
      }
      try { const result = await body(c); await hooks.afterBody?.(c, transaction, index); return result }
      finally { c.query = originalQuery }
    })
    db.tx = delegate
    return { transactions, originalTx: invoke, restore: () => { const unchanged = db.tx === delegate; db.tx = original; assert(unchanged, 'Profile capture ownership changed') } }
  }
  async function observe(change: string, originalTx: Db['tx'], holder: ProfileIdentity, worker: ProfileIdentity, deadline: number) {
    assert.notEqual(holder.pid, worker.pid); expect(worker.database).toBe(holder.database); expect(worker.principal).toBe(holder.principal)
    await originalTx(async c => {
      await c.query("set local statement_timeout='1000ms'")
      const observer = await identity(c); expect([holder.pid, worker.pid]).not.toContain(observer.pid)
      while (performance.now() < deadline) {
        await c.query('select pg_stat_clear_snapshot()')
        const rows = (await c.query<ProfileIdentity & QueryResultRow & { state: string; wait_event_type: string | null; wait_event: string | null; query: string; blockers: number[]; xid: string | null;
          holder_backend_start: string; holder_xact_start: string; holder_state: string; holder_database: string; holder_principal: string; holder_xid: string | null }>(`select w.pid,w.backend_start::text backend_start,w.xact_start::text xact_start,w.datname database,w.usename principal,
          w.state,w.wait_event_type,w.wait_event,w.query,pg_blocking_pids(w.pid) blockers,w.backend_xid::text xid,
          h.backend_start::text holder_backend_start,h.xact_start::text holder_xact_start,h.state holder_state,h.datname holder_database,h.usename holder_principal,h.backend_xid::text holder_xid
          from pg_stat_activity w join pg_stat_activity h on h.pid=$1 where w.pid=$2 and w.datname=current_database()`, [holder.pid, worker.pid])).rows
        expect(rows).toHaveLength(1); const row = rows[0]!
        expect(row.backend_start).toBe(worker.backend_start); expect(row.xact_start).toBe(worker.xact_start)
        expect(row.database).toBe(worker.database); expect(row.principal).toBe(worker.principal)
        expect(row.holder_backend_start).toBe(holder.backend_start); expect(row.holder_xact_start).toBe(holder.xact_start)
        expect(row.holder_database).toBe(holder.database); expect(row.holder_principal).toBe(holder.principal)
        expect(row.xid).toBe(String(BigInt(worker.txid) % 4294967296n)); expect(row.holder_xid).toBe(String(BigInt(holder.txid) % 4294967296n))
        if (row.state === 'active' && row.wait_event_type === 'Lock' && row.holder_state === 'idle in transaction'
          && row.query.trim().replace(/\s+/g, ' ') === PROFILE_PREFIX && row.blockers.length === 1 && row.blockers[0] === holder.pid) {
          assert(performance.now() < deadline)
          waits.push({ change, holder: holder.pid, waiter: worker.pid, event: row.wait_event, query: row.query })
          process.stdout.write('CATALOG_PROFILE_NATIVE_PREFIX_WITNESS ' + JSON.stringify({ change, holder, worker, observer, query: PROFILE_PREFIX, blockers: row.blockers }) + '\n')
          return
        }
        await new Promise<void>(yes => setTimeout(yes, Math.min(25, Math.max(1, deadline - performance.now()))))
      }
      throw new Error(`${change}: no actual exact profile prefix blocker before the 3s deadline`)
    })
  }
  it('two initially absent profiles reach the real common prefix; the refused second save updates the same new company on a fresh PUT', async () => {
    const person = await actor(), db = app.db!, firstReady = signal<void>(), secondReady = signal<void>(), firstLocked = signal<void>()
    const allowFirst = signal<void>(), allowSecond = signal<void>(), completeFirst = signal<void>()
    let winnerFrame: Awaited<ReturnType<typeof literalFrame>> | undefined
    const capture = captureProfile(db, person, {
      beforePrefix: async (_transaction, index) => { expect(index === 0 || index === 1).toBe(true); if (index === 0) { firstReady.resolve(); await allowFirst.promise } else { secondReady.resolve(); await allowSecond.promise } },
      afterPrefix: async (_transaction, index) => { if (index === 0) { firstLocked.resolve(); await completeFirst.promise } },
      afterBody: async (c, _transaction, index) => { if (index === 0) winnerFrame = await literalFrame(c) },
    })
    const firstName = `Synthetic first profile ${randomUUID()}`, secondName = `Synthetic second profile ${randomUUID()}`
    const first = reflect(saveProfile(person, firstName)); let second: Promise<Outcome<Reply>> | undefined, witness: Promise<Outcome<void>> | undefined, failure: { error: unknown } | undefined
    try {
      await ready(firstReady.promise, [first], performance.now() + 3_000)
      second = reflect(saveProfile(person, secondName))
      await ready(secondReady.promise, [first, second], performance.now() + 3_000)
      expect(capture.transactions).toHaveLength(2); expect(capture.transactions.every(t => t.initiallyAbsent && t.prefixes === 1)).toBe(true)
      const deadline = performance.now() + 3_000
      allowFirst.resolve(); await ready(firstLocked.promise, [first, second], deadline); allowSecond.resolve()
      witness = reflect(observe('concurrent initially absent profile', capture.originalTx, capture.transactions[0]!, capture.transactions[1]!, deadline))
      value(await by(witness, deadline))
      completeFirst.resolve()
      const a = ok<Card>(value(await first)); vendors.add(a.id); error(value(await second), 'calendar_scope_changed', 409)
      assert(winnerFrame)
      expect(JSON.stringify(await literalFrame()) === JSON.stringify(winnerFrame)).toBe(true)
      expect((await db.query('select id,name from vendors where user_id=$1', [person.id])).rows).toEqual([{ id: a.id, name: firstName }])
      expect((await db.query('select count(*)::int n from vendor_packages where vendor_id=$1', [a.id])).rows).toEqual([{ n: 1 }])
      expect(capture.transactions[0]!.forwarded.filter(sql => /insert into vendors/.test(sql))).toHaveLength(1)
      expect(capture.transactions[1]!.forwarded.filter(sql => /(?:insert into|update) vendors/.test(sql))).toHaveLength(0)
    } catch (error) { failure = { error } } finally {
      allowFirst.resolve(); allowSecond.resolve(); completeFirst.resolve()
      const results = await Promise.all([first, ...(second ? [second] : []), ...(witness ? [witness] : [])])
      const errors = results.flatMap(result => !result.ok && result.error !== failure?.error ? [result.error] : [])
      try { capture.restore() } catch (error) { errors.push(error) }
      if (errors.length) failure = { error: new AggregateError(failure ? [failure.error, ...errors] : errors, 'Profile creation and drain failed', failure ? { cause: failure.error } : undefined) }
    }
    if (failure) throw failure.error
    const current = ok<Card>(await app.inject({ url: '/vendor/profile', headers: person.headers })), retried = ok<Card>(await saveProfile(person, secondName))
    expect(retried.id).toBe(current.id); expect((await db.query('select id,name from vendors where user_id=$1', [person.id])).rows).toEqual([{ id: current.id, name: secondName }])
    expect((await db.query('select count(*)::int n from vendor_packages where vendor_id=$1', [current.id])).rows).toEqual([{ n: 1 }])
  }, 15_000)
  it.each(['session', 'consent', 'account'] as const)('first profile creation rechecks current %s after an actual common-prefix wait', async change => {
    const person = await actor(), db = app.db!, originalTx: Db['tx'] = db.tx.bind(db), holderReady = signal<ProfileIdentity>(), permission = signal<void>()
    let expected: unknown, expectedFrame: Awaited<ReturnType<typeof literalFrame>> | undefined
    const holder = reflect(originalTx(async c => {
      const held = await identity(c), scope = await prepareLegacyCalendarScope(c, { personIds: [person.id], mode: 'erase' })
      await scope.assertCurrent(); holderReady.resolve(held); await permission.promise
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [person.session])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [person.id])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [person.id])
      expected = await state(person, c); expectedFrame = await literalFrame(c)
    }))
    let reply: Promise<Outcome<Reply>> | undefined, witness: Promise<Outcome<void>> | undefined, capture: ReturnType<typeof captureProfile> | undefined, failure: { error: unknown } | undefined
    try {
      const held = await ready(holderReady.promise, [holder], performance.now() + 3_000), workerReady = signal<ProfileTransaction>()
      capture = captureProfile(db, person, { beforePrefix: async (transaction, index) => { expect(index).toBe(0); workerReady.resolve(transaction) } })
      reply = reflect(saveProfile(person, `Synthetic blocked first creation ${randomUUID()}`))
      const deadline = performance.now() + 3_000, worker = await ready(workerReady.promise, [holder, reply], deadline)
      witness = reflect(observe(`first profile current ${change}`, originalTx, held, worker, deadline))
      value(await by(witness, deadline))
      permission.resolve(); value(await holder)
      const response = value(await reply); error(response, change === 'consent' ? 'forbidden' : 'unauthorized', change === 'consent' ? 403 : 401)
      expect(await state(person)).toEqual(expected); expect(response.body).not.toContain(person.id)
      assert(expectedFrame); expect(JSON.stringify(await literalFrame()) === JSON.stringify(expectedFrame)).toBe(true)
      expect((await db.query('select id from vendors where user_id=$1', [person.id])).rows).toEqual([])
    } catch (error) { failure = { error } } finally {
      permission.resolve()
      const results = await Promise.all([holder, ...(reply ? [reply] : []), ...(witness ? [witness] : [])])
      const errors = results.flatMap(result => !result.ok && result.error !== failure?.error ? [result.error] : [])
      try { capture?.restore() } catch (error) { errors.push(error) }
      if (errors.length) failure = { error: new AggregateError(failure ? [failure.error, ...errors] : errors, 'Profile invalidation and drain failed', failure ? { cause: failure.error } : undefined) }
    }
    if (failure) throw failure.error
  })
})