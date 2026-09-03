import type { FastifyInstance } from 'fastify'
import { AppError, conflict, gone, notFound } from '../errors.js'
import { uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { guestByToken, newGuestToken, newShareCode } from '../guests/access.js'

const SHARE_TTL_DAYS = 30

interface GuestRow {
  id: string
  name: string
  plus_one: boolean
  group_name: string | null
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
  g.id, g.name, g.plus_one, g.group_name, g.rsvp, g.table_id, g.diet, g.diet_note,
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
 */
function toGuest(r: GuestRow) {
  return {
    id: r.id,
    name: r.name,
    plusOne: r.plus_one,
    group: r.group_name,
    status: r.rsvp,
    tableId: r.table_id,
    diet: r.diet,
    dietNote: r.diet_note,
    menuOptionId: r.menu_option_id,
    transfer: r.transfer,
    busId: r.bus_id,
    hotelId: r.hotel_id,
    inviteUrl: r.invite_code ? `https://tili-tili.ru/i/${r.invite_code}` : null,
    inviteUrlUsed: r.invite_used === true,
  }
}

/** Персон, а не записей: «Ольга и Денис» с плюс-одним — двое за столом. */
export function personCount(guests: { status: string; plusOne: boolean }[]): number {
  return guests.filter((g) => g.status === 'yes').reduce((a, g) => a + (g.plusOne ? 2 : 1), 0)
}

export async function guestRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  const loadGuest = async (client: Queryable, guestId: string) => {
    const { rows } = await client.query<GuestRow>(`select ${GUEST_COLUMNS} from guests g where g.id = $1`, [guestId])
    return rows[0] ? toGuest(rows[0]) : null
  }

  /* ── список и добавление ──────────────────────────────────────────── */
  app.get('/weddings/:weddingId/guests', async (request) => {
    const { rows } = await db().query<GuestRow>(
      `select ${GUEST_COLUMNS} from guests g where g.wedding_id = $1 order by g.created_at`,
      [request.member!.weddingId],
    )
    return rows.map(toGuest)
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
      return reply.code(201).send(await loadGuest(db(), id))
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
            group: { type: 'string', maxLength: 120 },
            tableId: { type: 'string', nullable: true },
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
      if (!/^[0-9a-f-]{36}$/i.test(guestId)) throw notFound('Гость не найден')

      if (body.tableId) {
        // Стол обязан принадлежать этой же свадьбе: иначе гость садится
        // за чужой стол и портит чужую рассадку.
        const { rows } = await db().query('select 1 from tables where id = $1 and wedding_id = $2', [
          body.tableId,
          weddingId,
        ])
        if (rows.length === 0) throw notFound('Стол не найден')
      }

      // `undefined` — поле не прислали, оставить как есть. Явный `null` —
      // снять значение (R-17): пропуск и очистка это разные намерения.
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
      const res = await db().query(
        `update guests set
           name = coalesce($3, name),
           plus_one = coalesce($4, plus_one),
           rsvp = coalesce($5, rsvp),
           group_name = case when $6 then $7 else group_name end,
           table_id = case when $8 then $9::uuid else table_id end,
           diet = case when $10 then $11 else diet end,
           diet_note = case when $12 then $13 else diet_note end,
           transfer = case when $14 then $15 else transfer end
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
        ],
      )
      if (res.rowCount === 0) throw notFound('Гость не найден')
      return loadGuest(db(), guestId)
    },
  )

  app.delete('/weddings/:weddingId/guests/:guestId', async (request, reply) => {
    const { guestId } = request.params as { guestId: string }
    if (!/^[0-9a-f-]{36}$/i.test(guestId)) throw notFound('Гость не найден')
    const res = await db().query('delete from guests where id = $1 and wedding_id = $2', [
      guestId,
      request.member!.weddingId,
    ])
    if (res.rowCount === 0) throw notFound('Гость не найден')
    return reply.code(204).send()
  })

  /* ── одноразовая ссылка ───────────────────────────────────────────── */
  app.post('/weddings/:weddingId/guests/:guestId/invite-link', async (request) => {
    const weddingId = request.member!.weddingId
    const { guestId } = request.params as { guestId: string }
    if (!/^[0-9a-f-]{36}$/i.test(guestId)) throw notFound('Гость не найден')

    const { rows } = await db().query('select 1 from guests where id = $1 and wedding_id = $2', [guestId, weddingId])
    if (rows.length === 0) throw notFound('Гость не найден')

    return db().tx(async (client) => {
      // Прежний код гаснет: «выдать новую ссылку» означает, что старая
      // потеряна или ушла не туда.
      await client.query('update guest_invite_codes set used_at = now() where guest_id = $1 and used_at is null', [
        guestId,
      ])

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
      await client.query('update guests set rsvp_token = $2 where id = $1', [guestId, newGuestToken()])
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
    // Гашение и выдача — один оператор: два одновременных перехода
    // по ссылке иначе получили бы токен оба.
    const claimed = await db().query<{ guest_id: string }>(
      `update guest_invite_codes set used_at = now()
        where code = $1 and used_at is null and expires_at > now()
        returning guest_id`,
      [shareCode.toUpperCase()],
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
      title: string
      date: string | null
      city: string | null
      region: string | null
      invite_text: string | null
      invite_theme_id: number
      venue: string | null
    }>(
      `select g.rsvp, w.title, w.date::text as date, c.name as city, c.region,
              w.invite_text, w.invite_theme_id, w.venue
         from guests g join weddings w on w.id = g.wedding_id
         left join cities c on c.id = w.city_id
        where g.id = $1`,
      [guest.guestId],
    )
    const r = rows[0]!
    return {
      guestName: guest.name,
      status: r.rsvp,
      wedding: {
        title: r.title,
        date: r.date,
        city: r.city ? { name: r.city, region: r.region } : null,
        inviteText: r.invite_text,
        inviteThemeId: r.invite_theme_id,
        venue: r.venue,
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

      await db().query(
        `update guests set rsvp = $2,
                plus_one = coalesce($3, plus_one),
                comment = coalesce($4, comment),
                diet = coalesce($5, diet),
                diet_note = coalesce($6, diet_note),
                transfer = coalesce($7, transfer)
          where id = $1`,
        [
          guest.guestId,
          body.status,
          (body.plusOne as boolean) ?? null,
          (body.comment as string) ?? null,
          (body.diet as string) ?? null,
          (body.dietNote as string) ?? null,
          (body.transfer as string) ?? null,
        ],
      )
      // «Не приду» — значит держать под него сиденье и номер незачем.
      // Счётчики поправит триггер: он считает по факту строк.
      if (body.status === 'no') {
        await db().query(
          `delete from bus_bookings b using bus_routes r
            where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
          [guest.guestId, guest.weddingId],
        )
        await db().query(
          `delete from hotel_bookings b using hotel_blocks h
            where b.hotel_id = h.id and b.guest_id = $1 and h.wedding_id = $2`,
          [guest.guestId, guest.weddingId],
        )
      }

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

  void conflict
}
