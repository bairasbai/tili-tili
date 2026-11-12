import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const ARRIVAL_BOARDING_LATEST = 1765120000000
export const ARRIVAL_BOARDING_MIGRATION = '1765120000000_arrival_boarding'

export async function runArrivalBoardingCycle({ db, migrate, snapshot }, ownerId) {
  const wedding = randomUUID(), passenger = randomUUID(), bus = randomUUID(), change = randomUUID()
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic arrival',$3)",[wedding,ownerId,wedding])
  await db.query("insert into guests(id,wedding_id,name,rsvp_token) values($1,$2,'Passenger',$3)",[passenger,wedding,randomUUID()])
  await db.query("insert into bus_routes(id,wedding_id,name,seats,pickup) values($1,$2,'Route',2,'Original')",[bus,wedding])
  await db.query('insert into bus_bookings(bus_id,guest_id) values($1,$2)',[bus,passenger])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length,127)
  await migrate('up',ARRIVAL_BOARDING_LATEST)
  const installed = await snapshot()
  const { wedding_events: events, shuttle_pickup_notices, pgmigrations, ...existing } = installed.data
  assert.deepEqual(shuttle_pickup_notices,[])
  assert.equal(pgmigrations.length,128)
  const previousEvents = events.map(({ arrival, ...row }) => {
    assert.equal(arrival,null)
    return row
  })
  const order = (a,b) => a.id.localeCompare(b.id)
  assert.deepEqual(previousEvents.sort(order),[...before.data.wedding_events].sort(order))
  assert.deepEqual({ ...existing,wedding_events:before.data.wedding_events,
    pgmigrations:pgmigrations.filter(row => row.name !== ARRIVAL_BOARDING_MIGRATION) },before.data)
  await migrate('up',ARRIVAL_BOARDING_LATEST)
  assert.deepEqual(await snapshot(),installed)
  await migrate('down',ARRIVAL_BOARDING_MIGRATION,undefined,true)
  assert.deepEqual(await snapshot(),before)
  await migrate('up',ARRIVAL_BOARDING_LATEST)
  await assert.rejects(() => db.query('update wedding_events set arrival=$2 where wedding_id=$1 and is_main',
    [wedding,{entrance:'',parking:null,accessibleRoute:null}]),{code:'23514'})
  await db.query('update wedding_events set arrival=$2 where wedding_id=$1 and is_main',
    [wedding,{entrance:'Entrance',parking:null,accessibleRoute:'Ramp'}])
  await db.query(`insert into shuttle_pickup_notices(wedding_id,change_id,guest_id,bus_id,route_label,previous_pickup,pickup)
    values($1,$2,$3,$4,'Route','Original','New')`,[wedding,change,passenger,bus])
  const populated = await snapshot()
  await migrate('down',ARRIVAL_BOARDING_MIGRATION,'arrival_boarding_rollback_preserves_history',true)
  assert.deepEqual(await snapshot(),populated)
  await db.query('delete from weddings where id=$1',[wedding])
  assert.equal((await db.query('select change_id from shuttle_pickup_notices where wedding_id=$1',[wedding])).rowCount,0)
  process.stdout.write('WP14_ARRIVAL_BOARDING_MIGRATION_PASSED\n')
}
