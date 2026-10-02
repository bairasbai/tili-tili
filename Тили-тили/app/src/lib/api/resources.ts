import { api, url } from './client'
import type { components } from './schema'

export type VendorResource = components['schemas']['VendorResource']
export type VendorResourceCreate = components['schemas']['VendorResourceCreate']
export type ResourceCapacityWindow = components['schemas']['ResourceCapacityWindow']
export type VendorAvailabilityPolicy = components['schemas']['VendorAvailabilityPolicy']
export type VendorResourceOptions = components['schemas']['VendorResourceOptions']
export const getVendorResources = (vendorId: string) => api.get(url('/vendors/{vendorId}/resources', { vendorId }))
export const getVendorResourceOptions = (vendorId: string) => api.get(url('/vendors/{vendorId}/resource-options', { vendorId }))
export const getVendorAvailabilityPolicy = (vendorId: string) => api.get(url('/vendors/{vendorId}/availability-policy', { vendorId }))
// Keys belong to a specific user intention; retain the same body/key after
// uncertain delivery, never silently retry a changed operation as the old one.
export const createVendorResource = (vendorId: string, body: VendorResourceCreate, key: string) =>
  api.post(url('/vendors/{vendorId}/resources', { vendorId }), body, { idempotencyKey: key })
export const retireVendorResource = (vendorId: string, resourceId: string, expectedVersion: string, key: string) =>
  api.post(url('/vendors/{vendorId}/resources/{resourceId}/retire', { vendorId, resourceId }), { expectedVersion }, { idempotencyKey: key })
export const createResourceCapacityWindow = (vendorId: string, resourceId: string, body: components['schemas']['ResourceCapacityWindowCreate'], key: string) =>
  api.post(url('/vendors/{vendorId}/resources/{resourceId}/windows', { vendorId, resourceId }), body, { idempotencyKey: key })
export const patchResourceCapacityWindow = (vendorId: string, resourceId: string, windowId: string, body: components['schemas']['ResourceCapacityWindowPatch'], key: string) =>
  api.patch(url('/vendors/{vendorId}/resources/{resourceId}/windows/{windowId}', { vendorId, resourceId, windowId }), body, { idempotencyKey: key })
export const patchVendorAvailabilityPolicy = (vendorId: string, body: components['schemas']['VendorAvailabilityPolicyWrite'], key: string) =>
  api.patch(url('/vendors/{vendorId}/availability-policy', { vendorId }), body, { idempotencyKey: key })
