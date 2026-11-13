import { api, url } from './client'
import type { components } from './schema'

type Schemas = components['schemas']
type Options = { assertCurrent: () => void }
export type VendorStaffMember = Schemas['VendorStaffMember']
export type VendorStaffInvitation = Schemas['VendorStaffInvitation']
export type VendorStaffRole = Schemas['VendorStaffRole']
export type VendorStaffDutyRole = Schemas['VendorStaffDutyRole']

export const getVendorStaff = (vendorId: string, options: Options) =>
  api.get(url('/vendor/companies/{vendorId}/staff', { vendorId }), options)
export const inviteVendorStaff = (vendorId: string, body: Schemas['VendorStaffInviteInput'], options: Options) =>
  api.post(url('/vendor/companies/{vendorId}/staff', { vendorId }), body, options)
export const updateVendorStaffRole = (member: VendorStaffMember, role: VendorStaffRole, options: Options) =>
  api.put(url('/vendor/companies/{vendorId}/staff/{memberId}/role', { vendorId: member.vendorId, memberId: member.id }),
    { role, expectedVersion: member.version }, options)
export const revokeVendorStaff = (member: VendorStaffMember, options: Options) =>
  api.post(url('/vendor/companies/{vendorId}/staff/{memberId}/revoke', { vendorId: member.vendorId, memberId: member.id }),
    { expectedVersion: member.version }, options)
export const answerVendorStaffInvitation = (token: string, accept: boolean, options: Options) =>
  accept ? api.post('/users/me/vendor-staff/invitations/accept', { token }, options) :
    api.post('/users/me/vendor-staff/invitations/decline', { token }, options)
export const getOwnStaffDuties = (after: string | null, options: Options) => {
  const path = '/users/me/vendor-staff/duties'
  return api.get((path + (after ? '?after=' + encodeURIComponent(after) : '')) as typeof path, options)
}
export const getOrderStaffDuties = (dealId: string, options: Options) =>
  api.get(url('/vendor/deals/{dealId}/staff-duties', { dealId }), options)
export const createOrderStaffDuty = (dealId: string, body: Schemas['VendorStaffDutyInput'], options: Options) =>
  api.post(url('/vendor/deals/{dealId}/staff-duties', { dealId }), body, options)
export const revokeOrderStaffDuty = (duty: Schemas['VendorStaffDuty'], options: Options) =>
  api.post(url('/vendor/deals/{dealId}/staff-duties/{dutyId}/revoke', { dealId: duty.dealId, dutyId: duty.id }),
    { expectedVersion: duty.version }, options)
export const reassignOrderStaffDuty = (duty: Schemas['VendorStaffDuty'], memberId: string, options: Options) =>
  api.post(url('/vendor/deals/{dealId}/staff-duties/{dutyId}/reassign', { dealId: duty.dealId, dutyId: duty.id }),
    { memberId, expectedVersion: duty.version }, options)
