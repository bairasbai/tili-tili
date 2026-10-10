import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'guest-event-day-test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const POLICY = '2026-09-02'
const APPLICATION = 'guest_event_day_read_' + randomUUID()
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
interface Actor { id: string; phone: string; headers: { authorization: string } }
interface Block { id: string; name: string; forGuests: boolean; [key: string]: unknown }
interface Day {
  programme?: { kind: 'additional'; eventId: string; guestId: string }
  date: string | null; tz: string | null; venue: string | null; timeline: Block[]
  sourceVersion: string; capturedAt: string; [key: string]: unknown
}
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

describe.skipIf(!DB)('selected additional guest programme: exact person, invitation and coherent read', () => {
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
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'guest-event-day-refresh-test-only-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address as string))
    assert.equal(live.port, Number(disposablePgPort())); assert.equal(live.name, target.pathname.slice(1))
  })
  async function cleanupOwned() {
    if (!app) return
    const rows = await app.db!.query<{ id: string }>('select id from weddings where owner_id=any($1::uuid[])', [ownedUsers])
    for (const row of rows.rows) if (!ownedWeddings.includes(row.id)) ownedWeddings.push(row.id)
    await app.db!.query('delete from weddings where id=any($1::uuid[])', [ownedWeddings])
    for (let offset = 0; offset < ownedUsers.length; offset += 32) {
      await app.db!.query('delete from users where id=any($1::uuid[])', [ownedUsers.slice(offset, offset + 32)])
    }
    // The append-only audit is evidence, never a cleanup target.
  }
  afterEach(cleanupOwned)
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
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = randomUUID(), phone = '+79' + randomInt(100_000_000, 999_999_999)
      ownedUsers.push(id)
      const inserted = await app.db!.query<{ id: string }>(
        'insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id', [id, phone, name])
      if (inserted.rowCount === 0) continue
      expect(inserted.rows[0]!.id).toBe(id)
      const sid = randomUUID()
      await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
      await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
      return { id, phone, headers: { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: id, sid }) } }
    }
    throw new Error('Could not allocate an owned additional guest programme actor in 8 attempts')
  }
  async function fixture(dated = false) {
    const owner = await actor('Private programme couple'), coordinator = await actor('MAIN-only coordinator')
    const future = (await app.db!.query<{ date: string }>("select to_char((clock_timestamp() at time zone 'Europe/Moscow')::date + 365,'YYYY-MM-DD') date")).rows[0]!.date
    const created = await app.inject({ method: 'POST', url: '/weddings', headers: owner.headers,
      payload: { partnerName: 'Partner', date: future, city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } } })
    expect(created.statusCode, created.body).toBe(201)
    const weddingId = created.json().id as string; ownedWeddings.push(weddingId)
    const base = `/weddings/${weddingId}`
    const invite = await app.inject({ method: 'POST', url: base + '/invites', headers: owner.headers, payload: { role: 'coordinator', label: 'Additional guest programme fixture' } })
    expect(invite.statusCode, invite.body).toBe(201)
    const joined = await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: coordinator.headers })
    expect(joined.statusCode, joined.body).toBe(200)
    const primary = await app.inject({ method: 'POST', url: base + '/guests', headers: owner.headers, payload: { name: 'Uninvited primary person' } })
    expect(primary.statusCode, primary.body).toBe(201)
    const primaryId = primary.json().id as string, partyId = primary.json().partyId as string
    const second = await app.inject({ method: 'POST', url: `${base}/guests/${primaryId}/members`, headers: owner.headers, payload: { name: 'Exact invited second person' } })
    expect(second.statusCode, second.body).toBe(201)
    const guestId = second.json().id as string
    const outsider = await app.inject({ method: 'POST', url: base + '/guests', headers: owner.headers, payload: { name: 'Private person in another party' } })
    expect(outsider.statusCode, outsider.body).toBe(201)
    const outsiderId = outsider.json().id as string
    const link = await app.inject({ method: 'POST', url: `${base}/guests/${primaryId}/invite-link`, headers: owner.headers })
    expect(link.statusCode, link.body).toBe(200)
    const exchange = await app.inject({ method: 'GET', url: `/invite/${(link.json().url as string).split('/').pop()!}` })
    expect(exchange.statusCode, exchange.body).toBe(200)
    const token = exchange.json().guestToken as string
    expect(token).toBeTruthy()
    await app.db!.query("update weddings set date=(clock_timestamp() at time zone coalesce(tz,'Europe/Moscow'))::date where id=$1", [weddingId])
    const patched = await app.inject({ method: 'PATCH', url: base, headers: owner.headers,
      payload: { venue: 'MAIN-only venue', dressCode: 'MAIN-only dress', dressNote: 'MAIN-only dress note' } })
    expect(patched.statusCode, patched.body).toBe(200)
    const contexts = await app.inject({ method: 'GET', url: base + '/events', headers: owner.headers })
    expect(contexts.statusCode, contexts.body).toBe(200)
    const mainId = (contexts.json() as { id: string; isMain: boolean }[]).find(e => e.isMain)!.id
    const extra = await app.inject({ method: 'POST', url: base + '/events', headers: { ...owner.headers, 'if-match': contexts.headers.etag! },
      payload: { name: 'Selected additional event', kind: 'second_day', ...(dated ? { date: future, timeZone: 'Asia/Yekaterinburg', location: 'Selected event location' } : {}) } })
    expect(extra.statusCode, extra.body).toBe(201)
    const eventId = extra.json().id as string
    const otherEvent = await app.inject({ method: 'POST', url: base + '/events', headers: { ...owner.headers, 'if-match': extra.headers.etag! }, payload: { name: 'Private other additional event', kind: 'ceremony' } })
    expect(otherEvent.statusCode, otherEvent.body).toBe(201)
    const invitationPath = `${base}/events/${eventId}/invitations`
    const invitationRead = await app.inject({ method: 'GET', url: invitationPath, headers: owner.headers })
    expect(invitationRead.statusCode, invitationRead.body).toBe(200)
    const invitations = await app.inject({ method: 'PUT', url: invitationPath, headers: { ...owner.headers, 'if-match': invitationRead.headers.etag! }, payload: { guestIds: [guestId, outsiderId] } })
    expect(invitations.statusCode, invitations.body).toBe(200)
    const timelinePath = base + '/timeline'
    const initial = await app.inject({ method: 'GET', url: timelinePath, headers: owner.headers })
    expect(initial.statusCode, initial.body).toBe(200)
    const saved = await app.inject({ method: 'PUT', url: timelinePath, headers: { ...owner.headers, 'if-match': initial.headers.etag! }, payload: [
      { name: 'Public MAIN block', forGuests: true },
      { name: 'Private MAIN block', forGuests: false },
      { name: 'Selected public programme', forGuests: true, eventId, startsAt: `${future}T10:00:00Z`, responsible: { kind: 'guest', id: guestId }, participants: [{ kind: 'guest', id: guestId }] },
      { name: 'Selected private preparation', forGuests: false, eventId },
      { name: 'Private other event public flag', forGuests: true, eventId: otherEvent.json().id },
    ] })
    expect(saved.statusCode, saved.body).toBe(200)
    const publicId = (saved.json() as Block[]).find(b => b.name === 'Selected public programme')!.id
    return { owner, coordinator, weddingId, base, primaryId, guestId, outsiderId, partyId, token, mainId, eventId, publicId, timelinePath, invitationPath,
      date: dated ? future : null, tz: dated ? 'Asia/Yekaterinburg' : null, venue: dated ? 'Selected event location' : null }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const main = (f: Fixture, token = f.token) => app.inject({ method: 'GET', url: `/join/${encodeURIComponent(token)}/day` })
  const get = (f: Fixture, eventId = f.eventId, guestId = f.guestId, token = f.token) => app.inject({ method: 'GET',
    url: `/join/${encodeURIComponent(token)}/day?eventId=${encodeURIComponent(eventId)}&guestId=${encodeURIComponent(guestId)}` })
  async function clock(client: Queryable = app.db!) {
    return (await client.query<{ at: string }>('select clock_timestamp()::text at')).rows[0]!.at
  }
  async function version(f: Fixture, client: Queryable = app.db!) {
    return (await client.query<{ version: string }>('select timeline_version::text version from weddings where id=$1', [f.weddingId])).rows[0]!.version
  }
  async function footprint(f: Fixture, client: Queryable = app.db!) {
    const state: Record<string, string> = {}
    for (const table of ['wedding_events', 'wedding_members', 'guest_parties', 'guests', 'guest_event_invitations', 'event_guest_participation', 'event_rsvp_requests',
      'timeline_events', 'timeline_dependencies', 'timeline_assignments', 'timeline_shifts', 'tables', 'chats', 'bus_routes', 'broadcasts', 'vendor_updates']) {
      state[table] = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text snapshot from ${table} t where wedding_id=$1`, [f.weddingId])).rows[0]!.snapshot
    }
    state.wedding = (await client.query<{ snapshot: string }>('select to_jsonb(w)::text snapshot from weddings w where id=$1', [f.weddingId])).rows[0]!.snapshot
    state.busBookings = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(b) order by to_jsonb(b)::text),'[]'::jsonb)::text snapshot from bus_bookings b join guests g on g.id=b.guest_id where g.wedding_id=$1`, [f.weddingId])).rows[0]!.snapshot
    for (const table of ['idempotency_keys', 'notifications']) {
      state[table] = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text snapshot from ${table} t where user_id=any($1::uuid[])`, [[f.owner.id, f.coordinator.id]])).rows[0]!.snapshot
    }
    state.audit = (await client.query<{ snapshot: string }>(`select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb)::text snapshot from audit_log a where a.actor_id=any($1::uuid[]) or a.entity_id::text=any($2::text[])`,
      [[f.owner.id, f.coordinator.id], [f.weddingId, f.guestId, f.primaryId, f.partyId, f.eventId, f.publicId]])).rows[0]!.snapshot
    return state // raw SQL text preserves BIGINT; do not parse through Number
  }
  function projection(res: Response, f: Fixture, name = 'Selected public programme') {
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Day
    expect(body).toMatchObject({ programme: { kind: 'additional', eventId: f.eventId, guestId: f.guestId }, date: f.date, tz: f.tz, venue: f.venue,
      dressCode: null, dressNote: null, table: null, bus: null, coordinator: null, chat: { open: false, opensAt: null, closesAt: null },
      timeline: [{ id: f.publicId, name, forGuests: true }] })
    expect(body.timeline).toHaveLength(1)
    for (const key of ['eventId', 'responsible', 'participants', 'dependsOn', 'durationMinutes', 'fixed', 'travelMinutes', 'bufferMinutes']) expect(body.timeline[0]).not.toHaveProperty(key)
    for (const secret of ['Public MAIN block', 'Private MAIN block', 'Selected private preparation', 'Private other event public flag',
      'MAIN-only venue', 'MAIN-only dress', 'MAIN-only dress note', 'MAIN-only table', 'MAIN-only bus',
      'Exact invited second person', 'Private person in another party', f.owner.phone, f.coordinator.phone, f.token]) expect(res.body).not.toContain(secret)
    expect(res.headers['x-timeline-updated-by']).toBeUndefined()
    return body
  }
  function denied(res: Response, status: 404 | 410, f: Fixture) {
    expect(res.statusCode, res.body).toBe(status)
    expect(res.json().error.code, res.body).toBe(status === 404 ? 'not_found' : 'gone')
    for (const field of ['programme', 'timeline', 'coordinator', 'table', 'bus', 'sourceVersion', 'capturedAt']) expect(res.json()).not.toHaveProperty(field)
    for (const secret of ['Selected public programme', 'Public MAIN block', f.owner.phone, f.coordinator.phone, f.token, f.guestId, f.eventId]) expect(res.body).not.toContain(secret)
  }
  function metadata(res: Response, expected: string, from: string, to: string) {
    const body = res.json() as Day
    expect(typeof body.sourceVersion).toBe('string'); expect(body.sourceVersion).toBe(expected)
    expect(res.headers.etag).toBe(`"${expected}"`)
    const at = Date.parse(body.capturedAt)
    expect(Number.isFinite(at)).toBe(true)
    expect(at).toBeGreaterThanOrEqual(Date.parse(from)); expect(at).toBeLessThanOrEqual(Date.parse(to))
    expect(res.headers['cache-control']).toBe('no-store')
  }
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
  async function held(f: Fixture, weddingLock: boolean, afterRelease: (client: Queryable) => Promise<void>) {
    const ready = barrier<number>(), release = barrier<void>()
    const job = tracked(app.db!.tx(async client => {
      const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      if (weddingLock) await client.query('select id from weddings where id=$1 for update', [f.weddingId])
      await client.query('lock table timeline_events in access exclusive mode')
      ready.resolve(pid); await release.promise; await afterRelease(client)
    }))
    try {
      const pid = await Promise.race([ready.promise, job.outcome.then(result => {
        if (!result.ok) throw result.error
        throw new Error('Holder finished before signaling the lock barrier')
      })])
      return { pid, release: () => release.resolve(), job }
    } catch (error) { release.resolve(); await job.outcome; throw error }
  }
  async function removeInvitation(client: Queryable, f: Fixture) {
    const removed = await client.query('delete from guest_event_invitations where wedding_id=$1 and event_id=$2 and guest_id=$3', [f.weddingId, f.eventId, f.guestId])
    expect(removed.rowCount).toBe(1)
  }

  it('revoked exact invitation after an actual wedding wait refuses the selected programme', async () => {
    const f = await fixture()
    let expected!: Awaited<ReturnType<typeof footprint>>
    const holder = await held(f, true, async client => { await removeInvitation(client, f); expected = await footprint(f, client) })
    let read: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f))
      await blocked(holder.pid, read.settled, /from\s+weddings/i)
      holder.release(); await value(holder.job)
      denied(await value(read), 404, f)
      expect(await footprint(f)).toEqual(expected)
    } finally {
      holder.release()
      try { await value(holder.job) } finally { if (read) await value(read) }
    }
  })
  it('invited second person receives only its selected programme with exact BIGINT and unknown event metadata', async () => {
    const f = await fixture()
    await app.db!.query('update weddings set timeline_version=9007199254740993 where id=$1', [f.weddingId])
    const expected = await version(f), before = await footprint(f), from = await clock()
    const response = await get(f), to = await clock()
    projection(response, f); metadata(response, expected, from, to)
    expect(await footprint(f)).toEqual(before)
  })
  it('selected event has its own date, time zone and location without MAIN sidecars', async () => {
    const f = await fixture(true)
    const accepted = await app.inject({ method: 'POST', url: `/rsvp/${encodeURIComponent(f.token)}`, payload: { status: 'yes' } })
    expect(accepted.statusCode, accepted.body).toBe(200)
    const table = await app.inject({ method: 'POST', url: f.base + '/tables', headers: f.owner.headers, payload: { name: 'MAIN-only table' } })
    expect(table.statusCode, table.body).toBe(201)
    const seated = await app.inject({ method: 'PATCH', url: `${f.base}/guests/${f.primaryId}`, headers: f.owner.headers, payload: { tableId: table.json().id } })
    expect(seated.statusCode, seated.body).toBe(200)
    const bus = await app.inject({ method: 'POST', url: f.base + '/logistics/buses', headers: f.owner.headers, payload: { name: 'MAIN-only bus', seats: 4 } })
    expect(bus.statusCode, bus.body).toBe(201)
    const boarded = await app.inject({ method: 'POST', url: `/join/${encodeURIComponent(f.token)}/shuttle`, headers: { 'idempotency-key': randomUUID() }, payload: { busId: bus.json().id } })
    expect(boarded.statusCode, boarded.body).toBe(200)
    const before = await footprint(f), response = await get(f)
    projection(response, f)
    const defaultRead = await main(f)
    expect(defaultRead.statusCode, defaultRead.body).toBe(200)
    expect(defaultRead.json()).not.toHaveProperty('programme')
    expect(defaultRead.json().timeline.map((b: Block) => b.name)).toEqual(['Public MAIN block'])
    expect(defaultRead.json().venue).toBe('MAIN-only venue')
    expect(defaultRead.json().table).toEqual({ name: 'MAIN-only table' })
    expect(defaultRead.json().bus.name).toBe('MAIN-only bus')
    expect(defaultRead.json().coordinator).toEqual({ name: 'MAIN-only coordinator', phone: f.coordinator.phone })
    expect(await footprint(f)).toEqual(before)
  })
  it('unknown, declined and attending answers do not gate an invited programme', async () => {
    const f = await fixture()
    for (const status of ['unknown', 'declined', 'attending'] as const) {
      const roster = await app.inject({ method: 'GET', url: `${f.base}/events/${f.eventId}/rsvp`, headers: f.owner.headers })
      expect(roster.statusCode, roster.body).toBe(200)
      const person = (roster.json().people as { guestId: string; version: string }[]).find(p => p.guestId === f.guestId)!
      const corrected = await app.inject({ method: 'PUT', url: `${f.base}/events/${f.eventId}/rsvp/${f.guestId}`, headers: f.owner.headers,
        payload: { status, expectedVersion: person.version } })
      expect(corrected.statusCode, corrected.body).toBe(200)
      const before = await footprint(f)
      projection(await get(f), f); expect(await footprint(f)).toEqual(before)
    }
  })
  it('uninvited primary and another invited party are equally opaque', async () => {
    const f = await fixture(), before = await footprint(f)
    const responses = [await get(f, f.eventId, f.primaryId), await get(f, f.eventId, f.outsiderId)]
    for (const res of responses) denied(res, 404, f)
    expect(responses[0]!.json()).toEqual(responses[1]!.json())
    expect(await footprint(f)).toEqual(before)
  })
  it('foreign and absent people are equally opaque without reading their party', async () => {
    const f = await fixture(), other = await fixture(), before = await footprint(f), otherBefore = await footprint(other)
    const responses = [await get(f, f.eventId, other.guestId), await get(f, f.eventId, randomUUID())]
    for (const res of responses) denied(res, 404, f)
    expect(responses[0]!.json()).toEqual(responses[1]!.json())
    expect(await footprint(f)).toEqual(before); expect(await footprint(other)).toEqual(otherBefore)
  })
  it('foreign, absent and explicit MAIN event selectors are equally opaque', async () => {
    const f = await fixture(), other = await fixture(), before = await footprint(f), otherBefore = await footprint(other)
    const responses = [await get(f, other.eventId), await get(f, randomUUID()), await get(f, f.mainId)]
    for (const res of responses) denied(res, 404, f)
    for (const res of responses.slice(1)) expect(res.json()).toEqual(responses[0]!.json())
    expect(await footprint(f)).toEqual(before); expect(await footprint(other)).toEqual(otherBefore)
  })
  it('partial and malformed selectors return field validation without a MAIN fallback', async () => {
    const f = await fixture(), before = await footprint(f)
    for (const [query, field] of [
      [`eventId=${f.eventId}`, 'guestId'], [`guestId=${f.guestId}`, 'eventId'],
      [`eventId=bad&guestId=${f.guestId}`, 'eventId'], [`eventId=${f.eventId}&guestId=bad`, 'guestId'],
      [`eventId=&guestId=${f.guestId}`, 'eventId'], [`eventId=${f.eventId}&guestId=`, 'guestId'],
    ] as const) {
      const res = await app.inject({ method: 'GET', url: `/join/${encodeURIComponent(f.token)}/day?${query}` })
      expect(res.statusCode, res.body).toBe(422); expect(res.json().error.code).toBe('validation_failed')
      expect(res.json().error.fields).toHaveProperty(field)
      expect(res.json()).not.toHaveProperty('timeline'); expect(res.body).not.toContain('Public MAIN block')
    }
    expect(await footprint(f)).toEqual(before)
  })
  it('dead token and cancelled, archived or deleted invitation keep the existing 410 boundary', async () => {
    const f = await fixture()
    denied(await get(f, f.eventId, f.guestId, randomUUID()), 410, f)
    for (const state of ['cancelled', 'archived', 'deleted'] as const) {
      const own = await fixture()
      if (state === 'deleted') await app.db!.tx(async client => {
        await client.query('select id from weddings where id=$1 for update', [own.weddingId])
        await client.query('delete from guest_parties where id=$1 and wedding_id=$2', [own.partyId, own.weddingId])
      })
      else await app.db!.query(`update weddings set ${state}_at=clock_timestamp() where id=$1`, [own.weddingId])
      const before = await footprint(own)
      denied(await get(own), 410, own); expect(await footprint(own)).toEqual(before)
    }
  })
  it('token rotation committed during a wedding wait returns 410 before any selected data', async () => {
    const f = await fixture()
    let expected!: Awaited<ReturnType<typeof footprint>>
    const holder = await held(f, true, async client => {
      const next = randomUUID()
      await client.query('update guest_parties set invite_token=$2 where id=$1 and wedding_id=$3', [f.partyId, next, f.weddingId])
      await client.query('update guests set rsvp_token=$2 where party_id=$1 and party_position=1', [f.partyId, next])
      expected = await footprint(f, client)
    })
    let read: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f)); await blocked(holder.pid, read.settled, /from\s+weddings/i)
      holder.release(); await value(holder.job)
      denied(await value(read), 410, f); expect(await footprint(f)).toEqual(expected)
    } finally {
      holder.release(); try { await value(holder.job) } finally { if (read) await value(read) }
    }
  })
  it('selected member deletion during a wedding wait refuses it while retained family MAIN remains valid', async () => {
    const f = await fixture()
    let expected!: Awaited<ReturnType<typeof footprint>>
    const holder = await held(f, true, async client => {
      const removed = await client.query('delete from guests where id=$1 and party_id=$2 and wedding_id=$3', [f.guestId, f.partyId, f.weddingId])
      expect(removed.rowCount).toBe(1); expected = await footprint(f, client)
    })
    let read: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f)); await blocked(holder.pid, read.settled, /from\s+weddings/i)
      holder.release(); await value(holder.job)
      denied(await value(read), 404, f)
      expect((await main(f)).statusCode).toBe(200); expect(await footprint(f)).toEqual(expected)
    } finally {
      holder.release(); try { await value(holder.job) } finally { if (read) await value(read) }
    }
  })
  it('pinned invitation survives a data wait and real roster replacement queues until the read finishes', async () => {
    const f = await fixture(), roster = await app.inject({ method: 'GET', url: f.invitationPath, headers: f.owner.headers })
    expect(roster.statusCode, roster.body).toBe(200)
    const holder = await held(f, false, async () => {})
    let read: ReturnType<typeof tracked<Response>> | undefined, writer: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f)); const reader = await blocked(holder.pid, read.settled, /from\s+timeline_events/i)
      writer = tracked(app.inject({ method: 'PUT', url: f.invitationPath, headers: { ...f.owner.headers, 'if-match': roster.headers.etag! }, payload: { guestIds: [f.outsiderId] } }))
      await blocked(reader.pid, writer.settled, /from\s+weddings/i)
      expect(read.settled()).toBe(false); expect(writer.settled()).toBe(false)
      holder.release(); await value(holder.job)
      projection(await value(read), f)
      const replaced = await value(writer); expect(replaced.statusCode, replaced.body).toBe(200)
      const before = await footprint(f)
      denied(await get(f), 404, f); expect(await footprint(f)).toEqual(before)
    } finally {
      holder.release(); try { await value(holder.job) } finally {
        try { if (read) await value(read) } finally { if (writer) await value(writer) }
      }
    }
  })
  it('queued selected read captures committed event metadata and programme with the late database clock', async () => {
    const f = await fixture(true)
    let expectedVersion!: string, afterMutation!: string, expected!: Awaited<ReturnType<typeof footprint>>
    const holder = await held(f, true, async client => {
      await client.query('update wedding_events set location=$3,time_zone=$4 where wedding_id=$1 and id=$2', [f.weddingId, f.eventId, 'Committed selected location', 'Europe/Kaliningrad'])
      await client.query('update timeline_events set name=$2 where id=$1 and wedding_id=$3', [f.publicId, 'Committed selected programme', f.weddingId])
      expectedVersion = await version(f, client); expected = await footprint(f, client); afterMutation = await clock(client)
    })
    let read: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f)); await blocked(holder.pid, read.settled, /from\s+weddings/i)
      holder.release(); await value(holder.job)
      const response = await value(read), to = await clock()
      projection(response, { ...f, venue: 'Committed selected location', tz: 'Europe/Kaliningrad' }, 'Committed selected programme')
      metadata(response, expectedVersion, afterMutation, to); expect(await footprint(f)).toEqual(expected)
    } finally {
      holder.release(); try { await value(holder.job) } finally { if (read) await value(read) }
    }
  })
  it('real programme PUT waits behind the selected read, then fresh GET advances body and exact version together', async () => {
    const f = await fixture(), originalVersion = await version(f)
    const teamRead = await app.inject({ method: 'GET', url: f.timelinePath, headers: f.owner.headers })
    expect(teamRead.statusCode, teamRead.body).toBe(200)
    const changed = (teamRead.json() as Block[]).map(block => block.id === f.publicId ? { ...block, name: 'Next accepted selected programme' } : block)
    const from = await clock(), holder = await held(f, false, async () => {})
    let read: ReturnType<typeof tracked<Response>> | undefined, writer: ReturnType<typeof tracked<Response>> | undefined
    try {
      read = tracked(get(f)); const reader = await blocked(holder.pid, read.settled, /from\s+timeline_events/i)
      writer = tracked(app.inject({ method: 'PUT', url: f.timelinePath, headers: { ...f.owner.headers, 'if-match': teamRead.headers.etag! }, payload: changed }))
      await blocked(reader.pid, writer.settled, /from\s+weddings/i)
      expect(read.settled()).toBe(false); expect(writer.settled()).toBe(false)
      holder.release(); await value(holder.job)
      const response = await value(read), to = await clock()
      projection(response, f); metadata(response, originalVersion, from, to)
      const written = await value(writer); expect(written.statusCode, written.body).toBe(200)
      const next = await version(f); expect(BigInt(next)).toBeGreaterThan(BigInt(originalVersion))
      const freshFrom = await clock(), fresh = await get(f), freshTo = await clock()
      projection(fresh, f, 'Next accepted selected programme'); metadata(fresh, next, freshFrom, freshTo)
    } finally {
      holder.release(); try { await value(holder.job) } finally {
        try { if (read) await value(read) } finally { if (writer) await value(writer) }
      }
    }
  })
})
