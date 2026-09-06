import { Queue, Worker, type Job } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { sendDuePushes } from '../notify/push.js'
import { notify, notifyWedding } from '../notify/notify.js'
import { recomputeAllRatings } from '../reviews/rating.js'
import { reportJobFailure } from '../plugins/sentry.js'
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
  out['users'] = await eraseDeletedUsers(app)
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
 * Стирание аккаунта через 30 дней после мягкого удаления (152-ФЗ, План §19.1).
 *
 * Голый `delete from users` здесь стоял с этапа 1 и не прошёл бы ни у кого,
 * кто хоть раз выдавал приглашение: три внешних ключа без каскада —
 * `invites.created_by`/`accepted_by`, `weddings.cancel_requested_by`,
 * `deals.vendor_id` — роняли запрос, а с ним и всю остальную уборку (она
 * идёт одним списком). Хуже второе: `weddings.owner_id` каскадный, и
 * стирание одного партнёра сносило бы свадьбу целиком у второго — гостей,
 * сделки, переписку. Найдено аудитом 2026-09-06 по графу внешних ключей.
 *
 * Поэтому по шагам, в транзакции на человека:
 *   1. свадьбы, где он владелец, переходят живому партнёру с ролью «пара»
 *      (нет партнёра — свадьба уходит вместе с ним, это его данные);
 *   2. ссылки на него в приглашениях и запросе отмены обнуляются;
 *   3. его сделки как подрядчика остаются паре историей — с именем
 *      исполнителя и без ссылки на анкету (`deals_has_performer` держит);
 *   4. сам аккаунт удаляется — остальное уносит каскад.
 * Сбой на одном человеке не останавливает остальных: ошибка в лог, дальше.
 */
export async function eraseDeletedUsers(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{ id: string }>(
    "select id from users where deleted_at is not null and deleted_at < now() - interval '30 days' order by deleted_at limit 100",
  )
  let erased = 0
  for (const { id } of rows) {
    try {
      await db.tx(async (client) => {
        await client.query(
          `update weddings w set owner_id = heir.user_id
             from (select distinct on (m.wedding_id) m.wedding_id, m.user_id
                     from wedding_members m join users u on u.id = m.user_id
                    where m.role = 'couple' and m.user_id <> $1 and u.deleted_at is null
                    order by m.wedding_id, m.joined_at) heir
            where w.owner_id = $1 and heir.wedding_id = w.id`,
          [id],
        )
        await client.query('update invites set created_by = null where created_by = $1', [id])
        await client.query('update invites set accepted_by = null where accepted_by = $1', [id])
        await client.query(
          'update weddings set cancel_requested_by = null, cancel_requested_at = null where cancel_requested_by = $1',
          [id],
        )
        await client.query(
          `update deals d set vendor_id = null, external_name = coalesce(d.external_name, v.name)
             from vendors v where v.id = d.vendor_id and v.user_id = $1`,
          [id],
        )
        await client.query('delete from users where id = $1', [id])
      })
      erased += 1
    } catch (err) {
      app.log.error({ err, userId: id }, 'не удалось стереть аккаунт')
    }
  }
  return erased
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
  /* Снятие брони и запись в журнал — одна транзакция: без записи
   * `announceDealEvents` о снятой броне не узнает, а повтор задачи уже
   * не найдёт сделку в `negotiating` (R-122). */
  return app.db!.tx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `update deals set state = 'candidate', negotiating_until = null
        where state = 'negotiating' and negotiating_until is not null and negotiating_until <= now()
        returning id`,
    )
    /* Запись в журнал сделки — та же, что и на ленивом пути: история
     * не должна зависеть от того, кто первым заметил истечение. Уведомление
     * отсюда не шлём: его разошлёт `announceDealEvents` по этой же записи —
     * иначе о снятой броне сообщали бы дважды, а о снятой в обработчике
     * не сообщали бы вовсе. */
    for (const row of rows) {
      await client.query(
        `insert into deal_events (id, deal_id, from_state, to_state, note)
         values ($1, $2, 'negotiating', 'candidate', 'истёк срок мягкой брони')`,
        [uuidv7(), row.id],
      )
    }
    return rows.length
  })
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
      /* Со сделкой, а не «куда-то в сделки»: экран открывается по её
         идентификатору, и без него нажатие уводило бы в общий список. */
      link: `/deal/${deal.id}`,
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

/** Человеческое название состояния сделки — в тексте уведомления. */
const STATE_TITLE: Record<string, string> = {
  candidate: 'Сделка вернулась в кандидаты',
  contacted: 'Подрядчику написали',
  negotiating: 'Дата под мягкой бронью',
  booked: 'Дата забронирована',
  paid_deposit: 'Аванс получен',
  done: 'Сделка закрыта',
  cancelled: 'Сделка отменена',
}

