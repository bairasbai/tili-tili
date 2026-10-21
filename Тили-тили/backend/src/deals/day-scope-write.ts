import type { Queryable } from '../plugins/db.js'
import { conflict, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import type { DealState } from './state.js'
import { acquireLegacyDay, lockLegacyDayVendors, reconcileLegacyDay, resolveLegacyDay, touchLegacyDayGroup,
  type LegacyDayGroup } from '../resources/day-groups.js'
import { lockLegacyBookingCompanies } from '../resources/booking-boundary.js'

type ContextKind = 'implicit_main' | 'explicit_main' | 'explicit_event' | 'unknown'
type Performer = 'catalog' | 'external' | 'unknown'
type Binding = 'unknown' | 'undated' | 'external' | 'active' | 'done_retained' | 'done_undated' | 'released'
type Operation = 'observe' | 'observe_done' | 'acquire' | 'move' | 'retain_done' | 'release'
interface Tuple {
  slot_id: string; context_kind: ContextKind; event_id: string | null; performer_kind: Performer
  vendor_id: string | null; binding_state: Binding; service_date: string | null; time_zone: string | null; day_id: string | null
}
interface Version extends Tuple { id: string; revision: string; current: boolean }
interface Root {
  id: string; wedding_id: string; slot_id: string; state: DealState; vendor_id: string | null
  external_name: string | null; vendor_exists: boolean; selected: boolean; resource_managed: boolean
  program_event_id: string | null; event_id: string | null; is_main: boolean | null
  event_date: string | null; event_tz: string | null; wedding_date: string | null; wedding_tz: string | null
}
interface Day { id: string; vendor_id: string; date: string; source_revision: string }
type Group = LegacyDayGroup
interface Stamp { pid: number; txid: string }
interface Prepared { stamp: Stamp; vendors: Set<string> }
const prepared = new WeakMap<Queryable, Map<string, Prepared>>()
const transitions = new WeakMap<DayTransition, { client: Queryable; stamp: Stamp; consumed: boolean }>()
const moves = new WeakMap<MainDayChange, { client: Queryable; stamp: Stamp; observed: boolean; consumed: boolean }>()
const changed = () => conflict('day_scope_changed', 'Область брони изменилась — обновите данные')
const committed = (state: DealState) => state === 'booked' || state === 'paid_deposit' || state === 'done'
const open = (state: DealState) => state === 'booked' || state === 'paid_deposit'
const stamp = async (client: Queryable) => (await client.query<Stamp>(
  'select pg_backend_pid() as pid,txid_current()::text as txid')).rows[0]!
function scopesInTransaction(client: Queryable, current: Stamp): Map<string, Prepared> {
  const existing = prepared.get(client)
  return existing && [...existing.values()].every(value => value.stamp.pid === current.pid && value.stamp.txid === current.txid)
    ? existing : new Map<string, Prepared>()
}

/** Called by the owning outer TX after its financial/principal/company prefix.
 * One complete vendor union precedes every DATE mutation; nested calls may only
 * reuse it. The token never turns the observation reader into authority. */
export async function prepareDayWriter(client: Queryable, weddingId: string, extraVendorIds: readonly string[] = []): Promise<void> {
  const current = await stamp(client)
  const vendors = (await client.query<{ id: string }>(`select distinct id from (
    select vendor_id id from deals where wedding_id=$1
    union select vendor_id from deal_day_scope_versions where wedding_id=$1
    union select vendor_id from deal_resource_commitment_versions where wedding_id=$1
    union select g.vendor_id from legacy_day_groups g where exists(select 1 from deals d
      where d.wedding_id=$1 and d.id=any(g.legacy_candidates))
    union select unnest($2::uuid[])) u where id is not null order by id`, [weddingId, extraVendorIds])).rows.map(r => r.id)
  const scopes = scopesInTransaction(client, current)
  const previous = scopes.get(weddingId)
  if (previous && previous.stamp.pid === current.pid && previous.stamp.txid === current.txid) {
    if (vendors.some(id => !previous.vendors.has(id))) throw changed()
    return
  }
  await lockLegacyBookingCompanies(client, vendors)
  await lockLegacyDayVendors(client, vendors)
  scopes.set(weddingId, { stamp: current, vendors: new Set(vendors) })
  prepared.set(client, scopes)
}

/** Erasure owns several wedding/company prefixes at once. Acquire their
 * complete numeric advisory-key union once, before per-wedding iteration. */
export async function prepareDayWriterUnion(client: Queryable, weddingIds: readonly string[], extraVendorIds: readonly string[] = []): Promise<void> {
  const current = await stamp(client)
  const vendors = (await client.query<{ id: string }>(`select distinct id from (
    select vendor_id id from deals where wedding_id=any($1::uuid[])
    union select vendor_id from deal_day_scope_versions where wedding_id=any($1::uuid[])
    union select vendor_id from deal_resource_commitment_versions where wedding_id=any($1::uuid[])
    union select g.vendor_id from legacy_day_groups g where exists(select 1 from deals d
      where d.wedding_id=any($1::uuid[]) and d.id=any(g.legacy_candidates))
    union select unnest($2::uuid[])) u where id is not null order by id`, [weddingIds, extraVendorIds])).rows.map(r => r.id)
  const scopes = scopesInTransaction(client, current)
  for (const weddingId of weddingIds) {
    const previous = scopes.get(weddingId)
    if (previous && previous.stamp.pid === current.pid && previous.stamp.txid === current.txid
      && vendors.some(id => !previous.vendors.has(id))) throw changed()
  }
  await lockLegacyBookingCompanies(client, vendors)
  await lockLegacyDayVendors(client, vendors)
  for (const weddingId of weddingIds) scopes.set(weddingId, { stamp: current, vendors: new Set(vendors) })
  prepared.set(client, scopes)
}

async function loadRoot(client: Queryable, weddingId: string, dealId: string): Promise<Root> {
  const row = (await client.query<Root>(`select d.id,d.wedding_id,d.slot_id,d.state,d.vendor_id,d.external_name,
    exists(select 1 from vendors v where v.id=d.vendor_id) vendor_exists,
    s.deal_id=d.id selected,s.program_event_id,e.id event_id,e.is_main,e.date::text event_date,e.time_zone event_tz,
    w.date::text wedding_date,w.tz wedding_tz,
    exists(select 1 from deal_resource_commitments c where c.deal_id=d.id and c.revision>0) resource_managed
    from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
    join weddings w on w.id=d.wedding_id left join wedding_events e
      on e.wedding_id=d.wedding_id and (e.id=s.program_event_id or (s.program_event_id is null and e.is_main))
    where d.wedding_id=$1 and d.id=$2`, [weddingId, dealId])).rows[0]
  if (!row) throw notFound('Сделка не найдена')
  return row
}
async function head(client: Queryable, weddingId: string, dealId: string): Promise<Version | null> {
  return (await client.query<Version>(`select v.id,v.revision::text,v.slot_id,v.context_kind,v.event_id,
    v.performer_kind,v.vendor_id,v.binding_state,v.service_date::text,v.time_zone,v.day_id,
    deal_day_scope_matches_current(v) current from deal_day_scope_heads h
    join deal_day_scope_versions v on v.id=h.current_version_id and v.deal_id=h.deal_id and v.wedding_id=h.wedding_id
    where h.wedding_id=$1 and h.deal_id=$2 for update of h`, [weddingId, dealId])).rows[0] ?? null
}
function tuple(root: Root): Tuple {
  const context: ContextKind = !root.event_id ? 'unknown' : root.is_main
    ? root.program_event_id === null ? 'implicit_main' : 'explicit_main' : 'explicit_event'
  const performer: Performer = root.vendor_id && root.vendor_exists ? 'catalog' : root.external_name !== null ? 'external' : 'unknown'
  return { slot_id: root.slot_id, context_kind: context, event_id: root.event_id, performer_kind: performer,
    vendor_id: performer === 'catalog' ? root.vendor_id : null, binding_state: 'unknown',
    service_date: root.event_date, time_zone: root.event_tz, day_id: null }
}
function assertMain(root: Root): void {
  if (!root.event_id || !root.is_main) throw conflict('additional_event_booking_pending',
    'Бронь отдельного мероприятия будет доступна после согласования ресурсов и условий заказа')
  if (root.event_date !== root.wedding_date || root.event_tz !== root.wedding_tz) throw conflict('event_date_conflict',
    'Дата или часовой пояс основного мероприятия изменились — обновите программу')
}
function freshSelectedMain(root: Root): boolean {
  return root.selected && root.is_main === true && root.event_id !== null
    && root.event_date === root.wedding_date && root.event_tz === root.wedding_tz
}
async function erasedCatalog(client: Queryable, root: Root, previous: Version | null): Promise<boolean> {
  if (!previous || previous.current || previous.performer_kind !== 'catalog' || !previous.vendor_id
    || root.vendor_id !== null || root.external_name === null) return false
  return !(await client.query('select id from vendors where id=$1', [previous.vendor_id])).rowCount
}
async function append(client: Queryable, root: Root, previous: Version | null, value: Tuple,
  operation: Operation, origin: 'legacy_unknown' | 'observed_tracking' = 'legacy_unknown'): Promise<Version> {
  const id = uuidv7(), revision = previous ? (BigInt(previous.revision) + 1n).toString() : '1'
  await client.query(`insert into deal_day_scope_versions(id,wedding_id,deal_id,slot_id,schema_version,revision,
    previous_version_id,origin_knowledge,operation,context_kind,event_id,performer_kind,vendor_id,binding_state,service_date,time_zone,day_id)
    values($1,$2,$3,$4,1,$5::bigint,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15,$16)`,
  [id, root.wedding_id, root.id, value.slot_id, revision, previous?.id ?? null, previous ? null : origin, operation,
    value.context_kind, value.event_id, value.performer_kind, value.vendor_id, value.binding_state, value.service_date, value.time_zone, value.day_id])
  if (previous) {
    const updated = await client.query(`update deal_day_scope_heads set revision=$3::bigint,current_version_id=$4
      where wedding_id=$1 and deal_id=$2 and revision=$5::bigint and current_version_id=$6`,
    [root.wedding_id, root.id, revision, id, previous.revision, previous.id])
    if (updated.rowCount !== 1) throw changed()
  } else await client.query(`insert into deal_day_scope_heads(wedding_id,deal_id,revision,current_version_id)
    values($1,$2,1,$3)`, [root.wedding_id, root.id, id])
  return { ...value, id, revision, current: true }
}
async function touchDays(client: Queryable, root: Root, previous: Version | null): Promise<Group[]> {
  const days = (await client.query<Day>(`select b.id,b.vendor_id,b.date::text,b.source_revision::text
    from vendor_busy_dates b where b.source='deal' and (
      b.id=any(select day_id from deal_day_scope_versions where wedding_id=$1 and deal_id=$2 and day_id is not null)
      or exists(select 1 from legacy_day_groups g where g.day_id=b.id and $2::uuid=any(g.legacy_candidates))
      or b.id=$3 or (b.vendor_id=$4 and exists(select 1 from deals p where p.id=b.deal_id and p.wedding_id=$1)))
    order by b.vendor_id,b.date,b.id for update of b`, [root.wedding_id, root.id, previous?.day_id ?? null, root.vendor_id])).rows
  const result: Group[] = []
  for (const day of days) {
    const row = await touchLegacyDayGroup(client, day.id, root.wedding_id, day.source_revision)
    if (!row) throw changed()
    result.push(row)
  }
  return result
}
async function reconcile(client: Queryable, groups: readonly Group[], version?: { id: string; dealId: string; reason: 'cancel' | 'main_move' }): Promise<void> {
  for (const group of groups) {
    // Re-read CAS revision: a previous member of this same prepared unit may
    // already have resolved/reconciled the shared physical DATE.
    const current = await loadGroup(client, group.day_id)
    if (!current) continue
    const resolved = version ? await resolveLegacyDay(client, current, version.dealId, version.id, version.reason) : current
    if (!resolved) throw changed()
    await reconcileLegacyDay(client, resolved)
  }
}
async function loadGroup(client: Queryable, dayId: string): Promise<Group | null> {
  return (await client.query<Group>(`select day_id,vendor_id,service_date::text,wedding_id,classification,
    legacy_candidates,revision::text from legacy_day_groups where day_id=$1 for update`, [dayId])).rows[0] ?? null
}
async function reconcileDay(client: Queryable, dayId: string): Promise<void> {
  const group = await loadGroup(client, dayId)
  if (!group) throw changed()
  await reconcile(client, [group])
}
async function acquire(client: Queryable, root: Root, value: Tuple): Promise<Tuple> {
  assertMain(root)
  if (!root.selected && root.state !== 'done') throw changed()
  if (value.performer_kind === 'external') return { ...value, binding_state: 'external' }
  if (value.performer_kind !== 'catalog' || !value.vendor_id) throw changed()
  if (value.service_date === null) return { ...value, binding_state: 'undated' }
  let day: string
  try { day = await acquireLegacyDay(client, value.vendor_id, value.service_date, root.wedding_id, root.id) }
  catch (error) {
    const pg = error as { code?: string; constraint?: string }
    if (pg.code === '23505' && pg.constraint === 'vendor_busy_dates_pk') throw conflict('date_taken', 'Эта дата у подрядчика уже занята')
    throw error
  }
  if (!day) throw changed()
  return { ...value, binding_state: 'active', day_id: day }
}

export interface DayTransition {
  readonly root: Root; readonly previous: Version | null; readonly groups: readonly Group[]
  readonly erased: boolean; readonly skip: boolean
}
async function bindTransition(client: Queryable, value: DayTransition): Promise<DayTransition> {
  const result = Object.freeze({ ...value, root: Object.freeze({ ...value.root }),
    previous: value.previous && Object.freeze({ ...value.previous }),
    groups: Object.freeze(value.groups.map(group => Object.freeze({ ...group, legacy_candidates: [...group.legacy_candidates] }))) })
  transitions.set(result, { client, stamp: await stamp(client), consumed: false })
  return result
}
async function assertTransitionToken(client: Queryable, value: DayTransition): Promise<void> {
  const binding = transitions.get(value), current = await stamp(client)
  if (!binding || binding.client !== client || binding.consumed || current.pid !== binding.stamp.pid || current.txid !== binding.stamp.txid) throw changed()
  binding.consumed = true
}
/** Capture before changing the financial state; price/payment-only commands do
 * not call this gate and keep their existing legal behavior. */
export async function prepareDayTransition(client: Queryable, weddingId: string, dealId: string): Promise<DayTransition> {
  await prepareDayWriter(client, weddingId)
  const root = await loadRoot(client, weddingId, dealId), previous = await head(client, weddingId, dealId)
  if (root.resource_managed) return bindTransition(client, { root, previous, groups: [], erased: false, skip: true })
  const erased = await erasedCatalog(client, root, previous)
  if (previous && !previous.current && !erased) throw changed()
  const groups = await touchDays(client, root, previous)
  return bindTransition(client, { root, previous, groups, erased, skip: false })
}

/** Capture a pre-existing target's old cohort before inserting a new root. */
export async function prepareSlotDayCommitment(client: Queryable, weddingId: string, slotId: string, vendorId: string | null): Promise<void> {
  await prepareDayWriter(client, weddingId, vendorId ? [vendorId] : [])
  if (!vendorId) return
  const days = (await client.query<Day>(`select b.id,b.vendor_id,b.date::text,b.source_revision::text
    from slots s join weddings w on w.id=s.wedding_id join vendor_busy_dates b on b.vendor_id=$3 and b.date=w.date
    join deals p on p.id=b.deal_id and p.wedding_id=w.id
    where s.wedding_id=$1 and s.id=$2 and b.source='deal' order by b.id for update of b`, [weddingId, slotId, vendorId])).rows
  for (const day of days) await touchLegacyDayGroup(client, day.id, weddingId, day.source_revision)
}

export async function finishNewDayCommitment(client: Queryable, weddingId: string, dealId: string,
  origin: 'legacy_unknown' | 'observed_tracking' = 'observed_tracking'): Promise<void> {
  await prepareDayWriter(client, weddingId)
  const root = await loadRoot(client, weddingId, dealId)
  if (root.resource_managed) return
  const previous = await head(client, weddingId, dealId)
  if (previous) throw changed()
  let value = await acquire(client, root, tuple(root)), operation: Operation = 'acquire'
  if (root.state === 'done' && value.performer_kind === 'catalog') {
    value = { ...value, binding_state: value.service_date === null ? 'done_undated' : 'done_retained' }
    operation = value.service_date === null ? 'observe_done' : 'observe'
  }
  await append(client, root, null, value, operation, root.state === 'done' && value.service_date === null ? 'legacy_unknown' : origin)
  if (value.day_id) await reconcileDay(client, value.day_id)
}

export async function finishDayTransition(client: Queryable, prepared: DayTransition, to: DealState): Promise<void> {
  await assertTransitionToken(client, prepared)
  if (prepared.skip || prepared.root.state === to) return
  const root = await loadRoot(client, prepared.root.wedding_id, prepared.root.id)
  const previous = prepared.previous
  if (to === 'cancelled') {
    const value: Tuple = previous ? { ...previous, binding_state: 'released', day_id: null }
      : { ...tuple(prepared.root), binding_state: 'released', day_id: null }
    const released = await append(client, root, previous, value, previous ? 'release' : 'observe')
    await reconcile(client, prepared.groups, { id: released.id, dealId: root.id, reason: 'cancel' })
    return
  }
  if (prepared.erased && to === 'done') return
  if (!committed(prepared.root.state) && committed(to)) {
    let value = await acquire(client, root, tuple(root))
    let operation: Operation = 'acquire'
    if (to === 'done' && value.performer_kind === 'catalog') {
      value = { ...value, binding_state: value.service_date === null ? 'done_undated' : 'done_retained' }
      operation = value.service_date === null ? 'observe_done' : 'observe'
    }
    await append(client, root, previous, value, operation)
    if (value.day_id) await reconcileDay(client, value.day_id)
    return
  }
  if (to !== 'done') return
  if (!previous) {
    if (freshSelectedMain(prepared.root) && prepared.root.vendor_exists && prepared.root.vendor_id !== null
      && prepared.root.event_date === null) {
      await append(client, root, null, { ...tuple(prepared.root), binding_state: 'done_undated' }, 'observe_done')
      return
    }
    if (freshSelectedMain(prepared.root) && prepared.root.vendor_id === null && prepared.root.external_name !== null) {
      await append(client, root, null, { ...tuple(prepared.root), binding_state: 'external' }, 'observe')
      return
    }
    // Existing untracked committed roots do not acquire a date merely by
    // completing. Only a witnessed own physical DATE can support retention.
    const own = prepared.groups.length ? (await client.query<{ id: string }>(`select b.id from vendor_busy_dates b
      join deals p on p.id=b.deal_id where b.source='deal' and b.vendor_id=$1 and b.date=$2::date
      and p.wedding_id=$3 and p.state in ('booked','paid_deposit','done') order by b.id`,
    [prepared.root.vendor_id, prepared.root.event_date, root.wedding_id])).rows[0] : undefined
    if (own && prepared.root.vendor_exists && prepared.root.selected && prepared.root.is_main
      && prepared.root.event_date === prepared.root.wedding_date && prepared.root.event_tz === prepared.root.wedding_tz) {
      // The pre-state observation must be inserted before the caller's state
      // mutation; prepareTerminalDayTransition supplies it below.
      throw changed()
    }
    await append(client, root, null, { ...tuple(root), binding_state: 'unknown', day_id: null }, 'observe')
    return
  }
  if (previous.binding_state === 'active' || previous.binding_state === 'undated') {
    const retained = await append(client, root, previous, { ...previous,
      binding_state: previous.binding_state === 'active' ? 'done_retained' : 'done_undated' }, 'retain_done')
    if (retained.day_id) await reconcileDay(client, retained.day_id)
  } else if (previous.binding_state === 'external') {
    await append(client, root, previous, previous, 'retain_done')
  } else if (previous.binding_state !== 'unknown') throw changed()
}

export async function prepareTerminalDayTransition(client: Queryable, weddingId: string, dealId: string): Promise<DayTransition> {
  const result = await prepareDayTransition(client, weddingId, dealId)
  const root = result.root
  if (result.skip || result.erased || result.previous || !open(root.state)) return result
  const own = (await client.query<{ id: string }>(`select b.id from vendor_busy_dates b join deals p on p.id=b.deal_id
    where b.source='deal' and b.vendor_id=$1 and b.date=$2::date and p.wedding_id=$3
      and p.state in ('booked','paid_deposit','done') order by b.id`, [root.vendor_id, root.event_date, weddingId])).rows[0]
  if (!own || !root.vendor_exists || !root.selected || !root.is_main
    || root.event_date !== root.wedding_date || root.event_tz !== root.wedding_tz) return result
  const previous = await append(client, root, null, { ...tuple(root), binding_state: 'active', day_id: own.id }, 'observe')
  return bindTransition(client, { ...result, previous })
}

export interface MainDayChange { readonly weddingId: string; readonly date: string | null; readonly timeZone: string | null; readonly transitions: readonly DayTransition[] }
export async function prepareMainDayChange(client: Queryable, weddingId: string): Promise<MainDayChange> {
  await prepareDayWriter(client, weddingId)
  const wedding = (await client.query<{ date: string | null; tz: string | null }>(
    'select date::text,tz from weddings where id=$1 for update', [weddingId])).rows[0]
  if (!wedding) throw notFound('Свадьба не найдена')
  const roots = (await client.query<{ id: string }>(`select d.id from deals d join slots s on s.id=d.slot_id
    left join wedding_events e on e.id=s.program_event_id and e.wedding_id=d.wedding_id
    where d.wedding_id=$1 and d.state in ('booked','paid_deposit') and (s.program_event_id is null or e.is_main)
    order by d.id for update of d`, [weddingId])).rows
  const transitions: DayTransition[] = []
  for (const { id } of roots) transitions.push(await prepareDayTransition(client, weddingId, id))
  const result = Object.freeze({ weddingId, date: wedding.date, timeZone: wedding.tz, transitions: Object.freeze(transitions) })
  moves.set(result, { client, stamp: await stamp(client), observed: false, consumed: false })
  return result
}
export async function finishMainDayChange(client: Queryable, prepared: MainDayChange): Promise<void> {
  const binding = moves.get(prepared), current = await stamp(client)
  if (!binding || binding.client !== client || binding.consumed || current.pid !== binding.stamp.pid || current.txid !== binding.stamp.txid) throw changed()
  binding.consumed = true
  const wedding = (await client.query<{ date: string | null; tz: string | null }>('select date::text,tz from weddings where id=$1', [prepared.weddingId])).rows[0]
  if (!wedding) throw changed()
  if (wedding.date === prepared.date && wedding.tz === prepared.timeZone) return
  if (!binding.observed) throw changed()
  // First establish every old fact under its old context. The caller invokes
  // observeMainDayChange before changing the wedding/event rows.
  const published: { transition: DayTransition; version: Version }[] = []
  for (const transition of prepared.transitions) {
    await assertTransitionToken(client, transition)
    if (transition.skip) continue
    if (transition.erased) throw changed()
    const root = await loadRoot(client, prepared.weddingId, transition.root.id)
    const previous = await head(client, prepared.weddingId, root.id)
    if (!previous) throw changed()
    const value = await acquire(client, root, tuple(root))
    const moved = await append(client, root, previous, value, 'move')
    published.push({ transition, version: moved })
  }
  // No classifier/reconciliation observes an intermediate mixture of old
  // active claims and the new event context. Publish the whole OPEN unit first.
  for (const { transition, version } of published) await reconcile(client, transition.groups,
    { id: version.id, dealId: transition.root.id, reason: 'main_move' })
  const targets = [...new Set(published.flatMap(({ version }) => version.day_id ? [version.day_id] : []))].sort()
  for (const dayId of targets) await reconcileDay(client, dayId)
}
export async function observeMainDayChange(client: Queryable, prepared: MainDayChange): Promise<void> {
  const binding = moves.get(prepared), current = await stamp(client)
  if (!binding || binding.client !== client || binding.observed || binding.consumed || current.pid !== binding.stamp.pid || current.txid !== binding.stamp.txid) throw changed()
  binding.observed = true
  for (const transition of prepared.transitions) {
    if (transition.skip || transition.previous || transition.erased) continue
    await append(client, transition.root, null, { ...tuple(transition.root), binding_state: 'unknown', day_id: null }, 'observe')
  }
}
