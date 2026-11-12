import { api, url } from './client'
import type { components } from './schema'

export type ThanksPreview = components['schemas']['ThanksPreview']
export type ThanksReceipt = components['schemas']['ThanksReceipt']
type ThanksDraft = components['schemas']['ThanksDraft']
type ThanksConfirm = components['schemas']['ThanksConfirm']
type Options = { assertCurrent: () => void }

const path = '/weddings/{weddingId}/thanks'
export const getThanksRecipients = (weddingId: string, options: Options) =>
  api.get(url(path, { weddingId }), options)
export const previewGuestThanks = (weddingId: string, body: ThanksDraft, options: Options) =>
  api.post(url(`${path}/preview`, { weddingId }), body, options)
export const confirmGuestThanks = (weddingId: string, body: ThanksConfirm, options: Options) =>
  api.post(url(path, { weddingId }), body, options)
