import { api, beginLocalSessionAction, url } from './client'
import type { components } from './schema'

type Schemas = components['schemas']
export type CalendarSourceKind = Schemas['LegacyCalendarSourceSummary']['kind']
export type CalendarOutcome = Schemas['LegacyCalendarBoundsOutcomeInput']['outcome']
export type CalendarStaffing = Schemas['LegacyCalendarBoundsProposalWrite']['staffing']['completeness']
export type CalendarSpanInput = Schemas['LegacyCalendarBoundsSpanInput']
export type CalendarSpan = Schemas['LegacyCalendarBoundsSpanView']
export type CalendarOutcomeInput = Schemas['LegacyCalendarBoundsOutcomeInput']
export type CalendarHolderInput = Schemas['LegacyCalendarBoundsHolderInput']
export type CalendarProposalInput = Schemas['LegacyCalendarBoundsProposalWrite']
export type CalendarSourceSummary = Schemas['LegacyCalendarSourceSummary']
export type CalendarHolderView = Schemas['LegacyCalendarBoundsHolderView']
export type CalendarProposalView = Schemas['LegacyCalendarBoundsProposalView']
export type CalendarBoundsEditor = Schemas['LegacyCalendarBoundsEditor']
export type CalendarBoundsView = Schemas['LegacyCalendarBoundsPrivate']
export type CalendarSourceList = Schemas['LegacyCalendarSourceList']
export type OwnCalendarSourceList = Schemas['OwnLegacyCalendarSourceList']
export type CalendarAcceptInput = Schemas['LegacyCalendarBoundsAcceptWrite']
export type CalendarActivateInput = Schemas['LegacyCalendarBoundsActivateWrite']
export interface CalendarCurrent { assertCurrent?: () => void }
/** Extra request-local session latch; parent guards also retire equal-body/new-parent renders. */
async function scoped<T>(options: CalendarCurrent | undefined, run: (assertCurrent: () => void) => Promise<T>): Promise<T> {
  const session = beginLocalSessionAction()
  const check = () => { session.assertCurrent(); options?.assertCurrent?.() }
  try { check(); const value = await run(check); check(); return value } finally { session.close() }
}
export const getLegacyCalendarSources = (vendorId: string, options?: CalendarCurrent): Promise<CalendarSourceList> =>
  scoped(options, assertCurrent => api.get(url('/vendors/{vendorId}/legacy-calendar/sources', { vendorId }), { assertCurrent }))
export const getLegacyCalendarEditor = (vendorId: string, sourceId: string, options?: CalendarCurrent): Promise<CalendarBoundsView> =>
  scoped(options, assertCurrent => api.get(url('/vendors/{vendorId}/legacy-calendar/sources/{sourceId}', { vendorId, sourceId }), { assertCurrent }))
export const captureLegacyCalendarInventory = (vendorId: string, sourceId: string, body: { expectedSourceRevision: string; expectedInventoryRevision: string }, idempotencyKey: string, options?: CalendarCurrent): Promise<CalendarBoundsView> =>
  scoped(options, assertCurrent => api.post(url('/vendors/{vendorId}/legacy-calendar/sources/{sourceId}/capture', { vendorId, sourceId }), body, { idempotencyKey, assertCurrent }))
export const proposeLegacyCalendar = (vendorId: string, sourceId: string, body: CalendarProposalInput, idempotencyKey: string, options?: CalendarCurrent): Promise<CalendarBoundsView> =>
  scoped(options, assertCurrent => api.post(url('/vendors/{vendorId}/legacy-calendar/sources/{sourceId}/proposals', { vendorId, sourceId }), body, { idempotencyKey, assertCurrent }))
export const activateOwnerLegacyCalendar = (vendorId: string, sourceId: string, body: CalendarActivateInput, idempotencyKey: string, options?: CalendarCurrent): Promise<CalendarBoundsView> =>
  scoped(options, assertCurrent => api.post(url('/vendors/{vendorId}/legacy-calendar/sources/{sourceId}/activate', { vendorId, sourceId }), body, { idempotencyKey, assertCurrent }))
export const getOwnLegacyCalendarSources = (weddingId: string, dealId: string, options?: CalendarCurrent): Promise<OwnCalendarSourceList> =>
  scoped(options, assertCurrent => api.get(url('/weddings/{weddingId}/deals/{dealId}/legacy-calendar', { weddingId, dealId }), { assertCurrent }))
/** Only call from an explicit deliberate-read action, never an automatic mount fetch. */
export const readOwnLegacyCalendar = (weddingId: string, dealId: string, sourceId: string, options?: CalendarCurrent, boundsVersionId?: string): Promise<CalendarBoundsView> => {
  const path = url('/weddings/{weddingId}/deals/{dealId}/legacy-calendar/{sourceId}', { weddingId, dealId, sourceId })
  return scoped(options, assertCurrent => api.get((path + (boundsVersionId ? `?boundsVersionId=${encodeURIComponent(boundsVersionId)}` : '')) as typeof path, { assertCurrent }))
}
export const acceptOwnLegacyCalendar = (weddingId: string, dealId: string, sourceId: string, body: CalendarAcceptInput, idempotencyKey: string, options?: CalendarCurrent): Promise<CalendarBoundsView> =>
  scoped(options, assertCurrent => api.post(url('/weddings/{weddingId}/deals/{dealId}/legacy-calendar/{sourceId}/accept', { weddingId, dealId, sourceId }), body, { idempotencyKey, assertCurrent }))
export const activateOwnLegacyCalendar = (weddingId: string, dealId: string, sourceId: string, body: CalendarActivateInput, idempotencyKey: string, options?: CalendarCurrent): Promise<CalendarBoundsView> =>
  scoped(options, assertCurrent => api.post(url('/weddings/{weddingId}/deals/{dealId}/legacy-calendar/{sourceId}/activate', { weddingId, dealId, sourceId }), body, { idempotencyKey, assertCurrent }))
