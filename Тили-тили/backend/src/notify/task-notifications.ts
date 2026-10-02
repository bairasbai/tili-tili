import type { FastifyInstance } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { notify } from './notify.js'
import { deliverAfter, knownTimeZone } from './quiet.js'

/** Same fallback as notify(): recipient profile, wedding, then Moscow. */
const TZ = `coalesce((select name from pg_timezone_names
  where name=coalesce(nullif(u.tz,''),w.tz,'Europe/Moscow')), 'Europe/Moscow')`
const SCHEDULED = `((t.due-t.reminder_days_before::int)+t.reminder_time) at time zone (${TZ})`
const LIVE = `t.kind='checklist' and t.done_at is null and t.assignee_id is not null
  and u.deleted_at is null and w.archived_at is null and w.cancelled_at is null
  and exists (select 1 from wedding_members m where m.wedding_id=t.wedding_id
    and m.user_id=t.assignee_id and m.role in ('couple','helper','coordinator'))`

/** Rechecked at inbox read and immediately before handing a push to the provider. */
export const TASK_NOTICE_VALID = `n.cancelled_at is null and exists (
  select 1 from tasks t join weddings w on w.id=t.wedding_id
  join users u on u.id=t.assignee_id
  where t.id=n.task_id and t.notice_version=n.task_version and t.assignee_id=n.user_id
    and ${LIVE}
    and (n.task_event<>'reminder' or t.reminder_days_before is not null)
    and n.expires_at > $1
)`

export async function pruneTaskNotifications(db: Queryable, now = new Date(), userId: string | null = null): Promise<void> {
  await db.query(`update notifications n set cancelled_at=$1 where n.cancelled_at is null and n.task_id is not null and ($2::uuid is null or n.user_id=$2) and not (${TASK_NOTICE_VALID})`, [now, userId])
}

/** Quiet-hour edits after enqueue are respected too; no lock is held during network I/O. */
export async function taskPushReady(db: Queryable, noticeId: string, now = new Date()): Promise<boolean> {
  const { rows } = await db.query<{ tz: string | null; wedding_tz: string | null; quiet_from: string; quiet_to: string; expires_at: Date; enabled: boolean; push_disposition: string }>(
    `select u.tz,w.tz as wedding_tz,coalesce(p.quiet_from::text,'22:00') as quiet_from,
       coalesce(p.quiet_to::text,'09:00') as quiet_to,n.expires_at,coalesce(p.tasks,true) as enabled,n.push_disposition
     from notifications n join users u on u.id=n.user_id
     join tasks t on t.id=n.task_id join weddings w on w.id=t.wedding_id
     left join notification_prefs p on p.user_id=u.id
     where n.id=$2 and ${TASK_NOTICE_VALID}`, [now, noticeId])
  const row = rows[0]
  if (!row) return false
  if (!row.enabled) {
    await db.query("update notifications set push_disposition='inbox_only',pushed_at=coalesce(pushed_at,$2) where id=$1 and cancelled_at is null",[noticeId,now])
    return false
  }
  if (row.push_disposition!=='planned') return false
  const after = deliverAfter(now, knownTimeZone(row.tz || row.wedding_tz), { from: row.quiet_from, to: row.quiet_to }, false)
  if (after > now) {
    if (after >= row.expires_at) await db.query('update notifications set cancelled_at=$2 where id=$1', [noticeId, now])
    else await db.query('update notifications set pushed_at=null,deliver_after=$2 where id=$1 and cancelled_at is null', [noticeId, after])
    return false
  }
  return true
}

/** Database-only work inside the task transaction; no external network operation. */
export async function notifyTaskAssignment(db: Queryable, taskId: string, actorId: string,
  previousAssigneeId: string | null, now = new Date()): Promise<void> {
  const { rows } = await db.query<{ id: string; title: string; assignee_id: string; notice_version: string; wedding_id: string; tz: string | null }>(
    `select t.id,t.title,t.assignee_id,t.notice_version::text,t.wedding_id,w.tz
       from tasks t join weddings w on w.id=t.wedding_id join users u on u.id=t.assignee_id
      where t.id=$1 and ${LIVE}`, [taskId])
  const task = rows[0]
  if (!task || task.assignee_id === actorId || task.assignee_id === previousAssigneeId) return
  await notify(db, { userId: task.assignee_id, kind: 'task', title: 'Вам назначена задача', body: task.title,
    link: `/wedding/checklist?task=${task.id}&wedding=${task.wedding_id}`, respectQuietHours: true,
    task: { id: task.id, version: task.notice_version, event: 'assignment', expiresAt: new Date(now.getTime()+86_400_000) },
  }, now, task.tz)
}

