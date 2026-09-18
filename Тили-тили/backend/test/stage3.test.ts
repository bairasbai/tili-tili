import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { rotateNewcomers } from '../src/catalog/vendors.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('этап 3: каталог и анкета подрядчика', () => {
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
    reader = (await newUser()).token
  })

  afterAll(async () => {
    await app?.close()
  })

  /** Каталог за входом — всем чтениям нужен токен. */
  let reader = ''

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

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

  async function newUser(name?: string) {
    const phone = nextPhone()
    expect(
      (await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })).statusCode,
    ).toBe(200)
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const { accessToken, user } = v.json()
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/users/me/consent',
          headers: auth(accessToken),
          payload: { policyVersion: '2026-09-02' },
        })
      ).statusCode,
    ).toBe(201)
    if (name) await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(accessToken), payload: { name } })
    return { token: accessToken, id: user.id }
  }

  /** Подрядчик с анкетой; по умолчанию опубликован. */
  async function newVendor(extra: Record<string, unknown> = {}, publish = true) {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Фотограф ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
        priceFrom: { amount: 8_500_000, currency: 'RUB' },
        ...extra,
      },
    })
    expect(res.statusCode).toBe(200)
    if (publish) {
      expect(
        (await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })).statusCode,
      ).toBe(200)
    }
    return { ...user, vendorId: res.json().id as string }
  }

  /* ── справочник ───────────────────────────────────────────────────── */
  it('категорий ровно 35 и у каждой есть подпись', async () => {
    const res = await app.inject({ method: 'GET', url: '/catalog/categories', headers: auth(reader) })
    expect(res.statusCode).toBe(200)
    const list = res.json() as { id: string; title: string }[]
    expect(list).toHaveLength(35)
    expect(list.every((c) => c.title.length > 0)).toBe(true)
    expect(list.map((c) => c.id)).toContain('photo')
  })

  /* ── главный критерий: занятая дата убирает из выдачи ─────────────── */
  it('подрядчик с занятой датой из выдачи исчезает', async () => {
    const vendor = await newVendor()
    const date = `2027-06-${String(randomInt(10, 28)).padStart(2, '0')}`

    const before = await app.inject({ method: 'GET', url: `/catalog/vendors?q=${RUN}&categoryId=photo&date=${date}&limit=100`, headers: auth(reader) })
    expect((before.json().items as { id: string }[]).map((v) => v.id)).toContain(vendor.vendorId)

    const busy = await app.inject({
      method: 'POST',
      url: '/vendor/calendar/busy',
      headers: auth(vendor.token),
      payload: { dates: [date], status: 'busy' },
    })
    expect(busy.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: `/catalog/vendors?q=${RUN}&categoryId=photo&date=${date}&limit=100`, headers: auth(reader) })
    expect((after.json().items as { id: string }[]).map((v) => v.id)).not.toContain(vendor.vendorId)

    // Без фильтра по дате он на месте: исчез именно на эту дату.
    const noFilter = await app.inject({ method: 'GET', url: `/catalog/vendors?q=${RUN}&categoryId=photo&limit=100`, headers: auth(reader) })
    expect((noFilter.json().items as { id: string }[]).map((v) => v.id)).toContain(vendor.vendorId)
  })

  it('занятость видна в календаре подрядчика и в анкете', async () => {
    const vendor = await newVendor()
    await app.inject({
      method: 'POST',
      url: '/vendor/calendar/busy',
      headers: auth(vendor.token),
      payload: { dates: ['2027-07-03', '2027-07-04'], status: 'busy' },
    })

    const calendar = await app.inject({
      method: 'GET',
      url: '/vendor/calendar?month=2027-07',
      headers: auth(vendor.token),
    })
    // `source` отличает свою занятость от даты под сделкой: снять вторую
    // нельзя, и кабинет обязан показать это до нажатия.
    expect(calendar.json()).toEqual([
      { date: '2027-07-03', status: 'busy', source: 'manual' },
      { date: '2027-07-04', status: 'busy', source: 'manual' },
    ])

    const availability = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}/availability?month=2027-07`,
      headers: auth(reader),
    })
    expect(availability.json().busyDates).toEqual(['2027-07-03', '2027-07-04'])

    // Другой месяц пуст — фильтр по месяцу работает, а не игнорируется.
    const other = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}/availability?month=2027-08`,
      headers: auth(reader),
    })
    expect(other.json().busyDates).toEqual([])
  })

  it('дата под сделкой не снимается кнопкой в календаре', async () => {
    const vendor = await newVendor()
    // Так занятость будет выглядеть после брони на этапе 4.
    await app.db!.query(
      "insert into vendor_busy_dates (vendor_id, date, source) values ($1, '2027-09-09'::date, 'deal')",
      [vendor.vendorId],
    )
    const res = await app.inject({
      method: 'POST',
      url: '/vendor/calendar/busy',
      headers: auth(vendor.token),
      payload: { dates: ['2027-09-09'], status: 'free' },
    })
    expect(res.statusCode).toBe(204)

    const { rows } = await app.db!.query(
      "select 1 from vendor_busy_dates where vendor_id = $1 and date = '2027-09-09'::date",
      [vendor.vendorId],
    )
    // Иначе пара приезжает на свадьбу к тому, кто в этот день уже занят.
    expect(rows).toHaveLength(1)
  })

  /* ── главный критерий: видео длиннее 180 с ────────────────────────── */
  it('видео 200 секунд отклоняется', async () => {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: 'Видеограф',
        categoryId: 'video',
        city: { name: 'Уфа', region: 'Башкортостан' },
        media: [{ kind: 'video', url: 'https://example.test/v.mp4', durationS: 200 }],
      },
    })
    expect(res.statusCode).toBe(422)
  })

  it('видео без длительности отклоняется внятно, а не пятисоткой из БД', async () => {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: 'Видеограф',
        categoryId: 'video',
        city: { name: 'Уфа', region: 'Башкортостан' },
        media: [{ kind: 'video', url: 'https://example.test/v.mp4' }],
      },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('video_duration_required')
  })

  it('видео 180 секунд принимается', async () => {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: 'Видеограф',
        categoryId: 'video',
        city: { name: 'Уфа', region: 'Башкортостан' },
        media: [{ kind: 'video', url: 'https://example.test/v.mp4', durationS: 180 }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().hasVideo).toBe(true)
  })

  it('ограничение длительности стоит и в базе, а не только в схеме', async () => {
    const vendor = await newVendor()
    await expect(
      app.db!.query(
        "insert into vendor_media (id, vendor_id, kind, url, duration_s) values (gen_random_uuid(), $1, 'video', 'x', 999)",
        [vendor.vendorId],
      ),
    ).rejects.toThrow()
  })

  /* ── главный критерий: ротация новичков ───────────────────────────── */
  it('в выдаче из 20 анкет минимум 2 без отзывов', async () => {
    // Своя категория, чтобы соседние тесты не влияли на состав выдачи.
    const category = 'decor'
    const withReviews: string[] = []
    for (let i = 0; i < 20; i++) {
      const v = await newVendor({ categoryId: category })
      withReviews.push(v.vendorId)
    }
    // У двадцати есть отзывы — они бы заняли всю страницу.
    await app.db!.query('update vendors set reviews_count = 7, rating = 4.8 where id = any($1::uuid[])', [withReviews])
    // И два новичка без единого отзыва.
    await newVendor({ categoryId: category })
    await newVendor({ categoryId: category })

    const res = await app.inject({ method: 'GET', url: `/catalog/vendors?q=${RUN}&categoryId=${category}&limit=20`, headers: auth(reader) })
    const items = res.json().items as { reviewsCount: number }[]
    expect(items).toHaveLength(20)
    expect(items.filter((v) => v.reviewsCount === 0).length).toBeGreaterThanOrEqual(2)
  })

  /* ── документы верификации ────────────────────────────────────────── */
  it('документы верификации не попадают ни в один ответ каталога', async () => {
    const vendor = await newVendor()
    await app.db!.query(
      `insert into vendor_verifications (id, vendor_id, kind, file_url, inn, status, checked_at)
       values (gen_random_uuid(), $1, 'passport', 'https://storage.test/passport-scan.jpg', '027812345678', 'approved', now())`,
      [vendor.vendorId],
    )
    await app.db!.query('update vendors set verified_at = now() where id = $1', [vendor.vendorId])

    const detail = await app.inject({ method: 'GET', url: `/catalog/vendors/${vendor.vendorId}`, headers: auth(reader) })
    const list = await app.inject({ method: 'GET', url: `/catalog/vendors?q=${RUN}&categoryId=photo&limit=100`, headers: auth(reader) })
    const mine = await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(vendor.token) })

    // Наружу выходит только галочка. Скан паспорта и ИНН — никогда.
    expect(detail.json().verified).toBe(true)
    for (const body of [detail.body, list.body, mine.body]) {
      expect(body).not.toContain('passport-scan')
      expect(body).not.toContain('027812345678')
      expect(body).not.toContain('file_url')
    }
  })

  /* ── анкета и публикация ──────────────────────────────────────────── */
  it('неопубликованная анкета не видна в каталоге, но видна владельцу', async () => {
    const vendor = await newVendor({}, false)
    const list = await app.inject({ method: 'GET', url: `/catalog/vendors?q=${RUN}&categoryId=photo&limit=100`, headers: auth(reader) })
    expect((list.json().items as { id: string }[]).map((v) => v.id)).not.toContain(vendor.vendorId)

    const direct = await app.inject({ method: 'GET', url: `/catalog/vendors/${vendor.vendorId}`, headers: auth(reader) })
    expect(direct.statusCode).toBe(404)

    const mine = await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(vendor.token) })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().published).toBe(false)
  })

  it('анкета одна на аккаунт: повторный PUT правит, а не заводит вторую', async () => {
    const vendor = await newVendor()
    const again = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendor.token),
      payload: { name: 'Новое имя', categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    expect(again.statusCode).toBe(200)
    expect(again.json().id).toBe(vendor.vendorId)
    expect(again.json().name).toBe('Новое имя')

    const { rows } = await app.db!.query('select count(*)::int as n from vendors where user_id = $1', [vendor.id])
    expect(rows[0]!.n).toBe(1)
  })

  it('пакеты и медиа заменяются целиком, а не дописываются', async () => {
    const user = await newUser()
    const put = (packages: unknown[]) =>
      app.inject({
        method: 'PUT',
        url: '/vendor/profile',
        headers: auth(user.token),
        payload: {
          name: 'Студия',
          categoryId: 'photo',
          city: { name: 'Уфа', region: 'Башкортостан' },
          packages,
        },
      })

    await put([
      { name: 'Базовый', price: { amount: 5_000_000, currency: 'RUB' }, includes: ['4 часа'] },
      { name: 'Полный', price: { amount: 9_000_000, currency: 'RUB' }, includes: ['8 часов'] },
    ])
    const after = await put([{ name: 'Единственный', price: { amount: 7_000_000, currency: 'RUB' } }])
    const packages = after.json().packages as { name: string }[]
    // Удалённая позиция не должна воскреснуть — иначе пара покупает то,
    // что подрядчик уже не предлагает.
    expect(packages.map((p) => p.name)).toEqual(['Единственный'])
  })

  it('анкета в несуществующей категории и городе не создаётся', async () => {
    const user = await newUser()
    const badCategory = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: { name: 'Студия', categoryId: 'нет-такой', city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    expect(badCategory.statusCode).toBe(404)

    const badCity = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: { name: 'Студия', categoryId: 'photo', city: { name: 'Нью-Васюки', region: 'Нигде' } },
    })
    expect(badCity.statusCode).toBe(404)
  })

  it('без анкеты профиль отвечает 404, остальные пути кабинета — 403, а не пустотой', async () => {
    const user = await newUser()
    /* 404 — только у профиля: по нему экран показывает «Анкеты ещё нет». Календарь
       и публикация без анкеты — 403, как пути кабинета в `vendorCabinet.ts` (ревью 015, V15). */
    expect((await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(user.token) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/vendor/calendar', headers: auth(user.token) })).statusCode).toBe(403)
    expect(
      (await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })).statusCode,
    ).toBe(403)
  })

  /* ── фильтры ──────────────────────────────────────────────────────── */
  it('фильтры по цене, рейтингу и видео', async () => {
    const category = 'cake'
    const cheap = await newVendor({ categoryId: category, priceFrom: { amount: 1_000_000, currency: 'RUB' } })
    const rich = await newVendor({
      categoryId: category,
      priceFrom: { amount: 50_000_000, currency: 'RUB' },
      media: [{ kind: 'video', url: 'https://example.test/a.mp4', durationS: 60 }],
    })
    await app.db!.query('update vendors set rating = 4.9 where id = $1', [rich.vendorId])

    const byPrice = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?q=${RUN}&categoryId=${category}&priceMax=2000000&limit=100`,
      headers: auth(reader),
    })
    const priceIds = (byPrice.json().items as { id: string }[]).map((v) => v.id)
    expect(priceIds).toContain(cheap.vendorId)
    expect(priceIds).not.toContain(rich.vendorId)

    const byVideo = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?q=${RUN}&categoryId=${category}&hasVideo=true&limit=100`,
      headers: auth(reader),
    })
    const videoIds = (byVideo.json().items as { id: string }[]).map((v) => v.id)
    expect(videoIds).toContain(rich.vendorId)
    expect(videoIds).not.toContain(cheap.vendorId)

    const byRating = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?q=${RUN}&categoryId=${category}&ratingMin=4.5&limit=100`,
      headers: auth(reader),
    })
    expect((byRating.json().items as { id: string }[]).map((v) => v.id)).not.toContain(cheap.vendorId)
  })

  it('неизвестный параметр фильтра отвергается', async () => {
    const res = await app.inject({ method: 'GET', url: `/catalog/vendors?q=${RUN}&categoryId=photo&hasVideoo=true`, headers: auth(reader) })
    expect(res.statusCode).toBe(422)
  })

  /* ── избранное ────────────────────────────────────────────────────── */
  it('избранное добавляется дважды без ошибки и снимается', async () => {
    const vendor = await newVendor()
    const user = await newUser()

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'PUT',
        url: `/me/favorites/${vendor.vendorId}`,
        headers: auth(user.token),
      })
      expect(res.statusCode).toBe(204)
    }

    const list = await app.inject({ method: 'GET', url: '/me/favorites', headers: auth(user.token) })
    expect((list.json() as { id: string }[]).filter((v) => v.id === vendor.vendorId)).toHaveLength(1)

    expect(
      (
        await app.inject({ method: 'DELETE', url: `/me/favorites/${vendor.vendorId}`, headers: auth(user.token) })
      ).statusCode,
    ).toBe(204)
    // Повторное снятие — тоже успех: результат ровно тот, которого хотели.
    expect(
      (
        await app.inject({ method: 'DELETE', url: `/me/favorites/${vendor.vendorId}`, headers: auth(user.token) })
      ).statusCode,
    ).toBe(204)

    const empty = await app.inject({ method: 'GET', url: '/me/favorites', headers: auth(user.token) })
    expect((empty.json() as { id: string }[]).map((v) => v.id)).not.toContain(vendor.vendorId)
  })

  it('в избранное нельзя положить неопубликованную или выдуманную анкету', async () => {
    const hidden = await newVendor({}, false)
    const user = await newUser()
    expect(
      (await app.inject({ method: 'PUT', url: `/me/favorites/${hidden.vendorId}`, headers: auth(user.token) }))
        .statusCode,
    ).toBe(404)
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/me/favorites/01a06426-0000-7000-8000-000000000000',
          headers: auth(user.token),
        })
      ).statusCode,
    ).toBe(404)
  })

  /* ── консьерж ─────────────────────────────────────────────────────── */
  it('заявка консьержу сохраняется, выдуманная категория отвергается', async () => {
    const user = await newUser()
    const ok = await app.inject({
      method: 'POST',
      url: '/catalog/concierge',
      headers: auth(user.token),
      payload: {
        categoryId: 'host',
        city: 'Уфа',
        budget: { amount: 6_000_000, currency: 'RUB' },
        comment: 'Нужен ведущий на 80 гостей',
      },
    })
    expect(ok.statusCode).toBe(201)

    const { rows } = await app.db!.query<{ status: string; budget: string }>(
      'select status, budget::text as budget from concierge_requests where user_id = $1',
      [user.id],
    )
    expect(rows[0]).toMatchObject({ status: 'new', budget: '6000000' })

    const bad = await app.inject({
      method: 'POST',
      url: '/catalog/concierge',
      headers: auth(user.token),
      payload: { categoryId: 'нет-такой' },
    })
    expect(bad.statusCode).toBe(404)
  })

  /* ── загрузка файлов отложена осознанно ───────────────────────────── */
  it('загрузка файлов отвечает 501 со своей причиной, а не общей заглушкой', async () => {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/media/upload-url',
      headers: auth(user.token),
      payload: { kind: 'vendor_photo', contentType: 'image/jpeg', sizeBytes: 1000 },
    })
    expect(res.statusCode).toBe(501)
    expect(res.json().error.code).toBe('storage_not_configured')
  })
})

/* ── чистая функция ротации ───────────────────────────────────────── */
describe('ротация новичков', () => {
  const v = (id: string, reviewsCount: number) => ({ id, reviewsCount })

  it('добавляет новичков, когда их меньше десятой части страницы', () => {
    const items = Array.from({ length: 20 }, (_, i) => v(`old${i}`, 5))
    const out = rotateNewcomers(items, 20, [v('new1', 0), v('new2', 0), v('new3', 0)])
    expect(out.items).toHaveLength(20)
    expect(out.items.filter((x) => x.reviewsCount === 0)).toHaveLength(2)
    // Верх выдачи не трогается: вытесняется хвост.
    expect(out.items[0]!.id).toBe('old0')
    // Вытесненные должны попасть на следующую страницу — по счётчику
    // считается курсор.
    expect(out.keptFromMain).toBe(18)
  })

  it('ничего не меняет, когда новичков уже достаточно', () => {
    const items = [...Array.from({ length: 15 }, (_, i) => v(`old${i}`, 5)), ...Array.from({ length: 5 }, (_, i) => v(`new${i}`, 0))]
    expect(rotateNewcomers(items, 20, [v('extra', 0)])).toEqual({ items, keptFromMain: 20 })
  })

  it('не дублирует того, кто уже в выдаче', () => {
    const items = Array.from({ length: 20 }, (_, i) => v(`x${i}`, 5))
    const out = rotateNewcomers(items, 20, [v('x0', 0), v('fresh', 0)])
    expect(new Set(out.items.map((x) => x.id)).size).toBe(out.items.length)
  })

  it('пустой запас оставляет выдачу как есть', () => {
    const items = Array.from({ length: 20 }, (_, i) => v(`old${i}`, 5))
    expect(rotateNewcomers(items, 20, [])).toEqual({ items, keptFromMain: 20 })
  })
})
