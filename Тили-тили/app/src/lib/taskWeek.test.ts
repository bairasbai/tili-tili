import { describe, expect, it } from 'vitest'
import { groupTaskWeek, taskCalendarZone, taskWeekRange } from './taskWeek'

const task = (id: string, due?: string | null, done = false) => ({ id, title: id, due, done })
const ids = (items: readonly { id: string }[]) => items.map(item => item.id)

describe('task-only weekly projection', () => {
  it.each([
    ['2026-10-05', '2026-10-05', '2026-10-11'],
    ['2026-10-06', '2026-10-05', '2026-10-11'],
    ['2026-10-11', '2026-10-05', '2026-10-11'],
    ['2027-01-01', '2026-12-28', '2027-01-03'],
    ['2024-02-29', '2024-02-26', '2024-03-03'],
    ['2026-03-08', '2026-03-02', '2026-03-08'],
    ['2026-11-01', '2026-10-26', '2026-11-01'],
    ['2026-03-29', '2026-03-23', '2026-03-29'],
  ])('%s belongs to Monday %s through Sunday %s', (today, start, end) => {
    expect(taskWeekRange(today)).toEqual({ start, end })
  })

  it.each(['', 'not-a-date', '2026-02-29', '2026-04-31', '2026-1-01', '2026-10-05T00:00:00Z', '9999-12-31'])('rejects an invalid or unrepresentable week %j instead of claiming zero tasks', today => {
    expect(taskWeekRange(today)).toBeNull()
    expect(groupTaskWeek([task('real', '2026-10-05')], today)).toBeNull()
  })

  it('includes today and Sunday, keeps all earlier weeks overdue, and exposes undated tasks separately', () => {
    const result = groupTaskWeek([
      task('next', '2026-10-12'), task('sunday', '2026-10-11'), task('today', '2026-10-07'),
      task('monday', '2026-10-05'), task('old', '2026-09-01'), task('none'),
      task('invalid', '2026-02-30'), task('complete', '2026-10-06', true),
    ], '2026-10-07')!
    expect(ids(result.overdue)).toEqual(['old', 'monday'])
    expect(ids(result.upcoming)).toEqual(['today', 'sunday'])
    expect(ids(result.undated)).toEqual(['none', 'invalid'])
    expect(ids(result.later)).toEqual(['next'])
  })

  it('does not include next Monday in a Sunday view', () => {
    const result = groupTaskWeek([task('sunday', '2026-10-11'), task('monday', '2026-10-12')], '2026-10-11')!
    expect(ids(result.upcoming)).toEqual(['sunday'])
    expect(ids(result.later)).toEqual(['monday'])
  })

  it('does not mutate frozen inputs or replace the original objects', () => {
    const early = Object.freeze(task('early', '2026-10-05'))
    const late = Object.freeze(task('late', '2026-10-10'))
    const input = Object.freeze([late, early])
    const result = groupTaskWeek(input, '2026-10-07')!
    expect(input).toEqual([late, early])
    expect(result.overdue[0]).toBe(early)
    expect(result.upcoming[0]).toBe(late)
  })

  it('preserves server order for equal deadlines and unknown deadlines', () => {
    const result = groupTaskWeek([task('z', '2026-10-08'), task('a', '2026-10-08'), task('n1'), task('n2', null)], '2026-10-07')!
    expect(ids(result.upcoming)).toEqual(['z', 'a'])
    expect(ids(result.undated)).toEqual(['n1', 'n2'])
  })

  it('does not invent a date for an undated relative-period task', () => {
    const result = groupTaskWeek([{ ...task('relative'), period: 1 }], '2026-10-07')!
    expect(ids(result.undated)).toEqual(['relative'])
    expect(result.overdue).toEqual([])
  })

  it('has empty groups only for a real empty or fully completed response', () => {
    for (const tasks of [[], [task('done', '2026-10-01', true)]]) {
      expect(groupTaskWeek(tasks, '2026-10-07')).toEqual({
        start: '2026-10-05', end: '2026-10-11', overdue: [], upcoming: [], undated: [], later: [],
      })
    }
  })

  it.each(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])('partitions every open task exactly once on %s', today => {
    const tasks = Array.from({ length: 31 }, (_, index) => task(String(index), `2026-10-${String(index + 1).padStart(2, '0')}`, index % 4 === 0))
    tasks.push(task('unknown'), task('bad', 'invalid'), task('completed-unknown', null, true))
    const week = groupTaskWeek(tasks, today)!
    const all = [...week.overdue, ...week.upcoming, ...week.undated, ...week.later]
    expect(new Set(all).size).toBe(all.length)
    expect(new Set(all)).toEqual(new Set(tasks.filter(item => !item.done)))
    for (const item of week.overdue) expect(item.due! < today).toBe(true)
    for (const item of week.upcoming) expect(item.due! >= today && item.due! <= week.end).toBe(true)
    for (const item of week.later) expect(item.due! > week.end).toBe(true)
  })
})

describe('weekly calendar timezone', () => {
  it.each(['UTC', 'Europe/Moscow', 'America/New_York', 'Asia/Yekaterinburg', 'Pacific/Honolulu'])('retains an explicitly valid server timezone %s', zone => {
    expect(taskCalendarZone(zone)).toBe(zone)
  })
  it.each([undefined, null, ''])('matches the existing offer-calendar fallback for %j', zone => {
    expect(taskCalendarZone(zone)).toBe('Europe/Moscow')
  })
  it.each(['Not/AZone', ' ', 'Europe/Unknown'])('rejects invalid %j without substituting the viewer calendar', zone => {
    expect(taskCalendarZone(zone)).toBeNull()
  })
})
