import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { announceDealEvents } from '../src/jobs/index.js'

/**
 * Аудит 2026-09-07, блок 10: сквозной сценарий трёх ролей, доказанный базой.
 *
 * Пара заводит свадьбу и находит подрядчика, пишет ему; подрядчик держит
 * заявку и отвечает в чате; пара бронирует, вносит аванс и закрывает сделку,
 * наполняет свадьбу (бюджет, задачи, тайминг, автобус, отель, опрос, подарок,
 * гость с телефоном и именной ссылкой); гость по ссылке отвечает с +1, едой и
 * трансфером, садится в автобус и отель, голосует за блюдо, резервирует
 * подарок; после дня свадьбы гость и пара оставляют отзывы, подрядчик
 * отвечает и учитывает обновления; фоновая задача рассылает события сделки.
 *
 * Каждый шаг идёт через контракт (`app.inject`), а в конце сценарий
 * проверяется НЕ по ответам экранов, а по строкам в базе: что и в какой
 * таблице осталось (R-132). Сущности помечены `MARK` — те же строки видны
 * снаружи через psql (см. AUDIT.md, блок 10).
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('блок 10: сквозной сценарий трёх ролей', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259): в общей
   * дев-базе сотня тысяч номеров `+79RRRRRRNNN` от прежних
   * прогонов, и случайный RUN иногда совпадает с занятым — тогда на
   * свежем номере прилетает 409 «wedding_exists». */
  let RUN = String(randomInt(100_000, 1_000_000))
  const MARK = `E2E-${RUN}`
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
  const key = () => ({ 'idempotency-key': `e2e-${RUN}-${++counter}` })
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`
  const ok = (res: { statusCode: number; body: string }, what: string) => {
    expect(res.statusCode, `${what}: ${res.statusCode} ${res.body.slice(0, 200)}`).toBeLessThan(300)
    return res
  }

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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id, phone }
  }
  const count = async (sql: string, params: unknown[]) =>
    Number((await app.db!.query<{ n: string }>(sql, params)).rows[0]!.n)

  it('пара, подрядчик и гость проходят путь до отзывов — и каждая запись остаётся в базе', async () => {
    /* ── 1. Пара заводит свадьбу ─────────────────────────────────────── */
    const couple = await newUser()
    const wedding = ok(await app.inject({
      method: 'POST', url: '/weddings', headers: auth(couple.token),
      payload: { partnerName: MARK, date: '2027-11-06', city: { name: 'Казань', region: 'Татарстан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    }), 'создание свадьбы')
    const weddingId = wedding.json().id as string

    /* ── 2. Подрядчик заводит и публикует анкету, закрывает день ──────── */
    const vendorUser = await newUser()
    const profile = ok(await app.inject({
      method: 'PUT', url: '/vendor/profile', headers: auth(vendorUser.token),
      payload: { name: `Фото ${MARK}`, categoryId: 'photo', city: { name: 'Казань', region: 'Татарстан' }, about: 'Снимаю свадьбы', phone: '+79170001100', priceFrom: { amount: 5_000_000, currency: 'RUB' } },
    }), 'анкета подрядчика')
    const vendorId = profile.json().id as string
    ok(await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendorUser.token) }), 'публикация')
    ok(await app.inject({ method: 'POST', url: '/vendor/calendar/busy', headers: auth(vendorUser.token), payload: { dates: ['2027-11-07'], status: 'busy' } }), 'занятый день')

    /* ── 3. Пара находит подрядчика в каталоге и пишет ему ─────────────── */
    const found = ok(await app.inject({ method: 'GET', url: `/catalog/vendors?q=${encodeURIComponent(`Фото ${MARK}`)}&city=${encodeURIComponent('Казань')}`, headers: auth(couple.token) }), 'поиск')
    expect((found.json().items as { id: string }[]).some((v) => v.id === vendorId)).toBe(true)
    const chat = ok(await app.inject({ method: 'POST', url: `/chats/vendor/${vendorId}`, headers: auth(couple.token) }), 'чат с подрядчиком')
    const chatId = chat.json().id as string
    ok(await app.inject({ method: 'POST', url: `/chats/${chatId}/messages`, headers: auth(couple.token), payload: { text: 'Свободны 6 ноября?' } }), 'сообщение пары')

    /* ── 4. Подрядчик держит заявку и отвечает ──────────────────────────── */
    const leads = ok(await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendorUser.token) }), 'заявки')
    const lead = (leads.json() as { id: string; status: string }[])[0]!
    expect(lead.status).toBe('new')
    ok(await app.inject({ method: 'POST', url: `/vendor/leads/${lead.id}`, headers: auth(vendorUser.token), payload: { action: 'hold' } }), 'hold заявки')
    ok(await app.inject({ method: 'POST', url: `/chats/${chatId}/messages`, headers: auth(vendorUser.token), payload: { text: 'Да, свободен — держу дату' } }), 'ответ подрядчика')

    /* ── 5. Бронь → аванс → завершение ───────────────────────────────────── */
    const slots = ok(await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(couple.token) }), 'слоты')
    const slot = (slots.json() as { id: string; categoryId: string }[]).find((s) => s.categoryId === 'photo')!
    const booked = ok(await app.inject({
      method: 'POST', url: `/weddings/${weddingId}/slots/${slot.id}/book`, headers: { ...auth(couple.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    }), 'бронь')
    const dealId = booked.json().deal.id as string
    expect(((ok(await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendorUser.token) }), 'заявки после брони')).json() as { status: string }[])[0]!.status).toBe('won')
    const vendorDeals = ok(await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(vendorUser.token) }), 'сделки подрядчика')
    expect((vendorDeals.json().items as { id: string }[]).some((d) => d.id === dealId)).toBe(true)
    ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${slot.id}/pay`, headers: { ...auth(couple.token), ...key() }, payload: {} }), 'аванс')
    ok(await app.inject({ method: 'PATCH', url: `/deals/${dealId}`, headers: { ...auth(couple.token), ...key() }, payload: { state: 'done' } }), 'завершение сделки')

    /* ── 6. Пара наполняет свадьбу ───────────────────────────────────────── */
    ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/budget/items`, headers: auth(couple.token), payload: { title: `Букет ${MARK}`, amount: { amount: 1_500_000, currency: 'RUB' }, categoryId: 'b2' } }), 'статья бюджета')
    const task = ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/tasks`, headers: auth(couple.token), payload: { title: `Заказать торт ${MARK}`, period: '3' } }), 'задача')
    ok(await app.inject({ method: 'PATCH', url: `/weddings/${weddingId}/tasks/${task.json().id as string}`, headers: auth(couple.token), payload: { done: true } }), 'задача сделана')
    const timeline = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/timeline`, headers: auth(couple.token) })
    ok(await app.inject({ method: 'PUT', url: `/weddings/${weddingId}/timeline`, headers: { ...auth(couple.token), 'if-match': timeline.headers.etag! }, payload: [{ name: `Сбор гостей ${MARK}`, startsAt: '2027-11-06T12:00:00.000Z' }] }), 'тайминг')
    const bus = ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/logistics/buses`, headers: auth(couple.token), payload: { name: `Автобус ${MARK}`, from: 'ЗАГС', time: '11:30', seats: 20 } }), 'автобус')
    const hotel = ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/logistics/hotels`, headers: auth(couple.token), payload: { name: `Отель ${MARK}`, rooms: 5 } }), 'отель')
    ok(await app.inject({ method: 'PUT', url: `/weddings/${weddingId}/menu-poll`, headers: auth(couple.token), payload: { question: 'Что на горячее?', options: [{ name: 'Утка' }, { name: 'Рыба' }] } }), 'опрос меню')
    const poll = ok(await app.inject({ method: 'GET', url: `/weddings/${weddingId}/menu-poll`, headers: auth(couple.token) }), 'чтение опроса')
    const optionId = (poll.json().options as { id: string }[])[0]!.id
    const gift = ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/wishlist`, headers: auth(couple.token), payload: { name: `Кофемашина ${MARK}`, price: { amount: 6_200_000, currency: 'RUB' } } }), 'подарок')
    const guest = ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests`, headers: auth(couple.token), payload: { name: `Марина ${MARK}`, phone: '+79170002200' } }), 'гость')
    const guestId = guest.json().id as string
    const link = ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests/${guestId}/invite-link`, headers: auth(couple.token) }), 'именная ссылка')
    const code = (link.json().url as string).split('/').pop()!

    /* ── 7. Гость по ссылке ──────────────────────────────────────────────── */
    const redeemed = ok(await app.inject({ method: 'GET', url: `/invite/${code}` }), 'обмен ссылки')
    const token = redeemed.json().guestToken as string
    const t = encodeURIComponent(token)
    ok(await app.inject({ method: 'POST', url: `/rsvp/${t}`, payload: { status: 'yes', plusOne: true, diet: 'vegan', transfer: 'need' } }), 'RSVP')
    ok(await app.inject({ method: 'POST', url: `/join/${t}/shuttle`, headers: key(), payload: { busId: bus.json().id } }), 'место в автобусе')
    ok(await app.inject({ method: 'POST', url: `/join/${t}/hotels`, headers: key(), payload: { hotelId: hotel.json().id } }), 'номер в отеле')
    ok(await app.inject({ method: 'POST', url: `/join/${t}/menu-vote`, payload: { optionId } }), 'голос за блюдо')
    ok(await app.inject({ method: 'POST', url: `/gifts/${t}/${gift.json().id as string}/reserve`, headers: key(), payload: {} }), 'резерв подарка')
    const page = ok(await app.inject({ method: 'GET', url: `/rsvp/${t}` }), 'страница гостя')
    expect(page.json()).toMatchObject({ status: 'yes', plusOne: true, diet: 'vegan', transfer: 'need' })

    /* ── 8. После дня свадьбы: отзывы ────────────────────────────────────── */
    await app.db!.query('update weddings set date = current_date - 1 where id = $1', [weddingId])
    ok(await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guest-reviews?guestToken=${t}`, payload: { vendorId, stars: 5, text: `Гость доволен ${MARK}` } }), 'отзыв гостя')
    ok(await app.inject({ method: 'POST', url: `/catalog/vendors/${vendorId}/reviews`, headers: auth(couple.token), payload: { rating: 5, text: `Пара довольна ${MARK}` } }), 'отзыв пары')

    /* ── 9. Подрядчик отвечает и учитывает обновления ────────────────────── */
    const reviews = ok(await app.inject({ method: 'GET', url: '/vendor/reviews', headers: auth(vendorUser.token) }), 'отзывы подрядчика')
    const list = reviews.json() as { id: string; source: string }[]
    expect(list.map((r) => r.source).sort()).toEqual(['couple', 'guest'])
    const coupleReview = list.find((r) => r.source === 'couple')!
    ok(await app.inject({ method: 'POST', url: `/vendor/reviews/${coupleReview.id}/reply`, headers: auth(vendorUser.token), payload: { text: 'Спасибо!' } }), 'ответ на отзыв')
    const updates = ok(await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendorUser.token) }), 'обновления от пар')
    const update = (updates.json() as { id: string }[])[0]
    expect(update, 'обновление о гостях/брони должно прийти').toBeTruthy()
    ok(await app.inject({ method: 'POST', url: `/vendor/updates/${update!.id}/ack`, headers: auth(vendorUser.token), payload: {} }), 'учтено')

    /* ── 10. Фоновая рассылка событий сделки ─────────────────────────────── */
    await announceDealEvents(app)

    /* ── 11. Доказательство базой ────────────────────────────────────────── */
    const guestRow = (await app.db!.query<{ rsvp: string; plus_one: boolean; diet: string; transfer: string; phone: string; menu_option_id: string }>(
      'select rsvp, plus_one, diet, transfer, phone, menu_option_id from guests where id = $1', [guestId],
    )).rows[0]!
    expect(guestRow).toMatchObject({ rsvp: 'yes', plus_one: false, diet: 'vegan', transfer: 'need', phone: '+79170002200', menu_option_id: optionId })

    const deal = (await app.db!.query<{ state: string; done_at: Date | null; vendor_id: string }>('select state, done_at, vendor_id from deals where id = $1', [dealId])).rows[0]!
    expect(deal.state).toBe('done')
    expect(deal.done_at).not.toBeNull()

    const evidence = {
      members: await count('select count(*)::text as n from wedding_members where wedding_id = $1 and user_id = $2 and role = $3', [weddingId, couple.userId, 'couple']),
      lead_won: await count("select count(*)::text as n from leads where wedding_id = $1 and vendor_id = $2 and state = 'won'", [weddingId, vendorId]),
      deal_events: await count('select count(*)::text as n from deal_events where deal_id = $1', [dealId]),
      busy_dates: await count('select count(*)::text as n from vendor_busy_dates where vendor_id = $1', [vendorId]),
      budget_items: await count('select count(*)::text as n from budget_items where wedding_id = $1 and title like $2', [weddingId, `%${MARK}%`]),
      tasks_done: await count('select count(*)::text as n from tasks where wedding_id = $1 and title like $2 and done_at is not null', [weddingId, `%${MARK}%`]),
      timeline: await count('select count(*)::text as n from timeline_events where wedding_id = $1', [weddingId]),
      bus_bookings: await count('select count(*)::text as n from bus_bookings where guest_id = $1', [guestId]),
      hotel_bookings: await count('select count(*)::text as n from hotel_bookings where guest_id = $1', [guestId]),
      gift_reservations: await count('select count(*)::text as n from gift_reservations where gift_id = $1', [gift.json().id]),
      reviews: await count('select count(*)::text as n from reviews where vendor_id = $1 and wedding_id = $2', [vendorId, weddingId]),
      review_replied: await count('select count(*)::text as n from reviews where vendor_id = $1 and reply is not null', [vendorId]),
      vendor_updates_acked: await count('select count(*)::text as n from vendor_updates where vendor_id = $1 and ack_at is not null', [vendorId]),
      chat_messages: await count('select count(*)::text as n from messages where chat_id = $1', [chatId]),
      notifications_vendor: await count('select count(*)::text as n from notifications where user_id = $1', [vendorUser.userId]),
      notifications_couple: await count('select count(*)::text as n from notifications where user_id = $1', [couple.userId]),
    }

    expect(evidence.members).toBe(1)
    expect(evidence.lead_won).toBe(1)
    expect(evidence.deal_events).toBeGreaterThanOrEqual(3) // бронь, аванс, завершение
    expect(evidence.busy_dates).toBeGreaterThanOrEqual(2) // свой день + день сделки
    expect(evidence.budget_items).toBe(1)
    expect(evidence.tasks_done).toBe(1)
    expect(evidence.timeline).toBe(1)
    expect(evidence.bus_bookings).toBe(1)
    expect(evidence.hotel_bookings).toBe(1)
    expect(evidence.gift_reservations).toBe(1)
    expect(evidence.reviews).toBe(2)
    expect(evidence.review_replied).toBe(1)
    expect(evidence.vendor_updates_acked).toBe(1)
    expect(evidence.chat_messages).toBe(2)
    expect(evidence.notifications_vendor).toBeGreaterThanOrEqual(1)
    expect(evidence.notifications_couple).toBeGreaterThanOrEqual(1)
  })
})
