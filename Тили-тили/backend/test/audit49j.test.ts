/*
 * Ревью 016 / хвост SA-05 — гонка «удаление аккаунта × бронирование слота»
 * (сиблинг ERR-0271 / R-271, расследован FL-9, закрыт этим проходом).
 *
 * До правки: `DELETE /users/me` брал `for update` на свадьбы пары и проверял
 * живые сделки внутри своей транзакции, но `POST …/slots/{slotId}/book`
 * нигде не перепроверял `deleted_at` ЗАЯВИТЕЛЯ после `preHandler`. Порядок
 * «удаление раньше брони» проходил насквозь: удаление коммитилось (204),
 * уже аутентифицированная бронь заводила сделку на стёртый аккаунт, и
 * подрядчику доставалась дата, занятая призраком. Обратный порядок FL-9
 * закрыла — бронь успевала зафиксироваться, и проверка сделок отвечала 409.
 *
 * Сторона подрядчика была дырявой в обе стороны: бронь читала анкету с
 * `u.deleted_at is null`, но без замка на строке пользователя-подрядчика,
 * так что удаление подрядчика и бронь у него не сериализовались вовсе.
 *
 * T1 — пара: 10 заходов `Promise.all([DELETE /users/me, book])` на прогретом
 *      пуле. Допустимы ровно два исхода: (удаление 204 и бронь не 2xx)
 *      либо (бронь 2xx и удаление 409). Оба успеха сразу — та самая гонка.
 * T2 — подрядчик: то же для `Promise.all([DELETE подрядчика, book у него])`.
 * T3 — контроль: без гонки бронь у живого подрядчика по-прежнему 2xx, а
 *      удаление пары с живой сделкой по-прежнему 409.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('SA-05: удаление аккаунта и бронирование слота — обе стороны под замком', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259): в общей
   * дев-базе сотня тысяч номеров `+79RRRRRRNNN` от прежних прогонов, и
   * случайный RUN иногда совпадает с занятым — тогда на свежем номере
   * прилетает 409 «wedding_exists». */
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

  /* Гонка видна только на прогретом пуле: холодный сам сериализует залп,
   * открывая соединения по одному, и «проходит» даже без фикса. */
  const warmPool = () => Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.2)')))

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 and consumed_at is null order by created_at desc limit 1',
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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: body.accessToken, userId: body.user.id }
  }

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    const weddingId = w.json().id as string
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(user.token) })
    ).json() as { id: string; categoryId: string }[]
    return { ...user, weddingId, slotId: slots.find((s) => s.categoryId === 'photo')!.id }
  }

  async function publishedVendor() {
    const owner = await newUser()
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: {
        name: `Студия ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
        priceFrom: { amount: 4_000_000, currency: 'RUB' },
      },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    expect(
      (await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })).statusCode,
    ).toBe(200)
    return { ...owner, vendorId: put.json().id as string }
  }

  const book = (w: { token: string; weddingId: string; slotId: string }, vendorId: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${w.slotId}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })

  /* Успех брони — 200 либо 201: путь идёт через `withIdempotency`,
   * который отвечает 200 с телом слота. Сравнивать только с 201 — значит
   * зеленеть вхолостую: проверка «оба успеха» никогда не сработает. */
  const booked2xx = (code: number) => code === 200 || code === 201

  const dealsOf = async (weddingId: string) =>
    (await app.db!.query('select 1 from deals where wedding_id = $1', [weddingId])).rows.length

  it('T1: пара — «аккаунт удалён» и «слот забронирован» не случаются оба', async () => {
    for (let i = 0; i < 10; i++) {
      const w = await newWedding()
      const vendor = await publishedVendor()
      await warmPool()
      const [del, booked] = await Promise.all([
        app.inject({ method: 'DELETE', url: '/users/me', headers: auth(w.token) }),
        book(w, vendor.vendorId),
      ])
      const deals = await dealsOf(w.weddingId)
      expect(
        del.statusCode === 204 && booked2xx(booked.statusCode),
        `заход ${i}: удаление 204 и бронь ${booked.statusCode} одновременно, сделок ${deals}`,
      ).toBe(false)
      if (del.statusCode === 204) expect(deals, `заход ${i}: аккаунт удалён, а сделка есть`).toBe(0)
      if (booked2xx(booked.statusCode)) {
        expect(del.statusCode, `заход ${i}: бронь прошла — удаление обязано быть 409`).toBe(409)
      }
    }
  })

  it('T2: подрядчик — удаление его аккаунта и бронь у него не случаются оба', async () => {
    for (let i = 0; i < 10; i++) {
      const w = await newWedding()
      const vendor = await publishedVendor()
      await warmPool()
      const [del, booked] = await Promise.all([
        app.inject({ method: 'DELETE', url: '/users/me', headers: auth(vendor.token) }),
        book(w, vendor.vendorId),
      ])
      const deals = await dealsOf(w.weddingId)
      expect(
        del.statusCode === 204 && booked2xx(booked.statusCode),
        `заход ${i}: подрядчик удалён (204) и бронь у него прошла (${booked.statusCode}), сделок ${deals}`,
      ).toBe(false)
      if (booked2xx(booked.statusCode)) {
        expect(del.statusCode, `заход ${i}: бронь прошла — удаление подрядчика обязано быть 409`).toBe(409)
      }
    }
  })

  it('T3: контроль без гонки — бронь 2xx, затем удаление пары 409', async () => {
    const w = await newWedding()
    const vendor = await publishedVendor()
    const booked = await book(w, vendor.vendorId)
    expect(booked2xx(booked.statusCode), booked.body.slice(0, 300)).toBe(true)
    const del = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(w.token) })
    expect(del.statusCode, del.body.slice(0, 300)).toBe(409)
    expect(del.json().error.code).toBe('active_deals')
  })
})
