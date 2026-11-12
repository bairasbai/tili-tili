import type { Queryable } from '../plugins/db.js'

/**
 * One clock for the completion screen and its reminders. The next local
 * midnight is the earliest end of an event day. Scheduled blocks can extend it.
 * Undated events and unknown event zones keep the program unresolved.
 *
 * SQL consumers use "w" for the weddings row and load the zone names once.
 */
const ZONES_SQL = 'with completion_zones as materialized (select name from pg_timezone_names)'
const COMPLETION_PROGRAM_SQL = `
  left join lateral (
    select days.date,days.time_zone,days.ends_at,
           bool_and(days.ends_at is not null) over () and bool_or(days.is_main) over () as complete,
           max(days.time_zone) filter (where days.is_main) over () as main_time_zone
      from (
        select e.id,e.date,e.is_main,zone.name as time_zone,
               case when e.date is not null and zone.name is not null and not coalesce(blocks.unfinished_late, false)
                 then greatest(local_day.midnight, blocks.latest_end) end as ends_at
          from wedding_events e
          left join completion_zones zone on zone.name=coalesce(e.time_zone,case when e.is_main then 'Europe/Moscow' end)
          cross join lateral (select (e.date+1)::timestamp at time zone zone.name as midnight) local_day
          left join lateral (
            select max(coalesce(t.ends_at,t.starts_at+t.duration_minutes*interval '1 minute')) as latest_end,
                   bool_or(t.starts_at>=local_day.midnight and t.ends_at is null and t.duration_minutes is null) as unfinished_late
              from timeline_events t
             where t.wedding_id=e.wedding_id and t.program_event_id=e.id
          ) blocks on true
         where e.wedding_id=w.id
      ) days
     order by days.ends_at desc nulls last,days.date desc nulls last,days.id
     limit 1
  ) program on true
`

type CompletionState = 'waiting' | 'ready' | 'schedule_incomplete' | 'cancelled'

interface CompletionRow {
  title: string
  state: CompletionState
  date: string | null
  time_zone: string | null
  completion_at: Date | null
}

export async function readWeddingCompletion(client: Queryable, weddingId: string) {
  const { rows: [row] } = await client.query<CompletionRow>(`
    ${ZONES_SQL}
    select w.title,
           case when w.cancelled_at is not null then 'cancelled'
                when program.complete is not true then 'schedule_incomplete'
                when statement_timestamp() < program.ends_at then 'waiting' else 'ready' end as state,
           case when program.complete and w.cancelled_at is null then program.date::text end as date,
           case when program.complete and w.cancelled_at is null then program.time_zone end as time_zone,
           case when program.complete and w.cancelled_at is null then program.ends_at end as completion_at
      from weddings w ${COMPLETION_PROGRAM_SQL}
     where w.id=$1 and w.archived_at is null`, [weddingId])
  return row ? {
    title: row.title, state: row.state, lastEventDate: row.date, timeZone: row.time_zone,
    completionAt: row.completion_at?.toISOString() ?? null,
  } : null
}

interface CompletionReminderRow {
  id: string
  days: number
  years: number
  anniversary: boolean
  deals: boolean
  photos: number
}

export async function readCompletionReminderCandidates(client: Queryable, weddingId: string | null = null) {
  const { rows } = await client.query<CompletionReminderRow>(`
    ${ZONES_SQL}
    select w.id,elapsed.days,elapsed.years,elapsed.anniversary,
           exists(select 1 from deals d where d.wedding_id=w.id and d.state in ('booked','paid_deposit','done')) as deals,
           (select count(*)::int from album_photos p where p.wedding_id=w.id) as photos
      from weddings w ${COMPLETION_PROGRAM_SQL}
      cross join lateral (
        select (statement_timestamp() at time zone program.time_zone)::date as program_today,
               (statement_timestamp() at time zone program.main_time_zone)::date as wedding_today
      ) today
      cross join lateral (
        select today.program_today-((program.ends_at-interval '1 millisecond') at time zone program.time_zone)::date as days,
               extract(year from age(today.wedding_today,w.date))::int as years,
               to_char(today.wedding_today,'MM-DD')=to_char(w.date,'MM-DD') as anniversary
      ) elapsed
     where ($1::uuid is null or w.id=$1)
       and w.date<=(statement_timestamp() at time zone 'UTC')::date+1
       and w.archived_at is null and w.cancelled_at is null
       and program.complete and program.ends_at<=statement_timestamp()
       and (elapsed.days between 1 and 7 or elapsed.days between 14 and 21
            or (elapsed.anniversary and elapsed.years>=1))
     order by w.id`, [weddingId])
  return rows
}
