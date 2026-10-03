import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Db, Queryable } from '../src/plugins/db.js'

// Intended placement: backend/test/c04ProfileDefaultOrders.test.ts.
// Independent HTTP/state oracles; no candidate writer/helper/SQL is imported.
const PRIMARY = 'tili_ecosystem_c04prefs_20261003_test'
const FULL = 'tili_ecosystem_full_20260930_test'
const APPLICATION = 'c04prefs_' + randomUUID()
const ACCESS = 'synthetic-c04-profile-access'.repeat(3)
const REFRESH = 'synthetic-c04-profile-refresh'.repeat(3)
const POLICY = '2026-09-02'
const DATABASE = process.env.TEST_DATABASE_URL
const ROOT_ATTESTATION = 'C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-root-createdb.json'
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
type Kind = 'users' | 'sessions' | 'consents' | 'otp'
interface Material {
  user: { name: string | null; lang: string; tz: string | null }
  prefs: { tasks: boolean; chats: boolean; deals: boolean; tips: boolean; urgent: boolean; from: string; to: string } | null
}
interface Waiter { pid: number; datname: string; application_name: string; state: string; wait_event_type: string | null; query: string; blockers: number[] }
interface Probe {
  after?: (sql: string, values: readonly unknown[] | undefined, client: Queryable, scope: 'pool' | 'tx') => Promise<void>
}
interface Gate { entered: Promise<void>; pause(): Promise<void>; open(): void }
const userStatement = (sql: string, values: readonly unknown[] | undefined, id: string) =>
  /^\s*update\s+users\b/i.test(sql) && values?.includes(id) === true
const userWait = (sql: string) => /\busers\b/i.test(sql) && (/^\s*update\s+users\b/i.test(sql) || /\bfor\s+update\b/i.test(sql))

