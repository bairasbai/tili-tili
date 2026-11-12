import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'
import { cleanup } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('020: family invitations and separate people', () => {
  let app: FastifyInstance
  let counter = 0
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
    for (let i = 0; i < 20; i++) {
      const { rows } = await app.db!.query('select 1 from users where phone like $1 limit 1', [`+79${RUN}%`])
      if (rows.length === 0) break
      RUN = String(randomInt(100_000, 1_000_000))
    }
  })

  afterAll(async () => app?.close())

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const code = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, code) === rows[0]!.code_hash) return code
    }
    throw new Error('OTP not found')
  }

  async function newUser() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(verified.statusCode, verified.body).toBe(200)
    const body = verified.json() as { accessToken: string }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { id: (verified.json() as { user: { id: string } }).user.id, token: body.accessToken, phone }
  }

  async function newWedding() {
    const user = await newUser()
    const response = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(response.statusCode, response.body).toBe(201)
    return { ...user, weddingId: response.json().id as string }
  }

  async function family(existingWedding?: Awaited<ReturnType<typeof newWedding>>, name = 'Марина', plusOne = true) {
    const wedding = existingWedding ?? await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/guests`,
      headers: auth(wedding.token),
      payload: { name, plusOne, phone: nextPhone() },
    })
    expect(created.statusCode, created.body).toBe(201)
    const primaryId = created.json().id as string
    const partyId = created.json().partyId as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/guests/${primaryId}/invite-link`,
      headers: auth(wedding.token),
    })
    expect(link.statusCode, link.body).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode, exchanged.body).toBe(200)
    return { ...wedding, primaryId, partyId, guestToken: exchanged.json().guestToken as string }
  }

  it('legacy +1 becomes two real people in one invitation', async () => {
    const f = await family()
    const { rows } = await app.db!.query<{
      id: string
      party_position: number
      plus_one: boolean
      is_placeholder: boolean
    }>(
      'select id, party_position, plus_one, is_placeholder from guests where party_id = $1 order by party_position',
      [f.partyId],
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.party_position)).toEqual([1, 2])
    expect(rows.every((r) => r.plus_one === false)).toBe(true)
    expect(rows[1]!.is_placeholder).toBe(true)

    const page = await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json().partyId).toBe(f.partyId)
    expect(page.json().members).toHaveLength(2)
    expect(page.json().plusOne).toBe(true)
  })

  it('legacy guest reply revises migrated main participation without changing a second-day answer', async () => {
    const f = await family()
    const main = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [f.weddingId])).rows[0]!.id
    const second = uuidv7()
    await app.db!.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone) values($1,$2,'День 2','other','2027-06-15','Europe/Moscow')", [second, f.weddingId])
    await app.db!.query(`insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source)
      values($1,$2,$4,'attending','legacy_main_rsvp'),($1,$3,$4,'attending','team_observation')`, [f.weddingId, main, second, f.primaryId])
    const response = await app.inject({ method: 'POST', url: `/rsvp/${f.guestToken}`, payload: { status: 'no' } })
    expect(response.statusCode, response.body).toBe(200)
    const read = () => app.db!.query('select program_event_id,status,source,actor_user_id,version::text from event_guest_participation where guest_id=$1 order by program_event_id', [f.primaryId])
    const rows = (await read()).rows
    expect(rows.find(r => r.program_event_id === main)).toMatchObject({ status: 'declined', source: 'guest_response', actor_user_id: null, version: '2' })
    expect(rows.find(r => r.program_event_id === second)).toMatchObject({ status: 'attending', source: 'team_observation', version: '1' })
    expect((await app.inject({ method: 'POST', url: `/rsvp/${f.guestToken}`, payload: { status: 'no' } })).statusCode).toBe(200)
    expect((await read()).rows).toEqual(rows)
  })

  it('team RSVP records its actual author; unrelated edits do not fabricate a participation response', async () => {
    const f = await family()
    const path = `/weddings/${f.weddingId}/guests/${f.primaryId}`
    const untouched = await app.inject({ method: 'PATCH', url: path, headers: auth(f.token), payload: { name: 'Марина Новая' } })
    expect(untouched.statusCode, untouched.body).toBe(200)
    expect((await app.db!.query('select 1 from event_guest_participation where wedding_id=$1', [f.weddingId])).rowCount).toBe(0)
    const observed = await app.inject({ method: 'PATCH', url: path, headers: auth(f.token), payload: { status: 'yes' } })
    expect(observed.statusCode, observed.body).toBe(200)
    const rows = (await app.db!.query('select guest_id,status,source,actor_user_id,version::text from event_guest_participation where wedding_id=$1', [f.weddingId])).rows
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.status === 'attending' && r.source === 'team_observation' && r.actor_user_id === f.id && r.version === '1')).toBe(true)
  })

  it('family RSVP is independent per person and one no frees only that person', async () => {
    const f = await family()
    const page = (await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })).json()
    const [first, second] = page.members as { guestId: string }[]

    const response = await app.inject({
      method: 'POST',
      url: `/rsvp/${encodeURIComponent(f.guestToken)}`,
      payload: {
        members: [
          { guestId: first!.guestId, status: 'yes', diet: 'vegan', transfer: 'need' },
          { guestId: second!.guestId, status: 'no', diet: null, transfer: 'own' },
        ],
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().members).toMatchObject([
      { guestId: first!.guestId, status: 'yes', diet: 'vegan' },
      { guestId: second!.guestId, status: 'no', diet: null },
    ])
  })


  it('one family refusal frees only that bus seat and keeps the room while another member attends', async () => {
    const f = await family()
    const page = (await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })).json()
    const [first, second] = page.members as { guestId: string }[]

    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/logistics/buses`,
      headers: auth(f.token),
      payload: { name: 'Семейный автобус', seats: 2 },
    })
    expect(bus.statusCode, bus.body).toBe(201)
    const busId = bus.json().id as string

    for (const member of [first!, second!]) {
      const booked = await app.inject({
        method: 'POST',
        url: `/join/${encodeURIComponent(f.guestToken)}/shuttle`,
        payload: { busId, guestId: member.guestId },
      })
      expect(booked.statusCode, booked.body).toBe(200)
    }

    const hotel = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/logistics/hotels`,
      headers: auth(f.token),
      payload: { name: 'Семейный номер', rooms: 1 },
    })
    expect(hotel.statusCode, hotel.body).toBe(201)
    const hotelId = hotel.json().id as string
    const room = await app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/hotels`,
      payload: { hotelId },
    })
    expect(room.statusCode, room.body).toBe(200)

    const bothYes = await app.inject({
      method: 'POST',
      url: `/rsvp/${encodeURIComponent(f.guestToken)}`,
      payload: { members: [
        { guestId: first!.guestId, status: 'yes' },
        { guestId: second!.guestId, status: 'yes' },
      ] },
    })
    expect(bothYes.statusCode, bothYes.body).toBe(200)

    const oneNo = await app.inject({
      method: 'POST',
      url: `/rsvp/${encodeURIComponent(f.guestToken)}`,
      payload: { members: [{ guestId: second!.guestId, status: 'no' }] },
    })
    expect(oneNo.statusCode, oneNo.body).toBe(200)

    const { rows: busRows } = await app.db!.query<{ guest_id: string }>(
      'select guest_id from bus_bookings where bus_id = $1 order by guest_id',
      [busId],
    )
    expect(busRows.map((row) => row.guest_id)).toEqual([first!.guestId])

    const { rows: roomRows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from hotel_bookings where party_id = $1 and hotel_id = $2',
      [f.partyId, hotelId],
    )
    expect(roomRows[0]!.n).toBe('1')

    const lastNo = await app.inject({
      method: 'POST',
      url: `/rsvp/${encodeURIComponent(f.guestToken)}`,
      payload: { members: [{ guestId: first!.guestId, status: 'no' }] },
    })
    expect(lastNo.statusCode, lastNo.body).toBe(200)

    const { rows: roomAfterLastNo } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from hotel_bookings where party_id = $1 and hotel_id = $2',
      [f.partyId, hotelId],
    )
    expect(roomAfterLastNo[0]!.n).toBe('0')
  })

  it('bus and menu are per person, hotel is one room per family', async () => {
    const f = await family()
    const rsvp = (await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })).json()
    const [first, second] = rsvp.members as { guestId: string }[]

    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/logistics/buses`,
      headers: auth(f.token),
      payload: { name: 'Микроавтобус', seats: 1 },
    })
    expect(bus.statusCode, bus.body).toBe(201)
    const busId = bus.json().id as string

    const firstBus = await app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/shuttle`,
      payload: { busId, guestId: first!.guestId },
    })
    expect(firstBus.statusCode, firstBus.body).toBe(200)
    const secondBus = await app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/shuttle`,
      payload: { busId, guestId: second!.guestId },
    })
    expect(secondBus.statusCode, secondBus.body).toBe(409)
    expect(secondBus.json().error.code).toBe('bus_full')

    const optionA = uuidv7()
    const optionB = uuidv7()
    await app.db!.query(
      `insert into menu_options(id,wedding_id,name,sort) values($1,$3,'Рыба',1),($2,$3,'Овощи',2)`,
      [optionA, optionB, f.weddingId],
    )
    for (const [guestId, optionId] of [[first!.guestId, optionA], [second!.guestId, optionB]] as const) {
      const vote = await app.inject({
        method: 'POST',
        url: `/join/${encodeURIComponent(f.guestToken)}/menu-vote`,
        payload: { guestId, optionId },
      })
      expect(vote.statusCode, vote.body).toBe(200)
    }
    const menu = await app.inject({ method: 'GET', url: `/join/${encodeURIComponent(f.guestToken)}/menu-vote` })
    expect(menu.statusCode, menu.body).toBe(200)
    expect(menu.json().members).toMatchObject([
      { guestId: first!.guestId, chosenOptionId: optionA },
      { guestId: second!.guestId, chosenOptionId: optionB },
    ])

    const hotel = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/logistics/hotels`,
      headers: auth(f.token),
      payload: { name: 'Семейный отель', rooms: 1 },
    })
    expect(hotel.statusCode, hotel.body).toBe(201)
    const hotelId = hotel.json().id as string
    const firstHotel = await app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/hotels`,
      payload: { hotelId },
    })
    expect(firstHotel.statusCode, firstHotel.body).toBe(200)
    const again = await app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/hotels`,
      payload: { hotelId },
    })
    expect(again.statusCode, again.body).toBe(200)

    const { rows: hotelRows } = await app.db!.query<{ n: string; booked: number }>(
      `select count(b.*)::text as n, max(h.booked)::int as booked
         from hotel_blocks h left join hotel_bookings b on b.hotel_id = h.id
        where h.id = $1 group by h.id`,
      [hotelId],
    )
    expect(hotelRows[0]).toEqual({ n: '1', booked: 1 })
  })

  it('gift reservation belongs to the family token and reissue releases it once', async () => {
    const f = await family()
    const gift = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/wishlist`,
      headers: auth(f.token),
      payload: { name: 'Кофемашина', price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(gift.statusCode, gift.body).toBe(201)
    const giftId = gift.json().id as string

    const reserved = await app.inject({
      method: 'POST',
      url: `/gifts/${encodeURIComponent(f.guestToken)}/${giftId}/reserve`,
      headers: { 'idempotency-key': randomUUID() },
    })
    expect(reserved.statusCode, reserved.body).toBe(200)

    const { rows: identity } = await app.db!.query<{ guest_token: string; invite_token: string }>(
      `select r.guest_token, p.invite_token
         from gift_reservations r join guest_parties p on p.id = $2
        where r.gift_id = $1`,
      [giftId, f.partyId],
    )
    expect(identity[0]!.guest_token).toBe(identity[0]!.invite_token)

    const reissued = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/guests/${f.primaryId}/invite-link`,
      headers: auth(f.token),
    })
    expect(reissued.statusCode, reissued.body).toBe(200)
    const { rows: left } = await app.db!.query('select 1 from gift_reservations where gift_id = $1', [giftId])
    expect(left).toHaveLength(0)
  })

  it('family import creates explicit named people instead of a hidden plus-one', async () => {
    const w = await newWedding()
    const imported = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/import`,
      headers: auth(w.token),
      payload: {
        guests: [{
          name: 'Семья Сафины',
          members: [{ name: 'Илья Сафин' }, { name: 'Анна Сафина' }],
          phone: nextPhone(),
        }],
      },
    })
    expect(imported.statusCode, imported.body).toBe(201)
    expect(imported.json().created).toHaveLength(1)
    expect(imported.json().skipped).toEqual([])

    const partyId = imported.json().created[0].partyId as string
    const { rows } = await app.db!.query<{
      name: string
      party_position: number
      plus_one: boolean
      is_placeholder: boolean
    }>(
      `select name, party_position, plus_one, is_placeholder
         from guests where party_id = $1 order by party_position`,
      [partyId],
    )
    expect(rows).toEqual([
      { name: 'Семья Сафины', party_position: 1, plus_one: false, is_placeholder: false },
      { name: 'Илья Сафин', party_position: 2, plus_one: false, is_placeholder: false },
      { name: 'Анна Сафина', party_position: 3, plus_one: false, is_placeholder: false },
    ])
  })

  it('legacy direct INSERT is auto-wrapped into a one-person party', async () => {
    const w = await newWedding()
    const guestId = uuidv7()
    const token = `legacy020-${randomUUID()}`
    await app.db!.query(
      `insert into guests(id,wedding_id,name,plus_one,rsvp_token)
       values($1,$2,'Legacy direct',false,$3)`,
      [guestId, w.weddingId, token],
    )
    const { rows } = await app.db!.query<{ party_id: string; invite_token: string }>(
      `select g.party_id, p.invite_token
         from guests g join guest_parties p on p.id = g.party_id
        where g.id = $1`,
      [guestId],
    )
    expect(rows[0]!.party_id).toBeTruthy()
    expect(rows[0]!.invite_token).toBe(token)
  })
  it('family token cannot answer for a person from another invitation', async () => {
    const a = await family()
    const b = await family()
    const other = (await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(b.guestToken)}` })).json()
    const foreignId = other.members[0].guestId as string
    const response = await app.inject({
      method: 'POST',
      url: `/rsvp/${encodeURIComponent(a.guestToken)}`,
      payload: { members: [{ guestId: foreignId, status: 'yes' }] },
    })
    expect([401, 404]).toContain(response.statusCode)
  })

  it('removing the primary person promotes the next member without rotating the family token', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: {
        name: 'Марина',
        members: [{ name: 'Илья' }, { name: 'Анна' }],
        phone: nextPhone(),
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    const primaryId = created.json().id as string
    const partyId = created.json().partyId as string

    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${primaryId}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode, link.body).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const token = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/guests/${primaryId}`,
      headers: auth(w.token),
    })
    expect(deleted.statusCode, deleted.body).toBe(204)

    const { rows: party } = await app.db!.query<{ invite_token: string; label: string | null }>(
      'select invite_token, label from guest_parties where id = $1',
      [partyId],
    )
    expect(party[0]).toMatchObject({ invite_token: token, label: 'Илья' })

    const { rows: people } = await app.db!.query<{ name: string; party_position: number }>(
      'select name, party_position from guests where party_id = $1 order by party_position',
      [partyId],
    )
    expect(people).toEqual([
      { name: 'Илья', party_position: 1 },
      { name: 'Анна', party_position: 2 },
    ])

    const page = await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(token)}` })
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json().guestName).toBe('Илья')
    expect(page.json().members).toHaveLength(2)
  })


  async function namedSeatingFamily(capacity = 1) {
    const f = await newWedding()
    const created = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/guests`, headers: auth(f.token),
      payload: { name: 'Named Alice', members: [{ name: 'Named Bob' }] } })
    expect(created.statusCode, created.body).toBe(201)
    const people = (await app.inject({ method: 'GET', url: `/weddings/${f.weddingId}/guests`, headers: auth(f.token) })).json() as { id: string; name: string }[]
    const table = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/tables`, headers: auth(f.token), payload: { name: 'Individual seats', capacity } })
    expect(table.statusCode, table.body).toBe(201)
    return { ...f, primaryId: created.json().id as string, people, tableId: table.json().id as string }
  }

  it('seating a single named family person uses one seat and does not move the other person', async () => {
    const f = await namedSeatingFamily()
    const saved = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${f.primaryId}`, headers: auth(f.token), payload: { tableId: f.tableId } })
    expect(saved.statusCode, saved.body).toBe(200)
    const { rows } = await app.db!.query<{ id: string; table_id: string | null }>('select id,table_id from guests where wedding_id=$1', [f.weddingId])
    expect(rows.find(g => g.id === f.primaryId)?.table_id).toBe(f.tableId)
    expect(rows.find(g => g.id !== f.primaryId)?.table_id).toBeNull()
    const other = f.people.find(g => g.id !== f.primaryId)!
    const refused = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${other.id}`, headers: auth(f.token), payload: { tableId: f.tableId } })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.code).toBe('table_full')
  })

  it('a named secondary person may be assigned to its own one-seat table', async () => {
    const f = await namedSeatingFamily()
    const other = f.people.find(g => g.id !== f.primaryId)!
    const saved = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${other.id}`, headers: auth(f.token), payload: { tableId: f.tableId } })
    expect(saved.statusCode, saved.body).toBe(200)
    const { rows } = await app.db!.query<{ id: string; table_id: string | null }>('select id,table_id from guests where wedding_id=$1', [f.weddingId])
    expect(rows.find(g => g.id === other.id)?.table_id).toBe(f.tableId)
    expect(rows.find(g => g.id === f.primaryId)?.table_id).toBeNull()
  })

  it('repeating compatibility plusOne for an existing named companion is idempotent, without a hidden person or SQL error', async () => {
    const f = await namedSeatingFamily(2)
    for (const person of f.people) {
      const saved = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${person.id}`, headers: auth(f.token), payload: { tableId: f.tableId } })
      expect(saved.statusCode, saved.body).toBe(200)
    }
    const saved = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${f.primaryId}`, headers: auth(f.token), payload: { plusOne: true } })
    expect(saved.statusCode, saved.body).toBe(200)
    const { rows } = await app.db!.query<{ n: string }>('select count(*)::text as n from guests where wedding_id=$1', [f.weddingId])
    expect(rows[0]!.n).toBe('2')
  })

  it('compatibility plusOne after removing a named person retains the compacted family without an SQL error', async () => {
    const f = await namedSeatingFamily(3)
    const third = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/guests/${f.primaryId}/members`, headers: auth(f.token), payload: { name: 'Named Charlie' } })
    expect(third.statusCode, third.body).toBe(201)
    for (const id of [f.primaryId, third.json().id as string]) {
      const saved = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${id}`, headers: auth(f.token), payload: { tableId: f.tableId } })
      expect(saved.statusCode, saved.body).toBe(200)
    }
    const other = f.people.find(g => g.id !== f.primaryId)!
    const removed = await app.inject({ method: 'DELETE', url: `/weddings/${f.weddingId}/guests/${other.id}`, headers: auth(f.token) })
    expect(removed.statusCode, removed.body).toBe(204)
    const shrunk = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/tables/${f.tableId}`, headers: auth(f.token), payload: { capacity: 2 } })
    expect(shrunk.statusCode, shrunk.body).toBe(200)
    const saved = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${f.primaryId}`, headers: auth(f.token), payload: { plusOne: true } })
    expect(saved.statusCode, saved.body).toBe(200)
    const { rows } = await app.db!.query<{ n: string }>('select count(*)::text as n from guests where wedding_id=$1 and table_id=$2', [f.weddingId, f.tableId])
    expect(rows[0]!.n).toBe('2')
  })

  it('a generated legacy companion still moves with the primary and cannot fit together at a one-seat table', async () => {
    const f = await family()
    const table = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/tables`, headers: auth(f.token), payload: { name: 'One seat', capacity: 1 } })
    expect(table.statusCode, table.body).toBe(201)
    const tableId = table.json().id as string
    const refused = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${f.primaryId}`, headers: auth(f.token), payload: { tableId } })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.code).toBe('table_full')
    const { rows: members } = await app.db!.query<{ id: string; table_id: string | null }>('select id,table_id from guests where party_id=$1 and party_position=2', [f.partyId])
    expect(members[0]!.table_id).toBeNull()
    const single = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${members[0]!.id}`, headers: auth(f.token), payload: { tableId } })
    expect(single.statusCode, single.body).toBe(200)
  })

  it('legacy plusOne creation at a one-seat table is refused atomically without a new person', async () => {
    const f = await newWedding()
    const guest = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/guests`, headers: auth(f.token), payload: { name: 'Solo person' } })
    expect(guest.statusCode, guest.body).toBe(201)
    const table = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/tables`, headers: auth(f.token), payload: { name: 'One seat', capacity: 1 } })
    const id = guest.json().id as string
    const seated = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${id}`, headers: auth(f.token), payload: { tableId: table.json().id } })
    expect(seated.statusCode, seated.body).toBe(200)
    const refused = await app.inject({ method: 'PATCH', url: `/weddings/${f.weddingId}/guests/${id}`, headers: auth(f.token), payload: { plusOne: true } })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.code).toBe('table_full')
    const { rows } = await app.db!.query<{ n: string }>('select count(*)::text as n from guests where wedding_id=$1', [f.weddingId])
    expect(rows[0]!.n).toBe('1')
  })

  it('table capacity counts materialized family people once even if deprecated plus_one is stale', async () => {
    const f = await family()
    const page = (await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })).json()
    const members = page.members as { guestId: string }[]

    const table = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/tables`,
      headers: auth(f.token),
      payload: { name: 'Семейный стол', capacity: 4 },
    })
    expect(table.statusCode, table.body).toBe(201)
    const tableId = table.json().id as string

    const seated = await app.inject({
      method: 'PATCH',
      url: `/weddings/${f.weddingId}/guests/${f.primaryId}`,
      headers: auth(f.token),
      payload: { tableId },
    })
    expect(seated.statusCode, seated.body).toBe(200)

    const { rows: assigned } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from guests where party_id = $1 and table_id = $2',
      [f.partyId, tableId],
    )
    expect(assigned[0]!.n).toBe('2')

    await app.db!.query('update guests set plus_one = true where id = $1', [members[0]!.guestId])

    const shrink = await app.inject({
      method: 'PATCH',
      url: `/weddings/${f.weddingId}/tables/${tableId}`,
      headers: auth(f.token),
      payload: { capacity: 2 },
    })
    expect(shrink.statusCode, shrink.body).toBe(200)
    expect(shrink.json().capacity).toBe(2)
  })

  it('two families racing for the last hotel room create exactly one family booking', async () => {
    const a = await family()
    const hotel = await app.inject({
      method: 'POST',
      url: `/weddings/${a.weddingId}/logistics/hotels`,
      headers: auth(a.token),
      payload: { name: 'Последний номер', rooms: 1 },
    })
    expect(hotel.statusCode, hotel.body).toBe(201)
    const hotelId = hotel.json().id as string
    /* b belongs to another wedding, so create a second family in a's wedding
       through the same public guest model rather than sharing a foreign block. */
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${a.weddingId}/guests`,
      headers: auth(a.token),
      payload: { name: 'Вторая семья', plusOne: true },
    })
    const secondId = created.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${a.weddingId}/guests/${secondId}/invite-link`,
      headers: auth(a.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const secondToken = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string

    const results = await Promise.all([
      app.inject({ method: 'POST', url: `/join/${encodeURIComponent(a.guestToken)}/hotels`, payload: { hotelId } }),
      app.inject({ method: 'POST', url: `/join/${encodeURIComponent(secondToken)}/hotels`, payload: { hotelId } }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const { rows } = await app.db!.query<{ booked: number; n: string }>(
      `select h.booked, count(b.*)::text as n
         from hotel_blocks h left join hotel_bookings b on b.hotel_id = h.id
        where h.id = $1 group by h.id`,
      [hotelId],
    )
    expect(rows[0]).toEqual({ booked: 1, n: '1' })
  })

  it('FR044: event arrival is scoped and changed pickup reaches only passengers at the time', async () => {
    const f = await family(), base = `/weddings/${f.weddingId}`, headers = auth(f.token), db = app.db!
    const { rows: [, companion] } = await db.query<{ id: string }>('select id from guests where party_id=$1 order by party_position',[f.partyId])
    const teamEvents = () => app.inject({ method:'GET',url:base+'/events',headers })
    const original = await teamEvents()
    expect(original.statusCode,original.body).toBe(200)
    const main = original.json().find((event: { isMain: boolean })=>event.isMain).id as string
    const mainArrival = { entrance:'Вход во двор',parking:'Северная парковка',accessibleRoute:'Пандус справа' }
    const mainEdit = await app.inject({ method:'PATCH',url:`${base}/events/${main}`,
      headers:{...headers,'if-match':original.headers.etag},payload:{arrival:mainArrival} })
    expect(mainEdit.statusCode,mainEdit.body).toBe(200)
    expect(mainEdit.json().arrival).toEqual(mainArrival)
    const extraArrival = { entrance:'Вход с набережной',parking:null,accessibleRoute:'Лифт у стойки' }
    const additional = await app.inject({ method:'POST',url:base+'/events',
      headers:{...headers,'if-match':mainEdit.headers.etag},payload:{name:'Второй день FR044',kind:'second_day',arrival:extraArrival} })
    expect(additional.statusCode,additional.body).toBe(201)
    const extra = additional.json().id as string
    const rosterPath = `${base}/events/${extra}/invitations`
    const invite = async (guestIds: string[]) => {
      const roster = await app.inject({ method:'GET',url:rosterPath,headers })
      expect(roster.statusCode,roster.body).toBe(200)
      const saved = await app.inject({ method:'PUT',url:rosterPath,headers:{...headers,'if-match':roster.headers.etag},payload:{guestIds} })
      expect(saved.statusCode,saved.body).toBe(200)
    }
    await invite([companion!.id])
    const outsider = await app.inject({ method:'POST',url:base+'/guests',headers,payload:{name:'Другая семья FR044'} })
    expect(outsider.statusCode,outsider.body).toBe(201)
    const stranger = outsider.json().id as string, otherToken = randomUUID()
    await db.query('update guest_parties set invite_token=$2 where id=$1',[outsider.json().partyId,otherToken])
    const guest = `/join/${f.guestToken}`, other = `/join/${otherToken}`
    const rsvp = await app.inject({ method:'GET',url:`/rsvp/${f.guestToken}` })
    expect(rsvp.statusCode,rsvp.body).toBe(200)
    expect(rsvp.json().events).toMatchObject([
      {id:main,arrival:mainArrival},{id:extra,arrival:extraArrival,guestIds:[companion!.id]},
    ])
    const extraView = await app.inject({ method:'GET',url:`/rsvp/${f.guestToken}/events` })
    expect(extraView.statusCode,extraView.body).toBe(200)
    expect(extraView.json().events[0].event.arrival).toEqual(extraArrival)
    expect((await app.inject({ method:'GET',url:`/rsvp/${otherToken}` })).json().events)
      .toMatchObject([{id:main,arrival:mainArrival}])
    const mainDay = await app.inject({ method:'GET',url:guest+'/day' })
    expect(mainDay.statusCode,mainDay.body).toBe(200)
    expect(mainDay.json().arrival).toEqual(mainArrival)
    const programme = await app.inject({ method:'GET',url:`${guest}/day?eventId=${extra}&guestId=${companion!.id}` })
    expect(programme.statusCode,programme.body).toBe(200)
    expect(programme.json().arrival).toEqual(extraArrival)
    const denied = await app.inject({ method:'GET',url:`${guest}/day?eventId=${extra}&guestId=${f.primaryId}` })
    expect(denied.statusCode,denied.body).toBe(404)

    const create = async (name: string, body: object) => {
      const result = await app.inject({ method:'POST',url:base+'/logistics/buses',headers,payload:{name,seats:3,from:'Исходная точка',...body} })
      expect(result.statusCode,result.body).toBe(201)
      return result.json().id as string
    }
    const outbound = await create('FR044 туда',{eventId:extra})
    const returning = await create('FR044 обратно',{eventId:extra,direction:'return'})
    const mainTrip = await create('FR044 основной',{})
    const board = async (path: string, busId: string, guestId: string) => {
      const result = await app.inject({ method:'POST',url:path+'/shuttle',headers:{'idempotency-key':randomUUID()},payload:{busId,guestId} })
      expect(result.statusCode,result.body).toBe(200)
    }
    await board(guest,outbound,companion!.id)
    await board(guest,returning,companion!.id)
    await board(guest,mainTrip,f.primaryId)
    await board(other,mainTrip,stranger)
    const edit = (busId: string, from: string | null) =>
      app.inject({ method:'PATCH',url:base+'/logistics/buses/'+busId,headers,payload:{from} })
    const notices = async (path: string) => {
      const result = await app.inject({ method:'GET',url:path+'/shuttle?includeTrips=true' })
      expect(result.statusCode,result.body).toBe(200)
      return result.json().pickupNotices
    }
    const duplicate = await Promise.all([edit(outbound,'Новая точка'),edit(outbound,'  Новая точка  ')])
    expect(duplicate.map(result=>result.statusCode)).toEqual([200,200])
    expect(duplicate.map(result=>result.json().pickupNotified).filter(count=>count !== undefined)).toEqual([1])
    expect(await notices(guest)).toMatchObject([{guestId:companion!.id,busId:outbound,routeLabel:'FR044 туда',
      eventLabel:'Второй день FR044',previousPickup:'Исходная точка',pickup:'Новая точка'}])
    expect(await notices(other)).toEqual([])
    expect((await app.inject({method:'GET',url:'/join/unknown/shuttle?includeTrips=true'})).statusCode).toBe(401)

    await invite([companion!.id,stranger])
    await board(other,outbound,stranger)
    expect(await notices(other)).toEqual([])
    const clear = await edit(outbound,null)
    expect(clear.statusCode,clear.body).toBe(200)
    expect(clear.json().pickupNotified).toBe(2)
    expect(await notices(guest)).toMatchObject([{guestId:companion!.id,busId:outbound,pickup:null},{guestId:companion!.id,busId:outbound,pickup:'Новая точка'}])
    expect(await notices(other)).toMatchObject([{guestId:stranger,busId:outbound,pickup:null}])
    await invite([stranger])
    expect(await notices(guest)).toEqual([])
    expect(await notices(other)).toHaveLength(1)
  })

  it('SC-009: both families keep the right trips across a late move, refusal and last-seat race', async () => {
    const f = await family(), base = `/weddings/${f.weddingId}`, headers = auth(f.token)
    const db = app.db!, root = base + '/logistics'
    const create = async (name: string, fields: object = {}) => {
      const result = await app.inject({ method: 'POST', url: root + '/buses', headers, payload: { name, seats: 1, ...fields } })
      expect(result.statusCode, result.body).toBe(201)
      return result.json().id as string
    }
    const patch = async (bus: string, payload: object) => {
      const result = await app.inject({ method: 'PATCH', url: root + '/buses/' + bus, headers, payload })
      expect(result.statusCode, result.body).toBe(200)
      return result.json()
    }
    const first = await create('До переноса', { replacement: { contact: 'Диспетчер FR042', instructions: 'Встреча у входа\nВозьмите билет' } })
    const target = await create('После переноса')
    const alternate = await create('Другой рейс')
    const returned = await create('Обратно FR042', { direction: 'return' })
    const second = await family(f, 'Другая семья SC-009', false)
    const outsider = second.primaryId
    const events = await app.inject({ method: 'GET', url: base + '/events', headers })
    expect(events.statusCode, events.body).toBe(200)
    const arrival = { entrance: 'Северный вход SC-009', parking: null, accessibleRoute: 'Пандус SC-009' }
    const added = await app.inject({ method: 'POST', url: base + '/events', headers: { ...headers, 'if-match': events.headers.etag },
      payload: { name: 'Дополнительное мероприятие SC-009', kind: 'second_day', arrival } })
    expect(added.statusCode, added.body).toBe(201)
    const eventId = added.json().id as string
    const roster = `${base}/events/${eventId}/invitations`
    const rosterBefore = await app.inject({ method: 'GET', url: roster, headers })
    expect(rosterBefore.statusCode, rosterBefore.body).toBe(200)
    const invited = await app.inject({ method: 'PUT', url: roster, headers: { ...headers, 'if-match': rosterBefore.headers.etag },
      payload: { guestIds: [f.primaryId] } })
    expect(invited.statusCode, invited.body).toBe(200)
    const extra = await create('Отдельный рейс SC-009', { eventId })
    const guest = `/join/${encodeURIComponent(f.guestToken)}/shuttle`
    const other = `/join/${encodeURIComponent(second.guestToken)}/shuttle`
    const board = (path: string, busId: string, guestId: string) =>
      app.inject({ method: 'POST', url: path, headers: { 'idempotency-key': randomUUID() }, payload: { busId, guestId } })
    const leave = (path: string, busId: string, guestId: string) =>
      app.inject({ method: 'DELETE', url: `${path}/seats/${busId}/${guestId}` })
    const ask = (requestId: string, fromBusId: string, toBusId: string, guestId = f.primaryId) =>
      app.inject({ method: 'PUT', url: `${guest}/requests/${requestId}`, payload: { guestId, fromBusId, toBusId } })
    const review = (id: string, decision: 'approved' | 'declined', by: Record<string, string> = headers) =>
      app.inject({ method: 'PUT', url: root + '/shuttle-requests/' + id, headers: by, payload: { decision } })
    const read = async (path = guest) => {
      const result = await app.inject({ method: 'GET', url: path + '?includeTrips=true' })
      expect(result.statusCode, result.body).toBe(200)
      return result.json()
    }
    const seats = async (guestId = f.primaryId) => (await db.query<{ bus_id: string }>(
      'select bus_id from bus_bookings where guest_id=$1 order by bus_id', [guestId])).rows.map(row => row.bus_id)
    expect((await read()).routes.find((route: { id: string }) => route.id === first).replacement).toBeNull()
    expect((await board(other,extra,outsider)).statusCode).toBe(404)
    expect((await board(other,first,f.primaryId)).statusCode).toBe(404)
    expect((await board(guest,randomUUID(),f.primaryId)).statusCode).toBe(404)
    for (const [path,bus,person] of [[guest,first,f.primaryId],[guest,returned,f.primaryId],[guest,extra,f.primaryId],[other,target,outsider]] as const) {
      const result = await board(path,bus,person)
      expect(result.statusCode,result.body).toBe(200)
    }
    expect((await read()).routes.find((route: { id: string }) => route.id === first).replacement)
      .toEqual({ contact: 'Диспетчер FR042', instructions: 'Встреча у входа\nВозьмите билет' })
    expect((await read(other)).routes.find((route: { id: string }) => route.id === first).replacement).toBeNull()
    expect((await ask(randomUUID(),first,alternate)).json().error.code).toBe('shuttle_deadline_open')
    await patch(first,{ deadlineOn: '2000-01-01' })
    expect((await board(guest,first,f.primaryId)).json().alreadyBooked).toBe(true)
    expect((await board(guest,alternate,f.primaryId)).json().error.code).toBe('shuttle_deadline_passed')
    expect((await leave(other,first,f.primaryId)).statusCode).toBe(404)
    expect((await ask(randomUUID(),first,target,outsider)).statusCode).toBe(404)
    expect((await ask(randomUUID(),first,returned)).statusCode).toBe(409)
    const id = randomUUID()
    const pending = await ask(id,first,target)
    expect(pending.statusCode,pending.body).toBe(200)
    expect(pending.json()).toMatchObject({ id, status: 'pending', fromBusId: first, toBusId: target, resolvedAt: null })
    expect((await ask(id,first,target)).json()).toEqual(pending.json())
    expect((await ask(randomUUID(),first,alternate)).statusCode).toBe(409)
    expect((await read(other)).requests).toEqual([])
    const denied = await review(id,'approved',{})
    expect(denied.statusCode).toBe(401)
    const full = await review(id,'approved')
    expect(full.statusCode,full.body).toBe(409)
    expect(full.json().error.code).toBe('bus_full')
    expect(await seats()).toEqual([first,returned,extra].sort())
    expect((await read()).requests[0].status).toBe('pending')
    expect((await leave(other,target,outsider)).statusCode).toBe(204)
    const approved = await review(id,'approved')
    expect(approved.statusCode,approved.body).toBe(200)
    expect(approved.json().status).toBe('approved')
    expect((await review(id,'approved')).json()).toEqual(approved.json())
    expect((await review(id,'declined')).statusCode).toBe(409)
    expect(await seats()).toEqual([target,returned,extra].sort())

    await patch(target,{ deadlineOn: '2000-01-01' })
    const request = randomUUID()
    expect((await ask(request,target,alternate)).statusCode).toBe(200)
    expect((await leave(guest,target,f.primaryId)).statusCode).toBe(204)
    expect((await leave(guest,target,f.primaryId)).statusCode).toBe(204)
    expect(await seats()).toEqual([returned,extra].sort())
    expect((await read()).requests[0]).toMatchObject({ id: request, status: 'withdrawn' })
    expect((await review(request,'approved')).statusCode).toBe(409)
    await patch(target,{ deadlineOn: null })
    const race = await Promise.all([board(guest,target,f.primaryId),board(other,target,outsider)])
    expect(race.map(result => result.statusCode).sort()).toEqual([200,409])
    const count = await db.query<{ taken: number }>('select taken from bus_routes where id=$1',[target])
    expect(count.rows[0]!.taken).toBe(1)
    const bookedIds = await seats()
    expect(bookedIds).toEqual([returned, extra, ...(race[0]!.statusCode === 200 ? [target] : [])].sort())
    const picked = await patch(extra, { from: 'Новая точка SC-009' })
    expect(picked).toMatchObject({ pickupNotified: 1 })
    expect((await read()).pickupNotices).toEqual(expect.arrayContaining([
      expect.objectContaining({ busId: extra, guestId: f.primaryId, pickup: 'Новая точка SC-009' }),
    ]))
    const outside = await read(other)
    expect(outside.routes.map((route: { id: string }) => route.id)).not.toContain(extra)
    expect(outside.pickupNotices).toEqual([])
    expect(outside.members.map((member: { guestId: string }) => member.guestId)).toEqual([outsider])
    const familyInvite = await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })
    expect(familyInvite.statusCode, familyInvite.body).toBe(200)
    expect(familyInvite.json().events).toEqual(expect.arrayContaining([expect.objectContaining({ id: eventId, arrival })]))
    const otherInvite = await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(second.guestToken)}` })
    expect(otherInvite.statusCode, otherInvite.body).toBe(200)
    expect(otherInvite.json().events.map((event: { id: string }) => event.id)).not.toContain(eventId)
  })

  it('FR042: revoking an additional invitation withdraws that trip and keeps a main seat', async () => {
    const f = await family(), base = `/weddings/${f.weddingId}`, headers = auth(f.token), event = randomUUID()
    const db = app.db!
    await db.query("insert into wedding_events(id,wedding_id,name,kind) values($1,$2,'FR042 extra','other')",[event,f.weddingId])
    await db.query('insert into guest_event_invitations(wedding_id,event_id,guest_id) values($1,$2,$3)',[f.weddingId,event,f.primaryId])
    const add = async (name: string, eventId?: string) => {
      const response = await app.inject({ method: 'POST', url: base + '/logistics/buses', headers, payload: { name,seats: 1,eventId } })
      expect(response.statusCode,response.body).toBe(201)
      return response.json().id as string
    }
    const main = await add('Main'), from = await add('Extra from',event), to = await add('Extra to',event)
    const shuttle = `/join/${f.guestToken}/shuttle`
    for (const busId of [main,from]) {
      const response = await app.inject({ method: 'POST', url: shuttle, headers: { 'idempotency-key': randomUUID() }, payload: { busId,guestId:f.primaryId } })
      expect(response.statusCode,response.body).toBe(200)
    }
    const patch = await app.inject({ method: 'PATCH', url: base + '/logistics/buses/' + from, headers, payload: { deadlineOn:'2000-01-01' } })
    expect(patch.statusCode,patch.body).toBe(200)
    const id = randomUUID()
    const pending = await app.inject({ method: 'PUT', url: shuttle + '/requests/' + id, payload: { guestId:f.primaryId,fromBusId:from,toBusId:to } })
    expect(pending.statusCode,pending.body).toBe(200)
    const rosterPath = base + '/events/' + event + '/invitations'
    const roster = await app.inject({ method: 'GET', url: rosterPath, headers })
    expect(roster.statusCode,roster.body).toBe(200)
    const revoked = await app.inject({ method: 'PUT', url: rosterPath, headers: { ...headers,'if-match':roster.headers.etag }, payload: { guestIds:[] } })
    expect(revoked.statusCode,revoked.body).toBe(200)
    const seats = await db.query('select bus_id from bus_bookings where guest_id=$1',[f.primaryId])
    expect(seats.rows).toEqual([{ bus_id: main }])
    const own = await app.inject({ method: 'GET', url: shuttle + '?includeTrips=true' })
    expect(own.json().requests).toEqual([])
    const team = await app.inject({ method: 'GET', url: base + '/logistics/shuttle-requests', headers })
    expect(team.statusCode,team.body).toBe(200)
    expect(team.json().requests[0]).toMatchObject({ id,status:'withdrawn' })
  })

  it('FR041: per-person trips keep return and additional-event seats, including failed moves', async () => {
    const f = await family(), base = `/weddings/${f.weddingId}`, headers = auth(f.token)
    const db = app.db!
    const { rows: [, companion] } = await db.query<{ id: string }>(
      'select id from guests where party_id=$1 order by party_position', [f.partyId],
    )
    const eventId = randomUUID()
    await db.query("insert into wedding_events(id,wedding_id,name,kind,date) values($1,$2,'Второй день','second_day','2027-06-15')", [eventId, f.weddingId])
    await db.query('insert into guest_event_invitations(wedding_id,event_id,guest_id) values($1,$2,$3)', [f.weddingId, eventId, companion!.id])
    const another = await app.inject({ method: 'POST', url: base + '/guests', headers, payload: { name: 'Другая семья' } })
    expect(another.statusCode, another.body).toBe(201)
    const stranger = another.json().id as string
    const otherToken = randomUUID()
    await db.query('update guest_parties set invite_token=$2 where id=$1', [another.json().partyId, otherToken])
    const route = async (name: string, fields: object = {}) => {
      const result = await app.inject({ method: 'POST', url: base + '/logistics/buses', headers, payload: { name, seats: 2, ...fields } })
      expect(result.statusCode, result.body).toBe(201)
      return result.json().id as string
    }
    const shuttle = `/join/${encodeURIComponent(f.guestToken)}/shuttle`
    const board = (busId: string, guestId?: string, path = shuttle) => app.inject({
      method: 'POST', url: path, headers: { 'idempotency-key': randomUUID() }, payload: { busId, guestId },
    })
    const original = await route('Вперёд А'), onward = await route('Вперёд Б', { seats: 1 })
    const back = await route('Назад', { direction: 'return', departureDate: '2027-06-14', from: 'Зал', time: '21:45',
      destination: 'Вокзал', stops: ['Парк', 'Мост'], publicContact: 'Диспетчер рейса' })
    const otherEvent = await route('Дополнительный рейс', { eventId })
    expect((await board(original)).statusCode).toBe(200)
    expect((await board(back)).statusCode).toBe(404)
    expect((await board(back, f.primaryId)).statusCode).toBe(200)
    expect((await board(otherEvent, f.primaryId)).statusCode).toBe(404)
    expect((await board(otherEvent, stranger)).statusCode).toBe(404)
    expect((await board(otherEvent, companion!.id)).statusCode).toBe(200)
    expect((await board(back, f.primaryId)).json()).toMatchObject({ alreadyBooked: true, taken: 1 })
    const race = await Promise.all([board(onward, f.primaryId), board(onward, stranger, `/join/${otherToken}/shuttle`)])
    expect(race.map(result => result.statusCode).sort()).toEqual([200, 409])
    expect(race.find(result => result.statusCode === 409)!.json().error.code).toBe('bus_full')
    const primaryBus = race[0]!.statusCode === 200 ? onward : original
    const legacy = await app.inject({ method: 'GET', url: shuttle })
    expect(legacy.statusCode, legacy.body).toBe(200)
    expect(legacy.json().myBusId).toBe(primaryBus)
    expect(legacy.json().routes.map((bus: { id: string }) => bus.id).sort()).toEqual([original, onward].sort())

    const familyRead = await app.inject({ method: 'GET', url: shuttle + '?includeTrips=true' })
    expect(familyRead.statusCode, familyRead.body).toBe(200)
    const familyBody = familyRead.json()
    expect(familyBody.members[0]).toMatchObject({ guestId: f.primaryId, busIds: [primaryBus, back].sort() })
    expect(familyBody.members[0].eligibleBusIds).not.toContain(otherEvent)
    expect(familyBody.members[1]).toMatchObject({ guestId: companion!.id, busIds: [original, otherEvent].sort() })
    expect(familyBody.routes.find((bus: { id: string }) => bus.id === back)).toMatchObject({
      direction: 'return', departureDate: '2027-06-14', from: 'Зал', time: '21:45',
      destination: 'Вокзал', stops: ['Парк', 'Мост'], publicContact: 'Диспетчер рейса', taken: 1,
    })
    expect(familyBody.routes.every((bus: object) => !('passengers' in bus))).toBe(true)
    const outside = await app.inject({ method: 'GET', url: `/join/${otherToken}/shuttle?includeTrips=true` })
    expect(outside.statusCode, outside.body).toBe(200)
    expect(outside.json().routes.map((bus: { id: string }) => bus.id)).not.toContain(otherEvent)
    const team = await app.inject({ method: 'GET', url: base + '/logistics/buses', headers })
    expect(team.statusCode, team.body).toBe(200)
    expect(team.json().find((bus: { id: string }) => bus.id === back).passengers)
      .toMatchObject([{ guestId: f.primaryId, name: 'Марина' }])

    const notice = await app.inject({ method: 'POST', url: base + '/logistics/notify-pickup',
      headers: { ...headers, 'idempotency-key': randomUUID() }, payload: {} })
    expect(notice.statusCode, notice.body).toBe(202)
    expect(notice.json().recipients).toBe(2 + Number(race[1]!.statusCode === 200))

    const changeScope = await app.inject({ method: 'PATCH', url: base + '/logistics/buses/' + back, headers, payload: { eventId } })
    expect(changeScope.statusCode, changeScope.body).toBe(409)
    expect(changeScope.json().error.code).toBe('bus_scope_in_use')
    const foreign = await app.inject({ method: 'PATCH', url: base + '/logistics/buses/' + back, headers, payload: { eventId: randomUUID() } })
    expect(foreign.statusCode, foreign.body).toBe(422)
    const badDate = await app.inject({ method: 'PATCH', url: base + '/logistics/buses/' + back, headers, payload: { departureDate: '2027-02-30' } })
    expect(badDate.statusCode, badDate.body).toBe(422)
    const decline = await app.inject({ method: 'POST', url: `/rsvp/${encodeURIComponent(f.guestToken)}`, payload: {
      members: [{ guestId: companion!.id, status: 'no' }],
    } })
    expect(decline.statusCode, decline.body).toBe(200)
    const assigned = await db.query<{ bus_id: string }>('select bus_id from bus_bookings where guest_id=$1', [companion!.id])
    expect(assigned.rows).toEqual([{ bus_id: otherEvent }])
  })

  it('two family members racing for the last bus seat book exactly one person', async () => {
    const f = await family()
    const page = (await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })).json()
    const members = page.members as { guestId: string }[]
    expect(members).toHaveLength(2)

    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${f.weddingId}/logistics/buses`,
      headers: auth(f.token),
      payload: { name: 'Последнее семейное место', seats: 1 },
    })
    expect(bus.statusCode, bus.body).toBe(201)
    const busId = bus.json().id as string

    const results = await Promise.all(members.map((member) => app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/shuttle`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { busId, guestId: member.guestId },
    })))
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(results.find((response) => response.statusCode === 409)!.json().error.code).toBe('bus_full')

    const { rows } = await app.db!.query<{ taken: number; n: string }>(
      `select r.taken, count(b.*)::text as n
         from bus_routes r left join bus_bookings b on b.bus_id = r.id
        where r.id = $1 group by r.id`,
      [busId],
    )
    expect(rows[0]).toEqual({ taken: 1, n: '1' })
  })

  it('two tabs moving one family hotel serialize to one final room', async () => {
    const f = await family()
    const hotelIds: string[] = []
    for (const name of ['Исходный номер', 'Вариант Б', 'Вариант В']) {
      const hotel = await app.inject({
        method: 'POST',
        url: `/weddings/${f.weddingId}/logistics/hotels`,
        headers: auth(f.token),
        payload: { name, rooms: 1 },
      })
      expect(hotel.statusCode, hotel.body).toBe(201)
      hotelIds.push(hotel.json().id as string)
    }

    const initial = await app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/hotels`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { hotelId: hotelIds[0] },
    })
    expect(initial.statusCode, initial.body).toBe(200)

    const moves = await Promise.all(hotelIds.slice(1).map((hotelId) => app.inject({
      method: 'POST',
      url: `/join/${encodeURIComponent(f.guestToken)}/hotels`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { hotelId },
    })))
    expect(moves.map((response) => response.statusCode)).toEqual([200, 200])

    const { rows: bookings } = await app.db!.query<{ hotel_id: string }>(
      'select hotel_id from hotel_bookings where party_id = $1',
      [f.partyId],
    )
    expect(bookings).toHaveLength(1)
    expect(hotelIds.slice(1)).toContain(bookings[0]!.hotel_id)

    const { rows: counters } = await app.db!.query<{ booked: string }>(
      'select sum(booked)::text as booked from hotel_blocks where id = any($1::uuid[])',
      [hotelIds],
    )
    expect(counters[0]!.booked).toBe('1')
  })

  it('parallel family gift reservations cannot exceed the shared invitation quota', async () => {
    const f = await family()
    const max = app.appConfig.reservationsMaxPerGuest
    expect(max).toBeGreaterThan(0)
    const giftIds: string[] = []

    for (let i = 0; i < max + 1; i++) {
      const gift = await app.inject({
        method: 'POST',
        url: `/weddings/${f.weddingId}/wishlist`,
        headers: auth(f.token),
        payload: { name: `Семейный подарок ${i + 1}`, price: { amount: 100_000 + i, currency: 'RUB' } },
      })
      expect(gift.statusCode, gift.body).toBe(201)
      giftIds.push(gift.json().id as string)
    }

    for (const giftId of giftIds.slice(0, Math.max(0, max - 1))) {
      const reserved = await app.inject({
        method: 'POST',
        url: `/gifts/${encodeURIComponent(f.guestToken)}/${giftId}/reserve`,
        headers: { 'idempotency-key': randomUUID() },
      })
      expect(reserved.statusCode, reserved.body).toBe(200)
    }

    const edge = await Promise.all(giftIds.slice(max - 1, max + 1).map((giftId) => app.inject({
      method: 'POST',
      url: `/gifts/${encodeURIComponent(f.guestToken)}/${giftId}/reserve`,
      headers: { 'idempotency-key': randomUUID() },
    })))
    expect(edge.map((response) => response.statusCode).sort()).toEqual([200, 429])
    expect(edge.find((response) => response.statusCode === 429)!.json().error.code).toBe('reservation_limit')

    const { rows } = await app.db!.query<{ n: string }>(
      `select count(*)::text as n
         from gift_reservations r join gifts g on g.id = r.gift_id
        where g.wedding_id = $1 and r.guest_token = $2`,
      [f.weddingId, f.guestToken],
    )
    expect(Number(rows[0]!.n)).toBe(max)
  })

  it('export keeps family structure but never exposes the shared invite token', async () => {
    const f = await family()
    const dump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(f.token) })
    expect(dump.statusCode, dump.body).toBe(200)
    const body = dump.json() as { guests: { party_id: string; party_position: number; is_placeholder: boolean }[] }
    const familyGuests = body.guests.filter((g) => g.party_id === f.partyId)
    expect(familyGuests.map((g) => g.party_position).sort()).toEqual([1, 2])
    expect(dump.body).not.toContain(f.guestToken)
  })

  it('31-day account cleanup cascades family people, party token and family-owned rows', async () => {
    const f = await family()
    const deleted = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(f.token) })
    expect(deleted.statusCode, deleted.body).toBe(204)
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [f.id])
    await cleanup(app)
    const { rows: parties } = await app.db!.query('select 1 from guest_parties where id = $1', [f.partyId])
    const { rows: people } = await app.db!.query('select 1 from guests where party_id = $1', [f.partyId])
    expect(parties).toEqual([])
    expect(people).toEqual([])
    expect((await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })).statusCode).toBe(401)
  })

  async function lodgingHotel(f: Awaited<ReturnType<typeof newWedding>>, name: string, rooms: number) {
    const response = await app.inject({ method: 'POST', url: `/weddings/${f.weddingId}/logistics/hotels`,
      headers: auth(f.token), payload: { name, rooms } })
    expect(response.statusCode, response.body).toBe(201)
    return response.json().id as string
  }

  it('FR-043 links a legacy family request once and exposes only that family’s lodging', async () => {
    const f = await family()
    const other = await family(f, 'Анна', false)
    const foreign = await newWedding()
    const hotelId = await lodgingHotel(f, 'Казань', 1)
    const alternateHotelId = await lodgingHotel(f, 'Волга', 2)
    const base = `/weddings/${f.weddingId}/logistics`
    const guestHotels = `/join/${encodeURIComponent(f.guestToken)}/hotels`
    const otherHotels = `/join/${encodeURIComponent(other.guestToken)}/hotels`
    const headers = auth(f.token)
    const created = await app.inject({ method: 'POST', url: guestHotels, payload: { hotelId } })
    expect(created.statusCode, created.body).toBe(200)
    const roomId = randomUUID()
    const roomUrl = `${base}/lodging/rooms/${roomId}`
    const room = { version: 0, hotelId, label: '212', capacity: 2 }
    const over = await app.inject({ method: 'PUT', url: roomUrl, headers, payload: room })
    expect(over.statusCode, over.body).toBe(409)
    expect(over.json().error.code).toBe('hotel_full')
    const linked = await app.inject({ method: 'PUT', url: roomUrl, headers, payload: { ...room, legacyPartyId: f.partyId } })
    expect(linked.statusCode, linked.body).toBe(200)
    const duplicate = await app.inject({ method: 'PUT', url: `${base}/lodging/rooms/${randomUUID()}`, headers,
      payload: { ...room, label: '213', legacyPartyId: f.partyId } })
    expect(duplicate.statusCode, duplicate.body).toBe(409)
    expect(duplicate.json().error.code).toBe('lodging_request_linked')

    const placement = { version: 0, roomId, guestId: f.primaryId, checkIn: '2027-06-12', checkOut: '2027-06-15',
      responsibleId: f.id, source: 'hotel' }
    const placementUrl = `${base}/lodging/placements/${randomUUID()}`
    const wrongFamily = await app.inject({ method: 'PUT', url: placementUrl, headers, payload: { ...placement, guestId: other.primaryId } })
    expect(wrongFamily.statusCode, wrongFamily.body).toBe(409)
    expect(wrongFamily.json().error.code).toBe('lodging_room_family')
    const wrongMember = await app.inject({ method: 'PUT', url: placementUrl, headers, payload: { ...placement, responsibleId: foreign.id } })
    expect(wrongMember.statusCode, wrongMember.body).toBe(422)
    const saved = await app.inject({ method: 'PUT', url: placementUrl, headers, payload: placement })
    expect(saved.statusCode, saved.body).toBe(200)
    const companion = await app.db!.query<{ id: string }>('select id from guests where party_id=$1 and id<>$2', [f.partyId, f.primaryId])
    expect(companion.rows).toHaveLength(1)
    const shared = await app.inject({ method: 'PUT', url: `${base}/lodging/placements/${randomUUID()}`, headers,
      payload: { ...placement, guestId: companion.rows[0]!.id } })
    expect(shared.statusCode, shared.body).toBe(200)

    const rsvp = await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(f.guestToken)}` })
    expect(rsvp.statusCode, rsvp.body).toBe(200)
    expect(rsvp.json().hasLodging).toBe(true)
    const otherRsvp = await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(other.guestToken)}` })
    expect(otherRsvp.statusCode, otherRsvp.body).toBe(200)
    expect(otherRsvp.json().hasLodging).toBeUndefined()

    const mine = await app.inject({ method: 'GET', url: guestHotels })
    expect(mine.statusCode, mine.body).toBe(200)
    expect(mine.json()).toContainEqual(expect.objectContaining({ id: hotelId, booked: 1, mine: true,
      placements: expect.arrayContaining([expect.objectContaining({ roomLabel: '212', guestName: 'Марина', checkIn: '2027-06-12',
        checkOut: '2027-06-15', source: 'hotel', current: true })]) }))
    expect(mine.json().find((h: { id: string }) => h.id === hotelId).placements).toHaveLength(2)
    const theirs = await app.inject({ method: 'GET', url: otherHotels })
    expect(theirs.statusCode, theirs.body).toBe(200)
    expect(theirs.json().find((h: { id: string }) => h.id === hotelId)).toMatchObject({ booked: 1, mine: false })
    expect(theirs.body).not.toContain('placements')
    expect(theirs.body).not.toContain('Марина')

    const keep = await app.inject({ method: 'POST', url: guestHotels, payload: { hotelId } })
    expect(keep.statusCode, keep.body).toBe(200)
    expect(keep.json()).toMatchObject({ alreadyBooked: true, booked: 1 })
    const move = await app.inject({ method: 'POST', url: guestHotels, payload: { hotelId: alternateHotelId } })
    expect(move.statusCode, move.body).toBe(409)
    expect(move.json().error.code).toBe('lodging_managed')
    const full = await app.inject({ method: 'POST', url: otherHotels, payload: { hotelId } })
    expect(full.statusCode, full.body).toBe(409)
    expect(full.json().error.code).toBe('hotel_full')

    const team = await app.inject({ method: 'GET', url: `${base}/lodging`, headers })
    expect(team.statusCode, team.body).toBe(200)
    expect(team.json()).toMatchObject({ requests: [], rooms: [{ id: roomId, legacyPartyId: f.partyId }],
      placements: expect.arrayContaining([expect.objectContaining({ guestId: f.primaryId, responsibleId: f.id, source: 'hotel' })]) })
    const outsider = await app.inject({ method: 'GET', url: `${base}/lodging`, headers: auth(foreign.token) })
    expect(outsider.statusCode, outsider.body).toBe(404)
    const deletedHotel = await app.inject({ method: 'DELETE', url: `${base}/hotels/${hotelId}`, headers })
    expect(deletedHotel.statusCode, deletedHotel.body).toBe(409)
    expect(deletedHotel.json().error.code).toBe('lodging_hotel_in_use')
  })

  it('FR-043 serializes the last bed, rejects overlapping stays and allows an adjacent arrival', async () => {
    const f = await family()
    const other = await family(f, 'Анна', false)
    const hotelId = await lodgingHotel(f, 'Тестовый отель', 3)
    const base = `/weddings/${f.weddingId}/logistics/lodging`
    const headers = auth(f.token)
    const roomId = randomUUID()
    const secondRoomId = randomUUID()
    const roomDraft = { version: 0, hotelId, capacity: 1 }
    for (const [id, label] of [[roomId, '301'], [secondRoomId, '302']]) {
      const created = await app.inject({ method: 'PUT', url: `${base}/rooms/${id}`, headers, payload: { ...roomDraft, label } })
      expect(created.statusCode, created.body).toBe(200)
    }
    const period = { roomId, checkIn: '2027-06-12', checkOut: '2027-06-14', responsibleId: null, source: 'organizer' }
    const firstId = randomUUID()
    const secondId = randomUUID()
    const save = (id: string, payload: object) => app.inject({ method: 'PUT', url: `${base}/placements/${id}`, headers, payload })
    const choices = [{ id: firstId, guestId: f.primaryId }, { id: secondId, guestId: other.primaryId }]
    const race = await Promise.all(choices.map(p => save(p.id, { ...period, version: 0, guestId: p.guestId })))
    expect(race.map(r => r.statusCode).sort()).toEqual([200, 409])
    expect(race.find(r => r.statusCode === 409)!.json().error.code).toBe('lodging_room_full')
    const winner = choices[race.findIndex(r => r.statusCode === 200)]!
    const loser = choices[race.findIndex(r => r.statusCode === 409)]!

    const overlap = await save(randomUUID(), { ...period, roomId: secondRoomId, version: 0, guestId: winner.guestId })
    expect(overlap.statusCode, overlap.body).toBe(409)
    expect(overlap.json().error.code).toBe('lodging_guest_overlap')
    const adjacent = await save(loser.id, { ...period, version: 0, guestId: loser.guestId, checkIn: '2027-06-14', checkOut: '2027-06-16' })
    expect(adjacent.statusCode, adjacent.body).toBe(200)
    const invalid = await save(randomUUID(), { ...period, version: 0, guestId: loser.guestId, checkIn: '2027-02-30' })
    expect(invalid.statusCode, invalid.body).toBe(422)
    const inUse = await app.inject({ method: 'DELETE', url: `${base}/rooms/${roomId}?version=1`, headers })
    expect(inUse.statusCode, inUse.body).toBe(409)
    expect(inUse.json().error.code).toBe('lodging_room_in_use')

    const moved = await save(winner.id, { ...period, version: 1, roomId: secondRoomId, guestId: winner.guestId, source: 'guest' })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json().version).toBe(2)
    const stale = await save(winner.id, { ...period, version: 1, guestId: winner.guestId })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('lodging_stale')
    const deleted = await app.inject({ method: 'DELETE', url: `${base}/placements/${loser.id}?version=1`, headers })
    expect(deleted.statusCode, deleted.body).toBe(204)
    const reused = await save(randomUUID(), { ...period, version: 0, guestId: loser.guestId })
    expect(reused.statusCode, reused.body).toBe(200)
  })

  it('FR-043 uses the same last physical room for a family request and the team plan', async () => {
    const f = await family()
    const hotelId = await lodgingHotel(f, 'Один номер', 1)
    const headers = auth(f.token)
    const [plan, familyRequest] = await Promise.all([
      app.inject({ method: 'PUT', url: `/weddings/${f.weddingId}/logistics/lodging/rooms/${randomUUID()}`, headers,
        payload: { version: 0, hotelId, label: '101', capacity: 1 } }),
      app.inject({ method: 'POST', url: `/join/${encodeURIComponent(f.guestToken)}/hotels`, payload: { hotelId } }),
    ])
    expect([plan.statusCode, familyRequest.statusCode].sort()).toEqual([200, 409])
    expect((plan.statusCode === 409 ? plan : familyRequest).json().error.code).toBe('hotel_full')
    const { rows } = await app.db!.query('select lodging_inventory_used($1) as used', [hotelId])
    expect(rows[0]).toEqual({ used: 1 })
  })
})
