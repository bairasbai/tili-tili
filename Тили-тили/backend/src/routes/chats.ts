import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { assertOpen, chatForUser, type ChatKind } from '../chats/access.js'
import { notify } from '../notify/notify.js'

/** Ответ Тиль, пока у неё нет модели. Честно, а не «думаю…» в пустоту. */
const TILLY_STUB =
  'Тиль пока без ИИ — подсказки готовятся. Напишите вопрос: он сохранится, и вы получите ответ, когда помощник заработает.'

const TITLE_BY_KIND: Record<Exclude<ChatKind, 'vendor'>, string> = {
  team: 'Команда свадьбы',
  day: 'Чат дня X · гости',
  tilly: 'Тиль — помощник',
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  interface ListRow {
    id: string
    kind: ChatKind
    vendor_name: string | null
    vendor_photo: string | null
    opens_at: Date | null
    last_text: string | null
    unread: string
  }

  const toChat = (r: ListRow) => ({
    id: r.id,
    title: r.kind === 'vendor' ? (r.vendor_name ?? 'Подрядчик') : TITLE_BY_KIND[r.kind],
    avatarUrl: r.vendor_photo,
    lastMessage: r.last_text ?? '',
    unread: Number(r.unread),
    kind: r.kind,
    openFrom: r.opens_at?.toISOString() ?? null,
  })

  /* ── список чатов ─────────────────────────────────────────────────── */
  app.get('/chats', { preHandler: app.requireConsent }, async (request) => {
    const userId = request.caller!.userId
    /* Один запрос на все чаты пользователя: и там, где он в команде свадьбы,
     * и там, где он подрядчик. Правила видимости повторяют список из
     * `chats/access.ts` — тест сверяет их между собой, чтобы они не разошлись. */
    const { rows } = await db().query<ListRow>(
      `select c.id, c.kind, v.name as vendor_name, v.photo_url as vendor_photo, c.opens_at,
              (select m.text from messages m where m.chat_id = c.id order by m.created_at desc limit 1) as last_text,
              (select count(*)::text from messages m
                where m.chat_id = c.id and m.sender_id is distinct from $1
                  and m.created_at > coalesce(r.read_at, to_timestamp(0))) as unread
         from chats c
         join weddings w on w.id = c.wedding_id
         left join vendors v on v.id = c.vendor_id
         left join wedding_members mem on mem.wedding_id = c.wedding_id and mem.user_id = $1
         left join chat_reads r on r.chat_id = c.id and r.user_id = $1
        where w.archived_at is null and w.cancelled_at is null
          and (
            (mem.role = 'couple')
            or (mem.role = 'coordinator' and c.kind <> 'tilly')
            or (mem.role = 'helper' and c.kind in ('team','day'))
            or (v.user_id = $1)
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
    return rows.map(toChat)
  })

  /* ── история ──────────────────────────────────────────────────────── */
  app.get('/chats/:chatId/messages', { preHandler: app.requireConsent }, async (request) => {
    const { chatId } = request.params as { chatId: string }
    const { chat } = await chatForUser(db(), chatId, request.caller!.userId)
    assertOpen(chat)

    const page = parsePageQuery(request.query as { limit?: unknown; cursor?: unknown })
    // Лента идёт от свежих к старым: открывая чат, человек видит последнее.
    const { rows } = await db().query<{
      id: string
      chat_id: string
      sender_id: string | null
      text: string
      attachments: { url?: string } | null
      created_at: Date
    }>(
      `select id, chat_id, sender_id, text, attachments, created_at
         from messages
        where chat_id = $1
          and ($2::text is null or (created_at, id) < ($2::timestamptz, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [chatId, page.cursor?.sort ?? null, page.cursor?.id ?? null, page.limit + 1],
    )

    // Открыл чат — значит прочитал. Отметка на пользователя, а не на чат:
    // прочитал один, а не «прочитали все».
    await db().query(
      `insert into chat_reads (chat_id, user_id, read_at) values ($1,$2,now())
       on conflict (chat_id, user_id) do update set read_at = now()`,
      [chatId, request.caller!.userId],
    )

    return buildPage(
      rows.map((r) => ({
        id: r.id,
        chatId: r.chat_id,
        senderId: r.sender_id,
        text: r.text,
        attachmentUrl: r.attachments?.url ?? null,
        sentAt: r.created_at.toISOString(),
      })),
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
      }
      // Сначала живому каналу, потом уведомление: у кого чат открыт,
      // тот увидит сообщение, а не значок о нём.
      await app.realtime.publish({ chatId, type: 'message', actorId: userId, payload: { message } })
      await notifyOthers(chatId, chat.wedding_id, chat.kind, userId, body.text)

      // Тиль отвечает сразу и честно: вопрос сохранён, модели пока нет.
      // Молчание выглядело бы как поломка, а «думаю…» — как обман.
      if (chat.kind === 'tilly') {
        const replyId = uuidv7()
        const { rows: answered } = await db().query<{ created_at: Date }>(
          'insert into messages (id, chat_id, sender_id, text) values ($1,$2,null,$3) returning created_at',
          [replyId, chatId, TILLY_STUB],
        )
        await app.realtime.publish({
          chatId,
          type: 'message',
          actorId: userId,
          payload: {
            message: {
              id: replyId,
              chatId,
              senderId: null,
              text: TILLY_STUB,
              attachmentUrl: null,
              sentAt: answered[0]!.created_at.toISOString(),
            },
          },
        })
      }

      return reply.code(201).send(message)
    },
  )

  /** Уведомление всем, кто в этом чате состоит, кроме автора. */
  async function notifyOthers(
    chatId: string,
    weddingId: string,
    kind: ChatKind,
    authorId: string,
    text: string,
  ): Promise<void> {
    if (kind === 'tilly') return
    const { rows } = await db().query<{ user_id: string }>(
      `select mem.user_id from wedding_members mem where mem.wedding_id = $1
        union
       select v.user_id from chats c join vendors v on v.id = c.vendor_id where c.id = $2`,
      [weddingId, chatId],
    )
    for (const row of rows) {
      if (row.user_id === authorId) continue
      await notify(db(), {
        userId: row.user_id,
        kind: 'chat',
        title: 'Новое сообщение',
        body: text.length > 120 ? `${text.slice(0, 119)}…` : text,
        link: `/chats/${chatId}`,
      })
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
    if (!/^[0-9a-f-]{36}$/i.test(vendorId)) throw notFound('Подрядчик не найден')
    const userId = request.caller!.userId

    const { rows: mine } = await db().query<{ wedding_id: string }>(
      `select m.wedding_id from wedding_members m join weddings w on w.id = m.wedding_id
        where m.user_id = $1 and m.role = 'couple' and w.archived_at is null and w.cancelled_at is null
        order by w.created_at desc limit 1`,
      [userId],
    )
    if (mine.length === 0) throw notFound('Сначала заведите свадьбу')
    const weddingId = mine[0]!.wedding_id

    const { rows: vendor } = await db().query<{ name: string; photo_url: string | null }>(
      `select v.name, v.photo_url from vendors v join users u on u.id = v.user_id
        where v.id = $1 and v.published_at is not null and u.deleted_at is null`,
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

    const { rows: last } = await db().query<{ text: string }>(
      'select text from messages where chat_id = $1 order by created_at desc limit 1',
      [rows[0]!.id],
    )
    return {
      id: rows[0]!.id,
      title: vendor[0]!.name,
      avatarUrl: vendor[0]!.photo_url,
      lastMessage: last[0]?.text ?? '',
      unread: 0,
      kind: 'vendor',
      openFrom: null,
    }
  })
}
