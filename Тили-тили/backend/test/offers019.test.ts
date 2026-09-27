/**
 * 019 / US2: запросы предложений и ответы подрядчиков (T022).
 *
 * Тесты написаны до маршрутов T023–T025. Без TEST_DATABASE_URL они
 * пропускаются, а с живой базой до реализации должны быть красными:
 * ложнозелёных проверок через прямую вставку ответа здесь нет.
 *
 * Гонки лимитов идут на прогретом пуле (R-271/R-317), а итог
 * доказывают строки и уведомления, не только пара HTTP-кодов.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface UserFixture {
  id: string
  token: string
}

interface WeddingFixture extends UserFixture {
  weddingId: string
  date: string
}

interface VendorFixture extends UserFixture {
  vendorId: string
  name: string
  packageId: string
  packageName: string
}

interface RequestResult {
  entryId: string
  status: 'sent' | 'not_shortlisted' | 'busy' | 'already_open' | 'unavailable' | 'category_changed'
  requestId?: string
}

interface OfferResponse {
  id: string
  requestId: string
  kind: 'offer' | 'decline'
  packageId: string | null
  title: string | null
  price: { amount: number; currency: 'RUB' } | null
  includes: string[]
  message: string | null
  validUntil: string | null
}

interface VendorRequest {
  id: string
  status: string
  closeReason?: string | null
  weddingDate: string | null
  guests: number | null
  city: string | null
  wishes: string | null
  budgetHint?: { amount: number; currency: string } | null
}

interface NotificationRow {
  id: string
  kind: string
  title: string
  body: string
  link: string | null
}

interface OfferRow {
  id: string
  request_id: string
  kind: 'offer' | 'decline'
  package_id: string | null
  package_snapshot: Record<string, unknown> | null
  title: string | null
  price: string | null
  currency: string
  includes: string[]
  message: string | null
  valid_until: string | null
  superseded_at: Date | null
  accepted_at: Date | null
  deal_id: string | null
  created_by: string | null
  created_at: Date
}

describe.skipIf(!live)('019 / US2: запросы и предложения', () => {
  let app: FastifyInstance
  let counter = 0
  let vendorCounter = 0
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUsers: string[] = []

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const idem = (token: string, key = randomUUID()) => ({ ...auth(token), 'idempotency-key': key })
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`

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
    if (!app) return
    /* Владельцы свадеб создаются раньше подрядчиков своих
     * сценариев: прямой порядок сначала удаляет каскад свадьбы. */
    const failures: unknown[] = []
    try {
      for (const id of createdUsers) {
        try {
          await app.db!.tx((client) => eraseUser(client, id))
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await app.db!.query('delete from otp_codes where phone like $1', [`+79${RUN}%`])
      } catch (error) {
        failures.push(error)
      }
    } finally {
      await app?.close()
    }
    if (failures.length > 0) throw new AggregateError(failures, 'не все фикстуры offers019 очищены')
  })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10_000; i++) {
      const code = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, code) === rows[0]!.code_hash) return code
    }
    throw new Error('код не подобрался')
  }

  async function newUser(): Promise<UserFixture> {
    const phone = nextPhone()
    const requested = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(requested.statusCode, requested.body).toBe(200)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(verified.statusCode, verified.body).toBe(200)
    const body = verified.json() as { accessToken: string; user: { id: string } }
    const consent = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    expect(consent.statusCode, consent.body).toBe(201)
    createdUsers.push(body.user.id)
    return { id: body.user.id, token: body.accessToken }
  }

  async function newWedding(date = '2034-06-14', guestsPlanned = 88): Promise<WeddingFixture> {
    const user = await newUser()
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Уфа', region: 'Башкортостан' },
        guestsPlanned,
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    return { ...user, weddingId: created.json().id as string, date }
  }

  async function newVendor(categoryId = 'photo'): Promise<VendorFixture> {
    /* Номер фиксируем до первого await: параллельные newVendor()
     * иначе читали общий counter уже после чужих await. */
    const vendorSeq = ++vendorCounter
    const user = await newUser()
    const name = `Подрядчик ${RUN}-${vendorSeq}`
    const packageName = `Пакет ${RUN}-${vendorSeq}`
    const saved = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
        portfolioUrls: [`https://example.com/${RUN}-${vendorSeq}.jpg`],
        priceFrom: { amount: 8_000_000, currency: 'RUB' },
        packages: [
          {
            name: packageName,
            price: { amount: 10_000_000, currency: 'RUB' },
            includes: ['8 часов', 'Ретушь'],
          },
        ],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const published = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    expect(published.statusCode, published.body).toBe(200)
    const body = saved.json() as { id: string; packages: { id: string; name: string }[] }
    return { ...user, vendorId: body.id, name, packageId: body.packages[0]!.id, packageName }
  }

  async function member(wedding: WeddingFixture, role: 'helper' | 'coordinator'): Promise<UserFixture> {
    const user = await newUser()
    const issued = await app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/invites`,
      headers: auth(wedding.token),
      payload: { role, label: `019-${role}` },
    })
    expect(issued.statusCode, issued.body).toBe(201)
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${issued.json().code as string}/accept`,
      headers: auth(user.token),
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    return user
  }

  async function slotOf(wedding: WeddingFixture, categoryId = 'photo'): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: `/weddings/${wedding.weddingId}/slots`,
      headers: auth(wedding.token),
    })
    expect(response.statusCode, response.body).toBe(200)
    const slots = response.json() as { id: string; categoryId: string }[]
    const slot = slots.find((item) => item.categoryId === categoryId)
    if (!slot) throw new Error(`нет слота ${categoryId}`)
    return slot.id
  }

  const addCandidate = (wedding: WeddingFixture, vendor: VendorFixture) =>
    app.inject({
      method: 'PUT',
      url: `/weddings/${wedding.weddingId}/shortlist/${vendor.vendorId}`,
      headers: auth(wedding.token),
    })

  const requestOffers = (
    wedding: WeddingFixture,
    slotId: string,
    entryIds: string[],
    key = randomUUID(),
    extra: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/slots/${slotId}/offer-requests`,
      headers: idem(wedding.token, key),
      payload: { entryIds, ...extra },
    })

  const answer = (
    vendor: VendorFixture,
    requestId: string,
    payload: Record<string, unknown>,
    key = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: `/vendor/offer-requests/${requestId}/offers`,
      headers: idem(vendor.token, key),
      payload,
    })

  const customOffer = (number: number) => ({
    kind: 'offer',
    title: `Версия ${number}`,
    price: { amount: 11_000_000 + number, currency: 'RUB' },
    includes: [`Пункт ${number}`],
    message: `Сообщение ${number}`,
    validUntil: '2034-06-01',
  })

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

  const hasExactKeys = (value: Record<string, unknown>, expected: string[]) =>
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())

  function requestResults(value: unknown): RequestResult[] {
    if (!Array.isArray(value)) throw new Error('итоги batch обязаны быть массивом')
    const statuses: RequestResult['status'][] = [
      'sent',
      'not_shortlisted',
      'busy',
      'already_open',
      'unavailable',
      'category_changed',
    ]
    for (const item of value) {
      if (!isRecord(item) || typeof item.entryId !== 'string' || !statuses.includes(item.status as RequestResult['status'])) {
        throw new Error('невалидный итог batch')
      }
      const keys = item.status === 'sent' ? ['entryId', 'requestId', 'status'] : ['entryId', 'status']
      if (!hasExactKeys(item, keys) || (item.status === 'sent' && typeof item.requestId !== 'string')) {
        throw new Error('итог batch имеет неверную форму')
      }
    }
    return value as RequestResult[]
  }

  function successResultsOf(response: { json: () => unknown }): RequestResult[] {
    const body = response.json()
    if (!isRecord(body) || !hasExactKeys(body, ['results'])) {
      throw new Error('успешный batch обязан вернуть { results: [] }')
    }
    return requestResults(body.results)
  }

  function errorResultsOf(response: { json: () => unknown }): RequestResult[] {
    const body = response.json()
    if (!isRecord(body) || !hasExactKeys(body, ['error']) || !isRecord(body.error)) {
      throw new Error('отказ batch обязан вернуть error.details.results')
    }
    const error = body.error
    if (
      !hasExactKeys(error, ['code', 'details', 'message'])
      || error.code !== 'no_request_sent'
      || typeof error.message !== 'string'
      || !isRecord(error.details)
      || !hasExactKeys(error.details, ['results'])
    ) {
      throw new Error('no_request_sent обязан иметь точный envelope error.{code,message,details.{results}}')
    }
    return requestResults(error.details.results)
  }

  function offerOf(response: { json: () => unknown }): OfferResponse {
    const body = response.json()
    const keys = ['id', 'requestId', 'kind', 'packageId', 'title', 'price', 'includes', 'message', 'validUntil']
    if (!isRecord(body) || !hasExactKeys(body, keys)) {
      throw new Error('успешный ответ подрядчика обязан вернуть точную форму Offer')
    }
    if (
      typeof body.id !== 'string'
      || body.id.length === 0
      || typeof body.requestId !== 'string'
      || body.requestId.length === 0
      || (body.kind !== 'offer' && body.kind !== 'decline')
      || (body.packageId !== null && typeof body.packageId !== 'string')
      || (body.title !== null && typeof body.title !== 'string')
      || !Array.isArray(body.includes)
      || !body.includes.every((item) => typeof item === 'string')
      || (body.message !== null && typeof body.message !== 'string')
      || (body.validUntil !== null && typeof body.validUntil !== 'string')
    ) {
      throw new Error('Offer содержит поле неверного типа')
    }
    if (body.price !== null) {
      if (
        !isRecord(body.price)
        || !hasExactKeys(body.price, ['amount', 'currency'])
        || !Number.isSafeInteger(body.price.amount)
        || body.price.currency !== 'RUB'
      ) {
        throw new Error('Offer.price обязан быть Money в RUB')
      }
    }
    if (body.kind === 'offer') {
      if (typeof body.title !== 'string' || body.price === null || typeof body.validUntil !== 'string') {
        throw new Error('kind=offer обязан вернуть title, price и validUntil')
      }
    } else if (
      body.packageId !== null
      || body.title !== null
      || body.price !== null
      || body.includes.length !== 0
      || body.validUntil !== null
    ) {
      throw new Error('kind=decline обязан вернуть нулевые поля предложения')
    }
    return body as unknown as OfferResponse
  }

  function createdOfferOf(
    response: { json: () => unknown },
    requestId: string,
    kind: OfferResponse['kind'],
  ): OfferResponse {
    const body = offerOf(response)
    expect(body.requestId).toBe(requestId)
    expect(body.kind).toBe(kind)
    return body
  }

  function vendorItems(response: { json: () => unknown }): VendorRequest[] {
    const body = response.json()
    if (!Array.isArray(body)) throw new Error('кабинет обязан вернуть bare array')
    return body as VendorRequest[]
  }

  const vendorRequests = (vendor: VendorFixture) =>
    app.inject({ method: 'GET', url: '/vendor/offer-requests', headers: auth(vendor.token) })

  async function requestIdFor(slotId: string, vendorId: string): Promise<string> {
    const { rows } = await app.db!.query<{ id: string }>(
      `select id from offer_requests
        where slot_id = $1 and vendor_id = $2 and status = 'open'
        order by created_at desc limit 1`,
      [slotId, vendorId],
    )
    if (!rows[0]) throw new Error('открытый запрос не создан')
    return rows[0].id
  }

  async function offerRows(requestId: string): Promise<OfferRow[]> {
    const { rows } = await app.db!.query<OfferRow>(
      `select id, request_id, kind, package_id, package_snapshot, title, price::text as price, currency, includes,
              message, valid_until::text as valid_until, superseded_at, accepted_at, deal_id, created_by, created_at
         from offers where request_id = $1 order by created_at, id`,
      [requestId],
    )
    return rows
  }

  async function notifications(userId: string): Promise<NotificationRow[]> {
    const { rows } = await app.db!.query<NotificationRow>(
      `select id, kind, title, body, link from notifications
        where user_id = $1 order by created_at, id`,
      [userId],
    )
    return rows
  }

  async function recentRequestCount(weddingId: string): Promise<number> {
    const { rows } = await app.db!.query<{ n: number }>(
      `select count(*)::int as n from offer_requests r
        join slots s on s.id = r.slot_id
       where s.wedding_id = $1 and r.created_at > now() - interval '24 hours'`,
      [weddingId],
    )
    return rows[0]!.n
  }

  async function seedClosedRequests(
    wedding: WeddingFixture,
    slotId: string,
    vendorId: string,
    count: number,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      await app.db!.query(
        `insert into offer_requests
          (id, slot_id, vendor_id, status, close_reason, closed_at, wedding_date,
           guests, city, wishes, created_by, created_at)
         values ($1, $2, $3, 'closed', 'removed', now(), $4, 88, 'Уфа', 'история', $5,
                 now() - interval '5 minutes')`,
        [randomUUID(), slotId, vendorId, wedding.date, wedding.id],
      )
    }
  }

  /** Холодный пул сам сериализует залп и маскирует гонку. */
  async function warmPool(): Promise<void> {
    await Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.2)')))
  }

  /** Успех гонки доказывается фактом ожидания замка, а не таймером (R-316). */
  async function waitForBlockedBy(
    client: Queryable,
    holderPid: number,
    expected: number,
    timeoutMs = 5_000,
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await client.query('select pg_stat_clear_snapshot()')
      const { rows } = await client.query<{ query: string }>(
        `select query from pg_stat_activity
          where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,
        [holderPid],
      )
      if (rows.length >= expected) return rows.map((row) => row.query)
      if (Date.now() > deadline) {
        throw new Error(`за контрольным замком не встали ${expected} запроса`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('один запрос двум кандидатам: каждый видит только свой снимок', async () => {
    const wedding = await newWedding()
    const [first, second] = await Promise.all([newVendor(), newVendor()])
    const added = await Promise.all([addCandidate(wedding, first), addCandidate(wedding, second)])
    expect(added.map((response) => response.statusCode)).toEqual([200, 200])
    const slotId = added[0]!.json().slotId as string
    const entryIds = added.map((response) => response.json().id as string)
    const before = await Promise.all([notifications(first.id), notifications(second.id)])

    const wishes = `Снимок условий ${RUN}`
    const sent = await requestOffers(wedding, slotId, entryIds, randomUUID(), {
      wishes,
      budgetHint: { amount: 12_345_678, currency: 'RUB' },
    })
    expect(sent.statusCode, sent.body).toBe(201)
    const sentResults = successResultsOf(sent)
    expect(sentResults).toHaveLength(2)
    expect(Object.fromEntries(sentResults.map((item) => [item.entryId, item.status]))).toEqual({
      [entryIds[0]!]: 'sent',
      [entryIds[1]!]: 'sent',
    })

    const firstId = await requestIdFor(slotId, first.vendorId)
    const secondId = await requestIdFor(slotId, second.vendorId)
    expect(Object.fromEntries(sentResults.map((item) => [item.entryId, item.requestId]))).toEqual({
      [entryIds[0]!]: firstId,
      [entryIds[1]!]: secondId,
    })
    const { rows: snapshots } = await app.db!.query<{
      id: string
      vendor_id: string
      wedding_date: string
      guests: number
      city: string
      wishes: string
      budget_hint: string
      currency: string
      created_by: string
    }>(
      `select id, vendor_id, wedding_date::text as wedding_date, guests, city, wishes,
              budget_hint::text as budget_hint, currency, created_by
         from offer_requests where id = any($1::uuid[]) order by vendor_id`,
      [[firstId, secondId]],
    )
    expect(snapshots).toHaveLength(2)
    expect(Object.fromEntries(snapshots.map((row) => [row.vendor_id, row]))).toEqual({
      [first.vendorId]: {
        id: firstId,
        vendor_id: first.vendorId,
        wedding_date: wedding.date,
        guests: 88,
        city: 'Уфа',
        wishes,
        budget_hint: '12345678',
        currency: 'RUB',
        created_by: wedding.id,
      },
      [second.vendorId]: {
        id: secondId,
        vendor_id: second.vendorId,
        wedding_date: wedding.date,
        guests: 88,
        city: 'Уфа',
        wishes,
        budget_hint: '12345678',
        currency: 'RUB',
        created_by: wedding.id,
      },
    })

    const { rows: [otherCity] } = await app.db!.query<{ id: number; name: string }>(
      `select id, name from cities where name <> 'Уфа' order by id limit 1`,
    )
    expect(otherCity).toBeDefined()
    await app.db!.query('update weddings set guests_planned = 777, city_id = $2 where id = $1', [
      wedding.weddingId,
      otherCity!.id,
    ])

    const firstList = await vendorRequests(first)
    const secondList = await vendorRequests(second)
    expect(firstList.statusCode, firstList.body).toBe(200)
    expect(secondList.statusCode, secondList.body).toBe(200)
    const firstItems = vendorItems(firstList)
    const secondItems = vendorItems(secondList)
    expect(firstItems).toHaveLength(1)
    expect(secondItems).toHaveLength(1)
    expect(firstItems[0]).toMatchObject({
      id: firstId,
      status: 'open',
      weddingDate: wedding.date,
      guests: 88,
      city: 'Уфа',
      wishes,
      budgetHint: { amount: 12_345_678, currency: 'RUB' },
    })
    expect(secondItems[0]).toMatchObject({
      id: secondId,
      status: 'open',
      weddingDate: wedding.date,
      guests: 88,
      city: 'Уфа',
      wishes,
      budgetHint: { amount: 12_345_678, currency: 'RUB' },
    })
    expect(firstList.body).not.toContain(otherCity!.name)
    expect(secondList.body).not.toContain(otherCity!.name)
    expect(JSON.stringify(firstItems)).not.toContain(secondId)
    expect(JSON.stringify(firstItems)).not.toContain(second.vendorId)
    expect(JSON.stringify(firstItems)).not.toContain(second.name)
    expect(JSON.stringify(secondItems)).not.toContain(firstId)
    expect(JSON.stringify(secondItems)).not.toContain(first.vendorId)
    expect(JSON.stringify(secondItems)).not.toContain(first.name)

    const after = await Promise.all([notifications(first.id), notifications(second.id)])
    expect(after[0]).toHaveLength(before[0].length + 1)
    expect(after[1]).toHaveLength(before[1].length + 1)
    expect(after[0].at(-1)?.kind).toBe('deal')
    expect(after[1].at(-1)?.kind).toBe('deal')
    expect(after[0].at(-1)?.link).toBe('/vendor/offer-requests')
    expect(after[1].at(-1)?.link).toBe('/vendor/offer-requests')
    const firstNoticeText = JSON.stringify({
      title: after[0].at(-1)!.title,
      body: after[0].at(-1)!.body,
      link: after[0].at(-1)!.link,
    })
    const secondNoticeText = JSON.stringify({
      title: after[1].at(-1)!.title,
      body: after[1].at(-1)!.body,
      link: after[1].at(-1)!.link,
    })
    for (const foreign of [entryIds[1]!, secondId, second.vendorId, second.name]) {
      expect(firstNoticeText).not.toContain(foreign)
    }
    for (const foreign of [entryIds[0]!, firstId, first.vendorId, first.name]) {
      expect(secondNoticeText).not.toContain(foreign)
    }
  }, 60_000)

  it('занятому не шлёт, свободному шлёт; ноль успехов даёт route-specific 409', async () => {
    const wedding = await newWedding('2035-07-19')
    const [busy, free] = await Promise.all([newVendor(), newVendor()])
    const added = await Promise.all([addCandidate(wedding, busy), addCandidate(wedding, free)])
    expect(added.map((response) => response.statusCode)).toEqual([200, 200])
    const slotId = added[0]!.json().slotId as string
    const entryIds = added.map((response) => response.json().id as string)

    const otherWedding = await newWedding(wedding.date)
    const otherSlot = await slotOf(otherWedding)
    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${otherWedding.weddingId}/slots/${otherSlot}/book`,
      headers: idem(otherWedding.token),
      payload: { vendorId: busy.vendorId, price: { amount: 9_000_000, currency: 'RUB' } },
    })
    expect(booked.statusCode, booked.body).toBe(200)
    const beforeBusy = (await notifications(busy.id)).length
    const beforeFree = (await notifications(free.id)).length

    const partial = await requestOffers(wedding, slotId, entryIds)
    expect(partial.statusCode, partial.body).toBe(201)
    const partialResults = successResultsOf(partial)
    expect(partialResults).toHaveLength(2)
    expect(Object.fromEntries(partialResults.map((item) => [item.entryId, item.status]))).toEqual({
      [entryIds[0]!]: 'busy',
      [entryIds[1]!]: 'sent',
    })
    const { rows: opened } = await app.db!.query<{ vendor_id: string }>(
      `select vendor_id from offer_requests where slot_id = $1 and status = 'open' order by vendor_id`,
      [slotId],
    )
    expect(opened.map((row) => row.vendor_id)).toEqual([free.vendorId])
    expect(await notifications(busy.id)).toHaveLength(beforeBusy)
    const freeAfter = await notifications(free.id)
    expect(freeAfter).toHaveLength(beforeFree + 1)
    expect(freeAfter.at(-1)).toMatchObject({ kind: 'deal', link: '/vendor/offer-requests' })

    const none = await requestOffers(wedding, slotId, entryIds)
    expect(none.statusCode, none.body).toBe(409)
    expect((none.json() as { error: { code: string } }).error.code).toBe('no_request_sent')
    const noneResults = errorResultsOf(none)
    expect(noneResults).toHaveLength(2)
    expect(Object.fromEntries(noneResults.map((item) => [item.entryId, item.status]))).toEqual({
      [entryIds[0]!]: 'busy',
      [entryIds[1]!]: 'already_open',
    })
    expect(await notifications(busy.id)).toHaveLength(beforeBusy)
    expect(await notifications(free.id)).toHaveLength(beforeFree + 1)
  }, 60_000)

  it('no_request_sent освобождает ключ; повтор исполняется, а успех replay-ится', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const key = randomUUID()
    await app.db!.query("update weddings set tz = 'Asia/Vladivostok' where id = $1", [wedding.weddingId])
    await app.db!.query('update vendors set blocked_at = now() where id = $1', [vendor.vendorId])
    const noticesBefore = (await notifications(vendor.id)).length

    const refused = await requestOffers(wedding, slotId, [entryId], key)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.headers['idempotent-replay']).toBeUndefined()
    expect(errorResultsOf(refused)).toEqual([{ entryId, status: 'unavailable' }])
    expect(await recentRequestCount(wedding.weddingId)).toBe(0)
    expect(await notifications(vendor.id)).toHaveLength(noticesBefore)

    await app.db!.query('update vendors set blocked_at = null where id = $1', [vendor.vendorId])
    const retried = await requestOffers(wedding, slotId, [entryId], key)
    expect(retried.statusCode, retried.body).toBe(201)
    expect(retried.headers['idempotent-replay']).toBeUndefined()
    const retriedResults = successResultsOf(retried)
    expect(retriedResults).toHaveLength(1)
    expect(retriedResults[0]).toMatchObject({ entryId, status: 'sent', requestId: expect.any(String) })
    expect(await recentRequestCount(wedding.weddingId)).toBe(1)
    expect(await notifications(vendor.id)).toHaveLength(noticesBefore + 1)

    const replay = await requestOffers(wedding, slotId, [entryId], key)
    expect(replay.statusCode, replay.body).toBe(201)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.json()).toEqual(retried.json())
    expect(await recentRequestCount(wedding.weddingId)).toBe(1)
    expect(await notifications(vendor.id)).toHaveLength(noticesBefore + 1)

    const requestId = retriedResults[0]!.requestId!
    const localDefault = async () => {
      const { rows } = await app.db!.query<{ value: string }>(
        `select ((now() at time zone coalesce(tz, 'Europe/Moscow'))::date + 7)::text as value
           from weddings where id = $1`,
        [wedding.weddingId],
      )
      return rows[0]!.value
    }
    const defaultBefore = await localDefault()
    const offered = await answer(vendor, requestId, {
      kind: 'offer',
      title: 'Без явного срока',
      price: { amount: 11_000_000, currency: 'RUB' },
      includes: ['Съёмка'],
    })
    const defaultAfter = await localDefault()
    expect(offered.statusCode, offered.body).toBe(201)
    expect([defaultBefore, defaultAfter]).toContain(createdOfferOf(offered, requestId, 'offer').validUntil)
  }, 60_000)

  it('повтор запроса с тем же ключом не дублирует строку и уведомление', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const key = randomUUID()
    const before = (await notifications(vendor.id)).length
    const call = () => requestOffers(wedding, slotId, [entryId], key, { wishes: 'Без бюджета' })

    const first = await call()
    const replay = await call()
    expect(first.statusCode, first.body).toBe(201)
    expect(replay.statusCode, replay.body).toBe(201)
    expect(successResultsOf(first)).toHaveLength(1)
    expect(successResultsOf(replay)).toHaveLength(1)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.json()).toEqual(first.json())
    const { rows } = await app.db!.query<{ n: number; budget_is_null: boolean }>(
      `select count(*)::int as n, bool_and(budget_hint is null) as budget_is_null
         from offer_requests where slot_id = $1 and vendor_id = $2`,
      [slotId, vendor.vendorId],
    )
    expect(rows[0]).toEqual({ n: 1, budget_is_null: true })
    const after = await notifications(vendor.id)
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)).toMatchObject({ kind: 'deal', link: '/vendor/offer-requests' })
  })

  it('десятый запрос проходит, replay при count=10 проходит, новый ключ даёт 429', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    await seedClosedRequests(wedding, slotId, vendor.vendorId, 9)
    expect(await recentRequestCount(wedding.weddingId)).toBe(9)
    const before = (await notifications(vendor.id)).length
    const boundaryKey = randomUUID()

    const tenth = await requestOffers(wedding, slotId, [entryId], boundaryKey)
    expect(tenth.statusCode, tenth.body).toBe(201)
    expect(successResultsOf(tenth)).toHaveLength(1)
    expect(await recentRequestCount(wedding.weddingId)).toBe(10)
    const afterTenth = await notifications(vendor.id)
    expect(afterTenth).toHaveLength(before + 1)
    expect(afterTenth.at(-1)).toMatchObject({ kind: 'deal', link: '/vendor/offer-requests' })

    const replay = await requestOffers(wedding, slotId, [entryId], boundaryKey)
    expect(replay.statusCode, replay.body).toBe(201)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.json()).toEqual(tenth.json())
    expect(successResultsOf(replay)).toHaveLength(1)
    expect(await recentRequestCount(wedding.weddingId)).toBe(10)
    expect(await notifications(vendor.id)).toHaveLength(before + 1)

    const refused = await requestOffers(wedding, slotId, [entryId], randomUUID())
    expect(refused.statusCode, refused.body).toBe(429)
    expect((refused.json() as { error: { code: string } }).error.code).toBe('offer_requests_limit')
    expect(refused.headers['retry-after']).toBeUndefined()
    expect(await recentRequestCount(wedding.weddingId)).toBe(10)
    expect(await notifications(vendor.id)).toHaveLength(before + 1)
    const { rows: opened } = await app.db!.query<{ n: number }>(
      `select count(*)::int as n from offer_requests
        where slot_id = $1 and vendor_id = $2 and status = 'open'`,
      [slotId, vendor.vendorId],
    )
    expect(opened[0]!.n).toBe(1)
  })

  it('два одновременных запроса после девяти: ровно 201+429, 10 строк и одна новость', async () => {
    const wedding = await newWedding()
    const [first, second] = await Promise.all([newVendor(), newVendor()])
    const added = await Promise.all([addCandidate(wedding, first), addCandidate(wedding, second)])
    expect(added.map((response) => response.statusCode)).toEqual([200, 200])
    const slotId = added[0]!.json().slotId as string
    const entryIds = added.map((response) => response.json().id as string)
    await seedClosedRequests(wedding, slotId, first.vendorId, 9)
    const beforeFirst = (await notifications(first.id)).length
    const beforeSecond = (await notifications(second.id)).length

    await warmPool()
    type RequestResponse = Awaited<ReturnType<typeof requestOffers>>
    let pending: Promise<RequestResponse>[] = []
    let settled: PromiseSettledResult<RequestResponse>[] = []
    let probeError: unknown
    try {
      await app.db!.tx(async (client) => {
        await client.query('select id from weddings where id = $1 for update', [wedding.weddingId])
        const { rows: [holder] } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        pending = [
          requestOffers(wedding, slotId, [entryIds[0]!]),
          requestOffers(wedding, slotId, [entryIds[1]!]),
        ]
        const blocked = await waitForBlockedBy(client, holder!.pid, 2)
        expect(blocked.every((query) => query.toLocaleLowerCase('en-US').includes('weddings'))).toBe(true)
      })
    } catch (error) {
      probeError = error
    } finally {
      settled = await Promise.allSettled(pending)
    }
    if (probeError) throw probeError
    const failed = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed[0]) throw failed[0].reason
    const raced = settled.map((result) => (result as PromiseFulfilledResult<RequestResponse>).value)
    expect(raced.map((response) => response.statusCode).sort()).toEqual([201, 429])
    expect(raced.some((response) => response.statusCode >= 500)).toBe(false)
    const rejected = raced.find((response) => response.statusCode === 429)!
    expect((rejected.json() as { error: { code: string } }).error.code).toBe('offer_requests_limit')
    expect(rejected.headers['retry-after']).toBeUndefined()
    const created = raced.find((response) => response.statusCode === 201)!
    expect(successResultsOf(created)).toHaveLength(1)

    expect(await recentRequestCount(wedding.weddingId)).toBe(10)
    const { rows: opened } = await app.db!.query<{ vendor_id: string }>(
      `select vendor_id from offer_requests
        where slot_id = $1 and vendor_id = any($2::uuid[]) and status = 'open'`,
      [slotId, [first.vendorId, second.vendorId]],
    )
    expect(opened).toHaveLength(1)
    const afterFirst = await notifications(first.id)
    const afterSecond = await notifications(second.id)
    expect([afterFirst.length - beforeFirst, afterSecond.length - beforeSecond].sort()).toEqual([0, 1])
    const addedNotice = afterFirst.length > beforeFirst ? afterFirst.at(-1)! : afterSecond.at(-1)!
    expect(addedNotice).toMatchObject({ kind: 'deal', link: '/vendor/offer-requests' })
  }, 60_000)

  it('подрядчики отвечают пакетом и отказом; снимок и поля отказа честные', async () => {
    const wedding = await newWedding()
    const [offering, declining] = await Promise.all([newVendor(), newVendor()])
    const added = await Promise.all([addCandidate(wedding, offering), addCandidate(wedding, declining)])
    expect(added.map((response) => response.statusCode)).toEqual([200, 200])
    const slotId = added[0]!.json().slotId as string
    const entryIds = added.map((response) => response.json().id as string)
    const requested = await requestOffers(wedding, slotId, entryIds)
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(2)
    const offeringRequest = await requestIdFor(slotId, offering.vendorId)
    const decliningRequest = await requestIdFor(slotId, declining.vendorId)
    const before = (await notifications(wedding.id)).length

    const offer = await answer(offering, offeringRequest, {
      kind: 'offer',
      packageId: offering.packageId,
      price: { amount: 12_000_000, currency: 'RUB' },
      message: 'Готовы снимать',
      validUntil: '2034-06-01',
    })
    expect(offer.statusCode, offer.body).toBe(201)
    const offerBody = createdOfferOf(offer, offeringRequest, 'offer')
    expect(offerBody).toEqual({
      id: expect.any(String),
      requestId: offeringRequest,
      kind: 'offer',
      packageId: offering.packageId,
      title: offering.packageName,
      price: { amount: 12_000_000, currency: 'RUB' },
      includes: ['8 часов', 'Ретушь'],
      message: 'Готовы снимать',
      validUntil: '2034-06-01',
    })
    const afterOffer = await notifications(wedding.id)
    expect(afterOffer).toHaveLength(before + 1)
    expect(afterOffer.at(-1)).toMatchObject({ kind: 'deal', link: `/wedding/slot/${slotId}` })

    const decline = await answer(declining, decliningRequest, {
      kind: 'decline',
      message: 'Дата не подходит',
    })
    expect(decline.statusCode, decline.body).toBe(201)
    const declineBody = createdOfferOf(decline, decliningRequest, 'decline')
    expect(declineBody).toEqual({
      id: expect.any(String),
      requestId: decliningRequest,
      kind: 'decline',
      packageId: null,
      title: null,
      price: null,
      includes: [],
      message: 'Дата не подходит',
      validUntil: null,
    })
    const afterDecline = await notifications(wedding.id)
    expect(afterDecline).toHaveLength(before + 2)
    expect(afterDecline.slice(before).every((notice) => notice.kind === 'deal')).toBe(true)
    expect(afterDecline.slice(before).every((notice) => notice.link === `/wedding/slot/${slotId}`)).toBe(true)

    const offered = await offerRows(offeringRequest)
    const declined = await offerRows(decliningRequest)
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({
      id: offerBody.id,
      request_id: offeringRequest,
      kind: 'offer',
      package_id: offering.packageId,
      title: offering.packageName,
      price: '12000000',
      currency: 'RUB',
      includes: ['8 часов', 'Ретушь'],
      message: 'Готовы снимать',
      valid_until: '2034-06-01',
      superseded_at: null,
      accepted_at: null,
      deal_id: null,
    })
    expect(offered[0]!.package_snapshot).toEqual({
      id: offering.packageId,
      name: offering.packageName,
      price: { amount: 10_000_000, currency: 'RUB' },
      includes: ['8 часов', 'Ретушь'],
    })
    expect(declined).toHaveLength(1)
    expect(declined[0]).toMatchObject({
      id: declineBody.id,
      request_id: decliningRequest,
      kind: 'decline',
      package_id: null,
      package_snapshot: null,
      title: null,
      price: null,
      currency: 'RUB',
      includes: [],
      message: 'Дата не подходит',
      valid_until: null,
      superseded_at: null,
      accepted_at: null,
      deal_id: null,
    })
    const changed = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(offering.token),
      payload: {
        name: offering.name,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
        packages: [
          {
            id: offering.packageId,
            name: 'Пакет после ответа',
            price: { amount: 99_000_000, currency: 'RUB' },
            includes: ['Новый состав'],
          },
        ],
      },
    })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(await offerRows(offeringRequest)).toEqual(offered)
    expect(await offerRows(decliningRequest)).toEqual(declined)
  }, 60_000)

  it('удаление пакета при новой версии не образует deadlock offer↔vendor', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const requested = await requestOffers(wedding, slotId, [entryId])
    expect(requested.statusCode, requested.body).toBe(201)
    const requestId = await requestIdFor(slotId, vendor.vendorId)
    const first = await answer(vendor, requestId, {
      kind: 'offer',
      packageId: vendor.packageId,
      price: { amount: 12_000_000, currency: 'RUB' },
      validUntil: '2034-06-01',
    })
    expect(first.statusCode, first.body).toBe(201)
    const firstId = createdOfferOf(first, requestId, 'offer').id
    const noticesBefore = (await notifications(wedding.id)).length

    await warmPool()
    type OfferHttpResponse = Awaited<ReturnType<typeof answer>>
    let pending: Promise<OfferHttpResponse> | null = null
    let settled: PromiseSettledResult<OfferHttpResponse> | null = null
    let probeError: unknown
    try {
      await app.db!.tx(async (client) => {
        /* PUT /vendor/profile сначала держит строку анкеты, затем удаляет
         * неприсланный пакет. FK SET NULL при этом обновляет active offer.
         * Ответ уже держит request, но не должен держать offer до vendor-lock:
         * иначе эти две транзакции ждут друг друга и PostgreSQL даёт 40P01. */
        await client.query('select id from vendors where id = $1 for update', [vendor.vendorId])
        const { rows: [holder] } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        pending = answer(vendor, requestId, customOffer(2))
        const blocked = await waitForBlockedBy(client, holder!.pid, 1)
        expect(blocked.some((query) => query.toLocaleLowerCase('en-US').includes('from vendors'))).toBe(true)
        const deleted = await client.query('delete from vendor_packages where id = $1 and vendor_id = $2', [
          vendor.packageId,
          vendor.vendorId,
        ])
        expect(deleted.rowCount).toBe(1)
      })
    } catch (error) {
      probeError = error
    } finally {
      if (pending) {
        settled = await Promise.resolve(pending).then(
          (value): PromiseSettledResult<OfferHttpResponse> => ({ status: 'fulfilled', value }),
          (reason): PromiseSettledResult<OfferHttpResponse> => ({ status: 'rejected', reason }),
        )
      }
    }
    if (probeError) throw probeError
    if (!settled) throw new Error('ответ подрядчика не был запущен')
    if (settled.status === 'rejected') throw settled.reason
    expect(settled.value.statusCode, settled.value.body).toBe(201)
    const secondId = createdOfferOf(settled.value, requestId, 'offer').id

    const rows = await offerRows(requestId)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === firstId)).toMatchObject({
      package_id: null,
      package_snapshot: {
        id: vendor.packageId,
        name: vendor.packageName,
        price: { amount: 10_000_000, currency: 'RUB' },
        includes: ['8 часов', 'Ретушь'],
      },
      superseded_at: expect.any(Date),
    })
    expect(rows.find((row) => row.id === secondId)).toMatchObject({
      title: 'Версия 2',
      package_id: null,
      superseded_at: null,
    })
    expect(await notifications(wedding.id)).toHaveLength(noticesBefore + 1)
  }, 60_000)

  it('повтор ответа с тем же ключом — одна версия и одно уведомление', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const requested = await requestOffers(wedding, slotId, [entryId])
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, vendor.vendorId)
    const before = (await notifications(wedding.id)).length
    const key = randomUUID()
    const call = () => answer(vendor, requestId, customOffer(1), key)

    const first = await call()
    const replay = await call()
    expect(first.statusCode, first.body).toBe(201)
    expect(replay.statusCode, replay.body).toBe(201)
    const firstBody = createdOfferOf(first, requestId, 'offer')
    expect(firstBody).toEqual({
      id: expect.any(String),
      requestId,
      kind: 'offer',
      packageId: null,
      title: 'Версия 1',
      price: { amount: 11_000_001, currency: 'RUB' },
      includes: ['Пункт 1'],
      message: 'Сообщение 1',
      validUntil: '2034-06-01',
    })
    const replayBody = createdOfferOf(replay, requestId, 'offer')
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replayBody).toEqual(firstBody)
    expect(await offerRows(requestId)).toHaveLength(1)
    const after = await notifications(wedding.id)
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)).toMatchObject({ kind: 'deal', link: `/wedding/slot/${slotId}` })
  })

  it('пятая версия проходит, replay при count=5 проходит, новый ключ даёт 429', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const requested = await requestOffers(wedding, slotId, [entryId])
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, vendor.vendorId)
    const before = (await notifications(wedding.id)).length

    const firstFour: Record<string, unknown>[] = [
      customOffer(1),
      { kind: 'decline', message: 'Отказ 2' },
      customOffer(3),
      { kind: 'decline', message: 'Отказ 4' },
    ]
    for (const version of firstFour) {
      const response = await answer(vendor, requestId, version)
      expect(response.statusCode, response.body).toBe(201)
      createdOfferOf(response, requestId, version.kind as OfferResponse['kind'])
    }
    expect(await offerRows(requestId)).toHaveLength(4)
    expect(await notifications(wedding.id)).toHaveLength(before + 4)

    const fifthKey = randomUUID()
    const fifth = await answer(vendor, requestId, customOffer(5), fifthKey)
    expect(fifth.statusCode, fifth.body).toBe(201)
    const fifthBody = createdOfferOf(fifth, requestId, 'offer')
    const historyAtLimit = await offerRows(requestId)
    expect(historyAtLimit).toHaveLength(5)
    expect(await notifications(wedding.id)).toHaveLength(before + 5)

    const replay = await answer(vendor, requestId, customOffer(5), fifthKey)
    expect(replay.statusCode, replay.body).toBe(201)
    const replayBody = createdOfferOf(replay, requestId, 'offer')
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replayBody).toEqual(fifthBody)
    expect(await offerRows(requestId)).toEqual(historyAtLimit)
    expect(await notifications(wedding.id)).toHaveLength(before + 5)

    const sixth = await answer(vendor, requestId, customOffer(6), randomUUID())
    expect(sixth.statusCode, sixth.body).toBe(429)
    expect((sixth.json() as { error: { code: string } }).error.code).toBe('offer_revisions_limit')
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(sixth.headers['retry-after'])).toBeLessThanOrEqual(86_400)

    const rows = await offerRows(requestId)
    expect(rows).toEqual(historyAtLimit)
    expect(rows).toHaveLength(5)
    expect(rows.filter((row) => row.superseded_at !== null)).toHaveLength(4)
    expect(rows.filter((row) => row.superseded_at === null)).toHaveLength(1)
    expect(rows.find((row) => row.superseded_at === null)?.title).toBe('Версия 5')
    const history = rows
      .map((row) => ({
        kind: row.kind,
        packageId: row.package_id,
        packageSnapshot: row.package_snapshot,
        title: row.title,
        price: row.price,
        currency: row.currency,
        includes: row.includes,
        message: row.message,
        validUntil: row.valid_until,
        superseded: row.superseded_at !== null,
        acceptedAt: row.accepted_at,
        dealId: row.deal_id,
      }))
      .sort((left, right) => {
        const leftVersion = Number((left.message ?? '').match(/\d+$/)?.[0])
        const rightVersion = Number((right.message ?? '').match(/\d+$/)?.[0])
        return leftVersion - rightVersion
      })
    expect(history).toEqual([
      {
        kind: 'offer', packageId: null, packageSnapshot: null, title: 'Версия 1', price: '11000001',
        currency: 'RUB', includes: ['Пункт 1'], message: 'Сообщение 1', validUntil: '2034-06-01',
        superseded: true, acceptedAt: null, dealId: null,
      },
      {
        kind: 'decline', packageId: null, packageSnapshot: null, title: null, price: null,
        currency: 'RUB', includes: [], message: 'Отказ 2', validUntil: null,
        superseded: true, acceptedAt: null, dealId: null,
      },
      {
        kind: 'offer', packageId: null, packageSnapshot: null, title: 'Версия 3', price: '11000003',
        currency: 'RUB', includes: ['Пункт 3'], message: 'Сообщение 3', validUntil: '2034-06-01',
        superseded: true, acceptedAt: null, dealId: null,
      },
      {
        kind: 'decline', packageId: null, packageSnapshot: null, title: null, price: null,
        currency: 'RUB', includes: [], message: 'Отказ 4', validUntil: null,
        superseded: true, acceptedAt: null, dealId: null,
      },
      {
        kind: 'offer', packageId: null, packageSnapshot: null, title: 'Версия 5', price: '11000005',
        currency: 'RUB', includes: ['Пункт 5'], message: 'Сообщение 5', validUntil: '2034-06-01',
        superseded: false, acceptedAt: null, dealId: null,
      },
    ])
    const notices = await notifications(wedding.id)
    expect(notices).toHaveLength(before + 5)
    expect(notices.slice(before).every((notice) => notice.kind === 'deal')).toBe(true)
    expect(notices.slice(before).every((notice) => notice.link === `/wedding/slot/${slotId}`)).toBe(true)
  }, 60_000)

  it('два ответа после четырёх: под замком запроса ровно 201+429, 5 строк и одна новость', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const requested = await requestOffers(wedding, slotId, [entryId])
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, vendor.vendorId)

    for (let version = 1; version <= 4; version++) {
      const response = await answer(vendor, requestId, customOffer(version))
      expect(response.statusCode, response.body).toBe(201)
      createdOfferOf(response, requestId, 'offer')
    }
    expect(await offerRows(requestId)).toHaveLength(4)
    const before = (await notifications(wedding.id)).length

    await warmPool()
    type OfferHttpResponse = Awaited<ReturnType<typeof answer>>
    let pending: Promise<OfferHttpResponse>[] = []
    let settled: PromiseSettledResult<OfferHttpResponse>[] = []
    let probeError: unknown
    try {
      await app.db!.tx(async (client) => {
        await client.query('select id from offer_requests where id = $1 for update', [requestId])
        const { rows: [holder] } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        pending = [
          answer(vendor, requestId, customOffer(5)),
          answer(vendor, requestId, customOffer(6)),
        ]
        const blocked = await waitForBlockedBy(client, holder!.pid, 2)
        expect(blocked.every((query) => query.toLocaleLowerCase('en-US').includes('offer_requests'))).toBe(true)
      })
    } catch (error) {
      probeError = error
    } finally {
      settled = await Promise.allSettled(pending)
    }
    if (probeError) throw probeError
    const failed = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed[0]) throw failed[0].reason
    const raced = settled.map((result) => (result as PromiseFulfilledResult<OfferHttpResponse>).value)
    expect(raced.map((response) => response.statusCode).sort()).toEqual([201, 429])
    expect(raced.some((response) => response.statusCode >= 500)).toBe(false)
    const rejected = raced.find((response) => response.statusCode === 429)!
    expect((rejected.json() as { error: { code: string } }).error.code).toBe('offer_revisions_limit')
    expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(rejected.headers['retry-after'])).toBeLessThanOrEqual(86_400)
    const created = raced.find((response) => response.statusCode === 201)!
    createdOfferOf(created, requestId, 'offer')

    const rows = await offerRows(requestId)
    expect(rows).toHaveLength(5)
    expect(rows.filter((row) => row.superseded_at !== null)).toHaveLength(4)
    const active = rows.filter((row) => row.superseded_at === null)
    expect(active).toHaveLength(1)
    expect(['Версия 5', 'Версия 6']).toContain(active[0]!.title)
    const notices = await notifications(wedding.id)
    expect(notices).toHaveLength(before + 1)
    expect(notices.at(-1)).toMatchObject({ kind: 'deal', link: `/wedding/slot/${slotId}` })
  }, 60_000)

  it('принятую версию нельзя заменить: 409, принятая строка и новость неизменны', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const requested = await requestOffers(wedding, slotId, [entryId])
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, vendor.vendorId)
    const answered = await answer(vendor, requestId, customOffer(1))
    expect(answered.statusCode, answered.body).toBe(201)
    const offerId = createdOfferOf(answered, requestId, 'offer').id
    const dealId = randomUUID()
    await app.db!.tx(async (client) => {
      await client.query(
        `insert into deals (
           id, wedding_id, slot_id, vendor_id, state, price, currency, booked_at,
           package_title_snapshot, package_includes_snapshot)
         values ($1, $2, $3, $4, 'booked', 11000001, 'RUB', now(), $5, $6::jsonb)`,
        [dealId, wedding.weddingId, slotId, vendor.vendorId, 'Версия 1', JSON.stringify(['Пункт 1'])],
      )
      await client.query('update slots set deal_id = $2 where id = $1', [slotId, dealId])
      await client.query(
        `insert into vendor_busy_dates (vendor_id, date, source, deal_id)
         values ($1, $2::date, 'deal', $3)`,
        [vendor.vendorId, wedding.date, dealId],
      )
      await client.query(
        `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
         values ($1, $2, null, 'booked', $3)`,
        [randomUUID(), dealId, wedding.id],
      )
      await client.query('update offers set accepted_at = now(), deal_id = $2 where id = $1', [offerId, dealId])
      await client.query(
        `update offer_requests
            set status = 'closed', close_reason = 'booked', closed_at = now()
          where id = $1`,
        [requestId],
      )
    })
    const { rows: linkage } = await app.db!.query<{
      deal_id: string
      slot_deal_id: string
      status: string
      close_reason: string
      closed: boolean
      busy_deal_id: string
    }>(
      `select d.id as deal_id, s.deal_id as slot_deal_id, r.status, r.close_reason,
              r.closed_at is not null as closed, b.deal_id as busy_deal_id
         from deals d
         join slots s on s.id = d.slot_id
         join offer_requests r on r.id = $2
         join vendor_busy_dates b
           on b.vendor_id = d.vendor_id and b.date = $3::date and b.source = 'deal'
        where d.id = $1`,
      [dealId, requestId, wedding.date],
    )
    expect(linkage).toEqual([{
      deal_id: dealId,
      slot_deal_id: dealId,
      status: 'closed',
      close_reason: 'booked',
      closed: true,
      busy_deal_id: dealId,
    }])
    const beforeOffer = (await offerRows(requestId))[0]!
    expect(beforeOffer).toMatchObject({ id: offerId, deal_id: dealId, superseded_at: null })
    expect(beforeOffer.accepted_at).not.toBeNull()
    const before = (await notifications(wedding.id)).length

    const refused = await answer(vendor, requestId, customOffer(2))
    expect(refused.statusCode, refused.body).toBe(409)
    expect((refused.json() as { error: { code: string } }).error.code).toBe('request_closed')
    const after = await offerRows(requestId)
    expect(after).toHaveLength(1)
    expect(after[0]).toEqual(beforeOffer)
    expect(await notifications(wedding.id)).toHaveLength(before)
  })

  it('пара убирает кандидата: запрос closed/removed, подрядчику приходит отзыв', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const requested = await requestOffers(wedding, slotId, [entryId])
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, vendor.vendorId)
    const before = (await notifications(vendor.id)).length

    const removed = await app.inject({
      method: 'DELETE',
      url: `/weddings/${wedding.weddingId}/slots/${slotId}/shortlist/${entryId}`,
      headers: auth(wedding.token),
    })
    expect(removed.statusCode, removed.body).toBe(204)
    const { rows } = await app.db!.query<{
      status: string
      close_reason: string | null
      closed: boolean
    }>(
      `select status, close_reason, closed_at is not null as closed
         from offer_requests where id = $1`,
      [requestId],
    )
    expect(rows[0]).toEqual({ status: 'closed', close_reason: 'removed', closed: true })
    const after = await notifications(vendor.id)
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)!.kind).toBe('deal')
    expect(after.at(-1)!.link).toBe('/vendor/offer-requests')
    expect(`${after.at(-1)!.title} ${after.at(-1)!.body}`).not.toContain(wedding.weddingId)
    expect(`${after.at(-1)!.title} ${after.at(-1)!.body}`).not.toContain(vendor.vendorId)
  })

  it('атомарная замена кандидата тоже закрывает его запрос и шлёт ровно один отзыв', async () => {
    const wedding = await newWedding()
    const [requested, second, third, incoming] = await Promise.all([
      newVendor(),
      newVendor(),
      newVendor(),
      newVendor(),
    ])
    const entries = await Promise.all([
      addCandidate(wedding, requested),
      addCandidate(wedding, second),
      addCandidate(wedding, third),
    ])
    expect(entries.map((response) => response.statusCode)).toEqual([200, 200, 200])
    const slotId = entries[0]!.json().slotId as string
    const replacedEntryId = entries[0]!.json().id as string
    const requestedResponse = await requestOffers(wedding, slotId, [replacedEntryId])
    expect(requestedResponse.statusCode, requestedResponse.body).toBe(201)
    expect(successResultsOf(requestedResponse)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, requested.vendorId)
    const before = (await notifications(requested.id)).length

    const replaced = await app.inject({
      method: 'PUT',
      url: `/weddings/${wedding.weddingId}/shortlist/${incoming.vendorId}`,
      headers: auth(wedding.token),
      payload: { replaceEntryId: replacedEntryId },
    })
    expect(replaced.statusCode, replaced.body).toBe(200)
    expect(replaced.json().position).toBe(entries[0]!.json().position)
    const { rows: [closed] } = await app.db!.query<{
      status: string
      close_reason: string | null
      closed: boolean
    }>(
      `select status, close_reason, closed_at is not null as closed
         from offer_requests where id = $1`,
      [requestId],
    )
    expect(closed).toEqual({ status: 'closed', close_reason: 'removed', closed: true })
    const { rows: shortlist } = await app.db!.query<{ vendor_id: string }>(
      'select vendor_id from slot_shortlist where slot_id = $1 order by position',
      [slotId],
    )
    expect(shortlist.map((row) => row.vendor_id)).not.toContain(requested.vendorId)
    expect(shortlist.map((row) => row.vendor_id)).toContain(incoming.vendorId)
    expect(shortlist).toHaveLength(3)
    const after = await notifications(requested.id)
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)!.kind).toBe('deal')
    expect(after.at(-1)!.link).toBe('/vendor/offer-requests')
    expect(`${after.at(-1)!.title} ${after.at(-1)!.body}`).not.toContain(incoming.vendorId)
    expect(`${after.at(-1)!.title} ${after.at(-1)!.body}`).not.toContain(incoming.name)
  }, 60_000)

  it('скрытый подрядчик не отвечает: 409 vendor_unavailable без ответа и новости', async () => {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const added = await addCandidate(wedding, vendor)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    const requested = await requestOffers(wedding, slotId, [entryId])
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, vendor.vendorId)
    await app.db!.query('update vendors set blocked_at = now() where id = $1', [vendor.vendorId])
    const before = (await notifications(wedding.id)).length

    const response = await answer(vendor, requestId, customOffer(1))
    expect(response.statusCode, response.body).toBe(409)
    expect((response.json() as { error: { code: string } }).error.code).toBe('vendor_unavailable')
    expect(await offerRows(requestId)).toEqual([])
    expect(await notifications(wedding.id)).toHaveLength(before)
    const { rows } = await app.db!.query<{ status: string }>('select status from offer_requests where id = $1', [
      requestId,
    ])
    expect(rows[0]!.status).toBe('open')
  })

  it('помощник и координатор видят лишь status; чужой подрядчик не видит запрос/ответ нигде', async () => {
    const wedding = await newWedding()
    const helper = await member(wedding, 'helper')
    const coordinator = await member(wedding, 'coordinator')
    const [author, outsider] = await Promise.all([newVendor(), newVendor()])
    const added = await Promise.all([addCandidate(wedding, author), addCandidate(wedding, outsider)])
    expect(added.map((response) => response.statusCode)).toEqual([200, 200])
    const slotId = added[0]!.json().slotId as string
    const authorEntryId = added[0]!.json().id as string
    const wishesCanary = `WISHES_CANARY_${RUN}`
    const budgetCanary = 7_654_321
    const declineCanary = `DECLINE_CANARY_${RUN}`
    const offerTitleCanary = `OFFER_TITLE_CANARY_${RUN}`
    const offerMessageCanary = `OFFER_MESSAGE_CANARY_${RUN}`
    const offerIncludesCanary = `OFFER_INCLUDES_CANARY_${RUN}`
    const offerPriceCanary = 12_345_679
    const protectedBefore = await Promise.all([
      notifications(helper.id),
      notifications(coordinator.id),
      notifications(outsider.id),
    ])
    const requested = await requestOffers(wedding, slotId, [authorEntryId], randomUUID(), {
      wishes: wishesCanary,
      budgetHint: { amount: budgetCanary, currency: 'RUB' },
    })
    expect(requested.statusCode, requested.body).toBe(201)
    expect(successResultsOf(requested)).toHaveLength(1)
    const requestId = await requestIdFor(slotId, author.vendorId)

    const readAs = (token: string) =>
      app.inject({
        method: 'GET',
        url: `/weddings/${wedding.weddingId}/slots/${slotId}/shortlist`,
        headers: auth(token),
      })
    type EntryView = { vendor: { id: string } | null; request?: unknown }
    const authorEntry = (response: { json: () => unknown }) =>
      (response.json() as EntryView[]).find((entry) => entry.vendor?.id === author.vendorId)!
    const expectNoCanaries = (body: string, canaries: string[]) => {
      for (const canary of canaries) expect(body).not.toContain(canary)
    }

    const [couplePending, helperPending, coordinatorPending] = await Promise.all([
      readAs(wedding.token),
      readAs(helper.token),
      readAs(coordinator.token),
    ])
    for (const view of [couplePending, helperPending, coordinatorPending]) {
      expect(view.statusCode, view.body).toBe(200)
    }
    const pendingCanaries = [requestId, wishesCanary, String(budgetCanary)]
    const couplePendingRequest = JSON.stringify(authorEntry(couplePending).request)
    for (const canary of pendingCanaries) {
      expect(couplePendingRequest).toContain(canary)
      expect(couplePending.body).toContain(canary)
    }
    for (const view of [helperPending, coordinatorPending]) {
      expect(authorEntry(view).request).toEqual({ status: 'pending' })
      expectNoCanaries(JSON.stringify(authorEntry(view).request), pendingCanaries)
      expectNoCanaries(view.body, pendingCanaries)
    }
    const protectedPending = await Promise.all([
      notifications(helper.id),
      notifications(coordinator.id),
      notifications(outsider.id),
    ])
    expect(protectedPending.map((rows) => rows.length)).toEqual(protectedBefore.map((rows) => rows.length))

    const pairBefore = (await notifications(wedding.id)).length
    const answered = await answer(author, requestId, { kind: 'decline', message: declineCanary })
    expect(answered.statusCode, answered.body).toBe(201)
    const declinedBody = createdOfferOf(answered, requestId, 'decline')
    expect(declinedBody).toEqual({
      id: expect.any(String),
      requestId,
      kind: 'decline',
      packageId: null,
      title: null,
      price: null,
      includes: [],
      message: declineCanary,
      validUntil: null,
    })

    const [coupleResponded, helperResponded, coordinatorResponded] = await Promise.all([
      readAs(wedding.token),
      readAs(helper.token),
      readAs(coordinator.token),
    ])
    for (const view of [coupleResponded, helperResponded, coordinatorResponded]) {
      expect(view.statusCode, view.body).toBe(200)
    }
    const respondedCanaries = [...pendingCanaries, declineCanary]
    const coupleRespondedRequest = JSON.stringify(authorEntry(coupleResponded).request)
    for (const canary of respondedCanaries) {
      expect(coupleRespondedRequest).toContain(canary)
      expect(coupleResponded.body).toContain(canary)
    }
    for (const view of [helperResponded, coordinatorResponded]) {
      expect(authorEntry(view).request).toEqual({ status: 'responded' })
      expectNoCanaries(JSON.stringify(authorEntry(view).request), respondedCanaries)
      expectNoCanaries(view.body, respondedCanaries)
    }
    const pairAfter = await notifications(wedding.id)
    expect(pairAfter).toHaveLength(pairBefore + 1)
    expect(pairAfter.at(-1)).toMatchObject({ kind: 'deal', link: `/wedding/slot/${slotId}` })

    const offered = await answer(author, requestId, {
      kind: 'offer',
      title: offerTitleCanary,
      price: { amount: offerPriceCanary, currency: 'RUB' },
      includes: [offerIncludesCanary],
      message: offerMessageCanary,
      validUntil: '2034-06-01',
    })
    expect(offered.statusCode, offered.body).toBe(201)
    const offeredBody = createdOfferOf(offered, requestId, 'offer')
    expect(offeredBody).toEqual({
      id: expect.any(String),
      requestId,
      kind: 'offer',
      packageId: null,
      title: offerTitleCanary,
      price: { amount: offerPriceCanary, currency: 'RUB' },
      includes: [offerIncludesCanary],
      message: offerMessageCanary,
      validUntil: '2034-06-01',
    })

    const [coupleOffered, helperOffered, coordinatorOffered] = await Promise.all([
      readAs(wedding.token),
      readAs(helper.token),
      readAs(coordinator.token),
    ])
    for (const view of [coupleOffered, helperOffered, coordinatorOffered]) {
      expect(view.statusCode, view.body).toBe(200)
    }
    const offerCanaries = [offerTitleCanary, offerMessageCanary, offerIncludesCanary, String(offerPriceCanary)]
    const allCanaries = [...respondedCanaries, ...offerCanaries]
    const coupleOfferedRequest = JSON.stringify(authorEntry(coupleOffered).request)
    for (const canary of [...pendingCanaries, ...offerCanaries]) {
      expect(coupleOfferedRequest).toContain(canary)
      expect(coupleOffered.body).toContain(canary)
    }
    for (const view of [helperOffered, coordinatorOffered]) {
      expect(authorEntry(view).request).toEqual({ status: 'responded' })
      expectNoCanaries(JSON.stringify(authorEntry(view).request), allCanaries)
      expectNoCanaries(view.body, allCanaries)
    }
    const pairAfterOffer = await notifications(wedding.id)
    expect(pairAfterOffer).toHaveLength(pairBefore + 2)
    expect(pairAfterOffer.slice(pairBefore).every((notice) => notice.kind === 'deal')).toBe(true)
    expect(pairAfterOffer.slice(pairBefore).every((notice) => notice.link === `/wedding/slot/${slotId}`)).toBe(true)

    const outsiderList = await vendorRequests(outsider)
    expect(outsiderList.statusCode, outsiderList.body).toBe(200)
    expect(vendorItems(outsiderList)).toEqual([])
    expectNoCanaries(outsiderList.body, allCanaries)

    const forged = await answer(outsider, requestId, customOffer(99))
    expect(forged.statusCode, forged.body).toBe(404)
    expectNoCanaries(forged.body, allCanaries)
    const vendorWeddingRead = await readAs(outsider.token)
    expect(vendorWeddingRead.statusCode, vendorWeddingRead.body).toBe(404)
    expectNoCanaries(vendorWeddingRead.body, allCanaries)

    const protectedAfter = await Promise.all([
      notifications(helper.id),
      notifications(coordinator.id),
      notifications(outsider.id),
    ])
    expect(protectedAfter.map((rows) => rows.length)).toEqual(protectedBefore.map((rows) => rows.length))
    for (const rows of protectedAfter) expectNoCanaries(JSON.stringify(rows), allCanaries)
    const privateRows = await offerRows(requestId)
    expect(privateRows).toHaveLength(2)
    expect(privateRows.find((row) => row.kind === 'decline')).toMatchObject({
      id: declinedBody.id,
      message: declineCanary,
      superseded_at: expect.any(Date),
    })
    expect(privateRows.find((row) => row.kind === 'offer')).toMatchObject({
      id: offeredBody.id,
      title: offerTitleCanary,
      price: String(offerPriceCanary),
      includes: [offerIncludesCanary],
      message: offerMessageCanary,
      superseded_at: null,
    })
  }, 60_000)
})
