import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError, forbidden, notFound, unauthorized, validationFailed } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { allowedRoles, type Role } from '../wedding/access.js'

export interface TimelineVersion {
  version: string
  updated_at: Date | null
  updated_by: string | null
}

export async function lockTimeline(client: Queryable, weddingId: string, write: boolean): Promise<TimelineVersion> {
  const { rows } = await client.query<TimelineVersion>(
    `select timeline_version::text as version, timeline_updated_at as updated_at,
            timeline_updated_by as updated_by from weddings where id = $1
      for ${write ? 'update' : 'share'}`,
    [weddingId],
  )
  if (!rows[0]) throw notFound('Свадьба не найдена')
  return rows[0]
}

/** Access may be revoked while the handler waits for the wedding lock. */
export async function lockTimelineForRequest(client: Queryable, request: FastifyRequest, write: boolean): Promise<TimelineVersion> {
  const weddingId = request.member!.weddingId
  const caller = request.caller!
  const snapshot = await lockTimeline(client, weddingId, write)
  const wedding = await client.query<{ archived_at: Date | null; cancelled_at: Date | null }>(
    'select archived_at, cancelled_at from weddings where id=$1', [weddingId],
  )
  if (wedding.rows[0]!.archived_at || (write && wedding.rows[0]!.cancelled_at)) throw notFound('Свадьба не найдена')
  const user = await client.query<{ deleted_at: Date | null }>('select deleted_at from users where id=$1 for share', [caller.userId])
  if (!user.rows[0] || user.rows[0].deleted_at) throw unauthorized('Аккаунт удалён')
  const session = await client.query('select id from sessions where id=$1 and user_id=$2 and revoked_at is null for share', [caller.sessionId, caller.userId])
  if (session.rowCount === 0) throw unauthorized('Сессия завершена')
  const member = await client.query<{ role: Role }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [weddingId, caller.userId])
  if (!member.rows[0]) throw notFound('Свадьба не найдена')
  if (!allowedRoles(request.routeOptions.url!, request.method).includes(member.rows[0].role)) throw forbidden('Недостаточно прав')
  return snapshot
}

export const timelineETag = (version: string) => `"${version}"`

export function sendTimelineVersion(reply: FastifyReply, snapshot: TimelineVersion): void {
  reply.header('ETag', timelineETag(snapshot.version))
  if (snapshot.updated_at) reply.header('X-Timeline-Updated-At', snapshot.updated_at.toISOString())
  if (snapshot.updated_by) reply.header('X-Timeline-Updated-By', snapshot.updated_by)
}

export function expectedTimelineVersion(header: string | string[] | undefined): string {
  if (header === undefined) throw new AppError(428, 'timeline_version_required', 'Обновите программу перед сохранением')
  const match = typeof header === 'string' ? /^"(\d+)"$/.exec(header) : null
  if (!match) throw validationFailed({ 'If-Match': 'нужна версия полученного снимка программы' })
  return match[1]!
}

export async function setTimelineActor(client: Queryable, actorId: string | null): Promise<void> {
  await client.query("select set_config('tili.timeline_actor', $1, true)", [actorId ?? ''])
}
