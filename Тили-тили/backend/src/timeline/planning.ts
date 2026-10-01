import type { Queryable } from '../plugins/db.js'
import { validationFailed } from '../errors.js'
import { UUID_ID } from '../ids.js'

export interface TimelineReference { kind: 'member' | 'guest' | 'deal'; id: string }
export interface TimelinePlanning {
  eventId?: string
  durationMinutes: number | null
  fixed: boolean
  travelMinutes: number
  bufferMinutes: number
  dependsOn: string[]
  responsible: TimelineReference | null
  participants: TimelineReference[]
}
export const planningProperties = {
  eventId: UUID_ID,
  durationMinutes: { type: 'number', nullable: true, minimum: 0, maximum: 10080 },
  fixed: { type: 'boolean' },
  travelMinutes: { type: 'number', minimum: 0, maximum: 10080 },
  bufferMinutes: { type: 'number', minimum: 0, maximum: 10080 },
  dependsOn: { type: 'array', maxItems: 60, items: UUID_ID },
  responsible: {
    type: 'object', nullable: true, required: ['kind', 'id'], additionalProperties: false,
    properties: { kind: { type: 'string', enum: ['member', 'guest', 'deal'] }, id: UUID_ID },
  },
  participants: {
    type: 'array', maxItems: 200,
    items: { type: 'object', required: ['kind', 'id'], additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['member', 'guest', 'deal'] }, id: UUID_ID } },
  },
}
const empty = (): TimelinePlanning => ({ durationMinutes: null, fixed: false, travelMinutes: 0,
  bufferMinutes: 0, dependsOn: [], responsible: null, participants: [] })

/** Team-only projection. Guest links must not receive internal identities. */
export async function readTimelinePlanning(db: Queryable, weddingId: string): Promise<Map<string, TimelinePlanning>> {
  const { rows } = await db.query<{
    id: string; program_event_id: string; duration_minutes: number | null; fixed: boolean; travel_minutes: number; buffer_minutes: number
  }>('select id,program_event_id,duration_minutes,fixed,travel_minutes,buffer_minutes from timeline_events where wedding_id=$1', [weddingId])
  const result = new Map(rows.map(r => [r.id, { ...empty(), eventId: r.program_event_id, durationMinutes: r.duration_minutes,
    fixed: r.fixed, travelMinutes: r.travel_minutes, bufferMinutes: r.buffer_minutes }]))
  const { rows: dependencies } = await db.query<{ event_id: string; depends_on: string }>(
    'select event_id,depends_on from timeline_dependencies where wedding_id=$1 order by event_id,depends_on', [weddingId])
  for (const r of dependencies) result.get(r.event_id)!.dependsOn.push(r.depends_on)
  const { rows: assignments } = await db.query<{
    event_id: string; role: string; kind: TimelineReference['kind']; reference_id: string
  }>('select event_id,role,kind,reference_id from timeline_assignments where wedding_id=$1 order by event_id,kind,reference_id', [weddingId])
  for (const r of assignments) {
    const event = result.get(r.event_id)!
    const reference = { kind: r.kind, id: r.reference_id }
    if (r.role === 'responsible') event.responsible = reference
    else event.participants.push(reference)
  }
  return result
}

