// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { getGuestDay, getGuestDaySnapshot, getRsvp, redeemInvite, saveGuestToken } from './api/guest'
import { saveTokens } from './api/client'
import { externalProgramNamespace } from './offlineAccess'
import { GUEST_DAY_OFFLINE_KEY, forgetGuestDay, guestDayGeneration, parseGuestDayCopy, recallGuestDay, rememberGuestDay, subscribeGuestDayChanges } from './guestDayOffline'

const TOKEN = 'PRIVATE-GUEST-TOKEN'
const SOURCE = '9007199254740993'
const CAPTURED = '2027-06-13T06:00:00.123456Z'
const data = () => ({ date: '2027-06-14', tz: 'Asia/Yekaterinburg', sourceVersion: SOURCE, capturedAt: CAPTURED,
  timeline: [{ id: 'main-1', name: 'MAIN', startsAt: '2027-06-14T08:00:00Z', endsAt: '2027-06-14T09:00:00Z', location: 'Hall', forGuests: true }],
  coordinator: { phone: '+79991234567' }, chat: { open: true }, table: { name: 'private' }, events: [{ id: 'extra' }],
})
const response = (body: unknown, status = 200, etag: string | null = `"${SOURCE}"`) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
})
async function copy() {
  await rememberGuestDay(TOKEN, data(), `"${SOURCE}"`, guestDayGeneration())
  return JSON.parse(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)!) as Record<string, unknown>
}
beforeEach(() => { localStorage.clear(); saveTokens(null); saveGuestToken(TOKEN); forgetGuestDay(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('minimal guest MAIN snapshot', () => {
  it('projects only explicit fields and retains exact BIGINT/time/header text without token or private payload', async () => {
    const saved = await copy()
    expect(saved).toEqual({ schema: 1, namespace: await externalProgramNamespace(TOKEN), sourceVersion: SOURCE, capturedAt: CAPTURED,
      etag: `"${SOURCE}"`, date: '2027-06-14', tz: 'Asia/Yekaterinburg', timeline: data().timeline })
    expect(JSON.stringify(saved)).not.toContain(TOKEN)
    expect(JSON.stringify(saved)).not.toContain('+79991234567')
    expect(await recallGuestDay(TOKEN, guestDayGeneration())).toEqual(saved)
    expect(await recallGuestDay('OTHER', guestDayGeneration())).toBeNull()
  })
  it.each([
    ['numeric version', { sourceVersion: 9007199254740992 }], ['nondecimal version', { sourceVersion: '1e2' }],
    ['zero-padded version', { sourceVersion: '01', etag: '"01"' }], ['weak header', { etag: `W/"${SOURCE}"` }],
    ['missing header', { etag: null }], ['mismatched header', { etag: '"2"' }], ['client/invalid time', { capturedAt: 'yesterday' }],
    ['invalid date', { date: '2027-02-30' }], ['invalid zone', { tz: 'unknown/zone' }],
    ['raw namespace', { namespace: TOKEN }], ['unknown schema', { schema: 2 }],
    ['private block', { timeline: [{ ...data().timeline[0], forGuests: false }] }],
    ['additional event', { timeline: [{ ...data().timeline[0], eventId: 'extra' }] }],
    ['duplicate block', { timeline: [data().timeline[0], data().timeline[0]] }],
    ['invalid time', { timeline: [{ ...data().timeline[0], startsAt: 'tomorrow' }] }],
  ])('rejects %s in stored copies', async (_label, change) => {
    expect(parseGuestDayCopy({ ...await copy(), ...change })).toBeNull()
  })
  it('reprojects an injected stored object instead of restoring contacts, chat or arbitrary fields', async () => {
    const saved = await copy()
    const parsed = parseGuestDayCopy({ ...saved, guestToken: TOKEN, coordinator: { phone: 'secret' }, chat: { open: true },
      timeline: [{ ...data().timeline[0], who: 'secret', proof: 'private' }] })
    expect(parsed).toEqual(saved)
  })
  it('missing metadata/header never fabricates a cache from body data', async () => {
    await rememberGuestDay(TOKEN, { ...data(), capturedAt: undefined }, null, guestDayGeneration())
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
  })
  it('crypto missing and blocked storage stay fail closed without a raw-token fallback', async () => {
    vi.stubGlobal('crypto', undefined)
    await rememberGuestDay(TOKEN, data(), `"${SOURCE}"`, guestDayGeneration())
    expect(await recallGuestDay(TOKEN, guestDayGeneration())).toBeNull()
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
    vi.stubGlobal('crypto', webcrypto)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    await expect(rememberGuestDay(TOKEN, data(), `"${SOURCE}"`, guestDayGeneration())).resolves.toBeUndefined()
    expect(await recallGuestDay(TOKEN, guestDayGeneration())).toBeNull()
  })
  it('A→B→A invalidates persisted copy and all earlier read/hash generations', async () => {
    await copy(); const generation = guestDayGeneration()
    saveGuestToken('B'); saveGuestToken(TOKEN)
    expect(guestDayGeneration()).toBeGreaterThan(generation)
    await rememberGuestDay(TOKEN, data(), `"${SOURCE}"`, generation)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
    expect(await recallGuestDay(TOKEN, generation)).toBeNull()
  })
  it.each(['denial', 'A→B→A'] as const)('late namespace completion after %s cannot write or recall', async action => {
    await copy(); const generation = guestDayGeneration()
    let finish!: (value: ArrayBuffer) => void
    vi.stubGlobal('crypto', { subtle: { digest: () => new Promise<ArrayBuffer>(resolve => { finish = resolve }) } })
    const write = rememberGuestDay(TOKEN, data(), `"${SOURCE}"`, generation)
    if (action === 'denial') forgetGuestDay(); else { saveGuestToken('B'); saveGuestToken(TOKEN) }
    finish(new Uint8Array(32).buffer); await write
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
    const readGeneration = guestDayGeneration()
    const read = recallGuestDay(TOKEN, readGeneration)
    forgetGuestDay(); finish(new Uint8Array(32).buffer)
    expect(await read).toBeNull()
  })
  it('observed cross-tab A→B→A transitions erase even if current storage is already A', async () => {
    await copy(); const generation = guestDayGeneration(), unsubscribe = subscribeGuestDayChanges(() => {})
    window.dispatchEvent(new StorageEvent('storage', { key: 'tt_guest_token', oldValue: TOKEN, newValue: 'B' }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'tt_guest_token', oldValue: 'B', newValue: TOKEN }))
    expect(guestDayGeneration()).toBeGreaterThan(generation)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull(); unsubscribe()
  })
})

describe('public guest snapshot wrappers', () => {
  it('uses real response ETag and preserves body-only compatibility for anonymous and registered reads', async () => {
    const fetch = vi.fn(async () => response(data())); vi.stubGlobal('fetch', fetch)
    expect((await getGuestDaySnapshot(TOKEN)).etag).toBe(`"${SOURCE}"`)
    saveTokens({ accessToken: 'unrelated-account', refreshToken: 'unrelated-refresh' })
    expect(await getGuestDay(TOKEN)).toEqual(data())
    for (const [, options] of fetch.mock.calls as unknown as [unknown, RequestInit][]) expect(new Headers(options.headers).has('authorization')).toBe(false)
    expect(await recallGuestDay(TOKEN, guestDayGeneration())).not.toBeNull()
  })
  it('RSVP and invite exchange reads never refresh an unrelated account after a final 401', async () => {
    saveTokens({ accessToken: 'unrelated-account', refreshToken: 'unrelated-refresh' })
    const fetch = vi.fn(async () => response({ error: { code: 'unauthorized', message: 'Denied' } }, 401)); vi.stubGlobal('fetch', fetch)
    await expect(getRsvp(TOKEN)).rejects.toMatchObject({ status: 401 })
    await expect(redeemInvite('share')).rejects.toMatchObject({ status: 401 })
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [path, options] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(path).not.toContain('refresh'); expect(new Headers(options.headers).has('authorization')).toBe(false)
    }
  })
  it('known denial clears persisted data and fences a pending successful body even with the same token', async () => {
    await copy(); let finish!: (value: Response) => void
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response({ error: { code: 'gone', message: 'Revoked' } }, 410))
    vi.stubGlobal('fetch', fetch)
    const late = getGuestDaySnapshot(TOKEN)
    const refusedLate = expect(late).rejects.toMatchObject({ status: 410 })
    await expect(getGuestDay(TOKEN)).rejects.toMatchObject({ status: 410 })
    finish(response(data())); await refusedLate
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
  })
  it('an explicit valid token caller without persisted token retains server-owned body compatibility but does not cache', async () => {
    saveGuestToken(null); vi.stubGlobal('fetch', vi.fn(async () => response(data())))
    expect(await getGuestDay(TOKEN)).toEqual(data())
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
  })
  it('a cross-tab cache deletion fences a pending older 200 before it can restore the copy', async () => {
    await copy(); let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const unsubscribe = subscribeGuestDayChanges(() => {})
    const late = getGuestDaySnapshot(TOKEN), refusedLate = expect(late).rejects.toMatchObject({ status: 410 })
    const oldValue = localStorage.getItem(GUEST_DAY_OFFLINE_KEY)
    localStorage.removeItem(GUEST_DAY_OFFLINE_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: GUEST_DAY_OFFLINE_KEY, oldValue, newValue: null }))
    finish(response(data())); await refusedLate
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull(); unsubscribe()
  })
  it('a new actual successful day read reopens without cache metadata, and a subsequent 410 still fences late data', async () => {
    let finish!: (value: Response) => void
    const denial = () => response({ error: { code: 'gone', message: 'Revoked' } }, 410)
    const fetch = vi.fn().mockResolvedValueOnce(denial()).mockResolvedValueOnce(response({ ...data(), sourceVersion: undefined }, 200, null))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve })).mockResolvedValueOnce(denial())
    vi.stubGlobal('fetch', fetch)
    await expect(getGuestDay(TOKEN)).rejects.toMatchObject({ status: 410 })
    await getGuestDay(TOKEN)
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
    const late = getGuestDaySnapshot(TOKEN), refusedLate = expect(late).rejects.toMatchObject({ status: 410 })
    await expect(getGuestDay(TOKEN)).rejects.toMatchObject({ status: 410 })
    finish(response(data())); await refusedLate
    expect(localStorage.getItem(GUEST_DAY_OFFLINE_KEY)).toBeNull()
  })
})
