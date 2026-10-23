import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { expect } from 'vitest'
import { buildApp } from '../../src/app.js'
import { signAccessToken } from '../../src/auth/tokens.js'
import { isUuid } from '../../src/ids.js'
import type { Queryable } from '../../src/plugins/db.js'
import { seedUntrackedSlotDeal } from './dayFixture.js'

export const YEAR = new Date().getUTCFullYear() + 1
export const MAIN_DATE = `${YEAR}-06-14`, EVENT_DATE = `${YEAR}-06-16`, OTHER_DATE = `${YEAR}-06-17`
export const EVENT_TZ = 'Asia/Vladivostok'
const SECRET = 'additional-event-matrix-synthetic-access-'.repeat(3), POLICY = '2026-09-02'
export type Actor = { id: string; sid: string; token: string }
export type Company = { id: string; actor: Actor }
export type EventContext = { id: string; date: string; timeZone: string }
export type ProgramEvent = { id: string; date: string | null; timeZone: string | null; isMain: boolean;
  name: string; kind: string; location: string | null }
export type Reply = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }
export type SlotReply = { id: string; deal: { id: string; state: string; vendor?: { id: string } | null } | null }
export type Case = { pair: Actor; company: Company; wedding: string; mainEvent: ProgramEvent; mainSlot: string;
  event: ProgramEvent; slot: string; actors: string[]; companies: string[]; mainDeal?: string }
export type Raw = Record<string, string[]>
type Request = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; payload?: object;
  key?: string | null; context?: EventContext | string | null; headers?: Record<string, string> }
export const witness = (label: string, value: unknown) => process.stdout.write(`ADDITIONAL_MATRIX_${label} ${JSON.stringify(value)}\n`)
export function ok<T>(r: Reply, status = 200): T { assert.equal(r.statusCode, status, r.body); return r.json<T>() }
export const context = (event: ProgramEvent): EventContext => {
  assert(event.date && event.timeZone, 'Acquisition fixture must have its own known DATE/TZ')
  return { id: event.id, date: event.date, timeZone: event.timeZone }
}

