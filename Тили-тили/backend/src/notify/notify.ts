import type { Queryable } from '../plugins/db.js'
import { uuidv7 } from '../ids.js'
import { deliverAfter, knownTimeZone } from './quiet.js'

/**
 * Одна дверь для всех уведомлений.
 *
 * Тихие часы и дневной лимит считаются здесь, а не в каждом месте, откуда
 * приходит новость: иначе первое же уведомление, добавленное на следующем
 * этапе, разбудит человека в три ночи — просто потому, что про правило
 * забыли.
 */
export type NotificationKind = 'deal' | 'chat' | 'task' | 'guest' | 'system'

export interface NewNotification {
  userId: string
  kind: NotificationKind
  title: string
  body: string
  link?: string | null
  /** Сделки и день X идут мимо тихих часов и мимо лимита. */
  critical?: boolean
}

/** Сколько НЕкритичных push в сутки вне дня X (План §18.6). */
export const PUSH_LIMIT_PER_DAY = 3

/**
 * На сколько суток вперёд можно раскладывать переполнение.
 *
 * Дальше двух недель push уже не новость, а археология: уведомление
 * остаётся в приложении, но звонить о нём поздно.
 */
export const PUSH_SPILL_DAYS = 14

/** Какая настройка выключает какой вид. `guest` и `system` не выключаются. */
const PREF_COLUMN: Partial<Record<NotificationKind, string>> = {
  deal: 'deals',
  chat: 'chats',
  task: 'tasks',
}

interface Prefs {
  enabled: boolean
  quiet_from: string
  quiet_to: string
  tz: string | null
}

export async function notify(db: Queryable, item: NewNotification, now = new Date()): Promise<string | null> {
  const column = PREF_COLUMN[item.kind]
  const { rows } = await db.query<Prefs>(
    `select coalesce(${column ? `p.${column}` : 'true'}, true) as enabled,
            coalesce(p.quiet_from::text, '22:00') as quiet_from,
            coalesce(p.quiet_to::text, '09:00') as quiet_to,
            u.tz
       from users u left join notification_prefs p on p.user_id = u.id
      where u.id = $1 and u.deleted_at is null`,
    [item.userId],
  )
  const prefs = rows[0]
  // Пользователя нет или он выключил этот вид — новости не будет вовсе.
  // Молча писать строку, которую никто не увидит, незачем.
  if (!prefs || !prefs.enabled) return null

  // Таймзона может быть не указана или испорчена: сервис работает в РФ,
  // считаем по Москве. Уронить уведомление из-за настройки профиля нельзя.
  const tz = knownTimeZone(prefs.tz)
  let after = deliverAfter(now, tz, { from: prefs.quiet_from, to: prefs.quiet_to }, item.critical)

  if (!item.critical) {
    /* Лимит считается по УЖЕ ЗАПЛАНИРОВАННЫМ на эти сутки, а не по
     * отправленным: иначе три уведомления, отложенные до утра, утром
     * разбудят человека все три сразу и лимит окажется бумажным.
     *
     * Ищем ближайший день, где место есть, а не переносим на сутки один раз:
     * при десяти новостях единственный сдвиг сложил бы семь из них в один
     * следующий день, и лимит там был бы нарушен ровно так же. */
    for (let day = 0; day < PUSH_SPILL_DAYS; day++) {
      const { rows: planned } = await db.query<{ n: string }>(
        `select count(*)::text as n from notifications
          where user_id = $1 and deliver_after >= date_trunc('day', $2::timestamptz)
            and deliver_after < date_trunc('day', $2::timestamptz) + interval '1 day'`,
        [item.userId, after],
      )
      // Свыше лимита — не выбрасываем, а переносим: непрочитанное
      // в приложении всё равно видно сразу.
      if (Number(planned[0]!.n) < PUSH_LIMIT_PER_DAY) break
      after = new Date(after.getTime() + 86_400_000)
    }
  }

  const id = uuidv7()
  await db.query(
    `insert into notifications (id, user_id, kind, title, body, link, deliver_after)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [id, item.userId, item.kind, item.title, item.body, item.link ?? null, after],
  )
  return id
}

/** Всем участникам свадьбы, кроме автора события. */
export async function notifyWedding(
  db: Queryable,
  weddingId: string,
  exceptUserId: string | null,
  item: Omit<NewNotification, 'userId'>,
  now = new Date(),
): Promise<number> {
  const { rows } = await db.query<{ user_id: string }>(
    'select user_id from wedding_members where wedding_id = $1',
    [weddingId],
  )
  let sent = 0
  for (const row of rows) {
    if (row.user_id === exceptUserId) continue
    if (await notify(db, { ...item, userId: row.user_id }, now)) sent += 1
  }
  return sent
}
