import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertJournal, assertMigrationFiles, fileSHA, reviewedMigrationPins, verifyMigrationDirectory, verifySource } from '../test-support/c04-c05-native-admission.mjs'

const backend = realpathSync(resolve('.')), repo = realpathSync(resolve('../..')), directory = join(backend, 'migrations')
const current = reviewedMigrationPins(99), names = current.map(p => p.name)
const history = reviewedMigrationPins(100), historyNames = history.map(p => p.name)
const latest = reviewedMigrationPins(101), latestNames = latest.map(p => p.name)
const planB = reviewedMigrationPins(102), planBNames = planB.map(p => p.name)
const scenarios = reviewedMigrationPins(103), scenarioNames = scenarios.map(p => p.name)
const guestAddress = reviewedMigrationPins(104), guestAddressNames = guestAddress.map(p => p.name)
const coordination = reviewedMigrationPins(105), coordinationNames = coordination.map(p => p.name)
const urgent = reviewedMigrationPins(106), urgentNames = urgent.map(p => p.name)
const delivery = reviewedMigrationPins(107), deliveryNames = delivery.map(p => p.name)
const deliveryFiles = reviewedMigrationPins(108), deliveryFileNames = deliveryFiles.map(p => p.name)
const thanks = reviewedMigrationPins(109), thanksNames = thanks.map(p => p.name)
const media = { name: '1764830000000_managed_portfolio_media', sha256: '2FCDAA78A7350E8A2C01649B6F500C1FC8A727A3616E440B62BED9C2522F059C' }
const album = { name: '1764840000000_managed_guest_album', sha256: '7C6BC9569EFFA42992D23F3EF680D5FDFAB17F56DAE9B954A26B9DC8F8E89700' }
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean)
const contract = { name: '1764850000000_managed_contract_attachment', sha256: '870F039C20CFB231536BE7F6A51C2AFB431F419A58317144956E7646474EE2C3' }
const batch = { name: '1764860000000_planb_notification_batches', sha256: 'A741850B56DF5A289675C5F1B57544CF253747F426C96FAAE1ABCEA3024366AA' }
const source = { kind: 'c04_c05_current_source109_v1' as const, backend, repo, files: paths.map(path => ({ path, sha256: fileSHA(join(repo, path)) })) }
const required = [
  'test-support/c04-c05-managed-media-migrations.json', 'test-support/managed-media-migration-drill.mjs', 'test/c04C05ManagedMediaAdmission.test.ts',
  'migrations/1764830000000_managed_portfolio_media.cjs', 'src/media/config.ts', 'src/media/storage.ts', 'src/media/scanner.ts', 'src/media/photo.ts',
  'src/media/service.ts', 'src/media/portfolio.ts', 'src/media/routes.ts', 'src/app.ts', 'src/routes/vendor.ts', 'src/routes/users.ts', 'src/jobs/index.ts',
  'src/vendor/profile-locks.ts', 'src/auth/consent.ts', 'test/mediaManagedApi.test.ts', 'test/mediaConfig.test.ts', 'test/mediaStorage.test.ts',
  'test/mediaScanner.test.ts', 'test/mediaPhoto.test.ts', 'test/helpers/managedMediaFixture.ts', 'test/helpers/mediaTransportFixture.ts', 'vitest.serial.json',
  'src/contract/api.generated.ts', 'src/contract/paths.generated.ts', 'src/contract/schemas.generated.ts',
  'migrations/1764860000000_planb_notification_batches.cjs', 'test-support/c04-c05-planb-migrations.json',
  'test-support/planb-notification-migration-drill.mjs', 'src/routes/dayx.ts', 'src/notify/delivery-status.ts',
  'src/notify/enrolled.ts', 'test/planbInitialization.test.ts',
  'migrations/1764870000000_planb_scenarios.cjs', 'test-support/c04-c05-planb-scenario-migrations.json',
  'src/planb/scenarios.ts', 'src/planb/preview.ts', 'src/wedding/access.ts',
  'migrations/1764880000000_planb_guest_address.cjs', 'test-support/c04-c05-planb-guest-migrations.json', 'src/routes/day.ts',
  'migrations/1764890000000_dayx_coordination.cjs', 'test-support/c04-c05-dayx-coordination-migrations.json', 'src/routes/dayxCoordination.ts',
  'migrations/1764900000000_planb_urgent_event.cjs', 'test-support/c04-c05-planb-urgent-event-migrations.json',
  'src/notify/planb-urgency.ts', 'src/notify/preflight.ts', 'src/notify/notice-transactions.ts', 'src/notify/notify.ts',
].map(p => 'Тили-тили/backend/' + p).concat(['Тили-тили/Тили-тили_API_openapi.yaml'], [
  'src/components/PortfolioPhotos.tsx', 'src/components/PortfolioPhotos.test.tsx', 'src/pages/VendorApp.tsx', 'src/lib/api/client.ts',
  'src/components/AlbumPhotoImage.tsx', 'src/pages/GuestAlbum.tsx', 'src/lib/api/album.ts',
  'src/pages/Smart.tsx', 'src/components/DayXCoordination.tsx', 'src/components/PlanBPreviewDetails.tsx', 'src/lib/api/weddingWrite.ts',
  'src/lib/api/vendor.ts', 'src/lib/api/media.ts', 'src/lib/api/media.test.ts', 'src/lib/api/schema.ts', 'src/lib/i18n.en.media.ts', 'src/lib/i18n.en.ts', 'src/lib/dictionary.test.ts', 'src/lib/mediaErrorTranslations.test.ts',
].map(p => 'Тили-тили/app/' + p))
const parent = realpathSync(tmpdir()), owned = new Set<string>()
function fixture(pins = current) {
  const root = mkdtempSync(join(parent, 'c04c05-media99-')); owned.add(root)
  writeFileSync(join(root, 'owner.json'), JSON.stringify({ owner: 'c04C05ManagedMediaAdmission', root,
    purpose: 'byte-exact media schema negative controls', result: 'Vitest', cleanup: 'afterEach' }), { flag: 'wx' })
  const target = join(root, 'migrations'); mkdirSync(target); mkdirSync(join(target, 'data'))
  for (const p of pins) copyFileSync(join(directory, p.name + '.cjs'), join(target, p.name + '.cjs'))
  for (const name of ['categories.json', 'cities.json']) copyFileSync(join(directory, 'data', name), join(target, 'data', name))
  return target
}
afterEach(() => {
  for (const root of owned) {
    expect(dirname(root)).toBe(parent); expect(root.slice(parent.length + 1)).toMatch(/^c04c05-media99-[A-Za-z0-9]+$/)
    expect(realpathSync(root)).toBe(root); rmSync(root, { recursive: true }); owned.delete(root)
  }
})
describe('independently pinned managed-media admissions', () => {
  it('retains historic99–108 and admits current109 physical SQL and complete SOURCE', () => {
    expect(current.slice(0, 98)).toEqual(reviewedMigrationPins(98)); expect(current.at(-1)).toEqual(media)
    expect(fileSHA(join(directory, media.name + '.cjs'))).toBe(media.sha256)
    expect(verifyMigrationDirectory(fixture(), current)).toEqual(names)
    expect(history.slice(0, 99)).toEqual(current); expect(history.at(-1)).toEqual(album)
    expect(fileSHA(join(directory, album.name + '.cjs'))).toBe(album.sha256)
    expect(latest.slice(0, 100)).toEqual(history); expect(latest.at(-1)).toEqual(contract)
    expect(fileSHA(join(directory, contract.name + '.cjs'))).toBe(contract.sha256)
    expect(verifyMigrationDirectory(fixture(latest), latest)).toEqual(latestNames)
    expect(planB.slice(0, 101)).toEqual(latest); expect(planB.at(-1)).toEqual(batch)
    expect(fileSHA(join(directory, batch.name + '.cjs'))).toBe(batch.sha256)
    expect(verifyMigrationDirectory(fixture(planB), planB)).toEqual(planBNames)
    expect(scenarios.slice(0, 102)).toEqual(planB)
    expect(verifyMigrationDirectory(fixture(scenarios), scenarios)).toEqual(scenarioNames)
    expect(guestAddress.slice(0, 103)).toEqual(scenarios)
    expect(verifyMigrationDirectory(fixture(guestAddress), guestAddress)).toEqual(guestAddressNames)
    expect(coordination.slice(0, 104)).toEqual(guestAddress)
    expect(verifyMigrationDirectory(fixture(coordination), coordination)).toEqual(coordinationNames)
    expect(urgent.slice(0, 105)).toEqual(coordination)
    expect(verifyMigrationDirectory(fixture(urgent), urgent)).toEqual(urgentNames)
    expect(delivery.slice(0, 106)).toEqual(urgent)
    expect(verifyMigrationDirectory(fixture(delivery), delivery)).toEqual(deliveryNames)
    expect(deliveryFiles.slice(0, 107)).toEqual(delivery)
    expect(verifyMigrationDirectory(fixture(deliveryFiles), deliveryFiles)).toEqual(deliveryFileNames)
    expect(thanks.slice(0, 108)).toEqual(deliveryFiles)
    expect(verifyMigrationDirectory(directory, thanks)).toEqual(thanksNames)
    expect(verifySource(source)).toEqual(thanksNames)
    expect(() => assertJournal(planBNames, planBNames)).not.toThrow()
    expect(() => verifyMigrationDirectory(directory, reviewedMigrationPins(98))).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source98_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source99_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source100_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source101_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source102_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source103_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source104_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source105_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source106_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source107_v1' })).toThrow()
    expect(() => verifySource({ ...source, kind: 'c04_c05_current_source108_v1' })).toThrow()
    expect(() => reviewedMigrationPins(110)).toThrow(); expect(() => reviewedMigrationPins(84)).toThrow()
  })
  it.each(required)('refuses incomplete current109 source missing %s', path => {
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
  it('rejects SQL tampering of schema100 even with a caller-rehashed pin', () => {
    const target = fixture(history), file = join(target, album.name + '.cjs')
    expect(verifyMigrationDirectory(target, history)).toEqual(historyNames)
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// tampered\n')
    expect(() => verifyMigrationDirectory(target, history)).toThrow()
    expect(() => verifyMigrationDirectory(target, [...history.slice(0, 99), { ...album, sha256: fileSHA(file) }])).toThrow()
  })
  it('rejects SQL tampering of schema101 even with a caller-rehashed pin', () => {
    const target = fixture(latest), file = join(target, contract.name + '.cjs')
    expect(verifyMigrationDirectory(target, latest)).toEqual(latestNames)
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// tampered\n')
    expect(() => verifyMigrationDirectory(target, latest)).toThrow()
    expect(() => verifyMigrationDirectory(target, [...latest.slice(0, 100), { ...contract, sha256: fileSHA(file) }])).toThrow()
  })
  it('rejects missing99, duplicate entries, nonregular SQL, extra migration and mutated data seed', () => {
    const entries = readdirSync(directory, { withFileTypes: true })
    expect(() => assertMigrationFiles(entries, thanks)).not.toThrow()
    expect(() => assertMigrationFiles(entries.filter(e => e.name !== media.name + '.cjs'), thanks)).toThrow()
    expect(() => assertMigrationFiles(entries.filter(e => e.name !== '1764910000000_order_deliveries.cjs'), thanks)).toThrow()
    expect(() => assertMigrationFiles(entries.filter(e => e.name !== '1764920000000_order_delivery_files.cjs'), thanks)).toThrow()
    expect(() => assertMigrationFiles(entries.filter(e => e.name !== '1764930000000_guest_thanks.cjs'), thanks)).toThrow()
    expect(() => assertMigrationFiles([...entries, entries[0]!], thanks)).toThrow()
    expect(() => assertMigrationFiles(entries.map(e => e.name === media.name + '.cjs'
      ? { name: e.name, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true } : e), thanks)).toThrow()
    const target = fixture(), seed = join(target, 'data', 'cities.json')
    writeFileSync(join(target, '1764840000000_unknown.cjs'), 'throw Error("not admitted")')
    expect(() => verifyMigrationDirectory(target, current)).toThrow()
    rmSync(join(target, '1764840000000_unknown.cjs'))
    writeFileSync(seed, readFileSync(seed, 'utf8') + '\n')
    expect(() => verifyMigrationDirectory(target, current)).toThrow()
  })
})
