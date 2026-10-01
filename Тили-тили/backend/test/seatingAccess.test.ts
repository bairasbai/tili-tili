import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48)
const POLICY = '2026-09-02'

describe.skipIf(!DB)('seating: live access after actual PostgreSQL waits', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })

  async function setup() {
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID()
    const consentId = randomUUID(), phone = '+79' + randomInt(100000000, 999999999)
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [userId, phone, 'Seating access test'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    await app.db!.query(`insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code)
      values($1,$2,'Seating access test','2027-06-14','Europe/Moscow',100000000,$3)`, [weddingId, userId, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, userId])
    const headers = { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
    const base = `/weddings/${weddingId}`
    const guest = await app.inject({ method: 'POST', url: base + '/guests', headers, payload: { name: 'Seating person', phone } })
    expect(guest.statusCode, guest.body).toBe(201)
    const guestId = guest.json().id as string
    const table = await app.inject({ method: 'POST', url: base + '/tables', headers, payload: { name: 'Original table', capacity: 2 } })
    expect(table.statusCode, table.body).toBe(201)
    const tableId = table.json().id as string
    return { userId, sessionId, consentId, weddingId, guestId, tableId, headers, base, phone }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>
  async function attachVendor(w: Fixture) {
    const userId = randomUUID(), vendorId = randomUUID(), slotId = randomUUID(), dealId = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [userId, '+79' + randomInt(100000000, 999999999), 'Seating vendor test'])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Seating vendor test',now())", [vendorId, userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Seating vendor test')", [slotId, w.weddingId])
    await app.db!.query(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,booked_at)
      values($1,$2,$3,$4,'booked',1000000,now())`, [dealId, w.weddingId, slotId, vendorId])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slotId, dealId])
  }
  type Response = Awaited<ReturnType<FastifyInstance['inject']>>
  type Door = 'guest PATCH' | 'guest DELETE' | 'table POST' | 'table PATCH' | 'table DELETE'
  const doors: Door[] = ['guest PATCH', 'guest DELETE', 'table POST', 'table PATCH', 'table DELETE']
  const changes = [
    { name: 'member removed', status: 404, code: 'not_found', sql: 'delete from wedding_members where wedding_id=$1 and user_id=$2', values: (w: Fixture) => [w.weddingId, w.userId] },
    { name: 'role denied', status: 403, code: 'forbidden', sql: "update wedding_members set role='vendor' where wedding_id=$1 and user_id=$2", values: (w: Fixture) => [w.weddingId, w.userId] },
    { name: 'session revoked', status: 401, code: 'unauthorized', sql: 'update sessions set revoked_at=now() where id=$1', values: (w: Fixture) => [w.sessionId] },
    { name: 'account deleted', status: 401, code: 'unauthorized', sql: 'update users set deleted_at=now() where id=$1', values: (w: Fixture) => [w.userId] },
    { name: 'wedding archived', status: 404, code: 'not_found', sql: 'update weddings set archived_at=now() where id=$1', values: (w: Fixture) => [w.weddingId] },
    { name: 'wedding cancelled', status: 404, code: 'not_found', sql: 'update weddings set cancelled_at=now() where id=$1', values: (w: Fixture) => [w.weddingId] },
    { name: 'consent withdrawn', status: 403, code: 'forbidden', sql: 'update consents set withdrawn_at=now() where id=$1', values: (w: Fixture) => [w.consentId] },
    { name: 'consent outdated', status: 403, code: 'consent_outdated', sql: "update consents set policy_version='2020-01-01' where id=$1", values: (w: Fixture) => [w.consentId] },
  ]
  function send(w: Fixture, door: Door, payload?: Record<string, unknown>) {
    switch (door) {
      case 'guest PATCH': return app.inject({ method: 'PATCH', url: w.base + '/guests/' + w.guestId, headers: w.headers, payload: payload ?? { tableId: w.tableId } })
      case 'guest DELETE': return app.inject({ method: 'DELETE', url: w.base + '/guests/' + w.guestId, headers: w.headers })
      case 'table POST': return app.inject({ method: 'POST', url: w.base + '/tables', headers: w.headers, payload: { name: 'Forbidden new table', capacity: 3 } })
      case 'table PATCH': return app.inject({ method: 'PATCH', url: w.base + '/tables/' + w.tableId, headers: w.headers, payload: { name: 'Forbidden rename' } })
      case 'table DELETE': return app.inject({ method: 'DELETE', url: w.base + '/tables/' + w.tableId, headers: w.headers })
    }
  }
  async function snapshot(w: Fixture) {
    const guests = await app.db!.query('select id,name,phone,table_id,party_id,party_position from guests where wedding_id=$1 order by id', [w.weddingId])
    const tables = await app.db!.query('select id,name,capacity,sort from tables where wedding_id=$1 order by id', [w.weddingId])
    const updates = await app.db!.query('select id,kind,text from vendor_updates where wedding_id=$1 order by id', [w.weddingId])
    return { guests: guests.rows, tables: tables.rows, updates: updates.rows }
  }
  async function blocked(client: Queryable, pid: number, settled: () => boolean) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      await client.query('select pg_stat_clear_snapshot()')
      const waiters = await client.query(`select pid from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [pid])
      if (waiters.rowCount! > 0) return
      if (settled()) throw new Error('HTTP settled before an actual PostgreSQL lock wait')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('No actual PostgreSQL lock wait observed before release')
  }
  async function whileWaiting(w: Fixture, door: Door, change: (client: Queryable) => Promise<unknown>, payload?: Record<string, unknown>, weddingLock = true) {
    let pending: Promise<Response> | undefined
    let settled = false
    let response: Response | undefined
    try {
      await app.db!.tx(async client => {
        const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        if (weddingLock) await client.query('select id from weddings where id=$1 for update', [w.weddingId])
        await client.query('select id from tables where id=$1 for update', [w.tableId])
        await client.query('select id from guests where id=$1 for update', [w.guestId])
        pending = send(w, door, payload).then(result => { settled = true; return result })
        await blocked(client, rows[0]!.pid, () => settled)
        await change(client)
      })
    } finally {
      if (pending) response = await pending
    }
    return response!
  }

  for (const door of doors) {
    for (const change of changes) {
      it(`${door} refuses ${change.name} committed during its actual lock wait`, async () => {
        const w = await setup(), before = await snapshot(w)
        const res = await whileWaiting(w, door, client => client.query(change.sql, change.values(w)))
        expect(res.statusCode, res.body).toBe(change.status)
        expect(res.json().error.code, res.body).toBe(change.code)
        expect(await snapshot(w)).toEqual(before)
      })
    }
  }
  for (const role of ['helper', 'coordinator']) {
    it(`guest PATCH rejects phone changes after couple becomes ${role} during the lock wait`, async () => {
      const w = await setup(), before = await snapshot(w)
      const res = await whileWaiting(w, 'guest PATCH', client => client.query(
        'update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role]), { phone: null, tableId: w.tableId })
      expect(res.statusCode, res.body).toBe(403)
      expect(res.json().error.code, res.body).toBe('forbidden')
      expect(await snapshot(w)).toEqual(before)
    })
    it(`guest PATCH keeps seating rights but omits private fields after couple becomes ${role} during the lock wait`, async () => {
      const w = await setup()
      await app.db!.query("update guests set comment='Private RSVP comment' where id=$1", [w.guestId])
      const invite = await app.inject({ method: 'POST', url: w.base + '/guests/' + w.guestId + '/invite-link', headers: w.headers })
      expect(invite.statusCode, invite.body).toBe(200)
      const res = await whileWaiting(w, 'guest PATCH', client => client.query(
        'update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role]))
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ id: w.guestId, tableId: w.tableId, hasPhone: true })
      for (const key of ['phone', 'comment', 'inviteUrl']) expect(res.json()).not.toHaveProperty(key)
      expect((await app.db!.query('select phone,comment,table_id from guests where id=$1', [w.guestId])).rows[0])
        .toEqual({ phone: w.phone, comment: 'Private RSVP comment', table_id: w.tableId })
    })
  }
  for (const door of doors) {
    it(`${door} refuses a real token expiring during its wedding lock wait`, async () => {
      const w = await setup(), before = await snapshot(w)
      const expires = Math.floor(Date.now() / 1000) + 3
      w.headers.authorization = 'Bearer ' + await signAccessToken(SECRET,
        { sub: w.userId, sid: w.sessionId }, (expires - ACCESS_TTL_SECONDS) * 1000)
      const res = await whileWaiting(w, door, async () => {
        while (Date.now() < expires * 1000) await new Promise(resolve => setTimeout(resolve, 10))
      })
      expect(res.statusCode, res.body).toBe(401)
      expect(res.json().error.code, res.body).toBe('token_expired')
      expect(await snapshot(w)).toEqual(before)
    })
  }
  for (const door of doors.filter(item => item !== 'table POST')) {
    it(`${door} rolls back when a real token expires during a later resource lock wait`, async () => {
      const w = await setup()
      await attachVendor(w)
      if (door === 'table DELETE') {
        const seated = await send(w, 'guest PATCH')
        expect(seated.statusCode, seated.body).toBe(200)
        await app.db!.query('delete from vendor_updates where wedding_id=$1', [w.weddingId])
      }
      const before = await snapshot(w)
      const version = (await app.db!.query('select timeline_version from weddings where id=$1', [w.weddingId])).rows[0]!.timeline_version
      const expires = Math.floor(Date.now() / 1000) + 3
      w.headers.authorization = 'Bearer ' + await signAccessToken(SECRET,
        { sub: w.userId, sid: w.sessionId }, (expires - ACCESS_TTL_SECONDS) * 1000)
      const res = await whileWaiting(w, door, async () => {
        while (Date.now() < expires * 1000) await new Promise(resolve => setTimeout(resolve, 10))
      }, undefined, false)
      expect(res.statusCode, res.body).toBe(401)
      expect(res.json().error.code, res.body).toBe('token_expired')
      expect(await snapshot(w)).toEqual(before)
      expect((await app.db!.query('select timeline_version from weddings where id=$1', [w.weddingId])).rows[0]!.timeline_version).toBe(version)
    })
  }
  it('allowed seating and table removal commit actual vendor updates and individual assignments', async () => {
    const w = await setup()
    await attachVendor(w)
    const seated = await send(w, 'guest PATCH')
    expect(seated.statusCode, seated.body).toBe(200)
    expect((await snapshot(w)).updates).toHaveLength(1)
    await app.db!.query('delete from vendor_updates where wedding_id=$1', [w.weddingId])
    const removed = await send(w, 'table DELETE')
    expect(removed.statusCode, removed.body).toBe(204)
    const after = await snapshot(w)
    expect(after.tables).toEqual([])
    expect(after.guests).toMatchObject([{ id: w.guestId, table_id: null }])
    expect(after.updates).toHaveLength(1)
  })
  for (const change of changes.filter(item => ['session revoked', 'account deleted', 'member removed', 'role denied', 'consent withdrawn', 'consent outdated'].includes(item.name))) {
    it(`pins ${change.name} until the later guest wait and transaction finish`, async () => {
      const w = await setup()
      let write: Promise<Response> | undefined, revoke: Promise<unknown> | undefined
      let writeSettled = false, revokeSettled = false
      try {
        await app.db!.tx(async client => {
          const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
          await client.query('select id from guests where id=$1 for update', [w.guestId])
          write = send(w, 'guest PATCH').then(res => { writeSettled = true; return res })
          await blocked(client, rows[0]!.pid, () => writeSettled)
          const waiters = await client.query<{ pid: number }>(`select pid from pg_stat_activity
            where wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [rows[0]!.pid])
          expect(waiters.rows).toHaveLength(1)
          revoke = app.db!.query(change.sql, change.values(w)).then(res => { revokeSettled = true; return res })
          await blocked(client, waiters.rows[0]!.pid, () => revokeSettled)
          expect(writeSettled).toBe(false)
          expect(revokeSettled).toBe(false)
        })
      } finally {
        if (write) {
          const res = await write
          expect(res.statusCode, res.body).toBe(200)
        }
        if (revoke) await revoke
      }
      expect((await app.db!.query('select table_id from guests where id=$1', [w.guestId])).rows[0]!.table_id).toBe(w.tableId)
      const denied = await send(w, 'guest PATCH', { tableId: null })
      expect(denied.statusCode, denied.body).toBe(change.status)
    })
  }
})
