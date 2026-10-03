import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import type { OrderActor } from '../src/orders/context.js'
import { createOrderAssignment } from '../src/orders/assignments.js'
import { createOrderPart } from '../src/orders/model.js'
import { saveOrderResourcePlan } from '../src/orders/resource-plan.js'
import { publishOrderTerms, loadOrderTerms, acceptOrderTerms } from '../src/orders/terms.js'
import { createResource, createCapacityWindow } from '../src/resources/model.js'
import { getAvailabilityPolicy, setAvailabilityPolicy } from '../src/resources/policy.js'
import { commitAgreedOrderResources } from '../src/resources/commitments.js'
import { assertLegacyDateBookingAllowed } from '../src/resources/booking-boundary.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'
import { purgeArchivedWeddings, eraseUser } from '../src/jobs/index.js'
import { disposablePgPort } from './disposablePgPort.js'
// Under-test module (leaf 1.3.1, parallel work). Only the exported surface
// and the schema/guards from the contract are relied on below — never the
// implementation file itself.
import {
  loadLegacyCalendarInventory, captureLegacyCalendarSource, locateLegacyCalendarInventoryScope,
} from '../src/resources/legacy-source.js'
import type {
  CalendarSourceKind, LegacyInventoryView, LegacyInventorySourceDto,
} from '../src/resources/legacy-source.js'

/**
 * 370 Stage A — технический инвентарь прежнего календаря.
 *
 * Контракт: `.unlazy/tz-full-20261002/c370-contract.md`, §«Экспорт» и
 * §«Тесты Stage A» (T01–T12). Написано независимо и параллельно с
 * `src/resources/legacy-source.ts` и его миграцией (leaf 1.3.1): этот файл
 * проверяет контракт, а не их реализацию, поэтому в src ничего нового не
 * читалось, кроме уже существующих писателей/соседних модулей.
 *
 * Реальный PostgreSQL, реальные транзакции. Guard БД — inventory|full
 * (R6-1). Серийный файл: §«Тесты Stage A» и `audit53.test.ts` требуют
 * `pg_stat_activity`+`pg_blocking_pids` — путь обязан быть в
 * `vitest.serial.json`.
 */

const DATABASE = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'legacy-calendar-inventory-370-stageA-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DB_NAME_RE = /^tili_ecosystem_(inventory|full)_20260930_test$/
const COMMITTED = ['booked', 'paid_deposit', 'done'] as const
type Reply = { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }

