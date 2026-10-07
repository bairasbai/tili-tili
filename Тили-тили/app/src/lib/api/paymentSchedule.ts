import { api, beginLocalSessionAction, url } from './client'
import type { components } from './schema'

type Schema = components['schemas']
async function scoped<T>(action: (assertCurrent: () => void) => Promise<T>): Promise<T> {
  const owner=beginLocalSessionAction()
  try { return await action(owner.assertCurrent) } finally { owner.close() }
}
export type PaymentScheduleData = Schema['PaymentSchedule']
export type PaymentInstallment = Schema['PaymentInstallment']
export type PaymentRecord = Schema['PaymentRecord']
export type PaymentCorrectionWrite = Schema['PaymentCorrectionWrite']
export type PaymentCorrection = Schema['PaymentCorrection']
export type PaymentInstallmentEdit = Schema['PaymentInstallmentEdit']
export type ScheduleFilter = { from?: string; to?: string; includeOverdue?: boolean; includeCancelled?: boolean }
export function getPaymentSchedule(weddingId: string, filter: ScheduleFilter = {}) {
  const path = url('/weddings/{weddingId}/payment-schedule', { weddingId })
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') query.set(key, String(value))
  // Keep the concrete URL branded with its OpenAPI template; response types remain generated.
  return scoped(assertCurrent=>api.get((query.size ? `${path}?${query}` : path) as typeof path,{assertCurrent}))
}
export const createPaymentInstallment = (weddingId: string, body: Schema['PaymentInstallmentCreate'], idempotencyKey: string) =>
  scoped(assertCurrent=>api.post(url('/weddings/{weddingId}/payment-schedule', { weddingId }), body, { idempotencyKey,assertCurrent }))
export const updatePaymentInstallment = (weddingId: string, installmentId: string, body: Schema['PaymentInstallmentPatch'], idempotencyKey: string) =>
  scoped(assertCurrent=>api.patch(url('/weddings/{weddingId}/payment-schedule/{installmentId}', { weddingId, installmentId }), body, { idempotencyKey, assertCurrent }))
export const payInstallment = (weddingId: string, installmentId: string, body: Schema['PaymentInstallmentPay'], idempotencyKey: string) =>
  scoped(assertCurrent=>api.post(url('/weddings/{weddingId}/payment-schedule/{installmentId}/pay', { weddingId, installmentId }), body, { idempotencyKey,assertCurrent }))
export const linkPaymentPlan = (weddingId: string, paymentId: string, body: Schema['PaymentPlanLink'], idempotencyKey: string) =>
  scoped(assertCurrent=>api.patch(url('/weddings/{weddingId}/payments/{paymentId}/plan', { weddingId, paymentId }), body, { idempotencyKey,assertCurrent }))
export const correctPaymentRecord = (weddingId: string, paymentId: string, body: PaymentCorrectionWrite, idempotencyKey: string) =>
  scoped(assertCurrent=>api.patch(url('/weddings/{weddingId}/payments/{paymentId}', { weddingId, paymentId }), body, { idempotencyKey, assertCurrent }))
export function getPaymentCorrectionHistory(weddingId: string, paymentId: string, cursor?: string) {
  const path = url('/weddings/{weddingId}/payments/{paymentId}/history', { weddingId, paymentId })
  return scoped(assertCurrent=>api.get((cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path) as typeof path, { assertCurrent }))
}
export function getInstallmentEditHistory(weddingId: string, installmentId: string, cursor?: string) {
  const path = url('/weddings/{weddingId}/payment-schedule/{installmentId}/history', { weddingId, installmentId })
  return scoped(assertCurrent=>api.get((cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path) as typeof path, { assertCurrent }))
}
export const exportPaymentHistory = (weddingId: string) => scoped(assertCurrent=>api.get(url('/weddings/{weddingId}/payment-schedule/export', { weddingId }),{assertCurrent}))

export const listPaymentReceipts = (weddingId: string, paymentId: string) =>
  scoped(assertCurrent=>api.get(url('/weddings/{weddingId}/payments/{paymentId}/receipts', { weddingId, paymentId }),{assertCurrent}))
export const addPaymentReceipt = (weddingId: string, paymentId: string, body: { filename: string; mimeType: 'application/pdf'|'image/jpeg'|'image/png'|'image/webp'; contentBase64: string }, idempotencyKey: string, timeoutMs?: number) =>
  scoped(assertCurrent=>api.post(url('/weddings/{weddingId}/payments/{paymentId}/receipts', { weddingId, paymentId }), body, { idempotencyKey, assertCurrent, ...(timeoutMs ? { timeoutMs } : {}) }))
export const getPaymentReceipt = (weddingId: string, paymentId: string, receiptId: string) =>
  scoped(assertCurrent=>api.get(url('/weddings/{weddingId}/payments/{paymentId}/receipts/{receiptId}/content', { weddingId, paymentId, receiptId }),{assertCurrent}))
export const deletePaymentReceipt = (weddingId: string, paymentId: string, receiptId: string) =>
  scoped(assertCurrent=>api.delete(url('/weddings/{weddingId}/payments/{paymentId}/receipts/{receiptId}', { weddingId, paymentId, receiptId }),{assertCurrent}))
