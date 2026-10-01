import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { ApiError } from '@/lib/api/client'
import type { VendorProgram, VendorProgramAck } from '@/lib/api/vendor'
import { useApi, explainError } from '@/lib/api/useApi'
import { forgetOfflinePrograms, offlineGeneration, onOfflineProgramRefused, subscribeOfflineChanges } from '@/lib/offlineAccess'
import { offlinePrograms, rememberProgram, type OfflineProgram } from '@/lib/offlineProgram'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { t } from '@/lib/i18n'
import { AsyncState, ready } from './AsyncState'
import { ProgramSnapshot } from './ProgramSnapshot'

function recalled(namespace: string | null, weddingId?: string): OfflineProgram | null {
  const entries = offlinePrograms(namespace)
  return weddingId ? entries.find(e => e.program.weddingId === weddingId) ?? null : entries.length === 1 ? entries[0]! : null
}

function SavedProgram({ copy, reload, reloadDisabled }: { copy: OfflineProgram; reload: () => void; reloadDisabled: boolean }) {
  return <ProgramSnapshot key={`offline:${copy.etag}:${copy.savedAt}`} program={{ ...copy.program, readToken: null, expiresAt: null }}
    etag={copy.etag} offlineSavedAt={copy.savedAt} reload={reload} reloadDisabled={reloadDisabled}
    acknowledge={() => Promise.reject(new Error('Offline acknowledgment is forbidden'))} />
}

export function OfflineProgramView({ namespace, weddingId, reload, reloadDisabled = true }: {
  namespace: string | null; weddingId?: string; reload: () => void; reloadDisabled?: boolean
}) {
  useSyncExternalStore(subscribeOfflineChanges, offlineGeneration)
  const copy = recalled(namespace, weddingId)
  return copy ? <SavedProgram copy={copy} reload={reload} reloadDisabled={reloadDisabled} /> : <>
    <p role="alert" className="text-sm">{t('Сохранённой программы нет')}</p>
    <button disabled={reloadDisabled} onClick={reload} className="press flex items-center gap-2 min-h-11 text-sm disabled:opacity-40"><RefreshCw size={16} />{t('Открыть заново')}</button>
  </>
}

export function ProgramReader({ namespace, weddingId, read, acknowledge, onRefused, onOfflineChange }: {
  namespace: string | null
  weddingId?: string
  read: () => Promise<{ data: VendorProgram; etag: string | null }>
  acknowledge: (proof: string, etag: string) => Promise<VendorProgramAck>
  onRefused?: (error: ApiError) => void
  onOfflineChange?: (offline: boolean) => void
}) {
  const generation = useSyncExternalStore(subscribeOfflineChanges, offlineGeneration)
  const q = useApi(async () => {
    const generation = offlineGeneration()
    if (!navigator.onLine) throw new ApiError('network', 0, 'network', 'Нет связи с сервером')
    return { snapshot: await read(), generation }
  }, [namespace, weddingId])
  const online = useProgramOnline(q.reload)
  const [refusal, setRefusal] = useState<ApiError | null>(null)
  const refused = useCallback((error: ApiError) => {
    if (namespace) forgetOfflinePrograms({ namespace, weddingId })
    setRefusal(error); onRefused?.(error)
  }, [namespace, weddingId, onRefused])
  useEffect(() => onOfflineProgramRefused(namespace, weddingId, refused), [namespace, weddingId, refused])
  const knownFailure = q.failure && [401, 403, 404, 410].includes(q.failure.status) ? q.failure : null
  const refusalError = refusal ?? knownFailure
  useEffect(() => {
    if (knownFailure) {
      if (namespace) forgetOfflinePrograms({ namespace, weddingId })
      onRefused?.(knownFailure)
    }
  }, [knownFailure, namespace, weddingId, onRefused])
  const settled = ready(q) && !q.refreshing && !!q.data && q.data.generation === generation
  const snapshot = settled ? q.data!.snapshot : null
  const mismatch = !!snapshot && !!weddingId && snapshot.data.weddingId !== weddingId
  const unavailable = !online || !!q.failure?.isDown || (!settled && !!recalled(namespace, weddingId))
  const fallbackAllowed = !refusalError && !mismatch && !(q.failure && !q.failure.isDown)
  useEffect(() => { onOfflineChange?.(unavailable) }, [unavailable, onOfflineChange])
  useEffect(() => {
    if (online && settled && !mismatch && !refusalError && snapshot) rememberProgram(namespace, snapshot, generation)
  }, [online, settled, mismatch, refusalError, snapshot, namespace, generation])
  const reopen = () => { setRefusal(null); q.reload() }
  if (refusalError) return <><p role="alert" className="text-sm">{explainError(refusalError)}</p><button onClick={reopen} className="press flex items-center gap-2 min-h-11 text-sm"><RefreshCw size={16} />{t('Открыть заново')}</button></>
  if (unavailable && fallbackAllowed) {
    const copy = recalled(namespace, weddingId)
    return copy ? <SavedProgram copy={copy} reload={reopen} reloadDisabled={!online} /> : <>
      <p role="alert" className="text-sm">{t('Нет связи с сервером')} · {t('Сохранённой программы нет')}</p>
      <button onClick={reopen} disabled={!online} className="press flex items-center gap-2 min-h-11 text-sm disabled:opacity-40"><RefreshCw size={16} />{t('Открыть заново')}</button>
    </>
  }
  if (mismatch) return <p role="alert" className="text-sm">{t('Данные программы не совпадают с запросом')}</p>
  return <>
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {!q.loading && !q.error && !q.forbidden && !snapshot && <><p role="alert" className="text-sm">{t('Доступ и данные требуют нового чтения')}</p><button onClick={reopen} className="press flex items-center gap-2 min-h-11 text-sm"><RefreshCw size={16} />{t('Открыть заново')}</button></>}
    {snapshot && <ProgramSnapshot key={`${snapshot.data.readToken}:${snapshot.data.acknowledgedAt}`} program={snapshot.data} etag={snapshot.etag}
      reload={reopen} acknowledge={acknowledge} onRefused={refused} />}
  </>
}
