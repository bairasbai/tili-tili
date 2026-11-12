import { api, url } from './client'
import type { components } from './schema'

type Schemas = components['schemas']
export type WeddingItem = Schemas['WeddingItem']
export type WeddingItemKit = Schemas['WeddingItemKit']
export type WeddingItemList = Schemas['WeddingItemList']
export type WeddingItemWrite = Schemas['WeddingItemWrite']

export const getItemSets = (weddingId: string) => api.get(url('/weddings/{weddingId}/item-sets', { weddingId }))
export const putWeddingItem = (weddingId: string, itemId: string, body: WeddingItemWrite, assertCurrent: () => void) =>
  api.put(url('/weddings/{weddingId}/item-sets/{itemId}', { weddingId, itemId }), body, { assertCurrent })
export const getItemHistory = (weddingId: string, itemId: string) =>
  api.get(url('/weddings/{weddingId}/item-sets/{itemId}/history', { weddingId, itemId }))
