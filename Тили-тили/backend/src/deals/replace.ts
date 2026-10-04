import type { EnrolledEmission } from '../notify/enrolled.js'
import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import { boundedText, checkEntityId, checkVersion, objectValues } from '../orders/model.js'
import { assertLegacyDateBookingAllowed } from '../resources/booking-boundary.js'
import { bookVendor, lockBookingActor, lockBookingContext } from './book.js'
import { cancelDeal } from './cancel.js'

export interface ReplaceLegacySlotInput {
  weddingId: string; slotId: string; actorId: string; sessionId: string; policyVersion: string
  expectedSelectedDealId: string
  expectedSelectedDealState: 'candidate' | 'contacted' | 'negotiating' | 'booked' | 'paid_deposit'
  vendorId: string; packageId?: string; price: number; expectedPolicyRevision: string
}
interface Selected { deal_id: string | null; prebooked_at: Date | null; vendor_id: string | null; state: string }
interface Company { id: string; user_id: string; category_id: string; published_at: Date | null; blocked_at: Date | null }
const states = ['candidate', 'contacted', 'negotiating', 'booked', 'paid_deposit'] as const
const keys = ['weddingId', 'slotId', 'actorId', 'sessionId', 'policyVersion', 'expectedSelectedDealId',
  'expectedSelectedDealState', 'vendorId', 'price', 'expectedPolicyRevision'] as const
const sorted = (ids: string[]) => [...new Set(ids)].sort()

function validate(input: ReplaceLegacySlotInput): void {
  const value = objectValues(input, 'replacement')
  if (keys.some(key => !Object.hasOwn(value, key)) || (Reflect.ownKeys(value) as string[]).some(key =>
    key !== 'packageId' && !keys.includes(key as typeof keys[number]))) {
    throw validationFailed({ replacement: 'Нужен точный состав полей замены исполнителя' })
  }
  for (const field of ['weddingId', 'slotId', 'actorId', 'sessionId', 'expectedSelectedDealId', 'vendorId'] as const) {
    checkEntityId(input[field], field)
  }
  if (Object.hasOwn(value, 'packageId')) checkEntityId(input.packageId, 'packageId')
  boundedText(input.policyVersion, 'policyVersion', 100)
  if (!states.includes(input.expectedSelectedDealState)) throw validationFailed({ expectedSelectedDealState: 'Нужен действующий этап выбранного заказа' })
  if (!Number.isSafeInteger(input.price) || input.price <= 0) throw validationFailed({ price: 'Нужна положительная сумма в копейках' })
  checkVersion(input.expectedPolicyRevision, input.expectedPolicyRevision, 'expectedPolicyRevision', true)
  if (BigInt(input.expectedPolicyRevision) > 9223372036854775807n) throw validationFailed({ expectedPolicyRevision: 'Версия вне допустимого диапазона' })
}
function assertSelected(selected: Selected | undefined, input: ReplaceLegacySlotInput): asserts selected is Selected {
  if (!selected) throw notFound('Позиция услуги не найдена')
  if (selected.prebooked_at !== null || selected.deal_id !== input.expectedSelectedDealId) {
    throw conflict('resource_order_slot_changed', 'Выбор исполнителя изменился — обновите позицию')
  }
  if (selected.state !== input.expectedSelectedDealState || !states.some(state => state === selected.state)) {
    throw conflict('resource_order_source_changed', 'Выбранный заказ уже изменился — проверьте его условия')
  }
  if (selected.vendor_id === input.vendorId) throw validationFailed({ vendorId: 'Для замены нужен другой исполнитель' })
}
async function rejectOldResources(client: Queryable, input: ReplaceLegacySlotInput): Promise<void> {
  const live = await client.query(`select id from resource_allocations
    where wedding_id=$1 and deal_id=$2 and released_at is null limit 1`, [input.weddingId, input.expectedSelectedDealId])
  if (live.rowCount) throw conflict('resource_booking_required', 'Замену согласованной брони ресурсов нужно согласовать отдельно')
}

