/*
 * Корзина 1 после сверки планов (2026-09-18) — бэкенд.
 *
 * Т1  подсказки §3.14: дефицит категории — число из той же выборки, что каталог; бронь снимает подсказку;
 *     блокирующий слот — «Доставка букета и деталей» без флориста; лимит бюджета — > 85 % плана категории.
 * Т2  подсказки — только паре: помощнику 403 (в них суммы), чужой свадьбе 404.
 * Т3  карточка сделки в кабинете: `paid`, `chatId`, заголовок договора без полей сторон.
 * Т4  заполненность анкеты: одно правило у кабинета и у панели; `missing` называет поля.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { profileCompleteness, COMPLETENESS_FIELDS } from '../src/vendor/completeness.js'
import { BLOCK_DEPENDENCIES, BUDGET_ALERT_RATIO, DEFICIT_THRESHOLD } from '../src/wedding/tips.js'
import { TIMELINE_TEMPLATE } from '../src/wedding/templates.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('корзина 1: чистые правила', () => {
  it('Т4: заполненность — четыре поля, missing называет отсутствующие', () => {
    expect(profileCompleteness({ about: '', phone: null, priceFrom: null, packagesCount: 0 })).toEqual({ pct: 0, missing: [...COMPLETENESS_FIELDS] })
    expect(profileCompleteness({ about: 'Снимаем', phone: '+79170000000', priceFrom: 100, packagesCount: 0 })).toEqual({ pct: 75, missing: ['packages'] })
    expect(profileCompleteness({ about: ' ', phone: '', priceFrom: 0, packagesCount: 2 })).toEqual({ pct: 50, missing: ['about', 'phone'] })
  })

  it('Т1: зависимости блоков названы именами шаблона тайминга', () => {
    for (const name of Object.keys(BLOCK_DEPENDENCIES)) {
      expect(TIMELINE_TEMPLATE.some((b) => b.name === name), `блока «${name}» нет в шаблоне`).toBe(true)
    }
    expect(BLOCK_DEPENDENCIES['Доставка букета и деталей']).toContain('florist')
    expect(DEFICIT_THRESHOLD).toBe(6)
    expect(BUDGET_ALERT_RATIO).toBe(0.85)
  })
})

describe.skipIf(!live)('корзина 1: бэкенд', () => {
  let app: FastifyInstance
  let counter = 0
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp(
      {
        env: 'test',
        databaseUrl: DB ?? null,
        redisUrl: null,
        corsOrigins: [],
        jwtAccessSecret: SECRET_A,
        jwtRefreshSecret: SECRET_R,
        policyVersion: '2026-09-02',
        otpMaxPerHourTotal: 1_000_000,
        otpMaxPerIpHour: 1_000_000,
      },
      [],
    )
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
  const key = (k = randomUUID()) => ({ 'idempotency-key': k })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 and consumed_at is null order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  async function login(phone: string) {
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    expect(v.statusCode, v.body.slice(0, 200)).toBe(200)
    return v.json() as { accessToken: string; user: { id: string } }
  }

  async function newUser() {
    const phone = nextPhone()
    const body = await login(phone)
    const c = await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02', adult: true } })
    expect(c.statusCode, c.body.slice(0, 200)).toBe(201)
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  const dbDate = async (shiftDays: number) =>
    (await app.db!.query<{ d: string }>(`select to_char(current_date + $1::int, 'YYYY-MM-DD') as d`, [shiftDays])).rows[0]!.d

  async function newWedding(date: string, city = { name: 'Уфа', region: 'Башкортостан' }, budgetTotal = 100_000_000) {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date, city, budgetTotal: { amount: budgetTotal, currency: 'RUB' } },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }
  type Wedding = Awaited<ReturnType<typeof newWedding>>

  type Tip = { kind: string; title: string; body: string; link: string; categoryId?: string | null }
  const tipsOf = async (w: Wedding, token = w.token) => {
    const res = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/tips`, headers: auth(token) })
    return { status: res.statusCode, items: (res.json().items ?? []) as Tip[] }
  }

  async function vendorOf(owner: { token: string }, categoryId: string, city = { name: 'Уфа', region: 'Башкортостан' }, extra: Record<string, unknown> = {}) {
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Студия ${RUN}-${++counter}`, categoryId, city, priceFrom: { amount: 4_000_000, currency: 'RUB' }, mediaRights: true, ...extra },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })).statusCode).toBe(200)
    return put.json() as { id: string }
  }

  async function book(w: Wedding, categoryId: string, vendorId: string, amount: number) {
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === categoryId)!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return slot.id
  }

  it('Т1: дефицит, блокирующий слот и лимит бюджета — из данных свадьбы; бронь снимает подсказки', async () => {
    /* Малый город справочника: свободных флористов там мало или нет — дефицит виден. */
    const CITY = { name: 'Большеустьикинское', region: 'Башкортостан' }
    const date = await dbDate(90)
    const w = await newWedding(date, CITY)
    const before = await tipsOf(w)
    expect(before.status).toBe(200)

    const { rows: free } = await app.db!.query<{ n: string }>(
      `select count(*)::text as n from vendors v
         join users u on u.id = v.user_id and u.deleted_at is null and v.blocked_at is null
         join cities c on c.id = v.city_id
        where v.category_id = 'florist' and v.published_at is not null and c.name = $1
          and not exists (select 1 from vendor_busy_dates b where b.vendor_id = v.id and b.date = $2::date)`,
      [CITY.name, date],
    )
    const n = Number(free[0]!.n)
    const deficit = before.items.find((t) => t.kind === 'deficit' && t.categoryId === 'florist')
    if (n <= DEFICIT_THRESHOLD) {
      expect(deficit, 'дефицит флористов не назван').toBeTruthy()
      expect(deficit!.title).toContain(`: ${n}`)
      expect(deficit!.link).toBe('/search/florist')
    } else {
      expect(deficit).toBeUndefined()
    }
    /* Блокирующий слот: «Доставка букета и деталей» из шаблона держится на флористе. */
    const blocking = before.items.find((t) => t.kind === 'blocking_slot' && t.categoryId === 'florist')
    expect(blocking, 'пустой флорист под блоком тайминга не назван').toBeTruthy()
    expect(blocking!.title).toContain('Доставка букета и деталей')
    expect(before.items.some((t) => t.kind === 'budget'), 'лимит без броней').toBe(false)

    /* Бронь флориста на 90 % плана категории «Развлечения и декор» (11,8 % от 1 000 000 ₽ = 118 000 ₽). */
    const owner = await newUser()
    const v = await vendorOf(owner, 'florist', CITY)
    await book(w, 'florist', v.id, 11_000_000)
    const after = await tipsOf(w)
    expect(after.items.some((t) => t.kind === 'deficit' && t.categoryId === 'florist'), 'дефицит после брони').toBe(false)
    expect(after.items.some((t) => t.kind === 'blocking_slot' && t.categoryId === 'florist'), 'блок после брони').toBe(false)
    const budget = after.items.find((t) => t.kind === 'budget' && t.categoryId === 'b4')
    expect(budget, 'лимит категории не назван').toBeTruthy()
    expect(budget!.title).toMatch(/9\d %|100 %/)
    expect(budget!.link).toBe('/wedding/budget')
  })

  it('Т2: подсказки только паре — помощнику 403, чужой свадьбе 404', async () => {
    const w = await newWedding(await dbDate(120))
    const helper = await newUser()
    const invite = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/invites`, headers: auth(w.token), payload: { role: 'helper', label: 'Тест' } })
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code as string}/accept`, headers: auth(helper.token) })
    expect((await tipsOf(w, helper.token)).status).toBe(403)
    const stranger = await newUser()
    expect((await tipsOf(w, stranger.token)).status).toBe(404)
  })

  it('Т3: карточка сделки в кабинете — paid, chatId и заголовок договора без полей', async () => {
    const w = await newWedding(await dbDate(200))
    const owner = await newUser()
    const v = await vendorOf(owner, 'photo')
    const slotId = await book(w, 'photo', v.id, 8_000_000)
    const paid = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
      headers: { ...auth(w.token), ...key() },
      payload: { amount: { amount: 3_000_000, currency: 'RUB' } },
    })
    expect(paid.statusCode, paid.body.slice(0, 200)).toBe(200)
    const chat = await app.inject({ method: 'POST', url: `/chats/vendor/${v.id}`, headers: auth(w.token) })
    expect([200, 201]).toContain(chat.statusCode)
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json() as { id: string; deal: { id: string } | null }[]
    const dealId = slots.find((s) => s.id === slotId)!.deal!.id
    const contract = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: { ...auth(w.token), ...key() },
      payload: { templateCode: 'photographer', fields: { customerFullName: 'Аня Иванова', performerFullName: 'Студия', passport: '4510 123456' } },
    })
    expect([200, 201], contract.body.slice(0, 200)).toContain(contract.statusCode)
    const list = (await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(owner.token) })).json() as {
      items: { id: string; paid: { amount: number }; chatId: string | null; contract: Record<string, unknown> | null }[]
    }
    const mine = list.items.find((d) => d.id === dealId)!
    expect(mine.paid.amount).toBe(3_000_000)
    expect(mine.chatId).toBe(chat.json().id)
    expect(mine.contract).toMatchObject({ templateCode: 'photographer', version: 1, status: 'draft' })
    expect(JSON.stringify(mine.contract)).not.toContain('4510')
  })

  it('Т4: заполненность в ответе анкеты совпадает с правилом панели', async () => {
    const owner = await newUser()
    await vendorOf(owner, 'dj', undefined, { about: 'Играем всё' })
    const me = (await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(owner.token) })).json() as { id: string; completeness: { pct: number; missing: string[] } }
    expect(me.completeness).toEqual({ pct: 50, missing: ['phone', 'packages'] })
    const { rows } = await app.db!.query<{ n: number }>(
      `select (case when coalesce(v.about, '') <> '' then 1 else 0 end
             + case when v.phone is not null then 1 else 0 end
             + case when v.price_from is not null then 1 else 0 end
             + case when exists (select 1 from vendor_packages p where p.vendor_id = v.id) then 1 else 0 end) as n
         from vendors v where v.id = $1`,
      [me.id],
    )
    expect(Math.round((Number(rows[0]!.n) / 4) * 100), 'панель и кабинет считают по-разному').toBe(me.completeness.pct)
  })
})
