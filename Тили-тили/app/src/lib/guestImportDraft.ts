// Structural payload: the consuming API call checks assignability to GuestImportRow.
export type GuestImportPayload = { name: string; phone?: string; plusOne?: boolean; members?: { name: string }[] }
import {
  guestNameKey,
  NAME_MAX,
  normalizeRuPhone,
  parseGuestList,
} from './guestsImport'

export const IMPORT_ROWS_MAX = 300
export const IMPORT_MEMBERS_MAX = 9
export const IMPORT_PHONE_MAX = 32

export type ImportMemberDraft = { id: string; name: string }
export type ImportInvitationDraft = {
  id: string
  sourceIndex: number
  raw: string
  name: string
  phone: string
  mode: 'named' | 'legacy-plus-one'
  members: ImportMemberDraft[]
  nextMemberId: number
}
export type ImportIssue = {
  field: 'name' | 'phone' | 'members' | 'mode'
  memberId?: string
  code: 'name-length' | 'phone' | 'too-many-members' | 'mixed-modes'
}
export type ExistingImportGuest = { name: string; phone?: string | null }
export type ImportPreviewRow = ImportInvitationDraft & {
  issues: ImportIssue[]
  duplicate: boolean
  duplicateReason: 'family' | 'existing' | 'batch' | null
  persons: number
}

export function createImportDraft(text: string): ImportInvitationDraft[] {
  return parseGuestList(text).map(row => ({
    id: `import-${row.index}`,
    sourceIndex: row.index,
    raw: row.raw,
    name: row.name,
    phone: row.phone ?? row.invalidPhone ?? '',
    mode: row.plusOne ? 'legacy-plus-one' : 'named',
    members: [],
    nextMemberId: 0,
  }))
}

function validName(value: string): boolean {
  const name = value.trim()
  return guestNameKey(name).length >= 2 && name.length <= NAME_MAX
}

export function validateImportDraft(row: ImportInvitationDraft): ImportIssue[] {
  const issues: ImportIssue[] = []
  if (!validName(row.name)) issues.push({ field: 'name', code: 'name-length' })
  const phone = row.phone.trim()
  if (phone && (phone.length > IMPORT_PHONE_MAX || !normalizeRuPhone(phone))) {
    issues.push({ field: 'phone', code: 'phone' })
  }
  if (row.members.length > IMPORT_MEMBERS_MAX) {
    issues.push({ field: 'members', code: 'too-many-members' })
  }
  if (row.mode === 'legacy-plus-one' && row.members.length > 0) {
    issues.push({ field: 'mode', code: 'mixed-modes' })
  }
  for (const member of row.members) {
    if (!validName(member.name)) {
      issues.push({ field: 'members', memberId: member.id, code: 'name-length' })
    }
  }
  return issues
}

export function appendImportMember(row: ImportInvitationDraft): ImportInvitationDraft {
  if (row.mode !== 'named' || row.members.length >= IMPORT_MEMBERS_MAX) return row
  return {
    ...row,
    members: [...row.members, { id: `${row.id}-member-${row.nextMemberId}`, name: '' }],
    nextMemberId: row.nextMemberId + 1,
  }
}

// Вызывается исключительно кнопкой «Указать имя вместо +1».
export function nameLegacyCompanion(row: ImportInvitationDraft): ImportInvitationDraft {
  if (row.mode !== 'legacy-plus-one') return row
  return appendImportMember({ ...row, mode: 'named', members: [] })
}

