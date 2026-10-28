import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import { loadLegacyCalendarInventory, captureLegacyCalendarSource } from '../src/resources/legacy-source.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart } from '../src/orders/model.js'
import { saveOrderResourcePlan } from '../src/orders/resource-plan.js'
import { publishOrderTerms, loadOrderTerms, acceptOrderTerms } from '../src/orders/terms.js'
import { createResource, createCapacityWindow } from '../src/resources/model.js'
import { setAvailabilityPolicy } from '../src/resources/policy.js'
import { commitAgreedOrderResources } from '../src/resources/commitments.js'
import { disposablePgPort } from './disposablePgPort.js'

// Independent CONTRACT-v3 canonical requirements. Public-command assertions
// use existing HTTP handlers. Explicit legacy/storage fixtures are labelled,
// never produced by deleting tracking after a public booking.
const DATABASE = process.env.TEST_DATABASE_URL
const SECRET = 'atomic-day-f0-independent-access-'.repeat(3), POLICY = '2026-09-02'
const YEAR = new Date().getUTCFullYear() + 2, DATE = `${YEAR}-06-14`
const V = 'deal_day_scope_versions', H = 'deal_day_scope_heads'
type RawSnapshot = Record<string, string[]>
type Case = { label: string; explicit: boolean; date: string | null; tz: string | null }
type Version = { id: string; wedding_id: string; deal_id: string; slot_id: string; schema_version: number
  revision: string; previous_version_id: string | null; origin_knowledge: string | null; operation: string
  recorded_at: string; context_kind: string; event_id: string | null; performer_kind: string
  vendor_id: string | null; binding_state: string; service_date: string | null; time_zone: string | null
  day_id: string | null; is_current: boolean }

const catalogCases: Case[] = [
  { label: 'new implicit main dated', explicit: false, date: DATE, tz: 'Europe/Moscow' },
  { label: 'new explicit main dated unknown timezone', explicit: true, date: DATE, tz: null },
  { label: 'new implicit main NULL date and timezone', explicit: false, date: null, tz: null },
  { label: 'new explicit main NULL date known timezone', explicit: true, date: null, tz: 'Asia/Novosibirsk' },
]
const offerCases: Case[] = [
  { label: 'implicit main', explicit: false, date: DATE, tz: 'Europe/Moscow' },
  { label: 'explicit main', explicit: true, date: DATE, tz: 'Asia/Novosibirsk' },
]
const externalCases: Case[] = [
  { label: 'implicit main NULL date and timezone', explicit: false, date: null, tz: null },
  { label: 'explicit main dated', explicit: true, date: DATE, tz: 'Europe/Moscow' },
]

