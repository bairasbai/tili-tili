import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import pg from 'pg'

assert.equal(process.platform, 'linux')
const container = process.argv[2]
assert.match(container, /^c372-sql-\d+-\d+$/)
const out = '.ci/c372-sql-diagnostic'
mkdirSync(out, { recursive: true })
const database = 'tili_ecosystem_full_20260930_test'
const url = `postgres://codex_test@127.0.0.1:15432/${database}`
const admin = new pg.Client({ connectionString: 'postgres://codex_test@127.0.0.1:15432/postgres', connectionTimeoutMillis: 5000 })
const helpers = ['legacy_calendar_adopted_version(uuid,uuid)', 'legacy_calendar_adopted_commitment(uuid)', 'legacy_calendar_adoption_calendar_projection(uuid,uuid)']
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const save = (name, value) => writeFileSync(`${out}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
const command = async (label, args, seconds, extraEnv = {}) => {
  const stdout = `${out}/${label}.stdout.log`, stderr = `${out}/${label}.stderr.log`
  const fd1 = openSync(stdout, 'wx'), fd2 = openSync(stderr, 'wx')
  const started = new Date().toISOString()
  // GNU timeout owns a distinct process group. Its limit bounds an aborted diagnostic
  // child; the original per-test/hook deadlines are unchanged.
  const child = spawn('timeout', ['--signal=TERM', '--kill-after=10s', `${seconds}s`, ...args], {
    stdio: ['ignore', fd1, fd2], env: { ...process.env, ...extraEnv },
  })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  try {
    let procStat
    for (let n = 0; n < 100; n++) {
      procStat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
      if (Number(procStat.slice(procStat.lastIndexOf(')') + 2).split(' ')[2]) === child.pid) break
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    assert.equal(Number(procStat.slice(procStat.lastIndexOf(')') + 2).split(' ')[2]), child.pid, 'GNU timeout must own its process group')
    save(`${label}.start`, { owner: 'root/c372-sql-diagnostic', pid: child.pid, started, cwd: process.cwd(), args,
      procStat, processGroupId: child.pid, procCmd: readFileSync(`/proc/${child.pid}/cmdline`, 'utf8') })
    const exit = await closed
    const inventory = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8' })
    assert.equal(inventory.status, 0)
    const remainingGroup = inventory.stdout.split('\n').filter(line => Number(line.trim().split(/\s+/)[2]) === child.pid)
    const receipt = { started, ended: new Date().toISOString(), ...exit, stdout: { file: stdout, sha256: hash(stdout) },
      stderr: { file: stderr, sha256: hash(stderr) }, eofBoth: null, directFileTransport: true, nativeEOFClaimed: false, perTestTimeoutChanged: false,
      diagnosticOnly: true, testsPassed: false, remainingOriginalProcessGroup: remainingGroup }
    save(`${label}.exit`, receipt)
    assert.equal(remainingGroup.length, 0, 'Refuse progressing with remaining owned child group')
    return receipt
  } finally { closeSync(fd1); closeSync(fd2) }
}

let connected = false
for (let attempt = 0; attempt < 60; attempt++) {
  const r = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'codex_test', '-p', '15432', '-d', 'postgres'], { stdio: 'ignore' })
  if (r.status === 0) { connected = true; break }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
assert(connected, 'Own PostgreSQL failed to become ready')
await admin.connect()
save('source', { diagnosticOnly: true, production: false, migration: { file: 'migrations/1763930000000_legacy_calendar_adoption.cjs',
  sha256: hash('migrations/1763930000000_legacy_calendar_adoption.cjs') }, test: { file: 'test/additionalEventMove.test.ts',
  sha256: hash('test/additionalEventMove.test.ts') }, controller: { file: 'scripts/c372-sql-diagnostic.mjs', sha256: hash('scripts/c372-sql-diagnostic.mjs') },
  commit: process.env.GITHUB_SHA, sourceParent: 'c4049bb076e9350781e654ebd65130a0b4955c5f',
  scope: 'M0 and M1 only. Other 21 cases deliberately outside diagnostic scope; never whole-suite acceptance.' })
const arms = ['default_jit', 'database_jit_off', 'helper_jit_off', 'helper_jit_on_sham']
const receipts = []
const retainedDumps = new Set()
try {
  for (const arm of arms) {
    assert.equal((await admin.query('select 1 from pg_database where datname=$1', [database])).rowCount, 0, 'Refuse existing canonical database')
    await admin.query(`create database ${database} owner codex_test template template0`)
    const migration = await command(`${arm}-migration`, [process.execPath, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js', '-m', 'migrations', 'up'], 180, { DATABASE_URL: url })
    assert.equal(migration.code, 0, 'Migration must pass before diagnostic')
    const c = new pg.Client({ connectionString: url }); await c.connect()
    try {
      await c.query('create extension pg_stat_statements')
      if (arm === 'database_jit_off') await c.query(`alter database ${database} set jit=off`)
      if (arm === 'helper_jit_off' || arm === 'helper_jit_on_sham') {
        for (const fn of helpers) await c.query(`alter function ${fn} set jit=${arm === 'helper_jit_off' ? 'off' : 'on'}`)
      }
      save(`${arm}-before`, { identity: (await c.query(`select version(),current_database(),current_user,inet_server_port(),pg_jit_available(),
        (select system_identifier::text from pg_control_system()) system_identifier,(select oid::text from pg_database where datname=current_database()) oid`)).rows,
        jitSettings: (await c.query("select name,setting,unit,source from pg_settings where name like 'jit%' order by name")).rows,
        existingSessionPredatesDatabaseSetting: arm === 'database_jit_off', newTestAndAfterConnectionsUseDatabaseSetting: true,
        databaseSettings: (await c.query('select setconfig from pg_db_role_setting where setdatabase=(select oid from pg_database where datname=current_database())')).rows,
        functions: (await c.query('select oid::regprocedure::text signature,provolatile,proconfig,prosrc from pg_proc where oid=any($1::regprocedure[])', [helpers])).rows,
        journal: (await c.query('select * from pgmigrations order by id')).rows })
      await c.query('select pg_stat_statements_reset()')
    } finally { await c.end() }
    const test = await command(`${arm}-tests`, [process.execPath, 'node_modules/vitest/vitest.mjs', 'run', 'test/additionalEventMove.test.ts',
      '--testNamePattern', 'M[01] ', '--reporter=default', '--reporter=json', `--outputFile=${out}/${arm}-tests.json`], 180,
    { DATABASE_URL: url, TEST_DATABASE_URL: url, TILI_DISPOSABLE_PG_PORT: '15432' })
    const stats = new pg.Client({ connectionString: url }); await stats.connect()
    try {
      save(`${arm}-after`, { diagnosticOnly: true, testExit: test.code,
        activeSettings: (await stats.query("select name,setting,source from pg_settings where name like 'jit%' order by name")).rows,
        statements: (await stats.query('select to_jsonb(s) data from pg_stat_statements s where dbid=(select oid from pg_database where datname=current_database()) order by total_exec_time desc')).rows,
        functions: (await stats.query('select * from pg_stat_user_functions order by total_time desc')).rows,
        tables: (await stats.query("select relname,n_live_tup from pg_stat_user_tables order by relname")).rows,
        sessions: (await stats.query('select pid,application_name,state,query from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()')).rows })
    } finally { await stats.end() }
    const sessions = (await admin.query('select pid,state,query from pg_stat_activity where datname=$1', [database])).rows
    save(`${arm}-sessions-after-child`, sessions)
    assert.equal(sessions.length, 0, 'No surviving test connection allowed before rename')
    const retained = `c372_diag_${arm}_${process.env.GITHUB_RUN_ID}_test`
    assert.match(retained, /^[a-z0-9_]+$/)
    await admin.query(`alter database ${database} rename to ${retained}`)
    const dump = `${out}/${arm}.pgdump`, dumpFd = openSync(dump, 'wx'), errFd = openSync(`${out}/${arm}-dump.stderr.log`, 'wx')
    let dumped
    try { dumped = spawnSync('docker', ['exec', container, 'pg_dump', '-U', 'codex_test', '-p', '15432', '-Fc', retained], { stdio: ['ignore', dumpFd, errFd], timeout: 120000 }) }
    finally { closeSync(dumpFd); closeSync(errFd) }
    save(`${arm}-retained`, { retainedDatabase: retained, dump, sha256: hash(dump), dumpStatus: dumped.status, diagnosticOnly: true })
    assert.equal(dumped.status, 0, 'Diagnostic FAILED database dump must be retained')
    retainedDumps.add(retained)
    receipts.push({ arm, testCode: test.code, retainedDatabase: retained })
    console.log(JSON.stringify({ kind: 'DIAGNOSTIC_ARM_ONLY', arm, testCode: test.code, otherCasesOutsideScope: 21 }))
  }
  save('diagnostic-complete', { diagnosticOnly: true, featureAcceptance: false, receipts })
} finally {
  // Also preserve the current FAILED database if a migration, child or session
  // guard aborts an arm before its normal rename/dump. Never kill DB sessions.
  try {
    const owned = (await admin.query('select datname from pg_database where datname=$1 or datname like $2',
      [database, 'c372_diag_%'])).rows
    for (const { datname } of owned) {
      if (retainedDumps.has(datname)) continue
      assert.match(datname, /^[a-z0-9_]+$/)
      const file = `${out}/fallback-${datname}.pgdump`
      const fd = openSync(file, 'wx'), err = openSync(`${out}/fallback-${datname}.stderr.log`, 'wx')
      let result
      try { result = spawnSync('docker', ['exec', container, 'pg_dump', '-U', 'codex_test', '-p', '15432', '-Fc', datname],
        { stdio: ['ignore', fd, err], timeout: 120000 }) }
      finally { closeSync(fd); closeSync(err) }
      save(`fallback-${datname}`, { database: datname, file, sha256: hash(file), nativeStatus: result.status, signal: result.signal,
        error: result.error?.message ?? null, completeDump: result.status === 0, diagnosticOnly: true })
    }
  } finally { await admin.end() }
}
