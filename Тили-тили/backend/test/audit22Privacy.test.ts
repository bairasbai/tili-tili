import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import * as Sentry from '@sentry/node'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import { RealtimeHub } from '../src/realtime/hub.js'
import { seedUntrackedSlotDeal } from './helpers/dayFixture.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'

const verification = vi.hoisted(() => ({ pause: null as null | ((claims: { sub: string; sid: string; exp: number }) => Promise<void>) }))
// Test-only continuation pause after the real native signature/claims check.
// No claims, keys, expiry decisions or database rows are fabricated.
vi.mock('../src/auth/tokens.js', async importOriginal => {
  const canonical = await importOriginal<typeof import('../src/auth/tokens.js')>()
  return { ...canonical, verifyAccessToken: async (...args: Parameters<typeof canonical.verifyAccessToken>) => {
    const claims = await canonical.verifyAccessToken(...args)
    await verification.pause?.(claims)
    return claims
  } }
})

// Keep the real configured beforeSend boundary without an external transport.
vi.mock('@sentry/node', () => ({
  init: vi.fn(), flush: vi.fn(async () => true), captureException: vi.fn(() => 'synthetic-id'),
  withScope: vi.fn((fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => undefined })),
}))

const DB = process.env.TEST_DATABASE_URL
const REDIS = process.env.TEST_REDIS_URL
const SECRET = 'audit22-privacy-synthetic-access-'.repeat(3)
const POLICY = '2026-09-02'
const YEAR = new Date().getUTCFullYear() + 1
const MAIN_DATE = `${YEAR}-06-14`
const EVENT_DATE = `${YEAR}-06-16`
const config = {
  env: 'test' as const, databaseUrl: DB ?? null, redisUrl: REDIS ?? null, corsOrigins: [],
  jwtAccessSecret: SECRET, jwtRefreshSecret: 'audit22-synthetic-refresh-'.repeat(3), policyVersion: POLICY,
}
type Actor = { id: string; sid: string; token: string }
type WireEvent = { type: string; chatId?: string; message?: { id: string; text: string }; code?: string; status?: number }
const auth = (actor: Actor) => ({ authorization: `Bearer ${actor.token}` })
const documentBody = { templateCode: 'universal', fields: {
  customerFullName: 'Synthetic customer', performerFullName: 'Synthetic performer', passport: 'PRIVATE-AUDIT22',
} }

describe('BE01: asynchronous subscription lifecycle safeguards', () => {
  it.each([false, true])('a left/rejoined socket never receives an old queued event (rejection=%s)', async rejected => {
    const hub = new RealtimeHub()
    const sent: string[] = [], socket = { send: (wire: string) => { sent.push(wire) } }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const denied = vi.fn()
    const authorize = vi.fn(async (token: string, write: () => void) => {
      expect(token).toBe('old-token')
      await gate
      if (rejected) throw new Error('old session revoked')
      write()
    })
    hub.join('chat', socket, 'viewer', { token: 'old-token', withAccess: authorize, denied })
    const first = hub.publish({ chatId: 'chat', type: 'message', actorId: 'author', payload: { text: 'old first' } })
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce())
    const queued = hub.publish({ chatId: 'chat', type: 'message', actorId: 'author', payload: { text: 'old queued' } })
    hub.leave('chat', socket)
    let retained!: () => void
    const current = vi.fn(async (token: string, write: () => void) => { expect(token).toBe('new-token'); retained = write; write() })
    hub.join('chat', socket, 'viewer', { token: 'new-token', withAccess: current, denied: vi.fn() })
    release()
    await Promise.all([first, queued])
    expect(sent).toEqual([])
    expect(denied).not.toHaveBeenCalled()
    expect(hub.size('chat')).toBe(1)
    await hub.publish({ chatId: 'chat', type: 'message', actorId: 'author', payload: { text: 'current' } })
    expect(sent.map(wire => (JSON.parse(wire) as { text: string }).text)).toEqual(['current'])
    expect(current).toHaveBeenCalledOnce()
    retained(); retained()
    expect(sent).toHaveLength(1)
  })
})

