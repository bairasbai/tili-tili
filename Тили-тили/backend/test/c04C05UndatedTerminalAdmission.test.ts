// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertJournal, assertMigrationFiles, fileSHA, profileMigrationCount, reviewedMigrationPins,
  verifyMigrationDirectory, verifySource, type MigrationEntry, type MigrationPin, type Profile } from '../test-support/c04-c05-native-admission.mjs'

// Independent current88 requirements written before helper88/product bytes.
// No reviewedMigrationPins(88) at evaluation: F0 reaches the real old profile.
const backend = realpathSync(resolve('.')), repo = realpathSync(resolve('../..'))
const directory = join(backend, 'migrations'), support = join(backend, 'test-support')
const tailName = '1763860000000_deal_day_scope_undated_terminal', tailManifest = 'c04-c05-undated-terminal-migrations.json'
const tempRoot = realpathSync(tmpdir()), owned = new Set<string>()
const historical = [
  ['c04-c05-migrations.json', '295E73E8779E28BEE130EFF3786078B4699603AE15D004ADC451DAA4813EAC19'],
  ['c04-c05-fr011-migrations.json', '9F6852E53A9F58C7675C6B3FA77A54E9DB48EED67BFDEE2FCD686CA27BDBBED8'],
  ['c04-c05-resource-erasure-migrations.json', 'CF3FA5ECE8BB97BB2D250D103642AD26134164902509E64E2013DA0BC493F14C'],
  ['c04-c05-day-scope-migrations.json', '8107E7521D6EAFB832682053297676C5F074AA3E694D87E062DD1FF5CCFD7750'],
] as const
const names = (pins: MigrationPin[]) => pins.map(row => row.name)
const current = () => { const pins = reviewedMigrationPins(88); expect(pins).toHaveLength(88); expect(pins.at(-1)?.name).toBe(tailName); return pins }
function fixture(count: 83 | 85 | 86 | 87 | 88 = 88) {
  const target = mkdtempSync(join(tempRoot, 'c04c05-undated88-')); owned.add(target)
  for (const pin of reviewedMigrationPins(count)) cpSync(join(directory, pin.name + '.cjs'), join(target, pin.name + '.cjs'))
  mkdirSync(join(target, 'data')); cpSync(join(directory, 'data'), join(target, 'data'), { recursive: true })
  return target
}
afterEach(() => {
  for (const target of owned) {
    expect(dirname(resolve(target))).toBe(tempRoot); expect(target.slice(tempRoot.length + 1)).toMatch(/^c04c05-undated88-[A-Za-z0-9]+$/)
    expect(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()).toBe(true); expect(realpathSync(target)).toBe(resolve(target))
    rmSync(target, { recursive: true }); owned.delete(target)
  }
})
const required88 = [
  'Тили-тили/backend/migrations/' + tailName + '.cjs', 'Тили-тили/backend/test-support/' + tailManifest,
  'Тили-тили/backend/test/c04C05UndatedTerminalAdmission.test.ts',
  'Тили-тили/backend/migrations/1763850000000_deal_day_scope_foundation.cjs',
  'Тили-тили/backend/test-support/c04-c05-day-scope-migrations.json', 'Тили-тили/backend/test/c04C05DayScopeAdmission.test.ts',
  'Тили-тили/backend/test-support/c04-c05-native-admission.mjs', 'Тили-тили/backend/test-support/c04-c05-native-admission.d.mts',
] as const
function source89() {
  const paths = new Set<string>([
    ...reviewedMigrationPins(89).map(row => 'Тили-тили/backend/migrations/' + row.name + '.cjs'), ...required88,
    ...historical.map(([name]) => 'Тили-тили/backend/test-support/' + name),
    'Тили-тили/backend/test-support/c04-c05-atomic-day-migrations.json',
    'Тили-тили/backend/test/c04C05AtomicDayAdmission.test.ts',
    'Тили-тили/backend/test-support/deal-day-scope-atomic-drill.mjs',
    'Тили-тили/backend/src/deals/day-scope-write.ts', 'Тили-тили/backend/src/resources/day-groups.ts', 'Тили-тили/backend/src/resources/legacy-source.ts',
    'Тили-тили/backend/migrations/data/categories.json', 'Тили-тили/backend/migrations/data/cities.json',
    'Тили-тили/backend/test-support/c04-c05-test-inverse.json', 'Тили-тили/backend/test/c04C05MigrationAdmission.test.ts',
    'Тили-тили/backend/vitest.c04-isolated.config.ts', 'Тили-тили/backend/vitest.c05-worker-isolated.config.ts',
    'Тили-тили/backend/scripts/c04-c05-isolated-lane.mjs', 'Тили-тили/backend/scripts/c04-c05-receipt-barrier-control.mjs',
    'Тили-тили/backend/test-isolated/c04FanoutAdmission.test.ts', 'Тили-тили/backend/test-isolated/c05WorkerFinalBatch.test.ts',
    '.github/workflows/ci.yml', 'init.sh',
  ])
  const files = [...paths].sort().map(path => ({ path, sha256: fileSHA(join(repo, path)) }))
  expect(files.length - 1).toBeGreaterThan(100)
  return { kind: 'c04_c05_current_source89_v1' as Parameters<typeof verifySource>[0]['kind'], backend, repo, files }
}
const fake = (name: string, kind: 'file' | 'directory' | 'symlink'): MigrationEntry => ({ name,
  isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' })

describe('independent C04 C05 undated terminal current88 admission contract', () => {
  it('F0 current88 profile: github-ci requires89 while historical local remains83', () => {
    const p = { targetName: 'unused', targetURL: 'unused', username: 'unused', port: 5432 }
    expect(profileMigrationCount({ ...p, mode: 'local' } as Profile)).toBe(83)
    expect(profileMigrationCount({ ...p, mode: 'github-ci' } as Profile)).toBe(89)
  })
  it('preserves all four historical manifest Git LF bytes and the exact87 pin prefix', () => {
    for (const [name, digest] of historical) expect(createHash('sha256').update(readFileSync(join(support, name), 'utf8').replaceAll('\r\n', '\n')).digest('hex').toUpperCase(), name).toBe(digest)
    const pins = current(), old = reviewedMigrationPins(87)
    expect(pins.slice(0, 87)).toEqual(old); expect(old.at(-1)?.name).toBe('1763850000000_deal_day_scope_foundation')
    expect(new Set(names(pins)).size).toBe(88); expect(names(pins)).toEqual([...names(pins)].sort())
    const tail = pins[87]!
    expect(Object.keys(tail).sort()).toEqual(['name', 'sha256']); expect(tail.sha256).toMatch(/^[A-F0-9]{64}$/)
    expect(JSON.parse(readFileSync(join(support, tailManifest), 'utf8'))).toEqual([tail])
    expect(fileSHA(join(directory, tailName + '.cjs'))).toBe(tail.sha256)
  })
  it('admits exact88 journal and physical regular migration/seed files', () => {
    const pins = current(), journal = names(pins)
    expect(() => assertJournal(journal, journal)).not.toThrow(); expect(verifyMigrationDirectory(fixture(88), pins)).toEqual(journal)
  })
  it.each([83, 85, 86, 87] as const)('keeps exact historical%s journal, prefix and all physical bytes', count => {
    const pins = reviewedMigrationPins(count), journal = names(pins)
    expect(current().slice(0, count)).toEqual(pins); expect(() => assertJournal(journal, journal)).not.toThrow()
    expect(verifyMigrationDirectory(fixture(count), pins)).toEqual(journal)
  })
  it.each([82, 84, 90])('rejects unsupported count%s rather than an open count range', count => {
    expect(() => reviewedMigrationPins(count)).toThrow()
  })
  it.each(['extra', 'renamed', 'duplicate', 'reverse'])('rejects %s journal even with matching caller expected list', mode => {
    const journal = names(current())
    if (mode === 'extra') journal.push('1763870000000_unreviewed')
    if (mode === 'renamed') journal[87] = tailName + '_changed'
    if (mode === 'duplicate') journal[87] = journal[86]!
    if (mode === 'reverse') journal.reverse()
    expect(() => assertJournal(journal, journal)).toThrow()
  })
  it('rejects a truncated88 journal and historical source kind on the current directory', () => {
    const source = source89(), journal = names(current())
    expect(() => assertJournal(journal.slice(0, 87), journal)).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source87_v1' })).toThrow()
  })
  it.each(['missing', 'extra file', 'extra directory', 'symlink', 'duplicate', 'data as file'])('rejects %s in closed88 directory metadata', mode => {
    const pins = current(), entries: MigrationEntry[] = readdirSync(fixture(88), { withFileTypes: true }); expect(() => assertMigrationFiles(entries, pins)).not.toThrow()
    let attempted = [...entries]
    if (mode === 'missing') attempted = attempted.filter(e => e.name !== tailName + '.cjs')
    if (mode === 'extra file') attempted.push(fake('extra.cjs.disabled', 'file'))
    if (mode === 'extra directory') attempted.push(fake('unreviewed', 'directory'))
    if (mode === 'symlink') attempted = attempted.map(e => e.name === tailName + '.cjs' ? fake(e.name, 'symlink') : e)
    if (mode === 'duplicate') attempted.push(fake(tailName + '.cjs', 'file'))
    if (mode === 'data as file') attempted = attempted.map(e => e.name === 'data' ? fake('data', 'file') : e)
    expect(() => assertMigrationFiles(attempted, pins)).toThrow()
  })
  it.each([0, 83, 84, 85, 86, 87])('refuses changed migration bytes and caller-rehashed pin at index%s', index => {
    const pins = current(), target = fixture(), file = join(target, pins[index]!.name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// own byte mutation\n')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
    const attempted = pins.map(row => ({ ...row })); attempted[index]!.sha256 = fileSHA(file)
    expect(attempted[index]!.sha256).not.toBe(pins[index]!.sha256); expect(() => verifyMigrationDirectory(target, attempted)).toThrow()
  })
  it.each([83, 85, 86, 87, 88] as const)('keeps required seed byte/closed-directory checks at schema%s', count => {
    const pins = reviewedMigrationPins(count), target = fixture(count), data = join(target, 'data')
    writeFileSync(join(data, 'extra.json'), '{}'); expect(() => verifyMigrationDirectory(target, pins)).toThrow(); rmSync(join(data, 'extra.json'))
    const file = join(data, 'categories.json'); writeFileSync(file, readFileSync(file, 'utf8') + '\n')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
  })
  it.each(required88)('requires reviewed current89 source input %s', omitted => {
    const source = source89(); expect(verifySource(source)).toEqual(names(reviewedMigrationPins(89)))
    expect(source.files.some(row => row.path === omitted)).toBe(true)
    expect(() => verifySource({ ...source, files: source.files.filter(row => row.path !== omitted) })).toThrow()
  })
  it('rejects duplicate source paths, forged hash and unknown source kind90', () => {
    const source = source89(); expect(verifySource(source)).toEqual(names(reviewedMigrationPins(89)))
    expect(() => verifySource({ ...source, files: [...source.files, source.files[0]!] })).toThrow()
    const files = source.files.map(row => ({ ...row })); files.find(row => row.path === required88[0])!.sha256 = '0'.repeat(64)
    expect(() => verifySource({ ...source, files })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source90_v1' as typeof source.kind })).toThrow()
  })
})
