import { Queue, Worker, type Job } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { sendDuePushes } from '../notify/push.js'
import { notify, notifyWedding } from '../notify/notify.js'
import { uuidv7 } from '../ids.js'

/**
 * Фоновые задачи — BullMQ на том же Redis (раздел 5 плана).
 *
 * Расписание живёт в очереди, а не в системном cron: очередь одна и деплой
 * один, а cron пришлось бы настраивать отдельно на каждой машине и он
 * запустил бы задачу на всех сразу.
 *
 * Каждая задача идемпотентна: повтор — no-op. Это не роскошь, а условие
 * работы очереди с повторами при падении.
 */
const QUEUE = 'tili'

export interface JobStats {
  push: { sent: number; dropped: number }
  cleaned: Record<string, number>
  holds: number
}

/** Уборка просроченного. Всё, что чистится, чистится по времени жизни. */
export async function cleanup(app: FastifyInstance): Promise<Record<string, number>> {
  const db = app.db!
  const out: Record<string, number> = {}
  const drop = async (name: string, sql: string) => {
    const res = await db.query(sql)
    out[name] = res.rowCount ?? 0
  }
  await drop('otp_codes', 'delete from otp_codes where expires_at < now()')
  await drop('idempotency_keys', "delete from idempotency_keys where created_at < now() - interval '1 day'")
  await drop(
    'sessions',
    "delete from sessions where revoked_at is not null and revoked_at < now() - interval '90 days'",
  )
  // Мягко удалённый аккаунт живёт 30 дней (План §19.1) — потом насовсем.
  await drop('users', "delete from users where deleted_at is not null and deleted_at < now() - interval '30 days'")
  /* Прочитанное уведомление старше 90 дней никому не нужно, а таблица
   * растёт от каждого сообщения в чате. Это ERR-0041 в другом месте:
   * журнал рассылок рос ровно так же. Непрочитанное не трогаем — человек
   * его ещё не видел. */
  await drop(
    'notifications',
    "delete from notifications where read_at is not null and read_at < now() - interval '90 days'",
  )
  return out
}

/**
 * Страховка на истечение брони.
 *
 * Основной путь — ленивый: `expireHolds` вызывается при чтении сделок
 * и бюджета. Но пара может не открывать приложение неделями, а дата у
 * подрядчика всё это время занята. Ежечасный проход снимает такие брони
 * независимо от того, зашёл ли кто-нибудь.
 */
export async function expireStaleHolds(app: FastifyInstance): Promise<number> {
  const { rows } = await app.db!.query<{ id: string }>(
    `update deals set state = 'candidate', negotiating_until = null
      where state = 'negotiating' and negotiating_until is not null and negotiating_until <= now()
      returning id`,
  )
  // Запись в журнал сделки — та же, что и на ленивом пути: история
  // не должна зависеть от того, кто первым заметил истечение.
  for (const row of rows) {
    await app.db!.query(
      `insert into deal_events (id, deal_id, from_state, to_state, note)
       values ($1, $2, 'negotiating', 'candidate', 'истёк срок мягкой брони')`,
      [uuidv7(), row.id],
    )
  }
  return rows.length
}

/**
 * Чат дня X открылся — об этом надо сказать.
 *
 * Ленивая проверка `opens_at <= now()` открывает чат, но никого не зовёт:
 * человек узнает об этом, только если сам зайдёт. Задача раздела 5 как раз
 * про «шлёт push участникам».
 *
 * Отметка `opened_notified_at` обязательна: без неё ежечасная задача звала
 * бы в чат каждый час до самой свадьбы.
 */
export async function announceOpenedDayChats(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{ id: string; wedding_id: string }>(
    `update chats set opened_notified_at = now()
      where kind = 'day' and opens_at is not null and opens_at <= now() and opened_notified_at is null
      returning id, wedding_id`,
  )
  for (const chat of rows) {
    await notifyWedding(db, chat.wedding_id, null, {
      kind: 'system',
      title: 'Чат дня X открыт',
      body: 'Гости и команда теперь на связи — можно писать',
      link: `/chats/${chat.id}`,
      // День X критичен: тихие часы его не держат.
      critical: true,
    })
  }
  return rows.length
}

/**
 * Напоминание за 12 часов до конца мягкой брони.
 *
 * Без него пара узнаёт об истечении постфактум — дата уже свободна, и её
 * успел занять кто-то другой. Раздел 5 называет это отдельной задачей.
 */
export async function remindExpiringHolds(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{ id: string; wedding_id: string }>(
    `update deals set hold_reminded_at = now()
      where state = 'negotiating' and hold_reminded_at is null
        and negotiating_until is not null
        and negotiating_until between now() and now() + interval '12 hours'
      returning id, wedding_id`,
  )
  for (const deal of rows) {
    await notifyWedding(db, deal.wedding_id, null, {
      kind: 'deal',
      title: 'Бронь скоро истечёт',
      body: 'Осталось меньше 12 часов — подтвердите или отпустите дату',
      link: '/deal',
      // Деньги и дата: ждать утра нельзя, к утру дату займут.
      critical: true,
    })
  }
  return rows.length
}

