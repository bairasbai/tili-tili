import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { prepareShift } from './helpers/shift.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'
import { announceDealEvents, rsvpDigest } from '../src/jobs/index.js'

/**
 * Третий проход по этапу 7 — по МАТРИЦЕ УВЕДОМЛЕНИЙ плана §18.6.
 *
 * В матрице шесть строк и три столбца получателей. Подрядчику галочка
 * стоит в трёх строках, а он не участник свадьбы: рассылка по
 * `wedding_members` его не видела вовсе.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('третий проход по этапу 7: матрица §18.6', () => {
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
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    const { rows } = await app.db!.query<{ id: string }>('select id from users where phone = $1', [phone])
    return { token, userId: rows[0]!.id }
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
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  async function newVendor(name: string) {
    const user = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: created.json().id as string }
  }

  /** Бронирует слот у настоящего подрядчика — чтобы у сделки был `vendor_id`. */
  async function book(w: { token: string; weddingId: string }, vendorId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'photo') ?? slots[0]!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    return slot.id
  }

  /**
   * Разбирает журнал до конца.
   *
   * Задача берёт СТАРЕЙШИЕ события пачкой — в общей тестовой базе их
   * накопилось от соседних наборов, и одного прохода не хватит, чтобы
   * дойти до наших. В бою очередь так же вычерпывает очередь по минуте.
   */
  async function drainDealEvents() {
    let total = 0
    for (let pass = 0; pass < 50; pass++) {
      const n = await announceDealEvents(app)
      total += n
      if (n === 0) break
    }
    return total
  }

  const titlesOf = async (userId: string) =>
    (
      await app.db!.query<{ title: string }>('select title from notifications where user_id = $1', [userId])
    ).rows.map((r) => r.title)

  /* ── подрядчик в матрице ──────────────────────────────────────────── */
  it('сдвиг тайминга доходит до забронированного подрядчика', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Ведущий Артём')
    await book(w, vendor.vendorId)
    await app.db!.query(
      `update timeline_events set starts_at = now() + interval '2 hours', ends_at = now() + interval '3 hours', duration_minutes=60
        where wedding_id = $1`,
      [w.weddingId],
    )
    await app.db!.query(`insert into timeline_assignments(wedding_id,event_id,role,kind,reference_id)
      select $1,t.id,'responsible','deal',d.id from timeline_events t join deals d on d.wedding_id=t.wedding_id
      where t.wedding_id=$1 and d.vendor_id=$2 order by t.sort limit 1`, [w.weddingId, vendor.vendorId])

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/shift`,
      ...await prepareShift(app, w.weddingId, { ...auth(w.token), ...key() }, 15),
    })
    expect(res.statusCode).toBe(200)

    // §13.2: `timeline.shifted` обязан дойти до забронированных, иначе
    // ведущий приедет к прежнему времени. Подрядчик не участник свадьбы,
    // и рассылка по `wedding_members` его не видела вовсе.
    expect(await titlesOf(vendor.userId)).toContain('Тайминг сдвинут')
  })

  it('план Б доходит до подрядчика тоже', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Фотограф Лена')
    await book(w, vendor.vendorId)

    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/planb/activate`,
      headers: { ...auth(w.token), ...key() },
      payload: { scenario: 'rain' },
    })
    expect(await titlesOf(vendor.userId)).toContain('Активирован план Б')
  })

  it('незабронированный подрядчик чужих новостей не получает', async () => {
    const w = await newWedding()
    const stranger = await newVendor('Посторонний')
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/planb/activate`,
      headers: { ...auth(w.token), ...key() },
      payload: { scenario: 'rain' },
    })
    expect(await titlesOf(stranger.userId)).toEqual([])
  })

  /* ── смена статуса сделки ─────────────────────────────────────────── */
  it('о смене статуса сделки узнают и пара, и подрядчик', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Флорист Оля')
    await book(w, vendor.vendorId)

    // Рассылка идёт по журналу переходов: состояние меняется в четырёх
    // местах, и вызов в каждом — четыре места, где о ней можно забыть.
    expect(await drainDealEvents()).toBeGreaterThanOrEqual(1)
    expect(await titlesOf(vendor.userId)).toContain('Дата забронирована')

    // Повтор задачи пуст: отметка `notified_at` уже стоит.
    const before = (await titlesOf(vendor.userId)).length
    await drainDealEvents()
    expect((await titlesOf(vendor.userId)).length).toBe(before)
  })

  it('истечение брони само становится новостью, без отдельной рассылки', async () => {
    const w = await newWedding()
    const vendor = await newVendor('Кейтеринг Дом')
    const slotId = await book(w, vendor.vendorId)
    await drainDealEvents()

    // Возвращаем сделку в мягкую бронь с истёкшим сроком и снимаем её так,
    // как это делает фоновая задача.
    await app.db!.query(
      `update deals set state = 'negotiating', negotiating_until = now() - interval '1 hour'
        where slot_id = $1`,
      [slotId],
    )
    const { rows: deal } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [slotId])
    await app.db!.query(
      `insert into deal_events (id, deal_id, from_state, to_state, note)
       values ($1,$2,'negotiating','candidate','истёк срок мягкой брони')`,
      [uuidv7(), deal[0]!.id],
    )

    await drainDealEvents()
    // Раздел 5 требует «push паре и подрядчику» — раньше истечение брони
    // не сообщало никому.
    expect(await titlesOf(vendor.userId)).toContain('Сделка вернулась к статусу «Не связывались»')
    expect(await titlesOf(w.userId)).toContain('Сделка вернулась к статусу «Не связывались»')
  })

  /* ── сводка по гостям ─────────────────────────────────────────────── */
  it('ответы гостей приходят сводкой раз в день, а не по одному', async () => {
    const w = await newWedding()
    const tokens: string[] = []
    for (const name of ['Аня', 'Борис', 'Вера']) {
      const created = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/guests`,
        headers: auth(w.token),
        payload: { name },
      })
      const link = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
        headers: auth(w.token),
      })
      const code = (link.json().url as string).split('/').pop()!
      const opened = await app.inject({ method: 'GET', url: `/invite/${code}` })
      tokens.push(opened.json().guestToken as string)
    }
    await app.inject({ method: 'POST', url: `/rsvp/${tokens[0]}`, payload: { status: 'yes' } })
    await app.inject({ method: 'POST', url: `/rsvp/${tokens[1]}`, payload: { status: 'yes' } })
    await app.inject({ method: 'POST', url: `/rsvp/${tokens[2]}`, payload: { status: 'no' } })

    // Ни одного уведомления на сам ответ: на свадьбе полторы сотни гостей,
    // и письмо на каждое «приду» — способ заставить пару выключить всё.
    expect(await titlesOf(w.userId)).not.toContain('Ответы гостей за сутки')

    expect(await rsvpDigest(app)).toBeGreaterThanOrEqual(1)
    const { rows } = await app.db!.query<{ body: string }>(
      "select body from notifications where user_id = $1 and title = 'Ответы гостей за сутки'",
      [w.userId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toBe('Придут: 2. Не смогут: 1.')
  })

  it('свадьба без свежих ответов сводку не получает', async () => {
    const w = await newWedding()
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Молчун' },
    })
    await rsvpDigest(app)
    expect(await titlesOf(w.userId)).not.toContain('Ответы гостей за сутки')
  })
})
