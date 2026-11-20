import assert from 'node:assert/strict'

export const DELIVERY_MIGRATION = '1764910000000_order_deliveries'
export const DELIVERY_LATEST = 1764910000000

export async function runOrderDeliveryCycle({ db, migrate, snapshot }, wedding, deal, actor) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 106)
  await migrate('up', DELIVERY_LATEST)
  const empty = await snapshot()
  assert.equal(empty.data.pgmigrations.length, 107)
  assert.deepEqual(empty.data.order_delivery_steps, [])
  const oldRows = { ...empty.data, pgmigrations: empty.data.pgmigrations.filter(row => row.name !== DELIVERY_MIGRATION) }
  delete oldRows.order_delivery_steps
  assert.deepEqual(oldRows, before.data)
  await migrate('up', DELIVERY_LATEST)
  assert.deepEqual(await snapshot(), empty)
  await migrate('down', DELIVERY_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', DELIVERY_LATEST)
  await db.query(`insert into order_delivery_steps(wedding_id,deal_id,revision,kind,actor_id,summary,material_url,due_on)
    values($1,$2,1,'submitted',$3,'Synthetic delivery','https://example.invalid/material','2027-06-15')`, [wedding, deal, actor])
  const populated = await snapshot()
  await migrate('down', DELIVERY_MIGRATION, 'order_delivery_preserving_down_t012', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from order_delivery_steps where wedding_id=$1 and deal_id=$2', [wedding, deal])
  process.stdout.write('ORDER_DELIVERY107_PRESERVING_PASSED emptyCycle=1 exactRepeat=1 populatedRefusal=1\n')
}
