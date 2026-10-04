/** Implementer-authored registered native acceptance regressions. Independent22/UI/native-race qualification stays separate. */
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { eraseUser } from '../src/jobs/index.js'

const TARGET = 'tili_ecosystem_fr018_20261004_test'
const DATABASE = 'postgres://codex_test@127.0.0.1:15432/' + TARGET
const MIGRATION = '1763825000000_offer_comparison_terms'
const OID = '630867'
const PIN_SHA = '87686BDBECEE3E05543A258944059F3349CA1C57F489359C340D602F554BFAEB'
const SECRET = 'synthetic-fr018-native-acceptance'.repeat(3)
const POLICY = '2026-09-02'
const APPLICATION = 'fr018accept_' + randomUUID()
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`
const FIELDS = ['hours', 'team', 'result', 'delivery', 'extras', 'cancellation', 'reschedule'] as const
type Terms = Record<(typeof FIELDS)[number], string | null>
const UNKNOWN: Terms = { hours: null, team: null, result: null, delivery: null, extras: null, cancellation: null, reschedule: null }
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
const note = (fact: object) => process.stdout.write('FR018_ACCEPT_WITNESS ' + JSON.stringify(fact) + '\n')

describe.sequential('FR018 genuine selected-version durable snapshot and private lifecycle', () => {
  let app: FastifyInstance | undefined, sourceProof: SourceProof, sourceRaw = '', pins: SourcePins, journal: string[] = []
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
    const pinFile = fileURLToPath(new URL('../test-support/fr018-native-acceptance-pins.json', import.meta.url))
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
    note({ event: 'root-admitted-native83-start', actual, rootAttestedHead: sourceProof.head, fullSourceProofSHA256: hash(sourceRaw), fullSourceFiles: sourceProof.files.length,
      mutable, retainedInitialAudits: await rows('select to_jsonb(a) as row from audit_log a order by id') })
  }, 30_000)

  afterAll(async () => {
    if (!app) return
    const failures: unknown[] = []
    try {
      sourceGuard(); await nativeGuard()
      const audit = await rows('select to_jsonb(a) as row from audit_log a order by id')
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
    if (failures.length) throw new AggregateError(failures, 'FR018 acceptance own cleanup failed; preserve prior native case failure')
  }, 30_000)

  async function actor(): Promise<Actor> {
    const id = randomUUID(), sid = randomUUID(), cid = randomUUID()
    expect((await db().query('select id from users where id=$1', [id])).rowCount).toBe(0)
    users.push(id); note({ event: 'own-actor-before-insert', id, sid, cid })
    let inserted = false
    for (let n = 0; n < 8 && !inserted; n++) inserted = (await db().query<{ id: string }>("insert into users(id,phone,name,tz) values($1,$2,'Synthetic FR018 acceptance actor','UTC') on conflict(phone) do nothing returning id", [id, '+79' + randomInt(100_000_000, 999_999_999)])).rows[0]?.id === id
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
  const conditions = (label: string): Terms => ({ hours: label + ' hours', team: label + ' team', result: label + ' result', delivery: label + ' delivery', extras: '0', cancellation: label + ' cancellation', reschedule: label + ' reschedule' })
  const offer = (terms: Partial<Terms> | null | undefined = conditions('Literal selected')) => ({ kind: 'offer', title: 'Literal custom quote', includes: ['Literal custom service'], price: { amount: 7654321, currency: 'RUB' },
    ...(terms === undefined ? {} : { comparisonTerms: terms }) })
  const reply = (f: Fixture, body: object, key = randomUUID(), who = f.vendor) => call(who, 'POST', `/vendor/offer-requests/${f.request}/offers`, body, key)
  const accept = (f: Fixture, id: string, key = randomUUID(), who = f.owner) => call(who, 'POST', `/weddings/${f.wedding}/offers/${id}/accept`, undefined, key)
  async function shortlist(f: Fixture, who = f.owner) {
    const r = await call(who, 'GET', `/weddings/${f.wedding}/slots/${f.slot}/shortlist`)
    expect(r.statusCode, r.body).toBe(200)
    return { response: r, entry: (r.json() as { id: string; request?: { status: string; offer?: { id: string; comparisonTerms: Terms | null; price: { amount: number } } }; availabilityObservation: { source: string; date: string; checkedAt: string } | null }[]).find(e => e.id === f.entry)! }
  }
  async function slotDeal(f: Fixture, who = f.owner): Promise<{ response: Response; deal: Row }> {
    const r = await call(who, 'GET', `/weddings/${f.wedding}/slots`); expect(r.statusCode, r.body).toBe(200)
    return { response: r, deal: (r.json() as { id: string; deal: Row }[]).find(s => s.id === f.slot)!.deal }
  }
  async function snapshot(f: Fixture) {
    return { offers: await rows('select to_jsonb(o) as row from offers o where request_id=$1 order by created_at,id', [f.request]),
      requests: await rows('select to_jsonb(r) as row from offer_requests r where slot_id=$1 order by id', [f.slot]),
      deals: await rows('select to_jsonb(d) as row from deals d where wedding_id=$1 order by id', [f.wedding]),
      receipts: await rows('select to_jsonb(k) as row from idempotency_keys k where user_id=any($1::uuid[]) order by key', [users]),
      notices: await rows('select to_jsonb(n) as row from notifications n where user_id=any($1::uuid[]) order by id', [users]),
      busy: await rows('select to_jsonb(b) as row from vendor_busy_dates b where vendor_id=$1 order by date', [f.vendor.vendorId]),
      sources: await rows('select to_jsonb(s) as row from legacy_calendar_sources s where wedding_id=$1 order by id', [f.wedding]) }
  }
  function refused(r: Response, code: string, status = 409) { expect(r.statusCode, r.body).toBe(status); expect(r.json().error.code).toBe(code) }

  it.each(['package', 'custom'] as const)('F01/F03/F04 %s quote binds literal money/terms to both couple sessions and actual accepted snapshot', async kind => {
    const f = await fixture(), partner = await member(f, 'couple'), terms = conditions(kind)
    const body = kind === 'package' ? { kind: 'offer', packageId: f.vendor.packageId, price: { amount: 7654321, currency: 'RUB' }, comparisonTerms: terms } : offer(terms)
    const sent = await reply(f, body); expect(sent.statusCode, sent.body).toBe(201); expect(sent.json().comparisonTerms).toEqual(terms)
    expect(sent.json().price).toEqual({ amount: 7654321, currency: 'RUB' })
    for (const who of [f.owner, partner]) { const read = await shortlist(f, who); expect(read.entry.request?.offer).toMatchObject({ id: sent.json().id, comparisonTerms: terms, price: { amount: 7654321 } }); expect(read.entry.availabilityObservation).toMatchObject({ source: 'legacy_day', date: DATE }) }
    const accepted = await accept(f, sent.json().id as string, randomUUID(), partner)
    expect(accepted.statusCode, accepted.body).toBe(200); expect(accepted.json().deal.comparisonTerms).toEqual(terms)
    const native = (await rows('select to_jsonb(d) as row from deals d where slot_id=$1', [f.slot]))[0]!
    expect(native.offer_comparison_terms_snapshot).toEqual(terms); expect(native.price).toBe(7654321)
    expect((await rows('select to_jsonb(o) as row from offers o where id=$1', [sent.json().id]))[0]!.comparison_terms).toEqual(terms)
    expect(native.package_title_snapshot).toBe(kind === 'package' ? 'Literal offered package' : 'Literal custom quote')
    expect(native.package_includes_snapshot).toEqual(kind === 'package' ? ['Literal service A', 'Literal service B'] : ['Literal custom service'])
    for (const who of [f.owner, partner]) expect((await slotDeal(f, who)).deal.comparisonTerms).toEqual(terms)
    const vendor = await call(f.vendor, 'GET', '/vendor/deals'); expect(vendor.statusCode).toBe(200)
    expect(vendor.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: native.id, comparisonTerms: terms })]))
  })

  it('F02/F03 every omitted one of seven fields stays null, distinct from quoted extras zero/amount/unknown', async () => {
    for (const missing of FIELDS) {
      const f = await fixture(), submitted: Partial<Terms> = conditions('Missing ' + missing); delete submitted[missing]
      const expected = { ...conditions('Missing ' + missing), [missing]: null }
      const r = await reply(f, offer(submitted)); expect(r.statusCode).toBe(201); expect(r.json().comparisonTerms).toEqual(expected)
      expect((await shortlist(f)).entry.request?.offer?.comparisonTerms).toEqual(expected)
      const accepted = await accept(f, r.json().id as string); expect(accepted.statusCode).toBe(200)
      expect(accepted.json().deal.comparisonTerms).toEqual(expected)
    }
    for (const extras of ['0', 'Literal quoted extra 125.01 RUB', null]) {
      const f = await fixture(), expected = { ...UNKNOWN, hours: 'Literal hours', extras }
      const r = await reply(f, offer({ hours: 'Literal hours', extras })); expect(r.statusCode).toBe(201); expect(r.json().comparisonTerms).toEqual(expected)
      const accepted = await accept(f, r.json().id as string); expect(accepted.statusCode, accepted.body).toBe(200); expect(accepted.json().deal.comparisonTerms).toEqual(expected)
    }
  }, 60_000)

  it.each(['package', 'custom'] as const)('F05 %s omitted fields stay unknown and never parse unrelated package/message conditions', async kind => {
    const f = await fixture()
    const body = kind === 'package' ? { kind: 'offer', packageId: f.vendor.packageId, price: { amount: 7654321, currency: 'RUB' }, message: 'NOT A CONDITION: 99 hours' } : { kind: 'offer', title: 'NOT A CONDITION: 99 hours', includes: [], price: { amount: 7654321, currency: 'RUB' }, message: 'NOT A CONDITION: fee zero' }
    const r = await reply(f, body); expect(r.statusCode).toBe(201); expect(r.json().comparisonTerms).toBeNull()
    const a = await accept(f, r.json().id as string); expect(a.statusCode).toBe(200); expect(a.json().deal.comparisonTerms).toBeNull()
    expect((await rows('select to_jsonb(d) as row from deals d where slot_id=$1', [f.slot]))[0]!.offer_comparison_terms_snapshot).toBeNull()
  })

  it('C09 refuses old version without any booking/receipt/notice/calendar mutation; selected new version is copied whole', async () => {
    const f = await fixture(), old = await reply(f, offer(conditions('Old'))), latest = await reply(f, offer(conditions('New')))
    expect([old.statusCode, latest.statusCode]).toEqual([201, 201]); const before = await snapshot(f)
    refused(await accept(f, old.json().id as string), 'offer_superseded'); expect(await snapshot(f)).toEqual(before)
    const accepted = await accept(f, latest.json().id as string); expect(accepted.statusCode).toBe(200); expect(accepted.json().deal.comparisonTerms).toEqual(conditions('New'))
    const native = await rows('select to_jsonb(d) as row from deals d where slot_id=$1', [f.slot]); expect(native).toHaveLength(1); expect(native[0]!.offer_comparison_terms_snapshot).toEqual(conditions('New'))
  })

  it('C10/C20 actual authorized package edit/deletion cannot retarget accepted conditions, offer or couple/vendor views/exports', async () => {
    const f = await fixture(), terms = conditions('Durable package')
    const quoted = await reply(f, { kind: 'offer', packageId: f.vendor.packageId, price: { amount: 7654321, currency: 'RUB' }, comparisonTerms: terms })
    expect(quoted.statusCode).toBe(201); const accepted = await accept(f, quoted.json().id as string); expect(accepted.statusCode).toBe(200)
    const original = (await rows('select to_jsonb(d) as row from deals d where slot_id=$1', [f.slot]))[0]!
    for (const packages of [[{ id: f.vendor.packageId, name: 'Changed current catalogue', price: { amount: 1, currency: 'RUB' }, includes: ['Changed current catalogue services'] }], []]) {
      const changed = await call(f.vendor, 'PUT', '/vendor/profile', { name: f.vendor.name, categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' }, packages })
      expect(changed.statusCode, changed.body).toBe(200)
      const native = (await rows('select to_jsonb(d) as row from deals d where slot_id=$1', [f.slot]))[0]!
      expect(native.offer_comparison_terms_snapshot).toEqual(terms); expect(native.price).toBe(original.price); expect(native.package_title_snapshot).toBe(original.package_title_snapshot); expect(native.package_includes_snapshot).toEqual(original.package_includes_snapshot)
      expect((await slotDeal(f)).deal).toMatchObject({ comparisonTerms: terms, packageName: 'Literal offered package', packageIncludes: ['Literal service A', 'Literal service B'], price: { amount: 7654321, currency: 'RUB' } })
      const own = await call(f.vendor, 'GET', '/vendor/deals'); expect(own.statusCode).toBe(200); expect(own.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: original.id, comparisonTerms: terms })]))
      const couple = await call(f.owner, 'GET', '/users/me/export'); expect(couple.statusCode).toBe(200); expect(couple.json().deals).toEqual(expect.arrayContaining([expect.objectContaining({ offer_comparison_terms_snapshot: terms, price: '7654321' })]))
      const vendor = await call(f.vendor, 'GET', '/users/me/export'); expect(vendor.statusCode).toBe(200); expect(vendor.json().vendorOffers).toEqual(expect.arrayContaining([expect.objectContaining({ request_id: f.request, comparison_terms: terms })]))
    }
  })

  it('C10/C20 registered completion/authorized account removal + existing scoped erase deletes vendor offers but preserves original deal terms and audits', async () => {
    const f = await fixture(), terms = conditions('Durable after erase'), sent = await reply(f, offer(terms))
    expect(sent.statusCode).toBe(201); const a = await accept(f, sent.json().id as string); expect(a.statusCode).toBe(200)
    const done = await call(f.owner, 'PATCH', `/deals/${a.json().deal.id as string}`, { state: 'done' }, randomUUID()); expect(done.statusCode, done.body).toBe(200)
    const deleted = await call(f.vendor, 'DELETE', '/users/me'); expect(deleted.statusCode, deleted.body).toBe(204)
    const immutableAudit = await rows('select to_jsonb(a) as row from audit_log a order by id')
    // Only this authorized synthetic account is advanced to existing native hard-erasure age.
    await db().query("update users set deleted_at=clock_timestamp()-interval '31 days' where id=$1 and deleted_at is not null", [f.vendor.id])
    const allReceipts = (await db().query<{ user_id: string }>('select user_id from idempotency_keys')).rows
    expect(allReceipts.every(row => users.includes(row.user_id))).toBe(true) // scoped target makes eraseUser's existing TTL sweep contain only own fixtures
    await db().tx(client => eraseUser(client, f.vendor.id))
    expect((await db().query('select id from users where id=$1', [f.vendor.id])).rows).toEqual([])
    expect(await rows('select to_jsonb(o) as row from offers o where request_id=$1', [f.request])).toEqual([])
    const native = (await rows('select to_jsonb(d) as row from deals d where slot_id=$1', [f.slot]))[0]!
    expect(native).toMatchObject({ vendor_id: null, external_name: 'Удалённый подрядчик', offer_comparison_terms_snapshot: terms, price: 7654321 })
    expect((await slotDeal(f)).deal.comparisonTerms).toEqual(terms)
    const exported = await call(f.owner, 'GET', '/users/me/export'); expect(exported.statusCode).toBe(200)
    expect(exported.json().deals).toEqual(expect.arrayContaining([expect.objectContaining({ offer_comparison_terms_snapshot: terms, price: '7654321' })]))
    expect(exported.body).not.toContain(f.vendor.name); expect(await rows('select to_jsonb(a) as row from audit_log a order by id')).toEqual(immutableAudit)
  })

  it('C20 owned native legacy-NULL snapshot control never reconstructs terms from the still-known live offer/package', async () => {
    const f = await fixture(), terms = conditions('Known current offer'), sent = await reply(f, offer(terms)); expect(sent.statusCode).toBe(201)
    const accepted = await accept(f, sent.json().id as string); expect(accepted.statusCode).toBe(200); const deal = accepted.json().deal.id as string
    // Explicit synthetic legacy-cell control, not an authorized commercial edit or historical up-migration claim.
    expect((await db().query('update deals set offer_comparison_terms_snapshot=null where id=$1 and wedding_id=$2 returning id', [deal, f.wedding])).rowCount).toBe(1)
    expect((await rows('select to_jsonb(o) as row from offers o where id=$1', [sent.json().id]))[0]!.comparison_terms).toEqual(terms)
    expect((await slotDeal(f)).deal.comparisonTerms).toBeNull()
    const vendor = await call(f.vendor, 'GET', '/vendor/deals'); expect(vendor.statusCode).toBe(200)
    expect(vendor.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: deal, comparisonTerms: null })]))
    const dump = await call(f.owner, 'GET', '/users/me/export'); expect(dump.statusCode).toBe(200)
    expect(dump.json().deals).toEqual(expect.arrayContaining([expect.objectContaining({ offer_comparison_terms_snapshot: null })]))
  })

  it.each([null, DATE])('C12 date assignment/change from %s closes request, denies stale acceptance and adds no booking', async date => {
    const f = await fixture(date), sent = await reply(f, offer(conditions('Old date'))); expect(sent.statusCode).toBe(201)
    if (date) { const same = await call(f.owner, 'POST', `/weddings/${f.wedding}/reschedule`, { date }, randomUUID()); expect(same.statusCode).toBe(200); expect((await rows('select to_jsonb(r) as row from offer_requests r where id=$1', [f.request]))[0]!.status).toBe('open') }
    const changed = await call(f.owner, 'PATCH', `/weddings/${f.wedding}`, { date: `${new Date().getUTCFullYear() + 1}-07-14` }); expect(changed.statusCode).toBe(200)
    const before = await snapshot(f); expect(before.requests.find(r => r.id === f.request)).toMatchObject({ status: 'closed', close_reason: 'date_changed' })
    refused(await accept(f, sent.json().id as string), 'offer_stale_date'); expect(await snapshot(f)).toEqual(before); expect(before.deals).toEqual([])
  })

  it('C13 helper refusal preserves every fact; couple-authorized revocation closes removed and stale accept cannot resurrect conditions or deal', async () => {
    const f = await fixture(), helper = await member(f, 'helper'), sent = await reply(f, offer(conditions('Revoked'))); expect(sent.statusCode).toBe(201)
    const beforeHelper = await snapshot(f)
    refused(await call(helper, 'DELETE', `/weddings/${f.wedding}/slots/${f.slot}/shortlist/${f.entry}`), 'request_open')
    expect(await snapshot(f)).toEqual(beforeHelper)
    const removed = await call(f.owner, 'DELETE', `/weddings/${f.wedding}/slots/${f.slot}/shortlist/${f.entry}`); expect(removed.statusCode).toBe(204)
    const before = await snapshot(f); expect(before.requests.find(r => r.id === f.request)).toMatchObject({ status: 'closed', close_reason: 'removed' })
    refused(await accept(f, sent.json().id as string), 'request_closed'); expect(await snapshot(f)).toEqual(before); expect(before.deals).toEqual([])
    const vendor = await call(f.vendor, 'GET', '/vendor/offer-requests'); expect(vendor.statusCode).toBe(200); expect(vendor.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.request, status: 'closed', closeReason: 'removed' })]))
  })

  it('C14 seven distinct commercial canaries never enter helper/coordinator/foreign vendor views, exports, notices or unauthorized acceptance', async () => {
    const f = await fixture(), helper = await member(f, 'helper'), coordinator = await member(f, 'coordinator'), foreign = await vendor()
    const added = await call(f.owner, 'PUT', `/weddings/${f.wedding}/shortlist/${foreign.vendorId}`); expect(added.statusCode).toBe(200); expect(added.json().slotId).toBe(f.slot)
    const competitorRequest = await call(f.owner, 'POST', `/weddings/${f.wedding}/slots/${f.slot}/offer-requests`, { entryIds: [added.json().id as string] }, randomUUID())
    expect(competitorRequest.statusCode).toBe(201)
    const nonce = randomUUID(), terms: Terms = { hours: 'CANARY_HOURS_' + nonce, team: 'CANARY_TEAM_' + nonce, result: 'CANARY_RESULT_' + nonce,
      delivery: 'CANARY_DELIVERY_' + nonce, extras: 'CANARY_EXTRAS_' + nonce, cancellation: 'CANARY_CANCELLATION_' + nonce, reschedule: 'CANARY_RESCHEDULE_' + nonce }
    expect(new Set(Object.values(terms)).size).toBe(7)
    const sent = await reply(f, offer(terms)); expect(sent.statusCode).toBe(201)
    for (const who of [helper, coordinator]) {
      const view = await shortlist(f, who); expect(view.entry.request).toEqual({ status: 'responded' })
      for (const value of Object.values(terms)) expect(view.response.body).not.toContain(value!)
      const before = await snapshot(f); refused(await accept(f, sent.json().id as string, randomUUID(), who), 'forbidden', 403); expect(await snapshot(f)).toEqual(before)
    }
    const hidden = await call(foreign, 'GET', `/weddings/${f.wedding}/slots/${f.slot}/shortlist`); expect(hidden.statusCode).toBe(404)
    const before = await snapshot(f); refused(await reply(f, offer(conditions('Foreign')), randomUUID(), foreign), 'not_found', 404); expect(await snapshot(f)).toEqual(before)
    const unauthorized = await accept(f, sent.json().id as string, randomUUID(), foreign); expect(unauthorized.statusCode).toBe(404); expect(await snapshot(f)).toEqual(before)
    const accepted = await accept(f, sent.json().id as string); expect(accepted.statusCode).toBe(200)
    const competitor = (await rows('select to_jsonb(r) as row from offer_requests r where id=$1', [competitorRequest.json().results[0].requestId]))[0]!
    expect(competitor).toMatchObject({ status: 'closed', close_reason: 'booked_other' })
    for (const who of [helper, coordinator]) {
      const view = await slotDeal(f, who); for (const key of ['comparisonTerms', 'price', 'paid', 'packageName', 'packageIncludes']) expect(view.deal).not.toHaveProperty(key)
      const dump = await call(who, 'GET', '/users/me/export'); expect(dump.statusCode).toBe(200); expect(dump.json().offers).toEqual([]); expect(dump.json().vendorOffers).toEqual([])
      for (const value of Object.values(terms)) { expect(view.response.body).not.toContain(value!); expect(dump.body).not.toContain(value!) }
    }
    for (const url of ['/vendor/offer-requests', '/vendor/deals', '/users/me/export']) {
      const read = await call(foreign, 'GET', url); expect(read.statusCode).toBe(200); for (const value of Object.values(terms)) expect(read.body).not.toContain(value!)
    }
    const notices = await rows('select to_jsonb(n) as row from notifications n where user_id=any($1::uuid[]) order by id', [[helper.id, coordinator.id, foreign.id]])
    for (const value of Object.values(terms)) expect(JSON.stringify(notices)).not.toContain(value!)
  })

  it('C17 exact stable reply/accept keys replay committed native terms once; changed body409 preserves every fact', async () => {
    const f = await fixture(), terms = conditions('Stable intent'), body = offer(terms), replyKey = randomUUID(), acceptKey = randomUUID()
    const first = await reply(f, body, replyKey); expect(first.statusCode).toBe(201); const replied = await snapshot(f)
    const replay = await reply(f, body, replyKey); expect(replay.statusCode).toBe(201); expect(replay.headers['idempotent-replay']).toBe('true'); expect(replay.json()).toEqual(first.json()); expect(await snapshot(f)).toEqual(replied)
    refused(await reply(f, offer(conditions('Different explicit intent')), replyKey), 'idempotency_key_reused'); expect(await snapshot(f)).toEqual(replied)
    const accepted = await accept(f, first.json().id as string, acceptKey); expect(accepted.statusCode).toBe(200); const committed = await snapshot(f)
    expect(committed.deals).toHaveLength(1); expect(committed.deals[0]!.offer_comparison_terms_snapshot).toEqual(terms)
    const acceptReplay = await accept(f, first.json().id as string, acceptKey); expect(acceptReplay.statusCode).toBe(200); expect(acceptReplay.headers['idempotent-replay']).toBe('true'); expect(acceptReplay.json()).toEqual(accepted.json()); expect(await snapshot(f)).toEqual(committed)
    expect(committed.offers.filter(o => o.accepted_at)).toHaveLength(1)
  })
})
