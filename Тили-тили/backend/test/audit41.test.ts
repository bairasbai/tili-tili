/*
 * Фича 012 — заполненность анкет на дашборде (`AdminMetrics.profiles`).
 *
 * Определение (спека Р1): доля заполненных из четырёх полей — описание,
 * рабочий телефон, цена «от», хотя бы один пакет; «полная» — 4 из 4; считаются
 * живые опубликованные анкеты. Проверка — по разности «до/после»: в общей базе
 * тысячи анкет, и абсолютные числа тут ничьи. Три новые анкеты — пустая (0/4),
 * половинная (2/4) и полная (4/4) — двигают `published` на 3, `complete` на 1,
 * а сумму долей на 1,5; неопубликованная не двигает ничего. Красный без фикса:
 * поля `profiles` в ответе не было.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

type Metrics = { vendorsPublished: number; profiles?: { published: number; complete: number; averagePercent: number } }

describe.skipIf(!live)('фича 012: заполненность анкет на дашборде', () => {
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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id }
  }

  async function profile(fields: Record<string, unknown>, publish: boolean) {
    const owner = await newUser()
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Анкета ${RUN}-${counter}`, categoryId: 'decor', city: { name: 'Уфа', region: 'Башкортостан' }, ...fields },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    if (publish) {
      const pub = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
      expect(pub.statusCode, pub.body.slice(0, 200)).toBe(200)
    }
  }

  async function metrics(token: string): Promise<Metrics> {
    const res = await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as Metrics
  }

  it('profiles: пустая, половинная и полная анкеты двигают published на 3, complete на 1, среднее — по долям; черновик не считается', async () => {
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])
    const before = await metrics(staff.token)
    expect(before.profiles, 'в ответе дашборда нет profiles').toBeTruthy()
    expect(before.profiles!.published, 'profiles.published — тот же набор, что vendorsPublished').toBe(before.vendorsPublished)

    await profile({}, true) // 0 из 4
    await profile({ about: 'Оформляем залы', priceFrom: { amount: 3_000_000, currency: 'RUB' } }, true) // 2 из 4
    await profile({
      about: 'Полный декор', phone: '+79170009900', priceFrom: { amount: 5_000_000, currency: 'RUB' },
      packages: [{ name: 'Базовый', price: { amount: 5_000_000, currency: 'RUB' }, includes: ['арка'] }],
    }, true) // 4 из 4
    await profile({ about: 'Черновик', phone: '+79170009901', priceFrom: { amount: 100, currency: 'RUB' }, packages: [{ name: 'x' }] }, false)

    const after = await metrics(staff.token)
    /* Соседние файлы прогона публикуют свои анкеты на той же базе (R-177): дельты — «не меньше», не «ровно». */
    expect(after.profiles!.published - before.profiles!.published).toBeGreaterThanOrEqual(3)
    expect(after.profiles!.complete - before.profiles!.complete).toBeGreaterThanOrEqual(1)
    expect(after.profiles!.published, 'profiles.published — тот же набор, что vendorsPublished').toBe(after.vendorsPublished)

    /* Определение спеки — сверкой с SQL по живым опубликованным: доля заполненных из четырёх полей.
       Между снимком сервера и запросом теста соседний файл может опубликовать анкету — поэтому до трёх попыток
       «снимок → SQL», и совпасть должна хотя бы одна пара. */
    const DEFINITION = `select count(*)::text as published,
              count(*) filter (where n = 4)::text as complete,
              coalesce(round(100 * avg(n / 4.0)), 0)::text as avg
         from (select (case when coalesce(v.about, '') <> '' then 1 else 0 end
                     + case when v.phone is not null then 1 else 0 end
                     + case when v.price_from is not null then 1 else 0 end
                     + case when exists (select 1 from vendor_packages p where p.vendor_id = v.id) then 1 else 0 end) as n
                 from vendors v join users u on u.id = v.user_id and u.deleted_at is null
                where v.published_at is not null and v.blocked_at is null) f`
    let matched = false
    let last = ''
    for (let attempt = 0; attempt < 3 && !matched; attempt++) {
      const snap = (await metrics(staff.token)).profiles!
      const { rows } = await app.db!.query<{ published: string; complete: string; avg: string }>(DEFINITION)
      const sql = { published: Number(rows[0]!.published), complete: Number(rows[0]!.complete), averagePercent: Number(rows[0]!.avg) }
      last = `сервер ${JSON.stringify(snap)} · SQL ${JSON.stringify(sql)}`
      /* `published` под полным прогоном растёт между снимком и SQL на десятки анкет (75 файлов публикуют
         свои) — его точность держит равенство с `vendorsPublished` в одном снимке выше; здесь — «SQL не меньше».
         Определение проверяют `complete` (4 из 4 — редкость, чужие тесты его почти не двигают) и среднее. */
      matched = sql.published >= snap.published && snap.complete === sql.complete && snap.averagePercent === sql.averagePercent
    }
    expect(matched, 'profiles не совпали с определением спеки: ' + last).toBe(true)
  })
})
