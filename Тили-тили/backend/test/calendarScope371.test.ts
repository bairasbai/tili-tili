import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isDeepStrictEqual } from 'node:util'
import type { Db, Queryable } from '../src/plugins/db.js'
import { prepareLegacyCalendarScope, type LegacyCalendarScopeInput } from '../src/resources/legacy-calendar-scope.js'
import { createResource } from '../src/resources/model.js'
import { activateLegacyCalendarBounds, type CalendarBoundsPrivateView } from '../src/resources/legacy-calendar.js'
import { commitAgreedOrderResources, type CommitResourceInput } from '../src/resources/commitments.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'
import { lockBookingContext, bookVendor } from '../src/deals/book.js'
import { eraseUser } from '../src/jobs/index.js'
import { Calendar371Fixture, POLICY, denied, ok, type Actor, type Company, type Cohort } from './calendarBounds371.fixtures.js'

type Wait = { pid: number; query: string; wait_event: string | null; blockers: number[] }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
type Action<T> = { finished: boolean; completion: Promise<Outcome<T>> }
type Control = { client: Client; pid: number }
const queryable = (client: Client): Queryable => client as unknown as Queryable
const trace = (label: string, value: unknown) => process.stdout.write(`CALENDAR371_SCOPE_TRACE ${JSON.stringify({ label, value })}\n`)
// Root-authorized native flow budget: genuine multi-source API setup is slow.
// Only this file's cases use 240s; SQL/control deadlines and wait witnesses stay bounded.
const WAIT_BOUND_MS = 8000

