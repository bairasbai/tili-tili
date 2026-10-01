import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disposablePgPort } from './disposablePgPort.js'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
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
  async function observe(change: string, holderPid: number, waiterPid?: number) {
    let rows: { pid: number; wait_event: string | null; query: string }[] = []
    for (let attempt = 0; attempt < 120; attempt++) {
      rows = (await app.db!.query<{ pid: number; wait_event: string | null; query: string }>(`select pid,wait_event,query from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and ($2::int is null or pid=$2)`, [holderPid, waiterPid ?? null])).rows
      if (rows.length) break
      await new Promise<void>(r => setTimeout(r, 25))
    }
    expect(rows, `${change}: actual profile account mutex wait`).toHaveLength(1)
    expect(rows[0]!.query).toMatch(/^select id from users where id=\$1 for update$/)
    waits.push({ change, holder: holderPid, waiter: rows[0]!.pid, event: rows[0]!.wait_event, query: rows[0]!.query })
  }
  it('two initially absent profiles serialize on the actual account UPDATE mutex, return a bounded stale-scope response and retry cleanly', async () => {
    const person = await actor(), db = app.db!, originalTx: Db['tx'] = db.tx.bind(db)
    let firstReady!: () => void, bothReady!: () => void, firstLocked!: () => void, allowFirst!: () => void, allowSecond!: () => void, completeFirst!: () => void
    const firstPaused = new Promise<void>(r => { firstReady = r }), bothPaused = new Promise<void>(r => { bothReady = r }), hasMutex = new Promise<void>(r => { firstLocked = r })
    const firstPermission = new Promise<void>(r => { allowFirst = r }), secondPermission = new Promise<void>(r => { allowSecond = r }), finishPermission = new Promise<void>(r => { completeFirst = r })
    const transactions: { pid: number; initiallyAbsent: boolean; paused: boolean; forwarded: string[] }[] = []
    // No SQL result is replaced. Every original statement reaches its real
    // transaction client; this wrapper pauses exactly before the absent-owner
    // UPDATE mutex and keeps the first actual acquired lock until observed.
    db.tx = async <T>(action: (client: Queryable) => Promise<T>): Promise<T> => originalTx(async client => {
      const transaction = { pid: (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid, initiallyAbsent: false, paused: false, forwarded: [] as string[] }
      const index = transactions.push(transaction) - 1
      const wrapped: Queryable = { query: async <R extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) => {
        if (sql === 'select id from users where id=$1 for update' && values?.[0] === person.id) {
          expect(transaction.initiallyAbsent).toBe(true); expect(transaction.paused).toBe(false); transaction.paused = true
          if (index === 0) { firstReady(); await firstPermission }
          else { expect(index).toBe(1); bothReady(); await secondPermission }
          transaction.forwarded.push(sql)
          const response = await client.query<R>(sql, values)
          if (index === 0) { expect(response.rowCount).toBe(1); firstLocked(); await finishPermission }
          return response
        }
        transaction.forwarded.push(sql)
        const response = await client.query<R>(sql, values)
        if (sql === 'select id from vendors where user_id=$1' && !transaction.paused) {
          expect(values?.[0]).toBe(person.id); expect(response.rows).toEqual([]); transaction.initiallyAbsent = true
        }
        return response
      } }
      return action(wrapped)
    })
    const firstName = `Synthetic first profile ${randomUUID()}`, secondName = `Synthetic second profile ${randomUUID()}`
    const first = saveProfile(person, firstName); let second: Promise<Reply> | undefined
    try {
      await Promise.race([firstPaused, first.then(() => { throw new Error('First profile completed before the instrumented mutex') })])
      second = saveProfile(person, secondName)
      await Promise.race([bothPaused, second.then(() => { throw new Error('Second profile completed before locating absence') })])
      expect(transactions).toHaveLength(2); expect(transactions.every(t => t.initiallyAbsent && t.paused)).toBe(true)
      allowFirst(); await hasMutex; allowSecond(); await observe('concurrent initially absent profile', transactions[0]!.pid, transactions[1]!.pid)
      completeFirst()
      const a = ok<Card>(await first), b = await second; vendors.add(a.id); error(b, 'vendor_profile_scope_changed', 409)
      expect((await db.query('select id,name from vendors where user_id=$1', [person.id])).rows).toEqual([{ id: a.id, name: firstName }])
      expect((await db.query('select count(*)::int n from vendor_packages where vendor_id=$1', [a.id])).rows).toEqual([{ n: 1 }])
      expect(transactions[0]!.forwarded.filter(sql => /insert into vendors/.test(sql))).toHaveLength(1)
      expect(transactions[1]!.forwarded.some(sql => /insert into vendors/.test(sql))).toBe(false)
    } finally {
      allowFirst(); allowSecond(); completeFirst()
      try { await first; if (second) await second } finally { db.tx = originalTx }
    }
    const current = ok<Card>(await app.inject({ url: '/vendor/profile', headers: person.headers })), retried = ok<Card>(await saveProfile(person, secondName))
    expect(retried.id).toBe(current.id); expect((await db.query('select id,name from vendors where user_id=$1', [person.id])).rows).toEqual([{ id: current.id, name: secondName }])
    expect((await db.query('select count(*)::int n from vendor_packages where vendor_id=$1', [current.id])).rows).toEqual([{ n: 1 }])
  }, 15_000)
  it.each(['session', 'consent', 'account'] as const)('first profile creation rechecks current %s after an actual account mutex wait', async change => {
    const person = await actor()
    let release!: () => void, signal!: () => void, holderPid = 0, expected: unknown
    const permission = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { signal = r })
    const holder = app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query('select id from users where id=$1 for update', [person.id]); signal(); await permission
      if (change === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [person.session])
      if (change === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [person.id])
      if (change === 'account') await c.query('update users set deleted_at=now() where id=$1', [person.id])
      expected = await state(person, c)
    })
    await Promise.race([ready, holder.then(() => { throw new Error('Profile revocation holder exited early') })])
    const reply = saveProfile(person, `Synthetic blocked first creation ${randomUUID()}`)
    try {
      await observe(`first profile current ${change}`, holderPid); release(); await holder
      const response = await reply; error(response, change === 'consent' ? 'forbidden' : 'unauthorized', change === 'consent' ? 403 : 401)
      expect(await state(person)).toEqual(expected); expect(response.body).not.toContain(person.id)
      expect((await app.db!.query('select id from vendors where user_id=$1', [person.id])).rows).toEqual([])
    } finally { release(); await holder; await reply }
  })
})
