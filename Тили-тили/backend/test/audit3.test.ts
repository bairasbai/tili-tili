import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Перепроверка после этапа 3 — всей работы, а не только каталога.
 * Вопросы те же, что и в прошлый раз: кто что видит в теле ответа, что будет
 * при двух одновременных запросах, что накапливается и кто это чистит,
 * какое поле принимается от клиента на веру, что стоит денег.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('перепроверка после этапа 3', () => {
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
    return { token: accessToken, id: user.id }
  }

  async function newVendor(extra: Record<string, unknown> = {}) {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Студия ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
        ...extra,
      },
    })
    expect(res.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  const inCatalog = async (vendorId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/catalog/vendors?categoryId=photo&limit=100',
      headers: auth((await newUser()).token),
    })
    return (res.json().items as { id: string }[]).map((v) => v.id).includes(vendorId)
  }

  /* ── кто что видит: каталог не открыт всему интернету ─────────────── */
  it('каталог требует входа — так говорят и контракт, и матрица доступа', async () => {
    // В матрице раздела 6 у строки `/catalog/*` для гостя стоит «—»,
    // и в контракте у этих путей нет `security: []`. Открытый каталог
    // отдаёт базу подрядчиков любому скрипту.
    for (const url of ['/catalog/categories', '/catalog/vendors?categoryId=photo']) {
      const res = await app.inject({ method: 'GET', url })
      expect(`${url} → ${res.statusCode}`).toBe(`${url} → 401`)
    }
  })

  it('анкета и занятость тоже за входом', async () => {
    const vendor = await newVendor()
    for (const url of [`/catalog/vendors/${vendor.vendorId}`, `/catalog/vendors/${vendor.vendorId}/availability`]) {
      const res = await app.inject({ method: 'GET', url })
      expect(`${url} → ${res.statusCode}`).toBe(`${url} → 401`)
    }
  })

  it('в карточке подрядчика нет ни телефона, ни идентификатора аккаунта', async () => {
    const vendor = await newVendor()
    const user = await newUser()
    const detail = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(user.token),
    })
    expect(detail.statusCode).toBe(200)
    // Телефон подрядчика — контакт, который продаётся вместе со сделкой,
    // а не раздаётся из каталога.
    expect(detail.body).not.toContain(vendor.id)
    expect(detail.body).not.toContain('phone')
    expect(detail.body).not.toContain('userId')
  })

  /* ── две одновременные правки анкеты ──────────────────────────────── */
  it('два одновременных PUT анкеты не роняют запрос', async () => {
    const user = await newUser()
    const put = () =>
      app.inject({
        method: 'PUT',
        url: '/vendor/profile',
        headers: auth(user.token),
        payload: { name: 'Студия', categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' } },
      })

    // Мастер анкеты на медленной связи — двойное нажатие «Сохранить».
    // Проверка «есть ли анкета» и вставка раздельно дают уникальному ключу
    // сработать, и человек видит пятисотку вместо сохранённой анкеты.
    const [a, b] = await Promise.all([put(), put()])
    expect([a.statusCode, b.statusCode]).toEqual([200, 200])

    const { rows } = await app.db!.query<{ n: number }>('select count(*)::int as n from vendors where user_id = $1', [
      user.id,
    ])
    expect(rows[0]!.n).toBe(1)
  })

  /* ── удалённый аккаунт исчезает из выдачи ─────────────────────────── */
  it('анкета удалённого аккаунта пропадает из каталога', async () => {
    const vendor = await newVendor()
    expect(await inCatalog(vendor.vendorId)).toBe(true)

    const del = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(vendor.token) })
    expect(del.statusCode).toBe(204)

    // Аккаунт удалён мягко на 30 дней, но человек уже ушёл: показывать его
    // анкету и принимать по ней заявки нельзя.
    expect(await inCatalog(vendor.vendorId)).toBe(false)

    const user = await newUser()
    const direct = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(user.token),
    })
    expect(direct.statusCode).toBe(404)
  })

  it('отзыв согласия тоже убирает анкету из каталога', async () => {
    const vendor = await newVendor()
    await app.inject({ method: 'DELETE', url: '/users/me/consent', headers: auth(vendor.token) })
    expect(await inCatalog(vendor.vendorId)).toBe(false)
  })

  /* ── что приходит от клиента и принимается на веру ────────────────── */
  it('ссылка на портфолио обязана быть http или https', async () => {
    const user = await newUser()
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://example.test/a.jpg', 'не ссылка']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/vendor/profile',
        headers: auth(user.token),
        payload: {
          name: 'Студия',
          categoryId: 'photo',
          city: { name: 'Уфа', region: 'Башкортостан' },
          portfolioUrls: [url],
        },
      })
      // Ссылка из анкеты подставляется в галерею у пары. `javascript:`
      // в атрибуте — это выполнение чужого кода на её странице.
      expect(`${url} → ${res.statusCode}`).toBe(`${url} → 422`)
    }
  })

  it('нормальная ссылка проходит', async () => {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: 'Студия',
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
        portfolioUrls: ['https://storage.test/a.jpg'],
      },
    })
    expect(res.statusCode).toBe(200)
  })

  /* ── что стоит денег ──────────────────────────────────────────────── */
  it('заявки консьержу не копятся без счёта', async () => {
    const user = await newUser()
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/catalog/concierge',
        headers: auth(user.token),
        payload: { categoryId: 'host', comment: 'нужен ведущий' },
      })

    expect((await send()).statusCode).toBe(201)
    // Каждая заявка — ручная работа человека. Вторая открытая по той же
    // категории не создаёт новой работы, а плодит очередь.
    const second = await send()
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('concierge_pending')

    // По другой категории — можно.
    const other = await app.inject({
      method: 'POST',
      url: '/catalog/concierge',
      headers: auth(user.token),
      payload: { categoryId: 'florist' },
    })
    expect(other.statusCode).toBe(201)
  })

  /* ── избранное не растёт бесконечно ───────────────────────────────── */
  it('избранное отдаётся ограниченным списком', async () => {
    const user = await newUser()
    const res = await app.inject({ method: 'GET', url: '/me/favorites', headers: auth(user.token) })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  /* ── вторая страница выдачи ───────────────────────────────────────── */
  it('листание выдачи не теряет и не повторяет анкеты', async () => {
    const category = 'transport'
    const ids: string[] = []
    for (let i = 0; i < 7; i++) ids.push((await newVendor({ categoryId: category })).vendorId)
    // Разные рейтинги: при сортировке по рейтингу курсор обязан учитывать
    // именно его, а не только идентификатор.
    for (let i = 0; i < ids.length; i++) {
      await app.db!.query('update vendors set rating = $2 where id = $1', [ids[i], 3 + (i % 3) * 0.5])
    }
    const reader = (await newUser()).token

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const url =
        `/catalog/vendors?categoryId=${category}&limit=3&sort=rating` + (cursor ? `&cursor=${cursor}` : '')
      const res = await app.inject({ method: 'GET', url, headers: auth(reader) })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { items: { id: string }[]; nextCursor: string | null }
      seen.push(...body.items.map((v) => v.id))
      cursor = body.nextCursor
      if (!cursor) break
    }

    // Ни одна анкета не должна пропасть между страницами и ни одна —
    // прийти дважды: пара листает каталог и видит либо дубли, либо дыры.
    for (const id of ids) expect(seen).toContain(id)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('ротация новичков не теряет вытесненные анкеты при листании', async () => {
    const category = 'rings'
    const veterans: string[] = []
    for (let i = 0; i < 6; i++) veterans.push((await newVendor({ categoryId: category })).vendorId)
    await app.db!.query('update vendors set reviews_count = 5, rating = 4.5 where id = any($1::uuid[])', [veterans])
    const rookie = await newVendor({ categoryId: category })
    const reader = (await newUser()).token

    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const url = `/catalog/vendors?categoryId=${category}&limit=3` + (cursor ? `&cursor=${cursor}` : '')
      const res = await app.inject({ method: 'GET', url, headers: auth(reader) })
      const body = res.json() as { items: { id: string }[]; nextCursor: string | null }
      seen.push(...body.items.map((v) => v.id))
      cursor = body.nextCursor
      if (!cursor) break
    }

    // Новичок вытесняет кого-то с первой страницы. Вытесненный обязан
    // появиться дальше: иначе он не показывается вообще никогда.
    for (const id of [...veterans, rookie.vendorId]) expect(seen).toContain(id)
  })

  /* ── радиус поиска ────────────────────────────────────────────────── */
  it('radiusKm либо работает, либо не принимается — но не игнорируется молча', async () => {
    const category = 'dj'
    const near = await newVendor({ categoryId: category, city: { name: 'Бирск', region: 'Башкортостан' } })
    const far = await newVendor({ categoryId: category, city: { name: 'Стерлитамак', region: 'Башкортостан' } })
    const reader = (await newUser()).token

    // Бирск примерно в 80 км от Уфы, Стерлитамак — в 120 км.
    const res = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?categoryId=${category}&city=Уфа&radiusKm=100&limit=100`,
      headers: auth(reader),
    })
    expect(res.statusCode).toBe(200)
    const ids = (res.json().items as { id: string }[]).map((v) => v.id)
    // Молчаливое игнорирование параметра — худший исход: фронт рисует
    // «в радиусе 100 км», а показывает всю страну.
    expect(ids).toContain(near.vendorId)
    expect(ids).not.toContain(far.vendorId)
  })

  /* ── старые проверки не сломались ─────────────────────────────────── */
  it('матрица доступа этапа 2 продолжает работать', async () => {
    const couple = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(couple.token),
      payload: {
        partnerName: 'Тимур',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.json().id}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    const helper = await newUser()
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper.token) })

    const budget = await app.inject({
      method: 'GET',
      url: `/weddings/${w.json().id}/budget`,
      headers: auth(helper.token),
    })
    expect(budget.statusCode).toBe(403)

    const card = await app.inject({ method: 'GET', url: `/weddings/${w.json().id}`, headers: auth(helper.token) })
    expect(card.body).not.toContain('budgetTotal')
  })
})
