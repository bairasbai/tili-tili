import type { Queryable } from '../plugins/db.js'
import { forbidden, notFound, unauthorized } from '../errors.js'
import { lockCurrentConsent } from '../auth/consent.js'

export interface OrderActor { userId: string; sessionId: string; policyVersion: string }
export interface OrderContext { weddingId: string; dealId: string; slotId: string; categoryId: string;
  vendorId: string | null; state: string; actorRole: 'couple' | 'vendor' }

/** Principal rows remain locked until commit; the caller must supply a transaction client. */
export async function lockOrderPrincipal(client: Queryable, actor: OrderActor): Promise<void> {
  const user = await client.query('select id from users where id=$1 and deleted_at is null for share',[actor.userId])
  if (!user.rows[0]) throw unauthorized('Аккаунт удалён')
  const session = await client.query('select id from sessions where id=$1 and user_id=$2 and revoked_at is null for share',[actor.sessionId,actor.userId])
  if (!session.rows[0]) throw unauthorized('Сессия завершена')
  await lockCurrentConsent(client, actor.userId, actor.policyVersion)
}

export async function lockOrderWedding(client: Queryable, weddingId: string, write = true): Promise<void> {
  const wedding = await client.query(`select id from weddings where id=$1 and archived_at is null
    and cancelled_at is null for ${write ? 'update' : 'share'}`,[weddingId])
  if (!wedding.rows[0]) throw notFound('Свадьба не найдена')
}

/** Financial/private drafts are visible only to a current couple member or vendor owner. */
export async function lockOrderContext(client: Queryable, weddingId: string, dealId: string,
  actor: OrderActor, write = true): Promise<OrderContext> {
  await lockOrderWedding(client,weddingId,write)
  await lockOrderPrincipal(client,actor)
  const member = await client.query<{role:string}>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share',[weddingId,actor.userId])
  const deal = await client.query<{slot_id:string;category_id:string;vendor_id:string|null;state:string}>(`select d.slot_id,s.category_id,d.vendor_id,d.state
    from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
    where d.id=$2 and d.wedding_id=$1 for ${write ? 'update' : 'share'} of d,s`,[weddingId,dealId])
  const d = deal.rows[0]
  if (!d) throw notFound('Заказ не найден')
  if (write && d.state==='cancelled') throw forbidden('Отменённый заказ не исполняется; расчёты ведутся отдельно')
  let actorRole: 'couple' | 'vendor'
  if (member.rows[0]?.role==='couple') actorRole='couple'
  else {
    const vendor = d.vendor_id ? await client.query(`select v.id from vendors v join users u on u.id=v.user_id
      where v.id=$1 and v.user_id=$2 and u.deleted_at is null and v.blocked_at is null for share of v,u`,[d.vendor_id,actor.userId]) : null
    if (!vendor?.rows[0]) throw notFound('Заказ не найден')
    actorRole='vendor'
  }
  return {weddingId,dealId,slotId:d.slot_id,categoryId:d.category_id,vendorId:d.vendor_id,state:d.state,actorRole}
}
