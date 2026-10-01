import type { FastifyInstance } from 'fastify'
import { AppError, validationFailed } from '../errors.js'
import { UUID_ID } from '../ids.js'
import { ATTENTION_MODES, loadAttention, updateAttention, type AttentionMode } from '../wedding/attention.js'
import { lockOrderPrincipal } from '../orders/context.js'

export async function attentionRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  app.get('/weddings/:weddingId/attention', async (request, reply) => {
    const state = await loadAttention(db(), request.member!.weddingId)
    reply.header('ETag', `"${state.version}"`)
    return state
  })
  app.patch('/weddings/:weddingId/attention', { schema: { body: {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: {
      mode: { type: 'string', enum: ATTENTION_MODES },
      coordinatorUserId: { anyOf: [UUID_ID, { type: 'null' }] },
    },
  } } }, async (request, reply) => {
    const header = request.headers['if-match']
    if (header === undefined) throw new AppError(428, 'attention_version_required', 'Обновите настройки перед сохранением')
    const match = typeof header === 'string' ? /^"([1-9]\d*)"$/.exec(header) : null
    if (!match) throw validationFailed({ 'If-Match': 'Нужна версия полученных настроек' })
    const body = request.body as { mode?: AttentionMode; coordinatorUserId?: string | null }
    const state = await db().tx(async client => {
      // A session may have been revoked while this transaction waited for the wedding lock.
      const result = await updateAttention(client, { ...body, weddingId: request.member!.weddingId,
        actorUserId: request.caller!.userId, expectedVersion: match[1]! })
      await lockOrderPrincipal(client, { ...request.caller!, policyVersion: app.appConfig.policyVersion })
      return result
    })
    reply.header('ETag', `"${state.version}"`)
    return state
  })
}
