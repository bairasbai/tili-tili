import type { components } from '../contract/api.generated.js'
import { conflict, notFound, validationFailed } from '../errors.js'
import { notify } from '../notify/notify.js'
import type { Db, Queryable } from '../plugins/db.js'
import { lockServicePriceOperator, requirePriceStaff } from './pricedCatalog.js'
import type { OrderActor } from '../orders/context.js'
import {
  MANUAL_PROVIDER, grantPaidServiceOrder, lockScope, ownsServiceScope,
  type ObserveServicePlanPaid, type OrderRow, type ServicePlanPaidEvent,
} from './orders.js'

type Schemas = components['schemas']

export type ManualRow = OrderRow & {
  save_receipt_copy: boolean
  receipt_email: string | null
  receipt_inn: string | null
  submitted_at: Date | null
  reviewed_at: Date | null
  receipt_url: string | null
}

const manualOrders = 'service_plan_orders orders join service_plan_manual_orders info on info.order_id = orders.id'

export function manualView(row: ManualRow): Schemas['ServicePlanManualStatus'] {
  return {
    saveReceiptCopy: row.save_receipt_copy,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    receiptUrl: row.receipt_url,
  }
}

export async function readManualOrder(db: Queryable, orderId: string, customerId: string): Promise<ManualRow> {
  const { rows: [order] } = await db.query<ManualRow>(`
    select orders.*, info.* from ${manualOrders} where orders.id = $1 and orders.customer_id = $2
  `, [orderId, customerId])
  if (!order) throw notFound('Заказ на перевод не найден')
  return order
}

export async function customerManualOrders(db: Queryable, input: {
  code: Schemas['ServicePlanCode']; targetId: string; customerId: string
}): Promise<ManualRow[]> {
  const { rows } = await db.query<ManualRow>(`
    select orders.*, info.* from ${manualOrders}
    where plan_code = $1 and target_id = $2 and customer_id = $3
    order by (state = 'pending') desc, created_at desc, id desc limit 20
  `, [input.code, input.targetId, input.customerId])
  return rows
}

export async function listManualReview(db: Queryable, orderId?: string): Promise<ManualRow[]> {
  const { rows } = await db.query<ManualRow>(`
    select orders.*, info.save_receipt_copy, info.submitted_at, info.reviewed_at, info.receipt_url,
      case when customers.id is not null then info.receipt_email end as receipt_email,
      case when customers.id is not null then info.receipt_inn end as receipt_inn
    from ${manualOrders}
    left join users customers on customers.id = orders.customer_id and customers.deleted_at is null
    where ($1::uuid is null and state = 'pending') or orders.id = $1
    order by submitted_at asc nulls last, orders.created_at asc, orders.id asc limit 50
  `, [orderId ?? null])
  return rows
}

export async function reportManualPayment(db: Db, orderId: string, userId: string, operatorIds: readonly string[]): Promise<ManualRow> {
  return db.tx(async tx => {
    const current = await readManualOrder(tx, orderId, userId)
    if (current.state !== 'pending' || current.submitted_at) return current
    const { rowCount } = await tx.query(`
      update service_plan_manual_orders info set submitted_at = statement_timestamp()
      where info.order_id = $1 and info.submitted_at is null and info.reviewed_at is null and info.closed_at is null
    `, [orderId])
    if (rowCount) {
      const { rows: recipients } = await tx.query<{ id: string }>(`
        select id from users where id = any($1::uuid[]) and is_staff and deleted_at is null order by id
      `, [operatorIds])
      for (const { id } of recipients) {
        await notify(tx, {
          userId: id, kind: 'system', title: 'Оплата тарифа к проверке',
          body: 'Покупатель сообщил о переводе по QR Сбера.',
          link: '/admin/service-plans?manualOrder=' + orderId,
        })
      }
    }
    return readManualOrder(tx, orderId, userId)
  })
}

function normalizeReceipt(input: string | undefined): string | null {
  if (!input) return null
  const match = /^https:\/\/lknpd\.nalog\.ru\/api\/v1\/receipt\/([0-9]{12})\/([a-z0-9-]{1,64})\/print\/?$/i.exec(input)
  if (!match) throw validationFailed({ receiptUrl: 'Укажите ссылку на выданный чек из «Моего налога»' })
  return 'https://lknpd.nalog.ru/api/v1/receipt/' + match[1] + '/' + match[2] + '/print'
}

