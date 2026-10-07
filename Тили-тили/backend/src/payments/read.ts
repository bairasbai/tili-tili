import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, notFound } from '../errors.js'
import { COMMITTED_WITH_HOLD } from '../deals/state.js'
import { PAID_SUM } from '../deals/repo.js'
import { assertRealDate } from '../wedding/dates.js'
import { asMoney, INSTALLMENT_ORDER, INSTALLMENT_SELECT, positive, stageViews, type InstallmentRow } from './model.js'
import { canCorrectPayment } from './amendments.js'

export interface ScheduleQuery { from?: string; to?: string; includeOverdue?: boolean; includeCancelled?: boolean }
export async function financialToday(db: Queryable,weddingId: string) {
  const {rows}=await db.query<{today:string; tz:string; cancelled:boolean}>(`select
    (now() at time zone coalesce(tz,'Europe/Moscow'))::date::text as today,
    coalesce(tz,'Europe/Moscow') as tz,cancelled_at is not null as cancelled from weddings where id=$1`,[weddingId])
  if (!rows[0]) throw notFound('Свадьба не найдена')
  return rows[0]
}
interface DealOverviewRow {
  id:string;slot_id:string;name:string;state:string;price:string|null;paid:string;planned:string;unallocated:string
  unknown_payments:number;active:boolean
}
export async function paymentOverview(db: Queryable,weddingId: string) {
  const {rows}=await db.query<DealOverviewRow>(`select d.id,d.slot_id,coalesce(v.name,d.external_name,s.label) as name,d.state,
    d.price::text as price,${PAID_SUM}::text as paid,
    (select coalesce(sum(i.amount),0) from payment_installments i where i.deal_id=d.id and i.cancelled_at is null)::text as planned,
    (select coalesce(sum(case when p.kind='refund' then -p.amount else p.amount end),0) from payments p
      left join payment_installments i on i.id=p.installment_id
      where p.deal_id=d.id and p.status <> 'cancelled' and (p.installment_id is null or i.cancelled_at is not null))::text as unallocated,
    (select count(*)::int from payments p where p.deal_id=d.id and p.status<>'cancelled' and not p.amount_known) as unknown_payments,
    (d.state=any($2) and (d.state<>'negotiating' or d.negotiating_until is null or d.negotiating_until>now())) as active
    from deals d join slots s on s.id=d.slot_id left join vendors v on v.id=d.vendor_id
    where d.wedding_id=$1 order by s.sort,d.created_at,d.id limit 10001`,[weddingId,COMMITTED_WITH_HOLD])
  if (rows.length>10000) throw conflict('financial_history_too_large','Финансовая история слишком велика для одного ответа')
  let committed=0n,recorded=0n,remaining=0n,unallocated=0n,inactiveDealRecorded=0n,unknownPrices=0,unknownAmountPayments=0
  const deals=rows.map(d=>{
    const paid=BigInt(d.paid),price=d.price===null?null:BigInt(d.price),planned=BigInt(d.planned)
    unknownAmountPayments+=d.unknown_payments
    if (d.active) {
      if (price===null) unknownPrices++;else {committed+=price;remaining+=positive(price-paid)}
      recorded+=paid;unallocated+=BigInt(d.unallocated)
    } else inactiveDealRecorded+=paid
    return {id:d.id,slotId:d.slot_id,name:d.name,state:d.state,price:price===null?null:asMoney(price),
      recorded:asMoney(paid),remaining:price===null?null:asMoney(positive(price-paid)),planned:asMoney(planned),
      unallocated:asMoney(d.unallocated),unknownAmountPayments:d.unknown_payments,needsReview:price===null?planned>0n:planned>price,
      active:d.active,canPlan:['booked','paid_deposit','done'].includes(d.state) && price!==null && price>0n}
  })
  return {deals,summary:{committed:asMoney(committed),recorded:asMoney(recorded),remaining:asMoney(remaining),
    unallocated:asMoney(unallocated),inactiveDealRecorded:asMoney(inactiveDealRecorded),unknownPrices,
    unknownAmountPayments,amountIncomplete:unknownAmountPayments>0}}
}
export async function loadPaymentSchedule(db: Queryable,weddingId:string,query:ScheduleQuery={}) {
  const {today,tz,cancelled}=await financialToday(db,weddingId)
  const from=query.from??today
  assertRealDate(from,'from')
  const end=new Date(from+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+30)
  const to=query.to??end.toISOString().slice(0,10)
  assertRealDate(to,'to')
  if (from>to || Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>365*86400000) {
    throw new AppError(422,'bad_payment_range','Выберите период до 366 дней: начало не позже конца')
  }
  const includeOverdue=query.includeOverdue??true,includeCancelled=query.includeCancelled??false
  const overview=await paymentOverview(db,weddingId)
  const {rows}=await db.query<InstallmentRow>(`select ${INSTALLMENT_SELECT} from payment_installments i
    join deals d on d.id=i.deal_id where d.wedding_id=$1 order by ${INSTALLMENT_ORDER} limit 10001`,[weddingId])
  if (rows.length>10000) throw conflict('financial_history_too_large','График слишком велик для одного ответа')
  const all=stageViews(rows,today)
  const items=all.filter(i=>(includeCancelled || i.status!=='cancelled') &&
    ((i.due>=from && i.due<=to) || (includeOverdue && i.overdue)))
  const {rows:payments}=await db.query<{id:string;deal_id:string;kind:string;amount:string|null;status:string;created_at:Date;installment_id:string|null;plan_version:number;
    payment_method:string;visibility:string;amount_known:boolean;paid_on:string;currency:string;provider_ref:string|null;deal_state:import('../deals/state.js').DealState;deal_price:string|null;deal_currency:string}>(
    `select p.id,p.deal_id,p.kind,p.amount::text as amount,p.status,p.created_at,p.installment_id,p.plan_version,
        p.payment_method,p.visibility,p.amount_known,p.paid_on::text as paid_on,p.currency,p.provider_ref,
        d.state as deal_state,d.price::text as deal_price,d.currency as deal_currency
      from payments p join deals d on d.id=p.deal_id where d.wedding_id=$1
      order by p.paid_on desc,p.created_at desc,p.id desc limit 10001`,[weddingId])
  if (payments.length>10000) throw conflict('financial_history_too_large','История оплат слишком велика для одного ответа')
  return {range:{from,to,today,timeZone:tz,includeOverdue,includeCancelled},readOnly:cancelled,items,...overview,
    dueInWindow:asMoney(items.filter(i=>i.due>=from && i.due<=to).reduce((sum,i)=>sum+BigInt(i.remaining.amount),0n)),
    overdueRemaining:asMoney(all.filter(i=>i.overdue).reduce((sum,i)=>sum+BigInt(i.remaining.amount),0n)),
    allInstallments:all.map(i=>({id:i.id,dealId:i.dealId,title:i.title,status:i.status,remaining:i.remaining,
      unknownAmountPayments:i.unknownAmountPayments})),
    payments:payments.map(p=>({id:p.id,dealId:p.deal_id,kind:p.kind,amountKnown:p.amount_known,
      amount:p.amount_known && p.amount!==null?asMoney(p.amount):null,paymentMethod:p.payment_method,visibility:p.visibility,
      paidOn:p.paid_on,status:p.status,createdAt:p.created_at.toISOString(),installmentId:p.installment_id,version:p.plan_version,
      canCorrect:canCorrectPayment(p,{state:p.deal_state,price:p.deal_price,currency:p.deal_currency},cancelled)}))}
}

