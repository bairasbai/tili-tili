import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const COUPLE_DECISIONS_LATEST = 1765010000000
export const COUPLE_DECISIONS_MIGRATION = '1765010000000_couple_decisions'

export async function runCoupleDecisionsCycle({ db, migrate, snapshot }, weddingId, proposerId, partnerId) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 116)
  await migrate('up', COUPLE_DECISIONS_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 117)
  const { wedding_decisions: decisions, wedding_decision_versions: versions, pgmigrations, ...oldTables } = installed.data
  assert.deepEqual(decisions, [])
  assert.deepEqual(versions, [])
  assert.deepEqual({ ...oldTables, pgmigrations: pgmigrations.filter(row => row.name !== COUPLE_DECISIONS_MIGRATION) }, before.data)
  await migrate('up', COUPLE_DECISIONS_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', COUPLE_DECISIONS_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)

  await migrate('up', COUPLE_DECISIONS_LATEST)
  const id = randomUUID()
  await db.query(`insert into wedding_decisions(id,wedding_id,proposer_id,partner_id,request_id,title)
    values($1,$2,$3,$4,$5,'Synthetic decision')`, [id, weddingId, proposerId, partnerId, randomUUID()])
  await db.query(`insert into wedding_decision_versions(decision_id,version,author_id,proposal,proposer_response,partner_response,effective_at)
    values($1,1,$2,'Accepted proposal','approved','approved',now()),($1,2,$2,'Pending proposal',null,null,null)`, [id, proposerId])
  await assert.rejects(() => db.query('update wedding_decision_versions set effective_at=now() where decision_id=$1 and version=2', [id]), { code: '23514' })
  const populated = await snapshot()
  await migrate('down', COUPLE_DECISIONS_MIGRATION, 'wedding_decisions_preserving_down_fr007', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from wedding_decisions where id=$1 and wedding_id=$2', [id, weddingId])
  process.stdout.write('FR007_COUPLE_DECISIONS_MIGRATION_PASSED\n')
}
