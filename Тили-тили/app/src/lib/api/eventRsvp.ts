import { api, ApiError, url } from './client'
import type { components } from './schema'

/*
 * T012 — срок ответа и персональный RSVP дополнительных мероприятий.
 *
 * Гость отвечает за персон своей семьи по каждому дополнительному мероприятию
 * до общего срока; после срока — только просьба организатору. Пара задаёт
 * срок, видит ответы с источником (кто ответил), правит их и решает просьбы.
 * Основная программа (`/rsvp/{token}` и её RSVP) этим файлом не затрагивается.
 */

export type EventRsvpDeadline = components['schemas']['EventRsvpDeadline']
export type EventRsvpRequest = components['schemas']['EventRsvpRequest']
export type EventRsvpPerson = components['schemas']['EventRsvpPerson']
export type EventRsvpCouplePerson = components['schemas']['EventRsvpCouplePerson']
export type GuestRsvpEvent = components['schemas']['GuestRsvpEvent']
export type EventRsvpRoster = components['schemas']['EventRsvpRoster']
export type EventRsvpDecisionResult = components['schemas']['EventRsvpDecisionResult']

function invalid(message: string): never {
  throw new ApiError('http', 200, 'invalid_response', message)
}

const SOURCES = ['legacy_main_rsvp', 'guest_response', 'team_observation', 'organizer_correction']

/* Сервер отдаёт типы по контракту, но ответ бывает ошибочным или от старой
   версии — поэтому форма проверяется в рантайме, тем же приёмом, что
   `assertRoster` у приглашений (`weddingEvents.ts`): параметр типизирован
   ожидаемой формой, а проверка — что поля и правда такие, какими их обещает TS. */
function badDeadline(d: EventRsvpDeadline): boolean {
  return !d || (d.date !== null && typeof d.date !== 'string') || (d.timeZone !== null && typeof d.timeZone !== 'string')
    || !['none', 'open', 'closed'].includes(d.state) || (d.closesAt !== null && typeof d.closesAt !== 'string')
}
function badRequest(r: EventRsvpRequest): boolean {
  return !r || typeof r.id !== 'string' || typeof r.guestId !== 'string'
    || !['attending', 'declined'].includes(r.requestedStatus) || !['pending', 'accepted', 'rejected'].includes(r.state)
    || (r.comment !== null && typeof r.comment !== 'string') || (r.decisionNote !== null && typeof r.decisionNote !== 'string')
    || typeof r.createdAt !== 'string' || (r.decidedAt !== null && typeof r.decidedAt !== 'string') || typeof r.version !== 'string'
}
function badPerson(p: EventRsvpPerson): boolean {
  return !p || typeof p.guestId !== 'string' || typeof p.name !== 'string'
    || !['unknown', 'attending', 'declined'].includes(p.status) || (p.source !== null && !SOURCES.includes(p.source))
    || typeof p.version !== 'string' || (p.request !== null && badRequest(p.request))
}
function badCouplePerson(p: EventRsvpCouplePerson): boolean {
  return badPerson(p) || typeof p.partyId !== 'string' || (p.partyLabel !== null && typeof p.partyLabel !== 'string')
}

/* ── Гость (по персональному токену семьи) ──────────────────────────────── */

/** Дополнительные мероприятия семьи гостя со сроком ответа и текущими ответами (T012). */
export const getGuestEventRsvp = async (token: string): Promise<GuestRsvpEvent[]> => {
  const data = await api.get(url('/rsvp/{guestToken}/events', { guestToken: token }))
  const events = data.events
  if (!Array.isArray(events) || events.some(e => !e.event || typeof e.event.id !== 'string' || typeof e.event.name !== 'string'
    || typeof e.event.isMain !== 'boolean' || badDeadline(e.deadline) || !Array.isArray(e.people) || e.people.some(badPerson)))
    invalid('Мероприятия гостя не подтверждены сервером')
  return events
}

export type GuestEventAnswer = { guestId: string; status: 'attending' | 'declined'; expectedVersion: string }

/** Ответить за персон семьи на дополнительное мероприятие; атомарно всей пачкой (T012). */
export const saveGuestEventAnswers = async (token: string, eventId: string, answers: GuestEventAnswer[]): Promise<EventRsvpPerson[]> => {
  const data = await api.put(url('/rsvp/{guestToken}/events/{eventId}/answers', { guestToken: token, eventId }), { answers })
  const people = data.people
  if (!Array.isArray(people) || people.some(badPerson) || new Set(people.map(p => p.guestId)).size !== people.length)
    invalid('Ответы мероприятия не подтверждены сервером')
  return people
}

export type GuestEventRequestInput = { guestId: string; requestedStatus: 'attending' | 'declined'; comment?: string }

/**
 * Попросить организатора изменить ответ после срока (T012).
 *
 * `idempotencyKey` создаётся в обработчике клика, не здесь: так один и тот же
 * ключ переживает явный повтор того же черновика, а новый черновик получает
 * новый ключ (решение владельца K-Q9).
 */
export const requestGuestEventChange = async (token: string, eventId: string, body: GuestEventRequestInput, idempotencyKey: string): Promise<EventRsvpRequest> => {
  const req = await api.post(url('/rsvp/{guestToken}/events/{eventId}/requests', { guestToken: token, eventId }), body, { idempotencyKey })
  if (badRequest(req)) invalid('Просьба не подтверждена сервером')
  return req
}

/* ── Пара (и команда свадьбы на чтение) ──────────────────────────────────── */

/** Срок, состав ответов и просьбы дополнительного мероприятия — вид команды свадьбы (T012). */
export const getEventRsvpRoster = async (weddingId: string, eventId: string): Promise<EventRsvpRoster> => {
  const data = await api.get(url('/weddings/{weddingId}/events/{eventId}/rsvp', { weddingId, eventId }))
  if (badDeadline(data.deadline) || !Array.isArray(data.people) || data.people.some(badCouplePerson)
    || !Array.isArray(data.requests) || data.requests.some(badRequest))
    invalid('Снимок ответов не подтверждён сервером')
  return data
}

/**
 * Внести или исправить ответ персоны («внесено организатором», T012).
 *
 * Версия — в теле (`expectedVersion`), не в `If-Match`: сравнивается версия
 * самой персоны в `event_guest_participation`, а не снимка программы.
 */
export const correctEventRsvp = async (
  weddingId: string, eventId: string, guestId: string, status: 'unknown' | 'attending' | 'declined', expectedVersion: string,
): Promise<EventRsvpCouplePerson> => {
  const person = await api.put(url('/weddings/{weddingId}/events/{eventId}/rsvp/{guestId}', { weddingId, eventId, guestId }), { status, expectedVersion })
  if (badCouplePerson(person)) invalid('Ответ персоны не подтверждён сервером')
  return person
}

/** Принять или отклонить просьбу гостя изменить ответ (T012). Версия — в теле, как у коррекции. */
export const decideEventRsvpRequest = async (
  weddingId: string, eventId: string, requestId: string, decision: 'accept' | 'reject', expectedVersion: string, note?: string,
): Promise<EventRsvpDecisionResult> => {
  const result = await api.post(url('/weddings/{weddingId}/events/{eventId}/rsvp-requests/{requestId}/decision', { weddingId, eventId, requestId }), {
    decision, expectedVersion, ...(note ? { note } : {}),
  })
  if (badRequest(result.request) || badCouplePerson(result.person)) invalid('Решение по просьбе не подтверждено сервером')
  return result
}
