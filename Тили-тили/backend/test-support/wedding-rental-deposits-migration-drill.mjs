import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const RENTAL_DEPOSITS_LATEST = 1765080000000
export const RENTAL_DEPOSITS_MIGRATION = '1765080000000_wedding_rental_deposits'

export async function runRentalDepositsCycle({ db, migrate, snapshot }, ownerId) {
  const wedding = randomUUID(), item = randomUUID()
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic rental',$3)", [wedding, ownerId, wedding])
  await db.query(`insert into wedding_purchase_versions(wedding_id,id,version,title,quantity,unit,category_id,status,status_changed,actor_id)
    values($1,$2,1,'Old purchase',1,'unit','b2','needed',true,$3)`, [wedding,item,ownerId])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length,123)
  await migrate('up', RENTAL_DEPOSITS_LATEST)
  const installed = await snapshot()
  const { wedding_purchase_versions: purchases, pgmigrations, ...existing } = installed.data
  assert.equal(pgmigrations.length,124)
  const projected = purchases.map(({ rental_pickup_on, rental_return_on, deposit_expected, deposit_paid, deposit_refunded,
    deposit_disputed, rental_changed, ...previous }) => {
    assert.deepEqual([rental_pickup_on,rental_return_on,deposit_expected,deposit_paid,deposit_refunded,deposit_disputed,rental_changed],
      [null,null,null,null,null,null,false])
    return previous
  })
  const order = (a,b) => a.wedding_id.localeCompare(b.wedding_id) || a.id.localeCompare(b.id) || a.version - b.version
  assert.deepEqual(projected.sort(order), [...before.data.wedding_purchase_versions].sort(order))
  assert.deepEqual({ ...existing, wedding_purchase_versions: before.data.wedding_purchase_versions,
    pgmigrations: pgmigrations.filter(row => row.name !== RENTAL_DEPOSITS_MIGRATION) }, before.data)
  await migrate('up', RENTAL_DEPOSITS_LATEST)
  assert.deepEqual(await snapshot(),installed)
  await migrate('down', RENTAL_DEPOSITS_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(),before)
  await migrate('up', RENTAL_DEPOSITS_LATEST)
  const insert = `insert into wedding_purchase_versions(wedding_id,id,version,title,quantity,unit,category_id,status,status_changed,
    rental_pickup_on,rental_return_on,deposit_expected,deposit_paid,deposit_refunded,deposit_disputed,rental_changed)
    values($1,$2,1,'Rental',1,'unit','b2','needed',true,'2027-06-01','2027-06-02',50000,30000,$3,$4,true)`
  const rental = randomUUID()
  await assert.rejects(() => db.query(insert,[wedding,rental,40000,0]),{code:'23514'})
  await assert.rejects(() => db.query(insert,[wedding,rental,25000,10000]),{code:'23514'})
  await db.query(insert,[wedding,rental,25000,5000])
  const populated = await snapshot()
  await migrate('down',RENTAL_DEPOSITS_MIGRATION,'wedding_rental_deposits_rollback_preserves_history',true)
  assert.deepEqual(await snapshot(),populated)
  await db.query('delete from weddings where id=$1',[wedding])
  const rows = await db.query('select id from wedding_purchase_versions where wedding_id=$1',[wedding])
  assert.equal(rows.rowCount,0)
  process.stdout.write('WP13_RENTAL_DEPOSITS_MIGRATION_PASSED\n')
}
