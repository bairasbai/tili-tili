// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, saveTokens } from './api/client'
import { getGuestEventDaySnapshot, getGuestDay, saveGuestToken } from './api/guest'
import { guestEventStorageText } from '../test/guestEventStorage'
import {
  GUEST_DAY_OFFLINE_KEY, GUEST_EVENT_COPY_PREFIX, acceptGuestEventRead, clearGuestEventRefusal, forgetGuestDay, guestDayGeneration,
  type GuestEventCopy, guestEventIsCurrent, guestEventNamespace, guestEventReadTicket, guestEventRefusal, guestEventScopeIsCurrent, guestEventScopeRevision, parseGuestEventCopy,
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
const storageKey = (namespace: string) => GUEST_EVENT_COPY_PREFIX + namespace
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
    refuseGuestEvent(ticket(), new ApiError('http', 404, 'not_found', 'Not found'), await guestEventNamespace(TOKEN, selector))
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
    const raw = guestEventStorageText()!
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
    expect(guestEventStorageText()).toBeNull()
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
    refuseGuestEvent(denied, new ApiError('http', 404, 'not_found', 'Not found'), await guestEventNamespace(TOKEN, selector))
    expect(guestEventIsCurrent(denied)).toBe(false)
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(second)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
  })
  it('preserves the sibling and MAIN when quota prevents writing the refusal stamp', async () => {
    await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    const main = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    expect(main).not.toBeNull()
    const refused = await saved(), allowed = await saved(other)
    const before = guestEventStorageText()
    expect(before).toContain(refused.namespace)
    expect(before).toContain(allowed.namespace)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'not_found', message: 'Denied' } }, 404)))
    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })
    expect(write).not.toHaveBeenCalledWith(storageKey(allowed.namespace), expect.any(String))
    expect(guestEventStorageText()).not.toContain(refused.namespace)
    expect(await recallGuestEvent(ticket(other))).toEqual(allowed)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
  })
  it('keeps other events without a storage rewrite when the refused copy is already absent', async () => {
    const allowed = await saved(other)
    const before = guestEventStorageText()
    expect(before).toContain(allowed.namespace)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'not_found', message: 'Denied' } }, 404)))
    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })
    expect(guestEventRefusal(TOKEN, selector)?.status).toBe(404)
    expect(write).not.toHaveBeenCalledWith(storageKey(allowed.namespace), expect.any(String))
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/:external-event:[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{32}$/))
    expect(guestEventStorageText()).toBe(before)
    expect(await recallGuestEvent(ticket(other))).toEqual(allowed)
  })
  it('a confirmed scoped404 after leaving A still removes only A while B and MAIN remain', async () => {
    await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    const main = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    selectGuestEvent(selector); await saved(); const a = ticket()
    selectGuestEvent(other); const b = await saved(other)
    expect(guestEventIsCurrent(a)).toBe(false)
    expect(guestEventScopeIsCurrent(a)).toBe(true)
    refuseGuestEvent(a, new ApiError('http', 404, 'not_found', 'Not found'), await guestEventNamespace(TOKEN, selector))
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(b)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
    expect(guestEventRefusal(TOKEN, selector)?.status).toBe(404)
  })
  it('a scoped404 from an older token A→B→A generation cannot remove newly saved copies', async () => {
    await saved(); const old = ticket()
    saveGuestToken('OTHER'); saveGuestToken(TOKEN)
    const fresh = await saved(), before = guestEventStorageText()
    expect(guestEventScopeIsCurrent(old)).toBe(false)
    refuseGuestEvent(old, new ApiError('http', 404, 'not_found', 'Not found'), await guestEventNamespace(TOKEN, selector))
    expect(guestEventStorageText()).toBe(before)
    expect(await recallGuestEvent(ticket())).toEqual(fresh)
    expect(guestEventRefusal(TOKEN, selector)).toBeNull()
  })
  it('only a current successful selected read clears its own refusal', async () => {
    const old = ticket()
    refuseGuestEvent(old, new ApiError('http', 404, 'not_found', 'Not found'), await guestEventNamespace(TOKEN, selector))
    acceptGuestEventRead(old)
    expect(guestEventRefusal(TOKEN, selector)?.status).toBe(404)
    const current = ticket()
    acceptGuestEventRead(current)
    expect(guestEventRefusal(TOKEN, selector)).toBeNull()
  })
  it('an explicit retry can replace a refused programme with fresh validated data', async () => {
    const denied = await saved()
    refuseGuestEvent(ticket(), new ApiError('http', 404, 'not_found', 'Not found'), denied.namespace)
    clearGuestEventRefusal(TOKEN, selector)
    expect(await recallGuestEvent(ticket())).toBeNull() // Retry is not permission to restore a known-denied old copy.
    const fresh = { ...data(), sourceVersion: '9007199254740994', timeline: [{ ...data().timeline[0], name: 'Fresh allowed programme' }] }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200,
      headers: { 'content-type': 'application/json', etag: '"9007199254740994"' },
    })))
    await getGuestEventDaySnapshot(TOKEN, selector)
    expect((await recallGuestEvent(ticket()))?.timeline[0]?.name).toBe('Fresh allowed programme')
    expect(guestEventRefusal(TOKEN, selector)).toBeNull()
  })
  it('a successful retry with missing cache metadata never reopens a known-denied earlier offline copy', async () => {
    const denied = await saved()
    refuseGuestEvent(ticket(), new ApiError('http', 404, 'not_found', 'Not found'), denied.namespace)
    clearGuestEventRefusal(TOKEN, selector)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...data(), sourceVersion: undefined }), { status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    await getGuestEventDaySnapshot(TOKEN, selector)
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(guestEventStorageText()).toBeNull()
  })
  it('unavailable WebCrypto and blocked real Storage prototype writes fail closed', async () => {
    vi.stubGlobal('crypto', undefined)
    await rememberGuestEvent(ticket(), data(), `"${VERSION}"`)
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(guestEventStorageText()).toBeNull()
    vi.stubGlobal('crypto', webcrypto)
    const error = new DOMException('blocked', 'SecurityError')
    const blocked = vi.spyOn(Object.getPrototypeOf(localStorage) as Storage, 'setItem').mockImplementation(() => { throw error })
    await expect(rememberGuestEvent(ticket(), data(), `"${VERSION}"`)).resolves.toBeUndefined()
    expect(blocked).toHaveBeenCalledExactlyOnceWith(storageKey((await guestEventNamespace(TOKEN, selector))!), expect.any(String))
    expect(blocked.mock.results).toEqual([{ type: 'throw', value: error }])
    expect(guestEventStorageText()).toBeNull()
  })
  it('a known refusal without available crypto still erases stored private event data', async () => {
    const refused = await saved(), allowed = await saved(other)
    vi.stubGlobal('crypto', undefined)
    refuseGuestEvent(ticket(), new ApiError('http', 403, 'forbidden', 'Denied'), await guestEventNamespace(TOKEN, selector))
    expect(guestEventStorageText()).not.toContain(refused.namespace)
    expect(await recallGuestEvent(ticket(other))).toEqual(allowed)
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
    if (action !== 'selection ABA') expect(guestEventStorageText()).toBeNull()
  })
  it('observed cross-tab entry removal fences a pending older selected read', async () => {
    const copy = await saved(), old = ticket(), unsubscribe = subscribeGuestDayChanges(() => {})
    const key = storageKey(copy.namespace), raw = localStorage.getItem(key)
    localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue: raw, newValue: null }))
    expect(guestEventIsCurrent(old)).toBe(false)
    await rememberGuestEvent(old, data(), `"${VERSION}"`)
    expect(guestEventStorageText()).toBeNull(); unsubscribe()
  })
})

