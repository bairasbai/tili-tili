import type { Queryable } from '../plugins/db.js'
import { conflict, notFound, validationFailed } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { EXECUTION_KINDS, validateBrief, type ExecutionKind } from './catalog.js'
import { lockOrderContext, type OrderActor } from './context.js'

export interface OrderInput { weddingId: string; dealId: string; actor: OrderActor }
export interface OrderWriteInput extends OrderInput { expectedVersion: string }
type IntervalDetails = { startsAt: string | null; endsAt: string | null; location: string | null;
  setupMinutes: number | null; teardownMinutes: number | null; travelMinutes: number | null }
export interface PartDetails {
  timed_service: IntervalDetails
  appointment: IntervalDetails
  supply: { quantity: number | null; unit: string | null; windowStartsAt: string | null;
    windowEndsAt: string | null; location: string | null; recipient: string | null; substitutions: string | null }
  rental: { quantity: number | null; unit: string | null; handoverAt: string | null; returnAt: string | null;
    location: string | null; recipient: string | null; condition: string | null; depositTerms: string | null }
  deliverable: { items: string[] | null; dueAt: string | null; recipient: string | null; reviewProcess: string | null }
}
export type OrderPartDto = { [K in ExecutionKind]: { id: string; kind: K; version: string; assignmentId: string | null;
  source: 'legacy' | 'structured'; title: string; details: PartDetails[K]; cancelledAt: string | null } }[ExecutionKind]
export interface AssignmentDto { id: string; slotId: string; programEventId: string; version: string;
  source: 'legacy' | 'structured'; label: string; cancelledAt: string | null }
export interface OrderDto { dealId: string; version: string; schemaVersion: 1; source: 'legacy' | 'structured';
  brief: { categoryId: string; subtypeId?: string; values: Record<string, unknown> } | null;
  assignments: AssignmentDto[]; parts: OrderPartDto[] }
