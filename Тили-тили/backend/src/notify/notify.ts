import type { Db, Queryable } from '../plugins/db.js'
import { uuidv7 } from '../ids.js'
import { deliverAfter, knownTimeZone, localDayBounds } from './quiet.js'

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
  /** Сегодня у этого человека свадьба. */
  wedding_today: boolean
}

/**
 * @param weddingTz  пояс свадьбы, о которой новость, — запасной, когда в
 *                   профиле пояс не задан. Клиент его не отправляет, и без
 *                   запасного вся страна жила по Москве: паре во Владивостоке
 *                   push молчали весь рабочий день и звонили в два ночи (D4-04).
 */
/**
 * Замок дневного лимита push — по человеку (класс R-271). Двухключевая форма,
 * как `OTP_PHONE_LOCK`: строки, которую можно запереть, ещё нет.
 */
const NOTIFY_LIMIT_LOCK = 4_210_005

/** Пул умеет `tx`, клиент внутри транзакции — нет. Отличаем по этому. */
const hasTx = (db: Queryable): db is Db => typeof (db as Partial<Db>).tx === 'function'

export async function notify(
  db: Queryable,
  item: NewNotification,
  now = new Date(),
  weddingTz: string | null = null,
): Promise<string | null> {
  const column = PREF_COLUMN[item.kind]
  const { rows } = await db.query<Prefs>(
    `select coalesce(${column ? `p.${column}` : 'true'}, true) as enabled,
            coalesce(p.quiet_from::text, '22:00') as quiet_from,
            coalesce(p.quiet_to::text, '09:00') as quiet_to,
            u.tz,
            /* День X: свадьба ровно сегодня по её собственной таймзоне.
             * Считается здесь, а не отдельной ночной задачей с флагом:
             * флаг пришлось бы ставить и снимать, а он ещё и переживал бы
             * перенос даты. Вопрос «сегодня ли» дешевле задать, чем хранить. */
            exists(
              select 1 from wedding_members m join weddings w on w.id = m.wedding_id
               where m.user_id = u.id and w.archived_at is null and w.cancelled_at is null
                 and w.date = (now() at time zone coalesce(w.tz, 'Europe/Moscow'))::date
            ) as wedding_today
       from users u left join notification_prefs p on p.user_id = u.id
      where u.id = $1 and u.deleted_at is null`,
    [item.userId],
  )
  const prefs = rows[0]
  // Пользователя нет или он выключил этот вид — новости не будет вовсе.
  // Молча писать строку, которую никто не увидит, незачем.
  if (!prefs || !prefs.enabled) return null

  // Пояс: профиль → свадьба, о которой новость → Москва. Таймзона может быть
  // не указана или испорчена: сервис работает в РФ, считаем по Москве.
  // Уронить уведомление из-за настройки профиля нельзя.
  const tz = knownTimeZone(prefs.tz || weddingTz)
  /* В день X тишины и лимита нет вовсе (План §18.6): свадьба идёт прямо
   * сейчас, и «разбудим утром» тут значит «уже неважно». */
  const unlimited = item.critical || prefs.wedding_today
  const startAt = deliverAfter(now, tz, { from: prefs.quiet_from, to: prefs.quiet_to }, unlimited)

  /*
   * Поиск места и вставка — В ОДНОЙ транзакции за замком по человеку
   * (F-RL3-04, класс ERR-0271 / R-271). Раньше это были «посчитал» и
   * «вставил» двумя отдельными запросами: две новости, пришедшие
   * одновременно, обе видели `planned < PUSH_LIMIT_PER_DAY` и обе
   * вставлялись — дневной лимит существовал только на бумаге, а человек
   * получал лишние звонки ровно в тот день, когда новостей и так много.
   *
   * Замок advisory: строки, которую можно было бы запереть, ещё нет —
   * запирается сам человек как ключ. При `unlimited` (день X, критичное)
   * лимита нет вовсе, считать нечего — замок не берём, чтобы не
   * сериализовать залп новостей в самый горячий день.
   */
  const place = async (client: Queryable): Promise<string> => {
    let after = startAt
    let placed = true
    if (!unlimited) {
      await client.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [NOTIFY_LIMIT_LOCK, item.userId])
      /* Лимит считается по УЖЕ ЗАПЛАНИРОВАННЫМ на эти сутки, а не по
       * отправленным: иначе три уведомления, отложенные до утра, утром
       * разбудят человека все три сразу и лимит окажется бумажным.
       *
       * Ищем ближайший день, где место есть, а не переносим на сутки один
       * раз: при десяти новостях единственный сдвиг сложил бы семь из них в
       * один следующий день, и лимит там был бы нарушен ровно так же.
       *
       * Сутки — МЕСТНЫЕ, как и тихие часы выше. Раньше границу резал
       * `date_trunc('day')` по таймзоне сессии базы, то есть по UTC, и на
       * Камчатке лимит разрешал шесть push за местный день вместо трёх. */
      placed = false
      for (let day = 0; day < PUSH_SPILL_DAYS; day++) {
        const bounds = localDayBounds(after, tz)
        const { rows: planned } = await client.query<{ n: string }>(
          `select count(*)::text as n from notifications
            where user_id = $1 and deliver_after >= $2 and deliver_after < $3`,
          [item.userId, bounds.from, bounds.to],
        )
        // Свыше лимита — не выбрасываем, а переносим: непрочитанное
        // в приложении всё равно видно сразу.
        if (Number(planned[0]!.n) < PUSH_LIMIT_PER_DAY) {
          placed = true
          break
        }
        after = new Date(after.getTime() + 86_400_000)
      }
    }

    /* Места нет на две недели вперёд — push не будет вовсе: строка помечается
     * доставленной сразу. Раньше она вставлялась с `deliver_after` на +14
     * суток, и через две недели человеку звонили о новости двухнедельной
     * давности — при живой переписке каждый день по три таких (D4-16).
     * В приложении уведомление видно сразу, как и все остальные. */
    if (!placed) after = now
    const id = uuidv7()
    await client.query(
      `insert into notifications (id, user_id, kind, title, body, link, deliver_after, pushed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, item.userId, item.kind, item.title, item.body, item.link ?? null, after, placed ? null : now],
    )
    return id
  }

  /*
   * Вызывают `notify()` и с пулом, и (в будущем) изнутри чужой транзакции.
   * С пулом открываем свою — иначе `pg_advisory_xact_lock` освободится сразу
   * же, в конце собственного запроса, и не защитит ничего. Изнутри чужой
   * транзакции клиент `.tx` не имеет: там замок берётся прямо на нём и живёт
   * до конца ТОЙ транзакции — то, что и нужно. Ни один вызывающий не меняется.
   */
  return hasTx(db) ? db.tx(place) : place(db)
}

/**
 * Всем участникам свадьбы, кроме автора события.
 *
 * `withVendors` добавляет подрядчиков с действующей сделкой. Матрица §18.6
 * ставит им галочку наравне с парой в трёх строках из шести — тайминг,
 * сделки, день X, — а участниками свадьбы они не числятся: у них своя
 * сторона, а не роль в команде.
 *
 * `roles` сужает круг до перечисленных ролей команды: события сделок по
 * §18.6 адресованы паре и подрядчику, и помощник с координатором, которым
 * деньги закрыты везде, не должны получать «Сумма изменена: … ₽» (D4-02).
 * Подрядчиков (`withVendors`) фильтр не касается — у них нет роли.
 */
export async function notifyWedding(
  db: Queryable,
  weddingId: string,
  exceptUserId: string | null,
  item: Omit<NewNotification, 'userId'>,
  now = new Date(),
  withVendors = false,
  roles: readonly string[] | null = null,
): Promise<number> {
  const { rows } = await db.query<{ user_id: string; tz: string | null }>(
    `select m.user_id, w.tz from wedding_members m join weddings w on w.id = m.wedding_id
      where m.wedding_id = $1 and ($3::text[] is null or m.role = any($3))
      union
     select v.user_id, w.tz from deals d join vendors v on v.id = d.vendor_id join weddings w on w.id = d.wedding_id
      where d.wedding_id = $1 and $2 and d.state in ('booked','paid_deposit','done')`,
    [weddingId, withVendors, roles],
  )
  let sent = 0
  for (const row of rows) {
    if (row.user_id === exceptUserId) continue
    if (await notify(db, { ...item, userId: row.user_id }, now, row.tz)) sent += 1
  }
  return sent
}
