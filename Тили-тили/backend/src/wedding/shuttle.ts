import { conflict, notFound, validationFailed } from '../errors.js'
import type { GuestCaller } from '../guests/access.js'
import { isCheckViolation, type Queryable } from '../plugins/db.js'
import { assertRealDate } from './dates.js'

export type TripDirection = 'outbound' | 'return'
export interface TripWrite {
  eventId?: string | null
  direction?: TripDirection
  departureDate?: string | null
  destination?: string | null
  stops?: string[]
  publicContact?: string | null
}

export const tripProperties = {
  eventId: { type: 'string', format: 'uuid', nullable: true },
  direction: { type: 'string', enum: ['outbound', 'return'] },
  departureDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', nullable: true },
  destination: { type: 'string', maxLength: 300, nullable: true },
  stops: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 200 } },
  publicContact: { type: 'string', maxLength: 160, nullable: true },
}

function cleanText(value: string | null | undefined, field: string): string | null {
  const text = value?.trim()
  if (text && [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw validationFailed({ [field]: 'Уберите управляющие символы' })
  }
  return text || null
}

export async function normalizeTrip(client: Queryable, weddingId: string, body: TripWrite) {
  let eventId = body.eventId
  if (eventId) {
    const { rows: [event] } = await client.query<{ id: string; is_main: boolean }>(
      'select id,is_main from wedding_events where wedding_id=$1 and id=$2 for share', [weddingId, eventId],
    )
    if (!event) throw validationFailed({ eventId: 'Выберите мероприятие этой свадьбы' })
    eventId = event.is_main ? null : event.id
  }
  if (body.departureDate) assertRealDate(body.departureDate, 'departureDate')
  const stops = body.stops?.map(value => {
    const stop = cleanText(value, 'stops')
    if (!stop) throw validationFailed({ stops: 'Укажите названия остановок' })
    return stop
  })
  return { eventId, direction: body.direction, departureDate: body.departureDate,
    destination: body.destination === undefined ? undefined : cleanText(body.destination, 'destination'),
    stops, publicContact: body.publicContact === undefined ? undefined : cleanText(body.publicContact, 'publicContact') }
}

const invitedToTrip = `(r.program_event_id is null or exists (
  select 1 from guest_event_invitations i where i.wedding_id=g.wedding_id
    and i.event_id=r.program_event_id and i.guest_id=g.id
))`

export async function shuttleMembers(client: Queryable, guest: GuestCaller, includeTrips: boolean) {
  const { rows } = await client.query<{ id: string; name: string; eligible: string[]; booked: string[]; legacy: string | null }>(
    `select g.id,g.name,
        coalesce(array_agg(r.id order by r.id) filter (where r.id is not null),'{}') as eligible,
        coalesce(array_agg(r.id order by r.id) filter (where b.bus_id is not null),'{}') as booked,
        (array_agg(r.id order by r.id) filter (where b.bus_id is not null and r.program_event_id is null
          and r.direction='outbound'))[1] as legacy
      from guests g
      left join bus_routes r on r.wedding_id=g.wedding_id and ${invitedToTrip}
        and ($3 or (r.program_event_id is null and r.direction='outbound'))
      left join bus_bookings b on b.bus_id=r.id and b.guest_id=g.id
      where g.wedding_id=$1 and g.party_id=$2
      group by g.id order by g.party_position,g.created_at,g.id`, [guest.weddingId, guest.partyId, includeTrips],
  )
  return rows
}

export async function teamTripPassengers(client: Queryable, weddingId: string) {
  const { rows } = await client.query<{ bus_id: string; guest_id: string; name: string }>(
    `select b.bus_id,b.guest_id,g.name from bus_routes r join bus_bookings b on b.bus_id=r.id
      join guests g on g.id=b.guest_id and g.wedding_id=r.wedding_id
      where r.wedding_id=$1 order by g.name,g.id`, [weddingId],
  )
  const passengers = new Map<string, { guestId: string; name: string }[]>()
  for (const row of rows) {
    const group = passengers.get(row.bus_id) ?? []
    group.push({ guestId: row.guest_id, name: row.name })
    passengers.set(row.bus_id, group)
  }
  return passengers
}

/** The caller pins the wedding and invitation and takes the primary guest write lock first. */
export async function bookTrip(client: Queryable, guest: GuestCaller, busId: string, guestId?: string) {
  const { rows: [target] } = await client.query<{ program_event_id: string | null; direction: TripDirection }>(
    'select program_event_id,direction from bus_routes where id=$1 and wedding_id=$2', [busId, guest.weddingId],
  )
  if (!target || (!guestId && (target.program_event_id || target.direction !== 'outbound'))) {
    throw notFound('Маршрут не найден')
  }
  const { rows: selected } = await client.query<{ id: string }>(
    `select g.id from guests g join bus_routes r on r.id=$1 and r.wedding_id=g.wedding_id
      where g.wedding_id=$2 and g.party_id=$3 and ($4::uuid is null or g.id=$4) and ${invitedToTrip}
      order by g.id for update of g`, [busId, guest.weddingId, guest.partyId, guestId ?? null],
  )
  if (!selected.length) throw notFound('Маршрут или пассажир недоступен для этого приглашения')
  const memberIds = selected.map(row => row.id)
  const scope = [guest.weddingId, target.program_event_id, target.direction, busId, memberIds]

  const { rows: locked } = await client.query<{ id: string; taken: number; seats: number }>(
    `select r.id,r.taken,r.seats from bus_routes r
      where r.wedding_id=$1 and r.program_event_id is not distinct from $2::uuid and r.direction=$3
        and (r.id=$4 or exists(select 1 from bus_bookings b where b.bus_id=r.id and b.guest_id=any($5::uuid[])))
      order by r.id for update`, scope,
  )
  const destination = locked.find(route => route.id === busId.toLowerCase())
  if (!destination) throw notFound('Маршрут не найден')
  const { rows: [count] } = await client.query<{ n: number }>(
    'select count(*)::int as n from bus_bookings where bus_id=$1 and guest_id=any($2::uuid[])', [busId, memberIds],
  )
  const missing = memberIds.length - count!.n
  const full = () => conflict('bus_full', 'Мест в этом автобусе не осталось')
  if (destination.taken + missing > destination.seats) throw full()

  await client.query(`delete from bus_bookings b using bus_routes r
    where b.bus_id=r.id and r.wedding_id=$1 and r.program_event_id is not distinct from $2::uuid
      and r.direction=$3 and r.id<>$4 and b.guest_id=any($5::uuid[])`, scope)
  let booked
  try {
    booked = await client.query(`insert into bus_bookings(bus_id,guest_id)
      select $1,id from unnest($2::uuid[]) as x(id) on conflict do nothing`, [busId, memberIds])
  } catch (error) {
    if (isCheckViolation(error, 'bus_taken_bounded')) throw full()
    throw error
  }
  if (!target.program_event_id) {
    await client.query("update guests set transfer='need' where id=any($1::uuid[])", [memberIds])
  }
  return { guestId: guestId ?? guest.guestId, guestIds: memberIds, busId,
    alreadyBooked: booked.rowCount === 0, taken: destination.taken + missing, seats: destination.seats }
}
