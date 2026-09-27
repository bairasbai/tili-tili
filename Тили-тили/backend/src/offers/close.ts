import type { Queryable } from '../plugins/db.js'
import { notifyVendorOfferEvent } from './notify.js'

/** Caller holds the wedding row. Close requests before taking deal/vendor locks. */
export async function closeWeddingOfferRequests(
  client: Queryable,
  weddingId: string,
  weddingTz: string | null,
  reason: 'date_changed' | 'wedding_cancelled',
): Promise<void> {
  const { rows } = await client.query<{ user_id: string | null }>(
    `with targets as (
       select r.id from offer_requests r join slots s on s.id = r.slot_id
        where s.wedding_id = $1 and r.status = 'open' order by r.id for update of r
     ), closed as (
       update offer_requests r set status = 'closed', close_reason = $2, closed_at = now()
        from targets t where r.id = t.id returning r.id, r.vendor_id
     )
     select v.user_id from closed c left join vendors v on v.id = c.vendor_id order by c.id`,
    [weddingId, reason],
  )
  for (const row of rows) {
    if (row.user_id) await notifyVendorOfferEvent(client, row.user_id, weddingTz, reason)
  }
}