/** Caller supplies ONE transaction: an error must roll back cancellation and
 * booking together. This legacy-only door never converts a resource promise.
 * The existing cancellation and booking kernels own all their side effects. */
export async function replaceLegacySlotBooking(client: Queryable, supplied: ReplaceLegacySlotInput, emissions?: EnrolledEmission): Promise<string> {
  validate(supplied)
  const input: ReplaceLegacySlotInput = { ...supplied, weddingId: supplied.weddingId.toLowerCase(), slotId: supplied.slotId.toLowerCase(),
    actorId: supplied.actorId.toLowerCase(), sessionId: supplied.sessionId.toLowerCase(),
    expectedSelectedDealId: supplied.expectedSelectedDealId.toLowerCase(), vendorId: supplied.vendorId.toLowerCase(),
    ...(supplied.packageId === undefined ? {} : { packageId: supplied.packageId.toLowerCase() }) }
  const wedding = (await client.query<{ owner_id: string; date: string | null }>(`select owner_id,date::text from weddings
    where id=$1 and archived_at is null and cancelled_at is null for update`, [input.weddingId])).rows[0]
  if (!wedding) throw notFound('Свадьба не найдена')
  await lockBookingActor(client, input)
  // Location is not authority. Pin request mutexes before the selected root,
  // matching profile package deletion and all offer booking doors.
  const locate = `select s.deal_id,s.prebooked_at,d.vendor_id,d.state from slots s
    left join deals d on d.id=s.deal_id and d.wedding_id=s.wedding_id and d.slot_id=s.id
    where s.wedding_id=$1 and s.id=$2`
  assertSelected((await client.query<Selected>(locate, [input.weddingId, input.slotId])).rows[0], input)
  if (wedding.date === null) throw conflict('booking_date_required', 'Сначала укажите дату свадьбы')
  await client.query('select id from offer_requests where slot_id=$1 order by id for update', [input.slotId])
  const deal = (await client.query<{ vendor_id: string | null; state: string }>(`select vendor_id,state from deals
    where wedding_id=$1 and slot_id=$2 and id=$3 for update`, [input.weddingId, input.slotId, input.expectedSelectedDealId])).rows[0]
  const slot = (await client.query<{ deal_id: string | null; prebooked_at: Date | null; category_id: string }>(
    'select deal_id,prebooked_at,category_id from slots where wedding_id=$1 and id=$2 for update', [input.weddingId, input.slotId])).rows[0]
  const selected = slot && deal ? { ...slot, ...deal } : undefined
  assertSelected(selected, input)
  const order = await client.query('select deal_id from deal_orders where wedding_id=$1 and deal_id=$2 for update',
    [input.weddingId, input.expectedSelectedDealId])
  if (!order.rowCount) throw conflict('resource_order_source_changed', 'Источник выбранного заказа недоступен')
  const head = (await client.query<{ state: string }>(`select state from deal_resource_commitments
    where wedding_id=$1 and deal_id=$2 for update`, [input.weddingId, input.expectedSelectedDealId])).rows[0]
  if (head?.state === 'reserved') throw conflict('resource_booking_required', 'Замену согласованной брони ресурсов нужно согласовать отдельно')
  await rejectOldResources(client, input)

  // Cancellation may read a historical company after vendor erasure or a
  // previous release. Locate the full union before taking ANY company lock;
  // a changed owner fails closed instead of taking a new account backwards.
  const historical = (await client.query<{ vendor_id: string | null }>(`select distinct vendor_id
    from deal_resource_commitment_versions where wedding_id=$1 and deal_id=$2`, [input.weddingId, input.expectedSelectedDealId])).rows
  const companyIds = sorted([input.vendorId, ...(selected.vendor_id ? [selected.vendor_id] : []),
    ...historical.flatMap(version => version.vendor_id ? [version.vendor_id] : [])])
  const located = (await client.query<{ id: string; user_id: string }>(
    'select id,user_id from vendors where id=any($1::uuid[]) order by id', [companyIds])).rows
  if (!located.some(company => company.id === input.vendorId)) throw notFound('Подрядчик не найден')
  const accountIds = sorted([input.actorId, wedding.owner_id, ...located.map(company => company.user_id)])
  const accounts = (await client.query<{ id: string; deleted_at: Date | null }>(
    'select id,deleted_at from users where id=any($1::uuid[]) order by id for share', [accountIds])).rows
  const companies = (await client.query<Company>(`select id,user_id,category_id,published_at,blocked_at from vendors
    where id=any($1::uuid[]) order by id for share`, [companyIds])).rows
  if (companies.length !== located.length || located.some(company => !companies.some(current =>
    current.id === company.id && current.user_id === company.user_id))) {
    throw conflict('resource_source_changed', 'Исполнитель изменился — обновите данные')
  }
  const policies = (await client.query<{ vendor_id: string; mode: string; revision: string }>(`select vendor_id,mode,revision::text
    from vendor_availability_policy where vendor_id=any($1::uuid[]) order by vendor_id for share`, [companyIds])).rows
  // Re-check after every possible account/company/policy wait using the
  // already pinned scope, never acquiring a newly discovered identity.
  await lockBookingActor(client, input)
  assertSelected((await client.query<Selected>(locate, [input.weddingId, input.slotId])).rows[0], input)
  await rejectOldResources(client, input)
  const vendor = companies.find(company => company.id === input.vendorId)
  if (!vendor || vendor.published_at === null || vendor.blocked_at !== null ||
    !accounts.some(account => account.id === vendor.user_id && account.deleted_at === null)) throw notFound('Подрядчик недоступен')
  // The slot and company rows are pinned after their respective waits. The
  // current catalogue category is authority, never a frontend filter or old
  // location read. Reject before cancellation or any financial mutation.
  if (vendor.category_id !== slot!.category_id) throw validationFailed({ vendorId: 'Категория исполнителя отличается от выбранной позиции' })
  if (selected.vendor_id && policies.some(policy => policy.vendor_id === selected.vendor_id && policy.mode === 'resources')) {
    throw conflict('resource_booking_required', 'Для этого заказа нужна согласованная замена ресурсов')
  }
  const policy = policies.find(policy => policy.vendor_id === input.vendorId)
  if (policy && policy.mode !== 'legacy_day') throw conflict('resource_booking_required', 'Для этого исполнителя нужно согласовать заказ и забронировать его ресурсы')
  checkVersion(policy?.revision ?? '0', input.expectedPolicyRevision, 'expectedPolicyRevision', true)
  await assertLegacyDateBookingAllowed(client, input.vendorId)
  // Refuse an already occupied foreign day before locking/releasing the old
  // DATE. In particular, two weddings cannot form an A→B/B→A DATE lock cycle.
  // Concurrent first occupancy remains protected by bookVendor's unique key.
  const busy = (await client.query<{ mine: boolean }>(`select exists(select 1 from deals d
    where d.id=b.deal_id and d.wedding_id=$3) as mine from vendor_busy_dates b
    where b.vendor_id=$1 and b.date=$2::date`, [input.vendorId, wedding.date, input.weddingId])).rows[0]
  if (busy && !busy.mine) throw new AppError(409, 'date_taken', 'Эта дата у подрядчика уже занята')

  await cancelDeal(client, input.expectedSelectedDealId, { actorId: input.actorId, sessionId: input.sessionId, policyVersion: input.policyVersion })
  const context = await lockBookingContext(client, input)
  return bookVendor(client, context, { performer: { kind: 'catalog', vendorId: input.vendorId,
    ...(input.packageId === undefined ? {} : { packageId: input.packageId }) }, price: input.price }, emissions)
}
