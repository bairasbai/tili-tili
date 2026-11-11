import { api, url } from './client'
import { assertUploadPhoto, awaitMediaProcessing, sendSignedFile, type MediaActionOptions, type MediaProgress } from './media'
import type { components } from './schema'

export type AlbumPhoto = components['schemas']['AlbumPhoto']

export const getGuestAlbum = (guestToken: string, options: MediaActionOptions) =>
  api.get(url('/join/{guestToken}/album', { guestToken }), { ...options, auth: false })

export const getGuestAlbumImage = (guestToken: string, photoId: string, options: MediaActionOptions) =>
  api.getBlob(url('/join/{guestToken}/album/{photoId}/content', { guestToken, photoId }), { ...options, auth: false })

export const getTeamAlbumImage = (weddingId: string, photoId: string, options: MediaActionOptions) =>
  api.getBlob(url('/weddings/{weddingId}/album/{photoId}/content', { weddingId, photoId }), options)

export async function uploadGuestAlbumPhoto(guestToken: string, file: File, key: string, sentUploadId: string | null,
  options: MediaActionOptions & { onProgress: (phase: MediaProgress) => void; onSent: (uploadId: string) => void }) {
  const assertCurrent = () => {
    options.assertCurrent()
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }
  const access = { auth: false as const, assertCurrent, signal: options.signal }
  assertCurrent()
  let uploadId = sentUploadId
  if (!uploadId) {
    const contentType = assertUploadPhoto(file)
    options.onProgress('uploading')
    const grant = await api.post(url('/join/{guestToken}/album/uploads', { guestToken }),
      { contentType, sizeBytes: file.size, consent: true }, { ...access, idempotencyKey: key })
    await sendSignedFile(grant, file, 'album', access)
    assertCurrent()
    uploadId = grant.uploadId
    options.onSent(uploadId)
  }
  options.onProgress('scanning')
  const params = { guestToken, uploadId }
  const result = await api.post(url('/join/{guestToken}/album/uploads/{uploadId}/complete', params), {}, { ...access, timeoutMs: 120_000 })
  return awaitMediaProcessing(result, () => api.get(url('/join/{guestToken}/album/uploads/{uploadId}', params), access), assertCurrent)
}
