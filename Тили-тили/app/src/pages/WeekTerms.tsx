import { Link, useParams, useSearchParams } from 'react-router'
import { OrderTerms } from '@/components/OrderTerms'
import { DealEventMoveLinks } from '@/components/EventMoveReview'
import { DealJournal } from '@/components/DealJournal'
import { TopBar } from '@/components/chrome'
import { t } from '@/lib/i18n'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function WeekTerms({ showMoves = false, vendor = false }: { showMoves?: boolean; vendor?: boolean }) {
  const { dealId } = useParams()
  const [params] = useSearchParams()
  const documentId = params.get('document')
  const documentsPath = documentId && uuid.test(documentId) ? '/wedding/documents?' + new URLSearchParams({ document: documentId }).toString() : '/wedding/documents'
  const backTo = vendor && dealId && uuid.test(dealId) ? `/vendor-app/deals/${dealId}` : documentsPath
  return <div className="pb-28">
    <TopBar back title={t('Условия сделки')} fallback={showMoves ? backTo : undefined} />
    <div className="px-5">
      {dealId && uuid.test(dealId)
        ? <div key={dealId} className="space-y-3">
          <OrderTerms dealId={dealId} initiallyOpen />
          {showMoves && <DealJournal dealId={dealId} vendor={vendor} />}
          {showMoves && <DealEventMoveLinks dealId={dealId} />}
          {showMoves && <Link className="press inline-flex min-h-11 items-center text-sm underline" to={backTo}>{t('Вернуться к редакциям договора')}</Link>}
        </div>
        : <p role="alert">{t('Сделка не найдена')}</p>}
    </div>
  </div>
}
