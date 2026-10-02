import { disposablePgPort } from './disposablePgPort.js'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import { lockOrderContext, type OrderActor } from '../src/orders/context.js'
import { createResource, listResources, retireResource, createCapacityWindow, patchCapacityWindow, type CreateResourceInput, type CreateCapacityWindowInput } from '../src/resources/model.js'
import { getAvailabilityPolicy, setAvailabilityPolicy } from '../src/resources/policy.js'

const DB = process.env.TEST_DATABASE_URL
const START = '2027-06-14T10:00:00+03:00', END = '2027-06-14T11:00:00+03:00'
describe.skipIf(!DB)('actual resource identity, declared capacity and current authority', () => {
  let db: Db
  const users: string[] = [], vendors: string[] = [], resources: string[] = [], weddings: string[] = []
  const witnesses: { change: string; holder: number; waiter: number; lock: string }[] = []
  let sequence = 0; const phone = String(randomInt(100_000, 999_999))
  beforeAll(async () => {
    const target = new URL(DB!)
    assert(['postgres:', 'postgresql:'].includes(target.protocol)); assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    assert.equal(target.port, disposablePgPort()); assert.equal(target.username, 'codex_test')
    assert(['/tili_ecosystem_resources_20260930_test','/tili_ecosystem_full_20260930_test'].includes(target.pathname))
    assert.equal(target.search, ''); assert.equal(target.hash, '')
    db = createDb(DB!)
    expect((await db.query<{ name: string }>('select current_database() as name')).rows[0]!.name).toBe(target.pathname.slice(1))
  })
  afterAll(async () => {
    if (!db) return
    try {
      process.stdout.write(`RESOURCE_PG_LOCK_WITNESSES count=${witnesses.length} ${JSON.stringify(witnesses)}\n`)
      await db.query('delete from vendor_resources where id=any($1::uuid[])', [resources])
      for (const id of weddings) await db.query('delete from weddings where id=$1', [id])
      for (const id of vendors) await db.query('delete from vendors where id=$1', [id])
      for (const id of users) await db.query('delete from users where id=$1', [id])
    } finally { await db.close() }
  })
  async function actor(): Promise<OrderActor> {
    const userId = randomUUID(), sessionId = randomUUID(); users.push(userId)
    await db.query("insert into users(id,phone,name) values($1,$2,'Synthetic resource person')", [userId, `+79${phone}${String(++sequence).padStart(3,'0')}`])
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId,userId,randomUUID()])
    await db.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(),userId])
    return { userId,sessionId,policyVersion:'2026-09-02' }
  }
  async function member(vendorId: string, owner: OrderActor, role: 'worker'|'resource_manager' = 'worker', state: 'active'|'invited'|'declined'|'revoked' = 'active') {
    const person = await actor(), id = randomUUID()
    // Synthetic accepted DB history exercises current authority. This fixture
    // does not claim a person actually accepted an invitation in a browser.
    await db.query(`insert into vendor_staff_members(id,vendor_id,user_id,state,role,invite_token_hash,invite_expires_at,invited_by,accepted_at,accepted_session_id,revoked_at)
      values($1,$2,$3,$4,$5,$6,'2028-01-01T00:00:00Z',$7,case when $4 in ('active','revoked') then clock_timestamp() end,
        case when $4 in ('active','revoked') then $8::uuid end,case when $4='revoked' then clock_timestamp() end)`,
    [id,vendorId,person.userId,state,role,createHash('sha256').update(randomUUID()).digest('hex'),owner.userId,person.sessionId])
    return { person,id }
  }
  async function fixture() {
    const owner = await actor(), vendorId = randomUUID(); vendors.push(vendorId)
    await db.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'florist','Synthetic resource company',now())", [vendorId,owner.userId])
    const manager = await member(vendorId,owner,'resource_manager'), worker = await member(vendorId,owner)
    return { vendorId,owner,manager,worker }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const scope = (f: Fixture, actor = f.owner) => ({ vendorId:f.vendorId,actor })
  async function make(f: Fixture, extra: Partial<CreateResourceInput> = {}) {
    const r = await db.tx(c => createResource(c,{ ...scope(f),kind:'equipment',label:'Declared kit',...extra })); resources.push(r.id); return r
  }
  const read = (f: Fixture, actor = f.owner) => db.tx(c => listResources(c,scope(f,actor)))
  const policy = (f: Fixture) => db.tx(c => getAvailabilityPolicy(c,scope(f)))
  const window = (f: Fixture, resourceId: string, extra: Partial<CreateCapacityWindowInput> = {}) => db.tx(c => createCapacityWindow(c,{ ...scope(f),resourceId,startsAt:START,endsAt:END,capacity:3,...extra }))
  async function snapshot(f: Fixture) {
    const results = await Promise.all([
      db.query('select * from vendor_resources where vendor_id=$1 order by id',[f.vendorId]),
      db.query('select w.* from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id where r.vendor_id=$1 order by w.id',[f.vendorId]),
      db.query('select * from vendor_availability_policy where vendor_id=$1',[f.vendorId]),
      db.query('select * from audit_log where actor_id=any($1::uuid[]) order by id',[[f.owner.userId,f.manager.person.userId,f.worker.person.userId]]),
      db.query('select * from vendor_busy_dates where vendor_id=$1 order by date',[f.vendorId]),
      db.query('select * from deals where vendor_id=$1 order by id',[f.vendorId]),
      db.query('select p.* from payments p join deals d on d.id=p.deal_id where d.vendor_id=$1 order by p.id',[f.vendorId]),
    ]); return results.map(r => r.rows)
  }
  it('missing policy is conservative legacy_day, not inferred from florist category; same-mode no-op adds no row or audit', async () => {
    const f = await fixture(), before = await snapshot(f)
    expect(await policy(f)).toMatchObject({mode:'legacy_day',revision:'0',changedBy:null,changedAt:null,legacyObligations:{unresolved:false,reason:null}})
    expect(await db.tx(c => setAvailabilityPolicy(c,{...scope(f),mode:'legacy_day',expectedRevision:'0'}))).toEqual(await policy(f))
    expect(await snapshot(f)).toEqual(before); expect(await read(f)).toEqual([])
  })
  it('owner and current accepted manager can manage actual resources; DTO exposes no conflict key or unrelated client scope', async () => {
    const f = await fixture(), own = await make(f,{kind:'person',personUserId:f.owner.userId,label:'Owner person'})
    const employee = await make(f,{kind:'person',personUserId:f.worker.person.userId,staffMemberId:f.worker.id,label:'Accepted employee'})
    const capacity = await make(f,{kind:'capacity',capacityUnit:'deliveries per declared window',label:'Delivery capacity'})
    const managed = await db.tx(c => createResource(c,{...scope(f,f.manager.person),kind:'equipment',label:'Manager kit'})); resources.push(managed.id)
    const list = await read(f,f.manager.person); expect(list).toHaveLength(4)
    expect(own).toMatchObject({personUserId:f.owner.userId,staffMemberId:null,source:'current'})
    expect(employee).toMatchObject({personUserId:f.worker.person.userId,staffMemberId:f.worker.id,source:'current'})
    expect(capacity).toMatchObject({capacityUnit:'deliveries per declared window',windows:[]})
    for (const r of list) { expect(r).not.toHaveProperty('conflict_identity'); expect(r).not.toHaveProperty('weddingId'); expect(r).not.toHaveProperty('price') }
  })
  it.each(['worker','invited','declined','revoked','foreign'] as const)('%s is not current resource management permission', async mode => {
    const f = await fixture()
    const caller = mode==='worker' ? f.worker.person : mode==='foreign' ? await actor() : (await member(f.vendorId,f.owner,'resource_manager',mode)).person
    const before = await snapshot(f)
    await expect(db.tx(c => createResource(c,{...scope(f,caller),kind:'equipment',label:'Denied kit'}))).rejects.toMatchObject({statusCode:403})
    await expect(read(f,caller)).rejects.toMatchObject({statusCode:403}); expect(await snapshot(f)).toEqual(before)
  })
  it.each(['unrelated','foreign_member','invited','revoked','deleted'] as const)('person identity refuses %s source without invented staff acceptance', async mode => {
    const f = await fixture(), other = await fixture(), outsider = await actor()
    const target = mode==='foreign_member' ? other.worker : mode==='invited' || mode==='revoked' ? await member(f.vendorId,f.owner,'worker',mode) : {person:outsider,id:undefined}
    if(mode==='deleted') await db.query('update users set deleted_at=now() where id=$1',[target.person.userId])
    const before = await snapshot(f)
    await expect(make(f,{kind:'person',personUserId:target.person.userId,...(target.id ? {staffMemberId:target.id} : {})})).rejects.toMatchObject({statusCode:422})
    expect(await snapshot(f)).toEqual(before)
  })
  it.each([{kind:'capacity',capacityUnit:''},{kind:'capacity',capacityUnit:'   '},{kind:'capacity',capacityUnit:'x'.repeat(81)},
    {kind:'person'},{kind:'equipment',capacityUnit:'kits'},{kind:'capacity',personUserId:randomUUID(),capacityUnit:'deliveries'},{kind:'unknown'}] as const)('rejects invalid resource %#', async extra => {
    const f = await fixture(), before = await snapshot(f)
    await expect(make(f,extra as Partial<CreateResourceInput>)).rejects.toMatchObject({statusCode:422}); expect(await snapshot(f)).toEqual(before)
  })
  it('duplicate person identity includes retired history; retirement versions once and preserves windows and unknown source', async () => {
    const f = await fixture(), person = await make(f,{kind:'person',personUserId:f.owner.userId})
    await db.tx(c => retireResource(c,{...scope(f),resourceId:person.id,expectedVersion:'1'}))
    await expect(make(f,{kind:'person',personUserId:f.owner.userId})).rejects.toMatchObject({code:'resource_person_exists'})
    const capacity = await make(f,{kind:'capacity',capacityUnit:'deliveries'}), win = await window(f,capacity.id)
    const retired = await db.tx(c => retireResource(c,{...scope(f),resourceId:capacity.id,expectedVersion:'1'}))
    expect(retired).toMatchObject({version:'2',source:'unavailable',unavailableReason:'retired',windows:[win]})
    const before = await snapshot(f)
    expect(await db.tx(c => retireResource(c,{...scope(f),resourceId:capacity.id,expectedVersion:'2'}))).toEqual(retired)
    expect(await snapshot(f)).toEqual(before)
    await expect(db.tx(c => retireResource(c,{...scope(f),resourceId:capacity.id,expectedVersion:'1'}))).rejects.toMatchObject({code:'order_version_conflict'})
    await expect(window(f,capacity.id)).rejects.toMatchObject({code:'resource_retired'})
  })
  it('revoked and actually erased person sources remain unavailable; immutable internal identity is not DTO permission', async () => {
    const f = await fixture(), p = await make(f,{kind:'person',personUserId:f.worker.person.userId,staffMemberId:f.worker.id})
    const identity = (await db.query('select conflict_identity from vendor_resources where id=$1',[p.id])).rows[0]!.conflict_identity
    await db.query("update vendor_staff_members set state='revoked',revoked_at=now() where id=$1",[f.worker.id])
    expect((await read(f))[0]).toMatchObject({source:'unavailable',personUserId:null,staffMemberId:null,unavailableReason:'person_unavailable'})
    await db.query('delete from users where id=$1',[f.worker.person.userId])
    expect((await read(f))[0]).toMatchObject({source:'unavailable',personUserId:null,unavailableReason:'identity_unknown'})
    expect((await db.query('select conflict_identity,person_user_id from vendor_resources where id=$1',[p.id])).rows[0]).toEqual({conflict_identity:identity,person_user_id:null})
  })
  it('finite windows compare actual instants, permit adjacent [) windows and independent resources', async () => {
    const f = await fixture(), r = await make(f,{kind:'capacity',capacityUnit:'deliveries'}), other = await make(f,{kind:'capacity',capacityUnit:'cakes'})
    expect(await window(f,r.id)).toMatchObject({startsAt:'2027-06-14T07:00:00.000Z',endsAt:'2027-06-14T08:00:00.000Z',capacity:3,used:0,version:'1'})
    await window(f,r.id,{startsAt:'2027-06-14T08:00:00Z',endsAt:'2027-06-14T09:00:00Z'}); await window(f,other.id)
    await expect(window(f,r.id,{startsAt:'2027-06-14T07:30:00Z',endsAt:'2027-06-14T08:30:00Z'})).rejects.toMatchObject({code:'resource_window_overlap'})
  })
  it.each([{capacity:0},{capacity:1.5},{capacity:2_147_483_648},{startsAt:'infinity'},{startsAt:'2027-02-30T10:00:00Z'},
    {startsAt:'2027-06-14T10:00:00'},{endsAt:START},{endsAt:'2027-06-14T06:00:00Z'},{startsAt:'2027-06-14T10:00:00+14:01'}])('rejects invalid capacity window %#', async extra => {
    const f = await fixture(), r = await make(f,{kind:'capacity',capacityUnit:'explicit unit'}), before = await snapshot(f)
    await expect(window(f,r.id,extra)).rejects.toMatchObject({statusCode:422}); expect(await snapshot(f)).toEqual(before)
  })
  it('wrong resource kind and foreign company/window scope cannot change a window', async () => {
    const f = await fixture(), other = await fixture(), kit = await make(f), r = await make(other,{kind:'capacity',capacityUnit:'deliveries'}), win = await window(other,r.id)
    await expect(window(f,kit.id)).rejects.toMatchObject({statusCode:422})
    await expect(window(f,r.id)).rejects.toMatchObject({statusCode:404})
    await expect(db.tx(c => patchCapacityWindow(c,{...scope(f),resourceId:kit.id,windowId:win.id,expectedVersion:'1',capacity:2}))).rejects.toMatchObject({statusCode:422})
    const local = await make(f,{kind:'capacity',capacityUnit:'deliveries'}), before = await snapshot(other)
    await expect(db.tx(c => patchCapacityWindow(c,{...scope(f),resourceId:local.id,windowId:win.id,expectedVersion:'1',capacity:2}))).rejects.toMatchObject({statusCode:404})
    expect(await snapshot(other)).toEqual(before)
  })
  it('capacity patch is exact-version, no-op has no audit, and time/unit/identity cannot be patched', async () => {
    const f = await fixture(), r = await make(f,{kind:'capacity',capacityUnit:'deliveries'}), w = await window(f,r.id)
    const input = {...scope(f),resourceId:r.id,windowId:w.id,expectedVersion:'1',capacity:3}, before = await snapshot(f)
    expect(await db.tx(c => patchCapacityWindow(c,input))).toEqual(w); expect(await snapshot(f)).toEqual(before)
    const changed = await db.tx(c => patchCapacityWindow(c,{...input,capacity:5})); expect(changed).toMatchObject({capacity:5,version:'2'})
    await expect(db.tx(c => patchCapacityWindow(c,input))).rejects.toMatchObject({code:'order_version_conflict'})
    await expect(db.tx(c => patchCapacityWindow(c,{...input,expectedVersion:'2',startsAt:'2027-06-14T10:00:00Z'} as typeof input))).rejects.toMatchObject({statusCode:422})
    // Synthetic occupancy is solely a guard test; no actual reservation is claimed.
    await db.query('update resource_capacity_windows set used=4,legacy_used=4 where id=$1',[w.id])
    await expect(db.tx(c => patchCapacityWindow(c,{...input,expectedVersion:'2',capacity:3}))).rejects.toMatchObject({code:'resource_capacity_used'})
  })
  it('concurrent duplicate-person and overlapping-window commands produce exactly one accepted mutation each', async () => {
    const f = await fixture()
    const people = await Promise.allSettled([make(f,{kind:'person',personUserId:f.owner.userId}),make(f,{kind:'person',personUserId:f.owner.userId})])
    expect(people.filter(r=>r.status==='fulfilled')).toHaveLength(1); expect(people.filter(r=>r.status==='rejected')).toHaveLength(1)
    const r = await make(f,{kind:'capacity',capacityUnit:'deliveries'})
    const wins = await Promise.allSettled([window(f,r.id),window(f,r.id)])
    expect(wins.filter(r=>r.status==='fulfilled')).toHaveLength(1); expect((await read(f)).find(x=>x.id===r.id)!.windows).toHaveLength(1)
  })
  it('raw concurrent PostgreSQL inserts wait on the actual exclusion constraint and cannot both occupy the same window', async () => {
    const f=await fixture(), r=await make(f,{kind:'capacity',capacityUnit:'deliveries'})
    const sql='insert into resource_capacity_windows(id,resource_id,starts_at,ends_at,capacity) values($1,$2,$3,$4,1)'
    let ready!:()=>void,release!:()=>void,pid=0
    const start=new Promise<void>(resolve=>{ready=resolve}),finish=new Promise<void>(resolve=>{release=resolve})
    const holder=db.tx(async c=>{pid=(await c.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid
      await c.query(sql,[randomUUID(),r.id,START,END]);ready();await finish})
    await start;let done=false
    const second=db.query(sql,[randomUUID(),r.id,START,END]).then(value=>({value}),error=>({error})).finally(()=>{done=true})
    try {
      let observed:{pid:number;wait_event:string}|undefined;const deadline=Date.now()+3000
      while(!done&&Date.now()<deadline){observed=(await db.query<{pid:number;wait_event:string}>(`select pid,wait_event from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and query ilike '%insert into resource_capacity_windows%'`,[pid])).rows[0]
        if(observed)break;await new Promise(resolve=>setTimeout(resolve,10))}
      expect(observed,'No actual exclusion wait').toBeDefined();witnesses.push({change:'raw_exclusion',holder:pid,waiter:observed!.pid,lock:observed!.wait_event})
    }finally{release();await holder;await second}
    const result=await second;expect(result).toHaveProperty('error');if('error'in result)expect(result.error).toMatchObject({code:'23P01'})
    expect((await read(f))[0]!.windows).toHaveLength(1)
  })
  it('concurrent first policy selection and same-version capacity patches each have exactly one actual change',async()=>{
    const f=await fixture(),r=await make(f,{kind:'capacity',capacityUnit:'deliveries'}),w=await window(f,r.id)
    const selected=await Promise.allSettled([db.tx(c=>setAvailabilityPolicy(c,{...scope(f),mode:'resources',expectedRevision:'0'})),db.tx(c=>setAvailabilityPolicy(c,{...scope(f),mode:'resources',expectedRevision:'0'}))])
    expect(selected.filter(x=>x.status==='fulfilled')).toHaveLength(1)
    expect(selected.filter(x=>x.status==='rejected')).toHaveLength(1);expect(await policy(f)).toMatchObject({mode:'resources',revision:'1'})
    const changed=await Promise.allSettled([4,5].map(capacity=>db.tx(c=>patchCapacityWindow(c,{...scope(f),resourceId:r.id,windowId:w.id,expectedVersion:'1',capacity}))))
    expect(changed.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(changed.filter(x=>x.status==='rejected')).toHaveLength(1)
    expect((await read(f))[0]!.windows[0]!.version).toBe('2')
    expect((await db.query("select action from audit_log where actor_id=$1 and action in ('resource.policy_changed','resource.window_changed')",[f.owner.userId])).rows).toHaveLength(2)
  })
  it('accepted person identity is stable across companies while each company membership remains independently required',async()=>{
    const f=await fixture(),other=await fixture(),employee=f.worker.person,id=randomUUID()
    await db.query(`insert into vendor_staff_members(id,vendor_id,user_id,state,role,invite_token_hash,invite_expires_at,invited_by,accepted_at,accepted_session_id)
      values($1,$2,$3,'active','worker',$4,'2028-01-01T00:00:00Z',$5,now(),$6)`,[id,other.vendorId,employee.userId,createHash('sha256').update(randomUUID()).digest('hex'),other.owner.userId,employee.sessionId])
    const first=await make(f,{kind:'person',personUserId:employee.userId,staffMemberId:f.worker.id}),second=await make(other,{kind:'person',personUserId:employee.userId,staffMemberId:id})
    expect((await db.query('select conflict_identity from vendor_resources where id=any($1::uuid[]) order by id',[[first.id,second.id]])).rows).toEqual([{conflict_identity:employee.userId},{conflict_identity:employee.userId}])
    await db.query("update vendor_staff_members set state='revoked',revoked_at=now() where id=$1",[f.worker.id])
    expect((await read(f))[0]!.source).toBe('unavailable');expect((await read(other))[0]!.source).toBe('current')
    // Identity alone neither grants management nor reserves this person's time.
    await expect(read(other,employee)).rejects.toMatchObject({statusCode:403})
  })
  it('all domain doors refuse worker management without changing valid resource/window/policy history',async()=>{
    const f=await fixture(),r=await make(f,{kind:'capacity',capacityUnit:'deliveries'}),w=await window(f,r.id),s=scope(f,f.worker.person),before=await snapshot(f)
    const commands=[()=>db.tx(c=>listResources(c,s)),()=>db.tx(c=>getAvailabilityPolicy(c,s)),()=>db.tx(c=>createResource(c,{...s,kind:'equipment',label:'Denied'})),
      ()=>db.tx(c=>retireResource(c,{...s,resourceId:r.id,expectedVersion:'1'})),()=>db.tx(c=>createCapacityWindow(c,{...s,resourceId:r.id,startsAt:END,endsAt:'2027-06-14T12:00:00+03:00',capacity:2})),
      ()=>db.tx(c=>patchCapacityWindow(c,{...s,resourceId:r.id,windowId:w.id,expectedVersion:'1',capacity:4})),()=>db.tx(c=>setAvailabilityPolicy(c,{...s,mode:'resources',expectedRevision:'0'}))]
    for(const command of commands){await expect(command()).rejects.toMatchObject({statusCode:403});expect(await snapshot(f)).toEqual(before)}
  })
  it('actual company erasure preserves orphaned resource/windows but another company cannot read or revive them',async()=>{
    const f=await fixture(),other=await fixture(),r=await make(f,{kind:'capacity',capacityUnit:'deliveries'}),w=await window(f,r.id)
    await db.query('delete from vendors where id=$1',[f.vendorId])
    await expect(read(f)).rejects.toMatchObject({statusCode:404})
    expect(await read(other)).toEqual([])
    expect((await db.query('select vendor_id from vendor_resources where id=$1',[r.id])).rows[0]).toEqual({vendor_id:null})
    expect((await db.query('select id from resource_capacity_windows where resource_id=$1',[r.id])).rows).toEqual([{id:w.id}])
    await expect(db.query('update vendor_resources set vendor_id=$2 where id=$1',[r.id,other.vendorId])).rejects.toMatchObject({code:'23514'})
  })
  it('policy needs a live actual resource, versions changes and leaves manual/unknown/confirmed legacy finance untouched', async () => {
    const f = await fixture()
    await expect(db.tx(c => setAvailabilityPolicy(c,{...scope(f),mode:'resources',expectedRevision:'0'}))).rejects.toMatchObject({code:'resource_policy_empty'})
    const r = await make(f,{kind:'capacity',capacityUnit:'deliveries'})
    const couple = await actor(), weddingId=randomUUID(), slotId=randomUUID(), dealId=randomUUID(); weddings.push(weddingId)
    await db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic legacy obligation','2027-06-14','Europe/Moscow',$3)",[weddingId,couple.userId,randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[weddingId,couple.userId])
    await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'florist','Legacy flowers')",[slotId,weddingId])
    await db.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'booked',18000)",[dealId,weddingId,slotId,f.vendorId])
    await db.query('update slots set deal_id=$2 where id=$1',[slotId,dealId])
    await db.query("insert into payments(id,deal_id,kind,amount,status) values($1,$2,'deposit',3000,'recorded')",[randomUUID(),dealId])
    await db.query("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2),($1,'2027-06-15','manual',null),($1,'2027-06-16','deal',null)",[f.vendorId,dealId])
    const before = await snapshot(f), switched = await db.tx(c => setAvailabilityPolicy(c,{...scope(f),mode:'resources',expectedRevision:'0'}))
    expect(switched).toMatchObject({mode:'resources',revision:'1',legacyObligations:{unresolved:true,manualDays:1,dealDays:2,unknownDays:1,committedDeals:1,reason:'unresolved_legacy_obligations'}})
    expect(JSON.stringify(switched)).not.toContain(weddingId); expect(JSON.stringify(switched)).not.toContain(dealId)
    expect((await snapshot(f)).slice(4)).toEqual(before.slice(4)); expect((await read(f))[0]!.windows).toEqual([])
    await expect(db.tx(c=>lockOrderContext(c,weddingId,dealId,f.manager.person,false))).rejects.toMatchObject({statusCode:404})
    const unchanged = await snapshot(f); expect(await db.tx(c => setAvailabilityPolicy(c,{...scope(f),mode:'resources',expectedRevision:'1'}))).toEqual(switched); expect(await snapshot(f)).toEqual(unchanged)
    await expect(db.tx(c => setAvailabilityPolicy(c,{...scope(f),mode:'legacy_day',expectedRevision:'0'}))).rejects.toMatchObject({code:'order_version_conflict'})
    expect(await db.tx(c => setAvailabilityPolicy(c,{...scope(f),mode:'legacy_day',expectedRevision:'1'}))).toMatchObject({revision:'2',legacyObligations:{unresolved:true}})
    await db.tx(c => retireResource(c,{...scope(f),resourceId:r.id,expectedVersion:'1'}))
    await expect(db.tx(c => setAvailabilityPolicy(c,{...scope(f),mode:'resources',expectedRevision:'2'}))).rejects.toMatchObject({code:'resource_policy_empty'})
  })
  it('schema negative controls protect identities, units, actual company scope, finite capacity and overlap outside the domain', async () => {
    const f = await fixture(), other = await fixture(), r = await make(f,{kind:'capacity',capacityUnit:'deliveries'}), kit = await make(f), p = await make(f,{kind:'person',personUserId:f.owner.userId})
    const w = await window(f,r.id), before = await snapshot(f)
    const negatives: [string,unknown[],string][] = [
      ["update vendor_resources set kind='equipment' where id=$1",[r.id],'23514'],
      ["update vendor_resources set capacity_unit='cakes' where id=$1",[r.id],'23514'],
      ['update vendor_resources set person_user_id=$2 where id=$1',[p.id,other.owner.userId],'23514'],
      ['update vendor_resources set conflict_identity=$2 where id=$1',[kit.id,randomUUID()],'23514'],
      ['update vendor_resources set vendor_id=$2 where id=$1',[r.id,other.vendorId],'23514'],
      ['update resource_capacity_windows set resource_id=$2 where id=$1',[w.id,kit.id],'23514'],
      ["update resource_capacity_windows set starts_at='-infinity' where id=$1",[w.id],'23514'],
      ['update resource_capacity_windows set used=4 where id=$1',[w.id],'23514'],
      ['insert into resource_capacity_windows(id,resource_id,starts_at,ends_at,capacity) values($1,$2,$3,$4,1)',[randomUUID(),r.id,START,END],'23P01'],
      ["insert into vendor_resources(id,vendor_id,kind,label,person_user_id,conflict_identity,staff_member_id) values($1,$2,'person','Bad scoped person',$3,$3,$4)",[randomUUID(),f.vendorId,other.worker.person.userId,other.worker.id],'23514'],
    ]
    for(const [sql,values,code] of negatives) { await expect(db.query(sql,values)).rejects.toMatchObject({code}); expect(await snapshot(f)).toEqual(before) }
  })
  it('a real PostgreSQL audit constraint failure rolls back resource, window, retirement and policy mutations', async () => {
    const f = await fixture(), r = await make(f,{kind:'capacity',capacityUnit:'deliveries'}), w = await window(f,r.id)
    const name = `resource_audit_${randomUUID().replaceAll('-','')}`
    // Exact test actor only; NOT VALID leaves already recorded audit history.
    await db.query(`alter table audit_log add constraint ${name} check(actor_id is distinct from '${f.owner.userId}'::uuid or action not like 'resource.%') not valid`)
    try {
      const before = await snapshot(f)
      const commands = [() => make(f),() => window(f,r.id,{startsAt:END,endsAt:'2027-06-14T12:00:00+03:00'}),
        () => db.tx(c=>patchCapacityWindow(c,{...scope(f),resourceId:r.id,windowId:w.id,expectedVersion:'1',capacity:4})),
        () => db.tx(c=>retireResource(c,{...scope(f),resourceId:r.id,expectedVersion:'1'})),
        () => db.tx(c=>setAvailabilityPolicy(c,{...scope(f),mode:'resources',expectedRevision:'0'}))]
      for(const command of commands) { await expect(command()).rejects.toMatchObject({code:'23514',constraint:name}); expect(await snapshot(f)).toEqual(before) }
    } finally { await db.query(`alter table audit_log drop constraint ${name}`) }
  })

  async function waitMutation(f: Fixture, label: string, account: string | null, action: () => Promise<unknown>, mutation: (c: Queryable)=>Promise<unknown>) {
    let ready!:()=>void, release!:()=>void, pid=0
    const start=new Promise<void>(r=>{ready=r}), finish=new Promise<void>(r=>{release=r})
    const holder=db.tx(async c=>{ pid=(await c.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid
      if(account) await c.query('select id from users where id=$1 for update',[account])
      else await c.query('select id from vendors where id=$1 for update',[f.vendorId])
      ready(); await finish; await mutation(c)
    })
    await start; let done=false
    const result=action().then(value=>({value}),error=>({error})).finally(()=>{done=true})
    try {
      let observed:{pid:number;wait_event:string}|undefined; const deadline=Date.now()+3000
      while(!done && Date.now()<deadline){ observed=(await db.query<{pid:number;wait_event:string}>(`select pid,wait_event from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and query ilike $2`,[pid,account ? '%from users%' : '%from vendors%'])).rows[0]
        if(observed)break; await new Promise(r=>setTimeout(r,10)) }
      expect(observed,`No actual ${label} PG wait`).toBeDefined(); witnesses.push({change:label,holder:pid,waiter:observed!.pid,lock:observed!.wait_event})
    } finally {release();await holder;await result}
    return result
  }
  it.each(['member_revoked','member_deleted','role_worker','session_revoked','consent_withdrawn','actor_deleted','owner_deleted','vendor_blocked','owner_changed'] as const)('manager operation rechecks %s after witnessed first-account/company lock', async change=>{
    const f=await fixture(), nextOwner=await actor(), before=await snapshot(f)
    const account=change==='actor_deleted' ? f.manager.person.userId : change==='owner_deleted' ? f.owner.userId : null
    const result=await waitMutation(f,change,account,()=>make(f,{actor:f.manager.person}),async c=>{
      if(change==='member_revoked')return c.query("update vendor_staff_members set state='revoked',revoked_at=now() where id=$1",[f.manager.id])
      if(change==='member_deleted')return c.query('delete from vendor_staff_members where id=$1',[f.manager.id])
      if(change==='role_worker')return c.query("update vendor_staff_members set role='worker' where id=$1",[f.manager.id])
      if(change==='session_revoked')return c.query('update sessions set revoked_at=now() where id=$1',[f.manager.person.sessionId])
      if(change==='consent_withdrawn')return c.query('update consents set withdrawn_at=now() where user_id=$1',[f.manager.person.userId])
      if(change==='actor_deleted'||change==='owner_deleted')return c.query('update users set deleted_at=now() where id=$1',[account])
      if(change==='vendor_blocked')return c.query('update vendors set blocked_at=now() where id=$1',[f.vendorId])
      return c.query('update vendors set user_id=$2 where id=$1',[f.vendorId,nextOwner.userId])
    })
    expect(result).toHaveProperty('error')
    if('error' in result)expect(result.error).toMatchObject({statusCode:change==='owner_changed'?409:change==='actor_deleted'||change==='session_revoked'?401:change==='owner_deleted'||change==='vendor_blocked'?404:403})
    expect(await snapshot(f)).toEqual(before)
  })
  it('create-person locks the actual person account before company/resource and refuses erasure after waiting', async()=>{
    const f=await fixture(), before=await snapshot(f)
    const result=await waitMutation(f,'person_deleted',f.worker.person.userId,()=>make(f,{kind:'person',personUserId:f.worker.person.userId,staffMemberId:f.worker.id}),c=>c.query('update users set deleted_at=now() where id=$1',[f.worker.person.userId]))
    expect(result).toHaveProperty('error'); if('error' in result)expect(result.error).toMatchObject({statusCode:422}); expect(await snapshot(f)).toEqual(before)
  })
  it('create-person rechecks target accepted membership after company wait, independently of manager authority',async()=>{
    const f=await fixture(),before=await snapshot(f)
    const result=await waitMutation(f,'target_member_revoked',null,()=>make(f,{kind:'person',personUserId:f.worker.person.userId,staffMemberId:f.worker.id}),
      c=>c.query("update vendor_staff_members set state='revoked',revoked_at=now() where id=$1",[f.worker.id]))
    expect(result).toHaveProperty('error');if('error'in result)expect(result.error).toMatchObject({statusCode:422});expect(await snapshot(f)).toEqual(before)
  })
})
