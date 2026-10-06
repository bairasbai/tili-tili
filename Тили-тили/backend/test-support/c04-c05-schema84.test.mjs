import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { assertJournal, verifyMigrationDirectory, selectProfile } from './c04-c05-native-admission.mjs'

const root = fileURLToPath(new URL('../migrations/', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('./c04-c05-migrations.json', import.meta.url), 'utf8'))
const names = manifest.map(f => f.name)
test('fresh schema84 requires the exact ordered 84-entry journal', () => assertJournal(names, names))
test('old83 cannot be presented as schema84', () => assert.throws(() => assertJournal(names.slice(0, -1), names)))
test('an unknown extra migration is not admitted', () => assert.throws(() => assertJournal([...names, '1763840000000_unknown'], names)))
test('a duplicate journal entry is not admitted', () => assert.throws(() => assertJournal([...names.slice(0, -1), names[0]], names)))
test('a reordered journal is not admitted', () => assert.throws(() => assertJournal([...names].reverse(), names)))
test('the declared manifest cannot substitute an unknown latest name', () => { const bad = [...names.slice(0, -1), '1763840000000_unknown']; assert.throws(() => assertJournal(bad, bad)) })
test('all previous83 migration hashes remain byte-identical to the reviewed baseline', () => {
  const canonical = JSON.stringify(manifest.slice(0, -1))
  assert.equal(createHash('sha256').update(canonical).digest('hex'), '2fb0a9b9fdc01ea0d4d28e994ceba130fd4d3fe4d4fcb2556d23ca338c978591')
})
test('the actual directory passes exact filenames, types and every pinned hash', () => assert.deepEqual(verifyMigrationDirectory(root, manifest), names))
test('the old local83 receipt is explicitly refused before any local connection', () => assert.throws(() => selectProfile({ C04_C05_NATIVE_PROFILE: 'local' }), /local83-to84 preserving receipt/))
for (const mutation of ['content', 'missing', 'extra']) test(`directory mutation ${mutation} is rejected`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fr005-migration-manifest-'))
  try {
    cpSync(root, dir, { recursive: true })
    const latest = join(dir, names.at(-1) + '.cjs')
    if (mutation === 'content') writeFileSync(latest, 'unreviewed migration')
    if (mutation === 'missing') rmSync(latest)
    if (mutation === 'extra') writeFileSync(join(dir, '1763840000000_unknown.cjs'), '')
    assert.throws(() => verifyMigrationDirectory(dir, manifest))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
