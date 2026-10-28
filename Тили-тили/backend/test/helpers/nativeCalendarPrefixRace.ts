import assert from 'node:assert/strict'
import type { QueryResultRow } from 'pg'
import type { Db, Queryable } from '../../src/plugins/db.js'

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
interface Identity extends QueryResultRow { pid: number; backend_start: string; xact_start: string; txid: string; database: string; principal: string }
export interface NativeCalendarWaitRow extends QueryResultRow {
  pid: number; backend_start: string; xact_start: string; datname: string; usename: string
  state: string; wait_event_type: string | null; query: string; blockers: number[]
  holder_pid: number; holder_backend_start: string; holder_xact_start: string | null
  holder_datname: string; holder_usename: string; holder_state: string; observed_at: string
}
interface Proof { holder: Identity; worker: Identity; observer: Identity; activity: NativeCalendarWaitRow; observedMs: number; deadlineMs: number }
const PREFIX = 'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope'
const reflect = <T>(task: Promise<T>): Promise<Outcome<T>> => task.then(
  value => ({ status: 'fulfilled', value } as const), reason => ({ status: 'rejected', reason } as const))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function until<T>(task: Promise<T>, deadline: number): Promise<T> {
  const left = deadline - performance.now(); assert(left > 0, 'Native calendar wait deadline expired')
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([task, new Promise<never>((_yes, no) => {
    timer = setTimeout(() => no(new Error('Native calendar wait deadline expired')), left)
  })]) } finally { if (timer !== undefined) clearTimeout(timer) }
}
async function ready<T>(signal: Promise<T>, tasks: Promise<Outcome<unknown>>[], deadline: number): Promise<T> {
  const choice = await until(Promise.race([signal.then(value => ({ kind: 'ready' as const, value })),
    ...tasks.map(task => task.then(outcome => ({ kind: 'settled' as const, outcome })))]), deadline)
  if (choice.kind === 'ready') return choice.value
  if (choice.outcome.status === 'rejected') throw choice.outcome.reason
  throw new Error('Native calendar task completed before its readiness signal')
}
async function identity(c: Queryable): Promise<Identity> {
  const rows = (await c.query<Identity>(`select pg_backend_pid() pid,current_database() database,current_user principal,txid_current()::text txid,
    a.backend_start::text backend_start,a.xact_start::text xact_start from pg_stat_activity a where a.pid=pg_backend_pid()`)).rows
  assert.equal(rows.length, 1); const row = rows[0]!
  assert(Number.isSafeInteger(row.pid) && row.pid > 0 && row.backend_start && row.xact_start && /^[0-9]+$/.test(row.txid))
  return row
}
/** One real lock race. The caller's literal observer SQL executes on the third physical client. */
export async function runNativeCalendarPrefixRace<T>(db: Db, scope: { weddingId: string; dealId: string; caseName: string },
  lock: (c: Queryable) => Promise<unknown>, invalidate: (c: Queryable) => Promise<unknown>, work: (c: Queryable) => Promise<T>,
  observe: (c: Queryable, holder: Identity, worker: Identity) => Promise<NativeCalendarWaitRow[]>,
): Promise<{ worker: Outcome<T>; witness: Proof; mutationCommitted: true }> {
  const holderReady = deferred<Identity>(), workerReady = deferred<Identity>(), decision = deferred<boolean>()
  let decided = false, invalidationCompleted = false
  const release = (mutate: boolean) => { if (!decided) { decided = true; decision.resolve(mutate) } }
  const holder = reflect(db.tx(async c => {
    const current = await identity(c); await lock(c)
    const held = await c.query<{ id: string }>('select id from weddings where id=$1 for update', [scope.weddingId])
    assert.deepEqual(held.rows, [{ id: scope.weddingId }]); holderReady.resolve(current)
    if (await decision.promise) { await invalidate(c); invalidationCompleted = true }
  }))
  let worker: Promise<Outcome<T>> | undefined, observer: Promise<Outcome<Proof>> | undefined
  let failure: { error: unknown } | undefined, result: { worker: Outcome<T>; witness: Proof; mutationCommitted: true } | undefined
  try {
    const h = await ready(holderReady.promise, [holder], performance.now() + 6_000)
    // This ONE deadline covers worker PID setup AND wait observation while the holder is idle.
    const deadline = performance.now() + 6_000
    worker = reflect(db.tx(async c => { const current = await identity(c); workerReady.resolve(current); return work(c) }))
    const w = await ready(workerReady.promise, [worker, holder], deadline)
    assert.notEqual(h.pid, w.pid); assert.equal(w.database, h.database); assert.equal(w.principal, h.principal)
    observer = reflect(db.tx(async c => {
      await c.query("set local statement_timeout='1000ms'")
      const o = await identity(c); assert(![h.pid,w.pid].includes(o.pid))
      assert.equal(o.database, h.database); assert.equal(o.principal, h.principal)
      while (performance.now() < deadline) {
        await c.query('select pg_stat_clear_snapshot()')
        const rows = await observe(c, h, w); assert.equal(rows.length, 1); const row = rows[0]!
        assert.equal(row.pid, w.pid); assert.equal(row.backend_start, w.backend_start); assert.equal(row.xact_start, w.xact_start)
        assert.equal(row.datname, w.database); assert.equal(row.usename, w.principal)
        assert.equal(row.holder_pid, h.pid); assert.equal(row.holder_backend_start, h.backend_start); assert.equal(row.holder_xact_start, h.xact_start)
        assert.equal(row.holder_datname, h.database); assert.equal(row.holder_usename, h.principal)
        const observedMs = performance.now()
        if (row.state === 'active' && row.wait_event_type === 'Lock' && row.blockers.includes(h.pid)
          && row.holder_state === 'idle in transaction' && row.query.trim().replace(/\s+/g, ' ') === PREFIX) {
          assert(observedMs < deadline, 'Actual witness must precede the single deadline')
          return { holder: h, worker: w, observer: o, activity: row, observedMs, deadlineMs: deadline }
        }
        await new Promise<void>(yes => setTimeout(yes, Math.min(25, Math.max(1, deadline - performance.now()))))
      }
      throw new Error('No actual closed calendar prefix wait before deadline')
    }))
    const choice = await until(Promise.race([
      observer.then(outcome => ({ kind: 'observer' as const, outcome })),
      worker.then(outcome => ({ kind: 'worker' as const, outcome })),
      holder.then(outcome => ({ kind: 'holder' as const, outcome })),
    ]), deadline)
    if (choice.kind !== 'observer') {
      if (choice.outcome.status === 'rejected') throw choice.outcome.reason
      throw new Error('Native race task completed before a lock witness')
    }
    if (choice.outcome.status === 'rejected') throw choice.outcome.reason
    const witness = choice.outcome.value
    assert(performance.now() < deadline)
    process.stdout.write('LEGACY_CALENDAR_NATIVE_WAIT_WITNESS ' + JSON.stringify({ ...scope, ...witness, phase: 'before_invalidation' }) + '\n')
    release(true)
    const held = await holder; if (held.status === 'rejected') throw held.reason
    assert(invalidationCompleted, 'The original invalidation must finish and holder TX must COMMIT')
    process.stdout.write('LEGACY_CALENDAR_INVALIDATION_COMMITTED ' + JSON.stringify({ ...scope, holder: h, worker: w, observedAt: witness.activity.observed_at }) + '\n')
    result = { worker: await worker, witness, mutationCommitted: true }
  } catch (error) { failure = { error } } finally {
    release(false)
    const tasks: Array<{ label: string; task: Promise<Outcome<unknown>> }> = [{ label: 'holder', task: holder }]
    if (worker) tasks.push({ label: 'worker', task: worker })
    if (observer) tasks.push({ label: 'observer', task: observer })
    const settled = await Promise.all(tasks.map(async x => ({ label: x.label, outcome: await x.task })))
    const secondary = settled.flatMap(x => x.outcome.status === 'rejected' && (x.label !== 'worker' || failure)
      && x.outcome.reason !== failure?.error ? [x.outcome.reason] : [])
    if (secondary.length) failure = { error: new AggregateError(failure ? [failure.error, ...secondary] : secondary,
      'Native calendar race or cleanup failed', failure ? { cause: failure.error } : undefined) }
  }
  if (failure) throw failure.error
  assert(result); return result
}

