import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import type { GuestCaller } from '../guests/access.js'
import { UUID_ID } from '../ids.js'
import { isCheckViolation, isUniqueViolation, type Queryable } from '../plugins/db.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'
import { assertRealDate } from '../wedding/dates.js'
import { listWeddingMemberOptions, lockAssignableWeddingMember } from '../wedding/member-options.js'

const base = '/weddings/:weddingId/logistics/lodging'
const version = { type: 'integer', minimum: 0, maximum: 2_147_483_646 }
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const sources = ['organizer', 'guest', 'hotel'] as const
const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', properties, required, additionalProperties: false })

interface RoomDraft { version: number; hotelId: string; label: string; capacity: number; legacyPartyId?: string }
interface PlacementDraft {
  version: number; roomId: string; guestId: string; checkIn: string; checkOut: string
  responsibleId: string | null; source: typeof sources[number]
}

export const isHotelInventoryFull = (error: unknown): boolean =>
  isCheckViolation(error, 'hotel_booked_bounded') || isCheckViolation(error, 'hotel_inventory_bounded')

export const hotelInventoryFull = () => conflict('hotel_full', 'Свободных номеров в этом блоке не осталось')

function lodgingError(error: unknown): never {
  if (isHotelInventoryFull(error)) throw hotelInventoryFull()
  if (isCheckViolation(error, 'lodging_room_capacity')) throw conflict('lodging_room_full', 'На эти даты в номере не хватает мест')
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    if (error.constraint === 'lodging_guest_no_overlap' && 'code' in error && error.code === '23P01') {
      throw conflict('lodging_guest_overlap', 'Гость уже размещён на пересекающиеся даты')
    }
    if (isUniqueViolation(error) && error.constraint === 'lodging_room_label_unique') {
      throw conflict('lodging_room_label_taken', 'В этом отеле уже есть номер с таким названием')
    }
    if (isUniqueViolation(error) && error.constraint === 'lodging_room_legacy_unique') {
      throw conflict('lodging_request_linked', 'Эта семейная заявка уже связана с номером')
    }
  }
  throw error
}

const stale = () => conflict('lodging_stale', 'Данные изменились. Обновите список и повторите действие')
const currentStay = "(now() at time zone coalesce(w.tz,'Europe/Moscow'))::date < p.check_out"

export async function familyHasLodging(db: Queryable, guest: GuestCaller, currentOnly = false): Promise<boolean> {
  const { rows } = await db.query(`select 1 from lodging_placements p
    join guests g on g.wedding_id=p.wedding_id and g.id=p.guest_id
    join weddings w on w.id=p.wedding_id
    where p.wedding_id=$1 and g.party_id=$2 and (not $3::boolean or ${currentStay}) limit 1`, [guest.weddingId, guest.partyId, currentOnly])
  return rows.length > 0
}

export async function guestLodging(db: Queryable, guest: GuestCaller) {
  const { rows } = await db.query<{ hotelId: string; id: string; guestName: string; roomLabel: string; checkIn: string
    checkOut: string; responsibleName: string | null; source: string; current: boolean }>(`
    select r.hotel_id as "hotelId",p.id,g.name as "guestName",r.label as "roomLabel",
           p.check_in::text as "checkIn",p.check_out::text as "checkOut",
           u.name as "responsibleName",p.source,(${currentStay}) as current
      from lodging_placements p
      join guests g on g.wedding_id=p.wedding_id and g.id=p.guest_id
      join lodging_rooms r on r.wedding_id=p.wedding_id and r.id=p.room_id
      join weddings w on w.id=p.wedding_id
      left join users u on u.id=p.responsible_id and u.deleted_at is null
     where p.wedding_id=$1 and g.party_id=$2
     order by p.check_in,g.party_position,p.id`, [guest.weddingId, guest.partyId])
  return rows
}

