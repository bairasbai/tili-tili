import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { lockOrderPrincipal, lockOrderWedding, type OrderActor } from './context.js'
import { boundedText, checkEntityId, checkVersion, lockDraftOrder, readOrder, recordOrderChange, type OrderDto, type OrderWriteInput } from './model.js'

export interface AdditionalSlotInput { weddingId: string; actor: OrderActor; categoryId: string; programEventId: string; label: string }
export interface AdditionalSlotDto { id: string; categoryId: string; programEventId: string; label: string }
/** Explicit extra position: the legacy category-only create contract is unchanged. */
export async function createAdditionalSlot(client: Queryable, input: AdditionalSlotInput): Promise<AdditionalSlotDto> {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.programEventId, 'programEventId')
  await lockOrderWedding(client, input.weddingId)
  await lockOrderPrincipal(client, input.actor)
  const member = await client.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [input.weddingId, input.actor.userId])
  if (!member.rows[0]) throw notFound('Свадьба не найдена')
  if (member.rows[0].role !== 'couple') throw forbidden('Позиции услуг создаёт пара')
  boundedText(input.label, 'label')
  const category = await client.query('select id from categories where id=$1', [input.categoryId])
  if (!category.rows[0]) throw validationFailed({ categoryId: 'Категория не найдена' })
  const event = await client.query('select id from wedding_events where wedding_id=$1 and id=$2 for share', [input.weddingId, input.programEventId])
  if (!event.rows[0]) throw notFound('Мероприятие не найдено')
  const count = await client.query<{ n: string }>('select count(*)::text as n from slots where wedding_id=$1', [input.weddingId])
  if (Number(count.rows[0]!.n) >= 100) throw conflict('slot_limit', 'Допустимо до 100 позиций услуг в свадьбе')
  const id = uuidv7()
  await client.query('insert into slots(id,wedding_id,category_id,program_event_id,label,sort) values($1,$2,$3,$4,$5,(select coalesce(max(sort),0)+1 from slots where wedding_id=$2))',
    [id, input.weddingId, input.categoryId, input.programEventId, input.label])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.slot_created','slot',$2,$3::jsonb)",
    [input.actor.userId, id, JSON.stringify({ weddingId: input.weddingId, programEventId: input.programEventId, draftOnly: true })])
  return { id, categoryId: input.categoryId, programEventId: input.programEventId, label: input.label }
}
export interface CreateOrderAssignmentInput extends OrderWriteInput { slotId: string; programEventId: string; label: string }
export async function createOrderAssignment(client: Queryable, input: CreateOrderAssignmentInput): Promise<OrderDto> {
  const context = await lockDraftOrder(client, input)
  checkEntityId(input.slotId, 'slotId'); checkEntityId(input.programEventId, 'programEventId')
  if (context.actorRole !== 'couple') throw forbidden('Назначения на мероприятия меняет пара')
  boundedText(input.label, 'label')
  const slot = await client.query<{ category_id: string; program_event_id: string | null; deal_id: string | null }>(
    'select category_id,program_event_id,deal_id from slots where wedding_id=$1 and id=$2 for update', [input.weddingId, input.slotId])
  const s = slot.rows[0]; if (!s) throw notFound('Позиция услуги не найдена')
  if (s.deal_id !== null && s.deal_id !== input.dealId.toLowerCase()) throw conflict('slot_taken', 'Позиция занята другим заказом')
  if (s.category_id !== context.categoryId) throw validationFailed({ slotId: 'Назначение должно соответствовать категории заказа' })
  if (input.slotId.toLowerCase() !== context.slotId && (s.deal_id !== null || s.program_event_id === null)) throw validationFailed({ slotId: 'Создайте отдельную позицию для этого мероприятия' })
  if (s.program_event_id !== null && s.program_event_id !== input.programEventId.toLowerCase()) throw validationFailed({ programEventId: 'Мероприятие отличается от выбранной позиции' })
  const event = await client.query('select id from wedding_events where wedding_id=$1 and id=$2 for share', [input.weddingId, input.programEventId])
  if (!event.rows[0]) throw notFound('Мероприятие не найдено')
  const occupied = await client.query('select id from order_assignments where slot_id=$1 and cancelled_at is null for update', [input.slotId])
  if (occupied.rows[0]) throw conflict('slot_taken', 'В этой позиции уже есть назначение')
  const id = uuidv7()
  await client.query("insert into order_assignments(id,wedding_id,deal_id,slot_id,program_event_id,source,label,created_by) values($1,$2,$3,$4,$5,'structured',$6,$7)",
    [id, input.weddingId, input.dealId, input.slotId, input.programEventId, input.label, input.actor.userId])
  return recordOrderChange(client, input, 'order.assignment_created', id)
}
export interface CancelOrderAssignmentInput extends OrderWriteInput { assignmentId: string; expectedAssignmentVersion: string }
/** Cancels this draft scope; does not cancel the contract, payments or legacy day hold. */
export async function cancelOrderAssignment(client: Queryable, input: CancelOrderAssignmentInput): Promise<OrderDto> {
  const context = await lockDraftOrder(client, input)
  checkEntityId(input.assignmentId, 'assignmentId')
  if (context.actorRole !== 'couple') throw forbidden('Назначения на мероприятия меняет пара')
  const assignment = await client.query<{ version: string; cancelled_at: Date | null }>(
    'select version::text,cancelled_at from order_assignments where wedding_id=$1 and deal_id=$2 and id=$3 for update', [input.weddingId, input.dealId, input.assignmentId])
  const a = assignment.rows[0]; if (!a) throw notFound('Назначение не найдено')
  checkVersion(a.version, input.expectedAssignmentVersion, 'expectedAssignmentVersion')
  if (a.cancelled_at) return readOrder(client, input)
  await client.query('select id from order_parts where wedding_id=$1 and deal_id=$2 and assignment_id=$3 order by id for update', [input.weddingId, input.dealId, input.assignmentId])
  await client.query('update order_parts set cancelled_at=now(),version=version+1,modified_at=now() where wedding_id=$1 and deal_id=$2 and assignment_id=$3 and cancelled_at is null', [input.weddingId, input.dealId, input.assignmentId])
  await client.query('update order_assignments set cancelled_at=now(),version=version+1 where wedding_id=$1 and deal_id=$2 and id=$3', [input.weddingId, input.dealId, input.assignmentId])
  return recordOrderChange(client, input, 'order.assignment_cancelled', input.assignmentId)
}
