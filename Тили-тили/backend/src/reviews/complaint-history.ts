import type { Queryable } from '../plugins/db.js'
import { buildPage, encodeCursor, timestampKey, type PageQuery } from '../pagination.js'

type Outcome = 'dismissed' | 'measures_taken' | 'closed'
type Row = { id: string; target_kind: string; category: string; text: string | null; status: 'new' | 'resolved';
  outcome: Outcome | null; public_reason: string | null; created_at: Date; resolved_at: Date | null; cursor_key: string }

const outcome = `case when status='new' then null when resolution='dismiss' then 'dismissed'
  when resolution in ('warn','downrank','block') then 'measures_taken' else 'closed' end`

export async function listOwnComplaints(client: Queryable, reporter: string, page: PageQuery) {
  const { rows } = await client.query<Row>(`select id,target_kind,category,text,status,${outcome} as outcome,
      public_reason,created_at,resolved_at,${timestampKey('created_at')} as cursor_key
    from complaints where reporter_id=$1 and ($2::timestamptz is null or (created_at,id)<($2,$3::uuid))
    order by created_at desc,id desc limit $4`, [reporter, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1])
  const { items, nextCursor } = buildPage(rows, page.limit, row => encodeCursor(row.cursor_key, row.id))
  return { nextCursor, items: items.map(row => ({ id: row.id, targetKind: row.target_kind, category: row.category,
    text: row.text, status: row.status, createdAt: row.created_at.toISOString(), decision: row.outcome
      ? { outcome: row.outcome, reason: row.public_reason, resolvedAt: row.resolved_at?.toISOString() ?? null } : null })) }
}

export async function exportOwnComplaints(client: Queryable, reporter: string) {
  return (await client.query(`select target_kind,target_id,category,text,status,created_at,resolved_at,
    ${outcome} as outcome,public_reason from complaints where reporter_id=$1 order by created_at,id`, [reporter])).rows
}
