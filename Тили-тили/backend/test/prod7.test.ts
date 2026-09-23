import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { isRealDate, weddingDateRange } from '../src/wedding/dates.js'

/**
 * Даты и календари.
 *
 * Две беды сразу. Первая: `PATCH /weddings` менял дату мимо переноса —
 * занятость подрядчика оставалась на дне, которого больше нет, а на
 * настоящий день свадьбы у него было пусто, и эту дату успевала занять
 * другая пара. Вторая: шаблон `\d{4}-\d{2}-\d{2}` пропускал 30 февраля,
 * и такая строка роняла запрос в базе — 500 вместо внятного отказа.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('календарная арифметика', () => {
  it('30 февраля не бывает, а 29 февраля в високосный год бывает', () => {
    expect(isRealDate('2027-02-30')).toBe(false)
    expect(isRealDate('2027-13-45')).toBe(false)
    expect(isRealDate('2027-04-31')).toBe(false)
    expect(isRealDate('0000-01-01')).toBe(false)
    expect(isRealDate('2028-02-29')).toBe(true)
    expect(isRealDate('2027-02-28')).toBe(true)
  })

  it('диапазон — год назад и пять лет вперёд', () => {
    const { from, to } = weddingDateRange(new Date('2026-09-03T12:00:00Z'))
    // Решение владельца 2026-09-03: назад — ради раздела «После свадьбы»,
    // вперёд — дальше площадки бронь не держат.
    expect(from).toBe('2025-09-03')
    expect(to).toBe('2031-09-03')
  })
})

describe.skipIf(!live)('прод: дата свадьбы и её последствия', () => {
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

  async function newUser() {
    const phone = nextPhone()
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

  async function newWedding(date: string | null = '2027-06-14') {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        ...(date ? { date } : {}),
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
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
        name: `Студия ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  async function book(w: { token: string; weddingId: string }, vendorId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'photo')!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
  }

  const busyDates = async (vendorId: string) => {
    const { rows } = await app.db!.query<{ date: string }>(
      'select date::text as date from vendor_busy_dates where vendor_id = $1 order by date',
      [vendorId],
    )
    return rows.map((r) => r.date)
  }

  /* ── перенос через PATCH ──────────────────────────────────────────── */
  it('правка даты двигает занятость подрядчика, сроки задач и тайминг', async () => {
    const w = await newWedding('2027-06-14')
    const vendor = await newVendor()
    await book(w, vendor.vendorId)
    expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-14'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { date: '2028-08-08' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().date).toBe('2028-08-08')

    /* Раньше здесь менялась только колонка. Подрядчик оставался занят
     * на 14 июня, а 8 августа у него было СВОБОДНО — и этот день успевала
     * занять другая пара, ровно на настоящую свадьбу. */
    expect(await busyDates(vendor.vendorId)).toEqual(['2028-08-08'])

    const { rows: tasks } = await app.db!.query<{ max: string }>(
      'select max(due)::text as max from tasks where wedding_id = $1',
      [w.weddingId],
    )
    // Сроки чек-листа считались от старой даты — уехали на ту же разницу.
    expect(tasks[0]!.max! > '2028-01-01').toBe(true)

    const { rows: timeline } = await app.db!.query<{ day: string }>(
      'select min(starts_at)::date::text as day from timeline_events where wedding_id = $1',
      [w.weddingId],
    )
    expect(timeline[0]!.day).toBe('2028-08-08')

    const { rows: chat } = await app.db!.query<{ opens: string }>(
      "select opens_at::date::text as opens from chats where wedding_id = $1 and kind = 'day'",
      [w.weddingId],
    )
    expect(chat[0]!.opens).toBe('2028-08-07')
  })

  it('правка даты на занятую подрядчиком — 409, и ничего не сдвинулось', async () => {
    const vendor = await newVendor()
    const first = await newWedding('2027-06-14')
    await book(first, vendor.vendorId)

    const second = await newWedding('2027-07-20')
    await book(second, vendor.vendorId)

    const clash = await app.inject({
      method: 'PATCH',
      url: `/weddings/${second.weddingId}`,
      headers: auth(second.token),
      payload: { date: '2027-06-14' },
    })
    /* Частичный перенос хуже отказа: половина команды осталась бы
     * на старой дате, и выяснилось бы это в день свадьбы. */
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.code).toBe('team_busy')

    const { rows } = await app.db!.query<{ date: string }>('select date::text as date from weddings where id = $1', [
      second.weddingId,
    ])
    expect(rows[0]!.date).toBe('2027-07-20')
  })

  it('дата, назначенная позже, занимает календарь подрядчика', async () => {
    const w = await newWedding(null)
    const vendor = await newVendor()
    await book(w, vendor.vendorId)
    // Даты не было — занимать было нечего, и это верно.
    expect(await busyDates(vendor.vendorId)).toEqual([])

    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { date: '2027-09-19' },
    })
    // А как появилась — подрядчик занят. Раньше он оставался свободным.
    expect(await busyDates(vendor.vendorId)).toEqual(['2027-09-19'])
  })

  it('правка города и бюджета дату не трогает', async () => {
    const w = await newWedding('2027-06-14')
    const vendor = await newVendor()
    await book(w, vendor.vendorId)

    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { city: { name: 'Красноярск', region: 'Красноярский край' }, guestsPlanned: 90 },
    })
    // Перенос запускается только правкой даты, а не любым PATCH.
    expect(await busyDates(vendor.vendorId)).toEqual(['2027-06-14'])
  })

  /* ── несуществующие и невозможные даты ────────────────────────────── */
  it('30 февраля — 422 везде, где принимается дата', async () => {
    const w = await newWedding('2027-06-14')
    const vendor = await newVendor()

    const cases = [
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/reschedule`,
        headers: { ...auth(w.token), ...key() },
        payload: { date: '2027-02-30' },
      }),
      app.inject({
        method: 'POST',
        url: '/vendor/calendar/busy',
        headers: auth(vendor.token),
        payload: { dates: ['2027-13-45'], status: 'busy' },
      }),
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/logistics/hotels`,
        headers: auth(w.token),
        payload: { name: 'Отель', rooms: 5, deadline: '2027-02-30' },
      }),
      app.inject({
        method: 'GET',
        url: '/catalog/vendors?date=2027-04-31',
        headers: auth(w.token),
      }),
    ]
    for (const res of await Promise.all(cases)) {
      // Раньше каждый из четырёх отвечал 500: строка доходила до PostgreSQL.
      expect({ code: res.statusCode, body: res.json().error?.code }).toEqual({ code: 422, body: 'bad_date' })
    }
  })

  it('свадьба в нулевом году и в 9999-м не заводится', async () => {
    const user = await newUser()
    for (const date of ['0001-01-01', '9999-12-31', '2000-01-01']) {
      const res = await app.inject({
        method: 'POST',
        url: '/weddings',
        headers: auth(user.token),
        payload: { partnerName: 'Т', date, city: { name: 'Казань', region: 'Татарстан' } },
      })
      /* `0001-01-01` раньше давал 500: срок задачи уезжал в нулевой год,
       * которого в PostgreSQL нет. Остальные две принимались молча. */
      expect({ date, code: res.statusCode }).toEqual({ date, code: 422 })
    }
  })

  it('вчерашняя свадьба заводится, позапрошлогодняя — нет', async () => {
    const day = (shift: number) => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + shift)
      return d.toISOString().slice(0, 10)
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth((await newUser()).token),
      payload: { partnerName: 'Т', date: day(-1), city: { name: 'Казань', region: 'Татарстан' } },
    })
    /* Прошедшая дата нужна: раздел «После свадьбы» и отзывы работают
     * и у тех, кто пришёл в приложение уже после праздника. */
    expect(ok.statusCode).toBe(201)

    const tooOld = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth((await newUser()).token),
      payload: { partnerName: 'Т', date: day(-400), city: { name: 'Казань', region: 'Татарстан' } },
    })
    expect(tooOld.statusCode).toBe(422)
    expect(tooOld.json().error.code).toBe('date_out_of_range')
  })
})
