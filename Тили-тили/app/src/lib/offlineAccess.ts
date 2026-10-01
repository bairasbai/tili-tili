import { safeGet } from './usePersist'
import type { ApiError } from './api/client'

export const OFFLINE_DAY_KEY = 'tt_dayx_offline'
export const OFFLINE_PROGRAM_KEY = 'tt_program_offline'
export const OFFLINE_SEATING_KEY = 'tt_seating_offline'
export const AUTH_CHANGED_EVENT = 'tt-auth-changed'
const CACHE_CHANGED_EVENT = 'tt-offline-cleared'
const PROGRAM_REFUSED_EVENT = 'tt-program-refused'
const SEATING_REFUSED_EVENT = 'tt-seating-refused'
let generation = 0

export interface OfflineScope { userId: string; sessionId: string }

/** Untrusted cache namespace only, never identity verification or authorization. */
export function offlineScope(token: string | null): OfflineScope | null {
  try {
    const part = token?.split('.')[1]
    if (!part) return null
    const claims: unknown = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    if (!claims || typeof claims !== 'object' || !('sub' in claims) || !('sid' in claims)) return null
    return typeof claims.sub === 'string' && claims.sub.length > 0 && typeof claims.sid === 'string' && claims.sid.length > 0
      ? { userId: claims.sub, sessionId: claims.sid } : null
  } catch { return null }
}

export const sameOfflineScope = (a: OfflineScope | null, b: OfflineScope | null) =>
  !!a && !!b && a.userId === b.userId && a.sessionId === b.sessionId

export const offlineGeneration = () => generation

export function onOfflineSeatingRefused(weddingId: string, listener: (error: ApiError) => void): () => void {
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<{ weddingId?: string; error: ApiError }>).detail
    if (!detail.weddingId || detail.weddingId === weddingId) listener(detail.error)
  }
  window.addEventListener(SEATING_REFUSED_EVENT, receive)
  return () => window.removeEventListener(SEATING_REFUSED_EVENT, receive)
}

export function forgetOfflineSeating(weddingId?: string, refusal?: ApiError): void {
  if (refusal) window.dispatchEvent(new CustomEvent(SEATING_REFUSED_EVENT, { detail: { weddingId, error: refusal } }))
  try {
    const raw = safeGet(OFFLINE_SEATING_KEY)
    if (weddingId && raw && JSON.parse(raw).weddingId !== weddingId) return
    localStorage.removeItem(OFFLINE_SEATING_KEY)
  } catch { try { localStorage.removeItem(OFFLINE_SEATING_KEY) } catch { /* disabled storage */ } }
  notifyCleanup()
}

function notifyCleanup(): void {
  generation += 1
  window.dispatchEvent(new Event(CACHE_CHANGED_EVENT))
}

export const registeredProgramNamespace = (scope: OfflineScope | null): string | null =>
  scope ? `registered:${JSON.stringify([scope.userId, scope.sessionId])}` : null

/** SHA256 names the cache only; possession/validation of a URL token stays server-side. */
export async function externalProgramNamespace(token: string): Promise<string | null> {
  try {
    if (!token) return null
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return `external:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  } catch { return null }
}

type ProgramFilter = { namespace?: string; weddingId?: string; registeredOnly?: boolean; externalOnly?: boolean }

export function onOfflineProgramRefused(namespace: string | null, weddingId: string | undefined, listener: (error: ApiError) => void): () => void {
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<{ filter?: ProgramFilter; error: ApiError }>).detail
    const f = detail.filter
    if ((!f?.namespace || f.namespace === namespace) && (!f?.weddingId || !weddingId || f.weddingId === weddingId)
      && (!f?.registeredOnly || namespace?.startsWith('registered:') || (!namespace && !!weddingId))
      && (!f?.externalOnly || namespace?.startsWith('external:') || (!namespace && !weddingId))) listener(detail.error)
  }
  window.addEventListener(PROGRAM_REFUSED_EVENT, receive)
  return () => window.removeEventListener(PROGRAM_REFUSED_EVENT, receive)
}

export function forgetOfflinePrograms(filter?: ProgramFilter, refusal?: ApiError): void {
  if (refusal) window.dispatchEvent(new CustomEvent(PROGRAM_REFUSED_EVENT, { detail: { filter, error: refusal } }))
  try {
    const raw = safeGet(OFFLINE_PROGRAM_KEY)
    const value: unknown = raw ? JSON.parse(raw) : null
    if (filter && value && typeof value === 'object' && 'schema' in value && value.schema === 1 && 'entries' in value && Array.isArray(value.entries)) {
      const remaining = value.entries.filter((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || !('namespace' in entry) || typeof entry.namespace !== 'string' || !('program' in entry)
          || !entry.program || typeof entry.program !== 'object' || !('weddingId' in entry.program)) return false
        return (filter.namespace !== undefined && filter.namespace !== entry.namespace)
          || (filter.weddingId !== undefined && filter.weddingId !== entry.program.weddingId)
          || (!!filter.registeredOnly && !entry.namespace.startsWith('registered:'))
          || (!!filter.externalOnly && !entry.namespace.startsWith('external:'))
      })
      if (remaining.length) localStorage.setItem(OFFLINE_PROGRAM_KEY, JSON.stringify({ schema: 1, entries: remaining }))
      else localStorage.removeItem(OFFLINE_PROGRAM_KEY)
    } else localStorage.removeItem(OFFLINE_PROGRAM_KEY)
  } catch {
    try { localStorage.removeItem(OFFLINE_PROGRAM_KEY) } catch { /* disabled storage */ }
  }
  notifyCleanup()
}

export function forgetOfflineDay(weddingId?: string): void {
  if (weddingId) {
    try {
      const raw = safeGet(OFFLINE_DAY_KEY)
      if (raw && JSON.parse(raw).weddingId !== weddingId) return
    } catch { /* malformed private data must also disappear */ }
  }
  try { localStorage.removeItem(OFFLINE_DAY_KEY) } catch { /* site data is disabled */ }
  notifyCleanup()
}

export function subscribeOfflineChanges(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === 'tt_auth' && event.oldValue !== event.newValue) {
      const readScope = (raw: string | null) => {
        try { return offlineScope(raw ? JSON.parse(raw).accessToken ?? null : null) } catch { return null }
      }
      if (!sameOfflineScope(readScope(event.oldValue), readScope(event.newValue))) {
        forgetOfflinePrograms({ registeredOnly: true })
        forgetOfflineSeating()
      }
    }
    if (event.key === null || event.key === OFFLINE_DAY_KEY || event.key === OFFLINE_PROGRAM_KEY || event.key === OFFLINE_SEATING_KEY || event.key === 'tt_auth') {
      generation += 1
      listener()
    }
  }
  window.addEventListener(CACHE_CHANGED_EVENT, listener)
  window.addEventListener(AUTH_CHANGED_EVENT, listener)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(CACHE_CHANGED_EVENT, listener); window.removeEventListener(AUTH_CHANGED_EVENT, listener); window.removeEventListener('storage', storage) }
}
