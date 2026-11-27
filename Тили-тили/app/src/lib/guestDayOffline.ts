import { externalProgramNamespace } from './offlineAccess'
import { instant } from './timelineClock'
import { safeGet, safeSet } from './usePersist'
import type { ApiError } from './api/client'

export const GUEST_DAY_OFFLINE_KEY = 'tt_guest_day_offline'
/** Legacy envelope retained for browsers updating from the previous app version. */
export const GUEST_EVENT_OFFLINE_KEY = 'tt_guest_event_offline'
export const GUEST_EVENT_COPY_PREFIX = GUEST_EVENT_OFFLINE_KEY + ':'
const LINK_FENCE_KEY = 'tt_guest_link_fence'
const EVENT_FENCE_PREFIX = 'tt_guest_event_fence:'
const EVENT_RESET_FENCE_KEY = EVENT_FENCE_PREFIX + 'all'
const PENDING_READ_PREFIX = 'tt_guest_read:'
const PENDING_EVENT_READ_PREFIX = PENDING_READ_PREFIX + 'event:'
const PENDING_UNSCOPED_READ_PREFIX = PENDING_EVENT_READ_PREFIX + 'unknown:'
const PENDING_READ_TTL_MS = 120_000
const TOKEN_KEY = 'tt_guest_token'
const CHANGED = 'tt-guest-day-changed'
let generation = 0
let observedLinkFence = safeGet(LINK_FENCE_KEY)
let revision = 0
let refusal: { token: string; error: ApiError } | null = null
let selectionEpoch = 0
let eventStoreEpoch = 0
let lastEventStoreReset = 0
const lastEventRemoval = new Map<string, number>()
let selectedEvent: string | null = null
const eventEpochs = new Map<string, number>()
const eventScopesByNamespace = new Map<string, string>()
const eventRefusals = new Map<string, ApiError>()
let nextEventRead = 0
const acceptedEventReads = new Map<string, number>()
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
  JSON.stringify([guestDayGeneration(), selectionEpoch, lastEventStoreReset, token ? eventEpochs.get(eventScope(token, selector)) ?? 0 : 0])

export const guestEventReadTicket = (token: string, selector: GuestEventSelector): GuestEventReadTicket => ({
  token, selector: canonicalSelector(selector), generation: guestDayGeneration(), selectionEpoch, storeEpoch: eventStoreEpoch,
  scopeEpoch: eventEpochs.get(eventScope(token, selector)) ?? 0,
})
const guestEventAccessIsCurrent = (ticket: GuestEventReadTicket) =>
  guestDayIsCurrent(ticket.token, ticket.generation)
  && (eventEpochs.get(eventScope(ticket.token, ticket.selector)) ?? 0) === ticket.scopeEpoch
export const guestEventScopeIsCurrent = (ticket: GuestEventReadTicket) =>
  guestEventAccessIsCurrent(ticket) && ticket.storeEpoch >= lastEventStoreReset
export const guestEventIsCurrent = (ticket: GuestEventReadTicket) =>
  guestEventScopeIsCurrent(ticket) && selectionEpoch === ticket.selectionEpoch
export const guestEventRefusal = (token: string, selector: GuestEventSelector) => eventRefusals.get(eventScope(token, selector)) ?? null
export function clearGuestEventRefusal(token: string, selector: GuestEventSelector): void {
  if (eventRefusals.delete(eventScope(token, selector))) notify()
}
export function acceptGuestEventRead(ticket: GuestEventReadTicket): void {
  if (guestEventIsCurrent(ticket)) clearGuestEventRefusal(ticket.token, ticket.selector)
}

