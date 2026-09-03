import type { Queryable } from '../plugins/db.js'
import { uuidv7 } from '../ids.js'

/**
 * Заявка подрядчику.
 *
 * Рождается в двух местах: из «Написать» и из брони слота. Обычная функция,
 * а не декоратор приложения: декоратор виден только внутри того плагина, где
 * объявлен, и вызов из соседнего модуля падал бы с «не функция» — ровно это
 * и случилось при первом заходе.
 *
 * Повтор — тот же лид: пара, написавшая дважды, не превращается в две заявки.
 *
 * Уведомления отсюда нет намеренно. О первом сообщении подрядчик узнаёт
 * из уведомления чата, о брони — из уведомления о сделке; третье письмо
 * про то же самое событие — это спам, а не забота.
 */
export async function openLead(
  db: Queryable,
  weddingId: string,
  vendorId: string,
  message: string | null,
  won = false,
): Promise<void> {
  await db.query(
    `insert into leads (id, vendor_id, wedding_id, message, state)
     values ($1,$2,$3,$4,$5)
     on conflict (vendor_id, wedding_id) do update
       set state = case when $5 = 'won' then 'won' else leads.state end`,
    [uuidv7(), vendorId, weddingId, message, won ? 'won' : 'new'],
  )
}
