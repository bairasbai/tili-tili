// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { getGuestEventDaySnapshot, saveGuestToken } from './api/guest'
import { saveTokens } from './api/client'
import { GUEST_DAY_OFFLINE_KEY, GUEST_EVENT_OFFLINE_KEY, forgetGuestDay, guestDayGeneration,
  guestEventNamespace, guestEventReadTicket, recallGuestEvent, rememberGuestDay, selectGuestEvent } from './guestDayOffline'

const TOKEN = 'PRIVATE-EVENT-LINK'
const SELECTED = { eventId: '01990000-0000-7000-8000-00000000000a', guestId: '01990000-0000-7000-8000-00000000000b' }
const OTHER = { ...SELECTED, guestId: '01990000-0000-7000-8000-000000000003' }
const VERSION = '9007199254740993'
const capturedAt = '2027-06-13T06:00:00.123Z'
const body = () => ({ programme: { kind: 'additional', ...SELECTED }, date: null, tz: null, sourceVersion: VERSION, capturedAt,
  timeline: [{ id: 'public', name: 'Public programme', forGuests: true, startsAt: null, endsAt: null, location: null }],
  table: null, bus: null, coordinator: null, dressCode: null, dressNote: null, chat: { open: false, opensAt: null, closesAt: null } })
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', etag: `"${VERSION}"` },
})
beforeEach(() => { localStorage.clear(); saveTokens(null); saveGuestToken(TOKEN); forgetGuestDay(); selectGuestEvent(SELECTED); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('selected public guest programme API', () => {
  it('sends both exact selectors without account auth, returns nullable metadata and caches only matching copy', async () => {
    saveTokens({ accessToken: 'account-secret', refreshToken: 'refresh-secret' })
    const fetch = vi.fn(async () => response(body())); vi.stubGlobal('fetch', fetch)
    expect((await getGuestEventDaySnapshot(TOKEN, SELECTED)).data).toEqual(body())
    const [path, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toContain(`/join/${TOKEN}/day?eventId=${SELECTED.eventId}&guestId=${SELECTED.guestId}`)
    expect(new Headers(options.headers).has('authorization')).toBe(false)
    expect(new Headers(options.headers).has('if-match')).toBe(false)
    expect(new Headers(options.headers).has('idempotency-key')).toBe(false)
    expect(options.method).toBe('GET'); expect(options.body).toBeUndefined()
    const saved = await recallGuestEvent(guestEventReadTicket(TOKEN, SELECTED))
    expect(saved?.sourceVersion).toBe(VERSION); expect(saved?.tz).toBeNull()
    for (const value of [TOKEN, SELECTED.eventId, SELECTED.guestId, 'account-secret']) expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).not.toContain(value)
  })
  it.each(['missing', 'foreign person', 'foreign event', 'MAIN block', 'private block'])('rejects %s response before projection or display', async change => {
    const data = body()
    if (change === 'missing') delete (data as Partial<typeof data>).programme
    if (change === 'foreign person') data.programme.guestId = OTHER.guestId
    if (change === 'foreign event') data.programme.eventId = 'foreign'
    if (change === 'MAIN block') Object.assign(data.timeline[0]!, { eventId: 'main' })
    if (change === 'private block') data.timeline[0]!.forGuests = false
    vi.stubGlobal('fetch', vi.fn(async () => response(data)))
    await expect(getGuestEventDaySnapshot(TOKEN, SELECTED)).rejects.toMatchObject({ status: 502, code: 'guest_programme_mismatch' })
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('does not cache explicit reads when their token is not persisted', async () => {
    saveGuestToken(null); vi.stubGlobal('fetch', vi.fn(async () => response(body())))
    expect((await getGuestEventDaySnapshot(TOKEN, SELECTED)).data).toEqual(body())
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('canonicalises valid upper-case UUID selectors before echo validation and cache projection', async () => {
    const upper = { eventId: SELECTED.eventId.toUpperCase(), guestId: SELECTED.guestId.toUpperCase() }
    expect(upper).not.toEqual(SELECTED)
    const fetch = vi.fn(async () => response(body())); vi.stubGlobal('fetch', fetch)
    expect((await getGuestEventDaySnapshot(TOKEN, upper)).data).toEqual(body())
    expect((fetch.mock.calls as unknown as [string, RequestInit][])[0]![0]).toContain(`eventId=${SELECTED.eventId}&guestId=${SELECTED.guestId}`)
    expect((await recallGuestEvent(guestEventReadTicket(TOKEN, upper)))?.sourceVersion).toBe(VERSION)
  })
  it('selection A→B→A rejects an old HTTP200 and leaves no resurrected copy', async () => {
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const late = getGuestEventDaySnapshot(TOKEN, SELECTED)
    const rejected = expect(late).rejects.toMatchObject({ status: 410, code: 'guest_selection_changed' })
    selectGuestEvent(OTHER); selectGuestEvent(SELECTED); finish(response(body())); await rejected
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it.each([403, 404])('scoped %s clears selected copy and fences pending200 while preserving MAIN', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body())))
    await getGuestEventDaySnapshot(TOKEN, SELECTED)
    await rememberGuestDay(TOKEN, { date: null, tz: 'UTC', sourceVersion: VERSION, capturedAt, timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    const main = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'Unavailable' } }, status)))
    const late = getGuestEventDaySnapshot(TOKEN, SELECTED), rejected = expect(late).rejects.toMatchObject({ status: 410 })
    await expect(getGuestEventDaySnapshot(TOKEN, SELECTED)).rejects.toMatchObject({ status })
    finish(response(body())); await rejected
    expect(await recallGuestEvent(guestEventReadTicket(TOKEN, SELECTED))).toBeNull()
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
  })
  it('global410 clears additional and MAIN copies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body())))
    await getGuestEventDaySnapshot(TOKEN, SELECTED)
    await rememberGuestDay(TOKEN, { date: null, tz: 'UTC', sourceVersion: VERSION, capturedAt, timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'gone', message: 'Revoked' } }, 410)))
    await expect(getGuestEventDaySnapshot(TOKEN, SELECTED)).rejects.toMatchObject({ status: 410 })
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull(); expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
  })
  it('late actual global410 after leaving the selection clears both copies and preserves account auth', async () => {
    saveTokens({ accessToken: 'account-secret', refreshToken: 'refresh-secret' })
    await rememberGuestDay(TOKEN, { date: null, tz: 'UTC', sourceVersion: VERSION, capturedAt, timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    localStorage.setItem(GUEST_EVENT_OFFLINE_KEY, JSON.stringify({ schema: 1, entries: [{ schema: 1,
      namespace: await guestEventNamespace(TOKEN, SELECTED), sourceVersion: VERSION, capturedAt, etag: `"${VERSION}"`, date: null, tz: null, timeline: [],
    }] }))
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).not.toBeNull(); expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).not.toBeNull()
    const auth = localStorage.getItem('tt_auth')
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const late = getGuestEventDaySnapshot(TOKEN, SELECTED), rejected = expect(late).rejects.toMatchObject({ status: 410, code: 'gone' })
    selectGuestEvent(null); finish(response({ error: { code: 'gone', message: 'Revoked' } }, 410)); await rejected
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull(); expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
    expect(localStorage.getItem('tt_auth')).toBe(auth)
  })
})
