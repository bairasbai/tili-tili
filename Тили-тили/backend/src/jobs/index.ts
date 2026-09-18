import { Queue, Worker, type Job } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { sendDuePushes } from '../notify/push.js'
import { notify, notifyWedding } from '../notify/notify.js'
import { recomputeAllRatings } from '../reviews/rating.js'
import { reportJobFailure } from '../plugins/sentry.js'
import { uuidv7 } from '../ids.js'
import { plural } from '../text/plural.js'
import { personCount } from '../routes/guests.js'

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
  /* Сессия без обновления дольше срока refresh (30 дней) мертва — гасим,
   * чтобы она не жила в списке устройств вечно (ревью 015); погашенные
   * старше 90 дней удаляются. */
  await drop(
    'sessions_expired',
    "update sessions set revoked_at = now() where revoked_at is null and last_used_at < now() - interval '30 days'",
  )
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
  /* Архив отменённых свадеб — отдельным изолированным шагом.
   *
   * Остальная уборка выше — это `delete` по времени жизни, безобидные сами по
   * себе. Здесь удаляется проект целиком, запросов несколько, и любой из них
   * может упасть на чужой блокировке. Без изоляции такое падение унесло бы с
   * собой и уборку кодов, и ключи идемпотентности: они идут одним списком.
   */
  out['weddings_purged'] = 0
  const pass = startPass('cleanup')
  await isolated(app, pass, {}, 'не удалось убрать отменённые свадьбы из архива', async () => {
    const purged = await purgeArchivedWeddings(app)
    out['weddings_purged'] = purged
    // Число за проход — в лог: без него удаление сотен проектов не оставляет
    // следа нигде, кроме самих строк, которых уже нет (FR-008).
    if (purged > 0) app.log.info({ purged }, 'уборка архива: отменённые свадьбы удалены')
  })
  reportPass(app, pass)
  return out
}

/**
 * Отменённая свадьба хранится ограниченный срок, потом удаляется насовсем.
 *
 * План §19.1 обещает 12 месяцев, а лежала она бессрочно
 * (`RELEASE-BLOCKERS.md` №10): персональные данные полутора сотен гостей —
 * телефоны, имена, диеты — оставались в базе навсегда после свадьбы, которой
 * не было. Срок — `WEDDING_ARCHIVE_DAYS`, не меньше 30 дней.
 *
 * Убираются ТОЛЬКО отменённые: `archived_at` сам по себе ничего не решает —
 * состоявшийся проект хранится бессрочно (План §18.5 п. 4).
 *
 * Партия — сотня за проход, как у `eraseDeletedUsers`: один `delete` на
 * тысячи свадеб держал бы блокировки на половине таблиц минутами.
 *
 * Транзакция — на КАЖДУЮ свадьбу, а не на партию, и тоже как у
 * `eraseDeletedUsers`. Общая транзакция означала «одна плохая свадьба —
 * и уборки нет вовсе»: сбой откатывал всю партию, `isolated()` глотал
 * ошибку, а первая по `archived_at` свадьба возвращалась в выборку
 * следующего прохода и блокировала архив навсегда.
 *
 * Занятость подрядчика снимается ЯВНО, до удаления: `vendor_busy_dates.deal_id`
 * стоит `ON DELETE SET NULL`, и каскад оставил бы дату занятой навсегда —
 * с обнулённой ссылкой её не нашёл бы уже никто, включая самого подрядчика.
 *
 * Отзывы — и пары, и гостя — уборку переживают: это история подрядчика, а
 * не свадьбы. `reviews.wedding_id`, `reviews.deal_id` и `reviews.guest_id`
 * (гость уходит каскадом вместе со свадьбой) стоят `ON DELETE SET NULL`, и
 * `CHECK reviews_key_matches_source` после миграции 1760500000000 (фича 014,
 * решение владельца) сделку у отзыва пары больше не требует. До неё отзыв
 * пары удалялся здесь заранее — иначе каскад упирался в проверку и падала
 * вся партия (ERR-0209); рейтинг подрядчика от уборки теперь не меняется,
 * пересчитывать нечего. То же при стирании аккаунта ниже.
 */
