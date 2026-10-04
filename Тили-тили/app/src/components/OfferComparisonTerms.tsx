import type { components } from '@/lib/api/schema'
import { OFFER_COMPARISON_FIELDS, type OfferComparisonTerms as ComparisonTerms } from '@/lib/offerComparisonTerms'
import { t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'

/** Omitted monetary field is hidden; an explicit null means the conditions are unknown. */
export function OfferComparisonTerms({ terms }: { terms: ComparisonTerms | undefined }) {
  if (terms === undefined) return null
  return <dl className="mt-2 space-y-2 text-[11px]">
    {OFFER_COMPARISON_FIELDS.map(({ name, label }) => <div key={name} className="min-w-0">
      <dt className="font-medium text-[var(--soft)]">{t(label)}</dt>
      <dd className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--ink2)]">{terms?.[name] ?? t('Неизвестно')}</dd>
    </div>)}
  </dl>
}

/** Same native read's day/source/time; no TTL or resource availability claim. */
export function OfferAvailabilityObservation({ observation }: {
  observation: components['schemas']['ShortlistEntry']['availabilityObservation'] | undefined
}) {
  if (!observation) return <span className="text-[var(--soft)]">{t('Неизвестно')}</span>
  return <div className="space-y-1 text-left break-words [overflow-wrap:anywhere]">
    <p>{t('Календарь дня')}</p>
    <p>{t('Дата календаря')}: {formatWeddingDate(observation.date)}</p>
    <p>{t('Время чтения')}: <time dateTime={observation.checkedAt}>{observation.checkedAt}</time></p>
    <p className="text-[var(--soft)]">{t('Время чтения не подтверждает доступность отдельных ресурсов')}</p>
  </div>
}
