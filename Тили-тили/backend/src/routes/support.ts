import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ref } from '../contract/schemas.generated.js'
import { withIdempotency } from '../deals/idempotency.js'
import { AppError, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { lockOrderPrincipal } from '../orders/context.js'
import { buildPage, encodeCursor, parsePageQuery, timestampKey } from '../pagination.js'
import type { Queryable } from '../plugins/db.js'
import { assertSeatingToken } from '../wedding/access.js'

type Status = 'open' | 'resolved'
type CaseRow = { id: string; subject: string; status: Status; assigned: boolean; created_at: Date }
type ScopedCase = CaseRow & { wedding_id: string | null }
type QueueRow = { id: string; status: Status; assigned_to_me: boolean; created_at: Date; key: string }
type Command = { action: 'claim' | 'release' } | { action: 'resolve'; message: string }
type EventKind = 'opened' | 'assigned' | 'released' | 'resolved'
const ownerRoot = '/support/cases'
const staffRoot = '/admin/support/cases'
const params = { type: 'object', required: ['caseId'], properties: { caseId: UUID_ID } }
const activeAssignee = `exists(select 1 from users u where u.id=c.assignee_id and u.is_staff and u.deleted_at is null)`
const fields = `c.id,c.subject,c.status,${activeAssignee} as assigned,c.created_at`
const dto = (row: CaseRow) => ({ id: row.id, subject: row.subject, status: row.status === 'resolved' ? 'resolved'
  : row.assigned ? 'in_progress' : 'open', assigned: row.assigned, createdAt: row.created_at.toISOString() })
const caseScope = (row: ScopedCase) => row.wedding_id ? { weddingId: row.wedding_id } : {}

export async function authorizeSupport(client: Queryable, request: FastifyRequest, staff = false) {
  const { userId, sessionId } = request.caller!
  await lockOrderPrincipal(client, { userId, sessionId, policyVersion: request.server.appConfig.policyVersion })
  if (staff && !(await client.query('select 1 from users where id=$1 and is_staff', [userId])).rowCount) {
    throw forbidden('Раздел для сотрудников платформы')
  }
  return userId
}

async function lockCaseWedding(client: Queryable, weddingId: string, ownerId: string) {
  const owner = await client.query('select 1 from users where id=$1 and deleted_at is null for share', [ownerId])
  if (!owner.rowCount) return false
  const wedding = await client.query('select 1 from weddings where id=$1 for share', [weddingId])
  if (!wedding.rowCount) return false
  const member = await client.query("select 1 from wedding_members where wedding_id=$1 and user_id=$2 and role='couple' for share",
    [weddingId, ownerId])
  return !!member.rowCount
}

export async function lockSupportWeddingAccess(client: Queryable, caseId: string, weddingId: string, staffId: string) {
  const scope = "from support_cases where id=$1 and wedding_id=$2 and assignee_id=$3 and status='open'"
  const keys = [caseId, weddingId, staffId]
  const { rows: [candidate] } = await client.query<{ owner_id: string }>(`select owner_id ${scope}`, keys)
  const denied = () => notFound('Свадьба недоступна по этому обращению')
  if (!candidate || !await lockCaseWedding(client, weddingId, candidate.owner_id)) throw denied()
  // Take the case lock after wedding membership. Recheck assignment after a concurrent release.
  if (!(await client.query(`select 1 ${scope} and owner_id=$4 for share`, [...keys, candidate.owner_id])).rowCount) throw denied()
}

function text(value: string, field: 'subject' | 'message') {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) throw validationFailed({ [field]: 'Введите текст' })
  return trimmed
}

async function history(client: Queryable, caseId: string) {
  const { rows } = await client.query<{ id: string; kind: EventKind; message: string | null; created_at: Date }>(
    'select id,kind,message,created_at from support_case_events where case_id=$1 order by position', [caseId])
  return rows.map(row => ({ id: row.id, kind: row.kind, message: row.message, createdAt: row.created_at.toISOString() }))
}

async function append(client: Queryable, caseId: string, actor: string, kind: EventKind, message: string | null = null) {
  await client.query('insert into support_case_events(id,case_id,actor_id,kind,message) values($1,$2,$3,$4,$5)',
    [uuidv7(), caseId, actor, kind, message])
}

async function audit(client: Queryable, caseId: string, actor: string, action: string) {
  await client.query("insert into audit_log(actor_id,action,entity,entity_id) values($1,$2,'support_case',$3)", [actor, action, caseId])
}

export async function readOwnedSupportExport(client: Queryable, userId: string) {
  const { rows } = await client.query<ScopedCase & { history: object[] }>(`select ${fields},c.wedding_id,
    (select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'message',e.message,
      'createdAt',e.created_at) order by e.position),'[]'::jsonb) from support_case_events e where e.case_id=c.id) as history
    from support_cases c where c.owner_id=$1 order by c.created_at,c.id`, [userId])
  return rows.map(row => ({ ...dto(row), ...caseScope(row), history: row.history }))
}