export async function prepareTimelinePlanning(
  db: Queryable, weddingId: string, events: (Partial<TimelinePlanning> & { id?: string })[], ids: string[],
  moments: { startsAt: string | null; endsAt: string | null }[],
): Promise<TimelinePlanning[]> {
  const old = await readTimelinePlanning(db, weddingId)
  const contexts = await db.query<{ id: string; is_main: boolean }>('select id,is_main from wedding_events where wedding_id=$1 order by id for share', [weddingId])
  const ownEvents = new Set(contexts.rows.map(r => r.id))
  const main = contexts.rows.find(r => r.is_main)!.id
  const remaining = new Set(ids)
  const plans = events.map((e, i) => {
    const previous = old.get(ids[i]!) ?? empty()
    const p: TimelinePlanning = { ...previous, ...e,
      eventId: (e.eventId ?? previous.eventId ?? main).toLowerCase(),
      dependsOn: (e.dependsOn ?? previous.dependsOn).map(id => id.toLowerCase()),
      responsible: e.responsible === undefined ? previous.responsible : e.responsible,
      participants: e.participants ?? previous.participants,
    }
    p.responsible = p.responsible ? { ...p.responsible, id: p.responsible.id.toLowerCase() } : null
    p.participants = p.participants.map(r => ({ ...r, id: r.id.toLowerCase() }))
    const bad = (field: string, message: string): never => { throw validationFailed({ [`${i}.${field}`]: message }) }
    if (!ownEvents.has(p.eventId!)) bad('eventId', 'мероприятие недоступно в этой свадьбе')
    if (new Set(p.dependsOn).size !== p.dependsOn.length || p.dependsOn.some(id => id === ids[i] || !remaining.has(id))) {
      bad('dependsOn', 'зависимости должны быть уникальными другими блоками сохранённой программы')
    }
    if (new Set(p.participants.map(r => `${r.kind}:${r.id}`)).size !== p.participants.length) {
      bad('participants', 'участники не должны повторяться')
    }
    const m = moments[i]!
    if (p.fixed && !m.startsAt) bad('fixed', 'фиксированному блоку нужно время начала')
    if (!m.startsAt) {
      if (m.endsAt) bad('endsAt', 'окончание требует времени начала')
    } else {
      const start = Date.parse(m.startsAt)
      if (m.endsAt) {
        const actual = (Date.parse(m.endsAt) - start) / 60_000
        if (actual < 0 || actual > 10080) bad('endsAt', 'длительность должна быть от 0 до 10080 минут')
        // An omitted duration follows explicitly supplied endpoints; explicit null clears the manual value.
        if (e.durationMinutes === undefined) p.durationMinutes = actual
        else if (p.durationMinutes !== null && Math.abs(actual - p.durationMinutes) * 60_000 > 1) {
          bad('durationMinutes', 'длительность не совпадает с началом и окончанием')
        }
      } else if (p.durationMinutes !== null) {
        m.endsAt = new Date(start + p.durationMinutes * 60_000).toISOString()
      }
    }
    return p
  })
  const byId = new Map(ids.map((id, i) => [id, plans[i]!]))
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw validationFailed({ dependsOn: 'зависимости программы образуют цикл' })
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)

  const references = new Map<string, TimelineReference>()
  for (const p of plans) for (const r of [...p.participants, ...(p.responsible ? [p.responsible] : [])]) {
    references.set(`${r.kind}:${r.id}`, r)
  }
  for (const r of [...references.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
    let found: boolean
    if (r.kind === 'member') {
      const result = await db.query(`select u.id from users u join wedding_members m on m.user_id=u.id
        where u.id=$1 and m.wedding_id=$2 and u.deleted_at is null
          and m.role in ('couple','helper','coordinator') for share of u,m`, [r.id, weddingId])
      found = result.rows.length > 0
    } else if (r.kind === 'guest') {
      found = (await db.query('select id from guests where id=$1 and wedding_id=$2 for share', [r.id, weddingId])).rows.length > 0
    } else {
      found = (await db.query(`select id from deals where id=$1 and wedding_id=$2
        and state in ('booked','paid_deposit','done') for share`, [r.id, weddingId])).rows.length > 0
    }
    if (!found) throw validationFailed({ participants: 'ответственный или участник недоступен в этой свадьбе' })
  }
  return plans
}

export async function replaceTimelineRelations(db: Queryable, weddingId: string, ids: string[], plans: TimelinePlanning[]): Promise<void> {
  await db.query('delete from timeline_dependencies where wedding_id=$1', [weddingId])
  await db.query('delete from timeline_assignments where wedding_id=$1', [weddingId])
  for (const [i, p] of plans.entries()) {
    for (const dependency of p.dependsOn) {
      await db.query('insert into timeline_dependencies(wedding_id,event_id,depends_on) values ($1,$2,$3)', [weddingId, ids[i], dependency])
    }
    for (const [role, refs] of [['responsible', p.responsible ? [p.responsible] : []], ['participant', p.participants]] as const) {
      for (const r of refs) await db.query(`insert into timeline_assignments(wedding_id,event_id,role,kind,reference_id)
        values ($1,$2,$3,$4,$5)`, [weddingId, ids[i], role, r.kind, r.id])
    }
  }
}
