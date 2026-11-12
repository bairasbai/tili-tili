import assert from 'node:assert/strict'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'

export const WEDDING_STAFF_LATEST = 1765140000000
export const WEDDING_STAFF_MIGRATION = '1765140000000_wedding_staff_delegations'

export async function runWeddingStaffCycle({ db, migrate, snapshot }, owner) {
  const wedding = randomUUID(), organizer = randomUUID(), employee = randomUUID()
  const legacyTask = randomUUID(), staffTask = randomUUID(), staleTask = randomUUID()
  for (const id of [organizer, employee]) {
    const phone = '+1555' + String(randomInt(0, 10_000_000)).padStart(7, '0')
    await db.query("insert into users(id,phone,name) values($1,$2,'Synthetic staff')",[id,phone])
  }
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic staffing',$3)",[wedding,owner,wedding])
  await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'coordinator')",[wedding,owner,organizer])
  for (const task of [legacyTask, staffTask, staleTask]) {
    await db.query("insert into tasks(id,wedding_id,title,kind,source,period) values($1,$2,'Synthetic duty','checklist','user','3')",[task,wedding])
  }
  const legacy = randomUUID()
  await db.query(`insert into wedding_task_delegations(id,wedding_id,task_id,issued_by,code_hash,expires_at,accepted_by,accepted_at)
    values($1,$2,$3,$4,$5,now()+interval '7 days',$6,now())`,[legacy,wedding,legacyTask,owner,randomBytes(32).toString('hex'),employee])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length,129)
  await migrate('up',WEDDING_STAFF_LATEST)
  const installed = await snapshot()
  const { pgmigrations, wedding_task_delegations, ...existing } = installed.data
  assert.equal(pgmigrations.length,130)
  assert.equal(Object.keys(installed.data).length,151)
  const priorGrants = wedding_task_delegations.map(({ issued_as, target_user_id, ...row }) => {
    assert.equal(issued_as,'couple')
    assert.equal(target_user_id,null)
    return row
  })
  const order = (a,b) => a.id.localeCompare(b.id)
  assert.deepEqual(priorGrants.sort(order),[...before.data.wedding_task_delegations].sort(order))
  assert.deepEqual({ ...existing, wedding_task_delegations: before.data.wedding_task_delegations,
    pgmigrations: pgmigrations.filter(row => row.name !== WEDDING_STAFF_MIGRATION) },before.data)
  await migrate('up',WEDDING_STAFF_LATEST)
  assert.deepEqual(await snapshot(),installed)
  await migrate('down',WEDDING_STAFF_MIGRATION,undefined,true)
  assert.deepEqual(await snapshot(),before)

  // A historical issuer lost couple authority before this migration existed.
  const stale = randomUUID()
  await db.query("update wedding_members set role='couple' where wedding_id=$1 and user_id=$2",[wedding,organizer])
  await db.query(`insert into wedding_task_delegations(id,wedding_id,task_id,issued_by,code_hash,expires_at)
    values($1,$2,$3,$4,$5,now()+interval '7 days')`,[stale,wedding,staleTask,organizer,randomBytes(32).toString('hex')])
  await db.query("update wedding_members set role='coordinator' where wedding_id=$1 and user_id=$2",[wedding,organizer])
  await migrate('up',WEDDING_STAFF_LATEST)
  const retired = async (id, reason) => {
    assert.equal((await db.query('select revoked_at is not null as retired from wedding_task_delegations where id=$1',[id])).rows[0].retired,true)
    assert.equal((await db.query(`select count(*)::int as events from audit_log
      where action='task_delegation.access_ended' and diff->>'delegationId'=$1 and diff->>'reason'=$2`,[id,reason])).rows[0].events,1)
  }
  await retired(stale,'previous_authority_ended')
  const add = (id, target) => db.query(`insert into wedding_task_delegations
    (id,wedding_id,task_id,issued_by,code_hash,expires_at,issued_as,target_user_id)
    values($1,$2,$3,$4,$5,now()+interval '7 days','coordinator',$6)`,[id,wedding,staffTask,organizer,randomBytes(32).toString('hex'),target])
  await assert.rejects(() => add(randomUUID(),null),{code:'23514',constraint:'wedding_task_staff_target'})
  const staff = randomUUID()
  await add(staff,employee)
  await assert.rejects(() => db.query('update wedding_task_delegations set accepted_by=$2,accepted_at=now() where id=$1',[staff,owner]),
    {code:'23514',constraint:'wedding_task_staff_target'})
  await db.query('delete from wedding_members where wedding_id=$1 and user_id=$2',[wedding,organizer])
  await retired(staff,'issuer_access_lost')
  await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'coordinator')",[wedding,organizer])
  const next = randomUUID()
  await add(next,employee)
  await db.query('update users set deleted_at=now() where id=$1',[employee])
  await retired(next,'account_removed')
  await retired(legacy,'account_removed')
  const populated = await snapshot()
  await migrate('down',WEDDING_STAFF_MIGRATION,'wedding_staff_delegations_preserving_down_fr052',true)
  assert.deepEqual(await snapshot(),populated)
  await db.query('delete from weddings where id=$1',[wedding])
  await db.query('delete from users where id=any($1::uuid[])',[[organizer,employee]])
  process.stdout.write('WP14_WEDDING_STAFF_MIGRATION_PASSED\n')
}
