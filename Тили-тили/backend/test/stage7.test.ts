import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { deliverAfter, parseTime } from '../src/notify/quiet.js'

/**
 * Этап 7: чаты, уведомления, режим дня X.
 *
 * Тихие часы проверяются чистой функцией, а не живым ночным прогоном:
 * решение «когда можно» не должно зависеть от времени запуска тестов.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('тихие часы — чистый расчёт', () => {
  const quiet = { from: '22:00', to: '09:00' }
  const msk = 'Europe/Moscow'
  const at = (iso: string) => new Date(iso)

  it('в 23:00 push откладывается на 09:00 следующего дня', () => {
    // 23:00 МСК = 20:00 UTC.
    const decided = deliverAfter(at('2027-06-01T20:00:00Z'), msk, quiet)
    // 09:00 МСК 2 июня = 06:00 UTC.
    expect(decided.toISOString()).toBe('2027-06-02T06:00:00.000Z')
  })

  it('в 03:00 откладывается на утро ТОГО ЖЕ дня, а не следующего', () => {
    // Ночь уже наступила: ждать сутки незачем.
    const decided = deliverAfter(at('2027-06-02T00:00:00Z'), msk, quiet)
    expect(decided.toISOString()).toBe('2027-06-02T06:00:00.000Z')
  })

  it('днём уходит сразу', () => {
    const noon = at('2027-06-01T09:00:00Z')
    expect(deliverAfter(noon, msk, quiet).toISOString()).toBe(noon.toISOString())
  })

  it('на границах: 22:00 уже тихо, 09:00 уже нет', () => {
    expect(deliverAfter(at('2027-06-01T19:00:00Z'), msk, quiet).toISOString()).toBe('2027-06-02T06:00:00.000Z')
    const nine = at('2027-06-01T06:00:00Z')
    expect(deliverAfter(nine, msk, quiet).toISOString()).toBe(nine.toISOString())
  })

  it('критичное идёт мимо тишины', () => {
    const night = at('2027-06-01T20:00:00Z')
    expect(deliverAfter(night, msk, quiet, true).toISOString()).toBe(night.toISOString())
  })

  it('таймзона считается по пользователю, а не по серверу', () => {
    // 23:00 в Москве — это 02:00 в Красноярске, тоже тишина, но конец её
    // наступит на четыре часа раньше по UTC.
    const decided = deliverAfter(at('2027-06-01T20:00:00Z'), 'Asia/Krasnoyarsk', quiet)
    expect(decided.toISOString()).toBe('2027-06-02T02:00:00.000Z')
  })

  it('пустое окно тишины не откладывает ничего', () => {
    const night = at('2027-06-01T20:00:00Z')
    expect(deliverAfter(night, msk, { from: '22:00', to: '22:00' }).toISOString()).toBe(night.toISOString())
  })

  it('время разбирается терпимо к мусору', () => {
    expect(parseTime('22:00')).toBe(1320)
    expect(parseTime('09:00:00')).toBe(540)
    expect(parseTime('нет')).toBe(0)
  })
})

describe.skipIf(!live)('этап 7: чаты, уведомления, день X', () => {
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
    return { token, userId: v.json().user?.id as string | undefined }
  }

  async function newWedding(date = '2027-06-14') {
    const { token } = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { token, weddingId: w.json().id as string }
  }

  const chats = (token: string) => app.inject({ method: 'GET', url: '/chats', headers: auth(token) })

  /* ── список чатов ─────────────────────────────────────────────────── */
  it('у новой свадьбы сразу есть чат дня X и Тиль', async () => {
    const w = await newWedding()
    const list = (await chats(w.token)).json() as { kind: string; openFrom: string | null; title: string }[]
    const kinds = list.map((c) => c.kind).sort()
    // Чат дня X виден заранее — «откроется 13 июня в 09:00» из моков.
    // Появись он только в срок, в списке до этого была бы пустота.
    expect(kinds).toEqual(['day', 'tilly'])

    const day = list.find((c) => c.kind === 'day')!
    // 09:00 накануне по московскому времени = 06:00 UTC 13 июня.
    expect(day.openFrom).toBe('2027-06-13T06:00:00.000Z')
  })

  it('перенос даты двигает открытие чата дня X', async () => {
    const w = await newWedding('2027-06-14')
    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { date: '2027-07-20' },
    })
    const list = (await chats(w.token)).json() as { kind: string; openFrom: string | null }[]
    expect(list.find((c) => c.kind === 'day')?.openFrom).toBe('2027-07-19T06:00:00.000Z')
  })

  it('до срока чат дня X закрыт — 423, а не 403', async () => {
    const w = await newWedding()
    const list = (await chats(w.token)).json() as { id: string; kind: string }[]
    const dayId = list.find((c) => c.kind === 'day')!.id

    const write = await app.inject({
      method: 'POST',
      url: `/chats/${dayId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Всем привет' },
    })
    // Доступ не запрещён — он ещё не наступил. Разница видна человеку.
    expect(write.statusCode).toBe(423)
    expect(write.json().error.code).toBe('chat_not_open_yet')
  })

  it('после наступления срока чат дня X открыт', async () => {
    const w = await newWedding()
    const list = (await chats(w.token)).json() as { id: string; kind: string }[]
    const dayId = list.find((c) => c.kind === 'day')!.id
    await app.db!.query("update chats set opens_at = now() - interval '1 hour' where id = $1", [dayId])

    const write = await app.inject({
      method: 'POST',
      url: `/chats/${dayId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Сбор в 15:00' },
    })
    expect(write.statusCode).toBe(201)
  })

  /* ── Тиль ─────────────────────────────────────────────────────────── */
  it('Тиль отвечает честно, а не молчит', async () => {
    const w = await newWedding()
    const list = (await chats(w.token)).json() as { id: string; kind: string }[]
    const tilly = list.find((c) => c.kind === 'tilly')!.id

    await app.inject({
      method: 'POST',
      url: `/chats/${tilly}/messages`,
      headers: auth(w.token),
      payload: { text: 'Что подарить свидетелю?' },
    })
    /* Тиль отвечает в фоне (фича 010): POST возвращает 201 раньше, чем заглушка
     * записана. Без ожидания лента начиналась с реплики пары, когда GET обгонял
     * фоновую вставку, — тест мигал (перенесено из PR №2; в CI этой ветки — запуск 36282911756). */
    await app.tilly.settle()
    const history = await app.inject({ method: 'GET', url: `/chats/${tilly}/messages`, headers: auth(w.token) })
    const items = history.json().items as { text: string; senderId: string | null }[]
    // Молчание выглядело бы как поломка, «думаю…» — как обман.
    expect(items[0]!.senderId).toBeNull()
    expect(items[0]!.text).toContain('без ИИ')
  })

  /* ── чат с подрядчиком ────────────────────────────────────────────── */
  async function newVendor(name = 'Елена Смирнова') {
    const { token } = await newUser()
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
    expect(
      (await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(token) })).statusCode,
    ).toBe(200)
    return { token, vendorId: created.json().id as string }
  }

  it('«Написать» дважды открывает тот же чат', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const first = await app.inject({
      method: 'POST',
      url: `/chats/vendor/${vendor.vendorId}`,
      headers: auth(w.token),
    })
    expect(first.statusCode).toBe(200)
    const second = await app.inject({
      method: 'POST',
      url: `/chats/vendor/${vendor.vendorId}`,
      headers: auth(w.token),
    })
    // Второе нажатие — не второй чат. Держит уникальный индекс.
    expect(second.json().id).toBe(first.json().id)
    expect(second.json().title).toBe('Елена Смирнова')
  })

  it('подрядчик видит свой чат и не видит чужих', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Артём Краснов')
    const chat = await app.inject({
      method: 'POST',
      url: `/chats/vendor/${vendor.vendorId}`,
      headers: auth(w.token),
    })
    const mine = (await chats(vendor.token)).json() as { id: string; kind: string }[]
    expect(mine.map((c) => c.id)).toEqual([chat.json().id])
    // Чат дня X и Тиль подрядчику не показываются вовсе.
    expect(mine.every((c) => c.kind === 'vendor')).toBe(true)
  })

  /* ── переписка и непрочитанные ────────────────────────────────────── */
  it('непрочитанные считаются на каждого читателя отдельно', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const chat = await app.inject({
      method: 'POST',
      url: `/chats/vendor/${vendor.vendorId}`,
      headers: auth(w.token),
    })
    const chatId = chat.json().id as string

    for (const text of ['Здравствуйте!', 'Свободны 14 июня?']) {
      const sent = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/messages`,
        headers: auth(w.token),
        payload: { text },
      })
      expect(sent.statusCode).toBe(201)
    }

    const forVendor = (await chats(vendor.token)).json() as { unread: number; lastMessage: string }[]
    expect(forVendor[0]).toMatchObject({ unread: 2, lastMessage: 'Свободны 14 июня?' })
    // Свои сообщения непрочитанными не считаются.
    const forCouple = (await chats(w.token)).json() as { kind: string; unread: number }[]
    expect(forCouple.find((c) => c.kind === 'vendor')?.unread).toBe(0)

    await app.inject({ method: 'GET', url: `/chats/${chatId}/messages`, headers: auth(vendor.token) })
    const afterRead = (await chats(vendor.token)).json() as { unread: number }[]
    expect(afterRead[0]!.unread).toBe(0)
  })

  it('история листается курсором от свежих к старым', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    for (const text of ['раз', 'два', 'три']) {
      await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/messages`,
        headers: auth(w.token),
        payload: { text },
      })
    }

    const first = await app.inject({
      method: 'GET',
      url: `/chats/${chatId}/messages?limit=2`,
      headers: auth(w.token),
    })
    expect((first.json().items as { text: string }[]).map((m) => m.text)).toEqual(['три', 'два'])
    const next = await app.inject({
      method: 'GET',
      url: `/chats/${chatId}/messages?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: auth(w.token),
    })
    // Вторая страница не повторяет и не пропускает — ERR-0033 про это.
    expect((next.json().items as { text: string }[]).map((m) => m.text)).toEqual(['раз'])
  })

  it('чужой чат не открывается', async () => {
    const mine = await newWedding()
    const other = await newWedding()
    const vendor = await newVendor()
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(other.token) })
    ).json().id as string

    const peek = await app.inject({ method: 'GET', url: `/chats/${chatId}/messages`, headers: auth(mine.token) })
    // 404, а не 403: по кодам не должно быть видно, какие чаты существуют.
    expect(peek.statusCode).toBe(404)
  })

  /* ── уведомления ──────────────────────────────────────────────────── */
  it('сообщение рождает уведомление у собеседника, но не у автора', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Добрый день!' },
    })

    const forVendor = (
      await app.inject({ method: 'GET', url: '/notifications', headers: auth(vendor.token) })
    ).json() as { kind: string; body: string; read: boolean; id: string }[]
    expect(forVendor).toHaveLength(1)
    expect(forVendor[0]).toMatchObject({ kind: 'chat', body: 'Добрый день!', read: false })

    const forAuthor = (
      await app.inject({ method: 'GET', url: '/notifications', headers: auth(w.token) })
    ).json() as unknown[]
    expect(forAuthor).toHaveLength(0)

    const read = await app.inject({
      method: 'POST',
      url: `/notifications/${forVendor[0]!.id}/read`,
      headers: auth(vendor.token),
    })
    expect(read.statusCode).toBe(204)
    const after = (
      await app.inject({ method: 'GET', url: '/notifications', headers: auth(vendor.token) })
    ).json() as { read: boolean }[]
    expect(after[0]!.read).toBe(true)
  })

  it('выключенный вид уведомлений не создаёт записей', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(vendor.token),
      payload: { push: { chats: false } },
    })
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Тишина' },
    })

    const forVendor = (
      await app.inject({ method: 'GET', url: '/notifications', headers: auth(vendor.token) })
    ).json() as unknown[]
    expect(forVendor).toHaveLength(0)
  })

  /* ── push ─────────────────────────────────────────────────────────── */
  it('подписка на push честно отвечает 501, пока нет ключей', async () => {
    const { token } = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/push-subscriptions',
      headers: auth(token),
      payload: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'k', auth: 'a' },
      },
    })
    // Принять подписку и промолчать значило бы показать «уведомления
    // включены» там, где их не будет.
    expect(res.statusCode).toBe(501)
    expect(res.json().error.code).toBe('push_not_configured')

    // А отписаться можно всегда: «выключить» не должно упираться в то,
    // что «включить» пока нельзя.
    const off = await app.inject({ method: 'DELETE', url: '/users/me/push-subscriptions', headers: auth(token) })
    expect(off.statusCode).toBe(204)
  })

  /* ── день X ───────────────────────────────────────────────────────── */
  it('сдвиг тайминга двигает будущие блоки и не трогает прошедшие', async () => {
    const w = await newWedding()
    await app.db!.query(
      `update timeline_events set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
        where wedding_id = $1 and sort = (select min(sort) from timeline_events where wedding_id = $1)`,
      [w.weddingId],
    )
    await app.db!.query(
      `update timeline_events set starts_at = now() + interval '2 hours', ends_at = now() + interval '3 hours'
        where wedding_id = $1 and sort > (select min(sort) from timeline_events where wedding_id = $1)`,
      [w.weddingId],
    )

    const before = await app.db!.query<{ starts_at: Date }>(
      'select starts_at from timeline_events where wedding_id = $1 order by sort limit 1',
      [w.weddingId],
    )
    const shift = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      headers: { ...auth(w.token), ...key() },
      payload: { minutes: 15 },
    })
    expect(shift.statusCode).toBe(200)
    expect(shift.json().minutes).toBe(15)
    expect(shift.json().shiftedBlocks).toBeGreaterThan(0)

    const after = await app.db!.query<{ starts_at: Date }>(
      'select starts_at from timeline_events where wedding_id = $1 order by sort limit 1',
      [w.weddingId],
    )
    // Церемония, которая уже прошла, не сдвигается от того, что банкет
    // задержался — иначе в расписании поедет всё.
    expect(after.rows[0]!.starts_at.getTime()).toBe(before.rows[0]!.starts_at.getTime())
  })

  it('повтор сдвига с тем же ключом не двигает дважды', async () => {
    const w = await newWedding()
    await app.db!.query(
      `update timeline_events set starts_at = now() + interval '2 hours', ends_at = now() + interval '3 hours'
        where wedding_id = $1`,
      [w.weddingId],
    )
    const headers = { ...auth(w.token), ...key() }
    const first = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      headers,
      payload: { minutes: 15 },
    })
    const again = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      headers,
      payload: { minutes: 15 },
    })
    expect(again.statusCode).toBe(200)
    expect(again.headers['idempotent-replay']).toBe('true')

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from timeline_shifts where wedding_id = $1',
      [w.weddingId],
    )
    expect({ первый: first.statusCode, записей: Number(rows[0]!.n) }).toEqual({ первый: 200, записей: 1 })
  })

  it('план Б включается и запоминает сценарий', async () => {
    const w = await newWedding()
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/planb/activate`,
      headers: { ...auth(w.token), ...key() },
      payload: { scenario: 'rain' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().scenario).toBe('rain')

    const { rows } = await app.db!.query<{ planb_scenario: string; action: string }>(
      `select w.planb_scenario, b.action from weddings w
         join broadcasts b on b.wedding_id = w.id where w.id = $1`,
      [w.weddingId],
    )
    expect(rows[0]).toMatchObject({ planb_scenario: 'rain', action: 'planb:rain' })
  })

  it('выдуманный сценарий плана Б не принимается', async () => {
    const w = await newWedding()
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/planb/activate`,
      headers: { ...auth(w.token), ...key() },
      payload: { scenario: 'нашествие' },
    })
    expect(res.statusCode).toBe(422)
  })
})
