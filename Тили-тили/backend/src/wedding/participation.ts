import type { Queryable } from '../plugins/db.js'
import { forbidden, notFound, unauthorized, validationFailed } from '../errors.js'
import { guestByToken } from '../guests/access.js'
import { lockOrderPrincipal, lockOrderWedding, type OrderActor } from '../orders/context.js'
import { checkEntityId, checkVersion } from '../orders/model.js'

export type ParticipationStatus = 'unknown' | 'attending' | 'declined'
export type ParticipationPrincipal = { kind: 'team'; actor: OrderActor } | { kind: 'guest'; token: string }
export interface ParticipationInput { weddingId: string; eventId: string; principal: ParticipationPrincipal; guestId?: string }
export type ParticipationSource = 'legacy_main_rsvp' | 'guest_response' | 'team_observation' | 'organizer_correction'
export interface ParticipationDto { guestId: string; programEventId: string; status: ParticipationStatus; version: string;
  source: ParticipationSource | null; actorUserId: string | null; recordedAt: string | null }
async function scope(client: Queryable, input: ParticipationInput, write: boolean) {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.eventId, 'eventId')
  if (input.guestId !== undefined) checkEntityId(input.guestId, 'guestId')
  await lockOrderWedding(client, input.weddingId, write)
  let partyId: string | null = null, actorUserId: string | null = null
  if (input.principal.kind === 'team') {
    actorUserId = input.principal.actor.userId.toLowerCase()
    await lockOrderPrincipal(client, input.principal.actor)
    const member = await client.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [input.weddingId, actorUserId])
    if (!member.rows[0]) throw notFound('Свадьба не найдена')
    if (!['couple', 'helper', 'coordinator'].includes(member.rows[0].role)) throw forbidden('Нет доступа к участию гостей')
  } else if (input.principal.kind === 'guest') {
    // Resolve token again after the wedding lock; the earlier HTTP hook is insufficient.
    const guest = await guestByToken(client, input.principal.token)
    if (guest.weddingId !== input.weddingId.toLowerCase()) throw unauthorized('Ссылка недействительна')
    const party = await client.query<{ id: string }>('select id from guest_parties where id=$1 and wedding_id=$2 and invite_token=$3 for share', [guest.partyId, input.weddingId, input.principal.token])
    if (!party.rows[0]) throw unauthorized('Ссылка недействительна')
    partyId = guest.partyId
  } else throw unauthorized()
  const event = await client.query<{ is_main: boolean }>('select is_main from wedding_events where wedding_id=$1 and id=$2 for share', [input.weddingId, input.eventId])
  if (!event.rows[0]) throw notFound('Мероприятие не найдено')
  const people = await client.query<{ id: string; rsvp: string }>(`select id,rsvp from guests where wedding_id=$1
    and ($2::uuid is null or party_id=$2) and ($3::uuid is null or id=$3) order by id for share`, [input.weddingId, partyId, input.guestId ?? null])
  if (input.guestId && !people.rows[0]) throw notFound('Персона не найдена')
  return { people: people.rows, isMain: event.rows[0].is_main, actorUserId }
}
/** Missing rows on other events are unknown; only the real main event may use legacy RSVP. */
export async function loadEventParticipation(client: Queryable, input: ParticipationInput): Promise<ParticipationDto[]> {
  const access = await scope(client, input, false)
  const existing = await client.query<{ guest_id: string; status: ParticipationStatus; version: string; source: ParticipationDto['source']; actor_user_id: string | null; recorded_at: Date }>(
    'select guest_id,status,version::text,source,actor_user_id,recorded_at from event_guest_participation where wedding_id=$1 and program_event_id=$2 and guest_id=any($3::uuid[])', [input.weddingId, input.eventId, access.people.map(p => p.id)])
  const byId = new Map(existing.rows.map(r => [r.guest_id, r]))
  return access.people.map(p => {
    const row = byId.get(p.id)
    return { guestId: p.id, programEventId: input.eventId.toLowerCase(), status: row?.status ?? (access.isMain ? p.rsvp === 'yes' ? 'attending' : p.rsvp === 'no' ? 'declined' : 'unknown' : 'unknown'),
      version: row?.version ?? '0', source: row?.source ?? (access.isMain ? 'legacy_main_rsvp' : null), actorUserId: row?.actor_user_id ?? null, recordedAt: row?.recorded_at.toISOString() ?? null }
  })
}
export interface UpdateParticipationInput extends ParticipationInput { guestId: string; status: ParticipationStatus; expectedVersion: string }
export async function updateEventParticipation(client: Queryable, input: UpdateParticipationInput): Promise<ParticipationDto> {
  checkEntityId(input.guestId, 'guestId')
  const access = await scope(client, input, true)
  if (!['unknown', 'attending', 'declined'].includes(input.status)) throw validationFailed({ status: 'Неизвестное участие' })
  const existing = await client.query<{ status: ParticipationStatus; version: string; source: string; actor_user_id: string | null }>(
    'select status,version::text,source,actor_user_id from event_guest_participation where wedding_id=$1 and program_event_id=$2 and guest_id=$3 for update', [input.weddingId, input.eventId, input.guestId])
  const row = existing.rows[0]
  checkVersion(row?.version ?? '0', input.expectedVersion, 'expectedVersion', true)
  const source = input.principal.kind === 'guest' ? 'guest_response' : 'team_observation'
  if (row?.status === input.status && row.source === source && row.actor_user_id === access.actorUserId) return (await loadEventParticipation(client, input))[0]!
  await client.query(`insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source,actor_user_id)
    values($1,$2,$3,$4,$5,$6) on conflict(program_event_id,guest_id) do update set status=excluded.status,
    source=excluded.source,actor_user_id=excluded.actor_user_id,version=event_guest_participation.version+1,recorded_at=now()`,
    [input.weddingId, input.eventId, input.guestId, input.status, source, access.actorUserId])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'wedding.participation_changed','guest',$2,$3::jsonb)",
    [access.actorUserId, input.guestId, JSON.stringify({ weddingId: input.weddingId, programEventId: input.eventId, status: input.status, source, beforeVersion: input.expectedVersion })])
  return (await loadEventParticipation(client, input))[0]!
}

