/**
 * PRIVATE / UNRUN native candidate, 2026-10-08. No SUT or runtime qualification.
 * Integration: copy to backend/test/guestDayReadAccess.test.ts, register that
 * path in backend/vitest.serial.json (shared TABLE lock), then root alone runs
 * the selected queued RED with the unchanged 20s case / 30s hook limits.
 * Relative imports below intentionally target that future test location.
 *
 * Current source anchors in C:/Тили-тили/wp03-shift-guests-20261008/Тили-тили:
 * backend/src/routes/day.ts:105,1246,1310 (410; MAIN/for_guests; eve/contact/chat).
 * backend/src/routes/guests.ts:961,1004,1009,1099 (token rotation; RSVP read pins).
 * backend/src/timeline/version.ts:14 (timeline_version::text; read SHARE).
 * backend/test/audit38.test.ts:175,240,355,498 (API fixture, gates, dead/deleted).
 * backend/test/audit55.test.ts:660 (410/gone, never 401 for the three day paths).
 * backend/test/guestReadAccess.test.ts:67 (actual PostgreSQL blocker observer).
 * backend/test/orderTermsApi.test.ts:21,37,73 (native fences/owned cleanup/actors).
 * app/src/lib/api/guest.ts:144 (current public wrapper; offline/client tests are
 * a separate root scope, not evidence from this backend draft).
 *
 * Proposed additive DTO only: sourceVersion:string (timeline BIGINT),
 * capturedAt: ISO server snapshot time, ETag from that same timeline version.
 * These fields are NOT present in today's GuestDay contract. No new TTL,
 * event visibility, staff permission, acknowledgment or provider policy.
 * Keep all existing audit38/audit55/timeline021 negatives/callbacks untouched.
 */
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'guest-day-read-test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const POLICY = '2026-09-02'
const APPLICATION = 'guest_day_current_read_' + randomUUID()
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
interface Actor { id: string; phone: string; headers: { authorization: string } }
interface Block { id: string; name: string; forGuests: boolean; [key: string]: unknown }
interface Day { date: string | null; tz: string; timeline: Block[]; coordinator: { name: string | null; phone: string } | null;
  table: { name: string } | null; bus: unknown; chat: { open: boolean; opensAt: string | null; closesAt: string | null };
  sourceVersion?: unknown; capturedAt?: unknown; [key: string]: unknown }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
