import { AppError, conflict, forbidden, notFound } from '../errors.js'
import type { Db, Queryable } from '../plugins/db.js'
import type { components } from '../contract/api.generated.js'
import { readServicePlans } from './pricedCatalog.js'

type PlanCode = components['schemas']['ServicePlanCode']
type Scope = { code: PlanCode; targetId: string }
type State = 'pending' | 'paid' | 'canceled' | 'refunded'
export const MANUAL_PROVIDER = 'sber_manual'
export type ServicePlanPaidEvent = { event: 'purchase' | 'renewal'; code: PlanCode; priceId: string }
export type ObserveServicePlanPaid = (event: ServicePlanPaidEvent) => void

export type OrderRow = {
  id: string
  price_id: string
  plan_code: PlanCode
  target_id: string
  customer_id: string | null
  amount: number
  terms_version: number
  terms_text: string
  provider: string
  provider_id: string | null
  provider_requested_at: Date | null
  created_at: Date
  quote_expires_at: Date
  state: State
  refunded_amount: number
  paid_at: Date | null
  access_from: Date | null
  access_until: Date | null
}

type ServicePaymentOrder = OrderRow & { provider_request_token: string | null }

// The adapter obtains this snapshot from the provider's authenticated API.
// Browser returns and incoming event bodies cannot supply these fields directly.
export type VerifiedPayment = {
  orderId: string
  provider: string
  paymentId: string
  amount: number
  currency: string
  refundedAmount: number
} & (
  | { state: 'pending' }
  | { state: 'canceled' }
  | { state: 'paid'; paidAt: Date }
  | { state: 'refunded'; paidAt: Date }
)

export async function lockScope(db: Queryable, scope: Scope): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtextextended('service-plan:' || $1 || ':' || $2::uuid::text, 0))", [
    scope.code, scope.targetId,
  ])
}

export async function ownsServiceScope(db: Queryable, scope: Scope, userId: string, lock = false,
  alsoLockUserId?: string): Promise<boolean> {
  // Account withdrawal locks the wedding before the user. A vendor cascades from the user.
  if (lock && scope.code === 'wedding') {
    const wedding = await db.query('select id from weddings where id = $1 for share', [scope.targetId])
    if (!wedding.rowCount) return false
  }
  // Withdrawal can lock multiple users together. Keep the same UUID order
  // when manual review also needs the operator's principal.
  const userIds = lock && alsoLockUserId ? [userId, alsoLockUserId] : [userId]
  const { rows: users } = await db.query<{ id: string }>(
    `select id from users where id = any($1::uuid[]) and deleted_at is null order by id${lock ? ' for share' : ''}`,
    [userIds],
  )
  if (!users.some(user => user.id === userId.toLowerCase())) return false
  const result = scope.code === 'wedding'
    ? await db.query(`
        select 1 from wedding_members member
        join weddings wedding on wedding.id = member.wedding_id
        where member.user_id = $1 and member.wedding_id = $2 and member.role = 'couple'
          and wedding.cancelled_at is null and wedding.archived_at is null
        ${lock ? 'for share of member' : ''}
      `, [userId, scope.targetId])
    : await db.query(`select 1 from vendors where user_id = $1 and id = $2${lock ? ' for share' : ''}`,
      [userId, scope.targetId])
  return Boolean(result.rowCount)
}

async function requireOwner(db: Queryable, scope: Scope, userId: string): Promise<void> {
  if (!await ownsServiceScope(db, scope, userId, true)) throw forbidden('Оформить тариф может владелец свадьбы или кабинета')
}

