import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import type { TermsView } from '../src/orders/terms.js'
import { signOrderTermsRead, verifyOrderTermsRead } from '../src/orders/terms-token.js'

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
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Private terms studio',now()),($3,$4,'photo','Other profile',now())", [vendor, vendorOwner.id, randomUUID(), otherVendorOwner.id])
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
  async function whileLocked<T>(f: Fixture, start: () => PromiseLike<T>, change: (c: Queryable) => Promise<void>): Promise<T> {
    let acquired!: (pid: number) => void, changeNow!: () => void, release!: () => void, changed!: () => void
    const ready = new Promise<number>(r => { acquired = r }), mutate = new Promise<void>(r => { changeNow = r }), unlock = new Promise<void>(r => { release = r }), didChange = new Promise<void>(r => { changed = r })
    let shouldChange = false
    const blocker = app.db!.tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [f.wedding]); acquired((await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid)
      await mutate; if (shouldChange) await change(c); changed(); await unlock
    })
    const pid = await Promise.race([ready, blocker.then(() => { throw new Error('Blocker ended before locking') })]), pending = Promise.resolve(start())
    void pending.catch(() => {})
    try {
      let witnessed = false; const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const result = await app.db!.query(`select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and $1=any(pg_blocking_pids(pid)) and query like 'select id from weddings where id=$1 and archived_at%'`, [pid])
        if (result.rowCount) { witnessed = true; break }
        await new Promise(r => setTimeout(r, 10))
      }
      expect(witnessed, 'Actual HTTP transaction must be waiting on this exact blocker').toBe(true)
      shouldChange = true; changeNow(); await Promise.race([didChange, blocker])
    } finally { changeNow(); release(); try { await blocker } finally { await pending.catch(() => {}) } }
    return pending
  }
  const revocations: Revocation[] = ['membership', 'session', 'consent', 'vendor_owner', 'vendor_blocked', 'account', 'wedding', 'deal']
  it.each(revocations)('actual waiting fresh accept rechecks %s instead of creating consent', async kind => {
    const f = await fixture(); ok(await proposal(f)); const user = kind.startsWith('vendor_') ? f.vendorOwner : f.owner, v = await view(f, user), before = await state(f)
    denied(await whileLocked(f, () => accept(f, v, user), c => revoke(c, f, kind)), statuses[kind]); expect(await state(f)).toEqual(before)
  })
  it.each(revocations)('actual waiting saved proposal replay rechecks %s before returning private saved body', async kind => {
    const f = await fixture(), user = kind.startsWith('vendor_') ? f.vendorOwner : f.owner, key = randomUUID(); ok(await proposal(f, user, key)); const before = await state(f)
    denied(await whileLocked(f, () => proposal(f, user, key), c => revoke(c, f, kind)), statuses[kind]); expect(await state(f)).toEqual(before)
  })
  it.each(revocations)('actual waiting saved acceptance replay rechecks %s without reporting cached success to revoked caller', async kind => {
    const f = await fixture(), user = kind.startsWith('vendor_') ? f.vendorOwner : f.owner, key = randomUUID(); ok(await proposal(f))
    const v = await view(f, user); ok(await accept(f, v, user, key)); const before = await state(f)
    denied(await whileLocked(f, () => accept(f, v, user, key), c => revoke(c, f, kind)), statuses[kind]); expect(await state(f)).toEqual(before)
  })
  it.each(['membership', 'session', 'consent', 'vendor_owner'] as const)('actual waiting history GET rechecks %s before exposing immutable private history', async kind => {
    const f = await fixture(), user = kind === 'vendor_owner' ? f.vendorOwner : f.owner; ok(await proposal(f)); const before = await state(f)
    denied(await whileLocked(f, () => read(f, user), c => revoke(c, f, kind)), statuses[kind]); expect(await state(f)).toEqual(before)
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
})
