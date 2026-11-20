import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const PERSON_LODGING_LATEST = 1765130000000
export const PERSON_LODGING_MIGRATION = '1765130000000_person_lodging'

export async function runPersonLodgingCycle({ db, migrate, snapshot }, owner) {
  const wedding = randomUUID(), guest = randomUUID(), second = randomUUID()
  const hotel = randomUUID(), room = randomUUID(), stay = randomUUID()
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic lodging',$3)",
    [wedding,owner,wedding])
  for (const id of [guest,second]) {
    await db.query("insert into guests(id,wedding_id,name,rsvp_token) values($1,$2,'Synthetic person',$3)",
      [id,wedding,randomUUID()])
  }
  await db.query("insert into hotel_blocks(id,wedding_id,name,rooms) values($1,$2,'Synthetic hotel',1)",[hotel,wedding])
  await db.query('insert into hotel_bookings(hotel_id,guest_id) values($1,$2)',[hotel,guest])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length,128)
  await migrate('up',PERSON_LODGING_LATEST)
  const installed = await snapshot()
  const { lodging_rooms, lodging_placements, pgmigrations, ...existing } = installed.data
  assert.deepEqual(lodging_rooms,[])
  assert.deepEqual(lodging_placements,[])
  assert.equal(pgmigrations.length,129)
  assert.equal(Object.keys(installed.data).length,151)
  assert.deepEqual({ ...existing, pgmigrations: pgmigrations.filter(row => row.name !== PERSON_LODGING_MIGRATION) },before.data)
  await migrate('up',PERSON_LODGING_LATEST)
  assert.deepEqual(await snapshot(),installed)
  await migrate('down',PERSON_LODGING_MIGRATION,undefined,true)
  assert.deepEqual(await snapshot(),before)
  await migrate('up',PERSON_LODGING_LATEST)

  const createRoom = (legacyGuest) => db.query(`insert into lodging_rooms
    (wedding_id,id,hotel_id,label,capacity,legacy_guest_id) values($1,$2,$3,'301',1,$4)`,[wedding,room,hotel,legacyGuest])
  await assert.rejects(() => createRoom(null),{code:'23514',constraint:'hotel_inventory_bounded'})
  await createRoom(guest)
  assert.deepEqual((await db.query('select lodging_inventory_used($1) as used',[hotel])).rows,[{used:1}])
  const place = (id, person, from, to) => db.query(`insert into lodging_placements
    (wedding_id,id,room_id,guest_id,check_in,check_out,source) values($1,$2,$3,$4,$5,$6,'hotel')`,
  [wedding,id,room,person,from,to])
  await place(stay,guest,'2027-06-12','2027-06-14')
  await assert.rejects(() => place(randomUUID(),second,'2027-06-13','2027-06-15'),
    {code:'23514',constraint:'lodging_room_capacity'})
  await assert.rejects(() => place(randomUUID(),guest,'2027-06-13','2027-06-15'),
    {code:'23P01',constraint:'lodging_guest_no_overlap'})
  await place(randomUUID(),second,'2027-06-14','2027-06-15')
  const populated = await snapshot()
  await migrate('down',PERSON_LODGING_MIGRATION,'Cannot remove the lodging schema while it contains rooms',true)
  assert.deepEqual(await snapshot(),populated)
  await db.query('delete from weddings where id=$1',[wedding])
  assert.equal((await db.query('select from lodging_rooms where wedding_id=$1',[wedding])).rowCount,0)
  assert.equal((await db.query('select from lodging_placements where wedding_id=$1',[wedding])).rowCount,0)
  process.stdout.write('WP14_PERSON_LODGING_MIGRATION_PASSED\n')
}
