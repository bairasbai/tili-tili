import { api, ApiError, url } from './client'
import { awaitMediaProcessing, sendSignedFile, type MediaActionOptions, type MediaProgress } from './media'

type Version = { dealId: string; documentId: string }
type Attachment = Version & { uploadId: string }
const path = '/deals/{dealId}/documents/{documentId}/attachments'

export const getContractVersions = (dealId: string, options: MediaActionOptions) =>
  api.get(url('/deals/{dealId}/documents', { dealId }), options)

export const recordContractAgreement = (version: Version, action: 'propose' | 'agree', attachmentId: string | null, options: MediaActionOptions) =>
  api.post(url('/deals/{dealId}/documents/{documentId}/agreement', version), { action, attachmentId }, options)

export const downloadContractAttachment = (attachment: Attachment, options: MediaActionOptions) =>
  api.getBlob(url(`${path}/{uploadId}/content`, attachment), options)

export const removeContractAttachment = (attachment: Attachment, options: MediaActionOptions) =>
  api.delete(url(`${path}/{uploadId}`, attachment), options)

export async function checkContractAttachment(attachment: Attachment, options: MediaActionOptions) {
  const result = await api.post(url(`${path}/{uploadId}/complete`, attachment), {}, { ...options, timeoutMs: 120_000 })
  return awaitMediaProcessing(result, () => api.get(url(`${path}/{uploadId}`, attachment), options), options.assertCurrent)
}

export async function uploadContractAttachment(version: Version, file: File, idempotencyKey: string,
  options: MediaActionOptions & { onProgress: (state: MediaProgress) => void }) {
  if ((file.type !== 'application/pdf' && (file.type !== '' || !file.name.toLowerCase().endsWith('.pdf')))
    || file.size < 1 || file.size > 10 * 1024 * 1024) {
    throw new ApiError('http', 422, 'media_invalid_pdf', 'Нужен PDF размером до 10 МиБ')
  }
  options.assertCurrent()
  options.onProgress('uploading')
  const grant = await api.post(url(path, version), { sizeBytes: file.size }, { ...options, idempotencyKey })
  await sendSignedFile(grant, file, 'contract.pdf', options)
  options.assertCurrent()
  options.onProgress('scanning')
  return checkContractAttachment({ ...version, uploadId: grant.uploadId }, options)
}
