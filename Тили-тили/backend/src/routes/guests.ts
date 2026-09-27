import type { FastifyInstance } from 'fastify'
import { AppError, conflict, gone, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import { plural } from '../text/plural.js'
import { isCheckViolation, type Queryable } from '../plugins/db.js'
import { guestByToken, newGuestToken, newShareCode } from '../guests/access.js'
import { requireRole, type Role } from '../wedding/access.js'

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
  party_id: string
  is_primary: boolean
  party_size: string
  name: string
  group_name: string | null
  phone: string | null
  comment: string | null
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
  g.id, g.party_id, g.is_primary,
  (select count(*)::text from guests member where member.party_id = g.party_id) as party_size,
  g.name, g.group_name,
  (select p.phone from guests p where p.party_id = g.party_id and p.is_primary limit 1) as phone,
  (select p.comment from guests p where p.party_id = g.party_id and p.is_primary limit 1) as comment,
  g.rsvp, g.table_id, g.diet, g.diet_note, g.menu_option_id, g.transfer,
  (select b.bus_id from bus_bookings b where b.guest_id = g.id limit 1) as bus_id,
  (select h.hotel_id from hotel_bookings h where h.party_id = g.party_id limit 1) as hotel_id,
  (select c.code from guest_invite_codes c where c.party_id = g.party_id and c.used_at is null
    order by c.issued_at desc limit 1) as invite_code,
  (select true from guest_invite_codes c where c.party_id = g.party_id and c.used_at is not null limit 1) as invite_used`

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
 *
 * Телефон и комментарий из RSVP — тоже только паре (фича 005, В6; 152-ФЗ,
 * минимизация): напоминания шлёт пара, а помощнику и координатору сам
 * номер не нужен — им приходит `hasPhone`, чтобы видеть, кому напоминание
 * не уйдёт. Комментарий гость пишет паре, а не команде.
 */
export function toGuest(r: GuestRow, asCouple: boolean) {
  return {
    id: r.id,
    partyId: r.party_id,
    primary: r.is_primary,
    /* Compatibility only: derived from explicit persons, never stored. */
    plusOne: Number(r.party_size) > 1,
    name: r.name,
    group: r.group_name,
    /* Телефон вводит пара ради `POST …/guests/remind`. Гостевые пути
     * (`/rsvp`, `/gifts`) этот объект не отдают. */
    ...(asCouple ? { phone: r.phone, comment: r.comment } : {}),
    hasPhone: Boolean(r.phone),
    status: r.rsvp,
    tableId: r.table_id,
    diet: r.diet,
    dietNote: r.diet_note,
    menuOptionId: r.menu_option_id,
    transfer: r.transfer,
    busId: r.bus_id,
    hotelId: r.hotel_id,
    ...(asCouple ? { inviteUrl: r.invite_code ? `https://tili-tili.ru/i/${r.invite_code}` : null } : {}),
    inviteUrlUsed: r.invite_used === true,
  }
}

/** Ссылку, телефон и комментарий показываем только паре — она отправитель приглашения и адресат ответа. */
export const seesInviteUrl = (role: Role): boolean => role === 'couple'

/**
 * Телефон гостя пишет тот же, кто его читает, — пара (фича 014, A2).
 *
 * Помощник и координатор номер не видят (`hasPhone` вместо него), но до
 * этого могли его записать и перезаписать — вслепую, не зная, что там было.
 * Право писать то, что нельзя прочитать, — не право, а дыра: чужой номер
 * затирается «своим», и напоминание уходит не туда. 403, а не молчаливый
 * пропуск поля: молча выброшенный телефон — класс ERR-0034.
 */
export function assertPhoneByCouple(role: Role, hasPhone: boolean): void {
  if (hasPhone && !seesInviteUrl(role)) {
    throw new AppError(403, 'forbidden', 'Телефоны гостей ведёт пара — остальной команде они не показываются и не правятся')
  }
}

/**
 * Телефон из списка гостей — к виду `+7XXXXXXXXXX` (фича 008).
 *
 * Пара вставляет номера как записала: «8 917 000-11-22», «+7 (917) …», «7917…».
 * Один вид нужен дедупликации и напоминаниям; не российский или неполный
 * номер — `null`, строка помечается `invalid` и не заводится.
 */
