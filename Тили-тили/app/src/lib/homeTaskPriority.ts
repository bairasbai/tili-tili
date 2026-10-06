// A structural projection keeps this selector independent of the generated API client.
export type HomeTaskInput = { due?: string | null; done?: boolean }

export type TaskDueInfo =
  | { state: 'known'; date: string }
  | { state: 'missing' | 'invalid'; date: null }

/** Calendar dates only: no clocks, Date parsing, timezone or silent repair. */
export function classifyTaskDue(value: unknown): TaskDueInfo {
  if (value == null) return { state: 'missing', date: null }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { state: 'invalid', date: null }
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (year < 1 || month < 1 || month > 12) return { state: 'invalid', date: null }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > monthDays[month - 1]!) return { state: 'invalid', date: null }
  return { state: 'known', date: value }
}

/** First three open tasks; ties and all unknown dates retain response order. */
export function selectHomeTaskPreview<T extends HomeTaskInput>(tasks: readonly T[]) {
  return tasks
    .map((task, sourceIndex) => ({ task, sourceIndex, due: classifyTaskDue(task.due) }))
    .filter(({ task }) => !task.done)
    .sort((a, b) => {
      if (a.due.state === 'known' && b.due.state === 'known') {
        if (a.due.date < b.due.date) return -1
        if (a.due.date > b.due.date) return 1
      } else if (a.due.state === 'known') {
        return -1
      } else if (b.due.state === 'known') {
        return 1
      }
      return a.sourceIndex - b.sourceIndex
    })
    .slice(0, 3)
}
