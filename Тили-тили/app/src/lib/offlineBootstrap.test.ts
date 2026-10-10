// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizeOfflineBootstrap } from './offlineBootstrap'
import { OFFLINE_DAY_KEY, OFFLINE_PROGRAM_KEY, OFFLINE_SEATING_KEY, offlineGeneration } from './offlineAccess'
import { GUEST_DAY_OFFLINE_KEY, GUEST_EVENT_OFFLINE_KEY, guestDayGeneration, guestEventIsCurrent, guestEventReadTicket } from './guestDayOffline'

const savedAt = '2027-06-14T10:00:00.123Z'
const version = '9007199254740993'
const scope = { userId: 'person:1', sessionId: 'session:1' }
const namespace = `registered:${JSON.stringify([scope.userId, scope.sessionId])}`
const day = () => ({ schema: 2, scope, role: 'helper', weddingId: 'w1', savedAt, etag: `"${version}"`,
  weddingDate: null, weddingTimeZone: null, timeline: [{ id: 'b1', name: 'Saved day', startsAt: null, endsAt: null, eventId: null, location: null }],
  events: [{ id: 'e1', name: 'Unknown event zone', timeZone: null }], planBActivatedAt: null,
  team: [{ id: 's1', label: 'Permitted contact', phone: '+79990000001' }] })
const program = (ns = namespace, weddingId = 'w1') => ({ namespace: ns, savedAt, etag: `"${version}"`,
  program: { weddingId, wedding: 'Saved wedding', sourceVersion: version, updatedAt: null, acknowledgedAt: null, requiresAcknowledgment: true,
    blocks: [{ id: 'b1', name: 'Saved programme', location: null, startsAt: null, endsAt: null, durationMinutes: null, fixed: false,
      travelMinutes: 1.5, bufferMinutes: 0.25, outdoor: false, roles: ['responsible'], dependsOn: [],
      event: { id: 'e1', name: 'Unknown event zone', date: null, timeZone: null, location: null } }] } })
const seating = () => ({ schema: 1, scope, weddingId: 'w1', role: 'coordinator', savedAt,
  guestsReadAt: '2027-06-14T10:00:00.001Z', tablesReadAt: '2027-06-14T10:00:00.002Z',
  guests: [{ id: 'g1', name: 'Permitted person', status: 'yes', tableId: 't1' }], tables: [{ id: 't1', name: 'Table', capacity: 2 }] })
const guestDay = () => ({ schema: 1, namespace: 'external:' + 'a'.repeat(64), sourceVersion: version, capturedAt: savedAt,
  etag: `"${version}"`, date: null, tz: 'Asia/Yekaterinburg',
  timeline: [{ id: 'b1', name: 'Public programme', startsAt: null, endsAt: null, location: null, forGuests: true }] })
