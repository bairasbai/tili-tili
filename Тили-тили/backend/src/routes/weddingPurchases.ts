import type { FastifyInstance } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { ref } from '../contract/schemas.generated.js'
import { AppError } from '../errors.js'
import { UUID_ID } from '../ids.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess, weddingAccessHook } from '../wedding/access.js'
import { listWeddingPurchases, saveWeddingPurchase, weddingPurchaseHistory } from '../wedding/purchases.js'

export async function weddingPurchaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preValidation', weddingAccessHook(app))
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const path = '/weddings/:weddingId/purchases'
  const params = { type: 'object', required: ['weddingId', 'purchaseId'],
    properties: { weddingId: UUID_ID, purchaseId: UUID_ID } }

  app.get(path, { schema: { response: { 200: ref('WeddingPurchaseList') } } }, (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const result = await listWeddingPurchases(client, request.member!.weddingId)
      await assertSeatingToken(request)
      return result
    })
  })
  app.put(path + '/:purchaseId', { schema: { params, body: ref('WeddingPurchaseWrite'),
    response: { 200: ref('WeddingPurchase') } } }, (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { purchaseId } = request.params as { purchaseId: string }
    return db().tx(async client => {
      await lockSeatingAccess(client, request)
      const result = await saveWeddingPurchase(client, request.member!.weddingId, purchaseId, request.caller!.userId,
        request.body as components['schemas']['WeddingPurchaseWrite'])
      await assertSeatingToken(request)
      return result
    })
  })
  app.get(path + '/:purchaseId/history', { schema: { params, response: { 200: ref('WeddingPurchaseHistory') } } }, (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { purchaseId } = request.params as { purchaseId: string }
    return db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const result = await weddingPurchaseHistory(client, request.member!.weddingId, purchaseId)
      await assertSeatingToken(request)
      return result
    })
  })
}
