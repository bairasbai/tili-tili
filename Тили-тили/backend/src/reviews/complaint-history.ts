import type { Queryable } from '../plugins/db.js'
import { buildPage, encodeCursor, timestampKey, type PageQuery } from '../pagination.js'
import { complaintDecisionAudit } from './complaint-decisions.js'

type Outcome = 'dismissed' | 'measures_taken' | 'closed'
type Row = { id: string; target_kind: string; category: string; text: string | null; status: 'new' | 'resolved';
  outcome: Outcome | null; public_reason: string | null; created_at: Date; resolved_at: Date | null; cursor_key: string;
  can_appeal: boolean; reviewed_outcome: Exclude<Outcome, 'closed'> | null }

const outcome = `case when status='new' then null when resolution='dismiss' then 'dismissed'
  when resolution in ('warn','downrank','block') then 'measures_taken' else 'closed' end`

export async function listOwnComplaints(client: Queryable, reporter: string, page: PageQuery) {
  const { rows } = await client.query<Row>(`select c.id,c.target_kind,c.category,c.text,c.status,${outcome} as outcome,
      c.public_reason,c.created_at,c.resolved_at,${timestampKey('c.created_at')} as cursor_key,
      coalesce(c.status='resolved' and c.resolution='dismiss' and exists(select 1 ${complaintDecisionAudit}
        and l.actor_id is not null),false) as can_appeal,
      case when a.new_action='dismiss' then 'dismissed'
        when a.new_action is not null then 'measures_taken' end as reviewed_outcome
    from complaints c left join complaint_appeals a on a.complaint_id=c.id
    where c.reporter_id=$1 and ($2::timestamptz is null or (c.created_at,c.id)<($2,$3::uuid))
    order by c.created_at desc,c.id desc limit $4`, [reporter, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1])
  const { items, nextCursor } = buildPage(rows, page.limit, row => encodeCursor(row.cursor_key, row.id))
  return { nextCursor, items: items.map(row => ({ id: row.id, targetKind: row.target_kind, category: row.category,
    text: row.text, status: row.status, createdAt: row.created_at.toISOString(), canAppeal: row.can_appeal,
    reviewedOutcome: row.reviewed_outcome, decision: row.outcome
      ? { outcome: row.outcome, reason: row.public_reason, resolvedAt: row.resolved_at?.toISOString() ?? null } : null })) }
}

export async function exportOwnComplaints(client: Queryable, reporter: string) {
  return (await client.query(`select target_kind,target_id,category,text,status,created_at,resolved_at,
    ${outcome} as outcome,public_reason from complaints where reporter_id=$1 order by created_at,id`, [reporter])).rows
}
