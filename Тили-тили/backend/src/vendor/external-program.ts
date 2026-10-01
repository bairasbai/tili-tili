import type { FastifyInstance } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, validationFailed } from '../errors.js'
import { expectedTimelineVersion, timelineETag } from '../timeline/version.js'
import { lockExternalProgramAccess } from './external-program-access.js'
import { signExternalProgramRead, verifyExternalProgramRead } from './external-program-token.js'
import { PROGRAM_READ_TTL_SECONDS } from './program-token.js'
import { readProgram } from './program.js'

type Access = Awaited<ReturnType<typeof lockExternalProgramAccess>>
async function acknowledgment(client: Queryable, access: Access, digest: string): Promise<string | null> {
  const row = (await client.query<{ acknowledged_at: Date }>(
    'select acknowledged_at from external_program_acknowledgments where wedding_id=$1 and invite_id=$2 and deal_id=$3 and version=$4 and digest=$5',
    [access.weddingId, access.inviteId, access.dealId, access.snapshot.version, digest],
  )).rows[0]
  return row?.acknowledged_at.toISOString() ?? null
}
export async function externalProgramRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const secret = () => {
    if (!app.appConfig.jwtAccessSecret) throw new AppError(503, 'auth_unavailable', 'Подписание снимка недоступно')
    return app.appConfig.jwtAccessSecret
  }
  app.get('/guest-vendor/:token/timeline', async (request, reply) => {
    const { token } = request.params as { token: string }
    return db().tx(async client => {
      const access = await lockExternalProgramAccess(client, token, false)
      const { payload, digest } = await readProgram(client, access.weddingId, access)
      const acknowledgedAt = await acknowledgment(client, access, digest)
      const readToken = payload.blocks.length ? await signExternalProgramRead(secret(), {
        weddingId: access.weddingId, inviteId: access.inviteId, dealId: access.dealId, version: access.snapshot.version, digest,
      }, access.now) : null
      reply.header('ETag', timelineETag(access.snapshot.version)).header('Cache-Control', 'no-store')
      return { ...payload, acknowledgedAt, requiresAcknowledgment: payload.blocks.length > 0 && acknowledgedAt === null,
        readToken, expiresAt: readToken ? new Date((Math.floor(access.now.getTime() / 1000) + PROGRAM_READ_TTL_SECONDS) * 1000).toISOString() : null }
    })
  })
  app.post('/guest-vendor/:token/timeline/ack', { schema: { body: {
    type: 'object', required: ['readToken'], additionalProperties: false,
    properties: { readToken: { type: 'string', minLength: 1, maxLength: 8192 } },
  } } }, async (request, reply) => {
    const { token } = request.params as { token: string }
    const expected = expectedTimelineVersion(request.headers['if-match'])
    const { readToken } = request.body as { readToken: string }
    return db().tx(async client => {
      const access = await lockExternalProgramAccess(client, token, true)
      if (access.snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — откройте новую редакцию')
      const claims = await verifyExternalProgramRead(secret(), readToken, access.now)
      if (claims.weddingId !== access.weddingId || claims.inviteId !== access.inviteId || claims.dealId !== access.dealId || claims.version !== expected)
        throw validationFailed({ readToken: 'снимок относится к другой ссылке, сделке, свадьбе или версии' })
      const { payload, digest } = await readProgram(client, access.weddingId, access)
      if (payload.blocks.length === 0) throw conflict('program_unassigned', 'Нет назначенных вам блоков программы')
      if (claims.digest !== digest) throw conflict('program_snapshot_changed', 'Содержание программы изменилось — откройте её заново')
      const inserted = await client.query<{ acknowledged_at: Date }>(
        `insert into external_program_acknowledgments(wedding_id,invite_id,deal_id,version,digest,program_snapshot)
          values($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing returning acknowledged_at`,
        [access.weddingId, access.inviteId, access.dealId, expected, digest, JSON.stringify(payload)],
      )
      if (inserted.rowCount) await client.query(
        `insert into audit_log(actor_id,action,entity,entity_id,diff) values(null,'timeline.external_acknowledged','wedding',$1,$2::jsonb)`,
        [access.weddingId, JSON.stringify({ actorKind: 'external_link', inviteId: access.inviteId, dealId: access.dealId, version: expected, digest })],
      )
      const acknowledgedAt = inserted.rows[0]?.acknowledged_at.toISOString() ?? await acknowledgment(client, access, digest)
      if (!acknowledgedAt) throw new AppError(503, 'acknowledgment_unavailable', 'Подтверждение недоступно')
      reply.header('ETag', timelineETag(expected)).header('Cache-Control', 'no-store')
      return { sourceVersion: expected, acknowledgedAt }
    })
  })
}
