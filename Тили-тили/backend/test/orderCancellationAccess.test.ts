import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart } from '../src/orders/model.js'
import type { Queryable } from '../src/plugins/db.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'test-cancellation-access-key'.repeat(3)
const POLICY = '2026-09-02'
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`
const DOORS = ['slot_cancel', 'deal_patch', 'external_delete', 'wedding_cancel'] as const
const CHANGES = ['member_removed', 'role_changed', 'session_revoked', 'consent_withdrawn', 'user_deleted', 'wedding_archived', 'wedding_cancelled'] as const
type Door = typeof DOORS[number]
type Change = typeof CHANGES[number]

describe.skipIf(!DB)('cancellation principal and saved replies use current authority after real PG waiting', () => {
  let app: FastifyInstance
  const weddings: string[] = [], users: string[] = []
  const witnesses: { door: string; change: string; holderPid: number; waitingPid: number; lockKind: string }[] = []
  const phonePrefix = String(randomInt(100_000, 999_999)); let seq = 0
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'test-refresh-cancellation-key'.repeat(3), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => {
    try {
      // Evidence includes both real PIDs, not merely a timer or intercepted SQL.
      process.stdout.write(`CANCELLATION_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app?.close() }
  })
  async function actor() {
    const userId = randomUUID(), sessionId = randomUUID(); users.push(userId)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Cancellation test person')", [userId, `+79${phonePrefix}${String(++seq).padStart(3, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    return { userId, sessionId, policyVersion: POLICY, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor, key = randomUUID()) => ({ ...auth(a), 'idempotency-key': key })
  async function fixture() {
    const owner = await actor(), vendorOwner = await actor(), weddingId = randomUUID(), slotId = randomUUID(), catalogSlotId = randomUUID(), vendorId = randomUUID()
    weddings.push(weddingId)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Cancellation access',$3,'Europe/Moscow',$4)", [weddingId, owner.userId, DATE, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Cancellation studio',now())", [vendorId, vendorOwner.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label,sort) values($1,$3,'photo','Private external',1),($2,$3,'photo','Catalog reference',2)", [slotId, catalogSlotId, weddingId])
    const external = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${slotId}/external`, headers: auth(owner),
      payload: { vendorName: 'Private photographer', phone: '+79990000001', price: { amount: 18000, currency: 'RUB' } } })
    expect(external.statusCode, external.body).toBe(200)
    const dealId = external.json().deal.id as string
    const booked = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${catalogSlotId}/book`, headers: idem(owner),
      payload: { vendorId, price: { amount: 22000, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200)
    const catalogDealId = booked.json().deal.id as string
    for (const position of [slotId, catalogSlotId]) {
      const paid = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${position}/pay`, headers: idem(owner),
        payload: { amount: { amount: 3000, currency: 'RUB' } } })
      expect(paid.statusCode, paid.body).toBe(200)
    }
    const mainId = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    for (const [rootId, position] of [[dealId, slotId], [catalogDealId, catalogSlotId]] as const) {
      const assigned = await app.db!.tx(c => createOrderAssignment(c, { weddingId, dealId: rootId, actor: owner, expectedVersion: '1', slotId: position, programEventId: mainId, label: 'Private draft assignment' }))
      await app.db!.tx(c => createOrderPart(c, { weddingId, dealId: rootId, actor: owner, expectedVersion: assigned.version,
        assignmentId: assigned.assignments[0]!.id, kind: 'timed_service', title: 'Unaccepted draft scope', details: {} }))
    }
    for (let n = 0; n < 2; n++) {
      const invited = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${slotId}/external/invite`, headers: auth(owner) })
      expect(invited.statusCode, invited.body).toBe(201)
    }
    return { owner, vendorOwner, weddingId, slotId, dealId, catalogSlotId, catalogDealId, vendorId }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function invoke(w: Fixture, door: Door, key = randomUUID(), caller = w.owner) {
    if (door === 'slot_cancel') return app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${w.slotId}/cancel`, headers: idem(caller, key) }).then(r => r)
    if (door === 'deal_patch') return app.inject({ method: 'PATCH', url: `/deals/${w.dealId}`, headers: idem(caller, key), payload: { state: 'cancelled' } }).then(r => r)
    if (door === 'external_delete') return app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/slots/${w.slotId}/external`, headers: auth(caller) }).then(r => r)
    return app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(caller) }).then(r => r)
  }
  async function state(w: Fixture) {
    const db = app.db!
    const result = await Promise.all([
      db.query('select id,state,price::text,currency,booked_at,cancelled_at,cancel_reason,current_program_invite_id from deals where wedding_id=$1 order by id', [w.weddingId]),
      db.query('select p.id,p.deal_id,p.kind,p.amount::text,p.status,p.created_at from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1 order by p.id', [w.weddingId]),
      db.query('select id,deal_id from slots where wedding_id=$1 order by id', [w.weddingId]),
      db.query('select deal_id,version::text,source,brief,modified_at from deal_orders where wedding_id=$1 order by deal_id', [w.weddingId]),
      db.query('select id,deal_id,version::text,cancelled_at from order_assignments where wedding_id=$1 order by id', [w.weddingId]),
      db.query('select id,deal_id,version::text,cancelled_at,details from order_parts where wedding_id=$1 order by id', [w.weddingId]),
      db.query('select program_identity,revoked_at from external_invites where wedding_id=$1 order by program_identity', [w.weddingId]),
      db.query('select vendor_id,date::text,source,deal_id from vendor_busy_dates where vendor_id=$1 order by date', [w.vendorId]),
      db.query('select id,deal_id,from_state,to_state,actor_id,note,kind from deal_events where deal_id=any($1::uuid[]) order by id', [[w.dealId, w.catalogDealId]]),
      db.query('select actor_id,action,entity,entity_id,diff from audit_log where entity_id=any($1::uuid[]) order by at,id', [[w.weddingId, w.dealId, w.catalogDealId, w.slotId, w.catalogSlotId]]),
      db.query('select cancel_requested_by,cancel_requested_at from weddings where id=$1', [w.weddingId]),
    ])
    const [deals, payments, slots, orders, assignments, parts, invites, busy, events, audit, wedding] = result.map(r => r.rows)
    return { deals, payments, slots, orders, assignments, parts, invites, busy, events, audit, wedding }
  }
  async function mutate(c: Queryable, w: Fixture, change: Change) {
    if (change === 'member_removed') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.owner.userId])
    if (change === 'role_changed') await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [w.weddingId, w.owner.userId])
    if (change === 'session_revoked') await c.query('update sessions set revoked_at=clock_timestamp() where id=$1', [w.owner.sessionId])
    if (change === 'consent_withdrawn') await c.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1', [w.owner.userId])
    if (change === 'user_deleted') await c.query('update users set deleted_at=clock_timestamp() where id=$1', [w.owner.userId])
    if (change === 'wedding_archived') await c.query('update weddings set archived_at=clock_timestamp() where id=$1', [w.weddingId])
    if (change === 'wedding_cancelled') await c.query('update weddings set cancelled_at=clock_timestamp() where id=$1', [w.weddingId])
  }
  function refusal(response: Awaited<ReturnType<typeof invoke>>, change: Change) {
    const status = change === 'session_revoked' || change === 'user_deleted' ? 401 :
      change === 'role_changed' || change === 'consent_withdrawn' ? 403 : 404
    expect(response.statusCode, response.body).toBe(status)
    expect(response.headers['idempotent-replay']).toBeUndefined()
    expect(Object.keys(response.json())).toEqual(['error'])
    expect(response.body).not.toContain('Private photographer')
    expect(response.body).not.toContain('Unaccepted draft scope')
  }
  async function whileWeddingLocked(w: Fixture, door: Door, change: Change, request: () => ReturnType<typeof invoke>, cached = false) {
    const db = app.db!
    let start!: () => void, release!: () => void, holderPid = 0
    const ready = new Promise<void>(r => { start = r }), go = new Promise<void>(r => { release = r })
    const holder = db.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query('select id from weddings where id=$1 for update', [w.weddingId])
      start(); await go
      await mutate(c, w, change)
    })
    await ready
    let done = false
    const response = request().then(r => { done = true; return r })
    let witness: { pid: number; wait_event: string; query: string } | undefined
    try {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !done) {
        const observed = await db.query<{ pid: number; wait_event: string; query: string }>(`select pid,wait_event,query from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))
            and query ilike '%weddings%'`, [holderPid])
        witness = observed.rows[0]
        if (witness) break
        await new Promise(r => setTimeout(r, 10))
      }
      expect(witness, `No actual wedding-lock wait: ${cached ? 'cached ' : ''}${door}/${change}, replyFinished=${done}`).toBeDefined()
      witnesses.push({ door: cached ? `cached_${door}` : door, change, holderPid, waitingPid: witness!.pid, lockKind: witness!.wait_event })
    } finally {
      release(); await holder
      // A failed lock witness must not leave an unobserved HTTP request behind.
      await response
    }
    return await response
  }

  const races = DOORS.flatMap(door => CHANGES.map(change => ({ door, change })))
  it.each(races)('$door refuses $change after a witnessed wedding lock and preserves finance, drafts and invitations', async ({ door, change }) => {
    const w = await fixture(), before = await state(w)
    refusal(await whileWeddingLocked(w, door, change, () => invoke(w, door)), change)
    expect(await state(w)).toEqual(before)
  })

  const replayCases = (['slot_cancel', 'deal_patch'] as const).flatMap(door => CHANGES.map(change => ({ door, change })))
  it.each(replayCases)('cached $door reply refuses $change after a witnessed wedding lock without disclosing saved data', async ({ door, change }) => {
    const w = await fixture(), key = randomUUID(), original = await invoke(w, door, key)
    expect(original.statusCode, original.body).toBe(200)
    const before = await state(w)
    refusal(await whileWeddingLocked(w, door, change, () => invoke(w, door, key), true), change)
    expect(await state(w)).toEqual(before)
    const cache = await app.db!.query<{ status: number; body: unknown }>('select status,body from idempotency_keys where key=$1', [`${w.owner.userId}:${door === 'slot_cancel' ? 'slots.cancel' : 'deals.patch'}:${key}`])
    expect(cache.rows[0]).toEqual({ status: 200, body: original.json() })
  })

  it.each(DOORS.map(door => ({ door })))('$door with a valid current principal cancels the intended roots and preserves actual payment rows', async ({ door }) => {
    const w = await fixture(), before = await state(w), response = await invoke(w, door)
    expect(response.statusCode, response.body).toBe(door === 'external_delete' ? 204 : 200)
    const after = await state(w)
    expect(after.payments).toEqual(before.payments)
    const affected = door === 'wedding_cancel' ? [w.dealId, w.catalogDealId] : [w.dealId]
    for (const deal of after.deals) expect(deal.state).toBe(affected.includes(deal.id as string) ? 'cancelled' : 'paid_deposit')
    for (const assignment of after.assignments) {
      expect(assignment.cancelled_at !== null).toBe(affected.includes(assignment.deal_id as string))
      expect(assignment.version).toBe(affected.includes(assignment.deal_id as string) ? '2' : '1')
    }
    for (const part of after.parts) {
      expect(part.cancelled_at !== null).toBe(affected.includes(part.deal_id as string))
      expect(part.version).toBe(affected.includes(part.deal_id as string) ? '2' : '1')
    }
    for (const root of after.orders) expect(root.version).toBe(affected.includes(root.deal_id as string) ? '4' : '3')
    expect(after.invites).toHaveLength(2); expect(after.invites.every(i => i.revoked_at !== null)).toBe(true)
    expect(after.busy).toEqual(door === 'wedding_cancel' ? [] : before.busy)
    expect(after.deals.map(d => ({ id: d.id, price: d.price, currency: d.currency }))).toEqual(before.deals.map(d => ({ id: d.id, price: d.price, currency: d.currency })))
  })

  it.each((['slot_cancel', 'deal_patch'] as const).map(door => ({ door })))('valid saved $door reply recovers a lost response without repeating cancellation or its audit', async ({ door }) => {
    const w = await fixture(), key = randomUUID(), original = await invoke(w, door, key)
    expect(original.statusCode, original.body).toBe(200)
    const before = await state(w), recovered = await invoke(w, door, key)
    expect(recovered.statusCode, recovered.body).toBe(200)
    expect(recovered.headers['idempotent-replay']).toBe('true')
    expect(recovered.json()).toEqual(original.json()); expect(await state(w)).toEqual(before)
  })

  it('completed external DELETE revokes its old links before the expected 409 and retains money, root and draft history', async () => {
    const w = await fixture()
    const done = await app.inject({ method: 'PATCH', url: `/deals/${w.dealId}`, headers: idem(w.owner), payload: { state: 'done' } })
    expect(done.statusCode, done.body).toBe(200)
    const before = await state(w), response = await invoke(w, 'external_delete')
    expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('bad_transition')
    const after = await state(w)
    expect(after.invites.every(i => i.revoked_at !== null)).toBe(true)
    expect({ ...after, invites: [] }).toEqual({ ...before, invites: [] })
    expect(after.deals.find(d => d.id === w.dealId)?.state).toBe('done')
  })

  it.each(CHANGES)('stored done external root still refuses %s before revoking invitations when access changed during PG waiting', async change => {
    const w = await fixture()
    const marked = await app.inject({ method: 'PATCH', url: `/deals/${w.dealId}`, headers: idem(w.owner), payload: { state: 'done' } })
    expect(marked.statusCode, marked.body).toBe(200)
    const before = await state(w)
    refusal(await whileWeddingLocked(w, 'external_delete', change, () => invoke(w, 'external_delete')), change)
    expect(await state(w)).toEqual(before)
  })

  it.each(DOORS.map(door => ({ door })))('$door atomically rolls back every cancellation effect if the draft audit cannot persist', async ({ door }) => {
    const w = await fixture(), before = await state(w), db = app.db!, original = db.tx
    db.tx = action => original(c => action({ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (sql.includes("'order.draft_scope_cancelled'")) return Promise.reject(new Error('Controlled cancellation audit failure'))
      return c.query<T>(sql, values)
    } }))
    try { expect((await invoke(w, door)).statusCode).toBe(500) } finally { db.tx = original }
    expect(await state(w)).toEqual(before)
  })
})
