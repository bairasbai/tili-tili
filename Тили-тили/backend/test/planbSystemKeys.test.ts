import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Db, Queryable } from '../src/plugins/db.js'

// Intended final placement: backend/test/planbSystemKeys.test.ts.
// Independent contract literals; do not import a production template/guard.
const TEMPLATES = [
  { key: 'planb.vendor_arrival', title: 'Обзвонить всех подрядчиков за 1–2 дня: время и адрес прибытия' },
  { key: 'planb.rings_passports', title: 'Кольца и паспорта — у свидетелей' },
  { key: 'planb.venue_materials', title: 'Алкоголь и реквизит отвезти на площадку накануне вечером' },
  { key: 'planb.weather_venue_backup', title: 'Проверить прогноз погоды и план Б площадки' },
  { key: 'planb.timeline_buffer', title: 'Запас 15 минут в каждом блоке тайминга' },
  { key: 'planb.emergency_kit', title: 'Powerbank, аптечка, швейный набор, присыпка от пятен' },
] as const
const DB = process.env.TEST_DATABASE_URL
const SECRET = 'synthetic-planb-system-key-access'.repeat(3), POLICY = '2026-09-02'
const APPLICATION = 'planb_system_keys_' + randomUUID()
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
interface Item { id: string; title: string; done: boolean }
interface PlanB { scenario: string | null; activatedAt: string | null; checklist: Item[] }
interface TaskRow { id: string; wedding_id: string; title: string; source: string; kind: string; sort: number; key: string | null; done_at: Date | null }
interface Probe { before?: (sql: string, values: readonly unknown[] | undefined) => void; after?: (sql: string, values: readonly unknown[] | undefined, result: pg.QueryResult) => Promise<void> | void }
type IdentityKind = 'users' | 'sessions' | 'consents' | 'weddings' | 'tasks' | 'notifications'
const errorFacts = (error: unknown) => {
  const value = error as { code?: string; constraint?: string; message?: string } | null
  return { code: value?.code ?? null, constraint: value?.constraint ?? null, message: value?.message ?? null }
}

interface WeddingWaiter { pid: number; datname: string; application_name: string; state: string; wait_event_type: string | null; query: string; blockers: number[] }
function weddingWaiterGraph(waiting: readonly WeddingWaiter[], holderPid: number, database: string, application: string): boolean {
  if (!Number.isInteger(holderPid) || holderPid <= 0 || waiting.length !== 2) return false
  if (waiting.some(row => !Number.isInteger(row.pid) || row.pid <= 0 || row.pid === holderPid
    || row.datname !== database || row.application_name !== application || row.state !== 'active' || row.wait_event_type !== 'Lock'
    || !/^select\s+archived_at\s*,\s*cancelled_at\s+from\s+weddings\s+where\s+id\s*=\s*\$1\s+for\s+update\s*;?$/i.test(row.query.trim()))) return false
  const first = waiting[0]!, second = waiting[1]!
  if (first.pid === second.pid) return false
  const edge = (row: WeddingWaiter, blocker: number) => row.blockers.length === 1 && row.blockers[0] === blocker
  // Exactly two direct edges, or one peer edge followed by the holder edge.
  // No external blocker, cycle, duplicate/multiple blocker or deeper chain.
  return (edge(first, holderPid) && edge(second, holderPid))
    || (edge(first, second.pid) && edge(second, holderPid))
    || (edge(second, first.pid) && edge(first, holderPid))
}

