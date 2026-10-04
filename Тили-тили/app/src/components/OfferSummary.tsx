import { useOfferDay } from '@/lib/useOfferDay'
import type { OfferPublic, OfferRequest } from '@/lib/api/offers'
import { fmt } from '@/lib/money'
import { formatWeddingDate } from '@/lib/weddingDate'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { OfferComparisonTerms } from './OfferComparisonTerms'

function isFullOfferRequest(request: OfferRequest | OfferPublic): request is OfferRequest {
  return 'id' in request
}

function closeReason(reason: OfferRequest['closeReason']): string {
  if (reason === 'removed') return t('Запрос отозван')
  if (reason === 'booked_other') return t('Выбран другой исполнитель')
  if (reason === 'booked') return t('Предложение выбрано')
  if (reason === 'wedding_cancelled') return t('Свадьба отменена')
  if (reason === 'date_changed') return t('Дата свадьбы изменилась')
  if (reason === 'vendor_erased') return t('Анкета подрядчика удалена')
  return t('Запрос закрыт')
}

/** Один и тот же честный показ ответа на месте, в анкете и в сравнении. */
export function OfferSummary({
  request,
  currentWeddingDate,
  weddingTz,
  compact = false,
  showComparisonTerms = true,
}: {
  request?: OfferRequest | OfferPublic
  /** `undefined` — экран не знает нынешнюю дату; `null` — дата снята. */
  currentWeddingDate?: string | null
  weddingTz?: string | null
  compact?: boolean
  showComparisonTerms?: boolean
}) {
  const today = useOfferDay(weddingTz)
  if (!request) return <span className="text-[var(--soft)]">—</span>

  if (!isFullOfferRequest(request)) return (
    <span className="text-[var(--soft)]">
      {request.status === 'responded' ? t('Подрядчик ответил') : t('Ждём ответ')}
    </span>
  )

  const oldDate = currentWeddingDate !== undefined && request.weddingDate !== currentWeddingDate
  const offer = request.offer
  return (
    <div className={cn('text-left', compact ? 'space-y-1' : 'space-y-1.5')}>
      {oldDate && <p className="font-semibold text-[var(--rose-ink)]">{t('На прежнюю дату — запросите заново')}</p>}
      {request.status === 'closed' && !oldDate && (
        <p className="font-semibold text-[var(--soft)]">{closeReason(request.closeReason)}</p>
      )}
      {!offer ? (
        <p className="text-[var(--soft)]">{request.status === 'open' ? t('Ждём ответ') : t('Ответа не было')}</p>
      ) : offer.kind === 'decline' ? (
        <>
          <p className="font-semibold text-[var(--rose-ink)]">{t('Подрядчик отказался')}</p>
          <p className="font-normal text-[var(--ink2)] whitespace-pre-wrap">{offer.message}</p>
        </>
      ) : (
        <>
          {request.closeReason !== 'booked' && offer.validUntil < today && <p className="font-semibold text-[var(--rose-ink)]">{t('Срок предложения истёк')}</p>}
          <p className="font-semibold">{offer.title}</p>
          <p className="font-semibold tabular text-[var(--rose-ink)]">{fmt(offer.price.amount)}</p>
          {offer.includes.length > 0 ? (
            <ul className="list-disc pl-4 font-normal text-[var(--ink2)]">
              {offer.includes.map((part, index) => <li key={`${index}-${part}`}>{part}</li>)}
            </ul>
          ) : <p className="text-[var(--soft)]">{t('Состав услуги неизвестен')}</p>}
          {showComparisonTerms && <OfferComparisonTerms terms={offer.comparisonTerms} />}
          {offer.message && <p className="font-normal text-[var(--ink2)] whitespace-pre-wrap">{offer.message}</p>}
          <p className="text-[var(--soft)] font-normal">{t('Действует до')} {formatWeddingDate(offer.validUntil)}</p>
        </>
      )}
    </div>
  )
}
