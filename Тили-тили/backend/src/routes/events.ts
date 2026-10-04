import { runEnrolledFanout } from '../notify/enrolled.js'
import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { knownTimeZone } from '../notify/quiet.js'
import { assertRealDate, assertWeddingDate } from '../wedding/dates.js'
import { rescheduleWedding } from '../wedding/reschedule.js'
import { expectedTimelineVersion, lockTimeline, lockTimelineForRequest, sendTimelineVersion, setTimelineActor } from '../timeline/version.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'
import { applyOrganizerCorrection, decideRequest, loadCoupleRoster } from '../wedding/rsvp-events.js'

interface EventRow {
  id: string; name: string; kind: string; date: string | null; time_zone: string | null; location: string | null; is_main: boolean
  rsvp_deadline: string | null
}
type EventPatch = { name?: string; kind?: string; date?: string | null; timeZone?: string | null; location?: string | null; rsvpDeadline?: string | null }
const columns = 'id,name,kind,date::text,time_zone,location,is_main,rsvp_deadline::text'
const project = (r: EventRow) => ({ id: r.id, name: r.name, kind: r.kind, date: r.date,
  timeZone: r.time_zone, location: r.location, isMain: r.is_main, rsvpDeadline: r.rsvp_deadline })
const properties = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  kind: { type: 'string', enum: ['registration', 'nikah', 'ceremony', 'banquet', 'second_day', 'other'] },
  date: { type: 'string', nullable: true, format: 'date' },
  timeZone: { type: 'string', nullable: true, minLength: 1, maxLength: 100 },
  location: { type: 'string', nullable: true, maxLength: 300 },
}
// T012: срок ответа задаётся только правкой существующего мероприятия — не при создании.
const patchProperties = { ...properties, rsvpDeadline: { type: 'string', format: 'date', nullable: true } }
function validate(p: EventPatch): void {
  if (p.name !== undefined && !p.name.trim()) throw validationFailed({ name: 'нужно название мероприятия' })
  if (p.date) assertWeddingDate(p.date)
  if (p.timeZone !== undefined && p.timeZone !== null && knownTimeZone(p.timeZone) !== p.timeZone) {
    throw validationFailed({ timeZone: 'неизвестный часовой пояс' })
  }
  if (p.rsvpDeadline) assertRealDate(p.rsvpDeadline, 'rsvpDeadline')
}
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  async function event(db: Queryable, weddingId: string, id: string): Promise<EventRow> {
    const result = await db.query<EventRow>(`select ${columns} from wedding_events where wedding_id=$1 and id=$2`, [weddingId, id])
    if (!result.rows[0]) throw notFound('Мероприятие не найдено')
    return result.rows[0]
  }
  async function checkTimeZone(db: Queryable, patch: EventPatch): Promise<void> {
    if (patch.timeZone !== undefined && patch.timeZone !== null
      && (await db.query('select 1 from pg_timezone_names where name=$1', [patch.timeZone])).rowCount === 0) {
      throw validationFailed({ timeZone: 'часовой пояс не поддерживается базой' })
    }
  }
  async function roster(client: Queryable, weddingId: string, eventId: string) {
    const selected = await event(client, weddingId, eventId)
    const people = await client.query<{ id: string; name: string; invited: boolean }>(
      `select g.id,g.name,($3 or i.guest_id is not null) as invited from guests g
        left join guest_event_invitations i on i.wedding_id=g.wedding_id and i.guest_id=g.id and i.event_id=$2
        where g.wedding_id=$1 order by g.name,g.id`, [weddingId, eventId, selected.is_main])
    return { event: project(selected), people: people.rows.map(p => ({ guestId: p.id, name: p.name, invited: p.invited })) }
  }
  const rosterParams = { type: 'object', required: ['weddingId', 'eventId'], properties: { weddingId: UUID_ID, eventId: UUID_ID } }
  app.get('/weddings/:weddingId/events/:eventId/invitations', { schema: { params: rosterParams } }, async (request, reply) => db().tx(async client => {
    await lockGuestReadAccess(client, request)
    const weddingId = request.member!.weddingId, eventId = (request.params as { eventId: string }).eventId
    const snapshot = await lockTimeline(client, weddingId, false)
    const result = await roster(client, weddingId, eventId)
    await assertSeatingToken(request)
    sendTimelineVersion(reply, snapshot)
    return result
  }))
  app.put('/weddings/:weddingId/events/:eventId/invitations', { schema: {
    params: rosterParams,
    body: { type: 'object', required: ['guestIds'], additionalProperties: false, properties: {
      guestIds: { type: 'array', maxItems: 5000, uniqueItems: true, items: UUID_ID },
    } },
  } }, async (request, reply) => {
    const expected = expectedTimelineVersion(request.headers['if-match'])
    const { guestIds } = request.body as { guestIds: string[] }
    return db().tx(async client => {
      await lockSeatingAccess(client, request)
      const weddingId = request.member!.weddingId, eventId = (request.params as { eventId: string }).eventId
      const snapshot = await lockTimeline(client, weddingId, true)
      if (snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — обновите её')
      const before = await event(client, weddingId, eventId)
      if (before.is_main) throw validationFailed({ eventId: 'состав основной программы задаётся списком гостей' })
      const people = await client.query('select id from guests where wedding_id=$1 and id=any($2::uuid[]) for share', [weddingId, guestIds])
      if (people.rowCount !== guestIds.length) throw notFound('Человек не найден в этой свадьбе')
      await setTimelineActor(client, request.caller!.userId)
      await client.query('delete from guest_event_invitations where wedding_id=$1 and event_id=$2 and not(guest_id=any($3::uuid[]))', [weddingId, eventId, guestIds])
      await client.query(`insert into guest_event_invitations(wedding_id,event_id,guest_id)
        select $1,$2,id from unnest($3::uuid[]) id on conflict do nothing`, [weddingId, eventId, guestIds])
      const result = await roster(client, weddingId, eventId)
      await assertSeatingToken(request)
      sendTimelineVersion(reply, await lockTimeline(client, weddingId, true))
      return result
    })
  })
  app.get('/weddings/:weddingId/events', async (request, reply) => db().tx(async client => {
    const snapshot = await lockTimelineForRequest(client, request, false)
    const result = await client.query<EventRow>(`select ${columns} from wedding_events where wedding_id=$1 order by is_main desc,date nulls last,id`, [request.member!.weddingId])
    sendTimelineVersion(reply, snapshot)
    return result.rows.map(project)
  }))
  app.post('/weddings/:weddingId/events', { schema: { body: {
    type: 'object', required: ['name', 'kind'], additionalProperties: false, properties,
  } } }, async (request, reply) => {
    const patch = request.body as EventPatch
    validate(patch)
    const expected = expectedTimelineVersion(request.headers['if-match'])
    const result = await db().tx(async client => {
      const weddingId = request.member!.weddingId
      const snapshot = await lockTimelineForRequest(client, request, true)
      if (snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — обновите её')
      await checkTimeZone(client, patch)
      if ((await client.query<{ n: number }>('select count(*)::int n from wedding_events where wedding_id=$1', [weddingId])).rows[0]!.n >= 50) {
        throw validationFailed({ events: 'технический предел — 50 мероприятий на свадьбу' })
      }
      await setTimelineActor(client, request.caller!.userId)
      const id = uuidv7()
      await client.query('insert into wedding_events(id,wedding_id,name,kind,date,time_zone,location) values($1,$2,$3,$4,$5,$6,$7)',
        [id, weddingId, patch.name!.trim(), patch.kind, patch.date ?? null, patch.timeZone ?? null, patch.location ?? null])
      sendTimelineVersion(reply, await lockTimeline(client, weddingId, true))
      return project(await event(client, weddingId, id))
    })
    return reply.code(201).send(result)
  })
  app.patch('/weddings/:weddingId/events/:eventId', { schema: {
    params: { type: 'object', required: ['weddingId', 'eventId'], properties: { weddingId: UUID_ID, eventId: UUID_ID } },
    body: { type: 'object', minProperties: 1, additionalProperties: false, properties: patchProperties },
  } }, async (request, reply) => {
    const patch = request.body as EventPatch
    validate(patch)
    const expected = expectedTimelineVersion(request.headers['if-match'])
    return db().tx(async client => runEnrolledFanout(client, { owner: 'events.patch', weddingId: request.member!.weddingId, actorId: request.caller!.userId, request, afterReceipt: false }, async (emissions) => {
      const weddingId = request.member!.weddingId, id = (request.params as { eventId: string }).eventId
      const snapshot = await lockTimelineForRequest(client, request, true)
      if (snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — обновите её')
      const before = await event(client, weddingId, id)
      await checkTimeZone(client, patch)
      /* T012: срок — только у дополнительного мероприятия с известным поясом
       * и не позже его даты. Эффективные значения — с учётом этого патча, ещё
       * до записи: DB CHECK (is_main/time_zone) — тот же инвариант задним
       * числом, сравнение с датой — только здесь (в CHECK не выражено).
       * Перепроверяем, если патч трогает ЛЮБОЕ из трёх полей: снятие одного
       * только пояса при уже заданном сроке — тоже нарушение (не только явная
       * правка самого rsvpDeadline). */
      if (patch.rsvpDeadline !== undefined || patch.timeZone !== undefined || patch.date !== undefined) {
        const effectiveDeadline = patch.rsvpDeadline !== undefined ? patch.rsvpDeadline : before.rsvp_deadline
        const effectiveTimeZone = patch.timeZone !== undefined ? patch.timeZone : before.time_zone
        const effectiveDate = patch.date !== undefined ? patch.date : before.date
        if (effectiveDeadline !== null) {
          if (before.is_main) throw validationFailed({ rsvpDeadline: 'у основной программы срока ответа нет' })
          if (!effectiveTimeZone) throw validationFailed({ rsvpDeadline: 'нужен известный часовой пояс мероприятия' })
          if (effectiveDate !== null && effectiveDeadline > effectiveDate) throw validationFailed({ rsvpDeadline: 'срок не может быть позже даты мероприятия' })
        }
      }
      await setTimelineActor(client, request.caller!.userId)
      if (before.is_main) {
        if (patch.date === null && before.date !== null) throw validationFailed({ date: 'назначенную основную дату нельзя снять; используйте перенос' })
        if (patch.date !== undefined && patch.date !== null) await rescheduleWedding(client, weddingId, patch.date, request.caller!.userId, emissions)
        if (patch.timeZone !== undefined) await client.query('update weddings set tz=$2 where id=$1', [weddingId, patch.timeZone])
        if (patch.location !== undefined) await client.query('update weddings set venue=$2 where id=$1', [weddingId, patch.location])
      }
      const current = await event(client, weddingId, id)
      await client.query('update wedding_events set name=$3,kind=$4,date=$5,time_zone=$6,location=$7,rsvp_deadline=$8 where wedding_id=$1 and id=$2',
        [weddingId, id, patch.name?.trim() ?? current.name, patch.kind ?? current.kind,
          before.is_main || patch.date === undefined ? current.date : patch.date,
          before.is_main || patch.timeZone === undefined ? current.time_zone : patch.timeZone,
          before.is_main || patch.location === undefined ? current.location : patch.location,
          patch.rsvpDeadline !== undefined ? patch.rsvpDeadline : current.rsvp_deadline])
      sendTimelineVersion(reply, await lockTimeline(client, weddingId, true))
      return project(await event(client, weddingId, id))
    }))
  })
  app.delete('/weddings/:weddingId/events/:eventId', { schema: {
    params: { type: 'object', required: ['weddingId', 'eventId'], properties: { weddingId: UUID_ID, eventId: UUID_ID } },
  } }, async (request, reply) => {
    const expected = expectedTimelineVersion(request.headers['if-match'])
    await db().tx(async client => {
      const weddingId = request.member!.weddingId, id = (request.params as { eventId: string }).eventId
      const snapshot = await lockTimelineForRequest(client, request, true)
      if (snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — обновите её')
      const selected = await event(client, weddingId, id)
      const dependencies = await client.query(`select 1 where
        exists(select 1 from timeline_events where wedding_id=$1 and program_event_id=$2)
        or exists(select 1 from slots where wedding_id=$1 and program_event_id=$2)
        or exists(select 1 from order_assignments where wedding_id=$1 and program_event_id=$2)
        or exists(select 1 from guest_event_invitations where wedding_id=$1 and event_id=$2)
        or exists(select 1 from event_rsvp_requests where wedding_id=$1 and program_event_id=$2)`, [weddingId, id])
      if (selected.is_main || dependencies.rowCount) {
        throw conflict('event_in_use', 'Мероприятие используется программой, приглашениями, позициями услуг или историей заказов; основное мероприятие не удаляется')
      }
      await setTimelineActor(client, request.caller!.userId)
      await client.query('delete from wedding_events where wedding_id=$1 and id=$2', [weddingId, id])
      sendTimelineVersion(reply, await lockTimeline(client, weddingId, true))
    })
    return reply.code(204).send()
  })

  /* ── T012: срок, ростер и просьбы дополнительного мероприятия (пара/команда) ── */
  app.get('/weddings/:weddingId/events/:eventId/rsvp', { schema: {
    params: { type: 'object', required: ['weddingId', 'eventId'], properties: { weddingId: UUID_ID, eventId: UUID_ID } },
  } }, async (request) => {
    const eventId = (request.params as { eventId: string }).eventId
    return db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const roster = await loadCoupleRoster(client, request.member!.weddingId, eventId)
      await assertSeatingToken(request)
      return roster
    })
  })

  app.put('/weddings/:weddingId/events/:eventId/rsvp/:guestId', { schema: {
    params: { type: 'object', required: ['weddingId', 'eventId', 'guestId'], properties: { weddingId: UUID_ID, eventId: UUID_ID, guestId: UUID_ID } },
    body: { type: 'object', required: ['status', 'expectedVersion'], additionalProperties: false, properties: {
      status: { type: 'string', enum: ['unknown', 'attending', 'declined'] },
      expectedVersion: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' },
    } },
  } }, async (request) => {
    const { eventId, guestId } = request.params as { eventId: string; guestId: string }
    const body = request.body as { status: 'unknown' | 'attending' | 'declined'; expectedVersion: string }
    return db().tx(async client => {
      await lockSeatingAccess(client, request)
      const person = await applyOrganizerCorrection(client, {
        weddingId: request.member!.weddingId, eventId, guestId, status: body.status,
        expectedVersion: body.expectedVersion, actorUserId: request.caller!.userId,
      })
      await assertSeatingToken(request)
      return person
    })
  })

  app.post('/weddings/:weddingId/events/:eventId/rsvp-requests/:requestId/decision', { schema: {
    params: { type: 'object', required: ['weddingId', 'eventId', 'requestId'], properties: { weddingId: UUID_ID, eventId: UUID_ID, requestId: UUID_ID } },
    body: { type: 'object', required: ['decision', 'expectedVersion'], additionalProperties: false, properties: {
      decision: { type: 'string', enum: ['accept', 'reject'] },
      note: { type: 'string', maxLength: 500 },
      expectedVersion: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
    } },
  } }, async (request) => {
    const { eventId, requestId } = request.params as { eventId: string; requestId: string }
    const body = request.body as { decision: 'accept' | 'reject'; note?: string; expectedVersion: string }
    return db().tx(async client => {
      await lockSeatingAccess(client, request)
      const result = await decideRequest(client, {
        weddingId: request.member!.weddingId, eventId, requestId, decision: body.decision,
        note: body.note ?? null, expectedVersion: body.expectedVersion, actorUserId: request.caller!.userId,
      })
      await assertSeatingToken(request)
      return result
    })
  })
}
