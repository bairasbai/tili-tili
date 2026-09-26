import { ref } from '../contract/schemas.generated.js'
import type { components } from '../contract/api.generated.js'
import { weddingAccessHook } from '../wedding/access.js'
import type { FastifyInstance } from 'fastify'
import { AppError,conflict,notFound,validationFailed } from '../errors.js'
import { uuidv7,isUuid } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { assertRealDate } from '../wedding/dates.js'
import { assertPayable,assertVersion,asMoney,installment,lockDeal,lockFinanceAccess,recordPayment,toInstallment } from '../payments/model.js'
import { financialExport,financialToday,loadPaymentSchedule,type ScheduleQuery } from '../payments/read.js'
import type { Queryable } from '../plugins/db.js'

const DATE={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'} as const
type Schemas = components['schemas']

export async function paymentScheduleRoutes(app:FastifyInstance):Promise<void> {
  // Authorize even malformed requests before schema validation, including guest-token queries.
  app.addHook('preValidation', weddingAccessHook(app))
  const db=()=>{if(!app.db)throw new AppError(503,'db_unavailable','База недоступна');return app.db}
  const output=async(tx:Queryable,weddingId:string,id:string)=>toInstallment(await installment(tx,weddingId,id),(await financialToday(tx,weddingId)).today)
  // A single consistent snapshot for the calendar, totals and existing payment history.
  app.get('/weddings/:weddingId/payment-schedule',{schema:{querystring:{type:'object',additionalProperties:false,properties:{
    from:DATE,to:DATE,includeOverdue:{type:'boolean',default:true},includeCancelled:{type:'boolean',default:false}}}}},async request=>db().tx(async tx=>{
      await tx.query('set transaction isolation level repeatable read read only')
      return loadPaymentSchedule(tx,request.member!.weddingId,request.query as ScheduleQuery)
    }))
  app.get('/weddings/:weddingId/payment-schedule/export',async request=>financialExport(db(),request.member!.weddingId))

  app.post('/weddings/:weddingId/payment-schedule', { schema: { body: ref('PaymentInstallmentCreate') } }, async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId
    const body=request.body as Schemas['PaymentInstallmentCreate']
    assertRealDate(body.due,'due')
    if(!body.title.trim())throw validationFailed({title:'Введите название этапа'})
    return withIdempotency(db(),request,reply,'payment-schedule.create',tx=>tx(async client=>{
      await lockFinanceAccess(client,wid,uid)
      const deal=await lockDeal(client,wid,body.dealId);assertPayable(deal)
      const {rows}=await client.query<{amount:string;n:number}>(`select coalesce(sum(amount) filter(where cancelled_at is null),0)::text as amount,
        count(*)::int as n from payment_installments where deal_id=$1`,[deal.id])
      if(rows[0]!.n>=500)throw conflict('payment_plan_limit','В одной сделке допускается до 500 этапов')
      if(BigInt(rows[0]!.amount)+BigInt(body.amount.amount)>BigInt(deal.price!))throw conflict('plan_over_price','Сумма активных этапов превысила цену сделки')
      const id=uuidv7()
      await client.query('insert into payment_installments(id,deal_id,title,amount,due) values($1,$2,$3,$4,$5)',[id,deal.id,body.title.trim(),body.amount.amount,body.due])
      await audit(client,uid,id,'payment_plan.created',{dealId:deal.id,amount:body.amount.amount,due:body.due})
      return {status:201,body:await output(client,wid,id)}
    }))
  })
  app.patch('/weddings/:weddingId/payment-schedule/:installmentId', { schema: { body: ref('PaymentInstallmentPatch') } }, async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId,id=(request.params as {installmentId:string}).installmentId
    const body=request.body as Schemas['PaymentInstallmentPatch']
    if(body.due!==undefined)assertRealDate(body.due,'due')
    if(body.title!==undefined&&!body.title.trim())throw validationFailed({title:'Введите название этапа'})
    if(body.cancelled && (body.title!==undefined || body.amount!==undefined || body.due!==undefined)) throw validationFailed({cancelled:'Отмена выполняется отдельно от изменения суммы, названия и срока'})
    if(body.reason!==undefined&&!body.cancelled)throw validationFailed({reason:'Причина указывается при отмене'})
    return withIdempotency(db(),request,reply,'payment-schedule.patch',tx=>tx(async client=>{
      await lockFinanceAccess(client,wid,uid)
      const found=await installment(client,wid,id)
      const deal=await lockDeal(client,wid,found.deal_id)
      const current=await installment(client,wid,id)
      assertVersion(current.version,body.version)
      if(current.cancelled_at)throw conflict('installment_cancelled','Этап платежа отменён')
      if(!body.cancelled){
        assertPayable(deal)
        const amount=BigInt(body.amount?.amount??current.amount)
        if(amount<BigInt(current.paid))throw conflict('plan_below_paid','Сумма этапа меньше уже отмеченных оплат')
        const {rows}=await client.query<{amount:string}>('select coalesce(sum(amount),0)::text as amount from payment_installments where deal_id=$1 and cancelled_at is null',[deal.id])
        const before=BigInt(rows[0]!.amount),after=before-BigInt(current.amount)+amount
        // An already inconsistent schedule may be reduced step-by-step, never silently repriced.
        if(after>BigInt(deal.price!)&&after>=before)throw conflict('plan_over_price','Сумма активных этапов превысила цену сделки')
      }
      await client.query(`update payment_installments set title=coalesce($2,title),amount=coalesce($3,amount),due=coalesce($4::date,due),
        cancelled_at=case when $5 then now() else cancelled_at end,cancel_reason=case when $5 then $6 else cancel_reason end,
        version=version+1,updated_at=now() where id=$1`,[id,body.title?.trim()??null,body.amount?.amount??null,body.due??null,!!body.cancelled,body.reason??null])
      await audit(client,uid,id,body.cancelled?'payment_plan.cancelled':'payment_plan.updated',{previousVersion:current.version,...body})
      return {status:200,body:await output(client,wid,id)}
    }))
  })
  app.post('/weddings/:weddingId/payment-schedule/:installmentId/pay', { schema: { body: ref('PaymentInstallmentPay') } }, async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId,id=(request.params as {installmentId:string}).installmentId
    const body=request.body as Schemas['PaymentInstallmentPay']
    return withIdempotency(db(),request,reply,'payment-schedule.pay',tx=>tx(async client=>{
      await lockFinanceAccess(client,wid,uid)
      const found=await installment(client,wid,id),deal=await lockDeal(client,wid,found.deal_id)
      const current=await installment(client,wid,id);assertVersion(current.version,body.version)
      const paymentId=await recordPayment(client,deal,uid,body.amount.amount,current)
      await audit(client,uid,paymentId,'payment.recorded',{installmentId:id,amount:body.amount.amount})
      return {status:200,body:await output(client,wid,id)}
    }))
  })
  app.patch('/weddings/:weddingId/payments/:paymentId/plan', { schema: { body: ref('PaymentPlanLink') } }, async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId,id=(request.params as {paymentId:string}).paymentId
    const body=request.body as Schemas['PaymentPlanLink']
    if(!isUuid(id))throw notFound('Оплата не найдена')
    return withIdempotency(db(),request,reply,'payments.plan',tx=>tx(async client=>{
      await lockFinanceAccess(client,wid,uid)
      const found=await client.query<{deal_id:string}>(`select p.deal_id from payments p join deals d on d.id=p.deal_id where p.id=$1 and d.wedding_id=$2`,[id,wid])
      if(!found.rows[0])throw notFound('Оплата не найдена')
      const deal=await lockDeal(client,wid,found.rows[0].deal_id)
      const {rows}=await client.query<{plan_version:number;installment_id:string|null;amount:string;kind:string;status:string;created_at:Date}>(
        'select plan_version,installment_id,amount::text as amount,kind,status,created_at from payments where id=$1 for update',[id])
      const p=rows[0]!
      assertVersion(p.plan_version,body.version)
      if(p.status==='cancelled')throw conflict('payment_cancelled','Отметка оплаты отменена')
      const signed=BigInt(p.amount)*(p.kind==='refund'?-1n:1n)
      if(body.installmentId!==null){
        const target=await installment(client,wid,body.installmentId)
        if(target.deal_id!==deal.id)throw validationFailed({installmentId:'Этап относится к другой сделке'})
        if(target.cancelled_at)throw conflict('installment_cancelled','Этап платежа отменён')
        const projected=BigInt(target.paid)+(p.installment_id===target.id?0n:signed)
        if(projected>BigInt(target.amount)||projected<0n)throw conflict('installment_overpay','Отметка не помещается в остаток этапа. Одна отметка привязывается целиком')
      }
      if(p.installment_id && p.installment_id!==body.installmentId){
        const old=await installment(client,wid,p.installment_id)
        if(BigInt(old.paid)-signed<0n)throw conflict('payment_refund_link','Сначала перенесите связанные возвраты, чтобы не получить отрицательный итог этапа')
      }
      await client.query('update payments set installment_id=$2 where id=$1',[id,body.installmentId])
      await audit(client,uid,id,'payment.plan_linked',{from:p.installment_id,to:body.installmentId})
      return {status:200,body:{id,dealId:deal.id,installmentId:body.installmentId,
        version:p.plan_version+(p.installment_id===body.installmentId?0:1),kind:p.kind,amount:asMoney(p.amount),status:p.status,createdAt:p.created_at.toISOString()}}
    }))
  })
}
async function audit(tx:Queryable,uid:string,id:string,action:string,diff:object){
  await tx.query('insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,$3,$4,$5)',[uid,action,'payment_schedule',id,JSON.stringify(diff)])
}
