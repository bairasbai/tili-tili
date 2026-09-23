import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Вторая перепроверка этапа 5: проход по составу этапа построчно.
 * «Атомарные места в автобусе И НОМЕРЕ», «счётчики персон» — то, что было
 * в описании этапа, но не попало ни в один критерий «Готово, когда».
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('перепроверка этапа 5, второй проход', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259): в общей
   * дев-базе сотня тысяч номеров `+79RRRRRRNNN` от прежних
   * прогонов, и случайный RUN иногда совпадает с занятым — тогда на
   * свежем номере прилетает 409 «wedding_exists». */
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

  afterAll(async () => {
    await app?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const key = () => ({ 'idempotency-key': randomUUID() })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  async function newWedding() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    return { token, weddingId: w.json().id as string }
  }

  async function newGuest(w: { token: string; weddingId: string }, name = 'Ольга', plusOne = false) {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name, plusOne },
    })
    const guestId = created.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    return { guestId, token: exchanged.json().guestToken as string, code }
  }

  const bookSeat = (guestToken: string, busId: string) =>
    app.inject({ method: 'POST', url: `/join/${guestToken}/shuttle`, headers: key(), payload: { busId } })

  /* ── места в номере: их вообще нельзя было занять ─────────────────── */
  it('гость записывается в отельный блок, и места кончаются', async () => {
    const w = await newWedding()
    const hotel = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/hotels`,
      headers: auth(w.token),
      payload: { name: 'Отель «Ривьера»', rooms: 2 },
    })
    expect(hotel.statusCode).toBe(201)
    const hotelId = hotel.json().id as string

    const guests = []
    for (let i = 0; i < 3; i++) guests.push(await newGuest(w, `Гость ${i}`))

    const results = await Promise.all(
      guests.map((g) =>
        app.inject({ method: 'POST', url: `/join/${g.token}/hotels`, headers: key(), payload: { hotelId } }),
      ),
    )
    // «Атомарные места в автобусе И НОМЕРЕ» — из описания этапа. Автобус
    // проверен критерием, номер не проверял никто, и записаться в него
    // было нечем: пути не существовало.
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2)
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(1)

    const { rows } = await app.db!.query<{ booked: number; rows: string }>(
      `select h.booked, (select count(*)::text from hotel_bookings k where k.hotel_id = h.id) as rows
         from hotel_blocks h where h.id = $1`,
      [hotelId],
    )
    expect(rows[0]!.booked).toBe(2)
    expect(Number(rows[0]!.rows)).toBe(2)
  })

  /* ── один гость — один автобус ────────────────────────────────────── */
  it('гость не занимает места сразу в двух автобусах', async () => {
    const w = await newWedding()
    const first = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Первый', seats: 5 },
    })
    const second = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Второй', seats: 5 },
    })
    const guest = await newGuest(w)

    expect((await bookSeat(guest.token, first.json().id)).statusCode).toBe(200)
    // Передумал и выбрал другую точку сбора. Он один человек: место
    // в первом автобусе обязано освободиться, иначе водитель ждёт того,
    // кто уехал другим рейсом.
    expect((await bookSeat(guest.token, second.json().id)).statusCode).toBe(200)

    // Сверяем по идентификаторам, а не по порядку сортировки: он зависит
    // от правил сравнения строк в базе и к сути проверки отношения не имеет.
    const { rows } = await app.db!.query<{ taken: number }>(
      `select (select taken from bus_routes where id = $1) as taken`,
      [first.json().id],
    )
    const { rows: now } = await app.db!.query<{ taken: number }>(
      `select (select taken from bus_routes where id = $1) as taken`,
      [second.json().id],
    )
    expect({ прежний: rows[0]!.taken, новый: now[0]!.taken }).toEqual({ прежний: 0, новый: 1 })
  })

  /* ── отказ от приглашения освобождает место ───────────────────────── */
  it('гость, ответивший «не приду», перестаёт занимать место', async () => {
    const w = await newWedding()
    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус', seats: 3 },
    })
    const hotel = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/hotels`,
      headers: auth(w.token),
      payload: { name: 'Отель', rooms: 3 },
    })
    const guest = await newGuest(w)
    await bookSeat(guest.token, bus.json().id)
    await app.inject({
      method: 'POST',
      url: `/join/${guest.token}/hotels`,
      headers: key(),
      payload: { hotelId: hotel.json().id },
    })

    const said = await app.inject({
      method: 'POST',
      url: `/rsvp/${guest.token}`,
      payload: { status: 'no' },
    })
    expect(said.statusCode).toBe(200)

    // Он не придёт — держать под него сиденье и номер незачем.
    const { rows } = await app.db!.query<{ taken: number; booked: number }>(
      `select (select taken from bus_routes where id = $1) as taken,
              (select booked from hotel_blocks where id = $2) as booked`,
      [bus.json().id, hotel.json().id],
    )
    expect(rows[0]).toEqual({ taken: 0, booked: 0 })
  })

  /* ── счётчик персон должен где-то жить ────────────────────────────── */
  it('опрос меню показывает, на сколько персон готовить', async () => {
    const w = await newWedding()
    const yesPlusOne = await newGuest(w, 'Ольга', true)
    const yesAlone = await newGuest(w, 'Денис')
    const declined = await newGuest(w, 'Катя')

    await app.inject({ method: 'POST', url: `/rsvp/${yesPlusOne.token}`, payload: { status: 'yes', plusOne: true } })
    await app.inject({ method: 'POST', url: `/rsvp/${yesAlone.token}`, payload: { status: 'yes' } })
    await app.inject({ method: 'POST', url: `/rsvp/${declined.token}`, payload: { status: 'no' } })

    const poll = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
    })
    // Кейтерингу нужны порции, а не записи: «Ольга +1» это два человека
    // за столом и две порции. Правило было в описании этапа, но нигде
    // не отдавалось наружу.
    expect(poll.json().expectedPortions).toBe(3)
  })

  /* ── опрос меню ───────────────────────────────────────────────────── */
  it('правка опроса сохраняет голоса за оставшиеся блюда', async () => {
    const w = await newWedding()
    const poll = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }] },
    })
    const [fish, meat] = poll.json().options as { id: string; name: string }[]
    const guest = await newGuest(w)
    await app.inject({ method: 'POST', url: `/join/${guest.token}/menu-vote`, payload: { optionId: fish!.id } })

    const edited = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
      payload: { options: [{ id: fish!.id, name: 'Рыба на гриле' }, { id: meat!.id, name: 'Мясо' }] },
    })
    expect(edited.statusCode).toBe(200)

    const after = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
    })
    const options = after.json().options as { id: string; name: string; votes: number }[]
    // Переименование блюда не должно обнулять уже сделанный выбор.
    expect(options.find((o) => o.id === fish!.id)).toMatchObject({ name: 'Рыба на гриле', votes: 1 })
  })

  /* ── отменённая свадьба ───────────────────────────────────────────── */
  it('после отмены свадьбы гостевой токен перестаёт работать', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    expect((await app.inject({ method: 'GET', url: `/rsvp/${guest.token}` })).statusCode).toBe(200)

    await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })
    expect((await app.inject({ method: 'GET', url: `/rsvp/${guest.token}` })).statusCode).toBe(401)
  })

  /* ── код ссылки ───────────────────────────────────────────────────── */
  it('код ссылки принимается в любом регистре', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Катя' },
    })
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    // Человек переписывает код с экрана — регистр он не сохранит.
    const res = await app.inject({ method: 'GET', url: `/invite/${code.toLowerCase()}` })
    expect(res.statusCode).toBe(200)
  })
})
