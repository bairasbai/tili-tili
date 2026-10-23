import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isUuid } from '../src/ids.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { finishNewDayCommitment, prepareDayWriter } from '../src/deals/day-scope-write.js'
import { EVENT_MOVE_READ_TTL_SECONDS, signEventMoveRead } from '../src/orders/event-move-token.js'
import { signOrderTermsRead } from '../src/orders/terms-token.js'
import type { Queryable } from '../src/plugins/db.js'
import { acceptStaffInvite, createStaffDuty, inviteStaff } from '../src/vendor/staff.js'
import { seedUntrackedSlotDeal } from './helpers/dayFixture.js'
import { AdditionalEventFixture, MAIN_DATE, OTHER_DATE, YEAR, context, ok,
  type Actor, type Case, type Company, type ProgramEvent, type Raw, type Reply, type SlotReply } from './helpers/additionalEventFixture.js'

// Frozen CONTRACT-v1 + Root's public DTO clarification. Only M0 is the initial
// meaningful RED: registered ordinary PATCH location, not a future route's 404.
const TARGET_DATE = `${YEAR}-06-20`, TARGET_TZ = 'Asia/Novosibirsk'
const MOVE_TABLES = ['event_move_proposals', 'event_move_roots', 'event_move_receipts', 'event_move_effects'] as const
const SUCCESS_AUDIT = new Set(['event_move.proposed', 'event_move.accepted', 'event_move.applied', 'event_move.cancelled'])
type Target = { date: string; timeZone: string; location: string | null }
type Receipt = { id: string; party: 'customer' | 'performer'; userId: string | null; sessionId: string | null; digest: string; acceptedAt: string }
type Proposal = { id: string; eventId: string; digest: string; from: Target; to: Target;
  status: 'pending' | 'applied' | 'cancelled' | 'stale'; roots: { dealId: string; digest: string; receipts: Receipt[] }[] }
type RootView = { id: string; eventId: string; dealId: string; digest: string; material: Record<string, unknown>;
  receipts: Receipt[]; readToken: string | null; status: Proposal['status'] }
type Root = { deal: string; slot: string; company: Company; price: number }
type MoveCase = { f: Case; roots: Root[] }
type ExpectedMaterial = {
  schemaVersion: 1; proposalId: string; dealId: string;
  event: { id: string; name: string; kind: string; from: Target; to: Target };
  economics: { amount: number; currency: string; vendorId: string | null; packageTitle: string | null;
    packageIncludes: string[] | null; comparisonTerms: unknown };
  assignments: { id: string; slotId: string; eventId: string; label: string }[];
  preserved: { price: true; payments: true; paymentDueDates: true; otherEvents: true };
}
const emit = (label: string, value: unknown) => process.stdout.write(`ADDITIONAL_MOVE_${label} ${JSON.stringify(value)}\n`)
const target = (patch: Partial<Target> = {}): Target => ({ date: TARGET_DATE, timeZone: TARGET_TZ, location: 'Synthetic agreed extra venue', ...patch })
const base = (f: Case) => `/weddings/${f.wedding}/events/${f.event.id}/move-proposals`
const rootUrl = (p: Proposal, root: string) => `/deals/${root}/event-moves/${p.id}`
const code = (r: Reply) => r.json<{ error: { code: string } }>().error.code

