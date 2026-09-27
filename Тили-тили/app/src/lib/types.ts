/*
 * Типы, которыми экраны описывают то, что приходит с сервера.
 *
 * Раньше они жили в `lib/data.ts` рядом с выдуманными подрядчиками и гостями.
 * Сами моки снесены (этап 11), типы остались: `Slot` — форма строки мозаики,
 * которую собирает `lib/store.tsx` из ответа сервера.
 */

/** Шесть состояний сделки плюс отмена — те же, что в контракте. */
export type DealState = 'candidate' | 'contacted' | 'negotiating' | 'booked' | 'paid_deposit' | 'done' | 'cancelled'

/** Состояние плитки в мозаике команды: производное от сделки, считает сервер. */
export type SlotState = 'empty' | 'candidate' | 'hold' | 'booked'

export interface Slot {
  id: string
  categoryId: string
  label: string
  icon: string
  tile: string
  state: SlotState
  vendor?: string
  vendorId?: string
  /** Цена сделки в копейках. */
  price?: number
  /** Сколько уже внесено: считает сервер по платежам. */
  paid?: number
  paidAt?: string
  status?: string
  external?: boolean
  phone?: string
  dealId?: string
  dealState?: DealState
  /** Название пакета, по которому бронировали; нет — бронь без пакета или пакет снят с витрины. */
  packageName?: string
  packageIncludes?: string[] | null
}
