import { safeGet, safeSet } from './usePersist'
import { instant } from './timelineClock'
import { OFFLINE_SEATING_KEY, forgetOfflineSeating, offlineGeneration, sameOfflineScope, type OfflineScope } from './offlineAccess'

export interface OfflineSeating {
  schema: 1
  scope: OfflineScope
  weddingId: string
  role: 'couple' | 'helper' | 'coordinator'
  savedAt: string
  guestsReadAt: string
  tablesReadAt: string
  guests: { id: string; name: string; status: 'yes' | 'no' | 'pending'; tableId: string | null }[]
  tables: { id: string; name: string; capacity: number }[]
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string'
const time = (v: unknown): v is string => text(v) && instant(v) !== null

/** Explicit projection: a cached seating plan is neither an atomic revision nor current authorization. */
export function parseSeating(v: unknown): OfflineSeating | null {
  if (!object(v) || v.schema !== 1 || !object(v.scope) || !text(v.scope.userId) || !v.scope.userId
    || !text(v.scope.sessionId) || !v.scope.sessionId || !text(v.weddingId) || !v.weddingId
    || !['couple', 'helper', 'coordinator'].includes(String(v.role)) || !time(v.savedAt)
    || !time(v.guestsReadAt) || !time(v.tablesReadAt) || !Array.isArray(v.guests) || !Array.isArray(v.tables)) return null
  if (!v.guests.every(g => object(g) && text(g.id) && g.id && text(g.name)
    && ['yes', 'no', 'pending'].includes(String(g.status)) && (g.tableId === null || (text(g.tableId) && !!g.tableId)))
    || !v.tables.every(tb => object(tb) && text(tb.id) && tb.id && text(tb.name)
      && typeof tb.capacity === 'number' && Number.isInteger(tb.capacity) && tb.capacity > 0)) return null
  const guests = v.guests as OfflineSeating['guests'], tables = v.tables as OfflineSeating['tables']
  const tableIds = new Set(tables.map(tb => tb.id))
  if (new Set(guests.map(g => g.id)).size !== guests.length || tableIds.size !== tables.length
    || guests.some(g => g.tableId !== null && !tableIds.has(g.tableId))) return null
  return {
    schema: 1, scope: { userId: v.scope.userId, sessionId: v.scope.sessionId }, weddingId: v.weddingId,
    role: v.role as OfflineSeating['role'], savedAt: v.savedAt, guestsReadAt: v.guestsReadAt, tablesReadAt: v.tablesReadAt,
    guests: guests.map(({ id, name, status, tableId }) => ({ id, name, status, tableId })),
    tables: tables.map(({ id, name, capacity }) => ({ id, name, capacity })),
  }
}

export function rememberSeating(copy: OfflineSeating, expectedGeneration: number): void {
  if (expectedGeneration !== offlineGeneration()) return
  const minimal = parseSeating(copy)
  if (minimal) safeSet(OFFLINE_SEATING_KEY, JSON.stringify(minimal))
}

export function recallSeating(weddingId: string | null, scope: OfflineScope | null): OfflineSeating | null {
  if (!weddingId || !scope) return null
  try {
    const copy = parseSeating(JSON.parse(safeGet(OFFLINE_SEATING_KEY) ?? 'null'))
    return copy && copy.weddingId === weddingId && sameOfflineScope(copy.scope, scope) ? copy : null
  } catch { return null }
}

/** A successful current membership list can revoke an old copy while Seating is unmounted. */
export function reconcileOfflineSeating(list: readonly { id?: string; role?: string }[], scope: OfflineScope | null): void {
  const raw = safeGet(OFFLINE_SEATING_KEY)
  if (!raw) return
  try {
    const copy = parseSeating(JSON.parse(raw))
    if (!copy || !sameOfflineScope(copy.scope, scope) || list.find(w => w.id === copy.weddingId)?.role !== copy.role) forgetOfflineSeating()
  } catch { forgetOfflineSeating() }
}
