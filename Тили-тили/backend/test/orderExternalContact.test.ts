import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import { disposablePgPort } from './disposablePgPort.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'fr002-contact-http-test-only-'.repeat(3), POLICY = '2026-09-02'
interface Actor { id: string; session: string; headers: { authorization: string } }
describe.skipIf(!DB)('FR002 external contact: real HTTP/PG version, scope and history', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort())
    assert.match(decodeURIComponent(target.pathname.slice(1)), /^tili_ecosystem_[a-z][a-z0-9_]{0,25}_20260930_test$/)
    assert.equal(target.search, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'fr002-refresh-test-only-'.repeat(3), policyVersion: POLICY })
    await app.ready()
    const live = (await app.db!.query('select host(inet_server_addr()) as address,inet_server_port() as port,current_database() as name')).rows[0]!
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(live.address as string))
    assert.equal(live.port, Number(disposablePgPort())); assert.equal(live.name, target.pathname.slice(1))
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    if (!app) return
    try {
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function actor(label: string): Promise<Actor> {
    const session = randomUUID(); let id: string | undefined
    for (let attempt = 0; attempt < 8; attempt++) {
      id = (await app.db!.query<{ id: string }>('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id',
        [randomUUID(), '+79' + randomInt(100_000_000, 999_999_999), `Synthetic FR002 ${label}`])).rows[0]?.id
      if (id) break
    }
    assert(id, 'Synthetic fixture phone allocation failed'); users.push(id)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return { id, session, headers: { authorization: `Bearer ${await signAccessToken(SECRET, { sub: id, sid: session })}` } }
  }
  async function fixture(external = true) {
    const owner = await actor('couple'), partner = await actor('partner'), helper = await actor('helper'), coordinator = await actor('coordinator'), outsider = await actor('outsider'), vendorOwner = await actor('vendor')
    const wedding = randomUUID(), slot = randomUUID(), deal = randomUUID(), vendor = randomUUID(); weddings.push(wedding)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code,budget_total) values($1,$2,'Synthetic FR002','2027-06-14','Europe/Moscow',$3,90000000)", [wedding, owner.id, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'couple'),($1,$4,'helper'),($1,$5,'coordinator')", [wedding, owner.id, partner.id, helper.id, coordinator.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photographer')", [slot, wedding])
    if (!external) await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic catalog vendor',now())", [vendor, vendorOwner.id])
    // These rows describe synthetic pre-existing manual facts, not human or performer consent.
    await app.db!.query(`insert into deals(id,wedding_id,slot_id,vendor_id,external_name,external_phone,state,price,currency,booked_at)
      values($1,$2,$3,$4,$5,$6,'booked',15000000,'RUB',now())`,
    [deal, wedding, slot, external ? null : vendor, external ? 'Private external photographer' : null, external ? '+79990000000' : null])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [slot, deal])
    await app.db!.query("insert into payments(id,deal_id,kind,amount,payment_method,visibility,paid_on) values($1,$2,'deposit',1000000,'bank_transfer','private','2026-10-01')", [randomUUID(), deal])
    return { owner, partner, helper, coordinator, outsider, vendorOwner, wedding, slot, deal, path: `/deals/${deal}/order` }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const read = (f: Fixture, user = f.owner) => app.inject({ url: f.path, headers: user.headers })
  const write = (f: Fixture, body: object = { expectedVersion: '1', name: 'Corrected external name', phone: '+79991112233' }, user = f.owner, key = randomUUID()) =>
    app.inject({ method: 'PATCH', url: f.path + '/external-contact', headers: { ...user.headers, 'idempotency-key': key }, payload: body })
  async function history(f: Fixture) {
    return (await app.db!.query(`select
      (select to_jsonb(d)-'external_name'-'external_phone' from deals d where d.id=$1) as financial_root,
      (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from payments p where p.deal_id=$1) as payments,
      (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from deal_terms_versions t where t.deal_id=$1) as terms,
      (select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from deal_terms_receipts t where t.deal_id=$1) as receipts,
      (select coalesce(jsonb_agg(to_jsonb(b) order by b.vendor_id,b.date),'[]') from vendor_busy_dates b where b.deal_id=$1) as busy,
      (select to_jsonb(s) from slots s where s.id=$2) as slot,
      (select count(*)::int from resource_allocations a where a.wedding_id=$3) as allocations,
      (select count(*)::int from vendor_program_acknowledgments a where a.wedding_id=$3) as acknowledgments`, [f.deal, f.slot, f.wedding])).rows[0]
  }
  const state = async (f: Fixture) => (await app.db!.query(`select d.external_name,d.external_phone,o.version::text,
    (select count(*)::int from audit_log a where a.entity_id=d.id and a.action='order.external_contact_changed') as contact_audits
    from deals d join deal_orders o on o.deal_id=d.id where d.id=$1`, [f.deal])).rows[0]

  it('GET exposes the real external contact and catalog orders do not invent one', async () => {
    const f = await fixture(), g = await fixture(false)
    expect((await read(f)).json().externalContact).toEqual({ name: 'Private external photographer', phone: '+79990000000' })
    expect((await read(g)).json()).not.toHaveProperty('externalContact')
  })
  it('updates that deal, increments the existing version once, persists on reread and preserves financial/history rows', async () => {
    const f = await fixture(), before = await history(f), reply = await write(f)
    expect(reply.statusCode, reply.body).toBe(200)
    expect(reply.json()).toMatchObject({ dealId: f.deal, version: '2', externalContact: { name: 'Corrected external name', phone: '+79991112233' } })
    expect((await read(f)).json()).toEqual(reply.json()); expect(await history(f)).toEqual(before)
    expect(await state(f)).toMatchObject({ version: '2', contact_audits: 1 })
    const audit = (await app.db!.query("select diff from audit_log where entity_id=$1 and action='order.external_contact_changed'", [f.deal])).rows[0]!
    expect(JSON.stringify(audit)).not.toContain('+7999')
  })
  it('null/blank phone stays unknown; a no-op does not increment the version or write another audit', async () => {
    const f = await fixture(), body = { expectedVersion: '1', name: ' Private external photographer ', phone: ' ' }
    expect((await write(f, body)).statusCode).toBe(200)
    const before = await state(f)
    expect(before).toMatchObject({ external_name: 'Private external photographer', external_phone: null, version: '2' })
    expect((await write(f, { expectedVersion: '2', name: 'Private external photographer', phone: null })).statusCode).toBe(200)
    expect(await state(f)).toEqual(before)
  })
  it('a stale version cannot overwrite another partner contact', async () => {
    const f = await fixture()
    expect((await write(f)).statusCode).toBe(200)
    const before = await state(f), reply = await write(f, { expectedVersion: '1', name: 'Stale second name', phone: null }, f.partner)
    expect(reply.statusCode, reply.body).toBe(409); expect(await state(f)).toEqual(before)
  })
  it('actual concurrent partner edits yield one success and one version refusal', async () => {
    const f = await fixture(), responses = await Promise.all([write(f), write(f, { expectedVersion: '1', name: 'Partner name', phone: null }, f.partner)])
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409])
    expect(await state(f)).toMatchObject({ version: '2', contact_audits: 1 })
  })
  it('same key/body replays without another write and projects the current contact after a later authorized edit', async () => {
    const f = await fixture(), key = randomUUID(), body = { expectedVersion: '1', name: 'First contact', phone: null }
    expect((await write(f, body, f.owner, key)).statusCode).toBe(200)
    expect((await write(f, { expectedVersion: '2', name: 'Latest contact', phone: '+79992223344' }, f.partner)).statusCode).toBe(200)
    const before = await state(f), replay = await write(f, body, f.owner, key)
    expect(replay.statusCode, replay.body).toBe(200); expect(replay.json()).toMatchObject({ version: '3', externalContact: { name: 'Latest contact', phone: '+79992223344' } })
    expect(await state(f)).toEqual(before)
    expect((await write(f, { ...body, name: 'Different intent' }, f.owner, key)).statusCode).toBe(409)
    expect(await state(f)).toEqual(before)
  })
  it.each(['helper', 'coordinator', 'outsider', 'vendorOwner'] as const)('%s cannot read or edit an external private order', async role => {
    const f = await fixture(), before = await state(f)
    for (const r of [await read(f, f[role]), await write(f, undefined, f[role])]) {
      expect(r.statusCode, r.body).toBe(404); expect(r.body).not.toContain('Private external photographer')
    }
    expect(await state(f)).toEqual(before)
  })
  it('catalog deal, including its vendor owner, cannot use the external writer', async () => {
    const f = await fixture(false), before = await history(f)
    for (const user of [f.owner, f.vendorOwner]) expect((await write(f, undefined, user)).statusCode).toBe(404)
    expect(await history(f)).toEqual(before)
  })
  it.each(['done', 'cancelled'] as const)('%s deal cannot reopen operations through contact edits', async closed => {
    const f = await fixture()
    await app.db!.query('update deals set state=$2 where id=$1', [f.deal, closed])
    const before = await state(f)
    expect((await write(f)).statusCode).toBe(403); expect(await state(f)).toEqual(before)
  })
  it.each([
    { name: 'A ', phone: null }, { name: 'x'.repeat(121), phone: null },
    { name: 'Bad\u0000name', phone: null }, { name: 'Valid contact', phone: 'x'.repeat(33) },
    { name: 'Valid contact', phone: '\u0001' }, { name: 'Valid contact', phone: null, unexpected: true },
    { name: 123, phone: null }, { name: 'Valid contact', phone: 123 }, { name: 'Valid contact', phone: '\n123' },
    { name: 'Valid\tcontact', phone: null }, { name: 'Valid contact', phone: null, expectedVersion: 1 },
  ])('invalid contact is refused without any mutation: %j', async fields => {
    const f = await fixture(), before = await state(f), r = await write(f, { expectedVersion: '1', ...fields })
    expect([400, 422]).toContain(r.statusCode); expect(await state(f)).toEqual(before)
  })
  it('membership and session revocation invalidate a previously successful replay', async () => {
    const f = await fixture(), key = randomUUID(), body = { expectedVersion: '1', name: 'Private edited contact', phone: null }
    expect((await write(f, body, f.owner, key)).statusCode).toBe(200)
    await app.db!.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.wedding, f.owner.id])
    const before = await state(f), denied = await write(f, body, f.owner, key)
    expect(denied.statusCode).toBe(404); expect(denied.body).not.toContain('Private edited contact')
    expect(await state(f)).toEqual(before)
    await app.db!.query("update wedding_members set role='couple' where wedding_id=$1 and user_id=$2", [f.wedding, f.owner.id])
    await app.db!.query('update sessions set revoked_at=now() where id=$1', [f.owner.session])
    expect((await write(f, body, f.owner, key)).statusCode).toBe(401); expect(await state(f)).toEqual(before)
  })
  it('a real committed write followed by membership revoke cannot leak the committed response', async () => {
    const f = await fixture(), realTx = app.db!.tx.bind(app.db!)
    const hook = vi.spyOn(app.db!, 'tx').mockImplementationOnce(async action => {
      const result = await realTx(action)
      await app.db!.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [f.wedding, f.owner.id])
      return result
    })
    try {
      const r = await write(f)
      expect(r.statusCode, r.body).toBe(404); expect(r.body).not.toContain('Corrected external name')
      expect(await state(f)).toMatchObject({ external_name: 'Corrected external name', version: '2', contact_audits: 1 })
    } finally { hook.mockRestore() }
  })
  it('withdrawn consent refuses replay without leaking or rewriting the saved contact', async () => {
    const f = await fixture(), key = randomUUID(), body = { expectedVersion: '1', name: 'Consent private contact', phone: null }
    expect((await write(f, body, f.owner, key)).statusCode).toBe(200)
    await app.db!.query('update consents set withdrawn_at=now() where user_id=$1', [f.owner.id])
    const before = await state(f), replay = await write(f, body, f.owner, key)
    expect(replay.statusCode, replay.body).toBe(403); expect(replay.body).not.toContain('Consent private contact'); expect(await state(f)).toEqual(before)
  })
  it.each(['root', 'idempotency', 'replay'] as const)('JWT expiry during an actual %s lock wait rolls back the command/receipt', async boundary => {
    const f = await fixture(), key = randomUUID(), body = { expectedVersion: '1', name: 'Expiry private contact', phone: null }
    const route = '/deals/:dealId/order/external-contact', storedKey = `${f.owner.id}:${route}:${key}`
    if (boundary === 'replay') expect((await write(f, body, f.owner, key)).statusCode).toBe(200)
    const before = await state(f)
    const expires = Math.floor(Date.now() / 1000) + 4
    f.owner.headers.authorization = 'Bearer ' + await signAccessToken(SECRET, { sub: f.owner.id, sid: f.owner.session }, (expires - ACCESS_TTL_SECONDS) * 1000)
    let pending: ReturnType<typeof write> | undefined
    await app.db!.tx(async blocker => {
      const pid = (await blocker.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      if (boundary === 'root') await blocker.query('select deal_id from deal_orders where deal_id=$1 for update', [f.deal])
      else if (boundary === 'replay') await blocker.query('select key from idempotency_keys where key=$1 for update', [storedKey])
      else await blocker.query('insert into idempotency_keys(key,user_id,route,request_hash,status,body) values($1,$2,$3,$4,200,$5::jsonb)', [storedKey, f.owner.id, route, 'uncommitted-blocker', '{}'])
      pending = write(f, body, f.owner, key)
      const deadline = Date.now() + 2500
      let blocked = false
      while (Date.now() < deadline) {
        blocked = Boolean((await app.db!.query('select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount)
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked, 'must observe the real writer waiting on the held PostgreSQL lock').toBe(true)
      while (Date.now() < expires * 1000 + 20) await new Promise(resolve => setTimeout(resolve, 20))
      // Discard only the synthetic uncommitted blocker; the writer resumes on COMMIT.
      if (boundary === 'idempotency') await blocker.query('delete from idempotency_keys where key=$1', [storedKey])
    })
    const reply = await pending!
    expect(reply.statusCode, reply.body).toBe(401); expect(reply.json().error.code).toBe('token_expired')
    expect(reply.body).not.toContain('Expiry private contact'); expect(await state(f)).toEqual(before)
    if (boundary !== 'replay') expect((await app.db!.query('select key from idempotency_keys where key=$1', [storedKey])).rowCount).toBe(0)
  })
  it('contact edits preserve a nonempty published snapshot and customer receipt, and invalidate its old read proof', async () => {
    const f = await fixture(), termsPath = f.path + '/terms'
    const post = (suffix: string, payload: object) => app.inject({ method: 'POST', url: termsPath + suffix, headers: { ...f.owner.headers, 'idempotency-key': randomUUID() }, payload })
    const published = await post('/proposals', { expectedOrderVersion: '1', expectedTermsRevision: '0' })
    expect(published.statusCode, published.body).toBe(200)
    const view = (await app.inject({ url: termsPath, headers: f.owner.headers })).json()
    const acceptance = { expectedTermsVersion: view.selected.version, digest: view.selected.digest, readToken: view.readToken }
    expect((await post(`/${view.selected.id}/accept`, acceptance)).statusCode).toBe(200)
    const before = await history(f)
    expect(before!.terms).toHaveLength(1); expect(before!.receipts).toHaveLength(1)
    expect((await write(f)).statusCode).toBe(200); expect(await history(f)).toEqual(before)
    const fresh = (await app.inject({ url: termsPath, headers: f.owner.headers })).json()
    expect(fresh.selected.freshness).toBe('stale'); expect(fresh.readToken).toBeNull(); expect(fresh.agreedTermsId).toBeNull()
    expect(fresh.selected.snapshot.economics.performer).toMatchObject({ externalName: 'Private external photographer', externalPhone: '+79990000000' })
    expect((await post(`/${view.selected.id}/accept`, acceptance)).statusCode).toBe(409)
    expect(await history(f)).toEqual(before)
  })
})
