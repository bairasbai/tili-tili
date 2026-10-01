import { randomUUID } from 'node:crypto'
import { Agent } from 'node:https'
import webpush from 'web-push'
import type { Config } from '../config.js'
import type { Db, Queryable } from '../plugins/db.js'
import { pruneTaskNotifications, taskPushReady } from './task-notifications.js'
import { notificationPushReady } from './preflight.js'

export interface PushResult {
  /** Successful provider handoffs; not device delivery or reading. */
  sent: number
  /** Subscriptions removed after provider 404/410. */
  dropped: number
  /** Expired push windows; the inbox notice remains. */
  expired: number
}
export const PUSH_MAX_AGE_MS = 24 * 3_600_000
export const PUSH_MAX_ATTEMPTS = 5
export const PUSH_LEASE_MS = 60_000
export const PUSH_TIMEOUT_MS = 10_000
/** Yield the shared job worker between passes; pending rows stay durable. */
export const PUSH_PASS_BUDGET_MS = 30_000
const OPEN = "('queued','retry_wait','claimed')"

interface Claim {
  notification_id: string
  subscription_id: string
  attempts: number
  lease_token: string
}
interface Ready {
  title: string
  body: string
  link: string | null
  task_id: string | null
  endpoint: string
  keys: { p256dh: string; auth: string }
  ttl: number
}
export function pushConfigured(config: Config): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey)
}

/**
 * Durable bounded attempts for a snapshot of subscriptions. Acquire just one
 * lease immediately before I/O. A pre-send crash leaves a recoverable lease.
 * A crash AFTER provider acceptance but before persisting it can cause another
 * submission: Web Push has no transactional exactly-once acknowledgment.
 * notificationId identifies the notice; device delivery is never asserted.
 * Legacy pushed_at means the push plan settled, including expiration/refusal
 * or no subscription. Actual acceptance lives only in the delivery rows.
 */