export async function openServiceOrder(db: Db, input: Scope & {
  userId: string
  priceId: string
  provider: string
  terms: { version: number; text: string }
  manual?: components['schemas']['ServicePlanManualOptions']
}): Promise<OrderRow> {
  return db.tx(async tx => {
    await requireOwner(tx, input, input.userId)
    await lockScope(tx, input)
    // An attempt handed to the provider may have succeeded despite a network
    // failure. Only the adapter's authoritative result can unlock that order.
    await tx.query(`
      update service_plan_orders set state = 'canceled'
      where plan_code = $1 and target_id = $2 and state = 'pending'
        and provider_requested_at is null and quote_expires_at <= statement_timestamp()
    `, [input.code, input.targetId])
    const { rows: [existing] } = await tx.query<OrderRow>(`
      select * from service_plan_orders where plan_code = $1 and target_id = $2
        and (state = 'pending' or (plan_code = 'wedding' and state = 'paid'))
      order by created_at desc limit 1
    `, [input.code, input.targetId])
    if (existing?.state === 'paid') throw conflict('service_already_paid', 'Доступ на свадьбу уже оплачен')
    if (existing) {
      if (existing.customer_id !== input.userId || existing.provider !== input.provider) {
        throw conflict('service_payment_pending', 'Для этого проекта уже есть незавершённая оплата')
      }
      if (existing.price_id !== input.priceId || existing.terms_version !== input.terms.version ||
        existing.terms_text !== input.terms.text) throw conflict('service_payment_pending', 'Завершите открытую оплату')
      return existing
    }

    // Serialize an order against a publication of a new active price as well.
    await tx.query('select code from service_plans where code = $1 for share', [input.code])
    const { plans } = await readServicePlans(tx)
    const plan = plans.find(item => item.code === input.code)
    if (!plan || plan.price.id !== input.priceId) throw conflict('service_price_changed', 'Цена изменилась. Обновите тарифы.')

    const { rows: [order] } = await tx.query<OrderRow>(`
      insert into service_plan_orders(plan_code, target_id, customer_id, price_id, amount, terms_version, terms_text, provider, quote_expires_at, provider_requested_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, statement_timestamp() + interval '30 minutes',
        case when $9 then statement_timestamp() end)
      returning *
    `, [input.code, input.targetId, input.userId, input.priceId, plan.price.amount,
      input.terms.version, input.terms.text, input.provider, Boolean(input.manual)])
    if (!order) throw new Error('Service order insert returned no row')
    if (input.manual) {
      await tx.query(`
        insert into service_plan_manual_orders(order_id, save_receipt_copy, receipt_email, receipt_inn)
        values ($1, $2, $3, $4)
      `, [order.id, input.manual.saveReceiptCopy, input.manual.receiptEmail, input.manual.receiptInn ?? null])
    }
    return order
  })
}

// Call before attempting to create a remote payment. Use the same order ID
// for reconciliation after a timeout, never another remote payment ID.
export async function claimServicePayment(db: Db, orderId: string, userId: string): Promise<ServicePaymentOrder & { firstAttempt: boolean }> {
  return db.tx(async tx => {
    const current = await readCustomerServiceOrder(tx, orderId, userId)
    if (current.state === 'pending') {
      await requireOwner(tx, { code: current.plan_code, targetId: current.target_id }, userId)
    }
    const { rows: [order] } = await tx.query<ServicePaymentOrder>(`
      update service_plan_orders
      set provider_requested_at = statement_timestamp()
      where id = $1 and customer_id = $2 and state = 'pending'
        and provider_requested_at is null and quote_expires_at > statement_timestamp()
      returning *, provider_requested_at::text as provider_request_token
    `, [orderId, userId])
    if (order) return { ...order, firstAttempt: true }
    const existing = await readCustomerServiceOrder(tx, orderId, userId)
    if (existing.state === 'pending' && existing.provider_requested_at) return { ...existing, firstAttempt: false }
    throw conflict('service_quote_expired', 'Предложение истекло или недоступно. Обновите тарифы.')
  })
}