export async function purgeArchivedWeddings(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const days = app.appConfig.weddingArchiveDays
  const { rows } = await db.query<{ id: string; cancelled_at: Date; archived_at: Date }>(
    `select id, cancelled_at, archived_at from weddings
      where cancelled_at is not null and archived_at < now() - make_interval(days => $1)
      order by archived_at limit 100`,
    [days],
  )
  let purged = 0
  for (const row of rows) {
    try {
      /* Транзакция на свадьбу: между записью в журнал и удалением не должно
       * быть состояния «свадьбы нет, а следа не осталось» — и наоборот. */
      await db.tx(async (client) => {
        await client.query(
          `delete from vendor_busy_dates
            where source = 'deal' and deal_id in (select id from deals where wedding_id = $1)`,
          [row.id],
        )
        /* `actor_id` пустой: уборку делает платформа, а не человек, и записать
         * сюда чьё-то имя значило бы соврать в журнале. Колонка это допускает. */
        await client.query(
          `insert into audit_log (actor_id, action, entity, entity_id, diff)
           values (null, 'wedding.purged', 'wedding', $1, $2)`,
          [row.id, JSON.stringify({ cancelledAt: row.cancelled_at, archivedAt: row.archived_at })],
        )
        // Каскад по `weddings.id` уносит участников, гостей, сделки, слоты,
        // чаты, задачи — все двадцать три таблицы свадьбы.
        await client.query('delete from weddings where id = $1', [row.id])
      })
      purged += 1
    } catch (err) {
      // Сбой на одной свадьбе не останавливает остальные: ошибка в лог с
      // идентификатором — иначе искать её было бы негде.
      app.log.error({ err, weddingId: row.id }, 'не удалось убрать отменённую свадьбу из архива')
    }
  }
  return purged
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
 *   2. у свадеб, которые уходят с ним, заранее снимается занятость
 *      подрядчиков по сделкам — см. ниже;
 *   3. ссылки на него в приглашениях и запросе отмены обнуляются;
 *   4. его сделки как подрядчика остаются паре историей — с именем
 *      исполнителя и без ссылки на анкету (`deals_has_performer` держит);
 *   5. сам аккаунт удаляется — остальное уносит каскад.
 * Сбой на одном человеке не останавливает остальных: ошибка в лог, дальше.
 *
 * Шаг 2 — по той же причине, что в архиве: `vendor_busy_dates.deal_id`
 * стоит `SET NULL`, и дата осталась бы занятой призраком навсегда (R-221
 * требует пройти по всем удалениям родителя). Отзывы пары здесь тоже
 * удалялись — «SET NULL против CHECK», ERR-0209, D5-01/D6-04: каскад
 * `weddings → deals` обнулял `reviews.deal_id`, проверка откатывала
 * транзакцию, и аккаунт не стирался никогда. После миграции 1760500000000
 * (фича 014) проверка сделку у отзыва пары не требует, отзыв остаётся
 * подрядчику историей.
 */
export async function eraseDeletedUsers(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{ id: string }>(
    "select id from users where deleted_at is not null and deleted_at < now() - interval '30 days' order by deleted_at limit 100",
  )
  let erased = 0
  for (const { id } of rows) {
    try {
      await db.tx((client) => eraseUser(client, id))
      erased += 1
    } catch (err) {
      app.log.error({ err, userId: id }, 'не удалось стереть аккаунт')
    }
  }
  return erased
}

/**
 * Стирание одного аккаунта — шаги из `eraseDeletedUsers`, в транзакции
 * вызывающего. Вынесено, потому что дверей две: ежечасная уборка и вход по
 * телефону, чья строка старше окна восстановления (фича 014, A18): до прохода
 * уборки такой вход выдавал токены, с которыми каждый запрос отвечал 401
 * «Аккаунт удалён», — SMS потрачена, войти нельзя. Вход стирает строку сразу
 * тем же путём и заводит аккаунт заново.
 */
export async function eraseUser(client: Queryable, id: string): Promise<void> {
  /* Наследник — живой партнёр, а если такого нет — партнёр, мягко удалённый
   * в своём 30-дневном окне: он ещё может вернуться входом (`auth.ts`), и
   * свадьба должна дождаться его, а не уйти каскадом вместе с первым
   * стёртым (ревью 015). Не вернётся — уборка дойдёт и до него, и тогда
   * свадьба уйдёт с ним, как положено. */
  await client.query(
    `update weddings w set owner_id = heir.user_id
       from (select distinct on (m.wedding_id) m.wedding_id, m.user_id
               from wedding_members m join users u on u.id = m.user_id
              where m.role = 'couple' and m.user_id <> $1
                and (u.deleted_at is null or u.deleted_at > now() - interval '30 days')
              order by m.wedding_id, (u.deleted_at is not null), m.joined_at) heir
      where w.owner_id = $1 and heir.wedding_id = w.id`,
    [id],
  )
  /* Свадьбы, у которых наследника не нашлось, уйдут каскадом вместе
   * с аккаунтом — до этого у них снимается занятость по сделкам. */
  await client.query(
    `delete from vendor_busy_dates
      where source = 'deal'
        and deal_id in (select d.id from deals d join weddings w on w.id = d.wedding_id where w.owner_id = $1)`,
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
  const pass = startPass('dayx-open')
  for (const chat of rows) {
    await isolated(app, pass, { chatId: chat.id }, 'не удалось объявить открытие чата дня X', () =>
      notifyWedding(db, chat.wedding_id, null, {
        kind: 'system',
        title: 'Чат дня X открыт',
        body: 'Команда теперь на связи — можно писать; гости пишут в него по своей ссылке',
        link: `/chats/${chat.id}`,
        // День X критичен: тихие часы его не держат.
        critical: true,
      }),
    )
  }
  reportPass(app, pass)
  return rows.length
}

/**
 * Одна строка списка — одна попытка.
 *
 * Все задачи ниже устроены одинаково: сначала пометить строки как
 * обработанные (`returning`), потом пройти по ним и разослать. Без изоляции
 * первый же сбой — стёртый между выборкой и записью пользователь, упавшая
 * вставка уведомления — выбрасывал исключение из цикла, а помеченные строки
 * после него не получали ничего и уже никогда: повтор задачи их не видит.
 * Найдено аудитом 2026-09-07: `weeklyDigest` падал на внешнем ключе
 * `digest_sent`, когда `eraseDeletedUsers` стирал аккаунт параллельно.
 * Сбой уходит в лог со своим ключом, остальные строки идут дальше.
 *
 * Сбои при этом СЧИТАЮТСЯ по проходу (`Pass`), и итог уходит в Sentry:
 * помеченные строки повтор задачи уже не увидит (R-199), и систематический
 * сбой — `notify()` падает у всех — раньше не доходил никуда: задача была
 * «успешна», события сделок за проход помечены и потеряны, а обнаружилось бы
 * это через сутки по тому, что перестали приходить push (D4-12).
 */
interface Pass {
  job: string
  total: number
  failed: number
}

const startPass = (job: string): Pass => ({ job, total: 0, failed: 0 })

async function isolated(
  app: FastifyInstance,
  pass: Pass,
  context: Record<string, string>,
  message: string,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  pass.total += 1
  try {
    await fn()
    return true
  } catch (err) {
    pass.failed += 1
    app.log.error({ err, ...context }, message)
    return false
  }
}

/** Итог прохода: были сбои — инцидент с числом, как у падения задачи целиком. */
function reportPass(app: FastifyInstance, pass: Pass): void {
  if (pass.failed === 0) return
  const summary = `${pass.job}: ${pass.failed} из ${pass.total} строк не обработаны — см. лог задачи`
  app.log.error({ job: pass.job, failed: pass.failed, total: pass.total }, 'фоновая задача прошла со сбоями')
  reportJobFailure(pass.job, new Error(summary))
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
  const pass = startPass('holds')
  for (const deal of rows) {
    await isolated(app, pass, { dealId: deal.id }, 'не удалось напомнить об истечении брони', () =>
      notifyWedding(
        db,
        deal.wedding_id,
        null,
        {
          kind: 'deal',
          title: 'Бронь скоро истечёт',
          body: 'Осталось меньше 12 часов — подтвердите или отпустите дату',
          /* Со сделкой, а не «куда-то в сделки»: экран открывается по её
             идентификатору, и без него нажатие уводило бы в общий список. */
          link: `/deal/${deal.id}`,
          // Деньги и дата: ждать утра нельзя, к утру дату займут.
          critical: true,
        },
        new Date(),
        false,
        // Сделки по §18.6 — новость пары; помощнику и координатору они не адресованы.
        DEAL_AUDIENCE,
      ),
    )
  }
  reportPass(app, pass)
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
  /* Уже получившие дайджест этой недели и удалённые аккаунты отсекаются в
   * выборке: иначе каждый повтор задачи перебирал бы всех подряд и ставил
   * `on conflict do nothing` на каждого — на тысячах строк это минуты. */
  const { rows } = await db.query<{ user_id: string; week: string; tasks: string }>(
    `select m.user_id,
            to_char(now(), 'IYYY-IW') as week,
            count(*)::text as tasks
       from tasks t
       join wedding_members m on m.wedding_id = t.wedding_id
       join weddings w on w.id = t.wedding_id
       join users u on u.id = m.user_id and u.deleted_at is null
      where t.done_at is null and t.due is not null
        and t.due between current_date and current_date + 7
        and w.archived_at is null and w.cancelled_at is null
        and not exists (select 1 from digest_sent d
                         where d.user_id = m.user_id and d.week = to_char(now(), 'IYYY-IW'))
      group by m.user_id`,
  )
  let sent = 0
  const pass = startPass('digest')
  for (const row of rows) {
    const ok = await isolated(app, pass, { userId: row.user_id }, 'не удалось отправить дайджест недели', async () => {
      // Ключ по неделе делает повтор задачи пустым: вторая строка не встанет,
      // и второго дайджеста не будет, сколько раз задачу ни перезапусти.
      const claimed = await db.query(
        'insert into digest_sent (user_id, week) values ($1,$2) on conflict do nothing',
        [row.user_id, row.week],
      )
      if (claimed.rowCount === 0) return false
      await notify(db, {
        userId: row.user_id,
        kind: 'task',
        title: 'Задачи недели',
        body: `На этой неделе ${Number(row.tasks)} ${plural(Number(row.tasks), 'задача', 'задачи', 'задач')} — загляните в чек-лист`,
        link: '/checklist',
      })
      return true
    })
    if (ok) sent += 1
  }
  reportPass(app, pass)
  return sent
}

/**
 * Кому из команды идут события сделок: только паре. §18.6 адресует сделки
 * паре и подрядчику; помощник и координатор не видят денег нигде (§6), а
 * журнал сделки несёт суммы — «Сумма изменена: 50 000 ₽ → 80 000 ₽» — и
 * свободный текст пары. Подрядчик сделки получает своё отдельно.
 */
const DEAL_AUDIENCE = ['couple'] as const

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
  /* Событие старше двух суток помечается БЕЗ рассылки: push о позавчерашней
   * смене статуса — не новость, а шум. Раньше такие строки не помечались
   * вовсе: простой воркера дольше двух суток (или стенд без Redis) оставлял
   * их в частичном индексе `notified_at is null` навсегда (D4-25). Число —
   * в лог: потерянные уведомления должны быть видны хоть где-то. */
  const stale = await db.query(
    "update deal_events set notified_at = now() where notified_at is null and at <= now() - interval '2 days'",
  )
  if (stale.rowCount) app.log.warn({ stale: stale.rowCount }, 'события сделок старше двух суток помечены без рассылки')

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
  const pass = startPass('deal-events')
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
    await isolated(app, pass, { dealId: event.deal_id }, 'не удалось разослать событие сделки', async () => {
      /* Тому, кто сам нажал кнопку, сообщать нечего. Из команды — только паре:
       * `note` несёт суммы («Сумма изменена: 50 000 ₽ → 80 000 ₽») и свободный
       * текст, а помощнику и координатору деньги закрыты везде (D4-02/D1-05). */
      await notifyWedding(db, event.wedding_id!, event.actor_id, item, new Date(), false, DEAL_AUDIENCE)
      /* Подрядчик ЭТОЙ сделки, а не «все забронированные на свадьбе».
       * Снятая мягкая бронь — новость того, чью дату держали, и состояние
       * сделки к этому моменту уже не `booked`: фильтр по забронированным
       * отсёк бы ровно тот случай, ради которого уведомление и нужно. */
      if (event.vendor_user_id && event.vendor_user_id !== event.actor_id) {
        await notify(db, { ...item, userId: event.vendor_user_id })
      }
    })
  }
  reportPass(app, pass)
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
  const pass = startPass('rsvp-digest')
  for (const row of rows) {
    await isolated(app, pass, { weddingId: row.wedding_id }, 'не удалось отправить сводку ответов гостей', () =>
      notifyWedding(db, row.wedding_id, null, {
        kind: 'guest',
        title: 'Ответы гостей за сутки',
        body: `Придут: ${row.yes}. Не смогут: ${row.no}.`,
        link: '/guests',
      }),
    )
  }
  reportPass(app, pass)
  return rows.length
}

