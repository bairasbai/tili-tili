import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const ITEM_SETS_LATEST = 1765090000000
export const ITEM_SETS_MIGRATION = '1765090000000_wedding_item_sets'

export async function runItemSetsCycle({ db, migrate, snapshot }, ownerId) {
  const wedding = randomUUID(), foreignWedding = randomUUID(), purchase = randomUUID(), item = randomUUID()
  for (const id of [wedding, foreignWedding]) {
    await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic item sets',$3)", [id,ownerId,id])
  }
  await db.query(`insert into wedding_purchase_versions(wedding_id,id,version,title,quantity,unit,category_id,status,status_changed)
    values($1,$2,1,'Purchase',1,'unit','b2','needed',true)`, [wedding,purchase])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length,124)
  await migrate('up',ITEM_SETS_LATEST)
  const installed = await snapshot()
  const { wedding_item_versions, pgmigrations, ...existing } = installed.data
  assert.deepEqual(wedding_item_versions,[])
  assert.equal(pgmigrations.length,125)
  assert.deepEqual({ ...existing, pgmigrations: pgmigrations.filter(row => row.name !== ITEM_SETS_MIGRATION) },before.data)
  await migrate('up',ITEM_SETS_LATEST)
  assert.deepEqual(await snapshot(),installed)
  await migrate('down',ITEM_SETS_MIGRATION,undefined,true)
  assert.deepEqual(await snapshot(),before)
  await migrate('up',ITEM_SETS_LATEST)
  const insert = `insert into wedding_item_versions(wedding_id,id,version,title,kit,purchase_id)
    values($1,$2,1,'Item','ceremony',$3)`
  await assert.rejects(() => db.query(insert,[foreignWedding,item,purchase]),{code:'23503'})
  await db.query(insert,[wedding,item,purchase])
  const populated = await snapshot()
  await migrate('down',ITEM_SETS_MIGRATION,'wedding_item_sets_rollback_preserves_history',true)
  assert.deepEqual(await snapshot(),populated)
  await db.query('delete from weddings where id=any($1::uuid[])',[[wedding,foreignWedding]])
  assert.equal((await db.query('select id from wedding_item_versions where wedding_id=$1',[wedding])).rowCount,0)
  process.stdout.write('WP13_ITEM_SETS_MIGRATION_PASSED\n')
}
