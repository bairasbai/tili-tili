import type { Queryable } from '../plugins/db.js'

export async function familyEventInvitations(client: Queryable, weddingId: string, partyId: string) {
  const { rows } = await client.query<{
    id: string; name: string; kind: string; date: string | null; time_zone: string | null; location: string | null; is_main: boolean; guest_ids: string[]
  }>(`select e.id,e.name,e.kind,e.date::text,e.time_zone,e.location,e.is_main,
       array_agg(g.id order by g.party_position,g.id) as guest_ids
      from wedding_events e join guests g on g.wedding_id=e.wedding_id and g.party_id=$2
      left join guest_event_invitations i on i.wedding_id=e.wedding_id and i.event_id=e.id and i.guest_id=g.id
      where e.wedding_id=$1 and (e.is_main or i.guest_id is not null)
      group by e.id order by e.is_main desc,e.date nulls last,e.id`, [weddingId, partyId])
  return rows.map(e => ({ id: e.id, name: e.name, kind: e.kind, date: e.date, timeZone: e.time_zone,
    location: e.location, isMain: e.is_main, guestIds: e.guest_ids }))
}
