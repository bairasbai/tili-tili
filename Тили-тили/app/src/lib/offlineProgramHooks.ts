import { useEffect, useState, useSyncExternalStore } from 'react'
import { accessTokenForWs } from './api/client'
import { externalProgramNamespace, offlineScope, registeredProgramNamespace, subscribeOfflineChanges } from './offlineAccess'

export function useProgramOnline(reconnect?: () => void): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => { setOnline(true); reconnect?.() }, off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [reconnect])
  return online
}

export function useRegisteredProgramNamespace(): string | null {
  return useSyncExternalStore(subscribeOfflineChanges, () => registeredProgramNamespace(offlineScope(accessTokenForWs())))
}

export function useExternalProgramNamespace(token: string): { namespace: string | null; pending: boolean } {
  const [result, setResult] = useState<{ token: string; namespace: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    void externalProgramNamespace(token).then(namespace => { if (alive) setResult({ token, namespace }) })
    return () => { alive = false }
  }, [token])
  return { namespace: result?.token === token ? result.namespace : null, pending: result?.token !== token }
}