describe.sequential('C04 profile/default creator orders: real registered HTTP plus PostgreSQL', () => {
  let app: FastifyInstance | undefined, raw: Db | undefined, observer: pg.Client | undefined
  let url = '', databaseName = '', probe: Probe = {}
  const transactionPids = new WeakMap<object, number>()
  const ids: Record<Kind, Set<string>> = { users: new Set(), sessions: new Set(), consents: new Set(), otp: new Set() }
  const phones = new Set<string>(), createdUsers = new Set<string>(), controllers = new Set<pg.Client>(), requests = new Set<Promise<Response>>(), gates = new Set<Gate>()
  function note(value: object) { process.stdout.write(`C04_PREFS_WITNESS ${JSON.stringify(value)}\n`) }
  function journal(kind: Kind, id: string): string {
    assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
    if (!ids[kind].has(id)) { ids[kind].add(id); note({ kind, id, beforeWrite: true }) }
    return id
  }
  const allocate = (kind: Kind) => journal(kind, randomUUID())
  const db = () => { assert(raw, 'preflight did not initialize raw DB'); return raw }
  const observe = () => { assert(observer, 'preflight did not initialize observer'); return observer }
  const getApp = () => { assert(app, 'preflight did not initialize app'); return app }
  function deferred(): Gate {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), wait = new Promise<void>(resolve => { release = resolve })
    const result = { entered, async pause() { enter(); await wait }, open() { release() } }
    gates.add(result); return result
  }
  async function bounded<T>(promise: Promise<T>, label: string, ms = 8_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ': bounded deadline')), ms) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  async function identity(client: Queryable) {
    const row = (await client.query<{ name: string; username: string; address: string; port: number; oid: string; pid: number }>(`select current_database() as name,current_user as username,
      host(inet_server_addr()) as address,inet_server_port() as port,pg_backend_pid() as pid,
      (select oid::text from pg_database where datname=current_database()) as oid`)).rows[0]!
    assert.equal(row.name, databaseName); assert.equal(row.username, 'codex_test'); assert.equal(row.port, 15432)
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(row.address))
    if (databaseName === PRIMARY) assert.equal(row.oid, '612840', 'focused target must be the root-created database, not a reused name')
    return row
  }
  function forwarding(): Db {
    const wrap = (client: Queryable, scope: 'pool' | 'tx'): Queryable => ({
      async query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<pg.QueryResult<T>> {
        if (/^\s*insert\s+into\s+users\b/i.test(sql) && typeof values?.[0] === 'string' && values.some(v => typeof v === 'string' && phones.has(v))) journal('users', values[0])
        if (/^\s*insert\s+into\s+sessions\b/i.test(sql) && typeof values?.[0] === 'string' && values.some(v => typeof v === 'string' && ids.users.has(v))) journal('sessions', values[0])
        const result = await client.query<T>(sql, values)
        await probe.after?.(sql, values, client, scope)
        return result
      },
    })
    return { query: wrap(db(), 'pool').query, tx: action => db().tx(async client => {
      const actual = await identity(client)
      transactionPids.set(client, actual.pid)
      const xid = (await client.query<{ xid: string }>('select txid_current()::text as xid')).rows[0]!.xid
      note({ event: 'owned-callback', pid: actual.pid, xid })
      return action(wrap(client, 'tx'))
    }), ping: () => db().ping(), close: () => db().close() }
  }
  beforeAll(async () => {
    assert(DATABASE, 'TEST_DATABASE_URL is mandatory; no skipped PostgreSQL tests')
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert.equal(target.hostname, '127.0.0.1')
    assert.equal(target.username, 'codex_test'); assert.equal(target.password, ''); assert.equal(target.port, '15432')
    assert.equal(target.search, ''); assert.equal(target.hash, ''); databaseName = target.pathname.slice(1)
    assert([PRIMARY, FULL].includes(databaseName), 'refuse any unapproved/shared/production target')
    if (databaseName === PRIMARY) {
      const file = process.env.C04_PREFS_CREATION_ATTESTATION ?? ROOT_ATTESTATION
      const proof = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      assert.equal(proof.kind, 'root_actual_absent_before_create'); assert.equal(proof.absentBeforeCreate, true)
      assert.equal(proof.beforeRowCount, 0); assert.equal(proof.targetName, PRIMARY)
      assert.equal(proof.targetURL, `postgres://codex_test@127.0.0.1:15432/${PRIMARY}`)
      assert.equal(proof.databaseOID, '612840'); assert.equal(proof.actualMain, '03f41a0f12bbd369450501fb30e2381972b15b0c')
      const admin = proof.actualAdmin as Record<string, unknown>
      assert.equal(admin.database, 'postgres'); assert.equal(admin.username, 'codex_test')
      assert.equal(admin.port, 15432); assert.equal(admin.address, '127.0.0.1')
      note({ event: 'root-creation-attestation', databaseOID: proof.databaseOID, beforeRowCount: proof.beforeRowCount, actualMain: proof.actualMain })
    }
    target.searchParams.set('application_name', APPLICATION); url = target.href
    observer = new pg.Client({ connectionString: url.replace(APPLICATION, APPLICATION + '_observer') })
    await observer.connect(); const actual = await identity(observer); note({ event: 'live-preflight', actual, fullTargetNoPrivateAttestation: databaseName === FULL })
    app = await buildApp({ env: 'test', databaseUrl: url, redisUrl: null, corsOrigins: [], jwtAccessSecret: ACCESS,
      jwtRefreshSecret: REFRESH, policyVersion: POLICY, rateLimitPerSecond: 0 }, [], { tillyModel: null })
    await app.ready(); raw = app.db!; await identity(raw); app.db = forwarding()
  }, 20_000)
  async function release(client: pg.Client) {
    if (!controllers.has(client)) return
    try { await client.query('rollback') } finally { await client.end(); controllers.delete(client) }
  }
  async function settleAll() {
    const failures: unknown[] = []
    for (const gate of gates) gate.open(); gates.clear()
    for (const client of [...controllers]) {
      try { await release(client) } catch (error) { failures.push(error); note({ event: 'controller-cleanup-failure', message: String(error) }) }
    }
    try { await bounded(Promise.allSettled([...requests]), 'settle owned HTTP', 9_000) }
    catch (error) {
      failures.push(error)
      note({ event: 'settle-failure', message: String(error) })
      try {
        const active = (await observe().query<{ pid: number }>('select pid from pg_stat_activity where datname=$1 and application_name=$2 and state=\'active\'', [databaseName, APPLICATION])).rows
        for (const row of active) { assert(row.pid > 0); note({ event: 'cancel-owned-app-query', pid: row.pid }); await observe().query('select pg_cancel_backend($1)', [row.pid]) }
        await bounded(Promise.allSettled([...requests]), 'settle after owned cancellation', 5_000)
      } catch (cleanup) { failures.push(cleanup); note({ event: 'owned-cancellation-failure', message: String(cleanup) }) }
    } finally { probe = {} }
    if (failures.length) throw new AggregateError(failures, 'owned HTTP/controller cleanup failed')
  }
  afterEach(async () => { if (raw) await settleAll() }, 20_000)
  afterAll(async () => {
    const failures: unknown[] = []
    try {
      if (raw) {
        try { await settleAll() } catch (error) { failures.push(error) }
        // Cleanup still runs after a settling failure; it never acquires another DB.
        await identity(raw)
        // Allocated but failed/ignored INSERT UUIDs do not establish row ownership.
        const users = [...createdUsers]
        // Audit is append-only and has no actor FK. Preserve its original scoped facts.
        const auditSql = 'select id::text as id,actor_id,action,entity,entity_id,at from audit_log where actor_id=any($1::uuid[]) order by id'
        const auditBefore = (await raw.query(auditSql, [users])).rows
        note({ event: 'intentional-audit-retention-before-user-cleanup', count: auditBefore.length, rows: auditBefore })
        await raw.query('delete from otp_codes where id=any($1::uuid[])', [[...ids.otp]])
        for (const id of users) await raw.query('delete from users where id=$1', [id])
        const counts = (await raw.query<Record<string, string>>(`select
          (select count(*)::text from users where id=any($1::uuid[])) as users,
          (select count(*)::text from sessions where id=any($2::uuid[]) or user_id=any($1::uuid[])) as sessions,
          (select count(*)::text from consents where id=any($3::uuid[]) or user_id=any($1::uuid[])) as consents,
          (select count(*)::text from notification_prefs where user_id=any($1::uuid[])) as prefs,
          (select count(*)::text from otp_codes where id=any($4::uuid[])) as otp,
          (select count(*)::text from notifications where user_id=any($1::uuid[])) as notices`,
        [users, [...ids.sessions], [...ids.consents], [...ids.otp]])).rows[0]!
        const auditAfter = (await raw.query(auditSql, [users])).rows
        note({ event: 'fixture-cleanup', counts, retainedAuditCount: auditAfter.length, retainedAudits: auditAfter,
          manifest: Object.fromEntries(Object.entries(ids).map(([kind, values]) => [kind, [...values]])) })
        expect(counts).toEqual({ users: '0', sessions: '0', consents: '0', prefs: '0', otp: '0', notices: '0' })
        expect(auditAfter).toEqual(auditBefore)
      }
    } catch (error) { failures.push(error); note({ event: 'fixture-cleanup-failure', message: String(error) }) }
    finally {
      try { if (app) { if (raw) app.db = raw; await app.close() } } catch (error) { failures.push(error) }
      try { await observer?.end() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'C04 cleanup failed; preserve original case failures too')
  }, 25_000)
  async function actor(prefs = true, consent = true) {
    const id = allocate('users'), sid = allocate('sessions'), cid = allocate('consents')
    let phone = ''
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = '+79' + randomInt(100_000_000, 999_999_999)
      phones.add(candidate) // Stored only in process memory; never sent to a provider or logged.
      const inserted = await db().query('insert into users(id,phone,name,lang,tz) values($1,$2,$3,\'ru\',\'UTC\') on conflict(phone) do nothing returning id', [id, candidate, 'Synthetic profile fixture'])
      if (inserted.rows[0]?.id === id) { phone = candidate; createdUsers.add(id); break }
    }
    assert(phone, 'eight atomic phone attempts exhausted')
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    if (consent) await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [cid, id, POLICY])
    if (prefs) await db().query("insert into notification_prefs(user_id,tasks,chats,deals,tips,quiet_from,quiet_to,urgent_incidents) values($1,false,true,true,false,'18:00','07:30',true)", [id])
    return { id, sid, cid, phone, token: await signAccessToken(ACCESS, { sub: id, sid }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  async function material(a: Actor): Promise<Material> {
    const user = (await db().query<Material['user']>('select name,trim(lang) as lang,tz from users where id=$1', [a.id])).rows[0]!
    const prefs = (await db().query<NonNullable<Material['prefs']>>(`select tasks,chats,deals,tips,urgent_incidents as urgent,
      left(quiet_from::text,5) as "from",left(quiet_to::text,5) as "to" from notification_prefs where user_id=$1`, [a.id])).rows[0] ?? null
    return { user, prefs }
  }
  const CHANGES = { name: 'Changed synthetic profile', lang: 'en', tz: 'Europe/Moscow', push: { deals: false }, quietHours: { from: '21:00' } }
  function request(method: 'PATCH' | 'GET' | 'POST', path: string, payload?: object, token?: string) {
    const pending = Promise.resolve(getApp().inject({ method, url: path, ...(payload ? { payload } : {}), ...(token ? { headers: { authorization: 'Bearer ' + token } } : {}) }))
    requests.add(pending); void pending.then(() => requests.delete(pending), () => requests.delete(pending)); return pending
  }
  const patch = (a: Actor, token = a.token) => request('PATCH', '/users/me', CHANGES, token)
  const projected = (response: Response) => {
    const body = response.json<Record<string, unknown>>()
    return { name: body.name, lang: body.lang, tz: body.tz, push: body.push, quietHours: body.quietHours, urgentIncidents: body.urgentIncidents }
  }
  async function waitOrSettled(pending: Promise<Response>, pid: number, query: (sql: string) => boolean): Promise<Waiter | null> {
    let settled = false; void pending.then(() => { settled = true }, () => { settled = true })
    const until = Date.now() + 3_000
    do {
      const rows = (await observe().query<Waiter>(`select pid,datname,application_name,state,wait_event_type,query,pg_blocking_pids(pid) as blockers
        from pg_stat_activity where datname=$1 and application_name=$2 and state='active' and wait_event_type='Lock'`, [databaseName, APPLICATION])).rows
      const matches = rows.filter(row => query(row.query))
      if (matches.length) {
        assert.equal(matches.length, 1, 'unexpected extra app waiter'); const row = matches[0]!
        assert.equal(row.datname, databaseName); assert.equal(row.application_name, APPLICATION)
        assert.equal(row.state, 'active'); assert.equal(row.wait_event_type, 'Lock'); assert.deepEqual(row.blockers, [pid])
        note({ event: 'real-blocking-witness', holderPid: pid, row }); return row
      }
      if (settled) { note({ event: 'request-settled-without-required-wait', holderPid: pid }); return null }
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < until)
    throw new Error('required real PG waiter did not appear within three seconds')
  }
  async function otp(a: Actor) {
    const id = allocate('otp'), code = String(randomInt(100_000, 999_999))
    await db().query("insert into otp_codes(id,phone,code_hash,expires_at) values($1,$2,$3,clock_timestamp()+interval '5 minutes')", [id, a.phone, hashCode(REFRESH, a.phone, code)])
    return request('POST', '/auth/otp/verify', { phone: a.phone, code, device: 'Synthetic C04 fixture' })
  }

  const EXPECTED = { user: { name: CHANGES.name, lang: 'en', tz: CHANGES.tz },
    prefs: { tasks: true, chats: true, deals: false, tips: true, urgent: false, from: '21:00', to: '09:00' } }
  const initializer = (sql: string, values: readonly unknown[] | undefined, id: string) =>
    /^\s*insert\s+into\s+notification_prefs\b/i.test(sql) && values?.includes(id) === true
  function acceptedPartial(response: Response) {
    expect(response.statusCode).toBe(200)
    expect(projected(response)).toEqual({ name: CHANGES.name, lang: 'en', tz: CHANGES.tz,
      push: { tasks: true, chats: true, deals: false, tips: true }, quietHours: { from: '21:00', to: '09:00' }, urgentIncidents: false })
  }
  it('profile first pins absent prefs; auth default writer waits and preserves the committed partial choices', async () => {
    const a = await actor(false), before = await material(a), loginGate = deferred(), profileGate = deferred()
    let loginReached = false, profileReached = false, holderPid: number | undefined, waiter: Waiter | null = null
    probe = { async after(sql, values, client, scope) {
      if (!loginReached && userStatement(sql, values, a.id) && /set\s+deleted_at\s*=\s*null/i.test(sql)) {
        loginReached = true; await loginGate.pause()
      } else if (!profileReached && userStatement(sql, values, a.id) && /set\s+name\s*=/i.test(sql)) {
        profileReached = true; holderPid = transactionPids.get(client)
        note({ event: 'profile-first-own-holder', scope, pid: holderPid ?? null }); await profileGate.pause()
      }
    } }
    const login = otp(a); await bounded(loginGate.entered, 'post-restore default writer boundary', 4_000)
    const update = patch(a); await bounded(profileGate.entered, 'completed profile user UPDATE', 4_000)
    let during: Material | undefined
    try {
      loginGate.open(); waiter = await waitOrSettled(login, holderPid ?? -1, userWait)
      during = await material(a)
    } finally { profileGate.open(); loginGate.open() }
    const [updated, loggedIn] = await bounded(Promise.all([update, login]), 'settle profile-first creators')
    const after = await material(a)
    note({ case: 'profile-first/default-second', loginReached, profileReached, holderPid: holderPid ?? null,
      waited: waiter !== null, before, during, after, profileStatus: updated.statusCode, loginStatus: loggedIn.statusCode })
    expect(loginReached && profileReached).toBe(true); expect(holderPid).toBeGreaterThan(0); expect(waiter).not.toBeNull()
    expect(during).toEqual(before); acceptedPartial(updated); expect(loggedIn.statusCode).toBe(200)
    expect(loggedIn.json().consentRequired).toBe(false); expect(after).toEqual(EXPECTED)
  }, 20_000)
  it('auth defaults first pins creation; profile waits and applies only the requested fields after that commit', async () => {
    const a = await actor(false), before = await material(a), defaultGate = deferred()
    let defaultReached = false, holderPid: number | undefined, waiter: Waiter | null = null
    probe = { async after(sql, values, client, scope) {
      if (!defaultReached && initializer(sql, values, a.id)) {
        defaultReached = true; holderPid = transactionPids.get(client)
        note({ event: 'default-first-own-holder', scope, pid: holderPid ?? null }); await defaultGate.pause()
      }
    } }
    const login = otp(a); await bounded(defaultGate.entered, 'completed auth default INSERT', 4_000)
    const update = patch(a)
    let during: Material | undefined
    try {
      waiter = await waitOrSettled(update, holderPid ?? -1, userWait); during = await material(a)
    } finally { defaultGate.open() }
    const [loggedIn, updated] = await bounded(Promise.all([login, update]), 'settle default-first creators')
    const after = await material(a)
    note({ case: 'default-first/profile-second', defaultReached, holderPid: holderPid ?? null,
      waited: waiter !== null, before, during, after, profileStatus: updated.statusCode, loginStatus: loggedIn.statusCode })
    expect(defaultReached).toBe(true); expect(holderPid).toBeGreaterThan(0); expect(waiter).not.toBeNull()
    expect(during).toEqual(before); acceptedPartial(updated); expect(loggedIn.statusCode).toBe(200)
    expect(loggedIn.json().consentRequired).toBe(false); expect(after).toEqual(EXPECTED)
  }, 20_000)
})
