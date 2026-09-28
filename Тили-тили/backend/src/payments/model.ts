import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound, unauthorized } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { assertRealDate } from '../wedding/dates.js'
import { PAID_SUM } from '../deals/repo.js'
import { COMMITTED, type DealState } from '../deals/state.js'

export const asMoney = (value: bigint | string | number) => {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount)) throw conflict('money_out_of_range', 'Итог суммы вне безопасного диапазона — нужна сверка данных')
  return { amount, currency: 'RUB' as const }
}
export const positive = (n: bigint) => n > 0n ? n : 0n

export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'other'
export type PaymentVisibility = 'private' | 'finance_members' | 'vendor'
export interface PaymentRecordOptions {
  paymentMethod?: PaymentMethod
  visibility?: PaymentVisibility
  amountKnown?: boolean
  paidOn?: string
  /** Compatibility for the pre-021 slot/pay endpoint only. New 021 writes never set this. */
  legacyVendorVisible?: boolean
}
export function assertPaidOn(value: string) {
  assertRealDate(value, 'paidOn')
  if (value < '2000-01-01' || value > '2100-12-31') {
    throw new AppError(422, 'bad_date', 'Дата оплаты — между 2000 и 2100 годом',
      { paidOn: 'ожидается дата между 2000-01-01 и 2100-12-31' })
  }
}

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
  cancelled_at: Date | null; cancel_reason: string | null; paid: string; unknown_payments: number
  /** Цена и все известные оплаты сделки — для распределения неразнесённых денег по этапам. */
  deal_price: string | null; deal_paid: string
}
/** Выборка этапа. Требует `deals d` в запросе: цена и оплаты сделки берутся оттуда. */
export const INSTALLMENT_SELECT = `i.id,i.deal_id,i.title,i.amount::text as amount,i.due::text as due,
  i.version,i.cancelled_at,i.cancel_reason,
  -- Сумму привязанных известных отметок ведёт триггер; NULL неизвестной суммы не участвует.
  i.paid::text as paid,
  (select count(*)::int from payments up where up.installment_id=i.id and up.status<>'cancelled' and not up.amount_known) as unknown_payments,
  d.price::text as deal_price,${PAID_SUM}::text as deal_paid`
/** Порядок этапов: по сроку, затем по созданию. Им же неразнесённые деньги ложатся на этапы. */
export const INSTALLMENT_ORDER = 'i.due,i.created_at,i.id'

export type InstallmentStatus = 'pending' | 'partial' | 'paid' | 'covered' | 'cancelled'
export interface InstallmentView {
  id: string; dealId: string; title: string; amount: { amount: number; currency: 'RUB' }; due: string
  version: number; paid: { amount: number; currency: 'RUB' }; allocated: { amount: number; currency: 'RUB' }
  remaining: { amount: number; currency: 'RUB' }; status: InstallmentStatus; overdue: boolean
  unknownAmountPayments: number
  cancelledAt: string | null; cancelReason: string | null
}

/**
 * Этапы с учётом всех ИЗВЕСТНЫХ денег сделки (ревью 018, M-01).
 *
 * Неизвестная сумма существует как факт оплаты, но не уменьшает числовой остаток:
 * PostgreSQL SUM игнорирует NULL, а `unknownAmountPayments` сообщает UI о неполноте.
 * Остальная логика распределения 018-A остаётся прежней.
 */
export function stageViews(rows: InstallmentRow[], today: string): InstallmentView[] {
  const byDeal = new Map<string, InstallmentRow[]>()
  for (const row of rows) {
    const list = byDeal.get(row.deal_id)
    if (list) list.push(row); else byDeal.set(row.deal_id, [row])
  }
  const views = new Map<string, InstallmentView>()
  for (const list of byDeal.values()) {
    const dealPaid = BigInt(list[0]!.deal_paid)
    const price = list[0]!.deal_price === null ? null : BigInt(list[0]!.deal_price)
    const linkedActive = list.filter(r => !r.cancelled_at).reduce((sum, r) => sum + BigInt(r.paid), 0n)
    let pool = positive(dealPaid - linkedActive)
    let left = price === null ? null : positive(price - dealPaid)
    for (const row of list) {
      const amount = BigInt(row.amount), paid = BigInt(row.paid)
      const base = {
        id: row.id, dealId: row.deal_id, title: row.title, amount: asMoney(amount), due: row.due,
        version: row.version, paid: asMoney(paid), unknownAmountPayments: row.unknown_payments,
        cancelledAt: row.cancelled_at?.toISOString() ?? null, cancelReason: row.cancel_reason,
      }
      if (row.cancelled_at) {
        views.set(row.id, { ...base, allocated: asMoney(0n), remaining: asMoney(0n), status: 'cancelled', overdue: false })
        continue
      }
      const own = positive(amount - paid)
      const cover = own < pool ? own : pool
      pool -= cover
      let remaining = own - cover
      if (left !== null) {
        if (remaining > left) remaining = left
        left -= remaining
      }
      const status: InstallmentStatus = paid >= amount ? 'paid'
        : remaining === 0n ? 'covered'
        : paid > 0n || cover > 0n ? 'partial' : 'pending'
      views.set(row.id, { ...base, allocated: asMoney(cover), remaining: asMoney(remaining), status,
        overdue: remaining > 0n && row.due < today })
    }
  }
  return rows.map(row => views.get(row.id)!)
}

