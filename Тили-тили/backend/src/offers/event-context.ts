import { conflict } from '../errors.js'
import { lockSlotProgramContext, type SlotProgramContext } from '../deals/program-event-context.js'
import type { Queryable } from '../plugins/db.js'

/** Canonical public material. JSONB key order never defines equality. */
export function offerEventContext(event: SlotProgramContext): SlotProgramContext {
  return { id: event.id, isMain: event.isMain, date: event.date, timeZone: event.timeZone,
    name: event.name, kind: event.kind, location: event.location }
}

/** The request's historical NULL is only the old main protocol, never a way to
 * infer extra-event consent from the event's current metadata. Wedding is held
 * before request/event locks by each caller. */
export async function assertOfferEventContext(client: Queryable, weddingId: string, slotId: string,
  snapshot: SlotProgramContext | null, requestDate: string | null): Promise<SlotProgramContext> {
  const actual = await lockSlotProgramContext(client, weddingId, slotId)
  const fields: (keyof SlotProgramContext)[] = ['id', 'isMain', 'date', 'timeZone', 'name', 'kind', 'location']
  if (requestDate !== actual.date || (snapshot === null ? !actual.isMain
    : fields.some(key => snapshot[key] !== actual[key]))) {
    throw conflict('offer_stale_date', 'Мероприятие изменилось — запросите новое предложение')
  }
  return actual
}
