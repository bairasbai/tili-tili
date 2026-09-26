/*
 * Фича 018 «Ответы квиза влияют на свадьбу» (tasks/фичи/018-квиз-влияет) — бэкенд, живая база.
 *
 * До фичи сервер сохранял из квиза только дату, город, гостей, бюджет и стиль: формат, «кто планирует» и «что уже
 * забронировано» не меняли ничего — у всех одна мозаика из 12 плиток, один чек-лист и один тайминг с «Выездной
 * церемонией», даже у «Классики: ЗАГС + банкет».
 *
 * Т1  формат → состав мозаики и тайминг (четыре формата и «не указан»).
 * Т2  «кто планирует» → слот организатора или координатора.
 * Т3  «уже забронировано» → отметка на слотах, три задачи шаблона сразу выполнены.
 * Т4  неизвестный код — 422, свадьба не заводится.
 * Т5  `DELETE …/slots/{slotId}/prebooked`: 204, повтор 204, помощник и координатор 403, чужой слот 404.
 * Т6  бронь из каталога и свой подрядчик снимают отметку; отметка на слоте со сделкой запрещена базой.
 * Т7  перенос даты двигает второй день; первая дата ставит часы по формату.
 * Т8  название «Имя ♥ Партнёр» после `PATCH /users/me` — на это опирается квиз.
 * Т9  подсказки Тиля (§3.14): отмеченный слот не открыт — ни дефицита, ни блокирующего слота; блоки форматов
 *     названы в карте зависимостей; «Выездная церемония» держится и на слотах своего формата.
 * Т10 контекст Тиля называет отметку «уже забронировано вне приложения», а не «пусто».
 *
 * Все проверки — через HTTP и SQL на живой базе: моки базы здесь запрещены (поручение владельца).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { SLOT_TEMPLATE, TIMELINE_TEMPLATE, WEDDING_FORMATS, timelineTemplate } from '../src/wedding/templates.js'
import { BLOCK_DEPENDENCIES, DEFICIT_THRESHOLD } from '../src/wedding/tips.js'
import { weddingContext } from '../src/tilly/context.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const CITY = { name: 'Уфа', region: 'Башкортостан' }
const BASE_CATEGORIES = SLOT_TEMPLATE.map((s) => s.categoryId)

interface SlotOut {
  id: string
  categoryId: string
  label: string
  prebooked?: unknown
  tileState: string
  deal: { id: string; state: string } | null
}
interface EventRow {
  name: string
  icon: string | null
  sort: number
  starts: string | null
  ends: string | null
}

/* Т9, чистое правило. Правило «блокирующий слот» находит блок по имени: блок, которого нет в карте, для него
   не существует. Молчание по блоку формата — тоже решение, поэтому оно записано явно, пустым списком. */
describe('Т9: карта зависимостей знает блоки всех форматов', () => {
  const names = [...new Set([null, ...WEDDING_FORMATS].flatMap((f) => timelineTemplate(f).map((b) => b.name)))]

  it('каждый блок тайминга любого формата назван в BLOCK_DEPENDENCIES', () => {
    for (const name of names) expect(BLOCK_DEPENDENCIES[name], `блок «${name}» не назван`).toBeDefined()
  })

  it('решения по блокам форматов: ЗАГС и второй день — ни на чём; «Ужин» — на площадке', () => {
    expect(BLOCK_DEPENDENCIES['Регистрация в ЗАГСе']).toEqual([])
    expect(BLOCK_DEPENDENCIES['Ужин']).toEqual(['venue'])
    expect(BLOCK_DEPENDENCIES['День 2: бранч']).toEqual([])
    expect(BLOCK_DEPENDENCIES['День 2: продолжение праздника']).toEqual([])
    expect(BLOCK_DEPENDENCIES['Выездная церемония']).toEqual(expect.arrayContaining(['ceremony', 'registrar']))
  })
})

