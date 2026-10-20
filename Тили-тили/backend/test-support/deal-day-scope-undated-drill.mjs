// Native preserving drill only. Synthetic storage transitions are not public
// booking/financial policy, availability authority, or a production admission.
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const NAME = '1763860000000_deal_day_scope_undated_terminal'
const SHA = '91633bbdc3bc20e15573a0bc7304115c386cb9baacce7f907f4137164a54bbcc'
const NAMES = ['deal_day_scope_matches_current', 'deal_day_scope_shape_valid', 'protect_deal_day_scope_version']
const V = 'deal_day_scope_versions', H = 'deal_day_scope_heads'
const columns = ['id', 'wedding_id', 'deal_id', 'slot_id', 'schema_version', 'revision', 'previous_version_id', 'origin_knowledge',
  'operation', 'context_kind', 'event_id', 'performer_kind', 'vendor_id', 'binding_state', 'service_date', 'time_zone', 'day_id']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const clone = value => structuredClone(value)
const ordered = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
async function bounded(promise, milliseconds) {
  let timer
  try { return await Promise.race([promise.then(value => ({ value })), new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), milliseconds)
  })]) } finally { clearTimeout(timer) }
}
function nativeDatabaseError(stderr) {
  // db.js echoes the entire failing SQL before bin/node-pg-migrate.js prints
  // the original Error. Only the final Error+stack+own-property block is an
  // error oracle; SQL literals (including RAISE text/codes) are not evidence.
  const headers = [...stderr.matchAll(/^error: ([^\r\n]+)\r?$/gm)]
  assert(headers.length > 0, 'Native PostgreSQL Error header required')
  const last = headers.at(-1), block = stderr.slice(last.index)
  const properties = / \{\r?\n([\s\S]*)\r?\n\}\s*$/.exec(block)
  assert(properties && /\r?\n {4}at /.test(block.slice(0, properties.index)), 'Native Error stack/property boundary required')
  const field = (name, pattern) => {
    const found = [...properties[1].matchAll(new RegExp(`^  ${name}: (${pattern}),?\\r?$`, 'gm'))]
    assert.equal(found.length, 1, `Exactly one native Error.${name} property required`)
    return found[0][1]
  }
  const code = field('code', "'[A-Z0-9]{5}'").slice(1, -1)
  const severity = field('severity', "'[A-Z]+'").slice(1, -1)
  const constraintLiteral = field('constraint', "undefined|null|'[^'\\r\\n]*'")
  return { name: 'error', message: last[1], code, severity,
    constraint: ['undefined', 'null'].includes(constraintLiteral) ? null : constraintLiteral.slice(1, -1), constraintLiteral }
}

