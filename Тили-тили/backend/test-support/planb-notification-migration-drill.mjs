import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const PLANB_BATCH_MIGRATION = '1764860000000_planb_notification_batches'
export const PLANB_BATCH_LATEST = 1764860000000
const GUARD = 'planb_notification_batch_preserving_down_t016'
const added = { broadcasts: 'planb_current', notifications: 'broadcast_id' }
const isAdded = row => added[row.table_name] === row.column_name

export async function runPlanBBatchCycle({ migrate, snapshot }) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 101)
  await migrate('up', PLANB_BATCH_LATEST)
  const after = await snapshot()
  assert.equal(after.data.pgmigrations.length, 102)
  for (const [table, rows] of Object.entries(before.data)) {
    let actual = after.data[table]
    if (table === 'pgmigrations') actual = actual.filter(row => row.name !== PLANB_BATCH_MIGRATION)
    if (Object.hasOwn(added, table)) actual = actual.map(row => {
      assert.equal(row[added[table]], null, 'Historical rows must not acquire inferred notice links')
      const { [added[table]]: unused, ...original } = row
      assert.equal(unused, null)
      return original
    })
    assert.deepEqual(actual, rows, 'Previous rows must survive: ' + table)
  }
  assert.deepEqual(after.schema.columns.filter(row => !isAdded(row)), before.schema.columns)
  await migrate('up', PLANB_BATCH_LATEST)
  assert.deepEqual(await snapshot(), after)
  await migrate('down', PLANB_BATCH_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', PLANB_BATCH_LATEST)
  const replayed = await snapshot()
  const columns = replayed.schema.columns.map(row => isAdded(row)
    ? { ...row, ordinal_position: row.ordinal_position - 1, dtd_identifier: String(Number(row.dtd_identifier) - 1) }
    : row)
  assert.deepEqual({ ...replayed.schema, columns }, after.schema)
  assert.equal(replayed.data.pgmigrations.length, before.data.pgmigrations.length + 1)
  assert.deepEqual(replayed.data.pgmigrations.filter(row => row.name !== PLANB_BATCH_MIGRATION), before.data.pgmigrations)
}

export async function runPlanBBatchGuardedDown({ db, migrate, snapshot }, wedding, user) {
  const broadcastId = randomUUID(), noticeId = randomUUID()
  await db.query("insert into broadcasts(id,wedding_id,action,recipients,planb_current) values($1,$2,'planb:rain',0,true)", [broadcastId, wedding])
  await db.query("insert into notifications(id,user_id,kind,title,body,broadcast_id) values($1,$2,'system','Synthetic Plan B','Migration check',$3)", [noticeId, user, broadcastId])
  const before = await snapshot()
  await migrate('down', PLANB_BATCH_MIGRATION, GUARD, true)
  assert.deepEqual(await snapshot(), before)
  await db.query('delete from broadcasts where id=$1', [broadcastId])
  assert.deepEqual((await db.query('select broadcast_id,title from notifications where id=$1', [noticeId])).rows,
    [{ broadcast_id: null, title: 'Synthetic Plan B' }])
  await db.query('delete from notifications where id=$1', [noticeId])
}
