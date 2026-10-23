import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { isUuid } from '../src/ids.js'
import type { Queryable } from '../src/plugins/db.js'

const DATABASE = process.env.TEST_DATABASE_URL
const SECRET = 'additional-event-booking-f0-synthetic-access-secret-'.repeat(2)
const POLICY = '2026-09-02'
const ATOMIC89 = '1763870000000_deal_day_scope_atomic'
const LOCAL_DATABASE = 'tili_additional_20261021_test'
const FULL_DATABASE = 'tili_ecosystem_full_20260930_test'
const LOCAL_DATA = 'C:/Users/Bayra/AppData/Local/Temp/tili-t009-additional-20261021-pg'
const LOCAL_SYSTEM_ID = '7699152002090497236'
const YEAR = new Date().getUTCFullYear() + 1
const MAIN_DATE = `${YEAR}-06-14`, EXTRA_DATE = `${YEAR}-06-16`, SIBLING_DATE = `${YEAR}-06-17`
const EXTRA_TZ = 'Asia/Vladivostok', SIBLING_TZ = 'Asia/Novosibirsk'
type Actor = { id: string; session: string; token: string }
type Reply = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }
type Event = { id: string; date: string | null; timeZone: string | null; isMain: boolean }
type Slot = { id: string; categoryId: string; deal: { id: string; state: string } | null }
type Raw = { table: string; rows: string[] }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const headers = (actor: Actor, key?: string) => ({ authorization: `Bearer ${actor.token}`, ...(key ? { 'idempotency-key': key } : {}) })
const observed = (label: string, value: unknown) => process.stdout.write(`ADDITIONAL_BOOKING_F0_${label} ${JSON.stringify(value)}\n`)
function ok<T>(response: Reply, status: number): T {
  assert.equal(response.statusCode, status, response.body)
  return response.json<T>()
}