/**
 * Ключ задачи раздела 5 (`after:{weddingId}:{step}`, `catering:{weddingId}:{date}`).
 * Первый, кто вставил ключ, и рассылает; повтор задачи получает `false` и
 * молчит — тот же приём, что `digest_sent`, только одна таблица на все ключи.
 */
async function claimJobKey(db: Queryable, key: string): Promise<boolean> {
  const res = await db.query('insert into job_marks (key) values ($1) on conflict do nothing', [key])
  return (res.rowCount ?? 0) > 0
}

/**
 * «После свадьбы» (раздел 5, План §18.5): отзывы на +1…+7, альбом на +3…+7
 * (только когда гости что-то прислали — напоминать о пустом альбоме нечем),
 * итоги на +14…+21, годовщина — в тот же день каждый год.
 *
 * Окна, а не точные дни: воркер мог стоять сутки (стенд без Redis, деплой),
 * и «ровно +1» пропал бы навсегда. Ключ шага держит один раз на свадьбу.
 * Получатель — пара: отзывы и итоги пишет она (§6, деньги и оценки — не
 * помощнику).
 */
export async function afterWedding(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{
    id: string
    days: number
    years: number
    same_day: boolean
    deals: string
    photos: string
  }>(
    `select w.id,
            (current_date - w.date)::int as days,
            extract(year from age(current_date, w.date))::int as years,
            (to_char(current_date, 'MM-DD') = to_char(w.date, 'MM-DD')) as same_day,
            (select count(*)::text from deals d where d.wedding_id = w.id and d.state in ('booked','paid_deposit','done')) as deals,
            (select count(*)::text from album_photos p where p.wedding_id = w.id) as photos
       from weddings w
      where w.date is not null and w.date < current_date
        and w.archived_at is null and w.cancelled_at is null`,
  )
  const pass = startPass('after')
  let sent = 0
  for (const w of rows) {
    const steps: { step: string; item: Parameters<typeof notifyWedding>[3] }[] = []
    if (w.days >= 1 && w.days <= 7 && Number(w.deals) > 0) {
      steps.push({
        step: 'reviews',
        item: {
          kind: 'system',
          title: 'Свадьба прошла — оцените команду',
          body: 'Закройте сделки и оставьте отзывы подрядчикам: их увидят следующие пары',
          link: '/after',
        },
      })
    }
    if (w.days >= 3 && w.days <= 7 && Number(w.photos) > 0) {
      const n = Number(w.photos)
      steps.push({
        step: 'album',
        item: {
          kind: 'guest',
          title: 'Гости прислали кадры',
          body: `В альбоме ${n} ${plural(n, 'кадр', 'кадра', 'кадров')} — одобрите, что показывать всем`,
          link: '/album',
        },
      })
    }
    if (w.days >= 14 && w.days <= 21) {
      steps.push({
        step: 'results',
        item: {
          kind: 'system',
          title: 'Итоги свадьбы',
          body: 'Что получилось, сколько потрачено и кого стоит порекомендовать — всё собрано на одном экране',
          link: '/after',
        },
      })
    }
    if (w.same_day && w.years >= 1) {
      steps.push({
        step: `anniversary:${w.years}`,
        item: {
          kind: 'system',
          title: `С годовщиной — ${w.years} ${plural(w.years, 'год', 'года', 'лет')}!`,
          body: 'Ваша свадьба и её альбом по-прежнему здесь',
          link: '/home',
        },
      })
    }
    for (const s of steps) {
      const ok = await isolated(app, pass, { weddingId: w.id, step: s.step }, 'не удалось отправить шаг «после свадьбы»', async () => {
        if (!(await claimJobKey(db, `after:${w.id}:${s.step}`))) return false
        await notifyWedding(db, w.id, null, s.item, new Date(), false, ['couple'])
        return true
      })
      if (ok) sent += 1
    }
  }
  reportPass(app, pass)
  return sent
}

