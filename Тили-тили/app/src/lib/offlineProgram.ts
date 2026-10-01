import type { VendorProgram } from './api/vendor'
import { instant } from './timelineClock'
import { safeGet, safeSet } from './usePersist'
import { OFFLINE_PROGRAM_KEY, offlineGeneration } from './offlineAccess'

export interface OfflineProgram {
  namespace: string
  savedAt: string
  etag: string
  program: Omit<VendorProgram, 'readToken' | 'expiresAt'>
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string'
const nullableText = (v: unknown): v is string | null => v === null || text(v)
const timestamp = (v: unknown) => v === null || (text(v) && instant(v) !== null)
const minutes = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
function namespaceValid(value: string): boolean {
  if (/^external:[a-f0-9]{64}$/.test(value)) return true
  if (!value.startsWith('registered:')) return false
  try {
    const pair: unknown = JSON.parse(value.slice('registered:'.length))
    return Array.isArray(pair) && pair.length === 2 && pair.every(v => text(v) && v.length > 0)
  } catch { return false }
}

/** Project only server-permitted program fields, never proof/link token/chat/finance. */
function project(value: unknown): OfflineProgram | null {
  if (!object(value) || !text(value.namespace) || !namespaceValid(value.namespace) || !text(value.savedAt) || instant(value.savedAt) === null
    || !text(value.etag) || !/^"\d+"$/.test(value.etag) || !object(value.program)) return null
  const p = value.program
  if (!text(p.weddingId) || !p.weddingId || !text(p.wedding) || !text(p.sourceVersion) || value.etag !== `"${p.sourceVersion}"`
    || !timestamp(p.updatedAt) || !timestamp(p.acknowledgedAt) || typeof p.requiresAcknowledgment !== 'boolean' || !Array.isArray(p.blocks)) return null
  if (!p.blocks.every(b => object(b) && text(b.id) && b.id && text(b.name) && nullableText(b.location)
    && timestamp(b.startsAt) && timestamp(b.endsAt) && (b.durationMinutes === null || minutes(b.durationMinutes))
    && typeof b.fixed === 'boolean' && minutes(b.travelMinutes) && minutes(b.bufferMinutes) && typeof b.outdoor === 'boolean'
    && Array.isArray(b.roles) && b.roles.every(r => r === 'responsible' || r === 'participant')
    && Array.isArray(b.dependsOn) && b.dependsOn.every(text)
    && object(b.event) && text(b.event.id) && b.event.id && text(b.event.name)
    && nullableText(b.event.date) && (b.event.date === null || /^\d{4}-\d{2}-\d{2}$/.test(b.event.date))
    && nullableText(b.event.timeZone) && nullableText(b.event.location))) return null
  const blocks = p.blocks as VendorProgram['blocks']
  const ids = new Set(blocks.map(b => b.id))
  if (ids.size !== blocks.length || blocks.some(b => b.dependsOn.some(id => !ids.has(id)))) return null
  return {
    namespace: value.namespace, savedAt: value.savedAt, etag: value.etag,
    program: { weddingId: p.weddingId, wedding: p.wedding, sourceVersion: p.sourceVersion,
      updatedAt: p.updatedAt as string | null, acknowledgedAt: p.acknowledgedAt as string | null, requiresAcknowledgment: p.requiresAcknowledgment,
      blocks: blocks.map(({ id, name, location, startsAt, endsAt, durationMinutes, fixed, travelMinutes, bufferMinutes, outdoor, roles, dependsOn, event }) => ({
        id, name, location, startsAt, endsAt, durationMinutes, fixed, travelMinutes, bufferMinutes, outdoor, roles: [...roles], dependsOn: [...dependsOn],
        event: { id: event.id, name: event.name, date: event.date, timeZone: event.timeZone, location: event.location },
      })),
    },
  }
}

export function offlinePrograms(namespace: string | null): OfflineProgram[] {
  if (!namespace) return []
  try {
    const root: unknown = JSON.parse(safeGet(OFFLINE_PROGRAM_KEY) ?? 'null')
    if (!object(root) || root.schema !== 1 || !Array.isArray(root.entries)) return []
    const entries = root.entries.map(project).filter((e): e is OfflineProgram => !!e && e.namespace === namespace)
    const ids = new Set(entries.map(e => e.program.weddingId))
    return ids.size === entries.length ? entries : []
  } catch { return [] }
}

export function rememberProgram(namespace: string | null, snapshot: { data: VendorProgram; etag: string | null }, generation: number): void {
  if (!namespace || generation !== offlineGeneration()) return
  const minimal = project({ namespace, savedAt: new Date().toISOString(), etag: snapshot.etag, program: snapshot.data })
  if (!minimal) return
  let entries: OfflineProgram[] = []
  try {
    const root: unknown = JSON.parse(safeGet(OFFLINE_PROGRAM_KEY) ?? 'null')
    if (object(root) && root.schema === 1 && Array.isArray(root.entries)) entries = root.entries.map(project).filter((e): e is OfflineProgram => !!e)
  } catch { /* legacy/malformed data is not a namespace */ }
  entries = entries.filter(e => !(e.namespace === namespace && e.program.weddingId === minimal.program.weddingId))
  safeSet(OFFLINE_PROGRAM_KEY, JSON.stringify({ schema: 1, entries: [...entries, minimal] }))
}