export type NativeCalendarHttpIdentity = Identity
interface HttpObservation {
  holder: Identity; workers: Identity[]; observer: Identity; activity: NativeCalendarWaitRow[]
  paths: number[][]; observedMs: number; deadlineMs: number
}
/** Observation only: HTTP keeps the real Db object, original this and unchanged transaction client. */
export async function runNativeCalendarHttpPrefixRace<T>(db: Db,
  scope: { weddingId: string; dealId?: string; caseName: string },
  lockBeforeWorker: (c: Queryable) => Promise<unknown>, invalidate: ((c: Queryable) => Promise<unknown>) | null,
  commands: readonly { label: string; start: () => PromiseLike<T> }[],
  observe: (c: Queryable, holder: Identity, workers: readonly Identity[]) => Promise<NativeCalendarWaitRow[]>,
): Promise<{ replies: T[]; witnesses: HttpObservation[]; mutationCommitted: boolean }> {
  assert(commands.length === 1 || commands.length === 2)
  const original = db.tx, invoke: Db['tx'] = original.bind(db)
  const heldReady = deferred<Identity>(), decision = deferred<boolean>()
  const tasks: Promise<Outcome<T>>[] = [], ended: (Outcome<T> | undefined)[] = [], workers: Identity[] = [], witnesses: HttpObservation[] = []
  let holderEnded: Outcome<unknown> | undefined
  let decided = false, installed = false, mutationCompleted = false
  let armed: ReturnType<typeof deferred<Identity>> | undefined, captures = 0
  const release = (mutate: boolean) => { if (!decided) { decided = true; decision.resolve(mutate) } }
  const delegate: Db['tx'] = <R>(body: (c: Queryable) => Promise<R>): Promise<R> => invoke<R>(async c => {
    const signal = armed; assert(signal, 'Only the armed HTTP transaction may use this observation')
    armed = undefined; captures++
    signal.resolve(await identity(c))
    return body(c) // no query wrapper, alternate client, SQL/result/auth/error replacement
  })
  const holder = reflect(invoke(async c => {
    const h = await identity(c); await lockBeforeWorker(c); heldReady.resolve(h)
    if (await decision.promise) {
      if (invalidate) { await invalidate(c); mutationCompleted = true }
    }
  })).then(outcome => { holderEnded = outcome; return outcome })
  let observer: Promise<Outcome<{ replies: T[]; witnesses: HttpObservation[]; mutationCommitted: boolean }>> | undefined
  let result: { replies: T[]; witnesses: HttpObservation[]; mutationCommitted: boolean } | undefined
  let failure: { error: unknown } | undefined
  try {
    const h = await ready(heldReady.promise, [holder], performance.now() + 5_000)
    // The existing 5s budget covers HTTP worker identity setup and all live queue witnesses.
    const deadline = performance.now() + 5_000
    observer = reflect(invoke(async c => {
      await c.query("set local statement_timeout='1000ms'")
      const o = await identity(c); assert.notEqual(o.pid, h.pid)
      assert.equal(o.database, h.database); assert.equal(o.principal, h.principal)
      db.tx = delegate; installed = true
      for (const command of commands) {
        const signal = deferred<Identity>(); armed = signal
        const index = tasks.length
        const task = reflect(Promise.resolve(command.start())).then(outcome => { ended[index] = outcome; return outcome }); tasks.push(task)
        const w = await ready(signal.promise, [holder, ...tasks], deadline)
        workers.push(w)
        assert.equal(captures, workers.length)
        assert(![h.pid, o.pid, ...workers.slice(0, -1).map(x => x.pid)].includes(w.pid))
        assert.equal(w.database, h.database); assert.equal(w.principal, h.principal)
        let witness: HttpObservation | undefined
        while (performance.now() < deadline) {
          const early = holderEnded ?? ended.find(outcome => outcome !== undefined)
          if (early) {
            if (early.status === 'rejected') throw early.reason
            throw new Error('HTTP or holder completed before its actual prefix wait')
          }
          await c.query('select pg_stat_clear_snapshot()')
          const rows = await observe(c, h, workers)
          assert.equal(rows.length, workers.length, 'Every known HTTP backend must still exist')
          for (const current of workers) {
            const row = rows.find(x => x.pid === current.pid); assert(row)
            assert.equal(row.backend_start, current.backend_start); assert.equal(row.xact_start, current.xact_start)
            assert.equal(row.datname, current.database); assert.equal(row.usename, current.principal)
            assert.equal(row.holder_pid, h.pid); assert.equal(row.holder_backend_start, h.backend_start)
            assert.equal(row.holder_xact_start, h.xact_start); assert.equal(row.holder_datname, h.database)
            assert.equal(row.holder_usename, h.principal)
          }
          const known = new Set([h.pid, ...workers.map(x => x.pid)])
          const closed = rows.every(row => row.state === 'active' && row.wait_event_type === 'Lock'
            && row.holder_state === 'idle in transaction' && row.query.trim().replace(/\s+/g, ' ') === PREFIX
            && row.blockers.length > 0 && row.blockers.every(pid => known.has(pid) && pid !== row.pid))
          const first = rows.find(x => x.pid === workers[0]!.pid)!
          const paths = [[first.pid, h.pid]]
          let queued = closed && first.blockers.includes(h.pid)
          if (workers.length === 2) {
            const second = rows.find(x => x.pid === workers[1]!.pid)!
            queued = queued && second.blockers.includes(first.pid) && !first.blockers.includes(second.pid)
            paths.push([second.pid, first.pid, h.pid])
          }
          if (queued) { witness = { holder: h, workers: [...workers], observer: o, activity: rows, paths,
            observedMs: performance.now(), deadlineMs: deadline }; break }
          await new Promise<void>(yes => setTimeout(yes, Math.min(25, Math.max(1, deadline - performance.now()))))
        }
        assert(witness && witness.observedMs < deadline, 'No actual closed HTTP calendar-prefix path before existing 5s deadline')
        witnesses.push(witness)
        process.stdout.write('LEGACY_CALENDAR_HTTP_NATIVE_WAIT ' + JSON.stringify({ ...scope, command: command.label, ...witness }) + '\n')
      }
      release(true)
      const held = await holder; if (held.status === 'rejected') throw held.reason
      assert.equal(mutationCompleted, invalidate !== null)
      const replies: T[] = []
      for (const task of tasks) { const outcome = await task; if (outcome.status === 'rejected') throw outcome.reason; replies.push(outcome.value) }
      return { replies, witnesses, mutationCommitted: mutationCompleted }
    }))
    const observed = await observer; if (observed.status === 'rejected') throw observed.reason
    result = observed.value
  } catch (error) { failure = { error } } finally {
    release(false)
    const outcomes = await Promise.all([holder, ...(observer ? [observer] : []), ...tasks])
    const secondary = outcomes.flatMap(x => x.status === 'rejected' && x.reason !== failure?.error ? [x.reason] : [])
    if (installed) {
      if (db.tx !== delegate) secondary.push(new Error('Owned HTTP Db.tx observation changed unexpectedly'))
      db.tx = original
    }
    if (secondary.length) failure = { error: new AggregateError(failure ? [failure.error, ...secondary] : secondary,
      'HTTP calendar race or cleanup failed', failure ? { cause: failure.error } : undefined) }
  }
  if (failure) throw failure.error
  assert(result); return result
}
