import assert from 'node:assert/strict'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { components } from '../src/contract/api.generated.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02', SECRET = randomBytes(48).toString('hex')
type Task = components['schemas']['Task']

describe.skipIf(!DB)('FR005 actual task dependencies and PostgreSQL guards', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_task_dependencies_20261006_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: randomBytes(48).toString('hex'), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address))
    assert.equal(live.port, Number(disposablePgPort())); assert.equal(live.name, target.pathname.slice(1))
  })
  afterAll(async () => {
    if (!app) return
    try {
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function actor() {
    const id = randomUUID(), sid = randomUUID(); users.push(id)
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [id, '+79' + randomInt(100_000_000, 999_999_999), 'Synthetic task participant'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, sid, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid })}` } }
  }
  async function fixture() {
    const owner = await actor(), helper = await actor(), coordinator = await actor(), wid = randomUUID(); weddings.push(wid)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Prerequisites','2027-06-14','Europe/Moscow',$3)", [wid, owner.id, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper'),($1,$4,'coordinator')", [wid, owner.id, helper.id, coordinator.id])
    const f = { wid, owner, helper, coordinator, path: `/weddings/${wid}/tasks` }
    const a = await create(f, 'Guest answers'), b = await create(f, 'Final menu'), c = await create(f, 'Catering order')
    return { ...f, a, b, c }
  }
  type Base = { wid: string; owner: Awaited<ReturnType<typeof actor>>; path: string }
  async function create(f: Base, title: string, extra: object = {}) {
    const r = await app.inject({ method: 'POST', url: f.path, headers: f.owner.headers, payload: { title, period: '1', ...extra } })
    expect(r.statusCode, r.body).toBe(201); return r.json<Task>()
  }
  async function patch(f: Base, task: Task, body: object, user = f.owner) {
    return app.inject({ method: 'PATCH', url: `${f.path}/${task.id}`, headers: user.headers, payload: body })
  }
  async function read(f: Base) {
    const r = await app.inject({ url: f.path, headers: f.owner.headers }); expect(r.statusCode, r.body).toBe(200)
    return r.json<Task[]>()
  }
  async function link(f: Base, task: Task, ids: string[]) {
    const r = await patch(f, task, { dependsOn: ids, dependencyVersion: task.dependencyVersion })
    expect(r.statusCode, r.body).toBe(200); return r.json<Task>()
  }
  async function audit(task: Task) {
    return (await app.db!.query("select actor_id,diff from audit_log where entity_id=$1 and action='task.dependencies.overridden' order by id", [task.id])).rows
  }
  const decision = (task: Task, reason = 'Menu approved using the confirmed headcount') => ({ done: true, dependencyVersion: task.dependencyVersion,
    dependencyOverride: { reason, prerequisiteIds: task.dependencies!.filter(d => !d.done).map(d => d.id) } })

  it('starts historical-compatible ordinary tasks with no prerequisites or override', async () => {
    const f = await fixture(); expect(f.a).toMatchObject({ dependencies: [], dependencyVersion: '0', dependencyOverride: null })
    expect((await patch(f, f.a, { done: true }, f.helper)).statusCode).toBe(200)
  })
  it('creates and reloads explicit prerequisites without inferring any from titles', async () => {
    const f = await fixture(), task = await create(f, 'New step', { dependsOn: [f.a.id, f.b.id] })
    expect(task.dependencies!.map(d => d.id).sort()).toEqual([f.a.id, f.b.id].sort())
    expect((await read(f)).find(t => t.id === task.id)).toEqual(task)
  })
  it.each(['helper', 'coordinator'] as const)('%s may edit a normal task but cannot set dependencies or override them', async role => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!]), actor = f[role]
    expect((await patch(f, f.a, { title: 'Updated ordinary task' }, actor)).statusCode).toBe(200)
    expect((await patch(f, f.c, { dependsOn: [f.a.id], dependencyVersion: '0' }, actor)).statusCode).toBe(403)
    expect((await patch(f, task, decision(task), actor)).statusCode).toBe(403)
    expect(await audit(task)).toEqual([])
  })
  it('rejects prerequisites from another wedding without linking them', async () => {
    const f = await fixture(), other = await fixture()
    expect((await patch(f, f.b, { dependsOn: [other.a.id], dependencyVersion: '0' })).statusCode).toBe(422)
    expect((await read(f)).find(t => t.id === f.b.id)!.dependencies).toEqual([])
  })
  it('rejects missing and non-checklist prerequisites', async () => {
    const f = await fixture()
    expect((await patch(f, f.b, { dependsOn: [randomUUID()], dependencyVersion: '0' })).statusCode).toBe(422)
    await app.db!.query("update tasks set kind='planb' where id=$1", [f.a.id])
    expect((await patch(f, f.b, { dependsOn: [f.a.id], dependencyVersion: '0' })).statusCode).toBe(422)
  })
  it('rejects self-reference and case-insensitive duplicate identities', async () => {
    const f = await fixture()
    for (const ids of [[f.a.id], [f.b.id, f.b.id!.toUpperCase()]]) {
      expect((await patch(f, f.a, { dependsOn: ids, dependencyVersion: '0' })).statusCode).toBe(422)
    }
  })
  it('rejects an indirect cycle and rolls back its attempted replacement', async () => {
    const f = await fixture(); await link(f, f.b, [f.a.id!]); await link(f, f.c, [f.b.id!])
    const r = await patch(f, f.a, { dependsOn: [f.c.id], dependencyVersion: '0' })
    expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe('task_dependency_cycle')
    expect((await read(f)).find(t => t.id === f.a.id)).toMatchObject({ dependencies: [], dependencyVersion: '0' })
  })
  it('uses a versioned replacement and treats an unchanged set as a no-op', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!])
    expect((await link(f, task, [f.a.id!])).dependencyVersion).toBe(task.dependencyVersion)
    expect((await patch(f, task, { dependsOn: [], dependencyVersion: '0' })).statusCode).toBe(409)
    expect((await patch(f, task, { dependsOn: [] })).statusCode).toBe(422)
    expect((await link(f, task, [])).dependencies).toEqual([])
  })
  it('blocks completion until prerequisites really complete', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!])
    const r = await patch(f, task, { done: true }); expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('task_dependencies_pending')
    expect((await read(f)).find(t => t.id === task.id)!.done).toBe(false)
    expect((await patch(f, f.a, { done: true })).statusCode).toBe(200)
    expect((await patch(f, task, { done: true }, f.helper)).statusCode).toBe(200)
    expect(await audit(task)).toEqual([])
  })
  it('records one explicit manual decision atomically and keeps it on reload', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!, f.c.id!]), body = decision(task)
    const r = await patch(f, task, body); expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ done: true, dependencyOverride: { reason: body.dependencyOverride.reason } })
    expect((await patch(f, task, body)).statusCode).toBe(200)
    const rows = await audit(task); expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_id: f.owner.id, diff: { reason: body.dependencyOverride.reason, weddingId: f.wid } })
    expect(rows[0]!.diff.prerequisiteIds.sort()).toEqual([f.a.id, f.c.id].sort())
    expect((await read(f)).find(t => t.id === task.id)!.dependencyOverride).toEqual(r.json().dependencyOverride)
  })
  it('rejects a blank manual reason and does not complete the task', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!])
    expect((await patch(f, task, decision(task, '  '))).statusCode).toBe(422)
    expect(await audit(task)).toEqual([])
  })
  it('requires the current dependency version for an override', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!])
    const r = await patch(f, task, { ...decision(task), dependencyVersion: '0' })
    expect(r.statusCode, r.body).toBe(409); expect(await audit(task)).toEqual([])
  })
  it('requires the exact currently unfinished set, not an old blocker list', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!, f.c.id!])
    expect((await patch(f, f.a, { done: true })).statusCode).toBe(200)
    expect((await patch(f, task, decision(task))).statusCode).toBe(409)
    expect(await audit(task)).toEqual([])
  })
  it('does not combine graph replacement or reopening with a manual completion decision', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!])
    expect((await patch(f, task, { ...decision(task), dependsOn: [] })).statusCode).toBe(422)
    expect((await patch(f, task, { ...decision(task), done: false })).statusCode).toBe(422)
  })
  it('hides the current override after reopen but retains its immutable audit record', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!]); expect((await patch(f, task, decision(task))).statusCode).toBe(200)
    const r = await patch(f, task, { done: false }); expect(r.statusCode, r.body).toBe(200)
    expect(r.json().dependencyOverride).toBeNull(); expect(await audit(task)).toHaveLength(1)
    expect((await patch(f, task, { done: true })).statusCode).toBe(409)
  })
  it('does not silently reopen completed dependents when a prerequisite reopens', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!])
    await patch(f, f.a, { done: true }); await patch(f, task, { done: true }); await patch(f, f.a, { done: false })
    expect((await read(f)).find(t => t.id === task.id)).toMatchObject({ done: true, dependencies: [{ done: false }] })
  })
  it('allows removing links from a completed task but refuses new ones', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!]); await patch(f, task, decision(task))
    expect((await patch(f, task, { dependsOn: [f.c.id], dependencyVersion: task.dependencyVersion })).statusCode).toBe(409)
    expect((await read(f)).find(t => t.id === task.id)!.dependencies!.map(d => d.id)).toEqual([f.a.id])
    expect((await link(f, task, [])).dependencies).toEqual([])
  })
  it('protects completion at the database layer as well as the HTTP route', async () => {
    const f = await fixture(), task = await link(f, f.b, [f.a.id!])
    await expect(app.db!.query('update tasks set done_at=now() where id=$1', [task.id])).rejects.toMatchObject({ code: '23514', constraint: 'task_dependencies_pending' })
  })
  it('protects graph cycles and linked task kinds in SQL', async () => {
    const f = await fixture(); await link(f, f.b, [f.a.id!])
    await expect(app.db!.query('insert into task_dependencies(wedding_id,task_id,prerequisite_id) values($1,$2,$3)', [f.wid, f.a.id, f.b.id])).rejects.toMatchObject({ code: '23514', constraint: 'task_dependency_cycle' })
    await expect(app.db!.query("update tasks set kind='planb' where id=$1", [f.a.id])).rejects.toMatchObject({ code: '23514', constraint: 'task_dependency_scope' })
  })
  it('rejects direct SQL cross-wedding links', async () => {
    const f = await fixture(), other = await fixture()
    await expect(app.db!.query('insert into task_dependencies(wedding_id,task_id,prerequisite_id) values($1,$2,$3)', [f.wid, f.b.id, other.a.id])).rejects.toMatchObject({ code: '23514' })
  })
  it('prevents ordinary prerequisite deletion but allows the wedding cascade', async () => {
    const f = await fixture(); await link(f, f.b, [f.a.id!])
    const r = await app.inject({ method: 'DELETE', url: `${f.path}/${f.a.id}`, headers: f.owner.headers })
    expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe('task_dependency_in_use')
    await app.db!.query('delete from weddings where id=$1', [f.wid])
    expect((await app.db!.query('select 1 from task_dependencies where wedding_id=$1', [f.wid])).rowCount).toBe(0)
  })
  it('serializes concurrent opposite links so only one can succeed', async () => {
    const f = await fixture()
    const responses = await Promise.all([patch(f, f.a, { dependsOn: [f.b.id], dependencyVersion: '0' }), patch(f, f.b, { dependsOn: [f.a.id], dependencyVersion: '0' })])
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409])
    expect((await app.db!.query('select 1 from task_dependencies where wedding_id=$1', [f.wid])).rowCount).toBe(1)
  })
  it('rejects one of two concurrent replacements based on the same old version', async () => {
    const f = await fixture()
    const responses = await Promise.all([patch(f, f.a, { dependsOn: [f.b.id], dependencyVersion: '0' }), patch(f, f.a, { dependsOn: [f.c.id], dependencyVersion: '0' })])
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409])
  })
  it.each(['role', 'session'] as const)('rechecks current %s after a real wedding lock wait', async kind => {
    const f = await fixture(), blocker = new pg.Client({ connectionString: DB!, application_name: 'fr005_owned_blocker' })
    await blocker.connect(); await blocker.query('begin')
    try {
      const pid = (await blocker.query('select pg_backend_pid() as id')).rows[0].id as number
      await blocker.query('select id from weddings where id=$1 for update', [f.wid])
      const pending = patch(f, f.b, { dependsOn: [f.a.id], dependencyVersion: '0' })
      let witnessed = false
      for (let i = 0; i < 100; i++) {
        if ((await blocker.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount) { witnessed = true; break }
        await delay(20)
      }
      expect(witnessed, 'The actual request must wait on the owned PostgreSQL lock').toBe(true)
      if (kind === 'role') await blocker.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.wid, f.owner.id])
      else await blocker.query('update sessions set revoked_at=now() where id=$1', [f.owner.sid])
      await blocker.query('commit')
      const r = await pending; expect(r.statusCode, r.body).toBe(kind === 'role' ? 403 : 401)
      expect((await app.db!.query('select 1 from task_dependencies where wedding_id=$1', [f.wid])).rowCount).toBe(0)
    } finally { await blocker.query('rollback').catch(() => undefined); await blocker.end() }
  })
})
