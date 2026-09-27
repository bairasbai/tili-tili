import { useRef, useState } from 'react'
import type { ShortlistEntry } from '@/lib/api/shortlist'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { requestOffers, type OfferRequestInput, type OfferRequestResult } from '@/lib/api/offers'
import { explainError } from '@/lib/api/useApi'
import { parseWholeRubles } from '@/lib/paymentAmount'
import { rub } from '@/lib/money'
import { t } from '@/lib/i18n'

function resultFromError(error: unknown): OfferRequestResult[] | null {
  if (!(error instanceof ApiError) || error.code !== 'no_request_sent') return null
  const results = error.details.results
  return Array.isArray(results) ? results as OfferRequestResult[] : null
}

function resultText(status: OfferRequestResult['status']): string {
  if (status === 'sent') return t('Запрос отправлен')
  if (status === 'busy') return t('Дата занята')
  if (status === 'already_open') return t('Запрос уже открыт')
  if (status === 'unavailable') return t('Анкета недоступна')
  if (status === 'category_changed') return t('Подрядчик сменил категорию')
  return t('Больше не в кандидатах')
}

/** Форма одной попытки пары; используется и на месте, и в анкете кандидата. */
export function OfferRequestComposer({
  weddingId,
  slotId,
  entries,
  onChanged,
}: {
  weddingId: string
  slotId: string
  entries: ShortlistEntry[]
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [wishes, setWishes] = useState('')
  const [budget, setBudget] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<OfferRequestResult[]>([])
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null)
  const names = Object.fromEntries(entries.map(entry => [entry.id, entry.vendor?.name ?? t('Анкета недоступна')]))

  const submit = async () => {
    if (busyRef.current || entries.length < 1 || entries.length > 3) return
    const budgetRubles = budget.trim() ? parseWholeRubles(budget) : null
    if (budget.trim() && (budgetRubles === null || budgetRubles <= 0)) {
      setError(t('Введите бюджет целым числом рублей больше нуля'))
      return
    }
    const body: OfferRequestInput = {
      entryIds: entries.map(entry => entry.id),
      ...(wishes.trim() ? { wishes: wishes.trim() } : {}),
      ...(budgetRubles === null ? {} : { budgetHint: { amount: rub(budgetRubles), currency: 'RUB' } }),
    }
    const fingerprint = JSON.stringify(body)
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, key: newIdempotencyKey() }
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    setResults([])
    try {
      const response = await requestOffers(weddingId, slotId, body, attempt.current.key)
      setResults(response.results)
      attempt.current = null
      setOpen(false)
      onChanged()
    } catch (cause) {
      const failed = resultFromError(cause)
      if (failed) {
        setResults(failed)
        setError(t('Ни одному кандидату запрос не отправлен'))
        onChanged()
      } else {
        setError(explainError(cause))
      }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      {!open && (
        <button
          type="button"
          disabled={entries.length < 1 || entries.length > 3}
          onClick={() => { setOpen(true); setError(null); setResults([]) }}
          className="press w-full py-3 rounded-[16px] grad text-[var(--on-grad)] text-[12px] font-semibold disabled:opacity-50"
        >{entries.length > 1 ? `${t('Запросить предложение')} (${entries.length})` : t('Запросить предложение')}</button>
      )}
      {open && (
        <div className="card-s rounded-[16px] p-3 space-y-2.5">
          <p className="text-[11px] text-[var(--soft)] leading-relaxed">{t('Пожелания и ориентир увидят только выбранные кандидаты')}</p>
          <textarea
            value={wishes}
            onChange={event => setWishes(event.target.value)}
            maxLength={2000}
            placeholder={t('Пожелания к предложению (необязательно)')}
            className="w-full min-h-20 rounded-[14px] bg-[var(--bg)] px-3 py-2.5 text-[12px] outline-none resize-y"
          />
          <input
            value={budget}
            onChange={event => setBudget(event.target.value)}
            inputMode="numeric"
            placeholder={t('Ориентир бюджета, ₽ (необязательно)')}
            aria-label={t('Ориентир бюджета, ₽ (необязательно)')}
            className="w-full h-11 rounded-[14px] bg-[var(--bg)] px-3 text-[12px] outline-none"
          />
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => setOpen(false)} className="press flex-1 h-10 rounded-full bg-[var(--track)] text-[11px] font-semibold disabled:opacity-50">{t('Отмена')}</button>
            <button type="button" disabled={busy} onClick={() => void submit()} className="press flex-1 h-10 rounded-full grad text-[var(--on-grad)] text-[11px] font-semibold disabled:opacity-50">{busy ? t('Отправляем…') : t('Отправить запрос')}</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[11px] text-[var(--rose-ink)]">{error}</p>}
      {results.length > 0 && (
        <div role="status" className="mt-2 space-y-1">
          {results.map(result => (
            <p key={result.entryId} className="text-[11px] text-[var(--ink2)]">
              <b>{names[result.entryId] ?? t('Кандидат')}:</b> {resultText(result.status)}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
