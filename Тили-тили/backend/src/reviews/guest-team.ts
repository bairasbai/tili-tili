import type { Queryable } from '../plugins/db.js'
import { COMMITTED } from '../deals/state.js'

export async function guestReviewTeam(client: Queryable, weddingId: string, vendorId: string | null = null) {
  const { rows } = await client.query<{ vendorId: string; name: string; categoryId: string }>(`
    select v.id as "vendorId",v.name,v.category_id as "categoryId"
      from vendors v
     where ($3::uuid is null or v.id=$3) and exists (
       select 1 from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
        where d.wedding_id=$1 and d.vendor_id=v.id and d.state=any($2::text[])
     )
     order by v.name,v.id`, [weddingId, COMMITTED, vendorId])
  return rows
}
