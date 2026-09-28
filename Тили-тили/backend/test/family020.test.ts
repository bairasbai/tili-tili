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

  async function family() {
    const wedding = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/guests`,
      headers: auth(wedding.token),
      payload: { name: 'Марина', plusOne: true, phone: nextPhone() },
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

    // Compatibility flag must never re-enter capacity arithmetic after 020.
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
})
