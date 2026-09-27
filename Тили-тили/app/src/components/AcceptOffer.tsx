import { useRef, useState } from 'react'
import { acceptOffer } from '@/lib/api/offers'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'

export interface OfferAcceptance {
  weddingId: string
  disabled?: boolean
  onComplete: () => void
  onConflict: (message: string) => void
}

const CONFLICTS: Record<string, string> = {
  offer_expired: 'Срок предложения истёк',
  offer_stale_date: 'На прежнюю дату — запросите заново',
  offer_superseded: 'Подрядчик обновил предложение — проверьте новые условия',
  offer_declined: 'Подрядчик отказался',
  offer_accepted: 'Предложение уже принято',
  request_closed: 'Запрос закрыт',
  slot_taken: 'Место уже забронировано — обновили команду',
  date_taken: 'Дата у подрядчика уже занята — выберите другого',
  vendor_unavailable: 'Анкета подрядчика недоступна',
}

/** Mounted only for an eligible, full offer visible to a couple member. */
export function AcceptOffer({ offerId, acceptance }: { offerId: string; acceptance: OfferAcceptance }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const flight = useRef(false)
  const attempt = useRef<{ offerId: string; key: string } | null>(null)
  const submit = async () => {
    if (flight.current || acceptance.disabled) return
    flight.current = true
    setBusy(true)
    setError(null)
    if (attempt.current?.offerId !== offerId) attempt.current = { offerId, key: newIdempotencyKey() }
    try {
      await acceptOffer(acceptance.weddingId, offerId, attempt.current.key)
      attempt.current = null
      setConfirming(false)
      acceptance.onComplete()
    } catch (e) {
      // A lost response/5xx can hide a committed booking. Preserve the key
      // even if confirmation is closed and opened again on this card.
      const uncertain = !(e instanceof ApiError) || e.kind !== 'http' || e.status >= 500 || e.code === 'idempotency_in_progress'
      if (uncertain) setError(t('Ответ не получен. Повторите — второй брони не будет'))
      else {
        attempt.current = null
        setConfirming(false)
        const message = e instanceof ApiError && CONFLICTS[e.code] ? t(CONFLICTS[e.code]) : explainError(e)
        setError(message)
        acceptance.onConflict(message)
      }
    } finally {
      flight.current = false
      setBusy(false)
    }
  }
  return <div className="mt-3 space-y-2">
    {error && <p role="alert" className="font-normal text-[var(--rose-ink)]">{error}</p>}
    {confirming ? <>
      <p className="font-normal text-[var(--ink2)]">{t('Бронь сохранит цену и состав предложения выше. Оплата сейчас не списывается.')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || acceptance.disabled} onClick={() => void submit()} className="press px-3 py-2 rounded-xl grad text-[var(--on-grad)] font-semibold disabled:opacity-50">{busy ? t('Бронируем…') : t('Подтвердить бронь')}</button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="press px-3 py-2 rounded-xl bg-[var(--track)]">{t('Отмена')}</button>
      </div>
    </> : <button type="button" disabled={busy || acceptance.disabled} onClick={() => setConfirming(true)} className="press px-3 py-2 rounded-xl grad text-[var(--on-grad)] font-semibold disabled:opacity-50">{t('Принять предложение')}</button>}
  </div>
}
