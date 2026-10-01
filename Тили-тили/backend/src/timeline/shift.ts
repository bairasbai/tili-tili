import { validationFailed } from '../errors.js'
import type { TimelinePlanning, TimelineReference } from './planning.js'
import { isRealDate } from '../wedding/dates.js'

export type ShiftScope =
  | { kind: 'day'; date: string; timeZone: string }
  | { kind: 'event'; eventId: string; date: string; timeZone: string }

export interface ShiftBlock extends TimelinePlanning {
  id: string
  name: string
  programEventId: string | null
  location: string | null
  startsAt: string | null
  endsAt: string | null
  /** Additional canonical identities resolved by the server, never the client. */
  resourceKeys?: readonly string[]
}

type Moment = { startsAt: string; endsAt: string | null }
export function planningEnd(b: Pick<ShiftBlock, 'startsAt' | 'endsAt' | 'durationMinutes'>): number | null {
  if (b.endsAt !== null) return Date.parse(b.endsAt)
  const start = b.startsAt === null ? null : Date.parse(b.startsAt)
  return start === null || b.durationMinutes === null ? null : start + b.durationMinutes * 60_000
}
export interface ShiftConflict {
  kind: 'shifted_into_past' | 'crosses_day' | 'unknown_duration' | 'invalid_interval'
    | 'missing_dependency' | 'unknown_dependency_time' | 'dependency_timing'
    | 'unknown_participant_time' | 'participant_overlap' | 'travel_buffer_overlap'
  blockIds: string[]
}
export interface ShiftPreview {
  scope: ShiftScope
  minutes: number
  canConfirm: boolean
  blocks: { id: string; before: Moment; after: Moment }[]
  excluded: { id: string; reason: 'undated' | 'other_day' | 'other_event' | 'fixed' | 'past' }[]
  conflicts: ShiftConflict[]
  affectedBlockIds: string[]
  affectedReferences: TimelineReference[]
  movements: { blockId: string; location: string | null; travelMinutes: number; bufferMinutes: number;
    beforeArrival: string | null; afterArrival: string | null }[]
}

