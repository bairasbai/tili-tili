import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const TASK_DELEGATIONS_LATEST = 1765020000000
export const TASK_DELEGATIONS_MIGRATION = '1765020000000_wedding_task_delegations'

export async function runTaskDelegationsCycle({ db, migrate, snapshot }, weddingId, issuerId, recipientId) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 117)
  await migrate('up', TASK_DELEGATIONS_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 118)
  const { wedding_task_delegations: grants, pgmigrations, ...existing } = installed.data
  assert.deepEqual(grants, [])
  assert.deepEqual({ ...existing, pgmigrations: pgmigrations.filter(row => row.name !== TASK_DELEGATIONS_MIGRATION) }, before.data)
  await migrate('up', TASK_DELEGATIONS_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', TASK_DELEGATIONS_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)

  await migrate('up', TASK_DELEGATIONS_LATEST)
  const task = randomUUID(), grant = randomUUID()
  await db.query("insert into tasks(id,wedding_id,title,source,kind,period) values($1,$2,'Synthetic task','user','checklist','3')", [task, weddingId])
  await db.query(`insert into wedding_task_delegations(id,wedding_id,task_id,issued_by,code_hash,expires_at,accepted_by,accepted_at)
    values($1,$2,$3,$4,repeat('1',64),now()+interval '7 days',$5,now())`, [grant, weddingId, task, issuerId, recipientId])
  const populated = await snapshot()
  await migrate('down', TASK_DELEGATIONS_MIGRATION, 'wedding_task_delegations_preserving_down_fr008', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from tasks where id=$1 and wedding_id=$2', [task, weddingId])
  assert.equal((await db.query('select id from wedding_task_delegations where id=$1', [grant])).rowCount, 0)
  process.stdout.write('FR008_TASK_DELEGATIONS_MIGRATION_PASSED\n')
}
