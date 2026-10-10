// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, saveTokens } from './api/client'
import { getGuestEventDaySnapshot, getGuestDay, saveGuestToken } from './api/guest'
import {
  GUEST_DAY_OFFLINE_KEY, GUEST_EVENT_OFFLINE_KEY, acceptGuestEventRead, clearGuestEventRefusal, forgetGuestDay, guestDayGeneration,
  guestEventIsCurrent, guestEventNamespace, guestEventReadTicket, guestEventRefusal, guestEventScopeIsCurrent, guestEventScopeRevision, parseGuestEventCopy,
  recallGuestEvent, refuseGuestEvent, rememberGuestDay, rememberGuestEvent, selectGuestEvent, subscribeGuestDayChanges,
} from './guestDayOffline'

const TOKEN = 'PRIVATE-TOKEN'
const selector = { eventId: '1111abcd-1111-4111-8111-111111111111', guestId: '2222abcd-2222-4222-8222-222222222222' }
const other = { eventId: '33333333-3333-4333-8333-333333333333', guestId: '44444444-4444-4444-8444-444444444444' }
const VERSION = '9007199254740993'
const CAPTURED = '2027-06-13T06:00:00.123456Z'
const data = (scope = selector) => ({ programme: { kind: 'additional', ...scope }, date: null, tz: null,
  sourceVersion: VERSION, capturedAt: CAPTURED,
  timeline: [{ id: 'event-block', name: 'Permitted programme', startsAt: '2027-06-16T07:00:00Z', endsAt: null, location: 'Hall', forGuests: true }],
  guestName: 'PRIVATE PERSON', eventName: 'PRIVATE EVENT', guestToken: TOKEN,
  coordinator: { phone: '+79991234567' }, chat: { open: true }, table: { name: 'private' }, bus: { name: 'private' },
})
const ticket = (scope = selector) => guestEventReadTicket(TOKEN, scope)
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json', etag: `"${VERSION}"` },
})
async function saved(scope = selector) {
  const read = ticket(scope)
  await rememberGuestEvent(read, data(scope), `"${VERSION}"`)
  return (await recallGuestEvent(read))!
}
beforeEach(() => { localStorage.clear(); saveTokens(null); saveGuestToken(TOKEN); forgetGuestDay(); selectGuestEvent(null); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); selectGuestEvent(null) })

