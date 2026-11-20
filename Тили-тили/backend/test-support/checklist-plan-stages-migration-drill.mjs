import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const CHECKLIST_STAGES_LATEST = 1764990000000
export const CHECKLIST_STAGES_MIGRATION = '1764990000000_checklist_plan_stages'
const stages = ['12', 'last_week', 'wedding_day', 'after_wedding']

export async function runChecklistStagesCycle({ db, migrate, snapshot }, weddingId) {
  const draft = randomUUID()
  await db.query(`insert into weddings(id,owner_id,title,tz,invite_code)
    select $2::uuid,owner_id,'FR003 undated fixture',tz,$2::uuid::text from weddings where id=$1`, [weddingId, draft])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 114)
  await migrate('up', CHECKLIST_STAGES_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 115)
  const oldIds = new Set(before.data.tasks.map(task => task.id))
  const oldTasks = installed.data.tasks.filter(task => oldIds.has(task.id))
  const pgmigrations = installed.data.pgmigrations.filter(row => row.name !== CHECKLIST_STAGES_MIGRATION)
  assert.deepEqual({ ...installed.data, tasks: oldTasks, pgmigrations }, before.data)
  assert.deepEqual(installed.schema, before.schema)

  const readStages = id => installed.data.tasks.filter(task => task.wedding_id === id && !oldIds.has(task.id))
    .sort((left, right) => left.sort - right.sort)
  const dated = readStages(weddingId), undated = readStages(draft)
  assert.deepEqual(dated.map(task => task.period), stages)
  assert.deepEqual(undated.map(task => task.period), stages)
  assert(undated.every(task => task.due === null))
  assert(dated.every(task => task.due && task.kind === 'checklist' && task.source === 'system'))
  const { rows: [expected] } = await db.query(`select
    (date-interval '12 months')::date::text as year, (date-7)::text as week,
    date::text as day, (date+7)::text as after from weddings where id=$1`, [weddingId])
  assert.deepEqual(dated.map(task => task.due), [expected.year, expected.week, expected.day, expected.after])

  await migrate('up', CHECKLIST_STAGES_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', CHECKLIST_STAGES_MIGRATION, 'checklist_preserve_plan_stages_fr003', true)
  assert.deepEqual(await snapshot(), installed)
  await db.query('delete from weddings where id=$1', [draft])
  process.stdout.write('FR003_CHECKLIST_STAGES_MIGRATION_PASSED\n')
}
