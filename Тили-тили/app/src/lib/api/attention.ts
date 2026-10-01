import { api, url } from './client'
import type { components } from './schema'

export type WeddingAttention = components['schemas']['WeddingAttention']
export type AttentionMode = WeddingAttention['mode']
export const getAttention = (weddingId: string) => api.getSnapshot(url('/weddings/{weddingId}/attention', { weddingId }))
export const patchAttention = (weddingId: string, version: string, patch: { mode?: AttentionMode; coordinatorUserId?: string | null }) =>
  api.patch(url('/weddings/{weddingId}/attention', { weddingId }), patch, { ifMatch: `"${version}"` })
