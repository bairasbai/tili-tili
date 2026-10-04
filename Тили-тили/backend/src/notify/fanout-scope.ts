import type { Queryable } from '../plugins/db.js'
import { conflict, notFound } from '../errors.js'

const ids = (values: readonly string[]) => [...new Set(values.map(id => id.toLowerCase()))].sort()
const changed = () => conflict('resource_source_changed', 'Область уведомлений изменилась — обновите данные')
interface AccountMap { id: string }
interface MemberMap { wedding_id: string; user_id: string; role: string }
interface VendorMap { id: string; user_id: string }
interface ResourceMap { id: string; vendor_id: string | null; person_user_id: string | null;
  staff_member_id: string | null; kind: string; conflict_identity: string }
interface StaffMap { id: string; vendor_id: string; user_id: string | null }
interface TaskMap { id: string; wedding_id: string; assignee_id: string | null }
interface NoticeMap { id: string; user_id: string; task_id: string | null }
interface RequestMap { id: string; slot_id: string; vendor_id: string | null }
interface DealMap { id: string; slot_id: string; vendor_id: string | null }
interface SlotMap { id: string; wedding_id: string }
interface OrderMap { deal_id: string; resource_plan_id: string | null }
interface TransactionIdentity { pid: number; txid: string }

export interface FanoutLocator {
  weddingId: string
  actorId: string | null
  extraVendorIds?: readonly string[]
  /** Explicit catalog selection; its original owner is a private booking source. */
  selectedCatalogVendorId?: string
}
interface Located {
  wedding: { id: string; owner_id: string }[]
  members: MemberMap[]
  vendors: VendorMap[]
  resources: ResourceMap[]
  staff: StaffMap[]
  tasks: TaskMap[]
  notices: NoticeMap[]
  requests: RequestMap[]
  deals: DealMap[]
  slots: SlotMap[]
  orders: OrderMap[]
  keys: { kind: string; identity: string }[]
  accounts: string[]
}

/** IDs and parent maps only. No endpoint, phone, contact or private projection is exported. */
async function locate(client: Queryable, input: FanoutLocator): Promise<Located> {
  const wedding = (await client.query<{ id: string; owner_id: string }>(
    'select id,owner_id from weddings where id=$1', [input.weddingId])).rows
  const members = (await client.query<MemberMap>(
    'select wedding_id,user_id,role from wedding_members where wedding_id=$1 order by user_id', [input.weddingId])).rows
  const tasks = (await client.query<TaskMap>(
    'select id,wedding_id,assignee_id from tasks where wedding_id=$1 order by id', [input.weddingId])).rows
  // Include historical notice recipients, not merely today's task assignee.
  const notices = (await client.query<NoticeMap>(
    'select id,user_id,task_id from notifications where task_id=any($1::uuid[]) order by id', [tasks.map(t => t.id)])).rows
  const requests = (await client.query<RequestMap>(`select r.id,r.slot_id,r.vendor_id from offer_requests r
    join slots s on s.id=r.slot_id where s.wedding_id=$1 order by r.id`, [input.weddingId])).rows
  const deals = (await client.query<DealMap>(
    'select id,slot_id,vendor_id from deals where wedding_id=$1 order by id', [input.weddingId])).rows
  const slots = (await client.query<SlotMap>(
    'select id,wedding_id from slots where wedding_id=$1 order by id', [input.weddingId])).rows
  const orders = (await client.query<OrderMap>(
    'select deal_id,resource_plan_id from deal_orders where wedding_id=$1 order by deal_id', [input.weddingId])).rows
  const resources = (await client.query<ResourceMap>(`select r.id,r.vendor_id,r.person_user_id,r.staff_member_id,r.kind,r.conflict_identity
    from vendor_resources r where exists(select 1 from resource_allocations a where a.wedding_id=$1 and a.resource_id=r.id)
      or exists(select 1 from deal_orders o join deal_resource_plan_versions p on p.id=o.resource_plan_id
        where o.wedding_id=$1 and exists(select 1 from jsonb_array_elements(p.private_snapshot->'lines') line
          where line->>'resourceId'=r.id::text)) order by r.id`, [input.weddingId])).rows
  const staff = (await client.query<StaffMap>(
    'select id,vendor_id,user_id from vendor_staff_members where id=any($1::uuid[]) order by id',
    [ids(resources.flatMap(r => r.staff_member_id ? [r.staff_member_id] : []))])).rows
  const vendors = (await client.query<VendorMap>(`select v.id,v.user_id from vendors v
    where v.id=any($2::uuid[]) or v.id=any($3::uuid[])
      or exists(select 1 from deals d where d.wedding_id=$1 and d.vendor_id=v.id)
      or exists(select 1 from offer_requests q join slots s on s.id=q.slot_id where s.wedding_id=$1 and q.vendor_id=v.id)
      or exists(select 1 from slot_shortlist e join slots s on s.id=e.slot_id where s.wedding_id=$1 and e.vendor_id=v.id)
    order by v.id`, [input.weddingId, ids(input.extraVendorIds ?? []),
    ids([...resources.flatMap(r => r.vendor_id ? [r.vendor_id] : []), ...staff.map(m => m.vendor_id)])])).rows
  const allocationKeys = (await client.query<{ kind: string; identity: string }>(
    'select distinct kind,conflict_identity as identity from resource_allocations where wedding_id=$1', [input.weddingId])).rows
  const keys = [...new Map([...allocationKeys, ...resources.map(r => ({ kind: r.kind, identity: r.conflict_identity }))]
    .map(key => [`${key.kind}:${key.identity}`, key])).values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.identity.localeCompare(b.identity))
  const accounts = ids([...(input.actorId ? [input.actorId] : []), ...wedding.map(w => w.owner_id),
    ...members.map(m => m.user_id), ...vendors.map(v => v.user_id), ...notices.map(n => n.user_id),
    ...tasks.flatMap(t => t.assignee_id ? [t.assignee_id] : []),
    ...resources.flatMap(r => r.person_user_id ? [r.person_user_id] : []), ...staff.flatMap(m => m.user_id ? [m.user_id] : [])])
  return { wedding, members, vendors, resources, staff, tasks, notices, requests, deals, slots, orders, keys, accounts }
}