describe.sequential('FULL371 actual native scope births waits and current replay', { timeout: 240_000 }, () => {
  const h = new Calendar371Fixture(), controls = new Set<Client>()
  beforeAll(() => h.open())
  afterAll(async () => {
    const failures: unknown[] = []
    for (const client of controls) {
      try { await client.query('rollback') } catch (error) { failures.push(error) }
      try { await client.end() } catch (error) { failures.push(error) }
    }
    controls.clear(); await h.close()
    if (failures.length) throw new AggregateError(failures, 'Owned scope-control cleanup failed')
  })
  function launch<T>(operation: Promise<T>): Action<T> {
    const action: Action<T> = { finished: false, completion: Promise.resolve({ ok: false as const, error: 'not started' }) }
    action.completion = operation.then(value => { action.finished = true; return { ok: true as const, value } },
      error => { action.finished = true; return { ok: false as const, error } })
    return action
  }
  async function control<T>(body: (c: Control) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL!, application_name: 'calendar371_owned_scope_control',
      connectionTimeoutMillis: 5000, statement_timeout: 12000, idle_in_transaction_session_timeout: 15000 })
    controls.add(client)
    let result!: T, primary: unknown, failed = false, connected = false, ended = false
    const cleanup: unknown[] = []
    try {
      await client.connect(); connected = true; await client.query('begin')
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      trace('control-open', { pid, nodePID: process.pid, owner: 'root/calendar371-scope-tests', openedAt: new Date().toISOString(),
        cwd: process.cwd(), database: 'tili_ecosystem_full_20260930_test', port: 15432 })
      result = await body({ client, pid })
    } catch (error) { failed = true; primary = error }
    if (connected) { try { await client.query('rollback') } catch (error) { cleanup.push(error) } }
    try { await client.end(); ended = true } catch (error) { cleanup.push(error) }
    if (ended) controls.delete(client)
    trace('control-close', { endResolved: ended, cleanupErrors: cleanup.length })
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Scope-control rollback/end failed')
    if (failed) throw primary
    return result
  }
  async function waitFor(blocker: number, action: Action<unknown>, label: string): Promise<Wait> {
    const deadline = performance.now() + WAIT_BOUND_MS
    while (!action.finished && performance.now() < deadline) {
      const row = (await h.db.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) order by pid`, [blocker])).rows[0]
      if (row) { expect(row.blockers).toContain(blocker); trace(label, { blocker, ...row }); return row }
      await pause(10) // polling yield, never the evidence of blocking
    }
    throw new Error(`ACTUAL_WAIT_MISSING ${label}: no pg_blocking_pids witness`)
  }
  async function releaseAndDrain(client: Client, action: Action<unknown>): Promise<void> {
    // completion never rejects, so no detached pending business transaction survives a failed assertion.
    await client.query('rollback').catch(() => undefined)
    await action.completion
  }
  async function waitForTwo(blocker: Control, actions: Action<unknown>[], label: string, workerPids: number[]): Promise<Wait[]> {
    expect(workerPids).toHaveLength(2); expect(new Set(workerPids).size).toBe(2)
    expect(workerPids).not.toContain(blocker.pid)
    const deadline = performance.now() + WAIT_BOUND_MS
    while (actions.every(a => !a.finished) && performance.now() < deadline) {
      // The held connection observes both exact workers. PostgreSQL may queue
      // one tuple waiter behind the other, so both need not block directly on us.
      await blocker.client.query('select pg_stat_clear_snapshot()')
      const rows = (await blocker.client.query<Wait & { state: string; wait_event_type: string | null }>(`select pid,state,query,wait_event_type,wait_event,pg_blocking_pids(pid) blockers
        from pg_stat_activity where datname=current_database() and pid=any($1::int[]) order by pid`, [workerPids])).rows
      const byPid = new Map(rows.map(row => [row.pid, row]))
      const reachesOwnedBlocker = (pid: number, visited: ReadonlySet<number>): boolean => {
        if (pid === blocker.pid) return true
        if (visited.has(pid)) return false // a cycle is never accepted as serialization
        const row = byPid.get(pid)
        if (!row || row.state !== 'active' || row.wait_event_type !== 'Lock' || !row.blockers.length ||
          !row.query.includes('legacy_calendar_bounds_prepare_scope')) return false
        const next = new Set(visited); next.add(pid)
        // Every edge is closed over these two known workers and our actual held
        // account blocker; no unrelated PID or unfinished branch can be evidence.
        return row.blockers.every(parent => (parent === blocker.pid || workerPids.includes(parent)) && reachesOwnedBlocker(parent, next))
      }
      if (rows.length === 2 && byPid.size === 2 && workerPids.every(pid => reachesOwnedBlocker(pid, new Set()))) {
        trace(label, { blocker: blocker.pid, waiters: rows, allClosedPathsReachOwnedBlocker: true }); return rows
      }
      await pause(10) // bounded polling only; the graph above is the evidence
    }
    throw new Error(`ACTUAL_TWO_WAITS_MISSING ${label}`)
  }
  function succeeded<T>(outcome: Outcome<T>): T {
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
  function scopeRefused(outcome: Outcome<unknown>): void {
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatchObject({ statusCode: 409 })
  }
  async function invitation(c: Company, person: Actor) {
    return h.db.tx(client => inviteStaff(client, { vendorId: c.id, actor: h.actorInput(c.owner), role: 'worker', targetUserId: person.id }))
  }
  async function equalPeople(): Promise<{ a: Company; b: Company }> {
    const a = await h.company(), b = await h.company()
    for (const [company, person] of [[a, b.owner], [b, a.owner]] as const) {
      const i = await invitation(company, person)
      await h.db.tx(client => acceptStaffInvite(client, { token: i.token, actor: h.actorInput(person) }))
    }
    const expected = [a.owner.id, b.owner.id].sort()
    for (const company of [a, b]) {
      const row = (await h.db.query<{ scope: { identities: string[]; unknownOrigins: unknown[] } }>(
        'select legacy_calendar_bounds_known_person_scope($1) scope', [company.id])).rows[0]!.scope
      expect(row.identities).toEqual(expected); expect(row.unknownOrigins).toEqual([])
    }
    return { a, b }
  }
  async function nativeLocate(client: Queryable, seed: LegacyCalendarScopeInput) {
    return (await client.query<{ scope: { weddings: string[]; resources: string[]; keys: { kind: string; identity: string }[] } }>(
      'select legacy_calendar_bounds_locate($1::jsonb) scope', [JSON.stringify(seed)])).rows[0]!.scope
  }
  async function firstWedding(seed: LegacyCalendarScopeInput): Promise<string> {
    const located = await nativeLocate(h.db, seed)
    assert(located.weddings.length, 'SETUP_SCOPE371: real first wedding parent required')
    return [...located.weddings].sort()[0]!
  }
  async function boundFrame(source: string, client: Queryable = h.db): Promise<Record<string, string[]>> {
    const raw: Record<string, string[]> = {}
    for (const table of ['legacy_calendar_bounds_versions', 'legacy_calendar_bounds_holders', 'legacy_calendar_bounds_receipts',
      'legacy_calendar_bounds_heads', 'legacy_calendar_resolution_events', 'legacy_calendar_resolution_holders']) {
      raw[table] = await h.raw(table, 'source_id=$1', [source], client)
    }
    for (const table of ['legacy_calendar_bounds_spans', 'legacy_calendar_bounds_person_scope']) {
      raw[table] = await h.raw(table, 'bounds_version_id in(select id from legacy_calendar_bounds_versions where source_id=$1)', [source], client)
    }
    raw.certificates = await h.raw('resource_occupancy_origin_certificates', 'source_identity=$1', [source], client)
    raw.occupancy = await h.raw('resource_occupancy', 'certificate_id in(select id from resource_occupancy_origin_certificates where source_identity=$1)', [source], client)
    return raw
  }
  async function currentAppProof(c: Cohort): Promise<{ id: string; view: CalendarBoundsPrivateView }> {
    const id = (await h.liveSources(c.company)).find(s => s.kind === 'app_day')?.id
    assert(id, 'SETUP_SCOPE371: genuine app_day required')
    await h.propose(c.company, id); await h.agree(c.company, id)
    const view = await h.editor(c.company, id)
    expect(view.readiness.requiredReceipts).toBe(4); expect(view.readiness.acceptedReceipts).toBe(4)
    expect(view.readiness.canActivate).toBe(true)
    return { id, view }
  }
  async function allButLast(c: Cohort): Promise<{ id: string; view: CalendarBoundsPrivateView; ids: string[] }> {
    const sources = await h.liveSources(c.company); assert(sources.length)
    for (const s of sources) { await h.propose(c.company, s.id); await h.agree(c.company, s.id) }
    for (const s of sources.slice(0, -1)) await h.activate(c.company, s.id)
    const id = sources.at(-1)!.id, view = await h.editor(c.company, id)
    expect(view.readiness.canActivate).toBe(true)
    return { id, view, ids: sources.map(s => s.id) }
  }

  type OpaqueReply = Awaited<ReturnType<Calendar371Fixture['call']>>
  type OpaqueBackend = { pid: number; backend_start: string; xact_start: string; txid: string; database: string; principal: string }
  type OpaqueCase = { label: string; actor: Actor; seed: LegacyCalendarScopeInput; foreignSource: string;
    requestedWedding: string | null; requestedDeal: string | null; foreignWedding: string; foreignDeal: string;
    gateTable: 'weddings' | 'deals'; gateId: string; ownUrl: string; foreignUrl: string; body: object; key: string; first: OpaqueReply }
  async function opaqueBackend(c: Queryable): Promise<OpaqueBackend> {
    const rows = (await c.query<OpaqueBackend>(`select pg_backend_pid() pid,current_database() database,current_user principal,txid_current()::text txid,
      a.backend_start::text backend_start,a.xact_start::text xact_start from pg_stat_activity a where a.pid=pg_backend_pid()`)).rows
    assert.equal(rows.length, 1); const row = rows[0]!
    assert(Number.isSafeInteger(row.pid) && row.pid > 0 && row.backend_start && row.xact_start && /^[0-9]+$/.test(row.txid))
    return row
  }
  async function opaqueFrame(): Promise<Record<string, string[]>> {
    const tables = (await h.db.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename")).rows
    assert(tables.length > 0); const frame: Record<string, string[]> = {}
    for (const { tablename } of tables) frame[tablename] = await h.raw(tablename, 'true', [])
    return frame
  }
  async function opaque404UnderGate(gate: Control, info: OpaqueCase, key: string): Promise<void> {
    const held = await opaqueBackend(queryable(gate.client)); assert.equal(held.pid, gate.pid)
    await gate.client.query("set local statement_timeout='1000ms'")
    const db = h.db, original = db.tx, invoke: Db['tx'] = original.bind(db)
    let worker: OpaqueBackend | undefined, captures = 0, action: Action<OpaqueReply> | undefined
    let verified = false, failed = false, primary: unknown
    const cleanup: unknown[] = []
    const delegate: Db['tx'] = <T>(body: (c: Queryable) => Promise<T>): Promise<T> => invoke<T>(async c => {
      captures++; assert.equal(captures, 1, 'Only one armed route transaction may be observed')
      worker = await opaqueBackend(c)
      return body(c) // unchanged actual client, callback, data and errors
    })
    db.tx = delegate
    try {
      action = launch(h.call(info.actor, 'POST', info.foreignUrl, info.body, key))
      const deadline = performance.now() + WAIT_BOUND_MS
      while (performance.now() < deadline) {
        if (action.finished) {
          const reply = succeeded(await action.completion)
          denied(reply, 404, 'not_found')
          assert(!reply.body.includes('"readToken"') && !reply.body.includes('"proposal"') && !reply.body.includes(info.foreignSource),
            'Opaque refusal must not expose source facts or proofs')
          const envelope = reply.json<{ error: { code: string; message: string } }>()
          assert(isDeepStrictEqual(Object.keys(envelope), ['error']) && isDeepStrictEqual(Object.keys(envelope.error).sort(), ['code','message']),
            'Opaque refusal must contain only the standard error envelope')
          await gate.client.query('select pg_stat_clear_snapshot()')
          assert(isDeepStrictEqual(await opaqueBackend(queryable(gate.client)), held), 'Opaque404 must finish while the exact foreign gate TX remains open')
          verified = true
          trace('opaque404-before-foreign-prefix', { label: info.label, foreignSource: info.foreignSource, gateTable: info.gateTable,
            gateId: info.gateId, holder: held, routeWorker: worker ?? null, observedRouteTransactions: captures, status: reply.statusCode })
          break
        }
        if (worker) {
          await gate.client.query('select pg_stat_clear_snapshot()')
          const rows = (await gate.client.query<{ pid: number; backend_start: string; xact_start: string | null; datname: string; usename: string;
            state: string; wait_event_type: string | null; query: string; blockers: number[];
            holder_pid: number; holder_backend_start: string; holder_xact_start: string | null; observed_at: string }>(`select w.pid,w.backend_start::text backend_start,
            w.xact_start::text xact_start,w.datname,w.usename,w.state,w.wait_event_type,w.query,pg_blocking_pids(w.pid) blockers,
            b.pid holder_pid,b.backend_start::text holder_backend_start,b.xact_start::text holder_xact_start,clock_timestamp()::text observed_at
            from pg_stat_activity w join pg_stat_activity b on b.pid=$2 where w.pid=$1`, [worker.pid, held.pid])).rows
          assert(rows.length <= 1)
          const row = rows[0]
          if (row && row.state === 'active' && row.wait_event_type === 'Lock' && row.blockers.includes(held.pid)
            && row.query.trim().replace(/\s+/g, ' ') === 'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope') {
            assert.equal(row.pid, worker.pid); assert.equal(row.backend_start, worker.backend_start); assert.equal(row.xact_start, worker.xact_start)
            assert.equal(row.datname, worker.database); assert.equal(row.usename, worker.principal)
            assert.equal(row.holder_pid, held.pid); assert.equal(row.holder_backend_start, held.backend_start); assert.equal(row.holder_xact_start, held.xact_start)
            trace('OPAQUE_PREAUTH_UNDESIRED_FOREIGN_WAIT', { label: info.label, foreignSource: info.foreignSource,
              requestedWedding: info.requestedWedding, requestedDeal: info.requestedDeal, gateTable: info.gateTable, gateId: info.gateId,
              holder: held, routeWorker: worker, activity: row, requiredStatusBeforeGateRelease: 404 })
            assert.fail('OPAQUE404_REQUIRED_WHILE_FOREIGN_GATE_HELD: actual closed-prefix wait on unauthorized source')
          }
        }
        await pause(10) // pacing only; a timeout alone never qualifies as the meaningful RED
      }
      assert(verified, 'SETUP_OPAQUE_PROBE_DEADLINE: neither completed opaque404 nor actual foreign wait witness')
    } catch (error) { failed = true; primary = error } finally {
      if (!verified) { try { await gate.client.query('rollback') } catch (error) { cleanup.push(error) } }
      if (action) await action.completion // reflected immediately by launch; drain before restoring the delegate
      if (db.tx !== delegate) cleanup.push(new Error('Owned route transaction observation changed unexpectedly'))
      db.tx = original
    }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Opaque probe release/drain/restore failed')
    if (failed) throw primary
  }
  async function exerciseOpaque(info: OpaqueCase): Promise<void> {
    const located = (await h.db.query<{ scope: { sources: string[]; weddings: string[]; deals: string[] } }>(
      'select legacy_calendar_bounds_locate($1::jsonb) scope', [JSON.stringify(info.seed)])).rows[0]!.scope
    expect(located.sources).toContain(info.foreignSource); expect(located.weddings).toContain(info.foreignWedding); expect(located.deals).toContain(info.foreignDeal)
    trace('opaque-native-source-gate-map', { label: info.label, foreignSource: info.foreignSource, requestedWedding: info.requestedWedding,
      requestedDeal: info.requestedDeal, gateTable: info.gateTable, gateId: info.gateId, actualScope: located })
    const before = await opaqueFrame()
    let failed = false, primary: unknown
    try {
      await control(async gate => {
        const sql = info.gateTable === 'weddings' ? 'select id from weddings where id=$1 for update' : 'select id from deals where id=$1 for update'
        expect((await gate.client.query<{ id: string }>(sql, [info.gateId])).rows).toEqual([{ id: info.gateId }])
        await opaque404UnderGate(gate, info, info.key) // collision with a genuine own-source successful cache
        await opaque404UnderGate(gate, info, randomUUID()) // first use must remain equally opaque
      })
    } catch (error) { failed = true; primary = error }
    const post: unknown[] = []
    try {
      const replay = await h.call(info.actor, 'POST', info.ownUrl, info.body, info.key)
      ok(replay, 'legitimate own-source cached replay after opaque refusal')
      assert(isDeepStrictEqual(replay.json(), info.first.json()), 'The legitimate own-source cached payload must stay exact')
      const after = await opaqueFrame()
      assert(isDeepStrictEqual(after, before), 'Opaque foreign requests and own cached retry must preserve every public raw row')
      trace('opaque-full-raw-frame-unchanged', { label: info.label, publicTables: Object.keys(before).length,
        auditRows: before.audit_log!.length, idempotencyRows: before.idempotency_keys!.length, allLiteralRowsUnchanged: true })
    } catch (error) { post.push(error) }
    if (post.length) throw new AggregateError(failed ? [primary, ...post] : post, 'Opaque regression post-proof failed')
    if (failed) throw primary
  }

  type OpaqueGetCase = { label: string; actor: Actor; foreignUrl: string; foreignSource: string;
    foreignWedding: string; foreignDeal: string; foreignVendor: string }
  function assertOpaqueGet(reply: OpaqueReply, info: OpaqueGetCase): void {
    denied(reply, 404, 'not_found')
    assert(String(reply.headers['cache-control']).split(/\s*,\s*/).includes('no-store'), 'Opaque private GET must be no-store')
    const envelope = reply.json<{ error: { code: string; message: string } }>()
    assert(isDeepStrictEqual(Object.keys(envelope), ['error']) && isDeepStrictEqual(Object.keys(envelope.error).sort(), ['code', 'message']),
      'Opaque GET must contain only the standard error envelope')
    assert(!reply.body.includes('"readToken"') && !reply.body.includes('"proposal"') &&
      ![info.foreignSource, info.foreignWedding, info.foreignDeal, info.foreignVendor].some(id => reply.body.includes(id)),
    'Opaque GET must not expose foreign identifiers, material or proofs')
  }
  async function opaqueGet404UnderWeddingGate(gate: Control, info: OpaqueGetCase): Promise<void> {
    const held = await opaqueBackend(queryable(gate.client)); assert.equal(held.pid, gate.pid)
    await gate.client.query("set local statement_timeout='1000ms'")
    const db = h.db, original = db.tx, invoke: Db['tx'] = original.bind(db)
    let worker: OpaqueBackend | undefined, captures = 0, action: Action<OpaqueReply> | undefined
    let verified = false, primary: { error: unknown } | undefined
    const cleanup: unknown[] = []
    const delegate: Db['tx'] = <T>(body: (c: Queryable) => Promise<T>): Promise<T> => invoke<T>(async c => {
      captures++; assert.equal(captures, 1, 'One actual GET route transaction is required')
      worker = await opaqueBackend(c)
      return body(c) // identical real Queryable, callback, result and error
    })
    db.tx = delegate
    try {
      const deadline = performance.now() + WAIT_BOUND_MS
      action = launch(h.call(info.actor, 'GET', info.foreignUrl))
      while (performance.now() < deadline) {
        if (action.finished) {
          assertOpaqueGet(succeeded(await action.completion), info)
          assert.equal(captures, 1, 'Early opaque GET still uses its real DB transaction/access locator')
          assert(worker, 'Actual route backend identity is required')
          await gate.client.query('select pg_stat_clear_snapshot()')
          assert(isDeepStrictEqual(await opaqueBackend(queryable(gate.client)), held), 'GET404 must precede release of the SAME gate TX')
          verified = true
          trace('opaque-get404-before-foreign-wedding-lock', { label: info.label, holder: held, routeWorker: worker,
            observedRouteTransactions: captures, status: 404, foreignWedding: info.foreignWedding })
          break
        }
        if (worker) {
          await gate.client.query('select pg_stat_clear_snapshot()')
          const rows = (await gate.client.query<{ pid: number; backend_start: string; xact_start: string | null; backend_xid: string | null;
            datname: string; usename: string; state: string; wait_event_type: string | null; query: string; blockers: number[];
            holder_pid: number; holder_backend_start: string; holder_xact_start: string | null; holder_backend_xid: string | null; observed_at: string }>(`select
              w.pid,w.backend_start::text backend_start,w.xact_start::text xact_start,w.backend_xid::text backend_xid,
              w.datname,w.usename,w.state,w.wait_event_type,w.query,pg_blocking_pids(w.pid) blockers,
              b.pid holder_pid,b.backend_start::text holder_backend_start,b.xact_start::text holder_xact_start,
              b.backend_xid::text holder_backend_xid,clock_timestamp()::text observed_at
            from pg_stat_activity w join pg_stat_activity b on b.pid=$2 where w.pid=$1`, [worker.pid, held.pid])).rows
          assert(rows.length <= 1)
          const row = rows[0], closed = 'select id from weddings where id=$1 and archived_at is null and cancelled_at is null for share'
          if (row && row.state === 'active' && row.wait_event_type === 'Lock' && row.blockers.length === 1 && row.blockers[0] === held.pid
            && row.query.trim().replace(/\s+/g, ' ') === closed) {
            assert.equal(row.pid, worker.pid); assert.equal(row.backend_start, worker.backend_start); assert.equal(row.xact_start, worker.xact_start)
            assert.equal(row.datname, worker.database); assert.equal(row.usename, worker.principal)
            assert.equal(row.backend_xid, (BigInt(worker.txid) % 4_294_967_296n).toString())
            assert.equal(row.holder_pid, held.pid); assert.equal(row.holder_backend_start, held.backend_start); assert.equal(row.holder_xact_start, held.xact_start)
            assert.equal(row.holder_backend_xid, (BigInt(held.txid) % 4_294_967_296n).toString())
            trace('OPAQUE_GET_UNDESIRED_FOREIGN_WEDDING_SHARE', { label: info.label, foreignWedding: info.foreignWedding,
              foreignDeal: info.foreignDeal, foreignSource: info.foreignSource, holder: held, routeWorker: worker,
              activity: row, requiredStatusBeforeGateRelease: 404 })
            assert.fail('OPAQUE_GET404_REQUIRED_WHILE_FOREIGN_GATE_HELD: actual wedding SHARE wait precedes foreign GET authorization')
          }
        }
        await pause(10) // pacing only, never evidence of a domain failure
      }
      assert(verified, 'SETUP_OPAQUE_GET_DEADLINE: neither completed404 nor exact native wedding SHARE wait observed')
    } catch (error) { primary = { error } } finally {
      try { await gate.client.query('rollback') } catch (error) { cleanup.push(error) }
      if (action) {
        const outcome = await action.completion // immediately reflected at launch, always drained
        if (!outcome.ok) cleanup.push(outcome.error)
        else { try { assertOpaqueGet(outcome.value, info) } catch (error) { cleanup.push(error) } }
      }
      if (db.tx !== delegate) cleanup.push(new Error('Owned GET transaction observer changed unexpectedly'))
      db.tx = original
    }
    if (cleanup.length) throw new AggregateError(primary ? [primary.error, ...cleanup] : cleanup, 'Opaque GET release/drain/restore failed',
      primary ? { cause: primary.error } : undefined)
    if (primary) throw primary.error
  }
  async function exerciseOpaqueGet(kind: 'list' | 'detail'): Promise<void> {
    const a = await h.cohort(1), b = await h.cohort(1)
    const ownSource = (await h.liveSources(a.company)).find(s => s.kind === 'app_root')?.id
    const foreignSource = (await h.liveSources(b.company)).find(s => s.kind === 'app_root')?.id
    assert(ownSource && foreignSource && ownSource !== foreignSource)
    const ownUrl = kind === 'list' ? `/weddings/${a.wedding}/deals/${a.deals[0]!}/legacy-calendar` : h.holderUrl(a.wedding, a.deals[0]!, ownSource)
    const foreignUrl = kind === 'list' ? `/weddings/${b.wedding}/deals/${b.deals[0]!}/legacy-calendar` : h.holderUrl(b.wedding, b.deals[0]!, foreignSource)
    const assertOwnGet = (reply: OpaqueReply, source: string): void => {
      ok(reply, 'real holder GET positive control')
      if (kind === 'list') expect(reply.json<{ sources: { sourceId: string }[] }>().sources.some(s => s.sourceId === source)).toBe(true)
      else expect(reply.json<CalendarBoundsPrivateView>().source.sourceId).toBe(source)
    }
    const own = await h.call(a.pair, 'GET', ownUrl); assertOwnGet(own, ownSource)
    assertOwnGet(await h.call(b.pair, 'GET', foreignUrl), foreignSource)
    const seed = { weddingIds: [b.wedding], vendorIds: [b.company.id], actor: h.actorInput(b.pair) }
    expect((await nativeLocate(h.db, seed)).weddings).toEqual([b.wedding])
    const before = await opaqueFrame(); expect(Object.keys(before)).toHaveLength(124)
    let primary: { error: unknown } | undefined
    try {
      await control(async gate => {
        await prepareLegacyCalendarScope(queryable(gate.client), seed)
        expect((await gate.client.query('select id from weddings where id=$1 for update', [b.wedding])).rows).toEqual([{ id: b.wedding }])
        await opaqueGet404UnderWeddingGate(gate, { label: `CS371-GET-${kind}`, actor: a.pair, foreignUrl,
          foreignSource, foreignWedding: b.wedding, foreignDeal: b.deals[0]!, foreignVendor: b.company.id })
      })
    } catch (error) { primary = { error } }
    const post: unknown[] = []
    try {
      const ownAgain = await h.call(a.pair, 'GET', ownUrl); assertOwnGet(ownAgain, ownSource)
      assert(isDeepStrictEqual(ownAgain.json(), own.json()), 'Own GET payload stays literal after foreign refusal')
    } catch (error) { post.push(error) }
    try {
      const after = await opaqueFrame(); assert(isDeepStrictEqual(Object.keys(after), Object.keys(before)))
      const equal = Object.fromEntries(Object.keys(before).map(table => [table, isDeepStrictEqual(after[table], before[table])]))
      trace('opaque-get-full-raw-frame', { kind, publicTables: Object.keys(before).length, tableEquality: equal,
        allLiteralRowsUnchanged: Object.values(equal).every(Boolean), auditRows: before.audit_log!.length })
      for (const [table, unchanged] of Object.entries(equal)) assert(unchanged, `Opaque GET changed public table ${table}`)
    } catch (error) { post.push(error) }
    if (post.length) throw new AggregateError(primary ? [primary.error, ...post] : post, 'Opaque GET raw/positive post-proof failed',
      primary ? { cause: primary.error } : undefined)
    if (primary) throw primary.error
  }
  it('CS371-B01 actual INSERT child and its new equipment key can extend only the already pinned A/B parent union', async () => {
    const { a, b } = await equalPeople()
    await control(async ({ client }) => {
      const q = queryable(client), seed = { vendorIds: [a.id], actor: h.actorInput(a.owner) }
      const prepared = await prepareLegacyCalendarScope(q, seed)
      const resource = await createResource(q, { vendorId: b.id, actor: h.actorInput(b.owner), kind: 'equipment', label: 'Actual INSERT after full parent prefix' })
      h.resources.add(resource.id)
      expect((await client.query<{ born: boolean }>("select legacy_calendar_bounds_inserted_in_transaction('vendor_resources',$1) born", [resource.id])).rows[0]!.born).toBe(true)
      await prepareLegacyCalendarScope(q, { vendorIds: [b.id], resourceIds: [resource.id], actor: h.actorInput(b.owner) })
      await prepared.assertCurrent()
      trace('actual-insert-admitted', { resource: resource.id, rollbackAfterControl: true })
    })
  })
  it('CS371-B02 UPDATE of a pre-existing outside equipment never qualifies as INSERT birth', async () => {
    const { a, b } = await equalPeople()
    const resource = ok<{ id: string }>(await h.call(b.owner, 'POST', `/vendors/${b.id}/resources`, { kind: 'equipment', label: 'Old outside equipment' }), 'old equipment setup')
    h.resources.add(resource.id)
    const before = await h.raw('vendor_resources', 'id=$1', [resource.id])
    await control(async ({ client }) => {
      const q = queryable(client)
      // UPDATE first: it gets current xmin, but must not acquire a native INSERT birth witness.
      await client.query("update vendor_resources set label='Updated, not born',version=version+1 where id=$1", [resource.id])
      expect((await client.query<{ born: boolean }>("select legacy_calendar_bounds_inserted_in_transaction('vendor_resources',$1) born", [resource.id])).rows[0]!.born).toBe(false)
      const seed = { vendorIds: [a.id], actor: h.actorInput(a.owner) }
      expect((await nativeLocate(q, seed)).resources).not.toContain(resource.id)
      await prepareLegacyCalendarScope(q, seed)
      await expect(prepareLegacyCalendarScope(q, { vendorIds: [b.id], resourceIds: [resource.id], actor: h.actorInput(b.owner) }))
        .rejects.toMatchObject({ statusCode: 409, code: 'calendar_scope_changed' })
    })
    expect(await h.raw('vendor_resources', 'id=$1', [resource.id])).toEqual(before)
  })
  it('CS371-B03 a user genuinely born in this TX is still a forbidden new early account parent', async () => {
    const company = await h.company(), user = randomUUID(); h.users.add(user)
    await control(async ({ client }) => {
      const q = queryable(client)
      await prepareLegacyCalendarScope(q, { vendorIds: [company.id], actor: h.actorInput(company.owner) })
      await client.query("insert into users(id,phone,name) values($1,$2,'Owned late account parent')", [user, `+7${randomInt(1_000_000_000, 9_999_999_999)}`])
      await expect(prepareLegacyCalendarScope(q, { vendorIds: [company.id], extraAccountIds: [user] })).rejects.toMatchObject({ statusCode: 409 })
    })
    expect(await h.raw('users', 'id=$1', [user])).toEqual([])
  })
  it('CS371-B04 a genuinely new session cannot expand a prepared earlier principal set', async () => {
    const company = await h.company(), sid = randomUUID()
    await control(async ({ client }) => {
      const q = queryable(client)
      const prepared = await prepareLegacyCalendarScope(q, { vendorIds: [company.id], actor: h.actorInput(company.owner) })
      await client.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, company.owner.id, randomUUID()])
      await expect(prepared.assertCurrent()).rejects.toMatchObject({ statusCode: 409, code: 'calendar_scope_changed' })
    })
    expect(await h.raw('sessions', 'id=$1', [sid])).toEqual([])
  })
  it('CS371-B05 write-to-erase strongest-mode upgrade is rejected before late account UPDATE', async () => {
    const company = await h.company()
    await control(async ({ client }) => {
      const q = queryable(client)
      await prepareLegacyCalendarScope(q, { vendorIds: [company.id], mode: 'write' })
      await expect(prepareLegacyCalendarScope(q, { vendorIds: [company.id], mode: 'erase' })).rejects.toMatchObject({ statusCode: 409 })
    })
  })
  it('CS371-B06 an existing unrelated wedding cannot become a late earlier parent', async () => {
    const company = await h.company(), person = await h.actor(), wedding = await h.wedding(person)
    await control(async ({ client }) => {
      const q = queryable(client)
      await prepareLegacyCalendarScope(q, { vendorIds: [company.id] })
      await expect(prepareLegacyCalendarScope(q, { weddingIds: [wedding.id] })).rejects.toMatchObject({ statusCode: 409 })
    })
  })
  it('CS371-C01 the same actual client cannot reuse a previous transaction stamp', async () => {
    const a = await h.company(), b = await h.company()
    await control(async ({ client, pid }) => {
      const q = queryable(client), first = await prepareLegacyCalendarScope(q, { vendorIds: [a.id] })
      const xid1 = (await client.query<{ txid: string }>('select txid_current()::text txid')).rows[0]!.txid
      await client.query('commit'); await client.query('begin')
      const second = await prepareLegacyCalendarScope(q, { vendorIds: [b.id] })
      const xid2 = (await client.query<{ txid: string }>('select txid_current()::text txid')).rows[0]!.txid
      expect(xid2).not.toBe(xid1); expect(second.vendorIds).toContain(b.id)
      await expect(first.assertCurrent()).rejects.toMatchObject({ statusCode: 409 })
      trace('same-client-new-tx', { pid, xid1, xid2 })
    })
  })
  it('CS371-C02 distinct physical clients keep independent prepared prefixes', async () => {
    const a = await h.company(), b = await h.company()
    await control(async first => control(async second => {
      expect(first.pid).not.toBe(second.pid)
      const p1 = await prepareLegacyCalendarScope(queryable(first.client), { vendorIds: [a.id] })
      const p2 = await prepareLegacyCalendarScope(queryable(second.client), { vendorIds: [b.id] })
      expect(p1.vendorIds).toContain(a.id); expect(p1.vendorIds).not.toContain(b.id)
      expect(p2.vendorIds).toContain(b.id); expect(p2.vendorIds).not.toContain(a.id)
      await p1.assertCurrent(); await p2.assertCurrent()
    }))
  })

  it('CS371-W01 genuine activation waiting on the first wedding refuses a real new booked holder', async () => {
    const c = await h.cohort(), { id, view } = await currentAppProof(c)
    const seed = { sourceIds: [id], vendorIds: [c.company.id], actor: h.actorInput(c.company.owner) }
    const first = await firstWedding(seed)
    await control(async ({ client, pid }) => {
      await client.query('select id from weddings where id=$1 for update', [first])
      const action = launch(h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/activate', h.activation(view)))
      try {
        await waitFor(pid, action, 'activation-before-valid-holder')
        const slot = randomUUID()
        await client.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'decor','Actual late protected holder')", [slot, c.wedding])
        const context = await lockBookingContext(queryable(client), { weddingId: c.wedding, slotId: slot,
          actorId: c.pair.id, sessionId: c.pair.sid, policyVersion: POLICY })
        const deal = await bookVendor(queryable(client), context, { performer: { kind: 'catalog', vendorId: c.company.id }, price: 15000 })
        const expected = await boundFrame(id, queryable(client))
        await client.query('commit')
        const reply = succeeded(await action.completion)
        denied(reply, 409, 'calendar_scope_changed'); expect(await boundFrame(id)).toEqual(expected)
        expect((await h.db.query<{ state: string }>('select state from deals where id=$1', [deal])).rows[0]!.state).toBe('booked')
        trace('valid-holder-retained-activation-rolled-back', { source: id, deal })
      } finally { await releaseAndDrain(client, action) }
    })
  })
  it('CS371-W02 genuine activation waiting before a valid member acceptance refuses expanded person scope', async () => {
    const c = await h.cohort(), person = await h.actor(), i = await invitation(c.company, person)
    const { id, view } = await currentAppProof(c)
    const first = await firstWedding({ sourceIds: [id], vendorIds: [c.company.id], actor: h.actorInput(c.company.owner) })
    await control(async ({ client, pid }) => {
      await client.query('select id from weddings where id=$1 for update', [first])
      const action = launch(h.call(c.company.owner, 'POST', h.ownerUrl(c.company, id) + '/activate', h.activation(view)))
      try {
        await waitFor(pid, action, 'activation-before-valid-member')
        const member = await acceptStaffInvite(queryable(client), { token: i.token, actor: h.actorInput(person) })
        expect(member.userId).toBe(person.id); expect(member.state).toBe('active')
        const expected = await boundFrame(id, queryable(client)); await client.query('commit')
        denied(succeeded(await action.completion), 409, 'calendar_scope_changed')
        expect(await boundFrame(id)).toEqual(expected)
      } finally { await releaseAndDrain(client, action) }
    })
  })
  it('CS371-W03 reverse activation then member wait preserves accepted ranges and makes old narrowing stale', async () => {
    const c = await h.cohort(), ready = await h.ready(c.company), person = await h.actor(), i = await invitation(c.company, person)
    const { id, view, ids } = await allButLast(c)
    await control(async ({ client, pid }) => {
      await activateLegacyCalendarBounds(queryable(client), { vendorId: c.company.id, sourceId: id,
        actor: h.actorInput(c.company.owner), ...h.activation(view) })
      for (const source of ids) {
        const effect = (await client.query<{ effect: { freshness: string; state: string } }>('select legacy_calendar_bounds_current_effect($1) effect', [source])).rows[0]!.effect
        expect(effect.freshness).toBe('current'); expect(effect.state).toBe('finite')
      }
      const certificates = await h.raw('resource_occupancy_origin_certificates', 'vendor_identity=$1', [c.company.id], queryable(client))
      const ranges = await h.raw('resource_occupancy', 'vendor_identity=$1', [c.company.id], queryable(client))
      const action = launch(h.db.tx(q => acceptStaffInvite(q, { token: i.token, actor: h.actorInput(person) })))
      try {
        await waitFor(pid, action, 'member-after-actual-activation')
        await client.query('commit')
        expect(succeeded(await action.completion).state).toBe('active')
        expect((await h.editor(c.company, id)).source.freshness).toBe('stale')
        expect(await h.raw('resource_occupancy_origin_certificates', 'vendor_identity=$1', [c.company.id])).toEqual(certificates)
        expect(await h.raw('resource_occupancy', 'vendor_identity=$1', [c.company.id])).toEqual(ranges)
        denied(await h.commit(ready), 409, 'unresolved_legacy_obligations')
      } finally { await releaseAndDrain(client, action) }
    })
  })
  it('CS371-W04 shared-person new association before a waiting booking cannot create a second promise', async () => {
    const c = await h.cohort(), b = await h.company(), third = await h.company()
    const ready = await h.ready(b, 'person', '2027-07-01T08:30:00Z', '2027-07-01T09:30:00Z', c.company.owner)
    const i = await invitation(third, c.company.owner); await h.settleAll(c.company)
    const first = await firstWedding({ weddingIds: [ready.wedding], vendorIds: [b.id], personIds: [c.company.owner.id], actor: h.actorInput(ready.pair) })
    const before = await h.raw('resource_occupancy', "kind='person' and conflict_identity=$1", [c.company.owner.id])
    await control(async ({ client, pid }) => {
      await client.query('select id from weddings where id=$1 for update', [first])
      const action = launch(h.commit(ready))
      try {
        await waitFor(pid, action, 'booking-before-shared-person-association')
        const accepted = await acceptStaffInvite(queryable(client), { token: i.token, actor: h.actorInput(c.company.owner) })
        expect(accepted.state).toBe('active'); await client.query('commit')
        denied(succeeded(await action.completion), 409)
        expect((await h.db.query<{ n: number }>('select count(*)::int n from resource_allocations where deal_id=$1', [ready.deal])).rows[0]!.n).toBe(0)
        expect(await h.raw('resource_occupancy', "kind='person' and conflict_identity=$1", [c.company.owner.id])).toEqual(before)
      } finally { await releaseAndDrain(client, action) }
    })
  })
  it('CS371-W05 reverse actual booking then shared-person acceptance wait is a fresh refusal and retry preserves both origins', async () => {
    const c = await h.cohort(), b = await h.company(), third = await h.company()
    const ready = await h.ready(b, 'person', '2027-08-10T10:00:00Z', '2027-08-10T11:00:00Z', c.company.owner)
    const i = await invitation(third, c.company.owner); await h.settleAll(c.company)
    await control(async ({ client, pid }) => {
      await commitAgreedOrderResources(queryable(client), { weddingId: ready.wedding, dealId: ready.deal,
        actor: h.actorInput(ready.pair), ...ready.body } as CommitResourceInput)
      const action = launch(h.db.tx(q => acceptStaffInvite(q, { token: i.token, actor: h.actorInput(c.company.owner) })))
      try {
        await waitFor(pid, action, 'association-after-actual-disjoint-booking')
        await client.query('commit'); scopeRefused(await action.completion)
        const before = await h.raw('resource_occupancy', "kind='person' and conflict_identity=$1", [c.company.owner.id])
        expect((await h.db.query<{ n: number }>('select count(*)::int n from resource_allocations where deal_id=$1 and released_at is null', [ready.deal])).rows[0]!.n).toBe(1)
        const retry = await h.db.tx(q => acceptStaffInvite(q, { token: i.token, actor: h.actorInput(c.company.owner) }))
        expect(retry.state).toBe('active')
        expect(await h.raw('resource_occupancy', "kind='person' and conflict_identity=$1", [c.company.owner.id])).toEqual(before)
      } finally { await releaseAndDrain(client, action) }
    })
  })

  it.each(['left-first', 'right-first'] as const)('CS371-E01 two actual erasers in %s order serialize without SHARE-upgrade deadlock', async direction => {
    const { a, b } = await equalPeople(), people = [a.owner, b.owner], vendors = [a.id, b.id]
    const order = direction === 'left-first' ? [0, 1] : [1, 0], earliest = people.map(p => p.id).sort()[0]!
    await control(async blocker => control(async left => control(async right => {
      await blocker.client.query('select id from users where id=$1 for update', [earliest])
      async function erase(c: Control, person: Actor): Promise<void> {
        try {
          await prepareLegacyCalendarScope(queryable(c.client), { vendorIds: vendors, personIds: people.map(p => p.id),
            actor: h.actorInput(person), extraAccountIds: people.map(p => p.id), mode: 'erase' })
          await eraseUser(queryable(c.client), person.id)
          await c.client.query('commit')
        } catch (error) { await c.client.query('rollback').catch(() => undefined); throw error }
      }
      const workers = [left, right], actions = new Map<number, Action<void>>()
      trace('two-eraser-owned-schedule', { direction, blocker: blocker.pid, earliest,
        workers: workers.map((worker, index) => ({ pid: worker.pid, userId: people[index]!.id })) })
      for (const index of order) actions.set(index, launch(erase(workers[index]!, people[index]!)))
      try {
        await waitForTwo(blocker, [...actions.values()], `two-erasers-before-first-account-${direction}`, workers.map(w => w.pid))
        await blocker.client.query('commit')
        const outcomes = await Promise.all([actions.get(0)!.completion, actions.get(1)!.completion])
        expect(outcomes.filter(o => o.ok)).toHaveLength(1)
        expect(outcomes.filter(o => !o.ok)).toHaveLength(1)
        const loser = outcomes.findIndex(o => !o.ok), winner = 1 - loser
        scopeRefused(outcomes[loser]!) // 40P01/timeout is not an accepted serialization outcome.
        trace('two-eraser-native-outcome', { direction, winner: workers[winner]!.pid, retry: workers[loser]!.pid })
        expect(await h.raw('users', 'id=$1', [people[winner]!.id])).toEqual([])
        expect((await h.raw('users', 'id=$1', [people[loser]!.id])).length).toBe(1)
        await h.db.tx(async q => {
          await prepareLegacyCalendarScope(q, { vendorIds: vendors, personIds: people.map(p => p.id), extraAccountIds: people.map(p => p.id),
            actor: h.actorInput(people[loser]!), mode: 'erase' })
          await eraseUser(q, people[loser]!.id)
        })
        expect(await h.raw('users', 'id=any($1::uuid[])', [people.map(p => p.id)])).toEqual([])
        expect((await h.db.query<{ n: number }>("select count(*)::int n from resource_conflict_keys where kind='person' and identity=any($1::uuid[])", [people.map(p => p.id)])).rows[0]!.n).toBe(2)
      } finally {
        await blocker.client.query('rollback').catch(() => undefined)
        const drained = await Promise.all([...actions.values()].map(action => action.completion))
        trace('two-eraser-drained-after-control-diagnostic', drained.map(o => o.ok ? { ok: true } : {
          ok: false, code: (o.error as { code?: string })?.code ?? null, statusCode: (o.error as { statusCode?: number })?.statusCode ?? null }))
      }
    })))
  })
  it('CS371-N01 actual55P03 covers only the specifically requested NOWAIT vendor row', async () => {
    const company = await h.company()
    await control(async holder => {
      await holder.client.query('select id from vendors where id=$1 for update', [company.id])
      await control(async requester => {
        await expect(requester.client.query('select id from vendors where id=$1 for update nowait', [company.id])).rejects.toMatchObject({ code: '55P03' })
        trace('narrow-nowait-55P03', { holder: holder.pid, requester: requester.pid, table: 'vendors', id: company.id })
      })
    })
  })
  it('CS371-R01 a later counter-receipt permits unchanged retry but revoking a represented counterparty refuses cached readiness', async () => {
    const c = await h.cohort(), id = (await h.liveSources(c.company)).find(s => s.kind === 'app_day')?.id
    assert(id); await h.propose(c.company, id)
    function body(view: CalendarBoundsPrivateView) {
      assert(view.proposal && view.readToken)
      return { boundsVersionId: view.proposal.id, expectedVersion: view.proposal.version, digest: view.proposal.digest, readToken: view.readToken }
    }
    const url = h.holderUrl(c.wedding, c.deals[0]!, id) + '/accept'
    const customerBody = body(await h.read(c.pair, c.wedding, c.deals[0]!, id)), customerKey = randomUUID()
    const first = await h.call(c.pair, 'POST', url, customerBody, customerKey); ok(first, 'customer first real receipt')
    const performerBody = body(await h.read(c.company.owner, c.wedding, c.deals[0]!, id)), performerKey = randomUUID()
    const second = await h.call(c.company.owner, 'POST', url, performerBody, performerKey); ok(second, 'performer actual counter-receipt')
    const repeated = await h.call(c.pair, 'POST', url, customerBody, customerKey)
    expect(repeated.statusCode).toBe(200); expect(repeated.json()).toStrictEqual(first.json())
    await h.db.query('update sessions set revoked_at=clock_timestamp() where id=$1', [c.pair.sid])
    const before = await boundFrame(id)
    denied(await h.call(c.company.owner, 'POST', url, performerBody, performerKey), 409)
    expect(await boundFrame(id)).toEqual(before); expect(await h.effectCount(c.company)).toBe(0)
  })

  it('CS371-P01 valid owner A rejects actual cross-wedding source B before its foreign prefix and cache lookup', async () => {
    const a = await h.cohort(), b = await h.cohort()
    const own = (await h.liveSources(a.company)).find(s => s.kind === 'app_day')?.id
    const foreign = (await h.liveSources(b.company)).find(s => s.kind === 'app_day')?.id
    assert(own && foreign && own !== foreign); await h.editor(b.company, foreign)
    const view = await h.editor(a.company, own), body = { expectedSourceRevision: view.source.sourceRevision, expectedInventoryRevision: view.source.inventoryRevision }
    const key = randomUUID(), ownUrl = h.ownerUrl(a.company, own) + '/capture'
    const first = await h.call(a.company.owner, 'POST', ownUrl, body, key); ok(first, 'owned capture cache before owner opaque regression')
    await exerciseOpaque({ label: 'CS371-P01-owner-cross-wedding', actor: a.company.owner, seed: { sourceIds: [foreign],
      vendorIds: [a.company.id], weddingIds: [], actor: h.actorInput(a.company.owner) }, foreignSource: foreign,
      requestedWedding: null, requestedDeal: null, foreignWedding: b.wedding, foreignDeal: b.deals[0]!,
      gateTable: 'weddings', gateId: b.wedding, ownUrl, foreignUrl: h.ownerUrl(a.company, foreign) + '/capture', body, key, first })
  })
  it('CS371-P02 valid holder A rejects actual cross-wedding source B before its foreign prefix and cache lookup', async () => {
    const a = await h.cohort(), b = await h.cohort()
    const own = (await h.liveSources(a.company)).find(s => s.kind === 'app_day')?.id
    const foreign = (await h.liveSources(b.company)).find(s => s.kind === 'app_day')?.id
    assert(own && foreign && own !== foreign); await h.editor(b.company, foreign); await h.propose(a.company, own)
    const read = await h.read(a.pair, a.wedding, a.deals[0]!, own); assert(read.proposal && read.readToken)
    const body = { boundsVersionId: read.proposal.id, expectedVersion: read.proposal.version, digest: read.proposal.digest, readToken: read.readToken }
    const key = randomUUID(), ownUrl = h.holderUrl(a.wedding, a.deals[0]!, own) + '/accept'
    const first = await h.call(a.pair, 'POST', ownUrl, body, key); ok(first, 'owned receipt cache before holder opaque regression')
    await exerciseOpaque({ label: 'CS371-P02-holder-cross-wedding', actor: a.pair, seed: { sourceIds: [foreign],
      vendorIds: [], weddingIds: [a.wedding], actor: h.actorInput(a.pair) }, foreignSource: foreign,
      requestedWedding: a.wedding, requestedDeal: a.deals[0]!, foreignWedding: b.wedding, foreignDeal: b.deals[0]!,
      gateTable: 'weddings', gateId: b.wedding, ownUrl, foreignUrl: h.holderUrl(a.wedding, a.deals[0]!, foreign) + '/accept', body, key, first })
  })
  it('CS371-P03 same vendor and wedding never authorize holder A to another actual app-root B', async () => {
    const c = await h.cohort(), dealA = c.deals[0]!, dealB = c.deals[1]!
    const roots = (await h.db.query<{ id: string; root_deal_id: string }>(`select s.id::text,s.root_deal_id::text from legacy_calendar_sources s
      where s.vendor_id=$1 and s.wedding_id=$2 and s.kind='app_root' and legacy_calendar_present(s) order by s.root_deal_id`, [c.company.id, c.wedding])).rows
    const own = roots.find(s => s.root_deal_id === dealA)?.id, foreign = roots.find(s => s.root_deal_id === dealB)?.id
    assert(own && foreign && own !== foreign)
    const other = await h.propose(c.company, foreign); assert(other.editor)
    expect(other.editor.holders.map(x => x.dealId)).toEqual([dealB])
    expect((await h.db.query<{ n: number }>('select count(*)::int n from legacy_calendar_bounds_holders where source_id=$1 and wedding_id=$2 and deal_id=$3',
      [foreign, c.wedding, dealA])).rows[0]!.n).toBe(0)
    await h.read(c.pair, c.wedding, dealB, foreign) // real actor access is valid on B's actual own URL
    await h.propose(c.company, own)
    const read = await h.read(c.pair, c.wedding, dealA, own); assert(read.proposal && read.readToken)
    const body = { boundsVersionId: read.proposal.id, expectedVersion: read.proposal.version, digest: read.proposal.digest, readToken: read.readToken }
    const key = randomUUID(), ownUrl = h.holderUrl(c.wedding, dealA, own) + '/accept'
    const first = await h.call(c.pair, 'POST', ownUrl, body, key); ok(first, 'owned receipt cache before exact-affinity regression')
    await exerciseOpaque({ label: 'CS371-P03-exact-root-affinity', actor: c.pair, seed: { sourceIds: [foreign],
      vendorIds: [], weddingIds: [c.wedding], actor: h.actorInput(c.pair) }, foreignSource: foreign,
      requestedWedding: c.wedding, requestedDeal: dealA, foreignWedding: c.wedding, foreignDeal: dealB,
      gateTable: 'deals', gateId: dealB, ownUrl, foreignUrl: h.holderUrl(c.wedding, dealA, foreign) + '/accept', body, key, first })
  })
  it('CS371-G01 valid A GET list refuses foreign wedding B before its actual held wedding SHARE', async () => {
    await exerciseOpaqueGet('list')
  })
  it('CS371-G02 valid A GET detail refuses foreign wedding B before its actual held wedding SHARE', async () => {
    await exerciseOpaqueGet('detail')
  })
})