export function normalizeRuPhone(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`
  if (digits.length === 10 && digits[0] === '9') return `+7${digits}`
  return null
}

/**
 * Телефон из формы пары — к виду `+7XXXXXXXXXX` или 422 (ревью 015). Тот же
 * `normalizeRuPhone`, что у импорта: иначе один и тот же номер жил в двух
 * написаниях, дедупликация их не видела, а провайдер SMS получал сырую строку.
 * `undefined` — поля не прислали.
 */
export function normalizedPhoneOr422(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw.trim() === '') return null
  const phone = normalizeRuPhone(raw)
  if (phone === null) throw new AppError(422, 'validation_failed', 'Телефон не распознан', { phone: 'ожидается российский номер, например +7 917 000-00-00' })
  return phone
}

/** Сколько SMS уходит за одно нажатие «Напомнить»: список гостей не ограничен, а SMS — деньги. */
export const REMIND_MAX_PER_CALL = 300

/** Текст напоминания: имя гостя — одной строкой и коротко, оно набрано парой, а не нами. */
export function remindText(name: string, code: string): string {
  const who = name.replace(/\s+/g, ' ').trim().slice(0, 40)
  return `${who}, напоминаем о свадьбе: ответьте, пожалуйста, придёте ли вы — https://tili-tili.ru/i/${code}`
}

