import type { Queryable } from '../plugins/db.js'
import { AppError, conflict } from '../errors.js'
import { lockTimeline } from '../timeline/version.js'

const gone = () => new AppError(410, 'gone', 'Ссылка недействительна: истекла или отозвана')
export async function lockExternalProgramAccess(client: Queryable, token: string, write: boolean, updateInvite = false) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) throw gone()
  const candidate = (await client.query<{ wedding_id: string }>('select wedding_id from external_invites where token=$1', [token])).rows[0]
  if (!candidate) throw gone()
  let snapshot
  try { snapshot = await lockTimeline(client, candidate.wedding_id, write) }
  catch (error) {
    if (error instanceof AppError && error.statusCode === 404) throw gone()
    throw error
  }
  const wedding = (await client.query<{ title: string; date: string | null; tz: string | null; archived_at: Date | null; cancelled_at: Date | null }>(
    'select title,date::text as date,tz,archived_at,cancelled_at from weddings where id=$1', [candidate.wedding_id],
  )).rows[0]!
  if (wedding.archived_at || wedding.cancelled_at) throw gone()
  const invite = (await client.query<{ program_identity: string; program_deal_id: string | null; slot_id: string; expires_at: Date; revoked_at: Date | null }>(
    `select program_identity,program_deal_id,slot_id,expires_at,revoked_at from external_invites where token=$1 and wedding_id=$2 for ${updateInvite ? 'update' : 'share'}`, [token, candidate.wedding_id],
  )).rows[0]
  const openedAt = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
  if (!invite || invite.revoked_at || invite.expires_at <= openedAt) throw gone()
  if (!invite.program_deal_id) throw conflict('program_link_unbound', 'Для ознакомления с программой нужна новая ссылка от пары')
  const slot = (await client.query<{ deal_id: string | null }>(
    'select deal_id from slots where id=$1 and wedding_id=$2 for share', [invite.slot_id, candidate.wedding_id],
  )).rows[0]
  if (slot?.deal_id !== invite.program_deal_id) throw gone()
  const deal = (await client.query<{ vendor_id: string | null; external_name: string | null; state: string }>(
    'select vendor_id,external_name,state from deals where id=$1 and wedding_id=$2 for share', [invite.program_deal_id, candidate.wedding_id],
  )).rows[0]
  if (!deal || deal.vendor_id || !deal.external_name || !['booked', 'paid_deposit', 'done'].includes(deal.state)) throw gone()
  // Transaction now() predates lock waits; expiry must be checked after all waits.
  const now = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
  if (invite.expires_at <= now) throw gone()
  return { snapshot, weddingId: candidate.wedding_id, wedding: wedding.title, dealIds: [invite.program_deal_id],
    inviteId: invite.program_identity, dealId: invite.program_deal_id, slotId: invite.slot_id,
    date: wedding.date, tz: wedding.tz, expiresAt: invite.expires_at, now }
}

export async function assertExternalLinkNotExpired(client: Queryable, expiresAt: Date) {
  const now = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
  if (expiresAt <= now) throw gone()
}
