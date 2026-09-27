import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { acceptOffer } from '@/lib/api/offers'
import { newIdempotencyKey } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { useStore } from '@/lib/store'
import { t } from '@/lib/i18n'

export function OfferAccept({ weddingId, offerId, onChanged }: {
  weddingId: string; offerId: string; onChanged?: () => void
}) {
  const nav = useNavigate()
  const { refreshSlots } = useStore()
  const attempt = useRef<{ offerId: string; key: string } | null>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const accept = async () => {
    if (pending.current || done) return
    if (attempt.current?.offerId !== offerId) attempt.current = { offerId, key: newIdempotencyKey() }
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const slot = await acceptOffer(weddingId, offerId, attempt.current.key)
      setDone(true)
      refreshSlots()
      onChanged?.()
      nav(`/wedding/slot/${slot.id}`)
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return <div className="pt-2">
    <button type="button" disabled={busy || done} onClick={() => void accept()}
      className="press w-full py-3 px-3 rounded-full grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50">
      {done ? t('Забронировано') : busy ? t('Бронируем…') : t('Принять предложение')}
    </button>
    {error && <p role="alert" className="mt-2 text-[var(--rose-ink)] font-normal">{error}</p>}
  </div>
}
