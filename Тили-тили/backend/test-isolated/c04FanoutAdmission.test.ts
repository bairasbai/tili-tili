import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { readAdmission, assertTestURLs, assertIdentity, assertNativeAdmission } from '../test-support/c04-c05-native-admission.mjs'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { notificationPushReady } from '../src/notify/preflight.js'
import type { Db, Queryable } from '../src/plugins/db.js'

// Eventual placement: backend/test-isolated/c04FanoutAdmission.test.ts.
// Dedicated target/config only: generic receipt claims run a global expiry sweep.
// No candidate helper/constants/SQL or synthetic business results are imported.
const admission = readAdmission('tests')
const TARGET = admission.targetName
const URL = admission.targetURL
const APP = 'c04batch_' + randomUUID(), SECRET = 'independent-c04-batch-secret'.repeat(3), POLICY = '2026-09-02'
const DATE = `${new Date().getUTCFullYear() + 1}-06-14`, NEXT = `${new Date().getUTCFullYear() + 1}-06-15`
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const QUOTA = 4_210_005, BARRIER = 2_147_483_001 // Existing quota; proposed private barrier, separately admitted by root.
type Response = Awaited<ReturnType<FastifyInstance['inject']>>
type Owner = 'O01' | 'O02' | 'O03' | 'O04' | 'O05' | 'O06' | 'O07' | 'O08' | 'O09' | 'O10' | 'O11' | 'O12'
const OWNERS: Owner[] = ['O01','O02','O03','O04','O05','O06','O07','O08','O09','O10','O11','O12']
interface Actor { id: string; sid: string; token: string }
interface Vendor { id: string; actor: Actor }
interface Fixture { id: string; owner: Actor; partner: Actor; vendors: Vendor[]; slot: string; main: string; block: string; task: string }
interface Meta { pid: number; xid: string }
interface Entry { seq: number; sql: string; meta: Meta; quota: number[]; notice?: { id: string; user: string; kind: string; title: string } }
interface Notice extends pg.QueryResultRow { id: string; user_id: string; kind: string; title: string; body: string; link: string | null;
  deliver_after: Date; pushed_at: Date | null; cancelled_at: Date | null; push_disposition: string; task_id: string | null; expires_at: Date | null }
interface Command { f: Fixture; owner: Owner; actor: Actor; method: 'POST' | 'PATCH'; path: string; payload?: object;
  headers?: Record<string,string>; status: number; copies: { user: string; kind: string; title: string }[]; receipt?: string; key: string }
interface Gate { entered: Promise<void>; pause(): Promise<void>; open(): void }
interface Catalog { kind: 'schema' | 'function' | 'trigger'; name: string; oid: string; owner: string; definition?: string }
interface Probe { before?(sql: string, values: readonly unknown[] | undefined, client: Queryable, meta: Meta | null): Promise<void>;
  after?(sql: string, values: readonly unknown[] | undefined, client: Queryable, meta: Meta | null, result: pg.QueryResult): Promise<void> }

