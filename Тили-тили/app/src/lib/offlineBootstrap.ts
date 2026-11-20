import { accessTokenForWs } from './api/client'
import { OFFLINE_DAY_KEY, OFFLINE_PROGRAM_KEY, OFFLINE_SEATING_KEY, offlineScope, registeredProgramNamespace, sameOfflineScope } from './offlineAccess'
import { parseDay } from './offlineDay'
import { parseOfflineProgram } from './offlineProgram'
import { parseSeating } from './offlineSeating'
import { GUEST_DAY_OFFLINE_KEY, GUEST_EVENT_OFFLINE_KEY, parseGuestDayCopy, parseGuestEventCopies } from './guestDayOffline'

function programEnvelope(value: unknown, currentNamespace: string | null): object | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('schema' in value) || value.schema !== 1 || !('entries' in value) || !Array.isArray(value.entries)) return null
  const parsed = value.entries.map(parseOfflineProgram)
  if (parsed.some(copy => !copy)) return null
  const copies = parsed.filter(copy => copy !== null).filter(copy => copy.namespace === currentNamespace || copy.namespace.startsWith('external:'))
  const identities = copies.map(copy => JSON.stringify([copy.namespace, copy.program.weddingId]))
  return copies.length && new Set(identities).size === copies.length ? { schema: 1, entries: copies } : null
}

function eventEnvelope(value: unknown): object | null {
  const entries = parseGuestEventCopies(value)
  return entries ? { schema: 1, entries } : null
}

function remove(key: string): void {
  try { localStorage.removeItem(key) } catch { /* Site storage may be blocked. */ }
}

/** Run before mounting readers: retain only existing scoped, minimal copies; never infer access. */
export function sanitizeOfflineBootstrap(): void {
  const scope = offlineScope(accessTokenForWs())
  const namespace = registeredProgramNamespace(scope)
  const copies: readonly [string, (value: unknown) => object | null][] = [
    [OFFLINE_DAY_KEY, value => { const copy = parseDay(value); return copy && sameOfflineScope(copy.scope, scope) ? copy : null }],
    [OFFLINE_PROGRAM_KEY, value => programEnvelope(value, namespace)],
    [OFFLINE_SEATING_KEY, value => { const copy = parseSeating(value); return copy && sameOfflineScope(copy.scope, scope) ? copy : null }],
    [GUEST_DAY_OFFLINE_KEY, parseGuestDayCopy],
    [GUEST_EVENT_OFFLINE_KEY, eventEnvelope],
  ]
  for (const [key, project] of copies) {
    let raw: string | null
    try { raw = localStorage.getItem(key) } catch { remove(key); continue }
    if (raw === null) continue
    try {
      const minimal = project(JSON.parse(raw))
      if (!minimal) { remove(key); continue }
      const canonical = JSON.stringify(minimal)
      if (canonical === raw) continue
      localStorage.setItem(key, canonical)
      if (localStorage.getItem(key) !== canonical) remove(key)
    } catch { remove(key) }
  }
}
