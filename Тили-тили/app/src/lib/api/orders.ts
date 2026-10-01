import { api, url } from './client'
import type { components } from './schema'

export type WeddingOrder = components['schemas']['WeddingOrder']
export type OrderCatalog = components['schemas']['OrderCatalog']
export type OrderBriefField = components['schemas']['OrderBriefField']
export type OrderBriefWrite = components['schemas']['OrderBriefWrite']
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

/** A caller retains the same key when retrying the same operation after a
 * network failure; a new user intention gets a new key. No command here
 * accepts terms, changes payments or claims resource availability. */
export const getOrder = (dealId: string) => api.get(url('/deals/{dealId}/order', { dealId }))
export const getOrderCatalog = (dealId: string) => api.get(url('/deals/{dealId}/order/catalog', { dealId }))
/** Policy is a way to prepare an order, never proof of free resources. */
export const getVendorBookingPolicy = (vendorId: string) => api.get(url('/vendors/{vendorId}/booking-policy', { vendorId }))
export const prepareResourceOrder = (weddingId: string, slotId: string, body: ResourceOrderPreparationWrite, key: string) =>
  api.post(url('/weddings/{weddingId}/slots/{slotId}/resource-order', { weddingId, slotId }), body, { idempotencyKey: key })
export const getOrderResourceCommitments = (dealId: string) => api.get(url('/deals/{dealId}/order/resource-commitments', { dealId }))
export const commitOrderResources = (dealId: string, body: ResourceCommitmentWrite, key: string) =>
  api.post(url('/deals/{dealId}/order/resource-commitments', { dealId }), body, { idempotencyKey: key })
export const replaceOrderResources = (dealId: string, body: ResourceCommitmentWrite, key: string) =>
  api.post(url('/deals/{dealId}/order/resource-commitments/replace', { dealId }), body, { idempotencyKey: key })
/** Saving records a plan only. Actual availability and reservation are separate operations. */
export const getOrderResourcePlan = (dealId: string) => api.get(url('/deals/{dealId}/order/resource-plan', { dealId }))
export const saveOrderResourcePlan = (dealId: string, body: ResourcePlanWrite, key: string) =>
  api.patch(url('/deals/{dealId}/order/resource-plan', { dealId }), body, { idempotencyKey: key })
export const patchOrderBrief = (dealId: string, body: OrderBriefWrite, key: string) =>
  api.patch(url('/deals/{dealId}/order/brief', { dealId }), body, { idempotencyKey: key })
export const createOrderPart = (dealId: string, body: OrderPartCreate, key: string) =>
  api.post(url('/deals/{dealId}/order/parts', { dealId }), body, { idempotencyKey: key })
export const patchOrderPart = (dealId: string, partId: string, body: OrderPartPatch, key: string) =>
  api.patch(url('/deals/{dealId}/order/parts/{partId}', { dealId, partId }), body, { idempotencyKey: key })
export const cancelOrderPart = (dealId: string, partId: string, body: components['schemas']['OrderPartCancel'], key: string) =>
  api.post(url('/deals/{dealId}/order/parts/{partId}/cancel', { dealId, partId }), body, { idempotencyKey: key })
export const createOrderAssignment = (dealId: string, body: OrderAssignmentCreate, key: string) =>
  api.post(url('/deals/{dealId}/order/assignments', { dealId }), body, { idempotencyKey: key })
export const cancelOrderAssignment = (dealId: string, assignmentId: string, body: components['schemas']['OrderAssignmentCancel'], key: string) =>
  api.post(url('/deals/{dealId}/order/assignments/{assignmentId}/cancel', { dealId, assignmentId }), body, { idempotencyKey: key })

/** Read proofs live only in the current reader, never local/offline storage. */
export const getOrderTerms = (dealId: string, termsId?: string) => {
  const path = url('/deals/{dealId}/order/terms', { dealId })
  return api.get((path + (termsId ? `?termsId=${encodeURIComponent(termsId)}` : '')) as typeof path)
}
export const publishOrderTerms = (dealId: string, body: components['schemas']['OrderTermsPublish'], key: string) =>
  api.post(url('/deals/{dealId}/order/terms/proposals', { dealId }), body, { idempotencyKey: key })
export const acceptOrderTerms = (dealId: string, termsId: string, body: components['schemas']['OrderTermsAccept'], key: string) =>
  api.post(url('/deals/{dealId}/order/terms/{termsId}/accept', { dealId, termsId }), body, { idempotencyKey: key })
