import assert from 'node:assert/strict'
import { randomInt, randomUUID, createHash } from 'node:crypto'
import { readAdmission, assertTestURLs, assertIdentity, assertNativeAdmission } from '../test-support/c04-c05-native-admission.mjs'
import pg from 'pg'
import webpush from 'web-push'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type Config } from '../src/config.js'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import { sendDuePushes, type PushResult } from '../src/notify/push.js'

// Corrected-worker regressions authored after source review. Real SQL/results; provider transport only fails closed.
const admission=readAdmission('tests')
const TARGET=admission.targetName, DATABASE=admission.targetURL
const APP='c05wf_'+randomUUID(), UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const settledStatuses=['expired','provider_accepted','permanent_failure'] as const
const lateStatuses=['provider_accepted','permanent_failure'] as const
const excludedModes=['queued','retry_wait','claimed','no-delivery','already-pushed','inbox_only','processed'] as const
type Status=typeof settledStatuses[number]|'queued'|'retry_wait'|'claimed'
type Meta={pid:number;xid:string}
type Gate={entered:Promise<void>;pause():Promise<void>;open():void}
type Probe={before?(sql:string,values:readonly unknown[]|undefined,client:Queryable,meta:Meta|null):Promise<void>;
  after?(sql:string,values:readonly unknown[]|undefined,client:Queryable,meta:Meta|null,result:pg.QueryResult):Promise<void>}
type Fixture={user:string;id:string;subscriptions:string[]}
// Gate classification only; expected effects below use independent fixture facts, never a copied eligibility query.
const finalLocator=(sql:string)=>/^\s*select\s+(?:[a-z_]\w*\.)?id\s+from\s+notifications\b/i.test(sql)&&/\bnotification_push_deliveries\b/i.test(sql)&&/\bstatus\s+in\b/i.test(sql)
const finalMutation=(sql:string)=>/^\s*update\s+notifications\s+n\s+set\s+pushed_at\s*=\s*now\(\)\s*,\s*push_disposition\s*=\s*'processed'/i.test(sql)&&/\breturning\s+exists\b/i.test(sql)&&/\bas\s+expired\b/i.test(sql)
const rowLock=(sql:string)=>/\bfor\s+(?:no\s+key\s+)?update\b|\bfor\s+(?:key\s+)?share\b/i.test(sql)
const fingerprint=(sql:string)=>createHash('sha256').update(sql).digest('hex')
const note=(value:object)=>process.stdout.write('C05_WORKER_WITNESS '+JSON.stringify(value)+'\n')

