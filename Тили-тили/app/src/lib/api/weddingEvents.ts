import { api, url } from './client'
import type { components, paths } from './schema'

export type WeddingEvent = components['schemas']['WeddingEvent']
export type CreateWeddingEvent = paths['/weddings/{weddingId}/events']['post']['requestBody']['content']['application/json']
export type PatchWeddingEvent = paths['/weddings/{weddingId}/events/{eventId}']['patch']['requestBody']['content']['application/json']

export const createWeddingEvent = (weddingId: string, body: CreateWeddingEvent, version: string) =>
  api.post(url('/weddings/{weddingId}/events', { weddingId }), body, { ifMatch: version })

export const patchWeddingEvent = (weddingId: string, eventId: string, body: PatchWeddingEvent, version: string) =>
  api.patch(url('/weddings/{weddingId}/events/{eventId}', { weddingId, eventId }), body, { ifMatch: version })

export const deleteWeddingEvent = (weddingId: string, eventId: string, version: string) =>
  api.delete(url('/weddings/{weddingId}/events/{eventId}', { weddingId, eventId }), { ifMatch: version })
