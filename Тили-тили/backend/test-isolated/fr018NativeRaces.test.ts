/** Different-author C15/C16 race regressions. Fixture/admission source reused from frozen native14; all native execution is UNRUN by author. */
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'

const TARGET = 'tili_ecosystem_fr018_20261004_test'
const DATABASE = 'postgres://codex_test@127.0.0.1:15432/' + TARGET
const MIGRATION = '1763825000000_offer_comparison_terms'
const OID = '630867'
const PIN_SHA = '87686BDBECEE3E05543A258944059F3349CA1C57F489359C340D602F554BFAEB'
const SECRET = 'synthetic-fr018-native-races'.repeat(3)
const POLICY = '2026-09-02'
const APPLICATION = 'fr018race_' + randomUUID()
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`
const FIELDS = ['hours', 'team', 'result', 'delivery', 'extras', 'cancellation', 'reschedule'] as const
type Terms = Record<(typeof FIELDS)[number], string | null>

type Actor = { id: string; token: string }
type Vendor = Actor & { vendorId: string; packageId: string; name: string }
type Fixture = { owner: Actor; wedding: string; vendor: Vendor; slot: string; entry: string; request: string }
type Row = Record<string, unknown>
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
type Pin = { path: string; sha256: string }
type SourcePins = { effective: Pin[]; data: Pin[]; oldMigrations: { name: string; sha256: string }[]; external: Pin[]; nativeFKs: Row[] }
type SourceProof = { checkout: string; head: string; files: Pin[] }
const backend = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const checkout = path.resolve(backend, '../..')
const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex').toUpperCase()
const fileHash = (file: string) => hash(readFileSync(file))
const note = (fact: object) => process.stdout.write('FR018_RACE_WITNESS ' + JSON.stringify(fact) + '\n')

describe.sequential('FR018 C15/C16 genuine rooted native races and complete selected snapshots', () => {
  let app: FastifyInstance | undefined, sourceProof: SourceProof, sourceRaw = '', pins: SourcePins, journal: string[] = []
  let initialAudits: Row[] = []
  const users: string[] = [], weddings: string[] = [], vendors: string[] = [], keys: string[] = []
  const application = () => { assert(app); return app }
  const db = () => { assert(app?.db); return app.db }
  const auth = (actor: Actor) => ({ authorization: 'Bearer ' + actor.token })
  const rows = async (sql: string, values: unknown[] = []) => (await db().query<{ row: Row }>(sql, values)).rows.map(r => r.row)

  function sourceGuard() {
    const proofPath = process.env.FR018_TEST_SOURCE_PROOF
    assert(proofPath, 'Root actual post-adoption full-source proof required')
    assert.equal(fileHash(proofPath), process.env.FR018_TEST_SOURCE_PROOF_SHA256)
    assert.match(process.env.FR018_TEST_SOURCE_HEAD ?? '', /^[a-f0-9]{40}$/)
    const raw = readFileSync(proofPath, 'utf8'), proof = JSON.parse(raw) as SourceProof
    assert.equal(proof.head, process.env.FR018_TEST_SOURCE_HEAD, 'Root-attested HEAD bound to this full-source proof')
    assert.equal(path.resolve(proof.checkout).toLowerCase(), checkout.toLowerCase())
    assert(proof.files.length >= 727); assert.equal(new Set(proof.files.map(p => p.path)).size, proof.files.length)
    const named = new Map(proof.files.map(p => [p.path, p.sha256]))
    for (const pin of proof.files) {
      assert.match(pin.sha256, /^[A-F0-9]{64}$/); assert(!pin.path.includes('\\')); assert(!path.isAbsolute(pin.path))
      const resolved = path.resolve(checkout, pin.path); assert(resolved.startsWith(checkout + path.sep)); assert(!lstatSync(resolved).isSymbolicLink())
      assert.equal(fileHash(resolved), pin.sha256, pin.path)
    }
    function enumerate(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assert(!entry.isSymbolicLink()); const full = path.join(directory, entry.name)
        if (entry.isDirectory()) enumerate(full)
        else { assert(entry.isFile()); assert(named.has(path.relative(checkout, full).replaceAll('\\', '/')), 'Root proof omits actual source file: ' + full) }
      }
    }
    for (const local of ['src', 'test', 'test-isolated', 'test-support', 'migrations', 'scripts']) enumerate(path.join(backend, local))
    enumerate(path.resolve(backend, '../app/src'))
    for (const pin of [...pins.effective, ...pins.data]) { assert.equal(fileHash(path.resolve(checkout, pin.path)), pin.sha256); assert.equal(named.get(pin.path), pin.sha256) }
    for (const pin of pins.external) assert.equal(fileHash(pin.path), pin.sha256)
    assert.deepEqual(readdirSync(path.join(backend, 'migrations')).sort(), [...pins.oldMigrations.map(r => r.name + '.cjs'), MIGRATION + '.cjs', 'data'].sort())
    for (const pin of pins.oldMigrations) assert.equal(fileHash(path.join(backend, 'migrations', pin.name + '.cjs')), pin.sha256)
    if (sourceRaw) assert.equal(raw, sourceRaw, 'Root proof must remain immutable throughout native suite')
    return { proof, raw }
  }
  async function nativeGuard() {
    const identity = (await db().query<{ name: string; username: string; port: number; address: string; oid: string; encoding: string }>(
      `select current_database() as name,current_user as username,inet_server_port() as port,host(inet_server_addr()) as address,
       (select oid::text from pg_database where datname=current_database()) as oid,current_setting('server_encoding') as encoding`,
    )).rows[0]!
    expect(identity).toEqual({ name: TARGET, username: 'codex_test', port: 15432, address: '127.0.0.1', oid: OID, encoding: 'UTF8' })
    expect((await db().query('select pid,application_name,state from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and application_name<>$1', [APPLICATION])).rows).toEqual([])
    expect((await db().query<{ name: string }>('select name from pgmigrations order by name')).rows.map(r => r.name)).toEqual(journal)
    expect((await db().query(`select t.oid::text,t.tgname,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid) as definition
      from pg_trigger t where t.tgrelid='public.idempotency_keys'::regclass order by t.tgname`)).rows).toEqual(pins.nativeFKs)
    return identity
  }
  beforeAll(async () => {
    assert.equal(process.env.TEST_DATABASE_URL, DATABASE); assert.equal(process.env.DATABASE_URL, DATABASE)
    assert.equal(process.env.FR018_TEST_DATABASE_OID, OID); assert.equal(process.env.FR018_TEST_MIGRATION_NAME, MIGRATION)
    assert.notEqual(process.env.GITHUB_ACTIONS, 'true')
    const pinFile = fileURLToPath(new URL('../test-support/fr018-native-races-pins.json', import.meta.url))
    assert.equal(fileHash(pinFile), PIN_SHA); pins = JSON.parse(readFileSync(pinFile, 'utf8')) as SourcePins
    assert.equal(pins.oldMigrations.length, 82); journal = [...pins.oldMigrations.map(p => p.name), MIGRATION].sort()
    assert.equal(journal.length, 83)
    assert.deepEqual(readdirSync(path.join(backend, 'migrations/data')).sort(), ['categories.json', 'cities.json'])
    const creationPath = process.env.FR018_TEST_CREATION_PROOF; assert(creationPath)
    const creation = JSON.parse(readFileSync(creationPath, 'utf8')) as { kind: string; targetName: string; targetURL: string; databaseOID: string; absentBeforeCreate: boolean; beforeRowCount: number; actualAdmin: { database: string; username: string; port: number; address: string } }
    assert.equal(creation.kind, 'root_actual_absent_before_create'); assert.equal(creation.absentBeforeCreate, true); assert.equal(creation.beforeRowCount, 0)
    assert.equal(creation.targetName, TARGET); assert.equal(creation.targetURL, DATABASE); assert.equal(creation.databaseOID, OID)
    assert.equal(creation.actualAdmin.database, 'postgres'); assert.equal(creation.actualAdmin.username, 'codex_test'); assert.equal(creation.actualAdmin.port, 15432); assert.equal(creation.actualAdmin.address, '127.0.0.1')
    const accepted = sourceGuard(); sourceProof = accepted.proof; sourceRaw = accepted.raw
    const url = new URL(DATABASE); url.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: url.href, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: SECRET + '-refresh', policyVersion: POLICY, rateLimitPerSecond: 0, vapidPublicKey: null, vapidPrivateKey: null }, [], { tillyModel: null })
    await app.ready(); const actual = await nativeGuard()
    const columns = (await db().query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(`select table_name,column_name,data_type,is_nullable from information_schema.columns
      where table_schema='public' and ((table_name='offers' and column_name='comparison_terms') or (table_name='deals' and column_name='offer_comparison_terms_snapshot')) order by table_name,column_name`)).rows
    expect(columns).toEqual([{ table_name: 'deals', column_name: 'offer_comparison_terms_snapshot', data_type: 'jsonb', is_nullable: 'YES' }, { table_name: 'offers', column_name: 'comparison_terms', data_type: 'jsonb', is_nullable: 'YES' }])
    const mutable = (await db().query(`select (select count(*)::int from users) as users,(select count(*)::int from sessions) as sessions,
      (select count(*)::int from consents) as consents,(select count(*)::int from notification_prefs) as prefs,
      (select count(*)::int from weddings) as weddings,(select count(*)::int from vendors) as vendors,
      (select count(*)::int from offers) as offers,(select count(*)::int from offer_requests) as requests,
      (select count(*)::int from deals) as deals,(select count(*)::int from notifications) as notices,
      (select count(*)::int from idempotency_keys) as receipts`)).rows[0]!
    expect(Object.values(mutable)).toEqual(Array(11).fill(0))
    initialAudits = await rows('select to_jsonb(a) as row from audit_log a order by id')
    assert.equal(new TextEncoder().encode(APPLICATION).length, 46, 'Native application_name below PostgreSQL63-byte bound')
    note({ event: 'root-admitted-native83-start', actual, rootAttestedHead: sourceProof.head, fullSourceProofSHA256: hash(sourceRaw), fullSourceFiles: sourceProof.files.length,
      mutable, retainedInitialAudits: await rows('select to_jsonb(a) as row from audit_log a order by id') })
  }, 30_000)

  afterAll(async () => {
    if (!app) return
    const failures: unknown[] = []
    try {
      sourceGuard(); await nativeGuard()
      const audit = await rows('select to_jsonb(a) as row from audit_log a order by id')
      for (const old of initialAudits) expect(audit.find(row => row.id === old.id)).toEqual(old)
      await db().tx(async c => {
        const ownVendors = (await c.query<{ id: string }>('select id from vendors where user_id=any($1::uuid[])', [users])).rows.map(r => r.id)
        const ownWeddings = (await c.query<{ id: string }>('select id from weddings where owner_id=any($1::uuid[])', [users])).rows.map(r => r.id)
        await c.query(`delete from vendor_busy_dates b using deals d,weddings w where b.deal_id=d.id and d.wedding_id=w.id
          and w.id=any($1::uuid[]) and w.owner_id=any($2::uuid[]) and b.vendor_id=any($3::uuid[]) and b.source='deal'`, [ownWeddings, users, ownVendors])
        await c.query('delete from weddings where id=any($1::uuid[]) and owner_id=any($2::uuid[])', [ownWeddings, users])
        await c.query('delete from idempotency_keys where user_id=any($1::uuid[])', [users])
        await c.query('delete from users where id=any($1::uuid[])', [users])
      })
      expect(await rows('select to_jsonb(a) as row from audit_log a order by id')).toEqual(audit)
      const global = (await db().query(`select (select count(*)::int from users) as users,(select count(*)::int from sessions) as sessions,
        (select count(*)::int from consents) as consents,(select count(*)::int from notification_prefs) as prefs,
        (select count(*)::int from weddings) as weddings,(select count(*)::int from vendors) as vendors,
        (select count(*)::int from offers) as offers,(select count(*)::int from offer_requests) as requests,
        (select count(*)::int from deals) as deals,(select count(*)::int from notifications) as notices,
        (select count(*)::int from idempotency_keys) as receipts,(select count(*)::int from vendor_busy_dates) as busy,
        (select count(*)::int from legacy_calendar_sources) as source`)).rows[0]!
      expect(Object.values(global)).toEqual(Array(13).fill(0)); await nativeGuard(); sourceGuard()
      note({ event: 'own-native-cleanup', users, vendors, weddings, keys, global, retainedImmutableAudits: audit, auditCountForcedZero: false })
    } catch (e) { failures.push(e) }
    finally { try { await app.close() } catch (e) { failures.push(e) } }
    if (failures.length) throw new AggregateError(failures, 'FR018 race own cleanup failed; preserve prior native case failure')
  }, 30_000)

  async function actor(): Promise<Actor> {
    const id = randomUUID(), sid = randomUUID(), cid = randomUUID()
    expect((await db().query('select id from users where id=$1', [id])).rowCount).toBe(0)
    users.push(id); note({ event: 'own-actor-before-insert', id, sid, cid })
    let inserted = false
    for (let n = 0; n < 8 && !inserted; n++) inserted = (await db().query<{ id: string }>("insert into users(id,phone,name,tz) values($1,$2,'Synthetic FR018 race actor','UTC') on conflict(phone) do nothing returning id", [id, '+79' + randomInt(100_000_000, 999_999_999)])).rows[0]?.id === id
    assert(inserted)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [cid, id, POLICY])
    await db().query("insert into notification_prefs(user_id,quiet_from,quiet_to) values($1,'00:00','00:00')", [id])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  async function vendor(): Promise<Vendor> {
    const who = await actor(), name = 'Synthetic FR018 vendor ' + randomUUID()
    const r = await call(who, 'PUT', '/vendor/profile', { name, categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' },
      portfolioUrls: ['https://example.com/fr018.jpg'], priceFrom: { amount: 8000000, currency: 'RUB' },
      packages: [{ name: 'Literal offered package', price: { amount: 10000000, currency: 'RUB' }, includes: ['Literal service A', 'Literal service B'] }] })
    expect(r.statusCode, r.body).toBe(200); const v = r.json() as { id: string; packages: { id: string }[] }; vendors.push(v.id)
    expect((await call(who, 'POST', '/vendor/profile/publish')).statusCode).toBe(200)
    return { ...who, vendorId: v.id, packageId: v.packages[0]!.id, name }
  }
  async function call(who: Actor, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, key?: string): Promise<Response> {
    if (key && !keys.includes(key)) keys.push(key)
    const response = await application().inject({ method, url, headers: { ...auth(who), ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload }) })
    note({ event: 'registered-response', user: who.id, method, url, key: key ?? null, status: response.statusCode, body: response.body, replay: response.headers['idempotent-replay'] ?? null })
    return response
  }
  async function fixture(date: string | null = DATE): Promise<Fixture> {
    const owner = await actor(), v = await vendor()
    const w = await call(owner, 'POST', '/weddings', { partnerName: 'Synthetic partner', ...(date ? { date } : {}), city: { name: 'Уфа', region: 'Башкортостан' }, guestsPlanned: 88 })
    expect(w.statusCode, w.body).toBe(201); const wedding = w.json().id as string; weddings.push(wedding)
    const s = await call(owner, 'PUT', `/weddings/${wedding}/shortlist/${v.vendorId}`)
    expect(s.statusCode, s.body).toBe(200); const { id: entry, slotId: slot } = s.json() as { id: string; slotId: string }
    const r = await call(owner, 'POST', `/weddings/${wedding}/slots/${slot}/offer-requests`, { entryIds: [entry] }, randomUUID())
    expect(r.statusCode, r.body).toBe(201); const request = r.json().results[0].requestId as string
    return { owner, wedding, vendor: v, slot, entry, request }
  }
  async function member(f: Fixture, role: 'couple' | 'helper' | 'coordinator') {
    const who = await actor()
    const invited = await call(f.owner, 'POST', `/weddings/${f.wedding}/invites`, { role, label: 'Synthetic FR018 ' + role })
    expect(invited.statusCode, invited.body).toBe(201)
    const joined = await call(who, 'POST', `/invites/${invited.json().code as string}/accept`)
    expect(joined.statusCode, joined.body).toBe(200); return who
  }
  async function slotDeal(f: Fixture, who = f.owner): Promise<{ response: Response; deal: Row }> {
    const r = await call(who, 'GET', `/weddings/${f.wedding}/slots`); expect(r.statusCode, r.body).toBe(200)
    return { response: r, deal: (r.json() as { id: string; deal: Row }[]).find(s => s.id === f.slot)!.deal }
  }
  type WaitRow = { pid: number; datname: string; application_name: string; state: string; wait_event_type: string; wait_event: string; query: string; blockers: number[] }
  const ROOT_QUERY = 'select id from weddings where id=$1 for update'
  const normalizeQuery = (query: string) => query.replace(/\s+/g, ' ').trim().toLowerCase()
  function admissibleWaitGraph(observed: WaitRow[], holder: number, firstPID: number | null, count: 1 | 2, requirePeerChain: boolean): boolean {
    if (!Number.isInteger(holder) || holder <= 0 || observed.length !== count || new Set(observed.map(row => row.pid)).size !== count) return false
    if (!observed.every(row => Number.isInteger(row.pid) && row.pid > 0 && row.pid !== holder && row.datname === TARGET && row.application_name === APPLICATION
      && row.state === 'active' && row.wait_event_type === 'Lock' && ['tuple', 'transactionid'].includes(row.wait_event)
      && normalizeQuery(row.query) === ROOT_QUERY && Array.isArray(row.blockers) && row.blockers.length === 1
      && Number.isInteger(row.blockers[0]) && row.blockers[0]! > 0 && row.blockers[0] !== row.pid)) return false
    if (count === 1) return (firstPID === null || observed[0]!.pid === firstPID) && observed[0]!.blockers[0] === holder
    if (firstPID === null) return false
    const first = observed.find(row => row.pid === firstPID), second = observed.find(row => row.pid !== firstPID)
    if (!first || !second || first.blockers[0] !== holder) return false
    if (requirePeerChain) return first.wait_event === 'transactionid' && second.wait_event === 'tuple' && second.blockers[0] === firstPID
    return second.blockers[0] === holder || second.blockers[0] === firstPID
  }
  async function observeWait(client: Queryable, holder: number, firstPID: number | null, count: 1 | 2, requirePeerChain: boolean): Promise<WaitRow[]> {
    const deadline = Date.now() + 5_000
    const samples: { observedAt: string; rows: WaitRow[] }[] = []
    for (;;) {
      await client.query('select pg_stat_clear_snapshot()')
      const observed = (await client.query<WaitRow>(`select pid,datname,application_name,state,wait_event_type,wait_event,query,
        pg_blocking_pids(pid) as blockers from pg_stat_activity
        where datname=current_database() and application_name=$1 and pid<>$2 and wait_event_type='Lock' order by pid`, [APPLICATION, holder])).rows
      samples.push({ observedAt: new Date().toISOString(), rows: observed })
      if (admissibleWaitGraph(observed, holder, firstPID, count, requirePeerChain)) {
        note({ event: 'actual-native-rooted-wait', controllerPID: holder, firstPID, count, requirePeerChain, database: TARGET, application: APPLICATION, samples })
        return observed
      }
      if (Date.now() >= deadline) {
        note({ event: 'actual-native-rooted-wait-refusal', controllerPID: holder, firstPID, count, requirePeerChain, samples })
        throw Error('No admissible actual owned native wedding-lock graph before release')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  async function heldRace(f: Fixture, firstLabel: string, firstAction: () => Promise<Response>, secondLabel: string, secondAction: () => Promise<Response>, requirePeerChain: boolean) {
    const pending: Promise<Response>[] = [], settlements: Promise<PromiseSettledResult<Response>>[] = [], done: boolean[] = []
    const launch = (action: () => Promise<Response>) => {
      const index = pending.length; done.push(false)
      const promise = action(); pending.push(promise)
      settlements.push(promise.then(value => { done[index] = true; return { status: 'fulfilled' as const, value } }, reason => { done[index] = true; return { status: 'rejected' as const, reason } }))
    }
    try {
      await db().tx(async controller => {
        expect((await controller.query(ROOT_QUERY, [f.wedding])).rowCount).toBe(1)
        const holder = (await controller.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        launch(firstAction)
        const first = await observeWait(controller, holder, null, 1, false)
        const firstPID = first[0]!.pid
        expect(done).toEqual([false])
        // Only the first registered request is in flight when its exact PID is captured.
        launch(secondAction)
        const both = await observeWait(controller, holder, firstPID, 2, requirePeerChain)
        expect(done).toEqual([false, false])
        note({ event: 'before-controller-release', wedding: f.wedding, slot: f.slot, controllerPID: holder, firstLabel, secondLabel,
          firstPID, secondPID: both.find(row => row.pid !== firstPID)!.pid, requirePeerChain, done, rows: both })
      })
    } finally {
      // Controller Db.tx commits/rolls back before awaiting requests; every outcome is retained.
      const settled = await Promise.all(settlements)
      note({ event: 'after-controller-release-settlements', firstLabel, secondLabel, settled: settled.map(row => row.status === 'fulfilled'
        ? { status: row.status, httpStatus: row.value.statusCode, body: row.value.body } : { status: row.status, reason: String(row.reason) }) })
    }
    expect(pending).toHaveLength(2)
    return Promise.all(pending)
  }
  type LiteralQuote = { kind: 'offer'; title: string; includes: string[]; price: { amount: number; currency: 'RUB' }; comparisonTerms: Terms; validUntil: string }
  const quote = (label: string, amount: number, validUntil = DATE): LiteralQuote => ({ kind: 'offer', title: label + ' title', includes: [label + ' service A', label + ' service B'],
    price: { amount, currency: 'RUB' }, validUntil,
    comparisonTerms: { hours: label + ' hours', team: label + ' team', result: label + ' result', delivery: label + ' delivery',
      extras: label + ' explicit extras', cancellation: label + ' cancellation', reschedule: label + ' reschedule' } })
  const reply = (f: Fixture, body: LiteralQuote, key = randomUUID()) => call(f.vendor, 'POST', `/vendor/offer-requests/${f.request}/offers`, body, key)
  const accept = (f: Fixture, offerId: string, key = randomUUID(), who = f.owner) => call(who, 'POST', `/weddings/${f.wedding}/offers/${offerId}/accept`, undefined, key)
  const refusal = (response: Response, code: string) => { expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe(code) }
  const receiptKey = (who: Actor, route: 'offers.accept' | 'vendor.offer-response', key: string) => `${who.id}:${route}:${key}`
  async function anotherVendor(f: Fixture): Promise<Fixture> {
    const v = await vendor()
    const added = await call(f.owner, 'PUT', `/weddings/${f.wedding}/shortlist/${v.vendorId}`)
    expect(added.statusCode, added.body).toBe(200)
    expect(added.json().slotId).toBe(f.slot)
    const requested = await call(f.owner, 'POST', `/weddings/${f.wedding}/slots/${f.slot}/offer-requests`, { entryIds: [added.json().id] }, randomUUID())
    expect(requested.statusCode, requested.body).toBe(201)
    return { ...f, vendor: v, entry: added.json().id as string, request: requested.json().results[0].requestId as string }
  }
  async function state(f: Fixture) {
    return { offers: await rows(`select to_jsonb(o) as row from offers o join offer_requests r on r.id=o.request_id where r.slot_id=$1 order by o.id`, [f.slot]),
      requests: await rows('select to_jsonb(r) as row from offer_requests r where slot_id=$1 order by id', [f.slot]),
      deals: await rows('select to_jsonb(d) as row from deals d where wedding_id=$1 order by id', [f.wedding]),
      events: await rows('select to_jsonb(e) as row from deal_events e join deals d on d.id=e.deal_id where d.wedding_id=$1 order by e.id', [f.wedding]),
      receipts: await rows('select to_jsonb(k) as row from idempotency_keys k where user_id=any($1::uuid[]) order by key', [users]),
      notices: await rows('select to_jsonb(n) as row from notifications n where user_id=any($1::uuid[]) order by id', [users]),
      busy: await rows('select to_jsonb(b) as row from vendor_busy_dates b join deals d on d.id=b.deal_id where d.wedding_id=$1 order by b.id', [f.wedding]),
      sources: await rows('select to_jsonb(s) as row from legacy_calendar_sources s where wedding_id=$1 order by id', [f.wedding]) }
  }
  function additions(before: Row[], after: Row[], identity: string) {
    for (const old of before) expect(after.find(row => row[identity] === old[identity])).toEqual(old)
    return after.filter(row => !before.some(old => old[identity] === row[identity]))
  }
  function assertReceipt(before: Row[], after: Row[], who: Actor, route: 'offers.accept' | 'vendor.offer-response', key: string, response: Response) {
    const added = additions(before, after, 'key')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ key: receiptKey(who, route, key), user_id: who.id, route, status: response.statusCode, body: response.json() })
  }
  async function assertSelected(f: Fixture, offerId: string, expected: LiteralQuote, response: Response, partner: Actor) {
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().deal).toMatchObject({ comparisonTerms: expected.comparisonTerms, packageName: expected.title, packageIncludes: expected.includes, price: expected.price })
    const native = await state(f)
    expect(native.deals).toHaveLength(1); expect(native.events).toHaveLength(1)
    const deal = native.deals[0]!
    expect(Object.keys(deal.offer_comparison_terms_snapshot as object).sort()).toEqual([...FIELDS].sort())
    expect(deal).toMatchObject({ vendor_id: f.vendor.vendorId, slot_id: f.slot, state: 'booked', offer_comparison_terms_snapshot: expected.comparisonTerms,
      package_title_snapshot: expected.title, package_includes_snapshot: expected.includes, price: expected.price.amount, currency: 'RUB' })
    const accepted = native.offers.filter(row => row.accepted_at !== null)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ id: offerId, deal_id: deal.id, comparison_terms: expected.comparisonTerms, title: expected.title, includes: expected.includes, price: expected.price.amount, currency: 'RUB', valid_until: expected.validUntil })
    expect(native.busy).toHaveLength(1); expect(native.busy[0]).toMatchObject({ vendor_id: f.vendor.vendorId, source: 'deal', deal_id: deal.id })
    for (const who of [f.owner, partner]) expect((await slotDeal(f, who)).deal).toMatchObject({ id: deal.id, comparisonTerms: expected.comparisonTerms, packageName: expected.title, packageIncludes: expected.includes, price: expected.price })
    const ownVendor = await call(f.vendor, 'GET', '/vendor/deals'); expect(ownVendor.statusCode, ownVendor.body).toBe(200)
    expect(ownVendor.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: deal.id, comparisonTerms: expected.comparisonTerms })]))
    return native
  }

  it('C15: two live couple sessions wait on one actual root, exactly one full quote wins and loser remains private', async () => {
    const first = await fixture(), second = await anotherVendor(first), partner = await member(first, 'couple')
    const q1 = quote('C15 FIRST unique', 7654321), q2 = quote('C15 SECOND unique', 44455)
    const sent1 = await reply(first, q1), sent2 = await reply(second, q2)
    expect([sent1.statusCode, sent2.statusCode]).toEqual([201, 201])
    const before = await state(first), key1 = randomUUID(), key2 = randomUUID()
    const results = await heldRace(first, 'owner accepts first offer', () => accept(first, sent1.json().id as string, key1),
      'partner accepts second offer', () => accept(second, sent2.json().id as string, key2, partner), false)
    expect(results.map(row => row.statusCode).sort(), results.map(row => row.body).join('\n')).toEqual([200, 409])
    const winnerAt = results.findIndex(row => row.statusCode === 200), loserAt = 1 - winnerAt
    const fixtures = [first, second], quotes = [q1, q2], sent = [sent1, sent2], actors = [first.owner, partner], attemptKeys = [key1, key2]
    const winner = fixtures[winnerAt]!, loser = fixtures[loserAt]!, winningQuote = quotes[winnerAt]!, losingQuote = quotes[loserAt]!
    refusal(results[loserAt]!, 'slot_taken')
    const after = await assertSelected(winner, sent[winnerAt]!.json().id as string, winningQuote, results[winnerAt]!, partner)
    expect(after.offers).toHaveLength(2)
    expect(after.offers.find(row => row.id === sent[loserAt]!.json().id)).toMatchObject({ accepted_at: null, deal_id: null,
      comparison_terms: losingQuote.comparisonTerms, title: losingQuote.title, includes: losingQuote.includes, price: losingQuote.price.amount })
    expect(after.events[0]).toMatchObject({ deal_id: after.deals[0]!.id, actor_id: actors[winnerAt]!.id, from_state: null, to_state: 'booked' })
    expect(after.requests.find(row => row.id === winner.request)).toMatchObject({ status: 'closed', close_reason: 'booked' })
    expect(after.requests.find(row => row.id === loser.request)).toMatchObject({ status: 'closed', close_reason: 'booked_other' })
    assertReceipt(before.receipts, after.receipts, actors[winnerAt]!, 'offers.accept', attemptKeys[winnerAt]!, results[winnerAt]!)
    expect(after.receipts.find(row => row.key === receiptKey(actors[loserAt]!, 'offers.accept', attemptKeys[loserAt]!))).toBeUndefined()
    const notices = additions(before.notices, after.notices, 'id')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ user_id: loser.vendor.id, kind: 'deal', title: 'Пара выбрала другого исполнителя',
      body: 'Запрос предложения закрыт: пара выбрала другого исполнителя.', link: '/vendor/offer-requests' })
    const loserView = await call(loser.vendor, 'GET', '/vendor/offer-requests'); expect(loserView.statusCode).toBe(200)
    expect(loserView.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: loser.request, status: 'closed', closeReason: 'booked_other' })]))
    for (const value of Object.values(winningQuote.comparisonTerms)) {
      expect(results[loserAt]!.body).not.toContain(value!); expect(loserView.body).not.toContain(value!); expect(JSON.stringify(notices)).not.toContain(value!)
    }
    expect(loserView.body).not.toContain(sent[winnerAt]!.json().id as string)
    for (const value of Object.values(losingQuote.comparisonTerms)) expect(results[winnerAt]!.body).not.toContain(value!)
    const replay = await accept(winner, sent[winnerAt]!.json().id as string, attemptKeys[winnerAt]!, actors[winnerAt]!)
    expect(replay.statusCode).toBe(200); expect(replay.headers['idempotent-replay']).toBe('true'); expect(replay.json()).toEqual(results[winnerAt]!.json())
    expect(await state(first)).toEqual(after)
    note({ event: 'C15-complete-native-oracles', winnerActor: actors[winnerAt]!.id, winnerVendor: winner.vendor.vendorId, selectedOffer: sent[winnerAt]!.json().id, after })
  })

  it('C16 accept first: actual second→first→controller queue yields old complete accepted quote and request_closed revision', async () => {
    const f = await fixture(), partner = await member(f, 'couple'), old = quote('C16 ACCEPT FIRST old', 7654321), next = quote('C16 ACCEPT FIRST revised', 44455, DATE.slice(0, 8) + '15')
    const sent = await reply(f, old); expect(sent.statusCode).toBe(201)
    const before = await state(f), acceptKey = randomUUID(), reviseKey = randomUUID()
    const [accepted, revised] = await heldRace(f, 'accept old selected version', () => accept(f, sent.json().id as string, acceptKey, partner),
      'revise same request', () => reply(f, next, reviseKey), true)
    refusal(revised!, 'request_closed')
    const after = await assertSelected(f, sent.json().id as string, old, accepted!, partner)
    expect(after.offers).toHaveLength(1); expect(after.offers[0]!.superseded_at).toBeNull()
    expect(after.requests).toHaveLength(1); expect(after.requests[0]).toMatchObject({ id: f.request, status: 'closed', close_reason: 'booked' })
    expect(additions(before.notices, after.notices, 'id')).toEqual([])
    assertReceipt(before.receipts, after.receipts, partner, 'offers.accept', acceptKey, accepted!)
    expect(after.receipts.find(row => row.key === receiptKey(f.vendor, 'vendor.offer-response', reviseKey))).toBeUndefined()
    for (const value of Object.values(next.comparisonTerms)) { expect(accepted!.body).not.toContain(value!); expect(revised!.body).not.toContain(value!) }
    note({ event: 'C16-accept-first-complete-native-oracles', oldOffer: sent.json().id, after })
  })

  it('C16 revision first: actual second→first→controller queue refuses old offer_superseded; explicit new acceptance copies only revised quote', async () => {
    const f = await fixture(), partner = await member(f, 'couple'), old = quote('C16 REVISE FIRST old', 7654321), next = quote('C16 REVISE FIRST new', 44455, DATE.slice(0, 8) + '15')
    const sent = await reply(f, old); expect(sent.statusCode).toBe(201)
    const before = await state(f), reviseKey = randomUUID(), staleKey = randomUUID()
    const [revised, stale] = await heldRace(f, 'revise same request', () => reply(f, next, reviseKey),
      'accept now-superseded original', () => accept(f, sent.json().id as string, staleKey, partner), true)
    expect(revised!.statusCode, revised!.body).toBe(201); expect(revised!.json()).toMatchObject({ comparisonTerms: next.comparisonTerms, validUntil: next.validUntil })
    refusal(stale!, 'offer_superseded')
    const afterRace = await state(f)
    expect(afterRace.deals).toEqual(before.deals); expect(afterRace.events).toEqual(before.events); expect(afterRace.busy).toEqual(before.busy); expect(afterRace.sources).toEqual(before.sources)
    expect(afterRace.requests).toEqual(before.requests); expect(afterRace.offers).toHaveLength(2)
    const original = afterRace.offers.find(row => row.id === sent.json().id)!, current = afterRace.offers.find(row => row.id === revised!.json().id)!
    expect(original).toMatchObject({ accepted_at: null, deal_id: null, comparison_terms: old.comparisonTerms, title: old.title, includes: old.includes, price: old.price.amount, valid_until: old.validUntil })
    expect(original.superseded_at).not.toBeNull()
    expect(current).toMatchObject({ superseded_at: null, accepted_at: null, deal_id: null, comparison_terms: next.comparisonTerms, title: next.title, includes: next.includes, price: next.price.amount, valid_until: next.validUntil })
    assertReceipt(before.receipts, afterRace.receipts, f.vendor, 'vendor.offer-response', reviseKey, revised!)
    expect(afterRace.receipts.find(row => row.key === receiptKey(partner, 'offers.accept', staleKey))).toBeUndefined()
    const notices = additions(before.notices, afterRace.notices, 'id')
    expect(notices).toHaveLength(2); expect(notices.map(row => row.user_id).sort()).toEqual([f.owner.id, partner.id].sort())
    for (const notice of notices) expect(notice).toMatchObject({ kind: 'deal', title: 'Новое предложение', body: 'Подрядчик прислал предложение.', link: `/wedding/slot/${f.slot}` })
    for (const value of Object.values(next.comparisonTerms)) { expect(stale!.body).not.toContain(value!); expect(JSON.stringify(notices)).not.toContain(value!) }
    const latestKey = randomUUID(), selected = await accept(f, revised!.json().id as string, latestKey, partner)
    const acceptedState = await assertSelected(f, revised!.json().id as string, next, selected, partner)
    expect(acceptedState.offers.find(row => row.id === sent.json().id)).toEqual(original)
    expect(acceptedState.notices).toEqual(afterRace.notices)
    assertReceipt(afterRace.receipts, acceptedState.receipts, partner, 'offers.accept', latestKey, selected)
    for (const value of Object.values(old.comparisonTerms)) expect(selected.body).not.toContain(value!)
    note({ event: 'C16-revision-first-complete-native-oracles', oldOffer: sent.json().id, revisedOffer: revised!.json().id, afterRace, acceptedState })
  })
})
