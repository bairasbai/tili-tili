import { isRealIso } from './weddingDate'

/** The existing task API owns deadlines. Never infer one from a period or title. */
export interface TaskDeadline {
  done?: boolean
  due?: string | null
}

export function taskDue(task: TaskDeadline): string | null {
  return typeof task.due === 'string' && isRealIso(task.due) ? task.due : null
}

/**
 * Open tasks with real dates first, earliest deadline first; undated tasks last.
 * Equal dates retain server order. Neither the API array nor its objects change.
 * A caller must check its query's readiness before displaying cached tasks.
 */
export function prioritizeTasks<T extends TaskDeadline>(tasks: readonly T[]): T[] {
  return tasks
    .filter(task => !task.done)
    .map((task, index) => ({ task, index, due: taskDue(task) }))
    .sort((a, b) => {
      if (a.due === b.due) return a.index - b.index
      if (a.due === null) return 1
      if (b.due === null) return -1
      return a.due < b.due ? -1 : 1
    })
    .map(({ task }) => task)
}