export function checkVersion(actual: string, expected: string, field = 'expectedVersion', allowZero = false): void {
  if (typeof expected !== 'string' || !(allowZero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(expected)) {
    throw validationFailed({ [field]: 'Нужна точная версия' })
  }
  if (actual !== expected) throw conflict('order_version_conflict', 'Данные изменились — обновите заказ')
}
export function boundedText(value: unknown, field: string, max = 200): asserts value is string {
  const controls = typeof value === 'string' && Array.from(value).some(c => { const code = c.charCodeAt(0); return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13) })
  if (typeof value !== 'string' || !value.trim() || value.length > max || controls) {
    throw validationFailed({ [field]: 'Нужен текст допустимой длины' })
  }
}
export function checkEntityId(value: unknown, field: string): asserts value is string {
  if (!isUuid(value)) throw validationFailed({ [field]: 'Нужен идентификатор' })
}
export function objectValues(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) throw validationFailed({ [field]: 'Нужен простой объект' })
  const keys = Reflect.ownKeys(value)
  if (keys.length > 64 || keys.some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
    throw validationFailed({ [field]: 'Недопустимые поля' })
  }
  return value as Record<string, unknown>
}
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(k => Object.hasOwn(right, k) && sameJson(left[k], right[k]))
}
const FIELDS: Record<ExecutionKind, readonly string[]> = {
  timed_service: ['startsAt', 'endsAt', 'location', 'setupMinutes', 'teardownMinutes', 'travelMinutes'],
  appointment: ['startsAt', 'endsAt', 'location', 'setupMinutes', 'teardownMinutes', 'travelMinutes'],
  supply: ['quantity', 'unit', 'windowStartsAt', 'windowEndsAt', 'location', 'recipient', 'substitutions'],
  rental: ['quantity', 'unit', 'handoverAt', 'returnAt', 'location', 'recipient', 'condition', 'depositTerms'],
  deliverable: ['items', 'dueAt', 'recipient', 'reviewProcess'],
}
function instant(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw validationFailed({ [field]: 'Нужна дата и время с часовым поясом' })
  const [date, time] = value.split('T'), [year, month, day] = date!.split('-').map(Number)
  const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate()
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(value)
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || day! > days || Number(time!.slice(0, 2)) > 23 || Number(time!.slice(3, 5)) > 59 || Number(time!.slice(6, 8)) > 59 ||
    (offset && (Number(offset[2]) > 14 || Number(offset[3]) > 59 || (Number(offset[2]) === 14 && Number(offset[3]) !== 0))) || !Number.isFinite(Date.parse(value))) {
    throw validationFailed({ [field]: 'Недопустимая дата или время' })
  }
}
/** Draft values stay nullable; this validates scope, not agreement or reservation. */
export function validatePartDetails<K extends ExecutionKind>(kind: K, value: unknown): PartDetails[K] {
  if (!EXECUTION_KINDS.includes(kind)) throw validationFailed({ kind: 'Неизвестный вид работы' })
  const details = objectValues(value, 'details'), fields = FIELDS[kind], result: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(details) as string[]) if (!fields.includes(key)) throw validationFailed({ [`details.${key}`]: 'Поле не относится к этому виду работы' })
  for (const key of fields) {
    const v = details[key] ?? null
    if (v !== null) {
      if (key.endsWith('At')) instant(v, `details.${key}`)
      else if (key === 'quantity' || key.endsWith('Minutes')) {
        const min = key === 'quantity' ? 1 : 0, max = key === 'quantity' ? 1_000_000 : 10_080
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw validationFailed({ [`details.${key}`]: 'Нужное целое число вне допустимого диапазона' })
      } else if (key === 'items') {
        if (!Array.isArray(v) || v.length > 100) throw validationFailed({ 'details.items': 'Допустимо до 100 пунктов' })
        for (const item of v) boundedText(item, 'details.items', 500)
      } else boundedText(v, `details.${key}`, key === 'unit' ? 80 : 2000)
    }
    result[key] = v
  }
  for (const [start, end, equal] of [['startsAt', 'endsAt', false], ['windowStartsAt', 'windowEndsAt', false], ['handoverAt', 'returnAt', true]] as const) {
    if (result[start] !== undefined && result[start] !== null && result[end] !== null && result[end] !== undefined) {
      const a = Date.parse(result[start] as string), b = Date.parse(result[end] as string)
      if (equal ? b < a : b <= a) throw validationFailed({ [`details.${end}`]: 'Конец должен следовать за началом' })
    }
  }
  return result as unknown as PartDetails[K]
}
/** Internal projection. Call only after locking and authorizing the order in this transaction. */
export async function readOrder(client: Queryable, input: Pick<OrderInput, 'weddingId' | 'dealId'>): Promise<OrderDto> {
  const root = await client.query<{ version: string; source: 'legacy' | 'structured'; brief_category_id: string | null; brief_subtype_id: string | null; brief: Record<string, unknown> | null }>(
    'select version::text,source,brief_category_id,brief_subtype_id,brief from deal_orders where wedding_id=$1 and deal_id=$2', [input.weddingId, input.dealId])
  const r = root.rows[0]; if (!r) throw notFound('Заказ не найден')
  const assignments = await client.query<{ id: string; slot_id: string; program_event_id: string; version: string; source: 'legacy' | 'structured'; label: string; cancelled_at: Date | null }>(
    'select id,slot_id,program_event_id,version::text,source,label,cancelled_at from order_assignments where wedding_id=$1 and deal_id=$2 order by created_at,id', [input.weddingId, input.dealId])
  const parts = await client.query<{ id: string; kind: ExecutionKind; version: string; assignment_id: string | null; source: 'legacy' | 'structured'; title: string; details: PartDetails[ExecutionKind]; cancelled_at: Date | null }>(
    'select id,kind,version::text,assignment_id,source,title,details,cancelled_at from order_parts where wedding_id=$1 and deal_id=$2 order by created_at,id', [input.weddingId, input.dealId])
  return { dealId: input.dealId.toLowerCase(), version: r.version, schemaVersion: 1, source: r.source,
    brief: r.brief === null ? null : { categoryId: r.brief_category_id!, ...(r.brief_subtype_id ? { subtypeId: r.brief_subtype_id } : {}), values: r.brief },
    assignments: assignments.rows.map(a => ({ id: a.id, slotId: a.slot_id, programEventId: a.program_event_id, version: a.version, source: a.source, label: a.label, cancelledAt: a.cancelled_at?.toISOString() ?? null })),
    parts: parts.rows.map(p => ({ id: p.id, kind: p.kind, version: p.version, assignmentId: p.assignment_id, source: p.source, title: p.title, details: p.details, cancelledAt: p.cancelled_at?.toISOString() ?? null }) as OrderPartDto) }
}
export async function loadOrder(client: Queryable, input: OrderInput): Promise<OrderDto> {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.dealId, 'dealId')
  await lockOrderContext(client, input.weddingId, input.dealId, input.actor, false)
  return readOrder(client, input)
}
export async function lockDraftOrder(client: Queryable, input: OrderWriteInput) {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.dealId, 'dealId')
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor)
  const root = await client.query<{ version: string }>('select version::text from deal_orders where wedding_id=$1 and deal_id=$2 for update', [input.weddingId, input.dealId])
  if (!root.rows[0]) throw notFound('Заказ не найден')
  checkVersion(root.rows[0].version, input.expectedVersion)
  return context
}
export async function recordOrderChange(client: Queryable, input: OrderWriteInput, action: string, entityId: string,
  resourcePlan?: { id: string; revision: string }): Promise<OrderDto> {
  if (resourcePlan) await client.query(`update deal_orders set version=version+1,source='structured',modified_at=now(),
    resource_plan_id=$3,resource_plan_revision=$4 where wedding_id=$1 and deal_id=$2`,
  [input.weddingId, input.dealId, resourcePlan.id, resourcePlan.revision])
  else await client.query("update deal_orders set version=version+1,source='structured',modified_at=now() where wedding_id=$1 and deal_id=$2", [input.weddingId, input.dealId])
  await client.query('insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,\'order\',$3,$4::jsonb)',
    [input.actor.userId, action, input.dealId, JSON.stringify({ draftOnly: true, changedEntityId: entityId, beforeVersion: input.expectedVersion })])
  return readOrder(client, input)
}
export async function patchOrderBrief(client: Queryable, input: OrderWriteInput & { brief: { subtypeId?: string; values: Record<string, unknown> } | null }): Promise<OrderDto> {
  const context = await lockDraftOrder(client, input), before = await readOrder(client, input)
  if (input.brief !== null) {
    const brief = objectValues(input.brief, 'brief')
    if (Object.keys(brief).some(k => !['subtypeId', 'values'].includes(k)) || (brief.subtypeId !== undefined && typeof brief.subtypeId !== 'string')) throw validationFailed({ brief: 'Недопустимый состав брифа' })
    const errors = validateBrief(context.categoryId, brief.values, brief.subtypeId as string | undefined)
    if (errors.length) throw validationFailed(Object.fromEntries(errors.map(e => [`brief.${e.field}`, e.code])))
  }
  const after = input.brief === null ? null : { categoryId: context.categoryId, ...(input.brief.subtypeId !== undefined ? { subtypeId: input.brief.subtypeId } : {}), values: input.brief.values }
  if (sameJson(before.brief, after)) return before
  await client.query('update deal_orders set brief_category_id=$3,brief_subtype_id=$4,brief=$5::jsonb where wedding_id=$1 and deal_id=$2',
    [input.weddingId, input.dealId, after?.categoryId ?? null, after?.subtypeId ?? null, after ? JSON.stringify(after.values) : null])
  return recordOrderChange(client, input, 'order.brief_changed', input.dealId)
}
export interface CreateOrderPartInput extends OrderWriteInput { kind: ExecutionKind; assignmentId?: string | null; title: string; details: unknown }
export async function createOrderPart(client: Queryable, input: CreateOrderPartInput): Promise<OrderDto> {
  await lockDraftOrder(client, input)
  boundedText(input.title, 'title'); const details = validatePartDetails(input.kind, input.details), assignmentId = input.assignmentId ?? null
  if (input.kind !== 'deliverable' && assignmentId === null) throw validationFailed({ assignmentId: 'Нужно назначение на мероприятие' })
  if (assignmentId !== null) await activeAssignment(client, input, assignmentId)
  const id = uuidv7()
  await client.query("insert into order_parts(id,wedding_id,deal_id,assignment_id,kind,source,title,details,created_by) values($1,$2,$3,$4,$5,'structured',$6,$7::jsonb,$8)",
    [id, input.weddingId, input.dealId, assignmentId, input.kind, input.title, JSON.stringify(details), input.actor.userId])
  return recordOrderChange(client, input, 'order.part_created', id)
}
async function activeAssignment(client: Queryable, input: OrderInput, id: string): Promise<void> {
  checkEntityId(id, 'assignmentId')
  const row = await client.query('select id from order_assignments where wedding_id=$1 and deal_id=$2 and id=$3 and cancelled_at is null for update', [input.weddingId, input.dealId, id])
  if (!row.rows[0]) throw notFound('Действующее назначение не найдено')
}
export interface PatchOrderPartInput extends OrderWriteInput { partId: string; expectedPartVersion: string; title?: string; details?: unknown }
async function lockedPart(client: Queryable, input: OrderWriteInput & { partId: string; expectedPartVersion: string }) {
  checkEntityId(input.partId, 'partId')
  const part = await client.query<{ kind: ExecutionKind; title: string; details: PartDetails[ExecutionKind]; version: string; cancelled_at: Date | null }>(
    'select kind,title,details,version::text,cancelled_at from order_parts where wedding_id=$1 and deal_id=$2 and id=$3 for update', [input.weddingId, input.dealId, input.partId])
  const p = part.rows[0]; if (!p) throw notFound('Часть заказа не найдена')
  checkVersion(p.version, input.expectedPartVersion, 'expectedPartVersion'); return p
}
export async function patchOrderPart(client: Queryable, input: PatchOrderPartInput): Promise<OrderDto> {
  await lockDraftOrder(client, input); const p = await lockedPart(client, input)
  if (p.cancelled_at) throw conflict('order_part_cancelled', 'Отменённая часть не изменяется')
  if (input.title !== undefined) boundedText(input.title, 'title')
  const details = input.details === undefined ? p.details : validatePartDetails(p.kind, { ...p.details, ...objectValues(input.details, 'details') })
  const title = input.title ?? p.title
  if (title === p.title && sameJson(details, p.details)) return readOrder(client, input)
  await client.query('update order_parts set title=$4,details=$5::jsonb,version=version+1,modified_at=now() where wedding_id=$1 and deal_id=$2 and id=$3',
    [input.weddingId, input.dealId, input.partId, title, JSON.stringify(details)])
  return recordOrderChange(client, input, 'order.part_changed', input.partId)
}
export async function cancelOrderPart(client: Queryable, input: OrderWriteInput & { partId: string; expectedPartVersion: string }): Promise<OrderDto> {
  await lockDraftOrder(client, input); const p = await lockedPart(client, input)
  if (p.cancelled_at) return readOrder(client, input)
  await client.query('update order_parts set cancelled_at=now(),version=version+1,modified_at=now() where wedding_id=$1 and deal_id=$2 and id=$3', [input.weddingId, input.dealId, input.partId])
  return recordOrderChange(client, input, 'order.part_cancelled', input.partId)
}
