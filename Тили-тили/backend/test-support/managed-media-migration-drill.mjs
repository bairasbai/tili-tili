import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const MEDIA_MIGRATION = '1764830000000_managed_portfolio_media'
export const MEDIA_LATEST = 1764830000000
const GUARD = 'media_preserving_down_032'
const newTables = ['media_objects', 'media_uploads']
function record(label, value) {
  if (!process.env.MANAGED_MEDIA_MIGRATION_EVIDENCE) return
  const directory = resolve(process.env.MANAGED_MEDIA_MIGRATION_EVIDENCE)
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, label + '.json'), JSON.stringify({ owner: 'managed-media-migration-drill',
    at: new Date().toISOString(), label, syntheticOnly: true, ...value }), { encoding: 'utf8', flag: 'wx' })
}

function assertUpgrade(before, after) {
  assert.equal(before.data.pgmigrations.length, 98)
  assert.equal(after.data.pgmigrations.length, 99)
  assert.deepEqual(Object.keys(after.data).sort(), [...Object.keys(before.data), ...newTables].sort())
  for (const table of newTables) assert.deepEqual(after.data[table], [])
  for (const [table, rows] of Object.entries(before.data)) {
    let actual = after.data[table]
    if (table === 'pgmigrations') actual = actual.filter(r => r.name !== MEDIA_MIGRATION)
    if (table === 'vendor_media') actual = actual.map(({ media_upload_id, ...r }) => {
      assert.equal(media_upload_id, null, 'Legacy URLs must not infer managed ownership'); return r
    })
    assert.deepEqual(actual, rows, 'All old rows and values must survive: ' + table)
  }
  assert.deepEqual(after.schema.columns.filter(r => !newTables.includes(r.table_name)
    && !(r.table_name === 'vendor_media' && r.column_name === 'media_upload_id')), before.schema.columns)
}

/** The caller supplies its closed native identity/quiescence guard and real CLI.
 * All fixtures are synthetic metadata: no provider capabilities or real files. */
export async function runManagedMediaCycle(c, phase) {
  assert(['empty', 'legacy-populated'].includes(phase))
  let legacy
  if (phase === 'legacy-populated') {
    const vendor = (await c.db.query('select id,photo_url from vendors order by id limit 1')).rows[0]
    assert(vendor, 'An actual populated vendor is mandatory')
    legacy = { ...vendor, media: randomUUID(), url: 'https://example.invalid/legacy/' + randomUUID() }
    await c.db.query("insert into vendor_media(id,vendor_id,kind,url,sort) values($1,$2,'photo',$3,7)", [legacy.media, legacy.id, legacy.url])
    await c.db.query('update vendors set photo_url=$1 where id=$2', [legacy.url, legacy.id])
  }
  const before = await c.snapshot()
  if (phase === 'legacy-populated') {
    assert(before.data.vendor_media.some(r => r.kind === 'photo'), 'A populated legacy photo is mandatory')
    assert(before.data.vendors.some(r => r.photo_url !== null), 'A legacy primary photo is mandatory')
  }
  await c.migrate('up', MEDIA_LATEST)
  const after = await c.snapshot()
  assertUpgrade(before, after)
  await c.migrate('up', MEDIA_LATEST)
  assert.deepEqual(await c.snapshot(), after, 'Repeated native UP is an exact no-op')
  await c.migrate('down', MEDIA_MIGRATION, undefined, true)
  const down = await c.snapshot()
  record('cycle-' + phase, { before, up: after, down })
  assert.deepEqual(down, before, 'Successful legacy-only DOWN restores every row and schema fact')
  await c.migrate('up', MEDIA_LATEST)
  assertUpgrade(before, await c.snapshot())
  if (legacy) {
    await c.db.query('delete from vendor_media where id=$1 and vendor_id=$2', [legacy.media, legacy.id])
    await c.db.query('update vendors set photo_url=$1 where id=$2', [legacy.photo_url, legacy.id])
  }
  process.stdout.write('MANAGED_MEDIA99_CYCLE_PASSED ' + JSON.stringify({ phase,
    previousMigrations: 98, migrations: 99, oldTables: Object.keys(before.data).length,
    tables: Object.keys(after.data).length, actualUps: 2, actualDowns: 1, actualRepeats: 1,
    legacyRowsExact: true, managedDowngradeSucceeded: false }) + '\n')
}

