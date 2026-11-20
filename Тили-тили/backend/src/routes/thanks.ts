import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ref } from '../contract/schemas.generated.js'
import { AppError, conflict } from '../errors.js'
import { confirmThanks, listThanksRecipients, previewThanks, type ThanksConfirm, type ThanksDraft } from '../guests/thanks.js'
import { UUID_ID } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'
import { readWeddingCompletion } from '../wedding/completion.js'

export async function guestThanksRoutes(app: FastifyInstance) {
  const path = '/weddings/:weddingId/thanks'
  const params = { type: 'object', required: ['weddingId'], properties: { weddingId: UUID_ID } }
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const secret = () => {
    if (!app.appConfig.jwtAccessSecret) throw new AppError(503, 'db_unavailable', 'Благодарности временно недоступны')
    return app.appConfig.jwtAccessSecret
  }
  async function authorize(client: Queryable, request: FastifyRequest, write = false) {
    await (write ? lockSeatingAccess : lockGuestReadAccess)(client, request)
    const { weddingId } = request.member!
    if ((await readWeddingCompletion(client, weddingId))?.state !== 'ready') {
      throw conflict('thanks_not_open', 'Благодарности откроются после последнего мероприятия')
    }
    return { weddingId, userId: request.caller!.userId, sessionId: request.caller!.sessionId }
  }
  app.get(path, { schema: { params, response: { 200: ref('ThanksRecipientList') } } }, request => db().tx(async client => {
    const { weddingId } = await authorize(client, request)
    const result = await listThanksRecipients(client, weddingId)
    await assertSeatingToken(request)
    return result
  }))
  app.post(`${path}/preview`, { schema: { params, body: ref('ThanksDraft'), response: { 200: ref('ThanksPreview') } } }, request =>
    db().tx(async client => {
      const origin = await authorize(client, request)
      const result = await previewThanks(client, origin, request.body as ThanksDraft, secret())
      await assertSeatingToken(request)
      return result
    }))
  app.post(path, { schema: { params, body: ref('ThanksConfirm'), response: { 200: ref('ThanksReceipt') } } }, request =>
    db().tx(async client => {
      const origin = await authorize(client, request, true)
      const result = await confirmThanks(client, origin, request.body as ThanksConfirm, secret())
      await assertSeatingToken(request)
      return result
    }))
}
