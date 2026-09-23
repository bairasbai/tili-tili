import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { decayWeight, publicRating, weightedRating, MIN_REVIEWS_TO_SHOW } from '../src/reviews/rating.js'

/**
 * Этап 8: кабинет подрядчика, отзывы, модерация.
 *
 * Право на отзыв — завершённая сделка, и держат это ограничения базы:
 * «один отзыв на сделку» проверкой в коде означает два отзыва при двух
 * одновременных отправках.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('рейтинг: взвешенное среднее с затуханием', () => {
  it('свежий отзыв весит больше старого', () => {
    expect(decayWeight(0)).toBe(1)
    // Период полураспада — год: отзыв годичной давности весит вдвое меньше.
    expect(decayWeight(365)).toBeCloseTo(0.5, 5)
    expect(decayWeight(730)).toBeCloseTo(0.25, 5)
  })

  it('старая пятёрка не перевешивает свежую двойку', () => {
    const rating = weightedRating([
      { stars: 5, ageDays: 1095 },
      { stars: 2, ageDays: 0 },
    ])
    // Три года — вес 1/8. Среднее арифметическое дало бы 3,5.
    expect(rating).toBeLessThan(3)
  })

  it('без отзывов числа нет', () => {
    expect(weightedRating([])).toBeNull()
  })

  it('до трёх отзывов число не показывается', () => {
    // Один отзыв от знакомого — это 5,0 и первое место в выдаче.
    expect(publicRating(5, 1)).toBeNull()
    expect(publicRating(5, MIN_REVIEWS_TO_SHOW - 1)).toBeNull()
    expect(publicRating(4.7, MIN_REVIEWS_TO_SHOW)).toBe(4.7)
  })
})

describe.skipIf(!live)('этап 8: кабинет, отзывы, модерация', () => {
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
    const { rows } = await app.db!.query<{ id: string }>('select id from users where phone = $1', [phone])
    return { token, userId: rows[0]!.id }
  }

  async function newWedding(date = '2027-06-14') {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { ...user, weddingId: w.json().id as string }
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
    expect(created.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: created.json().id as string }
  }

  async function newStaff() {
    const user = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    return user
  }

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
    return rows[0]!.id
  }

  const finish = (dealId: string) =>
    app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [dealId])

  /* ── лиды ─────────────────────────────────────────────────────────── */
  it('«Написать» заводит лид, повтор не заводит второй', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })

    const leads = (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
      status: string
    }[]
    // Пара написала дважды — это тот же разговор, а не две заявки.
    expect(leads).toHaveLength(1)
    expect(leads[0]!.status).toBe('new')
  })

  it('бронь без переписки тоже видна в кабинете — как выигранный лид', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)

    const leads = (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
      status: string
    }[]
    // Иначе сделка появлялась бы в кабинете ниоткуда.
    expect(leads[0]!.status).toBe('won')
  })

  it('холд лида держится 72 часа и сам снимается', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    const leadId = (
      (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
        id: string
      }[]
    )[0]!.id

    const held = await app.inject({
      method: 'POST',
      url: `/vendor/leads/${leadId}`,
      headers: auth(vendor.token),
      payload: { action: 'hold' },
    })
    expect(held.json().status).toBe('hold')
    expect(new Date(held.json().holdUntil).getTime()).toBeGreaterThan(Date.now())

    await app.db!.query("update leads set hold_until = now() - interval '1 hour' where id = $1", [leadId])
    const after = (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
      status: string
    }[]
    // Держать дату «под вопросом» после срока — терять и пару, и подрядчика.
    expect(after[0]!.status).toBe('new')
  })

  it('ответ на лид уходит в общий чат, а не в отдельную переписку', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    const leadId = (
      (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
        id: string
      }[]
    )[0]!.id

    await app.inject({
      method: 'POST',
      url: `/vendor/leads/${leadId}`,
      headers: auth(vendor.token),
      payload: { action: 'reply', text: 'Здравствуйте! Дата свободна.' },
    })
    const history = await app.inject({
      method: 'GET',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
    })
    // Два места хранения переписки — два порядка сортировки и две правды.
    expect((history.json().items as { text: string }[])[0]!.text).toBe('Здравствуйте! Дата свободна.')
  })

  it('ответ без текста не принимается', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    const leadId = (
      (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
        id: string
      }[]
    )[0]!.id
    const res = await app.inject({
      method: 'POST',
      url: `/vendor/leads/${leadId}`,
      headers: auth(vendor.token),
      payload: { action: 'reply' },
    })
    expect(res.statusCode).toBe(422)
  })

  /* ── отзыв пары ───────────────────────────────────────────────────── */
  it('отзыв по незавершённой сделке — 403, по завершённой — 201, повтор — 409', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const dealId = await book(w, vendor.vendorId)
    const leave = () =>
      app.inject({
        method: 'POST',
        url: `/catalog/vendors/${vendor.vendorId}/reviews`,
        headers: auth(w.token),
        payload: { rating: 5, text: 'Прекрасно' },
      })

    // Право на отзыв — завершённая сделка, а не желание высказаться.
    expect((await leave()).statusCode).toBe(403)
    await finish(dealId)
    expect((await leave()).statusCode).toBe(201)

    const again = await leave()
    // Один отзыв на сделку держит уникальный индекс, а не проверка.
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('review_exists')
  })

  it('отзыв через год не принимается', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const dealId = await book(w, vendor.vendorId)
    await app.db!.query("update deals set state = 'done', done_at = now() - interval '30 days' where id = $1", [
      dealId,
    ])

    const res = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 1, text: 'Вспомнил обиду' },
    })
    // Окно 14 дней: позже это уже не впечатление, а сведение счётов.
    expect(res.statusCode).toBe(403)
  })

  it('до трёх отзывов каталог показывает «Новый», с тремя — число', async () => {
    const vendor = await newVendor('Оценённый')
    const stars = [5, 4, 5]
    // Даты разные: у подрядчика первичный ключ (подрядчик, дата), и две
    // свадьбы в один день к нему не влезут — это защита этапа 4, не дыра.
    const dates = ['2027-03-01', '2027-03-02', '2027-03-03']
    for (const [i, value] of stars.slice(0, 2).entries()) {
      const w = await newWedding(dates[i])
      const dealId = await book(w, vendor.vendorId)
      await finish(dealId)
      await app.inject({
        method: 'POST',
        url: `/catalog/vendors/${vendor.vendorId}/reviews`,
        headers: auth(w.token),
        payload: { rating: value, text: 'Хорошо' },
      })
    }
    const couple = await newWedding()
    const twoReviews = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(couple.token),
    })
    expect(twoReviews.json()).toMatchObject({ rating: null, reviewsCount: 2 })

    const third = await newWedding(dates[2])
    const dealId = await book(third, vendor.vendorId)
    await finish(dealId)
    await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(third.token),
      payload: { rating: stars[2], text: 'Отлично' },
    })
    const withNumber = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(couple.token),
    })
    expect(withNumber.json().reviewsCount).toBe(3)
    expect(withNumber.json().rating).toBeGreaterThan(4)
  })

  /* ── ответ подрядчика ─────────────────────────────────────────────── */
  it('подрядчик отвечает на отзыв, но не видит, кто его оставил', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const dealId = await book(w, vendor.vendorId)
    await finish(dealId)
    await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 4, text: 'Хорошо, но опоздал' },
    })

    const mine = await app.inject({ method: 'GET', url: '/vendor/reviews', headers: auth(vendor.token) })
    const review = (mine.json() as { id: string; authorName: string }[])[0]!
    expect(review.authorName).toBe('Пара со сделкой')
    expect(mine.body).not.toContain('guest_token')

    const replied = await app.inject({
      method: 'POST',
      url: `/vendor/reviews/${review.id}/reply`,
      headers: auth(vendor.token),
      payload: { text: 'Извините за задержку!' },
    })
    expect(replied.statusCode).toBe(200)
    const after = (await app.inject({ method: 'GET', url: '/vendor/reviews', headers: auth(vendor.token) })).json() as {
      reply: { text: string } | null
    }[]
    expect(after[0]!.reply?.text).toBe('Извините за задержку!')
  })

  it('чужой отзыв не прокомментируешь', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const stranger = await newVendor('Посторонний')
    const dealId = await book(w, vendor.vendorId)
    await finish(dealId)
    await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 5, text: 'Отлично' },
    })
    const review = (
      (await app.inject({ method: 'GET', url: '/vendor/reviews', headers: auth(vendor.token) })).json() as {
        id: string
      }[]
    )[0]!

    const res = await app.inject({
      method: 'POST',
      url: `/vendor/reviews/${review.id}/reply`,
      headers: auth(stranger.token),
      payload: { text: 'Это не мой отзыв' },
    })
    expect(res.statusCode).toBe(404)
  })

  /* ── отзыв гостя ──────────────────────────────────────────────────── */
  it('гость оценивает подрядчика после свадьбы, повтор — правка', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)

    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Аня' },
    })
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const guestToken = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string

    const leave = (stars: number) =>
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${encodeURIComponent(guestToken)}`,
        payload: { vendorId: vendor.vendorId, stars, text: 'Было здорово' },
      })

    // До свадьбы гость мог бы оценить разве что переписку.
    expect((await leave(5)).statusCode).toBe(403)

    await app.db!.query("update weddings set date = current_date - 1 where id = $1", [w.weddingId])
    expect((await leave(5)).statusCode).toBe(201)
    expect((await leave(3)).statusCode).toBe(201)

    const { rows } = await app.db!.query<{ n: string; stars: number }>(
      "select count(*)::text as n, max(stars) as stars from reviews where vendor_id = $1 and source = 'guest'",
      [vendor.vendorId],
    )
    // Повтор — правка своего же отзыва, а не второй отзыв.
    expect({ штук: Number(rows[0]!.n), звёзд: rows[0]!.stars }).toEqual({ штук: 1, звёзд: 3 })
  })

  it('пара видит отзывы гостей без токенов', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)
    await app.db!.query("update weddings set date = current_date - 1 where id = $1", [w.weddingId])
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Борис' },
    })
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const guestToken = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${encodeURIComponent(guestToken)}`,
      payload: { vendorId: vendor.vendorId, stars: 5, text: 'Спасибо!' },
    })

    const seen = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/guest-reviews`,
      headers: auth(w.token),
    })
    expect(seen.statusCode).toBe(200)
    expect(seen.json()).toHaveLength(1)
    // Та же граница, что у резервов подарков: звёзды видно, автора нет.
    expect(seen.body).not.toContain(guestToken)
    expect(seen.json()[0].authorName).toBe('Гость свадьбы')
  })

  /* ── верификация ──────────────────────────────────────────────────── */
  it('документы на верификацию наружу не выходят', async () => {
    const vendor = await newVendor()
    const sent = await app.inject({
      method: 'POST',
      url: '/vendor/verification',
      headers: auth(vendor.token),
      payload: { kind: 'ip', fileUrl: 'https://cdn.tili-tili.ru/doc.pdf', inn: '1234567890' },
    })
    expect(sent.statusCode).toBe(201)
    // В ответе только факт подачи: ссылка на скан не должна нигде всплыть.
    expect(sent.body).not.toContain('doc.pdf')

    const again = await app.inject({
      method: 'POST',
      url: '/vendor/verification',
      headers: auth(vendor.token),
      payload: { kind: 'ip', fileUrl: 'https://cdn.tili-tili.ru/doc2.pdf' },
    })
    expect(again.statusCode).toBe(409)

    const couple = await newWedding()
    const card = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(couple.token),
    })
    expect(card.body).not.toContain('doc.pdf')
    expect(card.body).not.toContain('1234567890')
  })

  /* ── антиспам ─────────────────────────────────────────────────────── */
  it('непроверенный подрядчик не пишет больше пяти новым парам в день', async () => {
    const vendor = await newVendor('Активный')
    const codes: number[] = []
    for (let i = 0; i < 7; i++) {
      const w = await newWedding()
      const chatId = (
        await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
      ).json().id as string
      const res = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/messages`,
        headers: auth(vendor.token),
        payload: { text: 'Здравствуйте, я свободен!' },
      })
      codes.push(res.statusCode)
    }
    // Галочка «Проверен» стоит времени, и до неё веерная рассылка закрыта.
    expect(codes.filter((c) => c === 201)).toHaveLength(5)
    expect(codes.filter((c) => c === 429)).toHaveLength(2)
  })

  it('в уже начатой переписке лимит не мешает', async () => {
    const vendor = await newVendor('Разговорчивый')
    const w = await newWedding()
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/chats/${chatId}/messages`,
        headers: auth(vendor.token),
        payload: { text: `Сообщение ${i}` },
      })
      // Лимит про ПЕРВЫЕ сообщения: иначе он бил бы по тем, кто работает.
      expect(res.statusCode).toBe(201)
    }
  })

  /* ── жалобы и модерация ───────────────────────────────────────────── */
  it('жалоба попадает в очередь, повтор её не удваивает', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const complain = () =>
      app.inject({
        method: 'POST',
        url: '/complaints',
        headers: auth(w.token),
        payload: { targetKind: 'vendor', targetId: vendor.vendorId, category: 'no_show', text: 'Не приехал' },
      })
    expect((await complain()).statusCode).toBe(201)
    expect((await complain()).json().duplicate).toBe(true)

    const staff = await newStaff()
    const queue = await app.inject({ method: 'GET', url: '/admin/complaints', headers: auth(staff.token) })
    expect(queue.statusCode).toBe(200)
    /* Очередь идёт от старейших, и в общей тестовой базе наша жалоба —
     * на последней странице. Проверяем состав страницы (только неразобранные)
     * и наличие жалобы в очереди по базе. */
    expect((queue.json().items as { status: string }[]).every((c) => c.status === 'new')).toBe(true)
    const { rows } = await app.db!.query<{ status: string }>(
      'select status from complaints where target_id = $1 and reporter_id is not null',
      [vendor.vendorId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('new')
  })

  it('обычный пользователь в админку не входит', async () => {
    const user = await newUser()
    for (const url of ['/admin/complaints', '/admin/metrics', '/admin/moderation/vendors']) {
      const res = await app.inject({ method: 'GET', url, headers: auth(user.token) })
      // 403, а не 404: админка не секрет, доступ к ней секрет.
      expect({ url, code: res.statusCode }).toEqual({ url, code: 403 })
    }
  })

  it('блокировка убирает подрядчика из выдачи', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Нарушитель')
    await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(w.token),
      payload: { targetKind: 'vendor', targetId: vendor.vendorId, category: 'fraud' },
    })
    const staff = await newStaff()
    const { rows } = await app.db!.query<{ id: string }>(
      "select id from complaints where target_id = $1 and status = 'new'",
      [vendor.vendorId],
    )
    const decided = await app.inject({
      method: 'POST',
      url: `/admin/complaints/${rows[0]!.id}`,
      headers: auth(staff.token),
      payload: { action: 'block', note: 'Подтверждено' },
    })
    expect(decided.statusCode).toBe(200)

    const card = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(w.token),
    })
    // Блокировка — это «нет в выдаче», а не «есть, но с пометкой».
    expect(card.statusCode).toBe(404)

    // Повторное решение по разобранной жалобе — гонка двух модераторов.
    const again = await app.inject({
      method: 'POST',
      url: `/admin/complaints/${rows[0]!.id}`,
      headers: auth(staff.token),
      payload: { action: 'dismiss' },
    })
    expect(again.statusCode).toBe(404)
  })

  it('скрытый отзыв уходит и из показа, и из рейтинга', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Оболганный')
    const dealId = await book(w, vendor.vendorId)
    await finish(dealId)
    await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 1, text: 'Оскорбление' },
    })
    const review = (
      (await app.inject({ method: 'GET', url: '/vendor/reviews', headers: auth(vendor.token) })).json() as {
        id: string
      }[]
    )[0]!

    await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(vendor.token),
      payload: { targetKind: 'review', targetId: review.id, category: 'content' },
    })
    const staff = await newStaff()
    const { rows } = await app.db!.query<{ id: string }>(
      "select id from complaints where target_id = $1 and status = 'new'",
      [review.id],
    )
    await app.inject({
      method: 'POST',
      url: `/admin/complaints/${rows[0]!.id}`,
      headers: auth(staff.token),
      payload: { action: 'block' },
    })

    const { rows: after } = await app.db!.query<{ reviews_count: number; rating: string | null }>(
      'select reviews_count, rating::text as rating from vendors where id = $1',
      [vendor.vendorId],
    )
    // Наказывать звёздами за текст, признанный недопустимым, нельзя.
    expect(after[0]).toMatchObject({ reviews_count: 0, rating: null })
    expect((await app.inject({ method: 'GET', url: '/vendor/reviews', headers: auth(vendor.token) })).json()).toEqual(
      [],
    )
  })

  it('модератор одобряет анкету, и она уходит из очереди', async () => {
    const vendor = await newVendor('Новичок')
    const staff = await newStaff()
    const queue = await app.inject({
      method: 'GET',
      url: '/admin/moderation/vendors?limit=100',
      headers: auth(staff.token),
    })
    expect(queue.statusCode).toBe(200)
    /* Очередь идёт от старейших — в общей тестовой базе наша анкета
     * оказалась бы на сотой странице. Проверяем состав очереди: в ней
     * не должно быть уже проверенных. */
    const { rows: unmoderated } = await app.db!.query<{ n: string }>(
      `select count(*)::text as n from vendors
        where id = any($1) and moderated_at is not null`,
      [(queue.json().items as { id: string }[]).map((v) => v.id)],
    )
    expect(Number(unmoderated[0]!.n)).toBe(0)

    const decided = await app.inject({
      method: 'POST',
      url: `/admin/moderation/vendors/${vendor.vendorId}`,
      headers: auth(staff.token),
      payload: { action: 'verify' },
    })
    expect(decided.statusCode).toBe(200)

    const { rows } = await app.db!.query<{ verified_at: Date | null; moderated_at: Date | null }>(
      'select verified_at, moderated_at from vendors where id = $1',
      [vendor.vendorId],
    )
    expect(rows[0]!.verified_at).not.toBeNull()
    expect(rows[0]!.moderated_at).not.toBeNull()
  })

  /* ── просмотр проекта поддержкой ──────────────────────────────────── */
  it('просмотр чужой свадьбы требует причины и пишется в журнал', async () => {
    const w = await newWedding()
    const staff = await newStaff()

    const noReason = await app.inject({
      method: 'GET',
      url: `/admin/weddings/${w.weddingId}`,
      headers: auth(staff.token),
    })
    // «Смотрел по обращению» должно быть проверяемо.
    expect(noReason.statusCode).toBe(422)

    const seen = await app.inject({
      method: 'GET',
      url: `/admin/weddings/${w.weddingId}?reason=${encodeURIComponent('обращение №123 от пары')}`,
      headers: auth(staff.token),
    })
    expect(seen.statusCode).toBe(200)
    /* Ни гостей, ни переписки, ни сумм: для разбора обращения хватает карточки.
     * Проверка белым списком, а не отсутствием одного поля: `budgetTotal`
     * в этом ответе не было НИКОГДА, и такая проверка проходила бы, даже
     * если бы поддержке отдавали свадьбу целиком. Появилось новое поле —
     * список расходится, и его придётся объяснить (`WeddingSupportCard`). */
    expect(Object.keys(seen.json()).sort()).toEqual([
      'city',
      'createdAt',
      'date',
      'guestsPlanned',
      'id',
      'style',
      'title',
    ])

    const { rows } = await app.db!.query<{ action: string; diff: { reason: string } }>(
      "select action, diff from audit_log where entity_id = $1 and action = 'wedding.view'",
      [w.weddingId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.diff.reason).toContain('обращение')
  })

  /* ── аналитика ────────────────────────────────────────────────────── */
  it('воронка кабинета считает просмотры, обращения, лиды и сделки', async () => {
    const vendor = await newVendor('Считаемый')
    const w = await newWedding()
    await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(w.token),
    })
    await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    const dealId = await book(w, vendor.vendorId)

    /* «Доход» — поступившие платежи, а не цены броней: бронь без рубля доходом
     * не была (D5-08, ERR-0222). До 2026-09-11 тест закреплял 50 000 ₽ по
     * сделке без единого платежа. */
    const before = await app.inject({ method: 'GET', url: '/vendor/analytics', headers: auth(vendor.token) })
    expect(before.statusCode).toBe(200)
    expect(before.json().revenue).toEqual({ amount: 0, currency: 'RUB' })

    const { rows: slot } = await app.db!.query<{ slot_id: string }>('select slot_id from deals where id = $1', [dealId])
    const paid = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot[0]!.slot_id}/pay`,
      headers: { ...auth(w.token), ...key() },
      payload: { amount: { amount: 2_000_000, currency: 'RUB' } },
    })
    expect(paid.statusCode).toBe(200)

    const stats = await app.inject({ method: 'GET', url: '/vendor/analytics', headers: auth(vendor.token) })
    expect(stats.statusCode).toBe(200)
    expect(stats.json().funnel).toMatchObject({ views: 1, contacts: 1, leads: 1, deals: 1 })
    expect(stats.json().revenue).toEqual({ amount: 2_000_000, currency: 'RUB' })
    // Прошлого периода не было — процент не определён, а не «плюс сто».
    expect(stats.json().revenueDeltaPct).toBeNull()
  })

  it('кабинет закрыт для того, у кого нет анкеты', async () => {
    const user = await newUser()
    for (const url of ['/vendor/leads', '/vendor/reviews', '/vendor/analytics']) {
      const res = await app.inject({ method: 'GET', url, headers: auth(user.token) })
      expect({ url, code: res.statusCode }).toEqual({ url, code: 403 })
    }
  })

  /* ── синонимы ─────────────────────────────────────────────────────── */
  it('поиск находит по слову, которым человек говорит', async () => {
    const staff = await newStaff()
    const host = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(host.token),
      payload: {
        name: `Ведущий ${RUN}-${counter}`,
        categoryId: 'host',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 4_000_000, currency: 'RUB' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(host.token) })

    await app.inject({
      method: 'PUT',
      url: '/admin/categories',
      headers: auth(staff.token),
      payload: { synonyms: { тамада: 'host' } },
    })

    const couple = await newWedding()
    const found = await app.inject({
      method: 'GET',
      url: '/catalog/vendors?q=тамада&limit=20',
      headers: auth(couple.token),
    })
    const items = found.json().items as { categoryId: string }[]
    /* Человек ищет «тамада», а категория называется «Ведущий»: без словаря
     * это выглядит как «у вас никого нет». Проверяем не конкретную анкету
     * (порядок в выдаче — дело рейтинга), а то, что нашлись ведущие. */
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((v) => v.categoryId === 'host')).toBe(true)
    expect(created.statusCode).toBe(200)

    // Слово не из словаря и не из названий по-прежнему ничего не находит:
    // условие не превратилось в «показать всех».
    const nothing = await app.inject({
      method: 'GET',
      url: '/catalog/vendors?q=абракадабра',
      headers: auth(couple.token),
    })
    expect(nothing.json().items).toEqual([])
  })
})
