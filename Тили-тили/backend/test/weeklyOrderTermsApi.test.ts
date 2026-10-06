import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { TermsView } from '../src/orders/terms.js'
import { disposablePgPort } from './disposablePgPort.js'
import { isActiveOrderState, orderTermsTargets, summarizeOrderTerms } from '../../app/src/lib/weeklyOrderTerms.js'

// Real Fastify routes and PostgreSQL, with the actual frontend metadata projection.
// This is not a browser or a replacement implementation of its request queue.
const DB = process.env.TEST_DATABASE_URL
const SECRET = 'weekly-terms-synthetic-test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const POLICY = '2026-09-02'

describe.skipIf(!DB)('weekly order metadata with actual API and PostgreSQL', () => {
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
      jwtRefreshSecret: 'weekly-terms-refresh-test-only-'.repeat(3), policyVersion: POLICY }, [], { tillyModel: null })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) address,inet_server_port() port,current_database() name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address as string))
    assert.equal(live.port, Number(disposablePgPort())); assert.equal(live.name, target.pathname.slice(1))
  })
  afterAll(async () => {
    if (!app) return
    try {
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function actor(label: string) {
    const session = randomUUID()
    let id: string | undefined
    for (let attempt = 0; attempt < 8 && !id; attempt++) {
      id = (await app.db!.query<{ id: string }>('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id',
        [randomUUID(), '+79' + randomInt(100_000_000, 999_999_999), label])).rows[0]?.id
    }
    assert(id, 'Cannot allocate a unique synthetic actor')
    users.push(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  async function fixture() {
    const owner = await actor('Synthetic weekly couple'), performer = await actor('Synthetic weekly performer')
    const wedding = randomUUID(), slot = randomUUID(), deal = randomUUID(), vendor = randomUUID(); weddings.push(wedding)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Weekly metadata','2027-06-14','Europe/Moscow',$3)", [wedding, owner.id, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [wedding, owner.id])
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic weekly studio',now())", [vendor, performer.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photographer')", [slot, wedding])
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price,package_title_snapshot,package_includes_snapshot) values($1,$2,$3,$4,'booked',9007199254740993,'Private frozen package',$5::jsonb)", [deal, wedding, slot, vendor, JSON.stringify(['Frozen gallery'])])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slot, deal])
    return { wedding, slot, deal, owner, performer, path: `/deals/${deal}/order/terms` }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function get(f: Fixture, path: string, user = f.owner) {
    const reply = await app.inject({ url: path, headers: user.headers })
    expect(reply.statusCode, reply.body).toBe(200)
    return reply
  }
  async function terms(f: Fixture, user = f.owner) {
    return (await get(f, f.path, user)).json<TermsView>()
  }
  async function ledger(f: Fixture) {
    return (await app.db!.query(`select
      (select to_jsonb(d) from deals d where d.id=$1) deal,
      (select d.price::text from deals d where d.id=$1) exact_price,
      (select to_jsonb(o) from deal_orders o where o.deal_id=$1) root,
      (select jsonb_agg(to_jsonb(t) order by t.id) from deal_terms_versions t where t.deal_id=$1) terms,
      (select jsonb_agg(to_jsonb(r) order by r.id) from deal_terms_receipts r where r.deal_id=$1) receipts,
      (select jsonb_agg(to_jsonb(p) order by p.id) from payments p where p.deal_id=$1) payments,
      (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.entity_id=$1) audit`, [f.deal])).rows[0]
  }

  it.each(['candidate', 'contacted', 'negotiating', 'booked', 'paid_deposit'])('keeps the confirmed active %s state readable without fabricating published conditions', async state => {
    const f = await fixture()
    await app.db!.query('update deals set state=$2 where id=$1', [f.deal, state])
    const before = await ledger(f)
    const targets = orderTermsTargets((await get(f, `/weddings/${f.wedding}/slots`)).json())
    expect(targets.map(t => t.dealId)).toEqual([f.deal])
    const catalog = (await get(f, `/deals/${f.deal}/order/catalog`)).json()
    expect(catalog).toMatchObject({ weddingId: f.wedding, actorRole: 'couple', dealState: state })
    expect(isActiveOrderState(catalog.dealState)).toBe(true)
    expect(summarizeOrderTerms(await terms(f))).toEqual({ state: 'unpublished', version: null, awaiting: [], previousAgreement: false })
    expect(await ledger(f)).toEqual(before)
  })
  it.each(['done', 'cancelled'])('distinguishes historical agreement from an active order after a newer catalog reports %s', async state => {
    const f = await fixture()
    const proposal = await app.inject({ method: 'POST', url: f.path + '/proposals',
      headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload: { expectedOrderVersion: '1', expectedTermsRevision: '0' } })
    expect(proposal.statusCode, proposal.body).toBe(200)
    for (const user of [f.owner, f.performer]) {
      const read = await terms(f, user), selected = read.selected!
      const response = await app.inject({ method: 'POST', url: `${f.path}/${selected.id}/accept`,
        headers: { ...user.headers, 'idempotency-key': randomUUID() }, payload: { expectedTermsVersion: selected.version, digest: selected.digest, readToken: read.readToken } })
      expect(response.statusCode, response.body).toBe(200)
    }
    const olderList = orderTermsTargets((await get(f, `/weddings/${f.wedding}/slots`)).json())
    expect(olderList.map(t => t.dealId)).toEqual([f.deal])
    await app.db!.query('update deals set state=$2 where id=$1', [f.deal, state])
    const beforeRead = await ledger(f)
    const catalog = (await get(f, `/deals/${f.deal}/order/catalog`)).json()
    expect(catalog).toMatchObject({ weddingId: f.wedding, actorRole: 'couple', dealState: state })
    expect(isActiveOrderState(catalog.dealState)).toBe(false)
    // The history is legitimately readable even after closure. It is not proof
    // that a stale slots target is still active; the production reader must stop.
    const history = await terms(f)
    expect(summarizeOrderTerms(history)).toEqual({ state: 'agreed', version: '1', awaiting: [], previousAgreement: false })
    expect(orderTermsTargets((await get(f, `/weddings/${f.wedding}/slots`)).json())).toEqual([])
    expect(await ledger(f)).toEqual(beforeRead)
  })
})