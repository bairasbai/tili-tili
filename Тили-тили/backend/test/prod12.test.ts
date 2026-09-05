import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Деньги и история сделки — то, чего в ответе не было.
 *
 * В схеме сделки жили цена и состояние, но не сумма платежей: «оплачено
 * 30 000 из 50 000» показать было нечем, и остаток человек держал в голове.
 * События сделки писались в `deal_events` с самого начала и не читались
 * нигде — при споре «мы договаривались на другую сумму» доказательство
 * лежало в базе и никому не показывалось.
 *
 * Обе вещи — деньги, поэтому проверяется и граница доступа: помощник не
 * видит ни цены, ни оплаченного (план §6), посторонний не видит сделки вовсе.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: оплаченное и журнал сделки', () => {
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
  const key = () => ({ 'idempotency-key': `k12-${RUN}-${++counter}` })

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
    const { rows: user } = await app.db!.query<{ id: string }>('select id from users where phone = $1', [phone])
    return { token, userId: user[0]!.id }
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
        name: `Фотостудия ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(res.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  /** Бронь на 50 000 ₽ (в копейках) в слоте фотографа. */
  async function book(w: { token: string; weddingId: string }, vendorId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'photo') ?? slots[0]!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    const { rows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [slot.id])
    return { slotId: slot.id, dealId: rows[0]!.id }
  }

  const slotOf = async (w: { token: string; weddingId: string }, slotId: string) => {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; deal: { price?: { amount: number }; paid?: { amount: number }; paidAt?: string } | null }[]
    return slots.find((s) => s.id === slotId)!
  }

  /* ── сколько уже оплачено ─────────────────────────────────────────── */
  it('оплаченное считается по платежам, а не хранится', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const { slotId } = await book(w, vendor.vendorId)

    const before = await slotOf(w, slotId)
    expect(before.deal!.paid).toEqual({ amount: 0, currency: 'RUB' })
    expect(before.deal!.paidAt).toBeNull()

    const pay = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
      headers: { ...auth(w.token), ...key() },
      payload: { amount: { amount: 2_000_000, currency: 'RUB' } },
    })
    expect(pay.statusCode).toBe(200)

    const after = await slotOf(w, slotId)
    // 20 000 из 50 000 — ровно то, чего на экране показать было нечем.
    expect(after.deal!.paid).toEqual({ amount: 2_000_000, currency: 'RUB' })
    expect(after.deal!.price).toEqual({ amount: 5_000_000, currency: 'RUB' })
    expect(after.deal!.paidAt).not.toBeNull()
  })

  it('возврат вычитается, отменённый платёж не считается', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const { slotId, dealId } = await book(w, vendor.vendorId)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
      headers: { ...auth(w.token), ...key() },
      payload: { amount: { amount: 3_000_000, currency: 'RUB' } },
    })

    await app.db!.query(
      `insert into payments (id, deal_id, kind, amount, currency, status)
       values (gen_random_uuid(), $1, 'refund', 1000000, 'RUB', 'recorded'),
              (gen_random_uuid(), $1, 'deposit', 500000, 'RUB', 'cancelled')`,
      [dealId],
    )

    const after = await slotOf(w, slotId)
    // 30 000 − 10 000 возврата; отменённые 5 000 не считаются вовсе.
    expect(after.deal!.paid).toEqual({ amount: 2_000_000, currency: 'RUB' })
  })

  it('помощник не видит ни цены, ни оплаченного', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const { slotId } = await book(w, vendor.vendorId)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
      headers: { ...auth(w.token), ...key() },
      payload: { amount: { amount: 1_000_000, currency: 'RUB' } },
    })

    const helper = await newUser()
    await app.db!.query('insert into wedding_members (wedding_id, user_id, role) values ($1,$2,$3)', [
      w.weddingId,
      helper.userId,
      'helper',
    ])

    const seen = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(helper.token) })
    ).json() as { id: string; deal: Record<string, unknown> | null }[]
    const slot = seen.find((s) => s.id === slotId)!
    expect(slot.deal).not.toBeNull()
    // Деньги — одна граница: нет цены, значит нет и суммы платежей.
    expect(slot.deal).not.toHaveProperty('price')
    expect(slot.deal).not.toHaveProperty('paid')
    expect(slot.deal).not.toHaveProperty('paidAt')
  })

  /* ── журнал сделки ────────────────────────────────────────────────── */
  it('журнал видят обе стороны сделки, автор назван ролью', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const { slotId, dealId } = await book(w, vendor.vendorId)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
      headers: { ...auth(w.token), ...key() },
      payload: { amount: { amount: 5_000_000, currency: 'RUB' } },
    })

    const mine = await app.inject({ method: 'GET', url: `/deals/${dealId}/events`, headers: auth(w.token) })
    expect(mine.statusCode).toBe(200)
    const events = mine.json() as { toState: string; by: string; kind: string }[]
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.map((e) => e.toState)).toContain('booked')
    expect(events.map((e) => e.toState)).toContain('paid_deposit')
    expect(new Set(events.map((e) => e.by))).toEqual(new Set(['couple']))
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(['state']))

    // Подрядчику журнал нужен ровно там же, где паре: в споре о сумме.
    const theirs = await app.inject({ method: 'GET', url: `/deals/${dealId}/events`, headers: auth(vendor.token) })
    expect(theirs.statusCode).toBe(200)
    expect(theirs.json()).toHaveLength(events.length)
  })

  it('правка цены попадает в журнал отдельным видом события', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const { dealId } = await book(w, vendor.vendorId)

    const patched = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: { ...auth(w.token), ...key() },
      payload: { price: { amount: 4_000_000, currency: 'RUB' } },
    })
    expect(patched.statusCode).toBe(200)

    const events = (
      await app.inject({ method: 'GET', url: `/deals/${dealId}/events`, headers: auth(w.token) })
    ).json() as { kind: string; note: string | null }[]
    const price = events.find((e) => e.kind === 'price')
    expect(price).toBeDefined()
    // Старая и новая сумма — иначе запись не доказывает ничего.
    // Пробел внутри числа неразрывный: его ставит Intl, а не клавиатура.
    expect(price!.note).toMatch(/50\s000/)
    expect(price!.note).toMatch(/40\s000/)
  })

  it('чужой журнал не читается, кривой идентификатор — 422', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const { dealId } = await book(w, vendor.vendorId)

    const stranger = await newWedding()
    const seen = await app.inject({ method: 'GET', url: `/deals/${dealId}/events`, headers: auth(stranger.token) })
    // 404, а не 403: по коду ответа не должно быть видно, что сделка есть.
    expect(seen.statusCode).toBe(404)

    const bad = await app.inject({ method: 'GET', url: '/deals/not-a-uuid/events', headers: auth(w.token) })
    expect(bad.statusCode).toBe(422)
  })
})