/** A newer accepted read supersedes responses for this exact token, event and person. */
export function trackGuestEventRead(ticket: GuestEventReadTicket) {
  const scope = eventScope(ticket.token, ticket.selector)
  const order = ++nextEventRead
  return {
    hasNewerAcceptance: () => (acceptedEventReads.get(scope) ?? 0) > order,
    markAccepted: () => acceptedEventReads.set(scope, order),
  }
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
interface StoredGuestEventCopy extends GuestEventCopy {
  linkFence?: string
  scopeFence?: string
  readPermit?: string
}
interface StoredGuestDayCopy extends GuestDayCopy { linkFence?: string; readPermit?: string }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const decimal = (value: unknown): value is string => text(value) && /^(0|[1-9][0-9]*)$/.test(value)
const nullableTime = (value: unknown): value is string | null => value === null || (text(value) && instant(value) !== null)
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const tokenValue = (value: string | null) => value || null
const stampPattern = /^[a-f0-9]{32}$/
const scopeFencePattern = /^(?:[a-f0-9]{32})?:(?:[a-f0-9]{32})?$/
const mainPermitPattern = /^tt_guest_read:main:[a-f0-9]{32}$/
const eventPermitPattern = /^tt_guest_read:event:external-event:[a-f0-9]{64}:[a-f0-9]{32}$/
const validMetadata = (value: unknown, format: RegExp) => value == null || (text(value) && format.test(value))
const guestEventCopyKey = (namespace: string) => GUEST_EVENT_COPY_PREFIX + namespace

function guestStorageKeys(prefix: string): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key?.startsWith(prefix) === true)
  } catch { return [] }
}

export const guestEventCopyKeys = () => guestStorageKeys(GUEST_EVENT_COPY_PREFIX)

function notify(): void {
  revision += 1
  window.dispatchEvent(new Event(CHANGED))
}

function invalidateEventStore(): void {
  lastEventStoreReset = ++eventStoreEpoch
  lastEventRemoval.clear()
}

function invalidateEventNamespace(namespace: string): void {
  lastEventRemoval.set(namespace, ++eventStoreEpoch)
  const scope = eventScopesByNamespace.get(namespace)
  if (scope) eventEpochs.set(scope, (eventEpochs.get(scope) ?? 0) + 1)
}

function invalidateGuestDayReaders(): void {
  generation += 1
  eventRefusals.clear()
  eventCacheRefusals.clear()
  eventEpochs.clear()
  eventScopesByNamespace.clear()
  acceptedEventReads.clear()
  invalidateEventStore()
}

function accessStamp(): string {
  // The stamp identifies the invalidation only. It carries no credential or programme data.
  return globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
    Date.now().toString(16).padStart(16, '0') + Math.random().toString(16).slice(2).padEnd(16, '0')
}

function bumpFence(key: string): boolean {
  const stamp = accessStamp()
  safeSet(key, stamp)
  return safeGet(key) === stamp
}

function removeGuestStorageKey(key: string): void {
  try { localStorage.removeItem(key) } catch { /* disabled storage */ }
}

function storedCopyUsesPermit(key: string): boolean {
  const namespace = key.slice(PENDING_EVENT_READ_PREFIX.length, key.lastIndexOf(':'))
  const storageKey = mainPermitPattern.test(key) ? GUEST_DAY_OFFLINE_KEY
    : eventPermitPattern.test(key) ? guestEventCopyKey(namespace) : null
  if (!storageKey) return false
  try {
    const value: unknown = JSON.parse(safeGet(storageKey) ?? 'null')
    return object(value) && value.readPermit === key
  } catch { return false }
}

/**
 * A request owns a unique storage key before it can publish data. Even at quota,
 * a refusal can invalidate a pending read by removing its key.
 */
export function reserveGuestRead(namespace?: string | null) {
  const now = Date.now()
  for (const key of guestStorageKeys(PENDING_READ_PREFIX)) {
    if (Number(safeGet(key)) <= now && !storedCopyUsesPermit(key)) removeGuestStorageKey(key)
  }
  const prefix = namespace === undefined ? PENDING_READ_PREFIX + 'main:'
    : namespace === null ? PENDING_UNSCOPED_READ_PREFIX : PENDING_EVENT_READ_PREFIX + namespace + ':'
  const key = prefix + accessStamp(), expires = now + PENDING_READ_TTL_MS
  const value = String(expires)
  safeSet(key, value)
  if (safeGet(key) !== value) return null
  return {
    key,
    current: () => Date.now() < expires && safeGet(key) === value,
    release: () => { if (!storedCopyUsesPermit(key)) removeGuestStorageKey(key) },
  }
}

