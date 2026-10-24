import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { Queryable } from '../../src/plugins/db.js'
import { AdditionalEventFixture, EVENT_TZ, OTHER_DATE, YEAR, ok, witness,
  type Actor, type Case, type Company, type ProgramEvent, type Raw, type Reply, type SlotReply } from './additionalEventFixture.js'

export { EVENT_TZ, OTHER_DATE, YEAR, ok, witness }
export type { Actor, Case, Company, ProgramEvent, Raw, Reply, SlotReply }
export const TARGET = { date: `${YEAR}-06-21`, timeZone: 'Asia/Novosibirsk', location: 'Synthetic first agreed DATE' }
export const nullWire = (event: ProgramEvent) => JSON.stringify({ id: event.id, date: event.date, timeZone: event.timeZone })
export const eventFields = (event: ProgramEvent) => ({ id: event.id, isMain: event.isMain, date: event.date,
  timeZone: event.timeZone, name: event.name, kind: event.kind, location: event.location })
export const moveBase = (f: Case) => `/weddings/${f.wedding}/events/${f.event.id}/move-proposals`
export const rootMove = (proposal: string, deal: string) => `/deals/${deal}/event-moves/${proposal}`
export const errorCode = (r: Reply) => r.json<{ error: { code: string } }>().error.code
export type Root = { deal: string; slot: string; company: Company; price: number }
export type MoveCase = { f: Case; roots: Root[] }
export type Receipt = { id: string; party: 'customer' | 'performer'; userId: string; sessionId: string; digest: string }
export type Proposal = { id: string; eventId: string; digest: string; status: string;
  from: { date: string | null; timeZone: string; location: string | null }; to: typeof TARGET;
  roots: { dealId: string; digest: string; receipts: Receipt[] }[] }
export type RootView = { id: string; dealId: string; eventId: string; digest: string;
  material: Record<string, unknown>; readToken: string | null; receipts: Receipt[]; status: string }

/** Public nullable-wire adapter and raw fixture observations, not a business implementation. */
export class UndatedFixture extends AdditionalEventFixture {
  private readonly materials = new Map<string, Map<string, Record<string, unknown>>>()
  private readonly scopes = new Map<string, string>()

