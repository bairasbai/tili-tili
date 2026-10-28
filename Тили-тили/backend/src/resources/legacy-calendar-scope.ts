import type { Queryable } from '../plugins/db.js'
import type { OrderActor } from '../orders/context.js'
import { conflict, validationFailed } from '../errors.js'
import { isUuid } from '../ids.js'
import { calendarNativeRefusal } from './calendar-errors.js'

export interface LegacyCalendarScopeInput {
  weddingIds?: readonly string[]; vendorIds?: readonly string[]; personIds?: readonly string[]
  resourceIds?: readonly string[]; sourceIds?: readonly string[]; extraAccountIds?: readonly string[]
  actor?: OrderActor; mode?: 'write' | 'erase'
}
export interface PreparedLegacyCalendarScope {
  readonly sourceIds: readonly string[]; readonly weddingIds: readonly string[]
  readonly vendorIds: readonly string[]; readonly personIds: readonly string[]
  assertCurrent(): Promise<void>
}
const arrays = ['weddings', 'requests', 'deals', 'slots', 'orders', 'accounts', 'vendors', 'staff',
  'resources', 'windows', 'allocations', 'sources', 'days', 'persons', 'sessions'] as const
type ScopeArray = typeof arrays[number]
interface NativeScope extends Record<ScopeArray, string[]> {
  keys: { kind: 'person' | 'equipment' | 'capacity'; identity: string }[]
}
interface Stamp { pid: number; txid: string }
interface Entry { stamp: Stamp; seed: LegacyCalendarScopeInput; scope: NativeScope; erasing: boolean }
const prepared = new WeakMap<Queryable, Entry>()
const changed = () => conflict('calendar_scope_changed', 'Область календарных обязательств изменилась — обновите данные')
const sorted = (values: readonly string[]) => [...new Set(values)].sort()

function ids(values: readonly string[] | undefined, limit: number): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > limit || values.some(id => !isUuid(id))) {
    throw validationFailed({ calendar: 'Нужна полная ограниченная область идентификаторов' })
  }
  return sorted(values.map(id => id.toLowerCase()))
}
function seedOf(input: LegacyCalendarScopeInput): LegacyCalendarScopeInput {
  if (input.mode !== undefined && input.mode !== 'write' && input.mode !== 'erase') {
    throw validationFailed({ calendar: 'Неизвестный режим области' })
  }
  const seed: LegacyCalendarScopeInput = {
    weddingIds: ids(input.weddingIds, 128), vendorIds: ids(input.vendorIds, 128),
    personIds: ids(input.personIds, 256), resourceIds: ids(input.resourceIds, 512),
    sourceIds: ids(input.sourceIds, 128), extraAccountIds: ids(input.extraAccountIds, 512), mode: input.mode ?? 'write',
  }
  if (input.actor !== undefined) {
    const actor = input.actor
    if (!isUuid(actor.userId) || !isUuid(actor.sessionId) || typeof actor.policyVersion !== 'string' ||
      !actor.policyVersion || actor.policyVersion.length > 100) throw validationFailed({ actor: 'Нужен текущий принципал' })
    seed.actor = { userId: actor.userId.toLowerCase(), sessionId: actor.sessionId.toLowerCase(), policyVersion: actor.policyVersion }
  }
  return seed
}
function nativeScope(value: unknown): NativeScope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw changed()
  const object = value as Record<string, unknown>, result = {} as NativeScope
  for (const name of arrays) {
    const values = object[name]
    if (!Array.isArray(values) || values.some(v => !isUuid(v))) throw changed()
    result[name] = sorted(values.map(v => (v as string).toLowerCase()))
  }
  if (!Array.isArray(object.keys)) throw changed()
  result.keys = object.keys.map(value => {
    if (value === null || typeof value !== 'object') throw changed()
    const key = value as Record<string, unknown>
    if (!['person', 'equipment', 'capacity'].includes(String(key.kind)) || !isUuid(key.identity)) throw changed()
    return { kind: key.kind as NativeScope['keys'][number]['kind'], identity: key.identity.toLowerCase() }
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.identity.localeCompare(b.identity))
  if (result.weddings.length > 128 || result.sources.length > 128 || result.persons.length > 256) {
    throw conflict('calendar_scope_incomplete', 'Область обязательств слишком велика для одной операции')
  }
  return result
}
async function stamp(client: Queryable): Promise<Stamp> {
  const row = (await client.query<Stamp>('select pg_backend_pid() as pid,txid_current()::text as txid')).rows[0]
  if (!row || !Number.isInteger(row.pid) || !/^[0-9]+$/.test(row.txid)) throw changed()
  return row
}
const sameStamp = (a: Stamp, b: Stamp) => a.pid === b.pid && a.txid === b.txid
async function locate(client: Queryable, seed: LegacyCalendarScopeInput): Promise<NativeScope> {
  try {
    const row = (await client.query<{ scope: unknown }>(
      'select legacy_calendar_bounds_locate($1::jsonb) as scope', [JSON.stringify(seed)])).rows[0]
    return nativeScope(row?.scope)
  } catch (error) { return calendarNativeRefusal(error) }
}

