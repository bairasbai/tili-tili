import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Фича 009 «Гостевой день X», задание BE-009 (контракт v0.32.0).
 *
 * Что проверяется: `PUT …/timeline` принимает `forGuests`, тайминг отдаёт
 * его везде (список, автоплан); `GET /join/{t}/day` собирает день гостя одним
 * ответом — только блоки «для гостей», свой стол, свой автобус с перевозчиком,
 * координатор с телефоном (В2), окно чата дня; чат дня гостя — вне окна 423
 * `chat_closed_for_guests` с `details.opensAt`, в окне реплика гостя 201 с
 * `guestName`, у пары в `GET /chats/{id}/messages` — с именем и `system:false`,
 * команде — уведомление; CHECK `messages_one_author` держит база; мёртвая
 * ссылка — 410.
 *
 * Каждый тест был красным до правки: `GET /join/{t}/day` отвечал 501
 * `not_implemented` (доказательство — подмена файлов из `HEAD`, цитаты в
 * отчёте). База общая с соседними наборами (R-177/R-226/R-227): каждый тест
 * заводит свою свадьбу и утверждает только свои строки.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface TimelineEvent {
  id: string
  name: string
  startsAt: string | null
  forGuests: boolean
}

interface Message {
  id: string
  chatId: string
  senderId: string | null
  text: string
  sentAt: string
  system: boolean
  guestName: string | null
}

interface GuestDay {
  date: string | null
  tz: string
  venue: string | null
  dressCode: string | null
  dressNote: string | null
  timeline: TimelineEvent[]
  table: { name: string } | null
  bus: { id: string; name: string; time: string | null; carrier: string | null } | null
  coordinator: { name: string | null; phone: string | null } | null
  chat: { open: boolean; opensAt: string | null; closesAt: string | null }
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

describe.skipIf(!live)('фича 009, BE-009: день X глазами гостя', () => {
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
  const key = () => ({ 'idempotency-key': randomUUID() })

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

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string, tz: (w.json().tz as string | null) ?? 'Europe/Moscow' }
  }

  type Wedding = Awaited<ReturnType<typeof newWedding>>

