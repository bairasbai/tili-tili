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
import { PROFILES_METRIC_SQL } from '../src/routes/admin.js'

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
    return { vendorId: put.json().id as string }
  }

  async function metrics(token: string): Promise<Metrics> {
    const res = await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as Metrics
  }

  it('profiles: published — тот же снимок, что vendorsPublished; заполненность считает определение спеки на своих трёх анкетах', async () => {
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])

    // (i) Один снимок сервера: published — тот же набор, что vendorsPublished.
    const snap = await metrics(staff.token)
    expect(snap.profiles, 'в ответе дашборда нет profiles').toBeTruthy()
    expect(snap.profiles!.published, 'profiles.published — тот же набор, что vendorsPublished').toBe(snap.vendorsPublished)

    /* Определение спеки (Р1) — своей копией SQL, а не текстом дашборда:
       сверка ниже (ii) доказывает, что копия и константа обработчика
       (`PROFILES_METRIC_SQL`) считают одно и то же. Функция, а не голая
       строка: (iii) переиспользует ЭТОТ ЖЕ текст с фильтром по своим id
       (ARB-3 — один текст формулы, не третья копия, F6-G5-06), а не только
       без фильтра, как в (ii). */
    const DEFINITION = (extraWhere = '') => `select count(*)::text as published,
              count(*) filter (where n = 4)::text as complete,
              coalesce(round(100 * avg(n / 4.0)), 0)::text as avg
         from (select (case when coalesce(v.about, '') <> '' then 1 else 0 end
                     + case when v.phone is not null then 1 else 0 end
                     + case when v.price_from is not null then 1 else 0 end
                     + case when exists (select 1 from vendor_packages p where p.vendor_id = v.id) then 1 else 0 end) as n
                 from vendors v join users u on u.id = v.user_id and u.deleted_at is null
                where v.published_at is not null and v.blocked_at is null ${extraWhere}) f`

    /* (ii) F6-d: константа обработчика и определение спеки — в ОДНОМ снимке
       (`repeatable read`), а не «снимок сервера → SQL секунду позже»: сосед
       не может подвинуть базу МЕЖДУ двумя запросами одной транзакции, гонка
       с параллельными файлами исключена конструктивно, а не вероятностно. */
    const [fromMetric, fromSpec] = await app.db!.tx(async (client) => {
      await client.query('set transaction isolation level repeatable read')
      const metric = await client.query<{ published: string; complete: string; average_percent: string }>(PROFILES_METRIC_SQL)
      const spec = await client.query<{ published: string; complete: string; avg: string }>(DEFINITION())
      return [metric.rows[0]!, spec.rows[0]!]
    })
    expect(Number(fromMetric.published)).toBe(Number(fromSpec.published))
    expect(Number(fromMetric.complete)).toBe(Number(fromSpec.complete))
    expect(Number(fromMetric.average_percent)).toBe(Number(fromSpec.avg))

    // (iii) Свои три анкеты, посчитанные строго по своим id (без дельт по всей базе, R-177):
    // пустая — 0/4, половинная — 2/4, полная — 4/4; черновик не публикуется и не попадает в выборку.
    const empty = await profile({}, true)
    const half = await profile({ about: 'Оформляем залы', priceFrom: { amount: 3_000_000, currency: 'RUB' } }, true)
    const full = await profile({
      about: 'Полный декор', phone: '+79170009900', priceFrom: { amount: 5_000_000, currency: 'RUB' },
      packages: [{ name: 'Базовый', price: { amount: 5_000_000, currency: 'RUB' }, includes: ['арка'] }],
    }, true)
    const draft = await profile({ about: 'Черновик', phone: '+79170009901', priceFrom: { amount: 100, currency: 'RUB' }, packages: [{ name: 'x' }] }, false)

    // F6-G5-06: тот же DEFINITION, что и в (ii) — не третья копия формулы, —
    // с фильтром по своим id: пустая (0/4) + половинная (2/4) + полная (4/4)
    // дают published=3, complete=1 (только полная); черновик не публикуется —
    // если бы он попал в выборку, published было бы 4, а не 3.
    const own = [empty.vendorId, half.vendorId, full.vendorId, draft.vendorId]
    const { rows: filtered } = await app.db!.query<{ published: string; complete: string; avg: string }>(
      DEFINITION('and v.id = any($1)'),
      [own],
    )
    expect(Number(filtered[0]!.published), 'черновик не публикуется — его нет среди опубликованных').toBe(3)
    expect(Number(filtered[0]!.complete)).toBe(1)
    expect(Number(filtered[0]!.avg)).toBe(50)
  })
})
