import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, quotaExceeded } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { uuidv7, isUuid } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery, type PageQuery } from '../pagination.js'
import { assertOpen, chatForUser, rolesSeeing, type ChatKind } from '../chats/access.js'
import { hasLink, looksLikePayoutBypass, PAYOUT_WARNING } from '../chats/guard.js'
import { notify } from '../notify/notify.js'
import { openLead } from '../vendor/leads.js'

const TITLE_BY_KIND: Record<Exclude<ChatKind, 'vendor' | 'external'>, string> = {
  team: 'Команда свадьбы',
  day: 'Чат дня X · гости',
  tilly: 'Тиль — помощник',
  crew: 'Чат исполнителей — ведёт координатор',
}

/**
 * Строка реплики из базы — одна на всех, кто читает `messages`: лента чата
 * (`GET /chats/{id}/messages`) и лента гостя в чате дня X
 * (`GET /join/{t}/day-chat/messages`, фича 009). Имя гостя — `left join
 * guests`: у гостя нет аккаунта, `sender_id` пуст, и без имени его реплика
 * была бы неотличима от системной записи; удалённый из списка гость имя
 * уносит (`SET NULL`) — реплика остаётся, имя пропадает честно.
 */
export interface MessageRow {
  id: string
  chat_id: string
  sender_id: string | null
  guest_id: string | null
  guest_name: string | null
  text: string
  attachments: { url?: string } | null
  created_at: Date
}

/**
 * Страница ленты от свежих к старым: открывая чат, человек видит последнее.
 * Берётся `limit + 1` строка — лишняя отвечает «есть ли ещё» (`buildPage`).
 */
export async function messagePage(db: Queryable, chatId: string, page: PageQuery): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRow>(
    `select m.id, m.chat_id, m.sender_id, m.guest_id, g.name as guest_name, m.text, m.attachments, m.created_at
       from messages m
       left join guests g on g.id = m.guest_id
      where m.chat_id = $1
        and ($2::text is null or (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
      order by m.created_at desc, m.id desc
      limit $4`,
    [chatId, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
  )
  return rows
}

/**
 * `Message` контракта из строки базы.
 *
 * Системная запись — признак от сервера, а не догадка экрана по тексту
 * (D4-15): пустой отправитель означает систему только там, где ей есть
 * место. У Тиль пустой отправитель — её ответ, в чате со своим подрядчиком —
 * сам подрядчик (аккаунта у него нет), а в чате дня X — гость по своей
 * ссылке (фича 009): у него нет `sender_id`, но есть `guest_id`.
 */
