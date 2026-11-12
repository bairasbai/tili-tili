import type { components } from '@/lib/api/schema'
import { t } from '@/lib/i18n'

export function ArrivalDetails({ arrival }: { arrival?: components['schemas']['VenueArrival'] | null }) {
  if (!arrival) return null
  return <dl className="mt-2 space-y-1 text-[12px] break-words [overflow-wrap:anywhere]">
    {arrival.entrance && <div><dt className="font-semibold">{t('Вход на площадку')}</dt><dd className="whitespace-pre-line">{arrival.entrance}</dd></div>}
    {arrival.parking && <div><dt className="font-semibold">{t('Парковка')}</dt><dd className="whitespace-pre-line">{arrival.parking}</dd></div>}
    {arrival.accessibleRoute && <div><dt className="font-semibold">{t('Доступный путь')}</dt><dd className="whitespace-pre-line">{arrival.accessibleRoute}</dd></div>}
  </dl>
}