describe.sequential('T009 independent atomic main DATE contract', () => {
  let app: FastifyInstance | undefined, guarded = false
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>()
  const slots = new Set<string>(), deals = new Set<string>(), versions = new Set<string>()
  const resources = new Set<string>()
  const observedAudits = new Map<string, string>()
  const db = () => { assert(app?.db); return app.db }
  const witness = (phase: string, value: unknown) => process.stdout.write(`ATOMIC_DAY_F0_${phase} ${JSON.stringify(value)}\n`)
  const raw = async (table: string, where = '', values: readonly unknown[] = []) =>
    (await db().query<{ row: string }>(`select row_to_json(t)::text row from "${table}" t ${where} order by row_to_json(t)::text`, values)).rows.map(r => r.row)
  function rememberAudits(rows: string[]) {
    for (const row of rows) {
      const id = String((JSON.parse(row) as { id: string | number }).id)
      assert.match(id, /^[1-9][0-9]*$/)
      if (observedAudits.has(id)) expect(row, `observed audit ${id} changed`).toBe(observedAudits.get(id))
      observedAudits.set(id, row)
    }
  }

  beforeAll(async () => {
    assert(DATABASE, 'Explicit native TEST_DATABASE_URL required; no skip/fallback')
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const url = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.port, '15432'); assert.equal(disposablePgPort(), '15432'); assert.equal(url.username, 'codex_test')
    assert(['/tili_day_atomic_20261021_test', '/tili_ecosystem_full_20260930_test'].includes(url.pathname))
    assert.equal(url.search, ''); assert.equal(url.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'atomic-f0-synthetic-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const identity = (await db().query<{ name: string; oid: string; role: string; owner: string; address: string; port: number
      data: string; systemid: string; pid: number; postmaster_started: string }>(`select current_database() name,
      (select oid::text from pg_database where datname=current_database()) oid,current_user role,
      (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) owner,
      host(inet_server_addr()) address,inet_server_port() port,current_setting('data_directory') data,
      (select system_identifier::text from pg_control_system()) systemid,pg_backend_pid() pid,
      pg_postmaster_start_time()::text postmaster_started`)).rows[0]!
    assert.equal(identity.name, url.pathname.slice(1)); assert.equal(identity.role, 'codex_test'); assert.equal(identity.owner, 'codex_test')
    assert.equal(identity.address, '127.0.0.1'); assert.equal(identity.port, 15432)
    assert(/^\d+$/.test(identity.oid) && /^\d+$/.test(identity.systemid) && identity.pid > 0 && identity.data.length > 0)
    assert(Number.isFinite(Date.parse(identity.postmaster_started)))
    const journal = (await db().query<{ name: string }>('select name from pgmigrations order by name')).rows.map(r => r.name)
    assert([88, 89, 90, 91, 92, 93, 94].includes(journal.length), 'Root separately admits exact88 RED or reviewed89/90/91/92/93/94; F0 does not require89')
    assert(journal.includes('1763850000000_deal_day_scope_foundation') && journal.includes('1763860000000_deal_day_scope_undated_terminal'))
    witness('IDENTITY', { identity, journal, scope: 'F0_PUBLIC_MAIN_ACQUIRE_ONLY', production: false })
    rememberAudits(await raw('audit_log')); guarded = true
  })

  afterAll(async () => {
    if (!app) return
    try {
      if (!guarded) return
      rememberAudits(await raw('audit_log'))
      witness('FIXTURES', { users: [...users], weddings: [...weddings], vendors: [...vendors], resources: [...resources], slots: [...slots], deals: [...deals], versions: [...versions] })
      // Delete only recorded synthetic parents, never history/audits directly.
      for (const id of weddings) await db().query('delete from weddings where id=$1', [id])
      for (const id of vendors) await db().query('delete from vendors where id=$1', [id])
      await db().query('delete from resource_conflict_keys where identity=any($1::uuid[])', [[...resources, ...users]])
      for (const id of users) await db().query('delete from users where id=$1', [id])
      for (const [table, ids] of [['users', users], ['weddings', weddings], ['vendors', vendors], ['slots', slots], ['deals', deals]] as const)
        expect((await db().query(`select id from ${table} where id=any($1::uuid[])`, [[...ids]])).rows).toEqual([])
      for (const table of [V, H, 'deal_orders'])
        expect((await db().query(`select deal_id from ${table} where wedding_id=any($1::uuid[])`, [[...weddings]])).rows).toEqual([])
      expect((await db().query('select id from vendor_busy_dates where vendor_id=any($1::uuid[])', [[...vendors]])).rows).toEqual([])
      for (const table of ['sessions', 'consents', 'idempotency_keys', 'notifications'])
        expect((await db().query(`select user_id from ${table} where user_id=any($1::uuid[])`, [[...users]])).rows).toEqual([])
      const after = await raw('audit_log'), byID = new Map(after.map(row => [String((JSON.parse(row) as { id: string | number }).id), row]))
      witness('AUDIT_CLEANUP', { observed: [...observedAudits].map(([id, row]) => ({ id, row })), after })
      for (const [id, row] of observedAudits) expect(byID.get(id), `audit ${id} retained literally`).toBe(row)
      witness('CLEANUP', { ownRowsAbsent: true, allObservedAuditsRetained: true })
    } finally { await app.close() }
  })

  async function actor() {
    const id = randomUUID(), sid = randomUUID(); let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) inserted = (await db().query(
      "insert into users(id,phone,name) values($1,$2,'Synthetic independent atomic F0 actor') on conflict(phone) do nothing returning id",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])).rowCount === 1
    assert(inserted); users.add(id)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, sid, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor) => ({ ...auth(a), 'idempotency-key': randomUUID() })
  async function fixture(c: Case) {
    const pair = await actor(), company = await actor(), weddingId = randomUUID(), vendorId = randomUUID(), slotId = randomUUID()
    weddings.add(weddingId); vendors.add(vendorId); slots.add(slotId)
    await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic F0 company',now())", [vendorId, company.id])
    await db().query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic F0 main',$3,$4,$5)", [weddingId, pair.id, c.date, c.tz, randomUUID()])
    await db().query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, pair.id])
    const main = (await db().query<{ id: string; date: string | null; time_zone: string | null }>(
      'select id,date::text,time_zone from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows
    assert.equal(main.length, 1); const eventId = main[0]!.id
    assert.equal(main[0]!.date, c.date); assert.equal(main[0]!.time_zone, c.tz)
    await db().query("insert into slots(id,wedding_id,category_id,label,program_event_id) values($1,$2,'photo','Synthetic F0 selected position',$3)", [slotId, weddingId, c.explicit ? eventId : null])
    return { ...c, pair, company, weddingId, vendorId, slotId, eventId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  async function call(phase: string, actor: Actor, options: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET'; url: string; headers: Record<string, string>; payload?: Record<string, unknown> }) {
    assert(app)
    const response = await app.inject(options)
    witness('HTTP', { phase, actorId: actor.id, sessionId: actor.sid, method: options.method, url: options.url,
      payload: options.payload ?? null, idempotencyKey: options.headers['idempotency-key'] ?? null,
      status: response.statusCode, body: response.body, idempotentReplay: response.headers['idempotent-replay'] ?? null })
    rememberAudits(await raw('audit_log'))
    return response
  }
  async function snapshot(f: Fixture): Promise<RawSnapshot> {
    const result: RawSnapshot = {}
    for (const table of ['weddings', 'wedding_events', 'slots', 'deals', 'deal_orders', 'order_assignments', 'order_parts', V, H])
      result[table] = await raw(table, table === 'weddings' ? 'where t.id=$1' : 'where t.wedding_id=$1', [f.weddingId])
    result.busy = await raw('vendor_busy_dates', 'where t.vendor_id=$1', [f.vendorId])
    result.requests = await raw('offer_requests', 'where t.slot_id=$1', [f.slotId])
    result.offers = await raw('offers', 'where t.request_id in(select id from offer_requests where slot_id=$1)', [f.slotId])
    result.receipts = await raw('idempotency_keys', 'where t.user_id=any($1::uuid[])', [[f.pair.id, f.company.id]])
    result.audit = await raw('audit_log'); rememberAudits(result.audit)
    return result
  }

  async function assertAcquire(f: Fixture, door: 'catalog' | 'offer' | 'external', response: { statusCode: number; body: string }) {
    const state = await snapshot(f)
    const roots = (await db().query<{ id: string; state: string; price: string; currency: string; vendor_id: string | null }>(
      'select id,state,price::text,currency,vendor_id from deals where wedding_id=$1', [f.weddingId])).rows
    for (const root of roots) deals.add(root.id)
    const scope = (await db().query<Version>(`select v.id,v.wedding_id,v.deal_id,v.slot_id,v.schema_version,v.revision::text,
      v.previous_version_id,v.origin_knowledge,v.operation,v.recorded_at::text,v.context_kind,v.event_id,v.performer_kind,
      v.vendor_id,v.binding_state,v.service_date::text,v.time_zone,v.day_id,deal_day_scope_matches_current(v) is_current
      from deal_day_scope_versions v where v.wedding_id=$1 order by v.revision`, [f.weddingId])).rows
    for (const v of scope) versions.add(v.id)
    const heads = (await db().query<{ deal_id: string; wedding_id: string; revision: string; current_version_id: string }>(
      'select deal_id,wedding_id,revision::text,current_version_id from deal_day_scope_heads where wedding_id=$1', [f.weddingId])).rows
    const days = (await db().query<{ id: string; service_date: string; source: string; deal_id: string | null }>(
      'select id,date::text as service_date,source,deal_id from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId])).rows
    // Preserve native outcome before every expected-success assertion, including
    // the first meaningful applied88 failure (versions=[] after actual HTTP200).
    witness('ACQUIRE_EXPECT_SUCCESS', { phase: 'POST_HTTP_NATIVE_READBACK', door, fixture: { weddingId: f.weddingId, slotId: f.slotId,
      eventId: f.eventId, vendorId: f.vendorId, explicit: f.explicit, date: f.date, tz: f.tz },
    response: { status: response.statusCode, body: response.body }, roots, scope, heads, days, state })
    expect(response.statusCode, response.body).toBe(200)
    expect(roots).toHaveLength(1); const root = roots[0]!
    expect(root).toMatchObject({ state: 'booked', price: '17000', currency: 'RUB', vendor_id: door === 'external' ? null : f.vendorId })
    expect(state.deal_orders).toHaveLength(1)
    expect(scope, 'Expected one current acquire from the actual public main command; applied88 RED is absent tracking, not a missing import').toHaveLength(1)
    const v = scope[0]!
    expect(v).toMatchObject({ wedding_id: f.weddingId, deal_id: root.id, slot_id: f.slotId, schema_version: 1,
      revision: '1', previous_version_id: null, origin_knowledge: 'observed_tracking', operation: 'acquire',
      context_kind: f.explicit ? 'explicit_main' : 'implicit_main', event_id: f.eventId,
      performer_kind: door === 'external' ? 'external' : 'catalog', vendor_id: door === 'external' ? null : f.vendorId,
      binding_state: door === 'external' ? 'external' : f.date === null ? 'undated' : 'active',
      service_date: f.date, time_zone: f.tz, is_current: true })
    expect(Number.isFinite(Date.parse(v.recorded_at))).toBe(true)
    expect(heads).toEqual([{ deal_id: root.id, wedding_id: f.weddingId, revision: '1', current_version_id: v.id }])
    if (door !== 'external' && f.date !== null) {
      expect(days).toHaveLength(1)
      expect(days[0]).toMatchObject({ service_date: f.date, source: 'deal', deal_id: root.id })
      expect(v.day_id).toBe(days[0]!.id)
    } else { expect(days).toEqual([]); expect(v.day_id).toBeNull() }
    expect((JSON.parse(state.slots![0]!) as { deal_id: string }).deal_id).toBe(root.id)
    if (door === 'offer') {
      expect(state.requests).toHaveLength(1); expect(state.offers).toHaveLength(1)
      expect(JSON.parse(state.requests![0]!) as { status: string }).toMatchObject({ status: 'closed' })
      expect((JSON.parse(state.offers![0]!) as { accepted_at: string | null }).accepted_at).not.toBeNull()
    }
  }

  it.each(catalogCases)('F0 catalog $label creates one observed main acquire', async c => {
    const f = await fixture(c), response = await call('CATALOG_BOOK', f.pair, { method: 'POST',
      url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: idem(f.pair),
      payload: { vendorId: f.vendorId, price: { amount: 17000, currency: 'RUB' } } })
    await assertAcquire(f, 'catalog', response)
  })

  it.each(offerCases)('F0 genuine offer request reply accept $label creates one observed main acquire', async c => {
    const f = await fixture(c)
    const added = await call('SHORTLIST', f.pair, { method: 'PUT', url: `/weddings/${f.weddingId}/shortlist/${f.vendorId}`,
      headers: auth(f.pair), payload: { slotId: f.slotId } })
    expect(added.statusCode, added.body).toBe(200)
    const entries = (await db().query<{ id: string }>('select id from slot_shortlist where slot_id=$1 and vendor_id=$2', [f.slotId, f.vendorId])).rows
    expect(entries).toHaveLength(1)
    const requested = await call('OFFER_REQUEST', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/offer-requests`,
      headers: idem(f.pair), payload: { entryIds: [entries[0]!.id] } })
    expect(requested.statusCode, requested.body).toBe(201)
    const requests = (await db().query<{ id: string; wedding_date: string }>('select id,wedding_date::text from offer_requests where slot_id=$1 and vendor_id=$2', [f.slotId, f.vendorId])).rows
    expect(requests).toHaveLength(1); expect(requests[0]!.wedding_date).toBe(f.date)
    const replied = await call('VENDOR_REPLY', f.company, { method: 'POST', url: `/vendor/offer-requests/${requests[0]!.id}/offers`,
      headers: idem(f.company), payload: { kind: 'offer', title: 'Actual F0 agreed photography', price: { amount: 17000, currency: 'RUB' },
        includes: ['Photography'], validUntil: `${YEAR}-06-13` } })
    expect(replied.statusCode, replied.body).toBe(201)
    const offers = (await db().query<{ id: string }>('select id from offers where request_id=$1 and superseded_at is null', [requests[0]!.id])).rows
    expect(offers).toHaveLength(1)
    const accepted = await call('OFFER_ACCEPT', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/offers/${offers[0]!.id}/accept`, headers: idem(f.pair) })
    await assertAcquire(f, 'offer', accepted)
  })

  it.each(externalCases)('F0 external $label creates one observed main acquire without vendor DATE', async c => {
    const f = await fixture(c), response = await call('EXTERNAL_BOOK', f.pair, { method: 'POST',
      url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair),
      payload: { vendorName: 'Actual F0 outside photographer', price: { amount: 17000, currency: 'RUB' } } })
    await assertAcquire(f, 'external', response)
  })

  // All-record snapshots are for atomic/no-write comparisons, not counts.
  async function whole(c: Queryable = db()): Promise<RawSnapshot> {
    const names = (await c.query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(r => r.name)
    const result: RawSnapshot = {}
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/)
      result[name] = (await c.query<{ row: string }>(`select row_to_json(t)::text row from "${name}" t order by row_to_json(t)::text`)).rows.map(r => r.row)
    }
    rememberAudits(result.audit_log!); return result
  }
  async function ledger(f: Fixture, dealId?: string) {
    const id = dealId ?? (await db().query<{ deal_id: string }>('select deal_id from slots where id=$1', [f.slotId])).rows[0]?.deal_id
    assert(id); deals.add(id)
    const rows = (await db().query<Version>(`select v.id,v.wedding_id,v.deal_id,v.slot_id,v.schema_version,v.revision::text,
      v.previous_version_id,v.origin_knowledge,v.operation,v.recorded_at::text,v.context_kind,v.event_id,v.performer_kind,
      v.vendor_id,v.binding_state,v.service_date::text,v.time_zone,v.day_id,deal_day_scope_matches_current(v) is_current
      from deal_day_scope_versions v where v.wedding_id=$1 and v.deal_id=$2 order by revision`, [f.weddingId, id])).rows
    rows.forEach(v => versions.add(v.id)); return { id, rows, current: rows.at(-1)! }
  }
  async function book(f: Fixture, key = randomUUID(), vendorId = f.vendorId) {
    const r = await call('BOOK', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: { ...auth(f.pair), 'idempotency-key': key },
      payload: { vendorId, price: { amount: 17000, currency: 'RUB' } } })
    expect(r.statusCode, r.body).toBe(200); return ledger(f)
  }
  const patch = (f: Fixture, id: string, state: string, key = randomUUID(), price?: number) => call('STATE', f.pair, { method: 'PATCH', url: `/deals/${id}`,
    headers: { ...auth(f.pair), 'idempotency-key': key }, payload: { state, ...(price === undefined ? {} : { price: { amount: price, currency: 'RUB' } }) } })
  const cancel = (f: Fixture, key = randomUUID()) => call('CANCEL', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/cancel`, headers: { ...auth(f.pair), 'idempotency-key': key } })
  const tuple = (v: Version) => Object.fromEntries(['wedding_id', 'deal_id', 'slot_id', 'context_kind', 'event_id', 'performer_kind', 'vendor_id', 'service_date', 'time_zone', 'day_id'].map(k => [k, v[k as keyof Version]]))
  const moneyTables = ['deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts', 'payments', 'payment_installments', 'payment_corrections', 'payment_installment_edits']
  async function money(id: string) {
    const result: RawSnapshot = {}; for (const t of moneyTables) result[t] = await raw(t, 'where t.deal_id=$1', [id]); return result
  }
  async function sibling(f: Fixture, vendorId = f.vendorId, explicit = f.explicit): Promise<Fixture> {
    const slotId = randomUUID(); slots.add(slotId)
    await db().query("insert into slots(id,wedding_id,category_id,label,program_event_id) values($1,$2,'photo','Independent second position',$3)", [slotId, f.weddingId, explicit ? f.eventId : null])
    return { ...f, slotId, vendorId, explicit }
  }
  async function newVendor(f: Fixture) {
    const owner = await actor(), id = randomUUID(); vendors.add(id)
    await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Independent next company',now())", [id, owner.id])
    return { id, owner, fixture: { ...f, vendorId: id, company: owner } }
  }
  async function move(f: Fixture, date: string, door: 'reschedule' | 'wedding' | 'event' = 'reschedule', tz?: string) {
    if (door === 'event') {
      const before = await call('EVENT_READ', f.pair, { method: 'GET', url: `/weddings/${f.weddingId}/events`, headers: auth(f.pair) })
      expect(before.statusCode).toBe(200); assert(typeof before.headers.etag === 'string')
      return call('EVENT_MOVE', f.pair, { method: 'PATCH', url: `/weddings/${f.weddingId}/events/${f.eventId}`, headers: { ...auth(f.pair), 'if-match': before.headers.etag }, payload: { date, ...(tz === undefined ? {} : { timeZone: tz }) } })
    }
    return call('MAIN_MOVE', f.pair, { method: door === 'wedding' ? 'PATCH' : 'POST', url: `/weddings/${f.weddingId}${door === 'wedding' ? '' : '/reschedule'}`,
      headers: idem(f.pair), payload: { date, ...(tz === undefined ? {} : { tz }) } })
  }
  async function group(day: string) {
    return (await db().query<{ day_id: string; vendor_id: string; service_date: string; wedding_id: string | null; classification: string; legacy_candidates: string[]; revision: string }>(
      'select day_id,vendor_id,service_date::text,wedding_id,classification,legacy_candidates,revision::text from legacy_day_groups where day_id=$1', [day])).rows[0]
  }
  // Explicit historical SQL fixture, never a public booking/backfill claim.
  async function legacy(f: Fixture, state = 'booked', makeDay = true, date = f.date) {
    const id = randomUUID(); deals.add(id)
    await db().query(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,currency,booked_at)
      values($1,$2,$3,$4,$5,17000,'RUB',clock_timestamp())`, [id, f.weddingId, f.slotId, f.vendorId, state])
    await db().query('update slots set deal_id=$2 where id=$1', [f.slotId, id])
    if (makeDay && date !== null) await db().query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3) on conflict(vendor_id,date) do nothing", [f.vendorId, date, id])
    expect((await db().query('select id from deal_day_scope_versions where deal_id=$1', [id])).rows).toEqual([])
    return id
  }
  async function candidate(f: Fixture) {
    const created = await call('FIXTURE_RESOURCE', f.company, { method: 'POST', url: `/vendors/${f.vendorId}/resources`, headers: idem(f.company), payload: { kind: 'equipment', label: 'Independent candidate setup' } })
    expect(created.statusCode, created.body).toBe(200)
    resources.add(created.json<{ id: string }>().id)
    const policy = await call('FIXTURE_POLICY_RESOURCES', f.company, { method: 'PATCH', url: `/vendors/${f.vendorId}/availability-policy`, headers: idem(f.company), payload: { mode: 'resources', expectedRevision: '0' } })
    expect(policy.statusCode, policy.body).toBe(200)
    const prepared = await call('CANDIDATE_PREPARE', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/resource-order`, headers: idem(f.pair),
      payload: { vendorId: f.vendorId, packageId: null, expectedSelectedDealId: null, expectedPolicyRevision: policy.json<{ revision: string }>().revision } })
    expect(prepared.statusCode, prepared.body).toBe(200)
    const id = prepared.json<{ dealId: string }>().dealId; deals.add(id)
    const down = await call('FIXTURE_POLICY_LEGACY', f.company, { method: 'PATCH', url: `/vendors/${f.vendorId}/availability-policy`, headers: idem(f.company), payload: { mode: 'legacy_day', expectedRevision: policy.json<{ revision: string }>().revision } })
    expect(down.statusCode, down.body).toBe(200)
    expect((await db().query('select id from resource_allocations where vendor_id=$1', [f.vendorId])).rows).toEqual([])
    return id
  }
  async function replace(f: Fixture, id: string, next: string, key = randomUUID()) {
    const state = (await db().query<{ state: string }>('select state from deals where id=$1', [id])).rows[0]!.state
    const revision = (await db().query<{ revision: string }>('select revision::text from vendor_availability_policy where vendor_id=$1', [next])).rows[0]?.revision ?? '0'
    return call('REPLACE', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/replace`, headers: { ...auth(f.pair), 'idempotency-key': key },
      payload: { expectedSelectedDealId: id, expectedSelectedDealState: state, vendorId: next, price: { amount: 18000, currency: 'RUB' }, expectedPolicyRevision: revision } })
  }

  // R1: real public candidate and all nine first-COMMITTED transitions.
  const first = (['candidate', 'contacted', 'negotiating'] as const).flatMap(from => (['booked', 'paid_deposit', 'done'] as const).map(to => ({ from, to })))
  it.each(first)('R1 PATCH first COMMITTED $from to $to appends exact main once with price', async ({ from, to }) => {
    const f = await fixture(catalogCases[0]!), id = await candidate(f)
    if (from !== 'candidate') { const r = await patch(f, id, from); expect(r.statusCode, r.body).toBe(200) }
    const before = await money(id), r = await patch(f, id, to, randomUUID(), 17000), l = await ledger(f, id)
    witness('FIRST_COMMITTED', { from, to, status: r.statusCode, body: r.body, ledger: l, raw: await whole() })
    expect(r.statusCode, r.body).toBe(200); expect(l.rows).toHaveLength(1)
    expect(l.current).toMatchObject({ revision: '1', previous_version_id: null, origin_knowledge: 'legacy_unknown',
      binding_state: to === 'done' ? 'done_retained' : 'active', service_date: f.date, time_zone: f.tz, event_id: f.eventId, is_current: true })
    expect(await money(id)).toEqual(before)
  })
  it.each([false, true])('R1 NULL first done explicit=%s uses observe_done without manufactured booked predecessor', async explicit => {
    const f = await fixture({ ...catalogCases[2]!, explicit }), id = await candidate(f)
    const r = await patch(f, id, 'done'), l = await ledger(f, id)
    witness('OBSERVE_DONE', { status: r.statusCode, body: r.body, ledger: l, raw: await whole() })
    expect(r.statusCode, r.body).toBe(200); expect(l.rows).toHaveLength(1)
    expect(l.current).toMatchObject({ revision: '1', previous_version_id: null, operation: 'observe_done', origin_knowledge: 'legacy_unknown', binding_state: 'done_undated', service_date: null, day_id: null, time_zone: null, is_current: true })
    expect((await db().query('select from_state,to_state from deal_events where deal_id=$1 order by at,id', [id])).rows).not.toContainEqual({ from_state: 'candidate', to_state: 'booked' })
  })
  it('R1 exact replay is one immutable ledger while changed body conflicts and current ACL refuses cached reply', async () => {
    const f = await fixture(catalogCases[0]!), key = randomUUID(), first = await book(f, key), before = await whole()
    const again = await book(f, key); expect(again.rows).toEqual(first.rows); expect(await whole()).toEqual(before)
    const bad = await call('HASH_CONFLICT', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: { ...auth(f.pair), 'idempotency-key': key }, payload: { vendorId: f.vendorId, price: { amount: 17001, currency: 'RUB' } } })
    expect(bad.statusCode).toBe(409); expect(await whole()).toEqual(before)
    await db().query('update sessions set revoked_at=clock_timestamp() where id=$1', [f.pair.sid]); const revoked = await whole()
    const denied = await call('CACHED_REVOKED', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: { ...auth(f.pair), 'idempotency-key': key }, payload: { vendorId: f.vendorId, price: { amount: 17000, currency: 'RUB' } } })
    expect(denied.statusCode).toBe(401); expect(denied.headers['idempotent-replay']).toBeUndefined(); expect(await whole()).toEqual(revoked)
  })

  // R2 terminal history and current authority are separate assertions.
  it.each(catalogCases)('R2 tracked $label done retains literal tuple and money through later main move', async c => {
    const f = await fixture(c), before = await book(f), saved = await raw(V, 'where t.deal_id=$1', [before.id]), finance = await money(before.id)
    const r = await patch(f, before.id, 'done'), after = await ledger(f)
    expect(r.statusCode, r.body).toBe(200); expect(after.rows).toHaveLength(2)
    expect(after.current).toMatchObject({ operation: 'retain_done', binding_state: c.date === null ? 'done_undated' : 'done_retained', origin_knowledge: null, is_current: true })
    expect(tuple(after.current)).toEqual(tuple(before.current)); expect((await raw(V, 'where t.id=$1', [before.current.id]))[0]).toBe(saved[0])
    const terminal = await raw(V, 'where t.deal_id=$1', [before.id]); expect(await money(before.id)).toEqual(finance)
    const moved = await move(f, `${YEAR}-09-19`); expect(moved.statusCode, moved.body).toBe(200)
    expect(await raw(V, 'where t.deal_id=$1', [before.id])).toEqual(terminal); expect(await money(before.id)).toEqual(finance)
    expect((await ledger(f)).current).toMatchObject({ service_date: c.date, time_zone: c.tz, day_id: before.current.day_id, is_current: true })
    const snapshot = await whole(), denied = await cancel(f)
    expect(denied.statusCode).toBe(409); expect(denied.json<{ error: { code: string } }>().error.code).toBe('bad_transition'); expect(await whole()).toEqual(snapshot)
  })
  it.each(['booked', 'paid_deposit'])('R2 legacy nohead %s without DATE completes as unknown legacy without invented authority', async state => {
    const f = await fixture(catalogCases[0]!), id = await legacy(f, state, false), finance = await money(id)
    const r = await patch(f, id, 'done'), l = await ledger(f, id)
    expect(r.statusCode, r.body).toBe(200); expect(l.rows).toHaveLength(1)
    expect(l.current).toMatchObject({ operation: 'observe', origin_knowledge: 'legacy_unknown', binding_state: 'unknown', day_id: null, is_current: true })
    expect(await money(id)).toEqual(finance); expect(await raw('vendor_busy_dates', 'where t.vendor_id=$1', [f.vendorId])).toEqual([])
  })
  it('R2 legacy matching DATE observes then retains with legacy origin', async () => {
    const f = await fixture(catalogCases[0]!), id = await legacy(f), r = await patch(f, id, 'done'), l = await ledger(f, id)
    expect(r.statusCode, r.body).toBe(200); expect(l.rows.map(v => v.operation)).toEqual(['observe', 'retain_done'])
    expect(l.rows[0]!.origin_knowledge).toBe('legacy_unknown'); expect(l.rows.slice(1).every(v => v.origin_knowledge === null)).toBe(true); expect(l.current.binding_state).toBe('done_retained')
  })
  it('R2 no day append on same-tuple payment state/price; genuine payment remains and price lock refuses atomically', async () => {
    const f = await fixture(catalogCases[0]!), l = await book(f), old = await raw(V, 'where t.deal_id=$1', [l.id])
    const changed = await call('PRICE_ONLY', f.pair, { method: 'PATCH', url: `/deals/${l.id}`, headers: idem(f.pair), payload: { price: { amount: 18000, currency: 'RUB' } } })
    expect(changed.statusCode, changed.body).toBe(200)
    const paid = await call('PAY', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/pay`, headers: idem(f.pair), payload: { amount: { amount: 3000, currency: 'RUB' } } })
    expect(paid.statusCode, paid.body).toBe(200); expect(await raw(V, 'where t.deal_id=$1', [l.id])).toEqual(old)
    expect((await money(l.id)).payments!.length).toBeGreaterThan(0)
    const before = await whole(), r = await patch(f, l.id, 'done', randomUUID(), 19000)
    expect(r.statusCode).toBe(409); expect(r.json<{ error: { code: string } }>().error.code).toBe('price_locked'); expect(await whole()).toEqual(before)
  })
  it.each(['slot', 'patch', 'external', 'wedding'] as const)('R2 four central cancellation doors $0 release exact current in same commit', async door => {
    const f = await fixture(catalogCases[0]!)
    let id: string
    if (door === 'external') { const r = await call('EXTERNAL', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair), payload: { vendorName: 'Independent external', price: { amount: 17000, currency: 'RUB' } } }); expect(r.statusCode).toBe(200); id = (await ledger(f)).id }
    else id = (await book(f)).id
    const previous = await ledger(f), finance = await money(id)
    const r = door === 'patch' ? await patch(f, id, 'cancelled') : door === 'external'
      ? await call('EXTERNAL_DELETE', f.pair, { method: 'DELETE', url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair) }) : door === 'wedding'
        ? await call('WEDDING_CANCEL', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/cancel`, headers: auth(f.pair) }) : await cancel(f)
    expect(r.statusCode, r.body).toBe(door === 'external' ? 204 : 200); const l = await ledger(f, id)
    expect(l.rows).toHaveLength(previous.rows.length + 1); expect(l.current).toMatchObject({ operation: 'release', binding_state: 'released', day_id: null, previous_version_id: previous.current.id, is_current: true })
    expect(await raw('vendor_busy_dates', 'where t.vendor_id=$1', [f.vendorId])).toEqual([])
    expect((await money(id)).payments).toEqual(finance.payments)
  })

  // R3 independently-constructed K/U expected sets, never a call to classifier.
  it.each([false, true])('R3 cancelling pointer=%s preserves the other same-DATE exact K and its full financial graph', async pointer => {
    const f = await fixture(catalogCases[0]!), a = await book(f), other = await sibling(f), b = await book(other)
    const beforeB = await money(b.id), previousDay = a.current.day_id!; expect(b.current.day_id).toBe(previousDay)
    const target = pointer ? f : other, retained = pointer ? b : a
    const r = await cancel(target); expect(r.statusCode, r.body).toBe(200)
    expect((await db().query('select id,deal_id from vendor_busy_dates where id=$1', [previousDay])).rows).toEqual([{ id: previousDay, deal_id: retained.id }])
    expect((await ledger(pointer ? other : f)).current).toMatchObject({ day_id: previousDay, binding_state: 'active', is_current: true })
    expect(await money(b.id)).toEqual(beforeB)
    expect(await group(previousDay)).toMatchObject({ classification: 'exact', legacy_candidates: [] })
  })
  it('R3 lazy U preserves two ambiguous legacy roots; cancelling only one cannot free DATE', async () => {
    const f = await fixture(catalogCases[0]!), old1 = await legacy(f), second = await sibling(f), old2 = await legacy(second), next = await sibling(f)
    const beforeRead = await raw('legacy_day_groups'), actor = { userId: f.company.id, sessionId: f.company.sid, policyVersion: POLICY }
    await db().tx(c => loadLegacyCalendarInventory(c, { vendorId: f.vendorId, actor })); expect(await raw('legacy_day_groups')).toEqual(beforeRead)
    const n = await book(next), day = n.current.day_id!, g = await group(day)
    expect(g).toMatchObject({ classification: 'legacy_unknown', legacy_candidates: [old1, old2].sort() })
    const r = await cancel(f); expect(r.statusCode, r.body).toBe(200)
    expect((await group(day))!.legacy_candidates).toEqual([old2]); expect((await ledger(f, old1)).current.origin_knowledge).toBe('legacy_unknown')
    expect((await cancel(next)).statusCode).toBe(200); expect((await db().query('select id from vendor_busy_dates where id=$1', [day])).rows).toEqual([{ id: day }])
    expect((await cancel(second)).statusCode).toBe(200); expect((await db().query('select id from vendor_busy_dates where id=$1', [day])).rows).toEqual([])
  })
  it('R3 old done with its own other DATE is not U for the current DATE', async () => {
    const f = await fixture(catalogCases[0]!), open = await legacy(f), doneF = await sibling(f), done = await legacy(doneF, 'done', true, `${YEAR}-06-13`), next = await sibling(f), n = await book(next)
    expect((await group(n.current.day_id!))!.legacy_candidates).toEqual([open])
    expect((await db().query('select deal_id from vendor_busy_dates where vendor_id=$1 and date=$2', [f.vendorId, `${YEAR}-06-13`])).rows).toEqual([{ deal_id: done }])
  })
  it('R3 erased U remains uncertainty and cannot be pruned by a missing-root JOIN', async () => {
    const f = await fixture(catalogCases[0]!), old = await legacy(f), other = await sibling(f), n = await book(other), day = n.current.day_id!
    await db().tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [f.weddingId])
      await c.query('select legacy_day_lock_vendors($1::uuid[])', [[f.vendorId]])
      await c.query('update slots set deal_id=null where id=$1', [f.slotId]); await c.query('delete from deals where id=$1', [old])
    })
    const r = await cancel(other); expect(r.statusCode, r.body).toBe(200)
    expect((await group(day))!.legacy_candidates).toEqual([old]); expect((await group(day))!.classification).toBe('opaque')
    expect((await db().query('select id from vendor_busy_dates where id=$1', [day])).rows).toEqual([{ id: day }])
  })
  it('R3 manual and foreign wedding DATE never become same-wedding free authority', async () => {
    const f = await fixture(catalogCases[0]!)
    await db().query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual')", [f.vendorId, f.date])
    const before = await whole(), r = await call('MANUAL_CONFLICT', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: idem(f.pair), payload: { vendorId: f.vendorId, price: { amount: 17000, currency: 'RUB' } } })
    expect(r.statusCode).toBe(409); expect(await whole()).toEqual(before)
  })

  // R4 all server main-date doors, identity ABA and timezone/city changes.
  it.each(['reschedule', 'wedding', 'event'] as const)('R4 $0 moves OPEN main only by detach/acquire new UUID and preserves done old DATE', async door => {
    const f = await fixture(catalogCases[0]!), a = await book(f), sf = await sibling(f), b = await book(sf)
    expect((await patch(sf, b.id, 'done')).statusCode).toBe(200)
    const retained = await raw(V, 'where t.deal_id=$1', [b.id]), financeA = await money(a.id), financeB = await money(b.id)
    const r = await move(f, `${YEAR}-07-20`, door), l = await ledger(f)
    expect(r.statusCode, r.body).toBe(200); expect(l.current).toMatchObject({ operation: 'move', service_date: `${YEAR}-07-20`, is_current: true })
    expect(l.current.day_id).not.toBe(a.current.day_id); expect(await raw(V, 'where t.deal_id=$1', [b.id])).toEqual(retained)
    expect(await money(a.id)).toEqual(financeA); expect(await money(b.id)).toEqual(financeB)
    expect((await ledger(sf)).current).toMatchObject({ day_id: a.current.day_id, service_date: f.date, binding_state: 'done_retained', is_current: true })
    expect((await db().query('select id,date::text from vendor_busy_dates where vendor_id=$1 order by date', [f.vendorId])).rows).toEqual([
      { id: a.current.day_id, date: f.date }, { id: l.current.day_id, date: `${YEAR}-07-20` }])
  })
  it('R4 main DATE A→B→A is a new operational identity; old captured/history UUID never resurrects', async () => {
    const f = await fixture(catalogCases[0]!), a = await book(f), before = await raw(V, 'where t.id=$1', [a.current.id])
    expect((await move(f, `${YEAR}-08-18`)).statusCode).toBe(200); const b = await ledger(f)
    expect((await move(f, f.date!)).statusCode).toBe(200); const a2 = await ledger(f)
    expect(new Set([a.current.day_id, b.current.day_id, a2.current.day_id]).size).toBe(3)
    expect(await raw(V, 'where t.id=$1', [a.current.id])).toEqual(before)
  })
  it('R4 effective timezone-only and city-derived timezone append main material without replacing DATE identity', async () => {
    const f = await fixture(catalogCases[0]!), first = await book(f)
    const r = await call('TZ_ONLY', f.pair, { method: 'PATCH', url: `/weddings/${f.weddingId}`, headers: auth(f.pair), payload: { tz: 'Asia/Novosibirsk' } })
    expect(r.statusCode, r.body).toBe(200); const second = await ledger(f)
    expect(second.current).toMatchObject({ time_zone: 'Asia/Novosibirsk', day_id: first.current.day_id, service_date: f.date, is_current: true }); expect(second.rows.length).toBeGreaterThan(first.rows.length)
    const city = (await db().query<{ name: string; region: string; tz: string }>("select name,region,tz from cities where tz is not null and tz<>'Asia/Novosibirsk' order by id limit 1")).rows[0]!
    const moved = await call('CITY_TZ', f.pair, { method: 'PATCH', url: `/weddings/${f.weddingId}`, headers: auth(f.pair), payload: { city: { name: city.name, region: city.region } } })
    expect(moved.statusCode, moved.body).toBe(200); expect((await ledger(f)).current).toMatchObject({ time_zone: city.tz, day_id: first.current.day_id, is_current: true })
  })

  // A barrier is released/drained even when observing the actual PG wait fails.
  async function gate(sql: string, values: readonly unknown[], mutate: (c: Queryable) => Promise<unknown> = async () => undefined) {
    let release!: () => void, ready!: () => void, fail!: (e: unknown) => void, pid = 0
    const started = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject }), permission = new Promise<void>(resolve => { release = resolve })
    const holder = db().tx(async c => { pid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid; await c.query(sql, values); ready(); await permission; await mutate(c) })
    void holder.catch(fail); await started
    return { pid, release, holder }
  }
  async function blocked(holder: number, count: number, label: string) {
    type Row = { pid: number; blockers: number[]; state: string; wait_event_type: string | null; query: string }
    let found: Row[] = [], graph: Row[] = []
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      graph = (await db().query<Row>(`select pid,pg_blocking_pids(pid) blockers,state,wait_event_type,query
        from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()`)).rows
      // Every transitive edge belongs to this one actual activity snapshot.
      const reachable = new Set<number>([holder]); let changed = true
      while (changed) { changed = false; for (const row of graph) if (!reachable.has(row.pid) && row.blockers.some(p => reachable.has(p))) { reachable.add(row.pid); changed = true } }
      found = graph.filter(r => r.pid !== holder && reachable.has(r.pid) && r.wait_event_type === 'Lock')
      if (found.length >= count) break
      await new Promise<void>(done => setTimeout(done, 15))
    }
    witness('PG_WAIT', { label, holder, count, found, graph })
    expect(found.length, `${label}: actual pg_blocking_pids path to recorded holder`).toBeGreaterThanOrEqual(count)
    return found
  }
  type Response = Awaited<ReturnType<typeof call>>
  async function queueTwo(f: Fixture, label: string, first: () => Promise<Response>, second: () => Promise<Response>, vendorGate = false) {
    const held = await gate(vendorGate ? 'select legacy_day_lock_vendors($1::uuid[])' : 'select id from weddings where id=$1 for update', vendorGate ? [[f.vendorId]] : [f.weddingId])
    const requests: Promise<Response>[] = []; let error: unknown, drained: PromiseSettledResult<unknown>[] = []
    try {
      const a = first(); void a.catch(() => undefined); requests.push(a); await blocked(held.pid, 1, label + '/first')
      const b = second(); void b.catch(() => undefined); requests.push(b); await blocked(held.pid, 2, label + '/second')
    } catch (e) { error = e }
    finally {
      held.release(); drained = await Promise.allSettled([held.holder, ...requests])
    }
    const failed = drained.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
    if (error !== undefined) failed.unshift(error); if (failed.length) throw new AggregateError(failed, label + ' drain')
    const result = await Promise.all(requests); expect(result).toHaveLength(2); return result as [Response, Response]
  }
  const bookResponse = (f: Fixture, vendorId = f.vendorId, key = randomUUID()) => call('RACE_BOOK', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: { ...auth(f.pair), 'idempotency-key': key }, payload: { vendorId, price: { amount: 17000, currency: 'RUB' } } })
  it.each([true, false])('R5 schedule1/2 book-first=%s serializes genuine book and main move', async bookFirst => {
    const f = await fixture(catalogCases[0]!), nextDate = `${YEAR}-10-14`
    const failedMoveKey = bookFirst ? randomUUID() : '', retryMoveKey = bookFirst ? randomUUID() : ''
    const failedScopedKey = f.pair.id + ':weddings.reschedule:' + failedMoveKey
    const keyedMove = (key: string) => call('MAIN_MOVE', f.pair, { method: 'POST', url: '/weddings/' + f.weddingId + '/reschedule',
      headers: { ...auth(f.pair), 'idempotency-key': key }, payload: { date: nextDate } })
    const database = db(), original = database.tx, invoke: Db['tx'] = original.bind(database)
    let armed = false, captures = 0, bookedFrame: RawSnapshot | undefined
    const a = () => { armed = bookFirst; return bookResponse(f) }, b = () => bookFirst ? keyedMove(failedMoveKey) : move(f, nextDate)
    const delegate: Db['tx'] = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => invoke(async c => {
      const capture = armed
      if (capture) { armed = false; captures++ }
      const result = await action(c)
      if (capture) {
        // Actual successful booking callback, including its saved receipt, before native COMMIT.
        const names = (await c.query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.name)
        const frame: RawSnapshot = {}
        for (const name of names) {
          assert.match(name, /^[a-z_][a-z0-9_]*$/)
          frame[name] = (await c.query<{ row: string }>('select row_to_json(t)::text row from "' + name + '" t order by row_to_json(t)::text')).rows.map(row => row.row)
        }
        const pendingClaim = frame.idempotency_keys!.filter(row => (JSON.parse(row) as { key: string }).key === failedScopedKey)
        expect(pendingClaim).toHaveLength(1)
        expect(JSON.parse(pendingClaim[0]!) as { user_id: string; route: string; status: number | null; body: unknown })
          .toMatchObject({ user_id: f.pair.id, route: 'weddings.reschedule', status: null, body: null })
        // The failed request must release exactly its own pre-domain claim; all other public rows remain literal.
        frame.idempotency_keys = frame.idempotency_keys!.filter(row => (JSON.parse(row) as { key: string }).key !== failedScopedKey)
        bookedFrame = frame
      }
      return result
    })
    let rows!: [Response, Response], raceError: { error: unknown } | undefined
    if (bookFirst) database.tx = delegate
    try { rows = await queueTwo(f, bookFirst ? 'schedule1/book→move' : 'schedule2/move→book', bookFirst ? a : b, bookFirst ? b : a) }
    catch (error) { raceError = { error } }
    finally {
      if (bookFirst) {
        if (database.tx !== delegate) raceError = { error: new AggregateError(raceError ? [raceError.error] : [], 'R5 owned transaction observation changed') }
        database.tx = original // queueTwo has already released and drained both actual requests.
      }
    }
    if (raceError) throw raceError.error
    if (bookFirst) {
      expect(rows[0].statusCode, rows[0].body).toBe(200)
      expect(rows[1].statusCode, rows[1].body).toBe(409)
      expect(rows[1].json<{ error: { code: string } }>().error.code).toBe('calendar_scope_changed')
      expect(captures).toBe(1); assert(bookedFrame)
      expect((await db().query('select key from idempotency_keys where key=$1', [failedScopedKey])).rows).toEqual([])
      expect(await whole(), 'Failed move changed a public row beyond releasing its exact pending claim').toEqual(bookedFrame)
      await assertAcquire(f, 'catalog', rows[0])
      expect((await db().query('select date::text from weddings where id=$1', [f.weddingId])).rows).toEqual([{ date: f.date }])
      expect((await db().query('select date::text from wedding_events where id=$1 and wedding_id=$2 and is_main', [f.eventId, f.weddingId])).rows).toEqual([{ date: f.date }])
      const booked = await ledger(f), financialRoot = await raw('deals', 'where t.id=$1', [booked.id]), literalMoney: RawSnapshot = {}
      for (const table of moneyTables) literalMoney[table] = await raw(table)
      const ownMoney = await money(booked.id)
      assert.notEqual(retryMoveKey, failedMoveKey)
      const retried = await keyedMove(retryMoveKey)
      expect(retried.statusCode, retried.body).toBe(200)
      expect(await raw('deals', 'where t.id=$1', [booked.id])).toEqual(financialRoot)
      expect(await money(booked.id)).toEqual(ownMoney)
      for (const table of moneyTables) expect(await raw(table), table).toEqual(literalMoney[table])
      expect((await db().query('select status from idempotency_keys where key=$1', [f.pair.id + ':weddings.reschedule:' + retryMoveKey])).rows).toEqual([{ status: 200 }])
      witness('R5_REFUSAL_FRESH_RETRY_MONEY', { failedMoveKey, retryMoveKey, financialRoot, literalMoney, ownMoney })
    } else {
      for (const r of rows) expect(r.statusCode, r.body).toBe(200)
    }
    const l = await ledger(f); expect(l.current).toMatchObject({ service_date: nextDate, is_current: true })
    expect((await db().query('select id,date::text,deal_id from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([{ id: l.current.day_id, date: nextDate, deal_id: l.id }])
  })

  async function commonScopeWholeRefusal(f: Fixture, label: string, first: () => Promise<Response>, second: () => Promise<Response>,
    route: 'slots.book' | 'slots.cancel', loserKey: string): Promise<[Response, Response]> {
    const database = db(), original = database.tx, invoke: Db['tx'] = original.bind(database)
    const scoped = f.pair.id + ':' + route + ':' + loserKey
    let armed = false, captures = 0, committedFirstFrame: RawSnapshot | undefined, failure: { error: unknown } | undefined
    const delegate: Db['tx'] = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => invoke(async c => {
      const capture = armed; if (capture) { armed = false; captures++ }
      const result = await action(c)
      if (capture) {
        const names = (await c.query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.name)
        const frame: RawSnapshot = {}
        for (const name of names) {
          assert.match(name, /^[a-z_][a-z0-9_]*$/)
          frame[name] = (await c.query<{ row: string }>('select row_to_json(t)::text row from "' + name + '" t order by row_to_json(t)::text')).rows.map(row => row.row)
        }
        const claims = frame.idempotency_keys!.filter(row => (JSON.parse(row) as { key: string }).key === scoped)
        expect(claims).toHaveLength(1)
        expect(JSON.parse(claims[0]!) as { user_id: string; route: string; status: number | null; body: unknown })
          .toMatchObject({ user_id: f.pair.id, route, status: null, body: null })
        frame.idempotency_keys = frame.idempotency_keys!.filter(row => (JSON.parse(row) as { key: string }).key !== scoped)
        committedFirstFrame = frame // staged after the first callback, verified only after its real200/COMMIT
      }
      return result
    })
    database.tx = delegate
    let replies: [Response, Response] | undefined
    try { replies = await queueTwo(f, label, () => { armed = true; return first() }, second) }
    catch (error) { failure = { error } }
    finally {
      if (database.tx !== delegate) failure = { error: new AggregateError(failure ? [failure.error] : [], label + ': transaction observer ownership changed') }
      database.tx = original // queueTwo has released/drained holder and both requests.
    }
    if (failure) throw failure.error
    assert(replies); expect(replies[0].statusCode, replies[0].body).toBe(200)
    expect(replies[1].statusCode, replies[1].body).toBe(409)
    expect(replies[1].json<{ error: { code: string } }>().error.code).toBe('calendar_scope_changed')
    expect(captures).toBe(1); assert(committedFirstFrame)
    expect((await db().query('select key from idempotency_keys where key=$1', [scoped])).rows).toEqual([])
    expect(await whole(), label + ': loser changed public rows beyond releasing its exact pending claim').toEqual(committedFirstFrame)
    return replies
  }
  async function retainedHolder(id: string) {
    return { root: await raw('deals', 'where t.id=$1', [id]), money: await money(id),
      versions: await raw(V, 'where t.deal_id=$1', [id]), head: await raw(H, 'where t.deal_id=$1', [id]) }
  }
  async function recordedPartialInstallment(f: Fixture, id: string, label: string) {
    assert(f.date)
    const created = await call(label + '/installment', f.pair, { method: 'POST', url: '/weddings/' + f.weddingId + '/payment-schedule',
      headers: idem(f.pair), payload: { dealId: id, title: label, amount: { amount: 6000, currency: 'RUB' }, due: f.date } })
    expect(created.statusCode, created.body).toBe(201)
    const stage = created.json<{ id: string; version: number }>()
    expect(created.json()).toMatchObject({ id: stage.id, dealId: id, amount: { amount: 6000, currency: 'RUB' },
      due: f.date, paid: { amount: 0, currency: 'RUB' }, status: 'pending', cancelledAt: null })
    const paid = await call(label + '/partial-payment', f.pair, { method: 'POST',
      url: '/weddings/' + f.weddingId + '/payment-schedule/' + stage.id + '/pay', headers: idem(f.pair),
      payload: { version: stage.version, amount: { amount: 2000, currency: 'RUB' }, amountKnown: true,
        paymentMethod: 'cash', visibility: 'private', paidOn: f.date } })
    expect(paid.statusCode, paid.body).toBe(200)
    expect(paid.json()).toMatchObject({ id: stage.id, dealId: id, version: stage.version + 1,
      amount: { amount: 6000, currency: 'RUB' }, paid: { amount: 2000, currency: 'RUB' },
      remaining: { amount: 4000, currency: 'RUB' }, status: 'partial', cancelledAt: null })
    const linked = (await db().query('select i.id,i.deal_id,i.amount::text,i.currency::text,i.due::text,i.paid::text,'
      + 'i.cancelled_at,i.cancel_reason,p.installment_id,p.amount::text payment_amount,p.status,p.kind,p.amount_known,p.paid_on::text '
      + 'from payment_installments i join payments p on p.installment_id=i.id and p.deal_id=i.deal_id where i.deal_id=$1 order by i.id,p.id', [id])).rows
    expect(linked).toEqual([{ id: stage.id, deal_id: id, amount: '6000', currency: 'RUB', due: f.date, paid: '2000',
      cancelled_at: null, cancel_reason: null, installment_id: stage.id, payment_amount: '2000',
      status: 'recorded', kind: 'deposit', amount_known: true, paid_on: f.date }])
    const baseline = await cancellationMoney(id)
    expect(baseline.money.payment_installments).toHaveLength(1); expect(baseline.money.payments).toHaveLength(1)
    expect(baseline.money.order_assignments).toEqual([]); expect(baseline.money.order_parts).toEqual([])
    witness('R5_REAL_PARTIAL_PAYMENT_BASELINE', { label, dealId: id, installmentId: stage.id, money: baseline.money })
    return baseline
  }
  async function cancellationMoney(id: string) {
    const economic = (await db().query<{ row: string }>('select row_to_json(t)::text row from (select id,wedding_id,slot_id,vendor_id,'
      + 'price,currency,booked_at,package_id,package_title_snapshot,package_includes_snapshot from deals where id=$1) t', [id])).rows.map(row => row.row)
    expect(economic).toHaveLength(1)
    return { economic, money: await money(id) }
  }
  async function assertCancellationMoney(id: string, before: Awaited<ReturnType<typeof cancellationMoney>>) {
    expect(before.money.payment_installments).toHaveLength(1); expect(before.money.payments).toHaveLength(1)
    const after = await cancellationMoney(id)
    expect(after.economic).toEqual(before.economic)
    for (const table of ['deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts', 'payments', 'payment_corrections', 'payment_installment_edits'])
      expect(after.money[table], table).toEqual(before.money[table])
    // Immutable1761310000000: only these four fields change on each previously uncancelled installment.
    const literalInstallments = '[' + before.money.payment_installments!.join(',') + ']'
    const rows = (await db().query<{ exact: boolean }>('with prior as (select p.* from jsonb_array_elements($1::jsonb) j(value) '
      + 'cross join lateral jsonb_populate_record(null::payment_installments,j.value) p), '
      + 'expected as (select p.id,case when p.cancelled_at is null then to_jsonb(p)||jsonb_build_object('
      + "'cancelled_at',d.cancelled_at,'cancel_reason','Сделка отменена','version',p.version+1,'updated_at',d.cancelled_at)"
      + ' else to_jsonb(p) end row from prior p cross join deals d where d.id=$2), '
      + 'actual as (select a.id,to_jsonb(a) row from payment_installments a where a.deal_id=$2) '
      + "select exists(select 1 from deals where id=$2 and state='cancelled' and cancelled_at is not null) "
      + 'and (select count(*) from expected)=(select count(*) from actual) '
      + 'and not exists(select 1 from expected e left join actual a using(id) where a.id is null or a.row is distinct from e.row) exact',
      [literalInstallments, id])).rows
    expect(rows).toEqual([{ exact: true }])
  }
  it.each([true, false])('R5 schedule3/4 cancel-first=%s preserves the second K after real concurrent book', async cancelFirst => {
    const f = await fixture(catalogCases[0]!), old = await book(f), other = await sibling(f)
    // Only the existing root can have a real obligation before the empty-slot booking.
    const oldMoney = await recordedPartialInstallment(f, old.id, 'schedule3-4/old/prequeue'), oldRetained = await retainedHolder(old.id)
    const firstKey = randomUUID(), loserKey = randomUUID(), freshKey = randomUUID()
    const first = cancelFirst ? () => cancel(f, firstKey) : () => bookResponse(other, other.vendorId, firstKey)
    const second = cancelFirst ? () => bookResponse(other, other.vendorId, loserKey) : () => cancel(f, loserKey)
    await commonScopeWholeRefusal(f, cancelFirst ? 'schedule3/cancel→book' : 'schedule4/book→cancel', first, second,
      cancelFirst ? 'slots.book' : 'slots.cancel', loserKey)
    assert.notEqual(freshKey, loserKey)
    if (cancelFirst) {
      await assertCancellationMoney(old.id, oldMoney)
      expect((await ledger(f, old.id)).current.binding_state).toBe('released')
      expect(await raw('vendor_busy_dates', 'where t.vendor_id=$1', [f.vendorId])).toEqual([])
      const retained = await retainedHolder(old.id)
      const retry = await bookResponse(other, other.vendorId, freshKey)
      expect(retry.statusCode, retry.body).toBe(200)
      expect(await retainedHolder(old.id)).toEqual(retained)
      expect((await ledger(other)).current.day_id).not.toBe(old.current.day_id)
    } else {
      expect(await retainedHolder(old.id)).toEqual(oldRetained)
      const live = await ledger(other)
      // The whole124 loser409 proof above finishes before this new root receives its own real payment.
      await recordedPartialInstallment(other, live.id, 'schedule4/new/post409-before-fresh-cancel')
      expect(await retainedHolder(old.id)).toEqual(oldRetained)
      const retained = await retainedHolder(live.id), beforeCancel = await cancellationMoney(old.id)
      expect(live.current.is_current).toBe(true)
      expect((await ledger(f, old.id)).current.binding_state).toBe('active')
      const retry = await cancel(f, freshKey)
      expect(retry.statusCode, retry.body).toBe(200)
      expect(await retainedHolder(live.id)).toEqual(retained)
      await assertCancellationMoney(old.id, beforeCancel)
    }
    const l = await ledger(other); expect(l.current.is_current).toBe(true)
    expect((await db().query('select id,deal_id from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([{ id: l.current.day_id, deal_id: l.id }])
    expect((await ledger(f, old.id)).current.binding_state).toBe('released')
  })

  it('R5 schedule5 two cancellation transactions release only their own K and remove last exact DATE', async () => {
    const f = await fixture(catalogCases[0]!), a = await book(f), other = await sibling(f), b = await book(other)
    await recordedPartialInstallment(f, a.id, 'schedule5/first/prequeue')
    const secondMoney = await recordedPartialInstallment(other, b.id, 'schedule5/second/prequeue')
    const firstMoney = await cancellationMoney(a.id), secondRetained = await retainedHolder(b.id)
    const firstKey = randomUUID(), loserKey = randomUUID(), freshKey = randomUUID()
    await commonScopeWholeRefusal(f, 'schedule5/two-cancels', () => cancel(f, firstKey), () => cancel(other, loserKey), 'slots.cancel', loserKey)
    await assertCancellationMoney(a.id, firstMoney)
    expect(await retainedHolder(b.id)).toEqual(secondRetained)
    expect((await ledger(f, a.id)).current.binding_state).toBe('released')
    expect((await ledger(other, b.id)).current.binding_state).toBe('active')
    expect((await db().query('select id,deal_id from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([{ id: b.current.day_id, deal_id: b.id }])
    const retained = await retainedHolder(a.id)
    assert.notEqual(freshKey, loserKey)
    const retry = await cancel(other, freshKey)
    expect(retry.statusCode, retry.body).toBe(200)
    expect(await retainedHolder(a.id)).toEqual(retained)
    await assertCancellationMoney(b.id, secondMoney)
    expect((await ledger(f, a.id)).current.binding_state).toBe('released'); expect((await ledger(other, b.id)).current.binding_state).toBe('released')
    expect(await raw('vendor_busy_dates', 'where t.vendor_id=$1', [f.vendorId])).toEqual([])
  })

  it('R5 schedule6 two weddings contend for the same vendor DATE; only one commit/receipt/head', async () => {
    const f = await fixture(catalogCases[0]!), foreign = await fixture(catalogCases[0]!), other = { ...foreign, vendorId: f.vendorId }
    const rows = await queueTwo(f, 'schedule6/foreign-weddings', () => bookResponse(f), () => bookResponse(other), true)
    expect(rows.map(r => r.statusCode).sort()).toEqual([200, 409])
    const winners = (await db().query<{ id: string; wedding_id: string }>("select id,wedding_id from deals where vendor_id=$1 and state='booked'", [f.vendorId])).rows
    expect(winners).toHaveLength(1); const winner = winners[0]!
    expect((await db().query('select deal_id from vendor_busy_dates where vendor_id=$1 and date=$2', [f.vendorId, f.date])).rows).toEqual([{ deal_id: winner.id }])
    expect((await db().query('select deal_id from deal_day_scope_heads where wedding_id=any($1::uuid[])', [[f.weddingId, other.weddingId]])).rows).toEqual([{ deal_id: winner.id }])
  })
  it('R5 schedule7 opposite replacement unions serialize without company lock upgrade/deadlock', async () => {
    const f = await fixture(catalogCases[0]!), other = await fixture(catalogCases[0]!), a = await book(f), b = await book(other)
    const held = await gate('select legacy_day_lock_vendors($1::uuid[])', [[f.vendorId, other.vendorId]])
    const work: Promise<Response>[] = []; let failure: unknown, drained: PromiseSettledResult<unknown>[] = []
    try { work.push(replace(f, a.id, other.vendorId)); void work[0]!.catch(() => undefined); await blocked(held.pid, 1, 'schedule7/one')
      work.push(replace(other, b.id, f.vendorId)); void work[1]!.catch(() => undefined); await blocked(held.pid, 2, 'schedule7/two') }
    catch (e) { failure = e }
    finally { held.release(); drained = await Promise.allSettled([held.holder, ...work]) }
    const errors = drained.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
    if (failure !== undefined) errors.unshift(failure); if (errors.length) throw new AggregateError(errors, 'opposite replacement drain')
    const results = await Promise.all(work); expect(results.map(r => r.statusCode)).toEqual([409, 409])
    expect((await ledger(f)).current).toEqual(a.current); expect((await ledger(other)).current).toEqual(b.current)
  })
  it('R5 schedule8 inventory capture and nonpointer append both orders use actual held wedding wait', async () => {
    for (const captureFirst of [true, false]) {
      const f = await fixture(catalogCases[0]!), first = await book(f), other = await sibling(f)
      const actor = { userId: f.company.id, sessionId: f.company.sid, policyVersion: POLICY }
      const view = await db().tx(c => loadLegacyCalendarInventory(c, { vendorId: f.vendorId, actor })), source = view.sources.find(s => s.kind === 'app_day')!
      expect(source).toBeDefined(); const held = await gate('select id from weddings where id=$1 for update', [f.weddingId])
      const work: Promise<unknown>[] = []; let failure: unknown, drained: PromiseSettledResult<unknown>[] = []
      const capture = () => db().tx(c => captureLegacyCalendarSource(c, { vendorId: f.vendorId, actor, sourceId: source.sourceId, expectedSourceRevision: source.sourceRevision, expectedInventoryRevision: source.inventoryRevision }))
      try { work.push(captureFirst ? capture() : bookResponse(other)); void work[0]!.catch(() => undefined); await blocked(held.pid, 1, 'schedule8/first')
        work.push(captureFirst ? bookResponse(other) : capture()); void work[1]!.catch(() => undefined); await blocked(held.pid, 2, 'schedule8/second') }
      catch (e) { failure = e }
      finally { held.release(); drained = await Promise.allSettled([held.holder, ...work]) }
      const failed = drained.filter((r, index): r is PromiseRejectedResult => r.status === 'rejected' && index !== (captureFirst ? 1 : 2)).map(r => r.reason)
      if (failure !== undefined) failed.unshift(failure); if (failed.length) throw new AggregateError(failed, 'capture/nonpointer drain')
      const captureResult = drained[captureFirst ? 1 : 2]!
      if (captureFirst) expect(captureResult.status, 'capture queued first must actually commit').toBe('fulfilled')
      else if (captureResult.status === 'rejected') expect(captureResult.reason).toMatchObject({ statusCode: 409 })
      expect((await ledger(other)).current).toMatchObject({ day_id: first.current.day_id, is_current: true })
      const now = await db().tx(c => loadLegacyCalendarInventory(c, { vendorId: f.vendorId, actor })); expect(now.sources.find(s => s.sourceId === source.sourceId)!.freshness).toBe('stale')
    }
  })

  // Current principal must be rechecked after a proven blocking read, fresh/replay.
  const aclChanges = ['member', 'role', 'session', 'consent', 'account'] as const
  it.each(aclChanges.flatMap(change => [false, true].map(replay => ({ change, replay }))))('R6 current ACL $change replay=$replay after real wait leaves no day/financial write', async ({ change, replay }) => {
    const f = await fixture(catalogCases[0]!), key = randomUUID()
    if (replay) await book(f, key)
    let expected: RawSnapshot | undefined
    const held = await gate('select id from weddings where id=$1 for update', [f.weddingId], async c => {
      if (change === 'member') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.weddingId, f.pair.id])
      if (change === 'role') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.weddingId, f.pair.id])
      if (change === 'session') await c.query('update sessions set revoked_at=clock_timestamp() where id=$1', [f.pair.sid])
      if (change === 'consent') await c.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1', [f.pair.id])
      if (change === 'account') await c.query('update users set deleted_at=clock_timestamp() where id=$1', [f.pair.id])
      expected = await whole(c)
      expected.idempotency_keys = expected.idempotency_keys!.filter(row => !(JSON.parse(row) as { key: string; status: number | null }).key.endsWith(':' + key) || (JSON.parse(row) as { status: number | null }).status !== null)
    })
    const response = bookResponse(f, f.vendorId, key); void response.catch(() => undefined)
    try { await blocked(held.pid, 1, `acl/${change}/${replay}`) }
    finally { held.release(); await Promise.all([held.holder, response]) }
    const r = await response; expect([401, 403, 404]).toContain(r.statusCode); expect(r.headers['idempotent-replay']).toBeUndefined(); expect(await whole()).toEqual(expected)
  })

  it.each(['root', 'day', 'head', 'notice', 'receipt'] as const)('R6 real SQL22012 after $0 rolls back full raw state; same key retries successfully', async target => {
    const f = await fixture(catalogCases[0]!)
    let noticeRecipient: string | undefined, noticeRequest: string | undefined
    if (target === 'notice') {
      // A plain catalogue book has no notification recipient. A genuine open
      // request to the other company makes booked_other emit in this same TX.
      const other = await newVendor(f); noticeRecipient = other.owner.id
      const added = await call('FAULT_NOTICE_SHORTLIST', f.pair, { method: 'PUT', url: `/weddings/${f.weddingId}/shortlist/${other.id}`, headers: auth(f.pair), payload: { slotId: f.slotId } })
      expect(added.statusCode, added.body).toBe(200)
      const entries = (await db().query<{ id: string }>('select id from slot_shortlist where slot_id=$1 and vendor_id=$2', [f.slotId, other.id])).rows
      expect(entries).toHaveLength(1)
      const requested = await call('FAULT_NOTICE_REQUEST', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/offer-requests`, headers: idem(f.pair), payload: { entryIds: [entries[0]!.id] } })
      expect(requested.statusCode, requested.body).toBe(201)
      const requests = (await db().query<{ id: string; status: string }>('select id,status from offer_requests where slot_id=$1 and vendor_id=$2', [f.slotId, other.id])).rows
      expect(requests).toHaveLength(1); expect(requests[0]!.status).toBe('open'); noticeRequest = requests[0]!.id
    }
    const before = await whole(), key = randomUUID(), database = db(), original = database.tx, forward = database.tx.bind(database)
    const patterns = { root: /insert into deals\s*\(/i, day: /(?:insert into vendor_busy_dates\s*\(|legacy_day_acquire\s*\()/i, head: /(?:insert into|update) deal_day_scope_heads/i, notice: /insert into notifications\s*\(/i, receipt: /update idempotency_keys[\s\S]*status/i }
    let hit = false, actual: { code?: string; constraint?: string } | undefined, callback = false
    database.tx = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => forward(async c => {
      const wrapped: Queryable = { query: async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
        const result = await c.query<R>(sql, values)
        if (!hit && patterns[target].test(sql)) { hit = true; witness('SQL_FAULT_PRE', { target, sql, values, raw: await whole(c) }); try { await c.query('select 1/0') } catch (e) { actual = e as { code?: string }; throw e } }
        return result
      } }
      const result = await action(wrapped); callback = true; return result
    })
    let response: Response
    try { response = await bookResponse(f, f.vendorId, key) } finally { database.tx = original }
    witness('SQL_FAULT', { target, hit, actual, callback, status: response.statusCode, before, after: await whole() })
    expect(hit, 'fault must reach an actual domain SQL write, not fail during setup').toBe(true); expect(actual?.code).toBe('22012'); expect(response.statusCode).toBe(500); expect(await whole()).toEqual(before)
    const retry = await book(f, key); expect(retry.rows).toHaveLength(1); expect(retry.current.is_current).toBe(true)
    if (target === 'notice') {
      expect((await db().query('select status,close_reason from offer_requests where id=$1', [noticeRequest])).rows).toEqual([{ status: 'closed', close_reason: 'booked_other' }])
      const notices = (await db().query<{ row: string }>("select row_to_json(t)::text row from notifications t where user_id=$1 and title='Пара выбрала другого исполнителя' order by id", [noticeRecipient])).rows.map(r => r.row)
      expect(notices).toHaveLength(1); expect(before.notifications!).not.toContain(notices[0])
    }
  })
  it('R6 real outer COMMIT rejects orphan next version after successful callback and retains every row', async () => {
    const f = await fixture(catalogCases[0]!), l = await book(f), before = await whole()
    let callback = false, phase = 'SETUP', error: unknown
    try { await db().tx(async c => {
      const v = l.current; phase = 'INSERT_VERSION'
      await c.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
        values($1,$2,$3,$4,1,2,$5,null,'acquire',$6,$7,$8,$9,$10,$11,$12,$13)`, [randomUUID(), f.weddingId, l.id, f.slotId, v.id, v.context_kind, v.event_id, v.performer_kind, v.vendor_id, v.binding_state, v.service_date, v.time_zone, v.day_id])
      callback = true; phase = 'OUTER_COMMIT'
    }) } catch (e) { error = e }
    witness('OUTER_COMMIT', { phase, callback, error: error && { code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }, before, after: await whole() })
    expect(callback).toBe(true); expect(phase).toBe('OUTER_COMMIT'); expect(error).toMatchObject({ code: '23514', constraint: 'deal_day_scope_chain' }); expect(await whole()).toEqual(before)
  })

  async function material(f: Fixture, kind = 'app_day', exactTarget?: string) {
    const targets = exactTarget === undefined ? kind === 'app_day'
      ? (await db().query<{ id: string }>("select id from vendor_busy_dates where vendor_id=$1 and date=$2 and source='deal'", [f.vendorId, f.date])).rows
      : (await db().query<{ id: string }>('select deal_id id from slots where id=$1 and wedding_id=$2', [f.slotId, f.weddingId])).rows
      : [{ id: exactTarget }]
    expect(targets).toHaveLength(1); assert(targets[0]!.id)
    const source = (await db().query<{ id: string }>(`select id from legacy_calendar_sources where vendor_id=$1 and wedding_id=$2 and kind=$3
      and ${kind === 'app_day' ? 'day_id' : 'root_deal_id'}=$4 order by id`, [f.vendorId, f.weddingId, kind, targets[0]!.id])).rows
    expect(source).toHaveLength(1)
    const row = (await db().query<{ value: Record<string, unknown>; digest: string }>(`select legacy_calendar_current_inventory_material(s) value,
      encode(sha256(convert_to(legacy_calendar_current_inventory_material(s)::text,'UTF8')),'hex') digest from legacy_calendar_sources s where id=$1`, [source[0]!.id])).rows[0]!
    return { sourceId: source[0]!.id, value: row.value, digest: row.digest }
  }
  async function capture(f: Fixture, sourceId: string) {
    const actor = { userId: f.company.id, sessionId: f.company.sid, policyVersion: POLICY }, view = await db().tx(c => loadLegacyCalendarInventory(c, { vendorId: f.vendorId, actor }))
    const dto = view.sources.find(s => s.sourceId === sourceId)!; expect(dto).toBeDefined()
    return db().tx(c => captureLegacyCalendarSource(c, { vendorId: f.vendorId, actor, sourceId, expectedSourceRevision: dto.sourceRevision, expectedInventoryRevision: dto.inventoryRevision }))
  }
  it('I1 untouched old /1 capture bytes remain immutable while activation switches dispatcher to /2 and stale', async () => {
    const f = await fixture(catalogCases[0]!), old = await legacy(f), before = await material(f)
    expect(before.value.encoding).toBe('legacy-calendar-inventory/1'); await capture(f, before.sourceId)
    const saved = await raw('legacy_calendar_versions', 'where t.source_id=$1', [before.sourceId]); expect(saved).toHaveLength(1)
    const next = await sibling(f); await book(next)
    const after = await material(f); expect(after.value.encoding).toBe('legacy-calendar-inventory/2')
    expect(await raw('legacy_calendar_versions', 'where t.source_id=$1', [before.sourceId])).toEqual(saved)
    const actor = { userId: f.company.id, sessionId: f.company.sid, policyVersion: POLICY }, view = await db().tx(c => loadLegacyCalendarInventory(c, { vendorId: f.vendorId, actor }))
    expect(view.sources.find(s => s.sourceId === before.sourceId)!.freshness).toBe('stale')
    expect((after.value.holders as { dealId: string }[]).map(h => h.dealId)).not.toContain(old)
    expect(after.value.completeness).toBe('unknown')
  })
  it('I1 full /2 knownHolders bind all18 fields/head exactly; nonpointer append changes digest without pointer revision', async () => {
    const f = await fixture(catalogCases[0]!), first = await book(f), before = await material(f), day = first.current.day_id!
    const pointer = await raw('vendor_busy_dates', 'where t.id=$1', [day]); await capture(f, before.sourceId)
    const saved = await raw('legacy_calendar_versions', 'where t.source_id=$1', [before.sourceId]), other = await sibling(f), second = await book(other)
    const after = await material(f); expect(await raw('vendor_busy_dates', 'where t.id=$1', [day])).toEqual(pointer)
    expect(after.value).not.toEqual(before.value); expect(await raw('legacy_calendar_versions', 'where t.source_id=$1', [before.sourceId])).toEqual(saved)
    const scopes = after.value.dayScopes as Record<string, unknown>[]; expect(scopes).toHaveLength(1)
    const s = scopes[0]!
    expect(Object.keys(s).sort()).toEqual(['dayId', 'vendorId', 'date', 'weddingId', 'classification', 'groupRevision', 'legacyCandidates', 'opaque', 'knownHolders', 'day'].sort())
    expect(s).toMatchObject({ dayId: day, vendorId: f.vendorId, date: f.date, weddingId: f.weddingId, classification: 'exact', legacyCandidates: [], opaque: false })
    expect(s.groupRevision).toBe((await group(day))!.revision)
    const nativeDay = (await db().query<{ id: string; vendor_id: string; date: string; source: string; deal_id: string; at: string; revision: string }>(`select id,vendor_id,date::text,source,deal_id,
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,source_revision::text revision from vendor_busy_dates where id=$1`, [day])).rows[0]!
    expect(s.day).toEqual({ id: nativeDay.id, vendorId: nativeDay.vendor_id, date: nativeDay.date, source: nativeDay.source, dealId: nativeDay.deal_id, createdAt: nativeDay.at, sourceRevision: nativeDay.revision })
    const holders = s.knownHolders as { head: Record<string, unknown>; version: Record<string, unknown> }[]
    expect(holders).toHaveLength(2); expect(holders.map(h => h.version.dealId)).toEqual([first.id, second.id].sort())
    const versionKeys = ['id', 'weddingId', 'dealId', 'slotId', 'schemaVersion', 'revision', 'previousVersionId', 'originKnowledge', 'operation', 'recordedAt', 'contextKind', 'eventId', 'performerKind', 'vendorId', 'bindingState', 'serviceDate', 'timeZone', 'dayId']
    for (const h of holders) {
      expect(Object.keys(h).sort()).toEqual(['head', 'version']); expect(Object.keys(h.version).sort()).toEqual([...versionKeys].sort())
      expect(Object.keys(h.head).sort()).toEqual(['weddingId', 'dealId', 'revision', 'currentVersionId'].sort())
      const native = (await ledger(f, h.version.dealId as string)).current
      expect(h.head).toEqual({ weddingId: f.weddingId, dealId: native.deal_id, revision: native.revision, currentVersionId: native.id })
      expect(h.version).toEqual({ id: native.id, weddingId: native.wedding_id, dealId: native.deal_id, slotId: native.slot_id, schemaVersion: native.schema_version, revision: native.revision,
        previousVersionId: native.previous_version_id, originKnowledge: native.origin_knowledge, operation: native.operation,
        recordedAt: (await db().query<{ at: string }>(`select to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at from deal_day_scope_versions where id=$1`, [native.id])).rows[0]!.at,
        contextKind: native.context_kind, eventId: native.event_id, performerKind: native.performer_kind, vendorId: native.vendor_id, bindingState: native.binding_state, serviceDate: native.service_date, timeZone: native.time_zone, dayId: native.day_id })
    }
    expect((after.value.holders as { dealId: string }[]).map(h => h.dealId).sort()).toEqual([first.id, second.id].sort())
  })
  it('I1 NULL date root and vanished activated DATE never silently fall back to old encoding', async () => {
    const f = await fixture(catalogCases[2]!), l = await book(f), m = await material(f, 'app_root')
    expect(m.value.encoding).toBe('legacy-calendar-inventory/2'); expect(m.value.dayScopes).toEqual([])
    expect((await cancel(f)).statusCode).toBe(200)
    const after = await material(f, 'app_root', l.id); expect(after.value.encoding).toBe('legacy-calendar-inventory/2')
    expect((await ledger(f, l.id)).current.binding_state).toBe('released')
    const dated = await fixture(catalogCases[0]!), prior = await book(dated), root = await material(dated, 'app_root')
    await capture(dated, root.sourceId); const saved = await raw('legacy_calendar_versions', 'where t.source_id=$1', [root.sourceId])
    expect((await cancel(dated)).statusCode).toBe(200)
    expect(await raw('vendor_busy_dates', 'where t.id=$1', [prior.current.day_id])).toEqual([])
    const missing = await material(dated, 'app_root', prior.id); expect(missing.value.encoding).toBe('legacy-calendar-inventory/2')
    expect((missing.value.dayScopes as Record<string, unknown>[]).find(s => s.dayId === prior.current.day_id)).toMatchObject({ day: null, opaque: true })
    expect(await raw('legacy_calendar_versions', 'where t.source_id=$1', [root.sourceId])).toEqual(saved)
  })

  async function agreedResourceSibling(f: Fixture) {
    const n = await newVendor(f), sf = await sibling(n.fixture), id = randomUUID(); deals.add(id)
    // A genuine never-booked candidate; historical legacy() fixtures intentionally keep their booked_at marker.
    await db().query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price,currency,booked_at) values($1,$2,$3,$4,'candidate',17000,'RUB',null)",
      [id, sf.weddingId, sf.slotId, sf.vendorId])
    await db().query('update slots set deal_id=$2 where id=$1', [sf.slotId, id])
    expect((await db().query('select booked_at from deals where id=$1', [id])).rows).toEqual([{ booked_at: null }])
    expect((await db().query('select id from deal_day_scope_versions where deal_id=$1', [id])).rows).toEqual([])
    expect((await db().query('select id from vendor_busy_dates where vendor_id=$1', [n.id])).rows).toEqual([])
    const principal = (a: Actor) => ({ userId: a.id, sessionId: a.sid, policyVersion: POLICY })
    const resource = await db().tx(c => createResource(c, { vendorId: n.id, actor: principal(n.owner), kind: 'capacity', label: 'Independent genuine mixed capacity', capacityUnit: 'items' })); resources.add(resource.id)
    const window = await db().tx(c => createCapacityWindow(c, { vendorId: n.id, actor: principal(n.owner), resourceId: resource.id, startsAt: `${YEAR}-06-01T00:00:00Z`, endsAt: `${YEAR}-06-30T23:00:00Z`, capacity: 10 }))
    const input = { weddingId: f.weddingId, dealId: id, actor: principal(f.pair) }
    const assigned = await db().tx(c => createOrderAssignment(c, { ...input, expectedVersion: '1', slotId: sf.slotId, programEventId: sf.eventId, label: 'Independent actual resource duty' }))
    const part = await db().tx(c => createOrderPart(c, { ...input, expectedVersion: assigned.version, assignmentId: assigned.assignments[0]!.id, kind: 'timed_service', title: 'Independent resource service', details: {} }))
    const plan = await db().tx(c => saveOrderResourcePlan(c, { ...input, actor: principal(n.owner), expectedVersion: part.version, expectedPlanRevision: '0', lines: [{ partId: part.parts[0]!.id, resourceId: resource.id, capacityWindowId: window.id, quantity: 4,
      startsAt: `${YEAR}-06-14T07:00:00Z`, endsAt: `${YEAR}-06-14T09:00:00Z`, timeZone: 'Europe/Moscow', setupMinutes: 10, teardownMinutes: 15, travelBeforeMinutes: 20, travelAfterMinutes: 25 }] }))
    await db().tx(c => publishOrderTerms(c, { ...input, expectedOrderVersion: plan.orderVersion, expectedTermsRevision: '0' }))
    for (const a of [f.pair, n.owner]) {
      const read = await db().tx(c => loadOrderTerms(c, { ...input, actor: principal(a) }, { secret: SECRET })), selected = read.selected!
      assert(read.readToken); await db().tx(c => acceptOrderTerms(c, { ...input, actor: principal(a), termsId: selected.id, expectedTermsVersion: selected.version, digest: selected.digest, readToken: read.readToken! }, { secret: SECRET }))
    }
    const terms = await db().tx(c => loadOrderTerms(c, input, { secret: SECRET })); expect(terms.selected!.receipts).toHaveLength(2)
    const policy = await db().tx(c => setAvailabilityPolicy(c, { vendorId: n.id, actor: principal(n.owner), mode: 'resources', expectedRevision: '0' }))
    await db().tx(c => commitAgreedOrderResources(c, { ...input, expectedOrderVersion: plan.orderVersion, expectedCommitmentRevision: '0', termsId: terms.selected!.id, expectedTermsVersion: terms.selected!.version,
      termsDigest: terms.selected!.digest, planRevisionId: plan.current!.planRevisionId, expectedPolicyRevision: policy.revision }))
    const paid = await call('MIXED_RESOURCE_PAY', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${sf.slotId}/pay`, headers: idem(f.pair), payload: { amount: { amount: 1000, currency: 'RUB' } } })
    expect(paid.statusCode, paid.body).toBe(200)
    return { id, slotId: sf.slotId, eventId: sf.eventId, vendor: n.id, resource: resource.id }
  }
  it('R4 mixed resource agreement refuses main move; cancel legacy leaves full second terms/receipts/ledger/allocations/money byte-exact', async () => {
    const f = await fixture(catalogCases[0]!), l = await book(f), second = await agreedResourceSibling(f)
    const tables = [...moneyTables, 'deal_resource_plan_versions', 'deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'resource_allocations']
    const stable = async () => {
      const s: RawSnapshot = {}; for (const t of tables) s[t] = await raw(t, 'where t.deal_id=$1', [second.id])
      s.deals = await raw('deals', 'where t.id=$1', [second.id]); s.slots = await raw('slots', 'where t.id=$1', [second.slotId])
      s.program = await raw('wedding_events', 'where t.id=$1', [second.eventId]); return s
    }
    const other = await stable(); expect(other.deal_terms_receipts).toHaveLength(2); expect(other.resource_allocations!.length).toBeGreaterThan(0); expect(other.payments).toHaveLength(1)
    const before = await whole(), denied = await move(f, `${YEAR}-07-19`)
    expect(denied.statusCode).toBe(409); expect(await whole()).toEqual(before)
    expect((await cancel(f)).statusCode).toBe(200); expect(await stable()).toEqual(other)
    expect((await ledger(f, l.id)).current.binding_state).toBe('released')
  })
  it('R4 nonmain active literal date/tz cannot be rewritten and missing event context stays financial no-write', async () => {
    const f = await fixture(catalogCases[0]!), event = randomUUID(), slotId = randomUUID(); slots.add(slotId)
    await db().query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone) values($1,$2,'Independent additional','second_day',$3,'Asia/Novosibirsk')", [event, f.weddingId, `${YEAR}-06-15`])
    await db().query("insert into slots(id,wedding_id,category_id,label,program_event_id) values($1,$2,'photo','Independent nonmain',$3)", [slotId, f.weddingId, event])
    const extra = { ...f, slotId, eventId: event, date: `${YEAR}-06-15`, tz: 'Asia/Novosibirsk', explicit: true }
    const before = await whole(), denied = await bookResponse(extra)
    expect(denied.statusCode).toBe(428); expect(denied.json<{ error: { code: string } }>().error.code).toBe('event_context_required'); expect(await whole()).toEqual(before)
    // Honest storage-native active context (no public additional booking claim).
    const id = await legacy(extra), day = (await db().query<{ id: string }>('select id from vendor_busy_dates where vendor_id=$1 and date=$2', [f.vendorId, extra.date])).rows[0]!.id
    await db().tx(c => insertInitial(c, extra, id, { operation: 'observe', binding: 'active', day, origin: 'legacy_unknown', context: 'explicit_event' }))
    const events = await call('READ_EVENTS', f.pair, { method: 'GET', url: `/weddings/${f.weddingId}/events`, headers: auth(f.pair) }), saved = await whole()
    assert(typeof events.headers.etag === 'string')
    const changed = await call('ADDITIONAL_CONTEXT', f.pair, { method: 'PATCH', url: `/weddings/${f.weddingId}/events/${event}`, headers: { ...auth(f.pair), 'if-match': events.headers.etag }, payload: { date: `${YEAR}-06-16`, timeZone: 'Europe/Moscow' } })
    expect(changed.statusCode).toBe(409); expect(await whole()).toEqual(saved)
  })

  async function insertInitial(c: Queryable, f: Fixture, id: string, o: { operation?: string; origin?: string; binding?: string; day?: string | null; context?: string; event?: string | null; tz?: string | null } = {}) {
    const version = randomUUID(); versions.add(version)
    await c.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
      values($1,$2,$3,$4,1,1,null,$5,$6,$7,$8,'catalog',$9,$10,$11,$12,$13)`, [version, f.weddingId, id, f.slotId, o.origin ?? 'legacy_unknown', o.operation ?? 'observe_done', o.context ?? (f.explicit ? 'explicit_main' : 'implicit_main'), o.event === undefined ? f.eventId : o.event, f.vendorId,
      o.binding ?? 'done_undated', f.date, o.tz === undefined ? f.tz : o.tz, o.day ?? null])
    await c.query('insert into deal_day_scope_heads(wedding_id,deal_id,revision,current_version_id) values($1,$2,1,$3)', [f.weddingId, id, version]); return version
  }
  it.each(catalogCases.map(c => ({ ...c, date: null })))('R2 first SQL observe_done $label commits only exact legacy NULL own main and stays historical later', async c => {
    const f = await fixture(c), id = await legacy(f, 'done', false)
    let callback = false; await db().tx(async x => { await insertInitial(x, f, id); callback = true })
    expect(callback).toBe(true); const l = await ledger(f, id)
    expect(l.rows).toHaveLength(1); expect(l.current).toMatchObject({ operation: 'observe_done', origin_knowledge: 'legacy_unknown', binding_state: 'done_undated', service_date: null, time_zone: c.tz, day_id: null, is_current: true })
    const rawBefore = await raw(V, 'where t.deal_id=$1', [id]); expect((await move(f, `${YEAR}-11-12`, 'event', 'Asia/Yekaterinburg')).statusCode).toBe(200)
    expect(await raw(V, 'where t.deal_id=$1', [id])).toEqual(rawBefore); expect((await ledger(f, id)).current.is_current).toBe(true)
  })
  it.each(['wrong origin', 'old observe', 'old acquire', 'foreign event', 'late date', 'late selected slot'] as const)('R2 initial observe_done refuses $0 with valid real parents and native rollback', async change => {
    const f = await fixture(catalogCases[2]!), id = await legacy(f, 'done', false), foreign = await fixture(catalogCases[2]!), before = await whole()
    let callback = false, phase = 'INSERT_VERSION', error: unknown
    try { await db().tx(async c => {
      await insertInitial(c, f, id, { origin: change === 'wrong origin' ? 'observed_tracking' : 'legacy_unknown', operation: change === 'old observe' ? 'observe' : change === 'old acquire' ? 'acquire' : 'observe_done', event: change === 'foreign event' ? foreign.eventId : f.eventId })
      if (change === 'late date') await c.query('update weddings set date=$2 where id=$1', [f.weddingId, DATE])
      if (change === 'late selected slot') await c.query('update slots set deal_id=null where id=$1', [f.slotId])
      callback = true; phase = 'OUTER_COMMIT'
    }) } catch (e) { error = e }
    witness('OBSERVE_DONE_REFUSAL', { change, phase, callback, error: error && { code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }, before, after: await whole() })
    expect(error).toMatchObject({ code: '23514', constraint: ['wrong origin', 'old observe', 'old acquire'].includes(change) ? 'deal_day_scope_shape' : 'deal_day_scope_current' })
    expect(callback).toBe(change === 'late date' || change === 'late selected slot'); expect(await whole()).toEqual(before)
  })
  it('R3 cancel untracked legacy starts observe/released; no invented acquired history', async () => {
    const f = await fixture(catalogCases[0]!), id = await legacy(f), r = await cancel(f), l = await ledger(f, id)
    expect(r.statusCode, r.body).toBe(200); expect(l.rows).toHaveLength(1)
    expect(l.current).toMatchObject({ operation: 'observe', origin_knowledge: 'legacy_unknown', binding_state: 'released', day_id: null, is_current: true })
  })
  it('R6 same-key concurrent booking waits on receipt/domain and commits one exact immutable chain', async () => {
    const f = await fixture(catalogCases[0]!), key = randomUUID(), database = db(), original = database.tx, forward = database.tx.bind(database)
    const namespace = 2147482998, lockKey = randomInt(1, 2147483647), held = await gate('select pg_advisory_xact_lock($1::int,$2::int)', [namespace, lockKey])
    const scoped = `${f.pair.id}:slots.book:${key}`, requests: Promise<Response>[] = []
    let reached = false, writerPID = 0, receipt: unknown, failure: unknown, drained: PromiseSettledResult<unknown>[] = []
    database.tx = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => forward(c => action({ query: async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
      const result = await c.query<R>(sql, values)
      if (!reached && /update idempotency_keys[\s\S]*status/i.test(sql) && values?.[0] === scoped) {
        reached = true; writerPID = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
        receipt = (await c.query('select status,body from idempotency_keys where key=$1', [scoped])).rows
        await c.query('select pg_advisory_xact_lock($1::int,$2::int)', [namespace, lockKey])
      }
      return result
    } }))
    try {
      const first = bookResponse(f, f.vendorId, key); void first.catch(() => undefined); requests.push(first)
      const initialWait = await blocked(held.pid, 1, 'same-key receipt/first')
      expect(reached).toBe(true); expect(receipt).toMatchObject([{ status: 200 }]); expect(initialWait.map(r => r.pid)).toContain(writerPID)
      const second = bookResponse(f, f.vendorId, key); void second.catch(() => undefined); requests.push(second)
      const both = await blocked(held.pid, 2, 'same-key receipt/second')
      expect(both).toContainEqual(expect.objectContaining({ query: expect.stringMatching(/insert into idempotency_keys/i), blockers: expect.arrayContaining([writerPID]) }))
      witness('SAME_KEY_RECEIPT_WAIT', { scoped, writerPID, receipt, both })
    } catch (e) { failure = e }
    finally { held.release(); drained = await Promise.allSettled([held.holder, ...requests]); database.tx = original }
    const failed = drained.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
    if (failure !== undefined) failed.unshift(failure); if (failed.length) throw new AggregateError(failed, 'same-key receipt drain')
    const rows = await Promise.all(requests); expect(rows).toHaveLength(2)
    expect(rows[0].statusCode).toBe(200); expect(rows[1].statusCode).toBe(200); expect(rows[0].json()).toEqual(rows[1].json())
    expect(rows[0].headers['idempotent-replay']).toBeUndefined(); expect(rows[1].headers['idempotent-replay']).toBe('true')
    const l = await ledger(f); expect(l.rows).toHaveLength(1)
    expect((await db().query('select status from idempotency_keys where key=$1', [`${f.pair.id}:slots.book:${key}`])).rows).toEqual([{ status: 200 }])
  })
  it.each([false, true])('R6 genuine JWT expiry while blocked fresh/replay=%s rolls back writer or denies cached result', async replay => {
    const f = await fixture(catalogCases[0]!), key = randomUUID(); if (replay) await book(f, key)
    const before = await whole(), held = await gate('select id from weddings where id=$1 for update', [f.weddingId])
    const exp = Math.floor(Date.now() / 1000) + 3, token = await signAccessToken(SECRET, { sub: f.pair.id, sid: f.pair.sid }, (exp - ACCESS_TTL_SECONDS) * 1000)
    expect((await verifyAccessToken(SECRET, token)).exp).toBe(exp)
    const action = call('EXPIRY', { ...f.pair, token }, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: { vendorId: f.vendorId, price: { amount: 17000, currency: 'RUB' } } })
    void action.catch(() => undefined); let expired = false
    try {
      await blocked(held.pid, 1, 'JWT before expiry'); expect((await verifyAccessToken(SECRET, token)).exp).toBe(exp)
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        try { await verifyAccessToken(SECRET, token) } catch (e) { expect(e).toMatchObject({ statusCode: 401, code: 'token_expired' }); expired = true; break }
        await new Promise<void>(done => setTimeout(done, 10))
      }
      expect(expired).toBe(true); await blocked(held.pid, 1, 'JWT still blocked after verified expiry')
    } finally { held.release(); await Promise.all([held.holder, action]) }
    const response = await action; expect(response.statusCode).toBe(401); expect(response.headers['idempotent-replay']).toBeUndefined(); expect(await whole()).toEqual(before)
  })
  it('R6 actual SQL failure after replacement detach rolls back old root/day/group/head/new root/receipt and permits same-key retry', async () => {
    const f = await fixture(catalogCases[0]!), old = await book(f), n = await newVendor(f), before = await whole(), key = randomUUID(), database = db(), original = database.tx, forward = database.tx.bind(database)
    let hit = false, code: string | undefined
    database.tx = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => forward(async c => action({ query: async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
      const result = await c.query<R>(sql, values)
      if (!hit && /update deals set state\s*=\s*'cancelled'/i.test(sql) && values?.includes(old.id)) { hit = true; expect((await c.query('select state from deals where id=$1', [old.id])).rows).toEqual([{ state: 'cancelled' }]); try { await c.query('select 1/0') } catch (e) { code = (e as { code?: string }).code; throw e } }
      return result
    } }))
    let response: Response; try { response = await replace(f, old.id, n.id, key) } finally { database.tx = original }
    expect(hit).toBe(true); expect(code).toBe('22012'); expect(response.statusCode).toBe(500); expect(await whole()).toEqual(before)
    const retried = await replace(f, old.id, n.id, key); expect(retried.statusCode, retried.body).toBe(200)
    expect((await ledger(f, old.id)).current).toMatchObject({ operation: 'release', binding_state: 'released', day_id: null })
    const current = await ledger(f); expect(current.id).not.toBe(old.id); expect(current.current).toMatchObject({ vendor_id: n.id, operation: 'acquire', is_current: true })
  })

  it('R4 two exact main holders D1→D2 both append before old reconcile; no opaque ghost D1', async () => {
    const f = await fixture(catalogCases[0]!), a = await book(f), sf = await sibling(f), b = await book(sf), oldDay = a.current.day_id!
    const oldSource = await material(f, 'app_day', oldDay); await capture(f, oldSource.sourceId)
    const oldSourceRaw = await raw('legacy_calendar_sources', 'where t.id=$1', [oldSource.sourceId])
    const oldVersions = await raw('legacy_calendar_versions', 'where t.source_id=$1', [oldSource.sourceId])
    const oldHolders = await raw('legacy_calendar_version_holders', 'where t.source_id=$1', [oldSource.sourceId])
    const moneyA = await money(a.id), moneyB = await money(b.id), r = await move(f, `${YEAR}-10-21`)
    expect(r.statusCode, r.body).toBe(200); const nextA = await ledger(f), nextB = await ledger(sf)
    expect(nextA.current).toMatchObject({ operation: 'move', service_date: `${YEAR}-10-21`, is_current: true })
    expect(nextB.current).toMatchObject({ operation: 'move', service_date: `${YEAR}-10-21`, is_current: true, day_id: nextA.current.day_id })
    expect(nextA.current.day_id).not.toBe(oldDay)
    expect(await raw('vendor_busy_dates', 'where t.id=$1', [oldDay])).toEqual([]); expect(await group(oldDay)).toBeUndefined()
    expect((await db().query('select id from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([{ id: nextA.current.day_id }])
    expect(await group(nextA.current.day_id!)).toMatchObject({ classification: 'exact', legacy_candidates: [] })
    const m = await material(f, 'app_day', nextA.current.day_id!); expect(m.sourceId).not.toBe(oldSource.sourceId)
    expect(((m.value.dayScopes as Record<string, unknown>[])[0]!.knownHolders as unknown[])).toHaveLength(2)
    expect(await raw('legacy_calendar_sources', 'where t.id=$1', [oldSource.sourceId])).toEqual(oldSourceRaw)
    expect(await raw('legacy_calendar_versions', 'where t.source_id=$1', [oldSource.sourceId])).toEqual(oldVersions)
    expect(await raw('legacy_calendar_version_holders', 'where t.source_id=$1', [oldSource.sourceId])).toEqual(oldHolders)
    const actor = { userId: f.company.id, sessionId: f.company.sid, policyVersion: POLICY }
    const inventory = await db().tx(c => loadLegacyCalendarInventory(c, { vendorId: f.vendorId, actor }))
    expect(inventory.sources.find(s => s.sourceId === oldSource.sourceId)).toMatchObject({ freshness: 'unavailable' })
    expect(await money(a.id)).toEqual(moneyA); expect(await money(b.id)).toEqual(moneyB)
  })
  it('R3 legacy OPEN move removes only its own possible memberships and keeps done-U old DATE/origin forever unknown', async () => {
    const f = await fixture(catalogCases[0]!), old = await legacy(f), other = await sibling(f), done = await legacy(other, 'done', false), next = await sibling(f), n = await book(next), day = n.current.day_id!
    expect((await group(day))!.legacy_candidates).toEqual([old, done].sort())
    const r = await move(f, `${YEAR}-09-21`); expect(r.statusCode, r.body).toBe(200)
    expect((await ledger(f, old)).rows[0]!.origin_knowledge).toBe('legacy_unknown')
    expect((await ledger(f, old)).current).toMatchObject({ service_date: `${YEAR}-09-21`, is_current: true })
    expect((await group(day))!.legacy_candidates).toEqual([done]); expect((await db().query('select id,deal_id from vendor_busy_dates where id=$1', [day])).rows).toEqual([{ id: day, deal_id: done }])
    expect((await db().query('select state from deals where id=$1', [done])).rows).toEqual([{ state: 'done' }])
  })
  it.each(['date', 'pointer', 'root', 'head', 'group identity'] as const)('R6 bare managed $0 mutation cannot bypass final guard by omitting version INSERT', async field => {
    const f = await fixture(catalogCases[0]!), l = await book(f), foreign = await fixture(catalogCases[0]!), other = await legacy(foreign), before = await whole()
    let callback = false, error: unknown
    try { await db().tx(async c => {
      if (field === 'date') await c.query('update weddings set date=$2 where id=$1', [f.weddingId, `${YEAR}-12-19`])
      if (field === 'pointer') await c.query('update vendor_busy_dates set deal_id=$2 where id=$1', [l.current.day_id, other])
      if (field === 'root') await c.query("update deals set state='cancelled' where id=$1", [l.id])
      if (field === 'head') await c.query('delete from deal_day_scope_heads where deal_id=$1', [l.id])
      if (field === 'group identity') await c.query('update legacy_day_groups set service_date=service_date+1 where day_id=$1', [l.current.day_id])
      callback = true
    }) } catch (e) { error = e }
    witness('BARE_MANAGED_REFUSAL', { field, callback, error: error && { code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }, before, after: await whole() })
    expect(error).toMatchObject({ code: '23514' }); expect(await whole()).toEqual(before)
    if (field === 'root' || field === 'date') expect(callback).toBe(true)
  })
  it('R3 SQL resolve rejects a real current but noncancelled root and stale CAS; no caller boolean can clear U', async () => {
    const f = await fixture(catalogCases[0]!), old = await legacy(f), other = await sibling(f), l = await book(other), g = (await group(l.current.day_id!))!, before = await whole()
    for (const revision of [g.revision, String(BigInt(g.revision) + 1n)]) {
      let error: unknown
      try { await db().tx(async c => {
        await c.query('select legacy_day_lock_vendors($1::uuid[])', [[f.vendorId]])
        await c.query("select legacy_day_resolve($1,$2,$3,$4,'cancel')", [l.current.day_id, old, revision, l.current.id])
      }) } catch (e) { error = e }
      expect(error).toMatchObject({ code: '23514', constraint: 'legacy_day_group_resolution' }); expect(await whole()).toEqual(before)
    }
  })
  it.each(['unknown encoding', 'extra field', 'missing nonpointer', 'nested extra', 'nested head revision'] as const)('I1 capture INSERT refuses $0 with valid parent/digest and no count-only waiver', async change => {
    const f = await fixture(catalogCases[0]!), a = await book(f), other = await sibling(f); await book(other)
    const m = await material(f); await capture(f, m.sourceId)
    const previous = (await db().query<{ id: string; revision: string }>('select id,revision::text from legacy_calendar_versions where source_id=$1 order by revision desc limit 1', [m.sourceId])).rows[0]!, before = await whole()
    const bad = structuredClone(m.value)
    if (change === 'unknown encoding') bad.encoding = 'legacy-calendar-inventory/3'
    if (change === 'extra field') bad.unreviewed = true
    if (change === 'missing nonpointer') {
      const scope = (bad.dayScopes as { knownHolders: { version: { dealId: string } }[] }[])[0]!
      scope.knownHolders = scope.knownHolders.filter(h => h.version.dealId === a.id)
    }
    if (change === 'nested extra' || change === 'nested head revision') {
      const h = (bad.holders as { dayScope: Record<string, unknown> }[])[0]!
      expect(h.dayScope).toBeTruthy()
      if (change === 'nested extra') h.dayScope.unreviewed = true
      else (h.dayScope.head as Record<string, unknown>).revision = '999'
    }
    let error: unknown
    try { await db().tx(async c => {
      await c.query(`insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by)
        select $1,$2,$3,$4,$5::jsonb::text,encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex'),'owner_capture',$6`,
      [randomUUID(), m.sourceId, String(BigInt(previous.revision) + 1n), previous.id, JSON.stringify(bad), f.company.id])
    }) } catch (e) { error = e }
    expect(error).toMatchObject({ code: '23514' }); expect(await whole()).toEqual(before)
  })
  it('I1 full correct /2 canonical cannot commit a head whose per-version holders are absent', async () => {
    const f = await fixture(catalogCases[0]!), l = await book(f), m = await material(f); await capture(f, m.sourceId)
    const previous = (await db().query<{ id: string; revision: string; canonical: string; digest: string }>('select id,revision::text,canonical,digest from legacy_calendar_versions where source_id=$1 order by revision desc limit 1', [m.sourceId])).rows[0]!, before = await whole(), id = randomUUID()
    let callback = false, error: unknown
    try { await db().tx(async c => {
      await c.query("insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by) values($1,$2,$3,$4,$5,$6,'owner_capture',$7)", [id, m.sourceId, String(BigInt(previous.revision) + 1n), previous.id, previous.canonical, previous.digest, f.company.id])
      await c.query('update legacy_calendar_heads set revision=revision+1,current_version_id=$2 where source_id=$1', [m.sourceId, id])
      expect((await c.query('select id from deals where id=$1', [l.id])).rows).toHaveLength(1); callback = true
    }) } catch (e) { error = e }
    expect(callback).toBe(true); expect(error).toMatchObject({ code: '23514', message: expect.stringContaining('holders') }); expect(await whole()).toEqual(before)
  })
  it('I1 nonpointer cancellation stales captured /2 without changing pointer source_revision or immutable capture', async () => {
    const f = await fixture(catalogCases[0]!), a = await book(f), sf = await sibling(f); await book(sf)
    const m = await material(f); await capture(f, m.sourceId)
    const saved = await raw('legacy_calendar_versions', 'where t.source_id=$1', [m.sourceId]), pointer = await raw('vendor_busy_dates', 'where t.id=$1', [a.current.day_id])
    expect((await cancel(sf)).statusCode).toBe(200); expect(await raw('vendor_busy_dates', 'where t.id=$1', [a.current.day_id])).toEqual(pointer)
    expect((await material(f)).value).not.toEqual(m.value); expect(await raw('legacy_calendar_versions', 'where t.source_id=$1', [m.sourceId])).toEqual(saved)
    const actor = { userId: f.company.id, sessionId: f.company.sid, policyVersion: POLICY }, inv = await db().tx(c => loadLegacyCalendarInventory(c, { vendorId: f.vendorId, actor }))
    expect(inv.sources.find(s => s.sourceId === m.sourceId)!.freshness).toBe('stale')
  })
  it('R2 vendor erasure is a stale evidence exception: payment/done/cancel do not forge replacement catalog authority', async () => {
    const f = await fixture(catalogCases[0]!), l = await book(f), rawLedger = await raw(V, 'where t.deal_id=$1', [l.id])
    await db().tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [f.weddingId])
      await c.query('select legacy_day_lock_vendors($1::uuid[])', [[f.vendorId]])
      await c.query("update deals set vendor_id=null,external_name='Удалённый подрядчик' where id=$1", [l.id]); await c.query('delete from vendors where id=$1', [f.vendorId])
    })
    const paid = await call('ERASED_PAY', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/pay`, headers: idem(f.pair), payload: { amount: { amount: 1000, currency: 'RUB' } } })
    expect(paid.statusCode, paid.body).toBe(200); expect(await raw(V, 'where t.deal_id=$1', [l.id])).toEqual(rawLedger)
    const done = await patch(f, l.id, 'done'); expect(done.statusCode, done.body).toBe(200); expect(await raw(V, 'where t.deal_id=$1', [l.id])).toEqual(rawLedger)
    expect((await ledger(f)).current.is_current).toBe(false)
    const before = await whole(), denied = await cancel(f); expect(denied.statusCode).toBe(409); expect(await whole()).toEqual(before)
  })

  it('R6 expiry after actual domain writes and saved receipt plus genuine PG wait rolls everything back', async () => {
    const f = await fixture(catalogCases[0]!), key = randomUUID(), before = await whole(), database = db(), original = database.tx, forward = database.tx.bind(database)
    const namespace = 2147482999, lockKey = randomInt(1, 2147483647), held = await gate('select pg_advisory_xact_lock($1::int,$2::int)', [namespace, lockKey])
    let reached = false, receipt: unknown, inside: RawSnapshot | undefined
    const exp = Math.floor(Date.now() / 1000) + 3, token = await signAccessToken(SECRET, { sub: f.pair.id, sid: f.pair.sid }, (exp - ACCESS_TTL_SECONDS) * 1000)
    database.tx = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => forward(c => action({ query: async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
      const result = await c.query<R>(sql, values)
      if (!reached && /update idempotency_keys[\s\S]*status/i.test(sql)) {
        reached = true; receipt = (await c.query('select status,body from idempotency_keys where key=$1', [`${f.pair.id}:slots.book:${key}`])).rows
        inside = await whole(c); await c.query('select pg_advisory_xact_lock($1::int,$2::int)', [namespace, lockKey])
      }
      return result
    } }))
    const action = call('LATE_EXPIRY', { ...f.pair, token }, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: { vendorId: f.vendorId, price: { amount: 17000, currency: 'RUB' } } }); void action.catch(() => undefined)
    let expired = false, failure: unknown, drained: PromiseSettledResult<unknown>[] = []
    try {
      await blocked(held.pid, 1, 'late receipt expiry'); expect(reached).toBe(true); expect(receipt).toMatchObject([{ status: 200 }])
      expect(inside![V]!.length).toBeGreaterThan(before[V]!.length); expect(inside![H]!.length).toBeGreaterThan(before[H]!.length)
      expect((await verifyAccessToken(SECRET, token)).exp).toBe(exp)
      const until = Date.now() + 5000
      while (Date.now() < until) { try { await verifyAccessToken(SECRET, token) } catch (e) { expect(e).toMatchObject({ code: 'token_expired' }); expired = true; break }; await new Promise<void>(done => setTimeout(done, 10)) }
      expect(expired).toBe(true)
    } catch (e) { failure = e }
    finally { held.release(); drained = await Promise.allSettled([held.holder, action]); database.tx = original }
    const failed = drained.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
    if (failure !== undefined) failed.unshift(failure); if (failed.length) throw new AggregateError(failed, 'late expiry drain')
    const r = await action; witness('LATE_EXPIRY', { reached, expired, receipt, inside, status: r.statusCode, before, after: await whole() })
    expect(r.statusCode).toBe(401); expect(r.json<{ error: { code: string } }>().error.code).toBe('token_expired'); expect(await whole()).toEqual(before)
  })

  it('R2 public tracked external done retains literal tuple without catalog DATE or fake origin', async () => {
    const f = await fixture(externalCases[1]!), response = await call('EXTERNAL', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair), payload: { vendorName: 'Independent known external', price: { amount: 17000, currency: 'RUB' } } })
    expect(response.statusCode).toBe(200); const before = await ledger(f), finance = await money(before.id)
    const done = await patch(f, before.id, 'done'); expect(done.statusCode, done.body).toBe(200)
    const after = await ledger(f); expect(after.rows).toHaveLength(2); expect(after.current).toMatchObject({ operation: 'retain_done', binding_state: 'external', performer_kind: 'external', vendor_id: null, day_id: null, is_current: true })
    expect(tuple(after.current)).toEqual(tuple(before.current)); expect(await money(before.id)).toEqual(finance)
  })
  async function appendExternalRetain(c: Queryable, f: Fixture, first: Awaited<ReturnType<typeof ledger>>, inserted: () => void) {
    const previous = first.current, id = randomUUID()
    await c.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
      values($1,$2,$3,$4,1,$5,$6,null,'retain_done',$7,$8,'external',null,'external',$9,$10,null)`,
    [id, f.weddingId, first.id, f.slotId, String(BigInt(previous.revision) + 1n), previous.id, previous.context_kind, previous.event_id, previous.service_date, previous.time_zone])
    inserted()
    await c.query('update deal_day_scope_heads set revision=revision+1,current_version_id=$2 where deal_id=$1', [first.id, id])
    return id
  }
  it('R2 external retain_done cannot be inserted while its actual root is still booked', async () => {
    const f = await fixture(externalCases[1]!), response = await call('EXTERNAL_RETAIN_SETUP', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair), payload: { vendorName: 'Independent external terminal guard', price: { amount: 17000, currency: 'RUB' } } })
    expect(response.statusCode, response.body).toBe(200)
    const first = await ledger(f), before = await whole(); let phase = 'INSERT_VERSION', callback = false, error: unknown
    try { await db().tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [f.weddingId])
      expect((await c.query('select state from deals where id=$1 for update', [first.id])).rows).toEqual([{ state: 'booked' }])
      await appendExternalRetain(c, f, first, () => { phase = 'ADVANCE_HEAD' })
      callback = true; phase = 'OUTER_COMMIT'
    }) } catch (e) { error = e }
    witness('EXTERNAL_RETAIN_BOOKED_REFUSAL', { phase, callback, error: error && { code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }, before, after: await whole() })
    expect(phase).toBe('INSERT_VERSION'); expect(callback).toBe(false)
    expect(error).toMatchObject({ code: '23514', constraint: 'deal_day_scope_shape' }); expect(await whole()).toEqual(before)
  })
  it('R2 external retained terminal head rechecks live done state at the true outer COMMIT', async () => {
    const f = await fixture(externalCases[1]!), response = await call('EXTERNAL_FINAL_STATE_SETUP', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair), payload: { vendorName: 'Independent external final-state guard', price: { amount: 17000, currency: 'RUB' } } })
    expect(response.statusCode, response.body).toBe(200)
    const first = await ledger(f), before = await whole(); let phase = 'SET_DONE', callback = false, error: unknown
    try { await db().tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [f.weddingId])
      await c.query("update deals set state='done' where id=$1", [first.id]); phase = 'INSERT_VERSION'
      const id = await appendExternalRetain(c, f, first, () => { phase = 'ADVANCE_HEAD' })
      expect((await c.query('select current_version_id from deal_day_scope_heads where deal_id=$1', [first.id])).rows).toEqual([{ current_version_id: id }])
      expect((await c.query('select deal_day_scope_matches_current(v) current from deal_day_scope_versions v where id=$1', [id])).rows).toEqual([{ current: true }])
      phase = 'REVERT_STATE'; await c.query("update deals set state='booked' where id=$1", [first.id])
      callback = true; phase = 'OUTER_COMMIT'
    }) } catch (e) { error = e }
    witness('EXTERNAL_RETAIN_FINAL_STATE_REFUSAL', { phase, callback, error: error && { code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }, before, after: await whole() })
    expect(phase).toBe('OUTER_COMMIT'); expect(callback).toBe(true)
    expect(error).toMatchObject({ code: '23514', constraint: 'deal_day_scope_current' }); expect(await whole()).toEqual(before)
  })
  it.each(['policy', 'company account'] as const)('R6 $0 changed after actual vendor-prefix wait refuses first book without residual claim/financial/day rows', async change => {
    const f = await fixture(catalogCases[0]!), key = randomUUID()
    if (change === 'policy') {
      const r = await call('POLICY_RESOURCE_FIXTURE', f.company, { method: 'POST', url: `/vendors/${f.vendorId}/resources`, headers: idem(f.company), payload: { kind: 'equipment', label: 'Actual policy wait resource' } })
      expect(r.statusCode).toBe(200); resources.add(r.json<{ id: string }>().id)
    }
    let expected: RawSnapshot | undefined
    const held = await gate(change === 'policy' ? 'select id from vendors where id=$1 for update' : 'select id from users where id=$1 for update', [change === 'policy' ? f.vendorId : f.company.id], async c => {
      if (change === 'policy') await c.query("insert into vendor_availability_policy(vendor_id,mode,changed_by) values($1,'resources',$2)", [f.vendorId, f.company.id])
      else await c.query('update users set deleted_at=clock_timestamp() where id=$1', [f.company.id])
      expected = await whole(c); expected.idempotency_keys = expected.idempotency_keys!.filter(row => { const r = JSON.parse(row) as { key: string; status: number | null }; return !r.key.endsWith(':' + key) || r.status !== null })
    })
    const action = bookResponse(f, f.vendorId, key); void action.catch(() => undefined)
    try { await blocked(held.pid, 1, `source/${change}`) } finally { held.release(); await Promise.all([held.holder, action]) }
    const r = await action; expect([404, 409]).toContain(r.statusCode); expect(await whole()).toEqual(expected)
  })

  it('R2 known external legacy nohead completion observes external legacy_unknown without manufactured DATE', async () => {
    const f = await fixture(externalCases[0]!), id = randomUUID(); deals.add(id)
    await db().query("insert into deals(id,wedding_id,slot_id,external_name,state,price,currency) values($1,$2,$3,'Synthetic historical external','booked',17000,'RUB')", [id, f.weddingId, f.slotId])
    await db().query('update slots set deal_id=$2 where id=$1', [f.slotId, id]); const finance = await money(id)
    const r = await patch(f, id, 'done'), l = await ledger(f, id)
    expect(r.statusCode, r.body).toBe(200); expect(l.rows).toHaveLength(1)
    expect(l.current).toMatchObject({ operation: 'observe', origin_knowledge: 'legacy_unknown', performer_kind: 'external', binding_state: 'external', vendor_id: null, service_date: null, time_zone: null, day_id: null, is_current: true })
    expect(await money(id)).toEqual(finance)
  })
  it.each(['slot event', 'slot removed', 'wedding archived', 'wedding cancelled'] as const)('R6 current $0 revalidation after real wait denies without stale command write', async change => {
    const f = await fixture(catalogCases[0]!), key = randomUUID(), event = randomUUID()
    await db().query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone) values($1,$2,'Actual adversarial extra','second_day',$3,'Asia/Novosibirsk')", [event, f.weddingId, `${YEAR}-06-15`])
    let expected: RawSnapshot | undefined
    const held = await gate('select id from weddings where id=$1 for update', [f.weddingId], async c => {
      if (change === 'slot event') await c.query('update slots set program_event_id=$2 where id=$1', [f.slotId, event])
      if (change === 'slot removed') await c.query('delete from slots where id=$1', [f.slotId])
      if (change === 'wedding archived') await c.query('update weddings set archived_at=clock_timestamp() where id=$1', [f.weddingId])
      if (change === 'wedding cancelled') await c.query('update weddings set cancelled_at=clock_timestamp() where id=$1', [f.weddingId])
      expected = await whole(c); expected.idempotency_keys = expected.idempotency_keys!.filter(row => { const r = JSON.parse(row) as { key: string; status: number | null }; return !r.key.endsWith(':' + key) || r.status !== null })
    })
    const action = bookResponse(f, f.vendorId, key); void action.catch(() => undefined)
    try { await blocked(held.pid, 1, `current-context/${change}`) } finally { held.release(); await Promise.all([held.holder, action]) }
    const r = await action, changedParent = change === 'slot event' || change === 'slot removed'
    expect(r.statusCode, r.body).toBe(changedParent ? 409 : 404)
    if (changedParent) expect(r.json<{ error: { code: string } }>().error.code).toBe('calendar_scope_changed')
    expect(await whole()).toEqual(expected)
  })

  it.each(['undated', 'unknown'] as const)('I1 typed root $0 ledger-only advancement changes digest with dayScopes[] and exact old holder base', async binding => {
    const f = await fixture(catalogCases[2]!)
    let l: Awaited<ReturnType<typeof ledger>>
    if (binding === 'undated') l = await book(f)
    else { const id = await legacy(f, 'booked', false); await db().tx(c => insertInitial(c, f, id, { operation: 'observe', binding: 'unknown', context: 'unknown', event: null })); l = await ledger(f, id) }
    const before = await material(f, 'app_root'), rawBefore = await whole()
    expect(before.value.encoding).toBe('legacy-calendar-inventory/2'); expect(before.value.dayScopes).toEqual([])
    const base = (await db().query<{ value: Record<string, unknown> }>('select legacy_calendar_holder($1,$2) value', [f.weddingId, l.id])).rows[0]!.value
    const root = before.value.root as Record<string, unknown>
    expect(Object.keys(root).sort()).toEqual([...Object.keys(base), 'dayScope'].sort())
    expect(Object.fromEntries(Object.entries(root).filter(([k]) => k !== 'dayScope'))).toEqual(base)
    const nested = root.dayScope as { head: Record<string, unknown>; version: Record<string, unknown> }
    expect(Object.keys(nested).sort()).toEqual(['head', 'version']); expect(Object.keys(nested.head).sort()).toEqual(['weddingId', 'dealId', 'revision', 'currentVersionId'].sort()); expect(Object.keys(nested.version)).toHaveLength(18)
    const id = randomUUID(); versions.add(id)
    await db().tx(async c => {
      await c.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
        values($1,$2,$3,$4,1,2,$5,null,'acquire',$6,$7,'catalog',$8,'undated',null,$9,null)`, [id, f.weddingId, l.id, f.slotId, l.current.id, f.explicit ? 'explicit_main' : 'implicit_main', f.eventId, f.vendorId, f.tz])
      await c.query('update deal_day_scope_heads set revision=2,current_version_id=$2 where deal_id=$1', [l.id, id])
    })
    const after = await material(f, 'app_root'), rawAfter = await whole(), changed = after.value.root as Record<string, unknown>
    expect(after.digest).not.toBe(before.digest); expect(after.value.dayScopes).toEqual([])
    expect(Object.fromEntries(Object.entries(changed).filter(([k]) => k !== 'dayScope'))).toEqual(base)
    expect((changed.dayScope as { head: unknown }).head).toEqual({ weddingId: f.weddingId, dealId: l.id, revision: '2', currentVersionId: id })
    expect(after.value.holders).toEqual([changed]); expect({ ...rawAfter, [V]: [], [H]: [] }).toEqual({ ...rawBefore, [V]: [], [H]: [] })
  })

  it('I1 genuine external pure typed projection includes exact head/version and changes on ledger revision; no invented owner source', async () => {
    const f = await fixture(externalCases[0]!), r = await call('EXTERNAL_TYPED_FIXTURE', f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair), payload: { vendorName: 'Independent external typed projection', price: { amount: 17000, currency: 'RUB' } } })
    expect(r.statusCode).toBe(200); const l = await ledger(f), before = await whole()
    const projection = async () => (await db().query<{ value: Record<string, unknown> }>('select legacy_calendar_holder_v2($1,$2) value', [f.weddingId, l.id])).rows[0]!.value
    const first = await projection(), base = (await db().query<{ value: Record<string, unknown> }>('select legacy_calendar_holder($1,$2) value', [f.weddingId, l.id])).rows[0]!.value
    expect(Object.keys(first).sort()).toEqual([...Object.keys(base), 'dayScope'].sort())
    expect(Object.fromEntries(Object.entries(first).filter(([key]) => key !== 'dayScope'))).toEqual(base)
    const firstScope = first.dayScope as { head: Record<string, unknown>; version: Record<string, unknown> }
    expect(Object.keys(firstScope).sort()).toEqual(['head', 'version']); expect(Object.keys(firstScope.head)).toHaveLength(4); expect(Object.keys(firstScope.version)).toHaveLength(18)
    expect(firstScope.head).toEqual({ weddingId: f.weddingId, dealId: l.id, revision: '1', currentVersionId: l.current.id })
    expect(firstScope.version).toMatchObject({ id: l.current.id, bindingState: 'external', performerKind: 'external', vendorId: null, serviceDate: null, dayId: null, timeZone: null })
    const id = randomUUID(); versions.add(id)
    await db().tx(async c => {
      await c.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
        values($1,$2,$3,$4,1,2,$5,null,'acquire','implicit_main',$6,'external',null,'external',null,null,null)`, [id, f.weddingId, l.id, f.slotId, l.current.id, f.eventId])
      await c.query('update deal_day_scope_heads set revision=2,current_version_id=$2 where deal_id=$1', [l.id, id])
    })
    const after = await projection(); expect(after).not.toEqual(first)
    expect((after.dayScope as { head: unknown }).head).toEqual({ weddingId: f.weddingId, dealId: l.id, revision: '2', currentVersionId: id })
    expect(Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'dayScope'))).toEqual(base)
    const final = await whole(); expect({ ...final, [V]: [], [H]: [] }).toEqual({ ...before, [V]: [], [H]: [] })
    expect((await db().query('select id from legacy_calendar_sources where root_deal_id=$1', [l.id])).rows).toEqual([])
  })

  it('R4 legacy nohead timezone-only move resolves own U on the same physical DATE', async () => {
    const f = await fixture(catalogCases[0]!), id = await legacy(f), sf = await sibling(f), otherU = await legacy(sf, 'done', false)
    const day = (await db().query<{ id: string }>('select id from vendor_busy_dates where vendor_id=$1 and date=$2', [f.vendorId, f.date])).rows[0]!.id
    expect(await group(day)).toBeUndefined()
    const otherBefore = { root: await raw('deals', 'where t.id=$1', [otherU]), money: await money(otherU), slot: await raw('slots', 'where t.id=$1', [sf.slotId]), versions: await raw(V, 'where t.deal_id=$1', [otherU]), heads: await raw(H, 'where t.deal_id=$1', [otherU]) }
    const before = await whole(), r = await call('LEGACY_TZ_ONLY', f.pair, { method: 'PATCH', url: `/weddings/${f.weddingId}`, headers: auth(f.pair), payload: { tz: 'Asia/Novosibirsk' } })
    const l = await ledger(f, id), g = await group(day), after = await whole()
    witness('LEGACY_TZ_EXPECT_SUCCESS', { expected: { ownUResolved: id, otherURetained: otherU, sameDay: day }, status: r.statusCode, body: r.body, ledger: l, group: g ?? null, before, after })
    expect(r.statusCode, r.body).toBe(200)
    expect(l.rows.map(v => v.operation)).toEqual(['observe', 'move']); expect(l.rows[0]!.origin_knowledge).toBe('legacy_unknown')
    expect(l.current).toMatchObject({ binding_state: 'active', service_date: f.date, time_zone: 'Asia/Novosibirsk', day_id: day, is_current: true })
    expect(g).toMatchObject({ day_id: day, vendor_id: f.vendorId, wedding_id: f.weddingId, legacy_candidates: [otherU] })
    expect((await db().query('select id from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([{ id: day }])
    const m = await material(f), scope = (m.value.dayScopes as { dayId: string; knownHolders: { version: { dealId: string } }[] }[]).find(s => s.dayId === day)!
    expect(scope.knownHolders.map(h => h.version.dealId)).toEqual([id])
    expect({ root: await raw('deals', 'where t.id=$1', [otherU]), money: await money(otherU), slot: await raw('slots', 'where t.id=$1', [sf.slotId]), versions: await raw(V, 'where t.deal_id=$1', [otherU]), heads: await raw(H, 'where t.deal_id=$1', [otherU]) }).toEqual(otherBefore)
  })
  it('R4 legacy additional sibling cannot create team_busy for a main-only move', async () => {
    const f = await fixture(catalogCases[0]!), a = await book(f), n = await newVendor(f), event = randomUUID(), slotId = randomUUID(), nextDate = `${YEAR}-10-22`, extraDate = `${YEAR}-06-16`
    slots.add(slotId)
    await db().query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone) values($1,$2,'Synthetic existing legacy additional','second_day',$3,'Asia/Novosibirsk')", [event, f.weddingId, extraDate])
    await db().query("insert into slots(id,wedding_id,category_id,label,program_event_id) values($1,$2,'photo','Synthetic existing legacy additional position',$3)", [slotId, f.weddingId, event])
    const extra = { ...n.fixture, slotId, eventId: event, explicit: true, date: extraDate, tz: 'Asia/Novosibirsk' }, id = await legacy(extra)
    await db().query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual')", [n.id, nextDate])
    const stable = async () => ({ root: await raw('deals', 'where t.id=$1', [id]), money: await money(id), slot: await raw('slots', 'where t.id=$1', [slotId]), event: await raw('wedding_events', 'where t.id=$1', [event]), versions: await raw(V, 'where t.deal_id=$1', [id]), heads: await raw(H, 'where t.deal_id=$1', [id]), days: await raw('vendor_busy_dates', 'where t.vendor_id=$1', [n.id]), groups: await raw('legacy_day_groups', 'where t.vendor_id=$1', [n.id]) })
    const siblingBefore = await stable(), before = await whole(), r = await move(f, nextDate), after = await whole()
    witness('MAIN_ONLY_WITH_LEGACY_EXTRA_EXPECT_SUCCESS', { mainRoot: a.id, legacyExtraRoot: id, extraEvent: event, nextDate, status: r.statusCode, body: r.body, before, after, siblingBefore, siblingAfter: await stable() })
    expect(r.statusCode, r.body).toBe(200)
    expect((await ledger(f, a.id)).current).toMatchObject({ operation: 'move', service_date: nextDate, is_current: true })
    expect(await stable()).toEqual(siblingBefore)
    expect(siblingBefore.heads).toEqual([]); expect(siblingBefore.versions).toEqual([])
    expect((await db().query('select date::text,source,deal_id from vendor_busy_dates where vendor_id=$1 order by date', [n.id])).rows).toEqual([
      { date: extraDate, source: 'deal', deal_id: id }, { date: nextDate, source: 'manual', deal_id: null }])
  })
})