/** Spreadsheet formulas are neutralised; CSV text never becomes executable cells. */
export function csvCell(value:string|number|boolean|null) {
  let s=String(value??'')
  if (typeof value !== 'number' && typeof value !== 'boolean' && (/^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s))) s="'"+s
  return '"'+s.replaceAll('"','""')+'"'
}
export async function financialExport(db:Queryable,weddingId:string) {
  const {rows}=await db.query<{record_type:string;id:string;deal_id:string;title:string;date:string;amount:string|null;status:string;
    installment_id:string|null;amount_known:boolean;payment_method:string|null;visibility:string|null}>(`
    select * from (
      select 'plan'::text as record_type,i.id,i.deal_id,i.title,i.due::text as date,i.amount::text as amount,
        case when i.cancelled_at is null then 'planned' else 'cancelled' end as status,i.id as installment_id,
        true as amount_known,null::text as payment_method,null::text as visibility
        from payment_installments i join deals d on d.id=i.deal_id where d.wedding_id=$1
      union all
      select 'payment',p.id,p.deal_id,coalesce(v.name,d.external_name,s.label),p.paid_on::text,
        case when not p.amount_known then null when p.kind='refund' then (-p.amount)::text else p.amount::text end,
        p.status,p.installment_id,p.amount_known,p.payment_method,p.visibility
        from payments p join deals d on d.id=p.deal_id join slots s on s.id=d.slot_id
        left join vendors v on v.id=d.vendor_id where d.wedding_id=$1
    ) history order by date,id limit 10001`,[weddingId])
  if(rows.length>10000) throw conflict('financial_history_too_large','История слишком велика для одной выгрузки')
  const lines=[['Тип записи','ID','Сделка','Название','Дата','Сумма, коп.','Валюта','Статус','Этап',
    'amount_known','payment_method','visibility'].map(csvCell).join(';')]
  for(const x of rows) lines.push([x.record_type,x.id,x.deal_id,x.title,x.date,
    x.amount===null?'':asMoney(x.amount).amount,'RUB',x.status,x.installment_id,
    x.amount_known,x.payment_method,x.visibility].map(csvCell).join(';'))
  return {filename:'tili-payment-history.csv',csv:'\uFEFF'+lines.join('\r\n')+'\r\n',records:rows.length}
}
