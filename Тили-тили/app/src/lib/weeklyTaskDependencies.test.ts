import { describe, expect, it } from 'vitest'
import { weeklyChecklistHref, weeklyDependencyState } from './weeklyTaskDependencies'

const parent = '00000000-0000-4000-8000-000000000001'
const id = 'aaaaaaaa-0000-4000-8000-000000000001'
const task = (dependencies: unknown = [], dependencyVersion: unknown = '0') => ({ id: parent, dependencies, dependencyVersion })
const dependency = (done = false) => ({ id, title: '  Review the guest list  ', done })

describe('explicit weekly prerequisite projection', () => {
  it('distinguishes a confirmed empty list from unknown metadata', () => {
    expect(weeklyDependencyState(task())).toEqual({ state: 'none', pending: [] })
  })
  it('returns only unsatisfied direct dependencies in the server order', () => {
    expect(weeklyDependencyState(task([dependency(true), { ...dependency(), id: 'bbbbbbbb-0000-4000-8000-000000000001' }], '7')))
      .toEqual({ state: 'blocked', pending: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Review the guest list' }] })
  })
  it('marks all supplied prerequisites as satisfied without claiming the task is complete', () => {
    expect(weeklyDependencyState(task([dependency(true)]))).toEqual({ state: 'satisfied', pending: [] })
  })
  it.each([null, [], {}, task(null), task({}), { ...task(), dependencyVersion: undefined }, task([], null), task([], 0), task([], ''), task([], '-1'), task([], '1.5')])(
    'treats invalid or absent metadata as unknown (%#)', input => {
      expect(weeklyDependencyState(input)).toEqual({ state: 'unknown', pending: [] })
    })
  it.each([null, {}, { ...dependency(), id: '../other' }, { ...dependency(), title: null }, { ...dependency(), done: 'false' }, { ...dependency(), done: undefined }])(
    'does not turn a malformed prerequisite into a completed or actionable entry (%#)', entry => {
      expect(weeklyDependencyState(task([dependency(), entry]))).toEqual({ state: 'unknown', pending: [] })
    })
  it('rejects duplicate identities, including different UUID case', () => {
    expect(weeklyDependencyState(task([dependency(), { ...dependency(), id: id.toUpperCase() }])).state).toBe('unknown')
  })
  it('rejects a self-reference rather than offering a misleading link', () => {
    expect(weeklyDependencyState(task([{ ...dependency(), id: parent }])).state).toBe('unknown')
  })
  it('keeps the full allowed list and rejects an oversized response', () => {
    const deps = Array.from({ length: 64 }, (_, i) => ({ ...dependency(), id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` }))
    expect(weeklyDependencyState(task(deps)).pending).toHaveLength(64)
    expect(weeklyDependencyState(task([...deps, { ...dependency(), id: 'cccccccc-0000-4000-8000-000000000000' }])).state).toBe('unknown')
  })
  it('copies only identity and title, does not retain notes or mutate input', () => {
    const item = Object.freeze({ ...dependency(), privateNote: 'not part of the view' })
    const input = Object.freeze({ ...task(Object.freeze([item])), dependencyOverride: { reason: 'private audit reason' } })
    const result = weeklyDependencyState(input)
    expect(result).toEqual({ state: 'blocked', pending: [{ id, title: 'Review the guest list' }] })
    result.pending[0].title = 'changed locally'
    expect(input.dependencies).toEqual([item]); expect(item.title).toBe('  Review the guest list  ')
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it('preserves a blank title for the localized unnamed fallback', () => {
    expect(weeklyDependencyState(task([{ ...dependency(), title: '  ' }])).pending[0].title).toBe('')
  })
})

describe('wedding-scoped task links', () => {
  it('keeps the explicit task and wedding for reload', () => {
    expect(weeklyChecklistHref(parent, id)).toBe(`/wedding/checklist?wedding=${parent}&task=${id}`)
  })
  it('opens the selected wedding checklist without fabricating a task', () => {
    expect(weeklyChecklistHref(parent)).toBe(`/wedding/checklist?wedding=${parent}`)
  })
  it('encodes untrusted values without allowing another query parameter or route', () => {
    const href = weeklyChecklistHref('w &task=other#fragment', 't /?wedding=other&task=x')
    const parsed = new URL(href, 'https://test.invalid')
    expect(parsed.pathname).toBe('/wedding/checklist'); expect(parsed.hash).toBe('')
    expect([...parsed.searchParams.keys()]).toEqual(['wedding', 'task'])
    expect(parsed.searchParams.get('wedding')).toBe('w &task=other#fragment')
    expect(parsed.searchParams.get('task')).toBe('t /?wedding=other&task=x')
  })
})