/** Pure calculation; the caller must obtain/recheck a locked, authorized snapshot. */
export function previewTimelineShift(
  blocks: readonly ShiftBlock[], scope: ShiftScope, minutes: number, now: Date,
): ShiftPreview {
  if (!Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > 240) {
    throw validationFailed({ minutes: 'нужно целое ненулевое число от -240 до 240' })
  }
  if (!isRealDate(scope.date)) {
    throw validationFailed({ day: 'нужна существующая дата YYYY-MM-DD' })
  }
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: scope.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch { throw validationFailed({ timeZone: 'неизвестный часовой пояс' }) }
  if (!Number.isFinite(now.getTime())) throw validationFailed({ now: 'нужно фактическое серверное время' })
  if (scope.kind === 'event' && !scope.eventId) throw validationFailed({ eventId: 'нужна идентичность мероприятия' })
  const localDate = (instant: number): string => {
    const parts = formatter.formatToParts(new Date(instant))
    const value = (type: string) => parts.find(p => p.type === type)!.value
    return `${value('year')}-${value('month')}-${value('day')}`
  }
  const byId = new Map(blocks.map(b => [b.id, b]))
  if (byId.size !== blocks.length) throw validationFailed({ blocks: 'идентичности блоков должны быть уникальны' })
  const start = (b: ShiftBlock): number | null => b.startsAt === null ? null : Date.parse(b.startsAt)
  const end = planningEnd
  const conflicts: ShiftConflict[] = []
  const changes: ShiftPreview['blocks'] = []
  const excluded: ShiftPreview['excluded'] = []
  const delta = minutes * 60_000
  const moved = new Set<string>()
  for (const b of blocks) {
    const s = start(b), e = end(b)
    if (s !== null && !Number.isFinite(s)) throw validationFailed({ startsAt: 'недопустимый момент в программе' })
    let reason: ShiftPreview['excluded'][number]['reason'] | undefined
    if (s === null) reason = 'undated'
    else if (localDate(s) !== scope.date) reason = 'other_day'
    else if (scope.kind === 'event' && b.programEventId !== scope.eventId) reason = 'other_event'
    else if (b.fixed) reason = 'fixed'
    else if (s <= now.getTime()) reason = 'past'
    if (reason) { excluded.push({ id: b.id, reason }); continue }
    if (s === null) continue
    if (e !== null && (!Number.isFinite(e) || e < s || e - s > 10080 * 60_000)) {
      conflicts.push({ kind: 'invalid_interval', blockIds: [b.id] })
    }
    if (e === null) conflicts.push({ kind: 'unknown_duration', blockIds: [b.id] })
    if (s + delta <= now.getTime()) conflicts.push({ kind: 'shifted_into_past', blockIds: [b.id] })
    if (localDate(s + delta) !== scope.date) conflicts.push({ kind: 'crosses_day', blockIds: [b.id] })
    const canonicalEnd = e === null || !Number.isFinite(e) ? null : new Date(e).toISOString()
    changes.push({ id: b.id, before: { startsAt: new Date(s).toISOString(), endsAt: canonicalEnd },
      after: { startsAt: new Date(s + delta).toISOString(), endsAt: canonicalEnd === null ? null : new Date(e! + delta).toISOString() } })
    moved.add(b.id)
  }
  const afterStart = (b: ShiftBlock): number | null => {
    const s = start(b)
    return s === null ? null : s + (moved.has(b.id) ? delta : 0)
  }
  const afterEnd = (b: ShiftBlock): number | null => {
    const e = end(b)
    return e === null ? null : e + (moved.has(b.id) ? delta : 0)
  }
  for (const b of blocks) {
    for (const depId of b.dependsOn) {
      if (!moved.has(b.id) && !moved.has(depId)) continue
      const dep = byId.get(depId)
      if (!dep) { conflicts.push({ kind: 'missing_dependency', blockIds: [depId, b.id] }); continue }
      const ready = afterEnd(dep), s = afterStart(b)
      if (ready === null || s === null || !Number.isFinite(ready) || !Number.isFinite(s)) {
        conflicts.push({ kind: 'unknown_dependency_time', blockIds: [depId, b.id] })
      } else if (ready + (b.travelMinutes + b.bufferMinutes) * 60_000 > s) {
        conflicts.push({ kind: 'dependency_timing', blockIds: [depId, b.id] })
      }
    }
  }
  const references = (b: ShiftBlock): TimelineReference[] => [...(b.responsible ? [b.responsible] : []), ...b.participants]
  const key = (r: TimelineReference): string => `${r.kind}:${r.id}`
  const resources = new Map(blocks.map(b => [b.id, new Set([...references(b).map(key), ...(b.resourceKeys ?? [])])]))
  const overlap = (a: number, aEnd: number, b: number, bEnd: number): boolean => a < aEnd && b < bEnd && a < bEnd && b < aEnd
  for (let i = 0; i < blocks.length; i++) {
    const a = blocks[i]!
    for (let j = i + 1; j < blocks.length; j++) {
      const b = blocks[j]!
      if (!moved.has(a.id) && !moved.has(b.id)) continue
      if (![...resources.get(a.id)!].some(r => resources.get(b.id)!.has(r))) continue
      const aStart = afterStart(a), aEnd = afterEnd(a), bStart = afterStart(b), bEnd = afterEnd(b)
      if (aStart === null || aEnd === null || bStart === null || bEnd === null
        || ![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) {
        conflicts.push({ kind: 'unknown_participant_time', blockIds: [a.id, b.id] })
      } else if (overlap(aStart, aEnd, bStart, bEnd)) {
        conflicts.push({ kind: 'participant_overlap', blockIds: [a.id, b.id] })
      } else if (overlap(aStart - (a.travelMinutes + a.bufferMinutes) * 60_000, aEnd,
        bStart - (b.travelMinutes + b.bufferMinutes) * 60_000, bEnd)) {
        conflicts.push({ kind: 'travel_buffer_overlap', blockIds: [a.id, b.id] })
      }
    }
  }
  const affected = new Set([...moved, ...conflicts.flatMap(c => c.blockIds).filter(id => byId.has(id))])
  const refs = new Map<string, TimelineReference>()
  const movements: ShiftPreview['movements'] = []
  for (const b of blocks) {
    if (!affected.has(b.id)) continue
    for (const r of references(b)) refs.set(key(r), { ...r })
    if (b.travelMinutes > 0 || b.bufferMinutes > 0) {
      const before = start(b), after = afterStart(b)
      movements.push({ blockId: b.id, location: b.location, travelMinutes: b.travelMinutes, bufferMinutes: b.bufferMinutes,
        beforeArrival: before === null ? null : new Date(before).toISOString(),
        afterArrival: after === null ? null : new Date(after).toISOString() })
    }
  }
  return { scope: { ...scope }, minutes, canConfirm: changes.length > 0 && conflicts.length === 0,
    blocks: changes, excluded, conflicts, affectedBlockIds: [...affected], affectedReferences: [...refs.values()], movements }
}
