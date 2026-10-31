import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import { disposablePgPort } from './disposablePgPort.js'

// T009 inventory2 activation acceptance (contract c-t009-inventory2-activation-contract.md):
// public book activates the /2 material dispatcher; the owner captures it through the public
// door; old /1 bytes stay immutable. Deal writers never write inventory (370/D4).
const DATABASE = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'inventory2-activation-independent-native-'.repeat(2)
const DATE = '2027-06-14', TZ = 'Europe/Moscow'

interface VersionRow { id: string; revision: string; previous_version_id: string | null; canonical: string
  digest: string; capture_kind: string; captured_by: string | null }
interface SourceRow { id: string; kind: string; day_id: string | null; root_deal_id: string | null }

describe.sequential('T009 inventory2 activation acceptance', () => {
  let app: FastifyInstance | undefined
  const users = new Set<string>(), weddings = new Set<string>(), vendors = new Set<string>(), slots = new Set<string>()
  const db = () => { assert(app?.db); return app.db }

  beforeAll(async () => {
    assert(DATABASE, 'Explicit TEST_DATABASE_URL is required; no silent native skip')
    assert.equal(process.env.DATABASE_URL, DATABASE)
    const url = new URL(DATABASE)
    assert(['postgres:', 'postgresql:'].includes(url.protocol)); assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.port, '15432'); assert.equal(disposablePgPort(), '15432'); assert.equal(url.username, 'codex_test')
    assert(['/tili_day_atomic_20261021_test', '/tili_ecosystem_full_20260930_test'].includes(url.pathname))
    assert.equal(url.search, ''); assert.equal(url.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DATABASE, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'inventory2-synthetic-refresh-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const identity = (await db().query<{ name: string; role: string; owner: string; address: string; port: number }>(`select
      current_database() name,current_user role,(select pg_get_userbyid(datdba) from pg_database where datname=current_database()) owner,
      host(inet_server_addr()) address,inet_server_port() port`)).rows[0]!
    assert.equal(identity.name, url.pathname.slice(1)); assert.equal(identity.role, 'codex_test')
    assert.equal(identity.owner, 'codex_test'); assert.equal(identity.address, '127.0.0.1'); assert.equal(identity.port, 15432)
    const journal = (await db().query<{ name: string }>('select name from pgmigrations order by name')).rows.map(r => r.name)
    assert(journal.includes('1763850000000_deal_day_scope_foundation'), 'day-scope foundation required')
    assert(journal.includes('1763860000000_deal_day_scope_undated_terminal'), 'undated terminal required')
    assert(journal.includes('1763870000000_deal_day_scope_atomic'), 'atomic /2 material builder required')
  })

  afterAll(async () => {
    if (!app) return
    try {
      for (const id of weddings) await db().query('delete from weddings where id=$1', [id])
      for (const id of vendors) await db().query('delete from vendors where id=$1', [id])
      for (const id of users) await db().query('delete from users where id=$1', [id])
      expect((await db().query('select id from vendor_busy_dates where vendor_id=any($1::uuid[])', [[...vendors]])).rows).toEqual([])
      expect((await db().query('select id from legacy_calendar_sources where vendor_id=any($1::uuid[])', [[...vendors]])).rows).toEqual([])
      expect((await db().query('select id from deals where wedding_id=any($1::uuid[])', [[...weddings]])).rows).toEqual([])
    } finally { await app.close() }
  })

  async function actor(name: string) {
    const id = randomUUID(), sid = randomUUID(); let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) inserted = (await db().query(
      `insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id`,
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`, name])).rowCount === 1
    assert(inserted); users.add(id)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, sid, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  const idem = (a: Actor, key = randomUUID()) => ({ ...auth(a), 'idempotency-key': key })

  async function fixture() {
    const pair = await actor('Synthetic inventory2 pair'), company = await actor('Synthetic inventory2 company')
    const weddingId = randomUUID(), vendorId = randomUUID(), slotId = randomUUID()
    weddings.add(weddingId); vendors.add(vendorId); slots.add(slotId)
    await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic inventory2 company',now())", [vendorId, company.id])
    await db().query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic inventory2 main',$3,$4,$5)",
      [weddingId, pair.id, DATE, TZ, randomUUID()])
    await db().query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, pair.id])
    const main = (await db().query<{ id: string; date: string | null; time_zone: string | null }>(
      'select id,date::text,time_zone from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows
    assert.equal(main.length, 1); assert.equal(main[0]!.date, DATE); assert.equal(main[0]!.time_zone, TZ)
    await db().query("insert into slots(id,wedding_id,category_id,label,program_event_id) values($1,$2,'photo','Synthetic inventory2 position',null)", [slotId, weddingId])
    return { pair, company, weddingId, vendorId, slotId, eventId: main[0]!.id }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  const call = (a: Actor, options: { method: 'POST' | 'GET'; url: string; headers: Record<string, string>; payload?: Record<string, unknown> }) => {
    assert(app); return app.inject(options)
  }
  async function book(f: Fixture) {
    const r = await call(f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/book`,
      headers: idem(f.pair), payload: { vendorId: f.vendorId, price: { amount: 17000, currency: 'RUB' } } })
    expect(r.statusCode, r.body).toBe(200)
    const dealId = (await db().query<{ deal_id: string }>('select deal_id::text from slots where id=$1', [f.slotId])).rows[0]!.deal_id
    return dealId
  }
  async function source(f: Fixture, kind: 'app_day' | 'app_root'): Promise<SourceRow> {
    const rows = (await db().query<SourceRow>(`select id::text,kind,day_id::text,root_deal_id::text from legacy_calendar_sources
      where vendor_id=$1 and wedding_id=$2 and kind=$3 order by id`, [f.vendorId, f.weddingId, kind])).rows
    expect(rows).toHaveLength(1); return rows[0]!
  }
  const versions = (client: Queryable, sourceId: string) => client.query<VersionRow>(`select id::text,revision::text,
    previous_version_id::text,canonical,digest,capture_kind,captured_by::text from legacy_calendar_versions
    where source_id=$1 order by revision`, [sourceId]).then(r => r.rows)
  async function capture(f: Fixture, sourceId: string, sourceRevision: string, inventoryRevision: string, key = randomUUID(), as: Actor = f.company) {
    return call(as, { method: 'POST', url: `/vendors/${f.vendorId}/legacy-calendar/sources/${sourceId}/capture`,
      headers: idem(as, key), payload: { expectedSourceRevision: sourceRevision, expectedInventoryRevision: inventoryRevision } })
  }
  const sourceRevision = (f: Fixture, s: SourceRow) => s.day_id
    ? db().query<{ revision: string }>('select source_revision::text revision from vendor_busy_dates where id=$1', [s.day_id]).then(r => r.rows[0]?.revision ?? '0')
    : Promise.resolve('0')
  const headRevision = (s: SourceRow) => db().query<{ revision: string; current: string | null }>(
    'select revision::text,current_version_id::text current from legacy_calendar_heads where source_id=$1', [s.id]).then(r => r.rows[0]!)

  it('A2-01 public book activates /2 and owner capture stores the exact version', async () => {
    const f = await fixture(), dealId = await book(f), s = await source(f, 'app_day')
    const head = await headRevision(s); expect(head).toEqual({ revision: '0', current: null })
    const sr = await sourceRevision(f, s); expect(sr).toBe('1')
    const first = await capture(f, s.id, sr, '0')
    expect(first.statusCode, first.body).toBe(200)

    const all = await versions(db(), s.id); expect(all).toHaveLength(1)
    const v = all[0]!
    expect(v.revision).toBe('1'); expect(v.previous_version_id).toBeNull()
    expect(v.capture_kind).toBe('owner_capture'); expect(v.captured_by).toBe(f.company.id)
    const digestOk = await db().query<{ ok: boolean }>(
      "select digest=encode(sha256(convert_to(canonical,'UTF8')),'hex') ok from legacy_calendar_versions where id=$1", [v.id])
    expect(digestOk.rows[0]!.ok).toBe(true)
    const canon = JSON.parse(v.canonical) as Record<string, unknown>
    expect(canon.encoding).toBe('legacy-calendar-inventory/2')
    expect(canon.kind).toBe('app_day'); expect(canon.vendorId).toBe(f.vendorId); expect(canon.sourceId).toBe(s.id)
    const scopes = canon.dayScopes as Record<string, unknown>[]; expect(scopes).toHaveLength(1)
    const scope = scopes[0]!
    expect(Object.keys(scope).sort()).toEqual(['dayId', 'vendorId', 'date', 'weddingId', 'classification',
      'groupRevision', 'legacyCandidates', 'opaque', 'knownHolders', 'day'].sort())
    expect(scope).toMatchObject({ dayId: s.day_id, vendorId: f.vendorId, date: DATE, weddingId: f.weddingId, opaque: false })
    const holders = scope.knownHolders as { head: Record<string, unknown>; version: Record<string, unknown> }[]
    expect(holders).toHaveLength(1)
    expect(Object.keys(holders[0]!.head).sort()).toEqual(['weddingId', 'dealId', 'revision', 'currentVersionId'].sort())
    expect(Object.keys(holders[0]!.version).sort()).toEqual(['id', 'weddingId', 'dealId', 'slotId', 'schemaVersion', 'revision',
      'previousVersionId', 'originKnowledge', 'operation', 'recordedAt', 'contextKind', 'eventId', 'performerKind',
      'vendorId', 'bindingState', 'serviceDate', 'timeZone', 'dayId'].sort())
    expect(holders[0]!.version).toMatchObject({ weddingId: f.weddingId, dealId, slotId: f.slotId, operation: 'acquire',
      performerKind: 'catalog', vendorId: f.vendorId, bindingState: 'active', serviceDate: DATE, timeZone: TZ, dayId: s.day_id })
    const stored = await db().query<{ fingerprint_ok: boolean; wedding_id: string; deal_id: string }>(
      `select fingerprint=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') fingerprint_ok,wedding_id::text,deal_id::text
       from legacy_calendar_version_holders where source_id=$1 and version_id=$2`, [s.id, v.id])
    expect(stored.rows).toHaveLength(1)
    expect(stored.rows[0]!.fingerprint_ok).toBe(true)
    expect(stored.rows[0]).toMatchObject({ wedding_id: f.weddingId, deal_id: dealId })
    expect((await headRevision(s)).current).toBe(v.id)
  })

  it('A2-02 repeat capture without material change is a no-op; stale revision 409 recovers after reread', async () => {
    const f = await fixture(); await book(f); const s = await source(f, 'app_day')
    const sr = await sourceRevision(f, s)
    expect((await capture(f, s.id, sr, '0')).statusCode).toBe(200)
    const repeat = await capture(f, s.id, sr, '1')
    expect(repeat.statusCode, repeat.body).toBe(200)
    expect(await versions(db(), s.id)).toHaveLength(1)
    expect((await headRevision(s)).revision).toBe('1')

    const stale = await capture(f, s.id, sr, '0')
    expect(stale.statusCode, stale.body).toBe(409)
    expect(JSON.parse(stale.body).error).toMatchObject({ code: 'legacy_inventory_version_conflict' })
    expect(await versions(db(), s.id)).toHaveLength(1)
    const recovered = await capture(f, s.id, sr, (await headRevision(s)).revision)
    expect(recovered.statusCode, recovered.body).toBe(200)
    expect(await versions(db(), s.id)).toHaveLength(1)
  })

  it('A2-03 same idempotency key replays the stored reply; same key with another body refuses', async () => {
    const f = await fixture(); await book(f); const s = await source(f, 'app_day')
    const sr = await sourceRevision(f, s), key = randomUUID()
    const first = await capture(f, s.id, sr, '0', key)
    expect(first.statusCode, first.body).toBe(200)
    const replay = await capture(f, s.id, sr, '0', key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(JSON.parse(replay.body)).toEqual(JSON.parse(first.body))
    const reused = await capture(f, s.id, sr, '1', key)
    expect(reused.statusCode, reused.body).toBe(409)
    expect(JSON.parse(reused.body).error).toMatchObject({ code: 'idempotency_key_reused' })
    expect(await versions(db(), s.id)).toHaveLength(1)
  })

  it('A2-04 ACL: owner list 403 for non-owners, capture door opaque 404; holder read stays 200', async () => {
    const f = await fixture(), dealId = await book(f), s = await source(f, 'app_day')
    const sr = await sourceRevision(f, s)
    const foreign = await actor('Synthetic inventory2 foreign owner')
    const foreignVendor = randomUUID(); vendors.add(foreignVendor)
    await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic foreign company',now())", [foreignVendor, foreign.id])

    const pairRead = await call(f.pair, { method: 'GET', url: `/vendors/${f.vendorId}/legacy-calendar/sources`, headers: auth(f.pair) })
    expect(pairRead.statusCode, pairRead.body).toBe(403)
    expect(JSON.parse(pairRead.body).error).toMatchObject({ code: 'forbidden' })
    const pairCapture = await capture(f, s.id, sr, '0', randomUUID(), f.pair)
    expect(pairCapture.statusCode, pairCapture.body).toBe(404)
    expect(JSON.parse(pairCapture.body).error).toMatchObject({ code: 'not_found' })
    const foreignRead = await call(foreign, { method: 'GET', url: `/vendors/${f.vendorId}/legacy-calendar/sources`, headers: auth(foreign) })
    expect(foreignRead.statusCode, foreignRead.body).toBe(403)
    const foreignCapture = await capture(f, s.id, sr, '0', randomUUID(), foreign)
    expect(foreignCapture.statusCode, foreignCapture.body).toBe(404)
    expect(JSON.parse(foreignCapture.body).error).toMatchObject({ code: 'not_found' })
    expect(await versions(db(), s.id)).toHaveLength(0)

    const holderRead = await call(f.pair, { method: 'GET', url: `/weddings/${f.weddingId}/deals/${dealId}/legacy-calendar`, headers: auth(f.pair) })
    expect(holderRead.statusCode, holderRead.body).toBe(200)
  })

  it('A2-05 cancelled DATE makes the source unavailable; stored /2 bytes stay immutable', async () => {
    const f = await fixture(); await book(f); const s = await source(f, 'app_day')
    const sr = await sourceRevision(f, s)
    expect((await capture(f, s.id, sr, '0')).statusCode).toBe(200)
    const before = await versions(db(), s.id); expect(before).toHaveLength(1)

    const cancelled = await call(f.pair, { method: 'POST', url: `/weddings/${f.weddingId}/slots/${f.slotId}/cancel`, headers: idem(f.pair) })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect((await db().query('select id from vendor_busy_dates where id=$1', [s.day_id])).rows).toEqual([])

    const gone = await capture(f, s.id, '0', '1')
    expect(gone.statusCode, gone.body).toBe(409)
    expect(JSON.parse(gone.body).error).toMatchObject({ code: 'legacy_source_unavailable' })
    expect(await versions(db(), s.id)).toEqual(before)
    expect((await headRevision(s)).revision).toBe('1')
  })
})
