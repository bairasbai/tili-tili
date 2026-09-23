import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Перепроверка после этапа 5 — всей работы.
 * Вопросы прежние: кто что видит в теле, что при двух одновременных запросах,
 * сколько строк через месяц, что вернётся с чистого устройства, что копится,
 * какое поле принимается на веру, что стоит денег.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('перепроверка после этапа 5', () => {
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
      // Предел кадров занижен, чтобы проверить, что ограничитель есть:
      // в проде 50, и гонять полсотни запросов в тесте незачем.
      albumMaxPerGuest: 10,
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
  const idem = (token: string) => ({ ...auth(token), 'idempotency-key': randomUUID() })

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

  async function newUser() {
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
    return token
  }

  async function newWedding() {
    const token = await newUser()
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
    return { guestId, token: exchanged.json().guestToken as string }
  }

  /* ── удаление гостя освобождает место ─────────────────────────────── */
  it('удаление гостя возвращает место в автобус', async () => {
    const w = await newWedding()
    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус', seats: 2 },
    })
    const busId = bus.json().id as string
    const a = await newGuest(w, 'Ольга')
    const b = await newGuest(w, 'Денис')

    for (const g of [a, b]) {
      const res = await app.inject({
        method: 'POST',
        url: `/join/${g.token}/shuttle`,
        headers: { 'idempotency-key': randomUUID() },
        payload: { busId },
      })
      expect(res.statusCode).toBe(200)
    }

    // Гость передумал и его удалили из списка. Место обязано вернуться:
    // иначе автобус «полон» с пустым сиденьем, и следующий не сядет.
    await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/guests/${a.guestId}`,
      headers: auth(w.token),
    })

    const { rows } = await app.db!.query<{ taken: number; booked: string }>(
      `select b.taken, (select count(*)::text from bus_bookings k where k.bus_id = b.id) as booked
         from bus_routes b where b.id = $1`,
      [busId],
    )
    expect(Number(rows[0]!.booked)).toBe(1)
    expect(rows[0]!.taken).toBe(1)

    const c = await newGuest(w, 'Катя')
    const seat = await app.inject({
      method: 'POST',
      url: `/join/${c.token}/shuttle`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { busId },
    })
    expect(seat.statusCode).toBe(200)
  })

  it('удаление маршрута не оставляет висящих записей', async () => {
    const w = await newWedding()
    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус', seats: 5 },
    })
    const busId = bus.json().id as string
    const guest = await newGuest(w)
    await app.inject({
      method: 'POST',
      url: `/join/${guest.token}/shuttle`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { busId },
    })
    await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/logistics/buses/${busId}`,
      headers: auth(w.token),
    })
    const { rows } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from bus_bookings where bus_id = $1',
      [busId],
    )
    expect(rows[0]!.n).toBe(0)
  })

  /* ── что копится ──────────────────────────────────────────────────── */
  it('старые рассылки не хранятся вечно', async () => {
    const w = await newWedding()
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/notify-pickup`,
      headers: idem(w.token),
    })
    await app.db!.query("update broadcasts set created_at = now() - interval '400 days'")
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/menu-poll/remind`,
      headers: idem(w.token),
    })
    const { rows } = await app.db!.query<{ n: number }>(
      "select count(*)::int as n from broadcasts where created_at < now() - interval '90 days'",
    )
    expect(rows[0]!.n).toBe(0)
  })

  /* ── что принимается от гостя на веру ─────────────────────────────── */
  it('гость не может завалить альбом кадрами без предела', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/album?guestToken=${encodeURIComponent(guest.token)}`,
        payload: { fileUrl: `https://storage.test/${i}.jpg`, consent: true },
      })
      statuses.push(res.statusCode)
    }
    // Каждый кадр — файл в хранилище и работа модератора. Без предела один
    // человек забивает альбом и счёт за хранение.
    expect(statuses).toContain(429)
  })

  it('ссылка на кадр обязана быть http или https', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/album?guestToken=${encodeURIComponent(guest.token)}`,
      payload: { fileUrl: 'javascript:alert(1)', consent: true },
    })
    expect(res.statusCode).toBe(422)
  })

  /* ── роли ─────────────────────────────────────────────────────────── */
  it('помощник ведёт гостей и логистику, но не видит денег', async () => {
    const w = await newWedding()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'helper' },
    })
    const helperToken = await newUser()
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(helperToken),
    })

    for (const url of ['/guests', '/tables', '/tasks', '/timeline']) {
      const res = await app.inject({
        method: 'GET',
        url: `/weddings/${w.weddingId}${url}`,
        headers: auth(helperToken),
      })
      expect(`${url} → ${res.statusCode}`).toBe(`${url} → 200`)
    }
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/weddings/${w.weddingId}/budget`,
          headers: auth(helperToken),
        })
      ).statusCode,
    ).toBe(403)
  })

  it('гость не попадает на пути пары своим токеном', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    for (const url of ['/guests', '/budget', '/tables']) {
      const res = await app.inject({
        method: 'GET',
        url: `/weddings/${w.weddingId}${url}?guestToken=${encodeURIComponent(guest.token)}`,
      })
      expect(`${url} → ${res.statusCode}`).toBe(`${url} → 401`)
    }
  })

  /* ── старые этапы не сломались ────────────────────────────────────── */
  it('каталог, сделки и бюджет продолжают работать', async () => {
    const w = await newWedding()
    expect(
      (await app.inject({ method: 'GET', url: '/catalog/categories', headers: auth(w.token) })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/budget`, headers: auth(w.token) })).statusCode,
    ).toBe(200)
  })
})
