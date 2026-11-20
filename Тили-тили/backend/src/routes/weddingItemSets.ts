import type { FastifyInstance } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { ref } from '../contract/schemas.generated.js'
import { AppError } from '../errors.js'
import { UUID_ID } from '../ids.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess, weddingAccessHook } from '../wedding/access.js'
import { listWeddingItems, saveWeddingItem, weddingItemHistory } from '../wedding/item-sets.js'

export async function weddingItemSetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preValidation', weddingAccessHook(app))
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const path = '/weddings/:weddingId/item-sets'
  const params = { type: 'object', required: ['weddingId', 'itemId'],
    properties: { weddingId: UUID_ID, itemId: UUID_ID } }

  app.get(path, { schema: { response: { 200: ref('WeddingItemList') } } }, (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const result = await listWeddingItems(client, request.member!.weddingId)
      await assertSeatingToken(request)
      return result
    })
  })
  app.put(path + '/:itemId', { schema: { params, body: ref('WeddingItemWrite'),
    response: { 200: ref('WeddingItem') } } }, (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { itemId } = request.params as { itemId: string }
    return db().tx(async client => {
      await lockSeatingAccess(client, request)
      const result = await saveWeddingItem(client, request.member!.weddingId, itemId, request.caller!.userId,
        request.body as components['schemas']['WeddingItemWrite'])
      await assertSeatingToken(request)
      return result
    })
  })
  app.get(path + '/:itemId/history', { schema: { params, response: { 200: ref('WeddingItemHistory') } } }, (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { itemId } = request.params as { itemId: string }
    return db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const result = await weddingItemHistory(client, request.member!.weddingId, itemId)
      await assertSeatingToken(request)
      return result
    })
  })
}
