import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const SUPPORT_MIGRATION = '1764940000000_support_cases'
export const SUPPORT_LATEST = 1764940000000

export async function runSupportCasesCycle({ db, migrate, snapshot }, owner) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 109)
  await migrate('up', SUPPORT_LATEST)
  const empty = await snapshot()
  assert.equal(empty.data.pgmigrations.length, 110)
  const { support_cases: cases, support_case_events: events, ...old } = empty.data
  assert.deepEqual([cases, events], [[], []])
  assert.deepEqual({ ...old, pgmigrations: old.pgmigrations.filter(row => row.name !== SUPPORT_MIGRATION) }, before.data)
  await migrate('up', SUPPORT_LATEST)
  assert.deepEqual(await snapshot(), empty)
  await migrate('down', SUPPORT_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', SUPPORT_LATEST)
  const id = randomUUID()
  await db.query("insert into support_cases(id,owner_id,subject) values($1,$2,'Synthetic support')", [id, owner])
  await db.query("insert into support_case_events(id,case_id,actor_id,kind,message) values($1,$2,$3,'opened','Synthetic message')",
    [randomUUID(), id, owner])
  const populated = await snapshot()
  await migrate('down', SUPPORT_MIGRATION, 'support_cases_preserving_down_fr068', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from support_cases where id=$1', [id])
  process.stdout.write('SUPPORT_CASES110_PRESERVING_PASSED emptyCycle=1 exactRepeat=1 populatedRefusal=1\n')
}