export interface SyncMainParticipationInput {
  weddingId: string
  guestIds: string[]
  source: 'guest_response' | 'team_observation'
  actorUserId: string | null
}
/** Internal legacy-command bridge, not an ACL entry point. The caller must already
 * authorize the actual token/session/selected people and hold this wedding's write
 * lock in the same transaction. Pass only people affected by that RSVP command.
 * It does not mirror changes in the reverse direction or alter legacy bookings. */
export async function syncMainParticipationFromLegacy(client: Queryable, input: SyncMainParticipationInput): Promise<ParticipationDto[]> {
  checkEntityId(input.weddingId, 'weddingId')
  if (!['guest_response', 'team_observation'].includes(input.source)) throw validationFailed({ source: 'Нужен настоящий источник ответа' })
  if (input.source === 'guest_response') {
    if (input.actorUserId !== null) throw validationFailed({ actorUserId: 'Ответ по гостевому токену не имеет автора аккаунта' })
  } else checkEntityId(input.actorUserId, 'actorUserId')
  if (!Array.isArray(input.guestIds) || input.guestIds.length > 1000) throw validationFailed({ guestIds: 'Нужен ограниченный список персон' })
  for (const id of input.guestIds) checkEntityId(id, 'guestIds')
  const ids = [...new Set(input.guestIds.map(id => id.toLowerCase()))].sort()
  const actorUserId = input.actorUserId?.toLowerCase() ?? null
  if (!ids.length) return []
  const event = await client.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main for share', [input.weddingId])
  const main = event.rows[0]
  if (!main) throw notFound('Основное мероприятие не найдено')
  const guests = await client.query<{ id: string; rsvp: string }>('select id,rsvp from guests where wedding_id=$1 and id=any($2::uuid[]) order by id for share', [input.weddingId, ids])
  // Reject the entire command before writing if any selected person has left this wedding.
  if (guests.rows.length !== ids.length) throw notFound('Персона не найдена')
  const result: ParticipationDto[] = []
  for (const guest of guests.rows) {
    const status: ParticipationStatus = guest.rsvp === 'yes' ? 'attending' : guest.rsvp === 'no' ? 'declined' : 'unknown'
    const existing = await client.query<{ status: ParticipationStatus; source: string; actor_user_id: string | null; version: string; recorded_at: Date }>(
      'select status,source,actor_user_id,version::text,recorded_at from event_guest_participation where wedding_id=$1 and program_event_id=$2 and guest_id=$3 for update', [input.weddingId, main.id, guest.id])
    const before = existing.rows[0]
    const changed = !before || before.status !== status || before.source !== input.source || before.actor_user_id !== actorUserId
    let version = before?.version, recordedAt = before?.recorded_at
    if (changed) {
      const written = await client.query<{ version: string; recorded_at: Date }>(`insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source,actor_user_id)
        values($1,$2,$3,$4,$5,$6) on conflict(program_event_id,guest_id) do update set status=excluded.status,
        source=excluded.source,actor_user_id=excluded.actor_user_id,version=event_guest_participation.version+1,recorded_at=now()
        returning version::text,recorded_at`, [input.weddingId, main.id, guest.id, status, input.source, actorUserId])
      version = written.rows[0]!.version; recordedAt = written.rows[0]!.recorded_at
      await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'wedding.participation_changed','guest',$2,$3::jsonb)",
        [actorUserId, guest.id, JSON.stringify({ weddingId: input.weddingId, programEventId: main.id, status, source: input.source, beforeVersion: before?.version ?? '0', legacyCommand: true })])
    }
    result.push({ guestId: guest.id, programEventId: main.id, status, version: version!, source: input.source,
      actorUserId, recordedAt: recordedAt!.toISOString() })
  }
  return result
}
