import { api, url } from './client'
import type { paths } from './schema'

/** Элемент ответа short-list по контракту OpenAPI. */
export type ShortlistEntry =
  paths['/weddings/{weddingId}/shortlist/{vendorId}']['put']['responses'][200]['content']['application/json']

/** Кандидаты на место свадьбы. */
export const getShortlist = (weddingId: string, slotId: string, options?: { assertCurrent?: () => void }) =>
  api.get(url('/weddings/{weddingId}/slots/{slotId}/shortlist', { weddingId, slotId }), options)

/**
 * Добавить подрядчика в кандидаты: exactSlotId выбирает конкретную позицию,
 * без него сохраняется прежний выбор позиции категории.
 * `replaceEntryId` атомарно заменяет одну запись в заполненном месте.
 */
export const addShortlistCandidate = (weddingId: string, vendorId: string, replaceEntryId?: string, exactSlotId?: string, options?: { assertCurrent?: () => void }) =>
  api.put(
    url('/weddings/{weddingId}/shortlist/{vendorId}', { weddingId, vendorId }),
    { ...(replaceEntryId ? { replaceEntryId } : {}), ...(exactSlotId !== undefined ? { slotId: exactSlotId } : {}) },
    options,
  )

/** Убрать запись short-list по её стабильному id. */
export const removeShortlistCandidate = (weddingId: string, slotId: string, entryId: string, options?: { assertCurrent?: () => void }) =>
  api.delete(url('/weddings/{weddingId}/slots/{slotId}/shortlist/{entryId}', { weddingId, slotId, entryId }), options)
