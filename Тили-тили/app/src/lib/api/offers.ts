import { api, url } from './client'
import type { components, paths } from './schema'

type OfferRequestRoute = paths['/weddings/{weddingId}/slots/{slotId}/offer-requests']['post']

export type Offer = components['schemas']['Offer']
export type OfferInput = components['schemas']['OfferInput']
export type OfferRequest = components['schemas']['OfferRequest']
export type OfferPublic = components['schemas']['OfferPublic']
export type OfferRequestInput = OfferRequestRoute['requestBody']['content']['application/json']
export type OfferRequestBatch = OfferRequestRoute['responses'][201]['content']['application/json']
export type OfferRequestResult = OfferRequestBatch['results'][number]

/**
 * Отправить одну пользовательскую попытку запроса выбранным кандидатам.
 * Ключ создаёт экран и сохраняет до ответа: после обрыва сети повтор обязан
 * уйти с тем же ключом, а не создать второй набор запросов.
 */
export const requestOffers = (
  weddingId: string,
  slotId: string,
  body: OfferRequestInput,
  idempotencyKey: string,
) => api.post(
  url('/weddings/{weddingId}/slots/{slotId}/offer-requests', { weddingId, slotId }),
  body,
  { idempotencyKey },
)

/** Retry an indeterminate outcome with this SAME key. No editable terms. */
export const acceptOffer = (weddingId: string, offerId: string, idempotencyKey: string) => api.postWithoutBody(
  url('/weddings/{weddingId}/offers/{offerId}/accept', { weddingId, offerId }),
  { idempotencyKey },
)
