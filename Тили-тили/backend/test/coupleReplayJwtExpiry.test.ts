import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js'
import { AppError } from '../src/errors.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'synthetic-couple-replay-expiry-key'.repeat(3)
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`
const PRUNE_QUERY = "delete from idempotency_keys where created_at < now() - interval '1 day'"
const DOORS = ['slots.book', 'slots.replace', 'slots.cancel', 'slots.pay', 'offer-requests.create', 'offers.accept', 'deals.patch'] as const
type Door = typeof DOORS[number]
type Actor = { userId: string; sessionId: string; consentId: string; token: string }
type Company = { vendorId: string; packageId: string; owner: Actor }
type Fixture = { owner: Actor; companies: Company[]; weddingId: string; slotId: string; entryId: string; nonce: string; dealId?: string; offerId?: string }
type Command = { method: 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }
type Wait = { pid: number; query: string; wait_event: string; blockers: number[] }
type PinnedRow = { key: string; digest: string }
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

// These seven registered doors must fail closed when their original live JWT
// expires after preHandler, without repeating an already committed writer.
describe.sequential('couple saved replies refuse genuine JWT expiry after an actual initial PostgreSQL wait', () => {
  let app: FastifyInstance, sentinel: Fixture
  let priorAudits: PinnedRow[] = [], priorReceipts: PinnedRow[] = []
  const users: string[] = [], sessions: string[] = [], consents: string[] = [], weddings: string[] = [], vendors: string[] = []
  const witnesses: { door: Door; userId: string; sessionId: string; scopedKey: string; holderPid: number;
    waiting: Wait; beforeReleaseWaiting: Wait; exp: number; issuedAfterLockAtMs: number;
    verifiedBeforeInvokeAtMs: number; verifiedAfterWaitAtMs: number; expiredVerifiedAtMs: number }[] = []

  beforeAll(async () => {
    assert(DB, 'TEST_DATABASE_URL is mandatory for the seven genuine replay-expiry regressions')
    assert.equal(process.env.DATABASE_URL, DB, 'DATABASE_URL must equal the approved TEST_DATABASE_URL')
    const target = new URL(DB)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert.equal(target.pathname, '/tili_ecosystem_full_20260930_test')
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'synthetic-couple-replay-expiry-refresh'.repeat(3), policyVersion: POLICY })
    await app.ready()
    expect((await app.db!.query<{ name: string }>('select current_database() name')).rows[0]!.name).toBe(target.pathname.slice(1))
    priorAudits = await pinAudits()
    priorReceipts = await pinReceipts()
    sentinel = await fixture('slots.book')
    await saveFirst(sentinel, 'slots.book', randomUUID())
  })

  afterAll(async () => {
    if (!app) return
    try {
      process.stdout.write(`COUPLE_REPLAY_JWT_EXPIRY_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      // Exact owned UUIDs only. Immutable audit rows, including our own audit
      // history, are retained; no pre-existing row or schema is deleted.
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
      for (const [table, ids] of [['weddings', weddings], ['vendors', vendors], ['users', users], ['sessions', sessions], ['consents', consents]] as const) {
        expect((await app.db!.query(`select id from ${table} where id=any($1::uuid[])`, [ids])).rows, `Own ${table} fixtures remain`).toEqual([])
      }
      expect((await app.db!.query('select key from idempotency_keys where user_id=any($1::uuid[])', [users])).rows).toEqual([])
      expect((await app.db!.query('select id from notifications where user_id=any($1::uuid[])', [users])).rows).toEqual([])
      await preservePriorRows()
      process.stdout.write('COUPLE_REPLAY_JWT_EXPIRY_CLEANUP completed=true\n')
    } finally { await app.close() }
  })

  async function pinAudits(): Promise<PinnedRow[]> {
    return (await app.db!.query<{ key: string; row: string }>('select id::text as key,to_jsonb(a)::text as row from audit_log a order by id')).rows
      .map(row => ({ key: row.key, digest: sha(row.row) }))
  }
  async function pinReceipts(): Promise<PinnedRow[]> {
    return (await app.db!.query<{ key: string; row: string }>('select key,to_jsonb(i)::text as row from idempotency_keys i order by key')).rows
      .map(row => ({ key: row.key, digest: sha(row.row) }))
  }
  async function preservePriorRows() {
    const audits = new Map((await pinAudits()).map(row => [row.key, row.digest]))
    const receipts = new Map((await pinReceipts()).map(row => [row.key, row.digest]))
    for (const row of priorAudits) expect(audits.get(row.key), 'Pre-existing immutable audit changed').toBe(row.digest)
    for (const row of priorReceipts) expect(receipts.get(row.key), 'Pre-existing receipt changed').toBe(row.digest)
  }

  async function actor(): Promise<Actor> {
    const userId = randomUUID(), sessionId = randomUUID(), consentId = randomUUID()
    let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
      const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`
      inserted = (await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic couple expiry actor') on conflict(phone) do nothing returning id", [userId, phone])).rowCount === 1
    }
    assert(inserted, 'Cannot create an owned actor without borrowing an occupied phone')
    users.push(userId); sessions.push(sessionId); consents.push(consentId)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    return { userId, sessionId, consentId, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  const auth = (a: Actor, key?: string) => ({ authorization: `Bearer ${a.token}`, ...(key ? { 'idempotency-key': key } : {}) })
  async function company(nonce: string, name: string): Promise<Company> {
    const owner = await actor(), vendorId = randomUUID(), packageId = randomUUID(); vendors.push(vendorId)
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo',$3,now())", [vendorId, owner.userId, `Private expiry studio ${name} ${nonce}`])
    await app.db!.query('insert into vendor_packages(id,vendor_id,name,price,items) values($1,$2,$3,24000,$4::jsonb)',
      [packageId, vendorId, `Private expiry package ${name} ${nonce}`, JSON.stringify([`Private expiry gallery ${name} ${nonce}`])])
    return { owner, vendorId, packageId }
  }
  async function fixture(door: Door): Promise<Fixture> {
    const owner = await actor(), nonce = randomUUID(), companies = [await company(nonce, 'A'), await company(nonce, 'B')]
    const weddingId = randomUUID(), slotId = randomUUID(); weddings.push(weddingId)
    await app.db!.query('insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,$3,$4,\'Europe/Moscow\',$5)',
      [weddingId, owner.userId, `Private expiry wedding ${nonce}`, DATE, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo',$3)", [slotId, weddingId, `Private expiry position ${nonce}`])
    const selected = await app.inject({ method: 'PUT', url: `/weddings/${weddingId}/shortlist/${companies[0]!.vendorId}`, headers: auth(owner) })
    expect(selected.statusCode, selected.body).toBe(200)
    const f: Fixture = { owner, companies, nonce, weddingId, slotId, entryId: selected.json().id as string }
    if (door === 'offers.accept') {
      const requested = await app.inject({ ...command(f, 'offer-requests.create'), headers: auth(owner, randomUUID()) })
      expect(requested.statusCode, requested.body).toBe(201)
      expect(requested.json().results).toEqual([{ entryId: f.entryId, status: 'sent', requestId: expect.any(String) }])
      const requestId = requested.json().results[0].requestId as string
      const offered = await app.inject({ method: 'POST', url: `/vendor/offer-requests/${requestId}/offers`, headers: auth(companies[0]!.owner, randomUUID()),
        payload: { kind: 'offer', packageId: companies[0]!.packageId, price: { amount: 24000, currency: 'RUB' },
          message: `Private expiry quoted message ${nonce}`, validUntil: DATE,
          comparisonTerms: { hours: `Private expiry quoted hours ${nonce}`, team: null, result: null, delivery: null, extras: null, cancellation: null, reschedule: null } } })
      expect(offered.statusCode, offered.body).toBe(201)
      f.offerId = offered.json().id as string
    } else if (['slots.replace', 'slots.cancel', 'slots.pay', 'deals.patch'].includes(door)) {
      const booked = await invoke(f, 'slots.book', randomUUID())
      expect(booked.statusCode, booked.body).toBe(200)
      expect(booked.json().deal).toMatchObject({ id: expect.any(String), state: 'booked' })
      f.dealId = booked.json().deal.id as string
    }
    return f
  }
  function command(f: Fixture, door: Door): Command {
    const first = f.companies[0]!, next = f.companies[1]!
    if (door === 'offer-requests.create') return { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/offer-requests`,
      payload: { entryIds: [f.entryId], wishes: `Private expiry wishes ${f.nonce}`, budgetHint: { amount: 25000, currency: 'RUB' } } }
    if (door === 'offers.accept') { assert(f.offerId); return { method: 'POST', url: `/weddings/${f.weddingId}/offers/${f.offerId}/accept` } }
    if (door === 'deals.patch') { assert(f.dealId); return { method: 'PATCH', url: `/deals/${f.dealId}`, payload: { state: 'cancelled', note: `Private expiry cancellation ${f.nonce}` } } }
    if (door === 'slots.book') return { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`,
      payload: { vendorId: first.vendorId, packageId: first.packageId, price: { amount: 22000, currency: 'RUB' } } }
    if (door === 'slots.replace') { assert(f.dealId); return { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/replace`,
      payload: { expectedSelectedDealId: f.dealId, expectedSelectedDealState: 'booked', vendorId: next.vendorId, packageId: next.packageId,
        price: { amount: 32000, currency: 'RUB' }, expectedPolicyRevision: '0' } } }
    if (door === 'slots.pay') return { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/pay`, payload: { amount: { amount: 700, currency: 'RUB' } } }
    return { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/cancel` }
  }
  function invoke(f: Fixture, door: Door, key: string, caller = f.owner) {
    return app.inject({ ...command(f, door), headers: auth(caller, key) }).then(response => response)
  }
  const storedKey = (f: Fixture, door: Door, key: string) => `${f.owner.userId}:${door}:${key}`
  async function receipt(f: Fixture, door: Door, key: string) {
    return (await app.db!.query<{ row: string }>('select to_jsonb(i)::text as row from idempotency_keys i where key=$1', [storedKey(f, door, key)])).rows[0]?.row
  }
  async function saveFirst(f: Fixture, door: Door, key: string) {
    const response = await invoke(f, door, key)
    expect(response.statusCode, response.body).toBe(door === 'offer-requests.create' ? 201 : 200)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    const saved = (await app.db!.query('select user_id,route,status,body from idempotency_keys where key=$1', [storedKey(f, door, key)])).rows[0]
    expect(saved).toEqual({ user_id: f.owner.userId, route: door, status: response.statusCode, body: response.json() })
    const deals = (await app.db!.query<{ id: string; state: string; vendor_id: string | null; price: string }>('select id,state,vendor_id,price::text from deals where wedding_id=$1 order by id', [f.weddingId])).rows
    if (door === 'offer-requests.create') {
      expect(response.json().results).toEqual([{ entryId: f.entryId, status: 'sent', requestId: expect.any(String) }]); expect(deals).toEqual([])
    } else if (door === 'slots.replace') {
      expect(deals).toHaveLength(2); expect(deals.find(row => row.id === f.dealId)?.state).toBe('cancelled')
      expect(deals.filter(row => row.state === 'booked')).toEqual([{ id: response.json().deal.id, state: 'booked', vendor_id: f.companies[1]!.vendorId, price: '32000' }])
    } else {
      expect(deals).toHaveLength(1)
      expect(deals[0]!.state).toBe(door === 'slots.cancel' || door === 'deals.patch' ? 'cancelled' : door === 'slots.pay' ? 'paid_deposit' : 'booked')
      if (door === 'slots.cancel' || door === 'deals.patch') expect((await app.db!.query('select deal_id from slots where id=$1', [f.slotId])).rows).toEqual([{ deal_id: null }])
      if (door === 'slots.pay') expect((await app.db!.query('select amount::text,status from payments where deal_id=$1', [f.dealId])).rows).toEqual([{ amount: '700', status: 'recorded' }])
      if (door === 'offers.accept') expect((await app.db!.query('select deal_id,accepted_at is not null accepted from offers where id=$1', [f.offerId])).rows).toEqual([{ deal_id: deals[0]!.id, accepted: true }])
    }
    return response
  }

  async function state(f: Fixture) {
    const actorIds = [f.owner.userId, ...f.companies.map(company => company.owner.userId)], companyIds = f.companies.map(company => company.vendorId)
    const tables: readonly [string, string, readonly unknown[]][] = [
      ['weddings', 'id=$1', [f.weddingId]], ['wedding_events', 'wedding_id=$1', [f.weddingId]], ['wedding_members', 'wedding_id=$1', [f.weddingId]],
      ['slots', 'wedding_id=$1', [f.weddingId]], ['slot_shortlist', 'slot_id=$1', [f.slotId]], ['deals', 'wedding_id=$1', [f.weddingId]],
      ['deal_orders', 'wedding_id=$1', [f.weddingId]], ['order_assignments', 'wedding_id=$1', [f.weddingId]], ['order_parts', 'wedding_id=$1', [f.weddingId]],
      ['deal_events', 'deal_id in(select id from deals where wedding_id=$1)', [f.weddingId]], ['payments', 'deal_id in(select id from deals where wedding_id=$1)', [f.weddingId]],
      ['payment_installments', 'deal_id in(select id from deals where wedding_id=$1)', [f.weddingId]], ['offer_requests', 'slot_id=$1', [f.slotId]],
      ['offers', 'request_id in(select id from offer_requests where slot_id=$1)', [f.slotId]], ['chats', 'wedding_id=$1', [f.weddingId]],
      ['leads', 'wedding_id=$1', [f.weddingId]], ['external_invites', 'wedding_id=$1', [f.weddingId]], ['bus_routes', 'wedding_id=$1', [f.weddingId]],
      ['vendor_busy_dates', 'vendor_id=any($1::uuid[])', [companyIds]], ['vendor_availability_policy', 'vendor_id=any($1::uuid[])', [companyIds]],
      ['vendors', 'id=any($1::uuid[])', [companyIds]], ['vendor_packages', 'vendor_id=any($1::uuid[])', [companyIds]],
      ['users', 'id=any($1::uuid[])', [actorIds]], ['sessions', 'user_id=any($1::uuid[])', [actorIds]], ['consents', 'user_id=any($1::uuid[])', [actorIds]],
      ['notifications', 'user_id=any($1::uuid[])', [actorIds]], ['audit_log', 'actor_id=any($1::uuid[])', [actorIds]], ['idempotency_keys', 'user_id=any($1::uuid[])', [actorIds]],
    ]
    const result: { table: string; rows: string[] }[] = []
    for (const [table, where, values] of tables) result.push({ table, rows: (await app.db!.query<{ row: string }>(`select to_jsonb(t)::text as row from ${table} t where ${where} order by to_jsonb(t)::text`, values)).rows.map(row => row.row) })
    return result
  }

  async function expiryReplay(f: Fixture, door: Door, key: string) {
    let ready!: () => void, failReady!: (error: unknown) => void, release!: () => void
    let holderPid = 0, caller = f.owner, exp = 0, issuedAfterLockAtMs = 0, verifiedBeforeInvokeAtMs = 0
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject }), released = new Promise<void>(resolve => { release = resolve })
    const holder = app.db!.tx(async client => {
      holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await client.query('lock table idempotency_keys in share mode')
      issuedAfterLockAtMs = Date.now(); exp = Math.floor(issuedAfterLockAtMs / 1000) + 3
      caller = { ...f.owner, token: await signAccessToken(SECRET, { sub: f.owner.userId, sid: f.owner.sessionId }, (exp - ACCESS_TTL_SECONDS) * 1000) }
      expect(await verifyAccessToken(SECRET, caller.token)).toEqual({ sub: f.owner.userId, sid: f.owner.sessionId, exp })
      verifiedBeforeInvokeAtMs = Date.now(); ready(); await released
    })
    void holder.catch(failReady)
    await started
    let done = false
    const response = invoke(f, door, key, caller).then(result => { done = true; return result })
    void response.catch(() => undefined)
    let barrierFailed = false, barrierError: unknown, drainFailures: unknown[] = []
    try {
      let waiting: Wait | undefined
      const waitDeadline = Date.now() + 3000
      while (!done && Date.now() < waitDeadline) {
        waiting = (await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
          where datname=current_database() and usename=current_user and wait_event_type='Lock'
            and $1=any(pg_blocking_pids(pid)) and query=$2`, [holderPid, PRUNE_QUERY])).rows[0]
        if (waiting) break
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      expect(waiting, `No exact initial idempotency DELETE witness for ${door}; responseFinished=${done}`).toBeDefined()
      expect(done).toBe(false); expect(waiting!.query).toBe(PRUNE_QUERY); expect(waiting!.blockers).toContain(holderPid)
      const claims = { sub: f.owner.userId, sid: f.owner.sessionId, exp }
      // An already expired preHandler cannot substitute for the final replay
      // clock boundary: verify it is still genuinely valid after the witness.
      expect(await verifyAccessToken(SECRET, caller.token)).toEqual(claims)
      const verifiedAfterWaitAtMs = Date.now(), expiryDeadline = Date.now() + 4000
      let expiredVerifiedAtMs: number | undefined
      while (Date.now() < expiryDeadline) {
        try { expect(await verifyAccessToken(SECRET, caller.token)).toEqual(claims) }
        catch (error) {
          if (!(error instanceof AppError) || error.statusCode !== 401 || error.code !== 'token_expired') throw error
          expiredVerifiedAtMs = Date.now(); break
        }
        await new Promise<void>(resolve => setTimeout(resolve, 10)) // Yield only; the verifier proves expiry.
      }
      assert(expiredVerifiedAtMs !== undefined, 'Production JWT verifier did not prove expiry within the bounded hold')
      expect(done).toBe(false)
      const beforeReleaseWaiting = (await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
        where pid=$3 and datname=current_database() and usename=current_user and wait_event_type='Lock'
          and $1=any(pg_blocking_pids(pid)) and query=$2`, [holderPid, PRUNE_QUERY, waiting!.pid])).rows[0]
      expect(beforeReleaseWaiting, 'The original replay must remain locked after genuine JWT expiry').toBeDefined()
      expect(beforeReleaseWaiting!.blockers).toContain(holderPid)
      witnesses.push({ door, userId: f.owner.userId, sessionId: f.owner.sessionId, scopedKey: storedKey(f, door, key), holderPid,
        waiting: waiting!, beforeReleaseWaiting: beforeReleaseWaiting!, exp, issuedAfterLockAtMs, verifiedBeforeInvokeAtMs, verifiedAfterWaitAtMs, expiredVerifiedAtMs })
    } catch (error) { barrierFailed = true; barrierError = error }
    finally {
      release()
      const outcomes = await Promise.allSettled([holder, response])
      drainFailures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map(outcome => outcome.reason)
    }
    if (barrierFailed) drainFailures.unshift(barrierError)
    if (drainFailures.length === 1) throw drainFailures[0]
    if (drainFailures.length > 1) throw new AggregateError(drainFailures, 'Couple replay expiry barrier/request drain failed')
    return response
  }

  it.each(DOORS)('saved %s reply refuses genuine JWT expiry without replaying private success or repeating the writer', async door => {
    const f = await fixture(door), key = randomUUID(), original = await saveFirst(f, door, key)
    const before = await state(f), sentinelBefore = await state(sentinel), saved = await receipt(f, door, key)
    assert(saved, 'The actual successful action must have a saved receipt')
    const live = await invoke(f, door, key)
    expect(live.statusCode, live.body).toBe(original.statusCode); expect(live.headers['idempotent-replay']).toBe('true'); expect(live.json()).toEqual(original.json())
    expect(await state(f)).toEqual(before); expect(await state(sentinel)).toEqual(sentinelBefore); expect(await receipt(f, door, key)).toBe(saved)
    const response = await expiryReplay(f, door, key)
    // These invariants are checked before the expected pre-fix status failure.
    expect(await state(f)).toEqual(before); expect(await state(sentinel)).toEqual(sentinelBefore); expect(await receipt(f, door, key)).toBe(saved)
    await preservePriorRows()
    expect(response.statusCode, response.body).toBe(401)
    expect(response.json()).toEqual({ error: { code: 'token_expired', message: expect.any(String) } })
    expect(response.headers['idempotent-replay']).toBeUndefined()
    const requestIds = door === 'offer-requests.create' ? original.json<{ results: { requestId: string }[] }>().results.map(row => row.requestId) : []
    for (const marker of [f.nonce, f.weddingId, f.slotId, f.entryId, f.owner.userId, ...requestIds,
      ...(f.offerId ? [f.offerId] : []), ...(f.dealId ? [f.dealId] : []), ...f.companies.map(company => company.vendorId)]) expect(response.body).not.toContain(marker)
    expect(witnesses.filter(witness => witness.door === door)).toHaveLength(1)
  })
})
