import type { Queryable } from '../plugins/db.js'

const activeTeam = "m.role in ('couple','helper','coordinator') and u.deleted_at is null"

export async function listWeddingMemberOptions(db: Queryable, weddingId: string) {
  const { rows } = await db.query<{ id: string; label: string }>(`select m.user_id as id,u.name as label
    from wedding_members m join users u on u.id=m.user_id
    where m.wedding_id=$1 and ${activeTeam} order by u.name,m.user_id`, [weddingId])
  return rows
}

export async function lockAssignableWeddingMember(db: Queryable, weddingId: string, userId: string): Promise<boolean> {
  const result = await db.query(`select m.user_id from wedding_members m join users u on u.id=m.user_id
    where m.wedding_id=$1 and m.user_id=$2 and ${activeTeam} for share of m,u`, [weddingId, userId])
  return result.rowCount === 1
}
