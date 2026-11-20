import { createHash } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { ref } from '../contract/schemas.generated.js'
import { AppError, forbidden, validationFailed } from '../errors.js'
import { publishServicePlanPrice, readAdminServicePlans, readServicePlans, requirePriceStaff } from '../service-plans/catalog.js'
import { UUID_ID } from '../ids.js'
import {
  MANUAL_PROVIDER, claimServicePayment, findCustomerPendingOrder, openServiceOrder, ownsServiceScope,
  readCustomerServiceOrder, servicePlanAccess, settleServiceOrder,
} from '../service-plans/orders.js'
import type { ServicePaymentProvider } from '../service-plans/provider.js'
import {
  closeManualOrder, confirmManualPayment, customerManualOrders, listManualReview, manualView,
  readManualOrder, reportManualPayment, type ManualRow,
} from '../service-plans/manualOrders.js'

type Schemas = components['schemas']

type CheckoutTerms = { version: number; text: string }

const termsHash = (terms: string) => createHash('sha256').update(terms).digest('hex')

// These are only reachable when an explicitly injected test transport exists.
const testTerms: Record<Schemas['ServicePlanCode'], CheckoutTerms> = {
  wedding: { version: 1, text: 'Тестовый доступ на одну свадьбу. Сумма реальных платежей не списывается.' },
  vendor_month: { version: 1, text: 'Тестовый доступ на один месяц. Продление вручную. Реальных списаний нет.' },
}

const manualTerms: Record<Schemas['ServicePlanCode'], CheckoutTerms> = {
  wedding: { version: 1, text: 'Разовый платёж за доступ на одну свадьбу. Доступ откроется после сверки перевода. Чек будет отправлен на указанный адрес.' },
  vendor_month: { version: 1, text: 'Доступ на один календарный месяц после сверки перевода. При продлении месяц добавляется к действующему периоду. Чек будет отправлен на указанный адрес.' },
}

function orderView(order: Awaited<ReturnType<typeof readCustomerServiceOrder>>): Schemas['ServicePlanOrder'] {
  return {
    id: order.id, code: order.plan_code, targetId: order.target_id, priceId: order.price_id, amount: order.amount,
    currency: 'RUB', state: order.state, refundedAmount: order.refunded_amount,
    quoteExpiresAt: order.quote_expires_at.toISOString(),
    accessFrom: order.access_from?.toISOString() ?? null, accessUntil: order.access_until?.toISOString() ?? null,
    termsVersion: order.terms_version, termsText: order.terms_text, termsHash: termsHash(order.terms_text),
  }
}

function manualOrderView(order: ManualRow): Schemas['ServicePlanOrder'] {
  return { ...orderView(order), manual: manualView(order) }
}

function reviewView(order: ManualRow): Schemas['ServicePlanManualReview'] {
  return { order: manualOrderView(order), receiptEmail: order.receipt_email, receiptInn: order.receipt_inn }
}

