import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import type { Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

// Independent tests frozen BEFORE the forward implementation. Contract CBD28DB5.
// FNULL02/03 expect SUCCESS: applied87 must actually FAIL at the new INSERT shape.
// Other tests are selected only after the forward migration, never silent skips.
const DATABASE = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'independent-undated-terminal-native-'.repeat(3)
const V = 'deal_day_scope_versions', H = 'deal_day_scope_heads'
const columns = ['id', 'wedding_id', 'deal_id', 'slot_id', 'schema_version', 'revision', 'previous_version_id',
  'origin_knowledge', 'operation', 'recorded_at', 'context_kind', 'event_id', 'performer_kind', 'vendor_id',
  'binding_state', 'service_date', 'time_zone', 'day_id'] as const
type Version = { id: string; wedding_id: string; deal_id: string; slot_id: string; schema_version: number; revision: string
  previous_version_id: string | null; origin_knowledge: string | null; operation: string; recorded_at: string
  context_kind: string; event_id: string | null; performer_kind: string; vendor_id: string | null
  binding_state: string; service_date: string | null; time_zone: string | null; day_id: string | null }
type View = { revision: string; versionId: string; freshness: string
  origin: { knowledge: string; eventId: string | null; date: string | null; timeZone: string | null }
  current: { bindingState: string; performerKind: string; contextKind: string; slotId: string; eventId: string | null
    vendorId: string | null; date: string | null; timeZone: string | null; dayId: string | null } }
type Snapshot = Record<string, string[]>
type Phase = 'SETUP' | 'INSERT_VERSION' | 'ADVANCE_HEAD' | 'UPDATE_HEAD' | 'UPDATE_VERSION' | 'OUTER_COMMIT' | 'COMMITTED'
const facts = (v: Version) => [v.slot_id, v.context_kind, v.event_id, v.performer_kind, v.vendor_id, v.service_date, v.time_zone, v.day_id]
const errorInfo = (e: unknown) => {
  if (!e) return null
  const x = e as { name?: string; message?: string; code?: string; constraint?: string; detail?: string }
  return { name: x.name ?? null, message: x.message ?? null, code: x.code ?? null, constraint: x.constraint ?? null, detail: x.detail ?? null }
}
const witness = (label: string, value: unknown) => process.stdout.write(`UNDATED_TERMINAL_${label} ${JSON.stringify(value)}\n`)

describe.sequential('R1.2 independent NULL done storage contract', () => {
  let app: FastifyInstance | undefined, guarded = false, dateSequence = 1
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>(), slots = new Set<string>()
  const deals = new Set<string>(), versions = new Set<string>(), observedAudits = new Map<string, string>()
  // Storage fixtures stage financial facts in the SAME native TX as the
  // manually authored version; public-command controls opt in explicitly.
  const syntheticTransitions = new Map<string, 'done' | 'cancelled'>()
  let hasCalendarBounds = false
  const db = () => { assert(app?.db); return app.db }
  const raw = async (c: Queryable, table: string, where = '', values: readonly unknown[] = []) =>
    (await c.query<{ row: string }>(`select row_to_json(t)::text row from "${table}" t ${where} order by row_to_json(t)::text`, values)).rows.map(r => r.row)
  function rememberAudits(rows: string[]) {
    for (const row of rows) { const id = (JSON.parse(row) as { id: string }).id
      if (observedAudits.has(id)) expect(row, `observed audit ${id} changed`).toBe(observedAudits.get(id))
      observedAudits.set(id, row)
    }
  }
  beforeAll(async () => {
    assert(DATABASE, 'Explicit native TEST_DATABASE_URL required; no skip/fallback')
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const url = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    assert.equal(url.username, 'codex_test'); assert.equal(url.port, '15432'); assert.equal(disposablePgPort(), '15432')
    assert(['/tili_day_atomic_20261021_test', '/tili_day_undated_terminal_20261019_test', '/tili_ecosystem_full_20260930_test'].includes(url.pathname))
    assert.equal(url.search, ''); assert.equal(url.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'synthetic-undated-refresh-'.repeat(4), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const identity = (await db().query<{ name: string; oid: string; username: string; owner: string; address: string; port: number
      data: string; systemid: string; pid: number; startedAt: string }>(`select current_database() name,
      (select oid::text from pg_database where datname=current_database()) oid,current_user username,
      (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) owner,
      host(inet_server_addr()) address,inet_server_port() port,current_setting('data_directory') data,
      (select system_identifier::text from pg_control_system()) systemid,pg_backend_pid() pid,pg_postmaster_start_time()::text "startedAt"`)).rows[0]!
    assert.equal(identity.name, url.pathname.slice(1)); assert.equal(identity.username, 'codex_test'); assert.equal(identity.owner, 'codex_test')
    assert(['127.0.0.1', '::1'].includes(identity.address)); assert.equal(identity.port, 15432)
    assert(/^\d+$/.test(identity.oid) && /^\d+$/.test(identity.systemid) && identity.pid > 0 && identity.data.length > 0)
    const journal = (await db().query<{ name: string }>('select name from pgmigrations order by name')).rows.map(r => r.name)
    assert([87, 88, 89, 90, 91, 92, 93, 94].includes(journal.length), 'Root admits exact87 RED or reviewed88/89/90/91/92/93/94; RED must not require88')
    assert(journal.includes('1763850000000_deal_day_scope_foundation'))
    hasCalendarBounds = journal.includes('1763920000000_legacy_calendar_bounds')
    const catalogue = (await db().query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(r => r.name)
    assert(catalogue.includes(V) && catalogue.includes(H), 'Existing87 foundation required before fixtures')
    witness('IDENTITY', { identity, journal, catalogue, sourceContract: 'CBD28DB5399F3D1792EEA330DC1161AB69C3390DF0E92C149291F19A2F85F326' })
    rememberAudits(await raw(db(), 'audit_log')); guarded = true
  })
  afterAll(async () => {
    if (!app) return
    try {
      if (!guarded) return
      // Preserve ALL observed audit rows, including actor=NULL, before own parent cleanup.
      rememberAudits(await raw(db(), 'audit_log'))
      witness('FIXTURES', { users: [...users], weddings: [...weddings], vendors: [...vendors], slots: [...slots], deals: [...deals], versions: [...versions] })
      for (const id of weddings) await db().query('delete from weddings where id=$1', [id])
      for (const id of vendors) await db().query('delete from vendors where id=$1', [id])
      for (const id of users) await db().query('delete from users where id=$1', [id])
      for (const [table, ids] of [['users', users], ['weddings', weddings], ['vendors', vendors], ['slots', slots], ['deals', deals]] as const)
        expect((await db().query(`select id from ${table} where id=any($1::uuid[])`, [[...ids]])).rows).toEqual([])
      expect((await db().query(`select id from ${V} where id=any($1::uuid[])`, [[...versions]])).rows).toEqual([])
      expect((await db().query(`select deal_id from ${H} where deal_id=any($1::uuid[])`, [[...deals]])).rows).toEqual([])
      const after = await raw(db(), 'audit_log'), byId = new Map(after.map(row => [(JSON.parse(row) as { id: string }).id, row]))
      witness('AUDIT_CLEANUP', { observed: [...observedAudits].map(([id, row]) => ({ id, row })), after })
      for (const [id, row] of observedAudits) expect(byId.get(id), `audit ${id} retained literally`).toBe(row)
      witness('CLEANUP', { ownRowsAbsent: true, allObservedAuditsRetained: true })
    } finally { await app.close() }
  })
  async function actor() {
    const id = randomUUID(), session = randomUUID(); let inserted = false
    for (let i = 0; i < 8 && !inserted; i++) inserted = (await db().query(
      "insert into users(id,phone,name) values($1,$2,'Synthetic independent undated actor') on conflict(phone) do nothing returning id",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])).rowCount === 1
    assert(inserted); users.add(id)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid: session }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor, key = randomUUID()) => ({ authorization: `Bearer ${a.token}`, 'idempotency-key': key })
  async function fixture(o: { date?: string | null; tz?: string | null; explicit?: boolean; external?: boolean } = {}) {
    const pair = await actor(), company = await actor(), weddingId = randomUUID(), vendorId = randomUUID(), slotId = randomUUID()
    const date = o.date ?? null, tz = o.tz ?? null
    weddings.add(weddingId); vendors.add(vendorId); slots.add(slotId)
    await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic undated studio',now())", [vendorId, company.id])
    await db().query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic undated wedding',$3,$4,$5)", [weddingId, pair.id, date, tz, randomUUID()])
    await db().query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, pair.id])
    const eventId = (await db().query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    await db().query("insert into slots(id,wedding_id,category_id,label,program_event_id) values($1,$2,'photo','Synthetic own position',$3)", [slotId, weddingId, o.explicit ? eventId : null])
    // Synthetic untracked legacy parent for the storage contract. Public
    // financial transitions below remain public; no public history is erased.
    const dealId = randomUUID(); deals.add(dealId)
    await db().query(`insert into deals(id,wedding_id,slot_id,vendor_id,external_name,state,price,currency,booked_at)
      values($1,$2,$3,$4,$5,'booked',17000,'RUB',clock_timestamp())`,
    [dealId, weddingId, slotId, o.external ? null : vendorId, o.external ? 'Synthetic external' : null])
    await db().query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
    if (!o.external && date !== null) await db().query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3)", [vendorId, date, dealId])
    expect((await db().query('select deal_id from deal_orders where wedding_id=$1 and deal_id=$2', [weddingId, dealId])).rows).toEqual([{ deal_id: dealId }])
    return { pair, company, weddingId, vendorId, slotId, dealId, eventId, date, tz, explicit: o.explicit ?? false, external: o.external ?? false }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const dated = () => `2029-08-${String(dateSequence++ % 27 + 1).padStart(2, '0')}`
  async function snapshot(f: Fixture, c: Queryable = db()): Promise<Snapshot> {
    const s: Snapshot = {}
    for (const table of [V, H, 'deals', 'slots', 'wedding_events', 'deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts', 'external_invites'])
      s[table] = await raw(c, table, 'where t.wedding_id=$1', [f.weddingId])
    s.weddings = await raw(c, 'weddings', 'where t.id=$1', [f.weddingId])
    s.vendor_busy_dates = await raw(c, 'vendor_busy_dates', 'where t.vendor_id=$1', [f.vendorId])
    for (const table of ['deal_events', 'payments', 'payment_installments', 'payment_corrections', 'payment_installment_edits'])
      s[table] = await raw(c, table, 'where t.deal_id=$1', [f.dealId])
    // Exact relational ownership, never whether a source UUID contains a root UUID.
    s.legacy_calendar_sources = await raw(c, 'legacy_calendar_sources', 'where t.wedding_id=$1 or t.vendor_id=$2', [f.weddingId, f.vendorId])
    for (const table of ['legacy_calendar_versions', 'legacy_calendar_heads', 'legacy_calendar_version_holders'])
      s[table] = await raw(c, table, 'where t.source_id in (select id from legacy_calendar_sources where wedding_id=$1 or vendor_id=$2)', [f.weddingId, f.vendorId])
    s.audit = await raw(c, 'audit_log', 'where t.actor_id=any($1::uuid[]) or t.entity_id=any($2::uuid[])', [[f.pair.id, f.company.id], [f.weddingId, f.dealId, f.slotId]])
    rememberAudits(s.audit)
    s.receipts = await raw(c, 'idempotency_keys', 'where t.user_id=any($1::uuid[])', [[f.pair.id, f.company.id]])
    return s
  }
  function finance(s: Snapshot) {
    const keys = ['deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts', 'payments', 'payment_installments', 'payment_corrections', 'payment_installment_edits']
    return Object.fromEntries(keys.map(k => [k, s[k]]))
  }
  async function version(f: Fixture, patch: Partial<Version> = {}): Promise<Version> {
    const day = (await db().query<{ id: string }>("select id from vendor_busy_dates where vendor_id=$1 and date=$2 and source='deal'", [f.vendorId, f.date])).rows[0]?.id ?? null
    return { id: randomUUID(), wedding_id: f.weddingId, deal_id: f.dealId, slot_id: f.slotId, schema_version: 1, revision: '1', previous_version_id: null,
      origin_knowledge: 'observed_tracking', operation: 'observe', recorded_at: '1970-01-01T00:00:00Z', context_kind: f.explicit ? 'explicit_main' : 'implicit_main',
      event_id: f.eventId, performer_kind: f.external ? 'external' : 'catalog', vendor_id: f.external ? null : f.vendorId,
      binding_state: f.external ? 'external' : f.date ? 'active' : 'undated', service_date: f.date, time_zone: f.tz, day_id: f.external ? null : day, ...patch }
  }
  async function insert(c: Queryable, v: Version) {
    const state = syntheticTransitions.get(v.deal_id)
    if (state) {
      syntheticTransitions.delete(v.deal_id)
      await c.query('update deals set state=$2 where id=$1', [v.deal_id, state])
      if (state === 'cancelled') {
        await c.query('update slots set deal_id=null where id=$1 and deal_id=$2', [v.slot_id, v.deal_id])
        await c.query('delete from vendor_busy_dates where deal_id=$1', [v.deal_id])
      }
    }
    versions.add(v.id)
    await c.query(`insert into ${V}(${columns.join(',')}) values(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(k => v[k]))
  }
  const head = (c: Queryable, v: Version) => c.query(`insert into ${H}(deal_id,wedding_id,revision,current_version_id) values($1,$2,$3,$4)`, [v.deal_id, v.wedding_id, v.revision, v.id])
  const advance = (c: Queryable, v: Version) => c.query(`update ${H} set revision=$2,current_version_id=$3 where deal_id=$1`, [v.deal_id, v.revision, v.id])
  const next = (p: Version, patch: Partial<Version> = {}): Version => ({ ...p, id: randomUUID(), revision: String(BigInt(p.revision) + 1n), previous_version_id: p.id, origin_knowledge: null, operation: 'retain_done', ...patch })
  async function track(f: Fixture, patch: Partial<Version> = {}) {
    const p = await version(f, patch); await db().tx(async c => { await insert(c, p); await head(c, p) }); return p
  }
  const savedVersion = (p: Version) => raw(db(), V, 'where t.id=$1', [p.id])
  async function view(f: Fixture, c: Queryable = db()): Promise<View | null> {
    const path = '../src/deals/day-scope.js'
    const m = await import(/* @vite-ignore */ path) as { loadDealDayScope: (c: Queryable, scope: { weddingId: string; dealId: string }) => Promise<View | null> }
    return m.loadDealDayScope(c, { weddingId: f.weddingId, dealId: f.dealId })
  }
  async function complete(f: Fixture, publicFinancial = false) {
    if (!publicFinancial) {
      const hasHead = (await db().query(`select deal_id from ${H} where deal_id=$1`, [f.dealId])).rows.length > 0
      if (hasHead) syntheticTransitions.set(f.dealId, 'done')
      else await db().query("update deals set state='done',done_at=clock_timestamp() where id=$1", [f.dealId])
      return
    }
    const response = await app!.inject({ method: 'PATCH', url: `/deals/${f.dealId}`, headers: auth(f.pair), payload: { state: 'done' } })
    witness('PUBLIC_DONE', { weddingId: f.weddingId, dealId: f.dealId, status: response.statusCode, body: response.body })
    expect(response.statusCode, 'Public done setup must actually succeed before storage target').toBe(200)
  }
  async function paid(f: Fixture) {
    const r = await app!.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/pay`, headers: auth(f.pair), payload: { amount: { amount: 3000, currency: 'RUB' } } })
    expect(r.statusCode, r.body).toBe(200)
    expect((await db().query('select state from deals where id=$1', [f.dealId])).rows).toEqual([{ state: 'paid_deposit' }])
  }
  async function populatedDraft(f: Fixture) {
    const orderVersion = async () => (await db().query<{ version: string }>('select version::text from deal_orders where deal_id=$1', [f.dealId])).rows[0]!.version
    const assignment = await app!.inject({ method: 'POST', url: `/deals/${f.dealId}/order/assignments`, headers: auth(f.pair),
      payload: { expectedVersion: await orderVersion(), slotId: f.slotId, programEventId: f.eventId, label: 'Synthetic unchanged draft scope' } })
    expect(assignment.statusCode, assignment.body).toBe(200)
    const id = (await db().query<{ id: string }>('select id from order_assignments where deal_id=$1 and slot_id=$2 and cancelled_at is null', [f.dealId, f.slotId])).rows[0]!.id
    const part = await app!.inject({ method: 'POST', url: `/deals/${f.dealId}/order/parts`, headers: auth(f.pair),
      payload: { expectedVersion: await orderVersion(), kind: 'timed_service', assignmentId: id, title: 'Synthetic unchanged service', details: {} } })
    expect(part.statusCode, part.body).toBe(200)
  }
  async function appendSuccess(f: Fixture, value: Version, atomic = false) {
    const before = await snapshot(f); let phase: Phase = 'SETUP', callbackCompleted = false, refusal: unknown = null
    try { await db().tx(async c => {
      if (atomic) await c.query("update deals set state='done',done_at=now() where id=$1", [f.dealId])
      phase = 'INSERT_VERSION'; await insert(c, value)
      phase = 'ADVANCE_HEAD'; await advance(c, value)
      await c.query('select 1'); callbackCompleted = true; phase = 'OUTER_COMMIT'
    }); phase = 'COMMITTED' } catch (e) { refusal = e }
    const after = await snapshot(f)
    witness('APPEND_EXPECT_SUCCESS', { dealId: f.dealId, attempted: value, atomic, phase, callbackCompleted, error: errorInfo(refusal), before, after })
    if (refusal) expect(after, 'actual87 failure must fully roll back storage/atomic state').toEqual(before)
    expect(refusal, 'Expected successful native terminal COMMIT; applied87 meaningful RED is INSERT23514/deal_day_scope_shape').toBeNull()
    expect(callbackCompleted).toBe(true); expect(phase).toBe('COMMITTED')
    expect(await view(f)).toMatchObject({ versionId: value.id, revision: value.revision, freshness: 'current', current: {
      bindingState: value.binding_state, slotId: value.slot_id, contextKind: value.context_kind, eventId: value.event_id,
      performerKind: value.performer_kind, vendorId: value.vendor_id, date: value.service_date, timeZone: value.time_zone, dayId: value.day_id } })
    return after
  }
  async function terminal(o: Parameters<typeof fixture>[0] = {}, origin = 'observed_tracking') {
    const f = await fixture(o), p = await track(f, { origin_knowledge: origin }), before = await savedVersion(p)
    await complete(f)
    const t = next(p, { binding_state: p.binding_state === 'active' ? 'done_retained' : 'done_undated' })
    await appendSuccess(f, t); expect(await savedVersion(p)).toEqual(before)
    return { f, p, t }
  }
  async function rejected(f: Fixture, constraint: string, expectedPhase: Phase,
    run: (c: Queryable, mark: (p: Phase) => void) => Promise<unknown>, message?: RegExp) {
    const before = await snapshot(f); let phase: Phase = 'SETUP', callbackCompleted = false, error: unknown = null
    try { await db().tx(async c => { await run(c, p => { phase = p }); await c.query('select 1'); callbackCompleted = true; phase = 'OUTER_COMMIT' }) }
    catch (e) { error = e }
    const after = await snapshot(f)
    witness('REFUSAL', { dealId: f.dealId, expectedPhase, expectedConstraint: constraint, phase, callbackCompleted, error: errorInfo(error), before, after })
    expect(error).toMatchObject({ code: '23514', constraint }); expect(phase).toBe(expectedPhase)
    expect(callbackCompleted).toBe(expectedPhase === 'OUTER_COMMIT')
    if (message) expect(errorInfo(error)?.message).toMatch(message)
    expect(after, 'full rollback, not counts').toEqual(before)
  }
  async function reschedule(f: Fixture, date: string) {
    const r = await app!.inject({ method: 'POST', url: `/weddings/${f.weddingId}/reschedule`, headers: auth(f.pair), payload: { date } })
    expect(r.statusCode, r.body).toBe(200)
  }

  it.each(['booked', 'paid_deposit'] as const)('FNULL01 public %s NULL-date done preserves financial facts and creates no DATE', async state => {
    const f = await fixture(); await populatedDraft(f); if (state === 'paid_deposit') await paid(f)
    const before = await snapshot(f); await complete(f, true); const after = await snapshot(f)
    witness('FINANCIAL_POSITIVE', { state, before, after })
    expect(before.order_assignments.length).toBeGreaterThan(0); expect(before.order_parts.length).toBeGreaterThan(0)
    if (state === 'paid_deposit') expect(before.payments.length).toBeGreaterThan(0)
    expect(finance(after)).toEqual(finance(before)); expect(after.vendor_busy_dates).toEqual([])
    const root = JSON.parse(after.deals[0]!) as { state: string; done_at: string | null; price: number; currency: string }
    expect(root.state).toBe('done'); expect(root.done_at).not.toBeNull(); expect(root.price).toBe(17000); expect(root.currency).toBe('RUB')
  })
  it('FNULL01 locked paid parent combined price and done is409 with no financial/history/receipt write', async () => {
    const f = await fixture(); await paid(f); const before = await snapshot(f)
    const r = await app!.inject({ method: 'PATCH', url: `/deals/${f.dealId}`, headers: auth(f.pair), payload: { state: 'done', price: { amount: 18000, currency: 'RUB' } } })
    const after = await snapshot(f); witness('PRICE_LOCKED', { status: r.statusCode, body: r.body, before, after })
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('price_locked'); expect(after).toEqual(before)
  })
  const variants = [{ explicit: false, tz: null }, { explicit: false, tz: 'Europe/Moscow' }, { explicit: true, tz: null }, { explicit: true, tz: 'Europe/Moscow' }]
  it.each(variants)('FNULL02 expected terminal COMMIT explicit=$explicit tz=$tz', async o => {
    const f = await fixture(o), p = await track(f), old = await savedVersion(p); await complete(f)
    const t = next(p, { binding_state: 'done_undated' }); const after = await appendSuccess(f, t)
    expect(facts(t)).toEqual(facts(p)); expect(await savedVersion(p)).toEqual(old); expect(after.vendor_busy_dates).toEqual([])
    expect((await db().query('select state from deals where id=$1', [f.dealId])).rows).toEqual([{ state: 'done' }])
  })
  it('FNULL03 expected atomic SQL state plus terminal COMMIT; actual87 shape rollback includes root state', async () => {
    const f = await fixture(), p = await track(f)
    await appendSuccess(f, next(p, { binding_state: 'done_undated' }), true)
    expect((await db().query('select state from deals where id=$1', [f.dealId])).rows).toEqual([{ state: 'done' }])
  })
  it('FNULL04 done_undated repeat retain preserves NULL tuple and immutable origin', async () => {
    const { f, p, t } = await terminal(), oldP = await savedVersion(p), oldT = await savedVersion(t)
    const again = next(t); await appendSuccess(f, again)
    expect(facts(again)).toEqual(facts(t)); expect(await savedVersion(p)).toEqual(oldP); expect(await savedVersion(t)).toEqual(oldT)
  })
  it('FNULL04 legacy_unknown origin masks history while known undated terminal remains current', async () => {
    const { f, p, t } = await terminal({ explicit: true, tz: 'Asia/Novosibirsk' }, 'legacy_unknown')
    expect(await view(f)).toMatchObject({ freshness: 'current', origin: { knowledge: 'legacy_unknown', eventId: null, date: null, timeZone: null },
      current: { bindingState: 'done_undated', eventId: p.event_id, timeZone: 'Asia/Novosibirsk', date: null, dayId: null } })
    expect(facts(t)).toEqual(facts(p))
  })
  it('FNULL04 historical terminal ignores later main dates timezone and selected/event pointers without inventing DATE', async () => {
    const { f, p, t } = await terminal({ explicit: true }), oldP = await savedVersion(p), oldT = await savedVersion(t)
    await reschedule(f, dated()); await reschedule(f, dated())
    await db().query("update weddings set tz='Asia/Novosibirsk' where id=$1", [f.weddingId])
    const event = randomUUID()
    await db().query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Synthetic later context','other',null,null,false)", [event, f.weddingId])
    await db().query('update slots set program_event_id=$2,deal_id=null where id=$1', [f.slotId, event])
    expect(await view(f)).toMatchObject({ freshness: 'current', current: { eventId: p.event_id, timeZone: null, date: null, dayId: null } })
    expect(await savedVersion(p)).toEqual(oldP); expect(await savedVersion(t)).toEqual(oldT)
    expect((await db().query('select id from vendor_busy_dates where vendor_id=$1', [f.vendorId])).rows).toEqual([])
  })
  it('FNULL04 stale before done is observable; storage does not pretend to implement pretransition writer freshness', async () => {
    const f = await fixture(), p = await track(f), before = await snapshot(f), saved = await savedVersion(p)
    let callback = false
    await expect(db().tx(async c => {
      await c.query('update weddings set date=$2 where id=$1', [f.weddingId, dated()])
      expect(await view(f, c)).toMatchObject({ freshness: 'stale', current: { bindingState: 'undated', date: null, dayId: null } })
      expect(await raw(c, V, 'where t.id=$1', [p.id])).toEqual(saved); callback = true
    })).rejects.toMatchObject({ code: '23514' })
    expect(callback).toBe(true); expect(await snapshot(f)).toEqual(before)
  })
  it.each([false, true])('FNULL04 dated typed retain repeat=%s preserves old DATE after main move', async repeat => {
    const { f, p, t } = await terminal({ date: dated(), tz: 'Europe/Moscow' }), old = await savedVersion(p)
    const current = repeat ? next(t) : t; if (repeat) await appendSuccess(f, current)
    await reschedule(f, dated())
    expect(await view(f)).toMatchObject({ freshness: 'current', current: { bindingState: 'done_retained', date: p.service_date, dayId: p.day_id } })
    expect(await savedVersion(p)).toEqual(old)
    expect((await db().query('select id from vendor_busy_dates where id=$1', [p.day_id])).rows).toEqual([{ id: p.day_id }])
  })
  it('FNULL06 dated retained pointer disappearance still refuses at real outer COMMIT', async () => {
    const { f, t } = await terminal({ date: dated() }), again = next(t)
    await rejected(f, 'deal_day_scope_current', 'OUTER_COMMIT', async (c, mark) => {
      mark('INSERT_VERSION'); await insert(c, again); await advance(c, again)
      expect((await c.query('delete from vendor_busy_dates where id=$1 returning id', [t.day_id])).rows).toEqual([{ id: t.day_id }])
    })
  })
  const shapes: { name: string; patch: Partial<Version> }[] = [
    { name: 'schema_version2', patch: { schema_version: 2 } }, { name: 'nonnull DATE', patch: { service_date: '2029-11-12' } },
    { name: 'explicit_event', patch: { context_kind: 'explicit_event' } }, { name: 'unknown context', patch: { context_kind: 'unknown' } },
  ]
  it.each(shapes)('FNULL05 first shape refuses $name before chain/current', async ({ patch }) => {
    const { f, t } = await terminal(), n = next(t, patch)
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, n) })
  })
  it('FNULL05 first shape refuses a real nonNULL day without using missing FK as oracle', async () => {
    const { f, t } = await terminal(), other = await fixture({ date: dated() }), day = (await version(other)).day_id
    assert(day); const foreign = await snapshot(other)
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(t, { day_id: day })) })
    expect(await snapshot(other)).toEqual(foreign)
  })
  it('FNULL05 invalid timezone reaches timezone guard before retained tuple comparison', async () => {
    const { f, t } = await terminal()
    await rejected(f, 'deal_day_scope_time_zone', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(t, { time_zone: 'Synthetic/Invalid-Zone' })) })
  })
  it('FNULL05 genuine external performer cannot enter the catalog-only done_undated shape', async () => {
    const f = await fixture({ external: true }), p = await track(f); await complete(f)
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => {
      mark('INSERT_VERSION'); await insert(c, next(p, { binding_state: 'done_undated' }))
    }, /Invalid day scope shape/)
  })
  it('FNULL05 missing namespace head cannot borrow another real head; all composite FKs valid', async () => {
    const own = await fixture(), foreign = await fixture(); await track(foreign)
    const otherBefore = await snapshot(foreign), p = await version(own), t = next(p, { binding_state: 'done_undated' })
    await rejected(own, 'deal_day_scope_chain', 'INSERT_VERSION', async (c, mark) => {
      await insert(c, p) // Real own predecessor, deliberately no head; deferred first-version check not reached yet.
      await c.query("update deals set state='done' where id=$1", [own.dealId]); mark('INSERT_VERSION'); await insert(c, t)
    })
    expect(await snapshot(foreign)).toEqual(otherBefore)
  })
  it('FNULL05 revision skip reaches exact chain guard', async () => {
    const { f, t } = await terminal()
    await rejected(f, 'deal_day_scope_chain', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(t, { revision: String(BigInt(t.revision) + 2n) })) })
  })
  it('FNULL05 older real same-parent predecessor reaches chain rather than deferred FK', async () => {
    const f = await fixture(), p = await track(f), second = next(p, { operation: 'acquire', binding_state: 'undated' })
    await db().tx(async c => { await insert(c, second); await advance(c, second) }); await complete(f)
    await rejected(f, 'deal_day_scope_chain', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(second, { binding_state: 'done_undated', previous_version_id: p.id })) })
  })
  it.each(['slot', 'event', 'vendor', 'context', 'timezone'])('FNULL05 retained literal %s mismatch reaches tuple shape', async field => {
    const { f, t } = await terminal(), other = await fixture(), foreign = await snapshot(other)
    const patches: Record<string, Partial<Version>> = { slot: { slot_id: other.slotId }, event: { event_id: other.eventId }, vendor: { vendor_id: other.vendorId },
      context: { context_kind: 'explicit_main' }, timezone: { time_zone: 'Europe/Moscow' } }
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(t, patches[field])) }, /Retained day must preserve/)
    expect(await snapshot(other)).toEqual(foreign)
  })
  it('FNULL05 live vendor mismatch reaches current with unchanged retained tuple', async () => {
    const { f, t } = await terminal(), other = await fixture(), foreign = await snapshot(other)
    await rejected(f, 'deal_day_scope_current', 'INSERT_VERSION', async (c, mark) => {
      await c.query('update deals set vendor_id=$2 where id=$1', [f.dealId, other.vendorId]); mark('INSERT_VERSION'); await insert(c, next(t))
    })
    expect(await snapshot(other)).toEqual(foreign)
  })
  it('FNULL05 exact existing pointer plus wrong head revision reaches heads_step', async () => {
    const { f, t } = await terminal()
    await rejected(f, 'deal_day_scope_heads_step', 'UPDATE_HEAD', async (c, mark) => { mark('UPDATE_HEAD'); await c.query(`update ${H} set revision=revision+1 where deal_id=$1`, [t.deal_id]) })
  })
  it.each(['origin_knowledge=origin_knowledge', 'recorded_at=recorded_at'])('FNULL05 immutable version refuses %s', async expression => {
    const { f, p } = await terminal()
    await rejected(f, 'deal_day_scope_versions_immutable', 'UPDATE_VERSION', async (c, mark) => { mark('UPDATE_VERSION'); await c.query(`update ${V} set ${expression} where id=$1`, [p.id]) })
  })
  it.each(['observe', 'acquire'])('FNULL05 first-observed done_undated %s has no manufactured predecessor', async operation => {
    const f = await fixture(); await complete(f); const first = await version(f, { binding_state: 'done_undated', operation })
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, first) })
  })
  it.each(['state', 'vendor', 'slot'])('FNULL06 real outer COMMIT rejects final root %s mutation after valid append/head', async field => {
    const { f, t } = await terminal(), other = await fixture(), foreign = await snapshot(other), again = next(t)
    const empty = randomUUID(); slots.add(empty)
    await db().query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'video','Synthetic rollback slot')", [empty, f.weddingId])
    await rejected(f, 'deal_day_scope_current', 'OUTER_COMMIT', async (c, mark) => {
      // Admit the complete potential parent/vendor union before writing a DAY
      // version. Otherwise the94 financial prefix correctly rejects a late
      // union extension before this test reaches its deferred-current oracle.
      if (hasCalendarBounds) await prepareLegacyCalendarScope(c, {
        weddingIds: [f.weddingId, other.weddingId], vendorIds: [f.vendorId, other.vendorId],
      })
      mark('INSERT_VERSION'); await insert(c, again); await advance(c, again)
      if (field === 'state') await c.query("update deals set state='booked' where id=$1", [f.dealId])
      else if (field === 'vendor') await c.query('update deals set vendor_id=$2 where id=$1', [f.dealId, other.vendorId])
      else await c.query('update deals set slot_id=$2 where id=$1', [f.dealId, empty])
    })
    expect(await snapshot(other)).toEqual(foreign)
  })
  it('FNULL06 orphan valid append completes callback then refuses outer COMMIT chain', async () => {
    const { f, t } = await terminal()
    await rejected(f, 'deal_day_scope_chain', 'OUTER_COMMIT', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(t)) })
  })

  const crossTargets = [
    ['active', 'done_undated'], ['done_retained', 'done_undated'], ['undated', 'done_retained'], ['done_undated', 'done_retained'],
    ['unknown', 'done_undated'], ['unknown', 'done_retained'], ['external', 'done_undated'], ['external', 'done_retained'],
    ['released', 'done_undated'], ['released', 'done_retained'],
  ] as const
  it.each(crossTargets)('FNULL05 typed retain refuses %s to %s before tuple/current', async (predecessor, target) => {
    const f = await fixture({ date: ['active', 'done_retained'].includes(predecessor) ? dated() : null, external: predecessor === 'external' })
    let p = await track(f, predecessor === 'unknown' ? { binding_state: 'unknown' } : {})
    if (predecessor === 'released') {
      syntheticTransitions.set(f.dealId, 'cancelled')
      const released = next(p, { operation: 'release', binding_state: 'released', day_id: null })
      await db().tx(async c => { await insert(c, released); await advance(c, released) }); p = released
    } else {
      await complete(f)
      if (predecessor === 'done_retained' || predecessor === 'done_undated') { const t = next(p, { binding_state: predecessor }); await appendSuccess(f, t); p = t }
    }
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => {
      // Make NEW shape/current otherwise valid. Direct financial-looking facts
      // exist ONLY inside this rollback TX; no HTTP reopen/authority claim.
      await c.query("update deals set state='done',vendor_id=$2,external_name=null where id=$1", [f.dealId, f.vendorId])
      await c.query('update slots set deal_id=$2 where id=$1', [f.slotId, f.dealId])
      let day: string | null = null; const date = target === 'done_retained' ? (f.date ?? dated()) : null
      if (date) day = (await c.query<{ id: string }>(`insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3)
        on conflict(vendor_id,date) do update set deal_id=excluded.deal_id returning id`, [f.vendorId, date, f.dealId])).rows[0]!.id
      const n = next(p, { binding_state: target, performer_kind: 'catalog', vendor_id: f.vendorId, context_kind: f.explicit ? 'explicit_main' : 'implicit_main',
        event_id: f.eventId, service_date: date, day_id: day })
      mark('INSERT_VERSION'); await insert(c, n)
    }, /Invalid predecessor state/)
  })
  it.each(['acquire', 'move'])('FNULL07 terminal predecessor refuses %s with otherwise-valid undated NEW', async operation => {
    const { f, t } = await terminal()
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => {
      await c.query("update deals set state='booked' where id=$1", [f.dealId])
      mark('INSERT_VERSION'); await insert(c, next(t, { operation, binding_state: 'undated' }))
    }, /Invalid predecessor state/)
  })
  it.each(['done_undated', 'done_retained'])('FNULL07 generic release from %s requires cancelled root; done INSERT refuses current', async binding => {
    const { f, t } = await terminal(binding === 'done_retained' ? { date: dated() } : {})
    await rejected(f, 'deal_day_scope_current', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(t, { operation: 'release', binding_state: 'released', day_id: null })) })
    // A separate schema-only rollback control must pass both INSERT/head/current
    // under cancelled facts; it never commits HTTP reopen/cancel permission.
    const before = await snapshot(f)
    const rollback = new Error('expected schema-only rollback after successful release')
    let reached = false
    try { await db().tx(async c => {
      await c.query("update deals set state='cancelled' where id=$1", [f.dealId])
      const release = next(t, { operation: 'release', binding_state: 'released', day_id: null })
      await insert(c, release); await advance(c, release)
      expect((await c.query<{ ok: boolean }>(`select deal_day_scope_matches_current(t) ok from ${V} t where id=$1`, [release.id])).rows).toEqual([{ ok: true }])
      reached = true; throw rollback
    }) } catch (e) { expect(e).toBe(rollback) }
    expect(reached).toBe(true); expect(await snapshot(f)).toEqual(before)
    witness('RELEASE_SCHEMA_ONLY', { binding, reached, before, after: await snapshot(f) })
  })
  it('FNULL07 public done cancellation keeps financial/root/history exact', async () => {
    const { f } = await terminal(), before = await snapshot(f)
    const r = await app!.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/cancel`, headers: auth(f.pair) })
    const after = await snapshot(f); witness('DONE_CANCEL', { status: r.statusCode, body: r.body, before, after })
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('bad_transition'); expect(after).toEqual(before)
  })
  it('FNULL07 genuine external done DELETE409 commits invite revocation only, snapshots precede guestGET410', async () => {
    const f = await fixture({ external: true }), foreign = await fixture({ external: true })
    const invite = async (x: Fixture) => { const r = await app!.inject({ method: 'POST', url: `/weddings/${x.weddingId}/slots/${x.slotId}/external/invite`, headers: auth(x.pair) }); expect(r.statusCode, r.body).toBe(201); return r.json<{ token: string }>().token }
    const token = await invite(f); await invite(f); await invite(foreign); await complete(f)
    const p = await track(f), before = await snapshot(f), other = await snapshot(foreign)
    const invites = before.external_invites.map(row => JSON.parse(row) as { token: string; revoked_at: string | null; expires_at: string })
    expect(invites.length).toBeGreaterThan(0); expect(invites.every(i => i.revoked_at === null)).toBe(true)
    const start = (await db().query<{ at: Date }>('select clock_timestamp() at')).rows[0]!.at.getTime()
    expect(invites.every(i => Date.parse(i.expires_at) > start)).toBe(true)
    const r = await app!.inject({ method: 'DELETE', url: `/weddings/${f.weddingId}/slots/${f.slotId}/external`, headers: auth(f.pair) })
    const end = (await db().query<{ at: Date }>('select clock_timestamp() at')).rows[0]!.at.getTime(), after = await snapshot(f)
    witness('EXTERNAL_DELETE', { status: r.statusCode, body: r.body, before, after, foreignBefore: other, foreignAfter: await snapshot(foreign) })
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('bad_transition')
    const project = (rows: string[]) => rows.map(row => { const value = JSON.parse(row) as Record<string, unknown>; delete value.revoked_at; return value })
    expect(project(after.external_invites)).toEqual(project(before.external_invites))
    for (const row of after.external_invites) { const at = Date.parse((JSON.parse(row) as { revoked_at: string }).revoked_at); expect(at).toBeGreaterThanOrEqual(start); expect(at).toBeLessThanOrEqual(end) }
    expect({ ...after, external_invites: [] }).toEqual({ ...before, external_invites: [] }); expect(await snapshot(foreign)).toEqual(other)
    expect(await savedVersion(p)).toEqual(before[V]); expect((await app!.inject({ method: 'GET', url: `/guest-vendor/${token}` })).statusCode).toBe(410)
  })
  it('FNULL08 binding unknown is not fabricated as undated even when origin is known', async () => {
    const f = await fixture(), p = await track(f, { binding_state: 'unknown' }); await complete(f)
    await rejected(f, 'deal_day_scope_shape', 'INSERT_VERSION', async (c, mark) => { mark('INSERT_VERSION'); await insert(c, next(p, { binding_state: 'done_undated' })) }, /Invalid predecessor state/)
  })
  it.each(['active', 'undated', 'unknown', 'external', 'done_retained', 'released'])('FNULL08 old87 first observe %s remains admitted', async binding => {
    const f = await fixture({ date: ['active', 'done_retained'].includes(binding) ? dated() : null, external: binding === 'external' })
    if (binding === 'done_retained') await complete(f)
    if (binding === 'released') {
      syntheticTransitions.set(f.dealId, 'cancelled')
    }
    const patch: Partial<Version> = binding === 'unknown' ? { context_kind: 'unknown', event_id: null, performer_kind: 'unknown', vendor_id: null,
      binding_state: 'unknown', origin_knowledge: 'legacy_unknown', service_date: null, time_zone: null, day_id: null } : { binding_state: binding }
    const p = await track(f, patch)
    expect(p.revision).toBe('1'); expect(p.operation).toBe('observe'); expect(await view(f)).toMatchObject({ freshness: 'current', current: { bindingState: binding } })
  })
  it.each(['vendor', 'owner user'])('FNULL08 scoped native %s erasure retains terminal evidence and makes it stale', async erased => {
    const { f, p, t } = await terminal(), other = await fixture(), oldP = await savedVersion(p), oldT = await savedVersion(t), foreign = await snapshot(other)
    const audits = await raw(db(), 'audit_log'); rememberAudits(audits)
    await db().tx(async c => {
      await c.query("update deals set vendor_id=null,external_name='Удалённый подрядчик' where id=$1 and vendor_id=$2", [f.dealId, f.vendorId])
      if (erased === 'vendor') await c.query('delete from vendors where id=$1', [f.vendorId]); else await c.query('delete from users where id=$1', [f.company.id])
    })
    expect(await savedVersion(p)).toEqual(oldP); expect(await savedVersion(t)).toEqual(oldT)
    expect(await view(f)).toMatchObject({ freshness: 'stale', current: { bindingState: 'done_undated', performerKind: 'catalog', vendorId: f.vendorId, dayId: null } })
    expect(await snapshot(other)).toEqual(foreign); rememberAudits(await raw(db(), 'audit_log'))
    witness('SCOPED_ERASURE', { erased, oldP, oldT, after: await snapshot(f), foreign })
  })
  it.each(['deal', 'wedding'])('FNULL08 legitimate own %s cascade does not erase foreign terminal/audits', async parent => {
    const { f, t } = await terminal(), other = await terminal(), foreign = await snapshot(other.f)
    rememberAudits(await raw(db(), 'audit_log'))
    await db().tx(async c => {
      if (parent === 'deal') { await c.query('update slots set deal_id=null where id=$1', [f.slotId]); await c.query('delete from deals where id=$1', [f.dealId]) }
      else await c.query('delete from weddings where id=$1', [f.weddingId])
    })
    expect(await savedVersion(t)).toEqual([]); expect((await db().query(`select deal_id from ${H} where deal_id=$1`, [f.dealId])).rows).toEqual([])
    expect(await snapshot(other.f)).toEqual(foreign); rememberAudits(await raw(db(), 'audit_log'))
  })
})
