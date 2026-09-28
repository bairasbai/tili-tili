import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { purgeArchivedWeddings } from '../src/jobs/index.js'
import { uuidv7 } from '../src/ids.js'

/**
 * Фича 005 (хвосты ревью), задание BE-A2: автобус по персонам (T011), отзыв
 * по гостю (T012), санкции и заявки под правилами базы (T014), столы
 * `PATCH`/`DELETE`, телефон и комментарий гостя только паре, `mine` у
 * отелей и `tz` у команды глазами гостя, `blocked` в анкете и `shortfall`
 * в кабинете. Каждый тест был красным до своей правки (доказательство —
 * подмена файла из `HEAD`, цитаты в отчёте).
 *
 * База общая с соседними наборами (R-177/R-226/R-227): каждый тест заводит
 * свою свадьбу и смотрит только на свои строки по своим идентификаторам —
 * никаких счётчиков общей выдачи и позиций в срезе.
 *
 * Правила базы проверяются ПРЯМЫМ SQL: если обработчик обойти, отказ всё
 * равно приходит от PostgreSQL (`23514`/`23505`) — в этом и смысл переезда
 * инвариантов в схему (CLAUDE.md §5 п. 11).
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface PgError {
  code?: string
  constraint?: string
}
/** Код и имя ограничения из ошибки PostgreSQL — ради «красного по правилу базы». */
const pgFail = async (action: Promise<unknown>): Promise<PgError> => {
  try {
    await action
    return {}
  } catch (error) {
    const e = error as PgError
    return { code: e.code, constraint: e.constraint }
  }
}

