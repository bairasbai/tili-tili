import { api, url, ApiError, beginLocalSessionAction, onSessionChanged } from './client'
import type { components } from './schema'

export type MediaUpload = components['schemas']['MediaUpload']
type MediaUploadGrant = components['schemas']['MediaUploadGrant']
export type MediaProgress = 'uploading' | 'scanning'
export interface MediaActionOptions { assertCurrent: () => void; signal?: AbortSignal }
export const getPortfolioUploads = (options: MediaActionOptions) => api.get('/media/uploads', options)
export const removePortfolioPhoto = (id: string, options: MediaActionOptions) => api.delete(url('/media/uploads/{uploadId}', { uploadId: id }), options)
export async function getPortfolioPreview(id: string, options: MediaActionOptions) {
  const controller = new AbortController(), abort = () => controller.abort(), stop = onSessionChanged(abort)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = setTimeout(abort, 15_000)
  try { return await api.getBlob(url('/media/photos/{uploadId}', { uploadId: id }), { ...options, signal: controller.signal }) }
  finally { clearTimeout(timeout); stop(); options.signal?.removeEventListener('abort', abort); controller.abort() }
}
export const isManagedPhotoURL = (value: string, known: string[] = []) => {
  if (known.includes(value)) return true
  try {
    const own = new URL(import.meta.env.VITE_API_URL ?? '/api', window.location.origin), parsed = new URL(value)
    return parsed.origin === own.origin && parsed.pathname.startsWith(own.pathname.replace(/\/$/, '') + '/media/photos/')
  } catch { return false }
}

export async function completePortfolioPhoto(id: string, options: MediaActionOptions): Promise<MediaUpload> {
  const owner = beginLocalSessionAction()
  const assertCurrent = () => { options.assertCurrent(); owner.assertCurrent(); if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError') }
  try {
    assertCurrent()
    const result = await api.post(url('/media/uploads/{uploadId}/complete', { uploadId: id }), {}, { assertCurrent, signal: options.signal, timeoutMs: 120_000 })
    return await awaitMediaProcessing(result, () => api.get(url('/media/uploads/{uploadId}', { uploadId: id }), { assertCurrent, signal: options.signal }), assertCurrent)
  } finally { owner.close() }
}

export async function awaitMediaProcessing(result: MediaUpload, status: () => Promise<MediaUpload>, assertCurrent: () => void) {
  assertCurrent()
  for (let attempt = 0; result.state === 'processing' && attempt < 60; attempt++) {
    await new Promise<void>(resolve => setTimeout(resolve, 1500))
    assertCurrent()
    result = await status()
    assertCurrent()
  }
  return result
}

export function assertUploadPhoto(file: File): MediaUpload['contentType'] {
  const type = file.type
  if ((type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/webp') || file.size < 1 || file.size > 10 * 1024 * 1024) {
    throw new ApiError('http', 422, 'media_invalid_photo', 'Нужна фотография JPEG, PNG или WebP до 10 МиБ')
  }
  return type
}

export async function sendSignedFile(grant: MediaUploadGrant, file: File, filename: 'portfolio' | 'album' | 'contract.pdf', options: MediaActionOptions) {
  options.assertCurrent()
  const controller = new AbortController(), abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(abort, 90_000)
  try {
    const body = new FormData()
    for (const [key, value] of Object.entries(grant.fields)) body.append(key, value)
    body.append('file', file, filename)
    const response = await fetch(grant.uploadUrl, { method: 'POST', body, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal })
    try {
      options.assertCurrent()
      if (!response.ok) throw new ApiError('http', response.status, 'media_storage_unavailable', filename === 'contract.pdf'
        ? 'Не удалось загрузить файл — повторите попытку' : 'Не удалось загрузить фотографию — повторите попытку')
      const reader = response.body?.getReader()
      if (reader) {
        try {
          let received = 0
          for (;;) {
            const chunk = await reader.read(); options.assertCurrent()
            if (chunk.done) break
            received += chunk.value.byteLength
            if (received > 64 * 1024) throw new Error('Unexpected provider response')
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      }
    } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

/** One lifetime fences issue -> provider -> complete, including A -> B -> A. */
export async function uploadPortfolioPhoto(file: File, idempotencyKey: string,
  options: MediaActionOptions & { onProgress: (state: MediaProgress) => void; onIntent: (id: string) => void }): Promise<MediaUpload> {
  const owner = beginLocalSessionAction(), controller = new AbortController()
  const abort = () => controller.abort()
  const unsubscribe = onSessionChanged(abort)
  options.signal?.addEventListener('abort', abort, { once: true })
  const assertCurrent = () => { options.assertCurrent(); owner.assertCurrent(); if (options.signal?.aborted || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError') }
  try {
    assertCurrent()
    assertUploadPhoto(file)
    const grant = await api.post('/media/upload-url', { kind: 'vendor_photo', contentType: file.type, sizeBytes: file.size }, { assertCurrent, signal: controller.signal, idempotencyKey })
    assertCurrent(); options.onIntent(grant.uploadId); options.onProgress('uploading')
    await sendSignedFile(grant, file, 'portfolio', { assertCurrent, signal: controller.signal })
    assertCurrent(); options.onProgress('scanning')
    const result = await completePortfolioPhoto(grant.uploadId, { assertCurrent, signal: controller.signal })
    assertCurrent(); return result
  } finally {
    unsubscribe(); options.signal?.removeEventListener('abort', abort); controller.abort(); owner.close()
  }
}
