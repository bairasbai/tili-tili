import { Link, useSearchParams } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { ContractAttachments } from '@/components/ContractAttachments'
import { TopBar } from '@/components/chrome'
import { getArchivedContracts } from '@/lib/api/contractAttachments'
import { useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'

export default function ArchivedContracts({ vendor = false }: { vendor?: boolean }) {
  const [params] = useSearchParams()
  const before = params.get('before')
  const scope = JSON.stringify([vendor, before])
  const key = useLegacySessionKey(scope)
  return <ArchiveReader key={key} scope={scope} vendor={vendor} before={before} />
}

function ArchiveReader({ scope, vendor, before }: { scope: string; vendor: boolean; before: string | null }) {
  const capture = useLegacyActionScope(scope)
  const q = useApi(() => getArchivedContracts(vendor ? 'vendor' : 'couple', before,
    { assertCurrent: capture().assertCurrent }), [vendor, before, capture])
  const data = ready(q) ? q.data : null
  const path = vendor ? '/vendor-app/archived-contracts' : '/archived-contracts'
  const locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
  return <div className="pb-28">
    <TopBar back fallback={vendor ? '/vendor-app/deals' : '/settings'} title={t('Архив договоров')} />
    <div className="px-5 space-y-3">
      <AsyncState q={q} />
      {data?.archiveRetentionDays != null && <p className="text-sm text-[var(--soft)]">
        {t('Срок хранения архива — {days} дн.').replace('{days}', new Intl.NumberFormat(locale).format(data.archiveRetentionDays))}
      </p>}
      {data && !data.items.length && <p className="text-sm text-[var(--soft)]">{t('В архиве нет доступных договоров')}</p>}
      {data?.items.map(item => <article key={item.dealId} className="card-s p-4">
        <h2 className="font-semibold break-words">{item.weddingTitle}</h2>
        {item.performerName && <p className="text-sm break-words">{item.performerName}</p>}
        <p className="text-xs text-[var(--soft)]">{t('Дата архивации')} · <time dateTime={item.archivedAt}>
          {new Date(item.archivedAt).toLocaleDateString(locale)}
        </time></p>
        {item.cleanupEligible && <p className="text-xs text-[var(--rose-deep)]">{t('Срок хранения истёк. Архив может быть удалён при ближайшей очистке.')}</p>}
        <ContractAttachments dealId={item.dealId} archivedOnly />
      </article>)}
      {data?.nextCursor && <Link to={`${path}?${new URLSearchParams({ before: data.nextCursor })}`}
        className="press inline-flex min-h-11 items-center text-sm underline">{t('Следующая страница')}</Link>}
      {before && <Link to={path} className="press inline-flex min-h-11 items-center text-sm underline">{t('К началу архива')}</Link>}
    </div>
  </div>
}
