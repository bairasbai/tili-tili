import type { components } from '../contract/api.generated.js'
import type { Queryable } from '../plugins/db.js'
import { checklistTemplate } from './templates.js'

export interface ChecklistTaskIdentity {
  id: string
  sort: number
  source: string
  kind: string | null
  period: string | null
  done_at: Date | null
  excluded_reason: string | null
}

type Blocker = components['schemas']['TaskDependencyBlocker']

/** Completion callers already hold the wedding write lock, also used by RSVP and task writers. */
export async function loadTaskBlockers(db: Queryable, weddingId: string, tasks: readonly ChecklistTaskIdentity[]) {
  const waiting = tasks.flatMap(task => {
    if (task.kind !== 'checklist' || task.source !== 'system' || task.done_at || task.excluded_reason !== null) return []
    const dependencies = checklistTemplate(task.sort, task.period)?.dependencies
    return dependencies?.length ? [{ id: task.id, dependencies }] : []
  })
  const dependencies = waiting.flatMap(task => task.dependencies)
  const taskSorts = [...new Set(dependencies.flatMap(d => d.kind === 'task' ? [d.sort] : []))]
  const [prerequisites, guests] = await Promise.all([
    taskSorts.length ? db.query<{ id: string; title: string; sort: number; period: string | null }>(
      `select id,title,sort,period from tasks
        where wedding_id=$1 and kind='checklist' and source='system' and sort=any($2::int[])
          and done_at is null and excluded_reason is null order by id`, [weddingId, taskSorts],
    ) : null,
    dependencies.some(d => d.kind === 'guest_rsvp') ? db.query<{ pending: number }>(
      "select count(*)::int as pending from guests where wedding_id=$1 and rsvp='pending'", [weddingId],
    ) : null,
  ])
  const pending = guests?.rows[0]?.pending ?? 0
  const blockers = new Map<string, Blocker[]>()
  for (const task of waiting) {
    const required = task.dependencies.flatMap<Blocker>(dependency => {
      if (dependency.kind === 'guest_rsvp') return pending > 0 ? [{ kind: 'guest_rsvp', pendingCount: pending }] : []
      const prerequisite = prerequisites?.rows.find(row => row.sort === dependency.sort && row.period === dependency.period)
      return prerequisite ? [{ kind: 'task', taskId: prerequisite.id, title: prerequisite.title }] : []
    })
    if (required.length) blockers.set(task.id, required)
  }
  return blockers
}
