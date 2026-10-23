import type { FastifyRequest } from 'fastify'
import { AppError, conflict } from '../errors.js'
import { isUuid } from '../ids.js'
import { knownTimeZone } from '../notify/quiet.js'
import type { Queryable } from '../plugins/db.js'
import { isRealDate } from '../wedding/dates.js'

export interface ProgramEventContext { id: string; date: string; timeZone: string }
export interface SlotProgramContext {
  id: string | null; isMain: boolean; date: string | null; timeZone: string | null
  name: string | null; kind: string | null; location: string | null
}
export interface ProgramEventPrecondition { eventContext?: ProgramEventContext | undefined }

/** A public optimistic precondition, never permission or a client-selected event.
 * Canonicalization also defines the idempotent command identity. */
export function readProgramEventContext(request: Pick<FastifyRequest, 'headers'>): ProgramEventContext | undefined {
  const raw = request.headers['x-program-event-context']
  if (raw === undefined) return undefined
  const invalid = () => new AppError(422, 'event_context_invalid', 'Нужен точный контекст выбранного мероприятия')
  if (typeof raw !== 'string' || raw.length > 2048) throw invalid()
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const context = value as Record<string, unknown>
  if (Object.keys(context).length !== 3 || Object.keys(context).some(key => !['id', 'date', 'timeZone'].includes(key))
    || !isUuid(context.id) || typeof context.date !== 'string' || !isRealDate(context.date)
    || typeof context.timeZone !== 'string' || knownTimeZone(context.timeZone) !== context.timeZone) throw invalid()
  return { id: context.id.toLowerCase(), date: context.date, timeZone: context.timeZone }
}

/** Caller owns the wedding prefix. Read and pin the real slot/event relation;
 * an explicit missing/unknown event never inherits the main date. */
export async function lockSlotProgramContext(client: Queryable, weddingId: string, slotId: string): Promise<SlotProgramContext> {
  const load = async () => (await client.query<{
    program_event_id: string | null; event_id: string | null; is_main: boolean | null
    event_date: string | null; event_tz: string | null; wedding_date: string | null; wedding_tz: string | null
    name: string | null; kind: string | null; location: string | null
  }>(`select s.program_event_id,e.id event_id,e.is_main,e.date::text event_date,e.time_zone event_tz,
    w.date::text wedding_date,w.tz wedding_tz,e.name,e.kind,e.location
    from slots s join weddings w on w.id=s.wedding_id left join wedding_events e
      on e.wedding_id=s.wedding_id and (e.id=s.program_event_id or (s.program_event_id is null and e.is_main))
    where s.wedding_id=$1 and s.id=$2`, [weddingId, slotId])).rows[0]
  const located = await load()
  if (!located || (located.program_event_id !== null && located.event_id === null)) {
    throw conflict('event_context_changed', 'Мероприятие позиции изменилось — обновите данные')
  }
  if (located.event_id) await client.query('select id from wedding_events where wedding_id=$1 and id=$2 for share', [weddingId, located.event_id])
  const row = await load()
  if (!row || row.program_event_id !== located.program_event_id || row.event_id !== located.event_id) {
    throw conflict('event_context_changed', 'Мероприятие позиции изменилось — обновите данные')
  }
  const isMain = row.program_event_id === null || row.is_main === true
  if (row.event_id && isMain && (row.event_date !== row.wedding_date || row.event_tz !== row.wedding_tz)) {
    throw conflict('event_date_conflict', 'Дата или часовой пояс основного мероприятия изменились — обновите программу')
  }
  return { id: row.event_id, isMain, date: isMain ? row.wedding_date : row.event_date,
    timeZone: isMain ? row.wedding_tz : row.event_tz, name: row.name, kind: row.kind, location: row.location }
}

/** Releases do not require a new acquisition precondition. If supplied, it is
 * still compared to the current actual scope. */
export function assertProgramEventContext(actual: SlotProgramContext, expected: ProgramEventContext | undefined, acquisition = false): void {
  if (acquisition && !actual.isMain && (!actual.id || actual.date === null || actual.timeZone === null)) {
    throw conflict('event_context_incomplete', 'Укажите дату и часовой пояс дополнительного мероприятия перед бронированием')
  }
  if (acquisition && !actual.isMain && !expected) {
    throw new AppError(428, 'event_context_required', 'Обновите данные выбранного мероприятия перед бронированием')
  }
  if (expected && (actual.id !== expected.id || actual.date !== expected.date || actual.timeZone !== expected.timeZone)) {
    throw conflict('event_context_changed', 'Контекст выбранного мероприятия изменился — обновите данные')
  }
}