describe('ROOT01: configured Sentry request sanitization', () => {
  it.each([
    ['/rsvp/guest-secret?lang=ru&token=jwt-secret#help', '/rsvp/***?lang=ru&token=***'],
    ['https://tili-tili.ru/rsvp/guest-secret?lang=ru&token=jwt-secret#help', 'https://tili-tili.ru/rsvp/***?lang=ru&token=***'],
    ['https://tili-tili.ru/guest-vendor/external-secret/chat?code=share-secret&view=day', 'https://tili-tili.ru/guest-vendor/***/chat?code=***&view=day'],
    ['https://tili-tili.ru/chats/c/ws?%74oken=jwt-secret&cursor=next', 'https://tili-tili.ru/chats/c/ws?%74oken=***&cursor=next'],
  ])('masks secrets and preserves URL structure: %s', async (url, expected) => {
    const app = await buildApp({ ...config, databaseUrl: null, redisUrl: null, sentryDsn: 'https://synthetic@sentry.example/1' })
    try {
      const beforeSend = vi.mocked(Sentry.init).mock.calls.at(-1)?.[0]?.beforeSend
      expect(beforeSend).toBeTypeOf('function')
      const event = { request: { url, headers: { authorization: 'Bearer private', cookie: 'private' },
        query_string: 'token=jwt-secret', data: 'private body' } }
      const sanitized = await beforeSend!(event, {})
      expect(sanitized?.request?.url).toBe(expected)
      expect(JSON.stringify(sanitized)).not.toMatch(/guest-secret|jwt-secret|share-secret|external-secret|private/)
      const parsed = new URL(String(sanitized?.request?.url), 'https://tili-tili.ru')
      expect(parsed.hostname).toBe('tili-tili.ru')
      // Fragments are irrelevant to the server and may contain private data.
      // Consistent removal is safe; retention is not an audit requirement.
      expect(parsed.hash).toBe('')
    } finally { await app.close() }
  })
})

