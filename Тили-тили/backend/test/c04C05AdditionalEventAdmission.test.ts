// @vitest-environment node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertJournal, assertMigrationFiles, fileSHA, profileMigrationCount, reviewedMigrationPins,
  verifyMigrationDirectory, verifySource, type MigrationEntry, type MigrationPin, type Profile } from '../test-support/c04-c05-native-admission.mjs'

// Independent requirements, not imports of migration/application code.
// Root admitted FINAL_93_SHA only after owner STOP and independent SQL review.
// FINAL_91_SHA/FINAL_92_SHA are immutable. Never adopt mutable DDL hashes at runtime or skip.
const FINAL_91_SHA = 'C3A1019F88A798B4DF8802D9C5212EEF01F6F54194A98BA615DCE0C9AC613AFA'
const FINAL_92_SHA = 'EC1635C3E1638B18B9330B889C2E456C4009C6E4928E7D9307F95C7C746476CB'
const FINAL_93_SHA = '4FF66E47B92954A8DCA6D430925143727B99FC3FD54376FEB24A4B96E6CC59D4'
const FINAL_94_SHA = '023FFCD77A29A94AEF26974B5686ADBDF53BB63B515684B6E2DC21391349B697'
const offer90 = { name: '1763880000000_offer_event_context', sha256: '24B8B831F370E74567B409AB6943236776807AB40D37B46A21FAA2ABC72AF036' }
const move91 = { name: '1763890000000_event_move_agreements', sha256: FINAL_91_SHA }
const fix92 = { name: '1763900000000_event_move_snapshot_operators', sha256: FINAL_92_SHA }
const undated93 = { name: '1763910000000_additional_event_undated', sha256: FINAL_93_SHA }
const bounds94 = { name: '1763920000000_legacy_calendar_bounds', sha256: FINAL_94_SHA }
const backend = realpathSync(resolve('.')), repo = realpathSync(resolve('../..'))
const migrations = join(backend, 'migrations'), support = join(backend, 'test-support')
const tail = 'c04-c05-additional-event-migrations.json'
const fixTail = 'c04-c05-event-move-fix-migrations.json'
const undatedTail = 'c04-c05-undated-additional-migrations.json'
const boundsTail = 'c04-c05-calendar-bounds-migrations.json'
const historical = [
  [83, 'c04-c05-migrations.json', '295E73E8779E28BEE130EFF3786078B4699603AE15D004ADC451DAA4813EAC19'],
  [85, 'c04-c05-fr011-migrations.json', '9F6852E53A9F58C7675C6B3FA77A54E9DB48EED67BFDEE2FCD686CA27BDBBED8'],
  [86, 'c04-c05-resource-erasure-migrations.json', 'CF3FA5ECE8BB97BB2D250D103642AD26134164902509E64E2013DA0BC493F14C'],
  [87, 'c04-c05-day-scope-migrations.json', '8107E7521D6EAFB832682053297676C5F074AA3E694D87E062DD1FF5CCFD7750'],
  [88, 'c04-c05-undated-terminal-migrations.json', 'AE490EC703006E828DF63CDC7D82BFB75337AAD325037D434667EDCAE7F26BC1'],
  [89, 'c04-c05-atomic-day-migrations.json', 'B906F9E38AFB52C2A4A87EACEC4672266458B32E03154B01C2E30CEAB1F901EA'],
] as const
const names = (pins: MigrationPin[]) => pins.map(pin => pin.name)
function expected(count: 83 | 85 | 86 | 87 | 88 | 89 | 90 | 91 | 92 | 93 | 94): MigrationPin[] {
  const pins = historical.filter(([last]) => last <= count).flatMap(([, name]) => JSON.parse(readFileSync(join(support, name), 'utf8')) as MigrationPin[])
  expect(pins).toHaveLength(Math.min(count, 89))
  if (count >= 90) pins.push({ ...offer90 })
  if (count >= 91) {
    assert.match(FINAL_91_SHA, /^[A-F0-9]{64}$/, 'Final migration91 reviewed pin is UNADMITTED; Root SOURCE review required')
    pins.push({ ...move91 })
  }
  if (count >= 92) {
    assert.match(FINAL_92_SHA, /^[A-F0-9]{64}$/, 'Final migration92 reviewed pin is UNADMITTED; Root SOURCE review required')
    pins.push({ ...fix92 })
  }
  if (count === 93 || count === 94) pins.push({ ...undated93 })
  if (count === 94) pins.push({ ...bounds94 })
  expect(pins).toHaveLength(count); expect(new Set(names(pins)).size).toBe(count); expect(names(pins)).toEqual([...names(pins)].sort())
  return pins
}
const tempRoot = realpathSync(tmpdir()), owned = new Set<string>()
function fixture(count: 90 | 91 | 92 | 93 | 94) {
  const pins = expected(count), target = mkdtempSync(join(tempRoot, 'c04c05-additional-')); owned.add(target)
  mkdirSync(join(target, 'data'))
  for (const pin of pins) {
    const source = join(migrations, pin.name + '.cjs'); assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink())
    cpSync(source, join(target, pin.name + '.cjs'), { force: false, errorOnExist: true })
  }
  for (const seed of ['categories.json', 'cities.json']) {
    const source = join(migrations, 'data', seed); assert(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink())
    cpSync(source, join(target, 'data', seed), { force: false, errorOnExist: true })
  }
  return target
}
afterEach(() => {
  try {
    for (const target of owned) {
      expect(dirname(resolve(target))).toBe(tempRoot); expect(target.slice(tempRoot.length + 1)).toMatch(/^c04c05-additional-[A-Za-z0-9]+$/)
      expect(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()).toBe(true)
      expect(realpathSync(target)).toBe(resolve(target))
      rmSync(target, { recursive: true }); owned.delete(target)
    }
  } finally { expect(owned.size, 'Every own native FS fixture must be removed').toBe(0) }
})
const requiredNew = [
  'Тили-тили/backend/test-support/' + undatedTail,
  'Тили-тили/backend/migrations/' + undated93.name + '.cjs',
  'Тили-тили/backend/test/additionalEventUndated.test.ts',
  'Тили-тили/backend/test/additionalEventUndatedMove.test.ts',
  'Тили-тили/backend/test/helpers/additionalEventUndatedFixture.ts',
  'Тили-тили/backend/test-support/additional-event-undated-migration-drill.mjs',
  'Тили-тили/backend/test-support/' + tail,
  'Тили-тили/backend/test-support/' + fixTail,
  'Тили-тили/backend/migrations/' + offer90.name + '.cjs', 'Тили-тили/backend/migrations/' + move91.name + '.cjs',
  'Тили-тили/backend/migrations/' + fix92.name + '.cjs',
  'Тили-тили/backend/test/additionalEventSnapshotValidation.test.ts',
  'Тили-тили/backend/test/c04C05AdditionalEventAdmission.test.ts',
  'Тили-тили/backend/src/deals/program-event-context.ts', 'Тили-тили/backend/src/offers/event-context.ts',
  'Тили-тили/backend/src/orders/event-moves.ts', 'Тили-тили/backend/src/orders/event-move-token.ts',
] as const
const requiredOld = [
  'Тили-тили/backend/test-support/c04-c05-native-admission.mjs', 'Тили-тили/backend/test-support/c04-c05-native-admission.d.mts',
  'Тили-тили/backend/test-support/c04-c05-test-inverse.json', 'Тили-тили/backend/test/c04C05MigrationAdmission.test.ts',
  'Тили-тили/backend/test/c04C05DayScopeAdmission.test.ts', 'Тили-тили/backend/test/c04C05UndatedTerminalAdmission.test.ts',
  'Тили-тили/backend/test/c04C05AtomicDayAdmission.test.ts', 'Тили-тили/backend/test-support/deal-day-scope-atomic-drill.mjs',
  'Тили-тили/backend/src/deals/day-scope-write.ts', 'Тили-тили/backend/src/resources/day-groups.ts', 'Тили-тили/backend/src/resources/legacy-source.ts',
  'Тили-тили/backend/vitest.c04-isolated.config.ts', 'Тили-тили/backend/vitest.c05-worker-isolated.config.ts',
  'Тили-тили/backend/scripts/c04-c05-isolated-lane.mjs', 'Тили-тили/backend/scripts/c04-c05-receipt-barrier-control.mjs',
  'Тили-тили/backend/test-isolated/c04FanoutAdmission.test.ts', 'Тили-тили/backend/test-isolated/c05WorkerFinalBatch.test.ts',
  '.github/workflows/ci.yml', 'init.sh',
] as const
const required94 = [
  'Тили-тили/backend/test-support/c04-c05-calendar-bounds-migrations.json',
  'Тили-тили/backend/migrations/1763920000000_legacy_calendar_bounds.cjs',
  'Тили-тили/backend/test-support/calendar-bounds-migration-drill.mjs',
] as const
function source94() {
  const paths = new Set([
    ...required94, ...expected(94).map(pin => 'Тили-тили/backend/migrations/' + pin.name + '.cjs'),
    ...historical.map(([, name]) => 'Тили-тили/backend/test-support/' + name), ...requiredOld, ...requiredNew,
    'Тили-тили/backend/migrations/data/categories.json', 'Тили-тили/backend/migrations/data/cities.json',
  ])
  const files = [...paths].sort().map(path => ({ path, sha256: fileSHA(join(repo, path)) }))
  return { kind: 'c04_c05_current_source94_v1' as const, backend, repo, files }
}
const entry = (name: string, kind: 'file' | 'directory' | 'symlink'): MigrationEntry => ({ name,
  isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' })

describe('independent C04 C05 additional event current94 admission contract', () => {
  it('F0 current profile requires94 while historical local remains83 without reading unadmitted94 at evaluation', () => {
    const p = { targetName: 'unused', targetURL: 'unused', username: 'unused', port: 5432 }
    expect(profileMigrationCount({ ...p, mode: 'local' } as Profile)).toBe(83)
    expect(profileMigrationCount({ ...p, mode: 'github-ci' } as Profile)).toBe(94)
  })
  it.each(historical)('retains the declared historical%s manifest Git LF bytes', (_count, name, digest) => {
    const text = readFileSync(join(support, name), 'utf8').replaceAll('\r\n', '\n')
    expect(createHash('sha256').update(text).digest('hex').toUpperCase(), name).toBe(digest)
  })
  it.each([83, 85, 86, 87, 88, 89, 90, 91, 92] as const)('keeps exact historical%s reviewed prefix and journal', count => {
    const pins = expected(count); expect(reviewedMigrationPins(count)).toEqual(pins)
    expect(() => assertJournal(names(pins), names(pins))).not.toThrow()
    expect(expected(93).slice(0, count)).toEqual(pins)
  })
  it('requires the closed two-entry90/91 tail and an independently frozen91 literal, never mutable DDL adoption', () => {
    const pins = expected(91)
    expect(pins.slice(0, 90)).toEqual(expected(90)); expect(reviewedMigrationPins(91)).toEqual(pins)
    expect(JSON.parse(readFileSync(join(support, tail), 'utf8'))).toEqual([offer90, move91])
    expect(fileSHA(join(migrations, offer90.name + '.cjs'))).toBe(offer90.sha256)
    expect(fileSHA(join(migrations, move91.name + '.cjs'))).toBe(FINAL_91_SHA)
  })
  it('requires the separate closed92 tail without changing the two-entry90/91 manifest', () => {
    const pins = expected(92)
    expect(pins.slice(0, 91)).toEqual(expected(91)); expect(reviewedMigrationPins(92)).toEqual(pins)
    expect(JSON.parse(readFileSync(join(support, tail), 'utf8'))).toEqual([offer90, move91])
    expect(JSON.parse(readFileSync(join(support, fixTail), 'utf8'))).toEqual([fix92])
    expect(fileSHA(join(migrations, fix92.name + '.cjs'))).toBe(FINAL_92_SHA)
  })
  it('requires the separate reviewed93 tail and keeps all92 historical pins', () => {
    const pins = expected(93)
    expect(pins.slice(0, 92)).toEqual(expected(92)); expect(reviewedMigrationPins(93)).toEqual(pins)
    expect(JSON.parse(readFileSync(join(support, undatedTail), 'utf8'))).toEqual([undated93])
    expect(fileSHA(join(migrations, undated93.name + '.cjs'))).toBe(FINAL_93_SHA)
  })
  it.each([90, 91, 92, 93] as const)('admits physical%s regular migration/seed fixture without extra migration', count => {
    const pins = expected(count); expect(verifyMigrationDirectory(fixture(count), pins)).toEqual(names(pins))
  })
  it.each([82, 84, 95])('refuses unsupported count%s', count => {
    expect(reviewedMigrationPins(94)).toEqual(expected(94)); expect(() => reviewedMigrationPins(count)).toThrow()
  })
  it.each(['truncated', 'extra', 'duplicate', 'reverse'])('refuses %s current93 journal and malformed repeated expectations', mode => {
    const journal = names(expected(93))
    if (mode === 'truncated') journal.pop()
    if (mode === 'extra') journal.push(fix92.name + '_unreviewed')
    if (mode === 'duplicate') journal[91] = journal[90]!
    if (mode === 'reverse') journal.reverse()
    expect(() => assertJournal(journal, names(expected(93)))).toThrow()
    // The truncated92 prefix is explicitly supported historical input, not a
    // malformed expected list. A current93 caller must pin its required tail.
    if (mode !== 'truncated') expect(() => assertJournal(journal, journal)).toThrow()
  })
  it.each(['missing90', 'missing91', 'missing92', 'missing93', 'extra', 'symlink90', 'symlink91', 'symlink92', 'symlink93', 'duplicate'])('refuses %s directory entry metadata', mode => {
    const pins = expected(93), entries = [...pins.map(pin => entry(pin.name + '.cjs', 'file')), entry('data', 'directory')]
    expect(() => assertMigrationFiles(entries, pins)).not.toThrow()
    let changed = [...entries]
    const selected = mode.endsWith('90') ? offer90 : mode.endsWith('91') ? move91 : mode.endsWith('92') ? fix92 : undated93
    if (mode.startsWith('missing')) changed = changed.filter(row => row.name !== selected.name + '.cjs')
    if (mode === 'extra') changed.push(entry('unreviewed.cjs', 'file'))
    if (mode.startsWith('symlink')) changed = changed.map(row => row.name === selected.name + '.cjs' ? entry(row.name, 'symlink') : row)
    if (mode === 'duplicate') changed.push(entry(fix92.name + '.cjs', 'file'))
    expect(() => assertMigrationFiles(changed, pins)).toThrow()
  })
  it.each([89, 90, 91, 92])('refuses changed bytes plus caller-rehashed substitution at index%s', index => {
    const pins = expected(93), target = fixture(93), file = join(target, pins[index]!.name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// OWN changed byte control\n')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
    const changed = pins.map(pin => ({ ...pin })); changed[index]!.sha256 = fileSHA(file)
    expect(changed[index]!.sha256).not.toBe(pins[index]!.sha256); expect(() => verifyMigrationDirectory(target, changed)).toThrow()
  })
  it.each(['extra', 'changed'])('retains seed %s refusal', mode => {
    const pins = expected(93), target = fixture(93)
    if (mode === 'extra') writeFileSync(join(target, 'data/unknown.json'), '{}')
    else { const file = join(target, 'data/cities.json'); writeFileSync(file, readFileSync(file, 'utf8') + '\n') }
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
  })
  it('requires the separate closed94 tail and exact93 prefix before current94 controls', () => {
    const pins = expected(94)
    expect(pins.slice(0, 93)).toEqual(expected(93)); expect(reviewedMigrationPins(94)).toEqual(pins)
    expect(JSON.parse(readFileSync(join(support, boundsTail), 'utf8'))).toEqual([bounds94])
    expect(fileSHA(join(migrations, bounds94.name + '.cjs'))).toBe(FINAL_94_SHA)
    expect(verifyMigrationDirectory(fixture(94), pins)).toEqual(names(pins))
  })
  it.each(['truncated', 'extra', 'duplicate', 'reverse'])('refuses %s current94 journal after exact positive94', mode => {
    const pins = expected(94), journal = names(pins)
    expect(() => assertJournal(journal, journal)).not.toThrow()
    if (mode === 'truncated') journal.pop()
    if (mode === 'extra') journal.push('1763930000000_unreviewed')
    if (mode === 'duplicate') journal[93] = journal[92]!
    if (mode === 'reverse') journal.reverse()
    expect(() => assertJournal(journal, names(pins))).toThrow()
    if (mode !== 'truncated') expect(() => assertJournal(journal, journal)).toThrow()
  })
  it.each(['missing94', 'symlink94', 'future95', 'duplicate'])('refuses %s metadata after exact positive94', mode => {
    const pins = expected(94), entries = [...pins.map(pin => entry(pin.name + '.cjs', 'file')), entry('data', 'directory')]
    expect(() => assertMigrationFiles(entries, pins)).not.toThrow()
    let changed = [...entries]
    if (mode === 'missing94') changed = changed.filter(row => row.name !== bounds94.name + '.cjs')
    if (mode === 'symlink94') changed = changed.map(row => row.name === bounds94.name + '.cjs' ? entry(row.name, 'symlink') : row)
    if (mode === 'future95') changed.push(entry('1763930000000_future.cjs', 'file'))
    if (mode === 'duplicate') changed.push(entry(bounds94.name + '.cjs', 'file'))
    expect(() => assertMigrationFiles(changed, pins)).toThrow()
  })
  it('refuses changed94 bytes and a caller-rehashed94 substitution after positive94', () => {
    const pins = expected(94), target = fixture(94), file = join(target, bounds94.name + '.cjs')
    expect(verifyMigrationDirectory(target, pins)).toEqual(names(pins))
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// OWN changed94 byte control\n')
    expect(() => verifyMigrationDirectory(target, pins)).toThrow()
    const changed = pins.map(pin => ({ ...pin })); changed[93]!.sha256 = fileSHA(file)
    expect(changed[93]!.sha256).not.toBe(FINAL_94_SHA); expect(() => verifyMigrationDirectory(target, changed)).toThrow()
  })
  it('qualifies the current94 real source bytes before any omission negative', () => {
    expect(verifySource(source94())).toEqual(names(expected(94)))
  })
  it.each([...requiredNew, ...required94])('requires critical additional/move source input %s', omitted => {
    const source = source94(); expect(verifySource(source)).toEqual(names(expected(94)))
    expect(source.files.some(row => row.path === omitted)).toBe(true)
    expect(() => verifySource({ ...source, files: source.files.filter(row => row.path !== omitted) })).toThrow()
  })
  it.each(['duplicate', 'hash', 'source90', 'source91', 'source92', 'source93', 'future95'])('refuses %s current source while preserving a positive94 control', mode => {
    const source = source94(); expect(verifySource(source)).toEqual(names(expected(94)))
    if (mode === 'duplicate') expect(() => verifySource({ ...source, files: [...source.files, source.files[0]!] })).toThrow()
    if (mode === 'hash') {
      const files = source.files.map(row => ({ ...row })); files.find(row => row.path === requiredNew[0])!.sha256 = '0'.repeat(64)
      expect(() => verifySource({ ...source, files })).toThrow()
    }
    if (mode === 'source90') expect(() => verifySource({ ...source, kind: 'c04_c05_current_source90_v1' })).toThrow()
    if (mode === 'source91') expect(() => verifySource({ ...source, kind: 'c04_c05_current_source91_v1' })).toThrow()
    if (mode === 'source92') expect(() => verifySource({ ...source, kind: 'c04_c05_current_source92_v1' })).toThrow()
    if (mode === 'source93') expect(() => verifySource({ ...source, kind: 'c04_c05_current_source93_v1' })).toThrow()
    if (mode === 'future95') expect(() => verifySource({ ...source, kind: 'c04_c05_current_source95_v1' as typeof source.kind })).toThrow()
  })
})
