import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from 'pg'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Calendar371Fixture, SECRET, denied, ok, span, type Cohort, type Reply } from './calendarBounds371.fixtures.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import { ACCESS_TTL_SECONDS, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js'
import { AppError } from '../src/errors.js'
import type { Queryable } from '../src/plugins/db.js'

// FULL372 frozen c372-adoption-contract.md: same financial root adoption of an
// accepted legacy holder into a native resource commitment. No fabricated
// receipts; every positive goes through the genuine publish/read/accept flow.
// Requires Root's separately registered fresh schema95 cluster (port 15432).
describe.sequential('FULL372 same-root legacy adoption', { timeout: 240_000 }, () => {
  const h = new Calendar371Fixture()
  beforeAll(() => h.open())
  afterAll(() => h.close())

  async function adoptionFrame(c: Cohort) {
    const frame = await h.graph(c.company)
    for (const table of ['deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members',
      'resource_allocations', 'legacy_calendar_adoption_proofs']) frame[table] = await h.raw(table, 'deal_id=any($1::uuid[])', [c.deals])
    frame.audit_log = await h.raw('audit_log', 'entity_id=any($1::uuid[])', [[...c.deals, c.company.id]])
    frame.idempotency_keys = await h.raw('idempotency_keys', 'user_id=any($1::uuid[])', [[c.pair.id, c.company.owner.id]])
    return frame
  }
  async function nativeWait(setup: (client: Client) => Promise<void>, invoke: () => Promise<Reply>,
    during: (client: Client) => Promise<void>): Promise<Reply> {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL!, application_name: 'c372_owned_control',
      connectionTimeoutMillis: 5000, statement_timeout: 12000, idle_in_transaction_session_timeout: 20000 })
    let pending: Promise<{ reply: Reply } | { error: unknown }> | undefined, finished = false
    try {
      await client.connect(); await client.query('begin'); await setup(client)
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      pending = invoke().then(reply => { finished = true; return { reply } }, error => { finished = true; return { error } })
      type Wait = { pid: number; backend_start: string; query: string; blockers: number[] }
      let observed: Wait | undefined
      const deadline = performance.now() + 8000
      while (!finished && performance.now() < deadline) {
        observed = (await h.db.query<Wait>(`select pid,backend_start::text,query,pg_blocking_pids(pid) blockers from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [pid])).rows[0]
        if (observed) break
        await pause(10)
      }
      assert(observed, 'SETUP_372: a real native wait must precede the tested expiry/authority change')
      process.stdout.write(`ADOPTION372_NATIVE_WAIT ${JSON.stringify({ owner: 'root/c372', controlPID: pid, ...observed })}\n`)
      await during(client)
      const still = (await h.db.query<Wait>(`select pid,backend_start::text,query,pg_blocking_pids(pid) blockers from pg_stat_activity
        where pid=$1 and wait_event_type='Lock' and $2=any(pg_blocking_pids(pid))`, [observed.pid, pid])).rows[0]
      expect(still).toEqual(observed)
      await client.query('commit')
      const outcome = await pending
      if ('error' in outcome) throw outcome.error
      return outcome.reply
    } finally {
      await client.query('rollback').catch(() => undefined)
      await client.end()
      if (pending) await pending
    }
  }

  async function daySource(c: Cohort): Promise<string> {
    const row = (await h.liveSources(c.company)).find(s => s.kind === 'app_day')
    assert(row, 'SETUP_372: actual app_day source required; absence is not domain RED')
    return row.id
  }
  interface Activated { sourceId: string; policyRevision: string; resourceId: string; window: string | null }
  // Resources and the resources policy first; plans second; the legacy settle
  // (capture/propose/agree/activate) LAST — it must observe the final order
  // versions, or the activated bounds go stale the moment a plan lands.
  async function activated(c: Cohort): Promise<Activated> {
    const sourceId = await daySource(c)
    const policy = ok<{ revision: string }>(await h.call(c.company.owner, 'GET', `/vendors/${c.company.id}/availability-policy`), 'current policy')
    const resource = ok<{ id: string }>(await h.call(c.company.owner, 'POST', `/vendors/${c.company.id}/resources`,
      { kind: 'capacity', label: 'Adoption actual resource', capacityUnit: 'pieces' }), 'actual adoptable resource')
    const window = ok<{ id: string }>(await h.call(c.company.owner, 'POST', `/vendors/${c.company.id}/resources/${resource.id}/windows`,
      { startsAt: '2027-01-01T00:00:00Z', endsAt: '2027-12-31T23:00:00Z', capacity: 10 }), 'actual capacity window')
    const selected = ok<{ revision: string }>(await h.call(c.company.owner, 'PATCH', `/vendors/${c.company.id}/availability-policy`,
      { mode: 'resources', expectedRevision: policy.revision }), 'resources mode for adoption')
    return { sourceId, policyRevision: selected.revision, resourceId: resource.id, window: window.id }
  }
  interface Planned { deal: string; orderVersion: string; planRevisionId: string }
  async function planFor(c: Cohort, act: Activated, dealIndex = 0,
    opts: { startsAt?: string; endsAt?: string; quantity?: number } = {}): Promise<Planned> {
    const deal = c.deals[dealIndex]!
    const startsAt = opts.startsAt ?? '2027-08-10T10:00:00Z', endsAt = opts.endsAt ?? '2027-08-10T11:00:00Z'
    const order = ok<{ version: string }>(await h.call(c.company.owner, 'GET', `/deals/${deal}/order`), 'current order')
    const withPart = ok<{ version: string; parts: { id: string }[] }>(await h.call(c.company.owner, 'POST', `/deals/${deal}/order/parts`,
      { expectedVersion: order.version, kind: 'deliverable', assignmentId: null, title: 'Adoption actual output',
        details: { dueAt: endsAt } }), 'adoption order part')
    const plan = ok<{ orderVersion: string; current: { planRevisionId: string } }>(await h.call(c.company.owner, 'PATCH', `/deals/${deal}/order/resource-plan`,
      { expectedVersion: withPart.version, expectedPlanRevision: '0', lines: [{ partId: withPart.parts.at(-1)!.id, resourceId: act.resourceId,
        capacityWindowId: act.window, quantity: opts.quantity ?? 3, startsAt, endsAt, timeZone: 'UTC',
        setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0 }] }), 'adoption resource plan')
    return { deal, orderVersion: plan.orderVersion, planRevisionId: plan.current.planRevisionId }
  }
  // Declaration spans must cover both the wedding-day barrier and every plan
  // window (legacy_calendar_bounds_engagement_covered checks plan lines too).
  function spansFor(specs: PrepareSpec[]) {
    const spans = [span()]
    let extra = false
    for (const spec of specs) {
      const s = Date.parse(spec.startsAt ?? '2027-08-10T10:00:00Z'), e = Date.parse(spec.endsAt ?? '2027-08-10T11:00:00Z')
      if (s >= Date.parse('2027-07-01T08:00:00Z') && e <= Date.parse('2027-07-01T10:00:00Z')) continue
      if (extra) continue
      extra = true
      spans.push(span({ timeZone: 'UTC', localStartsAt: '2027-08-10T09:00:00', localEndsAt: '2027-08-10T12:00:00',
        startsAt: '2027-08-10T09:00:00Z', endsAt: '2027-08-10T12:00:00Z' }))
    }
    return spans
  }
  // Per-holder spans: the plan-covering span belongs only to the planned holder, so a
  // retained sibling barrier never overlaps the adopted plan window.
  async function settleSplit(c: Cohort, act: Activated, extraByDeal: Map<string, ReturnType<typeof span>[]>): Promise<void> {
    const sources = await h.liveSources(c.company); assert(sources.length, 'SETUP_372: real legacy source required')
    for (const s of sources) {
      const e = await h.capture(c.company, s.id)
      const body = h.declaration(e, [span()])
      for (const holder of body.holders) {
        const extra = extraByDeal.get(holder.dealId)
        if (extra) holder.spans = [...holder.spans, ...extra]
      }
      ok(await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, s.id) + '/proposals', body), 'registered split bounds proposal')
      await h.agree(c.company, s.id); await h.activate(c.company, s.id)
    }
  }
  // Multi-holder setup: every planned deal gets its own day-local covering span, so a
  // sibling barrier never overlaps another holder's plan window.
  async function preparedSplit(c: Cohort, specs: (PrepareSpec & { dealIndex: number })[]): Promise<{ act: Activated; list: Prepared[] }> {
    const act = await activated(c)
    const plans: Planned[] = []
    for (const spec of specs) plans.push(await planFor(c, act, spec.dealIndex, spec))
    const extra = new Map<string, ReturnType<typeof span>[]>()
    for (const spec of specs) {
      const s = spec.startsAt ?? '2027-08-10T10:00:00Z', e = spec.endsAt ?? '2027-08-10T11:00:00Z'
      if (Date.parse(s) >= Date.parse('2027-07-01T08:00:00Z') && Date.parse(e) <= Date.parse('2027-07-01T10:00:00Z')) continue
      const day = s.slice(0, 10)
      extra.set(c.deals[spec.dealIndex]!, [span({ timeZone: 'UTC',
        localStartsAt: `${day}T09:00:00`, localEndsAt: `${day}T12:00:00`,
        startsAt: `${day}T09:00:00Z`, endsAt: `${day}T12:00:00Z` })])
    }
    await settleSplit(c, act, extra)
    const list: Prepared[] = []
    for (const p of plans) list.push(await publishFor(c, act, p))
    return { act, list }
  }
  async function settle(c: Cohort, act: Activated, mode: 'all' | 'day', spans = [span()]): Promise<void> {
    if (mode === 'all') await h.settleAll(c.company, spans)
    else { await h.propose(c.company, act.sourceId, spans); await h.agree(c.company, act.sourceId); await h.activate(c.company, act.sourceId) }
  }
  interface Pins { sourceId: string; sourceVersionId: string; expectedSourceFingerprint: string
    expectedSourceHeadRevision: string; effectiveBoundsVersionId: string }
  async function pinsOf(c: Cohort, sourceId: string): Promise<Pins> {
    const e = await h.editor(c.company, sourceId)
    assert(e.editor && e.source.effectiveVersionId, 'SETUP_372: activated effective bounds required')
    return { sourceId, sourceVersionId: e.editor.inventoryVersionId!, expectedSourceFingerprint: e.editor.sourceFingerprint,
      expectedSourceHeadRevision: e.source.headRevision, effectiveBoundsVersionId: e.source.effectiveVersionId }
  }
  interface Prepared { deal: string; pins: Pins; orderVersion: string; planRevisionId: string
    termsId: string; termsVersion: string; termsDigest: string; transition: Record<string, unknown> | null }
  async function publishFor(c: Cohort, act: Activated, p: Planned, opts: { schema3?: boolean } = {}): Promise<Prepared> {
    const pins = await pinsOf(c, act.sourceId)
    const prior = ok<{ revision: string }>(await h.call(c.pair, 'GET', `/deals/${p.deal}/order/terms`), 'terms revision')
    const published = ok<{ selected: { id: string; version: string; digest: string; snapshot: Record<string, unknown> } }>(
      await h.call(c.pair, 'POST', `/deals/${p.deal}/order/terms/proposals`,
        { expectedOrderVersion: p.orderVersion, expectedTermsRevision: prior.revision,
          ...(opts.schema3 === false ? {} : { adoption: pins }) }), 'adoption schema3 publish')
    const schema3 = opts.schema3 !== false
    const transition = (published.selected.snapshot.legacyTransition ?? null) as Record<string, unknown> | null
    if (schema3) {
      assert.equal(published.selected.snapshot.schemaVersion, 3, 'SETUP_372: server-built schema3 required')
      assert.equal(transition?.purpose, 'adopt-legacy-calendar')
      assert.equal(transition?.disposition, 'replace_this_holder_company_barrier_with_this_resource_plan')
    } else {
      assert.equal(published.selected.snapshot.schemaVersion, 2, 'SETUP_372: plain schema2 control required')
    }
    type Terms = { selected: { id: string; version: string; digest: string }; readToken: string; agreedTermsId: string | null }
    let terms: Terms | undefined
    for (const a of [c.pair, c.company.owner]) {
      terms = ok<Terms>(await h.call(a, 'GET', `/deals/${p.deal}/order/terms`), 'adoption terms read')
      if (schema3) {
        assert.equal(decodeProtectedHeader(terms.readToken).typ, 'order-legacy-adoption-read', 'SETUP_372: adoption JWT typ required')
        const claims = decodeJwt(terms.readToken)
        assert.equal(claims.aud, 'order-legacy-adoption-read'); assert.equal(claims.purpose, 'order-legacy-adoption-read')
        assert.equal(claims.sourceId, pins.sourceId); assert.equal(claims.boundsVersionId, pins.effectiveBoundsVersionId)
      }
      ok(await h.call(a, 'POST', `/deals/${p.deal}/order/terms/${terms.selected.id}/accept`,
        { expectedTermsVersion: terms.selected.version, digest: terms.selected.digest, readToken: terms.readToken }), 'genuine schema3 acceptance')
    }
    assert(terms)
    const agreed = ok<{ agreedTermsId: string | null }>(await h.call(c.pair, 'GET', `/deals/${p.deal}/order/terms`), 'agreed head')
    assert.equal(agreed.agreedTermsId, terms.selected.id, 'SETUP_372: two-party agreed head required')
    return { deal: p.deal, pins, orderVersion: p.orderVersion, planRevisionId: p.planRevisionId,
      termsId: terms.selected.id, termsVersion: terms.selected.version, termsDigest: terms.selected.digest, transition }
  }
  type PrepareSpec = { dealIndex?: number; startsAt?: string; endsAt?: string; quantity?: number; schema3?: boolean }
  async function prepared(c: Cohort, mode: 'all' | 'day', specs: PrepareSpec[]): Promise<{ act: Activated; list: Prepared[] }> {
    const act = await activated(c)
    const plans: { p: Planned; spec: PrepareSpec }[] = []
    for (const spec of specs) plans.push({ p: await planFor(c, act, spec.dealIndex ?? 0, spec), spec })
    await settle(c, act, mode, spansFor(specs))
    const list: Prepared[] = []
    for (const { p, spec } of plans) list.push(await publishFor(c, act, p, spec))
    return { act, list }
  }
  function adoptBody(act: Activated, t: Prepared, extra: Record<string, unknown> = {}) {
    return { expectedOrderVersion: t.orderVersion, expectedCommitmentRevision: '0', termsId: t.termsId,
      expectedTermsVersion: t.termsVersion, termsDigest: t.termsDigest, planRevisionId: t.planRevisionId,
      expectedPolicyRevision: act.policyRevision, ...t.pins, ...extra }
  }
  const adopt = (c: Cohort, act: Activated, t: Prepared, extra: Record<string, unknown> = {}, key?: string) =>
    h.call(c.pair, 'POST', `/deals/${t.deal}/order/resource-adoption`, adoptBody(act, t, extra), key)
  function groupHolder(c: Cohort, act: Activated, t: Prepared, extra: Record<string, unknown> = {}) {
    return { weddingId: c.wedding, dealId: t.deal, ...Object.fromEntries(Object.entries(adoptBody(act, t, extra))
      .filter(([key]) => key !== 'sourceId' && key !== 'expectedSourceHeadRevision')) }
  }
  function replacementBody(act: Activated, t: Prepared, revision: string) {
    return { expectedOrderVersion: t.orderVersion, expectedCommitmentRevision: revision, termsId: t.termsId,
      expectedTermsVersion: t.termsVersion, termsDigest: t.termsDigest,
      planRevisionId: t.planRevisionId, expectedPolicyRevision: act.policyRevision }
  }
  interface Commitment { revision: string; state: string; termsId: string | null; planRevisionId: string | null; reservation: string }
  async function proofs(deal: string) {
    return h.db.query<{ id: string; commitment_version_id: string }>(
      'select id::text,commitment_version_id::text from legacy_calendar_adoption_proofs where deal_id=$1', [deal]).then(r => r.rows)
  }
  async function assertAdopted(c: Cohort, act: Activated, t: Prepared, view: Commitment): Promise<void> {
    expect(view.reservation).toBe('reserved'); expect(view.revision).toBe('1')
    expect(view.termsId).toBe(t.termsId); expect(view.planRevisionId).toBe(t.planRevisionId)
    const head = (await h.db.query<{ revision: string; state: string }>(
      'select revision::text,state from deal_resource_commitments where deal_id=$1', [t.deal])).rows[0]!
    expect(head).toEqual({ revision: '1', state: 'reserved' })
    const version = (await h.db.query<{ action: string; proof: string | null }>(
      'select action,legacy_adoption_proof_id::text proof from deal_resource_commitment_versions where deal_id=$1', [t.deal])).rows[0]!
    expect(version.action).toBe('adopt'); expect(version.proof).not.toBeNull()
    const proof = await proofs(t.deal)
    expect(proof).toHaveLength(1); expect(proof[0]!.id).toBe(version.proof)
    const events = (await h.db.query<{ id: string }>(
      "select id::text from legacy_calendar_resolution_events where source_id=$1 and action='adopted'", [act.sourceId])).rows
    expect(events.length).toBeGreaterThanOrEqual(1)
    const released = (await h.db.query<{ n: number }>(
      "select count(*)::int n from resource_occupancy where release_reason='adopted' and release_event_id=any($1::uuid[])",
      [events.map(e => e.id)])).rows[0]!.n
    expect(released).toBeGreaterThanOrEqual(1)
    const allocations = (await h.db.query<{ n: number }>(
      'select count(*)::int n from resource_allocations where deal_id=$1 and released_at is null', [t.deal])).rows[0]!.n
    expect(allocations).toBe(1)
    const deal = (await h.db.query<{ state: string }>('select state from deals where id=$1', [t.deal])).rows[0]!
    expect(['booked', 'paid_deposit']).toContain(deal.state)
  }
  async function financialMirror(c: Cohort) {
    const result: Record<string, string[]> = {}
    result.deals = await h.raw('deals', 'wedding_id=$1', [c.wedding])
    result.payments = await h.raw('payments', 'deal_id=any($1::uuid[])', [c.deals])
    result.installments = await h.raw('payment_installments', 'deal_id=any($1::uuid[])', [c.deals])
    result.events = await h.raw('deal_events', 'deal_id=any($1::uuid[])', [c.deals])
    result.days = await h.raw('vendor_busy_dates', 'vendor_id=$1', [c.company.id])
    return result
  }

  it('RA372-P01 booked root adopts its own accepted holder; finance/DATE stay byte-exact', async () => {
    const c = await h.cohort(1), money = await financialMirror(c)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    const reply = await adopt(c, act, t)
    expect(reply.statusCode).toBe(200)
    await assertAdopted(c, act, t, reply.json<Commitment>())
    expect(await financialMirror(c)).toEqual(money)
  })
  it('RA372-P02 paid_deposit root adopts the same way', async () => {
    const c = await h.cohort(1)
    ok(await h.call(c.pair, 'PATCH', `/deals/${c.deals[0]}`, { state: 'paid_deposit' }), 'genuine deposit transition')
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    const reply = await adopt(c, act, t)
    expect(reply.statusCode).toBe(200)
    await assertAdopted(c, act, t, reply.json<Commitment>())
    expect((await h.db.query<{ state: string }>('select state from deals where id=$1', [t.deal])).rows[0]!.state).toBe('paid_deposit')
  })
  it('RA372-P03 idempotent replay returns the current projection without a second operation', async () => {
    const c = await h.cohort(1), key = randomUUID()
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    const first = await adopt(c, act, t, {}, key)
    expect(first.statusCode).toBe(200)
    const replay = await adopt(c, act, t, {}, key)
    expect(replay.statusCode).toBe(200)
    expect(replay.json<Commitment>()).toEqual(first.json<Commitment>())
    expect(await proofs(t.deal)).toHaveLength(1)
  })
  it('RA372-P04 retained holders keep protecting their spans after a sibling adoption', async () => {
    const c = await h.cohort(2)
    const { act, list } = await preparedSplit(c, [{ dealIndex: 0 }]); const t = list[0]!
    const reply = await adopt(c, act, t)
    expect(reply.statusCode).toBe(200)
    await assertAdopted(c, act, t, reply.json<Commitment>())
    const certificate = (await h.db.query<{ id: string }>(
      'select id::text from resource_occupancy_origin_certificates where source_identity=$1 and bounds_version_identity=$2',
      [act.sourceId, t.pins.effectiveBoundsVersionId])).rows[0]!
    const retained = (await h.db.query<{ n: number }>(`
      select count(*)::int n from resource_occupancy o join resource_occupancy_origin_certificates c on c.id=o.certificate_id
      where o.certificate_id=$1 and o.released_at is null
        and exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'lines') line
          join jsonb_array_elements(c.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          where (line.value->>'lineIndex')::int=o.origin_line_index
            and (r.value->>'weddingId')::uuid=$2 and (r.value->>'dealId')::uuid=$3)`,
    [certificate.id, c.wedding, c.deals[1]!])).rows[0]!.n
    expect(retained).toBeGreaterThanOrEqual(1)
    // The untouched sibling root stays plain legacy: no proof, no commitment.
    expect(await proofs(c.deals[1]!)).toHaveLength(0)
  })
  it('RA372-P05 owner adopts the full holder group atomically', async () => {
    const c = await h.cohort(2)
    const { act, list } = await preparedSplit(c, [{ dealIndex: 0, startsAt: '2027-08-10T10:00:00Z', endsAt: '2027-08-10T11:00:00Z' },
      { dealIndex: 1, startsAt: '2027-08-11T10:00:00Z', endsAt: '2027-08-11T11:00:00Z' }])
    const [first, second] = [list[0]!, list[1]!]
    const holder = (t: Prepared) => groupHolder(c, act, t)
    const body = { expectedSourceHeadRevision: first.pins.expectedSourceHeadRevision, holders: [holder(first), holder(second)] }
    const reply = await h.call(c.company.owner, 'POST', `/vendors/${c.company.id}/legacy-calendar/sources/${act.sourceId}/adopt`, body)
    expect(reply.statusCode).toBe(200)
    const view = reply.json<{ sourceId: string; adopted: { dealId: string; commitment: Commitment }[] }>()
    expect(view.sourceId).toBe(act.sourceId); expect(view.adopted).toHaveLength(2)
    for (const t of [first, second]) {
      const adopted = view.adopted.find(a => a.dealId === t.deal)!
      expect(adopted.commitment.reservation).toBe('reserved')
      await assertAdopted(c, act, t, adopted.commitment)
    }
  })
  it('RA372-P06 invalid second proof refuses the whole group before publication', async () => {
    const c = await h.cohort(2)
    const { act, list } = await preparedSplit(c, [{ dealIndex: 0, startsAt: '2027-08-10T10:00:00Z', endsAt: '2027-08-10T11:00:00Z' },
      { dealIndex: 1, startsAt: '2027-08-11T10:00:00Z', endsAt: '2027-08-11T11:00:00Z' }])
    const [first, second] = [list[0]!, list[1]!]
    const before = await h.graph(c.company), money = await financialMirror(c)
    const holder = (t: Prepared, extra: Record<string, unknown> = {}) => groupHolder(c, act, t, extra)
    const reply = await h.call(c.company.owner, 'POST', `/vendors/${c.company.id}/legacy-calendar/sources/${act.sourceId}/adopt`,
      { expectedSourceHeadRevision: first.pins.expectedSourceHeadRevision,
        holders: [holder(first), holder(second, { termsDigest: '0'.repeat(64) })] })
    expect(reply.statusCode).toBe(422)
    expect(await proofs(c.deals[0]!)).toHaveLength(0); expect(await proofs(c.deals[1]!)).toHaveLength(0)
    expect((await h.db.query<{ n: number }>(
      "select count(*)::int n from legacy_calendar_resolution_events where source_id=$1 and action='adopted'", [act.sourceId])).rows[0]!.n).toBe(0)
    expect((await h.db.query<{ n: number }>('select count(*)::int n from resource_allocations where deal_id=any($1::uuid[])', [c.deals])).rows[0]!.n).toBe(0)
    expect(await h.graph(c.company)).toEqual(before); expect(await financialMirror(c)).toEqual(money)
  })
  it('RA372-N01 schema2 agreed terms are not an adoption proof', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{ schema3: false }]); const t = list[0]!
    const before = await h.graph(c.company)
    denied(await adopt(c, act, t), 409, 'resource_terms_source_changed')
    expect(await proofs(t.deal)).toHaveLength(0); expect(await h.graph(c.company)).toEqual(before)
  })
  it('RA372-N02 an old order-terms-read token cannot accept the adoption edition', async () => {
    const c = await h.cohort(1), act = await activated(c)
    // Genuine plain round first: its read token has the old purpose/namespace.
    const deal = c.deals[0]!
    const order = ok<{ version: string }>(await h.call(c.company.owner, 'GET', `/deals/${deal}/order`), 'current order')
    const prior = ok<{ revision: string }>(await h.call(c.pair, 'GET', `/deals/${deal}/order/terms`), 'terms revision')
    ok(await h.call(c.pair, 'POST', `/deals/${deal}/order/terms/proposals`,
      { expectedOrderVersion: order.version, expectedTermsRevision: prior.revision }), 'plain publish')
    const plain = ok<{ selected: { version: string; digest: string }; readToken: string }>(
      await h.call(c.pair, 'GET', `/deals/${deal}/order/terms`), 'plain read token')
    assert.equal(decodeProtectedHeader(plain.readToken).typ, 'order-terms-read')
    // Now the server-built schema3 edition supersedes it.
    const p = await planFor(c, act, 0)
    await settle(c, act, 'all', spansFor([{}]))
    const t = await publishFor(c, act, p)
    denied(await h.call(c.pair, 'POST', `/deals/${deal}/order/terms/${t.termsId}/accept`,
      { expectedTermsVersion: t.termsVersion, digest: t.termsDigest, readToken: plain.readToken }), 422)
  })
  it('RA372-N03 wrong source pin refuses before any write', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    const before = await h.graph(c.company)
    denied(await adopt(c, act, t, { sourceId: randomUUID() }), 409, 'legacy_calendar_bounds_changed')
    expect(await proofs(t.deal)).toHaveLength(0); expect(await h.graph(c.company)).toEqual(before)
  })
  it('RA372-N04 stale source head revision refuses', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    denied(await adopt(c, act, t, { expectedSourceHeadRevision: (BigInt(t.pins.expectedSourceHeadRevision) + 1n).toString() }),
      409, 'legacy_calendar_bounds_changed')
    expect(await proofs(t.deal)).toHaveLength(0)
  })
  it('RA372-N05 a root whose slot moved away cannot adopt', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    await h.db.tx(async client => {
      await client.query("set local session_replication_role='replica'")
      await client.query('update slots set deal_id=null where wedding_id=$1 and deal_id=$2', [c.wedding, t.deal])
    })
    denied(await adopt(c, act, t), 409, 'resource_slot_changed')
    expect(await proofs(t.deal)).toHaveLength(0)
  })
  it('RA372-N06 a finished root cannot adopt', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    await h.db.tx(async client => {
      await client.query("set local session_replication_role='replica'")
      await client.query("update deals set state='done' where id=$1", [t.deal])
    })
    denied(await adopt(c, act, t), 409, 'legacy_adoption_state')
    expect(await proofs(t.deal)).toHaveLength(0)
  })
  it('RA372-N07 capacity exhaustion stays a truthful refusal', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{ quantity: 11 }]); const t = list[0]!
    denied(await adopt(c, act, t), 409, 'resource_capacity_exhausted')
    expect(await proofs(t.deal)).toHaveLength(0)
    expect((await h.db.query<{ used: string }>('select used::text from resource_capacity_windows where id=$1', [act.window])).rows[0]!.used).toBe('0')
  })
  it('RA372-N08 a retained sibling barrier refuses an overlapping plan', async () => {
    const c = await h.cohort(2)
    const { act, list } = await prepared(c, 'all', [{ startsAt: '2027-07-01T08:30:00Z', endsAt: '2027-07-01T09:30:00Z' }])
    const t = list[0]!
    const before = await h.graph(c.company)
    denied(await adopt(c, act, t), 409)
    expect(await proofs(t.deal)).toHaveLength(0); expect(await h.graph(c.company)).toEqual(before)
  })
  it('RA372-N09 any other unresolved source of the company refuses narrowing', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'day', [{}]); const t = list[0]!
    denied(await adopt(c, act, t), 409, 'unresolved_legacy_obligations')
    expect(await proofs(t.deal)).toHaveLength(0)
  })
  it('RA372-N10 direct SQL: an orphan adoption proof cannot COMMIT', async () => {
    const c = await h.cohort(1)
    const { list } = await prepared(c, 'all', [{}]); const t = list[0]!
    await expect(h.db.tx(async client => {
      await client.query(`insert into deal_resource_commitments(wedding_id,deal_id) values($1,$2) on conflict(deal_id) do nothing`, [c.wedding, t.deal])
      await client.query(`insert into legacy_calendar_adoption_proofs(id,source_id,source_version_id,wedding_id,deal_id,
        bounds_version_id,terms_id,plan_revision_id,commitment_version_id,source_fingerprint,bounds_digest)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), t.pins.sourceId, t.pins.sourceVersionId, c.wedding, t.deal, t.pins.effectiveBoundsVersionId,
        t.termsId, t.planRevisionId, randomUUID(), t.pins.expectedSourceFingerprint, t.transition!.effectiveBoundsDigest as string])
    })).rejects.toThrow(/Adoption proof must finish in an exact adopted resolution|violates foreign key constraint "legacy_calendar_adoption_proo/)
    expect(await proofs(t.deal)).toHaveLength(0)
  })
  it('RA372-N11 direct SQL: adopt version without its proof and proof immutability', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    await expect(h.db.tx(async client => {
      await client.query(`insert into deal_resource_commitments(wedding_id,deal_id) values($1,$2) on conflict(deal_id) do nothing`, [c.wedding, t.deal])
      await client.query(`insert into deal_resource_commitment_versions(id,wedding_id,deal_id,vendor_id,revision,previous_version_id,
        terms_id,plan_revision_id,policy_revision,action,state,reason,created_by)
        values($1,$2,$3,$4,1,null,$5,$6,$7,'adopt','reserved',null,$8)`,
      [randomUUID(), c.wedding, t.deal, c.company.id, t.termsId, t.planRevisionId, act.policyRevision, c.pair.id])
    })).rejects.toThrow()
    const reply = await adopt(c, act, t)
    expect(reply.statusCode).toBe(200)
    const proof = (await proofs(t.deal))[0]!
    await expect(h.db.tx(async client => {
      await client.query('update legacy_calendar_adoption_proofs set bounds_digest=$1 where id=$2', ['0'.repeat(64), proof.id])
    })).rejects.toThrow()
    await expect(h.db.tx(async client => {
      await client.query('delete from legacy_calendar_adoption_proofs where id=$1', [proof.id])
    })).rejects.toThrow()
  })
  it('RA372-N12 direct SQL: a forged transition edition is not adoption material', async () => {
    const c = await h.cohort(1)
    const { list } = await prepared(c, 'all', [{}]); const t = list[0]!
    const forged = randomUUID()
    await expect(h.db.tx(async client => {
      const source = (await client.query<{ canonical: string; snapshot: Record<string, unknown>; digest: string }>(
        'select canonical_payload canonical,snapshot,digest from deal_terms_versions where wedding_id=$1 and deal_id=$2 and id=$3',
        [c.wedding, t.deal, t.termsId])).rows[0]!
      const snapshot = { ...source.snapshot, legacyTransition: { ...t.transition!, disposition: 'adopted_to_resource_commitment' } }
      const { createHash } = await import('node:crypto')
      const { canonicalTermsJson } = await import('../src/orders/terms.js')
      const canonical = canonicalTermsJson(snapshot)
      const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
      const version = (BigInt(t.termsVersion) + 1n).toString()
      await client.query(`insert into deal_terms_versions(id,wedding_id,deal_id,version,source_order_version,source_fingerprint,
        canonical_payload,snapshot,digest,published_by,published_side,resource_plan_id)
        select $1,wedding_id,deal_id,$2::bigint,source_order_version,$3,$4,$5::jsonb,$3,published_by,published_side,resource_plan_id
        from deal_terms_versions where wedding_id=$6 and deal_id=$7 and id=$8`,
      [forged, version, digest, canonical, JSON.stringify(snapshot), c.wedding, t.deal, t.termsId])
      await client.query('update deal_orders set terms_revision=$3::bigint,proposed_terms_id=$4,agreed_terms_id=$4 where wedding_id=$1 and deal_id=$2',
        [c.wedding, t.deal, version, forged])
      await client.query(`insert into deal_resource_commitments(wedding_id,deal_id) values($1,$2) on conflict(deal_id) do nothing`, [c.wedding, t.deal])
      await client.query(`insert into legacy_calendar_adoption_proofs(id,source_id,source_version_id,wedding_id,deal_id,
        bounds_version_id,terms_id,plan_revision_id,commitment_version_id,source_fingerprint,bounds_digest)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), t.pins.sourceId, t.pins.sourceVersionId, c.wedding, t.deal, t.pins.effectiveBoundsVersionId,
        forged, t.planRevisionId, randomUUID(), t.pins.expectedSourceFingerprint, t.transition!.effectiveBoundsDigest as string])
    })).rejects.toThrow(/accepted schema3 transition|Adoption requires the exact/)
    expect(await proofs(t.deal)).toHaveLength(0)
  })
  it('RA372-F1 selected overlapping holders share sufficient capacity in one atomic group', async () => {
    const c = await h.cohort(2)
    const { act, list } = await preparedSplit(c, [{ dealIndex: 0, quantity: 3 }, { dealIndex: 1, quantity: 3 }])
    const money = await financialMirror(c)
    const holders = list.map(t => groupHolder(c, act, t))
    const reply = await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, act.sourceId) + '/adopt',
      { expectedSourceHeadRevision: list[0]!.pins.expectedSourceHeadRevision, holders })
    expect(reply.statusCode).toBe(200)
    const result = reply.json<{ adopted: { dealId: string; commitment: Commitment }[] }>()
    expect(result.adopted).toHaveLength(2)
    for (const t of list) await assertAdopted(c, act, t, result.adopted.find(row => row.dealId === t.deal)!.commitment)
    expect((await h.db.query<{ live: string; legacy_used: number }>(`select legacy_used,
      (select sum(quantity)::text from resource_allocations where capacity_window_id=$1 and released_at is null) live
      from resource_capacity_windows where id=$1`, [act.window])).rows).toEqual([{ live: '6', legacy_used: 0 }])
    expect(await financialMirror(c)).toEqual(money)
  })
  it('RA372-F1C aggregate capacity overflow rolls back every selected holder', async () => {
    const c = await h.cohort(2)
    const { act, list } = await preparedSplit(c, [{ dealIndex: 0, quantity: 6 }, { dealIndex: 1, quantity: 6 }])
    const frame = await adoptionFrame(c), money = await financialMirror(c)
    const reply = await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, act.sourceId) + '/adopt',
      { expectedSourceHeadRevision: list[0]!.pins.expectedSourceHeadRevision, holders: list.map(t => groupHolder(c, act, t)) })
    expect(reply.statusCode).toBe(409)
    expect(await adoptionFrame(c)).toEqual(frame)
    expect(await financialMirror(c)).toEqual(money)
  })
  it('RA372-F1L native late SQL fault rolls back a group after its first published holder', async () => {
    const c = await h.cohort(2)
    const { act, list } = await preparedSplit(c, [{ dealIndex: 0 }, { dealIndex: 1 }])
    const [first, second] = [...list].sort((a, b) => a.deal.localeCompare(b.deal))
    const probe = `c372_late_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    assert.match(probe, /^c372_late_[a-f0-9]{12}$/)
    // Sequence consumption survives rollback and proves that the native fault
    // followed the first published root; a generic HTTP500 alone cannot.
    await h.db.query(`create sequence ${probe}_seen`)
    await h.db.query(`create function ${probe}() returns trigger language plpgsql as $$ begin
      if NEW.deal_id='${second!.deal}'::uuid then
        if not exists(select 1 from deal_resource_commitments where deal_id='${first!.deal}'::uuid and revision=1 and state='reserved')
          or not exists(select 1 from resource_allocations where deal_id='${first!.deal}'::uuid and released_at is null) then
          raise exception 'group late-fault precondition missing' using errcode='22003';end if;
        perform nextval('${probe}_seen');
        raise exception 'c372 witnessed late group SQL fault' using errcode='22012';
      end if;return NEW;end $$`)
    await h.db.query(`create trigger ${probe} before insert on resource_allocations for each row execute function ${probe}()`)
    const frame = await adoptionFrame(c), money = await financialMirror(c)
    let reply: Awaited<ReturnType<typeof h.call>>
    try {
      reply = await h.call(c.company.owner, 'POST', h.ownerUrl(c.company, act.sourceId) + '/adopt',
        { expectedSourceHeadRevision: list[0]!.pins.expectedSourceHeadRevision, holders: list.map(t => groupHolder(c, act, t)) })
      expect((await h.db.query<{ last_value: string; is_called: boolean }>(`select last_value::text,is_called from ${probe}_seen`)).rows)
        .toEqual([{ last_value: '1', is_called: true }])
    } finally {
      await h.db.query(`drop trigger ${probe} on resource_allocations`)
      await h.db.query(`drop function ${probe}()`)
      await h.db.query(`drop sequence ${probe}_seen`)
    }
    expect(reply.statusCode).toBe(500)
    expect(await adoptionFrame(c)).toEqual(frame)
    expect(await financialMirror(c)).toEqual(money)
  })
  it('RA372-F2 replacement follows proven adoption ancestry without changing the legacy DATE', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    ok(await adopt(c, act, t), 'initial adoption before a separately agreed replacement')
    const money = await financialMirror(c), originalProof = await proofs(t.deal)
    const next = await publishFor(c, act, { deal: t.deal, orderVersion: t.orderVersion, planRevisionId: t.planRevisionId }, { schema3: false })
    const reply = await h.call(c.pair, 'POST', `/deals/${t.deal}/order/resource-commitments/replace`, {
      expectedOrderVersion: next.orderVersion, expectedCommitmentRevision: '1', termsId: next.termsId,
      expectedTermsVersion: next.termsVersion, termsDigest: next.termsDigest,
      planRevisionId: next.planRevisionId, expectedPolicyRevision: act.policyRevision,
    })
    expect(reply.statusCode).toBe(200)
    expect(reply.json<Commitment>()).toMatchObject({ revision: '2', reservation: 'reserved' })
    expect((await h.db.query<{ proven: boolean }>('select legacy_calendar_adopted_commitment($1) proven', [t.deal])).rows).toEqual([{ proven: true }])
    expect(await proofs(t.deal)).toEqual(originalProof)
    expect(await financialMirror(c)).toEqual(money)
  })
  it('RA372-F2E actual equipment substitution keeps the same occupied time and original DATE', async () => {
    const c = await h.cohort(2), capacity = await activated(c)
    const equipment: string[] = []
    for (const label of ['Original adoption equipment', 'Separately agreed replacement equipment']) {
      equipment.push(ok<{ id: string }>(await h.call(c.company.owner, 'POST', `/vendors/${c.company.id}/resources`,
        { kind: 'equipment', label }), 'same-company equipment').id)
    }
    const person = ok<{ id: string }>(await h.call(c.company.owner, 'POST', `/vendors/${c.company.id}/resources`,
      { kind: 'person', label: 'Non-neutral person control', personUserId: c.company.owner.id }), 'person exists before original bounds')
    const act: Activated = { ...capacity, resourceId: equipment[0]!, window: null }
    const plan = await planFor(c, act, 0, { quantity: 1 })
    await settleSplit(c, act, new Map([[plan.deal, spansFor([{}]).slice(1)]]))
    const t = await publishFor(c, act, plan)
    ok(await adopt(c, act, t), 'genuine equipment adoption')
    const before = await financialMirror(c), original = await proofs(t.deal)
    const old = (await h.db.query<{ line: Record<string, unknown> }>(
      "select private_snapshot->'lines'->0 line from deal_resource_plan_versions where id=$1", [t.planRevisionId])).rows[0]!.line
    const fields = ['partId', 'resourceId', 'capacityWindowId', 'quantity', 'startsAt', 'endsAt', 'timeZone',
      'setupMinutes', 'teardownMinutes', 'travelBeforeMinutes', 'travelAfterMinutes']
    const changed = ok<{ orderVersion: string; current: { planRevisionId: string } }>(await h.call(c.company.owner,
      'PATCH', `/deals/${t.deal}/order/resource-plan`, { expectedVersion: t.orderVersion, expectedPlanRevision: '1',
        lines: [{ ...Object.fromEntries(fields.map(key => [key, old[key]])), resourceId: equipment[1] }] }), 'equipment-only new plan')
    const next = await publishFor(c, act, { deal: t.deal, orderVersion: changed.orderVersion, planRevisionId: changed.current.planRevisionId }, { schema3: false })
    const forkFrame = await adoptionFrame(c), pendingId = randomUUID()
    let pendingInserted = false
    await expect(h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { weddingIds: [c.wedding], sourceIds: [act.sourceId], actor: h.actorInput(c.pair) })
      await client.query(`insert into deal_resource_commitment_versions(id,wedding_id,deal_id,vendor_id,revision,previous_version_id,
        terms_id,plan_revision_id,policy_revision,action,state,created_by) values($1,$2,$3,$4,2,$5,$6,$7,$8,'replace','reserved',$9)`,
      [pendingId, c.wedding, t.deal, c.company.id, original[0]!.commitment_version_id, next.termsId, next.planRevisionId, act.policyRevision, c.pair.id])
      expect((await client.query<{ own: boolean; other: boolean }>('select legacy_calendar_adopted_version($1,$2) own,legacy_calendar_adopted_version($3,$2) other',
        [t.deal, pendingId, c.deals[1]])).rows).toEqual([{ own: true, other: false }])
      pendingInserted = true
      // This pending version has proved ancestry but no published head/members.
      // The old deferred graph guard must still reject it at outer COMMIT.
    })).rejects.toMatchObject({ code: '23514' })
    expect(pendingInserted).toBe(true)
    expect(await adoptionFrame(c)).toEqual(forkFrame)
    const probe = `c372_pending_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    assert.match(probe, /^c372_pending_[a-f0-9]{12}$/)
    await h.db.query(`create function ${probe}() returns trigger language plpgsql as $$ begin
      if NEW.deal_id='${t.deal}'::uuid then
        if not legacy_calendar_adopted_version(NEW.deal_id,NEW.origin_version_id)
          or exists(select 1 from deal_resource_commitments where deal_id=NEW.deal_id and current_version_id=NEW.origin_version_id) then
          raise exception 'pending-origin ancestry control failed' using errcode='22012';end if;
        insert into audit_log(action,entity,entity_id,diff) values('test.c372_pending_origin','order',NEW.deal_id,
          jsonb_build_object('origin',NEW.origin_version_id,'notPublishedYet',true));
      end if;return NEW;end $$`)
    await h.db.query(`create trigger ${probe} before insert on resource_allocations for each row execute function ${probe}()`)
    let reply: Awaited<ReturnType<typeof h.call>>
    try {
      reply = await h.call(c.pair, 'POST', `/deals/${t.deal}/order/resource-commitments/replace`, replacementBody(act, next, '1'))
    } finally {
      await h.db.query(`drop trigger ${probe} on resource_allocations`)
      await h.db.query(`drop function ${probe}()`)
    }
    expect(reply.statusCode).toBe(200)
    expect(reply.json<Commitment>()).toMatchObject({ revision: '2', reservation: 'reserved' })
    expect((await h.db.query<{ resource_id: string; proven: boolean }>(`select resource_id::text,
      legacy_calendar_adopted_version(deal_id,origin_version_id) proven from resource_allocations where deal_id=$1 and released_at is null`, [t.deal])).rows)
      .toEqual([{ resource_id: equipment[1], proven: true }])
    expect((await h.db.query<{ diff: { notPublishedYet: boolean } }>(
      "select diff from audit_log where action='test.c372_pending_origin' and entity_id=$1", [t.deal])).rows)
      .toEqual([{ diff: expect.objectContaining({ notPublishedYet: true }) }])
    expect((await h.db.query<{ proven: boolean }>('select legacy_calendar_adopted_commitment($1) proven', [c.deals[1]])).rows).toEqual([{ proven: false }])
    const thirdPlan = ok<{ orderVersion: string; current: { planRevisionId: string } }>(await h.call(c.company.owner,
      'PATCH', `/deals/${t.deal}/order/resource-plan`, { expectedVersion: changed.orderVersion, expectedPlanRevision: '2',
        lines: [{ ...Object.fromEntries(fields.map(key => [key, old[key]])), resourceId: equipment[0] }] }), 'separately agreed second equipment substitution')
    const third = await publishFor(c, act, { deal: t.deal, orderVersion: thirdPlan.orderVersion, planRevisionId: thirdPlan.current.planRevisionId }, { schema3: false })
    const again = await h.call(c.pair, 'POST', `/deals/${t.deal}/order/resource-commitments/replace`, replacementBody(act, third, '2'))
    expect(again.statusCode).toBe(200)
    expect(again.json<Commitment>()).toMatchObject({ revision: '3', reservation: 'reserved' })
    const shifted = ok<{ orderVersion: string; current: { planRevisionId: string } }>(await h.call(c.company.owner,
      'PATCH', `/deals/${t.deal}/order/resource-plan`, { expectedVersion: thirdPlan.orderVersion, expectedPlanRevision: '3',
        lines: [{ ...Object.fromEntries(fields.map(key => [key, old[key]])), resourceId: equipment[0], travelBeforeMinutes: 1 }] }), 'separate changed-time draft')
    const shiftedTerms = await publishFor(c, act, { deal: t.deal, orderVersion: shifted.orderVersion, planRevisionId: shifted.current.planRevisionId }, { schema3: false })
    const beforeShift = await h.graph(c.company)
    expect((await h.call(c.pair, 'POST', `/deals/${t.deal}/order/resource-commitments/replace`, replacementBody(act, shiftedTerms, '3'))).statusCode).toBe(409)
    expect(await h.graph(c.company)).toEqual(beforeShift)
    expect((await h.db.query<{ projection: unknown }>('select legacy_calendar_adoption_calendar_projection($1,$2) projection', [c.wedding, t.deal])).rows).toEqual([{ projection: null }])
    let orderVersion = shifted.orderVersion, planRevision = 4n
    for (const spec of [{ resourceId: capacity.resourceId, capacityWindowId: capacity.window, quantity: 3 },
      { resourceId: person.id, capacityWindowId: null, quantity: 1 }]) {
      const changedKind = ok<{ orderVersion: string; current: { planRevisionId: string } }>(await h.call(c.company.owner,
        'PATCH', `/deals/${t.deal}/order/resource-plan`, { expectedVersion: orderVersion, expectedPlanRevision: planRevision.toString(),
          lines: [{ ...Object.fromEntries(fields.map(key => [key, old[key]])), ...spec }] }), 'separately agreed non-neutral resource-kind draft')
      const changedTerms = await publishFor(c, act, { deal: t.deal, orderVersion: changedKind.orderVersion, planRevisionId: changedKind.current.planRevisionId }, { schema3: false })
      const frame = await adoptionFrame(c)
      expect((await h.db.query<{ projection: unknown }>('select legacy_calendar_adoption_calendar_projection($1,$2) projection', [c.wedding, t.deal])).rows).toEqual([{ projection: null }])
      expect((await h.call(c.pair, 'POST', `/deals/${t.deal}/order/resource-commitments/replace`, replacementBody(act, changedTerms, '3'))).statusCode).toBe(409)
      expect(await adoptionFrame(c)).toEqual(frame)
      orderVersion = changedKind.orderVersion; planRevision++
    }
    const restored = ok<{ orderVersion: string; current: { planRevisionId: string } }>(await h.call(c.company.owner,
      'PATCH', `/deals/${t.deal}/order/resource-plan`, { expectedVersion: orderVersion, expectedPlanRevision: planRevision.toString(),
        lines: [{ ...Object.fromEntries(fields.map(key => [key, old[key]])), resourceId: equipment[0] }] }), 'restore calendar-neutral equipment draft')
    expect((await h.db.query<{ present: boolean }>('select legacy_calendar_adoption_calendar_projection($1,$2) is not null present', [c.wedding, t.deal])).rows).toEqual([{ present: true }])
    const editedOrder = ok<{ version: string }>(await h.call(c.company.owner, 'POST', `/deals/${t.deal}/order/parts`,
      { expectedVersion: restored.orderVersion, kind: 'deliverable', assignmentId: null, title: 'Separate non-plan order edit',
        details: { dueAt: '2027-08-10T11:00:00Z' } }), 'actual unrelated order edit')
    const editedTerms = await publishFor(c, act, { deal: t.deal, orderVersion: editedOrder.version, planRevisionId: restored.current.planRevisionId }, { schema3: false })
    const editedFrame = await adoptionFrame(c)
    expect((await h.db.query<{ projection: unknown }>('select legacy_calendar_adoption_calendar_projection($1,$2) projection', [c.wedding, t.deal])).rows).toEqual([{ projection: null }])
    expect((await h.call(c.pair, 'POST', `/deals/${t.deal}/order/resource-commitments/replace`, replacementBody(act, editedTerms, '3'))).statusCode).toBe(409)
    expect(await adoptionFrame(c)).toEqual(editedFrame)
    expect(await proofs(t.deal)).toEqual(original)
    expect(await financialMirror(c)).toEqual(before)
  })
  it('RA372-F3 new-key retries require the exact applied proof and all original pins', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]); const t = list[0]!
    ok(await adopt(c, act, t), 'original adoption before new-key controls')
    const before = await h.graph(c.company)
    for (const [extra, status] of [
      [{ termsDigest: '0'.repeat(64) }, 422], [{ expectedTermsVersion: '999' }, 409],
      [{ sourceId: randomUUID() }, 409], [{ sourceVersionId: randomUUID() }, 409],
      [{ effectiveBoundsVersionId: randomUUID() }, 409], [{ expectedSourceFingerprint: '0'.repeat(64) }, 409],
      [{ expectedSourceHeadRevision: '999' }, 409], [{ expectedCommitmentRevision: '999' }, 409],
    ] as const) {
      const reply = await adopt(c, act, t, extra, randomUUID())
      expect(reply.statusCode, JSON.stringify(extra)).toBe(status)
      expect(await h.graph(c.company)).toEqual(before)
    }
    expect(await proofs(t.deal)).toHaveLength(1)
    expect((await adopt(c, act, t, {}, randomUUID())).statusCode).toBe(200)
    expect(await proofs(t.deal)).toHaveLength(1)
  })
  it('RA372-A1 group replay cannot retain former owner authority through a native wait', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]), t = list[0]!, key = randomUUID()
    const url = h.ownerUrl(c.company, act.sourceId) + '/adopt'
    const body = { expectedSourceHeadRevision: t.pins.expectedSourceHeadRevision, holders: [groupHolder(c, act, t)] }
    ok(await h.call(c.company.owner, 'POST', url, body, key), 'original group receipt')
    const nextOwner = await h.actor()
    await h.db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [c.wedding, c.company.owner.id])
    const frame = await adoptionFrame(c), money = await financialMirror(c)
    const reply = await nativeWait(async client => {
      await prepareLegacyCalendarScope(client as unknown as Queryable, { sourceIds: [act.sourceId], vendorIds: [c.company.id],
        weddingIds: [c.wedding], personIds: [nextOwner.id], actor: h.actorInput(c.company.owner) })
      await client.query('select id from vendors where id=$1 for update', [c.company.id])
      await client.query('select key from idempotency_keys where key=$1 for update',
        [`${c.company.owner.id}:/vendors/:vendorId/legacy-calendar/sources/:sourceId/adopt:${key}`])
    }, () => h.call(c.company.owner, 'POST', url, body, key), async client => {
      await client.query('update vendors set user_id=$2 where id=$1', [c.company.id, nextOwner.id])
      // The deliberate transfer itself appends the native owner-person link.
      // Admit exactly that control-TX row, while retaining the complete command
      // frame as the no-effects oracle for the denied concurrent replay.
      const links = await h.raw('legacy_calendar_person_links', 'vendor_identity=$1', [c.company.id], client as unknown as Queryable)
      const added = links.filter(row => !frame.legacy_calendar_person_links!.includes(row))
      expect(added).toHaveLength(1)
      expect(JSON.parse(added[0]!)).toMatchObject({ vendor_identity: c.company.id, person_identity: nextOwner.id,
        origin_kind: 'owner', origin_id: c.company.id, unknown_identity: false })
      expect(links).toHaveLength(frame.legacy_calendar_person_links!.length + 1)
      frame.legacy_calendar_person_links = links
    })
    // The changed prefix refuses before the later owner seat can be read.
    denied(reply, 409, 'calendar_scope_changed')
    denied(await h.call(c.company.owner, 'POST', url, body, key), 404)
    expect(await adoptionFrame(c)).toEqual(frame)
    expect(await financialMirror(c)).toEqual(money)
  })
  it.each(['new', 'replay'] as const)('RA372-A2 %s adoption rechecks an access JWT that expires during a native wait', async mode => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]), t = list[0]!, key = randomUUID()
    if (mode === 'replay') ok(await adopt(c, act, t, {}, key), 'original single receipt')
    const frame = await adoptionFrame(c), money = await financialMirror(c)
    let caller = c.pair, exp = 0
    const reply = await nativeWait(async client => { await client.query('select id from weddings where id=$1 for update', [c.wedding]) }, async () => {
      exp = Math.floor(Date.now() / 1000) + 5
      caller = { ...c.pair, token: await signAccessToken(SECRET, { sub: c.pair.id, sid: c.pair.sid }, (exp - ACCESS_TTL_SECONDS) * 1000) }
      expect(await verifyAccessToken(SECRET, caller.token)).toEqual({ sub: caller.id, sid: caller.sid, exp })
      return h.call(caller, 'POST', `/deals/${t.deal}/order/resource-adoption`, adoptBody(act, t), key)
    }, async () => {
      let expired = false
      const deadline = performance.now() + 7000
      while (performance.now() < deadline) {
        try { await verifyAccessToken(SECRET, caller.token) } catch (error) {
          if (!(error instanceof AppError) || error.statusCode !== 401 || error.code !== 'token_expired') throw error
          expired = true; break
        }
        await pause(15)
      }
      expect(expired).toBe(true)
    })
    denied(reply, 401, 'token_expired')
    expect(await adoptionFrame(c)).toEqual(frame)
    expect(await financialMirror(c)).toEqual(money)
  })
  it('RA372-A4 a wrong actual foreign source refuses before its held bounds head, fresh and applied', async () => {
    const c = await h.cohort(1)
    const { act, list } = await prepared(c, 'all', [{}]), t = list[0]!
    const foreign = await h.cohort(1), foreignSource = await daySource(foreign)
    await h.propose(foreign.company, foreignSource)
    for (const mode of ['fresh', 'applied']) {
      if (mode === 'applied') ok(await adopt(c, act, t), 'real adoption before applied foreign-source control')
      const frame = await adoptionFrame(c)
      const client = new Client({ connectionString: process.env.TEST_DATABASE_URL!, application_name: 'c372_owned_foreign_head_control',
        connectionTimeoutMillis: 5000, statement_timeout: 12000, idle_in_transaction_session_timeout: 15000 })
      let pending: Promise<{ reply: Reply } | { error: unknown }> | undefined, finished = false
      try {
        await client.connect(); await client.query('begin')
        expect((await client.query('select source_id from legacy_calendar_bounds_heads where source_id=$1 for update', [foreignSource])).rowCount).toBe(1)
        const identity = (await client.query<{ pid: number; birth: string; xid: string }>(
          'select pg_backend_pid() pid,backend_start::text birth,txid_current()::text xid from pg_stat_activity where pid=pg_backend_pid()')).rows[0]!
        pending = adopt(c, act, t, { sourceId: foreignSource }).then(reply => { finished = true; return { reply } }, error => { finished = true; return { error } })
        let blocked: Record<string, unknown> | undefined
        const deadline = performance.now() + 8000
        while (!finished && performance.now() < deadline) {
          blocked = (await h.db.query(`select pid,backend_start::text,query,pg_blocking_pids(pid) blockers from pg_stat_activity
            where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [identity.pid])).rows[0]
          if (blocked) break
          await pause(10)
        }
        const finishedBeforeRelease = finished
        expect((await client.query('select pg_backend_pid() pid,backend_start::text birth,txid_current()::text xid from pg_stat_activity where pid=pg_backend_pid()')).rows)
          .toEqual([identity])
        process.stdout.write(`ADOPTION372_FOREIGN_HEAD_CONTROL ${JSON.stringify({ mode, identity, finishedBeforeRelease, blocked: blocked ?? null })}\n`)
        await client.query('rollback')
        const outcome = await pending
        if ('error' in outcome) throw outcome.error
        expect(finishedBeforeRelease).toBe(true)
        expect(blocked).toBeUndefined()
        denied(outcome.reply, 409, 'legacy_calendar_bounds_changed')
        expect(await adoptionFrame(c)).toEqual(frame)
      } finally {
        await client.query('rollback').catch(() => undefined)
        await client.end()
        if (pending) await pending
      }
    }
  })
  it('RA372-N13 caller-supplied snapshot.schemaVersion never selects schema3', async () => {
    const c = await h.cohort(1), act = await activated(c)
    const deal = c.deals[0]!
    const order = ok<{ version: string }>(await h.call(c.company.owner, 'GET', `/deals/${deal}/order`), 'current order')
    const prior = ok<{ revision: string }>(await h.call(c.pair, 'GET', `/deals/${deal}/order/terms`), 'terms revision')
    const reply = await h.call(c.pair, 'POST', `/deals/${deal}/order/terms/proposals`,
      { expectedOrderVersion: order.version, expectedTermsRevision: prior.revision, snapshot: { schemaVersion: 3 } })
    // The extra caller field is rejected by the strict body schema; even a
    // smuggled field could never become server-built adoption material.
    expect(reply.statusCode).toBe(422)
    void act
  })
})
