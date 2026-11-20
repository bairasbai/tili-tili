import { api, url } from './client'
import type { components } from './schema'

type Schemas = components['schemas']
type Origin = { assertCurrent: () => void }
export type CoupleDecision = Schemas['CoupleDecision']
export type CoupleDecisionCreate = Schemas['CoupleDecisionCreate']

export const getCoupleDecisions = (weddingId: string, origin: Origin) =>
  api.get(url('/weddings/{weddingId}/decisions', { weddingId }), origin)

export const createCoupleDecision = (weddingId: string, body: CoupleDecisionCreate, origin: Origin) =>
  api.post(url('/weddings/{weddingId}/decisions', { weddingId }), body, origin)

export const proposeCoupleDecision = (weddingId: string, decisionId: string, body: Schemas['CoupleDecisionProposalWrite'], origin: Origin) =>
  api.put(url('/weddings/{weddingId}/decisions/{decisionId}/proposal', { weddingId, decisionId }), body, origin)

export const respondCoupleDecision = (weddingId: string, decisionId: string, body: Schemas['CoupleDecisionResponseWrite'], origin: Origin) =>
  api.put(url('/weddings/{weddingId}/decisions/{decisionId}/response', { weddingId, decisionId }), body, origin)