describe.skipIf(!DB)('audit22: real HTTP/PG and WebSocket privacy boundaries', () => {
  let app: FastifyInstance
  let remote: FastifyInstance | undefined
  const bases = new Map<FastifyInstance, string>()
  const sockets = new Set<WebSocket>()
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>()

  beforeAll(async () => {
    app = await buildApp(config, [], { tillyModel: null })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const register = (instance: FastifyInstance) => {
      const address = instance.server.address()
      if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP listener')
      bases.set(instance, `ws://127.0.0.1:${address.port}`)
      process.stdout.write(`AUDIT22_LISTENER ${JSON.stringify({ pid: process.pid, port: address.port, owner: 'root audit22Privacy runner' })}\n`)
    }
    register(app)
    if (REDIS) {
      remote = await buildApp(config, [], { tillyModel: null })
      await remote.listen({ host: '127.0.0.1', port: 0 })
      register(remote)
      await vi.waitFor(async () => {
        const subscriptions = await app.redis!.pubsub('NUMSUB', 'tili:chat') as [string, number]
        expect(Number(subscriptions[1])).toBeGreaterThanOrEqual(2)
      }, { timeout: 5000 })
    }
  })

  afterEach(async () => {
    verification.pause = null
    for (const socket of sockets) socket.close()
    await vi.waitFor(() => {
      for (const socket of sockets) expect(socket.readyState).toBe(WebSocket.CLOSED)
    }, { timeout: 3000 })
    sockets.clear()
  })

  afterAll(async () => {
    try {
      // Only this fixture's own parents; audit/history rows are never erased directly.
      if (app?.db) await app.db.tx(async client => {
        for (const id of weddings) await client.query('delete from weddings where id=$1 and owner_id=any($2::uuid[])', [id, [...users]])
        for (const id of vendors) await client.query('delete from vendors where id=$1', [id])
        for (const id of users) await client.query('delete from users where id=$1', [id])
      })
    } finally {
      await remote?.close()
      await app?.close()
    }
  })

  async function session(id: string): Promise<Actor> {
    const sid = randomUUID()
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    return { id, sid, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  async function actor(): Promise<Actor> {
    const id = randomUUID()
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic audit22 actor')",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])
    users.add(id)
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return session(id)
  }
  async function wedding() {
    const pair = await actor()
    const created = await app.inject({ method: 'POST', url: '/weddings', headers: auth(pair), payload: {
      partnerName: 'Synthetic partner', date: MAIN_DATE, city: { name: 'Уфа', region: 'Башкортостан' },
    } })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id as string
    weddings.add(id)
    return { pair, id }
  }
  async function vendor() {
    const owner = await actor(), id = randomUUID()
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic audit22 vendor',now())", [id, owner.id])
    vendors.add(id)
    return { owner, id }
  }
  async function chatFixture(vendorChat = false) {
    const w = await wedding()
    if (vendorChat) {
      const v = await vendor()
      const created = await app.inject({ method: 'POST', url: `/chats/vendor/${v.id}`, headers: auth(w.pair) })
      expect(created.statusCode, created.body).toBe(200)
      return { ...w, viewer: v.owner, vendorId: v.id, chatId: created.json().id as string }
    }
    const viewer = await actor()
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [w.id, viewer.id])
    // The real trigger creates team/crew only at the second committed deal.
    // A fresh wedding has day/tilly, not an immediately available team chat.
    const positions = (await app.db!.query<{ id: string; category_id: string }>(
      "select id,category_id from slots where wedding_id=$1 and category_id in ('photo','video') order by category_id", [w.id])).rows
    expect(positions).toHaveLength(2)
    for (const position of positions) await seedUntrackedSlotDeal(app, {
      weddingId: w.id, slotId: position.id, externalName: `Synthetic ${position.category_id}`,
      state: 'booked', price: 17000,
    })
    const { rows } = await app.db!.query<{ id: string }>("select id from chats where wedding_id=$1 and kind='team'", [w.id])
    expect(rows).toHaveLength(1)
    return { ...w, viewer, vendorId: null, chatId: rows[0]!.id }
  }
  function watch(instance: FastifyInstance, chatId: string, viewer: Actor) {
    const socket = new WebSocket(`${bases.get(instance)}/chats/${chatId}/ws?token=${encodeURIComponent(viewer.token)}`)
    sockets.add(socket)
    const events: WireEvent[] = []
    socket.addEventListener('message', event => events.push(JSON.parse(String(event.data)) as WireEvent))
    const event = async (type: string, id?: string) => {
      await vi.waitFor(() => expect(events.some(item => item.type === type && (!id || item.message?.id === id))).toBe(true), { timeout: 3000 })
      return events.find(item => item.type === type && (!id || item.message?.id === id))!
    }
    return { socket, events, event, ready: () => event('ready') }
  }
  async function send(pair: Actor, chatId: string, text = 'Private message after completed revocation') {
    const response = await app.inject({ method: 'POST', url: `/chats/${chatId}/messages`, headers: auth(pair), payload: { text } })
    expect(response.statusCode, response.body).toBe(201)
    return response.json() as { id: string; text: string }
  }

  for (const node of ['local', 'remote'] as const) {
    it.skipIf(node === 'remote' && !REDIS).each(['session', 'consent', 'membership', 'vendor block'] as const)(
      `BE01: ${node} node stops new messages after %s revocation`, async reason => {
        const f = await chatFixture(reason === 'vendor block')
        const receiver = watch(node === 'remote' ? remote! : app, f.chatId, f.viewer)
        const control = watch(app, f.chatId, f.pair)
        const survivor = reason === 'session' ? watch(app, f.chatId, await session(f.viewer.id)) : undefined
        await Promise.all([receiver.ready(), control.ready(), survivor?.ready()])
        // Positive control proves the subscription and real bridge were working.
        const before = await send(f.pair, f.chatId, 'Before revocation')
        await receiver.event('message', before.id)
        if (reason === 'session') {
          const revoked = await app.inject({ method: 'DELETE', url: `/users/me/sessions/${f.viewer.sid}`, headers: auth(f.viewer) })
          expect(revoked.statusCode, revoked.body).toBe(204)
        } else if (reason === 'consent') {
          await app.db!.query('update consents set withdrawn_at=now() where user_id=$1 and withdrawn_at is null', [f.viewer.id])
        } else if (reason === 'membership') {
          await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.id, f.viewer.id])
        } else {
          await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
        }
        const denied = await app.inject({ method: 'GET', url: `/chats/${f.chatId}/messages`, headers: auth(f.viewer) })
        expect([401, 403, 404]).toContain(denied.statusCode)
        const after = await send(f.pair, f.chatId)
        await control.event('message', after.id)
        await survivor?.event('message', after.id)
        // Observe either the forbidden payload (baseline) or the closed socket
        // (correct behavior), so RED names the privacy outcome explicitly.
        await vi.waitFor(() => expect(receiver.socket.readyState === WebSocket.CLOSED ||
          receiver.events.some(event => event.message?.id === after.id)).toBe(true), { timeout: 1500 })
        expect(receiver.events.filter(event => event.message?.id === after.id)).toEqual([])
        expect(receiver.socket.readyState).toBe(WebSocket.CLOSED)
      },
    )
  }

  it.each(['session', 'consent'] as const)('BE01: completed %s revocation during the real auth-to-ACL continuation forbids delivery', async reason => {
    const f = await chatFixture()
    const receiver = watch(app, f.chatId, f.viewer), control = watch(app, f.chatId, f.pair)
    await Promise.all([receiver.ready(), control.ready()])
    const before = await send(f.pair, f.chatId, 'Positive control before paused delivery')
    await receiver.event('message', before.id)

    // Deliberate transport/continuation pause only: the actual canonical
    // authorizeToken has already executed real session+consent SELECTs. Its
    // returned claims/rows are never invented or replaced by the fixture.
    let release!: () => void, paused = false, armed = true
    const gate = new Promise<void>(resolve => { release = resolve })
    const canonical = app.authorizeToken.bind(app)
    const authorization = vi.spyOn(app, 'authorizeToken').mockImplementation(async token => {
      const claims = await canonical(token)
      if (armed && token === f.viewer.token) { armed = false; paused = true; await gate }
      return claims
    })
    const pending = send(f.pair, f.chatId, 'Private payload after a completed mid-check revocation')
    void pending.catch(() => undefined)
    try {
      await vi.waitFor(() => expect(paused).toBe(true), { timeout: 3000 })
      if (reason === 'session') {
        const revoked = await app.inject({ method: 'DELETE', url: `/users/me/sessions/${f.viewer.sid}`, headers: auth(f.viewer) })
        expect(revoked.statusCode, revoked.body).toBe(204)
      } else {
        const revoked = await app.db!.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1 and withdrawn_at is null', [f.viewer.id])
        expect(revoked.rowCount).toBe(1)
      }
      const denied = await app.inject({ method: 'GET', url: `/chats/${f.chatId}/messages`, headers: auth(f.viewer) })
      expect(denied.statusCode).toBe(reason === 'session' ? 401 : 403)
      release()
      const message = await pending
      await control.event('message', message.id)
      await vi.waitFor(() => expect(receiver.socket.readyState === WebSocket.CLOSED ||
        receiver.events.some(event => event.message?.id === message.id)).toBe(true), { timeout: 1500 })
      expect(receiver.events.filter(event => event.message?.id === message.id)).toEqual([])
      expect(receiver.socket.readyState).toBe(WebSocket.CLOSED)
    } finally {
      release()
      authorization.mockRestore()
      await pending
    }
  })

  it('BE01: native membership ABA cannot authorize a grant absent from the pinned rows', async () => {
    const f = await chatFixture()
    const receiver = watch(app, f.chatId, f.viewer), control = watch(app, f.chatId, f.pair)
    await Promise.all([receiver.ready(), control.ready()])
    const positive = await send(f.pair, f.chatId, 'Positive helper observer before native membership ABA')
    await receiver.event('message', positive.id)

    const gate = () => { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() } }
    const plain = gate(), pin = gate(), verified = gate()
    let plainPaused = false, pinPaused = false, verifiedPaused = false, finalGrantObserved = false
    let originalDeleted = false, grantDeleted = false
    let readerPid: number | undefined, writerPid: number | undefined, grantCompleted = false, grantBlockedByReader = false
    let grantError: unknown, primaryError: unknown
    let finalizerFailure: AggregateError | undefined
    let grantWriter: Promise<void> | undefined
    const grantGraphs: unknown[] = []
    const pinRows: unknown[][] = [], finalAclRows: { role: unknown; id: unknown }[][] = []
    const db = app.db!, nativeQuery: Queryable['query'] = db.query.bind(db), nativeTx: Db['tx'] = db.tx.bind(db)
    const isAcl = (sql: string, values?: readonly unknown[]) => sql.includes('from chats c') && sql.includes('as caller_blocked') &&
      values?.[0] === f.chatId && values[1] === f.viewer.id
    const outerQuery = vi.spyOn(db, 'query').mockImplementation(async function query<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
      const result = await nativeQuery<Row>(sql, values)
      if (!plainPaused && isAcl(sql, values)) {
        expect(result.rows[0]?.role).toBe('helper')
        plainPaused = true
        await plain.promise
      }
      return result
    })
    const transactions = vi.spyOn(db, 'tx').mockImplementation(async function tx<T>(action: (client: Queryable) => Promise<T>) {
      return nativeTx(async client => action({ query: async function query<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
        const result = await client.query<Row>(sql, values)
        if (originalDeleted && !pinPaused && sql.includes('from wedding_members') && sql.includes('for share') &&
          values?.[0] === f.id && values[1] === f.viewer.id) {
          expect(result.rows).toEqual([])
          readerPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          pinRows.push([...result.rows]); pinPaused = true
          await pin.promise
        }
        if (pinPaused && isAcl(sql, values)) {
          finalAclRows.push(result.rows.map(row => ({ role: row.role, id: row.id })))
          // With the strong principal pin the INSERT is still uncommitted:
          // the real ACL must see null and produce its own 404, not a fixture 500.
          expect(result.rows[0]?.role).toBe(grantBlockedByReader ? null : 'helper')
          finalGrantObserved = result.rows[0]?.role === 'helper'
        }
        return result
      } }))
    })
    verification.pause = async claims => {
      if (finalGrantObserved && !verifiedPaused && claims.sub === f.viewer.id && claims.sid === f.viewer.sid) {
        verifiedPaused = true
        await verified.promise
      }
    }
    const pending = send(f.pair, f.chatId, 'Forbidden payload after native grant ABA completed')
    void pending.catch(() => undefined)
    try {
      await vi.waitFor(() => expect(plainPaused).toBe(true), { timeout: 3000 })
      const removed = await nativeQuery('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.id, f.viewer.id])
      expect(removed.rowCount).toBe(1); originalDeleted = true; plain.release()
      await vi.waitFor(() => expect(pinPaused).toBe(true), { timeout: 3000 })
      grantWriter = nativeTx(async client => {
        await client.query("select set_config('application_name',$1,true)", [`audit22-aba-grant-${randomUUID()}`])
        writerPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        const granted = await client.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.id, f.viewer.id])
        expect(granted.rowCount).toBe(1)
      }).then(() => { grantCompleted = true }, error => { grantError = error })
      await vi.waitFor(async () => {
        if (writerPid && !grantCompleted && grantError === undefined) {
          const graph = (await nativeQuery<{ pid: number; wait_event_type: string | null; wait_event: string | null; blockers: number[] }>(
            'select pid,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1', [writerPid])).rows[0]
          if (graph?.blockers.includes(readerPid!)) { grantBlockedByReader = true; grantGraphs.push(graph) }
        }
        expect(grantCompleted || grantBlockedByReader || grantError !== undefined).toBe(true)
      }, { timeout: 3000 })
      if (grantError !== undefined) throw grantError
      const grantCompletedBeforePinRelease = grantCompleted
      pin.release()
      if (grantCompletedBeforePinRelease) {
        // Original RED schedule: the actual inserted grant reaches canonical
        // ACL, then its DELETE completes before final verification resumes.
        await vi.waitFor(() => expect(verifiedPaused || receiver.socket.readyState === WebSocket.CLOSED).toBe(true), { timeout: 3000 })
      } else {
        expect(grantBlockedByReader).toBe(true)
        await vi.waitFor(() => expect(receiver.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 3000 })
        expect(receiver.events.find(event => event.type === 'error')).toMatchObject({ status: 404, code: 'not_found' })
        await grantWriter
        if (grantError !== undefined) throw grantError
        expect(grantCompleted).toBe(true)
      }
      const deleted = await nativeQuery('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.id, f.viewer.id])
      expect(deleted.rowCount).toBe(1); grantDeleted = true; verified.release()
      const message = await pending
      await control.event('message', message.id)
      await vi.waitFor(() => expect(receiver.socket.readyState === WebSocket.CLOSED ||
        receiver.events.some(event => event.message?.id === message.id)).toBe(true), { timeout: 1500 })
      const forbidden = receiver.events.filter(event => event.message?.id === message.id)
      verification.pause = null
      const denied = await app.inject({ method: 'GET', url: `/chats/${f.chatId}/messages`, headers: auth(f.viewer) })
      expect(denied.statusCode, denied.body).toBe(404)
      process.stdout.write(`AUDIT22_NATIVE_ABA ${JSON.stringify({ plainPaused, pinPaused, pinRows, finalGrantObserved, finalAclRows,
        verifiedPaused, originalDeleted, grantDeleted, readerPid, writerPid, grantCompletedBeforePinRelease,
        grantBlockedByReader, grantGraphs, grantCompletedAfterRelease: grantCompleted,
        canonicalHttpStatus: denied.statusCode, wireError: receiver.events.find(event => event.type === 'error'),
        forbiddenMessageIds: forbidden.map(event => event.message?.id) })}\n`)
      expect(forbidden).toEqual([])
      expect(receiver.socket.readyState).toBe(WebSocket.CLOSED)
      expect(receiver.events.find(event => event.type === 'error')).toMatchObject({ status: 404, code: 'not_found' })
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      plain.release(); pin.release(); verified.release(); verification.pause = null
      outerQuery.mockRestore(); transactions.mockRestore()
      const finalized = await Promise.allSettled([pending, grantWriter ?? Promise.resolve()])
      const failures = finalized.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (grantError !== undefined) failures.push(grantError)
      if (grantCompleted && !grantDeleted) {
        try { await nativeQuery('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.id, f.viewer.id]) }
        catch (error) { failures.push(error) }
      }
      if (failures.length) finalizerFailure = new AggregateError([...new Set([...(primaryError === undefined ? [] : [primaryError]), ...failures])], 'Native ABA fixture finalizer failed')
    }
    // A primary try error is already rethrown above; do not mask it from finally.
    if (finalizerFailure) throw finalizerFailure
  })

  it.each(['bound vendor owner', 'crew membership'] as const)('BE01: native negative %s predicate is stable through the synchronous send', async kind => {
    let viewer: Actor, author: Actor, chatId: string, weddingId: string, vendorId: string, oldOwnerId: string
    if (kind === 'bound vendor owner') {
      const f = await chatFixture(true)
      viewer = f.pair; author = await actor(); chatId = f.chatId; weddingId = f.id; vendorId = f.vendorId!; oldOwnerId = f.viewer.id
      await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, author.id])
      await app.db!.query('update vendors set blocked_at=clock_timestamp() where id=$1', [vendorId])
    } else {
      const w = await wedding(), v = await vendor()
      viewer = v.owner; author = await actor(); weddingId = w.id; vendorId = v.id; oldOwnerId = v.owner.id
      await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'coordinator')", [weddingId, author.id])
      const positions = (await app.db!.query<{ id: string; category_id: string }>(
        "select id,category_id from slots where wedding_id=$1 and category_id in ('photo','video') order by category_id", [weddingId])).rows
      expect(positions).toHaveLength(2)
      for (const position of positions) await seedUntrackedSlotDeal(app, {
        weddingId, slotId: position.id, state: 'booked', price: 17000,
        ...(position.category_id === 'photo' ? { vendorId } : { externalName: 'Synthetic crew second performer' }),
      })
      chatId = (await app.db!.query<{ id: string }>("select id from chats where wedding_id=$1 and kind='crew'", [weddingId])).rows[0]!.id
    }
    const receiver = watch(app, chatId, viewer), control = watch(app, chatId, author)
    await Promise.all([receiver.ready(), control.ready()])
    const positive = await send(author, chatId, 'Positive observer before native negative predicate change')
    await receiver.event('message', positive.id)

    const db = app.db!, nativeQuery: Queryable['query'] = db.query.bind(db), nativeTx: Db['tx'] = db.tx.bind(db)
    let release!: () => void, paused = false, finalAcl = false, readerPid: number | undefined, writerPid: number | undefined
    let completed = false, writerError: unknown, blockedByReader = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const graphs: unknown[] = []
    const transactions = vi.spyOn(db, 'tx').mockImplementation(async function tx<T>(action: (client: Queryable) => Promise<T>) {
      return nativeTx(async client => action({ query: async function query<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
        const result = await client.query<Row>(sql, values)
        if (sql.includes('from chats c') && sql.includes('as caller_blocked') && values?.[0] === chatId && values[1] === viewer.id) {
          expect(result.rows).toHaveLength(1)
          if (kind === 'bound vendor owner') {
            expect(result.rows[0]?.role).toBe('couple')
            expect(result.rows[0]?.owner_id).toBe(oldOwnerId)
          } else {
            expect(result.rows[0]?.role).toBeNull()
            expect(result.rows[0]?.booked).toBe(true)
          }
          readerPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          finalAcl = true
        }
        return result
      } }))
    })
    verification.pause = async claims => {
      if (finalAcl && !paused && claims.sub === viewer.id && claims.sid === viewer.sid) { paused = true; await gate }
    }
    const sending = send(author, chatId, 'Private payload at the native predicate boundary')
    void sending.catch(() => undefined)
    let writer: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(paused).toBe(true), { timeout: 3000 })
      writer = nativeTx(async client => {
        await client.query("select set_config('application_name',$1,true)", [`audit22-negative-${randomUUID()}`])
        writerPid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        if (kind === 'bound vendor owner') {
          // Use the real bounded native prefix before the UPDATE. Its account
          // locks precede vendor mutation; no NOWAIT fallback is bypassed.
          await prepareLegacyCalendarScope(client, { vendorIds: [vendorId], personIds: [oldOwnerId, viewer.id], extraAccountIds: [oldOwnerId, viewer.id] })
          expect((await client.query('update vendors set user_id=$2 where id=$1', [vendorId, viewer.id])).rowCount).toBe(1)
        } else {
          expect((await client.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [weddingId, viewer.id])).rowCount).toBe(1)
        }
      }).then(() => { completed = true }, error => { writerError = error })
      await vi.waitFor(async () => {
        if (writerPid && !completed && writerError === undefined) {
          const graph = (await nativeQuery<{ pid: number; application_name: string; wait_event_type: string | null; wait_event: string | null; blockers: number[] }>(
            'select pid,application_name,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1', [writerPid])).rows[0]
          if (graph?.blockers.includes(readerPid!)) { blockedByReader = true; graphs.push(graph) }
        }
        expect(completed || blockedByReader || writerError !== undefined).toBe(true)
      }, { timeout: 3000 })
      if (writerError !== undefined) throw writerError
      const completedBeforeRelease = completed
      release()
      const message = await sending
      await control.event('message', message.id)
      if (completedBeforeRelease) {
        await vi.waitFor(() => expect(receiver.socket.readyState === WebSocket.CLOSED ||
          receiver.events.some(event => event.message?.id === message.id)).toBe(true), { timeout: 1500 })
        const forbidden = receiver.events.filter(event => event.message?.id === message.id)
        process.stdout.write(`AUDIT22_NATIVE_NEGATIVE ${JSON.stringify({ kind, finalAcl, paused, readerPid, writerPid,
          completedBeforeRelease, blockedByReader, graphs, forbiddenMessageIds: forbidden.map(event => event.message?.id) })}\n`)
        expect(forbidden).toEqual([])
        expect(receiver.socket.readyState).toBe(WebSocket.CLOSED)
      } else {
        // A real wait edge proves reader pins linearize this first write
        // before the native mutation can commit. That frame is legitimate.
        expect(blockedByReader).toBe(true)
        await receiver.event('message', message.id)
        await writer
        if (writerError !== undefined) throw writerError
        expect(completed).toBe(true)
        const after = await send(author, chatId, 'Private payload after native mutation commit')
        await control.event('message', after.id)
        await vi.waitFor(() => expect(receiver.socket.readyState === WebSocket.CLOSED ||
          receiver.events.some(event => event.message?.id === after.id)).toBe(true), { timeout: 1500 })
        const forbidden = receiver.events.filter(event => event.message?.id === after.id)
        process.stdout.write(`AUDIT22_NATIVE_NEGATIVE ${JSON.stringify({ kind, finalAcl, paused, readerPid, writerPid,
          completedBeforeRelease, blockedByReader, graphs, completedAfterRelease: completed,
          serializedMessageId: message.id, forbiddenMessageIds: forbidden.map(event => event.message?.id) })}\n`)
        expect(forbidden).toEqual([])
        expect(receiver.socket.readyState).toBe(WebSocket.CLOSED)
      }
    } finally {
      release(); verification.pause = null; transactions.mockRestore()
      await sending
      await writer
    }
  })

  it('BE01 safeguards: message order and typing exclusion survive delivery authorization', async () => {
    const f = await chatFixture()
    const author = watch(app, f.chatId, f.pair), receiver = watch(remote ?? app, f.chatId, f.viewer)
    await Promise.all([author.ready(), receiver.ready()])
    const typing = await app.inject({ method: 'POST', url: `/chats/${f.chatId}/typing`, headers: auth(f.pair) })
    expect(typing.statusCode).toBe(204)
    await receiver.event('typing')
    const first = await send(f.pair, f.chatId, 'first'), second = await send(f.pair, f.chatId, 'second')
    await receiver.event('message', second.id)
    expect(receiver.events.filter(event => event.type === 'message').map(event => event.message?.id)).toEqual([first.id, second.id])
    expect(author.events.filter(event => event.type === 'typing')).toEqual([])
  })

  it('BE01 safeguards: an open connection expires and leaves its room without receiving later messages', async () => {
    const f = await chatFixture()
    const token = await signAccessToken(SECRET, { sub: f.viewer.id, sid: f.viewer.sid }, Date.now() - (ACCESS_TTL_SECONDS - 3) * 1000)
    const receiver = watch(app, f.chatId, { ...f.viewer, token })
    await receiver.ready()
    await vi.waitFor(() => expect(receiver.socket.readyState).toBe(WebSocket.CLOSED), { timeout: 4500 })
    expect(receiver.events.find(event => event.type === 'error')?.code).toBe('token_expired')
    expect(app.realtime.size(f.chatId)).toBe(0)
    const message = await send(f.pair, f.chatId, 'After token expiry')
    expect(receiver.events.some(event => event.message?.id === message.id)).toBe(false)
  })

  async function dealFixture(additionalDate?: string | null) {
    const w = await wedding(), v = await vendor()
    let slotId: string
    if (additionalDate !== undefined) {
      const read = await app.inject({ method: 'GET', url: `/weddings/${w.id}/events`, headers: auth(w.pair) })
      const created = await app.inject({ method: 'POST', url: `/weddings/${w.id}/events`,
        headers: { ...auth(w.pair), 'if-match': String(read.headers.etag) },
        payload: { name: 'Synthetic additional programme', kind: 'second_day', date: additionalDate, timeZone: 'Asia/Vladivostok' } })
      expect(created.statusCode, created.body).toBe(201)
      const slot = await app.inject({ method: 'POST', url: `/weddings/${w.id}/slots/additional`,
        headers: { ...auth(w.pair), 'idempotency-key': randomUUID() },
        payload: { categoryId: 'photo', programEventId: created.json().id, label: 'Additional photo' } })
      expect(slot.statusCode, slot.body).toBe(201)
      slotId = slot.json().id as string
    } else {
      slotId = (await app.db!.query<{ id: string }>("select id from slots where wedding_id=$1 and category_id='photo' order by sort limit 1", [w.id])).rows[0]!.id
    }
    const { dealId } = await seedUntrackedSlotDeal(app, { weddingId: w.id, slotId, vendorId: v.id, state: 'booked', price: 17000 })
    return { ...w, vendor: v, dealId }
  }
  const contract = (dealId: string, caller: Actor, key = randomUUID()) => app.inject({ method: 'POST', url: `/deals/${dealId}/contract`,
    headers: { ...auth(caller), 'idempotency-key': key }, payload: documentBody })

  it('BE02 safeguards: an outsider gets opaque 404 without waiting for the foreign wedding lock', async () => {
    const f = await dealFixture(), outsider = await actor()
    let release!: () => void, locked!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const acquired = new Promise<void>(resolve => { locked = resolve })
    const holder = app.db!.tx(async client => {
      await client.query('select id from weddings where id=$1 for update', [f.id])
      locked()
      await gate
    })
    await acquired
    let status: number | undefined
    const denied = contract(f.dealId, outsider).then(response => { status = response.statusCode })
    try {
      await vi.waitFor(() => expect(status).toBe(404), { timeout: 1500 })
    } finally {
      release()
      await Promise.all([holder, denied])
    }
  })

  it.each(['demotion', 'removal', 'vendor ownership'] as const)('BE02: replay requires current access after %s change', async reason => {
    const f = await dealFixture()
    const requester = reason === 'vendor ownership' ? f.vendor.owner : await actor()
    if (reason !== 'vendor ownership') await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.id, requester.id])
    const key = randomUUID()
    const first = await contract(f.dealId, requester, key)
    expect(first.statusCode, first.body).toBe(201)
    const positive = await contract(f.dealId, requester, key)
    expect(positive.statusCode, positive.body).toBe(201)
    expect(positive.json()).toEqual(first.json())
    if (reason === 'demotion') await app.db!.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.id, requester.id])
    else if (reason === 'removal') await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.id, requester.id])
    else await app.db!.query('update vendors set user_id=$2 where id=$1', [f.vendor.id, (await actor()).id])
    const fresh = await contract(f.dealId, requester)
    expect(fresh.statusCode).toBe(reason === 'demotion' ? 403 : 404)
    const replay = await contract(f.dealId, requester, key)
    expect(replay.statusCode, replay.body).toBe(fresh.statusCode)
    expect(replay.body).not.toContain('PRIVATE-AUDIT22')
    expect((await app.db!.query('select id from documents where deal_id=$1', [f.dealId])).rows).toHaveLength(1)
  })

  it('BE03: blocked vendor cannot recover new message previews from the chat list', async () => {
    const f = await chatFixture(true)
    await app.db!.query('update vendors set blocked_at=now() where id=$1', [f.vendorId])
    await send(f.pair, f.chatId, 'AUDIT22-NEW-PRIVATE-PREVIEW')
    const history = await app.inject({ method: 'GET', url: `/chats/${f.chatId}/messages`, headers: auth(f.viewer) })
    expect(history.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/chats', headers: auth(f.viewer) })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().find((chat: { id: string }) => chat.id === f.chatId)).toBeUndefined()
    expect(list.body).not.toContain('AUDIT22-NEW-PRIVATE-PREVIEW')
    const pairList = await app.inject({ method: 'GET', url: '/chats', headers: auth(f.pair) })
    expect(pairList.body).toContain('AUDIT22-NEW-PRIVATE-PREVIEW')
  })

  it.each([['main', undefined, MAIN_DATE], ['additional', EVENT_DATE, EVENT_DATE], ['undated additional', null, null]] as const)(
    'FE05: server contract uses %s effective programme date', async (_label, date, expected) => {
      const f = await dealFixture(date)
      const response = await contract(f.dealId, f.pair)
      expect(response.statusCode, response.body).toBe(201)
      expect(response.json().fields).toMatchObject({ weddingDate: expected, amount: 17000, currency: 'RUB', passport: 'PRIVATE-AUDIT22' })
      const stored = (await app.db!.query<{ fields: { weddingDate: string | null } }>('select fields from documents where id=$1', [response.json().id])).rows[0]!
      expect(stored.fields.weddingDate).toBe(expected)
    },
  )
})