  /** Приглашает нового пользователя в команду свадьбы с ролью; отдаёт его токен. */
  async function joinAs(w: Wedding, role: 'helper' | 'coordinator', name?: string) {
    const member = await newUser()
    if (name) {
      const named = await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(member.token), payload: { name } })
      expect(named.statusCode, named.body.slice(0, 200)).toBe(200)
    }
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role, label: 'Фича 009' },
    })
    expect(invite.statusCode, invite.body.slice(0, 200)).toBe(201)
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code as string}/accept`,
      headers: auth(member.token),
    })
    expect(accepted.statusCode, accepted.body.slice(0, 200)).toBe(200)
    return member
  }

  /** Гость с личным токеном — так, как его получает живой человек. */
  async function newGuest(w: Wedding, name = 'Ольга') {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const guestId = created.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode, link.body.slice(0, 200)).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode, exchanged.body.slice(0, 200)).toBe(200)
    return { guestId, name, token: exchanged.json().guestToken as string }
  }

  async function newTable(w: Wedding, name: string) {
    const res = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/tables`, headers: auth(w.token), payload: { name } })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  async function seat(w: Wedding, guestId: string, tableId: string) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/guests/${guestId}`,
      headers: auth(w.token),
      payload: { tableId },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
  }

  /** Свой перевозчик (без анкеты) в слот «Транспорт» — его имя гость видит как `carrier`. */
  async function externalCarrier(w: Wedding, vendorName: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'transport')
    expect(slot, 'в мозаике нет слота «transport»').toBeTruthy()
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot!.id}/external`,
      headers: auth(w.token),
      payload: { vendorName, price: { amount: 2_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return (res.json().deal as { id: string }).id
  }

  async function newBus(w: Wedding, payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/logistics/buses`, headers: auth(w.token), payload })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  const board = async (guestToken: string, busId: string) => {
    const res = await app.inject({ method: 'POST', url: `/join/${guestToken}/shuttle`, headers: key(), payload: { busId } })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
  }

  const putTimeline = async (w: Wedding, events: Record<string, unknown>[]) => {
    const snapshot = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const res = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`, headers: { ...auth(w.token), 'if-match': snapshot.headers.etag! }, payload: events })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
    return res.json() as TimelineEvent[]
  }

  const dayOf = async (guestToken: string) => {
    const res = await app.inject({ method: 'GET', url: `/join/${guestToken}/day` })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
    return res.json() as GuestDay
  }

  const guestMessages = (guestToken: string, query = '') =>
    app.inject({ method: 'GET', url: `/join/${guestToken}/day-chat/messages${query}` })

  const guestSays = (guestToken: string, text: string) =>
    app.inject({ method: 'POST', url: `/join/${guestToken}/day-chat/messages`, payload: { text } })

  /** Чат дня X свадьбы глазами пары: идентификатор и `openFrom` из списка чатов. */
  async function dayChatOf(w: Wedding) {
    const res = await app.inject({ method: 'GET', url: '/chats', headers: auth(w.token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const chat = (res.json() as { id: string; kind: string; openFrom: string | null }[]).find((c) => c.kind === 'day')
    expect(chat, 'у свадьбы нет чата дня X').toBeTruthy()
    return chat!
  }

  /** Двигает дату свадьбы SQL на сегодня: окно гостя [вчера 09:00; завтра 23:59:59] по поясу места. */
  async function weddingToday(w: Wedding) {
    const { rows } = await app.db!.query<{ date: string }>(
      `update weddings set date = current_date where id = $1 returning to_char(date, 'YYYY-MM-DD') as date`,
      [w.weddingId],
    )
    return rows[0]!.date
  }

  /* ── тайминг: галочка «Показывать гостям» ─────────────────────────── */

  it('PUT …/timeline принимает forGuests (по умолчанию true); гость видит только гостевые блоки в порядке тайминга', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}`,
      headers: auth(w.token),
      payload: { venue: 'Усадьба «Ясная поляна»', dressCode: 'black tie', dressNote: 'дамы — без белого' },
    })

    const saved = await putTimeline(w, [
      { name: 'Сборы невесты', startsAt: '2027-06-14T05:00:00Z', forGuests: false },
      { name: 'Церемония', startsAt: '2027-06-14T09:00:00Z' },
      { name: 'Банкет', startsAt: '2027-06-14T12:00:00Z', forGuests: true },
    ])
    expect(saved.map((e) => [e.name, e.forGuests])).toEqual([
      ['Сборы невесты', false],
      ['Церемония', true],
      ['Банкет', true],
    ])

    const listed = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    ).json() as TimelineEvent[]
    expect(listed.find((e) => e.name === 'Сборы невесты')?.forGuests, 'GET …/timeline потерял forGuests:false').toBe(false)
    expect(listed.find((e) => e.name === 'Церемония')?.forGuests).toBe(true)

    // Автоплан строится на тех же строках — признак едет и в его предпросмотр.
    const autogen = (
      await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/timeline/autogen`, headers: auth(w.token) })
    ).json() as { events: TimelineEvent[] }
    expect(autogen.events.map((e) => e.forGuests)).toEqual([false, true, true])

    const day = await dayOf(guest.token)
    expect(day.timeline.map((e) => e.name), 'гость увидел служебный блок').toEqual(['Церемония', 'Банкет'])
    expect(day.timeline.every((e) => e.forGuests)).toBe(true)
    expect(day).toMatchObject({
      date: '2027-06-14',
      tz: w.tz,
      venue: 'Усадьба «Ясная поляна»',
      dressCode: 'black tie',
      dressNote: 'дамы — без белого',
    })
  })

  /* ── стол, автобус, координатор ───────────────────────────────────── */

  it('стол и автобус — свои: второй гость другой стол и без автобуса; без стола — null; carrier — перевозчик маршрута', async () => {
    const w = await newWedding()
    const anna = await newGuest(w, 'Анна')
    const mark = await newGuest(w, 'Марк')
    const olga = await newGuest(w, 'Ольга')

    const window = await newTable(w, 'У окна')
    const second = await newTable(w, 'Стол 2')
    await seat(w, anna.guestId, window)
    await seat(w, mark.guestId, second)

    const dealId = await externalCarrier(w, 'Автобусы Уфы')
    const bus1 = await newBus(w, { name: 'Автобус №1', from: 'ЗАГС', time: '14:30', seats: 20, dealId })
    await newBus(w, { name: 'Автобус №2', from: 'Гостиница', time: '15:00', seats: 20 })
    await board(anna.token, bus1)

    const annaDay = await dayOf(anna.token)
    expect(annaDay.table).toEqual({ name: 'У окна' })
    expect(annaDay.bus).toMatchObject({ id: bus1, name: 'Автобус №1', time: '14:30', carrier: 'Автобусы Уфы' })

    const markDay = await dayOf(mark.token)
    expect(markDay.table, 'гость увидел чужой стол').toEqual({ name: 'Стол 2' })
    expect(markDay.bus, 'гость без записи увидел чужой автобус').toBeNull()

    const olgaDay = await dayOf(olga.token)
    expect(olgaDay.table).toBeNull()
    expect(olgaDay.bus).toBeNull()
  })

  it('координатор — имя и телефон участника role=coordinator, и только с кануна; без координатора — null (помощник не в счёт); tz в GET /rsvp', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    await joinAs(w, 'helper', 'Пётр')
    const maria = await joinAs(w, 'coordinator', 'Мария')

    /* До кануна телефон координатора гостю не уходит (план, ворота прав): свадьба в 2027-м —
     * в ответе координатора нет, хотя он назначен. Экран раздел до кануна и не показывает,
     * но держать ворота должен сервер, а не только экран. */
    expect((await dayOf(guest.token)).coordinator, 'телефон координатора ушёл гостю до кануна').toBeNull()

    await weddingToday(w)
    const day = await dayOf(guest.token)
    expect(day.coordinator).toEqual({ name: 'Мария', phone: maria.phone })

    /* Пояс места нужен экрану гостя до запроса дня (раздел «с кануна» решается по нему):
     * контракт держит его в WeddingPublic.tz — отдаёт и GET /rsvp/{t}. */
    const rsvp = await app.inject({ method: 'GET', url: `/rsvp/${guest.token}` })
    expect(rsvp.statusCode).toBe(200)
    expect((rsvp.json() as { wedding: { tz?: string } }).wedding.tz, 'GET /rsvp без tz места').toBe(day.tz)

    const w2 = await newWedding()
    const guest2 = await newGuest(w2)
    await joinAs(w2, 'helper', 'Пётр')
    await weddingToday(w2)
    expect((await dayOf(guest2.token)).coordinator, 'помощник выдан за координатора').toBeNull()
  })

  /* ── чат дня: окно, реплика гостя, имя у пары ─────────────────────── */

  it('до кануна: chat.open=false с opensAt как у пары; GET и POST чата — 423 chat_closed_for_guests с details.opensAt', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    const dayChat = await dayChatOf(w)
    expect(dayChat.openFrom, 'у чата дня нет opens_at при назначенной дате').toBeTruthy()

    const day = await dayOf(guest.token)
    expect(day.chat).toEqual({ open: false, opensAt: dayChat.openFrom, closesAt: expect.any(String) })
    // Конец окна — день ПОСЛЕ свадьбы, позже её начала.
    expect(Date.parse(day.chat.closesAt!)).toBeGreaterThan(Date.parse(day.chat.opensAt!))

    const read = await guestMessages(guest.token)
    expect(read.statusCode, read.body.slice(0, 300)).toBe(423)
    /* Текст 423 идёт гостю на экран как есть — дата словами в поясе места, не сырой ISO. */
    const said = (read.json() as ErrorBody).error.message
    expect(said, 'в тексте 423 сырой ISO').not.toMatch(/\d{4}-\d{2}-\d{2}T\d/)
    expect(said).toContain('13 июня')
    expect((read.json() as ErrorBody).error).toMatchObject({
      code: 'chat_closed_for_guests',
      details: { opensAt: dayChat.openFrom },
    })

    const wrote = await guestSays(guest.token, 'Автобус задерживается')
    expect(wrote.statusCode, wrote.body.slice(0, 300)).toBe(423)
    expect((wrote.json() as ErrorBody).error).toMatchObject({ code: 'chat_closed_for_guests', details: { opensAt: dayChat.openFrom } })

    // Ничего не записалось: реплика вне окна — отказ, а не молчаливая запись.
    const { rows } = await app.db!.query('select 1 from messages where chat_id = $1 and guest_id = $2', [dayChat.id, guest.guestId])
    expect(rows).toEqual([])
  })

  it('в окне: реплика гостя 201 с guestName; у пары в GET /chats/{id}/messages — guestName и system:false; курсор; команде — уведомление', async () => {
    const w = await newWedding()
    const maria = await joinAs(w, 'coordinator', 'Мария')
    const guest = await newGuest(w, 'Ольга')
    const dayChat = await dayChatOf(w)
    const today = await weddingToday(w)

    const day = await dayOf(guest.token)
    expect(day.date).toBe(today)
    expect(day.chat.open, `окно закрыто: ${JSON.stringify(day.chat)}`).toBe(true)

    // Пара пишет первой — гость должен увидеть её реплику в той же ленте.
    const fromCouple = await app.inject({
      method: 'POST',
      url: `/chats/${dayChat.id}/messages`,
      headers: auth(w.token),
      payload: { text: 'Все на месте?' },
    })
    expect(fromCouple.statusCode, fromCouple.body.slice(0, 300)).toBe(201)
    expect((fromCouple.json() as Message).guestName, 'у реплики участника guestName должен быть null').toBeNull()

    const sent = await guestSays(guest.token, 'Автобус от ЗАГСа задерживается на 10 минут')
    expect(sent.statusCode, sent.body.slice(0, 300)).toBe(201)
    const mine = sent.json() as Message
    expect(mine).toMatchObject({
      chatId: dayChat.id,
      senderId: null,
      text: 'Автобус от ЗАГСа задерживается на 10 минут',
      system: false,
      guestName: 'Ольга',
    })
    const { rows: stored } = await app.db!.query<{ guest_id: string; sender_id: string | null }>(
      'select guest_id, sender_id from messages where id = $1',
      [mine.id],
    )
    expect(stored[0]).toEqual({ guest_id: guest.guestId, sender_id: null })

    // Лента гостя — та же, что у пары, по курсору: свежая первой, дальше по nextCursor.
    const first = await guestMessages(guest.token, '?limit=1')
    expect(first.statusCode, first.body.slice(0, 300)).toBe(200)
    const page1 = first.json() as { items: Message[]; nextCursor: string | null }
    expect(page1.items.map((m) => m.id)).toEqual([mine.id])
    expect(page1.nextCursor).toBeTruthy()
    const second = await guestMessages(guest.token, `?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`)
    const page2 = second.json() as { items: Message[] }
    expect(page2.items[0]).toMatchObject({ id: fromCouple.json().id, senderId: w.userId, guestName: null, system: false })

    // Пара видит реплику гостя с именем — и не как системную запись.
    const forCouple = await app.inject({ method: 'GET', url: `/chats/${dayChat.id}/messages`, headers: auth(w.token) })
    expect(forCouple.statusCode, forCouple.body.slice(0, 300)).toBe(200)
    const seen = (forCouple.json() as { items: Message[] }).items.find((m) => m.id === mine.id)
    expect(seen).toMatchObject({ senderId: null, system: false, guestName: 'Ольга' })

    // Команде — уведомление тем же путём, что от участника.
    const inbox = (
      await app.inject({ method: 'GET', url: '/notifications', headers: auth(maria.token) })
    ).json() as { kind: string; body: string; link: string | null }[]
    expect(inbox.find((n) => n.kind === 'chat' && n.body === 'Автобус от ЗАГСа задерживается на 10 минут')).toMatchObject({
      link: `/chats/${dayChat.id}`,
    })

    // Схема тела — по контракту: до 2000 знаков.
    const tooLong = await guestSays(guest.token, 'а'.repeat(2001))
    expect(tooLong.statusCode).toBe(422)
  })

  /* ── база держит инвариант ────────────────────────────────────────── */

  it('CHECK messages_one_author: реплика с sender_id и guest_id одновременно — 23514 прямым SQL', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    const dayChat = await dayChatOf(w)
    await expect(
      app.db!.query(
        `insert into messages (id, chat_id, sender_id, guest_id, text) values (gen_random_uuid(), $1, $2, $3, 'двое авторов')`,
        [dayChat.id, w.userId, guest.guestId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'messages_one_author' })
  })

  /* ── мёртвая ссылка ───────────────────────────────────────────────── */

  it('мёртвый токен — 410 gone на всех трёх путях дня; удалённый из списка гость — тоже 410', async () => {
    for (const path of ['/day', '/day-chat/messages']) {
      const res = await app.inject({ method: 'GET', url: `/join/${randomUUID()}${path}` })
      expect(res.statusCode, `${path}: ${res.body.slice(0, 200)}`).toBe(410)
      expect((res.json() as ErrorBody).error.code).toBe('gone')
    }
    const posted = await app.inject({ method: 'POST', url: `/join/${randomUUID()}/day-chat/messages`, payload: { text: 'эй' } })
    expect(posted.statusCode, posted.body.slice(0, 200)).toBe(410)

    const w = await newWedding()
    const guest = await newGuest(w)
    await dayOf(guest.token)
    const removed = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/guests/${guest.guestId}`, headers: auth(w.token) })
    expect(removed.statusCode, removed.body.slice(0, 200)).toBe(204)
    const after = await app.inject({ method: 'GET', url: `/join/${guest.token}/day` })
    expect(after.statusCode, after.body.slice(0, 200)).toBe(410)
  })
})
