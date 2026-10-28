import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import type { Db, Queryable } from '../src/plugins/db.js'
import { runNativeCalendarHttpPrefixRace, type NativeCalendarHttpIdentity, type NativeCalendarWaitRow } from './helpers/nativeCalendarPrefixRace.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { bookVendor, lockBookingContext } from '../src/deals/book.js'
import { createAdditionalSlot, createOrderAssignment, cancelOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart, cancelOrderPart, loadOrder } from '../src/orders/model.js'
import type { OrderActor } from '../src/orders/context.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'order-legacy-integration-access-secret'.repeat(2)
const POLICY = '2026-09-02'
const YEAR = new Date().getUTCFullYear() + 1
const DATE = `${YEAR}-06-14`

describe.skipIf(!DB)('structured draft integration with real legacy HTTP booking', () => {
  let app: FastifyInstance
  const weddings: string[] = [], users: string[] = [], resources: string[] = []
  const phonePrefix = String(randomInt(100_000, 999_999))
  let seq = 0
  beforeAll(async () => {
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_t009_legacy_20261016_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'test-refresh-secret'.repeat(4), policyVersion: POLICY })
    await app.ready()
    const identity = (await app.db!.query<{ db: string; role: string; address: string; port: number; data: string; systemid: string; pid: number }>(
      `select current_database() db,current_user role,host(inet_server_addr()) address,inet_server_port() port,
        current_setting('data_directory') data,(select system_identifier::text from pg_control_system()) systemid,pg_backend_pid() pid`)).rows[0]!
    assert.equal(identity.db, target.pathname.slice(1)); assert.equal(identity.role, 'codex_test')
    assert(['127.0.0.1', '::1'].includes(identity.address)); assert.equal(identity.port, Number(disposablePgPort()))
    assert(identity.data.length > 0 && /^\d+$/.test(identity.systemid))
    process.stdout.write(`ORDER_LEGACY_NATIVE_IDENTITY ${JSON.stringify(identity)}\n`)
  })
  afterAll(async () => {
    try {
      process.stdout.write(`ORDER_LEGACY_FIXTURE_MANIFEST ${JSON.stringify({ weddings, users, resources })}\n`)
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of resources) await app.db!.query('delete from vendor_resources where id=$1', [id])
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

  // The only synthetic writes are the existing actor/wedding/vendor fixtures.
  // Resource, policy, event/position and candidate/state changes use public routes.
  async function prepareThenDowngrade(w: Wedding, additional: boolean, explicitMain = false) {
    const resource = await app.inject({ method: 'POST', url: `/vendors/${w.performer.vendorId}/resources`,
      headers: idem(w.performer), payload: { kind: 'equipment', label: 'T009 boundary equipment' } })
    expect(resource.statusCode, resource.body).toBe(200)
    resources.push(resource.json().id as string)
    const policy = await app.inject({ method: 'PATCH', url: `/vendors/${w.performer.vendorId}/availability-policy`,
      headers: idem(w.performer), payload: { mode: 'resources', expectedRevision: '0' } })
    expect(policy.statusCode, policy.body).toBe(200); expect(policy.json()).toMatchObject({ mode: 'resources', revision: '1' })
    const eventId = additional ? await secondary(w) : w.mainId
    let slotId = w.slotId
    if (additional || explicitMain) {
      const position = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/additional`,
        headers: idem(w.owner), payload: { categoryId: 'photo', programEventId: eventId,
          label: additional ? 'T009 non-main position' : 'T009 explicit main position' } })
      expect(position.statusCode, position.body).toBe(201)
      slotId = position.json().id as string
      expect(position.json()).toMatchObject({ categoryId: 'photo', programEventId: eventId })
    }
    const prepared = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/resource-order`,
      headers: idem(w.owner), payload: { vendorId: w.performer.vendorId, packageId: null,
        expectedSelectedDealId: null, expectedPolicyRevision: policy.json().revision } })
    expect(prepared.statusCode, prepared.body).toBe(200); expect(prepared.json()).toMatchObject({ state: 'candidate', created: true, orderVersion: '1' })
    const dealId = prepared.json().dealId as string
    const downgraded = await app.inject({ method: 'PATCH', url: `/vendors/${w.performer.vendorId}/availability-policy`,
      headers: idem(w.performer), payload: { mode: 'legacy_day', expectedRevision: policy.json().revision } })
    expect(downgraded.statusCode, downgraded.body).toBe(200); expect(downgraded.json()).toMatchObject({ mode: 'legacy_day', revision: '2' })
    expect((await app.db!.query('select id from resource_allocations where vendor_id=$1', [w.performer.vendorId])).rows).toEqual([])
    expect((await app.db!.query('select state,price::text from deals where id=$1', [dealId])).rows).toEqual([{ state: 'candidate', price: null }])
    return { dealId, slotId, eventId }
  }
  const patchState = (w: Wedding, dealId: string, state: 'contacted' | 'negotiating' | 'booked' | 'paid_deposit' | 'done', key = randomUUID(), price?: number) =>
    app.inject({ method: 'PATCH', url: `/deals/${dealId}`, headers: idem(w.owner, key),
      payload: { state, ...(price === undefined ? {} : { price: { amount: price, currency: 'RUB' } }) } })
  async function firstCommittedSnapshot(w: Wedding, dealId: string) {
    const raw = async (table: string, where: string, values: readonly unknown[]) =>
      (await app.db!.query<{ row: string }>(`select row_to_json(t)::text row from ${table} t ${where} order by row_to_json(t)::text`, values)).rows.map(r => r.row)
    const state: Record<string, string[]> = {}
    for (const table of ['deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts',
      'deal_resource_plan_versions', 'deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members',
      'resource_allocations', 'deal_events', 'payments', 'payment_installments', 'payment_corrections', 'payment_installment_edits']) {
      state[table] = await raw(table, 'where t.deal_id=$1', [dealId])
    }
    state.deals = await raw('deals', 'where t.wedding_id=$1', [w.weddingId])
    state.slots = await raw('slots', 'where t.wedding_id=$1', [w.weddingId])
    state.program = await raw('wedding_events', 'where t.wedding_id=$1', [w.weddingId])
    state.timeline = await raw('timeline_events', 'where t.wedding_id=$1', [w.weddingId])
    state.holds = await raw('vendor_busy_dates', 'where t.vendor_id=$1', [w.performer.vendorId])
    state.leads = await raw('leads', 'where t.wedding_id=$1', [w.weddingId])
    state.audit = await raw('audit_log', 'where t.actor_id=any($1::uuid[]) or t.entity_id::text=$2', [[w.owner.userId, w.performer.userId], dealId])
    state.idempotency = await raw('idempotency_keys', 'where t.user_id=any($1::uuid[])', [[w.owner.userId, w.performer.userId]])
    return state
  }
  const firstCommittedCases = (['candidate', 'contacted', 'negotiating'] as const).flatMap(from =>
    (['booked', 'paid_deposit', 'done'] as const).map(to => ({ from, to })))
  it.each(firstCommittedCases)(
    'T009 first-COMMITTED requires event context for non-main $from to $to after public resource preparation and policy downgrade', async ({ from, to }) => {
      const w = await fixture(), prepared = await prepareThenDowngrade(w, true)
      if (from !== 'candidate') {
        const advanced = await patchState(w, prepared.dealId, from)
        expect(advanced.statusCode, advanced.body).toBe(200)
      }
      expect((await app.db!.query('select state from deals where id=$1', [prepared.dealId])).rows).toEqual([{ state: from }])
      const before = await firstCommittedSnapshot(w, prepared.dealId), key = randomUUID()
      expect(before.holds).toEqual([]); expect(before.resource_allocations).toEqual([])
      const response = await patchState(w, prepared.dealId, to, key)
      const after = await firstCommittedSnapshot(w, prepared.dealId)
      const attemptedReceipt = (await app.db!.query('select status,body from idempotency_keys where key=$1',
        [`${w.owner.userId}:deals.patch:${key}`])).rows
      // Preserve the actual answer AND native before/after even while this RED fails.
      process.stdout.write(`T009_FIRST_COMMITTED_RED_OBSERVATION ${JSON.stringify({ from, to, ...prepared,
        mainDate: DATE, observedDeals: after.deals!.map(row => JSON.parse(row) as unknown),
        observedHolds: after.holds!.map(row => JSON.parse(row) as unknown),
        response: { status: response.statusCode, body: response.json() }, before, after, attemptedReceipt })}\n`)
      error(response, 'event_context_required', 428)
      expect(after).toEqual(before); expect(attemptedReceipt).toEqual([])
    })
  it('T009 first-COMMITTED without event context rejects combined price and state without writes and permits identical same-key refusal retry', async () => {
    const w = await fixture(), prepared = await prepareThenDowngrade(w, true), key = randomUUID()
    const before = await firstCommittedSnapshot(w, prepared.dealId)
    expect(JSON.parse(before.deals![0]!) as { price: unknown }).toMatchObject({ price: null })
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await patchState(w, prepared.dealId, 'booked', key, 12345)
      const after = await firstCommittedSnapshot(w, prepared.dealId)
      const attemptedReceipt = (await app.db!.query('select status,body from idempotency_keys where key=$1',
        [`${w.owner.userId}:deals.patch:${key}`])).rows
      process.stdout.write(`T009_FIRST_COMMITTED_PRICE_RETRY_OBSERVATION ${JSON.stringify({ attempt, ...prepared,
        command: { state: 'booked', price: { amount: 12345, currency: 'RUB' } },
        response: { status: response.statusCode, body: response.json(), replay: response.headers['idempotent-replay'] ?? null },
        before, after, attemptedReceipt })}\n`)
      error(response, 'event_context_required', 428)
      expect(response.headers['idempotent-replay']).toBeUndefined()
      expect(after).toEqual(before); expect(attemptedReceipt).toEqual([])
    }
  })
  it.each(['legacy_NULL', 'explicit_main'] as const)(
    'T009 first-COMMITTED keeps %s main with its selected structured root and own draft assignment bookable', async mapping => {
    const w = await fixture(), prepared = await prepareThenDowngrade(w, false, mapping === 'explicit_main'), key = randomUUID()
    const assigned = await app.inject({ method: 'POST', url: `/deals/${prepared.dealId}/order/assignments`, headers: idem(w.owner),
      payload: { expectedVersion: '1', slotId: prepared.slotId, programEventId: w.mainId, label: 'Own main structured duty' } })
    expect(assigned.statusCode, assigned.body).toBe(200)
    expect(assigned.json()).toMatchObject({ dealId: prepared.dealId, source: 'structured', version: '2',
      assignments: [{ slotId: prepared.slotId, programEventId: w.mainId, source: 'structured', cancelledAt: null }] })
    const before = await firstCommittedSnapshot(w, prepared.dealId)
    expect(before.order_assignments).toHaveLength(1)
    const response = await patchState(w, prepared.dealId, 'booked', key)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ id: prepared.dealId, state: 'booked' })
    expect((await app.db!.query('select deal_id,program_event_id from slots where id=$1', [prepared.slotId])).rows)
      .toEqual([{ deal_id: prepared.dealId, program_event_id: mapping === 'explicit_main' ? w.mainId : null }])
    expect((await app.db!.query('select id,state,price::text from deals where wedding_id=$1', [w.weddingId])).rows)
      .toEqual([{ id: prepared.dealId, state: 'booked', price: null }])
    expect((await app.db!.query('select deal_id,date::text from vendor_busy_dates where vendor_id=$1', [w.performer.vendorId])).rows)
      .toEqual([{ deal_id: prepared.dealId, date: DATE }])
    const after = await firstCommittedSnapshot(w, prepared.dealId)
    for (const table of ['deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts', 'payments', 'program']) {
      expect(after[table], table).toEqual(before[table])
    }
    expect((await app.db!.query('select status from idempotency_keys where key=$1', [`${w.owner.userId}:deals.patch:${key}`])).rows).toEqual([{ status: 200 }])
  })

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

  it('a non-main empty position without event context blocks book/external/request/accept and never holds the main date', async () => {
    const w = await fixture(), position = await extra(w), pending = await offer(w, position.id), eventId = await secondary(w)
    // Historical request issued before this position was moved to another event.
    await app.db!.query('update slots set program_event_id=$2 where id=$1', [position.id, eventId])
    for (const response of [await book(w, position.id), await external(w, position.id), await requestOffer(w, position.id, pending.entryId), await accept(w, pending.offerId)]) {
      error(response, 'event_context_required', 428)
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

  async function observeIntegrationPrefix(c: Queryable, holder: NativeCalendarHttpIdentity,
    workers: readonly NativeCalendarHttpIdentity[]): Promise<NativeCalendarWaitRow[]> {
    return (await c.query<NativeCalendarWaitRow>(
      'select w.pid,w.backend_start::text backend_start,w.xact_start::text xact_start,w.datname,w.usename,w.state,'
      + 'w.wait_event_type,w.query,pg_blocking_pids(w.pid) blockers,b.pid holder_pid,'
      + 'b.backend_start::text holder_backend_start,b.xact_start::text holder_xact_start,'
      + 'b.datname holder_datname,b.usename holder_usename,b.state holder_state,clock_timestamp()::text observed_at '
      + 'from pg_stat_activity w join pg_stat_activity b on b.pid=$2 '
      + 'where w.datname=current_database() and w.pid=any($1::integer[]) order by w.pid',
      [workers.map(worker => worker.pid), holder.pid])).rows
  }
  async function integrationIdentity(c: Queryable): Promise<NativeCalendarHttpIdentity> {
    const rows = (await c.query<NativeCalendarHttpIdentity>('select pg_backend_pid() pid,current_database() database,current_user principal,txid_current()::text txid,'
      + 'a.backend_start::text backend_start,a.xact_start::text xact_start from pg_stat_activity a where a.pid=pg_backend_pid()')).rows
    assert.equal(rows.length, 1); const row = rows[0]!
    assert(Number.isSafeInteger(row.pid) && row.pid > 0 && row.backend_start && row.xact_start && /^[0-9]+$/.test(row.txid)); return row
  }
  async function integrationUntil<T>(p: Promise<T>, deadline: number): Promise<T> {
    const left = deadline - performance.now(); assert(left > 0, 'Integration native wait deadline')
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([p, new Promise<never>((_yes, no) => {
      timer = setTimeout(() => no(new Error('Integration native wait deadline')), left)
    })]) } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  async function integrationFrame(c: Queryable = app.db!): Promise<Record<string, string[]>> {
    const names = (await c.query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.name)
    assert.equal(names.length, 124)
    const frame: Record<string, string[]> = {}
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/)
      frame[name] = (await c.query<{ row: string }>('select row_to_json(t)::text row from "' + name + '" t order by row_to_json(t)::text')).rows.map(row => row.row)
    }
    return frame
  }

  const revocationCases = (['catalog', 'external', 'offer_accept', 'offer_request'] as const).flatMap(door =>
    (['member_removed', 'role_changed', 'session_revoked', 'consent_withdrawn'] as const).map(revoke => ({ door, revoke })))
  it.each(revocationCases)('real $door rechecks $revoke after waiting for wedding lock', async ({ door, revoke }) => {
    const w = await fixture(), pending = await offer(w, w.slotId), db = app.db!
    const result = await runNativeCalendarHttpPrefixRace(db,
      { weddingId: w.weddingId, caseName: door + '/' + revoke + '/slot:' + w.slotId },
      async c => {
        await prepareLegacyCalendarScope(c, { weddingIds: [w.weddingId], vendorIds: [w.performer.vendorId], actor: w.owner })
        const target = revoke === 'session_revoked' ? await c.query('select id from sessions where id=$1 for update', [w.owner.sessionId])
          : revoke === 'consent_withdrawn' ? await c.query('select user_id from consents where user_id=$1 for update', [w.owner.userId])
          : await c.query('select user_id from wedding_members where wedding_id=$1 and user_id=$2 for update', [w.weddingId, w.owner.userId])
        expect(target.rows).toHaveLength(1)
      }, async c => {
        if (revoke === 'member_removed') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.owner.userId])
        if (revoke === 'role_changed') await c.query("update wedding_members set role='coordinator' where wedding_id=$1 and user_id=$2", [w.weddingId, w.owner.userId])
        if (revoke === 'session_revoked') await c.query('update sessions set revoked_at=now() where id=$1', [w.owner.sessionId])
        if (revoke === 'consent_withdrawn') await c.query('update consents set withdrawn_at=now() where user_id=$1', [w.owner.userId])
      }, [{ label: door + '/' + revoke, start: () => door === 'catalog' ? book(w) : door === 'external' ? external(w, w.slotId) :
        door === 'offer_accept' ? accept(w, pending.offerId) : requestOffer(w, w.slotId, pending.entryId) }], observeIntegrationPrefix)
    expect(result.mutationCommitted).toBe(true); expect(result.replies).toHaveLength(1)
    error(result.replies[0]!, revoke === 'member_removed' ? 'not_found' : revoke === 'session_revoked' ? 'unauthorized' : 'forbidden',
      revoke === 'member_removed' ? 404 : revoke === 'session_revoked' ? 401 : 403)
    expect((await db.query('select count(*)::int n from deals where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe(0)
    expect((await db.query('select accepted_at from offers where id=$1', [pending.offerId])).rows[0]?.accepted_at).toBeNull()
  })

  it('assignment committed while real HTTP booking waits wins the same-position race', async () => {
    const w = await fixture(), dealId = await root(w), position = await extra(w), db = app.db!
    const result = await runNativeCalendarHttpPrefixRace(db,
      { weddingId: w.weddingId, dealId, caseName: 'assignment before booking' }, async c => {
        await prepareLegacyCalendarScope(c, { weddingIds: [w.weddingId], vendorIds: [w.performer.vendorId], actor: w.owner })
        expect((await c.query('select id from slots where wedding_id=$1 and id=$2 for update', [w.weddingId, position.id])).rows).toEqual([{ id: position.id }])
        expect((await c.query('select deal_id from deal_orders where wedding_id=$1 and deal_id=$2 for update', [w.weddingId, dealId])).rows).toEqual([{ deal_id: dealId }])
      }, c => createOrderAssignment(c, { ...input(w, dealId), slotId: position.id, programEventId: w.mainId, label: 'Winning draft' }),
      [{ label: 'booking behind actual assignment writer', start: () => book(w, position.id) }], observeIntegrationPrefix)
    expect(result.mutationCommitted).toBe(true); expect(result.replies).toHaveLength(1)
    error(result.replies[0]!, 'slot_assigned')
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
    const w = await fixture(), dealId = await root(w), position = await extra(w), db = app.db!
    type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
    const reflect = <T>(p: Promise<T>): Promise<Outcome<T>> => p.then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    let published!: (value: NativeCalendarHttpIdentity) => void, workerReady!: (value: NativeCalendarHttpIdentity) => void, release!: () => void
    const entered = new Promise<NativeCalendarHttpIdentity>(yes => { published = yes })
    const captured = new Promise<NativeCalendarHttpIdentity>(yes => { workerReady = yes })
    const go = new Promise<void>(yes => { release = yes })
    const original = db.tx, invoke: Db['tx'] = original.bind(db)
    let publication = false, workerCaptures = 0, winnerFrame: Record<string, string[]> | undefined
    const delegate: Db['tx'] = <T>(action: (c: Queryable) => Promise<T>): Promise<T> => invoke(async c => {
      const current = await integrationIdentity(c); let winner = false
      if (publication) { workerCaptures++; assert.equal(workerCaptures, 1); workerReady(current) }
      const value = await action({ async query<Q extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
        const result = await c.query<Q>(sql, values)
        if (/^\s*update\s+slots\s+set\s+deal_id\s*=\s*\$2,\s*prebooked_at\s*=\s*null\b/i.test(sql) && values?.[0] === position.id) {
          expect(result.rowCount).toBe(1); assert(!publication)
          publication = true; winner = true; published(current)
          process.stdout.write('INTEGRATION_ACTUAL_SLOT_PUBLICATION ' + JSON.stringify({ weddingId: w.weddingId, slotId: position.id, booker: current, rowCount: result.rowCount }) + '\n')
          await go // real completed publication SQL, original query result is forwarded unchanged
        }
        return result
      } })
      if (winner) winnerFrame = await integrationFrame(c) // after the unchanged callback/receipt, before actual COMMIT
      return value
    })
    let contender: Promise<Outcome<Awaited<ReturnType<typeof assign>>>> | undefined
    let contenderEnded: Outcome<Awaited<ReturnType<typeof assign>>> | undefined
    let observer: Promise<Outcome<unknown>> | undefined, failure: { error: unknown } | undefined, stopping = false
    let publishedDeal: string | undefined
    db.tx = delegate
    const booking = reflect(Promise.resolve().then(() => book(w, position.id)))
    try {
      const holder = await integrationUntil(Promise.race([entered, booking.then(result => {
        if (!result.ok) throw result.error
        throw new Error('Booking ended before its real slot publication')
      })]), performance.now() + 5000)
      const deadline = performance.now() + 5000
      contender = reflect(assign(w, dealId, position.id)).then(result => { contenderEnded = result; return result })
      const worker = await integrationUntil(Promise.race([captured, contender.then(result => {
        if (!result.ok) throw result.error
        throw new Error('Competing assignment ended before its actual transaction capture')
      })]), deadline)
      assert.notEqual(worker.pid, holder.pid)
      observer = reflect(invoke(async c => {
        await c.query("set local statement_timeout='1000ms'")
        const observedBy = await integrationIdentity(c); assert(![holder.pid, worker.pid].includes(observedBy.pid))
        while (!stopping && performance.now() < deadline) {
          if (contenderEnded) { if (!contenderEnded.ok) throw contenderEnded.error; throw new Error('Assignment ended before native wait') }
          await c.query('select pg_stat_clear_snapshot()')
          const rows = await observeIntegrationPrefix(c, holder, [worker])
          assert.equal(rows.length, 1); const row = rows[0]!
          assert.equal(row.pid, worker.pid); assert.equal(row.backend_start, worker.backend_start); assert.equal(row.xact_start, worker.xact_start)
          assert.equal(row.datname, worker.database); assert.equal(row.usename, worker.principal)
          assert.equal(row.holder_pid, holder.pid); assert.equal(row.holder_backend_start, holder.backend_start); assert.equal(row.holder_xact_start, holder.xact_start)
          assert.equal(row.holder_datname, holder.database); assert.equal(row.holder_usename, holder.principal)
          assert.equal(worker.database, holder.database); assert.equal(worker.principal, holder.principal)
          assert.equal(observedBy.database, holder.database); assert.equal(observedBy.principal, holder.principal)
          if (row.state === 'active' && row.wait_event_type === 'Lock' && row.holder_state === 'idle in transaction'
            && row.blockers.length === 1 && row.blockers[0] === holder.pid
            && row.query.trim().replace(/\s+/g, ' ') === 'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope') {
            assert(!stopping && performance.now() < deadline)
            process.stdout.write('INTEGRATION_PUBLICATION_NATIVE_PREFIX_WAIT ' + JSON.stringify({ weddingId: w.weddingId, slotId: position.id,
              holder, worker, observedBy, activity: row, path: [worker.pid, holder.pid] }) + '\n'); return
          }
          await new Promise<void>(yes => setTimeout(yes, Math.min(25, Math.max(1, deadline - performance.now()))))
        }
        throw new Error('No actual assignment prefix wait behind the known published booking')
      }))
      const observed = await integrationUntil(observer, deadline); if (!observed.ok) throw observed.error
      release()
      const won = await booking; if (!won.ok) throw won.error
      expect(won.value.statusCode, won.value.body).toBe(200)
      publishedDeal = won.value.json<{ deal: { id: string } }>().deal.id
      const lost = await contender
      assert(!lost.ok); expect(lost.error).toMatchObject({ statusCode: 409, code: 'calendar_scope_changed' })
    } catch (error) { failure = { error } } finally {
      stopping = true; release()
      const secondary: unknown[] = []
      const booked = await booking
      if (!booked.ok && (!failure || booked.error !== failure.error)) secondary.push(booked.error)
      if (contender) {
        const result = await contender
        if (failure && !result.ok && result.error !== failure.error) secondary.push(result.error)
      }
      if (observer) {
        const result = await observer
        if (!result.ok && (!failure || result.error !== failure.error)) secondary.push(result.error)
      }
      if (db.tx !== delegate) secondary.push(new Error('Owned publication observer method changed'))
      db.tx = original
      if (secondary.length) failure = { error: new AggregateError(failure ? [failure.error, ...secondary] : secondary,
        'Publication race or cleanup failed', failure ? { cause: failure.error } : undefined) }
    }
    if (failure) throw failure.error
    assert(winnerFrame && publishedDeal); expect(workerCaptures).toBe(1)
    assert(isDeepStrictEqual(await integrationFrame(), winnerFrame), 'Common409 assignment changed public rows after the genuine booking COMMIT')
    const oldFinancial = await firstCommittedSnapshot(w, dealId), newFinancial = await firstCommittedSnapshot(w, publishedDeal)
    await expect(assign(w, dealId, position.id)).rejects.toMatchObject({ statusCode: 409, code: 'slot_taken' })
    assert(isDeepStrictEqual(await integrationFrame(), winnerFrame), 'Fresh slot_taken refusal changed public rows')
    expect(await firstCommittedSnapshot(w, dealId)).toEqual(oldFinancial)
    expect(await firstCommittedSnapshot(w, publishedDeal)).toEqual(newFinancial)
    expect((await order(w, dealId)).assignments).toHaveLength(0)
    expect((await app.db!.query("select count(*)::int n from deals where slot_id=$1 and state<>'cancelled'", [position.id])).rows[0]?.n).toBe(1)
  })
})
