import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const FINAL_MENU_LATEST = 1765000000000
export const FINAL_MENU_MIGRATION = '1765000000000_checklist_final_menu'

export async function runFinalMenuCycle({ db, migrate, snapshot }, weddingId) {
  const draft = randomUUID()
  await db.query(`insert into weddings(id,owner_id,title,tz,invite_code)
    select $2::uuid,owner_id,'FR005 undated fixture',tz,$2::uuid::text from weddings where id=$1`, [weddingId, draft])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 115)
  await migrate('up', FINAL_MENU_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 116)
  const oldIds = new Set(before.data.tasks.map(task => task.id))
  const oldTasks = installed.data.tasks.filter(task => oldIds.has(task.id))
  const pgmigrations = installed.data.pgmigrations.filter(row => row.name !== FINAL_MENU_MIGRATION)
  assert.deepEqual({ ...installed.data, tasks: oldTasks, pgmigrations }, before.data)
  assert.deepEqual(installed.schema, before.schema)
  const { rows: [deadline] } = await db.query(
    "select (date-interval '1 month')::date::text as due from weddings where id=$1", [weddingId])
  for (const [id, due] of [[weddingId, deadline.due], [draft, null]]) {
    const rows = installed.data.tasks.filter(task => task.wedding_id === id && !oldIds.has(task.id))
    assert.equal(rows.length, 1)
    const [row] = rows
    assert.deepEqual([row.title, row.period, row.sort, row.source, row.kind, row.due],
      ['Утвердить окончательное меню', '1', 16, 'system', 'checklist', due])
  }
  await migrate('up', FINAL_MENU_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', FINAL_MENU_MIGRATION, 'checklist_preserve_final_menu_fr005', true)
  assert.deepEqual(await snapshot(), installed)
  await db.query('delete from weddings where id=$1', [draft])
  process.stdout.write('FR005_CHECKLIST_FINAL_MENU_MIGRATION_PASSED\n')
}
