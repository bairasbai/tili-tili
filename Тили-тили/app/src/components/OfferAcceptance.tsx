import { useRef, useState } from 'react'
import { acceptOffer, type OfferPublic, type OfferRequest } from '@/lib/api/offers'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { useOfferDay } from '@/lib/useOfferDay'
import { t } from '@/lib/i18n'

const CONFLICT_COPY: Record<string, string> = {
  offer_expired: 'Срок предложения истёк — запросите новое',
  offer_stale_date: 'Предложение на прежнюю дату — запросите заново',
  offer_superseded: 'Подрядчик изменил предложение — проверьте новые условия',
  request_closed: 'Запрос уже закрыт',
  offer_declined: 'Подрядчик отказался от запроса',
  slot_taken: 'Место уже занято — обновите предложения',
  date_taken: 'Эта дата у подрядчика уже занята',
  vendor_unavailable: 'Анкета подрядчика недоступна',
}

/** Mount with a wedding/offer key, so a new version is a new explicit intent. */
export function OfferAcceptance({ weddingId, request, currentWeddingDate, weddingTz, canAccept, onChanged }: {
  weddingId: string
  request?: OfferRequest | OfferPublic
  currentWeddingDate: string | null
  weddingTz?: string | null
  canAccept: boolean
  onChanged: () => void
}) {
  const today = useOfferDay(weddingTz)
  const attempt = useRef<string | null>(null)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [failure, setFailure] = useState<{ message: string; refresh: boolean } | null>(null)
  const full = request && 'id' in request ? request : null
  const offer = full?.offer
  const eligible = canAccept && full?.status === 'open' && full.weddingDate === currentWeddingDate
    && offer?.kind === 'offer' && offer.validUntil >= today

  const accept = async () => {
    if (!eligible || !offer || busy.current || accepted || failure?.refresh) return
    busy.current = true
    setPending(true)
    setFailure(null)
    attempt.current ??= newIdempotencyKey()
    try {
      await acceptOffer(weddingId, offer.id, attempt.current)
      setAccepted(true)
      onChanged()
    } catch (error) {
      const conflict = error instanceof ApiError && CONFLICT_COPY[error.code]
      // Transport uncertainty and an in-progress request retain the original key.
      // A definitive application refusal allows a fresh intent after reloading.
      if (error instanceof ApiError && !error.isDown && error.code !== 'idempotency_in_progress') attempt.current = null
      setFailure({ message: conflict ? t(conflict) : explainError(error), refresh: Boolean(conflict) })
    } finally {
      busy.current = false
      setPending(false)
    }
  }

  if (accepted) return <p role="status" className="text-[11px] text-[var(--sage-ink)] mt-2">{t('Бронь создана по условиям предложения')}</p>
  if (!eligible && !failure) return null
  return <div className="mt-2 space-y-2">
    {eligible && !failure?.refresh && <button
      disabled={pending}
      onClick={() => void accept()}
      aria-label={`${t('Принять предложение')}: ${offer?.title ?? ''}`}
      className="press px-4 py-2 rounded-xl grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50"
    >{pending ? t('Принимаем…') : t('Принять')}</button>}
    {failure && <p role="alert" className="text-[11px] text-[var(--rose-ink)]">{failure.message}</p>}
    {failure?.refresh && <button onClick={onChanged} className="press px-3 py-2 rounded-xl bg-[var(--track)] text-[11px] font-semibold">{t('Обновить предложения')}</button>}
  </div>
}
