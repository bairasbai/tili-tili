/*
 * Живой обход ролей и кнопок (2026-09-19) — бэкенд.
 *
 * Т1  чат с подрядчиком открывает пара. Помощнику и координатору — 403 с причиной,
 *     а не «Сначала заведите свадьбу»: свадьба у них есть, нет права. Без свадьбы — 404, как было.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('обход ролей: чат с подрядчиком по ролям', () => {
  let app: FastifyInstance
  let counter = 0
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp(
      {
        env: 'test',
        databaseUrl: DB ?? null,
        redisUrl: null,
        corsOrigins: [],
        jwtAccessSecret: SECRET_A,
        jwtRefreshSecret: SECRET_R,
        policyVersion: '2026-09-02',
        otpMaxPerHourTotal: 1_000_000,
        otpMaxPerIpHour: 1_000_000,
      },
      [],
    )
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
    expect(v.statusCode, v.body.slice(0, 200)).toBe(200)
    const token = (v.json() as { accessToken: string }).accessToken
    const c = await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(token), payload: { policyVersion: '2026-09-02', adult: true } })
    expect(c.statusCode, c.body.slice(0, 200)).toBe(201)
    return { token }
  }

  async function vendorOf(categoryId: string) {
    const owner = await newUser()
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Студия ${RUN}-${++counter}`, categoryId, city: { name: 'Уфа', region: 'Башкортостан' }, priceFrom: { amount: 4_000_000, currency: 'RUB' }, mediaRights: true },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })).statusCode).toBe(200)
    return (put.json() as { id: string }).id
  }

  it('Т1: пара открывает чат; помощник и координатор — 403 с причиной; без свадьбы — 404', async () => {
    const couple = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(couple.token),
      payload: { partnerName: 'Тимур', city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    const weddingId = (w.json() as { id: string }).id
    const vendorId = await vendorOf('photo')

    const members: Record<string, string> = {}
    for (const role of ['helper', 'coordinator'] as const) {
      const member = await newUser()
      const inv = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/invites`, headers: auth(couple.token), payload: { role } })
      expect(inv.statusCode, inv.body.slice(0, 200)).toBe(201)
      const acc = await app.inject({ method: 'POST', url: `/invites/${(inv.json() as { code: string }).code}/accept`, headers: auth(member.token) })
      expect(acc.statusCode, acc.body.slice(0, 200)).toBe(200)
      members[role] = member.token
    }

    for (const role of ['helper', 'coordinator'] as const) {
      const res = await app.inject({ method: 'POST', url: `/chats/vendor/${vendorId}`, headers: auth(members[role]!) })
      expect(res.statusCode, `${role}: ${res.body.slice(0, 200)}`).toBe(403)
      expect((res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: 'forbidden' })
      expect((res.json() as { error: { message: string } }).error.message).toContain('ведёт пара')
    }

    const outsider = await newUser()
    const none = await app.inject({ method: 'POST', url: `/chats/vendor/${vendorId}`, headers: auth(outsider.token) })
    expect(none.statusCode, none.body.slice(0, 200)).toBe(404)
    expect((none.json() as { error: { message: string } }).error.message).toBe('Сначала заведите свадьбу')

    const mine = await app.inject({ method: 'POST', url: `/chats/vendor/${vendorId}`, headers: auth(couple.token) })
    expect(mine.statusCode, mine.body.slice(0, 200)).toBe(200)
  })
})
