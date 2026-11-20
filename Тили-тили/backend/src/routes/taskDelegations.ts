import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { ref } from '../contract/schemas.generated.js'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { lockOrderPrincipal, lockOrderWedding } from '../orders/context.js'
import type { Queryable } from '../plugins/db.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'
import { loadTaskBlockers, type ChecklistTaskIdentity } from '../wedding/checklist-dependencies.js'

type Contract = components['schemas']
type GrantScope = { id: string; wedding_id: string; task_id: string }
type DelegationParams = { delegationId: string }
type RecipientParams = { recipientId: string }
type RetirementAction = 'task_delegation.employee_removed' | 'task_delegation.employee_left'
type DelegatedRow = GrantScope & ChecklistTaskIdentity & { delegation_id: string; title: string; due: string | null; revision: string }
type DelegatedListRow = DelegatedRow & { wedding_title: string }

const delegationParams = { type: 'object', required: ['delegationId'], properties: { delegationId: UUID_ID } } as const
const recipientParams = { type: 'object', required: ['recipientId'], properties: { recipientId: UUID_ID } } as const
const retirementQuery = { type: 'object', required: ['delegationId'], properties: { delegationId: UUID_ID } } as const
const recipientColumns = `g.id as delegation_id,t.id,t.wedding_id,t.id as task_id,t.title,t.due::text,t.revision::text,
  t.kind,t.source,t.period,t.sort,t.excluded_reason,t.done_at`
const eligible = "t.kind='checklist' and t.excluded_reason is null"
const liveIssuer = `exists (select from wedding_members m join users u on u.id=m.user_id
  where m.wedding_id=g.wedding_id and m.user_id=g.issued_by and u.deleted_at is null
    and (m.role='couple' or (g.issued_as='coordinator' and m.role='coordinator')))`
const missing = () => notFound('Поручение не найдено или больше недоступно')
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

async function lockTask(client: Queryable, weddingId: string, taskId: string) {
  const { rows: [task] } = await client.query<{ assignee_id: string | null }>(`select t.assignee_id from tasks t
    where t.wedding_id=$1 and t.id=$2 and ${eligible} for update`, [weddingId, taskId])
  if (!task) throw missing()
  return task
}

async function lockRecipient(client: Queryable, request: FastifyRequest, grant: GrantScope) {
  await lockOrderWedding(client, grant.wedding_id)
  await lockOrderPrincipal(client, { ...request.caller!, policyVersion: request.server.appConfig.policyVersion })
  await lockTask(client, grant.wedding_id, grant.task_id)
  await assertSeatingToken(request)
}

async function audit(client: Queryable, actor: string, action: string, grant: GrantScope) {
  await client.query(`insert into audit_log(actor_id,action,entity,entity_id,diff)
    values($1,$2,'task',$3,jsonb_build_object('delegationId',$4::uuid))`, [actor, action, grant.task_id, grant.id])
}

async function canRetireRecipient(client: Queryable, anchor: GrantScope & { revoked_at: Date | null }, actor: string, action: RetirementAction) {
  if (!anchor.revoked_at) return true
  const previous = await client.query(`select from audit_log where entity='task' and entity_id=$1
    and actor_id=$2 and action=$3 and diff->>'delegationId'=$4`, [anchor.task_id, actor, action, anchor.id])
  if (previous.rowCount) return false
  throw conflict('delegation_group_changed', 'Поручения изменились. Обновите список')
}

async function retireRecipient(client: Queryable, weddingId: string, recipientId: string, actor: string,
  action: RetirementAction, coordinatorOnly = false) {
  await client.query(`with locked as (
      select id from wedding_task_delegations
      where wedding_id=$1 and (target_user_id=$2 or accepted_by=$2) and revoked_at is null
        and (not $5::boolean or issued_as='coordinator')
      order by id for update
    ), retired as (
      update wedding_task_delegations g set revoked_at=statement_timestamp() from locked
      where g.id=locked.id returning g.id,g.task_id
    ) insert into audit_log(actor_id,action,entity,entity_id,diff)
      select $3,$4,'task',task_id,jsonb_build_object('delegationId',id) from retired`,
  [weddingId, recipientId, actor, action, coordinatorOnly])
}

function recipientView(row: DelegatedListRow, blocked: boolean): Contract['DelegatedTask'] {
  return { id: row.delegation_id, weddingId: row.wedding_id, weddingTitle: row.wedding_title, title: row.title, due: row.due,
    done: row.done_at !== null, revision: row.revision, blocked }
}

