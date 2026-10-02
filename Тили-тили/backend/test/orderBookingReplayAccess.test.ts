import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'test-booking-replay-access-key'.repeat(3), POLICY = '2026-09-02'
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`
const DOORS = ['slots.book', 'offer-requests.create', 'offers.accept'] as const
const CHANGES = ['member_removed', 'role_changed', 'session_revoked', 'consent_withdrawn', 'user_deleted', 'wedding_archived', 'wedding_cancelled'] as const
type Door = typeof DOORS[number]
type Change = typeof CHANGES[number]

describe.skipIf(!DB)('booking saved replies recheck current authority after actual PostgreSQL waiting', () => {
  let app: FastifyInstance
  const weddings: string[] = [], users: string[] = []
  const witnesses: { door: Door; change: string; holderPid: number; waitingPid: number; lockKind: string }[] = []
  const prefix = String(randomInt(100_000, 999_999)); let seq = 0
  beforeAll(async () => {
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort())
    assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_booking_replay_20260930_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'test-refresh-booking-replay-key'.repeat(3), policyVersion: POLICY })
    await app.ready()
    expect((await app.db!.query<{ name: string }>('select current_database() as name')).rows[0]!.name).toBe(target.pathname.slice(1))
  })
  afterAll(async () => {
    if (!app) return
    try {
      process.stdout.write(`BOOKING_REPLAY_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  // Authentication rows are explicit synthetic fixtures. Every saved business
  // result below comes from the actual registered HTTP handler, never saveResult.
  async function actor() {
    const userId = randomUUID(), sessionId = randomUUID(); users.push(userId)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Replay fixture person')", [userId, `+79${prefix}${String(++seq).padStart(3, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    return { userId, sessionId, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor, key: string) => ({ ...auth(a), 'idempotency-key': key })
  async function fixture(door: Door, owner?: Actor) {
    const couple = owner ?? await actor(), vendorOwner = await actor()
    const weddingId = randomUUID(), slotId = randomUUID(), otherSlotId = randomUUID(), vendorId = randomUUID()
    weddings.push(weddingId)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Private replay wedding',$3,'Europe/Moscow',$4)", [weddingId, couple.userId, DATE, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, couple.userId])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Private replay studio',now())", [vendorId, vendorOwner.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label,sort) values($1,$3,'photo','Private position',1),($2,$3,'photo','Other position',2)", [slotId, otherSlotId, weddingId])
    const shortlisted = await app.inject({ method: 'PUT', url: `/weddings/${weddingId}/shortlist/${vendorId}`, headers: auth(couple) })
    expect(shortlisted.statusCode, shortlisted.body).toBe(200)
    const entryId = shortlisted.json().id as string
    let offerId: string | null = null, requestId: string | null = null
    if (door === 'offers.accept') {
      const requested = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${slotId}/offer-requests`, headers: idem(couple, randomUUID()),
        payload: { entryIds: [entryId], wishes: 'Private offer wishes', budgetHint: { amount: 25000, currency: 'RUB' } } })
      expect(requested.statusCode, requested.body).toBe(201)
      expect(requested.json().results[0].status).toBe('sent')
      requestId = requested.json().results[0].requestId as string
      const offered = await app.inject({ method: 'POST', url: `/vendor/offer-requests/${requestId}/offers`, headers: idem(vendorOwner, randomUUID()),
        payload: { kind: 'offer', title: 'Private negotiated package', price: { amount: 24000, currency: 'RUB' }, includes: ['Private gallery'], message: 'Private negotiated message', validUntil: DATE } })
      expect(offered.statusCode, offered.body).toBe(201)
      offerId = offered.json().id as string
    }
    return { owner: couple, vendorOwner, weddingId, slotId, otherSlotId, vendorId, entryId, requestId, offerId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function command(w: Fixture, door: Door) {
    if (door === 'slots.book') return { url: `/weddings/${w.weddingId}/slots/${w.slotId}/book`, payload: { vendorId: w.vendorId, price: { amount: 22000, currency: 'RUB' } } }
    if (door === 'offer-requests.create') return { url: `/weddings/${w.weddingId}/slots/${w.slotId}/offer-requests`, payload: { entryIds: [w.entryId], wishes: 'Private offer wishes', budgetHint: { amount: 25000, currency: 'RUB' } } }
    return { url: `/weddings/${w.weddingId}/offers/${w.offerId}/accept` }
  }
  function invoke(w: Fixture, door: Door, key: string, caller = w.owner, override?: { url?: string; payload?: Record<string, unknown> }) {
    return app.inject({ method: 'POST', ...command(w, door), ...override, headers: idem(caller, key) }).then(r => r)
  }
  async function saved(w: Fixture, door: Door, key: string) {
    return (await app.db!.query('select key,user_id,route,request_hash,status,body,created_at from idempotency_keys where key=$1', [`${w.owner.userId}:${door}:${key}`])).rows[0]
  }
  async function state(w: Fixture) {
    const result = await Promise.all([
      app.db!.query('select * from deals where wedding_id=$1 order by id', [w.weddingId]),
      app.db!.query('select p.* from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1 order by p.id', [w.weddingId]),
      app.db!.query('select * from slots where wedding_id=$1 order by id', [w.weddingId]),
      app.db!.query('select * from deal_orders where wedding_id=$1 order by deal_id', [w.weddingId]),
      app.db!.query('select * from vendor_busy_dates where vendor_id=$1 order by date', [w.vendorId]),
      app.db!.query('select r.* from offer_requests r join slots s on s.id=r.slot_id where s.wedding_id=$1 order by r.id', [w.weddingId]),
      app.db!.query('select o.* from offers o join offer_requests r on r.id=o.request_id join slots s on s.id=r.slot_id where s.wedding_id=$1 order by o.id', [w.weddingId]),
      app.db!.query('select e.* from deal_events e join deals d on d.id=e.deal_id where d.wedding_id=$1 order by e.id', [w.weddingId]),
      app.db!.query('select * from notifications where user_id=any($1::uuid[]) order by id', [[w.owner.userId, w.vendorOwner.userId]]),
      app.db!.query('select * from audit_log where actor_id=any($1::uuid[]) order by id', [[w.owner.userId, w.vendorOwner.userId]]),
      app.db!.query('select * from idempotency_keys where user_id=any($1::uuid[]) order by key', [[w.owner.userId, w.vendorOwner.userId]]),
      app.db!.query('select * from leads where vendor_id=$1 order by id', [w.vendorId]),
      app.db!.query('select * from external_invites where wedding_id=$1 order by token', [w.weddingId]),
    ])
    return result.map(r => r.rows)
  }
  async function mutate(c: Queryable, w: Fixture, change: Change) {
    if (change === 'member_removed') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.owner.userId])
    if (change === 'role_changed') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [w.weddingId, w.owner.userId])
    if (change === 'session_revoked') await c.query('update sessions set revoked_at=clock_timestamp() where id=$1', [w.owner.sessionId])
    if (change === 'consent_withdrawn') await c.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1', [w.owner.userId])
    if (change === 'user_deleted') await c.query('update users set deleted_at=clock_timestamp() where id=$1', [w.owner.userId])
    if (change === 'wedding_archived') await c.query('update weddings set archived_at=clock_timestamp() where id=$1', [w.weddingId])
    if (change === 'wedding_cancelled') await c.query('update weddings set cancelled_at=clock_timestamp() where id=$1', [w.weddingId])
  }
  function refusal(response: Awaited<ReturnType<typeof invoke>>, status: number) {
    expect(response.statusCode, response.body).toBe(status)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    expect(Object.keys(response.json())).toEqual(['error'])
    for (const privateText of ['Private replay studio', 'Private position', 'Private negotiated package', 'Private gallery', 'Private offer wishes']) expect(response.body).not.toContain(privateText)
  }
  async function whileLocked(w: Fixture, door: Door, change: string, request: () => ReturnType<typeof invoke>, mutation: (c: Queryable) => Promise<unknown>) {
    let ready!: () => void, release!: () => void, holderPid = 0
    const start = new Promise<void>(r => { ready = r }), finish = new Promise<void>(r => { release = r })
    const holder = app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query('select id from weddings where id=$1 for update', [w.weddingId])
      ready(); await finish; await mutation(c)
    })
    await start
    let done = false
    const response = request().then(r => { done = true; return r })
    try {
      let observed: { pid: number; wait_event: string } | undefined
      const deadline = Date.now() + 3000
      while (!done && Date.now() < deadline) {
        observed = (await app.db!.query<{ pid: number; wait_event: string }>(`select pid,wait_event from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and query ilike '%weddings%'`, [holderPid])).rows[0]
        if (observed) break
        await new Promise(r => setTimeout(r, 10))
      }
      expect(observed, `No actual PG wedding wait ${door}/${change}, responseFinished=${done}`).toBeDefined()
      witnesses.push({ door, change, holderPid, waitingPid: observed!.pid, lockKind: observed!.wait_event })
    } finally { release(); await holder; await response }
    return response
  }
  async function positive(w: Fixture, door: Door, key: string) {
    const response = await invoke(w, door, key)
    expect(response.statusCode, response.body).toBe(door === 'offer-requests.create' ? 201 : 200)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    expect(await saved(w, door, key)).toMatchObject({ status: response.statusCode, body: response.json() })
    if (door === 'offer-requests.create') expect(response.json().results).toEqual([{ entryId: w.entryId, status: 'sent', requestId: expect.any(String) }])
    else expect(response.json().deal).toMatchObject({ state: 'booked', vendor: { id: w.vendorId }, price: { amount: door === 'slots.book' ? 22000 : 24000, currency: 'RUB' } })
    const ledger = await state(w)
    expect(ledger[0]).toHaveLength(door === 'offer-requests.create' ? 0 : 1)
    expect(ledger[3]).toHaveLength(door === 'offer-requests.create' ? 0 : 1)
    expect(ledger[4]).toHaveLength(door === 'offer-requests.create' ? 0 : 1)
    expect(ledger[5]).toHaveLength(door === 'slots.book' ? 0 : 1)
    if (door === 'offers.accept') expect(ledger[6]![0]).toMatchObject({ id: w.offerId, deal_id: response.json().deal.id, accepted_at: expect.any(Date) })
    return response
  }

  it.each(DOORS.flatMap(door => CHANGES.map(change => ({ door, change }))))('saved $door refuses $change after a proven PG wait without disclosure or a duplicate write', async ({ door, change }) => {
    const w = await fixture(door), key = randomUUID()
    await positive(w, door, key)
    const before = await state(w), cache = await saved(w, door, key)
    const status = change === 'session_revoked' || change === 'user_deleted' ? 401 : change === 'role_changed' || change === 'consent_withdrawn' ? 403 : 404
    refusal(await whileLocked(w, door, change, () => invoke(w, door, key), c => mutate(c, w, change)), status)
    expect(await state(w)).toEqual(before); expect(await saved(w, door, key)).toEqual(cache)
  })
  it.each(DOORS)('valid %s retry returns the original body without duplicate ledger records', async door => {
    const w = await fixture(door), key = randomUUID(), original = await positive(w, door, key)
    if (door !== 'offer-requests.create') {
      const paid = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${w.slotId}/pay`, headers: idem(w.owner, randomUUID()), payload: { amount: { amount: 1000, currency: 'RUB' } } })
      expect(paid.statusCode, paid.body).toBe(200)
    }
    const before = await state(w)
    if (door !== 'offer-requests.create') expect(before[1]).toHaveLength(1)
    for (let n = 0; n < 2; n++) {
      const retry = await invoke(w, door, key)
      expect(retry.statusCode, retry.body).toBe(original.statusCode)
      expect(retry.headers['idempotent-replay']).toBe('true'); expect(retry.json()).toEqual(original.json())
      expect(await state(w)).toEqual(before)
    }
  })
  it.each(DOORS)('%s saved key rejects a changed body with 409 and preserves the saved result', async door => {
    const w = await fixture(door), key = randomUUID(); await positive(w, door, key)
    const before = await state(w)
    const payload = door === 'slots.book' ? { vendorId: w.vendorId, price: { amount: 23000, currency: 'RUB' } } : door === 'offer-requests.create' ? { entryIds: [w.entryId], wishes: 'Different request' } : {}
    const response = await invoke(w, door, key, w.owner, { payload })
    refusal(response, 409); expect(response.json().error.code).toBe('idempotency_key_reused')
    expect(await state(w)).toEqual(before)
  })
  it.each(DOORS)('%s saved key rejects a changed path inside the same accessible wedding', async door => {
    const w = await fixture(door), key = randomUUID(); await positive(w, door, key)
    const before = await state(w)
    const url = door === 'offers.accept' ? `/weddings/${w.weddingId}/offers/${randomUUID()}/accept` : command(w, door).url.replace(w.slotId, w.otherSlotId)
    const response = await invoke(w, door, key, w.owner, { url })
    refusal(response, 409); expect(response.json().error.code).toBe('idempotency_key_reused')
    expect(await state(w)).toEqual(before)
  })
  it.each(DOORS)('%s saved key and private body cannot be retrieved by another live actor', async door => {
    const w = await fixture(door), key = randomUUID(), stranger = await actor(); await positive(w, door, key)
    const before = await state(w)
    refusal(await invoke(w, door, key, stranger), 404)
    expect(await state(w)).toEqual(before)
    expect((await app.db!.query('select key from idempotency_keys where user_id=$1', [stranger.userId])).rowCount).toBe(0)
  })
  it.each(DOORS)('%s saved key belongs to its actor even when another current couple member can access the same wedding', async door => {
    const w = await fixture(door), key = randomUUID(), partner = await actor(); await positive(w, door, key)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [w.weddingId, partner.userId])
    const before = await state(w), cache = await saved(w, door, key)
    const response = await invoke(w, door, key, partner)
    refusal(response, 409); expect(response.json().error.code).toBe(door === 'offer-requests.create' ? 'no_request_sent' : 'slot_taken')
    expect(await state(w)).toEqual(before); expect(await saved(w, door, key)).toEqual(cache)
    expect((await app.db!.query('select key from idempotency_keys where user_id=$1', [partner.userId])).rowCount).toBe(0)
  })
  it.each(DOORS)('%s does not replay into another accessible wedding when the path and scoped position change', async door => {
    const w = await fixture(door), other = await fixture(door, w.owner), key = randomUUID(); await positive(w, door, key)
    const before = await state(w), otherBefore = await state(other)
    const response = await invoke(w, door, key, w.owner, command(other, door))
    refusal(response, 409); expect(response.json().error.code).toBe('idempotency_key_reused')
    expect(await state(w)).toEqual(before); expect(await state(other)).toEqual(otherBefore)
  })
  it('saved offer acceptance checks that its offer still belongs to the locked wedding after waiting', async () => {
    const w = await fixture('offers.accept'), key = randomUUID(); await positive(w, 'offers.accept', key)
    const cache = await saved(w, 'offers.accept', key), original = await state(w)
    await whileLocked(w, 'offers.accept', 'offer_deleted', () => invoke(w, 'offers.accept', key), c => c.query('delete from offers where id=$1', [w.offerId])).then(r => refusal(r, 404))
    const before = await state(w)
    expect(before).toEqual(original.map((rows, index) => index === 6 ? rows.filter(row => row.id !== w.offerId) : rows))
    refusal(await invoke(w, 'offers.accept', key), 404)
    expect(await state(w)).toEqual(before); expect(await saved(w, 'offers.accept', key)).toEqual(cache)
    expect(before[0]).toHaveLength(1); expect(before[1]).toHaveLength(0); expect(before[4]).toHaveLength(1)
  })
  it.each(DOORS)('fresh %s operation refuses a revoked session after a witnessed wedding wait and leaves no incomplete key', async door => {
    const w = await fixture(door), key = randomUUID(), before = await state(w)
    refusal(await whileLocked(w, door, 'fresh_session_revoked', () => invoke(w, door, key), c => mutate(c, w, 'session_revoked')), 401)
    expect(await state(w)).toEqual(before); expect(await saved(w, door, key)).toBeUndefined()
  })
})
