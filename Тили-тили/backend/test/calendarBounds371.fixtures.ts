import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { expect } from 'vitest'
import { SignJWT, decodeJwt } from 'jose'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import type { OrderActor } from '../src/orders/context.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'
import type { CalendarBoundsPrivateView, CalendarBoundsProposalBody, CalendarBoundsSpanInput,
  CalendarBoundsSourceList, CalendarBoundsActivateBody } from '../src/resources/legacy-calendar.js'

export const POLICY = '2026-09-02'
export const SECRET = 'calendar371-synthetic-access-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
export type Reply = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }
export type Actor = { id: string; sid: string; token: string }
export type Company = { id: string; owner: Actor }
export type Cohort = { pair: Actor; company: Company; wedding: string; slots: string[]; deals: string[]; date: string | null }
export type ResourceKind = 'capacity' | 'equipment' | 'person'
export type Ready = { company: Company; pair: Actor; wedding: string; deal: string; resource: string; window: string | null;
  termsReadToken: string; body: Record<string, unknown> }
type Raw = Record<string, string[]>
export const coverage = () => ({ preparation: true as const, travel: true as const, handover: true as const,
  returns: true as const, remainingWork: true as const })
export function span(overrides: Partial<CalendarBoundsSpanInput> = {}): CalendarBoundsSpanInput {
  return { spanMode: 'explicit', timeZone: 'Europe/Berlin', localStartsAt: '2027-07-01T10:00:00',
    localEndsAt: '2027-07-01T12:00:00', startsAt: '2027-07-01T08:00:00Z', endsAt: '2027-07-01T10:00:00Z', coverage: coverage(), ...overrides }
}
export function ok<T>(reply: Reply, label: string): T {
  let code = '', message = ''
  if (reply.statusCode !== 200) { try { const error = reply.json<{ error?: { code?: string; message?: string } }>().error; code = error?.code ?? ''; message = error?.message ?? '' } catch { code = 'non-json' } }
  assert.equal(reply.statusCode, 200, `SETUP_371 ${label}: HTTP${reply.statusCode}/${code}/${message}; this is not the domain RED`)
  return reply.json<T>()
}
export function denied(reply: Reply, status: number, code?: string): void {
  expect(reply.statusCode).toBe(status)
  if (code) expect(reply.json<{ error: { code: string } }>().error.code).toBe(code)
}

/** Owned fixture data is intentionally retained for Root raw inspection/cleanup.
 * Accepted manual certificates and stable keys must not be erased by an ad-hoc test teardown.
 * close() closes this app/pool and emits IDs only, never JWTs or secrets. */