describe('additional event move: exact per-root agreement before one atomic effect', () => {
  const h = new AdditionalEventFixture()
  const cases: Case[] = []
  const proposalIds = new Set<string>(), dealIds = new Set<string>()
  const expectedMaterials = new Map<string, Map<string, ExpectedMaterial>>()
  beforeAll(() => h.start())
  afterAll(async () => {
    try {
      if (!h.app?.db || !cases.length) return
      const audit = await h.raw('audit_log', 'true', [])
      // Real parent erasure, not removal of new history to make a snapshot pass.
      await h.db.tx(async c => {
        for (const f of cases) await c.query('delete from weddings where id=$1 and owner_id=$2', [f.wedding, f.pair.id])
      })
      const checked: string[] = []
      for (const table of MOVE_TABLES) {
        // M0 is runnable on the pre-move schema. An absent future table is not a
        // GREEN assertion; the recorded checkedTables list makes that explicit.
        if (!(await h.db.query('select to_regclass($1) relation', [table])).rows[0]!.relation) continue
        checked.push(table)
        expect((await h.db.query(`select wedding_id from ${table} where wedding_id=any($1::uuid[])`, [cases.map(f => f.wedding)])).rows).toEqual([])
      }
      const after = new Set(await h.raw('audit_log', 'true', []))
      for (const raw of audit) expect(after.has(raw), 'All observed own/foreign audit survives parent cleanup literally').toBe(true)
      emit('CLEANUP', { weddings: cases.map(f => f.wedding), proposalIds: [...proposalIds], dealIds: [...dealIds], checkedTables: checked, retainedAuditRows: audit })
    } finally { await h.close() }
  })

  async function fixture(mainBooking = false) {
    const f = await h.fixture({ mainBooking }); cases.push(f)
    if (f.mainDeal) dealIds.add(f.mainDeal)
    return f
  }
  async function readEvent(f: Case): Promise<ProgramEvent> {
    const events = ok<ProgramEvent[]>(await h.call('MOVE_EVENT_READ', f.pair, { method: 'GET', url: `/weddings/${f.wedding}/events` }))
    const event = events.find(e => e.id === f.event.id); assert(event); return event
  }
  async function version(f: Case) {
    const r = await h.call('MOVE_ETAG', f.pair, { method: 'GET', url: `/weddings/${f.wedding}/events` })
    ok(r); assert.equal(typeof r.headers.etag, 'string'); return r.headers.etag as string
  }
  async function book(f: Case, slot = f.slot, company = f.company, price = 2468000, event = f.event): Promise<Root> {
    const r = await h.call('MOVE_SETUP_BOOK', f.pair, { method: 'POST', url: `/weddings/${f.wedding}/slots/${slot}/book`,
      key: randomUUID(), context: context(event), payload: { vendorId: company.id, price: { amount: price, currency: 'RUB' } } })
    const dto = ok<SlotReply>(r); assert(dto.deal); expect(dto.id).toBe(slot); expect(dto.deal.state).toBe('booked')
    const scope = await h.scope(f, dto.deal.id)
    expect(scope).toHaveLength(1); expect(scope[0]).toMatchObject({ context_kind: 'explicit_event', event_id: event.id,
      binding_state: 'active', service_date: event.date, time_zone: event.timeZone, exact_head: true, matches_current: true })
    dealIds.add(dto.deal.id); return { deal: dto.deal.id, slot, company, price }
  }
  async function setup(two = false, mainBooking = false, differentCompany = false): Promise<MoveCase> {
    const f = await fixture(mainBooking), roots = [await book(f)]
    if (two) {
      const company = differentCompany ? await h.company(f) : f.company, slot = await h.slot(f.wedding, f.pair, f.event)
      roots.push(await book(f, slot, company, differentCompany ? 9876500 : 3141500))
    }
    return { f, roots }
  }
  async function operational(f: Case): Promise<Raw> {
    const raw = await h.snapshot(f)
    delete raw.audit; delete raw.idempotency_keys; delete raw.notifications
    return raw
  }
  async function business(f: Case): Promise<Raw> {
    const raw = await h.snapshot(f); delete raw.audit
    for (const table of MOVE_TABLES) {
      if ((await h.db.query('select to_regclass($1) relation', [table])).rows[0]!.relation) raw[table] = await h.raw(table, 'wedding_id=$1', [f.wedding])
    }
    return raw
  }
  async function financial(root: string): Promise<Raw> {
    const raw: Raw = { deals: await h.raw('deals', 'id=$1', [root]) }
    for (const table of ['deal_orders', 'deal_events', 'payments', 'payment_installments',
      'payment_corrections', 'payment_installment_edits', 'order_assignments', 'order_parts', 'deal_terms_versions',
      'deal_terms_receipts', 'deal_resource_plan_versions', 'deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members']) {
      raw[table] = await h.raw(table, 'deal_id=$1', [root])
    }
    raw.payment_receipts = await h.raw('payment_receipts', 'payment_id in(select id from payments where deal_id=$1)', [root])
    return raw
  }
  async function untouched(f: Case, root: string) {
    const selected = (await h.db.query<{ slot_id: string; program_event_id: string | null }>(
      'select d.slot_id,s.program_event_id from deals d join slots s on s.id=d.slot_id where d.id=$1 and d.wedding_id=$2', [root, f.wedding])).rows[0]!
    return { financial: await financial(root), versions: await h.raw('deal_day_scope_versions', 'deal_id=$1', [root]),
      head: await h.raw('deal_day_scope_heads', 'deal_id=$1', [root]),
      slot: await h.raw('slots', 'id=$1', [selected.slot_id]),
      event: await h.raw('wedding_events', 'id=$1', [selected.program_event_id ?? f.mainEvent.id]),
      days: await h.raw('vendor_busy_dates', 'deal_id=$1', [root]),
      groups: await h.raw('legacy_day_groups', 'day_id in(select id from vendor_busy_dates where deal_id=$1)', [root]),
      wedding: await h.db.query('select date::text,tz,venue from weddings where id=$1', [f.wedding]).then(r => r.rows) }
  }
  async function ownAudit(f: Case) {
    return h.raw('audit_log', 'actor_id=any($1::uuid[]) or entity_id=$2 or entity_id=any($3::uuid[])',
      [f.actors, f.wedding, [...proposalIds, ...dealIds]])
  }
  async function auditRefusal(f: Case, before: string[]) {
    const after = await ownAudit(f), all = new Set(after), previous = new Set(before)
    for (const raw of before) expect(all.has(raw), 'Existing audit must remain literal').toBe(true)
    for (const raw of after) if (!previous.has(raw)) {
      const row = JSON.parse(raw) as { action: string }
      expect(SUCCESS_AUDIT.has(row.action), 'Refusal may record an error, never a new move success audit').toBe(false)
    }
    emit('REFUSAL_AUDIT', { before, after })
  }
  async function refusal(f: Case, label: string, action: () => Promise<Reply>, status: number, expectedCode: string) {
    const before = await business(f), audit = await ownAudit(f), r = await action(), after = await business(f)
    emit('REFUSAL', { label, status: r.statusCode, body: r.body, before, after })
    expect(r.statusCode, r.body).toBe(status); expect(code(r)).toBe(expectedCode); expect(after).toEqual(before)
    await auditRefusal(f, audit); return r
  }
  async function materialFacts(m: MoveCase, root: Root, to: Target): Promise<Omit<ExpectedMaterial, 'proposalId'>> {
    // Independent pre-proposal facts. Never call a production move constructor.
    const event = (await h.db.query<ProgramEvent>(`select id,name,kind,date::text,time_zone as "timeZone",location,is_main as "isMain"
      from wedding_events where wedding_id=$1 and id=$2`, [m.f.wedding, m.f.event.id])).rows[0]
    assert(event && !event.isMain && event.date && event.timeZone)
    const economic = (await h.db.query<{ price: string; currency: string; vendor_id: string | null;
      package_title_snapshot: string | null; package_includes_snapshot: string[] | null; offer_comparison_terms_snapshot: unknown }>(
      `select price::text,currency,vendor_id,package_title_snapshot,package_includes_snapshot,offer_comparison_terms_snapshot
       from deals where wedding_id=$1 and id=$2 and slot_id=$3`, [m.f.wedding, root.deal, root.slot])).rows[0]
    assert(economic && /^\d+$/.test(economic.price)); const amount = Number(economic.price)
    assert(Number.isSafeInteger(amount) && amount > 0 && BigInt(amount) === BigInt(economic.price))
    expect(economic.vendor_id).toBe(root.company.id); expect(amount).toBe(root.price); expect(economic.currency).toBe('RUB')
    const assignments = (await h.db.query<{ id: string; slotId: string; eventId: string; label: string }>(
      `select id,slot_id as "slotId",program_event_id as "eventId",label from order_assignments
       where wedding_id=$1 and deal_id=$2 and program_event_id=$3 and cancelled_at is null order by id`,
      [m.f.wedding, root.deal, event.id])).rows
    return { schemaVersion: 1, dealId: root.deal,
      event: { id: event.id, name: event.name, kind: event.kind,
        from: { date: event.date, timeZone: event.timeZone, location: event.location }, to: { ...to } },
      economics: { amount, currency: economic.currency, vendorId: economic.vendor_id,
        packageTitle: economic.package_title_snapshot, packageIncludes: economic.package_includes_snapshot,
        comparisonTerms: economic.offer_comparison_terms_snapshot }, assignments,
      preserved: { price: true, payments: true, paymentDueDates: true, otherEvents: true } }
  }
  async function propose(m: MoveCase, to = target(), key = randomUUID()): Promise<Proposal> {
    const nativeFacts = new Map<string, Omit<ExpectedMaterial, 'proposalId'>>()
    for (const root of m.roots) nativeFacts.set(root.deal, await materialFacts(m, root, to))
    emit('MATERIAL_BASELINE_BEFORE_PROPOSAL', { wedding: m.f.wedding, requestedTarget: to, roots: [...nativeFacts] })
    const r = await h.call('MOVE_PROPOSE', m.f.pair, { method: 'POST', url: base(m.f), key,
      headers: { 'if-match': await version(m.f) }, payload: to })
    const p = ok<Proposal>(r, 201); expect(isUuid(p.id)).toBe(true); expect(p.eventId).toBe(m.f.event.id)
    expect(p.status).toBe('pending'); expect(p.digest).toMatch(/^[a-f0-9]{64}$/); expect(p.to).toEqual(to)
    expect(p.from).toEqual({ date: m.f.event.date, timeZone: m.f.event.timeZone, location: m.f.event.location })
    expect(p.roots.map(row => row.dealId).sort()).toEqual(m.roots.map(root => root.deal).sort())
    const materials = new Map<string, ExpectedMaterial>()
    for (const [deal, facts] of nativeFacts) materials.set(deal, { ...facts, proposalId: p.id })
    expectedMaterials.set(p.id, materials)
    proposalIds.add(p.id); return p
  }
  async function readRoot(m: MoveCase, p: Proposal, root: Root, actor: Actor): Promise<RootView> {
    const r = await h.call('MOVE_ROOT_READ', actor, { method: 'GET', url: rootUrl(p, root.deal) })
    expect(r.headers['cache-control']).toContain('no-store')
    expect(r.headers['cache-control']).toContain('private')
    const view = ok<RootView>(r); expect(view).toMatchObject({ id: p.id, eventId: m.f.event.id, dealId: root.deal })
    expect(view.digest).toBe(p.roots.find(row => row.dealId === root.deal)!.digest)
    expect(view.digest).toMatch(/^[a-f0-9]{64}$/); expect(view.digest).not.toBe(p.digest)
    expect(view.material).toBeTypeOf('object')
    const expected = expectedMaterials.get(p.id)?.get(root.deal)
    assert(expected, 'Own material must have an independent baseline captured before proposal201')
    emit('MATERIAL_EXACT', { proposal: p.id, deal: root.deal, actor: actor.id, expected, actual: view.material })
    expect(view.material).toStrictEqual(expected)
    for (const receipt of view.receipts) expect(Object.keys(receipt).sort()).toEqual(['id', 'party', 'userId', 'sessionId', 'digest', 'acceptedAt'].sort())
    return view
  }
  async function accept(m: MoveCase, p: Proposal, root: Root, actor: Actor, party: Receipt['party']) {
    const view = await readRoot(m, p, root, actor)
    expect(view.readToken).toBeTypeOf('string'); assert(view.readToken)
    ok(await h.call('MOVE_ACCEPT', actor, { method: 'POST', url: rootUrl(p, root.deal) + '/accept', key: randomUUID(),
      payload: { digest: view.digest, readToken: view.readToken } }))
    const current = await readRoot(m, p, root, actor)
    expect(current.receipts.filter(receipt => receipt.party === party)).toEqual([
      expect.objectContaining({ party, userId: actor.id, sessionId: actor.sid, digest: view.digest }),
    ])
    return current
  }
  async function agreed(m: MoveCase, p: Proposal) {
    for (const root of m.roots) {
      await accept(m, p, root, m.f.pair, 'customer')
      const view = await accept(m, p, root, root.company.actor, 'performer')
      expect(view.receipts).toHaveLength(2)
      const a = view.receipts.find(row => row.party === 'customer')!, b = view.receipts.find(row => row.party === 'performer')!
      expect(a.userId).not.toBe(b.userId); expect(a.sessionId).not.toBe(b.sessionId)
    }
  }
  const apply = (m: MoveCase, p: Proposal, key = randomUUID(), digest = p.digest) => h.call('MOVE_APPLY', m.f.pair,
    { method: 'POST', url: base(m.f) + `/${p.id}/apply`, key, payload: { digest } })
  async function effects(p: Proposal) { return h.raw('event_move_effects', "proposal_id=$1 and action='apply'", [p.id]) }
  async function orderVersion(root: string) {
    return (await h.db.query<{ version: string }>('select version::text from deal_orders where deal_id=$1', [root])).rows[0]!.version
  }
  async function privatePayment(f: Case, root: Root) {
    const stage = ok<{ id: string; version: number }>(await h.call('MOVE_SETUP_PAYMENT_STAGE', f.pair, {
      method: 'POST', url: `/weddings/${f.wedding}/payment-schedule`, key: randomUUID(),
      payload: { dealId: root.deal, title: 'Synthetic fixed financial due date', amount: { amount: 500000, currency: 'RUB' }, due: `${YEAR}-06-12` } }), 201)
    ok(await h.call('MOVE_SETUP_ACTUAL_PAYMENT', f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/payment-schedule/${stage.id}/pay`, key: randomUUID(),
      payload: { version: stage.version, amount: { amount: 100000, currency: 'RUB' }, paymentMethod: 'cash', visibility: 'private', paidOn: `${YEAR}-06-10` } }))
    const paid = (await h.db.query<{ id: string; visibility: string }>('select id,visibility from payments where installment_id=$1', [stage.id])).rows
    expect(paid).toHaveLength(1); expect(paid[0]!.visibility).toBe('private')
    return { stage: stage.id, payment: paid[0]!.id }
  }
  async function assignment(m: MoveCase, root: Root, slot: string, event: ProgramEvent) {
    ok(await h.call('MOVE_SETUP_ASSIGNMENT', m.f.pair, { method: 'POST', url: `/deals/${root.deal}/order/assignments`, key: randomUUID(),
      payload: { expectedVersion: await orderVersion(root.deal), slotId: slot, programEventId: event.id, label: 'Synthetic actual assignment' } }))
    const rows = (await h.db.query<{ id: string }>('select id from order_assignments where deal_id=$1 and slot_id=$2 and cancelled_at is null', [root.deal, slot])).rows
    expect(rows).toHaveLength(1); return rows[0]!.id
  }

  it('M0 meaningful RED: ordinary public extra location PATCH must require agreement before any writes', async () => {
    const m = await setup(), before = await business(m.f), audit = await ownAudit(m.f)
    const r = await h.call('M0_REGISTERED_LOCATION_BYPASS', m.f.pair, { method: 'PATCH',
      url: `/weddings/${m.f.wedding}/events/${m.f.event.id}`, headers: { 'if-match': await version(m.f) },
      payload: { location: 'Synthetic unsigned changed venue' } })
    const after = await business(m.f)
    emit('M0_RESULT', { wedding: m.f.wedding, event: m.f.event, roots: m.roots, status: r.statusCode, body: r.body, before, after })
    expect(r.statusCode, r.body).toBe(409); expect(code(r)).toBe('event_move_requires_agreement'); expect(after).toEqual(before)
    await auditRefusal(m.f, audit)
  })

  it('M1 two real parties on each of two roots apply once, coalesce DATE and preserve main/sibling/full financial history', async () => {
    const m = await setup(true, true), f = m.f
    const siblingEvent = await h.event(f.wedding, f.pair, OTHER_DATE, 'Asia/Yekaterinburg')
    const siblingSlot = await h.slot(f.wedding, f.pair, siblingEvent), sibling = await book(f, siblingSlot, f.company, 2718200, siblingEvent)
    assert(f.mainDeal)
    for (const root of m.roots) await assignment(m, root, root.slot, f.event)
    await privatePayment(f, m.roots[0]!)
    const money = await Promise.all(m.roots.map(root => financial(root.deal))), main = await untouched(f, f.mainDeal), other = await untouched(f, sibling.deal)
    const oldDay = (await h.scope(f, m.roots[0]!.deal))[0]!.day_id
    expect((await h.scope(f, m.roots[1]!.deal))[0]!.day_id).toBe(oldDay)
    const old = await operational(f), p = await propose(m)
    expect(await operational(f)).toEqual(old)
    await accept(m, p, m.roots[0]!, f.pair, 'customer'); expect(await operational(f)).toEqual(old)
    await accept(m, p, m.roots[0]!, f.company.actor, 'performer')
    await accept(m, p, m.roots[1]!, f.pair, 'customer'); expect(await operational(f)).toEqual(old)
    await accept(m, p, m.roots[1]!, f.company.actor, 'performer'); expect(await operational(f)).toEqual(old)
    const key = randomUUID(), applied = ok<Proposal>(await apply(m, p, key))
    expect(applied).toMatchObject({ id: p.id, digest: p.digest, status: 'applied' })
    expect(await readEvent(f)).toMatchObject(p.to)
    const heads = await Promise.all(m.roots.map(root => h.scope(f, root.deal)))
    for (const rows of heads) {
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ operation: 'move', context_kind: 'explicit_event',
        event_id: f.event.id, service_date: TARGET_DATE, time_zone: TARGET_TZ, exact_head: true, matches_current: true })
      expect(rows[0]!.day_id).not.toBe(oldDay)
    }
    expect(heads[0]![0]!.day_id).toBe(heads[1]![0]!.day_id)
    expect((await h.db.query('select id from vendor_busy_dates where id=$1', [oldDay])).rows).toEqual([])
    expect((await h.db.query('select date::text date from vendor_busy_dates where vendor_id=$1 order by date', [f.company.id])).rows)
      .toEqual([{ date: MAIN_DATE }, { date: OTHER_DATE }, { date: TARGET_DATE }])
    expect(await Promise.all(m.roots.map(root => financial(root.deal)))).toEqual(money)
    expect(await untouched(f, f.mainDeal)).toEqual(main); expect(await untouched(f, sibling.deal)).toEqual(other)
    const beforeReplay = await business(f), replay = await apply(m, p, key)
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toEqual(applied)
    expect(replay.headers['idempotent-replay']).toBe('true'); expect(await business(f)).toEqual(beforeReplay)
    expect(await effects(p)).toHaveLength(1)
    emit('APPLIED_TWO_ROOTS', { proposal: p.id, applied, heads, financialBefore: money, financialAfter: await Promise.all(m.roots.map(root => financial(root.deal))), effects: await effects(p) })
  })

  it('M2 TZ-only and then location-only require fresh exact agreements while preserving DATE UUID', async () => {
    const m = await setup(), original = (await h.scope(m.f, m.roots[0]!.deal))[0]!, money = await financial(m.roots[0]!.deal)
    for (const to of [target({ date: m.f.event.date!, timeZone: 'Asia/Novosibirsk', location: null }),
      target({ date: m.f.event.date!, timeZone: 'Asia/Novosibirsk', location: 'Synthetic location-only agreement' })]) {
      m.f.event = await readEvent(m.f)
      const p = await propose(m, to); await agreed(m, p); expect(ok<Proposal>(await apply(m, p)).status).toBe('applied')
      expect(await readEvent(m.f)).toMatchObject(to)
      const current = (await h.scope(m.f, m.roots[0]!.deal))[0]!
      expect(current.day_id).toBe(original.day_id); expect(current.operation).toBe('move'); expect(current.matches_current).toBe(true)
      expect(BigInt(current.revision as string)).toBeGreaterThan(BigInt(original.revision as string))
      expect(await financial(m.roots[0]!.deal)).toEqual(money)
    }
  })

  it('M3 the unsigned second root cannot be omitted or borrow the first root receipts', async () => {
    const m = await setup(true), old = await operational(m.f), p = await propose(m)
    await accept(m, p, m.roots[0]!, m.f.pair, 'customer'); await accept(m, p, m.roots[0]!, m.f.company.actor, 'performer')
    await accept(m, p, m.roots[1]!, m.f.pair, 'customer')
    await refusal(m.f, 'SECOND_ROOT_NOT_AGREED', () => apply(m, p), 409, 'event_move_not_agreed')
    expect(await operational(m.f)).toEqual(old); expect(await effects(p)).toEqual([])
  })

  it('M4 own-root privacy, real current ACL, wrong purpose, unread and cross-root proofs fail closed', async () => {
    const m = await setup(true, false, true), first = m.roots[0]!, second = m.roots[1]!
    const privateIds = await privatePayment(m.f, first), p = await propose(m)
    const view = await readRoot(m, p, first, first.company.actor), text = JSON.stringify(view)
    expect(text).not.toContain(p.digest); expect(text).not.toContain(second.deal); expect(text).not.toContain(second.company.id)
    expect(JSON.stringify(view.material)).not.toContain(String(second.price)); expect(view).not.toHaveProperty('roots')
    expect(JSON.stringify(view.material)).not.toContain(privateIds.payment); expect(JSON.stringify(view.material)).not.toContain(privateIds.stage)
    const outsider = await h.actor(); m.f.actors.push(outsider.id)
    await refusal(m.f, 'OTHER_VENDOR_PRIVATE_ROOT', () => h.call('OTHER_VENDOR_PRIVATE_ROOT', second.company.actor,
      { method: 'GET', url: rootUrl(p, first.deal) }), 404, 'not_found')
    await refusal(m.f, 'OUTSIDER_PRIVATE_PROPOSAL', () => h.call('OUTSIDER_PRIVATE_PROPOSAL', outsider,
      { method: 'GET', url: base(m.f) + '/' + p.id }), 404, 'not_found')
    const customer = await readRoot(m, p, first, m.f.pair), other = await readRoot(m, p, second, m.f.pair)
    assert(customer.readToken); assert(other.readToken)
    for (const [label, digest, readToken] of [
      ['UNREAD', customer.digest, 'not-a-signed-read-proof'],
      ['OTHER_ROOT_TOKEN', other.digest, customer.readToken],
      ['WRONG_DIGEST', '0'.repeat(64), customer.readToken],
    ] as const) await refusal(m.f, label, () => h.call(label, m.f.pair, { method: 'POST',
      url: rootUrl(p, label === 'OTHER_ROOT_TOKEN' ? second.deal : first.deal) + '/accept', key: randomUUID(), payload: { digest, readToken } }), 422, 'validation_failed')
    const secret = h.app.appConfig.jwtAccessSecret; assert(secret)
    const ordinary = await signOrderTermsRead(secret, { purpose: 'order-terms-read', weddingId: m.f.wedding, dealId: first.deal,
      termsId: randomUUID(), version: '1', digest: customer.digest, userId: m.f.pair.id, sessionId: m.f.pair.sid,
      policyVersion: h.app.appConfig.policyVersion }, new Date())
    await refusal(m.f, 'ORDINARY_TERMS_PURPOSE', () => h.call('ORDINARY_TERMS_PURPOSE', m.f.pair,
      { method: 'POST', url: rootUrl(p, first.deal) + '/accept', key: randomUUID(), payload: { digest: customer.digest, readToken: ordinary } }), 422, 'validation_failed')
    expect((await readRoot(m, p, first, m.f.pair)).receipts).toEqual([])
    await accept(m, p, first, m.f.pair, 'customer')
    const receipts = await h.raw('event_move_receipts', 'proposal_id=$1 and deal_id=$2', [p.id, first.deal])
    expect(receipts).toHaveLength(1)
    const forged = { ...(JSON.parse(receipts[0]!) as Record<string, unknown>), id: randomUUID(), party: 'performer' }
    let actual: { code?: string; constraint?: string } | undefined
    try {
      await h.db.tx(c => c.query('insert into event_move_receipts select (jsonb_populate_record(null::event_move_receipts,$1::jsonb)).*', [JSON.stringify(forged)]))
    } catch (e) { actual = e as { code?: string; constraint?: string } }
    emit('SAME_USER_FORGED_PARTY', { proposal: p.id, root: first.deal, actual })
    expect(actual?.code, 'A real customer receipt cannot be duplicated as its own performer acceptance').toBe('23514')
    expect(actual?.constraint).toBe('event_move_party')
    expect(await h.raw('event_move_receipts', 'proposal_id=$1 and deal_id=$2', [p.id, first.deal])).toEqual(receipts)
  })

  it('M5 relevant source changed after both accepts makes the pending proposal stale without moving holds', async () => {
    const m = await setup(), p = await propose(m); await agreed(m, p)
    ok(await h.call('MOVE_SETUP_NAME_CHANGE', m.f.pair, { method: 'PATCH', url: `/weddings/${m.f.wedding}/events/${m.f.event.id}`,
      headers: { 'if-match': await version(m.f) }, payload: { name: 'Synthetic changed relevant event name' } }))
    await refusal(m.f, 'STALE_SOURCE', () => apply(m, p), 409, 'event_move_source_changed')
    expect(ok<Proposal>(await h.call('STALE_PROPOSAL_VIEW', m.f.pair, { method: 'GET', url: base(m.f) + '/' + p.id })).status).toBe('stale')
  })

  it('M6 cancel preserves pending history and old effective scope; no later apply or implicit acceptance', async () => {
    const m = await setup(), old = await operational(m.f), p = await propose(m)
    await accept(m, p, m.roots[0]!, m.f.pair, 'customer')
    const key = randomUUID(), call = () => h.call('MOVE_CANCEL', m.f.pair, { method: 'POST', url: base(m.f) + `/${p.id}/cancel`, key, payload: { digest: p.digest } })
    const cancelled = ok<Proposal>(await call()); expect(cancelled).toMatchObject({ id: p.id, digest: p.digest, status: 'cancelled' })
    const before = await business(m.f), replay = await call()
    expect(ok<Proposal>(replay)).toEqual(cancelled); expect(replay.headers['idempotent-replay']).toBe('true'); expect(await business(m.f)).toEqual(before)
    await refusal(m.f, 'CANCELLED_APPLY', () => apply(m, p), 409, 'event_move_cancelled')
    expect(await operational(m.f)).toEqual(old); expect(await effects(p)).toEqual([])
    expect(await h.raw('event_move_proposals', 'id=$1', [p.id])).toHaveLength(1)
    expect(await h.raw('event_move_receipts', 'proposal_id=$1', [p.id])).toHaveLength(1)
  })

  it('M7 same key cannot replay another target or bundle; response-loss retry has one original effect', async () => {
    const m = await setup(), key = randomUUID(), p = await propose(m, target(), key)
    await refusal(m.f, 'KEY_DIFFERENT_TARGET', async () => h.call('KEY_DIFFERENT_TARGET', m.f.pair, { method: 'POST',
      url: base(m.f), key, headers: { 'if-match': await version(m.f) }, payload: target({ location: 'Another intent' }) }), 409, 'idempotency_key_reused')
    await agreed(m, p)
    const applyKey = randomUUID(), applied = ok<Proposal>(await apply(m, p, applyKey)), before = await business(m.f)
    const retry = await apply(m, p, applyKey)
    expect(ok<Proposal>(retry)).toEqual(applied); expect(retry.headers['idempotent-replay']).toBe('true')
    expect(await business(m.f)).toEqual(before); expect(await effects(p)).toHaveLength(1)
    await refusal(m.f, 'KEY_DIFFERENT_BUNDLE', () => apply(m, p, applyKey, '0'.repeat(64)), 409, 'idempotency_key_reused')
  })

  it('M8 external-only committed graph is discovered and refused, never an empty zero-root agreement', async () => {
    const f = await fixture(), response = await h.call('MOVE_SETUP_EXTERNAL', f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/slots/${f.slot}/external`, key: randomUUID(), context: context(f.event),
      payload: { vendorName: 'Synthetic external performer', phone: '+79990000000', price: { amount: 135000, currency: 'RUB' } } })
    const root = ok<SlotReply>(response); assert(root.deal); dealIds.add(root.deal.id)
    const etag = await version(f)
    await refusal(f, 'EXTERNAL_ONLY', () => h.call('EXTERNAL_ONLY', f.pair, { method: 'POST', url: base(f), key: randomUUID(),
      headers: { 'if-match': etag }, payload: target() }), 409, 'event_move_scope_incomplete')
  })

  it('M9 public resource-policy mode refuses both a new proposal and apply after pending agreements', async () => {
    const m = await setup(), p = await propose(m); await agreed(m, p)
    ok(await h.call('MOVE_SETUP_PERSON_RESOURCE', m.f.company.actor, { method: 'POST', url: `/vendors/${m.f.company.id}/resources`, key: randomUUID(),
      payload: { kind: 'person', label: 'Synthetic actual owner resource', personUserId: m.f.company.actor.id } }))
    ok(await h.call('MOVE_SETUP_RESOURCE_POLICY', m.f.company.actor, { method: 'PATCH', url: `/vendors/${m.f.company.id}/availability-policy`, key: randomUUID(),
      payload: { mode: 'resources', expectedRevision: '0' } }))
    const etag = await version(m.f)
    await refusal(m.f, 'RESOURCE_POLICY', () => h.call('RESOURCE_POLICY', m.f.pair, { method: 'POST', url: base(m.f), key: randomUUID(),
      headers: { 'if-match': etag }, payload: target() }), 409, 'event_move_scope_incomplete')
    await refusal(m.f, 'RESOURCE_POLICY_AFTER_AGREEMENT', () => apply(m, p), 409, 'event_move_scope_incomplete')
    expect(await effects(p)).toEqual([])
  })

  it('M10 done, cross-event assignment, active timed part and executable program dependencies each refuse the whole source', async () => {
    for (const kind of ['done', 'multi', 'part', 'program'] as const) {
      const m = await setup(), root = m.roots[0]!
      if (kind === 'done') ok(await h.call('MOVE_SETUP_DONE', m.f.pair, { method: 'PATCH', url: `/deals/${root.deal}`, key: randomUUID(), payload: { state: 'done' } }))
      if (kind === 'multi') {
        const other = await h.event(m.f.wedding, m.f.pair, OTHER_DATE, 'Asia/Yekaterinburg'), slot = await h.slot(m.f.wedding, m.f.pair, other)
        await assignment(m, root, slot, other)
      }
      if (kind === 'part') {
        const a = await assignment(m, root, root.slot, m.f.event)
        ok(await h.call('MOVE_SETUP_TIMED_PART', m.f.pair, { method: 'POST', url: `/deals/${root.deal}/order/parts`, key: randomUUID(),
          payload: { expectedVersion: await orderVersion(root.deal), kind: 'timed_service', assignmentId: a, title: 'Synthetic actual fixed service',
            details: { startsAt: `${m.f.event.date}T09:00:00+10:00`, endsAt: `${m.f.event.date}T11:00:00+10:00`, location: 'Fixed old service venue', setupMinutes: 20, teardownMinutes: 10, travelMinutes: 0 } } }))
      }
      if (kind === 'program') {
        const read = await h.call('MOVE_SETUP_TIMELINE_READ', m.f.pair, { method: 'GET', url: `/weddings/${m.f.wedding}/timeline` })
        const existing = ok<Record<string, unknown>[]>(read)
        const allowed = ['id', 'name', 'location', 'startsAt', 'endsAt', 'who', 'icon', 'outdoor', 'forGuests', 'eventId', 'durationMinutes', 'fixed', 'travelMinutes', 'bufferMinutes', 'dependsOn', 'responsible', 'participants']
        const payload = existing.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => allowed.includes(key))))
        payload.push({ name: 'Synthetic executable event program', eventId: m.f.event.id, startsAt: `${m.f.event.date}T09:00:00+10:00`, endsAt: `${m.f.event.date}T10:00:00+10:00`, participants: [{ kind: 'deal', id: root.deal }] })
        assert.equal(typeof read.headers.etag, 'string')
        // Existing real public whole-program API: retained existing blocks are
        // forwarded through its declared input projection, never fake responses.
        ok(await h.call('MOVE_SETUP_EXECUTABLE_PROGRAM', m.f.pair, { method: 'PUT', url: `/weddings/${m.f.wedding}/timeline`,
          headers: { 'if-match': read.headers.etag as string }, payload }))
      }
      const etag = await version(m.f)
      await refusal(m.f, `UNSUPPORTED_${kind}`, () => h.call(`UNSUPPORTED_${kind}`, m.f.pair, { method: 'POST', url: base(m.f), key: randomUUID(),
        headers: { 'if-match': etag }, payload: target() }), 409, 'event_move_scope_incomplete')
    }
  }, 60000)

  it('M11 session revoked during actual PG wait denies both a fresh apply and saved private replay', async () => {
    // These literal activity predicates make this native schedule a serial lane
    // under audit53: pg_stat_activity / pg_blocking_pids are exercised by blocked.
    for (const replay of [false, true]) {
      const m = await setup(), p = await propose(m); await agreed(m, p)
      const key = randomUUID(); if (replay) ok(await apply(m, p, key))
      const before = await business(m.f), audit = await ownAudit(m.f)
      const held = await h.gate(m.f.wedding, c => c.query('update sessions set revoked_at=clock_timestamp() where id=$1 and user_id=$2', [m.f.pair.sid, m.f.pair.id]))
      const action = apply(m, p, key); void action.catch(() => undefined)
      try { await h.blocked(held.pid, `MOVE_REVOKE_${replay}`) }
      finally { held.unlock(); await Promise.allSettled([held.done, action]) }
      await held.done
      const r = await action; expect(r.statusCode, r.body).toBe(401); expect(r.headers['idempotent-replay']).toBeUndefined()
      expect(await business(m.f)).toEqual(before); await auditRefusal(m.f, audit)
    }
  }, 60000)

  it('M12 target becomes genuinely busy during PG wait: old event/holds remain and no effect is published', async () => {
    const m = await setup(), p = await propose(m); await agreed(m, p)
    const before = await business(m.f), audit = await ownAudit(m.f)
    let inserted: string[] = []
    const held = await h.gate(m.f.wedding, async c => {
      await c.query('select legacy_day_lock_vendors($1::uuid[])', [[m.f.company.id]])
      await c.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2::date,'manual')", [m.f.company.id, TARGET_DATE])
      inserted = await h.raw('vendor_busy_dates', 'vendor_id=$1 and date=$2::date', [m.f.company.id, TARGET_DATE], c)
      // Snapshot this mutation after its commit below; no third-client locked
      // snapshot or guessed sleep stands in for the observed wait barrier.
    })
    const action = apply(m, p); void action.catch(() => undefined)
    try { await h.blocked(held.pid, 'MOVE_TARGET_BUSY') }
    finally { held.unlock(); await Promise.allSettled([held.done, action]) }
    await held.done
    const r = await action; expect(r.statusCode, r.body).toBe(409); expect(code(r)).toBe('date_taken')
    const after = await business(m.f)
    expect(inserted).toHaveLength(1)
    expect(after.vendor_busy_dates!.slice().sort()).toEqual([...before.vendor_busy_dates!, ...inserted].sort())
    const otherBefore = { ...before }, otherAfter = { ...after }
    delete otherBefore.vendor_busy_dates; delete otherAfter.vendor_busy_dates
    expect(otherAfter).toEqual(otherBefore); await auditRefusal(m.f, audit)
    expect(await effects(p)).toEqual([]); expect(await readEvent(m.f)).toMatchObject(p.from)
    expect((await h.scope(m.f, m.roots[0]!.deal))[0]).toMatchObject({ operation: 'acquire', service_date: p.from.date, time_zone: p.from.timeZone, matches_current: true })
    expect((await h.db.query("select source from vendor_busy_dates where vendor_id=$1 and date=$2::date", [m.f.company.id, TARGET_DATE])).rows).toEqual([{ source: 'manual' }])
    emit('LATE_BUSY', { proposal: p.id, status: r.statusCode, inserted, before, after })
  })

  it('M13 actual SQL22012 on apply-effect INSERT rolls back all changes and allows the same key retry', async () => {
    const m = await setup(), p = await propose(m); await agreed(m, p)
    const before = await business(m.f), audit = await ownAudit(m.f), key = randomUUID()
    const suffix = randomUUID().replaceAll('-', ''), fn = `test_event_move_fault_${suffix}`, trigger = `test_event_move_fault_${suffix}`
    assert(/^[a-z_0-9]+$/.test(fn)); assert(isUuid(p.id))
    // Real native SQL fault on the actual new row; no handler-response mock.
    await h.db.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if NEW.action='apply' and NEW.proposal_id='${p.id}'::uuid then perform 1/0; end if; return NEW; end $$`)
    let installed = false, actual: { code?: string; constraint?: string } | undefined
    const database = h.db, original = database.tx, forward = database.tx.bind(database)
    let r!: Reply
    try {
      await h.db.query(`create trigger ${trigger} after insert on event_move_effects for each row execute function ${fn}()`); installed = true
      database.tx = async <T>(action: (c: Queryable) => Promise<T>) => {
        try { return await forward(action) } catch (e) { actual = e as { code?: string; constraint?: string }; throw e }
      }
      r = await apply(m, p, key)
    } finally {
      database.tx = original
      try { if (installed) await h.db.query(`drop trigger ${trigger} on event_move_effects`) }
      finally { await h.db.query(`drop function ${fn}()`) }
    }
    emit('SQL22012', { proposal: p.id, actual, status: r.statusCode, before, after: await business(m.f) })
    expect(actual?.code, 'Actual effect INSERT must reach the native division-by-zero').toBe('22012')
    expect(r.statusCode).toBe(500); expect(await business(m.f)).toEqual(before); await auditRefusal(m.f, audit)
    expect(ok<Proposal>(await apply(m, p, key)).status).toBe('applied'); expect(await effects(p)).toHaveLength(1)
  })

  it('M14 callback-complete financial reversal is rejected at actual outer COMMIT, not an immediate BEFORE error', async () => {
    const m = await setup(), p = await propose(m); await agreed(m, p)
    const before = await business(m.f), audit = await ownAudit(m.f), key = randomUUID(), database = h.db
    const original = database.tx, forward = database.tx.bind(database)
    let callbackReturned = false, mutationCompleted = false, actual: { code?: string; constraint?: string } | undefined
    database.tx = async <T>(action: (c: Queryable) => Promise<T>) => {
      try {
        return await forward(async c => {
          const result = await action(c)
          const effect = await c.query('select id from event_move_effects where proposal_id=$1 and action=$2', [p.id, 'apply'])
          if (effect.rows.length && !mutationCompleted) {
            callbackReturned = true
            const changed = await c.query<QueryResultRow>('update deals set price=price+1 where id=$1 returning id,price::text', [m.roots[0]!.deal])
            expect(changed.rows).toHaveLength(1); mutationCompleted = true
            emit('OUTER_COMMIT_PRE', { callbackReturned, mutationCompleted, effect: effect.rows, actualChangedRoot: changed.rows })
          }
          return result
        })
      } catch (e) { actual = e as { code?: string; constraint?: string }; throw e }
    }
    let r!: Reply
    try { r = await apply(m, p, key) } finally { database.tx = original }
    emit('OUTER_COMMIT', { proposal: p.id, callbackReturned, mutationCompleted, actual, status: r.statusCode, before, after: await business(m.f) })
    expect(callbackReturned).toBe(true); expect(mutationCompleted, 'Immediate BEFORE refusal is not an outer COMMIT witness').toBe(true)
    expect(actual).toMatchObject({ code: '23514', constraint: 'event_move_complete' })
    expect(r.statusCode).toBe(500); expect(await business(m.f)).toEqual(before); await auditRefusal(m.f, audit)
    expect(ok<Proposal>(await apply(m, p, key)).status).toBe('applied'); expect(await effects(p)).toHaveLength(1)
  })

  it('M15 mixed catalog and external roots of the SAME event refuse the whole discovered graph', async () => {
    const m = await setup(), externalSlot = await h.slot(m.f.wedding, m.f.pair, m.f.event)
    const response = await h.call('M15_MIXED_EXTERNAL_BOOK', m.f.pair, { method: 'POST',
      url: `/weddings/${m.f.wedding}/slots/${externalSlot}/external`, key: randomUUID(), context: context(m.f.event),
      payload: { vendorName: 'Synthetic mixed external performer', phone: '+79990001111', price: { amount: 815900, currency: 'RUB' } } })
    const external = ok<SlotReply>(response); assert(external.deal); dealIds.add(external.deal.id)
    const discovered = (await h.db.query(`select d.id,d.vendor_id,d.external_name,d.state,s.program_event_id
      from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
      where d.wedding_id=$1 and s.program_event_id=$2 order by d.id`, [m.f.wedding, m.f.event.id])).rows
    expect(discovered).toHaveLength(2)
    expect(discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: m.roots[0]!.deal, vendor_id: m.f.company.id, external_name: null, state: 'booked', program_event_id: m.f.event.id }),
      expect.objectContaining({ id: external.deal.id, vendor_id: null, external_name: 'Synthetic mixed external performer', state: 'booked', program_event_id: m.f.event.id }),
    ]))
    const money = await Promise.all([m.roots[0]!.deal, external.deal.id].map(financial)), before = await business(m.f)
    const etag = await version(m.f)
    await refusal(m.f, 'M15_MIXED_WHOLE_SCOPE', () => h.call('M15_MIXED_WHOLE_SCOPE', m.f.pair,
      { method: 'POST', url: base(m.f), key: randomUUID(), headers: { 'if-match': etag }, payload: target() }), 409, 'event_move_scope_incomplete')
    expect(await business(m.f)).toEqual(before)
    expect(await Promise.all([m.roots[0]!.deal, external.deal.id].map(financial))).toEqual(money)
    for (const table of MOVE_TABLES) expect(await h.raw(table, 'wedding_id=$1', [m.f.wedding])).toEqual([])
    emit('M15_MIXED_DISCOVERY', { discovered, financial: money, before, after: await business(m.f) })
  })

  it('M16 deleting an independent pre-proposal manual DATE after the callback fails actual outer COMMIT', async () => {
    const m = await setup(), manualDate = `${YEAR}-06-24`
    const manual = await h.db.tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [m.f.wedding])
      await c.query('select legacy_day_lock_vendors($1::uuid[])', [[m.f.company.id]])
      const row = (await c.query<{ id: string }>("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2::date,'manual') returning id", [m.f.company.id, manualDate])).rows[0]!
      const raw = await h.raw('vendor_busy_dates', 'id=$1', [row.id], c)
      expect(raw).toHaveLength(1); return { id: row.id, raw }
    })
    // The independent manual row existed before the immutable proposal, not
    // only before the after-callback mutation. It is outside the moving DATE.
    const p = await propose(m); await agreed(m, p)
    expect(await h.raw('vendor_busy_dates', 'id=$1', [manual.id])).toEqual(manual.raw)
    const before = await business(m.f), audit = await ownAudit(m.f), key = randomUUID(), database = h.db
    const original = database.tx, forward = database.tx.bind(database)
    let callbackReturned = false, deleteCompleted = false, actual: { code?: string; constraint?: string } | undefined
    let removed: string[] = [], r!: Reply
    database.tx = async <T>(action: (c: Queryable) => Promise<T>) => {
      try {
        return await forward(async c => {
          const result = await action(c)
          const effect = await c.query('select id from event_move_effects where proposal_id=$1 and action=$2', [p.id, 'apply'])
          if (effect.rows.length && !deleteCompleted) {
            callbackReturned = true
            removed = await h.raw('vendor_busy_dates', 'id=$1', [manual.id], c)
            expect(removed).toEqual(manual.raw)
            const changed = await c.query("delete from vendor_busy_dates where id=$1 and vendor_id=$2 and source='manual' returning id", [manual.id, m.f.company.id])
            expect(changed.rows).toEqual([{ id: manual.id }]); deleteCompleted = true
            expect(await h.raw('vendor_busy_dates', 'id=$1', [manual.id], c)).toEqual([])
            emit('M16_COMMIT_PRE', { callbackReturned, deleteCompleted, effect: effect.rows, manual, removed })
          }
          return result
        })
      } catch (error) { actual = error as { code?: string; constraint?: string }; throw error }
    }
    try { r = await apply(m, p, key) } finally { database.tx = original }
    emit('M16_OUTER_COMMIT', { proposal: p.id, callbackReturned, deleteCompleted, actual, status: r.statusCode, manual, before, after: await business(m.f) })
    expect(callbackReturned).toBe(true); expect(deleteCompleted, 'A BEFORE failure cannot stand in for completed DELETE plus outer COMMIT').toBe(true)
    expect(actual).toMatchObject({ code: '23514', constraint: 'event_move_complete' }); expect(r.statusCode).toBe(500)
    expect(await business(m.f)).toEqual(before); expect(await h.raw('vendor_busy_dates', 'id=$1', [manual.id])).toEqual(manual.raw)
    expect(await effects(p)).toEqual([]); await auditRefusal(m.f, audit)
    expect(ok<Proposal>(await apply(m, p, key)).status).toBe('applied'); expect(await effects(p)).toHaveLength(1)
    expect(await h.raw('vendor_busy_dates', 'id=$1', [manual.id])).toEqual(manual.raw)
  })

  it('M17 a real root-wide duty on ANOTHER event with NULL assignment is not lost by event-local discovery', async () => {
    const m = await setup(), root = m.roots[0]!, other = await h.event(m.f.wedding, m.f.pair, OTHER_DATE, 'Asia/Yekaterinburg')
    const worker = await h.actor(); m.f.actors.push(worker.id)
    const owner = { userId: root.company.actor.id, sessionId: root.company.actor.sid, policyVersion: h.app.appConfig.policyVersion }
    const workerPrincipal = { userId: worker.id, sessionId: worker.sid, policyVersion: h.app.appConfig.policyVersion }
    // These existing principal-bound domain APIs have no registered HTTP
    // route. This is explicitly native setup, not invented public coverage.
    const invited = await h.db.tx(c => inviteStaff(c, { vendorId: root.company.id, actor: owner, role: 'worker', targetUserId: worker.id }))
    const member = await h.db.tx(c => acceptStaffInvite(c, { token: invited.token, actor: workerPrincipal }))
    expect(member).toMatchObject({ state: 'active', userId: worker.id, vendorId: root.company.id })
    const duty = await h.db.tx(c => createStaffDuty(c, { vendorId: root.company.id, actor: owner, weddingId: m.f.wedding,
      dealId: root.deal, memberId: member.id, programEventId: other.id, assignmentId: null,
      role: 'performer', label: 'Synthetic actual root-wide other-event obligation' }))
    expect(duty).toMatchObject({ dealId: root.deal, programEventId: other.id, assignmentId: null, revokedAt: null })
    const witness = (await h.db.query(`select duty.id,duty.deal_id,duty.program_event_id,duty.assignment_id,duty.revoked_at,
      m.state,m.user_id,m.accepted_session_id from vendor_staff_duties duty
      join vendor_staff_members m on m.vendor_id=duty.vendor_id and m.id=duty.member_id
      where duty.id=$1 and duty.wedding_id=$2 and duty.vendor_id=$3`, [duty.id, m.f.wedding, root.company.id])).rows
    expect(witness).toEqual([expect.objectContaining({ id: duty.id, deal_id: root.deal, program_event_id: other.id,
      assignment_id: null, revoked_at: null, state: 'active', user_id: worker.id, accepted_session_id: worker.sid })])
    expect(await h.raw('order_assignments', 'deal_id=$1', [root.deal])).toEqual([])
    const rows = await h.raw('vendor_staff_duties', 'id=$1', [duty.id]), money = await financial(root.deal), etag = await version(m.f)
    await refusal(m.f, 'M17_OTHER_EVENT_ROOT_DUTY', () => h.call('M17_OTHER_EVENT_ROOT_DUTY', m.f.pair,
      { method: 'POST', url: base(m.f), key: randomUUID(), headers: { 'if-match': etag }, payload: target() }), 409, 'event_move_scope_incomplete')
    expect(await h.raw('vendor_staff_duties', 'id=$1', [duty.id])).toEqual(rows); expect(await financial(root.deal)).toEqual(money)
    for (const table of MOVE_TABLES) expect(await h.raw(table, 'wedding_id=$1', [m.f.wedding])).toEqual([])
    emit('M17_NATIVE_PRINCIPAL_DUTY', { member, witness, rows })
  })

  it('M18 genuine 600-second expired proof, another SID/party and helper/coordinator private attempts preserve the whole scope', async () => {
    const m = await setup(), root = m.roots[0]!, helpers: Actor[] = []
    for (const role of ['helper', 'coordinator'] as const) {
      const actor = await h.actor(); m.f.actors.push(actor.id); helpers.push(actor)
      await h.db.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [m.f.wedding, actor.id, role])
    }
    const secret = h.app.appConfig.jwtAccessSecret; assert(secret)
    const sid = randomUUID()
    await h.db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, m.f.pair.id, randomUUID()])
    const otherSession: Actor = { id: m.f.pair.id, sid, token: await signAccessToken(secret, { sub: m.f.pair.id, sid }) }
    const p = await propose(m), current = await readRoot(m, p, root, m.f.pair); assert(current.readToken)
    expect(EVENT_MOVE_READ_TTL_SECONDS).toBe(600)
    const issuedAt = new Date(Date.now() - (EVENT_MOVE_READ_TTL_SECONDS + 30) * 1000)
    const claims = { purpose: 'event-move-read' as const, weddingId: m.f.wedding, dealId: root.deal, proposalId: p.id,
      digest: current.digest, userId: m.f.pair.id, sessionId: m.f.pair.sid, policyVersion: h.app.appConfig.policyVersion, party: 'customer' as const }
    const expired = await signEventMoveRead(secret, claims, issuedAt)
    await refusal(m.f, 'M18_EXPIRED_REAL_PROOF', () => h.call('M18_EXPIRED_REAL_PROOF', m.f.pair,
      { method: 'POST', url: rootUrl(p, root.deal) + '/accept', key: randomUUID(), payload: { digest: current.digest, readToken: expired } }), 409, 'event_move_read_expired')
    const alternative = await readRoot(m, p, root, otherSession); expect(alternative.readToken).toBeTypeOf('string')
    await refusal(m.f, 'M18_OTHER_CURRENT_SID', () => h.call('M18_OTHER_CURRENT_SID', otherSession,
      { method: 'POST', url: rootUrl(p, root.deal) + '/accept', key: randomUUID(), payload: { digest: current.digest, readToken: current.readToken! } }), 422, 'validation_failed')
    const wrongParty = await signEventMoveRead(secret, { ...claims, party: 'performer' }, new Date())
    await refusal(m.f, 'M18_WRONG_ACTUAL_PARTY', () => h.call('M18_WRONG_ACTUAL_PARTY', m.f.pair,
      { method: 'POST', url: rootUrl(p, root.deal) + '/accept', key: randomUUID(), payload: { digest: current.digest, readToken: wrongParty } }), 422, 'validation_failed')
    for (const [index, actor] of helpers.entries()) {
      const label = index === 0 ? 'M18_HELPER' : 'M18_COORDINATOR'
      await refusal(m.f, label + '_PRIVATE_READ', () => h.call(label + '_PRIVATE_READ', actor,
        { method: 'GET', url: rootUrl(p, root.deal) }), 404, 'not_found')
      await refusal(m.f, label + '_PRIVATE_ACCEPT', () => h.call(label + '_PRIVATE_ACCEPT', actor,
        { method: 'POST', url: rootUrl(p, root.deal) + '/accept', key: randomUUID(), payload: { digest: current.digest, readToken: current.readToken! } }), 404, 'not_found')
    }
    expect(await h.raw('event_move_receipts', 'proposal_id=$1', [p.id])).toEqual([]); expect(await effects(p)).toEqual([])
    // A fresh current proof remains valid; expiry/ACL assertions did not turn
    // the proposal or principal into a broken setup.
    const accepted = await accept(m, p, root, m.f.pair, 'customer')
    expect(accepted.receipts).toHaveLength(1)
    emit('M18_PROOF_CLOCK_AND_PRINCIPALS', { proposal: p.id, digest: current.digest, ttl: EVENT_MOVE_READ_TTL_SECONDS,
      issuedAt: issuedAt.toISOString(), originalSID: m.f.pair.sid, otherCurrentSID: sid, helpers: helpers.map(a => a.id) })
  })

  it('M19 vendor/account export is own-root only while the current customer retains its complete own move history', async () => {
    const m = await setup(true, false, true), first = m.roots[0]!, second = m.roots[1]!
    const privateIds = await Promise.all(m.roots.map(root => privatePayment(m.f, root))), p = await propose(m)
    await agreed(m, p); expect(ok<Proposal>(await apply(m, p)).status).toBe('applied')
    const before = await business(m.f)
    type MoveExport = { eventMoveProposals: { id: string; digest: string }[];
      eventMoveRoots: { proposal_id: string; deal_id: string; material: ExpectedMaterial; digest: string }[];
      eventMoveReceipts: { id: string; proposal_id: string; deal_id: string }[];
      eventMoveEffects: { id: string; proposal_id: string; action: string }[] }
    const exports: { actor: string; value: MoveExport }[] = []
    for (const [own, foreign] of [[first, second], [second, first]] as const) {
      const view = await readRoot(m, p, own, own.company.actor)
      expect(view.status).toBe('applied'); expect(view.readToken).toBeNull()
      const response = await h.call('M19_VENDOR_ACCOUNT_EXPORT', own.company.actor, { method: 'GET', url: '/users/me/export' })
      const value = ok<MoveExport>(response), text = JSON.stringify(value)
      expect(value.eventMoveProposals).toEqual([])
      expect(value.eventMoveRoots).toHaveLength(1)
      expect(value.eventMoveRoots[0]).toStrictEqual({ proposal_id: p.id, deal_id: own.deal,
        material: expectedMaterials.get(p.id)!.get(own.deal)!, digest: view.digest })
      expect(value.eventMoveReceipts.map(r => r.id).sort()).toEqual(view.receipts.map(r => r.id).sort())
      expect(value.eventMoveReceipts.every(r => r.proposal_id === p.id && r.deal_id === own.deal)).toBe(true)
      expect(value.eventMoveEffects).toEqual([expect.objectContaining({ proposal_id: p.id, action: 'apply' })])
      expect(text).not.toContain(p.digest); expect(text).not.toContain(foreign.deal); expect(text).not.toContain(foreign.company.id)
      expect(text).not.toContain(String(foreign.price)); expect(text).not.toContain('read_proof_hash'); expect(text).not.toContain('canonical_payload')
      for (const ids of privateIds) { expect(text).not.toContain(ids.payment); expect(text).not.toContain(ids.stage) }
      const ownHistory = ok<{ id: string; eventId: string; status: string }[]>(await h.call('M19_VENDOR_OWN_ROOT_HISTORY', own.company.actor,
        { method: 'GET', url: `/deals/${own.deal}/event-moves` }))
      expect(ownHistory).toEqual([expect.objectContaining({ id: p.id, eventId: m.f.event.id, status: 'applied' })])
      await refusal(m.f, 'M19_VENDOR_FOREIGN_HISTORY', () => h.call('M19_VENDOR_FOREIGN_HISTORY', own.company.actor,
        { method: 'GET', url: `/deals/${foreign.deal}/event-moves` }), 404, 'not_found')
      exports.push({ actor: own.company.actor.id, value })
    }
    const customer = ok<MoveExport>(await h.call('M19_CUSTOMER_ACCOUNT_EXPORT', m.f.pair, { method: 'GET', url: '/users/me/export' }))
    expect(customer.eventMoveProposals).toEqual([expect.objectContaining({ id: p.id, digest: p.digest })])
    expect(customer.eventMoveRoots.map(r => r.deal_id).sort()).toEqual(m.roots.map(r => r.deal).sort())
    for (const row of customer.eventMoveRoots) expect(row.material).toStrictEqual(expectedMaterials.get(p.id)!.get(row.deal_id))
    expect(customer.eventMoveReceipts).toHaveLength(4); expect(customer.eventMoveEffects).toHaveLength(1)
    const history = ok<Proposal[]>(await h.call('M19_CUSTOMER_COMPLETE_HISTORY', m.f.pair, { method: 'GET', url: base(m.f) }))
    expect(history).toEqual([expect.objectContaining({ id: p.id, digest: p.digest, status: 'applied' })])
    expect(history[0]!.roots.map(r => r.dealId).sort()).toEqual(m.roots.map(r => r.deal).sort())
    expect(await business(m.f)).toEqual(before)
    emit('M19_OWN_EXPORTS', { proposal: p.id, exports, customer, privateIds, history })
  })

  it('M20 a genuine complete effect cannot resolve its own U after only ONE of TWO real heads is published', async () => {
    const f = await fixture(), secondSlot = await h.slot(f.wedding, f.pair, f.event), roots: Root[] = []
    // Honest untracked historical fixtures from their FIRST INSERT, never a
    // public booking stripped of its immutable head/history. The real kernel
    // subsequently observes them, preserving the old uncertain cohort.
    for (const [slot, price] of [[f.slot, 2468000], [secondSlot, 3141500]] as const) {
      const seeded = await seedUntrackedSlotDeal(h.app, { weddingId: f.wedding, slotId: slot, vendorId: f.company.id, state: 'booked', price })
      dealIds.add(seeded.dealId); roots.push({ deal: seeded.dealId, slot, price, company: f.company })
    }
    expect(await h.raw('deal_day_scope_heads', 'wedding_id=$1', [f.wedding])).toEqual([])
    const oldDay = (await h.db.query<{ id: string }>("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2::date,'deal',$3) returning id",
      [f.company.id, f.event.date, roots[0]!.deal])).rows[0]!.id
    expect(await h.raw('legacy_day_groups', 'day_id=$1', [oldDay])).toEqual([])
    await h.db.tx(async c => {
      await prepareDayWriter(c, f.wedding)
      for (const root of [...roots].sort((a, b) => a.deal.localeCompare(b.deal))) await finishNewDayCommitment(c, f.wedding, root.deal, 'legacy_unknown')
    })
    const group = (await h.db.query<{ revision: string; legacy_candidates: string[]; classification: string }>(
      'select revision::text,legacy_candidates,classification from legacy_day_groups where day_id=$1', [oldDay])).rows[0]!
    expect(group.classification).toBe('legacy_unknown'); expect(group.legacy_candidates.slice().sort()).toEqual(roots.map(r => r.deal).sort())
    for (const root of roots) expect((await h.scope(f, root.deal))[0]).toMatchObject({ day_id: oldDay,
      context_kind: 'explicit_event', binding_state: 'active', matches_current: true, exact_head: true })
    const m: MoveCase = { f, roots }, p = await propose(m); await agreed(m, p)
    const before = await business(f), audit = await ownAudit(f), key = randomUUID(), database = h.db
    const original = database.tx, forward = database.tx.bind(database)
    let attempted = false, actual: { code?: string; constraint?: string } | undefined, r!: Reply
    database.tx = async <T>(action: (c: Queryable) => Promise<T>) => {
      try {
        return await forward(c => action({ query: async <R extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
          const result = await c.query<R>(sql, values)
          if (!attempted && /^\s*update deal_day_scope_heads\b/i.test(sql) && result.rowCount === 1) {
            const effect = (await c.query<{ id: string; transaction_id: string; backend_pid: number; genuine: boolean; planned_versions: unknown[] }>(
              `select id,transaction_id::text,backend_pid,planned_versions,transaction_id=txid_current()
                and backend_pid=pg_backend_pid() and legacy_day_transaction_owns(xmin) genuine
               from event_move_effects where proposal_id=$1 and action='apply'`, [p.id])).rows
            if (effect.length) {
              expect(effect).toHaveLength(1); expect(effect[0]!.genuine).toBe(true); expect(effect[0]!.planned_versions).toHaveLength(2)
              const published = (await c.query<{ deal_id: string; id: string; old_day: string }>(`select v.deal_id,v.id,prev.day_id old_day
                from event_move_effects e cross join lateral jsonb_array_elements(e.planned_versions) plan
                join deal_day_scope_heads h on h.deal_id=(plan->>'dealId')::uuid and h.wedding_id=e.wedding_id
                join deal_day_scope_versions v on v.id=h.current_version_id and v.id=(plan->>'versionId')::uuid and v.revision=h.revision
                join deal_day_scope_versions prev on prev.id=v.previous_version_id
                where e.proposal_id=$1 and e.action='apply' order by v.deal_id`, [p.id])).rows
              expect(published).toHaveLength(1); expect(published[0]!.old_day).toBe(oldDay)
              const currentGroup = (await c.query<{ revision: string; legacy_candidates: string[] }>(
                'select revision::text,legacy_candidates from legacy_day_groups where day_id=$1 for update', [oldDay])).rows[0]!
              expect(currentGroup.legacy_candidates).toContain(published[0]!.deal_id)
              attempted = true
              emit('M20_HALF_HEADS_PRE_RESOLUTION', { proposal: p.id, effect, published, oldDay, currentGroup })
              // Intentionally EARLY native command. Every production query up
              // to this barrier was forwarded; no kernel was reimplemented.
              await c.query("select legacy_day_resolve($1,$2,$3::bigint,$4,'event_move')",
                [oldDay, published[0]!.deal_id, currentGroup.revision, published[0]!.id])
              assert.fail('An early own-U resolution must not pass with half the genuine planned heads')
            }
          }
          return result
        } }))
      } catch (error) { actual = error as { code?: string; constraint?: string }; throw error }
    }
    try { r = await apply(m, p, key) } finally { database.tx = original }
    emit('M20_IMMEDIATE_HEADS_BARRIER', { proposal: p.id, attempted, actual, status: r.statusCode, before, after: await business(f) })
    expect(attempted, 'The real complete effect plus 1/2 head publication must be reached').toBe(true)
    expect(actual).toMatchObject({ code: '23514', constraint: 'legacy_day_group_resolution' }); expect(r.statusCode).toBe(500)
    expect(await business(f)).toEqual(before); expect(await effects(p)).toEqual([]); await auditRefusal(f, audit)
    expect(ok<Proposal>(await apply(m, p, key)).status).toBe('applied'); expect(await effects(p)).toHaveLength(1)
    expect((await h.db.query('select id from vendor_busy_dates where id=$1', [oldDay])).rows).toEqual([])
  }, 60000)

  it('M21 flushed final checks are re-enqueued by a late closed offer or request mutation at outer COMMIT', async () => {
    for (const changedTable of ['offers', 'offer_requests'] as const) {
      const m = await setup(), requestId = randomUUID(), offerId = randomUUID()
      // Valid native closed quote history predates the immutable proposal.
      // No open request, fake public response or disabled trigger is used.
      await h.db.tx(async c => {
        const request = await c.query(`insert into offer_requests(id,slot_id,vendor_id,status,close_reason,closed_at,wedding_date,created_by,wishes,program_event_context)
          select $1,s.id,$3,'closed','booked',clock_timestamp(),e.date,$4,'Original retained wishes',
            jsonb_build_object('id',e.id,'isMain',e.is_main,'date',e.date,'timeZone',e.time_zone,'name',e.name,'kind',e.kind,'location',e.location)
          from slots s join wedding_events e on e.id=s.program_event_id and e.wedding_id=s.wedding_id
          where s.id=$2 and e.id=$5 and s.wedding_id=$6 returning id`,
        [requestId, m.f.slot, m.f.company.id, m.f.pair.id, m.f.event.id, m.f.wedding])
        expect(request.rows).toEqual([{ id: requestId }])
        await c.query(`insert into offers(id,request_id,kind,message,created_by)
          values($1,$2,'decline','Original retained offer message',$3)`, [offerId, requestId, m.f.company.actor.id])
      })
      const p = await propose(m); await agreed(m, p)
      const before = await business(m.f), audit = await ownAudit(m.f), key = randomUUID(), database = h.db
      const original = database.tx, forward = database.tx.bind(database)
      let callbackReturned = false, flushed = false, mutationCompleted = false
      let actual: { code?: string; constraint?: string } | undefined, r!: Reply
      database.tx = async <T>(action: (c: Queryable) => Promise<T>) => {
        try {
          return await forward(async c => {
            const result = await action(c)
            const effect = await c.query("select id from event_move_effects where proposal_id=$1 and action='apply'", [p.id])
            if (effect.rows.length && !mutationCompleted) {
              callbackReturned = true
              await c.query('set constraints event_move_complete immediate'); flushed = true
              // Restore deferred mode so the changed row must enqueue a NEW
              // check, and the observed failure belongs to the outer COMMIT.
              await c.query('set constraints event_move_complete deferred')
              const changed = changedTable === 'offers'
                ? await c.query("update offers set message='Late native offer mutation' where id=$1 returning id", [offerId])
                : await c.query("update offer_requests set wishes='Late native request mutation' where id=$1 returning id", [requestId])
              expect(changed.rows).toEqual([{ id: changedTable === 'offers' ? offerId : requestId }]); mutationCompleted = true
              emit('M21_FLUSHED_CALLBACK_PRE_COMMIT', { changedTable, callbackReturned, flushed, mutationCompleted, effect: effect.rows })
            }
            return result
          })
        } catch (error) { actual = error as { code?: string; constraint?: string }; throw error }
      }
      try { r = await apply(m, p, key) } finally { database.tx = original }
      emit('M21_OUTER_COMMIT', { changedTable, callbackReturned, flushed, mutationCompleted, actual, status: r.statusCode, before, after: await business(m.f) })
      expect(callbackReturned).toBe(true); expect(flushed).toBe(true); expect(mutationCompleted).toBe(true)
      expect(actual).toMatchObject({ code: '23514', constraint: 'event_move_complete' }); expect(r.statusCode).toBe(500)
      expect(await business(m.f)).toEqual(before); expect(await effects(p)).toEqual([]); await auditRefusal(m.f, audit)
      expect(ok<Proposal>(await apply(m, p, key)).status).toBe('applied'); expect(await effects(p)).toHaveLength(1)
    }
  }, 60000)

  it('M22 unknown historical price refuses before history while a known zero remains an exact zero', async () => {
    const m = await setup(), root = m.roots[0]!
    await h.db.tx(c => c.query('update deals set price=null where id=$1 and wedding_id=$2', [root.deal, m.f.wedding]))
    expect((await h.db.query('select price from deals where id=$1', [root.deal])).rows).toEqual([{ price: null }])
    expect((await h.scope(m.f, root.deal))[0]).toMatchObject({ exact_head: true, matches_current: true, binding_state: 'active' })
    const etag = await version(m.f)
    await refusal(m.f, 'M22_UNKNOWN_MONEY', () => h.call('M22_UNKNOWN_MONEY', m.f.pair,
      { method: 'POST', url: base(m.f), key: randomUUID(), headers: { 'if-match': etag }, payload: target() }), 409, 'event_move_scope_incomplete')
    for (const table of MOVE_TABLES) expect(await h.raw(table, 'wedding_id=$1', [m.f.wedding])).toEqual([])
    await h.db.tx(c => c.query('update deals set price=$3::bigint where id=$1 and wedding_id=$2', [root.deal, m.f.wedding, '9007199254740993']))
    expect((await h.db.query('select price::text from deals where id=$1', [root.deal])).rows).toEqual([{ price: '9007199254740993' }])
    await refusal(m.f, 'M22_UNREPRESENTABLE_MONEY', () => h.call('M22_UNREPRESENTABLE_MONEY', m.f.pair,
      { method: 'POST', url: base(m.f), key: randomUUID(), headers: { 'if-match': etag }, payload: target() }), 409, 'event_move_scope_incomplete')
    for (const table of MOVE_TABLES) expect(await h.raw(table, 'wedding_id=$1', [m.f.wedding])).toEqual([])
    // Legal historical zero is a native fact, not a fallback for unknown money.
    await h.db.tx(c => c.query('update deals set price=0 where id=$1 and wedding_id=$2', [root.deal, m.f.wedding]))
    const before = await operational(m.f)
    const p = ok<Proposal>(await h.call('M22_KNOWN_ZERO', m.f.pair,
      { method: 'POST', url: base(m.f), key: randomUUID(), headers: { 'if-match': await version(m.f) }, payload: target() }), 201)
    proposalIds.add(p.id); expect(p.status).toBe('pending'); expect(p.roots.map(row => row.dealId)).toEqual([root.deal])
    const view = ok<RootView>(await h.call('M22_READ_ZERO_MATERIAL', m.f.pair, { method: 'GET', url: rootUrl(p, root.deal) }))
    expect(view.material.economics).toMatchObject({ amount: 0, currency: 'RUB', vendorId: m.f.company.id })
    expect(await operational(m.f)).toEqual(before)
    emit('M22_KNOWN_MONEY_SCOPE', { proposal: p.id, material: view.material, after: await operational(m.f) })
  })
})