function invalidatePendingGuestReads(namespace?: string | null): void {
  const prefix = namespace === undefined ? PENDING_READ_PREFIX
    : namespace === null ? PENDING_EVENT_READ_PREFIX : PENDING_EVENT_READ_PREFIX + namespace + ':'
  for (const key of guestStorageKeys(prefix)) removeGuestStorageKey(key)
  if (namespace) {
    for (const key of guestStorageKeys(PENDING_UNSCOPED_READ_PREFIX)) removeGuestStorageKey(key)
  }
}

function removeGuestCopies(): void {
  removeGuestStorageKey(GUEST_DAY_OFFLINE_KEY)
  removeAdditionalGuestCopies()
}

function removeAdditionalGuestCopies(): void {
  for (const key of [GUEST_EVENT_OFFLINE_KEY, ...guestEventCopyKeys()]) {
    removeGuestStorageKey(key)
  }
}

/** Invalidate before notifying: already-running reads and namespace hashes cannot restore it. */
export function forgetGuestDay(): void {
  const stamped = bumpFence(LINK_FENCE_KEY)
  invalidateGuestDayReaders()
  invalidatePendingGuestReads()
  removeGuestCopies()
  if (!stamped) bumpFence(LINK_FENCE_KEY)
  observedLinkFence = safeGet(LINK_FENCE_KEY)
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

export function guestDayGeneration(): number {
  const fence = safeGet(LINK_FENCE_KEY)
  if (fence !== observedLinkFence) {
    observedLinkFence = fence
    invalidateGuestDayReaders()
  }
  return generation
}
export const guestDayRevision = () => revision
export const guestDayIsCurrent = (token: string, expectedGeneration: number) =>
  guestDayGeneration() === expectedGeneration && tokenValue(safeGet(TOKEN_KEY)) === token

export function subscribeGuestDayChanges(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === null || (event.key === TOKEN_KEY && event.oldValue !== event.newValue)) {
      refusal = null
      invalidateGuestDayReaders()
      removeGuestCopies()
      notify()
    } else if (event.key === LINK_FENCE_KEY) {
      guestDayGeneration()
      notify()
    } else if (event.key?.startsWith(EVENT_FENCE_PREFIX)) {
      if (event.key === EVENT_RESET_FENCE_KEY) invalidateEventStore()
      else invalidateEventNamespace(event.key.slice(EVENT_FENCE_PREFIX.length))
      notify()
    } else if (event.key === GUEST_DAY_OFFLINE_KEY) {
      if (event.newValue === null) generation += 1
      notify()
    } else if (event.key?.startsWith(GUEST_EVENT_COPY_PREFIX)) {
      if (event.newValue === null) invalidateEventNamespace(event.key.slice(GUEST_EVENT_COPY_PREFIX.length))
      notify()
    } else if (event.key === GUEST_EVENT_OFFLINE_KEY) {
      // A removed entry, including an observed A→B→A transition, fences late reads in this tab.
      const before = parseGuestEventEntries(event.oldValue), after = parseGuestEventEntries(event.newValue)
      if (event.newValue === null && !before.length) invalidateEventStore()
      else for (const copy of before) {
        if (!after.some(next => next.namespace === copy.namespace)) invalidateEventNamespace(copy.namespace)
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
  if (!token || !selector.eventId || !selector.guestId) return null
  const scope = eventScope(token, selector)
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scope))
    const namespace = `external-event:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`
    if (tokenValue(safeGet(TOKEN_KEY)) === token) eventScopesByNamespace.set(namespace, scope)
    return namespace
  } catch {
    for (const [namespace, knownScope] of eventScopesByNamespace) {
      if (knownScope === scope) return namespace
    }
    return null
  }
}

export function guestEventStorageFence(namespace: string | null): string | null {
  const reset = safeGet(EVENT_RESET_FENCE_KEY)
  const scoped = namespace ? safeGet(EVENT_FENCE_PREFIX + namespace) : null
  return reset === null && scoped === null ? null : `${reset ?? ''}:${scoped ?? ''}`
}