export class Calendar371Fixture {
  app!: FastifyInstance
  readonly users = new Set<string>(); readonly vendors = new Set<string>(); readonly weddings = new Set<string>()
  readonly resources = new Set<string>(); readonly sources = new Set<string>()
  private readonly couples = new Map<string, Actor>()
  private readonly prefix = String(randomInt(10_000, 99_999)); private sequence = 0
  get db() { return this.app.db! }
  actorInput(a: Actor): OrderActor { return { userId: a.id, sessionId: a.sid, policyVersion: POLICY } }
  async open(): Promise<void> {
    const database = process.env.TEST_DATABASE_URL
    assert(database && process.env.DATABASE_URL === database, 'SETUP_371: explicit equal guarded test database URLs required')
    const target = new URL(database)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, '15432'); assert.equal(target.username, 'codex_test')
    assert.equal(target.pathname, '/tili_ecosystem_full_20260930_test'); assert.equal(target.search, ''); assert.equal(target.hash, '')
    this.app = await buildApp({ env: 'test', databaseUrl: database, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'calendar371-synthetic-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await this.app.ready()
    const live = (await this.db.query<{ address: string; port: number; name: string; principal: string; data: string }>(
      "select host(inet_server_addr()) address,inet_server_port() port,current_database() name,current_user principal,current_setting('data_directory') data")).rows[0]!
    assert(['127.0.0.1', '::1'].includes(live.address)); assert.equal(live.port, 15432)
    assert.equal(live.name, 'tili_ecosystem_full_20260930_test'); assert.equal(live.principal, 'codex_test')
    if (process.platform === 'win32') assert(live.data.replaceAll('\\', '/').toLowerCase().endsWith('/tili-calendar371-consents-20261025-pg'), 'SETUP_371: Root registered fresh data directory only')
    else assert.equal(process.env.CI, 'true', 'SETUP_371: non-Windows execution requires the owned CI disposable environment')
    const journal = (await this.db.query<{ name: string }>('select name from pgmigrations order by id')).rows
    assert.equal(journal.length, 94, 'SETUP_371: schema94 required, missing DDL is not domain RED')
    assert.equal(journal.at(-1)!.name, '1763920000000_legacy_calendar_bounds')
    const categories = (await this.db.query("select id from categories where id in ('florist','decor')")).rows
    assert.equal(categories.length, 2, 'SETUP_371: canonical fixture categories required')
  }
  async close(): Promise<void> {
    if (!this.app) return
    try {
      process.stdout.write(`CALENDAR371_OWN_FIXTURE ${JSON.stringify({ retainedForRoot: true, users: [...this.users],
        vendors: [...this.vendors], weddings: [...this.weddings], resources: [...this.resources], sources: [...this.sources] })}\n`)
    } finally { await this.app.close() }
  }
  async actor(existingId?: string): Promise<Actor> {
    const id = existingId ?? randomUUID(), sid = randomUUID()
    if (!existingId) {
      this.users.add(id)
      await this.db.query("insert into users(id,phone,name) values($1,$2,'Synthetic full371 actor')", [id, `+79${this.prefix}${String(++this.sequence).padStart(4, '0')}`])
      await this.db.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    }
    await this.db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    return { id, sid, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  async call(a: Actor, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, key: string | null = randomUUID()): Promise<Reply> {
    const started = performance.now()
    const reply = await this.app.inject({ method, url, headers: { authorization: `Bearer ${a.token}`,
      ...(method !== 'GET' && key !== null ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload }) })
    process.stdout.write(`CALENDAR371_HTTP ${JSON.stringify({ method, url, status: reply.statusCode, milliseconds: Math.round(performance.now() - started) })}\n`)
    return reply
  }
  async company(owner?: Actor): Promise<Company> {
    const actualOwner = owner ?? await this.actor(), id = randomUUID(); this.vendors.add(id)
    await this.db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic full371 studio',now())", [id, actualOwner.id])
    return { id, owner: actualOwner }
  }
  async wedding(pair: Actor, date: string | null = '2027-07-01', tz = 'Europe/Berlin'): Promise<{ id: string; slot: string }> {
    const id = randomUUID(), slot = randomUUID(); this.weddings.add(id); this.couples.set(id, pair)
    await this.db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic full371 wedding',$3,$4,$5)", [id, pair.id, date, tz, randomUUID()])
    await this.db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [id, pair.id])
    await this.db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Synthetic full371 position')", [slot, id])
    return { id, slot }
  }
  async cohort(count = 2, date: string | null = '2027-07-01', samePerson = false, state: 'booked' | 'negotiating' = 'booked'): Promise<Cohort> {
    const pair = await this.actor(), company = await this.company(samePerson ? pair : await this.actor())
    const w = await this.wedding(pair, date), slots = [w.slot], deals: string[] = []
    for (let i = 0; i < count; i++) {
      if (i) { const id = randomUUID(); slots.push(id); await this.db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'decor','Second actual holder')", [id, w.id]) }
      if (date === null) {
        const id = randomUUID()
        await this.db.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'contacted',15000)", [id, w.id, slots[i], company.id])
        await this.db.query('update slots set deal_id=$2 where id=$1', [slots[i], id])
        ok(await this.call(pair, 'PATCH', `/deals/${id}`, { state }), 'legacy ledgerless public transition'); deals.push(id)
      } else {
        const reply = ok<{ deal: { id: string } }>(await this.call(pair, 'POST', `/weddings/${w.id}/slots/${slots[i]}/book`,
          { vendorId: company.id, price: { amount: 15000, currency: 'RUB' } }), 'genuine legacy book before resources mode')
        deals.push(reply.deal.id)
      }
    }
    // Nonzero, valid historical money/due-date witnesses, not calendar consents.
    await this.db.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',777,'recorded','cash','private')", [randomUUID(), deals[0]])
    await this.db.query("insert into payment_installments(id,deal_id,title,amount,due) values($1,$2,'Actual unchanged dated obligation',10000,'2027-09-13')", [randomUUID(), deals[0]])
    return { pair, company, wedding: w.id, slots, deals, date }
  }
  ownerUrl(c: Company, source: string): string { return `/vendors/${c.id}/legacy-calendar/sources/${source}` }
  holderUrl(wedding: string, deal: string, source: string): string { return `/weddings/${wedding}/deals/${deal}/legacy-calendar/${source}` }
  async list(c: Company): Promise<CalendarBoundsSourceList> {
    return ok(await this.call(c.owner, 'GET', `/vendors/${c.id}/legacy-calendar/sources`), 'registered owner source list')
  }
  async liveSources(c: Company): Promise<{ id: string; kind: string }[]> {
    return (await this.db.query<{ id: string; kind: string }>(
      'select id::text,kind from legacy_calendar_sources s where vendor_id=$1 and legacy_calendar_present(s) order by id', [c.id])).rows
  }
  async editor(c: Company, source: string): Promise<CalendarBoundsPrivateView> {
    this.sources.add(source)
    return ok(await this.call(c.owner, 'GET', this.ownerUrl(c, source)), 'registered owner editor')
  }
  async capture(c: Company, source: string): Promise<CalendarBoundsPrivateView> {
    const e = await this.editor(c, source)
    return ok(await this.call(c.owner, 'POST', this.ownerUrl(c, source) + '/capture', {
      expectedSourceRevision: e.source.sourceRevision, expectedInventoryRevision: e.source.inventoryRevision }), 'technical inventory capture')
  }
  declaration(e: CalendarBoundsPrivateView, spans = [span()], outcome: 'finite' | 'calendar_closed' = 'finite'): CalendarBoundsProposalBody {
    assert(e.editor, 'SETUP_371: owner editor material is required')
    const copySpans = () => spans.map(s => ({ ...s, coverage: { ...s.coverage } }))
    return { expectedSourceRevision: e.source.sourceRevision, expectedInventoryRevision: e.source.inventoryRevision,
      expectedHeadRevision: e.source.headRevision, expectedSourceFingerprint: e.editor.sourceFingerprint,
      holders: e.editor.holders.map(h => ({ weddingId: h.weddingId, dealId: h.dealId, expectedOrderVersion: h.orderVersion,
        outcome, closureReason: outcome === 'calendar_closed' ? 'no_remaining_calendar_engagement' : null, spans: copySpans() })),
      manualBounds: e.source.kind === 'manual_day' ? { outcome, closureReason: outcome === 'calendar_closed' ? 'no_remaining_calendar_engagement' : null, spans: copySpans() } : null,
      staffing: { completeness: 'declared_complete', personIds: e.editor.knownPersons.map(p => p.id).sort() } }
  }
  async propose(c: Company, source: string, spans = [span()], outcome: 'finite' | 'calendar_closed' = 'finite'): Promise<CalendarBoundsPrivateView> {
    const e = await this.capture(c, source)
    return ok(await this.call(c.owner, 'POST', this.ownerUrl(c, source) + '/proposals', this.declaration(e, spans, outcome)), 'registered bounds proposal')
  }
  async read(a: Actor, wedding: string, deal: string, source: string, version?: string): Promise<CalendarBoundsPrivateView> {
    return ok(await this.call(a, 'GET', this.holderUrl(wedding, deal, source) + (version ? `?boundsVersionId=${version}` : '')), 'deliberate private holder read')
  }
  async accept(a: Actor, wedding: string, deal: string, source: string, key?: string): Promise<CalendarBoundsPrivateView> {
    const read = await this.read(a, wedding, deal, source)
    assert(read.proposal && read.readToken, 'SETUP_371: genuine current GET must issue read proof')
    return ok(await this.call(a, 'POST', this.holderUrl(wedding, deal, source) + '/accept', { boundsVersionId: read.proposal.id,
      expectedVersion: read.proposal.version, digest: read.proposal.digest, readToken: read.readToken }, key), 'genuine public accept')
  }
  async agree(c: Company, source: string): Promise<void> {
    const e = await this.editor(c, source); assert(e.proposal?.holders)
    for (const h of e.proposal.holders) {
      const pair = this.couples.get(h.weddingId); assert(pair, 'SETUP_371: actual owned holder customer required')
      await this.accept(pair, h.weddingId, h.dealId, source)
      await this.accept(c.owner, h.weddingId, h.dealId, source)
    }
  }
  activation(e: CalendarBoundsPrivateView): CalendarBoundsActivateBody {
    assert(e.proposal && e.editor)
    return { boundsVersionId: e.proposal.id, expectedHeadRevision: e.source.headRevision,
      expectedSourceFingerprint: e.editor.sourceFingerprint, digest: e.proposal.digest }
  }
  async activate(c: Company, source: string): Promise<CalendarBoundsPrivateView> {
    const e = await this.editor(c, source)
    const applied = ok<CalendarBoundsPrivateView>(await this.call(c.owner, 'POST', this.ownerUrl(c, source) + '/activate', this.activation(e)), 'separate public whole-source activation')
    assert.equal(applied.source.freshness, 'current', 'SETUP_371: native effect must actually be current before domain RED')
    assert.notEqual(applied.source.state, 'unresolved', 'SETUP_371: HTTP200 alone is not whole-source activation evidence')
    assert.equal(applied.source.effectiveVersionId, e.proposal!.id, 'SETUP_371: native effective head must select this exact proposal')
    return applied
  }
  async settleAll(c: Company, spans = [span()]): Promise<string[]> {
    const sources = await this.liveSources(c); assert(sources.length, 'SETUP_371: real legacy source required')
    for (const s of sources) { await this.propose(c, s.id, spans); await this.agree(c, s.id); await this.activate(c, s.id) }
    return sources.map(s => s.id)
  }
  async addPart(c: Cohort, dueAt: string): Promise<void> {
    const order = ok<{ version: string }>(await this.call(c.company.owner, 'GET', `/deals/${c.deals[0]}/order`), 'current order')
    ok(await this.call(c.company.owner, 'POST', `/deals/${c.deals[0]}/order/parts`, { expectedVersion: order.version,
      kind: 'deliverable', assignmentId: null, title: 'Actual remaining output', details: { dueAt } }), 'remaining deliverable part')
  }
  async ready(c: Company, kind: ResourceKind = 'capacity', startsAt = '2027-08-10T10:00:00Z', endsAt = '2027-08-10T11:00:00Z', person?: Actor): Promise<Ready> {
    const pair = await this.actor(), w = await this.wedding(pair, '2027-08-10', 'UTC')
    const pkg = randomUUID()
    await this.db.query("insert into vendor_packages(id,vendor_id,name,price,items) values($1,$2,'Synthetic actual package',15000,'[\"Delivery\"]'::jsonb)", [pkg, c.id])
    let member: string | undefined
    if (person && person.id !== c.owner.id) {
      const invitation = await this.db.tx(client => inviteStaff(client, { vendorId: c.id, actor: this.actorInput(c.owner), role: 'worker', targetUserId: person.id }))
      member = (await this.db.tx(client => acceptStaffInvite(client, { token: invitation.token, actor: this.actorInput(person) }))).id
    }
    const resource = ok<{ id: string }>(await this.call(c.owner, 'POST', `/vendors/${c.id}/resources`, { kind, label: 'Synthetic actual resource',
      ...(kind === 'capacity' ? { capacityUnit: 'pieces' } : {}), ...(kind === 'person' ? { personUserId: (person ?? c.owner).id, ...(member ? { staffMemberId: member } : {}) } : {}) }), 'actual resource')
    this.resources.add(resource.id)
    const window = kind === 'capacity' ? ok<{ id: string }>(await this.call(c.owner, 'POST', `/vendors/${c.id}/resources/${resource.id}/windows`,
      { startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-12-31T23:00:00Z', capacity: 10 }), 'actual capacity window').id : null
    const policy = ok<{ revision: string }>(await this.call(c.owner, 'GET', `/vendors/${c.id}/availability-policy`), 'current policy')
    const selectedPolicy = ok<{ revision: string }>(await this.call(c.owner, 'PATCH', `/vendors/${c.id}/availability-policy`,
      { mode: 'resources', expectedRevision: policy.revision }), 'resources mode after legacy bookings')
    const selected = ok<{ dealId: string; orderVersion: string }>(await this.call(pair, 'POST', `/weddings/${w.id}/slots/${w.slot}/resource-order`,
      { vendorId: c.id, packageId: pkg, expectedSelectedDealId: null, expectedPolicyRevision: selectedPolicy.revision }), 'registered resource preparation')
    const order = ok<{ version: string; parts: { id: string }[] }>(await this.call(c.owner, 'POST', `/deals/${selected.dealId}/order/parts`,
      { expectedVersion: selected.orderVersion, kind: 'deliverable', assignmentId: null, title: 'Actual prepared output', details: { dueAt: endsAt } }), 'resource order part')
    const plan = ok<{ orderVersion: string; current: { planRevisionId: string } }>(await this.call(c.owner, 'PATCH', `/deals/${selected.dealId}/order/resource-plan`,
      { expectedVersion: order.version, expectedPlanRevision: '0', lines: [{ partId: order.parts[0]!.id, resourceId: resource.id, capacityWindowId: window,
        quantity: kind === 'capacity' ? 3 : 1, startsAt, endsAt, timeZone: 'UTC', setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0 }] }), 'resource plan')
    const prior = ok<{ revision: string }>(await this.call(pair, 'GET', `/deals/${selected.dealId}/order/terms`), 'terms revision')
    ok(await this.call(pair, 'POST', `/deals/${selected.dealId}/order/terms/proposals`,
      { expectedOrderVersion: plan.orderVersion, expectedTermsRevision: prior.revision }), 'real schema2 terms proposal')
    type Terms = { selected: { id: string; version: string; digest: string }; readToken: string }
    let terms: Terms | undefined
    for (const a of [pair, c.owner]) {
      terms = ok<Terms>(await this.call(a, 'GET', `/deals/${selected.dealId}/order/terms`), 'real terms read')
      ok(await this.call(a, 'POST', `/deals/${selected.dealId}/order/terms/${terms.selected.id}/accept`,
        { expectedTermsVersion: terms.selected.version, digest: terms.selected.digest, readToken: terms.readToken }), 'real terms acceptance')
    }
    assert(terms)
    return { company: c, pair, wedding: w.id, deal: selected.dealId, resource: resource.id, window, termsReadToken: terms.readToken,
      body: { expectedOrderVersion: plan.orderVersion, expectedCommitmentRevision: '0', termsId: terms.selected.id,
        expectedTermsVersion: terms.selected.version, termsDigest: terms.selected.digest, planRevisionId: plan.current.planRevisionId,
        expectedPolicyRevision: selectedPolicy.revision } }
  }
  commit(r: Ready, key?: string): Promise<Reply> { return this.call(r.pair, 'POST', `/deals/${r.deal}/order/resource-commitments`, r.body, key) }
  async manual(c: Company, date = '2027-07-01'): Promise<string> {
    const reply = await this.call(c.owner, 'POST', '/vendor/calendar/busy', { dates: [date], status: 'busy' })
    assert.equal(reply.statusCode, 204, 'SETUP_371: genuine manual DATE write')
    const sources = await this.liveSources(c); const source = sources.find(s => s.kind === 'manual_day')
    assert(source, 'SETUP_371: actual manual source required'); return source.id
  }
  async raw(table: string, where: string, values: unknown[], client: Queryable = this.db): Promise<string[]> {
    assert(/^[a-z_][a-z0-9_]*$/.test(table))
    return (await client.query<{ raw: string }>(`select row_to_json(t)::text raw from ${table} t where ${where} order by row_to_json(t)::text`, values)).rows.map(r => r.raw)
  }
  async graph(c: Company): Promise<Raw> {
    const result: Raw = {}
    for (const table of ['legacy_calendar_bounds_versions', 'legacy_calendar_bounds_holders', 'legacy_calendar_bounds_receipts',
      'legacy_calendar_bounds_heads', 'legacy_calendar_resolution_events', 'legacy_calendar_resolution_holders']) {
      result[table] = await this.raw(table, 'source_id in(select id from legacy_calendar_sources where vendor_id=$1)', [c.id])
    }
    for (const table of ['legacy_calendar_bounds_spans', 'legacy_calendar_bounds_person_scope']) {
      result[table] = await this.raw(table, 'bounds_version_id in(select v.id from legacy_calendar_bounds_versions v join legacy_calendar_sources s on s.id=v.source_id where s.vendor_id=$1)', [c.id])
    }
    for (const table of ['resource_occupancy_origin_certificates', 'resource_occupancy', 'legacy_calendar_person_links']) result[table] = await this.raw(table, 'vendor_identity=$1', [c.id])
    return result
  }
  async finance(): Promise<Raw> {
    const names = (await this.db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname='public' and
      (tablename ~ '(payment|refund|budget|expense|estimate)' or tablename=any($1::text[])) order by tablename`,
    [['deals', 'deal_events', 'deal_orders', 'order_parts', 'order_assignments', 'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions', 'vendor_packages', 'wedding_events']])).rows
    assert(names.some(n => n.tablename === 'payments') && names.some(n => n.tablename === 'deals'))
    const result: Raw = {}; for (const { tablename } of names) result[tablename] = await this.raw(tablename, 'true', [])
    return result
  }
  async counters(c: Company): Promise<string[]> {
    return this.raw('resource_capacity_windows', 'resource_id in(select id from vendor_resources where vendor_id=$1)', [c.id])
  }
  async effectCount(c: Company): Promise<number> {
    return (await this.db.query<{ n: number }>("select count(*)::int n from legacy_calendar_resolution_events where action='activate' and source_id in(select id from legacy_calendar_sources where vendor_id=$1)", [c.id])).rows[0]!.n
  }
  async expired(realToken: string): Promise<string> {
    const body = decodeJwt(realToken)
    for (const field of ['iss', 'aud', 'iat', 'exp']) delete body[field]
    const now = (await this.db.query<{ seconds: number }>('select floor(extract(epoch from clock_timestamp()))::float8 seconds')).rows[0]!.seconds
    return new SignJWT(body).setProtectedHeader({ alg: 'HS256', typ: 'calendar-bounds-read' }).setIssuer('tili-tili').setAudience('calendar-bounds-read')
      .setIssuedAt(now - 700).setExpirationTime(now - 100).sign(createHash('sha256').update(`tili-calendar-bounds-read\n${SECRET}`).digest())
  }
}
