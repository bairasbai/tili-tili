import type { Db, Queryable } from '../plugins/db.js'
import { uuidv7 } from '../ids.js'
import { HOLD_HOURS, tileState, type DealState } from './state.js'

export interface DealRow {
  id: string
  state: DealState
  vendor_id: string | null
  vendor_name: string | null
  vendor_category: string | null
  vendor_city: string | null
  external_name: string | null
  external_phone: string | null
  price: string | null
  currency: string
  negotiating_until: Date | null
  booked_at: Date | null
  done_at: Date | null
  cancelled_at: Date | null
}

export const DEAL_COLUMNS = `
  d.id, d.state, d.vendor_id, d.external_name, d.external_phone,
  d.price::text as price, d.currency, d.negotiating_until, d.booked_at, d.done_at, d.cancelled_at,
  ven.name as vendor_name, ven.category_id as vendor_category, vc.name as vendor_city`

export const DEAL_JOINS = `
  left join vendors ven on ven.id = d.vendor_id
  left join cities vc on vc.id = ven.city_id`

/**
 * Сделка в форме контракта.
 *
 * `seesMoney` — не украшение: помощник и координатор не видят сумм нигде
 * (план §6, ERR-0026), а сделка видна им на экране команды.
 */
export function toDeal(r: DealRow, seesMoney: boolean) {
  return {
    id: r.id,
    state: r.state,
    vendor: r.vendor_id
      ? { id: r.vendor_id, name: r.vendor_name ?? '', categoryId: r.vendor_category, city: r.vendor_city }
      : null,
    externalName: r.external_name,
    externalPhone: r.external_phone,
    ...(seesMoney
      ? { price: r.price === null ? null : { amount: Number(r.price), currency: r.currency } }
      : {}),
    negotiatingUntil: r.negotiating_until?.toISOString() ?? null,
    bookedAt: r.booked_at?.toISOString() ?? null,
    doneAt: r.done_at?.toISOString() ?? null,
    cancelledAt: r.cancelled_at?.toISOString() ?? null,
  }
}

export interface SlotRow extends Partial<DealRow> {
  slot_id: string
  category_id: string
  label: string
  sort: number
  deal_id: string | null
}

export function toSlot(r: SlotRow, seesMoney: boolean) {
  const deal = r.deal_id && r.state ? toDeal(r as DealRow, seesMoney) : null
  return {
    id: r.slot_id,
    categoryId: r.category_id,
    label: r.label,
    deal,
    tileState: tileState(deal ? (r.state as DealState) : null),
  }
}

/**
 * Истёкшая мягкая бронь возвращает сделку в `candidate`.
 *
 * По плану это фоновая задача (раздел 5, этап 7). Пока её нет, тот же самый
 * UPDATE выполняется перед чтением: иначе пара видит «бронь держится», хотя
 * 72 часа прошли, и подрядчик уже свободен для других. Условие в WHERE делает
 * повтор пустым, поэтому фоновая задача потом просто добавит расписание.
 */
export async function expireHolds(db: Queryable, weddingId: string): Promise<void> {
  const { rows } = await db.query<{ id: string; state: DealState }>(
    `update deals set state = 'candidate', negotiating_until = null
      where wedding_id = $1 and state = 'negotiating' and negotiating_until <= now()
      returning id, state`,
    [weddingId],
  )
  for (const row of rows) {
    await db.query(
      `insert into deal_events (id, deal_id, from_state, to_state, note)
       values ($1, $2, 'negotiating', 'candidate', 'истёк срок мягкой брони')`,
      [uuidv7(), row.id],
    )
  }
}

export async function loadSlots(db: Db, weddingId: string, seesMoney: boolean) {
  await expireHolds(db, weddingId)
  const { rows } = await db.query<SlotRow>(
    `select s.id as slot_id, s.category_id, s.label, s.sort, s.deal_id, ${DEAL_COLUMNS}
       from slots s
       left join deals d on d.id = s.deal_id
       ${DEAL_JOINS}
      where s.wedding_id = $1
      order by s.sort`,
    [weddingId],
  )
  return rows.map((r) => toSlot(r, seesMoney))
}

export async function loadSlot(db: Queryable, slotId: string, seesMoney: boolean) {
  const { rows } = await db.query<SlotRow>(
    `select s.id as slot_id, s.category_id, s.label, s.sort, s.deal_id, ${DEAL_COLUMNS}
       from slots s
       left join deals d on d.id = s.deal_id
       ${DEAL_JOINS}
      where s.id = $1`,
    [slotId],
  )
  return rows[0] ? toSlot(rows[0], seesMoney) : null
}

export function holdUntil(): string {
  return `${HOLD_HOURS} hours`
}
