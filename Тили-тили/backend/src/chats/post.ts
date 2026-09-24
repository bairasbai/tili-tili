import type { FastifyInstance } from 'fastify'
import type { Db, Queryable } from '../plugins/db.js'
import { AppError, conflict, quotaExceeded } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { notify } from '../notify/notify.js'
import { assertOpen, chatForUser, rolesSeeing, type ChatKind } from './access.js'
import { hasLink, looksLikePayoutBypass, PAYOUT_WARNING } from './guard.js'

/*
 * Реплика человека в чат — одна дверь на все входы (ревью 015).
 *
 * До этого текст подрядчика из кабинета заявок (`POST /vendor/leads/{id}`)
 * ложился в `messages` прямой вставкой, минуя всё, что держит
 * `POST /chats/{id}/messages`: заблокированный модератором подрядчик
 * продолжал писать парам, непроверенный — начинал шестую и седьмую холодную
 * переписку, ссылка в первом сообщении не уходила на модерацию, сторож
 * §18.2 молчал. Правила одни — значит и функция одна; обработчики только
 * разбирают запрос и отдают ответ.
 */

export interface SentMessage {
  id: string
  chatId: string
  senderId: string
  text: string
  attachmentUrl: string | null
  sentAt: string
  system: false
  guestName: null
  /** В живой канал уходит всем — своя ли реплика, каждый экран решает по `senderId`; автору в ответе — `true`. */
  mine: boolean | null
}

export interface SendInput {
  chatId: string
  userId: string
  text: string
  attachmentUrl?: string
}

/** Пояс свадьбы для тихих часов получателей без своего пояса. */
async function weddingTz(db: Queryable, weddingId: string): Promise<string | null> {
  const { rows } = await db.query<{ tz: string | null }>('select tz from weddings where id = $1', [weddingId])
  return rows[0]?.tz ?? null
}

/**
 * Уведомление всем, кто в этом чате состоит, кроме автора.
 *
 * Общее для реплики участника и реплики гостя в чате дня X (фича 009,
 * `routes/day.ts`): у гостя аккаунта нет, `authorId` пуст — получают все,
 * кто чат видит. Свой список получателей для гостя разошёлся бы с этим при
 * первой же правке матрицы — как уже расходился (ERR-0099, ERR-0106).
 */
export async function notifyOthers(
  db: Queryable,
  chatId: string,
  weddingId: string,
  kind: ChatKind,
  authorId: string | null,
  text: string,
): Promise<void> {
  if (kind === 'tilly') return
  /* Получатели — те же, кто видит чат, и берутся они из ТОЙ ЖЕ матрицы,
   * что и доступ (`rolesSeeing`). Здесь стоял свой список, и он учитывал
   * ровно один случай — `crew` только координатору. Всё остальное уходило
   * всем участникам свадьбы: помощник получал в теле уведомления первые
   * 120 символов переписки с подрядчиком, хотя по матрице ему видны только
   * `team` и `day`, а по ссылке его ждал 403 (ERR-0099). */
  const { rows } = await db.query<{ user_id: string }>(
    `select mem.user_id from wedding_members mem
       where mem.wedding_id = $1 and mem.role = any($4)
      union
     select v.user_id from chats c join vendors v on v.id = c.vendor_id where c.id = $2
      union
     select mine.user_id from deals d join vendors mine on mine.id = d.vendor_id
      where d.wedding_id = $1 and $3 in ('team','crew')
        and d.state in ('booked','paid_deposit','done')`,
    [weddingId, chatId, kind, rolesSeeing(kind)],
  )
  /* Тихие часы — по поясу свадьбы, если человек свой не назвал: самый
   * частый push — «Новое сообщение» — шёл без него и считался по Москве
   * (ревью фиксов, RF-BE-04). */
  const tz = await weddingTz(db, weddingId)
  for (const row of rows) {
    if (row.user_id === authorId) continue
    await notify(db, {
      userId: row.user_id,
      kind: 'chat',
      title: 'Новое сообщение',
      body: text.length > 120 ? `${text.slice(0, 119)}…` : text,
      link: `/chats/${chatId}`,
    }, new Date(), tz)
  }
}

