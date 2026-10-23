import { api, url } from './client'
import type { components } from './schema'

export type EventMoveProposal = components['schemas']['EventMoveProposal']
export type EventMoveRootView = components['schemas']['EventMoveRootView']
export type EventMoveTarget = components['schemas']['EventMoveTarget']
type Current = { assertCurrent?: () => void }
export const getEventMoveProposals = (weddingId: string, eventId: string, options?: Current) =>
  api.get(url('/weddings/{weddingId}/events/{eventId}/move-proposals', { weddingId, eventId }), options)
export const proposeEventMove = (weddingId: string, eventId: string, body: EventMoveTarget, version: string, idempotencyKey: string, options?: Current) =>
  api.post(url('/weddings/{weddingId}/events/{eventId}/move-proposals', { weddingId, eventId }), body, { ...options, ifMatch: version, idempotencyKey })
export const applyEventMove = (weddingId: string, eventId: string, proposalId: string, digest: string, idempotencyKey: string, options?: Current) =>
  api.post(url('/weddings/{weddingId}/events/{eventId}/move-proposals/{proposalId}/apply', { weddingId, eventId, proposalId }), { digest }, { ...options, idempotencyKey })
export const cancelEventMove = (weddingId: string, eventId: string, proposalId: string, digest: string, idempotencyKey: string, options?: Current) =>
  api.post(url('/weddings/{weddingId}/events/{eventId}/move-proposals/{proposalId}/cancel', { weddingId, eventId, proposalId }), { digest }, { ...options, idempotencyKey })
export const getDealEventMoves = (dealId: string, options?: Current) => api.get(url('/deals/{dealId}/event-moves', { dealId }), options)
export const getRootEventMove = (dealId: string, proposalId: string, options?: Current) => api.get(url('/deals/{dealId}/event-moves/{proposalId}', { dealId, proposalId }), options)
export const acceptRootEventMove = (dealId: string, proposalId: string, digest: string, readToken: string, idempotencyKey: string, options?: Current) =>
  api.post(url('/deals/{dealId}/event-moves/{proposalId}/accept', { dealId, proposalId }), { digest, readToken }, { ...options, idempotencyKey })
