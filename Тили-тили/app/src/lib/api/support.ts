import { api, url, type EventWriteOptions } from './client'
import type { components } from './schema'

export type SupportDraft = components['schemas']['SupportCaseDraft']
export type SupportCommand = components['schemas']['SupportCaseCommand']
export type SupportDetail = components['schemas']['SupportCaseDetail']
type Scope = Pick<EventWriteOptions, 'assertCurrent'>
type WriteScope = Scope & { idempotencyKey: string }

const owner = '/support/cases', staff = '/admin/support/cases'
const page = <P extends typeof owner | typeof staff>(path: P, cursor: string | null) =>
  cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` as P : path

export const getSupportCases = (cursor: string | null, scope: Scope) => api.get(page(owner, cursor), scope)
export const createSupportCase = (draft: SupportDraft, scope: WriteScope) => api.post(owner, draft, scope)
export const getSupportCase = (caseId: string, scope: Scope) => api.get(url(`${owner}/{caseId}`, { caseId }), scope)
export const getStaffSupportQueue = (cursor: string | null, scope: Scope) => api.get(page(staff, cursor), scope)
export const getStaffSupportCase = (caseId: string, scope: Scope) => api.get(url(`${staff}/{caseId}`, { caseId }), scope)
export const commandSupportCase = (caseId: string, command: SupportCommand, scope: WriteScope) =>
  api.post(url(`${staff}/{caseId}`, { caseId }), command, scope)
