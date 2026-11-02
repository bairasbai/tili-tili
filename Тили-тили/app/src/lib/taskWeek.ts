import { isRealIso } from './weddingDate'
import { prioritizeTasks, taskDue, type TaskDeadline } from './taskPriorities'

export interface TaskWeek<T> {
  start: string
  end: string
  overdue: T[]
  upcoming: T[]
  undated: T[]
  later: T[]
}

/** Date-only calendar arithmetic, independent of viewer timezone and DST. */
export function taskWeekRange(today: string): { start: string; end: string } | null {
  if (!isRealIso(today)) return null
  const monday = new Date(`${today}T12:00:00.000Z`)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  const sunday = new Date(monday)
  sunday.setUTCDate(sunday.getUTCDate() + 6)
  const start = monday.toISOString().slice(0, 10)
  const end = sunday.toISOString().slice(0, 10)
  return isRealIso(start) && isRealIso(end) ? { start, end } : null
}

/**
 * Every open task belongs to exactly one group. Earlier deadlines remain visible
 * as overdue, including previous weeks; unknown dates never become overdue.
 * `today` must already be the current date in the wedding's calendar timezone.
 */
export function groupTaskWeek<T extends TaskDeadline>(tasks: readonly T[], today: string): TaskWeek<T> | null {
  const range = taskWeekRange(today)
  if (!range) return null
  const result: TaskWeek<T> = { ...range, overdue: [], upcoming: [], undated: [], later: [] }
  for (const task of prioritizeTasks(tasks)) {
    const due = taskDue(task)
    if (due === null) result.undated.push(task)
    else if (due < today) result.overdue.push(task)
    else if (due <= range.end) result.upcoming.push(task)
    else result.later.push(task)
  }
  return result
}

/** Keep the established offer-calendar fallback, but reject a malformed zone. */
export function taskCalendarZone(zone?: string | null): string | null {
  const candidate = zone || 'Europe/Moscow'
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate })
    return candidate
  } catch {
    return null
  }
}
