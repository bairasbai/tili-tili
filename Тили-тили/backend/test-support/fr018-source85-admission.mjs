// Explicit local source85 admission. Historical source83 suites/pins are preserved.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { reviewedMigrationPins, verifyMigrationDirectory, assertFKs } from './c04-c05-native-admission.mjs'

const backend = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const checkout = path.resolve(backend, '../..')
const evidence = path.resolve('C:/Тили-тили/.unlazy/wp00-sc004-current-20261014')
const TARGET = 'tili_ecosystem_fr018_source85_20261014_test'
const DATABASE = 'postgres://codex_test@127.0.0.1:15432/' + TARGET
const OID = '23108'
const SYSID = '7696198290725246844'
const PGDIR = 'C:/Users/Bayra/.codex/visualizations/2026/10/13/01a1360d-bb5e-7792-84fc-6fbc3dc7f04d/wp00-replay-test/pgdata'
const ONBOARDING = '36a5698f6416627b4e42ce73b4a1abd558f4bf82'
const JWT_MAIN = 'db5d5006dd18064939fc95fab1a59424eb580a37'
const INTEGRATED_MAIN = '69617442dd2725d067466703303225c75708c928'
const TREE = '80b343189c506023f626982737824feaaeb572c4'
const HISTORICAL_PIN_SHA = 'CE4391FB155A2420A15FA6D422FC96300C69AB602FC8376A1DFD8C89372F1064'
const additions = [
  'Тили-тили/backend/test-isolated/fr018DurableSnapshotAcceptance.source85.test.ts',
  'Тили-тили/backend/test-isolated/fr018NativeRaces.source85.test.ts',
  'Тили-тили/backend/test-support/fr018-source85-admission.mjs',
  'Тили-тили/backend/test-support/fr018-source85-admission.d.mts',
  'Тили-тили/backend/test-support/fr018-source85-inverse.json',
  'Тили-тили/backend/vitest.fr018-acceptance-source85.config.ts',
  'Тили-тили/backend/vitest.fr018-races-source85.config.ts',
].sort()
const sha = raw => createHash('sha256').update(raw).digest('hex').toUpperCase()
const hashFile = file => sha(readFileSync(file))
const git = args => execFileSync('git', ['-c', 'safe.directory=' + checkout, ...args], { cwd: checkout, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
const strictSHA = value => assert(typeof value === 'string' && /^[A-F0-9]{64}$/.test(value), 'Exact SHA256 required')
const samePath = (first, second) => path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
function regular(file) {
  const resolved = path.resolve(file)
  assert(lstatSync(resolved).isFile() && !lstatSync(resolved).isSymbolicLink(), 'Only regular reference files allowed')
  assert(samePath(realpathSync(resolved), resolved), 'Reference parent symlink/junction refused')
  return resolved
}
function reference(ref, requiredPath) {
  assert.deepEqual(Object.keys(ref).sort(), ['path', 'sha256']); strictSHA(ref.sha256)
  const resolved = regular(ref.path)
  if (requiredPath) assert(samePath(resolved, requiredPath), 'Unexpected fixed receipt path')
  else assert(resolved.startsWith(evidence + path.sep), 'Receipt must stay in current root evidence directory')
  const raw = readFileSync(resolved); assert.equal(sha(raw), ref.sha256, 'Receipt bytes differ')
  return { raw: raw.toString('utf8'), data: JSON.parse(raw) }
}
function relativeFile(name) {
  assert(typeof name === 'string' && name && !name.includes('\\') && !path.isAbsolute(name))
  assert.equal(path.posix.normalize(name), name)
  assert(!name.split('/').some(part => ['', '.', '..'].includes(part)))
  const resolved = path.resolve(checkout, name)
  assert(resolved.startsWith(checkout + path.sep), 'Source path escapes checkout')
  return regular(resolved)
}
function verifyInverse() {
  const inverse = JSON.parse(readFileSync(path.join(backend, 'test-support/fr018-source85-inverse.json'), 'utf8'))
  assert.equal(inverse.kind, 'fr018_source85_admission_only_exact_inverse_v1')
  assert.equal(inverse.files.length, 4)
  const originals = new Set(), candidates = new Set()
  for (const entry of inverse.files) {
    assert(!originals.has(entry.originalPath) && !candidates.has(entry.candidatePath))
    originals.add(entry.originalPath); candidates.add(entry.candidatePath)
    const original = readFileSync(relativeFile(entry.originalPath), 'utf8')
    const candidate = readFileSync(relativeFile(entry.candidatePath), 'utf8')
    strictSHA(entry.originalSHA256); strictSHA(entry.candidateSHA256)
    assert.equal(sha(original), entry.originalSHA256); assert.equal(sha(candidate), entry.candidateSHA256)
    let restored = candidate
    for (const edit of [...entry.replacements].reverse()) {
      assert.equal(edit.count, 1); assert.equal(restored.split(edit.after).length - 1, edit.count)
      restored = restored.replace(edit.after, edit.before)
    }
    assert.equal(restored, original, 'Whole original bytes must be restored')
    if (entry.businessTailMarker) {
      assert.equal(original.split(entry.businessTailMarker).length, 2)
      assert.equal(candidate.split(entry.businessTailMarker).length, 2)
      assert.equal(candidate.slice(candidate.indexOf(entry.businessTailMarker)), original.slice(original.indexOf(entry.businessTailMarker)))
      assert.equal(sha(original.slice(original.indexOf(entry.businessTailMarker))), entry.businessTailSHA256)
      for (const kept of entry.preservedBlocks) {
        assert.equal(original.split(kept.raw).length, 2); assert.equal(candidate.split(kept.raw).length, 2)
        assert.equal(sha(kept.raw), kept.sha256)
      }
    }
  }
  assert.deepEqual([...originals].sort(), [
    'Тили-тили/backend/test-isolated/fr018DurableSnapshotAcceptance.test.ts',
    'Тили-тили/backend/test-isolated/fr018NativeRaces.test.ts',
    'Тили-тили/backend/vitest.fr018-acceptance-isolated.config.ts',
    'Тили-тили/backend/vitest.fr018-races-isolated.config.ts',
  ].sort())
  assert.deepEqual([...candidates].sort(), additions.filter(name => name.endsWith('.ts')))
}
function historicalPins() {
  const raw = readFileSync(path.join(backend, 'test-support/fr018-native-acceptance-pins.json'))
  assert.equal(sha(raw), HISTORICAL_PIN_SHA)
  assert(raw.equals(readFileSync(path.join(backend, 'test-support/fr018-native-races-pins.json'))))
  const pins = JSON.parse(raw)
  assert.equal(pins.external.length, 26)
  const seen = new Set()
  for (const ref of pins.external) {
    assert.deepEqual(Object.keys(ref).sort(), ['path', 'sha256']); strictSHA(ref.sha256)
    assert(path.isAbsolute(ref.path)); assert(!seen.has(ref.path)); seen.add(ref.path)
    assert.equal(hashFile(regular(ref.path)), ref.sha256, 'Historical provenance changed')
  }
}
function inspectReceipts(ctx) {
  const creation = reference(ctx.bundle.creation, path.join(evidence, 'creation.json')).data
  const schema = reference(ctx.bundle.schema, path.join(evidence, 'schema-after-migrate.json')).data
  assert.equal(creation.kind, 'root_actual_fr018_source85_absent_before_create_v1')
  assert.equal(creation.targetName, TARGET); assert.equal(creation.targetURL, DATABASE); assert.equal(creation.databaseOID, OID)
  assert.equal(creation.targetOwnerRoleOID, '10'); assert.equal(creation.absentBeforeCreate, true); assert.equal(creation.beforeRowCount, 0)
  assert.equal(creation.template, 'template0'); assert.equal(creation.postmasterPID, 42884)
  assert(Date.parse(creation.createdAt) >= Date.parse(creation.beforeAt) && Number.isFinite(Date.parse(creation.beforeAt)))
  assert.deepEqual(creation.initialPeers, [])
  assert.equal(creation.actualAdmin.database, 'postgres'); assert.equal(creation.actualAdmin.username, 'codex_test')
  assert.equal(creation.actualAdmin.port, 15432); assert.equal(creation.actualAdmin.address, '127.0.0.1')
  assert.equal(creation.actualAdmin.directory, PGDIR); assert.equal(creation.actualAdmin.system_identifier, SYSID)
  assert.equal(creation.actualAdmin.role_oid, '10'); assert.equal(creation.actualAdmin.superuser, true)
  assert.equal(creation.sourceAtCreation.head, ONBOARDING); assert.equal(creation.sourceAtCreation.tree, TREE)
  assert.equal(schema.kind, 'root_actual_fr018_source85_schema_v1'); assert.equal(schema.sourceAtMigration, ONBOARDING)
  assert.equal(schema.migrationCount, 85); assert.equal(schema.noTestsExecuted, true)
  assert.equal(schema.creation.path, 'creation.json'); assert.equal(schema.creation.sha256, ctx.bundle.creation.sha256)
  assert.deepEqual(schema.identity, { name: TARGET, username: 'codex_test', port: 15432, address: '127.0.0.1', oid: OID, encoding: 'UTF8' })
  assert.deepEqual(schema.migrationPins, reviewedMigrationPins(85))
  assert.deepEqual(schema.journal, schema.migrationPins.map(pin => pin.name).sort())
  assertFKs(schema.nativeFKs); assert.equal(schema.constraints.length, 1)
  assert.deepEqual(schema.constraints, [{ conname: 'idempotency_keys_user_id_fkey', contype: 'f', convalidated: true,
    condeferrable: false, condeferred: false, definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE' }])
  assert.deepEqual(Object.values(schema.counts), Array(11).fill(0)); assert.deepEqual(schema.audits, []); assert.deepEqual(schema.peers, [])
  assert.equal(creation.sourceAtCreation.migrationPinsSHA256, sha(JSON.stringify(schema.migrationPins)))
  return schema
}
export function readSource85Admission() {
  assert.notEqual(process.env.GITHUB_ACTIONS, 'true', 'Only explicit local root profile')
  assert.equal(process.env.DATABASE_URL, DATABASE); assert.equal(process.env.TEST_DATABASE_URL, DATABASE)
  assert.equal(process.env.FR018_SOURCE85_DATABASE_OID, OID)
  const filename = process.env.FR018_SOURCE85_ADMISSION
  assert(filename); strictSHA(process.env.FR018_SOURCE85_ADMISSION_SHA256)
  assert(path.resolve(filename).startsWith(evidence + path.sep))
  const raw = readFileSync(regular(filename), 'utf8')
  assert.equal(sha(raw), process.env.FR018_SOURCE85_ADMISSION_SHA256)
  const bundle = JSON.parse(raw)
  assert.equal(bundle.kind, 'root_fr018_source85_closed_admission_v1')
  assert.equal(bundle.targetName, TARGET); assert.equal(bundle.targetURL, DATABASE); assert.equal(bundle.databaseOID, OID)
  assert.match(bundle.integratedMain, /^[a-f0-9]{40}$/)
  assert.equal(bundle.integratedMain, INTEGRATED_MAIN, 'Actual published PR64 main required')
  assert.deepEqual(git(['show', '-s', '--format=%P', bundle.integratedMain]).trim().split(' '), [JWT_MAIN, ONBOARDING])
  assert.equal(git(['rev-parse', bundle.integratedMain + '^{tree}']).trim(), TREE)
  const head = git(['rev-parse', 'HEAD']).trim()
  assert.match(process.env.FR018_SOURCE85_SOURCE_HEAD ?? '', /^[a-f0-9]{40}$/)
  assert.equal(head, process.env.FR018_SOURCE85_SOURCE_HEAD); assert.equal(bundle.executionHead, head)
  git(['merge-base', '--is-ancestor', bundle.integratedMain, head])
  assert.deepEqual(git(['diff', '--name-only', '-z', bundle.integratedMain, head]).split('\0').filter(Boolean).sort(), additions)
  assert.equal(git(['status', '--porcelain']).trim(), '', 'Admission source must be committed and clean')
  historicalPins(); verifyInverse()
  const ctx = Object.freeze({ filename: path.resolve(filename), raw, bundle, head, targetName: TARGET, targetURL: DATABASE, databaseOID: OID })
  inspectReceipts(ctx); verifySource85(ctx)
  return ctx
}
export function verifySource85(ctx) {
  assert.equal(readFileSync(regular(ctx.filename), 'utf8'), ctx.raw, 'Root bundle immutable')
  assert.equal(git(['rev-parse', 'HEAD']).trim(), ctx.head)
  assert.equal(git(['status', '--porcelain']).trim(), '')
  const { raw, data: proof } = reference(ctx.bundle.source)
  assert.equal(proof.kind, 'root_fr018_source85_complete_current_source_v1')
  assert(samePath(proof.checkout, checkout)); assert.equal(proof.head, ctx.head); assert.equal(proof.integratedMain, ctx.bundle.integratedMain)
  assert(Array.isArray(proof.files) && proof.files.length >= 1000)
  const names = proof.files.map(pin => pin.path)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual([...names].sort(), git(['ls-files', '-z']).split('\0').filter(Boolean).sort(), 'Whole actual Git inventory required')
  const named = new Set(names)
  for (const pin of proof.files) { strictSHA(pin.sha256); assert.equal(hashFile(relativeFile(pin.path)), pin.sha256, 'Current source bytes differ: ' + pin.path) }
  function enumerate(directory) {
    assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink())
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink())
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) enumerate(full)
      else { assert(entry.isFile()); assert(named.has(path.relative(checkout, full).replaceAll('\\', '/')), 'Unattested runtime leaf') }
    }
  }
  for (const directory of ['src', 'test', 'test-isolated', 'test-support', 'migrations', 'scripts']) enumerate(path.join(backend, directory))
  enumerate(path.resolve(backend, '../app/src'))
  verifyMigrationDirectory(path.join(backend, 'migrations'), reviewedMigrationPins(85))
  historicalPins(); verifyInverse(); inspectReceipts(ctx)
  return { proof, raw }
}
export async function inspectNative85(db, ctx, applicationName) {
  assert.equal(readFileSync(regular(ctx.filename), 'utf8'), ctx.raw)
  const schema = inspectReceipts(ctx)
  const identity = (await db.query(`select current_database() as name,current_user as username,inet_server_port() as port,host(inet_server_addr()) as address,
    (select oid::text from pg_database where datname=current_database()) as oid,current_setting('server_encoding') as encoding`)).rows[0]
  assert.deepEqual(identity, schema.identity, 'Exact fresh target identity')
  const cluster = (await db.query(`select current_setting('data_directory') as directory,(select system_identifier::text from pg_control_system()) as system_identifier,
    (select datdba::text from pg_database where datname=current_database()) as owner_oid,(select oid::text from pg_roles where rolname=current_user) as role_oid`)).rows[0]
  assert.deepEqual(cluster, { directory: PGDIR, system_identifier: SYSID, owner_oid: '10', role_oid: '10' })
  assert.equal(readFileSync(PGDIR + '/postmaster.pid', 'utf8').split(/\r?\n/)[0], '42884')
  const peers = (await db.query('select pid,application_name,state from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and application_name<>$1', [applicationName])).rows
  assert.deepEqual(peers, [], 'Unexpected application peer')
  const journal = (await db.query('select name from pgmigrations order by name')).rows.map(row => row.name)
  assert.deepEqual(journal, schema.journal)
  const nativeFKs = (await db.query(`select t.oid::text,t.tgname,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid) as definition
    from pg_trigger t where t.tgrelid='public.idempotency_keys'::regclass order by t.tgname`)).rows
  assert.deepEqual(nativeFKs, schema.nativeFKs, 'Exact fresh native FK rows')
  const constraints = (await db.query(`select conname,contype,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) as definition
    from pg_constraint where conrelid='public.idempotency_keys'::regclass and contype='f' order by conname`)).rows
  assert.deepEqual(constraints, schema.constraints)
  return identity
}
