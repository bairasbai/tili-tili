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
  /* Выигранный лид срок мягкой брони не держит: бронь стала сделкой, и
   * «держим до …» рядом со статусом `won` в кабинете — прошлое (ревью 015). */
  await db.query(
    `insert into leads (id, vendor_id, wedding_id, message, state)
     values ($1,$2,$3,$4,$5)
     on conflict (vendor_id, wedding_id) do update
       set state = case when $5 = 'won' then 'won' else leads.state end,
           hold_until = case when $5 = 'won' then null else leads.hold_until end`,
    [uuidv7(), vendorId, weddingId, message, won ? 'won' : 'new'],
  )
}

/**
 * Отмена сделки возвращает лид в работу.
 *
 * `won` — «по этому лиду есть сделка», и кабинет по нему ничего не даёт
 * делать (409 `lead_won`). После отмены сделки лид оставался выигранным
 * навсегда: пара, вернувшаяся к тому же подрядчику, писала в заявку, по
 * которой он не мог ни ответить, ни отказать (ревью 015). Возвращается в
 * `replied` — переписка была, договорённость сорвалась, — и только если у
 * пары с этим подрядчиком не осталось другой живой сделки (фото + видео —
 * два слота, один лид). Зовётся из каждой двери отмены, как `detachBusRoutes`.
 */
export async function releaseLead(db: Queryable, dealId: string): Promise<void> {
  await db.query(
    `update leads l set state = 'replied'
      where l.state = 'won'
        and (l.vendor_id, l.wedding_id) = (select d.vendor_id, d.wedding_id from deals d where d.id = $1)
        and not exists (
          select 1 from deals o
           where o.vendor_id = l.vendor_id and o.wedding_id = l.wedding_id
             and o.id <> $1 and o.state in ('booked', 'paid_deposit', 'done'))`,
    [dealId],
  )
}
