import { describe, expect, it } from 'vitest'
import { previewTimelineShift, type ShiftBlock } from '../src/timeline/shift.js'
import { futureShiftStart } from './helpers/shift-window.js'

const HOUR = 60 * 60_000
const zone = 'Europe/Moscow'
function localDay(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant))
  const field = (type: string) => parts.find(part => part.type === type)!.value
  return `${field('year')}-${field('month')}-${field('day')}`
}
function block(startsAt: string, id = 'fixture'): ShiftBlock {
  return { id, name: id, programEventId: null, location: null, startsAt,
    endsAt: new Date(Date.parse(startsAt) + HOUR).toISOString(), durationMinutes: 60,
    fixed: false, travelMinutes: 0, bufferMinutes: 0, responsible: null,
    participants: [], dependsOn: [] }
}

// Real production planner, explicit instants; no fake system/database/auth clock.
describe('notification shift fixture stays inside its selected Moscow day', () => {
  it.each(Array.from({ length: 24 }, (_, hour) => hour))('is safe at UTC hour %i, including minute boundaries', hour => {
    for (const minute of [0, 40, 45, 50, 55, 59]) {
      const now = new Date(Date.UTC(2026, 9, 5, hour, minute, 59, 999))
      const initial = block(futureShiftStart(now))
      const scope = { kind: 'day' as const, date: localDay(initial.startsAt!), timeZone: zone }
      expect(Date.parse(initial.startsAt!)).toBeGreaterThan(now.getTime())
      const snapshot = structuredClone(initial)
      const once = previewTimelineShift([initial], scope, 15, now)
      expect(once.canConfirm, JSON.stringify({ now, conflicts: once.conflicts })).toBe(true)
      expect(once.blocks).toHaveLength(1)
      expect(initial).toEqual(snapshot)
      let current = initial
      for (let count = 0; count < 5; count++) {
        const next = previewTimelineShift([current], scope, 5, now)
        expect(next.canConfirm, JSON.stringify({ now, count, conflicts: next.conflicts })).toBe(true)
        expect(next.blocks).toHaveLength(1)
        current = { ...current, ...next.blocks[0]!.after }
        expect(localDay(current.startsAt!)).toBe(scope.date)
        expect(localDay(current.endsAt!)).toBe(scope.date)
        expect(Date.parse(current.endsAt!) - Date.parse(current.startsAt!)).toBe(HOUR)
      }
      expect(Date.parse(current.startsAt!) - Date.parse(initial.startsAt!)).toBe(25 * 60_000)
    }
  })

  it.each([
    ['2026-12-31T23:59:59.999Z', '2027-01-02T09:00:00.000Z'],
    ['2027-02-28T23:59:59.999Z', '2027-03-02T09:00:00.000Z'],
    ['2028-02-28T23:59:59.999Z', '2028-03-01T09:00:00.000Z'],
    ['2028-02-29T00:00:00.000Z', '2028-03-02T09:00:00.000Z'],
    ['2026-10-31T18:52:32.875Z', '2026-11-02T09:00:00.000Z'],
  ])('rolls calendar boundaries without depending on host timezone: %s', (input, expected) => {
    const now = new Date(input)
    expect(futureShiftStart(now)).toBe(expected)
    expect(now.toISOString()).toBe(input)
  })

  it.each([
    ['2026-10-05T18:52:32.875Z', 15],
    ['2026-10-05T18:57:01.216Z', 5],
  ] as const)('reproduces the old relative-clock conflict at %s and keeps the server guard', (instant, minutes) => {
    const now = new Date(instant)
    const old = block(new Date(now.getTime() + 2 * HOUR).toISOString())
    const result = previewTimelineShift([old], { kind: 'day', date: localDay(old.startsAt!), timeZone: zone }, minutes, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'crosses_day', blockIds: ['fixture'] })
    const fixed = block(futureShiftStart(now))
    expect(previewTimelineShift([fixed], { kind: 'day', date: localDay(fixed.startsAt!), timeZone: zone }, minutes, now).canConfirm).toBe(true)
  })

  it('preserves exclusion of a genuinely past block on the selected day', () => {
    const now = new Date('2026-10-05T10:00:00.000Z')
    const past = block('2026-10-05T09:00:00.000Z', 'past')
    const future = block('2026-10-05T12:00:00.000Z', 'future')
    const snapshot = structuredClone(past)
    const result = previewTimelineShift([past, future], { kind: 'day', date: '2026-10-05', timeZone: zone }, 15, now)
    expect(result.canConfirm).toBe(true)
    expect(result.blocks.map(row => row.id)).toEqual(['future'])
    expect(result.excluded).toContainEqual({ id: 'past', reason: 'past' })
    expect(past).toEqual(snapshot)
  })

  it('rejects an invalid clock rather than silently using another date', () => {
    expect(() => futureShiftStart(new Date(NaN))).toThrow(RangeError)
  })
})
