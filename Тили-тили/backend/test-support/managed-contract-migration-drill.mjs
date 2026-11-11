import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const CONTRACT_MIGRATION = '1764850000000_managed_contract_attachment'
export const CONTRACT_LATEST = 1764850000000
const GUARD = 'media_contract_preserving_down_t005'
const added = new Set(['document_id', 'document_author_id', 'document_author_side'])

export async function runManagedContractCycle({ migrate, snapshot }) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 100)
  await migrate('up', CONTRACT_LATEST)
  const after = await snapshot()
  assert.equal(after.data.pgmigrations.length, 101)
  for (const [table, rows] of Object.entries(before.data)) {
    let actual = after.data[table]
    if (table === 'pgmigrations') actual = actual.filter(row => row.name !== CONTRACT_MIGRATION)
    if (table === 'media_uploads') actual = actual.map(row => Object.fromEntries(Object.entries(row).filter(([column, value]) => {
      if (!added.has(column)) return true
      assert.equal(value, null)
      return false
    })))
    assert.deepEqual(actual, rows, 'Previous rows must survive: ' + table)
  }
  assert.deepEqual(after.schema.columns.filter(row => !(row.table_name === 'media_uploads' && added.has(row.column_name))), before.schema.columns)
  await migrate('up', CONTRACT_LATEST)
  assert.deepEqual(await snapshot(), after)
  await migrate('down', CONTRACT_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before, 'Previous schema and rows must be restored exactly')
  await migrate('up', CONTRACT_LATEST)
  const replayed = await snapshot()
  // PostgreSQL keeps dropped attribute slots. The re-added columns get the next
  // positions. Existing columns and every other catalogue entry stay exact.
  const replayedColumns = replayed.schema.columns.map(row => row.table_name === 'media_uploads' && added.has(row.column_name)
    ? { ...row, ordinal_position: row.ordinal_position - added.size, dtd_identifier: String(Number(row.dtd_identifier) - added.size) }
    : row)
  assert.deepEqual({ ...replayed.schema, columns: replayedColumns }, after.schema)
  assert.deepEqual(replayed.data.pgmigrations.slice(0, -1), before.data.pgmigrations)
  assert.equal(replayed.data.pgmigrations.at(-1).name, CONTRACT_MIGRATION)
}

export async function runManagedContractGuardedDown({ db, migrate, snapshot }, dealId) {
  const owner = (await db.query(`select m.user_id from deals d join wedding_members m on m.wedding_id=d.wedding_id
    where d.id=$1 and m.role='couple' order by m.user_id limit 1`, [dealId])).rows[0]
  assert(owner)
  const documentId = randomUUID(), id = randomUUID(), nonce = randomUUID(), storage = '6'.repeat(64)
  const original = `quarantine/${id}/original`, clean = `clean/${id}/${nonce}.pdf`
  await db.query("insert into documents(id,deal_id,template_code) values($1,$2,'universal')", [documentId, dealId])
  await db.query(`insert into media_objects(key,storage_id,not_before,write_phase,external_until)
    values($1,$2,now()+interval '7 minutes','external',now()+interval '7 minutes')`, [original, storage])
  await db.query(`insert into media_objects(key,storage_id,not_before,write_phase,writer_nonce)
    values($1,$2,now()+interval '7 minutes','settled',$3)`, [clean, storage, nonce])
  await db.query(`insert into media_uploads(id,document_id,document_author_id,document_author_side,idempotency_key,
    storage_id,content_type,size_bytes,state,quarantine_key,clean_key,file_url,ready_at,output_bytes,sha256)
    values($1,$2,$3,'couple',$9,$4,'application/pdf',1,'ready',$5,$6,$7,now(),1,$8)`,
  [id, documentId, owner.user_id, storage, original, clean, `https://example.invalid/contracts/${id}`, '7'.repeat(64), id])
  for (const phase of ['ready', 'orphan-cleanup']) {
    if (phase === 'orphan-cleanup') await db.query('delete from documents where id=$1', [documentId])
    const before = await snapshot()
    await migrate('down', CONTRACT_MIGRATION, GUARD, true)
    assert.deepEqual(await snapshot(), before, 'Guarded down must preserve ' + phase)
  }
  await db.query('delete from media_objects where key=any($1::text[])', [[original, clean]])
}
