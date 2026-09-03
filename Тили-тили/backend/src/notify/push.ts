import webpush from 'web-push'
import type { Config } from '../config.js'
import type { Db } from '../plugins/db.js'

/**
 * Отправка накопленных push.
 *
 * Уведомление лежит в базе со сроком `deliver_after` — тихие часы и дневной
 * лимит уже посчитаны при создании (см. notify.ts). Здесь только доставка:
 * взять созревшие, разослать по подпискам, отметить отправленными.
 *
 * Подписка живёт, пока браузер её признаёт. На 404 и 410 её удаляем: это
 * не сбой сети, а «такого получателя больше нет», и держать её значило бы
 * стучаться в закрытую дверь каждую минуту вечно.
 */
export interface PushResult {
  sent: number
  dropped: number
}

interface Due {
  id: string
  user_id: string
  title: string
  body: string
  link: string | null
}

interface Subscription {
  id: string
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export function pushConfigured(config: Config): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey)
}

export async function sendDuePushes(db: Db, config: Config, limit = 200): Promise<PushResult> {
  if (!pushConfigured(config)) return { sent: 0, dropped: 0 }
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey!, config.vapidPrivateKey!)

  /* Помечаем отправленными СРАЗУ и в той же выборке.
   *
   * Иначе два одновременных прохода очереди возьмут одни и те же строки
   * и человек получит каждое уведомление дважды. `skip locked` пропускает
   * то, что уже взял соседний процесс, а не ждёт его. */
  const { rows: due } = await db.query<Due>(
    `update notifications set pushed_at = now()
      where id in (
        select id from notifications
         where pushed_at is null and deliver_after <= now()
         order by deliver_after
         limit $1
         for update skip locked
      )
      returning id, user_id, title, body, link`,
    [limit],
  )
  if (due.length === 0) return { sent: 0, dropped: 0 }

  const byUser = new Map<string, Due[]>()
  for (const row of due) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row])

  const { rows: subs } = await db.query<Subscription & { user_id: string }>(
    'select id, user_id, endpoint, keys from push_subscriptions where user_id = any($1)',
    [[...byUser.keys()]],
  )

  let sent = 0
  let dropped = 0
  for (const sub of subs) {
    for (const item of byUser.get(sub.user_id) ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title: item.title, body: item.body, data: { link: item.link } }),
        )
        sent += 1
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await db.query('delete from push_subscriptions where id = $1', [sub.id])
          dropped += 1
          break
        }
        // Прочие ошибки — временные: уведомление уже помечено отправленным,
        // но оно осталось в приложении, и повторять звонок незачем.
      }
    }
  }
  return { sent, dropped }
}
