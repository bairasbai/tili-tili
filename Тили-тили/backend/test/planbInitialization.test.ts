import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'synthetic-planb-access-key'.repeat(3), POLICY = '2026-09-02'
const APPLICATION = 'planb_initialization_' + randomUUID()
const TITLES = [
  'Обзвонить всех подрядчиков за 1–2 дня: время и адрес прибытия',
  'Кольца и паспорта — у свидетелей',
  'Алкоголь и реквизит отвезти на площадку накануне вечером',
  'Проверить прогноз погоды и план Б площадки',
  'Запас 15 минут в каждом блоке тайминга',
  'Powerbank, аптечка, швейный набор, присыпка от пятен',
]
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
interface Item { id: string; title: string; done: boolean }
interface PlanB { scenario: string | null; activatedAt: string | null; checklist: Item[] }
interface Probe {
  before?: (sql: string, values: readonly unknown[] | undefined) => string | void
  after?: (sql: string, values: readonly unknown[] | undefined, result: pg.QueryResult) => Promise<void> | void
}

describe.skipIf(!DB)('WP10/A13: actual PostgreSQL Plan B initialization and current HTTP authority', () => {
  let app: FastifyInstance, rawDb: Db
  // Append-only identities: soft deletion and rollback never remove cleanup IDs.
  const manifest = { users: new Set<string>(), sessions: new Set<string>(), consents: new Set<string>(), weddings: new Set<string>(), tasks: new Set<string>() }
  const witnesses: object[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.username, 'codex_test')
    assert.equal(target.port, disposablePgPort()); assert.equal(target.search, ''); assert.equal(target.hash, '')
    assert(['/tili_ecosystem_planb_20261003_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    target.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: target.href, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'synthetic-planb-refresh-key'.repeat(3), policyVersion: POLICY,
      rateLimitPerSecond: 0 }, [], { tillyModel: null })
    await app.ready()
    rawDb = app.db!
    const actual = (await rawDb.query<{ name: string; address: string; port: number; username: string }>(
      'select current_database() as name,host(inet_server_addr()) as address,inet_server_port() as port,current_user as username')).rows[0]!
    assert.equal(actual.name, target.pathname.slice(1)); assert.equal(actual.port, Number(disposablePgPort()))
    assert.equal(actual.username, 'codex_test'); assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(actual.address))
    app.db = forwardingDb()
  })
  afterAll(async () => {
    if (!app || !rawDb) return
    app.db = rawDb
    try {
      process.stdout.write(`PLANB_PG_WITNESSES ${JSON.stringify(witnesses)}\n`)
      const weddings = [...manifest.weddings], users = [...manifest.users]
      // Capture any unexpected partial initializer before deleting only our weddings.
      for (const row of (await rawDb.query<{ id: string }>('select id from tasks where wedding_id=any($1::uuid[])', [weddings])).rows) manifest.tasks.add(row.id)
      for (const id of weddings) await rawDb.query('delete from weddings where id=$1', [id])
      for (const id of users) await rawDb.query('delete from users where id=$1', [id])
      const remaining = (await rawDb.query<{ users: string; sessions: string; consents: string; tasks: string; weddings: string }>(`select
        (select count(*)::text from users where id=any($1::uuid[])) as users,
        (select count(*)::text from sessions where id=any($2::uuid[]) or user_id=any($1::uuid[])) as sessions,
        (select count(*)::text from consents where id=any($3::uuid[]) or user_id=any($1::uuid[])) as consents,
        (select count(*)::text from tasks where id=any($4::uuid[]) or wedding_id=any($5::uuid[])) as tasks,
        (select count(*)::text from weddings where id=any($5::uuid[])) as weddings`,
      [users, [...manifest.sessions], [...manifest.consents], [...manifest.tasks], weddings])).rows[0]!
      expect(remaining).toEqual({ users: '0', sessions: '0', consents: '0', tasks: '0', weddings: '0' })
      process.stdout.write(`PLANB_FIXTURE_CLEANUP ${JSON.stringify(remaining)}\n`)
    } finally { await app.close() }
  })

  function isTaskInsert(sql: string, values: readonly unknown[] | undefined, weddingId?: string): boolean {
    return /^\s*insert\s+into\s+tasks\b/i.test(sql) && typeof values?.[1] === 'string'
      && (weddingId ? values[1] === weddingId : manifest.weddings.has(values[1]))
  }
  function isPlanBCount(sql: string, values: readonly unknown[] | undefined, weddingId: string): boolean {
    return /\bcount\s*\(\s*\*\s*\)/i.test(sql) && /\bfrom\s+tasks\b/i.test(sql)
      && /\bkind\s*=\s*'planb'/i.test(sql) && values?.[0] === weddingId
  }
  // Every result comes from the real public Db interface. No rows are fabricated.
  function forwardingDb(probe: Probe = {}): Db {
    const wrap = (client: Queryable): Queryable => ({
      async query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<pg.QueryResult<T>> {
        const forwardedSql = probe.before?.(sql, values) ?? sql
        const result = await client.query<T>(forwardedSql, values)
        if (isTaskInsert(sql, values) && typeof values?.[0] === 'string' && result.rowCount === 1) manifest.tasks.add(values[0])
        await probe.after?.(sql, values, result)
        return result
      },
    })
    return { query: wrap(rawDb).query, tx: action => rawDb.tx(client => action(wrap(client))), ping: () => rawDb.ping(), close: () => rawDb.close() }
  }
  function instrument(probe: Probe): () => void {
    const previous = app.db!
    app.db = forwardingDb(probe)
    return () => { app.db = previous }
  }
  function gate() {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
  }
  async function observed(check: () => Promise<boolean> | boolean, label: string, settled: () => boolean = () => false): Promise<void> {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (await check()) return
      if (settled()) throw new Error(`HTTP completed before ${label}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`No ${label} observed within 8 seconds`)
  }
  async function waiters(client: Queryable, holderPid: number): Promise<{ pid: number; query: string }[]> {
    await client.query('select pg_stat_clear_snapshot()')
    return (await client.query<{ pid: number; query: string }>(`select pid,query from pg_stat_activity
      where datname=current_database() and application_name=$2 and wait_event_type='Lock'
      and $1=any(pg_blocking_pids(pid))`, [holderPid, APPLICATION])).rows
  }

  // Synthetic authentication facts exercise the API; they are not human consent.
  async function actor() {
    const userId = randomUUID(), consentId = randomUUID()
    let created = false
    for (let attempt = 0; attempt < 8; attempt++) {
      const inserted = await rawDb.query<{ id: string }>('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id',
        [userId, '+79' + randomInt(100_000_000, 999_999_999), 'Synthetic Plan B fixture'])
      if (inserted.rows[0]?.id === userId) { created = true; break }
    }
    assert(created, 'Could not allocate a synthetic Plan B phone after 8 attempts')
    manifest.users.add(userId)
    await rawDb.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    manifest.consents.add(consentId)
    return { userId, consentId, ...await device(userId) }
  }
  async function device(userId: string) {
    const sessionId = randomUUID()
    await rawDb.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    manifest.sessions.add(sessionId)
    return { sessionId, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  async function fixture(role: 'couple' | 'helper' | 'coordinator' | 'vendor' | 'outsider' = 'couple') {
    const owner = await actor(), requester = role === 'couple' ? owner : await actor(), weddingId = randomUUID()
    await rawDb.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic Plan B wedding','2027-06-14','Europe/Moscow',$3)", [weddingId, owner.userId, randomUUID()])
    manifest.weddings.add(weddingId)
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    if (role !== 'couple' && role !== 'outsider') await rawDb.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [weddingId, requester.userId, role])
    return { weddingId, owner, requester }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const auth = (token: string) => ({ authorization: 'Bearer ' + token })
  const get = (f: Fixture, token = f.requester.token) => Promise.resolve(app.inject({ method: 'GET', url: `/weddings/${f.weddingId}/planb`, headers: auth(token) }))
  const snapshot = async (f: Fixture) => (await rawDb.query('select to_jsonb(t) as task from tasks t where wedding_id=$1 order by id', [f.weddingId])).rows
  const planbRows = async (f: Fixture) => (await rawDb.query<{ id: string; title: string; done_at: Date | null; source: string; sort: number }>(
    "select id,title,done_at,source,sort from tasks where wedding_id=$1 and kind='planb' order by sort,title", [f.weddingId])).rows
  async function initialized(f: Fixture, response: Response): Promise<PlanB> {
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json<PlanB>(), rows = await planbRows(f)
    expect(body.checklist).toHaveLength(6); expect(rows).toHaveLength(6)
    expect(new Set(body.checklist.map(item => item.id)).size).toBe(6)
    expect(body.checklist.map(item => item.title)).toEqual(TITLES)
    expect(rows.map(row => ({ title: row.title, source: row.source, sort: row.sort }))).toEqual(TITLES.map((title, sort) => ({ title, source: 'system', sort })))
    expect(body.checklist.map(item => item.id)).toEqual(rows.map(row => row.id))
    return body
  }

  it('concurrent first opens from two sessions create exactly one six-item system set', async () => {
    const f = await fixture(), other = await device(f.owner.userId), firstCount = gate()
    let zeroCounts = 0, firstPid: number | undefined, first: Promise<Response> | undefined, second: Promise<Response> | undefined
    let firstSettled = false, secondSettled = false
    const restoreDb = instrument({
      before(sql, values) {
        if (isPlanBCount(sql, values, f.weddingId)) {
          assert(/\bas\s+n\b/i.test(sql), 'Actual count query must expose n')
          return sql.replace(/\bas\s+n\b/i, 'as n, pg_backend_pid() as planb_test_pid')
        }
      },
      async after(sql, values, result) {
        if (isPlanBCount(sql, values, f.weddingId) && result.rows[0]?.n === '0') {
          zeroCounts++
          witnesses.push({ test: 'concurrent initialization', count: result.rows[0].n, pid: result.rows[0].planb_test_pid })
          if (zeroCounts === 1) {
            firstPid = Number(result.rows[0].planb_test_pid)
            assert(Number.isInteger(firstPid) && firstPid > 0)
            await firstCount.promise
          }
        }
      },
    })
    try {
      first = get(f).then(response => { firstSettled = true; return response }, error => { firstSettled = true; throw error })
      void first.catch(() => undefined)
      await observed(() => firstPid !== undefined, 'first real zero-count', () => firstSettled)
      second = get(f, other.token).then(response => { secondSettled = true; return response }, error => { secondSettled = true; throw error })
      void second.catch(() => undefined)
      await observed(async () => {
        if (zeroCounts >= 2) return true
        const blocked = await waiters(rawDb, firstPid!)
        if (!blocked.length) return false
        expect(blocked).toHaveLength(1)
        witnesses.push({ test: 'concurrent initialization', holderPid: firstPid, waitingPid: blocked[0]!.pid, query: blocked[0]!.query })
        return true
      }, 'second real zero-count or PostgreSQL waiter blocked by the first transaction', () => secondSettled)
      firstCount.release()
      const replies = await Promise.all([first, second])
      const a = await initialized(f, replies[0]), b = await initialized(f, replies[1])
      expect(a).toEqual(b)
    } finally {
      firstCount.release()
      await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])])
      restoreDb()
    }
  })

  it('a failure before the third insert rolls back two actual inserts and a retry creates the complete set', async () => {
    const f = await fixture(), before = await snapshot(f)
    let attempts = 0, actualInserts = 0
    const restoreDb = instrument({
      before(sql, values) {
        if (isTaskInsert(sql, values, f.weddingId) && ++attempts === 3) throw new Error('Synthetic Plan B failure before the third insert')
      },
      after(sql, values, result) {
        if (isTaskInsert(sql, values, f.weddingId)) { expect(result.rowCount).toBe(1); actualInserts++ }
      },
    })
    let failed: Response
    try { failed = await get(f) } finally { restoreDb() }
    expect(failed!.statusCode, failed!.body).toBe(500)
    expect(attempts).toBe(3); expect(actualInserts).toBe(2)
    expect(await snapshot(f)).toEqual(before)
    const retry = await initialized(f, await get(f)), repeat = await initialized(f, await get(f))
    expect(repeat).toEqual(retry)
  })

  it('retry and PATCH from a second device preserve IDs, changed title and done state', async () => {
    const f = await fixture(), first = await initialized(f, await get(f)), other = await device(f.owner.userId)
    expect(await initialized(f, await get(f, other.token))).toEqual(first)
    const selected = first.checklist[0]!, title = 'Synthetic shared preparation edit'
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/tasks/${selected.id}`, headers: auth(other.token), payload: { title, done: true } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.json()).toMatchObject({ id: selected.id, title, done: true })
    const expected = { ...first, checklist: first.checklist.map(item => item.id === selected.id ? { ...item, title, done: true } : item) }
    const before = await snapshot(f)
    for (const token of [f.owner.token, other.token, f.owner.token]) {
      const response = await get(f, token)
      expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual(expected)
    }
    expect(await snapshot(f)).toEqual(before)
  })

  it.each(['couple', 'helper', 'coordinator'] as const)('all_team %s can initialize and reread the same set', async role => {
    const f = await fixture(role), first = await initialized(f, await get(f)), before = await snapshot(f)
    expect(await initialized(f, await get(f))).toEqual(first)
    expect(await snapshot(f)).toEqual(before)
  })
  it.each(['outsider', 'vendor'] as const)('%s receives a refusal with no writes or checklist disclosure', async role => {
    const f = await fixture(role), status = role === 'outsider' ? 404 : 403
    for (const populated of [false, true]) {
      if (populated) await initialized(f, await get(f, f.owner.token))
      const before = await snapshot(f), response = await get(f)
      expect(response.statusCode, response.body).toBe(status)
      expect(response.json().error.code).toBe(role === 'outsider' ? 'not_found' : 'forbidden')
      expect(response.json()).not.toHaveProperty('checklist'); expect(await snapshot(f)).toEqual(before)
    }
  })
  it('cancellation preserves authorized first-open and existing-checklist read compatibility', async () => {
    const f = await fixture()
    await rawDb.query("update weddings set cancelled_at=now(),planb_scenario='rain',planb_at='2027-06-14T08:00:00Z' where id=$1", [f.weddingId])
    const first = await initialized(f, await get(f)), before = await snapshot(f)
    expect(first).toMatchObject({ scenario: 'rain', activatedAt: '2027-06-14T08:00:00.000Z' })
    expect(await initialized(f, await get(f))).toEqual(first); expect(await snapshot(f)).toEqual(before)
  })
  it('same user titles remain allowed and do not count as the system Plan B set', async () => {
    const f = await fixture(), ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/tasks`, headers: auth(f.owner.token), payload: { title: TITLES[0], period: '3' } })
      expect(response.statusCode, response.body).toBe(201); ids.push(response.json().id)
    }
    expect(new Set(ids).size).toBe(2)
    await initialized(f, await get(f))
    const checklist = await app.inject({ method: 'GET', url: `/weddings/${f.weddingId}/tasks`, headers: auth(f.owner.token) })
    expect(checklist.statusCode, checklist.body).toBe(200)
    expect(checklist.json().map((item: Item) => item.id).sort()).toEqual(ids.sort())
    expect(checklist.json().map((item: Item) => item.title)).toEqual([TITLES[0], TITLES[0]])
  })

  async function whileWeddingWaits(f: Fixture, change: (client: Queryable) => Promise<unknown>, label: string): Promise<Response> {
    let pending: Promise<Response> | undefined, settled = false
    try {
      await rawDb.tx(async client => {
        const holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        await client.query('select id from weddings where id=$1 for update', [f.weddingId])
        pending = get(f).then(response => { settled = true; return response }, error => { settled = true; throw error })
        void pending.catch(() => undefined)
        await observed(async () => {
          const blocked = await waiters(client, holderPid)
          if (!blocked.length) return false
          expect(blocked).toHaveLength(1)
          witnesses.push({ test: label, holderPid, waitingPid: blocked[0]!.pid, query: blocked[0]!.query })
          return true
        }, 'actual wedding-lock wait', () => settled)
        await change(client)
      })
      return await pending!
    } finally { await Promise.allSettled(pending ? [pending] : []) }
  }
  const changes = [
    { name: 'membership removed', status: 404, code: 'not_found', sql: 'delete from wedding_members where wedding_id=$1 and user_id=$2', values: (f: Fixture) => [f.weddingId, f.requester.userId] },
    { name: 'role becomes vendor', status: 403, code: 'forbidden', sql: "update wedding_members set role='vendor' where wedding_id=$1 and user_id=$2", values: (f: Fixture) => [f.weddingId, f.requester.userId] },
    { name: 'session revoked', status: 401, code: 'unauthorized', sql: 'update sessions set revoked_at=now() where id=$1', values: (f: Fixture) => [f.requester.sessionId] },
    { name: 'consent withdrawn', status: 403, code: 'forbidden', sql: 'update consents set withdrawn_at=now() where id=$1', values: (f: Fixture) => [f.requester.consentId] },
    { name: 'consent becomes outdated', status: 403, code: 'consent_outdated', sql: "update consents set policy_version='2020-01-01' where id=$1", values: (f: Fixture) => [f.requester.consentId] },
    { name: 'account deleted', status: 401, code: 'unauthorized', sql: 'update users set deleted_at=now() where id=$1', values: (f: Fixture) => [f.requester.userId] },
    { name: 'wedding archived', status: 404, code: 'not_found', sql: 'update weddings set archived_at=now() where id=$1', values: (f: Fixture) => [f.weddingId] },
  ]
  for (const change of changes) {
    for (const populated of [false, true]) {
      it(`${populated ? 'existing set read' : 'first open'} rejects ${change.name} committed during its actual wedding-lock wait without writes`, async () => {
        const f = await fixture()
        if (populated) await initialized(f, await get(f))
        const before = await snapshot(f)
        const response = await whileWeddingWaits(f, client => client.query(change.sql, change.values(f)), change.name + (populated ? ' with existing set' : ' with empty set'))
        expect(response.statusCode, response.body).toBe(change.status); expect(response.json().error.code).toBe(change.code)
        expect(response.json()).not.toHaveProperty('checklist'); expect(await snapshot(f)).toEqual(before)
      })
    }
  }
  it.each(['helper', 'coordinator'] as const)('current all_team %s role remains allowed after the wedding-lock wait', async role => {
    const f = await fixture()
    const response = await whileWeddingWaits(f, client => client.query('update wedding_members set role=$3 where wedding_id=$1 and user_id=$2',
      [f.weddingId, f.requester.userId, role]), 'role becomes ' + role)
    await initialized(f, response)
  })
  it('cancellation committed during the wedding-lock wait preserves read compatibility', async () => {
    const f = await fixture()
    await initialized(f, await whileWeddingWaits(f, client => client.query('update weddings set cancelled_at=now() where id=$1', [f.weddingId]), 'wedding cancelled'))
  })
  it('a real access token expiring during the wedding-lock wait leaves no initialized tasks', async () => {
    const f = await fixture(), expires = Math.floor(Date.now() / 1000) + 4, before = await snapshot(f)
    f.requester.token = await signAccessToken(SECRET, { sub: f.requester.userId, sid: f.requester.sessionId }, (expires - ACCESS_TTL_SECONDS) * 1000)
    const response = await whileWeddingWaits(f, async () => {
      await observed(() => Date.now() >= expires * 1000, 'real JWT expiry')
    }, 'JWT expiry')
    expect(response.statusCode, response.body).toBe(401); expect(response.json().error.code).toBe('token_expired')
    expect(await snapshot(f)).toEqual(before)
  })
})
