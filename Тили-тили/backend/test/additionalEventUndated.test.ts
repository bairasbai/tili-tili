import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Queryable } from '../src/plugins/db.js'
import { seedUntrackedSlotDeal } from './helpers/dayFixture.js'
import { UndatedFixture, errorCode, nullWire, type Reply } from './helpers/additionalEventUndatedFixture.js'
import { AdditionalEventFixture, EVENT_TZ, MAIN_DATE, OTHER_DATE, ok, witness,
  type Raw, type SlotReply } from './helpers/additionalEventFixture.js'

const h = new AdditionalEventFixture()
const MAIN_PRICE = 1357900, EXTRA_PRICE = 2468000

/** Select literal saved rows by fixture identity, without a production projection. */
function ownRows(state: Raw, table: string, field: string, id: string): string[] {
  assert(state[table], 'Raw table must be present: ' + table)
  return state[table].filter(row => (JSON.parse(row) as Record<string, unknown>)[field] === id)
}

describe('undated additional catalog activation: independent public/native RED', () => {
  beforeAll(() => h.start())
  // The existing helper deletes only its registered parents and verifies that
  // every old and newly observed audit row remains literal, including on RED.
  afterAll(() => h.close())

  it('U0 books its exact NULL-date additional event without borrowing main DATE or changing main/sibling facts', async () => {
    const f = await h.fixture({ date: null, timeZone: EVENT_TZ })
    expect(f.event).toMatchObject({ date: null, timeZone: EVENT_TZ, isMain: false })
    expect(f.mainEvent.date).toBe(MAIN_DATE)
    expect(f.mainEvent.timeZone).not.toBe(EVENT_TZ)

    // This is a registered public booking, not an inserted/retrograded root.
    const mainResponse = await h.call('UNDATED_MAIN_POSITIVE', f.pair, {
      method: 'POST', url: `/weddings/${f.wedding}/slots/${f.mainSlot}/book`, key: randomUUID(),
      payload: { vendorId: f.company.id, price: { amount: MAIN_PRICE, currency: 'RUB' } },
    })
    const main = ok<SlotReply>(mainResponse)
    assert(main.deal)
    const mainDeal = main.deal.id
    f.mainDeal = mainDeal
    const mainRows = (await h.db.query<{ id: string; state: string; price: string; currency: string;
      vendor_id: string; selected: string }>(`select d.id,d.state,d.price::text,d.currency,d.vendor_id,s.deal_id selected
      from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
      where d.wedding_id=$1 and d.id=$2`, [f.wedding, mainDeal])).rows
    expect(mainRows).toEqual([{ id: mainDeal, state: 'booked', price: String(MAIN_PRICE), currency: 'RUB',
      vendor_id: f.company.id, selected: mainDeal }])
    const mainDays = (await h.db.query<{ id: string; date: string; source: string; deal_id: string }>(
      'select id,date::text,source,deal_id from vendor_busy_dates where vendor_id=$1 order by date,id', [f.company.id])).rows
    expect(mainDays).toHaveLength(1)
    expect(mainDays[0]).toMatchObject({ date: MAIN_DATE, source: 'deal', deal_id: mainDeal })
    witness('UNDATED_MAIN_CONTROL', { response: mainResponse.body, roots: mainRows, days: mainDays })

    const sibling = await h.event(f.wedding, f.pair, OTHER_DATE, 'Europe/Moscow')
    const siblingSlot = await h.slot(f.wedding, f.pair, sibling)
    expect(sibling.id).not.toBe(f.event.id)
    expect(siblingSlot).not.toBe(f.slot)

    const protectedFacts = (state: Raw) => {
      const out: Raw = {}
      for (const table of ['weddings', 'wedding_events', 'tasks', 'timeline_events', 'vendor_busy_dates',
        'legacy_day_groups', 'vendor_resources', 'vendor_availability_policy', 'resource_allocations']) {
        assert(state[table], 'Protected raw table must be present: ' + table)
        out[table] = state[table]
      }
      out.mainSlot = ownRows(state, 'slots', 'id', f.mainSlot)
      out.siblingSlot = ownRows(state, 'slots', 'id', siblingSlot)
      out.mainRoot = ownRows(state, 'deals', 'id', mainDeal)
      for (const table of ['deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions',
        'deal_terms_receipts', 'deal_resource_plan_versions', 'deal_resource_commitments',
        'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'deal_day_scope_versions',
        'deal_day_scope_heads', 'payments', 'payment_installments', 'payment_corrections',
        'payment_installment_edits', 'deal_events']) out[table] = ownRows(state, table, 'deal_id', mainDeal)
      return out
    }
    const before = await h.snapshot(f), protectedBefore = protectedFacts(before)
    const exactContext = JSON.stringify({ id: f.event.id, date: null, timeZone: EVENT_TZ })
    const key = randomUUID()
    // Use the existing public call's raw string support: its dated-only context()
    // constructor and acquired() assertion are deliberately not the new oracle.
    const response = await h.call('UNDATED_EXTRA_EXPECT_SUCCESS', f.pair, {
      method: 'POST', url: `/weddings/${f.wedding}/slots/${f.slot}/book`, key, context: exactContext,
      payload: { vendorId: f.company.id, price: { amount: EXTRA_PRICE, currency: 'RUB' } },
    })
    const roots = (await h.db.query<{ id: string; slot_id: string; vendor_id: string; state: string;
      price: string; currency: string }>(`select id,slot_id,vendor_id,state,price::text,currency from deals
      where wedding_id=$1 and slot_id=$2 order by id`, [f.wedding, f.slot])).rows
    const selected = (await h.db.query<{ deal_id: string | null; program_event_id: string }>(
      'select deal_id,program_event_id from slots where wedding_id=$1 and id=$2', [f.wedding, f.slot])).rows
    const versions = (await h.db.query<{ id: string; deal_id: string; slot_id: string; revision: string;
      previous_version_id: string | null; origin_knowledge: string; operation: string; context_kind: string;
      event_id: string; performer_kind: string; vendor_id: string; binding_state: string;
      service_date: string | null; time_zone: string; day_id: string | null; exact_head: boolean }>(
      `select v.id,v.deal_id,v.slot_id,v.revision::text,v.previous_version_id,v.origin_knowledge,v.operation,
      v.context_kind,v.event_id,v.performer_kind,v.vendor_id,v.binding_state,v.service_date::text,v.time_zone,v.day_id,
      h.current_version_id=v.id and h.revision=v.revision exact_head from deal_day_scope_versions v
      left join deal_day_scope_heads h on h.wedding_id=v.wedding_id and h.deal_id=v.deal_id
      where v.wedding_id=$1 and v.slot_id=$2 order by v.revision`, [f.wedding, f.slot])).rows
    const after = await h.snapshot(f), protectedAfter = protectedFacts(after)
    // Preserve the actual refusal/readback before the intentional expected-200
    // boundary. A setup/import/collection failure is not the meaningful RED.
    witness('UNDATED_EXPECT_SUCCESS', { mainPositiveControlPassed: true,
      fixture: { wedding: f.wedding, slot: f.slot, vendor: f.company.id, event: f.event,
        mainDeal, mainSlot: f.mainSlot, sibling, siblingSlot },
      expected: { status: 200, contextKind: 'explicit_event', bindingState: 'undated',
        date: null, timeZone: EVENT_TZ, dayId: null, price: String(EXTRA_PRICE) },
      key, exactContext, response: { status: response.statusCode, body: response.body },
      roots, selected, versions, before, after, protectedBefore, protectedAfter })

    expect(response.statusCode, 'U0 actual public NULL-date catalog acquisition: ' + response.body).toBe(200)
    expect(roots).toHaveLength(1)
    const root = roots[0]!
    expect(root).toMatchObject({ slot_id: f.slot, vendor_id: f.company.id, state: 'booked',
      price: String(EXTRA_PRICE), currency: 'RUB' })
    expect(selected).toEqual([{ deal_id: root.id, program_event_id: f.event.id }])
    expect(ok<SlotReply>(response)).toMatchObject({ id: f.slot, deal: { id: root.id, state: 'booked' } })
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ deal_id: root.id, slot_id: f.slot, revision: '1',
      previous_version_id: null, origin_knowledge: 'observed_tracking', operation: 'acquire',
      context_kind: 'explicit_event', event_id: f.event.id, performer_kind: 'catalog', vendor_id: f.company.id,
      binding_state: 'undated', service_date: null, time_zone: EVENT_TZ, day_id: null, exact_head: true })
    expect(ownRows(after, 'deal_orders', 'deal_id', root.id)).toHaveLength(1)
    expect(protectedAfter).toEqual(protectedBefore)
    expect(after.vendor_busy_dates).toEqual(before.vendor_busy_dates)
    expect(after.vendor_busy_dates).toHaveLength(1) // Only the genuine main DATE remains held.
    expect(ownRows(after, 'slots', 'id', siblingSlot)).toEqual(ownRows(before, 'slots', 'id', siblingSlot))
  })
})

