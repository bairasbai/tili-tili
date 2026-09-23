import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Телефон в анкете подрядчика (решение владельца 2026-09-03).
 *
 * Два решения сразу. Номер — отдельное поле анкеты, а не номер входа:
 * публикация личного телефона это раскрытие персональных данных, и
 * заполняя поле, подрядчик соглашается его показать. Видит номер тот,
 * кто уже забронировал: до брони разговор идёт в чате.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)
const PHONE = '+7 999 123-45-67'

describe.skipIf(!live)('прод: телефон подрядчика', () => {
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
  const key = () => ({ 'idempotency-key': `k-${RUN}-${++counter}` })

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
    return { token, loginPhone: phone }
  }

  async function newVendor(phone: string | null = PHONE) {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Студия ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        ...(phone ? { phone } : {}),
      },
    })
    expect(res.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
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
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    return { ...user, weddingId: res.json().id as string }
  }

  async function book(w: { token: string; weddingId: string }, vendorId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'photo')!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
  }

  const card = (token: string, vendorId: string) =>
    app.inject({ method: 'GET', url: `/catalog/vendors/${vendorId}`, headers: auth(token) })

  /* ── до брони ─────────────────────────────────────────────────────── */
  it('до брони номера в анкете нет, после брони — есть', async () => {
    const vendor = await newVendor()
    const couple = await newWedding()

    const before = await card(couple.token, vendor.vendorId)
    /* Поле в ответе есть, но пустое: это «ещё рано», а не «номер не
     * указан» — клиент показывает вместо него кнопку «Написать». */
    expect(before.json().phone).toBeNull()
    expect(before.body).not.toContain('123-45-67')

    await book(couple, vendor.vendorId)
    const after = await card(couple.token, vendor.vendorId)
    expect(after.json().phone).toBe(PHONE)
  })

  it('чужая пара номера не видит, даже когда подрядчик занят', async () => {
    const vendor = await newVendor()
    const mine = await newWedding()
    await book(mine, vendor.vendorId)

    const stranger = await newWedding()
    const seen = await card(stranger.token, vendor.vendorId)
    // Бронь даёт номер той свадьбе, которая забронировала, а не всем сразу.
    expect(seen.json().phone).toBeNull()
    expect(seen.body).not.toContain('123-45-67')
  })

  it('команда свадьбы звонит по тому же поводу, что и пара', async () => {
    const vendor = await newVendor()
    const couple = await newWedding()
    await book(couple, vendor.vendorId)

    for (const role of ['coordinator', 'helper']) {
      const person = await newUser()
      const invite = await app.inject({
        method: 'POST',
        url: `/weddings/${couple.weddingId}/invites`,
        headers: auth(couple.token),
        payload: { role },
      })
      await app.inject({
        method: 'POST',
        url: `/invites/${invite.json().code}/accept`,
        headers: auth(person.token),
      })
      /* В день X контакты команды нужны и координатору, и помощнику:
       * право даёт сделка свадьбы, а не роль в ней. */
      expect({ role, phone: (await card(person.token, vendor.vendorId)).json().phone }).toEqual({ role, phone: PHONE })
    }
  })

  it('отмена брони закрывает номер обратно', async () => {
    const vendor = await newVendor()
    const couple = await newWedding()
    await book(couple, vendor.vendorId)
    expect((await card(couple.token, vendor.vendorId)).json().phone).toBe(PHONE)

    const { rows } = await app.db!.query<{ id: string }>(
      'select id from deals where wedding_id = $1 and vendor_id = $2',
      [couple.weddingId, vendor.vendorId],
    )
    await app.inject({
      method: 'PATCH',
      url: `/deals/${rows[0]!.id}`,
      headers: { ...auth(couple.token), ...key() },
      payload: { state: 'cancelled' },
    })
    // Сделки больше нет — и повода звонить тоже.
    expect((await card(couple.token, vendor.vendorId)).json().phone).toBeNull()
  })

  /* ── откуда берётся номер ─────────────────────────────────────────── */
  it('номер входа в анкету не попадает: показывается только то, что ввели', async () => {
    const vendor = await newVendor(null)
    const couple = await newWedding()
    await book(couple, vendor.vendorId)

    const seen = await card(couple.token, vendor.vendorId)
    /* Публиковать номер, которым человек ВОШЁЛ, нельзя: согласия на это
     * он не давал. Пустое поле анкеты — пустой телефон, даже после брони. */
    expect(seen.json().phone).toBeNull()
    expect(seen.body).not.toContain(vendor.loginPhone)
  })

  it('подрядчик видит и правит свой номер в кабинете', async () => {
    const vendor = await newVendor()
    const mine = await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(vendor.token) })
    // Свой номер владелец анкеты видит всегда — иначе не поймёт, что указал.
    expect(mine.json().phone).toBe(PHONE)

    await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendor.token),
      payload: {
        name: `Студия ${RUN}-новая`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        phone: '+7 999 765-43-21',
      },
    })
    expect((await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(vendor.token) })).json().phone).toBe(
      '+7 999 765-43-21',
    )
  })

  it('короткий огрызок вместо номера не сохраняется', async () => {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Студия ${RUN}-к`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        phone: '+7',
      },
    })
    expect(res.statusCode).toBe(422)
  })
})