export async function runUndatedDayScopeCycle(c) {
  const { db, write, migrate, fr018State, assertJournal, manifest, migrationsDir, backend, cli,
    databaseUrl, selectedPort, pg, ownedPids, registerOwnedConnection } = c
  const primary = { query: (sql, values) => write(sql, values) }
  const helperPath = fileURLToPath(import.meta.url), helperSHA = digest(readFileSync(helperPath))
  assert(lstatSync(helperPath).isFile() && !lstatSync(helperPath).isSymbolicLink())
  const sourcePath = resolve(migrationsDir, `${NAME}.cjs`)
  const seal = () => {
    assert(lstatSync(sourcePath).isFile() && !lstatSync(sourcePath).isSymbolicLink())
    const source = readFileSync(sourcePath)
    assert.equal(digest(source), SHA)
    return source.toString('utf8')
  }
  // Text extraction, never import/evaluate the migration or derive expected
  // SQL from the live database. The exact literal up contains only three CORs.
  const source = seal(), halves = source.split('exports.down = pgm => {')
  assert.equal(halves.length, 2)
  const definitions = part => [...part.matchAll(/create or replace function (\w+)\([^]*?\bas \$\$([^]*?)\$\$;/g)]
  const up = definitions(halves[0]), down = definitions(halves[1])
  assert.deepEqual(up.map(x => x[1]).sort(), NAMES); assert.deepEqual(down.map(x => x[1]).sort(), NAMES)
  const bodies = new Map(up.map(x => [x[1], x[2]])), oldBodies = new Map(down.map(x => [x[1], x[2]]))
  const prefix87 = manifest.filter(x => Number(x.name.slice(0, 13)) < 1763860000000).map(x => x.name)
  assert.equal(prefix87.length, 87); assert.equal(manifest.length, 88)
  await assertJournal(prefix87)

  const functions = async () => (await db.query(`select p.oid::text, p.proname,
    pg_get_function_identity_arguments(p.oid) arguments,p.prosrc,p.provolatile,p.prosecdef,p.proleakproof,
    p.proisstrict,p.proretset,p.proparallel,p.proconfig,p.prokind,p.procost,p.prorows,
    p.prosupport::regproc::text support,p.prorettype::regtype::text result,l.lanname,
    pg_get_userbyid(p.proowner) owner,p.proacl,obj_description(p.oid,'pg_proc') comment
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows
  const booleans = async () => (await db.query(`select id::text,deal_day_scope_shape_valid(v) shape,
    deal_day_scope_matches_current(v) current from deal_day_scope_versions v order by id`)).rows
  const inherits = async () => (await db.query(`select i.inhrelid::text child_oid,i.inhparent::text parent_oid,
    i.inhseqno,i.inhdetachpending,n.nspname child_schema,c.relname child,pn.nspname parent_schema,p.relname parent
    from pg_inherits i join pg_class c on c.oid=i.inhrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_class p on p.oid=i.inhparent join pg_namespace pn on pn.oid=p.relnamespace
    where n.nspname='public' or pn.nspname='public' order by i.inhrelid,i.inhparent,i.inhseqno`)).rows
  const transaction = async (client, fn) => {
    await client.query('begin')
    try { const value = await fn(client); await client.query('commit'); return value }
    // An aborted transaction cannot run safety's read queries before ROLLBACK.
    catch (error) { await (client === primary ? db : client).query('rollback'); throw error }
  }
  const insert = (client, v) => client.query(`insert into ${V}(${columns.join(',')}) values(${columns.map((_, i) => `$${i + 1}`).join(',')})`, columns.map(k => v[k]))
  const head = (client, v) => client.query(`insert into ${H}(deal_id,wedding_id,revision,current_version_id) values($1,$2,$3,$4)`, [v.deal_id, v.wedding_id, v.revision, v.id])
  const advance = (client, v) => client.query(`update ${H} set revision=$2,current_version_id=$3 where deal_id=$1`, [v.deal_id, v.revision, v.id])
  const next = (v, binding = v.binding_state) => ({ ...v, id: randomUUID(), revision: String(BigInt(v.revision) + 1n),
    previous_version_id: v.id, origin_knowledge: null, operation: 'retain_done', binding_state: binding })
  async function seed(date) {
    const f = Object.fromEntries(['owner', 'company', 'wedding', 'vendor', 'slot', 'deal'].map(k => [k, randomUUID()]))
    await transaction(primary, async client => {
      for (const id of [f.owner, f.company]) await client.query("insert into users(id,phone,name) values($1,$2,'Synthetic undated drill actor')",
        [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])
      await client.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic undated drill studio',now())", [f.vendor, f.company])
      await client.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic undated drill',$3,$4,$5)", [f.wedding, f.owner, date, date ? 'Europe/Moscow' : null, randomUUID()])
      await client.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.wedding, f.owner])
      await client.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Synthetic undated drill position')", [f.slot, f.wedding])
      await client.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'booked',17000)", [f.deal, f.wedding, f.slot, f.vendor])
      await client.query('update slots set deal_id=$2 where id=$1', [f.slot, f.deal])
      f.event = (await client.query('select id from wedding_events where wedding_id=$1 and is_main', [f.wedding])).rows[0].id
      f.day = date ? (await client.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3) returning id", [f.vendor, date, f.deal])).rows[0].id : null
      f.first = { id: randomUUID(), wedding_id: f.wedding, deal_id: f.deal, slot_id: f.slot, schema_version: 1, revision: '1', previous_version_id: null,
        origin_knowledge: 'legacy_unknown', operation: 'observe', context_kind: 'implicit_main', event_id: f.event,
        performer_kind: 'catalog', vendor_id: f.vendor, binding_state: date ? 'active' : 'undated', service_date: date,
        time_zone: date ? 'Europe/Moscow' : null, day_id: f.day }
      await insert(client, f.first); await head(client, f.first)
    })
    return f
  }
  const undated = await seed(null), dated = await seed('2031-07-09')
  const before = await fr018State(), oldFunctions = await functions(), oldBooleans = await booleans(), oldInherits = await inherits()
  assert.equal(Object.keys(before.snapshot.data).length, 107)
  const oldJournal = before.snapshot.data.pgmigrations
  for (const name of NAMES) {
    const rows = oldFunctions.filter(x => x.proname === name)
    assert.equal(rows.length, 1); assert.equal(rows[0].prosrc, oldBodies.get(name), `${name}: literal down must restore exact87 body`)
  }
  async function installed() {
    seal()
    const after = await fr018State(), metadata = await functions()
    const expectedMetadata = clone(oldFunctions)
    for (const row of expectedMetadata) if (bodies.has(row.proname)) row.prosrc = bodies.get(row.proname)
    assert.deepEqual(metadata, expectedMetadata, 'Every public function OID/owner/ACL/config/security/volatility/signature remains; only three exact literal bodies change')
    const expected = clone(before), observedJournal = after.snapshot.data.pgmigrations
    const added = observedJournal.filter(x => x.name === NAME)
    assert.equal(added.length, 1); assert(Number.isSafeInteger(added[0].id) && added[0].id > 0)
    assert.deepEqual(Object.keys(added[0]).sort(), ['id', 'name', 'run_on'])
    assert(Number.isFinite(Date.parse(added[0].run_on)))
    assert.deepEqual(observedJournal.filter(x => x.name !== NAME), oldJournal, 'All87 journal rows retain every field')
    expected.snapshot.data.pgmigrations = observedJournal
    for (const row of expected.snapshot.schema.functions) if (bodies.has(row.proname)) {
      const old = oldBodies.get(row.proname); assert.equal(row.definition.split(old).length, 2)
      row.definition = row.definition.replace(old, bodies.get(row.proname))
    }
    assert.deepEqual(after, expected, 'Only validated own88 journal and exact three function definitions may differ across all107 rows/catalog/OIDs/attributes')
    assert.deepEqual(await booleans(), oldBooleans, 'All prior history shape/current booleans remain literally equal')
    assert.deepEqual(await inherits(), oldInherits)
    await assertJournal(manifest.map(x => x.name))
    return after
  }
  await migrate('up', 1763860000000); const firstUp = await installed()
  await migrate('up', 1763860000000); assert.deepEqual(await fr018State(), firstUp); await installed()
  await migrate('down', NAME, undefined, true)
  assert.deepEqual(await fr018State(), before); assert.deepEqual(await functions(), oldFunctions); assert.deepEqual(await booleans(), oldBooleans); assert.deepEqual(await inherits(), oldInherits)
  await assertJournal(prefix87)
  await migrate('up', 1763860000000); await installed()

  // Only explicit known synthetic root state, one append, and its one head
  // may change. Validate the complete new row before projecting it away.
  async function appendWitness(previous, f, v, rootState, operation) {
    const after = await fr018State(), expected = clone(previous), data = after.snapshot.data
    const version = data[V].filter(x => x.id === v.id)
    assert.equal(version.length, 1)
    const { recorded_at, ...fields } = version[0]
    assert(Number.isFinite(Date.parse(recorded_at)))
    assert.deepEqual(fields, { ...v, revision: Number(v.revision) })
    const priorVersions = previous.snapshot.data[V]
    assert.deepEqual(ordered(data[V].filter(x => x.id !== v.id)), ordered(priorVersions), 'All historical versions remain byte/value exact')
    const headRow = data[H].filter(x => x.deal_id === f.deal)
    assert.deepEqual(headRow, [{ deal_id: f.deal, wedding_id: f.wedding, revision: Number(v.revision), current_version_id: v.id }])
    assert.deepEqual(ordered(data[H].filter(x => x.deal_id !== f.deal)), ordered(previous.snapshot.data[H].filter(x => x.deal_id !== f.deal)))
    expected.snapshot.data[V] = data[V]; expected.snapshot.data[H] = data[H]
    if (rootState) {
      const root = expected.snapshot.data.deals.find(x => x.id === f.deal); assert(root); root.state = rootState
    }
    assert.deepEqual(after, expected, `${operation}: exact107-table preservation outside the known root state/append/head; no financial, DATE, inventory, order, receipt or audit mutation`)
    const bool = (await booleans()).find(x => x.id === v.id)
    assert.deepEqual(bool, { id: v.id, shape: true, current: true })
    return after
  }
  async function append(f, v, state) {
    const previous = await fr018State()
    await transaction(primary, async client => {
      if (state) await client.query('update deals set state=$2 where id=$1', [f.deal, state])
      await insert(client, v); await advance(client, v); await client.query('select 1')
    })
    return appendWitness(previous, f, v, state, 'actual outer COMMIT')
  }
  let refusals = 0
  async function refused(constraint, fn, atCommit = false) {
    const previous = await fr018State(); let error, callbackCompleted = false
    try { await transaction(primary, async client => { await fn(client); await client.query('select 1'); callbackCompleted = true }) }
    catch (caught) { error = caught }
    assert(error); assert.equal(error.code, '23514'); assert.equal(error.constraint, constraint)
    assert.equal(callbackCompleted, atCommit); assert.deepEqual(await fr018State(), previous)
    refusals++; process.stdout.write(`UNDATED_SQL_REFUSAL ${JSON.stringify({ constraint, atCommit, callbackCompleted, code: error.code })}\n`)
  }
  // A real held writer precedes down. Do not read table snapshots while an
  // ACCESS EXCLUSIVE waiter is queued: only pg_stat_activity/pg_locks witness.
  const pending = next(undated.first, 'done_undated'), beforeConcurrent = await fr018State()
  const writer = new pg.Client({ connectionString: databaseUrl, statement_timeout: 20_000, connectionTimeoutMillis: 5_000 })
  const writerErrors = []; writer.on('error', error => { writerErrors.push({ code: error.code ?? null, name: error.name }) })
  let writerPID, child, childClosed, output = '', overflow = false, nativeError, forced = false, waitWitness, closed = false, childIdentity, nativeResult, rawEmitted = false, concurrentFailure
  const streams = { stdout: { chunks: [], ended: false }, stderr: { chunks: [], ended: false } }
  const emitNativeRaw = () => {
    const stdout = Buffer.concat(streams.stdout.chunks), stderr = Buffer.concat(streams.stderr.chunks)
    let databaseError = null, parseError = null
    try { databaseError = nativeDatabaseError(stderr.toString('utf8')) } catch (error) { parseError = { name: error.name, code: error.code ?? null, message: error.message } }
    const observed = { child: childIdentity ?? null, writerPID: writerPID ?? null, waitWitness: waitWitness ?? null,
      native: nativeResult ?? null, forced, overflow, closed, databaseError, parseError,
      nativeError: nativeError ? { name: nativeError.name, code: nativeError.code ?? null } : null,
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutBytes: stdout.length, stderrBytes: stderr.length,
      stdoutSHA256: digest(stdout), stderrSHA256: digest(stderr), stdoutEOF: streams.stdout.ended, stderrEOF: streams.stderr.ended,
      incompleteHashesAreObservedPrefixesOnly: overflow || !closed || !streams.stdout.ended || !streams.stderr.ended }
    process.stdout.write(`UNDATED_NATIVE_DOWN_RESULT ${JSON.stringify(observed)}\n`); rawEmitted = true
    return observed
  }
  const closeConcurrent = async priorFailure => {
    const errors = priorFailure ? [priorFailure.error] : []
    try { if (writerPID) await writer.query('rollback') } catch (error) { errors.push(error) }
    try {
      const end = writer.end()
      const ended = await bounded(end, 5_000)
      if (ended.timedOut) { writer.connection?.stream?.destroy(); throw new Error('Owned writer end deadline; forced socket close is not acceptance') }
      if (writerPID) ownedPids.delete(writerPID)
      assert.deepEqual(writerErrors, [], 'All owned client errors remain fatal')
    } catch (error) { errors.push(error) }
    try {
      if (child && !closed) {
        const done = await bounded(childClosed, 7_000)
        if (done.timedOut) {
          forced = true; child.kill()
          await bounded(childClosed, 5_000)
        }
        assert(!forced && closed, `Own native child forced/unclosed; refuse and retain actual PID ${child.pid}`)
      }
    } catch (error) { errors.push(error) }
    try { if (child && !rawEmitted) emitNativeRaw() } catch (error) { errors.push(error) }
    if (errors.length > (priorFailure ? 1 : 0)) {
      if (errors.length === 1) throw errors[0]
      throw new AggregateError(errors, 'Concurrent drill and owned cleanup failed', { cause: priorFailure ? priorFailure.error : errors[0] })
    }
  }
  const deadline = Date.now() + 20_000
  try {
    await writer.connect(); writerPID = await registerOwnedConnection(writer)
    await writer.query('begin'); await writer.query("update deals set state='done' where id=$1", [undated.deal])
    await insert(writer, pending); await advance(writer, pending); await writer.query('select 1')
    const tag = `undated-drill-down-${randomUUID()}`
    const args = [cli, 'down', NAME, '-m', migrationsDir, '--schema', 'public', '--migrations-table', 'pgmigrations', '--single-transaction', '--verbose', 'false']
    const startedAt = new Date().toISOString()
    child = spawn(process.execPath, args,
      { cwd: backend, windowsHide: true, env: { ...process.env, PGAPPNAME: tag, TILI_DISPOSABLE_PG_PORT: selectedPort, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] })
    childIdentity = { owner: 'deal-day-scope-undated-drill', parentPID: process.pid, pid: child.pid, exe: process.execPath, cwd: backend, args, startedAt, ports: [] }
    process.stdout.write(`UNDATED_NATIVE_CHILD_STARTED ${JSON.stringify(childIdentity)}\n`)
    childClosed = new Promise(resolveClose => {
      child.on('error', error => { nativeError = error })
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
        stream.on('data', chunk => {
          if (Buffer.byteLength(output) + chunk.length <= 16 * 1024 * 1024) { streams[name].chunks.push(chunk); output += chunk.toString('utf8') }
          else overflow = true
        })
        stream.on('end', () => { streams[name].ended = true }); stream.on('error', error => { nativeError = error })
      }
      child.on('close', (code, signal) => {
        closed = true; nativeResult = { code, signal, closedAt: new Date().toISOString() }
        const observed = emitNativeRaw()
        resolveClose({ ...nativeResult, databaseError: observed.databaseError, parseError: observed.parseError })
      })
    })
    while (Date.now() < deadline && !closed && !waitWitness) {
      const rows = (await db.query(`select a.pid,a.application_name,a.usename,a.datname,a.state,a.wait_event_type,a.wait_event,
        pg_blocking_pids(a.pid) blockers,l.mode,l.granted,l.relation::regclass::text relation
        from pg_stat_activity a join pg_locks l on l.pid=a.pid
        where a.datname=current_database() and a.application_name=$1 and l.relation='public.deal_day_scope_versions'::regclass
          and l.mode='AccessExclusiveLock' and not l.granted`, [tag])).rows
      if (rows.length) {
        assert.equal(rows.length, 1); const row = rows[0]
        assert.equal(row.usename, 'codex_test'); assert.equal(row.wait_event_type, 'Lock'); assert(row.blockers.includes(writerPID))
        waitWitness = row
      } else await new Promise(resolveTick => setTimeout(resolveTick, 25))
    }
    assert(waitWitness, 'Actual native down must be blocked by the exact live append writer, not an invented delay')
    const waited = await bounded(childClosed, Math.max(1, deadline - Date.now()))
    assert(!waited.timedOut, 'Owned down exceeded finite wall deadline'); const native = waited.value
    assert(!nativeError && !overflow); assert(streams.stdout.ended && streams.stderr.ended)
    assert.notEqual(native.code, 0); assert.equal(native.signal, null)
    assert.deepEqual([...output.matchAll(/^> - (.+)$/gm)].map(x => x[1].trim()), [NAME])
    assert.equal(native.parseError, null, 'Actual native Error properties must be captured')
    assert.deepEqual(native.databaseError, { name: 'error', message: 'canceling statement due to lock timeout',
      code: '55P03', severity: 'ERROR', constraint: null, constraintLiteral: 'undefined' }, 'Actual lock-first Error, never echoed SQL')
    await writer.query('commit')
    const stdout = Buffer.concat(streams.stdout.chunks), stderr = Buffer.concat(streams.stderr.chunks)
    process.stdout.write(`UNDATED_NATIVE_LOCK_WAIT ${JSON.stringify({ child: childIdentity, writerPID, waitWitness, ...native, forced,
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutBytes: stdout.length, stderrBytes: stderr.length,
      stdoutSHA256: digest(stdout), stderrSHA256: digest(stderr), stdoutEOF: streams.stdout.ended, stderrEOF: streams.stderr.ended })}\n`)
  } catch (error) {
    concurrentFailure = { error }; throw error
  } finally {
    await closeConcurrent(concurrentFailure)
  }
  await appendWitness(beforeConcurrent, undated, pending, 'done', 'writer COMMIT after actual native55P03/EOF')
  let current = next(pending); await append(undated, current)
  const datedTerminal = next(dated.first, 'done_retained'); await append(dated, datedTerminal, 'done')
  await refused('deal_day_scope_chain', client => insert(client, next(current)), true)
  const release = { ...next(current, 'released'), operation: 'release', day_id: null }
  await refused('deal_day_scope_current', client => insert(client, release))
  await refused('deal_day_scope_current', async client => {
    const repeated = next(datedTerminal); await insert(client, repeated); await advance(client, repeated)
    await client.query('delete from vendor_busy_dates where id=$1', [dated.day])
  }, true)
  let downRefusals = 0
  async function preservedDown() {
    const previous = await fr018State()
    const guarded = await migrate('down', NAME, 'Undated terminal history exists; use a preserving forward migration', true)
    process.stdout.write(`UNDATED_NATIVE_HISTORY_DOWN_RESULT ${JSON.stringify({ output: guarded.output, status: guarded.status })}\n`)
    assert.deepEqual(nativeDatabaseError(guarded.output), { name: 'error', message: 'Undated terminal history exists; use a preserving forward migration',
      code: '23514', severity: 'ERROR', constraint: 'deal_day_scope_preserving_down', constraintLiteral: "'deal_day_scope_preserving_down'" })
    assert(/code:\s*['"]23514['"]/.test(guarded.output)); assert(guarded.output.includes('deal_day_scope_preserving_down'))
    assert.deepEqual(await fr018State(), previous, 'ANY historical done_undated blocks down without changing any row/catalogue/journal')
    downRefusals++
  }
  await preservedDown()
  // Existing generic release predicate is retained, not a public cancellation
  // policy. This synthetic root change has no DATE to release and no payment.
  await append(undated, release, 'cancelled'); current = release
  assert.equal(current.binding_state, 'released')
  const retained = await fr018State()
  await migrate('up', 1763860000000); assert.deepEqual(await fr018State(), retained)
  await preservedDown()
  assert.deepEqual(await fr018State(), retained, 'ANY historical done_undated blocks down even when its current head is released')
  const finalFunctions = clone(oldFunctions)
  for (const row of finalFunctions) if (bodies.has(row.proname)) row.prosrc = bodies.get(row.proname)
  assert.deepEqual(await functions(), finalFunctions); assert.deepEqual(await inherits(), oldInherits)
  await assertJournal(manifest.map(x => x.name)); seal()
  assert.equal(digest(readFileSync(helperPath)), helperSHA, 'Helper source remains byte-exact throughout its run')
  assert.equal(refusals, 3); assert.equal(downRefusals, 2)
  process.stdout.write(`UNDATED_TERMINAL_DRILL_PASSED ${JSON.stringify({ schema: 88, tables: 107, changedFunctionBodies: NAMES,
    noTerminalHistoryDown: 1, populated87Ups: 2, repeats: 2, sqlRefusals: refusals, nativeLockTimeout: 1, preservedHistoryDown: downRefusals,
    helperSHA256: helperSHA, migrationSHA256: SHA, publicWriterAuthority: false })}\n`)
}