export async function confirmManualPayment(db: Db, orderId: string, actor: OrderActor,
  input: Schemas['ConfirmServicePlanManualPayment'], observe?: ObserveServicePlanPaid,
): Promise<ManualRow> {
  const receiptUrl = normalizeReceipt(input.receiptUrl)
  const bankOperation = input.bankOperation.trim().toUpperCase()
  const paidAt = new Date(input.paidAt)
  if (!/^[A-Z0-9][A-Z0-9._/-]{2,79}$/.test(bankOperation) || !Number.isFinite(paidAt.getTime())) {
    throw validationFailed({ bankOperation: 'Укажите фактические дату и номер банковской операции' })
  }
  await requirePriceStaff(db, actor.userId)
  let paidEvent: ServicePlanPaidEvent | undefined
  try {
    const reviewed = await db.tx(async tx => {
      const [observed] = await listManualReview(tx, orderId)
      if (!observed) throw notFound('Заказ на перевод не найден')
      const scope = { code: observed.plan_code, targetId: observed.target_id }
      const owner = observed.customer_id && await ownsServiceScope(tx, scope, observed.customer_id, true, actor.userId)
      await lockServicePriceOperator(tx, actor)
      await lockScope(tx, scope)
      const { rows: [order] } = await tx.query<ManualRow & { now: Date }>(`
        select orders.*, info.*, statement_timestamp() as now from ${manualOrders}
        where orders.id = $1 for update of orders, info
      `, [orderId])
      if (!order || order.provider !== MANUAL_PROVIDER) throw notFound('Заказ на перевод не найден')
      const createdInMinute = new Date(order.created_at)
      createdInMinute.setUTCSeconds(0, 0)
      if (input.amount !== order.amount || order.save_receipt_copy !== Boolean(receiptUrl) || !input.receiptDelivered ||
        paidAt < createdInMinute || paidAt > order.now) {
        throw conflict('service_manual_mismatch', 'Проверьте сумму, дату перевода и подтверждение выдачи чека')
      }
      if (order.state === 'paid' && order.reviewed_at && order.provider_id === bankOperation &&
        order.paid_at?.getTime() === paidAt.getTime() && order.receipt_url === receiptUrl) return order
      if (order.state !== 'pending') throw conflict('service_manual_closed', 'Заказ уже обработан')
      if (!owner) throw conflict('service_owner_changed', 'Владелец свадьбы или кабинета изменился. Сверьте платёж отдельно.')
      await tx.query(`
        update service_plan_manual_orders
        set reviewed_at = $2, reviewed_by = $3, receipt_url = $4, receipt_email = null, receipt_inn = null
        where order_id = $1
      `, [order.id, order.now, actor.userId, receiptUrl])
      paidEvent = await grantPaidServiceOrder(tx, order, { paymentId: bankOperation, paidAt, refundedAmount: 0, accessStart: order.now })
      if (order.customer_id) {
        const path = order.plan_code === 'wedding' ? '/settings' : '/vendor-app/settings'
        await notify(tx, {
          userId: order.customer_id, kind: 'system', title: 'Оплата тарифа подтверждена',
          body: 'Доступ по тарифу открыт.', link: path + '?serviceOrder=' + orderId,
        })
      }
      return (await listManualReview(tx, orderId))[0]!
    })
    if (paidEvent) observe?.(paidEvent)
    return reviewed
  } catch (error) {
    const failure = error as { code?: string; constraint?: string }
    if (failure.code === '23505' &&
      ['service_plan_orders_provider_provider_id_key', 'service_plan_manual_orders_receipt_url_key'].includes(failure.constraint ?? '')) {
      throw conflict('service_manual_already_used', 'Этот перевод или чек уже привязан к заказу')
    }
    throw error
  }
}

export async function closeManualOrder(db: Db, orderId: string, actor: OrderActor): Promise<ManualRow> {
  return db.tx(async tx => {
    await lockServicePriceOperator(tx, actor)
    const [observed] = await listManualReview(tx, orderId)
    if (!observed) throw notFound('Заказ на перевод не найден')
    await lockScope(tx, { code: observed.plan_code, targetId: observed.target_id })
    const { rowCount } = await tx.query(`
      update service_plan_orders set state = 'canceled'
      where id = $1 and state = 'pending' and provider = $2
    `, [orderId, MANUAL_PROVIDER])
    if (!rowCount) {
      const [current] = await listManualReview(tx, orderId)
      if (current?.state === 'canceled') return current
      throw conflict('service_manual_closed', 'Заказ уже обработан')
    }
    await tx.query(`
      update service_plan_manual_orders
      set closed_at = statement_timestamp(), closed_by = $2, receipt_email = null, receipt_inn = null
      where order_id = $1
    `, [orderId, actor.userId])
    return (await listManualReview(tx, orderId))[0]!
  })
}
