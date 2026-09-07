import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Админка платформы (фича tasks/фичи/001-админка), фаза 2 — основа.
 *
 * Две вещи, без которых панели не бывает.
 *
 * Первая: человек должен узнать, сотрудник он или нет. Признак `users.is_staff`
 * лежал в базе и наружу не выходил вовсе — меню «Мы» не могло решить, показывать
 * ли пункт «Админка», и единственным способом это выяснить был запрос в саму
 * панель с чтением 403. Признак отдаётся только про себя и только на чтение:
 * тело `PATCH /users/me` его не принимает, иначе «сделай меня админом» стало бы
 * одним запросом (SC-004).
 *
 * Вторая: `PUT /admin/categories` заменяет словарь синонимов ЦЕЛИКОМ, а прочитать
 * его было неоткуда. Экран правил бы словарь вслепую и стирал бы строки, которых
 * сотрудник ни разу не видел.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/** Категория для круга PUT → GET. Ни один тест её не трогает, значения возвращаются. */
const CAT = 'vykup'

interface AdminCategory {
  id: string
  title: string
  icon: string | null
  sort: number
}

describe.skipIf(!live)('админка: основа панели сотрудника', () => {
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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`

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
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  /** Права сотрудника ставятся руками в базе при найме — пути для этого нет и не будет. */
  async function newStaff() {
    const user = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    return user
  }

  const readCategories = async (token: string) => {
    const res = await app.inject({ method: 'GET', url: '/admin/categories', headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as { categories: AdminCategory[]; synonyms: Record<string, string> }
  }

  /* ── признак сотрудника ───────────────────────────────────────────── */
  it('профиль называет признак сотрудника, а изменить его нельзя', async () => {
    const user = await newUser()
    const before = await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })
    expect(before.statusCode).toBe(200)
    /* Именно false, а не отсутствие поля: «не знаем» и «не сотрудник» —
     * разные ответы, и меню «Мы» рисуется по этому различию. */
    expect(before.json().isStaff).toBe(false)

    // Права в теле профиля — это повышение прав в один запрос (SC-004).
    const patched = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(user.token),
      payload: { isStaff: true },
    })
    expect(patched.statusCode).toBe(422)
    expect(patched.json().error.code).toBe('validation_failed')

    const still = await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })
    expect(still.json().isStaff).toBe(false)
    // Проверка по базе, а не по ответу экрана: 422 мог бы прийти уже после записи.
    const { rows } = await app.db!.query<{ is_staff: boolean }>('select is_staff from users where id = $1', [
      user.userId,
    ])
    expect(rows[0]!.is_staff).toBe(false)

    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })
    expect(after.json().isStaff).toBe(true)
  })

  /* ── категории и словарь ──────────────────────────────────────────── */
  it('категории панели закрыты для постороннего и открыты сотруднику', async () => {
    const stranger = await newUser()
    const denied = await app.inject({ method: 'GET', url: '/admin/categories', headers: auth(stranger.token) })
    // 404 сказал бы, что пути нет, и это была бы неправда.
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('forbidden')

    const staff = await newStaff()
    const body = await readCategories(staff.token)
    expect(body.categories.length).toBeGreaterThan(30)
    const photo = body.categories.find((c) => c.id === 'photo')
    expect(photo).toBeDefined()
    expect(photo!.title.length).toBeGreaterThan(0)
    expect(typeof photo!.sort).toBe('number')
    // Словарь — объект «слово → категория», а не список и не пропущенное поле.
    expect(Array.isArray(body.synonyms)).toBe(false)
    expect(typeof body.synonyms).toBe('object')
  })

  it('словарь синонимов читается целиком — иначе панель правит его вслепую', async () => {
    const staff = await newStaff()
    const word = `синоним${RUN}`
    await app.db!.query(
      `insert into category_synonyms (word, category_id) values ($1, 'photo')
       on conflict (word) do update set category_id = excluded.category_id`,
      [word],
    )
    const body = await readCategories(staff.token)
    expect(body.synonyms[word]).toBe('photo')
  })

  it('круг PUT → GET сходится, а пропущенный значок остаётся прежним', async () => {
    const staff = await newStaff()
    const pick = async () => (await readCategories(staff.token)).categories.find((c) => c.id === CAT)!
    const before = await pick()
    expect(before).toBeDefined()

    const put = async (payload: unknown) => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/categories',
        headers: auth(staff.token),
        payload,
      })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      return res.json() as { categories: number; synonyms: number }
    }

    try {
      const written = await put({ categories: [{ id: CAT, title: `Выкуп ${RUN}`, icon: '🧪', sort: before.sort }] })
      expect(written).toEqual({ categories: 1, synonyms: 0 })
      const saved = await pick()
      expect(saved.title).toBe(`Выкуп ${RUN}`)
      expect(saved.icon).toBe('🧪')
      expect(saved.sort).toBe(before.sort)

      /* Клиент не шлёт `icon: null` — он опускает поле, и значок должен
       * остаться прежним. Иначе правка названия стирала бы картинку. */
      await put({ categories: [{ id: CAT, title: `Выкуп ${RUN} и ещё`, sort: before.sort }] })
      const kept = await pick()
      expect(kept.title).toBe(`Выкуп ${RUN} и ещё`)
      expect(kept.icon).toBe('🧪')
    } finally {
      // Справочник общий: возвращаем как было, чтобы соседние наборы читали своё.
      await put({
        categories: [
          before.icon === null
            ? { id: CAT, title: before.title, sort: before.sort }
            : { id: CAT, title: before.title, icon: before.icon, sort: before.sort },
        ],
      })
    }
  })
})
