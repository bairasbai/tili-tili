import { externalProgramNamespace } from './offlineAccess'
import { instant } from './timelineClock'
import { safeGet, safeSet } from './usePersist'
import type { ApiError } from './api/client'

export const GUEST_DAY_OFFLINE_KEY = 'tt_guest_day_offline'
export const GUEST_EVENT_OFFLINE_KEY = 'tt_guest_event_offline'
const TOKEN_KEY = 'tt_guest_token'
const CHANGED = 'tt-guest-day-changed'
let generation = 0
let revision = 0
let refusal: { token: string; error: ApiError } | null = null
let selectionEpoch = 0
let eventStoreEpoch = 0
let lastEventStoreReset = 0
const lastEventRemoval = new Map<string, number>()
let selectedEvent: string | null = null
const eventEpochs = new Map<string, number>()
const eventRefusals = new Map<string, ApiError>()
// Explicit retry may clear the visible error, but a denied old copy stays blocked until a new validated copy replaces it.
const eventCacheRefusals = new Set<string>()

export interface GuestEventSelector { eventId: string; guestId: string }
export interface GuestEventReadTicket {
  token: string
  generation: number
  selectionEpoch: number
  scopeEpoch: number
  storeEpoch: number
  selector: GuestEventSelector
}
const canonicalSelector = (selector: GuestEventSelector): GuestEventSelector => ({ eventId: selector.eventId.toLowerCase(), guestId: selector.guestId.toLowerCase() })
const eventScope = (token: string, selector: GuestEventSelector) => JSON.stringify([token, selector.eventId.toLowerCase(), selector.guestId.toLowerCase()])
const selectorValue = (selector: GuestEventSelector | null) => selector ? JSON.stringify([selector.eventId.toLowerCase(), selector.guestId.toLowerCase()]) : null

/** The URL is an untrusted selector. Changing it invalidates already-running selected reads. */
export function selectGuestEvent(selector: GuestEventSelector | null): void {
  const next = selectorValue(selector)
  if (next !== selectedEvent) { selectedEvent = next; selectionEpoch += 1; notify() }
}

/** Stable across ordinary cache writes; only changes that invalidate a selected read create a new ticket. */
export const guestEventScopeRevision = (token: string | null, selector: GuestEventSelector) =>
  JSON.stringify([generation, selectionEpoch, eventStoreEpoch, token ? eventEpochs.get(eventScope(token, selector)) ?? 0 : 0])

export const guestEventReadTicket = (token: string, selector: GuestEventSelector): GuestEventReadTicket => ({
  token, selector: canonicalSelector(selector), generation, selectionEpoch, storeEpoch: eventStoreEpoch,
  scopeEpoch: eventEpochs.get(eventScope(token, selector)) ?? 0,
})
const guestEventAccessIsCurrent = (ticket: GuestEventReadTicket) =>
  guestDayIsCurrent(ticket.token, ticket.generation)
  && (eventEpochs.get(eventScope(ticket.token, ticket.selector)) ?? 0) === ticket.scopeEpoch
export const guestEventScopeIsCurrent = (ticket: GuestEventReadTicket) =>
  guestEventAccessIsCurrent(ticket) && eventStoreEpoch === ticket.storeEpoch
export const guestEventIsCurrent = (ticket: GuestEventReadTicket) =>
  guestEventScopeIsCurrent(ticket) && selectionEpoch === ticket.selectionEpoch
export const guestEventRefusal = (token: string, selector: GuestEventSelector) => eventRefusals.get(eventScope(token, selector)) ?? null
export function clearGuestEventRefusal(token: string, selector: GuestEventSelector): void {
  if (eventRefusals.delete(eventScope(token, selector))) notify()
}
export function acceptGuestEventRead(ticket: GuestEventReadTicket): void {
  if (guestEventIsCurrent(ticket)) clearGuestEventRefusal(ticket.token, ticket.selector)
}

