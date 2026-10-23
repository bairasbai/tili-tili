import { useParams } from 'react-router'
import { TopBar } from '@/components/chrome'
import { EventMoveReview } from '@/components/EventMoveReview'
import { t } from '@/lib/i18n'

export default function RootEventMove() {
  const { dealId, proposalId } = useParams()
  return <div className="pb-28"><TopBar back title={t('Перенос мероприятия')} /><div className="px-5">
    {dealId && proposalId && <EventMoveReview dealId={dealId} proposalId={proposalId} />}
  </div></div>
}
