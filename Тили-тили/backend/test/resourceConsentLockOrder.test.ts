import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { Client } from 'pg'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createRefreshToken, hashRefreshToken, signAccessToken } from '../src/auth/tokens.js'
import { inviteStaff, acceptStaffInvite } from '../src/vendor/staff.js'

const DB=process.env.TEST_DATABASE_URL, POLICY='2026-09-02', SECRET='synthetic-consent-resource-lock'.repeat(3)
type Wait={pid:number;query:string;wait_event:string;blockers:number[]}
describe.skipIf(!DB)('actual resource management and consent withdrawal lock order',()=>{
  let app:FastifyInstance
  const users:string[]=[],vendors:string[]=[],weddings:string[]=[]
  const traces:unknown[]=[],observedErrors:{route:string;code:string|undefined}[]=[]
  const controls=new Set<Client>()
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
      for(const c of controls){await c.query('rollback').catch(()=>undefined);await c.end()}
      controls.clear()
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
  async function control(f:Fixture,account=false){
    const c=new Client({connectionString:DB!,statement_timeout:5000,idle_in_transaction_session_timeout:10000})
    controls.add(c);await c.connect();await c.query('begin')
    const pid=(await c.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid
    await c.query(account?'select id from users where id=$1 for update':'select id from vendors where id=$1 for update',[account?f.manager.userId:f.vendorId])
    return{c,pid}
  }
  async function waitFor(blocker:number,fragment:string,finished:()=>boolean):Promise<Wait>{
    const deadline=Date.now()+3500
    while(!finished()&&Date.now()<deadline){
      const row=(await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and query ilike $2`,[blocker,fragment])).rows[0]
      if(row)return row
    }
    throw new Error(`Actual PostgreSQL wait not witnessed: blocker=${blocker},query=${fragment},finished=${finished()}`)
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
    const f=await fixture(),before=await business(f),b=await control(f)
    let resource:ReturnType<typeof read>|undefined,deletion:ReturnType<typeof withdraw>|undefined
    let rDone=false,dDone=false
    const errorStart=observedErrors.length
    try{
      resource=read(f).then(r=>{rDone=true;return r})
      const resourceWait=await waitFor(b.pid,'%vendors%',()=>rDone)
      let refreshedAccess:string|undefined
      if(refresh){
        const rotated=await app.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:f.manager.refreshToken}})
        expect(rotated.statusCode,rotated.body).toBe(200);refreshedAccess=rotated.json().accessToken as string
        expect(refreshedAccess).toEqual(expect.any(String))
      }
      const beforeWithdrawal=await principal(f)
      deletion=withdraw(f).then(r=>{dDone=true;return r})
      const withdrawalWait=await waitFor(resourceWait.pid,'%users%',()=>dDone)
      await b.c.query('commit')
      // Observe a real two-way wait if present; in the fixed source requests
      // complete without one. Never inject an error or force a chosen victim.
      let cycle:Wait[]=[];const deadline=Date.now()+3500
      while(!(rDone&&dDone)&&Date.now()<deadline){
        const rows=(await app.db!.query<Wait>(`select pid,query,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
          where datname=current_database() and pid=any($1::int[]) and wait_event_type='Lock'`,[[resourceWait.pid,withdrawalWait.pid]])).rows
        if(rows.some(x=>x.pid===resourceWait.pid&&x.blockers.includes(withdrawalWait.pid))&&
          rows.some(x=>x.pid===withdrawalWait.pid&&x.blockers.includes(resourceWait.pid))){cycle=rows;break}
      }
      const [r,d]=await Promise.all([resource,deletion])
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
    }finally{
      // Release our blocker before draining handlers, including assertion or
      // observation failure. Never terminate other connections or change timeouts.
      await b.c.query('rollback').catch(()=>undefined)
      await Promise.allSettled([...(resource?[resource]:[]),...(deletion?[deletion]:[])])
      await b.c.end();controls.delete(b.c)
    }
  })
  it('withdrawal first wins the account queue and a waiting resource request denies the erased actor',async()=>{
    const f=await fixture(),before=await business(f),b=await control(f,true)
    let resource:ReturnType<typeof read>|undefined,deletion:ReturnType<typeof withdraw>|undefined
    let rDone=false,dDone=false
    try{
      deletion=withdraw(f).then(r=>{dDone=true;return r})
      const withdrawalWait=await waitFor(b.pid,'%users%',()=>dDone)
      resource=read(f).then(r=>{rDone=true;return r})
      const resourceWait=await waitFor(withdrawalWait.pid,'%users%',()=>rDone)
      await b.c.query('commit')
      const [r,d]=await Promise.all([resource,deletion])
      traces.push({withdrawalFirst:true,resourceWait,withdrawalWait,statuses:{resource:r.statusCode,withdrawal:d.statusCode}})
      expect(d.statusCode,d.body).toBe(204);expect(r.statusCode,r.body).toBe(401)
      expect(await business(f)).toEqual(before);await revokeComplete(f)
    }finally{
      await b.c.query('rollback').catch(()=>undefined)
      await Promise.allSettled([...(resource?[resource]:[]),...(deletion?[deletion]:[])])
      await b.c.end();controls.delete(b.c)
    }
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
