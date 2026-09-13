/*
 * Фича 013 — сделки свадьбы для поддержки (`GET /admin/weddings/{id}/deals`;
 * решение владельца 2026-09-13: сделки — да, переписка — нет).
 *
 * Сотрудник с причиной видит сделки свадьбы: из каталога — с именем анкеты,
 * ценой и историей событий; свой подрядчик — по имени, БЕЗ телефона (ни
 * одного номера в теле ответа); оплачено — той же формулой, что у пары.
 * Каждый просмотр — строка журнала `wedding.deals.view` с причиной. Без
 * причины — 422, не сотрудник — 403, чужой идентификатор — 404. Красный без
 * фикса: путь отвечал 501 `not_implemented`.
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

type SupportDeal = {
  id: string
  slotLabel: string
  categoryId: string
  vendorName: string | null
  externalName: string | null
  state: string
  price: { amount: number; currency: string } | null
  paid: { amount: number; currency: string }
  events: { at: string; by: string; fromState: string | null; toState: string; note: string | null }[]
}

describe.skipIf(!live)('фича 013: сделки свадьбы для поддержки', () => {
  let app: FastifyInstance
  let counter = 0
  const RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const EXTERNAL_PHONE = '+79170004455'

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

  async function newUser() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.json().id}/slots`, headers: auth(user.token) })).json() as { id: string; categoryId: string; label: string }[]
    return { ...user, weddingId: w.json().id as string, slots }
  }

  async function publishedVendor(categoryId: string) {
    const owner = await newUser()
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Студия ${RUN}`, categoryId, city: { name: 'Уфа', region: 'Башкортостан' }, priceFrom: { amount: 4_000_000, currency: 'RUB' } },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })).statusCode).toBe(200)
    return { id: put.json().id as string, name: `Студия ${RUN}` }
  }

  const dealsOf = (token: string, weddingId: string, reason = 'обращение #4521: спор о предоплате') =>
    app.inject({ method: 'GET', url: `/admin/weddings/${weddingId}/deals?reason=${encodeURIComponent(reason)}`, headers: auth(token) })

  it('сотрудник с причиной видит сделки: имя анкеты, цена, оплачено, история; свой подрядчик — по имени и без телефона; журнал пишется', async () => {
    const w = await newWedding()
    const photo = w.slots.find((s) => s.categoryId === 'photo')!
    const florist = w.slots.find((s) => s.categoryId === 'florist')!
    const vendor = await publishedVendor('photo')
    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${photo.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId: vendor.id, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect([200, 201], booked.body.slice(0, 300)).toContain(booked.statusCode)
    const external = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${florist.id}/external`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorName: 'Флорист Анна', phone: EXTERNAL_PHONE, price: { amount: 3_000_000, currency: 'RUB' } },
    })
    expect([200, 201], external.body.slice(0, 300)).toContain(external.statusCode)

    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])
    const res = await dealsOf(staff.token, w.weddingId)
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
    const { items } = res.json() as { items: SupportDeal[] }
    expect(items.length).toBeGreaterThanOrEqual(2)

    const fromCatalog = items.find((d) => d.slotLabel === photo.label)!
    expect(fromCatalog).toMatchObject({ categoryId: 'photo', vendorName: vendor.name, externalName: null, price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } })
    expect(['negotiating', 'booked']).toContain(fromCatalog.state)
    expect(fromCatalog.events.length, 'история событий сделки пуста').toBeGreaterThanOrEqual(1)
    expect(fromCatalog.events[0]).toMatchObject({ by: 'couple' })
    expect(fromCatalog.events.every((e) => typeof e.at === 'string' && e.toState)).toBe(true)

    const own = items.find((d) => d.slotLabel === florist.label)!
    expect(own).toMatchObject({ vendorName: null, externalName: 'Флорист Анна', price: { amount: 3_000_000, currency: 'RUB' } })
    /* Телефон своего подрядчика — персональные данные третьего лица: в ответе поддержке его нет. */
    expect(res.body).not.toContain(EXTERNAL_PHONE)
    expect(res.body).not.toContain(EXTERNAL_PHONE.slice(1))
    expect(res.body, 'телефон пары тоже не должен уходить').not.toContain(w.phone.slice(1))

    const { rows } = await app.db!.query<{ diff: { reason: string } }>(
      `select diff from audit_log where actor_id = $1 and action = 'wedding.deals.view' and entity_id = $2 order by at desc limit 1`,
      [staff.userId, w.weddingId],
    )
    expect(rows[0]?.diff.reason, 'просмотр сделок не записан в журнал').toBe('обращение #4521: спор о предоплате')
  })

  it('без причины — 422; причина короче пяти знаков — 422; не сотрудник — 403; чужой идентификатор — 404', async () => {
    const w = await newWedding()
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])

    expect((await app.inject({ method: 'GET', url: `/admin/weddings/${w.weddingId}/deals`, headers: auth(staff.token) })).statusCode).toBe(422)
    expect((await dealsOf(staff.token, w.weddingId, 'ок')).statusCode).toBe(422)
    expect((await dealsOf(w.token, w.weddingId)).statusCode, 'пара не сотрудник').toBe(403)
    expect((await dealsOf(staff.token, randomUUID())).statusCode).toBe(404)
    expect((await dealsOf(staff.token, 'not-a-uuid')).statusCode).toBe(404)
  })
})