export class AdditionalEventFixture {
  app!: FastifyInstance
  private admitted = false
  private readonly users = new Set<string>()
  private readonly weddings = new Set<string>()
  private readonly vendors = new Set<string>()
  private priorAudit: { id: string; raw: string }[] = []
  get db() { assert(this.app?.db); return this.app.db }
  async start() {
    const database = process.env.TEST_DATABASE_URL
    assert(database, 'TEST_DATABASE_URL required; a skipped native matrix is not acceptance')
    assert.equal(process.env.DATABASE_URL, database)
    const target = new URL(database)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.username, 'codex_test'); assert.equal(target.port, '15432')
    assert(['/tili_additional_20261021_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    this.app = await buildApp({ env: 'test', databaseUrl: database, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'additional-matrix-refresh-synthetic-'.repeat(3), policyVersion: POLICY },
    [], { tillyModel: null })
    await this.app.ready()
    const identity = (await this.db.query<{ database: string; role: string; address: string; port: number; data: string;
      systemIdentifier: string; oid: string; owner: string; pid: number }>(`select current_database() "database",current_user role,
      host(inet_server_addr()) address,inet_server_port() port,current_setting('data_directory') data,
      (select system_identifier::text from pg_control_system()) "systemIdentifier",d.oid::text oid,r.rolname owner,pg_backend_pid() pid
      from pg_database d join pg_roles r on r.oid=d.datdba where d.datname=current_database()`)).rows[0]!
    assert(identity); assert.equal(identity.database, target.pathname.slice(1)); assert.equal(identity.role, 'codex_test')
    assert.equal(identity.owner, 'codex_test'); assert.equal(identity.port, 15432)
    assert(['127.0.0.1', '::1'].includes(identity.address)); assert(/^\d+$/.test(identity.systemIdentifier) && /^\d+$/.test(identity.oid))
    assert(identity.pid > 0 && identity.data.length > 0)
    if (identity.database === 'tili_additional_20261021_test') {
      assert.equal(identity.systemIdentifier, '7699152002090497236')
      assert.equal(identity.data.replaceAll('\\', '/'), 'C:/Users/Bayra/AppData/Local/Temp/tili-t009-additional-20261021-pg')
    }
    const journal = (await this.db.query<{ name: string }>('select name from pgmigrations order by id')).rows.map(r => r.name)
    assert(journal.length >= 89 && journal.includes('1763870000000_deal_day_scope_atomic'))
    assert.equal(new Set(journal).size, journal.length)
    // Root seals exact current migration tail/native identity separately. Do not
    // bind canonical full/CI to this workstation or keep a future count===89.
    witness('IDENTITY', { identity, journal, currentTailAdmissionOwner: 'Root', production: false })
    this.priorAudit = (await this.db.query<{ id: string; raw: string }>('select id::text,row_to_json(t)::text raw from audit_log t order by id')).rows
    this.admitted = true
  }
  async close() {
    if (!this.app) return
    try {
      if (!this.admitted) return
      const discovered = (await this.db.query<{ id: string }>('select id from weddings where owner_id=any($1::uuid[])', [[...this.users]])).rows
      for (const row of discovered) this.weddings.add(row.id)
      const ownAudit = await this.raw('audit_log', `actor_id=any($1::uuid[]) or entity_id=any($2::uuid[])
        or entity_id=any($3::uuid[]) or entity_id in(select id from deals where wedding_id=any($2::uuid[]))`,
      [[...this.users], [...this.weddings], [...this.vendors]])
      witness('OWN_PARENTS', { users: [...this.users], weddings: [...this.weddings], vendors: [...this.vendors], retainedAuditRows: ownAudit })
      // Scoped parent erasure only: no history/group/capture/audit DELETE,
      // retrograde, trigger bypass, eraseUser/global TTL job or foreign cleanup.
      await this.db.tx(async c => {
        for (const id of this.weddings) await c.query('delete from weddings where id=$1 and owner_id=any($2::uuid[])', [id, [...this.users]])
        for (const id of this.vendors) await c.query('delete from vendors where id=$1 and user_id=any($2::uuid[])', [id, [...this.users]])
        for (const id of this.users) await c.query('delete from users where id=$1', [id])
      })
      for (const [table, ids] of [['users', this.users], ['weddings', this.weddings], ['vendors', this.vendors]] as const) {
        expect((await this.db.query(`select id from ${table} where id=any($1::uuid[])`, [[...ids]])).rows).toEqual([])
      }
      for (const table of ['vendor_busy_dates', 'legacy_day_groups', 'vendor_resources']) {
        expect((await this.db.query(`select vendor_id from ${table} where vendor_id=any($1::uuid[])`, [[...this.vendors]])).rows).toEqual([])
      }
      for (const table of ['slots', 'deals', 'deal_day_scope_versions', 'deal_day_scope_heads', 'order_assignments']) {
        expect((await this.db.query(`select wedding_id from ${table} where wedding_id=any($1::uuid[])`, [[...this.weddings]])).rows).toEqual([])
      }
      for (const table of ['sessions', 'consents', 'idempotency_keys', 'notifications']) {
        expect((await this.db.query(`select user_id from ${table} where user_id=any($1::uuid[])`, [[...this.users]])).rows).toEqual([])
      }
      const audit = new Map((await this.db.query<{ id: string; raw: string }>('select id::text,row_to_json(t)::text raw from audit_log t order by id')).rows.map(r => [r.id, r.raw]))
      for (const row of this.priorAudit) expect(audit.get(row.id), 'Prior audit ID/value retained').toBe(row.raw)
      const values = new Set(audit.values())
      for (const row of ownAudit) expect(values.has(row), 'New own audit remains literal').toBe(true)
      witness('CLEANUP', { parentsAbsent: true, priorAuditCount: this.priorAudit.length, retainedAuditRows: ownAudit, appClosePending: true })
    } finally { await this.app.close() }
  }
  async actor(): Promise<Actor> {
    const id = randomUUID(), sid = randomUUID()
    let inserted = false
    for (let n = 0; n < 8 && !inserted; n++) inserted = (await this.db.query(
      "insert into users(id,phone,name) values($1,$2,'Synthetic additional matrix actor') on conflict(phone) do nothing returning id",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])).rowCount === 1
    assert(inserted); this.users.add(id)
    await this.db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await this.db.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, sid, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  async company(f?: Case): Promise<Company> {
    const actor = await this.actor(), id = randomUUID(); this.vendors.add(id)
    await this.db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic additional matrix studio',now())", [id, actor.id])
    if (f) { f.companies.push(id); f.actors.push(actor.id) }
    return { id, actor }
  }
  async call(label: string, actor: Actor, request: Request): Promise<Reply> {
    const value = request.context, encoded = typeof value === 'string' ? value : value ? JSON.stringify(value) : undefined
    const headers = { authorization: `Bearer ${actor.token}`, ...(request.key ? { 'idempotency-key': request.key } : {}),
      ...(encoded === undefined ? {} : { 'x-program-event-context': encoded }), ...request.headers }
    const response = await this.app.inject({ method: request.method, url: request.url, headers, payload: request.payload })
    witness('HTTP', { label, actorId: actor.id, method: request.method, url: request.url, body: request.payload ?? null,
      key: request.key ?? null, eventContext: encoded ?? null, status: response.statusCode, response: response.body,
      idempotentReplay: response.headers['idempotent-replay'] ?? null })
    return response
  }
  async event(wedding: string, pair: Actor, date: string | null, timeZone: string | null): Promise<ProgramEvent> {
    const read = await this.call('EVENTS_GET', pair, { method: 'GET', url: `/weddings/${wedding}/events` })
    ok(read); assert.equal(typeof read.headers.etag, 'string')
    return ok<ProgramEvent>(await this.call('EVENT_CREATE', pair, { method: 'POST', url: `/weddings/${wedding}/events`,
      headers: { 'if-match': read.headers.etag as string },
      payload: { name: 'Synthetic matrix additional event', kind: 'second_day', date, timeZone } }), 201)
  }
  async slot(wedding: string, pair: Actor, event: ProgramEvent): Promise<string> {
    const slot = ok<{ id: string; programEventId: string; categoryId: string }>(await this.call('ADDITIONAL_CREATE', pair, {
      method: 'POST', url: `/weddings/${wedding}/slots/additional`, key: randomUUID(),
      payload: { categoryId: 'photo', programEventId: event.id, label: 'Synthetic independent additional photo' } }), 201)
    assert(isUuid(slot.id)); assert.equal(slot.programEventId, event.id); assert.equal(slot.categoryId, 'photo')
    return slot.id
  }
  async fixture(options: { date?: string | null; timeZone?: string | null; mainBooking?: boolean } = {}): Promise<Case> {
    const pair = await this.actor(), company = await this.company()
    const city = (await this.db.query<{ name: string; region: string }>(
      "select name,region from cities where name='Уфа' and region='Башкортостан' and tz is not null order by id limit 1")).rows[0]
    assert(city)
    const w = ok<{ id: string }>(await this.call('WEDDING_CREATE', pair, { method: 'POST', url: '/weddings',
      payload: { partnerName: 'Synthetic matrix partner', city, date: MAIN_DATE } }), 201)
    assert(isUuid(w.id)); this.weddings.add(w.id)
    const mainEvent = ok<ProgramEvent[]>(await this.call('MAIN_EVENT', pair, { method: 'GET', url: `/weddings/${w.id}/events` })).find(e => e.isMain)
    const main = ok<(SlotReply & { categoryId: string })[]>(await this.call('MAIN_SLOT', pair, { method: 'GET', url: `/weddings/${w.id}/slots` })).find(s => s.categoryId === 'photo' && s.deal === null)
    assert(mainEvent && main)
    const event = await this.event(w.id, pair, options.date === undefined ? EVENT_DATE : options.date, options.timeZone === undefined ? EVENT_TZ : options.timeZone)
    const slot = await this.slot(w.id, pair, event)
    const f: Case = { pair, company, wedding: w.id, mainEvent, mainSlot: main.id, event, slot, actors: [pair.id, company.actor.id], companies: [company.id] }
    if (options.mainBooking) {
      const mainBooking = ok<SlotReply>(await this.call('MAIN_BOOK', pair, { method: 'POST', url: `/weddings/${w.id}/slots/${main.id}/book`,
        key: randomUUID(), payload: { vendorId: company.id, price: { amount: 1357900, currency: 'RUB' } } }))
      assert(mainBooking.deal); f.mainDeal = mainBooking.deal.id
    }
    return f
  }
  book(f: Case, options: { slot?: string; company?: Company; key?: string | null; context?: EventContext | string | null } = {}) {
    return this.call('CATALOG_BOOK', f.pair, { method: 'POST', url: `/weddings/${f.wedding}/slots/${options.slot ?? f.slot}/book`,
      key: options.key === undefined ? randomUUID() : options.key,
      context: Object.hasOwn(options, 'context') ? options.context : context(f.event),
      payload: { vendorId: (options.company ?? f.company).id, price: { amount: 2468000, currency: 'RUB' } } })
  }
  cancel(f: Case, slot = f.slot, supplied?: EventContext) {
    return this.call('SLOT_CANCEL', f.pair, { method: 'POST', url: `/weddings/${f.wedding}/slots/${slot}/cancel`, key: randomUUID(), context: supplied })
  }
  async seed(f: Case, state: 'candidate' | 'contacted' | 'negotiating' = 'candidate') {
    // Explicit pretracking synthetic candidate, never a public booked root
    // retrograded or stripped of immutable history.
    return seedUntrackedSlotDeal(this.app, { weddingId: f.wedding, slotId: f.slot, vendorId: f.company.id, state,
      price: 17000, negotiatingUntil: state === 'negotiating' ? new Date(Date.now() + 72 * 3600_000).toISOString() : null })
  }
  async raw(table: string, where: string, values: readonly unknown[], client: Queryable = this.db) {
    return (await client.query<{ raw: string }>(`select row_to_json(t)::text raw from ${table} t where ${where} order by row_to_json(t)::text`, values)).rows.map(r => r.raw)
  }
  async snapshot(f: Case): Promise<Raw> {
    const out: Raw = {}
    for (const table of ['weddings']) out[table] = await this.raw(table, 'id=$1', [f.wedding])
    for (const table of ['wedding_events', 'slots', 'deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions',
      'deal_terms_receipts', 'deal_resource_plan_versions', 'deal_resource_commitments', 'deal_resource_commitment_versions',
      'deal_resource_commitment_members', 'resource_allocations', 'deal_day_scope_versions', 'deal_day_scope_heads', 'tasks', 'timeline_events', 'leads', 'chats', 'external_invites']) {
      out[table] = await this.raw(table, 'wedding_id=$1', [f.wedding])
    }
    for (const table of ['payments', 'payment_installments', 'payment_corrections', 'payment_installment_edits', 'deal_events']) {
      out[table] = await this.raw(table, 'deal_id in(select id from deals where wedding_id=$1)', [f.wedding])
    }
    for (const table of ['vendor_busy_dates', 'legacy_day_groups', 'vendor_resources', 'vendor_availability_policy']) {
      out[table] = await this.raw(table, 'vendor_id=any($1::uuid[])', [f.companies])
    }
    for (const table of ['slot_shortlist', 'offer_requests']) out[table] = await this.raw(table, 'slot_id in(select id from slots where wedding_id=$1)', [f.wedding])
    out.offers = await this.raw('offers', 'request_id in(select r.id from offer_requests r join slots s on s.id=r.slot_id where s.wedding_id=$1)', [f.wedding])
    out.audit = await this.raw('audit_log', 'actor_id=any($1::uuid[]) or entity_id=$2 or entity_id in(select id from deals where wedding_id=$2)', [f.actors, f.wedding])
    for (const table of ['idempotency_keys', 'notifications']) out[table] = await this.raw(table, 'user_id=any($1::uuid[])', [f.actors])
    return out
  }
  async refused(f: Case, label: string, action: () => Promise<Reply>, status: number, code: string) {
    const before = await this.snapshot(f), r = await action(), after = await this.snapshot(f)
    witness('REFUSAL', { label, status: r.statusCode, body: r.body, before, after })
    expect(r.statusCode, r.body).toBe(status); expect(r.json<{ error: { code: string } }>().error.code).toBe(code); expect(after).toEqual(before)
    return r
  }
  async scope(f: Case, deal: string) {
    return (await this.db.query<Record<string, unknown>>(`select v.id,v.wedding_id,v.deal_id,v.slot_id,v.revision::text,
      v.previous_version_id,v.origin_knowledge,v.operation,v.context_kind,v.event_id,v.performer_kind,v.vendor_id,
      v.binding_state,v.service_date::text,v.time_zone,v.day_id,h.current_version_id=v.id exact_head,
      deal_day_scope_matches_current(v) matches_current from deal_day_scope_heads h
      join deal_day_scope_versions v on v.id=h.current_version_id and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id
      where h.wedding_id=$1 and h.deal_id=$2`, [f.wedding, deal])).rows
  }
  async acquired(f: Case, response: Reply, performer: 'catalog' | 'external' = 'catalog') {
    const rows = (await this.db.query<{ id: string }>('select id from deals where wedding_id=$1 and slot_id=$2 order by id', [f.wedding, f.slot])).rows
    const scopes = rows.length === 1 ? await this.scope(f, rows[0]!.id) : []
    witness('ACQUIRE', { fixture: { wedding: f.wedding, slot: f.slot, event: f.event }, status: response.statusCode, body: response.body, rows, scopes, state: await this.snapshot(f) })
    expect(response.statusCode, response.body).toBe(200); expect(rows).toHaveLength(1)
    const deal = rows[0]!.id, scope = scopes[0]!
    expect(scopes).toHaveLength(1); expect(scope).toMatchObject({ wedding_id: f.wedding, deal_id: deal, slot_id: f.slot,
      revision: '1', previous_version_id: null, origin_knowledge: 'observed_tracking', operation: 'acquire',
      context_kind: 'explicit_event', event_id: f.event.id, performer_kind: performer, vendor_id: performer === 'catalog' ? f.company.id : null,
      binding_state: performer === 'catalog' ? 'active' : 'external', service_date: f.event.date, time_zone: f.event.timeZone,
      exact_head: true, matches_current: true })
    expect(ok<SlotReply>(response).id).toBe(f.slot)
    expect((await this.db.query('select deal_id from slots where wedding_id=$1 and id=$2', [f.wedding, f.slot])).rows).toEqual([{ deal_id: deal }])
    if (performer === 'catalog') {
      expect((await this.db.query("select id from vendor_busy_dates where vendor_id=$1 and date=$2::date and source='deal'", [f.company.id, f.event.date])).rows)
        .toEqual([{ id: scope.day_id }])
    } else expect(scope.day_id).toBeNull()
    return deal
  }
  async gate(wedding: string, mutate: (c: Queryable) => Promise<unknown> = async () => undefined) {
    let unlock!: () => void, ready!: () => void, fail!: (error: unknown) => void, pid = 0
    const began = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject }), permission = new Promise<void>(resolve => { unlock = resolve })
    const done = this.db.tx(async c => { pid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query('select id from weddings where id=$1 for update', [wedding]); ready(); await permission; await mutate(c) })
    void done.catch(fail); await began
    return { pid, unlock, done }
  }
  async blocked(holder: number, label: string) {
    let graph: { pid: number; blockers: number[]; wait_event_type: string | null; query: string }[] = [], reached: number[] = []
    const until = Date.now() + 4000
    while (Date.now() < until) {
      graph = (await this.db.query<{ pid: number; blockers: number[]; wait_event_type: string | null; query: string }>(
        'select pid,pg_blocking_pids(pid) blockers,wait_event_type,query from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()')).rows
      const known = new Set([holder]); let added = true
      while (added) { added = false; for (const row of graph) if (!known.has(row.pid) && row.blockers.some(pid => known.has(pid))) { known.add(row.pid); added = true } }
      reached = graph.filter(row => row.pid !== holder && known.has(row.pid) && row.wait_event_type === 'Lock').map(row => row.pid)
      if (reached.length) break
      await new Promise<void>(resolve => setTimeout(resolve, 15))
    }
    witness('PG_WAIT', { label, holder, reached, graph, activityRowsOneQuery: true, wholeDatabaseSnapshot: false })
    assert(reached.length > 0, 'Actual Lock edge to recorded own holder required')
  }
}