const matchesLinkFence = (fence?: string) => (fence ?? null) === safeGet(LINK_FENCE_KEY)
const matchesEventFence = (copy: StoredGuestEventCopy) =>
  matchesLinkFence(copy.linkFence) && (copy.scopeFence ?? null) === guestEventStorageFence(copy.namespace)
    && (!copy.readPermit || (copy.readPermit.startsWith(PENDING_EVENT_READ_PREFIX + copy.namespace + ':')
      && safeGet(copy.readPermit) !== null))

/** Additional copies project exactly the same minimal fields, while retaining an honest nullable zone. */
export function parseGuestEventCopy(value: unknown): GuestEventCopy | null {
  if (!object(value) || !text(value.namespace) || !/^external-event:[a-f0-9]{64}$/.test(value.namespace)
    || !(value.tz === null || text(value.tz))) return null
  const projected = parseGuestDayCopy({ ...value, namespace: 'external:' + value.namespace.slice('external-event:'.length), tz: value.tz ?? 'UTC' })
  return projected ? { ...projected, namespace: value.namespace, tz: value.tz } : null
}

function parseStoredGuestEventCopy(value: unknown): StoredGuestEventCopy | null {
  const copy = parseGuestEventCopy(value)
  if (!copy || !object(value) || !validMetadata(value.linkFence, stampPattern)
    || !validMetadata(value.scopeFence, scopeFencePattern) || !validMetadata(value.readPermit, eventPermitPattern)) return null
  return {
    ...copy,
    ...(text(value.linkFence) ? { linkFence: value.linkFence } : {}),
    ...(text(value.scopeFence) ? { scopeFence: value.scopeFence } : {}),
    ...(text(value.readPermit) ? { readPermit: value.readPermit } : {}),
  }
}

/** A malformed or ambiguous entry invalidates the entire legacy envelope. */
function parseGuestEventCopies(value: unknown): StoredGuestEventCopy[] | null {
  if (!object(value) || value.schema !== 1 || !Array.isArray(value.entries)) return null
  const copies = value.entries.map(parseStoredGuestEventCopy)
  if (copies.some(copy => !copy) || new Set(copies.map(copy => copy!.namespace)).size !== copies.length) return null
  return copies as StoredGuestEventCopy[]
}

/** Remove revoked entries when the offline launch sanitizes storage. */
export function sanitizeGuestEventCopies(value: unknown): object | null {
  const entries = parseGuestEventCopies(value)?.filter(matchesEventFence)
  return entries?.length ? { schema: 1, entries } : null
}

function readGuestEventCopy(key: string, value: unknown): StoredGuestEventCopy | null {
  const copy = parseStoredGuestEventCopy(value)
  return copy && guestEventCopyKey(copy.namespace) === key && matchesEventFence(copy) ? copy : null
}

function parseGuestEventEntries(raw: string | null): StoredGuestEventCopy[] {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    return parseGuestEventCopies(value) ?? []
  } catch { return [] }
}

export async function rememberGuestEvent(ticket: GuestEventReadTicket, data: unknown, etag: string | null, currentRead?: () => boolean,
  preparedNamespace?: string | null, readPermit?: string): Promise<void> {
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
  const linkFence = safeGet(LINK_FENCE_KEY)
  const scopeFence = guestEventStorageFence(namespace)
  const serialized = JSON.stringify({
    ...copy,
    ...(linkFence ? { linkFence } : {}),
    ...(scopeFence ? { scopeFence } : {}),
    ...(readPermit ? { readPermit } : {}),
  })
  if (!guestEventIsCurrent(ticket) || currentRead?.() === false) return
  const key = guestEventCopyKey(namespace)
  safeSet(key, serialized)
  if (safeGet(key) === serialized) eventCacheRefusals.delete(eventScope(ticket.token, ticket.selector))
  notify()
}

