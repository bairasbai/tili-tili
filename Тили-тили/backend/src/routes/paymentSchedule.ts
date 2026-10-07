import { createHash } from 'node:crypto'
import { ref } from '../contract/schemas.generated.js'
import type { components } from '../contract/api.generated.js'
import { weddingAccessHook } from '../wedding/access.js'
import type { FastifyInstance } from 'fastify'
import { AppError,conflict,notFound,validationFailed } from '../errors.js'
import { uuidv7,isUuid } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { assertDue,assertPayable,assertVersion,asMoney,dealStageRows,financeAudit,installment,lockDeal,lockFinanceAccess,recordPayment,stalePlan,stageViews } from '../payments/model.js'
import { financialExport,financialToday,loadPaymentSchedule,type ScheduleQuery } from '../payments/read.js'
import type { Queryable } from '../plugins/db.js'
import { paymentAmendmentRoutes } from './paymentAmendments.js'
import { amendAndRead, assertVersionCapacity, lockAmendmentContext } from '../payments/amendments.js'

const DATE={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'} as const
type Schemas = components['schemas']

export async function paymentScheduleRoutes(app:FastifyInstance):Promise<void> {
  // Authorize even malformed requests before schema validation, including guest-token queries.
  app.addHook('preValidation', weddingAccessHook(app))
  await paymentAmendmentRoutes(app)
  const db=()=>{if(!app.db)throw new AppError(503,'db_unavailable','База недоступна');return app.db}
  /* Этап в ответе считается так же, как в графике: вместе с остальными этапами сделки,
     на которые ложатся её неразнесённые известные деньги. */
  const output=async(tx:Queryable,weddingId:string,id:string)=>{
    const found=await installment(tx,weddingId,id),{today}=await financialToday(tx,weddingId)
    return stageViews(await dealStageRows(tx,weddingId,found.deal_id),today).find(v=>v.id===id)!
  }
  app.get('/weddings/:weddingId/payment-schedule',{schema:{querystring:{type:'object',additionalProperties:false,properties:{
    from:DATE,to:DATE,includeOverdue:{type:'boolean',default:true},includeCancelled:{type:'boolean',default:false}}}}},async request=>db().tx(async tx=>{
      await tx.query('set transaction isolation level repeatable read read only')
      return loadPaymentSchedule(tx,request.member!.weddingId,request.query as ScheduleQuery)
    }))
  app.get('/weddings/:weddingId/payment-schedule/export',async request=>financialExport(db(),request.member!.weddingId))

  app.post('/weddings/:weddingId/payment-schedule', { schema: { body: ref('PaymentInstallmentCreate') } }, async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId
    const body=request.body as Schemas['PaymentInstallmentCreate']
    assertDue(body.due)
    if(!body.title.trim())throw validationFailed({title:'Введите название этапа'})
    return withIdempotency(db(),request,reply,'payment-schedule.create',tx=>tx(async client=>{
      await lockFinanceAccess(client,wid,uid)
      const deal=await lockDeal(client,wid,body.dealId);assertPayable(deal)
      const {rows}=await client.query<{amount:string;n:number}>(`select coalesce(sum(amount) filter(where cancelled_at is null),0)::text as amount,
        (count(*) filter(where cancelled_at is null))::int as n from payment_installments where deal_id=$1`,[deal.id])
      if(rows[0]!.n>=500)throw conflict('payment_plan_limit','В одной сделке допускается до 500 этапов')
      if(BigInt(rows[0]!.amount)+BigInt(body.amount.amount)>BigInt(deal.price!))throw conflict('plan_over_price','Сумма активных этапов превысила цену сделки')
      const id=uuidv7()
      await client.query('insert into payment_installments(id,deal_id,title,amount,due) values($1,$2,$3,$4,$5)',[id,deal.id,body.title.trim(),body.amount.amount,body.due])
      await financeAudit(client,uid,'payment_installment',id,'payment_plan.created',{dealId:deal.id,amount:body.amount.amount,due:body.due})
      return {status:201,body:await output(client,wid,id)}
    }))
  })

  app.patch('/weddings/:weddingId/payment-schedule/:installmentId', { schema: { body: ref('PaymentInstallmentPatch') } }, async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId,id=(request.params as {installmentId:string}).installmentId
    const body=request.body as Schemas['PaymentInstallmentPatch']
    if(body.due!==undefined)assertDue(body.due)
    if(body.title!==undefined&&!body.title.trim())throw validationFailed({title:'Введите название этапа'})
    if(body.cancelled && (body.title!==undefined || body.amount!==undefined || body.due!==undefined)) throw validationFailed({cancelled:'Отмена выполняется отдельно от изменения суммы, названия и срока'})
    if(body.reason!==undefined&&!body.cancelled)throw validationFailed({reason:'Причина указывается при отмене'})
    reply.header('cache-control','no-store')
    return amendAndRead(db(),request,reply,'payment-schedule.patch',
      (client,write)=>lockAmendmentContext(client,wid,{...request.caller!,policyVersion:app.appConfig.policyVersion},{type:'installment',id},write),async(client,context)=>{
      const found=await installment(client,wid,id)
      const deal=context.deal
      const current=await installment(client,wid,id)
      assertVersion(current.version,body.version)
      if(current.cancelled_at)throw conflict('installment_cancelled','Этап платежа отменён')
      assertVersionCapacity(current.version)
      if(!body.cancelled){
        assertPayable(deal)
        const amount=BigInt(body.amount?.amount??current.amount)
        if(amount<BigInt(current.paid))throw conflict('plan_below_paid','Сумма этапа меньше уже отмеченных оплат')
        const {rows}=await client.query<{amount:string}>('select coalesce(sum(amount),0)::text as amount from payment_installments where deal_id=$1 and cancelled_at is null',[deal.id])
        const before=BigInt(rows[0]!.amount),after=before-BigInt(current.amount)+amount
        if(after>BigInt(deal.price!)&&after>=before)throw conflict('plan_over_price','Сумма активных этапов превысила цену сделки')
      }
      const updated=await client.query<{title:string;amount:string;due:string;cancelled_at:string|null;cancel_reason:string|null;currency:string;version:number}>(`update payment_installments set title=coalesce($2,title),amount=coalesce($3,amount),due=coalesce($4::date,due),
        cancelled_at=case when $5 then now() else cancelled_at end,cancel_reason=case when $5 then $6 else cancel_reason end,
        version=version+1,updated_at=now() where id=$1 and version=$7
        returning title,amount::text,due::text,cancelled_at::text,cancel_reason,currency,version`,[id,body.title?.trim()??null,body.amount?.amount??null,body.due??null,!!body.cancelled,body.reason?.trim()||null,current.version])
      if(updated.rowCount!==1)throw stalePlan()
      const after=updated.rows[0]!
      let eventId:string|null=null
      if(current.title!==after.title || current.amount!==after.amount || current.due!==after.due
        || after.cancelled_at!==null || current.cancel_reason!==after.cancel_reason){
        eventId=uuidv7()
        await client.query(`insert into payment_installment_edits(id,wedding_id,deal_id,installment_id,actor_id,session_id,before_version,after_version,currency,
          before_title,after_title,before_amount,after_amount,before_due,after_due,before_cancelled_at,after_cancelled_at,before_cancel_reason,after_cancel_reason)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [eventId,wid,deal.id,id,uid,request.caller!.sessionId,current.version,after.version,after.currency,current.title,after.title,current.amount,after.amount,current.due,after.due,current.cancelled_at,after.cancelled_at,current.cancel_reason,after.cancel_reason])
      }
      await financeAudit(client,uid,'payment_installment',id,body.cancelled?'payment_plan.cancelled':'payment_plan.updated',{
        previousVersion:current.version,
        ...(eventId?{amendmentId:eventId}:{}),
        changed:(['title','amount','due','reason'] as const).filter(k=>body[k]!==undefined),
        ...(body.amount!==undefined?{amount:body.amount.amount}:{}),...(body.due!==undefined?{due:body.due}:{})})
      return {body:await output(client,wid,found.id),eventId}
    },client=>output(client,wid,id))
  })

  app.post('/weddings/:weddingId/payment-schedule/:installmentId/pay', { schema: { body: ref('PaymentInstallmentPay') } }, async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId,id=(request.params as {installmentId:string}).installmentId
    const body=request.body as Schemas['PaymentInstallmentPay']
    return withIdempotency(db(),request,reply,'payment-schedule.pay',tx=>tx(async client=>{
      await lockFinanceAccess(client,wid,uid)
      const found=await installment(client,wid,id),deal=await lockDeal(client,wid,found.deal_id)
      const current=await installment(client,wid,id);assertVersion(current.version,body.version)
      const amountKnown=body.amountKnown ?? true
      if(amountKnown && body.amount===undefined)throw validationFailed({amount:'Укажите сумму или выберите «Сумма не сохранена»'})
      if(!amountKnown && body.amount!==undefined)throw validationFailed({amount:'Не передавайте сумму, если она не сохраняется'})
      await recordPayment(client,deal,uid,body.amount?.amount,current,{
        amountKnown,paymentMethod:body.paymentMethod ?? 'other',visibility:body.visibility ?? 'private',
        ...(body.paidOn===undefined?{}:{paidOn:body.paidOn})})
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
      const {rows}=await client.query<{plan_version:number;installment_id:string|null;amount:string|null;kind:string;status:string;created_at:Date;
        payment_method:string;visibility:string;amount_known:boolean;paid_on:string}>(
        'select plan_version,installment_id,amount::text as amount,kind,status,created_at,payment_method,visibility,amount_known,paid_on::text as paid_on from payments where id=$1 for update',[id])
      const p=rows[0]!
      assertVersion(p.plan_version,body.version)
      if(p.status==='cancelled')throw conflict('payment_cancelled','Отметка оплаты отменена')
      const changesLink=p.installment_id!==body.installmentId
      if(changesLink)assertVersionCapacity(p.plan_version)
      const signed=p.amount_known && p.amount!==null ? BigInt(p.amount)*(p.kind==='refund'?-1n:1n) : 0n
      if(body.installmentId!==null&&!isUuid(body.installmentId))throw notFound('Этап не найден')
      if(changesLink)await client.query('select id from payment_installments where deal_id=$1 and id=any($2::uuid[]) order by id for update',
        [deal.id,[p.installment_id,body.installmentId].filter((stageId):stageId is string=>stageId!==null)])
      if(body.installmentId!==null){
        const target=await installment(client,wid,body.installmentId)
        if(target.deal_id!==deal.id)throw validationFailed({installmentId:'Этап относится к другой сделке'})
        if(target.cancelled_at)throw conflict('installment_cancelled','Этап платежа отменён')
        if(changesLink)assertVersionCapacity(target.version)
        const projected=BigInt(target.paid)+(p.installment_id===target.id?0n:signed)
        if(projected>BigInt(target.amount)||projected<0n)throw conflict('installment_overpay','Отметка не помещается в остаток этапа. Одна отметка привязывается целиком')
      }
      if(p.installment_id && p.installment_id!==body.installmentId){
        const old=await installment(client,wid,p.installment_id)
        assertVersionCapacity(old.version)
        const rest=BigInt(old.paid)-signed
        if(rest<0n)throw conflict('payment_refund_link','Сначала перенесите связанные возвраты, чтобы не получить отрицательный итог этапа')
        if(rest>BigInt(old.amount))throw conflict('installment_overpay','Без этого возврата оплаты этапа превысят его сумму')
      }
      await client.query('update payments set installment_id=$2 where id=$1',[id,body.installmentId])
      await financeAudit(client,uid,'payment',id,'payment.plan_linked',{from:p.installment_id,to:body.installmentId})
      return {status:200,body:{id,dealId:deal.id,installmentId:body.installmentId,
        version:p.plan_version+(p.installment_id===body.installmentId?0:1),kind:p.kind,amountKnown:p.amount_known,
        amount:p.amount_known && p.amount!==null?asMoney(p.amount):null,paymentMethod:p.payment_method,visibility:p.visibility,
        paidOn:p.paid_on,status:p.status,createdAt:p.created_at.toISOString()}}
    }))
  })

  const receiptsEnabled=()=>app.appConfig.receiptsStorage!==null
  app.get('/weddings/:weddingId/payments/:paymentId/receipts', async request => {
    const wid=request.member!.weddingId,id=(request.params as {paymentId:string}).paymentId
    if(!isUuid(id))throw notFound('Оплата не найдена')
    const {rows: payment}=await db().query(`select 1 from payments p join deals d on d.id=p.deal_id where p.id=$1 and d.wedding_id=$2`,[id,wid])
    if(!payment[0])throw notFound('Оплата не найдена')
    const {rows}=await db().query<{id:string;filename:string;mime_type:string;size_bytes:number;created_at:Date}>(
      'select id,filename,mime_type,size_bytes,created_at from payment_receipts where wedding_id=$1 and payment_id=$2 order by created_at,id',[wid,id])
    return {items:rows.map(r=>({id:r.id,filename:r.filename,mimeType:r.mime_type,sizeBytes:r.size_bytes,createdAt:r.created_at.toISOString()})),
      uploadEnabled:receiptsEnabled()}
  })

  app.post('/weddings/:weddingId/payments/:paymentId/receipts', {
    schema:{body:{type:'object',required:['filename','mimeType','contentBase64'],additionalProperties:false,properties:{
      filename:{type:'string',minLength:1,maxLength:180},
      mimeType:{type:'string',enum:['application/pdf','image/jpeg','image/png','image/webp']},
      contentBase64:{type:'string',minLength:4,maxLength:720000,pattern:'^[A-Za-z0-9+/]+={0,2}$'},
    }}},
  }, async(request,reply)=>{
    if(!receiptsEnabled())throw new AppError(501,'storage_not_configured','Загрузка подтверждений оплаты не включена на сервере')
    const wid=request.member!.weddingId,uid=request.caller!.userId,id=(request.params as {paymentId:string}).paymentId
    if(!isUuid(id))throw notFound('Оплата не найдена')
    const body=request.body as {filename:string;mimeType:string;contentBase64:string}
    const filename=receiptFilename(body.filename,body.mimeType)
    if(!filename)throw validationFailed({filename:'Введите имя файла'})
    const content=Buffer.from(body.contentBase64,'base64')
    if(content.length===0||content.length>RECEIPT_MAX_BYTES)throw validationFailed({contentBase64:'Файл должен быть не больше 512 КБ'})
    if(content.toString('base64').replace(/=+$/,'')!==body.contentBase64.replace(/=+$/,''))throw validationFailed({contentBase64:'Некорректный base64'})
    if(!matchesMime(content,body.mimeType))throw validationFailed({mimeType:'Содержимое файла не соответствует указанному типу'})
    const sha256=createHash('sha256').update(content).digest('hex')
    return withIdempotency(db(),request,reply,'payment-receipt.add',tx=>tx(async client=>{
      await client.query('select id from weddings where id=$1 for update',[wid])
      await lockFinanceAccess(client,wid,uid)
      const {rows: payment}=await client.query(`select 1 from payments p join deals d on d.id=p.deal_id where p.id=$1 and d.wedding_id=$2 for update of p`,[id,wid])
      if(!payment[0])throw notFound('Оплата не найдена')
      const {rows:[used]}=await client.query<{files:number;onPayment:number;bytes:string}>(
        `select count(*)::int as files,(count(*) filter(where payment_id=$2))::int as "onPayment",coalesce(sum(size_bytes),0)::text as bytes
           from payment_receipts where wedding_id=$1`,[wid,id])
      if(used!.onPayment>=RECEIPTS_PER_PAYMENT)throw conflict('receipt_limit','К одной оплате можно прикрепить не больше 5 файлов')
      const {receiptsMaxPerWedding,receiptsMaxBytesPerWedding}=app.appConfig
      if(used!.files>=receiptsMaxPerWedding||BigInt(used!.bytes)+BigInt(content.length)>BigInt(receiptsMaxBytesPerWedding))
        throw conflict('receipt_quota','Место под подтверждения оплат у свадьбы закончилось — удалите ненужные файлы')
      const receiptId=uuidv7()
      const {rows:[saved]}=await client.query<{created_at:Date}>(`insert into payment_receipts(id,wedding_id,payment_id,filename,mime_type,size_bytes,content,uploaded_by)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning created_at`,[receiptId,wid,id,filename,body.mimeType,content.length,content,uid])
      await financeAudit(client,uid,'payment_receipt',receiptId,'payment.receipt_added',{paymentId:id,mimeType:body.mimeType,sizeBytes:content.length,sha256})
      return {status:201,body:{id:receiptId,filename,mimeType:body.mimeType,sizeBytes:content.length,createdAt:saved!.created_at.toISOString()}}
    }))
  })

  app.get('/weddings/:weddingId/payments/:paymentId/receipts/:receiptId/content', async(request)=>{
    const wid=request.member!.weddingId,{paymentId,receiptId}=request.params as {paymentId:string;receiptId:string}
    if(!isUuid(paymentId)||!isUuid(receiptId))throw notFound('Файл не найден')
    const {rows}=await db().query<{filename:string;mime_type:string;content:Buffer}>(
      `select r.filename,r.mime_type,r.content from payment_receipts r join payments p on p.id=r.payment_id join deals d on d.id=p.deal_id
        where r.id=$1 and r.payment_id=$2 and r.wedding_id=$3 and d.wedding_id=$3`,[receiptId,paymentId,wid])
    const file=rows[0];if(!file)throw notFound('Файл не найден')
    return {filename:file.filename,mimeType:file.mime_type,contentBase64:file.content.toString('base64')}
  })

  app.delete('/weddings/:weddingId/payments/:paymentId/receipts/:receiptId', async(request,reply)=>{
    const wid=request.member!.weddingId,uid=request.caller!.userId,{paymentId,receiptId}=request.params as {paymentId:string;receiptId:string}
    if(!isUuid(paymentId)||!isUuid(receiptId))throw notFound('Файл не найден')
    await db().tx(async tx=>{
      await lockFinanceAccess(tx,wid,uid)
      const {rows}=await tx.query<{size_bytes:number;mime_type:string;sha256:string}>(
        `delete from payment_receipts where id=$1 and payment_id=$2 and wedding_id=$3
          returning size_bytes,mime_type,encode(sha256(content),'hex') as sha256`,[receiptId,paymentId,wid])
      const gone=rows[0];if(!gone)throw notFound('Файл не найден')
      await financeAudit(tx,uid,'payment_receipt',receiptId,'payment.receipt_deleted',
        {paymentId,mimeType:gone.mime_type,sizeBytes:gone.size_bytes,sha256:gone.sha256})
    })
    return reply.code(204).send()
  })
}

const RECEIPT_MAX_BYTES=524288
const RECEIPTS_PER_PAYMENT=5
const RECEIPT_EXTENSIONS:Record<string,readonly string[]>={
  'application/pdf':['pdf'],'image/jpeg':['jpg','jpeg'],'image/png':['png'],'image/webp':['webp']}

export function receiptFilename(raw:string,mime:string):string {
  const name=Array.from(raw.normalize('NFC'))
    .filter(ch=>!/\p{Cf}/u.test(ch))
    .map(ch=>{const c=ch.codePointAt(0)!;return ch==='/'||ch==='\\'||c<0x20||(c>=0x7f&&c<=0x9f)?'_':ch})
    .join('').trim()
  if(!name)return ''
  const allowed=RECEIPT_EXTENSIONS[mime]??[]
  const dot=name.lastIndexOf('.')
  const ext=dot>0?name.slice(dot+1).toLowerCase():''
  const [base,suffix]=allowed.includes(ext)?[name.slice(0,dot),name.slice(dot)]:[dot>0?name.slice(0,dot):name,'.'+(allowed[0]??'bin')]
  return Array.from(base.trimEnd()||'file').slice(0,180-Array.from(suffix).length).join('')+suffix
}

function matchesMime(content:Buffer,mime:string):boolean {
  if(mime==='application/pdf')return content.subarray(0,5).toString('ascii')==='%PDF-'
  if(mime==='image/png')return content.length>=8&&content.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  if(mime==='image/jpeg')return content.length>=3&&content[0]===0xff&&content[1]===0xd8&&content[2]===0xff
  if(mime==='image/webp')return content.length>=12&&content.subarray(0,4).toString('ascii')==='RIFF'&&content.subarray(8,12).toString('ascii')==='WEBP'
  return false
}