/**
 * Уведомления о сменах статуса сделки — по журналу, а не по коду перехода.
 *
 * Состояние меняется в четырёх местах: правка сделки, бронь слота, свой
 * подрядчик, истечение брони фоновой задачей. Вызов рассылки в каждом —
 * это четыре места, где о ней можно забыть, и одно из них уже забыли:
 * истечение брони не сообщало никому, хотя раздел 5 требует «push паре
 * и подрядчику».
 *
 * Каждый переход и так пишется в `deal_events`. Рассылаем по журналу:
 * один путь на все четыре, отметка `notified_at` делает повтор пустым.
 */
export async function announceDealEvents(app: FastifyInstance, limit = 200): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{
    deal_id: string
    wedding_id: string
    vendor_user_id: string | null
    to_state: string
    kind: string
    actor_id: string | null
    note: string | null
  }>(
    `update deal_events e set notified_at = now()
      where e.id in (
        select id from deal_events
         where notified_at is null and at > now() - interval '2 days'
         order by at limit $1
      )
      returning e.deal_id,
                (select d.wedding_id from deals d where d.id = e.deal_id) as wedding_id,
                (select v.user_id from deals d join vendors v on v.id = d.vendor_id
                  where d.id = e.deal_id) as vendor_user_id,
                e.to_state, e.kind, e.actor_id, e.note`,
    [limit],
  )
  for (const event of rows) {
    if (!event.wedding_id) continue
    const item = {
      kind: 'deal' as const,
      /* Смена цены не меняет состояние, и заголовок по состоянию объявил
       * бы «сделка забронирована» на правку сметы. Вид записи в журнале
       * различает эти два события. */
      title: event.kind === 'price' ? 'Изменилась сумма сделки' : (STATE_TITLE[event.to_state] ?? 'Статус сделки изменился'),
      body: event.note ?? 'Загляните в карточку сделки',
      // Та самая сделка, а не список: экран открывается по идентификатору.
      link: `/deal/${event.deal_id}`,
      // Деньги и дата: §18.6 относит сделки к неотключаемым.
      critical: true,
    }
    // Тому, кто сам нажал кнопку, сообщать нечего.
    await notifyWedding(db, event.wedding_id, event.actor_id, item)
    /* Подрядчик ЭТОЙ сделки, а не «все забронированные на свадьбе».
     * Снятая мягкая бронь — новость того, чью дату держали, и состояние
     * сделки к этому моменту уже не `booked`: фильтр по забронированным
     * отсёк бы ровно тот случай, ради которого уведомление и нужно. */
    if (event.vendor_user_id && event.vendor_user_id !== event.actor_id) {
      await notify(db, { ...item, userId: event.vendor_user_id })
    }
  }
  return rows.length
}

/**
 * Сводка по ответам гостей — раз в день, а не письмо на каждое «приду».
 *
 * §18.6 так и записано: «RSVP гостя → паре сводка 1/день». На свадьбе
 * полторы сотни гостей, и уведомление на каждый ответ — это способ
 * заставить пару выключить уведомления совсем.
 */
export async function rsvpDigest(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{ wedding_id: string; yes: string; no: string }>(
    `select w.id as wedding_id,
            count(*) filter (where g.rsvp = 'yes')::text as yes,
            count(*) filter (where g.rsvp = 'no')::text as no
       from guests g join weddings w on w.id = g.wedding_id
      where g.rsvp_at is not null and g.rsvp_at > now() - interval '1 day'
        and w.archived_at is null and w.cancelled_at is null
      group by w.id`,
  )
  for (const row of rows) {
    await notifyWedding(db, row.wedding_id, null, {
      kind: 'guest',
      title: 'Ответы гостей за сутки',
      body: `Придут: ${row.yes}. Не смогут: ${row.no}.`,
      link: '/guests',
    })
  }
  return rows.length
}

async function runTick(app: FastifyInstance, name: string): Promise<unknown> {
  if (!app.db) return { skipped: 'нет базы' }
  if (name === 'push') return sendDuePushes(app.db, app.appConfig)
  if (name === 'cleanup') return cleanup(app)
  if (name === 'holds') return { expired: await expireStaleHolds(app), reminded: await remindExpiringHolds(app) }
  if (name === 'dayx-open') return announceOpenedDayChats(app)
  if (name === 'digest') return weeklyDigest(app)
  if (name === 'deal-events') return announceDealEvents(app)
  if (name === 'rsvp-digest') return rsvpDigest(app)
  if (name === 'ratings') return recomputeAllRatings(app.db)
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
  // Смена статуса сделки — новость срочная: дата уплывает.
  { name: 'deal-events', every: 60_000 },
  // Ответы гостей — сводкой раз в день, в 10 утра.
  { name: 'rsvp-digest', pattern: '0 10 * * *' },
  /* Затухание рейтинга идёт по времени, а не по событиям: без ночного
   * пересчёта у подрядчика без новых отзывов число застывает навсегда. */
  { name: 'ratings', pattern: '30 3 * * *' },
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
  worker.on('failed', (job, err) => {
    // Задачу никто не видит: без отчёта её падение обнаружится по тому,
    // что перестали приходить push — то есть через сутки.
    app.log.error({ err, job: job?.name }, 'фоновая задача упала')
    reportJobFailure(job?.name ?? 'неизвестная', err)
  })

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
