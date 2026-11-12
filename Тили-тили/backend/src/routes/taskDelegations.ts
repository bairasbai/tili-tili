import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { ref } from '../contract/schemas.generated.js'
import { AppError, conflict, notFound } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { lockOrderPrincipal, lockOrderWedding } from '../orders/context.js'
import type { Queryable } from '../plugins/db.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'
import { loadTaskBlockers, type ChecklistTaskIdentity } from '../wedding/checklist-dependencies.js'

type Contract = components['schemas']
type GrantScope = { id: string; wedding_id: string; task_id: string }
type DelegationParams = { delegationId: string }
type DelegatedRow = GrantScope & ChecklistTaskIdentity & { delegation_id: string; title: string; due: string | null; revision: string }

const delegationParams = { type: 'object', required: ['delegationId'], properties: { delegationId: UUID_ID } } as const
const recipientColumns = `g.id as delegation_id,t.id,t.wedding_id,t.id as task_id,t.title,t.due::text,t.revision::text,
  t.kind,t.source,t.period,t.sort,t.excluded_reason,t.done_at`
const eligible = "t.kind='checklist' and t.excluded_reason is null"
const missing = () => notFound('Поручение не найдено или больше недоступно')
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex')

async function lockTask(client: Queryable, weddingId: string, taskId: string) {
  const { rows: [task] } = await client.query(`select t.id from tasks t where t.wedding_id=$1 and t.id=$2 and ${eligible} for update`, [weddingId, taskId])
  if (!task) throw missing()
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

function recipientView(row: DelegatedRow, blocked: boolean): Contract['DelegatedTask'] {
  return { id: row.delegation_id, title: row.title, due: row.due, done: row.done_at !== null, revision: row.revision, blocked }
}

export async function taskDelegationRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.get('/weddings/:weddingId/task-delegations', async (request, reply): Promise<Contract['TaskDelegationBoard']> => {
    reply.header('Cache-Control', 'no-store')
    return db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const { weddingId } = request.member!
      const { rows: [wedding] } = await client.query<{ read_only: boolean }>('select cancelled_at is not null as read_only from weddings where id=$1', [weddingId])
      const { rows: tasks } = await client.query<{ id: string; title: string }>(
        `select t.id,t.title from tasks t where t.wedding_id=$1 and ${eligible} order by t.sort,t.id`, [weddingId])
      const { rows } = await client.query<{ id: string; taskId: string; taskTitle: string; expires_at: Date; accepted_at: Date | null; recipientName: string | null }>(
        `select g.id,g.task_id as "taskId",t.title as "taskTitle",g.expires_at,g.accepted_at,u.name as "recipientName"
          from wedding_task_delegations g join tasks t on t.wedding_id=g.wedding_id and t.id=g.task_id
          left join users u on u.id=g.accepted_by and u.deleted_at is null
          where g.wedding_id=$1 and g.revoked_at is null and ${eligible}
            and (g.accepted_at is not null or g.expires_at>now()) order by g.created_at desc,g.id desc`, [weddingId])
      return { readOnly: wedding!.read_only, tasks, items: rows.map(row => ({
        id: row.id, taskId: row.taskId, taskTitle: row.taskTitle, recipientName: row.recipientName,
        expiresAt: row.expires_at.toISOString(), accepted: row.accepted_at !== null,
      })) }
    })
  })

  app.post<{ Body: Contract['TaskDelegationCreate'] }>('/weddings/:weddingId/task-delegations', {
    schema: { body: ref('TaskDelegationCreate') },
  }, async (request, reply) => {
    const { taskId } = request.body
    const actor = request.caller!.userId, weddingId = request.member!.weddingId
    const code = randomBytes(24).toString('base64url'), id = uuidv7()
    const result = await db().tx(async client => {
      await lockSeatingAccess(client, request)
      await lockTask(client, weddingId, taskId)
      await client.query(`update wedding_task_delegations set revoked_at=now()
        where wedding_id=$1 and task_id=$2 and revoked_at is null and accepted_at is null and expires_at<=statement_timestamp()`, [weddingId, taskId])
      const { rows: [grant] } = await client.query<{ expires_at: Date }>(
        `insert into wedding_task_delegations(id,wedding_id,task_id,issued_by,code_hash,expires_at)
         values($1,$2,$3,$4,$5,statement_timestamp()+interval '7 days')
         on conflict(wedding_id,task_id) where revoked_at is null do nothing returning expires_at`, [id, weddingId, taskId, actor, hashCode(code)])
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
      await lockSeatingAccess(client, request)
      const { rows: [grant] } = await client.query<GrantScope & { revoked_at: Date | null }>(
        'select id,wedding_id,task_id,revoked_at from wedding_task_delegations where wedding_id=$1 and id=$2',
        [weddingId, request.params.delegationId])
      if (!grant) throw missing()
      if (grant.revoked_at) return
      await lockTask(client, weddingId, grant.task_id)
      const updated = await client.query('update wedding_task_delegations set revoked_at=now() where id=$1 and revoked_at is null', [grant.id])
      if (updated.rowCount) await audit(client, request.caller!.userId, 'task_delegation.revoked', grant)
      await assertSeatingToken(request)
    })
    return reply.code(204).send()
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
      const { rows: [current] } = await client.query<{ accepted_by: string | null; accepted_at: Date | null; expired: boolean; issued_by: string | null }>(
        `select accepted_by,accepted_at,expires_at<=statement_timestamp() as expired,issued_by from wedding_task_delegations
          where id=$1 and revoked_at is null for update`, [grant.id])
      if (!current) throw missing()
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
      await lockOrderPrincipal(client, { ...request.caller!, policyVersion: app.appConfig.policyVersion })
      const { rows } = await client.query<DelegatedRow>(`select ${recipientColumns}
        from wedding_task_delegations g join tasks t on t.wedding_id=g.wedding_id and t.id=g.task_id
        join weddings w on w.id=g.wedding_id and w.archived_at is null and w.cancelled_at is null
        where g.accepted_by=$1 and g.revoked_at is null and ${eligible}
        order by t.done_at nulls first,t.due nulls last,g.id`, [actor])
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
      return rows.map(row => recipientView(row, blockers.has(row.task_id)))
    })
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
        where g.id=$1 and g.accepted_by=$2 and g.revoked_at is null and ${eligible} for update of g`, [grant.id, actor])
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
