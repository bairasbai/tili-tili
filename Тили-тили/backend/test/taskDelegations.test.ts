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

  function call(actor: Actor, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) {
    return app.inject({ method, url, payload, headers: { authorization: `Bearer ${actor.token}` } })
  }

  async function fixture(title = 'FR008 fixture') {
    const [couple, teamHelper, first, second] = await Promise.all(['Пара', 'Команда', 'Первый', 'Второй'].map(actor))
    const id = randomUUID(), taskId = randomUUID(), otherId = randomUUID()
    await app.db!.query('insert into weddings(id,owner_id,title,invite_code) values($1,$2,$3,$4)', [id, couple.id, title, id])
    weddings.push(id)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper')",
      [id, couple.id, teamHelper.id])
    await app.db!.query(`insert into tasks(id,wedding_id,title,kind,source,period,due)
      values($1,$2,'Забрать декор','checklist','user','3','2030-06-12'),($3,$2,'Закрытая задача','checklist','user','3',null)`,
      [taskId, id, otherId])
    return { id, couple, teamHelper, first, second, taskId, otherId, board: `/weddings/${id}/task-delegations` }
  }

  async function issue(couple: Actor, board: string, taskId: string, targetUserId?: string) {
    const response = await call(couple, 'POST', board, { taskId, ...(targetUserId ? { targetUserId } : {}) })
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
    expect(await list(winner)).toEqual([{ id: invitation.id, weddingId: id, weddingTitle: 'FR008 fixture', title: 'Забрать декор', due: '2030-06-12', done: false, revision: '1', blocked: false }])
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

  async function addCoordinator(weddingId: string, coordinator: Actor) {
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'coordinator')", [weddingId, coordinator.id])
  }

  async function newTask(weddingId: string, title: string) {
    const id = randomUUID()
    await app.db!.query("insert into tasks(id,wedding_id,title,kind,source,period) values($1,$2,$3,'checklist','user','3')", [id, weddingId, title])
    return id
  }

  const employeeRemoval = (board: string, recipientId: string, delegationId: string) =>
    `${board}/recipients/${recipientId}?delegationId=${delegationId}`

  it('FR-052 confines staff grants and termination to the wedding and preserves completed duties', async () => {
    const a = await fixture('Первая свадьба'), b = await fixture('Вторая свадьба')
    const organizer = await actor('Организатор')
    const employee = a.first
    await addCoordinator(a.id, organizer)
    expect((await call(organizer, 'GET', b.board)).statusCode).toBe(404)
    await addCoordinator(b.id, organizer)
    const memberships = await call(organizer, 'GET', '/weddings')
    expect(memberships.statusCode, memberships.body).toBe(200)
    expect(memberships.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: a.id, role: 'coordinator' }), expect.objectContaining({ id: b.id, role: 'coordinator' }),
    ]))

    const familyTask = await newTask(a.id, 'Поручение пары')
    const family = await issue(a.couple, a.board, familyTask)
    expect((await accept(employee, family.code)).statusCode).toBe(204)
    const coordBoard = await call(organizer, 'GET', a.board)
    expect(coordBoard.statusCode, coordBoard.body).toBe(200)
    expect(coordBoard.json()).toMatchObject({ weddingTitle: 'Первая свадьба', requiresEmployeeCode: true, items: [] })
    expect(coordBoard.json().tasks).not.toContainEqual(expect.objectContaining({ id: familyTask }))
    expect((await call(organizer, 'DELETE', a.board + '/' + family.id)).statusCode).toBe(404)

    expect((await call(organizer, 'POST', a.board, { taskId: a.taskId })).statusCode).toBe(422)
    expect((await call(organizer, 'POST', a.board, { taskId: b.taskId, targetUserId: employee.id })).statusCode).toBe(404)
    await app.db!.query('update tasks set assignee_id=$2 where id=$1', [a.otherId, a.teamHelper.id])
    const alreadyAssigned = await call(organizer, 'POST', a.board, { taskId: a.otherId, targetUserId: employee.id })
    expect(alreadyAssigned.statusCode, alreadyAssigned.body).toBe(409)
    expect(alreadyAssigned.json().error.code).toBe('delegation_task_assigned')
    await app.db!.query('update tasks set assignee_id=null where id=$1', [a.otherId])

    const done = await issue(organizer, a.board, a.taskId, employee.id)
    const open = await issue(organizer, a.board, a.otherId, employee.id)
    const pendingId = await newTask(a.id, 'Получить смету по декору')
    const pending = await issue(organizer, a.board, pendingId, employee.id)
    const elsewhere = await issue(organizer, b.board, b.taskId, employee.id)
    expect((await accept(a.second, pending.code)).statusCode).toBe(404)
    expect((await accept(employee, done.code)).statusCode).toBe(204)
    expect((await accept(employee, open.code)).statusCode).toBe(204)
    expect((await accept(employee, elsewhere.code)).statusCode).toBe(204)
    for (const section of ['budget', 'guests', 'tasks']) {
      expect((await call(employee, 'GET', `/weddings/${a.id}/${section}`)).statusCode).toBe(404)
    }
    const before = await list(employee)
    expect(before.find(item => item.id === elsewhere.id)).toMatchObject({ weddingId: b.id, weddingTitle: 'Вторая свадьба' })
    expect((await call(employee, 'PUT', `${personal}/${done.id}/completion`, { done: true, expectedRevision: '1' })).statusCode).toBe(204)

    expect((await call(organizer, 'DELETE', employeeRemoval(a.board, employee.id, family.id))).statusCode).toBe(404)
    expect((await call(organizer, 'DELETE', employeeRemoval(a.board, a.second.id, open.id))).statusCode).toBe(404)
    const offboardUrl = employeeRemoval(a.board, employee.id, open.id)
    const retire = await call(organizer, 'DELETE', offboardUrl)
    expect(retire.statusCode, retire.body).toBe(204)
    expect((await list(employee)).map(item => item.id).sort()).toEqual([family.id, elsewhere.id].sort())
    expect((await accept(employee, pending.code)).statusCode).toBe(404)
    expect((await call(employee, 'PUT', `${personal}/${done.id}/completion`, { done: false, expectedRevision: '2' })).statusCode).toBe(404)
    const boardAfter = await call(organizer, 'GET', a.board)
    expect(boardAfter.json().tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: a.taskId, needsReassignment: false }),
      expect.objectContaining({ id: a.otherId, needsReassignment: true }),
      expect.objectContaining({ id: pendingId, needsReassignment: true }),
    ]))
    expect((await app.db!.query('select done_at is not null as done from tasks where id=$1', [a.taskId])).rows[0].done).toBe(true)
    const auditRows = await app.db!.query("select diff->>'delegationId' as id from audit_log where actor_id=$1 and action='task_delegation.employee_removed'", [organizer.id])
    expect(auditRows.rows.map(row => row.id).sort()).toEqual([done.id, open.id, pending.id].sort())
    const replacement = await issue(organizer, a.board, a.otherId, employee.id)
    expect((await call(organizer, 'DELETE', offboardUrl)).statusCode).toBe(204)
    expect((await accept(employee, replacement.code)).statusCode).toBe(204)
  })

  it('FR-052 staff can leave one wedding and an old retry does not cancel a new invitation', async () => {
    const a = await fixture('Первая свадьба'), b = await fixture('Вторая свадьба')
    const organizer = await actor('Организатор')
    await addCoordinator(a.id, organizer)
    await addCoordinator(b.id, organizer)
    const own = await issue(organizer, a.board, a.taskId, a.first.id)
    const pending = await issue(organizer, a.board, a.otherId, a.first.id)
    const other = await issue(organizer, b.board, b.taskId, a.first.id)
    expect((await accept(a.first, own.code)).statusCode).toBe(204)
    expect((await accept(a.first, other.code)).statusCode).toBe(204)
    const exit = `${personal}/${own.id}/wedding`
    expect((await call(a.second, 'DELETE', exit)).statusCode).toBe(404)
    const race = await Promise.all([call(a.first, 'DELETE', exit), accept(a.first, pending.code)])
    expect(race[0]!.statusCode, race[0]!.body).toBe(204)
    expect([204, 404]).toContain(race[1]!.statusCode)
    expect((await list(a.first)).map(task => task.id)).toEqual([other.id])
    expect((await accept(a.first, pending.code)).statusCode).toBe(404)
    const reissued = await issue(organizer, a.board, a.taskId, a.first.id)
    expect((await call(a.first, 'DELETE', exit)).statusCode).toBe(204)
    expect((await accept(a.first, reissued.code)).statusCode).toBe(204)
  })

  it('FR-052 removal and role change retire organizer invitations without touching another wedding', async () => {
    const a = await fixture(), b = await fixture()
    const organizer = await actor('Организатор')
    await addCoordinator(a.id, organizer)
    await addCoordinator(b.id, organizer)
    const active = await issue(organizer, a.board, a.taskId, a.first.id)
    const pending = await issue(organizer, a.board, a.otherId, a.first.id)
    const other = await issue(organizer, b.board, b.taskId, a.first.id)
    expect((await accept(a.first, active.code)).statusCode).toBe(204)
    const memberPath = `/weddings/${a.id}/members/${organizer.id}`
    const [downgrade, redemption] = await Promise.all([
      call(a.couple, 'PATCH', memberPath, { role: 'helper' }), accept(a.first, pending.code),
    ])
    expect(downgrade.statusCode, downgrade.body).toBe(200)
    expect([204, 404]).toContain(redemption.statusCode)
    expect(await list(a.first)).toEqual([])
    expect((await accept(a.first, pending.code)).statusCode).toBe(404)
    expect((await call(organizer, 'GET', a.board)).statusCode).toBe(403)
    expect((await accept(a.first, other.code)).statusCode).toBe(204)

    const restore = await call(a.couple, 'PATCH', memberPath, { role: 'coordinator' })
    expect(restore.statusCode, restore.body).toBe(200)
    expect((await accept(a.first, active.code)).statusCode).toBe(404)
    const next = await issue(organizer, a.board, a.taskId, a.first.id)
    const deletion = await call(a.couple, 'DELETE', memberPath)
    expect(deletion.statusCode, deletion.body).toBe(204)
    expect((await accept(a.first, next.code)).statusCode).toBe(404)
    expect((await list(a.first)).map(task => task.id)).toEqual([other.id])
    const audit = await app.db!.query("select diff->>'delegationId' as id from audit_log where action='task_delegation.access_ended' and entity_id=any($1::uuid[])",
      [[a.taskId, a.otherId]])
    expect(audit.rows.map(row => row.id).sort()).toEqual([active.id, pending.id, next.id].sort())
  })
})
