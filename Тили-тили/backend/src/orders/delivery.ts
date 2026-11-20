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
  files: { uploadId: string; contentType: string; sizeBytes: number }[]
}

export function deliveryAvailable(order: OrderContext) {
  return order.vendorId !== null && COMMITTED.some(state => state === order.state)
}

export function assertDeliveryActor(order: OrderContext, kind: DeliveryKind) {
  const role = kind === 'submitted' ? 'vendor' : 'couple'
  if (order.actorRole !== role) throw forbidden('Это действие доступно другой стороне сделки')
  if (!deliveryAvailable(order)) throw conflict('order_delivery_unavailable', 'Сдача доступна для подтверждённой сделки с исполнителем')
}

export const DELIVERY_DRAFT_LIMIT = 5

const canSubmit = (kind: DeliveryKind | undefined) => kind === undefined || kind === 'changes_requested'

export async function deliveryHead(client: Queryable, order: OrderContext) {
  return (await client.query<Pick<DeliveryRow, 'revision' | 'kind'>>(`select revision,kind from order_delivery_steps
    where wedding_id=$1 and deal_id=$2 order by revision desc limit 1`, [order.weddingId, order.dealId])).rows[0]
}

export async function currentDeliveryDraft(client: Queryable, order: OrderContext, revision: number) {
  assertDeliveryActor(order, 'submitted')
  const head = await deliveryHead(client, order)
  if (revision !== (head?.revision ?? 0) + 1 || !canSubmit(head?.kind)) {
    throw conflict('order_delivery_stale', 'История сдачи изменилась. Обновите её перед отправкой')
  }
}

export async function readDelivery(client: Queryable, order: OrderContext, actorId: string, uploadEnabled: boolean) {
  const { rows } = await client.query<DeliveryRow>(`select s.revision,s.kind,s.summary,s.material_url,s.due_on::text,s.comment,s.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('uploadId',u.id,'contentType',u.content_type,'sizeBytes',u.output_bytes)
      order by f.position) from order_delivery_attachments f join media_uploads u on u.id=f.upload_id and u.state='ready'
      where f.wedding_id=s.wedding_id and f.deal_id=s.deal_id and f.revision=s.revision),'[]') files
    from order_delivery_steps s where s.wedding_id=$1 and s.deal_id=$2 order by s.revision desc`, [order.weddingId, order.dealId])
  const available = deliveryAvailable(order)
  const revision = rows[0]?.revision ?? 0
  const drafts = order.actorRole === 'vendor' && available && canSubmit(rows[0]?.kind)
    ? (await client.query(`select id as "uploadId",content_type as "contentType",state,error_code as "errorCode",
      (state in ('pending','failed','processing') and expires_at>clock_timestamp() and attempts<3) retryable
      from media_uploads where delivery_deal_id=$1 and delivery_revision=$2 and delivery_author_id=$3
        and ((state='ready' and ready_at+interval '24 hours'>clock_timestamp())
          or (state in ('pending','failed','processing') and expires_at>clock_timestamp()))
      order by created_at,id`, [order.dealId, revision + 1, actorId])).rows
    : []
  return {
    actorRole: order.actorRole,
    available, revision, uploadEnabled, drafts,
    steps: rows.map(row => ({ revision: row.revision, kind: row.kind, summary: row.summary,
      materialUrl: row.material_url, dueOn: row.due_on, comment: row.comment, files: row.files, createdAt: row.created_at.toISOString() })),
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
export async function writeDelivery(client: Queryable, order: OrderContext, actorId: string, input: DeliveryWrite, storageId: string | null) {
  const current = await deliveryHead(client, order)
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    throw conflict('order_delivery_stale', 'История сдачи изменилась. Обновите её перед отправкой')
  }
  const submit = input.kind === 'submitted'
  const previous = current?.kind ?? null
  if (submit ? !canSubmit(current?.kind) : previous !== 'submitted') {
    throw conflict('order_delivery_transition', 'Действие недоступно на текущем этапе сдачи')
  }
  const summary = submit ? input.summary.trim() : null
  const comment = input.kind === 'changes_requested' ? input.comment.trim() : null
  if (summary === '' || comment === '' || summary?.includes('\0') || comment?.includes('\0')) {
    throw new AppError(422, 'order_delivery_text_required', 'Введите описание или комментарий без служебных символов')
  }
  const revision = input.expectedRevision + 1
  const materialUrl = submit && input.materialUrl ? materialLink(input.materialUrl) : null
  const files = submit ? input.fileIds ?? [] : []
  if (submit && !materialUrl && !files.length) {
    throw new AppError(422, 'order_delivery_material_required', 'Добавьте ссылку или проверенный файл')
  }
  if (files.length) {
    const ready = await client.query(`select id from media_uploads where id=any($1::uuid[])
      and delivery_deal_id=$2 and delivery_revision=$3 and delivery_author_id=$4 and state='ready'
      and storage_id=$5 and ready_at+interval '24 hours'>clock_timestamp() order by id for update`,
    [files, order.dealId, revision, actorId, storageId])
    if (ready.rows.length !== files.length) {
      throw conflict('order_delivery_file_unavailable', 'Проверьте состояние файлов перед сдачей')
    }
  }
  await client.query(`insert into order_delivery_steps(wedding_id,deal_id,revision,kind,previous_kind,actor_id,summary,material_url,due_on,comment)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [order.weddingId, order.dealId, revision, input.kind, previous, actorId,
    summary, materialUrl, submit ? input.dueOn : null, comment])
  if (files.length) await client.query(`insert into order_delivery_attachments(wedding_id,deal_id,revision,position,upload_id)
    select $1,$2,$3,position,upload_id from unnest($4::uuid[]) with ordinality as f(upload_id,position)`,
  [order.weddingId, order.dealId, revision, files])
  return { revision, kind: input.kind }
}
