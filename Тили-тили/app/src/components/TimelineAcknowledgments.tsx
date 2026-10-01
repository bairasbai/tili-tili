import { useEffect, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { AsyncState, ready } from './AsyncState'
import { getTimelineAcknowledgments } from '@/lib/api/weddingData'
import { onSessionExpired } from '@/lib/api/client'
import { useApi } from '@/lib/api/useApi'
import { instant } from '@/lib/timelineClock'
import { key, t } from '@/lib/i18n'

interface Props { weddingId: string; timelineVersion: string; refreshTimeline: () => void }
const labels = {
  pending: key('Ожидается подтверждение этой версии'),
  acknowledged: key('Эта версия подтверждена'),
  unassigned: key('Назначенных блоков нет'),
  unavailable: key('Подрядчик не может открыть программу'),
  not_supported: key('Внешнее ознакомление недоступно'),
} as const

export function TimelineAcknowledgments(props: Props) {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    const unsubscribe = onSessionExpired(() => setExpired(true))
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); unsubscribe() }
  }, [])
  return <section aria-label={t('Ознакомление исполнителей')} className="border-t border-[var(--line)] pt-4 mt-4 break-words">
    <h2 className="text-sm font-semibold">{t('Ознакомление исполнителей')}</h2>
    {expired ? <p role="alert" className="text-xs mt-2">{t('Сессия истекла — войдите снова')}</p>
      : !online ? <p role="alert" className="text-xs mt-2">{t('Нет связи с сервером')}</p>
      : <AcknowledgmentsRead key={`${props.weddingId}:${props.timelineVersion}`} {...props} />}
  </section>
}

function AcknowledgmentsRead({ weddingId, timelineVersion, refreshTimeline }: Props) {
  const q = useApi(() => getTimelineAcknowledgments(weddingId), [weddingId])
  const refresh = () => { refreshTimeline(); q.reload() }
  const data = q.data?.data
  const valid = data && typeof data.sourceVersion === 'string' && Array.isArray(data.items)
    && data.items.every(item => (item.kind === 'registered' || item.kind === 'external') && Object.hasOwn(labels, item.status)
      && (item.kind !== 'external' || (item.acknowledgedBy === null && (!item.previousAcknowledgment || item.previousAcknowledgment.acknowledgedBy === null)))
      && (item.status !== 'acknowledged' || (item.blockCount > 0 && instant(item.acknowledgedAt) !== null)))
  const coherent = valid && q.data?.etag === timelineVersion && timelineVersion === `"${data.sourceVersion}"`
  return <>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {ready(q) && !q.refreshing && (coherent ? <>
      <p className="text-xs text-[var(--soft)] mt-2">{t('Версия сводки:')} {data.sourceVersion}</p>
      {data.items.length === 0 && <p className="text-xs mt-2">{t('Действующих исполнителей нет')}</p>}
      <ul className="divide-y divide-[var(--line)] mt-2">
        {data.items.map(item => <li key={`${item.kind}:${item.id}`} className="py-3">
          <h3 className="text-sm font-semibold">{item.name || t('Неизвестно')}</h3>
          <p className="text-xs text-[var(--soft)] mt-1">{t('Блоков:')} {item.blockCount}</p>
          <p className="text-xs mt-1 flex items-start gap-1.5">{item.status === 'acknowledged' && <Check size={14} className="shrink-0" />}<span>{t(item.kind === 'external' && item.status === 'unavailable' ? 'Нет действующей ссылки для программы' : labels[item.status])}</span></p>
          {item.kind === 'external' && (item.status === 'pending' || item.status === 'acknowledged') && <p className="text-xs text-[var(--soft)] mt-1">{t('По последней выданной ссылке')}</p>}
          {item.status === 'acknowledged' && <div className="text-xs mt-1">
            <p>{item.kind === 'external' ? t('Подтверждено по ссылке исполнителя') : <>{t('Подтвердил:')} {item.acknowledgedBy || t('Неизвестно')}</>}</p>
            <time dateTime={item.acknowledgedAt ?? undefined}>{item.acknowledgedAt}</time>
          </div>}
          {item.previousAcknowledgment && <details className="text-xs text-[var(--soft)] mt-2">
            <summary className="cursor-pointer">{t('Предыдущее подтверждение')}</summary>
            <p className="mt-1">{t('Версия программы:')} {item.previousAcknowledgment.sourceVersion}</p>
            <p>{item.kind === 'external' ? t('Подтверждено по ссылке исполнителя') : <>{t('Подтвердил:')} {item.previousAcknowledgment.acknowledgedBy || t('Неизвестно')}</>}</p>
            <time dateTime={item.previousAcknowledgment.acknowledgedAt}>{item.previousAcknowledgment.acknowledgedAt}</time>
          </details>}
        </li>)}
      </ul>
    </> : <p role="alert" className="text-xs mt-2 text-[var(--rose-ink)]">{t(valid ? 'Версия сводки отличается от программы' : 'Сводка ознакомления неполная')}</p>)}
    {!q.forbidden && !q.loading && !q.error && <button title={t('Обновить программу и сводку')} aria-label={t('Обновить программу и сводку')} disabled={q.refreshing} onClick={refresh} className="press h-11 w-11 flex items-center justify-center mt-2 disabled:opacity-40"><RefreshCw size={17} /></button>}
  </>
}
