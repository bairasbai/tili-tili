import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'

const DB=process.env.TEST_DATABASE_URL, POLICY='2026-09-02', SECRET='synthetic-resource-api-access'.repeat(3)
const DOORS=['list','create','retire','window','patch','policy_read','policy_write','options'] as const
const CHANGES=['member_revoked','worker','session_revoked','consent_withdrawn','vendor_blocked','owner_deleted'] as const
type Door=typeof DOORS[number]
type Change=typeof CHANGES[number]
type Command={method:'GET'|'POST'|'PATCH';url:string;payload?:Record<string,unknown>}
const START='2027-06-14T10:00:00+03:00', END='2027-06-14T11:00:00+03:00'

describe.skipIf(!DB)('registered private resource API with current authority and atomic saved replies',()=>{
  let app:FastifyInstance
  const users:string[]=[], vendors:string[]=[], weddings:string[]=[]
  const witnesses:{door:string;change:string;holder:number;waiter:number;lock:string}[]=[]
  const prefix=String(randomInt(100_000,999_999));let sequence=0
  beforeAll(async()=>{
    const target=new URL(DB!)
    assert(['postgres:','postgresql:'].includes(target.protocol));assert.equal(target.hostname,'127.0.0.1')
    assert.equal(target.port,disposablePgPort());assert.equal(target.username,'codex_test')
    assert(['/tili_ecosystem_resources_api_20260930_test','/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search,'');assert.equal(target.hash,'')
    app=await buildApp({env:'test',databaseUrl:DB!,redisUrl:null,corsOrigins:[],jwtAccessSecret:SECRET,
      jwtRefreshSecret:'synthetic-resource-api-refresh'.repeat(3),policyVersion:POLICY})
    await app.ready()
    expect((await app.db!.query<{name:string}>('select current_database() name')).rows[0]!.name).toBe(target.pathname.slice(1))
  })
  afterAll(async()=>{
    if(!app)return
    try{
      process.stdout.write(`RESOURCE_API_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      await app.db!.query('delete from vendor_resources where vendor_id=any($1::uuid[])',[vendors])
      for(const id of weddings)await app.db!.query('delete from weddings where id=$1',[id])
      for(const id of vendors)await app.db!.query('delete from vendors where id=$1',[id])
      for(const id of users)await app.db!.query('delete from users where id=$1',[id])
    }finally{await app.close()}
  })
  // Accounts and consent are named synthetic fixtures. Membership acceptance is
  // exercised through the actual domain invite/accept commands, not inserted receipts.
  async function actor(){
    const userId=randomUUID(),sessionId=randomUUID();users.push(userId)
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic resource API actor')",[userId,`+79${prefix}${String(++sequence).padStart(3,'0')}`])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',[sessionId,userId,randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)',[randomUUID(),userId,POLICY])
    return{userId,sessionId,policyVersion:POLICY,token:await signAccessToken(SECRET,{sub:userId,sid:sessionId})}
  }
  type Actor=Awaited<ReturnType<typeof actor>>
  async function fixture(){
    const owner=await actor(),manager=await actor(),worker=await actor(),vendorId=randomUUID();vendors.push(vendorId)
    await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Private resource API company',now())",[vendorId,owner.userId])
    async function accept(person:Actor,role:'worker'|'resource_manager'){
      const invited=await app.db!.tx(c=>inviteStaff(c,{vendorId,actor:owner,role,targetUserId:person.userId}))
      const accepted=await app.db!.tx(c=>acceptStaffInvite(c,{token:invited.token,actor:person}))
      expect(accepted).toMatchObject({state:'active',userId:person.userId,role});return accepted.id
    }
    return{vendorId,owner,manager,worker,managerId:await accept(manager,'resource_manager'),workerId:await accept(worker,'worker')}
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>
  const base=(f:Fixture)=>`/vendors/${f.vendorId}`
  function invoke(f:Fixture,cmd:Command,caller=f.owner,key?:string){
    return app.inject({...cmd,headers:{authorization:`Bearer ${caller.token}`,...(key?{'idempotency-key':key}:{})}}).then(r=>r)
  }
  async function ok(f:Fixture,cmd:Command,caller=f.owner,key=randomUUID()){
    const response=await invoke(f,cmd,caller,key);expect(response.statusCode,response.body).toBe(200);return response
  }
  async function resource(f:Fixture,kind:'capacity'|'equipment'='capacity'){
    return(await ok(f,{method:'POST',url:base(f)+'/resources',payload:{kind,label:'Private declared deliveries',...(kind==='capacity'?{capacityUnit:'deliveries'}:{})}})).json() as {id:string;version:string}
  }
  async function window(f:Fixture,id:string){
    return(await ok(f,{method:'POST',url:base(f)+`/resources/${id}/windows`,payload:{startsAt:START,endsAt:END,capacity:3}})).json() as {id:string;version:string}
  }
  async function command(f:Fixture,door:Door):Promise<Command>{
    if(door==='list')return{method:'GET',url:base(f)+'/resources'}
    if(door==='policy_read')return{method:'GET',url:base(f)+'/availability-policy'}
    if(door==='options')return{method:'GET',url:base(f)+'/resource-options'}
    if(door==='create')return{method:'POST',url:base(f)+'/resources',payload:{kind:'equipment',label:'Private new kit'}}
    if(door==='policy_write'){await resource(f);return{method:'PATCH',url:base(f)+'/availability-policy',payload:{mode:'resources',expectedRevision:'0'}}}
    const r=await resource(f)
    if(door==='retire')return{method:'POST',url:base(f)+`/resources/${r.id}/retire`,payload:{expectedVersion:'1'}}
    if(door==='window')return{method:'POST',url:base(f)+`/resources/${r.id}/windows`,payload:{startsAt:START,endsAt:END,capacity:3}}
    const w=await window(f,r.id);return{method:'PATCH',url:base(f)+`/resources/${r.id}/windows/${w.id}`,payload:{capacity:5,expectedVersion:'1'}}
  }
  async function state(f:Fixture,client:Queryable=app.db!){
    const ids=[f.owner.userId,f.manager.userId,f.worker.userId]
    const result=await Promise.all([
      client.query('select * from vendor_resources where vendor_id=$1 order by id',[f.vendorId]),
      client.query('select w.* from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id where r.vendor_id=$1 order by w.id',[f.vendorId]),
      client.query('select * from vendor_availability_policy where vendor_id=$1',[f.vendorId]),
      client.query('select * from audit_log where actor_id=any($1::uuid[]) order by id',[ids]),
      client.query('select * from idempotency_keys where user_id=any($1::uuid[]) order by key',[ids]),
      client.query('select * from vendor_busy_dates where vendor_id=$1 order by date',[f.vendorId]),
      client.query('select * from deals where vendor_id=$1 order by id',[f.vendorId]),
      client.query('select p.* from payments p join deals d on d.id=p.deal_id where d.vendor_id=$1 order by p.id',[f.vendorId]),
      client.query('select * from weddings where id=any($1::uuid[]) order by id',[weddings]),
      client.query('select * from vendor_staff_duties where vendor_id=$1 order by id',[f.vendorId]),
      client.query('select * from wedding_events where wedding_id=any($1::uuid[]) order by id',[weddings]),
      client.query('select * from timeline_events where wedding_id=any($1::uuid[]) order by id',[weddings]),
      client.query('select * from slots where wedding_id=any($1::uuid[]) order by id',[weddings]),
    ]);return result.map(r=>r.rows)
  }
  function deny(r:Awaited<ReturnType<typeof invoke>>,status:number){
    expect(r.statusCode,r.body).toBe(status);expect(Object.keys(r.json())).toEqual(['error'])
    expect(r.headers['idempotent-replay']).toBeUndefined();expect(r.body).not.toContain('Private declared deliveries')
    expect(r.body).not.toContain('Private new kit');expect(r.body).not.toContain('conflict_identity')
  }
  async function waited(f:Fixture,door:string,change:string,request:()=>ReturnType<typeof invoke>,mutation:(c:Queryable)=>Promise<unknown>,account?:string){
    let ready!:()=>void,release!:()=>void,holderPid=0
    const started=new Promise<void>(r=>{ready=r}),finish=new Promise<void>(r=>{release=r})
    const holder=app.db!.tx(async c=>{
      holderPid=(await c.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid
      if(account)await c.query('select id from users where id=$1 for update',[account])
      else await c.query('select id from vendors where id=$1 for update',[f.vendorId])
      ready();await finish;await mutation(c)
    })
    await started;let done=false
    const response=request().then(r=>{done=true;return r})
    try{
      let observed:{pid:number;wait_event:string}|undefined;const deadline=Date.now()+4000
      while(!done&&Date.now()<deadline){
        observed=(await app.db!.query<{pid:number;wait_event:string}>(`select pid,wait_event from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))
          and query ilike $2`,[holderPid,account?'%users%':'%vendors%'])).rows[0]
        if(observed)break;await new Promise(r=>setTimeout(r,10))
      }
      expect(observed,`Missing actual PG wait ${door}/${change}; finished=${done}`).toBeDefined()
      witnesses.push({door,change,holder:holderPid,waiter:observed!.pid,lock:observed!.wait_event})
    }finally{release();await holder;await response}
    return response
  }
  async function revoke(c:Queryable,f:Fixture,change:Change){
    if(change==='member_revoked')await c.query("update vendor_staff_members set state='revoked',revoked_at=clock_timestamp() where id=$1",[f.managerId])
    if(change==='worker')await c.query("update vendor_staff_members set role='worker' where id=$1",[f.managerId])
    if(change==='session_revoked')await c.query('update sessions set revoked_at=clock_timestamp() where id=$1',[f.manager.sessionId])
    if(change==='consent_withdrawn')await c.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1',[f.manager.userId])
    if(change==='vendor_blocked')await c.query('update vendors set blocked_at=clock_timestamp() where id=$1',[f.vendorId])
    if(change==='owner_deleted')await c.query('update users set deleted_at=clock_timestamp() where id=$1',[f.owner.userId])
  }
  const status=(change:Change)=>change==='session_revoked'?401:change==='vendor_blocked'||change==='owner_deleted'?404:403
  it.each(DOORS)('%s actual positive control, narrow GET, exact retry and worker denial',async door=>{
    const f=await fixture(),cmd=await command(f,door),key=randomUUID()
    const first=await ok(f,cmd,f.manager,key),before=await state(f)
    const retry=await ok(f,cmd,f.manager,key);expect(retry.json()).toEqual(first.json());expect(await state(f)).toEqual(before)
    expect(first.headers['cache-control']).toBe('no-store')
    for(const field of ['conflict_identity','request_hash','invite_token','weddingId','price','terms'])expect(first.body).not.toContain(`"${field}"`)
    deny(await invoke(f,cmd,f.worker,randomUUID()),403);expect(await state(f)).toEqual(before)
  })
  for(const replay of [false,true])for(const door of DOORS){
    if(replay&&(door==='list'||door==='policy_read'||door==='options'))continue
    it.each(CHANGES)(`${door} ${replay?'cached':'fresh'} checks %s after proven PostgreSQL waiting`,async change=>{
      const f=await fixture(),cmd=await command(f,door),key=randomUUID()
      // Real HTTP success proves the initial role/session/schema and creates the saved reply.
      if(replay)await ok(f,cmd,f.manager,key)
      else await ok(f,{method:'GET',url:base(f)+'/resources'},f.manager)
      const before=await state(f)
      const response=await waited(f,door+(replay?':replay':':fresh'),change,()=>invoke(f,cmd,f.manager,key),c=>revoke(c,f,change),change==='owner_deleted'?f.owner.userId:undefined)
      deny(response,status(change));expect(await state(f)).toEqual(before)
    })
  }
  it.each(['create','retire','window','patch','policy_write'] as const)('%s requires key and binds it to exact body and vendor path',async door=>{
    const f=await fixture(),cmd=await command(f,door),key=randomUUID(),before=await state(f)
    deny(await invoke(f,cmd),400);expect(await state(f)).toEqual(before)
    await ok(f,cmd,f.owner,key);const saved=await state(f)
    const altered={...cmd,payload:{...cmd.payload,...(door==='create'?{label:'Changed'}:door==='retire'?{expectedVersion:'2'}:door==='policy_write'?{expectedRevision:'1'}:{capacity:9})}}
    deny(await invoke(f,altered,f.owner,key),409);expect(await state(f)).toEqual(saved)
    const other=await fixture()
    // One owner can be an accepted manager of a different company. Ownership
    // itself is unique; use actual invitation acceptance rather than overwriting it.
    const invite=await app.db!.tx(c=>inviteStaff(c,{vendorId:other.vendorId,actor:other.owner,role:'resource_manager',targetUserId:f.owner.userId}))
    await app.db!.tx(c=>acceptStaffInvite(c,{token:invite.token,actor:f.owner}))
    let otherCmd:Command
    if(door==='create'||door==='policy_write')otherCmd={...cmd,url:cmd.url.replace(f.vendorId,other.vendorId)}
    else otherCmd=await command({...other,owner:f.owner},door)
    const otherBefore=await state(other)
    deny(await invoke(other,otherCmd,f.owner,key),409);expect(await state(other)).toEqual(otherBefore)
  })
  it('person cached creation refuses revoked target after actual vendor wait and hides stale identity on GET',async()=>{
    const f=await fixture(),cmd:Command={method:'POST',url:base(f)+'/resources',payload:{kind:'person',label:'Private employee',personUserId:f.worker.userId,staffMemberId:f.workerId}},key=randomUUID()
    const first=await ok(f,cmd,f.owner,key);expect(first.json()).toMatchObject({personUserId:f.worker.userId,staffMemberId:f.workerId})
    const before=await state(f)
    const response=await waited(f,'person:replay','target_revoked',()=>invoke(f,cmd,f.owner,key),c=>c.query("update vendor_staff_members set state='revoked',revoked_at=clock_timestamp() where id=$1",[f.workerId]))
    deny(response,422);expect(response.body).not.toContain(f.worker.userId);expect(await state(f)).toEqual(before)
    const list=await ok(f,{method:'GET',url:base(f)+'/resources'})
    expect(list.json()[0]).toMatchObject({source:'unavailable',unavailableReason:'person_unavailable',personUserId:null,staffMemberId:null})
  })
  it('person cached creation refuses an erased target after proven first account wait',async()=>{
    const f=await fixture(),cmd:Command={method:'POST',url:base(f)+'/resources',payload:{kind:'person',label:'Private employee',personUserId:f.worker.userId,staffMemberId:f.workerId}},key=randomUUID()
    await ok(f,cmd,f.owner,key);const before=await state(f)
    const response=await waited(f,'person:replay','target_deleted',()=>invoke(f,cmd,f.owner,key),c=>c.query('update users set deleted_at=clock_timestamp() where id=$1',[f.worker.userId]),f.worker.userId)
    deny(response,422);expect(response.body).not.toContain(f.worker.userId);expect(await state(f)).toEqual(before)
  })
  it.each(['revoked','erased'] as const)('cached person retirement cannot return formerly current employee identity after target %s',async change=>{
    const f=await fixture()
    const person=(await ok(f,{method:'POST',url:base(f)+'/resources',payload:{kind:'person',label:'Private employee',personUserId:f.worker.userId,staffMemberId:f.workerId}})).json() as {id:string}
    const cmd:Command={method:'POST',url:base(f)+`/resources/${person.id}/retire`,payload:{expectedVersion:'1'}},key=randomUUID()
    const first=await ok(f,cmd,f.owner,key);expect(first.json()).toMatchObject({personUserId:f.worker.userId,staffMemberId:f.workerId})
    let afterChange:Awaited<ReturnType<typeof state>>|undefined
    const response=await waited(f,'person_retire:replay','target_'+change,()=>invoke(f,cmd,f.owner,key),async c=>{
      if(change==='erased')await c.query('delete from users where id=$1',[f.worker.userId])
      else await c.query("update vendor_staff_members set state='revoked',revoked_at=clock_timestamp() where id=$1",[f.workerId])
      // Actual erasure legitimately applies SET NULL and anonymizes old audits.
      // Compare against that real post-erasure state, not fabricated unchanged FKs.
      afterChange=await state(f,c)
    },change==='erased'?f.worker.userId:undefined)
    deny(response,422);expect(response.body).not.toContain(f.worker.userId);expect(await state(f)).toEqual(afterChange)
  })
  it.each(['revoked','erased'] as const)('fresh retirement of %s person remains possible without leaking unavailable source',async change=>{
    const f=await fixture()
    const person=(await ok(f,{method:'POST',url:base(f)+'/resources',payload:{kind:'person',label:'Private employee',personUserId:f.worker.userId,staffMemberId:f.workerId}})).json() as {id:string}
    if(change==='erased')await app.db!.query('delete from users where id=$1',[f.worker.userId])
    else await app.db!.query("update vendor_staff_members set state='revoked',revoked_at=clock_timestamp() where id=$1",[f.workerId])
    const cmd:Command={method:'POST',url:base(f)+`/resources/${person.id}/retire`,payload:{expectedVersion:'1'}},key=randomUUID()
    const retired=await ok(f,cmd,f.owner,key)
    expect(retired.json()).toMatchObject({version:'2',source:'unavailable',unavailableReason:'retired',personUserId:null,staffMemberId:null})
    const beforeRetry=await state(f)
    const retry=await ok(f,cmd,f.owner,key)
    expect(retry.json()).toEqual(retired.json());expect(await state(f)).toEqual(beforeRetry)
  })
  it.each(['create','retire','window','patch','policy_write'] as const)('%s two concurrent same-key HTTP commands produce exactly one action and audit',async door=>{
    const f=await fixture(),cmd=await command(f,door),key=randomUUID(),before=await state(f)
    const [first,second]=await Promise.all([invoke(f,cmd,f.manager,key),invoke(f,cmd,f.manager,key)])
    expect(first.statusCode,first.body).toBe(200);expect(second.statusCode,second.body).toBe(200);expect(second.json()).toEqual(first.json())
    const after=await state(f)
    expect(after[3]!.length-before[3]!.length).toBe(1);expect(after[4]!.length-before[4]!.length).toBe(1)
    if(door==='create')expect(after[0]!.length-before[0]!.length).toBe(1)
    if(door==='window')expect(after[1]!.length-before[1]!.length).toBe(1)
    expect(after.slice(5)).toEqual(before.slice(5))
    expect((await invoke(f,cmd,f.manager,key)).json()).toEqual(first.json());expect(await state(f)).toEqual(after)
  })
  it.each(DOORS)('%s rejects schema foreign fields or invalid params before mutation',async door=>{
    const f=await fixture(),cmd=await command(f,door),before=await state(f)
    const bad=cmd.method==='GET'?{...cmd,url:cmd.url.replace(f.vendorId,'not-a-uuid')}:{...cmd,payload:{...cmd.payload,vendorId:randomUUID(),actor:{userId:f.owner.userId}}}
    deny(await invoke(f,bad,f.owner,randomUUID()),422);expect(await state(f)).toEqual(before)
  })
  it('immutable kind/unit/time, positive integer capacity, exact version and adjacent windows are HTTP contracts',async()=>{
    const f=await fixture(),r=await resource(f),w=await window(f,r.id)
    const patch:Command={method:'PATCH',url:base(f)+`/resources/${r.id}/windows/${w.id}`,payload:{expectedVersion:'1',capacity:5}}
    for(const extra of [{startsAt:START},{capacityUnit:'kits'},{kind:'person'},{capacity:0},{capacity:1.5},{capacity:2147483648}]){
      const before=await state(f);deny(await invoke(f,{...patch,payload:{...patch.payload,...extra}},f.owner,randomUUID()),422);expect(await state(f)).toEqual(before)
    }
    await ok(f,patch);const before=await state(f)
    deny(await invoke(f,patch,f.owner,randomUUID()),409);expect(await state(f)).toEqual(before)
    const adjacent=await ok(f,{method:'POST',url:base(f)+`/resources/${r.id}/windows`,payload:{startsAt:'2027-06-14T08:00:00Z',endsAt:'2027-06-14T09:00:00Z',capacity:2}})
    expect(adjacent.json()).toMatchObject({used:0,capacity:2,startsAt:'2027-06-14T08:00:00.000Z'})
    const after=await state(f)
    deny(await invoke(f,{method:'POST',url:base(f)+`/resources/${r.id}/windows`,payload:{startsAt:'2027-06-14T07:30:00Z',endsAt:'2027-06-14T08:30:00Z',capacity:2}},f.owner,randomUUID()),409)
    expect(await state(f)).toEqual(after)
  })
  it('foreign actor, foreign company resource and foreign window cannot expose or mutate cached scope',async()=>{
    const f=await fixture(),other=await fixture(),r=await resource(f),w=await window(f,r.id),local=await resource(other),key=randomUUID()
    const cmd:Command={method:'POST',url:base(f)+'/resources',payload:{kind:'equipment',label:'Private new kit'}}
    await ok(f,cmd,f.owner,key);const before=await state(f)
    deny(await invoke(f,cmd,other.owner,key),403);expect(await state(f)).toEqual(before)
    deny(await invoke(other,{method:'POST',url:base(other)+`/resources/${r.id}/retire`,payload:{expectedVersion:'1'}},other.owner,randomUUID()),404)
    deny(await invoke(other,{method:'PATCH',url:base(other)+`/resources/${local.id}/windows/${w.id}`,payload:{expectedVersion:'1',capacity:2}},other.owner,randomUUID()),404)
    expect(await state(f)).toEqual(before)
  })
  it.each(['create','retire','window','patch','policy_write'] as const)('%s audit failure rolls back business mutation and idempotency claim; same key subsequently succeeds',async door=>{
    const f=await fixture(),cmd=await command(f,door),key=randomUUID(),constraint='resource_api_audit_'+randomUUID().replaceAll('-',''),before=await state(f)
    // Own fixture actor and resource actions only. This is a real PostgreSQL
    // failure, not an intercepted query or removal of a production constraint.
    await app.db!.query(`alter table audit_log add constraint ${constraint} check(not(actor_id='${f.owner.userId}'::uuid and action like 'resource.%')) not valid`)
    try{deny(await invoke(f,cmd,f.owner,key),500);expect(await state(f)).toEqual(before)}
    finally{await app.db!.query(`alter table audit_log drop constraint ${constraint}`)}
    await ok(f,cmd,f.owner,key);const after=await state(f)
    await ok(f,cmd,f.owner,key);expect(await state(f)).toEqual(after)
  })
  it('declared resource policy preserves actual legacy hold, booked money and wedding program without granting manager finance',async()=>{
    const f=await fixture(),couple=await actor(),weddingId=randomUUID(),slotId=randomUUID();weddings.push(weddingId)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Private legacy wedding','2027-06-14','Europe/Moscow',$3)",[weddingId,couple.userId,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[weddingId,couple.userId])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Legacy flowers')",[slotId,weddingId])
    const booked=await app.inject({method:'POST',url:`/weddings/${weddingId}/slots/${slotId}/book`,headers:{authorization:`Bearer ${couple.token}`,'idempotency-key':randomUUID()},payload:{vendorId:f.vendorId,price:{amount:18000,currency:'RUB'}}})
    expect(booked.statusCode,booked.body).toBe(200)
    const paid=await app.inject({method:'POST',url:`/weddings/${weddingId}/slots/${slotId}/pay`,headers:{authorization:`Bearer ${couple.token}`,'idempotency-key':randomUUID()},payload:{amount:{amount:3000,currency:'RUB'}}})
    expect(paid.statusCode,paid.body).toBe(200)
    const timeline=await app.inject({method:'GET',url:`/weddings/${weddingId}/timeline`,headers:{authorization:`Bearer ${couple.token}`}})
    expect(timeline.statusCode,timeline.body).toBe(200);expect(timeline.headers.etag).toEqual(expect.any(String))
    const planned=await app.inject({method:'PUT',url:`/weddings/${weddingId}/timeline`,headers:{authorization:`Bearer ${couple.token}`,'if-match':String(timeline.headers.etag)},
      payload:[{name:'Private wedding ceremony',startsAt:START,endsAt:END}]})
    expect(planned.statusCode,planned.body).toBe(200)
    const r=await resource(f);await window(f,r.id)
    const before=await state(f)
    expect(before[5]).toHaveLength(1);expect(before[7]).toHaveLength(1);expect(before[11]).toHaveLength(1)
    const selected=await ok(f,{method:'PATCH',url:base(f)+'/availability-policy',payload:{mode:'resources',expectedRevision:'0'}},f.manager)
    expect(selected.json()).toMatchObject({mode:'resources',legacyObligations:{unresolved:true,committedDeals:1,dealDays:1}})
    const after=await state(f);expect(after.slice(5)).toEqual(before.slice(5))
    const denied=await app.inject({method:'GET',url:`/weddings/${weddingId}/slots`,headers:{authorization:`Bearer ${f.manager.token}`}})
    deny(denied,404);expect((await state(f)).slice(5)).toEqual(before.slice(5))
  })
  it('resource options names only current accepted people of this company and reports actual management role',async()=>{
    const f=await fixture(),other=await fixture(),pending=await actor(),deleted=await actor()
    await app.db!.tx(c=>inviteStaff(c,{vendorId:f.vendorId,actor:f.owner,role:'worker',targetUserId:pending.userId}))
    const invited=await app.db!.tx(c=>inviteStaff(c,{vendorId:f.vendorId,actor:f.owner,role:'worker',targetUserId:deleted.userId}))
    await app.db!.tx(c=>acceptStaffInvite(c,{token:invited.token,actor:deleted}))
    await app.db!.query('update users set deleted_at=clock_timestamp() where id=$1',[deleted.userId])
    const cmd:Command={method:'GET',url:base(f)+'/resource-options'},before=await state(f)
    const owner=await ok(f,cmd),manager=await ok(f,cmd,f.manager)
    expect(owner.json()).toMatchObject({vendorId:f.vendorId,actorRole:'owner'})
    expect(manager.json()).toMatchObject({vendorId:f.vendorId,actorRole:'resource_manager'})
    expect(owner.json().persons).toEqual(manager.json().persons)
    expect(owner.json().persons.map((p:{userId:string})=>p.userId).sort()).toEqual([f.owner.userId,f.manager.userId,f.worker.userId].sort())
    for(const p of owner.json().persons){expect(Object.keys(p).sort()).toEqual(['name','staffMemberId','userId']);expect(p.name).toBe('Synthetic resource API actor')}
    for(const forbidden of [pending.userId,deleted.userId,other.owner.userId,other.worker.userId,'phone','invite_token','conflict_identity','terms','weddingId'])expect(owner.body).not.toContain(forbidden)
    deny(await invoke(f,cmd,other.owner),403);deny(await invoke(f,cmd,f.worker),403);expect(await state(f)).toEqual(before)
    await app.db!.query("update vendor_staff_members set state='revoked',revoked_at=clock_timestamp() where id=$1",[f.workerId])
    expect((await ok(f,cmd)).json().persons.map((p:{userId:string})=>p.userId).sort()).toEqual([f.owner.userId,f.manager.userId].sort())
  })
})
