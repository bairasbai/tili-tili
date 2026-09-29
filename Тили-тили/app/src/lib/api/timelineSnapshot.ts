import { ApiError } from './client'
import type { components } from './schema'
import { getTimeline } from './weddingData'
import { autogenTimeline, putTimeline, type TimelineDraft } from './weddingWrite'

export interface TimelineSnapshot {
  weddingId: string
  etag: string | null
  events: TimelineDraft[]
}

/** Full replacement must preserve every writable field, including server IDs. */
export function toTimelineDraft(event: components['schemas']['TimelinePlanEvent']): TimelineDraft {
  return {
    ...(event.id ? { id: event.id } : {}),
    name: event.name ?? '',
    startsAt: event.startsAt ?? '',
    ...(event.endsAt ? { endsAt: event.endsAt } : {}),
    ...(event.who ? { who: event.who } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.icon ? { icon: event.icon } : {}),
    outdoor: event.outdoor ?? false,
    forGuests: event.forGuests ?? true,
    timingMode: event.timingMode ?? 'flexible',
    assigneeUserIds: [...(event.assigneeUserIds ?? [])],
    dealIds: [...(event.dealIds ?? [])],
    dependsOn: (event.dependsOn ?? []).map(dependency => ({
      eventId: dependency.eventId,
      travelMinutes: dependency.travelMinutes ?? 0,
      bufferMinutes: dependency.bufferMinutes ?? 0,
    })),
  }
}

function snapshot(weddingId: string, etag: string | null, events: components['schemas']['TimelinePlanEvent'][]): TimelineSnapshot {
  if (!Array.isArray(events)) throw new ApiError('http', 502, 'invalid_response', 'Некорректный ответ сервера')
  return { weddingId, etag, events: events.map(toTimelineDraft) }
}

export async function getTimelineSnapshot(weddingId: string): Promise<TimelineSnapshot> {
  let etag: string | null = null
  const events = await getTimeline(weddingId, value => { etag = value })
  return snapshot(weddingId, etag, events)
}

export async function putTimelineSnapshot(weddingId: string, events: TimelineDraft[], ifMatch: string): Promise<TimelineSnapshot> {
  let etag: string | null = null
  const saved = await putTimeline(weddingId, events, ifMatch, value => { etag = value })
  return snapshot(weddingId, etag, saved)
}

export async function previewTimelineSnapshot(weddingId: string): Promise<TimelineSnapshot & { conflicts: string[] }> {
  let etag: string | null = null
  const result = await autogenTimeline(weddingId, value => { etag = value })
  if (!result || !Array.isArray(result.events)) throw new ApiError('http', 502, 'invalid_response', 'Некорректный ответ сервера')
  return { ...snapshot(weddingId, etag, result.events), conflicts: result.conflicts ?? [] }
}
