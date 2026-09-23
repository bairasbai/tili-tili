import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { PAYOUT_WARNING } from '../src/chats/guard.js'
import { hashCode } from '../src/auth/otp.js'
import { recomputeAllRatings, weightedRating, SOURCE_WEIGHT } from '../src/reviews/rating.js'

/**
 * Перепроверка этапа 8 по ОПИСАНИЮ и по источникам, на которые оно ссылается
 * (R-56). Критерии проверяли отзыв по сделке и порог в три отзыва; §15 и
 * список экранов остались непроверенными — там и нашлось.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('веса отзывов по источнику (§15)', () => {
  it('отзыв пары весит больше отзыва гостя', () => {
    expect(SOURCE_WEIGHT.couple).toBeGreaterThan(SOURCE_WEIGHT.guest)
    // Пятёрка от пары и двойка от гостя: среднее не 3,5, а ближе к паре —
    // у неё договор, у гостя впечатление.
    const mixed = weightedRating([
      { stars: 5, ageDays: 0, source: 'couple' },
      { stars: 2, ageDays: 0, source: 'guest' },
    ])
    expect(mixed).toBeGreaterThan(3.5)
  })

  it('сто гостей не перевешивают одну сделку до неузнаваемости', () => {
    const guests = Array.from({ length: 100 }, () => ({ stars: 5 as const, ageDays: 0, source: 'guest' as const }))
    const withCouple = weightedRating([{ stars: 1, ageDays: 0, source: 'couple' }, ...guests])
    // Гостей много и они правы — но и единица от пары не растворяется в ноль.
    expect(withCouple).toBeLessThan(5)
    expect(withCouple).toBeGreaterThan(4)
  })
})

describe.skipIf(!live)('перепроверка этапа 8', () => {
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

  async function newVendor(name = 'Подрядчик', categoryId = 'photo') {
    const user = await newUser()
    const vendorName = `${name} ${RUN}-${counter}`
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: vendorName,
        categoryId,
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: created.json().id as string, vendorName }
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

  async function leaveCoupleReview(vendorId: string, date: string, stars: number) {
    const w = await newWedding(date)
    const dealId = await book(w, vendorId)
    await app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [dealId])
    const res = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: stars, text: 'Отзыв пары' },
    })
    expect(res.statusCode).toBe(201)
    return w
  }

  /* ── публичная лента отзывов (§15) ────────────────────────────────── */
  it('отзывы подрядчика читаются с пометкой источника', async () => {
    const vendor = await newVendor('Читаемый')
    const w = await leaveCoupleReview(vendor.vendorId, '2027-04-01', 5)

    // Гостевой отзыв на той же свадьбе.
    await app.db!.query("update weddings set date = current_date - 1 where id = $1", [w.weddingId])
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
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${encodeURIComponent(guestToken)}`,
      payload: { vendorId: vendor.vendorId, stars: 4, text: 'Отзыв гостя' },
    })

    const reader = await newWedding('2027-05-05')
    const feed = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(reader.token),
    })
    expect(feed.statusCode).toBe(200)
    const items = feed.json().items as { source: string; authorName: string }[]
    /* Без этой ленты карточка показывала рейтинг, но не показывала,
     * за что он поставлен: §15 требует публичный список с пометкой. */
    expect(items).toHaveLength(2)
    expect(items.map((r) => r.source).sort()).toEqual(['couple', 'guest'])
    // Токен гостя в ленту не попадает — как и везде (§9).
    expect(feed.body).not.toContain(guestToken)

    const onlyGuests = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}/reviews?source=guest`,
      headers: auth(reader.token),
    })
    expect((onlyGuests.json().items as { source: string }[]).every((r) => r.source === 'guest')).toBe(true)
  })

  it('скрытый отзыв в ленту не попадает', async () => {
    const vendor = await newVendor('Оболганный2')
    await leaveCoupleReview(vendor.vendorId, '2027-04-02', 1)
    await app.db!.query("update reviews set hidden_at = now() where vendor_id = $1", [vendor.vendorId])

    const reader = await newWedding('2027-05-06')
    const feed = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(reader.token),
    })
    expect(feed.json().items).toEqual([])
  })

  /* ── сделки в кабинете ────────────────────────────────────────────── */
  it('кабинет показывает сделки с суммами, а «ожидается» — остаток после платежей', async () => {
    const vendor = await newVendor('Сделочный')
    const w = await newWedding('2027-04-10')
    const dealId = await book(w, vendor.vendorId)
    const { rows: slot } = await app.db!.query<{ slot_id: string }>('select slot_id from deals where id = $1', [dealId])
    // Аванс 20 000 ₽ из 50 000 ₽: то, что пара уже внесла, подрядчику не «ожидается».
    const paid = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot[0]!.slot_id}/pay`,
      headers: { ...auth(w.token), ...key() },
      payload: { amount: { amount: 2_000_000, currency: 'RUB' } },
    })
    expect(paid.statusCode).toBe(200)

    const deals = await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(vendor.token) })
    expect(deals.statusCode).toBe(200)
    const items = deals.json().items as { price: { amount: number }; state: string; coupleName: string }[]
    /* Экран «Сделки» есть в моках, а пути под него не было: заявка и сделка —
     * разные вещи, у заявки нет ни суммы, ни срока брони. */
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ state: 'paid_deposit' })
    expect(items[0]!.price.amount).toBe(5_000_000)
    /* «Ожидается по сделкам» = цена − оплачено по `payments`, а не цена
     * целиком: до 2026-09-11 здесь стояли 50 000 ₽ при внесённом авансе, и
     * тест это закреплял (D5-08). */
    expect(deals.json().expected.amount).toBe(3_000_000)
  })

  it('закрытая сделка в «ожидается» не входит', async () => {
    const vendor = await newVendor('Закрытый')
    const w = await newWedding('2027-04-11')
    const dealId = await book(w, vendor.vendorId)
    await app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [dealId])

    const deals = await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(vendor.token) })
    /* «Ожидается» — только по открытым броням (`booked`, `paid_deposit`).
     * Остаток по `done` без платежей в него не входит — переход в `done`
     * оплат не проверяет, и это вопрос владельцу, а не допущение «закрытая
     * уже оплачена». */
    expect(deals.json().expected.amount).toBe(0)
    expect((deals.json().items as { state: string }[])[0]!.state).toBe('done')
  })

  /* ── понижение в выдаче ───────────────────────────────────────────── */
  it('понижение в выдаче действительно опускает анкету', async () => {
    /* Метка в имени, а не категория целиком: в общей тестовой базе
     * во «флористах» уже сотня анкет от соседних наборов, и наши две
     * не попали бы даже на первую страницу. */
    const mark = `Флорист${randomInt(100_000, 999_999)}`
    const good = await newVendor(mark, 'florist')
    const bad = await newVendor(mark, 'florist')
    const reader = await newWedding('2027-05-07')

    const order = async () =>
      (
        (
          await app.inject({
            method: 'GET',
            url: `/catalog/vendors?q=${encodeURIComponent(mark)}&limit=100`,
            headers: auth(reader.token),
          })
        ).json().items as { id: string }[]
      ).map((v) => v.id)

    const before = await order()
    expect(before).toContain(bad.vendorId)

    await app.db!.query('update vendors set downranked_at = now() where id = $1', [bad.vendorId])
    const after = await order()
    /* Санкция «понижение в выдаче» ничего не понижала: колонка ставилась,
     * а сортировка про неё не знала. */
    expect(after.indexOf(bad.vendorId)).toBeGreaterThan(after.indexOf(good.vendorId))
    expect(after[after.length - 1]).toBe(bad.vendorId)
  })

  /* ── затухание считается по времени ───────────────────────────────── */
  it('рейтинг пересчитывается ночью, а не только при новом отзыве', async () => {
    const vendor = await newVendor('Застывший')
    await leaveCoupleReview(vendor.vendorId, '2027-04-03', 5)
    await leaveCoupleReview(vendor.vendorId, '2027-04-04', 5)
    await leaveCoupleReview(vendor.vendorId, '2027-04-05', 1)

    // Состарим две пятёрки на три года: их вес должен упасть, а единица —
    // остаться свежей. Без ночного пересчёта число застыло бы навсегда.
    await app.db!.query(
      "update reviews set created_at = now() - interval '3 years' where vendor_id = $1 and stars = 5",
      [vendor.vendorId],
    )
    const { rows: stale } = await app.db!.query<{ rating: string }>(
      'select rating::text as rating from vendors where id = $1',
      [vendor.vendorId],
    )

    await recomputeAllRatings(app.db!)
    const { rows: fresh } = await app.db!.query<{ rating: string }>(
      'select rating::text as rating from vendors where id = $1',
      [vendor.vendorId],
    )
    expect(Number(fresh[0]!.rating)).toBeLessThan(Number(stale[0]!.rating))
  })

  /* ── критерий этапа: выдача, а не карточка ────────────────────────── */
  it('в ВЫДАЧЕ подрядчик с двумя отзывами идёт без числа, с тремя — с числом', async () => {
    const category = 'decor'
    const vendor = await newVendor('Оцениваемый', category)
    const reader = await newWedding('2027-05-08')

    /* Выдача сужается поиском по имени, а не первой сотней категории: база
     * общая, в `decor` уже две тысячи анкет, и каждый прогон оставляет ещё
     * одну с рейтингом. Сортировка идёт по столбцу `rating` — он заполнен и
     * при двух отзывах, хотя наружу не показывается, — так что место анкеты
     * в первой сотне зависело от того, сколько раз этот тест уже гоняли и
     * что соседние наборы создали в ту же минуту (ERR-0215). */
    const inList = async () =>
      (
        (
          await app.inject({
            method: 'GET',
            url: `/catalog/vendors?categoryId=${category}&q=${encodeURIComponent(vendor.vendorName)}&limit=100`,
            headers: auth(reader.token),
          })
        ).json().items as { id: string; rating: number | null; reviewsCount: number }[]
      ).find((v) => v.id === vendor.vendorId)!

    for (const [i, stars] of [5, 4].entries()) {
      await leaveCoupleReview(vendor.vendorId, `2027-08-0${i + 1}`, stars)
    }
    // Критерий этапа говорит «в выдаче», а не «в карточке»: проверялось
    // только второе.
    await expect(inList()).resolves.toMatchObject({ rating: null, reviewsCount: 2 })

    await leaveCoupleReview(vendor.vendorId, '2027-08-03', 5)
    const withNumber = await inList()
    expect(withNumber.reviewsCount).toBe(3)
    expect(withNumber.rating).toBeGreaterThan(4)
  })

  it('«по рейтингу» ранжирует по показанному числу: одна пятёрка без цифры не обгоняет три четвёрки', async () => {
    const category = 'decor'
    // Общий уникальный префикс: `q=` вернёт обе анкеты и только их (R-227).
    const prefix = `Ранжир ${RUN}`
    const loud = await newVendor(`${prefix} один отзыв`, category)
    const steady = await newVendor(`${prefix} три отзыва`, category)
    const reader = await newWedding('2027-05-09')

    await leaveCoupleReview(loud.vendorId, '2027-09-01', 5)
    for (const day of ['2027-09-02', '2027-09-03', '2027-09-04']) await leaveCoupleReview(steady.vendorId, day, 4)

    const res = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?categoryId=${category}&q=${encodeURIComponent(prefix)}&sort=rating`,
      headers: auth(reader.token),
    })
    expect(res.statusCode).toBe(200)
    const items = res.json().items as { id: string; rating: number | null; reviewsCount: number }[]
    const ids = items.map((v) => v.id)
    expect(ids).toContain(loud.vendorId)
    expect(ids).toContain(steady.vendorId)

    /* До трёх отзывов числа на экране нет (План §18.2) — значит, его нет и
     * в сортировке: иначе одна пятёрка от знакомого ставит анкету на первое
     * место «по рейтингу», притом без цифры рядом. Столбец `vendors.rating`
     * заполнен уже при одном отзыве, наружу его прячет `publicRating`. */
    expect(items.find((v) => v.id === loud.vendorId)!.rating).toBeNull()
    expect(items.find((v) => v.id === steady.vendorId)!.rating).toBe(4)
    expect(ids.indexOf(steady.vendorId)).toBeLessThan(ids.indexOf(loud.vendorId))
  })

  /* ── защиты переписки (§18.2, §19.4) ──────────────────────────────── */
  it('первое сообщение пары становится текстом заявки', async () => {
    const vendor = await newVendor('Внимательный')
    const w = await newWedding('2027-04-21')
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Здравствуйте! Свадьба в «Маркони», 120 гостей. Свободны 14 июня?' },
    })

    const leads = (await app.inject({ method: 'GET', url: '/vendor/leads', headers: auth(vendor.token) })).json() as {
      message: string
    }[]
    /* Экран заявки в моках показывает, с чем к подрядчику пришли.
     * Пустая карточка не говорит ничего — и решать по ней нечего. */
    expect(leads[0]!.message).toContain('Маркони')
  })

  it('уход мимо платформы даёт предупреждение обеим сторонам, а не блокировку', async () => {
    const vendor = await newVendor('Хитрый')
    const w = await newWedding('2027-04-22')
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string

    const sent = await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Давайте без договора, переведи на карту — так дешевле' },
    })
    // Сообщение ДОСТАВЛЕНО: блокировка выгнала бы разговор в мессенджер,
    // где нет ни договора, ни следа для разбирательства. Текст — по константе:
    // слово «эскроу» из него ушло (обещание без кода, R-174; сверка планов 2026-09-18).
    expect(sent.statusCode).toBe(201)
    expect(sent.json().warning).toBe(PAYOUT_WARNING)

    const history = await app.inject({
      method: 'GET',
      url: `/chats/${chatId}/messages`,
      headers: auth(vendor.token),
    })
    const items = history.json().items as { senderId: string | null; text: string }[]
    // Предупреждение видно обеим сторонам и остаётся в истории.
    expect(items.some((m) => m.senderId === null && m.text === PAYOUT_WARNING)).toBe(true)

    // Повтор в те же сутки второго предупреждения не добавляет: иначе оно
    // превращается в шум и его перестают читать.
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'ну так что, номер карты скинете?' },
    })
    const after = await app.inject({
      method: 'GET',
      url: `/chats/${chatId}/messages`,
      headers: auth(vendor.token),
    })
    const warnings = (after.json().items as { senderId: string | null }[]).filter((m) => m.senderId === null)
    expect(warnings).toHaveLength(1)
  })

  it('обычная переписка предупреждения не получает', async () => {
    const vendor = await newVendor('Обычный')
    const w = await newWedding('2027-04-23')
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    const sent = await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Здравствуйте! Расскажите про пакеты и предоплату по договору.' },
    })
    // Ложное срабатывание стоит доверия: «по договору» — это не «без договора».
    expect(sent.json().warning).toBeUndefined()
  })

  it('ссылка в первом сообщении подрядчика уходит на модерацию', async () => {
    const vendor = await newVendor('Ссылочный')
    const w = await newWedding('2027-04-24')
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string

    const sent = await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(vendor.token),
      payload: { text: 'Здравствуйте! Портфолио тут: https://ne-tili.example/portfolio' },
    })
    // Сообщение доставлено — но модератор о нём узнает (§19.4, фишинг).
    expect(sent.statusCode).toBe(201)

    const { rows } = await app.db!.query<{ category: string; text: string }>(
      'select category, text from complaints where target_id = $1 and reporter_id is null',
      [vendor.vendorId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ category: 'spam' })
  })

  it('ответ со ссылкой в начатой переписке модерацию не тревожит', async () => {
    const vendor = await newVendor('Аккуратный2')
    const w = await newWedding('2027-04-25')
    const chatId = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
    ).json().id as string
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(w.token),
      payload: { text: 'Здравствуйте!' },
    })
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(vendor.token),
      payload: { text: 'Здравствуйте! Вот портфолио: https://example.com/portfolio' },
    })

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from complaints where target_id = $1 and reporter_id is null',
      [vendor.vendorId],
    )
    // Правило про ПЕРВОЕ сообщение: ссылка в ответе — обычное дело.
    expect(Number(rows[0]!.n)).toBe(0)
  })

  /* ── SLA модерации ────────────────────────────────────────────────── */
  it('метрики показывают просроченные жалобы, а не только открытые', async () => {
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])
    const w = await newWedding('2027-04-26')
    const vendor = await newVendor('Пожалованный')
    await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(w.token),
      payload: { targetKind: 'vendor', targetId: vendor.vendorId, category: 'no_show' },
    })
    await app.db!.query("update complaints set created_at = now() - interval '30 hours' where target_id = $1", [
      vendor.vendorId,
    ])

    const metrics = await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(staff.token) })
    // SLA 24 часа без счётчика просроченных существует только на бумаге.
    expect(metrics.json().complaintsOverdue).toBeGreaterThanOrEqual(1)
  })

  /* ── все пути этапа отвечают ──────────────────────────────────────── */
  it('шестнадцать путей этапа отвечают своими обработчиками', async () => {
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])
    const vendor = await newVendor('Полный')
    const w = await newWedding('2027-04-20')

    const checks: [string, string, string][] = [
      ['GET', '/vendor/leads', vendor.token],
      ['GET', '/vendor/deals', vendor.token],
      ['GET', '/vendor/reviews', vendor.token],
      ['GET', '/vendor/analytics', vendor.token],
      ['GET', `/catalog/vendors/${vendor.vendorId}/reviews`, w.token],
      ['GET', `/weddings/${w.weddingId}/guest-reviews`, w.token],
      ['GET', '/admin/moderation/vendors', staff.token],
      ['GET', '/admin/complaints', staff.token],
      ['GET', '/admin/metrics', staff.token],
      ['GET', `/admin/weddings/${w.weddingId}?reason=обращение%20пары`, staff.token],
    ]
    const wrong: string[] = []
    for (const [method, url, token] of checks) {
      const res = await app.inject({ method: method as 'GET', url, headers: auth(token) })
      if (res.statusCode !== 200) wrong.push(`${url} → ${res.statusCode}`)
    }
    expect(wrong).toEqual([])
  })
})
