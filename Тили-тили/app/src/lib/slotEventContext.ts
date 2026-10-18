import type { Slot } from './types'

/** Only an absent legacy field may inherit the wedding's context. */
export function slotEventContext(slot: Pick<Slot, 'programEvent'> | undefined, mainDate: string | null, mainTimeZone?: string | null) {
  const explicit = slot?.programEvent !== undefined
  const date = explicit ? slot.programEvent?.date ?? null : mainDate
  const timeZone = explicit ? slot.programEvent?.timeZone ?? null : mainTimeZone
  return {
    date,
    timeZone,
    explicit,
    known: !explicit || (!!date && !!timeZone),
    key: JSON.stringify(explicit ? slot.programEvent : [mainDate, mainTimeZone]),
  }
}
