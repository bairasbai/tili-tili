import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { components } from '../src/contract/api.generated.js'

const DB = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'a'.repeat(48)
const personal = '/users/me/task-delegations'
type Contract = components['schemas']
type Actor = { id: string; token: string }

describe.skipIf(!DB)('FR008: поручения к отдельным задачам', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []

  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => {
    try {
      await app?.db?.query('delete from weddings where id=any($1::uuid[])', [weddings])
      await app?.db?.query('delete from users where id=any($1::uuid[])', [users])
    } finally { await app?.close() }
  })

  async function actor(name: string): Promise<Actor> {
    const id = randomUUID(), sid = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`, name])
    users.push(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }

  function call(actor: Actor, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
    return app.inject({ method, url, payload, headers: { authorization: `Bearer ${actor.token}` } })
  }

  async function fixture() {
    const [couple, teamHelper, first, second] = await Promise.all(['Пара', 'Команда', 'Первый', 'Второй'].map(actor))
    const id = randomUUID(), taskId = randomUUID(), otherId = randomUUID()
    await app.db!.query('insert into weddings(id,owner_id,title,invite_code) values($1,$2,$3,$4)', [id, couple.id, 'FR008 fixture', id])
    weddings.push(id)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper')",
      [id, couple.id, teamHelper.id])
    await app.db!.query(`insert into tasks(id,wedding_id,title,kind,source,period,due)
      values($1,$2,'Забрать декор','checklist','user','3','2030-06-12'),($3,$2,'Закрытая задача','checklist','user','3',null)`,
      [taskId, id, otherId])
    return { id, couple, teamHelper, first, second, taskId, otherId, board: `/weddings/${id}/task-delegations` }
  }

  async function issue(couple: Actor, board: string, taskId: string) {
    const response = await call(couple, 'POST', board, { taskId })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    return response.json<Contract['TaskDelegationInvitation']>()
  }
  const accept = (actor: Actor, code: string) => call(actor, 'POST', personal + '/accept', { code })
  async function list(actor: Actor) {
    const response = await call(actor, 'GET', personal)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    return response.json<Contract['DelegatedTask'][]>()
  }

  it('принимает код один раз и ограничивает доступ одной задачей', async () => {
    const { id, couple, teamHelper, first, second, taskId, otherId, board } = await fixture()
    expect((await app.inject({ method: 'GET', url: personal })).statusCode).toBe(401)
    expect((await call(teamHelper, 'GET', board)).statusCode).toBe(403)
    expect((await call(teamHelper, 'POST', board, { taskId })).statusCode).toBe(403)
    expect((await call(first, 'GET', board)).statusCode).toBe(404)
    const invitation = await issue(couple, board, taskId)
    expect((await call(couple, 'POST', board, { taskId })).statusCode).toBe(409)
    expect((await accept(couple, invitation.code)).statusCode).toBe(404)
    expect((await accept(teamHelper, invitation.code)).statusCode).toBe(409)
    const results = await Promise.all([accept(first, invitation.code), accept(second, invitation.code)])
    expect(results.map(reply => reply.statusCode).sort(), results.map(reply => reply.body).join('\n')).toEqual([204, 404])
    const [winner, loser] = results[0]!.statusCode === 204 ? [first, second] : [second, first]
    expect((await accept(winner, invitation.code)).statusCode).toBe(204)
    expect(await list(loser)).toEqual([])
    expect(await list(winner)).toEqual([{ id: invitation.id, title: 'Забрать декор', due: '2030-06-12', done: false, revision: '1', blocked: false }])
    for (const section of ['budget', 'tasks', 'guests']) expect((await call(winner, 'GET', `/weddings/${id}/${section}`)).statusCode).toBe(404)
    const completion = `${personal}/${invitation.id}/completion`
    expect((await call(loser, 'PUT', completion, { done: true, expectedRevision: '1' })).statusCode).toBe(404)
    expect((await call(winner, 'PUT', completion, { done: true, expectedRevision: '2' })).json().error.code).toBe('delegated_task_changed')
    expect((await call(winner, 'PUT', completion, { done: true, expectedRevision: '1' })).statusCode).toBe(204)
    expect((await call(winner, 'PUT', completion, { done: true, expectedRevision: '1' })).statusCode).toBe(204)
    expect(await list(winner)).toMatchObject([{ done: true, revision: '2' }])
    expect((await app.db!.query('select done_at from tasks where id=$1', [otherId])).rows[0].done_at).toBeNull()
    const audit = await app.db!.query("select action,diff from audit_log where entity_id=$1 and action like 'task_delegation.%' order by action", [taskId])
    expect(audit.rows).toEqual(['accepted','completed','issued'].map(action => ({ action: 'task_delegation.' + action, diff: { delegationId: invitation.id } })))
    const revoke = await call(couple, 'DELETE', board + '/' + invitation.id)
    expect(revoke.statusCode, revoke.body).toBe(204)
    expect(await list(winner)).toEqual([])
    expect((await call(winner, 'PUT', completion, { done: false, expectedRevision: '2' })).statusCode).toBe(404)
    expect((await accept(winner, invitation.code)).statusCode).toBe(404)
  })

  it('отзывает доступ при назначении другого исполнителя и замене истёкшей ссылки', async () => {
    const { couple, teamHelper, first, taskId, otherId, board } = await fixture()
    const invitation = await issue(couple, board, taskId)
    expect((await accept(first, invitation.code)).statusCode).toBe(204)
    await app.db!.query('update tasks set assignee_id=$2 where id=$1', [taskId, teamHelper.id])
    expect(await list(first)).toEqual([])
    expect((await accept(first, invitation.code)).statusCode).toBe(404)
    const expired = await issue(couple, board, otherId)
    await app.db!.query("update wedding_task_delegations set created_at=now()-interval '8 days',expires_at=now()-interval '1 day' where id=$1", [expired.id])
    expect((await accept(first, expired.code)).statusCode).toBe(404)
    const next = await issue(couple, board, otherId)
    expect(next.id).not.toBe(expired.id)
    expect((await accept(first, next.code)).statusCode).toBe(204)
    await app.db!.query('delete from tasks where id=$1', [otherId])
    expect((await accept(first, next.code)).statusCode).toBe(404)
  })

  it('проверяет условие задачи и отзывает доступ после её исключения', async () => {
    const { id, couple, first, board } = await fixture()
    await app.db!.query(`insert into tasks(id,wedding_id,title,kind,source,period,sort)
      values($1,$3,'Составить список гостей','checklist','system','9',2),
      ($2,$3,'Заказать приглашения','checklist','system','9',5)`, [randomUUID(), randomUUID(), id])
    const response = await call(couple, 'GET', `/weddings/${id}/tasks`)
    expect(response.statusCode, response.body).toBe(200)
    const tasks = response.json<Contract['Task'][]>()
    const prerequisite = tasks.find(task => task.title === 'Составить список гостей')!
    const dependent = tasks.find(task => task.title === 'Заказать приглашения')!
    const invitation = await issue(couple, board, dependent.id!)
    expect((await accept(first, invitation.code)).statusCode).toBe(204)
    const [task] = await list(first)
    expect(task).toMatchObject({ id: invitation.id, blocked: true })
    const completion = `${personal}/${invitation.id}/completion`
    const done = { done: true, expectedRevision: task!.revision }
    expect((await call(first, 'PUT', completion, done)).json().error.code).toBe('task_dependencies_pending')
    await app.db!.query('update tasks set done_at=now() where id=$1', [prerequisite.id])
    expect((await call(first, 'PUT', completion, done)).statusCode).toBe(204)
    await app.db!.query("update tasks set excluded_reason='Уже решено' where id=$1", [dependent.id])
    expect(await list(first)).toEqual([])
  })

  it('сериализует завершение с отзывом', async () => {
    const { couple, first, taskId, board } = await fixture()
    const invitation = await issue(couple, board, taskId)
    expect((await accept(first, invitation.code)).statusCode).toBe(204)
    const [write, revoke] = await Promise.all([
      call(first, 'PUT', `${personal}/${invitation.id}/completion`, { done: true, expectedRevision: '1' }),
      call(couple, 'DELETE', board + '/' + invitation.id),
    ])
    expect(revoke.statusCode, revoke.body).toBe(204)
    expect([204, 404]).toContain(write.statusCode)
    const { rows } = await app.db!.query("select action from audit_log where entity_id=$1 and action in ('task_delegation.completed','task_delegation.revoked') order by action", [taskId])
    expect(rows.map(row => row.action)).toEqual(write.statusCode === 204
      ? ['task_delegation.completed', 'task_delegation.revoked'] : ['task_delegation.revoked'])
    const { rows: [task] } = await app.db!.query('select done_at is not null as done from tasks where id=$1', [taskId])
    expect(task.done).toBe(write.statusCode === 204)
    expect(await list(first)).toEqual([])
  })
})
