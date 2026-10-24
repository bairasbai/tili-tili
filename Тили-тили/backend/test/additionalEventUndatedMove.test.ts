import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Queryable } from '../src/plugins/db.js'
import { UndatedFixture, EVENT_TZ, OTHER_DATE, TARGET, YEAR, errorCode, nullWire, ok, rootMove, witness,
  type Case, type Proposal, type Reply, type Root, type SlotReply } from './helpers/additionalEventUndatedFixture.js'

const h = new UndatedFixture()
async function orderVersion(root: Root) {
  return (await h.db.query<{ version: string }>('select version::text from deal_orders where deal_id=$1', [root.deal])).rows[0]!.version
}
async function assignment(f: Case, root: Root, slot = root.slot, event = f.event) {
  ok(await h.call('UNDATED_ASSIGNMENT', f.pair, { method: 'POST', url: `/deals/${root.deal}/order/assignments`, key: randomUUID(),
    payload: { expectedVersion: await orderVersion(root), slotId: slot, programEventId: event.id, label: 'Synthetic own draft duty' } }))
  const rows = (await h.db.query<{ id: string }>('select id from order_assignments where deal_id=$1 and slot_id=$2 and cancelled_at is null', [root.deal, slot])).rows
  expect(rows).toHaveLength(1); return rows[0]!.id
}

