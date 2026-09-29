import { validationFailed } from '../errors.js'

export interface TimelineDependencyInput {
  eventId: string
  travelMinutes: number
  bufferMinutes: number
}

export interface TimelineGraphEvent {
  id: string
  name: string
  startsAt: string | null
  endsAt: string | null
  dependsOn: TimelineDependencyInput[]
}

/**
 * Validate the whole timeline graph before touching rows.
 *
 * The endpoint is full replacement, so the payload is the complete graph:
 * dependencies to omitted/foreign IDs are rejected without probing another wedding.
 */
export function assertTimelineGraph(events: TimelineGraphEvent[]): void {
  const byId = new Map(events.map((event) => [event.id, event]))

  for (const event of events) {
    if (event.startsAt && event.endsAt && Date.parse(event.endsAt) < Date.parse(event.startsAt)) {
      throw validationFailed({ endsAt: 'Конец события не может быть раньше начала' })
    }
    const seen = new Set<string>()
    for (const dependency of event.dependsOn) {
      if (seen.has(dependency.eventId)) {
        throw validationFailed({ dependsOn: `У «${event.name}» одна и та же зависимость указана несколько раз` })
      }
      seen.add(dependency.eventId)
      if (dependency.eventId === event.id) {
        throw validationFailed({ dependsOn: `«${event.name}» не может зависеть от самого себя` })
      }
      if (!byId.has(dependency.eventId)) {
        throw validationFailed({ dependsOn: 'Зависимость ссылается на блок, которого нет в текущем тайминге' })
      }
      if (
        !Number.isInteger(dependency.travelMinutes) ||
        !Number.isInteger(dependency.bufferMinutes) ||
        dependency.travelMinutes < 0 ||
        dependency.travelMinutes > 1440 ||
        dependency.bufferMinutes < 0 ||
        dependency.bufferMinutes > 1440
      ) {
        throw validationFailed({ dependsOn: 'Переезд и запас должны быть целыми минутами от 0 до 1440' })
      }
    }
  }

  // DFS over child -> prerequisites. A gray prerequisite means a cycle.
  const state = new Map<string, 0 | 1 | 2>()
  const visit = (id: string): void => {
    const mark = state.get(id) ?? 0
    if (mark === 2) return
    if (mark === 1) throw validationFailed({ dependsOn: 'Зависимости тайминга образуют цикл' })
    state.set(id, 1)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency.eventId)
    state.set(id, 2)
  }
  for (const event of events) visit(event.id)

  // If both clocks are known, dependency includes travel + explicit safety buffer.
  for (const child of events) {
    if (!child.startsAt) continue
    const childStart = Date.parse(child.startsAt)
    for (const dependency of child.dependsOn) {
      const parent = byId.get(dependency.eventId)!
      if (!parent.endsAt) continue
      const earliest =
        Date.parse(parent.endsAt) + (dependency.travelMinutes + dependency.bufferMinutes) * 60_000
      if (childStart < earliest) {
        const reserve = dependency.travelMinutes + dependency.bufferMinutes
        throw validationFailed({
          dependsOn: `«${child.name}» начинается раньше, чем заканчивается «${parent.name}» и проходит запас ${reserve} мин`,
        })
      }
    }
  }
}
