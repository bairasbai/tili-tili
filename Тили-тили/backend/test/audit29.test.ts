import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'

/**
 * Регрессия по находкам ревью старого кода (домены D1, D2, D5 — сделки,
 * слоты, перенос даты, каталог, анкета, отзывы, кабинет подрядчика).
 *
 * Каждый тест красный без своего фикса — так проверено на версии HEAD.
 * База общая (R-177/R-226/R-227): утверждения — по своим строкам, найденным
 * по своим ключам, а не по счётчикам общей выдачи.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const RUB = (amount: number) => ({ amount, currency: 'RUB' as const })
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000)

describe.skipIf(!live)('ревью старого кода: сделки, перенос, каталог, кабинет', () => {
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
  const key = () => ({ 'idempotency-key': randomUUID() })
  const idem = (token: string) => ({ ...auth(token), ...key() })
  const sql = <T extends object>(text: string, params: unknown[] = []) => app.db!.query<T>(text, params)

  async function readCode(phone: string): Promise<string> {
    const { rows } = await sql<{ code_hash: string }>(
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
    const { accessToken, user } = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: accessToken, userId: user.id }
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
        budgetTotal: RUB(150_000_000),
      },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  async function newVendor(
    name = 'П',
    categoryId = 'photo',
    extra: { phone?: string; packages?: { name: string; price?: { amount: number; currency: 'RUB' } }[] } = {},
  ) {
    const user = await newUser()
    const vendorName = `${name} ${RUN}-${counter}`
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: vendorName,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
        priceFrom: RUB(5_000_000),
        ...extra,
      },
    })
    expect(res.statusCode).toBe(200)
    const published = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    expect(published.statusCode).toBe(200)
    return { ...user, vendorId: res.json().id as string, vendorName }
  }

  const slotsOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
      deal: { id: string; state: string; price: { amount: number } | null } | null
    }[]

  const slotIn = async (w: { token: string; weddingId: string }, categoryId: string) => {
    const slots = await slotsOf(w.token, w.weddingId)
    return slots.find((s) => s.categoryId === categoryId)!
  }

  const book = (
    w: { token: string; weddingId: string },
    slotId: string,
    vendorId: string,
    amount: number,
    packageId?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId, price: RUB(amount), ...(packageId !== undefined ? { packageId } : {}) },
    })

  /** Бронь каталожного подрядчика в слот категории; возвращает сделку. */
  async function bookIn(w: { token: string; weddingId: string }, categoryId: string, vendorId: string, amount = 10_000_000) {
    const slot = await slotIn(w, categoryId)
    const res = await book(w, slot.id, vendorId, amount)
    expect(res.statusCode).toBe(200)
    return { slotId: slot.id, dealId: res.json().deal.id as string }
  }

  const patchDeal = (token: string, dealId: string, payload: object) =>
    app.inject({ method: 'PATCH', url: `/deals/${dealId}`, headers: idem(token), payload })

  const reschedule = (w: { token: string; weddingId: string }, date: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/reschedule`,
      headers: idem(w.token),
      payload: { date },
    })

  const busyDates = async (vendorId: string) =>
    (await sql<{ date: string }>('select date::text as date from vendor_busy_dates where vendor_id = $1 order by date', [vendorId])).rows.map(
      (r) => r.date,
    )

  const cancelledEvents = async (dealId: string) =>
    Number(
      (
        await sql<{ n: string }>(
          "select count(*)::text as n from deal_events where deal_id = $1 and to_state = 'cancelled'",
          [dealId],
        )
      ).rows[0]!.n,
    )

  /* ═══════════════════════════════════════════════════════════════════
   * D2-01 · перенос даты у пары, где один подрядчик занял два слота
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-01 · перенос даты при двух слотах одного подрядчика', () => {
    it('перенос отвечает 200, и у подрядчика ровно одна строка занятости на новую дату', async () => {
      const vendor = await newVendor('Фотовидео', 'photo')
      const w = await newWedding('2027-06-14')
      const photo = await slotIn(w, 'photo')
      const video = await slotIn(w, 'video')
      expect((await book(w, photo.id, vendor.vendorId, 8_500_000)).statusCode).toBe(200)
      expect((await book(w, video.id, vendor.vendorId, 5_000_000)).statusCode).toBe(200)

      const moved = await reschedule(w, '2027-06-21')
      /* До фикса: 409 `date_taken` «Дата у «…» занята» — занята их же
       * свадьбой: второй insert упирался в первичный ключ (vendor_id, date). */
      expect(moved.statusCode).toBe(200)
      expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-21'])
    })

    it('первая дата у свадьбы без даты: PATCH /weddings {date} проходит с двумя слотами одного подрядчика', async () => {
      const vendor = await newVendor('Фотовидео2', 'photo')
      const w = await newWedding(null)
      const photo = await slotIn(w, 'photo')
      const video = await slotIn(w, 'video')
      expect((await book(w, photo.id, vendor.vendorId, 8_500_000)).statusCode).toBe(200)
      expect((await book(w, video.id, vendor.vendorId, 5_000_000)).statusCode).toBe(200)
      expect(await busyDates(vendor.vendorId)).toEqual([])

      const dated = await app.inject({
        method: 'PATCH',
        url: `/weddings/${w.weddingId}`,
        headers: auth(w.token),
        payload: { date: '2027-07-03' },
      })
      expect(dated.statusCode).toBe(200)
      expect(await busyDates(vendor.vendorId)).toEqual(['2027-07-03'])
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-02 · отмена выполненной сделки закрыта той же машиной переходов
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-02 · из `done` отменить нельзя ни одной дверью', () => {
    it('POST /slots/{id}/cancel у выполненной сделки — 409 bad_transition, плитка не пустеет', async () => {
      const vendor = await newVendor('Выполнивший', 'photo')
      const w = await newWedding()
      const { slotId, dealId } = await bookIn(w, 'photo', vendor.vendorId)
      expect((await patchDeal(w.token, dealId, { state: 'done' })).statusCode).toBe(200)

      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`,
        headers: idem(w.token),
      })
      // До фикса: 200, `slots.deal_id = null`, событие `done → cancelled`.
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('bad_transition')

      const { rows } = await sql<{ deal_id: string | null }>('select deal_id from slots where id = $1', [slotId])
      expect(rows[0]!.deal_id).toBe(dealId)
      expect(await cancelledEvents(dealId)).toBe(0)
      expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-14'])
    })

    it('DELETE /slots/{id}/external у выполненной работы своего подрядчика — 409 bad_transition', async () => {
      const w = await newWedding()
      const slot = await slotIn(w, 'cake')
      const added = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
        headers: auth(w.token),
        payload: { vendorName: 'Кондитер Алия', price: RUB(3_000_000) },
      })
      expect(added.statusCode).toBe(200)
      const dealId = added.json().deal.id as string
      const invited = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/external/invite`,
        headers: auth(w.token),
      })
      expect(invited.statusCode).toBe(201)
      const token = invited.json().token as string
      expect((await patchDeal(w.token, dealId, { state: 'done' })).statusCode).toBe(200)

      const res = await app.inject({
        method: 'DELETE',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
        headers: auth(w.token),
      })
      // До фикса: 204 — состояние не проверялось вовсе.
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('bad_transition')
      const { rows } = await sql<{ state: string }>('select state from deals where id = $1', [dealId])
      expect(rows[0]!.state).toBe('done')
      /* Сделка остаётся, а ссылка убранного подрядчика гаснет всё равно:
         иначе её нечем отозвать 30 дней (ревью фиксов, RF-BE-03). */
      expect((await app.inject({ method: 'GET', url: `/guest-vendor/${token}` })).statusCode).toBe(410)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-06 · двойная отмена — одно событие
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-06 · одновременные отмены слота', () => {
    it('дают ровно одно событие `cancelled` и один ответ 200', async () => {
      const vendor = await newVendor('Отменяемый', 'photo')
      const w = await newWedding()
      const { slotId, dealId } = await bookIn(w, 'photo', vendor.vendorId)

      /* Четыре нажатия с разных устройств (две вкладки, два партнёра) с
       * разными ключами. Гонка — вероятностная: чем больше одновременных
       * отмен, тем надёжнее двое читают `booked` до записи первого. */
      const cancel = () =>
        app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`, headers: idem(w.token) })
      // Прогрев пула: на холодных соединениях запросы расходятся во времени
      // сами собой, и гонки не получается даже там, где защиты нет.
      await Promise.all(Array.from({ length: 8 }, () => sql('select 1')))
      const results = await Promise.all([cancel(), cancel(), cancel(), cancel()])
      const codes = results.map((r) => r.statusCode).sort()
      // До фикса: несколько 200 и столько же записей `booked → cancelled`.
      expect(codes).toEqual([200, 409, 409, 409])
      expect(await cancelledEvents(dealId)).toBe(1)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-05 · цена 0 — не цена
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-05 · нулевая цена', () => {
    it('бронь с amount: 0 — 422 bad_amount, сделка не заводится', async () => {
      const vendor = await newVendor('Бесплатный', 'photo')
      const w = await newWedding()
      const slot = await slotIn(w, 'photo')
      const res = await book(w, slot.id, vendor.vendorId, 0)
      // До фикса: 200 и сделка с ценой 0 — оплата без предела.
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('bad_amount')
      const { rows } = await sql('select 1 from deals where slot_id = $1', [slot.id])
      expect(rows).toHaveLength(0)
    })

    it('свой подрядчик с amount: 0 — 422 bad_amount', async () => {
      const w = await newWedding()
      const slot = await slotIn(w, 'cake')
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
        headers: auth(w.token),
        payload: { vendorName: 'Кондитер Даром', price: RUB(0) },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('bad_amount')
    })

    it('оплата сделки с ценой 0 — 409 no_price, платёж не пишется', async () => {
      const vendor = await newVendor('Обнулённый', 'photo')
      const w = await newWedding()
      const { slotId, dealId } = await bookIn(w, 'photo', vendor.vendorId, 10_000_000)
      // Ноль назначается явно через PATCH — там он законен.
      expect((await patchDeal(w.token, dealId, { price: RUB(0) })).statusCode).toBe(200)

      const pay = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
        headers: idem(w.token),
        payload: { amount: RUB(10_000_000) },
      })
      // До фикса: 200, `paid_deposit`, любая сумма — проверка переплаты отключена при `price > 0`.
      expect(pay.statusCode).toBe(409)
      expect(pay.json().error.code).toBe('no_price')
      const { rows } = await sql('select 1 from payments where deal_id = $1', [dealId])
      expect(rows).toHaveLength(0)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-07 · дата захватывается при первом входе в любое из COMMITTED
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-07 · перескок через `booked`', () => {
    it('negotiating → paid_deposit занимает дату подрядчика', async () => {
      const vendor = await newVendor('Перескочивший', 'photo')
      const w = await newWedding('2027-06-14')
      const { dealId } = await bookIn(w, 'photo', vendor.vendorId)
      // Сделка «до брони» — правкой базы: до появления лид → кандидат иначе недостижима.
      await sql("update deals set state = 'negotiating', negotiating_until = now() + interval '1 hour' where id = $1", [
        dealId,
      ])
      await sql('delete from vendor_busy_dates where deal_id = $1', [dealId])
      expect(await busyDates(vendor.vendorId)).toEqual([])

      const res = await patchDeal(w.token, dealId, { state: 'paid_deposit' })
      expect(res.statusCode).toBe(200)
      // До фикса: дата занималась только при `state === 'booked'` — строки нет.
      expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-14'])
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-08 · два переноса подряд с двух устройств
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-08 · параллельные переносы', () => {
    it('срок задачи соответствует итоговой дате, а не сумме двух сдвигов', async () => {
      const D0 = '2027-06-14'
      const w = await newWedding(D0)
      const slot = await slotIn(w, 'cake')
      const added = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
        headers: auth(w.token),
        payload: { vendorName: 'Кондитер Своя', price: RUB(3_000_000) },
      })
      expect(added.statusCode).toBe(200)

      const { rows: before } = await sql<{ id: string; due: string }>(
        `select id, due::text as due from tasks
          where wedding_id = $1 and due is not null and period ~ '^[0-9]+$' order by sort limit 1`,
        [w.weddingId],
      )
      const task = before[0]!

      // Прогрев пула — см. D2-06.
      await Promise.all(Array.from({ length: 8 }, () => sql('select 1')))
      const [a, b] = await Promise.all([reschedule(w, '2027-06-21'), reschedule(w, '2027-06-28')])
      expect([a.statusCode, b.statusCode]).toEqual([200, 200])

      const { rows: wedding } = await sql<{ date: string }>('select date::text as date from weddings where id = $1', [
        w.weddingId,
      ])
      const { rows: after } = await sql<{ due: string }>('select due::text as due from tasks where id = $1', [task.id])
      /* До фикса: оба переноса читали D0, второй сдвигал задачи на (D2 − D0)
       * ПОВЕРХ (D1 − D0) — срок уезжал на 21 день при переносе на 7 или 14. */
      expect(days(after[0]!.due, task.due)).toBe(days(wedding[0]!.date, D0))
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-16 · «назначить 0 ₽» сделке без цены
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-16 · цена null против 0', () => {
    it('PATCH {price: 0} у сделки без цены назначает ноль и пишет событие', async () => {
      const vendor = await newVendor('Бесценный', 'photo')
      const w = await newWedding()
      const { dealId } = await bookIn(w, 'photo', vendor.vendorId)
      await sql('update deals set price = null where id = $1', [dealId])

      const res = await patchDeal(w.token, dealId, { price: RUB(0) })
      expect(res.statusCode).toBe(200)
      // До фикса: `Number(null) === 0` → «ничего не изменилось», в ответе `price: null`.
      expect(res.json().price).toEqual({ amount: 0, currency: 'RUB' })
      const { rows } = await sql<{ note: string | null }>(
        "select note from deal_events where deal_id = $1 and kind = 'price'",
        [dealId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.note).toContain('0 ₽')
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-22 · перенос не трогает занятость выполненной сделки
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-22 · `done` при переносе', () => {
    it('день выполненной сделки остаётся отработанным, на новую дату не переезжает', async () => {
      const done = await newVendor('Отработавший', 'photo')
      const open = await newVendor('Открытый', 'video')
      const w = await newWedding('2027-06-14')
      const { dealId } = await bookIn(w, 'photo', done.vendorId)
      await bookIn(w, 'video', open.vendorId)
      expect((await patchDeal(w.token, dealId, { state: 'done' })).statusCode).toBe(200)

      expect((await reschedule(w, '2027-06-21')).statusCode).toBe(200)
      // До фикса: строка `done`-сделки переезжала на 21-е — будущий день блокировался под сделанную работу.
      expect(await busyDates(done.vendorId)).toEqual(['2027-06-14'])
      // Открытая бронь переезжает — обе половины фикстуры (R-217).
      expect(await busyDates(open.vendorId)).toEqual(['2027-06-21'])
    })

    it('два слота одного подрядчика, выполнен второй: отработанный день остаётся, открытая бронь переезжает', async () => {
      const vendor = await newVendor('Наполовину', 'photo')
      const w = await newWedding('2027-06-14')
      // Строка занятости ссылается на ПЕРВУЮ бронь (фото); выполнена вторая (видео).
      await bookIn(w, 'photo', vendor.vendorId)
      const video = await bookIn(w, 'video', vendor.vendorId)
      expect((await patchDeal(w.token, video.dealId, { state: 'done' })).statusCode).toBe(200)

      expect((await reschedule(w, '2027-06-21')).statusCode).toBe(200)
      /* Без переноса ссылки строка снималась вместе с открытой бронью, и
       * отработанный день видео освобождался — хотя работа на нём была. */
      expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-14', '2027-06-21'])
    })

    it('второй перенос и отмена открытой брони не оставляют призрачных дат (RF-BE-02)', async () => {
      const vendor = await newVendor('Дваждыпереносимый', 'photo')
      const w = await newWedding('2027-06-14')
      const photo = await bookIn(w, 'photo', vendor.vendorId)
      const video = await bookIn(w, 'video', vendor.vendorId)
      expect((await patchDeal(w.token, video.dealId, { state: 'done' })).statusCode).toBe(200)
      expect((await reschedule(w, '2027-06-21')).statusCode).toBe(200)

      /* Второй перенос: у выполненной сделки уже есть своя строка (14 июня),
       * и переписывать на неё ещё и 21 июня нельзя — иначе этот день остаётся
       * занят призраком навсегда (ревью фиксов, RF-BE-02). */
      expect((await reschedule(w, '2027-06-28')).statusCode).toBe(200)
      expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-14', '2027-06-28'])

      // Отмена единственной открытой брони освобождает новую дату; отработанный день остаётся.
      expect(
        (await app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/slots/${photo.slotId}/cancel`,
          headers: { ...auth(w.token), 'idempotency-key': `rf2-${RUN}-${counter++}` },
        })).statusCode,
      ).toBe(200)
      expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-14'])
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D2-23 · packageId при брони
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D2-23 · пакет при брони', () => {
    it('чужой, несуществующий или кривой пакет — 422 unknown_package; свой — 200', async () => {
      const vendor = await newVendor('Пакетный', 'photo', { packages: [{ name: 'Базовый', price: RUB(5_000_000) }] })
      const other = await newVendor('Соседний', 'photo', { packages: [{ name: 'Чужой', price: RUB(5_000_000) }] })
      const { rows: mine } = await sql<{ id: string }>('select id from vendor_packages where vendor_id = $1', [
        vendor.vendorId,
      ])
      const { rows: theirs } = await sql<{ id: string }>('select id from vendor_packages where vendor_id = $1', [
        other.vendorId,
      ])
      const w = await newWedding()
      const slot = await slotIn(w, 'photo')

      // До фикса: 200 на любой из трёх — поле принималось и молча ничего не делало.
      for (const packageId of ['нет такого', randomUUID(), theirs[0]!.id]) {
        const res = await book(w, slot.id, vendor.vendorId, 5_000_000, packageId)
        expect(res.statusCode).toBe(422)
        expect(res.json().error.code).toBe('unknown_package')
      }
      const { rows } = await sql('select 1 from deals where slot_id = $1', [slot.id])
      expect(rows).toHaveLength(0)

      const ok = await book(w, slot.id, vendor.vendorId, 5_000_000, mine[0]!.id)
      expect(ok.statusCode).toBe(200)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D1-04 / D5-25 · участник с ролью `vendor` — не сторона сделки
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D1-04 · D5-25 · роль `vendor` в команде', () => {
    it('журнал сумм — 403 участнику-vendor; подрядчику сделки и паре — 200', async () => {
      const vendor = await newVendor('Сторона', 'photo')
      const w = await newWedding()
      const { dealId } = await bookIn(w, 'photo', vendor.vendorId)
      const colleague = await newUser()
      await sql("insert into wedding_members (wedding_id, user_id, role) values ($1, $2, 'vendor')", [
        w.weddingId,
        colleague.userId,
      ])

      const events = (token: string) =>
        app.inject({ method: 'GET', url: `/deals/${dealId}/events`, headers: auth(token) })
      // До фикса: 200 с суммами — ветка `union` называлась `vendor`, как и роль участника.
      expect((await events(colleague.token)).statusCode).toBe(403)
      expect((await events(vendor.token)).statusCode).toBe(200)
      expect((await events(w.token)).statusCode).toBe(200)
    })

    it('телефон забронированного подрядчика: участнику-vendor — null, помощнику — номер', async () => {
      const vendor = await newVendor('Телефонный', 'photo', { phone: `+7999${RUN}1` })
      const w = await newWedding()
      await bookIn(w, 'photo', vendor.vendorId)
      const colleague = await newUser()
      const helper = await newUser()
      await sql("insert into wedding_members (wedding_id, user_id, role) values ($1, $2, 'vendor'), ($1, $3, 'helper')", [
        w.weddingId,
        colleague.userId,
        helper.userId,
      ])

      const card = async (token: string) =>
        (await app.inject({ method: 'GET', url: `/catalog/vendors/${vendor.vendorId}`, headers: auth(token) })).json() as {
          phone: string | null
        }
      // До фикса: `mayCall` не смотрел роль — номер уходил и коллеге по свадьбе.
      expect((await card(colleague.token)).phone).toBeNull()
      expect((await card(helper.token)).phone).toBe(`+7999${RUN}1`)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-03 · публикация после снятия модератором
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-03 · publish после reject и у заблокированной', () => {
    it('снятая анкета публикуется как новая: {status: moderation}, снова в очереди', async () => {
      const vendor = await newVendor('Снятый', 'photo')
      // Решение модератора `reject` — ровно так его пишет admin.ts.
      await sql('update vendors set moderated_at = now(), published_at = null where id = $1', [vendor.vendorId])

      const res = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendor.token) })
      expect(res.statusCode).toBe(200)
      // До фикса: `{status: 'live'}` — метка решения оставалась, в очередь анкета не попадала никогда.
      expect(res.json()).toEqual({ status: 'moderation' })
      const { rows } = await sql<{ queued: boolean }>(
        'select (moderated_at is null and published_at is not null) as queued from vendors where id = $1',
        [vendor.vendorId],
      )
      expect(rows[0]!.queued).toBe(true)
    })

    it('заблокированная анкета не публикуется: 409 vendor_blocked', async () => {
      const vendor = await newVendor('Заблокированный', 'photo')
      await sql('update vendors set blocked_at = now(), published_at = null where id = $1', [vendor.vendorId])

      const res = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendor.token) })
      // До фикса: 200 `{status: 'live'}` при блокировке.
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('vendor_blocked')
      const { rows } = await sql<{ published_at: Date | null }>('select published_at from vendors where id = $1', [
        vendor.vendorId,
      ])
      expect(rows[0]!.published_at).toBeNull()
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-08 · деньги кабинета — по платежам
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-08 · «ожидается» и «доход» считаются по payments', () => {
    it('бронь 100 000 ₽ с авансом 50 000 ₽: ожидается 50 000 ₽, доход — 50 000 ₽, до аванса — 0', async () => {
      const vendor = await newVendor('Денежный', 'photo')
      const w = await newWedding()
      const { slotId } = await bookIn(w, 'photo', vendor.vendorId, 10_000_000)

      const analytics = async () =>
        (await app.inject({ method: 'GET', url: '/vendor/analytics?period=month', headers: auth(vendor.token) })).json() as {
          revenue: { amount: number }
        }
      const deals = async () =>
        (await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(vendor.token) })).json() as {
          expected: { amount: number }
        }
      // До фикса: «доход» 100 000 ₽ по цене брони без единого рубля.
      expect((await analytics()).revenue.amount).toBe(0)
      expect((await deals()).expected.amount).toBe(10_000_000)

      const paid = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
        headers: idem(w.token),
        payload: { amount: RUB(5_000_000) },
      })
      expect(paid.statusCode).toBe(200)
      await sql("update payments p set visibility='vendor' from deals d where p.deal_id=d.id and d.slot_id=$1", [slotId])
      // До фикса: «ожидается» 100 000 ₽ при внесённом авансе.
      expect((await deals()).expected.amount).toBe(5_000_000)
      expect((await analytics()).revenue.amount).toBe(5_000_000)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-09 / D5-10 · курсор каталога
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-09 · курсор от другой сортировки', () => {
    it('sort=price_asc с курсором от sort=rating — 400 bad_cursor, не 500', async () => {
      const mark = `Курсорный${RUN}${randomInt(1000, 9999)}`
      const a = await newVendor(mark, 'transport')
      const b = await newVendor(mark, 'transport')
      // Порог показа рейтинга — по отзывам ПАР (фича 005): без `couple_reviews_count` число скрыто и ключи слипаются.
      await sql('update vendors set rating = 4.5, reviews_count = 3, couple_reviews_count = 3 where id = any($1::uuid[])', [[a.vendorId, b.vendorId]])
      const reader = await newUser()
      const list = (query: string) =>
        app.inject({ method: 'GET', url: `/catalog/vendors?q=${encodeURIComponent(mark)}&${query}`, headers: auth(reader.token) })

      const first = await list('sort=rating&limit=1')
      expect(first.statusCode).toBe(200)
      const cursor = first.json().nextCursor as string
      expect(cursor).toBeTruthy()

      // До фикса: `'4.5'::bigint` — ошибка приведения, 500 `internal` и авария в логе.
      const foreign = await list(`sort=price_asc&limit=1&cursor=${encodeURIComponent(cursor)}`)
      expect(foreign.statusCode).toBe(400)
      expect(foreign.json().error.code).toBe('bad_cursor')

      const priced = await list('sort=price_asc&limit=1')
      const priceCursor = priced.json().nextCursor as string
      // `9223372036854775807::int` не влезает — тоже 500 до фикса.
      const popular = await list(`sort=popular&limit=1&cursor=${encodeURIComponent(priceCursor)}`)
      expect(popular.statusCode).toBe(400)
      expect(popular.json().error.code).toBe('bad_cursor')

      // Свой курсор по-прежнему работает: вторая страница по рейтингу.
      const second = await list(`sort=rating&limit=1&cursor=${encodeURIComponent(cursor)}`)
      expect(second.statusCode).toBe(200)
      expect((second.json().items as { id: string }[]).map((v) => v.id)).toEqual([
        [a.vendorId, b.vendorId].filter((id) => id !== (first.json().items as { id: string }[])[0]!.id)[0],
      ])
    })
  })

  describe('D5-10 · пониженные анкеты при листании (R-47)', () => {
    async function fixture() {
      const mark = `Листание${RUN}${randomInt(1000, 9999)}`
      const make = async (rating: number, reviews: number, down: boolean) => {
        const v = await newVendor(mark, 'transport')
        // `couple_reviews_count` — порог показа числа с фичи 005; без него порядок совпадал бы с `v.id` случайно.
        await sql('update vendors set rating = $2, reviews_count = $3, couple_reviews_count = $3, downranked_at = $4 where id = $1', [
          v.vendorId,
          rating,
          reviews,
          down ? new Date() : null,
        ])
        return v.vendorId
      }
      const A = await make(5.0, 3, false)
      const B = await make(4.0, 3, false)
      const C = await make(3.0, 3, false)
      const D = await make(4.9, 2, false) // рейтинг скрыт до трёх отзывов — сортируется как «нет»
      const E = await make(4.5, 3, true)
      const F = await make(2.0, 3, true)
      const reader = await newUser()
      const walk = async (limit: number) => {
        const pages: string[][] = []
        let cursor: string | null = null
        for (let guard = 0; guard < 10; guard++) {
          const url =
            `/catalog/vendors?q=${encodeURIComponent(mark)}&sort=rating&limit=${limit}` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
          const res = await app.inject({ method: 'GET', url, headers: auth(reader.token) })
          expect(res.statusCode).toBe(200)
          const body = res.json() as { items: { id: string }[]; nextCursor: string | null }
          pages.push(body.items.map((v) => v.id))
          cursor = body.nextCursor
          if (!cursor) break
        }
        return pages
      }
      return { order: [A, B, C, D, E, F], walk }
    }

    it('limit=2: пониженные не теряются — все шесть приходят по одному разу и в порядке', async () => {
      const { order, walk } = await fixture()
      const pages = await walk(2)
      // До фикса: третья страница пуста — ключ пониженной 4.5 «выше» ключа последней строки (−1).
      expect(pages.flat()).toEqual(order)
    })

    it('limit=5: граница страницы в хвосте пониженных — вторая страница не повторяет уже показанных', async () => {
      const { order, walk } = await fixture()
      const pages = await walk(5)
      // До фикса: вторая страница снова отдавала B, C, D — условие «после курсора» не знало о понижении.
      expect(pages).toEqual([order.slice(0, 5), order.slice(5)])
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-11 · `%` и `_` в поиске — буквы
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-11 · экранирование like', () => {
    it('каталог: q с `_` находит только подчёркивание, q с `%` не находит ничего', async () => {
      const under = await newVendor(`Ф_${RUN}`, 'transport')
      const other = await newVendor(`ФX${RUN}`, 'transport')
      const reader = await newUser()
      const ids = async (q: string) =>
        (
          (await app.inject({ method: 'GET', url: `/catalog/vendors?q=${encodeURIComponent(q)}&limit=100`, headers: auth(reader.token) })).json()
            .items as { id: string }[]
        ).map((v) => v.id)

      const byUnderscore = await ids(`Ф_${RUN}`)
      // До фикса: `_` — любой символ, находились обе.
      expect(byUnderscore).toContain(under.vendorId)
      expect(byUnderscore).not.toContain(other.vendorId)
      // До фикса: `%` — любая строка, находились обе (и вся категория).
      expect(await ids(`%${RUN}`)).toEqual([])
    })

    it('справочник городов: q=%% не отдаёт весь справочник, q=у_а не находит Уфу', async () => {
      const cities = async (q: string) =>
        (await app.inject({ method: 'GET', url: `/geo/cities?q=${encodeURIComponent(q)}` })).json() as { name: string }[]
      // До фикса: 12 городов на `%%` и Уфа на `у_а`.
      expect(await cities('%%')).toEqual([])
      expect((await cities('у_а')).map((c) => c.name)).not.toContain('Уфа')
      // Обычный запрос работает как раньше.
      expect((await cities('уфа')).map((c) => c.name)).toContain('Уфа')
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-13 · просмотры владельца не считаются
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-13 · просмотры анкеты', () => {
    it('владелец открыл карточку дважды — счётчик стоит; пара открыла — +1', async () => {
      const vendor = await newVendor('Самолюбующийся', 'photo')
      const reader = await newUser()
      const views = async () =>
        Number((await sql<{ views: string }>('select views::text as views from vendors where id = $1', [vendor.vendorId])).rows[0]!.views)
      const open = (token: string) =>
        app.inject({ method: 'GET', url: `/catalog/vendors/${vendor.vendorId}`, headers: auth(token) })

      const start = await views()
      expect((await open(vendor.token)).statusCode).toBe(200)
      expect((await open(vendor.token)).statusCode).toBe(200)
      // До фикса: +2 — свои открытия шли в «интерес пар».
      expect(await views()).toBe(start)
      expect((await open(reader.token)).statusCode).toBe(200)
      expect(await views()).toBe(start + 1)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-20 · лента отзывов, занятость и избранное — только у живой анкеты
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-20 · живость анкеты на всех путях', () => {
    it('заблокированная анкета: отзывы и занятость — 404; неизвестный id — 404, не `200 []`', async () => {
      const vendor = await newVendor('Заблокированный2', 'photo')
      const reader = await newUser()
      const get = (url: string) => app.inject({ method: 'GET', url, headers: auth(reader.token) })

      expect((await get(`/catalog/vendors/${vendor.vendorId}/reviews`)).statusCode).toBe(200)
      expect((await get(`/catalog/vendors/${vendor.vendorId}/availability`)).statusCode).toBe(200)
      await sql('update vendors set blocked_at = now() where id = $1', [vendor.vendorId])
      // До фикса: 200 и `[]` / календарь «всё свободно» по прямой ссылке.
      expect((await get(`/catalog/vendors/${vendor.vendorId}/reviews`)).statusCode).toBe(404)
      expect((await get(`/catalog/vendors/${vendor.vendorId}/availability`)).statusCode).toBe(404)
      expect((await get(`/catalog/vendors/${randomUUID()}/reviews`)).statusCode).toBe(404)
      expect((await get(`/catalog/vendors/${randomUUID()}/availability`)).statusCode).toBe(404)
    })

    it('снятая модератором анкета пропадает из избранного', async () => {
      const vendor = await newVendor('Снятый2', 'photo')
      const reader = await newUser()
      expect(
        (await app.inject({ method: 'PUT', url: `/me/favorites/${vendor.vendorId}`, headers: auth(reader.token) })).statusCode,
      ).toBe(204)
      const favorites = async () =>
        ((await app.inject({ method: 'GET', url: '/me/favorites', headers: auth(reader.token) })).json() as { id: string }[]).map(
          (v) => v.id,
        )
      expect(await favorites()).toContain(vendor.vendorId)

      await sql('update vendors set moderated_at = now(), published_at = null where id = $1', [vendor.vendorId])
      // До фикса: анкета оставалась в избранном, а карточка по ней отвечала 404.
      expect(await favorites()).not.toContain(vendor.vendorId)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-21 · жалоба: цель существует, на сделку — только её сторона
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-21 · POST /complaints', () => {
    it('несуществующая сделка — 404, чужая — 403, своя — 201 (пара и подрядчик сделки)', async () => {
      const vendor = await newVendor('Обжалуемый', 'photo')
      const w = await newWedding()
      const stranger = await newWedding()
      const { dealId } = await bookIn(w, 'photo', vendor.vendorId)
      const complain = (token: string, targetId: string) =>
        app.inject({
          method: 'POST',
          url: '/complaints',
          headers: auth(token),
          payload: { targetKind: 'deal', targetId, category: 'no_show' },
        })

      // До фикса: 201 на всё — очередь модератора получала мусор и чужие сделки.
      expect((await complain(w.token, randomUUID())).statusCode).toBe(404)
      expect((await complain(stranger.token, dealId)).statusCode).toBe(403)
      expect((await complain(w.token, dealId)).statusCode).toBe(201)
      expect((await complain(vendor.token, dealId)).statusCode).toBe(201)
      const { rows } = await sql<{ n: string }>(
        "select count(*)::text as n from complaints where target_kind = 'deal' and target_id = $1",
        [dealId],
      )
      expect(Number(rows[0]!.n)).toBe(2)
    })

    it('жалоба на сообщение — только из своего чата: чужой чат 404, свой — 201 (RF-BE-05)', async () => {
      const vendor = await newVendor('Переписывающийся', 'photo')
      const w = await newWedding()
      const stranger = await newWedding()
      const chat = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
      expect(chat.statusCode).toBe(200)
      const chatId = chat.json().id as string
      const sent = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/messages`,
        headers: auth(w.token),
        payload: { text: `Договоримся напрямую ${RUN}` },
      })
      expect(sent.statusCode).toBe(201)
      const messageId = sent.json().id as string
      const complain = (token: string) =>
        app.inject({
          method: 'POST',
          url: '/complaints',
          headers: auth(token),
          payload: { targetKind: 'message', targetId: messageId, category: 'spam' },
        })
      /* До фикса: 201 по идентификатору из чужого уведомления — модератор
         открывал бы переписку, к которой жалобщик доступа не имеет. */
      expect((await complain(stranger.token)).statusCode).toBe(404)
      expect((await complain(vendor.token)).statusCode).toBe(201)
      expect((await complain(w.token)).statusCode).toBe(201)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-22 · текст при decline/hold уходит в чат заявки
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-22 · ответ по лиду с текстом', () => {
    it('decline и hold с текстом — сообщения подрядчика в чате заявки', async () => {
      const vendor = await newVendor('Отказывающий', 'photo')
      const w = await newWedding()
      const chat = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
      expect(chat.statusCode).toBe(200)
      const chatId = chat.json().id as string
      const leads = (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
        id: string
      }[]
      const leadId = leads[0]!.id

      const act = (action: string, text: string) =>
        app.inject({ method: 'POST', url: `/vendor/leads/${leadId}`, headers: auth(vendor.token), payload: { action, text } })
      const declined = await act('decline', `Заняты на вашу дату ${RUN}`)
      expect(declined.statusCode).toBe(200)
      expect(declined.json().status).toBe('declined')
      const held = await act('hold', `Держим до ответа ${RUN}`)
      expect(held.statusCode).toBe(200)

      const { rows } = await sql<{ sender_id: string; text: string }>(
        'select sender_id, text from messages where chat_id = $1 order by created_at',
        [chatId],
      )
      // До фикса: текст читался только при `reply` — «отказ с причиной» выбрасывался.
      expect(rows.map((m) => m.text)).toEqual([`Заняты на вашу дату ${RUN}`, `Держим до ответа ${RUN}`])
      expect(rows.every((m) => m.sender_id === vendor.userId)).toBe(true)
    })

    it('заявка без чата: текст передать некуда — 422 text_not_allowed, состояние не меняется', async () => {
      const vendor = await newVendor('Бесчатный', 'photo')
      const w = await newWedding()
      const leadId = uuidv7()
      await sql("insert into leads (id, vendor_id, wedding_id, state) values ($1, $2, $3, 'new')", [
        leadId,
        vendor.vendorId,
        w.weddingId,
      ])
      const res = await app.inject({
        method: 'POST',
        url: `/vendor/leads/${leadId}`,
        headers: auth(vendor.token),
        payload: { action: 'decline', text: 'Не сможем' },
      })
      // До фикса: 200 и тишина — заявка отклонена, текст пропал.
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('text_not_allowed')
      const { rows } = await sql<{ state: string }>('select state from leads where id = $1', [leadId])
      expect(rows[0]!.state).toBe('new')
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * D5-26б · истёкший срок брони не показывается
   * ═══════════════════════════════════════════════════════════════════ */
  describe('D5-26б · holdUntil в кабинете', () => {
    it('negotiating_until в прошлом — holdUntil null; в будущем — срок', async () => {
      const vendor = await newVendor('Держащий', 'photo')
      const w = await newWedding()
      const { dealId } = await bookIn(w, 'photo', vendor.vendorId)
      const holdUntil = async () =>
        ((await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(vendor.token) })).json().items as {
          id: string
          holdUntil: string | null
        }[]).find((d) => d.id === dealId)!.holdUntil

      await sql("update deals set state = 'negotiating', negotiating_until = now() - interval '1 hour' where id = $1", [dealId])
      // До фикса: «держим до <прошедшее время>» до часа, пока не снимет фоновая задача.
      expect(await holdUntil()).toBeNull()
      await sql("update deals set negotiating_until = now() + interval '1 hour' where id = $1", [dealId])
      expect(await holdUntil()).not.toBeNull()
    })
  })
})
