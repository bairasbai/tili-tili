import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Db, Queryable } from '../src/plugins/db.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
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
  async function cleanupOwnedFixtures(phase:'case'|'final'){
    if(!app)return
    const started=Date.now(),stages:Record<string,number>={}
    let completed=false
    const stage=async(name:string,run:()=>Promise<unknown>)=>{
      const started=Date.now()
      try{await run()}finally{stages[name]=Date.now()-started}
    }
    try{
      await stage('resources',()=>app.db!.query('delete from vendor_resources where vendor_id=any($1::uuid[])',[vendors]))
      await stage('weddings',()=>app.db!.query('delete from weddings where id=any($1::uuid[])',[weddings]))
      await stage('vendors',()=>app.db!.query('delete from vendors where id=any($1::uuid[])',[vendors]))
      await stage('users',async()=>{
        for(let offset=0;offset<users.length;offset+=32){
          await app.db!.query('delete from users where id=any($1::uuid[])',[users.slice(offset,offset+32)])
        }
      })
      completed=true
    }finally{
      process.stdout.write('RESOURCE_API_CASE_CLEANUP '+JSON.stringify({phase,completed,elapsedMs:Date.now()-started,stages})+'\n')
    }
  }
  afterEach(async()=>{await cleanupOwnedFixtures('case')})
  afterAll(async()=>{
    if(!app)return
    try{
      process.stdout.write(`RESOURCE_API_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      await cleanupOwnedFixtures('final')
      // Append-only audit remains evidence; only these owned mutable fixtures are removed.
      expect((await app.db!.query<{remaining:number}>('select count(*)::int remaining from vendor_resources where vendor_id=any($1::uuid[])',[vendors])).rows[0]!.remaining,'vendor_resources').toBe(0)
      for(const [table,ids] of [['weddings',weddings],['vendors',vendors],['users',users]] as const){
        expect((await app.db!.query<{remaining:number}>(`select count(*)::int remaining from ${table} where id=any($1::uuid[])`,[ids])).rows[0]!.remaining,table).toBe(0)
      }
    }finally{
      const started=Date.now();let completed=false
      try{await app.close();completed=true}finally{
        process.stdout.write('RESOURCE_API_POOL_CLOSE '+JSON.stringify({completed,elapsedMs:Date.now()-started})+'\n')
      }
    }
  })
  // Accounts and consent are named synthetic fixtures. Membership acceptance is
  // exercised through the actual domain invite/accept commands, not inserted receipts.
  async function actor(firstPhone?:string){
    const userId=randomUUID(),sessionId=randomUUID();users.push(userId)
    let created=false
    for(let attempt=0;attempt<8;attempt++){
      const phone=attempt===0&&firstPhone?firstPhone:'+79'+randomInt(100_000_000,999_999_999)
      const inserted=await app.db!.query<{id:string}>("insert into users(id,phone,name) values($1,$2,'Synthetic resource API actor') on conflict(phone) do nothing returning id",[userId,phone])
      if(inserted.rows[0]?.id===userId){created=true;break}
    }
    assert(created,'Could not allocate a synthetic resource API phone after 8 attempts')
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',[sessionId,userId,randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)',[randomUUID(),userId,POLICY])
    return{userId,sessionId,policyVersion:POLICY,token:await signAccessToken(SECRET,{sub:userId,sid:sessionId})}
  }
  type Actor=Awaited<ReturnType<typeof actor>>
  it('allocates a fresh fixture after a phone collision without changing the occupied account',async()=>{
    const occupied=await actor()
    const before=await app.db!.query('select * from users where id=$1',[occupied.userId])
    const sessions=await app.db!.query('select * from sessions where user_id=$1 order by id',[occupied.userId])
    const consents=await app.db!.query('select * from consents where user_id=$1 order by id',[occupied.userId])
    const fresh=await actor(before.rows[0]!.phone as string)
    expect(fresh.userId).not.toBe(occupied.userId)
    expect((await app.db!.query('select phone from users where id=$1',[fresh.userId])).rows[0]!.phone).not.toBe(before.rows[0]!.phone)
    expect((await app.db!.query('select * from users where id=$1',[occupied.userId])).rows).toEqual(before.rows)
    expect((await app.db!.query('select * from sessions where user_id=$1 order by id',[occupied.userId])).rows).toEqual(sessions.rows)
    expect((await app.db!.query('select * from consents where user_id=$1 order by id',[occupied.userId])).rows).toEqual(consents.rows)
  })
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
  interface PrefixIdentity { [key:string]:unknown;pid:number;backend_start:string;xact_start:string;txid:string;database:string;principal:string }
  interface PrefixActivity { [key:string]:unknown;pid:number;backend_start:string;xact_start:string;backend_xid:string|null;datname:string;usename:string;state:string;wait_event_type:string|null;query:string;blockers:number[];holder_pid:number;holder_backend_start:string;holder_xact_start:string;holder_backend_xid:string|null;holder_datname:string;holder_usename:string;holder_state:string;observed_at:string }
  type Reply=Awaited<ReturnType<typeof invoke>>
  type Outcome<T>={ok:true;value:T}|{ok:false;error:unknown}
  const reflect=<T>(promise:PromiseLike<T>):Promise<Outcome<T>>=>Promise.resolve(promise).then(value=>({ok:true,value} as const),error=>({ok:false,error} as const))
  const outcome=<T>(value:Outcome<T>):T=>{if(!value.ok)throw value.error;return value.value}
  const PREFIX='select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope'
  function signal<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return{promise,resolve}}
  async function before<T>(promise:Promise<T>,deadline:number):Promise<T>{
    const left=deadline-performance.now();assert(left>0,'Resource API original4s deadline expired')
    let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([promise,new Promise<never>((_yes,no)=>{timer=setTimeout(()=>no(new Error('Resource API original4s deadline expired')),left)})])}
    finally{if(timer!==undefined)clearTimeout(timer)}
  }
  async function ready<T>(phase:Promise<T>,tasks:Promise<Outcome<unknown>>[],deadline:number):Promise<T>{
    const value=await before(Promise.race([phase.then(value=>({kind:'ready' as const,value})),...tasks.map(task=>task.then(value=>({kind:'done' as const,value})))]),deadline)
    if(value.kind==='ready')return value.value
    if(!value.value.ok)throw value.value.error
    throw new Error('Resource API task completed before actual readiness')
  }
  async function identity(c:Queryable):Promise<PrefixIdentity>{
    const rows=(await c.query<PrefixIdentity>(`select pg_backend_pid() pid,current_database() database,current_user principal,txid_current()::text txid,
      a.backend_start::text backend_start,a.xact_start::text xact_start from pg_stat_activity a where a.pid=pg_backend_pid()`)).rows
    expect(rows).toHaveLength(1);const row=rows[0]!
    assert(Number.isSafeInteger(row.pid)&&row.pid>0&&row.backend_start&&row.xact_start&&/^[0-9]+$/.test(row.txid));return row
  }
  async function wholeFrame(c:Queryable=app.db!){
    const names=(await c.query<{tablename:string}>(`select tablename from pg_tables where schemaname='public' order by tablename collate "C"`)).rows.map(row=>row.tablename)
    expect(names).toHaveLength(124)
    const result:Record<string,string[]>={}
    for(const name of names){const quoted='"'+name.replaceAll('"','""')+'"';result[name]=(await c.query<{row:string}>(`select row_to_json(t)::text row from public.${quoted} t order by row_to_json(t)::text collate "C"`)).rows.map(row=>row.row)}
    return result
  }
  // Company-only counterpart of the reviewed HTTP prefix observer: no fictional
  // wedding ID and no replacement SQL/client/result/authentication are needed.
  async function companyRace(f:Fixture,door:string,change:string,commands:{label:string;start:()=>ReturnType<typeof invoke>}[],mutation:((c:Queryable)=>Promise<unknown>)|null,account?:string,captureWinner=false){
    assert(commands.length===1||commands.length===2)
    const db=app.db!,original=db.tx,invokeTx:Db['tx']=original.bind(db),heldReady=signal<PrefixIdentity>(),decision=signal<boolean>()
    const people=[...new Set([f.owner.userId,f.manager.userId,f.worker.userId])].sort()
    if(account)assert(people.includes(account),'Only an actual own fixture account may be invalidated')
    const tasks:Promise<Outcome<Reply>>[]=[],ended:(Outcome<Reply>|undefined)[]=[],workers:PrefixIdentity[]=[]
    const proofs:{holder:PrefixIdentity;workers:PrefixIdentity[];activity:PrefixActivity[];paths:number[][]}[]=[]
    let holderEnded:Outcome<void>|undefined,armed:ReturnType<typeof signal<PrefixIdentity>>|undefined,captures=0,installed=false,decided=false,mutationCompleted=false
    let winnerFrame:Awaited<ReturnType<typeof wholeFrame>>|undefined
    const release=(mutate:boolean)=>{if(!decided){decided=true;decision.resolve(mutate)}}
    const delegate:Db['tx']=<T>(body:(c:Queryable)=>Promise<T>):Promise<T>=>invokeTx(async c=>{
      const current=armed;assert(current,'Only the armed actual HTTP transaction may enter');armed=undefined
      const index=captures++;current.resolve(await identity(c));const result=await body(c)
      if(captureWinner&&index===0)winnerFrame=await wholeFrame(c)
      return result
    })
    const holder=reflect(invokeTx(async c=>{
      const h=await identity(c)
      // Invalidators prehold every account in strongest mode BEFORE any worker.
      // Pure same-key queues use write/SHARE, letting both requests reach the
      // exclusive vendor queue instead of inventing a compatible SHARE queue.
      const scope=await prepareLegacyCalendarScope(c,{vendorIds:[f.vendorId],personIds:people,mode:mutation?'erase':'write'})
      expect((await c.query<{id:string}>(`select id from users where id=any($1::uuid[]) order by id for ${mutation?'update':'share'}`,[people])).rows).toEqual(people.map(id=>({id})))
      expect((await c.query('select id from vendors where id=$1 for update',[f.vendorId])).rows).toEqual([{id:f.vendorId}])
      await scope.assertCurrent();heldReady.resolve(h)
      if(await decision.promise){if(mutation){await mutation(c);mutationCompleted=true}}
    })).then(value=>{holderEnded=value;return value})
    let observer:Promise<Outcome<Reply[]>>|undefined,failure:{error:unknown}|undefined,replies:Reply[]|undefined
    try{
      const h=await ready(heldReady.promise,[holder],performance.now()+4_000),deadline=performance.now()+4_000
      observer=reflect(invokeTx(async c=>{
        await c.query("set local statement_timeout='1000ms'")
        const o=await identity(c);assert.notEqual(o.pid,h.pid);assert.equal(o.database,h.database);assert.equal(o.principal,h.principal)
        db.tx=delegate;installed=true
        for(const command of commands){
          const current=signal<PrefixIdentity>();armed=current;const index=tasks.length
          const task=reflect(Promise.resolve().then(command.start)).then(value=>{ended[index]=value;return value});tasks.push(task)
          const w=await ready(current.promise,[holder,...tasks],deadline);workers.push(w)
          assert.equal(captures,workers.length);assert(![h.pid,o.pid,...workers.slice(0,-1).map(worker=>worker.pid)].includes(w.pid));assert.equal(w.database,h.database);assert.equal(w.principal,h.principal)
          let proof:typeof proofs[number]|undefined
          while(performance.now()<deadline){
            const early=holderEnded??ended.find(value=>value!==undefined)
            if(early){if(!early.ok)throw early.error;throw new Error('HTTP or holder finished before actual prefix wait')}
            await c.query('select pg_stat_clear_snapshot()')
            assert(performance.now()<deadline,'Original4s observer expired before actual SQL')
            const rows=(await c.query<PrefixActivity>('select w.pid,w.backend_start::text backend_start,w.xact_start::text xact_start,w.backend_xid::text backend_xid,w.datname,w.usename,w.state,w.wait_event_type,w.query,pg_blocking_pids(w.pid) blockers,'
              +'b.pid holder_pid,b.backend_start::text holder_backend_start,b.xact_start::text holder_xact_start,b.backend_xid::text holder_backend_xid,b.datname holder_datname,b.usename holder_usename,b.state holder_state,clock_timestamp()::text observed_at '
              +'from pg_stat_activity w join pg_stat_activity b on b.pid=$2 where w.datname=current_database() and w.pid=any($1::integer[]) order by w.pid',[workers.map(worker=>worker.pid),h.pid])).rows
            assert(performance.now()<deadline,'Actual observer exceeded original4s bound');expect(rows).toHaveLength(workers.length)
            for(const worker of workers){
              const row=rows.find(row=>row.pid===worker.pid);assert(row)
              assert.equal(row.backend_start,worker.backend_start);assert.equal(row.xact_start,worker.xact_start);assert.equal(row.backend_xid,(BigInt(worker.txid)%4294967296n).toString());assert.equal(row.datname,worker.database);assert.equal(row.usename,worker.principal)
              assert.equal(row.holder_pid,h.pid);assert.equal(row.holder_backend_start,h.backend_start);assert.equal(row.holder_xact_start,h.xact_start);assert.equal(row.holder_backend_xid,(BigInt(h.txid)%4294967296n).toString());assert.equal(row.holder_datname,h.database);assert.equal(row.holder_usename,h.principal)
            }
            const known=new Set([h.pid,...workers.map(worker=>worker.pid)])
            const closed=rows.every(row=>row.state==='active'&&row.wait_event_type==='Lock'&&row.holder_state==='idle in transaction'&&row.query.trim().replace(/\s+/g,' ')===PREFIX&&row.blockers.length>0&&row.blockers.every(pid=>known.has(pid)&&pid!==row.pid))
            const first=rows.find(row=>row.pid===workers[0]!.pid)!,paths=[[first.pid,h.pid]]
            let queued=closed&&first.blockers.includes(h.pid)
            if(workers.length===2){const second=rows.find(row=>row.pid===workers[1]!.pid)!;queued=queued&&second.blockers.includes(first.pid)&&!first.blockers.includes(second.pid);paths.push([second.pid,first.pid,h.pid])}
            if(queued){proof={holder:h,workers:[...workers],activity:rows,paths};break}
            await new Promise<void>(yes=>setTimeout(yes,Math.min(25,Math.max(1,deadline-performance.now()))))
          }
          assert(proof&&performance.now()<deadline,`Missing actual closed resource prefix wait ${door}/${change}`);proofs.push(proof)
          witnesses.push({door,change,holder:h.pid,waiter:w.pid,lock:proof.activity.find(row=>row.pid===w.pid)!.wait_event_type!})
          process.stdout.write('RESOURCE_API_NATIVE_PREFIX_WITNESS '+JSON.stringify({door,change,label:command.label,...proof,observer:o,phase:'before_invalidation'})+'\n')
        }
        release(true);outcome(await holder);expect(mutationCompleted).toBe(mutation!==null)
        const values:Reply[]=[];for(const task of tasks)values.push(outcome(await task));return values
      }))
      replies=outcome(await observer)
    }catch(error){failure={error}}finally{
      release(false)
      const results=await Promise.all([holder,...(observer?[observer]:[]),...tasks])
      const secondary=results.flatMap(value=>!value.ok&&value.error!==failure?.error?[value.error]:[])
      if(installed){if(db.tx!==delegate)secondary.push(new Error('Owned resource HTTP transaction observation changed'));db.tx=original}
      if(secondary.length)failure={error:new AggregateError(failure?[failure.error,...secondary]:secondary,'Resource HTTP race or drain failed',failure?{cause:failure.error}:undefined)}
    }
    if(failure)throw failure.error
    assert(replies);return{replies,proofs,mutationCommitted:mutationCompleted,winnerFrame}
  }
  async function waited(f:Fixture,door:string,change:string,request:()=>ReturnType<typeof invoke>,mutation:(c:Queryable)=>Promise<unknown>,account?:string){
    const result=await companyRace(f,door,change,[{label:door+'/'+change,start:request}],mutation,account)
    expect(result.mutationCommitted).toBe(true);expect(result.replies).toHaveLength(1);expect(result.proofs).toHaveLength(1)
    expect(result.proofs[0]!.paths).toEqual([[result.proofs[0]!.workers[0]!.pid,result.proofs[0]!.holder.pid]])
    return result.replies[0]!
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
    // Physical erasure changes native parent identities before cached ACL can
    // run. The queued attempt must refuse the changed epoch; a new SAME-key
    // request must still prove the original unavailable-person422 business rule.
    if(change==='erased'){
      deny(response,409);expect(response.json().error.code).toBe('calendar_scope_changed')
      expect(response.body).not.toContain(f.worker.userId);expect(await state(f)).toEqual(afterChange)
      const fresh=await invoke(f,cmd,f.owner,key)
      deny(fresh,422);expect(fresh.body).not.toContain(f.worker.userId);expect(await state(f)).toEqual(afterChange)
    }else{deny(response,422);expect(response.body).not.toContain(f.worker.userId);expect(await state(f)).toEqual(afterChange)}
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
    if(door==='create'||door==='window'){
      const race=await companyRace(f,door+':same_key','new_parent_epoch',[
        {label:'first same-key command',start:()=>invoke(f,cmd,f.manager,key)},
        {label:'second same-key command',start:()=>invoke(f,cmd,f.manager,key)},
      ],null,undefined,true)
      expect(race.mutationCommitted).toBe(false);expect(race.proofs).toHaveLength(2);expect(race.replies).toHaveLength(2)
      const [first,second]=race.replies
      expect(first!.statusCode,first!.body).toBe(200)
      deny(second!,409);expect(second!.json().error.code).toBe('calendar_scope_changed')
      assert(race.winnerFrame);expect(await wholeFrame()).toEqual(race.winnerFrame)
      const after=await state(f)
      expect(after[3]!.length-before[3]!.length).toBe(1);expect(after[4]!.length-before[4]!.length).toBe(1)
      if(door==='create')expect(after[0]!.length-before[0]!.length).toBe(1)
      if(door==='window')expect(after[1]!.length-before[1]!.length).toBe(1)
      expect(after.slice(5)).toEqual(before.slice(5))
      const fresh=await invoke(f,cmd,f.manager,key)
      expect(fresh.statusCode,fresh.body).toBe(200);expect(fresh.json()).toEqual(first!.json())
      expect(await state(f)).toEqual(after);expect(await wholeFrame()).toEqual(race.winnerFrame)
      return
    }
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
