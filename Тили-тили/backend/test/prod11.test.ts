import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Отзывы: половина, которой не было.
 *
 * Гость мог оставить отзыв, но до пары он не доходил — экран «После свадьбы»
 * читал моки из браузера и показывал пять выдуманных отзывов о подрядчиках,
 * которые на этой свадьбе не работали. Здесь проверяется вторая половина:
 * пара читает то, что ей действительно написали, знает, о ком отзыв, и не
 * узнаёт автора.
 *
 * Отдельно — дата свадьбы в гостевом списке команды: по ней форма отзыва
 * решает, показывать себя или сказать «после дня свадьбы». Без неё гость
 * заполнял форму и получал отказ после отправки.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: отзывы глазами пары', () => {
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
  const key = () => ({ 'idempotency-key': `k11-${RUN}-${++counter}` })

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

  async function newWedding(date = '2027-06-14') {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date, city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  async function newVendor() {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Фотостудия ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(res.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string, name: res.json().name as string }
  }

  async function book(w: { token: string; weddingId: string }, vendorId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'photo') ?? slots[0]!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    const { rows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [slot.id])
    return rows[0]!.id
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
    expect(exchanged.statusCode).toBe(200)
    return { guestId, token: exchanged.json().guestToken as string }
  }

  /** Свадьба в прошлом — иначе отзыв гостя не принимается вовсе. */
  const movePast = (weddingId: string) =>
    app.db!.query("update weddings set date = current_date - 3 where id = $1", [weddingId])

  /* ── дата в гостевом списке команды ───────────────────────────────── */
  it('гость получает дату свадьбы вместе с командой', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)
    const guest = await newGuest(w)

    const team = await app.inject({ method: 'GET', url: `/join/${guest.token}/team` })
    expect(team.statusCode).toBe(200)
    expect(team.json().weddingDate).toBe('2027-06-14')
    expect(team.json().vendors).toHaveLength(1)
  })

  /* ── пара читает отзывы гостей ────────────────────────────────────── */
  it('отзыв гостя доходит до пары — с подрядчиком и без автора', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)
    const guest = await newGuest(w)
    await movePast(w.weddingId)

    const sent = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${guest.token}`,
      payload: { vendorId: vendor.vendorId, stars: 5, text: 'Снимал незаметно, кадры живые' },
    })
    expect(sent.statusCode).toBe(201)

    const seen = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/guest-reviews`,
      headers: auth(w.token),
    })
    expect(seen.statusCode).toBe(200)
    const list = seen.json() as Record<string, unknown>[]
    expect(list).toHaveLength(1)
    // Без подрядчика отзыв не к чему отнести: экран показывал бы звёзды ни о ком.
    expect(list[0]).toMatchObject({
      vendorId: vendor.vendorId,
      vendorName: vendor.name,
      authorName: 'Гость свадьбы',
      rating: 5,
      text: 'Снимал незаметно, кадры живые',
    })
    // Ни токена, ни имени гостя: анонимность §9 держится в самом ответе.
    expect(JSON.stringify(list[0])).not.toContain(guest.token)
    expect(JSON.stringify(list[0])).not.toContain('Ольга')
  })

  it('чужие отзывы в свою свадьбу не попадают', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)
    const guest = await newGuest(w)
    await movePast(w.weddingId)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${guest.token}`,
      payload: { vendorId: vendor.vendorId, stars: 4 },
    })

    const stranger = await newWedding()
    const seen = await app.inject({
      method: 'GET',
      url: `/weddings/${stranger.weddingId}/guest-reviews`,
      headers: auth(stranger.token),
    })
    expect(seen.json()).toEqual([])
  })

  /* ── отзыв пары ───────────────────────────────────────────────────── */
  it('пара оценивает подрядчика только по завершённой сделке', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const dealId = await book(w, vendor.vendorId)

    // Сделка забронирована, но не завершена — отзыва быть не может.
    const early = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 5, text: 'Всё понравилось' },
    })
    expect(early.statusCode).toBe(403)

    await app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [dealId])
    const ok = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 5, text: 'Всё понравилось' },
    })
    expect(ok.statusCode).toBe(201)

    // Второй отзыв по той же сделке — конфликт, а не второй голос в рейтинге.
    const again = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 1, text: 'Передумали' },
    })
    expect(again.statusCode).toBe(409)
  })
})