describe('real selected programme wrapper fences', () => {
  it.each([403, 404])('removes only the refused copy from storage before notifying readers about %s', async status => {
    const denied = await saved(), allowed = await saved(other)
    const observed: (string | null)[] = []
    const unsubscribe = subscribeGuestDayChanges(() => {
      if (guestEventRefusal(TOKEN, selector)) observed.push(guestEventStorageText())
    })
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'not_found', message: 'Denied' } }, status)))
    try {
      await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status })
    } finally {
      unsubscribe()
    }
    expect(observed.length).toBeGreaterThan(0)
    for (const raw of observed) {
      expect(raw).not.toContain(denied.namespace)
      expect(raw).toContain(allowed.namespace)
    }
  })

  function storeFromOtherTab(namespace: string, copy: GuestEventCopy | null) {
    const key = storageKey(namespace), oldValue = localStorage.getItem(key)
    const newValue = copy ? JSON.stringify(copy) : null
    if (newValue === null) localStorage.removeItem(key)
    else localStorage.setItem(key, newValue)
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue }))
  }

  async function pendingScoped404() {
    let finish!: (value: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetch)
    const read = getGuestEventDaySnapshot(TOKEN, selector)
    const rejected = expect(read).rejects.toMatchObject({ status: 404 })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    return async () => {
      finish(response({ error: { code: 'not_found', message: 'Denied' } }, 404))
      await rejected
    }
  }

  it('keeps the accepted programme when an older request for the same selection returns 404', async () => {
    const respond = await pendingScoped404()
    const confirmed = { ...data(), timeline: [{ ...data().timeline[0], name: 'Programme accepted by the newer read' }] }
    vi.stubGlobal('fetch', vi.fn(async () => response(confirmed)))
    await getGuestEventDaySnapshot(TOKEN, selector)
    const accepted = await recallGuestEvent(ticket())
    expect(accepted?.timeline[0]?.name).toBe('Programme accepted by the newer read')

    await respond()

    expect(guestEventRefusal(TOKEN, selector)).toBeNull()
    expect(await recallGuestEvent(ticket())).toEqual(accepted)
  })

  it.each([
    { status: 404, hasOtherCopy: false },
    { status: 404, hasOtherCopy: true },
    { status: 410, hasOtherCopy: false },
    { status: 410, hasOtherCopy: true },
  ])('rejects a delayed 200 after another tab gets $status (other copy: $hasOtherCopy)', async ({ status, hasOtherCopy }) => {
    const otherCopy = hasOtherCopy ? await saved(other) : null
    let finish!: (value: Response) => void
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'access_refused', message: 'Denied' } }, status))
    vi.stubGlobal('fetch', fetch)

    const pending = getGuestEventDaySnapshot(TOKEN, selector)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    // Two module instances represent tabs that share storage but have independent in-memory tickets.
    vi.resetModules()
    const otherTab = await import('./api/guest')
    await expect(otherTab.getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status })
    finish(response(data()))

    await expect(pending).rejects.toMatchObject({ status: 410 })
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(status === 404 ? otherCopy : null)
  })

  it('does not interrupt a pending sibling read when a scoped refusal removes the last stored entry', async () => {
    const refused = await saved()
    const deniedKey = storageKey(refused.namespace), previous = localStorage.getItem(deniedKey)
    selectGuestEvent(other)
    let finish!: (value: Response) => void
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'Denied' } }, 404))
    vi.stubGlobal('fetch', fetch)
    const unsubscribe = subscribeGuestDayChanges(() => {})
    try {
      const pending = getGuestEventDaySnapshot(TOKEN, other)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      vi.resetModules()
      const otherTab = await import('./api/guest')
      await expect(otherTab.getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })
      const key = Object.keys(localStorage).find(candidate => candidate.endsWith(refused.namespace))!
      const stamp = localStorage.getItem(key)
      expect(stamp).not.toBeNull()
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: stamp }))
      window.dispatchEvent(new StorageEvent('storage', { key: deniedKey, oldValue: previous, newValue: null }))

      finish(response(data(other)))

      await expect(pending).resolves.toMatchObject({ data: { programme: other } })
      expect(await recallGuestEvent(ticket(other))).not.toBeNull()
    } finally {
      unsubscribe()
    }
  })

  it('publishes a revocation after deleting the denied copy frees space for its stamp', async () => {
    const denied = await saved()
    let finish!: (value: Response) => void
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'Denied' } }, 404))
    vi.stubGlobal('fetch', fetch)
    const pending = getGuestEventDaySnapshot(TOKEN, selector)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.endsWith(denied.namespace) && this.getItem(storageKey(denied.namespace)) !== null) {
        throw new DOMException('Storage is full', 'QuotaExceededError')
      }
      setItem.call(this, key, value)
    })

    vi.resetModules()
    const otherTab = await import('./api/guest')
    await expect(otherTab.getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })
    finish(response(data()))

    await expect(pending).rejects.toMatchObject({ status: 410 })
    expect(await recallGuestEvent(ticket())).toBeNull()
  })

  it.each([true, false])('blocks a late success with no cached scope even when the refusal stamp cannot be written (permit allocated: %s)', async canReserve => {
    const allowed = await saved(other)
    let finish!: (value: Response) => void
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'Denied' } }, 404))
    vi.stubGlobal('fetch', fetch)
    const setItem = Storage.prototype.setItem
    let quotaFull = true
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (quotaFull && (!canReserve || key.startsWith('tt_guest_event_fence:'))) {
        throw new DOMException('Storage is full', 'QuotaExceededError')
      }
      setItem.call(this, key, value)
    })

    const pending = getGuestEventDaySnapshot(TOKEN, selector)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    vi.resetModules()
    const otherTab = await import('./api/guest')
    await expect(otherTab.getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })
    quotaFull = false
    finish(response(data()))

    await expect(pending).rejects.toMatchObject({ status: canReserve ? 410 : 503 })
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(allowed)
    expect(Object.keys(localStorage).some(key => key.startsWith('tt_guest_read:'))).toBe(false)
  })

  it('revokes a reader registered after collecting keys even if allocating the refusal stamp fails', async () => {
    const { reserveGuestRead } = await import('./guestDayOffline')
    const copy = await saved()
    const prefix = storageKey(copy.namespace)
    const old = JSON.parse(localStorage.getItem(prefix)!) as GuestEventCopy
    reserveGuestRead(copy.namespace)?.release()
    let missed: ReturnType<typeof reserveGuestRead> = null
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'tt_guest_event_fence:' + copy.namespace) {
        missed ??= reserveGuestRead(copy.namespace)
        throw new DOMException('Storage is full', 'QuotaExceededError')
      }
      setItem.call(this, key, value)
    })
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'not_found', message: 'Denied' } }, 404)))

    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })

    const reader = missed as ReturnType<typeof reserveGuestRead>
    expect(reader?.current()).toBe(false)
    expect(localStorage.getItem(reader!.key)).not.toBeNull()
    const orphan = prefix + ':' + reader!.key.split(':').at(-1)
    localStorage.setItem(orphan, JSON.stringify({ ...old, readPermit: reader!.key }))
    vi.resetModules()
    const cold = await import('./guestDayOffline')
    expect(await cold.recallGuestEvent(cold.guestEventReadTicket(TOKEN, selector))).toBeNull()
    cold.purgeInvalidGuestSnapshots()
    expect(localStorage.getItem(orphan)).toBeNull()
  })

  it('physically removes a copy written after its permit disappears at the write boundary', async () => {
    const prefix = storageKey((await guestEventNamespace(TOKEN, selector))!) + ':'
    let writtenKey: string | undefined
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
      if (name.startsWith(prefix)) {
        // Another tab completed revocation after the final check while the quota blocked its stamp.
        const permit = (JSON.parse(value) as { readPermit: string }).readPermit
        expect(this.getItem(permit)).not.toBeNull()
        this.removeItem(permit)
        writtenKey = name
      }
      setItem.call(this, name, value)
    })
    vi.stubGlobal('fetch', vi.fn(async () => response(data())))

    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 410 })

    expect(writtenKey).toBeDefined()
    expect(localStorage.getItem(writtenKey!)).toBeNull()
    vi.resetModules()
    const cold = await import('./guestDayOffline')
    expect(await cold.recallGuestEvent(cold.guestEventReadTicket(TOKEN, selector))).toBeNull()
  })

  it('keeps a newly allowed copy of the same scope while removing the invalid writer’s record', async () => {
    const prefix = storageKey((await guestEventNamespace(TOKEN, selector))!) + ':'
    const setItem = Storage.prototype.setItem
    const replacement = 'f'.repeat(32)
    const replacementKey = prefix + replacement
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, raw: string) {
      if (key.startsWith(prefix)) {
        const stale = JSON.parse(raw) as GuestEventCopy & { readPermit: string }
        const expiry = this.getItem(stale.readPermit)!
        const readPermit = stale.readPermit.slice(0, -replacement.length) + replacement
        this.removeItem(stale.readPermit)
        setItem.call(this, readPermit, expiry)
        setItem.call(this, replacementKey, JSON.stringify({
          ...stale, readPermit, timeline: [{ ...stale.timeline[0], name: 'Programme accepted after access was restored' }],
        }))
      }
      setItem.call(this, key, raw)
    })
    vi.stubGlobal('fetch', vi.fn(async () => response(data())))

    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 410 })

    expect(guestEventStorageText()).not.toContain('Permitted programme')
    expect((await recallGuestEvent(ticket()))?.timeline[0]?.name).toBe('Programme accepted after access was restored')
  })

  it('purges an interrupted writer’s record at cold startup and preserves a newer copy of that scope', async () => {
    const { guestEventCopyKeys } = await import('./guestDayOffline')
    vi.stubGlobal('fetch', vi.fn(async () => response(data())))
    await getGuestEventDaySnapshot(TOKEN, selector)
    const storedKey = guestEventCopyKeys()[0]!
    const raw = JSON.parse(localStorage.getItem(storedKey)!) as { readPermit: string }
    localStorage.removeItem(raw.readPermit)
    const fresh = { ...data(), timeline: [{ ...data().timeline[0], name: 'Restored programme' }] }
    vi.stubGlobal('fetch', vi.fn(async () => response(fresh)))
    await getGuestEventDaySnapshot(TOKEN, selector)

    const { sanitizeOfflineBootstrap } = await import('./offlineBootstrap')
    sanitizeOfflineBootstrap()

    expect(localStorage.getItem(storedKey)).toBeNull()
    expect((await recallGuestEvent(ticket()))?.timeline[0]?.name).toBe('Restored programme')
  })

  it('keeps a sibling copy written by another tab while the refused copy is being removed', async () => {
    const denied = await saved(), allowed = await saved(other)
    const deniedKey = storageKey(denied.namespace), allowedKey = storageKey(allowed.namespace)
    const stored = localStorage.getItem(allowedKey)!
    localStorage.removeItem(allowedKey)
    let siblingWritten = false
    const removeItem = Storage.prototype.removeItem
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      if (key === deniedKey) {
        this.setItem(allowedKey, stored)
        siblingWritten = true
      }
      removeItem.call(this, key)
    })
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'not_found', message: 'Denied' } }, 404)))

    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 404 })

    expect(siblingWritten).toBe(true)
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(allowed)
  })

  it.each([404, 410])('ignores earlier stamped copies on a cold read after another tab received %s', async status => {
    const refused = await saved()
    const allowed = await saved(other)
    const previous = [refused, allowed].map(copy => {
      const key = storageKey(copy.namespace)
      return [key, localStorage.getItem(key)!] as const
    })
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'access_refused', message: 'Denied' } }, status)))

    vi.resetModules()
    const otherTab = await import('./api/guest')
    await expect(otherTab.getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status })
    // Even if a concurrent write arrives after removal, it carries the previous access stamp.
    for (const [key, value] of previous) localStorage.setItem(key, value)

    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(await recallGuestEvent(ticket(other))).toEqual(status === 404 ? allowed : null)
    const { sanitizeOfflineBootstrap } = await import('./offlineBootstrap')
    sanitizeOfflineBootstrap()
    const cold = await import('./guestDayOffline')
    expect(await cold.recallGuestEvent(cold.guestEventReadTicket(TOKEN, selector))).toBeNull()
    expect(await cold.recallGuestEvent(cold.guestEventReadTicket(TOKEN, other))).toEqual(status === 404 ? allowed : null)
  })

  it.each([true, false])('removes the refused programme after a different cross-tab removal (WebCrypto available: %s)', async cryptoAvailable => {
    await saved()
    const b = await saved(other)
    if (!cryptoAvailable) vi.stubGlobal('crypto', undefined)
    const unsubscribe = subscribeGuestDayChanges(() => {})
    try {
      const respond = await pendingScoped404()
      storeFromOtherTab(b.namespace, null)
      await respond()
      expect(guestEventStorageText()).toBeNull()
      expect(guestEventRefusal(TOKEN, selector)?.status).toBe(404)
    } finally {
      unsubscribe()
    }
  })

  it('preserves the newly reinstated programme when the other tab removed and restored that same scope', async () => {
    const a = await saved()
    await saved(other)
    const stored = JSON.parse(localStorage.getItem(storageKey(a.namespace))!) as GuestEventCopy
    const newer = '9007199254740994'
    const replacement = { ...a, sourceVersion: newer, etag: `"${newer}"` }
    const unsubscribe = subscribeGuestDayChanges(() => {})
    try {
      const respond = await pendingScoped404()
      storeFromOtherTab(a.namespace, null)
      storeFromOtherTab(a.namespace, { ...stored, ...replacement })
      const before = guestEventStorageText()
      await respond()
      expect(guestEventStorageText()).toBe(before)
      expect(guestEventRefusal(TOKEN, selector)).toBeNull()
      expect(await recallGuestEvent(ticket())).toEqual(replacement)
    } finally {
      unsubscribe()
    }
  })

  it('actual late404 for A after selecting B still deletes A and preserves B without granting stale200 access', async () => {
    selectGuestEvent(selector); await saved()
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const late = getGuestEventDaySnapshot(TOKEN, selector, ticket())
    const denied = expect(late).rejects.toMatchObject({ status: 404 })
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))
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
    expect(guestEventStorageText()).toBeNull()
  })
  it('late selected200 after route A→B→A is rejected before cache and visible data can revive', async () => {
    selectGuestEvent(selector); let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const late = getGuestEventDaySnapshot(TOKEN, selector, ticket())
    const rejected = expect(late).rejects.toMatchObject({ status: 410 })
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))
    selectGuestEvent(other); selectGuestEvent(selector)
    finish(response(data())); await rejected
    expect(guestEventStorageText()).toBeNull()
  })
  it.each([403, 404])('selected%s fences pending same-scope200 and preserves MAIN', async status => {
    await saved(); await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    const main = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'not_found', message: 'Denied' } }, status)))
    const late = getGuestEventDaySnapshot(TOKEN, selector), rejected = expect(late).rejects.toMatchObject({ status: 410 })
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1))
    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status })
    finish(response(data())); await rejected
    expect(await recallGuestEvent(ticket())).toBeNull()
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBe(main)
  })
  it('selected410 clears both MAIN and additional scopes', async () => {
    await saved(); await rememberGuestDay(TOKEN, { ...data(), tz: 'UTC', timeline: [] }, `"${VERSION}"`, guestDayGeneration())
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'gone', message: 'Revoked' } }, 410)))
    await expect(getGuestEventDaySnapshot(TOKEN, selector)).rejects.toMatchObject({ status: 410 })
    expect(guestEventStorageText()).toBeNull()
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
  })
})
