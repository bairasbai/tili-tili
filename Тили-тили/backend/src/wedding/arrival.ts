import { validationFailed } from '../errors.js'

export type VenueArrival = { entrance: string | null; parking: string | null; accessibleRoute: string | null }

const note = (maxLength: number) => ({ type: 'string', nullable: true, maxLength })
export const arrivalProperty = {
  type: 'object', nullable: true, additionalProperties: false,
  required: ['entrance', 'parking', 'accessibleRoute'],
  properties: { entrance: note(300), parking: note(300), accessibleRoute: note(600) },
}

export function normalizeArrival(arrival: VenueArrival | null | undefined) {
  if (!arrival) return arrival
  const result = { entrance: arrival.entrance?.trim() || null, parking: arrival.parking?.trim() || null,
    accessibleRoute: arrival.accessibleRoute?.trim() || null }
  for (const value of Object.values(result)) {
    if (value && [...value].some(char => (char.charCodeAt(0) < 32 && char !== '\n') || char.charCodeAt(0) === 127)) {
      throw validationFailed({ arrival: 'Уберите управляющие символы' })
    }
  }
  return result.entrance || result.parking || result.accessibleRoute ? result : null
}