/**
 * В закрытый чат своего подрядчика не пишут: его сделка отменена, ссылка
 * погашена, и по ту сторону никого нет. Переписка остаётся паре для
 * чтения (потому чат не удаляется вместе с подрядчиком), но сообщение
 * в неё легло бы в никуда — 409, а не 201 с молчанием в ответ.
 */
async function assertNotClosed(db: Db, chat: { kind: ChatKind; deal_id: string | null }): Promise<void> {
  if (chat.kind !== 'external' || !chat.deal_id) return
  const { rows } = await db.query<{ cancelled: boolean }>(`select (state = 'cancelled') as cancelled from deals where id = $1`, [
    chat.deal_id,
  ])
  if (rows[0]?.cancelled) {
    throw conflict('chat_closed', 'Своего подрядчика в слоте больше нет — писать некому, переписка остаётся для чтения')
  }
}

/**
 * Первое сообщение в переписке решает две вещи сразу.
 *
 * Во-первых, текст пары становится текстом заявки: в кабинете подрядчика
 * карточка заявки показывает, с чем к нему пришли, а пустая карточка
 * не говорит ничего.
 *
 * Во-вторых, ссылка в ПЕРВОМ сообщении подрядчика уходит на модерацию
 * (§19.4): так выглядит фишинг. Сообщение при этом доставляется —
 * блокировка выгнала бы разговор в мессенджер, где нет ни договора,
 * ни следа для разбирательства.
 */
async function onFirstMessage(
  db: Db,
  chatId: string,
  chat: { kind: ChatKind; wedding_id: string; vendor_id: string | null },
  userId: string,
  text: string,
): Promise<void> {
  if (chat.kind !== 'vendor' || !chat.vendor_id) return
  const { rows } = await db.query<{ n: string; owner: string | null }>(
    `select (select count(*)::text from messages m where m.chat_id = $1) as n,
            (select v.user_id from vendors v where v.id = $2) as owner`,
    [chatId, chat.vendor_id],
  )
  // Считаем ДО вставки, поэтому первое сообщение — это ноль предыдущих.
  if (Number(rows[0]!.n) > 0) return
  const fromVendor = rows[0]!.owner === userId

  if (!fromVendor) {
    await db.query('update leads set message = $3 where vendor_id = $1 and wedding_id = $2 and message is null', [
      chat.vendor_id,
      chat.wedding_id,
      text,
    ])
    return
  }

  if (hasLink(text)) {
    await db.query(
      `insert into complaints (id, reporter_id, target_kind, target_id, category, text)
       values ($1, null, 'vendor', $2, 'spam', $3)`,
      [uuidv7(), chat.vendor_id, `Ссылка в первом сообщении: ${text.slice(0, 500)}`],
    )
  }
}

/**
 * Разговор уходит мимо платформы — обеим сторонам мягкое предупреждение.
 *
 * Системное сообщение в самом чате, а не всплывашка одному: видеть его
 * должны оба, и оно должно остаться в истории. Не чаще раза в сутки
 * на чат — иначе оно превращается в шум и его перестают читать.
 */
/**
 * Замок на чат для «раз в сутки» (класс R-271). Строки, которую можно
 * запереть, здесь нет: предупреждения ещё не существует — поэтому advisory,
 * двухключевой формы, как `OTP_PHONE_LOCK`.
 */
const PAYOUT_WARNING_LOCK = 4_210_003

