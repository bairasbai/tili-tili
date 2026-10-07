import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ref } from '../contract/schemas.generated.js'
import { AppError } from '../errors.js'
import { assertSeatingToken } from '../wedding/access.js'
import { amendAndRead, amendmentHistory, correctPayment, lockAmendmentContext, paymentProjection, validateCorrection, type CorrectionInput } from '../payments/amendments.js'

export async function paymentAmendmentRoutes(app: FastifyInstance): Promise<void> {
  const db = () => { if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна'); return app.db }
  const actor = (request: FastifyRequest) => ({ ...request.caller!, policyVersion: app.appConfig.policyVersion })
  app.patch('/weddings/:weddingId/payments/:paymentId', {
    schema: { body: ref('PaymentCorrectionWrite') },
    preValidation: async request => { validateCorrection(request.body) },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const wid = request.member!.weddingId, id = (request.params as { paymentId: string }).paymentId
    return amendAndRead(db(), request, reply, 'payments.correct',
      (tx, write) => lockAmendmentContext(tx, wid, actor(request), { type: 'payment', id }, write),
      (tx, context) => correctPayment(tx, context, id, request.body as CorrectionInput),
      (tx, context) => paymentProjection(tx, context, id))
  })
  const querystring = { type: 'object', additionalProperties: false, properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: { type: 'string' },
  } } as const
  app.get('/weddings/:weddingId/payments/:paymentId/history', { schema: { querystring } }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const wid = request.member!.weddingId, id = (request.params as { paymentId: string }).paymentId
    return db().tx(async tx => {
      const context = await lockAmendmentContext(tx, wid, actor(request), { type: 'payment', id })
      const result = await amendmentHistory(tx, context, 'payment', id, request.query as { limit?: unknown; cursor?: unknown })
      await assertSeatingToken(request)
      return result
    })
  })
  app.get('/weddings/:weddingId/payment-schedule/:installmentId/history', { schema: { querystring } }, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const wid = request.member!.weddingId, id = (request.params as { installmentId: string }).installmentId
    return db().tx(async tx => {
      const context = await lockAmendmentContext(tx, wid, actor(request), { type: 'installment', id })
      const result = await amendmentHistory(tx, context, 'installment', id, request.query as { limit?: unknown; cursor?: unknown })
      await assertSeatingToken(request)
      return result
    })
  })
}
