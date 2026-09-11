import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { windowFreesIn } from '../src/routes/auth.js'

/*
 * Фича 005 «Хвосты ревью старого кода», задание BE-B (В2, В3, В4, В6):
 *
 *   - T015: мягко удалённый аккаунт возвращается входом в 30-дневном окне
 *     (`user.restored` в аудите, refresh снова 200, согласие заново, если
 *     было отозвано); строка старше окна — прежнее поведение;
 *   - T016: лимиты выдачи кода — «номер + адрес» 3/час, номер 10/час и
 *     30/сутки, каждый 429 с честным `Retry-After` по `created_at`;
 *     неверные попытки постороннего не мешают владельцу с другого адреса;
 *   - T018: число рейтинга открывают только отзывы пар; гостевые остаются
 *     в среднем и в `reviewsCount`;
 *   - `GET /users/me/push-subscriptions` — хост и признак `mine`, без адреса;
 *   - `POST /weddings` — 409 `wedding_exists` на вторую живую свадьбу пары,
 *     гонка двух POST даёт ровно одну.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)
const POLICY = '2026-09-02'

const HOUR = 3600
const DAY = 24 * HOUR

describe('окно лимита: Retry-After считается по возрасту выдач', () => {
  it('освобождает окно выход самой старой из «лишних» строк', () => {
    // Три выдачи за час при пределе 3: окно откроется, когда уйдёт самая старая (300 с назад).
    expect(windowFreesIn([10, 100, 300], HOUR, 3)).toBe(HOUR - 300)
    // Четыре при пределе 3 (гонка): уйти должна не самая старая, а третья по свежести.
    expect(windowFreesIn([10, 100, 300, 3000], HOUR, 3)).toBe(HOUR - 300)
    // Дробный возраст округляется вверх, и меньше секунды не бывает.
    expect(windowFreesIn([HOUR - 0.4], HOUR, 1)).toBe(1)
    expect(windowFreesIn([DAY - 1], DAY, 1)).toBe(1)
  })
})

describe.skipIf(!live)('фича 005, BE-B: вход удалённого, лимиты кода, порог по парам, push-подписки, вторая свадьба', () => {
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
      policyVersion: POLICY,
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
  })
  afterAll(async () => {
    await app?.close()
  })

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`

  async function readCode(instance: FastifyInstance, phone: string): Promise<string> {
    const { rows } = await instance.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  /** Минутный интервал между кодами одного номера — сдвигом `created_at`, а не ожиданием. */
  async function pretendMinutePassed(instance: FastifyInstance, phone: string) {
    await instance.db!.query("update otp_codes set created_at = created_at - interval '2 minutes' where phone = $1", [
      phone,
    ])
  }

  async function signIn(phone: string, ip = IP) {
    const otp = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: ip })
    expect(otp.statusCode).toBe(200)
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(app, phone) },
    })
    expect(v.statusCode).toBe(200)
    return v.json() as {
      accessToken: string
      refreshToken: string
      user: { id: string }
      consentRequired: boolean
    }
  }

  async function consent(token: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: POLICY },
    })
    expect(res.statusCode).toBe(201)
  }

  async function newUser(name?: string) {
    const phone = nextPhone()
    const s = await signIn(phone)
    await consent(s.accessToken)
    if (name) {
      const res = await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(s.accessToken), payload: { name } })
      expect(res.statusCode).toBe(200)
    }
    return { phone, token: s.accessToken, refresh: s.refreshToken, userId: s.user.id }
  }

  async function auditActions(userId: string): Promise<string[]> {
    const { rows } = await app.db!.query<{ action: string }>('select action from audit_log where actor_id = $1', [
      userId,
    ])
    return rows.map((r) => r.action)
  }

  /* ── T015: вход удалённого ─────────────────────────────────────────── */

  it('T015: удалённый аккаунт возвращается входом — профиль на месте, user.restored в аудите, refresh 200', async () => {
    const u = await newUser('Вера')
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(u.token) })).statusCode).toBe(204)

    await pretendMinutePassed(app, u.phone)
    const again = await signIn(u.phone)
    expect(again.user.id).toBe(u.userId)

    // До фикса: токены выданы, а каждый запрос с ними — 401 «Аккаунт удалён».
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(again.accessToken) })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ id: u.userId, name: 'Вера' })
    // Согласие удалением аккаунта не отзывалось — спрашивать его заново незачем.
    expect(again.consentRequired).toBe(false)

    const { rows } = await app.db!.query<{ deleted_at: Date | null }>('select deleted_at from users where id = $1', [
      u.userId,
    ])
    expect(rows[0]!.deleted_at).toBeNull()
    expect(await auditActions(u.userId)).toContain('user.restored')

    // До фикса обмен токенов удалённого отвечал 401 «Аккаунт удалён» (D6-05) — теперь аккаунт не удалён.
    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: again.refreshToken } })
    expect(refreshed.statusCode).toBe(200)
  })

  it('T015: отозванное согласие после восстановления спрашивается заново — consentRequired, 403 до него', async () => {
    const u = await newUser()
    expect((await app.inject({ method: 'DELETE', url: '/users/me/consent', headers: auth(u.token) })).statusCode).toBe(204)

    await pretendMinutePassed(app, u.phone)
    const again = await signIn(u.phone)
    expect(again.user.id).toBe(u.userId)
    expect(again.consentRequired).toBe(true)
    expect(await auditActions(u.userId)).toContain('user.restored')

    // Вошёл, но согласия нет: 403, а не 401 «Аккаунт удалён».
    const before = await app.inject({ method: 'GET', url: '/users/me', headers: auth(again.accessToken) })
    expect(before.statusCode).toBe(403)

    await consent(again.accessToken)
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(again.accessToken) })
    expect(after.statusCode).toBe(200)
    expect(after.json().id).toBe(u.userId)
  })

  it('T015: новый аккаунт — consentRequired, известный с согласием — нет', async () => {
    const phone = nextPhone()
    const fresh = await signIn(phone)
    expect(fresh.consentRequired).toBe(true)
    await consent(fresh.accessToken)
    await pretendMinutePassed(app, phone)
    expect((await signIn(phone)).consentRequired).toBe(false)
  })

  it('T015: строка старше 30 дней не восстанавливается — токены выдаются, но аккаунт остаётся удалённым до стирания', async () => {
    /* Что происходит: `on conflict (phone)` отдаёт прежнюю строку, условие
     * `deleted_at > now() - 30 days` в восстановлении не срабатывает, токены
     * выдаются, и каждый запрос с ними — 401 «Аккаунт удалён», как до фичи.
     * Уборка (`eraseDeletedUsers`, раз в час) стирает строку, после чего
     * тот же номер заводит новый аккаунт. */
    const u = await newUser()
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(u.token) })).statusCode).toBe(204)
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [u.userId])

    await pretendMinutePassed(app, u.phone)
    const again = await signIn(u.phone)
    expect(await auditActions(u.userId)).not.toContain('user.restored')
    const { rows } = await app.db!.query<{ deleted_at: Date | null }>('select deleted_at from users where id = $1', [
      u.userId,
    ])
    expect(rows[0]!.deleted_at).not.toBeNull()
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: auth(again.accessToken) })).statusCode).toBe(401)
    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: again.refreshToken } })
    expect(refreshed.statusCode).toBe(401)
  })

  /* ── T016: лимиты выдачи кода ─────────────────────────────────────── */

  describe('T016: лимиты выдачи кода на номер', () => {
    let strict: FastifyInstance
    beforeAll(async () => {
      strict = await buildApp({
        env: 'test',
        databaseUrl: DB ?? null,
        redisUrl: null,
        corsOrigins: [],
        jwtAccessSecret: SECRET_A,
        jwtRefreshSecret: SECRET_R,
        policyVersion: POLICY,
        // Общий потолок и лимит по адресу проверяются в `audit12`; здесь они мешали бы измерять номер.
        otpMaxPerHourTotal: 1_000_000,
        otpMaxPerIpHour: 1_000_000,
        otpMaxPerPhoneIpHour: 3,
        otpMaxPerPhoneHour: 10,
        otpMaxPerPhoneDay: 30,
      })
      await strict.ready()
    })
    afterAll(async () => {
      await strict?.close()
    })

    /* Адреса — из номера прогона (R-227): по адресу лимит здесь не считается,
     * но пара «номер + адрес» должна быть своей у каждого запроса теста. */
    const seed = Number(RUN)
    const ipAt = (i: number) => `198.51.${(seed + i) % 256}.${((seed >> 8) + i) % 254 + 1}`

    async function request(phone: string, ip: string) {
      return strict.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: ip })
    }

    it('четвёртый код с того же адреса — 429 с честным Retry-After; с другого адреса — 200', async () => {
      const phone = nextPhone()
      const mine = ipAt(1)
      for (let i = 0; i < 3; i++) {
        if (i > 0) await pretendMinutePassed(strict, phone)
        expect((await request(phone, mine)).statusCode).toBe(200)
      }
      await pretendMinutePassed(strict, phone)
      const fourth = await request(phone, mine)
      expect(fourth.statusCode).toBe(429)
      expect(fourth.json().error.code).toBe('too_many_requests')
      const retry = Number(fourth.headers['retry-after'])
      expect(retry).toBeGreaterThan(0)
      // Самая старая выдача сдвинута на шесть минут назад: окно откроется раньше, чем «через час».
      expect(retry).toBeLessThanOrEqual(HOUR - 5 * 60)

      // Владелец номера с другого адреса код получает: лимит упёрся в того, кто запрашивал.
      const owner = await request(phone, ipAt(2))
      expect(owner.statusCode).toBe(200)
    })

    it('одиннадцатый код с разных адресов — 429: потолок по номеру за час', async () => {
      const phone = nextPhone()
      for (let i = 0; i < 10; i++) {
        if (i > 0) await pretendMinutePassed(strict, phone)
        expect((await request(phone, ipAt(10 + i))).statusCode).toBe(200)
      }
      await pretendMinutePassed(strict, phone)
      const eleventh = await request(phone, ipAt(30))
      expect(eleventh.statusCode).toBe(429)
      expect(eleventh.json().error.code).toBe('too_many_requests')
      const retry = Number(eleventh.headers['retry-after'])
      expect(retry).toBeGreaterThan(0)
      // Первая выдача сдвинута на двадцать минут назад — столько окно уже отсчитало.
      expect(retry).toBeLessThanOrEqual(HOUR - 15 * 60)
    })

    it('тридцать первый код за сутки — 429: потолок по номеру за сутки', async () => {
      const phone = nextPhone()
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 10; i++) {
          if (i > 0) await pretendMinutePassed(strict, phone)
          expect((await request(phone, ipAt(40 + batch * 10 + i))).statusCode).toBe(200)
        }
        // Десятка уезжает из часового окна, но остаётся в суточном.
        await strict.db!.query("update otp_codes set created_at = created_at - interval '2 hours' where phone = $1", [
          phone,
        ])
      }
      const thirtyFirst = await request(phone, ipAt(80))
      expect(thirtyFirst.statusCode).toBe(429)
      expect(thirtyFirst.json().error.code).toBe('too_many_requests')
      const retry = Number(thirtyFirst.headers['retry-after'])
      expect(retry).toBeGreaterThan(0)
      // Самая старая выдача — больше шести часов назад: до суток осталось меньше восемнадцати.
      expect(retry).toBeLessThanOrEqual(DAY - 6 * HOUR)
      // Час при этом пуст — отказ именно суточный, а не часовой.
      const { rows } = await strict.db!.query<{ n: string }>(
        "select count(*)::text as n from otp_codes where phone = $1 and created_at > now() - interval '1 hour'",
        [phone],
      )
      expect(Number(rows[0]!.n)).toBe(0)
    })

    it('чужие неверные попытки гасят код, но владелец с другого адреса получает новый после минуты', async () => {
      const phone = nextPhone()
      const stranger = ipAt(90)
      expect((await request(phone, stranger)).statusCode).toBe(200)
      const real = await readCode(strict, phone)
      const wrong = real === '0000' ? '1111' : '0000'
      for (let i = 0; i < 5; i++) {
        const res = await strict.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: wrong } })
        expect(res.statusCode).toBe(401)
      }
      // Пять попыток сожгли код: даже настоящий больше не принимается.
      expect(
        (await strict.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: real } })).statusCode,
      ).toBe(429)

      // Владелец сразу — «подождите минуту», не час: Retry-After не длиннее resendAfter.
      const owner = ipAt(91)
      const tooSoon = await request(phone, owner)
      expect(tooSoon.statusCode).toBe(429)
      expect(Number(tooSoon.headers['retry-after'])).toBeLessThanOrEqual(60)

      await pretendMinutePassed(strict, phone)
      expect((await request(phone, owner)).statusCode).toBe(200)
      const fresh = await strict.inject({
        method: 'POST',
        url: '/auth/otp/verify',
        payload: { phone, code: await readCode(strict, phone) },
      })
      expect(fresh.statusCode).toBe(200)
    })
  })

  /* ── помощники свадьбы и подрядчика ───────────────────────────────── */

  const key = () => ({ 'idempotency-key': randomUUID() })

  async function newWedding(date = '2027-06-14') {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date, city: { name: 'Казань', region: 'Татарстан' } },
    })
    expect(w.statusCode).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  async function newVendor(name: string, categoryId = 'photo') {
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
    expect((await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })).statusCode).toBe(
      200,
    )
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

  /** Отзыв пары: своя свадьба, сделка `done`, отзыв по ней. */
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

  /** Отзыв гостя: гость свадьбы, которая уже прошла, по ссылке-приглашению. */
  async function leaveGuestReview(w: { token: string; weddingId: string }, vendorId: string, stars: number) {
    await app.db!.query('update weddings set date = current_date - 1 where id = $1', [w.weddingId])
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: `Гость ${counter++}` },
    })
    expect(created.statusCode).toBe(201)
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const guestToken = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${encodeURIComponent(guestToken)}`,
      payload: { vendorId, stars, text: 'Отзыв гостя' },
    })
    expect(res.statusCode).toBe(201)
  }

  const card = async (vendorId: string, token: string) =>
    (await app.inject({ method: 'GET', url: `/catalog/vendors/${vendorId}`, headers: auth(token) })).json() as {
      rating: number | null
      reviewsCount: number
    }

  const listing = async (token: string, q: string, extra = '') =>
    (
      await app.inject({
        method: 'GET',
        url: `/catalog/vendors?categoryId=photo&q=${encodeURIComponent(q)}&sort=rating${extra}`,
        headers: auth(token),
      })
    ).json().items as { id: string; rating: number | null; reviewsCount: number }[]

  /* ── T018: порог рейтинга по отзывам пар ──────────────────────────── */

  it('T018: три гостевых отзыва — rating null при reviewsCount 3, в выдаче по рейтингу ниже тех, у кого число есть', async () => {
    const prefix = `Порог ${RUN}`
    const guestOnly = await newVendor(`${prefix} гости`)
    const byCouples = await newVendor(`${prefix} пары`)

    // Одна свадьба, одна бронь, три гостя — накрутка «5,0» без единого нарушенного правила.
    const w = await newWedding('2027-07-01')
    await book(w, guestOnly.vendorId)
    for (let i = 0; i < 3; i++) await leaveGuestReview(w, guestOnly.vendorId, 5)

    const reader = await newWedding('2027-07-02')
    expect(await card(guestOnly.vendorId, reader.token)).toMatchObject({ rating: null, reviewsCount: 3 })

    // Три отзыва пар по четвёрке — число есть.
    for (const day of ['2027-07-03', '2027-07-04', '2027-07-05']) await leaveCoupleReview(byCouples.vendorId, day, 4)
    expect(await card(byCouples.vendorId, reader.token)).toMatchObject({ rating: 4, reviewsCount: 3 })

    const items = await listing(reader.token, prefix)
    const ids = items.map((v) => v.id)
    expect(ids).toContain(guestOnly.vendorId)
    expect(ids).toContain(byCouples.vendorId)
    expect(items.find((v) => v.id === guestOnly.vendorId)).toMatchObject({ rating: null, reviewsCount: 3 })
    // «Новый» — ниже анкеты с числом, хотя три пятёрки гостей выше трёх четвёрок пар.
    expect(ids.indexOf(byCouples.vendorId)).toBeLessThan(ids.indexOf(guestOnly.vendorId))

    // Фильтр по рейтингу — только по анкетам, где число показано.
    const filtered = (await listing(reader.token, prefix, '&ratingMin=4')).map((v) => v.id)
    expect(filtered).toContain(byCouples.vendorId)
    expect(filtered).not.toContain(guestOnly.vendorId)
  })

  it('T018: после трёх отзывов пар гостевой четвёртый входит в среднее и в reviewsCount', async () => {
    const vendor = await newVendor(`Среднее ${RUN}`)
    const weddings = []
    for (const day of ['2027-08-01', '2027-08-02', '2027-08-03']) {
      weddings.push(await leaveCoupleReview(vendor.vendorId, day, 4))
    }
    const reader = await newWedding('2027-08-04')
    expect(await card(vendor.vendorId, reader.token)).toMatchObject({ rating: 4, reviewsCount: 3 })

    await leaveGuestReview(weddings[0]!, vendor.vendorId, 5)
    const after = await card(vendor.vendorId, reader.token)
    expect(after.reviewsCount).toBe(4)
    // Пятёрка гостя с половинным весом (§15): (4·3 + 5·0,5) / 3,5 ≈ 4,1.
    expect(after.rating).toBe(4.1)

    const { rows } = await app.db!.query<{ reviews_count: number; couple_reviews_count: number }>(
      'select reviews_count, couple_reviews_count from vendors where id = $1',
      [vendor.vendorId],
    )
    expect(rows[0]).toEqual({ reviews_count: 4, couple_reviews_count: 3 })
  })

  /* ── GET /users/me/push-subscriptions ─────────────────────────────── */

  it('GET /users/me/push-subscriptions: две подписки — две строки с хостом, mine у той, что в query, адреса нет', async () => {
    const u = await newUser()
    /* Подписки — прямо в базу: `POST …/push-subscriptions` без ключей VAPID
     * честно отвечает 501, а здесь проверяется чтение, не запись. */
    const phoneEndpoint = `https://fcm.googleapis.com/fcm/send/${RUN}-phone`
    const laptopEndpoint = `https://web.push.apple.com/${RUN}-laptop`
    for (const endpoint of [phoneEndpoint, laptopEndpoint]) {
      await app.db!.query('insert into push_subscriptions (id, user_id, endpoint, keys) values ($1, $2, $3, $4)', [
        randomUUID(),
        u.userId,
        endpoint,
        JSON.stringify({ p256dh: 'p', auth: 'a' }),
      ])
    }

    const res = await app.inject({
      method: 'GET',
      url: `/users/me/push-subscriptions?endpoint=${encodeURIComponent(laptopEndpoint)}`,
      headers: auth(u.token),
    })
    expect(res.statusCode).toBe(200)
    const list = res.json() as { id: string; endpointHost: string; createdAt: string; mine: boolean }[]
    expect(list).toHaveLength(2)
    expect(list.map((s) => s.endpointHost).sort()).toEqual(['fcm.googleapis.com', 'web.push.apple.com'])
    expect(list.find((s) => s.endpointHost === 'web.push.apple.com')).toMatchObject({ mine: true })
    expect(list.find((s) => s.endpointHost === 'fcm.googleapis.com')).toMatchObject({ mine: false })
    for (const s of list) {
      expect(s.id).toBeTypeOf('string')
      expect(Number.isNaN(Date.parse(s.createdAt))).toBe(false)
      // Полный адрес — секрет устройства: его нет ни в одном поле ответа.
      expect(JSON.stringify(s)).not.toContain(RUN)
    }

    // Без query своих нет вовсе: «своя» — только по адресу, который прислало устройство.
    const anon = await app.inject({ method: 'GET', url: '/users/me/push-subscriptions', headers: auth(u.token) })
    expect(anon.statusCode).toBe(200)
    expect((anon.json() as { mine: boolean }[]).every((s) => s.mine === false)).toBe(true)
  })

  /* ── POST /weddings: одна живая свадьба на пару (В6) ──────────────── */

  const postWedding = (token: string, date = '2027-09-10') =>
    app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', date, city: { name: 'Казань', region: 'Татарстан' } },
    })

  async function liveWeddingsOf(userId: string): Promise<number> {
    const { rows } = await app.db!.query<{ n: string }>(
      `select count(*)::text as n from weddings w
         join wedding_members m on m.wedding_id = w.id
        where m.user_id = $1 and m.role = 'couple' and w.cancelled_at is null and w.archived_at is null`,
      [userId],
    )
    return Number(rows[0]!.n)
  }

  it('POST /weddings: вторая живая свадьба — 409 wedding_exists с weddingId; после отмены или архива — 201', async () => {
    const u = await newUser()
    const first = await postWedding(u.token)
    expect(first.statusCode).toBe(201)
    const firstId = first.json().id as string

    const second = await postWedding(u.token, '2027-09-11')
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toMatchObject({ code: 'wedding_exists', details: { weddingId: firstId } })
    expect(await liveWeddingsOf(u.userId)).toBe(1)

    // Одна пара — отмена исполняется сразу, без подтверждения второго партнёра.
    const cancelled = await app.inject({ method: 'POST', url: `/weddings/${firstId}/cancel`, headers: auth(u.token) })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().state).toBe('cancelled')
    const afterCancel = await postWedding(u.token, '2027-09-12')
    expect(afterCancel.statusCode).toBe(201)
    const thirdId = afterCancel.json().id as string

    // Архив без отмены (состоявшаяся свадьба) — тоже не живая.
    await app.db!.query('update weddings set archived_at = now() where id = $1', [thirdId])
    expect((await postWedding(u.token, '2027-09-13')).statusCode).toBe(201)
    expect(await liveWeddingsOf(u.userId)).toBe(1)
  })

  it('POST /weddings: гонка двух POST — ровно одна свадьба, второму 409', async () => {
    const u = await newUser()
    const [a, b] = await Promise.all([postWedding(u.token, '2027-10-01'), postWedding(u.token, '2027-10-02')])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
    const winner = a.statusCode === 201 ? a : b
    const loser = a.statusCode === 201 ? b : a
    expect(loser.json().error).toMatchObject({ code: 'wedding_exists', details: { weddingId: winner.json().id } })
    expect(await liveWeddingsOf(u.userId)).toBe(1)
  })
})