describe('minimal selected-event copies and exact opaque namespaces', () => {
  it('cache writes keep the read epoch stable, while selector changes and scoped refusals advance it', async () => {
    selectGuestEvent(selector)
    const before = guestEventScopeRevision(TOKEN, selector), current = ticket()
    await saved()
    expect(guestEventScopeRevision(TOKEN, selector)).toBe(before)
    expect(guestEventIsCurrent(current)).toBe(true)
    selectGuestEvent(other)
    const changed = guestEventScopeRevision(TOKEN, selector)
    expect(changed).not.toBe(before)
    await refuseGuestEvent(ticket(), new ApiError('http', 404, 'not_found', 'Not found'))
    expect(guestEventScopeRevision(TOKEN, selector)).not.toBe(changed)
  })
  it('uppercase UUID selectors produce the same canonical ticket and opaque namespace', async () => {
    const upper = { eventId: selector.eventId.toUpperCase(), guestId: selector.guestId.toUpperCase() }
    expect(ticket(upper).selector).toEqual(selector)
    expect(await guestEventNamespace(TOKEN, upper)).toBe(await guestEventNamespace(TOKEN, selector))
    selectGuestEvent(selector)
    const before = guestEventScopeRevision(TOKEN, selector)
    selectGuestEvent(upper)
    expect(guestEventScopeRevision(TOKEN, selector)).toBe(before)
  })
  it('hashes the complete length-delimited scope and stores neither selectors nor private response fields', async () => {
    const copy = await saved()
    expect(copy.namespace).toBe('external-event:' + createHash('sha256').update(JSON.stringify([TOKEN, selector.eventId, selector.guestId])).digest('hex'))
    expect(copy).toEqual({ schema: 1, namespace: await guestEventNamespace(TOKEN, selector), date: null, tz: null,
      sourceVersion: VERSION, capturedAt: CAPTURED, etag: `"${VERSION}"`,
      timeline: [{ id: 'event-block', name: 'Permitted programme', startsAt: '2027-06-16T07:00:00Z', endsAt: null, location: 'Hall', forGuests: true }],
    })
    const raw = localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)!
    for (const privateValue of [TOKEN, selector.eventId, selector.guestId, 'PRIVATE PERSON', 'PRIVATE EVENT', '+79991234567', 'coordinator', 'chat', 'table', 'bus']) expect(raw).not.toContain(privateValue)
    expect(copy).not.toHaveProperty('programme')
    expect(await recallGuestEvent(ticket({ ...selector, guestId: other.guestId }))).toBeNull()
    expect(await recallGuestEvent(ticket({ ...selector, eventId: other.eventId }))).toBeNull()
  })
  it.each([
    ['missing programme', { programme: undefined }], ['MAIN programme', { programme: { kind: 'main', ...selector } }],
    ['wrong event', { programme: { kind: 'additional', ...selector, eventId: other.eventId } }],
    ['wrong person', { programme: { kind: 'additional', ...selector, guestId: other.guestId } }],
    ['wrong block event', { timeline: [{ ...data().timeline[0], eventId: other.eventId }] }],
    ['supplied matching event metadata', { timeline: [{ ...data().timeline[0], eventId: selector.eventId }] }],
    ['supplied null event metadata', { timeline: [{ ...data().timeline[0], eventId: null }] }],
    ['private block', { timeline: [{ ...data().timeline[0], forGuests: false }] }],
    ['numeric version', { sourceVersion: 9007199254740992 }], ['invalid date', { date: '2027-02-30' }],
    ['unknown zone', { tz: 'unknown/zone' }], ['missing zone', { tz: undefined }], ['invalid server clock', { capturedAt: 'yesterday' }],
  ])('does not persist %s or overwrite the earlier valid copy', async (_label, patch) => {
    const previous = await saved()
    await rememberGuestEvent(ticket(), { ...data(), ...patch }, `"${VERSION}"`)
    expect(await recallGuestEvent(ticket())).toEqual(previous)
  })
  it.each([null, 'W/"9007199254740993"', '"2"'])('rejects missing/weak/mismatched header %s', async etag => {
    await rememberGuestEvent(ticket(), data(), etag)
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('reprojects injected copies without restoring arbitrary identities or event selectors', async () => {
    const copy = await saved()
    expect(parseGuestEventCopy({ ...copy, programme: { kind: 'additional', ...selector }, guestToken: TOKEN,
      timeline: [{ ...copy.timeline[0], who: 'secret' }] })).toEqual(copy)
    expect(parseGuestEventCopy({ ...copy, timeline: [{ ...copy.timeline[0], eventId: selector.eventId }] })).toBeNull()
  })
  it('MAIN and two additional person/event copies coexist; scoped404 removes only its matching copy', async () => {
    await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [{ ...data().timeline[0], eventId: null }] }, `"${VERSION}"`, guestDayGeneration())
    const main = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    await saved(); const second = await saved(other)
    const denied = ticket()
    await refuseGuestEvent(denied, new ApiError('http', 404, 'not_found', 'Not found'))
    expect(guestEventIsCurrent(denied)).toBe(false)
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(second)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
  })
  it('a confirmed scoped404 after leaving A still removes only A while B and MAIN remain', async () => {
    await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    const main = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    selectGuestEvent(selector); await saved(); const a = ticket()
    selectGuestEvent(other); const b = await saved(other)
    expect(guestEventIsCurrent(a)).toBe(false)
    expect(guestEventScopeIsCurrent(a)).toBe(true)
    await refuseGuestEvent(a, new ApiError('http', 404, 'not_found', 'Not found'))
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(b)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
    expect(guestEventRefusal(TOKEN, selector)?.status).toBe(404)
  })
  it('a scoped404 from an older token A→B→A generation cannot remove newly saved copies', async () => {
    await saved(); const old = ticket()
    saveGuestToken('OTHER'); saveGuestToken(TOKEN)
    const fresh = await saved(), before = localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)
    expect(guestEventScopeIsCurrent(old)).toBe(false)
    await refuseGuestEvent(old, new ApiError('http', 404, 'not_found', 'Not found'))
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBe(before)
    expect(await recallGuestEvent(ticket())).toEqual(fresh)
    expect(guestEventRefusal(TOKEN, selector)).toBeNull()
  })
  it('only a current successful selected read clears its own refusal', async () => {
    const old = ticket()
    await refuseGuestEvent(old, new ApiError('http', 404, 'not_found', 'Not found'))
    acceptGuestEventRead(old)
    expect(guestEventRefusal(TOKEN, selector)?.status).toBe(404)
    const current = ticket()
    acceptGuestEventRead(current)
    expect(guestEventRefusal(TOKEN, selector)).toBeNull()
  })
  it('a delayed denial hash cannot remove the replacement copy accepted by an actual fresh read', async () => {
    await saved(); const old = ticket()
    let finish!: (value: ArrayBuffer) => void
    const digest = vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { finish = resolve }))
      .mockImplementation((algorithm: string, bytes: Uint8Array) => webcrypto.subtle.digest(algorithm, bytes))
    vi.stubGlobal('crypto', { subtle: { digest } })
    const denial = refuseGuestEvent(old, new ApiError('http', 404, 'not_found', 'Not found'))
    clearGuestEventRefusal(TOKEN, selector)
    expect(await recallGuestEvent(ticket())).toBeNull() // Retry is not permission to restore a known-denied old copy.
    const fresh = { ...data(), sourceVersion: '9007199254740994', timeline: [{ ...data().timeline[0], name: 'Fresh allowed programme' }] }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200,
      headers: { 'content-type': 'application/json', etag: '"9007199254740994"' },
    })))
    await getGuestEventDaySnapshot(TOKEN, selector)
    finish(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([TOKEN, selector.eventId, selector.guestId]))))
    await denial
    expect((await recallGuestEvent(ticket()))?.timeline[0]?.name).toBe('Fresh allowed programme')
    expect(guestEventRefusal(TOKEN, selector)).toBeNull()
  })
  it('a successful retry with missing cache metadata never reopens a known-denied earlier offline copy', async () => {
    await saved(); const old = ticket()
    let finish!: (value: ArrayBuffer) => void
    const digest = vi.fn().mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { finish = resolve }))
      .mockImplementation((algorithm: string, bytes: Uint8Array) => webcrypto.subtle.digest(algorithm, bytes))
    vi.stubGlobal('crypto', { subtle: { digest } })
    const denial = refuseGuestEvent(old, new ApiError('http', 404, 'not_found', 'Not found'))
    clearGuestEventRefusal(TOKEN, selector)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...data(), sourceVersion: undefined }), { status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    await getGuestEventDaySnapshot(TOKEN, selector)
    expect(await recallGuestEvent(ticket())).toBeNull()
    finish(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([TOKEN, selector.eventId, selector.guestId]))))
    await denial
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('unavailable WebCrypto and blocked real Storage prototype writes fail closed', async () => {
    vi.stubGlobal('crypto', undefined)
    await rememberGuestEvent(ticket(), data(), `"${VERSION}"`)
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
    vi.stubGlobal('crypto', webcrypto)
    const error = new DOMException('blocked', 'SecurityError')
    const blocked = vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, 'setItem').mockImplementation(() => { throw error })
    await expect(rememberGuestEvent(ticket(), data(), `"${VERSION}"`)).resolves.toBeUndefined()
    expect(blocked).toHaveBeenCalledExactlyOnceWith(GUEST_EVENT_OFFLINE_KEY, expect.any(String))
    expect(blocked.mock.results).toEqual([{ type: 'throw', value: error }])
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('a known refusal without available crypto still erases stored private event data', async () => {
    await saved(); vi.stubGlobal('crypto', undefined)
    await refuseGuestEvent(ticket(), new ApiError('http', 403, 'forbidden', 'Denied'))
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it.each(['selection ABA', 'token ABA', 'global removal'] as const)('late namespace completion cannot save or recall after %s', async action => {
    await saved(); selectGuestEvent(selector)
    const old = ticket()
    const pending: ((value: ArrayBuffer) => void)[] = []
    vi.stubGlobal('crypto', { subtle: { digest: () => new Promise<ArrayBuffer>(resolve => { pending.push(resolve) }) } })
    const write = rememberGuestEvent(old, data(), `"${VERSION}"`), read = recallGuestEvent(old)
    if (action === 'selection ABA') { selectGuestEvent(other); selectGuestEvent(selector) }
    else if (action === 'token ABA') { saveGuestToken('OTHER'); saveGuestToken(TOKEN) }
    else forgetGuestDay()
    for (const finish of pending) finish(new Uint8Array(32).buffer)
    await write; expect(await read).toBeNull()
    expect(guestEventIsCurrent(old)).toBe(false)
    if (action !== 'selection ABA') expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('observed cross-tab entry removal fences a pending older selected read', async () => {
    await saved(); const old = ticket(), unsubscribe = subscribeGuestDayChanges(() => {})
    const raw = localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)
    localStorage.removeItem(GUEST_EVENT_OFFLINE_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: GUEST_EVENT_OFFLINE_KEY, oldValue: raw, newValue: null }))
    expect(guestEventIsCurrent(old)).toBe(false)
    await rememberGuestEvent(old, data(), `"${VERSION}"`)
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull(); unsubscribe()
  })
})

