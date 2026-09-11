import type { FastifyInstance } from 'fastify'
import { AppError, conflict, gone, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import { plural } from '../text/plural.js'
import type { Queryable } from '../plugins/db.js'
import { guestByToken, newGuestToken, newShareCode } from '../guests/access.js'
import type { Role } from '../wedding/access.js'

const SHARE_TTL_DAYS = 30

/**
 * Сколько минут после первого обмена тот же код отдаёт тот же токен.
 *
 * Достаточно, чтобы «Повторить» после потерянного ответа сработало, и мало,
 * чтобы забытая в мессенджере ссылка не открывала гостевую страницу спустя
 * час тому, кто её нашёл.
 */
const REDEEM_RETRY_MINUTES = 10

interface GuestRow {
  id: string
  name: string
  plus_one: boolean
  group_name: string | null
  phone: string | null
  rsvp: string
  table_id: string | null
  diet: string | null
  diet_note: string | null
  menu_option_id: string | null
  transfer: string | null
  bus_id: string | null
  hotel_id: string | null
  invite_code: string | null
  invite_used: boolean | null
}

const GUEST_COLUMNS = `
  g.id, g.name, g.plus_one, g.group_name, g.phone, g.rsvp, g.table_id, g.diet, g.diet_note,
  g.menu_option_id, g.transfer,
  (select b.bus_id from bus_bookings b where b.guest_id = g.id limit 1) as bus_id,
  (select h.hotel_id from hotel_bookings h where h.guest_id = g.id limit 1) as hotel_id,
  (select c.code from guest_invite_codes c where c.guest_id = g.id and c.used_at is null
    order by c.issued_at desc limit 1) as invite_code,
  (select true from guest_invite_codes c where c.guest_id = g.id and c.used_at is not null limit 1) as invite_used`

/**
 * Гость в форме контракта.
 *
 * `rsvp_token` в выборке отсутствует физически: колонка не читается ни одним
 * запросом пары. Наружу идёт только одноразовая ссылка (ERR-0019).
 *
 * Саму ссылку видит ТОЛЬКО пара. Одноразовый код — не сведения о госте,
 * а ключ: кто его видит, тот обменивает его на токен гостя и дальше
 * действует от его имени — смотрит и резервирует подарки, снимает чужие
 * резервы, грузит кадры в альбом, а у настоящего гостя ссылка перестаёт
 * работать. Ровно поэтому выдача ссылки закрыта для помощника отдельным
 * правилом матрицы (решение владельца 2026-09-03), но список гостей отдавал
 * все уже выданные ссылки всей команде — и правило обходилось соседним
 * маршрутом (ERR-0103).
 *
 * `inviteUrlUsed` остаётся всем: «ссылка использована» — это состояние
 * приглашения, а не ключ, и команде оно нужно, чтобы вести список.
 */
export function toGuest(r: GuestRow, seesInviteUrl: boolean) {
  return {
    id: r.id,
    name: r.name,
    plusOne: r.plus_one,
    group: r.group_name,
    /* Телефон вводит пара ради `POST …/guests/remind`; без него в ответе
     * команда не видит, кому напоминание не уйдёт, и не может поправить
     * опечатку. Гостевые пути (`/rsvp`, `/gifts`) этот объект не отдают. */
    phone: r.phone,
    status: r.rsvp,
    tableId: r.table_id,
    diet: r.diet,
    dietNote: r.diet_note,
    menuOptionId: r.menu_option_id,
    transfer: r.transfer,
    busId: r.bus_id,
    hotelId: r.hotel_id,
    ...(seesInviteUrl
      ? { inviteUrl: r.invite_code ? `https://tili-tili.ru/i/${r.invite_code}` : null }
      : {}),
    inviteUrlUsed: r.invite_used === true,
  }
}

/** Ссылку показываем только паре — она и есть отправитель приглашения. */
export const seesInviteUrl = (role: Role): boolean => role === 'couple'

/** Персон, а не записей: «Ольга и Денис» с плюс-одним — двое за столом. */
export function personCount(guests: { status: string; plusOne: boolean }[]): number {
  return guests.filter((g) => g.status === 'yes').reduce((a, g) => a + (g.plusOne ? 2 : 1), 0)
}

export async function guestRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const loadGuest = async (client: Queryable, guestId: string, role: Role) => {
    const { rows } = await client.query<GuestRow>(`select ${GUEST_COLUMNS} from guests g where g.id = $1`, [guestId])
    return rows[0] ? toGuest(rows[0], seesInviteUrl(role)) : null
  }

  /* ── список и добавление ──────────────────────────────────────────── */
  app.get('/weddings/:weddingId/guests', async (request) => {
    const { rows } = await db().query<GuestRow>(
      `select ${GUEST_COLUMNS} from guests g where g.wedding_id = $1 order by g.created_at`,
      [request.member!.weddingId],
    )
    return rows.map((r) => toGuest(r, seesInviteUrl(request.member!.role)))
  })

  app.post(
    '/weddings/:weddingId/guests',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            plusOne: { type: 'boolean', default: false },
            group: { type: 'string', maxLength: 120 },
            phone: { type: 'string', maxLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; plusOne?: boolean; group?: string; phone?: string }
      const id = uuidv7()
      await db().query(
        `insert into guests (id, wedding_id, name, plus_one, group_name, phone, rsvp_token)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          request.member!.weddingId,
          body.name,
          body.plusOne ?? false,
          body.group ?? null,
          body.phone ?? null,
          newGuestToken(),
        ],
      )
      return reply.code(201).send(await loadGuest(db(), id, request.member!.role))
    },
  )

  app.patch(
    '/weddings/:weddingId/guests/:guestId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            plusOne: { type: 'boolean' },
            status: { type: 'string', enum: ['yes', 'no', 'pending'] },
            /* `null` снимает группу — контракт (`Guest.group: nullable`) это
             * обещает, а без `nullable` AJV приводил `null` к пустой строке,
             * и «без группы» записывалось как группа с пустым именем. */
            group: { type: 'string', nullable: true, maxLength: 120 },
            // `null` стирает номер — гость попросил не писать ему (R-17).
            phone: { type: 'string', nullable: true, maxLength: 32 },
            // Стол уходит в колонку uuid; `null` снимает рассадку (R-17).
            tableId: { ...UUID_ID, nullable: true },
            diet: {
              type: 'string',
              nullable: true,
              enum: [null, 'vegetarian', 'vegan', 'halal', 'kosher', 'gluten_free', 'other'],
            },
            dietNote: { type: 'string', nullable: true, maxLength: 300 },
            transfer: { type: 'string', nullable: true, enum: [null, 'need', 'own'] },
          },
        },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      const { guestId } = request.params as { guestId: string }
      const body = request.body as Record<string, unknown>
      if (!isUuid(guestId)) throw notFound('Гость не найден')

      // `undefined` — поле не прислали, оставить как есть. Явный `null` —
      // снять значение (R-17): пропуск и очистка это разные намерения.
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)

      /* Правка гостя, посадка и освобождение мест — одна транзакция (R-122):
       * «не придёт» с сиденьем в автобусе, оставшимся за гостем, — состояние,
       * которого не бывает в норме. */
      return db().tx(async (client) => {
        if (body.tableId) {
          /* Стол обязан принадлежать этой же свадьбе: иначе гость садится
           * за чужой стол и портит чужую рассадку. Строка стола под
           * блокировкой: два одновременных «посадить» за последнее место
           * иначе оба прошли бы проверку вместимости (R-49). */
          const { rows: table } = await client.query<{ name: string; capacity: number }>(
            'select name, capacity from tables where id = $1 and wedding_id = $2 for update',
            [body.tableId, weddingId],
          )
          if (table.length === 0) throw notFound('Стол не найден')

          /* Вместимость считается в персонах, а не в записях (R-29): «Ольга
           * и Денис» с плюс-одним — двое за столом, как их считает кейтеринг
           * на соседнем экране. Сам гость исключается из уже сидящих (он мог
           * пересаживаться в пределах этого же стола) и добавляется с тем
           * `plusOne`, который придёт вместе с посадкой. */
          const { rows: seated } = await client.query<{ persons: string; plus_one: boolean | null }>(
            `select coalesce(sum(1 + o.plus_one::int) filter (where o.id <> $3), 0)::text as persons,
                    bool_or(o.plus_one) filter (where o.id = $3) as plus_one
               from guests o
              where o.wedding_id = $2 and (o.table_id = $1 or o.id = $3)`,
            [body.tableId, weddingId, guestId],
          )
          if (seated[0]!.plus_one === null) throw notFound('Гость не найден')
          const plusOne = has('plusOne') ? Boolean(body.plusOne) : seated[0]!.plus_one
          const total = Number(seated[0]!.persons) + (plusOne ? 2 : 1)
          const { capacity, name } = table[0]!
          if (total > capacity) {
            throw conflict(
              'table_full',
              `За столом «${name}» ${capacity} ${plural(capacity, 'место', 'места', 'мест')}, а с этим гостем сидело бы ${total}`,
            )
          }
        }

        const res = await client.query(
          `update guests set
             name = coalesce($3, name),
             plus_one = coalesce($4, plus_one),
             rsvp = coalesce($5, rsvp),
             group_name = case when $6 then $7 else group_name end,
             table_id = case when $8 then $9::uuid else table_id end,
             diet = case when $10 then $11 else diet end,
             diet_note = case when $12 then $13 else diet_note end,
             transfer = case when $14 then $15 else transfer end,
             phone = case when $16 then $17 else phone end
           where id = $1 and wedding_id = $2`,
          [
            guestId,
            weddingId,
            (body.name as string) ?? null,
            (body.plusOne as boolean) ?? null,
            (body.status as string) ?? null,
            has('group'),
            (body.group as string) ?? null,
            has('tableId'),
            (body.tableId as string) ?? null,
            has('diet'),
            (body.diet as string) ?? null,
            has('dietNote'),
            (body.dietNote as string) ?? null,
            has('transfer'),
            (body.transfer as string) ?? null,
            has('phone'),
            (body.phone as string) ?? null,
          ],
        )
        if (res.rowCount === 0) throw notFound('Гость не найден')

        /* «Не придёт», поставленное рукой пары («бабушка без смартфона»,
         * План §19.5), освобождает автобус и номер так же, как ответ самого
         * гостя в `POST /rsvp/{t}`: иначе автобус выглядит полным при пустом
         * сиденье (ERR-0040 другим путём). Счётчики поправит триггер. */
        if (body.status === 'no') {
          await client.query(
            `delete from bus_bookings b using bus_routes r
              where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
            [guestId, weddingId],
          )
          await client.query(
            `delete from hotel_bookings b using hotel_blocks h
              where b.hotel_id = h.id and b.guest_id = $1 and h.wedding_id = $2`,
            [guestId, weddingId],
          )
        }

        /* §13.2: изменения рассадки видны подрядчику, чья сделка забронирована.
         * Декоратор расставляет карточки по столам, кейтеринг считает порции —
         * им нужно узнать об этом от нас, а не от пары накануне. */
        if (has('tableId')) {
          const { rows: seated } = await client.query<{ n: string }>(
            'select count(*)::text as n from guests where wedding_id = $1 and table_id is not null',
            [weddingId],
          )
          const n = Number(seated[0]!.n)
          await noteVendorUpdate(
            client,
            weddingId,
            'seating',
            `Рассадка обновлена: за столами ${n} ${plural(n, 'гость', 'гостя', 'гостей')}`,
          )
        }
        return loadGuest(client, guestId, request.member!.role)
      })
    },
  )

  app.delete('/weddings/:weddingId/guests/:guestId', async (request, reply) => {
    const { guestId } = request.params as { guestId: string }
    if (!isUuid(guestId)) throw notFound('Гость не найден')
    const res = await db().query('delete from guests where id = $1 and wedding_id = $2', [
      guestId,
      request.member!.weddingId,
    ])
    if (res.rowCount === 0) throw notFound('Гость не найден')
    return reply.code(204).send()
  })

  /* ── одноразовая ссылка ───────────────────────────────────────────── */
  /**
   * Напоминание тем, кто не ответил.
   *
   * Пара обходила список руками: на полусотне гостей это вечер, и половина
   * забывается. Здесь одно СМС каждому молчащему — с его же личной ссылкой.
   *
   * Ссылка берётся ТА ЖЕ, что уже выдана: перевыпуск гасит токен гостя, а
   * вместе с ним теряется всё, что он выбрал, — резерв подарка в том числе.
   * Поэтому гостю, чья ссылка уже открыта, отсюда не пишут: пара выдаёт ему
   * новую поштучно и осознанно.
   */
  app.post('/weddings/:weddingId/guests/remind', async (request) => {
    const weddingId = request.member!.weddingId

    /* Рассылка стоит денег и приходит чужим людям: не чаще раза в сутки.
     *
     * Захват — одним условным UPDATE, а не «прочитали, проверили, отправили»:
     * два нажатия подряд на плохой связи иначе оба проходили проверку и
     * каждый гость получал два SMS (R-49 про гонки — то же самое). Если
     * отправлять оказалось некому, захват снимается ниже: пара, дописавшая
     * телефоны, не должна ждать сутки. */
    /* Условие — на самой обновляемой строке, а не на присоединённом
     * подзапросе: при параллельном обновлении PostgreSQL перепроверяет
     * условие по новой версии строки только для целевой таблицы, а
     * значения из подзапроса берёт из старого снимка — и второй запрос
     * проходил бы. */
    const claimed = await db().query(
      `update weddings set guests_reminded_at = now()
        where id = $1
          and (guests_reminded_at is null or guests_reminded_at <= now() - interval '24 hours')`,
      [weddingId],
    )
    if (claimed.rowCount === 0) {
      throw new AppError(429, 'too_often', 'Напоминание уходит не чаще раза в сутки — гости получают его лично')
    }

    const { rows: pending } = await db().query<{ id: string; name: string; phone: string | null; code: string | null }>(
      `select g.id, g.name, g.phone,
              (select c.code from guest_invite_codes c
                where c.guest_id = g.id and c.used_at is null and c.expires_at > now()
                order by c.expires_at desc limit 1) as code
         from guests g
        where g.wedding_id = $1 and g.rsvp = 'pending'`,
      [weddingId],
    )

    let sent = 0
    let skippedNoPhone = 0
    let skippedLinkUsed = 0
    for (const guest of pending) {
      if (!guest.phone) {
        skippedNoPhone++
        continue
      }
      if (!guest.code) {
        skippedLinkUsed++
        continue
      }
      try {
        await app.sms.send(
          guest.phone,
          `${guest.name}, напоминаем о свадьбе: ответьте, пожалуйста, придёте ли вы — https://tili-tili.ru/i/${guest.code}`,
        )
        sent++
      } catch {
        // Отказ провайдера на одном номере не должен ронять всю рассылку:
        // остальные гости не виноваты. Ошибка уже в логе отправителя.
        skippedNoPhone++
      }
    }

    if (sent === 0) {
      /* Никому не ушло — суточный запрет не заслужен: снимаем захват. Прежняя
       * отметка либо пуста, либо старше суток — для правила это одно и то же. */
      await db().query('update weddings set guests_reminded_at = null where id = $1', [weddingId])
    }
    return { sent, skippedNoPhone, skippedLinkUsed }
  })

  app.post('/weddings/:weddingId/guests/:guestId/invite-link', async (request) => {
    const weddingId = request.member!.weddingId
    const { guestId } = request.params as { guestId: string }
    if (!isUuid(guestId)) throw notFound('Гость не найден')

    const { rows } = await db().query('select 1 from guests where id = $1 and wedding_id = $2', [guestId, weddingId])
    if (rows.length === 0) throw notFound('Гость не найден')

    return db().tx(async (client) => {
      /* Прежний код гаснет: «выдать новую ссылку» означает, что старая
       * потеряна или ушла не туда.
       *
       * Гаснет он сроком, а не только отметкой `used_at`: у обмена есть
       * окно повтора (`REDEEM_RETRY_MINUTES`), в котором уже использованный
       * код отдаёт токен ещё раз. Перевыпуск закрывает это окно у ВСЕХ
       * прежних кодов гостя — и у неоткрытого, и у открытого минуту назад:
       * ушедшая не туда ссылка не должна выдать ни старый, ни новый токен. */
      await client.query(
        `update guest_invite_codes
            set used_at = coalesce(used_at, now()), expires_at = least(expires_at, now())
          where guest_id = $1 and expires_at > now()`,
        [guestId],
      )

      /* Вместе с кодом гаснет и сам токен.
       *
       * Без этого перевыпуск отдаёт ТОТ ЖЕ токен, и пара, которая ссылку
       * выдаёт, может обменять её сама и открыть гостевую страницу — а там
       * видно, какой подарок этот гость зарезервировал. Анонимность §9
       * рушится молча, гость об этом не узнаёт.
       *
       * Со сменой токена такой обмен выдаёт пустую личность (резервы уходят
       * по триггеру), а у настоящего гостя ссылка перестаёт работать — он
       * попросит новую, и подмена станет видна. */
      const { rows: prev } = await client.query<{ rsvp_token: string }>(
        'select rsvp_token from guests where id = $1 for update',
        [guestId],
      )
      const fresh = newGuestToken()
      await client.query('update guests set rsvp_token = $2 where id = $1', [guestId, fresh])
      /* Отзыв гостя ключуется его токеном («один отзыв на подрядчика на
       * гостя» — уникальный индекс по `(guest_token, vendor_id)`), и без
       * переноса новый токен писал бы второй отзыв о том же подрядчике, а
       * оба шли бы в рейтинг: пара, которая сама выпускает ссылки, множила
       * бы гостевые голоса без предела (D3-09/D5-04). Отзыв едет за гостем,
       * как ехали бы резервы, если бы их не снимал триггер. */
      await client.query('update reviews set guest_token = $2 where guest_token = $1', [prev[0]!.rsvp_token, fresh])
      let code = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        code = newShareCode()
        const res = await client.query(
          `insert into guest_invite_codes (code, guest_id, expires_at)
           values ($1, $2, greatest(now(), (select coalesce(date::timestamptz, now()) from weddings where id = $3))
                   + ($4 || ' days')::interval)
           on conflict (code) do nothing`,
          [code, guestId, weddingId, String(SHARE_TTL_DAYS)],
        )
        if (res.rowCount === 1) break
        code = ''
      }
      if (!code) throw new AppError(503, 'code_collision', 'Не удалось выдать ссылку, попробуйте ещё раз')

      const { rows: saved } = await client.query<{ expires_at: Date }>(
        'select expires_at from guest_invite_codes where code = $1',
        [code],
      )
      return { url: `https://tili-tili.ru/i/${code}`, expiresAt: saved[0]!.expires_at.toISOString() }
    })
  })

  app.get('/invite/:shareCode', async (request) => {
    const { shareCode } = request.params as { shareCode: string }
    /* Гашение и выдача — один оператор, чтобы код нельзя было обменять
     * второй раз спустя время.
     *
     * Но не «ровно один раз»: обмен — GET, который гасит код до ответа, а
     * ответ теряется на мобильной сети или обрывается таймаутом клиента.
     * Тогда токен получил никто, а «Повторить» упиралось в 410 — ссылка
     * сгорала впустую (D3-07). Поэтому тот же код в окне после первого
     * обмена отдаёт тот же токен: отметка `used_at` не двигается, окно
     * считается от неё. Позже окна — 410, как и раньше; перевыпуск ссылки
     * закрывает окно немедленно (см. `invite-link`). */
    const claimed = await db().query<{ guest_id: string }>(
      `update guest_invite_codes set used_at = coalesce(used_at, now())
        where code = $1 and expires_at > now()
          and (used_at is null or used_at > now() - make_interval(mins => $2))
        returning guest_id`,
      [shareCode.toUpperCase(), REDEEM_RETRY_MINUTES],
    )
    if (claimed.rowCount === 0) {
      throw gone('Ссылка недействительна: уже использована или истекла — попросите пару прислать новую')
    }
    const { rows } = await db().query<{
      name: string
      token: string
      title: string
      date: string | null
      city: string | null
      region: string | null
      invite_text: string | null
      invite_theme_id: number
      venue: string | null
    }>(
      `select g.name, g.rsvp_token as token, w.title, w.date::text as date,
              c.name as city, c.region, w.invite_text, w.invite_theme_id, w.venue
         from guests g join weddings w on w.id = g.wedding_id
         left join cities c on c.id = w.city_id
        where g.id = $1`,
      [claimed.rows[0]!.guest_id],
    )
    const g = rows[0]!
    return {
      guestToken: g.token,
      guestName: g.name,
      wedding: {
        title: g.title,
        date: g.date,
        city: g.city ? { name: g.city, region: g.region } : null,
        inviteText: g.invite_text,
        inviteThemeId: g.invite_theme_id,
        venue: g.venue,
      },
    }
  })

  /* ── RSVP по токену ───────────────────────────────────────────────── */
  app.get('/rsvp/:guestToken', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestByToken(db(), guestToken)
    const { rows } = await db().query<{
      rsvp: string
      plus_one: boolean
      diet: string | null
      diet_note: string | null
      transfer: string | null
      title: string
      date: string | null
      city: string | null
      region: string | null
      invite_text: string | null
      invite_theme_id: number
      venue: string | null
      dress_code: string | null
      dress_note: string | null
    }>(
      `select g.rsvp, g.plus_one, g.diet, g.diet_note, g.transfer,
              w.title, w.date::text as date, c.name as city, c.region,
              w.invite_text, w.invite_theme_id, w.venue, w.dress_code, w.dress_note
         from guests g join weddings w on w.id = g.wedding_id
         left join cities c on c.id = w.city_id
        where g.id = $1`,
      [guest.guestId],
    )
    const r = rows[0]!
    return {
      guestName: guest.name,
      status: r.rsvp,
      /* Свой ответ целиком (v0.25): гость видит, что уже выбрал, и может
         поправить, а не отвечать вслепую поверх старого. */
      plusOne: r.plus_one,
      diet: r.diet,
      dietNote: r.diet_note,
      transfer: r.transfer,
      wedding: {
        title: r.title,
        date: r.date,
        city: r.city ? { name: r.city, region: r.region } : null,
        inviteText: r.invite_text,
        inviteThemeId: r.invite_theme_id,
        venue: r.venue,
        /* Дресс-код видит гость — ради него он и заводится (План ч. 976). */
        dressCode: r.dress_code,
        dressNote: r.dress_note,
      },
    }
  })

  app.post(
    '/rsvp/:guestToken',
    {
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['yes', 'no'] },
            plusOne: { type: 'boolean' },
            comment: { type: 'string', maxLength: 1000 },
            diet: {
              type: 'string',
              nullable: true,
              enum: [null, 'vegetarian', 'vegan', 'halal', 'kosher', 'gluten_free', 'other'],
            },
            dietNote: { type: 'string', maxLength: 300 },
            transfer: { type: 'string', enum: ['need', 'own'] },
          },
        },
      },
    },
    async (request) => {
      const { guestToken } = request.params as { guestToken: string }
      const body = request.body as Record<string, unknown>
      const guest = await guestByToken(db(), guestToken)

      /* Ответ и освобождение мест — одна транзакция (R-122): «не приду»
       * с сиденьем, оставшимся за гостем, — состояние, которого не бывает
       * в норме, а до 2026-09-06 сбой между запросами его давал. */
      /* Еда: присланный `null` — это «без ограничений», а не «не трогать».
       * Через `coalesce` гость, однажды выбравший «веган», не мог вернуться к
       * обычному меню: контракт разрешает null, обработчик его глотал. */
      const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key)
      await db().tx(async (client) => {
        await client.query(
          `update guests set rsvp = $2, rsvp_at = now(),
                  plus_one = coalesce($3, plus_one),
                  comment = coalesce($4, comment),
                  diet = case when $5 then $6 else diet end,
                  diet_note = case when $7 then $8 else diet_note end,
                  transfer = coalesce($9, transfer)
            where id = $1`,
          [
            guest.guestId,
            body.status,
            (body.plusOne as boolean) ?? null,
            (body.comment as string) ?? null,
            has('diet'),
            (body.diet as string) ?? null,
            has('diet') || has('dietNote'),
            (body.dietNote as string) ?? null,
            (body.transfer as string) ?? null,
          ],
        )
        // «Не приду» — значит держать под него сиденье и номер незачем.
        // Счётчики поправит триггер: он считает по факту строк.
        if (body.status === 'no') {
          await client.query(
            `delete from bus_bookings b using bus_routes r
              where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
            [guest.guestId, guest.weddingId],
          )
          await client.query(
            `delete from hotel_bookings b using hotel_blocks h
              where b.hotel_id = h.id and b.guest_id = $1 and h.wedding_id = $2`,
            [guest.guestId, guest.weddingId],
          )
        }

        /* Гостевые счётчики — тоже новость для подрядчика (§13.2):
         * кейтеринг закупает по числу «приду», и разница в десять человек
         * это разница в закупке, а не в таблице. */
        const { rows: counters } = await client.query<{ yes: string }>(
          "select count(*)::text as yes from guests where wedding_id = $1 and rsvp = 'yes'",
          [guest.weddingId],
        )
        await noteVendorUpdate(client, guest.weddingId, 'guests', `Гостей «приду»: ${counters[0]!.yes}`)
      })

      // Ответ гостю — без чужих данных: он видит только себя.
      return { status: body.status, guestName: guest.name }
    },
  )

  /* ── рассадка ─────────────────────────────────────────────────────── */
  app.get('/weddings/:weddingId/tables', async (request) => {
    const weddingId = request.member!.weddingId
    const { rows: tables } = await db().query<{ id: string; name: string; capacity: number }>(
      'select id, name, capacity from tables where wedding_id = $1 order by sort, name',
      [weddingId],
    )
    const { rows: guests } = await db().query<{ id: string; table_id: string | null; name: string }>(
      'select id, table_id, name from guests where wedding_id = $1 order by created_at',
      [weddingId],
    )
    return tables.map((t) => ({
      id: t.id,
      name: t.name,
      capacity: t.capacity,
      // Состав стола вычисляется из назначений, а не хранится вторым списком:
      // хранимый список расходится с назначениями, и человек оказывается
      // за двумя столами сразу (ERR-0016, R-30).
      guestIds: guests.filter((g) => g.table_id === t.id).map((g) => g.id),
    }))
  })

  app.post(
    '/weddings/:weddingId/tables',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            capacity: { type: 'integer', minimum: 1, maximum: 100, default: 8 },
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const body = (request.body ?? {}) as { name?: string; capacity?: number }
      const { rows: last } = await db().query<{ n: number }>(
        'select coalesce(max(sort), -1) + 1 as n from tables where wedding_id = $1',
        [weddingId],
      )
      const sort = last[0]!.n
      const id = uuidv7()
      await db().query('insert into tables (id, wedding_id, name, capacity, sort) values ($1,$2,$3,$4,$5)', [
        id,
        weddingId,
        body.name ?? `Стол ${sort + 1}`,
        body.capacity ?? 8,
        sort,
      ])
      const { rows } = await db().query<{ id: string; name: string; capacity: number }>(
        'select id, name, capacity from tables where id = $1',
        [id],
      )
      return reply.code(201).send({ ...rows[0]!, guestIds: [] })
    },
  )
}
