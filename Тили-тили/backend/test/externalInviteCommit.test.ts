import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'external-invite-commit-test-only'.repeat(3), POLICY = '2026-09-02'
describe.skipIf(!DB)('external invitation replies follow the actual database commit', () => {
  let app: FastifyInstance
  const weddings: string[] = [], users: string[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const target = new URL(DB!)
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, disposablePgPort())
    assert.match(target.pathname, /^\/tili_ecosystem_[a-z][a-z0-9_]{0,25}_20260930_test$/)
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: 'external-invite-refresh-test-only'.repeat(3), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => {
    if (!app) return
    try {
      for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
      for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    } finally { await app.close() }
  })
  async function fixture() {
    const user = randomUUID(), session = randomUUID(), wedding = randomUUID(), slot = randomUUID()
    users.push(user); weddings.push(wedding)
    // Synthetic auth rows test server behavior, never real human consent.
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic commit test couple')", [user, '+79' + randomInt(100_000_000, 999_999_999)])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, user, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), user, POLICY])
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Commit fixture','2027-06-14','Europe/Moscow',$3)", [wedding, user, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [wedding, user])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Own photographer')", [slot, wedding])
    const headers = { authorization: `Bearer ${await signAccessToken(SECRET, { sub: user, sid: session })}` }
    const booked = await app.inject({ method: 'POST', url: `/weddings/${wedding}/slots/${slot}/external`, headers,
      payload: { vendorName: 'Synthetic external photographer', price: { amount: 18000, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200)
    return { wedding, slot, deal: booked.json().deal.id as string, headers, path: `/weddings/${wedding}/slots/${slot}/external/invite` }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function snapshot(f: Fixture) {
    return (await app.db!.query(`select (select to_jsonb(w) from weddings w where id=$1) as wedding,
      (select to_jsonb(d) from deals d where id=$2) as deal,
      (select coalesce(jsonb_agg(to_jsonb(i) order by program_identity),'[]') from external_invites i where wedding_id=$1) as invites`, [f.wedding, f.deal])).rows[0]
  }
  it('returns201 only with a committed live issued token and exact current deal pointer', async () => {
    const f = await fixture(), response = await app.inject({ method: 'POST', url: f.path, headers: f.headers })
    expect(response.statusCode, response.body).toBe(201)
    const issued = response.json<{ token: string; url: string; expiresAt: string }>()
    const row = (await app.db!.query(`select i.program_identity,i.revoked_at,i.expires_at,d.current_program_invite_id
      from external_invites i join deals d on d.id=i.program_deal_id where i.token=$1 and i.wedding_id=$2`, [issued.token, f.wedding])).rows[0]!
    expect(row).toBeDefined(); expect(row.revoked_at).toBeNull()
    expect(row.current_program_invite_id).toBe(row.program_identity)
    expect(row.expires_at.toISOString()).toBe(issued.expiresAt)
    expect(issued.url).toBe(`https://tili-tili.ru/guest-vendor/${issued.token}`)
  })
  it('an actual deferred SQL constraint failure at COMMIT returns500 without exposing a rolled-back token', async () => {
    const f = await fixture(), before = await snapshot(f), suffix = randomUUID().replaceAll('-', '')
    const fn = `invite_commit_${suffix}`, trigger = `invite_commit_guard_${suffix}`
    await app.db!.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if NEW.wedding_id='${f.wedding}'::uuid then raise exception 'Synthetic deferred invitation commit rejection'; end if;
      return NEW; end $$`)
    try {
      // The callback's INSERT/UPDATE/SELECT all succeed. Only COMMIT executes
      // this constraint, so an early reply is a real observable wrong success.
      await app.db!.query(`create constraint trigger ${trigger} after insert on external_invites
        deferrable initially deferred for each row execute function ${fn}()`)
      const response = await app.inject({ method: 'POST', url: f.path, headers: f.headers })
      expect(response.statusCode, response.body).toBe(500)
      expect(Object.keys(response.json())).toEqual(['error'])
      expect(response.body).not.toContain('guest-vendor/')
      expect(response.body).not.toContain('Synthetic deferred invitation commit rejection')
      expect(await snapshot(f)).toEqual(before)
    } finally {
      await app.db!.query(`drop trigger if exists ${trigger} on external_invites`)
      await app.db!.query(`drop function ${fn}()`)
    }
    const retry = await app.inject({ method: 'POST', url: f.path, headers: f.headers })
    expect(retry.statusCode, retry.body).toBe(201)
    expect((await app.db!.query('select 1 from external_invites where wedding_id=$1', [f.wedding])).rowCount).toBe(1)
  })
})
