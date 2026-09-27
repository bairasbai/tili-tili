/** 019 / US3: HTTP + real PostgreSQL/Redis acceptance regression. */
import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'

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

describe.skipIf(!live)('019 / US3: принятие предложения и бронь', () => {
  let app: FastifyInstance
  let counter = 0
  let vendorCounter = 0
  let RUN = String(randomInt(100_000, 1_000_000))
  const createdUsers: string[] = []

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const idem = (token: string, key = randomUUID()) => ({ ...auth(token), 'idempotency-key': key })
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: process.env.TEST_REDIS_URL ?? null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      // Test fixture throughput only; production rate limits remain unchanged.
      rateLimitPerSecond: 1_000_000,
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
    if (failures.length > 0) throw new AggregateError(failures, 'не все фикстуры accept019 очищены')
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
    const remoteAddress = `2001:db8:${Number(RUN).toString(16).slice(-4)}:${counter.toString(16)}::1`
    const requested = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress })
    expect(requested.statusCode, requested.body).toBe(200)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      remoteAddress,
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

  async function newWedding(date = '2028-06-14', guestsPlanned = 88): Promise<WeddingFixture> {
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

  async function member(wedding: WeddingFixture, role: 'couple' | 'helper' | 'coordinator'): Promise<UserFixture> {
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
    validUntil: '2028-06-01',
  })


  const accept = (w: WeddingFixture, offerId: string, key = randomUUID(), token = w.token) => app.inject({
    method: 'POST', url: `/weddings/${w.weddingId}/offers/${offerId}/accept`, headers: idem(token, key),
  })
  async function fixture(packageOffer = false) {
    const w = await newWedding()
    const v = await newVendor()
    const slotId = await slotOf(w)
    const added = await addCandidate(w, v)
    expect(added.statusCode, added.body).toBe(200)
    const requested = await requestOffers(w, slotId, [added.json().id])
    expect(requested.statusCode, requested.body).toBe(201)
    const requestId = requested.json().results[0].requestId as string
    const reply = await answer(v, requestId, packageOffer ? { kind: 'offer', packageId: v.packageId, price: { amount: 12_000_000, currency: 'RUB' }, message: 'Согласованные условия', validUntil: '2028-06-01' } : customOffer(1))
    expect(reply.statusCode, reply.body).toBe(201)
    return { w, v, slotId, requestId, offer: reply.json() as { id: string; title: string; price: { amount: number }; includes: string[] } }
  }
  async function persisted(slotId: string) {
    const { rows } = await app.db!.query<{
      id: string; price: string; title: string; includes: string[]; package_id: string | null
    }>(`select id, price::text, package_title_snapshot as title,
              package_includes_snapshot as includes, package_id from deals where slot_id = $1`, [slotId])
    return rows
  }
  async function closed(requestId: string) {
    const { rows } = await app.db!.query<{ status: string; close_reason: string | null }>(
      'select status, close_reason from offer_requests where id = $1', [requestId])
    return rows[0]!
  }

  it('T032: accepts immutable price/services, books once, closes requests privately and replays', async () => {
    const { w, v, slotId, requestId, offer } = await fixture()
    const other = await newVendor()
    const added = await addCandidate(w, other)
    const request2 = await requestOffers(w, slotId, [added.json().id])
    const otherId = request2.json().results[0].requestId as string
    const key = randomUUID()
    const result = await accept(w, offer.id, key)
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ id: slotId, tileState: 'booked', deal: {
      state: 'booked', price: offer.price, packageName: offer.title, packageIncludes: offer.includes,
    } })
    const replay = await accept(w, offer.id, key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.json()).toEqual(result.json())
    expect(await persisted(slotId)).toHaveLength(1)
    expect(await closed(requestId)).toEqual({ status: 'closed', close_reason: 'booked' })
    expect(await closed(otherId)).toEqual({ status: 'closed', close_reason: 'booked_other' })
    const { rows: events } = await app.db!.query('select id from deal_events where deal_id = $1', [result.json().deal.id])
    const { rows: holds } = await app.db!.query('select deal_id from vendor_busy_dates where vendor_id = $1 and date = $2', [v.vendorId, w.date])
    expect(events).toHaveLength(1)
    expect(holds).toEqual([{ deal_id: result.json().deal.id }])
    const { rows: notices } = await app.db!.query<{ body: string; link: string }>(
      "select body, link from notifications where user_id = $1 and title = 'Пара выбрала другого исполнителя'", [other.id])
    expect(notices).toEqual([{ body: 'Запрос предложения закрыт: пара выбрала другого исполнителя.', link: '/vendor/offer-requests' }])
  })

  it.each(['expired', 'stale', 'superseded', 'declined', 'closed'] as const)('T032: %s offer is rejected without a partial booking', async kind => {
    const { w, v, slotId, requestId, offer } = await fixture()
    let id = offer.id
    let code = ''
    if (kind === 'expired') {
      await app.db!.query("update offers set valid_until = '2000-01-01' where id = $1", [id]); code = 'offer_expired'
    } else if (kind === 'stale') {
      await app.db!.query("update offer_requests set wedding_date = '2028-06-13' where id = $1", [requestId]); code = 'offer_stale_date'
    } else if (kind === 'superseded') {
      expect((await answer(v, requestId, customOffer(2))).statusCode).toBe(201); code = 'offer_superseded'
    } else if (kind === 'declined') {
      const reply = await answer(v, requestId, { kind: 'decline', message: 'Не смогу' });
      expect(reply.statusCode, reply.body).toBe(201); id = reply.json().id; code = 'offer_declined'
    } else {
      await app.db!.query("update offer_requests set status = 'closed', close_reason = 'removed', closed_at = now() where id = $1", [requestId]); code = 'request_closed'
    }
    const result = await accept(w, id)
    expect(result.statusCode, result.body).toBe(409)
    expect(result.json().error.code).toBe(code)
    expect(await persisted(slotId)).toEqual([])
  })

  it('T032: wedding-local expiry is inclusive, not the UTC date', async () => {
    const f = await fixture()
    // Always use a timezone whose local day differs from UTC at execution.
    const { rows } = await app.db!.query<{ tz: string }>(`select case
      when (now() at time zone 'Pacific/Kiritimati')::date <> (now() at time zone 'UTC')::date
      then 'Pacific/Kiritimati' else 'Pacific/Pago_Pago' end as tz`)
    await app.db!.query('update weddings set tz = $2 where id = $1', [f.w.weddingId, rows[0]!.tz])
    await app.db!.query('update offers set valid_until = (now() at time zone $2)::date where id = $1', [f.offer.id, rows[0]!.tz])
    const result = await accept(f.w, f.offer.id)
    expect(result.statusCode, result.body).toBe(200)
  })

  it('T032: two partners accepting different candidates cannot double-book a slot', async () => {
    const f = await fixture()
    const partner = await member(f.w, 'couple')
    const v2 = await newVendor()
    const added = await addCandidate(f.w, v2)
    const requested = await requestOffers(f.w, f.slotId, [added.json().id])
    const response = await answer(v2, requested.json().results[0].requestId, customOffer(2))
    expect(response.statusCode, response.body).toBe(201)
    await Promise.all(Array.from({ length: 6 }, () => app.db!.query('select 1')))
    const results = await Promise.all([accept(f.w, f.offer.id), accept(f.w, response.json().id, randomUUID(), partner.token)])
    expect(results.map(x => x.statusCode).sort()).toEqual([200, 409])
    expect(results.find(x => x.statusCode === 409)!.json().error.code).toBe('slot_taken')
    const deals = await persisted(f.slotId)
    expect(deals).toHaveLength(1)
    const { rows } = await app.db!.query('select id from offers where deal_id = $1 and accepted_at is not null', [deals[0]!.id])
    expect(rows).toHaveLength(1)
  })

  it('T032: acceptance versus vendor revision leaves exactly one consistent outcome', async () => {
    const f = await fixture()
    const [booked, revised] = await Promise.all([accept(f.w, f.offer.id), answer(f.v, f.requestId, customOffer(2))])
    if (booked.statusCode === 200) {
      expect(revised.statusCode, revised.body).toBe(409)
      expect(revised.json().error.code).toBe('request_closed')
      expect((await persisted(f.slotId))[0]!.title).toBe(f.offer.title)
    } else {
      expect(booked.statusCode, booked.body).toBe(409)
      expect(booked.json().error.code).toBe('offer_superseded')
      expect(revised.statusCode, revised.body).toBe(201)
      expect(await persisted(f.slotId)).toEqual([])
      expect((await closed(f.requestId)).status).toBe('open')
    }
  })

  it('T032: hidden vendor and busy date roll back all state and allow a later retry', async () => {
    const f = await fixture()
    await app.db!.query('update vendors set published_at = null where id = $1', [f.v.vendorId])
    let result = await accept(f.w, f.offer.id)
    expect(result.statusCode, result.body).toBe(409)
    expect(result.json().error.code).toBe('vendor_unavailable')
    await app.db!.query('update vendors set published_at = now() where id = $1', [f.v.vendorId])
    await app.db!.query("insert into vendor_busy_dates (vendor_id, date, source) values ($1, $2, 'manual')", [f.v.vendorId, f.w.date])
    result = await accept(f.w, f.offer.id)
    expect(result.statusCode, result.body).toBe(409)
    expect(result.json().error.code).toBe('date_taken')
    expect((await closed(f.requestId)).status).toBe('open')
    expect(await persisted(f.slotId)).toEqual([])
    await app.db!.query('delete from vendor_busy_dates where vendor_id = $1', [f.v.vendorId])
    expect((await accept(f.w, f.offer.id)).statusCode).toBe(200)
  })

  it('T032: package edit/removal and offer removal never rewrite accepted terms in either cabinet', async () => {
    const f = await fixture(true)
    await app.db!.query("update vendor_packages set name = 'CHANGED', price = 1, items = '[\"CHANGED\"]' where id = $1", [f.v.packageId])
    const result = await accept(f.w, f.offer.id)
    expect(result.statusCode, result.body).toBe(200)
    await app.db!.query('delete from vendor_packages where id = $1', [f.v.packageId])
    await app.db!.query('delete from offers where id = $1', [f.offer.id])
    const slots = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/slots`, headers: auth(f.w.token) })
    expect(slots.statusCode, slots.body).toBe(200)
    expect(slots.json().find((s: { id: string }) => s.id === f.slotId).deal).toMatchObject({
      price: f.offer.price, packageName: f.offer.title, packageIncludes: f.offer.includes,
    })
    const vendor = await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(f.v.token) })
    expect(vendor.statusCode, vendor.body).toBe(200)
    expect(vendor.json().items.find((d: { id: string }) => d.id === result.json().deal.id)).toMatchObject({
      price: f.offer.price, packageName: f.offer.title, packageIncludes: f.offer.includes,
    })
    expect((await persisted(f.slotId))[0]!.package_id).toBeNull()
  })

  it('T032: package deletion while acceptance waits on vendor preserves snapshot without FK error or deadlock', async () => {
    const f = await fixture(true)
    let unlock!: () => void
    let ready!: () => void
    const gate = new Promise<void>(resolve => { unlock = resolve })
    const locked = new Promise<void>(resolve => { ready = resolve })
    let blockerPid = 0
    const deletion = app.db!.tx(async client => {
      const { rows: pids } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      blockerPid = pids[0]!.pid
      await client.query('select id from vendors where id = $1 for update', [f.v.vendorId])
      ready()
      await gate
      await client.query('delete from vendor_packages where id = $1', [f.v.packageId])
    })
    await locked
    const accepting = accept(f.w, f.offer.id).then(result => result)
    try {
      let waiting = false
      for (let i = 0; i < 100 && !waiting; i++) {
        const { rows } = await app.db!.query<{ waiting: boolean }>(`select exists (
          select 1 from pg_stat_activity where datname = current_database()
          and query like '%select v.id from vendors v join users%'
          and $1 = ANY(pg_blocking_pids(pid))) as waiting`, [blockerPid])
        waiting = rows[0]!.waiting
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting, 'accept must reach vendor lock before deleting the package').toBe(true)
    } finally { unlock() }
    await deletion
    const result = await accepting
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().deal).toMatchObject({ price: f.offer.price, packageName: f.offer.title, packageIncludes: f.offer.includes })
    expect((await persisted(f.slotId))[0]!.package_id).toBeNull()
  })

  it('T032: couple-only, cross-wedding isolation, mandatory key and no caller-supplied price', async () => {
    const f = await fixture()
    for (const role of ['helper', 'coordinator'] as const) {
      const user = await member(f.w, role)
      expect((await accept(f.w, f.offer.id, randomUUID(), user.token)).statusCode).toBe(403)
    }
    const other = await newWedding()
    expect((await accept(other, f.offer.id)).statusCode).toBe(404)
    const path = `/weddings/${f.w.weddingId}/offers/${f.offer.id}/accept`
    expect((await app.inject({ method: 'POST', url: path, headers: auth(f.w.token) })).statusCode).toBe(400)
    const badBody = await app.inject({ method: 'POST', url: path, headers: idem(f.w.token), payload: { price: { amount: 1, currency: 'RUB' } } })
    expect(badBody.statusCode, badBody.body).toBe(422)
    const emptyBody = await app.inject({ method: 'POST', url: path, headers: idem(f.w.token), payload: {} })
    expect(emptyBody.statusCode, emptyBody.body).toBe(422)
    expect(await persisted(f.slotId)).toEqual([])
  })

  it.each(['date', 'first-date', 'cancel'] as const)('T035: %s closes requests, but same-date PATCH does not', async kind => {
    const f = await fixture()
    const same = await app.inject({ method: 'PATCH', url: `/weddings/${f.w.weddingId}`, headers: auth(f.w.token), payload: { date: f.w.date } })
    expect(same.statusCode, same.body).toBe(200)
    expect((await closed(f.requestId)).status).toBe('open')
    if (kind === 'first-date') {
      await app.db!.query('update weddings set date = null where id = $1', [f.w.weddingId])
      await app.db!.query('update offer_requests set wedding_date = null where id = $1', [f.requestId])
    }
    const result = await app.inject(kind === 'cancel'
      ? { method: 'POST', url: `/weddings/${f.w.weddingId}/cancel`, headers: auth(f.w.token) }
      : { method: 'PATCH', url: `/weddings/${f.w.weddingId}`, headers: auth(f.w.token), payload: { date: '2028-06-15' } })
    expect(result.statusCode, result.body).toBe(200)
    expect(await closed(f.requestId)).toEqual({ status: 'closed', close_reason: kind === 'cancel' ? 'wedding_cancelled' : 'date_changed' })
    const accepted = await accept(f.w, f.offer.id)
    expect(accepted.statusCode, accepted.body).toBe(kind === 'cancel' ? 404 : 409)
    expect(await persisted(f.slotId)).toEqual([])
  })

  it('T032: a booking with no wedding date is allowed but does not reserve an invented day', async () => {
    const f = await fixture()
    await app.db!.query('update weddings set date = null where id = $1', [f.w.weddingId])
    await app.db!.query('update offer_requests set wedding_date = null where id = $1', [f.requestId])
    const result = await accept(f.w, f.offer.id)
    expect(result.statusCode, result.body).toBe(200)
    const { rows } = await app.db!.query('select date from vendor_busy_dates where vendor_id = $1', [f.v.vendorId])
    expect(rows).toEqual([])
  })
  it.each(['catalog', 'external'] as const)('T032: %s booking also closes pending requests atomically', async kind => {
    const f = await fixture()
    const result = await app.inject({
      method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${f.slotId}/${kind === 'catalog' ? 'book' : 'external'}`,
      headers: idem(f.w.token), payload: kind === 'catalog'
        ? { vendorId: f.v.vendorId, packageId: f.v.packageId, price: { amount: 10_000_000, currency: 'RUB' } }
        : { vendorName: 'Свой фотограф', price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(await closed(f.requestId)).toEqual({ status: 'closed', close_reason: kind === 'catalog' ? 'booked' : 'booked_other' })
    expect((await accept(f.w, f.offer.id)).statusCode).toBe(409)
    expect(await persisted(f.slotId)).toHaveLength(1)
  })

  it('T032: vendor erasure preserves accepted terms for the couple and redacts them for helpers', async () => {
    const f = await fixture(true)
    const helper = await member(f.w, 'helper')
    const result = await accept(f.w, f.offer.id)
    expect(result.statusCode, result.body).toBe(200)
    const hidden = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/slots`, headers: auth(helper.token) })
    const deal = hidden.json().find((s: { id: string }) => s.id === f.slotId).deal
    expect(deal).not.toHaveProperty('price')
    expect(deal).not.toHaveProperty('packageIncludes')
    expect(deal.packageName).toBeNull()
    await app.db!.tx(client => eraseUser(client, f.v.id))
    createdUsers.splice(createdUsers.indexOf(f.v.id), 1)
    const slots = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/slots`, headers: auth(f.w.token) })
    expect(slots.statusCode, slots.body).toBe(200)
    expect(slots.json().find((s: { id: string }) => s.id === f.slotId).deal).toMatchObject({
      price: f.offer.price, packageName: f.offer.title, packageIncludes: f.offer.includes,
    })
  })

})
