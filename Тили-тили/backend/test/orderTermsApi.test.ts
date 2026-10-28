import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import { runNativeCalendarHttpPrefixRace, type NativeCalendarHttpIdentity, type NativeCalendarWaitRow } from './helpers/nativeCalendarPrefixRace.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import type { TermsView } from '../src/orders/terms.js'
import { signOrderTermsRead, verifyOrderTermsRead } from '../src/orders/terms-token.js'
import { PAID_SUM } from '../src/deals/repo.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'terms-api-test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const POLICY = '2026-09-02'
interface Actor { id: string; session: string; headers: { authorization: string } }

describe.skipIf(!DB)('actual order terms HTTP, current authority and atomic retry', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort())
    assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_terms_api_20260930_test', '/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'terms-api-refresh-only-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address as string))
    assert.equal(live.port, Number(disposablePgPort())); assert.equal(live.name, target.pathname.slice(1))
  })
  async function cleanupOwnedFixtures(phase: 'case' | 'final') {
    if (!app) return
    const started = Date.now(), stages: Record<string, number> = {}
    let completed = false
    const stage = async (name: string, run: () => Promise<unknown>) => {
      const started = Date.now()
      try { await run() } finally { stages[name] = Date.now() - started }
    }
    try {
      await stage('weddings', () => app.db!.query('delete from weddings where id=any($1::uuid[])', [weddings]))
      await stage('users', async () => {
        for (let offset = 0; offset < users.length; offset += 32) {
          await app.db!.query('delete from users where id=any($1::uuid[])', [users.slice(offset, offset + 32)])
        }
      })
      completed = true
    } finally {
      process.stdout.write('ORDER_TERMS_API_CASE_CLEANUP ' + JSON.stringify({ phase, completed, elapsedMs: Date.now() - started, stages }) + '\n')
    }
  }
  afterEach(async () => { await cleanupOwnedFixtures('case') })
  afterAll(async () => {
    if (!app) return
    try {
      await cleanupOwnedFixtures('final')
      // Append-only audit remains evidence; only these owned mutable fixtures are removed.
      for (const [table, ids] of [['weddings', weddings], ['users', users]] as const) {
        expect((await app.db!.query<{ remaining: number }>(`select count(*)::int remaining from ${table} where id=any($1::uuid[])`, [ids])).rows[0]!.remaining, table).toBe(0)
      }
    } finally {
      const started = Date.now(); let completed = false
      try { await app.close(); completed = true } finally {
        process.stdout.write('ORDER_TERMS_API_POOL_CLOSE ' + JSON.stringify({ completed, elapsedMs: Date.now() - started }) + '\n')
      }
    }
  })
  async function actor(label: string): Promise<Actor> {
    const session = randomUUID()
    let id: string | undefined
    // Synthetic authentication data exercises real guards, not human consent.
    for (let attempt = 0; attempt < 8; attempt++) {
      id = (await app.db!.query<{ id: string }>('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id', [randomUUID(), '+79' + randomInt(100_000_000, 999_999_999), label])).rows[0]?.id
      if (id) break
    }
    if (!id) throw new Error(`Synthetic terms fixture could not allocate a unique phone after 8 attempts (${label})`)
    users.push(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, session, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  async function fixture(external = false) {
    const owner = await actor('Private terms couple'), vendorOwner = await actor('Private terms performer'), helper = await actor('Helper'),
      coordinator = await actor('Coordinator'), outsider = await actor('Outsider'), otherVendorOwner = await actor('Other profile')
    const wedding = randomUUID(), slot = randomUUID(), deal = randomUUID(), vendor = randomUUID(); weddings.push(wedding)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Terms API','2027-06-14','Europe/Moscow',$3)", [wedding, owner.id, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper'),($1,$4,'coordinator')", [wedding, owner.id, helper.id, coordinator.id])
    const otherVendor = randomUUID()
    await app.db!.tx(async client => {
      const scope = await prepareLegacyCalendarScope(client, {
        vendorIds: [vendor, otherVendor], personIds: [vendorOwner.id, otherVendorOwner.id],
      })
      await client.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Private terms studio',now()),($3,$4,'photo','Other profile',now())", [vendor, vendorOwner.id, otherVendor, otherVendorOwner.id])
      await scope.assertCurrent()
    })
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photographer')", [slot, wedding])
    await app.db!.query(`insert into deals(id,wedding_id,slot_id,vendor_id,external_name,state,price,package_title_snapshot,package_includes_snapshot)
      values($1,$2,$3,$4,$5,'booked',9007199254740993,'Private frozen package','["Frozen gallery"]')`, [deal, wedding, slot, external ? null : vendor, external ? 'Private external contact' : null])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slot, deal])
    if (!external) await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2)", [vendor, deal])
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',2500000,'recorded','cash','private')", [randomUUID(), deal])
    // Explicit synthetic inherited WP03 ledger; never evidence of human reading
    // and never a substitute for actual terms acceptance through HTTP.
    const version = (await app.db!.query('select timeline_version::text from weddings where id=$1', [wedding])).rows[0]!.timeline_version as string
    const historical = { syntheticInheritedFixture: true, sourceVersion: version, blocks: [] }, digest = createHash('sha256').update(JSON.stringify(historical)).digest('hex')
    if (!external) await app.db!.query('insert into vendor_program_acknowledgments(wedding_id,vendor_id,user_id,session_id,version,digest,program_snapshot) values($1,$2,$3,$4,$5,$6,$7::jsonb)', [wedding, vendor, vendorOwner.id, vendorOwner.session, version, digest, JSON.stringify(historical)])
    else {
      const identity = randomUUID()
      await app.db!.query("insert into external_invites(token,wedding_id,slot_id,expires_at,program_identity,program_deal_id) values($1,$2,$3,now()+interval '1 day',$4,$5)", [randomUUID(), wedding, slot, identity, deal])
      await app.db!.query('update deals set current_program_invite_id=$2 where id=$1', [deal, identity])
      await app.db!.query('insert into external_program_acknowledgments(wedding_id,invite_id,deal_id,version,digest,program_snapshot) values($1,$2,$3,$4,$5,$6::jsonb)', [wedding, identity, deal, version, digest, JSON.stringify(historical)])
    }
    return { wedding, slot, deal, vendor, owner, vendorOwner, helper, coordinator, outsider, otherVendorOwner, path: `/deals/${deal}/order/terms` }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const read = (f: Fixture, user = f.owner, termsId?: string) => app.inject({ url: f.path + (termsId ? `?termsId=${termsId}` : ''), headers: user.headers })
  const post = (f: Fixture, suffix: string, payload: object, user = f.owner, key: string | null = randomUUID()) => app.inject({ method: 'POST', url: f.path + suffix, headers: { ...user.headers, ...(key === null ? {} : { 'idempotency-key': key }) }, payload })
  const proposalBody = { expectedOrderVersion: '1', expectedTermsRevision: '0' }
  const proposal = (f: Fixture, user = f.owner, key: string | null = randomUUID(), payload: object = proposalBody) => post(f, '/proposals', payload, user, key)
  async function view(f: Fixture, user = f.owner, termsId?: string): Promise<TermsView> {
    const reply = await read(f, user, termsId); expect(reply.statusCode, reply.body).toBe(200); expect(reply.headers['cache-control']).toBe('no-store'); return reply.json<TermsView>()
  }
  function acceptance(v: TermsView) { return { expectedTermsVersion: v.selected!.version, digest: v.selected!.digest, readToken: v.readToken! } }
  const accept = (f: Fixture, v: TermsView, user = f.owner, key: string | null = randomUUID(), payload: object = acceptance(v)) => post(f, `/${v.selected!.id}/accept`, payload, user, key)
  function ok(reply: { statusCode: number; body: string; headers: Record<string, unknown>; json<T>(): T }): TermsView {
    expect(reply.statusCode, reply.body).toBe(200); expect(reply.headers['cache-control']).toBe('no-store'); return reply.json<TermsView>()
  }
  const denied = (reply: { statusCode: number; body: string; headers: Record<string, unknown> }, status: number) => {
    expect(reply.statusCode, reply.body).toBe(status); expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.body).not.toContain('Private frozen package'); expect(reply.body).not.toContain('Frozen gallery')
  }
  async function state(f: Fixture) {
    return (await app.db!.query(`select to_jsonb(o) root,
      (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from deal_terms_versions t where t.deal_id=$1) terms,
      (select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from deal_terms_receipts r where r.deal_id=$1) receipts,
      (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from audit_log a where a.entity_id=$1) audit,
      (select coalesce(jsonb_agg(to_jsonb(k) order by k.key),'[]') from idempotency_keys k where k.user_id=any($2::uuid[])) keys
      from deal_orders o where o.deal_id=$1`, [f.deal, [f.owner.id, f.vendorOwner.id]])).rows[0]
  }
  async function ledger(f: Fixture) {
    return (await app.db!.query(`select (select jsonb_agg(to_jsonb(d)) from deals d where d.id=$1) deal,
      (select jsonb_agg(to_jsonb(p) order by p.id) from payments p where p.deal_id=$1) payments,
      (select jsonb_agg(to_jsonb(b) order by b.date) from vendor_busy_dates b where b.deal_id=$1) holds,
      (select jsonb_agg(to_jsonb(a) order by a.vendor_id,a.version) from vendor_program_acknowledgments a where a.wedding_id=$2) program,
      (select jsonb_agg(to_jsonb(a) order by a.invite_id,a.version) from external_program_acknowledgments a where a.wedding_id=$2) external_program`, [f.deal, f.wedding])).rows[0]
  }

  it('FR015 agreed contract rejects direct repricing without changing the exact financial root', async () => {
    const f = await fixture(), published = ok(await proposal(f))
    const customer = await view(f), performer = await view(f, f.vendorOwner)
    ok(await accept(f, customer)); const agreed = ok(await accept(f, performer, f.vendorOwner))
    expect(agreed.agreedTermsId).toBe(published.selected!.id)
    const before = (await app.db!.query<{ row: string; price: string }>('select to_jsonb(d)::text row,price::text price from deals d where id=$1', [f.deal])).rows[0]!
    expect(before.price).toBe('9007199254740993')
    const response = await app.inject({ method: 'PATCH', url: `/deals/${f.deal}`,
      headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: { price: { amount: 6_000_000, currency: 'RUB' } } })
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('price_locked')
    expect((await app.db!.query<{ row: string; price: string }>('select to_jsonb(d)::text row,price::text price from deals d where id=$1', [f.deal])).rows[0]).toEqual(before)
  })

  it('actual publish/read/two-party accept preserves exact money, holds and nonempty inherited program history', async () => {
    const f = await fixture(), before = await ledger(f), published = ok(await proposal(f))
    expect(published).toMatchObject({ revision: '1', readToken: null, agreedTermsId: null, acceptedByCaller: false })
    expect(published.selected?.snapshot).toMatchObject({ source: 'legacy', assignments: [], parts: [], economics: { amount: '9007199254740993' } })
    expect(published.selected?.receipts).toEqual([])
    const customer = await view(f), performer = await view(f, f.vendorOwner)
    const clock = (await app.db!.query<{ now: Date }>('select clock_timestamp() now')).rows[0]!.now
    expect(await verifyOrderTermsRead(SECRET, customer.readToken!, clock)).toMatchObject({ purpose: 'order-terms-read', userId: f.owner.id, sessionId: f.owner.session, weddingId: f.wedding, dealId: f.deal, termsId: published.selected!.id, version: '1', digest: published.selected!.digest, policyVersion: POLICY })
    const first = ok(await accept(f, customer)); expect(first.readToken).toBeNull(); expect(first.agreedTermsId).toBeNull()
    const final = ok(await accept(f, performer, f.vendorOwner)); expect(final.readToken).toBeNull(); expect(final.agreedTermsId).toBe(final.proposedTermsId)
    expect(final.selected?.receipts.map(r => ({ party: r.party, userId: r.userId, sessionId: r.sessionId, digest: r.digest }))).toEqual([
      { party: 'customer', userId: f.owner.id, sessionId: f.owner.session, digest: customer.selected!.digest },
      { party: 'performer', userId: f.vendorOwner.id, sessionId: f.vendorOwner.session, digest: performer.selected!.digest }])
    expect(before!.program).toHaveLength(1); expect(await ledger(f)).toEqual(before)
  })
  it.each(['helper', 'coordinator', 'outsider', 'otherVendorOwner'] as const)('%s cannot read, publish or accept private conditions', async role => {
    const f = await fixture(); ok(await proposal(f)); const v = await view(f), before = await state(f)
    denied(await read(f, f[role]), 404); denied(await proposal(f, f[role]), 404); denied(await accept(f, v, f[role]), 404)
    expect(await state(f)).toEqual(before)
  })
  it('pending invitation and foreign version query do not grant access', async () => {
    const f = await fixture(), other = await fixture(); ok(await proposal(f)); const foreign = ok(await proposal(other))
    await app.db!.query("insert into invites(code,wedding_id,role,created_by,expires_at) values($1,$2,'couple',$3,now()+interval '1 day')", [randomUUID(), f.wedding, f.owner.id])
    denied(await read(f, f.outsider), 404); denied(await read(f, f.owner, foreign.selected!.id), 404)
    denied(await app.inject({ url: `${f.path}?termsId=invalid`, headers: f.owner.headers }), 422)
    denied(await app.inject({ url: `${f.path}?unexpected=1`, headers: f.owner.headers }), 422)
    denied(await app.inject({ url: f.path }), 401)
  })
  it('version checks are exact; same-current proposal is no-op, new proposal preserves prior agreement and receipts', async () => {
    const f = await fixture(); const first = ok(await proposal(f, f.vendorOwner)); expect(first.selected?.publishedSide).toBe('performer')
    denied(await proposal(f), 409)
    expect(ok(await proposal(f, f.owner, randomUUID(), { ...proposalBody, expectedTermsRevision: '1' })).revision).toBe('1')
    ok(await accept(f, await view(f))); const agreed = ok(await accept(f, await view(f, f.vendorOwner), f.vendorOwner))
    const draft = await app.inject({ method: 'PATCH', url: `/deals/${f.deal}/order/brief`, headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: { expectedVersion: '1', brief: { values: {} } } })
    expect(draft.statusCode, draft.body).toBe(200)
    const next = ok(await proposal(f, f.owner, randomUUID(), { expectedOrderVersion: '2', expectedTermsRevision: '1' }))
    expect(next.agreedTermsId).toBe(agreed.agreedTermsId); expect(next.selected?.receipts).toEqual([])
    expect((await view(f, f.owner, agreed.agreedTermsId!)).readToken).toBeNull()
    expect(next.history.find(t => t.id === agreed.agreedTermsId)?.receipts).toHaveLength(2)
  })
  it.each(['price', 'payments', 'snapshot', 'actor', 'weddingId', 'termsId'] as const)('client %s fields cannot overwrite database source through proposal or acceptance', async field => {
    const f = await fixture(), before = await state(f)
    denied(await proposal(f, f.owner, randomUUID(), { ...proposalBody, [field]: { price: 1, payments: [] } }), 422)
    expect(await state(f)).toEqual(before)
    ok(await proposal(f)); const v = await view(f), after = await state(f)
    denied(await accept(f, v, f.owner, randomUUID(), { ...acceptance(v), [field]: { price: 1, payments: [] } }), 422)
    expect(await state(f)).toEqual(after)
  })
  it('response-loss retry returns exact original bodies and creates neither extra version nor receipt', async () => {
    const f = await fixture(), key = randomUUID(), first = ok(await proposal(f, f.owner, key))
    // Simulate the caller losing the committed response, then retry exact HTTP.
    const before = await state(f); expect(ok(await proposal(f, f.owner, key))).toEqual(first); expect(await state(f)).toEqual(before)
    const v = await view(f), acceptKey = randomUUID(), accepted = ok(await accept(f, v, f.owner, acceptKey)), after = await state(f)
    expect(ok(await accept(f, v, f.owner, acceptKey))).toEqual(accepted); expect(await state(f)).toEqual(after)
    denied(await proposal(f, f.owner, key, { ...proposalBody, expectedTermsRevision: '1' }), 409)
    denied(await accept(f, v, f.owner, acceptKey, { ...acceptance(v), digest: 'b'.repeat(64) }), 409)
    const other = await fixture()
    denied(await proposal(other, f.owner, key), 404)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [other.wedding, f.owner.id])
    denied(await proposal(other, f.owner, key), 409)
  })
  it('same client key is isolated by actual actor; proof still cannot cross party/session', async () => {
    const f = await fixture(), key = randomUUID(); ok(await proposal(f)); const customer = await view(f), performer = await view(f, f.vendorOwner)
    const first = ok(await accept(f, customer, f.owner, key)); expect(first.selected?.receipts).toHaveLength(1)
    denied(await accept(f, customer, f.vendorOwner, key), 422)
    const second = ok(await accept(f, performer, f.vendorOwner, key)); expect(second.selected?.receipts).toHaveLength(2)
    const session = randomUUID(); await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, f.owner.id, randomUUID()])
    const otherSession: Actor = { ...f.owner, session, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: f.owner.id, sid: session })}` } }
    denied(await accept(f, customer, otherSession), 422)
  })
  it('another couple member does not acquire a fabricated personal receipt from existing customer consent', async () => {
    const f = await fixture(), partner = await actor('Another actual couple member'); ok(await proposal(f))
    const accepted = ok(await accept(f, await view(f)))
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [f.wedding, partner.id])
    const partnerRead = await view(f, partner)
    expect(partnerRead.acceptedByCaller).toBe(false)
    const repeated = ok(await accept(f, partnerRead, partner))
    expect(repeated.acceptedByCaller).toBe(false); expect(repeated.selected?.receipts).toEqual(accepted.selected?.receipts)
    expect(repeated.selected?.receipts[0]?.userId).toBe(f.owner.id)
  })
  it.each(['publish', 'accept'] as const)('%s requires explicit idempotency key', async command => {
    const f = await fixture()
    if (command === 'publish') denied(await proposal(f, f.owner, null), 400)
    else { ok(await proposal(f)); denied(await accept(f, await view(f), f.owner, null), 400) }
  })
  it.each(['userId', 'sessionId', 'weddingId', 'dealId', 'termsId', 'version', 'digest', 'policyVersion', 'purpose'] as const)('actual API rejects server-signed proof with wrong %s', async field => {
    const f = await fixture(); ok(await proposal(f)); const v = await view(f), clock = (await app.db!.query<{ now: Date }>('select clock_timestamp() now')).rows[0]!.now
    const claims = await verifyOrderTermsRead(SECRET, v.readToken!, clock), before = await state(f)
    const value = field === 'version' ? '2' : field === 'digest' ? 'b'.repeat(64) : field === 'policyVersion' ? 'old-policy' : field === 'purpose' ? 'program-read' : randomUUID()
    const wrong = await signOrderTermsRead(SECRET, { ...claims, [field]: value }, clock)
    denied(await accept(f, v, f.owner, randomUUID(), { ...acceptance(v), readToken: wrong }), 422); expect(await state(f)).toEqual(before)
  })
  it('expired proof and superseded proposal require another current read', async () => {
    const f = await fixture(); ok(await proposal(f)); const v = await view(f), clock = (await app.db!.query<{ now: Date }>('select clock_timestamp() now')).rows[0]!.now
    const claims = await verifyOrderTermsRead(SECRET, v.readToken!, clock), expired = await signOrderTermsRead(SECRET, claims, new Date(clock.getTime() - 601000))
    const rejected = await accept(f, v, f.owner, randomUUID(), { ...acceptance(v), readToken: expired }); denied(rejected, 409); expect(rejected.json().error.code).toBe('terms_read_expired')
    await app.db!.query("update deals set price=6000000 where id=$1", [f.deal]); const stale = await view(f)
    expect(stale.readToken).toBeNull(); expect(stale.selected?.freshness).toBe('stale'); denied(await accept(f, v), 409)
    ok(await proposal(f, f.owner, randomUUID(), { ...proposalBody, expectedTermsRevision: '1' })); denied(await accept(f, v), 409)
  })
  it.each(['event', 'package_snapshot', 'brief', 'part'] as const)('HTTP read and accept reject stale %s material source', async kind => {
    const f = await fixture(); ok(await proposal(f)); const v = await view(f)
    // Main-event material facts follow the guarded wedding source, not a
    // direct edit that would violate the canonical main-event constraint.
    if (kind === 'event') await app.db!.query("update weddings set venue='Changed canonical hall' where id=$1", [f.wedding])
    if (kind === 'package_snapshot') await app.db!.query("update deals set package_title_snapshot='Changed frozen package' where id=$1", [f.deal])
    if (kind === 'brief' || kind === 'part') {
      const response = await app.inject({ method: kind === 'brief' ? 'PATCH' : 'POST', url: `/deals/${f.deal}/order/${kind === 'brief' ? 'brief' : 'parts'}`,
        headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: kind === 'brief'
          ? { expectedVersion: '1', brief: { values: {} } }
          : { expectedVersion: '1', kind: 'deliverable', title: 'New gallery obligation', details: { items: ['Gallery'] } } })
      expect(response.statusCode, response.body).toBe(200)
    }
    const stale = await view(f); expect(stale.selected?.freshness).toBe('stale'); expect(stale.readToken).toBeNull()
    const before = await state(f); denied(await accept(f, v), 409); expect(await state(f)).toEqual(before)
  })
  it('unknown actual money and package facts remain explicit nulls in HTTP snapshots', async () => {
    const f = await fixture()
    await app.db!.query('update deals set price=null,package_title_snapshot=null,package_includes_snapshot=null where id=$1', [f.deal])
    const published = ok(await proposal(f))
    expect(published.selected?.snapshot).toMatchObject({ brief: null, economics: { amount: null, amountKnown: false, package: { id: null, titleSnapshot: null, includesSnapshot: null } } })
    expect((await view(f)).readToken).toEqual(expect.any(String))
  })
  it('invalid draft keeps immutable history readable, no token and strict publication/acceptance refusal', async () => {
    const f = await fixture(); ok(await proposal(f)); const v = await view(f); ok(await accept(f, v)); const agreement = ok(await accept(f, await view(f, f.vendorOwner), f.vendorOwner))
    await app.db!.query("update deal_orders set brief_category_id='photo',brief='{\"unknownField\":true}' where deal_id=$1", [f.deal])
    const invalid = await view(f)
    expect(invalid.agreedTermsId).toBe(agreement.agreedTermsId); expect(invalid.readToken).toBeNull(); expect(invalid.selected?.freshness).toBe('invalid')
    expect(invalid.selected?.receipts).toEqual(agreement.selected?.receipts)
    denied(await proposal(f, f.owner, randomUUID(), { ...proposalBody, expectedTermsRevision: '1' }), 422); denied(await accept(f, v), 422)
  })
  it.each([null, 'short', 'x'.repeat(64)])('missing/weak trusted proof config refuses all terms operations %#', async secret => {
    const f = await fixture(); ok(await proposal(f)); const v = await view(f), before = await state(f), previous = app.appConfig.jwtAccessSecret
    // Authentication retains its initial trusted signing key; only the terms
    // configuration is removed to exercise unavailable proof without fake ACL.
    app.appConfig.jwtAccessSecret = secret
    try {
      denied(await read(f), 503); denied(await proposal(f, f.owner, randomUUID(), { ...proposalBody, expectedTermsRevision: '1' }), 503); denied(await accept(f, v), 503)
      expect(await state(f)).toEqual(before)
    } finally { app.appConfig.jwtAccessSecret = previous }
  })
  it('external contact has no performer account or fabricated receipt; inherited external program stays separate', async () => {
    const f = await fixture(true), before = await ledger(f); ok(await proposal(f)); const final = ok(await accept(f, await view(f)))
    expect(final.agreedTermsId).toBeNull(); expect(final.selected?.receipts.map(r => r.party)).toEqual(['customer'])
    denied(await read(f, f.vendorOwner), 404); denied(await accept(f, await view(f), f.vendorOwner), 404)
    expect(before!.external_program).toHaveLength(1); expect(await ledger(f)).toEqual(before)
  })

  type Revocation = 'membership' | 'session' | 'consent' | 'vendor_owner' | 'vendor_blocked' | 'account' | 'wedding' | 'deal'
  const statuses: Record<Revocation, number> = { membership: 404, session: 401, consent: 403, vendor_owner: 404, vendor_blocked: 404, account: 401, wedding: 404, deal: 403 }
  // A changed owner expands the schema94 parent union before the inner ACL.
  function deniedAfterCalendarWait(reply: Parameters<typeof denied>[0], kind: Revocation): void {
    denied(reply, kind === 'vendor_owner' ? 409 : statuses[kind])
    if (kind === 'vendor_owner') expect(JSON.parse(reply.body)).toMatchObject({ error: { code: 'calendar_scope_changed' } })
  }
  async function revoke(c: Queryable, f: Fixture, kind: Revocation) {
    if (kind === 'membership') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [f.wedding, f.owner.id])
    if (kind === 'session') await c.query('update sessions set revoked_at=now() where id=$1', [f.owner.session])
    if (kind === 'consent') await c.query('update consents set withdrawn_at=now() where user_id=$1', [f.owner.id])
    if (kind === 'vendor_owner') await c.query('update vendors set user_id=$2 where id=$1', [f.vendor, f.outsider.id])
    if (kind === 'vendor_blocked') await c.query('update vendors set blocked_at=now() where id=$1', [f.vendor])
    if (kind === 'account') await c.query('update users set deleted_at=now() where id=$1', [f.owner.id])
    if (kind === 'wedding') await c.query('update weddings set cancelled_at=now() where id=$1', [f.wedding])
    if (kind === 'deal') await c.query("update deals set state='cancelled' where id=$1", [f.deal])
  }
  async function observeOrderHttpPrefix(c: Queryable, holder: NativeCalendarHttpIdentity,
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
  async function lockTermsInvalidation(c: Queryable, f: Fixture, kind: Revocation) {
    const caller = kind.startsWith('vendor_') ? f.vendorOwner : f.owner
    await prepareLegacyCalendarScope(c, { weddingIds: [f.wedding],
      actor: { userId: caller.id, sessionId: caller.session, policyVersion: POLICY },
      ...(kind === 'vendor_owner' ? { extraAccountIds: [f.outsider.id], personIds: [f.vendorOwner.id, f.outsider.id] } : {}) })
    // Acquire the actual mutation target in strongest mode before HTTP can hold its SHARE.
    const target: Record<Revocation, { sql: string; values: string[] }> = {
      membership: { sql: 'select user_id from wedding_members where wedding_id=$1 and user_id=$2 for update', values: [f.wedding, f.owner.id] },
      session: { sql: 'select id from sessions where id=$1 for update', values: [f.owner.session] },
      consent: { sql: 'select user_id from consents where user_id=$1 for update', values: [f.owner.id] },
      vendor_owner: { sql: 'select id from vendors where id=$1 for update', values: [f.vendor] },
      vendor_blocked: { sql: 'select id from vendors where id=$1 for update', values: [f.vendor] },
      account: { sql: 'select id from users where id=$1 for update', values: [f.owner.id] },
      wedding: { sql: 'select id from weddings where id=$1 for update', values: [f.wedding] },
      deal: { sql: 'select id from deals where id=$1 for update', values: [f.deal] },
    }
    expect((await c.query(target[kind].sql, target[kind].values)).rowCount).toBeGreaterThan(0)
  }
  async function whileLocked<T>(f: Fixture, kind: Revocation, start: () => PromiseLike<T>,
    change: (c: Queryable) => Promise<void>): Promise<T> {
    const result = await runNativeCalendarHttpPrefixRace<T>(app.db!,
      { weddingId: f.wedding, dealId: f.deal, caseName: 'orderTermsApi/' + kind },
      c => lockTermsInvalidation(c, f, kind), change, [{ label: kind, start }], observeOrderHttpPrefix)
    expect(result.mutationCommitted).toBe(true); expect(result.replies).toHaveLength(1)
    return result.replies[0]!
  }

  const revocations: Revocation[] = ['membership', 'session', 'consent', 'vendor_owner', 'vendor_blocked', 'account', 'wedding', 'deal']
  it.each(revocations)('actual waiting fresh accept rechecks %s instead of creating consent', async kind => {
    const f = await fixture(); ok(await proposal(f)); const user = kind.startsWith('vendor_') ? f.vendorOwner : f.owner, v = await view(f, user), before = await state(f)
    deniedAfterCalendarWait(await whileLocked(f, kind, () => accept(f, v, user), c => revoke(c, f, kind)), kind); expect(await state(f)).toEqual(before)
  })
  it.each(revocations)('actual waiting saved proposal replay rechecks %s before returning private saved body', async kind => {
    const f = await fixture(), user = kind.startsWith('vendor_') ? f.vendorOwner : f.owner, key = randomUUID(); ok(await proposal(f, user, key)); const before = await state(f)
    deniedAfterCalendarWait(await whileLocked(f, kind, () => proposal(f, user, key), c => revoke(c, f, kind)), kind); expect(await state(f)).toEqual(before)
  })
  it.each(revocations)('actual waiting saved acceptance replay rechecks %s without reporting cached success to revoked caller', async kind => {
    const f = await fixture(), user = kind.startsWith('vendor_') ? f.vendorOwner : f.owner, key = randomUUID(); ok(await proposal(f))
    const v = await view(f, user); ok(await accept(f, v, user, key)); const before = await state(f)
    deniedAfterCalendarWait(await whileLocked(f, kind, () => accept(f, v, user, key), c => revoke(c, f, kind)), kind); expect(await state(f)).toEqual(before)
  })
  it.each(['membership', 'session', 'consent', 'vendor_owner'] as const)('actual waiting history GET rechecks %s before exposing immutable private history', async kind => {
    const f = await fixture(), user = kind === 'vendor_owner' ? f.vendorOwner : f.owner; ok(await proposal(f)); const before = await state(f)
    deniedAfterCalendarWait(await whileLocked(f, kind, () => read(f, user), c => revoke(c, f, kind)), kind); expect(await state(f)).toEqual(before)
  })
  it.each(['order.terms_published', 'order.terms_accepted'] as const)('%s audit failure rolls back action AND saved replay; same key retries afterwards', async action => {
    const f = await fixture(), key = randomUUID(); let v: TermsView | null = null
    if (action === 'order.terms_accepted') { ok(await proposal(f)); v = await view(f) }
    const before = await state(f), finances = await ledger(f), suffix = randomUUID().replaceAll('-', ''), fn = `terms_api_fail_${suffix}`, trigger = `terms_api_audit_${suffix}`
    const run = () => v ? accept(f, v, f.owner, key) : proposal(f, f.owner, key)
    await app.db!.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if NEW.entity_id='${f.deal}'::uuid and NEW.action='${action}' then raise exception 'Synthetic terms API audit failure'; end if; return NEW; end $$`)
    try {
      await app.db!.query(`create trigger ${trigger} before insert on audit_log for each row execute function ${fn}()`)
      const response = await run(); denied(response, 500); expect(response.body).not.toContain('Synthetic terms API audit failure')
      expect(await state(f)).toEqual(before); expect(await ledger(f)).toEqual(finances)
    } finally { await app.db!.query(`drop trigger if exists ${trigger} on audit_log`); await app.db!.query(`drop function ${fn}()`) }
    ok(await run()); expect((await app.db!.query('select 1 from audit_log where entity_id=$1 and action=$2', [f.deal, action])).rowCount).toBe(1)
  })

  describe('FR015 agreed contract price guard', () => {
    const priceChange = { price: { amount: 6_000_000, currency: 'RUB' } }
    const ownActors = (f: Fixture) => [f.owner.id, f.vendorOwner.id, f.helper.id, f.coordinator.id, f.outsider.id, f.otherVendorOwner.id]
    const patchFinancial = (f: Fixture, payload: object, user = f.owner, key = randomUUID()) =>
      app.inject({ method: 'PATCH', url: '/deals/' + f.deal, headers: { ...user.headers, 'idempotency-key': key }, payload })
    type FinancialReply = Awaited<ReturnType<typeof patchFinancial>>
    const rejectFinancial = (reply: FinancialReply, status: number, code: string) => {
      expect(reply.statusCode, reply.body).toBe(status)
      expect(reply.json().error.code).toBe(code)
      expect(reply.headers['idempotent-replay']).toBeUndefined()
      expect(reply.body).not.toContain('Private frozen package')
    }
    async function rawFinancial(f: Fixture) {
      // Keep financial/history aggregates as SQL text: pg JSON parsing loses BIGINT precision.
      const { rows } = await app.db!.query<Record<string, string | null>>(
        `SELECT d.price::text price,d.state::text state,${PAID_SUM}::text paid,to_jsonb(d)::text deal,
          (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb)::text FROM slots s WHERE s.wedding_id=$2 AND s.deal_id=$1) slots,
          (SELECT to_jsonb(o)::text FROM deal_orders o WHERE o.wedding_id=$2 AND o.deal_id=$1) head,
          (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb)::text FROM deal_terms_versions t WHERE t.wedding_id=$2 AND t.deal_id=$1) terms,
          (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb)::text FROM deal_terms_receipts r WHERE r.wedding_id=$2 AND r.deal_id=$1) receipts,
          (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb)::text FROM payments p WHERE p.deal_id=$1) payments,
          (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb)::text FROM payment_installments i WHERE i.deal_id=$1) installments,
          (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id),'[]'::jsonb)::text FROM payment_corrections h WHERE h.wedding_id=$2 AND h.deal_id=$1) payment_corrections,
          (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id),'[]'::jsonb)::text FROM payment_installment_edits h WHERE h.wedding_id=$2 AND h.deal_id=$1) installment_edits,
          (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb)::text FROM deal_events e WHERE e.deal_id=$1) events,
          (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.date,b.vendor_id),'[]'::jsonb)::text FROM vendor_busy_dates b WHERE b.deal_id=$1) holds,
          (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.vendor_id,a.version),'[]'::jsonb)::text FROM vendor_program_acknowledgments a WHERE a.wedding_id=$2) program,
          (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.invite_id,a.version),'[]'::jsonb)::text FROM external_program_acknowledgments a WHERE a.wedding_id=$2) external_program,
          (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb)::text FROM audit_log a WHERE a.actor_id=any($3::uuid[])) audit,
          (SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY k.key),'[]'::jsonb)::text FROM idempotency_keys k WHERE k.user_id=any($3::uuid[])) keys
         FROM deals d WHERE d.id=$1 AND d.wedding_id=$2`, [f.deal, f.wedding, ownActors(f)])
      expect(rows).toHaveLength(1)
      return rows[0]!
    }
    async function seedNativeFinancialHistory(f: Fixture) {
      // Actual manual/schedule APIs on synthetic fixtures; no bank/provider confirmation.
      const created = await app.inject({ method: 'POST', url: '/weddings/' + f.wedding + '/payment-schedule',
        headers: { ...f.owner.headers, 'idempotency-key': randomUUID() },
        payload: { dealId: f.deal, title: 'Synthetic FR015 schedule', due: '2027-06-14', amount: { amount: 5_000_000, currency: 'RUB' } } })
      expect(created.statusCode, created.body).toBe(201)
      const stageId = created.json().id as string
      const stageVersion = (await app.db!.query<{ version: number }>('select version from payment_installments where id=$1 and deal_id=$2', [stageId, f.deal])).rows[0]!.version
      const edited = await app.inject({ method: 'PATCH', url: '/weddings/' + f.wedding + '/payment-schedule/' + stageId,
        headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: { version: stageVersion, title: 'Synthetic FR015 edited schedule' } })
      expect(edited.statusCode, edited.body).toBe(200)
      const payment = (await app.db!.query<{ id: string; plan_version: number }>('select id,plan_version from payments where deal_id=$1 order by id', [f.deal])).rows[0]!
      const corrected = await app.inject({ method: 'PATCH', url: '/weddings/' + f.wedding + '/payments/' + payment.id,
        headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: { version: payment.plan_version, amountKnown: true,
          amount: { amount: 2_400_000, currency: 'RUB' }, paymentMethod: 'bank_transfer',
          paidOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), reason: 'Synthetic FR015 fixture correction' } })
      expect(corrected.statusCode, corrected.body).toBe(200)
      expect((await app.db!.query<{ n: string }>('select count(*)::text n from payment_corrections where deal_id=$1', [f.deal])).rows[0]!.n).toBe('1')
      expect((await app.db!.query<{ n: string }>('select count(*)::text n from payment_installment_edits where deal_id=$1', [f.deal])).rows[0]!.n).toBe('1')
      expect((await rawFinancial(f)).state).toBe('booked')
    }
    async function agreeFinancialTerms(f: Fixture) {
      const published = ok(await proposal(f)), customer = await view(f), performer = await view(f, f.vendorOwner)
      ok(await accept(f, customer))
      const agreed = ok(await accept(f, performer, f.vendorOwner))
      expect(agreed.agreedTermsId).toBe(published.selected!.id)
      expect(agreed.selected!.receipts.map(r => r.party).sort()).toEqual(['customer', 'performer'])
      return agreed
    }
    const unchangedPayments = (before: Record<string, string | null>, after: Record<string, string | null>) => {
      for (const field of ['paid', 'payments', 'installments', 'payment_corrections', 'installment_edits', 'holds', 'program', 'external_program']) expect(after[field], field).toBe(before[field])
    }
    async function queuedFinancialCommands(f: Fixture, order: string,
      first: { label: string; run: () => PromiseLike<FinancialReply> },
      second: { label: string; run: () => PromiseLike<FinancialReply> }) {
      const result = await runNativeCalendarHttpPrefixRace<FinancialReply>(app.db!,
        { weddingId: f.wedding, dealId: f.deal, caseName: 'FR015/' + order }, async c => {
          await prepareLegacyCalendarScope(c, { weddingIds: [f.wedding],
            actor: { userId: f.owner.id, sessionId: f.owner.session, policyVersion: POLICY },
            extraAccountIds: [f.vendorOwner.id] })
          expect((await c.query('select id from weddings where id=$1 for update', [f.wedding])).rows).toEqual([{ id: f.wedding }])
        }, null, [{ label: first.label, start: first.run }, { label: second.label, start: second.run }], observeOrderHttpPrefix)
      expect(result.replies).toHaveLength(2); expect(result.witnesses).toHaveLength(2)
      expect(result.mutationCommitted).toBe(false)
      process.stdout.write('FR015_PG_FINANCIAL_QUEUE ' + JSON.stringify({ order,
        holderPid: result.witnesses[0]!.holder.pid, first: result.witnesses[0], second: result.witnesses[1] }) + '\n')
      return [result.replies[0]!, result.replies[1]!] as const
    }

    it.each(['legacy', 'proposal', 'customer'] as const)('FR015 %s booked price remains editable before the first two-party agreement', async phase => {
      const f = await fixture()
      if (phase !== 'legacy') ok(await proposal(f))
      if (phase === 'customer') ok(await accept(f, await view(f)))
      const before = await rawFinancial(f), reply = await patchFinancial(f, priceChange)
      expect(reply.statusCode, reply.body).toBe(200)
      const after = await rawFinancial(f)
      expect(after.price).toBe('6000000'); expect(after.state).toBe('booked'); unchangedPayments(before, after)
      expect((await app.db!.query<{ agreed: string | null }>('select (select agreed_terms_id from deal_orders where wedding_id=$1 and deal_id=$2) agreed', [f.wedding, f.deal])).rows[0]!.agreed).toBeNull()
      expect((await app.db!.query<{ n: string }>("select count(*)::text n from deal_events where deal_id=$1 and kind='price'", [f.deal])).rows[0]!.n).toBe('1')
    })
    it('FR015 rejects direct safe price after actual both-party agreement and preserves raw money, schedule and history', async () => {
      const f = await fixture(); await seedNativeFinancialHistory(f); await agreeFinancialTerms(f)
      const before = await rawFinancial(f), key = randomUUID()
      expect(before.price).toBe('9007199254740993'); expect(before.paid).toBe('2400000')
      rejectFinancial(await patchFinancial(f, priceChange, f.owner, key), 409, 'price_locked'); expect(await rawFinancial(f)).toEqual(before)
      rejectFinancial(await patchFinancial(f, priceChange, f.owner, key), 409, 'price_locked'); expect(await rawFinancial(f)).toEqual(before)
      expect((await app.db!.query('select key from idempotency_keys where key=$1', [f.owner.id + ':deals.patch:' + key])).rows).toEqual([])
    })
    it('FR015 a new unaccepted proposal cannot unlock the previous agreed contract price', async () => {
      const f = await fixture(), agreed = await agreeFinancialTerms(f)
      const draft = await app.inject({ method: 'PATCH', url: '/deals/' + f.deal + '/order/brief',
        headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: { expectedVersion: '1', brief: { values: {} } } })
      expect(draft.statusCode, draft.body).toBe(200)
      const next = ok(await proposal(f, f.owner, randomUUID(), { expectedOrderVersion: '2', expectedTermsRevision: '1' }))
      expect(next.agreedTermsId).toBe(agreed.agreedTermsId); expect(next.proposedTermsId).not.toBe(next.agreedTermsId)
      expect(next.selected!.receipts).toEqual([]); expect(next.history.find(t => t.id === agreed.agreedTermsId)!.receipts).toHaveLength(2)
      const before = await rawFinancial(f)
      rejectFinancial(await patchFinancial(f, priceChange), 409, 'price_locked'); expect(await rawFinancial(f)).toEqual(before)
    })
    it('FR015 mixed price/state rejects atomically while state-only progress remains available', async () => {
      const f = await fixture(); await seedNativeFinancialHistory(f); await agreeFinancialTerms(f)
      const before = await rawFinancial(f)
      rejectFinancial(await patchFinancial(f, { ...priceChange, state: 'paid_deposit' }), 409, 'price_locked'); expect(await rawFinancial(f)).toEqual(before)
      const progressed = await patchFinancial(f, { state: 'paid_deposit' })
      expect(progressed.statusCode, progressed.body).toBe(200)
      const after = await rawFinancial(f)
      expect(after.price).toBe(before.price); expect(after.state).toBe('paid_deposit'); unchangedPayments(before, after)
      expect(after.head).toBe(before.head); expect(after.terms).toBe(before.terms); expect(after.receipts).toBe(before.receipts)
    })
    it('FR015 saved pre-agreement 200 replays under current authority without a second price action', async () => {
      const f = await fixture(), key = randomUUID(), first = await patchFinancial(f, priceChange, f.owner, key)
      expect(first.statusCode, first.body).toBe(200); await agreeFinancialTerms(f)
      const before = await rawFinancial(f), replay = await patchFinancial(f, priceChange, f.owner, key)
      expect(replay.statusCode, replay.body).toBe(200); expect(replay.headers['idempotent-replay']).toBe('true')
      expect(replay.json()).toEqual(first.json()); expect(await rawFinancial(f)).toEqual(before)
      // Field-present semantics match the existing paid/done/cancelled price guard.
      rejectFinancial(await patchFinancial(f, priceChange), 409, 'price_locked')
      rejectFinancial(await patchFinancial(f, { price: { amount: 7_000_000, currency: 'RUB' } }, f.owner, key), 409, 'idempotency_key_reused')
      expect(await rawFinancial(f)).toEqual(before)
    })
    it.each(['helper', 'coordinator', 'outsider', 'vendorOwner'] as const)('FR015 %s cannot bypass price authority or receive agreed financial context', async role => {
      const f = await fixture(); await agreeFinancialTerms(f)
      const before = await rawFinancial(f), known = role === 'helper' || role === 'coordinator'
      rejectFinancial(await patchFinancial(f, priceChange, f[role]), known ? 403 : 404, known ? 'forbidden' : 'not_found')
      expect(await rawFinancial(f)).toEqual(before)
    })
    it('FR015 a foreign deal remains private and both scoped financial snapshots remain unchanged', async () => {
      const f = await fixture(), other = await fixture(); await agreeFinancialTerms(other)
      const before = await rawFinancial(f), foreign = await rawFinancial(other)
      rejectFinancial(await patchFinancial(other, priceChange, f.owner), 404, 'not_found')
      expect(await rawFinancial(f)).toEqual(before); expect(await rawFinancial(other)).toEqual(foreign)
    })
    it.each(['membership', 'session', 'consent'] as const)('FR015 waiting fresh PATCH rechecks %s before price_locked', async kind => {
      const f = await fixture(); await agreeFinancialTerms(f)
      const before = await rawFinancial(f), codes = { membership: 'not_found', session: 'unauthorized', consent: 'forbidden' }
      const denied = await whileLocked(f, kind, () => patchFinancial(f, priceChange), client => revoke(client, f, kind))
      rejectFinancial(denied, statuses[kind], codes[kind]); expect(await rawFinancial(f)).toEqual(before)
    })
    it.each(['membership', 'session', 'consent'] as const)('FR015 waiting saved price replay rechecks current %s and hides the saved 200', async kind => {
      const f = await fixture(), key = randomUUID(), first = await patchFinancial(f, priceChange, f.owner, key)
      expect(first.statusCode, first.body).toBe(200); await agreeFinancialTerms(f)
      const before = await rawFinancial(f), codes = { membership: 'not_found', session: 'unauthorized', consent: 'forbidden' }
      const denied = await whileLocked(f, kind, () => patchFinancial(f, priceChange, f.owner, key), client => revoke(client, f, kind))
      rejectFinancial(denied, statuses[kind], codes[kind]); expect(await rawFinancial(f)).toEqual(before)
    })
    it.each(['accept-first', 'price-first'] as const)('FR015 witnessed %s queue serializes actual second-party acceptance against price PATCH', async order => {
      const f = await fixture(); ok(await proposal(f)); ok(await accept(f, await view(f)))
      const performer = await view(f, f.vendorOwner), before = await rawFinancial(f)
      const acceptCommand = { label: 'terms.accept', run: () => accept(f, performer, f.vendorOwner) }
      const priceCommand = { label: 'deals.patch', run: () => patchFinancial(f, priceChange) }
      const [first, second] = await queuedFinancialCommands(f, order,
        order === 'accept-first' ? acceptCommand : priceCommand, order === 'accept-first' ? priceCommand : acceptCommand)
      expect(first.statusCode, first.body).toBe(200); rejectFinancial(second, 409, order === 'accept-first' ? 'price_locked' : 'terms_source_changed')
      const after = await rawFinancial(f), head = (await app.db!.query<{ agreed_terms_id: string | null }>('select agreed_terms_id from deal_orders where wedding_id=$1 and deal_id=$2', [f.wedding, f.deal])).rows[0]!
      unchangedPayments(before, after); expect(after.state).toBe('booked')
      const receipts = (await app.db!.query<{ party: string }>('select party from deal_terms_receipts where wedding_id=$1 and deal_id=$2 order by party', [f.wedding, f.deal])).rows.map(r => r.party)
      if (order === 'accept-first') {
        expect(after.price).toBe('9007199254740993'); expect(head.agreed_terms_id).toBe(performer.selected!.id)
        expect(receipts).toEqual(['customer', 'performer']); expect(after.events).toBe(before.events)
      } else {
        expect(after.price).toBe('6000000'); expect(head.agreed_terms_id).toBeNull(); expect(receipts).toEqual(['customer'])
        expect(after.head).toBe(before.head); expect(after.terms).toBe(before.terms); expect(after.receipts).toBe(before.receipts)
        expect((await view(f)).selected!.freshness).toBe('stale')
      }
    })
  })

  type OrderOpaqueFrame = Record<string, string[]>
  type OrderOpaqueReply = Awaited<ReturnType<typeof read>>
  type OrderOpaqueOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
  type OrderOpaqueIdentity = Record<string, unknown> & { pid: number; backend_start: string; xact_start: string;
    txid: string; database: string; principal: string }
  async function orderOpaqueFrame(): Promise<OrderOpaqueFrame> {
    return app.db!.tx(async c => {
      await c.query('set transaction isolation level repeatable read, read only')
      const names = (await c.query<{ name: string }>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.name)
      assert.equal(names.length, 124, 'Current94 full public-table frame required')
      assert(names.includes('audit_log') && names.includes('pgmigrations'))
      const frame: OrderOpaqueFrame = {}
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/)
        frame[name] = (await c.query<{ row: string }>('select row_to_json(t)::text row from "' + name + '" t order by row_to_json(t)::text')).rows.map(row => row.row)
      }
      return frame
    })
  }
  function assertOrderOpaqueFrame(label: string, before: OrderOpaqueFrame, after: OrderOpaqueFrame): void {
    const names = Object.keys(before), sameTables = isDeepStrictEqual(Object.keys(after), names)
    const tables = names.map(table => ({ table, beforeRows: before[table]!.length, afterRows: after[table]?.length ?? null,
      rawExact: isDeepStrictEqual(after[table], before[table]) }))
    const rawExact = sameTables && tables.every(row => row.rawExact)
    process.stdout.write('ORDER_OPAQUE_FULL124_RAW_BOOL ' + JSON.stringify({ label, publicTables: names.length, sameTables, rawExact, tables }) + '\n')
    assert(rawExact, label + ': complete raw public rows changed; JWT/raw authentication values are not printed')
  }
  async function orderOpaqueIdentity(c: Queryable): Promise<OrderOpaqueIdentity> {
    const rows = (await c.query<OrderOpaqueIdentity>('select pg_backend_pid() pid,current_database() database,current_user principal,txid_current()::text txid,'
      + 'a.backend_start::text backend_start,a.xact_start::text xact_start from pg_stat_activity a where a.pid=pg_backend_pid()')).rows
    assert.equal(rows.length, 1); const row = rows[0]!
    assert(Number.isSafeInteger(row.pid) && row.pid > 0 && row.backend_start && row.xact_start && /^[0-9]+$/.test(row.txid)); return row
  }
  async function orderOpaqueUnderForeignGate(label: string, foreign: Fixture, caller: Actor, start: () => PromiseLike<OrderOpaqueReply>): Promise<void> {
    const db = app.db!, original = db.tx, invoke: Db['tx'] = original.bind(db), before = await orderOpaqueFrame()
    const reflect = <T>(p: Promise<T>): Promise<OrderOpaqueOutcome<T>> => p.then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    async function until<T>(p: Promise<T>, deadline: number): Promise<T> {
      const left = deadline - performance.now(); assert(left > 0, 'SETUP_ORDER_OPAQUE_DEADLINE')
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([p, new Promise<never>((_yes, no) => {
        timer = setTimeout(() => no(new Error('SETUP_ORDER_OPAQUE_DEADLINE')), left)
      })]) } finally { if (timer !== undefined) clearTimeout(timer) }
    }
    assert.notEqual(caller.id, foreign.owner.id)
    expect((await db.query('select 1 from wedding_members where wedding_id=$1 and user_id=$2', [foreign.wedding, caller.id])).rows).toEqual([])
    expect((await db.query('select user_id from vendors where id=$1', [foreign.vendor])).rows).toEqual([{ user_id: foreign.vendorOwner.id }])
    assert.notEqual(caller.id, foreign.vendorOwner.id)
    let signal!: (identity: OrderOpaqueIdentity) => void, unlock!: () => void
    const ready = new Promise<OrderOpaqueIdentity>(yes => { signal = yes }), release = new Promise<void>(yes => { unlock = yes })
    let workerIdentity: OrderOpaqueIdentity | undefined, captures = 0, installed = false, stopping = false
    let pending: Promise<OrderOpaqueOutcome<OrderOpaqueReply>> | undefined, ended: OrderOpaqueOutcome<OrderOpaqueReply> | undefined
    let observer: Promise<OrderOpaqueOutcome<unknown>> | undefined, primary: { error: unknown } | undefined, verified = false
    const delegate: Db['tx'] = <T>(body: (c: Queryable) => Promise<T>): Promise<T> => invoke(async c => {
      captures++; assert.equal(captures, 1, 'Only the armed foreign route transaction is observed')
      workerIdentity = await orderOpaqueIdentity(c)
      return body(c) // exact same real client/callback/results/errors; no query wrapper or auth replacement
    })
    const holder = reflect(invoke(async c => {
      const held = await orderOpaqueIdentity(c)
      expect((await c.query('select id from weddings where id=$1 for update', [foreign.wedding])).rows).toEqual([{ id: foreign.wedding }])
      signal(held); await release
    }))
    try {
      const held = await until(Promise.race([ready, holder.then(result => {
        if (!result.ok) throw result.error
        throw new Error('SETUP_ORDER_OPAQUE_HOLDER_ENDED')
      })]), performance.now() + 3000)
      const deadline = performance.now() + 3000
      observer = reflect(invoke(async c => {
        await c.query("set local statement_timeout='1000ms'")
        const observedBy = await orderOpaqueIdentity(c); assert.notEqual(observedBy.pid, held.pid)
        assert.equal(observedBy.database, held.database); assert.equal(observedBy.principal, held.principal)
        assert(!stopping && performance.now() < deadline, 'SETUP_ORDER_OPAQUE_OBSERVER_LATE')
        db.tx = delegate; installed = true
        pending = reflect(Promise.resolve(start())).then(result => { ended = result; return result })
        while (!stopping && performance.now() < deadline) {
          await c.query('select pg_stat_clear_snapshot()')
          if (ended) {
            if (!ended.ok) throw ended.error
            denied(ended.value, 404)
            expect(ended.value.json<{ error: { code: string } }>().error.code).toBe('not_found')
            const rows = (await c.query<{ backend_start: string; xact_start: string; state: string; datname: string; usename: string }>(
              'select backend_start::text backend_start,xact_start::text xact_start,state,datname,usename from pg_stat_activity where pid=$1',
              [held.pid])).rows
            assert.equal(rows.length, 1); const gate = rows[0]!
            assert.equal(gate.backend_start, held.backend_start); assert.equal(gate.xact_start, held.xact_start)
            assert.equal(gate.state, 'idle in transaction'); assert.equal(gate.datname, held.database); assert.equal(gate.usename, held.principal)
            assert(!stopping && performance.now() < deadline, 'SETUP_ORDER_OPAQUE_404_TOO_LATE')
            process.stdout.write('ORDER_OPAQUE_404_WHILE_SAME_GATE_OPEN ' + JSON.stringify({ label, foreignWedding: foreign.wedding,
              foreignDeal: foreign.deal, callerId: caller.id, holder: held, worker: workerIdentity ?? null, observedBy, captures, gate }) + '\n')
            verified = true; return
          }
          if (workerIdentity) {
            const rows = (await c.query<Record<string, unknown> & { pid: number; backend_start: string; xact_start: string; datname: string; usename: string;
              state: string; wait_event_type: string | null; query: string; blockers: number[]; holder_pid: number;
              holder_backend_start: string; holder_xact_start: string; holder_state: string; holder_database: string; holder_principal: string; observed_at: string }>(
              'select w.pid,w.backend_start::text backend_start,w.xact_start::text xact_start,w.datname,w.usename,w.state,w.wait_event_type,w.query,'
              + 'pg_blocking_pids(w.pid) blockers,b.pid holder_pid,b.backend_start::text holder_backend_start,b.xact_start::text holder_xact_start,'
              + 'b.state holder_state,b.datname holder_database,b.usename holder_principal,clock_timestamp()::text observed_at '
              + 'from pg_stat_activity w join pg_stat_activity b on b.pid=$2 where w.pid=$1', [workerIdentity.pid, held.pid])).rows
            if (rows.length === 1) {
              const row = rows[0]!
              if (row.state === 'active' && row.wait_event_type === 'Lock' && row.blockers.length === 1 && row.blockers[0] === held.pid
                && row.query.trim().replace(/\s+/g, ' ') === 'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope') {
                assert.notEqual(workerIdentity.pid, held.pid); assert.notEqual(workerIdentity.pid, observedBy.pid)
                assert.equal(row.pid, workerIdentity.pid); assert.equal(row.backend_start, workerIdentity.backend_start); assert.equal(row.xact_start, workerIdentity.xact_start)
                assert.equal(row.datname, workerIdentity.database); assert.equal(row.usename, workerIdentity.principal)
                assert.equal(row.holder_pid, held.pid); assert.equal(row.holder_backend_start, held.backend_start); assert.equal(row.holder_xact_start, held.xact_start)
                assert.equal(row.holder_state, 'idle in transaction'); assert.equal(row.holder_database, held.database); assert.equal(row.holder_principal, held.principal)
                assert.equal(workerIdentity.database, held.database); assert.equal(workerIdentity.principal, held.principal)
                assert(!stopping && performance.now() < deadline, 'SETUP_ORDER_OPAQUE_WITNESS_TOO_LATE')
                process.stdout.write('ORDER_OPAQUE_UNDESIRED_FOREIGN_PREFIX_WAIT ' + JSON.stringify({ label, foreignWedding: foreign.wedding,
                  foreignDeal: foreign.deal, callerId: caller.id, holder: held, worker: workerIdentity, observedBy, activity: row, path: [workerIdentity.pid, held.pid] }) + '\n')
                assert.fail('ORDER_OPAQUE404_REQUIRED_WHILE_FOREIGN_GATE_HELD')
              }
            }
          }
          await new Promise<void>(yes => setTimeout(yes, Math.min(10, Math.max(1, deadline - performance.now()))))
        }
        throw new Error('SETUP_ORDER_OPAQUE_NO_RESPONSE_OR_WITNESS')
      }))
      const observation = await until(observer, deadline); if (!observation.ok) throw observation.error
      assert(verified)
    } catch (error) { primary = { error } } finally {
      stopping = true; unlock()
      const cleanup: unknown[] = []
      const held = await holder; if (!held.ok && (!primary || held.error !== primary.error)) cleanup.push(held.error)
      if (observer) { const result = await observer; if (!result.ok && (!primary || result.error !== primary.error)) cleanup.push(result.error) }
      if (pending) { const result = await pending; if (!result.ok && (!primary || result.error !== primary.error)) cleanup.push(result.error) }
      if (installed) { if (db.tx !== delegate) cleanup.push(new Error('Owned order-opaque Db.tx method changed')); db.tx = original }
      try { assertOrderOpaqueFrame(label, before, await orderOpaqueFrame()) } catch (error) { cleanup.push(error) }
      if (cleanup.length) primary = { error: new AggregateError(primary ? [primary.error, ...cleanup] : cleanup, 'Order opaque cleanup/frame failed',
        primary ? { cause: primary.error } : undefined) }
    }
    if (primary) throw primary.error
    assert(verified)
  }

  it('O01 own order GET stays200 while foreign order must return opaque404 before its held wedding prefix', async () => {
    const a = await fixture(), b = await fixture()
    const own = await app.inject({ method: 'GET', url: '/deals/' + a.deal + '/order', headers: a.owner.headers })
    expect(own.statusCode, own.body).toBe(200); expect(own.headers['cache-control']).toBe('no-store')
    const otherOwn = await app.inject({ method: 'GET', url: '/deals/' + b.deal + '/order', headers: b.owner.headers })
    expect(otherOwn.statusCode, otherOwn.body).toBe(200)
    await orderOpaqueUnderForeignGate('O01 foreign order GET', b, a.owner,
      () => app.inject({ method: 'GET', url: '/deals/' + b.deal + '/order', headers: a.owner.headers }))
  })
  it('O02 own brief saved200 cannot reach a foreign prefix or cached body and replays its own exact response', async () => {
    const a = await fixture(), b = await fixture(), key = randomUUID()
    const current = await app.inject({ method: 'GET', url: '/deals/' + a.deal + '/order', headers: a.owner.headers })
    expect(current.statusCode, current.body).toBe(200)
    const otherOwn = await app.inject({ method: 'GET', url: '/deals/' + b.deal + '/order', headers: b.owner.headers })
    expect(otherOwn.statusCode, otherOwn.body).toBe(200)
    const version = current.json<{ version: string }>().version
    const payload = { expectedVersion: version, brief: { values: { photographer: 'Private named photographer' } } }
    const request = (deal: string) => app.inject({ method: 'PATCH', url: '/deals/' + deal + '/order/brief',
      headers: { ...a.owner.headers, 'idempotency-key': key }, payload })
    const first = await request(a.deal)
    expect(first.statusCode, first.body).toBe(200); expect(first.headers['cache-control']).toBe('no-store')
    expect(first.json()).toMatchObject({ version: (BigInt(version) + 1n).toString(),
      brief: { categoryId: 'photo', values: { photographer: 'Private named photographer' } } })
    await orderOpaqueUnderForeignGate('O02 foreign brief same saved key', b, a.owner, () => request(b.deal))
    const beforeReplay = await orderOpaqueFrame(), replayed = await request(a.deal)
    expect(replayed.statusCode, replayed.body).toBe(200); expect(replayed.headers['cache-control']).toBe('no-store')
    assert(isDeepStrictEqual(replayed.json(), first.json()), 'Own saved response content changed; no cached-body token dump')
    assertOrderOpaqueFrame('O02 own exact replay', beforeReplay, await orderOpaqueFrame())
  })

})
