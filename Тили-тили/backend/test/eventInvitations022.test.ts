import { randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL, SECRET = 'a'.repeat(48), POLICY = '2026-09-02'
const APPLICATION = 'event_invitation_' + randomUUID()
describe.skipIf(!DB)('022 individual additional-event invitations on real PostgreSQL', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    const target = new URL(DB!); target.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: target.href, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => app?.close())
  async function setup() {
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID(), consentId = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [userId, '+79' + randomInt(100000000, 999999999), 'Event invitation test'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    await app.db!.query(`insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code)
      values($1,$2,'Private wedding','2027-06-14','Europe/Moscow',100000000,$3)`, [weddingId, userId, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, userId])
    const headers = { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
    const base = `/weddings/${weddingId}`
    const family = await app.inject({ method: 'POST', url: base + '/guests', headers, payload: { name: 'Family first', plusOne: true } })
    expect(family.statusCode, family.body).toBe(201)
    const members = (await app.db!.query<{ id: string }>('select id from guests where party_id=$1 order by party_position', [family.json().partyId])).rows.map(g => g.id)
    const outsider = await app.inject({ method: 'POST', url: base + '/guests', headers, payload: { name: 'Other family private name' } })
    expect(outsider.statusCode, outsider.body).toBe(201)
    const main = (await app.inject({ method: 'GET', url: base + '/events', headers })).json()[0].id as string
    const events = await app.inject({ method: 'GET', url: base + '/events', headers })
    const extra = await app.inject({ method: 'POST', url: base + '/events', headers: { ...headers, 'if-match': String(events.headers.etag) }, payload: { name: 'Second day', kind: 'second_day' } })
    expect(extra.statusCode, extra.body).toBe(201)
    const eventId = extra.json().id as string
    const guestToken = (await app.db!.query<{ invite_token: string }>('select invite_token from guest_parties where id=$1', [family.json().partyId])).rows[0]!.invite_token
    return { userId, sessionId, weddingId, consentId, headers, base, main, eventId, members, guestToken,
      partyId: family.json().partyId as string, outsiderId: outsider.json().id as string, url: `${base}/events/${eventId}/invitations` }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>
  const read = (w: Fixture) => app.inject({ method: 'GET', url: w.url, headers: w.headers })
  async function replace(w: Fixture, guestIds: string[], version?: string) {
    return app.inject({ method: 'PUT', url: w.url, headers: { ...w.headers, 'if-match': version ?? String((await read(w)).headers.etag) }, payload: { guestIds } })
  }
  const page = (w: Fixture) => app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(w.guestToken)}` })
  const records = async (w: Fixture) => (await app.db!.query('select wedding_id,event_id,guest_id from guest_event_invitations where wedding_id=$1 order by guest_id', [w.weddingId])).rows
  it('starts additional events empty and exposes no uninvited event, preserving main family response', async () => {
    const w = await setup(), res = await read(w)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers.etag).toMatch(/^"\d+"$/)
    expect(res.json().people).toHaveLength(3)
    expect(res.json().people.every((p: { invited: boolean }) => !p.invited)).toBe(true)
    expect((await page(w)).json().events.map((e: { id: string }) => e.id)).toEqual([w.main])
    expect((await page(w)).json().members.map((g: { status: string }) => g.status)).toEqual(['pending', 'pending'])
  })
  it('selects separate people and reveals only own invited family subset and unknown metadata', async () => {
    const w = await setup(), before = await read(w)
    const res = await replace(w, [w.members[1]!, w.outsiderId], String(before.headers.etag))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers.etag).not.toBe(before.headers.etag)
    const publicPage = await page(w)
    expect(publicPage.statusCode, publicPage.body).toBe(200)
    expect(publicPage.json().events.find((e: { id: string }) => e.id === w.eventId)).toEqual({
      id: w.eventId, name: 'Second day', kind: 'second_day', date: null, timeZone: null, location: null, isMain: false, guestIds: [w.members[1]],
    })
    expect(publicPage.body).not.toContain(w.outsiderId)
    expect(publicPage.body).not.toContain('Other family private name')
    expect(publicPage.body).not.toMatch(/budget|phone|invite_token|rsvp_token|inviteUrl/)
    expect(res.body).not.toContain(w.guestToken)
  })
  it('clears only this roster and an unchanged set does not bump the version', async () => {
    const w = await setup(), first = await replace(w, [w.members[0]!])
    const unchanged = await replace(w, [w.members[0]!], String(first.headers.etag))
    expect(unchanged.statusCode, unchanged.body).toBe(200)
    expect(unchanged.headers.etag).toBe(first.headers.etag)
    const clear = await replace(w, [])
    expect(clear.statusCode, clear.body).toBe(200)
    expect(await records(w)).toEqual([])
    expect((await page(w)).json().events).toHaveLength(1)
  })
  it('stale replacement loses without partially deleting or adding people', async () => {
    const w = await setup(), old = await read(w)
    await replace(w, [w.members[0]!])
    const before = await records(w), res = await replace(w, [w.members[1]!], String(old.headers.etag))
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('timeline_conflict')
    expect(await records(w)).toEqual(before)
  })
  it('two simultaneous replacements on one version accept exactly one set', async () => {
    const w = await setup(), version = String((await read(w)).headers.etag)
    const responses = await Promise.all([replace(w, [w.members[0]!], version), replace(w, [w.members[1]!], version)])
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409])
    const winner = responses.find(r => r.statusCode === 200)!.json().people.filter((p: { invited: boolean }) => p.invited).map((p: { guestId: string }) => p.guestId)
    expect((await records(w)).map(r => r.guest_id)).toEqual(winner)
  })
  it('rejects missing version and duplicate people without mutations', async () => {
    const w = await setup()
    const missing = await app.inject({ method: 'PUT', url: w.url, headers: w.headers, payload: { guestIds: [w.members[0]] } })
    expect(missing.statusCode, missing.body).toBe(428)
    const duplicate = await replace(w, [w.members[0]!, w.members[0]!])
    expect(duplicate.statusCode, duplicate.body).toBe(422)
    expect(await records(w)).toEqual([])
  })
  it('rejects foreign/absent people atomically and does not expose foreign event', async () => {
    const w = await setup(), other = await setup()
    await replace(w, [w.members[0]!]); const before = await records(w)
    for (const id of [other.members[0]!, randomUUID()]) {
      const res = await replace(w, [w.members[1]!, id])
      expect(res.statusCode, res.body).toBe(404); expect(await records(w)).toEqual(before)
    }
    w.url = `${w.base}/events/${other.eventId}/invitations`
    expect((await read(w)).statusCode).toBe(404)
    expect((await replace(w, [], '"0"')).statusCode).toBe(409)
    expect((await replace(w, [], String((await app.inject({ method: 'GET', url: w.base + '/events', headers: w.headers })).headers.etag))).statusCode).toBe(404)
  })
  it('main roster reads all real people but replacement is forbidden', async () => {
    const w = await setup(); w.url = `${w.base}/events/${w.main}/invitations`
    const res = await read(w)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().people.every((p: { invited: boolean }) => p.invited)).toBe(true)
    expect((await replace(w, [])).statusCode).toBe(422)
  })
  it('legacy RSVP and new family members do not implicitly accept/invite extra events', async () => {
    const w = await setup(); await replace(w, [w.members[0]!])
    const before = await records(w)
    const res = await app.inject({ method: 'POST', url: `/rsvp/${w.guestToken}`, payload: { members: [
      { guestId: w.members[0], status: 'yes' }, { guestId: w.members[1], status: 'no' },
    ] } })
    expect(res.statusCode, res.body).toBe(200); expect(await records(w)).toEqual(before)
    const third = await app.inject({ method: 'POST', url: `${w.base}/guests/${w.members[0]}/members`, headers: w.headers, payload: { name: 'Third' } })
    expect(third.statusCode, third.body).toBe(201)
    const publicPage = (await page(w)).json()
    expect(publicPage.members.map((p: { status: string }) => p.status)).toEqual(['yes', 'no', 'pending'])
    expect(publicPage.events.find((e: { id: string }) => e.id === w.eventId).guestIds).toEqual([w.members[0]])
    expect(publicPage.events.find((e: { id: string }) => e.id === w.main).guestIds).toHaveLength(3)
  })
  it('populated event deletion is refused, person deletion removes only own invitation', async () => {
    const w = await setup(); await replace(w, [w.members[0]!, w.members[1]!])
    const del = await app.inject({ method: 'DELETE', url: `${w.base}/events/${w.eventId}`, headers: { ...w.headers, 'if-match': String((await read(w)).headers.etag) } })
    expect(del.statusCode, del.body).toBe(409); expect(del.json().error.code).toBe('event_in_use')
    expect(await records(w)).toHaveLength(2)
    const before = (await read(w)).headers.etag
    const person = await app.inject({ method: 'DELETE', url: `${w.base}/guests/${w.members[1]}`, headers: w.headers })
    expect(person.statusCode, person.body).toBe(204)
    expect((await records(w)).map(r => r.guest_id)).toEqual([w.members[0]])
    expect((await read(w)).headers.etag).not.toBe(before)
  })
  it('database rejects cross-wedding assignments and main rows, rollback refuses populated roster', async () => {
    const w = await setup(), other = await setup()
    await expect(app.db!.query('insert into guest_event_invitations values($1,$2,$3)', [w.weddingId, w.eventId, other.members[0]])).rejects.toMatchObject({ code: '23503' })
    await expect(app.db!.query('insert into guest_event_invitations values($1,$2,$3)', [w.weddingId, other.eventId, w.members[0]])).rejects.toMatchObject({ code: '23503' })
    await expect(app.db!.query('insert into guest_event_invitations values($1,$2,$3)', [w.weddingId, w.main, w.members[0]])).rejects.toMatchObject({ code: '23514' })
    await replace(w, [w.members[0]!]); const before = await records(w)
    const migration = createRequire(import.meta.url)('../migrations/1762500000000_event_invitations.cjs') as { down: (pgm: { sql: (sql: string) => void }) => void }
    let sql = ''; migration.down({ sql: value => { sql = value } })
    await expect(app.db!.tx(client => client.query(sql))).rejects.toThrow('Refusing rollback with individual event invitations')
    expect(await records(w)).toEqual(before)
  })
  for (const role of ['helper', 'coordinator', 'vendor']) {
    it(`${role} cannot read or replace private roster`, async () => {
      const w = await setup(); await app.db!.query('update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.userId, role])
      expect((await read(w)).statusCode).toBe(403)
      expect((await replace(w, [], '"1"')).statusCode).toBe(403)
      expect(await records(w)).toEqual([])
    })
  }
  async function waiting(client: Queryable, blocker: number, done: () => boolean) {
    const until = Date.now() + 12000
    while (Date.now() < until) {
      await client.query('select pg_stat_clear_snapshot()')
      const r = await client.query(`select pid from pg_stat_activity where datname=current_database()
        and application_name=$2 and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [blocker, APPLICATION])
      if (r.rowCount) return
      if (done()) throw new Error('HTTP settled before actual SQL lock wait')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Actual SQL waiter not observed')
  }
  const revocations = [
    { name: 'member deletion', code: 404, sql: 'delete from wedding_members where wedding_id=$1', args: (w: Fixture) => [w.weddingId] },
    { name: 'helper downgrade', code: 403, sql: "update wedding_members set role='helper' where wedding_id=$1", args: (w: Fixture) => [w.weddingId] },
    { name: 'session revocation', code: 401, sql: 'update sessions set revoked_at=now() where id=$1', args: (w: Fixture) => [w.sessionId] },
    { name: 'consent withdrawal', code: 403, sql: 'update consents set withdrawn_at=now() where id=$1', args: (w: Fixture) => [w.consentId] },
    { name: 'archive', code: 404, sql: 'update weddings set archived_at=now() where id=$1', args: (w: Fixture) => [w.weddingId] },
  ]
  it('read refuses JWT expiry during a later actual roster-table wait', async () => {
    const w = await setup(), expires = Math.floor(Date.now() / 1000) + 3
    w.headers.authorization = 'Bearer ' + await signAccessToken(SECRET, { sub: w.userId, sid: w.sessionId }, (expires - ACCESS_TTL_SECONDS) * 1000)
    let pending: ReturnType<typeof app.inject> | undefined, done = false
    try {
      await app.db!.tx(async client => {
        const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
        await client.query('lock table guest_event_invitations in access exclusive mode')
        pending = read(w); void pending.then(() => { done = true })
        await waiting(client, pid, () => done)
        while (Date.now() < expires * 1000) await new Promise(resolve => setTimeout(resolve, 10))
      })
    } finally { if (pending) await pending }
    const res = await pending!; expect(res.statusCode, res.body).toBe(401)
    expect(res.json().error.code).toBe('token_expired')
  })
  for (const method of ['GET', 'PUT'] as const) for (const change of revocations) {
    it(`${method} refuses ${change.name} committed during wedding-lock wait`, async () => {
      const w = await setup(), version = String((await read(w)).headers.etag)
      let pending: ReturnType<typeof app.inject> | undefined, done = false
      try {
        await app.db!.tx(async client => {
          const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
          await client.query('select id from weddings where id=$1 for update', [w.weddingId])
          pending = app.inject({ method, url: w.url, headers: { ...w.headers, 'if-match': version }, ...(method === 'PUT' ? { payload: { guestIds: [w.members[0]] } } : {}) })
          void pending.then(() => { done = true })
          await waiting(client, pid, () => done)
          await client.query(change.sql, change.args(w))
        })
      } finally { if (pending) await pending }
      expect(pending).toBeDefined(); const res = await pending!
      expect(res.statusCode, res.body).toBe(change.code); expect(await records(w)).toEqual([])
    })
  }
  for (const state of ['token rotation', 'token reassignment', 'archive', 'cancel']) {
    it(`guest projection refuses ${state} committed after initial token check`, async () => {
      const w = await setup(), other = state === 'token reassignment' ? await setup() : null
      let pending: ReturnType<typeof app.inject> | undefined, done = false
      try {
        await app.db!.tx(async client => {
          const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
          await client.query('select id from weddings where id=$1 for update', [w.weddingId])
          pending = page(w); void pending.then(() => { done = true })
          await waiting(client, pid, () => done)
          if (state === 'token rotation' || state === 'token reassignment') {
            await client.query('update guest_parties set invite_token=$2 where id=$1', [w.partyId, randomUUID()])
            if (other) await client.query('update guest_parties set invite_token=$2 where id=$1', [other.partyId, w.guestToken])
          }
          else await client.query(`update weddings set ${state === 'archive' ? 'archived_at' : 'cancelled_at'}=now() where id=$1`, [w.weddingId])
        })
      } finally { if (pending) await pending }
      const res = await pending!; expect(res.statusCode, res.body).toBe(401)
      expect(res.body).not.toContain('Second day')
    })
  }
})