/**
 * Еженедельный дайджест дедлайнов.
 *
 * ОДНО уведомление с задачами недели, а не по одному на задачу (План §18.6):
 * десять писем про десять дел человек не читает, он их выключает.
 */
export async function weeklyDigest(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{ user_id: string; week: string; tasks: string }>(
    `select m.user_id,
            to_char(now(), 'IYYY-IW') as week,
            count(*)::text as tasks
       from tasks t
       join wedding_members m on m.wedding_id = t.wedding_id
       join weddings w on w.id = t.wedding_id
      where t.done_at is null and t.due is not null
        and t.due between current_date and current_date + 7
        and w.archived_at is null and w.cancelled_at is null
      group by m.user_id`,
  )
  let sent = 0
  for (const row of rows) {
    // Ключ по неделе делает повтор задачи пустым: вторая строка не встанет,
    // и второго дайджеста не будет, сколько раз задачу ни перезапусти.
    const claimed = await db.query(
      'insert into digest_sent (user_id, week) values ($1,$2) on conflict do nothing',
      [row.user_id, row.week],
    )
    if (claimed.rowCount === 0) continue
    await notify(db, {
      userId: row.user_id,
      kind: 'task',
      title: 'Задачи недели',
      body: `На этой неделе ${row.tasks} — загляните в чек-лист`,
      link: '/checklist',
    })
    sent += 1
  }
  return sent
}

async function runTick(app: FastifyInstance, name: string): Promise<unknown> {
  if (!app.db) return { skipped: 'нет базы' }
  if (name === 'push') return sendDuePushes(app.db, app.appConfig)
  if (name === 'cleanup') return cleanup(app)
  if (name === 'holds') return { expired: await expireStaleHolds(app), reminded: await remindExpiringHolds(app) }
  if (name === 'dayx-open') return announceOpenedDayChats(app)
  if (name === 'digest') return weeklyDigest(app)
  return { skipped: name }
}

declare module 'fastify' {
  interface FastifyInstance {
    jobs: Queue | null
  }
}

/** Расписание раздела 5. Ключ повтора — имя: вторая такая же не заводится. */
const SCHEDULE: { name: string; every?: number; pattern?: string }[] = [
  // Созревшие push разъезжаются раз в минуту: откладывать дальше значит
  // превращать «сдвинули тайминг» в новость вчерашнего дня.
  { name: 'push', every: 60_000 },
  { name: 'cleanup', every: 60 * 60_000 },
  // Истечение брони и напоминание за 12 часов — один проход.
  { name: 'holds', every: 60 * 60_000 },
  { name: 'dayx-open', every: 60 * 60_000 },
  // Понедельник, 10:00 — по времени сервера: у дайджеста нет получателя
  // в единственном числе, а значит и «его» таймзоны.
  { name: 'digest', pattern: '0 10 * * 1' },
]

export async function registerJobs(app: FastifyInstance): Promise<void> {
  const config = app.appConfig
  // В тестах очередь не нужна: она бы стучалась в Redis между прогонами
  // и оставляла повторяющиеся задачи в общей базе.
  if (!config.redisUrl || config.env === 'test') {
    app.decorate('jobs', null)
    return
  }

  const connection = { url: config.redisUrl }
  const queue = new Queue(QUEUE, { connection })
  app.decorate('jobs', queue)

  const worker = new Worker(
    QUEUE,
    async (job: Job) => runTick(app, job.name),
    {
      connection,
      // Падение — три повтора с растущей задержкой (раздел 5), потом
      // задача остаётся в очереди неудачных и видна в отчёте.
      settings: { backoffStrategy: (attempts: number) => [60_000, 300_000, 1_500_000][attempts - 1] ?? 1_500_000 },
    },
  )
  worker.on('failed', (job, err) => app.log.error({ err, job: job?.name }, 'фоновая задача упала'))

  /* Планировщик именованный: повторный вызов при рестарте обновляет
   * расписание, а не заводит вторую такую же задачу. Иначе после десяти
   * деплоев уборка шла бы десять раз в час. */
  for (const item of SCHEDULE) {
    await queue.upsertJobScheduler(
      `repeat:${item.name}`,
      item.pattern ? { pattern: item.pattern } : { every: item.every! },
      {
        name: item.name,
        opts: { attempts: 3, backoff: { type: 'custom' }, removeOnComplete: 100, removeOnFail: 100 },
      },
    )
  }

  app.addHook('onClose', async () => {
    await worker.close()
    await queue.close()
  })
}
