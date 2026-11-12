import type { Queryable } from '../plugins/db.js'
import { conflict } from '../errors.js'
import { recomputeRating } from './rating.js'

export type ComplaintAction = 'dismiss' | 'warn' | 'downrank' | 'block'
export const applicableActions: Record<string, readonly ComplaintAction[]> = {
  vendor: ['dismiss', 'warn', 'downrank', 'block'],
  review: ['dismiss', 'warn', 'block'],
  message: ['dismiss', 'warn'],
  deal: ['dismiss', 'warn'],
}

export const actionLevel: Record<ComplaintAction, number> = { dismiss: 0, warn: 1, downrank: 2, block: 3 }

export const affectedAccount = `case c.target_kind
  when 'vendor' then (select user_id from vendors where id=c.target_id)
  when 'review' then (select author_user_id from reviews where id=c.target_id)
  when 'message' then (select sender_id from messages where id=c.target_id)
end`

export const complaintDecisionAudit = `from audit_log l where l.entity=c.target_kind and l.entity_id=c.target_id
  and l.action='complaint.'||c.resolution and l.diff->>'complaintId'=c.id::text and l.at=c.resolved_at`

const remainingEffect = `select max(case when a.new_action is not null then a.resolved_at else c.resolved_at end)
  from complaints c left join complaint_appeals a on a.complaint_id=c.id
  where c.target_kind=$1 and c.target_id=$2 and c.status='resolved'
    and coalesce(a.new_action,c.resolution)=$3`

type Target = { target_kind: string; target_id: string }
type PriorDecision = { action: ComplaintAction; at: string }

async function updateFlag(client: Queryable, table: 'vendors' | 'reviews',
  column: 'blocked_at' | 'downranked_at' | 'hidden_at', target: Target, effect: ComplaintAction,
  action: ComplaintAction, previous?: PriorDecision) {
  if (action !== effect && previous?.action !== effect) return false
  const add = action === effect
  const update = add
    ? `update ${table} set ${column}=now()${table === 'reviews' ? ',moderated_at=now()' : ''}
        where id=$1 and ${column} is null`
    : `update ${table} set ${column}=(${remainingEffect})${table === 'reviews' ? ',moderated_at=now()' : ''}
        where id=$2 and ${column}=$4::timestamptz`
  const result = await client.query(update, add ? [target.target_id] : [target.target_kind, target.target_id, effect, previous!.at])
  return (result.rowCount ?? 0) > 0
}

/** Serialize flags by target before calculating remaining complaints in a fresh SQL snapshot. */
export async function applyComplaintAction(client: Queryable, target: Target,
  action: ComplaintAction, previous?: PriorDecision) {
  const increases = previous !== undefined && actionLevel[action] > actionLevel[previous.action]
  const unavailable = () => {
    if (increases) throw conflict('complaint_target_unavailable', 'Объект жалобы больше недоступен')
  }
  if (target.target_kind === 'vendor') {
    if (!increases && actionLevel[action] < 2 && (!previous || actionLevel[previous.action] < 2)) return
    const { rowCount } = await client.query('select 1 from vendors where id=$1 for no key update', [target.target_id])
    if (!rowCount) return unavailable()
    await updateFlag(client, 'vendors', 'blocked_at', target, 'block', action, previous)
    await updateFlag(client, 'vendors', 'downranked_at', target, 'downrank', action, previous)
  }
  if (target.target_kind === 'review' && (increases || action === 'block' || previous?.action === 'block')) {
    const { rows: [review] } = await client.query<{ vendor_id: string }>('select vendor_id from reviews where id=$1', [target.target_id])
    if (!review) return unavailable()
    await client.query('select 1 from vendors where id=$1 for no key update', [review.vendor_id])
    const { rowCount } = await client.query('select 1 from reviews where id=$1 for no key update', [target.target_id])
    if (!rowCount) return unavailable()
    if (await updateFlag(client, 'reviews', 'hidden_at', target, 'block', action, previous)) {
      await recomputeRating(client, review.vendor_id)
    }
  }
  if (increases && (target.target_kind === 'message' || target.target_kind === 'deal')) {
    const table = target.target_kind === 'message' ? 'messages' : 'deals'
    if (!(await client.query(`select 1 from ${table} where id=$1 for key share`, [target.target_id])).rowCount) unavailable()
  }
}