describe('undated additional first DATE: genuine per-root reads, agreements and explicit atomic apply', () => {
  beforeAll(() => h.start())
  afterAll(() => h.close())

  it('UD1 two roots require four genuine private reads/accepts and explicit apply, preserving main/sibling and actual paid fixed dates', async () => {
    const m = await h.setup(true, true), { f } = m
    const sibling = await h.event(f.wedding, f.pair, OTHER_DATE, 'Europe/Moscow'), siblingSlot = await h.slot(f.wedding, f.pair, sibling)
    const stage = ok<{ id: string; version: number }>(await h.call('UNDATED_FIXED_STAGE', f.pair, {
      method: 'POST', url: `/weddings/${f.wedding}/payment-schedule`, key: randomUUID(), payload: {
        dealId: m.roots[0]!.deal, title: 'Synthetic fixed due', amount: { amount: 500000, currency: 'RUB' }, due: `${YEAR}-06-12` } }), 201)
    ok(await h.call('UNDATED_REAL_PAYMENT', f.pair, { method: 'POST', url: `/weddings/${f.wedding}/payment-schedule/${stage.id}/pay`,
      key: randomUUID(), payload: { version: stage.version, amount: { amount: 100000, currency: 'RUB' },
        paymentMethod: 'cash', visibility: 'private', paidOn: `${YEAR}-06-10` } }))
    const literal = async () => ({ mainRoot: await h.raw('deals', 'id=$1', [f.mainDeal]), mainSlot: await h.raw('slots', 'id=$1', [f.mainSlot]),
      mainScope: await h.scope(f, f.mainDeal!), siblingEvent: await h.raw('wedding_events', 'id=$1', [sibling.id]),
      siblingSlot: await h.raw('slots', 'id=$1', [siblingSlot]) })
    const protectedBefore = await literal(), financial = await Promise.all(m.roots.map(root => h.money(root.deal)))
    const old = await h.operational(f), p = await h.propose(m)
    expect(await h.operational(f)).toEqual(old)
    for (const root of m.roots) {
      await h.acceptMove(m, p, root, f.pair, 'customer'); expect(await h.operational(f)).toEqual(old)
      await h.acceptMove(m, p, root, root.company.actor, 'performer'); expect(await h.operational(f)).toEqual(old)
      expect(await h.effects(p)).toEqual([])
    }
    const receipts = (await h.db.query('select deal_id,party,user_id,session_id,digest from event_move_receipts where proposal_id=$1 order by deal_id,party', [p.id])).rows
    expect(receipts).toHaveLength(4)
    const key = randomUUID(), applied = ok<Proposal>(await h.apply(m, p, key))
    expect(applied).toMatchObject({ id: p.id, digest: p.digest, status: 'applied' })
    for (const root of m.roots) {
      const versions = await h.raw('deal_day_scope_versions', 'deal_id=$1', [root.deal])
      expect(versions).toHaveLength(2)
      expect(JSON.parse(versions.find(raw => (JSON.parse(raw) as { revision: number }).revision === 1)!))
        .toMatchObject({ binding_state: 'undated', service_date: null, day_id: null, time_zone: EVENT_TZ })
      expect((await h.scope(f, root.deal))[0]).toMatchObject({ revision: '2', operation: 'move', binding_state: 'active',
        context_kind: 'explicit_event', event_id: f.event.id, service_date: TARGET.date, time_zone: TARGET.timeZone, exact_head: true, matches_current: true })
    }
    const targetDays = (await h.db.query<{ id: string; date: string }>(
      'select id,date::text from vendor_busy_dates where vendor_id=$1 and date=$2::date', [f.company.id, TARGET.date])).rows
    expect(targetDays).toHaveLength(1)
    for (const root of m.roots) expect((await h.scope(f, root.deal))[0]!.day_id).toBe(targetDays[0]!.id)
    expect(await Promise.all(m.roots.map(root => h.money(root.deal)))).toEqual(financial)
    expect(await literal()).toEqual(protectedBefore); expect(await h.effects(p)).toHaveLength(1)
    const beforeReplay = await h.snapshot(f), replay = await h.apply(m, p, key)
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.headers['idempotent-replay']).toBe('true')
    expect(await h.snapshot(f)).toEqual(beforeReplay)
    witness('UNDATED_FIRST_DATE_COMPLETE', { receipts, old, after: await h.snapshot(f), financial, protectedBefore, targetDays })
    const empty = await h.slot(f.wedding, f.pair, f.event)
    await h.refusal(f, 'NULL_HEADER_AFTER_FIRST_DATE', () => h.acquire(f, { slot: empty }), 409, 'event_context_changed')
  })

  it('UD2 direct PATCH and three-of-four accepts cannot assign a first DATE', async () => {
    const m = await h.setup(true), p = await h.propose(m)
    await h.refusal(m.f, 'DIRECT_FIRST_DATE', () => h.patchEvent(m.f, TARGET), 409, 'event_move_requires_agreement')
    await h.acceptMove(m, p, m.roots[0]!, m.f.pair, 'customer')
    await h.acceptMove(m, p, m.roots[0]!, m.f.company.actor, 'performer')
    await h.acceptMove(m, p, m.roots[1]!, m.f.pair, 'customer')
    await h.refusal(m.f, 'SECOND_PERFORMER_MISSING', () => h.apply(m, p), 409, 'event_move_not_agreed')
    expect(await h.effects(p)).toEqual([])
  })

  it('UD3 unread, cross-root and cross-party proofs cannot replace real reads', async () => {
    const m = await h.setup(true, false, true), p = await h.propose(m), [a, b] = m.roots
    assert(a && b)
    const read = await h.read(m, p, a, m.f.pair), other = await h.read(m, p, b, m.f.pair)
    assert(read.readToken)
    for (const [label, root, digest, token] of [
      ['UNREAD', a, read.digest, 'not-a-signed-read'], ['CROSS_ROOT', b, other.digest, read.readToken],
    ] as const) await h.refusal(m.f, label, () => h.call(label, m.f.pair, { method: 'POST',
      url: rootMove(p.id, root.deal) + '/accept', key: randomUUID(), payload: { digest, readToken: token } }), 422, 'validation_failed')
    await h.refusal(m.f, 'CROSS_PARTY', () => h.call('CROSS_PARTY', a.company.actor, { method: 'POST',
      url: rootMove(p.id, a.deal) + '/accept', key: randomUUID(), payload: { digest: read.digest, readToken: read.readToken } }), 422, 'validation_failed')
    const privateOther = await h.call('OTHER_COMPANY_PRIVATE_ROOT', a.company.actor, { method: 'GET', url: rootMove(p.id, b.deal) })
    expect(privateOther.statusCode).toBe(404); expect(privateOther.body).not.toContain(b.company.id)
  })

  it.each(['manual', 'foreign', 'opaque'] as const)('UD4 actual %s target DATE occupancy refuses the entire first-date apply', async kind => {
    const m = await h.setup(true), p = await h.propose(m); await h.agree(m, p)
    if (kind === 'manual') await h.db.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual')", [m.f.company.id, TARGET.date])
    else if (kind === 'foreign') {
      const foreign = await h.fixture({ date: TARGET.date, timeZone: TARGET.timeZone })
      foreign.companies.push(m.f.company.id)
      foreign.actors.push(m.f.company.actor.id)
      const r = await h.call('FOREIGN_REAL_HOLD', foreign.pair, { method: 'POST', url: `/weddings/${foreign.wedding}/slots/${foreign.slot}/book`,
        key: randomUUID(), context: nullWire(foreign.event), payload: { vendorId: m.f.company.id, price: { amount: 17000, currency: 'RUB' } } })
      const root = ok<SlotReply>(r); assert(root.deal)
    } else {
      // Native orphan source from its first INSERT. The real classifier sees
      // no wedding/root and records opaque; no foreign hold is detached.
      await h.db.tx(async client => {
        await client.query('select legacy_day_lock_vendors(array[$1]::uuid[])', [m.f.company.id])
        await client.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',null)", [m.f.company.id, TARGET.date])
      })
      expect((await h.db.query(`select g.classification,g.wedding_id,g.legacy_candidates from legacy_day_groups g
        join vendor_busy_dates b on b.id=g.day_id where b.vendor_id=$1 and b.date=$2`, [m.f.company.id, TARGET.date])).rows)
        .toEqual([{ classification: 'opaque', wedding_id: null, legacy_candidates: [] }])
    }
    const before = await h.snapshot(m.f), r = await h.apply(m, p), after = await h.snapshot(m.f)
    expect(r.statusCode, r.body).toBe(409); expect(errorCode(r)).toBe('date_taken')
    expect(after).toEqual(before); expect(await h.effects(p)).toEqual([])
    witness('UNDATED_DATE_CONFLICT', { kind, before, after, response: r.body })
  })

  it.each(['resource', 'timed part', 'deliverable part', 'open request', 'RSVP deadline', 'multi event', 'done'] as const)(
    'UD5 unsupported actual %s refuses the WHOLE source before a new proposal', async kind => {
      const m = await h.setup(), root = m.roots[0]!
      let ownResourceId: string | undefined
      try {
        if (kind === 'resource') {
          ownResourceId = ok<{ id: string }>(await h.call('OWN_RESOURCE', root.company.actor, { method: 'POST', url: `/vendors/${root.company.id}/resources`, key: randomUUID(),
            payload: { kind: 'person', label: 'Synthetic own resource', personUserId: root.company.actor.id } })).id
          ok(await h.call('OWN_RESOURCE_POLICY', root.company.actor, { method: 'PATCH', url: `/vendors/${root.company.id}/availability-policy`, key: randomUUID(),
            payload: { mode: 'resources', expectedRevision: '0' } }))
        }
        if (kind === 'timed part' || kind === 'deliverable part') {
          const id = await assignment(m.f, root)
          ok(await h.call('UNKNOWN_TIMED_PART', m.f.pair, { method: 'POST', url: `/deals/${root.deal}/order/parts`, key: randomUUID(),
            payload: { expectedVersion: await orderVersion(root), kind: kind === 'timed part' ? 'timed_service' : 'deliverable', assignmentId: id,
              title: 'Synthetic active part with unknown instants', details: {} } }))
        }
        if (kind === 'open request') await h.request(m.f, await h.slot(m.f.wedding, m.f.pair, m.f.event))
        if (kind === 'RSVP deadline') ok(await h.patchEvent(m.f, { rsvpDeadline: `${YEAR}-06-01` }))
        if (kind === 'multi event') {
          const event = await h.event(m.f.wedding, m.f.pair, OTHER_DATE, 'Europe/Moscow')
          await assignment(m.f, root, await h.slot(m.f.wedding, m.f.pair, event), event)
        }
        if (kind === 'done') ok(await h.state(m.f, root.deal, 'done'))
        await h.refusal(m.f, 'WHOLE_' + kind, () => h.proposeReply(m), 409, 'event_move_scope_incomplete')
        expect(await h.raw('event_move_proposals', 'wedding_id=$1', [m.f.wedding])).toEqual([])
      } finally {
        if (ownResourceId) {
          const resourceId = ownResourceId, before = await h.raw('vendor_resources', 'id=$1', [resourceId]), audit = await h.raw('audit_log', 'true', [])
          await h.db.tx(async client => {
            const owned = (await client.query('select id,vendor_id,kind,person_user_id,created_by from vendor_resources where id=$1 for update', [resourceId])).rows
            expect(owned).toEqual([{ id: resourceId, vendor_id: root.company.id, kind: 'person', person_user_id: root.company.actor.id, created_by: root.company.actor.id }])
            for (const table of ['resource_allocations', 'resource_capacity_windows']) {
              expect(await h.raw(table, 'resource_id=$1', [resourceId], client)).toEqual([])
            }
            const deleted = await client.query(`delete from vendor_resources where id=$1 and vendor_id=$2 and kind='person'
              and person_user_id=$3 and created_by=$3 returning id`, [resourceId, root.company.id, root.company.actor.id])
            expect(deleted.rows).toEqual([{ id: resourceId }])
          })
          const after = await h.raw('vendor_resources', 'id=$1', [resourceId]), retained = new Set(await h.raw('audit_log', 'true', []))
          expect(before).toHaveLength(1); expect(after).toEqual([])
          for (const row of audit) expect(retained.has(row), 'Own unallocated resource cleanup retains every observed audit').toBe(true)
          witness('UNDATED_OWN_RESOURCE_CLEANUP', { resourceId, vendorId: root.company.id, personUserId: root.company.actor.id, before, after, auditRowsRetained: audit.length })
        }
      }
    })

  it('UD6 source price changed after four accepts makes the proposal stale, without partial DATE', async () => {
    const m = await h.setup(true), p = await h.propose(m); await h.agree(m, p)
    ok(await h.call('SOURCE_PRICE_CHANGED', m.f.pair, { method: 'PATCH', url: `/deals/${m.roots[0]!.deal}`, key: randomUUID(),
      payload: { price: { amount: 2468001, currency: 'RUB' } } }))
    await h.refusal(m.f, 'STALE_SOURCE_AFTER_ACCEPT', () => h.apply(m, p), 409, 'event_move_source_changed')
  })

  it.each([false, true])('UD7 actual session revocation while waiting refuses fresh/saved apply replay=%s', async replay => {
    const m = await h.setup(), p = await h.propose(m); await h.agree(m, p)
    const key = randomUUID(); if (replay) ok(await h.apply(m, p, key))
    const before = await h.snapshot(m.f)
    const r = await h.duringWait(m.f, 'FIRST_DATE_REVOKED_SESSION', () => h.apply(m, p, key), c =>
      c.query('update sessions set revoked_at=clock_timestamp() where id=$1 and user_id=$2', [m.f.pair.sid, m.f.pair.id]))
    expect(r.statusCode, r.body).toBe(401); expect(await h.snapshot(m.f)).toEqual(before)
  })

  it('UD8 native SQL22012 after complete first-date callback rolls back both heads/effect/receipt and same key retries', async () => {
    const m = await h.setup(true), p = await h.propose(m); await h.agree(m, p)
    const before = await h.snapshot(m.f), key = randomUUID(), database = h.db, original = database.tx, forward = database.tx.bind(database)
    let callbackCompleted = false, sqlstate: string | undefined
    database.tx = async <T>(action: (c: Queryable) => Promise<T>) => forward(async client => {
      const result = await action(client)
      if (!callbackCompleted && (await client.query("select id from event_move_effects where proposal_id=$1 and action='apply'", [p.id])).rowCount) {
        callbackCompleted = true
        witness('UNDATED_FAULT_PRE', { callbackCompleted, heads: await h.raw('deal_day_scope_heads', 'wedding_id=$1', [m.f.wedding], client) })
        try { await client.query('select 1/0') } catch (error) { sqlstate = (error as { code?: string }).code; throw error }
      }
      return result
    })
    let r: Reply
    try { r = await h.apply(m, p, key) } finally { database.tx = original }
    witness('UNDATED_FAULT', { callbackCompleted, sqlstate, response: r.body, before, after: await h.snapshot(m.f) })
    expect(callbackCompleted).toBe(true); expect(sqlstate).toBe('22012'); expect(r.statusCode).toBe(500)
    expect(await h.snapshot(m.f)).toEqual(before); expect(await h.effects(p)).toEqual([])
    expect(ok<Proposal>(await h.apply(m, p, key)).status).toBe('applied'); expect(await h.effects(p)).toHaveLength(1)
  })

  it('UD9 callback-complete financial mutation reaches real outer COMMIT23514 and cannot leave either first DATE head', async () => {
    const m = await h.setup(true), p = await h.propose(m); await h.agree(m, p)
    const before = await h.snapshot(m.f), key = randomUUID(), database = h.db, original = database.tx, forward = database.tx.bind(database)
    let callbackCompleted = false, mutationCompleted = false, actual: { code?: string; constraint?: string } | undefined
    database.tx = async <T>(action: (c: Queryable) => Promise<T>) => {
      try { return await forward(async client => {
        const result = await action(client)
        if (!mutationCompleted && (await client.query("select id from event_move_effects where proposal_id=$1 and action='apply'", [p.id])).rowCount) {
          callbackCompleted = true
          const changed = await client.query('update deals set price=price+1 where id=$1 returning id,price::text', [m.roots[0]!.deal])
          expect(changed.rowCount).toBe(1); mutationCompleted = true
          witness('UNDATED_OUTER_COMMIT_PRE', { callbackCompleted, mutationCompleted, changed: changed.rows })
        }
        return result
      }) } catch (error) { actual = error as typeof actual; throw error }
    }
    let r: Reply
    try { r = await h.apply(m, p, key) } finally { database.tx = original }
    witness('UNDATED_OUTER_COMMIT', { callbackCompleted, mutationCompleted, actual, status: r.statusCode, before, after: await h.snapshot(m.f) })
    expect(callbackCompleted && mutationCompleted).toBe(true)
    expect(actual).toMatchObject({ code: '23514', constraint: 'event_move_complete' }); expect(r.statusCode).toBe(500)
    expect(await h.snapshot(m.f)).toEqual(before); expect(await h.effects(p)).toEqual([])
    expect(ok<Proposal>(await h.apply(m, p, key)).status).toBe('applied')
  })
  it('UD10 two weddings contend for one actual vendor DATE after a witnessed native wedding wait', async () => {
    const a = await h.setup(), second = await h.fresh()
    second.companies.push(a.f.company.id)
    second.actors.push(a.f.company.actor.id)
    const secondRoot = await h.acquiredNull(second, await h.acquire(second, { company: a.f.company }), { company: a.f.company })
    const b = { f: second, roots: [secondRoot] }, pa = await h.propose(a), pb = await h.propose(b)
    await h.agree(a, pa); await h.agree(b, pb)
    const protectedA = { event: await h.raw('wedding_events', 'id=$1', [a.f.event.id]),
      versions: await h.raw('deal_day_scope_versions', 'deal_id=$1', [a.roots[0]!.deal]), money: await h.money(a.roots[0]!.deal) }
    let winner: Proposal | undefined
    const loser = await h.duringWait(a.f, 'TWO_WEDDINGS_FIRST_DATE', () => h.apply(a, pa), async () => undefined,
      async () => { winner = ok<Proposal>(await h.apply(b, pb)); expect(winner.status).toBe('applied') })
    expect(loser.statusCode, loser.body).toBe(409); expect(errorCode(loser)).toBe('date_taken'); assert(winner)
    expect(await h.effects(pa)).toEqual([]); expect(await h.effects(pb)).toHaveLength(1)
    expect({ event: await h.raw('wedding_events', 'id=$1', [a.f.event.id]),
      versions: await h.raw('deal_day_scope_versions', 'deal_id=$1', [a.roots[0]!.deal]), money: await h.money(a.roots[0]!.deal) }).toEqual(protectedA)
    expect((await h.db.query('select id from vendor_busy_dates where vendor_id=$1 and date=$2::date', [a.f.company.id, TARGET.date])).rows).toHaveLength(1)
    witness('UNDATED_TWO_WEDDING_RACE', { winner, loser: loser.body, protectedA })
  })
  it.each([null, '9007199254740992'])('UD11 native amount=%s stays explicit and refuses the whole unknown/unsafe first-date scope', async amount => {
    const m = await h.setup()
    await h.db.query('update deals set price=$2::bigint where id=$1', [m.roots[0]!.deal, amount])
    expect((await h.db.query('select price::text from deals where id=$1', [m.roots[0]!.deal])).rows).toEqual([{ price: amount }])
    await h.refusal(m.f, 'UNKNOWN_OR_UNSAFE_AMOUNT', () => h.proposeReply(m), 409, 'event_move_scope_incomplete')
  })
  it('UD12 lawful explicit zero amount can agree a first DATE without being reinterpreted as unknown', async () => {
    const m = await h.setup()
    ok(await h.call('EXPLICIT_ZERO', m.f.pair, { method: 'PATCH', url: `/deals/${m.roots[0]!.deal}`, key: randomUUID(),
      payload: { price: { amount: 0, currency: 'RUB' } } }))
    const p = await h.propose(m); await h.agree(m, p)
    const financial = await h.money(m.roots[0]!.deal)
    expect(ok<Proposal>(await h.apply(m, p)).status).toBe('applied'); expect(await h.money(m.roots[0]!.deal)).toEqual(financial)
  })

  it('UD13 first DATE joins the existing OWN target cohort without replacing its physical identity or losing any of three holders', async () => {
    const f = await h.fresh(true)
    assert(f.mainDeal)
    // Establish a real dated sibling and its target DATE before either NULL
    // root exists. This is the existing public book route, never a raw hold.
    const datedEvent = await h.event(f.wedding, f.pair, TARGET.date, TARGET.timeZone)
    const datedSlot = await h.slot(f.wedding, f.pair, datedEvent)
    const datedReply = await h.call('OWN_TARGET_DATED_BOOK', f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/slots/${datedSlot}/book`, key: randomUUID(), context: nullWire(datedEvent),
      payload: { vendorId: f.company.id, price: { amount: 6543210, currency: 'RUB' } } })
    const dated = ok<SlotReply>(datedReply); assert(dated.deal)
    const datedDeal = dated.deal.id, datedScope = await h.scope(f, datedDeal)
    expect(datedScope).toHaveLength(1)
    expect(datedScope[0]).toMatchObject({ context_kind: 'explicit_event', event_id: datedEvent.id,
      binding_state: 'active', service_date: TARGET.date, time_zone: TARGET.timeZone, exact_head: true, matches_current: true })
    const targetDay = datedScope[0]!.day_id
    assert.equal(typeof targetDay, 'string')
    const existingDays = (await h.db.query<{ id: string; vendor_id: string; date: string; source: string }>(
      'select id,vendor_id,date::text,source from vendor_busy_dates where vendor_id=$1 and date=$2::date', [f.company.id, TARGET.date])).rows
    expect(existingDays).toEqual([{ id: targetDay, vendor_id: f.company.id, date: TARGET.date, source: 'deal' }])
    const holderRows = async () => (await h.db.query<{ deal_id: string; version_id: string; day_id: string;
      binding_state: string; context_kind: string; service_date: string; time_zone: string }>(
      `select k.deal_id,k.id version_id,k.day_id,k.binding_state,k.context_kind,k.service_date::text,k.time_zone
      from legacy_day_known_holders($1::uuid) k order by k.deal_id`, [targetDay])).rows
    expect((await holderRows()).map(row => row.deal_id)).toEqual([datedDeal])

    const stage = ok<{ id: string; version: number }>(await h.call('OWN_TARGET_FIXED_DUE', f.pair, {
      method: 'POST', url: `/weddings/${f.wedding}/payment-schedule`, key: randomUUID(), payload: {
        dealId: datedDeal, title: 'Synthetic existing dated fixed due', amount: { amount: 500000, currency: 'RUB' }, due: `${YEAR}-06-12` } }), 201)
    ok(await h.call('OWN_TARGET_REAL_PAYMENT', f.pair, { method: 'POST',
      url: `/weddings/${f.wedding}/payment-schedule/${stage.id}/pay`, key: randomUUID(), payload: {
        version: stage.version, amount: { amount: 100000, currency: 'RUB' }, paymentMethod: 'cash',
        visibility: 'private', paidOn: `${YEAR}-06-10` } }))
    expect((await h.db.query(`select amount::text,currency,status,installment_id,visibility,paid_on::text
      from payments where deal_id=$1 and installment_id=$2`, [datedDeal, stage.id])).rows)
      .toEqual([{ amount: '100000', currency: 'RUB', status: 'recorded', installment_id: stage.id, visibility: 'private', paid_on: `${YEAR}-06-10` }])
    expect((await h.db.query('select amount::text,paid::text,due::text from payment_installments where id=$1 and deal_id=$2', [stage.id, datedDeal])).rows)
      .toEqual([{ amount: '500000', paid: '100000', due: `${YEAR}-06-12` }])
    const datedLiteral = async () => ({ event: await h.raw('wedding_events', 'id=$1', [datedEvent.id]),
      slot: await h.raw('slots', 'id=$1', [datedSlot]), head: await h.raw('deal_day_scope_heads', 'deal_id=$1', [datedDeal]),
      versions: await h.raw('deal_day_scope_versions', 'deal_id=$1', [datedDeal]), financial: await h.money(datedDeal) })
    const datedBefore = await datedLiteral(), mainBefore = { financial: await h.money(f.mainDeal),
      slot: await h.raw('slots', 'id=$1', [f.mainSlot]), head: await h.raw('deal_day_scope_heads', 'deal_id=$1', [f.mainDeal]),
      versions: await h.raw('deal_day_scope_versions', 'deal_id=$1', [f.mainDeal]) }

    const first = await h.acquiredNull(f, await h.acquire(f)), secondSlot = await h.slot(f.wedding, f.pair, f.event)
    const second = await h.acquiredNull(f, await h.acquire(f, { slot: secondSlot, price: 3456700 }), { slot: secondSlot, price: 3456700 })
    const m = { f, roots: [first, second] }, allDeals = [datedDeal, first.deal, second.deal]
    const oldVersions = new Map<string, string[]>()
    for (const deal of allDeals) {
      const literal = await h.raw('deal_day_scope_versions', 'deal_id=$1', [deal])
      expect(literal).toHaveLength(1); oldVersions.set(deal, literal)
    }
    const nullMoney = await Promise.all(m.roots.map(root => h.money(root.deal)))
    const resolutions = () => h.raw('audit_log', "action='legacy_day.resolved' and entity_id=any($1::uuid[])", [allDeals])
    const oldResolutionRows = await resolutions(); expect(oldResolutionRows).toEqual([])
    const operational = await h.operational(f), p = await h.propose(m)
    await h.agree(m, p)
    expect((await h.db.query('select id from event_move_receipts where proposal_id=$1', [p.id])).rows).toHaveLength(4)
    expect(await h.operational(f)).toEqual(operational); expect(await h.effects(p)).toEqual([])
    expect((await holderRows()).map(row => row.deal_id)).toEqual([datedDeal])
    const applied = ok<Proposal>(await h.apply(m, p))
    expect(applied).toMatchObject({ id: p.id, status: 'applied' }); expect(await h.effects(p)).toHaveLength(1)

    const expectedHeads = new Map<string, unknown>([[datedDeal, datedScope[0]!.id]])
    for (const root of m.roots) {
      const current = await h.scope(f, root.deal)
      expect(current).toHaveLength(1)
      expect(current[0]).toMatchObject({ revision: '2', operation: 'move', binding_state: 'active', day_id: targetDay,
        context_kind: 'explicit_event', event_id: f.event.id, service_date: TARGET.date, time_zone: TARGET.timeZone,
        exact_head: true, matches_current: true })
      expectedHeads.set(root.deal, current[0]!.id)
      expect(await h.raw('deal_day_scope_versions', 'deal_id=$1', [root.deal])).toHaveLength(2)
    }
    const holders = await holderRows()
    expect(holders.map(row => row.deal_id)).toEqual([...allDeals].sort())
    for (const holder of holders) expect(holder).toMatchObject({ version_id: expectedHeads.get(holder.deal_id),
      day_id: targetDay, binding_state: 'active', context_kind: 'explicit_event', service_date: TARGET.date, time_zone: TARGET.timeZone })
    const afterDays = (await h.db.query<{ id: string; vendor_id: string; date: string; source: string; deal_id: string }>(
      'select id,vendor_id,date::text,source,deal_id from vendor_busy_dates where vendor_id=$1 and date=$2::date', [f.company.id, TARGET.date])).rows
    expect(afterDays).toHaveLength(1)
    expect(afterDays[0]).toMatchObject(existingDays[0]!)
    expect(allDeals).toContain(afterDays[0]!.deal_id) // The valid representative may change; the physical DATE may not.
    expect((await h.db.query(`select day_id,vendor_id,wedding_id,classification,legacy_candidates from legacy_day_groups where day_id=$1`, [targetDay])).rows)
      .toEqual([{ day_id: targetDay, vendor_id: f.company.id, wedding_id: f.wedding, classification: 'exact', legacy_candidates: [] }])
    for (const [deal, literal] of oldVersions) {
      const ids = literal.map(raw => (JSON.parse(raw) as { id: string }).id)
      expect(await h.raw('deal_day_scope_versions', 'id=any($1::uuid[])', [ids]), 'Full old version row for ' + deal).toEqual(literal)
    }
    expect(await datedLiteral()).toEqual(datedBefore)
    expect(await Promise.all(m.roots.map(root => h.money(root.deal)))).toEqual(nullMoney)
    expect({ financial: await h.money(f.mainDeal), slot: await h.raw('slots', 'id=$1', [f.mainSlot]),
      head: await h.raw('deal_day_scope_heads', 'deal_id=$1', [f.mainDeal]),
      versions: await h.raw('deal_day_scope_versions', 'deal_id=$1', [f.mainDeal]) }).toEqual(mainBefore)
    expect(await resolutions()).toEqual(oldResolutionRows)
    const events = ok<{ id: string; date: string | null; timeZone: string | null }[]>(await h.call('OWN_TARGET_ACTUAL_EVENTS', f.pair,
      { method: 'GET', url: `/weddings/${f.wedding}/events` }))
    expect(events.find(event => event.id === f.event.id)).toMatchObject({ date: TARGET.date, timeZone: TARGET.timeZone })
    witness('UNDATED_EXISTING_OWN_COHORT', { targetDay, datedDeal, roots: m.roots, oldVersions: [...oldVersions],
      datedBefore, mainBefore, nullMoney, holders, existingDays, afterDays, oldResolutionRows, after: await h.snapshot(f) })
  })
})
