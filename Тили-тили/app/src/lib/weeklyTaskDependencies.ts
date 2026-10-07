/** Read-only projection of explicit task prerequisites from one server response. */
export type WeeklyPrerequisite = { id: string; title: string }
export type WeeklyDependencyState = {
  state: 'unknown' | 'none' | 'satisfied' | 'blocked'
  pending: WeeklyPrerequisite[]
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Missing or inconsistent metadata must not be presented as permission to complete. */
export function weeklyDependencyState(value: unknown): WeeklyDependencyState {
  const unknown = (): WeeklyDependencyState => ({ state: 'unknown', pending: [] })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown()
  const task = value as Record<string, unknown>
  if (typeof task.dependencyVersion !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(task.dependencyVersion)
    || !Array.isArray(task.dependencies) || task.dependencies.length > 64) return unknown()
  const seen = new Set<string>(), pending: WeeklyPrerequisite[] = []
  for (const item of task.dependencies) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return unknown()
    const dependency = item as Record<string, unknown>
    if (typeof dependency.id !== 'string' || !uuid.test(dependency.id)
      || typeof dependency.title !== 'string' || typeof dependency.done !== 'boolean') return unknown()
    const id = dependency.id.toLowerCase()
    if (seen.has(id) || (typeof task.id === 'string' && id === task.id.toLowerCase())) return unknown()
    seen.add(id)
    if (!dependency.done) pending.push({ id, title: dependency.title.trim() })
  }
  return { state: pending.length ? 'blocked' : seen.size ? 'satisfied' : 'none', pending }
}

/** The explicit wedding scope survives navigation and a full page reload. */
export function weeklyChecklistHref(weddingId: string, taskId?: string): string {
  const params = new URLSearchParams({ wedding: weddingId })
  if (taskId !== undefined) params.set('task', taskId)
  return `/wedding/checklist?${params.toString()}`
}
