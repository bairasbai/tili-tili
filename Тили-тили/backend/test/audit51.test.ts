import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * F1 (ревью 016, F-RL-2-02/SA-06) — одна дверь отмены сделки `cancelDeal()`.
 *
 * На `c24d211` сделку переводили в `cancelled` три независимые реализации:
 * `slots.ts` (`cancelDealInSlot`), `deals.ts` (`PATCH /deals`) и
 * `weddingLifecycle.ts` (отмена свадьбы) — с разными побочными эффектами
 * (дверь 3 не звала `releaseLead`/`detachBusRoutes`, не гасила
 * `external_invites`, снимала занятость голым `delete` мимо
 * `releaseVendorDate`; дверь 1 не сбрасывала `negotiating_until`; дверь 2
 * отвечала `bad_transition`, а не `already_cancelled`, на повторную отмену).
 * `cancelDeal()` (`src/deals/cancel.ts`) — единственное место, которое пишет
 * `deals.state = 'cancelled'`; все четыре HTTP-двери зовут только её.
 *
 * T1-T3, T8 — дверь свадьбы (была самой неполной). T4 — дверь слота
 * (не гасила мягкую бронь). T5 — дверь `PATCH /deals` (ARB-1 = A). T6 —
 * паритет всех четырёх дверей на одном сценарии («на c24d211 краснеет дверь
 * свадьбы» — остальные три уже давали правильный результат и здесь служат
 * спецификацией, не регрессией). T7 — статический сторож «четвёртой двери».
 *
 * Каждый тест был красным до своей правки. База общая с соседними наборами
 * (R-177): каждый тест заводит свою свадьбу и смотрит только на свои строки.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('F1: одна дверь отмены сделки cancelDeal()', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259). */
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

  /** Анкета в каталоге. Имя уникально на прогон. */
  async function newVendor(name: string, categoryId: string) {
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
  async function bookVendor(w: Wedding, vendorId: string, categoryId: string) {
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

  const cancelSlot = (w: Wedding, slotId: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`,
      headers: { ...auth(w.token), ...key() },
    })

  const patchDeal = (w: Wedding, dealId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: { ...auth(w.token), ...key() },
      payload,
    })

  const cancelWedding = (w: Wedding) =>
    app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })

  const postBus = (w: Wedding, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/logistics/buses`, headers: auth(w.token), payload })

  const addExternal = (w: Wedding, slotId: string, vendorName: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
      headers: auth(w.token),
      payload: { vendorName, price: { amount: 1_500_000, currency: 'RUB' } },
    })

  const inviteExternal = (w: Wedding, slotId: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`,
      headers: auth(w.token),
    })

  /* ── T1 ───────────────────────────────────────────────────────────── */
  it('T1: отмена свадьбы возвращает лид подрядчика в replied (на c24d211 — won)', async () => {
    const w = await newWedding()
    const vendor = await newVendor('T1 Подрядчик', 'photo')
    await bookVendor(w, vendor.vendorId, 'photo')

    const cancelled = await cancelWedding(w)
    expect(cancelled.statusCode, cancelled.body.slice(0, 200)).toBe(200)

    const { rows } = await app.db!.query<{ state: string }>(
      'select state from leads where vendor_id = $1 and wedding_id = $2',
      [vendor.vendorId, w.weddingId],
    )
    expect(rows[0]!.state).toBe('replied')
  })

  /* ── T2 ───────────────────────────────────────────────────────────── */
  it('T2: отмена свадьбы обнуляет bus_routes.deal_id сделки перевозчика (прямой SQL, как audit35)', async () => {
    const w = await newWedding()
    const vendor = await newVendor('T2 Перевозчик', 'transport')
    const { dealId } = await bookVendor(w, vendor.vendorId, 'transport')
    const bus = await postBus(w, { name: 'T2 автобус', seats: 10, dealId })
    expect(bus.statusCode, bus.body.slice(0, 200)).toBe(201)
    const busId = bus.json().id as string

    const cancelled = await cancelWedding(w)
    expect(cancelled.statusCode, cancelled.body.slice(0, 200)).toBe(200)

    const { rows } = await app.db!.query<{ deal_id: string | null }>('select deal_id from bus_routes where id = $1', [
      busId,
    ])
    expect(rows[0]!.deal_id, 'bus_routes.deal_id после отмены свадьбы').toBeNull()
  })

  /* ── T3 ───────────────────────────────────────────────────────────── */
  it('T3: отмена свадьбы гасит external_invites своего подрядчика', async () => {
    const w = await newWedding()
    const slotId = await slotOf(w, 'photo')
    const created = await addExternal(w, slotId, 'T3 Свой подрядчик')
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    const link = await inviteExternal(w, slotId)
    expect(link.statusCode, link.body.slice(0, 200)).toBe(201)
    const token = link.json().token as string

    const cancelled = await cancelWedding(w)
    expect(cancelled.statusCode, cancelled.body.slice(0, 200)).toBe(200)

    const { rows } = await app.db!.query<{ revoked_at: Date | null }>(
      'select revoked_at from external_invites where token = $1',
      [token],
    )
    expect(rows[0]!.revoked_at, 'ссылка своего подрядчика после отмены свадьбы').not.toBeNull()
  })

  /* ── T4 ───────────────────────────────────────────────────────────── */
  it('T4: POST …/slots/{id}/cancel обнуляет negotiating_until (состояние — SQL, F5-11)', async () => {
    const w = await newWedding()
    const vendor = await newVendor('T4 Подрядчик', 'photo')
    const { dealId, slotId } = await bookVendor(w, vendor.vendorId, 'photo')
    await app.db!.query(
      `update deals set state = 'negotiating', negotiating_until = now() + interval '1 hour' where id = $1`,
      [dealId],
    )

    const res = await cancelSlot(w, slotId)
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)

    const { rows } = await app.db!.query<{ state: string; negotiating_until: Date | null }>(
      'select state, negotiating_until from deals where id = $1',
      [dealId],
    )
    expect(rows[0]).toMatchObject({ state: 'cancelled' })
    expect(rows[0]!.negotiating_until, 'negotiating_until после отмены слота').toBeNull()
  })

  /* ── T5 ───────────────────────────────────────────────────────────── */
  it('T5: повторная отмена через PATCH /deals — 409 already_cancelled (ARB-1 = A; на c24d211 — bad_transition)', async () => {
    const w = await newWedding()
    const vendor = await newVendor('T5 Подрядчик', 'photo')
    const { dealId } = await bookVendor(w, vendor.vendorId, 'photo')

    const first = await patchDeal(w, dealId, { state: 'cancelled' })
    expect(first.statusCode, first.body.slice(0, 200)).toBe(200)

    const second = await patchDeal(w, dealId, { state: 'cancelled' })
    expect(second.statusCode, second.body.slice(0, 200)).toBe(409)
    expect(second.json().error?.code).toBe('already_cancelled')
  })

  /* ── T6 ───────────────────────────────────────────────────────────── */
  /**
   * Общий сценарий паритета: каталожный подрядчик в слоте «Транспорт»
   * (лид `won` через `openLead`, занятая дата через `holdVendorDate`),
   * автобусный маршрут со своим `dealId`, и ссылка слота.
   *
   * Ссылка слота заведена прямым SQL, а не через `POST …/external/invite`:
   * `external_invites` привязана к `slot_id`, а не к `deal_id`
   * (`migrations/1757500000000_deals_and_money.cjs:109-118`) — слот мог
   * раньше держать своего подрядчика с живой ссылкой, а сейчас в нём
   * каталожная сделка; выдать такую ссылку через API нельзя (409
   * `not_external`, `slots.ts:513`), но как факт в базе она равноправна.
   */
  async function parityScenario(w: Wedding) {
    const vendor = await newVendor('Паритет', 'transport')
    const { dealId, slotId } = await bookVendor(w, vendor.vendorId, 'transport')
    const bus = await postBus(w, { name: 'Паритет-автобус', seats: 10, dealId })
    expect(bus.statusCode, bus.body.slice(0, 200)).toBe(201)
    const token = randomBytes(16).toString('base64url')
    await app.db!.query(
      `insert into external_invites (token, wedding_id, slot_id, expires_at)
       values ($1, $2, $3, now() + interval '30 days')`,
      [token, w.weddingId, slotId],
    )

    // Предусловия (F1-G5-04): без них проверки «лид replied» / «строка
    // vendor_busy_dates снята» в assertDoorInvariants проходили бы и на
    // пустом сценарии (лид никогда не был won, занятости никогда не было) —
    // то есть ничего не доказывали бы про отмену.
    const { rows: leadBefore } = await app.db!.query<{ state: string }>(
      'select state from leads where vendor_id = $1 and wedding_id = $2',
      [vendor.vendorId, w.weddingId],
    )
    expect(leadBefore[0]!.state, 'предусловие: лид won до отмены').toBe('won')
    const busyBefore = await app.db!.query('select 1 from vendor_busy_dates where deal_id = $1', [dealId])
    expect(busyBefore.rows, 'предусловие: занятость подрядчика проставлена до отмены').toHaveLength(1)

    return { dealId, slotId, busId: bus.json().id as string, token, vendorId: vendor.vendorId }
  }

  interface Scenario {
    dealId: string
    slotId: string
    busId: string
    token: string
    vendorId?: string
  }

  async function assertDoorInvariants(w: Wedding, s: Scenario, expectedFrom: string, checkLeadAndDate: boolean) {
    const { rows: deal } = await app.db!.query<{
      state: string
      cancelled_at: Date | null
      negotiating_until: Date | null
    }>('select state, cancelled_at, negotiating_until from deals where id = $1', [s.dealId])
    expect(deal[0]).toMatchObject({ state: 'cancelled' })
    expect(deal[0]!.cancelled_at).not.toBeNull()
    expect(deal[0]!.negotiating_until).toBeNull()

    const { rows: events } = await app.db!.query<{ from_state: string }>(
      `select from_state from deal_events where deal_id = $1 and to_state = 'cancelled'`,
      [s.dealId],
    )
    expect(events, 'ровно одно событие → cancelled').toHaveLength(1)
    expect(events[0]!.from_state).toBe(expectedFrom)

    const { rows: slot } = await app.db!.query<{ deal_id: string | null }>(
      'select deal_id from slots where id = $1',
      [s.slotId],
    )
    expect(slot[0]!.deal_id).toBeNull()

    const { rows: bus } = await app.db!.query<{ deal_id: string | null }>(
      'select deal_id from bus_routes where id = $1',
      [s.busId],
    )
    expect(bus[0]!.deal_id).toBeNull()

    const { rows: invite } = await app.db!.query<{ revoked_at: Date | null }>(
      'select revoked_at from external_invites where token = $1',
      [s.token],
    )
    expect(invite[0]!.revoked_at, 'ссылка слота должна быть погашена').not.toBeNull()

    if (checkLeadAndDate) {
      const { rows: lead } = await app.db!.query<{ state: string }>(
        'select state from leads where vendor_id = $1 and wedding_id = $2',
        [s.vendorId!, w.weddingId],
      )
      expect(lead[0]!.state).toBe('replied')

      const { rows: busy } = await app.db!.query('select 1 from vendor_busy_dates where deal_id = $1', [s.dealId])
      expect(busy, 'строка vendor_busy_dates снята').toHaveLength(0)
    }
  }

  it('T6 паритет — дверь 1: POST …/slots/{id}/cancel', async () => {
    const w = await newWedding()
    const s = await parityScenario(w)
    const res = await cancelSlot(w, s.slotId)
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    await assertDoorInvariants(w, s, 'booked', true)
  })

  it('T6 паритет — дверь 2: PATCH /deals {state: cancelled}', async () => {
    const w = await newWedding()
    const s = await parityScenario(w)
    const res = await patchDeal(w, s.dealId, { state: 'cancelled' })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    await assertDoorInvariants(w, s, 'booked', true)
  })

  it('T6 паритет — дверь 3: POST /weddings/{id}/cancel, единственная пара (на c24d211 краснеет)', async () => {
    const w = await newWedding()
    const s = await parityScenario(w)
    const res = await cancelWedding(w)
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(res.json()).toMatchObject({ state: 'cancelled', cancelledDeals: 1 })
    await assertDoorInvariants(w, s, 'booked', true)
  })

  it('T6 паритет — дверь 4: DELETE …/external, свой подрядчик', async () => {
    const w = await newWedding()
    const slotId = await slotOf(w, 'transport')
    const created = await addExternal(w, slotId, 'Паритет свой перевозчик')
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    const dealId = (created.json().deal as { id: string }).id
    const bus = await postBus(w, { name: 'Паритет-автобус-4', seats: 6, dealId })
    expect(bus.statusCode, bus.body.slice(0, 200)).toBe(201)
    const link = await inviteExternal(w, slotId)
    expect(link.statusCode, link.body.slice(0, 200)).toBe(201)
    const token = link.json().token as string

    const res = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
      headers: auth(w.token),
    })
    expect(res.statusCode).toBe(204)

    await assertDoorInvariants(w, { dealId, slotId, busId: bus.json().id as string, token }, 'booked', false)
  })

  /* ── T8 ───────────────────────────────────────────────────────────── */
  it('T8: отмена свадьбы не освобождает дату done-сделки того же подрядчика без своей строки (RF-BE-02)', async () => {
    const w = await newWedding({ date: '2027-07-01' })
    const vendor = await newVendor('T8 Подрядчик', 'photo')
    // Первый слот — держит дату первым (единственная строка vendor_busy_dates).
    const first = await bookVendor(w, vendor.vendorId, 'photo')
    // Второй слот — тот же подрядчик, та же дата, другая категория анкеты
    // в мозаике (слот и анкета нарочно не сверяются, slots.ts «book»).
    const second = await bookVendor(w, vendor.vendorId, 'video')
    // Второй слот доходит до `done` — переход через ступень разрешён.
    const toDone = await patchDeal(w, second.dealId, { state: 'done' })
    expect(toDone.statusCode, toDone.body.slice(0, 200)).toBe(200)

    const before = await app.db!.query<{ deal_id: string }>(
      'select deal_id from vendor_busy_dates where vendor_id = $1 and date = $2::date',
      [vendor.vendorId, '2027-07-01'],
    )
    expect(before.rows).toHaveLength(1)
    expect(before.rows[0]!.deal_id).toBe(first.dealId)

    const cancelled = await cancelWedding(w)
    expect(cancelled.statusCode, cancelled.body.slice(0, 200)).toBe(200)
    expect(cancelled.json()).toMatchObject({ state: 'cancelled', cancelledDeals: 1 })

    const after = await app.db!.query<{ deal_id: string }>(
      'select deal_id from vendor_busy_dates where vendor_id = $1 and date = $2::date',
      [vendor.vendorId, '2027-07-01'],
    )
    expect(after.rows, 'строку держит done-сделка — она остаётся').toHaveLength(1)
    expect(after.rows[0]!.deal_id, 'deal_id переписан на done-сделку').toBe(second.dealId)

    const { rows: doneDeal } = await app.db!.query<{ state: string }>('select state from deals where id = $1', [
      second.dealId,
    ])
    expect(doneDeal[0]!.state, 'done не трогается отменой свадьбы').toBe('done')
  })
})

/* ── T7 (статический сторож, база не нужна) ───────────────────────── */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('F1 T7: единственная дверь SQL-перехода сделки в cancelled', () => {
  it('кроме src/deals/cancel.ts никто не переводит deals.state в cancelled прямым SQL', () => {
    const cancelDoor = join('src', 'deals', 'cancel.ts')
    // Литеральный SQL-текст перехода (двери 1 и 3 на c24d211: slots.ts:77,
    // weddingLifecycle.ts:158) — и JS-строка, которой дверь 2 собирала
    // SET-часть динамического UPDATE (deals.ts:273): сама SQL-фраза туда
    // приходит только в момент исполнения, а строковый литерал — в код.
    // literalUpdate требует state сразу после SET и пропускает переставленный
    // SET (`update deals set cancelled_at = now(), state = 'cancelled'`,
    // F1-G5-01) — templateUpdateDeals/dquoteUpdateDeals ловят литерал
    // `update deals … 'cancelled'` целиком, независимо от порядка колонок,
    // отдельно для шаблонной строки и строки в двойных кавычках (одна пара
    // кавычек/бэктиков без внутренней — SQL-текст между ними не переносится).
    const literalUpdate = /set\s+state\s*=\s*'cancelled'/i
    const dynamicSetPiece = /'cancelled_at\s*=\s*now\(\)'/
    const templateUpdateDeals = /`[^`]*\bupdate\s+deals\b[^`]*'cancelled'[^`]*`/i
    const dquoteUpdateDeals = /"[^"\n]*\bupdate\s+deals\b[^"\n]*'cancelled'[^"\n]*"/i
    const offenders: string[] = []
    for (const f of tsFiles('src')) {
      if (f === cancelDoor) continue
      const text = readFileSync(f, 'utf8')
      if (
        literalUpdate.test(text) ||
        dynamicSetPiece.test(text) ||
        templateUpdateDeals.test(text) ||
        dquoteUpdateDeals.test(text)
      )
        offenders.push(f)
    }
    expect(offenders, `SQL-переход в cancelled найден вне deals/cancel.ts: ${offenders.join(', ')}`).toEqual([])
  })
})
