/*
 * Фича 007 «Кабинет подрядчика: чаты, настройки, анкета глазами пары» — бэкенд.
 *
 * Два малых правила под экраны кабинета:
 *  — владелец видит свою анкету через каталожный путь и до публикации (превью
 *    «глазами пары»), чужой черновик — 404, как и раньше;
 *  — заявка несёт `chatId` — тот же чат, что открыло «Написать» пары, чтобы
 *    кабинет вёл из заявки прямо в переписку.
 * Красные без фикса: `catalog.ts` отвечал 404 владельцу неопубликованной,
 * `toLead` поля `chatId` не знал.
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

describe.skipIf(!live)('фича 007: анкета глазами пары и чат заявки', () => {
  let app: FastifyInstance
  let counter = 0
  const RUN = String(randomInt(100_000, 1_000_000))
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
  })

  afterAll(async () => {
    await app?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

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
    return { token: body.accessToken, userId: body.user.id }
  }

  async function newVendor(publish: boolean) {
    const user = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Фото ${RUN}-${++counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    if (publish) {
      const p = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
      expect(p.statusCode, p.body.slice(0, 200)).toBe(200)
    }
    return { ...user, vendorId: created.json().id as string }
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
    return { ...user, weddingId: w.json().id as string }
  }

  it('владелец видит свою НЕопубликованную анкету глазами пары — с published: false; чужой получает 404', async () => {
    const vendor = await newVendor(false)
    const own = await app.inject({ method: 'GET', url: `/catalog/vendors/${vendor.vendorId}`, headers: auth(vendor.token) })
    expect(own.statusCode, 'владелец не видит свой черновик через каталожный путь: ' + own.body.slice(0, 160)).toBe(200)
    expect(own.json()).toMatchObject({ id: vendor.vendorId, published: false, blocked: false })

    // Чужой — по адресу нельзя узнать, существует ли черновик.
    const stranger = await newUser()
    const other = await app.inject({ method: 'GET', url: `/catalog/vendors/${vendor.vendorId}`, headers: auth(stranger.token) })
    expect(other.statusCode).toBe(404)

    // Свой просмотр в воронку не идёт (D5-13).
    const { rows } = await app.db!.query<{ views: number }>('select views from vendors where id = $1', [vendor.vendorId])
    expect(rows[0]!.views).toBe(0)
  })

  it('опубликованная анкета владельцу — как раньше, без лишних отказов', async () => {
    const vendor = await newVendor(true)
    const own = await app.inject({ method: 'GET', url: `/catalog/vendors/${vendor.vendorId}`, headers: auth(vendor.token) })
    expect(own.statusCode, own.body.slice(0, 160)).toBe(200)
    expect(own.json().id).toBe(vendor.vendorId)
  })

  it('заявка несёт chatId — тот же чат, что открыло «Написать» пары', async () => {
    const vendor = await newVendor(true)
    const couple = await newWedding()
    const chat = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(couple.token) })
    expect(chat.statusCode, chat.body.slice(0, 200)).toBe(200)
    const chatId = chat.json().id as string
    const sent = await app.inject({ method: 'POST', url: `/chats/${chatId}/messages`, headers: auth(couple.token), payload: { text: 'Свободны 14 июня?' } })
    expect(sent.statusCode, sent.body.slice(0, 200)).toBe(201)

    const leads = await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })
    expect(leads.statusCode, leads.body.slice(0, 200)).toBe(200)
    const lead = (leads.json() as { id: string; chatId?: string | null }[])[0]
    expect(lead, 'заявки после «Написать» нет').toBeTruthy()
    expect(lead!.chatId, 'кабинет не знает, в какой чат вести из заявки').toBe(chatId)

    // Ответ на заявку возвращает ту же заявку с тем же чатом.
    const replied = await app.inject({ method: 'POST', url: `/vendor/leads/${lead!.id}`, headers: auth(vendor.token), payload: { action: 'reply', text: 'Свободны, 45 000 ₽' } })
    expect(replied.statusCode, replied.body.slice(0, 200)).toBe(200)
    expect(replied.json().chatId).toBe(chatId)
  })
})
