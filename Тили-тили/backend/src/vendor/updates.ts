import type { Queryable } from '../plugins/db.js'
import { uuidv7 } from '../ids.js'

/**
 * Новость для подрядчиков забронированной свадьбы (§13.2).
 *
 * Уведомление и обновление — разные вещи. Уведомление уходит в общий
 * список и тонет между «новое сообщение» и «гость ответил». Обновление
 * живёт короткой карточкой в кабинете, пока подрядчик его не закроет:
 * ему нужно не «узнать», а «учесть» — пересчитать порции, переставить
 * технику, приехать к другому времени.
 *
 * Кому. Только тем, чья сделка дошла до брони: кандидату, который ещё
 * ничего не обещал, чужая рассадка не нужна.
 */
export type VendorUpdateKind = 'seating' | 'menu' | 'timeline' | 'guests'

export async function noteVendorUpdate(
  db: Queryable,
  weddingId: string,
  kind: VendorUpdateKind,
  text: string,
): Promise<number> {
  const { rows } = await db.query<{ vendor_id: string }>(
    `select distinct d.vendor_id from deals d
      where d.wedding_id = $1 and d.vendor_id is not null
        and d.state in ('booked','paid_deposit','done')`,
    [weddingId],
  )
  for (const row of rows) {
    /* Рассадку двигают мышью, и каждое движение — не новость. Пока
     * прежняя строка не подтверждена, новая правка того же вида
     * обновляет её текст: иначе карточка превращается в ленту из
     * сорока «рассадка обновлена» за один вечер. */
    await db.query(
      `insert into vendor_updates (id, vendor_id, wedding_id, kind, text) values ($1,$2,$3,$4,$5)
       on conflict (vendor_id, wedding_id, kind) where ack_at is null
       do update set text = excluded.text, created_at = now()`,
      [uuidv7(), row.vendor_id, weddingId, kind, text],
    )
  }
  return rows.length
}