export interface GuestDayCopy {
  schema: 1
  /** An untrusted WebCrypto namespace, never guest identity or access proof. */
  namespace: string
  sourceVersion: string
  capturedAt: string
  etag: string
  date: string | null
  tz: string
  timeline: { id: string; name: string; startsAt: string | null; endsAt: string | null; location: string | null; forGuests: true }[]
}

export interface GuestEventCopy extends Omit<GuestDayCopy, 'tz'> { tz: string | null }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const decimal = (value: unknown): value is string => text(value) && /^(0|[1-9][0-9]*)$/.test(value)
const nullableTime = (value: unknown): value is string | null => value === null || (text(value) && instant(value) !== null)
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const tokenValue = (value: string | null) => value || null

function notify(): void {
  revision += 1
  window.dispatchEvent(new Event(CHANGED))
}

function invalidateEventStore(): void {
  lastEventStoreReset = ++eventStoreEpoch
  lastEventRemoval.clear()
}

/** Invalidate before notifying: already-running reads and namespace hashes cannot restore it. */
export function forgetGuestDay(): void {
  generation += 1
  eventRefusals.clear()
  eventCacheRefusals.clear()
  eventEpochs.clear()
  invalidateEventStore()
  try { localStorage.removeItem(GUEST_DAY_OFFLINE_KEY) } catch { /* disabled storage */ }
  try { localStorage.removeItem(GUEST_EVENT_OFFLINE_KEY) } catch { /* disabled storage */ }
  notify()
}

export function guestDayTokenChanged(previous: string | null, next: string | null): void {
  if (tokenValue(previous) !== tokenValue(next)) { refusal = null; forgetGuestDay() }
}

export function refuseGuestDay(token: string, error: ApiError): void {
  refusal = { token, error }
  forgetGuestDay()
}

export const guestDayRefusal = (token: string | null): ApiError | null => refusal?.token === token ? refusal.error : null

/** Only an explicit retry or a later actual successful day read reopens a refused reader. */
export function clearGuestDayRefusal(token: string): void {
  if (refusal?.token === token) { refusal = null; notify() }
}

export function acceptGuestDayRead(token: string, expectedGeneration: number): void {
  if (guestDayIsCurrent(token, expectedGeneration)) clearGuestDayRefusal(token)
}

export const guestDayGeneration = () => generation
export const guestDayRevision = () => revision
export const guestDayIsCurrent = (token: string, expectedGeneration: number) =>
  generation === expectedGeneration && tokenValue(safeGet(TOKEN_KEY)) === token

export function subscribeGuestDayChanges(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === null || (event.key === TOKEN_KEY && event.oldValue !== event.newValue)) { refusal = null; forgetGuestDay() }
    else if (event.key === GUEST_DAY_OFFLINE_KEY) {
      if (event.newValue === null) { refusal = null; generation += 1 }
      notify()
    } else if (event.key === GUEST_EVENT_OFFLINE_KEY) {
      // A removed entry, including an observed A→B→A transition, fences late reads in this tab.
      const before = parseGuestEventEntries(event.oldValue), after = parseGuestEventEntries(event.newValue)
      if (event.newValue === null) invalidateEventStore()
      else {
        const removed = before.filter(copy => !after.some(next => next.namespace === copy.namespace))
        if (removed.length) {
          eventStoreEpoch += 1
          for (const copy of removed) lastEventRemoval.set(copy.namespace, eventStoreEpoch)
        }
      }
      notify()
    }
  }
  window.addEventListener(CHANGED, listener)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', storage) }
}

