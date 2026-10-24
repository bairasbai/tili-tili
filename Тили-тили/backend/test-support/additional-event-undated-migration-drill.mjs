// Native schema93 preservation extension. Synthetic SQL storage controls are
// not public booking, first-DATE apply, read-proof acceptance or human consent.
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const NAME = '1763910000000_additional_event_undated'
const STAMP = 1763910000000
const PIN = '4ff66e47b92954a8dca6d430925143727b99fc3fd54376feb24a4b96e6cc59d4'
const PREVIOUS = '1763900000000_event_move_snapshot_operators'
const COR = ['deal_day_scope_shape_valid', 'legacy_day_initial_done_valid', 'offer_request_event_context_guard',
  'event_move_scope_supported', 'event_move_expected_physical', 'event_move_assert_applied']
const MESSAGE = 'Additional undated or move evidence exists; use a preserving forward migration'
const CONSTRAINT = 'additional_event_undated_preserving_down'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const clone = value => structuredClone(value)
const sorted = values => [...values].sort()
const quote = name => '"' + name.replaceAll('"', '""') + '"'
const emit = (name, value) => process.stdout.write(`${name} ${JSON.stringify(value)}\n`)

// Inspect the last native Error object, never an echoed SQL code/message.
function nativeError(output) {
  const headers = [...output.matchAll(/^error: ([^\r\n]+)\r?$/gm)]
  assert(headers.length > 0, 'Native Error header required')
  const last = headers.at(-1), block = output.slice(last.index)
  const properties = / \{\r?\n([\s\S]*)\r?\n\}\s*$/.exec(block)
  assert(properties && /\r?\n {4}at /.test(block.slice(0, properties.index)))
  const field = (name, pattern) => {
    const matches = [...properties[1].matchAll(new RegExp(`^  ${name}: (${pattern}),?\\r?$`, 'gm'))]
    assert.equal(matches.length, 1, `One actual Error.${name} required`)
    return matches[0][1]
  }
  const constraint = field('constraint', "undefined|null|'[^'\\r\\n]*'")
  return { message: last[1], code: field('code', "'[A-Z0-9]{5}'").slice(1, -1),
    severity: field('severity', "'[A-Z]+'").slice(1, -1),
    constraint: ['undefined', 'null'].includes(constraint) ? null : constraint.slice(1, -1) }
}
async function bounded(promise, milliseconds) {
  let timer
  try { return await Promise.race([promise.then(value => ({ value })), new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), milliseconds)
  })]) } finally { clearTimeout(timer) }
}

