import { offlineGeneration } from '@/lib/offlineAccess'
import { t } from '@/lib/i18n'
import type { SeatingRead } from '@/lib/useSeating'
import { seatingPdfBody } from '@/lib/seatingPdf'
import { getGuests } from '@/lib/api/weddingData'
import { OwnedPdfButton } from './OwnedPdfButton'

export function SeatingPdfButton({ weddingId, data, disabled }: { weddingId: string; data: SeatingRead | null; disabled: boolean }) {
  return <OwnedPdfButton weddingId={weddingId} snapshot={data} disabled={disabled || !data}
    label={t('PDF для печати А3')} canExport={() => navigator.onLine && data?.generation === offlineGeneration()}
    verifyAccess={() => getGuests(weddingId)}
    createDocument={() => ({ title: t('Рассадка'), body: seatingPdfBody(data!), filename: 'tili-seating.pdf', pageSize: 'A3' })}
    className="press w-full h-[52px] rounded-full bg-[var(--ink)] text-[var(--bg)] font-semibold text-[13.5px] flex items-center justify-center gap-2 disabled:opacity-50" />
}
