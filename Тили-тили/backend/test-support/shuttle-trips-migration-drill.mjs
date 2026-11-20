import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const SHUTTLE_TRIPS_LATEST = 1765100000000
export const SHUTTLE_TRIPS_MIGRATION = '1765100000000_shuttle_trips'

export async function runShuttleTripsCycle({ db, migrate, snapshot }, ownerId) {
  const wedding = randomUUID(), foreignWedding = randomUUID(), passenger = randomUUID(), route = randomUUID()
  const event = randomUUID(), foreignEvent = randomUUID()
  for (const id of [wedding, foreignWedding]) {
    await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic transfer',$3)", [id,ownerId,id])
  }
  await db.query("insert into guests(id,wedding_id,name,rsvp_token) values($1,$2,'Passenger',$3)", [passenger,wedding,randomUUID()])
  await db.query("insert into bus_routes(id,wedding_id,name,pickup,departs,seats) values($1,$2,'Route','Stop','14:20',2)", [route,wedding])
  await db.query('insert into bus_bookings(bus_id,guest_id) values($1,$2)', [route,passenger])
  for (const [id, weddingId] of [[event,wedding],[foreignEvent,foreignWedding]]) {
    await db.query("insert into wedding_events(id,wedding_id,name,kind) values($1,$2,'Additional','other')", [id,weddingId])
  }
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length,125)
  await migrate('up',SHUTTLE_TRIPS_LATEST)
  const installed = await snapshot()
  const { bus_routes: trips, pgmigrations, ...existing } = installed.data
  const legacy = trips.map(({ program_event_id, direction, departure_date, destination, stops, public_contact, ...row }) => {
    assert.deepEqual([program_event_id,direction,departure_date,destination,stops,public_contact],[null,'outbound',null,null,[],null])
    return row
  })
  const order = (a,b) => a.id.localeCompare(b.id)
  assert.deepEqual(legacy.sort(order),[...before.data.bus_routes].sort(order))
  assert.equal(pgmigrations.length,126)
  assert.deepEqual({ ...existing, bus_routes: before.data.bus_routes,
    pgmigrations: pgmigrations.filter(row => row.name !== SHUTTLE_TRIPS_MIGRATION) },before.data)
  await migrate('up',SHUTTLE_TRIPS_LATEST)
  assert.deepEqual(await snapshot(),installed)
  await migrate('down',SHUTTLE_TRIPS_MIGRATION,undefined,true)
  assert.deepEqual(await snapshot(),before)
  await migrate('up',SHUTTLE_TRIPS_LATEST)
  const addReturn = `insert into bus_routes(id,wedding_id,program_event_id,name,seats,direction,destination,stops,departure_date)
    values($1,$2,$3,'Return',2,'return','Station',array['Park'],'2027-06-14')`
  const returnRoute = randomUUID()
  await assert.rejects(() => db.query(addReturn,[returnRoute,wedding,foreignEvent]),{code:'23503'})
  await db.query(addReturn,[returnRoute,wedding,event])
  await db.query('insert into bus_bookings(bus_id,guest_id) values($1,$2)',[returnRoute,passenger])
  const { rows } = await db.query('select taken from bus_routes where id=any($1::uuid[])',[[route,returnRoute]])
  assert.deepEqual(rows,[{taken:1},{taken:1}])
  const populated = await snapshot()
  await migrate('down',SHUTTLE_TRIPS_MIGRATION,'shuttle_trips_rollback_preserves_routes',true)
  assert.deepEqual(await snapshot(),populated)
  await db.query('delete from weddings where id=any($1::uuid[])',[[wedding,foreignWedding]])
  assert.equal((await db.query('select id from bus_routes where wedding_id=$1',[wedding])).rowCount,0)
  process.stdout.write('WP14_SHUTTLE_TRIPS_MIGRATION_PASSED\n')
}
