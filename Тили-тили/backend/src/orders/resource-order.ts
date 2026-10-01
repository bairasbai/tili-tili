import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { lockOrderPrincipal, lockOrderWedding, type OrderActor } from './context.js'
import { boundedText, checkEntityId, checkVersion, objectValues } from './model.js'

export interface ResourceOrderPreparationInput {
  weddingId: string; slotId: string; actor: OrderActor; vendorId: string; packageId: string | null
  expectedSelectedDealId: string | null; expectedPolicyRevision: string
}
export interface ResourceOrderPreparationResult {
  dealId: string; orderVersion: string; state: 'candidate' | 'contacted' | 'negotiating'; created: boolean
}
interface Slot { category_id: string; deal_id: string | null; prebooked_at: Date | null }
interface SelectedDeal { id: string; vendor_id: string | null; package_id: string | null; state: string }
interface Vendor { user_id: string; category_id: string; published_at: Date | null; blocked_at: Date | null }
interface Package { name: string; items: unknown; price: string | null }
const inputKeys = ['weddingId','slotId','actor','vendorId','packageId','expectedSelectedDealId','expectedPolicyRevision'] as const

function validate(input: ResourceOrderPreparationInput): void {
  const value = objectValues(input, 'resourceOrder')
  if (Object.keys(value).length !== inputKeys.length || Object.keys(value).some(k => !inputKeys.includes(k as typeof inputKeys[number]))) {
    throw validationFailed({ resourceOrder: 'Нужен точный состав полей подготовки заказа' })
  }
  const actor = objectValues(input.actor, 'actor')
  if (Object.keys(actor).length !== 3 || Object.keys(actor).some(k => !['userId','sessionId','policyVersion'].includes(k))) {
    throw validationFailed({ actor: 'Нужна действующая сторона, сессия и версия согласия' })
  }
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.slotId, 'slotId')
  checkEntityId(input.vendorId, 'vendorId'); checkEntityId(input.actor.userId, 'userId')
  checkEntityId(input.actor.sessionId, 'sessionId'); boundedText(input.actor.policyVersion, 'policyVersion', 100)
  if (input.packageId !== null) checkEntityId(input.packageId, 'packageId')
  if (input.expectedSelectedDealId !== null) checkEntityId(input.expectedSelectedDealId, 'expectedSelectedDealId')
  checkVersion(input.expectedPolicyRevision, input.expectedPolicyRevision, 'expectedPolicyRevision')
  if (BigInt(input.expectedPolicyRevision) > 9223372036854775807n) {
    throw validationFailed({ expectedPolicyRevision: 'Версия вне допустимого диапазона' })
  }
}
function packageUnavailable(): AppError {
  return new AppError(422, 'unknown_package', 'Такого пакета у подрядчика нет — обновите данные', { packageId: 'Нужен действующий пакет этой компании' })
}
async function lockPackage(client: Queryable, vendorId: string, packageId: string | null): Promise<Package | null> {
  if (packageId === null) return null
  const row = (await client.query<Package>('select name,items,price::text from vendor_packages where id=$1 and vendor_id=$2 for key share', [packageId, vendorId])).rows[0]
  if (!row) throw packageUnavailable()
  // Keep the actual catalogue bytes and bigint price. Unknown is still NULL;
  // invalid persisted material cannot become an invented financial snapshot.
  boundedText(row.name, 'packageId', 200)
  if (!Array.isArray(row.items) || row.items.some(item => typeof item !== 'string') ||
    (row.price !== null && (!/^\d+$/.test(row.price) || BigInt(row.price) > 9223372036854775807n))) {
    throw validationFailed({ packageId: 'Пакет содержит недопустимые условия — обновите данные' })
  }
  return row
}

/** Catalogue preparation only. The caller supplies one transaction. Selecting
 * a financial draft neither promises an interval nor reserves any resource. */
