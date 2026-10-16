import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { beginLocalSessionAction, isAuthorized, onSessionChanged, onSessionExpired } from './api/client'
import { safeGet } from './usePersist'

export type LegacyAction = { assertCurrent: () => void; isCurrent: () => boolean }

/** Retire private forms, including an observed cross-tab A→B→A transition. */
export function useLegacySessionKey(scope: string): string {
  const [revision, setRevision] = useState(0)
  useLayoutEffect(() => {
    const monitor = beginLocalSessionAction()
    const invalidate = () => setRevision(value => value + 1)
    const changed = onSessionChanged(invalidate), expired = onSessionExpired(invalidate)
    const storage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== null && event.key !== 'tt_auth')) return
      try { monitor.assertCurrent() } catch { invalidate() }
    }
    window.addEventListener('storage', storage)
    return () => { monitor.close(); changed(); expired(); window.removeEventListener('storage', storage) }
  }, [revision])
  return JSON.stringify([scope, revision])
}

/** Local origin only. Cleanup permanently closes this reader instance. */
export function useLegacyActionScope(scope: string, weddingId?: string | null) {
  const reader = useRef<{ scope: string; action: LegacyAction } | null>(null)
  useLayoutEffect(() => {
    const session = beginLocalSessionAction()
    let closed = false
    const assertCurrent = () => {
      session.assertCurrent()
      if (closed || (weddingId && isAuthorized() && safeGet('tt_wedding_id') !== JSON.stringify(weddingId))) throw new Error('Legacy action scope changed')
    }
    const action: LegacyAction = {
      assertCurrent,
      isCurrent: () => { try { assertCurrent(); return true } catch { return false } },
    }
    const instance = { scope, action }
    reader.current = instance
    return () => { closed = true; session.close(); if (reader.current === instance) reader.current = null }
  }, [scope, weddingId])
  return useCallback(() => {
    const instance = reader.current
    if (!instance || instance.scope !== scope) throw new Error('Legacy action reader closed')
    return instance.action
  }, [scope])
}
