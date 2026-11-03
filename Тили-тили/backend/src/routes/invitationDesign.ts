import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'
import { EMPTY_DESIGN, parseInvitationDesign, type InvitationDesign } from '../invitations/design.js'

interface DesignRow { draft: InvitationDesign; published: InvitationDesign | null; version: string; published_at: Date | null }
function expected(request: FastifyRequest): string {
  const header = request.headers['if-match']
  if (header === undefined) throw new AppError(428, 'precondition_required', 'Обновите приглашение перед сохранением')
  if (typeof header !== 'string' || !/^"invitation-[0-9]{1,18}"$/.test(header)) throw new AppError(422, 'validation_failed', 'Неверная версия приглашения')
  return header.slice(12, -1)
}
const tag = (version: string) => `"invitation-${version}"`
const project = (row?: DesignRow) => ({ draft: row?.draft ?? EMPTY_DESIGN, published: row?.published ?? null,
  version: row?.version ?? '0', publishedAt: row?.published_at?.toISOString() ?? null })

export async function publishedInvitation(client: Queryable, weddingId: string): Promise<InvitationDesign | null> {
  const result = await client.query<{ published: InvitationDesign | null }>('select published from invitation_designs where wedding_id=$1', [weddingId])
  return result.rows[0]?.published ?? null
}

export async function invitationDesignRoutes(app: FastifyInstance): Promise<void> {
  const db = () => { if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна'); return app.db }
  const path = '/weddings/:weddingId/invitation-design'
  app.get(path, async (request, reply) => {
    const result = await db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const rows = await client.query<DesignRow>('select draft,published,version::text,published_at from invitation_designs where wedding_id=$1', [request.member!.weddingId])
      await assertSeatingToken(request)
      return project(rows.rows[0])
    })
    reply.header('ETag', tag(result.version)); reply.header('Cache-Control', 'no-store')
    return result
  })
  app.put(path, async (request, reply) => {
    const version = expected(request)
    const draft = await parseInvitationDesign(request.body)
    const result = await db().tx(async client => {
      await lockSeatingAccess(client, request)
      const weddingId = request.member!.weddingId
      await client.query('insert into invitation_designs(wedding_id) values($1) on conflict do nothing', [weddingId])
      const before = await client.query<DesignRow>('select draft,published,version::text,published_at from invitation_designs where wedding_id=$1 for update', [weddingId])
      await assertSeatingToken(request)
      if (before.rows[0]!.version !== version) throw conflict('invitation_conflict', 'Приглашение уже изменено — обновите страницу')
      const rows = await client.query<DesignRow>(`update invitation_designs set draft=$2,version=version+1,updated_at=now(),updated_by=$3
        where wedding_id=$1 returning draft,published,version::text,published_at`, [weddingId, JSON.stringify(draft), request.caller!.userId])
      return project(rows.rows[0])
    })
    reply.header('ETag', tag(result.version)); return result
  })
  app.post(`${path}/publish`, { schema: { body: { type: 'object', additionalProperties: false, maxProperties: 0 } } }, async (request, reply) => {
    const version = expected(request)
    const result = await db().tx(async client => {
      await lockSeatingAccess(client, request)
      const weddingId = request.member!.weddingId
      const before = await client.query<DesignRow>('select draft,published,version::text,published_at from invitation_designs where wedding_id=$1 for update', [weddingId])
      await assertSeatingToken(request)
      if (!before.rows[0] || before.rows[0].version !== version) throw conflict('invitation_conflict', 'Приглашение уже изменено — обновите страницу')
      if (!before.rows[0].draft.content.length) throw new AppError(422, 'validation_failed', 'Добавьте хотя бы один блок')
      const rows = await client.query<DesignRow>(`update invitation_designs set published=draft,published_at=now(),version=version+1,updated_at=now(),updated_by=$2
        where wedding_id=$1 returning draft,published,version::text,published_at`, [weddingId, request.caller!.userId])
      return project(rows.rows[0])
    })
    reply.header('ETag', tag(result.version)); return result
  })
}
