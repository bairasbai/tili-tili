import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import type { Queryable } from '../src/plugins/db.js'
import { eraseUser } from '../src/jobs/index.js'

// Keep wedding fixtures inside the API's rolling five-year limit.
const TEST_YEAR = new Date().getUTCFullYear() + 1
const DB = process.env.TEST_DATABASE_URL
const SECRET_R = 'b'.repeat(48)
type User = { id: string; token: string; phone: string }
type Wedding = User & { weddingId: string }
type Vendor = User & { vendorId: string; packageId: string }
type ReadyOffer = { wedding: Wedding; vendor: Vendor; slotId: string; requestId: string; offerId: string }

/** US3: real HTTP writes and PostgreSQL transactions, not mocked booking calls. */
describe.skipIf(!DB)('019 / US3: accept an offer into a booking', () => {
  let app: FastifyInstance
  const run = String(randomInt(100_000, 1_000_000))
  const createdUsers: string[] = []
  let sequence = 0
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const idem = (token: string, key = randomUUID()) => ({ ...auth(token), 'idempotency-key': key })
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: 'a'.repeat(48), jwtRefreshSecret: SECRET_R, policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000, otpMaxPerIpHour: 1_000_000 })
    await app.ready()
  })
  afterAll(async () => {
    if (!app) return
    const errors: unknown[] = []
    try {
      for (const id of createdUsers) {
        try { await app.db!.tx(client => eraseUser(client, id)) } catch (error) { errors.push(error) }
      }
      await app.db!.query('delete from otp_codes where phone like $1', [`+79${run}%`])
    } finally { await app.close() }
    if (errors.length) throw new AggregateError(errors, 'accept019 fixtures were not fully cleaned up')
  })
  async function newUser(): Promise<User> {
    const phone = `+79${run}${String(++sequence).padStart(3, '0')}`
    const otp = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone } })
    expect(otp.statusCode, otp.body).toBe(200)
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1', [phone])
    let code = ''
    for (let n = 0; n < 10000; n++) {
      const candidate = String(n).padStart(4, '0')
      if (hashCode(SECRET_R, phone, candidate) === rows[0]!.code_hash) { code = candidate; break }
    }
    const verified = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    expect(verified.statusCode, verified.body).toBe(200)
    const body = verified.json() as { accessToken: string; user: { id: string } }
    createdUsers.push(body.user.id)
    const consent = await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' } })
    expect(consent.statusCode, consent.body).toBe(201)
    return { id: body.user.id, token: body.accessToken, phone }
  }
  async function newWedding(date: string | null = `${TEST_YEAR}-06-14`): Promise<Wedding> {
    const user = await newUser()
    const result = await app.inject({ method: 'POST', url: '/weddings', headers: auth(user.token),
      payload: { partnerName: 'Тимур', ...(date ? { date } : {}), city: { name: 'Уфа', region: 'Башкортостан' }, guestsPlanned: 88 } })
    expect(result.statusCode, result.body).toBe(201)
    return { ...user, weddingId: result.json().id as string }
  }
  async function newVendor(): Promise<Vendor> {
    const user = await newUser()
    const result = await app.inject({ method: 'PUT', url: '/vendor/profile', headers: auth(user.token), payload: {
      name: `Accept ${user.id}`, categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' },
      portfolioUrls: ['https://example.com/portfolio.jpg'], priceFrom: { amount: 8000000, currency: 'RUB' },
      packages: [{ name: 'Съёмка 8 часов', includes: ['Ретушь', '500 фотографий'], price: { amount: 10000000, currency: 'RUB' } }],
    } })
    expect(result.statusCode, result.body).toBe(200)
    const publish = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    expect(publish.statusCode, publish.body).toBe(200)
    const profile = result.json() as { id: string; packages: { id: string }[] }
    return { ...user, vendorId: profile.id, packageId: profile.packages[0]!.id }
  }
  async function member(wedding: Wedding, role: 'couple' | 'helper' | 'coordinator') {
    const user = await newUser()
    const invite = await app.inject({ method: 'POST', url: `/weddings/${wedding.weddingId}/invites`,
      headers: auth(wedding.token), payload: { role, label: `accept-${role}` } })
    expect(invite.statusCode, invite.body).toBe(201)
    const joined = await app.inject({ method: 'POST', url: `/invites/${invite.json().code as string}/accept`, headers: auth(user.token) })
    expect(joined.statusCode, joined.body).toBe(200)
    return user
  }
  const offerBody = { kind: 'offer', title: 'Индивидуальная съёмка', includes: ['9 часов', 'Ретушь'],
    price: { amount: 7654321, currency: 'RUB' }, message: 'Договорённость', validUntil: `${TEST_YEAR}-06-01` }
  const answer = (f: ReadyOffer, payload: Record<string, unknown> = offerBody) => app.inject({ method: 'POST',
    url: `/vendor/offer-requests/${f.requestId}/offers`, headers: idem(f.vendor.token), payload })
  async function ready(wedding?: Wedding, withPackage = false): Promise<ReadyOffer> {
    const w = wedding ?? await newWedding()
    const vendor = await newVendor()
    const added = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/shortlist/${vendor.vendorId}`, headers: auth(w.token) })
    expect(added.statusCode, added.body).toBe(200)
    const { id: entryId, slotId } = added.json() as { id: string; slotId: string }
    const requested = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/offer-requests`,
      headers: idem(w.token), payload: { entryIds: [entryId] } })
    expect(requested.statusCode, requested.body).toBe(201)
    const requestId = requested.json().results[0].requestId as string
    const f = { wedding: w, vendor, slotId, requestId, offerId: '' }
    const offered = await answer(f, withPackage ? { kind: 'offer', packageId: vendor.packageId,
      price: offerBody.price, validUntil: offerBody.validUntil } : offerBody)
    expect(offered.statusCode, offered.body).toBe(201)
    return { ...f, offerId: offered.json().id as string }
  }
  const accept = (f: ReadyOffer, key = randomUUID(), token = f.wedding.token) => app.inject({ method: 'POST',
    url: `/weddings/${f.wedding.weddingId}/offers/${f.offerId}/accept`, headers: idem(token, key) })
  const rows = async (sql: string, values: unknown[]) => (await app.db!.query(sql, values)).rows
  const assertError = (response: { statusCode: number; body: string; json: () => { error: { code: string } } }, code: string, status = 409) => {
    expect(response.statusCode, response.body).toBe(status)
    expect(response.json().error.code).toBe(code)
  }

  async function findPersonalValueEverywhere(value: string): Promise<string[]> {
    const { rows: columns } = await app.db!.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('uuid', 'text', 'character varying', 'json', 'jsonb')
        order by table_name, column_name`,
    )
    const found: string[] = []
    for (const c of columns) {
      if (c.table_name === 'audit_log' || c.table_name === 'pgmigrations') continue
      const json = c.data_type === 'json' || c.data_type === 'jsonb'
      const cast = c.data_type === 'uuid' ? '::text' : ''
      const where = json
        ? `position($1 in "${c.column_name}"::text) > 0`
        : `"${c.column_name}"${cast} = $1`
      const { rows } = await app.db!.query<{ n: string }>(
        `select count(*)::text as n from "${c.table_name}" where ${where}`,
        [value],
      )
      if (Number(rows[0]!.n) > 0) found.push(`${c.table_name}.${c.column_name}`)
    }
    return found
  }

  async function waitForBlocked(client: Queryable, holder: number, expected: number): Promise<void> {
    const deadline = Date.now() + 5000
    for (;;) {
      await client.query('select pg_stat_clear_snapshot()')
      const blocked = await client.query<{ n: number }>(
        `with recursive waiting(pid) as (
           select $1::int union
           select a.pid from pg_stat_activity a join waiting w on w.pid = any(pg_blocking_pids(a.pid))
         ) select count(*)::int as n from waiting where pid <> $1`, [holder])
      if (blocked.rows[0]!.n >= expected) return
      if (Date.now() >= deadline) throw new Error(`Expected ${expected} blocked transactions`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  it('books the exact immutable offer, closes all requests anonymously and replays without duplicates', async () => {
    const f = await ready(undefined, true)
    const other = await ready(f.wedding)
    await app.db!.query("update vendor_packages set name = 'NEW', items = '[\"NEW\"]', price = 1 where id = $1", [f.vendor.packageId])
    const noticesBefore = await rows('select id from notifications where user_id = $1', [other.vendor.id])
    const key = randomUUID()
    const result = await accept(f, key)
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ id: f.slotId, deal: { state: 'booked', price: offerBody.price } })
    const deals = await rows('select * from deals where slot_id = $1', [f.slotId])
    expect(deals).toHaveLength(1)
    expect(deals[0]).toMatchObject({ price: '7654321', package_title_snapshot: 'Съёмка 8 часов',
      package_includes_snapshot: ['Ретушь', '500 фотографий'], vendor_id: f.vendor.vendorId })
    const offers = await rows('select accepted_at, deal_id from offers where id = $1', [f.offerId])
    expect(offers[0]).toEqual({ accepted_at: expect.any(Date), deal_id: deals[0]!.id })
    expect(await rows('select status, close_reason from offer_requests where id = $1', [f.requestId]))
      .toEqual([{ status: 'closed', close_reason: 'booked' }])
    expect(await rows('select status, close_reason from offer_requests where id = $1', [other.requestId]))
      .toEqual([{ status: 'closed', close_reason: 'booked_other' }])
    const notices = await rows('select id, title, body from notifications where user_id = $1 order by created_at', [other.vendor.id])
    expect(notices).toHaveLength(noticesBefore.length + 1)
    expect(notices.at(-1)).toMatchObject({ title: 'Пара выбрала другого исполнителя',
      body: 'Запрос предложения закрыт: пара выбрала другого исполнителя.' })
    const replay = await accept(f, key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(result.json())
    expect(await rows('select id from deals where slot_id = $1', [f.slotId])).toHaveLength(1)
    expect(await rows('select id from notifications where user_id = $1', [other.vendor.id])).toHaveLength(notices.length)
  })

  it('accepts a package snapshot after the live package was deleted', async () => {
    const f = await ready(undefined, true)
    await app.db!.query('delete from vendor_packages where id = $1', [f.vendor.packageId])
    const result = await accept(f)
    expect(result.statusCode, result.body).toBe(200)
    expect(await rows('select package_id, package_title_snapshot, price from deals where slot_id = $1', [f.slotId]))
      .toEqual([{ package_id: null, package_title_snapshot: 'Съёмка 8 часов', price: '7654321' }])
  })

  it.each(['expired', 'stale', 'superseded', 'declined', 'closed', 'unavailable'] as const)('rejects %s offers without side effects', async kind => {
    let f = await ready()
    const codes = { expired: 'offer_expired', stale: 'offer_stale_date', superseded: 'offer_superseded',
      declined: 'offer_declined', closed: 'request_closed', unavailable: 'vendor_unavailable' }
    if (kind === 'expired') await app.db!.query("update offers set valid_until = '2000-01-01' where id = $1", [f.offerId])
    if (kind === 'stale') await app.db!.query('update weddings set date = $2 where id = $1', [f.wedding.weddingId, `${TEST_YEAR}-07-14`])
    if (kind === 'superseded') expect((await answer(f)).statusCode).toBe(201)
    if (kind === 'declined') {
      const decline = await answer(f, { kind: 'decline', message: 'Не смогу' })
      expect(decline.statusCode, decline.body).toBe(201)
      f = { ...f, offerId: decline.json().id as string }
    }
    if (kind === 'closed') await app.db!.query("update offer_requests set status='closed', close_reason='removed', closed_at=now() where id=$1", [f.requestId])
    if (kind === 'unavailable') await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendor.vendorId])
    const before = await rows('select * from offer_requests where id=$1', [f.requestId])
    assertError(await accept(f), codes[kind])
    expect(await rows('select * from offer_requests where id=$1', [f.requestId])).toEqual(before)
    expect(await rows('select id from deals where slot_id=$1', [f.slotId])).toHaveLength(0)
    expect(await rows('select accepted_at,deal_id from offers where id=$1', [f.offerId]))
      .toEqual([{ accepted_at: null, deal_id: null }])
  })

  it('enforces couple-only access and hides another wedding offer', async () => {
    const f = await ready()
    for (const role of ['helper', 'coordinator'] as const) {
      const user = await member(f.wedding, role)
      expect((await accept(f, randomUUID(), user.token)).statusCode).toBe(403)
    }
    expect((await accept(f, randomUUID(), f.vendor.token)).statusCode).toBe(404)
    const other = await newWedding()
    expect((await accept({ ...f, wedding: other })).statusCode).toBe(404)
    expect((await accept({ ...f, offerId: randomUUID() })).statusCode).toBe(404)
    const noKey = await app.inject({ method: 'POST', url: `/weddings/${f.wedding.weddingId}/offers/${f.offerId}/accept`, headers: auth(f.wedding.token) })
    expect(noKey.statusCode, noKey.body).toBe(400)
  })

  it('two partners accepting different offers make exactly one booking', async () => {
    const first = await ready()
    const second = await ready(first.wedding)
    const partner = await member(first.wedding, 'couple')
    await Promise.all(Array.from({ length: 6 }, () => app.db!.query('select pg_sleep(0.02)')))
    let pending: Promise<Awaited<ReturnType<typeof accept>>>[] = []
    try {
      await app.db!.tx(async client => {
        await client.query('select id from weddings where id=$1 for update', [first.wedding.weddingId])
        const holder = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        pending = [accept(first), accept(second, randomUUID(), partner.token)].map(response => Promise.resolve(response))
        await waitForBlocked(client, holder.rows[0]!.pid, 2)
      })
    } finally { await Promise.allSettled(pending) }
    const results = await Promise.all(pending)
    expect(results.map(r => r.statusCode).sort(), results.map(r => r.body).join('\n')).toEqual([200, 409])
    assertError(results.find(r => r.statusCode === 409)!, 'slot_taken')
    expect(await rows('select id from deals where slot_id=$1', [first.slotId])).toHaveLength(1)
    expect(await rows('select id from offers where request_id = any($1::uuid[]) and accepted_at is not null',
      [[first.requestId, second.requestId]])).toHaveLength(1)
  })

  it('concurrent reply and acceptance never mix versions or deadlock', async () => {
    const f = await ready()
    const [accepted, revised] = await Promise.all([accept(f), answer(f, { ...offerBody, title: 'Другие условия', price: { amount: 999, currency: 'RUB' } })])
    expect([200, 409]).toContain(accepted.statusCode)
    expect([201, 409]).toContain(revised.statusCode)
    if (accepted.statusCode === 200) {
      assertError(revised, 'request_closed')
      expect(await rows('select price,package_title_snapshot from deals where slot_id=$1', [f.slotId]))
        .toEqual([{ price: '7654321', package_title_snapshot: 'Индивидуальная съёмка' }])
    } else {
      assertError(accepted, 'offer_superseded')
      expect(revised.statusCode).toBe(201)
      expect(await rows('select id from deals where slot_id=$1', [f.slotId])).toHaveLength(0)
    }
  })

  it('busy date rolls back closure, notifications and acceptance, allowing the same key to retry', async () => {
    const f = await ready()
    await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source) values ($1,$2,'manual')", [f.vendor.vendorId, `${TEST_YEAR}-06-14`])
    const key = randomUUID()
    assertError(await accept(f, key), 'date_taken')
    expect(await rows('select status from offer_requests where id=$1', [f.requestId])).toEqual([{ status: 'open' }])
    expect(await rows('select id from deals where slot_id=$1', [f.slotId])).toHaveLength(0)
    await app.db!.query("delete from vendor_busy_dates where vendor_id=$1 and source='manual'", [f.vendor.vendorId])
    expect((await accept(f, key)).statusCode).toBe(200)
  })

  it('validUntil is inclusive in the wedding timezone, not the UTC day', async () => {
    for (const tz of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
      const f = await ready()
      await app.db!.query('update weddings set tz=$2 where id=$1', [f.wedding.weddingId, tz])
      await app.db!.query('update offers set valid_until=(clock_timestamp() at time zone $2)::date where id=$1', [f.offerId, tz])
      expect((await accept(f)).statusCode).toBe(200)
      const old = await ready()
      await app.db!.query('update weddings set tz=$2 where id=$1', [old.wedding.weddingId, tz])
      await app.db!.query('update offers set valid_until=(clock_timestamp() at time zone $2)::date - 1 where id=$1', [old.offerId, tz])
      assertError(await accept(old), 'offer_expired')
    }
  })

  it.each([true, false])('date assignment/change closes requests; unchanged date does not (first=%s)', async first => {
    const f = await ready(await newWedding(first ? null : `${TEST_YEAR}-06-14`))
    if (!first) {
      const same = await app.inject({ method: 'POST', url: `/weddings/${f.wedding.weddingId}/reschedule`,
        headers: idem(f.wedding.token), payload: { date: `${TEST_YEAR}-06-14` } })
      expect(same.statusCode, same.body).toBe(200)
      expect(await rows('select status from offer_requests where id=$1', [f.requestId])).toEqual([{ status: 'open' }])
    }
    const result = await app.inject({ method: 'PATCH', url: `/weddings/${f.wedding.weddingId}`,
      headers: auth(f.wedding.token), payload: { date: `${TEST_YEAR}-07-14` } })
    expect(result.statusCode, result.body).toBe(200)
    expect(await rows('select status,close_reason from offer_requests where id=$1', [f.requestId]))
      .toEqual([{ status: 'closed', close_reason: 'date_changed' }])
    assertError(await accept(f), 'offer_stale_date')
    expect(await rows("select id from notifications where user_id=$1 and title='Дата свадьбы изменилась'", [f.vendor.id])).toHaveLength(1)
  })

  it('a cancellation request leaves offers open until the second partner confirms', async () => {
    const f = await ready()
    const partner = await member(f.wedding, 'couple')
    const cancel = (token: string) => app.inject({ method: 'POST', url: `/weddings/${f.wedding.weddingId}/cancel`, headers: auth(token) })
    const pending = await cancel(f.wedding.token)
    expect(pending.json()).toMatchObject({ state: 'confirmation_required' })
    expect(await rows('select status from offer_requests where id=$1', [f.requestId])).toEqual([{ status: 'open' }])
    expect((await cancel(partner.token)).json()).toMatchObject({ state: 'cancelled' })
    expect(await rows('select status,close_reason from offer_requests where id=$1', [f.requestId]))
      .toEqual([{ status: 'closed', close_reason: 'wedding_cancelled' }])
    expect(await rows("select id from notifications where user_id=$1 and title='Свадьба отменена'", [f.vendor.id])).toHaveLength(1)
    expect((await accept(f)).statusCode).toBe(404)
  })

  it('package deletion holding the vendor lock cannot deadlock acceptance', async () => {
    const f = await ready(undefined, true)
    await Promise.all(Array.from({ length: 5 }, () => app.db!.query('select pg_sleep(0.02)')))
    let pending: Promise<Awaited<ReturnType<typeof accept>>> | undefined
    try {
      await app.db!.tx(async client => {
        await client.query('select id from vendors where id=$1 for update', [f.vendor.vendorId])
        const holder = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        pending = Promise.resolve(accept(f))
        await waitForBlocked(client, holder.rows[0]!.pid, 1)
        // FK SET NULL updates offers while accept owns request, not offer, locks.
        await client.query('delete from vendor_packages where id=$1', [f.vendor.packageId])
      })
    } finally { if (pending) await Promise.allSettled([pending]) }
    const result = await pending!
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ deal: { packageName: 'Съёмка 8 часов',
      packageIncludes: ['Ретушь', '500 фотографий'], price: offerBody.price } })
  })

  it('deleting the offer, package and vendor never erases the booked terms; helpers see no negotiated text', async () => {
    const f = await ready(undefined, true)
    const helper = await member(f.wedding, 'helper')
    const coordinator = await member(f.wedding, 'coordinator')
    const accepted = await accept(f)
    expect(accepted.statusCode, accepted.body).toBe(200)
    const dealId = accepted.json().deal.id as string
    const terms = { id: dealId, packageName: 'Съёмка 8 часов', packageIncludes: ['Ретушь', '500 фотографий'], price: offerBody.price }
    await app.db!.query('delete from offers where id=$1', [f.offerId])
    await app.db!.query('delete from vendor_packages where id=$1', [f.vendor.packageId])
    const vendorView = await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(f.vendor.token) })
    expect(vendorView.statusCode, vendorView.body).toBe(200)
    expect(vendorView.json().items).toEqual(expect.arrayContaining([expect.objectContaining(terms)]))
    const read = (token: string) => app.inject({ method: 'GET', url: `/weddings/${f.wedding.weddingId}/slots`, headers: auth(token) })
    for (const user of [helper, coordinator]) {
      const view = await read(user.token)
      expect(view.statusCode, view.body).toBe(200)
      const slot = (view.json() as { id: string; deal: object }[]).find(item => item.id === f.slotId)!
      for (const field of ['price', 'paid', 'packageName', 'packageIncludes']) expect(slot.deal).not.toHaveProperty(field)
      expect(view.body).not.toContain('Съёмка 8 часов')
    }
    await app.db!.tx(client => eraseUser(client, f.vendor.id))
    const coupleView = await read(f.wedding.token)
    expect(coupleView.statusCode, coupleView.body).toBe(200)
    expect(coupleView.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.slotId, deal: expect.objectContaining(terms) })]))
  })

  it.each(['catalog', 'external'] as const)('%s booking also closes requests and notifies other vendors', async kind => {
    const f = await ready()
    const other = await ready(f.wedding)
    const before = await rows('select id from notifications where user_id=$1', [other.vendor.id])
    const result = await app.inject({ method: 'POST',
      url: `/weddings/${f.wedding.weddingId}/slots/${f.slotId}/${kind === 'catalog' ? 'book' : 'external'}`,
      headers: idem(f.wedding.token), payload: kind === 'catalog'
        ? { vendorId: f.vendor.vendorId, price: offerBody.price }
        : { vendorName: 'Свой фотограф', price: offerBody.price },
    })
    expect(result.statusCode, result.body).toBe(200)
    expect(await rows('select close_reason from offer_requests where id=$1', [f.requestId]))
      .toEqual([{ close_reason: kind === 'catalog' ? 'booked' : 'booked_other' }])
    expect(await rows('select close_reason from offer_requests where id=$1', [other.requestId]))
      .toEqual([{ close_reason: 'booked_other' }])
    expect(await rows('select id from notifications where user_id=$1', [other.vendor.id])).toHaveLength(before.length + 1)
    expect(await rows('select id from offers where request_id=any($1::uuid[]) and accepted_at is not null', [[f.requestId, other.requestId]])).toEqual([])
  })

  it('a refused reschedule rolls back request closure and its notifications', async () => {
    const f = await ready()
    const other = await ready(f.wedding)
    const accepted = await accept(f)
    expect(accepted.statusCode, accepted.body).toBe(200)
    // A different free slot has an outstanding request; a booked photo vendor is busy on the new date.
    const otherSlot = (await rows("select id from slots where wedding_id=$1 and category_id <> 'photo' limit 1", [f.wedding.weddingId]))[0]!.id
    await app.db!.query("update offer_requests set slot_id=$2,status='open',close_reason=null,closed_at=null where id=$1", [other.requestId, otherSlot])
    await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual')", [f.vendor.vendorId, `${TEST_YEAR}-07-14`])
    const before = await rows('select id from notifications where user_id=$1', [other.vendor.id])
    const moved = await app.inject({ method: 'POST', url: `/weddings/${f.wedding.weddingId}/reschedule`,
      headers: idem(f.wedding.token), payload: { date: `${TEST_YEAR}-07-14` } })
    assertError(moved, 'team_busy')
    expect(await rows('select status,close_reason from offer_requests where id=$1', [other.requestId]))
      .toEqual([{ status: 'open', close_reason: null }])
    expect(await rows('select id from notifications where user_id=$1', [other.vendor.id])).toHaveLength(before.length)
  })

  it('T039 erases open vendor offer text and keeps accepted snapshot', async () => {
    const accepted = await ready(undefined, true)
    const pending = await ready(accepted.wedding)
    await app.db!.tx(client => eraseUser(client, pending.vendor.id))
    expect(await rows('select vendor_id, status, close_reason from offer_requests where id = $1', [pending.requestId]))
      .toEqual([{ vendor_id: null, status: 'closed', close_reason: 'booked_other' }])
    expect(await rows('select id from offers where request_id = $1', [pending.requestId])).toEqual([])
    for (const erased of [
      pending.vendor.id,
      pending.vendor.phone,
      `Accept ${pending.vendor.id}`,
      offerBody.title,
      offerBody.message,
    ]) {
      expect(await findPersonalValueEverywhere(String(erased))).toEqual([])
    }
    expect((await accept(accepted)).statusCode).toBe(200)
    await app.db!.tx(client => eraseUser(client, accepted.vendor.id))
    expect(await rows('select vendor_id, package_title_snapshot, package_includes_snapshot, price from deals where slot_id = $1', [accepted.slotId]))
      .toEqual([{ vendor_id: null, package_title_snapshot: 'Съёмка 8 часов',
        package_includes_snapshot: ['Ретушь', '500 фотографий'], price: '7654321' }])
  })

  it('T039 does not deadlock account erasure against a concurrent vendor reply', async () => {
    const f = await ready()
    let reply: Promise<unknown> | null = null
    let cleanupRun: Promise<unknown> | null = null
    await app.db!.tx(async client => {
      await client.query('select id from vendors where id = $1 for update', [f.vendor.vendorId])
      const { rows: [holder] } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      reply = Promise.resolve(answer(f, { ...offerBody, title: 'Race check' }))
      await waitForBlocked(client, holder!.pid, 1)
      cleanupRun = app.db!.tx(c => eraseUser(c, f.vendor.id))
      await waitForBlocked(client, holder!.pid, 2)
    })
    const settled = await Promise.allSettled([reply!, cleanupRun!])
    expect(settled.every(x => x.status === 'fulfilled')).toBe(true)
    expect(await rows('select id from offers where request_id = $1', [f.requestId])).toEqual([])
    expect(await rows('select vendor_id, status, close_reason from offer_requests where id = $1', [f.requestId]))
      .toEqual([{ vendor_id: null, status: 'closed', close_reason: 'vendor_erased' }])
  })

  it('T040 exports couple offer data and vendor own offer data', async () => {
    const f = await ready()
    const coupleDump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(f.wedding.token) })
    expect(coupleDump.statusCode, coupleDump.body).toBe(200)
    expect(coupleDump.json()).toMatchObject({
      shortlist: [expect.objectContaining({ slot_id: f.slotId })],
      offerRequests: [expect.objectContaining({ id: f.requestId })],
      offers: [expect.objectContaining({ request_id: f.requestId, title: 'Индивидуальная съёмка', price: '7654321' })],
    })
    const vendorDump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(f.vendor.token) })
    expect(vendorDump.statusCode, vendorDump.body).toBe(200)
    expect(vendorDump.json()).toMatchObject({
      vendorOfferRequests: [expect.objectContaining({ id: f.requestId })],
      vendorOffers: [expect.objectContaining({ request_id: f.requestId, title: 'Индивидуальная съёмка' })],
    })
  })

})
