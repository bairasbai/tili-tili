import type { FastifyInstance } from 'fastify'
import { verifyAccessToken } from '../auth/tokens.js'
import { assertOpen, chatForUser } from '../chats/access.js'
import { COMMITTED, type DealState } from '../deals/state.js'
import { AppError, notFound, unauthorized } from '../errors.js'
import { lockOrderPrincipal, lockOrderWedding } from '../orders/context.js'

const expired = () => new AppError(401, 'token_expired', 'Срок действия токена истёк')

/** Plain opaque admission before taking any foreign chat/wedding locks. */
export async function authorizeChatToken(app: FastifyInstance, chatId: string, token: string) {
  if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
  const claims = await app.authorizeToken(token)
  const { chat } = await chatForUser(app.db, chatId, claims.sub)
  assertOpen(chat)
  if (claims.exp * 1000 <= Date.now()) throw expired()
  return { claims, chat }
}

/** A synchronous socket write runs while every authority source remains pinned.
 * No browser acknowledgement or network promise is awaited inside this scope. */
export async function withChatDeliveryAccess(
  app: FastifyInstance, chatId: string, token: string, write: () => void,
): Promise<void> {
  const { claims, chat: admitted } = await authorizeChatToken(app, chatId, token)
  if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
  await app.db.tx(async client => {
    // Same wedding -> principal -> membership -> deal/vendor order as private
    // order reads. Plain admission above is not relied on after a lock wait.
    await lockOrderWedding(client, admitted.wedding_id, false)
    // Membership/owner grants take FK KEY SHARE on this actor. Take the
    // strongest own-user pin first, never upgrade an already shared pin:
    // absent membership and owner precedence stay stable through the send.
    await client.query('select id from users where id=$1 for update', [claims.sub])
    await lockOrderPrincipal(client, { userId: claims.sub, sessionId: claims.sid, policyVersion: app.appConfig.policyVersion })
    const member = await client.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share',
      [admitted.wedding_id, claims.sub])
    const pinned = await client.query('select id from chats where id=$1 and wedding_id=$2 for share', [chatId, admitted.wedding_id])
    if (!pinned.rows[0]) throw notFound('Чат не найден')
    // Shared vendor chat access depends on live deals; ownership and the
    // caller-wide moderator block depend on that caller's vendor rows.
    const deals = await client.query<{ vendor_id: string; state: DealState }>(`select d.vendor_id,d.state from deals d join vendors v on v.id=d.vendor_id
      where d.wedding_id=$1 and v.user_id=$2 order by d.id for share of d`, [admitted.wedding_id, claims.sub])
    const vendors = await client.query<{ id: string; user_id: string }>('select id,user_id from vendors where user_id=$1 order by id for share', [claims.sub])
    const { chat, as } = await chatForUser(client, chatId, claims.sub)
    assertOpen(chat)
    // READ COMMITTED can see a newly inserted/reassigned grant that was absent
    // from a conditional pin query. Canonical ACL must be supported by the
    // actual locked facts, not that later unpinned grant.
    const owned = new Set(vendors.rows.filter(vendor => vendor.user_id === claims.sub).map(vendor => vendor.id))
    const proven = as === 'vendor'
      ? chat.kind === 'vendor'
        ? chat.vendor_id !== null && owned.has(chat.vendor_id)
        : deals.rows.some(deal => owned.has(deal.vendor_id) && COMMITTED.includes(deal.state))
      : member.rows[0]?.role === as
    if (!proven) throw notFound('Чат не найден')

    // Signature/identity/expiry are checked again after all waits, with pins
    // held through the immediately following synchronous write.
    const secret = app.appConfig.jwtAccessSecret
    if (!secret) throw unauthorized('Сервер не настроен для проверки токенов')
    const current = await verifyAccessToken(secret, token)
    if (current.sub !== claims.sub || current.sid !== claims.sid) throw unauthorized('Сессия завершена')
    if (current.exp * 1000 <= Date.now()) throw expired()
    write()
  })
}
