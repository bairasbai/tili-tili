import type { Queryable } from '../plugins/db.js'

/**
 * Даты подрядчика под мягкой бронью (План §18.3).
 *
 * Занятая дата лежит в `vendor_busy_dates`, а мягкая бронь — нет: она
 * живёт сроком у сделки в состоянии `negotiating`. Держать её в таблице
 * занятости значило бы закрывать дату под договорённость, которой ещё нет.
 *
 * Другим парам такая дата показывается «под вопросом»: свободной её
 * называть нельзя — переговоры идут, — а занятой рано.
 */
export async function holdDatesOf(
  db: Queryable,
  vendorId: string,
  range?: { from: string; to: string },
): Promise<string[]> {
  const conditions = [
    'd.vendor_id = $1',
    "d.state = 'negotiating'",
    'd.negotiating_until is not null',
    'd.negotiating_until > now()',
    'service.date is not null',
    'w.archived_at is null',
    'w.cancelled_at is null',
  ]
  const args: unknown[] = [vendorId]
  if (range) {
    args.push(range.from, range.to)
    conditions.push('service.date >= $2::date', 'service.date < $3::date')
  }
  const { rows } = await db.query<{ date: string }>(
    `select distinct service.date::text as date
       from deals d join weddings w on w.id = d.wedding_id
       join slots s on s.id=d.slot_id and s.wedding_id=w.id
       left join wedding_events e on e.wedding_id=w.id
         and (e.id=s.program_event_id or (s.program_event_id is null and e.is_main))
       cross join lateral (select case when s.program_event_id is null then w.date else e.date end as date) service
      where ${conditions.join(' and ')}
      order by 1`,
    args,
  )
  return rows.map((r) => r.date)
}
