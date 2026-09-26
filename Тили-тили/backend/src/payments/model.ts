import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound, unauthorized } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { PAID_SUM } from '../deals/repo.js'
import { COMMITTED, type DealState } from '../deals/state.js'

export const asMoney = (value: bigint | string | number) => {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount)) throw conflict('money_out_of_range', 'Итог суммы вне безопасного диапазона — нужна сверка данных')
  return { amount, currency: 'RUB' as const }
}
export const positive = (n: bigint) => n > 0n ? n : 0n

/** Wedding → user → membership → deal, matching rescheduling/account deletion.
 * Re-check under locks; middleware alone cannot prevent concurrent role removal. */
export async function lockFinanceAccess(tx: Queryable, weddingId: string, userId: string) {
  const w = await tx.query<{ archived_at: Date | null; cancelled_at: Date | null }>(
    'select archived_at,cancelled_at from weddings where id=$1 for share',[weddingId])
  if (!w.rows[0] || w.rows[0].archived_at) throw notFound('Свадьба не найдена')
  const u = await tx.query<{ deleted_at: Date | null }>('select deleted_at from users where id=$1 for share',[userId])
  if (!u.rows[0] || u.rows[0].deleted_at) throw unauthorized('Аккаунт удалён')
  const m = await tx.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share',[weddingId,userId])
  if (!m.rows[0]) throw notFound('Свадьба не найдена')
  if (m.rows[0].role !== 'couple') throw forbidden('Финансовый раздел доступен только паре')
  if (w.rows[0].cancelled_at) throw conflict('wedding_cancelled','Свадьба отменена — финансовая история доступна только для чтения')
}
export interface FinancialDeal { id: string; state: DealState; price: string | null }
export async function lockDeal(tx: Queryable,weddingId: string,dealId: string): Promise<FinancialDeal> {
  if (!isUuid(dealId)) throw notFound('Сделка не найдена')
  const {rows} = await tx.query<FinancialDeal>('select id,state,price::text as price from deals where id=$1 and wedding_id=$2 for update',[dealId,weddingId])
  if (!rows[0]) throw notFound('Сделка не найдена')
  return rows[0]
}
export function assertPayable(deal: FinancialDeal) {
  if (!COMMITTED.includes(deal.state)) throw conflict('not_booked','Оплатить можно только забронированную сделку')
  if (deal.price === null || BigInt(deal.price) <= 0n) throw conflict('no_price','У сделки не указана цена — сначала договоритесь о сумме')
}
export interface InstallmentRow {
  id: string; deal_id: string; title: string; amount: string; due: string; version: number
  cancelled_at: Date | null; cancel_reason: string | null; paid: string
}
export const INSTALLMENT_SELECT = `i.id,i.deal_id,i.title,i.amount::text as amount,i.due::text as due,
  i.version,i.cancelled_at,i.cancel_reason,
  (select coalesce(sum(case when p.kind='refund' then -p.amount else p.amount end),0)
     from payments p where p.installment_id=i.id and p.status <> 'cancelled')::text as paid`
export function toInstallment(row: InstallmentRow,today: string) {
  const paid=BigInt(row.paid), amount=BigInt(row.amount)
  return { id:row.id,dealId:row.deal_id,title:row.title,amount:asMoney(amount),due:row.due,
    version:row.version,paid:asMoney(paid),remaining:asMoney(row.cancelled_at ? 0n : positive(amount-paid)),
    status:row.cancelled_at ? 'cancelled' as const : paid >= amount ? 'paid' as const : paid > 0n ? 'partial' as const : 'pending' as const,
    overdue:!row.cancelled_at && paid<amount && row.due<today,
    cancelledAt:row.cancelled_at?.toISOString() ?? null,cancelReason:row.cancel_reason }
}
export async function installment(tx: Queryable,weddingId: string,id: string) {
  if (!isUuid(id)) throw notFound('Этап платежа не найден')
  const {rows}=await tx.query<InstallmentRow>(`select ${INSTALLMENT_SELECT} from payment_installments i
    join deals d on d.id=i.deal_id where i.id=$1 and d.wedding_id=$2`,[id,weddingId])
  if (!rows[0]) throw notFound('Этап платежа не найден')
  return rows[0]
}
export function assertVersion(actual: number,expected: number) {
  if (actual!==expected) throw conflict('stale_payment_plan','График изменился. Обновите данные и проверьте черновик перед сохранением')
}

/** Single money-writing door for the existing slot button and the new schedule. */
export async function recordPayment(tx: Queryable,deal: FinancialDeal,userId: string,
  amountInput?: number,stage?: InstallmentRow) {
  assertPayable(deal)
  if (stage?.cancelled_at) throw conflict('installment_cancelled','Этап платежа отменён')
  const price=BigInt(deal.price!)
  const {rows}=await tx.query<{total:string}>(`select ${PAID_SUM}::text as total from deals d where d.id=$1`,[deal.id])
  const already=BigInt(rows[0]!.total)
  const amount=amountInput===undefined ? positive(price-already) : BigInt(amountInput)
  if (amount<=0n) {
    if (amountInput===undefined) throw conflict('overpay','Сделка уже оплачена целиком')
    throw new AppError(422,'bad_amount','Сумма оплаты должна быть больше нуля')
  }
  if (already+amount>price) throw conflict('overpay','Сумма оплат превысила цену сделки')
  if (stage && BigInt(stage.paid)+amount>BigInt(stage.amount)) throw conflict('installment_overpay','Сумма превысила остаток этапа')
  const id=uuidv7()
  await tx.query(`insert into payments(id,deal_id,kind,amount,currency,status,installment_id)
    values($1,$2,$3,$4,'RUB','recorded',$5)`,[id,deal.id,already+amount>=price?'balance':'deposit',amount.toString(),stage?.id ?? null])
  if (deal.state==='booked') {
    await tx.query("update deals set state='paid_deposit' where id=$1",[deal.id])
    await tx.query(`insert into deal_events(id,deal_id,from_state,to_state,actor_id)
      values($1,$2,'booked','paid_deposit',$3)`,[uuidv7(),deal.id,userId])
  }
  return id
}
