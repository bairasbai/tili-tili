import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { canTransition, tileState } from '../src/deals/state.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('этап 4: слоты, сделки, деньги, документы', () => {
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
    return { token: accessToken, id: user.id as string }
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
    expect(res.statusCode).toBe(201)
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
        priceFrom: { amount: 8_500_000, currency: 'RUB' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  const slotsOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
      deal: { id: string; state: string; price?: { amount: number } } | null
      tileState: string
    }[]

  const budgetOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/budget`, headers: auth(token) })).json() as {
      total: { amount: number }
      spent: { amount: number }
      categories: { id: string; fromSlots: number; items: unknown[] }[]
    }

  async function book(w: { token: string; weddingId: string }, slotId: string, vendorId: string, amount: number) {
    return app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId, price: { amount, currency: 'RUB' } },
    })
  }

  /* ── мозаика ──────────────────────────────────────────────────────── */
  it('новая свадьба даёт 12 пустых слотов', async () => {
    const w = await newWedding()
    const slots = await slotsOf(w.token, w.weddingId)
    expect(slots).toHaveLength(12)
    expect(slots.every((s) => s.deal === null && s.tileState === 'empty')).toBe(true)
  })

  /* ── главный критерий: две брони на одну дату ─────────────────────── */
  it('две параллельные брони на одну дату одного подрядчика — одна проходит', async () => {
    const vendor = await newVendor()
    const date = `2027-08-${String(randomInt(10, 28)).padStart(2, '0')}`
    const a = await newWedding(date)
    const b = await newWedding(date)
    const slotA = (await slotsOf(a.token, a.weddingId)).find((s) => s.categoryId === 'photo')!
    const slotB = (await slotsOf(b.token, b.weddingId)).find((s) => s.categoryId === 'photo')!

    const [first, second] = await Promise.all([
      book(a, slotA.id, vendor.vendorId, 8_500_000),
      book(b, slotB.id, vendor.vendorId, 8_500_000),
    ])
    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([200, 409])

    // И в календаре подрядчика ровно одна строка на дату — так стоит
    // первичный ключ, а не проверка в коде.
    const { rows } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1 and date = $2::date',
      [vendor.vendorId, date],
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('забронированный подрядчик исчезает из выдачи на эту дату', async () => {
    const vendor = await newVendor('florist')
    const date = `2027-10-${String(randomInt(10, 28)).padStart(2, '0')}`
    const w = await newWedding(date)
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'florist')!
    expect((await book(w, slot.id, vendor.vendorId, 4_500_000)).statusCode).toBe(200)

    const res = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?categoryId=florist&date=${date}&limit=100`,
      headers: auth(w.token),
    })
    expect((res.json().items as { id: string }[]).map((v) => v.id)).not.toContain(vendor.vendorId)
  })

  /* ── главный критерий: идемпотентность оплаты ─────────────────────── */
  it('повтор оплаты с тем же ключом не создаёт вторую запись', async () => {
    const vendor = await newVendor('host')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'host')!
    await book(w, slot.id, vendor.vendorId, 6_000_000)

    const headers = { ...auth(w.token), 'idempotency-key': randomUUID() }
    const payload = { amount: { amount: 3_000_000, currency: 'RUB' } }
    const first = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/pay`,
      headers,
      payload,
    })
    const second = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/pay`,
      headers,
      payload,
    })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.headers['idempotent-replay']).toBe('true')
    expect(second.json()).toEqual(first.json())

    const deal = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!
    const { rows } = await app.db!.query<{ n: number; total: string }>(
      "select count(*)::int as n, coalesce(sum(amount),0)::text as total from payments where deal_id = $1",
      [deal.id],
    )
    expect(rows[0]!.n).toBe(1)
    expect(rows[0]!.total).toBe('3000000')
  })

  it('тот же ключ с другим телом — 409, а не тихая подмена', async () => {
    const vendor = await newVendor('dj')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'dj')!
    await book(w, slot.id, vendor.vendorId, 6_000_000)

    const headers = { ...auth(w.token), 'idempotency-key': randomUUID() }
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/pay`,
      headers,
      payload: { amount: { amount: 1_000_000, currency: 'RUB' } },
    })
    const other = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/pay`,
      headers,
      payload: { amount: { amount: 2_000_000, currency: 'RUB' } },
    })
    expect(other.statusCode).toBe(409)
    expect(other.json().error.code).toBe('idempotency_key_reused')
  })

  it('оплата больше цены сделки не проходит', async () => {
    const vendor = await newVendor('cake')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    await book(w, slot.id, vendor.vendorId, 1_000_000)

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/pay`,
      headers: idem(w.token),
      payload: { amount: { amount: 1_500_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('overpay')
  })

  it('без Idempotency-Key оплата не принимается', async () => {
    const vendor = await newVendor('decor')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'decor')!
    await book(w, slot.id, vendor.vendorId, 2_000_000)

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/pay`,
      headers: auth(w.token),
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('idempotency_key_required')
  })

  /* ── главный критерий: бюджет после отмены ────────────────────────── */
  it('отмена уменьшает «потрачено» на цену сделки без ручного пересчёта', async () => {
    const vendor = await newVendor('venue')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'venue')!

    const before = await budgetOf(w.token, w.weddingId)
    expect(before.total.amount).toBe(150_000_000)
    expect(before.spent.amount).toBe(0)

    await book(w, slot.id, vendor.vendorId, 25_000_000)
    const booked = await budgetOf(w.token, w.weddingId)
    expect(booked.spent.amount).toBe(25_000_000)
    expect(booked.categories.find((c) => c.id === 'b1')!.fromSlots).toBe(25_000_000)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/cancel`,
      headers: idem(w.token),
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().deal).toBeNull()

    const after = await budgetOf(w.token, w.weddingId)
    expect(after.spent.amount).toBe(0)

    // Дата вернулась подрядчику.
    const { rows } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1',
      [vendor.vendorId],
    )
    expect(rows[0]!.n).toBe(0)
  })

  it('своя статья расхода попадает в бюджет и удаляется', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/budget/items`,
      headers: auth(w.token),
      payload: { title: 'Полиграфия', categoryId: 'b5', amount: { amount: 1_200_000, currency: 'RUB' } },
    })
    expect(created.statusCode).toBe(201)

    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(1_200_000)

    const del = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/budget/items/${created.json().id}`,
      headers: auth(w.token),
    })
    expect(del.statusCode).toBe(204)
    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(0)
  })

  /* ── машина состояний ─────────────────────────────────────────────── */
  it('переходы только вперёд, назад — 409', async () => {
    const vendor = await newVendor('stylist')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'stylist')!
    await book(w, slot.id, vendor.vendorId, 3_000_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    const back = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: idem(w.token),
      payload: { state: 'contacted' },
    })
    expect(back.statusCode).toBe(409)
    expect(back.json().error.code).toBe('bad_transition')

    const forward = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: idem(w.token),
      payload: { state: 'paid_deposit' },
    })
    expect(forward.statusCode).toBe(200)
    expect(forward.json().state).toBe('paid_deposit')
  })

  it('мягкая бронь — срок, а не состояние: истечение возвращает в candidate', async () => {
    const vendor = await newVendor('transport')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'transport')!
    // Сделка заводится через свой путь, чтобы начать с candidate.
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Автопарк «Волга»', price: { amount: 2_000_000, currency: 'RUB' } },
    })
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id
    void vendor

    // booked → cancelled → новая сделка не нужна: проверяем срок напрямую.
    await app.db!.query(
      "update deals set state = 'negotiating', negotiating_until = now() + interval '72 hours' where id = $1",
      [dealId],
    )
    const held = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!
    expect(held.tileState).toBe('hold')
    expect(held.deal!.state).toBe('negotiating')

    // Прошло 72 часа.
    await app.db!.query("update deals set negotiating_until = now() - interval '1 minute' where id = $1", [dealId])
    const expired = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!
    expect(expired.deal!.state).toBe('candidate')
    expect(expired.tileState).toBe('candidate')

    const { rows } = await app.db!.query<{ note: string | null }>(
      `select note from deal_events where deal_id = $1 and to_state = 'candidate'`,
      [dealId],
    )
    expect(rows[0]!.note).toContain('истёк')
  })

  /* ── свой подрядчик ───────────────────────────────────────────────── */
  it('свой подрядчик занимает слот и бюджет, но не чужой календарь', async () => {
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'rings')!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Ювелир Иван', phone: '+79170000000', price: { amount: 9_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().deal.externalName).toBe('Ювелир Иван')
    expect(res.json().deal.vendor).toBeNull()
    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(9_000_000)

    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external/invite`,
      headers: auth(w.token),
    })
    expect(invite.statusCode).toBe(201)
    const token = invite.json().token as string

    const cabinet = await app.inject({ method: 'GET', url: `/guest-vendor/${token}` })
    expect(cabinet.statusCode).toBe(200)
    expect(cabinet.json().weddingDate).toBe('2027-06-14')
    expect(cabinet.json().slot.deal.externalName).toBe('Ювелир Иван')
    // Только свой слот и дата: ни гостей, ни бюджета, ни остальной команды.
    expect(cabinet.body).not.toContain('budget')
    expect(cabinet.body).not.toContain('members')

    const removed = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
      headers: auth(w.token),
    })
    expect(removed.statusCode).toBe(204)
    // Токен аннулирован вместе с подрядчиком.
    expect((await app.inject({ method: 'GET', url: `/guest-vendor/${token}` })).statusCode).toBe(410)
    expect((await budgetOf(w.token, w.weddingId)).spent.amount).toBe(0)
  })

  /* ── документы ────────────────────────────────────────────────────── */
  it('договор оформляется по брони, версии растут, файлов пока нет', async () => {
    const vendor = await newVendor('video')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'video')!
    await book(w, slot.id, vendor.vendorId, 12_000_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    const first = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: idem(w.token),
      payload: {
        templateCode: 'videographer',
        fields: { customerFullName: 'Алина Иванова', performerFullName: 'Пётр Петров' },
      },
    })
    expect(first.statusCode).toBe(201)
    expect(first.json().version).toBe(1)
    expect(first.json().pdfUrl).toBeNull()
    expect(first.json().fields.amount).toBe(12_000_000)
    expect(first.json().fields.disclaimer).toContain('информационный характер')

    const second = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: idem(w.token),
      payload: {
        templateCode: 'videographer',
        fields: { customerFullName: 'Алина Иванова', performerFullName: 'Пётр Сидоров' },
      },
    })
    expect(second.json().version).toBe(2)

    const list = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/documents`,
      headers: auth(w.token),
    })
    expect((list.json() as unknown[]).length).toBe(2)
  })

  it('договор без обязательных полей не оформляется', async () => {
    const vendor = await newVendor('dress')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'dress')!
    await book(w, slot.id, vendor.vendorId, 5_000_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    const res = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: idem(w.token),
      payload: { templateCode: 'universal', fields: { customerFullName: 'Алина' } },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('fields_missing')
  })

  /* ── перенос и отмена ─────────────────────────────────────────────── */
  it('перенос даты двигает календари и сроки задач', async () => {
    const vendor = await newVendor('photo')
    const w = await newWedding('2027-06-14')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'photo')!
    await book(w, slot.id, vendor.vendorId, 8_500_000)

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/reschedule`,
      headers: idem(w.token),
      payload: { date: '2027-07-14' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().busy).toEqual([])

    const { rows } = await app.db!.query<{ date: string }>(
      "select date::text as date from vendor_busy_dates where vendor_id = $1",
      [vendor.vendorId],
    )
    expect(rows.map((r) => r.date)).toEqual(['2027-07-14'])

    const { rows: tasks } = await app.db!.query<{ due: string }>(
      `select due::text as due from tasks where wedding_id = $1 and period = '9' order by sort limit 1`,
      [w.weddingId],
    )
    expect(tasks[0]!.due).toBe('2026-10-14')
  })

  it('перенос на дату, где занят кто-то из команды, — 409 со списком', async () => {
    const vendor = await newVendor('photo')
    const busyDate = `2027-11-${String(randomInt(10, 28)).padStart(2, '0')}`
    await app.db!.query(
      "insert into vendor_busy_dates (vendor_id, date, source) values ($1, $2::date, 'manual')",
      [vendor.vendorId, busyDate],
    )
    const w = await newWedding('2027-06-20')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'photo')!
    await book(w, slot.id, vendor.vendorId, 8_500_000)

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/reschedule`,
      headers: idem(w.token),
      payload: { date: busyDate },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('team_busy')

    // Дата не сдвинулась: частичный перенос хуже отказа.
    const { rows } = await app.db!.query<{ date: string }>('select date::text as date from weddings where id = $1', [
      w.weddingId,
    ])
    expect(rows[0]!.date).toBe('2027-06-20')
  })

  it('отмена свадьбы вдвоём требует подтверждения обоих', async () => {
    const a = await newWedding()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${a.weddingId}/invites`,
      headers: auth(a.token),
      payload: { role: 'couple' },
    })
    const b = await newUser()
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(b.token) })

    const first = await app.inject({ method: 'POST', url: `/weddings/${a.weddingId}/cancel`, headers: auth(a.token) })
    expect(first.json().state).toBe('confirmation_required')

    // Тот же партнёр второй раз ничего не исполняет.
    const again = await app.inject({ method: 'POST', url: `/weddings/${a.weddingId}/cancel`, headers: auth(a.token) })
    expect(again.json().state).toBe('confirmation_required')

    const second = await app.inject({ method: 'POST', url: `/weddings/${a.weddingId}/cancel`, headers: auth(b.token) })
    expect(second.json().state).toBe('cancelled')

    // Свадьба ушла в архив — доступа больше нет.
    expect((await app.inject({ method: 'GET', url: `/weddings/${a.weddingId}`, headers: auth(a.token) })).statusCode).toBe(404)
  })

  it('свадьбу одного человека отменяет он один', async () => {
    const w = await newWedding()
    const res = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })
    expect(res.json().state).toBe('cancelled')
  })

  /* ── роли ─────────────────────────────────────────────────────────── */
  it('помощник видит мозаику, но без цен, и не может ни бронировать, ни платить', async () => {
    const vendor = await newVendor('photo')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'photo')!
    await book(w, slot.id, vendor.vendorId, 8_500_000)

    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'helper' },
    })
    const helper = await newUser()
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper.token) })

    const seen = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/slots`,
      headers: auth(helper.token),
    })
    expect(seen.statusCode).toBe(200)
    // Мозаику видит, суммы — нет (план §6, ERR-0026).
    expect(seen.body).not.toContain('price')
    expect((seen.json() as { tileState: string }[]).some((s) => s.tileState === 'booked')).toBe(true)

    for (const tail of ['book', 'cancel', 'pay']) {
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/${tail}`,
        headers: idem(helper.token),
        payload: tail === 'book' ? { vendorId: vendor.vendorId, price: { amount: 1, currency: 'RUB' } } : {},
      })
      expect(`${tail} → ${res.statusCode}`).toBe(`${tail} → 403`)
    }

    for (const url of [`/weddings/${w.weddingId}/budget`, `/weddings/${w.weddingId}/documents`]) {
      expect((await app.inject({ method: 'GET', url, headers: auth(helper.token) })).statusCode).toBe(403)
    }
  })

  it('чужой сделкой распорядиться нельзя', async () => {
    const vendor = await newVendor('photo')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'photo')!
    await book(w, slot.id, vendor.vendorId, 8_500_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    const stranger = await newUser()
    const res = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: idem(stranger.token),
      payload: { state: 'cancelled' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('слот чужой свадьбы недоступен по прямой ссылке', async () => {
    const mine = await newWedding()
    const other = await newWedding()
    const otherSlot = (await slotsOf(other.token, other.weddingId))[0]!

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${mine.weddingId}/slots/${otherSlot.id}/external`,
      headers: auth(mine.token),
      payload: { vendorName: 'Кто-то', price: { amount: 1000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(404)
  })
})

/* ── чистые функции ───────────────────────────────────────────────── */
describe('машина состояний сделки', () => {
  it('вперёд можно, назад нельзя', () => {
    expect(canTransition('candidate', 'contacted')).toBe(true)
    expect(canTransition('candidate', 'booked')).toBe(true)
    expect(canTransition('booked', 'candidate')).toBe(false)
    expect(canTransition('paid_deposit', 'negotiating')).toBe(false)
  })

  it('отмена возможна из любого живого состояния, из отменённого — нет', () => {
    for (const s of ['candidate', 'contacted', 'negotiating', 'booked', 'paid_deposit'] as const) {
      expect(`${s} → cancelled: ${canTransition(s, 'cancelled')}`).toBe(`${s} → cancelled: true`)
    }
    expect(canTransition('cancelled', 'booked')).toBe(false)
    expect(canTransition('done', 'cancelled')).toBe(false)
  })

  it('переход в себя же не считается переходом', () => {
    expect(canTransition('booked', 'booked')).toBe(false)
  })

  it('подпись плитки выводится из состояния, а не хранится', () => {
    expect(tileState(null)).toBe('empty')
    expect(tileState('cancelled')).toBe('empty')
    expect(tileState('contacted')).toBe('candidate')
    expect(tileState('negotiating')).toBe('hold')
    expect(tileState('booked')).toBe('booked')
    expect(tileState('done')).toBe('paid')
  })
})
