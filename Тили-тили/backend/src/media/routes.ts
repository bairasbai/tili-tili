import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { readKeyHeader } from '../deals/idempotency.js'
import type { ManagedMediaService, UploadInput } from './service.js'

declare module 'fastify' { interface FastifyInstance { managedMedia: ManagedMediaService | null } }
const params = { type: 'object', required: ['uploadId'], additionalProperties: false,
  properties: { uploadId: { type: 'string', format: 'uuid' } } } as const

export async function mediaRoutes(app: FastifyInstance) {
  const service = () => {
    if (!app.managedMedia) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.managedMedia
  }
  app.post('/media/upload-url', { preHandler: app.requireConsent,
    schema: { body: { type: 'object', required: ['kind', 'contentType', 'sizeBytes'], additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['vendor_photo', 'vendor_video', 'album_photo', 'document_scan'] },
        contentType: { type: 'string', maxLength: 100 }, sizeBytes: { type: 'integer', minimum: 1, maximum: 10485760 } } } } },
  async (request, reply) => {
    // The shared reader handles malformed headers. The service requires its
    // stricter bounded key for photos; unsupported file purposes retain 501.
    const input = request.body as UploadInput
    const key = readKeyHeader(request, input.kind === 'vendor_photo') ?? ''
    const result = await service().issue(request, input, key)
    return reply.code(201).send(result)
  })
  app.get('/media/uploads', { preHandler: app.requireConsent }, request => service().list(request))
  app.get('/media/uploads/:uploadId', { preHandler: app.requireConsent, schema: { params } }, request =>
    service().status(request, (request.params as { uploadId: string }).uploadId))
  app.post('/media/uploads/:uploadId/complete', { preHandler: app.requireConsent, schema: { params } }, async (request, reply) => {
    const result = await service().complete(request, (request.params as { uploadId: string }).uploadId)
    return reply.code(result.state === 'processing' ? 202 : 200).send(result)
  })
  app.delete('/media/uploads/:uploadId', { preHandler: app.requireConsent, schema: { params } }, request =>
    service().remove(request, (request.params as { uploadId: string }).uploadId))
  app.get('/media/photos/:uploadId', { schema: { params }, preHandler: async (request, reply) => {
    if (request.headers.authorization) await app.requireConsent(request, reply)
  } }, async (request, reply) => {
    const { bytes, release } = await service().deliver(request, (request.params as { uploadId: string }).uploadId)
    if (reply.raw.destroyed || request.raw.aborted) { release(); return reply }
    const retire = () => {
      clearTimeout(deadline)
      reply.raw.off('finish', retire); reply.raw.off('close', retire)
      release()
    }
    const deadline = setTimeout(() => reply.raw.destroy(), 30_000)
    deadline.unref()
    reply.raw.once('finish', retire); reply.raw.once('close', retire)
    try {
      return reply.type('image/webp').header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', 'inline; filename="portfolio.webp"').send(bytes)
    } catch (error) { retire(); throw error }
  })
}
