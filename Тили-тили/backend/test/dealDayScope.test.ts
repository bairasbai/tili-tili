import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

// Independent requirements tests, written before the foundation implementation.
// Contract 6A09FC0B...: schema fixtures are NOT booking writers/authority.
// Initial RED must select only the catalogue title below. No missing-module
// import or missing-relation query is needed to reach that assertion.
const DATABASE = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'deal-day-scope-foundation-independent-native-'.repeat(2)
const VERSIONS = 'deal_day_scope_versions', HEADS = 'deal_day_scope_heads'
const versionColumns = ['id', 'wedding_id', 'deal_id', 'slot_id', 'schema_version', 'revision', 'previous_version_id',
  'origin_knowledge', 'operation', 'recorded_at', 'context_kind', 'event_id', 'performer_kind', 'vendor_id',
  'binding_state', 'service_date', 'time_zone', 'day_id'] as const
const headColumns = ['deal_id', 'wedding_id', 'revision', 'current_version_id'] as const
type Version = {
  id: string; wedding_id: string; deal_id: string; slot_id: string; schema_version: number; revision: string
  previous_version_id: string | null; origin_knowledge: string | null; operation: string; recorded_at: string
  context_kind: string; event_id: string | null; performer_kind: string; vendor_id: string | null
  binding_state: string; service_date: string | null; time_zone: string | null; day_id: string | null
}
type ScopeView = {
  revision: string; versionId: string
  origin: { knowledge: 'observed_tracking' | 'legacy_unknown'; eventId: string | null; date: string | null; timeZone: string | null }
  current: { bindingState: string; performerKind: string; contextKind: string; slotId: string; eventId: string | null
    vendorId: string | null; date: string | null; timeZone: string | null; dayId: string | null }
  freshness: 'current' | 'stale'
}
type Reader = (client: Queryable, input: { weddingId: string; dealId: string }) => Promise<ScopeView | null>

