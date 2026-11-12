import { api, url } from './client'
import type { components } from './schema'

export type ShuttleChange = components['schemas']['ShuttleChange']
export type ShuttleDecision = 'approved' | 'declined'

export const giveUpShuttleSeat = (guestToken: string, busId: string, guestId: string) =>
  api.delete(url('/join/{guestToken}/shuttle/seats/{busId}/{guestId}', { guestToken, busId, guestId }))

export const requestShuttleChange = (guestToken: string, requestId: string, body: { guestId: string; fromBusId: string; toBusId: string }) =>
  api.put(url('/join/{guestToken}/shuttle/requests/{requestId}', { guestToken, requestId }), body)

export const getShuttleRequests = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/logistics/shuttle-requests', { weddingId }))

export const resolveShuttleRequest = (weddingId: string, requestId: string, decision: ShuttleDecision) =>
  api.put(url('/weddings/{weddingId}/logistics/shuttle-requests/{requestId}', { weddingId, requestId }), { decision })