/** Все этапы одной сделки в порядке распределения — для ответа о единственном этапе. */
export async function dealStageRows(tx: Queryable, weddingId: string, dealId: string) {
  const { rows } = await tx.query<InstallmentRow>(`select ${INSTALLMENT_SELECT} from payment_installments i
    join deals d on d.id=i.deal_id where i.deal_id=$1 and d.wedding_id=$2 order by ${INSTALLMENT_ORDER}`, [dealId, weddingId])
  return rows
}

/** Журнал финансовых действий — только структурированные поля, без свободного текста. */
export async function financeAudit(tx: Queryable, uid: string, entity: 'payment' | 'payment_installment' | 'payment_receipt',
  id: string, action: string, diff: Record<string, unknown>) {
  await tx.query('insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,$3,$4,$5)',
    [uid, action, entity, id, JSON.stringify(diff)])
}

export async function installment(tx: Queryable,weddingId: string,id: string) {
  if (!isUuid(id)) throw notFound('Этап платежа не найден')
  const {rows}=await tx.query<InstallmentRow>(`select ${INSTALLMENT_SELECT} from payment_installments i
    join deals d on d.id=i.deal_id where i.id=$1 and d.wedding_id=$2`,[id,weddingId])
  if (!rows[0]) throw notFound('Этап платежа не найден')
  return rows[0]
}
export const stalePlan = () => conflict('stale_payment_plan','График изменился. Обновите данные и проверьте черновик перед сохранением')
export function assertVersion(actual: number,expected: number) {
  if (actual!==expected) throw stalePlan()
}
export function assertDue(value: string) {
  assertRealDate(value,'due')
  if (value<'2000-01-01' || value>'2100-12-31') throw new AppError(422,'bad_date','Срок платежа — между 2000 и 2100 годом',{due:'ожидается дата между 2000-01-01 и 2100-12-31'})
}

/** Single money-writing door for the existing slot button and the payment schedule.
 * `amountKnown=false` records a payment fact without inventing zero or reducing debt. */
export async function recordPayment(tx: Queryable,deal: FinancialDeal,userId: string,
  amountInput?: number,stage?: InstallmentRow,options: PaymentRecordOptions = {}) {
  assertPayable(deal)
  if (stage?.cancelled_at) throw conflict('installment_cancelled','Этап платежа отменён')
  const amountKnown=options.amountKnown ?? true
  if (!amountKnown && amountInput !== undefined) {
    throw new AppError(422,'validation_failed','Запрос не прошёл проверку',{amount:'Не передавайте сумму, если она не сохраняется'})
  }
  const paymentMethod=options.paymentMethod ?? 'other'
  const visibility=options.visibility ?? 'private'
  const legacyVendorVisible=options.legacyVendorVisible ?? false
  if (options.paidOn !== undefined) assertPaidOn(options.paidOn)
  const price=BigInt(deal.price!)
  const {rows}=await tx.query<{total:string}>(`select ${PAID_SUM}::text as total from deals d where d.id=$1`,[deal.id])
  const already=BigInt(rows[0]!.total)
  const amount=amountKnown ? (amountInput===undefined ? positive(price-already) : BigInt(amountInput)) : null
  if (amount !== null && amount<=0n) {
    if (amountInput===undefined) throw conflict('overpay','Сделка уже оплачена целиком')
    throw new AppError(422,'bad_amount','Сумма оплаты должна быть больше нуля')
  }
  if (amount !== null && already+amount>price) throw conflict('overpay','Сумма оплат превысила цену сделки')
  if (amount !== null && stage && BigInt(stage.paid)+amount>BigInt(stage.amount)) throw conflict('installment_overpay','Сумма превысила остаток этапа')
  const id=uuidv7()
  const kind=amount !== null && already+amount>=price ? 'balance' : 'deposit'
  await tx.query(`insert into payments(id,deal_id,kind,amount,currency,status,installment_id,payment_method,visibility,amount_known,paid_on,legacy_vendor_visible)
    values($1,$2,$3,$4,'RUB','recorded',$5,$6,$7,$8,
      coalesce($9::date,(select (now() at time zone coalesce(w.tz,'Europe/Moscow'))::date
        from deals d join weddings w on w.id=d.wedding_id where d.id=$2)),$10)`,
    [id,deal.id,kind,amount?.toString() ?? null,stage?.id ?? null,paymentMethod,visibility,amountKnown,options.paidOn ?? null,legacyVendorVisible])
  await financeAudit(tx,userId,'payment',id,'payment.recorded',{
    dealId:deal.id,installmentId:stage?.id ?? null,paymentMethod,visibility,amountKnown,
    paidOn:options.paidOn ?? null,version:1,...(amount===null?{}:{amount:Number(amount)})})
  if (deal.state==='booked') {
    await tx.query("update deals set state='paid_deposit' where id=$1",[deal.id])
    await tx.query(`insert into deal_events(id,deal_id,from_state,to_state,actor_id)
      values($1,$2,'booked','paid_deposit',$3)`,[uuidv7(),deal.id,userId])
  }
  return id
}