export async function lodgingRoutes(app: FastifyInstance): Promise<void> {
  const params = object({ weddingId: UUID_ID, id: UUID_ID }, ['weddingId', 'id'])
  const querystring = object({ version: { ...version, minimum: 1 } }, ['version'])
  const withAccess = <T>(request: FastifyRequest, write: boolean, action: (client: Queryable, weddingId: string) => Promise<T>) => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db.tx(async client => {
      await (write ? lockSeatingAccess : lockGuestReadAccess)(client, request)
      await assertSeatingToken(request)
      return action(client, request.member!.weddingId)
    })
  }

  app.get(base, request => withAccess(request, false, async (client, weddingId) => {
    const hotels = await client.query(`select id,name,rooms,lodging_inventory_used(id) as used
      from hotel_blocks where wedding_id=$1 order by name,id`, [weddingId])
    const rooms = await client.query(`select r.id,r.hotel_id as "hotelId",r.label,r.capacity,r.version,b.party_id as "legacyPartyId"
      from lodging_rooms r left join hotel_bookings b on b.hotel_id=r.hotel_id and b.guest_id=r.legacy_guest_id
      where r.wedding_id=$1 order by r.hotel_id,r.label,r.id`, [weddingId])
    const guests = await client.query(`select id,name as label from guests where wedding_id=$1 order by name,id`, [weddingId])
    const requests = await client.query(`select b.hotel_id as "hotelId",b.party_id as "partyId",g.name as label
      from hotel_bookings b join hotel_blocks h on h.id=b.hotel_id
      join guests g on g.id=b.guest_id and g.wedding_id=h.wedding_id
      where h.wedding_id=$1 and b.party_id is not null and not exists (
        select from lodging_rooms r where r.hotel_id=b.hotel_id and r.legacy_guest_id=b.guest_id)
      order by g.name,b.party_id`, [weddingId])
    const placements = await client.query(`select p.id,p.room_id as "roomId",p.guest_id as "guestId",g.name as "guestName",
        p.check_in::text as "checkIn",p.check_out::text as "checkOut",
        case when u.deleted_at is null then p.responsible_id end as "responsibleId",p.source,p.version
      from lodging_placements p join guests g on g.wedding_id=p.wedding_id and g.id=p.guest_id
      left join users u on u.id=p.responsible_id
      where p.wedding_id=$1 order by p.check_in,g.name,p.id`, [weddingId])
    return { hotels: hotels.rows, rooms: rooms.rows, guests: guests.rows, requests: requests.rows,
      placements: placements.rows, team: await listWeddingMemberOptions(client, weddingId) }
  }))

  app.put(base + '/rooms/:id', { schema: { params, body: object({
    version, hotelId: UUID_ID, label: { type: 'string', minLength: 1, maxLength: 120 },
    capacity: { type: 'integer', minimum: 1, maximum: 500 }, legacyPartyId: UUID_ID,
  }, ['version', 'hotelId', 'label', 'capacity']) } }, request => withAccess(request, true, async (client, weddingId) => {
    const { id } = request.params as { id: string }
    const draft = request.body as RoomDraft
    const label = draft.label.trim()
    if (!label) throw validationFailed({ label: 'Укажите номер или название комнаты' })
    try {
      if (draft.version === 0) {
        const block = await client.query('select id from hotel_blocks where wedding_id=$1 and id=$2', [weddingId, draft.hotelId])
        if (!block.rowCount) throw notFound('Блок не найден')
        const booking = draft.legacyPartyId ? (await client.query<{ guest_id: string }>(
          'select guest_id from hotel_bookings where hotel_id=$1 and party_id=$2', [draft.hotelId, draft.legacyPartyId],
        )).rows[0] : undefined
        if (draft.legacyPartyId && !booking) throw notFound('Семейная заявка не найдена')
        const { rows } = await client.query<{ version: number }>(`
          insert into lodging_rooms(wedding_id,id,hotel_id,label,capacity,legacy_guest_id)
          values($1,$2,$3,$4,$5,$6) on conflict (wedding_id,id) do nothing returning version`,
        [weddingId, id, draft.hotelId, label, draft.capacity, booking?.guest_id ?? null])
        if (!rows[0]) throw stale()
        return { id, version: rows[0].version }
      }
      if (draft.legacyPartyId) throw validationFailed({ legacyPartyId: 'Заявку можно связать при добавлении номера' })
      const { rows } = await client.query<{ version: number }>(`
        update lodging_rooms set label=$4,capacity=$5,version=version+1
        where wedding_id=$1 and id=$2 and version=$3 and hotel_id=$6 returning version`,
      [weddingId, id, draft.version, label, draft.capacity, draft.hotelId])
      if (!rows[0]) throw stale()
      return { id, version: rows[0].version }
    } catch (error) { lodgingError(error) }
  }))

  app.delete(base + '/rooms/:id', { schema: { params, querystring } }, async (request, reply) => {
    await withAccess(request, true, async (client, weddingId) => {
      const { id } = request.params as { id: string }
      const { version } = request.query as { version: number }
      const room = await client.query('select id from lodging_rooms where wedding_id=$1 and id=$2 and version=$3',
        [weddingId, id, version])
      if (!room.rowCount) throw stale()
      const placement = await client.query('select 1 from lodging_placements where wedding_id=$1 and room_id=$2 limit 1',
        [weddingId, id])
      if (placement.rowCount) throw conflict('lodging_room_in_use', 'Сначала перенесите или уберите размещение гостей')
      await client.query('delete from lodging_rooms where wedding_id=$1 and id=$2', [weddingId, id])
    })
    return reply.code(204).send()
  })

  app.put(base + '/placements/:id', { schema: { params, body: object({
    version, roomId: UUID_ID, guestId: UUID_ID, checkIn: date, checkOut: date,
    responsibleId: { anyOf: [UUID_ID, { type: 'null' }] }, source: { type: 'string', enum: sources },
  }, ['version', 'roomId', 'guestId', 'checkIn', 'checkOut', 'responsibleId', 'source']) } }, request => withAccess(request, true, async (client, weddingId) => {
    const { id } = request.params as { id: string }
    const draft = request.body as PlacementDraft
    assertRealDate(draft.checkIn, 'checkIn')
    assertRealDate(draft.checkOut, 'checkOut')
    if (draft.checkIn >= draft.checkOut) throw validationFailed({ checkOut: 'Выезд должен быть позже заезда' })
    const { rows: guests } = await client.query<{ party_id: string }>('select party_id from guests where wedding_id=$1 and id=$2',
      [weddingId, draft.guestId])
    if (!guests[0]) throw notFound('Гость не найден')
    const { rows: rooms } = await client.query<{ party_id: string | null }>(`select b.party_id from lodging_rooms r
      left join hotel_bookings b on b.hotel_id=r.hotel_id and b.guest_id=r.legacy_guest_id
      where r.wedding_id=$1 and r.id=$2`, [weddingId, draft.roomId])
    if (!rooms[0]) throw notFound('Номер не найден')
    if (rooms[0].party_id && rooms[0].party_id !== guests[0].party_id) {
      throw conflict('lodging_room_family', 'Этот номер связан с заявкой другой семьи')
    }
    if (draft.responsibleId && !await lockAssignableWeddingMember(client, weddingId, draft.responsibleId)) {
      throw validationFailed({ responsibleId: 'Выберите участника команды' })
    }
    const values = [weddingId, id, draft.roomId, draft.guestId, draft.checkIn, draft.checkOut, draft.responsibleId, draft.source]
    try {
      const { rows } = draft.version === 0
        ? await client.query<{ version: number }>(`insert into lodging_placements
            (wedding_id,id,room_id,guest_id,check_in,check_out,responsible_id,source)
            values($1,$2,$3,$4,$5,$6,$7,$8) on conflict (wedding_id,id) do nothing returning version`, values)
        : await client.query<{ version: number }>(`update lodging_placements set
            room_id=$3,guest_id=$4,check_in=$5,check_out=$6,responsible_id=$7,source=$8,version=version+1
            where wedding_id=$1 and id=$2 and version=$9 returning version`, [...values, draft.version])
      if (!rows[0]) throw stale()
      return { id, version: rows[0].version }
    } catch (error) { lodgingError(error) }
  }))

  app.delete(base + '/placements/:id', { schema: { params, querystring } }, async (request, reply) => {
    await withAccess(request, true, async (client, weddingId) => {
      const { id } = request.params as { id: string }
      const { version } = request.query as { version: number }
      const deleted = await client.query('delete from lodging_placements where wedding_id=$1 and id=$2 and version=$3',
        [weddingId, id, version])
      if (!deleted.rowCount) throw stale()
    })
    return reply.code(204).send()
  })
}
