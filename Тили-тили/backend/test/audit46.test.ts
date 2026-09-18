/*
 * Хвосты четырёх планов (сверка планов 2026-09-18) — бэкенд.
 *
 * П1  согласие: `adult` пишется в `consents.adult` и в журнал; без поля — false.
 * П2  анкета: `mediaRights: true` ставит момент и виден владельцу; `false` и
 *     отсутствие поля прежнее подтверждение не снимают.
 * П3  `POST /notifications/read-all` — только непрочитанные, повтор — 0.
 * П4  `PATCH /weddings/{id}/album` — все кадры разом, повтор — 0, гость по токену — не пускается.
 * П5  `GET /catalog/categories?city` — `vendorsCount` считает живые опубликованные анкеты города.
 * П6  текст сторожа §18.2 не обещает эскроу (R-174).
 * П7  «после свадьбы»: отзывы на +1 при сделках, ключ шага держит один раз; итоги на +14.
 * П8  сводка кейтерингу за 14 дней: порции, блюда, диеты, трансфер; повтор — 0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { PAYOUT_WARNING } from '../src/chats/guard.js'
import { afterWedding, cateringSummary } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('хвосты планов: тексты', () => {
  it('П6: сторож переписки не обещает эскроу, которого нет', () => {
    expect(PAYOUT_WARNING.toLowerCase()).not.toContain('эскроу')
    expect(PAYOUT_WARNING).toContain('Договор')
  })
})

describe.skipIf(!live)('хвосты планов: бэкенд', () => {
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

  async function newUser(consent: Record<string, unknown> = { policyVersion: '2026-09-02', adult: true }) {
    const phone = nextPhone()
    const body = await login(phone)
    const c = await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: consent })
    expect(c.statusCode, c.body.slice(0, 200)).toBe(201)
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  /* Дата — от `current_date` базы, как считает задача: UTC-полночь в JS и
     полночь сервера базы расходятся на часы, и «+14 дней» у полуночи
     попадали бы в разные сутки. */
  const dbDate = async (shiftDays: number) =>
    (await app.db!.query<{ d: string }>(`select to_char(current_date + $1::int, 'YYYY-MM-DD') as d`, [shiftDays])).rows[0]!.d

  async function newWedding(date = '2027-06-14') {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date, city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }
  type Wedding = Awaited<ReturnType<typeof newWedding>>

  const notes = async (w: Wedding) =>
    (await app.inject({ method: 'GET', url: '/notifications', headers: auth(w.token) })).json() as { id: string; title: string; body: string; link: string | null; read: boolean }[]

  async function vendorOf(owner: { token: string }, categoryId: string, extra: Record<string, unknown> = {}, city = 'Уфа', region = 'Башкортостан') {
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Студия ${RUN}-${++counter}`, categoryId, city: { name: city, region }, priceFrom: { amount: 4_000_000, currency: 'RUB' }, ...extra },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    return put.json() as { id: string; mediaRights: boolean }
  }
  const publish = (owner: { token: string }) => app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
  const myProfile = async (owner: { token: string }) =>
    (await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(owner.token) })).json() as { mediaRights: boolean }

  it('П1: «мне есть 18» пишется в согласие и в журнал; без поля — false', async () => {
    const adult = await newUser({ policyVersion: '2026-09-02', adult: true })
    const silent = await newUser({ policyVersion: '2026-09-02' })
    const { rows: a } = await app.db!.query<{ adult: boolean }>('select adult from consents where user_id = $1', [adult.userId])
    const { rows: s } = await app.db!.query<{ adult: boolean }>('select adult from consents where user_id = $1', [silent.userId])
    expect(a[0]!.adult).toBe(true)
    expect(s[0]!.adult).toBe(false)
    const { rows: log } = await app.db!.query<{ diff: { adult?: boolean } }>(
      `select diff from audit_log where actor_id = $1 and action = 'consent.given'`,
      [adult.userId],
    )
    expect(log[0]!.diff.adult).toBe(true)
  })

  it('П2: права на портфолио ставятся один раз и не снимаются сохранением', async () => {
    const owner = await newUser()
    const first = await vendorOf(owner, 'photo')
    expect(first.mediaRights).toBe(false)
    const confirmed = await vendorOf(owner, 'photo', { mediaRights: true })
    expect(confirmed.mediaRights).toBe(true)
    // Сохранение имени без поля и даже с `false` подтверждение не трогает.
    await vendorOf(owner, 'photo')
    expect((await myProfile(owner)).mediaRights).toBe(true)
    await vendorOf(owner, 'photo', { mediaRights: false })
    expect((await myProfile(owner)).mediaRights).toBe(true)
    const { rows } = await app.db!.query<{ media_rights_at: Date | null }>('select media_rights_at from vendors where id = $1', [confirmed.id])
    expect(rows[0]!.media_rights_at).not.toBeNull()
  })

  it('П3: «прочитать все» — только непрочитанные, повтор пустой', async () => {
    const w = await newWedding()
    for (const title of ['Первое', 'Второе', 'Третье']) {
      await app.db!.query(
        `insert into notifications (id, user_id, kind, title, body) values ($1, $2, 'system', $3, 'тест')`,
        [randomUUID(), w.userId, title],
      )
    }
    const one = (await notes(w))[0]!
    await app.inject({ method: 'POST', url: `/notifications/${one.id}/read`, headers: auth(w.token) })
    const all = await app.inject({ method: 'POST', url: '/notifications/read-all', headers: auth(w.token) })
    expect(all.statusCode, all.body).toBe(200)
    expect(all.json().marked).toBe(2)
    expect((await notes(w)).every((n) => n.read)).toBe(true)
    expect((await app.inject({ method: 'POST', url: '/notifications/read-all', headers: auth(w.token) })).json().marked).toBe(0)
    expect((await app.inject({ method: 'POST', url: '/notifications/read-all' })).statusCode).toBe(401)
  })

  it('П4: альбом одобряется одним запросом; повтор — 0; гость по токену не пускается', async () => {
    const w = await newWedding()
    for (let i = 0; i < 3; i++) {
      await app.db!.query('insert into album_photos (id, wedding_id, url, approved) values ($1, $2, $3, $4)', [
        randomUUID(),
        w.weddingId,
        `https://example.com/${RUN}-${i}.jpg`,
        i === 0,
      ])
    }
    const res = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/album`, headers: auth(w.token), payload: { approved: true } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().updated).toBe(2)
    const again = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/album`, headers: auth(w.token), payload: { approved: true } })
    expect(again.json().updated).toBe(0)
    const { rows } = await app.db!.query<{ n: string }>('select count(*)::text as n from album_photos where wedding_id = $1 and approved', [w.weddingId])
    expect(Number(rows[0]!.n)).toBe(3)
    // Гость видит альбом по токену, но одобрять кадры — не его дело.
    const created = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w.token), payload: { name: 'Ольга' } })
    const link = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests/${created.json().id as string}/invite-link`, headers: auth(w.token) })
    const code = (link.json().url as string).split('/').pop()!
    const token = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string
    const asGuest = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/album?guestToken=${token}`, payload: { approved: false } })
    expect(asGuest.statusCode).toBe(401)
  })

  it('П5: счётчик анкет по городу растёт на одну после публикации и не видит чужой город', async () => {
    const cats = async (city?: string) =>
      (await app.inject({ method: 'GET', url: `/catalog/categories${city ? `?city=${encodeURIComponent(city)}` : ''}`, headers: auth(owner.token) })).json() as {
        id: string
        vendorsCount: number
      }[]
    const owner = await newUser()
    const before = (await cats('Уфа')).find((c) => c.id === 'florist')!.vendorsCount
    const beforeElsewhere = (await cats('Стерлитамак')).find((c) => c.id === 'florist')!.vendorsCount
    await vendorOf(owner, 'florist', { mediaRights: true })
    // До публикации счётчик стоит: анкеты в каталоге ещё нет.
    expect((await cats('Уфа')).find((c) => c.id === 'florist')!.vendorsCount).toBe(before)
    expect((await publish(owner)).statusCode).toBe(200)
    expect((await cats('Уфа')).find((c) => c.id === 'florist')!.vendorsCount).toBe(before + 1)
    expect((await cats('Стерлитамак')).find((c) => c.id === 'florist')!.vendorsCount).toBe(beforeElsewhere)
    const total = (await cats()).find((c) => c.id === 'florist')!.vendorsCount
    expect(total).toBeGreaterThanOrEqual(before + 1)
  })

  it('П7: «после свадьбы» — отзывы на следующий день при сделках, ключ шага держит один раз; итоги на +14', async () => {
    const w = await newWedding()
    const owner = await newUser()
    const v = await vendorOf(owner, 'florist', { mediaRights: true })
    await publish(owner)
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json() as { id: string; categoryId: string }[]
    const florist = slots.find((s) => s.categoryId === 'florist')!
    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${florist.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId: v.id, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(booked.statusCode, booked.body.slice(0, 200)).toBe(200)
    // Свадьба «была вчера»: дата двигается прямо в базе — перенос через API
    // в прошлое не пускает, а задача смотрит только на дату.
    await app.db!.query('update weddings set date = current_date - 1 where id = $1', [w.weddingId])
    await afterWedding(app)
    const first = await notes(w)
    expect(first.filter((n) => n.title === 'Свадьба прошла — оцените команду')).toHaveLength(1)
    expect(first.find((n) => n.title === 'Свадьба прошла — оцените команду')!.link).toBe('/after')
    // Альбом пуст — напоминать не о чем; итоги ещё рано.
    expect(first.some((n) => n.title === 'Гости прислали кадры')).toBe(false)
    expect(first.some((n) => n.title === 'Итоги свадьбы')).toBe(false)
    await afterWedding(app)
    expect((await notes(w)).filter((n) => n.title === 'Свадьба прошла — оцените команду')).toHaveLength(1)
    await app.db!.query('update weddings set date = current_date - 14 where id = $1', [w.weddingId])
    await afterWedding(app)
    const later = await notes(w)
    expect(later.filter((n) => n.title === 'Итоги свадьбы')).toHaveLength(1)
    // Помощник отзывов не пишет — шаги идут только паре.
    const { rows: marks } = await app.db!.query<{ key: string }>('select key from job_marks where key like $1 order by key', [`after:${w.weddingId}:%`])
    expect(marks.map((m) => m.key)).toEqual([`after:${w.weddingId}:results`, `after:${w.weddingId}:reviews`])
  })

  it('П8: сводка кейтерингу за 14 дней — порции, блюда, диеты, трансфер; повтор — 0', async () => {
    const w = await newWedding(await dbDate(14))
    const g1 = (await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w.token), payload: { name: 'Ольга', plusOne: true } })).json() as { id: string }
    const g2 = (await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w.token), payload: { name: 'Марк' } })).json() as { id: string }
    await app.db!.query(`update guests set rsvp = 'yes', rsvp_at = now(), diet = 'vegan', transfer = 'need' where id = $1`, [g1.id])
    await app.db!.query(`update guests set rsvp = 'yes', rsvp_at = now() where id = $1`, [g2.id])
    const poll = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }] },
    })
    expect(poll.statusCode, poll.body.slice(0, 200)).toBe(200)
    const { rows: options } = await app.db!.query<{ id: string; name: string }>('select id, name from menu_options where wedding_id = $1 order by sort', [w.weddingId])
    await app.db!.query('insert into menu_votes (guest_id, option_id) values ($1, $2), ($3, $2)', [g1.id, options[0]!.id, g2.id])
    expect(await cateringSummary(app)).toBeGreaterThanOrEqual(1)
    const mine = (await notes(w)).filter((n) => n.title === 'Сводка для кейтеринга')
    expect(mine).toHaveLength(1)
    expect(mine[0]!.body).toContain('Порций: 3')
    expect(mine[0]!.body).toContain('Рыба — 2')
    expect(mine[0]!.body).toContain('особое питание: 1')
    expect(mine[0]!.body).toContain('трансфер нужен: 1')
    expect(mine[0]!.link).toBe('/catering')
    await cateringSummary(app)
    expect((await notes(w)).filter((n) => n.title === 'Сводка для кейтеринга')).toHaveLength(1)
  })
})
