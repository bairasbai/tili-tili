import { describe, expect, it } from 'vitest'
import type { components } from './api/schema'
import { classifyTaskDue, selectHomeTaskPreview } from './homeTaskPriority'

type Task = components['schemas']['Task']
const ids = (tasks: readonly Task[]) => selectHomeTaskPreview(tasks).map(x => x.task.id)

describe('WP09: home task order by known calendar due dates', () => {
  it('orders the complete open list before taking three; ties preserve response order', () => {
    const tasks: Task[] = [
      { id: 'unknown-first', due: null },
      { id: 'late', due: '2027-12-31', title: 'А' },
      { id: 'closed', due: '2000-01-01', done: true },
      { id: 'same-first', due: '2027-03-10', title: 'Я' },
      { id: 'same-second', due: '2027-03-10', title: 'А' },
      { id: 'earliest-last', due: '2026-12-31' },
    ]
    expect(ids(tasks)).toEqual(['earliest-last', 'same-first', 'same-second'])
  })

  it('keeps missing and invalid dates together in their original order after known dates', () => {
    const tasks: Task[] = [
      { id: 'invalid', due: '2027-02-30' },
      { id: 'missing', due: null },
      { id: 'omitted' },
      { id: 'known-last', due: '2099-12-31' },
    ]
    expect(ids(tasks)).toEqual(['known-last', 'invalid', 'missing'])
    expect(selectHomeTaskPreview(tasks).map(x => x.due.state)).toEqual(['known', 'invalid', 'missing'])
    expect(ids(tasks.slice(0, 3))).toEqual(['invalid', 'missing', 'omitted'])
  })

  it('excludes closed tasks but retains the existing !done treatment of an omitted flag', () => {
    expect(ids([{ id: 'closed', done: true }, { id: 'open', done: false }, { id: 'omitted' }]))
      .toEqual(['open', 'omitted'])
    expect(selectHomeTaskPreview([])).toEqual([])
    expect(selectHomeTaskPreview([{ done: true }])).toEqual([])
  })

  it.each([undefined, null])('classifies missing %s explicitly', value => {
    expect(classifyTaskDue(value)).toEqual({ state: 'missing', date: null })
  })

  it.each([
    '', ' ', '2027-2-01', '2027-02-1', ' 2027-02-01', '2027-02-01 ',
    '2027-00-01', '2027-13-01', '2027-01-00', '2027-01-32',
    '2027-04-31', '2027-02-29', '1900-02-29', '2100-02-29',
    '0000-01-01', '10000-01-01', '2027-02-01T00:00:00Z', 'not-a-date',
  ])('does not normalize invalid date %s into a sortable due date', value => {
    expect(classifyTaskDue(value)).toEqual({ state: 'invalid', date: null })
  })

  it.each(['0001-01-01', '2000-02-29', '2028-02-29', '2027-04-30', '2011-12-30', '9999-12-31'])(
    'keeps the calendar date %s without consulting a timezone', value => {
      expect(classifyTaskDue(value)).toEqual({ state: 'known', date: value })
    },
  )

  it('does not infer priorities from period, assignee, custom flag or title', () => {
    const tasks: Task[] = [
      { id: 'first', due: '2027-06-01', period: '1', title: 'Я', custom: true, assignee: null },
      { id: 'second', due: '2027-06-01', period: '9', title: 'А', custom: false,
        assignee: { userId: 'person', name: 'Аня' } },
      { id: 'unknown', due: null, period: '999' },
    ]
    expect(ids(tasks)).toEqual(['first', 'second', 'unknown'])
  })

  it('does not mutate the source array or records and returns original task identities', () => {
    const late = Object.freeze({ id: 'late', due: '2027-12-31', done: false })
    const early = Object.freeze({ id: 'early', due: '2027-01-01', done: false })
    const source = Object.freeze([late, early])
    const preview = selectHomeTaskPreview(source)
    expect(source).toEqual([late, early])
    expect(preview[0]!.task).toBe(early)
    expect(preview[1]!.task).toBe(late)
    expect(preview.map(x => x.sourceIndex)).toEqual([1, 0])
    expect(ids(source)).toEqual(['early', 'late'])
  })
})
