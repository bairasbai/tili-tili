/** Implementer-authored registered-route regressions. Source only; native execution belongs to root. */
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'

const TARGET = 'tili_ecosystem_fr018_20261004_test'
const URL = `postgres://codex_test@127.0.0.1:15432/${TARGET}`
const SECRET = 'synthetic-fr018-route-access'.repeat(3)
const APPLICATION = 'fr018route_' + randomUUID()
const POLICY = '2026-09-02'
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`
const FIELDS = ['hours', 'team', 'result', 'delivery', 'extras', 'cancellation', 'reschedule'] as const
type Terms = Record<(typeof FIELDS)[number], string | null>
type Actor = { id: string; token: string }
type Vendor = Actor & { vendorId: string; packageId: string }
type Fixture = { owner: Actor; vendor: Vendor; wedding: string; slot: string; request: string; users: string[] }
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
const EMPTY: Terms = { hours: null, team: null, result: null, delivery: null, extras: null, cancellation: null, reschedule: null }
const TERM_MESSAGE = 'Укажите текст условия до 2000 символов или оставьте поле пустым'

// No candidate normalizer/schema/Queryable mock is imported. Expected facts are literal contract oracles.
const BAD_TERMS = [
  { name: 'whole numeric0', value: 0, field: 'comparisonTerms' },
  { name: 'whole boolean', value: true, field: 'comparisonTerms' },
  { name: 'whole string', value: '0', field: 'comparisonTerms' },
  { name: 'whole array', value: [], field: 'comparisonTerms' },
  { name: 'raw numeric extras0', value: { extras: 0 }, field: 'comparisonTerms.extras' },
  { name: 'raw boolean extrasfalse', value: { extras: false }, field: 'comparisonTerms.extras' },
  { name: 'raw object extras', value: { extras: { price: '0' } }, field: 'comparisonTerms.extras' },
  { name: 'raw array extras', value: { extras: [] }, field: 'comparisonTerms.extras' },
  { name: 'unknown key', value: { invented: 'no policy' }, field: 'comparisonTerms' },
  { name: 'lone high surrogate', value: { extras: '\uD800' }, field: 'comparisonTerms.extras' },
  { name: 'lone low surrogate', value: { extras: '\uDFFF' }, field: 'comparisonTerms.extras' },
  { name: '2001 Unicode codepoints', value: { extras: '🧡'.repeat(2001) }, field: 'comparisonTerms.extras' },
  { name: '2001 ASCII codepoints', value: { extras: 'x'.repeat(2001) }, field: 'comparisonTerms.extras' },
  { name: 'raw bound before trim', value: { extras: ' ' + 'x'.repeat(1999) + ' ' }, field: 'comparisonTerms.extras' },
] as const
const GOOD_TERMS = [
  { name: 'omitted legacy', extra: {}, expected: null },
  { name: 'whole null', extra: { comparisonTerms: null }, expected: null },
  { name: 'empty object', extra: { comparisonTerms: {} }, expected: null },
  { name: 'all null', extra: { comparisonTerms: EMPTY }, expected: null },
  { name: 'blank text', extra: { comparisonTerms: { hours: ' \t\n ', extras: '' } }, expected: null },
  { name: 'quoted zero', extra: { comparisonTerms: { extras: '0' } }, expected: { ...EMPTY, extras: '0' } },
  { name: 'partial trimmed quote', extra: { comparisonTerms: { hours: '  8 quoted hours  ', delivery: ' unknown relative deadline ' } }, expected: { ...EMPTY, hours: '8 quoted hours', delivery: 'unknown relative deadline' } },
  { name: '2000 supplementary codepoints', extra: { comparisonTerms: { result: '🧡'.repeat(2000) } }, expected: { ...EMPTY, result: '🧡'.repeat(2000) } },
] as const

describe.sequential('FR018 registered offer input and native version/receipt/privacy regressions', () => {
  let app: FastifyInstance | undefined
  let oid = '', journal: string[] = []
  const users: string[] = [], weddings: string[] = [], vendors: string[] = []
  const ownKeys = new Set<string>()
  const application = () => { assert(app); return app }
  const db = () => { assert(app?.db); return app.db }
  const auth = (actor: Actor) => ({ authorization: `Bearer ${actor.token}` })
  const note = (value: object) => process.stdout.write(`FR018_ROUTE_WITNESS ${JSON.stringify(value)}\n`)

  async function identity() {
    const row = (await db().query<{ name: string; username: string; address: string; port: number; oid: string }>(
      `select current_database() as name,current_user as username,host(inet_server_addr()) as address,
        inet_server_port() as port,(select oid::text from pg_database where datname=current_database()) as oid`,
    )).rows[0]!
    assert.equal(row.name, TARGET); assert.equal(row.username, 'codex_test'); assert.equal(row.port, 15432)
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(row.address)); assert.equal(row.oid, oid)
    return row
  }

  beforeAll(async () => {
    assert.equal(process.env.TEST_DATABASE_URL, URL); assert.equal(process.env.DATABASE_URL, URL)
    assert.notEqual(process.env.GITHUB_ACTIONS, 'true', 'local reserved target only; portable CI needs separate admission')
    oid = process.env.FR018_TEST_DATABASE_OID ?? ''; assert.match(oid, /^[1-9][0-9]*$/)
    const proofPath = process.env.FR018_TEST_CREATION_PROOF; assert(proofPath, 'actual root creation proof required')
    const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as { kind: string; absentBeforeCreate: boolean; beforeRowCount: number; targetName: string; targetURL: string; databaseOID: string; actualAdmin: { database: string; username: string; port: number; address: string } }
    assert.equal(proof.kind, 'root_actual_absent_before_create'); assert.equal(proof.absentBeforeCreate, true); assert.equal(proof.beforeRowCount, 0)
    assert.equal(proof.targetName, TARGET); assert.equal(proof.targetURL, URL); assert.equal(proof.databaseOID, oid)
    assert.equal(proof.actualAdmin.database, 'postgres'); assert.equal(proof.actualAdmin.username, 'codex_test')
    assert.equal(proof.actualAdmin.port, 15432); assert.equal(proof.actualAdmin.address, '127.0.0.1')
    const chosen = process.env.FR018_TEST_MIGRATION_NAME ?? ''
    assert.equal(chosen, '1763825000000_offer_comparison_terms', 'exact root-selected preserving-order migration required')
    const originalRaw = readFileSync(new globalThis.URL('../test-support/fr018-pre83-migrations.json', import.meta.url))
    assert.equal(createHash('sha256').update(originalRaw).digest('hex').toUpperCase(), '432E733FAECFECEAFE64741760E2F9E99E95B52B52CBED3164DDB827E06D8655')
    const original = JSON.parse(originalRaw.toString('utf8')) as { name: string; sha256: string }[]
    assert.equal(original.length, 82); assert.equal(new Set(original.map(r => r.name)).size, 82)
    assert(!original.some(r => r.name === chosen)); journal = [...original.map(r => r.name), chosen].sort()
    for (const row of original) {
      assert.match(row.name, /^[0-9]{13}_[a-z0-9_]+$/)
      assert.equal(createHash('sha256').update(readFileSync(new globalThis.URL('../migrations/' + row.name + '.cjs', import.meta.url))).digest('hex').toUpperCase(), row.sha256)
    }
    const connection = new globalThis.URL(URL); connection.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: connection.href, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: SECRET + '-refresh', policyVersion: POLICY, rateLimitPerSecond: 0,
      vapidPublicKey: null, vapidPrivateKey: null }, [], { tillyModel: null })
    await app.ready(); note({ event: 'actual-identity', identity: await identity() })
    expect((await db().query('select pid,application_name from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and application_name<>$1', [APPLICATION])).rows).toEqual([])
    expect((await db().query<{ name: string }>('select name from pgmigrations order by name')).rows.map(r => r.name)).toEqual(journal)
    const columns = (await db().query<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public'
        and ((table_name='offers' and column_name='comparison_terms') or (table_name='deals' and column_name='offer_comparison_terms_snapshot')) order by table_name,column_name`,
    )).rows
    expect(columns).toEqual([
      { table_name: 'deals', column_name: 'offer_comparison_terms_snapshot', data_type: 'jsonb', is_nullable: 'YES' },
      { table_name: 'offers', column_name: 'comparison_terms', data_type: 'jsonb', is_nullable: 'YES' },
    ])
    const initial = (await db().query<Record<string, string>>(`select
      (select count(*)::text from users) as users,(select count(*)::text from weddings) as weddings,
      (select count(*)::text from vendors) as vendors,(select count(*)::text from offer_requests) as requests,
      (select count(*)::text from offers) as offers,(select count(*)::text from deals) as deals,
      (select count(*)::text from sessions) as sessions,(select count(*)::text from consents) as consents,
      (select count(*)::text from notification_prefs) as prefs,(select count(*)::text from notifications) as notices,
      (select count(*)::text from idempotency_keys) as receipts`)).rows[0]!
    expect(Object.values(initial)).toEqual(Array(11).fill('0')); note({ event: 'initial-owned-target-empty', counts: initial })
  }, 30_000)

  afterAll(async () => {
    if (!app) return
    const errors: unknown[] = []
    try {
      await identity()
      const auditSQL = 'select id::text,actor_id,action,entity,entity_id,at from audit_log order by id'
      const auditBefore = (await db().query(auditSQL)).rows
      for (const id of weddings) { try { await db().query('delete from weddings where id=$1 and owner_id=any($2::uuid[])', [id, users]) } catch (e) { errors.push(e) } }
      try { await db().query('delete from idempotency_keys where user_id=any($1::uuid[])', [users]) } catch (e) { errors.push(e) }
      for (const id of users) { try { await db().query('delete from users where id=$1', [id]) } catch (e) { errors.push(e) } }
      const counts = (await db().query<Record<string, string>>(`select
        (select count(*)::text from users where id=any($1::uuid[])) as users,
        (select count(*)::text from sessions where user_id=any($1::uuid[])) as sessions,
        (select count(*)::text from consents where user_id=any($1::uuid[])) as consents,
        (select count(*)::text from notification_prefs where user_id=any($1::uuid[])) as prefs,
        (select count(*)::text from notifications where user_id=any($1::uuid[])) as notices,
        (select count(*)::text from idempotency_keys where user_id=any($1::uuid[])) as receipts,
        (select count(*)::text from vendors where id=any($2::uuid[])) as vendors,
        (select count(*)::text from weddings where id=any($3::uuid[])) as weddings`, [users, vendors, weddings])).rows[0]!
      expect(Object.values(counts)).toEqual(Array(8).fill('0'))
      expect((await db().query(auditSQL)).rows).toEqual(auditBefore)
      expect((await db().query<{ name: string }>('select name from pgmigrations order by name')).rows.map(r => r.name)).toEqual(journal)
      note({ event: 'owned-cleanup', counts, retainedImmutableAudits: auditBefore, ownKeys: [...ownKeys], users, weddings, vendors })
    } catch (e) { errors.push(e) }
    finally { try { await app.close() } catch (e) { errors.push(e) } }
    if (errors.length) throw new AggregateError(errors, 'FR018 owned cleanup failed; retain original case failure')
  }, 30_000)

  async function actor(): Promise<Actor> {
    const id = randomUUID(), sid = randomUUID(), cid = randomUUID()
    expect((await db().query('select id from users where id=$1', [id])).rows).toEqual([])
    let inserted = false
    for (let n = 0; n < 8 && !inserted; n++) {
      const row = await db().query<{ id: string }>('insert into users(id,phone,name,tz) values($1,$2,$3,\'UTC\') on conflict(phone) do nothing returning id', [id, '+79' + randomInt(100_000_000, 999_999_999), 'Synthetic FR018 actor'])
      inserted = row.rows[0]?.id === id
    }
    assert(inserted, 'bounded synthetic phone allocation exhausted'); users.push(id)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [cid, id, POLICY])
    await db().query("insert into notification_prefs(user_id,quiet_from,quiet_to) values($1,'00:00','00:00')", [id])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }

  async function vendor(): Promise<Vendor> {
    const who = await actor()
    const response = await application().inject({ method: 'PUT', url: '/vendor/profile', headers: auth(who), payload: {
      name: 'Synthetic FR018 vendor ' + who.id, categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' },
      portfolioUrls: ['https://example.com/fr018-fixture.jpg'], priceFrom: { amount: 8000000, currency: 'RUB' },
      packages: [{ name: 'Synthetic quoted package', price: { amount: 10000000, currency: 'RUB' }, includes: ['Literal package service'] }],
    } })
    expect(response.statusCode, response.body).toBe(200)
    const result = response.json() as { id: string; packages: { id: string }[] }; vendors.push(result.id)
    const published = await application().inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(who) })
    expect(published.statusCode, published.body).toBe(200)
    return { ...who, vendorId: result.id, packageId: result.packages[0]!.id }
  }

  async function fixture(): Promise<Fixture> {
    const owner = await actor(), performer = await vendor()
    const response = await application().inject({ method: 'POST', url: '/weddings', headers: auth(owner), payload: {
      partnerName: 'Synthetic partner', date: DATE, city: { name: 'Уфа', region: 'Башкортостан' }, guestsPlanned: 88,
    } })
    expect(response.statusCode, response.body).toBe(201); const wedding = response.json().id as string; weddings.push(wedding)
    const added = await application().inject({ method: 'PUT', url: `/weddings/${wedding}/shortlist/${performer.vendorId}`, headers: auth(owner) })
    expect(added.statusCode, added.body).toBe(200)
    const entry = added.json() as { id: string; slotId: string }, key = randomUUID(); ownKeys.add(key)
    const requested = await application().inject({ method: 'POST', url: `/weddings/${wedding}/slots/${entry.slotId}/offer-requests`,
      headers: { ...auth(owner), 'idempotency-key': key }, payload: { entryIds: [entry.id] } })
    expect(requested.statusCode, requested.body).toBe(201)
    const results = requested.json().results as { entryId: string; status: string; requestId: string }[]
    expect(results).toEqual([{ entryId: entry.id, status: 'sent', requestId: expect.any(String) }])
    return { owner, vendor: performer, wedding, slot: entry.slotId, request: results[0]!.requestId, users: [owner.id, performer.id] }
  }

  const custom = (extra: Record<string, unknown> = {}) => ({ kind: 'offer', title: 'Literal negotiated offer',
    price: { amount: 12000001, currency: 'RUB' }, includes: ['Literal custom service'], ...extra })
  async function answer(f: Fixture, payload: object, key: string = randomUUID(), who: Actor = f.vendor) {
    ownKeys.add(key)
    return application().inject({ method: 'POST', url: `/vendor/offer-requests/${f.request}/offers`, headers: { ...auth(who), 'idempotency-key': key }, payload })
  }
  async function snapshot(f: Fixture) {
    return {
      offers: (await db().query('select to_jsonb(o) as row from offers o where request_id=$1 order by created_at,id', [f.request])).rows,
      request: (await db().query('select to_jsonb(r) as row from offer_requests r where id=$1', [f.request])).rows,
      receipts: (await db().query('select to_jsonb(k) as row from idempotency_keys k where user_id=any($1::uuid[]) order by key', [f.users])).rows,
      notices: (await db().query('select to_jsonb(n) as row from notifications n where user_id=any($1::uuid[]) order by id', [f.users])).rows,
      deals: (await db().query('select to_jsonb(d) as row from deals d where wedding_id=$1 order by id', [f.wedding])).rows,
    }
  }
  async function prime(f: Fixture) {
    const r = await answer(f, custom({ comparisonTerms: { hours: 'Original immutable version' } }))
    expect(r.statusCode, r.body).toBe(201)
    return r.json().id as string
  }
  function exactTermRefusal(response: Response, field: string) {
    expect(response.statusCode, response.body).toBe(422)
    expect(response.json()).toEqual({ error: { code: 'validation_failed', message: 'Запрос не прошёл проверку', fields: { [field]: TERM_MESSAGE } } })
  }
  async function stored(f: Fixture) {
    return (await db().query<{ id: string; comparison_terms: Terms | null; price: string | null; superseded_at: Date | null }>(
      'select id,comparison_terms,price::text as price,superseded_at from offers where request_id=$1 order by created_at,id', [f.request],
    )).rows
  }

  it.each(BAD_TERMS)('raw $name refuses422 without version/receipt/quota/notice effects and same key can correct', async ({ value, field }) => {
    const f = await fixture(), previous = await prime(f), key = randomUUID(), before = await snapshot(f)
    exactTermRefusal(await answer(f, custom({ comparisonTerms: value }), key), field)
    expect(await snapshot(f)).toEqual(before)
    const corrected = await answer(f, custom({ comparisonTerms: { extras: '0' } }), key)
    expect(corrected.statusCode, corrected.body).toBe(201); expect(corrected.headers['idempotent-replay']).toBeUndefined()
    expect(corrected.json().comparisonTerms).toEqual({ ...EMPTY, extras: '0' })
    const rows = await stored(f); expect(rows).toHaveLength(2); expect(rows.find(r => r.id === previous)?.superseded_at).toBeInstanceOf(Date)
    expect(rows.find(r => r.id === corrected.json().id)?.comparison_terms).toEqual({ ...EMPTY, extras: '0' })
    const committed = await snapshot(f), replay = await answer(f, custom({ comparisonTerms: { extras: '0' } }), key)
    expect(replay.statusCode, replay.body).toBe(201); expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.json()).toEqual(corrected.json()); expect(await snapshot(f)).toEqual(committed)
  })

  it('embedded NUL preserves the existing global422 code and all native state', async () => {
    const f = await fixture(); await prime(f); const before = await snapshot(f)
    const refused = await answer(f, custom({ comparisonTerms: { extras: 'before\u0000after' } }))
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json()).toEqual({ error: { code: 'invalid_character', message: 'В запросе недопустимый символ (NUL)' } })
    expect(await snapshot(f)).toEqual(before)
  })

  it.each(GOOD_TERMS)('$name survives actual route and persisted canonical fields', async ({ extra, expected }) => {
    const f = await fixture(), response = await answer(f, custom(extra))
    expect(response.statusCode, response.body).toBe(201); expect(response.json().comparisonTerms).toEqual(expected)
    expect(response.json().price).toEqual({ amount: 12000001, currency: 'RUB' })
    expect(response.json().includes).toEqual(['Literal custom service'])
    expect(await stored(f)).toEqual([{ id: response.json().id, comparison_terms: expected, price: '12000001', superseded_at: null }])
    const read = await application().inject({ method: 'GET', url: '/vendor/offer-requests', headers: auth(f.vendor) })
    expect(read.statusCode, read.body).toBe(200)
    expect((read.json() as { id: string; offer: { comparisonTerms: Terms | null } }[]).find(r => r.id === f.request)?.offer.comparisonTerms).toEqual(expected)
  })

  it('every one of seven optional quoted fields is independently retained; omitted others are null', async () => {
    for (const field of FIELDS) {
      const f = await fixture(), response = await answer(f, custom({ comparisonTerms: { [field]: 'quoted ' + field } }))
      expect(response.statusCode, response.body).toBe(201); expect(response.json().comparisonTerms).toEqual({ ...EMPTY, [field]: 'quoted ' + field })
      expect((await stored(f))[0]!.comparison_terms).toEqual({ ...EMPTY, [field]: 'quoted ' + field })
    }
  }, 60_000)

  it('package snapshot and negotiated numeric/string-money totals retain existing behavior with terms', async () => {
    const f = await fixture(), response = await answer(f, { kind: 'offer', packageId: f.vendor.packageId,
      price: { amount: '12000001', currency: 'RUB' }, comparisonTerms: { team: 'Quoted anonymous team' } })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ packageId: f.vendor.packageId, title: 'Synthetic quoted package', includes: ['Literal package service'],
      price: { amount: 12000001, currency: 'RUB' }, comparisonTerms: { ...EMPTY, team: 'Quoted anonymous team' } })
    expect((await stored(f))[0]!.price).toBe('12000001')
    const row = (await db().query<{ package_snapshot: unknown }>('select package_snapshot from offers where id=$1', [response.json().id])).rows[0]!
    expect(row.package_snapshot).toEqual({ id: f.vendor.packageId, name: 'Synthetic quoted package', price: { amount: 10000000, currency: 'RUB' }, includes: ['Literal package service'] })
  })

  it('zero base total and foreign selected package refuse without replacing the current quote', async () => {
    const f = await fixture(), foreign = await vendor(); await prime(f); const before = await snapshot(f)
    const zero = await answer(f, custom({ price: { amount: 0, currency: 'RUB' }, comparisonTerms: { extras: '0' } }))
    expect(zero.statusCode, zero.body).toBe(422); expect(zero.json().error.code).toBe('validation_failed'); expect(await snapshot(f)).toEqual(before)
    const other = await answer(f, { kind: 'offer', packageId: foreign.packageId, price: { amount: 12000001, currency: 'RUB' }, comparisonTerms: { extras: '0' } })
    expect(other.statusCode, other.body).toBe(422)
    expect(other.json()).toEqual({ error: { code: 'unknown_package', message: 'Такого пакета у подрядчика нет', fields: { packageId: 'пакет не найден в вашей анкете' } } })
    expect(await snapshot(f)).toEqual(before)
  })

  it('decline remains null-only output and rejects the new offer-only input field', async () => {
    const f = await fixture(); await prime(f); const before = await snapshot(f)
    const bad = await answer(f, { kind: 'decline', message: 'Synthetic unavailable date', comparisonTerms: { extras: '0' } })
    expect(bad.statusCode, bad.body).toBe(422); expect(bad.json().error.code).toBe('validation_failed'); expect(await snapshot(f)).toEqual(before)
    const good = await answer(f, { kind: 'decline', message: 'Synthetic unavailable date' })
    expect(good.statusCode, good.body).toBe(201)
    expect(good.json()).toMatchObject({ kind: 'decline', packageId: null, title: null, price: null, includes: [], validUntil: null, comparisonTerms: null })
    expect((await stored(f)).find(r => r.id === good.json().id)?.comparison_terms).toBeNull()
  })

  it('revision snapshots are separate; fifth replay stays unchanged and sixth refuses429', async () => {
    const f = await fixture(); let fifth: Response | undefined, fifthPayload: object = {}, fifthKey = ''
    for (let n = 1; n <= 5; n++) {
      const payload = custom({ comparisonTerms: { extras: 'literal version ' + n } }), key = randomUUID()
      const response = await answer(f, payload, key); expect(response.statusCode, response.body).toBe(201)
      if (n === 5) { fifth = response; fifthPayload = payload; fifthKey = key }
    }
    const rows = await stored(f); expect(rows).toHaveLength(5); expect(rows.filter(r => r.superseded_at === null)).toHaveLength(1)
    expect(rows.map(r => r.comparison_terms?.extras)).toEqual([1, 2, 3, 4, 5].map(n => 'literal version ' + n))
    const before = await snapshot(f), replay = await answer(f, fifthPayload, fifthKey)
    expect(replay.statusCode, replay.body).toBe(201); expect(replay.headers['idempotent-replay']).toBe('true'); expect(replay.json()).toEqual(fifth!.json())
    expect(await snapshot(f)).toEqual(before)
    const sixth = await answer(f, custom({ comparisonTerms: { extras: 'literal version 6' } }))
    expect(sixth.statusCode, sixth.body).toBe(429); expect(sixth.json().error).toEqual({ code: 'offer_revisions_limit', message: 'На один запрос можно отправить не более пяти версий за 24 часа' })
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0); expect(await snapshot(f)).toEqual(before)
  })

  it('same key with different raw quote refuses409 rather than replaying a hybrid; original rows remain', async () => {
    const f = await fixture(), key = randomUUID(), payload = custom({ comparisonTerms: { extras: '0' } })
    const response = await answer(f, payload, key); expect(response.statusCode, response.body).toBe(201); const before = await snapshot(f)
    const conflict = await answer(f, custom({ comparisonTerms: { extras: 'different literal quote' } }), key)
    expect(conflict.statusCode, conflict.body).toBe(409); expect(conflict.json().error.code).toBe('idempotency_key_reused')
    expect(await snapshot(f)).toEqual(before)
  })

  it('helper/coordinator and foreign actors never read quoted canaries; foreign reply404 leaves rows intact', async () => {
    const f = await fixture(), helper = await actor(), coordinator = await actor(), outsider = await vendor()
    f.users.push(helper.id, coordinator.id, outsider.id)
    for (const [who, role] of [[helper, 'helper'], [coordinator, 'coordinator']] as const)
      await db().query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [f.wedding, who.id, role])
    const terms = { hours: 'HOURS_' + randomUUID(), team: 'TEAM_' + randomUUID(), result: 'RESULT_' + randomUUID(), delivery: 'DELIVERY_' + randomUUID(),
      extras: 'EXTRAS_' + randomUUID(), cancellation: 'CANCEL_' + randomUUID(), reschedule: 'RESCHEDULE_' + randomUUID() }
    const response = await answer(f, custom({ comparisonTerms: terms })); expect(response.statusCode, response.body).toBe(201)
    const read = (who: Actor) => application().inject({ method: 'GET', url: `/weddings/${f.wedding}/slots/${f.slot}/shortlist`, headers: auth(who) })
    const owner = await read(f.owner); expect(owner.statusCode, owner.body).toBe(200)
    for (const canary of Object.values(terms)) expect(owner.body).toContain(canary)
    for (const who of [helper, coordinator]) {
      const view = await read(who); expect(view.statusCode, view.body).toBe(200)
      const entry = (view.json() as { vendor: { id: string }; request: object }[]).find(r => r.vendor?.id === f.vendor.vendorId)!
      expect(entry.request).toEqual({ status: 'responded' }); for (const canary of Object.values(terms)) expect(view.body).not.toContain(canary)
    }
    const foreignView = await read(outsider); expect(foreignView.statusCode, foreignView.body).toBe(404)
    const cabinet = await application().inject({ method: 'GET', url: '/vendor/offer-requests', headers: auth(outsider) })
    expect(cabinet.statusCode, cabinet.body).toBe(200); expect(cabinet.json()).toEqual([])
    const before = await snapshot(f), refused = await answer(f, custom({ comparisonTerms: { extras: 'foreign injected terms' } }), randomUUID(), outsider)
    expect(refused.statusCode, refused.body).toBe(404); expect(refused.json().error.message).toBe('Запрос не найден'); expect(await snapshot(f)).toEqual(before)
    const notices = (await db().query<{ body: string; title: string }>('select body,title from notifications where user_id=any($1::uuid[])', [[f.owner.id, helper.id, coordinator.id, outsider.id]])).rows
    for (const canary of Object.values(terms)) expect(JSON.stringify(notices)).not.toContain(canary)
    expect((await db().query('select id from notifications where user_id=any($1::uuid[])', [[helper.id, coordinator.id, outsider.id]])).rows).toEqual([])
  })
})