export async function supportRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const authorize = authorizeSupport
  const getCaseId = (request: FastifyRequest) => (request.params as { caseId: string }).caseId
  const ownerReplay = async (client: Queryable, request: FastifyRequest) => {
    await authorize(client, request)
    await assertSeatingToken(request)
  }
  app.get(ownerRoot, { preHandler: app.requireConsent, schema: { response: { 200: ref('SupportCasePage') } } },
    request => db().tx(async client => {
      const userId = await authorize(client, request)
      const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
      const { rows } = await client.query<CaseRow & { key: string }>(`select ${fields},${timestampKey('c.created_at')} as key
        from support_cases c where c.owner_id=$1 and ($2::timestamptz is null or (c.created_at,c.id)<($2,$3::uuid))
        order by c.created_at desc,c.id desc limit $4`, [userId, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1])
      const result = buildPage(rows, page.limit, row => encodeCursor(row.key, row.id))
      await assertSeatingToken(request)
      return { items: result.items.map(dto), nextCursor: result.nextCursor }
    }))
  app.post(ownerRoot, { preHandler: app.requireConsent, schema: { body: ref('SupportCaseDraft'), response: { 201: ref('SupportCaseReceipt') } } },
    (request, reply) => withIdempotency(db(), request, reply, 'support.create', tx => tx(async client => {
      const userId = await authorize(client, request)
      const body = request.body as { subject: string; message: string; weddingId?: string }
      if (body.weddingId && !await lockCaseWedding(client, body.weddingId, userId)) throw notFound('Свадьба не найдена')
      const id = uuidv7()
      await client.query('insert into support_cases(id,owner_id,subject,wedding_id) values($1,$2,$3,$4)',
        [id, userId, text(body.subject, 'subject'), body.weddingId ?? null])
      await append(client, id, userId, 'opened', text(body.message, 'message'))
      return { status: 201, body: { id } }
    }, { afterReceipt: () => assertSeatingToken(request) }), true, client => ownerReplay(client, request)))

  async function detail(request: FastifyRequest, staff: boolean) {
    return db().tx(async client => {
      const userId = await authorize(client, request, staff)
      const id = getCaseId(request)
      const { rows: [row] } = await client.query<ScopedCase>(`select ${fields},c.wedding_id from support_cases c
        where c.id=$1 and ${staff ? 'c.assignee_id' : 'c.owner_id'}=$2 for share of c`, [id, userId])
      if (!row) throw notFound('Обращение не найдено')
      const events = await history(client, id)
      if (staff) await audit(client, id, userId, 'support.case.read')
      await assertSeatingToken(request)
      return { ...dto(row), ...caseScope(row), history: events }
    })
  }
  const detailOptions = { preHandler: app.requireConsent, schema: { params, response: { 200: ref('SupportCaseDetail') } } }
  app.get(`${ownerRoot}/:caseId`, detailOptions, request => detail(request, false))
  app.get(`${staffRoot}/:caseId`, detailOptions, request => detail(request, true))

  app.get(staffRoot, { preHandler: app.requireConsent, schema: { response: { 200: ref('SupportQueuePage') } } },
    request => db().tx(async client => {
      const staff = await authorize(client, request, true)
      const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
      const { rows } = await client.query<QueueRow>(`select c.id,c.status,c.created_at,
        coalesce(c.assignee_id=$1,false) as assigned_to_me,${timestampKey('c.created_at')} as key from support_cases c
        where c.owner_id<>$1 and (c.assignee_id=$1 or (c.status='open' and not ${activeAssignee}))
          and ($2::timestamptz is null or (c.created_at,c.id)>($2,$3::uuid))
        order by c.created_at,c.id limit $4`, [staff, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1])
      const result = buildPage(rows, page.limit, row => encodeCursor(row.key, row.id))
      await assertSeatingToken(request)
      return { items: result.items.map(row => ({ id: row.id, status: row.status, assignedToMe: row.assigned_to_me,
        createdAt: row.created_at.toISOString() })), nextCursor: result.nextCursor }
    }))

  app.post(`${staffRoot}/:caseId`, { preHandler: app.requireConsent, schema: { params, body: ref('SupportCaseCommand'),
    response: { 200: ref('SupportCaseReceipt') } } }, (request, reply) => withIdempotency(db(), request, reply, 'support.staff.command',
    tx => tx(async client => {
      const staff = await authorize(client, request, true), id = getCaseId(request)
      const command = request.body as Command
      const { rows: [row] } = await client.query<{ status: Status; assignee_id: string | null; assigned: boolean }>(`select c.status,
        c.assignee_id,${activeAssignee} as assigned from support_cases c where c.id=$1 and c.owner_id<>$2 for update of c`, [id, staff])
      if (!row || (command.action !== 'claim' && row.assignee_id !== staff)) throw notFound('Обращение не найдено')
      if (row.status !== 'open') throw conflict('support_case_closed', 'Обращение уже закрыто')
      if (command.action === 'claim' && row.assignee_id === staff) return { status: 200, body: { id } }
      if (command.action === 'claim' && row.assigned) throw conflict('support_case_taken', 'Обращение уже назначено')
      const event = command.action === 'claim' ? 'assigned' : command.action === 'release' ? 'released' : 'resolved'
      await client.query('update support_cases set assignee_id=$2,status=$3 where id=$1',
        [id, command.action === 'release' ? null : staff, command.action === 'resolve' ? 'resolved' : 'open'])
      await append(client, id, staff, event, command.action === 'resolve' ? text(command.message, 'message') : null)
      await audit(client, id, staff, `support.case.${event}`)
      return { status: 200, body: { id } }
    }, { afterReceipt: () => assertSeatingToken(request) }), true, async client => {
      await authorize(client, request, true)
      await assertSeatingToken(request)
    }))
}
