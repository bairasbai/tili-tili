import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { lockOrderPrincipal, type OrderActor } from '../orders/context.js'
import { boundedText, checkEntityId, checkVersion, validatePartDetails } from '../orders/model.js'

export interface ResourceScope { vendorId: string; actor: OrderActor }
export type ResourceKind = 'person' | 'equipment' | 'capacity'
export interface CapacityWindowDto { id: string; startsAt: string; endsAt: string; capacity: number; used: number; version: string }
export interface ResourceDto { id: string; kind: ResourceKind; label: string; version: string;
  personUserId: string | null; staffMemberId: string | null; capacityUnit: string | null; retiredAt: string | null;
  source: 'current' | 'unavailable'; unavailableReason: 'retired' | 'identity_unknown' | 'person_unavailable' | null; windows: CapacityWindowDto[] }
export interface CreateResourceInput extends ResourceScope { kind: ResourceKind; label: string;
  personUserId?: string; staffMemberId?: string; capacityUnit?: string }
export interface RetireResourceInput extends ResourceScope { resourceId: string; expectedVersion: string }
export interface CreateCapacityWindowInput extends ResourceScope { resourceId: string; startsAt: string; endsAt: string; capacity: number }
export interface PatchCapacityWindowInput extends ResourceScope { resourceId: string; windowId: string; expectedVersion: string; capacity: number }

/** Caller supplies a transaction. Account locks precede company/resource locks,
 * matching erasure; current session/consent/member are pinned after company wait. */
export async function lockResourceScope(client: Queryable, input: ResourceScope, personUserId?: string, requireLivePerson = true): Promise<{ ownerId: string }> {
  checkEntityId(input.vendorId, 'vendorId'); checkEntityId(input.actor.userId, 'userId')
  const located = (await client.query<{ user_id: string }>('select user_id from vendors where id=$1', [input.vendorId])).rows[0]
  if (!located) throw notFound('Компания не найдена')
  const ids = [...new Set([located.user_id, input.actor.userId.toLowerCase(), ...(personUserId ? [personUserId.toLowerCase()] : [])])].sort()
  const accounts = await client.query<{ id: string; deleted_at: Date | null }>('select id,deleted_at from users where id=any($1::uuid[]) order by id for share', [ids])
  const company = (await client.query<{ user_id: string; blocked_at: Date | null }>('select user_id,blocked_at from vendors where id=$1 for update', [input.vendorId])).rows[0]
  if (!company) throw notFound('Компания не найдена')
  if (company.user_id !== located.user_id) throw conflict('resource_source_changed', 'Владелец компании изменился — обновите данные')
  await lockOrderPrincipal(client, input.actor)
  if (!accounts.rows.some(a => a.id === company.user_id && a.deleted_at === null) || company.blocked_at !== null) throw notFound('Компания недоступна')
  if (input.actor.userId.toLowerCase() !== company.user_id) {
    const member = await client.query(`select id from vendor_staff_members where vendor_id=$1 and user_id=$2
      and state='active' and accepted_at is not null and revoked_at is null and role='resource_manager' for share`, [input.vendorId, input.actor.userId])
    if (!member.rowCount) throw forbidden('Ресурсами управляет владелец или действующий управляющий компании')
  }
  // Historical resources may still be retired after their person disappears.
  // The trusted caller can retain account lock ordering without requiring life.
  if (requireLivePerson && personUserId && !accounts.rows.some(a => a.id === personUserId.toLowerCase() && a.deleted_at === null)) throw validationFailed({ personUserId: 'Нужен действующий аккаунт человека' })
  return { ownerId: company.user_id }
}
function keys(input: object, allowed: string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw validationFailed({ resource: 'Недопустимые поля' })
}
export function capacityValue(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw validationFailed({ capacity: 'Нужно положительное целое число в пределах PostgreSQL integer' })
}
async function audit(client: Queryable, input: ResourceScope, action: string, id: string, diff: object): Promise<void> {
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,'resource',$3,$4::jsonb)", [input.actor.userId, action, id, JSON.stringify(diff)])
}
interface ResourceRow { id: string; kind: ResourceKind; label: string; version: string; person_user_id: string | null;
  staff_member_id: string | null; capacity_unit: string | null; retired_at: Date | null; person_live: boolean }
