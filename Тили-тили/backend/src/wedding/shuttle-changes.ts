import { conflict, notFound, validationFailed } from '../errors.js'
import type { GuestCaller } from '../guests/access.js'
import type { Queryable } from '../plugins/db.js'
import { assignTrip, lockTripSelection, selectionClosed } from './shuttle.js'

type ChangeStatus = 'pending' | 'approved' | 'declined' | 'withdrawn'
export type ChangeDecision = 'approved' | 'declined'
export interface TripChange {
  guestId: string
  fromBusId: string
  toBusId: string
}
type ChangeRow = {
  id: string; guest_id: string; name: string; party_id: string; program_event_id: string | null
  from_bus_id: string | null; to_bus_id: string | null; from_label: string; to_label: string
  status: ChangeStatus; created_at: Date; resolved_at: Date | null
}

const base = `select q.*,g.name,g.party_id from shuttle_change_requests q
  join guests g on g.wedding_id=q.wedding_id and g.id=q.guest_id`
const availableEvent = `(q.program_event_id is null or exists(
  select 1 from guest_event_invitations i where i.wedding_id=q.wedding_id
    and i.event_id=q.program_event_id and i.guest_id=q.guest_id
))`
const view = (row: ChangeRow) => ({
  id: row.id, guestId: row.guest_id, passengerName: row.name, fromBusId: row.from_bus_id, toBusId: row.to_bus_id,
  fromLabel: row.from_label, toLabel: row.to_label, status: row.status,
  createdAt: row.created_at.toISOString(), resolvedAt: row.resolved_at?.toISOString() ?? null,
})

export async function guestTripChanges(client: Queryable, guest: GuestCaller) {
  const { rows } = await client.query<ChangeRow>(`${base} where q.wedding_id=$1 and g.party_id=$2 and ${availableEvent}
    order by (q.status='pending') desc,q.created_at desc,q.id limit 100`, [guest.weddingId, guest.partyId])
  return rows.map(view)
}

export async function teamTripChanges(client: Queryable, weddingId: string) {
  const { rows } = await client.query<ChangeRow>(`${base} where q.wedding_id=$1
    order by (q.status='pending') desc,q.created_at desc,q.id limit 200`, [weddingId])
  return rows.map(view)
}

/** The original seat and target are locked in the same order as a regular booking. */
export async function requestTripChange(client: Queryable, guest: GuestCaller, id: string, input: TripChange) {
  const guestId = input.guestId.toLowerCase()
  const fromBusId = input.fromBusId.toLowerCase()
  const toBusId = input.toBusId.toLowerCase()
  if (fromBusId === toBusId) throw validationFailed({ toBusId: 'Выберите другой рейс' })
  const { rows: [prior] } = await client.query<ChangeRow>(`${base} where q.wedding_id=$1 and q.id=$2
    and g.party_id=$3 and ${availableEvent}`, [guest.weddingId, id, guest.partyId])
  if (prior) {
    if (prior.guest_id !== guestId || (prior.from_bus_id && prior.from_bus_id !== fromBusId)
      || (prior.to_bus_id && prior.to_bus_id !== toBusId)) {
      throw conflict('shuttle_request_conflict', 'Запрос уже создан с другими данными')
    }
    return view(prior)
  }
  const selection = await lockTripSelection(client, guest, toBusId, guestId)
  const source = selection.locked.find(route => route.id === fromBusId)
  if (!source || !selection.missing) throw conflict('shuttle_seat_changed', 'Исходное место изменилось. Обновите список рейсов.')
  if (!await selectionClosed(client, selection)) {
    throw conflict('shuttle_deadline_open', 'Срок ещё не прошёл. Выберите рейс в списке.')
  }
  const inserted = await client.query(`insert into shuttle_change_requests(
      wedding_id,id,guest_id,program_event_id,from_bus_id,to_bus_id,from_label,to_label)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
  [guest.weddingId,id,guestId,selection.eventId,fromBusId,toBusId,source.name,selection.destination.name])
  if (!inserted.rowCount) throw conflict('shuttle_request_conflict', 'Запрос уже создан. Обновите список рейсов.')
  const { rows: [saved] } = await client.query<ChangeRow>(`${base} where q.wedding_id=$1 and q.id=$2`, [guest.weddingId,id])
  return view(saved!)
}

/** The caller holds the exclusive wedding lock and a current team session. */
export async function resolveTripChange(client: Queryable, weddingId: string, id: string, decision: ChangeDecision, actorId: string) {
  const { rows: [request] } = await client.query<ChangeRow>(`${base} where q.wedding_id=$1 and q.id=$2 for update of q`, [weddingId,id])
  if (!request) throw notFound('Запрос не найден')
  if (request.status === decision) return view(request)
  if (request.status !== 'pending') throw conflict('shuttle_request_resolved', 'Запрос уже закрыт')
  const resolved = await client.query<{ resolved_at: Date }>(`update shuttle_change_requests set status=$3,resolved_at=clock_timestamp(),resolved_by=$4
    where wedding_id=$1 and id=$2 returning resolved_at`, [weddingId,id,decision,actorId])
  if (decision === 'approved') {
    const selection = await lockTripSelection(client, { weddingId, partyId: request.party_id, guestId: request.guest_id },
      request.to_bus_id!, request.guest_id)
    if (selection.eventId !== request.program_event_id || !selection.missing
      || !selection.locked.some(route => route.id === request.from_bus_id)) {
      throw conflict('shuttle_seat_changed', 'Исходное место или рейс изменились. Обновите список запросов.')
    }
    await assignTrip(client, selection)
  }
  return view({ ...request, status: decision, resolved_at: resolved.rows[0]!.resolved_at })
}