export async function sendDuePushes(db: Db, config: Config, limit = 200): Promise<PushResult> {
  const started = performance.now()
  await pruneTaskNotifications(db)
  if (!pushConfigured(config)) return { sent: 0, dropped: 0, expired: 0 }
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('Push limit must be a non-negative integer')
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey!, config.vapidPrivateKey!)
  const result: PushResult = { sent: 0, dropped: 0, expired: 0 }

  // Never clear a live lease: the provider call in flight may be accepted.
  await db.query(`update notification_push_deliveries d
    set status=case when n.cancelled_at is not null or n.push_disposition<>'planned' then 'cancelled'
      when n.deliver_after<=now()-($1 || ' milliseconds')::interval or n.expires_at<=now() then 'expired'
      when d.attempts >= $2 then 'permanent_failure' else 'cancelled' end,
      last_error=case when d.attempts >= $2 then 'attempt_limit' else d.last_error end,
      lease_token=null,lease_until=null,updated_at=now()
    from notifications n where n.id=d.notification_id and d.status in ${OPEN}
      and (d.status<>'claimed' or d.lease_until<=now())
      and (n.cancelled_at is not null or n.push_disposition<>'planned' or n.deliver_after<=now()-($1 || ' milliseconds')::interval
        or n.expires_at<=now() or d.attempts >= $2
        or not exists (select 1 from push_subscriptions s join users u on u.id=s.user_id
          where s.id=d.subscription_id and s.user_id=n.user_id and u.deleted_at is null))`,
  [String(PUSH_MAX_AGE_MS), PUSH_MAX_ATTEMPTS])
  const stale = await db.query(`update notifications n set pushed_at=now(),push_disposition='processed'
    where n.cancelled_at is null and n.pushed_at is null and n.push_disposition='planned'
      and (n.deliver_after<=now()-($1 || ' milliseconds')::interval or n.expires_at<=now())
      and not exists (select 1 from notification_push_deliveries d
        where d.notification_id=n.id and d.status='claimed' and d.lease_until>now())`, [String(PUSH_MAX_AGE_MS)])
  result.expired = stale.rowCount ?? 0

  await db.tx(async client => {
    const { rows } = await client.query<{ id: string; user_id: string }>(`select n.id,n.user_id
      from notifications n where n.cancelled_at is null and n.pushed_at is null and n.push_disposition='planned'
        and n.deliver_after<=now()
        and not exists (select 1 from notification_push_deliveries d where d.notification_id=n.id)
      order by n.deliver_after,n.id limit $1 for update of n skip locked`, [limit])
    for (const notice of rows) {
      if (performance.now()-started>=PUSH_PASS_BUDGET_MS) break
      const inserted = await client.query(`insert into notification_push_deliveries(notification_id,subscription_id)
        select $1,s.id from push_subscriptions s join users u on u.id=s.user_id
          where s.user_id=$2 and u.deleted_at is null on conflict do nothing`, [notice.id, notice.user_id])
      if (!inserted.rowCount) await client.query("update notifications set pushed_at=now(),push_disposition='processed' where id=$1 and push_disposition='planned'", [notice.id])
    }
  })

  for (let i = 0; i < limit; i++) {
    if (performance.now()-started>=PUSH_PASS_BUDGET_MS) break
    const token = randomUUID()
    // MATERIALIZED freezes a single candidate. A self-table IN subquery can
    // be rescanned by a nested-loop plan while this UPDATE changes eligibility.
    const { rows } = await db.query<Claim>(`with candidate as materialized (
        select q.notification_id,q.subscription_id from notification_push_deliveries q
          join notifications n on n.id=q.notification_id
          join push_subscriptions s on s.id=q.subscription_id and s.user_id=n.user_id
          join users u on u.id=n.user_id
        where n.cancelled_at is null and n.pushed_at is null and n.push_disposition='planned' and u.deleted_at is null
          and n.deliver_after<=now() and n.deliver_after>now()-($3 || ' milliseconds')::interval
          and (n.expires_at is null or n.expires_at>now()) and q.attempts<$4
          and ((q.status in ('queued','retry_wait') and q.next_attempt_at<=now())
            or (q.status='claimed' and q.lease_until<=now()))
        order by q.next_attempt_at,n.deliver_after,q.notification_id,q.subscription_id
        limit 1 for update of q skip locked
      ) update notification_push_deliveries d
        set status='claimed',attempts=d.attempts+1,lease_token=$1,
          lease_until=now()+($2 || ' milliseconds')::interval,updated_at=now()
        from candidate c where d.notification_id=c.notification_id and d.subscription_id=c.subscription_id
      returning d.notification_id,d.subscription_id,d.attempts,d.lease_token`,
    [token, String(PUSH_LEASE_MS), String(PUSH_MAX_AGE_MS), PUSH_MAX_ATTEMPTS])
    const claim = rows[0]
    if (!claim) break
    const params = [claim.notification_id, claim.subscription_id, claim.lease_token]
    const finish = async (status: string, error: string | null, delay = 0, client: Queryable = db, unsent = false): Promise<boolean> => {
      const transition = await client.query(`update notification_push_deliveries set status=$4,
        provider_accepted_at=case when $4='provider_accepted' then now() else null end,
        last_error=$5,next_attempt_at=now()+($6 || ' milliseconds')::interval,
        attempts=case when $7::boolean then greatest(0,attempts-1) else attempts end,
        lease_token=null,lease_until=null,updated_at=now()
        where notification_id=$1 and subscription_id=$2 and lease_token=$3 and status='claimed'
          and lease_until>clock_timestamp()`,
      [...params, status, error, String(delay), unsent])
      return transition.rowCount === 1
    }
    const releaseUnsent = async () => db.query(`update notification_push_deliveries d
      set status='queued',attempts=greatest(0,d.attempts-1),
        next_attempt_at=greatest(n.deliver_after,now()),lease_token=null,lease_until=null,updated_at=now()
      from notifications n where n.id=d.notification_id and d.notification_id=$1
        and d.subscription_id=$2 and d.lease_token=$3 and d.status='claimed'
        and d.lease_until>clock_timestamp()`, params)
    const resolveUnsent = async () => {
      const current = await db.query<{ status: 'queued' | 'expired' | 'cancelled' }>(`select
        case when n.cancelled_at is not null or n.push_disposition<>'planned' then 'cancelled'
          when n.deliver_after<=now()-($2 || ' milliseconds')::interval or n.expires_at<=now() then 'expired'
          when n.deliver_after>now() then 'queued' else 'cancelled' end as status
        from notifications n where n.id=$1`, [claim.notification_id, String(PUSH_MAX_AGE_MS)])
      const status = current.rows[0]?.status ?? 'cancelled'
      if (status==='queued') await releaseUnsent()
      else await finish(status, status==='expired' ? 'push_window_expired' : 'no_longer_eligible', 0, db, true)
    }
    // Current cancellation, expiration, owner and subscription, not stale snapshot.
    const ready = async () => (await db.query<Ready>(`select n.title,n.body,n.link,n.task_id,s.endpoint,s.keys,
        greatest(1,floor(extract(epoch from (least(n.deliver_after+($4 || ' milliseconds')::interval,
          coalesce(n.expires_at,n.deliver_after+($4 || ' milliseconds')::interval))-now()))))::int as ttl
      from notifications n join notification_push_deliveries d on d.notification_id=n.id
        join push_subscriptions s on s.id=d.subscription_id and s.user_id=n.user_id
        join users u on u.id=n.user_id
      where n.id=$1 and d.subscription_id=$2 and d.lease_token=$3 and d.status='claimed'
        and d.lease_until>now() and n.cancelled_at is null and n.pushed_at is null and n.push_disposition='planned'
        and u.deleted_at is null and n.deliver_after<=now()
        and n.deliver_after>now()-($4 || ' milliseconds')::interval
        and (n.expires_at is null or n.expires_at>now())`, [...params, String(PUSH_MAX_AGE_MS)])).rows[0]
    if (!await notificationPushReady(db, claim.notification_id)) {
      await resolveUnsent()
      continue
    }
    let item = await ready()
    if (item?.task_id && !await taskPushReady(db, claim.notification_id)) {
      // Quiet edits defer; invalid tasks cancel. No outbound attempt happened.
      await resolveUnsent()
      continue
    }
    if (item && !await notificationPushReady(db, claim.notification_id)) {
      await resolveUnsent()
      continue
    }
    if (item) item = await ready()
    if (!item) {
      await resolveUnsent()
      continue
    }
    const remaining = Math.floor(PUSH_PASS_BUDGET_MS-(performance.now()-started))
    if (remaining<=0) { await releaseUnsent(); break }
    const requestTimeout = Math.min(PUSH_TIMEOUT_MS, remaining)
    // Catch provider I/O only. A DB failure must retain the recoverable lease.
    let failure: unknown
    let accepted = false
    // web-push's timeout is socket inactivity, not a total request deadline.
    // This disposable agent also aborts its sockets at the absolute deadline;
    // racing the promise alone would leave the network request alive.
    const agent = new Agent({ keepAlive: false })
    let deadline: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        agent.destroy()
        reject(new Error('Push request deadline'))
      }, requestTimeout)
      deadline.unref()
    })
    try {
      await Promise.race([webpush.sendNotification({ endpoint: item.endpoint, keys: item.keys },
        JSON.stringify({ title: item.title, body: item.body,
          data: { link: item.link, notificationId: claim.notification_id } }),
        { timeout: requestTimeout, TTL: item.ttl, agent }), timeout])
      accepted = true
    } catch (error) { failure = error }
    finally { clearTimeout(deadline); agent.destroy() }
    if (accepted) {
      result.sent += 1
      await finish('provider_accepted', null)
    } else {
      const status = (failure as { statusCode?: number } | null)?.statusCode
      const gone = status === 404 || status === 410
      const permanent = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
      const error = typeof status === 'number' ? `http_${status}` : 'transport_failure'
      const delay = 60_000 * 2 ** (claim.attempts - 1)
      if (gone) {
        // Destructive side effects require a successful fenced transition.
        // Losing this lease makes a late refusal obsolete. Transition/removal
        // commit together so a DB failure leaves the claim recoverable.
        result.dropped += await db.tx(async client => {
          if (!await finish('permanent_failure', error, delay, client)) return 0
          const removed = await client.query(`delete from push_subscriptions s using notifications n
            where s.id=$2 and n.id=$1 and s.user_id=n.user_id`, params.slice(0, 2))
          if (removed.rowCount) await client.query(`update notification_push_deliveries
            set status='permanent_failure',last_error='subscription_gone',
              lease_token=null,lease_until=null,updated_at=now()
            where subscription_id=$1 and status in ('queued','retry_wait')`, [claim.subscription_id])
          return removed.rowCount ?? 0
        })
      } else await finish(permanent || claim.attempts>=PUSH_MAX_ATTEMPTS ? 'permanent_failure' : 'retry_wait', error, delay)
    }
  }
  const finalized = await db.query<{ expired: boolean }>(`update notifications n set pushed_at=now(),push_disposition='processed'
    where n.pushed_at is null and n.push_disposition='planned'
    and exists (select 1 from notification_push_deliveries d where d.notification_id=n.id)
    and not exists (select 1 from notification_push_deliveries d where d.notification_id=n.id and d.status in ${OPEN})
    returning exists (select 1 from notification_push_deliveries d
      where d.notification_id=n.id and d.status='expired') as expired`)
  result.expired += finalized.rows.filter(row => row.expired).length
  return result
}