function controls(c) {
  const { db, write, migrate, fr018State, assertJournal, manifest, migrationsDir } = c
  assert.equal(manifest.length, 93)
  assert.equal(manifest[91].name, PREVIOUS); assert.equal(manifest[92].name, NAME)
  assert.equal(manifest[92].digest, PIN)
  const helper = fileURLToPath(import.meta.url), helperSHA = sha(readFileSync(helper))
  const path = resolve(migrationsDir, NAME + '.cjs')
  const seal = () => {
    assert.equal(sha(readFileSync(helper)), helperSHA, '93 helper changed during execution')
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink())
    const bytes = readFileSync(path); assert.equal(sha(bytes), PIN, '93 source requires an explicit reviewed repin')
    return bytes.toString('utf8').replaceAll('\r\n', '\n')
  }
  const halves = seal().split('exports.down = pgm =>'); assert.equal(halves.length, 2)
  const definitions = text => [...text.matchAll(/create or replace function (\w+)\([^]*?\bas \$\$([^]*?)\$\$;/g)]
    .map(row => ({ name: row[1], body: row[2] }))
  const up = definitions(halves[0]), down = definitions(halves[1])
  assert.deepEqual(up.map(row => row.name), COR); assert.deepEqual(down.map(row => row.name), COR)
  const functions = async () => (await db.query(`select p.oid::text,p.proname,
    pg_get_function_identity_arguments(p.oid) arguments,p.prosrc,p.provolatile,p.prosecdef,p.proleakproof,
    p.proisstrict,p.proretset,p.proparallel,p.proconfig,p.prokind,p.procost,p.prorows,
    p.prosupport::regproc::text support,p.prorettype::regtype::text result,l.lanname,
    pg_get_userbyid(p.proowner) owner,p.proacl,obj_description(p.oid,'pg_proc') comment
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows
  async function proof() {
    seal()
    const state = await fr018State(), raw = []
    for (const table of sorted(Object.keys(state.snapshot.data))) raw.push({ table,
      rows: (await db.query(`select row_to_json(t)::text raw from public.${quote(table)} t order by row_to_json(t)::text`)).rows.map(row => row.raw) })
    assert.equal(raw.length, 112)
    const validity = (await db.query(`select id::text,deal_day_scope_shape_valid(v) shape,
      deal_day_scope_matches_current(v) current,legacy_day_tuple_current(v) tuple,
      case when operation='observe_done' then legacy_day_initial_done_valid(v) else null end initial_done
      from deal_day_scope_versions v order by id`)).rows
    return { state, functions: await functions(), raw, validity }
  }
  async function flags() {
    return (await db.query(`select
      exists(select 1 from deal_day_scope_versions where context_kind='explicit_event'
        and binding_state in ('undated','done_undated')) versions,
      exists(select 1 from offer_requests where program_event_context->>'isMain'='false'
        and jsonb_typeof(program_event_context->'date')='null') quotes,
      exists(select 1 from event_move_proposals) proposals,exists(select 1 from event_move_roots) roots,
      exists(select 1 from event_move_receipts) receipts,exists(select 1 from event_move_effects) effects,
      exists(select 1 from audit_log where left(action,11)='event_move.') move_audit,
      exists(select 1 from audit_log where action='legacy_day.resolved' and diff->>'reason'='event_move') resolution_audit`)).rows[0]
  }
  async function tx(action) {
    await write('begin')
    try { const result = await action(); await write('commit'); return result }
    catch (error) { await db.query('rollback'); throw error }
  }
  async function installed(before, label) {
    await migrate('up', STAMP)
    const after = await proof(), expected = clone(before)
    const oldJournal = before.state.snapshot.data.pgmigrations
    assert.deepEqual(after.state.snapshot.data.pgmigrations.filter(row => row.name !== NAME), oldJournal)
    assert.equal(after.state.snapshot.data.pgmigrations.filter(row => row.name === NAME).length, 1)
    const journalRaw = after.raw.find(row => row.table === 'pgmigrations').rows
    assert.deepEqual(journalRaw.filter(raw => JSON.parse(raw).name !== NAME), before.raw.find(row => row.table === 'pgmigrations').rows)
    expected.state.snapshot.data.pgmigrations = after.state.snapshot.data.pgmigrations
    expected.raw.find(row => row.table === 'pgmigrations').rows = journalRaw
    for (let i = 0; i < COR.length; i++) {
      const old = expected.functions.filter(row => row.proname === COR[i])
      assert.equal(old.length, 1); assert.equal(old[0].prosrc, down[i].body, `${COR[i]} literal92 baseline`)
      old[0].prosrc = up[i].body
      const catalog = expected.state.snapshot.schema.functions.filter(row => row.proname === COR[i])
      assert.equal(catalog.length, 1); assert.equal(catalog[0].definition.split(down[i].body).length, 2)
      catalog[0].definition = catalog[0].definition.replace(down[i].body, () => up[i].body)
    }
    assert.deepEqual(after, expected, 'Only six exact COR bodies and one journal row may differ; all raw112/OIDs/ACL/catalogue/old validity remain')
    emit('UNDATED93_PRESERVING_UP', { label, helperSHA256: helperSHA, migrationSHA256: PIN, changedFunctions: COR, proof: after })
    return after
  }
  async function repeat(label) {
    const before = await proof(); await migrate('up', STAMP); assert.deepEqual(await proof(), before)
    emit('UNDATED93_REPEAT', { label, unchanged: true })
  }
  async function refusal(label, expectedFlags) {
    assert.deepEqual(await flags(), expectedFlags)
    const before = await proof(), outcome = await migrate('down', NAME, MESSAGE, true)
    assert.deepEqual(nativeError(outcome.output), { message: MESSAGE, code: '23514', severity: 'ERROR', constraint: CONSTRAINT })
    assert.deepEqual(await proof(), before); assert.deepEqual(await flags(), expectedFlags)
    emit('UNDATED93_RETAINED_DOWN', { label, expectedFlags, outcome, proof: before, unchanged: true })
  }
  const journal92 = () => assertJournal(manifest.slice(0, 92).map(row => row.name))
  const journal93 = () => assertJournal(manifest.map(row => row.name))
  return { db, write, migrate, proof, flags, tx, installed, repeat, refusal, seal, helperSHA, journal92, journal93 }
}

const emptyFlags = () => ({ versions: false, quotes: false, proposals: false, roots: false, receipts: false,
  effects: false, move_audit: false, resolution_audit: false })
const versionColumns = ['id', 'wedding_id', 'deal_id', 'slot_id', 'revision', 'origin_knowledge', 'operation',
  'context_kind', 'event_id', 'performer_kind', 'vendor_id', 'binding_state', 'service_date', 'time_zone', 'day_id']

// Root hook: old additional helper immediately after empty92 down/re-UP/repeat,
// before its flags/native legacy-audit/storage stages. Return exact schema92.
export async function runUndatedAdditionalEmptyCycle(c) {
  const o = controls(c), { db, write, migrate, proof, flags, tx } = o
  await o.journal92(); assert.deepEqual(await flags(), emptyFlags())
  const before92 = await proof()
  await o.installed(before92, 'first-empty93'); await o.repeat('first-empty93')
  await migrate('down', NAME, undefined, true)
  assert.deepEqual(await proof(), before92, 'Empty down restores literal six92 definitions and all raw/OID/ACL/catalogue')
  await o.journal92()
  await o.installed(before92, 'reup-empty93'); await o.repeat('reup-empty93')
  async function fixture(label, state = null) {
    const own = Object.fromEntries(['owner', 'company', 'wedding', 'vendor', 'event', 'slot', 'deal', 'version', 'request'].map(key => [key, randomUUID()]))
    own.timeZone = 'Europe/Moscow'
    await tx(async () => {
      for (const id of [own.owner, own.company]) await write("insert into users(id,phone,name) values($1,$2,'Synthetic undated93 actor')",
        [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])
      await write("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic undated93 studio',now())", [own.vendor, own.company])
      await write("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,$3,'2029-08-22','Europe/Moscow',$4)", [own.wedding, own.owner, label, randomUUID()])
      await write("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [own.wedding, own.owner])
      await write("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Synthetic undated additional','second_day',null,$3,false)", [own.event, own.wedding, own.timeZone])
      await write("insert into slots(id,wedding_id,program_event_id,category_id,label) values($1,$2,$3,'photo','Synthetic undated93 position')", [own.slot, own.wedding, own.event])
      if (state) {
        await write('insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,$5,17000)', [own.deal, own.wedding, own.slot, own.vendor, state])
        await write('update slots set deal_id=$2 where id=$1', [own.slot, own.deal])
      }
    })
    return own
  }
  async function append(own, client, done = false, timeZone = own.timeZone) {
    await client.query('select legacy_day_lock_vendors($1::uuid[])', [[own.vendor]])
    const values = [own.version, own.wedding, own.deal, own.slot, 1, 'legacy_unknown', done ? 'observe_done' : 'observe',
      'explicit_event', own.event, 'catalog', own.vendor, done ? 'done_undated' : 'undated', null, timeZone, null]
    assert.equal((await client.query(`insert into deal_day_scope_versions(${versionColumns.join(',')})
      values(${values.map((_, i) => '$' + (i + 1)).join(',')}) returning id`, values)).rowCount, 1)
    assert.equal((await client.query('insert into deal_day_scope_heads(deal_id,wedding_id,revision,current_version_id) values($1,$2,1,$3) returning deal_id',
      [own.deal, own.wedding, own.version])).rowCount, 1)
  }
  async function erase(own, baseline) {
    emit('UNDATED93_OWN_PARENT_ERASURE_BEFORE', { own, proof: await proof() })
    await tx(async () => {
      await write('select legacy_day_lock_vendors($1::uuid[])', [[own.vendor]])
      assert.deepEqual((await write('delete from weddings where id=$1 returning id', [own.wedding])).rows, [{ id: own.wedding }])
      assert.deepEqual((await write('delete from vendors where id=$1 returning id', [own.vendor])).rows, [{ id: own.vendor }])
      assert.deepEqual(sorted((await write('delete from users where id=any($1::uuid[]) returning id', [[own.owner, own.company]])).rows.map(row => row.id)), sorted([own.owner, own.company]))
    })
    assert.deepEqual(await proof(), baseline, 'Only exact own fixture parents cascade; every inherited row and all audit remain literal')
    assert.deepEqual(await flags(), emptyFlags())
    emit('UNDATED93_OWN_PARENT_ERASURE_AFTER', { own, proof: await proof() })
  }
  async function sqlRefusal(label, action, constraint) {
    const before = await proof(); let caught
    await write('begin')
    try { await action() } catch (error) { caught = error }
    finally { await db.query('rollback') }
    assert(caught, 'An actual invalid native write must fail')
    assert.equal(caught.code, '23514'); assert.equal(caught.constraint, constraint)
    assert.deepEqual(await proof(), before)
    emit('UNDATED93_NATIVE_CONSTRAINT', { label, code: caught.code, constraint: caught.constraint, message: caught.message, unchanged: true })
  }
  for (const done of [false, true]) {
    const baseline = await proof(), own = await fixture(done ? 'Synthetic93 initial done' : 'Synthetic93 open undated', done ? 'done' : 'booked')
    if (!done) await sqlRefusal('unknown-TZ-undated-shape', () => append(own, db, false, null), 'deal_day_scope_shape')
    await tx(() => append(own, db, done))
    const valid = (await db.query(`select deal_day_scope_shape_valid(v) shape,deal_day_scope_matches_current(v) current,
      legacy_day_tuple_current(v) tuple,legacy_day_initial_done_valid(v) initial_done,
      service_date::text,time_zone,day_id from deal_day_scope_versions v where id=$1`, [own.version])).rows
    assert.deepEqual(valid, [{ shape: true, current: true, tuple: true, initial_done: done, service_date: null, time_zone: own.timeZone, day_id: null }])
    await o.refusal(done ? 'initial-done-undated-only' : 'open-undated-only', { ...emptyFlags(), versions: true })
    await erase(own, baseline)
  }
  const quoteBase = await proof(), quoteOwn = await fixture('Synthetic93 NULL quote only')
  const insertQuote = bad => write(`insert into offer_requests(id,slot_id,vendor_id,status,close_reason,closed_at,wedding_date,created_by,program_event_context)
    select $1,s.id,$2,'closed','removed',clock_timestamp(),null,$3,
      jsonb_build_object('id',e.id,'isMain',false,'date',null,'timeZone',case when $5::boolean then null else e.time_zone end,
        'name',e.name,'kind',e.kind,'location',e.location)
    from slots s join wedding_events e on e.id=s.program_event_id where s.id=$4 returning id`,
  [quoteOwn.request, quoteOwn.vendor, quoteOwn.owner, quoteOwn.slot, bad])
  await sqlRefusal('NULL-quote-unknown-TZ', () => insertQuote(true), 'offer_request_event_context')
  assert.equal((await insertQuote(false)).rowCount, 1)
  const quoteRow = (await db.query('select wedding_date,program_event_context from offer_requests where id=$1', [quoteOwn.request])).rows[0]
  assert.equal(quoteRow.wedding_date, null); assert.equal(quoteRow.program_event_context.date, null)
  assert.equal(quoteRow.program_event_context.isMain, false); assert.equal(quoteRow.program_event_context.timeZone, quoteOwn.timeZone)
  await o.refusal('NULL-quote-only', { ...emptyFlags(), quotes: true }); await erase(quoteOwn, quoteBase)

  // A genuine pending version/head INSERT holds the first93 locked relation.
  // The waiter must reach native5s/55P03 before that writer is rolled back.
  const concurrentBase = await proof(), own = await fixture('Synthetic93 native AX writer', 'booked')
  const pendingBase = await proof(), writer = new c.pg.Client({ connectionString: c.databaseUrl, statement_timeout: 20_000, connectionTimeoutMillis: 5000 })
  let writerPID, child, childClosed, closed = false, exit, witness, primaryError
  const streams = { stdout: { chunks: [], eof: false }, stderr: { chunks: [], eof: false } }, errors = [], cleanup = []
  let bytes = 0, overflow = false
  const tag = `additional93-down-${randomUUID()}`
  const receipt = { owner: 'additional93-preserving-drill', parentPID: process.pid, pid: null, exe: process.execPath,
    cwd: c.backend, startedAt: null, ports: [], windowsHidden: true, forced: false }
  try {
    writer.on('error', error => errors.push({ source: 'writer', message: error.message }))
    await writer.connect(); writerPID = await c.registerOwnedConnection(writer); await writer.query('begin')
    await append(own, writer)
    const holder = (await db.query(`select pid,mode,granted,relation::regclass::text relation from pg_locks
      where pid=$1 and relation='public.deal_day_scope_versions'::regclass and mode='RowExclusiveLock' and granted`, [writerPID])).rows
    assert.deepEqual(holder, [{ pid: writerPID, mode: 'RowExclusiveLock', granted: true, relation: 'deal_day_scope_versions' }])
    const args = [c.cli, 'down', NAME, '-m', c.migrationsDir, '--schema', 'public', '--migrations-table', 'pgmigrations', '--single-transaction', '--verbose', 'false']
    child = spawn(process.execPath, args, { cwd: c.backend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGAPPNAME: tag, TILI_DISPOSABLE_PG_PORT: c.selectedPort, DATABASE_URL: c.databaseUrl, TEST_DATABASE_URL: c.databaseUrl } })
    receipt.pid = child.pid ?? null; receipt.startedAt = new Date().toISOString(); receipt.args = args
    emit('UNDATED93_NATIVE_STARTED', { receipt, writerPID, holder })
    childClosed = new Promise(resolveClose => {
      child.on('error', error => errors.push({ source: 'process', message: error.message }))
      child.on('exit', (code, signal) => { exit = { code, signal } })
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
        stream.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) overflow = true; else streams[name].chunks.push(chunk) })
        stream.on('end', () => { streams[name].eof = true }); stream.on('error', error => errors.push({ source: name, message: error.message }))
      }
      child.on('close', () => { closed = true; resolveClose() })
    })
    const deadline = performance.now() + 15_000
    while (performance.now() < deadline && !closed && !witness) {
      const waiters = (await db.query(`select a.pid,a.application_name,a.usename,a.datname,d.oid::text database_oid,
        a.backend_start,a.query_start,a.backend_type,host(a.client_addr) client_addr,a.client_port,a.state,a.query,a.wait_event_type,a.wait_event,
        pg_blocking_pids(a.pid) blockers,l.mode,l.granted,l.relation::regclass::text relation
        from pg_stat_activity a join pg_database d on d.datname=a.datname join pg_locks l on l.pid=a.pid
        where a.datname=current_database() and a.application_name=$1
          and l.relation='public.deal_day_scope_versions'::regclass and l.mode='AccessExclusiveLock' and not l.granted`, [tag])).rows
      if (waiters.length) { assert.equal(waiters.length, 1); witness = waiters[0] }
      else await new Promise(resolveTick => setTimeout(resolveTick, 25))
    }
    assert(witness && witness.blockers.includes(writerPID) && witness.wait_event_type === 'Lock')
    assert.equal(witness.usename, 'codex_test'); assert.equal(witness.datname, decodeURIComponent(new URL(c.databaseUrl).pathname.slice(1)))
    assert.equal(witness.database_oid, (await db.query('select oid::text from pg_database where datname=current_database()')).rows[0].oid)
    assert.equal(witness.backend_type, 'client backend'); assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(witness.client_addr))
    assert(/lock table deal_day_scope_versions,deal_day_scope_heads,offer_requests,/.test(witness.query))
    const outcome = await bounded(childClosed, Math.max(1, deadline - performance.now()))
    assert(!outcome.timedOut && closed); assert(exit && exit.code !== 0 && exit.signal === null)
    assert(!overflow && streams.stdout.eof && streams.stderr.eof); assert.deepEqual(errors, [])
    const stdout = Buffer.concat(streams.stdout.chunks).toString('utf8'), stderr = Buffer.concat(streams.stderr.chunks).toString('utf8')
    assert.deepEqual([...stdout.matchAll(/^> - (.+)$/gm)].map(row => row[1].trim()), [NAME])
    assert.deepEqual(nativeError(stderr), { message: 'canceling statement due to lock timeout', code: '55P03', severity: 'ERROR', constraint: null })
    emit('UNDATED93_NATIVE_AX_WAIT', { receipt, writerPID, holder, witness, stdout, stderr, exit, forced: false, writerCommitted: false })
  } catch (error) { primaryError = error }
  finally {
    try { if (writerPID) await writer.query('rollback') } catch (error) { cleanup.push(error) }
    try { const ended = await bounded(writer.end(), 5000); assert(!ended.timedOut, 'Writer close deadline; Root owns recorded PID')
      if (writerPID) c.ownedPids.delete(writerPID) } catch (error) { cleanup.push(error) }
    if (child && !closed) { const ended = await bounded(childClosed, 7000); if (ended.timedOut) cleanup.push(new Error(`Native child remains; Root owns exact PID ${receipt.pid}`)) }
    const rawStreams = Object.fromEntries(Object.entries(streams).map(([name, value]) => { const raw = Buffer.concat(value.chunks)
      return [name, { bytes: raw.length, sha256: sha(raw), eof: value.eof, raw: raw.toString('utf8') }] }))
    emit('UNDATED93_NATIVE_CLOSED', { receipt, endedAt: new Date().toISOString(), closed, exit, streams: rawStreams, overflow, errors,
      primaryError: primaryError?.message ?? null, cleanupErrors: cleanup.map(error => error.message), mayRemain: !closed })
  }
  if (cleanup.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanup], '93 owned close failed; no process killed')
  if (primaryError) throw primaryError
  assert.deepEqual(await proof(), pendingBase, 'Native AX timeout and own writer ROLLBACK preserve every committed raw row/catalogue')
  await erase(own, concurrentBase)
  assert.deepEqual(await flags(), emptyFlags()); await migrate('down', NAME, undefined, true)
  assert.deepEqual(await proof(), before92, 'Return exact92 before all original91/92 history checks')
  await o.journal92(); o.seal()
  emit('UNDATED93_EMPTY_MIGRATION_DRILL_PASSED', { schema: 92, oldRawTables: 112, changedFunctions: COR,
    emptyDowns: 2, upCommands: 4, retainedNativeDowns: 3, nativeConstraintRefusals: 2, nativeAXTimeout: 1,
    isolatedUndatedAndDoneHistory: true, isolatedNullQuote: true, moveHistoryEmpty: true, nativeWriterCommitted: false,
    helperSHA256: o.helperSHA, migrationSHA256: PIN, publicWriterAcceptance: false, realHumanAgreement: false })
}

// Call only after the unchanged existing additional92 cycle. Its real retained
// cancellation audit is an intentional conservative blocker, not new93 history.
export async function runUndatedAdditionalPopulatedCycle(c) {
  const o = controls(c)
  await o.journal92()
  const before = await o.proof(), flags = await o.flags()
  assert.deepEqual(flags, { ...emptyFlags(), move_audit: true }, 'Existing92 helper must leave its real cancellation audit only')
  const retained = before.raw.find(row => row.table === 'audit_log').rows.filter(raw => JSON.parse(raw).action === 'event_move.cancelled')
  assert(retained.length > 0)
  await o.installed(before, 'populated-old92-audit'); await o.repeat('populated-old92-audit')
  await o.refusal('conservative-ANY-old92-cancellation-audit', flags)
  await o.journal93(); o.seal()
  emit('UNDATED93_POPULATED_MIGRATION_DRILL_PASSED', { schema: 93, oldRawTables: 112, changedFunctions: COR,
    upCommands: 2, retainedNativeDowns: 1, blocker: 'retained actual old92 cancellation audit', retainedAudit: retained,
    new93MoveHistoryTested: false, guardMaskedByOldAudit: true, compatiblePopulatedRollbackClaimed: false,
    helperSHA256: o.helperSHA, migrationSHA256: PIN, publicWriterAcceptance: false, realHumanAgreement: false })
}
