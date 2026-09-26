import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48)
const money = (amount: number) => ({ amount, currency: 'RUB' })
describe.skipIf(!DB)('018-A: график платежей — деньги, права и версии', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: '2026-09-02' })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })
  async function user() {
    const id = randomUUID(), sid = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [id,'+79'+randomInt(100000000,999999999),'Payment test'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid,id,randomUUID()])
    await app.db!.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(),id])
    return { id, token: await signAccessToken(SECRET, { sub:id, sid }) }
  }
  async function setup(price = 1000000) {
    const owner = await user(), id = randomUUID(), slotId = randomUUID(), dealId = randomUUID()
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code) values($1,$2,'Payment test','2027-06-14','Asia/Yekaterinburg',5000000,$3)", [id,owner.id,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [id,owner.id])
    await app.db!.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Фотограф')", [slotId,id])
    await app.db!.query("insert into deals(id,wedding_id,slot_id,external_name,state,price,booked_at) values($1,$2,$3,'Фотограф','booked',$4,now())", [dealId,id,slotId,price])
    await app.db!.query('update slots set deal_id=$2 where id=$1',[slotId,dealId])
    return { id, owner, slotId, dealId }
  }
  type W = Awaited<ReturnType<typeof setup>>
  const headers = (w: W, key = randomUUID()) => ({ authorization:'Bearer '+w.owner.token, 'idempotency-key':key })
  const create = (w: W, body: Record<string, unknown> = {}, key = randomUUID()) => app.inject({ method:'POST', url:`/weddings/${w.id}/payment-schedule`, headers:headers(w,key), payload:{dealId:w.dealId,title:'Аванс',due:'2027-05-01',amount:money(400000),...body} })
  const read = (w: W, query = '?from=2027-01-01&to=2027-12-31') => app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule${query}`,headers:headers(w)})
  const edit = (w: W, id: string, body: Record<string, unknown>) => app.inject({method:'PATCH',url:`/weddings/${w.id}/payment-schedule/${id}`,headers:headers(w),payload:body})
  const pay = (w: W, id: string, amount: number, version = 1, key = randomUUID()) => app.inject({method:'POST',url:`/weddings/${w.id}/payment-schedule/${id}/pay`,headers:headers(w,key),payload:{amount:money(amount),version}})

  it('создаёт этап, не увеличивая обязательства и не создавая оплату', async () => {
    const w = await setup()
    const res = await create(w)
    expect(res.statusCode,res.body).toBe(201)
    expect(res.json()).toMatchObject({title:'Аванс',due:'2027-05-01',amount:money(400000),paid:money(0),version:1,status:'pending'})
    expect((await read(w)).json().summary).toMatchObject({committed:money(1000000),recorded:money(0),remaining:money(1000000)})
    expect((await app.db!.query('select id from payments where deal_id=$1',[w.dealId])).rowCount).toBe(0)
  })
  it('частичная оплата и повтор ключа дают одну запись, старый слот видит те же деньги', async () => {
    const w = await setup(), stage = await create(w), key = randomUUID()
    expect(stage.statusCode).toBe(201)
    const a = await pay(w,stage.json().id,100000,1,key)
    const b = await pay(w,stage.json().id,100000,1,key)
    expect(a.statusCode,a.body).toBe(200);expect(b.statusCode,b.body).toBe(200)
    expect(a.json()).toMatchObject({paid:money(100000),remaining:money(300000),status:'partial'})
    expect((await app.db!.query('select id from payments where deal_id=$1',[w.dealId])).rowCount).toBe(1)
    const slot = await app.inject({method:'GET',url:`/weddings/${w.id}/slots`,headers:headers(w)})
    expect(slot.statusCode,slot.body).toBe(200)
    expect(slot.json().find((x: {id:string})=>x.id===w.slotId).deal.paid).toEqual(money(100000))
    const budget = await app.inject({method:'GET',url:`/weddings/${w.id}/budget`,headers:headers(w)})
    expect(budget.json().spent).toEqual(money(1000000))
  })
  it('не принимает чужую сделку и не раскрывает деньги helper/coordinator', async () => {
    const a = await setup(), b = await setup()
    expect((await create(a,{dealId:b.dealId})).statusCode).toBe(404)
    for (const role of ['helper','coordinator','vendor']) {
      const u = await user()
      await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)',[a.id,u.id,role])
      const other = {...a,owner:u}
      expect((await read(other)).statusCode).toBe(403)
      expect((await create(other)).statusCode).toBe(403)
    }
  })
  it('не молча перезаписывает устаревшую версию этапа', async () => {
    const w = await setup(), stage = await create(w)
    expect(stage.statusCode).toBe(201)
    const id = stage.json().id
    expect((await edit(w,id,{version:1,title:'Задаток'})).statusCode).toBe(200)
    const stale = await edit(w,id,{version:1,title:'Старый черновик'})
    expect(stale.statusCode,stale.body).toBe(409)
    expect((await read(w)).json().items[0].title).toBe('Задаток')
  })
  it('отмена оплаченного этапа не создаёт возврат и не теряет историю', async () => {
    const w = await setup(), stage = await create(w)
    expect(stage.statusCode).toBe(201)
    const id = stage.json().id
    const paid = await pay(w,id,100000)
    expect(paid.statusCode).toBe(200)
    expect((await edit(w,id,{version:paid.json().version,cancelled:true})).statusCode).toBe(200)
    const result = (await read(w,'?from=2027-01-01&to=2027-12-31&includeCancelled=true')).json()
    expect(result.items[0]).toMatchObject({status:'cancelled',paid:money(100000)})
    expect(result.summary.recorded).toEqual(money(100000))
    expect((await app.db!.query("select id from payments where deal_id=$1 and kind='refund'",[w.dealId])).rowCount).toBe(0)
  })
  it.each(['2027-02-30','2027-13-01'])('не допускает некалендарную дату %s', async due => {
    const w = await setup();expect((await create(w,{due})).statusCode).toBe(422)
  })
  const link = (w: W, paymentId: string, installmentId: string | null, version = 1) => app.inject({method:'PATCH',url:`/weddings/${w.id}/payments/${paymentId}/plan`,headers:headers(w),payload:{version,installmentId}})
  const oldPay = (w: W, amount: number) => app.inject({method:'POST',url:`/weddings/${w.id}/slots/${w.slotId}/pay`,headers:headers(w),payload:{amount:money(amount)}})
  const paymentId = async (w: W) => (await app.db!.query<{id:string}>('select id from payments where deal_id=$1 order by created_at',[w.dealId])).rows[0]!.id
  it('привязывает прежнюю оплату без второй записи и позволяет снять привязку', async () => {
    const w=await setup(), stage=(await create(w)).json()
    expect((await oldPay(w,100000)).statusCode).toBe(200)
    const id=await paymentId(w)
    expect((await read(w)).json().summary.unallocated).toEqual(money(100000))
    const result=await link(w,id,stage.id)
    expect(result.statusCode,result.body).toBe(200)
    const state=(await read(w)).json()
    expect(state.items[0].paid).toEqual(money(100000))
    expect(state.summary.unallocated).toEqual(money(0))
    expect(state.payments).toHaveLength(1)
    expect((await link(w,id,null,result.json().version)).statusCode).toBe(200)
    expect((await read(w)).json().items[0].paid).toEqual(money(0))
  })
  it('не привязывает сумму к другому подрядчику и отклоняет устаревшую привязку', async () => {
    const w=await setup(), other=await setup(), a=(await create(w)).json(), b=(await create(other)).json()
    await oldPay(w,100000)
    const id=await paymentId(w)
    expect((await link(w,id,b.id)).statusCode).toBe(404)
    expect((await link(w,id,a.id)).statusCode).toBe(200)
    expect((await link(w,id,null,1)).statusCode).toBe(409)
    expect((await read(w)).json().items[0].paid).toEqual(money(100000))
  })
  it('две оплаты из одной версии не проходят обе и не превышают остаток', async () => {
    const w=await setup(), stage=(await create(w)).json()
    const results=await Promise.all([pay(w,stage.id,300000),pay(w,stage.id,300000)])
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409])
    expect((await read(w)).json().summary.recorded).toEqual(money(300000))
  })
  it('старый и новый способы оплаты используют один предел цены сделки', async () => {
    const w=await setup(1000000), stage=(await create(w,{amount:money(1000000)})).json()
    const results=await Promise.all([pay(w,stage.id,700000),oldPay(w,700000)])
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409])
    expect((await read(w)).json().summary.recorded).toEqual(money(700000))
  })
  it('не повторяет оплату при другом теле с прежним ключом', async () => {
    const w=await setup(), stage=(await create(w)).json(), key=randomUUID()
    expect((await pay(w,stage.id,100000,1,key)).statusCode).toBe(200)
    expect((await pay(w,stage.id,200000,1,key)).statusCode).toBe(409)
    expect((await read(w)).json().payments).toHaveLength(1)
  })
  it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('отклоняет невалидную сумму %s без записей', async amount=>{
    const w=await setup();expect((await create(w,{amount:money(amount)})).statusCode).toBe(422)
    expect((await read(w)).json().items).toHaveLength(0)
  })
  it('отклоняет чужую валюту, пустое название и превышение цены',async()=>{
    const w=await setup()
    expect((await create(w,{amount:{amount:100,currency:'USD'}})).statusCode).toBe(422)
    expect((await create(w,{title:'  '})).statusCode).toBe(422)
    expect((await create(w,{amount:money(1000001)})).statusCode).toBe(409)
    await create(w,{amount:money(800000)})
    expect((await create(w,{amount:money(300000)})).statusCode).toBe(409)
  })
  it('не скрывает изменение суммы внутри отмены и не уменьшает ниже оплаченного',async()=>{
    const w=await setup(), stage=(await create(w)).json(), paid=(await pay(w,stage.id,100000)).json()
    expect((await edit(w,stage.id,{version:paid.version,amount:money(99999)})).statusCode).toBe(409)
    expect((await edit(w,stage.id,{version:paid.version,cancelled:true,amount:money(1)})).statusCode).toBe(422)
    expect((await read(w)).json().items[0].amount).toEqual(money(400000))
  })
  it('возврат уменьшает итог, отменённая отметка не считается, версии обновляются',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    await pay(w,stage.id,300000)
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status,installment_id) values($1,$2,'refund',100000,'recorded',$3)",[randomUUID(),w.dealId,stage.id])
    const data=(await read(w)).json()
    expect(data.items[0]).toMatchObject({paid:money(200000),remaining:money(200000),version:3})
    expect(data.summary.recorded).toEqual(money(200000))
    await app.db!.query("update payments set status='cancelled' where deal_id=$1 and kind='refund'",[w.dealId])
    expect((await read(w)).json().items[0]).toMatchObject({paid:money(300000),version:4})
  })
  it('отмена сделки снимает планы, но удержанные деньги остаются в истории',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    await pay(w,stage.id,100000)
    const cancel=await app.inject({method:'PATCH',url:`/deals/${w.dealId}`,headers:headers(w),payload:{state:'cancelled'}})
    expect(cancel.statusCode,cancel.body).toBe(200)
    const state=(await read(w,'?from=2027-01-01&to=2027-12-31&includeCancelled=true')).json()
    expect(state.items[0].status).toBe('cancelled')
    expect(state.summary.committed).toEqual(money(0))
    expect(state.summary.inactiveDealRecorded).toEqual(money(100000))
    expect(state.payments).toHaveLength(1)
    expect((await pay(w,stage.id,1,state.items[0].version)).statusCode).toBe(409)
  })
  it('перенос свадьбы не сдвигает согласованные даты платежей',async()=>{
    const w=await setup();await create(w)
    const moved=await app.inject({method:'PATCH',url:`/weddings/${w.id}`,headers:headers(w),payload:{date:'2027-07-20'}})
    expect(moved.statusCode,moved.body).toBe(200)
    expect((await read(w)).json().items[0].due).toBe('2027-05-01')
  })
  it('снижение цены требует явной сверки плана, старая версия недействительна',async()=>{
    const w=await setup(), stage=(await create(w,{amount:money(900000)})).json()
    const price=await app.inject({method:'PATCH',url:`/deals/${w.dealId}`,headers:headers(w),payload:{price:money(700000)}})
    expect(price.statusCode,price.body).toBe(200)
    const data=(await read(w)).json()
    expect(data.deals[0].needsReview).toBe(true)
    expect((await edit(w,stage.id,{version:1,amount:money(700000)})).statusCode).toBe(409)
    expect((await edit(w,stage.id,{version:data.items[0].version,amount:money(700000)})).statusCode).toBe(200)
    expect((await read(w)).json().deals[0].needsReview).toBe(false)
  })
  it('отдельно фильтрует окно, просрочки и отменённые этапы',async()=>{
    const w=await setup()
    const yesterday=new Date();yesterday.setUTCDate(yesterday.getUTCDate()-2)
    await create(w,{title:'Просрочено',due:yesterday.toISOString().slice(0,10)})
    await create(w,{title:'План',due:'2027-05-01'})
    expect((await read(w,'?from=2027-05-01&to=2027-05-01&includeOverdue=false')).json().items).toHaveLength(1)
    expect((await read(w,'?from=2027-05-01&to=2027-05-01')).json().items).toHaveLength(2)
    expect((await read(w,'?from=2027-05-02&to=2027-05-01')).statusCode).toBe(422)
    expect((await read(w,'?from=2027-01-01&to=2029-01-01')).statusCode).toBe(422)
  })
  it('CSV различает планы и оплаты, нейтрализует формулы и закрыт чужому',async()=>{
    const w=await setup();await create(w,{title:'=HYPERLINK("bad")'})
    await oldPay(w,100000)
    const csv=await app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule/export`,headers:headers(w)})
    expect(csv.statusCode,csv.body).toBe(200)
    expect(csv.json().records).toBe(2)
    expect(csv.json().csv).toContain('"plan"')
    expect(csv.json().csv).toContain('"payment"')
    expect(csv.json().csv).toContain("'=HYPERLINK")
    const other=await user()
    expect((await app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule/export`,headers:{authorization:'Bearer '+other.token}})).statusCode).toBe(404)
  })
  it('CSV сохраняет возврат числом со знаком минус, не текстом формулы',async()=>{
    const w=await setup();await oldPay(w,100000)
    await app.db!.query("insert into payments(id,deal_id,kind,amount,status) values($1,$2,'refund',25000,'recorded')",[randomUUID(),w.dealId])
    const result=await app.inject({method:'GET',url:`/weddings/${w.id}/payment-schedule/export`,headers:headers(w)})
    expect(result.statusCode,result.body).toBe(200)
    expect(result.json().csv).toContain('"-25000";"RUB"')
    expect(result.json().csv).not.toContain("'-25000")
  })
  it('удалённая или отменённая свадьба не принимает финансовые изменения',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    await app.db!.query('update weddings set cancelled_at=now() where id=$1',[w.id])
    expect((await read(w)).json().readOnly).toBe(true)
    expect((await pay(w,stage.id,1)).statusCode).toBe(409)
    expect((await create(w)).statusCode).toBe(409)
    await app.db!.query('update weddings set archived_at=now() where id=$1',[w.id])
    expect((await read(w)).statusCode).toBe(404)
  })
  it('отказ аудита откатывает оплату и не оставляет ложную отметку',async()=>{
    const w=await setup(), stage=(await create(w)).json(), fn='plan_fault_'+randomUUID().replaceAll('-','')
    await app.db!.query(`create function ${fn}() returns trigger language plpgsql as $$ begin
      if new.actor_id='${w.owner.id}' and new.action='payment.recorded' then raise exception 'injected audit failure'; end if; return new; end $$`)
    await app.db!.query(`create trigger ${fn} before insert on audit_log for each row execute function ${fn}()`)
    try {
      expect((await pay(w,stage.id,100000)).statusCode).toBe(500)
      expect((await read(w)).json().payments).toHaveLength(0)
      expect((await read(w)).json().items[0].version).toBe(1)
    } finally {
      await app.db!.query(`drop trigger ${fn} on audit_log; drop function ${fn}()`)
    }
  })
  it('бюджет и Тиль используют тот же итог оплат, не сумму этапов',async()=>{
    const {weddingContext}=await import('../src/tilly/context.js')
    const w=await setup(), stage=(await create(w)).json();await pay(w,stage.id,100000)
    const budget=(await app.inject({method:'GET',url:`/weddings/${w.id}/budget`,headers:headers(w)})).json()
    expect(budget.paymentSummary).toEqual((await read(w)).json().summary)
    const context=await weddingContext(app.db!,w.id)
    expect(context.text).toContain('Отмечено оплат за вычетом возвратов 1 000 ₽')
    // Цены сделок — часть итога обязательств, а не второе «обязательства» рядом (ревью 018, M-08).
    expect(context.text).toContain('это часть итога выше, не прибавляй')
  })

  it('берёт замок свадьбы раньше пользователя: перенос и удаление аккаунта не образуют новый deadlock',async()=>{
    const w=await setup(), stage=(await create(w)).json()
    let startPayment: Promise<Awaited<ReturnType<typeof pay>>> | undefined
    await app.db!.tx(async tx=>{
      await tx.query('select id from weddings where id=$1 for update',[w.id])
      startPayment=pay(w,stage.id,100000)
      await new Promise(resolve=>setTimeout(resolve,80))
      await tx.query("set local lock_timeout='800ms'")
      await tx.query('select id from users where id=$1 for update',[w.owner.id])
    })
    const res=await startPayment!
    expect(res.statusCode,res.body).toBe(200)
  })

})