export function buildImportPreview(
  rows: ImportInvitationDraft[],
  existing: ExistingImportGuest[] | undefined,
): ImportPreviewRow[] {
  // undefined означает, что существующий список ещё неизвестен.
  // Дубликаты внутри текущей вставки всё равно обнаруживаются.
  const existingNames = new Set((existing ?? []).map(g => guestNameKey(g.name)))
  const existingPhones = new Set((existing ?? []).flatMap(g => {
    const phone = g.phone ? normalizeRuPhone(g.phone) : null
    return phone ? [phone] : []
  }))
  const batchNames = new Set<string>()
  const batchPhones = new Set<string>()
  return rows.map(row => {
    const issues = validateImportDraft(row)
    const phone = row.phone.trim() ? normalizeRuPhone(row.phone) : null
    // Match the existing server import policy for every person, not just the
    // primary. Rejected rows reserve nothing for later rows in this batch.
    const companions = row.mode === 'legacy-plus-one'
      ? [`Спутник ${row.name.trim().replace(/\s+/g, ' ')}`]
      : row.members.map(member => member.name)
    const keys = [row.name, ...companions].map(guestNameKey)
    let duplicateReason: ImportPreviewRow['duplicateReason'] = null
    if (issues.length === 0) {
      if (new Set(keys).size !== keys.length) duplicateReason = 'family'
      else if (keys.some(key => existingNames.has(key)) || (phone && existingPhones.has(phone))) duplicateReason = 'existing'
      else if (keys.some(key => batchNames.has(key)) || (phone && batchPhones.has(phone))) duplicateReason = 'batch'
      if (!duplicateReason) {
        for (const key of keys) batchNames.add(key)
        if (phone) batchPhones.add(phone)
      }
    }
    return {
      ...row,
      issues,
      duplicate: duplicateReason !== null,
      duplicateReason,
      persons: row.mode === 'legacy-plus-one' ? 2 : 1 + row.members.length,
    }
  })
}

export function importPayload(row: ImportInvitationDraft): GuestImportPayload {
  if (validateImportDraft(row).length > 0) throw new Error('invalid-import-draft')
  const phone = row.phone.trim()
  return {
    name: row.name.trim(),
    ...(phone ? { phone } : {}),
    ...(row.mode === 'legacy-plus-one' ? { plusOne: true } : {}),
    ...(row.mode === 'named' && row.members.length > 0
      ? { members: row.members.map(member => ({ name: member.name.trim() })) }
      : {}),
  }
}

export function prepareImport(preview: ImportPreviewRow[]) {
  const selected = preview.filter(row => row.issues.length === 0 && !row.duplicate)
  if (selected.length > IMPORT_ROWS_MAX) throw new Error('too-many-import-rows')
  if (new Set(selected.map(row => row.id)).size !== selected.length) throw new Error('duplicate-import-draft-id')
  return {
    rows: selected.map(importPayload),
    rowIds: selected.map(row => row.id),
    invitations: selected.length,
    persons: selected.reduce((sum, row) => sum + row.persons, 0),
  }
}

// Response.created — одна primary-строка на созданное приглашение.
// Необязательный partySize проверяем, никакого ?? 1.
export function createdImportPersons(
  created: ReadonlyArray<{ readonly partySize?: number }>,
): number | null {
  let total = 0
  for (const row of created) {
    const size = row.partySize
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > 10) {
      return null
    }
    total += size
  }
  return total
}

export function retainUncreatedDrafts(
  all: ImportInvitationDraft[],
  submittedIds: string[],
  skipped: ReadonlyArray<{ index: number }>,
): ImportInvitationDraft[] {
  const submitted = new Set(submittedIds)
  const skippedIds = new Set(skipped.map(item => {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= submittedIds.length) {
      throw new Error('invalid-import-response-index')
    }
    return submittedIds[item.index]!
  }))
  return all.filter(row => !submitted.has(row.id) || skippedIds.has(row.id))
}

export type ImportServerResult = {
  created: { partySize?: number }[]
  skipped: { index: number; name: string; reason: 'duplicate' | 'invalid' }[]
}

export function reconcileImportResponse(
  all: ImportInvitationDraft[],
  submittedIds: string[],
  response: unknown,
) {
  if (!response || typeof response !== 'object') throw new Error('invalid-import-response')
  const value = response as Partial<ImportServerResult>
  if (!Array.isArray(value.created) || !Array.isArray(value.skipped)) throw new Error('invalid-import-response')
  if (value.created.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('invalid-import-response')
  const seen = new Set<number>()
  for (const item of value.skipped) {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.index)
      || item.index < 0 || item.index >= submittedIds.length || seen.has(item.index)
      || typeof item.name !== 'string' || !['duplicate', 'invalid'].includes(item.reason)) {
      throw new Error('invalid-import-response')
    }
    seen.add(item.index)
  }
  if (value.created.length + seen.size !== submittedIds.length) throw new Error('incomplete-import-response')
  return {
    remaining: retainUncreatedDrafts(all, submittedIds, value.skipped),
    invitations: value.created.length,
    persons: createdImportPersons(value.created),
    skipped: value.skipped,
  }
}
