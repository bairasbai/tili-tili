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
