import { createHash } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { ref } from '../contract/schemas.generated.js'
import { AppError, forbidden } from '../errors.js'
import { publishServicePlanPrice, readAdminServicePlans, readServicePlans, requirePriceStaff } from '../service-plans/catalog.js'
import { UUID_ID } from '../ids.js'
import { claimServicePayment, findCustomerPendingOrder, openServiceOrder, readCustomerServiceOrder, settleServiceOrder } from '../service-plans/orders.js'
import type { ServicePaymentProvider } from '../service-plans/provider.js'

type Schemas = components['schemas']

type CheckoutTerms = { version: number; text: string }

const termsHash = (terms: string) => createHash('sha256').update(terms).digest('hex')

// These are only reachable when an explicitly injected test transport exists.
const testTerms: Record<Schemas['ServicePlanCode'], CheckoutTerms> = {
  wedding: { version: 1, text: 'Тестовый доступ на одну свадьбу. Сумма реальных платежей не списывается.' },
  vendor_month: { version: 1, text: 'Тестовый доступ на один месяц. Продление вручную. Реальных списаний нет.' },
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

export const servicePlanRoutes: FastifyPluginAsync<{ provider?: ServicePaymentProvider | undefined }> = async (app, options) => {
  const provider = options.provider
  function database() {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  function operator(userId: string): string {
    if (!app.appConfig.servicePriceOperatorIds.includes(userId.toLowerCase())) {
      throw forbidden('У вас нет доступа к управлению тарифами')
    }
    return userId
  }

  app.get('/users/me/service-plans', { preHandler: app.requireConsent }, async () => {
    const catalog = await readServicePlans(database())
    if (!provider) return catalog
    return { plans: catalog.plans.map(plan => {
      const terms = testTerms[plan.code]
      return { ...plan, checkoutAvailable: true, checkoutTerms: { ...terms, hash: termsHash(terms.text) } }
    }) }
  })

  app.post<{ Body: Schemas['OpenServicePlanOrder'] }>('/users/me/service-plan-orders', {
    preHandler: app.requireConsent,
    schema: { body: ref('OpenServicePlanOrder') },
  }, async request => {
    if (!provider) throw new AppError(501, 'service_payment_unavailable', 'Оплата тарифов пока недоступна.')
    const userId = request.caller!.userId
    const db = database()
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
      schema: { params: {
        type: 'object', required: ['code', 'targetId'],
        properties: { code: ref('ServicePlanCode'), targetId: UUID_ID },
      } },
    },
    async request => {
      const order = await findCustomerPendingOrder(database(), request.params, request.caller!.userId)
      return { order: order ? orderView(order) : null }
    },
  )

  app.get<{ Params: { orderId: string } }>('/users/me/service-plan-orders/:orderId', {
    preHandler: app.requireConsent,
    schema: { params: { type: 'object', required: ['orderId'], properties: { orderId: UUID_ID } } },
  }, async request => {
    const userId = request.caller!.userId
    const db = database()
    const order = await readCustomerServiceOrder(db, request.params.orderId, userId)
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

  app.get('/admin/service-plans', { preHandler: app.requireConsent }, async request => {
    const actorId = operator(request.caller!.userId)
    const db = database()
    await requirePriceStaff(db, actorId)
    return readAdminServicePlans(db)
  })

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
