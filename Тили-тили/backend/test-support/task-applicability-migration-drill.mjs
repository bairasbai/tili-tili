import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const TASK_APPLICABILITY_LATEST = 1764980000000
export const TASK_APPLICABILITY_MIGRATION = '1764980000000_task_applicability'

export async function runTaskApplicabilityCycle({ db, migrate, snapshot }, weddingId) {
  const taskId = randomUUID()
  await db.query(`insert into tasks(id,wedding_id,title,period,source,kind,sort)
    values($1,$2,'FR003 migration fixture','9','system','checklist',1000)`, [taskId, weddingId])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 113)
  await migrate('up', TASK_APPLICABILITY_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 114)
  for (const task of installed.data.tasks) assert.equal(task.excluded_reason, null)
  const tasks = installed.data.tasks.map(({ excluded_reason: _excludedReason, ...task }) => task)
  const pgmigrations = installed.data.pgmigrations.filter(row => row.name !== TASK_APPLICABILITY_MIGRATION)
  assert.deepEqual({ ...installed.data, tasks, pgmigrations }, before.data)
  await migrate('up', TASK_APPLICABILITY_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', TASK_APPLICABILITY_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', TASK_APPLICABILITY_LATEST)
  const setReason = reason => db.query('update tasks set excluded_reason=$2 where id=$1', [taskId, reason])
  await assert.rejects(() => setReason(' '), { code: '23514' })
  await assert.rejects(() => setReason('a'.repeat(501)), { code: '23514' })
  await setReason('Пара выбрала другой вариант')
  const excluded = await snapshot()
  await migrate('down', TASK_APPLICABILITY_MIGRATION, 'tasks_preserve_exclusions_fr003', true)
  assert.deepEqual(await snapshot(), excluded)
  await db.query('delete from tasks where id=$1 and wedding_id=$2', [taskId, weddingId])
  process.stdout.write('FR003_TASK_APPLICABILITY_MIGRATION_PASSED\n')
}
