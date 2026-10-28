import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eraseUser, expireStaleHolds, purgeArchivedWeddings } from '../src/jobs/index.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'
import { Calendar371Fixture, denied, ok, span, type Actor, type Cohort, type Company } from './calendarBounds371.fixtures.js'

type Raw = Record<string, string[]>
type Row = Record<string, unknown>
const mutableLifecycle = new Set(['deals', 'deal_events', 'deal_orders', 'order_parts', 'order_assignments'])
const liveCertificateFields = ['live_source_id', 'live_vendor_id', 'live_bounds_version_id', 'live_activation_event_id']

/** Real jobs are global table consumers: this suite belongs in the serial lane.
 * No positive calendar receipt is inserted by SQL. Failed/accepted fixture data
 * remains owned by Root; close() only emits its manifest and closes app/pool. */
describe.sequential('FULL371 actual lifecycle jobs and retained calendar origins', { timeout: 240_000 }, () => {
  const h = new Calendar371Fixture()
  beforeAll(async () => { await h.open() }, 30_000)
  afterAll(async () => { await h.close() }, 30_000)

  async function source(c: Company, kind: string): Promise<string> {
    const row = (await h.liveSources(c)).find(s => s.kind === kind)
    assert(row, `SETUP_371: actual ${kind} source required`)
    return row.id
  }
  async function dates(includeHistory = false): Promise<Raw> {
    const result: Raw = { weddings: await h.raw('weddings', 'true', []),
      events: await h.raw('wedding_events', 'true', []),
      days: await h.raw('vendor_busy_dates', 'true', []) }
    if (includeHistory) for (const table of ['deal_day_scope_versions', 'deal_day_scope_heads', 'legacy_day_groups']) result[table] = await h.raw(table, 'true', [])
    return result
  }
  async function money(): Promise<Raw> {
    // Lifecycle is allowed to change only the explicitly asserted financial
    // root/event/draft state. All other discovered economic rows stay literal.
    const result: Raw = Object.fromEntries(Object.entries(await h.finance()).filter(([name]) => !mutableLifecycle.has(name)))
    result.deal_economics = without(await h.raw('deals', 'true', []),
      ['state', 'cancelled_at', 'cancel_reason', 'negotiating_until', 'done_at', 'booked_at']).map(row => JSON.stringify(row)).sort()
    return result
  }
  async function cohortFinance(c: Cohort): Promise<Raw> {
    // Follow stored FK-shaped identities inside the existing economic snapshot,
    // including payment/receipt/correction children, without guessing their data.
    const snapshot = await h.finance()
    const all = Object.entries(snapshot).flatMap(([table, rows]) => rows.map(raw => ({ table, raw, row: JSON.parse(raw) as Row })))
    const ids = new Set([c.wedding, c.company.id, ...c.deals]), selected = new Set<typeof all[number]>()
    let changed = true
    while (changed) {
      changed = false
      for (const item of all) if (!selected.has(item) && Object.entries(item.row).some(([key, value]) =>
        (key === 'id' || key.endsWith('_id')) && typeof value === 'string' && ids.has(value))) {
        selected.add(item); if (typeof item.row.id === 'string') ids.add(item.row.id); changed = true
      }
    }
    return Object.fromEntries(Object.keys(snapshot).map(table => [table, [...selected].filter(item => item.table === table).map(item => item.raw).sort()]))
  }
  async function immutableHistory(c: Company): Promise<Raw> {
    const result: Raw = {}
    for (const table of ['legacy_calendar_bounds_versions', 'legacy_calendar_bounds_holders', 'legacy_calendar_bounds_receipts']) {
      result[table] = await h.raw(table, 'source_id in(select id from legacy_calendar_sources where vendor_id=$1)', [c.id])
    }
    for (const table of ['legacy_calendar_bounds_spans', 'legacy_calendar_bounds_person_scope']) {
      result[table] = await h.raw(table, 'bounds_version_id in(select id from legacy_calendar_bounds_versions where source_id in(select id from legacy_calendar_sources where vendor_id=$1))', [c.id])
    }
    return result
  }
  async function settle(c: Company, manualDay?: string): Promise<string[]> {
    const before = { finance: await h.finance(), dates: await dates(true), counters: await h.counters(c) }
    const sources = await h.liveSources(c); assert(sources.length)
    for (const s of sources) {
      const spans = s.kind === 'manual_day' && manualDay ? [span({ localStartsAt: `${manualDay}T10:00:00`,
        localEndsAt: `${manualDay}T12:00:00`, startsAt: `${manualDay}T08:00:00Z`, endsAt: `${manualDay}T10:00:00Z` })] : [span()]
      await h.propose(c, s.id, spans); await h.agree(c, s.id); await h.activate(c, s.id)
    }
    expect(await h.finance()).toEqual(before.finance)
    expect(await dates(true)).toEqual(before.dates)
    expect(await h.counters(c)).toEqual(before.counters)
    return sources.map(s => s.id)
  }
  async function manualProof(c: Company, day = '2027-07-01'): Promise<string> {
    const id = await h.manual(c, day)
    const before = { finance: await h.finance(), dates: await dates(true) }
    await h.propose(c, id); const applied = await h.activate(c, id)
    expect(applied.readiness.requiredReceipts).toBe(0)
    expect(await h.finance()).toEqual(before.finance); expect(await dates(true)).toEqual(before.dates)
    expect(await h.raw('legacy_calendar_bounds_receipts', 'source_id=$1', [id])).toEqual([])
    return id
  }
  async function certificates(c: Company, stable = false, scope?: 'app' | 'manual'): Promise<string[]> {
    const fields = stable ? `(to_jsonb(t)-${liveCertificateFields.map(f => `'${f}'`).join('-')})::text` : 'row_to_json(t)::text'
    return (await h.db.query<{ raw: string }>(`select ${fields} raw from resource_occupancy_origin_certificates t
      where vendor_identity=$1 and ($2::text is null or scope_kind=$2) order by id`, [c.id, scope ?? null])).rows.map(r => r.raw)
  }
  async function occupancy(c: Company): Promise<string[]> { return h.raw('resource_occupancy', 'vendor_identity=$1', [c.id]) }
  async function dealOrigins(wedding: string, deal: string): Promise<string[]> {
    // Select actual stored certificate lines by their recorded holder identity;
    // no production material constructor supplies the expected result.
    return (await h.db.query<{ id: string }>(`select o.id from resource_occupancy o
      join resource_occupancy_origin_certificates c on c.id=o.certificate_id
      where exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'lines') line
        join jsonb_array_elements(c.canonical::jsonb->'ranges') r on r->'ownerKey'=line->'ownerKey'
        where (line->>'lineIndex')::int=o.origin_line_index and r->>'weddingId'=$1 and r->>'dealId'=$2)
      order by o.id`, [wedding, deal])).rows.map(r => r.id)
  }
  function without(raw: string[], fields: string[]): Row[] {
    return raw.map(s => { const r = JSON.parse(s) as Row; for (const field of fields) delete r[field]; return r })
  }
  async function cancel(c: Cohort, deal: string): Promise<void> {
    ok(await h.call(c.pair, 'PATCH', `/deals/${deal}`, { state: 'cancelled' }), 'actual registered cancellation')
    expect((await h.db.query<{ state: string }>('select state from deals where id=$1', [deal])).rows[0]!.state).toBe('cancelled')
  }
  async function join(c: Company, person: Actor): Promise<void> {
    const invite = await h.db.tx(client => inviteStaff(client, { vendorId: c.id, actor: h.actorInput(c.owner), role: 'worker', targetUserId: person.id }))
    const member = await h.db.tx(client => acceptStaffInvite(client, { token: invite.token, actor: h.actorInput(person) }))
    expect(member.state).toBe('active'); expect(member.userId).toBe(person.id)
  }
  async function dateAttempt(c: Company, pair: Actor, wedding: { id: string; slot: string }): Promise<void> {
    denied(await h.call(pair, 'POST', `/weddings/${wedding.id}/slots/${wedding.slot}/book`,
      { vendorId: c.id, price: { amount: 15000, currency: 'RUB' } }), 409, 'resource_booking_required')
    denied(await h.call(c.owner, 'POST', '/vendor/calendar/busy', { dates: ['2027-08-30'], status: 'busy' }), 409, 'resource_booking_required')
  }

  it('CL371-C01 actual cancellation releases only its recorded holder lines, retaining sibling/manual/foreign promises and money', async () => {
    const c = await h.cohort(2), foreign = await h.company()
    await h.manual(c.company, '2027-07-02')
    const ready = await h.ready(c.company)
    await manualProof(foreign)
    await settle(c.company, '2027-07-02')
    const own = await dealOrigins(c.wedding, c.deals[0]!), survivor = await dealOrigins(c.wedding, c.deals[1]!)
    expect(own.length).toBeGreaterThan(0); expect(survivor.length).toBeGreaterThan(0)
    const before = { own: await h.raw('resource_occupancy', 'id=any($1::uuid[])', [own]),
      other: await h.raw('resource_occupancy', 'not(id=any($1::uuid[]))', [own]),
      history: await immutableHistory(c.company), foreign: await h.graph(foreign), money: await money(),
      wedding: await h.raw('weddings', 'id=$1', [c.wedding]), events: await h.raw('wedding_events', 'wedding_id=$1', [c.wedding]),
      counters: await h.counters(c.company), certificates: await certificates(c.company) }
    const physical = (await h.db.query<{ id: string }>("select id from vendor_busy_dates where vendor_id=$1 and date='2027-07-01' and source='deal'", [c.company.id])).rows[0]!
    await cancel(c, c.deals[0]!)
    const released = await h.raw('resource_occupancy', 'id=any($1::uuid[])', [own])
    expect(without(released, ['released_at', 'release_reason', 'release_event_id'])).toEqual(without(before.own, ['released_at', 'release_reason', 'release_event_id']))
    for (const raw of released) {
      const row = JSON.parse(raw) as Row
      expect(row.released_at).not.toBeNull(); expect(row.release_reason).toBe('holder_cancelled'); expect(typeof row.release_event_id).toBe('string')
      const event = (await h.db.query<{ action: string; material: Row }>('select action,material from legacy_calendar_resolution_events where id=$1', [row.release_event_id])).rows[0]!
      expect(event.action).toBe('holder_cancelled'); expect(event.material.dealId).toBe(c.deals[0])
    }
    expect(await h.raw('resource_occupancy', 'not(id=any($1::uuid[]))', [own])).toEqual(before.other)
    expect(await immutableHistory(c.company)).toEqual(before.history); expect(await certificates(c.company)).toEqual(before.certificates)
    expect(await h.graph(foreign)).toEqual(before.foreign)
    // The existing payment_schedule_deal_change trigger cancels this root's
    // future installments. Assert that exact lifecycle change and every other
    // financial field/row, including amounts, due dates and payments, literally.
    const afterMoney = await money(), expectedMoney = structuredClone(before.money)
    const cancelledRoot = (await h.db.query<{ cancelled_at: Date }>('select cancelled_at from deals where id=$1', [c.deals[0]])).rows[0]!
    const stages = before.money.payment_installments!.map(raw => JSON.parse(raw) as Row)
      .filter(row => row.deal_id === c.deals[0] && row.cancelled_at === null)
    expect(stages).toHaveLength(1)
    for (const oldStage of stages) {
      const raw = afterMoney.payment_installments!.find(value => (JSON.parse(value) as Row).id === oldStage.id)!
      expect(raw).toBeTypeOf('string'); const now = JSON.parse(raw) as Row
      expect(without([raw], ['cancelled_at', 'cancel_reason', 'version', 'updated_at']))
        .toEqual(without([JSON.stringify(oldStage)], ['cancelled_at', 'cancel_reason', 'version', 'updated_at']))
      expect(now.version).toBe(Number(oldStage.version) + 1); expect(now.cancel_reason).toBe('Сделка отменена')
      expect(new Date(String(now.cancelled_at)).toISOString()).toBe(cancelledRoot.cancelled_at.toISOString())
      expect(now.updated_at).toBe(now.cancelled_at)
      const exact = (await h.db.query<{ exact: boolean }>(`select
        i.cancelled_at is not distinct from d.cancelled_at and
        i.updated_at is not distinct from d.cancelled_at as exact
        from payment_installments i join deals d on d.id=i.deal_id where i.id=$1 and d.id=$2`,
      [oldStage.id, c.deals[0]])).rows
      expect(exact).toEqual([{ exact: true }])
      expectedMoney.payment_installments = expectedMoney.payment_installments!.map(value =>
        (JSON.parse(value) as Row).id === oldStage.id ? raw : value)
    }
    expectedMoney.payment_installments!.sort()
    expect(afterMoney).toEqual(expectedMoney)
    expect(await h.raw('weddings', 'id=$1', [c.wedding])).toEqual(before.wedding)
    expect(await h.raw('wedding_events', 'wedding_id=$1', [c.wedding])).toEqual(before.events)
    expect(await h.counters(c.company)).toEqual(before.counters)
    expect((await h.db.query('select id from vendor_busy_dates where id=$1 and vendor_id=$2', [physical.id, c.company.id])).rowCount).toBe(1)
    expect((await h.db.query('select id from resource_allocations where deal_id=$1', [ready.deal])).rowCount).toBe(0)
    const appDay = await source(c.company, 'app_day')
    expect((await h.editor(c.company, appDay)).source.freshness).not.toBe('current')
  })

  it('CL371-C02 actual resource cancellation releases exactly its allocation/mirror and restores its own capacity only', async () => {
    const company = await h.company(), a = await h.ready(company), b = await h.ready(company)
    ok(await h.commit(a), 'first genuine resource commitment'); ok(await h.commit(b), 'independent genuine resource commitment')
    const allocation = (await h.db.query<{ id: string; raw: string }>('select id,row_to_json(a)::text raw from resource_allocations a where deal_id=$1 and released_at is null', [a.deal])).rows
    expect(allocation).toHaveLength(1)
    const before = { others: await h.raw('resource_allocations', 'deal_id<>$1', [a.deal]),
      mirrors: await h.raw('resource_occupancy', 'allocation_id is distinct from $1', [allocation[0]!.id]),
      money: await money(), dates: await dates(), otherWindow: await h.raw('resource_capacity_windows', 'id=$1', [b.window]) }
    const window = (await h.db.query<{ raw: Row; used: number }>('select to_jsonb(w) raw,used from resource_capacity_windows w where id=$1', [a.window])).rows[0]!
    expect(window.used).toBe(3)
    ok(await h.call(a.pair, 'PATCH', `/deals/${a.deal}`, { state: 'cancelled' }), 'public resource-root cancellation')
    const after = (await h.db.query<{ id: string; released_at: Date; release_reason: string; raw: string }>('select id,released_at,release_reason,row_to_json(a)::text raw from resource_allocations a where id=$1', [allocation[0]!.id])).rows[0]!
    expect(after.released_at).not.toBeNull(); expect(after.release_reason).toBe('deal_cancelled')
    expect(without([after.raw], ['released_at', 'release_reason'])).toEqual(without([allocation[0]!.raw], ['released_at', 'release_reason']))
    const mirror = (await h.db.query<{ released_at: Date; release_reason: string; allocation_id: string }>('select released_at,release_reason,allocation_id from resource_occupancy where allocation_id=$1', [after.id])).rows
    expect(mirror).toHaveLength(1); expect(mirror[0]!.allocation_id).toBe(after.id)
    expect(mirror[0]!.released_at.getTime()).toBe(after.released_at.getTime()); expect(mirror[0]!.release_reason).toBe(after.release_reason)
    const exactMirror = (await h.db.query<{ exact: boolean }>(`select o.origin_kind='commitment' and o.enforcement='exclusive' and o.certificate_id is null
      and row(o.origin_id,o.origin_version_id,o.origin_line_index,o.vendor_identity,o.kind,o.conflict_identity,o.resource_id,o.capacity_window_id,o.quantity,
        o.occupied_starts_at,o.occupied_ends_at,o.released_at,o.release_reason)
        is not distinct from row(a.id,a.origin_version_id,a.origin_line_index,a.vendor_id,a.kind,a.conflict_identity,a.resource_id,a.capacity_window_id,a.quantity,
        a.occupied_starts_at,a.occupied_ends_at,a.released_at,a.release_reason) as exact
      from resource_allocations a join resource_occupancy o on o.allocation_id=a.id where a.id=$1`, [after.id])).rows
    expect(exactMirror).toEqual([{ exact: true }])
    const now = (await h.db.query<{ raw: Row; used: number }>('select to_jsonb(w) raw,used from resource_capacity_windows w where id=$1', [a.window])).rows[0]!
    expect(now.used).toBe(0)
    const omitUsed = (r: Row) => { const copy = { ...r }; delete copy.used; return copy }
    expect(omitUsed(now.raw)).toEqual(omitUsed(window.raw))
    expect(await h.raw('resource_allocations', 'deal_id<>$1', [a.deal])).toEqual(before.others)
    expect(await h.raw('resource_occupancy', 'allocation_id is distinct from $1', [allocation[0]!.id])).toEqual(before.mirrors)
    expect(await h.raw('resource_capacity_windows', 'id=$1', [b.window])).toEqual(before.otherWindow)
    expect(await money()).toEqual(before.money); expect(await dates()).toEqual(before.dates)
  })

  it('CL371-E01 actual eraseUser retains a manual certificate and stable shared-person barrier after live owner/company removal', async () => {
    const company = await h.company(), other = await h.company()
    const ready = await h.ready(other, 'person', '2027-07-01T08:30:00Z', '2027-07-01T09:30:00Z', company.owner)
    await manualProof(company)
    const before = { certificate: await certificates(company, true, 'manual'), occupancy: await occupancy(company),
      money: await money(), counters: await h.counters(other), dates: await dates() }
    expect(before.certificate.length).toBeGreaterThan(0); expect(before.occupancy.length).toBeGreaterThan(0)
    await h.db.tx(client => eraseUser(client, company.owner.id))
    expect((await h.db.query('select id from users where id=$1', [company.owner.id])).rowCount).toBe(0)
    expect((await h.db.query('select id from vendors where id=$1', [company.id])).rowCount).toBe(0)
    expect(await certificates(company, true, 'manual')).toEqual(before.certificate)
    // All live manual parents follow the existing company/source cascade. The
    // independent accepted certificate and its occupancy must remain intact.
    expect(await h.raw('legacy_calendar_sources', 'company_id=$1', [company.id])).toEqual([])
    expect(await h.raw('legacy_calendar_bounds_versions', 'company_id=$1', [company.id])).toEqual([])
    const retained = (await h.db.query<Row>(`select live_source_id,live_vendor_id,live_bounds_version_id,live_activation_event_id
      from resource_occupancy_origin_certificates where vendor_identity=$1 and scope_kind='manual'`, [company.id])).rows
    expect(retained).toHaveLength(before.certificate.length)
    for (const row of retained) expect(row).toEqual(Object.fromEntries(liveCertificateFields.map(field => [field, null])))
    expect((await h.db.query(`select e.id from legacy_calendar_resolution_events e
      left join legacy_calendar_sources s on s.id=e.source_id where s.id is null`)).rows).toEqual([])
    expect(await occupancy(company)).toEqual(before.occupancy)
    expect((await h.db.query("select identity from resource_conflict_keys where kind='person' and identity=$1", [company.owner.id])).rowCount).toBe(1)
    const resource = (await h.db.query<{ conflict_identity: string; person_user_id: string | null }>('select conflict_identity,person_user_id from vendor_resources where id=$1', [ready.resource])).rows[0]!
    expect(resource.conflict_identity).toBe(company.owner.id); expect(resource.person_user_id).toBeNull()
    // The person is now unavailable as a live resource; this cannot establish
    // a specific overlap error. Stored old barrier equality is the native oracle.
    denied(await h.commit(ready), 409)
    expect(await occupancy(company)).toEqual(before.occupancy)
    expect(await money()).toEqual(before.money); expect(await h.counters(other)).toEqual(before.counters)
    expect((await dates()).weddings).toEqual(before.dates.weddings); expect((await dates()).events).toEqual(before.dates.events)
    expect((await h.db.query('select id from resource_allocations where deal_id=$1', [ready.deal])).rowCount).toBe(0)
  })

  it('CL371-E02 actual owner erasure keeps app history with its living wedding and only nulls erased FK attribution', async () => {
    const c = await h.cohort(1); const ids = await settle(c.company)
    const sessions = (await h.db.query<{ id: string }>('select id::text from sessions where user_id=$1', [c.company.owner.id])).rows.map(r => r.id)
    expect(sessions).toContain(c.company.owner.sid)
    async function history(): Promise<Raw> {
      const graph = await h.graph(c.company), result: Raw = {}
      for (const [table, rows] of Object.entries(graph)) if (table.startsWith('legacy_calendar_')) result[table] = rows
      for (const table of ['legacy_calendar_sources', 'legacy_calendar_versions', 'legacy_calendar_version_holders', 'legacy_calendar_heads']) {
        result[table] = await h.raw(table, table === 'legacy_calendar_sources' ? 'id=any($1::uuid[])' : 'source_id=any($1::uuid[])', [ids])
      }
      return result
    }
    const before = { history: await history(), certificate: await h.raw('resource_occupancy_origin_certificates', 'app_wedding_id=$1', [c.wedding]),
      occupancy: await occupancy(c.company), deals: await h.raw('deals', 'wedding_id=$1', [c.wedding]),
      payments: await h.raw('payments', 'deal_id=any($1::uuid[])', [c.deals]), due: await h.raw('payment_installments', 'deal_id=any($1::uuid[])', [c.deals]),
      wedding: await h.raw('weddings', 'id=$1', [c.wedding]) }
    expect(before.certificate.length).toBeGreaterThan(0); expect(before.occupancy.length).toBeGreaterThan(0)
    expect(before.history.legacy_calendar_bounds_receipts).toHaveLength(ids.length * 2)
    expect(before.payments).toHaveLength(1); expect(before.due).toHaveLength(1)
    const parse = (rows: string[]) => rows.map(raw => JSON.parse(raw) as Row)
    const sort = (rows: Row[]) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const expectedHistory: Record<string, Row[]> = {}
    for (const [table, rows] of Object.entries(before.history)) expectedHistory[table] = sort(parse(rows).map(row => {
      const expected = { ...row }
      // These nullable FKs alone may lose exactly this erased actor/session.
      // Canonical strings, claims, IDs, hashes and every other party remain exact.
      for (const field of ['created_by', 'captured_by', 'actor_id', 'user_id']) if (expected[field] === c.company.owner.id) expected[field] = null
      for (const field of ['created_session_id', 'session_id']) if (typeof expected[field] === 'string' && sessions.includes(expected[field] as string)) expected[field] = null
      return expected
    }))
    await h.db.tx(client => eraseUser(client, c.company.owner.id))
    expect((await h.db.query('select id from users where id=$1', [c.company.owner.id])).rowCount).toBe(0)
    expect((await h.db.query('select id from vendors where id=$1', [c.company.id])).rowCount).toBe(0)
    expect(await h.raw('weddings', 'id=$1', [c.wedding])).toEqual(before.wedding)
    const afterHistory = await history()
    expect(Object.keys(afterHistory).sort()).toEqual(Object.keys(before.history).sort())
    for (const [table, rows] of Object.entries(afterHistory)) expect(sort(parse(rows)), table).toStrictEqual(expectedHistory[table])
    const expectedCertificates = parse(before.certificate).map(row => ({ ...row, live_vendor_id: null }))
    expect(sort(parse(await h.raw('resource_occupancy_origin_certificates', 'app_wedding_id=$1', [c.wedding])))).toStrictEqual(sort(expectedCertificates))
    expect(await occupancy(c.company)).toEqual(before.occupancy)
    expect(sort(parse(await h.raw('deals', 'wedding_id=$1', [c.wedding])))).toStrictEqual(sort(parse(before.deals).map(row => ({ ...row, vendor_id: null, external_name: 'Удалённый подрядчик' }))))
    expect(await h.raw('payments', 'deal_id=any($1::uuid[])', [c.deals])).toEqual(before.payments)
    expect(await h.raw('payment_installments', 'deal_id=any($1::uuid[])', [c.deals])).toEqual(before.due)
  })

  it('CL371-P01 actual archived-wedding purge cascades only its own app history after releases and keeps manual/foreign promises', async () => {
    const c = await h.cohort(1), foreign = await h.cohort(1)
    await h.manual(c.company, '2027-07-02'); await settle(c.company, '2027-07-02'); await settle(foreign.company)
    const ownApp = (await h.liveSources(c.company)).filter(s => s.kind === 'app_day' || s.kind === 'app_root').map(s => s.id)
    expect(ownApp.length).toBeGreaterThan(0)
    expect((await h.db.query('select id from resource_occupancy_origin_certificates where app_wedding_id=$1', [c.wedding])).rowCount).toBeGreaterThan(0)
    const cancelled = ok<{ state: string }>(await h.call(c.pair, 'POST', `/weddings/${c.wedding}/cancel`), 'actual public wedding cancellation')
    expect(cancelled.state).toBe('cancelled')
    // SYNTHETIC_OLD_JOBS_SETUP: only advance this owned already-cancelled
    // archive beyond the real configured TTL; do not fake consent or release.
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { weddingIds: [c.wedding], mode: 'erase' })
      await client.query("update weddings set archived_at=clock_timestamp()-make_interval(days=>$2) where id=$1 and cancelled_at is not null", [c.wedding, h.app.appConfig.weddingArchiveDays + 1])
    })
    const before = { manual: await certificates(c.company, true, 'manual'),
      manualOccupancy: await h.raw('resource_occupancy', "certificate_id in(select id from resource_occupancy_origin_certificates where vendor_identity=$1 and scope_kind='manual')", [c.company.id]),
      foreign: await h.graph(foreign.company), foreignFinance: await cohortFinance(foreign), foreignMoney: await h.raw('payments', 'deal_id=any($1::uuid[])', [foreign.deals]),
      foreignDue: await h.raw('payment_installments', 'deal_id=any($1::uuid[])', [foreign.deals]),
      foreignDays: await h.raw('vendor_busy_dates', 'vendor_id=$1', [foreign.company.id]), counters: await h.counters(c.company) }
    expect(before.manual.length).toBeGreaterThan(0); expect(before.foreignMoney).toHaveLength(1); expect(before.foreignDue).toHaveLength(1)
    expect(await purgeArchivedWeddings(h.app)).toBeGreaterThanOrEqual(1)
    expect((await h.db.query('select id from weddings where id=$1', [c.wedding])).rowCount).toBe(0)
    expect((await h.db.query('select id from deals where wedding_id=$1', [c.wedding])).rowCount).toBe(0)
    expect((await h.db.query('select id from resource_occupancy_origin_certificates where app_wedding_id=$1', [c.wedding])).rowCount).toBe(0)
    expect(await h.raw('legacy_calendar_bounds_versions', 'source_id=any($1::uuid[])', [ownApp])).toEqual([])
    expect(await h.raw('legacy_calendar_bounds_receipts', 'source_id=any($1::uuid[])', [ownApp])).toEqual([])
    expect(await certificates(c.company, true, 'manual')).toEqual(before.manual)
    expect(await h.raw('resource_occupancy', "certificate_id in(select id from resource_occupancy_origin_certificates where vendor_identity=$1 and scope_kind='manual')", [c.company.id])).toEqual(before.manualOccupancy)
    expect(await h.graph(foreign.company)).toEqual(before.foreign)
    expect(await cohortFinance(foreign)).toEqual(before.foreignFinance)
    expect(await h.raw('payments', 'deal_id=any($1::uuid[])', [foreign.deals])).toEqual(before.foreignMoney)
    expect(await h.raw('payment_installments', 'deal_id=any($1::uuid[])', [foreign.deals])).toEqual(before.foreignDue)
    expect(await h.raw('vendor_busy_dates', 'vendor_id=$1', [foreign.company.id])).toEqual(before.foreignDays)
    expect(await h.counters(c.company)).toEqual(before.counters)
    const audit = await h.raw('audit_log', "entity_id=$1 and action='wedding.purged'", [c.wedding])
    expect(audit).toHaveLength(1); expect((JSON.parse(audit[0]!) as Row).actor_id).toBeNull()
    await purgeArchivedWeddings(h.app)
    expect(await h.raw('audit_log', "entity_id=$1 and action='wedding.purged'", [c.wedding])).toEqual(audit)
  })

  it('CL371-P02 the real purge job cannot delete a newly cancelled archive before its configured TTL', async () => {
    const c = await h.cohort(1); await settle(c.company)
    ok(await h.call(c.pair, 'POST', `/weddings/${c.wedding}/cancel`), 'actual newly archived wedding')
    const before = { wedding: await h.raw('weddings', 'id=$1', [c.wedding]), graph: await h.graph(c.company), money: await money() }
    await purgeArchivedWeddings(h.app)
    expect(await h.raw('weddings', 'id=$1', [c.wedding])).toEqual(before.wedding)
    expect(await h.graph(c.company)).toEqual(before.graph); expect(await money()).toEqual(before.money)
    expect(await h.raw('audit_log', "entity_id=$1 and action='wedding.purged'", [c.wedding])).toEqual([])
  })

  it.each(['scheduled-job', 'lazy-public-slots'] as const)('CL371-H01 %s really expires a pending negotiation once and invalidates its old public proof without deleting history', async path => {
    const c = await h.cohort(1, null, false, 'negotiating'), id = await source(c.company, 'live_negotiation')
    await h.propose(c.company, id); await h.accept(c.pair, c.wedding, c.deals[0]!, id)
    const pending = await h.read(c.company.owner, c.wedding, c.deals[0]!, id)
    assert(pending.proposal && pending.readToken)
    const before = { history: await immutableHistory(c.company), money: await money(), dates: await dates() }
    // SYNTHETIC_OLD_JOBS_SETUP: expire the owned real public hold's clock only.
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { weddingIds: [c.wedding] })
      await client.query("update deals set negotiating_until=clock_timestamp()-interval '1 second' where id=$1 and state='negotiating'", [c.deals[0]])
    })
    const expire = async () => {
      if (path === 'scheduled-job') await expireStaleHolds(h.app)
      else ok(await h.call(c.pair, 'GET', `/weddings/${c.wedding}/slots`), 'real lazy expiry public reader')
    }
    await expire()
    expect((await h.db.query<{ state: string; negotiating_until: Date | null }>('select state,negotiating_until from deals where id=$1', [c.deals[0]])).rows[0]).toEqual({ state: 'candidate', negotiating_until: null })
    const events = await h.raw('deal_events', "deal_id=$1 and from_state='negotiating' and to_state='candidate'", [c.deals[0]])
    expect(events).toHaveLength(1)
    await expire(); expect(await h.raw('deal_events', "deal_id=$1 and from_state='negotiating' and to_state='candidate'", [c.deals[0]])).toEqual(events)
    denied(await h.call(c.company.owner, 'POST', h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept', {
      boundsVersionId: pending.proposal.id, expectedVersion: pending.proposal.version, digest: pending.proposal.digest, readToken: pending.readToken }), 409)
    expect(await immutableHistory(c.company)).toEqual(before.history)
    expect(await h.effectCount(c.company)).toBe(0); expect(await occupancy(c.company)).toEqual([])
    expect(await money()).toEqual(before.money); expect(await dates()).toEqual(before.dates)
    const editor = await h.editor(c.company, id); expect(editor.source.freshness).toBe('unavailable'); expect(editor.readToken).toBeNull()
  })

  it('CL371-H02 the actual expiry job makes accepted negotiation bounds unavailable but never releases their promised periods', async () => {
    const c = await h.cohort(1, null, false, 'negotiating'), id = await source(c.company, 'live_negotiation')
    await settle(c.company)
    const before = { history: await immutableHistory(c.company), certificate: await certificates(c.company), occupancy: await occupancy(c.company),
      effects: await h.effectCount(c.company), money: await money(), dates: await dates() }
    expect(before.occupancy.length).toBeGreaterThan(0)
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { weddingIds: [c.wedding] })
      await client.query("update deals set negotiating_until=clock_timestamp()-interval '1 second' where id=$1", [c.deals[0]])
    })
    await expireStaleHolds(h.app)
    expect((await h.db.query<{ state: string }>('select state from deals where id=$1', [c.deals[0]])).rows[0]!.state).toBe('candidate')
    expect((await h.editor(c.company, id)).source.freshness).toBe('unavailable')
    expect(await occupancy(c.company)).toEqual(before.occupancy); expect(await certificates(c.company)).toEqual(before.certificate)
    expect(await immutableHistory(c.company)).toEqual(before.history); expect(await h.effectCount(c.company)).toBe(before.effects)
    expect(await money()).toEqual(before.money); expect(await dates()).toEqual(before.dates)
  })

  it('CL371-D01 public done with a future output retains its old physical DAY and promise even when a sibling is cancelled', async () => {
    const c = await h.cohort(2); await h.addPart(c, '2027-07-01T09:00:00Z'); await settle(c.company)
    const own = await dealOrigins(c.wedding, c.deals[0]!); expect(own.length).toBeGreaterThan(0)
    const before = { own: await h.raw('resource_occupancy', 'id=any($1::uuid[])', [own]),
      history: await immutableHistory(c.company), money: await money(), days: await h.raw('vendor_busy_dates', 'vendor_id=$1', [c.company.id]),
      futurePart: await h.raw('order_parts', "deal_id=$1 and details->>'dueAt'='2027-07-01T09:00:00Z'", [c.deals[0]]) }
    expect(before.futurePart).toHaveLength(1)
    ok(await h.call(c.pair, 'PATCH', `/deals/${c.deals[0]}`, { state: 'done' }), 'actual terminal retention with future known output')
    expect(await h.raw('vendor_busy_dates', 'vendor_id=$1', [c.company.id])).toEqual(before.days)
    const doneHead = await h.raw('deal_day_scope_heads', 'deal_id=$1', [c.deals[0]])
    const doneVersions = await h.raw('deal_day_scope_versions', 'deal_id=$1', [c.deals[0]])
    await cancel(c, c.deals[1]!)
    expect(await h.raw('resource_occupancy', 'id=any($1::uuid[])', [own])).toEqual(before.own)
    expect(await immutableHistory(c.company)).toEqual(before.history); expect(await money()).toEqual(before.money)
    expect(await h.raw('deal_day_scope_heads', 'deal_id=$1', [c.deals[0]])).toEqual(doneHead)
    expect(await h.raw('deal_day_scope_versions', 'deal_id=$1', [c.deals[0]])).toEqual(doneVersions)
    const oldIds = before.days.map(r => (JSON.parse(r) as { id: string }).id)
    expect(await h.raw('vendor_busy_dates', 'id=any($1::uuid[])', [oldIds])).toHaveLength(oldIds.length)
    expect(await h.raw('order_parts', "deal_id=$1 and details->>'dueAt'='2027-07-01T09:00:00Z'", [c.deals[0]])).toEqual(before.futurePart)
  })

  it('CL371-M01 genuine manual free removes its physical DATE without releasing an accepted independent shared-person promise', async () => {
    const company = await h.company(), other = await h.company()
    const ready = await h.ready(other, 'person', '2027-07-01T08:30:00Z', '2027-07-01T09:30:00Z', company.owner)
    const id = await manualProof(company)
    const before = { stable: await certificates(company, true), occupancy: await occupancy(company), money: await money(), counters: await h.counters(other),
      weddings: await h.raw('weddings', 'true', []), history: await immutableHistory(company) }
    const reply = await h.call(company.owner, 'POST', '/vendor/calendar/busy', { dates: ['2027-07-01'], status: 'free' })
    expect(reply.statusCode).toBe(204)
    expect((await h.db.query("select id from vendor_busy_dates where vendor_id=$1 and date='2027-07-01' and source='manual'", [company.id])).rowCount).toBe(0)
    expect(await certificates(company, true)).toEqual(before.stable); expect(await occupancy(company)).toEqual(before.occupancy)
    // Source history may retain an unavailable live source; it must not be
    // rewritten. Certificate retention is independent of that FK choice.
    expect(await immutableHistory(company)).toEqual(before.history)
    denied(await h.commit(ready), 409, 'resource_booking_conflict')
    expect(await money()).toEqual(before.money); expect(await h.counters(other)).toEqual(before.counters)
    expect(await h.raw('weddings', 'true', [])).toEqual(before.weddings)
    expect((await h.db.query('select id from resource_allocations where deal_id=$1', [ready.deal])).rowCount).toBe(0)
    expect((await h.db.query('select id from resource_occupancy_origin_certificates where source_identity=$1', [id])).rowCount).toBeGreaterThan(0)
  })

  it('CL371-B00 positive control: unencumbered legacy policy really accepts registered new booking and manual DATE acquisition', async () => {
    const company = await h.company(), pair = await h.actor(), wedding = await h.wedding(pair, '2027-08-29', 'Asia/Vladivostok')
    const booked = ok<{ deal: { id: string } }>(await h.call(pair, 'POST', `/weddings/${wedding.id}/slots/${wedding.slot}/book`,
      { vendorId: company.id, price: { amount: 15000, currency: 'RUB' } }), 'DATE-only positive public booking')
    expect((await h.db.query<{ state: string }>('select state from deals where id=$1', [booked.deal.id])).rows[0]!.state).toBe('booked')
    expect((await h.call(company.owner, 'POST', '/vendor/calendar/busy', { dates: ['2027-08-30'], status: 'busy' })).statusCode).toBe(204)
    expect((await h.db.query("select id from vendor_busy_dates where vendor_id=$1 and date in('2027-08-29','2027-08-30')", [company.id])).rowCount).toBe(2)
  })

  it('CL371-B01 accepted company bounds fence new DATE doors without changing an existing physical DAY observation', async () => {
    const c = await h.cohort(1), pair = await h.actor(), wedding = await h.wedding(pair, '2027-08-29', 'Asia/Vladivostok')
    await settle(c.company)
    expect(ok<{ mode: string }>(await h.call(c.company.owner, 'GET', `/vendors/${c.company.id}/availability-policy`), 'actual legacy policy').mode).toBe('legacy_day')
    const before = { graph: await h.graph(c.company), finance: await h.finance(), dates: await dates() }
    await dateAttempt(c.company, pair, wedding)
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { weddingIds: [c.wedding], vendorIds: [c.company.id] })
      await client.query(`insert into vendor_busy_dates(vendor_id,date,source,deal_id)
        select vendor_id,date,source,deal_id from vendor_busy_dates where vendor_id=$1 and source='deal'
        on conflict(vendor_id,date) do nothing`, [c.company.id])
    })
    expect(await h.graph(c.company)).toEqual(before.graph); expect(await h.finance()).toEqual(before.finance); expect(await dates()).toEqual(before.dates)
    expect((await h.db.query('select id from deals where wedding_id=$1', [wedding.id])).rowCount).toBe(0)
  })

  it('CL371-B02 another legacy-mode company cannot acquire a DATE through a genuinely shared person with accepted finite promises', async () => {
    const company = await h.company(), other = await h.company(); await join(other, company.owner)
    const pair = await h.actor(), wedding = await h.wedding(pair, '2027-08-29', 'Asia/Vladivostok')
    await manualProof(company)
    expect(ok<{ mode: string }>(await h.call(other.owner, 'GET', `/vendors/${other.id}/availability-policy`), 'other company legacy policy').mode).toBe('legacy_day')
    const before = { graph: await h.graph(company), other: await h.graph(other), finance: await h.finance(), dates: await dates() }
    await dateAttempt(other, pair, wedding)
    expect(await h.graph(company)).toEqual(before.graph); expect(await h.graph(other)).toEqual(before.other)
    expect(await h.finance()).toEqual(before.finance); expect(await dates()).toEqual(before.dates)
  })

  it('CL371-B03 an unresolved other-company promise is unknown for DATE doors and an actual shared-person commitment', async () => {
    const company = await h.company(), other = await h.company(); await join(other, company.owner); await join(company, other.owner)
    await h.manual(company)
    const pair = await h.actor(), wedding = await h.wedding(pair, '2027-08-29', 'Asia/Vladivostok')
    expect(ok<{ mode: string }>(await h.call(other.owner, 'GET', `/vendors/${other.id}/availability-policy`), 'unresolved other-company legacy policy').mode).toBe('legacy_day')
    const before = { graph: await h.graph(company), finance: await h.finance(), dates: await dates() }
    await dateAttempt(other, pair, wedding)
    expect(await h.finance()).toEqual(before.finance); expect(await dates()).toEqual(before.dates)
    const ready = await h.ready(other, 'person')
    const prepared = { finance: await h.finance(), counters: await h.counters(other), graph: await h.graph(other) }
    denied(await h.commit(ready), 409, 'legacy_person_scope_unknown')
    expect(await h.finance()).toEqual(prepared.finance); expect(await h.counters(other)).toEqual(prepared.counters)
    expect(await h.graph(other)).toEqual(prepared.graph); expect(await h.graph(company)).toEqual(before.graph)
    expect((await h.db.query('select id from resource_allocations where deal_id=$1', [ready.deal])).rowCount).toBe(0)
  })
})