describe.sequential('370 Stage A — legacy calendar sources inventory (contract, not implementation)', () => {
  let app: FastifyInstance, guarded = false
  const users = new Set<string>(), vendors = new Set<string>(), weddings = new Set<string>()
  const createdUsers = new Set<string>()
  const waits: { change: string; holder: number; waiters: number[]; query: string }[] = []
  const prefix = String(randomInt(100_000, 999_999)); let sequence = 0, daySeq = 0

  beforeAll(async () => {
    assert(DATABASE, 'TEST_DATABASE_URL is required for the 370 inventory contract tests')
    assert.equal(process.env.DATABASE_URL, DATABASE); assert.equal(disposablePgPort(), disposablePgPort())
    const target = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.username, 'codex_test'); assert.equal(target.port, disposablePgPort()); assert.equal(target.search, ''); assert.equal(target.hash, '')
    assert(DB_NAME_RE.test(target.pathname.slice(1)), 'guarded disposable inventory/full test database only')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'legacy-calendar-inventory-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query<{ address: string; port: number; name: string; principal: string }>(
      'select host(inet_server_addr()) address,inet_server_port() port,current_database() name,current_user principal')).rows[0]!
    expect(['127.0.0.1', '::1']).toContain(live.address); expect(live.port).toBe(Number(disposablePgPort()))
    expect(live.name).toBe(target.pathname.slice(1)); expect(live.principal).toBe('codex_test')
    guarded = true
  })
  afterAll(async () => {
    if (!app) return
    try {
      if (!guarded) return
      process.stdout.write(`LEGACY_CALENDAR_SOURCES_PG_WAITS count=${waits.length} ${JSON.stringify(waits)}\n`)
      process.stdout.write(`LEGACY_CALENDAR_SOURCES_FIXTURE_MANIFEST ${JSON.stringify({ database: new URL(DATABASE!).pathname.slice(1), users: [...createdUsers], vendors: [...vendors], weddings: [...weddings] })}\n`)
      // Cascades only (never TRUNCATE): weddings cascade their own app-history
      // (legacy_calendar_sources.wedding_id) and vendors cascade manual/orphan
      // history (company_id) — D6. Weddings first, then vendors, matches the
      // existing ecosystem suites' own cleanup order.
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of vendors) await app.db!.query('delete from vendors where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
      const remaining = (await app.db!.query<{ users: number; sessions: number; consents: number }>(`select
        (select count(*)::int from users where id=any($1::uuid[])) as users,
        (select count(*)::int from sessions where user_id=any($1::uuid[])) as sessions,
        (select count(*)::int from consents where user_id=any($1::uuid[])) as consents`, [[...createdUsers]])).rows[0]!
      expect(remaining, 'all created actor accounts and their sessions/consents must be erased by teardown')
        .toEqual({ users: 0, sessions: 0, consents: 0 })
    } finally { await app.close() }
  })

  // ---------- generic fixtures (actors/companies/weddings/bookings) ----------
  async function actor() {
    const userId = randomUUID(), sessionId = randomUUID(); users.add(userId); createdUsers.add(userId)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic 370 actor')", [userId, `+79${prefix}${String(++sequence).padStart(4, '0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), userId, POLICY])
    return { userId, sessionId, policyVersion: POLICY, token: await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const principal = (a: Actor): OrderActor => ({ userId: a.userId, sessionId: a.sessionId, policyVersion: a.policyVersion })
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor, key = randomUUID()) => ({ ...auth(a), 'idempotency-key': key })
  async function company(owner?: Actor) {
    const o = owner ?? await actor(), id = randomUUID(); vendors.add(id)
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic 370 florist',now())", [id, o.userId])
    return { id, owner: o }
  }
  type Company = Awaited<ReturnType<typeof company>>
  function freshDate(): string {
    const d = new Date(Date.UTC(2027, 7, 10)); d.setUTCDate(d.getUTCDate() + daySeq); daySeq += 1
    return d.toISOString().slice(0, 10)
  }
  async function wedding(pair: Actor, date: string | null = freshDate()) {
    const id = randomUUID(), slot = randomUUID(); weddings.add(id)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic 370 wedding',$3,'Europe/Moscow',$4)", [id, pair.userId, date, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [id, pair.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Synthetic 370 floral position')", [slot, id])
    return { id, slot, date }
  }
  type Wedding = Awaited<ReturnType<typeof wedding>>
  async function secondSlot(w: Wedding) {
    const slot = randomUUID()
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'decor','Synthetic 370 second position')", [slot, w.id])
    return slot
  }
  const book = (pair: Actor, w: Wedding, c: Company, key = randomUUID(), slot = w.slot) =>
    app.inject({ method: 'POST', url: `/weddings/${w.id}/slots/${slot}/book`, headers: idem(pair, key), payload: { vendorId: c.id, price: { amount: 15000, currency: 'RUB' } } })
  const manual = (owner: Actor, dates: string[], status: 'busy' | 'free') =>
    app.inject({ method: 'POST', url: '/vendor/calendar/busy', headers: auth(owner), payload: { dates, status } })
  const patchDeal = (pair: Actor, dealId: string, state: string, key = randomUUID()) =>
    app.inject({ method: 'PATCH', url: `/deals/${dealId}`, headers: idem(pair, key), payload: { state } })
  const cancelSlot = (pair: Actor, w: Wedding, slot = w.slot, key = randomUUID()) =>
    app.inject({ method: 'POST', url: `/weddings/${w.id}/slots/${slot}/cancel`, headers: idem(pair, key) })
  const rescheduleTo = (pair: Actor, w: Wedding, date: string, key = randomUUID()) =>
    app.inject({ method: 'POST', url: `/weddings/${w.id}/reschedule`, headers: idem(pair, key), payload: { date } })
  async function rawDeal(w: Wedding, c: Company, state: string = 'contacted', slot = w.slot) {
    const id = randomUUID()
    await app.db!.query('insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,$5,15000)', [id, w.id, slot, c.id, state])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slot, id])
    return id
  }
  function ok<T>(r: Reply): T { expect(r.statusCode, r.body).toBe(200); return r.json<T>() }
  function httpError(r: Reply, code: string, status = 409) { expect(r.statusCode, r.body).toBe(status); expect(r.json<{ error: { code: string } }>().error.code).toBe(code) }

  // Full agreed resource-order flow ending with a committed ledger
  // (`deal_resource_commitments.revision>0`) while the deal itself is left
  // in `candidate` — mirrors `validLedger` in test/resourceBookingBoundaries.test.ts.
  async function ledger(w: Wedding, c: Company, pair: Actor) {
    const dealId = await rawDeal(w, c, 'candidate')
    const equipment = await app.db!.tx(x => createResource(x, { vendorId: c.id, actor: principal(c.owner), kind: 'capacity', label: 'Synthetic 370 production', capacityUnit: 'compositions' }))
    const window = await app.db!.tx(x => createCapacityWindow(x, { vendorId: c.id, actor: principal(c.owner), resourceId: equipment.id, startsAt: '2027-08-01T00:00:00Z', endsAt: '2027-08-31T23:00:00Z', capacity: 10 }))
    const event = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [w.id])).rows[0]!.id
    const input = { weddingId: w.id, dealId, actor: principal(pair) }
    const assigned = await app.db!.tx(x => createOrderAssignment(x, { ...input, expectedVersion: '1', slotId: w.slot, programEventId: event, label: 'Synthetic 370 delivery duty' }))
    const part = await app.db!.tx(x => createOrderPart(x, { ...input, expectedVersion: assigned.version, assignmentId: assigned.assignments[0]!.id, kind: 'supply', title: 'Synthetic 370 compositions', details: { quantity: 1, unit: 'compositions' } }))
    const plan = await app.db!.tx(x => saveOrderResourcePlan(x, { ...input, actor: principal(c.owner), expectedVersion: part.version, expectedPlanRevision: '0',
      lines: [{ partId: part.parts[0]!.id, resourceId: equipment.id, capacityWindowId: window.id, quantity: 1, startsAt: '2027-08-02T07:00:00Z', endsAt: '2027-08-02T09:00:00Z', timeZone: 'Europe/Moscow', setupMinutes: 0, teardownMinutes: 0, travelBeforeMinutes: 0, travelAfterMinutes: 0 }] }))
    await app.db!.tx(x => publishOrderTerms(x, { ...input, expectedOrderVersion: plan.orderVersion, expectedTermsRevision: '0' }))
    for (const person of [pair, c.owner]) {
      const party = { ...input, actor: principal(person) }, read = await app.db!.tx(x => loadOrderTerms(x, party, { secret: SECRET })), selected = read.selected!
      await app.db!.tx(x => acceptOrderTerms(x, { ...party, termsId: selected.id, expectedTermsVersion: selected.version, digest: selected.digest, readToken: read.readToken! }, { secret: SECRET }))
    }
    const terms = await app.db!.tx(x => loadOrderTerms(x, input, { secret: SECRET }))
    // Арбитраж драйвера: бронь ресурсов требует режима ресурсов компании (commitments.ts,
    // `resource_policy_required`) — как `validLedger` в resourceBookingBoundaries.test.ts.
    const policy = await app.db!.tx(x => setAvailabilityPolicy(x, { vendorId: c.id, actor: principal(c.owner), mode: 'resources', expectedRevision: '0' }))
    await app.db!.tx(x => commitAgreedOrderResources(x, { ...input, expectedOrderVersion: plan.orderVersion, expectedCommitmentRevision: '0',
      termsId: terms.selected!.id, expectedTermsVersion: terms.selected!.version, termsDigest: terms.selected!.digest, planRevisionId: plan.current!.planRevisionId, expectedPolicyRevision: policy.revision }))
    return dealId
  }

  // ---------- module-under-test wrappers ----------
  const load = (vendorId: string, who: Actor): Promise<LegacyInventoryView> => app.db!.tx(c => loadLegacyCalendarInventory(c, { vendorId, actor: principal(who) }))
  const capture = (vendorId: string, sourceId: string, who: Actor, expectedSourceRevision: string, expectedInventoryRevision: string) =>
    app.db!.tx(c => captureLegacyCalendarSource(c, { vendorId, actor: principal(who), sourceId, expectedSourceRevision, expectedInventoryRevision }))
  const locateScope = (vendorId: string, sourceId: string) => app.db!.tx(c => locateLegacyCalendarInventoryScope(c, { vendorId, sourceId }))
  async function dayId(vendorId: string, date: string): Promise<string> {
    const row = (await app.db!.query<{ id: string }>('select id from vendor_busy_dates where vendor_id=$1 and date=$2::date', [vendorId, date])).rows[0]
    expect(row, `no vendor_busy_dates row for ${vendorId}/${date}`).toBeTruthy(); return row!.id
  }
  async function sourceRow(vendorId: string, kind: CalendarSourceKind, dayOrRootId: string) {
    return (await app.db!.query('select * from legacy_calendar_sources where vendor_id=$1 and kind=$2 and (day_id=$3 or root_deal_id=$3)', [vendorId, kind, dayOrRootId])).rows[0] as Record<string, unknown> | undefined
  }
  async function headRow(sourceId: string) { return (await app.db!.query('select * from legacy_calendar_heads where source_id=$1', [sourceId])).rows[0] as Record<string, unknown> | undefined }
  async function versionsOf(sourceId: string) { return (await app.db!.query('select * from legacy_calendar_versions where source_id=$1 order by revision', [sourceId])).rows }
  async function holdersOf(sourceId: string, versionId: string) { return (await app.db!.query('select * from legacy_calendar_version_holders where source_id=$1 and version_id=$2 order by wedding_id,deal_id', [sourceId, versionId])).rows }
  const sha256hex = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
  async function expectDomainError(action: Promise<unknown>, code: string, status: number) { await expect(action).rejects.toMatchObject({ statusCode: status, code }) }

  // ---------- real-lock race witnesses (T04) ----------
  // Transitive BFS over the live pg_blocking_pids graph: a second waiter on a
  // row is reported blocked by the FIRST waiter in this PostgreSQL version,
  // not directly by the original holder — so both levels must be counted,
  // not just direct blockers of `holderPid`.
  async function blockedBy(holderPid: number, minCount: number, change: string) {
    let found: { pid: number; wait_event: string | null; query: string }[] = []
    for (let attempt = 0; attempt < 160; attempt++) {
      const rows = (await app.db!.query<{ pid: number; wait_event: string | null; query: string; blockers: number[] }>(
        `select pid,wait_event,query,pg_blocking_pids(pid) blockers from pg_stat_activity
         where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'`)).rows
      const seen = new Set<number>(), queue = [holderPid]
      while (queue.length) { const cur = queue.shift()!; for (const row of rows) if (row.blockers.includes(cur) && !seen.has(row.pid)) { seen.add(row.pid); queue.push(row.pid) } }
      found = rows.filter(r => seen.has(r.pid))
      if (found.length >= minCount) break
      await new Promise<void>(r => setTimeout(r, 25))
    }
    expect(found.length, `${change}: expected >=${minCount} real waiters (direct or chained) on pid ${holderPid}`).toBeGreaterThanOrEqual(minCount)
    waits.push({ change, holder: holderPid, waiters: found.map(f => f.pid), query: found[0]?.query ?? '' })
    return found
  }
  async function holdLock(lockSql: string, lockValues: readonly unknown[], mutate: (c: Queryable) => Promise<void>) {
    let release!: () => void, signal!: () => void, holderPid = 0
    const permission = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { signal = r })
    const holder = app.db!.tx(async c => {
      holderPid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query(lockSql, lockValues); signal(); await permission; await mutate(c)
    })
    await Promise.race([ready, holder.then(() => { throw new Error('holder finished before signalling ready') })])
    return { holderPid, finish: async () => { release(); await holder } }
  }

  // ============================================================ T01 ============================================================
  describe('T01 — операционная идентичность дня', () => {
    it('новый день получает устойчивый uuid и source_revision=1', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      expect(ok<{ deal: { id: string } }>(await book(pair, w, c)).deal.id).toBeTypeOf('string')
      const row = (await app.db!.query('select id,source_revision::text rev from vendor_busy_dates where vendor_id=$1 and date=$2::date', [c.id, w.date])).rows[0]!
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/); expect(row.rev).toBe('1')
    })
    it('смена указателя увеличивает source_revision ровно на единицу; тот же указатель и set source=source — без роста', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair), s2 = await secondSlot(w)
      const dealA = ok<{ deal: { id: string } }>(await book(pair, w, c)).deal.id
      const dealB = ok<{ deal: { id: string } }>(await book(pair, w, c, randomUUID(), s2)).deal.id
      const before = (await app.db!.query('select deal_id,source_revision::text rev from vendor_busy_dates where vendor_id=$1 and date=$2::date', [c.id, w.date])).rows[0]!
      expect(before.deal_id).toBe(dealA); expect(before.rev).toBe('1')
      await app.db!.query('update vendor_busy_dates set source=source where vendor_id=$1 and date=$2::date', [c.id, w.date])
      await app.db!.query('update vendor_busy_dates set deal_id=deal_id where vendor_id=$1 and date=$2::date', [c.id, w.date])
      expect((await app.db!.query('select source_revision::text rev from vendor_busy_dates where vendor_id=$1 and date=$2::date', [c.id, w.date])).rows[0]!.rev).toBe('1')
      const cancelled = await cancelSlot(pair, w); expect(cancelled.statusCode, cancelled.body).toBe(200)
      const after = (await app.db!.query('select deal_id,source_revision::text rev from vendor_busy_dates where vendor_id=$1 and date=$2::date', [c.id, w.date])).rows[0]!
      expect(after.deal_id).toBe(dealB); expect(after.rev).toBe('2')
    })
    it.each(['id', 'vendor_id', 'date', 'source', 'created_at'] as const)('колонка %s операционного дня неизменна', async column => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const value = column === 'id' || column === 'vendor_id' ? `'${randomUUID()}'::uuid` : column === 'date' ? "'2027-09-01'" :
        column === 'source' ? "'manual'" : "now()"
      const sql = column === 'date' || column === 'source'
        ? `update vendor_busy_dates set ${column}=${value} where vendor_id=$1 and date=$2::date`
        : `update vendor_busy_dates set ${column}=${value} where vendor_id=$1 and date=$2::date`
      await expect(app.db!.query(sql, [c.id, w.date])).rejects.toMatchObject({ code: '23514' })
    })
    it('явная не-единичная source_revision на вставке отказывает', async () => {
      const c = await company()
      await expect(app.db!.query("insert into vendor_busy_dates(vendor_id,date,source,source_revision) values($1,'2027-09-05','manual',2)", [c.id])).rejects.toMatchObject({ code: '23514' })
    })
    it('повтор удалённого id операционного дня отказывает', async () => {
      const c = await company(), owner = c.owner
      expect((await manual(owner, ['2027-09-10'], 'busy')).statusCode).toBe(204)
      const row = (await app.db!.query<{ id: string }>('select id from vendor_busy_dates where vendor_id=$1 and date=$2', [c.id, '2027-09-10'])).rows[0]!
      expect((await manual(owner, ['2027-09-10'], 'free')).statusCode).toBe(204)
      expect((await app.db!.query('select 1 from vendor_busy_dates where id=$1', [row.id])).rowCount).toBe(0)
      await expect(app.db!.query("insert into vendor_busy_dates(id,vendor_id,date,source) values($1,$2,'2027-09-11','manual')", [row.id, c.id])).rejects.toMatchObject({ code: '23514' })
    })
  })

  // ============================================================ T02 ============================================================
  describe('T02 — обнаружение у настоящих писателей', () => {
    it('каталожная бронь обнаруживает app_day на удерживаемую дату', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      const deal = ok<{ deal: { id: string } }>(await book(pair, w, c)).deal.id
      const id = await dayId(c.id, w.date)
      const row = await sourceRow(c.id, 'app_day', id)
      expect(row).toMatchObject({ kind: 'app_day', vendor_id: c.id, wedding_id: w.id, day_id: id, root_deal_id: null, discovered_by: 'writer' })
      expect((await load(c.id, c.owner)).sources.some(s => s.sourceId === row!.id)).toBe(true)
      void deal
    })
    it('PATCH в negotiating, затем в booked: одна сделка проходит live_negotiation и затем app_root', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      expect((await patchDeal(pair, deal, 'negotiating')).statusCode).toBe(200)
      const negotiation = await sourceRow(c.id, 'live_negotiation', deal)
      expect(negotiation).toMatchObject({ kind: 'live_negotiation', vendor_id: c.id, wedding_id: w.id, root_deal_id: deal, day_id: null })
      expect((await patchDeal(pair, deal, 'booked')).statusCode).toBe(200)
      const root = await sourceRow(c.id, 'app_root', deal)
      expect(root).toMatchObject({ kind: 'app_root', vendor_id: c.id, wedding_id: w.id, root_deal_id: deal, day_id: null })
      expect(root!.id).not.toBe(negotiation!.id)
    })
    it('ручной день обнаруживает manual_day', async () => {
      const c = await company(), owner = c.owner
      expect((await manual(owner, ['2027-08-05'], 'busy')).statusCode).toBe(204)
      const id = await dayId(c.id, '2027-08-05'), row = await sourceRow(c.id, 'manual_day', id)
      expect(row).toMatchObject({ kind: 'manual_day', vendor_id: c.id, company_id: c.id, wedding_id: null, day_id: id })
    })
    it('cancelDeal делает обнаруженный корень недостижимым (unavailable), сам источник остаётся историей', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await patchDeal(pair, deal, 'booked')
      const root = await sourceRow(c.id, 'app_root', deal)
      expect(await cancelSlot(pair, w)).toMatchObject({ statusCode: 200 })
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === root!.id)
      expect(dto).toMatchObject({ freshness: 'unavailable' })
    })
    it('перенос свадьбы освобождает старый день и обнаруживает новую идентичность на новой дате', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const oldId = await dayId(c.id, w.date), oldSource = await sourceRow(c.id, 'app_day', oldId)
      const newDate = freshDate(), moved = await rescheduleTo(pair, w, newDate)
      expect(moved.statusCode, moved.body).toBe(200)
      expect((await app.db!.query('select 1 from vendor_busy_dates where vendor_id=$1 and date=$2::date', [c.id, w.date])).rowCount).toBe(0)
      const newId = await dayId(c.id, newDate), newSource = await sourceRow(c.id, 'app_day', newId)
      expect(newSource).toBeTruthy(); expect(newSource!.id).not.toBe(oldSource!.id); expect(newId).not.toBe(oldId)
    })
    it('согласованный ресурсный заказ (reserve) пишет голову брони до booked — app_root не обнаруживается', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null)
      const dealWithLedger = await ledger(w, c, pair)
      expect((await app.db!.query('select revision::text rev from deal_resource_commitments where deal_id=$1', [dealWithLedger])).rows[0]!.rev).not.toBe('0')
      // Discovery is a database trigger on deals(state,vendor_id); flip state
      // directly to isolate it from the unrelated, pre-existing HTTP-level
      // resource-policy gate (`assertLegacyDateBookingAllowed`), which is not
      // part of 370 and would otherwise refuse this same transition for an
      // orthogonal reason (any live allocation already blocks new legacy
      // catalogue bookings for this vendor, regardless of this deal).
      await app.db!.query("update deals set state='booked' where id=$1", [dealWithLedger])
      expect(await sourceRow(c.id, 'app_root', dealWithLedger)).toBeUndefined()
      const plain = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [plain])
      expect(await sourceRow(c.id, 'app_root', plain)).toBeTruthy()
    })
    it('истечение мягкой брони по часам снимает присутствие live_negotiation при чтении, без новой записи', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await patchDeal(pair, deal, 'negotiating')
      const source = await sourceRow(c.id, 'live_negotiation', deal)
      const before = await app.db!.query('select count(*)::int n from legacy_calendar_sources')
      await app.db!.query("update deals set negotiating_until=now()-interval '1 hour' where id=$1", [deal])
      expect((await app.db!.query('select count(*)::int n from legacy_calendar_sources')).rows[0]!.n).toBe(before.rows[0]!.n)
      const dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)
      expect(dto).toMatchObject({ freshness: 'unavailable' })
    })
  })

  // ============================================================ T03 ============================================================
  describe('T03 — группа, done-в-другой-день, ledgerless, orphan, mixed, manual без свадьбы', () => {
    it('общий день двух держателей: done без своей строки входит, done со своей строкой — нет', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair), s2 = await secondSlot(w)
      const dealA = ok<{ deal: { id: string } }>(await book(pair, w, c)).deal.id // pointer
      const dealB = ok<{ deal: { id: string } }>(await book(pair, w, c, randomUUID(), s2)).deal.id // same-day holder, no own row
      await app.db!.query("update deals set state='done',done_at=now() where id=$1", [dealB])
      // A third same-wedding/vendor deal that is done AND already owns its OWN
      // separate day (a different date) must be excluded from this group —
      // only a done holder WITHOUT its own day row stays in.
      const s3 = await secondSlot(w), dealC = await rawDeal(w, c, 'done', s3), otherDate = freshDate()
      await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2::date,'deal',$3)", [c.id, otherDate, dealC])
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      expect((await app.db!.query('select deal_id from vendor_busy_dates where id=$1', [id])).rows[0]!.deal_id).toBe(dealA)
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === source!.id)!
      expect(dto).toMatchObject({ scopeCompleteness: 'complete', unavailableReason: null })
      expect(dto.holderCount).toBe(2) // dealA (pointer) + dealB (done, no own day); dealC excluded (done WITH its own day)
      // `locate` is a broader, lock-ordering scope: it lists every one of V's
      // deals in the referenced weddings regardless of state, unlike the
      // material's holder filter above — dealC belongs here even though it
      // is not a holder.
      const scope = await locateScope(c.id, source!.id as string)
      expect(scope.weddingIds).toContain(w.id)
      expect([...scope.dealIds].sort()).toEqual([dealA, dealB, dealC].sort())
      expect(scope.dayIds).toContain(id)
    })
    it('свадьба без даты держит собственный app_root', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [deal])
      const source = await sourceRow(c.id, 'app_root', deal)
      const dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)!
      expect(dto).toMatchObject({ kind: 'app_root', scopeCompleteness: 'complete', holderCount: 1, originDate: null })
    })
    it('осиротевший день (сделка исчезла, строка осталась) — unknown/orphan без держателей', async () => {
      const pair = await actor(), c = await company(pair), w = await wedding(pair)
      await book(pair, w, c)
      const id = await dayId(c.id, w.date)
      await sourceRow(c.id, 'app_day', id) // app_day already discovered
      // Арбитраж драйвера (неоднозначность (2) автора теста): purge/`eraseUser` снимают строки дней
      // ЯВНО до удаления свадьбы (jobs/index.ts; контракт, «Писатели»), поэтому сироту даёт только
      // каскад без этой уборки — модель п. 7: сделка удаляется каскадом свадьбы, строка дня остаётся
      // с `deal_id` NULL (FK SET NULL) и обнаруживается как orphan_day.
      await app.db!.query('delete from weddings where id=$1', [w.id])
      weddings.delete(w.id)
      const orphan = await sourceRow(c.id, 'orphan_day', id)
      expect(orphan).toMatchObject({ kind: 'orphan_day' })
      const dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === orphan!.id)!
      expect(dto).toMatchObject({ scopeCompleteness: 'unknown', unavailableReason: 'orphan', holderCount: 0 })
    })
    it('чужой указатель на общей дате — mixed_scope без держателей', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const foreignPair = await actor(), foreignCompany = await company(), foreignWedding = await wedding(foreignPair)
      const foreignDeal = ok<{ deal: { id: string } }>(await book(foreignPair, foreignWedding, foreignCompany)).deal.id
      // Simulates historical drift (pre-370 data), not a guard violation:
      // the pointer column is meant to change; it is just pointed at a deal
      // that belongs to a different vendor than this source's own vendor_id.
      await app.db!.query('update vendor_busy_dates set deal_id=$2 where vendor_id=$1 and date=$3::date', [c.id, foreignDeal, w.date])
      const dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)!
      expect(dto).toMatchObject({ scopeCompleteness: 'unknown', unavailableReason: 'mixed_scope', holderCount: 0 })
    })
    it('manual_day: без свадьбы, держателей всегда 0', async () => {
      const c = await company(), owner = c.owner
      await manual(owner, ['2027-08-07'], 'busy')
      const id = await dayId(c.id, '2027-08-07'), source = await sourceRow(c.id, 'manual_day', id)
      expect(source).toMatchObject({ wedding_id: null })
      const dto = (await load(c.id, owner)).sources.find(s => s.sourceId === source!.id)!
      expect(dto).toMatchObject({ scopeCompleteness: 'complete', holderCount: 0 })
    })
    it('захват: число holders совпадает с ожидаемым, canonical равен текущему материалу', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair), s2 = await secondSlot(w)
      await book(pair, w, c); await book(pair, w, c, randomUUID(), s2)
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const before = await load(c.id, c.owner), dto = before.sources.find(s => s.sourceId === source!.id)!
      const captured = await capture(c.id, source!.id as string, c.owner, dto.sourceRevision, before.sources.find(s => s.sourceId === source!.id)!.inventoryRevision)
      expect(captured.holderCount).toBe(2)
      const versions = await versionsOf(source!.id as string), version = versions[versions.length - 1]!
      const parsed = JSON.parse(version.canonical as string) as { holders: unknown[]; encoding: string; sourceId: string }
      expect(parsed.encoding).toBe('legacy-calendar-inventory/1'); expect(parsed.sourceId).toBe(source!.id)
      expect(parsed.holders).toHaveLength(2)
      expect(await holdersOf(source!.id as string, version.id as string)).toHaveLength(2)
    })
  })

  // ============================================================ T04 ============================================================
  describe('T04 — настоящее ожидание разрешает в 409/401/403, прежняя версия становится stale', () => {
    async function capturedDay(pair: Actor, c: Company, w: Wedding) {
      await book(pair, w, c)
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const view = await load(c.id, c.owner), dto: LegacyInventorySourceDto = view.sources.find(s => s.sourceId === source!.id)!
      const captured = await capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      return { source: source!, firstVersionId: captured.currentInventoryVersionId!, dto }
    }
    it('новый держатель, появившийся во время ожидания, даёт scope_changed; голова/версии/holders не меняются, прежняя версия — stale', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair), s2 = await secondSlot(w)
      const { source, firstVersionId, dto } = await capturedDay(pair, c, w)
      const headBefore = await headRow(source.id as string), versionsBefore = await versionsOf(source.id as string)
      const { holderPid, finish } = await holdLock('select id from weddings where id=$1 for update', [w.id], async c2 => {
        await c2.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'booked',15000)", [randomUUID(), w.id, s2, c.id])
      })
      const pending = capture(c.id, source.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      await blockedBy(holderPid, 1, 'new holder appears'); await finish()
      await expectDomainError(pending, 'legacy_source_scope_changed', 409)
      expect(await headRow(source.id as string)).toEqual(headBefore); expect(await versionsOf(source.id as string)).toEqual(versionsBefore)
      const after = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source.id)!
      expect(after.freshness).toBe('stale'); expect(after.currentInventoryVersionId).toBe(firstVersionId)
    })
    it('перенос указателя во время ожидания делает expectedSourceRevision устаревшей — legacy_source_changed', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair), s2 = await secondSlot(w)
      const dealA = ok<{ deal: { id: string } }>(await book(pair, w, c)).deal.id
      await book(pair, w, c, randomUUID(), s2)
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === source!.id)!
      // Арбитраж драйвера: держатель идёт порядком настоящих писателей — сначала свадьба
      // (lockOrderContext/PATCH deals FOR UPDATE), как и шаг 3 захвата; строка дня первой давала
      // взаимную блокировку, которой у приложения нет (контракт, «Риски» п. 1).
      const { holderPid, finish } = await holdLock('select id from weddings where id=$1 for update', [w.id], async c2 => {
        await cancelDealRepointLocked(c2, dealA)
      })
      async function cancelDealRepointLocked(c2: Queryable, dealId: string) {
        // Mirrors releaseVendorDate's HOLDER semantics (repoint to the
        // remaining open same-wedding/vendor holder) without re-entering the
        // app's own lock order from inside an already-held row lock.
        await c2.query("update deals set state='cancelled',cancelled_at=now() where id=$1", [dealId])
        await c2.query(`update vendor_busy_dates set deal_id=(select id from deals where wedding_id=$2 and vendor_id=$3 and state=any($4) and id<>$1 limit 1)
          where vendor_id=$3 and date=$5::date`, [dealId, w.id, c.id, COMMITTED, w.date])
      }
      const pending = capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      await blockedBy(holderPid, 1, 'repoint mid-capture'); await finish()
      await expectDomainError(pending, 'legacy_source_changed', 409)
    })
    /* Арбитраж драйвера 370-T04: компания перечитывается на шаге 7 (vendors FOR SHARE, «как load»)
       раньше сверки области на шаге 10 — сменившийся владелец получает 403, а не 409 scope_changed. */
    it('смена владельца во время ожидания — 403 на шаге 7, до сверки области', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      const { source, dto } = await capturedDay(pair, c, w)
      const newOwner = await actor()
      const { holderPid, finish } = await holdLock('select id from vendors where id=$1 for update', [c.id], async c2 => {
        await c2.query('update vendors set user_id=$2 where id=$1', [c.id, newOwner.userId])
      })
      const pending = capture(c.id, source.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      await blockedBy(holderPid, 1, 'owner change mid-capture'); await finish()
      await expectDomainError(pending, 'forbidden', 403)
    })
    it('отзыв сессии владельца во время ожидания — 401', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      const { source, dto } = await capturedDay(pair, c, w)
      const { holderPid, finish } = await holdLock('select id from sessions where id=$1 for update', [c.owner.sessionId], async c2 => {
        await c2.query('update sessions set revoked_at=now() where id=$1', [c.owner.sessionId])
      })
      const pending = capture(c.id, source.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      await blockedBy(holderPid, 1, 'session revoked mid-capture'); await finish()
      await expectDomainError(pending, 'unauthorized', 401)
    })
    it('отзыв согласия владельца во время ожидания — 403', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      const { source, dto } = await capturedDay(pair, c, w)
      const { holderPid, finish } = await holdLock('select id from consents where user_id=$1 for update', [c.owner.userId], async c2 => {
        await c2.query('update consents set withdrawn_at=now() where user_id=$1', [c.owner.userId])
      })
      const pending = capture(c.id, source.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      await blockedBy(holderPid, 1, 'consent withdrawn mid-capture'); await finish()
      await expectDomainError(pending, 'forbidden', 403)
    })
    it('удаление аккаунта владельца во время ожидания — 401', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      const { source, dto } = await capturedDay(pair, c, w)
      const { holderPid, finish } = await holdLock('select id from users where id=$1 for update', [c.owner.userId], async c2 => {
        await c2.query('update users set deleted_at=now() where id=$1', [c.owner.userId])
      })
      const pending = capture(c.id, source.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      await blockedBy(holderPid, 1, 'account deleted mid-capture'); await finish()
      await expectDomainError(pending, 'unauthorized', 401)
    })
    it('двойной захват одного источника: ровно один legacy_inventory_version_conflict, голова продвигается один раз', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === source!.id)!
      const { holderPid, finish } = await holdLock('select source_id from legacy_calendar_heads where source_id=$1 for update', [source!.id], async () => undefined)
      const first = capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      const second = capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      await blockedBy(holderPid, 2, 'double capture race'); await finish()
      const [r1, r2] = await Promise.allSettled([first, second])
      const outcomes = [r1, r2]
      const succeeded = outcomes.filter(r => r.status === 'fulfilled')
      const failed = outcomes.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(succeeded).toHaveLength(1); expect(failed).toHaveLength(1)
      expect(failed[0]!.reason).toMatchObject({ statusCode: 409, code: 'legacy_inventory_version_conflict' })
      expect(await versionsOf(source!.id as string)).toHaveLength(1)
    })
  })

  // ============================================================ T05 ============================================================
  describe('T05 — DELETE/reinsert операционного дня', () => {
    it('захват → отмена → unavailable с прежними байтами версии; новая бронь той же даты — новая идентичность; захват unavailable — 409', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const oldId = await dayId(c.id, w.date), oldSource = await sourceRow(c.id, 'app_day', oldId)
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === oldSource!.id)!
      const captured = await capture(c.id, oldSource!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      const versionBefore = (await versionsOf(oldSource!.id as string))[0]!
      expect(await cancelSlot(pair, w)).toMatchObject({ statusCode: 200 })
      expect((await app.db!.query('select 1 from vendor_busy_dates where id=$1', [oldId])).rowCount).toBe(0)
      const afterCancel = (await load(c.id, c.owner)).sources.find(s => s.sourceId === oldSource!.id)!
      expect(afterCancel.freshness).toBe('unavailable')
      const versionAfter = (await versionsOf(oldSource!.id as string))[0]!
      expect(versionAfter).toEqual(versionBefore)
      await expectDomainError(capture(c.id, oldSource!.id as string, c.owner, afterCancel.sourceRevision, afterCancel.inventoryRevision), 'legacy_source_unavailable', 409)
      const w2 = await wedding(pair); await app.db!.query('update weddings set date=$2::date where id=$1', [w2.id, w.date])
      expect(ok<{ deal: { id: string } }>(await book(pair, w2, c)).deal.id).toBeTypeOf('string')
      const newId = await dayId(c.id, w.date), newSource = await sourceRow(c.id, 'app_day', newId)
      expect(newId).not.toBe(oldId); expect(newSource!.id).not.toBe(oldSource!.id)
      void captured
    })
  })

  // ============================================================ T06 ============================================================
  describe('T06 — прямой SQL: не менее 10 независимых отрицаний из модели §6', () => {
    async function prepared() {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === source!.id)!
      const captured = await capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      const version = (await versionsOf(source!.id as string))[0]!, head = await headRow(source!.id as string)
      return { pair, c, w, id, source: source!, version, head, captured }
    }
    type Prepared = Awaited<ReturnType<typeof prepared>>
    const cases: { label: string; substring: string; run: (f: Prepared, c2: Queryable) => Promise<unknown>; deferred?: boolean }[] = [
      { label: 'sources INSERT с заведомо неверным origin', substring: 'operational origin', run: (f, c2) =>
        c2.query("insert into legacy_calendar_sources(id,kind,vendor_id,wedding_id,day_id,origin,discovered_by) values($1,'app_day',$2,$3,$4,'{\"bogus\":true}'::jsonb,'writer')", [randomUUID(), f.c.id, f.w.id, f.id]) },
      { label: 'sources UPDATE — immutable', substring: 'immutable', run: (f, c2) => c2.query("update legacy_calendar_sources set discovered_by='migration' where id=$1", [f.source.id]) },
      ...([['app_root', 'booked'], ['live_negotiation', 'negotiating']] as const).map(([kind, state]) => ({
        label: `${kind}: внешняя сделка с vendor_id=NULL не создаёт источник чужой компании`, substring: 'actual operational origin',
        run: async (f: Prepared, c2: Queryable) => {
          const slotId = randomUUID(), dealId = randomUUID(), sourceId = randomUUID()
          await c2.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Synthetic external source')", [slotId, f.w.id])
          await c2.query("insert into deals(id,wedding_id,slot_id,external_name,state,price) values($1,$2,$3,'Synthetic external contractor',$4,15000)", [dealId, f.w.id, slotId, state])
          await c2.query(`insert into legacy_calendar_sources(id,kind,vendor_id,wedding_id,root_deal_id,origin,discovered_by)
            values($1,$2,$3,$4,$5,legacy_calendar_origin($2,null,$5),'writer')`, [sourceId, kind, f.c.id, f.w.id, dealId])
          await c2.query('insert into legacy_calendar_heads(source_id) values($1)', [sourceId])
        },
      })),
      { label: 'sources DELETE при живой свадьбе', substring: 'can only be erased', run: (f, c2) => c2.query('delete from legacy_calendar_sources where id=$1', [f.source.id]) },
      { label: 'versions INSERT пропускает ревизию', substring: 'next exact head revision', run: (f, c2) =>
        c2.query("insert into legacy_calendar_versions(id,source_id,revision,canonical,digest,capture_kind) values($1,$2,5,'{}','" + sha256hex('{}') + "','owner_capture')", [randomUUID(), f.source.id]) },
      { label: 'versions INSERT с canonical не равным материалу', substring: 'equal current material', run: (f, c2) => {
        const bogus = JSON.stringify({ bogus: true }); return c2.query("insert into legacy_calendar_versions(id,source_id,revision,canonical,digest,capture_kind) values($1,$2,2,$3,$4,'owner_capture')", [randomUUID(), f.source.id, bogus, sha256hex(bogus)])
      } },
      { label: 'versions INSERT owner_capture с чужим captured_by', substring: 'current company owner', run: async (f, c2) => {
        const stranger = await actor()
        return c2.query('insert into legacy_calendar_versions(id,source_id,revision,canonical,digest,capture_kind,captured_by) values($1,$2,2,$3,$4,$5,$6)',
          [randomUUID(), f.source.id, f.version.canonical, f.version.digest, 'owner_capture', stranger.userId])
      } },
      { label: 'versions UPDATE произвольного поля — immutable', substring: 'immutable', run: (f, c2) => c2.query("update legacy_calendar_versions set capture_kind='owner_capture' where id=$1", [f.version.id]) },
      { label: 'holders INSERT со снимком, не совпадающим с материалом версии', substring: 'match captured material', run: (f, c2) =>
        c2.query("insert into legacy_calendar_version_holders(source_id,version_id,wedding_id,deal_id,snapshot,fingerprint) values($1,$2,$3,$4,'{\"bogus\":true}'::jsonb,$5)",
          [f.source.id, f.version.id, f.w.id, randomUUID(), sha256hex('{"bogus":true}')]) },
      { label: 'holders UPDATE — immutable', substring: 'immutable', run: async (f, c2) => {
        const rows = await holdersOf(f.source.id as string, f.version.id as string)
        return c2.query('update legacy_calendar_version_holders set snapshot=snapshot where source_id=$1 and version_id=$2 and wedding_id=$3 and deal_id=$4',
          [f.source.id, f.version.id, rows[0]!.wedding_id, rows[0]!.deal_id])
      } },
      { label: 'heads UPDATE пропускает ревизию', substring: 'advance by one exact revision', run: (f, c2) => c2.query('update legacy_calendar_heads set revision=99 where source_id=$1', [f.source.id]) },
      { label: 'orphan-версия без цепочки до головы (отложено на COMMIT)', substring: 'orphan inventory version', deferred: true, run: (f, c2) =>
        c2.query("insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by) values($1,$2,2,$3,$4,$5,'owner_capture',$6)",
          [randomUUID(), f.source.id, f.version.id, f.version.canonical, f.version.digest, f.c.owner.userId]) },
      { label: 'первая orphan-версия при голове revision=0 (отложено на COMMIT)', substring: 'orphan inventory version', deferred: true, run: async (f, c2) => {
        const day = (await c2.query<{ id: string }>("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual') returning id", [f.c.id, freshDate()])).rows[0]!.id
        await c2.query(`insert into legacy_calendar_versions(source_id,revision,canonical,digest,capture_kind,captured_by)
          select s.id,1,m.canonical,encode(sha256(convert_to(m.canonical,'UTF8')),'hex'),'owner_capture',$2
          from legacy_calendar_sources s cross join lateral (select legacy_calendar_inventory_material(s)::text canonical) m
          where s.day_id=$1 and s.kind='manual_day'`, [day, f.c.owner.userId])
      } },
      { label: 'неполная промежуточная версия не скрывается полной следующей (COMMIT)', substring: 'inventory version holders incomplete', deferred: true, run: async (f, c2) => {
        const versionId = randomUUID()
        await c2.query(`insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by)
          values($1,$2,2,$3,$4,$5,'owner_capture',$6)`, [versionId, f.source.id, f.version.id, f.version.canonical, f.version.digest, f.c.owner.userId])
        await c2.query('update legacy_calendar_heads set revision=2,current_version_id=$2 where source_id=$1', [f.source.id, versionId])
        await c2.query('update deals set price=price+1 where id=$1', [(JSON.parse(f.version.canonical as string).holders as { dealId: string }[])[0]!.dealId])
        await c2.query("select * from legacy_calendar_append_version($1,$2,'owner_capture')", [f.source.id, f.c.owner.userId])
      } },
      { label: 'operational day: явная чужая source_revision на UPDATE', substring: 'source revision is maintained', run: (f, c2) =>
        c2.query('update vendor_busy_dates set source_revision=5 where vendor_id=$1 and date=$2::date', [f.c.id, f.w.date]) },
      { label: 'operational day: повторная вставка с идентификатором уже известного дня', substring: 'identity cannot be reused', run: (f, c2) =>
        c2.query("insert into vendor_busy_dates(id,vendor_id,date,source) values($1,$2,'2027-08-09','manual')", [f.id, f.c.id]) },
    ]
    it.each(cases)('$label', async ({ run, substring, deferred }) => {
      const f = await prepared()
      // The mutation runs on the SAME transaction client (`c2`) that the
      // assertion's outer `tx()` commits — a deferred constraint trigger is
      // checked only at THAT commit, after the extra no-op statement below,
      // never immediately after the statement that `run` issues.
      await expect(app.db!.tx(async c2 => { await run(f, c2); if (deferred) await c2.query('select 1') }))
        .rejects.toMatchObject({ code: '23514', message: expect.stringContaining(substring) })
    })
    it('итог: минимум 10 независимых отрицаний, каждое в своей транзакции', () => { expect(cases.length).toBeGreaterThanOrEqual(10) })
  })

  // ============================================================ T07 ============================================================
  describe('T07 — законный каскад свадьбы/компании, не ручное стирание', () => {
    it.each([false, true])('удаление исходной свадьбы сохраняет инвентарь переназначенного дня (foreign company=%s)', async foreignCompany => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const id = await dayId(c.id, w.date), original = (await sourceRow(c.id, 'app_day', id))!
      const originalDto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === original.id)!
      await capture(c.id, original.id as string, c.owner, originalDto.sourceRevision, originalDto.inventoryRevision)
      const nextPair = await actor(), nextCompany = foreignCompany ? await company() : c, nextWedding = await wedding(nextPair)
      const nextDeal = ok<{ deal: { id: string } }>(await book(nextPair, nextWedding, nextCompany)).deal.id
      const nextSource = (await sourceRow(nextCompany.id, 'app_day', await dayId(nextCompany.id, nextWedding.date)))!
      const nextDto = (await load(nextCompany.id, nextCompany.owner)).sources.find(s => s.sourceId === nextSource.id)!
      await capture(nextCompany.id, nextSource.id as string, nextCompany.owner, nextDto.sourceRevision, nextDto.inventoryRevision)
      const nextVersions = await versionsOf(nextSource.id as string), nextHead = await headRow(nextSource.id as string)
      await app.db!.query('update vendor_busy_dates set deal_id=$2 where id=$1', [id, nextDeal])
      const before = (await app.db!.query('select * from vendor_busy_dates where id=$1', [id])).rows[0]!
      await app.db!.query('delete from weddings where id=$1', [w.id]); weddings.delete(w.id)
      expect((await app.db!.query('select * from vendor_busy_dates where id=$1', [id])).rows[0]).toEqual(before)
      expect((await app.db!.query('select id from legacy_calendar_sources where id=$1', [original.id])).rows).toEqual([])
      expect(await versionsOf(original.id as string)).toEqual([])
      const recovered = (await sourceRow(c.id, 'app_day', id))!
      expect(recovered).toMatchObject({ wedding_id: nextWedding.id, company_id: null, vendor_id: c.id })
      expect(recovered.id).not.toBe(original.id)
      expect(await headRow(recovered.id as string)).toMatchObject({ revision: '0', current_version_id: null })
      expect(await versionsOf(recovered.id as string)).toEqual([])
      const dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === recovered.id)!
      expect(dto).toMatchObject({ state: 'unresolved', sourceRevision: before.source_revision, inventoryRevision: '0' })
      if (foreignCompany) expect(dto).toMatchObject({ scopeCompleteness: 'unknown', unavailableReason: 'mixed_scope', holderCount: 0 })
      expect(await versionsOf(nextSource.id as string)).toEqual(nextVersions)
      expect(await headRow(nextSource.id as string)).toEqual(nextHead)
    })
    it('занятая чужая свадьба при восстановлении mixed day даёт bounded отказ и сохраняет исходную транзакцию', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const id = await dayId(c.id, w.date), original = (await sourceRow(c.id, 'app_day', id))!
      const nextPair = await actor(), nextCompany = await company(), nextWedding = await wedding(nextPair)
      const nextDeal = ok<{ deal: { id: string } }>(await book(nextPair, nextWedding, nextCompany)).deal.id
      await app.db!.query('update vendor_busy_dates set deal_id=$2 where id=$1', [id, nextDeal])
      const before = (await app.db!.query('select * from vendor_busy_dates where id=$1', [id])).rows[0]!
      let release!: () => void, markPinned!: () => void
      const permission = new Promise<void>(resolve => { release = resolve })
      const pinned = new Promise<void>(resolve => { markPinned = resolve })
      const blocker = app.db!.tx(async client => {
        await client.query('select id from weddings where id=$1 for update', [nextWedding.id])
        markPinned()
        await permission
      })
      const completion = Promise.allSettled([blocker])
      try {
        await Promise.race([pinned, completion.then(([result]) => {
          if (result!.status === 'rejected') throw result!.reason
          throw new Error('Foreign wedding transaction finished before pinning its row')
        })])
        await expect(app.db!.tx(async client => {
          await client.query("set local statement_timeout='5s'")
          await client.query('delete from weddings where id=$1', [w.id])
        })).rejects.toMatchObject({ code: '55P03' })
        expect((await app.db!.query('select id from weddings where id=$1', [w.id])).rows).toHaveLength(1)
        expect(await sourceRow(c.id, 'app_day', id)).toEqual(original)
        expect((await app.db!.query('select * from vendor_busy_dates where id=$1', [id])).rows[0]).toEqual(before)
      } finally { release(); await completion }
    }, 15_000)
    it('сырой DELETE свадьбы и ручной busy той же даты завершаются без обратного замка company/day', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      ok(await book(pair, w, c))
      const id = await dayId(c.id, w.date!), before = (await app.db!.query<{ revision: string }>(
        'select source_revision::text as revision from vendor_busy_dates where id=$1', [id])).rows[0]!
      let release!: (insert: boolean) => void, manualReady!: (pid: number) => void
      const permission = new Promise<boolean>(resolve => { release = resolve })
      const pinned = new Promise<number>(resolve => { manualReady = resolve })
      // Reproduce the manual writer's company mutex before its actual busy SQL.
      // The raw cascade is deliberately not routed through purge's day cleanup.
      const manualRun = app.db!.tx(async client => {
        await client.query("select set_config('statement_timeout','9s',true), set_config('lock_timeout','8s',true)")
        const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
        await client.query('select id from users where id=$1 for share', [c.owner.userId])
        await client.query('select id from vendors where id=$1 for update', [c.id])
        manualReady(pid)
        if (!await permission) return 0
        return (await client.query(`insert into vendor_busy_dates(vendor_id,date,source)
          values($1,$2::date,'manual') on conflict(vendor_id,date) do nothing`, [c.id, w.date])).rowCount ?? 0
      })
      const pending: Promise<number>[] = [manualRun]
      const manualCompletion = Promise.allSettled([manualRun])
      try {
        const manualPid = await Promise.race([pinned, manualCompletion.then(([result]) => {
          if (result!.status === 'rejected') throw result!.reason
          throw new Error('manual transaction completed before signalling its company lock')
        })])
        let cascadeReady!: (pid: number) => void
        const cascadeStarted = new Promise<number>(resolve => { cascadeReady = resolve })
        const cascadeRun = app.db!.tx(async client => {
          await client.query("select set_config('statement_timeout','9s',true), set_config('lock_timeout','8s',true)")
          const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
          cascadeReady(pid)
          return (await client.query('delete from weddings where id=$1', [w.id])).rowCount ?? 0
        })
        pending.push(cascadeRun)
        // Attach both settlements before observing the wait: an early SQL
        // failure must be reported here, without an unhandled rejection.
        const completion = Promise.allSettled(pending), cascadeCompletion = Promise.allSettled([cascadeRun])
        const cascadePid = await Promise.race([cascadeStarted, cascadeCompletion.then(([result]) => {
          if (result!.status === 'rejected') throw result!.reason
          throw new Error('raw cascade completed before signalling its backend')
        })])
        const witness = await blockedBy(manualPid, 1, 'raw wedding cascade waits for manual company mutex')
        expect(witness.filter(row => row.pid === cascadePid).map(row => row.query))
          .toEqual(['delete from weddings where id=$1'])
        release(true)
        const settled = await completion
        const rejected = settled.filter(result => result.status === 'rejected').map(result => {
          const error = result.reason as { code?: string; message?: string }
          return { code: error?.code, message: error?.message }
        })
        process.stdout.write(`LEGACY_CALENDAR_RAW_CASCADE_MANUAL_RACE ${JSON.stringify({ manualPid, cascadePid, rejected })}\n`)
        expect(rejected.map(error => error.code), 'the company/day race must not be resolved by PostgreSQL deadlock victim selection')
          .not.toContain('40P01')
        expect(rejected, 'both actual transactions must commit').toEqual([])
        expect(settled.map(result => result.status === 'fulfilled' ? result.value : null)).toEqual([0, 1])
        expect((await app.db!.query('select 1 from weddings where id=$1', [w.id])).rowCount).toBe(0)
        const day = (await app.db!.query<{ id: string; deal_id: string | null; source: string; revision: string }>(
          'select id,deal_id,source,source_revision::text as revision from vendor_busy_dates where id=$1', [id])).rows[0]!
        expect(day).toEqual({ id, deal_id: null, source: 'deal', revision: (BigInt(before.revision) + 1n).toString() })
        expect(await sourceRow(c.id, 'orphan_day', id)).toMatchObject({ company_id: c.id, wedding_id: null })
        weddings.delete(w.id)
      } finally {
        // A failed witness releases the company without issuing INSERT; both
        // clients finish/rollback before teardown touches their fixture rows.
        release(false)
        await Promise.allSettled(pending)
      }
    }, 30_000)
    it('purgeArchivedWeddings удаляет только app-историю своей свадьбы; manual/orphan и чужие свадьбы целы', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const daySource = await sourceRow(c.id, 'app_day', await dayId(c.id, w.date))
      await manual(c.owner, ['2027-08-12'], 'busy')
      const manualSource = await sourceRow(c.id, 'manual_day', await dayId(c.id, '2027-08-12'))
      const otherPair = await actor(), otherWedding = await wedding(otherPair)
      await book(otherPair, otherWedding, c, randomUUID(), otherWedding.slot)
      const otherSource = await sourceRow(c.id, 'app_day', await dayId(c.id, otherWedding.date!))
      await app.db!.query("update weddings set cancelled_at=now()-interval '400 days',archived_at=now()-interval '399 days' where id=$1", [w.id])
      expect((await app.db!.query<{ n: number }>(`select count(*)::int n from weddings where cancelled_at is not null and archived_at<now()-interval '365 days' and id<>$1`, [w.id])).rows[0]!.n).toBe(0)
      const fakeApp = { db: app.db, appConfig: { weddingArchiveDays: 365 }, log: { error: () => undefined } } as unknown as FastifyInstance
      expect(await purgeArchivedWeddings(fakeApp)).toBeGreaterThanOrEqual(1)
      expect((await app.db!.query('select 1 from legacy_calendar_sources where id=$1', [daySource!.id])).rowCount).toBe(0)
      expect((await app.db!.query('select 1 from legacy_calendar_sources where id=$1', [manualSource!.id])).rowCount).toBe(1)
      expect((await app.db!.query('select 1 from legacy_calendar_sources where id=$1', [otherSource!.id])).rowCount).toBe(1)
      weddings.delete(w.id)
    })
    it('eraseUser безнаследного владельца каскадирует тем же образом', async () => {
      const pair = await actor(), c = await company(pair), w = await wedding(pair)
      await book(pair, w, c)
      const daySource = await sourceRow(c.id, 'app_day', await dayId(c.id, w.date))
      await app.db!.tx(x => eraseUser(x, pair.userId))
      expect((await app.db!.query('select 1 from legacy_calendar_sources where id=$1', [daySource!.id])).rowCount).toBe(0)
      users.delete(pair.userId); weddings.delete(w.id)
    })
    it('прямой DELETE инвентаря при живой свадьбе отказывает 23514 (не ручное стирание)', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      await book(pair, w, c)
      const source = await sourceRow(c.id, 'app_day', await dayId(c.id, w.date))
      await expect(app.db!.query('delete from legacy_calendar_sources where id=$1', [source!.id])).rejects.toMatchObject({ code: '23514' })
    })
  })

  // ============================================================ T08 ============================================================
  describe('T08 — деньги/байты неизменны; нет нового free', () => {
    it('захват не меняет deals/payments/vendor_busy_dates/легаси-занятость, границу, политику и каталожный конфликт', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      const deal = ok<{ deal: { id: string } }>(await book(pair, w, c)).deal.id
      await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',1000,'recorded','cash','private')", [randomUUID(), deal])
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const policyBefore = await app.db!.tx(x => getAvailabilityPolicy(x, { vendorId: c.id, actor: principal(c.owner) }))
      const dealsBefore = (await app.db!.query('select * from deals where id=$1', [deal])).rows
      const paymentsBefore = (await app.db!.query('select * from payments where deal_id=$1 order by id', [deal])).rows
      const daysBefore = (await app.db!.query('select * from vendor_busy_dates where vendor_id=$1 order by date', [c.id])).rows
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === source!.id)!
      await capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      expect((await app.db!.query('select * from deals where id=$1', [deal])).rows).toEqual(dealsBefore)
      expect((await app.db!.query('select * from payments where deal_id=$1 order by id', [deal])).rows).toEqual(paymentsBefore)
      expect((await app.db!.query('select * from vendor_busy_dates where vendor_id=$1 order by date', [c.id])).rows).toEqual(daysBefore)
      const policyAfter = await app.db!.tx(x => getAvailabilityPolicy(x, { vendorId: c.id, actor: principal(c.owner) }))
      expect(policyAfter).toEqual(policyBefore)
      await expect(app.db!.tx(x => assertLegacyDateBookingAllowed(x, c.id))).resolves.toBeUndefined()
      const foreignPair = await actor(), foreignWedding = await wedding(foreignPair, w.date)
      const conflict = await book(foreignPair, foreignWedding, c)
      httpError(conflict, 'date_taken', 409)
    })
  })

  // ============================================================ T09 ============================================================
  describe('T09 — идемпотентный захват: без изменений no-op, после изменения — rev+1 с previous', () => {
    it('повторный захват без изменений не растит ревизию и не пишет audit; после смены состояния — ревизия+1 со ссылкой на предыдущую', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [deal])
      const source = await sourceRow(c.id, 'app_root', deal)
      const v1 = await load(c.id, c.owner), d1 = v1.sources.find(s => s.sourceId === source!.id)!
      const first = await capture(c.id, source!.id as string, c.owner, d1.sourceRevision, d1.inventoryRevision)
      const auditBefore = (await app.db!.query("select count(*)::int n from audit_log where action='legacy_calendar.captured'")).rows[0]!.n
      const repeat = await capture(c.id, source!.id as string, c.owner, first.sourceRevision, first.inventoryRevision)
      expect(repeat.currentInventoryVersionId).toBe(first.currentInventoryVersionId); expect(repeat.inventoryRevision).toBe(first.inventoryRevision)
      expect(await versionsOf(source!.id as string)).toHaveLength(1)
      expect((await app.db!.query("select count(*)::int n from audit_log where action='legacy_calendar.captured'")).rows[0]!.n).toBe(auditBefore)
      await app.db!.query("update deals set state='paid_deposit' where id=$1", [deal])
      const v2 = await load(c.id, c.owner), d2 = v2.sources.find(s => s.sourceId === source!.id)!
      expect(d2.freshness).toBe('stale')
      const second = await capture(c.id, source!.id as string, c.owner, d2.sourceRevision, d2.inventoryRevision)
      expect(second.inventoryRevision).toBe((BigInt(first.inventoryRevision) + 1n).toString())
      const versions = await versionsOf(source!.id as string); expect(versions).toHaveLength(2)
      expect(versions[1]!.previous_version_id).toBe(versions[0]!.id)
      expect((await app.db!.query("select count(*)::int n from audit_log where action='legacy_calendar.captured'")).rows[0]!.n).toBe(auditBefore + 1)
    })
  })

  // ============================================================ T10 ============================================================
  describe('T10 — чтение и права', () => {
    it('load ничего не пишет; классифицирует current → stale → unavailable', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [deal])
      const source = await sourceRow(c.id, 'app_root', deal)
      const before = (await app.db!.query('select * from legacy_calendar_sources where id=$1', [source!.id])).rows
      let dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)!
      expect(dto.freshness).toBe('stale') // never captured yet
      expect((await app.db!.query('select * from legacy_calendar_sources where id=$1', [source!.id])).rows).toEqual(before)
      const captured = await capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)!
      expect(dto.freshness).toBe('current'); expect(dto.currentInventoryVersionId).toBe(captured.currentInventoryVersionId)
      await app.db!.query("update deals set state='done',done_at=now() where id=$1", [deal])
      dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)!
      expect(dto.freshness).toBe('stale')
      await cancelSlot(pair, { ...w, slot: w.slot }).catch(() => undefined)
      await app.db!.query("update deals set state='cancelled',cancelled_at=now() where id=$1", [deal])
      dto = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)!
      expect(dto.freshness).toBe('unavailable')
    })
    it('resource_manager чужого штата и владелец другой компании получают 403; blocked → 404, erased → 401', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [deal])
      const source = await sourceRow(c.id, 'app_root', deal)
      const staffer = await actor()
      const invitation = await app.db!.tx(x => inviteStaff(x, { vendorId: c.id, actor: principal(c.owner), role: 'resource_manager', targetUserId: staffer.userId }))
      await app.db!.tx(x => acceptStaffInvite(x, { token: invitation.token!, actor: principal(staffer) }))
      await expectDomainError(load(c.id, staffer), 'forbidden', 403)
      const otherOwnerCompany = await company()
      await expectDomainError(load(c.id, otherOwnerCompany.owner), 'forbidden', 403)
      await app.db!.query('update vendors set blocked_at=now() where id=$1', [c.id])
      await expectDomainError(load(c.id, c.owner), 'not_found', 404)
      await app.db!.query('update vendors set blocked_at=null where id=$1', [c.id])
      await app.db!.query('update users set deleted_at=now() where id=$1', [c.owner.userId])
      await expectDomainError(load(c.id, c.owner), 'unauthorized', 401)
      void source
    })
    it.each([
      { label: 'лишний ключ', vendorId: '', sourceId: '', extra: { bogus: 'x' } },
      { label: 'не-UUID vendorId', vendorId: 'not-a-uuid', sourceId: '', extra: {} },
      { label: "ведущий ноль '01'", vendorId: '', sourceId: '', revision: '01' },
      { label: "отрицательная '-1'", vendorId: '', sourceId: '', revision: '-1' },
      { label: 'переполнение int8', vendorId: '', sourceId: '', revision: '9223372036854775808' },
    ])('422 validation_failed: $label', async ({ vendorId, sourceId, extra, revision }) => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [deal])
      const source = await sourceRow(c.id, 'app_root', deal)
      const before = (await app.db!.query('select * from legacy_calendar_sources where id=$1', [source!.id])).rows
      const input = {
        vendorId: vendorId || c.id, actor: principal(c.owner), sourceId: sourceId || (source!.id as string),
        expectedSourceRevision: revision ?? '0', expectedInventoryRevision: revision ?? '0', ...(extra ?? {}),
      }
      await expectDomainError(app.db!.tx(x => captureLegacyCalendarSource(x, input as never)), 'validation_failed', 422)
      expect((await app.db!.query('select * from legacy_calendar_sources where id=$1', [source!.id])).rows).toEqual(before)
    })
  })

  // ============================================================ T11 ============================================================
  describe('T11 — полнота: present = дни ∪ COMMITTED-корни без книги ∪ живые мягкие брони', () => {
    it('независимый SQL по условиям legacyBoundary совпадает с источниками, которые load считает не-unavailable', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair)
      // Арбитраж драйвера: legacyBoundary (commitments.ts) не бронирует ресурсы компании с прежними
      // обязательствами, а после брони ресурсов assertLegacyDateBookingAllowed не пускает бронь даты —
      // настоящими писателями эту смесь не собрать. Поэтому корень с книгой первым, прежние обязательства —
      // сырым SQL, как историческая выгрузка (обнаружение — триггерами БД и на сыром SQL, D3).
      const ledgered = await ledger(w, c, pair); await app.db!.query("update deals set state='booked' where id=$1", [ledgered]) // committed root WITH ledger -> never discovered
      const ledgerless = await rawDeal(w, c, 'contacted'); await app.db!.query("update deals set state='booked' where id=$1", [ledgerless]) // committed root w/o ledger -> present
      await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2::date,'deal',$3)", [c.id, w.date, ledgerless]) // day row -> present
      const negotiating = await rawDeal(w, c, 'contacted'); await app.db!.query("update deals set state='negotiating',negotiating_until=now()+interval '1 hour' where id=$1", [negotiating]) // live -> present
      const lapsed = await rawDeal(w, c, 'contacted'); await app.db!.query("update deals set state='negotiating',negotiating_until=now()-interval '1 hour' where id=$1", [lapsed]) // lapsed -> NOT present
      const independent = (await app.db!.query<{ n: number }>(`select
        (select count(*)::int from vendor_busy_dates where vendor_id=$1) +
        (select count(*)::int from deals d where d.vendor_id=$1 and d.state in ('booked','paid_deposit','done')
          and not exists(select 1 from deal_resource_commitments c where c.deal_id=d.id and c.revision>0)) +
        (select count(*)::int from deals d join weddings w on w.id=d.wedding_id where d.vendor_id=$1 and d.state='negotiating'
          and d.negotiating_until>clock_timestamp() and w.archived_at is null and w.cancelled_at is null) as n`, [c.id])).rows[0]!.n
      const view = await load(c.id, c.owner)
      const present = view.sources.filter(s => s.freshness !== 'unavailable')
      expect(present.length).toBe(independent)
      expect(view.sources.find(s => s.kind === 'app_root' && s.sourceId)).toBeTruthy()
      // Контракт (модель п. 6, T02): корень с головой брони revision>0 не обнаруживается вовсе.
      expect(await sourceRow(c.id, 'app_root', ledgered)).toBeUndefined()
      const lapsedSource = await sourceRow(c.id, 'live_negotiation', lapsed)
      expect(view.sources.find(s => s.sourceId === lapsedSource!.id)!.freshness).toBe('unavailable')
      void negotiating
    })
  })

  // ============================================================ T12 ============================================================
  describe('T12 — кодировка: независимость от сессии, digest = SHA-256 узла, числа строками', () => {
    it('digest версии равен SHA-256(canonical), посчитанному в Node', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [deal])
      const source = await sourceRow(c.id, 'app_root', deal)
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === source!.id)!
      await capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      const version = (await versionsOf(source!.id as string))[0]!
      expect(version.digest).toBe(sha256hex(version.canonical as string))
      const parsed = JSON.parse(version.canonical as string) as Record<string, unknown>
      expect(parsed.encoding).toBe('legacy-calendar-inventory/1')
      // Контракт D5: канон = jsonb::text PostgreSQL (с пробелами), не компактный JSON.stringify.
      expect((await app.db!.query<{ t: string }>('select $1::jsonb::text t', [version.canonical])).rows[0]!.t).toBe(version.canonical)
    })
    it('повторный захват под другими TimeZone/DateStyle сессии остаётся no-op — байты материала не зависят от настроек сессии', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair, null), deal = await rawDeal(w, c, 'contacted')
      await app.db!.query("update deals set state='booked' where id=$1", [deal])
      const source = await sourceRow(c.id, 'app_root', deal)
      const d0 = (await load(c.id, c.owner)).sources.find(s => s.sourceId === source!.id)!
      const first = await capture(c.id, source!.id as string, c.owner, d0.sourceRevision, d0.inventoryRevision)
      const underSettings = async (timeZone: string, dateStyle: string) => app.db!.tx(async x => {
        await x.query(`set local TimeZone='${timeZone}'`); await x.query(`set local DateStyle='${dateStyle}'`)
        return captureLegacyCalendarSource(x, { vendorId: c.id, actor: principal(c.owner), sourceId: source!.id as string,
          expectedSourceRevision: first.sourceRevision, expectedInventoryRevision: first.inventoryRevision })
      })
      const underUtc = await underSettings('UTC', 'ISO, YMD')
      const underOther = await underSettings('America/New_York', 'Postgres, MDY')
      expect(underUtc.currentInventoryVersionId).toBe(first.currentInventoryVersionId)
      expect(underOther.currentInventoryVersionId).toBe(first.currentInventoryVersionId)
      expect(await versionsOf(source!.id as string)).toHaveLength(1)
    })
    it('деньги/ревизии/версии в материале закодированы строками', async () => {
      const pair = await actor(), c = await company(), w = await wedding(pair), s2 = await secondSlot(w)
      await book(pair, w, c); await book(pair, w, c, randomUUID(), s2)
      const id = await dayId(c.id, w.date), source = await sourceRow(c.id, 'app_day', id)
      const view = await load(c.id, c.owner), dto = view.sources.find(s => s.sourceId === source!.id)!
      await capture(c.id, source!.id as string, c.owner, dto.sourceRevision, dto.inventoryRevision)
      const version = (await versionsOf(source!.id as string))[0]!
      const parsed = JSON.parse(version.canonical as string) as { holders: { commitmentRevision: unknown; economics: { price: unknown } }[] }
      for (const holder of parsed.holders) { expect(holder.commitmentRevision).toBeTypeOf('string'); expect(holder.economics.price).toBeTypeOf('string') }
    })
  })
})
