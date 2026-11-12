import { api, url } from './client'
import type { components } from './schema'

type Schemas = components['schemas']
export type Purchase = Schemas['WeddingPurchase']
export type PurchaseWrite = Schemas['WeddingPurchaseWrite']
export type PurchaseList = Schemas['WeddingPurchaseList']
export type PurchaseStatus = Schemas['WeddingPurchaseStatus']
const path = '/weddings/{weddingId}/purchases'

export const getPurchases = (weddingId: string) => api.get(url(path, { weddingId }))
export const putPurchase = (weddingId: string, purchaseId: string, body: PurchaseWrite, assertCurrent: () => void) =>
  api.put(url('/weddings/{weddingId}/purchases/{purchaseId}', { weddingId, purchaseId }), body, { assertCurrent })
export const getPurchaseHistory = (weddingId: string, purchaseId: string) =>
  api.get(url('/weddings/{weddingId}/purchases/{purchaseId}/history', { weddingId, purchaseId }))
