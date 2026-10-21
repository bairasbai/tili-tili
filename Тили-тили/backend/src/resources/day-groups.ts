import type { Queryable } from '../plugins/db.js'

/** Internal caller-TX SQL facade. It carries no actor, permission or DATE
 * policy. The caller pins its existing financial/authority prefix and the
 * complete vendor union before touching groups or appending a ledger version.
 */
export interface LegacyDayGroup {
  day_id: string
  vendor_id: string
  service_date: string
  wedding_id: string | null
  classification: 'exact' | 'legacy_unknown' | 'opaque'
  legacy_candidates: string[]
  revision: string
}
const GROUP_COLUMNS = `day_id::text,vendor_id::text,service_date::text,wedding_id::text,
  classification,legacy_candidates,revision::text`

export async function lockLegacyDayVendors(client: Queryable, vendorIds: readonly string[]): Promise<void> {
  await client.query('select legacy_day_lock_vendors($1::uuid[])', [vendorIds])
}

export async function touchLegacyDayGroup(
  client: Queryable, dayId: string, weddingId: string | null, sourceRevision: string,
): Promise<LegacyDayGroup> {
  return (await client.query<LegacyDayGroup>(
    `select ${GROUP_COLUMNS} from legacy_day_group_touch($1::uuid,$2::uuid,$3::bigint)`,
    [dayId, weddingId, sourceRevision],
  )).rows[0]!
}

export async function acquireLegacyDay(
  client: Queryable, vendorId: string, date: string, weddingId: string, dealId: string,
): Promise<string> {
  return (await client.query<{ day_id: string }>(
    'select legacy_day_acquire($1::uuid,$2::date,$3::uuid,$4::uuid)::text as day_id',
    [vendorId, date, weddingId, dealId],
  )).rows[0]!.day_id
}

export async function resolveLegacyDay(
  client: Queryable, group: LegacyDayGroup, dealId: string, currentVersionId: string, reason: 'cancel' | 'main_move',
): Promise<LegacyDayGroup> {
  return (await client.query<LegacyDayGroup>(
    `select ${GROUP_COLUMNS} from legacy_day_resolve($1::uuid,$2::uuid,$3::bigint,$4::uuid,$5::text)`,
    [group.day_id, dealId, group.revision, currentVersionId, reason],
  )).rows[0]!
}

export async function reconcileLegacyDay(client: Queryable, group: LegacyDayGroup): Promise<void> {
  await client.query('select legacy_day_reconcile($1::uuid,$2::bigint)', [group.day_id, group.revision])
}
