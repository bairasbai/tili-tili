import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Что гость и пара могут ПРОЧИТАТЬ в логистике и меню.
 *
 * Контракт умел только записывать. Пара заводила маршрут трансфера и отельный
 * блок, но прочитать их не могла: после перезагрузки экран логистики оставался
 * пустым, хотя записи лежали в базе. Гость мог записаться в автобус и выбрать
 * блюдо, но списка маршрутов и вариантов не видел — `busId` и `optionId` ему
 * было взять неоткуда, то есть кнопки существовали, а выбор был невозможен.
 *
 * Отдельно проверяется `myBusId` и `chosenOptionId`: без них гость, вернувшийся
 * по своей ссылке, видит пустой выбор и записывается второй раз.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: чтения логистики и меню', () => {
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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const key = () => ({ 'idempotency-key': `k10-${RUN}-${++counter}` })

  async function newUser() {
    const phone = `+79${RUN}${String(counter++).padStart(3, '0')}`
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    let code = ''
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) {
        code = c
        break
      }
    }
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token }
  }

  async function newWedding() {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  /** Гость с персональным токеном: пара выдаёт ссылку, браузер меняет её на токен. */
  async function newGuest(w: { token: string; weddingId: string }, name = 'Ольга') {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name },
    })
    const guestId = created.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode).toBe(200)
    return { guestId, token: exchanged.json().guestToken as string }
  }

  /* ── пара читает свою логистику ───────────────────────────────────── */
  it('маршрут и отельный блок читаются обратно, а не только создаются', async () => {
    const w = await newWedding()

    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус №1', from: 'Гостиный двор', time: '14:30', seats: 45 },
    })
    expect(bus.statusCode).toBe(201)

    const hotel = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/hotels`,
      headers: auth(w.token),
      payload: { name: 'Хилтон', rooms: 10, price: { amount: 450000, currency: 'RUB' } },
    })
    expect(hotel.statusCode).toBe(201)

    const buses = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
    })
    expect(buses.statusCode).toBe(200)
    expect(buses.json()).toHaveLength(1)
    expect(buses.json()[0]).toMatchObject({ name: 'Автобус №1', seats: 45, taken: 0 })

    const hotels = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/logistics/hotels`,
      headers: auth(w.token),
    })
    expect(hotels.statusCode).toBe(200)
    expect(hotels.json()[0]).toMatchObject({ name: 'Хилтон', rooms: 10, booked: 0 })
  })

  it('чужую логистику не видно', async () => {
    const mine = await newWedding()
    await app.inject({
      method: 'POST',
      url: `/weddings/${mine.weddingId}/logistics/buses`,
      headers: auth(mine.token),
      payload: { name: 'Автобус №1', seats: 45 },
    })
    const stranger = await newWedding()
    const seen = await app.inject({
      method: 'GET',
      url: `/weddings/${stranger.weddingId}/logistics/buses`,
      headers: auth(stranger.token),
    })
    expect(seen.json()).toEqual([])
  })

  /* ── гость читает то, из чего выбирает ────────────────────────────── */
  it('гость видит маршруты и то, куда уже записан', async () => {
    const w = await newWedding()
    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус №1', from: 'Гостиный двор', time: '14:30', seats: 45 },
    })
    const busId = bus.json().id as string
    const guest = await newGuest(w)

    const before = await app.inject({ method: 'GET', url: `/join/${guest.token}/shuttle` })
    expect(before.statusCode).toBe(200)
    expect(before.json().routes).toHaveLength(1)
    // До записи пусто — иначе гость не отличит «я записан» от «я нет».
    expect(before.json().myBusId).toBeNull()

    const joined = await app.inject({
      method: 'POST',
      url: `/join/${guest.token}/shuttle`,
      headers: key(),
      payload: { busId },
    })
    expect(joined.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: `/join/${guest.token}/shuttle` })
    expect(after.json().myBusId).toBe(busId)
    expect(after.json().routes[0].taken).toBe(1)
  })

  it('гость видит варианты блюд и свой выбор', async () => {
    const w = await newWedding()
    await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
      payload: { question: 'Что на горячее?', options: [{ name: 'Мясо' }, { name: 'Рыба' }] },
    })
    const guest = await newGuest(w)

    const before = await app.inject({ method: 'GET', url: `/join/${guest.token}/menu-vote` })
    expect(before.statusCode).toBe(200)
    expect(before.json().question).toBe('Что на горячее?')
    expect(before.json().options).toHaveLength(2)
    expect(before.json().chosenOptionId).toBeNull()

    const optionId = before.json().options[0].id as string
    await app.inject({
      method: 'POST',
      url: `/join/${guest.token}/menu-vote`,
      payload: { optionId },
    })

    const after = await app.inject({ method: 'GET', url: `/join/${guest.token}/menu-vote` })
    // Вернувшийся по ссылке гость должен видеть свой прошлый выбор, а не пустоту.
    expect(after.json().chosenOptionId).toBe(optionId)
  })

  it('чужой токен к маршрутам и меню не пускает', async () => {
    const mine = await newWedding()
    await app.inject({
      method: 'POST',
      url: `/weddings/${mine.weddingId}/logistics/buses`,
      headers: auth(mine.token),
      payload: { name: 'Автобус №1', seats: 45 },
    })
    const other = await newWedding()
    const stranger = await newGuest(other)

    // Гость чужой свадьбы видит логистику СВОЕЙ свадьбы, а не той, где автобус.
    const seen = await app.inject({ method: 'GET', url: `/join/${stranger.token}/shuttle` })
    expect(seen.json().routes).toEqual([])

    /* Недействительный токен — 401 «Ссылка недействительна», а не 404:
       адрес существует, не годится именно предъявленный ключ. */
    const bogus = await app.inject({ method: 'GET', url: '/join/нет-такого-токена/shuttle' })
    expect(bogus.statusCode).toBe(401)
  })
})
