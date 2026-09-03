import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Вторая перепроверка этапа 4: проход по составу этапа построчно, а не по
 * критериям «Готово, когда». Каждая проверка — из вопроса «а что если».
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('перепроверка этапа 4, второй проход', () => {
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

  async function newWedding(date: string | null = '2027-06-14') {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        ...(date ? { date } : {}),
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  async function newVendor(categoryId = 'photo') {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: { name: `П ${RUN}-${counter}`, categoryId, city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  const slotsOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
      deal: { id: string; state: string } | null
    }[]

  const budgetOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/budget`, headers: auth(token) })).json() as {
      spent: { amount: number }
    }

  const book = (w: { token: string; weddingId: string }, slotId: string, vendorId: string, amount: number) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId, price: { amount, currency: 'RUB' } },
    })

  /* ── один подрядчик на два слота одной свадьбы ────────────────────── */
  it('один подрядчик может занять два слота одной свадьбы', async () => {
    // Фотограф, который снимает и видео. Дата уже занята ЭТОЙ ЖЕ свадьбой —
    // отказывать во втором слоте бессмысленно, он и так занят ими.
    const vendor = await newVendor('photo')
    const w = await newWedding()
    const slots = await slotsOf(w.token, w.weddingId)
    const photo = slots.find((s) => s.categoryId === 'photo')!
    const video = slots.find((s) => s.categoryId === 'video')!

    expect((await book(w, photo.id, vendor.vendorId, 8_500_000)).statusCode).toBe(200)
    const second = await book(w, video.id, vendor.vendorId, 5_000_000)
    expect(second.statusCode).toBe(200)

    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(13_500_000)
  })

  it('отмена одного из двух слотов не освобождает дату у второго', async () => {
    const vendor = await newVendor('photo')
    const w = await newWedding()
    const slots = await slotsOf(w.token, w.weddingId)
    const photo = slots.find((s) => s.categoryId === 'photo')!
    const video = slots.find((s) => s.categoryId === 'video')!
    await book(w, photo.id, vendor.vendorId, 8_500_000)
    await book(w, video.id, vendor.vendorId, 5_000_000)

    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${photo.id}/cancel`,
      headers: idem(w.token),
    })

    // Второй слот всё ещё держит подрядчика: дата обязана остаться занятой,
    // иначе его заберёт другая пара, а он занят.
    const { rows } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1',
      [vendor.vendorId],
    )
    expect(rows[0]!.n).toBe(1)
  })

  /* ── идемпотентность строго по контракту ──────────────────────────── */
  it('договор оформляется без Idempotency-Key — контракт его не требует', async () => {
    const vendor = await newVendor('venue')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'venue')!
    await book(w, slot.id, vendor.vendorId, 20_000_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    // Клиент, написанный строго по контракту, заголовка не пришлёт.
    // Отвечать ему 400 — значит требовать больше, чем обещали.
    const res = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: auth(w.token),
      payload: {
        templateCode: 'venue',
        fields: { customerFullName: 'Алина Иванова', performerFullName: 'Пётр Петров' },
      },
    })
    expect(res.statusCode).toBe(201)
  })

  it('свой подрядчик добавляется без Idempotency-Key', async () => {
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId))[0]!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Свой мастер', price: { amount: 1_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
  })

  /* ── переход в booked через PATCH ─────────────────────────────────── */
  it('перевод сделки в booked через PATCH захватывает дату', async () => {
    const vendor = await newVendor('host')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'host')!
    await book(w, slot.id, vendor.vendorId, 6_000_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    // Отменяем и заводим заново через свой путь, чтобы начать не с booked.
    await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: idem(w.token),
      payload: { state: 'cancelled' },
    })
    const { rows: freed } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1',
      [vendor.vendorId],
    )
    // Отмена через PATCH обязана освободить дату так же, как отмена слота.
    expect(freed[0]!.n).toBe(0)

    const again = await book(w, slot.id, vendor.vendorId, 6_000_000)
    expect(again.statusCode).toBe(200)
    const { rows: taken } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1',
      [vendor.vendorId],
    )
    expect(taken[0]!.n).toBe(1)
  })

  it('перевод в booked, когда дата занята чужой свадьбой, — 409', async () => {
    const vendor = await newVendor('dj')
    const date = `2027-12-${String(randomInt(10, 28)).padStart(2, '0')}`
    const a = await newWedding(date)
    const b = await newWedding(date)
    const slotA = (await slotsOf(a.token, a.weddingId)).find((s) => s.categoryId === 'dj')!
    const slotB = (await slotsOf(b.token, b.weddingId)).find((s) => s.categoryId === 'dj')!

    expect((await book(a, slotA.id, vendor.vendorId, 3_000_000)).statusCode).toBe(200)

    // Вторая пара заводит сделку своим подрядчиком — путь без каталога,
    // потом пытается перевести в booked. Дата уже чужая.
    const external = await app.inject({
      method: 'POST',
      url: `/weddings/${b.weddingId}/slots/${slotB.id}/external`,
      headers: auth(b.token),
      payload: { vendorName: 'Тот же', price: { amount: 3_000_000, currency: 'RUB' } },
    })
    expect(external.statusCode).toBe(200)
    // Подменяем на каталожного, как если бы пара выбрала его из каталога.
    const dealB = external.json().deal.id as string
    await app.db!.query("update deals set vendor_id = $2, external_name = null, state = 'negotiating' where id = $1", [
      dealB,
      vendor.vendorId,
    ])

    const res = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealB}`,
      headers: idem(b.token),
      payload: { state: 'booked' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('date_taken')
  })

  /* ── свадьба без даты ─────────────────────────────────────────────── */
  it('бронь в свадьбе без даты проходит и никого не занимает', async () => {
    const vendor = await newVendor('cake')
    const w = await newWedding(null)
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    expect((await book(w, slot.id, vendor.vendorId, 1_500_000)).statusCode).toBe(200)

    const { rows } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1',
      [vendor.vendorId],
    )
    expect(rows[0]!.n).toBe(0)
    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(1_500_000)
  })

  /* ── деньги ───────────────────────────────────────────────────────── */
  it('сделка без цены не принимает бесконечных оплат', async () => {
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId))[0]!
    const external = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Без цены', price: { amount: 0, currency: 'RUB' } },
    })
    expect(external.statusCode).toBe(200)
    await app.db!.query('update deals set price = null where slot_id = $1', [slot.id])

    const first = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/pay`,
      headers: idem(w.token),
      payload: { amount: { amount: 1_000_000, currency: 'RUB' } },
    })
    // Цены нет — платить нечего: сумма без договорённости это просто число.
    expect(first.statusCode).toBe(409)
    expect(first.json().error.code).toBe('no_price')
  })

  it('состояния candidate и contacted не входят в «потрачено»', async () => {
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId))[0]!
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Кандидат', price: { amount: 4_000_000, currency: 'RUB' } },
    })
    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(4_000_000)

    // Пара ещё только присматривается — деньги не обещаны.
    await app.db!.query("update deals set state = 'candidate', booked_at = null where slot_id = $1", [slot.id])
    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(0)
  })

  /* ── журнал сделки ────────────────────────────────────────────────── */
  it('каждый переход попадает в журнал сделки', async () => {
    const vendor = await newVendor('florist')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'florist')!
    await book(w, slot.id, vendor.vendorId, 4_500_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: idem(w.token),
      payload: { state: 'paid_deposit', note: 'внесли аванс' },
    })
    const { rows } = await app.db!.query<{ from_state: string | null; to_state: string; note: string | null }>(
      'select from_state, to_state, note from deal_events where deal_id = $1 order by at',
      [dealId],
    )
    expect(rows.map((r) => r.to_state)).toEqual(['booked', 'paid_deposit'])
    expect(rows[1]!.note).toBe('внесли аванс')
  })
})
