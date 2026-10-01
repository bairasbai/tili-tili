import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48)
const POLICY = '2026-09-02'
const APPLICATION = 'guest_read_access_' + randomUUID()

describe.skipIf(!DB)('guest reads: fresh access and private projection through live PostgreSQL waits', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    const target = new URL(DB!)
    target.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: target.href, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })

  async function setup() {
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID(), consentId = randomUUID()
    const phone = '+79' + randomInt(100000000, 999999999)
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [userId, phone, 'Guest read access test'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    await app.db!.query(`insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code)
      values($1,$2,'Guest read access test','2027-06-14','Europe/Moscow',100000000,$3)`, [weddingId, userId, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, userId])
    const headers = { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
    const base = `/weddings/${weddingId}`
    const created = await app.inject({ method: 'POST', url: base + '/guests', headers, payload: { name: 'Private guest', phone } })
    expect(created.statusCode, created.body).toBe(201)
    const guestId = created.json().id as string
    await app.db!.query("update guests set comment='Private RSVP comment' where id=$1", [guestId])
    const invite = await app.inject({ method: 'POST', url: `${base}/guests/${guestId}/invite-link`, headers })
    expect(invite.statusCode, invite.body).toBe(200)
    const table = await app.inject({ method: 'POST', url: base + '/tables', headers, payload: { name: 'Read test table', capacity: 2 } })
    expect(table.statusCode, table.body).toBe(201)
    const tableId = table.json().id as string
    await app.db!.query('update guests set table_id=$2 where id=$1', [guestId, tableId])
    return { userId, sessionId, weddingId, consentId, phone, headers, base, guestId, tableId }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>
  type Response = Awaited<ReturnType<FastifyInstance['inject']>>
  const doors = ['guests', 'tables'] as const
  type Door = typeof doors[number]
  const send = (w: Fixture, door: Door) => app.inject({ method: 'GET', url: `${w.base}/${door}`, headers: w.headers })
  async function snapshot(w: Fixture) {
    const guests = await app.db!.query('select id,name,phone,comment,table_id from guests where wedding_id=$1 order by id', [w.weddingId])
    const tables = await app.db!.query('select id,name,capacity from tables where wedding_id=$1 order by id', [w.weddingId])
    const marks = await app.db!.query('select timeline_version,guests_reminded_at from weddings where id=$1', [w.weddingId])
    return { guests: guests.rows, tables: tables.rows, marks: marks.rows }
  }
  const changes = [
    { name: 'member removed', status: 404, code: 'not_found', sql: 'delete from wedding_members where wedding_id=$1 and user_id=$2', values: (w: Fixture) => [w.weddingId, w.userId] },
    { name: 'role denied', status: 403, code: 'forbidden', sql: "update wedding_members set role='vendor' where wedding_id=$1 and user_id=$2", values: (w: Fixture) => [w.weddingId, w.userId] },
    { name: 'session revoked', status: 401, code: 'unauthorized', sql: 'update sessions set revoked_at=now() where id=$1', values: (w: Fixture) => [w.sessionId] },
    { name: 'account deleted', status: 401, code: 'unauthorized', sql: 'update users set deleted_at=now() where id=$1', values: (w: Fixture) => [w.userId] },
    { name: 'wedding archived', status: 404, code: 'not_found', sql: 'update weddings set archived_at=now() where id=$1', values: (w: Fixture) => [w.weddingId] },
    { name: 'consent withdrawn', status: 403, code: 'forbidden', sql: 'update consents set withdrawn_at=now() where id=$1', values: (w: Fixture) => [w.consentId] },
    { name: 'consent outdated', status: 403, code: 'consent_outdated', sql: "update consents set policy_version='2020-01-01' where id=$1", values: (w: Fixture) => [w.consentId] },
  ]
  async function blocked(client: Queryable, pid: number, settled: () => boolean) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      await client.query('select pg_stat_clear_snapshot()')
      const waiters = await client.query<{ pid: number }>(`select pid from pg_stat_activity
        where datname=current_database() and application_name=$2
          and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [pid, APPLICATION])
      if (waiters.rowCount! > 0) return waiters.rows
      if (settled()) throw new Error('HTTP settled before an actual PostgreSQL lock wait')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('No actual PostgreSQL lock wait observed before release')
  }
  // Ordinary SELECT ignores row locks. A real table lock blocks the old read;
  // the wedding lock also lets the corrected read refresh access before data.
  async function whileWaiting(w: Fixture, door: Door, change: (client: Queryable) => Promise<unknown>, weddingLock = true) {
    let pending: Promise<Response> | undefined, settled = false
    try {
      await app.db!.tx(async client => {
        const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        if (weddingLock) await client.query('select id from weddings where id=$1 for update', [w.weddingId])
        await client.query(`lock table ${door} in access exclusive mode`)
        pending = send(w, door).then(response => { settled = true; return response })
        await blocked(client, rows[0]!.pid, () => settled)
        await change(client)
      })
    } finally { if (pending) await pending }
    return pending!
  }
  for (const door of doors) {
    for (const change of changes) {
      it(`${door} rejects ${change.name} committed while its actual read waits`, async () => {
        const w = await setup(), before = await snapshot(w)
        const res = await whileWaiting(w, door, client => client.query(change.sql, change.values(w)))
        expect(res.statusCode, res.body).toBe(change.status)
        expect(res.json().error.code, res.body).toBe(change.code)
        expect(await snapshot(w)).toEqual(before)
      })
    }
    it(`${door} remains readable when cancellation is committed during its wait`, async () => {
      const w = await setup()
      const res = await whileWaiting(w, door, client => client.query('update weddings set cancelled_at=now() where id=$1', [w.weddingId]))
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toHaveLength(1)
      expect(res.json()[0].id).toBe(door === 'guests' ? w.guestId : w.tableId)
    })
    for (const late of [false, true]) {
      it(`${door} refuses expiry during its ${late ? 'later data' : 'wedding'} wait`, async () => {
        const w = await setup(), before = await snapshot(w)
        const expires = Math.floor(Date.now() / 1000) + 3
        w.headers.authorization = 'Bearer ' + await signAccessToken(SECRET,
          { sub: w.userId, sid: w.sessionId }, (expires - ACCESS_TTL_SECONDS) * 1000)
        const res = await whileWaiting(w, door, async () => {
          while (Date.now() < expires * 1000) await new Promise(resolve => setTimeout(resolve, 10))
        }, !late)
        expect(res.statusCode, res.body).toBe(401)
        expect(res.json().error.code, res.body).toBe('token_expired')
        expect(await snapshot(w)).toEqual(before)
      })
    }
    for (const change of changes) {
      it(`${door} pins ${change.name} through its later data wait and denies the next read`, async () => {
        const w = await setup()
        let read: Promise<Response> | undefined, revoke: Promise<unknown> | undefined
        let readSettled = false, revokeSettled = false
        try {
          await app.db!.tx(async client => {
            const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
            await client.query(`lock table ${door} in access exclusive mode`)
            read = send(w, door).then(res => { readSettled = true; return res })
            const waiters = await blocked(client, rows[0]!.pid, () => readSettled)
            expect(waiters).toHaveLength(1)
            revoke = app.db!.query(change.sql, change.values(w)).then(res => { revokeSettled = true; return res })
            await blocked(client, waiters[0]!.pid, () => revokeSettled)
            expect(readSettled).toBe(false)
            expect(revokeSettled).toBe(false)
          })
        } finally {
          if (read) expect((await read).statusCode).toBe(200)
          if (revoke) await revoke
        }
        const res = await send(w, door)
        expect(res.statusCode, res.body).toBe(change.status)
      })
    }
  }
  for (const role of ['helper', 'coordinator']) {
    it(`guests uses the current ${role} projection after a couple role change during the wait`, async () => {
      const w = await setup()
      const res = await whileWaiting(w, 'guests', client => client.query(
        'update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role]))
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()[0]).toMatchObject({ id: w.guestId, hasPhone: true })
      for (const key of ['phone', 'comment', 'inviteUrl']) expect(res.json()[0]).not.toHaveProperty(key)
    })
    it(`tables preserves ${role} access and membership without exposing private guest data`, async () => {
      const w = await setup()
      const res = await whileWaiting(w, 'tables', client => client.query(
        'update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role]))
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual([{ id: w.tableId, name: 'Read test table', capacity: 2, guestIds: [w.guestId] }])
    })
  }
  it('couple still receives private guest fields but never a raw guest token', async () => {
    const w = await setup(), res = await send(w, 'guests')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()[0]).toMatchObject({ id: w.guestId, phone: w.phone, comment: 'Private RSVP comment' })
    expect(res.json()[0].inviteUrl).toMatch(/^https:\/\/tili-tili\.ru\/i\//)
    expect(JSON.stringify(res.json())).not.toMatch(/rsvp_token|invite_token|guestToken/)
  })
})
