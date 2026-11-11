import type { Queryable } from '../plugins/db.js'
import { COMMITTED } from '../deals/state.js'
import { AppError, conflict, forbidden } from '../errors.js'
import type { components } from '../contract/api.generated.js'
import type { OrderContext } from './context.js'

type DeliveryKind = components['schemas']['OrderDeliveryKind']
export type DeliveryWrite = components['schemas']['OrderDeliveryWrite']

interface DeliveryRow {
  revision: number
  kind: DeliveryKind
  summary: string | null
  material_url: string | null
  due_on: string | null
  comment: string | null
  created_at: Date
}

function deliveryAvailable(order: OrderContext) {
  return order.vendorId !== null && COMMITTED.some(state => state === order.state)
}

export function assertDeliveryActor(order: OrderContext, kind: DeliveryKind) {
  const role = kind === 'submitted' ? 'vendor' : 'couple'
  if (order.actorRole !== role) throw forbidden('Это действие доступно другой стороне сделки')
  if (!deliveryAvailable(order)) throw conflict('order_delivery_unavailable', 'Сдача доступна для подтверждённой сделки с исполнителем')
}

export async function readDelivery(client: Queryable, order: OrderContext) {
  const { rows } = await client.query<DeliveryRow>(`select revision,kind,summary,material_url,due_on::text,comment,created_at
    from order_delivery_steps where wedding_id=$1 and deal_id=$2 order by revision desc`, [order.weddingId, order.dealId])
  return {
    actorRole: order.actorRole,
    available: deliveryAvailable(order),
    revision: rows[0]?.revision ?? 0,
    steps: rows.map(row => ({ revision: row.revision, kind: row.kind, summary: row.summary,
      materialUrl: row.material_url, dueOn: row.due_on, comment: row.comment, createdAt: row.created_at.toISOString() })),
  }
}

function materialLink(raw: string) {
  const value = raw.trim()
  const link = URL.canParse(value) ? new URL(value) : null
  if (!value.startsWith('https://') || !link || link.protocol !== 'https:' || link.username || link.password || link.href.length > 2048) {
    throw new AppError(422, 'order_delivery_invalid_link', 'Укажите HTTPS-ссылку без логина и пароля')
  }
  return link.href
}

/** Call inside a transaction holding the order write locks. */
export async function writeDelivery(client: Queryable, order: OrderContext, actorId: string, input: DeliveryWrite) {
  const current = (await client.query<Pick<DeliveryRow, 'revision' | 'kind'>>(`select revision,kind from order_delivery_steps
    where wedding_id=$1 and deal_id=$2 order by revision desc limit 1`, [order.weddingId, order.dealId])).rows[0]
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    throw conflict('order_delivery_stale', 'История сдачи изменилась. Обновите её перед отправкой')
  }
  const submit = input.kind === 'submitted'
  const previous = current?.kind ?? null
  if (submit ? previous !== null && previous !== 'changes_requested' : previous !== 'submitted') {
    throw conflict('order_delivery_transition', 'Действие недоступно на текущем этапе сдачи')
  }
  const summary = submit ? input.summary.trim() : null
  const comment = input.kind === 'changes_requested' ? input.comment.trim() : null
  if (summary === '' || comment === '' || summary?.includes('\0') || comment?.includes('\0')) {
    throw new AppError(422, 'order_delivery_text_required', 'Введите описание или комментарий без служебных символов')
  }
  const revision = input.expectedRevision + 1
  await client.query(`insert into order_delivery_steps(wedding_id,deal_id,revision,kind,previous_kind,actor_id,summary,material_url,due_on,comment)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [order.weddingId, order.dealId, revision, input.kind, previous, actorId,
    summary, submit ? materialLink(input.materialUrl) : null, submit ? input.dueOn : null, comment])
  return { revision, kind: input.kind }
}