// A child born in this transaction needs no backwards wait: its row is already
// owned and cannot be visible to a peer. Existing new parents must always retry.
const children: Partial<Record<ScopeArray, { table: string; key: string }>> = {
  requests: { table: 'offer_requests', key: 'id' }, deals: { table: 'deals', key: 'id' },
  slots: { table: 'slots', key: 'id' }, orders: { table: 'deal_orders', key: 'deal_id' },
  staff: { table: 'vendor_staff_members', key: 'id' }, resources: { table: 'vendor_resources', key: 'id' },
  windows: { table: 'resource_capacity_windows', key: 'id' }, allocations: { table: 'resource_allocations', key: 'id' },
  sources: { table: 'legacy_calendar_sources', key: 'id' }, days: { table: 'vendor_busy_dates', key: 'id' },
}
async function assertContained(client: Queryable, before: NativeScope, after: NativeScope): Promise<void> {
  for (const name of arrays) {
    const known = new Set(before[name]), added = after[name].filter(id => !known.has(id))
    if (!added.length) continue
    const child = children[name]
    if (!child) throw changed()
    // SQL identifiers come only from this fixed internal table, never a body.
    const own = (await client.query<{ id: string }>(`select ${child.key}::text as id from ${child.table}
      where ${child.key}=any($1::uuid[]) and legacy_calendar_bounds_inserted_in_transaction($2,${child.key})
      order by ${child.key}`, [added, child.table])).rows
    if (own.length !== added.length) throw changed()
  }
  const known = new Set(before.keys.map(k => `${k.kind}:${k.identity}`))
  for (const key of after.keys) {
    if (known.has(`${key.kind}:${key.identity}`)) continue
    if (key.kind === 'person') throw changed()
    const own = await client.query(`select id from vendor_resources where id=$1 and kind=$2
      and conflict_identity=$1 and legacy_calendar_bounds_inserted_in_transaction('vendor_resources',id)`, [key.identity, key.kind])
    if (own.rowCount !== 1) throw changed()
  }
}