export async function prepareCatalogResourceOrder(client: Queryable, input: ResourceOrderPreparationInput): Promise<ResourceOrderPreparationResult> {
  validate(input)
  const weddingId = input.weddingId.toLowerCase(), slotId = input.slotId.toLowerCase(), vendorId = input.vendorId.toLowerCase()
  const packageId = input.packageId?.toLowerCase() ?? null, expectedDealId = input.expectedSelectedDealId?.toLowerCase() ?? null
  await lockOrderWedding(client, weddingId, true)
  await lockOrderPrincipal(client, input.actor)
  const member = (await client.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [weddingId, input.actor.userId])).rows[0]
  if (!member) throw notFound('Свадьба не найдена')
  if (member.role !== 'couple') throw forbidden('Исполнителя и финансовый заказ выбирает участник пары')
  const slot = (await client.query<Slot>('select category_id,deal_id,prebooked_at from slots where wedding_id=$1 and id=$2 for update', [weddingId, slotId])).rows[0]
  if (!slot) throw notFound('Позиция услуги не найдена')
  if (slot.prebooked_at !== null || slot.deal_id !== expectedDealId) {
    throw conflict('resource_order_slot_changed', 'Выбор исполнителя изменился — обновите позицию')
  }
  let selected: SelectedDeal | null = null, orderVersion: string | null = null
  if (expectedDealId !== null) {
    selected = (await client.query<SelectedDeal>(`select id,vendor_id,package_id,state from deals
      where wedding_id=$1 and slot_id=$2 and id=$3 for update`, [weddingId, slotId, expectedDealId])).rows[0] ?? null
    if (!selected || !['candidate','contacted','negotiating'].includes(selected.state) || selected.vendor_id !== vendorId || selected.package_id !== packageId) {
      throw conflict('resource_order_source_changed', 'Выбранный заказ уже изменился — проверьте его условия')
    }
    const order = (await client.query<{ version: string }>('select version::text from deal_orders where wedding_id=$1 and deal_id=$2 for update', [weddingId, expectedDealId])).rows[0]
    if (!order) throw conflict('resource_order_source_changed', 'Источник выбранного заказа недоступен')
    orderVersion = order.version
  }
  const assignments = await client.query<{ deal_id: string }>(`select deal_id from order_assignments
    where wedding_id=$1 and slot_id=$2 and cancelled_at is null order by id for share`, [weddingId, slotId])
  if (assignments.rows.some(a => a.deal_id !== expectedDealId)) {
    throw conflict('slot_assigned', 'Позиция уже связана с назначением другого заказа')
  }
  // Account identities are located before company locking. A changed owner
  // fails closed after the wait instead of acquiring a new account backwards.
  const located = (await client.query<{ user_id: string }>('select user_id from vendors where id=$1', [vendorId])).rows[0]
  if (!located) throw notFound('Подрядчик не найден')
  const accountIds = [...new Set([input.actor.userId.toLowerCase(), located.user_id])].sort()
  const accounts = (await client.query<{ id: string; deleted_at: Date | null }>('select id,deleted_at from users where id=any($1::uuid[]) order by id for share', [accountIds])).rows
  const vendor = (await client.query<Vendor>('select user_id,category_id,published_at,blocked_at from vendors where id=$1 for share', [vendorId])).rows[0]
  if (!vendor) throw notFound('Подрядчик не найден')
  if (vendor.user_id !== located.user_id) throw conflict('resource_order_source_changed', 'Владелец компании изменился — обновите данные')
  if (vendor.published_at === null || vendor.blocked_at !== null || !accounts.some(a => a.id === vendor.user_id && a.deleted_at === null)) {
    throw notFound('Подрядчик недоступен')
  }
  if (vendor.category_id !== slot.category_id) throw validationFailed({ vendorId: 'Категория исполнителя отличается от выбранной позиции' })
  const policy = (await client.query<{ mode: string; revision: string }>('select mode,revision::text from vendor_availability_policy where vendor_id=$1 for share', [vendorId])).rows[0]
  if (policy?.mode !== 'resources') throw conflict('resource_policy_required', 'Для подготовки этого заказа нужен режим ресурсов компании')
  checkVersion(policy.revision, input.expectedPolicyRevision, 'expectedPolicyRevision')
  const snapshot = await lockPackage(client, vendorId, packageId)
  if (selected) {
    // Catalogue changes never rewrite the already selected financial terms.
    return { dealId: selected.id, orderVersion: orderVersion!, state: selected.state as ResourceOrderPreparationResult['state'], created: false }
  }
  const dealId = uuidv7()
  await client.query(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,currency,package_id,package_title_snapshot,package_includes_snapshot)
    values($1,$2,$3,$4,'candidate',$5,'RUB',$6,$7,$8::jsonb)`, [dealId, weddingId, slotId, vendorId, snapshot?.price ?? null,
    packageId, snapshot?.name ?? null, snapshot === null ? null : JSON.stringify(snapshot.items)])
  const claimed = await client.query(`update slots set deal_id=$3 where wedding_id=$1 and id=$2 and deal_id is null and prebooked_at is null`, [weddingId, slotId, dealId])
  if (claimed.rowCount !== 1) throw conflict('resource_order_slot_changed', 'Выбор исполнителя изменился — обновите позицию')
  const order = (await client.query<{ version: string }>(`update deal_orders set source='structured'
    where wedding_id=$1 and deal_id=$2 returning version::text`, [weddingId, dealId])).rows[0]
  if (!order) throw conflict('resource_order_source_changed', 'Не удалось создать источник заказа')
  // This is a local draft selection, not a message to the performer. The
  // existing worker uses notified_at as its processing marker (including
  // suppressed events), separately from actual notification delivery receipts.
  await client.query(`insert into deal_events(id,deal_id,from_state,to_state,actor_id,notified_at)
    values($1,$2,null,'candidate',$3,clock_timestamp())`, [uuidv7(), dealId, input.actor.userId])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.resource_order_prepared','order',$2,$3::jsonb)",
    [input.actor.userId, dealId, JSON.stringify({ draftOnly: true, slotId, vendorId, packageId, state: 'candidate' })])
  return { dealId, orderVersion: order.version, state: 'candidate', created: true }
}
