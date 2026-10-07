// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertJournal, assertMigrationFiles, verifyMigrationDirectory, fileSHA, reviewedMigrationPins, verifySource, type MigrationPin, type MigrationEntry } from '../test-support/c04-c05-native-admission.mjs'

const directory = resolve('migrations')
const base: MigrationPin[] = reviewedMigrationPins(83)
const current: MigrationPin[] = reviewedMigrationPins(85), tail = current.slice(83), names = current.map(p => p.name)
const entries = readdirSync(directory, { withFileTypes: true })
const tempRoot = resolve(tmpdir()), owned = new Set<string>()
function fixture(count: 83 | 85 = 83) {
  const target = mkdtempSync(join(tempRoot, 'c04c05-guard-')); owned.add(target)
  cpSync(directory, target, { recursive: true })
  if (count === 83) for (const row of tail) rmSync(join(target, row.name + '.cjs'))
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
  it('admits the actual current85 directory and all bytes including seeds', () => {
    expect(verifyMigrationDirectory(directory, current)).toEqual(names)
  })
  it('admits the exact85 journal', () => expect(() => assertJournal(names, names)).not.toThrow())
  it('retains the exact historical83 journal', () => {
    const historical = base.map(p => p.name); expect(() => assertJournal(historical, historical)).not.toThrow()
  })
  it.each([84, 86])('rejects unreviewed migration count %s', count => {
    const attempted = count === 84 ? names.slice(0, 84) : [...names, '1763840000000_unreviewed']
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
  it('rejects a substituted current tail', () => {
    const renamed = [...names]; renamed[84] += '_changed'
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
  it('requires this regression test in the actual current85 source receipt', () => {
    const repo = realpathSync(resolve('../..')), backend = realpathSync(resolve('.'))
    const result = spawnSync('git', ['-c', 'safe.directory=' + repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', windowsHide: true })
    expect(result.status).toBe(0)
    const files = [...new Set(result.stdout.split('\0').filter(p => p && !p.includes('/.ci/') && !p.includes('/node_modules/') && !p.includes('/dist/')))]
      .sort().map(path => ({ path, sha256: fileSHA(join(repo, path)) }))
    const source = { kind: 'c04_c05_current_source85_v1' as const, backend, repo, files }
    expect(verifySource(source)).toEqual(names)
    const omitted = 'Тили-тили/backend/test/c04C05MigrationAdmission.test.ts'
    expect(files.some(row => row.path === omitted)).toBe(true)
    expect(() => verifySource({ ...source, files: files.filter(row => row.path !== omitted) })).toThrow()
  })
  it('refuses an altered current tail even when caller supplies its new hash', () => {
    const target = fixture(85), file = join(target, current[83].name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// own changed current tail\n')
    const attempted = current.map(row => ({ ...row }))
    attempted[83].sha256 = fileSHA(file)
    let failure: unknown; try { verifyMigrationDirectory(target, attempted) } catch (e) { failure = e }
    expect(failure).toMatchObject({ actual: attempted, expected: current })
  })
  it('checks all original83 bytes rather than allowing a name-only match', () => {
    const target = fixture(); const file = join(target, base[0].name + '.cjs')
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// fixture byte change\n')
    let failure: unknown; try { verifyMigrationDirectory(target, base) } catch (e) { failure = e }
    expect(failure).toMatchObject({ actual: fileSHA(file), expected: base[0].sha256 })
  })
  it('checks original seed bytes and refuses extra seed entries', () => {
    const target = fixture(), data = join(target, 'data')
    writeFileSync(join(data, 'unexpected.json'), '{}')
    expect(() => verifyMigrationDirectory(target, base)).toThrow()
    rmSync(join(data, 'unexpected.json'))
    const file = join(data, 'categories.json'); const oldHash = fileSHA(file)
    writeFileSync(file, readFileSync(file, 'utf8') + '\n')
    let failure: unknown; try { verifyMigrationDirectory(target, base) } catch (e) { failure = e }
    expect(failure).toMatchObject({ actual: fileSHA(file), expected: oldHash })
  })
})