export async function runManagedMediaGuardedDown(c) {
  const baseline = await c.snapshot()
  assert.equal(baseline.data.pgmigrations.length, 99)
  assert.deepEqual(baseline.data.media_objects, []); assert.deepEqual(baseline.data.media_uploads, [])
  const user = randomUUID(), vendor = randomUUID(), storage = 'a'.repeat(64), keys = []
  // Owned metadata only; this drill never invokes an authentication/SMS route.
  await c.db.query('insert into users(id,phone) values($1,$2)', [user, '+79' + randomInt(100_000_000, 1_000_000_000)])
  await c.db.query("insert into vendors(id,user_id,category_id,name) values($1,$2,'photo','Synthetic media preserving drill')", [vendor, user])
  let checks = 0
  async function refuses(label) {
    const before = await c.snapshot()
    const result = await c.migrate('down', MEDIA_MIGRATION, GUARD, true)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /23514/)
    assert.match(result.output, /media_preserving_down_032/)
    const after = await c.snapshot()
    record('guard-' + label, { before, after, native: result })
    assert.deepEqual(after, before, 'Refused DOWN preserves full rows and catalogue: ' + label)
    checks++
    process.stdout.write('MANAGED_MEDIA99_GUARDED_DOWN ' + JSON.stringify({ label,
      sqlstate: '23514', constraint: GUARD, status: result.status, output: result.output,
      rowsAndCatalogueExact: true, objects: before.data.media_objects.length, assets: before.data.media_uploads.length }) + '\n')
  }
  async function object(id, phase, state = 'pending') {
    const nonce = randomUUID(), key = phase === 'external' ? `quarantine/${id}/original` : `clean/${id}/${nonce}.webp`
    const deadline = new Date(Date.now() + 600_000)
    await c.db.query(`insert into media_objects(key,storage_id,not_before,state,write_phase,writer_nonce,external_until)
      values($1,$2,$3,$4,$5,$6,$7)`, [key, storage, deadline, state, phase,
      ['inflight', 'settled', 'uncertain'].includes(phase) ? nonce : null, phase === 'external' ? deadline : null])
    keys.push(key); return { key, nonce }
  }
  // Each first object is an independent refusal; earlier fixtures are removed
  // only after that refusal and its complete preservation assertion succeeded.
  for (const [phase, state] of [['registered', 'pending'], ['inflight', 'pending'], ['uncertain', 'pending'],
    ['external', 'pending'], ['uncertain', 'failed'], ['settled', 'done']]) {
    const { key } = await object(randomUUID(), phase, state)
    await refuses(`orphan-${phase}-${state}`)
    await c.db.query('delete from media_objects where key=$1 and storage_id=$2', [key, storage])
  }
  for (const state of ['pending', 'processing', 'ready']) {
    const id = randomUUID(), quarantine = await object(id, 'external'), clean = state === 'pending' ? null : await object(id, state === 'ready' ? 'settled' : 'inflight')
    await c.db.query(`insert into media_uploads(id,vendor_id,storage_id,idempotency_key,content_type,size_bytes,state,
      quarantine_key,clean_key,file_url,nonce,lease_until,ready_at,output_bytes,width,height,sha256)
      values($1::uuid,$2,$3,$1::uuid::text,'image/png',64,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)`,
    [id, vendor, storage, state, quarantine.key, clean?.key ?? null, 'https://example.invalid/media/' + id,
      state === 'processing' ? clean.nonce : null, state === 'processing' ? new Date(Date.now() + 90_000) : null,
      state === 'ready' ? new Date() : null, state === 'ready' ? 64 : null, state === 'ready' ? 1 : null,
      state === 'ready' ? 'b'.repeat(64) : null])
    if (state === 'ready') await c.db.query("insert into vendor_media(id,vendor_id,kind,url,media_upload_id) values($1,$2,'photo',$3,$1)", [id, vendor, 'https://example.invalid/media/' + id])
    await refuses('asset-' + state)
    if (state === 'ready') {
      await c.db.query('delete from users where id=$1', [user])
      assert.equal((await c.db.query('select count(*)::int n from media_uploads where vendor_id=$1', [vendor])).rows[0].n, 0)
      await refuses('account-cascade-orphan-obligations')
    } else await c.db.query('delete from media_uploads where id=$1', [id])
    await c.db.query('delete from media_objects where key=any($1::text[]) and storage_id=$2', [keys, storage])
  }
  await c.db.query('delete from users where id=$1', [user])
  const retired = await c.snapshot()
  record('retired', { before: baseline, after: retired, retainedOwner: { user, vendor } })
  // Inherited identity history deliberately survives account deletion. Verify
  // precisely these two new facts; never delete history to make a test green.
  const links = retired.data.legacy_calendar_person_links.filter(r => r.person_identity === user)
  assert.equal(links.length, 1)
  assert.deepEqual({ ...links[0], id: null, observed_at: null }, { id: null, observed_at: null,
    origin_id: vendor, origin_kind: 'owner', person_identity: user, vendor_identity: vendor, unknown_identity: false })
  const identities = retired.data.resource_conflict_keys.filter(r => r.identity === user)
  assert.deepEqual(identities, [{ kind: 'person', identity: user }])
  assert.deepEqual({ ...retired, data: { ...retired.data,
    legacy_calendar_person_links: retired.data.legacy_calendar_person_links.filter(r => r.person_identity !== user),
    resource_conflict_keys: retired.data.resource_conflict_keys.filter(r => r.identity !== user) } }, baseline,
  'All baseline rows/catalogue and every unrelated value remain exact after fixture retirement')
  process.stdout.write('MANAGED_MEDIA99_ALL_GUARDS_PASSED ' + JSON.stringify({ actualNativeRefusals: checks,
    fullSnapshotPreserved: true, liveSyntheticFixturesRetired: true, retainedNativeIdentityRows: 2, managedDowngradeSucceeded: false }) + '\n')
}