const guestEvent = () => ({ ...guestDay(), namespace: 'external-event:' + 'b'.repeat(64), tz: null })
const fixtures = () => ({
  [OFFLINE_DAY_KEY]: day(), [OFFLINE_PROGRAM_KEY]: { schema: 1, entries: [program(), program('external:' + 'c'.repeat(64))] },
  [OFFLINE_SEATING_KEY]: seating(), [GUEST_DAY_OFFLINE_KEY]: guestDay(), [GUEST_EVENT_OFFLINE_KEY]: { schema: 1, entries: [guestEvent()] },
})
const keys = Object.keys(fixtures())
const seed = (values = fixtures()) => { for (const [key, copy] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(copy)) }
const stored = (key: string) => JSON.parse(localStorage.getItem(key)!) as unknown
const privateMarker = 'UNPERMITTED PRIVATE EXTRA'
// jsdom Storage has named-property traps; patch its actual prototype, also used by MemoryStorage.
const storagePrototype = () => Object.getPrototypeOf(localStorage) as Storage

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.stubGlobal('fetch', vi.fn()); Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('offline privacy cleanup before readers mount', () => {
  it('deletes old unscoped and unknown-schema copies without a route, session or server request', () => {
    for (const key of keys) localStorage.setItem(key, JSON.stringify({ schema: 0, phone: privateMarker }))
    const untouched = { tt_auth: 'private-auth', tt_guest_token: 'private-invitation', tt_lang: 'en', tt_theme: 'dark', foreign_offline: privateMarker }
    for (const [key, raw] of Object.entries(untouched)) localStorage.setItem(key, raw)
    sanitizeOfflineBootstrap()
    for (const key of keys) expect(localStorage.getItem(key)).toBeNull()
    for (const [key, raw] of Object.entries(untouched)) expect(localStorage.getItem(key)).toBe(raw)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(keys)('removes malformed JSON in %s while preserving independent valid copies', key => {
    const valid = fixtures(); seed(valid); localStorage.setItem(key, '{broken private input')
    sanitizeOfflineBootstrap()
    expect(localStorage.getItem(key)).toBeNull()
    for (const other of keys.filter(k => k !== key)) expect(stored(other)).toEqual(valid[other as keyof typeof valid])
  })

  it('preserves literal versions, clocks, null zones, fractional intervals and separate captured seating times', () => {
    const valid = fixtures(); seed(valid); sanitizeOfflineBootstrap()
    for (const [key, copy] of Object.entries(valid)) expect(stored(key)).toEqual(copy)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('removes private extra fields from every known root and nested projection on disk', () => {
    const valid = fixtures()
    const decorated = JSON.parse(JSON.stringify(valid)) as Record<string, Record<string, unknown>>
    const add = (object: Record<string, unknown>) => { object.finance = privateMarker; object.readToken = privateMarker }
    for (const copy of Object.values(decorated)) {
      add(copy)
      const entries = Array.isArray(copy.entries) ? copy.entries as Record<string, unknown>[] : [copy]
      for (const entry of entries) {
        add(entry)
        const content = entry.program && typeof entry.program === 'object' ? entry.program as Record<string, unknown> : entry
        add(content)
        for (const field of ['timeline', 'events', 'team', 'guests', 'tables', 'blocks']) {
          if (Array.isArray(content[field])) for (const item of content[field] as Record<string, unknown>[]) {
            add(item)
            if (item.event && typeof item.event === 'object') add(item.event as Record<string, unknown>)
          }
        }
      }
    }
    for (const [key, copy] of Object.entries(decorated)) localStorage.setItem(key, JSON.stringify(copy))
    sanitizeOfflineBootstrap()
    for (const [key, copy] of Object.entries(valid)) {
      expect(stored(key)).toEqual(copy)
      expect(localStorage.getItem(key)).not.toContain(privateMarker)
    }
  })

  it('rejects an ambiguous programme envelope rather than making one duplicate readable', () => {
    const first = program(), second = program(); second.program.blocks[0]!.name = 'Different captured content'
    localStorage.setItem(OFFLINE_PROGRAM_KEY, JSON.stringify({ schema: 1, entries: [first, second, program('external:' + 'c'.repeat(64))] }))
    sanitizeOfflineBootstrap()
    expect(localStorage.getItem(OFFLINE_PROGRAM_KEY)).toBeNull()
  })

  it('keeps independent programme namespace/wedding pairs without concatenating ambiguous identities', () => {
    const entries = [program(), program(namespace, 'w2'), program('external:' + 'c'.repeat(64))]
    localStorage.setItem(OFFLINE_PROGRAM_KEY, JSON.stringify({ schema: 1, entries }))
    sanitizeOfflineBootstrap()
    expect(stored(OFFLINE_PROGRAM_KEY)).toEqual({ schema: 1, entries })
  })

  it.each(['duplicate', 'invalid'] as const)('retains whole-root guest-event rejection for a %s entry', kind => {
    const copy = guestEvent()
    const second = kind === 'duplicate' ? copy : { ...copy, namespace: 'external-event:' + 'd'.repeat(64), timeline: [{ ...copy.timeline[0], forGuests: false }] }
    localStorage.setItem(GUEST_EVENT_OFFLINE_KEY, JSON.stringify({ schema: 1, entries: [copy, second] }))
    sanitizeOfflineBootstrap()
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })

  it('does not invent missing session, revision, namespace or public-block permissions', () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify({ ...day(), scope: null }))
    localStorage.setItem(OFFLINE_SEATING_KEY, JSON.stringify({ ...seating(), tables: [] }))
    localStorage.setItem(OFFLINE_PROGRAM_KEY, JSON.stringify({ schema: 1, entries: [{ ...program(), namespace: 'legacy-owner' }] }))
    localStorage.setItem(GUEST_DAY_OFFLINE_KEY, JSON.stringify({ ...guestDay(), sourceVersion: 9007199254740992 }))
    const copy = guestEvent()
    localStorage.setItem(GUEST_EVENT_OFFLINE_KEY, JSON.stringify({ schema: 1, entries: [{ ...copy, timeline: [{ ...copy.timeline[0], eventId: 'private-event-id' }] }] }))
    sanitizeOfflineBootstrap()
    for (const key of keys) expect(localStorage.getItem(key)).toBeNull()
  })

  it('is idempotent and leaves existing generation and selection tickets unchanged', () => {
    seed(); localStorage.setItem('tt_guest_token', 'token')
    const selector = { eventId: '0199a110-a000-7000-8000-000000000001', guestId: '0199a110-a000-7000-8000-000000000002' }
    const ticket = guestEventReadTicket('token', selector), generation = offlineGeneration(), guestGeneration = guestDayGeneration()
    const before = keys.map(key => localStorage.getItem(key))
    sanitizeOfflineBootstrap()
    const write = vi.spyOn(storagePrototype(), 'setItem'), remove = vi.spyOn(storagePrototype(), 'removeItem')
    sanitizeOfflineBootstrap()
    expect(keys.map(key => localStorage.getItem(key))).toEqual(before)
    expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    expect(offlineGeneration()).toBe(generation); expect(guestDayGeneration()).toBe(guestGeneration)
    expect(guestEventIsCurrent(ticket)).toBe(true)
  })

  it.each(keys)('removes unsafe %s when canonicalization writes are rejected', key => {
    seed(); const canonical = localStorage.getItem(key)!
    localStorage.setItem(key, JSON.stringify({ ...(stored(key) as object), forbidden: privateMarker }))
    const set = localStorage.setItem.bind(localStorage)
    const error = new DOMException('Quota exceeded', 'QuotaExceededError')
    const write = vi.spyOn(storagePrototype(), 'setItem').mockImplementation((name, raw) => { if (name === key) throw error; set(name, raw) })
    const remove = vi.spyOn(storagePrototype(), 'removeItem')
    expect(() => sanitizeOfflineBootstrap()).not.toThrow()
    expect(write).toHaveBeenCalledExactlyOnceWith(key, canonical)
    expect(write.mock.results).toEqual([{ type: 'throw', value: error }])
    expect(remove).toHaveBeenCalledExactlyOnceWith(key)
    expect(localStorage.getItem(key)).toBeNull()
    for (const other of keys.filter(k => k !== key)) expect(localStorage.getItem(other)).not.toBeNull()
  })

  it.each(keys)('verifies stored canonical bytes and removes %s if storage silently ignores a write', key => {
    seed(); const canonical = localStorage.getItem(key)!
    localStorage.setItem(key, JSON.stringify({ ...(stored(key) as object), forbidden: privateMarker }))
    const unsafe = localStorage.getItem(key)!
    const set = localStorage.setItem.bind(localStorage)
    const write = vi.spyOn(storagePrototype(), 'setItem').mockImplementation((name, raw) => { if (name !== key) set(name, raw) })
    const read = vi.spyOn(storagePrototype(), 'getItem'), remove = vi.spyOn(storagePrototype(), 'removeItem')
    sanitizeOfflineBootstrap()
    expect(write).toHaveBeenCalledExactlyOnceWith(key, canonical)
    expect(write.mock.results).toEqual([{ type: 'return', value: undefined }])
    const readback = read.mock.calls.findIndex(([name], index) => name === key && read.mock.invocationCallOrder[index]! > write.mock.invocationCallOrder[0]!)
    expect(readback).toBeGreaterThanOrEqual(0)
    expect(read.mock.results[readback]).toEqual({ type: 'return', value: unsafe })
    expect(remove).toHaveBeenCalledExactlyOnceWith(key)
    expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(read.mock.invocationCallOrder[readback]!)
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('attempts scoped removal after blocked reads without preventing other copies from being sanitized', () => {
    seed(); localStorage.setItem(OFFLINE_PROGRAM_KEY, '{bad')
    const get = localStorage.getItem.bind(localStorage), remove = vi.spyOn(storagePrototype(), 'removeItem')
    const error = new DOMException('Blocked', 'SecurityError')
    const read = vi.spyOn(storagePrototype(), 'getItem').mockImplementation(key => { if (key === OFFLINE_DAY_KEY) throw error; return get(key) })
    expect(() => sanitizeOfflineBootstrap()).not.toThrow()
    expect(read.mock.calls.filter(([key]) => key === OFFLINE_DAY_KEY)).toEqual([[OFFLINE_DAY_KEY]])
    const deniedRead = read.mock.calls.findIndex(([key]) => key === OFFLINE_DAY_KEY)
    expect(read.mock.results[deniedRead]).toEqual({ type: 'throw', value: error })
    expect(remove).toHaveBeenCalledWith(OFFLINE_DAY_KEY)
    expect(get(OFFLINE_DAY_KEY)).toBeNull(); expect(get(OFFLINE_PROGRAM_KEY)).toBeNull()
    expect(get(GUEST_DAY_OFFLINE_KEY)).not.toBeNull()
  })

  it('does not crash or claim disk removal when both storage mutations are blocked', () => {
    const canonical = JSON.stringify(day())
    const raw = JSON.stringify({ ...day(), forbidden: privateMarker }); localStorage.setItem(OFFLINE_DAY_KEY, raw)
    const error = new DOMException('Blocked', 'SecurityError')
    const write = vi.spyOn(storagePrototype(), 'setItem').mockImplementation(() => { throw error })
    const remove = vi.spyOn(storagePrototype(), 'removeItem').mockImplementation(() => { throw error })
    expect(() => sanitizeOfflineBootstrap()).not.toThrow()
    expect(write).toHaveBeenCalledExactlyOnceWith(OFFLINE_DAY_KEY, canonical)
    expect(write.mock.results).toEqual([{ type: 'throw', value: error }])
    expect(remove).toHaveBeenCalledExactlyOnceWith(OFFLINE_DAY_KEY)
    expect(remove.mock.results).toEqual([{ type: 'throw', value: error }])
    expect(localStorage.getItem(OFFLINE_DAY_KEY)).toBe(raw)
  })

  it('does not crash when access to localStorage itself is blocked', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('Blocked', 'SecurityError') },
      removeItem: () => { throw new DOMException('Blocked', 'SecurityError') } })
    expect(() => sanitizeOfflineBootstrap()).not.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