// Missing or unsafe configuration fails this suite; it never silently skips it.
describe('T023: persistent Plan B semantic identity through real HTTP and PostgreSQL DML', () => {
  let app: FastifyInstance, rawDb: Db, connectionUrl: string, keyColumnObserved = false
  const manifest: Record<IdentityKind, Set<string>> = { users: new Set(), sessions: new Set(), consents: new Set(), weddings: new Set(), tasks: new Set(), notifications: new Set() }
  const witnesses: object[] = []
  function journal(kind: IdentityKind, id: string): string {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    if (!manifest[kind].has(id)) {
      manifest[kind].add(id)
      process.stdout.write(`PLANB_KEYS_IDENTITY ${JSON.stringify({ application: APPLICATION, kind, id, beforeWrite: true })}\n`)
    }
    return id
  }
  const ownId = (kind: IdentityKind) => journal(kind, randomUUID())
  function note(value: object) { witnesses.push(value); process.stdout.write(`PLANB_KEYS_WITNESS ${JSON.stringify(value)}\n`) }
  async function identity(client: Queryable) {
    const actual = (await client.query<{ name: string; address: string; port: number; username: string }>(
      'select current_database() as name,host(inet_server_addr()) as address,inet_server_port() as port,current_user as username')).rows[0]!
    const target = new URL(connectionUrl)
    assert.equal(actual.name, target.pathname.slice(1)); assert.equal(actual.port, 15432)
    assert.equal(actual.username, 'codex_test'); assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(actual.address))
    return actual
  }
  beforeAll(async () => {
    assert(DB, 'TEST_DATABASE_URL is required: no skipped PostgreSQL acceptance')
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.username, 'codex_test'); assert.equal(target.password, '')
    assert.equal(target.port, '15432'); assert.equal(target.search, ''); assert.equal(target.hash, '')
    assert(['/tili_ecosystem_planbkeys_20261003_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    target.searchParams.set('application_name', APPLICATION); connectionUrl = target.href
    app = await buildApp({ env: 'test', databaseUrl: connectionUrl, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'synthetic-planb-system-key-refresh'.repeat(3), policyVersion: POLICY,
      rateLimitPerSecond: 0 }, [], { tillyModel: null })
    await app.ready(); rawDb = app.db!
    const actual = await identity(rawDb)
    keyColumnObserved = (await rawDb.query<{ present: boolean }>(`select exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='tasks' and column_name='system_template_key') as present`)).rows[0]!.present
    note({ test: 'live identity and schema prerequisite', actual, keyColumnObserved })
    app.db = forwardingDb()
  })
  afterAll(async () => {
    if (!app) return
    if (!rawDb) { await app.close(); return }
    app.db = rawDb
    try {
      const users = [...manifest.users], weddings = [...manifest.weddings]
      // Children discovered here are scoped to previously journaled parent IDs.
      for (const row of (await rawDb.query<{ id: string }>('select id from tasks where wedding_id=any($1::uuid[])', [weddings])).rows) manifest.tasks.add(row.id)
      for (const row of (await rawDb.query<{ id: string }>('select id from notifications where user_id=any($1::uuid[])', [users])).rows) manifest.notifications.add(row.id)
      for (const id of weddings) await rawDb.query('delete from weddings where id=$1', [id])
      for (const id of users) await rawDb.query('delete from users where id=$1', [id])
      const remaining = (await rawDb.query<Record<IdentityKind, string>>(`select
        (select count(*)::text from users where id=any($1::uuid[])) as users,
        (select count(*)::text from sessions where id=any($2::uuid[]) or user_id=any($1::uuid[])) as sessions,
        (select count(*)::text from consents where id=any($3::uuid[]) or user_id=any($1::uuid[])) as consents,
        (select count(*)::text from tasks where id=any($4::uuid[]) or wedding_id=any($5::uuid[])) as tasks,
        (select count(*)::text from weddings where id=any($5::uuid[])) as weddings,
        (select count(*)::text from notifications where id=any($6::uuid[]) or user_id=any($1::uuid[])) as notifications`,
      [users, [...manifest.sessions], [...manifest.consents], [...manifest.tasks], weddings, [...manifest.notifications]])).rows[0]!
      process.stdout.write(`PLANB_KEYS_FIXTURE_CLEANUP ${JSON.stringify(remaining)}\n`)
      expect(remaining).toEqual({ users: '0', sessions: '0', consents: '0', tasks: '0', weddings: '0', notifications: '0' })
      process.stdout.write(`PLANB_KEYS_FINAL_MANIFEST ${JSON.stringify(Object.fromEntries(Object.entries(manifest).map(([kind, ids]) => [kind, [...ids]])))}\n`)
      process.stdout.write(`PLANB_KEYS_WITNESSES ${JSON.stringify(witnesses)}\n`)
    } finally { await app.close() }
  })

  // Forwarding is only for before-write IDs and real interruption evidence.
  // Neither SQL results nor the semantic expected key vector are fabricated.
  function forwardingDb(probe: Probe = {}): Db {
    const wrap = (client: Queryable): Queryable => ({
      async query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<pg.QueryResult<T>> {
        if (/^\s*insert\s+into\s+tasks\b/i.test(sql) && typeof values?.[0] === 'string' && values.some(v => typeof v === 'string' && manifest.weddings.has(v))) journal('tasks', values[0])
        if (/^\s*insert\s+into\s+notifications\b/i.test(sql) && typeof values?.[0] === 'string' && values.some(v => typeof v === 'string' && manifest.users.has(v))) journal('notifications', values[0])
        probe.before?.(sql, values)
        const result = await client.query<T>(sql, values); await probe.after?.(sql, values, result); return result
      },
    })
    return { query: wrap(rawDb).query, tx: action => rawDb.tx(client => action(wrap(client))), ping: () => rawDb.ping(), close: () => rawDb.close() }
  }
  async function actor() {
    const userId = ownId('users'), consentId = ownId('consents'), sessionId = ownId('sessions')
    let created = false
    for (let attempt = 0; attempt < 8; attempt++) {
      const inserted = await rawDb.query<{ id: string }>('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id',
        [userId, '+79' + randomInt(100_000_000, 999_999_999), 'Synthetic system-key fixture'])
      if (inserted.rows[0]?.id === userId) { created = true; break }
    }
    assert(created, 'Could not allocate a synthetic phone after eight atomic attempts')
    await rawDb.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    await rawDb.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    return { userId, consentId, sessionId, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  async function fixture() {
    const owner = await actor(), weddingId = ownId('weddings')
    await rawDb.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic key wedding','2027-06-14','Europe/Moscow',$3)", [weddingId, owner.userId, randomUUID()])
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    return { weddingId, owner }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function device(userId: string) {
    const sessionId = ownId('sessions')
    await rawDb.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    return { sessionId, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  const auth = (token: string) => ({ authorization: 'Bearer ' + token })
  const get = (f: Fixture, token = f.owner.token) => Promise.resolve(app.inject({ method: 'GET', url: `/weddings/${f.weddingId}/planb`, headers: auth(token) }))
  const create = (f: Fixture, payload: Record<string, unknown>) => Promise.resolve(app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/tasks`, headers: auth(f.owner.token), payload }))
  const patch = (f: Fixture, id: string, payload: Record<string, unknown>, token = f.owner.token) => Promise.resolve(app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/tasks/${id}`, headers: auth(token), payload }))
  async function rows(f: Fixture): Promise<TaskRow[]> {
    // Works on old schema too: NULL here is semantic absence, never SQLSTATE42703.
    return (await rawDb.query<TaskRow>(`select id,wedding_id,title,source,kind,sort,done_at,
      to_jsonb(t)->>'system_template_key' as key from tasks t where wedding_id=$1 and kind='planb' order by sort,title`, [f.weddingId])).rows
  }
  async function snapshot(fs: Fixture[], client: Queryable = rawDb) {
    const ids = fs.map(f => f.weddingId)
    const tasks = (await client.query('select to_jsonb(t) as task from tasks t where wedding_id=any($1::uuid[]) order by id', [ids])).rows
    const notices = (await client.query(`select to_jsonb(n) as notice from notifications n
      where task_id in(select id from tasks where wedding_id=any($1::uuid[])) order by id`, [ids])).rows
    return { tasks, notices }
  }
  async function readSet(f: Fixture, response: Response): Promise<PlanB> {
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json<PlanB>(), actual = await rows(f)
    expect(Object.keys(body).sort()).toEqual(['activatedAt', 'checklist', 'scenario'])
    expect(body.checklist).toHaveLength(6); expect(actual).toHaveLength(6)
    expect(new Set(body.checklist.map(item => item.id)).size).toBe(6)
    for (const item of body.checklist) expect(Object.keys(item).sort()).toEqual(['done', 'id', 'title'])
    expect(body.checklist.map(item => item.id)).toEqual(actual.map(row => row.id))
    return body
  }
  function needKeyColumn() {
    expect(keyColumnObserved, 'NEW_SCHEMA_PREREQUISITE_ONLY: no column-dependent SQL was executed on the old schema').toBe(true)
  }
  async function requireKeys(f: Fixture) {
    const actual = await rows(f)
    note({ test: 'actual semantic storage', weddingId: f.weddingId, rows: actual })
    expect(actual.map(row => ({ key: row.key, title: row.title, source: row.source, kind: row.kind, sort: row.sort })))
      .toEqual(TEMPLATES.map((item, sort) => ({ ...item, source: 'system', kind: 'planb', sort })))
    expect(new Set(actual.map(row => row.key)).size).toBe(6)
    return actual
  }
  async function insert(f: Fixture, source: 'system' | 'user' | 'ai', kind: 'planb' | 'checklist', title = 'Synthetic direct task') {
    const id = ownId('tasks')
    await rawDb.query('insert into tasks(id,wedding_id,title,source,kind) values($1,$2,$3,$4,$5)', [id, f.weddingId, title, source, kind])
    return id
  }
  async function keyed(f: Fixture, key: string, title = 'Synthetic trusted SQL template item', client: Queryable = rawDb, id = ownId('tasks')) {
    needKeyColumn()
    await client.query("insert into tasks(id,wedding_id,title,source,kind,system_template_key) values($1,$2,$3,'system','planb',$4)", [id, f.weddingId, title, key])
    return id
  }
  async function rejected(label: string, fs: Fixture[], sql: string, values: readonly unknown[], expected = '23514') {
    const before = await snapshot(fs)
    let error: unknown = null, acceptedSnapshot: unknown = null
    await rawDb.tx(async client => {
      await client.query('savepoint semantic_attempt')
      try { await client.query(sql, values); acceptedSnapshot = await snapshot(fs, client) } catch (caught) { error = caught }
      // Both an old accepted statement and a new rejected statement are rolled back.
      await client.query('rollback to savepoint semantic_attempt')
      expect(await snapshot(fs, client)).toEqual(before)
    })
    const facts = errorFacts(error)
    note({ test: label, operation: sql, expected, ...facts, accepted: error === null,
      acceptedChangedSnapshot: error === null && JSON.stringify(acceptedSnapshot) !== JSON.stringify(before),
      acceptedBefore: error === null ? before : null, acceptedAfter: error === null ? acceptedSnapshot : null })
    expect(facts.code, `${label}: accepted old operations are semantic red; missing-column errors are never accepted`).toBe(expected)
    expect(await snapshot(fs)).toEqual(before)
  }

  it('fresh GET stores all six exact semantic keys while preserving the internal HTTP projection and ordinary checklist rows', async () => {
    const f = await fixture()
    await insert(f, 'user', 'checklist', TEMPLATES[0].title); await insert(f, 'system', 'checklist', 'Synthetic ordinary system checklist')
    const previous = await snapshot([f]), body = await readSet(f, await get(f)), actual = await requireKeys(f)
    expect(body.checklist.map(item => ({ title: item.title, done: item.done }))).toEqual(TEMPLATES.map(item => ({ title: item.title, done: false })))
    expect(actual.every(row => row.done_at === null)).toBe(true)
    const after = await snapshot([f]); for (const row of previous.tasks) expect(after.tasks).toContainEqual(row)
    const other = await device(f.owner.userId), stable = await snapshot([f])
    for (const token of [f.owner.token, other.token, f.owner.token]) expect(await readSet(f, await get(f, token))).toEqual(body)
    expect(await snapshot([f])).toEqual(stable)
  })

  it('the same bare SYSTEM/PLANB INSERT is refused without relying on a new column in its statement', async () => {
    const f = await fixture(), id = ownId('tasks')
    await rejected('bare new SYSTEM/PLANB insert', [f], "insert into tasks(id,wedding_id,title,source,kind) values($1,$2,'Synthetic bare system row','system','planb')", [id, f.weddingId])
  })
  it.each(['user/checklist', 'user/planb', 'ai/planb', 'system/checklist'] as const)('unkeyed %s cannot be promoted into SYSTEM/PLANB by UPDATE', async pair => {
    const f = await fixture(), [source, kind] = pair.split('/') as ['system' | 'user' | 'ai', 'checklist' | 'planb'], id = await insert(f, source, kind)
    await rejected('unkeyed transition ' + pair, [f], "update tasks set source='system',kind='planb' where id=$1", [id])
  })
  it.each(['user/checklist', 'user/planb', 'ai/planb', 'system/checklist'] as const)('ordinary unkeyed %s INSERT remains permitted', async pair => {
    const f = await fixture(), [source, kind] = pair.split('/') as ['system' | 'user' | 'ai', 'checklist' | 'planb'], id = await insert(f, source, kind)
    const task = (await rawDb.query<{ source: string; kind: string; key: string | null }>("select source,kind,to_jsonb(t)->>'system_template_key' as key from tasks t where id=$1", [id])).rows[0]!
    expect(task).toEqual({ source, kind, key: null })
  })

  it.each([null, '', ' ', 'planb.unknown'] as const)('new SYSTEM/PLANB cannot be inserted with explicit key %s', async key => {
    needKeyColumn(); const f = await fixture(), id = ownId('tasks')
    await rejected('explicit missing or unknown key ' + String(key), [f], "insert into tasks(id,wedding_id,title,source,kind,system_template_key) values($1,$2,'Synthetic malformed key','system','planb',$3)", [id, f.weddingId, key])
  })
  for (const template of TEMPLATES) {
    it.each(['user', 'ai'] as const)(`${template.key} is refused on source=%s`, async source => {
      needKeyColumn(); const f = await fixture(), id = ownId('tasks')
      await rejected('wrong key source ' + source + '/' + template.key, [f], "insert into tasks(id,wedding_id,title,source,kind,system_template_key) values($1,$2,'Synthetic misplaced key',$3,'planb',$4)", [id, f.weddingId, source, template.key])
    })
    it(`${template.key} is refused on ordinary system/checklist`, async () => {
      needKeyColumn(); const f = await fixture(), id = ownId('tasks')
      await rejected('wrong key kind ' + template.key, [f], "insert into tasks(id,wedding_id,title,source,kind,system_template_key) values($1,$2,'Synthetic misplaced kind','system','checklist',$3)", [id, f.weddingId, template.key])
    })
  }
  it('uniqueness scopes the semantic key by wedding while different keys permit identical titles', async () => {
    needKeyColumn(); const a = await fixture(), b = await fixture()
    const first = await keyed(a, TEMPLATES[0].key, 'Shared synthetic title'), duplicate = ownId('tasks')
    await rejected('same key different UUID/title', [a], "insert into tasks(id,wedding_id,title,source,kind,sort,system_template_key) values($1,$2,'Different synthetic title','system','planb',91,$3)", [duplicate, a.weddingId, TEMPLATES[0].key], '23505')
    const second = await keyed(a, TEMPLATES[1].key, 'Shared synthetic title'), foreign = await keyed(b, TEMPLATES[0].key, 'Shared synthetic title')
    expect((await rows(a)).map(row => row.id).sort()).toEqual([first, second].sort()); expect((await rows(b)).map(row => row.id)).toEqual([foreign])
  })

  for (const change of ['id', 'wedding', 'source-user', 'source-ai', 'kind'] as const) {
    it(`existing initialized SYSTEM/PLANB ${change} identity is immutable with old-schema-compatible DML`, async () => {
      const f = await fixture(), destination = await fixture(), first = await readSet(f, await get(f)), id = first.checklist[0]!.id
      const changes = {
        id: { sql: 'update tasks set id=$2 where id=$1', value: ownId('tasks') },
        wedding: { sql: 'update tasks set wedding_id=$2 where id=$1', value: destination.weddingId },
        'source-user': { sql: 'update tasks set source=$2 where id=$1', value: 'user' },
        'source-ai': { sql: 'update tasks set source=$2 where id=$1', value: 'ai' },
        kind: { sql: 'update tasks set kind=$2 where id=$1', value: 'checklist' },
      }
      await rejected('initialized system identity ' + change, [f, destination], changes[change].sql, [id, changes[change].value])
      expect(await rows(destination)).toHaveLength(0)
    })
  }
  it.each([null, TEMPLATES[1].key, 'planb.unknown'] as const)('existing keyed identity cannot change its key to %s', async key => {
    needKeyColumn(); const f = await fixture(), id = await keyed(f, TEMPLATES[0].key)
    await rejected('key mutation ' + String(key), [f], 'update tasks set system_template_key=$2 where id=$1', [id, key])
  })
  it.each(['user/checklist', 'ai/planb', 'system/checklist'] as const)('key NULL is immutable for existing %s, including a simultaneous identity promotion', async pair => {
    needKeyColumn(); const f = await fixture(), [source, kind] = pair.split('/') as ['system' | 'user' | 'ai', 'checklist' | 'planb'], id = await insert(f, source, kind)
    await rejected('NULL to known key ' + pair, [f], 'update tasks set system_template_key=$2 where id=$1', [id, TEMPLATES[0].key])
    await rejected('NULL to known with promotion ' + pair, [f], "update tasks set source='system',kind='planb',system_template_key=$2 where id=$1", [id, TEMPLATES[0].key])
  })
  it('same-value identity UPDATE and ordinary title/done/sort/due edits keep the key', async () => {
    needKeyColumn(); const f = await fixture(), id = await keyed(f, TEMPLATES[0].key), before = await snapshot([f])
    expect((await rawDb.query('update tasks set id=id,wedding_id=wedding_id,source=source,kind=kind,system_template_key=system_template_key where id=$1', [id])).rowCount).toBe(1)
    expect(await snapshot([f])).toEqual(before)
    expect((await rawDb.query("update tasks set title='Synthetic SQL edit',done_at='2027-05-01T12:00:00Z',sort=42,due='2027-05-02',due_mode='fixed' where id=$1", [id])).rowCount).toBe(1)
    expect((await rows(f))[0]).toMatchObject({ id, key: TEMPLATES[0].key, source: 'system', kind: 'planb', title: 'Synthetic SQL edit', sort: 42, done_at: new Date('2027-05-01T12:00:00Z') })
    // Direct SQL domain compatibility does not imply Plan B scheduling API support.
  })

  it('second-session title/done edits permit two identical system titles without changing keys or restoring template text', async () => {
    const f = await fixture(), original = await readSet(f, await get(f)), before = await rows(f), other = await device(f.owner.userId), title = 'Synthetic identical changed titles'
    for (const item of original.checklist.slice(0, 2)) {
      const response = await patch(f, item.id, { title, done: true }, other.token)
      expect(response.statusCode, response.body).toBe(200); expect(response.json()).toMatchObject({ id: item.id, title, done: true, custom: false })
      expect(response.json()).not.toHaveProperty('system_template_key'); expect(response.json()).not.toHaveProperty('systemTemplateKey')
    }
    const stable = await snapshot([f]), actual = await rows(f)
    expect(actual.map(row => ({ id: row.id, key: row.key, source: row.source, kind: row.kind, sort: row.sort })))
      .toEqual(before.map(row => ({ id: row.id, key: row.key, source: row.source, kind: row.kind, sort: row.sort })))
    const expected = { ...original, checklist: original.checklist.map((item, i) => i < 2 ? { ...item, title, done: true } : item) }
    for (const token of [other.token, f.owner.token]) expect(await readSet(f, await get(f, token))).toEqual(expected)
    expect(await snapshot([f])).toEqual(stable)
  })
  it.each(['system_template_key', 'systemTemplateKey', 'source', 'kind', 'weddingId'] as const)('strict valid POST and PATCH reject extra %s without writes', async field => {
    const f = await fixture(), first = await readSet(f, await get(f)), values = { system_template_key: TEMPLATES[0].key, systemTemplateKey: TEMPLATES[0].key, source: 'system', kind: 'planb', weddingId: f.weddingId }
    const before = await snapshot([f]), posted = await create(f, { title: 'Synthetic valid base title', period: '3', [field]: values[field] })
    expect(posted.statusCode, posted.body).toBe(422); expect(await snapshot([f])).toEqual(before)
    const changed = await patch(f, first.checklist[0]!.id, { title: 'Synthetic valid rename', [field]: values[field] })
    expect(changed.statusCode, changed.body).toBe(422); expect(await snapshot([f])).toEqual(before)
  })
  it.each(['due', 'dueMode', 'assigneeId', 'reminderDaysBefore', 'reminderTime'] as const)('Plan B PATCH continues to refuse scheduling field %s', async field => {
    const f = await fixture(), first = await readSet(f, await get(f)), values = { due: '2027-05-01', dueMode: 'fixed', assigneeId: f.owner.userId, reminderDaysBefore: 1, reminderTime: '10:30' }, before = await snapshot([f])
    const changed = await patch(f, first.checklist[0]!.id, { [field]: values[field] })
    expect(changed.statusCode, changed.body).toBe(422); expect(await snapshot([f])).toEqual(before)
  })
  it('two user copies of every template title remain separate unkeyed checklist tasks and monthly listing excludes Plan B', async () => {
    const f = await fixture(), ids: string[] = []
    for (const template of TEMPLATES) for (let copy = 0; copy < 2; copy++) {
      const response = await create(f, { title: template.title, period: '3' })
      expect(response.statusCode, response.body).toBe(201); ids.push(response.json().id)
    }
    expect(ids).toHaveLength(12); expect(new Set(ids).size).toBe(12)
    await readSet(f, await get(f)); await requireKeys(f)
    const listed = await app.inject({ method: 'GET', url: `/weddings/${f.weddingId}/tasks`, headers: auth(f.owner.token) })
    expect(listed.statusCode, listed.body).toBe(200); expect(listed.json().map((item: Item) => item.id).sort()).toEqual(ids.sort())
    for (const template of TEMPLATES) expect(listed.json().filter((item: Item) => item.title === template.title)).toHaveLength(2)
    const actual = (await rawDb.query<{ id: string; source: string; kind: string; key: string | null }>("select id,source,kind,to_jsonb(t)->>'system_template_key' as key from tasks t where id=any($1::uuid[])", [ids])).rows
    expect(actual).toHaveLength(12); expect(actual.every(row => row.source === 'user' && row.kind === 'checklist' && row.key === null)).toBe(true)
  })
  it('foreign keyed task PATCH and DELETE return 404 without exposing or changing another wedding', async () => {
    const a = await fixture(), b = await fixture(), foreign = await readSet(b, await get(b)), before = await snapshot([a, b]), id = foreign.checklist[0]!.id
    const changed = await patch(a, id, { title: 'Synthetic forbidden edit' })
    expect(changed.statusCode, changed.body).toBe(404)
    const deleted = await app.inject({ method: 'DELETE', url: `/weddings/${a.weddingId}/tasks/${id}`, headers: auth(a.owner.token) })
    expect(deleted.statusCode, deleted.body).toBe(404); expect(await snapshot([a, b])).toEqual(before)
  })

  it('system API DELETE remains 409, user DELETE remains 204, and SQL deletion releases a key without repairing a nonempty partial set', async () => {
    needKeyColumn(); const f = await fixture(), first = await readSet(f, await get(f)), original = await requireKeys(f), id = first.checklist[0]!.id, before = await snapshot([f])
    const refused = await app.inject({ method: 'DELETE', url: `/weddings/${f.weddingId}/tasks/${id}`, headers: auth(f.owner.token) })
    expect(refused.statusCode, refused.body).toBe(409); expect(refused.json().error.code).toBe('system_task'); expect(await snapshot([f])).toEqual(before)
    const custom = await create(f, { title: TEMPLATES[0].title, period: '3' }); expect(custom.statusCode, custom.body).toBe(201)
    const removed = await app.inject({ method: 'DELETE', url: `/weddings/${f.weddingId}/tasks/${custom.json().id}`, headers: auth(f.owner.token) })
    expect(removed.statusCode, removed.body).toBe(204)
    expect((await rawDb.query('delete from tasks where id=$1', [id])).rowCount).toBe(1)
    const partial = await snapshot([f]), response = await get(f)
    expect(response.statusCode, response.body).toBe(200); expect(response.json<PlanB>().checklist).toHaveLength(5); expect(await snapshot([f])).toEqual(partial)
    const replacement = await keyed(f, TEMPLATES[0].key, 'Synthetic explicitly reinserted key')
    expect(replacement).not.toBe(id); expect(await rows(f)).toHaveLength(6)
    await rawDb.query("delete from tasks where wedding_id=$1 and kind='planb'", [f.weddingId])
    const regenerated = await readSet(f, await get(f)); await requireKeys(f)
    expect(regenerated.checklist.every(item => !original.some(row => row.id === item.id) && item.id !== replacement)).toBe(true)
  })
  it('parent wedding cascade deletes keyed rows and preserves a distinct foreign sentinel', async () => {
    const f = await fixture(), sentinel = await fixture(); await readSet(f, await get(f)); await requireKeys(f); await readSet(sentinel, await get(sentinel))
    const before = await snapshot([sentinel]); expect((await rawDb.query('delete from weddings where id=$1', [f.weddingId])).rowCount).toBe(1)
    expect(await rows(f)).toHaveLength(0); expect(await snapshot([sentinel])).toEqual(before)
  })
  it.each(['couple', 'helper', 'coordinator'] as const)('registered %s export keeps the legacy task projection and excludes foreign wedding keys', async role => {
    const f = await fixture(), foreign = await fixture(), caller = role === 'couple' ? f.owner : await actor()
    if (role !== 'couple') await rawDb.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [f.weddingId, caller.userId, role])
    await readSet(f, await get(f)); await requireKeys(f); await readSet(foreign, await get(foreign))
    const response = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(caller.token) })
    expect(response.statusCode, response.body).toBe(200)
    const tasks = response.json<{ tasks: Record<string, unknown>[] }>().tasks
    expect(tasks).toHaveLength(6)
    for (const task of tasks) {
      expect(Object.keys(task).sort()).toEqual(['done_at', 'due', 'period', 'source', 'title', 'wedding_id'])
      expect(task.wedding_id).toBe(f.weddingId); expect(task.source).toBe('system')
    }
    expect(tasks.map(task => task.title)).toEqual(TEMPLATES.map(template => template.title))
  })

  it('a multirow statement with a forbidden key change leaves the allowed neighbour and real notice unchanged', async () => {
    needKeyColumn(); const f = await fixture(), helper = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, helper.userId])
    const custom = await create(f, { title: 'Synthetic neighbour', period: '3', assigneeId: helper.userId, due: '2027-05-01' })
    expect(custom.statusCode, custom.body).toBe(201); const neighbour = custom.json().id as string, target = await keyed(f, TEMPLATES[0].key)
    expect((await snapshot([f])).notices).toHaveLength(1)
    await rejected('multirow forbidden key with allowed rename', [f], `update tasks set
      title=case when id=$1 then 'Synthetic attempted neighbour edit' else title end,
      system_template_key=case when id=$2 then $3 else system_template_key end
      where id=any($4::uuid[])`, [neighbour, target, TEMPLATES[1].key, [neighbour, target]])
  })
  it('an actual transaction rolls back one completed allowed edit and its notice change when a later key mutation fails', async () => {
    needKeyColumn(); const f = await fixture(), helper = await actor()
    await rawDb.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.weddingId, helper.userId])
    const custom = await create(f, { title: 'Synthetic rollback neighbour', period: '3', assigneeId: helper.userId, due: '2027-05-01' })
    expect(custom.statusCode, custom.body).toBe(201); const neighbour = custom.json().id as string, target = await keyed(f, TEMPLATES[0].key), before = await snapshot([f])
    expect(before.notices).toHaveLength(1); let firstRowCount: number | null = null, error: unknown = null
    try {
      await rawDb.tx(async client => {
        firstRowCount = (await client.query("update tasks set title='Synthetic attempted transaction edit' where id=$1", [neighbour])).rowCount
        expect(firstRowCount).toBe(1); expect(await snapshot([f], client)).not.toEqual(before)
        await client.query('update tasks set system_template_key=$2 where id=$1', [target, TEMPLATES[1].key])
      })
    } catch (caught) { error = caught }
    note({ test: 'transaction rollback after completed allowed edit', firstRowCount, ...errorFacts(error) })
    expect(errorFacts(error).code).toBe('23514'); expect(firstRowCount).toBe(1); expect(await snapshot([f])).toEqual(before)
  })

  async function observed(check: () => Promise<boolean>, settled: () => boolean, label: string) {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (await check()) return
      if (settled()) throw new Error(`Writer completed before ${label}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`No ${label} within eight seconds`)
  }
  it('two real sessions blocked by one wedding barrier return one identical six-key set', async () => {
    const f = await fixture(), other = await device(f.owner.userId)
    let first: Promise<Response> | undefined, second: Promise<Response> | undefined, firstSettled = false, secondSettled = false
    try {
      await rawDb.tx(async client => {
        const holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        await client.query('select id from weddings where id=$1 for update', [f.weddingId])
        first = get(f).then(response => { firstSettled = true; return response }, error => { firstSettled = true; throw error }); void first.catch(() => undefined)
        second = get(f, other.token).then(response => { secondSettled = true; return response }, error => { secondSettled = true; throw error }); void second.catch(() => undefined)
        await observed(async () => {
          await client.query('select pg_stat_clear_snapshot()')
          const waiting = (await client.query<WeddingWaiter>(`select pid,datname,application_name,state,wait_event_type,query,pg_blocking_pids(pid) as blockers from pg_stat_activity
            where datname=current_database() and application_name=$1 and state='active' and wait_event_type='Lock'`, [APPLICATION])).rows
          if (!weddingWaiterGraph(waiting, holderPid, new URL(connectionUrl).pathname.slice(1), APPLICATION)) return false
          note({ test: 'two-session HTTP key initialization', holderPid, waiting }); return true
        }, () => firstSettled || secondSettled, 'two actual first-open wedding-lock waiters')
      })
      const replies = await Promise.all([first!, second!])
      const a = await readSet(f, replies[0]!), b = await readSet(f, replies[1]!)
      expect(a).toEqual(b); await requireKeys(f)
    } finally { await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]) }
  })
  it.each(['commit', 'rollback'] as const)('real competing SQL writers await the first same-key writer; its %s determines the final winner', async release => {
    needKeyColumn(); const f = await fixture(), firstId = ownId('tasks'), secondId = ownId('tasks')
    const a = new pg.Client({ connectionString: connectionUrl, statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000 })
    const b = new pg.Client({ connectionString: connectionUrl, statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000 })
    let pending: Promise<{ ok: true; rowCount: number | null } | { ok: false; error: unknown }> | undefined, settled = false, aConnected = false, bConnected = false
    try {
      await a.connect(); aConnected = true; await b.connect(); bConnected = true; await identity(a); await identity(b)
      const holderPid = (await a.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const waitingPid = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await a.query('begin'); await b.query('begin')
      await keyed(f, TEMPLATES[0].key, 'Synthetic first SQL writer', a, firstId)
      pending = b.query("insert into tasks(id,wedding_id,title,source,kind,system_template_key) values($1,$2,'Synthetic second SQL writer','system','planb',$3)", [secondId, f.weddingId, TEMPLATES[0].key])
        .then(result => { settled = true; return { ok: true as const, rowCount: result.rowCount } }, error => { settled = true; return { ok: false as const, error } })
      await observed(async () => {
        await rawDb.query('select pg_stat_clear_snapshot()')
        const actual = (await rawDb.query<{ pid: number; query: string; wait_event: string; blockers: number[] }>(`select pid,query,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity
          where datname=current_database() and application_name=$1 and pid=$2 and wait_event_type='Lock' and $3=any(pg_blocking_pids(pid))`, [APPLICATION, waitingPid, holderPid])).rows
        if (!actual.length) return false
        expect(actual).toHaveLength(1); expect(actual[0]!.blockers).toContain(holderPid)
        note({ test: 'SQL unique concurrency ' + release, holderPid, waitingPid, actual: actual[0] }); return true
      }, () => settled, 'actual same-key PostgreSQL waiter with matching blocker PID')
      await a.query(release)
      const outcome = await pending
      if (release === 'commit') {
        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error('Competing key committed after the first writer committed')
        note({ test: 'SQL unique concurrency commit refusal', ...errorFacts(outcome.error) }); expect(errorFacts(outcome.error).code).toBe('23505'); await b.query('rollback')
      } else {
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) throw outcome.error
        expect(outcome.rowCount).toBe(1); await b.query('commit')
      }
      const actual = await rows(f)
      expect(actual).toHaveLength(1); expect(actual[0]).toMatchObject({ id: release === 'commit' ? firstId : secondId, key: TEMPLATES[0].key })
    } finally {
      // Release a held transaction before settling a blocked competing query.
      if (aConnected) await a.query('rollback').catch(() => undefined)
      if (pending) await pending
      if (bConnected) await b.query('rollback').catch(() => undefined)
      const closes = await Promise.allSettled([a.end(), b.end()])
      for (const close of closes) expect(close.status, 'Dedicated PostgreSQL client must close').toBe('fulfilled')
    }
  })

  it('real mid-initialization failure leaves no committed keys, then retry creates the complete immutable set', async () => {
    const f = await fixture(), before = await snapshot([f]); let attempts = 0, actualInserts = 0
    const previous = app.db!
    app.db = forwardingDb({
      before(sql, values) { if (/^\s*insert\s+into\s+tasks\b/i.test(sql) && values?.[1] === f.weddingId && ++attempts === 3) throw new Error('Synthetic keyed initializer interruption before third insert') },
      after(sql, values, result) { if (/^\s*insert\s+into\s+tasks\b/i.test(sql) && values?.[1] === f.weddingId) { expect(result.rowCount).toBe(1); actualInserts++ } },
    })
    let failed: Response
    try { failed = await get(f) } finally { app.db = previous }
    expect(failed!.statusCode, failed!.body).toBe(500); expect(attempts).toBe(3); expect(actualInserts).toBe(2)
    note({ test: 'mid-init real insert rollback', attempts, actualInserts }); expect(await snapshot([f])).toEqual(before)
    const retry = await readSet(f, await get(f)); await requireKeys(f)
    const stable = await snapshot([f]); expect(await readSet(f, await get(f))).toEqual(retry); expect(await snapshot([f])).toEqual(stable)
  })
})
