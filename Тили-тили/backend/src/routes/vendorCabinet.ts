import type { FastifyInstance } from 'fastify'
import { ref } from '../contract/schemas.generated.js'
import { withIdempotency } from '../deals/idempotency.js'
import { AppError, TooManyRequests, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { sendChatMessage } from '../chats/post.js'
import { notifyCoupleOfferEvent } from '../offers/notify.js'
import { isUniqueViolation } from '../plugins/db.js'

const VENDOR_PAID_SUM = `(select coalesce(sum(case when p.kind='refund' then -p.amount else p.amount end),0)
  from payments p
  where p.deal_id=d.id and p.status<>'cancelled' and p.amount_known
    and (p.visibility='vendor' or p.legacy_vendor_visible))`

/** Мягкая бронь подрядчика по лиду — те же 72 часа, что и у сделки (§18.3). */
const HOLD_HOURS = 72

type OfferInput =
  | {
      kind: 'offer'
      packageId: string
      price: { amount: number; currency: 'RUB' }
      message?: string
      validUntil?: string
    }
  | {
      kind: 'offer'
      title: string
      price: { amount: number; currency: 'RUB' }
      includes: string[]
      message?: string
      validUntil?: string
    }
  | { kind: 'decline'; message: string }

interface OfferViewRow {
  id: string
  request_id: string
  kind: 'offer' | 'decline'
  package_id: string | null
  title: string | null
  price: string | null
  currency: string
  includes: string[]
  message: string | null
  valid_until: string | null
}

const toOffer = (row: OfferViewRow) => ({
  id: row.id,
  requestId: row.request_id,
  kind: row.kind,
  packageId: row.package_id,
  title: row.title,
  price: row.price === null ? null : { amount: Number(row.price), currency: row.currency },
  includes: row.includes,
  message: row.message,
  validUntil: row.valid_until,
})

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
    w.title as couple_name, w.date::text as wedding_date, c.name as city,
    (select ch.id from chats ch where ch.wedding_id = l.wedding_id and ch.vendor_id = l.vendor_id and ch.kind = 'vendor') as chat_id`

  interface LeadRow {
    id: string
    message: string | null
    state: string
    hold_until: Date | null
    created_at: Date
    couple_name: string
    wedding_date: string | null
    city: string | null
    chat_id: string | null
  }

  const toLead = (r: LeadRow) => ({
    id: r.id,
    // Чат заявки — тот же, что открыло «Написать» пары; кабинет ведёт в него из заявки (фича 007).
    chatId: r.chat_id,
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

  /* ── запросы предложений (019) ───────────────────────────────────── */
  /** Снимки условий и только активная версия ответа текущего подрядчика. */
  app.get('/vendor/offer-requests', { preHandler: app.requireConsent }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    const { rows } = await db().query<{
      id: string
      status: 'open' | 'closed'
      close_reason: string | null
      wedding_date: string | null
      guests: number | null
      city: string | null
      wishes: string | null
      budget_hint: string | null
      currency: string
      created_at: Date
      offer_id: string | null
      offer_kind: 'offer' | 'decline' | null
      offer_package_id: string | null
      offer_title: string | null
      offer_price: string | null
      offer_currency: string | null
      offer_includes: string[] | null
      offer_message: string | null
      offer_valid_until: string | null
    }>(
      `select r.id, r.status, r.close_reason, r.wedding_date::text as wedding_date,
              r.guests, r.city, r.wishes, r.budget_hint::text as budget_hint,
              r.currency, r.created_at,
              o.id as offer_id, o.kind as offer_kind, o.package_id as offer_package_id,
              o.title as offer_title, o.price::text as offer_price,
              o.currency as offer_currency, o.includes as offer_includes,
              o.message as offer_message, o.valid_until::text as offer_valid_until
         from offer_requests r
         left join lateral (
           select id, request_id, kind, package_id, title, price, currency,
                  includes, message, valid_until
             from offers
            where request_id = r.id and superseded_at is null
            limit 1
         ) o on true
        where r.vendor_id = $1
        order by r.created_at desc, r.id desc`,
      [vendorId],
    )

    // Bare array: кабинет не видит ни других кандидатов, ни их ответов.
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      ...(row.close_reason === null ? {} : { closeReason: row.close_reason }),
      weddingDate: row.wedding_date,
      guests: row.guests,
      city: row.city,
      wishes: row.wishes,
      createdAt: row.created_at.toISOString(),
      ...(row.budget_hint === null
        ? {}
        : { budgetHint: { amount: Number(row.budget_hint), currency: row.currency } }),
      ...(row.offer_id === null
        ? {}
        : {
            offer: toOffer({
              id: row.offer_id,
              request_id: row.id,
              kind: row.offer_kind!,
              package_id: row.offer_package_id,
              title: row.offer_title,
              price: row.offer_price,
              currency: row.offer_currency!,
              includes: row.offer_includes!,
              message: row.offer_message,
              valid_until: row.offer_valid_until,
            }),
          }),
    }))
  })

  app.post(
    '/vendor/offer-requests/:requestId/offers',
    {
      preHandler: app.requireConsent,
      schema: {
        params: {
          type: 'object',
          required: ['requestId'],
          additionalProperties: false,
          properties: { requestId: UUID_ID },
        },
        body: ref('OfferInput'),
      },
    },
    async (request, reply) => {
      const { requestId } = request.params as { requestId: string }
      const body = request.body as OfferInput

      /* Replay идёт до проверок статуса, анкеты и квоты: после
       * успеха запрос могли закрыть, а пятая версия — заполнить квоту;
       * оба события не отменяют уже сохранённый ответ. */
      return withIdempotency(db(), request, reply, 'vendor.offer-response', (tx) =>
        tx(async (client) => {
          /* Запрос FOR UPDATE сериализует ответы, будущий accept, квоту
           * и смену активной версии. Сам offer здесь не запираем: правка
           * анкеты сначала держит vendor, а удаление пакета через FK
           * SET NULL обновляет offer; замок offer перед vendor дал бы deadlock. */
          const { rows: requests } = await client.query<{
            status: 'open' | 'closed'
            vendor_id: string
            slot_id: string
            wedding_id: string
            wedding_tz: string | null
            default_valid_until: string
          }>(
            `select r.status, r.vendor_id, r.slot_id, s.wedding_id,
                    w.tz as wedding_tz,
                    ((now() at time zone coalesce(w.tz, 'Europe/Moscow'))::date + 7)::text
                      as default_valid_until
               from offer_requests r
               join vendors owner on owner.id = r.vendor_id and owner.user_id = $2
               join slots s on s.id = r.slot_id
               join weddings w on w.id = s.wedding_id
              where r.id = $1
              for update of r`,
            [requestId, request.caller!.userId],
          )
          const offerRequest = requests[0]
          // Чужой и несуществующий UUID неразличимы: никакого оракула чужих запросов.
          if (!offerRequest) throw notFound('Запрос не найден')

          const { rows: activeRows } = await client.query<{ id: string; accepted_at: Date | null }>(
            `select id, accepted_at from offers
              where request_id = $1 and superseded_at is null`,
            [requestId],
          )
          const active = activeRows[0] ?? null
          if (offerRequest.status !== 'open' || active?.accepted_at) {
            throw conflict('request_closed', 'Запрос уже закрыт')
          }

          const { rows: vendors } = await client.query<{
            published_at: Date | null
            blocked_at: Date | null
            deleted_at: Date | null
          }>(
            `select v.published_at, v.blocked_at, u.deleted_at
               from vendors v join users u on u.id = v.user_id
              where v.id = $1 and v.user_id = $2
              for share of v, u`,
            [offerRequest.vendor_id, request.caller!.userId],
          )
          const vendor = vendors[0]
          if (!vendor || !vendor.published_at || vendor.blocked_at || vendor.deleted_at) {
            throw conflict('vendor_unavailable', 'Анкета недоступна')
          }

          const { rows: usageRows } = await client.query<{ n: number; retry_after: number | null }>(
            `select count(*)::int as n,
                    greatest(1, least(86400,
                      ceil(extract(epoch from
                        (min(created_at) + interval '24 hours' - now())))::int
                    )) as retry_after
               from offers
              where request_id = $1 and created_at > now() - interval '24 hours'`,
            [requestId],
          )
          const usage = usageRows[0]!
          if (usage.n >= 5) {
            throw new TooManyRequests(
              usage.retry_after ?? 86_400,
              'На один запрос можно отправить не более пяти версий за 24 часа',
              'offer_revisions_limit',
            )
          }

          let packageId: string | null = null
          let packageSnapshot: Record<string, unknown> | null = null
          let title: string | null = null
          let price: number | null = null
          let includes: string[] = []
          let message: string | null
          let validUntil: string | null = null

          if (body.kind === 'decline') {
            message = body.message.trim()
            if (!message) throw validationFailed({ message: 'Напишите причину отказа' })
          } else {
            price = body.price.amount
            message = body.message?.trim() || null
            validUntil = body.validUntil ?? offerRequest.default_valid_until
            // Ограничение хранилища не должно выливать как 500 на форматно верную дату.
            if (validUntil < '2000-01-01' || validUntil > '2100-12-31') {
              throw validationFailed({ validUntil: 'Дата должна быть между 2000-01-01 и 2100-12-31' })
            }

            if ('packageId' in body) {
              const { rows: packages } = await client.query<{
                id: string
                name: string
                price: string | null
                currency: string
                items: string[]
              }>(
                `select id, name, price::text as price, currency, items
                   from vendor_packages
                  where id = $1 and vendor_id = $2
                  for key share`,
                [body.packageId, offerRequest.vendor_id],
              )
              const selected = packages[0]
              if (!selected) {
                throw new AppError(422, 'unknown_package', 'Такого пакета у подрядчика нет', {
                  packageId: 'пакет не найден в вашей анкете',
                })
              }
              packageId = selected.id
              title = selected.name
              includes = selected.items
              packageSnapshot = {
                id: selected.id,
                name: selected.name,
                price:
                  selected.price === null
                    ? null
                    : { amount: Number(selected.price), currency: selected.currency },
                includes: selected.items,
              }
            } else {
              title = body.title.trim()
              if (!title) throw validationFailed({ title: 'Введите название предложения' })
              includes = body.includes
            }
          }

          if (active) {
            await client.query('update offers set superseded_at = now() where id = $1', [active.id])
          }

          const id = uuidv7()
          const { rows: inserted } = await client.query<OfferViewRow>(
            `insert into offers (
               id, request_id, kind, package_id, package_snapshot, title, price,
               currency, includes, message, valid_until, created_by)
             values ($1,$2,$3,$4,$5::jsonb,$6,$7,'RUB',$8::jsonb,$9,$10::date,$11)
             returning id, request_id, kind, package_id, title, price::text as price,
                       currency, includes, message, valid_until::text as valid_until`,
            [
              id,
              requestId,
              body.kind,
              packageId,
              packageSnapshot === null ? null : JSON.stringify(packageSnapshot),
              title,
              price,
              JSON.stringify(includes),
              message,
              validUntil,
              request.caller!.userId,
            ],
          )

          // Только пара; ни помощникам, ни координатору деньги и тексты не уходят.
          await notifyCoupleOfferEvent(
            client,
            offerRequest.wedding_id,
            offerRequest.slot_id,
            offerRequest.wedding_tz,
            body.kind,
          )
          return { status: 201, body: toOffer(inserted[0]!) }
        }),
      )
    },
  )

  /* ── обновления от пар (§13.2) ───────────────────────────── */
  /**
   * Короткий список того, что надо учесть по забронированным свадьбам:
   * пересчитать порции, переставить технику или приехать к другому часу.
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
                      where w.id = l.wedding_id) as city,
                    (select ch.id from chats ch where ch.wedding_id = l.wedding_id and ch.vendor_id = l.vendor_id
                      and ch.kind = 'vendor') as chat_id`,
        [leadId, vendorId, next, HOLD_HOURS],
      )

      /* Ответ подрядчика — сообщение в общий чат, а не отдельная сущность.
       * Иначе у переписки два места хранения и два порядка сортировки.
       *
       * Той же дверью, что `POST /chats/{id}/messages` (`sendChatMessage`):
       * прямая вставка здесь обходила блокировку модератора, предел холодных
       * обращений непроверенного подрядчика, модерацию ссылки в первом
       * сообщении и сторож §18.2, а уведомление собирала своим списком
       * (ERR-0107 → ревью 015). Состояние заявки уже записано выше — отказ
       * сторожа (403/429) откатит только текст, и это честно: заявка
       * переведена, а писать паре подрядчик права не имеет. */
      if (body.text && chatId) {
        await sendChatMessage(app, { chatId, userId: request.caller!.userId, text: body.text })
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
      unknown_payments: number
      hold_alive: boolean
      package_name: string | null
      package_includes: string[] | null
      bus_routes: { id: string; name: string; from: string | null; time: string | null; seats: number; taken: number }[]
      chat_id: string | null
      contract: { id: string; templateCode: string; version: number; status: string; createdAt: string } | null
    }>(
      `select d.id, w.title as couple_name, w.date::text as wedding_date,
              d.price::text as price, d.currency, d.state, d.negotiating_until,
              ${VENDOR_PAID_SUM}::text as paid,
              (select count(*)::int from payments vp
                where vp.deal_id=d.id and vp.status<>'cancelled'
                  and vp.visibility='vendor' and not vp.amount_known) as unknown_payments,
              (d.negotiating_until is not null and d.negotiating_until > now()) as hold_alive,
              coalesce(d.package_title_snapshot, pkg.name) as package_name,
              coalesce(d.package_includes_snapshot, pkg.items) as package_includes,
              /* Чат с парой — по свадьбе и анкете (уникальный ключ kind=vendor). */
              (select c.id from chats c where c.kind = 'vendor' and c.wedding_id = d.wedding_id and c.vendor_id = d.vendor_id) as chat_id,
              /* Последняя редакция договора по сделке — только заголовок:
                 состав полей (паспорта сторон) подрядчику из списка не отдаём. */
              (select json_build_object('id', doc.id, 'templateCode', doc.template_code, 'version', doc.version,
                                        'status', doc.status, 'createdAt', doc.created_at)
                 from documents doc where doc.deal_id = d.id order by doc.version desc, doc.created_at desc limit 1) as contract,
              coalesce((select json_agg(json_build_object(
                          'id', r.id, 'name', r.name, 'from', r.pickup, 'time', left(r.departs::text, 5),
                          'seats', r.seats, 'taken', r.taken)
                        order by r.departs nulls last, r.name)
                   from bus_routes r where r.deal_id = d.id and d.state <> 'cancelled'), '[]'::json) as bus_routes
         from deals d join weddings w on w.id = d.wedding_id
         left join vendor_packages pkg on pkg.id = d.package_id
        where d.vendor_id = $1 and w.archived_at is null
        order by d.created_at desc`,
      [vendorId],
    )

    /* «Ожидается по сделкам» — остаток по открытым броням: цена минус только
     * те известные `payments`, которые пара раскрыла этому подрядчику.
     * private/finance_members сюда не попадают даже косвенно через агрегат.
     * Раньше складывалась цена целиком,
     * и сделка 100 000 ₽ с внесённым авансом 50 000 ₽ показывала «ожидается
     * 100 000 ₽» (D5-08). Закрытые и отменённые в ожидание не входят. */
    const owed = (r: { price: string | null; paid: string }) => Math.max(0, Number(r.price ?? 0) - Number(r.paid))
    const expected = rows.filter((r) => r.state === 'booked' || r.state === 'paid_deposit').reduce((sum, r) => sum + owed(r), 0)

    /* «Недоплата» — остаток по ЗАВЕРШЁННЫМ: работа сдана, а цена платежами
     * не закрыта. В «ожидается» она не входит — это предмет спора, а не
     * ожидания (решение владельца, В7, фича 005); переход в `done` оплат не
     * проверяет, и раньше такой остаток просто исчезал с экрана. Отменённые
     * не считаются: там и работы не было. */
    const shortfall = rows.filter((r) => r.state === 'done').reduce((sum, r) => sum + owed(r), 0)

    return {
      expected: { amount: expected, currency: 'RUB' },
      shortfall: { amount: shortfall, currency: 'RUB' },
      amountIncomplete: rows.some((r) => r.unknown_payments > 0),
      items: rows.map((r) => ({
        id: r.id,
        coupleName: r.couple_name,
        weddingDate: r.wedding_date,
        price: r.price === null ? null : { amount: Number(r.price), currency: r.currency },
        // Что именно продано: неизменяемый снимок сделки; живая витрина — fallback старых строк.
        packageName: r.package_name,
        packageIncludes: r.package_includes,
        state: r.state,
        /* Карточка сделки: новые private/finance_members оплаты не участвуют.
           Для строк до 021 сохраняется прежняя совместимость агрегатов: их
           ретроспективную видимость достоверно восстановить нельзя. */
        paid: { amount: Number(r.paid), currency: r.currency },
        unknownAmountPayments: r.unknown_payments,
        chatId: r.chat_id,
        contract: r.contract,
        /* Срок брони показывается, только пока он не вышел: истёкший снимает
         * ленивый путь на стороне пары и ежечасная задача, а кабинет до этого
         * часа писал «держим до <прошедшее время>» (D5-26б, R-178). */
        holdUntil:
          r.state === 'negotiating' && r.hold_alive ? (r.negotiating_until?.toISOString() ?? null) : null,
        /* Маршруты для гостей по этой сделке (фича 006): перевозчику нужно
         * знать, сколько машин и мест готовить и сколько персон записалось —
         * и только это. Имена и телефоны гостей — данные пары (152-ФЗ), их
         * здесь нет и по контракту быть не должно. Отменённая сделка — не
         * перевозчик: у неё пусто, как у пары `dealId: null`. У сделок вне
         * слота «Транспорт» пусто само собой — привязать маршрут к ним нельзя. */
        busRoutes: r.bus_routes,
      })),
    }
  })

  /* ── видимые подрядчику оплаты его собственной сделки (021) ───── */
  app.get('/vendor/deals/:dealId/payments', {
    preHandler: app.requireConsent,
    schema: { params: { type: 'object', required: ['dealId'], properties: { dealId: UUID_ID } } },
  }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    const { dealId } = request.params as { dealId: string }
    const own = await db().query(`select 1 from deals d join weddings w on w.id=d.wedding_id
      where d.id=$1 and d.vendor_id=$2 and w.archived_at is null`, [dealId, vendorId])
    if (!own.rows[0]) throw notFound('Сделка не найдена')
    const { rows } = await db().query<{
      id:string; kind:string; amount:string|null; status:string; installment_id:string|null; plan_version:number
      payment_method:string; amount_known:boolean; paid_on:string; created_at:Date
      receipts:Array<{id:string;filename:string;mimeType:string;sizeBytes:number;createdAt:string}>
    }>(`select p.id,p.kind,p.amount::text as amount,p.status,p.installment_id,p.plan_version,
          p.payment_method,p.amount_known,p.paid_on::text as paid_on,p.created_at,
          coalesce((select json_agg(json_build_object(
            'id',r.id,'filename',r.filename,'mimeType',r.mime_type,'sizeBytes',r.size_bytes,'createdAt',r.created_at)
            order by r.created_at,r.id) from payment_receipts r where r.payment_id=p.id),'[]'::json) as receipts
        from payments p
        where p.deal_id=$1 and p.visibility='vendor'
        order by p.paid_on desc,p.created_at desc,p.id desc`, [dealId])
    return rows.map(p => ({
      id:p.id,dealId,kind:p.kind,amountKnown:p.amount_known,
      amount:p.amount_known && p.amount!==null ? {amount:Number(p.amount),currency:'RUB'} : null,
      paymentMethod:p.payment_method,visibility:'vendor' as const,paidOn:p.paid_on,status:p.status,
      createdAt:p.created_at.toISOString(),installmentId:p.installment_id,version:p.plan_version,
      receipts:p.receipts,
    }))
  })

  app.get('/vendor/deals/:dealId/payments/:paymentId/receipts/:receiptId/content', {
    preHandler: app.requireConsent,
    schema: { params: { type:'object', required:['dealId','paymentId','receiptId'], properties: {
      dealId:UUID_ID,paymentId:UUID_ID,receiptId:UUID_ID,
    } } },
  }, async (request) => {
    const vendorId = await myVendorId(request.caller!.userId)
    const {dealId,paymentId,receiptId}=request.params as {dealId:string;paymentId:string;receiptId:string}
    const {rows}=await db().query<{filename:string;mime_type:string;content:Buffer}>(`
      select r.filename,r.mime_type,r.content
        from payment_receipts r
        join payments p on p.id=r.payment_id
        join deals d on d.id=p.deal_id
        join weddings w on w.id=d.wedding_id
       where d.id=$1 and d.vendor_id=$2 and w.archived_at is null
         and p.id=$3 and p.visibility='vendor'
         and r.id=$4 and r.payment_id=p.id and r.wedding_id=d.wedding_id`,
      [dealId,vendorId,paymentId,receiptId])
    const found=rows[0]
    if(!found)throw notFound('Файл не найден')
    return {filename:found.filename,mimeType:found.mime_type,contentBase64:found.content.toString('base64')}
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
            where d.vendor_id = $1 and p.status <> 'cancelled'
              and p.amount_known and (p.visibility = 'vendor' or p.legacy_vendor_visible)`
      const { rows } = await db().query<{
        views: string
        contacts: string
        leads: string
        deals: string
        revenue: string
        prev_revenue: string
        unknown_payments: string
      }>(
        `select
           (select views from vendors where id = $1)::text as views,
           (select count(*) from chats where vendor_id = $1)::text as contacts,
           (select count(*) from leads where vendor_id = $1 and created_at > now() - make_interval(days => $2))::text as leads,
           (select count(*) from deals where vendor_id = $1 and state in ('booked','paid_deposit','done')
             and created_at > now() - make_interval(days => $2))::text as deals,
           (${PAYMENTS_SUM} and p.paid_on > (now() - make_interval(days => $2))::date)::text as revenue,
           (${PAYMENTS_SUM}
             and p.paid_on between (now() - make_interval(days => $2 * 2))::date and (now() - make_interval(days => $2))::date)::text
             as prev_revenue,
           (select count(*) from payments p join deals d on d.id=p.deal_id
             where d.vendor_id=$1 and p.status<>'cancelled' and p.visibility='vendor' and not p.amount_known
               and p.paid_on > (now() - make_interval(days => $2))::date)::text as unknown_payments`,
        [vendorId, days],
      )
      const row = rows[0]!
      const revenue = Number(row.revenue)
      const previous = Number(row.prev_revenue)
      return {
        period,
        revenue: { amount: revenue, currency: 'RUB' },
        revenueIncomplete: Number(row.unknown_payments) > 0,
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
        /* Тело — схема контракта `VerificationSubmit` (фича 014): одна на
         * контракт и обработчик. Правило `https` живёт в ней: ссылка
         * открывается сотрудником в новой вкладке из карточки заявки, и
         * `http`, `javascript:` или `file:` были бы не документом, а тем, что
         * подсунули сотруднику. Раньше схема тела была объявлена в самом пути,
         * `ref()` до неё не доставал, и правила жили второй копией здесь. */
        body: ref('VerificationSubmit'),
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

      try {
        await db().query(
          'insert into vendor_verifications (id, vendor_id, kind, file_url, inn) values ($1,$2,$3,$4,$5)',
          [uuidv7(), vendorId, body.kind, body.fileUrl, body.inn ?? null],
        )
      } catch (error) {
        /* Два нажатия одновременно проходят проверку выше оба; «одна заявка
         * на проверке» держит частичный уникальный индекс (фича 005), и
         * второму приходит тот же 409, а не 500. */
        if (isUniqueViolation(error)) throw conflict('verification_pending', 'Заявка уже на проверке')
        throw error
      }
      // Документ наружу не выходит никогда — в ответе только факт подачи.
      return reply.code(201).send({ status: 'pending' })
    },
  )
}
