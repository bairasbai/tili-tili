import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { encodeCursor } from '../src/pagination.js'

/*
 * Ревью старого кода, Д6-03 / Д2-18 / Д5-16: проверка «формат до базы» была
 * шире того, что принимает PostgreSQL.
 *
 * Шаблон `^[0-9a-f-]{36}$` пропускал 36 дефисов и дефисы не на границах групп,
 * а `'…'::uuid` на таком падал ошибкой 22P02 — 500 с записью в журнал как об
 * аварии и в Sentry (R-108/R-111). Курсор по времени проверялся `Date.parse`,
 * который принимает `'2026'`, тогда как `'2026'::timestamptz` в PG 16 — ошибка.
 * Любой вошедший одной строкой запроса писал в журнал аварию — ровно то, что
 * ERR-0093/0096/0098 объявили закрытым.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/** Проходит старый шаблон (36 знаков из `[0-9a-f-]`), не проходит `uuid_in`. */
const NOT_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa-'
const DASHES = '-'.repeat(36)

describe.skipIf(!live)('идентификаторы и курсоры: не-uuid и не-дата — 404/400, а не 500', () => {
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
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`

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
    const body = v.json() as { accessToken: string }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return body.accessToken
  }

  async function newWedding(token: string) {
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', date: '2027-06-14', city: { name: 'Казань', region: 'Татарстан' } },
    })
    expect(w.statusCode).toBe(201)
    return w.json().id as string
  }

  it('свадьба, анкета и слот с идентификатором из 36 знаков, но не uuid — 404, не 500', async () => {
    const token = await newUser()
    const weddingId = await newWedding(token)
    const urls = [
      `/weddings/${NOT_UUID}`,
      `/weddings/${DASHES}/slots`,
      `/catalog/vendors/${NOT_UUID}`,
      `/catalog/vendors/${DASHES}/reviews`,
      `/weddings/${weddingId}/slots/${NOT_UUID}/cancel`,
      `/deals/${DASHES}`,
      `/notifications/${NOT_UUID}/read`,
    ]
    const codes: Record<string, number> = {}
    for (const url of urls) {
      const method = url.endsWith('/cancel') || url.endsWith('/read') ? 'POST' : 'GET'
      const res = await app.inject({
        method,
        url,
        headers: { ...auth(token), 'idempotency-key': `k-${RUN}-${counter++}` },
        payload: method === 'POST' ? {} : undefined,
      })
      codes[url] = res.statusCode
    }
    // Ни один адрес с подделанным идентификатором не должен превращаться в аварию.
    expect(Object.values(codes).every((c) => c === 404 || c === 422)).toBe(true)
    expect(Object.values(codes)).not.toContain(500)
  })

  async function newVendor(token: string) {
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(token),
      payload: {
        name: `Курсорный ${RUN}-${counter}`,
        categoryId: 'decor',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(token) })
    return created.json().id as string
  }

  it('курсор по времени вида «2026» — 400 bad_cursor, не 500', async () => {
    const vendorId = await newVendor(await newUser())
    const reader = await newUser()
    // `Date.parse('2026')` — число, `'2026'::timestamptz` в PostgreSQL 16 — ошибка приведения.
    const forged = encodeCursor('2026', '01a08f6c-0000-7000-8000-000000000000')
    const res = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendorId}/reviews?cursor=${forged}`,
      headers: auth(reader),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('bad_cursor')
  })

  it('курсор с идентификатором из 36 дефисов — 400, не 500', async () => {
    const vendorId = await newVendor(await newUser())
    const reader = await newUser()
    const forged = encodeCursor('2026-09-11T00:00:00.000Z', DASHES)
    const res = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendorId}/reviews?cursor=${forged}`,
      headers: auth(reader),
    })
    expect(res.statusCode).toBe(400)
  })
})
