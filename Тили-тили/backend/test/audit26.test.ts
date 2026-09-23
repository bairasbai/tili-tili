import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { hashCode } from '../src/auth/otp.js'
import { cleanup } from '../src/jobs/index.js'
import { recomputeRating } from '../src/reviews/rating.js'

/**
 * Фича 003 «Отмена свадьбы и архив», бэкенд.
 *
 * Три вопроса, на которые тут отвечают базой, а не ответом экрана:
 *   1. что отмена свадьбы делает с УЖЕ ВЫПОЛНЕННОЙ сделкой (T004);
 *   2. что уборка делает с отменённой свадьбой старше срока хранения (T010);
 *   3. что получится из мусора в `WEDDING_ARCHIVE_DAYS` (T002).
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv

describe('срок хранения отменённой свадьбы: настройка', () => {
  /*
   * Число уходит в `make_interval(days => …)` уборки, а уборка по нему
   * УДАЛЯЕТ свадьбы со всем содержимым. Поэтому проверяется не «читается ли
   * переменная», а что из неё нельзя получить значение, стирающее архив
   * целиком или роняющее весь `cleanup()`.
   */
  it('ноль и отрицательное поднимаются до нижней границы в 30 дней', () => {
    expect(loadConfig(env({ NODE_ENV: 'development', WEDDING_ARCHIVE_DAYS: '0' })).weddingArchiveDays).toBe(30)
    expect(loadConfig(env({ NODE_ENV: 'development', WEDDING_ARCHIVE_DAYS: '-1' })).weddingArchiveDays).toBe(30)
    expect(loadConfig(env({ NODE_ENV: 'development', WEDDING_ARCHIVE_DAYS: '29' })).weddingArchiveDays).toBe(30)
  })

  it('мусор и пустое дают 365 — обещание Плана §19.1', () => {
    expect(loadConfig(env({ NODE_ENV: 'development', WEDDING_ARCHIVE_DAYS: 'abc' })).weddingArchiveDays).toBe(365)
    expect(loadConfig(env({ NODE_ENV: 'development', WEDDING_ARCHIVE_DAYS: '' })).weddingArchiveDays).toBe(365)
    expect(loadConfig(env({ NODE_ENV: 'development' })).weddingArchiveDays).toBe(365)
  })

  it('заданное число берётся как есть, дробное округляется', () => {
    expect(loadConfig(env({ NODE_ENV: 'development', WEDDING_ARCHIVE_DAYS: '400' })).weddingArchiveDays).toBe(400)
    // `make_interval(days => 400.4)` — ошибка типа, и она унесла бы с собой
    // всю остальную уборку: она идёт одним списком.
    expect(loadConfig(env({ NODE_ENV: 'development', WEDDING_ARCHIVE_DAYS: '400.4' })).weddingArchiveDays).toBe(400)
  })
})

