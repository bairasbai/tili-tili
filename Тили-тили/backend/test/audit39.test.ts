/*
 * Фича 010 — Тиль на живой модели: путь от реплики пары до реплики Тиля.
 *
 * Модель — подставная реализация `TillyModel` через `buildApp` (подмена
 * внешней службы для проверки, как `ConsoleSender` у SMS; не мок продукта):
 * записывает, что ей прислали, и отвечает заданным текстом или падает.
 * Проверяется: ответ Тиля в чате — текст модели, не заглушка; запрос к модели
 * несёт слоты, задачи, бюджет и гостей свадьбы и НЕ несёт телефонов
 * (План §18); история чата — чередование user/assistant без прежних
 * заглушек; без модели — прежняя честная заглушка; отказ модели — «временно
 * без ИИ» и учёт `failed`; квота 50/сутки — 429 `tilly_daily_limit` без записи
 * реплики, `Chat.tilly.usedToday` совпадает; `AdminMetrics.llm` — по учёту.
 * Красный без фикса: на HEAD `chats.ts` отвечал заглушкой и не знал квоты.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import type { TillyModel, TillyRequest, TillyReply } from '../src/tilly/model.js'
import { TILLY_OFFLINE, TILLY_STUB } from '../src/tilly/service.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/** Подставная модель: помнит запросы, отвечает текстом или падает по команде. */
class ScriptedModel implements TillyModel {
  readonly provider = 'test'
  readonly model = 'scripted-1'
  readonly requests: TillyRequest[] = []
  failNext = false
  reply = 'По данным свадьбы не забронированы DJ и транспорт; задача «Заказать торт» просрочена.'
  async complete(request: TillyRequest): Promise<TillyReply> {
    this.requests.push(request)
    if (this.failNext) {
      this.failNext = false
      throw new Error('provider down (тест)')
    }
    return { text: this.reply, usage: { inputTokens: 1200, outputTokens: 80 }, finish: 'stop', model: 'scripted-1' }
  }
}

type Message = { id: string; senderId: string | null; text: string; system: boolean }
type ChatItem = { id: string; kind: string; tilly?: { live: boolean; usedToday: number; limitPerDay: number } }

const BASE = {
  env: 'test' as const,
  databaseUrl: DB ?? null,
  redisUrl: null,
  corsOrigins: [],
  jwtAccessSecret: SECRET_A,
  jwtRefreshSecret: SECRET_R,
  policyVersion: '2026-09-02',
  otpMaxPerHourTotal: 1_000_000,
  otpMaxPerIpHour: 1_000_000,
}
const TILLY = { provider: null, baseUrl: null, apiKey: null, models: [], dailyLimit: 50, timeoutMs: 5_000, maxTokens: 1_500, temperature: 0.4 }