export async function taskDelegationRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.get('/weddings/:weddingId/task-delegations', async (request, reply): Promise<Contract['TaskDelegationBoard']> => {
    reply.header('Cache-Control', 'no-store')
    return db().tx(async client => {
      const role = await lockGuestReadAccess(client, request)
      const { weddingId } = request.member!
      const { rows: [wedding] } = await client.query<{ title: string; read_only: boolean }>('select title,cancelled_at is not null as read_only from weddings where id=$1', [weddingId])
      const { rows: tasks } = await client.query<{ id: string; title: string; needsReassignment: boolean }>(
        `select t.id,t.title,(t.done_at is null and t.assignee_id is null and exists (
            select from wedding_task_delegations g where g.wedding_id=t.wedding_id and g.task_id=t.id
              and (g.accepted_at is not null or g.issued_as='coordinator' or g.target_user_id is not null)
              and g.revoked_at is not null and ($2='couple' or g.issued_as='coordinator'))) as "needsReassignment"
          from tasks t where t.wedding_id=$1 and ${eligible} and ($2='couple' or (t.assignee_id is null and not exists (
            select from wedding_task_delegations g where g.wedding_id=t.wedding_id and g.task_id=t.id
              and g.revoked_at is null and (g.accepted_at is not null or g.expires_at>now()))))
          order by t.sort,t.id`, [weddingId, role])
      const { rows } = await client.query<{ id: string; taskId: string; taskTitle: string; expires_at: Date
        accepted_at: Date | null; recipientName: string | null; employeeId: string | null }>(
        `select g.id,g.task_id as "taskId",t.title as "taskTitle",g.expires_at,g.accepted_at,u.name as "recipientName",
            u.id as "employeeId"
          from wedding_task_delegations g join tasks t on t.wedding_id=g.wedding_id and t.id=g.task_id
          left join users u on u.id=coalesce(g.accepted_by,g.target_user_id) and u.deleted_at is null
          where g.wedding_id=$1 and g.revoked_at is null and ${eligible} and ${liveIssuer}
            and ($2='couple' or g.issued_as='coordinator')
            and (g.accepted_at is not null or g.expires_at>now()) order by g.created_at desc,g.id desc`, [weddingId, role])
      await assertSeatingToken(request)
      return { readOnly: wedding!.read_only, weddingTitle: wedding!.title, requiresEmployeeCode: role === 'coordinator', tasks, items: rows.map(row => ({
        id: row.id, taskId: row.taskId, taskTitle: row.taskTitle, recipientName: row.recipientName, employeeId: row.employeeId,
        expiresAt: row.expires_at.toISOString(), accepted: row.accepted_at !== null,
      })) }
    })
  })

  app.post<{ Body: Contract['TaskDelegationCreate'] }>('/weddings/:weddingId/task-delegations', {
    schema: { body: ref('TaskDelegationCreate') },
  }, async (request, reply) => {
    const { taskId, targetUserId } = request.body
    const actor = request.caller!.userId, weddingId = request.member!.weddingId
    const code = randomBytes(24).toString('base64url'), id = uuidv7()
    const result = await db().tx(async client => {
      const role = await lockSeatingAccess(client, request)
      if (role === 'coordinator' && !targetUserId) throw validationFailed({ targetUserId: 'Укажите код сотрудника' })
      if (targetUserId) {
        const target = await client.query('select id from users where id=$1 and deleted_at is null for share', [targetUserId])
        if (!target.rowCount) throw notFound('Сотрудник не найден')
        const member = await client.query('select from wedding_members where wedding_id=$1 and user_id=$2', [weddingId, targetUserId])
        if (member.rowCount) throw conflict('delegation_already_member', 'У сотрудника уже есть доступ к этой свадьбе как у участника команды')
      }
      const task = await lockTask(client, weddingId, taskId)
      if (role === 'coordinator' && task.assignee_id) throw conflict('delegation_task_assigned', 'У задачи уже есть ответственный')
      await client.query(`update wedding_task_delegations set revoked_at=now()
        where wedding_id=$1 and task_id=$2 and revoked_at is null and accepted_at is null and expires_at<=statement_timestamp()`, [weddingId, taskId])
      const { rows: [grant] } = await client.query<{ expires_at: Date }>(
        `insert into wedding_task_delegations(id,wedding_id,task_id,issued_by,code_hash,expires_at,issued_as,target_user_id)
         values($1,$2,$3,$4,$5,statement_timestamp()+interval '7 days',$6,$7)
         on conflict(wedding_id,task_id) where revoked_at is null do nothing returning expires_at`,
        [id, weddingId, taskId, actor, hashCode(code), role, targetUserId ?? null])
      if (!grant) throw conflict('delegation_exists', 'У задачи уже есть действующее поручение')
      await audit(client, actor, 'task_delegation.issued', { id, wedding_id: weddingId, task_id: taskId })
      await assertSeatingToken(request)
      return { id, code, expiresAt: grant.expires_at.toISOString() } satisfies Contract['TaskDelegationInvitation']
    })
    return reply.code(201).header('Cache-Control', 'no-store').send(result)
  })

  app.delete<{ Params: DelegationParams }>('/weddings/:weddingId/task-delegations/:delegationId', {
    schema: { params: delegationParams },
  }, async (request, reply) => {
    const { weddingId } = request.member!
    await db().tx(async client => {
      const role = await lockSeatingAccess(client, request)
      const { rows: [grant] } = await client.query<GrantScope & { revoked_at: Date | null }>(
        `select id,wedding_id,task_id,revoked_at from wedding_task_delegations
          where wedding_id=$1 and id=$2 and ($3='couple' or issued_as='coordinator')`,
        [weddingId, request.params.delegationId, role])
      if (!grant) throw missing()
      if (grant.revoked_at) return
      await lockTask(client, weddingId, grant.task_id)
      const updated = await client.query('update wedding_task_delegations set revoked_at=now() where id=$1 and revoked_at is null', [grant.id])
      if (updated.rowCount) await audit(client, request.caller!.userId, 'task_delegation.revoked', grant)
      await assertSeatingToken(request)
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: RecipientParams; Querystring: DelegationParams }>('/weddings/:weddingId/task-delegations/recipients/:recipientId', {
    schema: { params: recipientParams, querystring: retirementQuery },
  }, async (request, reply) => {
    await db().tx(async client => {
      const role = await lockSeatingAccess(client, request)
      const { weddingId } = request.member!, actor = request.caller!.userId
      const { recipientId } = request.params, { delegationId } = request.query
      const { rows: [anchor] } = await client.query<GrantScope & { revoked_at: Date | null }>(
        `select id,wedding_id,task_id,revoked_at from wedding_task_delegations
          where wedding_id=$1 and id=$2 and (target_user_id=$3 or accepted_by=$3) and ($4='couple' or issued_as='coordinator')
          for update`, [weddingId, delegationId, recipientId, role])
      if (!anchor) throw missing()
      const action = 'task_delegation.employee_removed'
      if (await canRetireRecipient(client, anchor, actor, action)) {
        await retireRecipient(client, weddingId, recipientId, actor, action, role === 'coordinator')
      }
      await assertSeatingToken(request)
    })
    return reply.code(204).header('Cache-Control', 'no-store').send()
  })

  app.post<{ Body: Contract['TaskDelegationAccept'] }>('/users/me/task-delegations/accept', {
    preHandler: app.requireConsent, schema: { body: ref('TaskDelegationAccept') },
  }, async (request, reply) => {
    const codeHash = hashCode(request.body.code), actor = request.caller!.userId
    await db().tx(async client => {
      const { rows: [grant] } = await client.query<GrantScope>(
        'select id,wedding_id,task_id from wedding_task_delegations where code_hash=$1 and revoked_at is null', [codeHash])
      if (!grant) throw missing()
      await lockRecipient(client, request, grant)
      const { rows: [current] } = await client.query<{ accepted_by: string | null; accepted_at: Date | null; expired: boolean
        issued_by: string | null; target_user_id: string | null }>(
        `select accepted_by,accepted_at,expires_at<=statement_timestamp() as expired,issued_by,target_user_id
          from wedding_task_delegations g where g.id=$1 and g.revoked_at is null and ${liveIssuer} for update of g`, [grant.id])
      if (!current || (current.target_user_id && current.target_user_id !== actor)) throw missing()
      if (current.accepted_by === actor) return
      if (current.accepted_at || current.expired || current.issued_by === actor) throw missing()
      const { rows: [membership] } = await client.query('select user_id from wedding_members where wedding_id=$1 and user_id=$2', [grant.wedding_id, actor])
      if (membership) throw conflict('delegation_already_member', 'У вас уже есть доступ к этой свадьбе как у участника команды')
      await client.query('update wedding_task_delegations set accepted_by=$2,accepted_at=now() where id=$1', [grant.id, actor])
      await audit(client, actor, 'task_delegation.accepted', grant)
      await assertSeatingToken(request)
    })
    return reply.code(204).header('Cache-Control', 'no-store').send()
  })

  app.get('/users/me/task-delegations', { preHandler: app.requireConsent }, async (request, reply): Promise<Contract['DelegatedTask'][]> => {
    reply.header('Cache-Control', 'no-store')
    return db().tx(async client => {
      const actor = request.caller!.userId
      const { rows: weddings } = await client.query<{ id: string }>(`select w.id from weddings w
        where w.archived_at is null and w.cancelled_at is null and exists (
          select from wedding_task_delegations g where g.wedding_id=w.id and g.accepted_by=$1 and g.revoked_at is null)
        order by w.id for share of w`, [actor])
      await lockOrderPrincipal(client, { ...request.caller!, policyVersion: app.appConfig.policyVersion })
      const { rows } = await client.query<DelegatedListRow>(`select ${recipientColumns},w.title as wedding_title
        from wedding_task_delegations g join tasks t on t.wedding_id=g.wedding_id and t.id=g.task_id
        join weddings w on w.id=g.wedding_id and w.archived_at is null and w.cancelled_at is null
        where g.accepted_by=$1 and g.wedding_id=any($2::uuid[]) and g.revoked_at is null and ${eligible} and ${liveIssuer}
        order by w.title,g.wedding_id,t.done_at nulls first,t.due nulls last,g.id`, [actor, weddings.map(w => w.id)])
      const byWedding = new Map<string, DelegatedRow[]>()
      for (const row of rows) {
        const tasks = byWedding.get(row.wedding_id)
        if (tasks) tasks.push(row)
        else byWedding.set(row.wedding_id, [row])
      }
      const blockers = new Set<string>()
      for (const [weddingId, tasks] of byWedding) {
        for (const taskId of (await loadTaskBlockers(client, weddingId, tasks)).keys()) blockers.add(taskId)
      }
      await assertSeatingToken(request)
      return rows.map(row => recipientView(row, blockers.has(row.task_id)))
    })
  })

  app.delete<{ Params: DelegationParams }>('/users/me/task-delegations/:delegationId/wedding', {
    preHandler: app.requireConsent, schema: { params: delegationParams },
  }, async (request, reply) => {
    await db().tx(async client => {
      const actor = request.caller!.userId
      const { delegationId } = request.params
      const { rows: [grant] } = await client.query<{ wedding_id: string }>(`select wedding_id from wedding_task_delegations
        where id=$1 and accepted_by=$2`, [delegationId, actor])
      if (!grant) throw missing()
      await lockOrderWedding(client, grant.wedding_id)
      await lockOrderPrincipal(client, { ...request.caller!, policyVersion: app.appConfig.policyVersion })
      const { rows: [anchor] } = await client.query<GrantScope & { revoked_at: Date | null }>(
        `select id,wedding_id,task_id,revoked_at from wedding_task_delegations
          where wedding_id=$1 and id=$2 and accepted_by=$3`, [grant.wedding_id, delegationId, actor])
      if (!anchor) throw missing()
      const action = 'task_delegation.employee_left'
      if (await canRetireRecipient(client, anchor, actor, action)) {
        await retireRecipient(client, grant.wedding_id, actor, actor, action)
      }
      await assertSeatingToken(request)
    })
    return reply.code(204).header('Cache-Control', 'no-store').send()
  })

  app.put<{ Params: DelegationParams; Body: Contract['TaskDelegationCompletion'] }>('/users/me/task-delegations/:delegationId/completion', {
    preHandler: app.requireConsent, schema: { params: delegationParams, body: ref('TaskDelegationCompletion') },
  }, async (request, reply) => {
    const actor = request.caller!.userId, { delegationId } = request.params
    await db().tx(async client => {
      const { rows: [grant] } = await client.query<GrantScope>(
        'select id,wedding_id,task_id from wedding_task_delegations where id=$1 and accepted_by=$2 and revoked_at is null', [delegationId, actor])
      if (!grant) throw missing()
      await lockRecipient(client, request, grant)
      const { rows: [current] } = await client.query<DelegatedRow>(`select ${recipientColumns}
        from wedding_task_delegations g join tasks t on t.wedding_id=g.wedding_id and t.id=g.task_id
        where g.id=$1 and g.accepted_by=$2 and g.revoked_at is null and ${eligible} and ${liveIssuer} for update of g`, [grant.id, actor])
      if (!current) throw missing()
      const { done, expectedRevision } = request.body
      if (done === (current.done_at !== null)) return
      if (expectedRevision !== current.revision) throw conflict('delegated_task_changed', 'Задача изменилась. Обновите поручения')
      if (done && (await loadTaskBlockers(client, grant.wedding_id, [current])).has(grant.task_id)) {
        throw conflict('task_dependencies_pending', 'Сначала должны быть выполнены условия задачи')
      }
      await client.query('update tasks set done_at=case when $3 then now() else null end where wedding_id=$1 and id=$2',
        [grant.wedding_id, grant.task_id, done])
      await audit(client, actor, done ? 'task_delegation.completed' : 'task_delegation.reopened', grant)
      await assertSeatingToken(request)
    })
    return reply.code(204).header('Cache-Control', 'no-store').send()
  })
}
