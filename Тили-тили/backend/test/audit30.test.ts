import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Ревью старого кода (2026-09-11), домены Д2–Д5: чаты, гости, подарки,
 * логистика, день X, уведомления. Каждый тест — одна находка ревью и
 * был красным до её закрытия; номер находки стоит в имени.
 *
 * База общая с соседними наборами (R-177/R-226/R-227): каждый тест заводит
 * свою свадьбу и смотрит только на свои строки — по своим идентификаторам,
 * а не по счётчикам общей выдачи.
 *
 * Гонки «прочитали, проверили, записали» (D3-13) воспроизводятся
 * детерминированно: тест держит блокировку строки, запрос обработчика
 * упирается в неё на `delete`, тест меняет строку и отпускает — и
 * PostgreSQL перепроверяет условие `where` по НОВОЙ версии строки
 * (READ COMMITTED). Условие только по идентификатору проходит, условие
 * по владельцу/сумме — нет. Так гонка проверяется без случайности.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isoDay = (shiftDays: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + shiftDays)
  return d.toISOString().slice(0, 10)
}

describe.skipIf(!live)('ревью старого кода: чаты, гости, подарки, день X', () => {
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
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: body.accessToken, userId: body.user.id }
  }

  async function newWedding(opts: { partnerName?: string; date?: string } = {}) {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: opts.partnerName ?? 'Тимур',
        date: opts.date ?? '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  type Wedding = Awaited<ReturnType<typeof newWedding>>

  /** Приглашает пользователя `token` в команду свадьбы с ролью. */
  async function joinAs(w: Wedding, role: 'helper' | 'coordinator', token: string) {
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role, label: 'Ревью' },
    })
    expect(invite.statusCode, invite.body.slice(0, 200)).toBe(201)
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code as string}/accept`,
      headers: auth(token),
    })
    expect(accepted.statusCode, accepted.body.slice(0, 200)).toBe(200)
  }

  /** Гость с личным токеном — так, как его получает живой человек. */
  async function newGuest(w: Wedding, name = 'Ольга', plusOne = false, group?: string) {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name, plusOne, ...(group ? { group } : {}) },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const guestId = created.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode, link.body.slice(0, 200)).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode, exchanged.body.slice(0, 200)).toBe(200)
    return { guestId, token: exchanged.json().guestToken as string, code }
  }

  async function newVendor(name = 'Фотограф') {
    const user = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `${name} ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: created.json().id as string }
  }

  async function firstSlot(w: Wedding, categoryId = 'photo') {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    return (slots.find((s) => s.categoryId === categoryId) ?? slots[0]!).id
  }

  async function bookVendor(w: Wedding, vendorId: string) {
    const slotId = await firstSlot(w)
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
  }

  async function newBus(w: Wedding, seats: number) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: `Автобус ${RUN}-${++counter}`, seats },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  async function newHotel(w: Wedding, rooms: number, deadline?: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/hotels`,
      headers: auth(w.token),
      payload: { name: `Отель ${RUN}-${++counter}`, rooms, ...(deadline ? { deadline } : {}) },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  async function newGift(w: Wedding, name: string, group = false) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/wishlist`,
      headers: auth(w.token),
      payload: { name, price: { amount: 1_000_000, currency: 'RUB' }, group },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  const reserve = (guestToken: string, giftId: string) =>
    app.inject({ method: 'POST', url: `/gifts/${guestToken}/${giftId}/reserve`, headers: key() })

  const patchGuest = (w: Wedding, guestId: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/guests/${guestId}`, headers: auth(w.token), payload })

  const notificationsOf = async (token: string) =>
    (await app.inject({ method: 'GET', url: '/notifications', headers: auth(token) })).json() as {
      title: string
      body: string
      kind: string
    }[]

  /* ── чаты ─────────────────────────────────────────────────────────── */

  it('D4-03: заблокированный подрядчик не пишет и не читает свои чаты — 403', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const chat = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    expect(chat.statusCode).toBe(200)
    const chatId = chat.json().id as string

    // Модератор заблокировал анкету — высшая санкция (План §18.2).
    await app.db!.query('update vendors set blocked_at = now() where id = $1', [vendor.vendorId])

    const sent = await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(vendor.token),
      payload: { text: `Пишу после блокировки ${RUN}` },
    })
    expect({ status: sent.statusCode, code: sent.json().error?.code }).toEqual({ status: 403, code: 'vendor_blocked' })
    const read = await app.inject({ method: 'GET', url: `/chats/${chatId}/messages`, headers: auth(vendor.token) })
    expect(read.statusCode).toBe(403)

    // Пара свою переписку не теряет: заблокирован он, а не она.
    const own = await app.inject({ method: 'GET', url: `/chats/${chatId}/messages`, headers: auth(w.token) })
    expect(own.statusCode).toBe(200)
  })

  it('D4-03: паре «Написать» заблокированному подрядчику — 404, лид не заводится', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await app.db!.query('update vendors set blocked_at = now() where id = $1', [vendor.vendorId])

    const res = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    expect(res.statusCode).toBe(404)
    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from leads where vendor_id = $1 and wedding_id = $2',
      [vendor.vendorId, w.weddingId],
    )
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('D4-14: координатору в двух свадьбах общие чаты подписаны названием свадьбы', async () => {
    const a = await newWedding({ partnerName: `Тимур ${RUN}` })
    const b = await newWedding({ partnerName: `Руслан ${RUN}` })
    const coordinator = await newUser()
    await joinAs(a, 'coordinator', coordinator.token)

    const listChats = async () =>
      (await app.inject({ method: 'GET', url: '/chats', headers: auth(coordinator.token) })).json() as {
        kind: string
        title: string
      }[]

    // Одна свадьба — заголовок без имени: уточнять нечего.
    const single = (await listChats()).filter((c) => c.kind === 'day').map((c) => c.title)
    expect(single).toEqual(['Чат дня X · гости'])

    await joinAs(b, 'coordinator', coordinator.token)
    const titles = (await listChats()).filter((c) => c.kind === 'day').map((c) => c.title)
    expect(titles).toHaveLength(2)
    // Пять одинаковых строк «Чат дня X · гости» не различить — имя свадьбы обязано быть в каждой.
    expect(titles.some((t) => t.includes(`Тимур ${RUN}`))).toBe(true)
    expect(titles.some((t) => t.includes(`Руслан ${RUN}`))).toBe(true)
  })

  it('D4-20: повторное «Написать» отдаёт настоящий unread, а не ноль', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const first = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    const chatId = first.json().id as string

    const answered = await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(vendor.token),
      payload: { text: 'Свободен, давайте обсудим' },
    })
    expect(answered.statusCode).toBe(201)

    const again = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    expect(again.statusCode).toBe(200)
    const listed = (
      (await app.inject({ method: 'GET', url: '/chats', headers: auth(w.token) })).json() as { id: string; unread: number }[]
    ).find((c) => c.id === chatId)!
    // Список и ответ «Написать» — одно число одного подзапроса.
    expect({ again: again.json().unread, listed: listed.unread }).toEqual({ again: 1, listed: 1 })
  })

  /* ── гости ────────────────────────────────────────────────────────── */

  it('D3-07: повторный обмен кода в окне 10 минут отдаёт тот же токен, позже — 410', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Ольга' },
    })
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id as string}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!

    const first = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(first.statusCode).toBe(200)
    // Ответ потерялся в сети — гость нажал «Повторить». Тот же код, тот же токен.
    const retry = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect({ status: retry.statusCode, sameToken: retry.json().guestToken === first.json().guestToken }).toEqual({
      status: 200,
      sameToken: true,
    })

    await app.db!.query("update guest_invite_codes set used_at = now() - interval '11 minutes' where code = $1", [code])
    expect((await app.inject({ method: 'GET', url: `/invite/${code}` })).statusCode).toBe(410)
  })

  it('D3-07: перевыпуск ссылки закрывает окно повтора у прежнего кода', async () => {
    const w = await newWedding()
    const guest = await newGuest(w, 'Катя')
    const reissued = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guest.guestId}/invite-link`,
      headers: auth(w.token),
    })
    expect(reissued.statusCode).toBe(200)
    // Старая ссылка могла уйти не туда: после перевыпуска она не отдаёт
    // ни старый, ни новый токен — даже внутри десяти минут.
    expect((await app.inject({ method: 'GET', url: `/invite/${guest.code}` })).statusCode).toBe(410)

    const code2 = (reissued.json().url as string).split('/').pop()!
    const first = await app.inject({ method: 'GET', url: `/invite/${code2}` })
    const retry = await app.inject({ method: 'GET', url: `/invite/${code2}` })
    expect([first.statusCode, retry.statusCode]).toEqual([200, 200])
    expect(retry.json().guestToken).toBe(first.json().guestToken)
    expect(retry.json().guestToken).not.toBe(guest.token)
  })

  it('D3-08: «не придёт» рукой пары снимает автобус и номер гостя', async () => {
    const w = await newWedding()
    const guest = await newGuest(w, 'Бабушка')
    const busId = await newBus(w, 20)
    const hotelId = await newHotel(w, 5)
    expect(
      (await app.inject({ method: 'POST', url: `/join/${guest.token}/shuttle`, headers: key(), payload: { busId } })).statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ method: 'POST', url: `/join/${guest.token}/hotels`, headers: key(), payload: { hotelId } })).statusCode,
    ).toBe(200)

    // Бабушка без смартфона — пара вносит ответ вручную (План §19.5).
    const res = await patchGuest(w, guest.guestId, { status: 'no' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'no', busId: null, hotelId: null })

    const buses = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/logistics/buses`, headers: auth(w.token) })
    ).json() as { id: string; taken: number }[]
    const hotels = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/logistics/hotels`, headers: auth(w.token) })
    ).json() as { id: string; booked: number }[]
    expect({
      taken: buses.find((b) => b.id === busId)!.taken,
      booked: hotels.find((h) => h.id === hotelId)!.booked,
    }).toEqual({ taken: 0, booked: 0 })
  })

  it('D3-03: стол считает персоны — гость с +1 занимает два места', async () => {
    const w = await newWedding()
    const table = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name: 'Стол молодых друзей', capacity: 2 },
    })
    const tableId = table.json().id as string
    const olga = await newGuest(w, 'Ольга', true)
    const denis = await newGuest(w, 'Денис')

    expect((await patchGuest(w, olga.guestId, { tableId })).statusCode).toBe(200)
    // «Ольга и Денис» с +1 — двое за столом (R-29). Третьему места нет.
    const full = await patchGuest(w, denis.guestId, { tableId })
    expect({ status: full.statusCode, code: full.json().error?.code }).toEqual({ status: 409, code: 'table_full' })
    // Повторная посадка той же Ольги за тот же стол — не второе место: она уже там.
    expect((await patchGuest(w, olga.guestId, { tableId })).statusCode).toBe(200)
    // Плюс-один, присланный вместе с посадкой, считается сразу: Денис «с +1» за стол на двоих не сядет и один.
    await patchGuest(w, olga.guestId, { tableId: null })
    const withPlusOne = await patchGuest(w, denis.guestId, { tableId, plusOne: true })
    expect(withPlusOne.statusCode).toBe(200)
    const back = await patchGuest(w, olga.guestId, { tableId })
    expect({ status: back.statusCode, code: back.json().error?.code }).toEqual({ status: 409, code: 'table_full' })

    const tables = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/tables`, headers: auth(w.token) })
    ).json() as { id: string; guestIds: string[] }[]
    expect(tables.find((t) => t.id === tableId)!.guestIds).toEqual([denis.guestId])
  })

  it('D3-09/D5-04: перевыпуск ссылки переносит отзыв гостя — второго отзыва не будет', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await bookVendor(w, vendor.vendorId)
    await app.db!.query('update weddings set date = current_date - 1 where id = $1', [w.weddingId])
    const guest = await newGuest(w, 'Аня')

    const leave = (token: string, stars: number) =>
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${encodeURIComponent(token)}`,
        payload: { vendorId: vendor.vendorId, stars, text: 'Было здорово' },
      })
    expect((await leave(guest.token, 5)).statusCode).toBe(201)

    const reissued = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guest.guestId}/invite-link`,
      headers: auth(w.token),
    })
    const code2 = (reissued.json().url as string).split('/').pop()!
    const token2 = (await app.inject({ method: 'GET', url: `/invite/${code2}` })).json().guestToken as string
    expect((await leave(token2, 3)).statusCode).toBe(201)

    const { rows } = await app.db!.query<{ n: string; stars: number }>(
      `select count(*)::text as n, max(stars) as stars from reviews
        where wedding_id = $1 and vendor_id = $2 and source = 'guest'`,
      [w.weddingId, vendor.vendorId],
    )
    // Тот же гость — правка своего отзыва, а не второй голос в рейтинг.
    expect({ штук: Number(rows[0]!.n), звёзд: rows[0]!.stars }).toEqual({ штук: 1, звёзд: 3 })
  })

  it('D3-10: PATCH {group: null} снимает группу', async () => {
    const w = await newWedding()
    const guest = await newGuest(w, 'Марат', false, 'Родня')
    const res = await patchGuest(w, guest.guestId, { group: null })
    expect({ status: res.statusCode, group: res.json().group }).toEqual({ status: 200, group: null })
  })

  /* ── подарки ──────────────────────────────────────────────────────── */

  it('D3-13: снятие резерва не стирает чужой — условие по токену в самом delete', async () => {
    const w = await newWedding()
    const giftId = await newGift(w, `Тостер ${RUN}`)
    const anna = await newGuest(w, 'Анна')
    const boris = await newGuest(w, 'Борис')
    expect((await reserve(anna.token, giftId)).statusCode).toBe(200)

    let pending!: Promise<{ statusCode: number }>
    await app.db!.tx(async (client) => {
      await client.query('select 1 from gift_reservations where gift_id = $1 for update', [giftId])
      pending = Promise.resolve().then(() => app.inject({ method: 'DELETE', url: `/gifts/${anna.token}/${giftId}/reserve` }))
      await sleep(300)
      // Пока запрос Анны ждёт: во второй вкладке она резерв уже сняла, и Борис занял подарок.
      await client.query('update gift_reservations set guest_token = $2 where gift_id = $1', [giftId, boris.token])
    })
    const res = await pending

    const { rows } = await app.db!.query<{ guest_token: string }>(
      'select guest_token from gift_reservations where gift_id = $1',
      [giftId],
    )
    expect({ holder: rows[0]?.guest_token === boris.token, status: res.statusCode }).toEqual({ holder: true, status: 403 })
  })

  it('D3-13: удаление подарка не уносит взнос, пришедший между проверкой и удалением', async () => {
    const w = await newWedding()
    const giftId = await newGift(w, `Велосипед ${RUN}`, true)
    const guest = await newGuest(w, 'Зоя')

    let pending!: Promise<{ statusCode: number; json(): { error?: { code: string } } }>
    await app.db!.tx(async (client) => {
      await client.query('select 1 from gifts where id = $1 for update', [giftId])
      pending = Promise.resolve().then(() =>
        app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/wishlist/${giftId}`, headers: auth(w.token) }),
      )
      await sleep(300)
      await client.query(
        'insert into gift_contributions (id, gift_id, guest_token, amount, idempotency_key) values ($1,$2,$3,$4,$5)',
        [randomUUID(), giftId, guest.token, 300_000, randomUUID()],
      )
    })
    const res = await pending
    // 204 здесь означало бы, что подарок удалён вместе с чужими деньгами.
    expect(res.statusCode).toBe(409)
    expect(res.json().error?.code).toBe('gift_has_contributions')
    const { rows } = await app.db!.query<{ funded: string }>('select funded::text as funded from gifts where id = $1', [giftId])
    // Деньги гостей на месте, подарок на месте.
    expect(rows[0]?.funded).toBe('300000')
  })

  it('D3-13: удаление фонда не уносит взнос, пришедший между проверкой и удалением', async () => {
    const w = await newWedding()
    const fund = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: `На путешествие ${RUN}`, target: { amount: 10_000_000, currency: 'RUB' } },
    })
    const fundId = fund.json().id as string
    const guest = await newGuest(w, 'Игорь')

    let pending!: Promise<{ statusCode: number; json(): { error?: { code: string } } }>
    await app.db!.tx(async (client) => {
      await client.query('select 1 from funds where id = $1 for update', [fundId])
      pending = Promise.resolve().then(() =>
        app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/funds/${fundId}`, headers: auth(w.token) }),
      )
      await sleep(300)
      await client.query(
        'insert into fund_contributions (id, fund_id, guest_token, amount, idempotency_key) values ($1,$2,$3,$4,$5)',
        [randomUUID(), fundId, guest.token, 500_000, randomUUID()],
      )
    })
    const res = await pending
    expect(res.statusCode).toBe(409)
    expect(res.json().error?.code).toBe('fund_has_contributions')
    const { rows } = await app.db!.query<{ collected: string }>('select collected::text as collected from funds where id = $1', [
      fundId,
    ])
    expect(rows[0]?.collected).toBe('500000')
  })

  it('D3-14: один гость резервирует не больше пяти подарков — шестой 429', async () => {
    const w = await newWedding()
    const gifts: string[] = []
    for (let i = 0; i < 6; i++) gifts.push(await newGift(w, `Подарок ${RUN}-${i}`))
    const guest = await newGuest(w, 'Жадный гость')

    for (const giftId of gifts.slice(0, 5)) expect((await reserve(guest.token, giftId)).statusCode).toBe(200)
    const sixth = await reserve(guest.token, gifts[5]!)
    expect({ status: sixth.statusCode, code: sixth.json().error?.code }).toEqual({ status: 429, code: 'reservation_limit' })
    // Повтор по уже своему подарку — не новый резерв, предел его не касается.
    expect((await reserve(guest.token, gifts[0]!)).statusCode).toBe(200)

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from gift_reservations where guest_token = $1',
      [guest.token],
    )
    expect(Number(rows[0]!.n)).toBe(5)
  })

  /* ── логистика ────────────────────────────────────────────────────── */

  it('D3-15: после дедлайна отельного блока номер не бронируется — 409', async () => {
    const w = await newWedding()
    const closed = await newHotel(w, 5, isoDay(-2))
    const open = await newHotel(w, 5, isoDay(2))
    const guest = await newGuest(w, 'Опоздавший')

    const late = await app.inject({ method: 'POST', url: `/join/${guest.token}/hotels`, headers: key(), payload: { hotelId: closed } })
    expect({ status: late.statusCode, code: late.json().error?.code }).toEqual({ status: 409, code: 'deadline_passed' })
    const ok = await app.inject({ method: 'POST', url: `/join/${guest.token}/hotels`, headers: key(), payload: { hotelId: open } })
    expect(ok.statusCode).toBe(200)
  })

  it('D3-16/020: автобус считает отдельные персоны семейного приглашения', async () => {
    const w = await newWedding()
    const tiny = await newBus(w, 1)
    const pair = await newBus(w, 2)
    const family = await newGuest(w, 'Ольга', true)
    const familyState = await app.inject({ method: 'GET', url: `/rsvp/${family.token}` })
    const people = familyState.json().people as { id: string }[]
    expect(people).toHaveLength(2)

    // На одно место садится ровно одна персона; вторая получает честный bus_full.
    expect((await app.inject({
      method: 'POST', url: `/join/${family.token}/shuttle`, headers: key(),
      payload: { busId: tiny, personId: people[0]!.id },
    })).statusCode).toBe(200)
    const refused = await app.inject({
      method: 'POST', url: `/join/${family.token}/shuttle`, headers: key(),
      payload: { busId: tiny, personId: people[1]!.id },
    })
    expect({ status: refused.statusCode, code: refused.json().error?.code }).toEqual({ status: 409, code: 'bus_full' })

    for (const person of people) {
      expect((await app.inject({
        method: 'POST', url: `/join/${family.token}/shuttle`, headers: key(),
        payload: { busId: pair, personId: person.id },
      })).statusCode).toBe(200)
    }
    const alone = await newGuest(w, 'Денис')
    const third = await app.inject({ method: 'POST', url: `/join/${alone.token}/shuttle`, headers: key(), payload: { busId: pair } })
    expect({ status: third.statusCode, code: third.json().error?.code }).toEqual({ status: 409, code: 'bus_full' })

    const again = await app.inject({
      method: 'POST', url: `/join/${family.token}/shuttle`, headers: key(),
      payload: { busId: pair, personId: people[0]!.id },
    })
    expect({ status: again.statusCode, alreadyBooked: again.json().alreadyBooked }).toEqual({ status: 200, alreadyBooked: true })
  })

  /* ── тексты сервера и день X ──────────────────────────────────────── */

  it('D4-18/D3-19: уведомления команде о рассылках — правда и со склонением', async () => {
    const w = await newWedding()
    const helper = await newUser()
    await joinAs(w, 'helper', helper.token)
    const guest = await newGuest(w, 'Единственный')
    await patchGuest(w, guest.guestId, { status: 'yes' })
    const busId = await newBus(w, 10)
    await app.inject({ method: 'POST', url: `/join/${guest.token}/shuttle`, headers: key(), payload: { busId } })

    const pickup = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/notify-pickup`,
      headers: { ...auth(w.token), ...key() },
    })
    expect(pickup.statusCode).toBe(202)
    const remind = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/menu-poll/remind`,
      headers: { ...auth(w.token), ...key() },
    })
    expect(remind.statusCode).toBe(202)

    const mine = await notificationsOf(helper.token)
    const aboutPickup = mine.find((n) => n.body.includes('точках сбора') || n.body.includes('Точки сбора'))
    const aboutMenu = mine.find((n) => n.body.includes('меню'))
    // Гостям ничего не уходит — канала нет; текст обязан говорить это, а не «разосланы».
    expect(aboutPickup?.body).toMatch(/Команда уведомлена о точках сбора/)
    expect(aboutPickup?.body).toMatch(/гостям доставки пока нет/)
    expect(aboutPickup?.body).not.toMatch(/разослан/)
    // «1 гость», а не «1 гостей»: граница слова — по кириллице, `\b` её не знает.
    expect(aboutPickup?.body).toMatch(/1 гость(?![а-яё])/)
    expect(aboutMenu?.body).toMatch(/1 гость ещё не выбрал блюдо/)
    expect(aboutMenu?.body).not.toMatch(/разослан/)
  })

  it('D4-18: notifiedGuests снят (v0.30.0) — в ответе только guestsAffected', async () => {
    const w = await newWedding()
    for (const name of ['Ольга', 'Денис']) {
      const g = await newGuest(w, name)
      await patchGuest(w, g.guestId, { status: 'yes' })
    }
    const shift = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      headers: { ...auth(w.token), ...key() },
      payload: { minutes: 15 },
    })
    expect(shift.statusCode).toBe(200)
    const planb = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/planb/activate`,
      headers: { ...auth(w.token), ...key() },
      payload: { scenario: 'rain' },
    })
    expect(planb.statusCode).toBe(200)
    // Канала до гостей нет — ноль, а не число подтвердивших (R-174).
    // Поле «скольким гостям ушло» было честным нулём (канала до гостей нет) и снято в v0.30.0 —
    // экран читает `guestsAffected`. Утверждение — что нуля-обещания в ответе больше нет.
    expect(shift.json()).not.toHaveProperty('notifiedGuests')
    expect(planb.json()).not.toHaveProperty('notifiedGuests')
    expect(typeof shift.json().guestsAffected).toBe('number')
  })

  it('D4-19/D2-19б: PATCH задачи возвращает срок', async () => {
    const w = await newWedding()
    const tasks = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/tasks`, headers: auth(w.token) })
    ).json() as { id: string; due: string | null }[]
    const dated = tasks.find((t) => t.due !== null)!
    expect(dated).toBeDefined()
    const res = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/tasks/${dated.id}`,
      headers: auth(w.token),
      payload: { done: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ done: true, due: dated.due })
  })

  it('D2-19а: своя задача «за 3 месяца» получает срок по формуле переноса', async () => {
    const w = await newWedding({ date: '2027-05-31' })
    const dated = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tasks`,
      headers: auth(w.token),
      payload: { title: 'Заказать торт', period: '3' },
    })
    expect(dated.statusCode).toBe(201)
    // 31 мая минус три месяца — 28 февраля, как у переноса (`make_interval`), а не 3 марта.
    expect(dated.json().due).toBe('2027-02-28')

    const vague = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tasks`,
      headers: auth(w.token),
      payload: { title: 'Позвонить тёте', period: 'накануне' },
    })
    expect({ status: vague.statusCode, due: vague.json().due }).toEqual({ status: 201, due: null })
  })

  it('D2-12: PUT /timeline с не-датой отвечает 422, а не 500', async () => {
    const w = await newWedding()
    const put = (startsAt: string) =>
      app.inject({
        method: 'PUT',
        url: `/weddings/${w.weddingId}/timeline`,
        headers: auth(w.token),
        payload: [{ name: 'Сборы', startsAt }],
      })
    const bad = await put('вчера')
    expect({ status: bad.statusCode, code: bad.json().error?.code }).toEqual({ status: 422, code: 'validation_failed' })
    // 30 февраля V8 читает как 2 марта — календарь проверяется отдельно.
    expect((await put('2027-02-30T09:00:00.000Z')).statusCode).toBe(422)
    expect((await put('2027-06-14T09:00:00.000Z')).statusCode).toBe(200)
    // Пустая строка — «время не назначено»: так экран возвращает `null` из GET, раньше это тоже был 500.
    const blank = await put('')
    expect({ status: blank.statusCode, startsAt: (blank.json() as { startsAt: string | null }[])[0]!.startsAt }).toEqual({
      status: 200,
      startsAt: null,
    })
  })

  /* ── push ─────────────────────────────────────────────────────────── */

  it('D4-10: DELETE push-subscriptions?endpoint= снимает только подписку этого устройства', async () => {
    const user = await newUser()
    const phone = `https://push.example/${RUN}/phone`
    const laptop = `https://push.example/${RUN}/laptop`
    for (const endpoint of [phone, laptop]) {
      await app.db!.query('insert into push_subscriptions (id, user_id, endpoint, keys) values ($1,$2,$3,$4)', [
        randomUUID(),
        user.userId,
        endpoint,
        JSON.stringify({ p256dh: 'k', auth: 'a' }),
      ])
    }
    const one = await app.inject({
      method: 'DELETE',
      url: `/users/me/push-subscriptions?endpoint=${encodeURIComponent(phone)}`,
      headers: auth(user.token),
    })
    expect(one.statusCode).toBe(204)
    const left = async () =>
      (
        await app.db!.query<{ endpoint: string }>('select endpoint from push_subscriptions where user_id = $1 order by endpoint', [
          user.userId,
        ])
      ).rows.map((r) => r.endpoint)
    // Выключил на телефоне — ноутбук продолжает получать push.
    expect(await left()).toEqual([laptop])

    const all = await app.inject({ method: 'DELETE', url: '/users/me/push-subscriptions', headers: auth(user.token) })
    expect(all.statusCode).toBe(204)
    expect(await left()).toEqual([])
  })

  /* ── свой подрядчик ───────────────────────────────────────────────── */

  it('D4-01: новый свой подрядчик не читает переписку прежнего (правка в slots.ts — у оркестратора)', async () => {
    const w = await newWedding()
    const slotId = await firstSlot(w, 'florist')
    const addExternal = (vendorName: string) =>
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
        headers: auth(w.token),
        payload: { vendorName, price: { amount: 3_000_000, currency: 'RUB' } },
      })
    const inviteExternal = async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`,
        headers: auth(w.token),
      })
      expect(res.statusCode).toBe(201)
      return res.json().token as string
    }

    expect((await addExternal('Флорист А')).statusCode).toBe(200)
    const tokenA = await inviteExternal()
    const secret = `Мой телефон и цены — только для этой пары ${RUN}`
    expect(
      (await app.inject({ method: 'POST', url: `/guest-vendor/${tokenA}/messages`, payload: { text: secret } })).statusCode,
    ).toBe(201)

    // Пара убрала А и позвала Б в тот же слот.
    expect(
      (await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/slots/${slotId}/external`, headers: auth(w.token) })).statusCode,
    ).toBe(204)
    expect((await addExternal('Флорист Б')).statusCode).toBe(200)
    const tokenB = await inviteExternal()

    const history = await app.inject({ method: 'GET', url: `/guest-vendor/${tokenB}/messages` })
    expect(history.statusCode).toBe(200)
    const texts = (history.json().items as { text: string }[]).map((m) => m.text)
    // Реплики А — персональные данные третьего лица; Б их видеть не должен.
    expect(texts).not.toContain(secret)
    expect(texts).toEqual([])
  })

  /* Зеркало D4-01 с другой двери (ревью фиксов, RF-BE-01): пара убирает
   * своего подрядчика не «Убрать» (`DELETE …/external`), а «Отменить сделку»
   * с экрана сделки — `POST …/cancel` или `PATCH /deals {cancelled}`. Токен А
   * при этом не отзывался, а фильтр «не старше текущей сделки» открывал ему
   * переписку пары со СЛЕДУЮЩИМ подрядчиком Б (ERR-0242). */
  for (const door of ['cancel', 'patch'] as const) {
    it(`RF-BE-01: старый токен своего подрядчика после отмены через ${door} гаснет и не читает переписку с новым`, async () => {
      const w = await newWedding()
      const slotId = await firstSlot(w, 'florist')
      const addExternal = (vendorName: string) =>
        app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
          headers: auth(w.token),
          payload: { vendorName, price: { amount: 3_000_000, currency: 'RUB' } },
        })
      const inviteExternal = async () => {
        const res = await app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`,
          headers: auth(w.token),
        })
        expect(res.statusCode).toBe(201)
        return res.json().token as string
      }
      expect((await addExternal('Флорист А')).statusCode).toBe(200)
      const tokenA = await inviteExternal()
      const { rows } = await app.db!.query<{ deal_id: string }>('select deal_id from slots where id = $1', [slotId])
      const dealA = rows[0]!.deal_id

      if (door === 'cancel') {
        expect(
          (await app.inject({
            method: 'POST',
            url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`,
            headers: { ...auth(w.token), 'idempotency-key': `rf1-${RUN}-${counter++}` },
          })).statusCode,
        ).toBe(200)
      } else {
        expect(
          (await app.inject({
            method: 'PATCH',
            url: `/deals/${dealA}`,
            headers: { ...auth(w.token), 'idempotency-key': `rf1p-${RUN}-${counter++}` },
            payload: { state: 'cancelled' },
          })).statusCode,
        ).toBe(200)
      }
      expect((await addExternal('Флорист Б')).statusCode).toBe(200)
      const tokenB = await inviteExternal()
      const secretB = `Адрес и предоплата для Б ${RUN}`
      expect(
        (await app.inject({ method: 'POST', url: `/guest-vendor/${tokenB}/messages`, payload: { text: secretB } })).statusCode,
      ).toBe(201)

      // Старый токен А погашен: ни слот с новой сделкой, ни переписка с Б.
      expect((await app.inject({ method: 'GET', url: `/guest-vendor/${tokenA}` })).statusCode).toBe(410)
      expect((await app.inject({ method: 'GET', url: `/guest-vendor/${tokenA}/messages` })).statusCode).toBe(410)
    })
  }
})