// A retry is allowed only after a provider confirms that this same merchant
// reference is absent. The claim prevents concurrent retries and leaves time
// for an in-flight provider request to finish before claiming another.
export async function claimServicePaymentRetry(db: Db, order: ServicePaymentOrder, userId: string): Promise<boolean> {
  return db.tx(async tx => {
    await requireOwner(tx, { code: order.plan_code, targetId: order.target_id }, userId)
    const { rowCount } = await tx.query(`
      update service_plan_orders set provider_requested_at = statement_timestamp()
      where id = $1 and customer_id = $2 and provider_requested_at = $3
        and state = 'pending' and provider_id is null and quote_expires_at > statement_timestamp() + interval '1 second'
        and provider_requested_at <= statement_timestamp() - interval '1 minute'
    `, [order.id, userId, order.provider_request_token])
    return Boolean(rowCount)
  })
}

export async function expireUnregisteredServicePayment(db: Queryable, order: ServicePaymentOrder): Promise<void> {
  await db.query(`
    update service_plan_orders set state = 'canceled'
    where id = $1 and provider_requested_at = $2 and state = 'pending' and provider_id is null
      and quote_expires_at <= statement_timestamp()
      and provider_requested_at <= statement_timestamp() - interval '1 minute'
  `, [order.id, order.provider_request_token])
}

export async function readCustomerServiceOrder(db: Queryable, orderId: string, userId: string): Promise<ServicePaymentOrder> {
  const { rows: [order] } = await db.query<ServicePaymentOrder>(
    'select *, provider_requested_at::text as provider_request_token from service_plan_orders where id = $1 and customer_id = $2', [orderId, userId],
  )
  if (!order) throw notFound('Заказ тарифа не найден')
  return order
}

export async function findCustomerPendingOrder(db: Queryable, scope: Scope, userId: string): Promise<OrderRow | null> {
  const { rows: [order] } = await db.query<OrderRow>(`
    select * from service_plan_orders
    where plan_code = $1 and target_id = $2 and customer_id = $3 and state = 'pending'
      and (provider_requested_at is not null or quote_expires_at > statement_timestamp())
  `, [scope.code, scope.targetId, userId])
  return order ?? null
}

export async function settleServiceOrder(db: Db, payment: VerifiedPayment, observe?: ObserveServicePlanPaid): Promise<State> {
  if (payment.provider === MANUAL_PROVIDER) throw conflict('service_payment_mismatch', 'Ручной перевод требует сверки')
  let paidEvent: ServicePlanPaidEvent | undefined
  const state = await db.tx(async tx => {
    const { rows: [observed] } = await tx.query<OrderRow>('select * from service_plan_orders where id = $1', [payment.orderId])
    if (!observed) throw new AppError(404, 'service_order_unknown', 'Заказ не найден')
    await lockScope(tx, { code: observed.plan_code, targetId: observed.target_id })
    const { rows: [order] } = await tx.query<OrderRow>('select * from service_plan_orders where id = $1 for update', [payment.orderId])
    if (!order || !order.provider_requested_at || order.provider !== payment.provider || order.amount !== payment.amount ||
      payment.currency !== 'RUB' || (order.provider_id && order.provider_id !== payment.paymentId) ||
      !Number.isInteger(payment.refundedAmount) || payment.refundedAmount < 0 || payment.refundedAmount > order.amount ||
      ((payment.state === 'refunded') !== (payment.refundedAmount === order.amount)) ||
      ((payment.state === 'pending' || payment.state === 'canceled') && payment.refundedAmount > 0)) {
      throw conflict('service_payment_mismatch', 'Оплата не совпадает с заказом')
    }

    if (order.state === 'refunded') return order.state
    if (order.state === 'canceled') {
      if (payment.state === 'paid' || payment.state === 'refunded') {
        throw conflict('service_payment_state_conflict', 'Статус отменённого платежа требует сверки')
      }
      return order.state
    }
    if (order.state === 'paid' && payment.state !== 'refunded') {
      if (payment.refundedAmount > order.refunded_amount) {
        await tx.query('update service_plan_orders set refunded_amount = $2 where id = $1', [order.id, payment.refundedAmount])
      }
      return order.state
    }

    if (payment.state === 'pending' || payment.state === 'canceled') {
      await tx.query('update service_plan_orders set provider_id = $2, state = $3 where id = $1', [
        order.id, payment.paymentId, payment.state,
      ])
      return payment.state
    }

    if (payment.state === 'refunded') {
      const refundTime = await tx.query<{ now: Date }>('select statement_timestamp() as now')
      const now = refundTime.rows[0]!.now
      await tx.query(`
        update service_plan_orders set provider_id = $2, state = 'refunded',
          refunded_amount = amount, paid_at = coalesce(paid_at, $3)
        where id = $1
      `, [order.id, payment.paymentId, payment.paidAt])
      if (order.plan_code === 'vendor_month' && order.access_from && order.access_until && order.access_until > now) {
        // Move only unused future periods forward into the refunded period.
        // Access already consumed by the current period stays in its history.
        const nextStart = order.access_from > now ? order.access_from : now
        await shiftUnusedVendorMonths(tx, order.target_id, order.access_until, nextStart)
      }
      return payment.state
    }

    paidEvent = await grantPaidServiceOrder(tx, order, payment)
    return payment.state
  })
  if (paidEvent) observe?.(paidEvent)
  return state
}

