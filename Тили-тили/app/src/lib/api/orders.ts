import { api, beginLocalSessionAction, url } from './client'
import type { components } from './schema'
import { safeGet } from '../usePersist'

export type WeddingOrder = components['schemas']['WeddingOrder']
export type OrderCatalog = components['schemas']['OrderCatalog']
export type OrderBriefField = components['schemas']['OrderBriefField']
export type OrderBriefWrite = components['schemas']['OrderBriefWrite']
export type OrderExternalContactWrite = components['schemas']['OrderExternalContactWrite']
export type OrderPartCreate = components['schemas']['OrderPartCreate']
export type OrderPartPatch = components['schemas']['OrderPartPatch']
export type OrderAssignmentCreate = components['schemas']['OrderAssignmentCreate']
export type OrderTermsView = components['schemas']['OrderTermsView']
export type PublishedOrderTerms = components['schemas']['PublishedOrderTerms']
export type ResourcePlanView = components['schemas']['OrderResourcePlanView']
export type ResourcePlanLineInput = components['schemas']['OrderResourcePlanLineInput']
export type ResourcePlanWrite = components['schemas']['OrderResourcePlanWrite']
export type ResourceCommitmentView = components['schemas']['OrderResourceCommitmentView']
export type ResourceCommitmentWrite = components['schemas']['OrderResourceCommitmentWrite']
export type ResourceOrderPreparationWrite = components['schemas']['ResourceOrderPreparationWrite']
export type VendorBookingPolicy = components['schemas']['VendorBookingPolicy']
export type AdditionalSlotCreate = components['schemas']['AdditionalSlotCreate']
export type AdditionalSlotDto = components['schemas']['AdditionalSlotDto']
export type OrderRequestOptions = { assertCurrent?: () => void }

/** A local reader fence, never permission evidence. Close invalidates old callbacks. */
export function beginOrderAction(assertMounted: () => void) {
  const session = beginLocalSessionAction(), wedding = safeGet('tt_wedding_id')
  let closed = false
  return {
    assertCurrent: () => {
      session.assertCurrent(); assertMounted()
      if (closed || safeGet('tt_wedding_id') !== wedding) throw new Error('Order scope changed')
    },
    close: () => { closed = true; session.close() },
  }
}

export const createAdditionalSlot = (weddingId: string, body: AdditionalSlotCreate, key: string, options?: { assertCurrent?: () => void }) =>
  api.post(url('/weddings/{weddingId}/slots/additional', { weddingId }), body, { ...options, idempotencyKey: key })

/** A caller retains the same key when retrying the same operation after a
 * network failure; a new user intention gets a new key. No command here
 * accepts terms, changes payments or claims resource availability. */
export const getOrder = (dealId: string, options?: OrderRequestOptions) => api.get(url('/deals/{dealId}/order', { dealId }), options)
export const getOrderCatalog = (dealId: string, options?: OrderRequestOptions) => api.get(url('/deals/{dealId}/order/catalog', { dealId }), options)
export const patchOrderExternalContact = (dealId: string, body: OrderExternalContactWrite, key: string, options?: OrderRequestOptions) =>
  api.patch(url('/deals/{dealId}/order/external-contact', { dealId }), body, { ...options, idempotencyKey: key })
/** Policy is a way to prepare an order, never proof of free resources. */
export const getVendorBookingPolicy = (vendorId: string, options?: { assertCurrent?: () => void }) => api.get(url('/vendors/{vendorId}/booking-policy', { vendorId }), options)
export const prepareResourceOrder = (weddingId: string, slotId: string, body: ResourceOrderPreparationWrite, key: string, options?: { assertCurrent?: () => void }) =>
  api.post(url('/weddings/{weddingId}/slots/{slotId}/resource-order', { weddingId, slotId }), body, { ...options, idempotencyKey: key })
export const getOrderResourceCommitments = (dealId: string, options?: { assertCurrent?: () => void }) => api.get(url('/deals/{dealId}/order/resource-commitments', { dealId }), options)
export const commitOrderResources = (dealId: string, body: ResourceCommitmentWrite, key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/resource-commitments', { dealId }), body, { ...options, idempotencyKey: key })
export const replaceOrderResources = (dealId: string, body: ResourceCommitmentWrite, key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/resource-commitments/replace', { dealId }), body, { ...options, idempotencyKey: key })
/** Saving records a plan only. Actual availability and reservation are separate operations. */
export const getOrderResourcePlan = (dealId: string, options?: OrderRequestOptions) => api.get(url('/deals/{dealId}/order/resource-plan', { dealId }), options)
export const saveOrderResourcePlan = (dealId: string, body: ResourcePlanWrite, key: string, options?: OrderRequestOptions) =>
  api.patch(url('/deals/{dealId}/order/resource-plan', { dealId }), body, { ...options, idempotencyKey: key })
export const patchOrderBrief = (dealId: string, body: OrderBriefWrite, key: string, options?: OrderRequestOptions) =>
  api.patch(url('/deals/{dealId}/order/brief', { dealId }), body, { ...options, idempotencyKey: key })
export const createOrderPart = (dealId: string, body: OrderPartCreate, key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/parts', { dealId }), body, { ...options, idempotencyKey: key })
export const patchOrderPart = (dealId: string, partId: string, body: OrderPartPatch, key: string, options?: OrderRequestOptions) =>
  api.patch(url('/deals/{dealId}/order/parts/{partId}', { dealId, partId }), body, { ...options, idempotencyKey: key })
export const cancelOrderPart = (dealId: string, partId: string, body: components['schemas']['OrderPartCancel'], key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/parts/{partId}/cancel', { dealId, partId }), body, { ...options, idempotencyKey: key })
export const createOrderAssignment = (dealId: string, body: OrderAssignmentCreate, key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/assignments', { dealId }), body, { ...options, idempotencyKey: key })
export const cancelOrderAssignment = (dealId: string, assignmentId: string, body: components['schemas']['OrderAssignmentCancel'], key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/assignments/{assignmentId}/cancel', { dealId, assignmentId }), body, { ...options, idempotencyKey: key })

/** Read proofs live only in the current reader, never local/offline storage. */
export const getOrderTerms = (dealId: string, termsId?: string, options?: OrderRequestOptions) => {
  const path = url('/deals/{dealId}/order/terms', { dealId })
  return api.get((path + (termsId ? `?termsId=${encodeURIComponent(termsId)}` : '')) as typeof path, options)
}
export const publishOrderTerms = (dealId: string, body: components['schemas']['OrderTermsPublish'], key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/terms/proposals', { dealId }), body, { ...options, idempotencyKey: key })
export const acceptOrderTerms = (dealId: string, termsId: string, body: components['schemas']['OrderTermsAccept'], key: string, options?: OrderRequestOptions) =>
  api.post(url('/deals/{dealId}/order/terms/{termsId}/accept', { dealId, termsId }), body, { ...options, idempotencyKey: key })