async function projection(client: Queryable, vendorId: string, id?: string): Promise<ResourceDto[]> {
  const resources = await client.query<ResourceRow>(`select r.id,r.kind,r.label,r.version::text,r.person_user_id,r.staff_member_id,r.capacity_unit,r.retired_at,
    case when r.kind<>'person' then true else u.id is not null and u.deleted_at is null and
      ((r.staff_member_id is null and r.person_user_id=v.user_id) or
        (m.vendor_id=r.vendor_id and m.user_id=r.person_user_id and m.state='active' and m.accepted_at is not null and m.revoked_at is null)) end as person_live
    from vendor_resources r join vendors v on v.id=r.vendor_id left join users u on u.id=r.person_user_id
    left join vendor_staff_members m on m.id=r.staff_member_id where r.vendor_id=$1 and ($2::uuid is null or r.id=$2) order by r.created_at,r.id`, [vendorId, id ?? null])
  const windows = await client.query<{ id: string; resource_id: string; starts_at: Date; ends_at: Date; capacity: number; used: number; version: string }>(
    'select id,resource_id,starts_at,ends_at,capacity,used,version::text from resource_capacity_windows where resource_id=any($1::uuid[]) order by starts_at,id', [resources.rows.map(r => r.id)])
  return resources.rows.map(r => {
    const unavailableReason = r.retired_at ? 'retired' as const : r.kind === 'person' && r.person_user_id === null ? 'identity_unknown' as const : !r.person_live ? 'person_unavailable' as const : null
    return { id: r.id, kind: r.kind, label: r.label, version: r.version, personUserId: r.person_live ? r.person_user_id : null,
      staffMemberId: r.person_live ? r.staff_member_id : null, capacityUnit: r.capacity_unit, retiredAt: r.retired_at?.toISOString() ?? null,
      source: unavailableReason ? 'unavailable' : 'current', unavailableReason,
      windows: windows.rows.filter(w => w.resource_id === r.id).map(w => ({ id: w.id, startsAt: w.starts_at.toISOString(), endsAt: w.ends_at.toISOString(), capacity: w.capacity, used: w.used, version: w.version })) }
  })
}
export async function listResources(client: Queryable, input: ResourceScope): Promise<ResourceDto[]> {
  await lockResourceScope(client, input); return projection(client, input.vendorId)
}
export async function createResource(client: Queryable, input: CreateResourceInput): Promise<ResourceDto> {
  keys(input, ['vendorId','actor','kind','label','personUserId','staffMemberId','capacityUnit'])
  if (!['person','equipment','capacity'].includes(input.kind)) throw validationFailed({ kind: 'Неизвестный вид ресурса' })
  boundedText(input.label, 'label')
  if (input.kind === 'person') { checkEntityId(input.personUserId, 'personUserId'); if (input.staffMemberId !== undefined) checkEntityId(input.staffMemberId, 'staffMemberId') }
  else if (input.personUserId !== undefined || input.staffMemberId !== undefined) throw validationFailed({ personUserId: 'Человек относится только к персональному ресурсу' })
  if (input.kind === 'capacity') boundedText(input.capacityUnit, 'capacityUnit', 80)
  else if (input.capacityUnit !== undefined) throw validationFailed({ capacityUnit: 'Единица мощности относится только к мощности' })
  const context = await lockResourceScope(client, input, input.personUserId)
  if (input.kind === 'person') {
    if (input.staffMemberId === undefined) {
      if (input.personUserId!.toLowerCase() !== context.ownerId) throw validationFailed({ staffMemberId: 'Нужно принятое участие человека в этой компании' })
    } else {
      const member = await client.query(`select id from vendor_staff_members where id=$1 and vendor_id=$2 and user_id=$3
        and state='active' and accepted_at is not null and revoked_at is null for share`, [input.staffMemberId, input.vendorId, input.personUserId])
      if (!member.rowCount) throw validationFailed({ staffMemberId: 'Нужно принятое участие человека в этой компании' })
    }
    const duplicate = await client.query('select id from vendor_resources where vendor_id=$1 and kind=\'person\' and conflict_identity=$2', [input.vendorId, input.personUserId])
    if (duplicate.rowCount) throw conflict('resource_person_exists', 'Ресурс этого человека уже существует, включая историю')
  }
  const id = uuidv7()
  await client.query('insert into vendor_resources(id,vendor_id,kind,label,person_user_id,staff_member_id,conflict_identity,capacity_unit,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, input.vendorId, input.kind, input.label, input.personUserId ?? null, input.staffMemberId ?? null, input.kind === 'person' ? input.personUserId : id, input.capacityUnit ?? null, input.actor.userId])
  await audit(client, input, 'resource.created', id, { kind: input.kind })
  return (await projection(client, input.vendorId, id))[0]!
}
async function lockedResource(client: Queryable, input: ResourceScope & { resourceId: string }) {
  checkEntityId(input.resourceId, 'resourceId')
  const row = (await client.query<{ kind: ResourceKind; version: string; retired_at: Date | null }>('select kind,version::text,retired_at from vendor_resources where id=$1 and vendor_id=$2 for update', [input.resourceId, input.vendorId])).rows[0]
  if (!row) throw notFound('Ресурс не найден'); return row
}
export async function retireResource(client: Queryable, input: RetireResourceInput): Promise<ResourceDto> {
  keys(input, ['vendorId','actor','resourceId','expectedVersion']); await lockResourceScope(client, input)
  const resource = await lockedResource(client, input); checkVersion(resource.version, input.expectedVersion)
  if (!resource.retired_at) {
    await client.query('update vendor_resources set retired_at=clock_timestamp(),version=version+1 where id=$1', [input.resourceId])
    await audit(client, input, 'resource.retired', input.resourceId, { beforeVersion: resource.version })
  }
  return (await projection(client, input.vendorId, input.resourceId))[0]!
}
export async function createCapacityWindow(client: Queryable, input: CreateCapacityWindowInput): Promise<CapacityWindowDto> {
  keys(input, ['vendorId','actor','resourceId','startsAt','endsAt','capacity']); capacityValue(input.capacity)
  if (typeof input.startsAt !== 'string' || typeof input.endsAt !== 'string') throw validationFailed({ startsAt: 'Нужно конечное время с явным смещением' })
  validatePartDetails('supply', { windowStartsAt: input.startsAt, windowEndsAt: input.endsAt })
  await lockResourceScope(client, input); const resource = await lockedResource(client, input)
  if (resource.kind !== 'capacity') throw validationFailed({ resourceId: 'Окно относится только к мощности' })
  if (resource.retired_at) throw conflict('resource_retired', 'Ресурс отключён')
  const overlap = await client.query("select id from resource_capacity_windows where resource_id=$1 and tstzrange(starts_at,ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')", [input.resourceId, input.startsAt, input.endsAt])
  if (overlap.rowCount) throw conflict('resource_window_overlap', 'Окна мощности пересекаются')
  const id = uuidv7()
  await client.query('insert into resource_capacity_windows(id,resource_id,starts_at,ends_at,capacity,created_by) values($1,$2,$3,$4,$5,$6)', [id, input.resourceId, input.startsAt, input.endsAt, input.capacity, input.actor.userId])
  await audit(client, input, 'resource.window_created', id, { resourceId: input.resourceId })
  return (await projection(client, input.vendorId, input.resourceId))[0]!.windows.find(w => w.id === id)!
}
export async function patchCapacityWindow(client: Queryable, input: PatchCapacityWindowInput): Promise<CapacityWindowDto> {
  keys(input, ['vendorId','actor','resourceId','windowId','expectedVersion','capacity']); checkEntityId(input.windowId, 'windowId'); capacityValue(input.capacity)
  await lockResourceScope(client, input); const resource = await lockedResource(client, input)
  if (resource.kind !== 'capacity') throw validationFailed({ resourceId: 'Окно относится только к мощности' })
  if (resource.retired_at) throw conflict('resource_retired', 'Ресурс отключён')
  const window = (await client.query<{ capacity: number; used: number; version: string }>('select capacity,used,version::text from resource_capacity_windows where id=$1 and resource_id=$2 for update', [input.windowId, input.resourceId])).rows[0]
  if (!window) throw notFound('Окно не найдено'); checkVersion(window.version, input.expectedVersion)
  if (input.capacity < window.used) throw conflict('resource_capacity_used', 'Мощность меньше уже используемой')
  if (input.capacity !== window.capacity) {
    await client.query('update resource_capacity_windows set capacity=$2,version=version+1 where id=$1', [input.windowId, input.capacity])
    await audit(client, input, 'resource.window_changed', input.windowId, { resourceId: input.resourceId, beforeVersion: window.version, beforeCapacity: window.capacity, capacity: input.capacity })
  }
  return (await projection(client, input.vendorId, input.resourceId))[0]!.windows.find(w => w.id === input.windowId.toLowerCase())!
}
