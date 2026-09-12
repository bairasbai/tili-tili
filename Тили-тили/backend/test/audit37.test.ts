/*
 * Фича 008 — импорт гостей списком: `POST /weddings/{weddingId}/guests/import`.
 *
 * Правила: одна транзакция, дубликаты (имя без регистра и лишних пробелов
 * или телефон — с базой и внутри запроса) пропускаются с причиной, телефон
 * нормализуется к `+7XXXXXXXXXX`, не распознанный — `invalid` и не заводится,
 * остальные заводятся; повтор того же списка добавляет ноль; два одновременных
 * импорта одного списка не дают дублей (замок строки свадьбы).
 * Красный без фикса: путь отвечал 501 `not_implemented`.
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

type Guest = { id: string; name: string; phone?: string | null; plusOne: boolean }
type ImportResult = { created: Guest[]; skipped: { index: number; name: string; reason: 'duplicate' | 'invalid' }[] }

describe.skipIf(!live)('фича 008: импорт гостей списком', () => {
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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id }
  }

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  const importGuests = (w: { token: string; weddingId: string }, guests: unknown) =>
    app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests/import`, headers: auth(w.token), payload: { guests } })

  const listGuests = async (w: { token: string; weddingId: string }) =>
    (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/guests`, headers: auth(w.token) })).json() as Guest[]

  it('три строки → три гостя; телефон нормализован; повтор того же списка добавляет ноль с причиной duplicate', async () => {
    const w = await newWedding()
    const rows = [
      { name: 'Анна Петрова', phone: '8 917 000 11 22', plusOne: true },
      { name: 'Марк' },
      { name: 'Ольга и Сергей', phone: '+7 (917) 000-33-44' },
    ]
    const first = await importGuests(w, rows)
    expect(first.statusCode, first.body.slice(0, 300)).toBe(201)
    const body = first.json() as ImportResult
    expect(body.created.map((g) => g.name)).toEqual(['Анна Петрова', 'Марк', 'Ольга и Сергей'])
    expect(body.created[0]!.plusOne).toBe(true)
    expect(body.created[0]!.phone, 'телефон не приведён к +7XXXXXXXXXX').toBe('+79170001122')
    expect(body.created[2]!.phone).toBe('+79170003344')
    expect(body.skipped).toEqual([])
    expect((await listGuests(w)).length).toBe(3)

    const again = await importGuests(w, rows)
    expect(again.statusCode, again.body.slice(0, 300)).toBe(201)
    const twice = again.json() as ImportResult
    expect(twice.created).toEqual([])
    expect(twice.skipped.map((s) => s.reason)).toEqual(['duplicate', 'duplicate', 'duplicate'])
    expect((await listGuests(w)).length, 'повтор списка размножил гостей').toBe(3)
  })

  it('дубликаты внутри запроса и с базой — по имени без регистра/пробелов и по телефону; строка с кривым телефоном — invalid, остальные заводятся', async () => {
    const w = await newWedding()
    const seeded = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Иван Иванов', phone: '+79170005566' },
    })
    expect(seeded.statusCode).toBe(201)

    const res = await importGuests(w, [
      { name: '  иван   ИВАНОВ ' }, // дубликат по имени (регистр, пробелы)
      { name: 'Пётр Смирнов', phone: '8 (917) 000-55-66' }, // дубликат по телефону с базой
      { name: 'Кирилл', phone: '12345' }, // телефон не распознан
      { name: 'Дарья' },
      { name: 'Дарья', plusOne: true }, // дубликат внутри запроса
      { name: 'Егор', phone: '+79170007788' },
      { name: 'Елена', phone: '89170007788' }, // тот же телефон внутри запроса
    ])
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201)
    const body = res.json() as ImportResult
    expect(body.created.map((g) => g.name)).toEqual(['Дарья', 'Егор'])
    expect(body.skipped).toEqual([
      { index: 0, name: '  иван   ИВАНОВ ', reason: 'duplicate' },
      { index: 1, name: 'Пётр Смирнов', reason: 'duplicate' },
      { index: 2, name: 'Кирилл', reason: 'invalid' },
      { index: 4, name: 'Дарья', reason: 'duplicate' },
      { index: 6, name: 'Елена', reason: 'duplicate' },
    ])
    expect((await listGuests(w)).length).toBe(3)
  })

  it('пустой список и 301 строка — 422; чужая свадьба — 404; помощник импортирует так же, как пара', async () => {
    const w = await newWedding()
    expect((await importGuests(w, [])).statusCode).toBe(422)
    const tooMany = Array.from({ length: 301 }, (_, i) => ({ name: `Гость ${i}` }))
    expect((await importGuests(w, tooMany)).statusCode).toBe(422)

    const stranger = await newUser()
    const foreign = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/import`,
      headers: auth(stranger.token),
      payload: { guests: [{ name: 'Чужой' }] },
    })
    expect([403, 404]).toContain(foreign.statusCode)

    // Помощник — через приглашение в команду.
    const invite = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/invites`, headers: auth(w.token), payload: { role: 'helper' } })
    expect(invite.statusCode, invite.body.slice(0, 200)).toBe(201)
    const helper = await newUser()
    const accepted = await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper.token) })
    expect(accepted.statusCode, accepted.body.slice(0, 200)).toBe(200)
    const byHelper = await importGuests({ token: helper.token, weddingId: w.weddingId }, [{ name: 'Гость помощника' }])
    expect(byHelper.statusCode, byHelper.body.slice(0, 200)).toBe(201)
    expect((byHelper.json() as ImportResult).created).toHaveLength(1)
  })

  /* Деталь задачи (фича 008, экран 12): `PATCH …/tasks/{id} { title }` до сих пор не имел ни одного
   * теста — фронт получил «Переименовать», и правило «имя меняется, выполнение нет» закрепляется здесь. */
  it('переименование задачи: PATCH { title } меняет имя, не трогая отметку; пустое имя — 422; чужая задача — 404', async () => {
    const w = await newWedding()
    const list = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/tasks`, headers: auth(w.token) })
    expect(list.statusCode).toBe(200)
    const task = (list.json() as { id: string; title: string; done: boolean }[])[0]!
    const done = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/tasks/${task.id}`, headers: auth(w.token), payload: { done: true } })
    expect(done.statusCode, done.body.slice(0, 200)).toBe(200)
    const renamed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/tasks/${task.id}`, headers: auth(w.token), payload: { title: 'Заказать торт у бабушки' } })
    expect(renamed.statusCode, renamed.body.slice(0, 200)).toBe(200)
    expect(renamed.json()).toMatchObject({ id: task.id, title: 'Заказать торт у бабушки', done: true })
    expect((await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/tasks/${task.id}`, headers: auth(w.token), payload: { title: '' } })).statusCode).toBe(422)
    const other = await newWedding()
    expect((await app.inject({ method: 'PATCH', url: `/weddings/${other.weddingId}/tasks/${task.id}`, headers: auth(other.token), payload: { title: 'Чужая' } })).statusCode).toBe(404)
  })

  it('два одновременных импорта одного списка — гостей ровно столько, сколько строк', async () => {
    const w = await newWedding()
    const rows = Array.from({ length: 20 }, (_, i) => ({ name: `Одновременный ${i}` }))
    const [a, b] = await Promise.all([importGuests(w, rows), importGuests(w, rows)])
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    const created = (a.json() as ImportResult).created.length + (b.json() as ImportResult).created.length
    expect(created, 'параллельные импорты завели дубли').toBe(20)
    expect((await listGuests(w)).length).toBe(20)
  })
})