describe.skipIf(!live)('фича 003: отмена свадьбы и уборка архива', () => {
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
  const idem = (token: string) => ({ ...auth(token), 'idempotency-key': randomUUID() })

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
    const { accessToken, user } = v.json()
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: accessToken as string, id: user.id as string }
  }

  async function newWedding(date = '2027-08-21') {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  async function newVendor(categoryId: string) {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Подрядчик ${RUN}-${counter}`,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  const slotsOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
      deal: { id: string } | null
    }[]

  /** Бронирует слот категории и возвращает подрядчика, слот и сделку. */
  async function book(w: { token: string; weddingId: string }, categoryId: string, price: number) {
    const vendor = await newVendor(categoryId)
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === categoryId)!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: idem(w.token),
      payload: { vendorId: vendor.vendorId, price: { amount: price, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id
    return { vendor, slotId: slot.id, dealId }
  }

  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
    (await app.db!.query<T>(sql, params)).rows[0] ?? null

  const count = async (sql: string, params: unknown[]) =>
    Number((await app.db!.query<{ n: string }>(sql, params)).rows[0]!.n)

  const busyDates = (vendorId: string) =>
    count('select count(*)::text as n from vendor_busy_dates where vendor_id = $1', [vendorId])

  /* ── T005: выполненную сделку отмена свадьбы не трогает ───────────── */
  it('отмена свадьбы отменяет брони и не трогает выполненную сделку', async () => {
    const w = await newWedding()
    const finished = await book(w, 'photo', 8_500_000)
    const booked = await book(w, 'video', 6_000_000)

    // Фотограф отснял свадьбу: сделка выполнена, день у него состоялся.
    const done = await app.inject({
      method: 'PATCH',
      url: `/deals/${finished.dealId}`,
      headers: idem(w.token),
      payload: { state: 'done' },
    })
    expect(done.statusCode, done.body.slice(0, 200)).toBe(200)
    expect(await busyDates(finished.vendor.vendorId)).toBe(1)
    expect(await busyDates(booked.vendor.vendorId)).toBe(1)

    // Помощник отменить свадьбу не может: это решение пары (FR-001).
    const helperInvite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'helper' },
    })
    const helper = await newUser()
    await app.inject({
      method: 'POST',
      url: `/invites/${helperInvite.json().code as string}/accept`,
      headers: auth(helper.token),
    })
    const refused = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/cancel`,
      headers: auth(helper.token),
    })
    expect(refused.statusCode).toBe(403)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/cancel`,
      headers: auth(w.token),
    })
    expect(cancelled.statusCode).toBe(200)
    // Ровно одна отменённая сделка — та, что была `booked`. Схема контракта
    // `CancelResult`: state плюс счётчик, без `done` в нём.
    expect(cancelled.json()).toEqual({ state: 'cancelled', cancelledDeals: 1 })

    const states = await one<{ finished: string; booked: string }>(
      `select (select state from deals where id = $1) as finished,
              (select state from deals where id = $2) as booked`,
      [finished.dealId, booked.dealId],
    )
    expect(states).toEqual({ finished: 'done', booked: 'cancelled' })

    /* Журнал сделки — откуда и куда. `returning state` после `update` отдаёт
     * уже новое состояние, и в базе лежали события `cancelled → cancelled`
     * (ERR-0206); исходное читается до записи. */
    const event = await one<{ from_state: string; to_state: string }>(
      `select from_state, to_state from deal_events where deal_id = $1 order by at desc, id desc limit 1`,
      [booked.dealId],
    )
    expect(event).toEqual({ from_state: 'booked', to_state: 'cancelled' })

    /* Выполненная работа — состоявшийся день, а не бронь. Снятие занятости
     * отдавало этот день другой паре, а подрядчик получал «Сделка отменена»
     * по съёмке, которую уже провёл. */
    expect(await busyDates(finished.vendor.vendorId)).toBe(1)
    expect(await busyDates(booked.vendor.vendorId)).toBe(0)

    const slots = await one<{ finished: string | null; booked: string | null }>(
      'select (select deal_id from slots where id = $1) as finished, (select deal_id from slots where id = $2) as booked',
      [finished.slotId, booked.slotId],
    )
    // Слот выполненной сделки остаётся занятым ею: иначе мозаика после
    // отмены показывает сделанную работу пустой плиткой.
    expect(slots!.finished).toBe(finished.dealId)
    expect(slots!.booked).toBeNull()
  })

  /* ── T011: уборка архива ──────────────────────────────────────────── */
  it('уборка удаляет отменённую свадьбу старше срока — и только её', async () => {
    /* Свадьба 1: отменена, в архиве 400 дней. У её выполненной сделки
     * осталась занятая дата у подрядчика — её и должна снять уборка. */
    const old = await newWedding()
    const oldDeal = await book(old, 'photo', 5_000_000)
    await app.inject({
      method: 'PATCH',
      url: `/deals/${oldDeal.dealId}`,
      headers: idem(old.token),
      payload: { state: 'done' },
    })
    await app.inject({ method: 'POST', url: `/weddings/${old.weddingId}/cancel`, headers: auth(old.token) })
    expect(await busyDates(oldDeal.vendor.vendorId)).toBe(1)
    await app.db!.query(
      "update weddings set archived_at = now() - interval '400 days' where id = $1",
      [old.weddingId],
    )

    // Свадьба 2: отменена вчера — срок хранения ещё идёт.
    const fresh = await newWedding()
    await app.inject({ method: 'POST', url: `/weddings/${fresh.weddingId}/cancel`, headers: auth(fresh.token) })
    await app.db!.query("update weddings set archived_at = now() - interval '1 day' where id = $1", [fresh.weddingId])

    /* Свадьба 3: синтетическая — архив без отмены. Продукт такую не создаёт
     * (`archived_at` ставится только отменой), но именно она отвечает на
     * вопрос, по какому полю уборка решает: по `cancelled_at`, а не по
     * `archived_at`. Иначе состоявшийся проект стёрся бы вместе с альбомом. */
    const kept = await newWedding()
    await app.db!.query(
      "update weddings set archived_at = now() - interval '400 days' where id = $1",
      [kept.weddingId],
    )

    /* Счётчик из ответа не проверяем на «не меньше одной»: базу делит
     * `jobs.test`, чья уборка идёт в соседнем процессе и могла забрать эту
     * свадьбу первой — тогда здесь честно вернётся 0. Доказательство —
     * состояние базы и след в журнале ниже, они не зависят от того, чей
     * проход успел (R-177). */
    const removed = await cleanup(app)
    expect(removed.weddings_purged).toBeTypeOf('number')

    const alive = async (id: string) => count('select count(*)::text as n from weddings where id = $1', [id])
    expect(await alive(old.weddingId)).toBe(0)
    expect(await alive(fresh.weddingId)).toBe(1)
    expect(await alive(kept.weddingId)).toBe(1)

    // Каскад по `weddings.id` уносит всё содержимое проекта.
    expect(await count('select count(*)::text as n from wedding_members where wedding_id = $1', [old.weddingId])).toBe(0)
    expect(await count('select count(*)::text as n from deals where wedding_id = $1', [old.weddingId])).toBe(0)
    expect(await count('select count(*)::text as n from slots where wedding_id = $1', [old.weddingId])).toBe(0)

    /* А вот занятость подрядчика каскад НЕ снимает: `vendor_busy_dates.deal_id`
     * стоит `ON DELETE SET NULL`, и без явного удаления дата осталась бы
     * занятой навсегда, с обнулённой ссылкой и без всякого способа её найти. */
    expect(await busyDates(oldDeal.vendor.vendorId)).toBe(0)

    const trace = await one<{ actor_id: string | null; diff: { cancelledAt: string; archivedAt: string } }>(
      `select actor_id, diff from audit_log
        where action = 'wedding.purged' and entity = 'wedding' and entity_id = $1`,
      [old.weddingId],
    )
    // След обязателен: строк свадьбы больше нет, и без журнала об удалении
    // не узнать ничего (FR-008). Имени сотрудника нет — убирает платформа.
    expect(trace, 'уборка обязана оставить строку в журнале действий').not.toBeNull()
    expect(trace!.actor_id).toBeNull()
    expect(trace!.diff.cancelledAt).toBeTruthy()
    expect(trace!.diff.archivedAt).toBeTruthy()
  })

  /* ── V-01: отзыв пары не должен блокировать уборку ────────────────── */

  /** Рейтинг подрядчика ровно в том виде, в каком его считает `recomputeRating`. */
  const ratingOf = (vendorId: string) =>
    one<{ rating: string | null; reviews_count: number }>(
      'select rating::text as rating, reviews_count from vendors where id = $1',
      [vendorId],
    )

  /**
   * Свадьба, отменённая и просроченная в архиве, с отзывом ПАРЫ по
   * выполненной сделке.
   *
   * Отзыв пары оставляется тем же путём, каким его оставляет пара: право на
   * него — завершённая сделка, а не строка в базе.
   */
  async function cancelledWithCoupleReview(archivedDays: number) {
    const w = await newWedding()
    const deal = await book(w, 'photo', 5_000_000)
    const done = await app.inject({
      method: 'PATCH',
      url: `/deals/${deal.dealId}`,
      headers: idem(w.token),
      payload: { state: 'done' },
    })
    expect(done.statusCode, done.body.slice(0, 200)).toBe(200)

    const review = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${deal.vendor.vendorId}/reviews`,
      headers: auth(w.token),
      payload: { rating: 5, text: `Отлично отработал ${RUN}` },
    })
    expect(review.statusCode, review.body.slice(0, 200)).toBe(201)

    await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })
    await app.db!.query('update weddings set archived_at = now() - make_interval(days => $2) where id = $1', [
      w.weddingId,
      archivedDays,
    ])
    return { ...w, deal }
  }

  it('уборка убирает свадьбу, а отзывы — и пары, и гостя — оставляет подрядчику с прежним рейтингом', async () => {
    const w = await cancelledWithCoupleReview(900)
    const vendorId = w.deal.vendor.vendorId

    /* Отзыв гостя — прямо в базу: продуктовый путь потребовал бы ссылки
     * гостя и прошедшей даты свадьбы, а проверяется здесь не он, а каскад.
     * У отзыва гостя свой ключ (`guest_token`), сделки у него нет. */
    const guestToken = `guest-${RUN}-${++counter}`
    const guestReviewId = randomUUID()
    await app.db!.query(
      `insert into reviews (id, vendor_id, wedding_id, source, guest_token, stars, text)
       values ($1,$2,$3,'guest',$4,4,'Было вкусно')`,
      [guestReviewId, vendorId, w.weddingId, guestToken],
    )
    /* Тот же пересчёт, что делает обработчик отзыва гостя: строку мы вставили
     * мимо него, а без пересчёта в `reviews_count` остался бы один отзыв
     * пары — и «стало меньше» после уборки ничего не доказывало бы. */
    await recomputeRating(app.db!, vendorId)
    expect((await ratingOf(vendorId))!.reviews_count).toBe(2)

    // Счётчик не утверждаем — соседний прогон мог убрать свадьбу первым (см. выше, R-177).
    const removed = await cleanup(app)
    expect(removed.weddings_purged).toBeTypeOf('number')

    /* Главное: свадьба удалена. Каскад по сделкам обнуляет `reviews.deal_id`;
     * до фичи 014 `CHECK reviews_key_matches_source` требовал его у отзыва
     * пары — `delete from weddings` падал на этой проверке, откатывал всю
     * партию, `isolated()` глотал ошибку, и первая по `archived_at` свадьба
     * возвращалась в выборку следующего прохода уже навсегда (ERR-0209).
     * Уборка тогда удаляла отзыв пары заранее; миграция 1760500000000
     * ослабила проверку, и отзыв остаётся (решение владельца, B5). */
    expect(await count('select count(*)::text as n from weddings where id = $1', [w.weddingId])).toBe(0)
    // Чей бы проход ни успел — след в журнале ровно один (FR-008).
    expect(
      await count(
        `select count(*)::text as n from audit_log
          where action = 'wedding.purged' and entity = 'wedding' and entity_id = $1`,
        [w.weddingId],
      ),
    ).toBe(1)

    // Отзыв пары остаётся подрядчику: свадьба и сделка у него — `null`.
    const couple = await one<{ deal_id: string | null; wedding_id: string | null }>(
      "select deal_id, wedding_id from reviews where vendor_id = $1 and source = 'couple'",
      [vendorId],
    )
    expect(couple, 'отзыв пары переживает уборку (фича 014, B5)').not.toBeNull()
    expect(couple!.deal_id).toBeNull()
    expect(couple!.wedding_id).toBeNull()

    /* Отзыв гостя остаётся историей подрядчика, `wedding_id` обнуляется
     * каскадом — проверку это не нарушает, ключ у него свой. */
    const guest = await one<{ wedding_id: string | null; vendor_id: string; deal_id: string | null }>(
      'select wedding_id, vendor_id, deal_id from reviews where id = $1',
      [guestReviewId],
    )
    expect(guest, 'отзыв гостя переживает уборку').not.toBeNull()
    expect(guest!.wedding_id).toBeNull()
    expect(guest!.vendor_id).toBe(vendorId)

    /* Рейтинг — как был: оба отзыва на месте, пересчитывать нечего. */
    const rating = await ratingOf(vendorId)
    expect(rating!.reviews_count).toBe(2)
  })

  it('одна свадьба с отзывом не блокирует уборку остальных', async () => {
    /* Партия шла одной транзакцией: сбой на первой уносил всю. Свадьба
     * с отзывом стоит в выборке ПЕРВОЙ (`order by archived_at`), поэтому
     * без транзакции на свадьбу не убиралось вообще ничего. */
    const poisoned = await cancelledWithCoupleReview(1000)

    const plain = await newWedding()
    await app.inject({ method: 'POST', url: `/weddings/${plain.weddingId}/cancel`, headers: auth(plain.token) })
    await app.db!.query("update weddings set archived_at = now() - interval '999 days' where id = $1", [
      plain.weddingId,
    ])

    await cleanup(app)

    const alive = async (id: string) => count('select count(*)::text as n from weddings where id = $1', [id])
    expect(await alive(poisoned.weddingId)).toBe(0)
    expect(await alive(plain.weddingId), 'соседняя свадьба не должна ждать плохую').toBe(0)
  })

  /* ── V-05: ушедший партнёр не запирает отмену ─────────────────────── */

  /** Второй партнёр в паре — приглашением с ролью «couple», как в продукте. */
  async function addPartner(w: { token: string; weddingId: string }) {
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'couple' },
    })
    expect(invite.statusCode, invite.body.slice(0, 200)).toBe(201)
    const partner = await newUser()
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code as string}/accept`,
      headers: auth(partner.token),
    })
    expect(accepted.statusCode, accepted.body.slice(0, 200)).toBe(200)
    return partner
  }

  it('после ухода партнёра отмена проходит с первого нажатия', async () => {
    const w = await newWedding()
    const partner = await addPartner(w)

    // Партнёр удалил аккаунт: строка в `wedding_members` остаётся, человека
    // нет. Подтверждать отмену стало некому.
    await app.db!.query('update users set deleted_at = now() where id = $1', [partner.id])

    /* Участники считались без `users.deleted_at is null`, поэтому оставшийся
     * видел `confirmation_required` на КАЖДОЕ нажатие: свадьбу нельзя было
     * ни отменить, ни оставить — она висела вечно. */
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/cancel`,
      headers: auth(w.token),
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(res.json().state).toBe('cancelled')
    expect(await count('select count(*)::text as n from weddings where id = $1 and cancelled_at is not null', [
      w.weddingId,
    ])).toBe(1)
  })

  /* ── V-07: две отмены сразу дают одну запись ──────────────────────── */
  it('два одновременных подтверждения отменяют свадьбу один раз', async () => {
    const w = await newWedding()
    const partner = await addPartner(w)

    // Первый партнёр запросил отмену — свадьба ещё жива, идёт срок в 72 часа.
    const asked = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/cancel`,
      headers: auth(w.token),
    })
    expect(asked.json().state).toBe('confirmation_required')

    /* Второй нажимает несколько раз сразу — двойной клик, повтор сети, два
     * устройства. Без `for update` все транзакции читали строку до отмены и
     * все доходили до записи: в журнале появлялась вторая `wedding.cancelled`,
     * а `archived_at` сдвигался — срок хранения архива начинался заново.
     * Четыре запроса, а не два: одному достаточно опоздать на миллисекунду,
     * чтобы упереться в 404 от хука доступа и гонку не показать. */
    const shots = await Promise.all(
      [1, 2, 3, 4].map(() =>
        app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(partner.token) }),
      ),
    )
    // Опоздавший либо видит уже отменённую свадьбу, либо не видит её вовсе:
    // архивную свадьбу хук доступа не отдаёт (404).
    for (const res of shots) expect([200, 404]).toContain(res.statusCode)
    expect(shots.some((r) => r.statusCode === 200)).toBe(true)

    const cancelRecords = () =>
      count(
        `select count(*)::text as n from audit_log
          where action = 'wedding.cancelled' and entity = 'wedding' and entity_id = $1`,
        [w.weddingId],
      )
    expect(await cancelRecords(), 'отмена записывается в журнал ровно один раз').toBe(1)

    // И последовательный повтор ничего не добавляет: свадьба уже в архиве.
    const again = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/cancel`,
      headers: auth(partner.token),
    })
    expect(again.statusCode).toBe(404)
    expect(await cancelRecords()).toBe(1)
  })
})
