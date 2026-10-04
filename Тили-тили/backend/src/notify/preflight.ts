import type { Db, Queryable } from '../plugins/db.js'
import { deliverAfter, knownTimeZone, localDayBounds } from './quiet.js'
import { PUSH_LIMIT_PER_DAY, PUSH_SPILL_DAYS } from './notify.js'
import { runNoticeTransaction } from './notice-transactions.js'

// Existing N parents and quota keys are prepared by the explicit owned adapter.
interface ReadyRow { user_id: string; kind: string; deliver_after: Date; expires_at: Date | null;
  disposition: string; cancelled_at: Date | null; pushed_at: Date | null; deleted_at: Date | null;
  tz: string | null; delivery_time_zone: string | null; enabled: boolean; quiet_from: string; quiet_to: string; now: Date }

/** Current channel/quiet state immediately before I/O. Does not infer incident urgency. */
export async function notificationPushReady(db: Db, id: string): Promise<boolean> {
  const check = async (client: Queryable) => {
    const initial = await client.query<{user_id:string}>('select user_id from notifications where id=$1',[id])
    if (!initial.rows[0]) return false
    // The original user quota key is already held after the sorted N prefix.
    const { rows } = await client.query<ReadyRow>(`select n.user_id,n.kind,n.deliver_after,n.expires_at,
      n.push_disposition as disposition,n.cancelled_at,n.pushed_at,u.deleted_at,u.tz,n.delivery_time_zone,
      case n.kind when 'chat' then coalesce(p.chats,true) when 'deal' then coalesce(p.deals,true)
        when 'task' then coalesce(p.tasks,true) else true end as enabled,
      coalesce(p.quiet_from::text,'22:00') as quiet_from,coalesce(p.quiet_to::text,'09:00') as quiet_to,
      clock_timestamp() as now
      from notifications n join users u on u.id=n.user_id left join notification_prefs p on p.user_id=u.id
      where n.id=$1 for update of n`,[id])
    const n = rows[0]
    if (!n || n.deleted_at || n.cancelled_at || n.pushed_at || n.disposition!=='planned'
      || (n.expires_at && n.expires_at<=n.now) || n.deliver_after>n.now) return false
    if (!n.enabled) {
      await client.query(`update notifications set push_disposition='inbox_only',pushed_at=now() where id=$1`,[id])
      return false
    }
    const tz = knownTimeZone(n.tz || n.delivery_time_zone)
    let after = deliverAfter(n.now,tz,{from:n.quiet_from,to:n.quiet_to},false)
    if (after<=n.now) return true
    let placed = false
    for (let day=0;day<PUSH_SPILL_DAYS;day++) {
      const bounds = localDayBounds(after,tz)
      const planned = await client.query<{n:string}>(`select count(*)::text as n from notifications n
        where n.user_id=$1 and n.id<>$2 and n.deliver_after >= $3 and n.deliver_after < $4
          and n.push_disposition<>'inbox_only' and (n.cancelled_at is null or n.pushed_at is not null
            or exists(select 1 from notification_push_deliveries d where d.notification_id=n.id and d.attempts>0))`,
        [n.user_id,id,bounds.from,bounds.to])
      if (Number(planned.rows[0]!.n)<PUSH_LIMIT_PER_DAY) { placed=true; break }
      after = new Date(after.getTime()+86_400_000)
    }
    if (!placed || (n.expires_at && after>=n.expires_at)) {
      await client.query(`update notifications set push_disposition='inbox_only',pushed_at=now() where id=$1`,[id])
    } else await client.query('update notifications set deliver_after=$2 where id=$1',[id,after])
    return false
  }
  return runNoticeTransaction(db, { noticeIds: [id] }, check)
}
