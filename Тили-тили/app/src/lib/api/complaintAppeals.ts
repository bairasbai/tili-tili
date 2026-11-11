import { api, url, type EventWriteOptions } from './client'
import type { components } from './schema'

type Scope = Pick<EventWriteOptions, 'assertCurrent'>
export type AppealCommand = components['schemas']['ComplaintAppealCommand']
export type OriginalDecision = components['schemas']['ComplaintAppealOriginal']
export type ComplaintAppeal = components['schemas']['ComplaintAppeal']

const own = '/complaints/{complaintId}/appeal'
const affected = '/moderation/decisions'
const staff = '/admin/complaint-appeals'
const staffDetail = '/admin/complaint-appeals/{appealId}'
const page = <P extends typeof affected | typeof staff>(path: P, cursor: string | null) =>
  cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` as P : path

export const getOwnAppeal = (complaintId: string, scope: Scope) => api.get(url(own, { complaintId }), scope)
export const submitAppeal = (complaintId: string, message: string, scope: Scope) => api.post(url(own, { complaintId }), { message }, scope)
export const getAffectedDecisions = (cursor: string | null, scope: Scope) => api.get(page(affected, cursor), scope)
export const getStaffAppeals = (cursor: string | null, scope: Scope) => api.get(page(staff, cursor), scope)
export const getStaffAppeal = (appealId: string, scope: Scope) => api.get(url(staffDetail, { appealId }), scope)
export const commandAppeal = (appealId: string, command: AppealCommand, scope: Scope) =>
  api.post(url(staffDetail, { appealId }), command, scope)
