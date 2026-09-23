import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Волна 1 подготовки к прод-релизу: часовые пояса и полнота выгрузки.
 *
 * Обе находки — не «недоделка», а невыполненное требование: 152-ФЗ даёт
 * право получить ВСЕ свои данные, а день X обязан считаться по местному
 * времени, иначе для половины страны он наступает не тогда.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: часовые пояса и выгрузка', () => {
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

  async function newWedding(city: { name: string; region: string }, date = '2027-06-14') {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city,
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  /* ── часовой пояс ─────────────────────────────────────────────────── */
  it('у каждого города справочника есть часовой пояс', async () => {
    const { rows } = await app.db!.query<{ region: string }>(
      'select distinct region from cities where tz is null',
    )
    /* Регион без зоны означает, что свадьба там снова поедет по Москве.
     * Проверка нужна не сегодня, а в день, когда в справочник добавят
     * новый регион и забудут строку в таблице соответствий. */
    expect(rows.map((r) => r.region)).toEqual([])
  })

  it('свадьба берёт пояс из города, а не остаётся московской', async () => {
    const east = await newWedding({ name: 'Владивосток', region: 'Приморский край' })
    const { rows } = await app.db!.query<{ tz: string | null }>('select tz from weddings where id = $1', [
      east.weddingId,
    ])
    expect(rows[0]!.tz).toBe('Asia/Vladivostok')
  })

  it('чат дня X открывается в 09:00 МЕСТНОГО времени, а не московского', async () => {
    const east = await newWedding({ name: 'Владивосток', region: 'Приморский край' }, '2027-06-14')
    const chats = (await app.inject({ method: 'GET', url: '/chats', headers: auth(east.token) })).json() as {
      kind: string
      openFrom: string | null
    }[]
    /* 09:00 накануне во Владивостоке (UTC+10) — это 23:00 UTC 12 июня.
     * По Москве получилось бы 06:00 UTC 13 июня: чат открывался бы
     * в день свадьбы в 16:00 по местному. */
    expect(chats.find((c) => c.kind === 'day')?.openFrom).toBe('2027-06-12T23:00:00.000Z')
  })

  it('переезд в другой город меняет пояс', async () => {
    const w = await newWedding({ name: 'Казань', region: 'Татарстан' })
    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { city: { name: 'Красноярск', region: 'Красноярский край' } },
    })
    const { rows } = await app.db!.query<{ tz: string }>('select tz from weddings where id = $1', [w.weddingId])
    expect(rows[0]!.tz).toBe('Asia/Krasnoyarsk')
  })

  it('явно указанный пояс побеждает пояс города', async () => {
    const w = await newWedding({ name: 'Казань', region: 'Татарстан' })
    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { city: { name: 'Красноярск', region: 'Красноярский край' }, tz: 'Europe/Samara' },
    })
    const { rows } = await app.db!.query<{ tz: string }>('select tz from weddings where id = $1', [w.weddingId])
    // Человек мог поправить пояс сам: свадьба бывает не в том городе,
    // где живёт пара.
    expect(rows[0]!.tz).toBe('Europe/Samara')
  })

  it('неизвестный пояс — 422, а не пятисотка', async () => {
    const w = await newWedding({ name: 'Казань', region: 'Татарстан' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { tz: 'Мордор/Барад-Дур' },
    })
    /* Зона уходит в `AT TIME ZONE` внутри триггера: неизвестная роняла
     * запрос ошибкой базы, а в Sentry летел ложный инцидент. */
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('unknown_timezone')

    const me = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(w.token),
      payload: { tz: 'что-то не то' },
    })
    expect(me.statusCode).toBe(422)
  })

  /* ── выгрузка данных ──────────────────────────────────────────────── */
  it('выгрузка отдаёт всё, что человек внёс', async () => {
    const w = await newWedding({ name: 'Казань', region: 'Татарстан' })
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Аня Гостева' },
    })
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/budget/items`,
      headers: auth(w.token),
      payload: { title: 'Торт от бабушки', categoryId: 'b4', amount: { amount: 1_500_000, currency: 'RUB' } },
    })
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/wishlist`,
      headers: auth(w.token),
      payload: { name: 'Кофемашина', price: { amount: 6_200_000, currency: 'RUB' } },
    })

    const dump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(w.token) })
    expect(dump.statusCode).toBe(200)
    const data = dump.json() as Record<string, unknown>

    /* 152-ФЗ даёт право получить ВСЕ свои данные. Раньше выгрузка отдавала
     * профиль, согласия, сессии и список свадеб — и молча теряла гостей,
     * бюджет, сделки и подарки. */
    for (const key of ['guests', 'deals', 'payments', 'budget', 'gifts', 'tasks', 'notifications', 'messages']) {
      expect({ key, есть: key in data }).toEqual({ key, есть: true })
    }
    expect(dump.body).toContain('Аня Гостева')
    expect(dump.body).toContain('Торт от бабушки')
    expect(dump.body).toContain('Кофемашина')
    // Чек-лист заводится вместе со свадьбой — значит, он не пустой.
    expect((data.tasks as unknown[]).length).toBeGreaterThan(0)
  })

  it('выгрузка не отдаёт чужого: ни токенов гостей, ни чужих сообщений', async () => {
    const w = await newWedding({ name: 'Казань', region: 'Татарстан' })
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

    const dump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(w.token) })
    /* Право на свои данные — не право на данные всех, кто рядом.
     * Гостевой токен в выгрузке пары сломал бы анонимность резервов (§9). */
    expect(dump.body).not.toContain(guestToken)
    expect(dump.body).not.toContain('rsvp_token')
  })

  it('человек без свадьбы получает выгрузку, а не ошибку', async () => {
    const user = await newUser()
    const dump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(user.token) })
    expect(dump.statusCode).toBe(200)
    // Пустой список свадеб означает пустые выборки, а не выгрузку всей базы.
    expect(dump.json().guests).toEqual([])
    expect(dump.json().deals).toEqual([])
  })
})