describe('isolated native corrected worker final batch (provider calls forbidden)',()=>{
  let raw:Db|undefined,observer:pg.Client|undefined,config:Config,probe:Probe={},unexpectedTransport=0
  const allocated=new Map<string,string>(),users=new Set<string>(),notices=new Set<string>(),subscriptions=new Set<string>()
  const gates=new Set<Gate>(),controllers=new Set<pg.Client>(),pending=new Set<Promise<PushResult>>()
  const mutations:{rows:number|null;meta:Meta|null;statement:string}[]=[]
  const db=()=>{assert(raw);return raw},see=()=>{assert(observer);return observer}
  function allocate(kind:string){const id=randomUUID();assert.match(id,UUID);allocated.set(id,kind);note({event:'uuid-before-write',id,kind});return id}
  async function bounded<T>(promise:Promise<T>,label:string,ms=8_000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('HARNESS_DEADLINE '+label)),ms)})])}finally{if(timer)clearTimeout(timer)}}
  function gate():Gate{let enter!:()=>void,open!:()=>void;const entered=new Promise<void>(r=>{enter=r}),wait=new Promise<void>(r=>{open=r})
    const g={entered,async pause(){enter();await wait},open};gates.add(g);return g}
  async function identity(client:Queryable){const row=(await client.query<{name:string;username:string;port:number;address:string;oid:string;pid:number}>(`select current_database() as name,current_user as username,inet_server_port() as port,
      host(inet_server_addr()) as address,pg_backend_pid() as pid,(select oid::text from pg_database where datname=current_database()) as oid`)).rows[0]!
    assertIdentity(row,admission.profile,admission.creation);return row}
  function forward():Db{const wrap=(client:Queryable,meta:Meta|null):Queryable=>({async query<T extends pg.QueryResultRow=pg.QueryResultRow>(sql:string,values?:readonly unknown[]){
    await probe.before?.(sql,values,client,meta);const result=await client.query<T>(sql,values)
    if(finalMutation(sql)){mutations.push({rows:result.rowCount,meta,statement:fingerprint(sql)});note({event:'actual-final-mutation',rows:result.rowCount,meta,statement:fingerprint(sql)})}
    await probe.after?.(sql,values,client,meta,result);return result
  }})
    return {query:wrap(db(),null).query,tx:action=>db().tx(async client=>{const actual=await identity(client),xid=(await client.query<{xid:string}>('select txid_current()::text as xid')).rows[0]!.xid;return action(wrap(client,{pid:actual.pid,xid}))}),ping:()=>db().ping(),close:()=>db().close()}}
  function start(limit=0){const worker=sendDuePushes(forward(),config,limit);pending.add(worker);void worker.then(()=>pending.delete(worker),()=>pending.delete(worker));return worker}
  async function admittedGate(g:Gate,worker:Promise<PushResult>,label:string){await bounded(Promise.race([g.entered,worker.then(()=>{throw new Error('HARNESS_PREFIX request settled before '+label)})]),label,4_000)}
  async function controller(){const url=new URL(DATABASE);url.searchParams.set('application_name','c05wc_'+randomUUID());const client=new pg.Client({connectionString:url.href,statement_timeout:8_000,idle_in_transaction_session_timeout:15_000});controllers.add(client);await client.connect();const actual=await identity(client);await client.query('begin');return {client,pid:actual.pid}}
  async function release(client:pg.Client){if(!controllers.has(client))return;try{await client.query('rollback')}finally{await client.end();controllers.delete(client)}}
  async function waitFor(worker:Promise<PushResult>,holder:number,expected:(sql:string)=>boolean,knownPid?:number){let settled=false;void worker.then(()=>{settled=true},()=>{settled=true});const until=Date.now()+6_000
    while(Date.now()<until){assert(!settled,'HARNESS_WITNESS worker settled before native wait');const rows=(await see().query<{pid:number;query:string;blockers:number[]}>(`select pid,query,pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname=$1 and application_name=$2 and state='active' and wait_event_type='Lock'`,[TARGET,APP])).rows
      if(rows.length){assert.equal(rows.length,1,'HARNESS_WITNESS unexpected extra worker Lock waiter');const row=rows[0]!;assert(expected(row.query),'HARNESS_WITNESS wrong native relation/query');if(knownPid!==undefined)assert.equal(row.pid,knownPid);assert.deepEqual(row.blockers,[holder]);assert(!settled)
        note({event:'actual-direct-blocker',pid:row.pid,holder,blockers:row.blockers,statement:fingerprint(row.query)});return row.pid}
      await new Promise(r=>setTimeout(r,20))
    }throw new Error('HARNESS_WITNESS genuine native blocker not observed')}
  async function completedPoolLocator(sql:string,result:pg.QueryResult,expected:readonly string[]){assert(!rowLock(sql),'HARNESS_PREFIX final locator must be nonlocking');assert.equal(result.rowCount,expected.length);assert.equal(result.rows.length,expected.length)
    const actual=result.rows.map(r=>{assert.deepEqual(Object.keys(r),['id']);assert(typeof r.id==='string');return r.id as string}).sort();assert.deepEqual(actual,[...expected].sort())
    const native=(await see().query<{pid:number;state:string;query:string}>(`select pid,state,query from pg_stat_activity where datname=$1 and application_name=$2 and query=$3`,[TARGET,APP,sql])).rows
    assert.equal(native.length,1,'HARNESS_PREFIX completed locator native PID ambiguous');assert.equal(native[0]!.state,'idle');note({event:'completed-first-native-locator',pid:native[0]!.pid,ids:actual,rows:result.rowCount,statement:fingerprint(sql)})}
  function pauseFirstLocator(expected:readonly string[]){const g=gate();let seen=false;probe={async after(sql,_values,_client,meta,result){if(!seen&&finalLocator(sql)){seen=true;assert.equal(meta,null,'HARNESS_PREFIX first locator must complete outside owned final TX');await completedPoolLocator(sql,result,expected);await g.pause()}}};return g}

  beforeAll(async()=>{
    assertTestURLs(process.env,admission.profile)
    const obsURL=new URL(DATABASE);obsURL.searchParams.set('application_name','c05wo_'+randomUUID());observer=new pg.Client({connectionString:obsURL.href});await observer.connect();note({event:'actual-preflight',identity:await identity(observer)})
    await assertNativeAdmission(observer,admission)
    const appURL=new URL(DATABASE);appURL.searchParams.set('application_name',APP);raw=createDb(appURL.href);await identity(raw)
    const schema=admission.schema;assert.equal(schema.migrationCount,84)
    const names=(await raw.query<{name:string}>('select name from pgmigrations order by name')).rows.map(r=>r.name);assert.deepEqual(names,[...schema.journalNames].sort())
    const others=(await observer.query('select pid from pg_stat_activity where datname=$1 and pid<>pg_backend_pid() and application_name<>$2',[TARGET,APP])).rows;assert.deepEqual(others,[],'HARNESS_ADMISSION exclusive isolated worker lane required')
    const empty=(await raw.query<{users:string;keys:string;notices:string;subscriptions:string;deliveries:string}>(`select (select count(*)::text from users) as users,(select count(*)::text from idempotency_keys) as keys,
      (select count(*)::text from notifications) as notices,(select count(*)::text from push_subscriptions) as subscriptions,(select count(*)::text from notification_push_deliveries) as deliveries`)).rows[0]!
    assert.deepEqual(empty,{users:'0',keys:'0',notices:'0',subscriptions:'0',deliveries:'0'});note({event:'actual-isolated-start',empty,migrations:names.length})
    const keys=webpush.generateVAPIDKeys();config={...loadConfig({NODE_ENV:'test'}),vapidPublicKey:keys.publicKey,vapidPrivateKey:keys.privateKey,vapidSubject:'mailto:worker-fixture@example.invalid'}
  },20_000)
  beforeEach(()=>{unexpectedTransport=0;mutations.length=0;probe={};vi.spyOn(webpush,'sendNotification').mockImplementation(async()=>{unexpectedTransport++;throw new Error('HARNESS_TRANSPORT unexpected provider call forbidden')})})
  async function settle(){const errors:unknown[]=[];for(const g of gates)g.open();gates.clear();for(const client of [...controllers])try{await release(client)}catch(e){errors.push(e)}
    try{await bounded(Promise.allSettled([...pending]),'settle owned workers',9_000)}catch(e){errors.push(e);for(const row of (await see().query<{pid:number}>(`select pid from pg_stat_activity where datname=$1 and application_name=$2 and state='active'`,[TARGET,APP])).rows){note({event:'cancel-exact-own-worker',pid:row.pid});await see().query('select pg_cancel_backend($1)',[row.pid])}await bounded(Promise.allSettled([...pending]),'settle cancelled worker',5_000)}finally{probe={}}
    if(errors.length)throw new AggregateError(errors,'HARNESS_CLEANUP worker/controller settlement failed')}
  async function cleanup(){await identity(db());const ownedUsers=[...users],all=[...allocated.keys()],auditSQL='select id::text,actor_id,action,entity,entity_id,at from audit_log where actor_id=any($1::uuid[]) or entity_id=any($2::uuid[]) order by id'
    const retained=(await db().query(auditSQL,[ownedUsers,all])).rows;note({event:'audit-retention-before-user-delete',rows:retained,count:retained.length})
    for(const id of ownedUsers)await db().query('delete from users where id=$1',[id])
    const counts=(await db().query<{users:string;prefs:string;notices:string;subscriptions:string;deliveries:string;sessions:string;consents:string}>(`select (select count(*)::text from users where id=any($1::uuid[])) as users,
      (select count(*)::text from notification_prefs where user_id=any($1::uuid[])) as prefs,(select count(*)::text from notifications where id=any($2::uuid[]) or user_id=any($1::uuid[])) as notices,
      (select count(*)::text from push_subscriptions where id=any($3::uuid[]) or user_id=any($1::uuid[])) as subscriptions,(select count(*)::text from notification_push_deliveries where notification_id=any($2::uuid[]) or subscription_id=any($3::uuid[])) as deliveries,
      (select count(*)::text from sessions where user_id=any($1::uuid[])) as sessions,(select count(*)::text from consents where user_id=any($1::uuid[])) as consents`,[ownedUsers,[...notices],[...subscriptions]])).rows[0]!
    const after=(await db().query(auditSQL,[ownedUsers,all])).rows;note({event:'owned-cleanup',counts,retainedAudits:after,uuidManifest:[...allocated]});expect(counts).toEqual({users:'0',prefs:'0',notices:'0',subscriptions:'0',deliveries:'0',sessions:'0',consents:'0'});expect(after).toEqual(retained)
    users.clear();notices.clear();subscriptions.clear();allocated.clear()
  }
  afterEach(async()=>{const errors:unknown[]=[];try{if(raw)await settle()}catch(e){errors.push(e)}try{if(raw)await cleanup()}catch(e){errors.push(e)}vi.restoreAllMocks();if(unexpectedTransport!==0)errors.push(new Error('HARNESS_TRANSPORT forbidden calls='+unexpectedTransport));if(errors.length)throw new AggregateError(errors,'HARNESS_CLEANUP or transport failure; preserve original semantic failure')},30_000)
  afterAll(async()=>{const errors:unknown[]=[];try{if(raw){await settle();await cleanup()}}catch(e){errors.push(e)}finally{try{await raw?.close()}catch(e){errors.push(e)}try{await observer?.end()}catch(e){errors.push(e)}}if(errors.length)throw new AggregateError(errors,'HARNESS_CLEANUP final connections/owned rows')},30_000)

  async function actor(){const user=allocate('user');users.add(user);let success=false;for(let n=0;n<8&&!success;n++){const r=await db().query("insert into users(id,phone,tz,name) values($1,$2,'UTC','Synthetic worker fixture') on conflict(phone) do nothing returning id",[user,'+79'+randomInt(100_000_000,999_999_999)]);success=r.rows[0]?.id===user}assert(success,'HARNESS_FIXTURE bounded atomic phone allocation exhausted');await db().query("insert into notification_prefs(user_id,quiet_from,quiet_to) values($1,'00:00','00:00')",[user]);return user}
  async function fixture(statuses:readonly Status[],future=false):Promise<Fixture>{const user=await actor(),id=allocate('notice');notices.add(id)
    await db().query(`insert into notifications(id,user_id,kind,title,body,link,deliver_after) values($1,$2,'system','Synthetic worker notice','Synthetic bounded regression','/wedding/dayx',now()+($3::int*interval '1 minute'))`,[id,user,future?60:-1])
    const ids:string[]=[];for(const status of statuses){const sub=allocate('subscription');subscriptions.add(sub);ids.push(sub);await db().query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4::jsonb)',[sub,user,'https://push.example.invalid/'+sub,JSON.stringify({p256dh:'synthetic',auth:'synthetic'})])
      const lease=status==='claimed'?allocate('synthetic-live-lease'):null
      await db().query(`insert into notification_push_deliveries(notification_id,subscription_id,status,attempts,next_attempt_at,lease_token,lease_until,provider_accepted_at)
        values($1,$2,$3,$4,now()+interval '1 hour',$5,case when $5::uuid is not null then now()+interval '1 hour' else null end,case when $3='provider_accepted' then now() else null end)`,[id,sub,status,status==='queued'?0:1,lease])
    }return {user,id,subscriptions:ids}}
  async function snapshot(){const ids=[...notices],u=[...users],s=[...subscriptions];return {
    notices:(await db().query('select id,user_id,kind,title,body,link,deliver_after,pushed_at,push_disposition,cancelled_at,read_at,created_at,task_id from notifications where id=any($1::uuid[]) order by id',[ids])).rows,
    deliveries:(await db().query('select * from notification_push_deliveries where notification_id=any($1::uuid[]) order by notification_id,subscription_id',[ids])).rows,
    subscriptions:(await db().query('select id,user_id,created_at from push_subscriptions where id=any($1::uuid[]) order by id',[s])).rows,
    users:(await db().query('select id,tz,deleted_at from users where id=any($1::uuid[]) order by id',[u])).rows,
    prefs:(await db().query('select * from notification_prefs where user_id=any($1::uuid[]) order by user_id',[u])).rows,
  }}
  async function notice(id:string){return (await db().query<{id:string;user_id:string;pushed_at:Date|null;push_disposition:string;cancelled_at:Date|null;read_at:Date|null}>('select id,user_id,pushed_at,push_disposition,cancelled_at,read_at from notifications where id=$1',[id])).rows[0]!}
  const noticeMaterial=(rows:pg.QueryResultRow[])=>rows.map(row=>{const rest={...row};delete rest.pushed_at;delete rest.push_disposition;return rest})
  const zero={sent:0,dropped:0,expired:0}
  function finalRows(expected:number){assert(mutations.length<=1,'HARNESS_PREFIX multiple final mutations need another reviewed schedule');if(expected>0)assert.equal(mutations.length,1,'HARNESS_PREFIX successful final native mutation required')
    if(mutations.length){expect(mutations[0]!.rows).toBe(expected);assert(mutations[0]!.meta,'HARNESS_PREFIX final batch must execute on a genuine owned transaction')}}

  it.each(lateStatuses)('prepared N1 excludes newly settled N2 (%s), and a later native pass processes N2',async status=>{
    const first=await fixture(['expired']),later=await fixture(['retry_wait']),before=await snapshot(),g=pauseFirstLocator([first.id]),holder=await controller()
    try{const worker=start();await admittedGate(g,worker,'initial N1-only native locator');const r=await holder.client.query(`update notification_push_deliveries set status=$3,provider_accepted_at=case when $3='provider_accepted' then now() else null end where notification_id=$1 and subscription_id=$2 returning notification_id`,[later.id,later.subscriptions[0],status]);assert.equal(r.rowCount,1);await holder.client.query('commit');const changed=await snapshot();g.open()
      expect(await bounded(worker,'first prepared final pass')).toEqual({sent:0,dropped:0,expired:1});finalRows(1);expect(await notice(first.id)).toMatchObject({push_disposition:'processed',cancelled_at:null,read_at:null});expect((await notice(first.id)).pushed_at).not.toBeNull();expect(await notice(later.id)).toMatchObject({push_disposition:'planned',pushed_at:null})
      const after=await snapshot();expect(noticeMaterial(after.notices)).toEqual(noticeMaterial(before.notices));expect(after.deliveries).toEqual(changed.deliveries);expect(after.subscriptions).toEqual(before.subscriptions);expect(after.users).toEqual(before.users);expect(after.prefs).toEqual(before.prefs)
      probe={};mutations.length=0;expect(await bounded(start(),'later N2 native pass')).toEqual(zero);finalRows(1);expect(await notice(later.id)).toMatchObject({push_disposition:'processed'});expect((await notice(later.id)).pushed_at).not.toBeNull();expect((await snapshot()).deliveries).toEqual(changed.deliveries)
    }finally{g.open();await release(holder.client)}
  })
  it('an initial empty prepared set cannot absorb N2 settled after the real first locator',async()=>{
    const f=await fixture(['retry_wait']),g=pauseFirstLocator([]),holder=await controller()
    try{const worker=start();await admittedGate(g,worker,'initial empty native locator');const r=await holder.client.query("update notification_push_deliveries set status='permanent_failure' where notification_id=$1 returning notification_id",[f.id]);assert.equal(r.rowCount,1);await holder.client.query('commit');const afterController=await snapshot();g.open();expect(await bounded(worker,'empty prepared set')).toEqual(zero);finalRows(0);expect(await snapshot()).toEqual(afterController)
      probe={};mutations.length=0;expect(await bounded(start(),'later newly settled N2')).toEqual(zero);finalRows(1);expect((await notice(f.id)).pushed_at).not.toBeNull()
    }finally{g.open();await release(holder.client)}
  })
  it('prepared N1 loses eligibility during a genuine notice-row wait and final mutation rechecks it',async()=>{
    const f=await fixture(['expired']),before=await snapshot(),g=pauseFirstLocator([f.id]),holder=await controller()
    try{const worker=start();await admittedGate(g,worker,'N1 eligibility locator');assert.equal((await holder.client.query("update notifications set push_disposition='inbox_only' where id=$1 returning id",[f.id])).rowCount,1);g.open()
      await waitFor(worker,holder.pid,sql=>/^\s*select\b/is.test(sql)&&/\bnotifications\b/i.test(sql)&&/\bfor\s+update\b/i.test(sql));await holder.client.query('commit');expect(await bounded(worker,'postwait revoked eligibility')).toEqual(zero);finalRows(0)
      expect(await notice(f.id)).toMatchObject({id:f.id,user_id:f.user,pushed_at:null,push_disposition:'inbox_only',cancelled_at:null,read_at:null});const after=await snapshot();expect(noticeMaterial(after.notices)).toEqual(noticeMaterial(before.notices));expect(after.deliveries).toEqual(before.deliveries);expect(after.subscriptions).toEqual(before.subscriptions);expect(after.users).toEqual(before.users);expect(after.prefs).toEqual(before.prefs)
    }finally{g.open();await release(holder.client)}
  })
  it('mixed settled deliveries count expiry once per notice and preserve every delivery fact/inbox row',async()=>{
    const fixtures=[await fixture(['expired','provider_accepted']),await fixture(['expired','permanent_failure']),await fixture(['provider_accepted']),await fixture(['permanent_failure'])],before=await snapshot()
    expect(await bounded(start(),'mixed settled final batch')).toEqual({sent:0,dropped:0,expired:2});finalRows(4)
    for(const f of fixtures){expect(await notice(f.id)).toMatchObject({push_disposition:'processed',cancelled_at:null,read_at:null});expect((await notice(f.id)).pushed_at).not.toBeNull()}
    const after=await snapshot();expect(after.notices).toHaveLength(4);expect(noticeMaterial(after.notices)).toEqual(noticeMaterial(before.notices));expect(after.deliveries).toEqual(before.deliveries);expect(after.subscriptions).toEqual(before.subscriptions);expect(after.users).toEqual(before.users);expect(after.prefs).toEqual(before.prefs)
  })
  it.each(settledStatuses)('ordinary configured settled %s control returns the original result and remains settled on replay',async status=>{
    const f=await fixture([status]),before=await snapshot();expect(await bounded(start(),'ordinary settled control')).toEqual({...zero,expired:status==='expired'?1:0});finalRows(1);expect((await notice(f.id)).pushed_at).not.toBeNull();const once=await snapshot();expect(noticeMaterial(once.notices)).toEqual(noticeMaterial(before.notices));expect(once.deliveries).toEqual(before.deliveries)
    mutations.length=0;expect(await bounded(start(),'settled subsequent pass')).toEqual(zero);finalRows(0);expect(await snapshot()).toEqual(once)
  })
  it.each(excludedModes)('configured %s exclusion retains exact inbox/delivery/subscription state without an outbound call',async mode=>{
    const f=await fixture(mode==='no-delivery'?[]:mode==='queued'||mode==='retry_wait'||mode==='claimed'?[mode]:['expired'])
    if(mode==='already-pushed')await db().query("update notifications set pushed_at=now(),push_disposition='processed' where id=$1",[f.id])
    if(mode==='inbox_only'||mode==='processed')await db().query('update notifications set push_disposition=$2 where id=$1',[f.id,mode])
    const before=await snapshot();expect(await bounded(start(),'excluded state control')).toEqual(zero);finalRows(0);expect(await snapshot()).toEqual(before)
  })
  it('configured empty native pass returns zero with no rows, no seeding and no provider calls',async()=>{
    const before=await snapshot();expect(await bounded(start(),'configured empty worker')).toEqual(zero);finalRows(0);expect(await snapshot()).toEqual(before)
  })
  it('configured positive-limit no-due pass neither seeds nor sends a future inbox notice',async()=>{
    const f=await fixture([],true),before=await snapshot();expect(await bounded(start(1),'configured no-due worker')).toEqual(zero);finalRows(0);expect(await snapshot()).toEqual(before);expect(await notice(f.id)).toMatchObject({pushed_at:null,push_disposition:'planned',cancelled_at:null})
  })
  it('changed original notice parent after a genuine account wait refuses scope and preserves controller facts',async()=>{
    const f=await fixture(['expired']),other=await actor(),before=await snapshot(),g=gate(),holder=await controller();let first=false,prepared=false,pid:number|undefined
    probe={async after(sql,_values,_client,meta,result){if(!first&&finalLocator(sql)){first=true;assert.equal(meta,null);await completedPoolLocator(sql,result,[f.id])}
      if(first&&!prepared&&meta&&/^\s*select\b/i.test(sql)&&/\bfrom\s+notifications\b/i.test(sql)&&result.rows.some(r=>r.id===f.id&&r.user_id===f.user)){assert(!rowLock(sql),'HARNESS_PREFIX parent locator must complete unlocked');assert.equal(result.rowCount,1);assert.equal(result.rows.length,1);prepared=true;pid=meta.pid;note({event:'completed-native-original-parent',id:f.id,user:f.user,meta});await g.pause()}}}
    try{const worker=start();await admittedGate(g,worker,'completed original parent locator');assert.equal((await holder.client.query('select id from users where id=$1 for update',[f.user])).rowCount,1);assert.equal((await holder.client.query('update notifications set user_id=$2 where id=$1 returning id',[f.id,other])).rowCount,1);g.open()
      await waitFor(worker,holder.pid,sql=>/^\s*select\b/is.test(sql)&&/\busers\b/i.test(sql)&&/\bfor\s+share\b/i.test(sql),pid);await holder.client.query('commit');await expect(bounded(worker,'postwait changed scope refusal')).rejects.toMatchObject({statusCode:409,code:'resource_source_changed'});expect(mutations).toHaveLength(0)
      expect(await notice(f.id)).toMatchObject({user_id:other,pushed_at:null,push_disposition:'planned'});const after=await snapshot();expect(noticeMaterial(after.notices)).toEqual(noticeMaterial(before.notices.map(n=>({...n,user_id:other}))));expect(after.deliveries).toEqual(before.deliveries);expect(after.subscriptions).toEqual(before.subscriptions);expect(after.users).toEqual(before.users);expect(after.prefs).toEqual(before.prefs)
    }finally{g.open();await release(holder.client)}
  })
  it('a real same-client PostgreSQL failure after final UPDATE rolls back all final-batch notice mutations',async()=>{
    await fixture(['expired']);await fixture(['provider_accepted']);const before=await snapshot();let injected=false
    probe={async after(sql,_values,client,meta,result){if(!injected&&finalMutation(sql)){assert(meta,'HARNESS_PREFIX atomic failure needs the real owned final TX');assert.equal(result.rowCount,2);injected=true;try{await client.query('select 1/0')}catch(error){note({event:'real-post-update-failure',meta,sqlstate:(error as {code?:string}).code});throw error}}}}
    await expect(bounded(start(),'real final-batch rollback')).rejects.toMatchObject({code:'22012'});assert(injected,'HARNESS_PREFIX final native UPDATE/failure boundary not reached');finalRows(2);expect(await snapshot()).toEqual(before)
  })
})
