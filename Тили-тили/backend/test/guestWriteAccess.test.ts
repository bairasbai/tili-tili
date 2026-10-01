import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48)
const POLICY = '2026-09-02'

describe.skipIf(!DB)('guest writes: live PostgreSQL access and committed responses', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })

  async function setup() {
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID(), consentId = randomUUID()
    const phone = '+79' + randomInt(100000000, 999999999)
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [userId, phone, 'Guest write access test'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    await app.db!.query(`insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code)
      values($1,$2,'Guest write access test','2027-06-14','Europe/Moscow',100000000,$3)`, [weddingId, userId, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, userId])
    const headers = { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
    const base = `/weddings/${weddingId}/guests`
    const guest = await app.inject({ method: 'POST', url: base, headers, payload: { name: 'Original person', phone } })
    expect(guest.statusCode, guest.body).toBe(201)
    const guestId = guest.json().id as string
    const invite = await app.inject({ method: 'POST', url: `${base}/${guestId}/invite-link`, headers })
    expect(invite.statusCode, invite.body).toBe(200)
    return { userId, sessionId, weddingId, consentId, phone, headers, base, guestId }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>
  type Response = Awaited<ReturnType<FastifyInstance['inject']>>
  const doors = ['create', 'import', 'member', 'invite'] as const
  type Door = typeof doors[number]
  function send(w: Fixture, door: Door, withPhone = false) {
    const person = { name: 'New person', ...(withPhone ? { phone: '+79170005566' } : {}) }
    switch (door) {
      case 'create': return app.inject({ method: 'POST', url: w.base, headers: w.headers, payload: person })
      case 'import': return app.inject({ method: 'POST', url: w.base + '/import', headers: w.headers, payload: { guests: [person] } })
      case 'member': return app.inject({ method: 'POST', url: `${w.base}/${w.guestId}/members`, headers: w.headers, payload: { name: 'New family member' } })
      case 'invite': return app.inject({ method: 'POST', url: `${w.base}/${w.guestId}/invite-link`, headers: w.headers })
    }
  }
  async function snapshot(w: Fixture, client: Queryable = app.db!) {
    const guests = await client.query(`select id,name,phone,comment,party_id,party_position,is_placeholder,
      md5(rsvp_token::text) as token_hash from guests where wedding_id=$1 order by id`, [w.weddingId])
    const parties = await client.query(`select id,label,contact_phone,md5(invite_token::text) as token_hash
      from guest_parties where wedding_id=$1 order by id`, [w.weddingId])
    const codes = await client.query(`select md5(c.code) as code_hash,c.guest_id,c.party_id,c.expires_at,c.used_at
      from guest_invite_codes c join guest_parties p on p.id=c.party_id
      where p.wedding_id=$1 order by c.code`, [w.weddingId])
    const updates = await client.query('select id,kind,text from vendor_updates where wedding_id=$1 order by id', [w.weddingId])
    const version = await client.query('select timeline_version from weddings where id=$1', [w.weddingId])
    return { guests: guests.rows, parties: parties.rows, codes: codes.rows, updates: updates.rows, version: version.rows }
  }
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
  async function whileWaiting(w: Fixture, door: Door, change: (client: Queryable) => Promise<unknown>, withPhone = false, weddingLock = true) {
    let pending: Promise<Response> | undefined, settled = false
    try {
      await app.db!.tx(async client => {
        const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        if (weddingLock) await client.query('select id from weddings where id=$1 for update', [w.weddingId])
        await client.query('select id from guests where id=$1 for update', [w.guestId])
        await client.query('select id from guest_parties where wedding_id=$1 for update', [w.weddingId])
        await client.query('select c.code from guest_invite_codes c join guest_parties p on p.id=c.party_id where p.wedding_id=$1 for update of c', [w.weddingId])
        pending = send(w, door, withPhone).then(response => { settled = true; return response })
        await blocked(client, rows[0]!.pid, () => settled)
        await change(client)
      })
    } finally { if (pending) await pending }
    return pending!
  }
  for (const door of doors) {
    for (const change of changes) {
      it(`${door} refuses ${change.name} committed during its actual lock wait without side effects`, async () => {
        const w = await setup(), before = await snapshot(w)
        const res = await whileWaiting(w, door, client => client.query(change.sql, change.values(w)))
        expect(res.statusCode, res.body).toBe(change.status)
        expect(res.json().error.code, res.body).toBe(change.code)
        expect(await snapshot(w)).toEqual(before)
      })
    }
  }
  for (const role of ['helper', 'coordinator']) {
    for (const door of ['create', 'import'] as const) {
      it(`${door} rejects phone writes after couple becomes ${role} during its actual wait`, async () => {
        const w = await setup(), before = await snapshot(w)
        const res = await whileWaiting(w, door, client => client.query(
          'update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role]), true)
        expect(res.statusCode, res.body).toBe(403)
        expect(await snapshot(w)).toEqual(before)
      })
    }
    for (const door of ['create', 'import', 'member'] as const) {
      it(`${door} preserves allowed family writes but strips private fields after couple becomes ${role}`, async () => {
        const w = await setup()
        const res = await whileWaiting(w, door, client => client.query(
          'update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role]))
        expect(res.statusCode, res.body).toBe(201)
        const guest = door === 'import' ? res.json().created[0] : res.json()
        expect(guest.id).toBeTypeOf('string')
        for (const key of ['phone', 'comment', 'inviteUrl']) expect(guest).not.toHaveProperty(key)
        expect((await snapshot(w)).guests).toHaveLength(2)
      })
    }
    it(`invite does not grant capability issuance when couple becomes ${role} during its actual wait`, async () => {
      const w = await setup(), before = await snapshot(w)
      const res = await whileWaiting(w, 'invite', client => client.query(
        'update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role]))
      expect(res.statusCode, res.body).toBe(403)
      expect(await snapshot(w)).toEqual(before)
    })
  }
  for (const door of doors) {
    it(`${door} refuses a genuinely expired token after its wedding wait`, async () => {
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
  for (const door of ['member', 'invite'] as const) {
    for (const change of changes.filter(item => ['session revoked', 'account deleted', 'member removed', 'role denied', 'consent withdrawn', 'consent outdated'].includes(item.name))) {
      it(`${door} pins ${change.name} through its later resource wait and COMMIT`, async () => {
        const w = await setup()
        let write: Promise<Response> | undefined, revoke: Promise<unknown> | undefined
        let writeSettled = false, revokeSettled = false
        try {
          await app.db!.tx(async client => {
            const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
            await client.query('select id from guests where id=$1 for update', [w.guestId])
            write = send(w, door).then(res => { writeSettled = true; return res })
            await blocked(client, rows[0]!.pid, () => writeSettled)
            const waiters = await client.query<{ pid: number }>(`select pid from pg_stat_activity
              where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [rows[0]!.pid])
            expect(waiters.rows).toHaveLength(1)
            revoke = app.db!.query(change.sql, change.values(w)).then(res => { revokeSettled = true; return res })
            await blocked(client, waiters.rows[0]!.pid, () => revokeSettled)
            expect(writeSettled).toBe(false)
            expect(revokeSettled).toBe(false)
          })
        } finally {
          if (write) {
            const res = await write
            expect(res.statusCode, res.body).toBe(door === 'invite' ? 200 : 201)
          }
          if (revoke) await revoke
        }
        const committed = await snapshot(w)
        expect(committed.guests).toHaveLength(door === 'member' ? 2 : 1)
        expect(committed.codes).toHaveLength(door === 'invite' ? 2 : 1)
        const denied = await send(w, door)
        expect(denied.statusCode, denied.body).toBe(change.status)
        expect(await snapshot(w)).toEqual(committed)
      })
    }
    it(`${door} rechecks the actual guest identity after deletion during its lock wait`, async () => {
      const w = await setup()
      let afterDelete: Awaited<ReturnType<typeof snapshot>> | undefined
      const res = await whileWaiting(w, door, async client => {
        await client.query('delete from guests where id=$1', [w.guestId])
        afterDelete = await snapshot(w, client)
      })
      expect(res.statusCode, res.body).toBe(404)
      expect(await snapshot(w)).toEqual(afterDelete)
    })
    it(`${door} rolls back when its token expires during the later guest/party wait`, async () => {
      const w = await setup(), before = await snapshot(w)
      const expires = Math.floor(Date.now() / 1000) + 3
      w.headers.authorization = 'Bearer ' + await signAccessToken(SECRET,
        { sub: w.userId, sid: w.sessionId }, (expires - ACCESS_TTL_SECONDS) * 1000)
      const res = await whileWaiting(w, door, async () => {
        while (Date.now() < expires * 1000) await new Promise(resolve => setTimeout(resolve, 10))
      }, false, false)
      expect(res.statusCode, res.body).toBe(401)
      expect(res.json().error.code, res.body).toBe('token_expired')
      expect(await snapshot(w)).toEqual(before)
    })
  }
  for (const door of doors) {
    it(`${door} cannot publish success before the actual PostgreSQL COMMIT`, async () => {
      const w = await setup(), before = await snapshot(w), original = app.db!.tx
      let entered!: () => void, release!: () => void, completed!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      const allowed = new Promise<void>(resolve => { release = resolve })
      const done = new Promise<void>(resolve => { completed = resolve })
      let inside: Awaited<ReturnType<typeof snapshot>> | undefined, settled = false
      app.db!.tx = action => original(async client => {
        const result = await action(client)
        inside = await snapshot(w, client)
        entered(); await allowed
        return result
      }).finally(completed)
      const pending = send(w, door).then(response => { settled = true; return response })
      try {
        await ready
        expect(inside).not.toEqual(before)
        expect(await snapshot(w)).toEqual(before)
        expect(settled, 'HTTP must remain pending until PostgreSQL commits').toBe(false)
        release()
        const res = await pending
        expect(res.statusCode, res.body).toBe(door === 'invite' ? 200 : 201)
        await done
        expect(await snapshot(w)).toEqual(inside)
      } finally { release(); await done; await pending; app.db!.tx = original }
    })
    it(`${door} SQL rollback publishes no success and preserves existing people and invitation`, async () => {
      const w = await setup(), before = await snapshot(w), original = app.db!.tx
      let completed!: () => void
      const done = new Promise<void>(resolve => { completed = resolve })
      app.db!.tx = action => original(async client => {
        const result = await action(client)
        expect(await snapshot(w, client)).not.toEqual(before)
        await client.query('select 1/0')
        return result
      }).finally(completed)
      try {
        const res = await send(w, door)
        await done
        expect(res.statusCode, res.body).toBe(500)
        expect(await snapshot(w)).toEqual(before)
      } finally { await done; app.db!.tx = original }
    })
  }
})
