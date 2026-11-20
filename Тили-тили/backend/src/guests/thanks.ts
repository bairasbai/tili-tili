import { createHash, randomUUID } from 'node:crypto'
import { errors, jwtVerify, SignJWT } from 'jose'
import { AppError, conflict } from '../errors.js'
import { isUuid } from '../ids.js'
import type { Queryable } from '../plugins/db.js'

type Origin = { weddingId: string; userId: string; sessionId: string }
export type ThanksDraft = { text: string; partyIds: string[] }
export type ThanksConfirm = ThanksDraft & { previewToken: string }
type Invitation = { partyId: string; label: string | null; inviteToken: string; members: { id: string; name: string }[] }
type ReceiptRow = { id: string; recipient_count: number; sent_at: Date }
const audience = 'guest-thanks-preview'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invitationHash = (token: string) => createHash('sha256').update(token).digest('hex')
const now = async (client: Queryable) => (await client.query<{ at: Date }>('select clock_timestamp() at')).rows[0]!.at
const expired = () => conflict('thanks_preview_expired', 'Срок предпросмотра истёк. Откройте его ещё раз')
const changed = () => conflict('thanks_preview_changed', 'Приглашения или текст изменились. Откройте предпросмотр заново')

function normalized(draft: ThanksDraft) {
  const text = draft.text.trim()
  if (!text || text.includes('\0')) throw new AppError(422, 'thanks_text_required', 'Введите текст благодарности')
  const partyIds = [...new Set(draft.partyIds.map(id => id.toLowerCase()))].sort()
  if (partyIds.length !== draft.partyIds.length) throw changed()
  return { text, partyIds }
}

async function invitations(client: Queryable, weddingId: string, partyIds: string[] | null) {
  if (partyIds) {
    await client.query('select id from guest_parties where wedding_id=$1 and id=any($2) order by id for share', [weddingId, partyIds])
    await client.query('select id from guests where wedding_id=$1 and party_id=any($2) order by party_id,id for share', [weddingId, partyIds])
  }
  return (await client.query<Invitation>(`select p.id as "partyId",p.label,p.invite_token as "inviteToken",people.members
    from guest_parties p join lateral (
      select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name) order by g.party_position,g.created_at,g.id) members
        from guests g where g.wedding_id=p.wedding_id and g.party_id=p.id
    ) people on people.members is not null
    where p.wedding_id=$1 and p.invite_token is not null and ($2::uuid[] is null or p.id=any($2))
    order by p.id`, [weddingId, partyIds])).rows
}

const publicInvitation = ({ partyId, label, members }: Invitation) => ({
  partyId, label: label?.trim() || members[0]!.name, guestNames: members.map(member => member.name),
})
const present = (rows: Invitation[]) => rows.map(publicInvitation).sort((a, b) => a.label.localeCompare(b.label, 'ru'))
const snapshot = (rows: Invitation[]) => digest(rows.map(row => [row.partyId, row.label, invitationHash(row.inviteToken), row.members]))
const receipt = (row: ReceiptRow) => ({ id: row.id, recipientCount: row.recipient_count, sentAt: row.sent_at.toISOString() })

export async function listThanksRecipients(client: Queryable, weddingId: string) {
  return { recipients: present(await invitations(client, weddingId, null)) }
}

export async function previewThanks(client: Queryable, origin: Origin, draft: ThanksDraft, secret: string) {
  const intent = normalized(draft)
  const rows = await invitations(client, origin.weddingId, intent.partyIds)
  if (rows.length !== intent.partyIds.length) throw changed()
  const issued = Math.floor((await now(client)).getTime() / 1000), expiry = issued + 600
  const previewToken = await new SignJWT({ ...origin, previewId: randomUUID(), intent: digest(intent), snapshot: snapshot(rows) })
    .setProtectedHeader({ alg: 'HS256', typ: audience }).setIssuer('tili-tili').setAudience(audience)
    .setIssuedAt(issued).setExpirationTime(expiry).sign(Buffer.from(secret))
  return { previewToken, text: intent.text, recipients: present(rows), expiresAt: new Date(expiry * 1000).toISOString() }
}

export async function confirmThanks(client: Queryable, origin: Origin, command: ThanksConfirm, secret: string) {
  const intent = normalized(command)
  const time = await now(client)
  const verified = await jwtVerify(command.previewToken, Buffer.from(secret), {
    algorithms: ['HS256'], issuer: 'tili-tili', audience, typ: audience, currentDate: time, requiredClaims: ['iat', 'exp'],
  }).catch(error => { if (error instanceof errors.JWTExpired) throw expired(); throw changed() })
  const claims = verified.payload
  if (claims.weddingId !== origin.weddingId || claims.userId !== origin.userId || claims.sessionId !== origin.sessionId
    || typeof claims.previewId !== 'string' || !isUuid(claims.previewId) || claims.intent !== digest(intent)
    || typeof claims.snapshot !== 'string' || typeof claims.exp !== 'number') throw changed()

  // The caller holds the wedding write lock before checking or inserting this receipt.
  const prior = (await client.query<ReceiptRow>(`select id,recipient_count,sent_at from guest_thanks_batches
    where wedding_id=$1 and id=$2`, [origin.weddingId, claims.previewId])).rows[0]
  if (prior) return receipt(prior)
  const rows = await invitations(client, origin.weddingId, intent.partyIds)
  if (rows.length !== intent.partyIds.length || snapshot(rows) !== claims.snapshot) throw changed()
  if ((await now(client)).getTime() >= claims.exp * 1000) throw expired()
  const batch = (await client.query<ReceiptRow>(`insert into guest_thanks_batches(id,wedding_id,actor_id,body,recipient_count)
    values($1,$2,$3,$4,$5) returning id,recipient_count,sent_at`,
  [claims.previewId, origin.weddingId, origin.userId, intent.text, rows.length])).rows[0]!
  await client.query(`insert into guest_thanks_recipients(wedding_id,party_id,batch_id,invitation_hash)
    select $1,r.party_id,$2,r.invitation_hash from unnest($3::uuid[],$4::text[]) r(party_id,invitation_hash)`,
  [origin.weddingId, batch.id, rows.map(row => row.partyId), rows.map(row => invitationHash(row.inviteToken))])
  return receipt(batch)
}

export async function readGuestThanks(client: Queryable, weddingId: string, partyId: string, token: string) {
  const { rows } = await client.query<{ id: string; body: string; sent_at: Date }>(`select b.id,b.body,b.sent_at
    from guest_thanks_recipients r join guest_thanks_batches b on b.wedding_id=r.wedding_id and b.id=r.batch_id
    where r.wedding_id=$1 and r.party_id=$2 and r.invitation_hash=$3 order by b.sent_at,b.id`,
  [weddingId, partyId, invitationHash(token)])
  return rows.map(row => ({ id: row.id, text: row.body, sentAt: row.sent_at.toISOString() }))
}
