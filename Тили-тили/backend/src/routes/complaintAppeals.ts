import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ref } from '../contract/schemas.generated.js'
import { AppError, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { notify } from '../notify/notify.js'
import { lockOrderPrincipal } from '../orders/context.js'
import { buildPage, encodeCursor, parsePageQuery, timestampKey } from '../pagination.js'
import type { Queryable } from '../plugins/db.js'
import { actionLevel, affectedAccount, applicableActions, applyComplaintAction, complaintDecisionAudit,
  type ComplaintAction } from '../reviews/complaint-decisions.js'
import { assertSeatingToken } from '../wedding/access.js'

type Role = 'reporter' | 'affected'
type AppealOutcome = 'upheld' | 'changed'
type Command = { action: 'claim' | 'release' } |
  { action: 'decide'; outcome: AppealOutcome; reason: string; newAction?: ComplaintAction }
type AppealRow = {
  id: string; appellant_role: Role; appellant_id: string | null; message: string | null
  assignee_id: string | null; outcome: AppealOutcome | null; reason: string | null
  new_action: ComplaintAction | null; created_at: Date; resolved_at: Date | null
}
type OriginalRow = {
  complaint_id: string; target_kind: string; target_id: string; category: string
  resolution: ComplaintAction; public_reason: string | null; decision_at: string; affected_user_id: string | null
}

const ownerPath = '/complaints/:complaintId/appeal'
const staffPath = '/admin/complaint-appeals'
const originalFields = `c.id as complaint_id,c.target_kind,c.target_id,c.category,c.resolution,
  c.public_reason,${timestampKey('c.resolved_at')} as decision_at,c.affected_user_id`
const ownerScope = `c.status='resolved' and c.resolved_at is not null
  and ((c.resolution='dismiss' and c.reporter_id=$2) or
    (c.resolution in ('warn','downrank','block') and c.affected_user_id=$2 and c.reporter_id is distinct from $2))
  and exists(select 1 ${complaintDecisionAudit} and l.actor_id is not null)`
const staffScope = `a.appellant_id is not null and c.reporter_id is distinct from $1
  and c.affected_user_id is distinct from $1 and (${affectedAccount}) is distinct from $1
  and a.appellant_id is distinct from $1 and not exists(select 1 ${complaintDecisionAudit} and l.actor_id=$1)`
const assigned = `exists(select 1 from users u where u.id=a.assignee_id and u.is_staff and u.deleted_at is null)`
const params = (field: 'complaintId' | 'appealId') => ({ type: 'object', required: [field], properties: { [field]: UUID_ID } })
const complaintId = (request: FastifyRequest) => (request.params as { complaintId: string }).complaintId
const appealId = (request: FastifyRequest) => (request.params as { appealId: string }).appealId
const missing = () => notFound('Апелляция или решение не найдены')

function text(value: string, field: 'message' | 'reason') {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) throw validationFailed({ [field]: 'Введите текст' })
  return trimmed
}

const originalDto = (row: OriginalRow, role: Role, staff = false) => ({
  complaintId: row.complaint_id, targetKind: row.target_kind, category: row.category,
  action: row.resolution, decisionAt: row.decision_at, reason: role === 'reporter' || staff ? row.public_reason : null,
})
const appealDto = (row: AppealRow) => ({
  id: row.id, role: row.appellant_role, message: row.message, submittedAt: row.created_at.toISOString(),
  decision: row.outcome ? { outcome: row.outcome, reason: row.reason, newAction: row.new_action,
    decidedAt: row.resolved_at!.toISOString() } : null,
})
const allowedActions = (row: OriginalRow & AppealRow) => (applicableActions[row.target_kind] ?? [])
  .filter(action => row.appellant_role === 'reporter' ? actionLevel[action] > actionLevel.dismiss
    : actionLevel[action] < actionLevel[row.resolution])

export async function exportComplaintAppeals(client: Queryable, userId: string) {
  const { rows } = await client.query<OriginalRow & AppealRow>(`select a.*,${originalFields} from complaint_appeals a
    join complaints c on c.id=a.complaint_id where a.appellant_id=$1 order by a.created_at,a.id`, [userId])
  return rows.map(row => ({ role: row.appellant_role, original: originalDto(row, row.appellant_role), appeal: appealDto(row) }))
}

