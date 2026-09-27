/**
 * Разведка 019 (ERR-0317): две одновременные брони одного места.
 *
 * Бронь вставляла сделку раньше, чем захватывала слот: внешний ключ ставил на строку
 * слота KEY SHARE, а `update slots set deal_id` требует FOR UPDATE — обе брони ждали
 * друг друга, одна падала «deadlock detected», пара получала 500 вместо 409. На этой
 * машине — 14 пар из 40; одиночный тест audit4 проходил в двух случаях из трёх.
 * Здесь двадцать повторов: вероятность ни разу не поймать дефект при 35 % — 0,65^20 ≈ 0,02 %.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Перепроверка после этапа 4 — всей работы.
 * Вопросы прежние: кто что видит в теле, что при двух одновременных запросах,
 * сколько строк через месяц, что вернётся с чистого устройства, что копится,
 * какое поле принимается на веру, что стоит денег.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('разведка 019: бронь места без взаимной блокировки (ERR-0317)', () => {
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
  const idem = (token: string) => ({ ...auth(token), 'idempotency-key': randomUUID() })

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

  async function newWedding(date = '2027-06-14') {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    return { ...user, weddingId: res.json().id as string }
  }

  async function newVendor(categoryId = 'photo') {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Подрядчик ${RUN}-${counter}`,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  const slotsOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
      deal: { id: string } | null
    }[]


  const book = (w: { token: string; weddingId: string }, slotId: string, vendorId: string, packageId?: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId, price: { amount: 1_000_000, currency: 'RUB' }, ...(packageId ? { packageId } : {}) },
    })
  const external = (w: { token: string; weddingId: string }, slotId: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Свой кондитер', price: { amount: 900_000, currency: 'RUB' } },
    })
  const liveDeals = async (slotId: string) =>
    (await app.db!.query<{ n: number }>("select count(*)::int as n from deals where slot_id = $1 and state <> 'cancelled'", [slotId]))
      .rows[0]!.n

  it('двадцать раз по две одновременные брони одного места — 200 и 409, ни одного 500', async () => {
    const vendorA = await newVendor('cake')
    const vendorB = await newVendor('cake')
    const seen: string[] = []
    for (let i = 0; i < 20; i++) {
      // Своя свадьба на каждый повтор и своя дата: даты подрядчиков не мешают друг другу.
      const w = await newWedding(`2028-0${1 + (i % 9)}-${String(10 + Math.floor(i / 9)).padStart(2, '0')}`)
      const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
      const [a, b] = await Promise.all([book(w, slot.id, vendorA.vendorId), book(w, slot.id, vendorB.vendorId)])
      seen.push([a.statusCode, b.statusCode].sort().join('/'))
      expect(await liveDeals(slot.id)).toBe(1)
    }
    expect(seen).toEqual(Array(20).fill('200/409'))
  }, 120_000)

  it('двадцать раз по два одновременных «свой подрядчик» в одно место — 200 и 409, ни одного 500', async () => {
    const seen: string[] = []
    for (let i = 0; i < 20; i++) {
      const w = await newWedding()
      const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
      const [a, b] = await Promise.all([external(w, slot.id), external(w, slot.id)])
      seen.push([a.statusCode, b.statusCode].sort().join('/'))
      expect(await liveDeals(slot.id)).toBe(1)
    }
    expect(seen).toEqual(Array(20).fill('200/409'))
  }, 120_000)

  it('пакет удаляют, пока бронь по нему в пути, — 422 unknown_package, а не 500', async () => {
    const vendor = await newVendor('cake')
    const saved = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendor.token),
      payload: { name: `Кондитер ${RUN}`, categoryId: 'cake', city: { name: 'Уфа', region: 'Башкортостан' },
        packages: [{ name: 'Торт на 50 гостей', price: { amount: 2_000_000, currency: 'RUB' } }] },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const { rows: [pkg] } = await app.db!.query<{ id: string }>('select id from vendor_packages where vendor_id = $1', [vendor.vendorId])
    const w = await newWedding('2030-05-05')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    let blocked = false
    let pending!: Promise<{ statusCode: number; json: () => { error?: { code?: string } } }>
    await app.db!.tx(async (client) => {
      // «Сохранение анкеты» удаляет пакет и ещё не зафиксировано.
      await client.query('delete from vendor_packages where id = $1', [pkg!.id])
      const { rows: [me] } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      pending = book(w, slot.id, vendor.vendorId, pkg!.id)
      for (let waited = 0; waited < 5000 && !blocked; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await client.query('select pg_stat_clear_snapshot()')
        const { rows } = await client.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [me!.pid])
        blocked = rows[0]!.n > 0
      }
    })
    const res = await pending
    // До фикса бронь не ждала пакет: читала его живым, а внешний ключ сделки падал после коммита удаления — 500.
    expect(blocked, 'бронь не ждала пакет под замком').toBe(true)
    expect(res.statusCode).toBe(422)
    expect(res.json().error?.code).toBe('unknown_package')
    expect(await liveDeals(slot.id)).toBe(0)
  }, 60_000)
})