describe.skipIf(!live)('фича 018: ответы квиза влияют на свадьбу', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона — до свободного (R-259), как в соседних наборах. */
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

  /** Вошёл по SMS, согласие дано. Имени в профиле нет — как у каждого нового номера. */
  async function newUser(): Promise<{ token: string }> {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    expect(v.statusCode, v.body.slice(0, 200)).toBe(200)
    const token = (v.json() as { accessToken: string }).accessToken
    const c = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02', adult: true },
    })
    expect(c.statusCode, c.body.slice(0, 200)).toBe(201)
    return { token }
  }

  const postWedding = (token: string, extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', city: CITY, ...extra },
    })

  /** Новая пара и её свадьба с ответами квиза `extra`. */
  async function wedding(extra: Record<string, unknown> = {}) {
    const user = await newUser()
    const res = await postWedding(user.token, { date: '2027-06-14', ...extra })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201)
    const body = res.json() as { id: string; title: string; format?: unknown; planner?: unknown }
    return { ...user, weddingId: body.id, body }
  }

  const slotsOf = async (token: string, weddingId: string) => {
    const res = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as SlotOut[]
  }

  /** Блоки тайминга в поясе площадки — так их видит пара. */
  const eventsOf = async (weddingId: string) =>
    (
      await app.db!.query<EventRow>(
        `select t.name, t.icon, t.sort,
                to_char(t.starts_at at time zone w.tz, 'YYYY-MM-DD HH24:MI') as starts,
                to_char(t.ends_at at time zone w.tz, 'YYYY-MM-DD HH24:MI') as ends
           from timeline_events t join weddings w on w.id = t.wedding_id
          where t.wedding_id = $1 order by t.sort`,
        [weddingId],
      )
    ).rows

  const tasksOf = async (token: string, weddingId: string) => {
    const res = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/tasks`, headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as { title: string; done: boolean }[]
  }

  async function addMember(coupleToken: string, weddingId: string, role: 'helper' | 'coordinator') {
    const member = await newUser()
    const inv = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(coupleToken),
      payload: { role },
    })
    expect(inv.statusCode, inv.body.slice(0, 200)).toBe(201)
    const acc = await app.inject({
      method: 'POST',
      url: `/invites/${(inv.json() as { code: string }).code}/accept`,
      headers: auth(member.token),
    })
    expect(acc.statusCode, acc.body.slice(0, 200)).toBe(200)
    return member
  }

  /* Анкета редкой категории: бронь не сверяет категорию анкеты со слотом (ERR-0037), а счёт свободных
     фотографов и площадок в Уфе у соседних наборов (подсказки §3.14) эта анкета не трогает. */
  async function vendor() {
    const owner = await newUser()
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: {
        name: `Выкуп ${RUN}-${++counter}`,
        categoryId: 'vykup',
        city: CITY,
        priceFrom: { amount: 4_000_000, currency: 'RUB' },
        mediaRights: true,
      },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    const pub = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    expect(pub.statusCode, pub.body.slice(0, 200)).toBe(200)
    return (put.json() as { id: string }).id
  }

  const unmark = (token: string, weddingId: string, slotId: string) =>
    app.inject({ method: 'DELETE', url: `/weddings/${weddingId}/slots/${slotId}/prebooked`, headers: auth(token) })

  const byCategory = (slots: SlotOut[], categoryId: string) => slots.find((s) => s.categoryId === categoryId)!

  type Tip = { kind: string; title: string; categoryId?: string | null }
  const tipsOf = async (token: string, weddingId: string) => {
    const res = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/tips`, headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return (res.json() as { items: Tip[] }).items
  }

  /* Дата по часам базы — правило дефицита считает месяцы от `current_date` базы. */
  const dbDate = async (shiftDays: number) =>
    (await app.db!.query<{ d: string }>(`select to_char(current_date + $1::int, 'YYYY-MM-DD') as d`, [shiftDays])).rows[0]!.d

  /* ── Т1: формат ─────────────────────────────────────────────────────── */
  describe('Т1: формат задаёт мозаику и тайминг', () => {
    it('«Классика» — 12 базовых плиток, ЗАГС в 14:00 вместо выездной церемонии', async () => {
      const w = await wedding({ format: 'classic' })
      expect(w.body.format).toBe('classic')
      const slots = await slotsOf(w.token, w.weddingId)
      expect(slots.map((s) => s.categoryId)).toEqual(BASE_CATEGORIES)

      const events = await eventsOf(w.weddingId)
      expect(events.map((e) => e.name)).toEqual([
        'Сборы невесты',
        'Сборы жениха',
        'Доставка букета и деталей',
        'Регистрация в ЗАГСе',
        'Банкет',
        'Салют и финал',
      ])
      expect(events[3]).toMatchObject({ icon: '🏛️', starts: '2027-06-14 14:00', ends: '2027-06-14 15:00' })
    })

    it('«Выездная церемония» — плюс площадка церемонии и церемониймейстер, тайминг прежний', async () => {
      const w = await wedding({ format: 'outdoor' })
      expect(w.body.format).toBe('outdoor')
      const slots = await slotsOf(w.token, w.weddingId)
      expect(slots.map((s) => s.categoryId)).toEqual([...BASE_CATEGORIES, 'ceremony', 'registrar'])
      expect(slots.slice(12).map((s) => s.label)).toEqual(['Площадка выездной церемонии', 'Церемониймейстер'])
      expect(slots.every((s) => s.deal === null && s.tileState === 'empty')).toBe(true)

      const events = await eventsOf(w.weddingId)
      expect(events.map((e) => [e.name, e.icon])).toEqual(TIMELINE_TEMPLATE.map((e) => [e.name, e.icon]))
      expect(events[3]).toMatchObject({ name: 'Выездная церемония', starts: '2027-06-14 16:00', ends: '2027-06-14 17:00' })
    })

    it('«Камерная» — ужин 18:00–22:00 вместо банкета, без салюта', async () => {
      const w = await wedding({ format: 'intimate' })
      const slots = await slotsOf(w.token, w.weddingId)
      expect(slots.map((s) => s.categoryId)).toEqual(BASE_CATEGORIES)

      const events = await eventsOf(w.weddingId)
      expect(events.map((e) => e.name)).toEqual([
        'Сборы невесты',
        'Сборы жениха',
        'Доставка букета и деталей',
        'Выездная церемония',
        'Ужин',
      ])
      expect(events[4]).toMatchObject({ starts: '2027-06-14 18:00', ends: '2027-06-14 22:00' })
    })

    it('«Банкет+ на 2 дня» — плюс отель; второй день — на следующее число', async () => {
      const w = await wedding({ format: 'two_day' })
      const slots = await slotsOf(w.token, w.weddingId)
      expect(slots.map((s) => s.categoryId)).toEqual([...BASE_CATEGORIES, 'hotel'])
      expect(slots[12]!.label).toBe('Отель для гостей')

      const events = await eventsOf(w.weddingId)
      expect(events.slice(0, 6).map((e) => e.name)).toEqual(TIMELINE_TEMPLATE.map((e) => e.name))
      expect(events.slice(6)).toEqual([
        { name: 'День 2: бранч', icon: '🥐', sort: 6, starts: '2027-06-15 12:00', ends: '2027-06-15 14:00' },
        { name: 'День 2: продолжение праздника', icon: '🎉', sort: 7, starts: '2027-06-15 14:00', ends: '2027-06-15 20:00' },
      ])
    })

    it('формат не указан (старый клиент) — как раньше: 12 плиток, выездной тайминг, format и planner — null', async () => {
      const w = await wedding()
      expect(w.body.format).toBeNull()
      expect(w.body.planner).toBeNull()
      const slots = await slotsOf(w.token, w.weddingId)
      expect(slots.map((s) => s.categoryId)).toEqual(BASE_CATEGORIES)
      expect(slots.map((s) => s.prebooked)).toEqual(BASE_CATEGORIES.map(() => false))
      const events = await eventsOf(w.weddingId)
      expect(events.map((e) => e.name)).toEqual(TIMELINE_TEMPLATE.map((e) => e.name))
    })

    it('формат и «кто планирует» хранятся у свадьбы и приходят в её ответах всей команде', async () => {
      const w = await wedding({ format: 'two_day', planner: 'agency' })
      const helper = await addMember(w.token, w.weddingId, 'helper')
      const card = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}`, headers: auth(helper.token) })
      expect(card.json()).toMatchObject({ format: 'two_day', planner: 'agency' })
      const list = await app.inject({ method: 'GET', url: '/weddings', headers: auth(w.token) })
      expect(list.json()).toEqual([expect.objectContaining({ id: w.weddingId, format: 'two_day', planner: 'agency' })])
      const { rows } = await app.db!.query('select format, planner from weddings where id = $1', [w.weddingId])
      expect(rows[0]).toEqual({ format: 'two_day', planner: 'agency' })
      /* Ответы человека — его данные: выгрузка (152-ФЗ) перечисляет колонки свадьбы поимённо. */
      const exported = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(w.token) })
      expect(exported.statusCode, exported.body.slice(0, 200)).toBe(200)
      expect((exported.json() as { weddings: unknown[] }).weddings).toEqual([
        expect.objectContaining({ id: w.weddingId, format: 'two_day', planner: 'agency' }),
      ])
    })
  })

  /* ── Т2: кто планирует ──────────────────────────────────────────────── */
  describe('Т2: «кто планирует» добавляет слот', () => {
    it('агентство — «Организатор», координатор — «Координатор дня», сами — ничего', async () => {
      const agency = await wedding({ planner: 'agency' })
      expect(agency.body.planner).toBe('agency')
      const a = await slotsOf(agency.token, agency.weddingId)
      expect(a.map((s) => s.categoryId)).toEqual([...BASE_CATEGORIES, 'agency'])
      expect(a[12]!.label).toBe('Организатор')

      const coordinator = await wedding({ planner: 'coordinator' })
      const c = await slotsOf(coordinator.token, coordinator.weddingId)
      expect(c.map((s) => s.categoryId)).toEqual([...BASE_CATEGORIES, 'coordinator'])
      expect(c[12]!.label).toBe('Координатор дня')

      const self = await wedding({ planner: 'self' })
      expect(self.body.planner).toBe('self')
      expect((await slotsOf(self.token, self.weddingId)).map((s) => s.categoryId)).toEqual(BASE_CATEGORIES)
    })

    it('формат и «кто планирует» вместе: сначала плитки формата, потом организатора', async () => {
      const w = await wedding({ format: 'outdoor', planner: 'coordinator' })
      const slots = await slotsOf(w.token, w.weddingId)
      expect(slots.map((s) => s.categoryId)).toEqual([...BASE_CATEGORIES, 'ceremony', 'registrar', 'coordinator'])
    })
  })

  /* ── Т3: уже забронировано ──────────────────────────────────────────── */
  describe('Т3: «уже забронировано» — отметка на слотах и выполненные задачи', () => {
    it('площадка и фотограф отмечены; «Забронировать площадку» и «Найти фотографа» выполнены, «ведущий» — нет', async () => {
      const w = await wedding({ prebooked: ['venue', 'photo'] })
      const slots = await slotsOf(w.token, w.weddingId)
      const marked = slots.filter((s) => s.prebooked === true).map((s) => s.categoryId)
      expect(marked).toEqual(['venue', 'photo'])
      expect(slots.filter((s) => s.prebooked === false)).toHaveLength(10)
      /* Сделки у отметки нет: плитка по контракту — производная от сделки. */
      expect(byCategory(slots, 'venue')).toMatchObject({ deal: null, tileState: 'empty' })

      const tasks = await tasksOf(w.token, w.weddingId)
      const done = (title: string) => tasks.find((t) => t.title === title)!.done
      expect(done('Забронировать площадку')).toBe(true)
      expect(done('Найти фотографа')).toBe(true)
      expect(done('Забронировать ведущего')).toBe(false)
      expect(tasks.filter((t) => t.done)).toHaveLength(2)
    })

    it('ведущий закрывает свою задачу; видеограф задачи в шаблоне не имеет — выполненных нет', async () => {
      const host = await wedding({ prebooked: ['host'] })
      const hostTasks = await tasksOf(host.token, host.weddingId)
      expect(hostTasks.filter((t) => t.done).map((t) => t.title)).toEqual(['Забронировать ведущего'])

      const video = await wedding({ prebooked: ['video'] })
      expect(byCategory(await slotsOf(video.token, video.weddingId), 'video').prebooked).toBe(true)
      expect((await tasksOf(video.token, video.weddingId)).filter((t) => t.done)).toEqual([])
    })

    it('«Пока ничего» — пустой список: отметок и выполненных задач нет', async () => {
      const w = await wedding({ prebooked: [] })
      expect((await slotsOf(w.token, w.weddingId)).every((s) => s.prebooked === false)).toBe(true)
      expect((await tasksOf(w.token, w.weddingId)).every((t) => !t.done)).toBe(true)
    })
  })

  /* ── Т4: неизвестные коды ───────────────────────────────────────────── */
  describe('Т4: неизвестный код — 422 с именем поля, свадьба не заводится', () => {
    /* Отказ обязан называть поле. До фичи эти тела тоже получали 422, но за «лишнее поле» (`_`):
       сервер не знал ни одного из трёх ответов квиза — такой отказ проверку кодов не доказывает. */
    it.each([
      ['format', { format: 'banquet' }, 'format'],
      ['planner', { planner: 'friends' }, 'planner'],
      ['prebooked: чужая категория', { prebooked: ['dress'] }, 'prebooked'],
      ['prebooked: повтор', { prebooked: ['venue', 'venue'] }, 'prebooked'],
      ['prebooked: не массив', { prebooked: 'venue' }, 'prebooked'],
      ['prebooked: больше четырёх', { prebooked: ['venue', 'photo', 'video', 'host', 'venue'] }, 'prebooked'],
      ['format: русская подпись вместо кода', { format: 'Выездная церемония' }, 'format'],
    ])('%s', async (_label, extra, field) => {
      const user = await newUser()
      const res = await postWedding(user.token, extra)
      expect(res.statusCode, res.body.slice(0, 300)).toBe(422)
      const { error } = res.json() as { error: { code: string; fields: Record<string, string> } }
      expect(error.code).toBe('validation_failed')
      expect(Object.keys(error.fields), res.body.slice(0, 300)).toEqual([expect.stringMatching(new RegExp(`^${field}(/\\d+)?$`))])
      const mine = await app.inject({ method: 'GET', url: '/weddings', headers: auth(user.token) })
      expect(mine.json()).toEqual([])
    })
  })

  /* ── Т5: «Нет, ещё ищем» ────────────────────────────────────────────── */
  describe('Т5: DELETE …/slots/{slotId}/prebooked', () => {
    it('пара снимает отметку: 204, повтор — 204; остальные слоты и задачи не трогаются', async () => {
      const w = await wedding({ prebooked: ['venue', 'photo'] })
      const venue = byCategory(await slotsOf(w.token, w.weddingId), 'venue')

      const first = await unmark(w.token, w.weddingId, venue.id)
      expect(first.statusCode, first.body.slice(0, 200)).toBe(204)
      expect(first.body).toBe('')
      const after = await slotsOf(w.token, w.weddingId)
      expect(byCategory(after, 'venue')).toMatchObject({ prebooked: false, deal: null, tileState: 'empty' })
      expect(byCategory(after, 'photo').prebooked).toBe(true)

      const again = await unmark(w.token, w.weddingId, venue.id)
      expect(again.statusCode, again.body.slice(0, 200)).toBe(204)
      /* Слот без отметки — тоже 204: действие идемпотентно, а не «нечего снимать». */
      const plain = byCategory(after, 'dj')
      expect((await unmark(w.token, w.weddingId, plain.id)).statusCode).toBe(204)
    })

    it('помощник и координатор — 403, отметка остаётся', async () => {
      const w = await wedding({ prebooked: ['venue'] })
      const venue = byCategory(await slotsOf(w.token, w.weddingId), 'venue')
      for (const role of ['helper', 'coordinator'] as const) {
        const member = await addMember(w.token, w.weddingId, role)
        /* Отметку команда видит — мозаика открыта всем своим. */
        expect(byCategory(await slotsOf(member.token, w.weddingId), 'venue').prebooked).toBe(true)
        const res = await unmark(member.token, w.weddingId, venue.id)
        expect(res.statusCode, `${role}: ${res.body.slice(0, 200)}`).toBe(403)
        expect((res.json() as { error: { code: string } }).error.code).toBe('forbidden')
      }
      expect(byCategory(await slotsOf(w.token, w.weddingId), 'venue').prebooked).toBe(true)
    })

    it('слот другой свадьбы и несуществующий — 404; чужая свадьба — 404', async () => {
      const mine = await wedding({ prebooked: ['venue'] })
      const other = await wedding({ prebooked: ['venue'] })
      const foreign = byCategory(await slotsOf(other.token, other.weddingId), 'venue')

      const res = await unmark(mine.token, mine.weddingId, foreign.id)
      expect(res.statusCode, res.body.slice(0, 200)).toBe(404)
      expect(byCategory(await slotsOf(other.token, other.weddingId), 'venue').prebooked).toBe(true)

      expect((await unmark(mine.token, mine.weddingId, randomUUID())).statusCode).toBe(404)
      expect((await unmark(mine.token, mine.weddingId, 'не-идентификатор')).statusCode).toBe(404)
      expect((await unmark(mine.token, other.weddingId, foreign.id)).statusCode).toBe(404)
    })
  })

  /* ── Т6: бронь снимает отметку ──────────────────────────────────────── */
  describe('Т6: любая бронь в отмеченный слот снимает отметку', () => {
    it('бронь из каталога — отметки нет ни в ответе, ни в базе; отмена брони её не возвращает', async () => {
      const w = await wedding({ prebooked: ['venue'] })
      const venue = byCategory(await slotsOf(w.token, w.weddingId), 'venue')
      const vendorId = await vendor()

      const booked = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${venue.id}/book`,
        headers: { ...auth(w.token), 'idempotency-key': randomUUID() },
        payload: { vendorId, price: { amount: 30_000_000, currency: 'RUB' } },
      })
      expect(booked.statusCode, booked.body.slice(0, 300)).toBe(200)
      expect(booked.json()).toMatchObject({ prebooked: false, tileState: 'booked' })
      const { rows } = await app.db!.query('select prebooked_at from slots where id = $1', [venue.id])
      expect(rows[0]).toEqual({ prebooked_at: null })

      const cancelled = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${venue.id}/cancel`,
        headers: { ...auth(w.token), 'idempotency-key': randomUUID() },
      })
      expect(cancelled.statusCode, cancelled.body.slice(0, 300)).toBe(200)
      expect(cancelled.json()).toMatchObject({ prebooked: false, tileState: 'empty', deal: null })
    })

    it('свой подрядчик — отметки нет', async () => {
      const w = await wedding({ prebooked: ['photo'] })
      const photo = byCategory(await slotsOf(w.token, w.weddingId), 'photo')
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${photo.id}/external`,
        headers: auth(w.token),
        payload: { vendorName: 'Фотограф Ирек', price: { amount: 5_000_000, currency: 'RUB' } },
      })
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
      expect(res.json()).toMatchObject({ prebooked: false, tileState: 'booked' })
      expect(byCategory(await slotsOf(w.token, w.weddingId), 'photo').prebooked).toBe(false)

      /* Третья выборка слота — кабинет своего подрядчика по ссылке: признак приходит и там. */
      const link = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${photo.id}/external/invite`,
        headers: auth(w.token),
      })
      expect(link.statusCode, link.body.slice(0, 200)).toBe(201)
      const token = (link.json() as { token: string }).token
      const cabinet = await app.inject({ method: 'GET', url: `/guest-vendor/${token}` })
      expect(cabinet.statusCode, cabinet.body.slice(0, 200)).toBe(200)
      expect((cabinet.json() as { slot: SlotOut }).slot).toMatchObject({ id: photo.id, prebooked: false })
    })

    it('база не даёт отметить слот со сделкой и записать чужой код формата', async () => {
      const w = await wedding({ prebooked: ['host'] })
      const host = byCategory(await slotsOf(w.token, w.weddingId), 'host')
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${host.id}/external`,
        headers: auth(w.token),
        payload: { vendorName: 'Ведущий Азат', price: { amount: 4_000_000, currency: 'RUB' } },
      })
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
      await expect(app.db!.query('update slots set prebooked_at = now() where id = $1', [host.id])).rejects.toMatchObject({
        code: '23514',
      })
      await expect(app.db!.query(`update weddings set format = 'banquet' where id = $1`, [w.weddingId])).rejects.toMatchObject({
        code: '23514',
      })
      await expect(app.db!.query(`update weddings set planner = 'friends' where id = $1`, [w.weddingId])).rejects.toMatchObject({
        code: '23514',
      })
    })

    it('отметка приходит во всех ответах со слотом: новый слот категории вне шаблона — false', async () => {
      const w = await wedding({ prebooked: ['venue'] })
      const added = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots`,
        headers: auth(w.token),
        payload: { categoryId: 'photobooth' },
      })
      expect(added.statusCode, added.body.slice(0, 200)).toBe(201)
      expect(added.json()).toMatchObject({ categoryId: 'photobooth', prebooked: false })
    })
  })

  /* ── Т7: перенос даты ───────────────────────────────────────────────── */
  describe('Т7: перенос даты и второй день', () => {
    const patchDate = (token: string, weddingId: string, date: string) =>
      app.inject({ method: 'PATCH', url: `/weddings/${weddingId}`, headers: auth(token), payload: { date } })

    it('перенос двухдневной свадьбы двигает второй день вместе с первым', async () => {
      const w = await wedding({ format: 'two_day', date: '2027-06-14' })
      const res = await patchDate(w.token, w.weddingId, '2027-07-10')
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
      const events = await eventsOf(w.weddingId)
      expect(events[0]).toMatchObject({ name: 'Сборы невесты', starts: '2027-07-10 08:00' })
      expect(events.slice(6)).toEqual([
        { name: 'День 2: бранч', icon: '🥐', sort: 6, starts: '2027-07-11 12:00', ends: '2027-07-11 14:00' },
        { name: 'День 2: продолжение праздника', icon: '🎉', sort: 7, starts: '2027-07-11 14:00', ends: '2027-07-11 20:00' },
      ])
    })

    it('двухдневная без даты: второй день без времени; первая дата ставит его на следующее число', async () => {
      const user = await newUser()
      const created = await postWedding(user.token, { format: 'two_day' })
      expect(created.statusCode, created.body.slice(0, 300)).toBe(201)
      const weddingId = (created.json() as { id: string }).id
      const before = await eventsOf(weddingId)
      expect(before).toHaveLength(8)
      expect(before.every((e) => e.starts === null && e.ends === null)).toBe(true)

      const res = await patchDate(user.token, weddingId, '2027-06-14')
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
      const events = await eventsOf(weddingId)
      expect(events.map((e) => [e.name, e.starts, e.ends])).toEqual([
        ['Сборы невесты', '2027-06-14 08:00', '2027-06-14 13:00'],
        ['Сборы жениха', '2027-06-14 09:00', '2027-06-14 12:00'],
        ['Доставка букета и деталей', '2027-06-14 12:00', '2027-06-14 13:00'],
        ['Выездная церемония', '2027-06-14 16:00', '2027-06-14 17:00'],
        ['Банкет', '2027-06-14 18:00', '2027-06-14 23:00'],
        ['Салют и финал', '2027-06-14 22:30', '2027-06-14 23:00'],
        ['День 2: бранч', '2027-06-15 12:00', '2027-06-15 14:00'],
        ['День 2: продолжение праздника', '2027-06-15 14:00', '2027-06-15 20:00'],
      ])
    })

    it('«Классика» без даты: первая дата ставит ЗАГС на 14:00, а не часы выездной церемонии', async () => {
      const user = await newUser()
      const created = await postWedding(user.token, { format: 'classic' })
      const weddingId = (created.json() as { id: string }).id
      expect((await patchDate(user.token, weddingId, '2027-06-14')).statusCode).toBe(200)
      const zags = (await eventsOf(weddingId)).find((e) => e.name === 'Регистрация в ЗАГСе')
      expect(zags).toMatchObject({ starts: '2027-06-14 14:00', ends: '2027-06-14 15:00' })
    })

    it('«Камерная» без даты: первая дата ставит ужин на 18:00–22:00', async () => {
      const user = await newUser()
      const created = await postWedding(user.token, { format: 'intimate' })
      const weddingId = (created.json() as { id: string }).id
      expect((await patchDate(user.token, weddingId, '2027-06-14')).statusCode).toBe(200)
      const dinner = (await eventsOf(weddingId)).find((e) => e.name === 'Ужин')
      expect(dinner).toMatchObject({ starts: '2027-06-14 18:00', ends: '2027-06-14 22:00' })
    })
  })

  /* ── Т8: название свадьбы ───────────────────────────────────────────── */
  /* Сторож серверной половины, на которую опирается шаг имён квиза: название из профиля сервер собирал и
     до фичи — этот тест зелёный и до правки. Красный до правки — фронтовый (PATCH уходит раньше POST). */
  describe('Т8: «Имя ♥ Партнёр»', () => {
    it('после PATCH /users/me {name} свадьба называется «Алина ♥ Тимур»; без имени — только партнёр', async () => {
      const named = await newUser()
      const patch = await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(named.token), payload: { name: 'Алина' } })
      expect(patch.statusCode, patch.body.slice(0, 200)).toBe(200)
      const res = await postWedding(named.token, {})
      expect(res.statusCode, res.body.slice(0, 300)).toBe(201)
      expect((res.json() as { title: string }).title).toBe('Алина ♥ Тимур')

      /* Ровно эту яму закрывает шаг имён квиза: после входа по SMS имени в профиле нет. */
      const anonymous = await newUser()
      const bare = await postWedding(anonymous.token, {})
      expect((bare.json() as { title: string }).title).toBe('Тимур')
    })
  })

  /* ── Т9: подсказки Тиля ─────────────────────────────────────────────── */
  describe('Т9: подсказки Тиля (§3.14) знают отметку и блоки форматов', () => {
    /* Малый город справочника: свободных площадок там нет или единицы — дефицит виден (как в audit47). */
    const SMALL = { name: 'Большеустьикинское', region: 'Башкортостан' }
    const freeIn = async (categoryId: string, date: string) =>
      Number(
        (
          await app.db!.query<{ n: string }>(
            `select count(*)::text as n from vendors v
               join users u on u.id = v.user_id and u.deleted_at is null and v.blocked_at is null
               join cities c on c.id = v.city_id
              where v.category_id = $1 and v.published_at is not null and c.name = $2
                and not exists (select 1 from vendor_busy_dates b where b.vendor_id = v.id and b.date = $3::date)`,
            [categoryId, SMALL.name, date],
          )
        ).rows[0]!.n,
      )
    const about = (tips: Tip[], categoryId: string) =>
      tips.filter((t) => t.categoryId === categoryId && (t.kind === 'deficit' || t.kind === 'blocking_slot'))
    const blocking = (tips: Tip[], categoryId: string) =>
      tips.find((t) => t.kind === 'blocking_slot' && t.categoryId === categoryId)?.title

    it('отмеченный слот не открыт: ни дефицита, ни блокирующего слота; «Нет, ещё ищем» возвращает подсказки', async () => {
      const date = await dbDate(90)
      const w = await wedding({ date, city: SMALL, format: 'outdoor', prebooked: ['venue', 'host'] })
      const before = await tipsOf(w.token, w.weddingId)
      expect(about(before, 'venue'), 'площадка отмечена — искать её Тиль не зовёт').toEqual([])
      expect(about(before, 'host'), 'ведущий отмечен — искать его Тиль не зовёт').toEqual([])
      /* Правило не выключено целиком: пустой неотмеченный слот под тем же блоком назван. */
      expect(blocking(before, 'decor')).toBe('«Выездная церемония» держится на слоте «Декоратор» — он пуст')

      const venue = byCategory(await slotsOf(w.token, w.weddingId), 'venue')
      expect((await unmark(w.token, w.weddingId, venue.id)).statusCode).toBe(204)
      const after = await tipsOf(w.token, w.weddingId)
      expect(blocking(after, 'venue')).toBe('«Выездная церемония» держится на слоте «Площадка» — он пуст')
      const deficit = after.find((t) => t.kind === 'deficit' && t.categoryId === 'venue')
      if ((await freeIn('venue', date)) <= DEFICIT_THRESHOLD) expect(deficit, 'дефицит площадок после снятия отметки').toBeTruthy()
      else expect(deficit).toBeUndefined()
      expect(about(after, 'host'), 'ведущий по-прежнему отмечен').toEqual([])
    })

    it('«Выездная церемония» держится и на слотах своего формата — площадке церемонии и церемониймейстере', async () => {
      const w = await wedding({ format: 'outdoor' })
      const tips = await tipsOf(w.token, w.weddingId)
      expect(blocking(tips, 'ceremony')).toBe('«Выездная церемония» держится на слоте «Площадка выездной церемонии» — он пуст')
      expect(blocking(tips, 'registrar')).toBe('«Выездная церемония» держится на слоте «Церемониймейстер» — он пуст')
    })

    it('камерная свадьба без выездной церемонии: «Ужин» держится на площадке, DJ ему не нужен', async () => {
      const w = await wedding({ format: 'intimate' })
      /* Пара убрала церемонию из тайминга — экран шлёт список целиком, как редактор тайминга. */
      const rest = timelineTemplate('intimate').filter((e) => e.name !== 'Выездная церемония').map((e) => ({ name: e.name }))
      const put = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token), payload: rest })
      expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
      const tips = await tipsOf(w.token, w.weddingId)
      expect(blocking(tips, 'venue')).toBe('«Ужин» держится на слоте «Площадка» — он пуст')
      expect(blocking(tips, 'dj')).toBeUndefined()
    })
  })

  /* ── Т10: контекст Тиля ─────────────────────────────────────────────── */
  describe('Т10: контекст Тиля называет отметку', () => {
    it('отмеченный слот — «уже забронировано вне приложения», пустой — «пусто»; после «Нет, ещё ищем» — «пусто»', async () => {
      const w = await wedding({ prebooked: ['venue'] })
      const ctx = (await weddingContext(app.db!, w.weddingId)).text
      expect(ctx).toContain('- Площадка: уже забронировано вне приложения')
      expect(ctx).not.toContain('- Площадка: пусто')
      expect(ctx).toContain('- Фотограф: пусто — подрядчик не выбран')

      const venue = byCategory(await slotsOf(w.token, w.weddingId), 'venue')
      expect((await unmark(w.token, w.weddingId, venue.id)).statusCode).toBe(204)
      expect((await weddingContext(app.db!, w.weddingId)).text).toContain('- Площадка: пусто — подрядчик не выбран')
    })
  })
})
