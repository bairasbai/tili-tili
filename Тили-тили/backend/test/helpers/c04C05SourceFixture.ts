import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileSHA, reviewedMigrationPins, type verifySource } from '../../test-support/c04-c05-native-admission.mjs'

type Source = Parameters<typeof verifySource>[0]
const require = createRequire(import.meta.url)
const owned = new Map<string, { root: string; verify: typeof verifySource }>()
const immutableSources = new Map<string, string>()
const parent = realpathSync(tmpdir())
function regularPath(root: string, path: string) {
  assert(!isAbsolute(path) && !path.split(/[\\/]/).includes('..'))
  assert(!/(^|\/)(?:\.env(?:\.|$)|local\.properties|google-services\.json|keystore\.properties|mobile)(\/|$)|\.(jks|keystore)$/i.test(path))
  let current = root
  for (const part of path.split('/')) { current = join(current, part); assert(!lstatSync(current).isSymbolicLink()) }
  assert(lstatSync(current).isFile())
  return current
}
/** Frozen historical source lives beside an unchanged copy of the actual guard.
 * No cwd/env override, relaxed production guard or historical extra migration. */
export function freezeHistoricalSource(source: Source): Source {
  const counts = { c04_c05_current_source94_v1: 94, c04_c05_current_source95_v1: 95, c04_c05_current_source98_v1: 98 } as const
  assert(Object.hasOwn(counts, source.kind), 'Only exact reviewed historical94/95/98 source copies are admitted')
  const count = counts[source.kind as keyof typeof counts]
  const key = JSON.stringify([source.kind, source.repo, source.files])
  const cached = immutableSources.get(key)
  if (cached) { const fixture = owned.get(cached); assert(fixture); return { ...source, repo: realpathSync(fixture.root), backend: cached } }
  const pins = reviewedMigrationPins(count)
  const migrationPaths = pins.map(p => `Тили-тили/backend/migrations/${p.name}.cjs`)
  assert.deepEqual(source.files.filter(f => /\/migrations\/[0-9]+_.*\.cjs$/.test(f.path)).map(f => f.path).sort(), migrationPaths.sort())
  const root = mkdtempSync(join(parent, `c04c05-source${count}-`))
  const record = { owner: 'c04C05SourceFixture', root, sourceRepo: source.repo, count, purpose: 'byte-exact historical source admission', result: 'Vitest output; remove after test', createdAt: new Date().toISOString(), paths: source.files.map(f => f.path) }
  writeFileSync(join(root, 'owner.json'), JSON.stringify(record), { flag: 'wx' })
  try {
    for (const file of source.files) {
      const original = regularPath(source.repo, file.path)
      assert.equal(fileSHA(original), file.sha256)
      const dest = join(root, file.path); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(original, dest)
      assert(readFileSync(original).equals(readFileSync(dest)))
    }
    const backend = realpathSync(join(root, 'Тили-тили/backend'))
    const module = require(join(backend, 'test-support/c04-c05-native-admission.mjs')) as { verifySource: typeof verifySource }
    assert.equal(typeof module.verifySource, 'function')
    owned.set(backend, { root, verify: module.verifySource })
    immutableSources.set(key, backend)
    return { ...source, repo: realpathSync(root), backend }
  } catch (error) { remove(root); throw error }
}
export function verifyHistoricalSource(source: Source): string[] {
  const fixture = owned.get(source.backend); assert(fixture, 'Historical verifier must belong to its exact owned source copy')
  return fixture.verify(source)
}
function remove(root: string) {
  assert.equal(dirname(resolve(root)), parent); assert(/^c04c05-source(?:94|95|98)-[A-Za-z0-9]+$/.test(root.slice(parent.length + 1)))
  assert(!lstatSync(root).isSymbolicLink()); assert.equal(realpathSync(root), root)
  const owner = JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8')) as { owner: string; root: string }
  assert.equal(owner.owner, 'c04C05SourceFixture'); assert.equal(owner.root, root)
  rmSync(root, { recursive: true }); assert(!existsSync(root))
}
export function cleanHistoricalSources() {
  for (const [backend, fixture] of owned) { remove(fixture.root); owned.delete(backend) }
  immutableSources.clear()
}

