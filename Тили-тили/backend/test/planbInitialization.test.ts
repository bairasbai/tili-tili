import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'
import { planBPreviewToken } from './helpers/planBPreview.js'
import { notificationPushReady } from '../src/notify/preflight.js'
import { isPlanBEventDay } from '../src/notify/planb-urgency.js'

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

it('determines the urgent window in the event time zone', () => {
  const at = new Date('2027-06-14T00:05:00Z')
  expect(isPlanBEventDay({ date: '2027-06-13', timeZone: 'America/Los_Angeles' }, at)).toBe(true)
  expect(isPlanBEventDay({ date: '2027-06-13', timeZone: 'Europe/Moscow' }, at)).toBe(false)
  expect(isPlanBEventDay({ date: '2027-06-14', timeZone: null }, at)).toBe(false)
})

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
  async function fixture(role: 'couple' | 'helper' | 'coordinator' | 'vendor' | 'outsider' = 'couple', date = '2027-06-14') {
    const owner = await actor(), requester = role === 'couple' ? owner : await actor(), weddingId = randomUUID()
    await rawDb.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic Plan B wedding',$3,'Europe/Moscow',$4)", [weddingId, owner.userId, date, randomUUID()])
    manifest.weddings.add(weddingId)
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    if (role !== 'couple' && role !== 'outsider') await rawDb.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [weddingId, requester.userId, role])
    return { weddingId, owner, requester }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const auth = (token: string) => ({ authorization: 'Bearer ' + token })
  const scenarioUrl = (f: Fixture, scenario = 'rain') => `/weddings/${f.weddingId}/planb/scenarios/${scenario}`
  const savedPlan = (userId: string) => ({
    expectedRevision: null as string | null,
    reason: 'Синтетический ливень', triggerCondition: 'Гроза к началу церемонии',
    reserveAddress: 'Синтетический резервный зал',
    contacts: [{ label: 'Администратор зала', value: 'private-contact@example.test' }],
    actions: [{ title: 'Встретить гостей', responsibleUserId: userId }],
  })
  const save = (f: Fixture, token: string, payload: ReturnType<typeof savedPlan>) =>
    app.inject({ method: 'PUT', url: scenarioUrl(f), headers: auth(token), payload })
  const get = (f: Fixture, token = f.requester.token) => Promise.resolve(app.inject({ method: 'GET', url: `/weddings/${f.weddingId}/planb`, headers: auth(token) }))
  const preview = (f: Fixture, token: string, scenario: 'rain' | 'power' = 'rain') =>
    planBPreviewToken(app, f.weddingId, auth(token), scenario)
  const activate = (f: Fixture, token: string, key: string = randomUUID(), scenario = 'rain', previewToken?: string,
    inAppRecipientIds?: string[], urgentEventId?: string) => Promise.resolve(app.inject({
    method: 'POST', url: `/weddings/${f.weddingId}/planb/activate`,
    headers: { ...auth(token), 'idempotency-key': key }, payload: {
      scenario, ...(previewToken ? { previewToken } : {}), ...(inAppRecipientIds === undefined ? {} : { inAppRecipientIds }),
      ...(urgentEventId === undefined ? {} : { urgentEventId }),
    },
  }))
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

  it('only the previewed event can bypass quiet hours for current opted-in recipients', async () => {
    const today = (await rawDb.query<{ date: string }>("select (clock_timestamp() at time zone 'Europe/Moscow')::date::text as date")).rows[0]!.date
    const f = await fixture('coordinator', today), normal = await actor(), changedContext = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper'),($1,$3,'helper')",
      [f.weddingId, normal.userId, changedContext.userId])
    await rawDb.query(`insert into notification_prefs(user_id,quiet_from,quiet_to,urgent_incidents)
      select u.id,(z.t-interval '2 hours')::time,(z.t+interval '2 hours')::time,u.opted
        from (values ($1::uuid,true),($2::uuid,false),($3::uuid,true)) u(id,opted)
        cross join (select date_trunc('minute',clock_timestamp() at time zone 'Europe/Moscow') as t) z`,
    [f.requester.userId, normal.userId, changedContext.userId])
    const otherEvent = randomUUID()
    await rawDb.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone) values($1,$2,'Synthetic other event','other',$3,'Europe/Moscow')",
      [otherEvent, f.weddingId, today])
    const getPreview = (scenario: 'rain' | 'power') => app.inject({
      method: 'POST', url: `/weddings/${f.weddingId}/planb/preview`, headers: auth(f.owner.token), payload: { scenario },
    })
    const regular = await getPreview('power')
    expect(regular.statusCode, regular.body).toBe(200)
    const regularResult = await activate(f, f.owner.token, randomUUID(), 'power', regular.json().previewToken, [f.requester.userId])
    expect(regularResult.statusCode, regularResult.body).toBe(200)
    expect((await rawDb.query('select deliver_after>clock_timestamp() as deferred from notifications where broadcast_id=$1',
      [regularResult.json().activationId])).rows).toEqual([{ deferred: true }])

    const urgent = await getPreview('rain')
    expect(urgent.statusCode, urgent.body).toBe(200)
    const { urgentEvent, previewToken } = urgent.json()
    expect(urgentEvent).toEqual({ id: expect.any(String), name: 'Основная программа', date: today })
    const recipients = [f.requester.userId, normal.userId, changedContext.userId]
    const outside = await activate(f, f.owner.token, randomUUID(), 'rain', previewToken, recipients, otherEvent)
    expect(outside.statusCode, outside.body).toBe(409)
    const key = randomUUID()
    const activated = await activate(f, f.owner.token, key, 'rain', previewToken, recipients, urgentEvent.id)
    expect(activated.statusCode, activated.body).toBe(200)
    const activationId = activated.json().activationId as string
    expect((await activate(f, f.owner.token, key, 'rain', previewToken, recipients, urgentEvent.id)).json()).toEqual(activated.json())
    const persisted = await rawDb.query('select planb_urgent_event_id as id, planb_urgent_event_version as version from broadcasts where id=$1', [activationId])
    expect(persisted.rows).toEqual([{ id: urgentEvent.id, version: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    const { rows: notices } = await rawDb.query<{ id: string; user_id: string; deferred: boolean; title: string; body: string }>(`
      select id,user_id,deliver_after>clock_timestamp() as deferred,title,body
        from notifications where broadcast_id=$1 order by user_id`, [activationId])
    expect(notices).toHaveLength(3)
    for (const notice of notices) {
      expect(notice.deferred).toBe(notice.user_id === normal.userId)
      expect(notice.title).toBe('Активирован план Б')
      expect(notice.body).toBe('Сценарий включён — проверьте точку сбора и тайминг')
    }
    const optedNotice = notices.find(row => row.user_id === f.requester.userId)!.id
    const contextNotice = notices.find(row => row.user_id === changedContext.userId)!.id
    expect(await notificationPushReady(rawDb, optedNotice)).toBe(true)
    await rawDb.query('update notification_prefs set urgent_incidents=false where user_id=$1', [f.requester.userId])
    expect(await notificationPushReady(rawDb, optedNotice)).toBe(false)
    await rawDb.query("update weddings set venue='Synthetic relocated venue' where id=$1", [f.weddingId])
    expect(await notificationPushReady(rawDb, contextNotice)).toBe(false)
    expect((await rawDb.query('select count(*)::int as deferred from notifications where broadcast_id=$1 and deliver_after>clock_timestamp()', [activationId])).rows)
      .toEqual([{ deferred: 3 }])
  })

  it('Day X shows the current booking and open tasks with separate, actor-stamped observations', async () => {
    const f = await fixture('coordinator')
    const helper = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, helper.userId])
    await rawDb.query("update users set name=case when id=$1 then 'Synthetic couple' else 'Synthetic coordinator' end where id in ($1,$2)",
      [f.owner.userId, f.requester.userId])
    const slot = randomUUID(), task = randomUUID()
    await rawDb.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Synthetic photo slot')", [slot, f.weddingId])
    const booked = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/slots/${slot}/external`,
      headers: auth(f.owner.token), payload: { vendorName: 'Synthetic photographer', phone: '+79170000000', price: { amount: 9876543, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200)
    const deal = booked.json().deal.id as string
    await rawDb.query(`insert into tasks(id,wedding_id,title,source,kind,due,assignee_id,done_at)
      values($1,$2,'Bring spare batteries','user','checklist','2027-06-14',$3,null),
            ($4,$2,'Completed task','user','checklist','2027-06-14',null,now())`, [task, f.weddingId, f.requester.userId, randomUUID()])
    const url = `/weddings/${f.weddingId}/dayx/coordination`
    const read = (token: string) => app.inject({ url, headers: auth(token) })
    const patch = (token: string, payload: object, dealId = deal) => app.inject({
      method: 'PATCH', url: `${url}/${dealId}`, headers: auth(token), payload,
    })
    expect((await read(helper.token)).statusCode).toBe(403)
    expect((await read((await actor()).token)).statusCode).toBe(404)
    const initial = await read(f.requester.token)
    expect(initial.statusCode, initial.body).toBe(200)
    const { performers: [performer], openTasks } = initial.json()
    expect(performer).toEqual({
      dealId: deal, label: 'Synthetic photo slot', name: 'Synthetic photographer', phone: '+79170000000',
      event: { name: 'Основная программа', date: '2027-06-14', timeZone: 'Europe/Moscow' },
      scopeKey: expect.stringMatching(/^[0-9a-f]{64}$/), revision: null, plannedArrivalAt: null, arrival: null, readiness: null,
    })
    expect(openTasks).toEqual([{ id: task, title: 'Bring spare batteries', due: '2027-06-14', assignee: 'Synthetic coordinator' }])
    const expected = { scopeKey: performer.scopeKey, expectedRevision: null }
    expect((await patch(helper.token, { ...expected, arrived: true })).statusCode).toBe(403)
    expect((await patch(f.owner.token, { ...expected, arrived: true }, randomUUID())).statusCode).toBe(404)
    const planned = '2027-06-14T09:30:00.000Z'
    const first = await patch(f.requester.token, { ...expected, plannedArrivalAt: planned })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ plannedArrivalAt: planned, arrival: null, readiness: null })
    const race = { ...expected, expectedRevision: first.json().revision }
    const writes = await Promise.all([patch(f.owner.token, { ...race, arrived: true }), patch(f.owner.token, { ...race, arrived: true })])
    expect(writes.map(write => write.statusCode).sort()).toEqual([200, 409])
    const arrived = writes.find(write => write.statusCode === 200)!.json()
    expect(arrived).toMatchObject({ arrival: { at: expect.any(String), by: 'Synthetic couple' }, readiness: null })
    const ready = await patch(f.requester.token, { ...expected, expectedRevision: arrived.revision, ready: true })
    expect(ready.statusCode, ready.body).toBe(200)
    expect(ready.json()).toMatchObject({
      plannedArrivalAt: planned, arrival: arrived.arrival, readiness: { at: expect.any(String), by: 'Synthetic coordinator' },
    })
    const clear = await patch(f.owner.token, { ...expected, expectedRevision: ready.json().revision, arrived: false })
    expect(clear.statusCode, clear.body).toBe(200)
    expect(clear.json()).toMatchObject({ plannedArrivalAt: planned, arrival: null, readiness: ready.json().readiness })

    // Context change uses the real main-event synchronization trigger.
    await rawDb.query("update weddings set venue='Synthetic relocated venue' where id=$1", [f.weddingId])
    const changed = (await read(f.requester.token)).json().performers[0]
    expect(changed).toMatchObject({ revision: null, plannedArrivalAt: null, arrival: null, readiness: null })
    expect(changed.scopeKey).not.toBe(expected.scopeKey)
    expect((await patch(f.owner.token, { ...expected, expectedRevision: clear.json().revision, arrived: true })).statusCode).toBe(409)
    const historical = await rawDb.query('select scope_key from dayx_vendor_status where wedding_id=$1 and deal_id=$2', [f.weddingId, deal])
    expect(historical.rows).toEqual([{ scope_key: expected.scopeKey }])
  })

  it('concurrent commands with distinct keys create one active batch and show exact delivery facts to command roles', async () => {
    const f = await fixture('coordinator')
    const helper = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, helper.userId])
    const guest = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/guests`,
      headers: auth(f.owner.token), payload: { name: 'Synthetic attending guest' } })
    expect(guest.statusCode, guest.body).toBe(201)
    const confirmedGuest = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${guest.json().id}`,
      headers: auth(f.owner.token), payload: { status: 'yes' } })
    expect(confirmedGuest.statusCode, confirmedGuest.body).toBe(200)
    const firstToken = await preview(f, f.owner.token)
    const secondToken = await preview(f, f.requester.token)
    const release = gate()
    const locked = gate()
    let holderPid = 0
    const held = rawDb.tx(async client => {
      holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await client.query('select id from weddings where id=$1 for update', [f.weddingId])
      locked.release()
      await release.promise
    })
    const firstKey = randomUUID()
    let attempts: Promise<Response>[] = []
    try {
      await Promise.race([held, locked.promise])
      attempts = [activate(f, f.owner.token, firstKey, 'rain', firstToken),
        activate(f, f.requester.token, randomUUID(), 'rain', secondToken)]
      await observed(async () => {
        // The second row lock can queue behind the first waiter, not the root holder.
        const direct = await waiters(rawDb, holderPid)
        const indirect = (await Promise.all(direct.map(row => waiters(rawDb, row.pid)))).flat()
        const waiting = [...new Set([...direct, ...indirect].map(row => row.pid))]
        if (waiting.length !== 2) return false
        witnesses.push({ test: 'concurrent activation', holderPid, waiting })
        return true
      }, 'two actual activation lock waiters')
    } finally {
      release.release()
      await held
      await Promise.all(attempts)
    }
    const [first, second] = await Promise.all(attempts)
    expect(first!.statusCode, first!.body).toBe(200)
    expect(second!.statusCode, second!.body).toBe(200)
    const { activationId } = first!.json<{ activationId: string }>()
    expect(first!.json()).toEqual({ scenario: 'rain', guestsAffected: 1, activationId })
    expect(second!.json()).toEqual(first!.json())
    expect((await rawDb.query('select id,planb_current from broadcasts where wedding_id=$1', [f.weddingId])).rows)
      .toEqual([{ id: activationId, planb_current: true }])
    const notices = (await rawDb.query<{ id: string; user_id: string }>(
      'select id,user_id from notifications where broadcast_id=$1 order by id', [activationId],
    )).rows
    expect(notices).toHaveLength(2)
    expect(notices.some(row => row.user_id === helper.userId)).toBe(true)
    expect(notices.filter(row => [f.owner.userId, f.requester.userId].includes(row.user_id))).toHaveLength(1)
    const delivery = { activationId, guestsAffected: 1, inApp: 2, queued: 2, providerAccepted: 0, confirmedDelivered: null, read: 0 }
    expect((await get(f, f.owner.token)).json().delivery).toEqual(delivery)
    const helperView = await get(f, helper.token)
    expect(helperView.statusCode, helperView.body).toBe(200)
    expect(Object.keys(helperView.json()).sort()).toEqual(['activatedAt', 'canActivate', 'checklist', 'scenario'])
    expect(helperView.json()).toMatchObject({ scenario: 'rain', activatedAt: expect.any(String), canActivate: false })
    expect((await activate(f, helper.token)).statusCode).toBe(403)

    const helperNotice = notices.find(row => row.user_id === helper.userId)!
    await rawDb.query(`insert into notification_push_deliveries(notification_id,subscription_id,status,provider_accepted_at)
      values($1,$2,'provider_accepted',now()),($1,$3,'provider_accepted',now())`, [helperNotice.id, randomUUID(), randomUUID()])
    const read = await app.inject({ method: 'POST', url: `/notifications/${helperNotice.id}/read`, headers: auth(helper.token) })
    expect(read.statusCode, read.body).toBe(204)
    expect((await get(f)).json().delivery).toEqual({ ...delivery, queued: 1, providerAccepted: 1, read: 1 })

    const next = await activate(f, f.owner.token, randomUUID(), 'power', await preview(f, f.owner.token, 'power'))
    expect(next.statusCode, next.body).toBe(200)
    expect(next.json().activationId).not.toBe(activationId)
    expect((await get(f)).json()).toMatchObject({ scenario: 'power', delivery: { activationId: next.json().activationId, read: 0 } })
    const replay = await activate(f, f.owner.token, firstKey, 'rain', firstToken)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.json()).toEqual(first!.json())
    expect((await rawDb.query('select id,planb_current from broadcasts where id=$1', [activationId])).rows)
      .toEqual([{ id: activationId, planb_current: false }])
    expect((await rawDb.query('select id from notifications where broadcast_id=$1', [activationId])).rowCount).toBe(2)
  })

  it('rolls back the activation, linked notice and receipt when notice placement fails', async () => {
    const f = await fixture('coordinator')
    const key = randomUUID()
    const token = await preview(f, f.owner.token)
    let linked = false
    const restore = instrument({
      after(sql, _values, result) {
        if (sql === 'update notifications set broadcast_id=$2 where id=$1') {
          linked = result.rowCount === 1
          throw new Error('Synthetic failure after actual notification linkage')
        }
      },
    })
    try {
      expect((await activate(f, f.owner.token, key, 'rain', token)).statusCode).toBe(500)
      expect(linked).toBe(true)
    } finally { restore() }
    expect((await get(f, f.owner.token)).json()).toMatchObject({ scenario: null, activatedAt: null, delivery: null })
    expect((await rawDb.query('select id from broadcasts where wedding_id=$1', [f.weddingId])).rowCount).toBe(0)
    expect((await rawDb.query("select id from notifications where user_id=$1 and title='Активирован план Б'", [f.requester.userId])).rowCount).toBe(0)
    expect((await rawDb.query('select key from idempotency_keys where key=$1', [`${f.owner.userId}:planb-activate:${key}`])).rowCount).toBe(0)
    const retry = await activate(f, f.owner.token, key, 'rain', token)
    expect(retry.statusCode, retry.body).toBe(200)
    expect((await get(f, f.owner.token)).json().delivery).toMatchObject({ activationId: retry.json().activationId, inApp: 1 })
  })

  it('preserves legacy activation and does not infer receipt links from historical matching text', async () => {
    const f = await fixture()
    await rawDb.query("update weddings set planb_scenario='rain',planb_at=now() where id=$1", [f.weddingId])
    await rawDb.query("insert into broadcasts(id,wedding_id,action,recipients) values($1,$2,'planb:rain',3)", [randomUUID(), f.weddingId])
    await rawDb.query("insert into notifications(id,user_id,kind,title,body,read_at) values($1,$2,'system','Активирован план Б','Synthetic historical text',now())",
      [randomUUID(), f.owner.userId])
    const legacy = await get(f)
    expect(legacy.statusCode, legacy.body).toBe(200)
    expect(legacy.json()).toMatchObject({ scenario: 'rain', activatedAt: expect.any(String), delivery: null })
  })

  it('checks current command role again before returning a saved activation receipt', async () => {
    const f = await fixture('coordinator')
    const key = randomUUID()
    const token = await preview(f, f.requester.token)
    const first = await activate(f, f.requester.token, key, 'rain', token)
    expect(first.statusCode, first.body).toBe(200)
    const denied = await whileWeddingWaits(f, client => client.query(
      "update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.weddingId, f.requester.userId],
    ), 'activation replay role revoked', () => activate(f, f.requester.token, key, 'rain', token))
    expect(denied.statusCode, denied.body).toBe(403)
    expect(denied.json()).not.toHaveProperty('activationId')
    expect((await rawDb.query('select id from broadcasts where wedding_id=$1', [f.weddingId])).rowCount).toBe(1)
  })

  it('requires a fresh snapshot when a confirmed guest or in-app recipient changes', async () => {
    const f = await fixture('coordinator')
    const previewUrl = `/weddings/${f.weddingId}/planb/preview`
    const headers = auth(f.owner.token)
    const before = await app.inject({ method: 'POST', url: previewUrl, headers, payload: { scenario: 'rain' } })
    expect(before.statusCode, before.body).toBe(200)
    expect(before.json()).toMatchObject({ currentScenario: null, reserveAddress: null, manualGuests: [],
      inAppRecipients: [{ name: 'Synthetic Plan B fixture', kind: 'team' }] })
    const guest = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/guests`, headers, payload: { name: 'Synthetic preview guest' } })
    expect(guest.statusCode, guest.body).toBe(201)
    const rsvp = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${guest.json().id}`, headers, payload: { status: 'yes' } })
    expect(rsvp.statusCode, rsvp.body).toBe(200)
    const rejectedGuest = await activate(f, f.owner.token, randomUUID(), 'rain', before.json().previewToken)
    expect(rejectedGuest.statusCode, rejectedGuest.body).toBe(409)
    expect(rejectedGuest.json().error.code).toBe('planb_preview_changed')

    const next = await preview(f, f.owner.token)
    const helper = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, helper.userId])
    const rejectedTeam = await activate(f, f.owner.token, randomUUID(), 'rain', next)
    expect(rejectedTeam.statusCode, rejectedTeam.body).toBe(409)
    expect(rejectedTeam.json().error.code).toBe('planb_preview_changed')
    expect((await rawDb.query('select id from broadcasts where wedding_id=$1', [f.weddingId])).rowCount).toBe(0)
    expect((await app.inject({ method: 'POST', url: previewUrl, headers: auth(helper.token), payload: { scenario: 'rain' } })).statusCode).toBe(403)
    expect((await get(f, helper.token)).json().canActivate).toBe(false)
    const fresh = await app.inject({ method: 'POST', url: previewUrl, headers, payload: { scenario: 'rain' } })
    expect(fresh.statusCode, fresh.body).toBe(200)
    expect(fresh.json().manualGuests).toEqual(['Synthetic preview guest'])
    expect(fresh.json().inAppRecipients).toHaveLength(2)
    const accepted = await activate(f, f.owner.token, randomUUID(), 'rain', fresh.json().previewToken)
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().guestsAffected).toBe(1)
    expect((await rawDb.query('select id from notifications where broadcast_id=$1', [accepted.json().activationId])).rowCount).toBe(2)
  })

  it('keeps scenario details private and scopes assignments to current wedding membership', async () => {
    const f = await fixture('coordinator'), outsider = await actor(), helper = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, helper.userId])
    const read = (token: string, scenario?: string) => app.inject({ method: 'GET', url: scenarioUrl(f, scenario), headers: auth(token) })
    expect((await read(f.requester.token)).json()).toEqual({ plan: null })
    expect((await save(f, f.requester.token, savedPlan(outsider.userId))).statusCode).toBe(422)
    expect((await save(f, f.requester.token, { ...savedPlan(helper.userId), reason: '   ' })).statusCode).toBe(422)
    const result = await save(f, f.requester.token, savedPlan(helper.userId))
    expect(result.statusCode, result.body).toBe(200)
    expect(result.headers['cache-control']).toBe('no-store')
    const { plan } = result.json()
    expect(plan).toMatchObject({ reserveAddress: 'Синтетический резервный зал', actions: savedPlan(helper.userId).actions })
    const readBack = await read(f.owner.token)
    expect(readBack.headers['cache-control']).toBe('no-store')
    expect(readBack.json()).toEqual({ plan })
    expect((await read(f.owner.token, 'power')).json()).toEqual({ plan: null })
    expect((await read(outsider.token)).statusCode).toBe(404)
    expect((await read(helper.token)).statusCode).toBe(403)
    expect((await save(f, helper.token, savedPlan(helper.userId))).statusCode).toBe(403)
    expect((await get(f, helper.token)).body).not.toContain(plan.reserveAddress)

    const impact = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/planb/preview`,
      headers: auth(f.owner.token), payload: { scenario: 'rain' } })
    expect(impact.statusCode, impact.body).toBe(200)
    expect(impact.headers['cache-control']).toBe('no-store')
    expect(impact.json().reserveAddress).toBe(plan.reserveAddress)
    expect(impact.json().planDetails).toEqual({
      reason: plan.reason, triggerCondition: plan.triggerCondition,
      actions: [{ title: 'Встретить гостей', responsibleName: 'Synthetic Plan B fixture' }],
    })
    expect(impact.body).not.toContain(plan.contacts[0].value)
    const active = await activate(f, f.owner.token, randomUUID(), 'rain', impact.json().previewToken)
    expect(active.statusCode, active.body).toBe(200)
    const notices = (await rawDb.query('select title,body,link from notifications where broadcast_id=$1', [active.json().activationId])).rows
    expect(notices).toHaveLength(2)
    expect(JSON.stringify(notices)).not.toContain(plan.reserveAddress)
    expect(JSON.stringify(notices)).not.toContain(plan.contacts[0].value)
    await rawDb.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.weddingId, helper.userId])
    expect((await read(f.owner.token)).json().plan.actions).toEqual([{ title: 'Встретить гостей', responsibleUserId: null }])
  })

  it('sends only the selected recipients once and makes a losing selection observable', async () => {
    const f = await fixture('coordinator'), other = await actor(), outsider = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, other.userId])
    const token = f.owner.token
    const previewToken = await preview(f, token)
    const invalid = await activate(f, token, randomUUID(), 'rain', previewToken, [outsider.userId])
    expect(invalid.statusCode, invalid.body).toBe(422)
    expect((await rawDb.query('select id from broadcasts where wedding_id=$1', [f.weddingId])).rowCount).toBe(0)
    const choices = [
      { key: randomUUID(), ids: [f.requester.userId] },
      { key: randomUUID(), ids: [other.userId] },
    ]
    const responses = await Promise.all(choices.map(({ key, ids }) => activate(f, token, key, 'rain', previewToken, ids)))
    expect(responses.map(response => response.statusCode), responses.map(response => response.body).join('\n')).toEqual([200, 200])
    const winner = responses.findIndex(response => response.json().alreadyActive !== true)
    expect(responses.filter(response => response.json().alreadyActive === true)).toHaveLength(1)
    const receipt = responses[winner]!.json(), { key, ids } = choices[winner]!
    expect(responses[1 - winner]!.json().activationId).toBe(receipt.activationId)
    expect((await rawDb.query('select user_id from notifications where broadcast_id=$1', [receipt.activationId])).rows)
      .toEqual([{ user_id: ids[0] }])
    expect((await activate(f, token, key, 'rain', previewToken, ids)).json()).toEqual(receipt)

    const withoutNotifications = await preview(f, token, 'power')
    const activated = await activate(f, token, randomUUID(), 'power', withoutNotifications, [])
    expect(activated.statusCode, activated.body).toBe(200)
    expect((await rawDb.query('select id from notifications where broadcast_id=$1', [activated.json().activationId])).rowCount).toBe(0)
  })

  it('requires a fresh preview when a selected member leaves before confirmation', async () => {
    const f = await fixture('coordinator')
    const token = await preview(f, f.owner.token)
    await rawDb.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.weddingId, f.requester.userId])
    const result = await activate(f, f.owner.token, randomUUID(), 'rain', token, [f.requester.userId])
    expect(result.statusCode, result.body).toBe(409)
    expect(result.json().error.code).toBe('planb_preview_changed')
    expect((await rawDb.query('select id from broadcasts where wedding_id=$1', [f.weddingId])).rowCount).toBe(0)
  })

  it('exposes only the explicitly published active address to confirmed main-day guests', async () => {
    const date = (await rawDb.query<{ date: string }>("select (clock_timestamp() at time zone 'Europe/Moscow')::date::text as date")).rows[0]!.date
    const f = await fixture('coordinator', date), other = await fixture('couple', date), helper = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, helper.userId])
    async function guestDay(wedding: Fixture, status: 'yes' | 'pending') {
      const path = `/weddings/${wedding.weddingId}/guests`, headers = auth(wedding.owner.token)
      const created = await app.inject({ method: 'POST', url: path, headers, payload: { name: 'Synthetic guest' } })
      expect(created.statusCode, created.body).toBe(201)
      if (status === 'yes') {
        const rsvp = await app.inject({ method: 'PATCH', url: `${path}/${created.json().id}`, headers, payload: { status } })
        expect(rsvp.statusCode, rsvp.body).toBe(200)
      }
      const link = await app.inject({ method: 'POST', url: `${path}/${created.json().id}/invite-link`, headers })
      expect(link.statusCode, link.body).toBe(200)
      const code = (link.json().url as string).split('/').pop()!
      const invitation = await app.inject({ method: 'GET', url: `/invite/${code}` })
      expect(invitation.statusCode, invitation.body).toBe(200)
      const token = invitation.json().guestToken
      return async () => {
        const response = await app.inject({ method: 'GET', url: `/join/${token}/day` })
        expect(response.statusCode, response.body).toBe(200)
        expect(response.headers['cache-control']).toBe('no-store')
        return response.json()
      }
    }
    const readConfirmed = await guestDay(f, 'yes'), readPending = await guestDay(f, 'pending'), readOther = await guestDay(other, 'yes')
    const token = f.requester.token, initial = savedPlan(f.owner.userId)
    const stored = await save(f, token, initial)
    expect(stored.statusCode, stored.body).toBe(200)
    const active = await activate(f, token, randomUUID(), 'rain', await preview(f, token), [])
    expect(active.statusCode, active.body).toBe(200)
    const { activationId } = active.json()
    const setVisibility = (userToken: string, visible: boolean, id = activationId) =>
      app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/planb/guest-address`,
        headers: auth(userToken), payload: { activationId: id, visible } })
    expect((await readConfirmed()).planB).toEqual({ reserveAddress: null })
    expect((await setVisibility(helper.token, true)).statusCode).toBe(403)
    expect((await setVisibility(other.owner.token, true)).statusCode).toBe(404)
    const opened = await setVisibility(token, true)
    expect(opened.statusCode, opened.body).toBe(200)
    expect((await setVisibility(token, true)).json()).toEqual({ published: true })
    expect((await readConfirmed()).planB).toEqual({ reserveAddress: initial.reserveAddress })
    expect(await readPending()).not.toHaveProperty('planB')
    expect(await readOther()).not.toHaveProperty('planB')

    const changed = await save(f, token, { ...initial, expectedRevision: stored.json().plan.revision, reserveAddress: 'Новый черновик' })
    expect(changed.statusCode, changed.body).toBe(200)
    expect((await setVisibility(token, true)).statusCode).toBe(409)
    expect((await readConfirmed()).planB).toEqual({ reserveAddress: initial.reserveAddress })
    expect((await setVisibility(token, false)).json()).toEqual({ published: false })
    expect((await readConfirmed()).planB).toEqual({ reserveAddress: null })
    const replacement = await activate(f, token, randomUUID(), 'rain', await preview(f, token), [])
    expect(replacement.statusCode, replacement.body).toBe(200)
    expect(replacement.json().activationId).not.toBe(activationId)
    expect((await setVisibility(token, false)).statusCode).toBe(409)
    expect((await readConfirmed()).planB).toEqual({ reserveAddress: null })
    expect((await rawDb.query('select id from notifications where broadcast_id=any($1::uuid[])',
      [[activationId, replacement.json().activationId]])).rowCount).toBe(0)
  })

  it('serializes two edits and requires explicit activation of the new version once', async () => {
    const f = await fixture('coordinator'), token = f.owner.token
    const input = savedPlan(f.requester.userId)
    const first = await save(f, token, input)
    expect(first.statusCode, first.body).toBe(200)
    const expectedRevision = first.json().plan.revision
    const unchanged = await save(f, token, { ...input, expectedRevision, reason: ' ' + input.reason })
    expect(unchanged.json().plan.revision).toBe(expectedRevision)
    const oldPreview = await preview(f, token)
    const firstActivation = await activate(f, token, randomUUID(), 'rain', oldPreview)
    expect(firstActivation.statusCode, firstActivation.body).toBe(200)
    const previewRequest = () => app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/planb/preview`,
      headers: auth(token), payload: { scenario: 'rain' } })
    expect((await previewRequest()).json()).toMatchObject({ currentScenario: 'rain', alreadyActive: true })
    const edits = await Promise.all([
      save(f, token, { ...input, expectedRevision, reserveAddress: 'Синтетический зал 2' }),
      save(f, f.requester.token, { ...input, expectedRevision, reserveAddress: 'Синтетический зал 3' }),
    ])
    expect(edits.map(edit => edit.statusCode).sort(), edits.map(edit => edit.body).join('\n')).toEqual([200, 409])
    expect(edits.find(edit => edit.statusCode === 409)!.json().error.code).toBe('planb_scenario_changed')
    const newRevision = edits.find(edit => edit.statusCode === 200)!.json().plan.revision
    expect(newRevision).not.toBe(expectedRevision)
    const stale = await activate(f, token, randomUUID(), 'rain', oldPreview)
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('planb_preview_changed')
    expect((await previewRequest()).json()).toMatchObject({ currentScenario: 'rain', alreadyActive: false })
    const next = await preview(f, token)
    const repeated = await Promise.all([
      activate(f, token, randomUUID(), 'rain', next), activate(f, token, randomUUID(), 'rain', next),
    ])
    expect(repeated.map(response => response.statusCode), repeated.map(response => response.body).join('\n')).toEqual([200, 200])
    expect(repeated[0]!.json().activationId).toBe(repeated[1]!.json().activationId)
    expect((await rawDb.query(`select id,planb_current,planb_revision from broadcasts
      where wedding_id=$1 order by planb_current`, [f.weddingId])).rows).toEqual([
      { id: firstActivation.json().activationId, planb_current: false, planb_revision: expectedRevision },
      { id: repeated[0]!.json().activationId, planb_current: true, planb_revision: newRevision },
    ])
  })

  it('requires a preview for a new command and preserves exact replay of a historical command', async () => {
    const f = await fixture()
    const key = randomUUID()
    const fresh = await activate(f, f.owner.token, key)
    expect(fresh.statusCode, fresh.body).toBe(400)
    expect(fresh.json().error.code).toBe('planb_preview_required')
    const body = { scenario: 'rain', guestsAffected: 2 }
    const requestHash = createHash('sha256').update(`/weddings/${f.weddingId}/planb/activate\n{"scenario":"rain"}`).digest('hex')
    await rawDb.query("insert into idempotency_keys(key,user_id,route,request_hash,status,body) values($1,$2,'planb-activate',$3,200,$4)",
      [`${f.owner.userId}:planb-activate:${key}`, f.owner.userId, requestHash, JSON.stringify(body)])
    const replayed = await activate(f, f.owner.token, key)
    expect(replayed.statusCode, replayed.body).toBe(200)
    expect(replayed.json()).toEqual(body)
    expect(replayed.headers['idempotent-replay']).toBe('true')
    expect((await rawDb.query('select id from broadcasts where wedding_id=$1', [f.weddingId])).rowCount).toBe(0)
  })

  it('requires reconfirmation after a different scenario is activated', async () => {
    const f = await fixture('coordinator')
    const rain = await preview(f, f.owner.token)
    const power = await preview(f, f.requester.token, 'power')
    const first = await activate(f, f.owner.token, randomUUID(), 'rain', rain)
    expect(first.statusCode, first.body).toBe(200)
    const stale = await activate(f, f.requester.token, randomUUID(), 'power', power)
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('planb_preview_changed')
    expect((await get(f)).json().scenario).toBe('rain')
    const fresh = await preview(f, f.requester.token, 'power')
    const next = await activate(f, f.requester.token, randomUUID(), 'power', fresh)
    expect(next.statusCode, next.body).toBe(200)
    expect((await get(f)).json().scenario).toBe('power')
  })

  it('refuses an expired preview and a preview issued in another session', async () => {
    const f = await fixture()
    const token = await preview(f, f.owner.token)
    const another = await device(f.owner.userId)
    expect((await activate(f, another.token, randomUUID(), 'rain', token)).statusCode).toBe(422)
    const restore = instrument({ before(sql) {
      if (sql === 'select clock_timestamp() as now') return "select clock_timestamp() + interval '11 minutes' as now"
    } })
    try {
      const expired = await activate(f, f.owner.token, randomUUID(), 'rain', token)
      expect(expired.statusCode, expired.body).toBe(409)
      expect(expired.json().error.code).toBe('planb_preview_expired')
    } finally { restore() }
    expect((await rawDb.query('select id from broadcasts where wedding_id=$1', [f.weddingId])).rowCount).toBe(0)
  })

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

  async function whileWeddingWaits(f: Fixture, change: (client: Queryable) => Promise<unknown>, label: string,
    request = () => get(f)): Promise<Response> {
    let pending: Promise<Response> | undefined, settled = false
    try {
      await rawDb.tx(async client => {
        const holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        await client.query('select id from weddings where id=$1 for update', [f.weddingId])
        pending = request().then(response => { settled = true; return response }, error => { settled = true; throw error })
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
