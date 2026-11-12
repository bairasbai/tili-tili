import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const DELIVERY_FILES_MIGRATION = '1764920000000_order_delivery_files'
export const DELIVERY_FILES_LATEST = 1764920000000

export async function runOrderDeliveryFilesCycle({ db, migrate, snapshot }, wedding, deal, actor) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 107)
  await migrate('up', DELIVERY_FILES_LATEST)
  const empty = await snapshot()
  assert.equal(empty.data.pgmigrations.length, 108)
  assert.deepEqual(empty.data.order_delivery_attachments, [])
  const { order_delivery_attachments: files, ...oldRows } = empty.data
  assert.equal(files.length, 0)
  oldRows.pgmigrations = oldRows.pgmigrations.filter(row => row.name !== DELIVERY_FILES_MIGRATION)
  oldRows.media_uploads = oldRows.media_uploads.map(({ delivery_author_id, delivery_deal_id, delivery_revision, ...old }) => {
    assert.deepEqual([delivery_author_id, delivery_deal_id, delivery_revision], [null, null, null])
    return old
  })
  assert.deepEqual(oldRows, before.data)
  await migrate('up', DELIVERY_FILES_LATEST)
  assert.deepEqual(await snapshot(), empty)
  await migrate('down', DELIVERY_FILES_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', DELIVERY_FILES_LATEST)
  const id = randomUUID(), nonce = randomUUID(), storage = '6'.repeat(64)
  const original = `quarantine/${id}/original`, clean = `clean/${id}/${nonce}.pdf`
  await db.query('begin')
  try {
    await db.query(`insert into media_objects(key,storage_id,not_before,write_phase,external_until)
      values($1,$2,now()+interval '7 minutes','external',now()+interval '7 minutes')`, [original, storage])
    await db.query(`insert into media_objects(key,storage_id,not_before,write_phase,writer_nonce)
      values($1,$2,now()+interval '7 minutes','settled',$3)`, [clean, storage, nonce])
    await db.query(`insert into media_uploads(id,delivery_deal_id,delivery_revision,delivery_author_id,idempotency_key,
      storage_id,content_type,size_bytes,state,quarantine_key,clean_key,file_url,ready_at,output_bytes,sha256)
      values($1,$2,1,$3,$9,$4,'application/pdf',1,'ready',$5,$6,$7,now(),1,$8)`,
    [id, deal, actor, storage, original, clean, `https://example.invalid/material/${id}`, '7'.repeat(64), id])
    await db.query(`insert into order_delivery_steps(wedding_id,deal_id,revision,kind,actor_id,summary,due_on)
      values($1,$2,1,'submitted',$3,'Synthetic checked file','2027-06-15')`, [wedding, deal, actor])
    await db.query(`insert into order_delivery_attachments(wedding_id,deal_id,revision,position,upload_id)
      values($1,$2,1,1,$3)`, [wedding, deal, id])
    await db.query('commit')
  } catch (error) { await db.query('rollback'); throw error }
  const populated = await snapshot()
  await migrate('down', DELIVERY_FILES_MIGRATION, 'order_delivery_files_preserving_down_t012', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from order_delivery_steps where wedding_id=$1 and deal_id=$2 and revision=1', [wedding, deal])
  await db.query('delete from media_uploads where id=$1 and delivery_deal_id=$2', [id, deal])
  await db.query('delete from media_objects where storage_id=$1 and key=any($2::text[])', [storage, [original, clean]])
  process.stdout.write('ORDER_DELIVERY_FILES108_PRESERVING_PASSED emptyCycle=1 exactRepeat=1 populatedRefusal=1\n')
}
