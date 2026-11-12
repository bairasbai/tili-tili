import type { Queryable } from '../plugins/db.js'

export interface PlanBEvent {
  id: string
  name: string
  date: string | null
  timeZone: string | null
  version: string
}

// Query fragments using the wedding_events alias e.
export const PLAN_B_EVENT_VERSION_SQL = `encode(sha256(convert_to(jsonb_build_array(e.id,e.date,e.time_zone,
  extract(epoch from e.modified_at))::text,'UTF8')),'hex')`

export function isPlanBEventDay(event: Pick<PlanBEvent, 'date' | 'timeZone'> | null, now: Date): boolean {
  if (!event?.date || !event.timeZone) return false
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: event.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now)
    const date = ['year', 'month', 'day'].map(kind => parts.find(part => part.type === kind)?.value).join('-')
    return date === event.date
  } catch { return false }
}

export async function planBPushIsUrgent(client: Queryable, broadcastId: string | null | undefined,
  userId: string, now: Date): Promise<boolean> {
  if (!broadcastId) return false
  const { rows } = await client.query<Pick<PlanBEvent, 'date' | 'timeZone'>>(`
    select e.date::text as date, e.time_zone as "timeZone"
      from broadcasts b
      join weddings w on w.id=b.wedding_id and w.cancelled_at is null and w.archived_at is null
      join wedding_events e on e.id=b.planb_urgent_event_id and e.wedding_id=b.wedding_id and e.is_main
      join notification_prefs p on p.user_id=$2 and p.urgent_incidents
      left join planb_scenarios ps on ps.wedding_id=b.wedding_id and b.action='planb:' || ps.scenario
     where b.id=$1 and b.planb_current and b.planb_revision is not distinct from ps.revision
       and b.planb_urgent_event_version=${PLAN_B_EVENT_VERSION_SQL}
       and (exists (select 1 from wedding_members m where m.wedding_id=b.wedding_id and m.user_id=$2)
         or exists (select 1 from deals d join vendors v on v.id=d.vendor_id
           join slots s on s.wedding_id=d.wedding_id and s.id=d.slot_id and s.deal_id=d.id
           where d.wedding_id=b.wedding_id and v.user_id=$2 and d.state in ('booked','paid_deposit','done')
             and (s.program_event_id is null or s.program_event_id=e.id)))
  `, [broadcastId, userId])
  return isPlanBEventDay(rows[0] ?? null, now)
}