export const HISTORICAL94_PATHS = [
  ".github/workflows/ci.yml",
  "init.sh",
  "Тили-тили/backend/migrations/1763840000000_resource_source_erasure.cjs",
  "Тили-тили/backend/migrations/1763850000000_deal_day_scope_foundation.cjs",
  "Тили-тили/backend/migrations/1763860000000_deal_day_scope_undated_terminal.cjs",
  "Тили-тили/backend/migrations/1763870000000_deal_day_scope_atomic.cjs",
  "Тили-тили/backend/migrations/1763880000000_offer_event_context.cjs",
  "Тили-тили/backend/migrations/1763890000000_event_move_agreements.cjs",
  "Тили-тили/backend/migrations/1763900000000_event_move_snapshot_operators.cjs",
  "Тили-тили/backend/migrations/1763910000000_additional_event_undated.cjs",
  "Тили-тили/backend/migrations/1763920000000_legacy_calendar_bounds.cjs",
  "Тили-тили/backend/scripts/c04-c05-isolated-lane.mjs",
  "Тили-тили/backend/scripts/c04-c05-receipt-barrier-control.mjs",
  "Тили-тили/backend/src/deals/day-scope-write.ts",
  "Тили-тили/backend/src/deals/program-event-context.ts",
  "Тили-тили/backend/src/offers/event-context.ts",
  "Тили-тили/backend/src/orders/event-move-token.ts",
  "Тили-тили/backend/src/orders/event-moves.ts",
  "Тили-тили/backend/src/resources/day-groups.ts",
  "Тили-тили/backend/src/resources/legacy-source.ts",
  "Тили-тили/backend/test-isolated/c04FanoutAdmission.test.ts",
  "Тили-тили/backend/test-isolated/c05WorkerFinalBatch.test.ts",
  "Тили-тили/backend/test-support/additional-event-undated-migration-drill.mjs",
  "Тили-тили/backend/test-support/c04-c05-additional-event-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-atomic-day-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-calendar-bounds-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-day-scope-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-event-move-fix-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-fr011-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-native-admission.d.mts",
  "Тили-тили/backend/test-support/c04-c05-native-admission.mjs",
  "Тили-тили/backend/test-support/c04-c05-resource-erasure-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-test-inverse.json",
  "Тили-тили/backend/test-support/c04-c05-undated-additional-migrations.json",
  "Тили-тили/backend/test-support/c04-c05-undated-terminal-migrations.json",
  "Тили-тили/backend/test-support/calendar-bounds-migration-drill.mjs",
  "Тили-тили/backend/test-support/deal-day-scope-atomic-drill.mjs",
  "Тили-тили/backend/test/additionalEventSnapshotValidation.test.ts",
  "Тили-тили/backend/test/additionalEventUndated.test.ts",
  "Тили-тили/backend/test/additionalEventUndatedMove.test.ts",
  "Тили-тили/backend/test/c04C05AdditionalEventAdmission.test.ts",
  "Тили-тили/backend/test/c04C05AtomicDayAdmission.test.ts",
  "Тили-тили/backend/test/c04C05DayScopeAdmission.test.ts",
  "Тили-тили/backend/test/c04C05MigrationAdmission.test.ts",
  "Тили-тили/backend/test/c04C05UndatedTerminalAdmission.test.ts",
  "Тили-тили/backend/test/helpers/additionalEventUndatedFixture.ts",
  "Тили-тили/backend/vitest.c04-isolated.config.ts",
  "Тили-тили/backend/vitest.c05-worker-isolated.config.ts"
] as const
