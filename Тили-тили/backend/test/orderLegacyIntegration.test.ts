import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { bookVendor, lockBookingContext } from '../src/deals/book.js'
import { createAdditionalSlot, createOrderAssignment, cancelOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart, cancelOrderPart, loadOrder } from '../src/orders/model.js'
import type { OrderActor } from '../src/orders/context.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'order-legacy-integration-access-secret'.repeat(2)
const POLICY = '2026-09-02'
const YEAR = new Date().getUTCFullYear() + 1
const DATE = `${YEAR}-06-14`

describe.skipIf(!DB)('structured draft integration with real legacy HTTP booking', () => {
  let app: FastifyInstance
  const weddings: string[] = [], users: string[] = []
  const phonePrefix = String(randomInt(100_000, 999_999))
  let seq = 0
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'test-refresh-secret'.repeat(4), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => {
    try {
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app?.close() }
  })
  async function actor() {
    const userId = randomUUID(), sessionId = randomUUID(); users.push(userId)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Integration person')", [userId, `+79${phonePrefix}${String(++seq).padStart(3, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    const principal: OrderActor = { userId, sessionId, policyVersion: POLICY }
    return { ...principal, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor, key = randomUUID()) => ({ ...auth(a), 'idempotency-key': key })
  async function vendor() {
    const owner = await actor(), vendorId = randomUUID()
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Integration studio',now())", [vendorId, owner.userId])
    return { ...owner, vendorId }
  }
  async function fixture() {
    const owner = await actor(), performer = await vendor(), weddingId = randomUUID(), slotId = randomUUID(); weddings.push(weddingId)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Integration',$3,'Europe/Moscow',$4)", [weddingId, owner.userId, DATE, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, owner.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Primary photo')", [slotId, weddingId])
    const mainId = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    return { owner, performer, weddingId, slotId, mainId }
  }
  type Wedding = Awaited<ReturnType<typeof fixture>>
  const book = (w: Wedding, slotId = w.slotId, key = randomUUID()) => app.inject({ method: 'POST',
    url: `/weddings/${w.weddingId}/slots/${slotId}/book`, headers: idem(w.owner, key),
    payload: { vendorId: w.performer.vendorId, price: { amount: 15000, currency: 'RUB' } } })
  const external = (w: Wedding, slotId: string) => app.inject({ method: 'POST',
    url: `/weddings/${w.weddingId}/slots/${slotId}/external`, headers: auth(w.owner),
    payload: { vendorName: 'Outside photographer', price: { amount: 16000, currency: 'RUB' } } })
  const cancel = (w: Wedding, key = randomUUID()) => app.inject({ method: 'POST',
    url: `/weddings/${w.weddingId}/slots/${w.slotId}/cancel`, headers: idem(w.owner, key) })
  async function root(w: Wedding) {
    const response = await book(w)
    expect(response.statusCode, response.body).toBe(200)
    return response.json().deal.id as string
  }
  const input = (w: Wedding, dealId: string, expectedVersion = '1') => ({ weddingId: w.weddingId, dealId, actor: w.owner, expectedVersion })
  const extra = (w: Wedding, eventId = w.mainId) => app.db!.tx(c => createAdditionalSlot(c, {
    weddingId: w.weddingId, actor: w.owner, categoryId: 'photo', programEventId: eventId, label: 'Extra photo' }))
  const assign = (w: Wedding, dealId: string, slotId: string, expectedVersion = '1', eventId = w.mainId) => app.db!.tx(c => createOrderAssignment(c, {
    ...input(w, dealId, expectedVersion), slotId, programEventId: eventId, label: 'Draft coverage' }))
  async function secondary(w: Wedding) {
    const before = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/events`, headers: auth(w.owner) })
    const response = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/events`,
      headers: { ...auth(w.owner), 'if-match': before.headers.etag! },
      payload: { name: 'Second day', kind: 'second_day', date: `${YEAR}-06-15`, timeZone: 'Asia/Yekaterinburg' } })
    expect(response.statusCode, response.body).toBe(201)
    return response.json().id as string
  }
  async function shortlist(w: Wedding, slotId: string) {
    const id = randomUUID()
    await app.db!.query('insert into slot_shortlist(id,slot_id,vendor_id,position,added_by) values($1,$2,$3,1,$4)', [id, slotId, w.performer.vendorId, w.owner.userId])
    return id
  }
  const requestOffer = (w: Wedding, slotId: string, entryId: string, key = randomUUID()) => app.inject({ method: 'POST',
    url: `/weddings/${w.weddingId}/slots/${slotId}/offer-requests`, headers: idem(w.owner, key), payload: { entryIds: [entryId] } })
  async function answer(w: Wedding, requestId: string) {
    const response = await app.inject({ method: 'POST', url: `/vendor/offer-requests/${requestId}/offers`, headers: idem(w.performer),
      payload: { kind: 'offer', title: 'Actual offer terms', price: { amount: 17000, currency: 'RUB' }, includes: ['Photography'], validUntil: `${YEAR}-06-13` } })
    expect(response.statusCode, response.body).toBe(201)
    return response.json().id as string
  }
  async function offer(w: Wedding, slotId: string) {
    const entryId = await shortlist(w, slotId), response = await requestOffer(w, slotId, entryId)
    expect(response.statusCode, response.body).toBe(201)
    const requestId = response.json().results[0].requestId as string
    return { offerId: await answer(w, requestId), requestId, entryId }
  }
  const accept = (w: Wedding, offerId: string, key = randomUUID()) => app.inject({ method: 'POST',
    url: `/weddings/${w.weddingId}/offers/${offerId}/accept`, headers: idem(w.owner, key) })
  const error = (response: { statusCode: number; body: string; json(): { error: { code: string } } }, code: string, status = 409) => {
    expect(response.statusCode, response.body).toBe(status); expect(response.json().error.code).toBe(code)
  }
  const order = (w: Wedding, dealId: string) => app.db!.tx(c => loadOrder(c, input(w, dealId)))

  it('all legacy booking doors reject an assigned extra position without a second financial root or accepted offer', async () => {
    const w = await fixture(), dealId = await root(w), position = await extra(w), pending = await offer(w, position.id)
    await assign(w, dealId, position.id)
    for (const response of await Promise.all([book(w, position.id), external(w, position.id), accept(w, pending.offerId)])) error(response, 'slot_assigned')
    error(await requestOffer(w, position.id, pending.entryId), 'slot_assigned')
    expect((await app.db!.query('select deal_id from slots where id=$1', [position.id])).rows[0]?.deal_id).toBeNull()
    expect((await app.db!.query('select count(*)::int n,sum(price)::text total from deals where wedding_id=$1', [w.weddingId])).rows[0]).toEqual({ n: 1, total: '15000' })
    expect((await app.db!.query('select accepted_at,deal_id from offers where id=$1', [pending.offerId])).rows[0]).toEqual({ accepted_at: null, deal_id: null })
    expect((await app.db!.query('select status from offer_requests where id=$1', [pending.requestId])).rows[0]?.status).toBe('open')
  })

  it('a non-main empty position explicitly blocks book/external/request/accept and never holds the main date', async () => {
    const w = await fixture(), position = await extra(w), pending = await offer(w, position.id), eventId = await secondary(w)
    // Historical request issued before this position was moved to another event.
    await app.db!.query('update slots set program_event_id=$2 where id=$1', [position.id, eventId])
    for (const response of [await book(w, position.id), await external(w, position.id), await requestOffer(w, position.id, pending.entryId), await accept(w, pending.offerId)]) {
      error(response, 'additional_event_booking_pending')
    }
    expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe(0)
    expect((await app.db!.query('select count(*)::int n from vendor_busy_dates where vendor_id=$1', [w.performer.vendorId])).rows[0]?.n).toBe(0)
    expect((await app.db!.query('select accepted_at from offers where id=$1', [pending.offerId])).rows[0]?.accepted_at).toBeNull()
  })

  it.each(['catalog', 'external', 'offer'] as const)('keeps old main empty-slot %s booking and its actual main-date hold', async door => {
    const w = await fixture()
    const response = door === 'catalog' ? await book(w) : door === 'external' ? await external(w, w.slotId) : await accept(w, (await offer(w, w.slotId)).offerId)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().tileState).toBe('booked')
    expect((await app.db!.query('select source from deal_orders where deal_id=$1', [response.json().deal.id])).rows[0]?.source).toBe('legacy')
    const busy = await app.db!.query('select date::text from vendor_busy_dates where vendor_id=$1', [w.performer.vendorId])
    expect(busy.rows).toEqual(door === 'external' ? [] : [{ date: DATE }])
  })

  it('canonical explicit main position remains bookable and response-loss replay creates one root', async () => {
    const w = await fixture(), position = await extra(w), key = randomUUID()
    const first = await book(w, position.id, key)
    expect(first.statusCode, first.body).toBe(200)
    // Client discards the first reply and retries the identical command/key.
    const recovered = await book(w, position.id, key)
    expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json()).toEqual(first.json())
    expect(recovered.headers['idempotent-replay']).toBe('true')
    error(await book(w, position.id), 'slot_taken')
    expect((await app.db!.query('select count(*)::int n from deals where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe(1)
  })

  it('canonical main context cannot diverge; offer snapshots use the actual updated main date and zone', async () => {
    const w = await fixture(), position = await extra(w), entry = await shortlist(w, position.id)
    await expect(app.db!.query("update wedding_events set time_zone='Asia/Yekaterinburg' where id=$1", [w.mainId])).rejects.toMatchObject({ code: '23514' })
    const snapshot = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/events`, headers: auth(w.owner) })
    const moved = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/events/${w.mainId}`,
      headers: { ...auth(w.owner), 'if-match': snapshot.headers.etag! }, payload: { date: `${YEAR}-06-16`, timeZone: 'Asia/Yekaterinburg' } })
    expect(moved.statusCode, moved.body).toBe(200)
    const requested = await requestOffer(w, position.id, entry)
    expect(requested.statusCode, requested.body).toBe(201)
    const requestId = requested.json().results[0].requestId as string
    expect((await app.db!.query('select wedding_date::text from offer_requests where id=$1', [requestId])).rows[0]?.wedding_date).toBe(`${YEAR}-06-16`)
    const accepted = await accept(w, await answer(w, requestId))
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect((await app.db!.query('select date::text from vendor_busy_dates where vendor_id=$1', [w.performer.vendorId])).rows).toEqual([{ date: `${YEAR}-06-16` }])
  })

  it('root cancellation versions only active scope, preserves money/history and replay, and permits a replacement assignment', async () => {
    const w = await fixture(), dealId = await root(w), position = await extra(w)
    let current = await assign(w, dealId, w.slotId)
    current = await assign(w, dealId, position.id, current.version)
    current = await app.db!.tx(c => createOrderPart(c, { ...input(w, dealId, current.version), assignmentId: current.assignments[0]!.id, kind: 'timed_service', title: 'Coverage', details: {} }))
    current = await app.db!.tx(c => createOrderPart(c, { ...input(w, dealId, current.version), kind: 'deliverable', title: 'Album', details: {} }))
    current = await app.db!.tx(c => cancelOrderPart(c, { ...input(w, dealId, current.version), partId: current.parts[0]!.id, expectedPartVersion: '1' }))
    const paid = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${w.slotId}/pay`, headers: idem(w.owner), payload: { amount: { amount: 5000, currency: 'RUB' } } })
    expect(paid.statusCode, paid.body).toBe(200)
    const paymentsBefore = (await app.db!.query('select id,amount::text,status from payments where deal_id=$1 order by id', [dealId])).rows
    const key = randomUUID(), first = await cancel(w, key)
    expect(first.statusCode, first.body).toBe(200)
    const after = await order(w, dealId)
    expect(after.version).toBe(String(Number(current.version) + 1))
    expect(after.assignments.every(a => a.cancelledAt !== null && a.version === '2')).toBe(true)
    expect(after.parts.every(p => p.cancelledAt !== null && p.version === '2')).toBe(true)
    expect(after.parts[0]!.cancelledAt).toBe(current.parts[0]!.cancelledAt)
    expect((await app.db!.query('select state,price::text from deals where id=$1', [dealId])).rows[0]).toEqual({ state: 'cancelled', price: '15000' })
    expect((await app.db!.query('select id,amount::text,status from payments where deal_id=$1 order by id', [dealId])).rows).toEqual(paymentsBefore)
    expect((await app.db!.query('select date::text from vendor_busy_dates where vendor_id=$1', [w.performer.vendorId])).rows).toEqual([])
    const audit = await app.db!.query("select actor_id,diff from audit_log where action='order.draft_scope_cancelled' and entity_id=$1", [dealId])
    expect(audit.rows).toHaveLength(1); expect(audit.rows[0]?.actor_id).toBe(w.owner.userId)
    expect(audit.rows[0]?.diff).toMatchObject({ draftOnly: true, reason: 'deal_cancelled', beforeVersion: current.version,
      cancelledAssignmentIds: current.assignments.map(a => a.id).sort(), cancelledPartIds: [current.parts[1]!.id] })
    const recovered = await cancel(w, key)
    expect(recovered.json()).toEqual(first.json()); expect(recovered.headers['idempotent-replay']).toBe('true')
    expect((await order(w, dealId)).version).toBe(after.version)
    const replacement = await root(w)
    expect((await assign(w, replacement, w.slotId)).assignments).toHaveLength(1)
  })

  it('an actual audit failure rolls back the whole HTTP cancellation, children, payment state, and hold', async () => {
    const w = await fixture(), dealId = await root(w), current = await assign(w, dealId, w.slotId)
    const db = app.db!, original = db.tx
    db.tx = action => original(c => action({ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (sql.includes("'order.draft_scope_cancelled'")) return Promise.reject(new Error('Controlled cancellation audit failure'))
      return c.query<T>(sql, values)
    } }))
    try { error(await cancel(w), 'internal', 500) } finally { db.tx = original }
    expect(await order(w, dealId)).toEqual(current)
    expect((await app.db!.query('select state from deals where id=$1', [dealId])).rows[0]?.state).toBe('booked')
    expect((await app.db!.query('select deal_id from slots where id=$1', [w.slotId])).rows[0]?.deal_id).toBe(dealId)
    expect((await app.db!.query('select deal_id from vendor_busy_dates where vendor_id=$1', [w.performer.vendorId])).rows).toEqual([{ deal_id: dealId }])
  })

  it.each(['empty_position', 'cancelled_assignment_history'] as const)('HTTP event deletion refuses %s explicitly and preserves history', async scenario => {
    const w = await fixture(), eventId = await secondary(w)
    if (scenario === 'empty_position') await extra(w, eventId)
    if (scenario === 'cancelled_assignment_history') {
      // The legacy primary position has no event FK; history alone protects it.
      const dealId = await root(w), current = await assign(w, dealId, w.slotId, '1', eventId)
      await app.db!.tx(c => cancelOrderAssignment(c, { ...input(w, dealId, current.version), assignmentId: current.assignments[0]!.id, expectedAssignmentVersion: '1' }))
    }
    const before = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/events`, headers: auth(w.owner) })
    const response = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/events/${eventId}`,
      headers: { ...auth(w.owner), 'if-match': before.headers.etag! } })
    error(response, 'event_in_use')
    const after = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/events`, headers: auth(w.owner) })
    expect(after.headers.etag).toBe(before.headers.etag); expect(after.json()).toEqual(before.json())
  })

  it('old unused secondary-event deletion still returns 204', async () => {
    const w = await fixture(), eventId = await secondary(w)
    const before = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/events`, headers: auth(w.owner) })
    expect((await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/events/${eventId}`,
      headers: { ...auth(w.owner), 'if-match': before.headers.etag! } })).statusCode).toBe(204)
  })

  async function observeTransactions(observer: (sql: string) => void, action: () => Promise<void>) {
    const db = app.db!, original = db.tx
    db.tx = callback => original(c => callback({ query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
      const pending = c.query<T>(sql, values); observer(sql); return pending
    } }))
    try { await action() } finally { db.tx = original }
  }
  const revocationCases = (['catalog', 'external', 'offer_accept', 'offer_request'] as const).flatMap(door =>
    (['member_removed', 'role_changed', 'session_revoked', 'consent_withdrawn'] as const).map(revoke => ({ door, revoke })))
  it.each(revocationCases)('real $door rechecks $revoke after waiting for wedding lock', async ({ door, revoke }) => {
    const w = await fixture(), pending = await offer(w, w.slotId), db = app.db!
    let unlock!: () => void, reached!: () => void, locked!: () => void
    const release = new Promise<void>(r => { unlock = r }), entered = new Promise<void>(r => { reached = r }), acquired = new Promise<void>(r => { locked = r })
    const holder = db.tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [w.weddingId]); locked(); await release
      if (revoke === 'member_removed') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.owner.userId])
      if (revoke === 'role_changed') await c.query("update wedding_members set role='coordinator' where wedding_id=$1 and user_id=$2", [w.weddingId, w.owner.userId])
      if (revoke === 'session_revoked') await c.query('update sessions set revoked_at=now() where id=$1', [w.owner.sessionId])
      if (revoke === 'consent_withdrawn') await c.query('update consents set withdrawn_at=now() where user_id=$1', [w.owner.userId])
    })
    await acquired
    await observeTransactions(sql => { if (sql.includes('from weddings where id = $1 for share') || sql.includes('for update of w')) reached() }, async () => {
      const response = (door === 'catalog' ? book(w) : door === 'external' ? external(w, w.slotId) :
        door === 'offer_accept' ? accept(w, pending.offerId) : requestOffer(w, w.slotId, pending.entryId)).then(r => r)
      try {
        const reachedBeforeReply = await Promise.race([entered.then(() => true), response.then(() => false)])
        expect(reachedBeforeReply).toBe(true)
      } finally { unlock() }
      await holder
      error(await response, revoke === 'member_removed' ? 'not_found' : revoke === 'session_revoked' ? 'unauthorized' : 'forbidden', revoke === 'member_removed' ? 404 : revoke === 'session_revoked' ? 401 : 403)
    })
    expect((await db.query('select count(*)::int n from deals where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe(0)
    expect((await db.query('select accepted_at from offers where id=$1', [pending.offerId])).rows[0]?.accepted_at).toBeNull()
  })

  it('assignment committed while real HTTP booking waits wins the same-position race', async () => {
    const w = await fixture(), dealId = await root(w), position = await extra(w), db = app.db!
    let release!: () => void, locked!: () => void, reached!: () => void
    const go = new Promise<void>(r => { release = r }), acquired = new Promise<void>(r => { locked = r }), entered = new Promise<void>(r => { reached = r })
    const holder = db.tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [w.weddingId]); locked(); await go
      return createOrderAssignment(c, { ...input(w, dealId), slotId: position.id, programEventId: w.mainId, label: 'Winning draft' })
    })
    await acquired
    await observeTransactions(sql => { if (sql.includes('from weddings where id = $1 for share')) reached() }, async () => {
      const response = book(w, position.id).then(r => r)
      try { expect(await Promise.race([entered.then(() => true), response.then(() => false)])).toBe(true) } finally { release() }
      await holder; error(await response, 'slot_assigned')
    })
    expect((await order(w, dealId)).assignments).toHaveLength(1)
    expect((await db.query('select count(*)::int n from deals where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe(1)
  })

  it('defensive booking guard rejects assignment added after context acquisition in the same transaction', async () => {
    const w = await fixture(), dealId = await root(w), position = await extra(w)
    await expect(app.db!.tx(async c => {
      const context = await lockBookingContext(c, { weddingId: w.weddingId, slotId: position.id, actorId: w.owner.userId,
        sessionId: w.owner.sessionId, policyVersion: POLICY })
      await createOrderAssignment(c, { ...input(w, dealId), slotId: position.id, programEventId: w.mainId, label: 'Newly assigned' })
      return bookVendor(c, context, { performer: { kind: 'external', name: 'Would duplicate root' }, price: 17000 })
    })).rejects.toMatchObject({ code: 'slot_assigned' })
    expect((await order(w, dealId)).assignments).toHaveLength(0)
  })

  it('failed assigned-position request releases its key so explicit draft cancellation can permit the same booking retry', async () => {
    const w = await fixture(), dealId = await root(w), position = await extra(w), key = randomUUID()
    const current = await assign(w, dealId, position.id)
    error(await book(w, position.id, key), 'slot_assigned')
    await app.db!.tx(c => cancelOrderAssignment(c, { ...input(w, dealId, current.version), assignmentId: current.assignments[0]!.id, expectedAssignmentVersion: '1' }))
    const retried = await book(w, position.id, key)
    expect(retried.statusCode, retried.body).toBe(200)
    expect(retried.headers['idempotent-replay']).toBeUndefined()
    expect((await order(w, dealId)).assignments[0]?.cancelledAt).not.toBeNull()
  })

  it('cancellation without typed scope leaves the legacy order revision and financial history intact', async () => {
    const w = await fixture(), dealId = await root(w)
    expect((await cancel(w)).statusCode).toBe(200)
    expect(await order(w, dealId)).toMatchObject({ version: '1', source: 'legacy', parts: [], assignments: [] })
    expect((await app.db!.query("select id from audit_log where action='order.draft_scope_cancelled' and entity_id=$1", [dealId])).rows).toEqual([])
    expect((await app.db!.query('select count(*)::int n,price::text from deals where id=$1 group by price', [dealId])).rows[0]).toEqual({ n: 1, price: '15000' })
  })

  it('real booking committed before a competing draft assignment leaves one financial root and no contradictory assignment', async () => {
    const w = await fixture(), dealId = await root(w), position = await extra(w)
    let reached!: () => void, release!: () => void
    const entered = new Promise<void>(r => { reached = r }), go = new Promise<void>(r => { release = r })
    const db = app.db!, original = db.tx
    db.tx = action => original(c => action({ async query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
      const result = await c.query<T>(sql, values)
      if (/^\s*update\s+slots\s+set\s+deal_id\s*=\s*\$2,\s*prebooked_at\s*=\s*null\b/i.test(sql) && values?.[0]===position.id) { reached(); await go }
      return result
    } }))
    const response = book(w, position.id).then(r => r)
    try {
      expect(await Promise.race([entered.then(() => true), response.then(() => false)])).toBe(true)
      const competing = assign(w, dealId, position.id)
      const outcome = expect(competing).rejects.toMatchObject({ code: 'slot_taken' })
      release()
      expect((await response).statusCode).toBe(200)
      await outcome
    } finally { release(); db.tx = original }
    expect((await order(w, dealId)).assignments).toHaveLength(0)
    expect((await app.db!.query("select count(*)::int n from deals where slot_id=$1 and state<>'cancelled'", [position.id])).rows[0]?.n).toBe(1)
  })
})
