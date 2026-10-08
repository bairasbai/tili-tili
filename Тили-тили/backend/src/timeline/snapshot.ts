import type { Queryable } from '../plugins/db.js'
import { notFound, validationFailed } from '../errors.js'
import { knownTimeZone } from '../notify/quiet.js'
import { isRealDate } from '../wedding/dates.js'
import type { ParticipationDto, ParticipationStatus } from '../wedding/participation.js'
import { readTimelinePlanning } from './planning.js'
import { planningEnd, previewTimelineShift, type ShiftBlock, type ShiftScope } from './shift.js'

export type RequestedShiftScope = { kind: 'day'; date: string } | { kind: 'event'; eventId: string }
export interface GuestConsequence {
  guestId: string; name: string | null; eventId: string; eventName: string
  status: ParticipationStatus; source: ParticipationDto['source']; version: string
  invitation: 'explicit' | 'main_legacy' | null; assignment: boolean
}
export async function readShiftPlan(db: Queryable, weddingId: string, requested: RequestedShiftScope, minutes: number, now: Date) {
  if (requested.kind === 'day' && !isRealDate(requested.date)) throw validationFailed({ date: 'нужна существующая дата YYYY-MM-DD' })
  const context = requested.kind === 'event'
    ? (await db.query<{ date: string | null; tz: string | null }>('select date::text,time_zone as tz from wedding_events where wedding_id=$1 and id=$2', [weddingId, requested.eventId])).rows[0]
    : (await db.query<{ date: string | null; tz: string | null }>('select $2::text as date,tz from weddings where id=$1', [weddingId, requested.date])).rows[0]
  if (!context) throw notFound('Мероприятие не найдено')
  if (!context.date || !context.tz || knownTimeZone(context.tz) !== context.tz) {
    throw validationFailed({ scope: 'нужны известные дата и часовой пояс выбранной области' })
  }
  const scope: ShiftScope = requested.kind === 'event'
    ? { kind: 'event', eventId: requested.eventId.toLowerCase(), date: context.date, timeZone: context.tz }
    : { kind: 'day', date: context.date, timeZone: context.tz }
  const planning = await readTimelinePlanning(db, weddingId)
  const rows = (await db.query<{ id: string; name: string; program_event_id: string; location: string | null;
    event_name: string; event_date: string | null; event_time_zone: string | null;
    starts_at: Date | null; ends_at: Date | null; for_guests: boolean }>(
    `select t.id,t.name,t.program_event_id,t.location,t.starts_at,t.ends_at,t.for_guests,
      e.name as event_name,e.date::text as event_date,e.time_zone as event_time_zone
      from timeline_events t join wedding_events e on e.wedding_id=t.wedding_id and e.id=t.program_event_id
      where t.wedding_id=$1 order by t.sort,t.id`, [weddingId])).rows
  const deals = (await db.query<{ id: string; vendor_id: string | null; owner_id: string | null; name: string | null }>(
    `select d.id,d.vendor_id,v.user_id as owner_id,coalesce(d.external_name,v.name) as name from deals d left join vendors v on v.id=d.vendor_id
      where d.wedding_id=$1 and d.state in ('booked','paid_deposit','done') order by d.id for share of d`, [weddingId])).rows
  const byDeal = new Map(deals.map(d => [d.id, d]))
  const blocks: ShiftBlock[] = rows.map(r => {
    const plan = planning.get(r.id)!
    const refs = [...plan.participants, ...(plan.responsible ? [plan.responsible] : [])]
    const resourceKeys = refs.filter(ref => ref.kind === 'deal').flatMap(ref => {
      const d = byDeal.get(ref.id)
      return d?.vendor_id ? [`vendor:${d.vendor_id}`, ...(d.owner_id ? [`member:${d.owner_id}`] : [])] : []
    })
    return { ...plan, id: r.id, name: r.name, programEventId: r.program_event_id, location: r.location,
      startsAt: r.starts_at?.toISOString() ?? null, endsAt: r.ends_at?.toISOString() ?? null, resourceKeys }
  })
  const preview = previewTimelineShift(blocks, scope, minutes, now)
  const moved = new Set(preview.blocks.map(b => b.id))
  const movedRows = rows.filter(r => moved.has(r.id))
  const main = (await db.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
  const affectedBlocks = blocks.filter(b => preview.affectedBlockIds.includes(b.id))
  const byBlockEvent = new Map(rows.map(r => [r.id, r.program_event_id]))
  const guestRows = (await db.query<{ id: string; name: string | null; rsvp: string }>(
    'select id,name,rsvp from guests where wedding_id=$1 order by id', [weddingId])).rows
  const byGuest = new Map(guestRows.map(g => [g.id, g]))
  const eventIds = [...new Set(rows.filter(r => preview.affectedBlockIds.includes(r.id)).map(r => r.program_event_id))].sort()
  const invitations = (await db.query<{ event_id: string; guest_id: string }>(
    'select event_id,guest_id from guest_event_invitations where wedding_id=$1 and event_id=any($2::uuid[]) order by event_id,guest_id', [weddingId, eventIds])).rows
  const invitedByEvent = new Map<string, Set<string>>()
  for (const invitation of invitations) {
    const people = invitedByEvent.get(invitation.event_id) ?? new Set<string>()
    people.add(invitation.guest_id); invitedByEvent.set(invitation.event_id, people)
  }
  const candidates = new Map<string, { guestId: string; eventId: string; assignment: boolean }>()
  const addCandidate = (guestId: string, eventId: string, assignment: boolean) => {
    if (!byGuest.has(guestId)) return
    const key = `${eventId}:${guestId}`, existing = candidates.get(key)
    candidates.set(key, { guestId, eventId, assignment: assignment || existing?.assignment === true })
  }
  for (const block of movedRows) {
    if (!block.for_guests) continue
    const people = block.program_event_id === main ? byGuest.keys() : invitedByEvent.get(block.program_event_id) ?? []
    for (const guestId of people) addCandidate(guestId, block.program_event_id, false)
  }
  for (const block of affectedBlocks) {
    const eventId = byBlockEvent.get(block.id)
    if (!eventId) throw notFound('Мероприятие не найдено')
    for (const ref of [...block.participants, ...(block.responsible ? [block.responsible] : [])]) {
      if (ref.kind === 'guest') addCandidate(ref.id, eventId, true)
    }
  }
  const participation = (await db.query<{ program_event_id: string; guest_id: string; status: ParticipationStatus; source: ParticipationDto['source']; version: string }>(
    `select program_event_id,guest_id,status,source,version::text from event_guest_participation
      where wedding_id=$1 and program_event_id=any($2::uuid[]) and guest_id=any($3::uuid[]) order by program_event_id,guest_id`,
    [weddingId, eventIds, [...new Set([...candidates.values()].map(p => p.guestId))]])).rows
  const byParticipation = new Map(participation.map(p => [`${p.program_event_id}:${p.guest_id}`, p]))
  const byEvent = new Map(rows.map(r => [r.program_event_id, r.event_name]))
  const guestConsequences: GuestConsequence[] = [...candidates.values()]
    .sort((a, b) => a.eventId.localeCompare(b.eventId) || a.guestId.localeCompare(b.guestId))
    .map(candidate => {
      const guest = byGuest.get(candidate.guestId)!, row = byParticipation.get(`${candidate.eventId}:${candidate.guestId}`)
      const isMain = candidate.eventId === main
      const eventName = byEvent.get(candidate.eventId)
      if (eventName === undefined) throw notFound('Мероприятие не найдено')
      return { ...candidate, name: guest.name, eventName,
        status: row?.status ?? (isMain ? guest.rsvp === 'yes' ? 'attending' : guest.rsvp === 'no' ? 'declined' : 'unknown' : 'unknown'),
        source: row ? row.source : isMain ? 'legacy_main_rsvp' : null, version: row?.version ?? '0',
        invitation: isMain ? 'main_legacy' : invitedByEvent.get(candidate.eventId)?.has(candidate.guestId) ? 'explicit' : null }
    })
  const attendingIds = new Set(guestConsequences.filter(g => g.status === 'attending').map(g => g.guestId))
  const guests = guestRows.filter(g => attendingIds.has(g.id))
  const unknownGuestCount = new Set(guestConsequences.filter(g => g.status === 'unknown').map(g => g.guestId)).size
  const memberRefs = preview.affectedReferences.filter(r => r.kind === 'member').map(r => r.id)
  const members = (await db.query<{ id: string; name: string | null }>(
    `select u.id,u.name from users u join wedding_members m on m.user_id=u.id
      where m.wedding_id=$1 and u.id=any($2::uuid[]) and u.deleted_at is null
        and m.role in ('couple','helper','coordinator') order by u.id`, [weddingId, memberRefs])).rows
  const byMember = new Map(members.map(m => [m.id, m]))
  const referenceDetails = preview.affectedReferences.map(ref => ({ ...ref,
    name: (ref.kind === 'member' ? byMember.get(ref.id)?.name : ref.kind === 'guest' ? byGuest.get(ref.id)?.name : byDeal.get(ref.id)?.name) ?? null,
    assignments: affectedBlocks.flatMap(b => [
      ...(b.responsible?.kind === ref.kind && b.responsible.id === ref.id ? [{ blockId: b.id, role: 'responsible' as const }] : []),
      ...(b.participants.some(r => r.kind === ref.kind && r.id === ref.id) ? [{ blockId: b.id, role: 'participant' as const }] : []),
    ]),
  }))
  const blockDetails = rows.map((r, i) => {
    const end = planningEnd(blocks[i]!)
    return { id: r.id, name: r.name, eventId: r.program_event_id,
      eventName: r.event_name, eventDate: r.event_date, timeZone: r.event_time_zone, location: r.location,
      startsAt: r.starts_at?.toISOString() ?? null, endsAt: end !== null && Number.isFinite(end) ? new Date(end).toISOString() : null }
  })
  const vendorIds = new Set<string>(), memberIds = new Set<string>(), vendorUsers = new Set<string>()
  for (const ref of preview.affectedReferences) {
    if (ref.kind === 'member') memberIds.add(ref.id)
    if (ref.kind === 'deal') {
      const d = byDeal.get(ref.id)
      if (d?.vendor_id) vendorIds.add(d.vendor_id)
      if (d?.owner_id) vendorUsers.add(d.owner_id)
    }
  }
  return { ...preview, blockDetails, referenceDetails, affectedGuests: guests.map(g => ({ id: g.id, name: g.name })),
    guestsAffected: guests.length, affectedGuestIds: guests.map(g => g.id),
    guestConsequences, unknownGuestCount, guestConsequencesIncomplete: unknownGuestCount > 0,
    affectedVendorIds: [...vendorIds].sort(), affectedMemberIds: [...memberIds].sort(),
    vendorUserIds: [...vendorUsers].sort() }
}
