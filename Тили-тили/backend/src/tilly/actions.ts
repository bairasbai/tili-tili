import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isCheckViolation, type Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { assertRealDate } from '../wedding/dates.js'
import { assertSeatingToken, lockSeatingAccess } from '../wedding/access.js'
import { loadTaskBlockers, type ChecklistTaskIdentity } from '../wedding/checklist-dependencies.js'

export type ActionKind = 'create_task' | 'complete_task' | 'reschedule_task'
type TaskSnapshot = Record<string, { title: string; revision: string; completionBlocked?: boolean }>
export interface TillyProposal { kind: ActionKind; title: string; due: string | null; taskId: string | null; revision: string | null }
export interface TillyActionRow {
  id: string; wedding_id: string; chat_id: string; message_id: string; recipient_user_id: string
  kind: ActionKind; payload: { title: string; due: string | null }; target_task_id: string | null; expected_revision: string | null
  state: 'pending' | 'applied' | 'stale' | 'dismissed'; expires_at: Date; result: { taskId: string } | null
  preview?: { currentDue: string | null; assignee: { name: string | null } | null } | null
}
export function publicTillyAction(row: TillyActionRow, viewer?: string) {
  const canApply = row.state === 'pending' && row.recipient_user_id === viewer && row.expires_at.getTime() > Date.now()
  return { id: row.id, kind: row.kind, title: row.payload.title, due: row.payload.due, state: row.state,
    expiresAt: row.expires_at.toISOString(), result: row.result, canApply,
    ...(canApply && row.preview ? { preview: row.preview } : {}) }
}
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  try { assertRealDate(value); return true } catch { return false }
}
/** Invalid model actions are discarded; a model response itself never mutates tasks. */
export function parseTillyReply(text: string, tasks: TaskSnapshot): { text: string; proposals: TillyProposal[] } {
  let json: unknown
  try { json = JSON.parse(text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')) } catch { return { text, proposals: [] } }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { text, proposals: [] }
  const value = json as Record<string, unknown>
  if (typeof value.reply !== 'string' || !value.reply.trim() || value.reply.length > 20000) return { text, proposals: [] }
  const result = { text: value.reply, proposals: [] as TillyProposal[] }
  if (!exact(value, ['reply', 'actions']) || !Array.isArray(value.actions) || value.actions.length > 3) return result
  for (const raw of value.actions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const action = raw as Record<string, unknown>
    if (action.kind === 'create_task') {
      if (!exact(action, ['kind', 'title', 'due']) || typeof action.title !== 'string' || !action.title.trim() || action.title.length > 200 || Array.from(action.title).some(char => char.charCodeAt(0) < 32) || (action.due !== null && !realDate(action.due))) continue
      result.proposals.push({ kind: action.kind, title: action.title.trim(), due: action.due, taskId: null, revision: null })
    } else if (action.kind === 'complete_task' || action.kind === 'reschedule_task') {
      if (!exact(action, action.kind === 'complete_task' ? ['kind', 'taskId'] : ['kind', 'taskId', 'due']) || typeof action.taskId !== 'string' || !isUuid(action.taskId)) continue
      const original = tasks[action.taskId]
      if (!original || !/^[1-9]\d{0,18}$/.test(original.revision) || (action.kind === 'reschedule_task' && !realDate(action.due))) continue
      if (action.kind === 'complete_task' && original.completionBlocked) continue
      result.proposals.push({ kind: action.kind, title: original.title, due: action.kind === 'reschedule_task' ? action.due as string : null, taskId: action.taskId, revision: original.revision })
    }
  }
  result.proposals = result.proposals.filter((proposal, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(proposal)) === index)
  return result
}

/** Caller holds the wedding lock before inserting reply; causal identity is checked again here. */
export async function storeTillyActions(client: Queryable, input: { weddingId: string; chatId: string; userId: string; questionMessageId?: string }, messageId: string, proposals: TillyProposal[]): Promise<TillyActionRow[]> {
  if (!input.questionMessageId || !isUuid(input.questionMessageId) || !proposals.length) return []
  const question = await client.query(`select m.id from messages m join chats c on c.id=m.chat_id
    join wedding_members wm on wm.wedding_id=c.wedding_id and wm.user_id=$3 and wm.role='couple'
    join users u on u.id=wm.user_id and u.deleted_at is null
    where m.id=$1 and m.chat_id=$2 and m.sender_id=$3 and c.wedding_id=$4 and c.kind='tilly' for share of m,wm,u`,
  [input.questionMessageId, input.chatId, input.userId, input.weddingId])
  if (!question.rowCount) return []
  const actions: TillyActionRow[] = []
  for (const [ordinal, proposal] of proposals.slice(0, 3).entries()) {
    const result = await client.query<TillyActionRow>(`insert into tilly_actions(id,wedding_id,chat_id,message_id,question_message_id,recipient_user_id,kind,payload,target_task_id,expected_revision,ordinal)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`, [uuidv7(),input.weddingId,input.chatId,messageId,input.questionMessageId,input.userId,proposal.kind,JSON.stringify({title:proposal.title,due:proposal.due}),proposal.taskId,proposal.revision,ordinal])
    actions.push(result.rows[0]!)
  }
  return actions
}

async function stale(client: Queryable, id: string) {
  await client.query("update tilly_actions set state='stale',resolved_at=clock_timestamp() where id=$1 and state='pending'", [id])
  return { ok: false as const }
}
async function expired(client: Queryable, row: TillyActionRow): Promise<boolean> {
  const clock = await client.query<{ expired: boolean }>('select $1::timestamptz <= clock_timestamp() as expired', [row.expires_at])
  return clock.rows[0]!.expired
}
export async function applyTillyAction(client: Queryable, request: FastifyRequest, id: string) {
  await lockSeatingAccess(client, request)
  const result = await client.query<TillyActionRow>('select * from tilly_actions where id=$1 and wedding_id=$2 for update', [id, request.member!.weddingId])
  await assertSeatingToken(request)
  const row = result.rows[0]
  if (!row) throw notFound('Предложение не найдено')
  if (row.recipient_user_id !== request.caller!.userId) throw forbidden('Подтвердить может автор запроса')
  if (row.state === 'applied') return { ok: true as const, changed: false, row }
  if (row.state !== 'pending') return { ok: false as const }
  if (await expired(client, row)) return stale(client, row.id)
  await client.query('savepoint tilly_action_effect')
  const rejectEffect = async () => {
    await client.query('rollback to savepoint tilly_action_effect')
    await client.query('release savepoint tilly_action_effect')
    return stale(client, row.id)
  }
  try {
  let taskId = row.target_task_id
  if (row.kind === 'create_task') {
    taskId = uuidv7()
    await client.query(`insert into tasks(id,wedding_id,title,period,source,kind,sort,due,due_mode)
      values($1,$2,$3,null,'user','checklist',(select coalesce(max(sort),-1)+1 from tasks where wedding_id=$2),$4::date,'fixed')`, [taskId,row.wedding_id,row.payload.title,row.payload.due])
  } else {
    const { rows: [task] } = await client.query<ChecklistTaskIdentity & { revision: string }>(
      'select id,revision::text,kind,source,sort,period,done_at,excluded_reason from tasks where id=$1 and wedding_id=$2 and excluded_reason is null for update', [taskId,row.wedding_id])
    await assertSeatingToken(request)
    if (await expired(client, row) || !task || task.kind !== 'checklist' || task.revision !== row.expected_revision) return rejectEffect()
    if (row.kind === 'complete_task') {
      if ((await loadTaskBlockers(client, row.wedding_id, [task])).has(task.id)) return rejectEffect()
      await client.query('update tasks set done_at=coalesce(done_at,clock_timestamp()) where id=$1 and wedding_id=$2', [taskId,row.wedding_id])
    }
    else await client.query("update tasks set due=$3::date,due_mode='fixed' where id=$1 and wedding_id=$2", [taskId,row.wedding_id,row.payload.due])
  }
  await assertSeatingToken(request)
  if (await expired(client, row)) return rejectEffect()
  const updated = await client.query<TillyActionRow>("update tilly_actions set state='applied',resolved_at=clock_timestamp(),result=$2 where id=$1 returning *", [row.id,JSON.stringify({taskId})])
  await assertSeatingToken(request)
  await client.query('release savepoint tilly_action_effect')
  return { ok: true as const, changed: true, row: updated.rows[0]! }
  } catch (error) {
    if (isCheckViolation(error, 'tilly_action_expired')) return rejectEffect()
    throw error
  }
}
export async function tillyActionRoutes(app: FastifyInstance) {
  app.post('/weddings/:weddingId/tilly/actions/:actionId/accept', { schema: { body: { type: 'object', additionalProperties: false, maxProperties: 0 } } }, async (request) => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    const { actionId } = request.params as { actionId: string }
    if (!isUuid(actionId)) throw notFound('Предложение не найдено')
    // Errors for committed expiry/staleness are produced only AFTER the transaction commits.
    const outcome = await app.db.tx(client => applyTillyAction(client, request, actionId))
    if (!outcome.ok) throw conflict('tilly_action_stale', 'Предложение устарело — попросите Тиля подготовить новое')
    if (outcome.changed) await app.realtime.publish({ chatId: outcome.row.chat_id, type: 'message', actorId: request.caller!.userId,
      payload: { actionId: outcome.row.id, messageId: outcome.row.message_id } }).catch(() => undefined)
    return publicTillyAction(outcome.row, request.caller!.userId)
  })
}
