import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, accessTokenForWs, consentOutdated } from './api/client'
import { noWedding, useApi } from './api/useApi'
import { getGuests, getMembers } from './api/weddingData'
import { getTables } from './api/weddingWrite'
import { forgetOfflineSeating, offlineGeneration, offlineScope, onOfflineSeatingRefused, sameOfflineScope, subscribeOfflineChanges, type OfflineScope } from './offlineAccess'
import { useProgramOnline, useRegisteredProgramNamespace } from './offlineProgramHooks'
import { parseSeating, recallSeating, rememberSeating } from './offlineSeating'

export async function readSeating(weddingId: string, scope: OfflineScope | null, isCurrent: () => boolean = () => true) {
  const generation = offlineGeneration()
  const [guestRead, tableRead, members] = await Promise.all([
    getGuests(weddingId).then(guests => ({ guests, receivedAt: new Date().toISOString() })),
    getTables(weddingId).then(tables => ({ tables, receivedAt: new Date().toISOString() })),
    scope ? getMembers(weddingId) : Promise.resolve(null),
  ])
  if (!isCurrent() || generation !== offlineGeneration() || (scope && !sameOfflineScope(scope, offlineScope(accessTokenForWs())))) {
    throw new ApiError('http', 409, 'offline_scope_changed', 'Доступ изменился — перечитайте рассадку')
  }
  if (scope && members) {
    const role = members.find(m => m.user?.id === scope.userId)?.role
    if (role !== 'couple' && role !== 'helper' && role !== 'coordinator') {
      const refusal = new ApiError('http', 403, 'seating_role_denied', 'Доступ к рассадке не подтверждён')
      forgetOfflineSeating(weddingId, refusal)
      throw refusal
    }
    const previous = recallSeating(weddingId, scope)
    if (previous && previous.role !== role) forgetOfflineSeating(weddingId)
    const assignmentsAgree = tableRead.tables.every(tb => Array.isArray(tb.guestIds)
      && new Set(tb.guestIds).size === tb.guestIds.length
      && tb.guestIds.length === guestRead.guests.filter(g => g.tableId === tb.id).length
      && tb.guestIds.every(id => guestRead.guests.some(g => g.id === id && g.tableId === tb.id)))
    const copy = assignmentsAgree && parseSeating({ schema: 1, scope, weddingId, role, savedAt: new Date().toISOString(),
      guestsReadAt: guestRead.receivedAt, tablesReadAt: tableRead.receivedAt,
      guests: guestRead.guests.map(g => ({ id: g.id, name: g.name, status: g.status, tableId: g.tableId ?? null })),
      tables: tableRead.tables,
    })
    if (!copy) throw new ApiError('http', 409, 'seating_inconsistent', 'Гости и столы не согласованы — перечитайте рассадку')
    if (navigator.onLine && !consentOutdated()) rememberSeating(copy, generation)
  }
  return { guests: guestRead.guests, tables: tableRead.tables, generation }
}

export type SeatingRead = Awaited<ReturnType<typeof readSeating>>

export function useSeating(weddingId: string | null) {
  const namespace = useRegisteredProgramNamespace()
  const generation = useSyncExternalStore(subscribeOfflineChanges, offlineGeneration)
  const online = useProgramOnline()
  const lifetime = useRef({ active: false, request: 0 })
  useEffect(() => {
    const reader = lifetime.current
    reader.active = true
    return () => { reader.active = false; reader.request++ }
  }, [weddingId, namespace, online])
  const [refusal, setRefusal] = useState<ApiError | null>(null)
  useEffect(() => weddingId ? onOfflineSeatingRefused(weddingId, setRefusal) : undefined, [weddingId])
  const q = useApi(async () => {
    if (!weddingId) return noWedding<SeatingRead>()
    if (!online) throw new ApiError('network', 0, 'offline', 'Сервер недоступен. Попробуйте позже')
    const request = ++lifetime.current.request
    return readSeating(weddingId, offlineScope(accessTokenForWs()), () => lifetime.current.active && request === lifetime.current.request)
  }, [weddingId, namespace, online])
  const failedAccess = !!q.failure && [401, 403, 404, 410].includes(q.failure.status)
  const copy = !refusal && !failedAccess && !consentOutdated() ? recallSeating(weddingId, offlineScope(accessTokenForWs())) : null
  const live = online && !refusal && !consentOutdated() && !q.loading && !q.refreshing
    && !q.error && !q.forbidden && q.data?.generation === generation
  return { q, copy, live, online, refusal }
}
