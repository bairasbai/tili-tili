import type { Queryable } from '../plugins/db.js'
import type { OrderActor } from '../orders/context.js'
import { lockOrderPrincipal } from '../orders/context.js'
import { conflict } from '../errors.js'

interface PackageScope { vendorId: string | null; weddings: string[]; requests: string[]; deals: string[] }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sorted = (ids: string[]) => [...new Set(ids)].sort()

async function locate(client: Queryable, userId: string, retainedIds: string[] | null): Promise<PackageScope> {
  const vendorId = (await client.query<{ id: string }>('select id from vendors where user_id=$1', [userId])).rows[0]?.id ?? null
  if (vendorId === null || retainedIds === null) return { vendorId, weddings: [], requests: [], deals: [] }
  const removed = (await client.query<{ id: string }>(`select id from vendor_packages
    where vendor_id=$1 and id<>all($2::uuid[]) order by id`, [vendorId, retainedIds])).rows.map(p => p.id)
  const deals = (await client.query<{ id: string; wedding_id: string }>(
    'select id,wedding_id from deals where package_id=any($1::uuid[]) order by id', [removed])).rows
  const requests = (await client.query<{ id: string; wedding_id: string }>(`select distinct r.id,s.wedding_id
    from offers o join offer_requests r on r.id=o.request_id join slots s on s.id=r.slot_id
    where o.package_id=any($1::uuid[]) order by r.id`, [removed])).rows
  return { vendorId, weddings: sorted([...deals.map(d => d.wedding_id), ...requests.map(r => r.wedding_id)]),
    requests: requests.map(r => r.id), deals: deals.map(d => d.id) }
}

/** Removing a catalogue package updates its deal/offer references through FK
 * SET NULL. Pin those weddings and request mutexes before the company, as
 * booking and order writers do. Locate again after the company mutex; a newly
 * discovered scope must retry rather than acquire a wedding backwards. */
export async function lockVendorProfileWrite(client: Queryable, actor: OrderActor,
  incomingPackages: readonly { id?: string }[] | undefined): Promise<void> {
  // Invalid/foreign IDs are still rejected by the profile's exact validation.
  // Only UUIDs reach this preliminary SQL cast; this is not package authority.
  const retainedIds = incomingPackages === undefined ? null : sorted(incomingPackages.flatMap(p =>
    p.id !== undefined && uuid.test(p.id) ? [p.id.toLowerCase()] : []))
  const located = await locate(client, actor.userId, retainedIds)
  await client.query('select id from weddings where id=any($1::uuid[]) order by id for update', [located.weddings])
  await client.query('select id from offer_requests where id=any($1::uuid[]) order by id for update', [located.requests])
  await client.query('select id from deals where id=any($1::uuid[]) order by id for update', [located.deals])
  // There is no company row to lock on first creation. Use its unique owner
  // as the mutex before taking SHARE, avoiding two concurrent SHARE upgrades.
  if (located.vendorId === null) await client.query('select id from users where id=$1 for update', [actor.userId])
  await lockOrderPrincipal(client, actor)
  if (located.vendorId !== null) {
    await client.query('select id from vendors where id=$1 for update', [located.vendorId])
  }
  const current = await locate(client, actor.userId, retainedIds)
  if (current.vendorId !== located.vendorId || current.weddings.some(id => !located.weddings.includes(id)) ||
    current.requests.some(id => !located.requests.includes(id)) || current.deals.some(id => !located.deals.includes(id))) {
    throw conflict('vendor_profile_scope_changed', 'Связанные заказы изменились — обновите анкету и повторите сохранение')
  }
}
