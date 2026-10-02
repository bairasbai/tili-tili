import type { Queryable } from '../plugins/db.js'
import { conflict } from '../errors.js'

/** Internal booking mutex only, never an ACL. Call after wedding/deal/request
 * locks. Batch callers pin the whole account union before any company lock. */
export async function lockLegacyBookingCompanies(client: Queryable, vendorIds: readonly string[]): Promise<void> {
  const ids = [...new Set(vendorIds.map(id => id.toLowerCase()))].sort()
  const located = (await client.query<{ id: string; user_id: string }>(
    'select id,user_id from vendors where id=any($1::uuid[]) order by id', [ids])).rows
  const accounts = [...new Set(located.map(v => v.user_id))].sort()
  await client.query('select id from users where id=any($1::uuid[]) order by id for share', [accounts])
  const pinned = (await client.query<{ id: string; user_id: string }>(
    'select id,user_id from vendors where id=any($1::uuid[]) order by id for share', [ids])).rows
  if (pinned.length !== located.length || located.some(v => !pinned.some(p => p.id === v.id && p.user_id === v.user_id))) {
    throw conflict('resource_source_changed', 'Исполнитель изменился — обновите данные')
  }
}

/** A DATE-only hold cannot stand in for an agreed resource reservation, even
 * after a policy downgrade. Retained live allocations continue to protect it. */
export async function assertLegacyDateBookingAllowed(client: Queryable, vendorId: string): Promise<void> {
  await lockLegacyBookingCompanies(client, [vendorId])
  const policy = (await client.query<{ mode: string }>(
    'select mode from vendor_availability_policy where vendor_id=$1 for share', [vendorId])).rows[0]
  const live = await client.query('select id from resource_allocations where vendor_id=$1 and released_at is null limit 1', [vendorId])
  if (policy?.mode === 'resources' || live.rowCount) {
    throw conflict('resource_booking_required', 'Для этого исполнителя нужно согласовать заказ и забронировать его ресурсы')
  }
}