  async fresh(mainBooking = false) {
    const f = await this.fixture({ date: null, timeZone: EVENT_TZ, mainBooking })
    this.scopes.set(f.wedding, f.pair.id); return f
  }
  async close() {
    try {
      if (this.app?.db && this.scopes.size) {
        const audit = await this.raw('audit_log', 'true', [])
        await this.db.tx(async client => {
          for (const [wedding, owner] of this.scopes) await client.query('delete from weddings where id=$1 and owner_id=$2', [wedding, owner])
        })
        for (const table of ['event_move_proposals', 'event_move_roots', 'event_move_receipts', 'event_move_effects']) {
          expect(await this.raw(table, 'wedding_id=any($1::uuid[])', [[...this.scopes.keys()]])).toEqual([])
        }
        const retained = new Set(await this.raw('audit_log', 'true', []))
        for (const row of audit) expect(retained.has(row), 'Every observed audit survives own parent cleanup').toBe(true)
        witness('UNDATED_MOVE_CLEANUP', { weddings: [...this.scopes.keys()], auditRowsRetained: audit })
      }
    } finally { await super.close() }
  }
  acquire(f: Case, options: { slot?: string; company?: Company; price?: number; key?: string;
    actor?: Actor; wire?: string | null; event?: ProgramEvent } = {}) {
    return this.call('UNDATED_BOOK', options.actor ?? f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/slots/${options.slot ?? f.slot}/book`, key: options.key ?? randomUUID(),
      context: Object.hasOwn(options, 'wire') ? options.wire : nullWire(options.event ?? f.event),
      payload: { vendorId: (options.company ?? f.company).id, price: { amount: options.price ?? 2468000, currency: 'RUB' } } })
  }
  async acquiredNull(f: Case, r: Reply, options: { slot?: string; company?: Company; price?: number } = {}): Promise<Root> {
    const slot = options.slot ?? f.slot, company = options.company ?? f.company, price = options.price ?? 2468000
    const roots = (await this.db.query<{ id: string; state: string; price: string; currency: string }>(
      'select id,state,price::text,currency from deals where wedding_id=$1 and slot_id=$2 order by id', [f.wedding, slot])).rows
    witness('UNDATED_ACQUIRE', { response: { status: r.statusCode, body: r.body }, roots, slot, event: f.event })
    expect(r.statusCode, r.body).toBe(200); expect(roots).toHaveLength(1)
    const deal = roots[0]!.id
    expect(roots[0]).toMatchObject({ state: 'booked', price: String(price), currency: 'RUB' })
    expect(ok<SlotReply>(r)).toMatchObject({ id: slot, deal: { id: deal, state: 'booked' } })
    expect(await this.scope(f, deal)).toEqual([expect.objectContaining({ deal_id: deal, slot_id: slot,
      revision: '1', previous_version_id: null, operation: 'acquire', origin_knowledge: 'observed_tracking',
      context_kind: 'explicit_event', event_id: f.event.id, performer_kind: 'catalog', vendor_id: company.id,
      binding_state: 'undated', service_date: null, time_zone: EVENT_TZ, day_id: null, exact_head: true, matches_current: true })])
    expect(await this.raw('vendor_busy_dates', 'deal_id=$1', [deal])).toEqual([])
    return { deal, slot, company, price }
  }
  async snapshot(f: Case): Promise<Raw> {
    const raw = await super.snapshot(f)
    for (const table of ['event_move_proposals', 'event_move_roots', 'event_move_receipts', 'event_move_effects', 'vendor_staff_duties']) {
      raw[table] = await this.raw(table, 'wedding_id=$1', [f.wedding])
    }
    raw.payment_receipts = await this.raw('payment_receipts',
      'payment_id in(select p.id from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1)', [f.wedding])
    return raw
  }
  async operational(f: Case): Promise<Raw> {
    const raw = await this.snapshot(f)
    for (const key of ['audit', 'idempotency_keys', 'notifications', 'event_move_proposals',
      'event_move_roots', 'event_move_receipts', 'event_move_effects']) delete raw[key]
    return raw
  }
  async money(deal: string): Promise<Raw> {
    const raw: Raw = { deals: await this.raw('deals', 'id=$1', [deal]) }
    for (const table of ['deal_orders', 'deal_events', 'payments', 'payment_installments', 'payment_corrections',
      'payment_installment_edits', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts',
      'deal_resource_plan_versions', 'deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members']) {
      raw[table] = await this.raw(table, 'deal_id=$1', [deal])
    }
    raw.payment_receipts = await this.raw('payment_receipts', 'payment_id in(select id from payments where deal_id=$1)', [deal])
    return raw
  }
  async economic(deal: string): Promise<Raw> {
    const raw: Raw = { agreedMoney: (await this.db.query(`select price::text,currency,package_id,
      package_title_snapshot,package_includes_snapshot,offer_comparison_terms_snapshot from deals where id=$1`, [deal])).rows.map(row => JSON.stringify(row)) }
    for (const table of ['payments', 'payment_installments', 'payment_corrections', 'payment_installment_edits']) {
      raw[table] = await this.raw(table, 'deal_id=$1', [deal])
    }
    raw.payment_receipts = await this.raw('payment_receipts', 'payment_id in(select id from payments where deal_id=$1)', [deal])
    return raw
  }
  async refusal(f: Case, label: string, action: () => Promise<Reply>, status: number, code?: string) {
    const before = await this.snapshot(f), r = await action(), after = await this.snapshot(f)
    witness('UNDATED_REFUSAL', { label, status: r.statusCode, body: r.body, before, after })
    expect(r.statusCode, r.body).toBe(status)
    if (code !== undefined) expect(errorCode(r)).toBe(code)
    else expect(errorCode(r)).toBeTypeOf('string') // Contract pins this status, not a newly invented error code.
    expect(after).toEqual(before)
    return r
  }
  async version(f: Case) {
    const r = await this.call('UNDATED_EVENTS_VERSION', f.pair, { method: 'GET', url: `/weddings/${f.wedding}/events` })
    ok(r); assert.equal(typeof r.headers.etag, 'string'); return r.headers.etag as string
  }
  async patchEvent(f: Case, payload: object) {
    return this.call('UNDATED_EVENT_PATCH', f.pair, { method: 'PATCH', url: `/weddings/${f.wedding}/events/${f.event.id}`,
      headers: { 'if-match': await this.version(f) }, payload })
  }
  state(f: Case, deal: string, state: string, wire: string | null = nullWire(f.event), key = randomUUID()) {
    return this.call('UNDATED_STATE_' + state, f.pair, { method: 'PATCH', url: `/deals/${deal}`, key, context: wire, payload: { state } })
  }
  async request(f: Case, slot = f.slot) {
    const entry = ok<{ id: string; slotId: string }>(await this.call('UNDATED_SHORTLIST', f.pair, {
      method: 'PUT', url: `/weddings/${f.wedding}/shortlist/${f.company.id}`, payload: { slotId: slot } }))
    expect(entry.slotId).toBe(slot)
    const result = ok<{ results: { entryId: string; status: string; requestId?: string }[] }>(await this.call('UNDATED_REQUEST', f.pair, {
      method: 'POST', url: `/weddings/${f.wedding}/slots/${slot}/offer-requests`, key: randomUUID(),
      context: nullWire(f.event), payload: { entryIds: [entry.id] } }), 201)
    const sent = result.results.find(row => row.entryId === entry.id); assert(sent?.requestId); expect(sent.status).toBe('sent')
    const request = (await this.db.query('select wedding_date::text,program_event_context from offer_requests where id=$1', [sent.requestId])).rows
    expect(request).toEqual([{ wedding_date: null, program_event_context: eventFields(f.event) }])
    return sent.requestId
  }
  reply(f: Case, request: string) {
    return this.call('UNDATED_VENDOR_REPLY', f.company.actor, { method: 'POST', url: `/vendor/offer-requests/${request}/offers`,
      key: randomUUID(), payload: { kind: 'offer', title: 'Synthetic own undated quote', includes: ['Own undated coverage'],
        price: { amount: 314159, currency: 'RUB' }, validUntil: `${YEAR}-06-25` } })
  }
  async quote(f: Case, slot = f.slot) {
    const request = await this.request(f, slot)
    const inbox = ok<{ id: string; weddingDate: string | null; programEvent: unknown }[]>(await this.call('UNDATED_VENDOR_INBOX',
      f.company.actor, { method: 'GET', url: '/vendor/offer-requests' }))
    expect(inbox.find(row => row.id === request)).toMatchObject({ id: request, weddingDate: null, programEvent: eventFields(f.event) })
    const offer = ok<{ id: string }>(await this.reply(f, request), 201)
    return { request, offer: offer.id }
  }
  acceptQuote(f: Case, offer: string, key = randomUUID(), wire = nullWire(f.event)) {
    return this.call('UNDATED_QUOTE_ACCEPT', f.pair, { method: 'POST', url: `/weddings/${f.wedding}/offers/${offer}/accept`,
      key, context: wire })
  }
  async setup(two = false, mainBooking = false, differentCompany = false): Promise<MoveCase> {
    const f = await this.fresh(mainBooking), roots = [await this.acquiredNull(f, await this.acquire(f))]
    if (two) {
      const slot = await this.slot(f.wedding, f.pair, f.event), company = differentCompany ? await this.company(f) : f.company
      const options = { slot, company, price: 3456700 }
      roots.push(await this.acquiredNull(f, await this.acquire(f, options), options))
    }
    return { f, roots }
  }
  async material(m: MoveCase, root: Root, to = TARGET): Promise<Record<string, unknown>> {
    const event = (await this.db.query<ProgramEvent>(`select id,name,kind,date::text,time_zone as "timeZone",
      location,is_main as "isMain" from wedding_events where wedding_id=$1 and id=$2`, [m.f.wedding, m.f.event.id])).rows[0]
    assert(event && !event.isMain && event.date === null && event.timeZone === EVENT_TZ)
    const economics = (await this.db.query<{ price: string; currency: string; vendor_id: string;
      package_title_snapshot: string | null; package_includes_snapshot: string[] | null; offer_comparison_terms_snapshot: unknown }>(
      `select price::text,currency,vendor_id,package_title_snapshot,package_includes_snapshot,offer_comparison_terms_snapshot
      from deals where wedding_id=$1 and id=$2 and slot_id=$3`, [m.f.wedding, root.deal, root.slot])).rows[0]
    assert(economics && economics.price !== null)
    const amount = Number(economics.price); assert(Number.isSafeInteger(amount) && BigInt(amount) === BigInt(economics.price))
    const assignments = (await this.db.query(`select id,slot_id as "slotId",program_event_id as "eventId",label from order_assignments
      where wedding_id=$1 and deal_id=$2 and cancelled_at is null order by id`, [m.f.wedding, root.deal])).rows
    return { schemaVersion: 1, dealId: root.deal, event: { id: event.id, name: event.name, kind: event.kind,
      from: { date: null, timeZone: EVENT_TZ, location: event.location }, to: { ...to } },
      economics: { amount, currency: economics.currency, vendorId: economics.vendor_id,
        packageTitle: economics.package_title_snapshot, packageIncludes: economics.package_includes_snapshot,
        comparisonTerms: economics.offer_comparison_terms_snapshot }, assignments,
      preserved: { price: true, payments: true, paymentDueDates: true, otherEvents: true } }
  }
  async proposeReply(m: MoveCase, to = TARGET, key = randomUUID()) {
    return this.call('UNDATED_FIRST_DATE_PROPOSE', m.f.pair, { method: 'POST', url: moveBase(m.f), key,
      headers: { 'if-match': await this.version(m.f) }, payload: to })
  }
  async propose(m: MoveCase, to = TARGET) {
    const baseline = new Map<string, Record<string, unknown>>()
    for (const root of m.roots) baseline.set(root.deal, await this.material(m, root, to))
    witness('UNDATED_MATERIAL_BEFORE_PROPOSAL', { roots: [...baseline], target: to })
    const p = ok<Proposal>(await this.proposeReply(m, to), 201)
    expect(p).toMatchObject({ status: 'pending', eventId: m.f.event.id,
      from: { date: null, timeZone: EVENT_TZ, location: m.f.event.location }, to })
    expect(p.roots.map(root => root.dealId).sort()).toEqual(m.roots.map(root => root.deal).sort())
    for (const [id, facts] of baseline) baseline.set(id, { ...facts, proposalId: p.id })
    this.materials.set(p.id, baseline); return p
  }
  async read(m: MoveCase, p: Proposal, root: Root, actor: Actor) {
    const r = await this.call('UNDATED_PRIVATE_READ', actor, { method: 'GET', url: rootMove(p.id, root.deal) })
    expect(r.headers['cache-control']).toContain('private'); expect(r.headers['cache-control']).toContain('no-store')
    const view = ok<RootView>(r), expected = this.materials.get(p.id)?.get(root.deal)
    assert(expected, 'Expected material must precede proposal and use independent native facts')
    expect(view).toMatchObject({ id: p.id, dealId: root.deal, eventId: m.f.event.id })
    expect(view.material).toStrictEqual(expected)
    expect(view.digest).toBe(p.roots.find(row => row.dealId === root.deal)!.digest)
    expect(view.digest).not.toBe(p.digest); expect(view.readToken).toBeTypeOf('string')
    witness('UNDATED_MATERIAL_EXACT', { root: root.deal, actor: actor.id, expected, actual: view.material, digest: view.digest })
    return view
  }
  async acceptMove(m: MoveCase, p: Proposal, root: Root, actor: Actor, party: Receipt['party']) {
    const view = await this.read(m, p, root, actor); assert(view.readToken)
    ok(await this.call('UNDATED_PRIVATE_ACCEPT', actor, { method: 'POST', url: rootMove(p.id, root.deal) + '/accept',
      key: randomUUID(), payload: { digest: view.digest, readToken: view.readToken } }))
    const current = await this.read(m, p, root, actor)
    expect(current.receipts.filter(row => row.party === party)).toEqual([
      expect.objectContaining({ party, userId: actor.id, sessionId: actor.sid, digest: view.digest })])
    return current
  }
  async agree(m: MoveCase, p: Proposal) {
    for (const root of m.roots) {
      await this.acceptMove(m, p, root, m.f.pair, 'customer')
      const current = await this.acceptMove(m, p, root, root.company.actor, 'performer')
      expect(current.receipts).toHaveLength(2)
      expect(current.receipts[0]!.userId).not.toBe(current.receipts[1]!.userId)
    }
  }
  apply(m: MoveCase, p: Proposal, key = randomUUID(), actor = m.f.pair) {
    return this.call('UNDATED_FIRST_DATE_APPLY', actor, { method: 'POST', url: moveBase(m.f) + `/${p.id}/apply`,
      key, payload: { digest: p.digest } })
  }
  async effects(p: Proposal) { return this.raw('event_move_effects', "proposal_id=$1 and action='apply'", [p.id]) }
  /** Always settle the owned blocker and request, including failed wait assertions. */
  async duringWait(f: Case, label: string, action: () => Promise<Reply>, mutate: (c: Queryable) => Promise<unknown>,
    whileHeld: () => Promise<void> = async () => undefined) {
    const held = await this.gate(f.wedding, mutate)
    let pending: Promise<Reply> | undefined, response: Reply | undefined, failure: unknown, failed = false, observed = false
    try { pending = action(); void pending.catch(() => undefined); await this.blocked(held.pid, label); observed = true; await whileHeld() }
    catch (error) { failure = error; failed = true }
    finally {
      held.unlock()
      const settled = await Promise.allSettled([held.done, ...(pending ? [pending] : [])])
      for (const row of settled) if (row.status === 'rejected') { if (!failed) failure = row.reason; failed = true }
      if (settled[1]?.status === 'fulfilled') response = settled[1].value as Reply
    }
    witness('UNDATED_WAIT_SETTLED', { label, observed, response: response && { status: response.statusCode, body: response.body } })
    if (failed) throw failure
    assert(observed && response); return response
  }
}
