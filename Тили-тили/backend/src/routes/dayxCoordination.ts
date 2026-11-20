import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { knownTimeZone } from '../notify/quiet.js'
import type { Queryable } from '../plugins/db.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'

interface PerformerRow {
  deal_id: string; label: string; name: string | null; phone: string | null
  event_name: string | null; event_date: string | null; event_zone: string | null; scope_key: string | null
  revision: string | null; planned_arrival_at: Date | null
  arrived_at: Date | null; arrived_by: string | null; arrived_name: string | null
  ready_at: Date | null; ready_by: string | null; ready_name: string | null
}
type Update = {
  scopeKey: string; expectedRevision: string | null
  plannedArrivalAt?: string | null; arrived?: boolean; ready?: boolean
}

// A changed event or deal-day binding starts fresh. Legacy slots still use the
// recorded main event. The fingerprint includes no financial material.
const performerRows = (client: Queryable, weddingId: string, dealId?: string, lockDeal = false) =>
  client.query<PerformerRow>(`with performers as (
    select d.id as deal_id,s.label,s.sort,coalesce(v.name,d.external_name) as name,
           case when d.vendor_id is null then d.external_phone end as phone,
           e.name as event_name,e.date::text as event_date,e.time_zone as event_zone,
           case when e.date is not null and e.time_zone is not null then
             encode(sha256(convert_to(jsonb_build_array(e.id,e.date,e.time_zone,extract(epoch from e.modified_at),
               h.current_version_id,d.vendor_id,d.external_name)::text,'UTF8')),'hex') end as scope_key
      from slots s join deals d on d.wedding_id=s.wedding_id and d.id=s.deal_id
      left join vendors v on v.id=d.vendor_id
      left join wedding_events e on e.wedding_id=s.wedding_id and (e.id=s.program_event_id or (s.program_event_id is null and e.is_main))
      left join deal_day_scope_heads h on h.wedding_id=d.wedding_id and h.deal_id=d.id
     where s.wedding_id=$1 and d.state in ('booked','paid_deposit','done') and ($2::uuid is null or d.id=$2)
     ${lockDeal ? 'for share of d' : ''}
  )
  select p.*,ds.revision,ds.planned_arrival_at,ds.arrived_at,ds.arrived_by,ds.ready_at,ds.ready_by,
         nullif(btrim(au.name),'') as arrived_name,nullif(btrim(ru.name),'') as ready_name
    from performers p
    left join dayx_vendor_status ds on ds.wedding_id=$1 and ds.deal_id=p.deal_id and ds.scope_key=p.scope_key
    left join users au on au.id=ds.arrived_by and au.deleted_at is null
    left join users ru on ru.id=ds.ready_by and ru.deleted_at is null
   order by p.sort,p.deal_id`, [weddingId, dealId ?? null])

const currentScope = (row: PerformerRow) =>
  row.event_zone && knownTimeZone(row.event_zone) === row.event_zone ? row.scope_key : null
const observed = (at: Date | null, by: string | null) => at ? { at: at.toISOString(), by } : null
const project = (row: PerformerRow) => ({
  dealId: row.deal_id, label: row.label, name: row.name, phone: row.phone,
  event: row.event_name === null ? null : { name: row.event_name, date: row.event_date, timeZone: row.event_zone },
  scopeKey: currentScope(row), revision: row.revision,
  plannedArrivalAt: row.planned_arrival_at?.toISOString() ?? null,
  arrival: observed(row.arrived_at, row.arrived_name),
  readiness: observed(row.ready_at, row.ready_name),
})

const uuid = { type: 'string', format: 'uuid' }
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const path = '/weddings/:weddingId/dayx/coordination'

export async function dayXCoordinationRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.get(path, async request => db().tx(async client => {
    await lockGuestReadAccess(client, request)
    const { weddingId } = request.member!
    const wedding = await client.query('select id from weddings where id=$1 and cancelled_at is null', [weddingId])
    if (!wedding.rowCount) throw notFound('Свадьба недоступна')
    const { rows: performers } = await performerRows(client, weddingId)
    const { rows: openTasks } = await client.query(`
      select t.id,t.title,t.due::text as due,nullif(btrim(u.name),'') as assignee
        from tasks t left join users u on u.id=t.assignee_id and u.deleted_at is null
       where t.wedding_id=$1 and t.done_at is null and t.excluded_reason is null and t.kind in ('checklist','planb')
       order by t.due nulls last,t.sort,t.title,t.id`, [weddingId])
    await assertSeatingToken(request)
    return { performers: performers.map(project), openTasks }
  }))

  app.patch<{ Params: { dealId: string }; Body: Update }>(path + '/:dealId', {
    schema: {
      params: { type: 'object', required: ['dealId'], properties: { dealId: uuid } },
      body: {
        type: 'object', required: ['scopeKey', 'expectedRevision'], additionalProperties: false, minProperties: 3,
        properties: {
          scopeKey: { type: 'string', pattern: '^[0-9a-f]{64}$' }, expectedRevision: nullable(uuid),
          plannedArrivalAt: nullable({ type: 'string', format: 'date-time' }),
          arrived: { type: 'boolean' }, ready: { type: 'boolean' },
        },
      },
    },
  }, async request => db().tx(async client => {
    await lockSeatingAccess(client, request)
    const { weddingId } = request.member!, { dealId } = request.params, actor = request.caller!.userId
    const lockedSlot = await client.query('select id from slots where wedding_id=$1 and deal_id=$2 for share', [weddingId, dealId])
    if (!lockedSlot.rowCount) throw notFound('Исполнитель не найден')
    const row = (await performerRows(client, weddingId, dealId, true)).rows[0]
    if (!row) throw notFound('Исполнитель не найден')
    const { scopeKey, expectedRevision, plannedArrivalAt, arrived, ready } = request.body
    if (currentScope(row) !== scopeKey || row.revision !== (expectedRevision?.toLowerCase() ?? null)) {
      throw conflict('dayx_coordination_changed', 'Данные исполнителя изменились. Обновите сводку')
    }
    const now = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
    const arrivalAt = arrived === false ? null : row.arrived_at ?? (arrived ? now : null)
    const arrivalBy = arrived === false ? null : row.arrived_at ? row.arrived_by : arrived ? actor : null
    const readinessAt = ready === false ? null : row.ready_at ?? (ready ? now : null)
    const readinessBy = ready === false ? null : row.ready_at ? row.ready_by : ready ? actor : null
    await client.query(`insert into dayx_vendor_status(wedding_id,deal_id,scope_key,revision,planned_arrival_at,arrived_at,arrived_by,ready_at,ready_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict(wedding_id,deal_id,scope_key) do update set revision=excluded.revision,
        planned_arrival_at=excluded.planned_arrival_at,arrived_at=excluded.arrived_at,arrived_by=excluded.arrived_by,
        ready_at=excluded.ready_at,ready_by=excluded.ready_by`,
    [weddingId, dealId, scopeKey, uuidv7(), plannedArrivalAt === undefined ? row.planned_arrival_at : plannedArrivalAt,
      arrivalAt, arrivalBy, readinessAt, readinessBy])
    const updated = (await performerRows(client, weddingId, dealId)).rows[0]!
    await assertSeatingToken(request)
    return project(updated)
  }))
}
