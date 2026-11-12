import { useParams } from 'react-router'
import { OrderTerms } from '@/components/OrderTerms'
import { TopBar } from '@/components/chrome'
import { t } from '@/lib/i18n'

export default function WeekTerms() {
  const { dealId } = useParams()
  return <div className="pb-28">
    <TopBar back title={t('Условия сделки')} />
    <div className="px-5">
      {dealId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dealId)
        ? <OrderTerms key={dealId} dealId={dealId} initiallyOpen />
        : <p role="alert">{t('Сделка не найдена')}</p>}
    </div>
  </div>
}