async function warnAboutPayoutBypass(app: FastifyInstance, db: Db, chatId: string, text: string): Promise<string | null> {
  if (!looksLikePayoutBypass(text)) return null
  /* Счёт и вставка — в одной транзакции за замком чата (F-RL3-05,
   * класс ERR-0271 / R-271). Раньше два сообщения с признаками выплаты мимо
   * эскроу, отправленные одновременно, оба видели пустой счётчик и оба вставляли
   * предупреждение — правило «не чаще раза в сутки» оказывалось бумажным именно
   * в тот момент, когда разговор реально уходит мимо платформы. Живой канал —
   * после фиксации: сообщать о строке до коммита значит показать то, чего может не быть. */
  const inserted = await db.tx(async (client) => {
    await client.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [PAYOUT_WARNING_LOCK, chatId])
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from messages
        where chat_id = $1 and sender_id is null and text = $2 and created_at > now() - interval '1 day'`,
      [chatId, PAYOUT_WARNING],
    )
    if (Number(rows[0]!.n) > 0) return false
    await client.query('insert into messages (id, chat_id, sender_id, text) values ($1,$2,null,$3)', [
      uuidv7(),
      chatId,
      PAYOUT_WARNING,
    ])
    return true
  })
  if (inserted) await app.realtime.publish({ chatId, type: 'message', actorId: 'system' })
  return PAYOUT_WARNING
}

/** Подрядчик и его строка — цель проверки лимита холодных переписок (ниже). */
interface ColdOutreachTarget {
  vendorId: string
}

/**
 * Применим ли лимит холодных переписок к этому отправителю: подрядчик,
 * свой чат, анкета ещё не проверена. Чтение — ДО транзакции: кто именно
 * отправитель и проверена ли анкета, не часть гонки (план §18.2/§19.4).
 * Сам счёт «сколько новых переписок сегодня» и порог — под замком строки
 * подрядчика внутри одной транзакции со вставкой сообщения, см.
 * `assertNotColdOutreach` ниже.
 */
async function resolveColdOutreachTarget(db: Queryable, chatId: string, kind: ChatKind, userId: string): Promise<ColdOutreachTarget | null> {
  if (kind !== 'vendor') return null
  const { rows } = await db.query<{ verified: boolean; mine: boolean; vendor_id: string }>(
    `select (v.verified_at is not null) as verified, (v.user_id = $2) as mine, v.id as vendor_id
       from chats c join vendors v on v.id = c.vendor_id where c.id = $1`,
    [chatId, userId],
  )
  const vendor = rows[0]
  if (!vendor || !vendor.mine || vendor.verified) return null
  return { vendorId: vendor.vendor_id }
}

/**
 * Непроверенный подрядчик — не больше N новых переписок в день (план §18.2,
 * §19.4). Считается и проверяется под замком строки подрядчика ПЕРВОЙ,
 * внутри ОДНОЙ транзакции со вставкой реплики (класс ERR-0271/R-271,
 * сиблинг SA-03): иначе параллельный залп первых сообщений в разные чаты
 * каждый видит одно и то же «меньше предела» и проходит весь разом —
 * ровно как гонка выдачи кода в `routes/auth.ts` (FL-01).
 *
 * Считаются переписки, которые НАЧАЛ он сам, — то есть те, где первое
 * сообщение в чате его.
 *
 * Раньше считались все чаты, где он за сутки что-либо написал, включая
 * ответы на входящие. Это ровно то, чего комментарий выше обещает не
 * делать: подрядчику, которому за день написали пять пар и он всем
 * ответил, шестая пара уже не могла получить ответ — он упирался в
 * «не больше 5 новых переписок в день», не начав ни одной (ERR-0100).
 *
 * Чат заводит пара (`POST /chats/vendor/:vendorId` требует роль `couple`),
 * поэтому холодное обращение здесь единственного вида: пара нажала
 * «Написать», ушла не написав, а подрядчик пишет первым.
 */
async function assertNotColdOutreach(client: Queryable, chatId: string, userId: string, target: ColdOutreachTarget, limit: number): Promise<void> {
  await client.query('select id from vendors where id = $1 for update', [target.vendorId])
  const { rows: already } = await client.query<{ here: string; today: string }>(
    `select (select count(*) from messages m where m.chat_id = $1 and m.sender_id = $2)::text as here,
            (select count(*) from chats c
               cross join lateral (
                 select m.sender_id, m.created_at from messages m
                  where m.chat_id = c.id order by m.created_at, m.id limit 1
               ) first
              where c.vendor_id = $3 and first.sender_id = $2
                and first.created_at > now() - interval '1 day')::text as today`,
    [chatId, userId, target.vendorId],
  )
  // В этой переписке он уже писал — она не новая, ограничение не про неё.
  if (Number(already[0]!.here) > 0) return
  if (Number(already[0]!.today) >= limit) {
    throw quotaExceeded('cold_outreach_limit', `До проверки анкеты — не больше ${limit} новых переписок в день`)
  }
}

/**
 * Реплика человека в чат: права, правила, запись, живой канал, уведомления,
 * сторож §18.2 и фоновый ответ Тиля. Возвращает реплику для ответа автору
 * (`mine: true`) и текст предупреждения, если оно сработало.
 */
export async function sendChatMessage(app: FastifyInstance, input: SendInput): Promise<{ message: SentMessage; warning: string | null }> {
  const db = app.db
  if (!db) throw new AppError(503, 'db_unavailable', 'База недоступна')
  const { chatId, userId } = input
  const { chat } = await chatForUser(db, chatId, userId)
  assertOpen(chat)
  await assertNotClosed(db, chat)
  const coldOutreachTarget = await resolveColdOutreachTarget(db, chatId, chat.kind, userId)

  /* Свой подрядчик работает мимо платформы по определению: пара нашла
   * его сама, комиссии с него нет. Предупреждать тут не о чем — оно
   * читалось бы как обвинение на ровном месте. Заодно пустой отправитель
   * в этом чате остаётся однозначным признаком подрядчика. В чате Тиля
   * сторожа тоже нет: его предупреждение ложилось системной записью без
   * отправителя — то есть «ответом Тиля» на экране и в истории для
   * модели (ревью 015); собеседник там не подрядчик, а помощник. */
  const guardHere = chat.kind !== 'external' && chat.kind !== 'tilly'
  await onFirstMessage(db, chatId, chat, userId, input.text)

  const id = uuidv7()
  const attachments = input.attachmentUrl ? { url: input.attachmentUrl } : null
  /* Квота Тиля (План §18: 50 реплик в сутки на свадьбу, фича 010) —
   * ДО записи и в одной транзакции с ней под замком строки чата: два
   * одновременных вопроса иначе оба видели «49 из 50» и оба записывались
   * — 51 реплика и два ответа модели (ревью 015). Реплика сверх предела
   * не сохраняется, иначе счётчик на экране и переписка расходились бы.
   * 429 без Retry-After — это квота, а не частота: сбросится в полночь
   * по поясу свадьбы, о чём и сказано. */
  const { rows } = await db.tx(async (client) => {
    if (coldOutreachTarget) {
      await assertNotColdOutreach(client, chatId, userId, coldOutreachTarget, app.appConfig.coldOutreachPerDay)
    }
    if (chat.kind === 'tilly') {
      await client.query('select id from chats where id = $1 for update', [chatId])
      const quota = await app.tilly.quota(client, chatId, chat.wedding_id)
      if (quota.used >= quota.limit) {
        throw quotaExceeded(
          'tilly_daily_limit',
          `На сегодня вопросов Тилю — ${quota.limit}, это предел на сутки. Счётчик обнулится в полночь по времени свадьбы, завтра продолжим`,
        )
      }
    }
    return client.query<{ created_at: Date }>(
      `insert into messages (id, chat_id, sender_id, text, attachments)
       values ($1,$2,$3,$4,$5) returning created_at`,
      [id, chatId, userId, input.text, attachments],
    )
  })

  const message: SentMessage = {
    id,
    chatId,
    senderId: userId,
    text: input.text,
    attachmentUrl: input.attachmentUrl ?? null,
    sentAt: rows[0]!.created_at.toISOString(),
    system: false,
    // Реплика участника: имя гостя бывает только у реплик по ссылке гостя.
    guestName: null,
    mine: null,
  }
  // Сначала живому каналу, потом уведомление: у кого чат открыт,
  // тот увидит сообщение, а не значок о нём.
  await app.realtime.publish({ chatId, type: 'message', actorId: userId, payload: { message } })
  await notifyOthers(db, chatId, chat.wedding_id, chat.kind, userId, input.text)
  const warning = guardHere ? await warnAboutPayoutBypass(app, db, chatId, input.text) : null

  /* Тиль отвечает в фоне (фича 010): 201 паре — сразу, ответ модели —
   * отдельной репликой через живой канал и опрос, «печатает…» пока
   * думает. Без модели — честная заглушка тем же путём; молчание
   * выглядело бы как поломка, а «думаю…» без модели — как обман. */
  if (chat.kind === 'tilly') app.tilly.answer({ chatId, weddingId: chat.wedding_id, userId })

  return { message: { ...message, mine: true }, warning }
}
