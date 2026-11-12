import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const WEDDING_PURCHASES_LATEST = 1765070000000
export const WEDDING_PURCHASES_MIGRATION = '1765070000000_wedding_purchases'

export async function runWeddingPurchasesCycle({ db, migrate, snapshot }, ownerId) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 122)
  await migrate('up', WEDDING_PURCHASES_LATEST)
  const installed = await snapshot()
  const { wedding_purchase_versions: purchases, pgmigrations, ...existing } = installed.data
  assert.deepEqual(purchases, [])
  assert.equal(pgmigrations.length, 123)
  assert.deepEqual({ ...existing, pgmigrations: pgmigrations.filter(row => row.name !== WEDDING_PURCHASES_MIGRATION) }, before.data)
  await migrate('up', WEDDING_PURCHASES_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', WEDDING_PURCHASES_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', WEDDING_PURCHASES_LATEST)
  const wedding = randomUUID(), id = randomUUID()
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic purchase',$3)", [wedding, ownerId, wedding])
  const insert = `insert into wedding_purchase_versions(wedding_id,id,version,title,quantity,unit,category_id,status,status_changed,actor_id)
    values($1,$2,1,'Synthetic purchase',$3,'unit','b2',$4,true,$5)`
  await assert.rejects(() => db.query(insert, [wedding,id,0,'needed',ownerId]), { code: '23514' })
  await assert.rejects(() => db.query(insert, [wedding,id,1,'received',ownerId]), { code: '23514' })
  await db.query(insert, [wedding,id,1.25,'needed',ownerId])
  const populated = await snapshot()
  await migrate('down', WEDDING_PURCHASES_MIGRATION, 'wedding_purchases_rollback_preserves_history', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from weddings where id=$1', [wedding])
  assert.deepEqual((await snapshot()).data.wedding_purchase_versions, [])
  process.stdout.write('WP13_WEDDING_PURCHASES_MIGRATION_PASSED\n')
}
