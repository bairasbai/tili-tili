import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Queryable } from '../src/plugins/db.js'
import { seedUntrackedSlotDeal } from './helpers/dayFixture.js'
import { AdditionalEventFixture, context, EVENT_DATE, EVENT_TZ, MAIN_DATE, OTHER_DATE, ok, witness, YEAR,
  type Case, type EventContext, type ProgramEvent, type Reply, type SlotReply } from './helpers/additionalEventFixture.js'

const h = new AdditionalEventFixture()
const externalBody = { vendorName: 'Synthetic private additional performer', phone: '+79990001122',
  price: { amount: 17000, currency: 'RUB' } }
const external = (f: Case, slot = f.slot, supplied: EventContext | string | null = context(f.event), key: string | null = randomUUID()) => h.call('EXTERNAL_CREATE', f.pair,
  { method: 'POST', url: '/weddings/' + f.wedding + '/slots/' + slot + '/external', key, context: supplied, payload: externalBody })
const removeExternal = (f: Case, supplied?: EventContext | string | null) => h.call('EXTERNAL_DELETE', f.pair,
  { method: 'DELETE', url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/external', context: supplied })
const patchState = (f: Case, deal: string, state: string, key = randomUUID(), supplied: EventContext | null = context(f.event)) =>
  h.call('STATE_' + state, f.pair, { method: 'PATCH', url: '/deals/' + deal, key, context: supplied, payload: { state } })
const eventSnapshot = (event: ProgramEvent) => ({ id: event.id, isMain: event.isMain, date: event.date,
  timeZone: event.timeZone, name: event.name, kind: event.kind, location: event.location })

async function patchEvent(f: Case, event: ProgramEvent, patch: object) {
  const read = await h.call('EVENT_READ_FOR_PATCH', f.pair, { method: 'GET', url: '/weddings/' + f.wedding + '/events' })
  ok(read); assert.equal(typeof read.headers.etag, 'string')
  return ok<ProgramEvent>(await h.call('EVENT_PATCH', f.pair, { method: 'PATCH',
    url: '/weddings/' + f.wedding + '/events/' + event.id, headers: { 'if-match': read.headers.etag as string }, payload: patch }))
}
async function quote(f: Case, validUntil = EVENT_DATE) {
  const entry = ok<{ id: string; slotId: string }>(await h.call('EXACT_SHORTLIST', f.pair, { method: 'PUT',
    url: '/weddings/' + f.wedding + '/shortlist/' + f.company.id, payload: { slotId: f.slot } }))
  expect(entry.slotId).toBe(f.slot)
  const requested = ok<{ results: { entryId: string; status: string; requestId?: string }[] }>(
    await h.call('OFFER_REQUEST', f.pair, { method: 'POST', url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/offer-requests',
      key: randomUUID(), context: context(f.event), payload: { entryIds: [entry.id], wishes: 'Synthetic event-specific coverage' } }), 201)
  const sent = requested.results.find(row => row.entryId === entry.id); expect(sent?.status).toBe('sent'); assert(sent?.requestId)
  const requestId = sent.requestId
  const request = (await h.db.query('select slot_id,wedding_date::text,status,program_event_context from offer_requests where id=$1', [requestId])).rows
  witness('REQUEST_CONTEXT', { requestId, expectedEvent: f.event, rows: request })
  expect(request).toEqual([{ slot_id: f.slot, wedding_date: f.event.date, status: 'open', program_event_context: eventSnapshot(f.event) }])
  const vendorRequests = ok<{ id: string; weddingDate: string | null; programEvent: unknown }[]>(await h.call('VENDOR_REQUEST_CONTEXT',
    f.company.actor, { method: 'GET', url: '/vendor/offer-requests' }))
  expect(vendorRequests.find(row => row.id === requestId)).toMatchObject({ id: requestId,
    weddingDate: f.event.date, programEvent: eventSnapshot(f.event) })
  const offer = ok<{ id: string }>(await h.call('VENDOR_REPLY', f.company.actor, { method: 'POST',
    url: '/vendor/offer-requests/' + requestId + '/offers', key: randomUUID(),
    payload: { kind: 'offer', title: 'Synthetic immutable additional quote', price: { amount: 314159, currency: 'RUB' },
      includes: ['Additional event coverage'], validUntil } }), 201)
  return { requestId, offerId: offer.id }
}
const accept = (f: Case, offer: string, supplied: EventContext = context(f.event)) => h.call('OFFER_ACCEPT', f.pair,
  { method: 'POST', url: '/weddings/' + f.wedding + '/offers/' + offer + '/accept', key: randomUUID(), context: supplied })
async function assignment(f: Case, deal: string, slot: string, event: ProgramEvent) {
  const order = ok<{ version: string }>(await h.call('ORDER_READ', f.pair, { method: 'GET', url: '/deals/' + deal + '/order' }))
  return ok<{ assignments: { slotId: string; programEventId: string }[] }>(await h.call('ASSIGNMENT_CREATE', f.pair, {
    method: 'POST', url: '/deals/' + deal + '/order/assignments', key: randomUUID(),
    payload: { expectedVersion: order.version, slotId: slot, programEventId: event.id, label: 'Synthetic exact event duty' } }))
}
async function paidHistory(deal: string) {
  return { financial: (await h.db.query(`select id,price::text,currency,package_id,package_title_snapshot,package_includes_snapshot
    from deals where id=$1`, [deal])).rows, payments: await h.raw('payments', 'deal_id=$1', [deal]),
  installments: await h.raw('payment_installments', 'deal_id=$1', [deal]) }
}

describe('additional activation: registered public doors, context identity and atomic refusal matrix', () => {
  beforeAll(() => h.start())
  afterAll(() => h.close())

  it('direct booking and nonpointer cancel preserve another exact holder and the independent main booking', async () => {
    const f = await h.fixture({ mainBooking: true }), beforeMain = {
      root: await h.raw('deals', 'id=$1', [f.mainDeal]), slot: await h.raw('slots', 'id=$1', [f.mainSlot]),
      scope: await h.scope(f, f.mainDeal!), day: await h.raw('vendor_busy_dates', 'deal_id=$1', [f.mainDeal]) }
    const a = await h.acquired(f, await h.book(f)), secondSlot = await h.slot(f.wedding, f.pair, f.event)
    const bReply = ok<SlotReply>(await h.book(f, { slot: secondSlot })); assert(bReply.deal); const b = bReply.deal.id
    const secondScopes = await h.scope(f, b)
    witness('SECOND_HOLDER', { secondScopes }); expect(secondScopes).toHaveLength(1)
    const aScope = (await h.scope(f, a))[0]!, bScope = secondScopes[0]!
    expect(aScope.day_id).toBe(bScope.day_id)
    const day = (await h.db.query<{ id: string; deal_id: string }>('select id,deal_id from vendor_busy_dates where id=$1', [aScope.day_id])).rows[0]!
    const removed = day.deal_id === a ? b : a, removedSlot = removed === a ? f.slot : secondSlot, retained = removed === a ? b : a
    const retainedBefore = { root: await h.raw('deals', 'id=$1', [retained]), scope: await h.scope(f, retained) }
    const response = await h.cancel(f, removedSlot)
    const retainedAfter = { root: await h.raw('deals', 'id=$1', [retained]), scope: await h.scope(f, retained) }
    witness('CANCEL_NONPOINTER', { day, removed, retained, status: response.statusCode, retainedBefore, retainedAfter, state: await h.snapshot(f) })
    expect(response.statusCode, response.body).toBe(200); expect(retainedAfter).toEqual(retainedBefore)
    expect((await h.db.query('select id,deal_id from vendor_busy_dates where id=$1', [day.id])).rows).toEqual([day])
    expect((await h.scope(f, removed))[0]).toMatchObject({ binding_state: 'released', day_id: null })
    expect({ root: await h.raw('deals', 'id=$1', [f.mainDeal]), slot: await h.raw('slots', 'id=$1', [f.mainSlot]),
      scope: await h.scope(f, f.mainDeal!), day: await h.raw('vendor_busy_dates', 'deal_id=$1', [f.mainDeal]) }).toEqual(beforeMain)
  })

  it('public exact shortlist → request → vendor reply → accept retains additional quote/date and one selected financial root', async () => {
    const f = await h.fixture(), q = await quote(f), deal = await h.acquired(f, await accept(f, q.offerId))
    expect((await h.db.query('select price::text,package_title_snapshot,package_includes_snapshot from deals where id=$1', [deal])).rows)
      .toEqual([{ price: '314159', package_title_snapshot: 'Synthetic immutable additional quote', package_includes_snapshot: ['Additional event coverage'] }])
    expect((await h.db.query('select status from offer_requests where id=$1', [q.requestId])).rows).toEqual([{ status: 'closed' }])
    expect((await h.db.query('select deal_id,accepted_at is not null accepted from offers where id=$1', [q.offerId])).rows).toEqual([{ deal_id: deal, accepted: true }])
  })

  it('a changed live extra DATE requires a new request rather than changing the meaning of the existing vendor quote', async () => {
    const f = await h.fixture(), q = await quote(f), oldContext = context(f.event)
    f.event = await patchEvent(f, f.event, { date: OTHER_DATE })
    await h.refused(f, 'OLD_ACCEPT_CONTEXT', () => accept(f, q.offerId, oldContext), 409, 'event_context_changed')
    await h.refused(f, 'OLD_QUOTE_NEW_CONTEXT', () => accept(f, q.offerId), 409, 'offer_stale_date')
  })

  it('offer expiry uses the additional timezone rather than the main wedding timezone', async () => {
    const f = await h.fixture({ timeZone: 'Pacific/Kiritimati' })
    f.mainEvent = await patchEvent(f, f.mainEvent, { timeZone: 'Pacific/Honolulu' })
    const clock = (await h.db.query<{ west: string; east: string }>(`select
      (clock_timestamp() at time zone 'Pacific/Honolulu')::date::text west,
      (clock_timestamp() at time zone 'Pacific/Kiritimati')::date::text east`)).rows[0]!
    expect(clock.east > clock.west).toBe(true)
    const q = await quote(f, clock.west)
    witness('EXPIRY_TIMEZONES', { clock, main: f.mainEvent, additional: f.event })
    await h.refused(f, 'EXTRA_LOCAL_EXPIRY', () => accept(f, q.offerId), 409, 'offer_expired')
  })

  it('additional external create tracks literal context without acquiring a catalog DATE, and no-header DELETE cancels only that root', async () => {
    const f = await h.fixture({ mainBooking: true }), mainBefore = await h.raw('deals', 'id=$1', [f.mainDeal])
    const deal = await h.acquired(f, await external(f), 'external')
    const removed = await removeExternal(f)
    witness('EXTERNAL_REMOVED', { status: removed.statusCode, root: await h.raw('deals', 'id=$1', [deal]), scope: await h.scope(f, deal) })
    expect(removed.statusCode, removed.body).toBe(204)
    expect((await h.db.query('select state from deals where id=$1', [deal])).rows).toEqual([{ state: 'cancelled' }])
    expect((await h.scope(f, deal))[0]).toMatchObject({ binding_state: 'released', day_id: null })
    expect(await h.raw('deals', 'id=$1', [f.mainDeal])).toEqual(mainBefore)
  })

  it('old implicit-main external creation still accepts no key/header and keeps its old financial/event semantics', async () => {
    const f = await h.fixture(), r = await external(f, f.mainSlot, null, null), booked = ok<SlotReply>(r); assert(booked.deal)
    expect((await h.scope(f, booked.deal.id))[0]).toMatchObject({ context_kind: 'implicit_main', event_id: f.mainEvent.id,
      performer_kind: 'external', vendor_id: null, service_date: MAIN_DATE, time_zone: f.mainEvent.timeZone, binding_state: 'external', day_id: null })
    expect(await h.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id])).toEqual([])
  })

  it('paid additional replacement atomically cancels only the old root and preserves its exact money/history', async () => {
    const f = await h.fixture({ mainBooking: true }), old = await h.acquired(f, await h.book(f)), next = await h.company(f)
    ok(await h.call('PAY_OLD', f.pair, { method: 'POST', url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/pay',
      key: randomUUID(), payload: { amount: { amount: 1000, currency: 'RUB' } } }))
    const before = await paidHistory(old), oldEvents = await h.raw('deal_events', 'deal_id=$1', [old])
    const main = await h.raw('deals', 'id=$1', [f.mainDeal])
    const r = await h.call('PAID_REPLACE', f.pair, { method: 'POST', url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/replace',
      key: randomUUID(), context: context(f.event), payload: { expectedSelectedDealId: old, expectedSelectedDealState: 'paid_deposit',
        vendorId: next.id, expectedPolicyRevision: '0', price: { amount: 271828, currency: 'RUB' } } })
    const after = await paidHistory(old)
    witness('PAID_REPLACEMENT', { status: r.statusCode, before, after, state: await h.snapshot(f) })
    const selected = ok<SlotReply>(r); assert(selected.deal); expect(selected.deal.id).not.toBe(old)
    expect(after).toEqual(before); expect(await h.raw('deals', 'id=$1', [f.mainDeal])).toEqual(main)
    expect((await h.db.query('select state from deals where id=$1', [old])).rows).toEqual([{ state: 'cancelled' }])
    const oldAfter = await h.raw('deal_events', 'deal_id=$1', [old])
    for (const row of oldEvents) expect(oldAfter).toContain(row)
    expect(oldAfter).toHaveLength(oldEvents.length + 1)
    expect((await h.scope(f, old))[0]).toMatchObject({ binding_state: 'released', day_id: null })
    expect((await h.scope(f, selected.deal.id))[0]).toMatchObject({ event_id: f.event.id, service_date: EVENT_DATE, time_zone: EVENT_TZ,
      vendor_id: next.id, binding_state: 'active', matches_current: true })
  })

  it.each([
    { from: 'candidate', to: 'booked' }, { from: 'contacted', to: 'paid_deposit' }, { from: 'negotiating', to: 'done' },
  ] as const)('legal first COMMITTED $from→$to uses the selected additional DATE without invented financial steps', async ({ from, to }) => {
    const f = await h.fixture(), seeded = await h.seed(f, from), before = await paidHistory(seeded.dealId)
    const r = await patchState(f, seeded.dealId, to), scope = await h.scope(f, seeded.dealId)
    witness('FIRST_COMMITTED', { from, to, status: r.statusCode, body: r.body, before, after: await paidHistory(seeded.dealId), scope })
    expect(r.statusCode, r.body).toBe(200); expect(await paidHistory(seeded.dealId)).toEqual(before)
    expect(scope).toHaveLength(1); expect(scope[0]).toMatchObject({ revision: '1', previous_version_id: null, origin_knowledge: 'legacy_unknown',
      context_kind: 'explicit_event', event_id: f.event.id, service_date: EVENT_DATE, time_zone: EVENT_TZ,
      performer_kind: 'catalog', vendor_id: f.company.id, binding_state: to === 'done' ? 'done_retained' : 'active', matches_current: true })
    expect((await h.db.query('select from_state,to_state from deal_events where deal_id=$1 order by id', [seeded.dealId])).rows)
      .toEqual([{ from_state: from, to_state: to }])
    expect((await h.db.query('select deal_id,date::text from vendor_busy_dates where vendor_id=$1', [f.company.id])).rows)
      .toEqual([{ deal_id: seeded.dealId, date: EVENT_DATE }])
  })

  it.each([
    { label: 'missing', header: null, status: 428, code: 'event_context_required' },
    { label: 'broken JSON', header: '{', status: 422, code: 'event_context_invalid' },
    { label: 'array', header: '[]', status: 422, code: 'event_context_invalid' },
    { label: 'missing timezone', header: JSON.stringify({ id: randomUUID(), date: EVENT_DATE }), status: 422, code: 'event_context_invalid' },
    { label: 'unknown key', header: JSON.stringify({ id: randomUUID(), date: EVENT_DATE, timeZone: EVENT_TZ, extra: true }), status: 422, code: 'event_context_invalid' },
    { label: 'invalid DATE', header: JSON.stringify({ id: randomUUID(), date: YEAR + '-02-30', timeZone: EVENT_TZ }), status: 422, code: 'event_context_invalid' },
    { label: 'invalid timezone', header: JSON.stringify({ id: randomUUID(), date: EVENT_DATE, timeZone: 'Unknown/Zone' }), status: 422, code: 'event_context_invalid' },
  ])('$label context refuses acquisition before any financial/DATE/receipt write', async row => {
    const f = await h.fixture()
    await h.refused(f, row.label, () => h.book(f, { context: row.header }), row.status, row.code)
  })

  it('stale and real foreign event headers cannot grant the own selected slot a different authority', async () => {
    const f = await h.fixture(), foreign = await h.fixture()
    await h.refused(f, 'STALE_DATE', () => h.book(f, { context: { ...context(f.event), date: OTHER_DATE } }), 409, 'event_context_changed')
    await h.refused(f, 'REAL_FOREIGN_EVENT', () => h.book(f, { context: context(foreign.event) }), 409, 'event_context_changed')
  })

  it.each(['external', 'request', 'first-COMMITTED', 'replace'] as const)('%s validates missing/stale context before any domain write', async door => {
    const f = await h.fixture()
    let entry: string | undefined, deal: string | undefined, replacementVendor: string | undefined
    if (door === 'request') entry = ok<{ id: string }>(await h.call('BOUNDARY_SHORTLIST', f.pair, { method: 'PUT',
      url: '/weddings/' + f.wedding + '/shortlist/' + f.company.id, payload: { slotId: f.slot } })).id
    if (door === 'first-COMMITTED') deal = (await h.seed(f)).dealId
    if (door === 'replace') {
      deal = await h.acquired(f, await h.book(f))
      replacementVendor = (await h.company(f)).id
    }
    const action = (pin: EventContext | null) => {
      if (door === 'external') return external(f, f.slot, pin)
      if (door === 'request') return h.call('CONTEXT_REQUEST', f.pair, { method: 'POST',
        url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/offer-requests', key: randomUUID(), context: pin, payload: { entryIds: [entry!] } })
      if (door === 'first-COMMITTED') return patchState(f, deal!, 'booked', randomUUID(), pin)
      return h.call('CONTEXT_REPLACE', f.pair, { method: 'POST', url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/replace',
        key: randomUUID(), context: pin, payload: { expectedSelectedDealId: deal!, expectedSelectedDealState: 'booked',
          vendorId: replacementVendor!, expectedPolicyRevision: '0', price: { amount: 271828, currency: 'RUB' } } })
    }
    await h.refused(f, door + '_MISSING', () => action(null), 428, 'event_context_required')
    await h.refused(f, door + '_STALE', () => action({ ...context(f.event), date: OTHER_DATE }), 409, 'event_context_changed')
  })

  it('canonical JSON property order replays exactly once while changed target content cannot reuse the key', async () => {
    const f = await h.fixture(), key = randomUUID(), first = await h.book(f, { key }); await h.acquired(f, first)
    const before = await h.snapshot(f), pin = context(f.event)
    const retry = await h.book(f, { key, context: JSON.stringify({ timeZone: pin.timeZone, date: pin.date, id: pin.id.toUpperCase() }) })
    const after = await h.snapshot(f)
    witness('CANONICAL_REPLAY', { first: first.body, retry: retry.body, status: retry.statusCode, replay: retry.headers['idempotent-replay'], before, after })
    expect(retry.statusCode, retry.body).toBe(200); expect(retry.json()).toEqual(first.json())
    expect(retry.headers['idempotent-replay']).toBe('true'); expect(after).toEqual(before)
    await h.refused(f, 'SAME_KEY_OTHER_TARGET', () => h.book(f, { key, context: { ...pin, date: OTHER_DATE } }), 409, 'idempotency_key_reused')
  })

  it('discarding a completed response is resolved by two public reads and the same immutable retry with one effect', async () => {
    // Driver-level lost observation, not a fabricated TCP wire-loss claim.
    const f = await h.fixture(), key = randomUUID()
    const unobserved = await h.book(f, { key })
    const selected = ok<(SlotReply & { categoryId: string })[]>(await h.call('LOSS_READ_SLOTS', f.pair,
      { method: 'GET', url: '/weddings/' + f.wedding + '/slots' })).find(row => row.id === f.slot)
    assert(selected?.deal)
    const order = ok<{ dealId: string }>(await h.call('LOSS_READ_ORDER', f.pair, { method: 'GET', url: '/deals/' + selected.deal.id + '/order' }))
    expect(order.dealId).toBe(selected.deal.id)
    const before = await h.snapshot(f), retry = await h.book(f, { key }), after = await h.snapshot(f)
    witness('DISCARDED_RESPONSE_RECOVERY', { originalStatus: unobserved.statusCode, selected, order, retry: retry.body, before, after })
    expect(retry.statusCode, retry.body).toBe(200); expect(retry.headers['idempotent-replay']).toBe('true')
    expect(retry.json()).toEqual(unobserved.json()); expect(after).toEqual(before)
    expect((await h.db.query('select id from deals where wedding_id=$1 and slot_id=$2', [f.wedding, f.slot])).rows).toEqual([{ id: selected.deal.id }])
  })


  it('a successful book receipt replays its original effect after own cancellation without creating another root', async () => {
    const f = await h.fixture(), key = randomUUID(), original = await h.book(f, { key })
    const deal = await h.acquired(f, original); ok(await h.cancel(f))
    const before = await h.snapshot(f), replay = await h.book(f, { key }), after = await h.snapshot(f)
    witness('REPLAY_AFTER_OWN_CANCEL', { original: original.body, replay: replay.body, before, after })
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.json()).toEqual(original.json()); expect(after).toEqual(before)
    expect((await h.db.query('select id,state from deals where wedding_id=$1 and slot_id=$2', [f.wedding, f.slot])).rows)
      .toEqual([{ id: deal, state: 'cancelled' }])
  })

  it('foreign main-DATE occupancy does not block a free additional DATE for the same vendor', async () => {
    const f = await h.fixture(), foreign = await h.fixture({ date: MAIN_DATE })
    const old = ok<SlotReply>(await h.book(foreign, { company: f.company })); assert(old.deal)
    const oldRaw = await h.raw('deals', 'id=$1', [old.deal.id])
    await h.acquired(f, await h.book(f))
    expect(await h.raw('deals', 'id=$1', [old.deal.id])).toEqual(oldRaw)
    expect((await h.db.query('select date::text from vendor_busy_dates where vendor_id=$1 order by date', [f.company.id])).rows)
      .toEqual([{ date: MAIN_DATE }, { date: EVENT_DATE }])
  })

  it('foreign additional-DATE occupancy refuses the own event even while its main DATE is free', async () => {
    const f = await h.fixture(), foreign = await h.fixture()
    const old = ok<SlotReply>(await h.book(foreign, { company: f.company })); assert(old.deal)
    const oldRaw = await h.raw('deals', 'id=$1', [old.deal.id])
    await h.refused(f, 'EXTRA_DATE_FOREIGN_BUSY', () => h.book(f), 409, 'date_taken')
    expect(await h.raw('deals', 'id=$1', [old.deal.id])).toEqual(oldRaw)
  })

  it('saved success does not bypass a current session revocation', async () => {
    const f = await h.fixture(), key = randomUUID(); await h.acquired(f, await h.book(f, { key }))
    await h.db.query('update sessions set revoked_at=clock_timestamp() where id=$1 and user_id=$2', [f.pair.sid, f.pair.id])
    await h.refused(f, 'REVOKED_REPLAY', () => h.book(f, { key }), 401, 'unauthorized')
  })

  it.each(['helper', 'coordinator', 'vendor', 'outsider'] as const)('current %s cannot acquire a known additional catalog position', async role => {
    const f = await h.fixture(), actor = await h.actor(); f.actors.push(actor.id)
    if (role !== 'outsider') await h.db.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [f.wedding, actor.id, role])
    await h.refused(f, 'ACL_' + role, () => h.call('FOREIGN_ACQUIRE', actor, { method: 'POST',
      url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/book', key: randomUUID(), context: context(f.event),
      payload: { vendorId: f.company.id, price: { amount: 17000, currency: 'RUB' } } }), role === 'outsider' ? 404 : 403, role === 'outsider' ? 'not_found' : 'forbidden')
  })

  it.each([
    { label: 'unknown DATE', date: null, timeZone: EVENT_TZ },
    { label: 'unknown TZ', date: EVENT_DATE, timeZone: null },
  ])('$label cannot borrow the known main context for a new commitment', async options => {
    const f = await h.fixture(options)
    await h.refused(f, options.label, () => h.book(f, { context: null }), 409, 'event_context_incomplete')
  })

  it('unknown NULL draft cancellation requires no new acquisition header and invents no main DATE hold', async () => {
    const f = await h.fixture({ date: null, timeZone: null }), candidate = await h.seed(f)
    const r = await h.cancel(f), scope = await h.scope(f, candidate.dealId)
    witness('UNKNOWN_DRAFT_CANCEL', { status: r.statusCode, body: r.body, scope, state: await h.snapshot(f) })
    expect(r.statusCode, r.body).toBe(200)
    expect(scope[0]).toMatchObject({ binding_state: 'released', service_date: null, time_zone: null, day_id: null })
    expect(await h.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id])).toEqual([])
  })

  it('unknown external candidate DELETE without a header remains a release rather than an invented acquisition', async () => {
    const f = await h.fixture({ date: null, timeZone: null })
    const seeded = await seedUntrackedSlotDeal(h.app, { weddingId: f.wedding, slotId: f.slot, state: 'candidate',
      externalName: 'Synthetic unknown draft performer', externalPhone: '+79990001122', price: 17000 })
    const r = await removeExternal(f)
    witness('UNKNOWN_EXTERNAL_RELEASE', { status: r.statusCode, scope: await h.scope(f, seeded.dealId) })
    expect(r.statusCode, r.body).toBe(204)
    expect((await h.db.query('select state from deals where id=$1', [seeded.dealId])).rows).toEqual([{ state: 'cancelled' }])
    expect((await h.scope(f, seeded.dealId))[0]).toMatchObject({ binding_state: 'released', service_date: null, time_zone: null, day_id: null })
  })

  it('valid current event context does not bypass the existing resources booking policy', async () => {
    const f = await h.fixture()
    ok(await h.call('EQUIPMENT_CREATE', f.company.actor, { method: 'POST', url: '/vendors/' + f.company.id + '/resources',
      key: randomUUID(), payload: { kind: 'equipment', label: 'Synthetic resources-only camera' } }))
    ok(await h.call('RESOURCES_POLICY', f.company.actor, { method: 'PATCH', url: '/vendors/' + f.company.id + '/availability-policy',
      key: randomUUID(), payload: { mode: 'resources', expectedRevision: '0' } }))
    await h.refused(f, 'CURRENT_CONTEXT_RESOURCES_GATE', () => h.book(f), 409, 'resource_booking_required')
  })

  it.each(['main', 'extra'] as const)('selected %s with only its own draft assignment is first-COMMITTED bookable', async selected => {
    const f = await h.fixture(), own = selected === 'main' ? { ...f, slot: f.mainSlot, event: f.mainEvent } : f
    const seeded = await h.seed(own)
    const assigned = await assignment(own, seeded.dealId, own.slot, own.event)
    expect(assigned.assignments).toHaveLength(1)
    const response = await patchState(own, seeded.dealId, 'booked', randomUUID(), selected === 'main' ? null : context(own.event))
    const scope = await h.scope(own, seeded.dealId)
    witness('OWN_EVENT_ASSIGNMENT', { selected, status: response.statusCode, scope, state: await h.snapshot(f) })
    expect(response.statusCode, response.body).toBe(200)
    expect(scope[0]).toMatchObject({ context_kind: selected === 'main' ? 'implicit_main' : 'explicit_event',
      event_id: own.event.id, service_date: own.event.date, time_zone: own.event.timeZone, binding_state: 'active', matches_current: true })
  })

  it.each(['main', 'extra'] as const)('selected %s cannot silently commit an active assignment on another DATE/event', async selected => {
    const f = await h.fixture(), own = selected === 'main' ? { ...f, slot: f.mainSlot, event: f.mainEvent } : f
    const seeded = await h.seed(own), otherEvent = selected === 'main' ? f.event : await h.event(f.wedding, f.pair, OTHER_DATE, 'Asia/Novosibirsk')
    const otherSlot = selected === 'main' ? f.slot : await h.slot(f.wedding, f.pair, otherEvent)
    await assignment(own, seeded.dealId, otherSlot, otherEvent)
    await h.refused(f, 'OTHER_EVENT_ASSIGNMENT_' + selected,
      () => patchState(own, seeded.dealId, 'booked', randomUUID(), selected === 'main' ? null : context(own.event)), 409, 'event_move_scope_incomplete')
  })

  it.each(['booked', 'done'] as const)('invalid supplied DELETE context cannot cancel/revoke external %s root or live invitation', async state => {
    const f = await h.fixture(), foreign = await h.fixture(), deal = await h.acquired(f, await external(f), 'external')
    if (state === 'done') ok(await patchState(f, deal, 'done'))
    ok(await h.call('EXTERNAL_INVITE', f.pair, { method: 'POST', url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/external/invite' }), 201)
    const invalid = [
      { label: 'malformed', header: '{', status: 422, code: 'event_context_invalid' },
      { label: 'stale', header: { ...context(f.event), date: OTHER_DATE }, status: 409, code: 'event_context_changed' },
      { label: 'foreign', header: context(foreign.event), status: 409, code: 'event_context_changed' },
    ]
    for (const row of invalid) await h.refused(f, 'EXTERNAL_' + state + '_' + row.label,
      () => removeExternal(f, row.header), row.status, row.code)
    expect((await h.db.query('select revoked_at from external_invites where program_deal_id=$1', [deal])).rows).toEqual([{ revoked_at: null }])
  })

  it('a legal no-header done external DELETE still commits invite withdrawal but refuses financial cancellation', async () => {
    const f = await h.fixture(), deal = await h.acquired(f, await external(f), 'external')
    ok(await patchState(f, deal, 'done'))
    ok(await h.call('DONE_INVITE', f.pair, { method: 'POST', url: '/weddings/' + f.wedding + '/slots/' + f.slot + '/external/invite' }), 201)
    const before = await paidHistory(deal), scope = await h.scope(f, deal), r = await removeExternal(f)
    witness('DONE_ACCESS_WITHDRAWAL', { status: r.statusCode, body: r.body, before, after: await paidHistory(deal),
      invites: await h.raw('external_invites', 'program_deal_id=$1', [deal]) })
    expect(r.statusCode, r.body).toBe(409); expect(r.json<{ error: { code: string } }>().error.code).toBe('bad_transition')
    expect(await paidHistory(deal)).toEqual(before); expect(await h.scope(f, deal)).toEqual(scope)
    expect((await h.db.query('select state from deals where id=$1', [deal])).rows).toEqual([{ state: 'done' }])
    expect((await h.db.query('select revoked_at is not null revoked from external_invites where program_deal_id=$1', [deal])).rows).toEqual([{ revoked: true }])
  })

  it.each(['role', 'session'] as const)('actual wedding lock wait rechecks revoked %s before any additional booking write', async boundary => {
    const f = await h.fixture(), before = await h.snapshot(f)
    const held = await h.gate(f.wedding, async c => {
      const changed = boundary === 'role'
        ? await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.wedding, f.pair.id])
        : await c.query('update sessions set revoked_at=clock_timestamp() where user_id=$1 and id=$2', [f.pair.id, f.pair.sid])
      expect(changed.rowCount).toBe(1)
    })
    let pending: Promise<Reply> | undefined, response: Reply | undefined, observedWait = false, failure: unknown
    try { pending = h.book(f); void pending.catch(() => undefined); await h.blocked(held.pid, 'COUPLE_REVOKE'); observedWait = true }
    catch (error) { failure = error }
    finally {
      held.unlock()
      const settled = await Promise.allSettled([held.done, ...(pending ? [pending] : [])])
      if (settled[0]?.status === 'rejected') failure ??= settled[0].reason
      if (settled[1]?.status === 'fulfilled') response = settled[1].value as Reply
      else if (settled[1]?.status === 'rejected') failure ??= settled[1].reason
    }
    const principal = (await h.db.query(`select m.role,s.revoked_at::text from wedding_members m join sessions s on s.user_id=m.user_id
      where m.wedding_id=$1 and m.user_id=$2 and s.id=$3`, [f.wedding, f.pair.id, f.pair.sid])).rows
    witness('WAIT_REVOKE_RESULT', { boundary, observedWait, principal, before, after: await h.snapshot(f), response: response && { status: response.statusCode, body: response.body } })
    if (failure) throw failure
    expect(observedWait).toBe(true); assert(response); expect(response.statusCode, response.body).toBe(boundary === 'role' ? 403 : 401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(boundary === 'role' ? 'forbidden' : 'unauthorized')
    expect(await h.snapshot(f)).toEqual(before)
  })

  it('actual event change while booking waits cannot turn an old header into a new target', async () => {
    const f = await h.fixture(), before = await h.snapshot(f)
    let expectedHolderRows: { weddings: string[]; wedding_events: string[]; audit: string[] } | undefined
    const held = await h.gate(f.wedding, async c => {
      const changed = await c.query('update wedding_events set date=$3::date where wedding_id=$1 and id=$2', [f.wedding, f.event.id, OTHER_DATE])
      expect(changed.rowCount).toBe(1)
      // Observe the legitimate mutation on this same held connection. Pool
      // reads here could wait for our own locks or observe an older context.
      expectedHolderRows = { weddings: await h.raw('weddings', 'id=$1', [f.wedding], c),
        wedding_events: await h.raw('wedding_events', 'wedding_id=$1', [f.wedding], c),
        audit: await h.raw('audit_log', 'actor_id=any($1::uuid[]) or entity_id=$2 or entity_id in(select id from deals where wedding_id=$2)', [f.actors, f.wedding], c) }
    })
    let pending: Promise<Reply> | undefined, response: Reply | undefined, failure: unknown
    try { pending = h.book(f); void pending.catch(() => undefined); await h.blocked(held.pid, 'EVENT_CHANGE') }
    catch (error) { failure = error }
    finally {
      held.unlock()
      const settled = await Promise.allSettled([held.done, ...(pending ? [pending] : [])])
      for (const row of settled) if (row.status === 'rejected') failure ??= row.reason
      if (settled[1]?.status === 'fulfilled') response = settled[1].value as Reply
    }
    const after = await h.snapshot(f)
    witness('WAIT_CONTEXT_RESULT', { expectedOld: f.event, expectedHolderRows,
      response: response && { status: response.statusCode, body: response.body }, before, after })
    if (failure) throw failure
    assert(response); expect(response.statusCode, response.body).toBe(409)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('event_context_changed')
    expect((await h.db.query('select id from deals where wedding_id=$1', [f.wedding])).rows).toEqual([])
    expect(await h.raw('vendor_busy_dates', 'vendor_id=$1', [f.company.id])).toEqual([])
    expect((await h.db.query('select id from deal_day_scope_versions where wedding_id=$1', [f.wedding])).rows).toEqual([])
    assert(expectedHolderRows, 'Same-connection post-mutation witness must exist')
    expect({ weddings: after.weddings, wedding_events: after.wedding_events, audit: after.audit }).toEqual(expectedHolderRows)
    expect(after).toEqual({ ...before, ...expectedHolderRows })
  })

  it('native 22012 after completed additional booking callback rolls back domain and saved receipt and allows the same-key retry', async () => {
    const f = await h.fixture(), database = h.db, original = database.tx, key = randomUUID()
    let hit = false, actual: { code?: string } | undefined
    database.tx = async <T>(action: (client: Queryable) => Promise<T>): Promise<T> => original.call(database, async (client: Queryable) => {
      const result = await action(client)
      const selected = (await client.query<{ deal_id: string | null }>('select deal_id from slots where wedding_id=$1 and id=$2', [f.wedding, f.slot])).rows[0]
      if (!hit && selected?.deal_id) {
        hit = true
        try { await client.query('select 1/0') } catch (error) {
          actual = { code: (error as { code?: string }).code }
          witness('SQL_FAULT_NATIVE', { hit, actual, phase: 'AFTER_CALLBACK_BEFORE_OUTER_COMMIT' })
          throw error
        }
      }
      return result
    }) as Promise<T>
    try { await h.refused(f, 'NATIVE_POST_CALLBACK_FAULT', () => h.book(f, { key }), 500, 'internal') }
    finally { database.tx = original }
    witness('SQL_FAULT', { hit, actual })
    expect(hit, 'must reach real domain success before fault').toBe(true); expect(actual?.code).toBe('22012')
    await h.acquired(f, await h.book(f, { key }))
  })

  it('real outer COMMIT rejects an orphan next additional version after successful callback and preserves all own rows', async () => {
    const f = await h.fixture(), deal = await h.acquired(f, await h.book(f)), v = (await h.scope(f, deal))[0]!
    const before = await h.snapshot(f)
    let callback = false, phase = 'INSERT', error: unknown
    try {
      await h.db.tx(async c => {
        await c.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,previous_version_id,
          origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
          values($1,$2,$3,$4,1,2,$5,null,'acquire','explicit_event',$6,'catalog',$7,'active',$8::date,$9,$10)`,
        [randomUUID(), f.wedding, deal, f.slot, v.id, f.event.id, f.company.id, f.event.date, f.event.timeZone, v.day_id])
        callback = true; phase = 'OUTER_COMMIT'
      })
    } catch (caught) { error = caught }
    witness('OUTER_COMMIT', { callback, phase, error: error && { code: (error as { code?: string }).code,
      constraint: (error as { constraint?: string }).constraint }, before, after: await h.snapshot(f) })
    expect(callback).toBe(true); expect(phase).toBe('OUTER_COMMIT')
    expect(error).toMatchObject({ code: '23514', constraint: 'deal_day_scope_chain' }); expect(await h.snapshot(f)).toEqual(before)
  })

  it('request storage keeps legacy NULL main context and exact seven-field additional context immutable', async () => {
    // Catalogue admission precedes any new-column SQL. These INSERTs are
    // explicitly native storage fixtures, not fabricated public booking proof.
    const columns = (await h.db.query(`select a.attname::text name,format_type(a.atttypid,a.atttypmod) type
      from pg_attribute a where a.attrelid='public.offer_requests'::regclass
      and a.attname='program_event_context' and a.attnum>0 and not a.attisdropped`)).rows
    witness('REQUEST_STORAGE_CATALOGUE', { columns }); expect(columns).toEqual([{ name: 'program_event_context', type: 'jsonb' }])
    const f = await h.fixture(), legacy = randomUUID(), exact = randomUUID(), snapshot = eventSnapshot(f.event)
    const insert = (c: Queryable, id: string, slot: string, date: string | null, value: unknown) => c.query(
      `insert into offer_requests(id,slot_id,vendor_id,created_by,wedding_date,program_event_context)
       values($1,$2,$3,$4,$5::date,$6::jsonb) returning id`,
      [id, slot, f.company.id, f.pair.id, date, value === null ? null : JSON.stringify(value)])
    await h.db.tx(async c => { await insert(c, legacy, f.mainSlot, MAIN_DATE, null); await insert(c, exact, f.slot, f.event.date, snapshot) })
    const rows = (await h.db.query(`select id,slot_id,wedding_date::text,program_event_context from offer_requests
      where id=any($1::uuid[]) order by id`, [[legacy, exact]])).rows
    witness('REQUEST_STORAGE_POSITIVES', { legacy, exact, rows })
    expect(rows).toEqual([
      { id: legacy, slot_id: f.mainSlot, wedding_date: MAIN_DATE, program_event_context: null },
      { id: exact, slot_id: f.slot, wedding_date: f.event.date, program_event_context: snapshot },
    ].sort((a, b) => a.id.localeCompare(b.id)))
    const refused = async (label: string, action: (c: Queryable) => Promise<unknown>) => {
      const before = await h.snapshot(f); let error: unknown
      try { await h.db.tx(action) } catch (caught) { error = caught }
      const after = await h.snapshot(f)
      witness('REQUEST_STORAGE_REFUSAL', { label, error: error && { code: (error as { code?: string }).code,
        constraint: (error as { constraint?: string }).constraint }, before, after })
      expect(error, label).toMatchObject({ code: '23514', constraint: 'offer_request_event_context' }); expect(after).toEqual(before)
    }
    // Real own slot/event/FKs are valid. The immutable-source guard must
    // reject before either unique-pair or downstream relationship checks.
    await refused('legacy main NULL cannot be reassigned to a real extra slot',
      c => c.query('update offer_requests set slot_id=$2 where id=$1', [legacy, f.slot]))
    await refused('stored service DATE cannot be rewritten',
      c => c.query('update offer_requests set wedding_date=$2::date where id=$1', [exact, OTHER_DATE]))
    await refused('stored literal event snapshot cannot be rewritten',
      c => c.query('update offer_requests set program_event_context=$2::jsonb where id=$1', [exact, JSON.stringify({ ...snapshot, name: 'Rewritten snapshot' })]))
    const freshSlot = await h.slot(f.wedding, f.pair, f.event)
    await refused('additional request INSERT cannot omit snapshot', c => insert(c, randomUUID(), freshSlot, f.event.date, null))
    await refused('additional request INSERT cannot invent a nonexact snapshot',
      c => insert(c, randomUUID(), freshSlot, f.event.date, { ...snapshot, date: OTHER_DATE }))
    // Source immutability does not freeze lifecycle or nullable erasure FKs.
    await h.db.tx(c => c.query(`update offer_requests set status='closed',close_reason='vendor_erased',closed_at=clock_timestamp(),
      vendor_id=null,created_by=null where id=$1`, [exact]))
    expect((await h.db.query('select slot_id,wedding_date::text,program_event_context,vendor_id,created_by,status from offer_requests where id=$1', [exact])).rows)
      .toEqual([{ slot_id: f.slot, wedding_date: f.event.date, program_event_context: snapshot, vendor_id: null, created_by: null, status: 'closed' }])
  })
})
