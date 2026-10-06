import { ApiError } from './client'
import { getSlots } from './weddingData'
import { getOrderCatalog, getOrderTerms } from './orders'
import { isActiveOrderState, orderTermsTargets, summarizeOrderTerms, type TermsSummary, type TermsTarget } from '../weeklyOrderTerms'

export type CheckedOrderTerms = TermsTarget & { summary: TermsSummary | null; failure: unknown }
export const TERMS_READ_CONCURRENCY = 3

/** Explicit snapshot only. The caller cancels queued work when its reader ends. */
export async function readWeeklyOrderTerms(weddingId: string, assertCurrent: () => void): Promise<CheckedOrderTerms[]> {
  assertCurrent()
  const slots = await getSlots(weddingId)
  assertCurrent()
  const targets = orderTermsTargets(slots)
  const result: CheckedOrderTerms[] = new Array(targets.length)
  let next = 0
  async function worker() {
    while (next < targets.length) {
      assertCurrent()
      const index = next++, target = targets[index]
      try {
        const catalog = await getOrderCatalog(target.dealId)
        assertCurrent()
        // A caller may belong to multiple weddings or also own a vendor account.
        // Bind this reader to the selected wedding, not merely an accessible deal ID.
        if (!catalog || catalog.weddingId?.toLowerCase() !== weddingId.toLowerCase() || catalog.actorRole !== 'couple') {
          throw new ApiError('http', 403, 'order_access_changed', 'Доступ к заказу изменился. Откройте раздел заново.')
        }
        // Slots and catalog are separate snapshots. Historical terms remain readable
        // after closing a deal, but must not be presented as an active-order check.
        if (!isActiveOrderState(catalog.dealState)) {
          const message = catalog.dealState === 'done' ? 'Заказ завершён — обновите список активных заказов.'
            : catalog.dealState === 'cancelled' ? 'Заказ отменён — обновите список активных заказов.'
              : 'Состояние заказа не подтверждено — обновите проверку.'
          throw new ApiError('http', 409, 'order_state_changed', message)
        }
        const terms = await getOrderTerms(target.dealId)
        assertCurrent()
        result[index] = { ...target, summary: summarizeOrderTerms(terms), failure: null }
      } catch (failure) {
        assertCurrent()
        result[index] = { ...target, summary: null, failure }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(TERMS_READ_CONCURRENCY, targets.length) }, worker))
  assertCurrent()
  return result
}
