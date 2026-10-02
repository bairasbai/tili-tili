import type { Queryable } from '../plugins/db.js'
import { conflict, validationFailed } from '../errors.js'
import { checkVersion } from '../orders/model.js'
import { lockResourceScope, listResources, type ResourceScope } from './model.js'

export type AvailabilityMode = 'legacy_day' | 'resources'
export interface AvailabilityPolicyDto { vendorId: string; mode: AvailabilityMode; revision: string;
  changedBy: string | null; changedAt: string | null;
  legacyObligations: { unresolved: boolean; manualDays: number; dealDays: number; unknownDays: number;
    committedDeals: number; negotiatingDeals: number; reason: 'unresolved_legacy_obligations' | null } }
interface PolicyRow { mode: AvailabilityMode; revision: string; changed_by: string | null; changed_at: Date }
async function project(client: Queryable, vendorId: string): Promise<AvailabilityPolicyDto> {
  const row = (await client.query<PolicyRow>('select mode,revision::text,changed_by,changed_at from vendor_availability_policy where vendor_id=$1', [vendorId])).rows[0]
  const counts = (await client.query<{ manual: number; deal: number; unknown: number; committed: number; negotiating: number }>(`select
    (select count(*)::int from vendor_busy_dates where vendor_id=$1 and source='manual') as manual,
    (select count(*)::int from vendor_busy_dates where vendor_id=$1 and source='deal') as deal,
    (select count(*)::int from vendor_busy_dates b left join deals d on d.id=b.deal_id where b.vendor_id=$1
      and b.source='deal' and (d.id is null or d.vendor_id is distinct from b.vendor_id or d.state not in ('booked','paid_deposit','done'))) as unknown,
    (select count(*)::int from deals where vendor_id=$1 and state in ('booked','paid_deposit','done')) as committed,
    (select count(*)::int from deals d join weddings w on w.id=d.wedding_id where d.vendor_id=$1 and d.state='negotiating'
      and d.negotiating_until>clock_timestamp() and w.archived_at is null and w.cancelled_at is null) as negotiating`, [vendorId])).rows[0]!
  const unresolved = counts.manual + counts.deal + counts.unknown + counts.committed + counts.negotiating > 0
  return { vendorId: vendorId.toLowerCase(), mode: row?.mode ?? 'legacy_day', revision: row?.revision ?? '0', changedBy: row?.changed_by ?? null,
    changedAt: row?.changed_at.toISOString() ?? null, legacyObligations: { unresolved, manualDays: counts.manual, dealDays: counts.deal, unknownDays: counts.unknown,
      committedDeals: counts.committed, negotiatingDeals: counts.negotiating, reason: unresolved ? 'unresolved_legacy_obligations' : null } }
}
export async function getAvailabilityPolicy(client: Queryable, input: ResourceScope): Promise<AvailabilityPolicyDto> {
  await lockResourceScope(client, input); return project(client, input.vendorId)
}
export interface SetAvailabilityPolicyInput extends ResourceScope { mode: AvailabilityMode; expectedRevision: string }
/** Explicit selection only. This function neither reserves resources nor
 * clears old dates/deals/payments, and unresolved counts remain authoritative. */
export async function setAvailabilityPolicy(client: Queryable, input: SetAvailabilityPolicyInput): Promise<AvailabilityPolicyDto> {
  if (Object.keys(input).some(k => !['vendorId','actor','mode','expectedRevision'].includes(k)) || !['legacy_day','resources'].includes(input.mode)) throw validationFailed({ mode: 'Нужен явный режим занятости' })
  await lockResourceScope(client, input)
  const before = await project(client, input.vendorId); checkVersion(before.revision, input.expectedRevision, 'expectedRevision', true)
  if (input.mode === 'resources' && !(await listResources(client, input)).some(r => r.source === 'current')) throw conflict('resource_policy_empty', 'Для этой политики нужен действующий реальный ресурс')
  if (input.mode === before.mode) return before
  await client.query(`insert into vendor_availability_policy(vendor_id,mode,changed_by) values($1,$2,$3)
    on conflict(vendor_id) do update set mode=excluded.mode,revision=vendor_availability_policy.revision+1,changed_by=excluded.changed_by,changed_at=clock_timestamp()`, [input.vendorId, input.mode, input.actor.userId])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'resource.policy_changed','vendor',$2,$3::jsonb)",
    [input.actor.userId, input.vendorId, JSON.stringify({ beforeRevision: before.revision, beforeMode: before.mode, mode: input.mode })])
  return project(client, input.vendorId)
}
