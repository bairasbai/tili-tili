import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48), POLICY = '2026-09-02'
const APPLICATION = 'guest_reminder_' + randomUUID()

describe.skipIf(!DB)('guest reminders: current claim access and committed bookkeeping without real SMS', () => {
  let app: FastifyInstance, sender: FastifyInstance['sms']['send']
  let calls = 0
  beforeAll(async () => {
    const target = new URL(DB!)
    target.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: target.href, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY, smsProvider: null })
    await app.ready()
    sender = app.sms.send
    app.sms.send = async () => { calls++ }
  })
  afterAll(async () => { if (app) { app.sms.send = sender; await app.close() } })
  async function setup() {
    calls = 0
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID(), consentId = randomUUID()
    const phone = '+79' + randomInt(100000000, 999999999)
    await app.db!.query('insert into users(id,phone) values($1,$2)', [userId, phone])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    await app.db!.query(`insert into weddings(id,owner_id,title,date,tz,invite_code)
      values($1,$2,'Reminder access test','2027-06-14','Europe/Moscow',$3)`, [weddingId, userId, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, userId])
    const headers = { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
    const base = `/weddings/${weddingId}/guests`
    const guest = await app.inject({ method: 'POST', url: base, headers, payload: { name: 'Reminder recipient', phone } })
    expect(guest.statusCode, guest.body).toBe(201)
    const guestId = guest.json().id as string
    const invite = await app.inject({ method: 'POST', url: `${base}/${guestId}/invite-link`, headers })
    expect(invite.statusCode, invite.body).toBe(200)
    return { userId, sessionId, weddingId, consentId, guestId, headers, base }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>
  type Response = Awaited<ReturnType<FastifyInstance['inject']>>
  const send = (w: Fixture) => app.inject({ method: 'POST', url: w.base + '/remind', headers: w.headers })
  async function mark(w: Fixture, client: Queryable = app.db!) {
    const res = await client.query<{ stamp: string | null }>('select guests_reminded_at::text as stamp from weddings where id=$1', [w.weddingId])
    return res.rows[0]!.stamp
  }
  async function blocked(client: Queryable, pid: number, settled: () => boolean) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      await client.query('select pg_stat_clear_snapshot()')
      const waiters = await client.query(`select pid from pg_stat_activity
        where datname=current_database() and application_name=$2 and wait_event_type='Lock'
          and $1=any(pg_blocking_pids(pid))`, [pid, APPLICATION])
      if (waiters.rowCount! > 0) return
      if (settled()) throw new Error('Reminder settled without actual PostgreSQL wait')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Reminder did not enter an actual PostgreSQL wait')
  }
  async function whileWaiting(w: Fixture, change: (client: Queryable) => Promise<unknown>, late = false) {
    let pending: Promise<Response> | undefined, settled = false
    try {
      await app.db!.tx(async client => {
        const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        if (late) await client.query('lock table guests in access exclusive mode')
        else await client.query('select id from weddings where id=$1 for update', [w.weddingId])
        pending = send(w).then(res => { settled = true; return res })
        await blocked(client, rows[0]!.pid, () => settled)
        await change(client)
      })
    } finally { if (pending) await pending }
    return pending!
  }
  const changes = [
    { name: 'removed member', status: 404, sql: 'delete from wedding_members where wedding_id=$1 and user_id=$2', values: (w: Fixture) => [w.weddingId, w.userId] },
    { name: 'helper role', status: 403, sql: "update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", values: (w: Fixture) => [w.weddingId, w.userId] },
    { name: 'revoked session', status: 401, sql: 'update sessions set revoked_at=now() where id=$1', values: (w: Fixture) => [w.sessionId] },
    { name: 'deleted account', status: 401, sql: 'update users set deleted_at=now() where id=$1', values: (w: Fixture) => [w.userId] },
    { name: 'withdrawn consent', status: 403, sql: 'update consents set withdrawn_at=now() where id=$1', values: (w: Fixture) => [w.consentId] },
    { name: 'outdated consent', status: 403, sql: "update consents set policy_version='2020-01-01' where id=$1", values: (w: Fixture) => [w.consentId] },
    { name: 'archived wedding', status: 404, sql: 'update weddings set archived_at=now() where id=$1', values: (w: Fixture) => [w.weddingId] },
    { name: 'cancelled wedding', status: 404, sql: 'update weddings set cancelled_at=now() where id=$1', values: (w: Fixture) => [w.weddingId] },
  ]
  for (const change of changes) {
    it(`does not claim or dispatch after ${change.name} committed during its actual wait`, async () => {
      const w = await setup()
      const res = await whileWaiting(w, client => client.query(change.sql, change.values(w)))
      expect(res.statusCode, res.body).toBe(change.status)
      expect(calls).toBe(0)
      expect(await mark(w)).toBeNull()
    })
  }
  for (const late of [false, true]) {
    it(`does not claim or dispatch when JWT expires during the ${late ? 'recipient' : 'wedding'} wait`, async () => {
      const w = await setup(), expires = Math.floor(Date.now() / 1000) + 3
      w.headers.authorization = 'Bearer ' + await signAccessToken(SECRET,
        { sub: w.userId, sid: w.sessionId }, (expires - ACCESS_TTL_SECONDS) * 1000)
      const res = await whileWaiting(w, async () => {
        while (Date.now() < expires * 1000) await new Promise(resolve => setTimeout(resolve, 10))
      }, late)
      expect(res.statusCode, res.body).toBe(401)
      expect(res.json().error.code).toBe('token_expired')
      expect(calls).toBe(0)
      expect(await mark(w)).toBeNull()
    })
  }
  it('dispatches only after the actual claim COMMIT, with the committed mark visible to the sender', async () => {
    const w = await setup(), original = app.db!.tx
    let entered = false, ready!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { ready = resolve })
    const allowed = new Promise<void>(resolve => { release = resolve })
    app.db!.tx = action => original(async client => {
      const result = await action(client)
      entered = true; ready(); await allowed
      return result
    })
    const ordinary = app.sms.send
    let visible: string | null = null
    app.sms.send = async () => { calls++; visible = await mark(w) }
    const pending = send(w)
    try {
      expect(await Promise.race([reached.then(() => true), pending.then(() => false)])).toBe(true)
      expect(calls).toBe(0)
      expect(await mark(w)).toBeNull()
      release()
      const res = await pending
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().sent).toBe(1)
      expect(visible).not.toBeNull()
    } finally { if (entered) release(); await pending; app.db!.tx = original; app.sms.send = ordinary }
  })
  it('actual recipient SQL failure leaves no committed mark and never calls the sender', async () => {
    const w = await setup(), original = app.db!.tx, query = app.db!.query
    const fails = (sql: string) => sql.includes('from guests g') && sql.includes('c.expires_at > now()')
    app.db!.query = (sql, values) => query(fails(sql) ? 'select 1/0' : sql, fails(sql) ? undefined : values)
    app.db!.tx = action => original(client => action({
      query: (sql, values) => client.query(fails(sql) ? 'select 1/0' : sql, fails(sql) ? undefined : values),
    }))
    try {
      const res = await send(w)
      expect(res.statusCode, res.body).toBe(500)
      expect(calls).toBe(0)
      expect(await mark(w)).toBeNull()
    } finally { app.db!.tx = original; app.db!.query = query }
  })
  it('no eligible phone releases its own claim without consuming the daily allowance', async () => {
    const w = await setup()
    await app.db!.query('update guests set phone=null where id=$1', [w.guestId])
    const res = await send(w)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ sent: 0, skippedNoPhone: 1, skippedLinkUsed: 0, failed: 0 })
    expect(calls).toBe(0)
    expect(await mark(w)).toBeNull()
  })
  it('two concurrent valid claims still send only once and return one daily-limit refusal', async () => {
    const w = await setup(), results = await Promise.all([send(w), send(w)])
    expect(results.map(res => res.statusCode).sort()).toEqual([200, 429])
    expect(calls).toBe(1)
    expect(await mark(w)).not.toBeNull()
  })
  it('a delayed failed old dispatch cannot clear a newer successful claim', async () => {
    const w = await setup(), ordinary = app.sms.send
    let ready!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { ready = resolve })
    const allowed = new Promise<void>(resolve => { release = resolve })
    app.sms.send = async () => {
      calls++
      if (calls === 1) { ready(); await allowed; throw new Error('controlled first-dispatch failure') }
    }
    const first = send(w)
    try {
      await reached
      expect(await mark(w)).not.toBeNull()
      // Model an eligible later claim while the old sender is still pending.
      await app.db!.query("update weddings set guests_reminded_at=now()-interval '25 hours' where id=$1", [w.weddingId])
      const second = await send(w), newer = await mark(w)
      expect(second.statusCode, second.body).toBe(200)
      expect(second.json().sent).toBe(1)
      expect(newer).not.toBeNull()
      release()
      const old = await first
      expect(old.statusCode, old.body).toBe(200)
      expect(old.json()).toMatchObject({ sent: 0, failed: 1 })
      expect(await mark(w)).toBe(newer)
    } finally { release(); await first; app.sms.send = ordinary }
  })
})
