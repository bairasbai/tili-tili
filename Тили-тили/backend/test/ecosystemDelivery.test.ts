import { randomInt, randomUUID } from 'node:crypto'
import { Agent } from 'node:https'
import pg from 'pg'
import assert from 'node:assert/strict'
import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { disposablePgPort } from './disposablePgPort.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import webpush from 'web-push'
import { loadConfig } from '../src/config.js'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import * as preflight from '../src/notify/preflight.js'
import { sendDuePushes as sendDuePushesNative, PUSH_LEASE_MS, PUSH_MAX_ATTEMPTS, PUSH_TIMEOUT_MS, PUSH_PASS_BUDGET_MS } from '../src/notify/push.js'

const DATABASE = process.env.TEST_DATABASE_URL
const keys = webpush.generateVAPIDKeys()
const config = { ...loadConfig({ NODE_ENV: 'test' }), vapidPublicKey: keys.publicKey,
  vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:delivery-test@example.com' }


type DeliveryIdentity = { name: string; oid: string; sysid: string; principal: string; session_principal: string; owner: string; data: string; address: string; port: number }
type DeliveryIsolation = { run: string; dir: string; name: string; url: string; parent: DeliveryIdentity | null; own: DeliveryIdentity | null; createdOID: string | null }
let isolation: DeliveryIsolation | null = null
const activePushes = new Set<Promise<void>>()
const activeMigrations = new Set<Promise<void>>()
const cleanupNow = performance.now.bind(performance), cleanupSetTimeout = setTimeout, cleanupClearTimeout = clearTimeout
const originalProviderDescriptor = Object.getOwnPropertyDescriptor(webpush, 'sendNotification')
assert(originalProviderDescriptor?.configurable && originalProviderDescriptor.writable && typeof originalProviderDescriptor.value === 'function')
let retainedDeliveryContext = false, ownedProvider: typeof webpush.sendNotification | null = null
function installOwnedDeliveryProvider() {
  assert(!retainedDeliveryContext && ownedProvider === null)
  // Plain owned descriptor, not spyOn: framework restoreAllMocks cannot expose a real transport underneath an inflight failed job.
  ownedProvider = vi.fn<typeof webpush.sendNotification>(() => Promise.reject(new Error('Delivery provider reset while failed: outbound disabled')))
    .mockResolvedValue({ statusCode: 201, body: '', headers: {} })
  Object.defineProperty(webpush, 'sendNotification', { ...originalProviderDescriptor, value: ownedProvider })
}
function restoreOwnedDeliveryProvider() {
  assert(!retainedDeliveryContext && activePushes.size === 0)
  if (ownedProvider) {
    assert.equal(Object.getOwnPropertyDescriptor(webpush, 'sendNotification')?.value, ownedProvider)
    Object.defineProperty(webpush, 'sendNotification', originalProviderDescriptor!); ownedProvider = null
  }
  vi.useRealTimers(); vi.restoreAllMocks()
}
// Observe settlement only: invoke the original function with the same arguments and return its exact promise.
const sendDuePushes: typeof sendDuePushesNative = (...args) => {
  if (retainedDeliveryContext) return Promise.reject(new Error('DELIVERY_RETAINED_FAILURE: new job refused before native invocation'))
  const action = sendDuePushesNative(...args), settled = action.then(() => undefined, () => undefined)
  activePushes.add(settled); void settled.then(() => { activePushes.delete(settled) }); return action
}
function deliveryArtifact(name: string, value: unknown) {
  assert(isolation && /^[a-z][a-z0-9-]*\.json$/.test(name))
  const file = join(isolation.dir, name), bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'), fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase()
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase(), sha256)
  process.stdout.write(`DELIVERY_ISOLATED_ARTIFACT ${JSON.stringify({ run: isolation.run, file, bytes: bytes.length, sha256 })}\n`)
  return { file, bytes: bytes.length, sha256 }
}
const deliveryQuery = (client: pg.Client): Queryable => ({ query: (sql, values) => client.query(sql, values as unknown[]) })
async function deliveryIdentity(client: Queryable): Promise<DeliveryIdentity> {
  const row = (await client.query<DeliveryIdentity>(`select current_database() name,d.oid::text oid,
    (pg_control_system()).system_identifier::text sysid,current_user principal,session_user session_principal,pg_get_userbyid(d.datdba) owner,
    current_setting('data_directory') data,host(inet_server_addr()) address,inet_server_port() port from pg_database d where datname=current_database()`)).rows[0]!
  assert.equal(row.principal, 'codex_test'); assert.equal(row.session_principal, 'codex_test'); assert.equal(row.owner, 'codex_test'); assert(['127.0.0.1','::1'].includes(row.address)); assert.equal(String(row.port), disposablePgPort())
  assert(/^[1-9][0-9]*$/.test(row.oid) && /^[0-9]+$/.test(row.sysid)); return row
}
async function prepareDeliveryDatabase(): Promise<string> {
  const until = performance.now() + 25_000
  const remaining = () => { const value = Math.floor(until - performance.now()); assert(value > 0, 'Delivery unchanged initialization hook budget'); return value }
  assert(DATABASE); const parentURL = new URL(DATABASE)
  assert(['postgres:', 'postgresql:'].includes(parentURL.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(parentURL.hostname))
  assert.equal(parentURL.username, 'codex_test'); assert.equal(parentURL.password, ''); assert.equal(parentURL.port, disposablePgPort())
  assert.equal(parentURL.pathname, '/tili_ecosystem_full_20260930_test'); assert.equal(parentURL.search, ''); assert.equal(parentURL.hash, '')
  if (process.env.DATABASE_URL) assert.equal(process.env.DATABASE_URL, DATABASE)
  const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..'), run = randomUUID().replaceAll('-', '')
  const name = `tili_ecosystem_delivery_${run}_test`; assert(/^tili_ecosystem_delivery_[a-f0-9]{32}_test$/.test(name) && name.length <= 63)
  const url = new URL(parentURL); url.pathname = '/' + name
  const root = join(backend, '.ci', 'delivery-isolated')
  for (const dir of [join(backend, '.ci'), root]) {
    if (!existsSync(dir)) mkdirSync(dir)
    assert(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink()); assert.equal(realpathSync(dir), dir)
  }
  const dir = join(root, run); mkdirSync(dir); isolation = { run, dir, name, url: url.toString(), parent: null, own: null, createdOID: null }
  const migrationsDir = join(backend, 'migrations'), cli = join(backend, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js')
  const migrationNames = readdirSync(migrationsDir).filter(n => /^[0-9]{13}_[a-z0-9_]+\.cjs$/.test(n)).sort().map(n => n.slice(0, -4))
  assert.equal(migrationNames.length, 94); assert.equal(migrationNames.at(-1), '1763920000000_legacy_calendar_bounds')
  const sources = [fileURLToPath(import.meta.url), cli, ...readdirSync(migrationsDir).filter(n => /\.(cjs|sql)$/.test(n)).sort().map(n => join(migrationsDir, n))]
  const sourcePins = sources.map(file => { const bytes = readFileSync(file); return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase() } })
  assert.equal(sourcePins.find(p => p.file === join(migrationsDir, '1763920000000_legacy_calendar_bounds.cjs'))!.sha256, '29A7F1A69E69FE36013707DB036418159B8D69973BD626017BB5A6926CBC9A6C')
  const setupClients = new Set<pg.Client>(), closing = new Map<pg.Client, Promise<void>>()
  const closeSetupClient = (client: pg.Client) => { let done = closing.get(client); if (!done) { done = client.end(); closing.set(client, done) }; return done }
  let migrationChild: ChildProcess | null = null, setupExpired = false
  const watchdogCloseErrors: unknown[] = []
  const watchdog = setTimeout(() => {
    setupExpired = true
    if (migrationChild && migrationChild.exitCode === null && migrationChild.signalCode === null) migrationChild.kill('SIGTERM')
    for (const client of setupClients) void closeSetupClient(client).catch(error => { watchdogCloseErrors.push(error) })
  }, Math.max(1, remaining()))
  const parent = new pg.Client({ connectionString: DATABASE, connectionTimeoutMillis: Math.min(5000, remaining()), statement_timeout: 5000, application_name: `delivery_creator_${run}` })
  setupClients.add(parent)
  let primary: { error: unknown } | null = null
  try {
    await parent.connect(); isolation.parent = await deliveryIdentity(deliveryQuery(parent))
    assert.equal(isolation.parent.name, 'tili_ecosystem_full_20260930_test'); remaining()
    assert.equal((await parent.query('select oid from pg_database where datname=$1', [name])).rowCount, 0)
    deliveryArtifact('ownership-plan.json', { owner: 'ecosystemDelivery.test.ts', phase: 'BEFORE_CREATE_DATABASE', at: new Date().toISOString(), pid: process.pid,
      cwd: process.cwd(), run, name, host: parentURL.hostname, port: parentURL.port, role: 'codex_test', template: 'template0', parent: isolation.parent,
      sourcePins, migrationNames, noDropResetReuseOrTerminate: true, failedOrUnknownRetained: true, production: false })
    remaining(); await parent.query(`create database "${name}" template template0 owner codex_test`)
    const oid = (await parent.query<{ oid: string }>('select oid::text oid from pg_database where datname=$1', [name])).rows[0]!.oid
    isolation.createdOID = oid
    deliveryArtifact('created-database.json', { run, name, oid, createdByThisAttempt: true, at: new Date().toISOString() })
    const absentEnv = join(dir, 'dotenv-must-remain-absent'); assert(!existsSync(absentEnv))
    const args = [cli, 'up', '1763920000000', '--timestamp', '-m', migrationsDir, '--schema', 'public', '--migrations-table', 'pgmigrations', '--single-transaction', '--verbose', 'false', '--envPath', absentEnv]
    const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_ENV: 'test', TZ: 'UTC',
      DATABASE_URL: url.toString(), TEST_DATABASE_URL: url.toString(), TILI_DISPOSABLE_PG_PORT: disposablePgPort() }
    const migration = new Promise<void>((resolveChild, rejectChild) => {
      let ownerError: { error: unknown } | null = null
      const child = execFile(process.execPath, args, { cwd: backend, env: childEnv, windowsHide: true, encoding: 'buffer',
        timeout: Math.max(1, Math.min(20_000, remaining() - 3000)), killSignal: 'SIGTERM', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        try {
          const out = join(dir, 'migration.stdout.raw'), err = join(dir, 'migration.stderr.raw')
          writeFileSync(out, stdout, { flag: 'wx', mode: 0o600 }); writeFileSync(err, stderr, { flag: 'wx', mode: 0o600 })
          deliveryArtifact('migration-exit.json', { run, pid: child.pid, nativeExitCode: child.exitCode, signal: child.signalCode,
            stdoutEOF: child.stdout?.readableEnded === true, stderrEOF: child.stderr?.readableEnded === true,
            stdout: { file: out, bytes: stdout.length, sha256: createHash('sha256').update(stdout).digest('hex').toUpperCase() },
            stderr: { file: err, bytes: stderr.length, sha256: createHash('sha256').update(stderr).digest('hex').toUpperCase() },
            failed: Boolean(error || ownerError), retained: true, rootOSVerificationRequired: true })
          if (ownerError) throw ownerError.error
          if (error) throw error
          assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null)
          assert(child.stdout?.readableEnded && child.stderr?.readableEnded, 'Migration pipes require actual EOF')
          assert(!existsSync(absentEnv)); resolveChild()
        } catch (error) { rejectChild(error) }
      })
      migrationChild = child
      try { deliveryArtifact('migration-owner.json', { owner: 'ecosystemDelivery.test.ts', run, pid: child.pid, parentPID: process.pid,
        startedAtUTC: new Date().toISOString(), osBirthNotObservedByTest: true, exe: process.execPath, cwd: backend, args, windowsHide: true, rootOSVerificationRequired: true }) }
      catch (error) { ownerError = { error }; child.kill('SIGTERM') }
    })
    const migrationSettled = migration.then(() => undefined, () => undefined)
    activeMigrations.add(migrationSettled); void migrationSettled.then(() => { activeMigrations.delete(migrationSettled) })
    await migration
    remaining(); const check = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: Math.min(3000, remaining()), statement_timeout: Math.min(3000, remaining()) })
    setupClients.add(check)
    try {
      await check.connect(); isolation.own = await deliveryIdentity(deliveryQuery(check))
      assert.deepEqual([isolation.own.name,isolation.own.oid,isolation.own.sysid,isolation.own.data], [name,oid,isolation.parent.sysid,isolation.parent.data])
      expect((await check.query<{ name: string }>('select name from pgmigrations order by id')).rows.map(r => r.name)).toEqual(migrationNames)
      expect((await check.query("select count(*)::int n from pg_tables where schemaname='public'")).rows).toEqual([{ n: 124 }])
      expect((await check.query('select (select count(*)::int from notifications) notices,(select count(*)::int from push_subscriptions) subscriptions,(select count(*)::int from notification_push_deliveries) deliveries')).rows).toEqual([{ notices: 0,subscriptions: 0,deliveries: 0 }])
    } finally { await closeSetupClient(check) }
    for (const pin of sourcePins) assert.equal(createHash('sha256').update(readFileSync(pin.file)).digest('hex').toUpperCase(), pin.sha256)
    remaining(); assert(!setupExpired)
    deliveryArtifact('isolated-ready.json', { run, own: isolation.own, migrationCount: 94, tables: 124, initialQueueEmpty: true, sourcePins, at: new Date().toISOString(), production: false })
  } catch (error) { primary = { error } }
  try { await closeSetupClient(parent) } catch (error) { primary = { error: primary ? new AggregateError([primary.error,error], 'Delivery creator and parent close failed') : error } }
  clearTimeout(watchdog)
  if (setupExpired && !primary) primary = { error: new Error('Delivery setup deadline exceeded; owned child/clients closed') }
  if (primary) { deliveryArtifact('setup-failed-retained.json', { run, name, own: isolation.own, complete: false, retained: true, setupExpired, watchdogCloseErrors: watchdogCloseErrors.length, rootInspectionRequired: true }); throw primary.error }
  return url.toString()
}
async function preserveDeliveryDatabase(pool: Db | undefined, retainedFailure: boolean, passed: number) {
  assert(isolation, 'No admitted isolated database; no preservation claim')
  const state = isolation, until = cleanupNow() + 25_000
  const bounded = async <T>(action: () => Promise<T>, label: string): Promise<T> => {
    const ms = Math.floor(until - cleanupNow()); assert(ms > 0, 'Delivery preservation real deadline')
    let timer: ReturnType<typeof cleanupSetTimeout> | undefined
    try { return await Promise.race([action(),new Promise<never>((_, reject) => { timer = cleanupSetTimeout(() => reject(new Error(label + ': incomplete cleanup')), ms) })]) }
    finally { if (timer) cleanupClearTimeout(timer) }
  }
  let closed = false, drained = false, migrationDrained = false, readbackClosed = false, snapshot: unknown = null, primary: { error: unknown } | null = null
  try {
    await bounded(() => Promise.all([...activeMigrations]), 'migration child drain'); migrationDrained = activeMigrations.size === 0; assert(migrationDrained)
    if (vi.isFakeTimers() && activePushes.size) await bounded(() => vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS), 'one actual product timeout cleanup')
    await bounded(() => Promise.all([...activePushes]), 'push drain'); drained = activePushes.size === 0; assert(drained)
    if (!retainedFailure) restoreOwnedDeliveryProvider()
    // A failed/unknown body may continue after framework timeout. Its provider stays closed even across framework restore/reset.
    if (pool) await bounded(() => pool.close(), 'test pool close'); closed = true
    if (state.createdOID) {
      const reader = new pg.Client({ connectionString: state.url, connectionTimeoutMillis: 3000, statement_timeout: 3000, application_name: `delivery_preserve_${state.run}` })
      let reading: { error: unknown } | null = null
      try {
        await bounded(() => reader.connect(), 'readback connect')
        const identity = await bounded(() => deliveryIdentity(deliveryQuery(reader)), 'readback identity')
        assert(state.parent); assert.deepEqual(identity, state.own ?? { ...state.parent,name: state.name,oid: state.createdOID })
        await bounded(() => reader.query('begin isolation level repeatable read read only'), 'readback begin')
        const tables = (await bounded(() => reader.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public' order by tablename"), 'readback tables')).rows
        const data: Record<string, string[]> = {}
        for (const { tablename } of tables) {
          assert(/^[a-z_][a-z0-9_]*$/.test(tablename))
          data[tablename] = (await bounded(() => reader.query<{ raw: string }>(`select row_to_json(t)::text raw from "${tablename}" t order by row_to_json(t)::text`), 'preservation read')).rows.map(r => r.raw)
        }
        await bounded(() => reader.query('commit'), 'readback commit'); snapshot = { identity, raw: data }
      } catch (error) { reading = { error } }
      const ending = reader.end(); void ending.catch(() => undefined)
      try { await bounded(() => ending, 'readback client close'); readbackClosed = true }
      catch (error) { reading = { error: reading ? new AggregateError([reading.error,error], 'Readback and client close failed') : error } }
      if (reading) throw reading.error
    }
  } catch (error) { primary = { error } }
  const captureComplete = migrationDrained && drained && closed && readbackClosed && snapshot !== null && primary === null && !retainedFailure
  try {
    deliveryArtifact('preservation.json', { owner: 'ecosystemDelivery.test.ts', run: state.run, name: state.name, retained: true, databaseDropped: false,
      complete: captureComplete && passed === 43, captureComplete, migrationChildDrained: migrationDrained, knownTrackedJobsDrained: drained,
      providerHeldForFailedContext: retainedDeliveryContext, pendingWorkUncertain: retainedFailure, activePushCount: activePushes.size,
      testPoolClosed: closed, readbackClientClosed: readbackClosed, observedPassedBodies: passed, retainedFailure,
      acceptanceRequiresRootResult: true, snapshot, at: new Date().toISOString() })
  } catch (error) { throw primary ? new AggregateError([primary.error,error], 'Preservation and artifact failed') : error }
  if (primary) throw primary.error
}

describe.skipIf(!DATABASE)('durable subscription delivery (real PostgreSQL, mocked provider)', () => {
  let db: Db
  const users: string[] = []
  const send = () => vi.mocked(webpush.sendNotification)
  const ownCalls = (id: string) => send().mock.calls.filter(([, payload]) =>
    JSON.parse(String(payload)).data.notificationId === id)

  let retainedFailure = false, observedPassedBodies = 0
  beforeAll(async () => { db = createDb(await prepareDeliveryDatabase()); expect(await db.ping()).toBe(true) })
  beforeEach(() => {
    assert(!retainedFailure, 'DELIVERY_RETAINED_FAILURE: subsequent bodies must not mutate the failed fixture')
    installOwnedDeliveryProvider()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state !== 'pass' || retainedFailure) { retainedFailure = true; retainedDeliveryContext = true; return }
    if (activePushes.size) { retainedFailure = true; retainedDeliveryContext = true; throw new Error('Delivery pending job after body: retained incomplete fixture') }
    try {
      restoreOwnedDeliveryProvider()
      if (users.length) { await db.query('delete from users where id=any($1::uuid[])', [[...users]]); users.splice(0) }
      observedPassedBodies++
    } catch (error) { retainedFailure = true; retainedDeliveryContext = true; throw error }
  })
  afterAll(async () => { await preserveDeliveryDatabase(db, retainedFailure, observedPassedBodies) })

  async function fixture(count = 1) {
    const user = randomUUID(); users.push(user)
    await db.query("insert into users(id,phone,tz) values($1,$2,'UTC')", [user, `+1555${randomInt(1_000_000_000, 9_999_999_999)}`])
    await db.query("insert into notification_prefs(user_id,quiet_from,quiet_to) values($1,'00:00','00:00')", [user])
    const id = randomUUID()
    await db.query(`insert into notifications(id,user_id,kind,title,body,link,deliver_after)
      values($1,$2,'system','Wedding update','Only this notice','/wedding/dayx',now()-interval '1 minute')`, [id, user])
    const subscriptions: string[] = []
    for (let i = 0; i < count; i++) {
      const sub = randomUUID(); subscriptions.push(sub)
      await db.query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4)',
        [sub, user, `https://push.example.invalid/${sub}`, JSON.stringify({ p256dh: 'test', auth: 'test' })])
    }
    return { user, id, subscriptions }
  }
  const rows = async (id: string) => (await db.query<{
    status: string; attempts: number; provider_accepted_at: Date | null; lease_token: string | null;
    lease_until: Date | null; last_error: string | null; next_attempt_at: Date; subscription_id: string
  }>('select * from notification_push_deliveries where notification_id=$1 order by subscription_id', [id])).rows
  const settled = async (id: string) => (await db.query<{ pushed_at: Date | null; cancelled_at: Date | null }>(
    'select pushed_at,cancelled_at from notifications where id=$1', [id])).rows[0]!
  const retryNow = async (id: string) => db.query(`update notification_push_deliveries
    set next_attempt_at=now()-interval '1 second' where notification_id=$1 and status='retry_wait'`, [id])
  function failQueryOnce(predicate: (sql: string, values?: readonly unknown[]) => boolean): Db {
    let failed = false
    return { ...db, async query<T extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (!failed && predicate(sql, values)) { failed = true; throw new Error('controlled database failure') }
      return db.query<T>(sql, values)
    } }
  }
  async function taskFixture() {
    const f = await fixture()
    const wedding = randomUUID(), task = randomUUID()
    await db.query("update users set tz='UTC' where id=$1", [f.user])
    await db.query("insert into weddings(id,owner_id,title,tz,invite_code) values($1,$2,'Delivery test','UTC',$3)", [wedding, f.user, randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [wedding, f.user])
    await db.query(`insert into tasks(id,wedding_id,title,assignee_id,due,reminder_days_before)
      values($1,$2,'Confirm the venue',$3,current_date+1,1)`, [task, wedding, f.user])
    await db.query(`update notifications set kind='task',task_id=$2,task_version=0,
      task_event='assignment',expires_at=now()+interval '1 day' where id=$1`, [f.id, task])
    return { ...f, wedding, task }
  }
  function onFirstRead(id: string, action: () => Promise<unknown>): Db {
    let acted = false
    return { ...db, async query<T extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (!acted && sql.includes('select n.title,n.body') && values?.[0]===id) { acted = true; await action() }
      return db.query<T>(sql, values)
    } }
  }

  it('accepts once per subscription, retains inbox and stable identity, with timeout shorter than lease', async () => {
    const f = await fixture(2)
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(2)
    expect((await rows(f.id)).map(r => r.status)).toEqual(['provider_accepted', 'provider_accepted'])
    expect((await rows(f.id)).every(r => r.attempts===1 && r.provider_accepted_at && !r.lease_token && !r.lease_until)).toBe(true)
    expect((await settled(f.id)).pushed_at).not.toBeNull()
    const call = ownCalls(f.id)[0]!
    expect(JSON.parse(String(call[1]))).toEqual({ title: 'Wedding update', body: 'Only this notice',
      data: { link: '/wedding/dayx', notificationId: f.id } })
    expect(call[2]?.timeout).toBe(PUSH_TIMEOUT_MS)
    expect(PUSH_TIMEOUT_MS).toBeLessThan(PUSH_LEASE_MS)
    expect(call[2]?.TTL).toBeGreaterThan(0)
    expect(call[2]?.TTL).toBeLessThanOrEqual(86_400)
  })

  it('temporary network failure stays retryable without marking acceptance and recovers on later pass', async () => {
    const f = await fixture()
    send().mockRejectedValue(new Error('network with secret endpoint must not be persisted'))
    await sendDuePushes(db, config)
    const failed = (await rows(f.id))[0]!
    expect(failed.status).toBe('retry_wait'); expect(failed.attempts).toBe(1)
    expect(failed.provider_accepted_at).toBeNull(); expect(failed.last_error).toBe('transport_failure')
    expect(failed.next_attempt_at.getTime()).toBeGreaterThan(Date.now()+45_000)
    expect((await settled(f.id)).pushed_at).toBeNull()
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(1)
    await retryNow(f.id); send().mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    await sendDuePushes(db, config)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
    expect((await rows(f.id))[0]?.attempts).toBe(2)
    expect(ownCalls(f.id).map(c => JSON.parse(String(c[1])).data.notificationId)).toEqual([f.id, f.id])
  })

  it.each([408, 429, 503])('HTTP %s is retried within the bound', async statusCode => {
    const f = await fixture(); send().mockRejectedValue({ statusCode })
    await sendDuePushes(db, config)
    expect((await rows(f.id))[0]?.status).toBe('retry_wait')
    expect((await rows(f.id))[0]?.last_error).toBe(`http_${statusCode}`)
  })

  it('stops at five failed attempts, retaining notice and subscription', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 503 })
    for (let i = 0; i < PUSH_MAX_ATTEMPTS; i++) { await retryNow(f.id); await sendDuePushes(db, config) }
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(PUSH_MAX_ATTEMPTS)
    expect((await rows(f.id))[0]?.status).toBe('permanent_failure')
    expect((await rows(f.id))[0]?.provider_accepted_at).toBeNull()
    expect((await settled(f.id)).pushed_at).not.toBeNull()
    expect((await db.query('select id from push_subscriptions where user_id=$1', [f.user])).rowCount).toBe(1)
  })

  it.each([404, 410])('HTTP %s removes only the gone subscription and preserves delivery history', async statusCode => {
    const f = await fixture(2); const gone = f.subscriptions[0]!
    send().mockImplementation(async subscription => {
      if (subscription.endpoint.endsWith(gone)) throw { statusCode }
      return { statusCode: 201, body: '', headers: {} }
    })
    const result = await sendDuePushes(db, config)
    expect(result.dropped).toBeGreaterThanOrEqual(1)
    const history = await rows(f.id)
    expect(history.find(r => r.subscription_id===gone)?.status).toBe('permanent_failure')
    expect(history.find(r => r.subscription_id!==gone)?.status).toBe('provider_accepted')
    expect((await db.query('select id from push_subscriptions where id=$1', [gone])).rowCount).toBe(0)
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(2)
  })

  it('permanent payload refusal does not delete a still-existing subscription or fake acceptance', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 413 })
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('permanent_failure')
    expect((await rows(f.id))[0]?.provider_accepted_at).toBeNull()
    expect((await db.query('select id from push_subscriptions where user_id=$1', [f.user])).rowCount).toBe(1)
  })

  it('gone response racing subscription reassignment does not delete or cancel the new owner’s queue', async () => {
    const f = await fixture(); const other = await fixture(0)
    send().mockImplementationOnce(async () => {
      await db.query('update push_subscriptions set user_id=$2 where id=$1', [f.subscriptions[0], other.user])
      await db.query('update notifications set pushed_at=null where id=$1', [other.id])
      await db.query(`insert into notification_push_deliveries(notification_id,subscription_id)
        values($1,$2)`, [other.id, f.subscriptions[0]])
      throw { statusCode: 410 }
    })
    // One outbound attempt, so the new owner's queued row can be inspected.
    await sendDuePushes(db, config, 1)
    expect((await db.query('select user_id from push_subscriptions where id=$1', [f.subscriptions[0]])).rows[0]?.user_id).toBe(other.user)
    expect((await rows(other.id))[0]?.status).toBe('queued')
    await sendDuePushes(db, config)
    expect((await rows(other.id))[0]?.status).toBe('provider_accepted')
    expect(ownCalls(other.id)).toHaveLength(1)
  })

  it.each([201, 410, 503])('late HTTP %s result cannot overwrite a newer lease or remove its subscription', async statusCode => {
    const f = await fixture(), replacement = randomUUID(), additional = randomUUID()
    await db.query(`insert into notifications(id,user_id,kind,title,body,deliver_after)
      values($1,$2,'system','Future','Future notice',now()+interval '10 minutes')`, [additional, f.user])
    await db.query('insert into notification_push_deliveries(notification_id,subscription_id) values($1,$2)', [additional, f.subscriptions[0]])
    send().mockImplementationOnce(async () => {
      await db.query(`update notification_push_deliveries set lease_token=$2,attempts=2,
        lease_until=now()+interval '1 minute' where notification_id=$1`, [f.id, replacement])
      if (statusCode!==201) throw { statusCode }
      return { statusCode, body: '', headers: {} }
    })
    const outcome = await sendDuePushes(db, config, 1)
    expect(outcome.sent).toBe(statusCode===201 ? 1 : 0) // Successful calls, not persisted/device acceptance.
    expect(outcome.dropped).toBe(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'claimed', lease_token: replacement, attempts: 2,
      provider_accepted_at: null, last_error: null })
    expect((await rows(additional))[0]?.status).toBe('queued')
    expect((await db.query('select id from push_subscriptions where id=$1', [f.subscriptions[0]])).rowCount).toBe(1)
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('expired lease with unchanged token cannot authorize a late gone cleanup', async () => {
    const f = await fixture()
    send().mockImplementationOnce(async () => {
      await db.query("update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1", [f.id])
      throw { statusCode: 410 }
    })
    const outcome = await sendDuePushes(db, config, 1)
    expect(outcome.dropped).toBe(0)
    expect((await rows(f.id))[0]?.status).toBe('claimed')
    expect((await db.query('select id from push_subscriptions where id=$1', [f.subscriptions[0]])).rowCount).toBe(1)
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('gone cleanup database failure rolls back terminal transition and keeps the claim recoverable', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 410 })
    const faulty: Db = { ...db, tx<T>(action: (client: Queryable) => Promise<T>): Promise<T> {
      return db.tx(client => action({ async query<R extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
        if (/^\s*delete\s+from\s+push_subscriptions\b/i.test(sql) && /\bwhere\b/i.test(sql) && values?.[0]===f.id) throw new Error('Controlled gone cleanup failure')
        return client.query<R>(sql, values)
      } }))
    } }
    await expect(sendDuePushes(faulty, config)).rejects.toThrow('Controlled gone cleanup failure')
    expect((await rows(f.id))[0]).toMatchObject({ status: 'claimed', last_error: null, provider_accepted_at: null })
    expect((await db.query('select id from push_subscriptions where id=$1', [f.subscriptions[0]])).rowCount).toBe(1)
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('recovers an expired pre-send lease, but will not take a live lease', async () => {
    const f = await fixture()
    await db.query(`insert into notification_push_deliveries(notification_id,subscription_id,status,attempts,lease_token,lease_until)
      values($1,$2,'claimed',1,$3,now()+interval '1 minute')`, [f.id, f.subscriptions[0], randomUUID()])
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(0)
    await db.query(`update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1`, [f.id])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.attempts).toBe(2)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
  })

  it('final crashed lease exhausts safely without a sixth call', async () => {
    const f = await fixture()
    await db.query(`insert into notification_push_deliveries(notification_id,subscription_id,status,attempts,lease_token,lease_until)
      values($1,$2,'claimed',5,$3,now()-interval '1 second')`, [f.id, f.subscriptions[0], randomUUID()])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('permanent_failure')
    expect((await rows(f.id))[0]?.last_error).toBe('attempt_limit')
  })

  it('concurrent workers share claims without duplicate sends', async () => {
    const f = await fixture(3)
    await Promise.all([sendDuePushes(db, config), sendDuePushes(db, config), sendDuePushes(db, config)])
    expect(ownCalls(f.id)).toHaveLength(3)
    expect((await rows(f.id)).every(r => r.status==='provider_accepted' && r.attempts===1)).toBe(true)
  })

  it('does not lease another subscription while the first provider call is pending', async () => {
    const f = await fixture(2)
    let enter!: () => void, complete!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const pending = new Promise<void>(resolve => { complete = resolve })
    send().mockImplementationOnce(async () => { enter(); await pending; return { statusCode: 201, body: '', headers: {} } })
    const worker = sendDuePushes(db, config)
    try {
      await Promise.race([entered, worker])
      expect((await rows(f.id)).map(r => r.status).sort()).toEqual(['claimed', 'queued'])
      expect((await settled(f.id)).pushed_at).toBeNull()
    } finally { complete(); await worker }
    expect(ownCalls(f.id)).toHaveLength(2)
  })

  it('claims exactly one under a nested-loop plan even with many subscriptions', async () => {
    const f = await fixture(12)
    const nested: Db = { ...db, async query<T extends pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (!sql.includes('returning d.notification_id')) return db.query<T>(sql, values)
      return db.tx(async client => {
        await client.query('set local enable_hashjoin=off')
        await client.query('set local enable_mergejoin=off')
        await client.query('set local enable_material=off')
        return client.query<T>(sql, values)
      })
    } }
    let enter!: () => void, complete!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const pending = new Promise<void>(resolve => { complete = resolve })
    send().mockImplementationOnce(async () => { enter(); await pending; return { statusCode: 201, body: '', headers: {} } })
    const worker = sendDuePushes(nested, config)
    try {
      await Promise.race([entered, worker])
      const snapshot = await rows(f.id)
      expect(snapshot.filter(r => r.status==='claimed')).toHaveLength(1)
      expect(snapshot.filter(r => r.status==='queued')).toHaveLength(11)
    } finally { complete(); await worker }
    expect(ownCalls(f.id)).toHaveLength(12)
    expect((await rows(f.id)).every(r => r.status==='provider_accepted' && r.attempts===1)).toBe(true)
  })

  it('pass budget yields with remaining subscriptions queued and never leased', async () => {
    const f = await fixture(8)
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    send().mockImplementation(async () => {
      elapsed += PUSH_PASS_BUDGET_MS/2
      return { statusCode: 201, body: '', headers: {} }
    })
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(2)
    const snapshot = await rows(f.id)
    expect(snapshot.filter(r => r.status==='provider_accepted')).toHaveLength(2)
    expect(snapshot.filter(r => r.status==='queued' && r.attempts===0 && !r.lease_token)).toHaveLength(6)
    expect(snapshot.some(r => r.status==='claimed')).toBe(false)
    expect((await settled(f.id)).pushed_at).toBeNull()
    vi.mocked(performance.now).mockRestore()
    send().mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(8)
  })

  it('budget expiring after claim releases it unsent for another pass', async () => {
    const f = await fixture()
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    const slowRead = onFirstRead(f.id, async () => { elapsed = PUSH_PASS_BUDGET_MS })
    await sendDuePushes(slowRead, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'queued', attempts: 0, lease_token: null })
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('preflight deferral is re-read, queued without spending an attempt, and never handed off', async () => {
    const f = await fixture()
    const guard = vi.spyOn(preflight, 'notificationPushReady').mockImplementation(async (client: Queryable, notificationId: string) => {
      await client.query("update notifications set deliver_after=now()+interval '1 hour' where id=$1", [notificationId])
      return false
    })
    await sendDuePushes(db, config)
    expect(guard).toHaveBeenCalledWith(db, f.id)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'queued', attempts: 0, lease_token: null })
    expect((await settled(f.id)).pushed_at).toBeNull()
  })

  it('preflight suppression remains in inbox without pretending provider acceptance', async () => {
    const f = await fixture()
    vi.spyOn(preflight, 'notificationPushReady').mockResolvedValue(false)
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'cancelled', attempts: 0, provider_accepted_at: null })
    expect((await settled(f.id)).cancelled_at).toBeNull()
  })

  it.each(['inbox_only', 'processed'])('explicit %s notice is never initialized even without legacy timestamp', async disposition => {
    const f = await fixture()
    await db.query('update notifications set push_disposition=$2,pushed_at=null where id=$1', [f.id, disposition])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect(await rows(f.id)).toHaveLength(0)
    expect((await settled(f.id)).pushed_at).toBeNull()
    expect((await db.query('select push_disposition from notifications where id=$1', [f.id])).rows[0]?.push_disposition).toBe(disposition)
  })

  it('actual preflight notices current channel opt-out, retains inbox and cancels unsent attempt', async () => {
    const f = await fixture()
    await db.query("update notifications set kind='chat' where id=$1", [f.id])
    await db.query('update notification_prefs set chats=false where user_id=$1', [f.user])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'cancelled', attempts: 0, provider_accepted_at: null })
    expect((await settled(f.id)).cancelled_at).toBeNull()
    expect((await db.query('select push_disposition from notifications where id=$1', [f.id])).rows[0]?.push_disposition).toBe('inbox_only')
  })

  it('absolute deadline aborts the disposable agent even if a provider promise never settles', async () => {
    const f = await fixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const destroy = vi.spyOn(Agent.prototype, 'destroy')
    send().mockImplementationOnce(async () => { enter(); return new Promise(() => {}) })
    const worker = sendDuePushes(db, config)
    await Promise.race([entered, worker])
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS)
    await worker
    expect(destroy).toHaveBeenCalled()
    expect((await rows(f.id))[0]?.status).toBe('retry_wait')
    expect((await rows(f.id))[0]?.provider_accepted_at).toBeNull()
    expect(ownCalls(f.id)).toHaveLength(1)
  })

  it('pre-send database failure leaves the claim recoverable without a provider call', async () => {
    const f = await fixture()
    const faulty = failQueryOnce((sql, values) => sql.includes('select n.title,n.body') && values?.[0]===f.id)
    await expect(sendDuePushes(faulty, config)).rejects.toThrow('controlled database failure')
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('claimed')
    expect((await settled(f.id)).pushed_at).toBeNull()
    await db.query("update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1", [f.id])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
  })

  it('known provider acceptance with failed persistence is ambiguous until lease recovery, not a fake transport failure', async () => {
    const f = await fixture()
    const faulty = failQueryOnce((sql, values) => sql.includes('provider_accepted_at=case') && values?.[0]===f.id)
    await expect(sendDuePushes(faulty, config)).rejects.toThrow('controlled database failure')
    expect(ownCalls(f.id)).toHaveLength(1)
    const pending = (await rows(f.id))[0]!
    expect(pending.status).toBe('claimed'); expect(pending.provider_accepted_at).toBeNull()
    expect(pending.last_error).toBeNull(); expect((await settled(f.id)).pushed_at).toBeNull()
    await db.query("update notification_push_deliveries set lease_until=now()-interval '1 second' where notification_id=$1", [f.id])
    await sendDuePushes(db, config)
    // Two submissions are possible in this crash window: no exactly-once promise.
    expect(ownCalls(f.id)).toHaveLength(2)
    expect(ownCalls(f.id).map(c => JSON.parse(String(c[1])).data.notificationId)).toEqual([f.id, f.id])
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
  })

  it('cancellation after handoff cannot undo acceptance or cause another send', async () => {
    const f = await fixture()
    send().mockImplementationOnce(async () => {
      await db.query('update notifications set cancelled_at=now() where id=$1', [f.id])
      return { statusCode: 201, body: '', headers: {} }
    })
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
    expect((await settled(f.id)).cancelled_at).not.toBeNull()
  })

  it('task completion after claim prevents provider I/O', async () => {
    const f = await taskFixture()
    const changing = onFirstRead(f.id, () => db.query('update tasks set done_at=now() where id=$1', [f.task]))
    await sendDuePushes(changing, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
    expect((await settled(f.id)).cancelled_at).not.toBeNull()
  })

  it('task channel opt-out after claim prevents provider I/O', async () => {
    const f = await taskFixture()
    const changing = onFirstRead(f.id, () => db.query('update notification_prefs set tasks=false where user_id=$1', [f.user]))
    await sendDuePushes(changing, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
    expect((await rows(f.id))[0]?.attempts).toBe(0)
  })

  it('quiet-hour edit after claim releases unsent task without burning attempts and later resumes once', async () => {
    const f = await taskFixture()
    const changing = onFirstRead(f.id, () => db.query(`update notification_prefs set
      quiet_from=(now() at time zone 'UTC'-interval '1 minute')::time,
      quiet_to=(now() at time zone 'UTC'+interval '10 minutes')::time where user_id=$1`, [f.user]))
    await sendDuePushes(changing, config)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]?.status).toBe('queued')
    expect((await rows(f.id))[0]?.attempts).toBe(0)
    expect((await settled(f.id)).pushed_at).toBeNull()
    await sendDuePushes(db, config); expect(ownCalls(f.id)).toHaveLength(0)
    await db.query("update notification_prefs set quiet_from='00:00',quiet_to='00:00' where user_id=$1", [f.user])
    await db.query('update notifications set deliver_after=now() where id=$1', [f.id])
    await db.query('update notification_push_deliveries set next_attempt_at=now() where notification_id=$1', [f.id])
    await sendDuePushes(db, config); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('provider_accepted')
    expect((await rows(f.id))[0]?.attempts).toBe(1)
  })

  it('cancellation between attempts stops retry, preserving inbox history', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 503 })
    await sendDuePushes(db, config)
    await db.query('update notifications set cancelled_at=now() where id=$1', [f.id])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
    expect((await settled(f.id)).cancelled_at).not.toBeNull()
  })

  it('subscription ownership changes prevent later retry to the new account', async () => {
    const f = await fixture(); const other = await fixture(0)
    send().mockRejectedValue({ statusCode: 503 }); await sendDuePushes(db, config)
    await db.query('update push_subscriptions set user_id=$2 where id=$1', [f.subscriptions[0], other.user])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('cancelled')
  })

  it('deleted account and removed subscription suppress queued retries', async () => {
    const f = await fixture(2); send().mockRejectedValue({ statusCode: 503 })
    await sendDuePushes(db, config)
    await db.query('delete from push_subscriptions where id=$1', [f.subscriptions[0]])
    await db.query('update users set deleted_at=now() where id=$1', [f.user])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(2)
    expect((await rows(f.id)).every(r => r.status==='cancelled')).toBe(true)
  })

  it('expiry stops retry without deleting the inbox notice', async () => {
    const f = await fixture(); send().mockRejectedValue({ statusCode: 503 }); await sendDuePushes(db, config)
    await db.query("update notifications set deliver_after=now()-interval '25 hours' where id=$1", [f.id])
    await retryNow(f.id); await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(1)
    expect((await rows(f.id))[0]?.status).toBe('expired')
    expect((await settled(f.id)).pushed_at).not.toBeNull()
  })

  it.each(['age', 'task_deadline'])('expiry by %s between claim and ready is expired rather than cancelled', async source => {
    const f = source==='task_deadline' ? await taskFixture() : await fixture()
    const expiring = onFirstRead(f.id, () => db.query(source==='age'
      ? "update notifications set deliver_after=now()-interval '25 hours' where id=$1"
      : "update notifications set expires_at=now()-interval '1 second' where id=$1", [f.id]))
    const outcome = await sendDuePushes(expiring, config)
    expect(outcome.expired).toBeGreaterThanOrEqual(1)
    expect(ownCalls(f.id)).toHaveLength(0)
    expect((await rows(f.id))[0]).toMatchObject({ status: 'expired', last_error: 'push_window_expired', attempts: 0 })
    expect((await settled(f.id)).pushed_at).not.toBeNull()
  })

  it('new expired notice and no-subscription notice settle without provider acceptance', async () => {
    const f = await fixture(); const none = await fixture(0)
    await db.query("update notifications set deliver_after=now()-interval '25 hours' where id=$1", [f.id])
    await sendDuePushes(db, config)
    expect(ownCalls(f.id)).toHaveLength(0); expect(ownCalls(none.id)).toHaveLength(0)
    expect(await rows(f.id)).toHaveLength(0); expect(await rows(none.id)).toHaveLength(0)
    expect((await settled(f.id)).pushed_at).not.toBeNull()
    expect((await settled(none.id)).pushed_at).not.toBeNull()
  })

  it('without VAPID retains pending notices and creates no delivery attempts', async () => {
    const f = await fixture()
    expect(await sendDuePushes(db, { ...config, vapidPrivateKey: null })).toEqual({ sent: 0, dropped: 0, expired: 0 })
    expect(await rows(f.id)).toHaveLength(0); expect((await settled(f.id)).pushed_at).toBeNull()
    expect(ownCalls(f.id)).toHaveLength(0)
  })

  it('bounded shared-queue backlog needs three passes without duplicate own provider acceptance', async () => {
    const foreign = await fixture(0), own = await fixture(2)
    await db.query("update notifications set deliver_after=now()-interval '2 minutes' where id=$1", [foreign.id])
    const extra = (await db.query<{ id: string }>(`insert into notifications(id,user_id,kind,title,body,link,deliver_after)
      select gen_random_uuid(),$1,'system','Owned backlog','Synthetic no subscription notice','/wedding/dayx',now()-interval '2 minutes'
      from generate_series(1,399) returning id`, [foreign.user])).rows.map(r => r.id)
    const foreignIds = [foreign.id,...extra]; expect(foreignIds).toHaveLength(400)
    const settledForeign = async () => Number((await db.query<{ n: string }>("select count(*)::text n from notifications where id=any($1::uuid[]) and pushed_at is not null and push_disposition='processed'", [foreignIds])).rows[0]!.n)
    expect((await db.query('select id from push_subscriptions where user_id=$1', [foreign.user])).rows).toEqual([])
    const first = await sendDuePushes(db, config), afterFirst = await settledForeign()
    expect(ownCalls(own.id)).toHaveLength(0); expect(await rows(own.id)).toEqual([]); expect(afterFirst).toBe(200)
    const second = await sendDuePushes(db, config), afterSecond = await settledForeign()
    expect(ownCalls(own.id)).toHaveLength(0); expect(await rows(own.id)).toEqual([]); expect(afterSecond).toBe(400)
    const foreignRaw = async () => (await db.query<{ raw: string }>('select row_to_json(t)::text raw from notifications t where id=any($1::uuid[]) order by id', [foreignIds])).rows.map(r => r.raw)
    const retained = await foreignRaw(), third = await sendDuePushes(db, config)
    expect(ownCalls(own.id)).toHaveLength(2)
    const accepted = await rows(own.id)
    expect(accepted).toHaveLength(2); expect(accepted.every(r => r.status==='provider_accepted' && r.attempts===1 && r.provider_accepted_at && !r.lease_token && !r.lease_until)).toBe(true)
    expect(new Set(accepted.map(r => r.subscription_id))).toEqual(new Set(own.subscriptions))
    expect((await settled(own.id)).pushed_at).not.toBeNull(); expect(await foreignRaw()).toEqual(retained)
    expect(ownCalls(foreign.id)).toHaveLength(0)
    deliveryArtifact('backlog-control.json', { foreignUser: foreign.user, ownNotice: own.id, earlierNoSubscriptionCount: foreignIds.length,
      first, second, third, processedAfterFirst: afterFirst, processedAfterSecond: afterSecond, ownAcceptedCalls: ownCalls(own.id).length,
      accepted, earlierRowsLiteralAfterThird: true, rootMayVerifyActualAssertions: true })
  })
})
