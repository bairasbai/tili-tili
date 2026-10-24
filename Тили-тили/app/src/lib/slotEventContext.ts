import type { Slot } from './types'
import type { ProgramEventPrecondition } from './api/client'
import type { components } from './api/schema'

export type ProgramEventMaterial = NonNullable<components['schemas']['OfferProgramEventContext']>

/** Compare all public snapshot facts, independent from JSON property order. */
export function sameProgramEvent(a: ProgramEventMaterial | null | undefined, b: ProgramEventMaterial | null | undefined): boolean {
  if (!a || !b) return a === b
  return a.id === b.id && a.isMain === b.isMain && a.date === b.date && a.timeZone === b.timeZone
    && a.name === b.name && a.kind === b.kind && a.location === b.location
}

export function slotEventPrecondition(slot: Pick<Slot, 'programEvent'> | undefined): ProgramEventPrecondition | undefined {
  const event = slot?.programEvent
  return event && !event.isMain && event.id && event.date !== undefined && event.timeZone
    ? { id: event.id, date: event.date, timeZone: event.timeZone } : undefined
}

/** Only an absent legacy field may inherit the wedding's context. */
export function slotEventContext(slot: Pick<Slot, 'programEvent'> | undefined, mainDate: string | null, mainTimeZone?: string | null) {
  const explicit = slot?.programEvent !== undefined
  const date = explicit ? slot.programEvent?.date ?? null : mainDate
  const timeZone = explicit ? slot.programEvent?.timeZone ?? null : mainTimeZone
  const precondition = slotEventPrecondition(slot)
  const known = !explicit || (!!date && !!timeZone)
  return {
    date,
    timeZone,
    explicit,
    known,
    timeZoneKnown: !explicit || !!timeZone,
    acquisitionReady: !explicit || (slot.programEvent?.isMain ? !!slot.programEvent.id : !!precondition),
    undatedAdditional: !!precondition && date === null,
    key: JSON.stringify(explicit ? slot.programEvent : [mainDate, mainTimeZone]),
    precondition,
  }
}