export async function grantPaidServiceOrder(tx: Queryable, order: OrderRow, payment: {
  paymentId: string
  paidAt: Date
  refundedAmount: number
  accessStart?: Date
}): Promise<ServicePlanPaidEvent> {
  const renewal = order.plan_code === 'vendor_month' && Boolean((await tx.query(`
    select 1 from service_plan_orders
    where plan_code = 'vendor_month' and target_id = $1 and id <> $2 and access_from is not null
    limit 1
  `, [order.target_id, order.id])).rowCount)
  // UTC makes the month boundary independent of the server's timezone.
  await tx.query(`
      with period_start as (
        select greatest($7::timestamptz, max(access_until)) as begins
        from service_plan_orders
        where plan_code = $4 and target_id = $5 and state = 'paid'
      )
      update service_plan_orders set provider_id = $2, state = 'paid', paid_at = $3, refunded_amount = $6,
        access_from = period_start.begins,
        access_until = case when $4 = 'vendor_month'
          then ((period_start.begins at time zone 'UTC') + interval '1 month') at time zone 'UTC'
          else null end
      from period_start where id = $1
  `, [order.id, payment.paymentId, payment.paidAt, order.plan_code, order.target_id, payment.refundedAmount,
    payment.accessStart ?? payment.paidAt])
  return { event: renewal ? 'renewal' : 'purchase', code: order.plan_code, priceId: order.price_id }
}

async function shiftUnusedVendorMonths(db: Queryable, targetId: string, oldEnd: Date, newStart: Date): Promise<void> {
  await db.query(`
    with recursive future as (
      select id, row_number() over (order by access_from, id)::integer as position
      from service_plan_orders
      where plan_code = 'vendor_month' and target_id = $1 and state = 'paid' and access_from >= $2
    ), shifted(id, position, begins, ends) as (
      select id, position, $3::timestamptz,
        (($3::timestamptz at time zone 'UTC') + interval '1 month') at time zone 'UTC'
      from future where position = 1
      union all
      select following.id, following.position, shifted.ends,
        ((shifted.ends at time zone 'UTC') + interval '1 month') at time zone 'UTC'
      from shifted join future following on following.position = shifted.position + 1
    )
    update service_plan_orders orders set access_from = shifted.begins, access_until = shifted.ends
    from shifted where orders.id = shifted.id
  `, [targetId, oldEnd, newStart])
}

export async function servicePlanAccess(db: Queryable, scope: Scope): Promise<boolean> {
  const { rowCount } = await db.query(`
    select 1 from service_plan_orders
    where plan_code = $1 and target_id = $2 and state = 'paid'
      and access_from <= statement_timestamp()
      and (access_until is null or access_until > statement_timestamp())
    limit 1
  `, [scope.code, scope.targetId])
  return rowCount === 1
}