// No skip: a missing database is not native evidence. Root alone executes this
// suite. Synthetic identity/catalog parents are not public onboarding or consent UX.
describe('F0 public known additional catalog booking uses its own event context', () => {
  let app: FastifyInstance
  let admitted = false
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>()
  let priorAudit: { id: string; raw: string }[] = []

  const db = () => { assert(app?.db); return app.db }
  async function rows(table: string, where: string, values: readonly unknown[], client: Queryable = db()): Promise<Raw> {
    // Every table/where caller below is a static literal; user data is parameterized.
    return { table, rows: (await client.query<{ raw: string }>(
      `select row_to_json(t)::text raw from ${table} t where ${where} order by row_to_json(t)::text`, values)).rows.map(row => row.raw) }
  }
  const audit = () => db().query<{ id: string; raw: string }>('select id::text,row_to_json(t)::text raw from audit_log t order by id')
  async function ownAudit() {
    return rows('audit_log', 'actor_id=any($1::uuid[])', [[...users]])
  }
  beforeAll(async () => {
    assert(DATABASE, 'TEST_DATABASE_URL is required; do not count a skipped F0 as RED/GREEN')
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const target = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.username, 'codex_test'); assert.equal(target.port, '15432')
    assert([LOCAL_DATABASE, FULL_DATABASE].includes(target.pathname.slice(1)))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'additional-booking-f0-refresh-synthetic-'.repeat(3),
      policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const identity = (await db().query<{
      database: string; role: string; address: string; port: number; data: string; systemIdentifier: string;
      databaseOID: string; owner: string; ownerOID: string; backendPID: number; postmasterStartedAt: string
    }>(`select current_database() "database",current_user role,host(inet_server_addr()) address,inet_server_port() port,
      current_setting('data_directory') data,(select system_identifier::text from pg_control_system()) "systemIdentifier",
      d.oid::text "databaseOID",r.rolname owner,r.oid::text "ownerOID",pg_backend_pid() "backendPID",
      pg_postmaster_start_time()::text "postmasterStartedAt"
      from pg_database d join pg_roles r on r.oid=d.datdba where d.datname=current_database()`)).rows[0]
    assert(identity); assert.equal(identity.database, target.pathname.slice(1)); assert.equal(identity.role, 'codex_test')
    assert.equal(identity.owner, 'codex_test'); assert(['127.0.0.1', '::1'].includes(identity.address)); assert.equal(identity.port, 15432)
    assert(/^\d+$/.test(identity.systemIdentifier) && /^\d+$/.test(identity.databaseOID) && /^\d+$/.test(identity.ownerOID))
    assert(Number.isInteger(identity.backendPID) && identity.backendPID > 0 && identity.postmasterStartedAt.length > 0)
    assert(identity.data.length > 0)
    if (identity.database === LOCAL_DATABASE) {
      assert.equal(identity.data.replaceAll('\\', '/'), LOCAL_DATA)
      assert.equal(identity.systemIdentifier, LOCAL_SYSTEM_ID)
    }
    // Canonical full/CI has its own Root admission, not this workstation's
    // systemIdentifier. Always publish actual identity for that separate binding.
    const journal = (await db().query<{ name: string }>('select name from pgmigrations order by id')).rows.map(row => row.name)
    assert(journal.length >= 89 && journal.includes(ATOMIC89)); assert.equal(new Set(journal).size, journal.length)
    // RED admission must bind exact89 externally. A future GREEN may have a new
    // reviewed tail; do not silently hardcode 89 forever inside this public test.
    observed('IDENTITY', { identity, journal, historical89Present: true, localIdentityPinned: identity.database === LOCAL_DATABASE,
      currentTailAdmissionOwner: 'Root', production: false })
    priorAudit = (await audit()).rows
    admitted = true
  })
  afterAll(async () => {
    if (!app) return
    try {
      if (!admitted) return
      // Discover only weddings of our newly inserted actors, also covering a
      // failed response assertion after a successful public wedding creation.
      const owned = (await db().query<{ id: string }>('select id from weddings where owner_id=any($1::uuid[]) order by id', [[...users]])).rows
      for (const row of owned) weddings.add(row.id)
      const retained = await ownAudit()
      observed('FIXTURE_MANIFEST', { users: [...users], weddings: [...weddings], vendors: [...vendors],
        retainedAuditRows: retained.rows, priorAuditCount: priorAudit.length, production: false })
      // Parent deletion only. No job/global TTL cleanup, direct history/group/
      // capture/audit DELETE, state retrograde, or disabled trigger.
      await db().tx(async client => {
        for (const id of weddings) await client.query('delete from weddings where id=$1 and owner_id=any($2::uuid[])', [id, [...users]])
        for (const id of vendors) await client.query('delete from vendors where id=$1 and user_id=any($2::uuid[])', [id, [...users]])
        for (const id of users) await client.query('delete from users where id=$1', [id])
      })
      for (const [table, ids] of [['users', users], ['weddings', weddings], ['vendors', vendors]] as const) {
        expect((await db().query(`select id from ${table} where id=any($1::uuid[])`, [[...ids]])).rows).toEqual([])
      }
      for (const table of ['deals', 'slots', 'wedding_events', 'order_assignments', 'deal_day_scope_versions', 'deal_day_scope_heads']) {
        expect((await db().query(`select wedding_id from ${table} where wedding_id=any($1::uuid[])`, [[...weddings]])).rows).toEqual([])
      }
      for (const table of ['sessions', 'consents', 'idempotency_keys', 'notifications']) {
        expect((await db().query(`select user_id from ${table} where user_id=any($1::uuid[])`, [[...users]])).rows).toEqual([])
      }
      for (const table of ['vendor_busy_dates', 'legacy_day_groups']) {
        expect((await db().query(`select vendor_id from ${table} where vendor_id=any($1::uuid[])`, [[...vendors]])).rows).toEqual([])
      }
      const afterAudit = new Map((await audit()).rows.map(row => [row.id, row.raw]))
      for (const row of priorAudit) expect(afterAudit.get(row.id), 'Prior audit ID/value must survive').toBe(row.raw)
      const literalAudit = new Set(afterAudit.values())
      for (const raw of retained.rows) expect(literalAudit.has(raw), 'New own audit ID/value must remain literal after parent erasure').toBe(true)
      observed('CLEANUP', { ownParentsAbsent: true, priorAuditCount: priorAudit.length,
        priorAuditSHA256: sha(JSON.stringify(priorAudit)), retainedAuditRows: retained.rows, appClosePending: true })
    } finally { await app.close() }
  })

  async function actor(): Promise<Actor> {
    const id = randomUUID(), session = randomUUID()
    let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) inserted = (await db().query(
      "insert into users(id,phone,name) values($1,$2,'Synthetic additional-booking F0 actor') on conflict(phone) do nothing returning id",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])).rowCount === 1
    assert(inserted); users.add(id)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, session, token: await signAccessToken(SECRET, { sub: id, sid: session }) }
  }
  async function extraEvent(wedding: string, actor: Actor, name: string, date: string, timeZone: string): Promise<Event> {
    const current = await app.inject({ method: 'GET', url: `/weddings/${wedding}/events`, headers: headers(actor) })
    ok<Event[]>(current, 200)
    const etag = current.headers.etag; assert.equal(typeof etag, 'string')
    return ok<Event>(await app.inject({ method: 'POST', url: `/weddings/${wedding}/events`,
      headers: { ...headers(actor), 'if-match': etag as string }, payload: { name, kind: 'second_day', date, timeZone } }), 201)
  }
  async function additional(wedding: string, event: Event, actor: Actor, label: string) {
    const result = ok<{ id: string; categoryId: string; programEventId: string; label: string }>(
      await app.inject({ method: 'POST', url: `/weddings/${wedding}/slots/additional`, headers: headers(actor, randomUUID()),
        payload: { categoryId: 'photo', programEventId: event.id, label } }), 201)
    assert(isUuid(result.id)); assert.equal(result.programEventId, event.id); assert.equal(result.categoryId, 'photo')
    return result
  }
  async function rootRows(deal: string) {
    const out: Raw[] = []
    for (const table of ['deals']) out.push(await rows(table, 'id=$1', [deal]))
    for (const table of ['deal_orders', 'deal_events', 'payments', 'payment_installments', 'order_assignments', 'order_parts',
      'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions', 'deal_resource_commitments',
      'deal_resource_commitment_versions', 'deal_day_scope_versions', 'deal_day_scope_heads']) {
      out.push(await rows(table, 'deal_id=$1', [deal]))
    }
    return out
  }
  async function mainSnapshot(wedding: string, mainEvent: string, slot: string, deal: string) {
    return { weddingContext: (await db().query('select id,date::text date,tz,city_id from weddings where id=$1', [wedding])).rows,
      event: await rows('wedding_events', 'id=$1', [mainEvent]), slot: await rows('slots', 'id=$1', [slot]),
      root: await rootRows(deal), busy: await rows('vendor_busy_dates', 'deal_id=$1', [deal]),
      groups: await rows('legacy_day_groups', 'day_id in(select id from vendor_busy_dates where deal_id=$1)', [deal]) }
  }
  async function snapshot(wedding: string, vendor: string) {
    const out: Raw[] = []
    for (const table of ['weddings']) out.push(await rows(table, 'id=$1', [wedding]))
    for (const table of ['wedding_events', 'slots', 'deals', 'deal_orders', 'order_assignments', 'order_parts',
      'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions', 'deal_resource_commitments',
      'deal_resource_commitment_versions', 'resource_allocations', 'deal_day_scope_versions', 'deal_day_scope_heads',
      'tasks', 'timeline_events']) out.push(await rows(table, 'wedding_id=$1', [wedding]))
    for (const table of ['vendor_busy_dates', 'legacy_day_groups']) out.push(await rows(table, 'vendor_id=$1', [vendor]))
    for (const table of ['payments', 'payment_installments', 'deal_events']) {
      out.push(await rows(table, 'deal_id in(select id from deals where wedding_id=$1)', [wedding]))
    }
    out.push(await rows('idempotency_keys', 'user_id=any($1::uuid[])', [[...users]]), await ownAudit())
    return out
  }

  it('books the exact additional photo slot on its event DATE/TZ while keeping the public main booking and other slot literal', async () => {
    const couple = await actor(), companyOwner = await actor(), vendor = randomUUID(); vendors.add(vendor)
    // Only catalog parents are direct fixtures; wedding, main booking, events,
    // additional slots and the command under test all use registered public HTTP.
    await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic F0 catalog studio',now())", [vendor, companyOwner.id])
    const city = (await db().query<{ name: string; region: string }>(
      "select name,region from cities where name='Уфа' and region='Башкортостан' and tz is not null order by id limit 1")).rows[0]
    assert(city, 'Reviewed city seed with a real timezone is required')
    const created = ok<{ id: string }>(await app.inject({ method: 'POST', url: '/weddings', headers: headers(couple),
      payload: { partnerName: 'Synthetic F0 partner', city, date: MAIN_DATE } }), 201)
    assert(isUuid(created.id)); const wedding = created.id; weddings.add(wedding)
    const eventReply = await app.inject({ method: 'GET', url: `/weddings/${wedding}/events`, headers: headers(couple) })
    const mainEvent = ok<Event[]>(eventReply, 200).find(event => event.isMain); assert(mainEvent)
    assert.equal(mainEvent.date, MAIN_DATE); assert(mainEvent.timeZone)
    const mainSlot = ok<Slot[]>(await app.inject({ method: 'GET', url: `/weddings/${wedding}/slots`, headers: headers(couple) }), 200)
      .find(slot => slot.categoryId === 'photo' && slot.deal === null)
    assert(mainSlot)
    const main = ok<Slot>(await app.inject({ method: 'POST', url: `/weddings/${wedding}/slots/${mainSlot.id}/book`,
      headers: headers(couple, randomUUID()), payload: { vendorId: vendor, price: { amount: 1357900, currency: 'RUB' } } }), 200)
    assert(main.deal); assert.equal(main.id, mainSlot.id)
    const targetEvent = await extraEvent(wedding, couple, 'Synthetic F0 eastern celebration', EXTRA_DATE, EXTRA_TZ)
    const siblingEvent = await extraEvent(wedding, couple, 'Synthetic F0 independent second day', SIBLING_DATE, SIBLING_TZ)
    const target = await additional(wedding, targetEvent, couple, 'F0 additional photography')
    const sibling = await additional(wedding, siblingEvent, couple, 'F0 independent photography')
    assert.notEqual(target.id, sibling.id); assert.notEqual(target.id, mainSlot.id)
    const before = await snapshot(wedding, vendor)
    const mainBefore = await mainSnapshot(wedding, mainEvent.id, mainSlot.id, main.deal.id)
    const siblingBefore = { slot: await rows('slots', 'id=$1', [sibling.id]), event: await rows('wedding_events', 'id=$1', [siblingEvent.id]) }
    const key = randomUUID(), context = { id: targetEvent.id, date: EXTRA_DATE, timeZone: EXTRA_TZ }
    const body = { vendorId: vendor, price: { amount: 2468000, currency: 'RUB' } }
    const url = `/weddings/${wedding}/slots/${target.id}/book`
    const response = await app.inject({ method: 'POST', url, headers: { ...headers(couple, key), 'x-program-event-context': JSON.stringify(context) }, payload: body })
    const after = await snapshot(wedding, vendor)
    const mainAfter = await mainSnapshot(wedding, mainEvent.id, mainSlot.id, main.deal.id)
    const siblingAfter = { slot: await rows('slots', 'id=$1', [sibling.id]), event: await rows('wedding_events', 'id=$1', [siblingEvent.id]) }
    // This raw witness is emitted BEFORE the expected-success assertion, so the
    // baseline pending409 is evidence, not a hidden setup/import failure.
    observed('RESULT', { request: { method: 'POST', url, body, idempotencyKey: key, eventContext: context },
      fixture: { wedding, vendor, mainEvent: mainEvent.id, mainSlot: mainSlot.id, mainDeal: main.deal.id, target, sibling },
      response: { status: response.statusCode, body: response.body }, before, after, mainBefore, mainAfter, siblingBefore, siblingAfter })
    expect(response.statusCode, response.body).toBe(200)
    const booked = response.json<Slot>()
    expect(booked.id).toBe(target.id); expect(booked.deal?.state).toBe('booked'); assert(booked.deal)
    const root = (await db().query('select id,wedding_id,slot_id,vendor_id,state,price::text price,currency from deals where id=$1', [booked.deal.id])).rows
    expect(root).toEqual([{ id: booked.deal.id, wedding_id: wedding, slot_id: target.id, vendor_id: vendor,
      state: 'booked', price: '2468000', currency: 'RUB' }])
    expect((await db().query('select deal_id,program_event_id from slots where wedding_id=$1 and id=$2', [wedding, target.id])).rows)
      .toEqual([{ deal_id: booked.deal.id, program_event_id: targetEvent.id }])
    const busy = (await db().query<{ id: string }>("select id from vendor_busy_dates where vendor_id=$1 and date=$2::date and source='deal' and deal_id=$3",
      [vendor, EXTRA_DATE, booked.deal.id])).rows
    expect(busy).toHaveLength(1)
    expect((await db().query('select id from deal_day_scope_versions where wedding_id=$1 and deal_id=$2', [wedding, booked.deal.id])).rows).toHaveLength(1)
    expect((await db().query(`select h.revision::text revision,v.revision::text version_revision,v.previous_version_id,v.origin_knowledge,v.operation,v.context_kind,v.event_id,
      v.performer_kind,v.vendor_id,v.binding_state,v.service_date::text service_date,v.time_zone,v.day_id,
      h.current_version_id=v.id exact_head,deal_day_scope_matches_current(v) matches_current
      from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
      and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id where h.wedding_id=$1 and h.deal_id=$2`,
    [wedding, booked.deal.id])).rows).toEqual([{ revision: '1', version_revision: '1', previous_version_id: null,
      origin_knowledge: 'observed_tracking', operation: 'acquire', context_kind: 'explicit_event', event_id: targetEvent.id,
      performer_kind: 'catalog', vendor_id: vendor, binding_state: 'active', service_date: EXTRA_DATE, time_zone: EXTRA_TZ,
      day_id: busy[0]!.id, exact_head: true, matches_current: true }])
    expect(mainAfter).toEqual(mainBefore); expect(siblingAfter).toEqual(siblingBefore)
    expect((await db().query('select date::text date from vendor_busy_dates where vendor_id=$1 order by date', [vendor])).rows)
      .toEqual([{ date: MAIN_DATE }, { date: EXTRA_DATE }])
  })
})
