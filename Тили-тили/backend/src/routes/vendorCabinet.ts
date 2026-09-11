import type { FastifyInstance } from 'fastify'
import { AppError, conflict, forbidden, notFound } from '../errors.js'
import { uuidv7, isUuid } from '../ids.js'
import { notify } from '../notify/notify.js'
import { rolesSeeing } from '../chats/access.js'
import { PAID_SUM } from '../deals/repo.js'

/** Мягкая бронь подрядчика по лиду — те же 72 часа, что и у сделки (§18.3). */
const HOLD_HOURS = 72

export async function vendorCabinetRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /** Анкета текущего пользователя. Нет анкеты — нет кабинета. */
  async function myVendorId(userId: string): Promise<string> {
    const { rows } = await db().query<{ id: string }>('select id from vendors where user_id = $1', [userId])
    if (rows.length === 0) throw forbidden('Кабинет доступен только подрядчику с анкетой')
    return rows[0]!.id
  }

  /* ── лиды ─────────────────────────────────────────────────────────── */
  const LEAD_COLUMNS = `l.id, l.message, l.state, l.hold_until, l.created_at,
    w.title as couple_name, w.date::text as wedding_date, c.name as city`

  interface LeadRow {
    id: string
    message: string | null
    state: string
    hold_until: Date | null
    created_at: Date
    couple_name: string
    wedding_date: string | null
    city: string | null
  }

  const toLead = (r: LeadRow) => ({
    id: r.id,
    coupleName: r.couple_name,
    weddingDate: r.wedding_date,
    city: r.city,
    message: r.message ?? '',
    status: r.state,
    holdUntil: r.hold_until?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  })

  /**
   * Просроченная бронь лида снимается при чтении.
   *
   * То же решение, что и с мягкой бронью сделки: ленивый путь плюс
   * ежечасная страховка. Держать дату «под вопросом» после срока — значит
   * терять и пару, и подрядчика.
   */
  async function expireLeadHolds(vendorId: string): Promise<void> {
    await db().query(
      `update leads set state = 'new', hold_until = null
        where vendor_id = $1 and state = 'hold' and hold_until is not null and hold_until <= now()`,
      [vendorId],
    )
  }

  /* ── обновления от пар (§13.2) ────────────────────────────────────── */
  /**
   * Что изменилось у пар по забронированным свадьбам.
   *
   * Не уведомление: уведомление уходит в общий список и тонет между
   * «новое сообщение» и «гость ответил». Здесь короткий список того,
   * что надо УЧЕСТЬ — пересчитать порции, переставить технику, приехать
   * к другому часу, — и он закрывается подтверждением.
   */
  app.get('/vendor/updates', { preHandler: app.requireConsent }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    const { rows } = await db().query<{
      id: string
      wedding: string
      date: string | null
      kind: string
      text: string
      created_at: Date
      ack_at: Date | null
    }>(
      `select u.id, w.title as wedding, w.date::text as date, u.kind, u.text, u.created_at, u.ack_at
         from vendor_updates u join weddings w on w.id = u.wedding_id
        where u.vendor_id = $1 and w.archived_at is null and w.cancelled_at is null
        order by (u.ack_at is not null), u.created_at desc
        limit 50`,
      [vendorId],
    )
    // Неподтверждённые сверху: подтверждённые остаются как история дня,
    // но глаз должен упираться в то, что ещё не учтено.
    return rows.map((r) => ({
      id: r.id,
      wedding: r.wedding,
      weddingDate: r.date,
      kind: r.kind,
      text: r.text,
      createdAt: r.created_at.toISOString(),
      ackAt: r.ack_at?.toISOString() ?? null,
    }))
  })

  app.post('/vendor/updates/:updateId/ack', { preHandler: app.requireConsent }, async (request, reply) => {
    const { updateId } = request.params as { updateId: string }
    if (!isUuid(updateId)) throw notFound('Обновление не найдено')
    const vendorId = await myVendorId(request.caller!.userId)
    // Повторное подтверждение не двигает время: «учёл» случается один раз.
    const res = await db().query(
      'update vendor_updates set ack_at = coalesce(ack_at, now()) where id = $1 and vendor_id = $2',
      [updateId, vendorId],
    )
    if (res.rowCount === 0) throw notFound('Обновление не найдено')
    return reply.code(204).send()
  })

  app.get('/vendor/leads', { preHandler: app.requireConsent }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    await expireLeadHolds(vendorId)
    const { rows } = await db().query<LeadRow>(
      `select ${LEAD_COLUMNS}
         from leads l
         join weddings w on w.id = l.wedding_id
         left join cities c on c.id = w.city_id
        where l.vendor_id = $1 and w.archived_at is null
        order by l.created_at desc`,
      [vendorId],
    )
    return rows.map(toLead)
  })

  app.post(
    '/vendor/leads/:leadId',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['reply', 'hold', 'decline', 'reopen'] },
            text: { type: 'string', minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
    async (request) => {
      const { leadId } = request.params as { leadId: string }
      if (!isUuid(leadId)) throw notFound('Лид не найден')
      const body = request.body as { action: 'reply' | 'hold' | 'decline' | 'reopen'; text?: string }
      const vendorId = await myVendorId(request.caller!.userId)

      const { rows: found } = await db().query<{ state: string; wedding_id: string }>(
        'select state, wedding_id from leads where id = $1 and vendor_id = $2',
        [leadId, vendorId],
      )
      if (found.length === 0) throw notFound('Лид не найден')
      // Выигранный лид — это состоявшаяся сделка. Возвращать его в работу
      // из кабинета нельзя: состояние сделки живёт в своей машине (этап 4).
      if (found[0]!.state === 'won') throw conflict('lead_won', 'По этому лиду уже есть сделка')

      const next = { reply: 'replied', hold: 'hold', decline: 'declined', reopen: 'new' }[body.action]
      if (body.action === 'reply' && !body.text) {
        throw new AppError(422, 'text_required', 'Для ответа нужен текст', { text: 'обязателен при action=reply' })
      }

      /* Текст при любом действии — сообщение подрядчика в чат заявки.
       *
       * Раньше он читался только при `reply`: «отказ с причиной» (§3.13)
       * принимался и выбрасывался, пара об отказе или холде не узнавала
       * ничем (D5-22, R-48). Чат ищется ДО записи состояния: если передать
       * текст некуда, заявка не должна менять состояние молча — это 422,
       * а не «принято» без последствий. Чат есть у всякой заявки из
       * «Написать»; без чата бывает только выигранная, а она отвергнута выше. */
      let chatId: string | null = null
      if (body.text) {
        const { rows: chat } = await db().query<{ id: string }>(
          "select id from chats where wedding_id = $1 and vendor_id = $2 and kind = 'vendor'",
          [found[0]!.wedding_id, vendorId],
        )
        if (!chat[0]) {
          throw new AppError(422, 'text_not_allowed', 'У этой заявки нет чата — текст передать некуда', {
            text: 'у заявки без чата текст не принимается',
          })
        }
        chatId = chat[0].id
      }

      const { rows } = await db().query<LeadRow>(
        `update leads l set state = $3,
              hold_until = case when $3 = 'hold' then now() + make_interval(hours => $4) else null end
          where l.id = $1 and l.vendor_id = $2
          returning l.id, l.message, l.state, l.hold_until, l.created_at,
                    (select w.title from weddings w where w.id = l.wedding_id) as couple_name,
                    (select w.date::text from weddings w where w.id = l.wedding_id) as wedding_date,
                    (select c.name from weddings w left join cities c on c.id = w.city_id
                      where w.id = l.wedding_id) as city`,
        [leadId, vendorId, next, HOLD_HOURS],
      )

      /* Ответ подрядчика — сообщение в общий чат, а не отдельная сущность.
       * Иначе у переписки два места хранения и два порядка сортировки. */
      if (body.text && chatId) {
        await db().query('insert into messages (id, chat_id, sender_id, text) values ($1,$2,$3,$4)', [
          uuidv7(),
          chatId,
          request.caller!.userId,
          body.text,
        ])
        await app.realtime.publish({ chatId, type: 'message', actorId: request.caller!.userId })

        /* И уведомление — тоже как у обычного сообщения.
         *
         * Ответ из кабинета лидов писал в тот же чат, но никого не звал:
         * живой канал доходит только до того, у кого чат открыт прямо
         * сейчас, а пара узнавала об ответе, лишь заглянув туда сама. Один
         * и тот же поступок через два входа давал разный результат — при
         * том, что комментарий выше объясняет, зачем переписка сведена
         * в одно место (ERR-0107).
         *
         * Получатели — по матрице видимости, а не все участники: помощник
         * чат с подрядчиком не открывает (ERR-0099). */
        const { rows: members } = await db().query<{ user_id: string }>(
          'select user_id from wedding_members where wedding_id = $1 and role = any($2)',
          [found[0]!.wedding_id, rolesSeeing('vendor')],
        )
        // Тихие часы по поясу свадьбы, если у получателя свой не задан (RF-BE-04).
        const { rows: tzRow } = await db().query<{ tz: string | null }>('select tz from weddings where id = $1', [
          found[0]!.wedding_id,
        ])
        for (const m of members) {
          await notify(db(), {
            userId: m.user_id,
            kind: 'chat',
            title: 'Новое сообщение',
            body: body.text.length > 120 ? `${body.text.slice(0, 119)}…` : body.text,
            link: `/chats/${chatId}`,
          }, new Date(), tzRow[0]?.tz ?? null)
        }
      }
      return toLead(rows[0]!)
    },
  )

  /* ── сделки ───────────────────────────────────────────────────────── */
  app.get('/vendor/deals', { preHandler: app.requireConsent }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    /* Заявка и сделка — разные вещи. У заявки нет ни суммы, ни срока брони,
     * и показывать список лидов вместо сделок значило бы врать про деньги. */
    const { rows } = await db().query<{
      id: string
      couple_name: string
      wedding_date: string | null
      price: string | null
      currency: string
      state: string
      negotiating_until: Date | null
      paid: string
      hold_alive: boolean
    }>(
      `select d.id, w.title as couple_name, w.date::text as wedding_date,
              d.price::text as price, d.currency, d.state, d.negotiating_until,
              ${PAID_SUM}::text as paid,
              (d.negotiating_until is not null and d.negotiating_until > now()) as hold_alive
         from deals d join weddings w on w.id = d.wedding_id
        where d.vendor_id = $1 and w.archived_at is null
        order by d.created_at desc`,
      [vendorId],
    )

    /* «Ожидается по сделкам» — остаток по открытым броням: цена минус то,
     * что уже пришло платежами (те же `payments`, что видит пара; возвраты
     * с минусом, отменённые не считаются). Раньше складывалась цена целиком,
     * и сделка 100 000 ₽ с внесённым авансом 50 000 ₽ показывала «ожидается
     * 100 000 ₽» (D5-08). Закрытые и отменённые в ожидание не входят. */
    const expected = rows
      .filter((r) => r.state === 'booked' || r.state === 'paid_deposit')
      .reduce((sum, r) => sum + Math.max(0, Number(r.price ?? 0) - Number(r.paid)), 0)

    return {
      expected: { amount: expected, currency: 'RUB' },
      items: rows.map((r) => ({
        id: r.id,
        coupleName: r.couple_name,
        weddingDate: r.wedding_date,
        price: r.price === null ? null : { amount: Number(r.price), currency: r.currency },
        state: r.state,
        /* Срок брони показывается, только пока он не вышел: истёкший снимает
         * ленивый путь на стороне пары и ежечасная задача, а кабинет до этого
         * часа писал «держим до <прошедшее время>» (D5-26б, R-178). */
        holdUntil:
          r.state === 'negotiating' && r.hold_alive ? (r.negotiating_until?.toISOString() ?? null) : null,
      })),
    }
  })

  /* ── отзывы на меня ───────────────────────────────────────────────── */
  app.get('/vendor/reviews', { preHandler: app.requireConsent }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    /* Столбец `guest_token` здесь не читается: отзыв гостя анонимен так же,
     * как резерв подарка (§9). Подрядчик видит звёзды и текст, но не то,
     * кто из гостей их поставил. */
    const { rows } = await db().query<{
      id: string
      stars: number
      text: string | null
      reply: string | null
      replied_at: Date | null
      created_at: Date
      source: string
    }>(
      `select id, stars, text, reply, replied_at, created_at, source
         from reviews where vendor_id = $1 and hidden_at is null
        order by created_at desc`,
      [vendorId],
    )
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      authorName: r.source === 'guest' ? 'Гость свадьбы' : 'Пара со сделкой',
      rating: r.stars,
      text: r.text ?? '',
      createdAt: r.created_at.toISOString(),
      reply: r.reply ? { text: r.reply, createdAt: (r.replied_at ?? r.created_at).toISOString() } : null,
    }))
  })

  app.post(
    '/vendor/reviews/:reviewId/reply',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request) => {
      const { reviewId } = request.params as { reviewId: string }
      if (!isUuid(reviewId)) throw notFound('Отзыв не найден')
      const { text } = request.body as { text: string }
      const vendorId = await myVendorId(request.caller!.userId)

      // Право ответа — одно (§18.2): ответ правится, но не превращается
      // в переписку под отзывом.
      const res = await db().query(
        'update reviews set reply = $3, replied_at = now() where id = $1 and vendor_id = $2 and hidden_at is null',
        [reviewId, vendorId, text],
      )
      if (res.rowCount === 0) throw notFound('Отзыв не найден')
      return { id: reviewId, reply: { text } }
    },
  )

  /* ── аналитика ────────────────────────────────────────────────────── */
  app.get(
    '/vendor/analytics',
    {
      preHandler: app.requireConsent,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { period: { type: 'string', enum: ['month', 'season', 'year'], default: 'season' } },
        },
      },
    },
    async (request) => {
      const vendorId = await myVendorId(request.caller!.userId)
      const period = (request.query as { period?: string }).period ?? 'season'
      const days = { month: 30, season: 92, year: 365 }[period] ?? 92

      /* «Доход» — деньги, которые пришли: сумма платежей по дате платежа,
       * возвраты с минусом, отменённые записи не считаются. Раньше складывалась
       * цена сделок по дате их создания — бронь без единого рубля шла в
       * «доход», и «+38 %» сравнивал такие же суммы (D5-08, R-178). */
      const PAYMENTS_SUM = `select coalesce(sum(case when p.kind = 'refund' then -p.amount else p.amount end), 0)
             from payments p join deals d on d.id = p.deal_id
            where d.vendor_id = $1 and p.status <> 'cancelled'`
      const { rows } = await db().query<{
        views: string
        contacts: string
        leads: string
        deals: string
        revenue: string
        prev_revenue: string
      }>(
        `select
           (select views from vendors where id = $1)::text as views,
           (select count(*) from chats where vendor_id = $1)::text as contacts,
           (select count(*) from leads where vendor_id = $1 and created_at > now() - make_interval(days => $2))::text as leads,
           (select count(*) from deals where vendor_id = $1 and state in ('booked','paid_deposit','done')
             and created_at > now() - make_interval(days => $2))::text as deals,
           (${PAYMENTS_SUM} and p.created_at > now() - make_interval(days => $2))::text as revenue,
           (${PAYMENTS_SUM}
             and p.created_at between now() - make_interval(days => $2 * 2) and now() - make_interval(days => $2))::text
             as prev_revenue`,
        [vendorId, days],
      )
      const row = rows[0]!
      const revenue = Number(row.revenue)
      const previous = Number(row.prev_revenue)
      return {
        period,
        revenue: { amount: revenue, currency: 'RUB' },
        // Прирост считается от прошлого такого же периода. Делить на ноль
        // нечем: если раньше не было ничего, процент не определён.
        revenueDeltaPct: previous === 0 ? null : Math.round(((revenue - previous) / previous) * 100),
        funnel: {
          views: Number(row.views),
          contacts: Number(row.contacts),
          leads: Number(row.leads),
          deals: Number(row.deals),
        },
      }
    },
  )

  /* ── верификация ──────────────────────────────────────────────────── */
  /**
   * Что стало с моими документами.
   *
   * Без этого пути подрядчик видит только наличие или отсутствие галочки:
   * «дошло ли» и «отклонили ли» неотличимы от «ещё не смотрели» (FR-007).
   *
   * Ни `file_url`, ни `inn` не выбираются: они свои, но экрану не нужны,
   * а лишний ответ с документом — это документ, осевший в кэше устройства.
   * Причина отказа приходит уведомлением: своего поля у заявки нет (A3).
   */
  app.get('/vendor/verification', { preHandler: app.requireConsent }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    // Последняя заявка, а не первая незакрытая: экран показывает состояние
    // дел на сейчас, а после отказа подрядчик подаёт документы заново.
    const { rows } = await db().query<{
      kind: string
      status: string
      created_at: Date
      checked_at: Date | null
    }>(
      `select kind, status, created_at, checked_at from vendor_verifications
        where vendor_id = $1 order by created_at desc, id desc limit 1`,
      [vendorId],
    )
    const last = rows[0]
    // Заявок не было — это `none`, а не пустой объект: экран различает
    // «не подавал» и «подал, ждём».
    if (!last) return { status: 'none', kind: null, submittedAt: null, checkedAt: null }
    return {
      status: last.status,
      kind: last.kind,
      submittedAt: last.created_at.toISOString(),
      checkedAt: last.checked_at?.toISOString() ?? null,
    }
  })

  app.post(
    '/vendor/verification',
    {
      preHandler: app.requireConsent,
      schema: {
        /* Слово в слово с контрактом (`POST /vendor/verification`), включая
         * `https`: ссылка открывается сотрудником в новой вкладке из карточки
         * заявки, и `http`, `javascript:` или `file:` были бы не документом, а
         * тем, что подсунули сотруднику. Раньше это требование жило ТОЛЬКО
         * здесь: контракт объявлял `fileUrl` голой строкой, и клиент, писавший
         * по контракту, узнавал о правиле из 422. `ref()` тут не поставить —
         * генератор переносит только `components.schemas`, а тело этого пути
         * объявлено в самом пути. */
        body: {
          type: 'object',
          required: ['kind', 'fileUrl'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['passport', 'ip', 'company'] },
            fileUrl: { type: 'string', maxLength: 2000, pattern: '^https://[^ ]+$' },
            inn: { type: 'string', pattern: '^[0-9]{10}$|^[0-9]{12}$' },
          },
        },
      },
    },
    async (request, reply) => {
      const vendorId = await myVendorId(request.caller!.userId)
      const body = request.body as { kind: string; fileUrl: string; inn?: string }

      const { rows: pending } = await db().query(
        "select 1 from vendor_verifications where vendor_id = $1 and status = 'pending'",
        [vendorId],
      )
      // Вторая заявка при неразобранной первой — это не второй документ,
      // а второе нажатие: очередь модератора от этого только растёт.
      if (pending.length > 0) throw conflict('verification_pending', 'Заявка уже на проверке')

      await db().query(
        'insert into vendor_verifications (id, vendor_id, kind, file_url, inn) values ($1,$2,$3,$4,$5)',
        [uuidv7(), vendorId, body.kind, body.fileUrl, body.inn ?? null],
      )
      // Документ наружу не выходит никогда — в ответе только факт подачи.
      return reply.code(201).send({ status: 'pending' })
    },
  )
}
