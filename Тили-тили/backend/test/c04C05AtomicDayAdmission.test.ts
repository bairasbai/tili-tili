// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertJournal, assertMigrationFiles, fileSHA, profileMigrationCount, reviewedMigrationPins,
  verifyMigrationDirectory, verifySource, type MigrationEntry, type MigrationPin, type Profile } from '../test-support/c04-c05-native-admission.mjs'

// Independent current89 requirements written before helper89 bytes.
// No reviewedMigrationPins(89) at evaluation: F0 reaches the real old profile.
const backend = realpathSync(resolve('.')), repo = realpathSync(resolve('../..'))
const directory = join(backend, 'migrations'), support = join(backend, 'test-support')
const tailName = '1763870000000_deal_day_scope_atomic', tailManifest = 'c04-c05-atomic-day-migrations.json'
const tempRoot = realpathSync(tmpdir()), owned = new Set<string>()
const historical = [
  ['c04-c05-migrations.json', '295E73E8779E28BEE130EFF3786078B4699603AE15D004ADC451DAA4813EAC19'],
  ['c04-c05-fr011-migrations.json', '9F6852E53A9F58C7675C6B3FA77A54E9DB48EED67BFDEE2FCD686CA27BDBBED8'],
  ['c04-c05-resource-erasure-migrations.json', 'CF3FA5ECE8BB97BB2D250D103642AD26134164902509E64E2013DA0BC493F14C'],
  ['c04-c05-day-scope-migrations.json', '8107E7521D6EAFB832682053297676C5F074AA3E694D87E062DD1FF5CCFD7750'],
  ['c04-c05-undated-terminal-migrations.json', 'AE490EC703006E828DF63CDC7D82BFB75337AAD325037D434667EDCAE7F26BC1'],
] as const
const names = (pins: MigrationPin[]) => pins.map(row => row.name)
const current = () => { const pins = reviewedMigrationPins(89); expect(pins).toHaveLength(89); expect(pins.at(-1)?.name).toBe(tailName); return pins }
function fixture(count: 83 | 85 | 86 | 87 | 88 | 89 = 89) {
  const target = mkdtempSync(join(tempRoot, 'c04c05-atomic89-')); owned.add(target)
  for (const pin of reviewedMigrationPins(count)) cpSync(join(directory, pin.name + '.cjs'), join(target, pin.name + '.cjs'))
  mkdirSync(join(target, 'data')); cpSync(join(directory, 'data'), join(target, 'data'), { recursive: true })
  return target
}
afterEach(() => {
  for (const target of owned) {
    expect(dirname(resolve(target))).toBe(tempRoot); expect(target.slice(tempRoot.length + 1)).toMatch(/^c04c05-atomic89-[A-Za-z0-9]+$/)
    expect(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()).toBe(true); expect(realpathSync(target)).toBe(resolve(target))
    rmSync(target, { recursive: true }); owned.delete(target)
  }
})
const required89 = [
  'Тили-тили/backend/migrations/' + tailName + '.cjs', 'Тили-тили/backend/test-support/' + tailManifest,
  'Тили-тили/backend/test/c04C05AtomicDayAdmission.test.ts',
  'Тили-тили/backend/migrations/1763860000000_deal_day_scope_undated_terminal.cjs',
  'Тили-тили/backend/test-support/c04-c05-undated-terminal-migrations.json', 'Тили-тили/backend/test/c04C05UndatedTerminalAdmission.test.ts',
  'Тили-тили/backend/test-support/deal-day-scope-atomic-drill.mjs',
    'Тили-тили/backend/src/deals/day-scope-write.ts', 'Тили-тили/backend/src/resources/day-groups.ts', 'Тили-тили/backend/src/resources/legacy-source.ts',
  'Тили-тили/backend/migrations/1763850000000_deal_day_scope_foundation.cjs',
  'Тили-тили/backend/test-support/c04-c05-day-scope-migrations.json', 'Тили-тили/backend/test/c04C05DayScopeAdmission.test.ts',
  'Тили-тили/backend/test-support/c04-c05-native-admission.mjs', 'Тили-тили/backend/test-support/c04-c05-native-admission.d.mts',
] as const
function source93() {
  const paths = new Set<string>([
    'Тили-тили/backend/test-support/c04-c05-undated-additional-migrations.json',
    'Тили-тили/backend/migrations/1763910000000_additional_event_undated.cjs',
    'Тили-тили/backend/test/additionalEventUndated.test.ts',
    'Тили-тили/backend/test/additionalEventUndatedMove.test.ts',
    'Тили-тили/backend/test/helpers/additionalEventUndatedFixture.ts',
    'Тили-тили/backend/test-support/additional-event-undated-migration-drill.mjs',
    'Тили-тили/backend/test-support/c04-c05-additional-event-migrations.json',
    'Тили-тили/backend/test-support/c04-c05-event-move-fix-migrations.json',
    'Тили-тили/backend/test/additionalEventSnapshotValidation.test.ts',
    'Тили-тили/backend/migrations/1763880000000_offer_event_context.cjs',
    'Тили-тили/backend/migrations/1763890000000_event_move_agreements.cjs',
    'Тили-тили/backend/test/c04C05AdditionalEventAdmission.test.ts',
    'Тили-тили/backend/src/deals/program-event-context.ts', 'Тили-тили/backend/src/offers/event-context.ts',
    'Тили-тили/backend/src/orders/event-moves.ts', 'Тили-тили/backend/src/orders/event-move-token.ts',
    ...reviewedMigrationPins(93).map(row => 'Тили-тили/backend/migrations/' + row.name + '.cjs'), ...required89,
    ...historical.map(([name]) => 'Тили-тили/backend/test-support/' + name),
    'Тили-тили/backend/migrations/data/categories.json', 'Тили-тили/backend/migrations/data/cities.json',
    'Тили-тили/backend/test-support/c04-c05-test-inverse.json', 'Тили-тили/backend/test/c04C05MigrationAdmission.test.ts',
    'Тили-тили/backend/vitest.c04-isolated.config.ts', 'Тили-тили/backend/vitest.c05-worker-isolated.config.ts',
    'Тили-тили/backend/scripts/c04-c05-isolated-lane.mjs', 'Тили-тили/backend/scripts/c04-c05-receipt-barrier-control.mjs',
    'Тили-тили/backend/test-isolated/c04FanoutAdmission.test.ts', 'Тили-тили/backend/test-isolated/c05WorkerFinalBatch.test.ts',
    '.github/workflows/ci.yml', 'init.sh',
  ])
  const files = [...paths].sort().map(path => ({ path, sha256: fileSHA(join(repo, path)) }))
  expect(files.length - 1).toBeGreaterThan(100)
  return { kind: 'c04_c05_current_source93_v1' as Parameters<typeof verifySource>[0]['kind'], backend, repo, files }
}
const fake = (name: string, kind: 'file' | 'directory' | 'symlink'): MigrationEntry => ({ name,
  isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' })

describe('independent C04 C05 atomic day current89 admission contract', () => {
  it('F0 current89 profile: github-ci requires93 while historical local remains83', () => {
    const p = { targetName: 'unused', targetURL: 'unused', username: 'unused', port: 5432 }
    expect(profileMigrationCount({ ...p, mode: 'local' } as Profile)).toBe(83)
    expect(profileMigrationCount({ ...p, mode: 'github-ci' } as Profile)).toBe(93)
  })
  it('preserves all five historical manifest Git LF bytes and the exact88 pin prefix', () => {
    for (const [name, digest] of historical) expect(createHash('sha256').update(readFileSync(join(support, name), 'utf8').replaceAll('\r\n', '\n')).digest('hex').toUpperCase(), name).toBe(digest)
    const pins = current(), old = reviewedMigrationPins(88)
    expect(pins.slice(0, 88)).toEqual(old); expect(old.at(-1)?.name).toBe('1763860000000_deal_day_scope_undated_terminal')
    expect(new Set(names(pins)).size).toBe(89); expect(names(pins)).toEqual([...names(pins)].sort())
    const tail = pins[88]!
    expect(Object.keys(tail).sort()).toEqual(['name', 'sha256']); expect(tail.sha256).toMatch(/^[A-F0-9]{64}$/)
    expect(tail.sha256).toBe('FC8E1AE6E6D62DEBFFE622D36E17DEFBB4C50120DB44C161AB6228264C6644DF')
    expect(JSON.parse(readFileSync(join(support, tailManifest), 'utf8'))).toEqual([tail])
    expect(fileSHA(join(directory, tailName + '.cjs'))).toBe(tail.sha256)
  })
  it('admits exact89 journal and physical regular migration/seed files', () => {
    const pins = current(), journal = names(pins)
    expect(() => assertJournal(journal, journal)).not.toThrow(); expect(verifyMigrationDirectory(fixture(89), pins)).toEqual(journal)
  })
  it.each([83, 85, 86, 87, 88] as const)('keeps exact historical%s journal, prefix and all physical bytes', count => {
    const pins = reviewedMigrationPins(count), journal = names(pins)
    expect(current().slice(0, count)).toEqual(pins); expect(() => assertJournal(journal, journal)).not.toThrow()
    expect(verifyMigrationDirectory(fixture(count), pins)).toEqual(journal)
  })
  it.each([82, 84, 94])('rejects unsupported count%s rather than an open count range', count => {
    expect(() => reviewedMigrationPins(count)).toThrow()
  })
  it.each(['extra', 'renamed', 'duplicate', 'reverse'])('rejects %s journal even with matching caller expected list', mode => {
    const journal = names(current())
    if (mode === 'extra') journal.push('1763870000000_unreviewed')
    if (mode === 'renamed') journal[88] = tailName + '_changed'
    if (mode === 'duplicate') journal[88] = journal[87]!
    if (mode === 'reverse') journal.reverse()
    expect(() => assertJournal(journal, journal)).toThrow()
  })
  it('rejects a truncated89 journal and historical source kind on the current directory', () => {
    const source = source93(), journal = names(current())
    expect(() => assertJournal(journal.slice(0, 88), journal)).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source87_v1' })).toThrow()
  })
  it.each(['missing', 'extra file', 'extra directory', 'symlink', 'duplicate', 'data as file'])('rejects %s in closed89 directory metadata', mode => {
    const pins = current(), entries: MigrationEntry[] = readdirSync(fixture(89), { withFileTypes: true }); expect(() => assertMigrationFiles(entries, pins)).not.toThrow()
    let attempted = [...entries]
    if (mode === 'missing') attempted = attempted.filter(e => e.name !== tailName + '.cjs')
    if (mode === 'extra file') attempted.push(fake('extra.cjs.disabled', 'file'))
    if (mode === 'extra directory') attempted.push(fake('unreviewed', 'directory'))
    if (mode === 'symlink') attempted = attempted.map(e => e.name === tailName + '.cjs' ? fake(e.name, 'symlink') : e)
    if (mode === 'duplicate') attempted.push(fake(tailName + '.cjs', 'file'))
    if (mode === 'data as file') attempted = attempted.map(e => e.name === 'data' ? fake('data', 'file') : e)
    expect(() => assertMigrationFiles(attempted, pins)).toThrow()
  })
  it.each([0, 83, 84, 85, 86, 87, 88])('refuses changed migration bytes and caller-rehashed pin at index%s', index => {
    const pins = current(), target = fixture(), file = join(target, pins[index]!.name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// own byte mutation\n')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
    const attempted = pins.map(row => ({ ...row })); attempted[index]!.sha256 = fileSHA(file)
    expect(attempted[index]!.sha256).not.toBe(pins[index]!.sha256); expect(() => verifyMigrationDirectory(target, attempted)).toThrow()
  })
  it.each([83, 85, 86, 87, 88, 89] as const)('keeps required seed byte/closed-directory checks at schema%s', count => {
    const pins = reviewedMigrationPins(count), target = fixture(count), data = join(target, 'data')
    writeFileSync(join(data, 'extra.json'), '{}'); expect(() => verifyMigrationDirectory(target, pins)).toThrow(); rmSync(join(data, 'extra.json'))
    const file = join(data, 'categories.json'); writeFileSync(file, readFileSync(file, 'utf8') + '\n')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
  })
  it.each(required89)('requires reviewed current93 source input %s', omitted => {
    const source = source93(); expect(verifySource(source)).toEqual(names(reviewedMigrationPins(93)))
    expect(source.files.some(row => row.path === omitted)).toBe(true)
    expect(() => verifySource({ ...source, files: source.files.filter(row => row.path !== omitted) })).toThrow()
  })
  it('rejects duplicate source paths, forged hash and unknown source kind94', () => {
    const source = source93(); expect(verifySource(source)).toEqual(names(reviewedMigrationPins(93)))
    expect(() => verifySource({ ...source, files: [...source.files, source.files[0]!] })).toThrow()
    const files = source.files.map(row => ({ ...row })); files.find(row => row.path === required89[0])!.sha256 = '0'.repeat(64)
    expect(() => verifySource({ ...source, files })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source94_v1' as typeof source.kind })).toThrow()
  })
})
