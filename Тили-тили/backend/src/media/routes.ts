import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../errors.js'
import { readKeyHeader } from '../deals/idempotency.js'
import { PHOTO_MAX_BYTES } from './storage.js'
import type { AlbumUploadInput, ManagedMediaService, UploadInput } from './service.js'

declare module 'fastify' { interface FastifyInstance { managedMedia: ManagedMediaService | null } }
const params = { type: 'object', required: ['uploadId'], additionalProperties: false,
  properties: { uploadId: { type: 'string', format: 'uuid' } } } as const
const guestTokenParam = { type: 'string', minLength: 1, maxLength: 200 } as const
const photoIdParam = { type: 'string', format: 'uuid' } as const
const guestParams = { type: 'object', required: ['guestToken'], properties: { guestToken: guestTokenParam } } as const
const guestUploadParams = { type: 'object', required: ['guestToken', 'uploadId'],
  properties: { guestToken: guestTokenParam, uploadId: photoIdParam } } as const
const noStore = 'private, no-store'

export function sendManagedFile(request: FastifyRequest, reply: FastifyReply, { bytes, release }: { bytes: Buffer; release: () => void },
  filename: 'portfolio.webp' | 'album.webp' | 'contract.pdf' | 'material.pdf' | 'material.webp') {
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
    const attachment = filename === 'contract.pdf' || filename.startsWith('material.')
    return reply.type(attachment ? 'application/octet-stream' : 'image/webp').header('Cache-Control', noStore)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', `${attachment ? 'attachment' : 'inline'}; filename="${filename}"`).send(bytes)
  } catch (error) { retire(); throw error }
}

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
    const photo = await service().deliver(request, (request.params as { uploadId: string }).uploadId)
    return sendManagedFile(request, reply, photo, 'portfolio.webp')
  })
  app.get('/join/:guestToken/album', { schema: { params: guestParams } }, async (request, reply) => {
    const { guestToken } = request.params as { guestToken: string }
    return reply.header('Cache-Control', noStore).send(await service().guestAlbum(guestToken, app.appConfig.env))
  })
  app.post('/join/:guestToken/album/uploads', { schema: { params: guestParams, body: {
    type: 'object', required: ['contentType', 'sizeBytes', 'consent'], additionalProperties: false,
    properties: { contentType: { type: 'string', maxLength: 100 }, sizeBytes: { type: 'integer', minimum: 1, maximum: PHOTO_MAX_BYTES },
      consent: { type: 'boolean' } },
  } } }, async (request, reply) => {
    const { guestToken } = request.params as { guestToken: string }
    const key = readKeyHeader(request, true)!
    const grant = await service().issueAlbum(guestToken, request.body as AlbumUploadInput, key, app.appConfig.albumMaxPerGuest, app.appConfig.env)
    return reply.code(201).header('Cache-Control', noStore).send(grant)
  })
  app.get('/join/:guestToken/album/uploads/:uploadId', { schema: { params: guestUploadParams } }, async (request, reply) => {
    const { guestToken, uploadId } = request.params as { guestToken: string; uploadId: string }
    return reply.header('Cache-Control', noStore).send(await service().albumStatus(guestToken, uploadId))
  })
  app.post('/join/:guestToken/album/uploads/:uploadId/complete', { schema: { params: guestUploadParams } }, async (request, reply) => {
    const { guestToken, uploadId } = request.params as { guestToken: string; uploadId: string }
    const result = await service().completeAlbum(guestToken, uploadId)
    return reply.code(result.state === 'processing' ? 202 : 200).header('Cache-Control', noStore).send(result)
  })
  app.get('/join/:guestToken/album/:photoId/content', { schema: { params: { type: 'object', required: ['guestToken', 'photoId'],
    properties: { guestToken: guestTokenParam, photoId: photoIdParam } } } }, async (request, reply) => {
    const { guestToken, photoId } = request.params as { guestToken: string; photoId: string }
    return sendManagedFile(request, reply, await service().deliverGuestAlbum(guestToken, photoId), 'album.webp')
  })
  app.get('/weddings/:weddingId/album/:photoId/content', { schema: { params: { type: 'object', required: ['weddingId', 'photoId'],
    properties: { weddingId: photoIdParam, photoId: photoIdParam } } } }, async (request, reply) => {
    const { photoId } = request.params as { photoId: string }
    return sendManagedFile(request, reply, await service().deliverTeamAlbum(request, photoId), 'album.webp')
  })
}
