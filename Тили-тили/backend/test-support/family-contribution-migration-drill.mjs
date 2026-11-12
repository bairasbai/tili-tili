import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const FAMILY_CONTRIBUTION_LATEST = 1765050000000
export const FAMILY_CONTRIBUTION_MIGRATION = '1765050000000_budget_family_contributions'

export async function runFamilyContributionCycle({ db, migrate, snapshot }, ownerId) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 120)
  await migrate('up', FAMILY_CONTRIBUTION_LATEST)
  const installed = await snapshot()
  const { budget_family_contribution_versions: versions, pgmigrations, ...existing } = installed.data
  assert.deepEqual(versions, [])
  assert.equal(pgmigrations.length, 121)
  assert.deepEqual({ ...existing, pgmigrations: pgmigrations.filter(row => row.name !== FAMILY_CONTRIBUTION_MIGRATION) }, before.data)
  await migrate('up', FAMILY_CONTRIBUTION_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', FAMILY_CONTRIBUTION_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)

  await migrate('up', FAMILY_CONTRIBUTION_LATEST)
  const wedding = randomUUID(), record = randomUUID()
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic family contribution',$3)", [wedding, ownerId, wedding])
  const insert = `insert into budget_family_contribution_versions
    (wedding_id,id,version,label,promised_amount,received_amount,archived) values($1,$2,$3,'Synthetic promise',$4,$5,false)`
  await assert.rejects(() => db.query(insert, [wedding, record, 1, 0, 0]), { code: '23514' })
  await db.query(insert, [wedding, record, 1, 15000, 0])
  await db.query(insert, [wedding, record, 2, 15000, 5000])
  await assert.rejects(() => db.query('update budget_family_contribution_versions set received_amount=0 where wedding_id=$1', [wedding]), { code: '23514' })
  await assert.rejects(() => db.query('delete from budget_family_contribution_versions where wedding_id=$1', [wedding]), { code: '23514' })
  const populated = await snapshot()
  await migrate('down', FAMILY_CONTRIBUTION_MIGRATION, 'budget_family_contribution_preserving_down_fr016', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from weddings where id=$1', [wedding])
  assert.deepEqual((await snapshot()).data.budget_family_contribution_versions, [])
  process.stdout.write('FR016_FAMILY_CONTRIBUTION_MIGRATION_PASSED\n')
}
