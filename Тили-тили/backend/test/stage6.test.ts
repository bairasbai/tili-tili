import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Этап 6: вишлист, резервы, складчина, денежные фонды, «просим не дарить».
 *
 * Главное здесь — анонимность (§9): пара видит «занято», но не видит кем.
 * Всё остальное — деньги, поэтому проверяется на границах: два одновременных
 * резерва, перебор складчины, повтор взноса, удаление того, во что сложились.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('этап 6: подарки и фонды', () => {
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
  const rub = (amount: number) => ({ amount, currency: 'RUB' })

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

  async function newWedding() {
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
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-08-21',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 120_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { token, weddingId: w.json().id as string }
  }

  async function newGuest(w: { token: string; weddingId: string }, name = 'Ольга') {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name },
    })
    expect(created.statusCode).toBe(201)
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode).toBe(200)
    return { guestId: created.json().id as string, token: exchanged.json().guestToken as string }
  }

  async function newGift(w: { token: string; weddingId: string }, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/wishlist`,
      headers: auth(w.token),
      payload,
    })
    expect(res.statusCode).toBe(201)
    return res.json() as { id: string; funded: { amount: number }; reserved: boolean }
  }

  const reserve = (guestToken: string, giftId: string) =>
    app.inject({ method: 'POST', url: `/gifts/${guestToken}/${giftId}/reserve`, headers: key() })

  const fund = (guestToken: string, giftId: string, amount: number, k = randomUUID()) =>
    app.inject({
      method: 'POST',
      url: `/gifts/${guestToken}/${giftId}/fund`,
      headers: { 'idempotency-key': k },
      payload: { amount: rub(amount) },
    })

  /* ── резерв ───────────────────────────────────────────────────────── */

  it('два одновременных резерва: один 200, второй 409', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Кофеварка', price: rub(1_500_000) })
    const [a, b] = await Promise.all([newGuest(w, 'Аня'), newGuest(w, 'Борис')])

    const results = await Promise.all([reserve(a.token, gift.id), reserve(b.token, gift.id)])
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1)
    const refused = results.find((r) => r.statusCode === 409)
    expect(refused?.json().error.code).toBe('gift_reserved')
  })

  it('повтор резерва тем же токеном — тот же 200, а не отказ', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Плед', price: rub(400_000) })
    const guest = await newGuest(w)
    // Гость нажал дважды на плохой связи. Подарок его — отказывать не за что.
    expect((await reserve(guest.token, gift.id)).statusCode).toBe(200)
    expect((await reserve(guest.token, gift.id)).statusCode).toBe(200)
  })

  it('свой резерв снимается, чужой — 403', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Тостер', price: rub(700_000) })
    const mine = await newGuest(w, 'Вера')
    const other = await newGuest(w, 'Глеб')
    await reserve(mine.token, gift.id)

    const foreign = await app.inject({
      method: 'DELETE',
      url: `/gifts/${other.token}/${gift.id}/reserve`,
    })
    expect(foreign.statusCode).toBe(403)

    const own = await app.inject({ method: 'DELETE', url: `/gifts/${mine.token}/${gift.id}/reserve` })
    expect(own.statusCode).toBe(204)
    // Снятый резерв освобождает подарок для остальных.
    expect((await reserve(other.token, gift.id)).statusCode).toBe(200)
  })

  /* ── анонимность ──────────────────────────────────────────────────── */

  it('ни один ответ паре не содержит гостевого токена', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Сервиз', price: rub(2_000_000) })
    const group = await newGift(w, { name: 'Путешествие', price: rub(9_000_000), group: true })
    const guest = await newGuest(w, 'Дина')
    await reserve(guest.token, gift.id)
    await fund(guest.token, group.id, 1_000_000)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: 'На дом', target: rub(50_000_000) },
    })

    // Проверяются ВСЕ пути этапа, доступные паре, — а не только вишлист:
    // токен обязан не встречаться нигде, включая соседние экраны.
    const paths = [
      `/weddings/${w.weddingId}/wishlist`,
      `/weddings/${w.weddingId}/guests`,
      `/weddings/${w.weddingId}`,
    ]
    for (const url of paths) {
      const res = await app.inject({ method: 'GET', url, headers: auth(w.token) })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain(guest.token)
    }

    const wishlist = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/wishlist`,
      headers: auth(w.token),
    })
    const gifts = wishlist.json().gifts as { id: string; reserved: boolean; mine?: boolean }[]
    // Пара видит статус — и не видит поля «мой», по которому дарителя
    // можно было бы вычислить, открыв гостевую страницу.
    expect(gifts.find((g) => g.id === gift.id)?.reserved).toBe(true)
    expect(gifts.every((g) => g.mine === undefined)).toBe(true)
  })

  it('гость отличает свой резерв от чужого', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Лампа', price: rub(300_000) })
    const mine = await newGuest(w, 'Егор')
    const other = await newGuest(w, 'Жанна')
    await reserve(mine.token, gift.id)

    const seen = await app.inject({ method: 'GET', url: `/gifts/${other.token}` })
    const theirs = (seen.json().gifts as { id: string; reserved: boolean; mine: boolean }[]).find(
      (g) => g.id === gift.id,
    )
    // «Занято» без «занято мной» — кнопка, которая не знает, что делать.
    expect(theirs).toMatchObject({ reserved: true, mine: false })

    const own = await app.inject({ method: 'GET', url: `/gifts/${mine.token}` })
    expect((own.json().gifts as { id: string; mine: boolean }[]).find((g) => g.id === gift.id)?.mine).toBe(true)
  })

  /* ── складчина ────────────────────────────────────────────────────── */

  it('складчина копится до цены и закрывает подарок', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Велосипед', price: rub(3_000_000), group: true })
    const a = await newGuest(w, 'Зоя')
    const b = await newGuest(w, 'Игорь')

    const first = await fund(a.token, gift.id, 1_000_000)
    expect(first.json()).toMatchObject({ funded: { amount: 1_000_000 }, reserved: false })

    const second = await fund(b.token, gift.id, 2_000_000)
    // Сумма собрана — подарок закрыт, хотя резерва на нём нет.
    expect(second.json()).toMatchObject({ funded: { amount: 3_000_000 }, reserved: true })

    const late = await fund(a.token, gift.id, 100_000)
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('gift_closed')
  })

  it('взнос сверх цены отклоняется, а не принимается лишним', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Гриль', price: rub(1_000_000), group: true })
    const guest = await newGuest(w)
    await fund(guest.token, gift.id, 800_000)

    const over = await fund(guest.token, gift.id, 500_000)
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('gift_overfunded')

    const state = await app.inject({ method: 'GET', url: `/gifts/${guest.token}` })
    const found = (state.json().gifts as { id: string; funded: { amount: number } }[]).find((g) => g.id === gift.id)
    expect(found?.funded.amount).toBe(800_000)
  })

  it('повтор взноса с тем же ключом не удваивает сумму', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Диван', price: rub(5_000_000), group: true })
    const guest = await newGuest(w)
    const k = randomUUID()

    const first = await fund(guest.token, gift.id, 1_500_000, k)
    const again = await fund(guest.token, gift.id, 1_500_000, k)
    expect(first.json()).toMatchObject({ funded: { amount: 1_500_000 } })
    expect(again.json()).toMatchObject({ funded: { amount: 1_500_000 } })

    // Тот же ключ на другую сумму — ошибка клиента, а не молчаливая потеря
    // второго взноса.
    const reused = await fund(guest.token, gift.id, 900_000, k)
    expect(reused.statusCode).toBe(409)
    expect(reused.json().error.code).toBe('idempotency_key_reused')
  })

  it('одинаковый ключ у разных гостей не мешает им друг другу', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Шатёр', price: rub(4_000_000), group: true })
    const a = await newGuest(w, 'Кира')
    const b = await newGuest(w, 'Лев')

    // Ключ придумывает клиент. Глобальная уникальность означала бы, что
    // первый выбравший «1» закрывает этот ключ всем остальным гостям.
    expect((await fund(a.token, gift.id, 500_000, '1')).statusCode).toBe(200)
    const second = await fund(b.token, gift.id, 700_000, '1')
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ funded: { amount: 1_200_000 } })
  })

  it('резерв и складчина исключают друг друга', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Холодильник', price: rub(6_000_000), group: true })
    const a = await newGuest(w, 'Марина')
    const b = await newGuest(w, 'Никита')
    await fund(a.token, gift.id, 1_000_000)

    // Иначе один гость забирает подарок, в который уже сложились двое,
    // и их деньги повисают на чужом резерве.
    const grab = await reserve(b.token, gift.id)
    expect(grab.statusCode).toBe(409)
    expect(grab.json().error.code).toBe('gift_has_contributions')

    const plain = await newGift(w, { name: 'Ваза', price: rub(500_000) })
    await reserve(a.token, plain.id)
    const late = await fund(b.token, plain.id, 100_000)
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('gift_not_group')
  })

  /* ── правки и удаление ────────────────────────────────────────────── */

  it('цену нельзя опустить ниже собранного, подарок с деньгами не удаляется', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Сноуборд', price: rub(4_000_000), group: true })
    const guest = await newGuest(w)
    await fund(guest.token, gift.id, 2_500_000)

    const cheaper = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/wishlist/${gift.id}`,
      headers: auth(w.token),
      payload: { price: rub(1_000_000) },
    })
    expect(cheaper.statusCode).toBe(409)
    expect(cheaper.json().error.code).toBe('gift_price_below_funded')

    const removed = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/wishlist/${gift.id}`,
      headers: auth(w.token),
    })
    // Удаление унесло бы взносы каскадом — деньги гостей не выбрасываются
    // одним тапом.
    expect(removed.statusCode).toBe(409)
    expect(removed.json().error.code).toBe('gift_has_contributions')
  })

  it('пустой подарок удаляется', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Зонт', price: rub(200_000) })
    const res = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/wishlist/${gift.id}`,
      headers: auth(w.token),
    })
    expect(res.statusCode).toBe(204)
  })

  /* ── фонды ────────────────────────────────────────────────────────── */

  it('фонд копит взносы и не удаляется с деньгами внутри', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: 'На путешествие', target: rub(30_000_000) },
    })
    expect(created.statusCode).toBe(201)
    const fundId = created.json().id as string
    const guest = await newGuest(w)

    const paid = await app.inject({
      method: 'POST',
      url: `/gifts/${guest.token}/funds/${fundId}`,
      headers: key(),
      payload: { amount: rub(2_000_000) },
    })
    expect(paid.json()).toMatchObject({ collected: { amount: 2_000_000 }, target: { amount: 30_000_000 } })

    const removed = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/funds/${fundId}`,
      headers: auth(w.token),
    })
    expect(removed.statusCode).toBe(409)
    expect(removed.json().error.code).toBe('fund_has_contributions')
  })

  it('в фонд можно внести больше цели — это ориентир, а не касса', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: 'На ремонт', target: rub(1_000_000) },
    })
    const guest = await newGuest(w)
    const paid = await app.inject({
      method: 'POST',
      url: `/gifts/${guest.token}/funds/${created.json().id}`,
      headers: key(),
      payload: { amount: rub(1_500_000) },
    })
    expect(paid.statusCode).toBe(200)
    expect(paid.json().collected.amount).toBe(1_500_000)
  })

  /* ── «просим не дарить» ───────────────────────────────────────────── */

  it('анти-вишлист заменяется целиком и не копит повторы', async () => {
    const w = await newWedding()
    const put = (list: string[]) =>
      app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/anti-gifts`, headers: auth(w.token), payload: list })

    expect((await put(['Вазы', 'Пледы', 'Вазы'])).json()).toEqual(['Вазы', 'Пледы'])
    // Список приходит целиком: то, чего в нём нет, исчезает.
    expect((await put(['Пледы'])).json()).toEqual(['Пледы'])

    const guest = await newGuest(w)
    const seen = await app.inject({ method: 'GET', url: `/gifts/${guest.token}` })
    expect(seen.json().antiGifts).toEqual(['Пледы'])

    expect((await put([])).json()).toEqual([])
  })

  /* ── ориентир «банкет на гостя» ───────────────────────────────────── */

  it('справедливая цена появляется только когда есть из чего считать', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)

    const empty = await app.inject({ method: 'GET', url: `/gifts/${guest.token}` })
    // Ноль читался бы как «дарить нечего», выдуманное число — хуже молчания.
    expect(empty.json().fairPrice).toBeNull()

    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/budget/items`,
      headers: auth(w.token),
      payload: { title: 'Банкет', categoryId: 'b1', amount: rub(9_000_000) },
    })
    await newGuest(w, 'Оксана')
    await newGuest(w, 'Павел')

    const shown = await app.inject({ method: 'GET', url: `/gifts/${guest.token}` })
    expect(shown.json().fairPrice).toEqual({ amount: 3_000_000, currency: 'RUB' })
  })

  /* ── чужая свадьба ────────────────────────────────────────────────── */

  it('гость чужой свадьбы не достаёт подарок по идентификатору', async () => {
    const mine = await newWedding()
    const theirs = await newWedding()
    const gift = await newGift(theirs, { name: 'Чайник', price: rub(300_000) })
    const guest = await newGuest(mine)

    const res = await reserve(guest.token, gift.id)
    // 404, а не 403: по кодам ответа не должно быть видно, что подарок есть.
    expect(res.statusCode).toBe(404)
  })

  it('без Idempotency-Key взнос не принимается — контракт обещает заголовок', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Проектор', price: rub(2_000_000), group: true })
    const guest = await newGuest(w)
    const res = await app.inject({
      method: 'POST',
      url: `/gifts/${guest.token}/${gift.id}/fund`,
      payload: { amount: rub(100_000) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('idempotency_key_required')
  })
})