/**
 * Сводка кейтерингу (раздел 5): за 14 и за 7 дней до даты — порции, блюда
 * по опросу, диеты и трансфер. План обещал вебхук или письмо кейтерингу;
 * ни отправителя писем (№13), ни адресов кейтерингов у нас нет — сводка
 * уходит паре и координатору уведомлением со ссылкой на экран меню, откуда
 * её и передают. Второй срез (−7) — «новая версия сводки» из плана: ответы
 * гостей к тому времени меняются.
 */
export async function cateringSummary(app: FastifyInstance): Promise<number> {
  const db = app.db!
  const { rows } = await db.query<{ id: string; date: string; days: number }>(
    `select w.id, to_char(w.date, 'YYYY-MM-DD') as date, (w.date - current_date)::int as days
       from weddings w
      where w.date in (current_date + 14, current_date + 7)
        and w.archived_at is null and w.cancelled_at is null`,
  )
  const pass = startPass('catering')
  let sent = 0
  for (const w of rows) {
    const ok = await isolated(app, pass, { weddingId: w.id }, 'не удалось отправить сводку кейтерингу', async () => {
      if (!(await claimJobKey(db, `catering:${w.id}:${w.date}:${w.days}`))) return false
      const { rows: guests } = await db.query<{
        status: string
        plus_one: boolean
        diet: string | null
        transfer: string | null
      }>('select rsvp as status, plus_one, diet, transfer from guests where wedding_id = $1', [w.id])
      const portions = personCount(guests.map((g) => ({ status: g.status, plusOne: g.plus_one })))
      const { rows: options } = await db.query<{ name: string; votes: string }>(
        `select o.name, (select count(*)::text from menu_votes v where v.option_id = o.id) as votes
           from menu_options o where o.wedding_id = $1 order by o.sort, o.name`,
        [w.id],
      )
      const coming = guests.filter((g) => g.status === 'yes')
      const diets = coming.filter((g) => g.diet).length
      const transfer = coming.filter((g) => g.transfer === 'need').length
      const dishes = options
        .filter((o) => Number(o.votes) > 0)
        .map((o) => `${o.name} — ${o.votes}`)
        .join(', ')
      const parts = [
        `Порций: ${portions}`,
        dishes ? `по опросу: ${dishes}` : 'опрос меню без ответов',
        `особое питание: ${diets}`,
        `трансфер нужен: ${transfer}`,
      ]
      await notifyWedding(
        db,
        w.id,
        null,
        {
          kind: 'system',
          title: w.days === 14 ? 'Сводка для кейтеринга' : 'Сводка для кейтеринга — свежая версия',
          body: `${parts.join(' · ')}. Передайте кейтерингу с экрана меню`,
          link: '/catering',
        },
        new Date(),
        false,
        ['couple', 'coordinator'],
      )
      return true
    })
    if (ok) sent += 1
  }
  reportPass(app, pass)
  return sent
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
  if (name === 'after') return afterWedding(app)
  if (name === 'catering') return cateringSummary(app)
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
  // «После свадьбы» — 00:05, как записано в разделе 5; окна шагов прощают простой воркера.
  { name: 'after', pattern: '5 0 * * *' },
  // Сводка кейтерингу — 09:00: паре читать её утром, а не ночью.
  { name: 'catering', pattern: '0 9 * * *' },
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
