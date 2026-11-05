import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertJournal, assertMigrationFiles, fileSHA, reviewedMigrationPins, verifyMigrationDirectory, verifySource } from '../test-support/c04-c05-native-admission.mjs'

const backend = realpathSync(resolve('.')), repo = realpathSync(resolve('../..')), directory = join(backend, 'migrations')
const current = reviewedMigrationPins(99), names = current.map(p => p.name)
const media = { name: '1764830000000_managed_portfolio_media', sha256: '2FCDAA78A7350E8A2C01649B6F500C1FC8A727A3616E440B62BED9C2522F059C' }
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean)
const source = { kind: 'c04_c05_current_source99_v1' as const, backend, repo, files: paths.map(path => ({ path, sha256: fileSHA(join(repo, path)) })) }
const required = [
  'test-support/c04-c05-managed-media-migrations.json', 'test-support/managed-media-migration-drill.mjs', 'test/c04C05ManagedMediaAdmission.test.ts',
  'migrations/1764830000000_managed_portfolio_media.cjs', 'src/media/config.ts', 'src/media/storage.ts', 'src/media/scanner.ts', 'src/media/photo.ts',
  'src/media/service.ts', 'src/media/portfolio.ts', 'src/media/routes.ts', 'src/app.ts', 'src/routes/vendor.ts', 'src/routes/users.ts', 'src/jobs/index.ts',
  'src/vendor/profile-locks.ts', 'src/auth/consent.ts', 'test/mediaManagedApi.test.ts', 'test/mediaConfig.test.ts', 'test/mediaStorage.test.ts',
  'test/mediaScanner.test.ts', 'test/mediaPhoto.test.ts', 'test/helpers/managedMediaFixture.ts', 'test/helpers/mediaTransportFixture.ts', 'vitest.serial.json',
  'src/contract/api.generated.ts', 'src/contract/paths.generated.ts', 'src/contract/schemas.generated.ts',
].map(p => 'Тили-тили/backend/' + p).concat(['Тили-тили/Тили-тили_API_openapi.yaml'], [
  'src/components/PortfolioPhotos.tsx', 'src/components/PortfolioPhotos.test.tsx', 'src/pages/VendorApp.tsx', 'src/lib/api/client.ts',
  'src/lib/api/vendor.ts', 'src/lib/api/media.ts', 'src/lib/api/media.test.ts', 'src/lib/api/schema.ts', 'src/lib/i18n.en.media.ts', 'src/lib/i18n.en.ts', 'src/lib/dictionary.test.ts', 'src/lib/mediaErrorTranslations.test.ts',
].map(p => 'Тили-тили/app/' + p))
const parent = realpathSync(tmpdir()), owned = new Set<string>()
function fixture() {
  const root = mkdtempSync(join(parent, 'c04c05-media99-')); owned.add(root)
  writeFileSync(join(root, 'owner.json'), JSON.stringify({ owner: 'c04C05ManagedMediaAdmission', root,
    purpose: 'byte-exact schema99 negative controls', result: 'Vitest', cleanup: 'afterEach' }), { flag: 'wx' })
  const target = join(root, 'migrations'); mkdirSync(target); mkdirSync(join(target, 'data'))
  for (const p of current) copyFileSync(join(directory, p.name + '.cjs'), join(target, p.name + '.cjs'))
  for (const name of ['categories.json', 'cities.json']) copyFileSync(join(directory, 'data', name), join(target, 'data', name))
  return target
}
afterEach(() => {
  for (const root of owned) {
    expect(dirname(root)).toBe(parent); expect(root.slice(parent.length + 1)).toMatch(/^c04c05-media99-[A-Za-z0-9]+$/)
    expect(realpathSync(root)).toBe(root); rmSync(root, { recursive: true }); owned.delete(root)
  }
})
describe('independently pinned managed-media schema99 admission', () => {
  it('retains the exact98 historical pins and separately admits current99 physical SQL and complete SOURCE', () => {
    expect(current.slice(0, 98)).toEqual(reviewedMigrationPins(98)); expect(current.at(-1)).toEqual(media)
    expect(fileSHA(join(directory, media.name + '.cjs'))).toBe(media.sha256)
    expect(verifyMigrationDirectory(directory, current)).toEqual(names); expect(verifySource(source)).toEqual(names)
    expect(() => assertJournal(names, names)).not.toThrow()
    expect(() => verifyMigrationDirectory(directory, reviewedMigrationPins(98))).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source98_v1' })).toThrow()
    expect(() => reviewedMigrationPins(100)).toThrow(); expect(() => reviewedMigrationPins(84)).toThrow()
  })
  it.each(required)('refuses incomplete current99 source missing %s', path => {
    expect(source.files.some(f => f.path === path)).toBe(true)
    expect(() => verifySource({ ...source, files: source.files.filter(f => f.path !== path) })).toThrow()
  })
  it('rejects SQL tampering even with caller-rehashed99 and retains its positive exact-byte fixture', () => {
    const target = fixture(), file = join(target, media.name + '.cjs')
    expect(verifyMigrationDirectory(target, current)).toEqual(names)
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// tampered\n')
    expect(() => verifyMigrationDirectory(target, current)).toThrow()
    expect(() => verifyMigrationDirectory(target, [...current.slice(0, 98), { ...media, sha256: fileSHA(file) }])).toThrow()
  })
  it('rejects missing99, duplicate entries, nonregular SQL, extra migration and mutated data seed', () => {
    const entries = readdirSync(directory, { withFileTypes: true })
    expect(() => assertMigrationFiles(entries, current)).not.toThrow()
    expect(() => assertMigrationFiles(entries.filter(e => e.name !== media.name + '.cjs'), current)).toThrow()
    expect(() => assertMigrationFiles([...entries, entries[0]!], current)).toThrow()
    expect(() => assertMigrationFiles(entries.map(e => e.name === media.name + '.cjs'
      ? { name: e.name, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true } : e), current)).toThrow()
    const target = fixture(), seed = join(target, 'data', 'cities.json')
    writeFileSync(join(target, '1764840000000_unknown.cjs'), 'throw Error("not admitted")')
    expect(() => verifyMigrationDirectory(target, current)).toThrow()
    rmSync(join(target, '1764840000000_unknown.cjs'))
    writeFileSync(seed, readFileSync(seed, 'utf8') + '\n')
    expect(() => verifyMigrationDirectory(target, current)).toThrow()
  })
})
