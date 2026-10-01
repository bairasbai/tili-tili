import type { FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { notFound, unauthorized } from '../errors.js'
import { lockTimeline } from '../timeline/version.js'

export async function lockVendorProgramAccess(client: Queryable, request: FastifyRequest, weddingId: string, write: boolean, expectedVendorId?: string) {
  const snapshot = await lockTimeline(client, weddingId, write)
  const wedding = (await client.query<{ title: string; archived_at: Date | null; cancelled_at: Date | null }>(
    'select title,archived_at,cancelled_at from weddings where id=$1', [weddingId],
  )).rows[0]!
  if (wedding.archived_at || wedding.cancelled_at) throw notFound('Программа недоступна')
  const caller = request.caller!
  const user = (await client.query<{ deleted_at: Date | null }>('select deleted_at from users where id=$1 for share', [caller.userId])).rows[0]
  if (!user || user.deleted_at) throw unauthorized('Аккаунт удалён')
  const session = await client.query('select id from sessions where id=$1 and user_id=$2 and revoked_at is null for share', [caller.sessionId, caller.userId])
  if (session.rowCount === 0) throw unauthorized('Сессия завершена')
  const vendor = (await client.query<{ id: string }>(
    'select id from vendors where user_id=$1 and ($2::uuid is null or id=$2) for share', [caller.userId, expectedVendorId ?? null],
  )).rows[0]
  if (!vendor) throw notFound('Программа недоступна')
  const deals = await client.query<{ id: string }>(
    `select id from deals where wedding_id=$1 and vendor_id=$2
      and state in ('booked','paid_deposit','done') order by id for share`, [weddingId, vendor.id],
  )
  if (deals.rowCount === 0) throw notFound('Программа недоступна')
  return { snapshot, vendorId: vendor.id, dealIds: deals.rows.map(d => d.id), wedding: wedding.title }
}
