import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

export const HOME_TIP_DECISIONS_LATEST = 1764970000000
export const HOME_TIP_DECISIONS_MIGRATION = '1764970000000_home_tip_decisions'

export async function runHomeTipDecisionsCycle({ db, migrate, snapshot }, weddingId) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 112)
  await migrate('up', HOME_TIP_DECISIONS_LATEST)
  const installed = await snapshot()
  const { home_tip_decisions: decisions, ...existing } = installed.data
  assert.deepEqual(decisions, [])
  assert.equal(existing.pgmigrations.length, 113)
  assert.deepEqual({ ...existing, pgmigrations: existing.pgmigrations.filter(row => row.name !== HOME_TIP_DECISIONS_MIGRATION) }, before.data)
  await migrate('up', HOME_TIP_DECISIONS_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', HOME_TIP_DECISIONS_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', HOME_TIP_DECISIONS_LATEST)

  if (weddingId) {
    const tipId = randomBytes(32).toString('hex')
    const insert = (state, revision) => db.query('insert into home_tip_decisions(wedding_id,tip_id,state,revision) values($1,$2,$3,$4)',
      [weddingId, tipId, state, revision])
    await assert.rejects(() => insert('unsupported', 1), { code: '23514' })
    await assert.rejects(() => insert('resolved', 0), { code: '23514' })
    await insert('resolved', 1)
    await assert.rejects(() => insert('not_applicable', 2), { code: '23505' })
    await db.query('update home_tip_decisions set state=null,revision=2 where wedding_id=$1 and tip_id=$2', [weddingId, tipId])
    const restored = await snapshot()
    await migrate('down', HOME_TIP_DECISIONS_MIGRATION, 'home_tip_decisions_preserving_down_fr063', true)
    assert.deepEqual(await snapshot(), restored)
    await db.query('delete from home_tip_decisions where wedding_id=$1 and tip_id=$2', [weddingId, tipId])
  }
  process.stdout.write(`FR063_HOME_TIP_DECISION_MIGRATION_PASSED guardedDown=${Boolean(weddingId)}\n`)
}