describe.skipIf(!live)('фича 010: Тиль на живой модели', () => {
  let app: FastifyInstance
  const model = new ScriptedModel()
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259): в общей
   * дев-базе сотня тысяч номеров `+79RRRRRRNNN` от прежних
   * прогонов, и случайный RUN иногда совпадает с занятым — тогда на
   * свежем номере прилетает 409 «wedding_exists». */
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp({ ...BASE, tilly: { ...TILLY, dailyLimit: 3 } }, [], { tillyModel: model })
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

  async function readCode(a: FastifyInstance, phone: string): Promise<string> {
    const { rows } = await a.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  async function newUser(a: FastifyInstance = app) {
    const phone = nextPhone()
    await a.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await a.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(a, phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await a.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  async function newWedding(a: FastifyInstance = app) {
    const user = await newUser(a)
    const w = await a.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    const chats = await a.inject({ method: 'GET', url: '/chats', headers: auth(user.token) })
    const tilly = (chats.json() as ChatItem[]).find((c) => c.kind === 'tilly')
    expect(tilly, 'у свадьбы нет чата Тиля').toBeTruthy()
    return { ...user, weddingId: w.json().id as string, tillyChatId: tilly!.id }
  }
  type Wedding = Awaited<ReturnType<typeof newWedding>>

  const ask = (a: FastifyInstance, w: Wedding, text: string) =>
    a.inject({ method: 'POST', url: `/chats/${w.tillyChatId}/messages`, headers: auth(w.token), payload: { text } })

  const messagesOf = async (a: FastifyInstance, w: Wedding) => {
    const res = await a.inject({ method: 'GET', url: `/chats/${w.tillyChatId}/messages`, headers: auth(w.token) })
    expect(res.statusCode).toBe(200)
    // Лента — от свежих к старым; для чтения удобнее по порядку.
    return ((res.json() as { items: Message[] }).items).reverse()
  }

  const tillyOf = async (a: FastifyInstance, w: Wedding) => {
    const res = await a.inject({ method: 'GET', url: '/chats', headers: auth(w.token) })
    return (res.json() as ChatItem[]).find((c) => c.kind === 'tilly')!.tilly
  }

  it('ответ Тиля — текст модели, не заглушка; запрос несёт слоты, задачи, бюджет и гостей и не несёт телефонов; учёт answered', async () => {
    const w = await newWedding()
    const guest = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Марина Гостева', phone: '+79170001122', plusOne: true },
    })
    expect(guest.statusCode).toBe(201)
    model.requests.length = 0

    const sent = await ask(app, w, 'Что мы забыли?')
    expect(sent.statusCode, sent.body.slice(0, 300)).toBe(201)
    await app.tilly.settle()

    const list = await messagesOf(app, w)
    expect(list.map((m) => m.text)).toEqual(['Что мы забыли?', model.reply])
    expect(list[1]!.senderId, 'ответ Тиля — без отправителя').toBeNull()
    expect(list[1]!.system, 'ответ Тиля — реплика помощника, не системная запись').toBe(false)

    expect(model.requests).toHaveLength(1)
    const req = model.requests[0]!
    expect(req.messages).toEqual([{ role: 'user', content: 'Что мы забыли?' }])
    expect(req.maxTokens).toBe(1_500)
    for (const needle of ['Фотограф', 'Найти фотографа', 'Площадка и кейтеринг', 'Марина Гостева', 'Уфа', '2027-06-14']) {
      expect(req.system, `в контексте нет «${needle}»`).toContain(needle)
    }
    /* План §18: в модель не уходят телефоны и e-mail — ни гостей, ни пары. */
    expect(req.system, 'телефон гостя ушёл модели').not.toContain('79170001122')
    expect(req.system, 'телефон пары ушёл модели').not.toContain(w.phone.slice(1))
    expect(req.system).not.toMatch(/\+7\d{10}|@\w+\.\w+/)

    const { rows } = await app.db!.query<{ outcome: string; provider: string; model: string; input_tokens: number; output_tokens: number; message_id: string | null }>(
      'select outcome, provider, model, input_tokens, output_tokens, message_id from tilly_usage where wedding_id = $1',
      [w.weddingId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'answered', provider: 'test', model: 'scripted-1', input_tokens: 1200, output_tokens: 80, message_id: list[1]!.id })
  })

  it('история для модели — чередование user/assistant без заглушек и отказов; отказ модели → «временно без ИИ», учёт failed, паре 201', async () => {
    const w = await newWedding()
    model.requests.length = 0
    expect((await ask(app, w, 'Сколько игристого на 80 гостей?')).statusCode).toBe(201)
    await app.tilly.settle()

    model.failNext = true
    expect((await ask(app, w, 'А вина?')).statusCode, 'отказ модели не должен ронять ответ паре').toBe(201)
    await app.tilly.settle()
    const list = await messagesOf(app, w)
    expect(list.map((m) => m.text)).toEqual(['Сколько игристого на 80 гостей?', model.reply, 'А вина?', TILLY_OFFLINE])
    expect(model.requests[1]!.messages).toEqual([
      { role: 'user', content: 'Сколько игристого на 80 гостей?' },
      { role: 'assistant', content: model.reply },
      { role: 'user', content: 'А вина?' },
    ])

    /* Третий вопрос: отказ «временно без ИИ» в историю не попадает — модель не должна учиться на своём отсутствии. */
    expect((await ask(app, w, 'И крепкого?')).statusCode).toBe(201)
    await app.tilly.settle()
    const third = model.requests[2]!.messages
    expect(third.map((m) => m.content)).not.toContain(TILLY_OFFLINE)
    expect(third[third.length - 1]!.role).toBe('user')
    expect(third[third.length - 1]!.content).toContain('И крепкого?')
    /* «А вина?» и «И крепкого?» — два вопроса подряд без ответа модели между ними: склеены в одну реплику пары. */
    expect(third.filter((m) => m.role === 'user').length, 'реплики одной роли подряд склеиваются').toBe(2)

    const { rows } = await app.db!.query<{ outcome: string }>(
      'select outcome from tilly_usage where wedding_id = $1 order by created_at',
      [w.weddingId],
    )
    expect(rows.map((r) => r.outcome)).toEqual(['answered', 'failed', 'answered'])
  })

  it('квота 3/сутки (override): три реплики проходят, четвёртая — 429 tilly_daily_limit и не сохраняется; Chat.tilly считает', async () => {
    const w = await newWedding()
    expect(await tillyOf(app, w)).toEqual({ live: true, usedToday: 0, limitPerDay: 3 })
    for (const q of ['раз', 'два', 'три']) expect((await ask(app, w, q)).statusCode).toBe(201)
    await app.tilly.settle()
    expect(await tillyOf(app, w)).toEqual({ live: true, usedToday: 3, limitPerDay: 3 })

    const fourth = await ask(app, w, 'четыре')
    expect(fourth.statusCode, fourth.body.slice(0, 300)).toBe(429)
    expect((fourth.json() as { error: { code: string; message: string } }).error.code).toBe('tilly_daily_limit')
    expect(fourth.headers['retry-after'], 'квота — без Retry-After').toBeUndefined()
    await app.tilly.settle()
    const list = await messagesOf(app, w)
    expect(list.filter((m) => m.senderId !== null).map((m) => m.text), 'четвёртая реплика не должна сохраниться').toEqual(['раз', 'два', 'три'])
    expect(list.filter((m) => m.senderId === null)).toHaveLength(3)
  })

  it('без модели — прежняя честная заглушка тем же путём, учёт stub, Chat.tilly.live=false; квота действует и без модели', async () => {
    const offline = await buildApp({ ...BASE, tilly: { ...TILLY, dailyLimit: 1 } }, [], { tillyModel: null })
    await offline.ready()
    try {
      const w = await newWedding(offline)
      expect(await tillyOf(offline, w)).toEqual({ live: false, usedToday: 0, limitPerDay: 1 })
      expect((await ask(offline, w, 'Ты тут?')).statusCode).toBe(201)
      await offline.tilly.settle()
      expect((await messagesOf(offline, w)).map((m) => m.text)).toEqual(['Ты тут?', TILLY_STUB])
      const { rows } = await offline.db!.query<{ outcome: string; provider: string }>(
        'select outcome, provider from tilly_usage where wedding_id = $1',
        [w.weddingId],
      )
      expect(rows).toEqual([{ outcome: 'stub', provider: 'none' }])
      expect((await ask(offline, w, 'Ещё?')).statusCode, 'квота — и без модели, иначе счётчик на экране врёт').toBe(429)
    } finally {
      await offline.close()
    }
  })

  it('AdminMetrics.llm — вызовы, ответы и токены за 30 дней по учёту', async () => {
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])
    const before = (await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(staff.token) })).json() as {
      llm: { since: string; calls: number; answered: number; inputTokens: number; outputTokens: number }
    }
    expect(before.llm.calls).toBeGreaterThanOrEqual(before.llm.answered)

    const w = await newWedding()
    expect((await ask(app, w, 'Что по бюджету?')).statusCode).toBe(201)
    await app.tilly.settle()

    const after = (await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(staff.token) })).json() as typeof before
    expect(after.llm.calls - before.llm.calls).toBeGreaterThanOrEqual(1)
    expect(after.llm.answered - before.llm.answered).toBeGreaterThanOrEqual(1)
    expect(after.llm.inputTokens - before.llm.inputTokens).toBeGreaterThanOrEqual(1200)
    expect(after.llm.outputTokens - before.llm.outputTokens).toBeGreaterThanOrEqual(80)
    expect(Date.parse(after.llm.since)).toBeLessThan(Date.now() - 29 * 86_400_000)
  })
})
