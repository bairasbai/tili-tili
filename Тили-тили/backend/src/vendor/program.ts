import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import { isUuid } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { encodeCursor, parsePageQuery, buildPage } from '../pagination.js'
import { expectedTimelineVersion, timelineETag } from '../timeline/version.js'
import { planningEnd } from '../timeline/shift.js'
import { lockVendorProgramAccess } from './program-access.js'
import { programDigest, signProgramRead, verifyProgramRead, PROGRAM_READ_TTL_SECONDS } from './program-token.js'

type ProgramAccess = Awaited<ReturnType<typeof lockVendorProgramAccess>>
interface ProgramRow {
  id: string; name: string; location: string | null; starts_at: Date | null; ends_at: Date | null
  duration_minutes: number | null; fixed: boolean; travel_minutes: number; buffer_minutes: number; outdoor: boolean
  event_id: string; event_name: string; event_date: string | null; time_zone: string | null; event_location: string | null
  roles: ('responsible' | 'participant')[]
}
export async function readProgram(client: Queryable, weddingId: string, access: Pick<ProgramAccess, 'snapshot' | 'dealIds' | 'wedding'>) {
  const { rows } = await client.query<ProgramRow>(
    `select e.id,e.name,e.location,e.starts_at,e.ends_at,e.duration_minutes,e.fixed,e.travel_minutes,e.buffer_minutes,e.outdoor,
            p.id as event_id,p.name as event_name,p.date::text as event_date,p.time_zone,p.location as event_location,
            array(select distinct a.role from timeline_assignments a where a.wedding_id=e.wedding_id and a.event_id=e.id
              and a.deal_id=any($2::uuid[]) order by a.role) as roles
       from timeline_events e join wedding_events p on p.wedding_id=e.wedding_id and p.id=e.program_event_id
      where e.wedding_id=$1 and exists (select 1 from timeline_assignments a
        where a.wedding_id=e.wedding_id and a.event_id=e.id and a.deal_id=any($2::uuid[]))
      order by e.sort,e.id`, [weddingId, access.dealIds],
  )
  const ids = rows.map(r => r.id)
  const dependencies = await client.query<{ event_id: string; depends_on: string }>(
    'select event_id,depends_on from timeline_dependencies where wedding_id=$1 and event_id=any($2::uuid[]) and depends_on=any($2::uuid[]) order by event_id,depends_on',
    [weddingId, ids],
  )
  const blocks = rows.map(r => {
    const knownEnd = planningEnd({ startsAt: r.starts_at?.toISOString() ?? null, endsAt: r.ends_at?.toISOString() ?? null, durationMinutes: r.duration_minutes })
    return { id: r.id, name: r.name, location: r.location, startsAt: r.starts_at?.toISOString() ?? null,
      endsAt: knownEnd === null ? null : new Date(knownEnd).toISOString(), durationMinutes: r.duration_minutes,
      fixed: r.fixed, travelMinutes: r.travel_minutes, bufferMinutes: r.buffer_minutes, outdoor: r.outdoor,
      roles: r.roles, dependsOn: dependencies.rows.filter(d => d.event_id === r.id).map(d => d.depends_on),
      event: { id: r.event_id, name: r.event_name, date: r.event_date, timeZone: r.time_zone, location: r.event_location } }
  })
  const payload = { weddingId, wedding: access.wedding, sourceVersion: access.snapshot.version,
    updatedAt: access.snapshot.updated_at?.toISOString() ?? null, blocks }
  const digest = programDigest(payload)
  return { payload, digest }
}
const actualTime = async (client: Queryable): Promise<Date> => (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
async function acknowledgment(client: Queryable, weddingId: string, access: ProgramAccess, userId: string, digest: string): Promise<string | null> {
  const row = (await client.query<{ acknowledged_at: Date }>(
    'select acknowledged_at from vendor_program_acknowledgments where wedding_id=$1 and vendor_id=$2 and user_id=$3 and version=$4 and digest=$5',
    [weddingId, access.vendorId, userId, access.snapshot.version, digest],
  )).rows[0]
  return row?.acknowledged_at.toISOString() ?? null
}

export async function vendorProgramRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const secret = () => {
    if (!app.appConfig.jwtAccessSecret) throw new AppError(503, 'auth_unavailable', 'Подписание снимка недоступно')
    return app.appConfig.jwtAccessSecret
  }
  app.get('/vendor/programs', { preHandler: app.requireConsent }, async (request, reply) => {
    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown }, /^0$/)
    const candidates = await db().query<{ id: string }>(
      `select distinct w.id from weddings w join deals d on d.wedding_id=w.id join vendors v on v.id=d.vendor_id
        where v.user_id=$1 and d.state in ('booked','paid_deposit','done') and w.archived_at is null and w.cancelled_at is null
          and ($2::uuid is null or w.id>$2::uuid) order by w.id limit $3`,
      [request.caller!.userId, page.cursor?.id ?? null, page.limit + 1],
    )
    const selected = buildPage(candidates.rows, page.limit, r => encodeCursor('0', r.id))
    const items = []
    for (const row of selected.items) {
      try {
        items.push(await db().tx(async client => {
          const access = await lockVendorProgramAccess(client, request, row.id, false)
          const { payload, digest } = await readProgram(client, row.id, access)
          const acknowledgedAt = await acknowledgment(client, row.id, access, request.caller!.userId, digest)
          return { weddingId: row.id, wedding: payload.wedding, sourceVersion: payload.sourceVersion, updatedAt: payload.updatedAt,
            blockCount: payload.blocks.length, acknowledgedAt, requiresAcknowledgment: payload.blocks.length > 0 && acknowledgedAt === null }
        }))
      } catch (error) {
        // A booking can be revoked between candidate selection and its locked read.
        if (!(error instanceof AppError) || error.statusCode !== 404) throw error
      }
    }
    reply.header('Cache-Control', 'no-store')
    return { items, nextCursor: selected.nextCursor }
  })
  app.get('/vendor/weddings/:weddingId/timeline', { preHandler: app.requireConsent }, async (request, reply) => {
    const { weddingId } = request.params as { weddingId: string }
    if (!isUuid(weddingId)) throw notFound('Программа недоступна')
    return db().tx(async client => {
      const access = await lockVendorProgramAccess(client, request, weddingId, false)
      const { payload, digest } = await readProgram(client, weddingId, access)
      const acknowledgedAt = await acknowledgment(client, weddingId, access, request.caller!.userId, digest)
      const now = await actualTime(client)
      const readToken = payload.blocks.length ? await signProgramRead(secret(), {
        weddingId, vendorId: access.vendorId, userId: request.caller!.userId, sessionId: request.caller!.sessionId,
        version: access.snapshot.version, digest,
      }, now) : null
      reply.header('ETag', timelineETag(access.snapshot.version)).header('Cache-Control', 'no-store')
      return { ...payload, acknowledgedAt, requiresAcknowledgment: payload.blocks.length > 0 && acknowledgedAt === null,
        readToken, expiresAt: readToken ? new Date((Math.floor(now.getTime() / 1000) + PROGRAM_READ_TTL_SECONDS) * 1000).toISOString() : null }
    })
  })
  app.post('/vendor/weddings/:weddingId/timeline/ack', { preHandler: app.requireConsent, schema: { body: {
    type: 'object', required: ['readToken'], additionalProperties: false,
    properties: { readToken: { type: 'string', minLength: 1, maxLength: 8192 } },
  } } }, async (request, reply) => {
    const { weddingId } = request.params as { weddingId: string }
    if (!isUuid(weddingId)) throw notFound('Программа недоступна')
    const expected = expectedTimelineVersion(request.headers['if-match'])
    const { readToken } = request.body as { readToken: string }
    return db().tx(async client => {
      const access = await lockVendorProgramAccess(client, request, weddingId, true)
      if (access.snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — откройте новую редакцию')
      const now = await actualTime(client)
      const claims = await verifyProgramRead(secret(), readToken, now)
      if (claims.weddingId !== weddingId || claims.vendorId !== access.vendorId || claims.userId !== request.caller!.userId
        || claims.sessionId !== request.caller!.sessionId || claims.version !== expected) throw validationFailed({ readToken: 'снимок относится к другому заказу, пользователю, сессии или версии' })
      const { payload, digest } = await readProgram(client, weddingId, access)
      if (payload.blocks.length === 0) throw conflict('program_unassigned', 'Нет назначенных вам блоков программы')
      if (digest !== claims.digest) throw conflict('program_snapshot_changed', 'Содержание программы изменилось — откройте её заново')
      const inserted = await client.query<{ acknowledged_at: Date }>(
        `insert into vendor_program_acknowledgments(wedding_id,vendor_id,user_id,session_id,version,digest,program_snapshot)
          values($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict do nothing returning acknowledged_at`,
        [weddingId, access.vendorId, request.caller!.userId, request.caller!.sessionId, expected, digest, JSON.stringify(payload)],
      )
      if (inserted.rowCount) await client.query(
        `insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'timeline.acknowledged','wedding',$2,$3::jsonb)`,
        [request.caller!.userId, weddingId, JSON.stringify({ vendorId: access.vendorId, version: expected, digest })],
      )
      const acknowledgedAt = inserted.rows[0]?.acknowledged_at.toISOString()
        ?? await acknowledgment(client, weddingId, access, request.caller!.userId, digest)
      if (!acknowledgedAt) throw new AppError(503, 'acknowledgment_unavailable', 'Подтверждение недоступно')
      reply.header('ETag', timelineETag(expected)).header('Cache-Control', 'no-store')
      return { sourceVersion: expected, acknowledgedAt }
    })
  })
}