// This capability is only a financial constructor. It never asserts calendar availability.
const financialDraftArrays = ['weddings', 'requests', 'deals', 'slots', 'orders', 'accounts', 'vendors'] as const
type FinancialDraftArray = typeof financialDraftArrays[number]
interface FinancialDraftScope extends Record<FinancialDraftArray, string[]> { owners: [string, string][] }
interface FinancialDraftEntry { stamp: Stamp; seed: LegacyCalendarScopeInput; scope: FinancialDraftScope }
const financialDraftPrepared = new WeakMap<Queryable, FinancialDraftEntry>()
async function locateFinancialDraft(client: Queryable, seed: LegacyCalendarScopeInput): Promise<FinancialDraftScope> {
  const row = (await client.query<{ scope: unknown }>(`with
    local_deals as (select id,vendor_id from deals where wedding_id=$1),
    local_slots as (select id from slots where wedding_id=$1),
    local_requests as (select r.id,r.vendor_id from offer_requests r join local_slots s on s.id=r.slot_id),
    local_vendors as (select id,user_id from vendors where id=$2
      or id in(select vendor_id from local_deals union select vendor_id from local_requests)),
    account_ids as (select owner_id id from weddings where id=$1
      union select user_id from wedding_members where wedding_id=$1
      union select user_id from local_vendors union select $3::uuid),
    local_orders as (select deal_id from deal_orders where wedding_id=$1
      union select deal_id from deal_resource_commitments where wedding_id=$1)
    select jsonb_build_object(
      'weddings',coalesce((select jsonb_agg(id order by id) from weddings where id=$1),'[]'),
      'requests',coalesce((select jsonb_agg(id order by id) from local_requests),'[]'),
      'deals',coalesce((select jsonb_agg(id order by id) from local_deals),'[]'),
      'slots',coalesce((select jsonb_agg(id order by id) from local_slots),'[]'),
      'orders',coalesce((select jsonb_agg(deal_id order by deal_id) from local_orders),'[]'),
      'accounts',coalesce((select jsonb_agg(id order by id) from account_ids where id is not null),'[]'),
      'vendors',coalesce((select jsonb_agg(id order by id) from local_vendors),'[]'),
      'owners',coalesce((select jsonb_agg(jsonb_build_array(id,user_id) order by id) from local_vendors),'[]')) scope`,
  [seed.weddingIds![0], seed.vendorIds![0], seed.actor!.userId])).rows[0]
  if (!row?.scope || typeof row.scope !== 'object' || Array.isArray(row.scope)) throw changed()
  const value = row.scope as Record<string, unknown>, scope = {} as FinancialDraftScope
  for (const name of financialDraftArrays) {
    const values = value[name]
    if (!Array.isArray(values) || values.some(id => !isUuid(id))) throw changed()
    scope[name] = ids(values as string[], name === 'weddings' ? 1 : 512)
  }
  if (!Array.isArray(value.owners) || value.owners.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(isUuid))) throw changed()
  scope.owners = value.owners as [string, string][]
  return scope
}
async function assertFinancialDraftContained(client: Queryable, before: FinancialDraftScope, after: FinancialDraftScope): Promise<void> {
  if (JSON.stringify(before.owners) !== JSON.stringify(after.owners)) throw changed()
  for (const name of financialDraftArrays) {
    const known = new Set(before[name]), added = after[name].filter(id => !known.has(id))
    if (!added.length) continue
    // Only real financial children born in this transaction may extend this constructor.
    const child = name === 'requests' || name === 'deals' || name === 'slots' || name === 'orders' ? children[name] : undefined
    if (!child) throw changed()
    const own = (await client.query<{ id: string }>(`select ${child.key}::text as id from ${child.table}
      where ${child.key}=any($1::uuid[]) and legacy_calendar_bounds_inserted_in_transaction($2,${child.key}) order by ${child.key}`,
    [added, child.table])).rows
    if (own.length !== added.length) throw changed()
  }
}
/** Server-only, no-promise constructor used solely by resource-order preparation.
 * Keep financial/account/company ordering while leaving DAY/occupancy untouched.
 * A fresh transaction is required to switch between this and operational scope. */
