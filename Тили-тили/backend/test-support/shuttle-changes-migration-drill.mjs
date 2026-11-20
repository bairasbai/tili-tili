import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const SHUTTLE_CHANGES_LATEST = 1765110000000
export const SHUTTLE_CHANGES_MIGRATION = '1765110000000_shuttle_changes'

export async function runShuttleChangesCycle({ db, migrate, snapshot }, ownerId) {
  const wedding = randomUUID(), passenger = randomUUID(), from = randomUUID(), to = randomUUID(), request = randomUUID()
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic shuttle change',$3)",[wedding,ownerId,wedding])
  await db.query("insert into guests(id,wedding_id,name,rsvp_token) values($1,$2,'Passenger',$3)",[passenger,wedding,randomUUID()])
  for (const [id,name] of [[from,'From'],[to,'To']]) {
    await db.query('insert into bus_routes(id,wedding_id,name,seats) values($1,$2,$3,2)',[id,wedding,name])
  }
  await db.query('insert into bus_bookings(bus_id,guest_id) values($1,$2)',[from,passenger])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length,126)
  await migrate('up',SHUTTLE_CHANGES_LATEST)
  const installed = await snapshot()
  const { bus_routes: routes, shuttle_change_requests, pgmigrations, ...existing } = installed.data
  assert.deepEqual(shuttle_change_requests,[])
  assert.equal(pgmigrations.length,127)
  const legacy = routes.map(({ deadline_on, replacement_contact, replacement_instructions, ...row }) => {
    assert.deepEqual([deadline_on,replacement_contact,replacement_instructions],[null,null,null])
    return row
  })
  const order = (a,b) => a.id.localeCompare(b.id)
  assert.deepEqual(legacy.sort(order),[...before.data.bus_routes].sort(order))
  assert.deepEqual({ ...existing,bus_routes:before.data.bus_routes,
    pgmigrations:pgmigrations.filter(row => row.name !== SHUTTLE_CHANGES_MIGRATION) },before.data)
  await migrate('up',SHUTTLE_CHANGES_LATEST)
  assert.deepEqual(await snapshot(),installed)
  await migrate('down',SHUTTLE_CHANGES_MIGRATION,undefined,true)
  assert.deepEqual(await snapshot(),before)
  await migrate('up',SHUTTLE_CHANGES_LATEST)
  await assert.rejects(() => db.query("update bus_routes set replacement_contact='Dispatcher' where id=$1",[from]),{code:'23514'})
  await db.query(`insert into shuttle_change_requests(wedding_id,id,guest_id,from_bus_id,to_bus_id,from_label,to_label)
    values($1,$2,$3,$4,$5,'From','To')`,[wedding,request,passenger,from,to])
  await db.query('delete from bus_bookings where bus_id=$1 and guest_id=$2',[from,passenger])
  assert.deepEqual((await db.query('select status from shuttle_change_requests where id=$1',[request])).rows,[{status:'withdrawn'}])
  const populated = await snapshot()
  await migrate('down',SHUTTLE_CHANGES_MIGRATION,'shuttle_changes_rollback_preserves_history',true)
  assert.deepEqual(await snapshot(),populated)
  await db.query('delete from weddings where id=$1',[wedding])
  assert.equal((await db.query('select id from shuttle_change_requests where wedding_id=$1',[wedding])).rowCount,0)
  process.stdout.write('WP14_SHUTTLE_CHANGES_MIGRATION_PASSED\n')
}