export async function recallGuestEvent(ticket: GuestEventReadTicket): Promise<GuestEventCopy | null> {
  const scope = eventScope(ticket.token, ticket.selector)
  if (!guestEventIsCurrent(ticket) || guestEventRefusal(ticket.token, ticket.selector) || eventCacheRefusals.has(scope)) return null
  const namespace = await guestEventNamespace(ticket.token, ticket.selector)
  if (!namespace || !guestEventIsCurrent(ticket) || guestEventRefusal(ticket.token, ticket.selector) || eventCacheRefusals.has(scope)) return null
  const key = guestEventCopyKey(namespace), raw = safeGet(key)
  if (raw !== null) {
    try { return parseGuestEventCopy(readGuestEventCopy(key, JSON.parse(raw))) } catch { return null }
  }
  const legacy = parseGuestEventEntries(safeGet(GUEST_EVENT_OFFLINE_KEY)).find(copy => copy.namespace === namespace)
  return legacy && matchesEventFence(legacy) ? parseGuestEventCopy(legacy) : null
}

function removeRefusedEventCopy(namespace: string | null): void {
  if (namespace) {
    removeGuestStorageKey(guestEventCopyKey(namespace))
    const legacy = safeGet(GUEST_EVENT_OFFLINE_KEY)
    if (legacy === null) return
    const copies = parseGuestEventEntries(legacy)
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
  } else {
    invalidateEventStore()
    removeAdditionalGuestCopies()
    return
  }
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
  const key = namespace ? EVENT_FENCE_PREFIX + namespace : EVENT_RESET_FENCE_KEY
  const stamped = bumpFence(key)
  invalidatePendingGuestReads(namespace)
  removeRefusedEventCopy(namespace)
  if (!stamped) bumpFence(key)
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

export function parseStoredGuestDayCopy(value: unknown): StoredGuestDayCopy | null {
  const copy = parseGuestDayCopy(value)
  if (!copy || !object(value) || !validMetadata(value.linkFence, stampPattern)
    || !validMetadata(value.readPermit, mainPermitPattern)) return null
  const fence = text(value.linkFence) ? value.linkFence : undefined
  const readPermit = text(value.readPermit) ? value.readPermit : undefined
  if (!matchesLinkFence(fence) || (readPermit && safeGet(readPermit) === null)) return null
  return { ...copy, ...(fence ? { linkFence: fence } : {}), ...(readPermit ? { readPermit } : {}) }
}

export async function rememberGuestDay(token: string, data: unknown, etag: string | null, expectedGeneration: number,
  currentRead?: () => boolean, readPermit?: string): Promise<void> {
  if (!guestDayIsCurrent(token, expectedGeneration) || currentRead?.() === false) return
  const namespace = await externalProgramNamespace(token)
  if (!namespace || !guestDayIsCurrent(token, expectedGeneration) || !object(data) || !Array.isArray(data.timeline)) return
  const copy = parseGuestDayCopy({
    ...data, schema: 1, namespace, etag,
    timeline: data.timeline.map(block => object(block) ? {
      ...block, startsAt: block.startsAt ?? null, endsAt: block.endsAt ?? null, location: block.location ?? null,
    } : block),
  })
  if (!copy || !guestDayIsCurrent(token, expectedGeneration)) return
  const linkFence = safeGet(LINK_FENCE_KEY)
  const raw = JSON.stringify({ ...copy, ...(linkFence ? { linkFence } : {}), ...(readPermit ? { readPermit } : {}) })
  if (guestDayIsCurrent(token, expectedGeneration) && currentRead?.() !== false) safeSet(GUEST_DAY_OFFLINE_KEY, raw)
  notify()
}

export async function recallGuestDay(token: string, expectedGeneration: number): Promise<GuestDayCopy | null> {
  const namespace = await externalProgramNamespace(token)
  if (!namespace || !guestDayIsCurrent(token, expectedGeneration)) return null
  try {
    const raw: unknown = JSON.parse(safeGet(GUEST_DAY_OFFLINE_KEY) ?? 'null')
    const copy = parseStoredGuestDayCopy(raw)
    return copy?.namespace === namespace && guestDayIsCurrent(token, expectedGeneration) ? parseGuestDayCopy(copy) : null
  } catch { return null }
}
