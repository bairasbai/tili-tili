import type { GuestCaller } from '../guests/access.js'
import { uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'

/** The route edit and its passenger snapshot share the exclusive wedding lock. */
export async function recordPickupNotices(client: Queryable, weddingId: string, busId: string, previous: string | null) {
  const result = await client.query(`insert into shuttle_pickup_notices(
      wedding_id,change_id,guest_id,bus_id,program_event_id,route_label,event_label,previous_pickup,pickup)
    select r.wedding_id,$3,g.id,r.id,r.program_event_id,r.name,e.name,$4,r.pickup
      from bus_routes r join bus_bookings b on b.bus_id=r.id
      join guests g on g.wedding_id=r.wedding_id and g.id=b.guest_id
      left join wedding_events e on e.wedding_id=r.wedding_id and e.id=r.program_event_id
      where r.wedding_id=$1 and r.id=$2 and r.pickup is distinct from $4
        and (r.program_event_id is null or exists(select 1 from guest_event_invitations i
          where i.wedding_id=r.wedding_id and i.event_id=r.program_event_id and i.guest_id=g.id))`,
  [weddingId,busId,uuidv7(),previous])
  return result.rowCount ?? 0
}

export async function guestPickupNotices(client: Queryable, guest: GuestCaller) {
  const { rows } = await client.query<{
    change_id: string; guest_id: string; name: string; bus_id: string | null; route_label: string
    event_label: string | null; previous_pickup: string | null; pickup: string | null; created_at: Date
  }>(`select n.change_id,n.guest_id,g.name,n.bus_id,n.route_label,n.event_label,n.previous_pickup,n.pickup,n.created_at
      from shuttle_pickup_notices n join guests g on g.wedding_id=n.wedding_id and g.id=n.guest_id
      where n.wedding_id=$1 and g.party_id=$2
        and (n.program_event_id is null or exists(select 1 from guest_event_invitations i
          where i.wedding_id=n.wedding_id and i.event_id=n.program_event_id and i.guest_id=n.guest_id))
      order by n.created_at desc,n.change_id,n.guest_id limit 100`, [guest.weddingId,guest.partyId])
  return rows.map(row => ({
    changeId: row.change_id, guestId: row.guest_id, passengerName: row.name, busId: row.bus_id,
    routeLabel: row.route_label, eventLabel: row.event_label, previousPickup: row.previous_pickup,
    pickup: row.pickup, createdAt: row.created_at.toISOString(),
  }))
}
