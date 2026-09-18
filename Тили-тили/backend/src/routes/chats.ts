import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { uuidv7, isUuid } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery, timestampKey, type PageQuery } from '../pagination.js'
import { assertOpen, chatForUser, type ChatKind } from '../chats/access.js'
import { sendChatMessage } from '../chats/post.js'
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
  /** `created_at` знаками, с микросекундами — ключ курсора (см. `CREATED_AT_US`). */
  created_at_us: string
}

/**
 * Время реплики для курсора — текстом из базы, с микросекундами
 * (`timestampKey`, фича 014, D4-23): с усечённым до миллисекунд временем
 * реплики, записанные в ту же миллисекунду после последней на странице,
 * в следующую страницу не попадали.
 */
export const CREATED_AT_US = `${timestampKey('m.created_at')} as created_at_us`

/**
 * Страница ленты от свежих к старым: открывая чат, человек видит последнее.
 * Берётся `limit + 1` строка — лишняя отвечает «есть ли ещё» (`buildPage`).
 */
export async function messagePage(db: Queryable, chatId: string, page: PageQuery): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRow>(
    `select m.id, m.chat_id, m.sender_id, m.guest_id, g.name as guest_name, m.text, m.attachments, m.created_at,
            ${CREATED_AT_US}
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
 *
 * `mine` — своя ли реплика для того, кто читает (фича 014, A8). Участнику
 * — по `sender_id`, гостю по ссылке — по его строке в списке гостей: у гостя
 * нет идентификатора аккаунта, и экран узнавал свою реплику по имени, а две
 * Марины на одной свадьбе — не редкость. Без читателя (живой канал, куда
 * одна и та же реплика уходит всем) — `null`: «не знаем», а не «не моя».
 */
export type MessageViewer = { userId: string } | { guestId: string } | null

export function toMessage(r: MessageRow, kind: ChatKind, viewer: MessageViewer = null) {
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
    mine: isMine(r, viewer),
  }
}

export function isMine(r: { sender_id: string | null; guest_id: string | null }, viewer: MessageViewer): boolean | null {
  if (!viewer) return null
  if ('userId' in viewer) return r.sender_id !== null && r.sender_id === viewer.userId
  return r.guest_id !== null && r.guest_id === viewer.guestId
}

/* Уведомление участникам чата — вместе с отправкой реплики в `chats/post.ts`;
 * здесь реэкспорт для `routes/day.ts` (реплика гостя в чате дня X). */
export { notifyOthers } from '../chats/post.js'

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

    // Курсор — по микросекундам строки, а не по `sentAt` с миллисекундами (D4-23).
    const paged = buildPage(rows, page.limit, (r) => encodeCursor(r.created_at_us, r.id))
    return { items: paged.items.map((r) => toMessage(r, chat.kind, { userId: request.caller!.userId })), nextCursor: paged.nextCursor }
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
      /* Права, правила (закрытый чат, холодные обращения, ссылка в первом
       * сообщении, сторож §18.2), квота Тиля и запись — в `sendChatMessage`:
       * та же дверь, что у текста подрядчика из кабинета заявок (ревью 015). */
      const { message, warning } = await sendChatMessage(app, {
        chatId,
        userId: request.caller!.userId,
        text: body.text,
        ...(body.attachmentUrl ? { attachmentUrl: body.attachmentUrl } : {}),
      })
      // Предупреждение едет вместе с ответом: клиенту не нужно перечитывать
      // историю, чтобы понять, что показать всплывающей плашкой.
      return reply.code(201).send(warning ? { ...message, warning } : message)
    },
  )

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
      // Квота Тиля — только у его чата; у остальных поле есть и пусто (контракт `Chat.tilly`).
      tilly: null,
    }
  })
}