describe.sequential('independent C04 selected fanout owners, receipts and final-domain quota', () => {
  let app: FastifyInstance | undefined, raw: Db | undefined, observer: pg.Client | undefined, probe: Probe = {}, tracking = false
  let trace: Entry[] = [], seq = 0
  const allocated = new Map<string,string>(), createdUsers = new Set<string>(), createdWeddings = new Set<string>(), receiptKeys = new Set<string>()
  const controllers = new Set<pg.Client>(), requests = new Set<Promise<Response>>(), gates = new Set<Gate>(), catalog: Catalog[] = []
  const schemaId = randomUUID(), schema = 'c04b_' + schemaId.replaceAll('-', '')
  const note = (value: object) => process.stdout.write(`C04_BATCH_WITNESS ${JSON.stringify(value)}\n`)
  function record(kind: string, id: string, beforeWrite: boolean) {
    assert.match(id, UUID)
    if (!allocated.has(id)) { allocated.set(id, kind); note({ event: 'uuid-journal', kind, id, beforeWrite }) }
    return id
  }
  const allocate = (kind: string) => record(kind, randomUUID(), true)
  const db = () => { assert(raw); return raw }, see = () => { assert(observer); return observer }, application = () => { assert(app); return app }
  function gate(): Gate {
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), wait = new Promise<void>(resolve => { release = resolve })
    const g = { entered: ready, async pause() { entered(); await wait }, open() { release() } }; gates.add(g); return g
  }
  async function bounded<T>(promise: Promise<T>, label: string, ms = 8_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ': bounded deadline')), ms) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  async function identity(client: Queryable) {
    const r = (await client.query<{ name: string; username: string; port: number; address: string; oid: string; pid: number }>(`select current_database() as name,current_user as username,
      inet_server_port() as port,host(inet_server_addr()) as address,pg_backend_pid() as pid,(select oid::text from pg_database where datname=current_database()) as oid`)).rows[0]!
    assertIdentity(r, admission.profile, admission.creation); return r
  }
  function forward(): Db {
    const wrap = (client: Queryable, meta: Meta | null): Queryable => ({ async query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: readonly unknown[]) {
      if (/^\s*insert\s+into\s+\w+/i.test(sql) && typeof values?.[0] === 'string' && UUID.test(values[0])) record('production-insert-candidate', values[0], true)
      if (/^\s*insert\s+into\s+idempotency_keys\b/i.test(sql) && typeof values?.[0] === 'string') receiptKeys.add(values[0])
      await probe.before?.(sql, values, client, meta)
      const result = await client.query<T>(sql, values)
      // Native default UUIDs are rebound from actual rows; no fabricated ID is substituted.
      if (/^\s*insert\s+into\s+event_rsvp_requests\b/i.test(sql)) for (const row of result.rows) if (typeof row.id === 'string') record('native-default-rsvp-request', row.id, false)
      if (tracking && meta) {
        const locks = (await client.query<{ key: string }>(`select objid::text as key from pg_locks where pid=pg_backend_pid()
          and locktype='advisory' and granted and classid=$1::oid and objsubid=2 order by objid`, [QUOTA])).rows
          .map(r => { const n = Number(r.key); return n > 2_147_483_647 ? n - 4_294_967_296 : n })
        const entry: Entry = { seq: ++seq, sql, meta, quota: locks }
        if (/^\s*insert\s+into\s+notifications\b/i.test(sql)) {
          assert(values && typeof values[0] === 'string' && typeof values[1] === 'string')
          entry.notice = { id: values[0], user: values[1], kind: String(values[2]), title: String(values[3]) }
        }
        trace.push(entry)
      }
      await probe.after?.(sql, values, client, meta, result); return result
    } })
    return { query: wrap(db(), null).query, tx: action => db().tx(async client => {
      const r = await identity(client), xid = (await client.query<{ xid: string }>('select txid_current()::text as xid')).rows[0]!.xid
      return action(wrap(client, { pid: r.pid, xid }))
    }), ping: () => db().ping(), close: () => db().close() }
  }
  beforeAll(async () => {
    assertTestURLs(process.env, admission.profile)
    const u = new globalThis.URL(URL); u.searchParams.set('application_name', APP)
    observer = new pg.Client({ connectionString: u.href.replace(APP, 'c04obs_' + randomUUID()) }); await observer.connect(); note({ event: 'actual-preflight', identity: await identity(observer) })
    await assertNativeAdmission(observer, admission)
    app = await buildApp({ env: 'test', databaseUrl: u.href, redisUrl: null, corsOrigins: [], jwtAccessSecret: SECRET,
      jwtRefreshSecret: SECRET + '-refresh', policyVersion: POLICY, rateLimitPerSecond: 0, vapidPublicKey: null, vapidPrivateKey: null }, [], { tillyModel: null })
    await app.ready(); raw = app.db!; await identity(raw)
    const initial = (await raw.query<{ users: string; keys: string }>('select (select count(*)::text from users) as users,(select count(*)::text from idempotency_keys) as keys')).rows[0]!
    expect(initial).toEqual({ users: '0', keys: '0' }); note({ event: 'isolated-start', initial })
    app.db = forward()
  }, 20_000)
  async function controller() {
    const u = new globalThis.URL(URL); u.searchParams.set('application_name', 'c04ctl_' + randomUUID())
    const client = new pg.Client({ connectionString: u.href }); controllers.add(client); await client.connect()
    const r = await identity(client); await client.query('begin'); return { client, pid: r.pid }
  }
  async function release(client: pg.Client) {
    if (!controllers.has(client)) return
    try { await client.query('rollback') } finally { await client.end(); controllers.delete(client) }
  }
  function request(method: 'POST' | 'PATCH' | 'GET' | 'DELETE', path: string, a?: Actor, payload?: object, headers: Record<string,string> = {}) {
    const pending = Promise.resolve(application().inject({ method, url: path, headers: { ...headers, ...(a ? { authorization: 'Bearer ' + a.token } : {}) }, ...(payload ? { payload } : {}) }))
    requests.add(pending); void pending.then(() => requests.delete(pending), () => requests.delete(pending)); return pending
  }
  async function settle() {
    const failures: unknown[] = []
    for (const g of gates) g.open(); gates.clear()
    for (const c of [...controllers]) try { await release(c) } catch (e) { failures.push(e) }
    try { await bounded(Promise.allSettled([...requests]), 'settle owned requests', 9_000) }
    catch (e) {
      failures.push(e)
      for (const r of (await see().query<{pid:number}>('select pid from pg_stat_activity where datname=$1 and application_name=$2 and state=\'active\'', [TARGET, APP])).rows) {
        note({ event: 'cancel-own-active-query', pid: r.pid }); await see().query('select pg_cancel_backend($1)', [r.pid])
      }
      await bounded(Promise.allSettled([...requests]), 'settle cancelled own requests', 5_000)
    } finally { probe = {}; tracking = false }
    if (failures.length) throw new AggregateError(failures, 'C04 request/controller cleanup failed')
  }
  async function catalogCleanup() {
    for (const c of [...catalog].reverse()) {
      if (c.kind === 'trigger') {
        const row = (await db().query<{ oid:string;owner:string;definition:string }>(`select t.oid::text,cl.relowner::text as owner,pg_get_triggerdef(t.oid) as definition
          from pg_trigger t join pg_class cl on cl.oid=t.tgrelid where t.tgname=$1 and t.tgrelid='public.idempotency_keys'::regclass`, [c.name])).rows[0]
        assert.deepEqual(row, { oid: c.oid, owner: c.owner, definition: c.definition }); await db().query(`drop trigger ${c.name} on public.idempotency_keys`)
      } else if (c.kind === 'function') {
        const row = (await db().query<{oid:string;owner:string;definition:string}>('select oid::text,proowner::text as owner,pg_get_functiondef(oid) as definition from pg_proc where oid=$1::oid', [c.oid])).rows[0]
        assert.deepEqual(row, { oid: c.oid, owner: c.owner, definition: c.definition }); await db().query(`drop function ${schema}.receipt_wait()`)
      } else {
        const row = (await db().query<{oid:string;owner:string}>('select oid::text,nspowner::text as owner from pg_namespace where nspname=$1', [schema])).rows[0]
        assert.deepEqual(row, { oid: c.oid, owner: c.owner }); await db().query(`drop schema ${schema}`)
      }
      catalog.splice(catalog.indexOf(c), 1); note({ event: 'owned-catalog-removed', kind: c.kind, oid: c.oid, name: c.name })
    }
  }
  afterEach(async () => { if (raw) { await settle(); await catalogCleanup() } }, 25_000)
  afterAll(async () => {
    const errors: unknown[] = []
    try {
      if (raw) {
        try { await settle(); await catalogCleanup() } catch (e) { errors.push(e) }
        await identity(raw); const users = [...createdUsers], all = [...allocated.keys()]
        const auditSql = 'select id::text,actor_id,action,entity,entity_id,at from audit_log where actor_id=any($1::uuid[]) or entity_id=any($2::uuid[]) order by id'
        const retained = (await raw.query(auditSql, [users, all])).rows; note({ event: 'audit-retention-before-cleanup', rows: retained, count: retained.length })
        for (const id of createdWeddings) await raw.query('delete from weddings where id=$1', [id])
        for (const key of receiptKeys) await raw.query('delete from idempotency_keys where key=$1 and user_id=any($2::uuid[])', [key, users])
        for (const id of users) await raw.query('delete from users where id=$1', [id])
        const counts = (await raw.query<{users:string;weddings:string;prefs:string;sessions:string;consents:string;notices:string;keys:string;subscriptions:string;deliveries:string}>(`select
          (select count(*)::text from users where id=any($1::uuid[])) as users,(select count(*)::text from weddings where id=any($2::uuid[])) as weddings,
          (select count(*)::text from notification_prefs where user_id=any($1::uuid[])) as prefs,(select count(*)::text from sessions where user_id=any($1::uuid[])) as sessions,
          (select count(*)::text from consents where user_id=any($1::uuid[])) as consents,(select count(*)::text from notifications where user_id=any($1::uuid[])) as notices,
          (select count(*)::text from idempotency_keys where key=any($3::text[])) as keys,
          (select count(*)::text from push_subscriptions where user_id=any($1::uuid[]) or id=any($4::uuid[])) as subscriptions,
          (select count(*)::text from notification_push_deliveries where notification_id=any($4::uuid[]) or subscription_id=any($4::uuid[])) as deliveries`, [users, [...createdWeddings], [...receiptKeys], all])).rows[0]!
        const afterAudit = (await raw.query(auditSql, [users, all])).rows
        note({ event: 'cleanup', counts, retainedAuditCount: afterAudit.length, retainedAudits: afterAudit, uuidManifest: [...allocated] })
        expect(counts).toEqual({ users:'0', weddings:'0', prefs:'0', sessions:'0', consents:'0', notices:'0', keys:'0', subscriptions:'0', deliveries:'0' }); expect(afterAudit).toEqual(retained)
        expect((await raw.query('select oid from pg_namespace where nspname=$1', [schema])).rows).toEqual([])
      }
    } catch (e) { errors.push(e) }
    finally { try { if (app) { if (raw) app.db = raw; await app.close() } } catch (e) { errors.push(e) }; try { await observer?.end() } catch (e) { errors.push(e) } }
    if (errors.length) throw new AggregateError(errors, 'C04 scoped cleanup failed; retain original case failures')
  }, 30_000)

  async function actor(): Promise<Actor> {
    const id = allocate('user'), sid = allocate('session'), cid = allocate('consent'); let inserted = false
    for (let n = 0; n < 8 && !inserted; n++) {
      const result = await db().query('insert into users(id,phone,name,tz) values($1,$2,$3,\'UTC\') on conflict(phone) do nothing returning id', [id, '+79' + randomInt(100_000_000, 999_999_999), 'Independent synthetic C04 actor'])
      inserted = result.rows[0]?.id === id
    }
    assert(inserted, 'bounded atomic synthetic phone allocation exhausted'); createdUsers.add(id)
    await db().query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid,id,randomUUID()])
    await db().query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [cid,id,POLICY])
    await db().query("insert into notification_prefs(user_id,quiet_from,quiet_to) values($1,'00:00','00:00')", [id])
    return { id, sid, token: await signAccessToken(SECRET, { sub:id,sid }) }
  }
  async function fixture(): Promise<Fixture> {
    const owner = await actor(), partner = await actor(), vendors: Vendor[] = []
    for (let n = 0; n < 3; n++) {
      const a = await actor(), id = allocate('vendor'); await db().query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo',$3,now())", [id,a.id,'Synthetic C04 vendor ' + n]); vendors.push({ id,actor:a })
    }
    const id = allocate('wedding'), slot = allocate('slot'), block = allocate('timeline-block'), task = allocate('task')
    await db().query("insert into weddings(id,owner_id,title,date,tz,invite_code,budget_total) values($1,$2,'Independent C04 fixture',$3,'UTC',$4,100000000)", [id,owner.id,DATE,randomUUID()]); createdWeddings.add(id)
    const main = (await db().query<{id:string}>('select id from wedding_events where wedding_id=$1 and is_main', [id])).rows[0]!.id; record('native-main-event',main,false)
    for (const [a,role] of [[owner,'couple'],[partner,'couple'],[vendors[0]!.actor,'helper'],[vendors[1]!.actor,'coordinator']] as const)
      await db().query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [id,a.id,role])
    await db().query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Independent photo position')", [slot,id])
    await db().query("insert into timeline_events(id,wedding_id,program_event_id,name,starts_at,ends_at,duration_minutes) values($1,$2,$3,'Independent future block',$4,$5,30)", [block,id,main,DATE+'T10:00:00Z',DATE+'T10:30:00Z'])
    await db().query("insert into timeline_assignments(wedding_id,event_id,role,kind,reference_id) values($1,$2,'responsible','member',$3)", [id,block,vendors[0]!.actor.id])
    await db().query("insert into tasks(id,wedding_id,title,kind,source,due,due_mode,assignee_id) values($1,$2,'Independent relative task','checklist','user',$3,'relative',$4)", [task,id,DATE,vendors[0]!.actor.id])
    return { id,owner,partner,vendors,slot,main,block,task }
  }
  async function openRequest(f: Fixture, vendor: Vendor) {
    const id = allocate('offer-request'); await db().query('insert into offer_requests(id,slot_id,vendor_id,wedding_date,created_by) values($1,$2,$3,$4,$5)', [id,f.slot,vendor.id,DATE,f.owner.id]); return id
  }
  async function prepare(owner: Owner): Promise<Command> {
    const f = await fixture(), key = allocate('client-attempt'), base = `/weddings/${f.id}`
    const c: Command = { f,owner,actor:f.owner,method:'POST',path:base,status:200,copies:[],key,headers:{'idempotency-key':key} }
    const copy = (user: string, kind: string, title: string) => c.copies.push({user,kind,title})
    if (owner === 'O01') {
      const preview = await request('POST',base+'/timeline/shift/preview',f.owner,{scope:{kind:'day',date:DATE},minutes:15})
      expect(preview.statusCode,preview.body).toBe(200); expect(preview.json().canConfirm).toBe(true); assert(preview.json().previewToken)
      c.path = base+'/timeline/shift'; c.payload = {previewToken:preview.json().previewToken}; c.headers!['if-match'] = String(preview.headers.etag); c.receipt='timeline-shift-v2'
      for (const a of [f.partner,f.vendors[0]!.actor,f.vendors[1]!.actor]) copy(a.id,'system','Тайминг сдвинут')
    } else if (owner === 'O02') {
      const party = allocate('guest-party'), guest = allocate('guest'), event = allocate('additional-event'), token = randomUUID()
      await db().query('insert into guest_parties(id,wedding_id,invite_token,label) values($1,$2,$3,\'Synthetic invited family\')',[party,f.id,token])
      await db().query("insert into guests(id,wedding_id,name,rsvp_token,party_id) values($1,$2,'Synthetic late guest',$3,$4)",[guest,f.id,token,party])
      const deadline = new Date(Date.now()-2*86_400_000).toISOString().slice(0,10)
      await db().query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,rsvp_deadline) values($1,$2,'Independent extra event','other',$3,'UTC',$4)",[event,f.id,NEXT,deadline])
      await db().query('insert into guest_event_invitations(wedding_id,event_id,guest_id) values($1,$2,$3)',[f.id,event,guest])
      c.path=`/rsvp/${token}/events/${event}/requests`; c.payload={guestId:guest,requestedStatus:'attending',comment:'Synthetic late request'}; c.status=201
      for(const a of [f.owner,f.partner])copy(a.id,'guest','Просьба изменить ответ')
    } else if (owner === 'O03' || owner === 'O04' || owner === 'O05' || owner === 'O06') {
      for (const v of f.vendors.slice(0,2)) await openRequest(f,v)
      if(owner==='O03'){ const e=await request('GET',base+'/events',f.owner); expect(e.statusCode).toBe(200);c.method='PATCH';c.path=base+'/events/'+f.main;c.payload={date:NEXT};c.headers!['if-match']=String(e.headers.etag) }
      if(owner==='O04'){c.method='PATCH';c.payload={date:NEXT,style:'Independent accepted ordinary field'}}
      if(owner==='O05'){c.path=base+'/reschedule';c.payload={date:NEXT};c.receipt='weddings.reschedule'}
      if(owner==='O06'){await db().query('delete from wedding_members where wedding_id=$1 and user_id=$2',[f.id,f.partner.id]);c.path=base+'/cancel'}
      for(const v of f.vendors.slice(0,2))copy(v.actor.id,'deal',owner==='O06'?'Свадьба отменена':'Дата свадьбы изменилась')
      if(owner!=='O06')for(const a of [f.partner,f.vendors[0]!.actor,f.vendors[1]!.actor])copy(a.id,'system','Дата свадьбы изменена')
    } else if(owner==='O07') {
      const entries:string[]=[]
      for(let i=0;i<2;i++){const id=allocate('shortlist');entries.push(id);await db().query('insert into slot_shortlist(id,slot_id,vendor_id,position,added_by) values($1,$2,$3,$4,$5)',[id,f.slot,f.vendors[i]!.id,i+1,f.owner.id]);copy(f.vendors[i]!.actor.id,'deal','Новый запрос предложения')}
      c.path=base+'/slots/'+f.slot+'/offer-requests';c.payload={entryIds:entries};c.status=201;c.receipt='offer-requests.create'
    } else if(owner==='O12') {
      const id=await openRequest(f,f.vendors[0]!);c.actor=f.vendors[0]!.actor;c.path=`/vendor/offer-requests/${id}/offers`;c.status=201;c.receipt='vendor.offer-response'
      c.payload={kind:'offer',title:'Private synthetic offer',price:{amount:17000,currency:'RUB'},includes:['Private synthetic inclusion'],message:'Private synthetic message',validUntil:DATE}
      for(const a of [f.owner,f.partner])copy(a.id,'deal','Новое предложение')
    } else {
      if(owner==='O10') {
        const primed=await request('POST',base+'/slots/'+f.slot+'/book',f.owner,{vendorId:f.vendors[0]!.id,price:{amount:15000,currency:'RUB'}},{'idempotency-key':allocate('prime-attempt')})
        expect(primed.statusCode,primed.body).toBe(200); const selected=primed.json().deal.id as string
        c.path=base+'/slots/'+f.slot+'/replace';c.payload={expectedSelectedDealId:selected,expectedSelectedDealState:'booked',vendorId:f.vendors[2]!.id,price:{amount:17000,currency:'RUB'},expectedPolicyRevision:'0'};c.receipt='slots.replace'
      }
      for(const v of f.vendors.slice(0,2)) { await openRequest(f,v);copy(v.actor.id,'deal','Пара выбрала другого исполнителя') }
      if(owner==='O08') {
        const selectedRequest=await openRequest(f,f.vendors[2]!), offer=allocate('offer')
        await db().query("insert into offers(id,request_id,kind,title,price,includes,valid_until,created_by) values($1,$2,'offer','Independent selected terms',16000,'[]'::jsonb,$3,$4)",[offer,selectedRequest,DATE,f.vendors[2]!.actor.id])
        c.path=base+'/offers/'+offer+'/accept';c.receipt='offers.accept'
      }
      if(owner==='O09'){c.path=base+'/slots/'+f.slot+'/book';c.payload={vendorId:f.vendors[2]!.id,price:{amount:17000,currency:'RUB'}};c.receipt='slots.book'}
      if(owner==='O11'){c.path=base+'/slots/'+f.slot+'/external';c.payload={vendorName:'Independent external performer',price:{amount:17000,currency:'RUB'}}}
    }
    return c
  }
  const command = (c: Command, a = c.actor) => request(c.method,c.path,a,c.payload,c.headers)
  const scopedReceipt = (c: Command) => c.receipt ? `${c.actor.id}:${c.receipt}:${c.key}` : null
  async function notices(f: Fixture) { return (await db().query<Notice>('select id,user_id,kind,title,body,link,deliver_after,pushed_at,cancelled_at,push_disposition,task_id,expires_at from notifications where user_id=any($1::uuid[]) order by id',[[f.owner.id,f.partner.id,...f.vendors.map(v=>v.actor.id)]])).rows }
  async function snapshot(f: Fixture) {
    const result: Record<string,unknown>={}
    for(const [name,sql] of [
      ['wedding',"select to_jsonb(w)-'invite_code' as row from weddings w where id=$1"],['tasks','select to_jsonb(t) as row from tasks t where wedding_id=$1 order by id'],
      ['timeline','select to_jsonb(t) as row from timeline_events t where wedding_id=$1 order by id'],['events','select to_jsonb(e) as row from wedding_events e where wedding_id=$1 order by id'],
      ['slots','select to_jsonb(s) as row from slots s where wedding_id=$1 order by id'],['deals','select to_jsonb(d) as row from deals d where wedding_id=$1 order by id'],
      ['requests','select to_jsonb(r) as row from offer_requests r join slots s on s.id=r.slot_id where s.wedding_id=$1 order by r.id'],
      ['offers','select to_jsonb(o) as row from offers o join offer_requests r on r.id=o.request_id join slots s on s.id=r.slot_id where s.wedding_id=$1 order by o.id'],
      ['broadcasts','select to_jsonb(b) as row from broadcasts b where wedding_id=$1 order by id'],['shifts','select to_jsonb(s) as row from timeline_shifts s where wedding_id=$1 order by id'],
      ['rsvp','select to_jsonb(r) as row from event_rsvp_requests r where wedding_id=$1 order by id'],
    ] as const)result[name]=(await db().query(sql,[f.id])).rows
    result.busy=(await db().query('select to_jsonb(b) as row from vendor_busy_dates b where vendor_id=any($1::uuid[]) order by vendor_id,date',[f.vendors.map(v=>v.id)])).rows
    result.vendorUpdates=(await db().query('select to_jsonb(v) as row from vendor_updates v where wedding_id=$1 order by id',[f.id])).rows
    result.dealEvents=(await db().query('select to_jsonb(e) as row from deal_events e join deals d on d.id=e.deal_id where d.wedding_id=$1 order by e.id',[f.id])).rows
    result.orders=(await db().query('select to_jsonb(o) as row from deal_orders o where wedding_id=$1 order by deal_id',[f.id])).rows
    result.notices=await notices(f)
    result.audit=(await db().query('select id::text,actor_id,action,entity,entity_id,at from audit_log where actor_id=any($1::uuid[]) or entity_id=any($2::uuid[]) order by id',[[f.owner.id,f.partner.id,...f.vendors.map(v=>v.actor.id)],[...allocated.keys()]])).rows
    return result
  }
  async function domainAccepted(c: Command) {
    const f=c.f, w=(await db().query<{date:string;cancelled_at:Date|null;archived_at:Date|null;style:string|null}>('select date::text,cancelled_at,archived_at,style from weddings where id=$1',[f.id])).rows[0]!
    if(c.owner==='O01'){expect((await db().query<{starts_at:Date}>('select starts_at from timeline_events where id=$1',[f.block])).rows[0]!.starts_at.toISOString()).toBe(DATE+'T10:15:00.000Z')}
    if(['O03','O04','O05'].includes(c.owner)){expect(w.date).toBe(NEXT);expect((await db().query<{due:string}>('select due::text from tasks where id=$1',[f.task])).rows[0]!.due).toBe(NEXT);if(c.owner==='O04')expect(w.style).toBe('Independent accepted ordinary field')}
    if(c.owner==='O06'){expect(w.cancelled_at).not.toBeNull();expect(w.archived_at).not.toBeNull()}
    if(c.owner==='O02')expect((await db().query('select requested_status,state from event_rsvp_requests where wedding_id=$1',[f.id])).rows).toEqual([{requested_status:'attending',state:'pending'}])
    if(c.owner==='O07')expect((await db().query('select status from offer_requests where slot_id=$1',[f.slot])).rows).toEqual([{status:'open'},{status:'open'}])
    if(['O08','O09','O10','O11'].includes(c.owner)){const d=(await db().query<{state:string;vendor_id:string|null;external_name:string|null}>('select d.state,d.vendor_id,d.external_name from slots s join deals d on d.id=s.deal_id where s.id=$1',[f.slot])).rows[0]!;expect(d.state).toBe('booked');expect(c.owner==='O11'?d.external_name:d.vendor_id).toBe(c.owner==='O11'?'Independent external performer':f.vendors[2]!.id)}
    if(c.owner==='O12')expect((await db().query('select o.title,o.kind from offers o join offer_requests r on r.id=o.request_id where r.slot_id=$1',[f.slot])).rows).toEqual([{title:'Private synthetic offer',kind:'offer'}])
  }
  async function sameBatch(c: Command, rows: Notice[]) {
    const inserts=trace.filter(e=>e.notice), calls=inserts.map(e=>e.notice!)
    const compare=(a:object,b:object)=>JSON.stringify(a).localeCompare(JSON.stringify(b))
    expect(calls.map(n=>({user:n.user,kind:n.kind,title:n.title})).sort(compare)).toEqual([...c.copies].sort(compare))
    // Preserve distinct within-user invocation order; unordered UNION recipient traversal is not invented as a policy.
    for(const user of new Set(c.copies.map(n=>n.user)))expect(calls.filter(n=>n.user===user).map(n=>n.kind+':'+n.title))
      .toEqual(c.copies.filter(n=>n.user===user).map(n=>n.kind+':'+n.title))
    if(c.owner==='O01')expect(calls.map(n=>n.user)).toEqual([...c.copies.map(n=>n.user)].sort())
    expect(inserts.length).toBeGreaterThanOrEqual(2);expect(new Set(inserts.map(e=>e.meta.pid+':'+e.meta.xid)).size).toBe(1)
    expect(rows.map(n=>({user:n.user_id,kind:n.kind,title:n.title})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual([...c.copies].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))
    const granted=new Set<number>(), acquisition: {seq:number;key:number}[]=[]
    for(const e of trace){const fresh=e.quota.filter(key=>!granted.has(key));assert(fresh.length<=1,'one SQL statement acquired multiple quota keys; trace does not prove their internal order');for(const key of fresh){granted.add(key);acquisition.push({seq:e.seq,key})}}
    const expectedKeys=[...new Set((await db().query<{key:number}>('select hashtext(id) as key from unnest($1::text[]) as ids(id)',[[...new Set(c.copies.map(n=>n.user))]])).rows.map(r=>r.key))].sort((a,b)=>a-b)
    expect(acquisition.map(a=>a.key)).toEqual(expectedKeys)
    expect(acquisition.length).toBeGreaterThanOrEqual(2);expect(inserts[0]!.seq).toBeGreaterThan(acquisition.at(-1)!.seq)
    const domain=trace.filter(e=>/^\s*(insert\s+into|update|delete\s+from)\s+(?!notifications\b|idempotency_keys\b)\w+/i.test(e.sql))
    for(const e of domain)expect(e.seq,'domain DML remained after quota acquisition: '+e.sql.slice(0,100)).toBeLessThan(acquisition[0]!.seq)
    note({ event:'actual-batch',owner:c.owner,trace,actualNoticeIds:rows.map(n=>n.id),acquisition })
  }
  async function observedWait(pending: Promise<Response>, holder: number, matches: (sql:string)=>boolean) {
    let settled=false;void pending.then(()=>{settled=true},()=>{settled=true});const until=Date.now()+3_000
    while(Date.now()<until){const rows=(await see().query<{pid:number;query:string;blockers:number[]}>(`select pid,query,pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname=$1 and application_name=$2 and state='active' and wait_event_type='Lock'`,[TARGET,APP])).rows.filter(r=>matches(r.query))
      if(rows.length){assert.equal(rows.length,1);assert.deepEqual(rows[0]!.blockers,[holder]);note({event:'real-wait',holder,row:rows[0]});return rows[0]!}
      assert(!settled,'request settled before the mandatory real wait');await new Promise(resolve=>setTimeout(resolve,50))}
    throw new Error('mandatory real wait did not appear')
  }
  function exp(a:Actor):number{const value=JSON.parse(Buffer.from(a.token.split('.')[1]!,'base64url').toString('utf8'));assert.equal(value.sub,a.id);assert.equal(value.sid,a.sid);assert(Number.isInteger(value.exp));return value.exp}
  async function expireAtBarrier(a:Actor,pid:number){const expires=exp(a);assert(Date.now()<expires*1_000,'already expired before real barrier');const deadline=Date.now()+7_000
    while(Date.now()<=expires*1_000+100){assert(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,50))}
    const now=(await see().query<{at:Date}>('select clock_timestamp() as at')).rows[0]!.at;assert(now.getTime()>expires*1_000);note({event:'actual-exp-crossed',exp:expires,at:now.toISOString(),appPid:pid})}
  async function timelineBarrier(key:string){
    assert.equal(process.env.C04_BATCH_BARRIER_NAMESPACE_ADMITTED,String(BARRIER),'root must first admit actual-main private namespace/catalog mechanism')
    assert.match(schema,/^c04b_[0-9a-f]{32}$/);assert.match(key,/^[0-9a-f-]{36}:timeline-shift-v2:[0-9a-f-]{36}$/)
    record('private-barrier-namespace',schemaId,true)
    expect(catalog).toHaveLength(0)
    const created=await db().tx(async client=>{
      await identity(client)
      expect((await client.query('select oid from pg_namespace where nspname=$1',[schema])).rows).toEqual([])
      expect((await client.query<{name:string}>("select n.nspname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='idempotency_keys'::regclass")).rows).toEqual([{name:'public'}])
      const journal:Catalog[]=[]
      // Catalog creation and OID/definition journaling commit together; partial setup rolls back natively.
      await client.query(`create schema ${schema}`);const s=(await client.query<{oid:string;owner:string}>('select oid::text,nspowner::text as owner from pg_namespace where nspname=$1',[schema])).rows[0]!;journal.push({kind:'schema',name:schema,...s})
      await client.query(`create function ${schema}.receipt_wait() returns trigger language plpgsql as $c04$ begin perform pg_advisory_xact_lock(${BARRIER},1); return NEW; end; $c04$`)
      const fn=(await client.query<{oid:string;owner:string;definition:string}>('select oid::text,proowner::text as owner,pg_get_functiondef(oid) as definition from pg_proc where pronamespace=$1::oid and proname=\'receipt_wait\'',[s.oid])).rows[0]!;journal.push({kind:'function',name:'receipt_wait',...fn})
      const name='c04bt_'+schema.slice(5)
      await client.query(`create trigger ${name} before update of status,body on public.idempotency_keys for each row when (OLD.status is null and NEW.status=200 and NEW.key='${key}') execute function ${schema}.receipt_wait()`)
      const t=(await client.query<{oid:string;owner:string;definition:string}>(`select t.oid::text,cl.relowner::text as owner,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class cl on cl.oid=t.tgrelid where t.tgname=$1 and t.tgrelid='public.idempotency_keys'::regclass`,[name])).rows[0]!;journal.push({kind:'trigger',name,...t})
      return journal
    })
    catalog.push(...created);note({event:'owned-barrier-catalog',catalog,key,namespace:BARRIER})
  }

  async function subscriptionConfig<T>(action:()=>Promise<T>):Promise<T>{
    const config=application().appConfig,previous={public:config.vapidPublicKey,private:config.vapidPrivateKey}
    // Only the registered POST presence guard is exercised. No provider sender/job is invoked.
    config.vapidPublicKey='synthetic-presence-only';config.vapidPrivateKey='synthetic-presence-only'
    try{return await action()}finally{config.vapidPublicKey=previous.public;config.vapidPrivateKey=previous.private}
  }
  async function subscriptionStable(users:string[]){
    const queries=[
      ['users','select id,name,tz,deleted_at from users where id=any($1::uuid[]) order by id'],
      ['prefs','select to_jsonb(p) as row from notification_prefs p where user_id=any($1::uuid[]) order by user_id'],
      ['sessions',"select to_jsonb(s)-'refresh_hash' as row from sessions s where user_id=any($1::uuid[]) order by id"],
      ['consents',"select to_jsonb(c)-'ip'-'user_agent' as row from consents c where user_id=any($1::uuid[]) order by id"],
      ['notices','select id,user_id,pushed_at,cancelled_at,push_disposition,deliver_after from notifications where user_id=any($1::uuid[]) order by id'],
      ['deliveries','select d.* from notification_push_deliveries d join notifications n on n.id=d.notification_id where n.user_id=any($1::uuid[]) order by d.notification_id,d.subscription_id'],
      ['receipts','select key,status,body from idempotency_keys where user_id=any($1::uuid[]) order by key'],
      ['audits','select id,actor_id,action,entity,entity_id,at from audit_log where actor_id=any($1::uuid[]) order by id'],
    ] as const
    return Object.fromEntries(await Promise.all(queries.map(async([name,sql])=>[name,(await db().query(sql,[users])).rows])))
  }
  async function historicalNotice(user:Actor,subscription?:string){
    const id=allocate('subscription-historical-notice')
    await db().query("insert into notifications(id,user_id,kind,title,body,push_disposition,delivery_time_zone) values($1,$2,'system','Independent historical notice','Synthetic','planned','UTC')",[id,user.id])
    if(subscription)await db().query("insert into notification_push_deliveries(notification_id,subscription_id,status,attempts) values($1,$2,'queued',0)",[id,subscription])
    return id
  }
  async function subscriptionFact(id:string,endpoint:string,keys:object){
    // Sensitive transport material stays in request/query parameters and is never archived in witnesses.
    return (await db().query<{id:string;user_id:string;endpoint_matches:boolean;keys_match:boolean}>(
      'select id,user_id,(endpoint=$2) as endpoint_matches,(keys=$3::jsonb) as keys_match from push_subscriptions where id=$1',
      [id,endpoint,JSON.stringify(keys)])).rows
  }

  it.each(['absent','rebound'] as const)('subscription prepared %s identity refuses a committed foreign scope change after a real PG wait',async mode=>{
    await subscriptionConfig(async()=>{
      const caller=await actor(),original=await actor(),next=mode==='rebound'?await actor():original,users=[...new Set([caller.id,original.id,next.id])]
      const id=allocate('subscription-race'),endpoint='https://push.example.invalid/'+id
      const originalKeys={p256dh:'synthetic-original',auth:'synthetic-original'},changedKeys={p256dh:'synthetic-changed',auth:'synthetic-changed'},callerKeys={p256dh:'synthetic-caller',auth:'synthetic-caller'}
      if(mode==='rebound')await db().query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[id,original.id,endpoint,JSON.stringify(originalKeys)])
      else expect((await db().query('select id from push_subscriptions where endpoint=$1',[endpoint])).rows).toEqual([])
      await historicalNotice(original,mode==='rebound'?id:undefined)
      const before=await subscriptionStable(users),pause=gate(),holder=await controller();let boundary:string|undefined,response:Response|undefined
      probe={
        async after(sql,values,_client,_meta,result){
          if(!boundary&&/\bselect\b/i.test(sql)&&/\bpush_subscriptions\b/i.test(sql)&&values?.includes(endpoint)&&!/^\s*(insert|update|delete)\b/i.test(sql)){
            assert(!/\bfor\s+(?:no\s+key\s+)?update\b|\bfor\s+(?:key\s+)?share\b/i.test(sql),'locking locator cannot admit this committed-change schedule; use a separately reviewed prefix barrier')
            assert.equal(result.rowCount,mode==='absent'?0:1,'actual first locator disagrees with native initial fixture')
            boundary='actual-unlocked-locator';await pause.pause()
          }
        },
        async before(sql,values){if(!boundary&&/^\s*(insert\s+into|update)\s+push_subscriptions\b/i.test(sql)&&values?.includes(endpoint)){
          boundary='baseline-before-real-upsert';await pause.pause()
        }},
      }
      try{
        const pending=request('POST','/users/me/push-subscriptions',caller,{endpoint,keys:callerKeys})
        await bounded(pause.entered,'actual locator/upsert schedule',4_000)
        if(mode==='absent')await holder.client.query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[id,next.id,endpoint,JSON.stringify(changedKeys)])
        else{const changed=await holder.client.query('update push_subscriptions set user_id=$2,keys=$3::jsonb where id=$1 and user_id=$4 returning id',[id,next.id,JSON.stringify(changedKeys),original.id]);assert.equal(changed.rowCount,1)}
        pause.open()
        const waiter=await observedWait(pending,holder.pid,sql=>/\bpush_subscriptions\b/i.test(sql)&&/^\s*(insert|update|select|with)\b/i.test(sql))
        await holder.client.query('commit');response=await bounded(pending,'after committed foreign subscription change')
        note({case:'subscription-source-change',mode,boundary,holder:holder.pid,appPid:waiter.pid,initialId:mode==='rebound'?id:null,originalOwner:mode==='rebound'?original.id:null,committedId:id,committedOwner:next.id,status:response.statusCode,error:response.body?response.json().error?.code??null:null})
      }finally{pause.open();await release(holder.client);probe={}}
      expect(response.statusCode).toBe(409);expect(response.json().error?.code).toBe('push_subscription_scope_changed')
      expect(await subscriptionFact(id,endpoint,changedKeys)).toEqual([{id,user_id:next.id,endpoint_matches:true,keys_match:true}])
      expect((await db().query('select id from push_subscriptions where endpoint=$1',[endpoint])).rows).toEqual([{id}])
      expect(await subscriptionStable(users)).toEqual(before)
    })
  })
  it('ordinary subscription reassignment preserves 201 and identity; unconfigured 501 and self-user DELETE remain real controls',async()=>{
    await subscriptionConfig(async()=>{
      const caller=await actor(),original=await actor(),id=allocate('subscription-control'),endpoint='https://push.example.invalid/'+id,keys={p256dh:'synthetic-control',auth:'synthetic-control'}
      await db().query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[id,original.id,endpoint,JSON.stringify({p256dh:'synthetic-prior',auth:'synthetic-prior'})])
      const config=application().appConfig,saved=config.vapidPrivateKey;config.vapidPrivateKey=null
      try{const unavailable=await request('POST','/users/me/push-subscriptions',caller,{endpoint,keys});expect(unavailable.statusCode).toBe(501);expect(unavailable.json().error?.code).toBe('push_not_configured')}
      finally{config.vapidPrivateKey=saved}
      expect((await db().query('select id,user_id from push_subscriptions where id=$1',[id])).rows).toEqual([{id,user_id:original.id}])
      const response=await request('POST','/users/me/push-subscriptions',caller,{endpoint,keys});expect(response.statusCode,response.body).toBe(201)
      expect(await subscriptionFact(id,endpoint,keys)).toEqual([{id,user_id:caller.id,endpoint_matches:true,keys_match:true}])
      expect((await db().query('select id from push_subscriptions where endpoint=$1',[endpoint])).rows).toEqual([{id}])
      for(const a of [caller,original])await db().query('update consents set policy_version=$2 where user_id=$1',[a.id,'independent-old-policy'])
      config.vapidPublicKey=null;config.vapidPrivateKey=null
      expect((await request('DELETE','/users/me/push-subscriptions?endpoint='+encodeURIComponent(endpoint),original)).statusCode).toBe(204)
      expect(await subscriptionFact(id,endpoint,keys)).toHaveLength(1)
      expect((await request('DELETE','/users/me/push-subscriptions?endpoint='+encodeURIComponent(endpoint),caller)).statusCode).toBe(204)
      expect(await subscriptionFact(id,endpoint,keys)).toEqual([])
      note({case:'subscription-ordinary-controls',id,originalOwner:original.id,currentOwner:caller.id,status:201,unconfigured:501,foreignDelete:204,ownDelete:204,deleteOutdatedConsent:true,deleteUnconfigured:true})
    })
  })
  it('DELETE refuses observed same-ID foreign-owner change after a genuine row wait and preserves the whole scoped action',async()=>{
    const caller=await actor(),foreign=await actor(),users=[caller.id,foreign.id],id=allocate('subscription-delete-race'),endpoint='https://push.example.invalid/'+id
    const changedKeys={p256dh:'synthetic-delete-changed',auth:'synthetic-delete-changed'}
    await db().query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[id,caller.id,endpoint,JSON.stringify({p256dh:'synthetic-delete-prior',auth:'synthetic-delete-prior'})])
    await historicalNotice(caller,id);const before=await subscriptionStable(users),pause=gate(),holder=await controller();let boundary:string|undefined,response:Response|undefined,preparedSubscriptionLock=false
    const selected=(values:readonly unknown[]|undefined,value:string)=>values?.some(arg=>arg===value||(Array.isArray(arg)&&arg.includes(value)))??false
    const locator=(sql:string)=>/^\s*select\b/i.test(sql)&&/\bpush_subscriptions\b/i.test(sql)
    const rowLock=(sql:string)=>/\bfor\s+(?:no\s+key\s+)?update\b|\bfor\s+(?:key\s+)?share\b/i.test(sql)
    probe={
      async after(sql,values,_client,meta,result){if(!boundary&&locator(sql)){
        assert(!rowLock(sql),'DELETE harness refuses a locking first locator before controller mutation')
        assert(!preparedSubscriptionLock,'DELETE harness missed the unlocked prefix before a subscription lock')
        assert(meta,'prepared native locator must run on the actual owned transaction client')
        assert(selected(values,caller.id),'first native subscription locator must actually select this caller (scalar/UUID array)')
        assert.equal(result.rowCount,1,'first native locator cardinality differs from the exact single-subscription fixture');assert.equal(result.rows.length,1)
        const row=result.rows[0] as {id?:unknown;user_id?:unknown}
        assert.equal(row.id,id,'first native locator returned a different subscription');assert.equal(row.user_id,caller.id,'first native locator returned a different owner')
        boundary=selected(values,endpoint)?'actual-unlocked-endpoint-locator':'actual-unlocked-caller-set-locator'
        note({case:'subscription-delete-locator',boundary,id,caller:caller.id,actualRows:result.rowCount,appPid:meta.pid,unlocked:true})
        await pause.pause()
      }},
      async before(sql,values){
        if(locator(sql)&&rowLock(sql)){preparedSubscriptionLock=true;assert(boundary,'DELETE harness missed FIRST unlocked locator; refuses prepared subscription lock before controller mutation')}
        if(!boundary&&/^\s*delete\s+from\s+push_subscriptions\b/i.test(sql)&&selected(values,endpoint)){
          assert(!preparedSubscriptionLock,'baseline DELETE fallback is forbidden after a prepared subscription lock');assert(selected(values,caller.id),'baseline DELETE must select the exact caller')
          boundary='baseline-before-real-delete';await pause.pause()
        }
      },
    }
    try{
      const pending=request('DELETE','/users/me/push-subscriptions?endpoint='+encodeURIComponent(endpoint),caller)
      await bounded(Promise.race([pause.entered,pending.then(()=>{throw new Error('DELETE harness: request settled before the admitted unlocked locator/write gate')})]),'actual DELETE locator/write schedule',4_000)
      const changed=await holder.client.query('update push_subscriptions set user_id=$2,keys=$3::jsonb where id=$1 and user_id=$4 returning id',[id,foreign.id,JSON.stringify(changedKeys),caller.id]);assert.equal(changed.rowCount,1)
      pause.open();const waiter=await observedWait(pending,holder.pid,sql=>/\bpush_subscriptions\b/i.test(sql)&&/^\s*(delete|select|with)\b/i.test(sql))
      await holder.client.query('commit');response=await bounded(pending,'DELETE after committed owner change')
      note({case:'subscription-delete-source-change',boundary,holder:holder.pid,appPid:waiter.pid,id,initialOwner:caller.id,committedOwner:foreign.id,status:response.statusCode,error:response.body?response.json().error?.code??null:null})
    }finally{pause.open();await release(holder.client);probe={}}
    expect(response.statusCode).toBe(409);expect(response.json().error?.code).toBe('push_subscription_scope_changed')
    expect(await subscriptionFact(id,endpoint,changedKeys)).toEqual([{id,user_id:foreign.id,endpoint_matches:true,keys_match:true}]);expect(await subscriptionStable(users)).toEqual(before)
  })
  it('unchanged DELETE-all keeps 204 with outdated consent and absent VAPID, without deleting another user device',async()=>{
    const caller=await actor(),foreign=await actor(),ownIds:string[]=[],foreignId=allocate('subscription-foreign-control'),keys={p256dh:'synthetic-all-control',auth:'synthetic-all-control'},foreignEndpoint='https://push.example.invalid/'+foreignId
    for(let n=0;n<2;n++){const id=allocate('subscription-own-all-control');ownIds.push(id);await db().query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[id,caller.id,'https://push.example.invalid/'+id,JSON.stringify(keys)])}
    await db().query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[foreignId,foreign.id,foreignEndpoint,JSON.stringify(keys)])
    await db().query('update consents set policy_version=$2 where user_id=$1',[caller.id,'independent-old-policy'])
    const config=application().appConfig,previous={public:config.vapidPublicKey,private:config.vapidPrivateKey};config.vapidPublicKey=null;config.vapidPrivateKey=null
    try{const response=await request('DELETE','/users/me/push-subscriptions',caller);expect(response.statusCode,response.body).toBe(204)}
    finally{config.vapidPublicKey=previous.public;config.vapidPrivateKey=previous.private}
    expect((await db().query('select id from push_subscriptions where id=any($1::uuid[])',[ownIds])).rows).toEqual([])
    expect(await subscriptionFact(foreignId,foreignEndpoint,keys)).toEqual([{id:foreignId,user_id:foreign.id,endpoint_matches:true,keys_match:true}])
    note({case:'subscription-delete-all-controls',ownIds,foreignId,status:204,outdatedConsent:true,unconfigured:true,foreignPreserved:true})
  })

  it.each(OWNERS)('%s registered owner commits distinct authorized notices on one client after all domain work and sorted actual quota keys',async owner=>{
    const c=await prepare(owner);trace=[];seq=0;tracking=true;const response=await command(c);tracking=false
    note({case:'owner-batch',owner,status:response.statusCode,error:response.json().error?.code??null});expect(response.statusCode,response.body).toBe(c.status)
    await domainAccepted(c);await sameBatch(c,await notices(c.f))
  })
  it.each(['O01','O05','O11','O12'] as const)('%s real PG failure after second notice atomically rolls back complete action and receipt',async owner=>{
    const c=await prepare(owner),before=await snapshot(c.f);let fired=0,state:string|null=null
    probe={async after(sql,_values,client){if(/^\s*insert\s+into\s+notifications\b/i.test(sql)&&++fired===2){try{await client.query('select 1/0 as independent_c04_batch_error')}catch(e){state=(e as {code:string}).code;throw e}}}}
    const response=await command(c);probe={};const after=await snapshot(c.f),key=scopedReceipt(c)
    note({case:'second-notice-real-error',owner,status:response.statusCode,sqlState:state,before,after})
    expect(fired).toBe(2);expect(state).toBe('22012');expect(response.statusCode).toBe(500);expect(after).toEqual(before)
    if(key)expect((await db().query('select status,body from idempotency_keys where key=$1',[key])).rows).toEqual([])
  })
  for(const owner of ['O01','O05'] as const)for(const expires of [true,false])it(`${owner} last actual receipt wait ${expires?'crosses JWT exp and rolls back':'releases valid JWT and commits'}`,async()=>{
    const c=await prepare(owner),before=await snapshot(c.f),key=scopedReceipt(c)!;receiptKeys.add(key)
    const finalGate=gate(),holder=await controller();let reached=false,response:Response|undefined
    try{
      if(owner==='O01'){await timelineBarrier(key);await holder.client.query('select pg_advisory_xact_lock($1::int,$2::int)',[BARRIER,1])}
      else probe={async before(sql,values){if(!reached&&/^\s*update\s+idempotency_keys\b/i.test(sql)&&values?.includes(key)){reached=true;await finalGate.pause()}}}
      const a={...c.actor,token:expires?await signAccessToken(SECRET,{sub:c.actor.id,sid:c.actor.sid},Date.now()-(900-6)*1_000):c.actor.token}
      const pending=command(c,a)
      if(owner==='O05'){await bounded(finalGate.entered,'after-owner/before-real-receipt boundary',4_000);const locked=await holder.client.query('select key from idempotency_keys where key=$1 and status is null for update',[key]);assert.equal(locked.rowCount,1,'claim must actually be visible and row-locked');finalGate.open()}
      const waiter=await observedWait(pending,holder.pid,sql=>/^\s*update\s+idempotency_keys\b/i.test(sql))
      assert(Date.now()<exp(a)*1_000,'actual JWT was not valid at observed receipt wait');if(expires)await expireAtBarrier(a,waiter.pid)
      await holder.client.query('commit');response=await bounded(pending,'post-receipt wait')
    }finally{finalGate.open();await release(holder.client);probe={}}
    const after=await snapshot(c.f);note({case:'receipt-expiry',owner,expires,status:response.statusCode,error:response.json().error?.code??null,before,after})
    if(expires){expect(response.statusCode).toBe(401);expect(response.json().error?.code).toBe('token_expired');expect(after).toEqual(before);expect((await db().query('select key from idempotency_keys where key=$1',[key])).rows).toEqual([])}
    else{expect(response.statusCode,response.body).toBe(c.status);await domainAccepted(c);expect((await db().query('select status from idempotency_keys where key=$1',[key])).rows).toEqual([{status:c.status}])}
  },20_000)
  it.each(['unattempted','pushed','attempted'] as const)('final-domain quota classifies reschedule messages after %s old task cancellation, retaining distinct order',async spent=>{
    const c=await prepare('O05'),f=c.f,user=f.vendors[0]!.actor,today=new Date().toISOString().slice(0,10),tomorrow=new Date(Date.now()+86_400_000).toISOString().slice(0,10),seeds:string[]=[]
    const clock=(await db().query<{at:Date}>('select clock_timestamp() as at')).rows[0]!.at;assert(clock.toISOString().slice(0,10)===today);assert(clock.getUTCHours()<23,'UTC date rollover would invalidate this bounded countervector')
    for(let n=0;n<2;n++){const id=allocate('quota-seed');seeds.push(id);await db().query("insert into notifications(id,user_id,kind,title,body,deliver_after,push_disposition,delivery_time_zone) values($1,$2,'system','Independent quota seed','Synthetic',$3,'planned','UTC')",[id,user.id,clock])}
    const old=allocate('old-task-notice');seeds.push(old)
    await db().query("insert into notifications(id,user_id,kind,title,body,deliver_after,push_disposition,delivery_time_zone,task_id,task_version,task_event,expires_at,pushed_at) values($1,$2,'task','Old task occurrence','Synthetic',$3,'planned','UTC',$4,0,'assignment',$5,$6)",[old,user.id,clock,f.task,new Date(clock.getTime()+5*86_400_000),spent==='pushed'?clock:null])
    if(spent==='attempted'){const sid=allocate('subscription');await db().query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[sid,user.id,'https://push.example.invalid/'+sid,JSON.stringify({p256dh:'synthetic',auth:'synthetic'})]);await db().query("insert into notification_push_deliveries(notification_id,subscription_id,status,attempts,next_attempt_at) values($1,$2,'retry_wait',1,$3)",[old,sid,new Date(clock.getTime()+86_400_000)])}
    const beforeInbox=await request('GET','/notifications',user);expect(beforeInbox.statusCode).toBe(200);expect((beforeInbox.json() as {id:string}[]).some(n=>n.id===old)).toBe(true)
    expect(await notificationPushReady(db(),old)).toBe(spent!=='pushed')
    const before=await notices(f),response=await command(c);expect(response.statusCode,response.body).toBe(200);const after=await notices(f)
    expect(before.find(n=>n.id===old)!.cancelled_at).toBeNull()
    const cancelled=after.find(n=>n.id===old)!;expect(cancelled.cancelled_at).not.toBeNull();expect(await notificationPushReady(db(),old)).toBe(false)
    const placed=after.filter(n=>n.user_id===user.id&&!seeds.includes(n.id));expect(placed).toHaveLength(2)
    const vendor=placed.find(n=>n.kind==='deal'&&n.title==='Дата свадьбы изменилась')!,system=placed.find(n=>n.kind==='system'&&n.title==='Дата свадьбы изменена')!;assert(vendor&&system)
    // Independent capacity model: two ordinary rows; spent old row persists, unattempted cancelled row frees one.
    const capacities=[2+(spent==='unattempted'?0:1),0],expected:string[]=[]
    for(let message=0;message<2;message++){const day=capacities[0]!<3?0:1;capacities[day]!++;expected.push(day===0?today:tomorrow)}
    const observed=[vendor.deliver_after.toISOString().slice(0,10),system.deliver_after.toISOString().slice(0,10)]
    note({case:'final-domain-capacity',spent,before,after,expectedFinalDomainDays:expected,observedDays:observed,
      historicalEarlyFanoutDays:spent==='unattempted'?[tomorrow,today]:[tomorrow,tomorrow],syntheticAttemptEvidenceOnly:true})
    expect(observed).toEqual(expected);expect(vendor.id).not.toBe(system.id)
    const inbox=await request('GET','/notifications',user);expect(inbox.statusCode).toBe(200);expect((inbox.json() as {id:string}[]).some(n=>n.id===old)).toBe(false)
  })
  it('critical reschedule preserves UTC quiet endpoint for both distinct vendor/system messages and immediate inbox',async()=>{
    const c=await prepare('O05'),a=c.f.vendors[0]!.actor,now=new Date(),h=now.getUTCHours(),from=String((h+23)%24).padStart(2,'0')+':00',to=String((h+2)%24).padStart(2,'0')+':00'
    const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),h+2))
    await db().query('update notification_prefs set quiet_from=$2::time,quiet_to=$3::time where user_id=$1',[a.id,from,to]);expect((await command(c)).statusCode).toBe(200)
    const rows=(await notices(c.f)).filter(n=>n.user_id===a.id);expect(rows).toHaveLength(2);for(const n of rows){expect(n.deliver_after.toISOString()).toBe(end.toISOString());expect(n.push_disposition).toBe('planned');expect(n.pushed_at).toBeNull()}
    const inbox=await request('GET','/notifications',a);expect(inbox.statusCode).toBe(200);for(const n of rows)expect((inbox.json() as {id:string}[]).some(r=>r.id===n.id)).toBe(true)
  })
  it('disabled deal push retains both couple inbox notices and preserves financial text privacy',async()=>{
    const c=await prepare('O12');for(const a of [c.f.owner,c.f.partner])await db().query('update notification_prefs set deals=false where user_id=$1',[a.id])
    expect((await command(c)).statusCode).toBe(201);const rows=await notices(c.f);expect(rows).toHaveLength(2)
    for(const n of rows){expect(n.push_disposition).toBe('inbox_only');expect(n.pushed_at).not.toBeNull();expect(n.body).toBe('Подрядчик прислал предложение.');expect(n.body).not.toContain('Private synthetic')}
    for(const a of [c.f.owner,c.f.partner]){const inbox=await request('GET','/notifications',a);expect(inbox.statusCode).toBe(200);expect((inbox.json() as {id:string}[]).some(n=>n.id===rows.find(r=>r.user_id===a.id)!.id)).toBe(true)}
  })
})
