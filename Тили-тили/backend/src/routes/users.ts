import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { REFRESH_TTL_SECONDS } from '../auth/tokens.js'
import { knownTimeZone } from '../notify/quiet.js'
import { clientIp } from './auth.js'

interface ProfileRow {
  id: string
  name: string | null
  phone: string
  email: string | null
  is_staff: boolean
  lang: string
  tz: string | null
  tasks: boolean
  chats: boolean
  deals: boolean
  tips: boolean
  quiet_from: string
  quiet_to: string
}

/** `22:00:00` из PostgreSQL → `22:00`, как в контракте. */
const hhmm = (t: string) => t.slice(0, 5)

/**
 * Хост push-службы из адреса подписки. Адрес проверен схемой при записи
 * (`https://…`), но строка в базе могла появиться и мимо API — тогда хоста
 * нет, и это честнее, чем 500 на весь список.
 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

function toProfile(r: ProfileRow) {
  return {
    id: r.id,
    name: r.name ?? '',
    phone: r.phone,
    email: r.email,
    /* Признак сотрудника — про себя и только про себя: по нему в меню «Мы»
     * появляется «Админка». Списка сотрудников наружу нет, и настраиваемым
     * признак не сделан: в схеме он readOnly, а в теле PATCH его нет вовсе. */
    isStaff: r.is_staff,
    lang: r.lang.trim(),
    tz: r.tz ?? '',
    push: { tasks: r.tasks, chats: r.chats, deals: r.deals, tips: r.tips },
    quietHours: { from: hhmm(r.quiet_from), to: hhmm(r.quiet_to) },
  }
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const loadProfile = async (userId: string) => {
    const { rows } = await db().query<ProfileRow>(
      `select u.id, u.name, u.phone, u.email, u.is_staff, u.lang, u.tz,
              coalesce(p.tasks, true) as tasks, coalesce(p.chats, true) as chats,
              coalesce(p.deals, true) as deals, coalesce(p.tips, true) as tips,
              coalesce(p.quiet_from, '22:00')::text as quiet_from,
              coalesce(p.quiet_to, '09:00')::text as quiet_to
         from users u left join notification_prefs p on p.user_id = u.id
        where u.id = $1 and u.deleted_at is null`,
      [userId],
    )
    if (!rows[0]) throw notFound('Пользователь не найден')
    return toProfile(rows[0])
  }

  /* ── согласие на обработку ПДн ────────────────────────────────────── */
  app.post(
    '/users/me/consent',
    {
      // Согласие — единственный защищённый путь без проверки согласия:
      // иначе дать его было бы невозможно.
      preHandler: app.requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['policyVersion'],
          properties: {
            policyVersion: { type: 'string', minLength: 1, maxLength: 40 },
            /* «Мне есть 18 лет» — отдельная галочка (план §7): версия документа
             * покрывает текст, возраст — нет. Пишется как есть; отсутствие поля
             * — «не подтверждал», а не отказ: старые клиенты поля не знают. */
            adult: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { policyVersion, adult = false } = request.body as { policyVersion: string; adult?: boolean }
      if (policyVersion !== app.appConfig.policyVersion) {
        // Иначе в базе окажется подпись под редакцией, которой человек не видел.
        throw new AppError(
          409,
          'policy_version_stale',
          `Текст обновился. Перечитайте и подтвердите редакцию ${app.appConfig.policyVersion}.`,
        )
      }
      await db().query(
        'insert into consents (id, user_id, policy_version, ip, adult) values ($1, $2, $3, $4, $5)',
        [uuidv7(), request.caller!.userId, policyVersion, clientIp(request), adult],
      )
      await db().query(
        `insert into audit_log (actor_id, action, entity, entity_id, diff)
         values ($1, 'consent.given', 'user', $1, $2)`,
        [request.caller!.userId, JSON.stringify({ policyVersion, adult })],
      )
      return reply.code(201).send()
    },
  )

  app.delete('/users/me/consent', { preHandler: app.requireAuth }, async (request, reply) => {
    // Отзыв согласия равносилен удалению аккаунта: без согласия обрабатывать
    // данные нельзя, а без данных сервис не работает.
    const userId = request.caller!.userId
    /* Все четыре шага — одной транзакцией.
     *
     * Раздельно они оставляли возможность половинчатого состояния: согласие
     * отозвано, а аккаунт жив. Человек после этого не может пользоваться
     * сервисом (`requireConsent` отвечает 403), его данные не поставлены
     * в очередь на удаление, и повторить отзыв ему нечем — согласия уже нет.
     * Для 152-ФЗ это хуже, чем неудавшийся запрос: тот можно повторить,
     * а зависшее состояние надо чинить руками в базе (ERR-0108). */
    await db().tx(async (client) => {
      await client.query('update consents set withdrawn_at = now() where user_id = $1 and withdrawn_at is null', [
        userId,
      ])
      await client.query('update users set deleted_at = now() where id = $1 and deleted_at is null', [userId])
      await client.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId])
      await client.query(
        `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'consent.withdrawn', 'user', $1)`,
        [userId],
      )
    })
    return reply.code(204).send()
  })

  /* ── профиль ──────────────────────────────────────────────────────── */
  app.get('/users/me', { preHandler: app.requireConsent }, async (request) => loadProfile(request.caller!.userId))

  app.patch(
    '/users/me',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 120 },
            lang: { type: 'string', enum: ['ru', 'en'] },
            tz: { type: 'string', maxLength: 64 },
            push: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tasks: { type: 'boolean' },
                chats: { type: 'boolean' },
                deals: { type: 'boolean' },
                tips: { type: 'boolean' },
              },
            },
            quietHours: {
              type: 'object',
              additionalProperties: false,
              properties: {
                /* Часы 00–23, а не любые две цифры: «25:00» проходило схему и
                 * падало уже в базе на приведении к `time` — 500 вместо 422
                 * (R-111: формат проверяется до базы). */
                from: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
                to: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const userId = request.caller!.userId
      const body = request.body as {
        name?: string
        lang?: string
        tz?: string
        push?: Partial<Record<'tasks' | 'chats' | 'deals' | 'tips', boolean>>
        quietHours?: { from?: string; to?: string }
      }

      /* Зона уходит в расчёт тихих часов и в `AT TIME ZONE`. Мусор там —
       * либо потерянное уведомление, либо ошибка базы; проверка длины
       * от этого не спасает (ERR-0055). */
      if (body.tz !== undefined && knownTimeZone(body.tz) !== body.tz) {
        throw new AppError(422, 'unknown_timezone', 'Неизвестный часовой пояс', {
          tz: 'ожидается зона вида Europe/Moscow',
        })
      }

      // coalesce, а не сборка SQL строками: пропущенное поле остаётся как было,
      // явный null стирает значение (правило R-17 — очистка это null, не пропуск).
      await db().query(
        `update users set name = coalesce($2, name), lang = coalesce($3, lang), tz = coalesce($4, tz)
          where id = $1 and deleted_at is null`,
        [userId, body.name ?? null, body.lang ?? null, body.tz ?? null],
      )

      if (body.push || body.quietHours) {
        await db().query(
          `insert into notification_prefs (user_id) values ($1) on conflict (user_id) do nothing`,
          [userId],
        )
        await db().query(
          `update notification_prefs
              set tasks = coalesce($2, tasks), chats = coalesce($3, chats),
                  deals = coalesce($4, deals), tips = coalesce($5, tips),
                  quiet_from = coalesce($6::time, quiet_from), quiet_to = coalesce($7::time, quiet_to)
            where user_id = $1`,
          [
            userId,
            body.push?.tasks ?? null,
            body.push?.chats ?? null,
            body.push?.deals ?? null,
            body.push?.tips ?? null,
            body.quietHours?.from ?? null,
            body.quietHours?.to ?? null,
          ],
        )
      }

      return loadProfile(userId)
    },
  )

  app.delete('/users/me', { preHandler: app.requireConsent }, async (request, reply) => {
    const userId = request.caller!.userId
    /* Живая сделка держит вторую сторону: у подрядчика занята дата, у пары
     * обещаны деньги. Контракт обещает здесь 409 со списком — до 2026-09-06
     * его не было, и аккаунт с забронированной свадьбой стирался молча,
     * оставляя подрядчику дату, занятую призраком. Сделки свадьбы принадлежат
     * свадьбе, а не человеку: партнёр, уходящий вторым из пары, свадьбу
     * не бросает — держит только последний из «пары». */
    // Мягкое удаление на 30 дней (План §19.1): человек передумывает чаще,
    // чем кажется, а восстановить стёртую свадьбу неоткуда.
    /* Проверка активных сделок — ВНУТРИ этой транзакции, за замком строк
     * `weddings` пары (SA-05, TR-1 §7 FL-9 mechanism (b), ERR-0271 сиблинг):
     * бронь (`POST …/slots/{slotId}/book`, `slots.ts` `weddingDate()`) читает
     * дату свадьбы `for share` внутри своей транзакции — тем же порядком
     * «свадьба → сделка», что и здесь. Раньше проверка шла отдельным чтением
     * ДО транзакции удаления, без единого замка: бронь успевала завестись
     * между проверкой и `update users`, и пара уходила (204) с только что
     * забронированной сделкой на удалённый аккаунт — не увидев её вовсе.
     * `for update` здесь ставит проверку и бронь в очередь друг за другом;
     * READ COMMITTED даёт каждому запросу транзакции свежий снимок, так что
     * проверка, дождавшись своей очереди, видит уже зафиксированную бронь. */
    await db().tx(async (client) => {
      await client.query(
        `select id from weddings
          where id in (select wedding_id from wedding_members where user_id = $1 and role = 'couple')
          for update`,
        [userId],
      )
      /* Своя строка `users` — следом за свадьбами, тем же порядком, что берёт
       * бронь (SA-05, хвост FL-9). Замка на свадьбах хватало только для
       * стороны пары и только в одном порядке: если удаление успевало
       * зафиксироваться первым, уже аутентифицированная бронь всё равно
       * заводила сделку — `slots.ts` не перепроверял `deleted_at` заявителя
       * после `preHandler`. Сторона подрядчика не сериализовалась вовсе:
       * удаление подрядчика вообще не трогает свадьбу, где его бронируют.
       * Порядок «свадьбы → users» одинаков в обеих транзакциях — цикла
       * ожидания нет. */
      await client.query('select 1 from users where id = $1 for update', [userId])
      const { rows: active } = await client.query<{ side: string; title: string }>(
        `select 'vendor' as side, w.title
           from deals d join vendors v on v.id = d.vendor_id join weddings w on w.id = d.wedding_id
          where v.user_id = $1 and d.state in ('booked', 'paid_deposit')
         union all
         select 'couple' as side, coalesce(v.name, d.external_name, '')
           from deals d join weddings w on w.id = d.wedding_id
           left join vendors v on v.id = d.vendor_id
          where d.state in ('booked', 'paid_deposit')
            and w.archived_at is null
            and exists (select 1 from wedding_members m where m.wedding_id = w.id and m.user_id = $1 and m.role = 'couple')
            and not exists (select 1 from wedding_members m2 join users u2 on u2.id = m2.user_id
                             where m2.wedding_id = w.id and m2.user_id <> $1 and m2.role = 'couple' and u2.deleted_at is null)`,
        [userId],
      )
      if (active.length > 0) {
        const names = active.map((r) => r.title).filter(Boolean).slice(0, 5).join(', ')
        throw new AppError(
          409,
          'active_deals',
          `Сначала завершите или отмените сделки (${active.length}): ${names || 'см. раздел «Свадьба»'}`,
        )
      }
      await client.query('update users set deleted_at = now() where id = $1 and deleted_at is null', [userId])
      await client.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId])
      await client.query(
        `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'user.deleted', 'user', $1)`,
        [userId],
      )
    })
    return reply.code(204).send()
  })

  /* ── сессии и устройства ──────────────────────────────────────────── */
  // выход доступен и при согласии под прежней редакцией (F4)
  app.get('/users/me/sessions', { preHandler: app.requireAuth }, async (request) => {
    /* Сессия, не обновлявшаяся дольше срока refresh-токена (30 дней), уже
     * мертва — `POST /auth/refresh` по ней отвечает 401 и гасит её. В списке
     * устройств она стояла бы «живой» до первого такого обмена (ревью 015). */
    const { rows } = await db().query<{ id: string; device: string | null; created_at: Date }>(
      `select id, device, created_at from sessions
        where user_id = $1 and revoked_at is null
          and last_used_at > now() - make_interval(secs => $2)
        order by created_at desc`,
      [request.caller!.userId, REFRESH_TTL_SECONDS],
    )
    return rows.map((r) => ({
      id: r.id,
      device: r.device ?? 'Неизвестное устройство',
      current: r.id === request.caller!.sessionId,
      createdAt: r.created_at.toISOString(),
    }))
  })

  // выход доступен и при согласии под прежней редакцией (F4)
  app.delete('/users/me/sessions', { preHandler: app.requireAuth }, async (request, reply) => {
    // Текущая сессия остаётся: человек нажимает «выйти везде», чтобы выгнать
    // чужого, а не себя. Выгнать себя — это кнопка «выйти».
    await db().query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [
      request.caller!.userId,
      request.caller!.sessionId,
    ])
    return reply.code(204).send()
  })

  app.delete(
    '/users/me/sessions/:sessionId',
    {
      // выход доступен и при согласии под прежней редакцией (F4)
      preHandler: app.requireAuth,
      // `sessions.id` — колонка uuid. Без проверки чужая строка уходит прямо
      // в запрос, драйвер отвечает ошибкой синтаксиса, а обработчик переводит
      // это в 500 с записью в лог как о падении сервера (R-108, R-111).
      schema: { params: { type: 'object', required: ['sessionId'], properties: { sessionId: UUID_ID } } },
    },
    async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string }
      /* Свою текущую сессию этим путём гасить МОЖНО: именно так выходит
       * приложение — «Выйти со всех устройств» гасит чужие списком, а свою
       * последней по идентификатору, потому что до этого ей нужен доступ к
       * самому списку. Ревью D1-19 предлагало 409 для своей сессии; живая
       * проверка выхода показала, что тогда своя сессия оставалась живой на
       * сервере после «выхода» (ERR-0233). Экран устройств свою строку
       * кнопкой «Завершить» не снабжает — это его дело, не сервера. */
      // Условие по user_id обязательно: без него по чужому идентификатору
      // сессии можно выкинуть постороннего человека. Уже погашенная — 404,
      // а не 204 с перезаписью `revoked_at`.
      const res = await db().query(
        'update sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null',
        [sessionId, request.caller!.userId],
      )
      if (res.rowCount === 0) throw notFound('Сессия не найдена')
      return reply.code(204).send()
    },
  )

  /* ── push-подписки: на каких устройствах включён push ─────────────── */
  app.get(
    '/users/me/push-subscriptions',
    {
      preHandler: app.requireConsent,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { endpoint: { type: 'string', minLength: 1, maxLength: 2048 } },
        },
      },
    },
    async (request) => {
      /* Адрес подписки — секрет устройства: push-служба принимает по нему
       * сообщения для этого браузера, и кто его знает, тот и шлёт. Наружу
       * уходит только хост службы (fcm.googleapis.com, web.push.apple.com…),
       * а «своя» подписка узнаётся сверкой с адресом, который прислало само
       * устройство, — как у `DELETE …?endpoint=` (R-232). Снять подписку
       * (свою или все) — тем же `DELETE` в `notifications.ts`; здесь только
       * список для экрана «Настройки» (контракт v0.29.0). */
      const { endpoint } = request.query as { endpoint?: string }
      const { rows } = await db().query<{ id: string; endpoint: string; created_at: Date }>(
        'select id, endpoint, created_at from push_subscriptions where user_id = $1 order by created_at',
        [request.caller!.userId],
      )
      return rows.map((r) => ({
        id: r.id,
        endpointHost: endpointHost(r.endpoint),
        createdAt: r.created_at.toISOString(),
        mine: endpoint !== undefined && r.endpoint === endpoint,
      }))
    },
  )

  /* ── экспорт данных (152-ФЗ) ──────────────────────────────────────── */
  app.get('/users/me/export', { preHandler: app.requireConsent }, async (request) => {
    const userId = request.caller!.userId
    const profile = await loadProfile(userId)
    const { rows: consents } = await db().query(
      'select policy_version, given_at, withdrawn_at from consents where user_id = $1 order by given_at',
      [userId],
    )
    const { rows: sessions } = await db().query(
      'select device, created_at, revoked_at from sessions where user_id = $1 order by created_at',
      [userId],
    )
    /* 152-ФЗ даёт право получить ВСЕ свои данные, а не выборку.
     *
     * Границы выгрузки: отдаём то, что человек внёс сам или что относится
     * лично к нему. НЕ отдаём чужие персональные данные, которые он видит
     * по роли: гостевые токены, тексты чужих сообщений, отзывы других людей.
     * Право на свои данные — не право на данные всех, кто рядом.
     *
     * Архивные (отменённые) свадьбы — тоже данные человека: до уборки они
     * лежат в базе со всем содержимым, и «всё, что принадлежит пользователю»
     * без них было бы неправдой.
     */
    const { rows: weddingRows } = await db().query<{ id: string; role: string; budget_total: string | null }>(
      `select w.id, w.title, w.date::text as date, w.tz, w.style, w.venue,
              w.guests_planned, w.budget_total::text as budget_total, w.currency,
              w.archived_at, w.cancelled_at,
              m.role, m.joined_at, c.name as city, c.region
         from wedding_members m
         join weddings w on w.id = m.wedding_id
         left join cities c on c.id = w.city_id
        where m.user_id = $1 and m.role in ('couple', 'helper', 'coordinator')
        order by m.joined_at`,
      [userId],
    )
    /* Деньги — только по свадьбам, где человек в роли «пара». Помощник и
     * координатор не видят сумм НИГДЕ (§6, матрица доступа закрывает им
     * бюджет, сделки и вишлист) — выгрузка не должна становиться обходом:
     * до 2026-09-11 помощник получал цены всех сделок, платежи и статьи
     * бюджета одним GET (тот же класс, что ERR-0026/ERR-0175). */
    const weddings = weddingRows.map(({ budget_total, ...rest }) =>
      rest.role === 'couple' ? { ...rest, budget_total } : rest,
    )
    const coupleIds = weddings.filter((w) => w.role === 'couple').map((w) => w.id)
    const otherIds = weddings.filter((w) => w.role !== 'couple').map((w) => w.id)

    // Дальше — по свадьбам, где человек состоит. Пустой список свадеб
    // означает пустые выборки, а не выгрузку всей базы.
    const byWeddings = async <T extends Record<string, unknown>>(ids: string[], sql: string): Promise<T[]> => {
      if (ids.length === 0) return []
      const { rows } = await db().query<T>(sql, [ids])
      return rows
    }
    const allIds = [...coupleIds, ...otherIds]

    /* Телефон и комментарий гостя читает только пара (`toGuest`, фича 005/014):
     * помощнику и координатору они не показываются в списке — и выгрузка не
     * должна становиться обходом (ревью 015, тот же класс, что ERR-0026). */
    const guests = [
      ...(await byWeddings(
        coupleIds,
        `select wedding_id, party_id, is_primary, name, phone, rsvp, group_name, diet, diet_note,
                transfer, comment, created_at
           from guests where wedding_id = any($1) order by created_at`,
      )),
      ...(await byWeddings(
        otherIds,
        `select wedding_id, party_id, is_primary, name, rsvp, group_name, diet, diet_note, transfer, created_at
           from guests where wedding_id = any($1) order by created_at`,
      )),
    ]
    const shortlist = await byWeddings(
      coupleIds,
      `select s.wedding_id, sl.slot_id, sl.position, sl.created_at,
              case when sl.vendor_id is null then null else v.name end as vendor_name
         from slot_shortlist sl
         join slots s on s.id = sl.slot_id
         left join vendors v on v.id = sl.vendor_id
        where s.wedding_id = any($1) order by sl.created_at`,
    )
    const offerRequests = await byWeddings(
      coupleIds,
      `select s.wedding_id, r.id, r.slot_id, r.status, r.close_reason, r.wedding_date::text as wedding_date,
              r.guests, r.city, r.wishes, r.budget_hint::text as budget_hint, r.currency, r.created_at, r.closed_at,
              case when r.vendor_id is null then null else v.name end as vendor_name
         from offer_requests r
         join slots s on s.id = r.slot_id
         left join vendors v on v.id = r.vendor_id
        where s.wedding_id = any($1) order by r.created_at`,
    )
    const offerRequestIds = offerRequests.map((r) => r.id as string)
    const offers = offerRequestIds.length === 0 ? [] : (await db().query(
      `select request_id, kind, title, price::text as price, currency, includes, message, valid_until::text as valid_until,
              superseded_at, accepted_at, created_at
         from offers where request_id = any($1::uuid[]) order by created_at`,
      [offerRequestIds],
    )).rows
    const deals = [
      ...(await byWeddings(
        coupleIds,
        `select d.wedding_id, s.label as slot, d.state, d.price::text as price, d.currency,
                coalesce(v.name, d.external_name) as performer, d.created_at, d.booked_at, d.done_at
           from deals d
           join slots s on s.id = d.slot_id
           left join vendors v on v.id = d.vendor_id
          where d.wedding_id = any($1) order by d.created_at`,
      )),
      ...(await byWeddings(
        otherIds,
        `select d.wedding_id, s.label as slot, d.state,
                coalesce(v.name, d.external_name) as performer, d.created_at, d.booked_at, d.done_at
           from deals d
           join slots s on s.id = d.slot_id
           left join vendors v on v.id = d.vendor_id
          where d.wedding_id = any($1) order by d.created_at`,
      )),
    ]
    const payments = await byWeddings(
      coupleIds,
      `select p.id, p.deal_id, p.kind, p.amount::text as amount, p.currency, p.status, p.installment_id, p.created_at
         from payments p join deals d on d.id = p.deal_id
        where d.wedding_id = any($1) order by p.created_at`,
    )
    /* График платежей (018-A) — такие же деньги пары, как оплаты: только по свадьбам,
     * где человек «пара». Без него выгрузка по 152-ФЗ теряла названия, суммы, сроки и
     * причины отмены этапов (ревью 018, P-02). */
    const paymentInstallments = await byWeddings(
      coupleIds,
      `select d.wedding_id, i.id, i.deal_id, i.title, i.amount::text as amount, i.currency, i.due::text as due,
              i.cancelled_at, i.cancel_reason, i.created_at
         from payment_installments i join deals d on d.id = i.deal_id
        where d.wedding_id = any($1) order by i.created_at, i.id`,
    )
    const budget = await byWeddings(
      coupleIds,
      `select wedding_id, title, category_id, amount::text as amount, currency, created_at
         from budget_items where wedding_id = any($1) order by created_at`,
    )
    /* Резерв, лимиты категорий и подтверждения оплат (018-B) — деньги пары, как бюджет:
     * только по свадьбам, где человек «пара». Подтверждения — без содержимого и без
     * автора (чужой идентификатор): файлы скачиваются в приложении по одному, а выгрузка
     * не превращается в десятки мегабайт base64 (ревью 018, BB-06). */
    const budgetSettings = await byWeddings(
      coupleIds,
      `select wedding_id, reserve_bps, version, updated_at
         from wedding_budget_settings where wedding_id = any($1) order by wedding_id`,
    )
    const budgetLimits = await byWeddings(
      coupleIds,
      `select wedding_id, category_id, amount::text as amount, currency, is_custom, version, updated_at
         from budget_category_limits where wedding_id = any($1) order by wedding_id, category_id`,
    )
    const paymentReceipts = await byWeddings(
      coupleIds,
      `select wedding_id, id, payment_id, filename, mime_type, size_bytes, created_at
         from payment_receipts where wedding_id = any($1) order by created_at, id`,
    )
    // Вишлист закрыт для помощника и координатора матрицей (ONLY_COUPLE) — и в выгрузке его нет (ревью 015).
    const gifts = await byWeddings(
      coupleIds,
      `select wedding_id, name, descr, price::text as price, currency, is_group,
              funded::text as funded, created_at
         from gifts where wedding_id = any($1) order by created_at`,
    )
    const tasks = await byWeddings(
      allIds,
      `select wedding_id, title, period, due::text as due, done_at, source
         from tasks where wedding_id = any($1) order by sort`,
    )
    // Приглашения в команду, которые выдал он сам. Кто принял — чужой идентификатор, его нет.
    const { rows: invites } = await db().query(
      `select code, wedding_id, role, label, created_at, expires_at, accepted_at, revoked_at
         from invites where created_by = $1 order by created_at`,
      [userId],
    )
    // Записи журнала сделок, где действовал он: смены статуса и суммы его рукой.
    const { rows: dealEvents } = await db().query(
      `select deal_id, from_state, to_state, kind, note, at
         from deal_events where actor_id = $1 order by at`,
      [userId],
    )

    // Личное, не зависящее от свадьбы.
    const { rows: notifications } = await db().query(
      `select kind, title, body, link, read_at, created_at
         from notifications where user_id = $1 order by created_at`,
      [userId],
    )
    // Только СВОИ сообщения: чужие реплики — чужие персональные данные.
    const { rows: messages } = await db().query(
      `select chat_id, text, created_at from messages where sender_id = $1 order by created_at`,
      [userId],
    )
    /* Отметки «прочитано» — тоже его след: когда он открывал какой чат.
     * Таблица завелась после первой версии выгрузки и в ней не значилась —
     * «все свои данные» без неё были неправдой (фича 014, A12). */
    const { rows: chatReads } = await db().query(
      'select chat_id, read_at from chat_reads where user_id = $1 order by read_at',
      [userId],
    )
    // Заметки, которые написал он (фича 014): чужие заметки команды — чужие слова.
    const { rows: notes } = await db().query(
      'select wedding_id, text, created_at from notes where author_id = $1 order by created_at',
      [userId],
    )
    const { rows: favorites } = await db().query(
      'select vendor_id, created_at from favorites where user_id = $1 order by created_at',
      [userId],
    )
    const { rows: inspirationLikes } = await db().query(
      'select story_id, created_at from inspiration_likes where user_id = $1 order by created_at',
      [userId],
    )
    // Адрес подписки — его устройство; ключи шифрования канала — нет: это не сведения о человеке, а секрет доставки.
    const { rows: pushSubscriptions } = await db().query(
      'select endpoint from push_subscriptions where user_id = $1 order by created_at',
      [userId],
    )
    const { rows: conciergeRequests } = await db().query(
      `select r.category_id, c.name as city, r.budget::text as budget, r.currency, r.comment, r.status, r.created_at
         from concierge_requests r left join cities c on c.id = r.city_id
        where r.user_id = $1 order by r.created_at`,
      [userId],
    )
    /* Жалобы, которые подал он. Внутренняя пометка модератора и санкция,
     * наложенная на третье лицо (`resolution`), — не его данные: в продукте
     * исход жалобы жалобщику не сообщается, и выгрузка не должна становиться
     * единственным каналом узнать, кого предупредили или понизили (RF-BE-07). */
    const { rows: complaints } = await db().query(
      `select target_kind, target_id, category, text, status, created_at, resolved_at
         from complaints where reporter_id = $1 order by created_at`,
      [userId],
    )
    const { rows: referral } = await db().query(
      'select code, created_at from referrals where owner_id = $1',
      [userId],
    )
    // Чужой код, который применил он сам. Кто пришёл по ЕГО коду — чужие люди, их здесь нет.
    const { rows: referralUses } = await db().query(
      `select code, applied_at, earned::text as earned, currency
         from referral_uses where invited_id = $1 order by applied_at`,
      [userId],
    )

    /* Анкета подрядчика — целиком, включая контакты и фото: это он сам её
     * заполнил. Документы верификации — без ссылки на файл: скан паспорта
     * лежит в хранилище по служебному адресу, и выдавать адрес наружу
     * значило бы раздать ключ от него. */
    const { rows: vendor } = await db().query<{ id: string }>(
      `select v.id, v.name, v.about, v.category_id, c.name as city, c.region, v.phone, v.photo_url,
              v.price_from::text as price_from, v.currency, v.years,
              v.published_at, v.verified_at, v.rating::text as rating, v.reviews_count, v.couple_reviews_count,
              v.created_at
         from vendors v left join cities c on c.id = v.city_id where v.user_id = $1`,
      [userId],
    )
    const vendorId = vendor[0]?.id ?? null
    const byVendor = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
      if (!vendorId) return []
      const { rows } = await db().query<T>(sql, [vendorId])
      return rows
    }
    const vendorVerifications = await byVendor(
      'select kind, inn, status, checked_at, created_at from vendor_verifications where vendor_id = $1 order by created_at',
    )
    const vendorPackages = await byVendor(
      'select name, price::text as price, currency, items from vendor_packages where vendor_id = $1 order by sort',
    )
    const vendorMedia = await byVendor('select kind, url, duration_s from vendor_media where vendor_id = $1 order by sort')
    // Только отмеченные им самим дни: занятость по сделкам — производная от сделок пары.
    const vendorOfferRequests = await byVendor(
      `select r.id, r.slot_id, r.status, r.close_reason, r.wedding_date::text as wedding_date, r.guests, r.city,
              r.wishes, r.budget_hint::text as budget_hint, r.currency, r.created_at, r.closed_at
         from offer_requests r where r.vendor_id = $1 order by r.created_at`,
    )
    const vendorRequestIds = vendorOfferRequests.map((r) => r.id as string)
    const vendorOffers = vendorRequestIds.length === 0 ? [] : (await db().query(
      `select request_id, kind, title, price::text as price, currency, includes, message, valid_until::text as valid_until,
              superseded_at, accepted_at, created_at
         from offers where request_id = any($1::uuid[]) order by created_at`,
      [vendorRequestIds],
    )).rows
    const vendorBusyDates = await byVendor(
      `select date::text as date from vendor_busy_dates where vendor_id = $1 and source <> 'deal' order by date`,
    )
    /* Отзывы, написанные им как парой (`m.role = 'couple'` — помощник отзыв не
     * писал и чужой не получает). Отзывы гостей о нём — чужие. Отзыв по
     * убранной свадьбе (`deal_id` → null после уборки, фича 014) автора не
     * помнит — его в выгрузке нет. */
    const { rows: reviews } = await db().query(
      `select r.vendor_id, r.stars, r.text, r.created_at
         from reviews r
         join deals d on d.id = r.deal_id
         join wedding_members m on m.wedding_id = d.wedding_id and m.user_id = $1 and m.role = 'couple'
        where r.source = 'couple' order by r.created_at`,
      [userId],
    )

    return {
      exportedAt: new Date().toISOString(),
      profile,
      consents,
      sessions,
      weddings,
      guests,
      shortlist,
      offerRequests,
      offers,
      deals,
      payments,
      paymentInstallments,
      paymentReceipts,
      budget,
      budgetSettings,
      budgetLimits,
      gifts,
      tasks,
      invites,
      dealEvents,
      notifications,
      messages,
      chatReads,
      notes,
      favorites,
      inspirationLikes,
      pushSubscriptions,
      conciergeRequests,
      complaints,
      referral: referral[0] ?? null,
      referralUses,
      vendorProfile: vendor[0] ?? null,
      vendorVerifications,
      vendorPackages,
      vendorMedia,
      vendorOfferRequests,
      vendorOffers,
      vendorBusyDates,
      reviews,
    }
  })
}
