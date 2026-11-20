import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'

export const APPEAL_MIGRATION = '1764960000000_complaint_appeals'
export const APPEAL_LATEST = 1764960000000

export async function runComplaintAppealCycle({ db, migrate, snapshot }, reporter) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 111)
  await migrate('up', APPEAL_LATEST)
  const installed = await snapshot()
  const { complaint_appeals: appeals, ...existing } = installed.data
  assert.deepEqual(appeals, [])
  assert.equal(existing.pgmigrations.length, 112)
  assert.deepEqual({
    ...existing,
    pgmigrations: existing.pgmigrations.filter(row => row.name !== APPEAL_MIGRATION),
    complaints: existing.complaints.map(({ affected_user_id, ...old }) => {
      assert.equal(affected_user_id, null)
      return old
    }),
    reviews: existing.reviews.map(({ author_user_id, ...old }) => {
      assert.equal(author_user_id, null)
      return old
    }),
  }, before.data)
  await migrate('up', APPEAL_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', APPEAL_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', APPEAL_LATEST)

  const account = randomUUID(), complaint = randomUUID(), appeal = randomUUID()
  await db.query('insert into users(id,phone) values($1,$2)', [account, '+79' + randomInt(100000000, 1000000000)])
  await db.query(`insert into complaints(id,reporter_id,target_kind,target_id,category,status,resolution,resolved_at,affected_user_id)
    values($1,$2,'vendor',$3,'spam','resolved','warn',now(),$4)`, [complaint, reporter, randomUUID(), account])
  await db.query(`insert into complaint_appeals(id,complaint_id,appellant_id,appellant_role,message)
    values($1,$2,$3,'affected','Synthetic appeal draft')`, [appeal, complaint, account])
  await db.query("update complaint_appeals set outcome='changed',new_action='dismiss',reason='Synthetic decision',resolved_at=clock_timestamp() where id=$1", [appeal])
  const populated = await snapshot()
  await migrate('down', APPEAL_MIGRATION, 'complaint_appeals_preserving_down_fr069', true)
  assert.deepEqual(await snapshot(), populated)

  await db.query('delete from users where id=$1', [account])
  const erased = await db.query(`select a.appellant_id,a.message,a.reason,a.outcome,a.new_action,c.affected_user_id
    from complaint_appeals a join complaints c on c.id=a.complaint_id where a.id=$1`, [appeal])
  assert.deepEqual(erased.rows, [{ appellant_id: null, message: null, reason: null, outcome: 'changed', new_action: 'dismiss', affected_user_id: null }])
  await db.query('delete from complaint_appeals where id=$1', [appeal])
  await db.query('delete from complaints where id=$1', [complaint])
  process.stdout.write('FR-069 appeal migration: legacy rows retained, repeat up and empty down stable, populated down refused, personal text erased\n')
}
