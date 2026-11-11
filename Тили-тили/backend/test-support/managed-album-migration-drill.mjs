import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const ALBUM_MIGRATION = '1764840000000_managed_guest_album'
export const ALBUM_LATEST = 1764840000000
const GUARD = 'media_album_preserving_down_t005'
const albumColumns = new Set(['album_wedding_id', 'album_party_id', 'album_guest_id', 'album_consent_at'])

function record(label, evidence) {
  if (!process.env.MANAGED_ALBUM_MIGRATION_EVIDENCE) return
  const directory = resolve(process.env.MANAGED_ALBUM_MIGRATION_EVIDENCE)
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, label + '.json'), JSON.stringify({ label, syntheticOnly: true, ...evidence }, null, 2), { encoding: 'utf8', flag: 'wx' })
}

function assertUpgrade(before, after) {
  assert.equal(before.data.pgmigrations.length, 99)
  assert.equal(after.data.pgmigrations.length, 100)
  assert.deepEqual(Object.keys(after.data), Object.keys(before.data))
  for (const [table, rows] of Object.entries(before.data)) {
    let actual = after.data[table]
    if (table === 'pgmigrations') actual = actual.filter(row => row.name !== ALBUM_MIGRATION)
    if (table === 'album_photos') actual = actual.map(({ media_upload_id, ...row }) => {
      assert.equal(media_upload_id, null, 'Existing links do not acquire managed ownership')
      return row
    })
    if (table === 'media_uploads') actual = actual.map(row => Object.fromEntries(Object.entries(row).filter(([column, value]) => {
      if (!albumColumns.has(column)) return true
      assert.equal(value, null, 'Portfolio records do not acquire guest ownership')
      return false
    })))
    assert.deepEqual(actual, rows, 'Existing values survive: ' + table)
  }
  const columns = after.schema.columns.filter(row => !(row.table_name === 'album_photos' && row.column_name === 'media_upload_id')
    && !(row.table_name === 'media_uploads' && albumColumns.has(row.column_name)))
    .map(row => row.table_name === 'media_uploads' && row.column_name === 'vendor_id' ? { ...row, is_nullable: 'NO' } : row)
  assert.deepEqual(columns, before.schema.columns)
  assert.equal(after.schema.columns.find(row => row.table_name === 'media_uploads' && row.column_name === 'vendor_id')?.is_nullable, 'YES')
}

/** A real CLI cycle on the caller's already admitted synthetic database. */
export async function runManagedAlbumCycle(c, phase) {
  assert(['empty', 'legacy-populated'].includes(phase))
  let legacyId
  if (phase === 'legacy-populated') {
    const guest = (await c.db.query('select id,wedding_id from guests where party_id is not null order by id limit 1')).rows[0]
    assert(guest, 'A current guest is required to verify preservation of prior album links')
    legacyId = randomUUID()
    await c.db.query('insert into album_photos(id,wedding_id,url,approved,uploaded_by) values($1,$2,$3,true,$4)',
      [legacyId, guest.wedding_id, 'https://example.invalid/old-album/' + legacyId, guest.id])
  }
  const before = await c.snapshot()
  await c.migrate('up', ALBUM_LATEST)
  const after = await c.snapshot()
  assertUpgrade(before, after)
  await c.migrate('up', ALBUM_LATEST)
  assert.deepEqual(await c.snapshot(), after, 'Repeated UP is a no-op')
  await c.migrate('down', ALBUM_MIGRATION, undefined, true)
  const down = await c.snapshot()
  assert.deepEqual(down, before, 'Legacy-only DOWN preserves every prior row and definition')
  await c.migrate('up', ALBUM_LATEST)
  assertUpgrade(before, await c.snapshot())
  record('cycle-' + phase, { before, up: after, down })
  if (legacyId) await c.db.query('delete from album_photos where id=$1', [legacyId])
  console.log('MANAGED_ALBUM100_CYCLE_PASSED', phase)
}

export async function runManagedAlbumGuardedDown(c) {
  const guest = (await c.db.query('select id,wedding_id,party_id from guests where party_id is not null order by id limit 1')).rows[0]
  assert(guest)
  const id = randomUUID(), writer = randomUUID(), original = `quarantine/${id}/original`, clean = `clean/${id}/${writer}.webp`
  const storageId = '8'.repeat(64), fileUrl = `https://example.invalid/album/${id}`
  await c.db.query(`insert into media_objects(key,storage_id,not_before,write_phase,external_until)
    values($1,$2,now()+interval '7 minutes','external',now()+interval '7 minutes')`, [original, storageId])
  await c.db.query(`insert into media_objects(key,storage_id,not_before,write_phase,writer_nonce)
    values($1,$2,now()+interval '7 minutes','settled',$3)`, [clean, storageId, writer])
  await c.db.query(`insert into media_uploads(id,album_wedding_id,album_party_id,album_guest_id,album_consent_at,
    storage_id,idempotency_key,content_type,size_bytes,state,quarantine_key,clean_key,file_url,ready_at,output_bytes,width,height,sha256)
    values($1,$2,$3,$4,now(),$5,$6,'image/png',1,'ready',$7,$8,$9,now(),1,1,1,$10)`,
  [id, guest.wedding_id, guest.party_id, guest.id, storageId, id, original, clean, fileUrl, '9'.repeat(64)])
  await c.db.query('insert into album_photos(id,wedding_id,url,approved,uploaded_by,media_upload_id) values($1,$2,$3,true,$4,$1)',
    [id, guest.wedding_id, fileUrl, guest.id])

  for (const phase of ['ready', 'deleted']) {
    if (phase === 'deleted') {
      await c.db.query('delete from album_photos where id=$1', [id])
      const asset = (await c.db.query('select state from media_uploads where id=$1', [id])).rows[0]
      assert.equal(asset.state, 'deleted')
      assert.equal((await c.db.query('select key from media_objects where key=any($1::text[])', [[original, clean]])).rowCount, 2)
    }
    const before = await c.snapshot()
    await c.migrate('down', ALBUM_MIGRATION, GUARD, true)
    const after = await c.snapshot()
    assert.deepEqual(after, before, 'Refused downgrade leaves all managed data and schema intact')
    record('refused-' + phase, { before, after })
  }
  await c.db.query('delete from media_uploads where id=$1 and album_wedding_id=$2', [id, guest.wedding_id])
  await c.db.query('delete from media_objects where storage_id=$1 and key=any($2::text[])', [storageId, [original, clean]])
  console.log('MANAGED_ALBUM100_GUARDED_DOWN_PASSED actualRefusals=2')
}
