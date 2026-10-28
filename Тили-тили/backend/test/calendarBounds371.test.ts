import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activateLegacyCalendarBounds } from '../src/resources/legacy-calendar.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import type { CalendarBoundsPrivateView } from '../src/resources/legacy-calendar.js'
import { Calendar371Fixture, denied, ok, span, type Cohort, type ResourceKind } from './calendarBounds371.fixtures.js'

// Full371 frozen D1–D11. No fabricated SQL receipts in any positive proof.
// This suite requires Root's separately registered fresh schema94 cluster.
// Multi-source public proof contains many individually bounded HTTP requests.
describe.sequential('FULL371 genuine per-holder public proof and native boundaries', { timeout: 240_000 }, () => {
  const h = new Calendar371Fixture()
  beforeAll(() => h.open())
  afterAll(() => h.close())

  async function source(c: Cohort, kind = 'app_day'): Promise<string> {
    const row = (await h.liveSources(c.company)).find(s => s.kind === kind)
    assert(row, `SETUP_371: actual ${kind} source required; absence is not domain RED`)
    return row.id
  }
  async function proposed(c: Cohort): Promise<{ id: string; view: CalendarBoundsPrivateView }> {
    const id = await source(c, c.date === null ? 'app_root' : 'app_day')
    return { id, view: await h.propose(c.company, id) }
  }
  function acceptBody(read: CalendarBoundsPrivateView) {
    assert(read.proposal && read.readToken, 'SETUP_371: genuine private read token required')
    return { boundsVersionId: read.proposal.id, expectedVersion: read.proposal.version, digest: read.proposal.digest, readToken: read.readToken }
  }
  async function noEffect(c: Cohort): Promise<void> { expect(await h.effectCount(c.company)).toBe(0) }

  it('CB371-P00 positive control: genuine schema2 resource commitment without legacy succeeds', async () => {
    const company = await h.company(), ready = await h.ready(company)
    const reply = await h.commit(ready)
    expect(reply.statusCode).toBe(200)
    expect((await h.db.query<{ n: number }>('select count(*)::int n from resource_allocations where deal_id=$1 and released_at is null', [ready.deal])).rows[0]!.n).toBe(1)
  })
  it('CB371-RED activated full public proof permits disjoint existing commitment beyond old blanket refusal', async () => {
    const c = await h.cohort(), ready = await h.ready(c.company)
    const legacyMoney = await h.finance(), counters = await h.counters(c.company)
    // Initial existing boundary control, before any bounds proof.
    denied(await h.commit(ready), 409, 'unresolved_legacy_obligations')
    const live = await h.liveSources(c.company)
    expect(live.some(s => s.kind === 'app_day')).toBe(true)
    expect(live.some(s => s.kind === 'app_root')).toBe(true)
    await h.settleAll(c.company)
    expect(await h.finance()).toEqual(legacyMoney)
    expect(await h.counters(c.company)).toEqual(counters) // company spans did not debit capacity
    const reply = await h.commit(ready)
    // The meaningful feature RED is THIS assertion after all SETUP_371 controls passed.
    expect(reply.statusCode, 'DOMAIN_RED_EXISTING_COMMIT_AFTER_GENUINE_ALL_SOURCE_PROOF').toBe(200)
    expect((await h.db.query<{ used: string }>('select used::text from resource_capacity_windows where id=$1', [ready.window])).rows[0]!.used).toBe('3')
  })
  it('CB371-P00B a pending row with an old booked_at marker cannot use initial conversion', async () => {
    const company = await h.company(), ready = await h.ready(company)
    await h.db.query('update deals set booked_at=clock_timestamp() where id=$1', [ready.deal])
    const money = await h.finance(), counters = await h.counters(company)
    denied(await h.commit(ready), 409, 'resource_initial_booking_required')
    expect((await h.db.query<{ n: number }>('select count(*)::int n from resource_allocations where deal_id=$1', [ready.deal])).rows[0]!.n).toBe(0)
    expect(await h.finance()).toEqual(money); expect(await h.counters(company)).toEqual(counters)
  })
  it('CB371-A01 list and owner editor are read-only and never issue a party read token', async () => {
    const c = await h.cohort(), id = await source(c), before = await h.graph(c.company), money = await h.finance()
    expect((await h.list(c.company)).sources.some(s => s.sourceId === id)).toBe(true)
    const editor = await h.editor(c.company, id)
    expect(editor.readToken).toBeNull(); expect(editor.proposal).toBeNull()
    expect(await h.graph(c.company)).toEqual(before); expect(await h.finance()).toEqual(money)
    await noEffect(c)
  })
  it('CB371-A02 technical capture and immutable proposal have no receipt or effect', async () => {
    const c = await h.cohort(), id = await source(c), money = await h.finance()
    const captured = await h.capture(c.company, id)
    expect(captured.readToken).toBeNull(); expect(captured.proposal).toBeNull()
    const p = await h.propose(c.company, id)
    expect(p.proposal!.holders).toHaveLength(2); expect(p.source.effectiveVersionId).toBeNull()
    expect(p.readiness.requiredReceipts).toBe(4); expect(p.readiness.acceptedReceipts).toBe(0)
    expect(await h.finance()).toEqual(money); await noEffect(c)
  })
  it('CB371-A03 proposal cannot omit one actual holder of a shared DAY source', async () => {
    const c = await h.cohort(), id = await source(c), e = await h.capture(c.company, id), body = h.declaration(e)
    expect(body.holders).toHaveLength(2); body.holders.pop()
    const before = await h.graph(c.company)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/proposals', body), 422)
    expect(await h.graph(c.company)).toEqual(before); await noEffect(c)
  })
  it('CB371-A04 missing one holder party retains the whole old blocker', async () => {
    const c = await h.cohort(), { id } = await proposed(c)
    await h.accept(c.pair, c.wedding, c.deals[0]!, id)
    await h.accept(c.company.owner, c.wedding, c.deals[0]!, id)
    await h.accept(c.pair, c.wedding, c.deals[1]!, id)
    const e = await h.editor(c.company, id), before = await h.graph(c.company)
    expect(e.readiness.acceptedReceipts).toBe(3)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/activate', h.activation(e)), 409, 'legacy_calendar_bounds_not_agreed')
    expect(await h.graph(c.company)).toEqual(before); await noEffect(c)
  })
  it('CB371-A05 the fourth real receipt still needs a separate explicit activation', async () => {
    const c = await h.cohort(), { id } = await proposed(c), money = await h.finance()
    await h.agree(c.company, id)
    const e = await h.editor(c.company, id)
    expect(e.readiness.acceptedReceipts).toBe(4); expect(e.readiness.canActivate).toBe(true)
    expect(e.source.effectiveVersionId).toBeNull(); await noEffect(c)
    const effective = await h.activate(c.company, id)
    expect(effective.source.effectiveVersionId).toBe(e.proposal!.id)
    expect(effective.source.state).toBe('finite'); expect(await h.effectCount(c.company)).toBe(1)
    expect(await h.finance()).toEqual(money)
  })
  it('CB371-A06 agreeing an app_day source never inherits consent into app_root aliases', async () => {
    const c = await h.cohort(), ready = await h.ready(c.company), id = await source(c)
    const aliases = (await h.liveSources(c.company)).filter(s => s.kind === 'app_root')
    expect(aliases.length).toBeGreaterThan(0)
    await h.propose(c.company, id); await h.agree(c.company, id); await h.activate(c.company, id)
    for (const alias of aliases) {
      const e = await h.editor(c.company, alias.id)
      expect(e.source.effectiveVersionId).toBeNull(); expect(e.receipts).toHaveLength(0)
    }
    denied(await h.commit(ready), 409, 'unresolved_legacy_obligations')
  })
  it('CB371-A07 ledgerless NULL-DATE app_root accepts explicit bounds without inventing a DATE', async () => {
    const c = await h.cohort(1, null), { id } = await proposed(c)
    const dates = await h.raw('weddings', 'id=$1', [c.wedding])
    await h.agree(c.company, id); const effective = await h.activate(c.company, id)
    expect(effective.source.state).toBe('finite'); expect(effective.source.originDate).toBeNull()
    expect(await h.raw('weddings', 'id=$1', [c.wedding])).toEqual(dates)
  })
  it('CB371-A08 genuine manual declaration needs owner activation but never forged party receipts', async () => {
    const company = await h.company(), id = await h.manual(company)
    await h.propose(company, id)
    expect(await h.effectCount(company)).toBe(0)
    const e = await h.activate(company, id)
    expect(e.source.state).toBe('finite'); expect(e.readiness.requiredReceipts).toBe(0)
    expect((await h.db.query<{ n: number }>('select count(*)::int n from legacy_calendar_bounds_receipts where source_id=$1', [id])).rows[0]!.n).toBe(0)
  })
  it('CB371-A19 actual live negotiation expiry invalidates read proof without auto-activating or deleting history', async () => {
    const c = await h.cohort(1, null, false, 'negotiating'), id = await source(c, 'live_negotiation')
    const p = await h.propose(c.company, id), old = await h.raw('legacy_calendar_bounds_versions', 'id=$1', [p.proposal!.id])
    await h.db.query("update deals set negotiating_until=clock_timestamp()-interval '1 second' where id=$1", [c.deals[0]])
    const e = await h.editor(c.company, id)
    expect(e.source.freshness).toBe('unavailable'); expect(e.readToken).toBeNull()
    expect(await h.raw('legacy_calendar_bounds_versions', 'id=$1', [p.proposal!.id])).toEqual(old); await noEffect(c)
  })
  it('CB371-A20 an actual orphan deal-DAY cannot become owner-consented finite', async () => {
    const c = await h.cohort(1)
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { weddingIds: [c.wedding], vendorIds: [c.company.id], actor: h.actorInput(c.pair), mode: 'erase' })
      await client.query('delete from weddings where id=$1', [c.wedding])
    })
    const id = await source(c, 'orphan_day'), e = await h.capture(c.company, id), before = await h.graph(c.company)
    expect(e.source.scopeCompleteness).toBe('unknown')
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/proposals', h.declaration(e)), 409, 'legacy_calendar_scope_incomplete')
    expect(await h.graph(c.company)).toEqual(before); await noEffect(c)
  })
  it('CB371-A09 unknown staffing declaration cannot establish effective person narrowing', async () => {
    const c = await h.cohort(), id = await source(c), e = await h.capture(c.company, id), body = h.declaration(e)
    body.staffing.completeness = 'unknown'
    ok(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/proposals', body), 'unknown staffing proposal remains descriptive')
    await h.agree(c.company, id)
    const current = await h.editor(c.company, id), before = await h.graph(c.company)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/activate', h.activation(current)), 409)
    expect(await h.graph(c.company)).toEqual(before); await noEffect(c)
  })
  it('CB371-A10 helper cannot substitute for either contract party', async () => {
    const c = await h.cohort(), { id } = await proposed(c), helper = await h.actor()
    await h.db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [c.wedding, helper.id])
    const before = await h.graph(c.company)
    denied(await h.call(helper, 'GET', h.holderUrl(c.wedding, c.deals[0]!, id)), 404)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-A10B private read rechecks its session after a proven user-row wait', async () => {
    const c = await h.cohort(), { id } = await proposed(c), before = await h.graph(c.company)
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL, statement_timeout: 8000, idle_in_transaction_session_timeout: 10000 })
    await blocker.connect()
    let pending: ReturnType<typeof h.call> | undefined
    try {
      await blocker.query('begin')
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await blocker.query('select id from users where id=$1 for update', [c.pair.id])
      pending = h.call(c.pair, 'GET', h.holderUrl(c.wedding, c.deals[0]!, id))
      const deadline = performance.now() + 8000
      let witness: { pid: number; query: string; blockers: number[] } | undefined
      while (performance.now() < deadline) {
        const rows = (await h.db.query<{ pid: number; query: string; blockers: number[] }>(`select pid,query,pg_blocking_pids(pid) blockers
          from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and $1=any(pg_blocking_pids(pid)) and query ilike '%from users%'`, [pid])).rows
        if (rows.length) { expect(rows).toHaveLength(1); witness = rows[0]; break }
        await pause(10)
      }
      assert(witness, 'SETUP_371: actual private-read user SHARE wait required, elapsed sleep is not evidence')
      expect(witness.blockers).toContain(pid)
      process.stdout.write(`CALENDAR371_PRIVATE_READ_WAIT ${JSON.stringify({ blockerPid: pid, waiterPid: witness.pid, query: witness.query, blockers: witness.blockers })}\n`)
      await blocker.query('update sessions set revoked_at=clock_timestamp() where id=$1', [c.pair.sid])
      await blocker.query('commit')
      const reply = await pending
      denied(reply, 401); expect(reply.json<{ readToken?: string }>().readToken).toBeUndefined()
      expect(await h.graph(c.company)).toEqual(before)
    } finally {
      await blocker.query('rollback').catch(() => undefined)
      await blocker.end()
      if (pending) await pending
    }
  })
  it('CB371-A11 another current session cannot replay a read proof from the same user', async () => {
    const c = await h.cohort(), { id } = await proposed(c), twin = await h.actor(c.pair.id)
    const read = await h.read(c.pair, c.wedding, c.deals[0]!, id), before = await h.graph(c.company)
    denied(await h.call(twin, 'POST', h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept', acceptBody(read)), 422, 'validation_failed')
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-A12 performer proof cannot be submitted by the customer', async () => {
    const c = await h.cohort(), { id } = await proposed(c)
    const read = await h.read(c.company.owner, c.wedding, c.deals[0]!, id), before = await h.graph(c.company)
    denied(await h.call(c.pair, 'POST', h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept', acceptBody(read)), 422)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-A13 fully valid expired negative proof is rejected at the actual public accept door', async () => {
    const c = await h.cohort(), { id } = await proposed(c), read = await h.read(c.pair, c.wedding, c.deals[0]!, id)
    const body = acceptBody(read); body.readToken = await h.expired(body.readToken)
    const before = await h.graph(c.company)
    denied(await h.call(c.pair, 'POST', h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept', body), 409, 'calendar_bounds_read_expired')
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-A14 history read has no current-purpose token and old proposal cannot accept', async () => {
    const c = await h.cohort(), { id, view: old } = await proposed(c)
    const read = await h.read(c.pair, c.wedding, c.deals[0]!, id)
    await h.propose(c.company, id)
    const history = await h.read(c.pair, c.wedding, c.deals[0]!, id, old.proposal!.id)
    expect(history.readToken).toBeNull(); expect(history.readiness.canAccept).toBe(false)
    const before = await h.graph(c.company)
    denied(await h.call(c.pair, 'POST', h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept', acceptBody(read)), 409)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-A15 one actual owner-couple user cannot provide both required parties', async () => {
    const c = await h.cohort(1, '2027-07-01', true), { id } = await proposed(c)
    await h.accept(c.pair, c.wedding, c.deals[0]!, id)
    const e = await h.editor(c.company, id)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/activate', h.activation(e)), 409)
    expect((await h.db.query<{ n: number }>('select count(*)::int n from legacy_calendar_bounds_receipts where source_id=$1', [id])).rows[0]!.n).toBe(1)
    await noEffect(c)
  })
  it('CB371-A17 a genuine old-purpose terms GET token cannot become a bounds receipt', async () => {
    const c = await h.cohort(), ready = await h.ready(c.company), { id } = await proposed(c)
    const read = await h.read(c.pair, c.wedding, c.deals[0]!, id), body = acceptBody(read)
    body.readToken = ready.termsReadToken
    const before = await h.graph(c.company)
    denied(await h.call(c.pair, 'POST', h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept', body), 422, 'validation_failed')
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-A18 malformed serialized proof cannot produce a receipt through the registered API', async () => {
    const c = await h.cohort(), { id } = await proposed(c), read = await h.read(c.pair, c.wedding, c.deals[0]!, id)
    const body = { ...acceptBody(read), readToken: 'not-a-jwt' }, before = await h.graph(c.company)
    denied(await h.call(c.pair, 'POST', h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept', body), 422)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it.each(['session', 'consent'] as const)('CB371-A16 current %s withdrawal invalidates already accepted parties', async kind => {
    const c = await h.cohort(), { id } = await proposed(c); await h.agree(c.company, id)
    if (kind === 'session') await h.db.query('update sessions set revoked_at=clock_timestamp() where id=$1', [c.pair.sid])
    else await h.db.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1', [c.pair.id])
    const e = await h.editor(c.company, id), before = await h.graph(c.company)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/activate', h.activation(e)), kind === 'session' ? 401 : 403)
    expect(await h.graph(c.company)).toEqual(before); await noEffect(c)
  })
  it('CB371-R01 same-key public accept retry is identical and creates only one receipt', async () => {
    const c = await h.cohort(), { id } = await proposed(c), read = await h.read(c.pair, c.wedding, c.deals[0]!, id)
    const key = randomUUID(), body = acceptBody(read), url = h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept'
    const first = await h.call(c.pair, 'POST', url, body, key); ok(first, 'first real accept')
    const before = await h.graph(c.company), second = await h.call(c.pair, 'POST', url, body, key)
    expect(second.statusCode).toBe(200); expect(second.json()).toStrictEqual(first.json()); expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-R02 same-key cached proposal refuses changed source material', async () => {
    const c = await h.cohort(), id = await source(c), e = await h.capture(c.company, id), key = randomUUID(), body = h.declaration(e)
    const url = h.ownerUrl(c.company, id) + '/proposals'
    const first = await h.call(c.company.owner, 'POST', url, body, key); ok(first, 'first proposal')
    const same = await h.call(c.company.owner, 'POST', url, body, key)
    expect(same.statusCode).toBe(200); expect(same.json()).toStrictEqual(first.json())
    await h.addPart(c, '2027-07-01T09:00:00Z')
    const before = await h.graph(c.company)
    denied(await h.call(c.company.owner, 'POST', url, body, key), 409)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-R03 cached acceptance cannot bypass a now-revoked current session', async () => {
    const c = await h.cohort(), { id } = await proposed(c), read = await h.read(c.pair, c.wedding, c.deals[0]!, id)
    const key = randomUUID(), body = acceptBody(read), url = h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept'
    ok(await h.call(c.pair, 'POST', url, body, key), 'first actual acceptance')
    await h.db.query('update sessions set revoked_at=clock_timestamp() where id=$1', [c.pair.sid])
    const before = await h.graph(c.company)
    denied(await h.call(c.pair, 'POST', url, body, key), 401)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-E01 actual remaining deliverable point must be covered by declared span union', async () => {
    const c = await h.cohort(); await h.addPart(c, '2027-07-01T12:00:00Z')
    const id = await source(c), e = await h.capture(c.company, id), before = await h.graph(c.company)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/proposals', h.declaration(e)), 422)
    expect(await h.graph(c.company)).toEqual(before)
    const second = span({ localStartsAt: '2027-07-01T13:00:00', localEndsAt: '2027-07-01T15:00:00', startsAt: '2027-07-01T11:00:00Z', endsAt: '2027-07-01T13:00:00Z' })
    const positive = await h.propose(c.company, id, [span(), second])
    expect(positive.proposal!.holders![0]!.spans).toHaveLength(2)
  })
  it('CB371-E02 calendar_closed cannot hide an actual remaining output', async () => {
    const c = await h.cohort(); await h.addPart(c, '2027-07-01T12:00:00Z')
    const id = await source(c), e = await h.capture(c.company, id), before = await h.graph(c.company)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/proposals', h.declaration(e, [], 'calendar_closed')), 422)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-E03 fresh parties can close an empty known legacy structure without changing its money or state', async () => {
    const c = await h.cohort(), id = await source(c), money = await h.finance()
    await h.propose(c.company, id, [], 'calendar_closed'); await h.agree(c.company, id)
    const e = await h.activate(c.company, id)
    expect(e.source.state).toBe('calendar_closed'); expect(await h.finance()).toEqual(money)
  })
  it('CB371-D01 whole local Berlin spring DAY stores actual 23-hour UTC period and original DATE', async () => {
    const c = await h.cohort(1, '2027-03-28'), id = await source(c)
    const whole = span({ spanMode: 'whole_local_day', localStartsAt: '2027-03-28T00:00:00', localEndsAt: '2027-03-29T00:00:00',
      startsAt: '2027-03-27T23:00:00Z', endsAt: '2027-03-28T22:00:00Z' })
    const e = await h.propose(c.company, id, [whole]), saved = e.proposal!.holders![0]!.spans[0]!
    expect(saved.originalDate).toBe('2027-03-28'); expect(saved.startsAt).toBe('2027-03-27T23:00:00.000Z')
    expect(saved.endsAt).toBe('2027-03-28T22:00:00.000Z'); expect(saved.timeZone).toBe('Europe/Berlin')
    expect(Date.parse(saved.endsAt) - Date.parse(saved.startsAt)).toBe(23 * 3_600_000)
  })
  it('CB371-D02 nonexistent non-Moscow wall time refuses the public proposal without rows', async () => {
    const c = await h.cohort(1, '2027-03-28'), id = await source(c), e = await h.capture(c.company, id)
    const gap = span({ localStartsAt: '2027-03-28T02:30:00', localEndsAt: '2027-03-28T04:30:00', startsAt: '2027-03-28T02:30:00+01:00', endsAt: '2027-03-28T04:30:00+02:00' })
    const before = await h.graph(c.company)
    denied(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/proposals', h.declaration(e, [gap])), 422)
    expect(await h.graph(c.company)).toEqual(before)
  })
  it.each(['capacity', 'equipment', 'person'] as const)('CB371-O01 company finite spans block overlapping %s without counter debit', async (kind: ResourceKind) => {
    const c = await h.cohort(), ready = await h.ready(c.company, kind, '2027-07-01T08:30:00Z', '2027-07-01T09:30:00Z')
    const counters = await h.counters(c.company); await h.settleAll(c.company)
    const before = await h.graph(c.company)
    denied(await h.commit(ready), 409, 'resource_booking_conflict')
    expect(await h.counters(c.company)).toEqual(counters); expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-O02 exactly touching half-open end allows a new commitment', async () => {
    const c = await h.cohort(), ready = await h.ready(c.company, 'equipment', '2027-07-01T10:00:00Z', '2027-07-01T11:00:00Z')
    await h.settleAll(c.company)
    expect((await h.commit(ready)).statusCode).toBe(200)
  })
  it('CB371-I01 the same actual account in another company is blocked by a legacy person barrier', async () => {
    const c = await h.cohort(), other = await h.company()
    const ready = await h.ready(other, 'person', '2027-07-01T08:30:00Z', '2027-07-01T09:30:00Z', c.company.owner)
    await h.settleAll(c.company)
    denied(await h.commit(ready), 409, 'resource_booking_conflict')
  })
  it('CB371-L01 accepted manual certificate and cross-company person barrier survive live vendor parent removal', async () => {
    const company = await h.company(), other = await h.company()
    const ready = await h.ready(other, 'person', '2027-07-01T08:30:00Z', '2027-07-01T09:30:00Z', company.owner)
    const id = await h.manual(company); await h.propose(company, id); await h.activate(company, id)
    const stable = async () => (await h.db.query<{ raw: string }>(`select (to_jsonb(c)-'live_source_id'-'live_vendor_id'-'live_bounds_version_id'-'live_activation_event_id')::text raw
      from resource_occupancy_origin_certificates c where vendor_identity=$1 order by id`, [company.id])).rows
    const before = await stable(), occupancy = await h.raw('resource_occupancy', 'vendor_identity=$1', [company.id])
    expect(before.length).toBeGreaterThan(0)
    await h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { vendorIds: [company.id], personIds: [company.owner.id], extraAccountIds: [company.owner.id], mode: 'erase' })
      await client.query('delete from vendors where id=$1', [company.id])
    })
    expect(await stable()).toEqual(before); expect(await h.raw('resource_occupancy', 'vendor_identity=$1', [company.id])).toEqual(occupancy)
    denied(await h.commit(ready), 409, 'resource_booking_conflict')
  })
  it('CB371-T01 callback-complete activation followed by genuine SQL22012 rolls back every effect', async () => {
    const c = await h.cohort(), { id } = await proposed(c); await h.agree(c.company, id)
    const e = await h.editor(c.company, id), before = await h.graph(c.company), money = await h.finance(); let completed = false
    await expect(h.db.tx(async client => {
      await activateLegacyCalendarBounds(client, { vendorId: c.company.id, sourceId: id, actor: h.actorInput(c.company.owner), ...h.activation(e) })
      completed = true; await client.query('select 1/0')
    })).rejects.toMatchObject({ code: '22012' })
    expect(completed).toBe(true); expect(await h.graph(c.company)).toEqual(before); expect(await h.finance()).toEqual(money)
    expect((await h.activate(c.company, id)).source.state).toBe('finite')
  })
  it('CB371-T02 native orphan next-version graph fails at actual outer COMMIT and leaves old proposal literal', async () => {
    const c = await h.cohort(), { id, view } = await proposed(c), before = await h.graph(c.company); let callbackComplete = false
    await expect(h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { sourceIds: [id], vendorIds: [c.company.id], weddingIds: [c.wedding], actor: h.actorInput(c.company.owner) })
      await client.query(`insert into legacy_calendar_bounds_versions(id,source_id,inventory_version_id,version,previous_version_id,wedding_id,company_id,
        source_revision,inventory_revision,inventory_digest,source_fingerprint,declaration,canonical,digest,staffing_completeness,association_fingerprint,
        created_by,created_session_id,policy_version)
        select $1,source_id,inventory_version_id,version+1,id,wedding_id,company_id,source_revision,inventory_revision,inventory_digest,
        source_fingerprint,declaration,canonical,digest,staffing_completeness,association_fingerprint,created_by,created_session_id,policy_version
        from legacy_calendar_bounds_versions where id=$2`, [randomUUID(), view.proposal!.id])
      callbackComplete = true
    })).rejects.toMatchObject({ code: '23514' })
    expect(callbackComplete).toBe(true); expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-T03 raw certificate or release fabrication is rejected and preserves genuine accepted origins', async () => {
    const c = await h.cohort(); await h.settleAll(c.company)
    const before = await h.graph(c.company)
    await expect(h.db.tx(client => client.query("update resource_occupancy set released_at=clock_timestamp(),release_reason='source_unavailable' where vendor_identity=$1", [c.company.id]))).rejects.toMatchObject({ code: '23514' })
    expect(await h.graph(c.company)).toEqual(before)
    await expect(h.db.tx(client => client.query("update resource_occupancy_origin_certificates set digest=repeat('0',64) where vendor_identity=$1", [c.company.id]))).rejects.toMatchObject({ code: '23514' })
    expect(await h.graph(c.company)).toEqual(before)
  })
  it('CB371-T04 actual commitment mirror cannot be independently altered', async () => {
    const company = await h.company(), ready = await h.ready(company)
    ok(await h.commit(ready), 'actual commitment creates mirror')
    const before = await h.graph(company)
    const mirror = (await h.db.query<{ id: string }>("select id::text from resource_occupancy where vendor_identity=$1 and origin_kind='commitment'", [company.id])).rows
    expect(mirror).toHaveLength(1)
    await expect(h.db.tx(client => client.query('update resource_occupancy set quantity=quantity+1 where id=$1', [mirror[0]!.id]))).rejects.toMatchObject({ code: '23514' })
    expect(await h.graph(company)).toEqual(before)
  })
  it('CB371-T05 a genuine public receipt is immutable under direct SQL tampering', async () => {
    const c = await h.cohort(), { id } = await proposed(c)
    await h.accept(c.pair, c.wedding, c.deals[0]!, id)
    const before = await h.graph(c.company)
    await expect(h.db.tx(client => client.query("update legacy_calendar_bounds_receipts set digest=repeat('0',64) where source_id=$1", [id]))).rejects.toMatchObject({ code: '23514' })
    expect(await h.graph(c.company)).toEqual(before); await noEffect(c)
  })
  it('CB371-P01 public occupancy is unknown before proof and leaks no private IDs after proof', async () => {
    const c = await h.cohort(), outsider = await h.actor()
    const url = `/catalog/vendors/${c.company.id}/occupancy?from=2027-07-01T00:00:00Z&to=2027-07-02T00:00:00Z`
    expect(ok<{ state: string }>(await h.call(outsider, 'GET', url), 'safe aggregate before proof').state).toBe('unknown')
    const sourceIds = await h.settleAll(c.company), response = await h.call(outsider, 'GET', url)
    const view = ok<{ state: string; occupiedPeriods: unknown[] }>(response, 'safe aggregate after proof')
    expect(view.state).toBe('busy'); expect(view.occupiedPeriods.length).toBeGreaterThan(0)
    for (const id of [...sourceIds, ...c.deals, c.wedding, c.pair.id, c.company.owner.id]) expect(response.body).not.toContain(id)
    const future = ok<{ state: string }>(await h.call(outsider, 'GET', `/catalog/vendors/${c.company.id}/occupancy?from=2027-08-10T00:00:00Z&to=2027-08-11T00:00:00Z`), 'none is not a capacity promise')
    expect(future.state).toBe('none')
  })
  it('CB371-P02 current customer projection contains only its holder and no person directory', async () => {
    const c = await h.cohort(), { id } = await proposed(c), read = await h.read(c.pair, c.wedding, c.deals[0]!, id)
    expect(read.editor).toBeNull(); expect(read.proposal!.holders).toBeNull(); expect(read.proposal!.ownHolder!.dealId).toBe(c.deals[0])
    expect(read.proposal!.staffing.personIds).toBeNull(); expect(read.receipts).toHaveLength(0)
    expect(JSON.stringify({ ...read, readToken: null })).not.toContain(c.deals[1]!)
  })
})
