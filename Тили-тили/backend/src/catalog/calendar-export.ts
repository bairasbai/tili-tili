import { randomUUID } from 'node:crypto'
import type { Queryable } from '../plugins/db.js'
import { validationFailed } from '../errors.js'
import { isRealDate } from '../wedding/dates.js'

function monthBounds(month: string): [string, string] {
  const first = month + '-01'
  if (!isRealDate(first) || month === '9999-12') throw validationFailed({ month: 'Укажите месяц календаря' })
  const end = new Date(first + 'T00:00:00Z')
  end.setUTCMonth(end.getUTCMonth() + 1)
  return [first, end.toISOString().slice(0, 10)]
}

const icalDate = (value: string) => value.replaceAll('-', '')
const icalInstant = (value: Date) => value.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')

/** Produces an owner download with generic events and no identifiers from the database. */
export async function exportVendorCalendar(client: Queryable, vendorId: string, month: string): Promise<string> {
  const [from, to] = monthBounds(month)
  const { rows } = await client.query<{ kind: 'day' | 'utc'; day_start: string | null; day_end: string | null; starts_at: Date | null; ends_at: Date | null }>(`
    with month_window as (
      select tstzrange($2::date::timestamp at time zone 'UTC',$3::date::timestamp at time zone 'UTC','[)') span
    ), days as (
      select unnest(range_agg(daterange(date,date+1,'[)'))) span
        from vendor_busy_dates where vendor_id=$1 and date >= $2::date and date < $3::date
    ), intervals as (
      select occupied span from vendor_external_calendar_periods where vendor_id=$1
      union all
      select tstzrange(occupied_starts_at,occupied_ends_at,'[)')
        from resource_occupancy where vendor_identity=$1 and released_at is null
      union all
      select tstzrange(w.starts_at,w.ends_at,'[)')
        from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id
        where r.vendor_id=$1 and w.legacy_used>0
    ), clipped as (
      select i.span * w.span span from intervals i cross join month_window w where i.span && w.span
    ), merged as (
      select unnest(range_agg(tstzrange(date_trunc('second',lower(span)),
        date_trunc('second',upper(span)+interval '999 milliseconds 999 microseconds'),'[)'))) span from clipped
    )
    select 'day' kind,lower(span)::text day_start,upper(span)::text day_end,
      null::timestamptz starts_at,null::timestamptz ends_at from days
    union all
    select 'utc',null,null,lower(span),upper(span) from merged
    order by kind,day_start,starts_at
    limit 501`, [vendorId, from, to])
  if (rows.length > 500) throw validationFailed({ month: 'Слишком много интервалов для одного файла' })
  const stamp = icalInstant(new Date())
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tili-Tili//Vendor availability//EN',
    ...rows.flatMap(row => [
      'BEGIN:VEVENT',
      `UID:${randomUUID()}@tili-tili`,
      `DTSTAMP:${stamp}`,
      row.kind === 'day' ? `DTSTART;VALUE=DATE:${icalDate(row.day_start!)}` : `DTSTART:${icalInstant(row.starts_at!)}`,
      row.kind === 'day' ? `DTEND;VALUE=DATE:${icalDate(row.day_end!)}` : `DTEND:${icalInstant(row.ends_at!)}`,
      'SUMMARY:Busy', 'TRANSP:OPAQUE', 'END:VEVENT',
    ]), 'END:VCALENDAR', '',
  ].join('\r\n')
}
