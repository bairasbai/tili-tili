import type { Queryable } from '../plugins/db.js'
import { forbidden, notFound, validationFailed } from '../errors.js'
import { lockOrderContext } from './context.js'
import { checkVersion, readOrder, type OrderInput, type OrderWriteInput } from './model.js'

export interface ExternalContactWrite extends OrderWriteInput { name: string; phone: string | null }

/** Run before AJV coercion as well as at the domain boundary. */
export function validateExternalContact(value: unknown): asserts value is Omit<ExternalContactWrite, keyof OrderInput> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationFailed({ body: 'Нужен внешний контакт' })
  const body = value as Record<string, unknown>
  if (Object.keys(body).some(k => !['expectedVersion', 'name', 'phone'].includes(k))) throw validationFailed({ body: 'Неизвестное поле' })
  if (typeof body.expectedVersion !== 'string' || !/^[1-9]\d{0,18}$/.test(body.expectedVersion)) throw validationFailed({ expectedVersion: 'Нужна точная версия' })
  const controls = (s: string) => Array.from(s).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 120 || controls(body.name)) throw validationFailed({ name: 'Имя: от 2 до 120 символов без управляющих символов' })
  if (body.phone !== null && (typeof body.phone !== 'string' || body.phone.length > 32 || controls(body.phone))) throw validationFailed({ phone: 'Телефон: до 32 символов или пустое значение' })
}

/** Pins authority, external identity and root version before idempotency waits.
 * Replay deliberately does not compare the old expectedVersion. */
export async function lockExternalContact(client: Queryable, input: OrderInput, write = true): Promise<string> {
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor, write)
  if (context.actorRole !== 'couple' || context.vendorId !== null) throw notFound('Внешний заказ не найден')
  const external = await client.query('select id from deals where wedding_id=$1 and id=$2 and vendor_id is null and external_name is not null', [input.weddingId, input.dealId])
  if (!external.rowCount) throw notFound('Внешний заказ не найден')
  if (write && !['booked', 'paid_deposit'].includes(context.state)) throw forbidden('Контакт закрытого заказа не изменяется')
  const root = await client.query<{ version: string }>(`select version::text from deal_orders where wedding_id=$1 and deal_id=$2 for ${write ? 'update' : 'share'}`, [input.weddingId, input.dealId])
  if (!root.rows[0]) throw notFound('Заказ не найден')
  return root.rows[0].version
}

export async function patchExternalContact(client: Queryable, input: ExternalContactWrite) {
  validateExternalContact({ expectedVersion: input.expectedVersion, name: input.name, phone: input.phone })
  const version = await lockExternalContact(client, input)
  checkVersion(version, input.expectedVersion)
  const before = await readOrder(client, input), name = input.name.trim(), phone = input.phone?.trim() || null
  if (before.externalContact?.name === name && before.externalContact.phone === phone) return before
  const changedFields = ['name', 'phone'].filter(field => before.externalContact?.[field as 'name' | 'phone'] !== (field === 'name' ? name : phone))
  await client.query('update deals set external_name=$3,external_phone=$4 where wedding_id=$1 and id=$2', [input.weddingId, input.dealId, name, phone])
  await client.query('update deal_orders set version=version+1,modified_at=now() where wedding_id=$1 and deal_id=$2', [input.weddingId, input.dealId])
  // Keep contact data out of the immutable audit; published terms remain intact.
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.external_contact_changed','order',$2,$3::jsonb)",
    [input.actor.userId, input.dealId, JSON.stringify({ changedFields, authorRole: 'couple', beforeVersion: version })])
  return readOrder(client, input)
}