describe('undated additional native shape before the forward migration', () => {
  const native = new AdditionalEventFixture()
  beforeAll(() => native.start())
  afterAll(() => native.close())

  it('U-SQL92 expected-success explicit_event undated acquire has valid real parents and a complete head', async () => {
    const f = await native.fixture({ date: null, timeZone: EVENT_TZ })
    // An explicitly untracked selected fixture from its first INSERT; never
    // retrograde a tracked root or delete its immutable history for this case.
    const { dealId } = await seedUntrackedSlotDeal(native.app, { weddingId: f.wedding, slotId: f.slot,
      vendorId: f.company.id, state: 'booked', price: 17000 })
    const parents = (await native.db.query(`select d.id,d.state,d.vendor_id,s.deal_id selected,
      s.program_event_id,e.id event_id,e.is_main,e.date::text,e.time_zone
      from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
      join wedding_events e on e.id=s.program_event_id and e.wedding_id=d.wedding_id
      join vendors v on v.id=d.vendor_id where d.wedding_id=$1 and d.id=$2`, [f.wedding, dealId])).rows
    expect(parents).toEqual([expect.objectContaining({ id: dealId, state: 'booked', vendor_id: f.company.id,
      selected: dealId, program_event_id: f.event.id, event_id: f.event.id, is_main: false, date: null, time_zone: EVENT_TZ })])
    const before = await native.snapshot(f), versionId = randomUUID()
    let insertedVersion = false, insertedHead = false, callbackCompleted = false, phase = 'BEGIN', error: unknown
    try {
      await native.db.tx(async client => {
        await client.query('select id from weddings where id=$1 for update', [f.wedding])
        await client.query('select legacy_day_lock_vendors(array[$1]::uuid[])', [f.company.id])
        phase = 'INSERT_VERSION'
        await client.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,
          previous_version_id,origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,
          binding_state,service_date,time_zone,day_id)
          values($1,$2,$3,$4,1,1,null,'observed_tracking','acquire','explicit_event',$5,'catalog',$6,'undated',null,$7,null)`,
        [versionId, f.wedding, dealId, f.slot, f.event.id, f.company.id, EVENT_TZ])
        insertedVersion = true; phase = 'INSERT_HEAD'
        await client.query(`insert into deal_day_scope_heads(wedding_id,deal_id,revision,current_version_id)
          values($1,$2,1,$3)`, [f.wedding, dealId, versionId])
        insertedHead = true; callbackCompleted = true; phase = 'OUTER_COMMIT'
      })
      phase = 'COMMITTED'
    } catch (caught) { error = caught }
    const after = await native.snapshot(f)
    witness('UNDATED_SQL_EXPECT_SUCCESS', { parents, expected: { committed: true, binding: 'undated',
      context: 'explicit_event', date: null, dayId: null, eventId: f.event.id, timeZone: EVENT_TZ },
      phase, insertedVersion, insertedHead, callbackCompleted,
      error: error && { code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint,
        message: (error as Error).message }, before, after })
    if (error) expect(after, 'Refused native shape must leave every prior raw row unchanged').toEqual(before)
    expect(error, 'Expected own explicit_event undated shape to COMMIT; actual phase=' + phase).toBeUndefined()
    expect(insertedVersion && insertedHead && callbackCompleted).toBe(true)
    expect((await native.scope(f, dealId))[0]).toMatchObject({ context_kind: 'explicit_event', binding_state: 'undated',
      service_date: null, time_zone: EVENT_TZ, day_id: null, event_id: f.event.id, exact_head: true, matches_current: true })
    expect(await native.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id])).toEqual([])
  })
})

describe('undated additional catalog public doors, current authority and atomicity', () => {
  const u = new UndatedFixture()
  beforeAll(() => u.start())
  afterAll(() => u.close())

  it('U1 genuine nullable shortlist/request/vendor reply/accept preserves all seven immutable event fields', async () => {
    const f = await u.fresh(), { request, offer } = await u.quote(f)
    const saved = await u.raw('offer_requests', 'id=$1', [request])
    const root = await u.acquiredNull(f, await u.acceptQuote(f, offer), { price: 314159 })
    expect((await u.db.query('select accepted_at is not null accepted,deal_id from offers where id=$1', [offer])).rows)
      .toEqual([{ accepted: true, deal_id: root.deal }])
    const after = (await u.db.query('select wedding_date::text,program_event_context from offer_requests where id=$1', [request])).rows
    const before = saved.map(raw => JSON.parse(raw) as { wedding_date: string | null; program_event_context: unknown })
    expect(after).toEqual(before.map(row => ({ wedding_date: row.wedding_date, program_event_context: row.program_event_context })))
    const snapshot = await u.snapshot(f)
    await expect(u.db.tx(c => c.query('update offer_requests set wedding_date=$2::date where id=$1', [request, OTHER_DATE])))
      .rejects.toMatchObject({ code: '23514', constraint: 'offer_request_event_context' })
    expect(await u.snapshot(f)).toEqual(snapshot)
  })

  it('U2 paid catalog replacement releases only its old NULL-date root, preserving real money and main hold', async () => {
    const f = await u.fresh(true), old = await u.acquiredNull(f, await u.acquire(f)), next = await u.company(f)
    ok(await u.call('UNDATED_OLD_PAY', f.pair, { method: 'POST', url: `/weddings/${f.wedding}/slots/${f.slot}/pay`, key: randomUUID(),
      payload: { amount: { amount: 1000, currency: 'RUB' } } }))
    const money = await u.economic(old.deal), main = await u.raw('deals', 'id=$1', [f.mainDeal])
    const days = await u.raw('vendor_busy_dates', 'vendor_id=any($1::uuid[])', [f.companies]), key = randomUUID()
    const action = () => u.call('UNDATED_REPLACE', f.pair, { method: 'POST', url: `/weddings/${f.wedding}/slots/${f.slot}/replace`,
      key, context: nullWire(f.event), payload: { expectedSelectedDealId: old.deal, expectedSelectedDealState: 'paid_deposit',
        vendorId: next.id, expectedPolicyRevision: '0', price: { amount: 271828, currency: 'RUB' } } })
    const result = ok<SlotReply>(await action()); assert(result.deal)
    expect(result.deal.id).not.toBe(old.deal)
    expect((await u.scope(f, old.deal))[0]).toMatchObject({ binding_state: 'released', day_id: null })
    expect((await u.scope(f, result.deal.id))[0]).toMatchObject({ context_kind: 'explicit_event', event_id: f.event.id,
      binding_state: 'undated', service_date: null, time_zone: EVENT_TZ, day_id: null, vendor_id: next.id })
    expect(await u.economic(old.deal)).toEqual(money); expect(await u.raw('deals', 'id=$1', [f.mainDeal])).toEqual(main)
    expect(await u.raw('vendor_busy_dates', 'vendor_id=any($1::uuid[])', [f.companies])).toEqual(days)
    const beforeReplay = await u.snapshot(f), replay = await action()
    expect(replay.statusCode).toBe(200); expect(replay.headers['idempotent-replay']).toBe('true')
    expect(await u.snapshot(f)).toEqual(beforeReplay)
  })

  const first = (['candidate', 'contacted', 'negotiating'] as const).flatMap(from =>
    (['booked', 'paid_deposit', 'done'] as const).map(to => ({ from, to })))
  it.each(first)('U3 selected catalog first-COMMITTED $from → $to preserves NULL DATE/TZ identity without a hold', async ({ from, to }) => {
    const f = await u.fresh(), seeded = await u.seed(f, from), money = await u.economic(seeded.dealId)
    const r = await u.state(f, seeded.dealId, to), ledger = await u.scope(f, seeded.dealId)
    witness('UNDATED_FIRST_COMMITTED', { from, to, status: r.statusCode, body: r.body, ledger, raw: await u.snapshot(f) })
    expect(r.statusCode, r.body).toBe(200); expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ revision: '1', previous_version_id: null, origin_knowledge: 'legacy_unknown',
      operation: to === 'done' ? 'observe_done' : 'acquire', context_kind: 'explicit_event', event_id: f.event.id,
      performer_kind: 'catalog', vendor_id: f.company.id, binding_state: to === 'done' ? 'done_undated' : 'undated',
      service_date: null, time_zone: EVENT_TZ, day_id: null, exact_head: true, matches_current: true })
    expect(await u.economic(seeded.dealId)).toEqual(money)
    expect(await u.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id])).toEqual([])
  })

  it.each(['booked', 'paid_deposit'] as const)('U4 tracked %s completion retains literal undated predecessor across a later MAIN date change', async from => {
    const f = await u.fresh(), root = await u.acquiredNull(f, await u.acquire(f))
    if (from === 'paid_deposit') ok(await u.state(f, root.deal, from))
    const economic = await u.economic(root.deal), predecessor = await u.raw('deal_day_scope_versions', 'deal_id=$1', [root.deal])
    ok(await u.state(f, root.deal, 'done'))
    const terminal = await u.raw('deal_day_scope_versions', 'deal_id=$1', [root.deal])
    expect(terminal).toHaveLength(2); expect(terminal).toEqual(expect.arrayContaining(predecessor))
    expect((await u.scope(f, root.deal))[0]).toMatchObject({ binding_state: 'done_undated', operation: 'retain_done',
      context_kind: 'explicit_event', service_date: null, time_zone: EVENT_TZ, day_id: null })
    ok(await u.call('MAIN_ONLY_DATE_CHANGE', f.pair, { method: 'PATCH', url: `/weddings/${f.wedding}`, key: randomUUID(), payload: { date: OTHER_DATE } }))
    expect(await u.raw('deal_day_scope_versions', 'deal_id=$1', [root.deal])).toEqual(terminal)
    expect(await u.economic(root.deal)).toEqual(economic)
    expect(await u.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id])).toEqual([])
  })

  it('U5 no-header cancel remains a release and cannot remove the independent main DATE', async () => {
    const f = await u.fresh(true), root = await u.acquiredNull(f, await u.acquire(f))
    const calendar = await u.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id]), money = await u.economic(root.deal)
    ok(await u.cancel(f))
    expect((await u.scope(f, root.deal))[0]).toMatchObject({ operation: 'release', binding_state: 'released', service_date: null, day_id: null })
    expect(await u.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id])).toEqual(calendar)
    expect(await u.economic(root.deal)).toEqual(money)
  })

  it.each(['missing date', 'empty date', 'string null', 'missing TZ', 'null TZ', 'extra field', 'JSON null'] as const)(
    'U6 malformed nullable wire %s refuses before any domain/receipt write', async kind => {
      const f = await u.fresh(), value: Record<string, unknown> = { id: f.event.id, date: null, timeZone: EVENT_TZ }
      if (kind === 'missing date') delete value.date
      if (kind === 'empty date') value.date = ''
      if (kind === 'string null') value.date = 'null'
      if (kind === 'missing TZ') delete value.timeZone
      if (kind === 'null TZ') value.timeZone = null
      if (kind === 'extra field') value.extra = true
      await u.refusal(f, kind, () => u.acquire(f, { wire: kind === 'JSON null' ? 'null' : JSON.stringify(value) }), 422, 'event_context_invalid')
    })
  it('U7 unknown DATE with known own TZ still requires an explicit exact header', async () => {
    const f = await u.fresh()
    await u.refusal(f, 'MISSING_NULL_HEADER', () => u.acquire(f, { wire: null }), 428, 'event_context_required')
    const foreign = await u.fresh()
    await u.refusal(f, 'FOREIGN_NULL_EVENT', () => u.acquire(f, { wire: nullWire(foreign.event) }), 409, 'event_context_changed')
  })
  it.each([null, OTHER_DATE])('U8 actual extra DATE=%s without its own TZ cannot borrow main/Moscow', async date => {
    const f = await u.fixture({ date, timeZone: null })
    const wire = JSON.stringify({ id: f.event.id, date, timeZone: EVENT_TZ })
    await u.refusal(f, 'UNKNOWN_OWN_TZ', () => u.acquire(f, { wire }), 409, 'event_context_incomplete')
  })

  it('U9 canonical NULL fingerprint replays once; changed date/TZ/event reuses no effect', async () => {
    const f = await u.fresh(), key = randomUUID(), first = await u.acquire(f, { key })
    await u.acquiredNull(f, first)
    const before = await u.snapshot(f)
    const retry = await u.acquire(f, { key, wire: JSON.stringify({ timeZone: EVENT_TZ, date: null, id: f.event.id.toUpperCase() }) })
    expect(retry.statusCode).toBe(200); expect(retry.json()).toEqual(first.json()); expect(retry.headers['idempotent-replay']).toBe('true')
    expect(await u.snapshot(f)).toEqual(before)
    for (const patch of [{ date: OTHER_DATE }, { timeZone: 'Europe/Moscow' }, { id: randomUUID() }]) {
      await u.refusal(f, 'NULL_INTENT_CHANGED', () => u.acquire(f, { key,
        wire: JSON.stringify({ id: f.event.id, date: null, timeZone: EVENT_TZ, ...patch }) }), 409, 'idempotency_key_reused')
    }
  })

  it('U10 discarded response recovers via actual public slots/order reads and the same key, with one effect', async () => {
    const f = await u.fresh(), key = randomUUID()
    await u.acquire(f, { key }) // Driver loses the observation, not a claimed TCP abort.
    const slots = ok<SlotReply[]>(await u.call('RECOVERY_SLOTS', f.pair, { method: 'GET', url: `/weddings/${f.wedding}/slots` }))
    const selected = slots.find(row => row.id === f.slot); assert(selected?.deal)
    const order = ok<{ dealId: string }>(await u.call('RECOVERY_ORDER', f.pair, { method: 'GET', url: `/deals/${selected.deal.id}/order` }))
    expect(order.dealId).toBe(selected.deal.id)
    const before = await u.snapshot(f), retry = await u.acquire(f, { key })
    expect(retry.statusCode).toBe(200); expect(retry.headers['idempotent-replay']).toBe('true')
    expect(await u.snapshot(f)).toEqual(before)
  })

  it('U11 a stale NULL header and old undated quote never inherit a newly assigned free-event DATE', async () => {
    const f = await u.fresh(), quote = await u.quote(f)
    const original = await u.raw('offer_requests', 'id=$1', [quote.request])
    ok(await u.patchEvent(f, { date: OTHER_DATE }))
    await u.refusal(f, 'STALE_NULL_BOOK', () => u.acquire(f), 409, 'event_context_changed')
    await u.refusal(f, 'STALE_NULL_REPLY', () => u.reply(f, quote.request), 409, 'offer_stale_date')
    await u.refusal(f, 'STALE_NULL_ACCEPT', () => u.acceptQuote(f, quote.offer, randomUUID(),
      JSON.stringify({ id: f.event.id, date: OTHER_DATE, timeZone: EVENT_TZ })), 409, 'offer_stale_date')
    const immutable = (rows: string[]) => rows.map(raw => {
      const row = JSON.parse(raw) as Record<string, unknown>
      return { slot: row.slot_id, date: row.wedding_date, snapshot: row.program_event_context }
    })
    expect(immutable(await u.raw('offer_requests', 'id=$1', [quote.request]))).toEqual(immutable(original))
  })

  it('U12 new undated external acquisition is409; lawful old external draft release and catalog replacement remain usable', async () => {
    const f = await u.fresh()
    await u.refusal(f, 'EXTERNAL_CREATE', () => u.call('EXTERNAL_CREATE', f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/slots/${f.slot}/external`, key: randomUUID(), context: nullWire(f.event),
      payload: { vendorName: 'Synthetic outside performer', price: { amount: 17000, currency: 'RUB' } } }), 409)
    const seeded = await seedUntrackedSlotDeal(u.app, { weddingId: f.wedding, slotId: f.slot,
      state: 'candidate', externalName: 'Synthetic pretracking outside performer', price: 17000 })
    await u.refusal(f, 'EXTERNAL_FIRST_COMMITTED', () => u.state(f, seeded.dealId, 'booked'), 409)
    const oldMoney = await u.economic(seeded.dealId)
    const next = ok<SlotReply>(await u.call('EXTERNAL_DRAFT_TO_CATALOG', f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/slots/${f.slot}/replace`, key: randomUUID(), context: nullWire(f.event),
      payload: { expectedSelectedDealId: seeded.dealId, expectedSelectedDealState: 'candidate', vendorId: f.company.id,
        expectedPolicyRevision: '0', price: { amount: 2468000, currency: 'RUB' } } }))
    assert(next.deal); expect(next.deal.id).not.toBe(seeded.dealId)
    expect((await u.scope(f, next.deal.id))[0]).toMatchObject({ binding_state: 'undated', day_id: null, performer_kind: 'catalog' })
    expect((await u.scope(f, seeded.dealId))[0]).toMatchObject({ binding_state: 'released', day_id: null })
    expect(await u.economic(seeded.dealId)).toEqual(oldMoney)
    ok(await u.cancel(f))
  })

  it.each(['helper', 'coordinator', 'vendor', 'outsider'] as const)('U13 current %s cannot acquire an own-known-TZ NULL-date catalog root', async role => {
    const f = await u.fresh(), actor = await u.actor(); f.actors.push(actor.id)
    if (role !== 'outsider') await u.db.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [f.wedding, actor.id, role])
    await u.refusal(f, 'ROLE_' + role, () => u.acquire(f, { actor }), role === 'outsider' ? 404 : 403, role === 'outsider' ? 'not_found' : 'forbidden')
  })
  it.each(['role', 'session', 'consent'] as const)('U14 actual wedding wait rechecks revoked %s without residual NULL-date writes', async change => {
    const f = await u.fresh(), before = await u.snapshot(f)
    const r = await u.duringWait(f, 'NULL_BOOK_REVOKE_' + change, () => u.acquire(f), async c => {
      if (change === 'role') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.wedding, f.pair.id])
      if (change === 'session') await c.query('update sessions set revoked_at=clock_timestamp() where id=$1 and user_id=$2', [f.pair.sid, f.pair.id])
      if (change === 'consent') await c.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1', [f.pair.id])
    })
    expect(r.statusCode, r.body).toBe(change === 'session' ? 401 : 403)
    expect(errorCode(r)).toBe(change === 'session' ? 'unauthorized' : 'forbidden')
    expect(await u.snapshot(f)).toEqual(before)
  })
  it('U15 saved success does not bypass current session revocation', async () => {
    const f = await u.fresh(), key = randomUUID(); await u.acquiredNull(f, await u.acquire(f, { key }))
    await u.db.query('update sessions set revoked_at=clock_timestamp() where id=$1', [f.pair.sid])
    await u.refusal(f, 'REPLAY_REVOKED', () => u.acquire(f, { key }), 401, 'unauthorized')
  })
  it('U16 concurrent exact key uses a real held wedding wait and creates one root/head/receipt', async () => {
    const f = await u.fresh(), key = randomUUID(); let duplicate: Promise<Reply> | undefined, first: Reply | undefined, inProgress: Reply | undefined
    try {
      first = await u.duringWait(f, 'TWO_NULL_COMMANDS_ONE_KEY', () => u.acquire(f, { key }), async () => undefined, async () => {
        duplicate = u.acquire(f, { key }); void duplicate.catch(() => undefined)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          inProgress = await Promise.race([duplicate, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Concurrent exact key did not return while the first command held the wedding mutex')), 5000)
          })])
          expect(inProgress.statusCode, inProgress.body).toBe(409); expect(errorCode(inProgress)).toBe('idempotency_in_progress')
        } finally { if (timer) clearTimeout(timer) }
      })
    } finally { if (duplicate) await Promise.allSettled([duplicate]) }
    assert(first && inProgress); expect([first.statusCode, inProgress.statusCode]).toEqual([200, 409])
    const root = await u.acquiredNull(f, first), scopedKey = `${f.pair.id}:slots.book:${key}`
    expect((await u.db.query('select id from deals where wedding_id=$1 and slot_id=$2', [f.wedding, f.slot])).rows).toHaveLength(1)
    const exact = async () => ({ root: await u.raw('deals', 'id=$1', [root.deal]),
      head: await u.raw('deal_day_scope_heads', 'deal_id=$1', [root.deal]), versions: await u.raw('deal_day_scope_versions', 'deal_id=$1', [root.deal]),
      receipt: await u.raw('idempotency_keys', 'key=$1 and user_id=$2 and route=$3', [scopedKey, f.pair.id, 'slots.book']) })
    const one = await exact(); for (const rows of Object.values(one)) expect(rows).toHaveLength(1)
    expect(await u.raw('idempotency_keys', 'user_id=$1 and route=$2', [f.pair.id, 'slots.book'])).toHaveLength(1)
    expect((await u.db.query('select status,body from idempotency_keys where key=$1 and user_id=$2 and route=$3',
      [scopedKey, f.pair.id, 'slots.book'])).rows).toEqual([{ status: 200, body: first.json() }])
    const beforeRetry = await u.snapshot(f), replay = await u.acquire(f, { key })
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toEqual(first.json())
    expect(replay.headers['idempotent-replay']).toBe('true'); expect(await exact()).toEqual(one)
    expect(await u.snapshot(f)).toEqual(beforeRetry)
    witness('UNDATED_CONCURRENT_KEY_RETRY', { concurrent: [first.statusCode, inProgress.statusCode], code: errorCode(inProgress), one, after: await exact() })
  })

  it('U17 native22012 after complete NULL booking callback rolls back domain/head/receipt and permits same-key retry', async () => {
    const f = await u.fresh(), before = await u.snapshot(f), key = randomUUID(), db = u.db, original = db.tx, forward = db.tx.bind(db)
    let completed = false, code: string | undefined
    db.tx = async <T>(action: (c: Queryable) => Promise<T>) => forward(async client => {
      const result = await action(client)
      if (!completed && (await client.query('select id from slots where id=$1 and deal_id is not null', [f.slot])).rowCount) {
        completed = true
        try { await client.query('select 1/0') } catch (error) { code = (error as { code?: string }).code; throw error }
      }
      return result
    })
    let r: Reply
    try { r = await u.acquire(f, { key }) } finally { db.tx = original }
    witness('UNDATED_BOOK_SQL_FAULT', { completed, code, response: r.body, before, after: await u.snapshot(f) })
    expect(completed).toBe(true); expect(code).toBe('22012'); expect(r.statusCode).toBe(500)
    expect(await u.snapshot(f)).toEqual(before)
    await u.acquiredNull(f, await u.acquire(f, { key }))
  })
  it('U18 valid orphan undated revision completes callback but true outerCOMMIT23514 rolls back the whole row', async () => {
    const f = await u.fresh(), root = await u.acquiredNull(f, await u.acquire(f)), prior = (await u.scope(f, root.deal))[0]!
    const before = await u.snapshot(f); let callbackCompleted = false, error: unknown, phase = 'INSERT'
    try {
      await u.db.tx(async c => {
        await c.query('select legacy_day_lock_vendors(array[$1]::uuid[])', [f.company.id])
        await c.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,
          origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
          values($1,$2,$3,$4,1,2,$5,null,'acquire','explicit_event',$6,'catalog',$7,'undated',null,$8,null)`,
        [randomUUID(), f.wedding, root.deal, f.slot, prior.id, f.event.id, f.company.id, EVENT_TZ])
        callbackCompleted = true; phase = 'OUTER_COMMIT'
      })
    } catch (caught) { error = caught }
    witness('UNDATED_BOOK_OUTER_COMMIT', { callbackCompleted, phase,
      error: error && { code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }, before, after: await u.snapshot(f) })
    expect(callbackCompleted).toBe(true); expect(phase).toBe('OUTER_COMMIT')
    expect(error).toMatchObject({ code: '23514', constraint: 'deal_day_scope_chain' }); expect(await u.snapshot(f)).toEqual(before)
  })
  it('U19 NULL price remains unknown during first COMMITTED instead of becoming zero', async () => {
    const f = await u.fresh(), seeded = await seedUntrackedSlotDeal(u.app, { weddingId: f.wedding, slotId: f.slot,
      vendorId: f.company.id, state: 'candidate', price: null })
    ok(await u.state(f, seeded.dealId, 'booked'))
    expect((await u.db.query('select price::text from deals where id=$1', [seeded.dealId])).rows).toEqual([{ price: null }])
    expect((await u.scope(f, seeded.dealId))[0]).toMatchObject({ binding_state: 'undated', service_date: null, day_id: null })
  })
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, null])('U20 new catalog price=%s keeps the existing amount boundary', async amount => {
    const f = await u.fresh()
    await u.refusal(f, 'OLD_MONEY_BOUNDARY', () => u.call('OLD_MONEY_BOUNDARY', f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/slots/${f.slot}/book`, key: randomUUID(), context: nullWire(f.event),
      payload: { vendorId: f.company.id, price: { amount, currency: 'RUB' } } }), 422, amount === 0 || amount === null ? 'bad_amount' : 'validation_failed')
  })
  it('U21 legacy external draft DELETE without a header remains legal while supplied stale context is rejected atomically', async () => {
    const f = await u.fresh(), seeded = await seedUntrackedSlotDeal(u.app, { weddingId: f.wedding, slotId: f.slot,
      state: 'candidate', externalName: 'Synthetic old external draft', price: 17000 })
    const money = await u.economic(seeded.dealId)
    await u.refusal(f, 'EXTERNAL_STALE_RELEASE', () => u.call('EXTERNAL_STALE_RELEASE', f.pair, { method: 'DELETE',
      url: `/weddings/${f.wedding}/slots/${f.slot}/external`, context: JSON.stringify({ id: f.event.id, date: OTHER_DATE, timeZone: EVENT_TZ }) }),
    409, 'event_context_changed')
    const r = await u.call('EXTERNAL_NO_HEADER_RELEASE', f.pair, { method: 'DELETE', url: `/weddings/${f.wedding}/slots/${f.slot}/external` })
    expect(r.statusCode, r.body).toBe(204)
    expect((await u.scope(f, seeded.dealId))[0]).toMatchObject({ binding_state: 'released', service_date: null, time_zone: EVENT_TZ, day_id: null })
    expect(await u.economic(seeded.dealId)).toEqual(money)
  })
  it.each(['event', 'time zone'] as const)('U22 native new undated version cannot lie about its actual %s with valid real FK parents', async field => {
    const f = await u.fresh(), root = await u.acquiredNull(f, await u.acquire(f)), prior = (await u.scope(f, root.deal))[0]!
    const other = await u.event(f.wedding, f.pair, null, EVENT_TZ), before = await u.snapshot(f)
    let error: unknown
    try {
      await u.db.tx(async client => {
        await client.query('select legacy_day_lock_vendors(array[$1]::uuid[])', [f.company.id])
        await client.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,
          origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
          values($1,$2,$3,$4,1,2,$5,null,'acquire','explicit_event',$6,'catalog',$7,'undated',null,$8,null)`,
        [randomUUID(), f.wedding, root.deal, f.slot, prior.id, field === 'event' ? other.id : f.event.id,
          f.company.id, field === 'time zone' ? 'Europe/Moscow' : EVENT_TZ])
      })
    } catch (caught) { error = caught }
    witness('UNDATED_NATIVE_CURRENT_REFUSAL', { field, other, error: error && {
      code: (error as { code?: string }).code, constraint: (error as { constraint?: string }).constraint }, before, after: await u.snapshot(f) })
    expect(error).toMatchObject({ code: '23514', constraint: 'deal_day_scope_current' })
    expect(await u.snapshot(f)).toEqual(before)
  })
})
