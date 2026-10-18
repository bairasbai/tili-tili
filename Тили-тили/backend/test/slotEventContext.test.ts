import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { disposablePgPort } from './disposablePgPort.js'

// R0 public GET contract, native PostgreSQL. No booking-guard activation.
const DB = process.env.TEST_DATABASE_URL, POLICY = '2026-09-02'
const SECRET = 'slot-event-context-native-synthetic-secret-'.repeat(2)
const YEAR = new Date().getUTCFullYear() + 2, MAIN = `${YEAR}-06-14`
type Context = { id: string; name: string; kind: string; date: string | null; timeZone: string | null; location: string | null; isMain: boolean }
type SlotJson = { id: string; categoryId: string; label: string; programEvent?: Context | null; deal: Record<string, unknown> | null; [key: string]: unknown }

describe.skipIf(!DB)('R0 slot programEvent: registered GET and native unchanged business state', () => {
  let app: FastifyInstance
  const owned = { users: new Set<string>(), sessions: new Set<string>(), consents: new Set<string>(), weddings: new Set<string>(), events: new Set<string>(), slots: new Set<string>(), deals: new Set<string>(), payments: new Set<string>(), chats: new Set<string>(), externalInvites: new Set<string>(), keys: new Set<string>(), retainedAuditIds: new Set<string>() }
  let priorAudits: { id: string; row: string }[] = []
  beforeAll(async () => {
    assert.equal(process.env.DATABASE_URL, DB)
    const u = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(u.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
    assert.equal(u.port, disposablePgPort()); assert.equal(u.port, '15432'); assert.equal(u.username, 'codex_test')
    assert(['/tili_ecosystem_full_20260930_test', '/tili_t009_day_20261018_test'].includes(u.pathname))
    assert.equal(u.search, ''); assert.equal(u.hash, '')
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET, jwtRefreshSecret: 'r0-native-refresh-synthetic-'.repeat(3), policyVersion: POLICY })
    await app.ready()
    const identity = (await app.db!.query<{ db: string; role: string; addr: string; port: number; data: string; sysid: string; pid: number; oid: number }>(
      `select current_database() db,current_user role,host(inet_server_addr()) addr,inet_server_port() port,
       current_setting('data_directory') data,(select system_identifier::text from pg_control_system()) sysid,
       pg_backend_pid() pid,(select oid::int from pg_database where datname=current_database()) oid`)).rows[0]!
    assert.equal(identity.db, u.pathname.slice(1)); assert.equal(identity.role, 'codex_test'); assert.equal(identity.port, 15432)
    assert(['127.0.0.1', '::1'].includes(identity.addr)); assert(identity.data && /^\d+$/.test(identity.sysid) && identity.pid > 0 && identity.oid > 0)
    process.stdout.write(`SLOT_EVENT_CONTEXT_NATIVE_IDENTITY ${JSON.stringify(identity)}\n`)
    priorAudits = (await app.db!.query<{ id: string; row: string }>('select id::text,to_jsonb(t)::text as row from audit_log t order by id')).rows
  })
  afterAll(async () => {
    if (!app) return
    try {
      const audits = (await app.db!.query<{ id: string }>('select id::text from audit_log where actor_id=any($1::uuid[]) order by id', [[...owned.users]])).rows
      for (const row of audits) owned.retainedAuditIds.add(row.id)
      process.stdout.write(`SLOT_EVENT_CONTEXT_FIXTURE_MANIFEST ${JSON.stringify(Object.fromEntries(Object.entries(owned).map(([key, values]) => [key, [...values]])))}\n`)
      await app.db!.query('delete from chats where id=any($1::uuid[])', [[...owned.chats]])
      await app.db!.query('delete from weddings where id=any($1::uuid[])', [[...owned.weddings]])
      await app.db!.query('delete from users where id=any($1::uuid[])', [[...owned.users]])
      for (const [table, ids] of [['weddings', owned.weddings], ['slots', owned.slots], ['deals', owned.deals], ['payments', owned.payments], ['wedding_events', owned.events], ['users', owned.users], ['sessions', owned.sessions], ['consents', owned.consents], ['chats', owned.chats]] as const) {
        expect((await app.db!.query(`select id from ${table} where id=any($1::uuid[])`, [[...ids]])).rows, `Own ${table} survived cleanup`).toEqual([])
      }
      expect((await app.db!.query('select key from idempotency_keys where user_id=any($1::uuid[])', [[...owned.users]])).rows).toEqual([])
      expect((await app.db!.query('select program_identity from external_invites where program_identity=any($1::uuid[])', [[...owned.externalInvites]])).rows).toEqual([])
      const current = new Map((await app.db!.query<{ id: string; row: string }>('select id::text,to_jsonb(t)::text as row from audit_log t order by id')).rows.map(r => [r.id, r.row]))
      for (const row of priorAudits) expect(current.get(row.id), 'Prior audit changed').toBe(row.row)
      for (const id of owned.retainedAuditIds) expect(current.has(id), 'Own audit was removed').toBe(true)
      process.stdout.write('SLOT_EVENT_CONTEXT_CLEANUP ownRowsAbsent=true priorAuditExact=true ownAuditRetained=true\n')
    } finally { await app.close() }
  })
  async function actor() {
    const id = randomUUID(), session = randomUUID(), consent = randomUUID()
    owned.users.add(id); owned.sessions.add(session); owned.consents.add(consent)
    let inserted = false
    for (let attempt = 0; attempt < 8 && !inserted; attempt++) inserted = (await app.db!.query(
      "insert into users(id,phone,name) values($1,$2,'Synthetic R0 context reader') on conflict(phone) do nothing returning id",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])).rowCount === 1
    assert(inserted)
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, id, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consent, id, POLICY])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid: session }) }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  const auth = (a: Actor) => ({ authorization: `Bearer ${a.token}` })
  async function fixture() {
    const owner = await actor(), wedding = randomUUID(), implicit = randomUUID(); owned.weddings.add(wedding); owned.slots.add(implicit)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic R0 wedding',$3,'Europe/Moscow',$4)", [wedding, owner.id, MAIN, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [wedding, owner.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label,sort) values($1,$2,'photo','Legacy implicit main',0)", [implicit, wedding])
    const response = await app.inject({ method: 'GET', url: `/weddings/${wedding}/events`, headers: auth(owner) })
    expect(response.statusCode, response.body).toBe(200)
    const main = response.json<Context[]>().find(e => e.isMain)!; expect(main).toBeDefined(); owned.events.add(main.id)
    return { owner, wedding, implicit, main }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const project = (e: Context): Context => ({ id: e.id, name: e.name, kind: e.kind, date: e.date, timeZone: e.timeZone, location: e.location, isMain: e.isMain })
  async function event(f: Fixture, body: { name: string; kind: string; date: string | null; timeZone: string | null; location?: string | null }) {
    const version = await app.inject({ method: 'GET', url: `/weddings/${f.wedding}/events`, headers: auth(f.owner) })
    expect(version.statusCode, version.body).toBe(200); expect(version.headers.etag).toBeTruthy()
    const reply = await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/events`, headers: { ...auth(f.owner), 'if-match': version.headers.etag! }, payload: body })
    expect(reply.statusCode, reply.body).toBe(201)
    const created = reply.json<Context>(); owned.events.add(created.id); return project(created)
  }
  async function additional(f: Fixture, e: Context, label: string) {
    const key = randomUUID(); owned.keys.add(key)
    const reply = await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/additional`, headers: { ...auth(f.owner), 'idempotency-key': key }, payload: { categoryId: 'photo', programEventId: e.id, label } })
    expect(reply.statusCode, reply.body).toBe(201)
    const created = reply.json<{ id: string; categoryId: string; programEventId: string; label: string }>()
    owned.slots.add(created.id); expect(created).toEqual({ id: expect.any(String), categoryId: 'photo', programEventId: e.id, label }); return created.id
  }
  const get = (f: Fixture, who = f.owner, query = '') => app.inject({ method: 'GET', url: `/weddings/${f.wedding}/slots${query}`, headers: auth(who) })
  async function list(f: Fixture) { const r = await get(f); expect(r.statusCode, r.body).toBe(200); return r.json<SlotJson[]>() }
  async function raw(f: Fixture) {
    const result: Record<string, string[]> = {}
    for (const table of ['slots', 'deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_resource_commitments', 'resource_allocations', 'leads']) {
      result[table] = (await app.db!.query<{ row: string }>(`select to_jsonb(t)::text as row from ${table} t where wedding_id=$1 order by to_jsonb(t)::text`, [f.wedding])).rows.map(r => r.row)
    }
    for (const table of ['payments', 'payment_installments', 'deal_events', 'deal_terms_versions', 'deal_terms_receipts', 'vendor_busy_dates']) {
      result[table] = (await app.db!.query<{ row: string }>(`select to_jsonb(t)::text as row from ${table} t where deal_id in(select id from deals where wedding_id=$1) order by to_jsonb(t)::text`, [f.wedding])).rows.map(r => r.row)
    }
    return result
  }

  it('returns two explicit same-category event contexts and explicit main, leaving implicit main DTO and real money unchanged', async () => {
    const f = await fixture()
    const booked = await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${f.implicit}/external`, headers: auth(f.owner), payload: { vendorName: 'Synthetic existing main performer', price: { amount: 1357900, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200)
    const deal = booked.json<SlotJson>().deal!.id as string; owned.deals.add(deal)
    const payment = randomUUID(); owned.payments.add(payment)
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',12345,'recorded','cash','private')", [payment, deal])
    const first = await event(f, { name: 'Ceremony second event', kind: 'ceremony', date: `${YEAR}-06-15`, timeZone: 'Pacific/Kiritimati', location: 'Synthetic east hall' })
    const second = await event(f, { name: 'Second day west', kind: 'second_day', date: `${YEAR}-06-16`, timeZone: 'Pacific/Honolulu', location: 'Synthetic west hall' })
    const a = await additional(f, first, 'Photo event A'), b = await additional(f, second, 'Photo event B'), mainSlot = await additional(f, f.main, 'Explicit main photo')
    const before = await raw(f), rows = await list(f)
    expect(a).not.toBe(b)
    expect(rows.find(s => s.id === a)).toMatchObject({ id: a, categoryId: 'photo', label: 'Photo event A', programEvent: first, deal: null })
    expect(rows.find(s => s.id === b)).toMatchObject({ id: b, categoryId: 'photo', label: 'Photo event B', programEvent: second, deal: null })
    expect(rows.find(s => s.id === a)?.programEvent).toEqual(first); expect(rows.find(s => s.id === b)?.programEvent).toEqual(second)
    expect(rows.find(s => s.id === mainSlot)?.programEvent).toEqual(project(f.main))
    const legacy = rows.find(s => s.id === f.implicit)!
    expect(Object.hasOwn(legacy, 'programEvent')).toBe(false)
    expect(legacy.deal).toMatchObject({ id: deal, price: { amount: 1357900, currency: 'RUB' }, paid: { amount: 12345, currency: 'RUB' } })
    expect(await raw(f)).toEqual(before)
  })
  it('keeps actual nullable event date/timeZone unknown instead of substituting the wedding date/zone', async () => {
    const f = await fixture(), e = await event(f, { name: 'Date not agreed', kind: 'other', date: null, timeZone: null, location: null })
    const slot = await additional(f, e, 'Unknown event photo'), before = await raw(f)
    expect((await list(f)).find(s => s.id === slot)?.programEvent).toEqual({ ...e, date: null, timeZone: null })
    expect(await raw(f)).toEqual(before)
  })
  it('reads fresh event PATCH context while retaining both slot identities/category/deal and all financial/history rows', async () => {
    const f = await fixture(), a = await event(f, { name: 'Before move', kind: 'ceremony', date: `${YEAR}-07-01`, timeZone: 'Europe/Moscow' })
    const b = await event(f, { name: 'Unchanged neighbor', kind: 'second_day', date: `${YEAR}-07-02`, timeZone: 'Asia/Novosibirsk' })
    const sa = await additional(f, a, 'Photo A'), sb = await additional(f, b, 'Photo B'), rawBefore = await raw(f), before = await list(f)
    const version = await app.inject({ method: 'GET', url: `/weddings/${f.wedding}/events`, headers: auth(f.owner) })
    const patch = { name: 'After move', date: `${YEAR}-07-03`, timeZone: 'Pacific/Honolulu', location: 'New hall' }
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${f.wedding}/events/${a.id}`, headers: { ...auth(f.owner), 'if-match': version.headers.etag! }, payload: patch })
    expect(changed.statusCode, changed.body).toBe(200)
    const after = await list(f), previousA = before.find(s => s.id === sa)!, currentA = after.find(s => s.id === sa)!
    expect(currentA.programEvent).toEqual({ ...a, ...patch })
    const withoutContext = (s: SlotJson) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'programEvent'))
    expect(withoutContext(currentA)).toEqual(withoutContext(previousA)); expect(after.find(s => s.id === sb)).toEqual(before.find(s => s.id === sb))
    expect(await raw(f)).toEqual(rawBefore)
  })
  it('binds context to the stored wedding/slot and preserves outsider denial plus helper money privacy', async () => {
    const f = await fixture(), foreign = await fixture(), outsider = await actor(), helper = await actor()
    const ownEvent = await event(f, { name: 'Own event', kind: 'other', date: `${YEAR}-08-01`, timeZone: 'Europe/Moscow' })
    const foreignEvent = await event(foreign, { name: 'Foreign event', kind: 'other', date: `${YEAR}-08-02`, timeZone: 'Pacific/Honolulu' })
    const slot = await additional(f, ownEvent, 'Own position'); await additional(foreign, foreignEvent, 'Foreign position')
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [f.wedding, helper.id])
    const booked = await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${f.implicit}/external`, headers: auth(f.owner), payload: { vendorName: 'Private main performer', price: { amount: 2468000, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200); const deal = booked.json<SlotJson>().deal!.id as string; owned.deals.add(deal)
    const before = await raw(f)
    for (const stranger of [outsider, foreign.owner]) {
      const denied = await get(f, stranger)
      expect(denied.statusCode, denied.body).toBe(404); expect(denied.body).not.toContain(ownEvent.id)
    }
    const helperRead = await get(f, helper); expect(helperRead.statusCode, helperRead.body).toBe(200)
    expect(helperRead.json<SlotJson[]>().find(s => s.id === slot)?.programEvent).toEqual(ownEvent)
    const hiddenMoney = helperRead.json<SlotJson[]>().find(s => s.id === f.implicit)!.deal!
    expect(hiddenMoney.id).toBe(deal); expect(Object.hasOwn(hiddenMoney, 'price')).toBe(false); expect(Object.hasOwn(hiddenMoney, 'paid')).toBe(false)
    const spoofed = await get(f, f.owner, `?programEventId=${foreignEvent.id}`)
    expect(spoofed.statusCode, spoofed.body).toBe(200)
    expect(spoofed.json<SlotJson[]>().find(s => s.id === slot)?.programEvent).toEqual(ownEvent)
    expect(spoofed.body).not.toContain(foreignEvent.id); expect(await raw(f)).toEqual(before)
  })
  it('does not expose the new event name/location/id object through an external guest-vendor token', async () => {
    const f = await fixture(), slot = await additional(f, f.main, 'Explicit main external position')
    const booked = await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${slot}/external`, headers: auth(f.owner), payload: { vendorName: 'Token-only main performer', price: { amount: 150000, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200); owned.deals.add(booked.json<SlotJson>().deal!.id as string)
    const invited = await app.inject({ method: 'POST', url: `/weddings/${f.wedding}/slots/${slot}/external/invite`, headers: auth(f.owner) })
    expect(invited.statusCode, invited.body).toBe(201)
    const token = invited.json<{ token: string }>().token
    const pin = (await app.db!.query<{ program_identity: string }>('select program_identity from external_invites where token=$1', [token])).rows[0]!
    owned.externalInvites.add(pin.program_identity)
    const guest = await app.inject({ method: 'GET', url: `/guest-vendor/${token}` })
    expect(guest.statusCode, guest.body).toBe(200)
    const body = guest.json<{ slot: SlotJson; chatId: string }>(); owned.chats.add(body.chatId)
    expect(body.slot.id).toBe(slot); expect(Object.hasOwn(body.slot, 'programEvent')).toBe(false)
    expect(guest.body).not.toContain(f.main.id)
    expect((await list(f)).find(s => s.id === slot)?.programEvent).toEqual(project(f.main))
  })
})