describe('real selected programme wrapper fences', () => {
  it('actual late404 for A after selecting B still deletes A and preserves B without granting stale200 access', async () => {
    selectGuestEvent(selector); await saved()
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const late = getGuestEventDaySnapshot(TOKEN, selector, ticket())
    const denied = expect(late).rejects.toMatchObject({ status: 404 })
    selectGuestEvent(other); const b = await saved(other)
    finish(response({ error: { code: 'not_found', message: 'Not found' } }, 404)); await denied
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(b)
    expect(guestEventRefusal(TOKEN, selector)?.status).toBe(404)
  })
  it('passes paired selectors without account Authorization and leaves default MAIN body-only reads intact', async () => {
    saveTokens({ accessToken: 'unrelated-account', refreshToken: 'unrelated-refresh' })
    const fetch = vi.fn(async (input: RequestInfo | URL) => response(String(input).includes('?') ? data() : { ...data(), tz: 'UTC', timeline: [] }))
    vi.stubGlobal('fetch', fetch)
    expect((await getGuestEventDaySnapshot(TOKEN, selector)).data.programme).toEqual({ kind: 'additional', ...selector })
    expect((await getGuestDay(TOKEN)).timeline).toEqual([])
    const [path, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toContain('eventId=' + selector.eventId); expect(path).toContain('guestId=' + selector.guestId)
    expect(new Headers(options.headers).has('Authorization')).toBe(false)
  })
  it('explicit server-owned token reads without a stored token do not cache or claim selection authority', async () => {
    saveGuestToken(null); vi.stubGlobal('fetch', vi.fn(async () => response(data())))
    expect((await getGuestEventDaySnapshot(TOKEN, selector)).data.programme).toEqual({ kind: 'additional', ...selector })
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it('late selected200 after route A→B→A is rejected before cache and visible data can revive', async () => {
    selectGuestEvent(selector); let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const late = getGuestEventDaySnapshot(TOKEN, selector, ticket())
    const rejected = expect(late).rejects.toMatchObject({ status: 410 })
    selectGuestEvent(other); selectGuestEvent(selector)
    finish(response(data())); await rejected
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
  })
  it.each([403, 404])('selected%s fences pending same-scope200 and preserves MAIN', async status => {
    await saved(); await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    const main = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'Denied' } }, status)))
    const late = getGuestEventDaySnapshot(TOKEN, selector), rejected = expect(late).rejects.toMatchObject({ status: 410 })
    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status })
    finish(response(data())); await rejected
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
  })
  it('selected410 clears both MAIN and additional scopes', async () => {
    await saved(); await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'gone', message: 'Revoked' } }, 410)))
    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 410 })
    expect(localStorage.getItem(GUEST_EVENT_OFFLINE_KEY)).toBeNull()
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
  })
})
