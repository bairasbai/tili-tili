import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Фича 006 «Транспорт», задание BE-006: перевозчик — подрядчик, маршрут для
 * гостей знает его сделку (`bus_routes.deal_id`, контракт v0.30.0).
 *
 * Что проверяется: `POST …/logistics/buses` принимает `dealId` только сделки
 * этой свадьбы в слоте «Транспорт» и не отменённой (422 / 422 `not_transport`
 * / 409 `deal_cancelled`); пара, команда и гость видят `carrier` — имя анкеты
 * или своего подрядчика; `PATCH …/buses/{busId}` правит маршрут под замком
 * строки (мест меньше занятых персон — 409 `bus_full`), `dealId: null`
 * снимает перевозчика; отмена сделки «убирает перевозчика», не трогая маршрут
 * и записи гостей; кабинет перевозчика видит `busRoutes` со счётчиками — и
 * ни одного имени или телефона гостя; `DayXBroadcast` без `notifiedGuests`.
 *
 * Каждый тест был красным до своей правки (доказательство — подмена файла из
 * `HEAD`, цитаты в отчёте). База общая с соседними наборами (R-177/R-226/R-227):
 * каждый тест заводит свою свадьбу и смотрит только на свои строки.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('фича 006, BE-006: перевозчик как подрядчик, маршрут знает сделку', () => {
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
    return { token: body.accessToken, userId: body.user.id }
  }

  async function newWedding(opts: { date?: string } = {}) {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: opts.date ?? '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  type Wedding = Awaited<ReturnType<typeof newWedding>>

  /** Приглашает нового пользователя в команду свадьбы с ролью; отдаёт его токен. */
  async function joinAs(w: Wedding, role: 'helper' | 'coordinator') {
    const member = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role, label: 'Фича 006' },
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
  async function newGuest(w: Wedding, name = 'Ольга', plusOne = false, phone?: string) {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name, plusOne, ...(phone ? { phone } : {}) },
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
    return { guestId, token: exchanged.json().guestToken as string }
  }

  /** Анкета в каталоге: по умолчанию перевозчик. Имя уникально на прогон. */
  async function newVendor(name = 'Автобусы Уфы', categoryId = 'transport') {
    const user = await newUser()
    const fullName = `${name} ${RUN}-${++counter}`
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: fullName,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: created.json().id as string, name: fullName }
  }

  async function slotOf(w: Wedding, categoryId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === categoryId)
    expect(slot, `в мозаике нет слота «${categoryId}»`).toBeTruthy()
    return slot!.id
  }

  /** Бронь анкеты из каталога в слот категории; отдаёт сделку и слот. */
  async function bookVendor(w: Wedding, vendorId: string, categoryId = 'transport') {
    const slotId = await slotOf(w, categoryId)
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 3_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return { dealId: (res.json().deal as { id: string }).id, slotId }
  }

  /** Свой подрядчик (без анкеты и аккаунта) в слот категории. */
  async function externalVendor(w: Wedding, vendorName: string, categoryId = 'transport') {
    const slotId = await slotOf(w, categoryId)
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
      headers: auth(w.token),
      payload: { vendorName, price: { amount: 2_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return { dealId: (res.json().deal as { id: string }).id, slotId }
  }

  const postBus = (w: Wedding, payload: Record<string, unknown>, token = w.token) =>
    app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/logistics/buses`, headers: auth(token), payload })

  const patchBus = (w: Wedding, busId: string, payload: Record<string, unknown>, token = w.token) =>
    app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/logistics/buses/${busId}`, headers: auth(token), payload })

  interface BusRoute {
    id: string
    name: string
    from: string | null
    time: string | null
    seats: number
    taken: number
    dealId: string | null
    carrier: string | null
  }

  const busesOf = async (w: Wedding) => {
    const res = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/logistics/buses`, headers: auth(w.token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as BusRoute[]
  }

  const peopleOf = async (guestToken: string) => {
    const res = await app.inject({ method: 'GET', url: `/rsvp/${guestToken}` })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return (res.json().people ?? []) as { id: string; name: string }[]
  }

  const board = (guestToken: string, busId: string, personId?: string) =>
    app.inject({
      method: 'POST',
      url: `/join/${guestToken}/shuttle`,
      headers: key(),
      payload: { busId, ...(personId ? { personId } : {}) },
    })

  const cancelSlot = (w: Wedding, slotId: string) =>
    app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`, headers: { ...auth(w.token), ...key() } })

  const errorOf = (res: { statusCode: number; json: () => { error?: { code?: string; message?: string } } }) => ({
    status: res.statusCode,
    code: res.json().error?.code,
  })

  /* ── POST: какая сделка годится в перевозчика ─────────────────────── */

  it('POST: dealId сделки чужой свадьбы — 422 с полем dealId, маршрут не заведён', async () => {
    const theirs = await newWedding({ date: '2027-06-14' })
    const carrier = await newVendor()
    const { dealId } = await bookVendor(theirs, carrier.vendorId)

    const mine = await newWedding({ date: '2027-06-15' })
    const res = await postBus(mine, { name: 'Автобус №1', seats: 40, dealId })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(422)
    expect(res.json().error.fields).toHaveProperty('dealId')
    expect(await busesOf(mine)).toEqual([])
  })

  it('POST: сделка не в слоте «Транспорт» — 422 not_transport с подсказкой', async () => {
    const w = await newWedding()
    const photographer = await newVendor('Фотограф', 'photo')
    const { dealId } = await bookVendor(w, photographer.vendorId, 'photo')

    const res = await postBus(w, { name: 'Автобус №1', seats: 40, dealId })
    expect(errorOf(res)).toEqual({ status: 422, code: 'not_transport' })
    expect(res.json().error.message).toContain('слоте «Транспорт»')
    expect(await busesOf(w)).toEqual([])
  })

  it('POST: отменённая транспортная сделка — 409 deal_cancelled', async () => {
    const w = await newWedding()
    const carrier = await newVendor()
    const { dealId, slotId } = await bookVendor(w, carrier.vendorId)
    const cancelled = await cancelSlot(w, slotId)
    expect(cancelled.statusCode, cancelled.body.slice(0, 200)).toBe(200)

    expect(errorOf(await postBus(w, { name: 'Автобус №1', seats: 40, dealId }))).toEqual({
      status: 409,
      code: 'deal_cancelled',
    })
    expect(await busesOf(w)).toEqual([])
  })

  it('POST: со сделкой из каталога carrier — имя анкеты; со своим подрядчиком — его имя; без сделки — null', async () => {
    const w = await newWedding()
    const carrier = await newVendor()
    const { dealId } = await bookVendor(w, carrier.vendorId)

    const withCatalog = await postBus(w, { name: 'Автобус №1', from: 'Гостиный двор', time: '14:30', seats: 40, dealId })
    expect(withCatalog.statusCode, withCatalog.body.slice(0, 200)).toBe(201)
    expect(withCatalog.json()).toMatchObject({ name: 'Автобус №1', time: '14:30', seats: 40, taken: 0, dealId, carrier: carrier.name })

    /* Свой перевозчик — в другой свадьбе: слот «Транспорт» в мозаике один,
     * и в нём уже стоит сделка из каталога. */
    const other = await newWedding()
    const own = await externalVendor(other, 'Дядя Рустем на микроавтобусе')
    const withOwn = await postBus(other, { name: 'Микроавтобус', seats: 8, dealId: own.dealId })
    expect(withOwn.statusCode, withOwn.body.slice(0, 200)).toBe(201)
    expect(withOwn.json()).toMatchObject({ dealId: own.dealId, carrier: 'Дядя Рустем на микроавтобусе' })

    const alone = await postBus(other, { name: 'Такси', seats: 4 })
    expect(alone.statusCode, alone.body.slice(0, 200)).toBe(201)
    expect(alone.json()).toMatchObject({ dealId: null, carrier: null })

    // Список пары — то же, что ответ на создание: имя перевозчика у каждого маршрута.
    const list = await busesOf(other)
    expect(list.find((b) => b.id === withOwn.json().id)).toMatchObject({ carrier: 'Дядя Рустем на микроавтобусе' })
    expect(list.find((b) => b.id === alone.json().id)).toMatchObject({ dealId: null, carrier: null })
  })

  /* ── PATCH ────────────────────────────────────────────────────────── */

  it('PATCH/020: мест меньше занятых отдельных персон — 409 bus_full; правка времени — 200', async () => {
    const w = await newWedding()
    const carrier = await newVendor()
    const { dealId } = await bookVendor(w, carrier.vendorId)
    const created = await postBus(w, { name: 'Автобус №1', time: '14:30', seats: 10, dealId })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const busId = created.json().id as string

    const family = await newGuest(w, 'Ольга и Денис', true)
    const people = await peopleOf(family.token)
    expect(people).toHaveLength(2)
    for (const person of people) expect((await board(family.token, busId, person.id)).statusCode).toBe(200)

    // Две отдельные персоны занимают два места.
    const tooSmall = await patchBus(w, busId, { seats: 1 })
    expect(errorOf(tooSmall)).toEqual({ status: 409, code: 'bus_full' })
    expect(tooSmall.json().error.message).toContain('Занято 2 персоны')
    expect((await busesOf(w)).find((b) => b.id === busId)).toMatchObject({ seats: 10, taken: 2 })

    // Ровно по занятым — можно: двое сидят, мест два.
    const exact = await patchBus(w, busId, { seats: 2, time: '15:00', from: 'Гостиный двор' })
    expect(exact.statusCode, exact.body.slice(0, 200)).toBe(200)
    expect(exact.json()).toMatchObject({ id: busId, seats: 2, taken: 2, time: '15:00', from: 'Гостиный двор', dealId, carrier: carrier.name })

    /* Перевозчик из каталога узнаёт о правке из «обновлений от пар» — как
     * кейтеринг о рассадке. Строка своя: по этой свадьбе и с именем маршрута. */
    const updates = await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(carrier.token) })
    expect(updates.statusCode, updates.body.slice(0, 200)).toBe(200)
    const note = (updates.json() as { text: string; ackAt: string | null }[]).find((u) => u.text.includes('«Автобус №1»'))
    expect(note, 'заметка перевозчику о маршруте').toBeTruthy()
    expect(note!.text).toBe('Пара изменила маршрут «Автобус №1» — 2 места, сбор 15:00')
    expect(note!.ackAt).toBeNull()
  })

  it('PATCH: dealId: null снимает перевозчика; чужой маршрут и мусорный идентификатор — 404; лишнее поле — 422', async () => {
    const w = await newWedding()
    const carrier = await newVendor()
    const { dealId } = await bookVendor(w, carrier.vendorId)
    const created = await postBus(w, { name: 'Автобус №1', seats: 20, dealId })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const busId = created.json().id as string

    const detached = await patchBus(w, busId, { dealId: null })
    expect(detached.statusCode, detached.body.slice(0, 200)).toBe(200)
    expect(detached.json()).toMatchObject({ id: busId, name: 'Автобус №1', seats: 20, dealId: null, carrier: null })
    // Пропуск поля — «оставить как есть»: без dealId в теле перевозчик не возвращается и не пропадает.
    const renamed = await patchBus(w, busId, { name: 'Автобус №2' })
    expect(renamed.json()).toMatchObject({ name: 'Автобус №2', dealId: null, carrier: null })
    // Привязать обратно можно тем же полем.
    expect((await patchBus(w, busId, { dealId })).json()).toMatchObject({ dealId, carrier: carrier.name })

    const other = await newWedding()
    expect((await patchBus(other, busId, { name: 'Чужой' })).statusCode).toBe(404)
    expect((await patchBus(w, 'not-a-uuid', { name: 'Мусор' })).statusCode).toBe(404)
    expect((await patchBus(w, busId, { taken: 0 })).statusCode).toBe(422)
    expect((await busesOf(w)).find((b) => b.id === busId)).toMatchObject({ name: 'Автобус №2' })
  })

  it('PATCH: права как у POST — помощник правит маршрут и перевозчика, логистика общая работа команды', async () => {
    const w = await newWedding()
    const carrier = await newVendor()
    const { dealId } = await bookVendor(w, carrier.vendorId)
    const helper = await joinAs(w, 'helper')

    const created = await postBus(w, { name: 'Автобус №1', seats: 20 }, helper.token)
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const patched = await patchBus(w, created.json().id as string, { time: '13:00', dealId }, helper.token)
    expect(patched.statusCode, patched.body.slice(0, 200)).toBe(200)
    expect(patched.json()).toMatchObject({ time: '13:00', dealId, carrier: carrier.name })
  })

  /* ── отмена сделки и гость ────────────────────────────────────────── */

  it('отмена сделки: dealId и carrier — null, маршрут и запись гостя целы; гость видит carrier у живой сделки', async () => {
    const w = await newWedding()
    const carrier = await newVendor()
    const { dealId, slotId } = await bookVendor(w, carrier.vendorId)
    const created = await postBus(w, { name: 'Автобус №1', time: '14:30', seats: 40, dealId })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const busId = created.json().id as string

    const guest = await newGuest(w, 'Ольга')
    expect((await board(guest.token, busId)).statusCode).toBe(200)

    // Гость ищет автобус на точке сбора по имени перевозчика (В4).
    const seen = await app.inject({ method: 'GET', url: `/join/${guest.token}/shuttle` })
    expect(seen.statusCode, seen.body.slice(0, 200)).toBe(200)
    expect(seen.json().myBusId).toBe(busId)
    expect((seen.json().routes as BusRoute[]).find((r) => r.id === busId)).toMatchObject({
      name: 'Автобус №1',
      time: '14:30',
      dealId,
      carrier: carrier.name,
    })

    const cancelled = await cancelSlot(w, slotId)
    expect(cancelled.statusCode, cancelled.body.slice(0, 200)).toBe(200)

    /* Перевозчик убран — маршрут остался, гость сидит: отмена сделки не
     * должна высаживать сорок человек. */
    expect((await busesOf(w)).find((b) => b.id === busId)).toMatchObject({ name: 'Автобус №1', taken: 1, dealId: null, carrier: null })
    const after = await app.inject({ method: 'GET', url: `/join/${guest.token}/shuttle` })
    expect(after.json().myBusId).toBe(busId)
    expect((after.json().routes as BusRoute[]).find((r) => r.id === busId)).toMatchObject({ dealId: null, carrier: null })
    const { rows } = await app.db!.query('select 1 from bus_bookings where bus_id = $1 and guest_id = $2', [busId, guest.guestId])
    expect(rows).toHaveLength(1)
    /* Колонка честна, а не только ответ: дверь отмены отпускает маршруты
     * (`detachBusRoutes`), иначе указатель на убранного перевозчика жил бы в базе. */
    const { rows: col } = await app.db!.query<{ deal_id: string | null }>('select deal_id from bus_routes where id = $1', [busId])
    expect(col[0]!.deal_id, 'bus_routes.deal_id после отмены сделки').toBeNull()
  })

  /* ── кабинет перевозчика ──────────────────────────────────────────── */

  it('кабинет: busRoutes у транспортной сделки со счётчиком персон, без имён и телефонов гостей; у сделки другой категории — []', async () => {
    const w = await newWedding({ date: '2027-06-14' })
    const carrier = await newVendor()
    const { dealId } = await bookVendor(w, carrier.vendorId)
    const created = await postBus(w, { name: 'Автобус №1', from: 'Гостиный двор', time: '14:30', seats: 40, dealId })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const busId = created.json().id as string
    // Ещё один маршрут без перевозчика — в кабинет он попадать не должен.
    const alone = await postBus(w, { name: 'Микроавтобус дяди', seats: 8 })
    expect(alone.statusCode).toBe(201)

    const privacyName = `Ольга-Секретова-${RUN}`
    const privacyPhone = nextPhone()
    const guest = await newGuest(w, privacyName, true, privacyPhone)
    const familyPeople = await peopleOf(guest.token)
    expect(familyPeople).toHaveLength(2)
    for (const person of familyPeople) expect((await board(guest.token, busId, person.id)).statusCode).toBe(200)

    // Тот же перевозчик — фотографом в другой свадьбе (другая дата, чтобы не упереться в занятость).
    const other = await newWedding({ date: '2027-06-20' })
    const asPhoto = await bookVendor(other, carrier.vendorId, 'photo')

    const deals = await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(carrier.token) })
    expect(deals.statusCode, deals.body.slice(0, 200)).toBe(200)
    const items = deals.json().items as { id: string; busRoutes: unknown[] }[]
    expect(items.find((d) => d.id === dealId)).toMatchObject({
      busRoutes: [{ id: busId, name: 'Автобус №1', from: 'Гостиный двор', time: '14:30', seats: 40, taken: 2 }],
    })
    expect(items.find((d) => d.id === asPhoto.dealId)).toMatchObject({ busRoutes: [] })

    // 152-ФЗ: перевозчику — сколько мест готовить, а не кто едет.
    const raw = deals.body
    expect(raw).not.toContain(privacyName)
    expect(raw).not.toContain(privacyPhone)
    expect(raw).not.toContain('Микроавтобус дяди')
  })

  /* ── DayXBroadcast ────────────────────────────────────────────────── */

  it('DayXBroadcast: сдвиг и план Б без notifiedGuests, guestsAffected остаётся', async () => {
    const w = await newWedding()
    const g = await newGuest(w, 'Денис')
    const yes = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/guests/${g.guestId}`,
      headers: auth(w.token),
      payload: { status: 'yes' },
    })
    expect(yes.statusCode, yes.body.slice(0, 200)).toBe(200)

    const shift = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      headers: { ...auth(w.token), ...key() },
      payload: { minutes: 15 },
    })
    expect(shift.statusCode, shift.body.slice(0, 200)).toBe(200)
    const planb = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/planb/activate`,
      headers: { ...auth(w.token), ...key() },
      payload: { scenario: 'rain' },
    })
    expect(planb.statusCode, planb.body.slice(0, 200)).toBe(200)

    // Поле «всегда ноль» снято контрактом v0.30.0: числа, которое ничего не сообщает, в ответе нет.
    expect(shift.json()).toMatchObject({ minutes: 15, guestsAffected: 1 })
    expect(shift.json()).not.toHaveProperty('notifiedGuests')
    expect(planb.json()).toMatchObject({ scenario: 'rain', guestsAffected: 1 })
    expect(planb.json()).not.toHaveProperty('notifiedGuests')
  })
})
