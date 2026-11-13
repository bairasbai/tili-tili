import type { Queryable } from '../plugins/db.js'
import { validationFailed } from '../errors.js'
import type { ImportedCalendarPeriod } from './calendar-import.js'

export type ExternalCalendarSource = 'ics' | 'external'

export async function assertCalendarZone(client: Queryable, timeZone: string): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) {
    throw validationFailed({ timeZone: 'Укажите часовой пояс календаря' })
  }
  const { rowCount } = await client.query('select 1 from pg_timezone_names where name=$1', [timeZone])
  if (!rowCount) throw validationFailed({ timeZone: 'Укажите часовой пояс календаря' })
}

export async function writeExternalCalendar(
  client: Queryable, vendorId: string, source: ExternalCalendarSource, timeZone: string, periods: ImportedCalendarPeriod[],
): Promise<number> {
  if (source === 'ics') await client.query('delete from vendor_external_calendar_periods where vendor_id=$1 and source=$2', [vendorId, source])
  const { rowCount } = await client.query(
    `with source as (
       select case when kind='day' then start::date else (start::timestamptz at time zone $3)::date end first_day,
              case when kind='day' then "end"::date else (("end"::timestamptz-interval '1 microsecond') at time zone $3)::date+1 end next_day,
              case when kind='day' then start::date::timestamp at time zone $3 else start::timestamptz end starts_at,
              case when kind='day' then "end"::date::timestamp at time zone $3 else "end"::timestamptz end ends_at
         from jsonb_to_recordset($4::jsonb) as p(kind text,start text,"end" text)
     )
     insert into vendor_external_calendar_periods(vendor_id,source,days,occupied)
       select $1,$2,daterange(first_day,next_day,'[)'),tstzrange(starts_at,ends_at,'[)') from source
       on conflict do nothing`, [vendorId, source, timeZone, JSON.stringify(periods)]).catch((error: unknown) => {
    if ((error as { code?: string }).code === '23514') {
      throw validationFailed({ calendar: 'Проверьте границы событий в часовом поясе календаря' })
    }
    throw error
  })
  if (source === 'external') {
    const { rows: [coverage] } = await client.query<{ count: number }>(`
      select count(*)::int as count from vendor_external_calendar_periods where vendor_id=$1 and source='external'
    `, [vendorId])
    if (coverage!.count > 500) throw validationFailed({ periods: 'Сократите список внешних интервалов до 500' })
  }
  await client.query(
    `delete from vendor_free_date_confirmations f where f.vendor_id=$1 and exists (
       select 1 from vendor_external_calendar_periods p where p.vendor_id=f.vendor_id and p.source=$2 and p.days @> f.date)`,
    [vendorId, source])
  return rowCount ?? 0
}

export async function externalBusyDates(
  client: Queryable, vendorId: string, range?: { from: string; to: string },
): Promise<{ date: string; source: ExternalCalendarSource; marked_at: Date }[]> {
  const { rows } = await client.query<{ date: string; source: ExternalCalendarSource; marked_at: Date }>(
    `select distinct on (g.day) g.day::date::text as date,p.source,p.marked_at
       from vendor_external_calendar_periods p
       cross join lateral generate_series(
         greatest(lower(p.days),$2::date)::timestamp,
         (least(upper(p.days),$3::date)-1)::timestamp,
         interval '1 day'
       ) g(day)
      where p.vendor_id=$1 and p.days && daterange($2::date,$3::date,'[)')
      order by g.day,p.source,p.marked_at desc`, [vendorId, range?.from ?? null, range?.to ?? null])
  return rows
}
