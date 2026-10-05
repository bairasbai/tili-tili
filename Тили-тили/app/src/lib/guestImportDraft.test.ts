import { describe, expect, it } from 'vitest'
import {
  appendImportMember, buildImportPreview, createImportDraft, createdImportPersons,
  importPayload, nameLegacyCompanion, prepareImport, reconcileImportResponse,
  validateImportDraft,
} from './guestImportDraft'

// Authored for the project's normal Vitest suite. Actual execution is recorded
// separately; the native node:test evidence must not be called a Vitest pass.
describe('WP02 named-family guest import', () => {
  it('does not invent people by splitting a pasted primary name', () => {
    const row = createImportDraft('Ольга и Сергей')[0]!
    expect(row.name).toBe('Ольга и Сергей')
    expect(row.members).toEqual([])
  })
  it('keeps an invalid phone when a primary name is corrected', () => {
    const row = { ...createImportDraft('А,12345')[0]!, name: 'Анна' }
    expect(row.phone).toBe('12345')
    expect(validateImportDraft(row)).toEqual([{ field: 'phone', code: 'phone' }])
  })
  it('requires an explicit name after converting a legacy +1', () => {
    const old = createImportDraft('Анна,+1')[0]!
    const row = nameLegacyCompanion(old)
    expect(row.mode).toBe('named')
    expect(() => importPayload(row)).toThrow('invalid-import-draft')
    const named = { ...row, members: [{ ...row.members[0]!, name: ' Борис ' }] }
    expect(importPayload(named)).toEqual({ name: 'Анна', members: [{ name: 'Борис' }] })
    expect(importPayload(old)).toEqual({ name: 'Анна', plusOne: true })
  })
  it('keeps a blank added member invalid rather than silently dropping them', () => {
    const row = appendImportMember(createImportDraft('Анна')[0]!)
    expect(() => importPayload(row)).toThrow('invalid-import-draft')
  })
  it('bounds the family to one primary and nine companions', () => {
    let row = createImportDraft('Анна')[0]!
    for (let i = 0; i < 9; i++) row = appendImportMember(row)
    expect(row.members).toHaveLength(9)
    expect(appendImportMember(row)).toBe(row)
  })
  it('deduplicates normalized primary names and phones', () => {
    const rows = createImportDraft('Анна\n АННА\nБорис,89170001122')
    expect(buildImportPreview(rows, [{ name: 'Вера', phone: '+79170001122' }]).map(row => row.duplicate))
      .toEqual([false, true, true])
  })
  it('keeps invitation and person estimates separate', () => {
    const rows = createImportDraft('Анна,+1\nБорис')
    const request = prepareImport(buildImportPreview(rows, []))
    expect(request.invitations).toBe(2)
    expect(request.persons).toBe(3)
  })
  it('rejects more than 300 eligible invitation rows', () => {
    const rows = createImportDraft(Array.from({ length: 301 }, (_, i) => `Гость ${i}`).join('\n'))
    expect(() => prepareImport(buildImportPreview(rows, []))).toThrow('too-many-import-rows')
  })
  it('maps skipped submitted positions back to the right draft after local filtering', () => {
    const rows = createImportDraft('А\nАнна\nБорис')
    const request = prepareImport(buildImportPreview(rows, []))
    const result = reconcileImportResponse(rows, request.rowIds, {
      created: [{ partySize: 3 }], skipped: [{ index: 1, name: 'Борис', reason: 'invalid' }],
    })
    expect(result.remaining.map(row => row.id)).toEqual(['import-0', 'import-2'])
    expect(result.invitations).toBe(1)
    expect(result.persons).toBe(3)
  })
  it('does not guess a missing person total', () => {
    expect(createdImportPersons([{}])).toBeNull()
    expect(createdImportPersons([{ partySize: 0 }])).toBeNull()
    expect(createdImportPersons([])).toBe(0)
  })
  it('refuses an incomplete response without mutating the draft', () => {
    const rows = createImportDraft('Анна')
    const before = JSON.stringify(rows)
    expect(() => reconcileImportResponse(rows, ['import-0'], { created: [], skipped: [] })).toThrow()
    expect(JSON.stringify(rows)).toBe(before)
  })
  it('rejects a duplicated skipped index', () => {
    const rows = createImportDraft('Анна\nБорис')
    const item = { index: 0, name: 'Анна', reason: 'invalid' }
    expect(() => reconcileImportResponse(rows, ['import-0', 'import-1'], { created: [], skipped: [item, item] })).toThrow()
  })
})
