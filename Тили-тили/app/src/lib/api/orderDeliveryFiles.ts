import { api, ApiError, url } from './client'
import { assertUploadPhoto, awaitMediaProcessing, sendSignedFile, type MediaActionOptions, type MediaProgress } from './media'

type Target = { dealId: string; uploadId: string }
const path = '/deals/{dealId}/order/delivery/files'

export const downloadDeliveryFile = (target: Target, options: MediaActionOptions) =>
  api.getBlob(url(`${path}/{uploadId}/content`, target), options)

export const removeDeliveryFile = (target: Target, options: MediaActionOptions) =>
  api.delete(url(`${path}/{uploadId}`, target), options)

export async function checkDeliveryFile(target: Target, options: MediaActionOptions) {
  const result = await api.post(url(`${path}/{uploadId}/complete`, target), {}, { ...options, timeoutMs: 120_000 })
  const checked = await awaitMediaProcessing(result, () => api.get(url(`${path}/{uploadId}`, target), options), options.assertCurrent)
  if (checked.state !== 'ready') throw new ApiError('http', 409, 'media_processing_pending', 'Проверка ещё не завершена — перечитайте состояние')
}

export async function uploadDeliveryFile(dealId: string, revision: number, file: File, idempotencyKey: string,
  options: MediaActionOptions & { onProgress: (state: MediaProgress) => void }) {
  const pdf = file.type === 'application/pdf' || (!file.type && file.name.toLowerCase().endsWith('.pdf'))
  if (pdf && (file.size < 1 || file.size > 10 * 1024 * 1024)) {
    throw new ApiError('http', 422, 'media_invalid_pdf', 'Нужен PDF размером до 10 МиБ')
  }
  const contentType = pdf ? 'application/pdf' : assertUploadPhoto(file)
  options.assertCurrent()
  options.onProgress('uploading')
  const grant = await api.post(url(path, { dealId }), { revision, contentType, sizeBytes: file.size }, { ...options, idempotencyKey })
  await sendSignedFile(grant, file, 'material', options)
  options.assertCurrent()
  options.onProgress('scanning')
  await checkDeliveryFile({ dealId, uploadId: grant.uploadId }, options)
}