export const servicePlanRoutes: FastifyPluginAsync<{ provider?: ServicePaymentProvider | undefined }> = async (app, options) => {
  const provider = options.provider
  if (provider?.code === MANUAL_PROVIDER) throw new Error('Reserved manual payment provider code')
  const operatorIds = app.appConfig.servicePriceOperatorIds
  const manualTransfer = app.appConfig.servicePlanManualTransfer
  const manualEnabled = !provider && manualTransfer && app.appConfig.servicePlanManualCheckoutEnabled && operatorIds.length > 0
  const orderParams = { type: 'object', required: ['orderId'], properties: { orderId: UUID_ID } }
  const scopeParams = {
    type: 'object', required: ['code', 'targetId'], properties: { code: ref('ServicePlanCode'), targetId: UUID_ID },
  }
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store')
    return payload
  })
  function database() {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  function operator(userId: string): string {
    if (!operatorIds.includes(userId.toLowerCase())) {
      throw forbidden('У вас нет доступа к управлению тарифами')
    }
    return userId
  }

  async function activeManualOperator() {
    return manualEnabled && Boolean((await database().query(`
      select 1 from users where id = any($1::uuid[]) and is_staff and deleted_at is null limit 1
    `, [operatorIds])).rowCount)
  }

  async function customerView(order: ManualRow, caller: string): Promise<Schemas['ServicePlanOrder']> {
    const view = manualOrderView(order)
    if (view.manual && manualTransfer && order.state === 'pending' && !order.submitted_at && await activeManualOperator() &&
      await ownsServiceScope(database(), { code: order.plan_code, targetId: order.target_id }, caller)) {
      view.manual.transfer = manualTransfer
    }
    return view
  }

  app.get('/users/me/service-plans', { preHandler: app.requireConsent }, async () => {
    const catalog = await readServicePlans(database())
    const activeOperator = await activeManualOperator()
    if (!provider && !activeOperator) return catalog
    return { manualCheckoutAvailable: Boolean(activeOperator), plans: catalog.plans.map(plan => {
      const terms = (provider ? testTerms : manualTerms)[plan.code]
      return { ...plan, checkoutAvailable: true, checkoutTerms: { ...terms, hash: termsHash(terms.text) } }
    }) }
  })

  app.post<{ Body: Schemas['OpenServicePlanOrder'] }>('/users/me/service-plan-orders', {
    preHandler: app.requireConsent,
    schema: { body: ref('OpenServicePlanOrder') },
  }, async request => {
    const userId = request.caller!.userId
    const db = database()
    if (!provider) {
      const { manual, ...orderInput } = request.body
      if (!await activeManualOperator()) throw new AppError(501, 'service_payment_unavailable', 'Оплата тарифов пока недоступна.')
      if (!manual) throw validationFailed({ manual: 'Укажите данные для чека' })
      const terms = manualTerms[orderInput.code]
      const pending = await findCustomerPendingOrder(db, orderInput, userId)
      const offered = pending?.provider === MANUAL_PROVIDER
        ? { version: pending.terms_version, text: pending.terms_text }
        : terms
      if (orderInput.termsVersion !== offered.version || orderInput.termsHash !== termsHash(offered.text)) {
        throw new AppError(409, 'service_terms_changed', 'Условия тарифа изменились. Обновите тарифы.')
      }
      const order = await openServiceOrder(db, { ...orderInput, manual, userId, provider: MANUAL_PROVIDER, terms: offered })
      return { order: await customerView(await readManualOrder(db, order.id, userId), userId), confirmationUrl: null }
    }
    if (request.body.manual) throw new AppError(409, 'service_terms_changed', 'Способ оплаты изменился. Обновите тарифы.')
    const resumed = request.body.resumeOrderId
      ? await readCustomerServiceOrder(db, request.body.resumeOrderId, userId)
      : null
    if (resumed && (resumed.plan_code !== request.body.code || resumed.target_id !== request.body.targetId.toLowerCase() ||
      resumed.price_id !== request.body.priceId.toLowerCase() || resumed.provider !== provider.code)) {
      throw new AppError(409, 'service_order_mismatch', 'Указанный заказ не совпадает с предложением')
    }
    const existing = resumed ?? await findCustomerPendingOrder(db, request.body, userId)
    const terms = existing ? { version: existing.terms_version, text: existing.terms_text } : testTerms[request.body.code]
    if (request.body.termsVersion !== terms.version || request.body.termsHash !== termsHash(terms.text)) {
      throw new AppError(409, 'service_terms_changed', 'Условия тарифа изменились. Обновите тарифы.')
    }
    const order = resumed ?? await openServiceOrder(db, { ...request.body, userId, provider: provider.code, terms })
    if (order.state !== 'pending') return { order: orderView(order), confirmationUrl: null }
    let reserved
    try {
      reserved = await claimServicePayment(db, order.id, userId)
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'service_quote_expired') throw error
      const refreshed = await readCustomerServiceOrder(db, order.id, userId)
      if (refreshed.state === 'pending') throw error
      return { order: orderView(refreshed), confirmationUrl: null }
    }
    const response = await provider.ensurePayment({
      orderId: reserved.id, amount: reserved.amount, currency: 'RUB', quoteExpiresAt: reserved.quote_expires_at,
      description: reserved.terms_text,
      returnPath: (reserved.plan_code === 'wedding' ? '/settings' : '/vendor-app/settings') + '?serviceOrder=' + reserved.id,
    }).catch(() => {
      request.log.warn({ orderId: reserved.id }, 'WP11: payment status needs reconciliation')
      return null
    })
    if (!response) return { order: orderView(await readCustomerServiceOrder(db, reserved.id, userId)), confirmationUrl: null }
    if (response.status.orderId !== reserved.id) throw new AppError(502, 'service_payment_mismatch', 'Оплата не совпадает с заказом')
    await settleServiceOrder(db, response.status)
    const refreshed = await readCustomerServiceOrder(db, reserved.id, userId)
    return { order: orderView(refreshed), confirmationUrl: refreshed.state === 'pending' ? response.confirmationUrl : null }
  })

  app.get<{ Params: { code: Schemas['ServicePlanCode']; targetId: string } }>(
    '/users/me/service-plan-orders/pending/:code/:targetId', {
      preHandler: app.requireConsent,
      schema: { params: scopeParams },
    },
    async request => {
      const db = database()
      const customerId = request.caller!.userId
      const order = await findCustomerPendingOrder(db, request.params, customerId)
      if (order?.provider === MANUAL_PROVIDER) {
        return { order: await customerView(await readManualOrder(db, order.id, customerId), customerId) }
      }
      return { order: order ? orderView(order) : null }
    },
  )

  app.get<{ Params: { orderId: string } }>('/users/me/service-plan-orders/:orderId', {
    preHandler: app.requireConsent,
    schema: { params: orderParams },
  }, async request => {
    const userId = request.caller!.userId
    const db = database()
    const order = await readCustomerServiceOrder(db, request.params.orderId, userId)
    if (order.provider === MANUAL_PROVIDER) return customerView(await readManualOrder(db, order.id, userId), userId)
    if (provider && order.provider === provider.code && order.provider_requested_at &&
      (order.state === 'pending' || order.state === 'paid')) {
      const payment = await provider.readPayment(order.id)
      if (payment?.orderId === order.id) {
        await settleServiceOrder(db, payment)
        return orderView(await readCustomerServiceOrder(db, order.id, userId))
      }
    }
    return orderView(order)
  })

  app.get<{ Params: { code: Schemas['ServicePlanCode']; targetId: string } }>(
    '/users/me/service-plan-orders/manual/:code/:targetId',
    { preHandler: app.requireConsent, schema: { params: scopeParams } },
    async request => {
      const db = database()
      const customerId = request.caller!.userId
      const orders = await customerManualOrders(db, { ...request.params, customerId })
      const active = await ownsServiceScope(db, request.params, customerId) && await servicePlanAccess(db, request.params)
      return { active, orders: await Promise.all(orders.map(order => customerView(order, customerId))) }
    },
  )

  app.post<{ Params: { orderId: string } }>('/users/me/service-plan-orders/:orderId/report-transfer', {
    preHandler: app.requireConsent, schema: { params: orderParams },
  }, async request => manualOrderView(await reportManualPayment(
    database(), request.params.orderId, request.caller!.userId, operatorIds,
  )))

  app.get('/admin/service-plans', { preHandler: app.requireConsent }, async request => {
    const actorId = operator(request.caller!.userId)
    const db = database()
    await requirePriceStaff(db, actorId)
    return readAdminServicePlans(db)
  })

  app.get<{ Querystring: { orderId?: string } }>('/admin/service-plans/manual-orders', {
    preHandler: app.requireConsent,
    schema: { querystring: { type: 'object', properties: { orderId: UUID_ID } } },
  }, async request => {
    const db = database()
    await requirePriceStaff(db, operator(request.caller!.userId))
    return { reviews: (await listManualReview(db, request.query.orderId)).map(reviewView) }
  })

  app.post<{ Params: { orderId: string }; Body: Schemas['ConfirmServicePlanManualPayment'] }>(
    '/admin/service-plans/manual-orders/:orderId/confirm',
    { preHandler: app.requireConsent, schema: { params: orderParams, body: ref('ConfirmServicePlanManualPayment') } },
    async request => reviewView(await confirmManualPayment(
      database(), request.params.orderId, operator(request.caller!.userId), request.body,
    )),
  )

  app.post<{ Params: { orderId: string }; Body: Schemas['CloseServicePlanManualOrder'] }>(
    '/admin/service-plans/manual-orders/:orderId/close',
    { preHandler: app.requireConsent, schema: { params: orderParams, body: ref('CloseServicePlanManualOrder') } },
    async request => reviewView(await closeManualOrder(
      database(), request.params.orderId, operator(request.caller!.userId),
    )),
  )

  app.post<{ Body: Schemas['PublishServicePlanPrice']; Params: { code: Schemas['ServicePlanCode'] } }>(
    '/admin/service-plans/:code/prices',
    {
      preHandler: app.requireConsent,
      schema: {
        body: ref('PublishServicePlanPrice'),
        params: {
          type: 'object', required: ['code'], properties: { code: ref('ServicePlanCode') },
        },
      },
    },
    async (request, reply) => {
      const actorId = operator(request.caller!.userId)
      await publishServicePlanPrice(database(), request.params.code, actorId, request.body)
      return reply.code(204).send()
    },
  )
}
