// FR011: behavioral regression first observed RED on the published schema83/base.
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { ACCESS_TTL_SECONDS, signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import {eraseUser,purgeArchivedWeddings} from '../src/jobs/index.js'
import { disposablePgPort } from './disposablePgPort.js'
const DB=process.env.TEST_DATABASE_URL,SECRET='fr011-correction-test-only-'.repeat(3),money=(amount:number)=>({amount,currency:'RUB' as const})
describe.skipIf(!DB)('FR011 manual payment correction and accessible amendment history: real HTTP/PG',()=>{
 let app:FastifyInstance
 const weddings:string[]=[],users:string[]=[]
 beforeAll(async()=>{
  assert.equal(DB,process.env.DATABASE_URL);const url=new URL(DB!);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port,disposablePgPort());assert.equal(url.pathname,'/tili_ecosystem_full_20260930_test');assert.equal(url.search,'')
  app=await buildApp({env:'test',databaseUrl:DB!,redisUrl:null,jwtAccessSecret:SECRET,jwtRefreshSecret:'fr011-refresh-test-only-'.repeat(3),policyVersion:'2026-09-02'});await app.ready()
  const identity=(await app.db!.query('select current_database() name,inet_server_port() port')).rows[0];assert.equal(identity.name,'tili_ecosystem_full_20260930_test');assert.equal(identity.port,Number(disposablePgPort()))
 })
 afterAll(async()=>{if(!app)return;try{for(const id of weddings)await app.db!.query('delete from weddings where id=$1',[id]);for(const id of users)await app.db!.query('delete from users where id=$1',[id])}finally{await app.close()}})
 async function fixture(){
  let user:string|undefined;for(let attempt=0;attempt<8&&!user;attempt++)user=(await app.db!.query<{id:string}>("insert into users(id,phone,name) values($1,$2,'Synthetic FR011 couple') on conflict(phone) do nothing returning id",[randomUUID(),'+79'+randomInt(100000000,999999999)])).rows[0]?.id
  assert(user);users.push(user);const session=randomUUID(),wedding=randomUUID(),slot=randomUUID(),deal=randomUUID();weddings.push(wedding)
  await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',[session,user,randomUUID()]);await app.db!.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)",[randomUUID(),user])
  await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code,budget_total) values($1,$2,'Synthetic FR011','2027-06-14','Europe/Moscow',$3,5000000)",[wedding,user,randomUUID()]);await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[wedding,user])
  await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Фотограф')",[slot,wedding]);await app.db!.query("insert into deals(id,wedding_id,slot_id,external_name,state,price,booked_at) values($1,$2,$3,'Synthetic photographer','booked',1000000,now())",[deal,wedding,slot]);await app.db!.query('update slots set deal_id=$2 where id=$1',[slot,deal])
  const token=await signAccessToken(SECRET,{sub:user,sid:session}),headers={authorization:'Bearer '+token,'idempotency-key':randomUUID()}
  const created=await app.inject({method:'POST',url:`/weddings/${wedding}/payment-schedule`,headers,payload:{dealId:deal,title:'Аванс',due:'2027-05-01',amount:money(400000)}});expect(created.statusCode,created.body).toBe(201);const stage=created.json().id as string
  const paid=await app.inject({method:'POST',url:`/weddings/${wedding}/payment-schedule/${stage}/pay`,headers:{...headers,'idempotency-key':randomUUID()},payload:{version:1,amount:money(100000),amountKnown:true,paymentMethod:'cash',paidOn:'2026-10-01'}});expect(paid.statusCode,paid.body).toBe(200)
  const result=await app.inject({url:`/weddings/${wedding}/payment-schedule?from=2027-01-01&to=2027-12-31`,headers});expect(result.statusCode,result.body).toBe(200);const data=result.json();expect(data.payments).toHaveLength(1);expect(data.summary.recorded).toEqual(money(100000))
  return {user,session,wedding,slot,deal,stage,headers,payment:data.payments[0] as {id:string;version:number},stageVersion:data.items[0].version as number}
 }
 it('corrects a partial mark in place, reloads the amount and preserves an accessible actual before/after',async()=>{
  const f=await fixture(),res=await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payments/${f.payment.id}`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version:f.payment.version,amountKnown:true,amount:money(125000),paymentMethod:'bank_transfer',paidOn:'2026-10-02',reason:'Исправлена сумма ручной отметки'}})
  expect(res.statusCode,res.body).toBe(200);expect(res.json()).toMatchObject({id:f.payment.id,version:2,amount:money(125000),paymentMethod:'bank_transfer',paidOn:'2026-10-02',status:'recorded'})
  const reread=await app.inject({url:`/weddings/${f.wedding}/payment-schedule?from=2027-01-01&to=2027-12-31`,headers:f.headers});expect(reread.statusCode,reread.body).toBe(200);expect(reread.json().payments).toHaveLength(1);expect(reread.json().summary).toMatchObject({recorded:money(125000),remaining:money(875000)});expect(reread.json().items[0]).toMatchObject({paid:money(125000),remaining:money(275000)})
  const history=await app.inject({url:`/weddings/${f.wedding}/payments/${f.payment.id}/history`,headers:f.headers});expect(history.statusCode,history.body).toBe(200);expect(history.json().items).toHaveLength(1);expect(history.json().items[0]).toMatchObject({paymentId:f.payment.id,beforeVersion:1,afterVersion:2,reason:'Исправлена сумма ручной отметки',actor:{id:f.user},before:{amount:money(100000),paymentMethod:'cash',paidOn:'2026-10-01'},after:{amount:money(125000),paymentMethod:'bank_transfer',paidOn:'2026-10-02'}})
 })
 it('date-only correction advances the shared payment version once without altering stage arithmetic',async()=>{
  const f=await fixture(),res=await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payments/${f.payment.id}`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version:1,amountKnown:true,amount:money(100000),paymentMethod:'cash',paidOn:'2026-10-03',reason:'Исправлена дата'}})
  expect(res.statusCode,res.body).toBe(200);expect(res.json()).toMatchObject({id:f.payment.id,version:2,paidOn:'2026-10-03',amount:money(100000)})
  const db=(await app.db!.query('select plan_version,(select version from payment_installments where id=$2) stage_version from payments where id=$1',[f.payment.id,f.stage])).rows[0];expect(db).toEqual({plan_version:2,stage_version:f.stageVersion})
 })
 it('existing stage edits expose real title/amount/due revisions rather than only the current row',async()=>{
  const f=await fixture(),edit=await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payment-schedule/${f.stage}`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version:f.stageVersion,title:'Первый платёж',due:'2027-05-02',amount:money(450000)}});expect(edit.statusCode,edit.body).toBe(200)
  const history=await app.inject({url:`/weddings/${f.wedding}/payment-schedule/${f.stage}/history`,headers:f.headers});expect(history.statusCode,history.body).toBe(200);expect(history.json().items).toHaveLength(1);expect(history.json().items[0]).toMatchObject({installmentId:f.stage,beforeVersion:f.stageVersion,afterVersion:f.stageVersion+1,actor:{id:f.user},before:{title:'Аванс',due:'2027-05-01',amount:money(400000)},after:{title:'Первый платёж',due:'2027-05-02',amount:money(450000)}})
 })
 const correction=(overrides:Record<string,unknown>={})=>({version:1,amountKnown:true,amount:money(125000),paymentMethod:'bank_transfer',paidOn:'2026-10-02',reason:'Уточнение ручной отметки',...overrides})
 const patch=(f:Awaited<ReturnType<typeof fixture>>,payload:Record<string,unknown>,key=randomUUID())=>app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payments/${f.payment.id}`,headers:{...f.headers,'idempotency-key':key},payload})
 const paymentRow=async(id:string)=>(await app.db!.query('select to_jsonb(p)::text as value from payments p where id=$1',[id])).rows[0].value
 const history=async(f:Awaited<ReturnType<typeof fixture>>)=>(await app.inject({url:`/weddings/${f.wedding}/payments/${f.payment.id}/history`,headers:f.headers})).json()
 it('known/unknown corrections retain NULL, identity, receipts and committed state while account export includes actual edits',async()=>{
  const f=await fixture(),receipt=randomUUID(),bytes=Buffer.from('%PDF-1.4')
  await app.db!.query("insert into payment_receipts(id,wedding_id,payment_id,filename,mime_type,size_bytes,content,uploaded_by) values($1,$2,$3,'synthetic.pdf','application/pdf',$4,$5,$6)",[receipt,f.wedding,f.payment.id,bytes.length,bytes,f.user])
  const receiptBefore=(await app.db!.query('select to_jsonb(r)::text value from payment_receipts r where id=$1',[receipt])).rows[0].value
  const unknown=await patch(f,correction({amountKnown:false,amount:null}));expect(unknown.statusCode,unknown.body).toBe(200);expect(unknown.json()).toMatchObject({id:f.payment.id,version:2,amountKnown:false,amount:null})
  const schedule=await app.inject({url:`/weddings/${f.wedding}/payment-schedule?from=2027-01-01&to=2027-12-31`,headers:f.headers});expect(schedule.statusCode,schedule.body).toBe(200);expect(schedule.json().summary).toMatchObject({recorded:money(0),remaining:money(1000000),amountIncomplete:true,unknownAmountPayments:1});expect(schedule.json().items[0]).toMatchObject({paid:money(0),unknownAmountPayments:1})
  expect((await app.db!.query('select state,price::text from deals where id=$1',[f.deal])).rows[0]).toEqual({state:'paid_deposit',price:'1000000'})
  const restored=await patch(f,correction({version:2,amount:money(75000)}));expect(restored.statusCode,restored.body).toBe(200);expect(restored.json()).toMatchObject({id:f.payment.id,version:3,amountKnown:true,amount:money(75000)})
  expect((await history(f)).items).toHaveLength(2)
  expect((await app.db!.query('select to_jsonb(r)::text value from payment_receipts r where id=$1',[receipt])).rows[0].value).toBe(receiptBefore)
  const exported=await app.inject({url:'/users/me/export',headers:f.headers});expect(exported.statusCode,exported.body).toBe(200);expect(exported.json().paymentCorrections).toHaveLength(2);expect(exported.json().paymentCorrections[0]).toMatchObject({payment_id:f.payment.id,before_amount:'100000',after_amount:null});expect(exported.json().paymentCorrections[0]).not.toHaveProperty('session_id');expect(exported.json().paymentCorrections[0]).not.toHaveProperty('provider_ref')
 })
 it('exact retry retains operation identity but rereads the current authorized payment; no-op and stale never add history',async()=>{
  const f=await fixture(),body=correction(),key=randomUUID(),first=await patch(f,body,key);expect(first.statusCode,first.body).toBe(200);expect(first.json().amendmentId).toBeTruthy()
  const second=await patch(f,correction({version:2,amount:money(140000)}));expect(second.statusCode,second.body).toBe(200)
  const replay=await patch(f,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.headers['idempotent-replay']).toBe('true');expect(replay.json()).toMatchObject({version:3,amount:money(140000),amendmentId:first.json().amendmentId})
  const before=await paymentRow(f.payment.id),noop=await patch(f,correction({version:3,amount:money(140000),reason:'Без нового изменения'}));expect(noop.statusCode,noop.body).toBe(200);expect(noop.json().amendmentId).toBeNull();expect(await paymentRow(f.payment.id)).toBe(before);expect((await history(f)).items).toHaveLength(2)
  const reused=await patch(f,correction({amount:money(150000)}),key);expect(reused.statusCode).toBe(409);expect(reused.json().error.code).toBe('idempotency_key_reused')
  const stale=await patch(f,body);expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('stale_payment_plan');expect((await history(f)).items).toHaveLength(2)
 })
 it.each([[1100000,'payment_over_price'],[450000,'installment_overpay']] as const)('rejects projected amount %i with %s and rolls back the claim',async(amount,code)=>{
  const f=await fixture(),before=await paymentRow(f.payment.id),key=randomUUID(),res=await patch(f,correction({amount:money(amount)}),key)
  expect(res.statusCode,res.body).toBe(409);expect(res.json().error.code).toBe(code);expect(await paymentRow(f.payment.id)).toBe(before);expect((await history(f)).items).toHaveLength(0);expect((await app.db!.query('select 1 from idempotency_keys where key=$1',[`${f.user}:payments.correct:${key}`])).rowCount).toBe(0)
 })
 it('retains signed refunds: a reduction below net zero refuses, metadata-only leaves legacy totals intact',async()=>{
  const f=await fixture();await app.db!.query("insert into payments(id,deal_id,kind,amount,currency,status,amount_known,paid_on) values($1,$2,'refund',80000,'RUB','recorded',true,'2026-10-02')",[randomUUID(),f.deal])
  const before=await paymentRow(f.payment.id),res=await patch(f,correction({amount:money(10000)}));expect(res.statusCode,res.body).toBe(409);expect(res.json().error.code).toBe('payment_over_price');expect(await paymentRow(f.payment.id)).toBe(before)
  const metadata=await patch(f,correction({amount:money(100000)}));expect(metadata.statusCode,metadata.body).toBe(200)
  expect((await app.db!.query("select sum(case when kind='refund' then -amount else amount end)::text paid from payments where deal_id=$1 and status<>'cancelled'",[f.deal])).rows[0].paid).toBe('20000')
 })
 it.each([
  {version:'1'},{amountKnown:'true'},{amount:{amount:'125000',currency:'RUB'}},{amountKnown:false,amount:money(125000)},
  {amountKnown:true,amount:null},{amount:money(0)},{paidOn:20261002},{paidOn:'2026-02-30'},{paymentMethod:1},{reason:123},{reason:'   '},{visibility:'vendor'},
 ])('rejects raw unintended types/tuple %j without mutation',async(overrides)=>{
  const f=await fixture(),before=await paymentRow(f.payment.id),res=await patch(f,correction(overrides));expect(res.statusCode,res.body).toBeGreaterThanOrEqual(400);expect(res.statusCode).toBeLessThan(500);expect(await paymentRow(f.payment.id)).toBe(before);expect((await history(f)).items).toHaveLength(0)
 })
 it.each(['confirmed','cancelled','provider','refund'] as const)('declines correction eligibility for %s without changing the old mark',async(mode)=>{
  const f=await fixture()
  if(mode==='provider')await app.db!.query("update payments set provider_ref='synthetic-provider-reference' where id=$1",[f.payment.id])
  else if(mode==='refund'){await app.db!.query('update payments set installment_id=null where id=$1',[f.payment.id]);await app.db!.query("update payments set kind='refund' where id=$1",[f.payment.id])}
  else await app.db!.query('update payments set status=$2 where id=$1',[f.payment.id,mode])
  const version=(await app.db!.query('select plan_version from payments where id=$1',[f.payment.id])).rows[0].plan_version,before=await paymentRow(f.payment.id),res=await patch(f,correction({version}))
  expect(res.statusCode,res.body).toBe(409);expect(res.json().error.code).toBe('payment_not_correctable');expect(await paymentRow(f.payment.id)).toBe(before);expect((await history(f)).items).toHaveLength(0)
  const q=await app.inject({url:`/weddings/${f.wedding}/payment-schedule`,headers:f.headers});expect(q.statusCode,q.body).toBe(200);expect(q.json().payments[0].canCorrect).toBe(false)
 })
 it('native currency guard refuses non-RUB without inventing a legacy row or disabling constraints',async()=>{
  const f=await fixture(),before=await paymentRow(f.payment.id)
  await assert.rejects(app.db!.query("update payments set currency='USD' where id=$1",[f.payment.id]),(e:unknown)=>{
    const error=e as {code:string;constraint:string};return error.code==='23514'&&error.constraint==='payments_currency_rub'
  })
  expect(await paymentRow(f.payment.id)).toBe(before);expect((await history(f)).items).toHaveLength(0)
 })
 it('cancelled wedding history remains readable, but writer/replay response requires the current couple',async()=>{
  const f=await fixture(),body=correction(),key=randomUUID();expect((await patch(f,body,key)).statusCode).toBe(200)
  await app.db!.query('update weddings set cancelled_at=now() where id=$1',[f.wedding]);const read=await app.inject({url:`/weddings/${f.wedding}/payments/${f.payment.id}/history`,headers:f.headers});expect(read.statusCode,read.body).toBe(200);expect(read.json().items).toHaveLength(1)
  const denied=await patch(f,correction({version:2,amount:money(140000)}));expect(denied.statusCode).toBe(409);expect(denied.json().error.code).toBe('wedding_cancelled')
  await app.db!.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2",[f.wedding,f.user])
  const replay=await patch(f,body,key);expect(replay.statusCode).toBe(403)
  const closed=await app.inject({url:`/weddings/${f.wedding}/payments/${f.payment.id}/history`,headers:f.headers});expect(closed.statusCode).toBe(403)
  const exported=await app.inject({url:'/users/me/export',headers:f.headers});expect(exported.statusCode,exported.body).toBe(200);expect(exported.json().paymentCorrections).toEqual([])
 })
 it('bounds version increments; metadata-only does not consume a linked max stage version',async()=>{
  const f=await fixture();await app.db!.query('update payment_installments set version=2147483647 where id=$1',[f.stage])
  const metadata=await patch(f,correction({amount:money(100000)}));expect(metadata.statusCode,metadata.body).toBe(200)
  const monetary=await patch(f,correction({version:2,amount:money(120000)}));expect(monetary.statusCode,monetary.body).toBe(409);expect(monetary.json().error.code).toBe('payment_version_exhausted')
  await app.db!.query('update payments set plan_version=2147483647 where id=$1',[f.payment.id]);const before=await paymentRow(f.payment.id),exhausted=await patch(f,correction({version:2147483647,paidOn:'2026-10-03',amount:money(100000)}));expect(exhausted.statusCode,exhausted.body).toBe(409);expect(exhausted.json().error.code).toBe('payment_version_exhausted');expect(await paymentRow(f.payment.id)).toBe(before)
 })
 it('stage same-value PATCH keeps prior version semantics without fake history; cancellation records actual before/after',async()=>{
  const f=await fixture(),url=`/weddings/${f.wedding}/payment-schedule/${f.stage}`
  const same=await app.inject({method:'PATCH',url,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version:f.stageVersion,title:'Аванс'}});expect(same.statusCode,same.body).toBe(200);expect(same.json().version).toBe(f.stageVersion+1)
  const empty=await app.inject({url:url+'/history',headers:f.headers});expect(empty.statusCode,empty.body).toBe(200);expect(empty.json().items).toHaveLength(0)
  const cancelled=await app.inject({method:'PATCH',url,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version:f.stageVersion+1,cancelled:true,reason:'Этап больше не нужен'}});expect(cancelled.statusCode,cancelled.body).toBe(200)
  const events=await app.inject({url:url+'/history',headers:f.headers});expect(events.statusCode,events.body).toBe(200);expect(events.json().items).toHaveLength(1);expect(events.json().items[0]).toMatchObject({beforeVersion:f.stageVersion+1,afterVersion:f.stageVersion+2,before:{cancelledAt:null,cancelReason:null},after:{cancelReason:'Этап больше не нужен'}});expect(events.json().items[0].after.cancelledAt).toBeTruthy()
  const exact=(await app.db!.query('select h.after_cancelled_at=p.cancelled_at exact from payment_installment_edits h join payment_installments p on p.id=h.installment_id where p.id=$1',[f.stage])).rows[0];expect(exact.exact).toBe(true)
 })
 it('account export retains revisions while exposing only the requesting actor identity',async()=>{
  const owner=await fixture(),partner=await fixture()
  await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[owner.wedding,partner.user])
  const other={...owner,headers:partner.headers},res=await patch(other,correction());expect(res.statusCode,res.body).toBe(200)
  const read=await history(owner);expect(read.items[0].actor).toMatchObject({id:partner.user,kind:'partner'})
  const foreign=await app.inject({url:'/users/me/export',headers:owner.headers});expect(foreign.statusCode,foreign.body).toBe(200)
  expect(foreign.json().paymentCorrections[0]).toMatchObject({actor_id:null,actor_name:null,payment_id:owner.payment.id,reason:'Уточнение ручной отметки'})
  expect(JSON.stringify(foreign.json().paymentCorrections)).not.toContain(partner.user)
  const self=await app.inject({url:'/users/me/export',headers:partner.headers});expect(self.statusCode,self.body).toBe(200);expect(self.json().paymentCorrections[0].actor_id).toBe(partner.user)
 })
 it.each(['payment','old-stage','new-stage'] as const)('real plan link refuses exhausted %s with controlled409 and no effect',async(boundary)=>{
  const f=await fixture(),target=randomUUID();await app.db!.query("insert into payment_installments(id,deal_id,title,amount,due) values($1,$2,'Second stage',400000,'2027-05-02')",[target,f.deal])
  if(boundary==='payment')await app.db!.query('update payments set plan_version=2147483647 where id=$1',[f.payment.id])
  else await app.db!.query('update payment_installments set version=2147483647 where id=$1',[boundary==='old-stage'?f.stage:target])
  const before=await paymentRow(f.payment.id),version=boundary==='payment'?2147483647:1
  const res=await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payments/${f.payment.id}/plan`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version,installmentId:target}})
  expect(res.statusCode,res.body).toBe(409);expect(res.json().error.code).toBe('payment_version_exhausted');expect(await paymentRow(f.payment.id)).toBe(before)
  const same=await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payments/${f.payment.id}/plan`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version,installmentId:f.stage}})
  expect(same.statusCode,same.body).toBe(200);expect(await paymentRow(f.payment.id)).toBe(before)
 })
 it('concurrent link and correction serialize on their shared payment version',async()=>{
  const f=await fixture(),responses=await Promise.all([patch(f,correction()),app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payments/${f.payment.id}/plan`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version:1,installmentId:null}})])
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);expect(responses.find(r=>r.statusCode===409)!.json().error.code).toBe('stale_payment_plan')
  const row=(await app.db!.query('select plan_version,amount::text,installment_id from payments where id=$1',[f.payment.id])).rows[0]
  expect(row.plan_version).toBe(2);const expected=row.installment_id===null?'100000':'125000'
  expect(row.amount).toBe(expected);expect((await history(f)).items).toHaveLength(row.installment_id===null?0:1)
 })
 it('concurrent existing slot-pay and correction cannot exceed the deal price',async()=>{
  const f=await fixture();await app.db!.query('update payment_installments set amount=1000000 where id=$1',[f.stage])
  const responses=await Promise.all([patch(f,correction({amount:money(900000)})),app.inject({method:'POST',url:`/weddings/${f.wedding}/slots/${f.slot}/pay`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{amount:money(800000)}})])
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409])
  const total=(await app.db!.query("select sum(case when kind='refund' then -coalesce(amount,0) else coalesce(amount,0) end)::text paid from payments where deal_id=$1 and status<>'cancelled'",[f.deal])).rows[0].paid;expect(total).toBe('900000')
 })
 it('post-COMMIT role revoke withholds the response and preserves the successful receipt for an exact authorized replay',async()=>{
  const f=await fixture(),key=randomUUID(),body=correction(),realTx=app.db!.tx.bind(app.db!)
  const hook=vi.spyOn(app.db!,'tx').mockImplementationOnce(async action=>{const result=await realTx(action);await app.db!.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2",[f.wedding,f.user]);return result})
  try{const res=await patch(f,body,key);expect(res.statusCode,res.body).toBe(403);expect(res.body).not.toContain('Уточнение ручной отметки')}finally{hook.mockRestore()}
  expect((await app.db!.query('select plan_version from payments where id=$1',[f.payment.id])).rows[0].plan_version).toBe(2)
  expect((await app.db!.query('select status from idempotency_keys where key=$1',[`${f.user}:payments.correct:${key}`])).rows[0].status).toBe(200)
  await app.db!.query("update wedding_members set role='couple' where wedding_id=$1 and user_id=$2",[f.wedding,f.user])
  const replay=await patch(f,body,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.headers['idempotent-replay']).toBe('true');expect((await history(f)).items).toHaveLength(1)
 })
 it.each(['session','consent'] as const)('a current %s revoke blocks history, writer and saved replay',async(boundary)=>{
  const f=await fixture(),key=randomUUID(),body=correction();expect((await patch(f,body,key)).statusCode).toBe(200);const before=await paymentRow(f.payment.id)
  if(boundary==='session')await app.db!.query('update sessions set revoked_at=now() where id=$1',[f.session]);else await app.db!.query('update consents set withdrawn_at=now() where user_id=$1',[f.user])
  for(const res of [await patch(f,body,key),await app.inject({url:`/weddings/${f.wedding}/payments/${f.payment.id}/history`,headers:f.headers})]){expect(res.statusCode,res.body).toBe(boundary==='session'?401:403);expect(res.body).not.toContain('Уточнение ручной отметки')}
  expect(await paymentRow(f.payment.id)).toBe(before)
 })
 it.each(['history','audit','receipt','missing-receipt'] as const)('real transaction rolls back payment/history/audit/key on %s failure',async(boundary)=>{
  const f=await fixture(),key=randomUUID(),before=await paymentRow(f.payment.id),realTx=app.db!.tx.bind(app.db!)
  const auditBefore=(await app.db!.query("select count(*)::int n from audit_log where entity_id=$1 and action='payment.corrected'",[f.payment.id])).rows[0].n
  const hook=vi.spyOn(app.db!,'tx').mockImplementationOnce(action=>realTx(async tx=>{
   const wrapped:Queryable={query:async<T extends pg.QueryResultRow=pg.QueryResultRow>(sql:string,values?:readonly unknown[])=>{
    const matches=boundary==='history'?sql.startsWith('insert into payment_corrections'):boundary==='audit'?sql.includes('insert into audit_log'):sql==='update idempotency_keys set status=200,body=$2 where key=$1 and status is null'
    if(!matches)return tx.query<T>(sql,values)
    if(boundary==='missing-receipt'){const result=await tx.query<T>(sql,values);return {...result,rowCount:0}}
    await tx.query('select 1/0');throw new Error('unreachable')
   }}
   return action(wrapped)
  }))
  try{const res=await patch(f,correction(),key);expect(res.statusCode,res.body).toBe(500);if(boundary==='missing-receipt')expect(res.json().error.code).toBe('payment_receipt_missing')}finally{hook.mockRestore()}
  expect(await paymentRow(f.payment.id)).toBe(before);expect((await history(f)).items).toHaveLength(0)
  expect((await app.db!.query("select count(*)::int n from audit_log where entity_id=$1 and action='payment.corrected'",[f.payment.id])).rows[0].n).toBe(auditBefore)
  expect((await app.db!.query('select 1 from idempotency_keys where key=$1',[`${f.user}:payments.correct:${key}`])).rowCount).toBe(0)
 })
 it.each(['deal','claim','replay','receipt'] as const)('JWT expiry during actual %s wait does not commit an expired correction',async(boundary)=>{
  const f=await fixture(),key=randomUUID(),body=correction(),storedKey=`${f.user}:payments.correct:${key}`
  if(boundary==='replay')expect((await patch(f,body,key)).statusCode).toBe(200)
  const gateName='fr011_receipt_'+randomUUID().replace(/-/g,''),gateKey=randomInt(1,2000000000)
  if(boundary==='receipt'){
   await app.db!.query(`create function ${gateName}() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${gateKey}); return new; end $$`)
   await app.db!.query(`create trigger ${gateName} before update on idempotency_keys for each row when (old.key='${storedKey}') execute function ${gateName}()`)
  }
  const before=await paymentRow(f.payment.id),expires=Math.floor(Date.now()/1000)+4
  f.headers.authorization='Bearer '+await signAccessToken(SECRET,{sub:f.user,sid:f.session},(expires-ACCESS_TTL_SECONDS)*1000)
  let pending:ReturnType<typeof patch>|undefined
  try{await app.db!.tx(async blocker=>{
   const pid=(await blocker.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid
   if(boundary==='deal')await blocker.query('select id from deals where id=$1 for update',[f.deal])
   else if(boundary==='replay')await blocker.query('select key from idempotency_keys where key=$1 for update',[storedKey])
   else if(boundary==='claim')await blocker.query('insert into idempotency_keys(key,user_id,route,request_hash,status,body) values($1,$2,$3,$4,200,$5::jsonb)',[storedKey,f.user,'payments.correct','synthetic-blocker','{}'])
   else await blocker.query('select pg_advisory_xact_lock($1)',[gateKey])
   pending=patch(f,body,key)
   const deadline=Date.now()+2500;let blocked=false
   while(Date.now()<deadline){blocked=Boolean((await app.db!.query('select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount);if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20))}
   expect(blocked,'observe actual PostgreSQL lock wait').toBe(true)
   while(Date.now()<expires*1000+20)await new Promise(resolve=>setTimeout(resolve,20))
   if(boundary==='claim')await blocker.query('delete from idempotency_keys where key=$1',[storedKey])
  })
  const res=await pending!;expect(res.statusCode,res.body).toBe(401);expect(res.json().error.code).toBe('token_expired');expect(await paymentRow(f.payment.id)).toBe(before)
  if(boundary!=='replay')expect((await app.db!.query('select 1 from idempotency_keys where key=$1',[storedKey])).rowCount).toBe(0)
  }finally{if(pending)await pending;if(boundary==='receipt'){await app.db!.query(`drop trigger ${gateName} on idempotency_keys`);await app.db!.query(`drop function ${gateName}()`)}}
 },10000)
 it('new writer and both histories enforce actual role/scope; forbidden callers cannot add amendments',async()=>{
  const f=await fixture(),other=await fixture(),paths=[`/weddings/${f.wedding}/payments/${f.payment.id}/history`,`/weddings/${f.wedding}/payment-schedule/${f.stage}/history`]
  const calls=async(headers:Record<string,string>)=>[await patch({...f,headers},correction()),...await Promise.all(paths.map(url=>app.inject({url,headers}))),await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payment-schedule/${f.stage}`,headers:{...headers,'idempotency-key':randomUUID()},payload:{version:f.stageVersion,title:'Private updated stage'}})]
  for(const headers of [other.headers,{}])for(const response of await calls(headers)){expect(response.statusCode,response.body).toBe('authorization' in headers?404:401);expect(response.body).not.toContain('Уточнение ручной отметки')}
  await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[f.wedding,other.user])
  for(const role of ['helper','coordinator','vendor']){await app.db!.query('update wedding_members set role=$3 where wedding_id=$1 and user_id=$2',[f.wedding,other.user,role]);for(const response of await calls(other.headers))expect(response.statusCode,response.body).toBe(403)}
  expect((await history(f)).items).toHaveLength(0);expect((await app.db!.query('select version from payment_installments where id=$1',[f.stage])).rows[0].version).toBe(f.stageVersion)
  expect((await patch(f,correction())).statusCode).toBe(200)
 })
 it('real history keyset paging returns25 distinct revisions without omissions',async()=>{
  const f=await fixture()
  for(let version=1;version<=25;version++){const res=await patch(f,correction({version,amount:money(100000),paidOn:version%2?'2026-10-03':'2026-10-04',reason:'Page '+version}));expect(res.statusCode,res.body).toBe(200)}
  const first=await history(f);expect(first.items).toHaveLength(20);expect(first.nextCursor).toBeTruthy()
  const next=await app.inject({url:`/weddings/${f.wedding}/payments/${f.payment.id}/history?cursor=${encodeURIComponent(first.nextCursor)}`,headers:f.headers});expect(next.statusCode,next.body).toBe(200);const last=next.json();expect(last.items).toHaveLength(5);expect(last.nextCursor).toBeNull()
  const ids=[...first.items,...last.items].map((row:{id:string})=>row.id);expect(new Set(ids).size).toBe(25);expect([...first.items,...last.items].map((row:{afterVersion:number})=>row.afterVersion)).toEqual(Array.from({length:25},(_,index)=>26-index))
 })
 it('erasing one author preserves both real histories for the heir while removing actor/session identity',async()=>{
  const f=await fixture(),partner=await fixture();await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[f.wedding,partner.user])
  expect((await patch(f,correction())).statusCode).toBe(200)
  const stageVersion=(await app.db!.query('select version from payment_installments where id=$1',[f.stage])).rows[0].version
  const edit=await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payment-schedule/${f.stage}`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version:stageVersion,title:'Preserved heir stage'}});expect(edit.statusCode,edit.body).toBe(200)
  const tuples=async()=>({p:(await app.db!.query("select (to_jsonb(h)-'actor_id'-'session_id')::text value from payment_corrections h where wedding_id=$1 order by id",[f.wedding])).rows,s:(await app.db!.query("select (to_jsonb(h)-'actor_id'-'session_id')::text value from payment_installment_edits h where wedding_id=$1 order by id",[f.wedding])).rows})
  const before=await tuples();await app.db!.tx(tx=>eraseUser(tx,f.user));expect(await tuples()).toEqual(before)
  expect((await app.db!.query('select owner_id from weddings where id=$1',[f.wedding])).rows[0].owner_id).toBe(partner.user)
  const heir={...f,headers:partner.headers};expect((await history(heir)).items[0].actor).toBeNull()
  const stages=await app.inject({url:`/weddings/${f.wedding}/payment-schedule/${f.stage}/history`,headers:partner.headers});expect(stages.statusCode,stages.body).toBe(200);expect(stages.json().items[0].actor).toBeNull()
  for(const table of ['payment_corrections','payment_installment_edits'])expect((await app.db!.query(`select actor_id,session_id from ${table} where wedding_id=$1`,[f.wedding])).rows).toEqual([{actor_id:null,session_id:null}])
 })
 it('actual archive purge removes both new history families with their wedding',async()=>{
  const f=await fixture();expect((await patch(f,correction())).statusCode).toBe(200)
  const version=(await app.db!.query('select version from payment_installments where id=$1',[f.stage])).rows[0].version
  expect((await app.inject({method:'PATCH',url:`/weddings/${f.wedding}/payment-schedule/${f.stage}`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{version,title:'Synthetic purged revision'}})).statusCode).toBe(200)
  await app.db!.query("update weddings set cancelled_at=now()-interval '20000 days',archived_at=now()-interval '20000 days' where id=$1",[f.wedding]);await purgeArchivedWeddings(app)
  expect((await app.db!.query('select 1 from weddings where id=$1',[f.wedding])).rowCount).toBe(0)
  for(const table of ['payment_corrections','payment_installment_edits'])expect((await app.db!.query(`select 1 from ${table} where wedding_id=$1`,[f.wedding])).rowCount).toBe(0)
 })
})
