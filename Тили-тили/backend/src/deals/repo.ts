import type { OfferComparisonTerms } from '../offers/comparison-terms.js'
import type { Db, Queryable } from '../plugins/db.js'
import { HOLD_HOURS, tileState, type DealState } from './state.js'
import { assertLegacyDateBookingAllowed } from '../resources/booking-boundary.js'
import { finishNewDayCommitment } from './day-scope-write.js'
import { conflict } from '../errors.js'

export interface DealRow {
  id: string
  state: DealState
  vendor_id: string | null
  vendor_name: string | null
  vendor_category: string | null
  vendor_city: string | null
  external_name: string | null
  external_phone: string | null
  /** Название пакета в момент брони; пусто — сделка была без пакета. */
  package_name: string | null
  package_includes?: string[] | null
  offer_comparison_terms_snapshot?: OfferComparisonTerms | null
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
  coalesce(d.package_title_snapshot, pkg.name) as package_name,
  coalesce(d.package_includes_snapshot, pkg.items) as package_includes,
  d.offer_comparison_terms_snapshot`

/* Новая сделка читает неизменяемый снимок; `left join` остаётся только
 * fallback для старой строки без снимка. Миграция 019 заполняет все живые
 * ссылки, но потерянные до неё пакеты восстановить достоверно нельзя. */
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
    ...(seesMoney
      ? {
          // Negotiated titles/includes may themselves contain a price.
          packageName: r.package_name,
          packageIncludes: r.package_includes ?? null,
          comparisonTerms: r.offer_comparison_terms_snapshot ?? null,
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

export interface SlotProgramEvent {
  id: string
  name: string
  kind: 'registration' | 'nikah' | 'ceremony' | 'banquet' | 'second_day' | 'other'
  date: string | null
  timeZone: string | null
  location: string | null
  isMain: boolean
}

export interface SlotRow extends Partial<DealRow> {
  slot_id: string
  category_id: string
  label: string
  sort: number
  deal_id: string | null
  /** «Уже забронировано вне приложения» из квиза (фича 018). */
  prebooked: boolean
  program_event_id?: string | null
  program_event?: SlotProgramEvent | null
}

/**
 * Колонки слота для `toSlot` — одна строка на три выборки (мозаика, один слот,
 * кабинет своего подрядчика). Ждёт псевдоним `s` у строки `slots`. Отметка
 * `prebooked` — вычисляемая: три копии списка колонок разошлись бы на первом
 * же новом поле, и ответ одной из дверей молча потерял бы его.
 */
export const SLOT_COLUMNS = `s.id as slot_id, s.category_id, s.label, s.sort, s.deal_id,
  (s.prebooked_at is not null) as prebooked, s.program_event_id,
  (select jsonb_build_object('id', e.id, 'name', e.name, 'kind', e.kind,
    'date', e.date::text, 'timeZone', e.time_zone, 'location', e.location, 'isMain', e.is_main)
   from wedding_events e where e.wedding_id = s.wedding_id and e.id = s.program_event_id) as program_event`

export function toSlot(r: SlotRow, seesMoney: boolean, seesProgramEvent = true) {
  const deal = r.deal_id && r.state ? toDeal(r as DealRow, seesMoney) : null
  return {
    id: r.slot_id,
    categoryId: r.category_id,
    label: r.label,
    // Only an explicit slot link supplies event context; legacy main stays implicit.
    ...(seesProgramEvent && r.program_event_id != null ? { programEvent: r.program_event ?? null } : {}),
    deal,
    tileState: tileState(deal ? (r.state as DealState) : null),
    /* Отметка живёт только у слота без сделки (CHECK миграции 1761300000000): плитка
       остаётся производной от сделки — `empty`, а счётчики готовности считают слот
       забронированным (фича 018). */
    prebooked: r.prebooked,
  }
}

/**
 * Истёкшая мягкая бронь возвращает сделку в `candidate`.
 *
 * Основной путь — ленивый: тот же UPDATE выполняется перед чтением, иначе
 * пара видит «бронь держится», хотя 72 часа прошли, и подрядчик уже свободен
 * для других. Ежечасная задача (`jobs/index.ts`, `expireStaleHolds`) — страховка
 * для сделок, которые никто не открывает; условие в WHERE делает повтор пустым.
 *
 * Снятие брони и запись в журнал сделки — ОДИН запрос (CTE), а не два: сюда
 * приходят и из транзакции, и с голого пула (`loadSlots`, бюджет, подарки),
 * и обрыв между «сняли» и «записали» оставлял сделку без истории — событие,
 * по которому `announceDealEvents` сообщает подрядчику о снятой брони, не
 * появлялось никогда (фича 014, D2-20). Идентификатор события — от базы:
 * событий может быть несколько, а один запрос — один набор параметров.
 */
export async function expireHolds(db: Queryable, weddingId: string): Promise<void> {
  await db.query(
    `with expired as (
       update deals set state = 'candidate', negotiating_until = null
        where wedding_id = $1 and state = 'negotiating' and negotiating_until <= now()
        returning id)
     insert into deal_events (id, deal_id, from_state, to_state, note)
     select gen_random_uuid(), id, 'negotiating', 'candidate', 'истёк срок мягкой брони' from expired`,
    [weddingId],
  )
}

export async function loadSlots(db: Db, weddingId: string, seesMoney: boolean) {
  await expireHolds(db, weddingId)
  const { rows } = await db.query<SlotRow>(
    `select ${SLOT_COLUMNS}, ${DEAL_COLUMNS}
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
    `select ${SLOT_COLUMNS}, ${DEAL_COLUMNS}
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
  await assertLegacyDateBookingAllowed(client, vendorId)
  const root = (await client.query<{ vendor_id: string | null; date: string | null }>(`select d.vendor_id,w.date::text
    from deals d join weddings w on w.id=d.wedding_id where d.id=$1 and d.wedding_id=$2`, [dealId, weddingId])).rows[0]
  if (!root || root.vendor_id !== vendorId || root.date !== date) throw conflict('day_scope_changed', 'Область брони изменилась — обновите данные')
  await finishNewDayCommitment(client, weddingId, dealId, 'legacy_unknown')
}

/**
 * Маршруты для гостей отпускают отменённую сделку с перевозчиком.
 *
 * Отмена не удаляет строку `deals` (только `state`), и `ON DELETE SET NULL`
 * у `bus_routes.deal_id` сам по себе не срабатывает: без этого шага колонка
 * держала бы указатель на убранного перевозчика, а API прятал бы его лишь на
 * чтении. Маршрут и записи гостей остаются — отмена автобуса не высаживает
 * сорок человек (фича 006). Зовётся из `cancelDeal` — единственной двери
 * отмены сделки (F1, ERR-0242).
 */
export async function detachBusRoutes(client: Queryable, dealId: string): Promise<void> {
  await client.query('update bus_routes set deal_id = null where deal_id = $1', [dealId])
}
