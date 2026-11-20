import { api, url } from './client'
import type { components } from './schema'

export type LodgingRoomWrite = components['schemas']['LodgingRoomWrite']
export type LodgingPlacementWrite = components['schemas']['LodgingPlacementWrite']
export type LodgingSource = components['schemas']['LodgingSource']

export const getLodging = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/logistics/lodging', { weddingId }))

const roomPath = (weddingId: string, id: string) =>
  url('/weddings/{weddingId}/logistics/lodging/rooms/{id}', { weddingId, id })

const placementPath = (weddingId: string, id: string) =>
  url('/weddings/{weddingId}/logistics/lodging/placements/{id}', { weddingId, id })

export const putLodgingRoom = (weddingId: string, id: string, room: LodgingRoomWrite) =>
  api.put(roomPath(weddingId, id), room)

export const putLodgingPlacement = (weddingId: string, id: string, placement: LodgingPlacementWrite) =>
  api.put(placementPath(weddingId, id), placement)

export function deleteLodgingRoom(weddingId: string, id: string, version: number) {
  const path = roomPath(weddingId, id)
  return api.delete(`${path}?version=${version}` as typeof path)
}

export function deleteLodgingPlacement(weddingId: string, id: string, version: number) {
  const path = placementPath(weddingId, id)
  return api.delete(`${path}?version=${version}` as typeof path)
}
