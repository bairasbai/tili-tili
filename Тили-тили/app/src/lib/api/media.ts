import { api, url, ApiError, beginLocalSessionAction, onSessionChanged } from './client'
import type { components } from './schema'

export type MediaUpload = components['schemas']['MediaUpload']
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
    let result = await api.post(url('/media/uploads/{uploadId}/complete', { uploadId: id }), {}, { assertCurrent, signal: options.signal, timeoutMs: 120_000 })
    assertCurrent()
    for (let attempt = 0; result.state === 'processing' && attempt < 60; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 1500))
      assertCurrent()
      result = await api.get(url('/media/uploads/{uploadId}', { uploadId: id }), { assertCurrent, signal: options.signal })
      assertCurrent()
    }
    return result
  } finally { owner.close() }
}

/** One lifetime fences issue -> provider -> complete, including A -> B -> A. */
export async function uploadPortfolioPhoto(file: File, idempotencyKey: string,
  options: MediaActionOptions & { onProgress: (state: MediaProgress) => void; onIntent: (id: string) => void }): Promise<MediaUpload> {
  const owner = beginLocalSessionAction(), controller = new AbortController()
  const abort = () => controller.abort()
  const unsubscribe = onSessionChanged(abort)
  options.signal?.addEventListener('abort', abort, { once: true })
  const assertCurrent = () => { options.assertCurrent(); owner.assertCurrent(); if (options.signal?.aborted || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError') }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    assertCurrent()
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) {
      throw new ApiError('http', 422, 'media_invalid_photo', 'Нужна фотография JPEG, PNG или WebP до 10 МиБ')
    }
    const grant = await api.post('/media/upload-url', { kind: 'vendor_photo', contentType: file.type, sizeBytes: file.size }, { assertCurrent, signal: controller.signal, idempotencyKey })
    assertCurrent(); options.onIntent(grant.uploadId); options.onProgress('uploading')
    const body = new FormData()
    for (const [key, value] of Object.entries(grant.fields)) body.append(key, value)
    body.append('file', file, 'portfolio')
    timer = setTimeout(abort, 90_000)
    const response = await fetch(grant.uploadUrl, { method: 'POST', body, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal })
    try {
      assertCurrent()
      if (!response.ok) throw new ApiError('http', response.status, 'media_storage_unavailable', 'Не удалось загрузить фотографию — повторите попытку')
      const reader = response.body?.getReader()
      if (reader) {
        try {
          let received = 0
          for (;;) {
            const chunk = await reader.read(); assertCurrent()
            if (chunk.done) break
            received += chunk.value.byteLength
            if (received > 64 * 1024) throw new Error('Unexpected provider response')
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      }
    } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined) }
    clearTimeout(timer); assertCurrent(); options.onProgress('scanning')
    const result = await completePortfolioPhoto(grant.uploadId, { assertCurrent, signal: controller.signal })
    assertCurrent(); return result
  } finally {
    clearTimeout(timer); unsubscribe(); options.signal?.removeEventListener('abort', abort); controller.abort(); owner.close()
  }
}