export function toMessage(r: MessageRow, kind: ChatKind) {
  const systemHere = kind !== 'tilly' && kind !== 'external'
  return {
    id: r.id,
    chatId: r.chat_id,
    senderId: r.sender_id,
    text: r.text,
    attachmentUrl: r.attachments?.url ?? null,
    sentAt: r.created_at.toISOString(),
    system: systemHere && r.sender_id === null && r.guest_id === null,
    guestName: r.guest_name,
  }
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

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  interface ListRow {
    id: string
    kind: ChatKind
    /** Пара видит строку чата исполнителей, но не его содержимое. */
    peek: boolean
    external_name: string | null
    /** Чат со своим подрядчиком, сделка которого отменена: читать можно, писать некому. */
    closed: boolean
    vendor_name: string | null
    vendor_photo: string | null
    opens_at: Date | null
    last_text: string | null
    unread: string
    /** Название свадьбы: подрядчику оно и есть имя собеседника. */
    wedding_title: string | null
    /** Смотрит не команда свадьбы, а подрядчик со стороны. */
    outsider: boolean
    /** У смотрящего больше одной живой свадьбы — общие чаты без имени свадьбы не различить. */
    many_weddings: boolean
    /** Свадьба чата — квота Тиля считается по её поясу (фича 010). */
    wedding_id: string
  }

  const externalTitle = (name: string | null) => (name ? `${name} · свой подрядчик` : 'Свой подрядчик')

  /**
   * Непрочитанные для пользователя `user` в чате `chat` — один подзапрос
   * на список и на ответ «Написать». Вторая копия правила уже расходилась
   * с первой: повторное «Написать» отдавало `unread: 0` константой, а список
   * рядом показывал 2 — ноль вместо неизвестного (R-178).
   */
  const unreadSql = (chat: string, user: string) =>
    `(select count(*)::text from messages m
       where m.chat_id = ${chat} and m.sender_id is distinct from ${user}
         and m.created_at > coalesce(
               (select r.read_at from chat_reads r where r.chat_id = ${chat} and r.user_id = ${user}),
               to_timestamp(0)))`

  /*
   * Название чата зависит от того, кто смотрит.
   *
   * Собеседник у пары — подрядчик, у подрядчика — пара. Раньше заголовок
   * считался один на всех: подрядчик с тремя свадьбами видел три строки со
   * СВОИМ именем и не мог отличить их друг от друга. Общие чаты (команда,
   * исполнители, день X) у него тоже повторяются по числу свадеб — к ним
   * добавляем, чья свадьба.
   *
   * То же у координатора и помощника: координатор по определению ведёт
   * несколько свадеб, и пять строк «Команда свадьбы» без имени свадьбы
   * не отличить одну от другой. Имя добавляется, когда у смотрящего больше
   * одной живой свадьбы; паре с единственной свадьбой уточнять нечего.
   */
  const toChat = (r: ListRow) => ({
    id: r.id,
    title:
      r.kind === 'vendor'
        ? (r.outsider ? (r.wedding_title ?? 'Пара') : (r.vendor_name ?? 'Подрядчик'))
        : r.kind === 'external'
          ? externalTitle(r.external_name)
          : r.outsider || r.many_weddings
            ? `${TITLE_BY_KIND[r.kind]} · ${r.wedding_title ?? ''}`.trim()
            : TITLE_BY_KIND[r.kind],
    avatarUrl: r.vendor_photo,
    /* Паре — факт, а не содержимое. Последняя реплика в списке выдала бы
     * ровно то, что решено не показывать, и счётчик непрочитанных звал бы
     * туда, куда её всё равно не пустят. */
    lastMessage: r.peek ? 'Переписку ведёт координатор' : (r.last_text ?? ''),
    unread: r.peek ? 0 : Number(r.unread),
    kind: r.kind,
    closed: r.closed,
    openFrom: r.opens_at?.toISOString() ?? null,
    /* Квота Тиля — только у его чата; у остальных поле есть и пусто (контракт). */
    tilly: null as null | { live: boolean; usedToday: number; limitPerDay: number },
  })

  /* ── список чатов ─────────────────────────────────────────────────── */
  app.get('/chats', { preHandler: app.requireConsent }, async (request) => {
    const userId = request.caller!.userId
    /* Один запрос на все чаты пользователя: и там, где он в команде свадьбы,
     * и там, где он подрядчик. Правила видимости повторяют список из
     * `chats/access.ts` — тест сверяет их между собой, чтобы они не разошлись. */
    const { rows } = await db().query<ListRow>(
      /* Имя своего подрядчика — из его сделки (`c.deal_id`), а не из `slots`
       * и не «последняя сделка слота»: когда пара его убирает, слот
       * освобождается и достаётся следующему — а переписка остаётся у
       * прежнего, и «Свой подрядчик» без имени в списке ничего не говорит.
       * Отменённая сделка помечает чат закрытым: паре — история, писать
       * некому (ERR-0219). */
      `select c.id, c.kind, v.name as vendor_name, v.photo_url as vendor_photo, c.opens_at,
              w.title as wedding_title, c.wedding_id,
              -- Кто смотрит: команда свадьбы или подрядчик со стороны.
              (mem.role is null) as outsider,
              (select count(*) from wedding_members mm join weddings ww on ww.id = mm.wedding_id
                where mm.user_id = $1 and ww.archived_at is null and ww.cancelled_at is null) > 1 as many_weddings,
              ext.external_name,
              coalesce(ext.state = 'cancelled', false) as closed,
              (select m.text from messages m where m.chat_id = c.id order by m.created_at desc limit 1) as last_text,
              ${unreadSql('c.id', '$1')} as unread,
              (mem.role = 'couple' and c.kind = 'crew') as peek
         from chats c
         join weddings w on w.id = c.wedding_id
         left join vendors v on v.id = c.vendor_id
         left join deals ext on ext.id = c.deal_id
         left join wedding_members mem on mem.wedding_id = c.wedding_id and mem.user_id = $1
        where w.archived_at is null and w.cancelled_at is null
          and (
            (mem.role = 'couple')
            or (mem.role = 'coordinator' and c.kind <> 'tilly')
            or (mem.role = 'helper' and c.kind in ('team','day'))
            or (v.user_id = $1)
            /* Забронированный подрядчик сидит в общих чатах наравне
             * с командой (§3.11) — но только пока забронирован. */
            or (c.kind in ('team','crew') and exists(
                  select 1 from deals d join vendors mine on mine.id = d.vendor_id
                   where d.wedding_id = c.wedding_id and mine.user_id = $1
                     and d.state in ('booked','paid_deposit','done')))
          )
        order by coalesce(
                   (select max(m.created_at) from messages m where m.chat_id = c.id),
                   c.created_at
                 ) desc`,
      [userId],
    )
    // Сверху — где только что написали. Порядок по дате создания означал бы,
    // что новое сообщение в старом чате никуда его не двигает, а на экране
    // мока чаты стоят по времени последней реплики.
    /* Чат Тиля несёт свою квоту (фича 010, `Chat.tilly`): «сегодня N из 50» и
     * «за Тилем есть модель» экран показывает только по этому ответу, а не
     * досчитывает и не предполагает. Чат Тиля у пары один — один запрос. */
    return Promise.all(
      rows.map(async (r) => {
        const chat = toChat(r)
        if (r.kind !== 'tilly') return chat
        const quota = await app.tilly.quota(db(), r.id, r.wedding_id)
        return { ...chat, tilly: { live: app.tilly.live, usedToday: quota.used, limitPerDay: quota.limit } }
      }),
    )
  })

  /* ── история ──────────────────────────────────────────────────────── */
  app.get('/chats/:chatId/messages', { preHandler: app.requireConsent }, async (request) => {
    const { chatId } = request.params as { chatId: string }
    const { chat } = await chatForUser(db(), chatId, request.caller!.userId)
    assertOpen(chat)

    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    const rows = await messagePage(db(), chatId, page)

    // Открыл чат — значит прочитал. Отметка на пользователя, а не на чат:
    // прочитал один, а не «прочитали все».
    await db().query(
      `insert into chat_reads (chat_id, user_id, read_at) values ($1,$2,now())
       on conflict (chat_id, user_id) do update set read_at = now()`,
      [chatId, request.caller!.userId],
    )

    return buildPage(
      rows.map((r) => toMessage(r, chat.kind)),
      page.limit,
      (m) => encodeCursor(m.sentAt, m.id),
    )
  })

  /* ── отправка ─────────────────────────────────────────────────────── */
  app.post(
    '/chats/:chatId/messages',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 4000 },
            attachmentUrl: { type: 'string', maxLength: 2000, pattern: '^https?://[^ ]+$' },
          },
        },
      },
    },
    async (request, reply) => {
      const { chatId } = request.params as { chatId: string }
      const body = request.body as { text: string; attachmentUrl?: string }
      const userId = request.caller!.userId
      const { chat } = await chatForUser(db(), chatId, userId)
      assertOpen(chat)
      await assertNotClosed(chat)

      await assertNotColdOutreach(chatId, chat.kind, userId)
      /* Квота Тиля (План §18: 50 реплик в сутки на свадьбу, фича 010) —
       * ДО записи: реплика сверх предела не сохраняется, иначе счётчик на
       * экране и переписка расходились бы. 429 без Retry-After — это квота,
       * а не частота: сбросится в полночь по поясу свадьбы, о чём и сказано. */
      if (chat.kind === 'tilly') {
        const quota = await app.tilly.quota(db(), chatId, chat.wedding_id)
        if (quota.used >= quota.limit) {
          throw quotaExceeded(
            'tilly_daily_limit',
            `На сегодня Тиль ответил ${quota.limit} раз — это предел на сутки. Счётчик обнулится в полночь по времени свадьбы, завтра продолжим`,
          )
        }
      }
      /* Свой подрядчик работает мимо платформы по определению: пара нашла
       * его сама, комиссии с него нет. Предупреждать тут не о чем — оно
       * читалось бы как обвинение на ровном месте. Заодно пустой отправитель
       * в этом чате остаётся однозначным признаком подрядчика. */
      const guardHere = chat.kind !== 'external'
      await onFirstMessage(chatId, chat, userId, body.text)

      const id = uuidv7()
      const { rows } = await db().query<{ created_at: Date }>(
        `insert into messages (id, chat_id, sender_id, text, attachments)
         values ($1,$2,$3,$4,$5) returning created_at`,
        [id, chatId, userId, body.text, body.attachmentUrl ? { url: body.attachmentUrl } : null],
      )

      const message = {
        id,
        chatId,
        senderId: userId,
        text: body.text,
        attachmentUrl: body.attachmentUrl ?? null,
        sentAt: rows[0]!.created_at.toISOString(),
        system: false,
        // Реплика участника: имя гостя бывает только у реплик по ссылке гостя.
        guestName: null,
      }
      // Сначала живому каналу, потом уведомление: у кого чат открыт,
      // тот увидит сообщение, а не значок о нём.
      await app.realtime.publish({ chatId, type: 'message', actorId: userId, payload: { message } })
      await notifyOthers(db(), chatId, chat.wedding_id, chat.kind, userId, body.text)
      const warning = guardHere ? await warnAboutPayoutBypass(chatId, body.text) : null

      /* Тиль отвечает в фоне (фича 010): 201 паре — сразу, ответ модели —
       * отдельной репликой через живой канал и опрос, «печатает…» пока
       * думает. Без модели — честная заглушка тем же путём; молчание
       * выглядело бы как поломка, а «думаю…» без модели — как обман. */
      if (chat.kind === 'tilly') app.tilly.answer({ chatId, weddingId: chat.wedding_id, userId })

      // Предупреждение едет вместе с ответом: клиенту не нужно перечитывать
      // историю, чтобы понять, что показать всплывающей плашкой.
      return reply.code(201).send(warning ? { ...message, warning } : message)
    },
  )

  /**
   * В закрытый чат своего подрядчика не пишут: его сделка отменена, ссылка
   * погашена, и по ту сторону никого нет. Переписка остаётся паре для
   * чтения (потому чат не удаляется вместе с подрядчиком), но сообщение
   * в неё легло бы в никуда — 409, а не 201 с молчанием в ответ.
   */
  async function assertNotClosed(chat: { kind: ChatKind; deal_id: string | null }): Promise<void> {
    if (chat.kind !== 'external' || !chat.deal_id) return
    const { rows } = await db().query<{ cancelled: boolean }>(
      `select (state = 'cancelled') as cancelled from deals where id = $1`,
      [chat.deal_id],
    )
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
    chatId: string,
    chat: { kind: ChatKind; wedding_id: string; vendor_id: string | null },
    userId: string,
    text: string,
  ): Promise<void> {
    if (chat.kind !== 'vendor' || !chat.vendor_id) return
    const { rows } = await db().query<{ n: string; owner: string | null }>(
      `select (select count(*)::text from messages m where m.chat_id = $1) as n,
              (select v.user_id from vendors v where v.id = $2) as owner`,
      [chatId, chat.vendor_id],
    )
    // Считаем ДО вставки, поэтому первое сообщение — это ноль предыдущих.
    if (Number(rows[0]!.n) > 0) return
    const fromVendor = rows[0]!.owner === userId

    if (!fromVendor) {
      await db().query('update leads set message = $3 where vendor_id = $1 and wedding_id = $2 and message is null', [
        chat.vendor_id,
        chat.wedding_id,
        text,
      ])
      return
    }

    if (hasLink(text)) {
      await db().query(
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
  async function warnAboutPayoutBypass(chatId: string, text: string): Promise<string | null> {
    if (!looksLikePayoutBypass(text)) return null
    const { rows } = await db().query<{ n: string }>(
      `select count(*)::text as n from messages
        where chat_id = $1 and sender_id is null and text = $2 and created_at > now() - interval '1 day'`,
      [chatId, PAYOUT_WARNING],
    )
    if (Number(rows[0]!.n) > 0) return PAYOUT_WARNING

    await db().query('insert into messages (id, chat_id, sender_id, text) values ($1,$2,null,$3)', [
      uuidv7(),
      chatId,
      PAYOUT_WARNING,
    ])
    await app.realtime.publish({ chatId, type: 'message', actorId: 'system' })
    return PAYOUT_WARNING
  }

  /**
   * Непроверенный подрядчик — не больше пяти новых переписок в день.
   *
   * План §18.2 и §19.4: галочка «Проверен» стоит денег и времени, и до неё
   * рассылать первые сообщения десяткам пар нельзя. Считаются именно ПЕРВЫЕ
   * сообщения: ответ в уже начатой переписке ограничения не знает — иначе
   * лимит бил бы по тем, кто нормально работает.
   */
  async function assertNotColdOutreach(chatId: string, kind: ChatKind, userId: string): Promise<void> {
    if (kind !== 'vendor') return
    const { rows } = await db().query<{ verified: boolean; mine: boolean; vendor_id: string }>(
      `select (v.verified_at is not null) as verified, (v.user_id = $2) as mine, v.id as vendor_id
         from chats c join vendors v on v.id = c.vendor_id where c.id = $1`,
      [chatId, userId],
    )
    const vendor = rows[0]
    if (!vendor || !vendor.mine || vendor.verified) return

    /* Считаются переписки, которые НАЧАЛ он сам, — то есть те, где первое
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
     * «Написать», ушла не написав, а подрядчик пишет первым. */
    const { rows: already } = await db().query<{ here: string; today: string }>(
      `select (select count(*) from messages m where m.chat_id = $1 and m.sender_id = $2)::text as here,
              (select count(*) from chats c
                 cross join lateral (
                   select m.sender_id, m.created_at from messages m
                    where m.chat_id = c.id order by m.created_at, m.id limit 1
                 ) first
                where c.vendor_id = $3 and first.sender_id = $2
                  and first.created_at > now() - interval '1 day')::text as today`,
      [chatId, userId, vendor.vendor_id],
    )
    // В этой переписке он уже писал — она не новая, ограничение не про неё.
    if (Number(already[0]!.here) > 0) return
    if (Number(already[0]!.today) >= app.appConfig.coldOutreachPerDay) {
      throw quotaExceeded(
        'outreach_limit',
        `До проверки анкеты — не больше ${app.appConfig.coldOutreachPerDay} новых переписок в день`,
      )
    }
  }

  /* ── «печатает…» ──────────────────────────────────────────────────── */
  /* Кто когда последний раз сообщал о наборе. Хранится в памяти процесса
   * намеренно: «печатает» живёт секунды, переживать перезапуск ему незачем. */
  const typingAt = new Map<string, number>()
  const TYPING_EVERY_MS = 2000

  app.post('/chats/:chatId/typing', { preHandler: app.requireConsent }, async (request, reply) => {
    const { chatId } = request.params as { chatId: string }
    const userId = request.caller!.userId
    const { chat } = await chatForUser(db(), chatId, userId)
    assertOpen(chat)

    /* Клавиатура шлёт событие на каждое нажатие. Без прореживания один
     * человек с длинным сообщением превращается в сотню публикаций
     * в общий канал — и это ещё до злого умысла. */
    const mark = `${userId}:${chatId}`
    const last = typingAt.get(mark) ?? 0
    const now = Date.now()
    if (now - last < TYPING_EVERY_MS) return reply.code(204).send()
    typingAt.set(mark, now)
    // Карта не должна расти вечно: раз в сотню событий выбрасываем старые.
    if (typingAt.size > 1000) {
      for (const [key, at] of typingAt) if (now - at > TYPING_EVERY_MS * 10) typingAt.delete(key)
    }
    /* Запасной путь для клиента без живого канала: он сообщает о наборе
     * обычным запросом, а дальше событие идёт тем же каналом, что и
     * сообщения. Ничего не хранится: «печатает» живёт секунды. */
    await app.realtime.publish({ chatId, type: 'typing', actorId: userId })
    return reply.code(204).send()
  })

  /* ── чат с подрядчиком ────────────────────────────────────────────── */
  app.post('/chats/vendor/:vendorId', { preHandler: app.requireConsent }, async (request) => {
    const { vendorId } = request.params as { vendorId: string }
    if (!isUuid(vendorId)) throw notFound('Подрядчик не найден')
    const userId = request.caller!.userId

    const { rows: mine } = await db().query<{ wedding_id: string }>(
      `select m.wedding_id from wedding_members m join weddings w on w.id = m.wedding_id
        where m.user_id = $1 and m.role = 'couple' and w.archived_at is null and w.cancelled_at is null
        order by w.created_at desc limit 1`,
      [userId],
    )
    if (mine.length === 0) throw notFound('Сначала заведите свадьбу')
    const weddingId = mine[0]!.wedding_id

    /* Заблокированная анкета — тот же «не найден», что у снятой с публикации:
     * каталог её не показывает, и прямая ссылка из избранного или старого
     * уведомления не должна заводить чат и лид тому, кого модератор убрал. */
    const { rows: vendor } = await db().query<{ name: string; photo_url: string | null }>(
      `select v.name, v.photo_url from vendors v join users u on u.id = v.user_id
        where v.id = $1 and v.published_at is not null and v.blocked_at is null and u.deleted_at is null`,
      [vendorId],
    )
    if (vendor.length === 0) throw notFound('Подрядчик не найден')

    // «Написать» нажимают дважды — второй раз должен открыть ТОТ ЖЕ чат,
    // а не завести второй. Держит это уникальный индекс, не проверка.
    const id = uuidv7()
    const { rows } = await db().query<{ id: string; opens_at: Date | null }>(
      `insert into chats (id, wedding_id, kind, vendor_id) values ($1,$2,'vendor',$3)
       on conflict (wedding_id, vendor_id) where kind = 'vendor' do update set kind = 'vendor'
       returning id, opens_at`,
      [id, weddingId, vendorId],
    )

    /* «Написать» — это и есть заявка. Лид заводится здесь, а не отдельной
     * кнопкой: подрядчик должен увидеть обращение в кабинете, даже если
     * пара после первого сообщения пропала. */
    await openLead(db(), weddingId, vendorId, null)

    /* Повторное «Написать» открывает уже живую переписку, в которой подрядчик
     * мог ответить: непрочитанные считаются тем же подзапросом, что в списке,
     * а не ставятся нулём. Нового чата это тоже касается — там и выйдет ноль. */
    const { rows: state } = await db().query<{ text: string | null; unread: string }>(
      `select (select m.text from messages m where m.chat_id = $1 order by m.created_at desc limit 1) as text,
              ${unreadSql('$1', '$2')} as unread`,
      [rows[0]!.id, userId],
    )
    return {
      id: rows[0]!.id,
      title: vendor[0]!.name,
      avatarUrl: vendor[0]!.photo_url,
      lastMessage: state[0]!.text ?? '',
      unread: Number(state[0]!.unread),
      kind: 'vendor',
      closed: false,
      openFrom: null,
    }
  })
}