interface ReminderRow {
  id: string; title: string; assignee_id: string; notice_version: string; wedding_id: string; tz: string | null
  scheduled_at: Date; deadline_end: Date
}
export interface TaskReminderResult { queued: number; suppressed: number; expired: number }

/**
 * A durable per-version mark and the notification are committed together.
 * Lock order matches task writes: wedding -> recipient -> task. A second
 * worker rechecks the version after the lock, and cannot create a duplicate.
 */
export async function sendTaskReminders(app: FastifyInstance, now = new Date(), limit = 200): Promise<TaskReminderResult> {
  const db = app.db!
  await pruneTaskNotifications(db, now)
  const result: TaskReminderResult = { queued: 0, suppressed: 0, expired: 0 }
  const { rows: candidates } = await db.query<{ id: string; wedding_id: string }>(
    `select t.id,t.wedding_id from tasks t join weddings w on w.id=t.wedding_id
       join users u on u.id=t.assignee_id
      where ${LIVE} and t.reminder_days_before is not null
        and t.reminded_version is distinct from t.notice_version and (${SCHEDULED}) <= $1
      order by t.due,t.id limit $2`, [now, limit])
  let failed = 0
  for (const candidate of candidates) {
    try {
      const outcome = await db.tx(async client => {
        const wedding = await client.query(
          'select id from weddings where id=$1 and archived_at is null and cancelled_at is null for update', [candidate.wedding_id])
        if (!wedding.rowCount) return null
        // Account deletion locks the user before clearing assignments.
        await client.query(`select u.id from users u join tasks t on t.assignee_id=u.id
          where t.id=$1 order by u.id for share of u`, [candidate.id])
        await client.query('select id from tasks where id=$1 for update', [candidate.id])
        const { rows } = await client.query<ReminderRow>(
          `select t.id,t.title,t.assignee_id,t.notice_version::text,t.wedding_id,w.tz,
             (${SCHEDULED}) as scheduled_at, (t.due+1)::timestamp at time zone (${TZ}) as deadline_end
           from tasks t join weddings w on w.id=t.wedding_id join users u on u.id=t.assignee_id
           where t.id=$1 and ${LIVE} and t.reminder_days_before is not null
             and t.reminded_version is distinct from t.notice_version`, [candidate.id])
        const task = rows[0]
        if (!task || task.scheduled_at > now) return null
        const expiresAt = new Date(Math.min(task.scheduled_at.getTime()+86_400_000, task.deadline_end.getTime()))
        let outcome: keyof TaskReminderResult = 'expired'
        if (now < expiresAt) {
          const id = await notify(client, { userId: task.assignee_id, kind: 'task', title: 'Напоминание о задаче',
            body: task.title, link: `/wedding/checklist?task=${task.id}&wedding=${task.wedding_id}`, respectQuietHours: true,
            task: { id: task.id, version: task.notice_version, event: 'reminder', expiresAt },
          }, now, task.tz)
          const plan = id ? await client.query<{push_disposition:string}>('select push_disposition from notifications where id=$1',[id]) : null
          outcome = plan?.rows[0]?.push_disposition==='planned' ? 'queued' : 'suppressed'
        }
        await client.query('update tasks set reminded_version=notice_version where id=$1', [task.id])
        return outcome
      })
      if (outcome) result[outcome] += 1
    } catch (err) {
      failed += 1
      app.log.error({ err, taskId: candidate.id }, 'не удалось подготовить напоминание задачи')
    }
  }
  // Successful rows remain marked; the job retry only retries failed rows.
  if (failed) throw new Error(`task-reminders: ${failed} задач не обработаны`)
  return result
}
