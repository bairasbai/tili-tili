import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, ArrowRight, ChevronRight, RefreshCw } from 'lucide-react'
import { ProgramReader } from '@/components/ProgramReader'
import { TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { ApiError, onSessionExpired } from '@/lib/api/client'
import { acknowledgeVendorProgram, getVendorProgram, getVendorPrograms } from '@/lib/api/vendor'
import { useApi } from '@/lib/api/useApi'
import { offlineGeneration, subscribeOfflineChanges } from '@/lib/offlineAccess'
import { offlinePrograms } from '@/lib/offlineProgram'
import { useProgramOnline, useRegisteredProgramNamespace } from '@/lib/offlineProgramHooks'
import { t } from '@/lib/i18n'

function LiveProgram({ children }: { children: ReactNode }) {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const unsubscribe = onSessionExpired(() => setExpired(true))
    return unsubscribe
  }, [])
  if (expired) return <p role="alert" className="px-5 py-4 text-sm"><Link to="/auth">{t('Сессия истекла — войдите снова')}</Link></p>
  return children
}

export function VendorPrograms() {
  const namespace = useRegisteredProgramNamespace()
  return <div className="pb-28"><TopBar back wrapTitle title={t('Программы свадеб')} /><LiveProgram key={namespace}><ProgramList namespace={namespace} /></LiveProgram></div>
}

function ProgramList({ namespace }: { namespace: string | null }) {
  useSyncExternalStore(subscribeOfflineChanges, offlineGeneration)
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const cursor = cursors[cursors.length - 1]
  const q = useApi(() => navigator.onLine ? getVendorPrograms(cursor) : Promise.reject(new ApiError('network', 0, 'network', 'Нет связи с сервером')), [cursor, namespace])
  const online = useProgramOnline(q.reload)
  if ((!online || q.failure?.isDown) && !(q.failure && !q.failure.isDown)) {
    const copies = offlinePrograms(namespace)
    return <div className="px-5 mt-3">
      <p role="status" className="text-xs leading-relaxed">{t('Офлайн-копия')} · {t('Актуальность и доступ не проверены.')}</p>
      {copies.length === 0 ? <p role="alert" className="text-sm mt-4">{t('Сохранённой программы нет')}</p> : <ul className="divide-y divide-[var(--line)] mt-3">
        {copies.map(copy => <li key={copy.program.weddingId}><Link to={`/vendor-app/programs/${encodeURIComponent(copy.program.weddingId)}`} className="flex items-center gap-3 py-4 min-w-0">
          <div className="min-w-0 flex-1 break-words"><h2 className="text-sm font-semibold">{copy.program.wedding}</h2><p className="text-xs text-[var(--soft)] mt-1">{t('Версия программы:')} {copy.program.sourceVersion} · {copy.savedAt}</p></div><ChevronRight size={18} className="shrink-0" />
        </Link></li>)}
      </ul>}
      <button disabled={!online} onClick={q.reload} aria-label={t('Обновить')} title={t('Обновить')} className="press h-11 w-11 flex items-center justify-center disabled:opacity-40"><RefreshCw size={18} /></button>
    </div>
  }
  return <div className="px-5 mt-3">
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {ready(q) && !q.refreshing && q.data && <>
      {q.data.items.length === 0 && <p className="text-sm text-[var(--soft)]">{t('Программ пока нет')}</p>}
      <ul className="divide-y divide-[var(--line)]">
        {q.data.items.map(program => <li key={program.weddingId}>
          <Link to={`/vendor-app/programs/${encodeURIComponent(program.weddingId)}`} className="flex items-center gap-3 py-4 min-w-0">
            <div className="min-w-0 flex-1 break-words">
              <h2 className="text-sm font-semibold">{program.wedding}</h2>
              <p className="text-xs text-[var(--soft)] mt-1">{t('Версия программы:')} {program.sourceVersion} · {t('Блоков:')} {program.blockCount}</p>
              <p className="text-xs mt-1">{program.requiresAcknowledgment ? t('Требуется ознакомление') : program.acknowledgedAt ? t('Версия подтверждена') : t('Назначенных блоков нет')}</p>
            </div>
            <ChevronRight size={18} className="shrink-0" />
          </Link>
        </li>)}
      </ul>
      <div className="flex justify-between items-center mt-4 gap-3">
        <button aria-label={t('Предыдущая страница')} title={t('Предыдущая страница')} disabled={cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))} className="press h-11 w-11 flex items-center justify-center disabled:opacity-40"><ArrowLeft size={18} /></button>
        <button aria-label={t('Обновить')} title={t('Обновить')} onClick={q.reload} className="press h-11 w-11 flex items-center justify-center"><RefreshCw size={18} /></button>
        <button aria-label={t('Следующая страница')} title={t('Следующая страница')} disabled={!q.data.nextCursor} onClick={() => { if (q.data?.nextCursor) setCursors(v => [...v, q.data!.nextCursor!]) }} className="press h-11 w-11 flex items-center justify-center disabled:opacity-40"><ArrowRight size={18} /></button>
      </div>
    </>}
  </div>
}

export function VendorProgramReader() {
  const { weddingId } = useParams()
  const namespace = useRegisteredProgramNamespace()
  return <div className="pb-28"><TopBar back wrapTitle title={t('Программа свадьбы')} /><LiveProgram key={`${namespace}:${weddingId}`}>{weddingId && <div className="px-5 mt-3"><ProgramReader
    namespace={namespace} weddingId={weddingId} read={() => getVendorProgram(weddingId)} acknowledge={(proof, tag) => acknowledgeVendorProgram(weddingId, proof, tag)}
  /></div>}</LiveProgram></div>
}
