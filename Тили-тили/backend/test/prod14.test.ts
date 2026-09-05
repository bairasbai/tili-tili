import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { plural } from '../src/text/plural.js'

/**
 * Кабинет подрядчика: что он видит о своей занятости и что читает у пары.
 *
 * Перепроверка этапа 9 нашла две вещи. День, закрытый сделкой, кабинет
 * предлагал открыть: сервер отвечал 204 и ничего не менял, а тап выглядел
 * потерянным — теперь у дня есть `source`, и такой день на экране заблокирован.
 * И обновление о рассадке приходило со строкой «за столами 1 гостей»: подрядчик
 * читает её как поломку данных, а не как оговорку.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('склонение в строках сервера', () => {
  it('число и слово согласованы', () => {
    expect(`1 ${plural(1, 'гость', 'гостя', 'гостей')}`).toBe('1 гость')
    expect(`2 ${plural(2, 'гость', 'гостя', 'гостей')}`).toBe('2 гостя')
    expect(`5 ${plural(5, 'гость', 'гостя', 'гостей')}`).toBe('5 гостей')
    // Одиннадцать — не «один»: правило ловит именно этот случай.
    expect(`11 ${plural(11, 'гость', 'гостя', 'гостей')}`).toBe('11 гостей')
    expect(`21 ${plural(21, 'гость', 'гостя', 'гостей')}`).toBe('21 гость')
    expect(`22 ${plural(22, 'гость', 'гостя', 'гостей')}`).toBe('22 гостя')
  })
})

describe.skipIf(!live)('прод: календарь подрядчика и обновления от пар', () => {
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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const key = () => ({ 'idempotency-key': `k14-${RUN}-${++counter}` })

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
    return { token }
  }

  async function newWedding() {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' } },
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
        name: `Студия ${RUN}-${counter}`,
        categoryId: 'florist',
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(res.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  async function book(w: { token: string; weddingId: string }, vendorId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'florist') ?? slots[0]!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 3_500_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    return slot.id
  }

  const calendar = async (token: string, month: string) =>
    (await app.inject({ method: 'GET', url: `/vendor/calendar?month=${month}`, headers: auth(token) })).json() as {
      date: string
      status: string
      source?: string | null
    }[]

  /* ── занятость: своя и от сделки ──────────────────────────────────── */
  it('день сделки помечен источником и не снимается, свой — снимается', async () => {
    const vendor = await newVendor()
    const w = await newWedding()
    await book(w, vendor.vendorId)

    await app.inject({
      method: 'POST',
      url: '/vendor/calendar/busy',
      headers: auth(vendor.token),
      payload: { dates: ['2027-06-20'], status: 'busy' },
    })

    const before = await calendar(vendor.token, '2027-06')
    expect(before).toEqual(
      expect.arrayContaining([
        { date: '2027-06-14', status: 'busy', source: 'deal' },
        { date: '2027-06-20', status: 'busy', source: 'manual' },
      ]),
    )

    // Снимаем оба дня одним запросом: свой уходит, день сделки остаётся.
    const freed = await app.inject({
      method: 'POST',
      url: '/vendor/calendar/busy',
      headers: auth(vendor.token),
      payload: { dates: ['2027-06-14', '2027-06-20'], status: 'free' },
    })
    expect(freed.statusCode).toBe(204)

    const after = await calendar(vendor.token, '2027-06')
    expect(after.map((d) => d.date)).toEqual(['2027-06-14'])
    expect(after[0]!.source).toBe('deal')
  })

  it('закрытый день убирает подрядчика из выдачи на эту дату', async () => {
    const vendor = await newVendor()
    const reader = await newUser()
    /* Ищем по имени, а не листаем выдачу: в общей базе сотня опубликованных
       флористов от прошлых прогонов, и место в списке зависит от рейтинга. */
    const name = encodeURIComponent(`Студия ${RUN}`)
    await app.inject({
      method: 'POST',
      url: '/vendor/calendar/busy',
      headers: auth(vendor.token),
      payload: { dates: ['2027-08-08'], status: 'busy' },
    })

    const free = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?q=${name}&date=2027-08-09&limit=100`,
      headers: auth(reader.token),
    })
    const busy = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?q=${name}&date=2027-08-08&limit=100`,
      headers: auth(reader.token),
    })
    const ids = (r: typeof free) => (r.json().items as { id: string }[]).map((v) => v.id)
    expect(ids(free)).toContain(vendor.vendorId)
    expect(ids(busy)).not.toContain(vendor.vendorId)
  })

  /* ── правка анкеты не должна стирать то, чем она не занимается ────── */
  it('сохранение анкеты без портфолио оставляет портфолио на месте', async () => {
    const vendor = await newVendor()
    // Заводим портфолио и пакет так, как это сделает экран загрузки после S3.
    const withMedia = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendor.token),
      payload: {
        name: `Студия ${RUN}-media`,
        categoryId: 'florist',
        city: { name: 'Уфа', region: 'Башкортостан' },
        portfolioUrls: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'],
        packages: [{ name: 'Букет невесты', price: { amount: 1_500_000, currency: 'RUB' } }],
      },
    })
    expect(withMedia.statusCode).toBe(200)
    expect(withMedia.json().gallery).toHaveLength(2)

    /* Мастер анкеты портфолио не редактирует и полей о нём не шлёт. Раньше это
       означало «стереть»: одно сохранение имени уносило все работы. */
    const renamed = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendor.token),
      payload: {
        name: `Студия ${RUN}-переименована`,
        categoryId: 'florist',
        city: { name: 'Уфа', region: 'Башкортостан' },
        packages: [{ name: 'Букет невесты', price: { amount: 1_500_000, currency: 'RUB' } }],
      },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().name).toContain('переименована')
    expect(renamed.json().gallery).toHaveLength(2)
    expect(renamed.json().packages).toHaveLength(1)

    // Пустой список — это «очисти»: удалённый последний пакет должен уйти.
    const cleared = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendor.token),
      payload: {
        name: `Студия ${RUN}-переименована`,
        categoryId: 'florist',
        city: { name: 'Уфа', region: 'Башкортостан' },
        packages: [],
      },
    })
    expect(cleared.json().packages).toEqual([])
    expect(cleared.json().gallery).toHaveLength(2)
  })

  /* ── обновления от пар ────────────────────────────────────────────── */
  it('обновление о рассадке приходит подрядчику и согласовано по числу', async () => {
    const vendor = await newVendor()
    const w = await newWedding()
    await book(w, vendor.vendorId)

    const guest = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Ирина' },
    })
    const table = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name: 'Стол 1', capacity: 10 },
    })
    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/guests/${guest.json().id}`,
      headers: auth(w.token),
      payload: { tableId: table.json().id },
    })

    const updates = await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })
    expect(updates.statusCode).toBe(200)
    const seating = (updates.json() as { kind: string; text: string; id: string; ackAt: string | null }[]).find(
      (u) => u.kind === 'seating',
    )
    expect(seating).toBeDefined()
    // «за столами 1 гостей» читается как поломка данных.
    expect(seating!.text).toContain('1 гость')
    expect(seating!.ackAt).toBeNull()

    const ack = await app.inject({
      method: 'POST',
      url: `/vendor/updates/${seating!.id}/ack`,
      headers: auth(vendor.token),
    })
    expect(ack.statusCode).toBe(204)
    const after = (await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })).json() as {
      id: string
      ackAt: string | null
    }[]
    expect(after.find((u) => u.id === seating!.id)!.ackAt).not.toBeNull()
  })
})
