import { api, ApiError, url } from './client'
import type { components, paths } from './schema'

export type WeddingEvent = components['schemas']['WeddingEvent']
export type EventInvitationRoster = components['schemas']['EventInvitationRoster']
export type GuestInvitedEvent = components['schemas']['GuestInvitedEvent']
export type CreateWeddingEvent = paths['/weddings/{weddingId}/events']['post']['requestBody']['content']['application/json']
export type PatchWeddingEvent = paths['/weddings/{weddingId}/events/{eventId}']['patch']['requestBody']['content']['application/json']

export const createWeddingEvent = (weddingId: string, body: CreateWeddingEvent, version: string) =>
  api.post(url('/weddings/{weddingId}/events', { weddingId }), body, { ifMatch: version })

export const patchWeddingEvent = (weddingId: string, eventId: string, body: PatchWeddingEvent, version: string) =>
  api.patch(url('/weddings/{weddingId}/events/{eventId}', { weddingId, eventId }), body, { ifMatch: version })

export const deleteWeddingEvent = (weddingId: string, eventId: string, version: string) =>
  api.delete(url('/weddings/{weddingId}/events/{eventId}', { weddingId, eventId }), { ifMatch: version })

function assertRoster(data: EventInvitationRoster, eventId: string): void {
  const event = data?.event
  if (!event || event.id !== eventId || typeof event.name !== 'string' || typeof event.isMain !== 'boolean'
    || !Array.isArray(data.people) || data.people.some(p => !p || typeof p.guestId !== 'string' || typeof p.name !== 'string' || typeof p.invited !== 'boolean')
    || new Set(data.people.map(p => p.guestId)).size !== data.people.length) {
    throw new ApiError('http', 200, 'invalid_response', 'Состав приглашённых не подтверждён сервером')
  }
}

export const getEventInvitations = async (weddingId: string, eventId: string) => {
  const snapshot = await api.getSnapshot(url('/weddings/{weddingId}/events/{eventId}/invitations', { weddingId, eventId }))
  assertRoster(snapshot.data, eventId)
  return snapshot
}

export const replaceEventInvitations = async (weddingId: string, eventId: string, guestIds: string[], version: string) => {
  const accepted = await api.put(url('/weddings/{weddingId}/events/{eventId}/invitations', { weddingId, eventId }), { guestIds }, { ifMatch: version })
  assertRoster(accepted, eventId)
  return accepted
}
