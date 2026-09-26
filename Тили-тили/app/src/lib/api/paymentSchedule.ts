import { api, url } from './client'
import type { components } from './schema'

type Schema = components['schemas']
export type PaymentScheduleData = Schema['PaymentSchedule']
export type PaymentInstallment = Schema['PaymentInstallment']
export type PaymentRecord = Schema['PaymentRecord']
export type ScheduleFilter = { from?: string; to?: string; includeOverdue?: boolean; includeCancelled?: boolean }
export function getPaymentSchedule(weddingId: string, filter: ScheduleFilter = {}) {
  const path = url('/weddings/{weddingId}/payment-schedule', { weddingId })
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') query.set(key, String(value))
  // Keep the concrete URL branded with its OpenAPI template; response types remain generated.
  return api.get((query.size ? `${path}?${query}` : path) as typeof path)
}
export const createPaymentInstallment = (weddingId: string, body: Schema['PaymentInstallmentCreate'], idempotencyKey: string) =>
  api.post(url('/weddings/{weddingId}/payment-schedule', { weddingId }), body, { idempotencyKey })
export const updatePaymentInstallment = (weddingId: string, installmentId: string, body: Schema['PaymentInstallmentPatch'], idempotencyKey: string) =>
  api.patch(url('/weddings/{weddingId}/payment-schedule/{installmentId}', { weddingId, installmentId }), body, { idempotencyKey })
export const payInstallment = (weddingId: string, installmentId: string, body: Schema['PaymentInstallmentPay'], idempotencyKey: string) =>
  api.post(url('/weddings/{weddingId}/payment-schedule/{installmentId}/pay', { weddingId, installmentId }), body, { idempotencyKey })
export const linkPaymentPlan = (weddingId: string, paymentId: string, body: Schema['PaymentPlanLink'], idempotencyKey: string) =>
  api.patch(url('/weddings/{weddingId}/payments/{paymentId}/plan', { weddingId, paymentId }), body, { idempotencyKey })
export const exportPaymentHistory = (weddingId: string) => api.get(url('/weddings/{weddingId}/payment-schedule/export', { weddingId }))