export async function prepareCalendarFinancialDraft(client: Queryable,
  input: Pick<LegacyCalendarScopeInput, 'weddingIds' | 'vendorIds' | 'actor'>): Promise<void> {
  if (Object.keys(input).some(key => !['weddingIds', 'vendorIds', 'actor'].includes(key))) {
    throw validationFailed({ calendar: 'Нужен точный финансовый контекст черновика' })
  }
  const seed = seedOf(input)
  if (seed.weddingIds!.length !== 1 || seed.vendorIds!.length !== 1 || !seed.actor) {
    throw validationFailed({ calendar: 'Нужны одна свадьба, компания и действующая сторона' })
  }
  const identity = await stamp(client), operational = prepared.get(client)
  if (operational && sameStamp(operational.stamp, identity)) throw changed()
  if (operational) prepared.delete(client)
  let entry = financialDraftPrepared.get(client)
  if (entry && !sameStamp(entry.stamp, identity)) { financialDraftPrepared.delete(client); entry = undefined }
  if (entry) {
    if (JSON.stringify(entry.seed) !== JSON.stringify(seed)) throw changed()
    await assertFinancialDraftContained(client, entry.scope, await locateFinancialDraft(client, seed))
    return
  }
  const initial = await locateFinancialDraft(client, seed)
  entry = { stamp: identity, seed, scope: initial }; financialDraftPrepared.set(client, entry)
  for (const [name, table, key] of [
    ['weddings', 'weddings', 'id'], ['requests', 'offer_requests', 'id'], ['deals', 'deals', 'id'],
    ['slots', 'slots', 'id'], ['orders', 'deal_orders', 'deal_id'], ['orders', 'deal_resource_commitments', 'deal_id'],
  ] as const) await client.query(`select ${key} from ${table} where ${key}=any($1::uuid[]) order by ${key} for update`, [initial[name]])
  await client.query('select id from users where id=any($1::uuid[]) order by id for share', [initial.accounts])
  await client.query('select id from sessions where id=$1 and user_id=$2 for share', [seed.actor.sessionId, seed.actor.userId])
  await client.query('select id from consents where user_id=any($1::uuid[]) order by user_id,id for share', [initial.accounts])
  await client.query('select user_id from wedding_members where wedding_id=any($1::uuid[]) order by wedding_id,user_id for share', [initial.weddings])
  await client.query('select id from vendors where id=any($1::uuid[]) order by id for share', [initial.vendors])
  await client.query('select vendor_id from vendor_availability_policy where vendor_id=any($1::uuid[]) order by vendor_id for share', [initial.vendors])
  if (!sameStamp(identity, await stamp(client))) throw changed()
  await assertFinancialDraftContained(client, initial, await locateFinancialDraft(client, seed))
}

/** Server-only transaction prefix. It is not an ACL or a caller bypass token.
 * Native SQL pins the complete sorted scope before older writers enter their
 * own prefixes. Nested operations can only reuse it or add their own new child. */
export async function prepareLegacyCalendarScope(client: Queryable,
  input: LegacyCalendarScopeInput): Promise<PreparedLegacyCalendarScope> {
  const seed = seedOf(input), identity = await stamp(client)
  const financial = financialDraftPrepared.get(client)
  if (financial && sameStamp(financial.stamp, identity)) throw changed()
  if (financial) financialDraftPrepared.delete(client)
  let entry = prepared.get(client)
  if (entry && !sameStamp(entry.stamp, identity)) { prepared.delete(client); entry = undefined }
  if (entry) {
    if (seed.mode === 'erase' && !entry.erasing) throw changed()
    const requested = await locate(client, seed)
    await assertContained(client, entry.scope, requested)
  } else {
    const row = await (async () => {
      try { return (await client.query<{ scope: unknown }>(
        'select legacy_calendar_bounds_prepare_scope($1::jsonb) as scope', [JSON.stringify(seed)])).rows[0] }
      catch (error) {
        if (error && typeof error === 'object' && (error as { code?: string }).code === '55P03') throw changed()
        return calendarNativeRefusal(error)
      }
    })()
    entry = { stamp: identity, seed, scope: nativeScope(row?.scope), erasing: seed.mode === 'erase' }
    prepared.set(client, entry)
  }
  const current = entry
  async function assertCurrent(): Promise<void> {
    if (!sameStamp(current.stamp, await stamp(client))) throw changed()
    await assertContained(client, current.scope, await locate(client, current.seed))
    if (seed !== current.seed) await assertContained(client, current.scope, await locate(client, seed))
  }
  await assertCurrent()
  return { sourceIds: current.scope.sources, weddingIds: current.scope.weddings,
    vendorIds: current.scope.vendors, personIds: current.scope.persons, assertCurrent }
}
