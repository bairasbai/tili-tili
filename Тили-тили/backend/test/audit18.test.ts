import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Регрессии аудита 2026-09-07, блок 5 (инвентаризация кнопок).
 *
 * Контракт v0.24 принимал еду и трансфер в RSVP и телефон гостя, но фронт
 * их не спрашивал, а страница гостя не отдавала обратно. Здесь — серверная
 * половина: ответ гостя возвращается ему целиком (v0.25), «без ограничений»
 * после «веган» действительно снимает ограничение, телефон гостя пишется и
 * стирается.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('блок 5: RSVP гостя целиком и телефон гостя', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона. В дев-базе десятки тысяч тестовых номеров
   * `+79RRRRRRNNN` от прежних прогонов, и случайный RUN раз в несколько
   * сотен прогонов совпадает с уже занятым — «у вас уже есть свадьба» на
   * свежем номере. Поэтому префикс перебирается до свободного (R-259). */
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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id, phone }
  }
  async function newWedding(token: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', date: '2027-11-06', city: { name: 'Казань', region: 'Татарстан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }
  async function guestWithToken(couple: { token: string }, weddingId: string, payload: Record<string, unknown>) {
    const guest = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests`, headers: auth(couple.token), payload })
    expect(guest.statusCode).toBe(201)
    const link = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests/${guest.json().id as string}/invite-link`, headers: auth(couple.token) })
    const code = (link.json().url as string).split('/').pop()!
    const token = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string
    return { guestId: guest.json().id as string, token }
  }

  it('страница гостя отдаёт его ответ целиком: +1, еда, трансфер', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const { token } = await guestWithToken(couple, weddingId, { name: 'Марина' })

    const sent = await app.inject({
      method: 'POST',
      url: `/rsvp/${encodeURIComponent(token)}`,
      payload: { status: 'yes', plusOne: true, diet: 'vegan', transfer: 'need' },
    })
    expect(sent.statusCode).toBe(200)

    const page = (await app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(token)}` })).json() as Record<string, unknown>
    expect(page.status).toBe('yes')
    expect(page.plusOne).toBe(true)
    expect(page.diet).toBe('vegan')
    expect(page.transfer).toBe('need')
  })

  it('«без ограничений» после «веган» снимает ограничение, а не оставляет старое', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const { token, guestId } = await guestWithToken(couple, weddingId, { name: 'Олег' })
    const url = `/rsvp/${encodeURIComponent(token)}`

    await app.inject({ method: 'POST', url, payload: { status: 'yes', diet: 'other', dietNote: 'орехи' } })
    /* Раньше `coalesce($5, diet)` читал присланный null как «не трогать». */
    const again = await app.inject({ method: 'POST', url, payload: { status: 'yes', diet: null } })
    expect(again.statusCode).toBe(200)

    const page = (await app.inject({ method: 'GET', url })).json() as Record<string, unknown>
    expect(page.diet).toBeNull()
    expect(page.dietNote).toBeNull()
    /* Пара в своём списке видит то же самое. */
    const list = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/guests`, headers: auth(couple.token) })).json() as { id: string; diet: string | null; dietNote: string | null }[]
    const mine = list.find((g) => g.id === guestId)!
    expect(mine.diet).toBeNull()
    expect(mine.dietNote).toBeNull()
  })

  it('отельный блок удаляется — единственный путь записи, у которого не было прямого теста', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/logistics/hotels`,
      headers: auth(couple.token),
      payload: { name: 'Отель у реки', rooms: 5 },
    })
    expect(created.statusCode).toBe(201)
    const hotelId = created.json().id as string

    const removed = await app.inject({ method: 'DELETE', url: `/weddings/${weddingId}/logistics/hotels/${hotelId}`, headers: auth(couple.token) })
    expect(removed.statusCode).toBe(204)
    const list = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/logistics/hotels`, headers: auth(couple.token) })).json() as { id: string }[]
    expect(list.some((h) => h.id === hotelId)).toBe(false)
    // Повтор — 404, а не молчаливое «удалили ещё раз».
    const again = await app.inject({ method: 'DELETE', url: `/weddings/${weddingId}/logistics/hotels/${hotelId}`, headers: auth(couple.token) })
    expect(again.statusCode).toBe(404)
  })

  it('телефон гостя: пишется при создании, правится и стирается парой', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const created = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests`, headers: auth(couple.token), payload: { name: 'Ирина', phone: '+79170001122' } })
    expect(created.statusCode).toBe(201)
    expect(created.json().phone).toBe('+79170001122')
    const guestId = created.json().id as string

    const patched = await app.inject({ method: 'PATCH', url: `/weddings/${weddingId}/guests/${guestId}`, headers: auth(couple.token), payload: { phone: '+79170003344' } })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().phone).toBe('+79170003344')

    const cleared = await app.inject({ method: 'PATCH', url: `/weddings/${weddingId}/guests/${guestId}`, headers: auth(couple.token), payload: { phone: null } })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().phone).toBeNull()
  })
})