export async function complaintAppealsRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  async function authorize(client: Queryable, request: FastifyRequest, staff = false) {
    const { userId, sessionId } = request.caller!
    await lockOrderPrincipal(client, { userId, sessionId, policyVersion: app.appConfig.policyVersion })
    if (staff && !(await client.query('select 1 from users where id=$1 and is_staff', [userId])).rowCount) {
      throw forbidden('Раздел для сотрудников платформы')
    }
    return userId
  }
  const audit = (client: Queryable, staff: string, id: string, action: string, diff?: object) =>
    client.query(`insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,'complaint_appeal',$3,$4)`,
      [staff, `complaint_appeal.${action}`, id, diff ? JSON.stringify(diff) : null])

  async function original(client: Queryable, id: string, userId: string, write = false) {
    const { rows: [row] } = await client.query<OriginalRow & { role: Role }>(`select ${originalFields},
      case when c.resolution='dismiss' then 'reporter' else 'affected' end as role from complaints c
      where c.id=$1 and ${ownerScope} for ${write ? 'update' : 'share'} of c`, [id, userId])
    if (!row) throw missing()
    return row
  }

  const ownAppeal = async (client: Queryable, id: string, userId: string) =>
    (await client.query<AppealRow>('select * from complaint_appeals where complaint_id=$1 and appellant_id=$2', [id, userId])).rows[0]

  app.get(ownerPath, { preHandler: app.requireConsent, schema: { params: params('complaintId'),
    response: { 200: ref('ComplaintAppealView') } } }, request => db().tx(async client => {
    const userId = await authorize(client, request)
    const row = await original(client, complaintId(request), userId)
    const appeal = await ownAppeal(client, row.complaint_id, userId)
    await assertSeatingToken(request)
    return { role: row.role, original: originalDto(row, row.role), appeal: appeal ? appealDto(appeal) : null }
  }))

  app.post(ownerPath, { preHandler: app.requireConsent, schema: { params: params('complaintId'),
    body: ref('ComplaintAppealDraft'), response: { 200: ref('ComplaintAppealReceipt'), 201: ref('ComplaintAppealReceipt') } } },
    async (request, reply) => {
      const result = await db().tx(async client => {
        const userId = await authorize(client, request)
        const row = await original(client, complaintId(request), userId, true)
        const message = text((request.body as { message: string }).message, 'message')
        const saved = await ownAppeal(client, row.complaint_id, userId)
        if (saved && saved.message !== message) throw conflict('complaint_appeal_exists', 'Апелляция уже подана')
        const id = saved?.id ?? uuidv7()
        if (!saved) await client.query(`insert into complaint_appeals(id,complaint_id,appellant_id,appellant_role,message)
          values($1,$2,$3,$4,$5)`, [id, row.complaint_id, userId, row.role, message])
        await assertSeatingToken(request)
        return { id, created: !saved }
      })
      return reply.code(result.created ? 201 : 200).send({ id: result.id })
    })

  app.get('/moderation/decisions', { preHandler: app.requireConsent,
    schema: { response: { 200: ref('AffectedComplaintPage') } } }, request => db().tx(async client => {
    const userId = await authorize(client, request)
    const page = parsePageQuery(request.query as { cursor?: unknown; limit?: unknown })
    const { rows } = await client.query<OriginalRow & { outcome: AppealOutcome | null }>(`select ${originalFields},a.outcome
      from complaints c left join complaint_appeals a on a.complaint_id=c.id
      where c.affected_user_id=$2 and c.resolution in ('warn','downrank','block') and ${ownerScope}
        and ($1::timestamptz is null or (c.resolved_at,c.id)<($1,$3::uuid))
      order by c.resolved_at desc,c.id desc limit $4`, [page.cursor?.sort ?? null, userId, page.cursor?.id ?? null, page.limit + 1])
    const result = buildPage(rows, page.limit, row => encodeCursor(row.decision_at, row.complaint_id))
    await assertSeatingToken(request)
    return { items: result.items.map(row => ({ original: originalDto(row, 'affected'), outcome: row.outcome })), nextCursor: result.nextCursor }
  }))

  app.get(staffPath, { preHandler: app.requireConsent, schema: { response: { 200: ref('ComplaintAppealQueue') } } },
    request => db().tx(async client => {
      const staff = await authorize(client, request, true)
      const page = parsePageQuery(request.query as { cursor?: unknown; limit?: unknown })
      const { rows } = await client.query<{
        id: string; target_kind: string; appellant_role: Role; created_at: Date; key: string
        assigned_to_me: boolean; outcome: AppealOutcome | null
      }>(`select a.id,c.target_kind,a.appellant_role,a.created_at,${timestampKey('a.created_at')} as key,
        coalesce(a.assignee_id=$1,false) as assigned_to_me,a.outcome from complaint_appeals a
        join complaints c on c.id=a.complaint_id where ${staffScope}
          and (a.assignee_id=$1 or (a.outcome is null and not ${assigned}))
          and ($2::timestamptz is null or (a.created_at,a.id)>($2,$3::uuid))
        order by a.created_at,a.id limit $4`, [staff, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1])
      const result = buildPage(rows, page.limit, row => encodeCursor(row.key, row.id))
      await assertSeatingToken(request)
      return { items: result.items.map(row => ({ id: row.id, targetKind: row.target_kind, role: row.appellant_role,
        assignedToMe: row.assigned_to_me, outcome: row.outcome, submittedAt: row.created_at.toISOString() })), nextCursor: result.nextCursor }
    }))

  const staffDetailPath = `${staffPath}/:appealId`
  app.get(staffDetailPath, { preHandler: app.requireConsent, schema: { params: params('appealId'),
    response: { 200: ref('ComplaintAppealStaffDetail') } } }, request => db().tx(async client => {
    const staff = await authorize(client, request, true)
    const { rows: [row] } = await client.query<OriginalRow & AppealRow & { complaint_text: string | null }>(
      `select a.*,${originalFields},c.text as complaint_text from complaint_appeals a join complaints c on c.id=a.complaint_id
        where a.id=$2 and a.assignee_id=$1 and ${staffScope} for share of a`, [staff, appealId(request)])
    if (!row) throw missing()
    await audit(client, staff, row.id, 'read')
    await assertSeatingToken(request)
    return { original: originalDto(row, row.appellant_role, true), appeal: appealDto(row), complaintText: row.complaint_text,
      allowedActions: row.outcome ? [] : allowedActions(row) }
  }))

  app.post(staffDetailPath, { preHandler: app.requireConsent, schema: { params: params('appealId'),
    body: ref('ComplaintAppealCommand'), response: { 200: ref('ComplaintAppealReceipt') } } }, async request => {
    const command = request.body as Command
    const result = await db().tx(async client => {
      const staff = await authorize(client, request, true)
      const { rows: [row] } = await client.query<OriginalRow & AppealRow & { assigned: boolean }>(
        `select a.*,${originalFields},${assigned} as assigned from complaint_appeals a join complaints c on c.id=a.complaint_id
          where a.id=$2 and ${staffScope} for update of a`, [staff, appealId(request)])
      if (!row || (command.action !== 'claim' && row.assignee_id !== staff)) throw missing()
      if (command.action === 'decide') {
        const reason = text(command.reason, 'reason')
        const newAction = command.newAction ?? null
        if (row.outcome) {
          if (row.outcome !== command.outcome || row.reason !== reason || row.new_action !== newAction) {
            throw conflict('complaint_appeal_closed', 'Апелляция уже рассмотрена')
          }
          await assertSeatingToken(request)
          return { id: row.id }
        }
        if (command.outcome === 'changed') {
          if (!newAction || !allowedActions(row).includes(newAction)) {
            throw validationFailed({ newAction: 'Выберите допустимое изменение решения' })
          }
        } else if (newAction) throw validationFailed({ newAction: 'Исходное решение остаётся в силе' })
        await client.query(`update complaint_appeals set outcome=$2,reason=$3,new_action=$4,resolved_at=now() where id=$1`,
          [row.id, command.outcome, reason, newAction])
        if (newAction) await applyComplaintAction(client, row, newAction, { action: row.resolution, at: row.decision_at })
        await audit(client, staff, row.id, 'decided', { complaintId: row.complaint_id, outcome: command.outcome, newAction })
        await assertSeatingToken(request)
        return { id: row.id, alert: row.appellant_role === 'reporter' && newAction ? row.affected_user_id : null }
      }
      if (row.outcome) throw conflict('complaint_appeal_closed', 'Апелляция уже рассмотрена')
      if (command.action === 'claim' && row.assigned && row.assignee_id !== staff) {
        throw conflict('complaint_appeal_taken', 'Апелляция уже назначена')
      }
      if (command.action === 'release' || row.assignee_id !== staff) {
        await client.query('update complaint_appeals set assignee_id=$2 where id=$1', [row.id, command.action === 'claim' ? staff : null])
        await audit(client, staff, row.id, command.action)
      }
      await assertSeatingToken(request)
      return { id: row.id }
    })
    if (result.alert) {
      await notify(db(), { userId: result.alert, kind: 'system', title: 'Решение по жалобе пересмотрено',
        body: 'Модерация изменила решение по жалобе.', link: '/support' })
        .catch(err => request.log.warn({ err, appealId: result.id }, 'Не удалось сообщить о пересмотре жалобы'))
    }
    return { id: result.id }
  })
}
