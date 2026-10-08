import { externalProgramNamespace } from './offlineAccess'
import { instant } from './timelineClock'
import { safeGet, safeSet } from './usePersist'
import type { ApiError } from './api/client'

export const GUEST_DAY_OFFLINE_KEY = 'tt_guest_day_offline'
const TOKEN_KEY = 'tt_guest_token'
const CHANGED = 'tt-guest-day-changed'
let generation = 0
let revision = 0
let refusal: { token: string; error: ApiError } | null = null

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

/** Invalidate before notifying: already-running reads and namespace hashes cannot restore it. */
export function forgetGuestDay(): void {
  generation += 1
  try { localStorage.removeItem(GUEST_DAY_OFFLINE_KEY) } catch { /* disabled storage */ }
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
    }
  }
  window.addEventListener(CHANGED, listener)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', storage) }
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
