// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertJournal, assertMigrationFiles, verifyMigrationDirectory, fileSHA, reviewedMigrationPins, verifySource, profileMigrationCount, type MigrationPin, type MigrationEntry } from '../test-support/c04-c05-native-admission.mjs'

const directory = resolve('migrations')
const base: MigrationPin[] = reviewedMigrationPins(83)
const previous: MigrationPin[] = reviewedMigrationPins(85), historical86: MigrationPin[] = reviewedMigrationPins(86), current: MigrationPin[] = reviewedMigrationPins(87), names = current.map(p => p.name)
const entries = readdirSync(directory, { withFileTypes: true })
const tempRoot = resolve(tmpdir()), owned = new Set<string>()
function fixture(count: 83 | 85 | 86 | 87 = 83) {
  const target = mkdtempSync(join(tempRoot, 'c04c05-guard-')); owned.add(target)
  cpSync(directory, target, { recursive: true })
  for (const row of current.slice(count)) rmSync(join(target, row.name + '.cjs'))
  return target
}
afterEach(() => {
  for (const target of owned) {
    expect(dirname(resolve(target))).toBe(tempRoot)
    expect(target.slice(tempRoot.length + 1)).toMatch(/^c04c05-guard-[A-Za-z0-9]+$/)
    rmSync(target, { recursive: true }); owned.delete(target)
  }
})
const fake = (name: string, kind: 'file' | 'directory' | 'symlink'): MigrationEntry => ({ name,
  isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' })

describe('C04 C05 closed current and historical migration admission', () => {
  it('admits the actual current87 directory and all bytes including seeds', () => {
    expect(verifyMigrationDirectory(directory, current)).toEqual(names)
  })
  it('admits the exact87 journal', () => expect(() => assertJournal(names, names)).not.toThrow())
  it('retains the exact historical86 journal, directory and prefix including seed bytes', () => {
    const historical = historical86.map(p => p.name); expect(() => assertJournal(historical, historical)).not.toThrow()
    expect(verifyMigrationDirectory(fixture(86), historical86)).toEqual(historical)
    expect(current.slice(0, 86)).toEqual(historical86); expect(historical86.slice(0, 85)).toEqual(previous)
  })
  it('retains the exact previous85 journal and directory with all bytes including seeds', () => {
    const historical = previous.map(p => p.name); expect(() => assertJournal(historical, historical)).not.toThrow()
    expect(verifyMigrationDirectory(fixture(85), previous)).toEqual(historical)
    expect(current.slice(0, 85)).toEqual(previous); expect(previous.slice(0, 83)).toEqual(base)
  })
  it('requires current87 in CI and preserves historical83 for the local profile', () => {
    const profile = { targetName: 'unused', targetURL: 'unused', username: 'unused', port: 5432 }
    expect(profileMigrationCount({ ...profile, mode: 'github-ci' })).toBe(87)
    expect(profileMigrationCount({ ...profile, mode: 'local' })).toBe(83)
  })
  it('retains the exact historical83 journal', () => {
    const historical = base.map(p => p.name); expect(() => assertJournal(historical, historical)).not.toThrow()
    expect(verifyMigrationDirectory(fixture(83), base)).toEqual(historical)
  })
  it.each([84, 88])('rejects unreviewed migration count %s', count => {
    const attempted = count === 84 ? names.slice(0, 84) : [...names, '1763860000000_unreviewed']
    expect(() => assertJournal(attempted, attempted)).toThrow()
  })
  it('rejects an altered historical name even when count and latest are retained', () => {
    const historical = base.map(p => p.name); historical[0] += '_unknown'
    expect(() => assertJournal(historical, historical)).toThrow()
  })
  it('rejects missing, duplicate and out of order journal rows', () => {
    expect(() => assertJournal(names.slice(1), names)).toThrow()
    const duplicate = [...names]; duplicate[0] = duplicate[1]
    expect(() => assertJournal(duplicate, duplicate)).toThrow()
    expect(() => assertJournal([...names].reverse(), [...names].reverse())).toThrow()
  })
  it.each([83, 84, 85, 86])('rejects a substituted reviewed tail at index %s', index => {
    const renamed = [...names]; renamed[index] += '_changed'
    expect(() => assertJournal(renamed, renamed)).toThrow()
  })
  it('admits only the exact current regular migration files and data directory', () => {
    expect(() => assertMigrationFiles(entries, current)).not.toThrow()
  })
  it.each(['1763840000000_future.cjs', 'extra.js', 'extra.cjs.disabled'])('rejects unexpected file %s', name => {
    expect(() => assertMigrationFiles([...entries, fake(name, 'file')], current)).toThrow()
  })
  it('rejects extra directories and a regular file in place of data', () => {
    expect(() => assertMigrationFiles([...entries, fake('unknown', 'directory')], current)).toThrow()
    expect(() => assertMigrationFiles(entries.map(e => e.name === 'data' ? fake('data', 'file') : e), current)).toThrow()
  })
  it('rejects a symlink in place of a reviewed migration', () => {
    expect(() => assertMigrationFiles(entries.map(e => e.name === base[0].name + '.cjs' ? fake(e.name, 'symlink') : e), current)).toThrow()
  })
  it.each(['Тили-тили/backend/test/c04C05MigrationAdmission.test.ts',
    'Тили-тили/backend/test-support/c04-c05-resource-erasure-migrations.json',
    'Тили-тили/backend/migrations/1763840000000_resource_source_erasure.cjs',
    'Тили-тили/backend/test-support/c04-c05-day-scope-migrations.json',
    'Тили-тили/backend/migrations/1763850000000_deal_day_scope_foundation.cjs',
    'Тили-тили/backend/test/c04C05DayScopeAdmission.test.ts'])('requires %s in the actual current87 source receipt', omitted => {
    const repo = realpathSync(resolve('../..')), backend = realpathSync(resolve('.'))
    const result = spawnSync('git', ['-c', 'safe.directory=' + repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', windowsHide: true })
    expect(result.status).toBe(0)
    const files = [...new Set(result.stdout.split('\0').filter(p => p && !p.includes('/.ci/') && !p.includes('/node_modules/') && !p.includes('/dist/')))]
      .sort().map(path => ({ path, sha256: fileSHA(join(repo, path)) }))
    const source = { kind: 'c04_c05_current_source87_v1' as const, backend, repo, files }
    expect(verifySource(source)).toEqual(names)
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source88_v1' as typeof source.kind })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source86_v1' as Parameters<typeof verifySource>[0]['kind'] })).toThrow()
    expect(files.some(row => row.path === omitted)).toBe(true)
    expect(() => verifySource({ ...source, files: files.filter(row => row.path !== omitted) })).toThrow()
  })
  it.each([83, 84, 85, 86])('refuses altered reviewed tail %s even when caller supplies its new hash', index => {
    const target = fixture(87), file = join(target, current[index].name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// own changed current tail\n')
    const attempted = current.map(row => ({ ...row }))
    attempted[index].sha256 = fileSHA(file)
    let failure: unknown; try { verifyMigrationDirectory(target, attempted) } catch (e) { failure = e }
    expect(failure).toMatchObject({ actual: attempted, expected: current })
  })
  it('checks all original83 bytes rather than allowing a name-only match', () => {
    const target = fixture(); const file = join(target, base[0].name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// fixture byte change\n')
    let failure: unknown; try { verifyMigrationDirectory(target, base) } catch (e) { failure = e }
    expect(failure).toMatchObject({ actual: fileSHA(file), expected: base[0].sha256 })
  })
  it.each([83, 85, 86, 87] as const)('checks original seed bytes and refuses extra seed entries at schema%s', count => {
    const target = fixture(count), data = join(target, 'data'), expected = reviewedMigrationPins(count)
    writeFileSync(join(data, 'unexpected.json'), '{}')
    expect(() => verifyMigrationDirectory(target, expected)).toThrow()
    rmSync(join(data, 'unexpected.json'))
    const file = join(data, 'categories.json'); const oldHash = fileSHA(file)
    writeFileSync(file, readFileSync(file, 'utf8') + '\n')
    let failure: unknown; try { verifyMigrationDirectory(target, expected) } catch (e) { failure = e }
    expect(failure).toMatchObject({ actual: fileSHA(file), expected: oldHash })
  })
})
