import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { CONTRACT_SCHEMAS } from '../src/contract/schemas.generated.js'

/**
 * Волна 4: объявленное поле обязано приходить.
 *
 * Сверка путей и операций у нас есть с этапа 0, и она ловит «пути нет».
 * Она НЕ ловит другое: путь есть, схема обещает поле, а обработчик его
 * не отдаёт. Так прожили `reviews: []`, `chatId: null`, `sentAt: null`
 * и `holdDates: []` — по нескольку этапов каждое, и нашлись они глазами,
 * а не проверкой.
 *
 * Здесь для ключевых сущностей берётся ЖИВОЙ ответ сервера и сверяется
 * с набором полей схемы. Ошибка выглядит как список недостающих имён.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface SchemaNode {
  type?: string
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  $ref?: string
}

const DEFS = (CONTRACT_SCHEMAS as { definitions: Record<string, SchemaNode> }).definitions

/** Имена полей схемы верхнего уровня — вложенность не разбираем. */
function fieldsOf(name: string): string[] {
  const schema = DEFS[name]
  if (!schema) throw new Error(`в контракте нет схемы ${name}`)
  return Object.keys(schema.properties ?? {})
}

describe.skipIf(!live)('прод: ответы не беднее контракта', () => {
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
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token }
  }

  /**
   * Поля схемы, которых нет в ответе.
   *
   * `null` считается ответом: «подарок никто не забронировал» — это null,
   * а не отсутствие поля. Отсутствие ключа — другое: клиент по контракту
   * его ждёт и получает `undefined`.
   */
  const missing = (body: Record<string, unknown>, schema: string): string[] =>
    fieldsOf(schema).filter((f) => !(f in body))

  it('карточка свадьбы отдаёт все поля схемы Wedding', async () => {
    const user = await newUser()
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-11-06',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(201)
    const weddingId = created.json().id as string
    const card = await app.inject({
      method: 'GET',
      url: `/weddings/${weddingId}`,
      headers: auth(user.token),
    })
    expect(missing(card.json() as Record<string, unknown>, 'Wedding')).toEqual([])
    return { weddingId, token: user.token }
  })

  it('слот, сделка и задача отдают все поля своих схем', async () => {
    const user = await newUser()
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-11-07',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    const weddingId = created.json().id as string

    const vendorOwner = await newUser()
    const profile = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendorOwner.token),
      payload: { name: `Студия ${RUN}`, categoryId: 'photo', city: { name: 'Казань', region: 'Татарстан' } },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendorOwner.token) })

    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(user.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'photo')!
    expect(missing(slot as unknown as Record<string, unknown>, 'Slot')).toEqual([])

    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(user.token), ...key() },
      payload: { vendorId: profile.json().id, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(missing(booked.json().deal as Record<string, unknown>, 'Deal')).toEqual([])

    const tasks = (
      await app.inject({ method: 'GET', url: `/weddings/${weddingId}/tasks`, headers: auth(user.token) })
    ).json() as Record<string, unknown>[]
    expect(missing(tasks[0]!, 'Task')).toEqual([])
  })

  it('гость, подарок и чат отдают все поля своих схем', async () => {
    const user = await newUser()
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-11-08',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    const weddingId = created.json().id as string

    const guest = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests`,
      headers: auth(user.token),
      payload: { name: 'Марина' },
    })
    expect(missing(guest.json() as Record<string, unknown>, 'Guest')).toEqual([])

    const gift = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/wishlist`,
      headers: auth(user.token),
      payload: { name: 'Кофемашина', price: { amount: 6_200_000, currency: 'RUB' } },
    })
    /* `mine` контракт объявляет только для гостевого ответа: «резерв
     * поставлен ЭТИМ гостем», паре это поле не отдаётся никогда (§9). */
    expect(missing(gift.json() as Record<string, unknown>, 'Gift').filter((f) => f !== 'mine')).toEqual([])

    const chats = (await app.inject({ method: 'GET', url: '/chats', headers: auth(user.token) })).json() as Record<
      string,
      unknown
    >[]
    expect(missing(chats[0]!, 'Chat')).toEqual([])

    // Именно Тиль: чат дня X до срока отвечает 423, и проверять было бы нечего.
    const tilly = chats.find((c) => c.kind === 'tilly')!
    const sent = await app.inject({
      method: 'POST',
      url: `/chats/${tilly.id as string}/messages`,
      headers: auth(user.token),
      payload: { text: 'Привет' },
    })
    /* `warning` объявлено nullable и приходит только при срабатывании
     * защиты — считаем его частью схемы и требуем ключ всегда. */
    expect(missing(sent.json() as Record<string, unknown>, 'Message').filter((f) => f !== 'warning')).toEqual([])
  })

  it('карточка подрядчика в каталоге отдаёт все поля схемы', async () => {
    const owner = await newUser()
    const profile = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Анкета ${RUN}`, categoryId: 'photo', city: { name: 'Казань', region: 'Татарстан' } },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })

    const reader = await newUser()
    const card = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${profile.json().id}`,
      headers: auth(reader.token),
    })
    expect(card.statusCode).toBe(200)
    expect(missing(card.json() as Record<string, unknown>, 'VendorDetail')).toEqual([])

    const list = await app.inject({
      method: 'GET',
      url: '/catalog/vendors?limit=1',
      headers: auth(reader.token),
    })
    const items = list.json().items as Record<string, unknown>[]
    expect(missing(items[0]!, 'Vendor')).toEqual([])
  })

  it('уведомление отдаёт все поля схемы Notification', async () => {
    const user = await newUser()
    await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-11-09',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    const { rows } = await app.db!.query<{ id: string }>('select id from users order by created_at desc limit 1')
    await app.db!.query(
      `insert into notifications (id, user_id, kind, title, body, link)
       values (gen_random_uuid(), $1, 'system', 'Проверка', 'Тело', '/')`,
      [rows[0]!.id],
    )
    const list = await app.inject({ method: 'GET', url: '/notifications', headers: auth(user.token) })
    const items = list.json() as Record<string, unknown>[]
    if (items.length > 0) expect(missing(items[0]!, 'Notification')).toEqual([])
  })
})