/** Length-delimited token/event/person scope; this digest is never proof of current access. */
export async function guestEventNamespace(token: string, selector: GuestEventSelector): Promise<string | null> {
  try {
    if (!token || !selector.eventId || !selector.guestId) return null
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(eventScope(token, selector)))
    return `external-event:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
  } catch { return null }
}

/** Additional copies project exactly the same minimal fields, while retaining an honest nullable zone. */
export function parseGuestEventCopy(value: unknown): GuestEventCopy | null {
  if (!object(value) || !text(value.namespace) || !/^external-event:[a-f0-9]{64}$/.test(value.namespace)
    || !(value.tz === null || text(value.tz))) return null
  const projected = parseGuestDayCopy({ ...value, namespace: 'external:' + value.namespace.slice('external-event:'.length), tz: value.tz ?? 'UTC' })
  return projected ? { ...projected, namespace: value.namespace, tz: value.tz } : null
}

/** A malformed or ambiguous entry invalidates the entire additional-copy envelope. */
export function parseGuestEventCopies(value: unknown): GuestEventCopy[] | null {
  if (!object(value) || value.schema !== 1 || !Array.isArray(value.entries)) return null
  const copies = value.entries.map(parseGuestEventCopy)
  if (copies.some(copy => !copy) || new Set(copies.map(copy => copy!.namespace)).size !== copies.length) return null
  return copies as GuestEventCopy[]
}

function parseGuestEventEntries(raw: string | null): GuestEventCopy[] {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    return parseGuestEventCopies(value) ?? []
  } catch { return [] }
}

export async function rememberGuestEvent(ticket: GuestEventReadTicket, data: unknown, etag: string | null, currentRead?: () => boolean,
  preparedNamespace?: string | null): Promise<void> {
  if (!guestEventIsCurrent(ticket) || !object(data) || !object(data.programme)
    || data.programme.kind !== 'additional' || data.programme.eventId !== ticket.selector.eventId
    || data.programme.guestId !== ticket.selector.guestId || !Array.isArray(data.timeline)
    || data.timeline.some(block => !object(block) || Object.prototype.hasOwnProperty.call(block, 'eventId') || block.forGuests !== true)) return
  const namespace = preparedNamespace === undefined ? await guestEventNamespace(ticket.token, ticket.selector) : preparedNamespace
  if (!namespace || !guestEventIsCurrent(ticket)) return
  const copy = parseGuestEventCopy({ ...data, schema: 1, namespace, etag,
    timeline: data.timeline.map(block => object(block) ? {
      id: block.id, name: block.name, startsAt: block.startsAt ?? null, endsAt: block.endsAt ?? null,
      location: block.location ?? null, forGuests: block.forGuests,
    } : block),
  })
  if (!copy || !guestEventIsCurrent(ticket) || currentRead?.() === false) return
  const entries = parseGuestEventEntries(safeGet(GUEST_EVENT_OFFLINE_KEY)).filter(entry => entry.namespace !== namespace)
  const serialized = JSON.stringify({ schema: 1, entries: [...entries, copy] })
  safeSet(GUEST_EVENT_OFFLINE_KEY, serialized)
  if (safeGet(GUEST_EVENT_OFFLINE_KEY) === serialized) eventCacheRefusals.delete(eventScope(ticket.token, ticket.selector))
  notify()
}

export async function recallGuestEvent(ticket: GuestEventReadTicket): Promise<GuestEventCopy | null> {
  const scope = eventScope(ticket.token, ticket.selector)
  if (!guestEventIsCurrent(ticket) || guestEventRefusal(ticket.token, ticket.selector) || eventCacheRefusals.has(scope)) return null
  const namespace = await guestEventNamespace(ticket.token, ticket.selector)
  if (!namespace || !guestEventIsCurrent(ticket) || guestEventRefusal(ticket.token, ticket.selector) || eventCacheRefusals.has(scope)) return null
  return parseGuestEventEntries(safeGet(GUEST_EVENT_OFFLINE_KEY)).find(copy => copy.namespace === namespace) ?? null
}

function removeRefusedEventCopy(namespace: string | null): void {
  if (namespace) {
    const copies = parseGuestEventEntries(safeGet(GUEST_EVENT_OFFLINE_KEY))
    const entries = copies.filter(copy => copy.namespace !== namespace)
    if (entries.length && entries.length === copies.length) return
    if (entries.length) {
      try {
        localStorage.setItem(GUEST_EVENT_OFFLINE_KEY, JSON.stringify({ schema: 1, entries }))
        return
      } catch {
        // If a rewrite fails, drop the envelope so a cold tab cannot reopen the refused copy.
        invalidateEventStore()
      }
    }
  } else invalidateEventStore()
  try { localStorage.removeItem(GUEST_EVENT_OFFLINE_KEY) } catch { /* disabled storage */ }
}

export function refuseGuestEvent(ticket: GuestEventReadTicket, error: ApiError, namespace: string | null): void {
  // Removing an unrelated entry in another tab invalidates live reads, but not the server's refusal for this scope.
  const lastRemoval = namespace ? lastEventRemoval.get(namespace) ?? 0 : 0
  if (!guestEventAccessIsCurrent(ticket) || ticket.storeEpoch < Math.max(lastEventStoreReset, lastRemoval)) return
  const scope = eventScope(ticket.token, ticket.selector)
  eventRefusals.set(scope, error)
  eventEpochs.set(scope, ticket.scopeEpoch + 1)
  eventCacheRefusals.add(scope)
  removeRefusedEventCopy(namespace)
  notify()
}

/** Copy only explicit MAIN fields; private contacts, chat, RSVP and extra events never persist. */
export function parseGuestDayCopy(value: unknown): GuestDayCopy | null {
  if (!object(value) || value.schema !== 1 || !text(value.namespace) || !/^external:[a-f0-9]{64}$/.test(value.namespace)
    || !decimal(value.sourceVersion) || !text(value.etag) || value.etag !== `"${value.sourceVersion}"`
    || !text(value.capturedAt) || instant(value.capturedAt) === null
    || !(value.date === null || (text(value.date) && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
      && Number.isFinite(Date.parse(value.date + 'T00:00:00Z'))
      && new Date(value.date + 'T00:00:00Z').toISOString().slice(0, 10) === value.date))
    || !text(value.tz) || !value.tz || !Array.isArray(value.timeline)) return null
  try { new Intl.DateTimeFormat('en', { timeZone: value.tz }) } catch { return null }
  const timeline: GuestDayCopy['timeline'] = []
  for (const block of value.timeline) {
    if (!object(block) || !text(block.id) || !block.id || !text(block.name) || block.forGuests !== true
      || (block.eventId !== undefined && block.eventId !== null)
      || !nullableTime(block.startsAt) || !nullableTime(block.endsAt) || !nullableText(block.location)) return null
    timeline.push({ id: block.id, name: block.name, startsAt: block.startsAt, endsAt: block.endsAt, location: block.location, forGuests: true })
  }
  if (new Set(timeline.map(block => block.id)).size !== timeline.length) return null
  return {
    schema: 1, namespace: value.namespace, sourceVersion: value.sourceVersion, capturedAt: value.capturedAt,
    etag: value.etag, date: value.date, tz: value.tz, timeline,
  }
}

export async function rememberGuestDay(token: string, data: unknown, etag: string | null, expectedGeneration: number): Promise<void> {
  if (!guestDayIsCurrent(token, expectedGeneration)) return
  const namespace = await externalProgramNamespace(token)
  if (!namespace || !guestDayIsCurrent(token, expectedGeneration) || !object(data) || !Array.isArray(data.timeline)) return
  const copy = parseGuestDayCopy({
    ...data, schema: 1, namespace, etag,
    timeline: data.timeline.map(block => object(block) ? {
      ...block, startsAt: block.startsAt ?? null, endsAt: block.endsAt ?? null, location: block.location ?? null,
    } : block),
  })
  if (!copy || !guestDayIsCurrent(token, expectedGeneration)) return
  safeSet(GUEST_DAY_OFFLINE_KEY, JSON.stringify(copy))
  notify()
}

export async function recallGuestDay(token: string, expectedGeneration: number): Promise<GuestDayCopy | null> {
  const namespace = await externalProgramNamespace(token)
  if (!namespace || !guestDayIsCurrent(token, expectedGeneration)) return null
  try {
    const copy = parseGuestDayCopy(JSON.parse(safeGet(GUEST_DAY_OFFLINE_KEY) ?? 'null'))
    return copy?.namespace === namespace && guestDayIsCurrent(token, expectedGeneration) ? copy : null
  } catch { return null }
}
