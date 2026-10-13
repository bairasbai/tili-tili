import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken, verifyAccessToken, type AccessClaims } from '../src/auth/tokens.js'
import { AppError } from '../src/errors.js'
import type { Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'synthetic-vendor-offer-replay-access'.repeat(3), POLICY = '2026-09-02'
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`
const ROUTE = 'vendor.offer-response'
const PRUNE_QUERY = "delete from idempotency_keys where created_at < now() - interval '1 day'"
const CHANGES = ['session_revoked', 'consent_withdrawn', 'user_deleted'] as const
type Change = typeof CHANGES[number]
type WaitChange = Change | 'token_expired'
type Wait = { pid: number; query: string; wait_event: string; blockers: number[] }
type ExpiryWitness = { userId: string; sessionId: string; scopedKey: string; holderPid: number; waitingPid: number;
  exp: number; issuedAfterHolderLockAtMs: number; verifiedBeforeInvokeAtMs: number;
  verifiedAfterWaitAtMs: number; expiredVerifiedAtMs: number; beforeReleaseWaiting: Wait }

// Mandatory security regression: missing/misrouted PostgreSQL is a failed gate,
// never a green skip. The root runner owns this disposable cluster exclusively.
describe('vendor offer saved replies recheck current authority after actual PostgreSQL waiting', () => {
  let app: FastifyInstance
  const weddings: string[] = [], vendors: string[] = [], users: string[] = []
  const sessions: string[] = [], consents: string[] = []
  const witnesses: { change: WaitChange; holderPid: number; waiting: Wait; userId: string; scopedKey: string }[] = []
  const expiryWitnesses: ExpiryWitness[] = []
  let unrelated: Fixture

  beforeAll(async () => {
    assert(DB, 'TEST_DATABASE_URL is required for mandatory vendor replay security tests')
    assert.equal(process.env.DATABASE_URL, DB, 'DATABASE_URL must match the approved TEST_DATABASE_URL')
    const target = new URL(DB)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort())
    assert.equal(target.username, 'codex_test')
    assert.equal(target.pathname, '/tili_ecosystem_full_20260930_test')
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'synthetic-vendor-offer-replay-refresh'.repeat(3), policyVersion: POLICY })
    await app.ready()
    expect((await app.db!.query<{ name: string }>('select current_database() as name')).rows[0]!.name).toBe(target.pathname.slice(1))
    unrelated = await fixture()
    await positive(unrelated, randomUUID())
  })

  afterAll(async () => {
    if (!app) return
    try {
      process.stdout.write(`VENDOR_OFFER_REPLAY_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      process.stdout.write(`VENDOR_OFFER_REPLAY_JWT_EXPIRY_WITNESSES count=${expiryWitnesses.length} ${JSON.stringify(expiryWitnesses)}\n`)
      // Exact UUID ownership only; no schema reset, wildcard/prefix deletion,
      // borrowed actors or updates to occupied phone fixtures.
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
      for (const [table, ids] of [['weddings', weddings], ['vendors', vendors], ['users', users],
        ['sessions', sessions], ['consents', consents]] as const) {
        expect((await app.db!.query(`select id from ${table} where id=any($1::uuid[])`, [ids])).rows, `Own ${table} fixtures remain`).toEqual([])
      }
      expect((await app.db!.query('select key from idempotency_keys where user_id=any($1::uuid[])', [users])).rows).toEqual([])
      expect((await app.db!.query('select id from notifications where user_id=any($1::uuid[])', [users])).rows).toEqual([])
    } finally { await app.close() }
  })

  async function actor() {
    const userId = randomUUID(), sessionId = randomUUID(), consentId = randomUUID()
    let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
      const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`
      inserted = (await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic replay actor') on conflict(phone) do nothing returning id", [userId, phone])).rowCount === 1
    }
    assert(inserted, 'Unable to create an owned synthetic user without touching an occupied phone')
    users.push(userId); sessions.push(sessionId); consents.push(consentId)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    return { userId, sessionId, consentId, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor, key: string) => ({ ...auth(a), 'idempotency-key': key })

  async function fixture() {
    const couple = await actor(), vendorOwner = await actor()
    const weddingId = randomUUID(), slotId = randomUUID(), vendorId = randomUUID()
    weddings.push(weddingId); vendors.push(vendorId)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Private replay wedding',$3,'Europe/Moscow',$4)", [weddingId, couple.userId, DATE, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, couple.userId])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Private replay studio',now())", [vendorId, vendorOwner.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Private replay position')", [slotId, weddingId])
    const shortlisted = await app.inject({ method: 'PUT', url: `/weddings/${weddingId}/shortlist/${vendorId}`, headers: auth(couple) })
    expect(shortlisted.statusCode, shortlisted.body).toBe(200)
    const requested = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${slotId}/offer-requests`, headers: idem(couple, randomUUID()),
      payload: { entryIds: [shortlisted.json().id], wishes: 'Private replay wishes', budgetHint: { amount: 25000, currency: 'RUB' } } })
    expect(requested.statusCode, requested.body).toBe(201)
    expect(requested.json().results).toEqual([{ entryId: shortlisted.json().id, status: 'sent', requestId: expect.any(String) }])
    const requestId = requested.json().results[0].requestId as string
    return { couple, vendorOwner, weddingId, slotId, vendorId, requestId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const body = { kind: 'offer', title: 'Private replay negotiated package', price: { amount: 24000, currency: 'RUB' },
    includes: ['Private replay gallery'], message: 'Private replay negotiated message', validUntil: DATE }
  function invoke(w: Fixture, key: string, caller = w.vendorOwner, override?: { url?: string; payload?: Record<string, unknown> }) {
    return app.inject({ method: 'POST', url: `/vendor/offer-requests/${w.requestId}/offers`, payload: body,
      ...override, headers: idem(caller, key) }).then(r => r)
  }
  const scopedKey = (w: Fixture, key: string) => `${w.vendorOwner.userId}:${ROUTE}:${key}`
  async function saved(w: Fixture, key: string) {
    return (await app.db!.query('select * from idempotency_keys where key=$1', [scopedKey(w, key)])).rows[0]
  }
  async function state(w: Fixture) {
    const results = await Promise.all([
      app.db!.query('select * from offer_requests where id=$1', [w.requestId]),
      app.db!.query('select * from offers where request_id=$1 order by id', [w.requestId]),
      app.db!.query('select * from notifications where user_id=any($1::uuid[]) order by id', [[w.couple.userId, w.vendorOwner.userId]]),
      app.db!.query('select * from idempotency_keys where user_id=any($1::uuid[]) order by key', [[w.couple.userId, w.vendorOwner.userId]]),
      app.db!.query('select * from deals where wedding_id=$1 order by id', [w.weddingId]),
      app.db!.query('select * from deal_orders where wedding_id=$1 order by deal_id', [w.weddingId]),
      app.db!.query('select * from vendor_busy_dates where vendor_id=$1 order by date', [w.vendorId]),
    ])
    // Serialised row snapshots compare the complete saved receipts and notices,
    // not merely counts. Principal fixture changes are deliberately excluded.
    return JSON.stringify(results.map(r => r.rows))
  }
  async function positive(w: Fixture, key: string) {
    const response = await invoke(w, key)
    expect(response.statusCode, response.body).toBe(201)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    expect(response.json()).toMatchObject({ id: expect.any(String), requestId: w.requestId,
      kind: 'offer', title: body.title, price: body.price, includes: body.includes, message: body.message, validUntil: DATE })
    expect(await saved(w, key)).toMatchObject({ user_id: w.vendorOwner.userId, route: ROUTE, status: 201, body: response.json() })
    expect((await app.db!.query('select id from offers where request_id=$1', [w.requestId])).rows).toHaveLength(1)
    expect((await app.db!.query("select id from notifications where user_id=$1 and title='Новое предложение'", [w.couple.userId])).rows).toHaveLength(1)
    return response
  }
  function refusal(response: Awaited<ReturnType<typeof invoke>>, status: number) {
    expect(response.statusCode, response.body).toBe(status)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    expect(Object.keys(response.json())).toEqual(['error'])
    for (const marker of [body.title, body.message, ...body.includes, 'Private replay wishes']) expect(response.body).not.toContain(marker)
  }
  async function mutate(client: Queryable, w: Fixture, change: Change) {
    const changed = change === 'session_revoked'
      ? await client.query('update sessions set revoked_at=clock_timestamp() where id=$1 and user_id=$2', [w.vendorOwner.sessionId, w.vendorOwner.userId])
      : change === 'consent_withdrawn'
        ? await client.query('update consents set withdrawn_at=clock_timestamp() where id=$1 and user_id=$2', [w.vendorOwner.consentId, w.vendorOwner.userId])
        : await client.query('update users set deleted_at=clock_timestamp() where id=$1', [w.vendorOwner.userId])
    expect(changed.rowCount).toBe(1)
  }
  async function replayAfterWitnessedWait(w: Fixture, key: string, change: WaitChange) {
    let ready!: () => void, failReady!: (error: unknown) => void, release!: () => void
    let holderPid = 0, approvedMutation = false
    let caller = w.vendorOwner, shortClaims: AccessClaims | undefined
    let issuedAfterHolderLockAtMs = 0, verifiedBeforeInvokeAtMs = 0
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject })
    const released = new Promise<void>(resolve => { release = resolve })
    const holder = app.db!.tx(async client => {
      holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await client.query('lock table idempotency_keys in share mode')
      if (change === 'token_expired') {
        // The real lock is acquired before issuing a genuinely signed token.
        // Backdated iat selects exp through the unchanged production TTL.
        issuedAfterHolderLockAtMs = Date.now()
        const exp = Math.floor(issuedAfterHolderLockAtMs / 1000) + 3
        caller = { ...w.vendorOwner, token: await signAccessToken(SECRET,
          { sub: w.vendorOwner.userId, sid: w.vendorOwner.sessionId }, (exp - ACCESS_TTL_SECONDS) * 1000) }
        shortClaims = await verifyAccessToken(SECRET, caller.token)
        expect(shortClaims).toEqual({ sub: w.vendorOwner.userId, sid: w.vendorOwner.sessionId, exp })
        verifiedBeforeInvokeAtMs = Date.now()
      }
      ready(); await released
      if (approvedMutation && change !== 'token_expired') await mutate(client, w, change)
    })
    // Ensure a failed lock acquisition cannot leave started pending forever.
    void holder.catch(failReady)
    await started
    let done = false
    const response = invoke(w, key, caller).then(result => { done = true; return result })
    void response.catch(() => undefined)
    let barrierFailed = false, barrierError: unknown
    let drainFailures: unknown[] = []
    try {
      let waiting: Wait | undefined
      const deadline = Date.now() + 3000
      while (!done && Date.now() < deadline) {
        waiting = (await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity
          where datname=current_database() and usename=current_user and wait_event_type='Lock'
            and $1=any(pg_blocking_pids(pid)) and query=$2`, [holderPid, PRUNE_QUERY])).rows[0]
        if (waiting) break
      }
      // This native PostgreSQL witness proves preHandler passed and the HTTP
      // exact replay is blocked in replayOrClaim, before any cached disclosure.
      expect(waiting, `No actual initial idempotency DELETE wait for ${change}; responseFinished=${done}`).toBeDefined()
      expect(done).toBe(false)
      expect(waiting!.query).toBe(PRUNE_QUERY)
      expect(waiting!.blockers).toContain(holderPid)
      witnesses.push({ change, holderPid, waiting: waiting!, userId: w.vendorOwner.userId, scopedKey: scopedKey(w, key) })
      if (change === 'token_expired') {
        assert(shortClaims, 'Missing genuinely verified short-lived claims')
        // Expiry before this proven wait is a failure, not a substitute for
        // exercising the final replay JWT check after waiting.
        expect(await verifyAccessToken(SECRET, caller.token)).toEqual(shortClaims)
        const verifiedAfterWaitAtMs = Date.now(), expiryDeadline = Date.now() + 4000
        let expiredVerifiedAtMs: number | undefined
        while (Date.now() < expiryDeadline) {
          try { expect(await verifyAccessToken(SECRET, caller.token)).toEqual(shortClaims) }
          catch (error) {
            if (!(error instanceof AppError) || error.statusCode !== 401 || error.code !== 'token_expired') throw error
            expiredVerifiedAtMs = Date.now(); break
          }
          // Yield only: the native verifier's token_expired error is the proof.
          await new Promise<void>(resolve => setTimeout(resolve, 10))
        }
        assert(expiredVerifiedAtMs !== undefined, 'Real JWT expiry was not verified within the unchanged bounded hold')
        expect(done).toBe(false)
        const beforeReleaseWaiting = (await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity
          where pid=$3 and datname=current_database() and usename=current_user and wait_event_type='Lock'
            and $1=any(pg_blocking_pids(pid)) and query=$2`, [holderPid, PRUNE_QUERY, waiting!.pid])).rows[0]
        expect(beforeReleaseWaiting, 'The original replay must still be held after actual token expiry').toBeDefined()
        expect(beforeReleaseWaiting!.blockers).toContain(holderPid)
        expiryWitnesses.push({ userId: caller.userId, sessionId: caller.sessionId, scopedKey: scopedKey(w, key),
          holderPid, waitingPid: waiting!.pid, exp: shortClaims.exp, issuedAfterHolderLockAtMs,
          verifiedBeforeInvokeAtMs, verifiedAfterWaitAtMs, expiredVerifiedAtMs, beforeReleaseWaiting: beforeReleaseWaiting! })
      }
      approvedMutation = true
    } catch (error) {
      barrierFailed = true; barrierError = error
    } finally {
      release()
      // Drain both handles even when mutation/COMMIT or HTTP rejects. Keep
      // every refusal visible instead of masking one with another or cleanup.
      const outcomes = await Promise.allSettled([holder, response])
      drainFailures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map(outcome => outcome.reason)
    }
    if (barrierFailed) drainFailures.unshift(barrierError)
    if (drainFailures.length === 1) throw drainFailures[0]
    if (drainFailures.length > 1) throw new AggregateError(drainFailures, 'Vendor replay barrier and request drain failed')
    return response
  }

  it.each(CHANGES)('saved offer refuses %s after a proven initial DELETE wait without disclosure or duplicate writes', async change => {
    const w = await fixture(), key = randomUUID()
    await positive(w, key)
    const before = await state(w), unrelatedBefore = await state(unrelated), receipt = JSON.stringify(await saved(w, key))
    const response = await replayAfterWitnessedWait(w, key, change)
    // Assert all immutable snapshots before the expected RED status assertion.
    expect(await state(w)).toBe(before); expect(await state(unrelated)).toBe(unrelatedBefore)
    expect(JSON.stringify(await saved(w, key))).toBe(receipt)
    refusal(response, change === 'consent_withdrawn' ? 403 : 401)
  })

  it('saved offer refuses genuine JWT expiry after a proven initial DELETE wait with unchanged principal rows', async () => {
    const w = await fixture(), key = randomUUID(); await positive(w, key)
    const before = await state(w), unrelatedBefore = await state(unrelated), receipt = JSON.stringify(await saved(w, key))
    const principalBefore = await Promise.all([
      app.db!.query('select * from users where id=$1', [w.vendorOwner.userId]),
      app.db!.query('select * from sessions where id=$1', [w.vendorOwner.sessionId]),
      app.db!.query('select * from consents where id=$1', [w.vendorOwner.consentId]),
    ]).then(results => JSON.stringify(results.map(result => result.rows)))
    const response = await replayAfterWitnessedWait(w, key, 'token_expired')
    expect(await state(w)).toBe(before); expect(await state(unrelated)).toBe(unrelatedBefore)
    expect(JSON.stringify(await saved(w, key))).toBe(receipt)
    const principalAfter = await Promise.all([
      app.db!.query('select * from users where id=$1', [w.vendorOwner.userId]),
      app.db!.query('select * from sessions where id=$1', [w.vendorOwner.sessionId]),
      app.db!.query('select * from consents where id=$1', [w.vendorOwner.consentId]),
    ]).then(results => JSON.stringify(results.map(result => result.rows)))
    expect(principalAfter).toBe(principalBefore)
    refusal(response, 401); expect(response.json().error.code).toBe('token_expired')
    expect(expiryWitnesses).toHaveLength(1)
  })

  it('unchanged live rights replay the same saved 201 twice without another offer or notification', async () => {
    const w = await fixture(), key = randomUUID(), original = await positive(w, key)
    const before = await state(w), unrelatedBefore = await state(unrelated)
    for (let retry = 0; retry < 2; retry++) {
      const response = await invoke(w, key)
      expect(response.statusCode, response.body).toBe(201)
      expect(response.headers['idempotent-replay']).toBe('true')
      expect(response.json()).toEqual(original.json())
      expect(await state(w)).toBe(before); expect(await state(unrelated)).toBe(unrelatedBefore)
    }
  })

  it.each(['request_closed', 'offer_accepted', 'quota_full', 'profile_unpublished', 'profile_blocked'] as const)('saved response survives %s without repeating its business writer', async change => {
    const w = await fixture(), key = randomUUID(), original = await positive(w, key)
    if (change === 'request_closed') await app.db!.query("update offer_requests set status='closed',close_reason='removed',closed_at=clock_timestamp() where id=$1", [w.requestId])
    if (change === 'offer_accepted') {
      const accepted = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/offers/${original.json().id}/accept`, headers: idem(w.couple, randomUUID()) })
      expect(accepted.statusCode, accepted.body).toBe(200)
      expect((await app.db!.query('select id from offers where request_id=$1 and accepted_at is not null', [w.requestId])).rowCount).toBe(1)
    }
    if (change === 'quota_full') {
      for (let revision = 1; revision < 5; revision++) {
        const revised = await invoke(w, randomUUID(), w.vendorOwner, { payload: { ...body, message: `${body.message} revision ${revision}` } })
        expect(revised.statusCode, revised.body).toBe(201)
      }
      expect((await app.db!.query('select id from offers where request_id=$1', [w.requestId])).rowCount).toBe(5)
    }
    if (change === 'profile_unpublished') await app.db!.query('update vendors set published_at=null where id=$1', [w.vendorId])
    if (change === 'profile_blocked') await app.db!.query('update vendors set blocked_at=clock_timestamp() where id=$1', [w.vendorId])
    const before = await state(w), unrelatedBefore = await state(unrelated), receipt = JSON.stringify(await saved(w, key))
    const response = await invoke(w, key)
    expect(response.statusCode, response.body).toBe(201)
    expect(response.headers['idempotent-replay']).toBe('true'); expect(response.json()).toEqual(original.json())
    expect(await state(w)).toBe(before); expect(await state(unrelated)).toBe(unrelatedBefore)
    expect(JSON.stringify(await saved(w, key))).toBe(receipt)
  })

  it.each(['body', 'path'] as const)('saved key rejects a changed %s and preserves private receipts', async change => {
    const w = await fixture(), key = randomUUID(); await positive(w, key)
    const before = await state(w), unrelatedBefore = await state(unrelated)
    const override = change === 'body' ? { payload: { ...body, message: 'Different request body' } } : { url: `/vendor/offer-requests/${unrelated.requestId}/offers` }
    const response = await invoke(w, key, w.vendorOwner, override)
    refusal(response, 409); expect(response.json().error.code).toBe('idempotency_key_reused')
    expect(await state(w)).toBe(before); expect(await state(unrelated)).toBe(unrelatedBefore)
  })

  it('another live vendor actor cannot obtain the saved response using the same client key', async () => {
    const w = await fixture(), key = randomUUID(); await positive(w, key)
    const before = await state(w), unrelatedBefore = await state(unrelated)
    refusal(await invoke(w, key, unrelated.vendorOwner), 404)
    expect(await state(w)).toBe(before); expect(await state(unrelated)).toBe(unrelatedBefore)
    expect((await app.db!.query('select key from idempotency_keys where key=$1', [`${unrelated.vendorOwner.userId}:${ROUTE}:${key}`])).rows).toEqual([])
  })
})
