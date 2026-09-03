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
    'w.date is not null',
    'w.archived_at is null',
    'w.cancelled_at is null',
  ]
  const args: unknown[] = [vendorId]
  if (range) {
    args.push(range.from, range.to)
    conditions.push('w.date >= $2::date', 'w.date < $3::date')
  }
  const { rows } = await db.query<{ date: string }>(
    `select distinct w.date::text as date
       from deals d join weddings w on w.id = d.wedding_id
      where ${conditions.join(' and ')}
      order by 1`,
    args,
  )
  return rows.map((r) => r.date)
}
