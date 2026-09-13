/*
 * Фича 014 — хвосты до прода, бэкенд.
 *
 * A1  слот категории вне шаблона: `POST /weddings/{id}/slots` — 201, повтор
 *     409 `slot_exists` с `details.slotId`, чужая категория 422, помощник 403;
 *     в новый слот бронируется подрядчик этой категории.
 * A2  телефон гостя пишет только пара: помощнику — 403, без телефона — 201.
 * A3  маршрут только к живой сделке перевозчика: кандидат — 409 `deal_not_booked`.
 * A8  `Message.mine` считает сервер: участнику по `senderId`, гостю по строке
 *     гостя — две Марины не путаются.
 * A9  значок категории стирается `icon: null`, пропуск поля его не трогает.
 * A12 в выгрузке 152-ФЗ есть `chatReads` и `notes`.
 * A13 курсор ленты — микросекунды строки: реплики одной миллисекунды не пропадают.
 * A14 отпечаток идемпотентности включает адрес: тот же ключ и тело на другой
 *     слот — 409 `idempotency_key_reused`, а не чужой ответ.
 * A17 `RESERVATIONS_MAX_PER_GUEST` — из конфигурации.
 * A18 вход по телефону строки старше окна восстановления стирает её сразу и
 *     заводит новый аккаунт — вместо токенов, с которыми всё отвечает 401.
 * B1  заметки свадьбы на сервере: команда читает и пишет, удаление — 204/404,
 *     пустой текст — 422, чужая свадьба — 404.
 * B2  маршрут с перевозчиком из каталога — заметка `transport` в кабинете.
 * B5  уборка архива оставляет отзыв пары подрядчику (сделка → null).
 * Красный без фикса (файлы из HEAD): каждая группа падает на своём шаге.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { loadConfig } from '../src/config.js'
import { purgeArchivedWeddings } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

type Slot = { id: string; categoryId: string; label: string; deal: { id: string; state: string } | null; tileState: string }
type Message = { id: string; senderId: string | null; text: string; guestName: string | null; mine: boolean | null; sentAt: string }
type Note = { id: string; text: string; authorName: string | null; createdAt: string }

describe('фича 014: настройки', () => {
  const env = (extra: Record<string, string>) => ({ NODE_ENV: 'development', ...extra }) as NodeJS.ProcessEnv
  it('A17: предел резервов подарков читается из RESERVATIONS_MAX_PER_GUEST, по умолчанию 5', () => {
    expect(loadConfig(env({})).reservationsMaxPerGuest).toBe(5)
    expect(loadConfig(env({ RESERVATIONS_MAX_PER_GUEST: '' })).reservationsMaxPerGuest).toBe(5)
    expect(loadConfig(env({ RESERVATIONS_MAX_PER_GUEST: '2' })).reservationsMaxPerGuest).toBe(2)
  })
})

describe.skipIf(!live)('фича 014: хвосты до прода', () => {
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
  const key = (k = randomUUID()) => ({ 'idempotency-key': k })

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

  async function login(phone: string) {
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    expect(v.statusCode, v.body.slice(0, 200)).toBe(200)
    return v.json() as { accessToken: string; user: { id: string }; consentRequired: boolean }
  }

  async function newUser(name?: string) {
    const phone = nextPhone()
    const body = await login(phone)
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    if (name) {
      const named = await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(body.accessToken), payload: { name } })
      expect(named.statusCode, named.body.slice(0, 200)).toBe(200)
    }
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  async function newWedding(name?: string) {
    const user = await newUser(name)
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }
  type Wedding = Awaited<ReturnType<typeof newWedding>>

  const slotsOf = async (w: Wedding, token = w.token) => {
    const res = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as Slot[]
  }

  async function joinAs(w: Wedding, role: 'helper' | 'coordinator', name?: string) {
    const member = await newUser(name)
    const invite = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/invites`, headers: auth(w.token), payload: { role, label: 'Фича 014' } })
    expect(invite.statusCode, invite.body.slice(0, 200)).toBe(201)
    const accepted = await app.inject({ method: 'POST', url: `/invites/${invite.json().code as string}/accept`, headers: auth(member.token) })
    expect(accepted.statusCode, accepted.body.slice(0, 200)).toBe(200)
    return member
  }

  async function newGuest(w: Wedding, name = 'Ольга') {
    const created = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w.token), payload: { name } })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const guestId = created.json().id as string
    const link = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`, headers: auth(w.token) })
    expect(link.statusCode, link.body.slice(0, 200)).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode, exchanged.body.slice(0, 200)).toBe(200)
    return { guestId, name, token: exchanged.json().guestToken as string }
  }

  async function publishedVendor(categoryId: string, name = `Студия ${RUN}`) {
    const owner = await newUser()
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name, categoryId, city: { name: 'Уфа', region: 'Башкортостан' }, priceFrom: { amount: 4_000_000, currency: 'RUB' } },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })).statusCode).toBe(200)
    return { id: put.json().id as string, name, owner }
  }

  async function book(w: Wedding, slotId: string, vendorId: string, k = randomUUID()) {
    return app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: { ...auth(w.token), ...key(k) },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
  }

  const addSlot = (w: Wedding, categoryId: string, token = w.token) =>
    app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots`, headers: auth(token), payload: { categoryId } })

  /* ── A1: слот вне шаблона ─────────────────────────────────────────── */
  it('A1: пара добавляет слот категории вне шаблона; повтор — 409 slot_exists с идентификатором; чужая категория — 422; помощник — 403; в новый слот бронируется подрядчик', async () => {
    const w = await newWedding()
    const before = await slotsOf(w)
    expect(before.map((s) => s.categoryId)).not.toContain('firework')

    const added = await addSlot(w, 'firework')
    expect(added.statusCode, added.body.slice(0, 300)).toBe(201)
    const slot = added.json() as Slot
    expect(slot).toMatchObject({ categoryId: 'firework', label: 'Пиротехника', deal: null, tileState: 'empty' })

    const after = await slotsOf(w)
    expect(after.length).toBe(before.length + 1)
    expect(after[after.length - 1]!.id, 'новый слот — в конце мозаики').toBe(slot.id)

    const again = await addSlot(w, 'firework')
    expect(again.statusCode, again.body.slice(0, 300)).toBe(409)
    expect(again.json().error).toMatchObject({ code: 'slot_exists', details: { slotId: slot.id } })
    expect((await slotsOf(w)).length, 'второй слот той же категории не завёлся').toBe(before.length + 1)

    const unknown = await addSlot(w, 'no-such-category')
    expect(unknown.statusCode, unknown.body.slice(0, 300)).toBe(422)

    const helper = await joinAs(w, 'helper')
    expect((await addSlot(w, 'photobooth', helper.token)).statusCode, 'состав команды решает пара').toBe(403)
    expect((await slotsOf(w, helper.token)).length, 'помощник мозаику видит вместе с новым слотом').toBe(before.length + 1)

    const vendor = await publishedVendor('firework', `Салют ${RUN}`)
    const booked = await book(w, slot.id, vendor.id)
    expect([200, 201], booked.body.slice(0, 300)).toContain(booked.statusCode)
    expect((booked.json() as Slot).deal).toBeTruthy()
  })

  /* ── A14: адрес в отпечатке идемпотентности ───────────────────────── */
  it('A14: тот же Idempotency-Key и то же тело на ДРУГОЙ слот — 409 idempotency_key_reused, а не чужой ответ', async () => {
    const w = await newWedding()
    const slots = await slotsOf(w)
    const photo = slots.find((s) => s.categoryId === 'photo')!
    const video = slots.find((s) => s.categoryId === 'video')!
    const vendor = await publishedVendor('photo')
    const k = randomUUID()

    const first = await book(w, photo.id, vendor.id, k)
    expect([200, 201], first.body.slice(0, 300)).toContain(first.statusCode)

    const other = await book(w, video.id, vendor.id, k)
    expect(other.statusCode, other.body.slice(0, 300)).toBe(409)
    expect(other.json().error.code).toBe('idempotency_key_reused')
    expect(other.headers['idempotent-replay']).toBeUndefined()
    expect((await slotsOf(w)).find((s) => s.id === video.id)!.deal, 'слот видео остался пустым — чужой ответ не выдан за бронь').toBeNull()

    // Честный повтор — тот же адрес, то же тело — по-прежнему возвращает сохранённый ответ.
    const replay = await book(w, photo.id, vendor.id, k)
    expect(replay.statusCode).toBe(first.statusCode)
    expect(replay.headers['idempotent-replay']).toBe('true')
  })

  /* ── A2: телефон гостя — только пара ──────────────────────────────── */
  it('A2: помощник не записывает телефон гостя (403) — ни при добавлении, ни при правке, ни импортом; без телефона — можно', async () => {
    const w = await newWedding()
    const helper = await joinAs(w, 'helper')
    const guests = `/weddings/${w.weddingId}/guests`

    const withPhone = await app.inject({ method: 'POST', url: guests, headers: auth(helper.token), payload: { name: 'Ольга', phone: '+79170000001' } })
    expect(withPhone.statusCode, withPhone.body.slice(0, 300)).toBe(403)
    const plain = await app.inject({ method: 'POST', url: guests, headers: auth(helper.token), payload: { name: 'Ольга' } })
    expect(plain.statusCode, plain.body.slice(0, 300)).toBe(201)
    const guestId = plain.json().id as string

    const patch = await app.inject({ method: 'PATCH', url: `${guests}/${guestId}`, headers: auth(helper.token), payload: { phone: '+79170000002' } })
    expect(patch.statusCode, patch.body.slice(0, 300)).toBe(403)
    const rename = await app.inject({ method: 'PATCH', url: `${guests}/${guestId}`, headers: auth(helper.token), payload: { name: 'Ольга Петрова' } })
    expect(rename.statusCode, rename.body.slice(0, 300)).toBe(200)

    const imported = await app.inject({ method: 'POST', url: `${guests}/import`, headers: auth(helper.token), payload: { guests: [{ name: 'Денис', phone: '+79170000003' }] } })
    expect(imported.statusCode, imported.body.slice(0, 300)).toBe(403)

    const { rows } = await app.db!.query<{ phone: string | null }>('select phone from guests where id = $1', [guestId])
    expect(rows[0]!.phone, 'телефон не записался вслепую').toBeNull()

    const couple = await app.inject({ method: 'PATCH', url: `${guests}/${guestId}`, headers: auth(w.token), payload: { phone: '+79170000004' } })
    expect(couple.statusCode, couple.body.slice(0, 300)).toBe(200)
    expect(couple.json().phone).toBe('+79170000004')
  })

  /* ── A3 и B2: маршрут и перевозчик ────────────────────────────────── */
  it('A3: маршрут к сделке-кандидату — 409 deal_not_booked; B2: маршрут с перевозчиком из каталога пишет заметку вида transport', async () => {
    const w = await newWedding()
    const transport = (await slotsOf(w)).find((s) => s.categoryId === 'transport')!
    const carrier = await publishedVendor('transport', `Кортеж ${RUN}`)
    const booked = await book(w, transport.id, carrier.id)
    expect([200, 201], booked.body.slice(0, 300)).toContain(booked.statusCode)
    const dealId = (booked.json() as Slot).deal!.id

    await app.db!.query(`update deals set state = 'candidate', booked_at = null where id = $1`, [dealId])
    const refused = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус №1', seats: 40, dealId },
    })
    expect(refused.statusCode, refused.body.slice(0, 300)).toBe(409)
    expect(refused.json().error.code).toBe('deal_not_booked')

    await app.db!.query(`update deals set state = 'booked', booked_at = now() where id = $1`, [dealId])
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус №1', seats: 40, time: '14:30', dealId },
    })
    expect(created.statusCode, created.body.slice(0, 300)).toBe(201)
    expect(created.json().carrier).toBe(carrier.name)

    const { rows } = await app.db!.query<{ kind: string; text: string }>(
      'select kind, text from vendor_updates where vendor_id = $1 and wedding_id = $2 and ack_at is null',
      [carrier.id, w.weddingId],
    )
    expect(rows.map((r) => r.kind), 'заметка перевозчику — своего вида').toContain('transport')
    expect(rows.find((r) => r.kind === 'transport')!.text).toContain('Автобус №1')
  })

  /* ── A8 и A13: своя реплика и курсор ленты ────────────────────────── */
  it('A8: mine считает сервер — участнику по senderId, гостям по своей строке (две Марины не путаются); A13: курсор ленты несёт микросекунды и не теряет реплики одной миллисекунды', async () => {
    const w = await newWedding('Алина')
    const helper = await joinAs(w, 'helper', 'Помощник')
    await app.db!.query('update weddings set date = current_date where id = $1', [w.weddingId])
    const chats = (await app.inject({ method: 'GET', url: '/chats', headers: auth(w.token) })).json() as { id: string; kind: string }[]
    const day = chats.find((c) => c.kind === 'day')!
    expect(day, 'у свадьбы нет чата дня X').toBeTruthy()

    const marina1 = await newGuest(w, 'Марина')
    const marina2 = await newGuest(w, 'Марина')
    const said = await app.inject({ method: 'POST', url: `/chats/${day.id}/messages`, headers: auth(w.token), payload: { text: 'Все собрались?' } })
    expect(said.statusCode, said.body.slice(0, 300)).toBe(201)
    expect((said.json() as Message).mine, 'автору в ответе — своя').toBe(true)
    const g1 = await app.inject({ method: 'POST', url: `/join/${marina1.token}/day-chat/messages`, payload: { text: 'Я у входа' } })
    expect(g1.statusCode, g1.body.slice(0, 300)).toBe(201)
    expect((g1.json() as Message).mine).toBe(true)
    const g2 = await app.inject({ method: 'POST', url: `/join/${marina2.token}/day-chat/messages`, payload: { text: 'А я в зале' } })
    expect(g2.statusCode, g2.body.slice(0, 300)).toBe(201)

    const byText = (items: Message[]) => Object.fromEntries(items.map((m) => [m.text, m.mine]))

    const coupleView = (await app.inject({ method: 'GET', url: `/chats/${day.id}/messages`, headers: auth(w.token) })).json() as { items: Message[] }
    expect(byText(coupleView.items)).toMatchObject({ 'Все собрались?': true, 'Я у входа': false, 'А я в зале': false })
    const helperView = (await app.inject({ method: 'GET', url: `/chats/${day.id}/messages`, headers: auth(helper.token) })).json() as { items: Message[] }
    expect(byText(helperView.items)).toMatchObject({ 'Все собрались?': false, 'Я у входа': false })

    const m1 = await app.inject({ method: 'GET', url: `/join/${marina1.token}/day-chat/messages` })
    expect(m1.statusCode, m1.body.slice(0, 300)).toBe(200)
    expect(byText((m1.json() as { items: Message[] }).items)).toMatchObject({ 'Я у входа': true, 'А я в зале': false, 'Все собрались?': false })
    const m2 = await app.inject({ method: 'GET', url: `/join/${marina2.token}/day-chat/messages` })
    expect(byText((m2.json() as { items: Message[] }).items)).toMatchObject({ 'Я у входа': false, 'А я в зале': true })

    /* A13. Три реплики в одну миллисекунду с разными микросекундами — как
     * их пишет база под нагрузкой. Листаем по одной: курсор с миллисекундами
     * терял вторую и третью — их `created_at` больше усечённого ключа. */
    const base = '2026-06-14T12:00:00.123'
    for (const [i, us] of ['456', '300', '100'].entries()) {
      await app.db!.query(
        `insert into messages (id, chat_id, sender_id, text, created_at) values ($1, $2, $3, $4, ($5 || 'Z')::timestamptz)`,
        [randomUUID(), day.id, w.userId, `мкс-${i}`, `${base}${us}`],
      )
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 8 && seen.length < 3; page++) {
      const q = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await app.inject({ method: 'GET', url: `/chats/${day.id}/messages${q}`, headers: auth(w.token) })
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
      const body = res.json() as { items: Message[]; nextCursor: string | null }
      for (const m of body.items) if (m.text.startsWith('мкс-')) seen.push(m.text)
      if (body.nextCursor) {
        const decoded = Buffer.from(body.nextCursor, 'base64url').toString('utf8')
        expect(decoded, 'ключ курсора — с шестью знаками дроби').toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|/)
      }
      cursor = body.nextCursor
      if (!cursor) break
    }
    expect(seen, 'реплики одной миллисекунды пропали при листании').toEqual(['мкс-0', 'мкс-1', 'мкс-2'])
  })

  /* ── B1 и A12: заметки и выгрузка ─────────────────────────────────── */
  it('B1: заметки свадьбы — команда читает и пишет, удаление 204/404, пустой текст 422, чужая свадьба 404; A12: выгрузка несёт notes и chatReads', async () => {
    const w = await newWedding('Алина')
    const helper = await joinAs(w, 'helper', 'Саша')
    const notes = `/weddings/${w.weddingId}/notes`

    const empty = await app.inject({ method: 'GET', url: notes, headers: auth(w.token) })
    expect(empty.statusCode, empty.body.slice(0, 300)).toBe(200)
    expect(empty.json()).toEqual([])

    const created = await app.inject({ method: 'POST', url: notes, headers: auth(w.token), payload: { text: 'Торт — трёхъярусный, без мастики' } })
    expect(created.statusCode, created.body.slice(0, 300)).toBe(201)
    const note = created.json() as Note
    expect(note).toMatchObject({ text: 'Торт — трёхъярусный, без мастики', authorName: 'Алина' })
    expect(typeof note.createdAt).toBe('string')

    const byHelper = await app.inject({ method: 'POST', url: notes, headers: auth(helper.token), payload: { text: 'Свечи — купить заранее' } })
    expect(byHelper.statusCode, byHelper.body.slice(0, 300)).toBe(201)
    expect((byHelper.json() as Note).authorName).toBe('Саша')

    expect((await app.inject({ method: 'POST', url: notes, headers: auth(w.token), payload: { text: '   ' } })).statusCode).toBe(422)
    expect((await app.inject({ method: 'POST', url: notes, headers: auth(w.token), payload: { text: '' } })).statusCode).toBe(422)

    const listed = (await app.inject({ method: 'GET', url: notes, headers: auth(helper.token) })).json() as Note[]
    expect(listed.map((n) => n.text), 'свежие первыми, видны всей команде').toEqual(['Свечи — купить заранее', 'Торт — трёхъярусный, без мастики'])

    const stranger = await newWedding()
    expect((await app.inject({ method: 'GET', url: notes, headers: auth(stranger.token) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/weddings/${stranger.weddingId}/notes/${note.id}`, headers: auth(stranger.token) })).statusCode, 'чужой идентификатор через свою свадьбу').toBe(404)

    expect((await app.inject({ method: 'DELETE', url: `${notes}/${note.id}`, headers: auth(helper.token) })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `${notes}/${note.id}`, headers: auth(helper.token) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `${notes}/not-a-uuid`, headers: auth(w.token) })).statusCode).toBe(404)
    expect(((await app.inject({ method: 'GET', url: notes, headers: auth(w.token) })).json() as Note[]).map((n) => n.text)).toEqual(['Свечи — купить заранее'])

    /* A12: выгрузка 152-ФЗ — свои заметки и отметки «прочитано». Чат дня X
     * есть у свадьбы с рождения (командный появляется на второй сделке);
     * открывается накануне — дата двигается на сегодня. */
    await app.db!.query('update weddings set date = current_date where id = $1', [w.weddingId])
    const chats = (await app.inject({ method: 'GET', url: '/chats', headers: auth(helper.token) })).json() as { id: string; kind: string }[]
    const day = chats.find((c) => c.kind === 'day')
    expect(day, 'помощник не видит чат дня X').toBeTruthy()
    const opened = await app.inject({ method: 'GET', url: `/chats/${day!.id}/messages`, headers: auth(helper.token) })
    expect(opened.statusCode, opened.body.slice(0, 300)).toBe(200)
    const exported = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(helper.token) })
    expect(exported.statusCode, exported.body.slice(0, 300)).toBe(200)
    const dump = exported.json() as { notes: { text: string }[]; chatReads: { chat_id: string }[] }
    expect(dump.notes?.map((n) => n.text), 'в выгрузке нет своих заметок').toEqual(['Свечи — купить заранее'])
    expect(dump.chatReads?.map((r) => r.chat_id), 'в выгрузке нет отметок «прочитано»').toContain(day!.id)
  })

  /* ── A9: значок категории ─────────────────────────────────────────── */
  it('A9: icon: null стирает значок категории, пропуск поля оставляет прежний', async () => {
    const CAT = 'registrar'
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])
    const read = async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/categories', headers: auth(staff.token) })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      return (res.json() as { categories: { id: string; title: string; icon: string | null; sort: number }[] }).categories.find((c) => c.id === CAT)!
    }
    const put = async (payload: unknown) => {
      const res = await app.inject({ method: 'PUT', url: '/admin/categories', headers: auth(staff.token), payload })
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
    }
    const before = await read()
    try {
      await put({ categories: [{ id: CAT, title: before.title, icon: '🧪', sort: before.sort }] })
      expect((await read()).icon).toBe('🧪')
      await put({ categories: [{ id: CAT, title: before.title, sort: before.sort }] })
      expect((await read()).icon, 'пропуск поля — прежний значок').toBe('🧪')
      await put({ categories: [{ id: CAT, title: before.title, icon: null, sort: before.sort }] })
      expect((await read()).icon, 'null — стереть').toBeNull()
    } finally {
      await put({ categories: [before.icon === null ? { id: CAT, title: before.title, icon: null, sort: before.sort } : { id: CAT, title: before.title, icon: before.icon, sort: before.sort }] })
    }
  })

  /* ── A18: вход после окна восстановления ──────────────────────────── */
  it('A18: строка старше 30 дней после удаления при входе стирается сразу — новый аккаунт работает, а не отвечает 401', async () => {
    /* Строка заводится SQL, как её оставила бы уборка, не успевшая пройти:
     * второй вход тем же телефоном упёрся бы в паузу между кодами. */
    const stale = { userId: randomUUID(), phone: nextPhone() }
    await app.db!.query(`insert into users (id, phone, deleted_at) values ($1, $2, now() - interval '31 days')`, [stale.userId, stale.phone])

    const fresh = await login(stale.phone)
    expect(fresh.user.id, 'аккаунт заведён заново, а не воскрешён').not.toBe(stale.userId)
    expect(fresh.consentRequired, 'у нового аккаунта согласия ещё нет').toBe(true)
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(fresh.accessToken), payload: { policyVersion: '2026-09-02' } })
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(fresh.accessToken) })
    expect(me.statusCode, me.body.slice(0, 300)).toBe(200)
    const { rows } = await app.db!.query('select 1 from users where id = $1', [stale.userId])
    expect(rows.length, 'старая строка стёрта').toBe(0)
  })

  /* ── B5: отзыв пары переживает уборку ─────────────────────────────── */
  it('B5: уборка архива не удаляет отзыв пары — он остаётся подрядчику со сделкой → null', async () => {
    const w = await newWedding()
    const photo = (await slotsOf(w)).find((s) => s.categoryId === 'photo')!
    const vendor = await publishedVendor('photo', `Фото ${RUN}`)
    const booked = await book(w, photo.id, vendor.id)
    expect([200, 201], booked.body.slice(0, 300)).toContain(booked.statusCode)
    const dealId = (booked.json() as Slot).deal!.id
    await app.db!.query(`update deals set state = 'done', done_at = now() where id = $1`, [dealId])

    const review = await app.inject({ method: 'POST', url: `/catalog/vendors/${vendor.id}/reviews`, headers: auth(w.token), payload: { rating: 5, text: 'Снимал легко и незаметно' } })
    expect(review.statusCode, review.body.slice(0, 300)).toBe(201)
    const ratingBefore = (await app.db!.query<{ rating: string | null; reviews_count: number }>('select rating::text as rating, reviews_count from vendors where id = $1', [vendor.id])).rows[0]!

    await app.db!.query(`update weddings set cancelled_at = now() - interval '400 days', archived_at = now() - interval '400 days' where id = $1`, [w.weddingId])
    await purgeArchivedWeddings(app)

    expect((await app.db!.query('select 1 from weddings where id = $1', [w.weddingId])).rows.length, 'свадьба убрана').toBe(0)
    const { rows } = await app.db!.query<{ deal_id: string | null; text: string }>(
      `select deal_id, text from reviews where vendor_id = $1 and source = 'couple'`,
      [vendor.id],
    )
    expect(rows.map((r) => r.text), 'отзыв пары удалён вместе со свадьбой').toEqual(['Снимал легко и незаметно'])
    expect(rows[0]!.deal_id).toBeNull()
    const after = (await app.db!.query<{ rating: string | null; reviews_count: number }>('select rating::text as rating, reviews_count from vendors where id = $1', [vendor.id])).rows[0]!
    expect(after).toEqual(ratingBefore)
  })
})
