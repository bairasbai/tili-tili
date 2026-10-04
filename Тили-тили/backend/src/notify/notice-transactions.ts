import type { Db, Queryable } from '../plugins/db.js'
import { conflict } from '../errors.js'

const sorted = (ids: readonly string[]) => [...new Set(ids.map(id => id.toLowerCase()))].sort()
const changed = () => conflict('resource_source_changed', 'Источник уведомления изменился — повторите подготовку')
interface NoticeParent { id: string; user_id: string; task_id: string | null; task_version: string | null;
  wedding_id: string | null; assignee_id: string | null }
interface SubscriptionParent { id: string; user_id: string }
interface DeliveryParent { notification_id: string; subscription_id: string }
export interface NoticeMutationInput {
  noticeIds: readonly string[]
  subscriptionIds?: readonly string[]
  /** Current subscriptions for initialization; ID/owner maps are rechecked. */
  subscriptionUserIds?: readonly string[]
  subscriptionMutation?: boolean
  /** Subscription mutation closes original/historical N parents, even before
   * a delivery row exists. Also acquires these users' actual quota keys. */
  allNoticeUserIds?: readonly string[]
  extraAccountIds?: readonly string[]
  /** Explicit registered owner only: pin its already prepared actor/session/
   * consent before old N and quota, using this exact owned callback client. */
  beforeNotices?: (client: Queryable) => Promise<void>
}
interface Located {
  notices: NoticeParent[]
  subscriptions: SubscriptionParent[]
  deliveries: DeliveryParent[]
  weddings: string[]
  tasks: string[]
  accounts: string[]
  quotaUsers: string[]
}
async function locate(client: Queryable, input: NoticeMutationInput): Promise<Located> {
  const subscriptions = (await client.query<SubscriptionParent>(
    'select id,user_id from push_subscriptions where id=any($1::uuid[]) or user_id=any($2::uuid[]) order by id',
    [sorted(input.subscriptionIds ?? []), sorted(input.subscriptionUserIds ?? [])])).rows
  const related = (await client.query<{ notification_id: string }>(
    'select distinct notification_id from notification_push_deliveries where subscription_id=any($1::uuid[]) order by notification_id',
    [subscriptions.map(s => s.id)])).rows.map(d => d.notification_id)
  const allNoticeUsers = sorted([...(input.allNoticeUserIds ?? []),
    ...(input.subscriptionMutation ? subscriptions.map(s => s.user_id) : [])])
  const notices = (await client.query<NoticeParent>(`select n.id,n.user_id,n.task_id,n.task_version::text,
    t.wedding_id,t.assignee_id from notifications n left join tasks t on t.id=n.task_id
    where n.id=any($1::uuid[]) or n.user_id=any($2::uuid[]) order by n.id`,
    [sorted([...input.noticeIds, ...related]), allNoticeUsers])).rows
  const deliveries = (await client.query<DeliveryParent>(`select notification_id,subscription_id
    from notification_push_deliveries where notification_id=any($1::uuid[]) order by notification_id,subscription_id`,
    [notices.map(n => n.id)])).rows
  const weddings = sorted(notices.flatMap(n => n.wedding_id ? [n.wedding_id] : []))
  const parents = (await client.query<{ user_id: string }>(`select owner_id as user_id from weddings where id=any($1::uuid[])
    union select user_id from wedding_members where wedding_id=any($1::uuid[])`, [weddings])).rows
  return { notices, subscriptions, deliveries, weddings, tasks: sorted(notices.flatMap(n => n.task_id ? [n.task_id] : [])),
    accounts: sorted([...notices.map(n => n.user_id), ...notices.flatMap(n => n.assignee_id ? [n.assignee_id] : []),
      ...subscriptions.map(s => s.user_id), ...parents.map(p => p.user_id), ...(input.extraAccountIds ?? []),
      ...allNoticeUsers, ...(input.subscriptionUserIds ?? [])]),
    quotaUsers: sorted([...notices.map(n => n.user_id), ...allNoticeUsers]) }
}

/** Explicit owned-client preparation, called only by runNoticeTransaction or
 * the existing push initialization Db.tx. No Queryable-shaped ownership claim.
 * Generic notices have a user parent only: their text link is never an ACL/root.
 * Future structured A12 fact/epoch sources require their separate adapter. */
export async function prepareExistingNoticeScope(client: Queryable, input: NoticeMutationInput): Promise<{
  noticeIds: readonly string[]; assertParents(): Promise<void>
}> {
  const stamp = (await client.query<{ pid: number; txid: string }>(
    'select pg_backend_pid() as pid,txid_current()::text as txid')).rows[0]!
  const located = await locate(client, input)
  await client.query('select id from weddings where id=any($1::uuid[]) order by id for update', [located.weddings])
  await client.query('select id from users where id=any($1::uuid[]) order by id for share', [located.accounts])
  await client.query('select user_id from notification_prefs where user_id=any($1::uuid[]) order by user_id for share', [located.accounts])
  await client.query('select user_id from wedding_members where wedding_id=any($1::uuid[]) order by wedding_id,user_id for share', [located.weddings])
  await client.query('select id from tasks where id=any($1::uuid[]) order by id for share', [located.tasks])
  await input.beforeNotices?.(client)
  // Pin every old row in one ID order before ANY quota acquisition.
  await client.query('select id from notifications where id=any($1::uuid[]) order by id for update', [located.notices.map(n => n.id)])
  const assertParents = async () => {
    const current = (await client.query<{ pid: number; txid: string }>(
      'select pg_backend_pid() as pid,txid_current()::text as txid')).rows[0]!
    if (stamp.pid !== current.pid || stamp.txid !== current.txid) throw changed()
    if (JSON.stringify(await locate(client, input)) !== JSON.stringify(located)) throw changed()
  }
  await assertParents()
  const keys = (await client.query<{ key: number }>(
    'select distinct hashtext(u) as key from unnest($1::text[]) u order by key',
    [located.quotaUsers])).rows
  for (const { key } of keys) {
    if (!Number.isInteger(key) || key < -2147483648 || key > 2147483647) throw new Error('Invalid PostgreSQL quota key')
    await client.query('select pg_advisory_xact_lock($1::int,$2::int)', [4_210_005, key])
  }
  // Subscription/delivery mutations are children of the original prepared N.
  // Binding epochs and immutable attempt facts are NOT invented by this adapter.
  await client.query('select id from push_subscriptions where id=any($1::uuid[]) order by id for update', [located.subscriptions.map(s => s.id)])
  await client.query(`select notification_id,subscription_id from notification_push_deliveries
    where notification_id=any($1::uuid[]) order by notification_id,subscription_id for update`, [located.notices.map(n => n.id)])
  await assertParents()
  return { noticeIds: located.notices.map(n => n.id), assertParents }
}

/** Real Db owns this transaction, independently of the twelve fanout owners. */
export async function runNoticeTransaction<T>(db: Db, input: NoticeMutationInput,
  action: (client: Queryable, noticeIds: readonly string[]) => Promise<T>): Promise<T> {
  return db.tx(async client => {
    const scope = await prepareExistingNoticeScope(client, input)
    return action(client, scope.noticeIds)
  })
}
