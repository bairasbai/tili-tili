import type { components } from '../contract/api.generated.js'
import { PAID_SUM } from '../deals/repo.js'
import { conflict } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { offerPriceBreakdown, type OfferPriceComponent, type OfferPricingRow } from '../offers/price-breakdown.js'
import type { Queryable } from '../plugins/db.js'
import type { OrderContext } from './context.js'

type Schemas = components['schemas']
type Formula = Schemas['OfferPriceFormula']
type Change = Schemas['OrderPriceQuantityChange']
type Difference = NonNullable<Schemas['OrderPriceChangePreview']['difference']>
export type OrderPriceAmendment = {
  agreementId: string
  previousPrice: Difference
  difference: Difference
  changes: Array<Change & { previousQuantity: string; unit: Formula['unit']; rate: NonNullable<Formula['rate']> }>
  components: OfferPriceComponent[]
}

export const orderCanAmendPrice = (order: OrderContext) =>
  order.vendorId !== null && (order.state === 'booked' || order.state === 'paid_deposit')

export async function loadOrderPriceBreakdown(client: Queryable, dealId: string) {
  // A later non-financial edition keeps earlier accepted quantities in force.
  // Pending or superseded proposals cannot become a new calculation baseline.
  const { rows: [row] } = await client.query<OfferPricingRow>(`
    select b.base_amount as pricing_base,
      coalesce(applied.snapshot->'priceAmendment'->'components',b.components) as pricing_components
    from offer_price_breakdowns b
    join deal_orders o on o.deal_id=b.deal_id
    left join deal_terms_versions agreed on agreed.id=o.agreed_terms_id
    left join lateral (
      select t.snapshot from deal_terms_versions t
      where t.wedding_id=o.wedding_id and t.deal_id=o.deal_id and t.version<=agreed.version
        and t.snapshot ? 'priceAmendment'
        and exists(select 1 from deal_terms_receipts r where r.terms_id=t.id and r.party='customer' and r.digest=t.digest)
        and exists(select 1 from deal_terms_receipts r where r.terms_id=t.id and r.party='performer' and r.digest=t.digest)
      order by t.version desc limit 1
    ) applied on true
    where b.deal_id=$1`, [dealId])
  return row && offerPriceBreakdown(row)
}

const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER)
const rub = (amount: number) => ({ amount, currency: 'RUB' as const })

function contractPrice(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return null
  const amount = BigInt(value)
  return amount <= MAX_AMOUNT ? Number(amount) : null
}

export function amendmentPrices(amount: unknown, currency: unknown, difference: Difference | null) {
  if (currency !== 'RUB' || !difference || difference.amount === 0) return null
  const before = contractPrice(amount)
  if (before === null) return null
  const after = BigInt(before) + BigInt(difference.amount)
  if (after < 0n || after > MAX_AMOUNT) return null
  return { currentPrice: rub(before), proposedPrice: rub(Number(after)) }
}

export async function quoteOrderPriceAmendment(client: Queryable, context: OrderContext, difference: Difference | null):
Promise<Schemas['OrderPriceAmendmentQuote'] | undefined> {
  if (!orderCanAmendPrice(context) || !difference) return undefined
  const { rows: [row] } = await client.query<{
    agreementId: string; orderVersion: string; termsRevision: string; price: string | null; currency: string; agreedPrice: string | null
  }>(`select a.id as "agreementId",o.version::text as "orderVersion",o.terms_revision::text as "termsRevision",
    d.price::text,d.currency,a.snapshot#>>'{economics,amount}' as "agreedPrice"
    from deal_orders o join deals d on d.id=o.deal_id
    join deal_terms_versions a on a.id=o.agreed_terms_id
    where o.wedding_id=$1 and o.deal_id=$2`, [context.weddingId, context.dealId])
  if (!row || row.price !== row.agreedPrice) return undefined
  const prices = amendmentPrices(row.price, row.currency, difference)
  return prices ? { agreementId: row.agreementId, orderVersion: row.orderVersion, termsRevision: row.termsRevision, ...prices } : undefined
}

export function priceAmendmentOf(snapshot: Record<string, unknown>): OrderPriceAmendment | null {
  const value = snapshot.priceAmendment as Partial<OrderPriceAmendment> | null | undefined
  if (!value || typeof value.agreementId !== 'string' || !isUuid(value.agreementId)
    || value.previousPrice?.currency !== 'RUB' || !Number.isSafeInteger(value.previousPrice.amount) || value.previousPrice.amount < 0
    || value.difference?.currency !== 'RUB' || !Number.isSafeInteger(value.difference.amount) || value.difference.amount === 0
    || !Array.isArray(value.changes) || !value.changes.length || !Array.isArray(value.components)) return null
  return value as OrderPriceAmendment
}

export async function applyOrderPriceAmendment(client: Queryable, context: OrderContext, actorId: string, termsId: string,
  amendment: OrderPriceAmendment, next: number) {
  const { rows: [payment] } = await client.query<{ paid: string; incomplete: boolean }>(`
    select ${PAID_SUM}::text as paid, exists(
      select 1 from payments p where p.deal_id=d.id and p.status<>'cancelled' and not p.amount_known
    ) as incomplete from deals d where d.wedding_id=$1 and d.id=$2`, [context.weddingId, context.dealId])
  if (!payment || payment.incomplete || BigInt(payment.paid) > BigInt(next)) {
    throw conflict('price_amendment_payment_review', 'Перед изменением цены нужно сверить оплаты')
  }
  const updated = await client.query('update deals set price=$3 where wedding_id=$1 and id=$2 and price=$4',
    [context.weddingId, context.dealId, next, amendment.previousPrice.amount])
  if (!updated.rowCount) throw conflict('price_amendment_source_changed', 'Исходная цена изменилась — обновите заказ')
  await client.query(`insert into deal_events (id,deal_id,from_state,to_state,actor_id,note,kind)
    values ($1,$2,$3,$3,$4,'Поправка к цене согласована обеими сторонами','price')`,
  [uuidv7(), context.dealId, context.state, actorId])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.price_amendment_applied','order',$2,$3::jsonb)",
    [actorId, context.dealId, JSON.stringify({ termsId, previousPrice: amendment.previousPrice, price: rub(next) })])
}