describe.skipIf(!live)('фича 005, BE-A2: автобус, отзыв гостя, столы, права, анкета, кабинет', () => {
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
        city: { name: 'Казань', region: 'Татарстан' },
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
      payload: { role, label: 'Фича 005' },
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

  /** Перевыпуск ссылки — новый токен тому же гостю. */
  async function reissue(w: Wedding, guestId: string) {
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode, link.body.slice(0, 200)).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    return (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string
  }

  async function newVendor(name = 'Фотограф') {
    const user = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `${name} ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: created.json().id as string }
  }

  async function firstSlot(w: Wedding, categoryId = 'photo') {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    return (slots.find((s) => s.categoryId === categoryId) ?? slots[0]!).id
  }

  /** Бронь подрядчика в первый слот; отдаёт сделку и слот. */
  async function bookVendor(w: Wedding, vendorId: string, amount = 5_000_000) {
    const slotId = await firstSlot(w)
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const { rows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1 and vendor_id = $2', [
      slotId,
      vendorId,
    ])
    return { dealId: rows[0]!.id, slotId }
  }

  async function newBus(w: Wedding, seats: number) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: `Автобус ${RUN}-${++counter}`, seats },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  const board = (guestToken: string, busId: string) =>
    app.inject({ method: 'POST', url: `/join/${guestToken}/shuttle`, headers: key(), payload: { busId } })

  const takenOf = async (w: Wedding, busId: string) => {
    const buses = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/logistics/buses`, headers: auth(w.token) })
    ).json() as { id: string; taken: number; seats: number }[]
    return buses.find((b) => b.id === busId)!.taken
  }

  const patchGuest = (w: Wedding, guestId: string, payload: unknown, token = w.token) =>
    app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/guests/${guestId}`, headers: auth(token), payload })

  const rsvp = (guestToken: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/rsvp/${guestToken}`, payload })

  const errorOf = (res: { statusCode: number; json: () => { error?: { code?: string; message?: string } } }) => ({
    status: res.statusCode,
    code: res.json().error?.code,
  })

  /* ── T011: автобус считает людей ──────────────────────────────────── */

  it('T011: 39 мест, 19 гостей «с +1» — taken 38, двадцатый «с +1» получает 409 bus_full', async () => {
    /* Спека (US1, сценарий 2) говорит «автобус на 20 мест, 19 гостей с +1 —
     * taken 38»: в 20 мест 38 человек не помещаются, поэтому мест 39 — все
     * девятнадцать пар сидят, двадцатой паре места нет, одиночке — есть. */
    const w = await newWedding()
    const busId = await newBus(w, 39)
    for (let i = 0; i < 19; i++) {
      const g = await newGuest(w, `Гость ${i}`, true)
      const res = await board(g.token, busId)
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    }
    // Счётчик экрана пары — персоны, а не записи: 19 × 2.
    expect(await takenOf(w, busId)).toBe(38)

    const twentieth = await newGuest(w, 'Двадцатый', true)
    expect(errorOf(await board(twentieth.token, busId))).toEqual({ status: 409, code: 'bus_full' })
    expect(await takenOf(w, busId)).toBe(38)

    // Один без «+1» — влезает на последнее место ровно как один.
    const single = await newGuest(w, 'Одиночка', false)
    expect((await board(single.token, busId)).statusCode).toBe(200)
    expect(await takenOf(w, busId)).toBe(39)
  })

  it('T011/020: legacy +1 создаёт отдельную персону и не меняет занятую автобусную бронь', async () => {
    const w = await newWedding()
    const busId = await newBus(w, 2)
    const anna = await newGuest(w, 'Анна')
    const boris = await newGuest(w, 'Борис')
    expect((await board(anna.token, busId)).statusCode).toBe(200)
    expect((await board(boris.token, busId)).statusCode).toBe(200)
    expect(await takenOf(w, busId)).toBe(2)

    const own = await rsvp(anna.token, { status: 'yes', plusOne: true })
    expect(errorOf(own)).toEqual({ status: 409, code: 'bus_full' })
    expect(await takenOf(w, busId)).toBe(2)
    const { rows } = await app.db!.query<{ plus_one: boolean }>('select plus_one from guests where id = $1', [anna.guestId])
    expect(rows[0]!.plus_one).toBe(false)
  })

  it('T011/020: прямой SQL plus_one больше не является счётчиком автобусных мест', async () => {
    const w = await newWedding()
    const busId = await newBus(w, 1)
    const anna = await newGuest(w, 'Анна')
    expect((await board(anna.token, busId)).statusCode).toBe(200)
    await app.db!.query('update guests set plus_one = true where id = $1', [anna.guestId])
    expect(await takenOf(w, busId)).toBe(1)
  })

  it('T011/020: отказ освобождает место, legacy +1 не оставляет скрытого множителя', async () => {
    const w = await newWedding()
    const busId = await newBus(w, 1)
    const anna = await newGuest(w, 'Анна')
    expect((await board(anna.token, busId)).statusCode).toBe(200)
    const res = await rsvp(anna.token, { status: 'no', plusOne: true })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(await takenOf(w, busId)).toBe(0)
    const { rows } = await app.db!.query<{ rsvp: string; plus_one: boolean }>(
      'select rsvp, plus_one from guests where id = $1',
      [anna.guestId],
    )
    expect(rows[0]).toEqual({ rsvp: 'no', plus_one: false })
  })

  it('T011: гость «с +1» на одно свободное место — ранняя 409 без отката, taken прежний', async () => {
    const w = await newWedding()
    const busId = await newBus(w, 3)
    const anna = await newGuest(w, 'Анна', true)
    expect((await board(anna.token, busId)).statusCode).toBe(200)
    expect(await takenOf(w, busId)).toBe(2)

    const pair = await newGuest(w, 'Пара гостей', true)
    expect(errorOf(await board(pair.token, busId))).toEqual({ status: 409, code: 'bus_full' })
    const alone = await newGuest(w, 'Один', false)
    expect((await board(alone.token, busId)).statusCode).toBe(200)
    expect(await takenOf(w, busId)).toBe(3)
  })

  /* ── T012: отзыв гостя ключуется гостем ───────────────────────────── */

  const leaveReview = (w: Wedding, guestToken: string, vendorId: string, stars: number) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guest-reviews?guestToken=${encodeURIComponent(guestToken)}`,
      payload: { vendorId, stars, text: 'Было здорово' },
    })

  /** Свадьба, которая уже прошла, с забронированным подрядчиком — право гостя на отзыв. */
  async function passedWeddingWithVendor() {
    const w = await newWedding()
    const vendor = await newVendor()
    await bookVendor(w, vendor.vendorId)
    await app.db!.query('update weddings set date = current_date - 1 where id = $1', [w.weddingId])
    return { w, vendor }
  }

  it('T012: отзыв → перевыпуск ссылки → второй отзыв тем же гостем — правка своего, ключ guest_id', async () => {
    const { w, vendor } = await passedWeddingWithVendor()
    const guest = await newGuest(w, 'Аня')
    expect((await leaveReview(w, guest.token, vendor.vendorId, 5)).statusCode).toBe(201)

    const token2 = await reissue(w, guest.guestId)
    expect(token2).not.toBe(guest.token)
    expect((await leaveReview(w, token2, vendor.vendorId, 3)).statusCode).toBe(201)

    const { rows } = await app.db!.query<{ guest_id: string | null; stars: number }>(
      `select guest_id, stars from reviews
        where wedding_id = $1 and vendor_id = $2 and source = 'guest'`,
      [w.weddingId, vendor.vendorId],
    )
    // Тот же гость — одна строка с его идентификатором и новой оценкой, а не второй голос.
    expect(rows).toEqual([{ guest_id: guest.guestId, stars: 3 }])
  })

  it('T012: прямой SQL второй строки с тем же (guest_id, vendor_id) — 23505', async () => {
    const { w, vendor } = await passedWeddingWithVendor()
    const guest = await newGuest(w, 'Аня')
    expect((await leaveReview(w, guest.token, vendor.vendorId, 4)).statusCode).toBe(201)

    expect(
      await pgFail(
        app.db!.query(
          `insert into reviews (id, vendor_id, wedding_id, source, guest_id, guest_token, stars)
           values ($1,$2,$3,'guest',$4,$5,1)`,
          [randomUUID(), vendor.vendorId, w.weddingId, guest.guestId, `другой-токен-${RUN}-${++counter}`],
        ),
      ),
    ).toEqual({ code: '23505', constraint: 'reviews_guest_id_vendor_id_unique_index' })
  })

  it('T012: уборка архива уносит гостя, отзыв остаётся подрядчику без guest_id', async () => {
    const { w, vendor } = await passedWeddingWithVendor()
    const guest = await newGuest(w, 'Аня')
    expect((await leaveReview(w, guest.token, vendor.vendorId, 4)).statusCode).toBe(201)
    const { rows: before } = await app.db!.query<{ id: string }>(
      'select id from reviews where guest_id = $1 and vendor_id = $2',
      [guest.guestId, vendor.vendorId],
    )
    const reviewId = before[0]!.id

    // Отмена и архив старше срока хранения — как в `audit26`.
    await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })
    await app.db!.query("update weddings set archived_at = now() - interval '900 days' where id = $1", [w.weddingId])
    await purgeArchivedWeddings(app)

    // Состояние базы, не счётчик (R-226): свадьбы и гостя нет, отзыв — есть, ключ гостя обнулён каскадом.
    expect((await app.db!.query('select 1 from guests where id = $1', [guest.guestId])).rowCount).toBe(0)
    const { rows: after } = await app.db!.query<{ guest_id: string | null; wedding_id: string | null; guest_token: string | null }>(
      'select guest_id, wedding_id, guest_token from reviews where id = $1',
      [reviewId],
    )
    expect(after).toEqual([{ guest_id: null, wedding_id: null, guest_token: guest.token }])
  })

  /* ── T014: санкции и заявки под правилами базы ────────────────────── */

  async function newStaff() {
    const user = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    return user
  }

  it('T014: санкция «block» жалобе на сообщение — 422 от обработчика, 23514 от базы прямым SQL', async () => {
    const complaintId = randomUUID()
    // Жалоба на сообщение — прямо в базу: проверяется правило, а не путь подачи.
    await app.db!.query(
      `insert into complaints (id, reporter_id, target_kind, target_id, category)
       values ($1, null, 'message', $2, 'spam')`,
      [complaintId, randomUUID()],
    )

    const staff = await newStaff()
    const res = await app.inject({
      method: 'POST',
      url: `/admin/complaints/${complaintId}`,
      headers: auth(staff.token),
      payload: { action: 'block' },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(422)

    // Обработчик обошли — база отказывает сама (CHECK стоит NOT VALID, но новые строки проверяет).
    expect(
      await pgFail(app.db!.query("update complaints set resolution = 'block' where id = $1", [complaintId])),
    ).toEqual({ code: '23514', constraint: 'complaints_resolution_by_target' })
    const { rows } = await app.db!.query<{ status: string; resolution: string | null }>(
      'select status, resolution from complaints where id = $1',
      [complaintId],
    )
    expect(rows[0]).toEqual({ status: 'new', resolution: null })
  })

  it('T014: два одновременных «Отправить» заявку на проверку — одна 201, вторая 409 verification_pending', async () => {
    const vendor = await newVendor('Проверяемый')
    const submit = () =>
      app.inject({
        method: 'POST',
        url: '/vendor/verification',
        headers: auth(vendor.token),
        payload: { kind: 'passport', fileUrl: `https://files.example/${RUN}-${++counter}.pdf` },
      })

    /* Гонка детерминированно: первая заявка вставлена, но не закоммичена —
     * проверка «уже на проверке» её не видит и проходит, а вставка второй
     * упирается в частичный уникальный индекс и ждёт коммита первой. */
    let second!: Promise<{ statusCode: number; json: () => { error?: { code?: string } } }>
    await app.db!.tx(async (client) => {
      await client.query(
        `insert into vendor_verifications (id, vendor_id, kind, file_url)
         values ($1, $2, 'passport', 'https://files.example/first.pdf')`,
        [uuidv7(), vendor.vendorId],
      )
      second = Promise.resolve().then(submit)
      await sleep(300)
    })
    const res = await second
    expect({ status: res.statusCode, code: res.json().error?.code }).toEqual({ status: 409, code: 'verification_pending' })

    // Третье нажатие после коммита — тот же 409 от проверки до вставки; в очереди одна заявка.
    expect((await submit()).statusCode).toBe(409)
    const { rows } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from vendor_verifications where vendor_id = $1 and status = 'pending'",
      [vendor.vendorId],
    )
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('T014: документ не по https — 422 схемой, 23514 базой прямым SQL', async () => {
    const vendor = await newVendor('Документный')
    const res = await app.inject({
      method: 'POST',
      url: '/vendor/verification',
      headers: auth(vendor.token),
      payload: { kind: 'passport', fileUrl: 'http://files.example/plain.pdf' },
    })
    expect(res.statusCode).toBe(422)

    expect(
      await pgFail(
        app.db!.query(
          `insert into vendor_verifications (id, vendor_id, kind, file_url)
           values ($1, $2, 'passport', 'http://files.example/plain.pdf')`,
          [uuidv7(), vendor.vendorId],
        ),
      ),
    ).toEqual({ code: '23514', constraint: 'vendor_verifications_file_url_https' })
  })

  /* ── столы: PATCH / DELETE ────────────────────────────────────────── */

  async function newTable(w: Wedding, capacity: number, name = `Стол ${RUN}-${++counter}`) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name, capacity },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  const patchTable = (w: Wedding, tableId: string, payload: unknown, token = w.token) =>
    app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/tables/${tableId}`, headers: auth(token), payload })

  const tablesOf = async (w: Wedding) =>
    (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/tables`, headers: auth(w.token) })).json() as {
      id: string
      name: string
      capacity: number
      guestIds: string[]
    }[]

  it('столы: PATCH переименовывает и меняет вместимость, ответ — стол с гостями', async () => {
    const w = await newWedding()
    const tableId = await newTable(w, 8)
    const olga = await newGuest(w, 'Ольга')
    expect((await patchGuest(w, olga.guestId, { tableId })).statusCode).toBe(200)

    const res = await patchTable(w, tableId, { name: 'Родня невесты', capacity: 6 })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(res.json()).toEqual({ id: tableId, name: 'Родня невесты', capacity: 6, guestIds: [olga.guestId] })
    expect((await tablesOf(w)).find((t) => t.id === tableId)).toMatchObject({ name: 'Родня невесты', capacity: 6 })
  })

  it('столы: вместимость считается по отдельным персонам после миграции +1', async () => {
    const w = await newWedding()
    const tableId = await newTable(w, 8)
    const pair = await newGuest(w, 'Ольга и Денис', true)
    const one = await newGuest(w, 'Марат')
    const { rows: companions } = await app.db!.query<{ id: string }>(
      `select x.id from guests x
        where x.party_id = (select party_id from guests where id = $1) and x.id <> $1`,
      [pair.guestId],
    )
    expect((await patchGuest(w, pair.guestId, { tableId })).statusCode).toBe(200)
    expect((await patchGuest(w, companions[0]!.id, { tableId })).statusCode).toBe(200)
    expect((await patchGuest(w, one.guestId, { tableId })).statusCode).toBe(200)

    // 020: три отдельные персоны сидят за столом; двух мест мало, трёх — ровно.
    expect(errorOf(await patchTable(w, tableId, { capacity: 2 }))).toEqual({ status: 409, code: 'table_full' })
    expect((await patchTable(w, tableId, { capacity: 3 })).statusCode).toBe(200)
    const table = (await tablesOf(w)).find((t) => t.id === tableId)!
    expect({ capacity: table.capacity, seated: table.guestIds.length }).toEqual({ capacity: 3, seated: 3 })
  })

  it('столы: чужой стол и мусорный идентификатор — 404, схема тела — 422', async () => {
    const mine = await newWedding()
    const other = await newWedding()
    const foreign = await newTable(other, 8)
    expect((await patchTable(mine, foreign, { name: 'Чужой' })).statusCode).toBe(404)
    expect((await patchTable(mine, 'не-uuid', { name: 'Мусор' })).statusCode).toBe(404)
    expect((await patchTable(mine, randomUUID(), { name: 'Нет такого' })).statusCode).toBe(404)
    // Стол по-прежнему называется как назвали.
    expect((await tablesOf(other)).find((t) => t.id === foreign)!.name).not.toBe('Чужой')

    const own = await newTable(mine, 8)
    expect((await patchTable(mine, own, { capacity: 0 })).statusCode).toBe(422)
    expect((await patchTable(mine, own, { seats: 5 })).statusCode).toBe(422)
    const del = await app.inject({ method: 'DELETE', url: `/weddings/${mine.weddingId}/tables/${foreign}`, headers: auth(mine.token) })
    expect(del.statusCode).toBe(404)
    expect((await tablesOf(other)).some((t) => t.id === foreign)).toBe(true)
  })

  it('столы: DELETE — 204, гости стола остаются в списке без стола', async () => {
    const w = await newWedding()
    const tableId = await newTable(w, 8)
    const keep = await newTable(w, 8)
    const olga = await newGuest(w, 'Ольга')
    const marat = await newGuest(w, 'Марат')
    expect((await patchGuest(w, olga.guestId, { tableId })).statusCode).toBe(200)
    expect((await patchGuest(w, marat.guestId, { tableId: keep })).statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/tables/${tableId}`, headers: auth(w.token) })
    expect(del.statusCode, del.body.slice(0, 200)).toBe(204)

    const tables = await tablesOf(w)
    expect(tables.some((t) => t.id === tableId)).toBe(false)
    expect(tables.find((t) => t.id === keep)!.guestIds).toEqual([marat.guestId])
    const guests = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/guests`, headers: auth(w.token) })
    ).json() as { id: string; tableId: string | null }[]
    expect(guests.find((g) => g.id === olga.guestId)!.tableId).toBeNull()
    expect(guests.find((g) => g.id === marat.guestId)!.tableId).toBe(keep)
  })

  it('столы: помощник правит и удаляет столы так же, как заводит', async () => {
    const w = await newWedding()
    const helper = await joinAs(w, 'helper')
    const tableId = await newTable(w, 8)
    expect((await patchTable(w, tableId, { name: 'Помощник переименовал' }, helper.token)).statusCode).toBe(200)
    const del = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/tables/${tableId}`, headers: auth(helper.token) })
    expect(del.statusCode).toBe(204)
  })

  /* ── права: телефон и комментарий гостя — только паре ─────────────── */

  const guestsAs = async (w: Wedding, token: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/guests`, headers: auth(token) })).json() as Record<
      string,
      unknown
    >[]

  it('права: телефон и комментарий из RSVP видит пара, помощнику и координатору — hasPhone без номера', async () => {
    const w = await newWedding()
    const helper = await joinAs(w, 'helper')
    const coordinator = await joinAs(w, 'coordinator')
    // Одиннадцать цифр: с ревью 015 телефон в форме пары нормализуется, двенадцатизначный — 422.
    const phone = `+7999${RUN}7`
    const olga = await newGuest(w, 'Ольга', false, phone)
    const marat = await newGuest(w, 'Марат')
    expect((await rsvp(olga.token, { status: 'yes', comment: 'Буду с тортом' })).statusCode).toBe(200)

    // Пара: номер, комментарий и признак — всё своё; у гостя без номера признак именно false (R-180).
    const mine = await guestsAs(w, w.token)
    expect(mine.find((g) => g.id === olga.guestId)).toMatchObject({ phone, hasPhone: true, comment: 'Буду с тортом' })
    expect(mine.find((g) => g.id === marat.guestId)).toMatchObject({ phone: null, hasPhone: false, comment: null })

    // Помощник и координатор ведут список по `hasPhone`, самих сведений не получают (152-ФЗ, минимизация).
    for (const member of [helper, coordinator]) {
      const list = await guestsAs(w, member.token)
      const seen = list.find((g) => g.id === olga.guestId)!
      expect(seen).toMatchObject({ name: 'Ольга', hasPhone: true })
      expect(seen).not.toHaveProperty('phone')
      expect(seen).not.toHaveProperty('comment')
      expect(JSON.stringify(list)).not.toContain(phone)
      expect(JSON.stringify(list)).not.toContain('Буду с тортом')
      expect(list.find((g) => g.id === marat.guestId)).toMatchObject({ hasPhone: false })
    }

    // Правка гостя помощнику разрешена — но и её ответ номера не отдаёт.
    const patched = await patchGuest(w, olga.guestId, { group: 'Родня' }, helper.token)
    expect(patched.statusCode, patched.body.slice(0, 200)).toBe(200)
    expect(patched.json()).toMatchObject({ group: 'Родня', hasPhone: true })
    expect(patched.json()).not.toHaveProperty('phone')
    expect(patched.json()).not.toHaveProperty('comment')
  })

  it('права: напомнить гостям может только пара — помощнику и координатору 403, суточное окно не тратится', async () => {
    const w = await newWedding()
    const helper = await joinAs(w, 'helper')
    const coordinator = await joinAs(w, 'coordinator')
    // Молчащий гость с телефоном и ещё не открытой ссылкой — есть кому слать.
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Ольга', phone: `+7999${RUN}8` },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id as string}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode, link.body.slice(0, 200)).toBe(200)

    const remind = (token: string) =>
      app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests/remind`, headers: auth(token) })
    expect(errorOf(await remind(helper.token))).toEqual({ status: 403, code: 'forbidden' })
    expect(errorOf(await remind(coordinator.token))).toEqual({ status: 403, code: 'forbidden' })

    // Отказ приходит ДО захвата суточного окна: пара после него рассылает как ни в чём не бывало.
    const own = await remind(w.token)
    expect(own.statusCode, own.body.slice(0, 200)).toBe(200)
    expect(own.json()).toEqual({ sent: 1, skippedNoPhone: 0, skippedLinkUsed: 0, failed: 0 })
  })

  /* ── гость: mine у отелей, tz у команды ───────────────────────────── */

  async function newHotel(w: Wedding, rooms: number) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/hotels`,
      headers: auth(w.token),
      payload: { name: `Отель ${RUN}-${++counter}`, rooms },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().id as string
  }

  const guestHotels = async (guestToken: string) =>
    (await app.inject({ method: 'GET', url: `/join/${guestToken}/hotels` })).json() as { id: string; mine: boolean }[]

  /** `id → mine` по своим блокам: ответ содержит только блоки этой свадьбы, но сверяем по идентификаторам. */
  const mineOf = (list: { id: string; mine: boolean }[], ...ids: string[]) =>
    Object.fromEntries(list.filter((h) => ids.includes(h.id)).map((h) => [h.id, h.mine]))

  it('гость: mine стоит у блока с его номером и переезжает вместе с бронью', async () => {
    const w = await newWedding()
    const first = await newHotel(w, 5)
    const second = await newHotel(w, 5)
    const olga = await newGuest(w, 'Ольга')
    const marat = await newGuest(w, 'Марат')

    // Без брони признак есть у каждого блока и он false — «не знаем» и «не мой» разные ответы (R-180).
    expect(mineOf(await guestHotels(olga.token), first, second)).toEqual({ [first]: false, [second]: false })

    const book = (token: string, hotelId: string) =>
      app.inject({ method: 'POST', url: `/join/${token}/hotels`, headers: key(), payload: { hotelId } })
    expect((await book(olga.token, first)).statusCode).toBe(200)
    expect((await book(marat.token, second)).statusCode).toBe(200)

    expect(mineOf(await guestHotels(olga.token), first, second)).toEqual({ [first]: true, [second]: false })
    // Чужая бронь своей не считается.
    expect(mineOf(await guestHotels(marat.token), first, second)).toEqual({ [first]: false, [second]: true })

    // Переезд: гость живёт в одном отеле, признак уходит за бронью.
    expect((await book(olga.token, second)).statusCode).toBe(200)
    expect(mineOf(await guestHotels(olga.token), first, second)).toEqual({ [first]: false, [second]: true })

    // Паре в её списке признака нет: он про гостя, а не про блок (контракт: только гостевой путь).
    const couple = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/logistics/hotels`, headers: auth(w.token) })
    ).json() as Record<string, unknown>[]
    expect(couple.find((h) => h.id === first)).not.toHaveProperty('mine')
  })

  it('гость: команда свадьбы приходит с поясом места — «день прошёл» считается по нему, не по телефону гостя', async () => {
    const { w, vendor } = await passedWeddingWithVendor()
    const guest = await newGuest(w, 'Аня')
    await app.db!.query("update weddings set tz = 'Asia/Vladivostok' where id = $1", [w.weddingId])

    const team = await app.inject({ method: 'GET', url: `/join/${guest.token}/team` })
    expect(team.statusCode, team.body.slice(0, 200)).toBe(200)
    expect(team.json()).toMatchObject({ weddingId: w.weddingId, tz: 'Asia/Vladivostok' })
    expect((team.json().vendors as { vendorId: string }[]).map((v) => v.vendorId)).toContain(vendor.vendorId)

    // Пояс у свадьбы не задан — тот же Europe/Moscow, по которому сервер принимает отзыв (`reviews.ts`).
    await app.db!.query('update weddings set tz = null where id = $1', [w.weddingId])
    expect((await app.inject({ method: 'GET', url: `/join/${guest.token}/team` })).json().tz).toBe('Europe/Moscow')
  })

  /* ── анкета и кабинет ─────────────────────────────────────────────── */

  it('анкета: заблокированная модератором — blocked: true владельцу, живая — false', async () => {
    const vendor = await newVendor('Блокируемый')
    const profile = async () =>
      (await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(vendor.token) })).json() as Record<string, unknown>
    // Именно false, а не отсутствие поля: «не знаем» и «не заблокирована» — разные ответы (R-180).
    expect(await profile()).toMatchObject({ published: true, blocked: false })

    // Блокировка — решением модератора по жалобе, тем же путём, что в жизни.
    const reporter = await newUser()
    const complaint = await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(reporter.token),
      payload: { targetKind: 'vendor', targetId: vendor.vendorId, category: 'no_show', text: `жалоба ${RUN}` },
    })
    expect(complaint.statusCode, complaint.body.slice(0, 200)).toBe(201)
    const { rows } = await app.db!.query<{ id: string }>(
      'select id from complaints where reporter_id = $1 and target_id = $2',
      [reporter.userId, vendor.vendorId],
    )
    const staff = await newStaff()
    const decided = await app.inject({
      method: 'POST',
      url: `/admin/complaints/${rows[0]!.id}`,
      headers: auth(staff.token),
      payload: { action: 'block' },
    })
    expect(decided.statusCode, decided.body.slice(0, 200)).toBe(200)

    expect(await profile()).toMatchObject({ blocked: true })
    // Публикация закрыта — и кабинет теперь знает, почему (D5-23).
    expect(
      errorOf(await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendor.token) })),
    ).toEqual({ status: 409, code: 'vendor_blocked' })
  })

  it('кабинет: недоплата по done — shortfall, в «ожидается» не входит; закрытая целиком — ноль', async () => {
    const vendor = await newVendor('Недоплаченный')
    const w = await newWedding()
    const { dealId, slotId } = await bookVendor(w, vendor.vendorId, 10_000_000)
    const pay = async (of: Wedding, slot: string, amount: number) => {
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${of.weddingId}/slots/${slot}/pay`,
        headers: { ...auth(of.token), ...key() },
        payload: { amount: { amount, currency: 'RUB' } },
      })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    }
    await pay(w, slotId, 6_000_000)
    await app.db!.query(`update payments set visibility='vendor' where deal_id=$1`,[dealId])

    const money = async () =>
      (await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(vendor.token) })).json() as {
        expected: { amount: number }
        shortfall: { amount: number; currency: string }
      }
    // Открытая бронь: остаток 40 000 ₽ ожидается, недоплаты ещё нет.
    expect(await money()).toMatchObject({ expected: { amount: 4_000_000 }, shortfall: { amount: 0, currency: 'RUB' } })

    // Работа сдана, а цена не закрыта: 40 000 ₽ — предмет спора, не ожидания (В7).
    const done = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: { ...auth(w.token), ...key() },
      payload: { state: 'done' },
    })
    expect(done.statusCode, done.body.slice(0, 200)).toBe(200)
    expect(await money()).toMatchObject({ expected: { amount: 0 }, shortfall: { amount: 4_000_000, currency: 'RUB' } })

    // Вторая done-сделка того же подрядчика (другая дата — та занята), закрытая платежами целиком, недоплаты не добавляет.
    const other = await newWedding({ date: '2027-06-15' })
    const second = await bookVendor(other, vendor.vendorId, 2_000_000)
    await pay(other, second.slotId, 2_000_000)
    await app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [second.dealId])
    expect(await money()).toMatchObject({ expected: { amount: 0 }, shortfall: { amount: 4_000_000, currency: 'RUB' } })
  })
})
