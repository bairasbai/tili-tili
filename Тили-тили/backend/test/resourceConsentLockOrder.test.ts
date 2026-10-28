import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createRefreshToken, hashRefreshToken, signAccessToken } from '../src/auth/tokens.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'
import { runNativeCalendarHttpPrefixRace, type NativeCalendarWaitRow } from './helpers/nativeCalendarPrefixRace.js'

const DB=process.env.TEST_DATABASE_URL, POLICY='2026-09-02', SECRET='synthetic-consent-resource-lock'.repeat(3)
type Wait={pid:number;query:string;wait_event:string;blockers:number[]}
describe.skipIf(!DB)('actual resource management and consent withdrawal lock order',()=>{
  let app:FastifyInstance
  const users:string[]=[],vendors:string[]=[],weddings:string[]=[]
  const traces:unknown[]=[],observedErrors:{route:string;code:string|undefined}[]=[]
  const prefix=String(randomInt(100_000,999_999));let sequence=0
  beforeAll(async()=>{
    const target=new URL(DB!)
    assert(['postgres:','postgresql:'].includes(target.protocol));assert(['127.0.0.1','localhost'].includes(target.hostname))
    assert.equal(target.port,disposablePgPort());assert.equal(target.username,'codex_test')
    assert(['/tili_ecosystem_resource_consent_20260930_test','/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search,'');assert.equal(target.hash,'')
    const hashes:Record<string,string>={}
    for(const path of ['routes/users.ts','orders/context.ts','resources/model.ts','auth/consent.ts'])
      hashes[path]=createHash('sha256').update(await readFile(new URL('../src/'+path,import.meta.url))).digest('hex')
    process.stdout.write(`RESOURCE_CONSENT_SOURCE_HASHES ${JSON.stringify(hashes)}\n`)
    app=await buildApp({env:'test',databaseUrl:DB!,redisUrl:null,corsOrigins:[],jwtAccessSecret:SECRET,
      jwtRefreshSecret:'synthetic-consent-refresh'.repeat(3),policyVersion:POLICY})
    // Read-only observation of genuine handler errors. No query interception,
    // replacement handler, invented SQLSTATE or artificial failing SQL here.
    app.addHook('onError',(request,_reply,error,done)=>{
      observedErrors.push({route:request.routeOptions.url??request.url,code:error.code});done()
    })
    await app.ready()
    expect((await app.db!.query<{name:string}>('select current_database() name')).rows[0]!.name).toBe(target.pathname.slice(1))
  })
  afterAll(async()=>{
    if(!app)return
    try{
      process.stdout.write(`RESOURCE_CONSENT_ACTUAL_TRACES ${JSON.stringify(traces)}\n`)
      process.stdout.write(`RESOURCE_CONSENT_OBSERVED_ERRORS ${JSON.stringify(observedErrors)}\n`)
      await app.db!.query('delete from vendor_resources where vendor_id=any($1::uuid[])',[vendors])
      for(const id of weddings)await app.db!.query('delete from weddings where id=$1',[id])
      for(const id of vendors)await app.db!.query('delete from vendors where id=$1',[id])
      for(const id of users)await app.db!.query('delete from users where id=$1',[id])
    }finally{await app.close()}
  })
  async function actor(){
    const userId=randomUUID(),sessionId=randomUUID(),refreshToken=createRefreshToken();users.push(userId)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic consent lock actor')",[userId,`+79${prefix}${String(++sequence).padStart(3,'0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',[sessionId,userId,hashRefreshToken(refreshToken)])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)',[randomUUID(),userId,POLICY])
    return{userId,sessionId,policyVersion:POLICY,refreshToken,token:await signAccessToken(SECRET,{sub:userId,sid:sessionId})}
  }
  type Actor=Awaited<ReturnType<typeof actor>>
  const auth=(a:Actor)=>({authorization:`Bearer ${a.token}`})
  async function fixture(){
    // Synthetic identity/consent fixtures, real staff acceptance and real HTTP
    // business commands. This does not assert human/legal invitation acceptance.
    const owner=await actor(),manager=await actor(),couple=await actor(),vendorId=randomUUID(),weddingId=randomUUID(),slotId=randomUUID()
    vendors.push(vendorId);weddings.push(weddingId)
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic lock company',now())",[vendorId,owner.userId])
    const invitation=await app.db!.tx(c=>inviteStaff(c,{vendorId,actor:owner,role:'resource_manager',targetUserId:manager.userId}))
    expect(await app.db!.tx(c=>acceptStaffInvite(c,{token:invitation.token,actor:manager}))).toMatchObject({state:'active',role:'resource_manager'})
    expect((await app.db!.query('select wedding_id from wedding_members where user_id=$1',[manager.userId])).rows).toEqual([])
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic lock wedding','2027-06-14','Europe/Moscow',$3)",[weddingId,couple.userId,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[weddingId,couple.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Legacy flowers')",[slotId,weddingId])
    const booked=await app.inject({method:'POST',url:`/weddings/${weddingId}/slots/${slotId}/book`,headers:{...auth(couple),'idempotency-key':randomUUID()},payload:{vendorId,price:{amount:18000,currency:'RUB'}}})
    expect(booked.statusCode,booked.body).toBe(200)
    const paid=await app.inject({method:'POST',url:`/weddings/${weddingId}/slots/${slotId}/pay`,headers:{...auth(couple),'idempotency-key':randomUUID()},payload:{amount:{amount:3000,currency:'RUB'}}})
    expect(paid.statusCode,paid.body).toBe(200)
    const created=await app.inject({method:'POST',url:`/vendors/${vendorId}/resources`,headers:{...auth(owner),'idempotency-key':randomUUID()},payload:{kind:'capacity',label:'Declared deliveries',capacityUnit:'deliveries'}})
    expect(created.statusCode,created.body).toBe(200)
    const resourceId=created.json().id as string
    const window=await app.inject({method:'POST',url:`/vendors/${vendorId}/resources/${resourceId}/windows`,headers:{...auth(owner),'idempotency-key':randomUUID()},
      payload:{startsAt:'2027-06-14T10:00:00+03:00',endsAt:'2027-06-14T11:00:00+03:00',capacity:3}})
    expect(window.statusCode,window.body).toBe(200)
    const policy=await app.inject({method:'PATCH',url:`/vendors/${vendorId}/availability-policy`,headers:{...auth(owner),'idempotency-key':randomUUID()},payload:{mode:'resources',expectedRevision:'0'}})
    expect(policy.statusCode,policy.body).toBe(200);expect(policy.json().legacyObligations.unresolved).toBe(true)
    const f={owner,manager,couple,vendorId,weddingId,resourceId}
    const positive=await read(f);expect(positive.statusCode,positive.body).toBe(200);expect(positive.json()).toHaveLength(1)
    return f
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>
  const read=(f:Fixture)=>app.inject({method:'GET',url:`/vendors/${f.vendorId}/resources`,headers:auth(f.manager)}).then(r=>r)
  const withdraw=(f:Fixture)=>app.inject({method:'DELETE',url:'/users/me/consent',headers:auth(f.manager)}).then(r=>r)
  async function business(f:Fixture){
    const r=await Promise.all([
      app.db!.query('select * from vendor_resources where vendor_id=$1 order by id',[f.vendorId]),
      app.db!.query('select * from resource_capacity_windows where resource_id=$1 order by id',[f.resourceId]),
      app.db!.query('select * from vendor_availability_policy where vendor_id=$1',[f.vendorId]),
      app.db!.query('select * from vendor_busy_dates where vendor_id=$1 order by date',[f.vendorId]),
      app.db!.query('select * from deals where wedding_id=$1 order by id',[f.weddingId]),
      app.db!.query('select p.* from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1 order by p.id',[f.weddingId]),
      app.db!.query('select * from weddings where id=$1',[f.weddingId]),
      app.db!.query('select * from slots where wedding_id=$1 order by id',[f.weddingId]),
      app.db!.query('select * from idempotency_keys where user_id=any($1::uuid[]) order by key',[[f.owner.userId,f.manager.userId,f.couple.userId]]),
    ]);return r.map(x=>x.rows)
  }
  async function principal(f:Fixture){
    const r=await Promise.all([
      app.db!.query('select * from users where id=$1',[f.manager.userId]),
      app.db!.query('select * from sessions where user_id=$1 order by id',[f.manager.userId]),
      app.db!.query('select * from consents where user_id=$1 order by id',[f.manager.userId]),
      app.db!.query('select * from audit_log where actor_id=$1 order by id',[f.manager.userId]),
    ]);return r.map(x=>x.rows)
  }
  type Outcome<T>={ok:true;value:T}|{ok:false;error:unknown}
  const reflected=<T>(task:Promise<T>):Promise<Outcome<T>>=>task.then(value=>({ok:true,value} as const),error=>({ok:false,error} as const))
  function resolved<T>(outcome:Outcome<T>):T{if(!outcome.ok)throw outcome.error;return outcome.value}
  async function monitorCycle(pids:number[],finished:()=>boolean):Promise<Wait[]>{
    const deadline=performance.now()+3500
    while(!finished()&&performance.now()<deadline){
      const rows=(await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
        where datname=current_database() and pid=any($1::int[]) and wait_event_type='Lock'`,[pids])).rows
      if(rows.some(x=>x.pid===pids[0]&&x.blockers.includes(pids[1]!))&&rows.some(x=>x.pid===pids[1]&&x.blockers.includes(pids[0]!)))return rows
      await new Promise<void>(yes=>setTimeout(yes,10))
    }
    return[]
  }
  async function consentRace(f:Fixture,withdrawalFirst:boolean,refresh=false){
    type Reply=Awaited<ReturnType<typeof read>>
    type Activity=NativeCalendarWaitRow&{wait_event:string|null;backend_xid:string|null;holder_backend_xid:string|null}
    let rDone=false,dDone=false,phaseDeadline=0,refreshedAccess:string|undefined
    let beforeWithdrawal:Awaited<ReturnType<typeof principal>>|undefined,monitor:Promise<Outcome<Wait[]>>|undefined
    let failure:{error:unknown}|undefined,result:{resource:Reply;deletion:Reply;resourceWait:Wait;withdrawalWait:Wait;cycle:Wait[];beforeWithdrawal:Awaited<ReturnType<typeof principal>>;refreshedAccess:string|undefined}|undefined
    const resource=()=>{phaseDeadline=performance.now()+3500;return read(f).then(r=>{rDone=true;return r},error=>{rDone=true;throw error})}
    const deletion=async()=>{
      if(refresh){
        // This real route uses db.query/rotateTokens on the SAME session, not db.tx.
        // The first resource HTTP is already witnessed waiting at the earliest gate.
        const rotated=await app.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:f.manager.refreshToken}})
        expect(rotated.statusCode,rotated.body).toBe(200);refreshedAccess=rotated.json().accessToken as string
        expect(refreshedAccess).toEqual(expect.any(String))
      }
      beforeWithdrawal=await principal(f);phaseDeadline=performance.now()+3500
      return withdraw(f).then(r=>{dDone=true;return r},error=>{dDone=true;throw error})
    }
    try{
      const race=await runNativeCalendarHttpPrefixRace(app.db!,{weddingId:f.weddingId,caseName:`consent withdrawalFirst=${withdrawalFirst}/refresh=${refresh}`},async c=>{
        await c.query("set local statement_timeout='5000ms'")
        await c.query("set local idle_in_transaction_session_timeout='10000ms'")
        // A pure gate owns ONLY the first sorted native wedding parent. It never
        // mutates other rows or requests a later lock, so refresh can really rotate.
        for(const seed of [{vendorIds:[f.vendorId],extraAccountIds:[f.manager.userId]},
          {personIds:[f.manager.userId],extraAccountIds:[f.manager.userId],mode:'erase'}]){
          const rows=(await c.query<{scope:{weddings:string[];accounts:string[]}}>('select legacy_calendar_bounds_locate($1::jsonb) as scope',[JSON.stringify(seed)])).rows
          expect(rows).toHaveLength(1);expect(rows[0]!.scope.weddings).toEqual([f.weddingId]);expect(rows[0]!.scope.accounts).toContain(f.manager.userId)
        }
        expect((await c.query('select id from weddings where id=$1 for update',[f.weddingId])).rows).toEqual([{id:f.weddingId}])
      },null,withdrawalFirst?[{label:'withdrawal',start:deletion},{label:'resource',start:resource}]
        :[{label:'resource',start:resource},{label:'withdrawal',start:deletion}],async(c,holder,workers)=>{
        assert(performance.now()<phaseDeadline,'Original consent3500ms phase observer deadline expired')
        const activity=(await c.query<Activity>(
          'select w.pid,w.backend_start::text backend_start,w.xact_start::text xact_start,w.backend_xid::text backend_xid,'
          +'w.datname,w.usename,w.state,w.wait_event_type,w.wait_event,w.query,pg_blocking_pids(w.pid) blockers,b.pid holder_pid,'
          +'b.backend_start::text holder_backend_start,b.xact_start::text holder_xact_start,b.backend_xid::text holder_backend_xid,'
          +'b.datname holder_datname,b.usename holder_usename,b.state holder_state,clock_timestamp()::text observed_at '
          +'from pg_stat_activity w join pg_stat_activity b on b.pid=$2 where w.datname=current_database() and w.pid=any($1::integer[]) order by w.pid',
          [workers.map(worker=>worker.pid),holder.pid])).rows
        for(const worker of workers){const row=activity.find(x=>x.pid===worker.pid)
          if(row?.state==='active'&&row.wait_event_type==='Lock'&&row.query.trim().replace(/\s+/g,' ')==='select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope'){
            assert.equal(row.backend_xid,(BigInt(worker.txid)%4294967296n).toString());assert.equal(row.holder_backend_xid,(BigInt(holder.txid)%4294967296n).toString())
          }
        }
        assert(performance.now()<phaseDeadline,'Actual consent witness exceeded original3500ms phase bound')
        if(workers.length===2&&!monitor)monitor=reflected(monitorCycle(workers.map(worker=>worker.pid),()=>rDone&&dDone))
        return activity
      })
      expect(race.mutationCommitted).toBe(false);expect(race.replies).toHaveLength(2);expect(race.witnesses).toHaveLength(2)
      const proof=race.witnesses[1]!;expect(proof.workers).toHaveLength(2)
      expect(proof.paths).toEqual([[proof.workers[0]!.pid,proof.holder.pid],[proof.workers[1]!.pid,proof.workers[0]!.pid,proof.holder.pid]])
      const resourceRow=proof.activity.find(x=>x.pid===proof.workers[withdrawalFirst?1:0]!.pid)! as Activity
      const withdrawalRow=proof.activity.find(x=>x.pid===proof.workers[withdrawalFirst?0:1]!.pid)! as Activity
      assert(resourceRow.wait_event&&withdrawalRow.wait_event&&monitor&&beforeWithdrawal)
      result={resource:race.replies[withdrawalFirst?1:0]!,deletion:race.replies[withdrawalFirst?0:1]!,resourceWait:resourceRow as Wait,
        withdrawalWait:withdrawalRow as Wait,cycle:resolved(await monitor),beforeWithdrawal,refreshedAccess}
    }catch(error){failure={error}}finally{
      if(monitor){const outcome=await monitor;if(!outcome.ok&&outcome.error!==failure?.error)failure={error:new AggregateError(failure?[failure.error,outcome.error]:[outcome.error],'Consent cycle observer/drain failed',failure?{cause:failure.error}:undefined)}}
    }
    if(failure)throw failure.error;assert(result);return result
  }
  async function revokeComplete(f:Fixture){
    const rows=await principal(f)
    expect(rows[0]![0]!.deleted_at).not.toBeNull()
    expect(rows[1]!.length).toBeGreaterThan(0);expect(rows[1]!.every(s=>s.revoked_at!==null)).toBe(true)
    expect(rows[2]!.length).toBeGreaterThan(0);expect(rows[2]!.every(c=>c.withdrawn_at!==null)).toBe(true)
    expect(rows[3]!.filter(a=>a.action==='consent.withdrawn')).toHaveLength(1)
    const denied=await read(f);expect(denied.statusCode,denied.body).toBe(401)
  }
  it.each([false,true])('resource first, real consent withdrawal completes without cycle; refresh control=%s',async refresh=>{
    const f=await fixture(),before=await business(f),errorStart=observedErrors.length
    const {resource:r,deletion:d,resourceWait,withdrawalWait,cycle,beforeWithdrawal,refreshedAccess}=await consentRace(f,false,refresh)
    const afterBusiness=await business(f),afterPrincipal=await principal(f)
    traces.push({refresh,resourceWait,withdrawalWait,cycle,statuses:{resource:r.statusCode,withdrawal:d.statusCode},
      businessUnchanged:isDeepStrictEqual(afterBusiness,before),withdrawalRolledBack:d.statusCode===500?isDeepStrictEqual(afterPrincipal,beforeWithdrawal):null,
      errors:observedErrors.slice(errorStart)})
    if(d.statusCode===500)expect(afterPrincipal).toEqual(beforeWithdrawal)
    expect(r.statusCode,r.body).toBe(200);expect(d.statusCode,d.body).toBe(204);expect(cycle).toEqual([])
    expect(afterBusiness).toEqual(before);await revokeComplete(f)
    if(refreshedAccess){
      const denied=await app.inject({method:'GET',url:`/vendors/${f.vendorId}/resources`,headers:{authorization:`Bearer ${refreshedAccess}`}})
      expect(denied.statusCode,denied.body).toBe(401)
    }
  })
  it('withdrawal first wins the current native queue and a waiting resource request denies the erased actor',async()=>{
    const f=await fixture(),before=await business(f)
    const {resource:r,deletion:d,resourceWait,withdrawalWait,cycle}=await consentRace(f,true)
    traces.push({withdrawalFirst:true,resourceWait,withdrawalWait,cycle,statuses:{resource:r.statusCode,withdrawal:d.statusCode}})
    expect(d.statusCode,d.body).toBe(204);expect(r.statusCode,r.body).toBe(401);expect(cycle).toEqual([])
    expect(await business(f)).toEqual(before);await revokeComplete(f)
  })
  it('actual withdrawal audit failure rolls back account, sessions and consent and remains retryable',async()=>{
    const f=await fixture(),beforePrincipal=await principal(f),beforeBusiness=await business(f),constraint='consent_lock_audit_'+randomUUID().replaceAll('-','')
    // Scoped negative control for this fixture only, removed unconditionally.
    await app.db!.query(`alter table audit_log add constraint ${constraint} check(not(actor_id='${f.manager.userId}'::uuid and action='consent.withdrawn')) not valid`)
    try{
      const failed=await withdraw(f);expect(failed.statusCode,failed.body).toBe(500)
      expect(await principal(f)).toEqual(beforePrincipal);expect(await business(f)).toEqual(beforeBusiness)
      const live=await read(f);expect(live.statusCode,live.body).toBe(200)
    }finally{await app.db!.query(`alter table audit_log drop constraint ${constraint}`)}
    const retry=await withdraw(f);expect(retry.statusCode,retry.body).toBe(204)
    expect(await business(f)).toEqual(beforeBusiness);await revokeComplete(f)
  })
})
