import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Две регрессии аудита, которым нужна живая база.
 *
 * Остальное закрыто в `audit13.test.ts` без базы — там хватает чистых функций
 * и схем. Эти две проверяют то, что живёт целиком в SQL: границу свадьбы
 * в опросе меню (ERR-0105) и лимит холодных обращений (ERR-0100). Держать их
 * «известным пробелом» было нельзя: обе про поведение, которое ломается тихо.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('регрессии аудита, требующие базы', () => {
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
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const { accessToken, user } = v.json()
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: accessToken as string, id: user.id as string }
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

  async function newVendor() {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Подрядчик ${RUN}-${++counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(res.statusCode).toBeLessThan(300)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  /** Опрос меню с одним блюдом. Возвращает его идентификатор. */
  async function newMenuOption(w: { token: string; weddingId: string }, name: string) {
    const res = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
      payload: { options: [{ name }] },
    })
    expect(res.statusCode).toBeLessThan(300)
    return res.json().options[0].id as string
  }

  const menuOptions = async (w: { token: string; weddingId: string }) =>
    (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/menu-poll`, headers: auth(w.token) })).json()
      .options as { id: string; name: string }[]

  describe('границы свадьбы в опросе меню (ERR-0105)', () => {
    it('чужое блюдо не переписывается идентификатором из другой свадьбы', async () => {
      const mine = await newWedding()
      const theirs = await newWedding()
      const theirOption = await newMenuOption(theirs, 'Рыба')

      /* До фикса запрос шёл `update menu_options set … where id = $1` — без
       * условия по свадьбе, и это переписывало блюдо в ЧУЖОЙ свадьбе. */
      const res = await app.inject({
        method: 'PUT',
        url: `/weddings/${mine.weddingId}/menu-poll`,
        headers: auth(mine.token),
        payload: { options: [{ id: theirOption, name: 'ВЗЛОМАНО' }] },
      })
      expect(res.statusCode).toBe(404)

      // Главное: у чужой свадьбы ничего не изменилось.
      const after = await menuOptions(theirs)
      expect(after).toHaveLength(1)
      expect(after[0]!.name).toBe('Рыба')
    })

    it('своё блюдо правится по-прежнему', async () => {
      // Иначе условие могло бы отсекать всё подряд, и тест выше проходил бы
      // по неверной причине.
      const mine = await newWedding()
      const id = await newMenuOption(mine, 'Курица')
      const res = await app.inject({
        method: 'PUT',
        url: `/weddings/${mine.weddingId}/menu-poll`,
        headers: auth(mine.token),
        payload: { options: [{ id, name: 'Утка' }] },
      })
      expect(res.statusCode).toBeLessThan(300)
      expect((await menuOptions(mine))[0]!.name).toBe('Утка')
    })
  })

  describe('лимит холодных обращений подрядчика (ERR-0100)', () => {
    /** Пара открывает чат с подрядчиком и получает его идентификатор. */
    async function openChat(couple: { token: string }, vendorId: string) {
      const res = await app.inject({
        method: 'POST',
        url: `/chats/vendor/${vendorId}`,
        headers: auth(couple.token),
      })
      expect(res.statusCode).toBeLessThan(300)
      return res.json().id as string
    }

    const send = (token: string, chatId: string, text: string) =>
      app.inject({ method: 'POST', url: `/chats/${chatId}/messages`, headers: auth(token), payload: { text } })

    it('ответы на входящие лимит не расходуют', async () => {
      const vendor = await newVendor()
      const limit = app.appConfig.coldOutreachPerDay

      /* Подрядчик без галочки «Проверен». Ему пишут limit пар, он всем
       * отвечает. До фикса лимит считал все чаты, где он писал, — и на
       * следующей паре он получал 429, не начав ни одной переписки. */
      for (let i = 0; i < limit; i++) {
        const couple = await newWedding()
        const chatId = await openChat(couple, vendor.vendorId)
        expect((await send(couple.token, chatId, `Здравствуйте, вопрос ${i}`)).statusCode).toBe(201)
        expect((await send(vendor.token, chatId, 'Здравствуйте, отвечаю')).statusCode).toBe(201)
      }

      const next = await newWedding()
      const chatId = await openChat(next, vendor.vendorId)
      expect((await send(next.token, chatId, 'Здравствуйте, а вы свободны?')).statusCode).toBe(201)
      // Это ответ клиенту, а не рассылка: лимит его знать не должен.
      expect((await send(vendor.token, chatId, 'Свободен, рассказывайте')).statusCode).toBe(201)
    })

    it('переписки, начатые самим подрядчиком, лимитом закрываются', async () => {
      // Обратная сторона: фикс не должен был выключить защиту. Пара открывает
      // чат и НЕ пишет — первое сообщение подрядчика и есть холодное обращение.
      const vendor = await newVendor()
      const limit = app.appConfig.coldOutreachPerDay

      for (let i = 0; i < limit; i++) {
        const couple = await newWedding()
        const chatId = await openChat(couple, vendor.vendorId)
        expect((await send(vendor.token, chatId, `Здравствуйте, предлагаю услуги ${i}`)).statusCode).toBe(201)
      }

      const couple = await newWedding()
      const chatId = await openChat(couple, vendor.vendorId)
      const blocked = await send(vendor.token, chatId, 'Здравствуйте, предлагаю услуги')
      expect(blocked.statusCode).toBe(429)
      expect(blocked.json().error.code).toBe('cold_outreach_limit')
    })
  })
})