function tracked<T>(promise: PromiseLike<T>) {
  let settled = false
  const outcome: Promise<Outcome<T>> = Promise.resolve(promise).then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
  ).finally(() => { settled = true })
  return { outcome, settled: () => settled }
}
async function value<T>(job: { outcome: Promise<Outcome<T>> }): Promise<T> {
  const result = await job.outcome
  if (!result.ok) throw result.error
  return result.value
}
function barrier<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe.skipIf(!DB)('main guest day: current link pins, read-only snapshot and source metadata', () => {
  let app: FastifyInstance
  const ownedUsers: string[] = [], ownedWeddings: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort())
    assert.equal(target.username, 'codex_test')
    assert.equal(target.pathname, '/tili_ecosystem_full_20260930_test')
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    target.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: target.href, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'guest-day-refresh-test-only-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address as string))
    assert.equal(live.port, Number(disposablePgPort())); assert.equal(live.name, target.pathname.slice(1))
  })
  async function cleanupOwned() {
    if (!app) return
    // API-generated weddings are bounded by fresh actor UUIDs even if a setup
    // assertion failed before the response UUID could be registered.
    const rows = await app.db!.query<{ id: string }>('select id from weddings where owner_id=any($1::uuid[])', [ownedUsers])
    for (const row of rows.rows) if (!ownedWeddings.includes(row.id)) ownedWeddings.push(row.id)
    await app.db!.query('delete from weddings where id=any($1::uuid[])', [ownedWeddings])
    for (let offset = 0; offset < ownedUsers.length; offset += 32) {
      await app.db!.query('delete from users where id=any($1::uuid[])', [ownedUsers.slice(offset, offset + 32)])
    }
    // Append-only audit remains evidence; no broad prefix/history deletion.
  }
  afterEach(async () => { await cleanupOwned() })
  afterAll(async () => {
    if (!app) return
    try {
      await cleanupOwned()
      for (const [table, ids] of [['weddings', ownedWeddings], ['users', ownedUsers]] as const) {
        expect((await app.db!.query<{ count: number }>(`select count(*)::int count from ${table} where id=any($1::uuid[])`, [ids])).rows[0]!.count).toBe(0)
      }
    } finally { await app.close() }
  })
  async function actor(name: string): Promise<Actor> {
    // Synthetic auth rows exercise actual guards; no claim of human consent.
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = randomUUID(), phone = '+79' + randomInt(100_000_000, 999_999_999)
      ownedUsers.push(id) // before INSERT; never adopt an occupied user
      const inserted = await app.db!.query<{ id: string }>(
        'insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id', [id, phone, name])
      if (inserted.rowCount === 0) continue
      expect(inserted.rows[0]!.id).toBe(id)
      const sid = randomUUID()
      await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
      await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
      return { id, phone, headers: { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: id, sid }) } }
    }
    throw new Error('Could not allocate an owned guest-day fixture actor in 8 attempts')
  }
  async function fixture(today = true) {
    const owner = await actor('Private guest-day couple'), coordinator = await actor('Visible guest-day coordinator')
    const future = (await app.db!.query<{ date: string }>("select to_char((clock_timestamp() at time zone 'Europe/Moscow')::date + 365,'YYYY-MM-DD') date")).rows[0]!.date
    const created = await app.inject({ method: 'POST', url: '/weddings', headers: owner.headers,
      payload: { partnerName: 'Partner', date: future, city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } } })
    expect(created.statusCode, created.body).toBe(201)
    const weddingId = created.json().id as string; ownedWeddings.push(weddingId)
    const base = `/weddings/${weddingId}`
    const invite = await app.inject({ method: 'POST', url: base + '/invites', headers: owner.headers, payload: { role: 'coordinator', label: 'Guest day native fixture' } })
    expect(invite.statusCode, invite.body).toBe(201)
    const joined = await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: coordinator.headers })
    expect(joined.statusCode, joined.body).toBe(200)
    const guest = await app.inject({ method: 'POST', url: base + '/guests', headers: owner.headers, payload: { name: 'Exact main invitee' } })
    expect(guest.statusCode, guest.body).toBe(201)
    const guestId = guest.json().id as string
    const link = await app.inject({ method: 'POST', url: `${base}/guests/${guestId}/invite-link`, headers: owner.headers })
    expect(link.statusCode, link.body).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const exchange = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchange.statusCode, exchange.body).toBe(200)
    const token = exchange.json().guestToken as string
    expect(token).toBeTruthy(); expect(token).not.toBe(code)
    const party = (await app.db!.query<{ party_id: string; invite_token: string }>(
      'select p.id party_id,p.invite_token from guest_parties p join guests g on g.party_id=p.id where g.id=$1 and p.wedding_id=$2', [guestId, weddingId])).rows[0]!
    expect(party.invite_token).toBe(token)
    // This existing audit38 weddingToday technique uses the database clock,
    // not mocked time; do not send an invalid past date through the wizard.
    if (today) await app.db!.query("update weddings set date=(clock_timestamp() at time zone coalesce(tz,'Europe/Moscow'))::date where id=$1", [weddingId])
    const date = (await app.db!.query<{ date: string }>("select to_char(date,'YYYY-MM-DD') date from weddings where id=$1", [weddingId])).rows[0]!.date
    const contexts = await app.inject({ method: 'GET', url: base + '/events', headers: owner.headers })
    expect(contexts.statusCode, contexts.body).toBe(200)
    const additional = await app.inject({ method: 'POST', url: base + '/events', headers: { ...owner.headers, 'if-match': contexts.headers.etag! },
      payload: { name: 'Private independent ceremony', kind: 'ceremony', date: future, timeZone: 'Europe/Moscow', location: 'Private independent venue' } })
    expect(additional.statusCode, additional.body).toBe(201)
    const timelinePath = base + '/timeline'
    const initial = await app.inject({ method: 'GET', url: timelinePath, headers: owner.headers })
    expect(initial.statusCode, initial.body).toBe(200)
    const saved = await app.inject({ method: 'PUT', url: timelinePath, headers: { ...owner.headers, 'if-match': initial.headers.etag! }, payload: [
      { name: 'Public MAIN ceremony', forGuests: true, startsAt: `${date}T09:00:00Z`, responsible: { kind: 'guest', id: guestId }, participants: [{ kind: 'guest', id: guestId }] },
      { name: 'Private MAIN preparation', forGuests: false, startsAt: `${date}T08:00:00Z` },
      { name: 'Public flag on private independent block', forGuests: true, eventId: additional.json().id, startsAt: `${future}T10:00:00Z` },
    ] })
    expect(saved.statusCode, saved.body).toBe(200)
    const blocks = saved.json() as Block[], publicId = blocks.find(block => block.name === 'Public MAIN ceremony')!.id
    return { owner, coordinator, weddingId, base, guestId, partyId: party.party_id, token, date, timelinePath, publicId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const get = (f: Fixture, token = f.token) => app.inject({ method: 'GET', url: `/join/${encodeURIComponent(token)}/day` })
  async function clock(client: Queryable = app.db!) {
    return (await client.query<{ at: string }>('select clock_timestamp()::text at')).rows[0]!.at
  }
  async function version(f: Fixture, client: Queryable = app.db!) {
    return (await client.query<{ version: string }>('select timeline_version::text version from weddings where id=$1', [f.weddingId])).rows[0]!.version
  }
  async function footprint(f: Fixture, client: Queryable = app.db!) {
    const state: Record<string, string> = {}
    for (const table of ['wedding_events', 'wedding_members', 'guest_parties', 'guests', 'guest_event_invitations', 'event_guest_participation',
      'timeline_events', 'timeline_dependencies', 'timeline_assignments', 'timeline_shifts', 'tables', 'chats', 'bus_routes', 'broadcasts', 'vendor_updates']) {
      state[table] = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text snapshot from ${table} t where wedding_id=$1`, [f.weddingId])).rows[0]!.snapshot
    }
    state.wedding = (await client.query<{ snapshot: string }>('select to_jsonb(w)::text snapshot from weddings w where id=$1', [f.weddingId])).rows[0]!.snapshot
    state.busBookings = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(b) order by to_jsonb(b)::text),'[]'::jsonb)::text snapshot from bus_bookings b join guests g on g.id=b.guest_id where g.wedding_id=$1`, [f.weddingId])).rows[0]!.snapshot
    for (const table of ['idempotency_keys', 'notifications']) {
      state[table] = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text snapshot from ${table} t where user_id=any($1::uuid[])`, [[f.owner.id, f.coordinator.id]])).rows[0]!.snapshot
    }
    state.audit = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb)::text snapshot from audit_log a where a.actor_id=any($1::uuid[]) or a.entity_id::text=any($2::text[])`, [[f.owner.id, f.coordinator.id], [f.weddingId, f.guestId, f.partyId, f.publicId]])).rows[0]!.snapshot
    return state // raw SQL text: never parse BIGINT through JSON/Number
  }
  function publicProjection(res: Response, f: Fixture, publicName = 'Public MAIN ceremony') {
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Day
    expect(body).toMatchObject({ date: f.date, timeline: [{ id: f.publicId, name: publicName, forGuests: true }] })
    expect(body.timeline).toHaveLength(1)
    for (const key of ['eventId', 'responsible', 'participants', 'dependsOn', 'durationMinutes', 'fixed', 'travelMinutes', 'bufferMinutes']) expect(body.timeline[0]).not.toHaveProperty(key)
    expect(res.body).not.toContain('Private MAIN preparation')
    expect(res.body).not.toContain('Public flag on private independent block')
    expect(res.body).not.toContain(f.owner.phone)
    expect(res.headers['x-timeline-updated-by']).toBeUndefined()
    return body
  }
  function gone(res: Response, f: Fixture) {
    expect(res.statusCode, res.body).toBe(410)
    expect(res.json().error.code, res.body).toBe('gone')
    for (const field of ['timeline', 'coordinator', 'table', 'bus', 'sourceVersion', 'capturedAt']) expect(res.json()).not.toHaveProperty(field)
    for (const secret of ['Public MAIN ceremony', f.coordinator.phone, f.owner.phone, f.token]) expect(res.body).not.toContain(secret)
  }
  function metadata(res: Response, expectedVersion: string, from: string, to: string) {
    const body = res.json() as Day
    expect(typeof body.sourceVersion).toBe('string')
    expect(body.sourceVersion).toBe(expectedVersion)
    expect(res.headers.etag).toBe(`"${expectedVersion}"`)
    expect(typeof body.capturedAt).toBe('string')
    const at = Date.parse(body.capturedAt as string)
    expect(Number.isFinite(at)).toBe(true)
    expect(at).toBeGreaterThanOrEqual(Date.parse(from)); expect(at).toBeLessThanOrEqual(Date.parse(to))
    expect(res.headers['cache-control']).toBe('no-store')
  }
  // Same actual observer as guestReadAccess:67, with a smaller local witness
  // deadline inside the unchanged 10s idle / 15s SQL / 20s case limits.
  async function blocked(pid: number, settled: () => boolean, query: RegExp) {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      await app.db!.query('select pg_stat_clear_snapshot()')
      const result = await app.db!.query<{ pid: number; query: string; blockers: number[] }>(`select pid,query,pg_blocking_pids(pid) blockers from pg_stat_activity
        where datname=current_database() and application_name=$2 and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [pid, APPLICATION])
      const matches = result.rows.filter(row => query.test(row.query))
      if (matches.length) { expect(matches).toHaveLength(1); expect(matches[0]!.blockers).toContain(pid); return matches[0]! }
      if (settled()) throw new Error('Operation settled before its actual owned PostgreSQL lock witness')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('No matching owned PostgreSQL blocker witness before release')
  }
  const revocations = ['cancellation', 'party token rotation'] as const
  async function revoke(client: Queryable, f: Fixture, kind: typeof revocations[number]) {
    if (kind === 'cancellation') {
      await client.query('update weddings set cancelled_at=clock_timestamp() where id=$1', [f.weddingId])
    } else {
      // Exact two authorization/mirror writes from invite-link:1004/1009.
      // No share-code TTL mutation and no occupied person/token adoption.
      const next = randomUUID()
      await client.query('update guest_parties set invite_token=$2 where id=$1 and wedding_id=$3', [f.partyId, next, f.weddingId])
      await client.query('update guests set rsvp_token=$2 where party_id=$1 and party_position=1', [f.partyId, next])
    }
  }
  // Holder contains ONLY SQL and barriers. The GET is started by the caller
  // outside its callback. Every job has an immediately attached rejection
  // observer; finally releases/joins holder and drains all request jobs.
  async function held(f: Fixture, weddingLock: boolean, afterRelease: (client: Queryable) => Promise<void>) {
    const ready = barrier<number>(), release = barrier<void>()
    const job = tracked(app.db!.tx(async client => {
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      if (weddingLock) await client.query('select id from weddings where id=$1 for update', [f.weddingId])
      await client.query('lock table timeline_events in access exclusive mode')
      ready.resolve(pid)
      await release.promise
      await afterRelease(client)
    }))
    try {
      const pid = await Promise.race([ready.promise, job.outcome.then(result => {
        if (!result.ok) throw result.error
        throw new Error('Holder finished before signaling the lock barrier')
      })])
      return { pid, release: () => release.resolve(), job }
    } catch (error) {
      release.resolve(); await job.outcome; throw error
    }
  }

  it('main guest day preserves public projection and exact BIGINT source metadata without writes', async () => {
    const f = await fixture()
    await app.db!.query('update weddings set timeline_version=9007199254740993 where id=$1', [f.weddingId])
    const expectedVersion = await version(f), before = await footprint(f), from = await clock()
    const response = await get(f), to = await clock()
    const body = publicProjection(response, f)
    expect(body.coordinator).toEqual({ name: 'Visible guest-day coordinator', phone: f.coordinator.phone })
    metadata(response, expectedVersion, from, to)
    expect(await footprint(f)).toEqual(before)
  })
  it('main guest day keeps coordinator hidden before eve and does not open day chat early', async () => {
    const f = await fixture(false), before = await footprint(f), response = await get(f)
    const body = publicProjection(response, f)
    expect(body.coordinator).toBeNull(); expect(response.body).not.toContain(f.coordinator.phone)
    expect(body.chat.open).toBe(false); expect(body.chat.opensAt).toEqual(expect.any(String))
    expect(await footprint(f)).toEqual(before)
  })
  it('keeps dead token 410 on all three existing day paths and deleted guest 410', async () => {
    const f = await fixture()
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: `/join/${randomUUID()}/day-chat/messages`, ...(method === 'POST' ? { payload: { text: 'not delivered' } } : {}) })
      gone(response, f)
    }
    gone(await get(f, randomUUID()), f)
    expect((await get(f)).statusCode).toBe(200)
    const removed = await app.inject({ method: 'DELETE', url: `${f.base}/guests/${f.guestId}`, headers: f.owner.headers })
    expect(removed.statusCode, removed.body).toBe(204)
    const afterDeletion = await footprint(f)
    gone(await get(f), f)
    expect(await footprint(f)).toEqual(afterDeletion)
  })
  for (const kind of revocations) {
    it(`main guest day rejects ${kind} committed while its actual read waits`, async () => {
      const f = await fixture()
      let expected!: Awaited<ReturnType<typeof footprint>>
      const holder = await held(f, true, async client => { await revoke(client, f, kind); expected = await footprint(f, client) })
      let read: ReturnType<typeof tracked<Response>> | undefined
      try {
        read = tracked(get(f)) // OUTSIDE holder transaction callback
        await blocked(holder.pid, read.settled, /(?:timeline_events|from\s+weddings)/i)
        holder.release(); await value(holder.job)
        gone(await value(read), f)
        expect(await footprint(f)).toEqual(expected)
      } finally {
        holder.release()
        try { await value(holder.job) } finally { if (read) await value(read) }
      }
    })
    it(`main guest day pins ${kind} through its data wait, then next read is gone`, async () => {
      const f = await fixture()
      const holder = await held(f, false, async () => {})
      let read: ReturnType<typeof tracked<Response>> | undefined, revoker: ReturnType<typeof tracked<void>> | undefined
      let expected!: Awaited<ReturnType<typeof footprint>>
      try {
        read = tracked(get(f)) // OUTSIDE holder
        const reader = await blocked(holder.pid, read.settled, /from\s+timeline_events/i)
        revoker = tracked(app.db!.tx(async client => {
          // First write lock matches the authority being revoked. Acquiring
          // it must queue behind the reader before any fixture mutation.
          await client.query(kind === 'cancellation' ? 'select id from weddings where id=$1 for update' : 'select id from guest_parties where id=$1 for update',
            [kind === 'cancellation' ? f.weddingId : f.partyId])
          await revoke(client, f, kind); expected = await footprint(f, client)
        })) // OUTSIDE holder; no HTTP awaited inside either transaction
        await blocked(reader.pid, revoker.settled, kind === 'cancellation' ? /from\s+weddings/i : /from\s+guest_parties/i)
        expect(read.settled()).toBe(false); expect(revoker.settled()).toBe(false)
        holder.release(); await value(holder.job)
        publicProjection(await value(read), f)
        await value(revoker)
        gone(await get(f), f)
        expect(await footprint(f)).toEqual(expected)
      } finally {
        holder.release()
        try { await value(holder.job) } finally {
          try { if (read) await value(read) } finally { if (revoker) await value(revoker) }
        }
      }
    })
  }
  it('queued main guest day captures program content, version and server time after the committed program change', async () => {
    const f = await fixture()
    let expectedVersion!: string, afterMutation!: string, expected!: Awaited<ReturnType<typeof footprint>>
    const holder = await held(f, true, async client => {
      await client.query('update timeline_events set name=$2 where id=$1 and wedding_id=$3', [f.publicId, 'Committed MAIN program', f.weddingId])
      expectedVersion = await version(f, client); expected = await footprint(f, client)
      afterMutation = await clock(client)
    })
    let read: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f))
      await blocked(holder.pid, read.settled, /(?:timeline_events|from\s+weddings)/i)
      holder.release(); await value(holder.job)
      const response = await value(read), to = await clock()
      publicProjection(response, f, 'Committed MAIN program')
      metadata(response, expectedVersion, afterMutation, to)
      expect(await footprint(f)).toEqual(expected)
    } finally {
      holder.release()
      try { await value(holder.job) } finally { if (read) await value(read) }
    }
  })
  it('pinned guest program version/body remains coherent while the real timeline PUT waits, then fresh GET advances', async () => {
    const f = await fixture(), originalVersion = await version(f)
    const teamRead = await app.inject({ method: 'GET', url: f.timelinePath, headers: f.owner.headers })
    expect(teamRead.statusCode, teamRead.body).toBe(200)
    const changed = (teamRead.json() as Block[]).map(block => block.id === f.publicId ? { ...block, name: 'Next accepted MAIN program' } : block)
    const from = await clock(), holder = await held(f, false, async () => {})
    let read: ReturnType<typeof tracked<Response>> | undefined, writer: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f))
      const reader = await blocked(holder.pid, read.settled, /from\s+timeline_events/i)
      writer = tracked(app.inject({ method: 'PUT', url: f.timelinePath, headers: { ...f.owner.headers, 'if-match': teamRead.headers.etag! }, payload: changed }))
      await blocked(reader.pid, writer.settled, /from\s+weddings/i)
      expect(read.settled()).toBe(false); expect(writer.settled()).toBe(false)
      holder.release(); await value(holder.job)
      const response = await value(read), to = await clock()
      publicProjection(response, f); metadata(response, originalVersion, from, to)
      const written = await value(writer); expect(written.statusCode, written.body).toBe(200)
      const nextVersion = await version(f); expect(BigInt(nextVersion)).toBeGreaterThan(BigInt(originalVersion))
      const nextFrom = await clock(), fresh = await get(f), nextTo = await clock()
      publicProjection(fresh, f, 'Next accepted MAIN program'); metadata(fresh, nextVersion, nextFrom, nextTo)
    } finally {
      holder.release()
      try { await value(holder.job) } finally {
        try { if (read) await value(read) } finally { if (writer) await value(writer) }
      }
    }
  })
})
