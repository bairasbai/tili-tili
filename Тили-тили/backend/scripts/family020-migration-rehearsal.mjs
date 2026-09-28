#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL or TEST_DATABASE_URL is required')
const target = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('family020 migration rehearsal is allowed only on a local *_test database')
}

const client = new pg.Client({ connectionString: databaseUrl })
await client.connect()

const ids = {
  user: randomUUID(),
  wedding: randomUUID(),
  table: randomUUID(),
  menu: randomUUID(),
  guest: randomUUID(),
  bus: randomUUID(),
  hotel: randomUUID(),
  gift: randomUUID(),
}
const token = `legacy020-${randomUUID()}`
const code = `F020-${randomUUID().slice(0, 8)}`
const weddingCode = `W020-${randomUUID().slice(0, 8)}`
const marker = `family020-migration-${ids.user}`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const mode = process.argv[2]
  if (mode === 'seed') {
    await client.query('begin')
    await client.query(
      `insert into users(id, phone, name) values($1,$2,$3)`,
      [ids.user, `+7999${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0').slice(0, 9)}`, marker],
    )
    await client.query(
      `insert into weddings(id, owner_id, title, invite_code) values($1,$2,$3,$4)`,
      [ids.wedding, ids.user, marker, weddingCode],
    )
    await client.query(
      `insert into tables(id,wedding_id,name,capacity) values($1,$2,'Legacy family table',4)`,
      [ids.table, ids.wedding],
    )
    await client.query(
      `insert into menu_options(id,wedding_id,name,sort) values($1,$2,'Legacy vegan',1)`,
      [ids.menu, ids.wedding],
    )
    await client.query(
      `insert into guests(
         id,wedding_id,name,rsvp,plus_one,group_name,diet,transfer,table_id,menu_option_id,rsvp_token
       ) values($1,$2,'Legacy primary','yes',true,'Legacy family','vegan','need',$3,$4,$5)`,
      [ids.guest, ids.wedding, ids.table, ids.menu, token],
    )
    await client.query(
      `insert into menu_votes(guest_id,option_id) values($1,$2)`,
      [ids.guest, ids.menu],
    )
    await client.query(
      `insert into guest_invite_codes(code,guest_id,expires_at)
       values($1,$2,now()+interval '7 days')`,
      [code, ids.guest],
    )
    await client.query(
      `insert into bus_routes(id,wedding_id,name,seats) values($1,$2,'Legacy family bus',4)`,
      [ids.bus, ids.wedding],
    )
    await client.query(
      `insert into bus_bookings(bus_id,guest_id) values($1,$2)`,
      [ids.bus, ids.guest],
    )
    await client.query(
      `insert into hotel_blocks(id,wedding_id,name,rooms) values($1,$2,'Legacy family hotel',2)`,
      [ids.hotel, ids.wedding],
    )
    await client.query(
      `insert into hotel_bookings(hotel_id,guest_id) values($1,$2)`,
      [ids.hotel, ids.guest],
    )
    await client.query(
      `insert into gifts(id,wedding_id,name,price) values($1,$2,'Legacy family gift',100000)`,
      [ids.gift, ids.wedding],
    )
    await client.query(
      `insert into gift_reservations(gift_id,guest_token) values($1,$2)`,
      [ids.gift, token],
    )
    await client.query(
      `insert into audit_log(actor_id,action,entity,entity_id,diff)
       values($1,'family020.migration.seed','wedding',$2,$3::jsonb)`,
      [ids.user, ids.wedding, JSON.stringify({ marker, ids, token, code })],
    )
    await client.query('commit')
    process.stdout.write(JSON.stringify({ marker, ids, token, code }) + '\n')
  } else if (mode === 'verify') {
    const audit = await client.query(
      `select diff from audit_log where action='family020.migration.seed'
       order by id desc limit 1`,
    )
    assert(audit.rows[0], 'migration rehearsal seed marker not found')
    const seed = audit.rows[0].diff
    const partyRows = await client.query(
      `select p.id as party_id,p.invite_token,g.id,g.name,g.party_position,g.is_placeholder,
              g.plus_one,g.rsvp,g.diet,g.transfer,g.table_id,g.menu_option_id
         from guest_parties p
         join guests g on g.party_id=p.id
        where p.wedding_id=$1
        order by g.party_position`,
      [seed.ids.wedding],
    )
    assert(partyRows.rows.length === 2, `expected 2 people after plusOne migration, got ${partyRows.rows.length}`)
    const [primary, companion] = partyRows.rows
    assert(primary.party_position === 1 && companion.party_position === 2, 'family positions were not preserved')
    assert(primary.invite_token === seed.token && companion.invite_token === seed.token, 'legacy token did not become party token')
    assert(primary.plus_one === false && companion.plus_one === false, 'legacy plus_one was not cleared')
    assert(companion.is_placeholder === true, 'migrated companion must be a placeholder person')
    for (const person of partyRows.rows) {
      assert(person.rsvp === 'yes', 'RSVP semantics were not copied')
      assert(person.diet === 'vegan', 'diet semantics were not copied')
      assert(person.transfer === 'need', 'transfer semantics were not copied')
      assert(person.table_id === seed.ids.table, 'table semantics were not copied')
      assert(person.menu_option_id === seed.ids.menu, 'menu selection column was not copied')
    }

    const votes = await client.query(
      `select guest_id,option_id from menu_votes
        where guest_id = any($1::uuid[]) order by guest_id`,
      [partyRows.rows.map((row) => row.id)],
    )
    assert(votes.rows.length === 2 && votes.rows.every((row) => row.option_id === seed.ids.menu), 'menu vote was not duplicated per person')

    const bus = await client.query(
      `select b.guest_id,b.persons,r.taken
         from bus_bookings b join bus_routes r on r.id=b.bus_id
        where b.bus_id=$1 order by b.guest_id`,
      [seed.ids.bus],
    )
    assert(bus.rows.length === 2, 'legacy family bus booking did not become two person bookings')
    assert(bus.rows.every((row) => Number(row.persons) === 1), 'bus booking persons must be exactly 1 after 020')
    assert(Number(bus.rows[0].taken) === 2, 'bus taken count changed during migration')

    const hotel = await client.query(
      `select guest_id,party_id from hotel_bookings where hotel_id=$1`,
      [seed.ids.hotel],
    )
    assert(hotel.rows.length === 1 && hotel.rows[0].party_id === primary.party_id, 'hotel booking did not remain one room per family')

    const invite = await client.query(
      `select guest_id,party_id from guest_invite_codes where code=$1`,
      [seed.code],
    )
    assert(invite.rows.length === 1 && invite.rows[0].party_id === primary.party_id, 'legacy invite code was not rebound to the family')

    const reserve = await client.query(
      `select guest_token from gift_reservations where gift_id=$1`,
      [seed.ids.gift],
    )
    assert(reserve.rows.length === 1 && reserve.rows[0].guest_token === seed.token, 'gift identity changed during family migration')

    await client.query('delete from users where id=$1', [seed.ids.user])
    process.stdout.write(JSON.stringify({
      ok: true,
      people: partyRows.rows.length,
      menuVotes: votes.rows.length,
      busBookings: bus.rows.length,
      hotelBookings: hotel.rows.length,
      inviteCodes: invite.rows.length,
      giftReservations: reserve.rows.length,
    }) + '\n')
  } else {
    throw new Error('usage: family020-migration-rehearsal.mjs <seed|verify>')
  }
} finally {
  await client.end()
}
