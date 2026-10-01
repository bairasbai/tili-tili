// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { offlineGeneration, forgetOfflineSeating } from './offlineAccess'
import { parseSeating, recallSeating, reconcileOfflineSeating, rememberSeating, type OfflineSeating } from './offlineSeating'

const scope = { userId: 'u1', sessionId: 's1' }, KEY = 'tt_seating_offline'
const copy = (): OfflineSeating => ({ schema: 1, scope, weddingId: 'w1', role: 'helper', savedAt: '2026-10-01T01:00:03Z',
  guestsReadAt: '2026-10-01T01:00:01Z', tablesReadAt: '2026-10-01T01:00:02Z',
  guests: [{ id: 'g1', name: 'Alice', status: 'yes', tableId: 't1' }], tables: [{ id: 't1', name: 'Table', capacity: 2 }] })
beforeEach(() => { localStorage.clear() })
describe('minimal seating copy, independent read provenance and isolation', () => {
  it('projects allowed fields on both write and recall, not raw private guest/member DTO', () => {
    const dirty = { ...copy(), tokens: 'secret', members: ['secret'], guests: [{ ...copy().guests[0], phone: 'secret', plusOne: true, diet: 'secret', comment: 'secret' }] }
    rememberSeating(dirty, offlineGeneration())
    expect(localStorage.getItem(KEY)).not.toContain('secret')
    expect(recallSeating('w1', scope)).toEqual(copy())
    localStorage.setItem(KEY, JSON.stringify(dirty))
    expect(recallSeating('w1', scope)).toEqual(copy())
  })
  it.each([
    { schema: 0 }, { role: 'vendor' }, { savedAt: 'bad' }, { guestsReadAt: null }, { tablesReadAt: 'bad' },
    { scope: { userId: 'u1', sessionId: '' } }, { tables: [{ id: 't1', name: 'Bad', capacity: 0 }] },
    { tables: [{ id: 't1', name: 'Bad', capacity: 1.5 }] }, { guests: [{ id: 'g1', name: 'Alice', status: 'unknown', tableId: 't1' }] },
    { guests: [{ id: 'g1', name: 'Alice', status: 'yes', tableId: 'missing' }] },
    { guests: [copy().guests[0], copy().guests[0]] }, { tables: [copy().tables[0], copy().tables[0]] },
  ])('rejects malformed or inconsistent storage %j', patch => { expect(parseSeating({ ...copy(), ...patch })).toBeNull() })
  it.each([['w2', scope], ['w1', { userId: 'u2', sessionId: 's1' }], ['w1', { userId: 'u1', sessionId: 's2' }], ['w1', null]] as const)('never crosses wedding/session/account %s', (wedding, ownScope) => {
    rememberSeating(copy(), offlineGeneration()); expect(recallSeating(wedding, ownScope)).toBeNull()
  })
  it('late read after cleanup cannot resurrect a removed copy', () => {
    const generation = offlineGeneration(); forgetOfflineSeating(); rememberSeating(copy(), generation)
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it.each([[], [{ id: 'w1', role: 'vendor' }], [{ id: 'w1', role: 'coordinator' }], [{ id: 'w2', role: 'helper' }]].map(list => ({ list })))('known membership change invalidates a copy while route is unmounted', ({ list }) => {
    rememberSeating(copy(), offlineGeneration()); reconcileOfflineSeating(list, scope)
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it('current matching membership retains the copy without inventing expiration or a server revision', () => {
    rememberSeating(copy(), offlineGeneration()); reconcileOfflineSeating([{ id: 'w1', role: 'helper' }], scope)
    expect(recallSeating('w1', scope)).toEqual(copy())
    expect(localStorage.getItem(KEY)).not.toMatch(/etag|version|expiresAt|readToken|retention/)
  })
})
