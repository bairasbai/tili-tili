// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  assertJournal, assertMigrationFiles, fileSHA, profileMigrationCount, reviewedMigrationPins,
  verifyMigrationDirectory, verifySource, type MigrationEntry, type MigrationPin, type Profile,
} from '../test-support/c04-c05-native-admission.mjs'

// Independent current87 requirements; no future DDL or helper implementation
// was read. Do NOT call reviewedMigrationPins(87) at module evaluation: the
// selected initial RED below must reach the existing public count function.
const backend = realpathSync(resolve('.')), repo = realpathSync(resolve('../..'))
const directory = join(backend, 'migrations'), support = join(backend, 'test-support')
const tailName = '1763850000000_deal_day_scope_foundation'
const tailManifest = 'c04-c05-day-scope-migrations.json'
const tempRoot = realpathSync(tmpdir()), owned = new Set<string>()
const gitLFHash = (path: string) => createHash('sha256').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).digest('hex').toUpperCase()
const historicalFiles = [
  ['c04-c05-migrations.json', '295E73E8779E28BEE130EFF3786078B4699603AE15D004ADC451DAA4813EAC19'],
  ['c04-c05-fr011-migrations.json', '9F6852E53A9F58C7675C6B3FA77A54E9DB48EED67BFDEE2FCD686CA27BDBBED8'],
  ['c04-c05-resource-erasure-migrations.json', 'CF3FA5ECE8BB97BB2D250D103642AD26134164902509E64E2013DA0BC493F14C'],
] as const
const fake = (name: string, kind: 'file' | 'directory' | 'symlink'): MigrationEntry => ({ name,
  isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' })
const names = (pins: MigrationPin[]) => pins.map(row => row.name)
const current = () => {
  const pins = reviewedMigrationPins(87)
  expect(pins).toHaveLength(87)
  expect(pins.at(-1)?.name).toBe(tailName)
  return pins
}
function fixture(count: 83 | 85 | 86 | 87 = 87) {
  const target = mkdtempSync(join(tempRoot, 'c04c05-day87-')); owned.add(target)
  // Copy only the selected reviewed files: historical fixtures do not depend
  // on silently removing an unreviewed extra file from the real directory.
  for (const pin of reviewedMigrationPins(count)) cpSync(join(directory, pin.name + '.cjs'), join(target, pin.name + '.cjs'))
  mkdirSync(join(target, 'data')); cpSync(join(directory, 'data'), join(target, 'data'), { recursive: true })
  return target
}
afterEach(() => {
  for (const target of owned) {
    expect(dirname(resolve(target))).toBe(tempRoot)
    expect(target.slice(tempRoot.length + 1)).toMatch(/^c04c05-day87-[A-Za-z0-9]+$/)
    expect(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()).toBe(true)
    expect(realpathSync(target)).toBe(resolve(target))
    rmSync(target, { recursive: true }); owned.delete(target)
  }
})

const required87 = [
  'Тили-тили/backend/migrations/' + tailName + '.cjs',
  'Тили-тили/backend/test-support/' + tailManifest,
  'Тили-тили/backend/test-support/c04-c05-native-admission.mjs',
  'Тили-тили/backend/test-support/c04-c05-native-admission.d.mts',
  'Тили-тили/backend/test/c04C05DayScopeAdmission.test.ts',
] as const
// Current source is94; foundation87 catalogue/directory checks retain exact subset fixtures.
const required94 = [
  'Тили-тили/backend/test-support/c04-c05-calendar-bounds-migrations.json',
  'Тили-тили/backend/migrations/1763920000000_legacy_calendar_bounds.cjs',
  'Тили-тили/backend/test-support/calendar-bounds-migration-drill.mjs',
] as const
function source94() {
  const pins = reviewedMigrationPins(94)
  // A pure FS public verifySource fixture, not an actual CI/native receipt.
  // All supplied files have real bytes; missing-required tests stay >100
  // entries, so their target cannot be hidden by the length precondition.
  const paths = new Set<string>([
    ...required94,
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
    ...pins.map(row => 'Тили-тили/backend/migrations/' + row.name + '.cjs'),
    ...required87,
    'Тили-тили/backend/test-support/c04-c05-undated-terminal-migrations.json',
    'Тили-тили/backend/test/c04C05UndatedTerminalAdmission.test.ts',
    'Тили-тили/backend/test-support/c04-c05-atomic-day-migrations.json',
    'Тили-тили/backend/test/c04C05AtomicDayAdmission.test.ts',
    'Тили-тили/backend/test-support/deal-day-scope-atomic-drill.mjs',
    'Тили-тили/backend/src/deals/day-scope-write.ts', 'Тили-тили/backend/src/resources/day-groups.ts', 'Тили-тили/backend/src/resources/legacy-source.ts',
    'Тили-тили/backend/migrations/data/categories.json', 'Тили-тили/backend/migrations/data/cities.json',
    'Тили-тили/backend/test-support/c04-c05-migrations.json',
    'Тили-тили/backend/test-support/c04-c05-fr011-migrations.json',
    'Тили-тили/backend/test-support/c04-c05-resource-erasure-migrations.json',
    'Тили-тили/backend/test-support/c04-c05-test-inverse.json',
    'Тили-тили/backend/vitest.c04-isolated.config.ts', 'Тили-тили/backend/vitest.c05-worker-isolated.config.ts',
    'Тили-тили/backend/scripts/c04-c05-isolated-lane.mjs',
    'Тили-тили/backend/scripts/c04-c05-receipt-barrier-control.mjs',
    'Тили-тили/backend/test-isolated/c04FanoutAdmission.test.ts',
    'Тили-тили/backend/test-isolated/c05WorkerFinalBatch.test.ts',
    'Тили-тили/backend/test/c04C05MigrationAdmission.test.ts',
    '.github/workflows/ci.yml', 'init.sh',
  ])
  const files = [...paths].sort().map(path => ({ path, sha256: fileSHA(join(repo, path)) }))
  expect(files.length - 1).toBeGreaterThan(100)
  return { kind: 'c04_c05_current_source94_v1' as Parameters<typeof verifySource>[0]['kind'], backend, repo, files }
}

describe('independent C04 C05 day-scope current87 admission contract', () => {
  it('F0 profile: github-ci requires94 while local remains83', () => {
    const local: Profile = { mode: 'local', targetName: 'tili_ecosystem_c04batch_20261003_test',
      targetURL: 'postgres://codex_test@127.0.0.1:15432/tili_ecosystem_c04batch_20261003_test', username: 'codex_test', port: 15432, fixedOID: '616406' }
    const ci: Profile = { mode: 'github-ci', targetName: 'tili_c04_c05_940001_1_test',
      targetURL: 'postgres://tili:tili@127.0.0.1:5432/tili_c04_c05_940001_1_test', username: 'tili', port: 5432,
      context: { workflow: 'CI', job: 'backend', repository: 'bairasbai/tili-tili', runID: '940001', attempt: '1',
        checkoutSHA: '1'.repeat(40), postgresContainerID: 'a'.repeat(64) } }
    expect(profileMigrationCount(local)).toBe(83)
    expect(profileMigrationCount(ci)).toBe(94)
  })
  it('preserves all three historical manifest contents modulo normal Git LF', () => {
    for (const [name, digest] of historicalFiles) expect(gitLFHash(join(support, name)), name).toBe(digest)
  })
  it('extends the exact83/85/86 prefix by one reviewed day-scope pin and actual file bytes', () => {
    const pins = current(), p83 = reviewedMigrationPins(83), p85 = reviewedMigrationPins(85), p86 = reviewedMigrationPins(86)
    expect(pins.slice(0, 86)).toEqual(p86); expect(p86.slice(0, 85)).toEqual(p85); expect(p85.slice(0, 83)).toEqual(p83)
    expect(new Set(names(pins)).size).toBe(87); expect(names(pins)).toEqual([...names(pins)].sort())
    const tail = pins[86]!
    expect(Object.keys(tail).sort()).toEqual(['name', 'sha256'])
    expect(tail.sha256).toMatch(/^[A-F0-9]{64}$/)
    expect(JSON.parse(readFileSync(join(support, tailManifest), 'utf8'))).toEqual([tail])
    expect(fileSHA(join(directory, tailName + '.cjs'))).toBe(tail.sha256)
    // No guessed future SHA is a test oracle. The reviewed returned pin must
    // actually bind the single new physical migration's bytes.
  })
  it('admits exact historical87 journal and regular migration/seed fixture', () => {
    const pins = current(), journal = names(pins)
    expect(() => assertJournal(journal, journal)).not.toThrow()
    expect(verifyMigrationDirectory(fixture(87), pins)).toEqual(journal)
  })
  it.each([83, 85, 86] as const)('retains exact historical%s journal and fixture including seed bytes', count => {
    const pins = reviewedMigrationPins(count), journal = names(pins)
    expect(pins).toHaveLength(count); expect(() => assertJournal(journal, journal)).not.toThrow()
    expect(verifyMigrationDirectory(fixture(count), pins)).toEqual(journal)
  })
  it.each([82, 84, 95])('rejects unsupported migration count %s', count => {
    expect(reviewedMigrationPins(94)).toHaveLength(94)
    expect(() => reviewedMigrationPins(count)).toThrow()
  })
  it.each(['extra', 'renamed', 'duplicate', 'reverse'])('rejects %s journal even when caller repeats the same attempted list', mode => {
    const journal = names(current())
    if (mode === 'extra') journal.push('1763860000000_unreviewed')
    if (mode === 'renamed') journal[86] = tailName + '_changed'
    if (mode === 'duplicate') journal[86] = journal[85]!
    if (mode === 'reverse') journal.reverse()
    expect(() => assertJournal(journal, journal)).toThrow()
  })
  it('refuses a truncated current87 actual journal against its correct expected pins', () => {
    const journal = names(current())
    expect(() => assertJournal(journal.slice(0, 86), journal)).toThrow()
  })
  it.each(['missing', 'extra file', 'extra directory', 'symlink', 'duplicate', 'data as file'])('rejects %s in current87 entry metadata', mode => {
    const pins = current(), entries: MigrationEntry[] = readdirSync(fixture(87), { withFileTypes: true })
    expect(() => assertMigrationFiles(entries, pins)).not.toThrow()
    let attempted = [...entries]
    if (mode === 'missing') attempted = attempted.filter(e => e.name !== tailName + '.cjs')
    if (mode === 'extra file') attempted.push(fake('extra.cjs.disabled', 'file'))
    if (mode === 'extra directory') attempted.push(fake('unreviewed', 'directory'))
    if (mode === 'symlink') attempted = attempted.map(e => e.name === tailName + '.cjs' ? fake(e.name, 'symlink') : e)
    if (mode === 'duplicate') attempted.push(fake(tailName + '.cjs', 'file'))
    if (mode === 'data as file') attempted = attempted.map(e => e.name === 'data' ? fake('data', 'file') : e)
    expect(() => assertMigrationFiles(attempted, pins)).toThrow()
  })
  it('refuses altered87 bytes with reviewed pins rather than a name-only match', () => {
    const pins = current(), target = fixture(), file = join(target, tailName + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// own test changed bytes\n')
    expect(fileSHA(file)).not.toBe(pins[86]!.sha256)
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
  })
  it.each([0, 83, 84, 85, 86])('refuses substituted migration hash at index%s even when caller supplies new file hash', index => {
    const pins = current(), target = fixture(), file = join(target, pins[index]!.name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// owned caller substitution\n')
    const attempted = pins.map(row => ({ ...row })); attempted[index]!.sha256 = fileSHA(file)
    expect(attempted[index]!.sha256).not.toBe(pins[index]!.sha256)
    expect(() => verifyMigrationDirectory(target, attempted)).toThrow()
  })
  it.each([83, 85, 86, 87] as const)('keeps closed seed-directory checks at schema%s', count => {
    const target = fixture(count), pins = reviewedMigrationPins(count), data = join(target, 'data')
    writeFileSync(join(data, 'extra.json'), '{}')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
    rmSync(join(data, 'extra.json'))
    const seed = join(data, 'cities.json'); writeFileSync(seed, readFileSync(seed, 'utf8') + '\n')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
  })
  it('admits a real-byte current94 source fixture retaining the87 required inputs', () => {
    expect(verifySource(source94())).toEqual(names(reviewedMigrationPins(94)))
  })
  it.each([...required87, ...required94])('current94 source receipt must retain historical87 input %s', omitted => {
    const source = source94()
    expect(verifySource(source)).toEqual(names(reviewedMigrationPins(94)))
    expect(source.files.some(f => f.path === omitted)).toBe(true)
    expect(() => verifySource({ ...source, files: source.files.filter(f => f.path !== omitted) })).toThrow()
  })
  it('current94 source receipt rejects duplicate paths and forged caller-supplied hashes', () => {
    const source = source94()
    expect(verifySource(source)).toEqual(names(reviewedMigrationPins(94)))
    expect(() => verifySource({ ...source, files: [...source.files, source.files[0]!] })).toThrow()
    const files = source.files.map(row => ({ ...row })), target = files.find(row => row.path === required87[0])!
    target.sha256 = target.sha256[0] === '0' ? '1' + target.sha256.slice(1) : '0' + target.sha256.slice(1)
    expect(() => verifySource({ ...source, files })).toThrow()
  })
  it('refuses future95 source kind after exact positive94', () => {
    const source = source94(); expect(verifySource(source)).toEqual(names(reviewedMigrationPins(94)))
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source95_v1' as Parameters<typeof verifySource>[0]['kind'] })).toThrow()
  })
})
