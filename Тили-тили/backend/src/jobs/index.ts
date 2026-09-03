import { Queue, Worker, type Job } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { sendDuePushes } from '../notify/push.js'
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

async function runTick(app: FastifyInstance, name: string): Promise<unknown> {
  if (!app.db) return { skipped: 'нет базы' }
  if (name === 'push') return sendDuePushes(app.db, app.appConfig)
  if (name === 'cleanup') return cleanup(app)
  if (name === 'holds') return expireStaleHolds(app)
  return { skipped: name }
}

declare module 'fastify' {
  interface FastifyInstance {
    jobs: Queue | null
  }
}

/** Расписание раздела 5. Ключ повтора — имя: вторая такая же не заводится. */
const SCHEDULE: { name: string; every: number }[] = [
  // Созревшие push разъезжаются раз в минуту: откладывать дальше значит
  // превращать «сдвинули тайминг» в новость вчерашнего дня.
  { name: 'push', every: 60_000 },
  { name: 'cleanup', every: 60 * 60_000 },
  { name: 'holds', every: 60 * 60_000 },
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
      { every: item.every },
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
