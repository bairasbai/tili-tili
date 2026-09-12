import type { Db, Queryable } from '../plugins/db.js'
import { AppError } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { COMMITTED, HOLD_HOURS, tileState, type DealState } from './state.js'

export interface DealRow {
  id: string
  state: DealState
  vendor_id: string | null
  vendor_name: string | null
  vendor_category: string | null
  vendor_city: string | null
  external_name: string | null
  external_phone: string | null
  /** Название пакета, по которому бронировали; пусто — без пакета или пакет снят с витрины. */
  package_name: string | null
  price: string | null
  currency: string
  negotiating_until: Date | null
  booked_at: Date | null
  done_at: Date | null
  cancelled_at: Date | null
  paid: string | null
  paid_at: Date | null
}

/*
 * Оплаченное считается на лету, а не хранится в сделке: сохранённая сумма
 * расходится с платежами на первой же правке (§3.1, ERR-0012).
 *
 * Возврат вычитается, отменённый платёж не считается вовсе: «оплачено»
 * должно означать «деньги у подрядчика», а не «когда-то была запись».
 *
 * Ждёт псевдоним `d` у строки `deals`. Экспортируется: кабинет подрядчика
 * считает «ожидается» и «доход» по тем же платежам, а не по цене сделки
 * (D5-08) — одна формула на обе стороны, иначе пара и подрядчик видят
 * разные деньги по одной сделке.
 */
export const PAID_SUM = `(select coalesce(sum(case when p.kind = 'refund' then -p.amount else p.amount end), 0)
                     from payments p where p.deal_id = d.id and p.status <> 'cancelled')`

export const DEAL_COLUMNS = `
  d.id, d.state, d.vendor_id, d.external_name, d.external_phone,
  d.price::text as price, d.currency, d.negotiating_until, d.booked_at, d.done_at, d.cancelled_at,
  ${PAID_SUM}::text as paid,
  (select max(p.created_at) from payments p where p.deal_id = d.id and p.status <> 'cancelled') as paid_at,
  ven.name as vendor_name, ven.category_id as vendor_category, vc.name as vendor_city,
  pkg.name as package_name`

/* Пакет — `left join`, а не подзапрос: `deals.package_id` ссылается на
 * `vendor_packages` с `on delete set null`, и снятый с витрины пакет честно
 * оставляет `null`, а не имя из ниоткуда (фича 005). */
export const DEAL_JOINS = `
  left join vendors ven on ven.id = d.vendor_id
  left join cities vc on vc.id = ven.city_id
  left join vendor_packages pkg on pkg.id = d.package_id`

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
    packageName: r.package_name,
    ...(seesMoney
      ? {
          price: r.price === null ? null : { amount: Number(r.price), currency: r.currency },
          // Оплаченное — те же деньги: кто не видит цену, не видит и платежей.
          paid: { amount: Number(r.paid ?? 0), currency: r.currency },
          paidAt: r.paid_at?.toISOString() ?? null,
        }
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

/**
 * Занять дату подрядчика под сделку.
 *
 * Дата принадлежит паре целиком, а не отдельной сделке: фотограф, который
 * снимает ещё и видео, занимает у них ОДИН день и занимает его один раз.
 * Поэтому конфликт с собственной свадьбой — не отказ, а «уже наша».
 * Конфликт с чужой — 409.
 */
export async function holdVendorDate(
  client: Queryable,
  vendorId: string,
  date: string,
  dealId: string,
  weddingId: string,
): Promise<void> {
  const inserted = await client.query(
    `insert into vendor_busy_dates (vendor_id, date, source, deal_id)
     values ($1, $2::date, 'deal', $3)
     on conflict (vendor_id, date) do nothing`,
    [vendorId, date, dealId],
  )
  if (inserted.rowCount === 1) return

  const { rows } = await client.query<{ mine: boolean }>(
    `select exists (
       select 1 from deals d
        where d.id = b.deal_id and d.wedding_id = $3
     ) as mine
       from vendor_busy_dates b
      where b.vendor_id = $1 and b.date = $2::date`,
    [vendorId, date, weddingId],
  )
  if (!rows[0]?.mine) {
    throw new AppError(409, 'date_taken', 'Эта дата у подрядчика уже занята')
  }
}

/**
 * Маршруты для гостей отпускают отменённую сделку с перевозчиком.
 *
 * Отмена не удаляет строку `deals` (только `state`), и `ON DELETE SET NULL`
 * у `bus_routes.deal_id` сам по себе не срабатывает: без этого шага колонка
 * держала бы указатель на убранного перевозчика, а API прятал бы его лишь на
 * чтении. Маршрут и записи гостей остаются — отмена автобуса не высаживает
 * сорок человек (фича 006). Зовётся из каждой двери отмены (ERR-0242).
 */
export async function detachBusRoutes(client: Queryable, dealId: string): Promise<void> {
  await client.query('update bus_routes set deal_id = null where deal_id = $1', [dealId])
}

/**
 * Освободить дату при отмене сделки.
 *
 * Только если её больше никто не держит: у той же пары мог остаться второй
 * слот с этим же подрядчиком, и снятие занятости отдало бы его чужой свадьбе,
 * хотя он занят.
 */
export async function releaseVendorDate(client: Queryable, dealId: string): Promise<void> {
  /* Строку удерживает другая сделка той же свадьбы у того же подрядчика,
   * если она открыта — или выполнена и ещё не имеет своей строки. Выполненная
   * сделка со своей строкой (день, уже отработанный до переноса) новую дату
   * не держит: иначе отмена единственной открытой брони после переноса
   * оставляла новую дату занятой (ревью фиксов, RF-BE-02). */
  const HOLDER = `
    select d.id from deals d
     where d.id <> $1
       and d.vendor_id = b.vendor_id
       and d.state = any($2)
       and d.wedding_id = (select wedding_id from deals where id = $1)
       and (d.state <> 'done'
            or not exists (select 1 from vendor_busy_dates o where o.deal_id = d.id and o.source = 'deal'))
     order by d.created_at limit 1`
  await client.query(
    `delete from vendor_busy_dates b
      where b.deal_id = $1 and b.source = 'deal'
        and not exists (${HOLDER})`,
    [dealId, COMMITTED],
  )
  // Если строку удержал другой слот той же свадьбы — переписываем ссылку
  // на него, иначе она указывает на отменённую сделку.
  await client.query(
    `update vendor_busy_dates b
        set deal_id = (${HOLDER})
      where b.deal_id = $1 and b.source = 'deal'`,
    [dealId, COMMITTED],
  )
}