const identity = async (client: Queryable) => (await client.query<TransactionIdentity>(
  'select pg_backend_pid() as pid,txid_current()::text as txid')).rows[0]!

export interface PreparedFanoutScope {
  readonly accounts: ReadonlySet<string>
  assertIdentity(): Promise<void>
  assertParents(): Promise<void>
}

/** Only the registered outer Db.tx/IdempotentTx callbacks call this factory.
 * Queryable does not prove transaction ownership. PID/txid binds continued use,
 * while the explicit owning route is responsible for BEGIN/COMMIT/ROLLBACK. */
export async function prepareFanoutScope(client: Queryable, input: FanoutLocator,
  afterPins: () => Promise<void>): Promise<PreparedFanoutScope> {
  const stamp = await identity(client)
  await client.query('select id from weddings where id=$1 for update', [input.weddingId])
  const located = await locate(client, input)
  if (located.wedding.length !== 1) throw notFound('Свадьба не найдена')
  // Same financial prefix as resource erasure; no account/company precedes it.
  await client.query(`select r.id from offer_requests r join slots s on s.id=r.slot_id
    where s.wedding_id=$1 order by r.id for update of r`, [input.weddingId])
  await client.query('select id from deals where wedding_id=$1 order by id for update', [input.weddingId])
  await client.query('select id from slots where wedding_id=$1 order by id for update', [input.weddingId])
  await client.query('select deal_id from deal_orders where wedding_id=$1 order by deal_id for update', [input.weddingId])
  // SHARE protects profile/default-pref writers yet permits immediate notify's
  // after-quota user FK KEY SHARE. Blanket UPDATE here would invert that peer.
  await client.query<AccountMap>('select id from users where id=any($1::uuid[]) order by id for share', [located.accounts])
  await client.query('select user_id from notification_prefs where user_id=any($1::uuid[]) order by user_id for share', [located.accounts])
  await client.query('select id from vendors where id=any($1::uuid[]) order by id for share', [located.vendors.map(v => v.id)])
  await client.query('select id from vendor_staff_members where id=any($1::uuid[]) order by id for share', [located.staff.map(m => m.id)])
  for (const key of located.keys) {
    await client.query('insert into resource_conflict_keys(kind,identity) values($1,$2) on conflict do nothing', [key.kind, key.identity])
    await client.query('select identity from resource_conflict_keys where kind=$1 and identity=$2 for update', [key.kind, key.identity])
  }
  await client.query('select id from vendor_resources where id=any($1::uuid[]) order by id for update', [located.resources.map(r => r.id)])
  await client.query('select id from resource_capacity_windows where resource_id=any($1::uuid[]) order by id for update', [located.resources.map(r => r.id)])
  await client.query('select id from resource_allocations where wedding_id=$1 order by id for update', [input.weddingId])
  await client.query('select user_id from wedding_members where wedding_id=$1 order by user_id for share', [input.weddingId])
  await client.query('select id from tasks where wedding_id=$1 order by id for update', [input.weddingId])
  await client.query('select id from notifications where id=any($1::uuid[]) order by id for update', [located.notices.map(n => n.id)])
  // All original sorted pins are held before this read-only ACL callback.
  // It neither discovers nor acquires a replacement account/company parent.
  await afterPins()
  const selectedCatalogId = input.selectedCatalogVendorId?.toLowerCase()
  const originalCatalogVendor = selectedCatalogId ? located.vendors.find(v => v.id === selectedCatalogId) : undefined
  const assertCatalogOwner = (current: readonly VendorMap[]) => {
    if (!selectedCatalogId) return
    const selected = current.find(v => v.id === selectedCatalogId)
    if (!originalCatalogVendor || !selected || selected.user_id !== originalCatalogVendor.user_id) {
      throw notFound('Подрядчик не найден')
    }
  }
  const pinned = await locate(client, input)
  assertCatalogOwner(pinned.vendors)
  if (JSON.stringify(pinned) !== JSON.stringify(located)) throw changed()
  const assertIdentity = async () => {
    const current = await identity(client)
    if (current.pid !== stamp.pid || current.txid !== stamp.txid) throw changed()
  }
  const assertParents = async () => {
    await assertIdentity()
    // Own domain work may change assignments, release allocations and create
    // rows. Existing source parent identities and the pre-pinned recipient set
    // must remain stable; never acquire a newly discovered parent after quota.
    const currentMembers = (await client.query<MemberMap>(
      'select wedding_id,user_id,role from wedding_members where wedding_id=$1 order by user_id', [input.weddingId])).rows
    const currentVendors = (await client.query<VendorMap>(
      'select id,user_id from vendors where id=any($1::uuid[]) order by id', [located.vendors.map(v => v.id)])).rows
    const currentResources = (await client.query<ResourceMap>(
      'select id,vendor_id,person_user_id,staff_member_id,kind,conflict_identity from vendor_resources where id=any($1::uuid[]) order by id',
      [located.resources.map(r => r.id)])).rows
    const currentStaff = (await client.query<StaffMap>(
      'select id,vendor_id,user_id from vendor_staff_members where id=any($1::uuid[]) order by id', [located.staff.map(m => m.id)])).rows
    const currentNotices = (await client.query<NoticeMap>(
      'select id,user_id,task_id from notifications where id=any($1::uuid[]) order by id', [located.notices.map(n => n.id)])).rows
    const currentWedding = (await client.query<{ id: string; owner_id: string }>(
      'select id,owner_id from weddings where id=$1', [input.weddingId])).rows
    const currentRequests = (await client.query<RequestMap>(
      'select id,slot_id,vendor_id from offer_requests where id=any($1::uuid[]) order by id', [located.requests.map(r => r.id)])).rows
    const currentDeals = (await client.query<DealMap>(
      'select id,slot_id,vendor_id from deals where id=any($1::uuid[]) order by id', [located.deals.map(d => d.id)])).rows
    const currentSlots = (await client.query<SlotMap>(
      'select id,wedding_id from slots where id=any($1::uuid[]) order by id', [located.slots.map(s => s.id)])).rows
    const currentOrders = (await client.query<OrderMap>(
      'select deal_id,resource_plan_id from deal_orders where deal_id=any($1::uuid[]) order by deal_id', [located.orders.map(o => o.deal_id)])).rows
    const currentTasks = (await client.query<TaskMap>(
      'select id,wedding_id,assignee_id from tasks where id=any($1::uuid[]) order by id', [located.tasks.map(t => t.id)])).rows
    assertCatalogOwner(currentVendors)
    for (const [old, current] of [[located.members, currentMembers], [located.vendors, currentVendors],
      [located.resources, currentResources], [located.staff, currentStaff], [located.notices, currentNotices],
      [located.wedding, currentWedding], [located.requests, currentRequests], [located.deals, currentDeals],
      [located.slots, currentSlots], [located.orders, currentOrders], [located.tasks, currentTasks]]) {
      if (JSON.stringify(old) !== JSON.stringify(current)) throw changed()
    }
  }
  return { accounts: new Set(located.accounts), assertIdentity, assertParents }
}