describe.sequential('R1.1 independent deal day scope storage contract', () => {
  let app: FastifyInstance | undefined, guarded = false, dateSequence = 0
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>()
  const slots = new Set<string>(), deals = new Set<string>(), versionIds = new Set<string>()
  let priorAudits: { id: string; row: string }[] = []
  const db = () => { assert(app?.db); return app.db }
  const raw = async (c: Queryable, table: string, where = '', values: readonly unknown[] = []) =>
    (await c.query<{ row: string }>(`select row_to_json(t)::text row from "${table}" t ${where} order by row_to_json(t)::text`, values)).rows.map(r => r.row)

  beforeAll(async () => {
    assert(DATABASE, 'Explicit TEST_DATABASE_URL is required; no silent native skip')
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.username, 'codex_test'); assert.equal(target.port, '15432')
    assert.equal(disposablePgPort(), '15432')
    assert(['/tili_day_atomic_20261021_test', '/tili_ecosystem_full_20260930_test', '/tili_ecosystem_inventory_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'day-scope-synthetic-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const identity = (await db().query<{ database: string; oid: string; role: string; address: string; port: number
      data: string; systemid: string; pid: number; started_at: string }>(`select current_database() database,
      (select oid::text from pg_database where datname=current_database()) oid,current_user role,
      host(inet_server_addr()) address,inet_server_port() port,current_setting('data_directory') data,
      (select system_identifier::text from pg_control_system()) systemid,pg_backend_pid() pid,
      pg_postmaster_start_time()::text started_at`)).rows[0]!
    assert.equal(identity.database, target.pathname.slice(1)); assert.equal(identity.role, 'codex_test')
    assert(['127.0.0.1', '::1'].includes(identity.address)); assert.equal(identity.port, 15432)
    assert(/^\d+$/.test(identity.oid) && /^\d+$/.test(identity.systemid) && identity.pid > 0)
    assert(identity.data.length > 0 && Number.isFinite(Date.parse(identity.started_at)))
    process.stdout.write(`DEAL_DAY_SCOPE_NATIVE_IDENTITY ${JSON.stringify(identity)}\n`)
    priorAudits = (await db().query<{ id: string; row: string }>('select id::text,row_to_json(t)::text row from audit_log t order by id')).rows
    guarded = true
  })
  afterAll(async () => {
    if (!app) return
    try {
      if (!guarded) return
      const ownAudits = (await db().query<{ id: string }>('select id::text from audit_log where actor_id=any($1::uuid[]) order by id', [[...users]])).rows.map(r => r.id)
      process.stdout.write(`DEAL_DAY_SCOPE_FIXTURE_MANIFEST ${JSON.stringify({ users: [...users], weddings: [...weddings],
        vendors: [...vendors], slots: [...slots], deals: [...deals], versions: [...versionIds], retainedAuditIds: ownAudits })}\n`)
      // Only recorded synthetic UUIDs. Financial/history deletion is parent
      // cascade, never an unrestricted delete of the new immutable tables.
      for (const id of weddings) await db().query('delete from weddings where id=$1', [id])
      for (const id of vendors) await db().query('delete from vendors where id=$1', [id])
      for (const id of users) await db().query('delete from users where id=$1', [id])
      for (const [table, ids] of [['users', users], ['weddings', weddings], ['vendors', vendors], ['slots', slots], ['deals', deals]] as const) {
        expect((await db().query(`select id from ${table} where id=any($1::uuid[])`, [[...ids]])).rows).toEqual([])
      }
      const present = new Set((await catalog()).map(r => r.table_name))
      if (present.has(VERSIONS)) expect((await db().query(`select id from ${VERSIONS} where id=any($1::uuid[])`, [[...versionIds]])).rows).toEqual([])
      if (present.has(HEADS)) expect((await db().query(`select deal_id from ${HEADS} where deal_id=any($1::uuid[])`, [[...deals]])).rows).toEqual([])
      for (const table of ['sessions', 'consents', 'idempotency_keys', 'notifications']) {
        expect((await db().query(`select user_id from ${table} where user_id=any($1::uuid[])`, [[...users]])).rows).toEqual([])
      }
      const audits = new Map((await db().query<{ id: string; row: string }>('select id::text,row_to_json(t)::text row from audit_log t order by id')).rows.map(r => [r.id, r.row]))
      for (const before of priorAudits) expect(audits.get(before.id), `prior audit ${before.id}`).toBe(before.row)
      for (const id of ownAudits) expect(audits.has(id), `new own audit ${id} must be retained`).toBe(true)
      process.stdout.write('DEAL_DAY_SCOPE_CLEANUP completed=true priorAuditsUnchanged=true\n')
    } finally { await app.close() }
  })

  const catalog = () => db().query<{ table_name: string; column_name: string; type: string; not_null: boolean }>(`select c.relname table_name,
    a.attname column_name,format_type(a.atttypid,a.atttypmod) type,a.attnotnull not_null
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname='public' and c.relkind='r' and c.relname=any($1::text[]) order by c.relname,a.attnum`, [[VERSIONS, HEADS]]).then(r => r.rows)
  async function requireSchema() {
    const rows = await catalog()
    for (const [table, columns] of [[VERSIONS, versionColumns], [HEADS, headColumns]] as const) {
      const actual = rows.filter(r => r.table_name === table).map(r => r.column_name)
      expect(actual.sort(), `schema precondition: ${table}; downstream witness not reached if missing`).toEqual([...columns].sort())
    }
    return rows
  }
  async function actor() {
    const id = randomUUID(), session = randomUUID(); let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) inserted = (await db().query(
      "insert into users(id,phone,name) values($1,$2,'Synthetic R1.1 actor') on conflict(phone) do nothing returning id",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])).rowCount === 1
    assert(inserted); users.add(id)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid: session }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor, key = randomUUID()) => ({ authorization: `Bearer ${a.token}`, 'idempotency-key': key })
  async function fixture(options: { date?: string | null; timeZone?: string | null; external?: boolean } = {}) {
    await requireSchema()
    const pair = await actor(), companyOwner = await actor(), vendorId = randomUUID(), weddingId = randomUUID(), slotId = randomUUID()
    const date = options.date === undefined ? `${new Date().getUTCFullYear() + 2}-08-${String(1 + dateSequence++ % 27).padStart(2, '0')}` : options.date
    const timeZone = options.timeZone === undefined ? 'Europe/Moscow' : options.timeZone
    vendors.add(vendorId); weddings.add(weddingId); slots.add(slotId)
    await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic R1.1 studio',now())", [vendorId, companyOwner.id])
    await db().query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic R1.1 wedding',$3,$4,$5)", [weddingId, pair.id, date, timeZone, randomUUID()])
    await db().query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, pair.id])
    await db().query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Synthetic R1.1 primary')", [slotId, weddingId])
    // Storage-only legacy parent, deliberately never passed through the new
    // public tracking writer. Do not delete tracking created by a public book.
    const dealId = randomUUID(); deals.add(dealId)
    await db().query(`insert into deals(id,wedding_id,slot_id,vendor_id,external_name,state,price,currency,booked_at)
      values($1,$2,$3,$4,$5,'booked',17000,'RUB',clock_timestamp())`,
    [dealId, weddingId, slotId, options.external ? null : vendorId, options.external ? 'Synthetic independent contractor' : null])
    await db().query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
    if (!options.external && date !== null) await db().query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3)", [vendorId, date, dealId])
    const eventId = (await db().query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    expect((await db().query('select deal_id from deal_orders where wedding_id=$1 and deal_id=$2', [weddingId, dealId])).rows).toEqual([{ deal_id: dealId }])
    return { pair, companyOwner, vendorId, weddingId, slotId, dealId, eventId, date, timeZone }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function snapshot(f: Fixture, c: Queryable = db()) {
    const state: Record<string, string[]> = {}
    for (const table of [VERSIONS, HEADS, 'deals', 'slots', 'wedding_events', 'deal_orders', 'order_assignments', 'order_parts']) {
      state[table] = await raw(c, table, 'where t.wedding_id=$1', [f.weddingId])
    }
    state.wedding = await raw(c, 'weddings', 'where t.id=$1', [f.weddingId])
    state.days = await raw(c, 'vendor_busy_dates', 'where t.vendor_id=$1', [f.vendorId])
    for (const table of ['deal_events', 'payments', 'payment_installments', 'payment_corrections', 'payment_installment_edits']) {
      state[table] = await raw(c, table, 'where t.deal_id=$1', [f.dealId])
    }
    state.audit = await raw(c, 'audit_log', 'where t.actor_id=any($1::uuid[])', [[f.pair.id, f.companyOwner.id]])
    state.receipts = await raw(c, 'idempotency_keys', 'where t.user_id=any($1::uuid[])', [[f.pair.id, f.companyOwner.id]])
    return state
  }
  async function currentVersion(f: Fixture, changes: Partial<Version> = {}): Promise<Version> {
    const live = (await db().query<{ date: string | null; time_zone: string | null; day: string | null }>(`select e.date::text,e.time_zone,
      (select b.id from vendor_busy_dates b where b.vendor_id=$2 and b.date=e.date and b.source='deal') as "day"
      from wedding_events e where e.id=$1 and e.wedding_id=$3`, [f.eventId, f.vendorId, f.weddingId])).rows[0]!
    return { id: randomUUID(), wedding_id: f.weddingId, deal_id: f.dealId, slot_id: f.slotId, schema_version: 1,
      revision: '1', previous_version_id: null, origin_knowledge: 'observed_tracking', operation: 'observe',
      recorded_at: '1970-01-01T00:00:00Z', context_kind: 'implicit_main', event_id: f.eventId,
      performer_kind: 'catalog', vendor_id: f.vendorId, binding_state: live.date ? 'active' : 'undated',
      service_date: live.date, time_zone: live.time_zone, day_id: live.day, ...changes }
  }
  async function insert(c: Queryable, value: Version) {
    versionIds.add(value.id)
    await c.query(`insert into ${VERSIONS}(${versionColumns.join(',')}) values(${versionColumns.map((_, i) => `$${i + 1}`).join(',')})`, versionColumns.map(k => value[k]))
  }
  const head = (c: Queryable, value: Version) => c.query(`insert into ${HEADS}(deal_id,wedding_id,revision,current_version_id) values($1,$2,$3,$4)`,
    [value.deal_id, value.wedding_id, value.revision, value.id])
  const advance = (c: Queryable, value: Version) => c.query(`update ${HEADS} set revision=$2,current_version_id=$3 where deal_id=$1`, [value.deal_id, value.revision, value.id])
  async function track(f: Fixture, changes: Partial<Version> = {}) {
    const value = await currentVersion(f, changes)
    await db().tx(async c => { await insert(c, value); await head(c, value) })
    return value
  }
  const next = (v: Version, patch: Partial<Version> = {}): Version => ({ ...v, id: randomUUID(), revision: String(BigInt(v.revision) + 1n),
    previous_version_id: v.id, origin_knowledge: null, operation: 'move', ...patch })
  const versionRaw = (v: Version) => raw(db(), VERSIONS, 'where t.id=$1', [v.id])
  async function rejected(f: Fixture, constraint: string, run: (c: Queryable) => Promise<unknown>, atCommit = false) {
    const before = await snapshot(f); let callbackReturned = false
    await expect(db().tx(async c => { await run(c); await c.query('select 1'); callbackReturned = true }))
      .rejects.toMatchObject({ code: '23514', constraint })
    if (atCommit) expect(callbackReturned, 'targeted statements and select 1 must return before outer COMMIT refusal').toBe(true)
    expect(await snapshot(f), 'full own native rows after actual rollback').toEqual(before)
  }
  async function reader(): Promise<Reader> {
    await requireSchema()
    // Variable import is deliberately after catalogue precondition. Initial
    // RED never statically resolves a not-yet-implemented source module.
    const modulePath = '../src/deals/day-scope.js'
    const module = await import(/* @vite-ignore */ modulePath) as { loadDealDayScope: Reader }
    expect(typeof module.loadDealDayScope).toBe('function')
    return module.loadDealDayScope
  }
  const view = async (f: Fixture) => (await reader())(db(), { weddingId: f.weddingId, dealId: f.dealId })
  const reschedule = async (f: Fixture, date: string) => {
    const response = await app!.inject({ method: 'POST', url: `/weddings/${f.weddingId}/reschedule`, headers: auth(f.pair), payload: { date } })
    expect(response.statusCode, response.body).toBe(200)
  }

  it('F0 catalogue: required scope tables and columns exist', async () => {
    // Meaningful initial RED: relation/column names returned by pg_catalog,
    // no fixtures, relation query, migration import or reader import.
    await requireSchema()
  })
  it('native types/nullability and deferred parent/chain FK actions match the agreed schema', async () => {
    const rows = await requireSchema(), columns = new Map(rows.filter(r => r.table_name === VERSIONS).map(r => [r.column_name, r]))
    for (const column of ['id', 'wedding_id', 'deal_id', 'slot_id', 'schema_version', 'revision', 'operation', 'recorded_at', 'context_kind', 'performer_kind', 'binding_state']) expect(columns.get(column)?.not_null).toBe(true)
    for (const column of ['event_id', 'vendor_id', 'service_date', 'time_zone', 'day_id', 'previous_version_id', 'origin_knowledge']) expect(columns.get(column)?.not_null).toBe(false)
    expect(columns.get('service_date')?.type).toBe('date'); expect(columns.get('revision')?.type).toBe('bigint')
    expect(columns.get('recorded_at')?.type).toBe('timestamp with time zone')
    const fk = (await db().query<{ table_name: string; columns: string[]; target: string; target_columns: string[]; action: string; deferred: boolean; initially_deferred: boolean }>(`select c.conrelid::regclass::text table_name,
      array(select a.attname::text from unnest(c.conkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=x.n order by x.o) columns,
      c.confrelid::regclass::text target,
      array(select a.attname::text from unnest(c.confkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=x.n order by x.o) target_columns,
      c.confdeltype action,c.condeferrable deferred,c.condeferred initially_deferred from pg_constraint c
      where c.contype='f' and c.conrelid in(to_regclass($1),to_regclass($2))`, [VERSIONS, HEADS])).rows
    expect(fk).toHaveLength(4)
    for (const table of [VERSIONS, HEADS]) expect(fk).toContainEqual(expect.objectContaining({ table_name: table,
      columns: ['wedding_id', 'deal_id'], target: 'deal_orders', target_columns: ['wedding_id', 'deal_id'], action: 'c' }))
    for (const [table, column] of [[VERSIONS, 'previous_version_id'], [HEADS, 'current_version_id']]) expect(fk).toContainEqual(expect.objectContaining({
      table_name: table, columns: ['wedding_id', 'deal_id', column], target: VERSIONS, target_columns: ['wedding_id', 'deal_id', 'id'], action: 'a', deferred: true, initially_deferred: true }))
  })
  it('synthetic untracked legacy main parent creates no invented historical origin automatically', async () => {
    const f = await fixture()
    expect((await db().query(`select id from ${VERSIONS} where deal_id=$1`, [f.dealId])).rows).toEqual([])
    expect((await db().query(`select deal_id from ${HEADS} where deal_id=$1`, [f.dealId])).rows).toEqual([])
    expect(await view(f)).toBeNull()
  })
  it('valid append advances exact head and keeps first observation immutable', async () => {
    const f = await fixture(), v1 = await track(f), first = await versionRaw(v1), v2 = next(v1)
    await db().tx(async c => { await insert(c, v2); await advance(c, v2) })
    expect(await versionRaw(v1)).toEqual(first)
    expect(await view(f)).toEqual({ revision: '2', versionId: v2.id,
      origin: { knowledge: 'observed_tracking', eventId: f.eventId, date: f.date, timeZone: f.timeZone },
      current: { bindingState: 'active', performerKind: 'catalog', contextKind: 'implicit_main', slotId: f.slotId,
        eventId: f.eventId, vendorId: f.vendorId, date: f.date, timeZone: f.timeZone, dayId: v1.day_id }, freshness: 'current' })
  })
  it('recorded_at is database-owned even when the inserted timestamp claims 1970', async () => {
    const f = await fixture(), before = (await db().query<{ at: Date }>('select clock_timestamp() at')).rows[0]!.at
    const v = await track(f), saved = (await db().query<{ recorded_at: Date }>(`select recorded_at from ${VERSIONS} where id=$1`, [v.id])).rows[0]!.recorded_at
    const after = (await db().query<{ at: Date }>('select clock_timestamp() at')).rows[0]!.at
    expect(saved.getTime()).toBeGreaterThanOrEqual(before.getTime()); expect(saved.getTime()).toBeLessThanOrEqual(after.getTime())
  })
  it('legacy_unknown origin stays unknown while current observation is known', async () => {
    const f = await fixture(), v1 = await track(f, { origin_knowledge: 'legacy_unknown' }), v2 = next(v1)
    await db().tx(async c => { await insert(c, v2); await advance(c, v2) })
    expect(await view(f)).toMatchObject({ revision: '2', origin: { knowledge: 'legacy_unknown', eventId: null, date: null, timeZone: null },
      current: { date: f.date, eventId: f.eventId, timeZone: f.timeZone }, freshness: 'current' })
  })
  it('undated implicit main preserves literal NULL date/time zone and no day', async () => {
    const f = await fixture({ date: null, timeZone: null }); await track(f)
    expect(await view(f)).toMatchObject({ current: { bindingState: 'undated', contextKind: 'implicit_main', date: null, timeZone: null, dayId: null }, freshness: 'current' })
  })
  it('dated main with unknown time zone preserves NULL instead of Moscow fallback', async () => {
    const f = await fixture({ timeZone: null }); await track(f)
    expect(await view(f)).toMatchObject({ current: { bindingState: 'active', date: f.date, timeZone: null }, freshness: 'current' })
  })
  it('synthetic external legacy parent is external, never a vendor DATE membership', async () => {
    const f = await fixture({ external: true, date: null, timeZone: null })
    await track(f, { performer_kind: 'external', vendor_id: null, binding_state: 'external', day_id: null })
    expect(await view(f)).toMatchObject({ current: { bindingState: 'external', performerKind: 'external', vendorId: null, dayId: null, date: null, timeZone: null }, freshness: 'current' })
    expect((await db().query('select id from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([])
  })
  it('explicit unknown snapshot does not acquire main/Moscow/date membership by fallback', async () => {
    const f = await fixture()
    await track(f, { context_kind: 'unknown', event_id: null, performer_kind: 'unknown', vendor_id: null,
      binding_state: 'unknown', service_date: null, time_zone: null, day_id: null, origin_knowledge: 'legacy_unknown' })
    expect(await view(f)).toMatchObject({ origin: { knowledge: 'legacy_unknown', eventId: null, date: null, timeZone: null },
      current: { bindingState: 'unknown', contextKind: 'unknown', performerKind: 'unknown', eventId: null, vendorId: null, date: null, timeZone: null, dayId: null } })
  })
  it('two same-category own main roots may share the same vendor DATE without coalescing their histories', async () => {
    const f = await fixture(), first = await track(f)
    const additional = await app!.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/additional`, headers: auth(f.pair),
      payload: { categoryId: 'photo', programEventId: f.eventId, label: 'Synthetic second main position' } })
    expect(additional.statusCode, additional.body).toBe(201)
    const slotId = additional.json<{ id: string }>().id; slots.add(slotId)
    const booked = await app!.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${slotId}/book`, headers: auth(f.pair),
      payload: { vendorId: f.vendorId, price: { amount: 19000, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200)
    const dealId = (await db().query<{ deal_id: string }>('select deal_id from slots where id=$1', [slotId])).rows[0]!.deal_id
    deals.add(dealId)
    // The real public book now created its own tracked initial acquire. Read
    // that chain; inserting a synthetic revision1 here would be a duplicate.
    const recorded = (await db().query<Pick<Version, 'id' | 'day_id' | 'revision' | 'origin_knowledge' | 'operation' | 'context_kind'>>(
      `select id,day_id,revision::text,origin_knowledge,operation,context_kind from ${VERSIONS}
       where wedding_id=$1 and deal_id=$2 order by revision`, [f.weddingId, dealId])).rows
    expect(recorded).toHaveLength(1); const second = recorded[0]!
    expect(second).toMatchObject({ revision: '1', origin_knowledge: 'observed_tracking', operation: 'acquire', context_kind: 'explicit_main' })
    expect(second.id).not.toBe(first.id); expect(second.day_id).toBe(first.day_id)
    expect((await db().query(`select deal_id from ${HEADS} where wedding_id=$1 order by deal_id`, [f.weddingId])).rows)
      .toEqual([f.dealId, dealId].sort().map(id => ({ deal_id: id })))
    expect((await db().query('select id from vendor_busy_dates where vendor_id=$1 and date=$2', [f.vendorId, f.date])).rows).toHaveLength(1)
  })
  const malformed: { label: string; patch: Partial<Version> }[] = [
    { label: 'revision0', patch: { revision: '0' } },
    { label: 'revision1 with previous id', patch: { previous_version_id: randomUUID() } },
    { label: 'revision1 without provenance', patch: { origin_knowledge: null } },
    { label: 'unknown context enum', patch: { context_kind: 'invented' } },
    { label: 'active without day', patch: { day_id: null } },
    { label: 'catalog without vendor', patch: { vendor_id: null } },
    { label: 'external with catalog vendor', patch: { performer_kind: 'external', binding_state: 'external', day_id: null } },
    { label: 'undated with nonnull date', patch: { binding_state: 'undated', day_id: null } },
    { label: 'revision1 with move operation', patch: { operation: 'move' } },
  ]
  it.each(malformed)('shape rejects $label and rolls back native rows', async ({ patch }) => {
    const f = await fixture(), value = await currentVersion(f, patch)
    await rejected(f, 'deal_day_scope_shape', c => insert(c, value))
  })
  it.each(['', 'Mars/Olympus'])('assigned invalid time zone %j is rejected, not treated as NULL', async timeZone => {
    const f = await fixture(), value = await currentVersion(f, { time_zone: timeZone })
    await rejected(f, 'deal_day_scope_time_zone', c => insert(c, value))
  })
  it('later revision cannot replace the immutable origin provenance', async () => {
    const f = await fixture(), first = await track(f), later = next(first, { origin_knowledge: 'observed_tracking' })
    await rejected(f, 'deal_day_scope_shape', c => insert(c, later))
  })
  it.each(['recorded_at=recorded_at', "origin_knowledge='legacy_unknown'"])('version UPDATE is forbidden even for %s', async assignment => {
    const f = await fixture(), first = await track(f)
    await rejected(f, 'deal_day_scope_versions_immutable', c => c.query(`update ${VERSIONS} set ${assignment} where id=$1`, [first.id]))
  })
  it.each([VERSIONS, HEADS, 'deal_orders'])('manual DELETE %s with live deals parent cannot erase tracking', async table => {
    const f = await fixture(); await track(f)
    await rejected(f, 'deal_day_scope_versions_immutable', c => c.query(`delete from ${table} where deal_id=$1`, [f.dealId]))
  })
  it.each(['revision=revision', 'revision=revision+2', "revision=1,current_version_id=gen_random_uuid()"])(
    'head rejects no-op/skip/repoint %s', async assignment => {
      const f = await fixture(); await track(f)
      await rejected(f, 'deal_day_scope_heads_step', c => c.query(`update ${HEADS} set ${assignment} where deal_id=$1`, [f.dealId]))
    })
  it('the first head cannot start at revision2 while its valid first version is revision1', async () => {
    const f = await fixture(), value = await currentVersion(f)
    await rejected(f, 'deal_day_scope_heads_step', async c => { await insert(c, value); await head(c, { ...value, revision: '2' }) })
  })
  it('new snapshot cannot claim another real wedding event/slot', async () => {
    const own = await fixture(), foreign = await fixture(), foreignBefore = await snapshot(foreign)
    const wrong = await currentVersion(own, { slot_id: foreign.slotId, event_id: foreign.eventId })
    await rejected(own, 'deal_day_scope_current', async c => { await insert(c, wrong); await head(c, wrong) })
    expect(await snapshot(foreign)).toEqual(foreignBefore)
  })
  it('real outer COMMIT rejects first version without its head after callback completed', async () => {
    const f = await fixture(), value = await currentVersion(f)
    await rejected(f, 'deal_day_scope_chain', c => insert(c, value), true)
  })
  it('real outer COMMIT rejects orphan append without head advance after callback completed', async () => {
    const f = await fixture(), first = await track(f), later = next(first)
    await rejected(f, 'deal_day_scope_chain', c => insert(c, later), true)
  })
  it('real outer COMMIT rechecks final context after valid new version/head then own date change', async () => {
    const f = await fixture(), value = await currentVersion(f)
    await rejected(f, 'deal_day_scope_current', async c => {
      await insert(c, value); await head(c, value)
      await c.query("update weddings set date=date+1 where id=$1", [f.weddingId])
    }, true)
  })
  it('real outer COMMIT rechecks recorded unknown partial facts after a later own context edit', async () => {
    const f = await fixture(), partial = await currentVersion(f, { binding_state: 'unknown', day_id: null })
    await rejected(f, 'deal_day_scope_current', async c => {
      await insert(c, partial); await head(c, partial)
      await c.query("update weddings set tz='Asia/Yekaterinburg' where id=$1", [f.weddingId])
    }, true)
  })
  it('real outer COMMIT rejects disappearance of newly retained done busy tuple', async () => {
    const f = await fixture(), first = await track(f)
    const retained = next(first, { operation: 'retain_done', binding_state: 'done_retained' })
    await rejected(f, 'deal_day_scope_current', async c => {
      // Storage-only state + append in the same real TX: a public done now
      // appends retain_done itself and cannot be followed by that append again.
      await c.query('select legacy_day_lock_vendors($1::uuid[])', [[f.vendorId]])
      await c.query("update deals set state='done' where id=$1", [f.dealId])
      await insert(c, retained); await advance(c, retained)
      expect((await c.query('delete from vendor_busy_dates where id=$1 returning id', [retained.day_id])).rows).toEqual([{ id: retained.day_id }])
    }, true)
  })
  it('a branch/skip predecessor cannot replace the exact current head ancestry', async () => {
    const f = await fixture(), first = await track(f), v2 = next(first)
    await db().tx(async c => { await insert(c, v2); await advance(c, v2) })
    const branch = next(v2, { previous_version_id: first.id })
    await rejected(f, 'deal_day_scope_chain', c => insert(c, branch))
  })
  it('foreign-chain predecessor is rejected by the exact chain guard without changing either root', async () => {
    const f = await fixture(), other = await fixture(), first = await track(f), foreign = await track(other)
    const foreignBefore = await snapshot(other), wrong = next(first, { previous_version_id: foreign.id })
    await rejected(f, 'deal_day_scope_chain', c => insert(c, wrong))
    expect(await snapshot(other)).toEqual(foreignBefore)
  })
  it.each(['deal', 'wedding'])('legitimate %s parent erasure cascades only its own chain', async parent => {
    const f = await fixture(), other = await fixture(); await track(f); await track(other)
    const foreignBefore = await snapshot(other)
    await db().tx(async c => {
      if (parent === 'deal') {
        // The existing slots FK requires releasing that operational pointer;
        // this is a schema-only erasure witness, not a new business command.
        await c.query('update slots set deal_id=null where id=$1', [f.slotId])
        await c.query('delete from deals where id=$1', [f.dealId])
      } else await c.query('delete from weddings where id=$1', [f.weddingId])
    })
    expect((await db().query(`select id from ${VERSIONS} where deal_id=$1`, [f.dealId])).rows).toEqual([])
    expect((await db().query(`select deal_id from ${HEADS} where deal_id=$1`, [f.dealId])).rows).toEqual([])
    expect(await snapshot(other)).toEqual(foreignBefore)
  })
  it('synthetic intermediate main move is stale; managed outer COMMIT refuses and history rolls back exactly', async () => {
    const f = await fixture(), first = await track(f), origin = await versionRaw(first)
    const newDate = `${new Date().getUTCFullYear() + 3}-09-18`
    const before = await snapshot(f), inspect = await reader(); let returned = false
    await expect(db().tx(async c => {
      await c.query('update weddings set date=$2 where id=$1', [f.weddingId, newDate])
      await c.query('delete from vendor_busy_dates where id=$1', [first.day_id])
      expect((await c.query('select id from vendor_busy_dates where id=$1', [first.day_id])).rows).toEqual([])
      expect(await raw(c, VERSIONS, 'where t.id=$1', [first.id])).toEqual(origin)
      expect(await inspect(c, { weddingId: f.weddingId, dealId: f.dealId })).toMatchObject({ revision: '1', freshness: 'stale', current: { date: f.date, dayId: first.day_id } })
      returned = true
    })).rejects.toMatchObject({ code: '23514' })
    expect(returned).toBe(true); expect(await snapshot(f)).toEqual(before)
  })
  it('done_retained keeps the previously tracked tuple when the main event later moves', async () => {
    const f = await fixture(), first = await track(f), before = await versionRaw(first)
    const retained = next(first, { operation: 'retain_done', binding_state: 'done_retained' })
    await db().tx(async c => { await c.query("update deals set state='done' where id=$1", [f.dealId]); await insert(c, retained); await advance(c, retained) })
    await reschedule(f, `${new Date().getUTCFullYear() + 3}-10-19`)
    expect(await versionRaw(first)).toEqual(before)
    expect(await view(f)).toMatchObject({ revision: '2', freshness: 'current', current: {
      bindingState: 'done_retained', date: f.date, eventId: first.event_id, timeZone: first.time_zone, dayId: first.day_id } })
  })
  it('cancel keeps immutable history and an explicit release has no current membership', async () => {
    const f = await fixture(), first = await track(f), before = await versionRaw(first)
    const released = next(first, { operation: 'release', binding_state: 'released', day_id: null })
    await db().tx(async c => {
      await c.query("update deals set state='cancelled' where id=$1", [f.dealId]); await c.query('update slots set deal_id=null where id=$1', [f.slotId])
      await c.query('delete from vendor_busy_dates where deal_id=$1', [f.dealId]); await insert(c, released); await advance(c, released)
    })
    expect(await versionRaw(first)).toEqual(before)
    expect(await view(f)).toMatchObject({ freshness: 'current', current: { bindingState: 'released', dayId: null, date: f.date } })
  })
  it.each(['done_retained', 'released'])('acquire cannot bypass terminal predecessor %s', async terminal => {
    const f = await fixture(), first = await track(f)
    const final = next(first, { operation: terminal === 'done_retained' ? 'retain_done' : 'release', binding_state: terminal,
      day_id: terminal === 'released' ? null : first.day_id })
    await db().tx(async c => {
      await c.query('update deals set state=$2 where id=$1', [f.dealId, terminal === 'done_retained' ? 'done' : 'cancelled'])
      if (terminal === 'released') { await c.query('update slots set deal_id=null where id=$1', [f.slotId]); await c.query('delete from vendor_busy_dates where deal_id=$1', [f.dealId]) }
      await insert(c, final); await advance(c, final)
    })
    await rejected(f, 'deal_day_scope_shape', async c => {
      // Adversarial schema-only, rollback-only base fixture. Make current
      // active facts otherwise valid, so the targeted refusal is terminal
      // predecessor, not a second unrelated current-state violation. There
      // is deliberately NO HTTP reopen/financial-authority claim here.
      await c.query("update deals set state='booked' where id=$1", [f.dealId])
      await c.query('update slots set deal_id=$2 where id=$1', [f.slotId, f.dealId])
      let dayId = first.day_id
      if (terminal === 'released') dayId = (await c.query<{ id: string }>(
        "insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3) returning id",
        [f.vendorId, f.date, f.dealId])).rows[0]!.id
      const reopened = next(final, { operation: 'acquire', binding_state: 'active', day_id: dayId })
      await insert(c, reopened)
    })
  })
  it.each(['vendor', 'owner user'])('scoped native %s erasure retains literal history, never inventing an external origin', async erased => {
    const f = await fixture(), other = await fixture(), first = await track(f), saved = await versionRaw(first), foreign = await snapshot(other)
    await db().tx(async c => {
      // These are the exact scoped retained-deal redaction and parent-delete
      // semantics used by the existing job. Do NOT invoke its unrelated global
      // expired-cache prune from a parallel schema suite. This witness is not
      // public erasure/job acceptance and carries no new deletion permission.
      await c.query("update deals set vendor_id=null,external_name='Удалённый подрядчик' where id=$1 and vendor_id=$2", [f.dealId, f.vendorId])
      if (erased === 'vendor') await c.query('delete from vendors where id=$1', [f.vendorId])
      else await c.query('delete from users where id=$1', [f.companyOwner.id])
    })
    expect((await db().query('select id from vendors where id=$1', [f.vendorId])).rows).toEqual([])
    expect(await versionRaw(first)).toEqual(saved)
    expect(await view(f)).toMatchObject({ freshness: 'stale', current: { performerKind: 'catalog', vendorId: f.vendorId, dayId: first.day_id } })
    expect(await snapshot(other)).toEqual(foreign)
  })
  it('readonly inspection is exact-scope and leaves all public tables byte-exact in a READ ONLY transaction', async () => {
    const f = await fixture(), other = await fixture(), tracked = await track(f), load = await reader()
    await db().tx(async c => {
      await c.query('set transaction isolation level repeatable read read only')
      expect((await c.query<{ read_only: string }>("select current_setting('transaction_read_only') read_only")).rows[0]!.read_only).toBe('on')
      const tables = (await c.query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(r => r.name)
      const journal = (await c.query<{ name: string }>('select name from pgmigrations order by name')).rows.map(r => r.name)
      expect([93, 94]).toContain(journal.length)
      expect(journal.at(-1)).toBe(journal.length === 94
        ? '1763920000000_legacy_calendar_bounds' : '1763910000000_additional_event_undated')
      const boundsTables = ['legacy_calendar_bounds_versions', 'legacy_calendar_bounds_holders', 'legacy_calendar_bounds_spans',
        'legacy_calendar_bounds_person_scope', 'legacy_calendar_bounds_receipts', 'legacy_calendar_bounds_heads',
        'legacy_calendar_resolution_events', 'legacy_calendar_resolution_holders', 'legacy_calendar_person_links',
        'resource_occupancy_origin_certificates', 'resource_occupancy', 'legacy_calendar_initial_commit_witnesses']
      expect(tables.filter(t => boundsTables.includes(t))).toEqual(journal.length === 94 ? [...boundsTables].sort() : [])
      expect(tables).toHaveLength(journal.length === 94 ? 124 : 112); expect(tables).toContain('legacy_day_groups')
      expect(tables).toEqual(expect.arrayContaining(['event_move_proposals', 'event_move_roots', 'event_move_receipts', 'event_move_effects']))
      const before: Record<string, string[]> = {}
      for (const table of tables) before[table] = await raw(c, table)
      expect(await load(c, { weddingId: f.weddingId, dealId: f.dealId })).toMatchObject({ versionId: tracked.id, freshness: 'current' })
      expect(await load(c, { weddingId: other.weddingId, dealId: f.dealId })).toBeNull()
      expect(await load(c, { weddingId: f.weddingId, dealId: other.dealId })).toBeNull()
      expect(await load(c, { weddingId: other.weddingId, dealId: other.dealId })).toBeNull()
      expect(await load(c, { weddingId: f.weddingId, dealId: randomUUID() })).toBeNull()
      const after: Record<string, string[]> = {}
      for (const table of tables) after[table] = await raw(c, table)
      expect(after).toEqual(before)
    })
  }, 30_000)
  it('F1 external unknown context rejects a real foreign event', async () => {
    const own = await fixture({ external: true }), foreign = await fixture()
    expect(own.weddingId).not.toBe(foreign.weddingId)
    expect(own.eventId).not.toBe(foreign.eventId)
    // Positive control: unknown context can retain a truthful non-null own
    // event fact; it remains external and never acquires a vendor DATE.
    const valid = await track(own, { context_kind: 'unknown', event_id: own.eventId,
      performer_kind: 'external', vendor_id: null, binding_state: 'external', day_id: null })
    expect(await view(own)).toMatchObject({ revision: '1', versionId: valid.id, freshness: 'current', current: {
      contextKind: 'unknown', eventId: own.eventId, bindingState: 'external', performerKind: 'external',
      vendorId: null, date: own.date, timeZone: own.timeZone, dayId: null } })
    const before = await snapshot(own), foreignBefore = await snapshot(foreign)
    const wrong = next(valid, { event_id: foreign.eventId })
    let refusal: unknown = null, callbackCompleted = false
    try {
      await db().tx(async c => {
        await insert(c, wrong); await advance(c, wrong)
        await c.query('select 1'); callbackCompleted = true
      })
    } catch (error) { refusal = error }
    const after = await snapshot(own), foreignAfter = await snapshot(foreign)
    const error = refusal as { code?: string; constraint?: string } | null
    // Persist the actual acceptance/refusal and full native snapshots before
    // the expected-error assertion, including on the initial meaningful RED.
    process.stdout.write(`DEAL_DAY_SCOPE_EXTERNAL_UNKNOWN_FOREIGN_EVENT ${JSON.stringify({
      ownWeddingId: own.weddingId, ownEventId: own.eventId, foreignWeddingId: foreign.weddingId,
      foreignEventId: foreign.eventId, attemptedVersion: wrong, callbackCompleted,
      error: error ? { code: error.code ?? null, constraint: error.constraint ?? null } : null,
      before, after, foreignBefore, foreignAfter })}\n`)
    expect(refusal, 'a real foreign known event must fail the native current guard').toMatchObject({
      code: '23514', constraint: 'deal_day_scope_current' })
    expect(after, 'full own rows after actual rollback').toEqual(before)
    expect(foreignAfter, 'foreign synthetic legacy parent and history remain exact').toEqual(foreignBefore)
  })
})
