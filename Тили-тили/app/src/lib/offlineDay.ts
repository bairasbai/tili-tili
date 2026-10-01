import { safeGet, safeSet } from './usePersist'
import { instant } from './timelineClock'
import { OFFLINE_DAY_KEY, forgetOfflineDay, offlineGeneration, sameOfflineScope, type OfflineScope } from './offlineAccess'
import type { Slot } from './types'

export { OFFLINE_DAY_KEY } from './offlineAccess'

export interface OfflineDay {
  schema: 2
  scope: OfflineScope
  role: 'couple' | 'helper' | 'coordinator'
  weddingId: string
  /** ISO-момент, когда копия снята с ответа сервера. */
  savedAt: string
  etag: string
  weddingDate: string | null
  weddingTimeZone: string | null
  timeline: { id: string; name: string; startsAt: string | null; endsAt: string | null; eventId: string | null; location: string | null }[]
  events: { id: string; name: string; timeZone: string | null }[]
  planBActivatedAt: string | null
  team: Pick<Slot, 'id' | 'label' | 'vendor' | 'vendorId' | 'phone'>[]
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const nullableInstant = (value: unknown) => value === null || (text(value) && instant(value) !== null)

/** Validate persisted data and project explicit fields; tokens/proofs/finance never survive. */
function parseDay(value: unknown): OfflineDay | null {
  if (!object(value) || value.schema !== 2 || !object(value.scope)
    || !text(value.scope.userId) || !value.scope.userId || !text(value.scope.sessionId) || !value.scope.sessionId
    || !['couple', 'helper', 'coordinator'].includes(String(value.role))
    || !text(value.weddingId) || !value.weddingId || !text(value.savedAt) || instant(value.savedAt) === null
    || !text(value.etag) || !/^"\d+"$/.test(value.etag)
    || !nullableText(value.weddingDate) || !nullableText(value.weddingTimeZone)
    || !nullableInstant(value.planBActivatedAt) || !Array.isArray(value.timeline) || !Array.isArray(value.events) || !Array.isArray(value.team)) return null
  if (!value.timeline.every(b => object(b) && text(b.id) && b.id && text(b.name)
    && nullableInstant(b.startsAt) && nullableInstant(b.endsAt) && nullableText(b.eventId) && nullableText(b.location))
    || !value.events.every(e => object(e) && text(e.id) && e.id && text(e.name) && nullableText(e.timeZone))
    || !value.team.every(s => object(s) && text(s.id) && text(s.label)
      && (s.vendor === undefined || text(s.vendor)) && (s.vendorId === undefined || text(s.vendorId))
      && (s.phone === undefined || text(s.phone)))) return null
  const timeline = value.timeline as OfflineDay['timeline']
  const events = value.events as OfflineDay['events']
  if (new Set(timeline.map(b => b.id)).size !== timeline.length || new Set(events.map(e => e.id)).size !== events.length) return null
  return {
    schema: 2, scope: { userId: value.scope.userId, sessionId: value.scope.sessionId },
    role: value.role as OfflineDay['role'], weddingId: value.weddingId, savedAt: value.savedAt, etag: value.etag,
    weddingDate: value.weddingDate, weddingTimeZone: value.weddingTimeZone,
    timeline: timeline.map(({ id, name, startsAt, endsAt, eventId, location }) => ({ id, name, startsAt, endsAt, eventId, location })),
    events: events.map(({ id, name, timeZone }) => ({ id, name, timeZone })),
    planBActivatedAt: value.planBActivatedAt as string | null,
    team: value.team.map(({ id, label, vendor, vendorId, phone }: OfflineDay['team'][number]) => ({ id, label, vendor, vendorId, phone })),
  }
}

export function rememberDay(snapshot: OfflineDay, expectedGeneration: number): void {
  if (expectedGeneration !== offlineGeneration()) return
  const minimal = parseDay(snapshot)
  if (minimal) safeSet(OFFLINE_DAY_KEY, JSON.stringify(minimal))
}

/** Legacy copies have no proven session/revision/context: do not fabricate a migration. */
export function recallDay(weddingId: string | null, scope: OfflineScope | null): OfflineDay | null {
  if (!weddingId || !scope) return null
  try {
    const parsed = parseDay(JSON.parse(safeGet(OFFLINE_DAY_KEY) ?? 'null'))
    return parsed && parsed.weddingId === weddingId && sameOfflineScope(parsed.scope, scope) ? parsed : null
  } catch {
    return null
  }
}

/** An actual membership list can revoke a cached role even while DayX is unmounted. */
export function reconcileOfflineDay(list: readonly { id?: string; role?: string }[], scope: OfflineScope | null): void {
  const raw = safeGet(OFFLINE_DAY_KEY)
  if (!raw) return
  try {
    const copy = parseDay(JSON.parse(raw))
    if (!copy || !sameOfflineScope(copy.scope, scope) || list.find(w => w.id === copy.weddingId)?.role !== copy.role) forgetOfflineDay()
  } catch { forgetOfflineDay() }
}
