import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { deliverAfter, knownTimeZone } from '../src/notify/quiet.js'
import { PUSH_LIMIT_PER_DAY } from '../src/notify/notify.js'

/**
 * Перепроверка этапа 7 по ОПИСАНИЮ, а не по критериям (R-56).
 *
 * Критерии проверяли открытие чата дня X и тихие часы. Про командный чат
 * «на второй сделке» и про лимит «3 в день» в них нет ни слова — а в составе
 * этапа они есть.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('часовой пояс из настроек — не любая строка', () => {
  it('мусор в поле tz не роняет расчёт', () => {
    // `PATCH /users/me` принимает любую строку до 64 символов. Неизвестная
    // зона роняла бы Intl, а с ним — каждое уведомление этому человеку.
    expect(knownTimeZone('Мордор/Барад-Дур')).toBe('Europe/Moscow')
    expect(knownTimeZone(null)).toBe('Europe/Moscow')
    expect(knownTimeZone('Asia/Krasnoyarsk')).toBe('Asia/Krasnoyarsk')

    const night = new Date('2027-06-01T20:00:00Z')
    expect(() => deliverAfter(night, 'Мордор/Барад-Дур', { from: '22:00', to: '09:00' })).not.toThrow()
  })
})

describe.skipIf(!live)('перепроверка этапа 7', () => {
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
  const key = () => ({ 'idempotency-key': randomUUID() })

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
    return token
  }

  async function newWedding(payload: Record<string, unknown> = {}) {
    const token = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: Object.fromEntries(
        Object.entries({
          partnerName: 'Тимур',
          date: '2027-06-14',
          city: { name: 'Казань', region: 'Татарстан' },
          budgetTotal: { amount: 200_000_000, currency: 'RUB' },
          ...payload,
          // `null` в теле — это не «без даты», а неверный тип: поле
          // с пустым значением просто не отправляется.
        }).filter(([, v]) => v !== null),
      ),
    })
    expect(w.statusCode).toBe(201)
    return { token, weddingId: w.json().id as string }
  }

  async function newVendor(name: string) {
    const token = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(token),
      payload: {
        name,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(token) })
    return { token, vendorId: created.json().id as string }
  }

  const chats = async (token: string) =>
    (await app.inject({ method: 'GET', url: '/chats', headers: auth(token) })).json() as {
      id: string
      kind: string
    }[]

  /* ── командный чат на второй сделке ───────────────────────────────── */
  it('командный чат появляется на ВТОРОЙ сделке, а не на первой', async () => {
    const w = await newWedding()
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const photoSlots = slots.filter((s) => s.categoryId === 'photo' || s.categoryId === 'video')
    expect(photoSlots.length).toBeGreaterThanOrEqual(2)

    const book = (slotId: string, vendorName: string) =>
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
        headers: { ...auth(w.token), ...key() },
        payload: { vendorName, price: { amount: 5_000_000, currency: 'RUB' } },
      })

    expect((await book(photoSlots[0]!.id, 'Первый')).statusCode).toBe(200)
    // С одним подрядчиком пара разговаривает в его чате — команды ещё нет.
    expect((await chats(w.token)).some((c) => c.kind === 'team')).toBe(false)

    expect((await book(photoSlots[1]!.id, 'Второй')).statusCode).toBe(200)
    // Людей стало несколько — появился общий чат (План §8.5).
    expect((await chats(w.token)).some((c) => c.kind === 'team')).toBe(true)
  })

  it('третья сделка не заводит второй командный чат', async () => {
    const w = await newWedding()
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string }[]
    for (const slot of slots.slice(0, 3)) {
      await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
        headers: { ...auth(w.token), ...key() },
        payload: { vendorName: 'Кто-то', price: { amount: 1_000_000, currency: 'RUB' } },
      })
    }
    const { rows } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from chats where wedding_id = $1 and kind = 'team'",
      [w.weddingId],
    )
    // Держит уникальный индекс, а не проверка в триггере.
    expect(Number(rows[0]!.n)).toBe(1)
  })

  /* ── лимит push в сутки ───────────────────────────────────────────── */
  it('свыше трёх уведомлений в сутки переносятся, а не теряются', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Много сообщений')
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string

    // Днём тихих часов нет, значит на срок влияет только лимит.
    await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(vendor.token),
      payload: { quietHours: { from: '00:00', to: '00:00' } },
    })

    for (let i = 0; i < 7; i++) {
      await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/messages`,
        headers: auth(w.token),
        payload: { text: `Сообщение ${i}` },
      })
    }

    const { rows } = await app.db!.query<{ day: string; n: string }>(
      `select date_trunc('day', deliver_after)::date::text as day, count(*)::text as n
         from notifications n
         join users u on u.id = n.user_id
        where n.user_id = (select user_id from vendors where id = $1)
        group by 1 order by 1`,
      [vendor.vendorId],
    )
    // Все семь новостей на месте: в приложении их видно сразу.
    expect(rows.reduce((sum, r) => sum + Number(r.n), 0)).toBe(7)
    // Но по суткам они разложены, а не свалены в один день: единственный
    // перенос «на завтра» сложил бы четыре из них в одни и те же сутки.
    expect(rows.every((r) => Number(r.n) <= PUSH_LIMIT_PER_DAY)).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })

  it('критичное уведомление лимита не знает', async () => {
    const w = await newWedding()
    const helper = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'helper', label: 'Катя' },
    })
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper) })

    await app.db!.query(
      `update timeline_events set starts_at = now() + interval '2 hours', ends_at = now() + interval '3 hours'
        where wedding_id = $1`,
      [w.weddingId],
    )
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/timeline/shift`,
        headers: { ...auth(w.token), ...key() },
        payload: { minutes: 5 },
      })
      expect(res.statusCode).toBe(200)
    }

    const { rows } = await app.db!.query<{ n: string; late: string }>(
      `select count(*)::text as n,
              count(*) filter (where deliver_after > now() + interval '1 minute')::text as late
         from notifications where kind = 'system' and user_id <> $1`,
      ['00000000-0000-0000-0000-000000000000'],
    )
    // День X не ждёт утра и не считает лимиты: гости уже в дороге.
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(5)
    expect(Number(rows[0]!.late)).toBe(0)
  })

  /* ── чат дня X без даты ───────────────────────────────────────────── */
  it('без даты свадьбы чат дня X закрыт, а не открыт настежь', async () => {
    const w = await newWedding({ date: null })
    const list = await chats(w.token)
    const day = list.find((c) => c.kind === 'day')!

    const write = await app.inject({
      method: 'POST',
      url: `/chats/${day.id}/messages`,
      headers: auth(w.token),
      payload: { text: 'Кто где?' },
    })
    // Пустое `opens_at` как «открыт» означало бы чат дня X за год до него.
    expect(write.statusCode).toBe(423)
    expect(write.json().error.code).toBe('wedding_date_unknown')
  })

  /* ── роли в чатах ─────────────────────────────────────────────────── */
  it('помощник видит команду и день X, но не переписку с подрядчиком', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Скрытый подрядчик')
    const vendorChat = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string

    const helper = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'helper', label: 'Катя' },
    })
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper) })

    const seen = await chats(helper)
    expect(seen.map((c) => c.kind).sort()).toEqual(['day'])

    const peek = await app.inject({
      method: 'GET',
      url: `/chats/${vendorChat}/messages`,
      headers: auth(helper),
    })
    // Он участник свадьбы и о существовании чатов знает — здесь честный 403.
    expect(peek.statusCode).toBe(403)
  })

  it('Тиль — только для пары', async () => {
    const w = await newWedding()
    const tilly = (await chats(w.token)).find((c) => c.kind === 'tilly')!.id
    const helper = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'coordinator', label: 'Координатор' },
    })
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper) })

    const peek = await app.inject({ method: 'GET', url: `/chats/${tilly}/messages`, headers: auth(helper) })
    expect(peek.statusCode).toBe(403)
  })

  /* ── «печатает…» ──────────────────────────────────────────────────── */
  it('индикатор «печатает…» честно говорит, что канала нет', async () => {
    const w = await newWedding()
    const tilly = (await chats(w.token)).find((c) => c.kind === 'tilly')!.id
    const res = await app.inject({ method: 'POST', url: `/chats/${tilly}/typing`, headers: auth(w.token) })
    // 204 означал бы «доставлено» о том, чего не произошло.
    expect(res.statusCode).toBe(501)
    expect(res.json().error.code).toBe('realtime_not_configured')
  })

  /* ── нулевой сдвиг ────────────────────────────────────────────────── */
  it('сдвиг на ноль минут — 422, а не выдуманный конфликт', async () => {
    const w = await newWedding()
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      headers: { ...auth(w.token), ...key() },
      payload: { minutes: 0 },
    })
    // Контракт у этого пути конфликта не обещает; 422 — общее соглашение.
    expect(res.statusCode).toBe(422)
  })

  it('сдвиг больше четырёх часов не принимается', async () => {
    const w = await newWedding()
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      headers: { ...auth(w.token), ...key() },
      payload: { minutes: 600 },
    })
    expect(res.statusCode).toBe(422)
  })

  /* ── вложения ─────────────────────────────────────────────────────── */
  it('вложением нельзя подсунуть javascript-ссылку', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Аккуратный')
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    const res = await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Смотрите', attachmentUrl: 'javascript:alert(1)' },
    })
    // ERR-0031 — то же самое в портфолио подрядчика.
    expect(res.statusCode).toBe(422)
  })

  /* ── удалённая свадьба ────────────────────────────────────────────── */
  it('после отмены свадьбы её чаты пропадают из списка', async () => {
    const w = await newWedding()
    expect((await chats(w.token)).length).toBeGreaterThan(0)
    await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })
    expect(await chats(w.token)).toEqual([])
  })
})
