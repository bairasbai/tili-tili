import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { Config } from '../src/config.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'
import { receiptFilename } from '../src/routes/paymentSchedule.js'

const DB=process.env.TEST_DATABASE_URL,SECRET='a'.repeat(48),SECRET_R='b'.repeat(48),money=(amount:number)=>({amount,currency:'RUB'})
/* Загрузка подтверждений включается владельцем (`RECEIPTS_STORAGE=db`, ревью 018 BB-01);
 * здесь включена, выключенную проверяет отдельный экземпляр. Лимиты кода входа подняты:
 * общая база и чужие прогоны не должны съедать квоту (R-177). */
const CONFIG:Partial<Config>={env:'test',databaseUrl:DB??null,redisUrl:null,jwtAccessSecret:SECRET,jwtRefreshSecret:SECRET_R,
  policyVersion:'2026-09-02',receiptsStorage:'db',otpMaxPerHourTotal:1_000_000,otpMaxPerIpHour:1_000_000}
describe.skipIf(!DB)('018-B: лимиты, резерв и приватные подтверждения',()=>{
 let app:FastifyInstance
 beforeAll(async()=>{app=await buildApp(CONFIG);await app.ready()})
 afterAll(async()=>{await app?.close()})
 async function user(){const id=randomUUID(),sid=randomUUID();await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',[id,'+79'+randomInt(100000000,999999999),'018B']);await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',[sid,id,randomUUID()]);await app.db!.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)",[randomUUID(),id]);return{id,token:await signAccessToken(SECRET,{sub:id,sid})}}
 async function setup(){const owner=await user(),id=randomUUID(),slotId=randomUUID(),dealId=randomUUID();await app.db!.query("insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code) values($1,$2,'018B','2027-06-14','Asia/Yekaterinburg',10000000,$3)",[id,owner.id,randomUUID()]);await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[id,owner.id]);await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Фото')",[slotId,id]);await app.db!.query("insert into deals(id,wedding_id,slot_id,external_name,state,price,booked_at) values($1,$2,$3,'Фото','booked',1000000,now())",[dealId,id,slotId]);await app.db!.query('update slots set deal_id=$2 where id=$1',[slotId,dealId]);return{id,owner,slotId,dealId}}
 const headers=(w:Awaited<ReturnType<typeof setup>>)=>({authorization:'Bearer '+w.owner.token})
 const budget=(w:Awaited<ReturnType<typeof setup>>)=>app.inject({method:'GET',url:`/weddings/${w.id}/budget`,headers:headers(w)})
 it('SC005: покупка, возврат аренды, передача вещи и бюджет сохраняют отдельную историю',async()=>{
   const w=await setup(),other=await setup(),helper=await user()
   try {
     await app.db!.query("update users set name='Помощник SC005' where id=$1",[helper.id])
     await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id])
     const prefix=`/weddings/${w.id}`, path=prefix+'/item-sets', id=randomUUID()
     const purchaseId=randomUUID(), rentalId=randomUUID(), foreignId=randomUUID()
     const writePurchase=(id:string,body:object,owner=w)=>app.inject({
       method:'PUT',url:`/weddings/${owner.id}/purchases/${id}`,headers:headers(owner),payload:body,
     })
     const write=(body:object)=>app.inject({method:'PUT',url:path+'/'+id,headers:headers(w),payload:body})
     const list=()=>app.inject({method:'GET',url:path,headers:headers(w)})
     const history=()=>app.inject({method:'GET',url:path+'/'+id+'/history',headers:headers(w)})
     const base={title:'Плед — белый',quantity:'1',unit:'шт.',categoryId:'b2',agreedAmount:120000}
     for(const [version,status] of ['needed','ordered','received','delivered','done'].entries()){
       const result=await writePurchase(purchaseId,{...base,version,status})
       expect(result.statusCode,result.body).toBe(200)
       expect(result.json()).toMatchObject({version:version+1,status})
     }
     expect((await writePurchase(foreignId,{...base,version:0,status:'needed'},other)).statusCode).toBe(200)
     const rental={pickupOn:'2027-06-10',returnOn:'2027-06-12',depositAmount:45000,paidAmount:0,refundedAmount:0,disputedAmount:0}
     for(const [version,status] of ['needed','ordered','received','returned'].entries()){
       const result=await writePurchase(rentalId,{...base,title:'Аренда стоек',agreedAmount:80000,version,status,
         rental:{...rental,paidAmount:version ? 45000 : 0,refundedAmount:version===3 ? 45000 : 0}})
       expect(result.statusCode,result.body).toBe(200)
     }
     const totals=async()=>{
       const response=await budget(w)
       expect(response.statusCode,response.body).toBe(200)
       return response.json()
     }
     const before=await totals()
     expect(before).toMatchObject({spent:money(1_200_000),rentalDeposits:{paid:'45000',refunded:'45000',held:'0'}})
     const body={title:'Плед белый',kit:'ceremony',holderId:w.owner.id,delivererId:helper.id,archived:false}
     expect((await write({...body,version:0,holderId:other.owner.id})).statusCode).toBe(422)
     expect((await write({...body,version:0,purchaseId:foreignId})).statusCode).toBe(422)
     const created=await write({...body,version:0})
     expect(created.statusCode,created.body).toBe(200)
     expect((await write({...body,version:0})).json()).toEqual(created.json())
     const suggestion=await list()
     expect(suggestion.statusCode,suggestion.body).toBe(200)
     expect(suggestion.json()).toMatchObject({
       kits:['bride_morning','groom_morning','ceremony','venue','emergency'],
       items:[{id,holderName:'018B',delivererName:'Помощник SC005',purchaseId:null,
         possiblePurchases:[{id:purchaseId,label:'Плед — белый'}]}],
     })
     const transfer=await write({...body,version:1,holderId:helper.id,purchaseId})
     expect(transfer.statusCode,transfer.body).toBe(200)
     const race=await Promise.all(['Плед для пары','Плед для гостей'].map(title=>
       write({...body,title,version:2,holderId:helper.id,purchaseId})))
     expect(race.map(result=>result.statusCode).sort()).toEqual([200,409])
     expect(race.find(result=>result.statusCode===409)?.json().error.code).toBe('stale_wedding_item')
     expect((await list()).json().items).toMatchObject([{id,version:3,purchaseId,possiblePurchases:[]}])
     const revisions=await history()
     expect(revisions.statusCode,revisions.body).toBe(200)
     expect(revisions.json().items).toMatchObject([
       {version:3,holderId:helper.id,delivererId:helper.id,purchaseId},
       {version:2,holderId:helper.id,delivererId:helper.id,purchaseId,actorName:'018B'},
       {version:1,holderId:w.owner.id,delivererId:helper.id,purchaseId:null,actorName:'018B'},
     ])
     for(const url of [path,path+'/'+id+'/history'])
       expect((await app.inject({method:'GET',url,headers:{authorization:'Bearer '+helper.token}})).statusCode).toBe(403)
     expect((await app.inject({method:'PUT',url:path+'/'+id,headers:{authorization:'Bearer '+helper.token},
       payload:{...body,version:3}})).statusCode).toBe(403)
     expect((await app.inject({method:'GET',url:`/weddings/${other.id}/item-sets/${id}/history`,headers:headers(other)})).statusCode).toBe(404)
     expect((await app.inject({method:'GET',url:prefix+'/purchases/'+rentalId+'/history',headers:headers(w)})).json().items)
       .toMatchObject([{version:4,status:'returned',rental:{refundedAmount:45000}},{version:3,status:'received'},
         {version:2,status:'ordered'},{version:1,status:'needed'}])
     const exported=await app.inject({method:'GET',url:'/users/me/export',headers:headers(w)})
     expect(exported.statusCode,exported.body).toBe(200)
     const itemExport=exported.json().weddingItems
     expect(itemExport).toMatchObject([
       {id,version:1,held_by_requester:true,delivered_by_requester:false},
       {id,version:2,purchase_id:purchaseId,held_by_requester:false,delivered_by_requester:false},
       {id,version:3,purchase_id:purchaseId,held_by_requester:false,delivered_by_requester:false},
     ])
     expect(JSON.stringify(itemExport)).not.toContain(helper.id)
     const helperExport=await app.inject({method:'GET',url:'/users/me/export',headers:{authorization:'Bearer '+helper.token}})
     expect(helperExport.statusCode,helperExport.body).toBe(200)
     expect(helperExport.json().weddingItems).toEqual([])
     expect(await totals()).toEqual(before)
     await app.db!.query('update weddings set cancelled_at=now() where id=$1',[w.id])
     expect((await list()).json().readOnly).toBe(true)
     expect((await write({...body,version:3})).statusCode).toBe(404)
     expect((await history()).json().items).toHaveLength(3)
   } finally {
     await app.db!.query('delete from weddings where id=any($1::uuid[])',[[w.id,other.id]])
     await app.db!.query('delete from users where id=any($1::uuid[])',[[w.owner.id,other.owner.id,helper.id]])
   }
 })
 it('FR025 отделяет залог от аренды, сохраняет частичный возврат и спорную часть',async()=>{
   const w=await setup()
   try {
     const path=`/weddings/${w.id}/purchases`, id=randomUUID()
     const write=(purchaseId:string,body:object)=>app.inject({method:'PUT',url:path+'/'+purchaseId,headers:headers(w),payload:body})
     const totals=async()=>{
       const response=await budget(w)
       expect(response.statusCode,response.body).toBe(200)
       return response.json()
     }
     const base={version:0,title:'Аренда стульев',quantity:'10',unit:'шт.',categoryId:'b2',agreedAmount:200001,status:'needed',assigneeId:w.owner.id}
     const planned={pickupOn:'2027-06-10',returnOn:'2027-06-12',depositAmount:500000,paidAmount:0,refundedAmount:0,disputedAmount:0}
     const values=(upcoming:string,paid:string,refunded:string,held:string,disputed:string)=>({upcoming,paid,refunded,held,disputed})
     expect((await write(id,{...base,rental:{...planned,returnOn:'2027-06-09'}})).statusCode).toBe(422)
     const created=await write(id,{...base,rental:planned})
     expect(created.statusCode,created.body).toBe(200)
     expect(created.json()).toMatchObject({rental:planned,version:1})
     expect(await totals()).toMatchObject({spent:money(1200001),rentalDeposits:values('500000','0','0','0','0')})
     const payment={...planned,paidAmount:500000}
     const ordered={...base,version:1,status:'ordered',rental:payment}
     const first=await write(id,ordered)
     expect(first.statusCode,first.body).toBe(200)
     expect((await write(id,ordered)).json()).toEqual(first.json())
     expect(await totals()).toMatchObject({spent:money(1200001),rentalDeposits:values('0','500000','0','500000','0')})
     const received=await write(id,{...base,version:2,status:'received'})
     expect(received.statusCode,received.body).toBe(200)
     expect(received.json()).toMatchObject({version:3,rental:payment})
     expect((await write(id,{...base,version:3,status:'returned',rental:{...payment,refundedAmount:500001}})).statusCode).toBe(422)
     expect((await write(id,{...base,version:3,status:'returned',rental:{...payment,refundedAmount:350000,disputedAmount:150001}})).statusCode).toBe(422)
     const partial={...payment,refundedAmount:350000,disputedAmount:100000}
     const returned=await write(id,{...base,version:3,status:'returned',rental:partial})
     expect(returned.statusCode,returned.body).toBe(200)
     expect(await totals()).toMatchObject({spent:money(1200001),rentalDeposits:values('0','500000','350000','150000','100000')})
     const resolved={...payment,refundedAmount:500000}
     expect((await write(id,{...base,version:4,status:'returned',rental:resolved})).json()).toMatchObject({version:5,rental:resolved})
     expect(await totals()).toMatchObject({spent:money(1200001),rentalDeposits:values('0','500000','500000','0','0')})
     const history=await app.inject({method:'GET',url:path+'/'+id+'/history',headers:headers(w)})
     expect(history.statusCode,history.body).toBe(200)
     expect(history.json().items.slice(0,2)).toMatchObject([
       {version:5,status:'returned',actorName:'018B',rental:resolved},
       {version:4,status:'returned',actorName:'018B',rental:partial},
     ])
     const cancelled=randomUUID(), advance={...planned,depositAmount:30000,paidAmount:20000}
     expect((await write(cancelled,{...base,rental:advance})).statusCode).toBe(200)
     expect((await write(cancelled,{...base,version:1,status:'cancelled'})).statusCode).toBe(200)
     expect(await totals()).toMatchObject({spent:money(1200001),rentalDeposits:values('0','520000','500000','20000','0')})
   } finally {
     await app.db!.query('delete from weddings where id=$1',[w.id])
     await app.db!.query('delete from users where id=$1',[w.owner.id])
   }
 })
 it('WP13 сохраняет покупку, все переходы и один вклад в бюджет',async()=>{
   const w=await setup(),other=await setup(),helper=await user()
   try {
     await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id])
     const event=(await app.db!.query<{id:string}>('select id from wedding_events where wedding_id=$1 and is_main',[w.id])).rows[0]!.id
     const path=`/weddings/${w.id}/purchases`,id=randomUUID()
     const write=(purchaseId:string,body:object)=>app.inject({method:'PUT',url:path+'/'+purchaseId,headers:headers(w),payload:body})
     const list=()=>app.inject({method:'GET',url:path,headers:headers(w)})
     const category=(response:Awaited<ReturnType<typeof budget>>)=>response.json().categories.find((row:{id:string})=>row.id==='b2')
     const body={version:0,title:'Украшения',quantity:'2.500',unit:'метра',categoryId:'b2',status:'needed',estimatedAmount:300000,
       assigneeId:helper.id,eventId:event,seller:'Магазин',sellerUrl:'https://example.org/item',dueOn:'2027-05-12'}
     expect((await write(randomUUID(),{...body,sellerUrl:'javascript:alert(1)'})).statusCode).toBe(422)
     expect((await write(randomUUID(),{...body,assigneeId:other.owner.id})).statusCode).toBe(422)
     expect((await write(randomUUID(),{...body,linkedDealId:other.dealId})).statusCode).toBe(404)
     expect((await write(randomUUID(),{...body,status:'received'})).json().error.code).toBe('wedding_purchase_transition')
     expect((await app.inject({method:'GET',url:path,headers:{authorization:'Bearer '+helper.token}})).statusCode).toBe(403)

     const created=await write(id,body)
     expect(created.statusCode,created.body).toBe(200)
     expect(created.json()).toMatchObject({id,version:1,quantity:'2.5',status:'needed',nextStatuses:['ordered','cancelled']})
     expect((await write(id,body)).json()).toEqual(created.json())
     const choices=await list()
     expect(choices.statusCode,choices.body).toBe(200)
     expect(choices.headers['cache-control']).toBe('no-store')
     expect(choices.json()).toMatchObject({items:[{id}],members:expect.arrayContaining([{id:helper.id,label:'018B'}]),
       events:expect.arrayContaining([expect.objectContaining({id:event})]),deals:expect.arrayContaining([expect.objectContaining({id:w.dealId})])})
     const estimated=await budget(w)
     expect(estimated.json().spent).toEqual(money(1000000))
     expect(category(estimated)).toMatchObject({estimatedPurchases:money(300000),unknownPurchaseCosts:0})

     const order={...body,version:1,agreedAmount:250001,status:'ordered'}
     expect((await write(id,order)).json()).toMatchObject({version:2,status:'ordered'})
     const committed=await budget(w)
     expect(committed.json().spent).toEqual(money(1250001))
     expect(category(committed)).toMatchObject({items:[{purchaseId:id,amount:money(250001),custom:false}]})
     expect(category(committed)).not.toHaveProperty('estimatedPurchases')
     const competing=await Promise.all([write(id,{...order,version:2,status:'received',seller:'А'}),write(id,{...order,version:2,status:'received',seller:'Б'})])
     expect(competing.map(response=>response.statusCode).sort()).toEqual([200,409])
     expect(competing.find(response=>response.statusCode===409)!.json().error.code).toBe('stale_wedding_purchase')
     const seller=competing.find(response=>response.statusCode===200)!.json().seller
     expect((await write(id,{...order,seller,version:3,status:'delivered'})).json()).toMatchObject({version:4,status:'delivered'})
     expect((await write(id,{...order,seller,version:4,status:'done'})).json()).toMatchObject({version:5,status:'done'})
     expect((await write(id,{...order,seller,version:5,status:'returned'})).json()).toMatchObject({version:6,status:'returned'})

     const linked=randomUUID()
     const withDeal=await write(linked,{...body,estimatedAmount:null,agreedAmount:120000,linkedDealId:w.dealId})
     expect(withDeal.statusCode,withDeal.body).toBe(200)
     const noDouble=await budget(w)
     expect(noDouble.json().spent).toEqual(money(1000000))
     expect(category(noDouble)).toMatchObject({items:[],linkedItems:[{purchaseId:linked,amount:money(120000),linkedDealId:w.dealId}]})
     expect((await write(linked,{...body,version:1,status:'cancelled',estimatedAmount:null,agreedAmount:120000,linkedDealId:w.dealId})).statusCode).toBe(200)
     expect(category(await budget(w)).linkedItems).toEqual([])
     const history=await app.inject({method:'GET',url:path+'/'+id+'/history',headers:headers(w)})
     expect(history.statusCode,history.body).toBe(200)
     expect(history.json().items.map((entry:{status:string})=>entry.status)).toEqual(['returned','done','delivered','received','ordered','needed'])
     expect(history.json().items[0]).toMatchObject({version:6,actorName:'018B'})
     const unknown=randomUUID()
     expect((await write(unknown,{...body,estimatedAmount:null})).statusCode).toBe(200)
     expect(category(await budget(w))).toMatchObject({unknownPurchaseCosts:1})
     expect((await write(unknown,{...body,version:1,estimatedAmount:0})).statusCode).toBe(200)
     expect(category(await budget(w))).toMatchObject({unknownPurchaseCosts:0,estimatedPurchases:money(0)})
   } finally {
     await app.db!.query('delete from weddings where id=any($1::uuid[])',[[w.id,other.id]])
     await app.db!.query('delete from users where id=any($1::uuid[])',[[w.owner.id,other.owner.id,helper.id]])
   }
 })
 it('SC002 считает связанную покупку один раз и сохраняет историю оплат после отмены сделки',async()=>{
   const w=await setup(),other=await setup(),helper=await user()
   try {
     await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id])
     const base=`/weddings/${w.id}/budget/items`
     const create=(payload:object,key?:string)=>app.inject({method:'POST',url:base,
       headers:{...headers(w),...(key?{'idempotency-key':key}:{})},payload})
     const manual={title:'Работа фотографа',categoryId:'b2',amount:money(450000)}
     const first=await create(manual)
     expect(first.statusCode,first.body).toBe(201)
     const { id }=first.json()
     const link=(dealId:string|null,version:number,authorization=headers(w).authorization)=>app.inject({
       method:'PUT',url:base+'/'+id+'/deal-link',headers:{authorization},payload:{dealId,version},
     })
     expect(first.json()).toMatchObject({linkedDealId:null,dealLinkVersion:0})
     expect((await budget(w)).json().spent).toEqual(money(1450000))
     expect((await link(other.dealId,0)).statusCode).toBe(404)
     expect((await link(w.dealId,0,'Bearer '+helper.token)).statusCode).toBe(403)
     expect((await create({...manual,linkedDealId:w.dealId})).statusCode).toBe(400)

     const schedule=`/weddings/${w.id}/payment-schedule`
     const stage=await app.inject({method:'POST',url:schedule,headers:{...headers(w),'idempotency-key':randomUUID()},
       payload:{dealId:w.dealId,title:'Аванс',due:'2027-05-01',amount:money(400000)}})
     expect(stage.statusCode,stage.body).toBe(201)
     const stageId=stage.json().id as string, payKey=randomUUID()
     const pay=()=>app.inject({method:'POST',url:`${schedule}/${stageId}/pay`,headers:{...headers(w),'idempotency-key':payKey},
       payload:{version:stage.json().version,amount:money(200000),paymentMethod:'cash',paidOn:'2026-10-01'}})
     const paid=await pay(), repeatedPayment=await pay()
     expect(paid.statusCode,paid.body).toBe(200)
     expect(paid.json()).toMatchObject({status:'partial',paid:money(200000),remaining:money(200000)})
     expect(repeatedPayment.statusCode,repeatedPayment.body).toBe(200)
     expect(repeatedPayment.headers['idempotent-replay']).toBe('true')
     expect(repeatedPayment.json()).toEqual(paid.json())
     const readSchedule=async()=>{
       const result=await app.inject({method:'GET',url:schedule+'?from=2027-05-01&to=2027-05-31',headers:headers(w)})
       expect(result.statusCode,result.body).toBe(200)
       return result.json()
     }
     const firstLedger=await readSchedule()
     expect(firstLedger.payments).toMatchObject([{dealId:w.dealId,installmentId:stageId,amount:money(200000)}])
     const payment=firstLedger.payments[0].id as string, correctionKey=randomUUID()
     const correct=()=>app.inject({method:'PATCH',url:`/weddings/${w.id}/payments/${payment}`,
       headers:{...headers(w),'idempotency-key':correctionKey},
       payload:{version:firstLedger.payments[0].version,amountKnown:true,amount:money(300000),paymentMethod:'cash',
         paidOn:'2026-10-02',reason:'Уточнена сумма аванса'}})
     const correction=await correct(), repeatedCorrection=await correct()
     expect(correction.statusCode,correction.body).toBe(200)
     expect(repeatedCorrection.statusCode,repeatedCorrection.body).toBe(200)
     expect(repeatedCorrection.headers['idempotent-replay']).toBe('true')
     expect(repeatedCorrection.json()).toEqual(correction.json())
     const history=()=>app.inject({method:'GET',url:`/weddings/${w.id}/payments/${payment}/history`,headers:headers(w)})
     const auditPayment=await history()
     expect(auditPayment.statusCode,auditPayment.body).toBe(200)
     expect(auditPayment.json().items).toMatchObject([{id:correction.json().amendmentId,reason:'Уточнена сумма аванса',
       before:{amount:money(200000)},after:{amount:money(300000)}}])

     // The current application reads recorded refunds; it has no refund command.
     const refund=randomUUID()
     await app.db!.query("insert into payments(id,deal_id,kind,amount,status,paid_on,installment_id) values($1,$2,'refund',50000,'recorded','2026-10-03',$3)",
       [refund,w.dealId,stageId])
     const ledger=await readSchedule()
     expect(ledger.payments).toMatchObject([{id:refund,kind:'refund',amount:money(50000)},{id:payment,amount:money(300000)}])
     expect(ledger.items).toMatchObject([{id:stageId,status:'partial',paid:money(250000),remaining:money(150000)}])
     const prior=(await budget(w)).json().paymentSummary
     expect(prior).toMatchObject({recorded:money(250000),remaining:money(750000),cashFlow:{paid:'300000',refunded:'50000'}})

     const firstLink=await link(w.dealId,0)
     expect(firstLink.statusCode,firstLink.body).toBe(200)
     expect(firstLink.json()).toMatchObject({id,linkedDealId:w.dealId,dealLinkVersion:1})
     expect((await link(w.dealId,0)).json()).toEqual(firstLink.json())
     expect((await link(null,0)).json().error.code).toBe('stale_budget_item_link')
     const combined=(await budget(w)).json()
     expect(combined.spent).toEqual(money(1000000))
     expect(combined.categories.find((row:{id:string})=>row.id==='b2')).toMatchObject({
       fromSlots:1000000,committed:money(1000000),items:[],linkedItems:[{id,amount:money(450000),linkedDealId:w.dealId}],
     })
     expect(combined.paymentSummary).toEqual(prior)

     const linked={...manual,title:'Печать в составе договора',linkedDealId:w.dealId}
     const key=randomUUID()
     const saved=await create(linked,key)
     const repeated=await create(linked,key)
     expect(saved.statusCode,saved.body).toBe(201)
     expect(repeated.statusCode,repeated.body).toBe(201)
     expect(repeated.headers['idempotent-replay']).toBe('true')
     expect(repeated.json()).toEqual(saved.json())
     expect((await create({...linked,title:'Другая статья'},key)).statusCode).toBe(409)
     expect((await budget(w)).json().spent).toEqual(money(1000000))

     const secondDeal=other.dealId
     const competingSlot=randomUUID(),competingDeal=randomUUID()
     await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Вторая фотосъёмка')",[competingSlot,w.id])
     await app.db!.query("insert into deals(id,wedding_id,slot_id,external_name,state,booked_at) values($1,$2,$3,'Другой фотограф','booked',now())",
       [competingDeal,w.id,competingSlot])
     const edits=await Promise.all([link(competingDeal,1),link(null,1)])
     expect(edits.map(result=>result.statusCode).sort()).toEqual([200,409])
     const winningDeal=edits.find(result=>result.statusCode===200)!.json().linkedDealId
     expect((await link(w.dealId,2)).json()).toMatchObject({linkedDealId:w.dealId,dealLinkVersion:3})
     expect((await link(secondDeal,3)).statusCode).toBe(404)
     await app.db!.query("update deals set state='cancelled',cancelled_at=now() where id=$1",[competingDeal])

     const cancel=await app.inject({method:'PATCH',url:`/deals/${w.dealId}`,
       headers:{...headers(w),'idempotency-key':randomUUID()},payload:{state:'cancelled'}})
     expect(cancel.statusCode,cancel.body).toBe(200)
     const cancelled=(await budget(w)).json()
     expect(cancelled.spent).toEqual(money(0))
     expect(cancelled.dealChoices).toEqual([])
     expect(cancelled.paymentSummary).toMatchObject({inactiveDealRecorded:money(250000),cashFlow:prior.cashFlow})
     expect((await history()).json().items).toEqual(auditPayment.json().items)
     expect(cancelled.categories.find((row:{id:string})=>row.id==='b2').linkedItems).toHaveLength(2)
     expect((await link(null,3)).json()).toMatchObject({linkedDealId:null,dealLinkVersion:4})
     expect((await budget(w)).json().spent).toEqual(money(450000))
     expect((await link(w.dealId,4)).statusCode).toBe(404)
     const audit=(await app.db!.query("select diff from audit_log where entity='budget_item' and entity_id=$1 order by (diff->>'version')::int",[id])).rows
     expect(audit.map(row=>row.diff)).toEqual([
       {weddingId:w.id,previousDealId:null,dealId:w.dealId,version:1},
       {weddingId:w.id,previousDealId:w.dealId,dealId:winningDeal,version:2},
       {weddingId:w.id,previousDealId:winningDeal,dealId:w.dealId,version:3},
       {weddingId:w.id,previousDealId:w.dealId,dealId:null,version:4},
     ])
   } finally {
     await app.db!.query('delete from weddings where id=any($1::uuid[])',[[w.id,other.id]])
     await app.db!.query('delete from users where id=any($1::uuid[])',[[w.owner.id,other.owner.id,helper.id]])
   }
 })
 it('FR016 хранит вклад отдельно от расходов, защищает версии и сохраняет историю',async()=>{
   const w=await setup(),other=await setup(),helper=await user()
   try {
     await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id])
     const listPath=`/weddings/${w.id}/budget/family-contributions`, id=randomUUID()
     const list=()=>app.inject({method:'GET',url:listPath,headers:headers(w)})
     const write=(record:string,body:object)=>app.inject({method:'PUT',url:listPath+'/'+record,headers:headers(w),payload:body})
     const summary=(outstanding:number,received:number)=>({outstanding:money(outstanding),received:money(received)})
     const before=(await budget(w)).json()
     const empty=await list()
     expect(empty.statusCode,empty.body).toBe(200)
     expect(empty.headers['cache-control']).toBe('no-store')
     expect(empty.json()).toEqual({items:[],...summary(0,0)})
     const promised={version:0,label:'Семья',promised:money(100001),received:money(0),archived:false}
     const replay=await Promise.all([write(id,promised),write(id,promised)])
     expect(replay.map(x=>x.statusCode)).toEqual([200,200])
     expect(replay[0]!.json()).toEqual(replay[1]!.json())
     expect((await list()).json()).toMatchObject(summary(100001,0))
     const receivedOnly=await write(randomUUID(),{...promised,label:'Вклад без обещания',promised:money(0),received:money(50000)})
     expect(receivedOnly.statusCode,receivedOnly.body).toBe(200)
     const partial={...promised,version:1,received:money(30001)}
     const updated=await write(id,partial)
     expect(updated.statusCode,updated.body).toBe(200)
     expect((await list()).json()).toMatchObject(summary(70000,80001))
     expect((await budget(w)).json()).toEqual(before)

     const edit=await Promise.all([write(id,{...partial,version:2,label:'Семья А'}),write(id,{...partial,version:2,label:'Семья Б'})])
     expect(edit.map(x=>x.statusCode).sort()).toEqual([200,409])
     expect(edit.find(x=>x.statusCode===409)!.json().error.code).toBe('stale_family_contribution')
     const chosen=edit.find(x=>x.statusCode===200)!.json()
     const overflow=await write(randomUUID(),{...promised,label:'Проверка границы',promised:money(0),received:money(Number.MAX_SAFE_INTEGER)})
     expect(overflow.statusCode,overflow.body).toBe(409)
     expect((await list()).json().items).toHaveLength(2)
     const archived=await write(id,{...partial,label:chosen.label,version:3,archived:true})
     expect(archived.statusCode,archived.body).toBe(200)
     expect((await list()).json()).toMatchObject(summary(0,50000))
     const history=await app.inject({method:'GET',url:listPath+'/'+id+'/history',headers:headers(w)})
     expect(history.statusCode,history.body).toBe(200)
     expect(history.headers['cache-control']).toBe('no-store')
     expect(history.json().items.map((row:{version:number})=>row.version)).toEqual([4,3,2,1])
     expect(history.json().items[3]).toMatchObject({received:money(0),archived:false})
     const helperHeaders={authorization:'Bearer '+helper.token}
     expect((await app.inject({method:'GET',url:listPath,headers:helperHeaders})).statusCode).toBe(403)
     expect((await app.inject({method:'PUT',url:listPath+'/'+id,headers:helperHeaders,payload:{}})).statusCode).toBe(403)
     expect((await app.inject({method:'GET',url:`/weddings/${other.id}/budget/family-contributions/${id}/history`,headers:headers(other)})).statusCode).toBe(404)
     const exportData=(requestHeaders:{authorization:string})=>app.inject({method:'GET',url:'/users/me/export',headers:requestHeaders})
     const [ownExport,helperExport,otherExport]=await Promise.all([exportData(headers(w)),exportData(helperHeaders),exportData(headers(other))])
     for(const response of [ownExport,helperExport,otherExport]) expect(response.statusCode,response.body).toBe(200)
     expect(ownExport.json().familyContributions.filter((row:{id:string})=>row.id===id)).toMatchObject([
       {wedding_id:w.id,version:1,received_amount:'0',currency:'RUB',archived:false},
       {version:2,received_amount:'30001',archived:false},
       {version:3,archived:false},
       {version:4,archived:true},
     ])
     expect(helperExport.json().familyContributions).toEqual([])
     expect(otherExport.json().familyContributions).toEqual([])
     const audit=(await app.db!.query("select diff from audit_log where entity='family_contribution' and entity_id=$1",[id])).rows
     expect(audit).toHaveLength(4)
     expect(audit.map(row=>Object.keys(row.diff).sort())).toEqual(Array.from({length:4},()=>['archived','version','weddingId']))
   } finally {
     await app.db!.query('delete from weddings where id=any($1::uuid[])',[[w.id,other.id]])
     await app.db!.query('delete from users where id=any($1::uuid[])',[[w.owner.id,other.owner.id,helper.id]])
   }
 })
 it('FR016 разделяет известные суммы и активные сделки без цены по категориям',async()=>{
   const w=await setup()
   try {
     const seed=async(category:string,state:'booked'|'candidate')=>{
       const slot=randomUUID(),deal=randomUUID()
       await app.db!.query('insert into slots(id,wedding_id,category_id,label) values($1,$2,$3,$3)',[slot,w.id,category])
       await app.db!.query(`insert into deals(id,wedding_id,slot_id,external_name,state,price,booked_at)
         values($1,$2,$3,$4,$5,null,case when $5='booked' then now() else null end)`,[deal,w.id,slot,category,state])
       await app.db!.query('update slots set deal_id=$2 where id=$1',[slot,deal])
     }
     const before=(await budget(w)).json()
     await seed('video','booked')
     await seed('decor','booked')
     await seed('host','candidate')
     const response=await budget(w)
     expect(response.statusCode,response.body).toBe(200)
     const current=response.json()
     expect(current.spent).toEqual(before.spent)
     expect(current.paymentSummary.unknownPrices).toBe(2)
     expect(current.categories).toEqual(expect.arrayContaining([
       expect.objectContaining({id:'b2',fromSlots:1000000,unknownPrices:1,live:'Фото'}),
       expect.objectContaining({id:'b4',fromSlots:0,unknownPrices:1,live:null}),
       expect.objectContaining({id:'b5',fromSlots:0,unknownPrices:0}),
     ]))
   } finally {
     await app.db!.query('delete from weddings where id=$1',[w.id])
     await app.db!.query('delete from users where id=$1',[w.owner.id])
   }
 })
 it('меняет резерв с optimistic version и не считает его расходом',async()=>{const w=await setup(),before=(await budget(w)).json();expect(before.reserveBps).toBe(1000);expect(before.settingsVersion).toBe(0);const a=await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:headers(w),payload:{reserveBps:1500,version:0}});expect(a.statusCode,a.body).toBe(200);const stale=await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:headers(w),payload:{reserveBps:2000,version:0}});expect(stale.statusCode).toBe(409);const after=(await budget(w)).json();expect(after.reserve).toEqual(money(1500000));expect(after.spent).toEqual(before.spent)})
 it('задаёт лимит категории, защищает stale edit и возвращает авто-лимит',async()=>{const w=await setup();const put=(version:number,amount:number)=>app.inject({method:'PUT',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:headers(w),payload:{amount:money(amount),version}});expect((await put(0,2500000)).statusCode).toBe(200);expect((await put(0,2600000)).statusCode).toBe(409);let b=(await budget(w)).json(),cat=b.categories.find((x:{id:string})=>x.id==='b2');expect(cat).toMatchObject({planned:money(2500000),limitCustom:true,limitVersion:1});expect((await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:headers(w),payload:{reset:true,version:1}})).statusCode).toBe(204);b=(await budget(w)).json();cat=b.categories.find((x:{id:string})=>x.id==='b2');expect(cat.limitCustom).toBe(false);expect(cat.limitVersion).toBe(2);expect(cat.planned.amount).not.toBe(2500000)
   // A client that still has version=0 from before custom -> auto must not revive the limit (ABA).
   expect((await put(0,2700000)).statusCode).toBe(409)})
 it('не раскрывает новые финансовые пути helper',async()=>{const w=await setup(),helper=await user();await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id]);const h={authorization:'Bearer '+helper.token};expect((await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:h,payload:{reserveBps:1000,version:0}})).statusCode).toBe(403)})
 it('ограниченная роль получает 403 до валидации тела финансовой записи',async()=>{const w=await setup(),helper=await user();await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id]);const r=await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:{authorization:'Bearer '+helper.token},payload:{reserveBps:'not-a-number'}});expect(r.statusCode).toBe(403)})
 async function payment(w:Awaited<ReturnType<typeof setup>>){const r=await app.inject({method:'POST',url:`/weddings/${w.id}/slots/${w.slotId}/pay`,headers:{...headers(w),'idempotency-key':randomUUID()},payload:{amount:money(100000)}});expect(r.statusCode,r.body).toBe(200);return (await app.db!.query<{id:string}>('select id from payments where deal_id=$1 order by created_at desc',[w.dealId])).rows[0]!.id}
 const png=Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64')
 it('FR012: загрузка, повтор, чтение и удаление документа сохраняют отметку и финансовые данные',async()=>{
   const w=await setup()
   try{
     const pid=await payment(w),key=randomUUID()
     const snapshot=async()=>({
       payment:(await app.db!.query('select * from payments where id=$1',[pid])).rows[0],
       deal:(await app.db!.query('select * from deals where id=$1',[w.dealId])).rows[0],
       spent:(await budget(w)).json().spent,
     })
     const before=await snapshot()
     expect(before.payment).toMatchObject({id:pid,status:'recorded',provider_ref:null})
     expect(before.spent).toMatchObject({currency:'RUB'})
     const uploadDocument=()=>app.inject({method:'POST',url:`/weddings/${w.id}/payments/${pid}/receipts`,
       headers:{...headers(w),'idempotency-key':key},payload:{filename:'чек.png',mimeType:'image/png',contentBase64:png}})
     const add=await uploadDocument();expect(add.statusCode,add.body).toBe(201)
     const rid=add.json().id
     expect(await snapshot()).toEqual(before)
     const replay=await uploadDocument();expect(replay.statusCode,replay.body).toBe(201)
     expect(replay.headers['idempotent-replay']).toBe('true');expect(replay.json().id).toBe(rid)
     expect(await snapshot()).toEqual(before)
     const list=await app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:headers(w)})
     expect(list.json().items).toHaveLength(1);expect(list.body).not.toContain(png)
     const content=await app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}/content`,headers:headers(w)})
     expect(content.headers['cache-control']).toBe('no-store');expect(content.headers['x-content-type-options']).toBe('nosniff')
     expect(content.json()).toMatchObject({filename:'чек.png',mimeType:'image/png',contentBase64:png})
     expect((await app.inject({method:'DELETE',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}`,headers:headers(w)})).statusCode).toBe(204)
     expect(await snapshot()).toEqual(before)
     expect((await app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:headers(w)})).json().items).toEqual([])
   }finally{
     await app.db!.query('delete from weddings where id=$1 and owner_id=$2',[w.id,w.owner.id])
     await app.db!.query('delete from users where id=$1',[w.owner.id])
   }
 })
 it('повтор загрузки с тем же ключом не создаёт второй файл',async()=>{const w=await setup(),pid=await payment(w),key=randomUUID(),req=()=>app.inject({method:'POST',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:{...headers(w),'idempotency-key':key},payload:{filename:'чек.png',mimeType:'image/png',contentBase64:png}});const first=await req(),second=await req();expect(first.statusCode).toBe(201);expect(second.statusCode).toBe(201);expect(second.headers['idempotent-replay']).toBe('true');expect(second.json().id).toBe(first.json().id);const {rows}=await app.db!.query<{n:number}>('select count(*)::int as n from payment_receipts where payment_id=$1',[pid]);expect(rows[0]!.n).toBe(1)})
 it('проверяет magic bytes, а не доверяет MIME из браузера',async()=>{const w=await setup(),pid=await payment(w);const r=await app.inject({method:'POST',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:{...headers(w),'idempotency-key':randomUUID()},payload:{filename:'fake.pdf',mimeType:'application/pdf',contentBase64:png}});expect(r.statusCode).toBe(422)})
 it('не даёт читать подтверждение из другой свадьбы и helper',async()=>{const w=await setup(),pid=await payment(w),add=await app.inject({method:'POST',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:{...headers(w),'idempotency-key':randomUUID()},payload:{filename:'x.png',mimeType:'image/png',contentBase64:png}}),rid=add.json().id;const other=await setup();expect((await app.inject({method:'GET',url:`/weddings/${other.id}/payments/${pid}/receipts/${rid}/content`,headers:headers(other)})).statusCode).toBe(404);const helper=await user();await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id]);expect((await app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}/content`,headers:{authorization:'Bearer '+helper.token}})).statusCode).toBe(403)})

 /* ── ревью 018: исправления 018-B ────────────────────────────────── */
 const IP=`198.18.${randomInt(0,255)}.${randomInt(1,254)}`
 async function withApp(overrides:Partial<Config>,fn:(other:FastifyInstance)=>Promise<void>){
   const other=await buildApp({...CONFIG,...overrides});await other.ready()
   try{await fn(other)}finally{await other.close()}
 }
 async function partnerOf(w:Awaited<ReturnType<typeof setup>>){
   const partner=await user()
   await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[w.id,partner.id])
   return partner
 }
 const upload=(target:FastifyInstance,w:{id:string},pid:string,token:string,filename='чек.png',content=png)=>target.inject({method:'POST',
   url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:{authorization:'Bearer '+token,'idempotency-key':randomUUID()},
   payload:{filename,mimeType:'image/png',contentBase64:content}})
 const receiptRow=async(rid:string)=>(await app.db!.query<{uploaded_by:string|null}>('select uploaded_by from payment_receipts where id=$1',[rid])).rows[0]

 it('BB-01: хранилище выключено — загрузка 501, список говорит об этом, прежние файлы читаются и удаляются',async()=>{
   const w=await setup(),pid=await payment(w)
   const before=await upload(app,w,pid,w.owner.token);expect(before.statusCode,before.body).toBe(201)
   expect((await app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:headers(w)})).json().uploadEnabled).toBe(true)
   await withApp({receiptsStorage:null},async off=>{
     const list=await off.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:headers(w)})
     expect(list.json()).toMatchObject({uploadEnabled:false});expect(list.json().items).toHaveLength(1)
     const denied=await upload(off,w,pid,w.owner.token)
     expect(denied.statusCode).toBe(501);expect(denied.json().error.code).toBe('storage_not_configured')
     const rid=before.json().id
     expect((await off.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}/content`,headers:headers(w)})).statusCode).toBe(200)
     expect((await off.inject({method:'DELETE',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}`,headers:headers(w)})).statusCode).toBe(204)
   })
   expect((await app.db!.query('select 1 from payment_receipts where payment_id=$1',[pid])).rows).toHaveLength(0)
 })

 it('BB-01: квота свадьбы по числу файлов — считается по всем оплатам свадьбы, лишний не записан',async()=>{
   await withApp({receiptsMaxPerWedding:2},async tight=>{
     const w=await setup(),a=await payment(w),b=await payment(w)
     expect((await upload(tight,w,a,w.owner.token)).statusCode).toBe(201)
     expect((await upload(tight,w,b,w.owner.token)).statusCode).toBe(201)
     const third=await upload(tight,w,a,w.owner.token)
     expect(third.statusCode).toBe(409);expect(third.json().error.code).toBe('receipt_quota')
     expect((await app.db!.query('select 1 from payment_receipts where wedding_id=$1',[w.id])).rows).toHaveLength(2)
   })
 })

 it('BB-01: квота свадьбы по байтам — файл, который её превысит, не записан',async()=>{
   await withApp({receiptsMaxBytesPerWedding:15},async tiny=>{
     const w=await setup(),pid=await payment(w)
     expect((await upload(tiny,w,pid,w.owner.token)).statusCode).toBe(201) // 9 байт
     const second=await upload(tiny,w,pid,w.owner.token) // 9 + 9 > 15
     expect(second.statusCode).toBe(409);expect(second.json().error.code).toBe('receipt_quota')
   })
 })

 it('BB-02: стирание партнёра, загрузившего чек, проходит — свадьба и чек остаются, автор обнулён',async()=>{
   const w=await setup(),partner=await partnerOf(w),pid=await payment(w)
   const add=await upload(app,w,pid,partner.token);expect(add.statusCode,add.body).toBe(201)
   // До фикса `delete from users` падал на внешнем ключе `uploaded_by` (23503) — уборка удалённых не стирала аккаунт никогда.
   await app.db!.tx(client=>eraseUser(client,partner.id))
   expect((await app.db!.query('select 1 from users where id=$1',[partner.id])).rows).toHaveLength(0)
   expect(await receiptRow(add.json().id)).toEqual({uploaded_by:null})
   expect((await app.db!.query('select owner_id from weddings where id=$1',[w.id])).rows[0]).toEqual({owner_id:w.owner.id})
 })

 it('BB-02: вход по коду на номер, стёртый по сроку, проходит и заводит новый аккаунт, чек остаётся',async()=>{
   const w=await setup(),partner=await partnerOf(w),pid=await payment(w)
   const add=await upload(app,w,pid,partner.token);expect(add.statusCode,add.body).toBe(201)
   const {rows:[row]}=await app.db!.query<{phone:string}>('select phone from users where id=$1',[partner.id])
   await app.db!.query("update users set deleted_at=now()-interval '31 days' where id=$1",[partner.id])
   expect((await app.inject({method:'POST',url:'/auth/otp',payload:{phone:row!.phone},remoteAddress:IP})).statusCode).toBe(200)
   const {rows:[otp]}=await app.db!.query<{code_hash:string}>('select code_hash from otp_codes where phone=$1 order by created_at desc limit 1',[row!.phone])
   let code=''
   for(let i=0;i<10000&&!code;i++){const c=String(i).padStart(4,'0');if(hashCode(SECRET_R,row!.phone,c)===otp!.code_hash)code=c}
   // До фикса вход стирал просроченную строку тем же `eraseUser` — и отвечал 500 на внешнем ключе чека.
   const verify=await app.inject({method:'POST',url:'/auth/otp/verify',payload:{phone:row!.phone,code}})
   expect(verify.statusCode,verify.body).toBe(200)
   expect(verify.json().user.id).not.toBe(partner.id)
   expect(await receiptRow(add.json().id)).toEqual({uploaded_by:null})
 })

 it('BB-10: имя файла — без невидимых символов, с расширением проверенного типа',async()=>{
   const w=await setup(),pid=await payment(w)
   const add=await upload(app,w,pid,w.owner.token,'чек‮gnp.exe')
   expect(add.statusCode,add.body).toBe(201);expect(add.json().filename).toBe('чекgnp.png')
   const list=await app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:headers(w)})
   expect(list.json().items[0].filename).toBe('чекgnp.png')
   const blank=await upload(app,w,pid,w.owner.token,'​​')
   expect(blank.statusCode).toBe(422)
 })

 it('BB-14: журнал добавления и удаления — оплата, тип, размер и SHA-256, без имени файла',async()=>{
   const w=await setup(),pid=await payment(w)
   const add=await upload(app,w,pid,w.owner.token,'Паспорт Иванова.png'),rid=add.json().id
   expect((await app.inject({method:'DELETE',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}`,headers:headers(w)})).statusCode).toBe(204)
   const {rows}=await app.db!.query<{action:string;actor_id:string;diff:Record<string,unknown>}>(
     "select action,actor_id,diff from audit_log where entity='payment_receipt' and entity_id=$1 order by id",[rid])
   const sha256=createHash('sha256').update(Buffer.from(png,'base64')).digest('hex')
   const expected={paymentId:pid,mimeType:'image/png',sizeBytes:9,sha256}
   expect(rows).toEqual([
     {action:'payment.receipt_added',actor_id:w.owner.id,diff:expected},
     {action:'payment.receipt_deleted',actor_id:w.owner.id,diff:expected}])
   expect(JSON.stringify(rows)).not.toContain('Паспорт')
 })

 /* Хук пускает по данным на начало запроса; роль снимают, пока запрос в пути.
  * Партнёра удаляют из команды в открытой транзакции, запрос упирается в её
  * блокировку строки участника, транзакция фиксируется — запись должна увидеть,
  * что партнёра больше нет. До фикса запись участника не читалась вовсе:
  * запрос не ждал никого и записывал (ревью 018, BB-05). */
 async function revokedMidway(w:Awaited<ReturnType<typeof setup>>,partnerId:string,send:()=>Promise<{statusCode:number}>){
   let blocked=false,pending!:Promise<{statusCode:number}>
   await app.db!.tx(async client=>{
     await client.query('delete from wedding_members where wedding_id=$1 and user_id=$2',[w.id,partnerId])
     const {rows:[me]}=await client.query<{pid:number}>('select pg_backend_pid() as pid')
     pending=send()
     for(let waited=0;waited<5000&&!blocked;waited+=20){
       await new Promise(resolve=>setTimeout(resolve,20))
       await client.query('select pg_stat_clear_snapshot()')
       const {rows}=await client.query<{n:number}>('select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',[me!.pid])
       blocked=rows[0]!.n>0
     }
   })
   expect(blocked,'запись не перепроверила участника под блокировкой').toBe(true)
   return pending
 }

 it('BB-05: резерв — снятого из команды посреди запроса партнёра не пускают, ничего не записано',async()=>{
   const w=await setup(),partner=await partnerOf(w)
   const res=await revokedMidway(w,partner.id,()=>app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,
     headers:{authorization:'Bearer '+partner.token},payload:{reserveBps:3000,version:0}}))
   expect(res.statusCode).toBe(404)
   expect((await app.db!.query('select 1 from wedding_budget_settings where wedding_id=$1',[w.id])).rows).toHaveLength(0)
 })

 it('BB-05: чек — снятого из команды посреди запроса партнёра не пускают, файл не записан',async()=>{
   const w=await setup(),partner=await partnerOf(w),pid=await payment(w)
   const res=await revokedMidway(w,partner.id,()=>upload(app,w,pid,partner.token))
   expect(res.statusCode).toBe(404)
   expect((await app.db!.query('select 1 from payment_receipts where payment_id=$1',[pid])).rows).toHaveLength(0)
 })

 it('BB-05: одновременные записи одного лимита — одна проходит, остальные 409, без 500',async()=>{
   const w=await setup()
   const all=await Promise.all(Array.from({length:6},(_,i)=>app.inject({method:'PUT',url:`/weddings/${w.id}/budget/categories/b3/limit`,
     headers:headers(w),payload:{amount:money(1_000_000+i),version:0}})))
   expect(all.map(r=>r.statusCode).sort()).toEqual([200,409,409,409,409,409])
 })

 it('BB-12: сброс лимита — неизвестная категория 422, как у PUT; версия 0 — отказ схемы',async()=>{
   const w=await setup()
   const unknown=await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/categories/nope/limit`,headers:headers(w),payload:{reset:true,version:1}})
   expect(unknown.statusCode).toBe(422);expect(unknown.json().error.fields).toHaveProperty('categoryId')
   const zero=await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:headers(w),payload:{reset:true,version:0}})
   expect(zero.statusCode).toBe(422);expect(zero.json().error.fields).toHaveProperty('version')
 })

 /* Сбой фиксации: отложенный триггер роняет COMMIT, а не запрос внутри
  * транзакции. Ответ изнутри транзакции уходил клиенту до COMMIT — клиент
  * получал 204, а база откатывалась (ревью 018, BB-03). Имя уникально, условие —
  * по свадьбе: соседние наборы триггер не замечают; файл — в vitest.serial.json. */
 async function failCommit(table:string,event:'update'|'delete',weddingId:string,fn:()=>Promise<void>){
   const name=`budget018b_fail_${randomUUID().replaceAll('-','')}`
   const row=event==='delete'?'old':'new'
   await app.db!.query(`create function ${name}() returns trigger language plpgsql as $$
     begin if ${row}.wedding_id = '${weddingId}' then raise exception 'commit fault injected by 018-B test'; end if; return null; end $$`)
   await app.db!.query(`create constraint trigger ${name} after ${event} on ${table} deferrable initially deferred
     for each row execute function ${name}()`)
   try{await fn()}finally{
     await app.db!.query(`drop trigger if exists ${name} on ${table}`)
     await app.db!.query(`drop function if exists ${name}()`)
   }
 }

 it('BB-03: сброс лимита — 204 только после фиксации; сбой COMMIT даёт 500, лимит остаётся',async()=>{
   const w=await setup()
   expect((await app.inject({method:'PUT',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:headers(w),payload:{amount:money(2_500_000),version:0}})).statusCode).toBe(200)
   await failCommit('budget_category_limits','update',w.id,async()=>{
     const res=await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:headers(w),payload:{reset:true,version:1}})
     expect(res.statusCode).toBe(500)
   })
   const cat=(await budget(w)).json().categories.find((x:{id:string})=>x.id==='b2')
   expect(cat).toMatchObject({limitCustom:true,limitVersion:1})
 })

 it('BB-03: удаление чека — 204 только после фиксации; сбой COMMIT даёт 500, файл на месте',async()=>{
   const w=await setup(),pid=await payment(w),rid=(await upload(app,w,pid,w.owner.token)).json().id
   await failCommit('payment_receipts','delete',w.id,async()=>{
     const res=await app.inject({method:'DELETE',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}`,headers:headers(w)})
     expect(res.statusCode).toBe(500)
   })
   expect(await receiptRow(rid)).toBeDefined()
 })

 it('BB-06: выгрузка пары — резерв, лимиты и список подтверждений без содержимого; помощнику — ничего',async()=>{
   const w=await setup(),pid=await payment(w),helper=await user()
   await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,helper.id])
   expect((await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:headers(w),payload:{reserveBps:1500,version:0}})).statusCode).toBe(200)
   expect((await app.inject({method:'PUT',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:headers(w),payload:{amount:money(2_500_000),version:0}})).statusCode).toBe(200)
   const rid=(await upload(app,w,pid,w.owner.token)).json().id
   const out=await app.inject({method:'GET',url:'/users/me/export',headers:headers(w)})
   expect(out.statusCode).toBe(200)
   const mine=(key:string)=>(out.json()[key] as Record<string,unknown>[]).filter(r=>r['wedding_id']===w.id)
   expect(mine('budgetSettings')).toMatchObject([{reserve_bps:1500,version:1}])
   expect(mine('budgetLimits')).toMatchObject([{category_id:'b2',amount:'2500000',currency:'RUB',is_custom:true}])
   expect(mine('paymentReceipts')).toMatchObject([{id:rid,payment_id:pid,filename:'чек.png',mime_type:'image/png',size_bytes:9}])
   expect(Object.keys(mine('paymentReceipts')[0]!)).not.toContain('content')
   expect(out.body).not.toContain(png)
   const theirs=(await app.inject({method:'GET',url:'/users/me/export',headers:{authorization:'Bearer '+helper.token}})).json()
   for(const key of ['budgetSettings','budgetLimits','paymentReceipts'])
     expect((theirs[key] as Record<string,unknown>[]).filter(r=>r['wedding_id']===w.id)).toEqual([])
 })

 /* ── ревью 018, BB-09/BF-17: заявленное, но не проверенное ───────────── */
 const pdf=Buffer.from('%PDF-1.4\n%чек\n').toString('base64')
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,16]).toString('base64')
 const webp=Buffer.concat([Buffer.from('RIFF'),Buffer.from([4,0,0,0]),Buffer.from('WEBP')]).toString('base64')
 const post=(w:{id:string},pid:string,token:string,body:Record<string,unknown>)=>app.inject({method:'POST',url:`/weddings/${w.id}/payments/${pid}/receipts`,
   headers:{authorization:'Bearer '+token,'idempotency-key':randomUUID()},payload:body})

 it('BB-09: сигнатуры PDF, JPEG и WebP принимаются; тип, не совпавший с содержимым, — 422',async()=>{
   const w=await setup(),pid=await payment(w)
   for(const [filename,mimeType,contentBase64] of [['a.pdf','application/pdf',pdf],['b.jpg','image/jpeg',jpeg],['c.webp','image/webp',webp]] as const)
     expect((await post(w,pid,w.owner.token,{filename,mimeType,contentBase64})).statusCode).toBe(201)
   const wrong=await post(w,pid,w.owner.token,{filename:'d.webp',mimeType:'image/webp',contentBase64:jpeg})
   expect(wrong.statusCode).toBe(422);expect(wrong.json().error.fields).toHaveProperty('mimeType')
 })

 it('BB-09: 512 КиБ ровно — принимается, на байт больше — 422; неканонический base64 — 422',async()=>{
   const w=await setup(),pid=await payment(w)
   const exact=Buffer.alloc(524288);Buffer.from([137,80,78,71,13,10,26,10]).copy(exact)
   expect((await post(w,pid,w.owner.token,{filename:'max.png',mimeType:'image/png',contentBase64:exact.toString('base64')})).statusCode).toBe(201)
   const over=Buffer.alloc(524289);Buffer.from([137,80,78,71,13,10,26,10]).copy(over)
   const big=await post(w,pid,w.owner.token,{filename:'big.png',mimeType:'image/png',contentBase64:over.toString('base64')})
   expect(big.statusCode).toBe(422);expect(big.json().error.fields).toHaveProperty('contentBase64')
   // «…Ggp=» — у «p» лишний младший бит перед «=»: Buffer.from молча отбросит его и даст те же 8 байт
   // сигнатуры PNG, а сверка с каноническим «…Ggo=» — нет.
   const odd=await post(w,pid,w.owner.token,{filename:'odd.png',mimeType:'image/png',contentBase64:'iVBORw0KGgp='})
   expect(odd.statusCode).toBe(422)
 })

 it('BB-09: шестой файл к одной оплате — 409 receipt_limit; две гонящиеся загрузки на пятое место — одна проходит',async()=>{
   const w=await setup(),pid=await payment(w)
   for(let i=0;i<4;i++)expect((await upload(app,w,pid,w.owner.token)).statusCode).toBe(201)
   const race=await Promise.all([upload(app,w,pid,w.owner.token),upload(app,w,pid,w.owner.token)])
   expect(race.map(r=>r.statusCode).sort()).toEqual([201,409])
   const sixth=await upload(app,w,pid,w.owner.token)
   expect(sixth.statusCode).toBe(409);expect(sixth.json().error.code).toBe('receipt_limit')
   expect((await app.db!.query('select 1 from payment_receipts where payment_id=$1',[pid])).rows).toHaveLength(5)
 })

 it('BB-09: чужая свадьба — список, загрузка и удаление по чужой оплате отвечают 404',async()=>{
   const w=await setup(),pid=await payment(w),rid=(await upload(app,w,pid,w.owner.token)).json().id,other=await setup()
   const h={authorization:'Bearer '+other.owner.token}
   expect((await app.inject({method:'GET',url:`/weddings/${other.id}/payments/${pid}/receipts`,headers:h})).statusCode).toBe(404)
   expect((await upload(app,other,pid,other.owner.token)).statusCode).toBe(404)
   expect((await app.inject({method:'DELETE',url:`/weddings/${other.id}/payments/${pid}/receipts/${rid}`,headers:h})).statusCode).toBe(404)
   expect(await receiptRow(rid)).toBeDefined()
 })

 it('BB-09: помощник и координатор — 403 на все пути чеков и лимитов, ничего не записано',async()=>{
   const w=await setup(),pid=await payment(w),rid=(await upload(app,w,pid,w.owner.token)).json().id
   for(const role of ['helper','coordinator']){
     const member=await user()
     await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)',[w.id,member.id,role])
     const h={authorization:'Bearer '+member.token}
     const calls=[
       app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts`,headers:h}),
       upload(app,w,pid,member.token),
       app.inject({method:'GET',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}/content`,headers:h}),
       app.inject({method:'DELETE',url:`/weddings/${w.id}/payments/${pid}/receipts/${rid}`,headers:h}),
       app.inject({method:'PUT',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:h,payload:{amount:money(100),version:0}}),
       app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:h,payload:{reset:true,version:1}}),
       app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:h,payload:{reserveBps:0,version:0}}),
     ]
     expect((await Promise.all(calls)).map(r=>r.statusCode),role).toEqual([403,403,403,403,403,403,403])
   }
   expect((await app.db!.query('select 1 from payment_receipts where wedding_id=$1',[w.id])).rows).toHaveLength(1)
   expect((await app.db!.query('select 1 from budget_category_limits where wedding_id=$1',[w.id])).rows).toHaveLength(0)
 })

 it('BB-09: резерв вне 0–5000 б. п. — 422, ничего не записано',async()=>{
   const w=await setup()
   for(const reserveBps of [-1,5001,12.5])
     expect((await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:headers(w),payload:{reserveBps,version:0}})).statusCode,String(reserveBps)).toBe(422)
   expect((await app.db!.query('select 1 from wedding_budget_settings where wedding_id=$1',[w.id])).rows).toHaveLength(0)
 })

 it('BB-08: подсказка о перерасходе не обещает резерв, которого нет',async()=>{
   const w=await setup()
   // Сделка «Фото» на 10 000 ₽ в категории фото; лимит категории — 1 000 ₽: перерасход.
   expect((await app.inject({method:'PUT',url:`/weddings/${w.id}/budget/categories/b2/limit`,headers:headers(w),payload:{amount:money(100_000),version:0}})).statusCode).toBe(200)
   const tip=async()=>((await app.inject({method:'GET',url:`/weddings/${w.id}/tips`,headers:headers(w)})).json().items as {kind:string;categoryId:string;body:string}[])
     .find(x=>x.kind==='budget'&&x.categoryId==='b2')
   expect((await tip())?.body).toContain('за счёт резерва')
   expect((await app.inject({method:'PATCH',url:`/weddings/${w.id}/budget/settings`,headers:headers(w),payload:{reserveBps:0,version:0}})).statusCode).toBe(200)
   const body=(await tip())?.body
   expect(body).toContain('резерв выключен');expect(body).not.toContain('за счёт резерва')
 })
})

describe('018-B: имя файла подтверждения (ревью 018, BB-10)',()=>{
 it.each([
   ['чек.png','image/png','чек.png'],
   ['scan.PDF','application/pdf','scan.PDF'],
   ['photo.jpeg','image/jpeg','photo.jpeg'],
   ['photo.jpg','image/jpeg','photo.jpg'],
   ['invoice.pdf','image/png','invoice.png'],
   ['noext','image/webp','noext.webp'],
   ['чек‮gnp.exe','image/png','чекgnp.png'],
   ['a/b\\c\u0000d\u0085.png','image/png','a_b_c_d_.png'],
   ['  имя  .pdf ','application/pdf','имя.pdf'],
   ['​​','image/png',''],
 ])('%j (%s) → %j',(raw,mime,expected)=>{
   expect(receiptFilename(raw,mime)).toBe(expected)
 })
 it('после правки расширения имя не длиннее 180 символов',()=>{
   const result=receiptFilename('я'.repeat(180),'image/png')
   expect(Array.from(result)).toHaveLength(180);expect(result.endsWith('.png')).toBe(true)
 })
})