/** Ключ имени для дедупликации: регистр и лишние пробелы — не другой гость. */
export function guestNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 020: одна строка guest = одна персона, поэтому никакого скрытого умножения. */
export function personCount(guests: { status: string }[]): number {
  return guests.filter((g) => g.status === 'yes').length
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

  interface NewPartyPerson { name: string }

  const cleanPersonName = (raw: string) => raw.trim().replace(/\s+/g, ' ')

  /** 020: one invitation owns one token; each attendee is a separate guest row. */
  const createParty = async (
    client: Queryable,
    input: { weddingId: string; name: string; group?: string | undefined; phone?: string | null | undefined; persons?: NewPartyPerson[] | undefined; legacyPlusOne?: boolean | undefined },
  ) => {
    const primaryId = uuidv7()
    const partyId = uuidv7()
    const extra = [...(input.persons ?? [])]
    if (input.legacyPlusOne && extra.length === 0) extra.push({ name: 'Спутник/спутница' })
    if (1 + extra.length > 10) throw new AppError(422, 'validation_failed', 'В одном приглашении не больше 10 персон')
    const names = [cleanPersonName(input.name), ...extra.map((p) => cleanPersonName(p.name))]
    if (names.some((name) => !name)) throw new AppError(422, 'validation_failed', 'У каждой персоны должно быть имя')

    await client.query(
      'insert into guest_parties (id, wedding_id, rsvp_token) values ($1,$2,$3)',
      [partyId, input.weddingId, newGuestToken()],
    )
    await client.query(
      `insert into guests (id, wedding_id, name, group_name, phone, party_id, is_primary)
       values ($1,$2,$3,$4,$5,$6,true)`,
      [primaryId, input.weddingId, names[0], input.group ?? null, input.phone ?? null, partyId],
    )
    for (const name of names.slice(1)) {
      await client.query(
        `insert into guests (id, wedding_id, name, group_name, party_id, is_primary)
         values ($1,$2,$3,$4,$5,false)`,
        [uuidv7(), input.weddingId, name, input.group ?? null, partyId],
      )
    }
    return { primaryId, partyId }
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
            /* Legacy bridge only. New clients send named persons. */
            plusOne: { type: 'boolean' },
            persons: {
              type: 'array',
              maxItems: 9,
              items: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
              },
            },
            group: { type: 'string', maxLength: 120 },
            phone: { type: 'string', maxLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string
        plusOne?: boolean
        persons?: NewPartyPerson[]
        group?: string
        phone?: string
      }
      assertPhoneByCouple(request.member!.role, body.phone !== undefined)
      const phone = normalizedPhoneOr422(body.phone)
      const created = await db().tx((client) =>
        createParty(client, {
          weddingId: request.member!.weddingId,
          name: body.name,
          group: body.group,
          phone,
          persons: body.persons,
          legacyPlusOne: body.plusOne === true,
        }),
      )
      return reply.code(201).send(await loadGuest(db(), created.primaryId, request.member!.role))
    },
  )

  /* ── импорт списком ────────────────────────────────────────────────── */
  app.post(
    '/weddings/:weddingId/guests/import',
    {
      schema: {
        body: {
          type: 'object',
          required: ['guests'],
          additionalProperties: false,
          properties: {
            guests: {
              type: 'array',
              minItems: 1,
              maxItems: 300,
              items: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string', minLength: 2, maxLength: 120 },
                  phone: { type: 'string', maxLength: 32 },
                  plusOne: { type: 'boolean' },
                  persons: {
                    type: 'array',
                    maxItems: 9,
                    items: {
                      type: 'object',
                      required: ['name'],
                      additionalProperties: false,
                      properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
                    },
                  },
                  group: { type: 'string', maxLength: 60 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { guests } = request.body as {
        guests: { name: string; phone?: string; plusOne?: boolean; persons?: NewPartyPerson[]; group?: string }[]
      }
      assertPhoneByCouple(request.member!.role, guests.some((g) => g.phone !== undefined))
      const skipped: { index: number; name: string; reason: 'duplicate' | 'invalid' }[] = []
      const createdIds: string[] = []

      await db().tx(async (client) => {
        await client.query('select id from weddings where id = $1 for update', [weddingId])
        const { rows: existing } = await client.query<{ name: string; phone: string | null }>(
          `select g.name,
                  case when g.is_primary then g.phone else null end as phone
             from guests g where g.wedding_id = $1`,
          [weddingId],
        )
        const names = new Set(existing.map((g) => guestNameKey(g.name)))
        const phones = new Set(existing.map((g) => g.phone).filter((p): p is string => !!p))

        for (const [index, row] of guests.entries()) {
          const phone = normalizeRuPhone(row.phone)
          if (phone === null) { skipped.push({ index, name: row.name, reason: 'invalid' }); continue }
          const partyNames = [
            cleanPersonName(row.name),
            ...(row.persons ?? []).map((p) => cleanPersonName(p.name)),
            ...(row.plusOne && !(row.persons?.length) ? ['Спутник/спутница'] : []),
          ]
          const primaryKey = guestNameKey(row.name)
          const invalid = partyNames.some((name) => name.length < 1) || partyNames.length > 10
          const duplicate = names.has(primaryKey) || (phone ? phones.has(phone) : false)
          if (invalid || duplicate) {
            skipped.push({ index, name: row.name, reason: invalid ? 'invalid' : 'duplicate' })
            continue
          }
          const created = await createParty(client, {
            weddingId,
            name: row.name,
            phone: phone ?? null,
            group: row.group,
            persons: row.persons,
            legacyPlusOne: row.plusOne === true,
          })
          createdIds.push(created.primaryId)
          for (const name of partyNames) names.add(guestNameKey(name))
          if (phone) phones.add(phone)
        }
      })

      const created: unknown[] = []
      for (const id of createdIds) created.push(await loadGuest(db(), id, request.member!.role))
      return reply.code(201).send({ created, skipped })
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
            /* Compatibility bridge. Explicit family clients do not use it. */
            plusOne: { type: 'boolean' },
            status: { type: 'string', enum: ['yes', 'no', 'pending'] },
            group: { type: 'string', nullable: true, maxLength: 120 },
            phone: { type: 'string', nullable: true, maxLength: 32 },
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
      const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
      assertPhoneByCouple(request.member!.role, has('phone'))
      const phone = body.phone === null ? null : normalizedPhoneOr422(body.phone as string | undefined)

      return db().tx(async (client) => {
        const { rows: owner } = await client.query<{ party_id: string }>(
          'select party_id from guests where id = $1 and wedding_id = $2',
          [guestId, weddingId],
        )
        const partyId = owner[0]?.party_id
        if (!partyId) throw notFound('Гость не найден')

        /* Family mutex first, then person rows: same order as family RSVP. */
        await client.query('select id from guest_parties where id = $1 for update', [partyId])
        const { rows: locked } = await client.query<{
          id: string
          is_primary: boolean
          name: string
          table_id: string | null
          rsvp: string
          group_name: string | null
          diet: string | null
          diet_note: string | null
          transfer: string | null
          menu_option_id: string | null
        }>(
          `select id, is_primary, name, table_id, rsvp, group_name, diet, diet_note, transfer, menu_option_id
             from guests where party_id = $1 order by id for update`,
          [partyId],
        )
        const current = locked.find((p) => p.id === guestId)
        if (!current) throw notFound('Гость не найден')
        const auto = locked.find((p) => !p.is_primary && p.name === 'Спутник/спутница') ?? null
        const legacySolo = locked.length === 1 && current.is_primary
        const addAuto = body.plusOne === true && legacySolo
        const removeAuto = body.plusOne === false && current.is_primary && auto !== null

        /* Legacy +1 follows primary seating. Named family members never do. */
        const targetTable = has('tableId')
          ? (body.tableId as string | null)
          : addAuto
            ? current.table_id
            : undefined
        if (targetTable) {
          const { rows: table } = await client.query<{ name: string; capacity: number }>(
            'select name, capacity from tables where id = $1 and wedding_id = $2 for update',
            [targetTable, weddingId],
          )
          if (!table[0]) throw notFound('Стол не найден')
          const movingIds = [guestId, ...(auto ? [auto.id] : [])]
          const { rows: seated } = await client.query<{ persons: string }>(
            `select count(*)::text as persons
               from guests
              where wedding_id = $2 and table_id = $1 and not (id = any($3::uuid[]))`,
            [targetTable, weddingId, movingIds],
          )
          const requested = current.is_primary && (addAuto || auto) ? 2 : 1
          const total = Number(seated[0]!.persons) + requested
          if (total > table[0].capacity) {
            throw conflict(
              'table_full',
              `За столом «${table[0].name}» ${table[0].capacity} ${plural(table[0].capacity, 'место', 'места', 'мест')}, а после изменения сидело бы ${total}`,
            )
          }
        }

        if (addAuto) {
          const companionId = uuidv7()
          await client.query(
            `insert into guests (
               id, wedding_id, name, rsvp, group_name, diet, diet_note, transfer,
               table_id, menu_option_id, party_id, is_primary, rsvp_at
             ) values ($1,$2,'Спутник/спутница',$3,$4,$5,$6,$7,$8,$9,$10,false,
                       case when $3 <> 'pending' then now() else null end)`,
            [
              companionId,
              weddingId,
              (body.status as string | undefined) ?? current.rsvp,
              has('group') ? (body.group as string | null) : current.group_name,
              has('diet') ? (body.diet as string | null) : current.diet,
              has('dietNote') ? (body.dietNote as string | null) : current.diet_note,
              has('transfer') ? (body.transfer as string | null) : current.transfer,
              has('tableId') ? (body.tableId as string | null) : current.table_id,
              current.menu_option_id,
              partyId,
            ],
          )
          /* Old client expects its +1 to ride with it. The trigger enforces
           * remaining capacity atomically. */
          const { rows: primaryBus } = await client.query<{ bus_id: string }>(
            'select bus_id from bus_bookings where guest_id = $1 limit 1',
            [guestId],
          )
          if (primaryBus[0]) {
            try {
              await client.query(
                'insert into bus_bookings(bus_id, guest_id) values ($1,$2)',
                [primaryBus[0].bus_id, companionId],
              )
            } catch (error) {
              if (isCheckViolation(error, 'bus_taken_bounded')) {
                throw conflict('bus_full', 'В автобусе нет места для второй персоны — выберите другой маршрут')
              }
              throw error
            }
          }
          if (current.menu_option_id) {
            await client.query(
              'insert into menu_votes(guest_id, option_id) values ($1,$2) on conflict (guest_id) do nothing',
              [companionId, current.menu_option_id],
            )
          }
        }

        if (removeAuto && auto) {
          await client.query('delete from guests where id = $1', [auto.id])
        }

        if (body.status === 'no') {
          await client.query(
            `delete from bus_bookings b using bus_routes r
              where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
            [guestId, weddingId],
          )
          if (auto && !removeAuto) {
            await client.query(
              `delete from bus_bookings b using bus_routes r
                where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
              [auto.id, weddingId],
            )
          }
        }

        const res = await client.query(
          `update guests set
             name = coalesce($3, name),
             rsvp = coalesce($4, rsvp),
             group_name = case when $5 then $6 else group_name end,
             table_id = case when $7 then $8::uuid else table_id end,
             diet = case when $9 then $10 else diet end,
             diet_note = case when $11 then $12 else diet_note end,
             transfer = case when $13 then $14 else transfer end,
             rsvp_at = case when $4::text is null then rsvp_at else now() end
           where id = $1 and wedding_id = $2`,
          [
            guestId,
            weddingId,
            (body.name as string) ?? null,
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

        /* Existing auto companion mirrors legacy primary edits; named family
         * members remain independent. */
        if (auto && !removeAuto) {
          await client.query(
            `update guests set
               rsvp = coalesce($2, rsvp),
               group_name = case when $3 then $4 else group_name end,
               table_id = case when $5 then $6::uuid else table_id end,
               diet = case when $7 then $8 else diet end,
               diet_note = case when $9 then $10 else diet_note end,
               transfer = case when $11 then $12 else transfer end,
               rsvp_at = case when $2::text is null then rsvp_at else now() end
             where id = $1`,
            [
              auto.id,
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
        }

        if (has('phone')) {
          await client.query('update guests set phone = $2 where party_id = $1 and is_primary', [partyId, phone])
        }

        if (body.status === 'no') {
          const { rows: remaining } = await client.query<{ n: string }>(
            "select count(*)::text as n from guests where party_id = $1 and rsvp <> 'no'",
            [partyId],
          )
          if (Number(remaining[0]!.n) === 0) await client.query('delete from hotel_bookings where party_id = $1', [partyId])
        }

        if (has('tableId') || addAuto || removeAuto) {
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
    const weddingId = request.member!.weddingId
    if (!isUuid(guestId)) throw notFound('Гость не найден')

    await db().tx(async (client) => {
      const { rows } = await client.query<{ party_id: string; is_primary: boolean; phone: string | null; comment: string | null }>(
        'select party_id, is_primary, phone, comment from guests where id = $1 and wedding_id = $2 for update',
        [guestId, weddingId],
      )
      const removed = rows[0]
      if (!removed) throw notFound('Гость не найден')
      await client.query('delete from guests where id = $1 and wedding_id = $2', [guestId, weddingId])

      const { rows: left } = await client.query<{ id: string }>(
        'select id from guests where party_id = $1 order by created_at, id for update',
        [removed.party_id],
      )
      if (left.length === 0) {
        /* Cascades invite codes + hotel; party trigger releases a live gift
         * reservation tied to its token. Contributions remain historical. */
        await client.query('delete from guest_parties where id = $1', [removed.party_id])
      } else if (removed.is_primary) {
        /* Keep the family link alive when its primary person is removed.
         * Contact fields move to the oldest surviving person. */
        await client.query(
          `update guests
              set is_primary = true,
                  phone = coalesce(phone, $2),
                  comment = coalesce(comment, $3)
            where id = $1`,
          [left[0]!.id, removed.phone, removed.comment],
        )
      }
    })
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
   *
   * Только паре (фича 005, В6): рассылка тратит SMS-лимит свадьбы и уходит
   * чужим людям от её имени — помощнику и координатору 403, как у выдачи
   * ссылки. Общее правило матрицы по `guests` открыто всей команде, поэтому
   * проверка здесь, как у приглашений в команду.
   */
  app.post('/weddings/:weddingId/guests/remind', async (request) => {
    requireRole(request, 'couple')
    const weddingId = request.member!.weddingId
    const claimed = await db().query(
      `update weddings set guests_reminded_at = now()
        where id = $1
          and (guests_reminded_at is null or guests_reminded_at <= now() - interval '24 hours')`,
      [weddingId],
    )
    if (claimed.rowCount === 0) {
      throw new AppError(429, 'too_often', 'Напоминание уходит не чаще раза в сутки — гости получают его лично')
    }

    /* One SMS per invitation, not per person. The primary person carries the
     * family contact during the 020 transition. */
    const { rows: pending } = await db().query<{ party_id: string; name: string; phone: string | null; code: string | null }>(
      `select party.id as party_id, primary_person.name, primary_person.phone,
              (select c.code from guest_invite_codes c
                where c.party_id = party.id and c.used_at is null and c.expires_at > now()
                order by c.expires_at desc limit 1) as code
         from guest_parties party
         join lateral (
           select g.name, g.phone from guests g
            where g.party_id = party.id and g.is_primary
            limit 1
         ) primary_person on true
        where party.wedding_id = $1
          and exists (select 1 from guests g where g.party_id = party.id and g.rsvp = 'pending')
        order by party.created_at, party.id`,
      [weddingId],
    )

    let sent = 0
    let skippedNoPhone = 0
    let skippedLinkUsed = 0
    let failed = 0
    for (const party of pending) {
      if (!party.phone) { skippedNoPhone++; continue }
      if (!party.code) { skippedLinkUsed++; continue }
      if (sent >= REMIND_MAX_PER_CALL) { failed++; continue }
      try {
        await app.sms.send(party.phone, remindText(party.name, party.code))
        sent++
      } catch {
        failed++
      }
    }
    if (sent === 0) await db().query('update weddings set guests_reminded_at = null where id = $1', [weddingId])
    return { sent, skippedNoPhone, skippedLinkUsed, failed }
  })

  app.post('/weddings/:weddingId/guests/:guestId/invite-link', async (request) => {
    const weddingId = request.member!.weddingId
    const { guestId } = request.params as { guestId: string }
    if (!isUuid(guestId)) throw notFound('Гость не найден')

    const { rows } = await db().query<{ party_id: string }>(
      'select party_id from guests where id = $1 and wedding_id = $2',
      [guestId, weddingId],
    )
    const partyId = rows[0]?.party_id
    if (!partyId) throw notFound('Гость не найден')

    return db().tx(async (client) => {
      await client.query('select id from guest_parties where id = $1 for update', [partyId])
      await client.query(
        `update guest_invite_codes
            set expires_at = least(expires_at, now())
          where party_id = $1 and expires_at > now()`,
        [partyId],
      )
      /* Rotating the family token invalidates a lost link and releases only
       * the live anonymous gift reservation. Contributions remain history. */
      await client.query('update guest_parties set rsvp_token = $2 where id = $1', [partyId, newGuestToken()])

      let code = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        code = newShareCode()
        const res = await client.query(
          `insert into guest_invite_codes (code, party_id, expires_at)
           values ($1, $2, greatest(now(), (select coalesce(date::timestamptz, now()) from weddings where id = $3))
                   + ($4 || ' days')::interval)
           on conflict (code) do nothing`,
          [code, partyId, weddingId, String(SHARE_TTL_DAYS)],
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
    const claimed = await db().query<{ party_id: string }>(
      `update guest_invite_codes c set used_at = coalesce(c.used_at, now())
        from guest_parties p join weddings w on w.id = p.wedding_id
        where c.code = $1 and c.expires_at > now() and p.id = c.party_id
          and w.cancelled_at is null and w.archived_at is null
          and (c.used_at is null or c.used_at > now() - make_interval(mins => $2))
        returning c.party_id`,
      [shareCode.toUpperCase(), REDEEM_RETRY_MINUTES],
    )
    const partyId = claimed.rows[0]?.party_id
    if (!partyId) {
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
      `select primary_person.name, p.rsvp_token as token, w.title, w.date::text as date,
              c.name as city, c.region, w.invite_text, w.invite_theme_id, w.venue
         from guest_parties p
         join weddings w on w.id = p.wedding_id
         join lateral (
           select g.name from guests g where g.party_id = p.id
           order by g.is_primary desc, g.created_at, g.id limit 1
         ) primary_person on true
         left join cities c on c.id = w.city_id
        where p.id = $1`,
      [partyId],
    )
    const { rows: persons } = await db().query<{
      id: string; name: string; is_primary: boolean; rsvp: string
    }>(
      'select id, name, is_primary, rsvp from guests where party_id = $1 order by is_primary desc, created_at, id',
      [partyId],
    )
    const g = rows[0]!
    return {
      guestToken: g.token,
      guestName: g.name,
      persons: persons.map((p) => ({ id: p.id, name: p.name, primary: p.is_primary, status: p.rsvp })),
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
    const { rows: wedding } = await db().query<{
      title: string; date: string | null; city: string | null; region: string | null
      invite_text: string | null; invite_theme_id: number; venue: string | null
      dress_code: string | null; dress_note: string | null; tz: string
    }>(
      `select w.title, w.date::text as date, c.name as city, c.region,
              w.invite_text, w.invite_theme_id, w.venue, w.dress_code, w.dress_note,
              coalesce(w.tz, 'Europe/Moscow') as tz
         from weddings w left join cities c on c.id = w.city_id
        where w.id = $1`,
      [guest.weddingId],
    )
    const { rows: persons } = await db().query<{
      id: string; name: string; is_primary: boolean; rsvp: string
      diet: string | null; diet_note: string | null; transfer: string | null
    }>(
      `select id, name, is_primary, rsvp, diet, diet_note, transfer
         from guests where party_id = $1
        order by is_primary desc, created_at, id`,
      [guest.partyId],
    )
    const primary = persons.find((p) => p.is_primary) ?? persons[0]!
    const w = wedding[0]!
    return {
      guestName: primary.name,
      /* Legacy single-person surface mirrors the primary during migration. */
      status: primary.rsvp,
      plusOne: persons.length > 1,
      diet: primary.diet,
      dietNote: primary.diet_note,
      transfer: primary.transfer,
      persons: persons.map((p) => ({
        id: p.id,
        name: p.name,
        primary: p.is_primary,
        status: p.rsvp,
        diet: p.diet,
        dietNote: p.diet_note,
        transfer: p.transfer,
      })),
      wedding: {
        title: w.title,
        date: w.date,
        city: w.city ? { name: w.city, region: w.region } : null,
        inviteText: w.invite_text,
        inviteThemeId: w.invite_theme_id,
        venue: w.venue,
        dressCode: w.dress_code,
        dressNote: w.dress_note,
        tz: w.tz,
      },
    }
  })

  app.post(
    '/rsvp/:guestToken',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          anyOf: [{ required: ['status'] }, { required: ['persons'] }],
          properties: {
            /* Legacy primary-person response. */
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
            /* 020 family response: every person is explicit. */
            persons: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: {
                type: 'object',
                required: ['id', 'status'],
                additionalProperties: false,
                properties: {
                  id: UUID_ID,
                  status: { type: 'string', enum: ['yes', 'no'] },
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
        },
      },
    },
    async (request) => {
      const { guestToken } = request.params as { guestToken: string }
      const body = request.body as {
        status?: 'yes' | 'no'
        plusOne?: boolean
        comment?: string
        diet?: string | null
        dietNote?: string | null
        transfer?: 'need' | 'own' | null
        persons?: Array<{
          id: string
          status: 'yes' | 'no'
          diet?: string | null
          dietNote?: string | null
          transfer?: 'need' | 'own' | null
        }>
      }
      const guest = await guestByToken(db(), guestToken)

      await db().tx(async (client) => {
        await client.query('select id from guest_parties where id = $1 for update', [guest.partyId])

        /* Legacy bridge: a late plusOne=true on an old client creates an
         * explicit companion exactly once. A named family person is never
         * removed by plusOne=false. */
        if (!body.persons && body.plusOne === true) {
          const { rows: size } = await client.query<{ n: string }>(
            'select count(*)::text as n from guests where party_id = $1',
            [guest.partyId],
          )
          if (Number(size[0]!.n) === 1) {
            await client.query(
              `insert into guests (
                 id, wedding_id, name, rsvp, group_name, diet, diet_note,
                 transfer, table_id, menu_option_id, party_id, is_primary, rsvp_at
               )
               select $2, wedding_id, 'Спутник/спутница', $3, group_name,
                      $4, $5, $6, table_id, menu_option_id, party_id, false, now()
                 from guests where id = $1`,
              [
                guest.guestId,
                uuidv7(),
                body.status ?? 'pending',
                body.diet ?? null,
                body.dietNote ?? null,
                body.transfer ?? null,
              ],
            )
          }
        }

        const updates = body.persons ?? [{
          id: guest.guestId,
          status: body.status!,
          ...(Object.prototype.hasOwnProperty.call(body, 'diet') ? { diet: body.diet } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, 'dietNote') ? { dietNote: body.dietNote } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, 'transfer') ? { transfer: body.transfer } : {}),
        }]
        const unique = [...new Set(updates.map((p) => p.id))]
        if (unique.length !== updates.length) {
          throw new AppError(422, 'validation_failed', 'Одна персона не может быть в ответе дважды')
        }

        const { rows: owned } = await client.query<{ id: string }>(
          `select id from guests
            where party_id = $1 and id = any($2::uuid[])
            order by id for update`,
          [guest.partyId, unique],
        )
        if (owned.length !== unique.length) throw notFound('Персона не найдена')

        for (const p of updates) {
          if (p.status === 'no') {
            await client.query(
              `delete from bus_bookings b using bus_routes r
                where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
              [p.id, guest.weddingId],
            )
          }
          const hasDiet = Object.prototype.hasOwnProperty.call(p, 'diet')
          const hasDietNote = Object.prototype.hasOwnProperty.call(p, 'dietNote')
          const hasTransfer = Object.prototype.hasOwnProperty.call(p, 'transfer')
          await client.query(
            `update guests set
                 rsvp = $2,
                 rsvp_at = now(),
                 diet = case when $3 then $4 else diet end,
                 diet_note = case when $5 then $6 else diet_note end,
                 transfer = case when $7 then $8 else transfer end
               where id = $1 and party_id = $9`,
            [
              p.id,
              p.status,
              hasDiet,
              p.diet ?? null,
              hasDiet || hasDietNote,
              p.dietNote ?? null,
              hasTransfer,
              p.transfer ?? null,
              guest.partyId,
            ],
          )
        }

        if (body.comment !== undefined) {
          await client.query(
            'update guests set comment = $2 where party_id = $1 and is_primary',
            [guest.partyId, body.comment],
          )
        }

        const { rows: active } = await client.query<{ n: string }>(
          "select count(*)::text as n from guests where party_id = $1 and rsvp <> 'no'",
          [guest.partyId],
        )
        if (Number(active[0]!.n) === 0) {
          await client.query('delete from hotel_bookings where party_id = $1', [guest.partyId])
        }

        const { rows: counters } = await client.query<{ yes: string }>(
          "select count(*)::text as yes from guests where wedding_id = $1 and rsvp = 'yes'",
          [guest.weddingId],
        )
        await noteVendorUpdate(client, guest.weddingId, 'guests', `Гостей «приду»: ${counters[0]!.yes}`)
      })

      const { rows: persons } = await db().query<{ id: string; name: string; is_primary: boolean; rsvp: string }>(
        'select id, name, is_primary, rsvp from guests where party_id = $1 order by is_primary desc, created_at, id',
        [guest.partyId],
      )
      const primary = persons.find((p) => p.is_primary) ?? persons[0]!
      return {
        status: primary.rsvp,
        guestName: primary.name,
        persons: persons.map((p) => ({ id: p.id, name: p.name, primary: p.is_primary, status: p.rsvp })),
      }
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

  /* Стол можно переименовать и ужать (фича 005, В6): до неё промах по
   * «Добавить стол» оставался навсегда. Вместимость меньше уже сидящих —
   * 409 `table_full`: считается в персонах, как при посадке выше. Строка
   * стола под замком — посадка гостя за этот же стол идёт через тот же
   * `for update`, и ужатие не проскочит между её проверкой и записью. */
  app.patch(
    '/weddings/:weddingId/tables/:tableId',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            capacity: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      const { tableId } = request.params as { tableId: string }
      const body = (request.body ?? {}) as { name?: string; capacity?: number }
      if (!isUuid(tableId)) throw notFound('Стол не найден')

      return db().tx(async (client) => {
        const { rows: table } = await client.query<{ name: string }>(
          'select name from tables where id = $1 and wedding_id = $2 for update',
          [tableId, weddingId],
        )
        if (table.length === 0) throw notFound('Стол не найден')

        if (body.capacity !== undefined) {
          const { rows: seated } = await client.query<{ persons: string }>(
            'select count(*)::text as persons from guests where table_id = $1',
            [tableId],
          )
          const persons = Number(seated[0]!.persons)
          if (persons > body.capacity) {
            throw conflict(
              'table_full',
              `За столом «${table[0]!.name}» уже ${persons} ${plural(persons, 'человек', 'человека', 'человек')} — вместимость меньше не поставить`,
            )
          }
        }

        const { rows } = await client.query<{ id: string; name: string; capacity: number }>(
          `update tables set name = coalesce($3, name), capacity = coalesce($4, capacity)
            where id = $1 and wedding_id = $2
            returning id, name, capacity`,
          [tableId, weddingId, body.name ?? null, body.capacity ?? null],
        )
        const { rows: guests } = await client.query<{ id: string }>(
          'select id from guests where table_id = $1 order by created_at',
          [tableId],
        )
        return { ...rows[0]!, guestIds: guests.map((g) => g.id) }
      })
    },
  )

  /* Гости удалённого стола остаются в списке «без стола»: `guests.table_id`
   * стоит `ON DELETE SET NULL`, и снимает их база тем же оператором, что
   * удаляет стол, — отдельного шага, который мог бы отстать, нет. */
  app.delete('/weddings/:weddingId/tables/:tableId', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { tableId } = request.params as { tableId: string }
    if (!isUuid(tableId)) throw notFound('Стол не найден')

    await db().tx(async (client) => {
      const { rows: seated } = await client.query<{ n: string }>(
        'select count(*)::text as n from guests where table_id = $1 and wedding_id = $2',
        [tableId, weddingId],
      )
      const res = await client.query('delete from tables where id = $1 and wedding_id = $2', [tableId, weddingId])
      if (res.rowCount === 0) throw notFound('Стол не найден')

      /* Сидевшие за столом лишились места — это правка рассадки, и
       * подрядчик узнаёт о ней так же, как о пересадке (§13.2). */
      if (Number(seated[0]!.n) > 0) {
        const { rows: left } = await client.query<{ n: string }>(
          'select count(*)::text as n from guests where wedding_id = $1 and table_id is not null',
          [weddingId],
        )
        const n = Number(left[0]!.n)
        await noteVendorUpdate(
          client,
          weddingId,
          'seating',
          `Рассадка обновлена: за столами ${n} ${plural(n, 'гость', 'гостя', 'гостей')}`,
        )
      }
    })
    return reply.code(204).send()
  })
}
