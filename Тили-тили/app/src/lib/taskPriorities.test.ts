import { describe, expect, it } from 'vitest'
import { prioritizeTasks, taskDue } from './taskPriorities'

const task = (id: string, due?: string | null, done = false) => ({ id, title: id, due, done })
const ids = (items: readonly { id: string }[]) => items.map(item => item.id)

describe('task deadline priorities', () => {
  it('orders dates before taking the home-page limit, not by API position', () => {
    const tasks = [task('far', '2027-01-01'), task('none'), task('next', '2026-10-09'), task('overdue', '2026-10-01'), task('today', '2026-10-05')]
    expect(ids(prioritizeTasks(tasks).slice(0, 3))).toEqual(['overdue', 'today', 'next'])
  })

  it('removes completed tasks before sorting and limiting', () => {
    expect(ids(prioritizeTasks([task('done', '2020-01-01', true), task('open', '2026-10-05')]))).toEqual(['open'])
  })

  it('retains server order for equal deadlines', () => {
    expect(ids(prioritizeTasks([task('z', '2026-10-05'), task('a', '2026-10-05'), task('m', '2026-10-05')]))).toEqual(['z', 'a', 'm'])
  })

  it('retains server order for undated and malformed deadlines', () => {
    expect(ids(prioritizeTasks([task('none'), task('null', null), task('invalid', '2026-02-30'), task('empty', '')]))).toEqual(['none', 'null', 'invalid', 'empty'])
  })

  it('does not turn an undated period into a fabricated deadline', () => {
    const periodTask = { ...task('period'), period: 1 }
    expect(taskDue(periodTask)).toBeNull()
    expect(ids(prioritizeTasks([periodTask, task('dated', '2030-01-01')]))).toEqual(['dated', 'period'])
  })

  it('does not mutate frozen source arrays or replace task objects', () => {
    const later = Object.freeze(task('later', '2026-12-01'))
    const earlier = Object.freeze(task('earlier', '2026-01-01'))
    const source = Object.freeze([later, earlier])
    const result = prioritizeTasks(source)
    expect(source).toEqual([later, earlier])
    expect(result).not.toBe(source)
    expect(result[0]).toBe(earlier)
    expect(result[1]).toBe(later)
  })

  it('returns an empty list when all tasks are complete', () => {
    expect(prioritizeTasks([task('done', null, true)])).toEqual([])
  })

  it('returns an empty list for empty input', () => {
    expect(prioritizeTasks([])).toEqual([])
  })

  it('sorts across year boundaries', () => {
    expect(ids(prioritizeTasks([task('january', '2027-01-01'), task('december', '2026-12-31')]))).toEqual(['december', 'january'])
  })

  it.each(['', 'not-a-date', '2026-2-01', '2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '2026-04-31', '2026-10-05T00:00:00Z', ' 2026-10-05'])('treats invalid date %j as unknown, not overdue', due => {
    expect(taskDue(task('invalid', due))).toBeNull()
    expect(ids(prioritizeTasks([task('invalid', due), task('valid', '2026-10-05')]))).toEqual(['valid', 'invalid'])
  })

  it.each(['2024-02-29', '2000-02-29', '2026-10-05', '2026-12-31'])('preserves valid date-only deadline %s without a UTC conversion', due => {
    expect(taskDue(task('valid', due))).toBe(due)
  })
})
