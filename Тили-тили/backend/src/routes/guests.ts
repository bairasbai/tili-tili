import type { FastifyInstance } from 'fastify'
import { AppError, conflict, gone, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import { plural } from '../text/plural.js'
import { isCheckViolation, type Queryable } from '../plugins/db.js'
import { guestByToken, newGuestToken, newShareCode } from '../guests/access.js'
import { assertSeatingToken, lockSeatingAccess, requireRole, type Role } from '../wedding/access.js'

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
  party_id: string
  party_position: number
  is_placeholder: boolean
  party_size: number
  plus_one: boolean
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
  g.id, g.name, g.party_id, g.party_position, g.is_placeholder,
  (select count(*)::int from guests family where family.party_id = g.party_id) as party_size,
  g.plus_one, g.group_name, g.phone, g.comment, g.rsvp, g.table_id, g.diet, g.diet_note,
  g.menu_option_id, g.transfer,
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
  /* Transitional fallback is deliberately local to serialization. Old unit
   * fixtures and rolling clients can still describe a pre-020 row while every
   * row read from the migrated database already has party metadata. */
  const partyPosition = r.party_position ?? 1
  const partySize = r.party_size ?? (r.plus_one ? 2 : 1)
  return {
    id: r.id,
    name: r.name,
    partyId: r.party_id ?? r.id,
    partyPosition,
    partySize,
    isPrimary: partyPosition === 1,
    isPlaceholder: r.is_placeholder ?? false,
    /* Transitional field for old clients: derived from real family members. */
    plusOne: partyPosition === 1 && partySize > 1,
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
    ...(asCouple ? {
      inviteUrl: partyPosition === 1 && r.invite_code ? `https://tili-tili.ru/i/${r.invite_code}` : null,
    } : {}),
    inviteUrlUsed: partyPosition === 1 && r.invite_used === true,
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
 * «+1» у гостя, который уже сидит в полном автобусе.
 *
 * Места считает база: смена `plus_one` пересчитывает персоны его записи
 * триггером, и переполнение приходит как `23514` от `bus_taken_bounded`
 * (фича 005). Это сработавшее правило, а не поломка сервера — человеку
 * нужен 409 с тем, что делать дальше, а не 500.
 */
const busFullForPlusOne = () =>
  conflict('bus_full', 'в автобусе нет места для +1 — снимите бронь автобуса или выберите другой')

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

/** 020: после materialization каждая строка guests — одна реальная персона.
 * Deprecated plusOne остаётся только compatibility-сигналом и не участвует
 * в счётчиках, вместимости или деньгах. */
export function personCount(guests: { status: string; plusOne?: boolean }[]): number {
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
            members: {
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
        members?: { name: string }[]
        group?: string
        phone?: string
      }
      /* Телефон — к виду `+7XXXXXXXXXX`, как у импорта: сырой «8 917 000-55-66»
       * не совпадал с нормализованным у дедупликации импорта и уходил
       * провайдеру SMS как есть (ревью 015). Не российский или неполный — 422. */
      const id = uuidv7()
      const partyId = uuidv7()
      const token = newGuestToken()
      const guest = await db().tx(async (client) => {
        const role = await lockSeatingAccess(client, request)
        assertPhoneByCouple(role, body.phone !== undefined)
        const phone = normalizedPhoneOr422(body.phone)
        await client.query(
          `insert into guest_parties (id, wedding_id, invite_token, label, contact_phone)
           values ($1,$2,$3,$4,$5)`,
          [partyId, request.member!.weddingId, token, body.name, phone],
        )
        await client.query(
          `insert into guests
             (id, wedding_id, name, plus_one, group_name, phone, rsvp_token, party_id, party_position)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
          [
            id,
            request.member!.weddingId,
            body.name,
            false,
            body.group ?? null,
            phone,
            token,
            partyId,
          ],
        )
        const extraMembers = body.members ?? (body.plusOne ? [{ name: `Спутник ${body.name}`, placeholder: true }] : [])
        for (const [index, member] of extraMembers.entries()) {
          const placeholder = 'placeholder' in member && member.placeholder === true
          await client.query(
            `insert into guests
               (id, wedding_id, name, plus_one, group_name, rsvp_token, party_id, party_position, is_placeholder)
             values ($1,$2,$3,false,$4,$5,$6,$7,$8)`,
            [
              uuidv7(),
              request.member!.weddingId,
              member.name,
              body.group ?? null,
              newGuestToken(),
              partyId,
              index + 2,
              placeholder,
            ],
          )
        }
        const created = await loadGuest(client, id, role)
        await assertSeatingToken(request)
        return created
      })
      return reply.code(201).send(guest)
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
                  plusOne: { type: 'boolean', default: false },
                  members: {
                    type: 'array',
                    maxItems: 9,
                    items: {
                      type: 'object',
                      required: ['name'],
                      additionalProperties: false,
                      properties: { name: { type: 'string', minLength: 2, maxLength: 120 } },
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
        guests: {
          name: string
          phone?: string
          plusOne?: boolean
          members?: { name: string }[]
          group?: string
        }[]
      }
      const skipped: { index: number; name: string; reason: 'duplicate' | 'invalid' }[] = []
      const createdIds: string[] = []

      /* Одна транзакция под замком строки свадьбы: два одновременных импорта
       * одного списка иначе прошли бы обе проверки на дубликаты и завели гостей
       * дважды (R-49). Дубликат — совпадение имени без регистра и лишних пробелов
       * или телефона: с уже заведёнными гостями и с более ранней строкой того же
       * списка. Дубликаты пропускаются, не обновляются: импорт заводит, а не
       * правит — правка у каждого гостя своя (`PATCH …/guests/{id}`). */
      const created = await db().tx(async (client) => {
        const role = await lockSeatingAccess(client, request)
        assertPhoneByCouple(role, guests.some((g) => g.phone !== undefined))
        const { rows: existing } = await client.query<{ name: string; phone: string | null }>(
          'select name, phone from guests where wedding_id = $1',
          [weddingId],
        )
        const names = new Set(existing.map((g) => guestNameKey(g.name)))
        const phones = new Set(existing.map((g) => g.phone).filter((p): p is string => !!p))

        for (const [index, row] of guests.entries()) {
          const phone = normalizeRuPhone(row.phone)
          if (phone === null) { skipped.push({ index, name: row.name, reason: 'invalid' }); continue }
          const nameKey = guestNameKey(row.name)
          const cleanName = row.name.trim().replace(/\s+/g, ' ')
          const extraMembers = row.members ?? (row.plusOne ? [{ name: `Спутник ${cleanName}`, placeholder: true }] : [])
          const memberNames = extraMembers.map((member) => ({
            ...member,
            cleanName: member.name.trim().replace(/\s+/g, ' '),
            key: guestNameKey(member.name),
          }))
          const familyKeys = [nameKey, ...memberNames.map((member) => member.key)]
          const duplicateInFamily = new Set(familyKeys).size !== familyKeys.length
          const invalidFamilyName = familyKeys.some((key) => key.length < 2)
          const duplicateExisting = familyKeys.some((key) => names.has(key))
          if (invalidFamilyName || duplicateInFamily || duplicateExisting || (phone && phones.has(phone))) {
            skipped.push({
              index,
              name: row.name,
              reason: invalidFamilyName ? 'invalid' : 'duplicate',
            })
            continue
          }
          for (const key of familyKeys) names.add(key)
          if (phone) phones.add(phone)
          const id = uuidv7()
          const partyId = uuidv7()
          const token = newGuestToken()
          await client.query(
            `insert into guest_parties (id, wedding_id, invite_token, label, contact_phone)
             values ($1,$2,$3,$4,$5)`,
            [partyId, weddingId, token, cleanName, phone ?? null],
          )
          await client.query(
            `insert into guests
               (id, wedding_id, name, plus_one, group_name, phone, rsvp_token, party_id, party_position)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
            [id, weddingId, cleanName, false, row.group ?? null, phone ?? null, token, partyId],
          )
          for (const [memberIndex, member] of memberNames.entries()) {
            const placeholder = 'placeholder' in member && member.placeholder === true
            await client.query(
              `insert into guests
                 (id, wedding_id, name, plus_one, group_name, rsvp_token, party_id, party_position, is_placeholder)
               values ($1,$2,$3,false,$4,$5,$6,$7,$8)`,
              [
                uuidv7(),
                weddingId,
                member.cleanName,
                row.group ?? null,
                newGuestToken(),
                partyId,
                memberIndex + 2,
                placeholder,
              ],
            )
          }
          createdIds.push(id)
        }
        const created: unknown[] = []
        for (const id of createdIds) created.push(await loadGuest(client, id, role))
        await assertSeatingToken(request)
        return created
      })
      return reply.code(201).send({ created, skipped })
    },
  )

  app.post(
    '/weddings/:weddingId/guests/:guestId/members',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { guestId } = request.params as { guestId: string }
      const { name } = request.body as { name: string }
      if (!isUuid(guestId)) throw notFound('Гость не найден')
      const guest = await db().tx(async (client) => {
        const role = await lockSeatingAccess(client, request)
        const { rows: primary } = await client.query<{ party_id: string; group_name: string | null }>(
          `select party_id, group_name from guests
            where id = $1 and wedding_id = $2 and party_position = 1
            for update`,
          [guestId, weddingId],
        )
        if (!primary[0]) throw notFound('Основной приглашённый не найден')
        await client.query('select id from guest_parties where id = $1 for update', [primary[0].party_id])
        const { rows: positions } = await client.query<{ next: number }>(
          'select coalesce(max(party_position),0)::int + 1 as next from guests where party_id = $1',
          [primary[0].party_id],
        )
        const position = positions[0]!.next
        if (position > 10) throw conflict('family_full', 'В одном приглашении не больше 10 человек')
        const id = uuidv7()
        await client.query(
          `insert into guests
             (id,wedding_id,name,plus_one,group_name,rsvp_token,party_id,party_position,is_placeholder)
           values($1,$2,$3,false,$4,$5,$6,$7,false)`,
          [id, weddingId, name, primary[0].group_name, newGuestToken(), primary[0].party_id, position],
        )
        const created = await loadGuest(client, id, role)
        await assertSeatingToken(request)
        return created
      })
      return reply.code(201).send(guest)
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
        const role = await lockSeatingAccess(client, request)
        assertPhoneByCouple(role, has('phone'))
        const phone = body.phone === null ? null : normalizedPhoneOr422(body.phone as string | undefined)
        await client.query("select set_config('tili.timeline_actor',$1,true)", [request.caller!.userId])
        /* Строка гостя — после свадьбы, до стола и до броней: тот же порядок замков,
         * что у посадки в автобус (гость → маршрут, RF-BE-06). Заодно 404
         * до любых проверок: чужого гостя дальше не пускаем. */
        const { rows: locked } = await client.query<{
          party_id: string
          party_position: number
          name: string
          rsvp: string
          table_id: string | null
          group_name: string | null
          diet: string | null
          diet_note: string | null
          transfer: string | null
          menu_option_id: string | null
        }>(
          `select party_id, party_position, name, rsvp, table_id, group_name, diet, diet_note, transfer, menu_option_id
             from guests where id = $1 and wedding_id = $2 for update`,
          [guestId, weddingId],
        )
        if (locked.length === 0) throw notFound('Гость не найден')
        const current = locked[0]!

        /* Вместимость стола проверяется и при пересадке, и при «+1» без
         * пересадки: гость уже сидит, а «+1» добавляет за столом персону
         * (ревью 015) — стол заявляется сразу с текущим `table_id`. */
        if (has('plusOne') && current.party_position !== 1) {
          throw new AppError(409, 'family_member_not_primary', 'Состав семьи меняется у основного приглашённого')
        }
        const { rows: secondRows } = current.party_position === 1 && (has('plusOne') || has('tableId'))
          ? await client.query<{ id: string; table_id: string | null; is_placeholder: boolean }>(
            'select id, table_id, is_placeholder from guests where party_id=$1 and party_position=2 for update',
            [current.party_id],
          ) : { rows: [] }
        const secondPerson = secondRows[0]
        const placeholder = secondPerson?.is_placeholder ? secondPerson : undefined
        const seatedAt = body.plusOne === true && !has('tableId') ? current.table_id : null
        const tableToCheck = (body.tableId as string | undefined) ?? seatedAt ?? undefined
        if (tableToCheck) {
          /* Стол обязан принадлежать этой же свадьбе: иначе гость садится
           * за чужой стол и портит чужую рассадку. Строка стола под
           * блокировкой: два одновременных «посадить» за последнее место
           * иначе оба прошли бы проверку вместимости (R-49). */
          const { rows: table } = await client.query<{ name: string; capacity: number }>(
            'select name, capacity from tables where id = $1 and wedding_id = $2 for update',
            [tableToCheck, weddingId],
          )
          if (table.length === 0) throw notFound('Стол не найден')

          // Named people move individually. Only a generated legacy companion
          // follows the primary; count the actual projected assignment, not family size.
          const { rows: seated } = await client.query<{ persons: string }>(
            `select count(*)::text as persons
               from guests o
              where o.wedding_id = $2
                and o.table_id = $1
                and o.id <> $3`,
            [tableToCheck, weddingId, guestId],
          )
          const changesPlaceholder = !!placeholder && (has('tableId') || body.plusOne === false)
          const removedFromTarget = changesPlaceholder && placeholder.table_id === tableToCheck ? 1 : 0
          const movedToTarget = placeholder && has('tableId') && body.plusOne !== false ? 1 : 0
          const addedToTarget = body.plusOne === true && !secondPerson ? 1 : 0
          const total = Number(seated[0]!.persons) + 1 - removedFromTarget + movedToTarget + addedToTarget
          const { capacity, name } = table[0]!
          if (total > capacity) {
            throw conflict(
              'table_full',
              `За столом «${name}» ${capacity} ${plural(capacity, 'место', 'места', 'мест')}, а с этим гостем сидело бы ${total}`,
            )
          }
        }

        /* «Не придёт», поставленное рукой пары («бабушка без смартфона»,
         * План §19.5), освобождает автобус и номер так же, как ответ самого
         * гостя в `POST /rsvp/{t}`: иначе автобус выглядит полным при пустом
         * сиденье (ERR-0040 другим путём). Счётчики поправит триггер.
         *
         * ДО записи самого ответа: с «+1» в том же теле у гостя, сидящего в
         * полном автобусе, база иначе отказала бы тому, кто место как раз
         * освобождает. */
        if (body.status === 'no') {
          await client.query(
            `delete from bus_bookings b using bus_routes r
              where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
            [guestId, weddingId],
          )
        }

        let res
        try {
          res = await client.query(
            `update guests set
               name = coalesce($3, name),
               plus_one = false,
               rsvp = coalesce($4, rsvp),
               group_name = case when $5 then $6 else group_name end,
               table_id = case when $7 then $8::uuid else table_id end,
               diet = case when $9 then $10 else diet end,
               diet_note = case when $11 then $12 else diet_note end,
               transfer = case when $13 then $14 else transfer end,
               phone = case when $15 then $16 else phone end
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
              has('phone'),
              phone,
            ],
          )
        } catch (error) {
          if (isCheckViolation(error, 'bus_taken_bounded')) throw busFullForPlusOne()
          throw error
        }
        if (res.rowCount === 0) throw notFound('Гость не найден')

        if (has('plusOne')) {
          if (body.plusOne === true && !secondPerson) {
            const companionId = uuidv7()
            const effectiveTable = has('tableId') ? (body.tableId as string | null) : current.table_id
            const effectiveStatus = (body.status as string | undefined) ?? current.rsvp
            const effectiveGroup = has('group') ? (body.group as string | null) : current.group_name
            const effectiveDiet = has('diet') ? (body.diet as string | null) : current.diet
            const effectiveDietNote = has('dietNote') ? (body.dietNote as string | null) : current.diet_note
            const effectiveTransfer = has('transfer') ? (body.transfer as string | null) : current.transfer
            await client.query(
              `insert into guests
                 (id, wedding_id, name, rsvp, plus_one, group_name, diet, diet_note, transfer,
                  table_id, menu_option_id, rsvp_token, party_id, party_position, is_placeholder)
               values ($1,$2,$3,$4,false,$5,$6,$7,$8,$9,$10,$11,$12,2,true)`,
              [
                companionId,
                weddingId,
                `Спутник ${(body.name as string | undefined) ?? current.name}`,
                effectiveStatus,
                effectiveGroup,
                effectiveDiet,
                effectiveDietNote,
                effectiveTransfer,
                effectiveTable,
                current.menu_option_id,
                newGuestToken(),
                current.party_id,
              ],
            )
            if (current.menu_option_id) {
              await client.query(
                `insert into menu_votes (guest_id, option_id)
                 values ($1,$2) on conflict (guest_id) do nothing`,
                [companionId, current.menu_option_id],
              )
            }
            try {
              await client.query(
                `insert into bus_bookings (bus_id, guest_id)
                 select bus_id, $2 from bus_bookings where guest_id = $1
                 on conflict do nothing`,
                [guestId, companionId],
              )
            } catch (error) {
              if (isCheckViolation(error, 'bus_taken_bounded')) throw busFullForPlusOne()
              throw error
            }
          } else if (body.plusOne === false && placeholder) {
            await client.query('delete from guests where id = $1', [placeholder.id])
          }
        }

        /* Legacy family fields were shared by the old +1 row. Keep generated
         * placeholders in sync when the pair edits the primary through the
         * old single-person route. A real named member is edited separately. */
        if (current.party_position === 1) {
          await client.query(
            `update guests set
                 rsvp = case when $2 then $3 else rsvp end,
                 table_id = case when $4 then $5::uuid else table_id end,
                 group_name = case when $6 then $7 else group_name end,
                 diet = case when $8 then $9 else diet end,
                 diet_note = case when $10 then $11 else diet_note end,
                 transfer = case when $12 then $13 else transfer end
               where party_id = $1 and party_position = 2 and is_placeholder`,
            [
              current.party_id,
              has('status'),
              (body.status as string) ?? null,
              has('tableId'),
              (body.tableId as string) ?? null,
              has('group'),
              (body.group as string) ?? null,
              has('diet'),
              (body.diet as string) ?? null,
              has('dietNote'),
              (body.dietNote as string) ?? null,
              has('transfer'),
              (body.transfer as string) ?? null,
            ],
          )
        }

        if (has('status')) {
          const { rows: attending } = await client.query<{ n: string }>(
            "select count(*)::text as n from guests where party_id = $1 and rsvp = 'yes'",
            [current.party_id],
          )
          if (Number(attending[0]!.n) === 0) {
            await client.query('delete from hotel_bookings where party_id = $1', [current.party_id])
          }
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
        const guest = await loadGuest(client, guestId, role)
        await assertSeatingToken(request)
        return guest
      })
    },
  )

  app.delete('/weddings/:weddingId/guests/:guestId', async (request, reply) => {
    const { guestId } = request.params as { guestId: string }
    if (!isUuid(guestId)) throw notFound('Гость не найден')
    await db().tx(async (client) => {
      await lockSeatingAccess(client, request)
      await client.query("select set_config('tili.timeline_actor',$1,true)", [request.caller!.userId])
      const { rows } = await client.query<{ party_id: string; party_position: number }>(
        'select party_id, party_position from guests where id = $1 and wedding_id = $2 for update',
        [guestId, request.member!.weddingId],
      )
      const guest = rows[0]
      if (!guest) throw notFound('Гость не найден')

      /* Family membership is protected by the party row. Removing one person
       * must not rotate the shared invite token while somebody else remains:
       * RSVP, hotel and gift identity belong to the invitation, not to the
       * person who happened to be position 1. */
      await client.query('select id from guest_parties where id = $1 for update', [guest.party_id])
      const { rows: members } = await client.query<{
        id: string
        party_position: number
        name: string
        phone: string | null
      }>(
        'select id, party_position, name, phone from guests where party_id = $1 order by party_position for update',
        [guest.party_id],
      )

      if (members.length <= 1) {
        await client.query('delete from guest_parties where id = $1', [guest.party_id])
        await assertSeatingToken(request)
        return
      }

      await client.query('delete from guests where id = $1', [guestId])
      const remaining = members.filter((member) => member.id !== guestId)

      /* Compact positions one-by-one from the first gap. The unique
       * (party_id, party_position) index makes a bulk renumber unsafe, while
       * ascending moves are conflict-free because the previous slot is empty. */
      for (const [index, member] of remaining.entries()) {
        const position = index + 1
        if (member.party_position !== position) {
          await client.query('update guests set party_position = $2 where id = $1', [member.id, position])
        }
      }

      if (guest.party_position === 1) {
        const nextPrimary = remaining[0]!
        await client.query(
          'update guest_parties set label = $2, contact_phone = $3 where id = $1',
          [guest.party_id, nextPrimary.name, nextPrimary.phone],
        )
      }
      await assertSeatingToken(request)
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
    let failed = 0
    /* Предел на одну рассылку: список гостей не ограничен, а SMS — наши
     * деньги на чужие номера (ревью 015). Сверх предела — не шлём, и в ответе
     * это видно как `failed`; на следующие сутки очередь дойдёт до остальных. */
    for (const guest of pending) {
      if (!guest.phone) {
        skippedNoPhone++
        continue
      }
      if (!guest.code) {
        /* Ссылки у гостя нет вовсе (импорт списком, ссылку не выдавали) —
         * напоминать не о чём, это не «ссылка открыта». */
        skippedLinkUsed++
        continue
      }
      if (sent >= REMIND_MAX_PER_CALL) {
        failed++
        continue
      }
      try {
        await app.sms.send(guest.phone, remindText(guest.name, guest.code))
        sent++
      } catch {
        // Отказ провайдера на одном номере не должен ронять всю рассылку:
        // остальные гости не виноваты. Ошибка уже в логе отправителя.
        failed++
      }
    }

    if (sent === 0) {
      /* Никому не ушло — суточный запрет не заслужен: снимаем захват. Прежняя
       * отметка либо пуста, либо старше суток — для правила это одно и то же. */
      await db().query('update weddings set guests_reminded_at = null where id = $1', [weddingId])
    }
    return { sent, skippedNoPhone, skippedLinkUsed, failed }
  })

  app.post('/weddings/:weddingId/guests/:guestId/invite-link', async (request) => {
    const weddingId = request.member!.weddingId
    const { guestId } = request.params as { guestId: string }
    if (!isUuid(guestId)) throw notFound('Гость не найден')

    return db().tx(async (client) => {
      await lockSeatingAccess(client, request)
      const { rows } = await client.query<{ party_id: string }>(
        'select party_id from guests where id = $1 and wedding_id = $2 for update',
        [guestId, weddingId],
      )
      if (rows.length === 0) throw notFound('Гость не найден')
      const partyId = rows[0]!.party_id
      await client.query('select id from guest_parties where id = $1 for update', [partyId])
      /* Прежний код гаснет: «выдать новую ссылку» означает, что старая
       * потеряна или ушла не туда.
       *
       * Гаснет он СРОКОМ, а не отметкой `used_at`: у обмена есть окно повтора
       * (`REDEEM_RETRY_MINUTES`), в котором уже использованный код отдаёт
       * токен ещё раз, — истёкший срок закрывает и его. Отметка «открыт» на
       * неоткрытом коде врала бы паре `inviteUrlUsed: true` (ревью 015). */
      await client.query(
        `update guest_invite_codes
            set expires_at = least(expires_at, now())
          where party_id = $1 and expires_at > now()`,
        [partyId],
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
       * попросит новую, и подмена станет видна.
       *
       * Отзыв гостя ключуется самим гостем (`reviews.guest_id`, фича 005), а
       * не токеном: переносить его за новой ссылкой больше не нужно — пара,
       * выпускающая ссылки, гостевых голосов в рейтинг не множит (D3-09). */
      const token = newGuestToken()
      await client.query('update guest_parties set invite_token = $2 where id = $1', [partyId, token])
      /* Primary keeps the party token only as a legacy mirror for tables and
       * old exports; authorization already resolves guest_parties. Other
       * members keep private internal tokens and never become a second link. */
      await client.query(
        'update guests set rsvp_token = $2 where party_id = $1 and party_position = 1',
        [partyId, token],
      )
      let code = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        code = newShareCode()
        const res = await client.query(
          `insert into guest_invite_codes (code, guest_id, party_id, expires_at)
           values ($1, $2, $3, greatest(now(), (select coalesce(date::timestamptz, now()) from weddings where id = $4))
                   + ($5 || ' days')::interval)
           on conflict (code) do nothing`,
          [code, guestId, partyId, weddingId, String(SHARE_TTL_DAYS)],
        )
        if (res.rowCount === 1) break
        code = ''
      }
      if (!code) throw new AppError(503, 'code_collision', 'Не удалось выдать ссылку, попробуйте ещё раз')

      const { rows: saved } = await client.query<{ expires_at: Date }>(
        'select expires_at from guest_invite_codes where code = $1',
        [code],
      )
      await assertSeatingToken(request)
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
    /* Свадьба отменена или убрана — ссылка мертва: обмен сжигал код и отдавал
     * название, дату и площадку отменённой свадьбы с токеном, который дальше
     * везде отвечал 401 (ревью 015). */
    const claimed = await db().query<{ party_id: string }>(
      `update guest_invite_codes c set used_at = coalesce(c.used_at, now())
        from guest_parties p join weddings w on w.id = p.wedding_id
        where c.code = $1 and c.expires_at > now() and p.id = c.party_id
          and w.cancelled_at is null and w.archived_at is null
          and (c.used_at is null or c.used_at > now() - make_interval(mins => $2))
        returning c.party_id`,
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
      `select g.name, p.invite_token as token, w.title, w.date::text as date,
              c.name as city, c.region, w.invite_text, w.invite_theme_id, w.venue
         from guest_parties p
         join weddings w on w.id = p.wedding_id
         join guests g on g.party_id = p.id and g.party_position = 1
         left join cities c on c.id = w.city_id
        where p.id = $1`,
      [claimed.rows[0]!.party_id],
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
    const { rows: members } = await db().query<{
      id: string
      name: string
      rsvp: string
      diet: string | null
      diet_note: string | null
      transfer: string | null
      party_position: number
      is_placeholder: boolean
    }>(
      `select id, name, rsvp, diet, diet_note, transfer, party_position, is_placeholder
         from guests
        where party_id = $1
        order by party_position, created_at, id`,
      [guest.partyId],
    )
    const { rows } = await db().query<{
      title: string
      date: string | null
      city: string | null
      region: string | null
      invite_text: string | null
      invite_theme_id: number
      venue: string | null
      dress_code: string | null
      dress_note: string | null
      tz: string
    }>(
      `select w.title, w.date::text as date, c.name as city, c.region,
              w.invite_text, w.invite_theme_id, w.venue, w.dress_code, w.dress_note,
              coalesce(w.tz, 'Europe/Moscow') as tz
         from weddings w
         left join cities c on c.id = w.city_id
        where w.id = $1`,
      [guest.weddingId],
    )
    const primary = members[0]!
    const wedding = rows[0]!
    return {
      partyId: guest.partyId,
      guestName: primary.name,
      status: primary.rsvp,
      /* Transitional single-person fields stay until the frontend moves to
       * members[]. plusOne is derived from real people, never from the old
       * boolean column. */
      plusOne: members.length > 1,
      diet: primary.diet,
      dietNote: primary.diet_note,
      transfer: primary.transfer,
      members: members.map((m) => ({
        guestId: m.id,
        name: m.name,
        status: m.rsvp,
        diet: m.diet,
        dietNote: m.diet_note,
        transfer: m.transfer,
        isPlaceholder: m.is_placeholder,
      })),
      wedding: {
        title: wedding.title,
        date: wedding.date,
        city: wedding.city ? { name: wedding.city, region: wedding.region } : null,
        inviteText: wedding.invite_text,
        inviteThemeId: wedding.invite_theme_id,
        venue: wedding.venue,
        dressCode: wedding.dress_code,
        dressNote: wedding.dress_note,
        tz: wedding.tz,
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
          anyOf: [{ required: ['status'] }, { required: ['members'] }],
          properties: {
            status: { type: 'string', enum: ['yes', 'no'] },
            plusOne: { type: 'boolean' },
            comment: { type: 'string', maxLength: 1000 },
            diet: {
              type: 'string',
              nullable: true,
              enum: [null, 'vegetarian', 'vegan', 'halal', 'kosher', 'gluten_free', 'other'],
            },
            dietNote: { type: 'string', nullable: true, maxLength: 300 },
            transfer: { type: 'string', nullable: true, enum: [null, 'need', 'own'] },
            members: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: {
                type: 'object',
                required: ['guestId', 'status'],
                additionalProperties: false,
                properties: {
                  guestId: UUID_ID,
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
        transfer?: string | null
        members?: {
          guestId: string
          status: 'yes' | 'no'
          diet?: string | null
          dietNote?: string | null
          transfer?: string | null
        }[]
      }
      const guest = await guestByToken(db(), guestToken)
      const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key)

      const result = await db().tx(async (client) => {
        await client.query('select id from weddings where id=$1 for update', [guest.weddingId])
        // Guest-token actions have no authenticated user author.
        await client.query("select set_config('tili.timeline_actor','',true)")
        const { rows: locked } = await client.query<{
          id: string
          name: string
          party_position: number
          is_placeholder: boolean
          rsvp: string
          table_id: string | null
          diet: string | null
          diet_note: string | null
          transfer: string | null
        }>(
          `select id, name, party_position, is_placeholder, rsvp, table_id, diet, diet_note, transfer
             from guests
            where party_id = $1
            order by id
            for update`,
          [guest.partyId],
        )
        if (locked.length === 0) throw new AppError(401, 'unauthorized', 'Ссылка недействительна')

        /* Compatibility for the old +1 UI. It mutates real people instead of
         * reviving guests.plus_one. A generated placeholder may later be
         * renamed by the pair/new family UI. */
        if (body.members === undefined && body.plusOne !== undefined) {
          const primary = locked.find((m) => m.party_position === 1) ?? locked[0]!
          const placeholder = locked.find((m) => m.party_position === 2 && m.is_placeholder)
          await client.query('update guests set plus_one = false where id = $1', [primary.id])
          if (body.plusOne && !placeholder) {
            const companionId = uuidv7()
            await client.query(
              `insert into guests
                 (id, wedding_id, name, rsvp, plus_one, group_name, diet, diet_note, transfer,
                  table_id, menu_option_id, rsvp_token, party_id, party_position, is_placeholder)
               select $2, wedding_id, 'Спутник ' || name, $3, false, group_name, diet, diet_note, transfer,
                      table_id, menu_option_id, $4, party_id, 2, true
                 from guests where id = $1`,
              [primary.id, companionId, body.status ?? primary.rsvp, newGuestToken()],
            )
            await client.query(
              `insert into menu_votes (guest_id, option_id, at)
               select $2, option_id, at from menu_votes where guest_id = $1
               on conflict (guest_id) do nothing`,
              [primary.id, companionId],
            )
            if (body.status !== 'no') {
              try {
                await client.query(
                  `insert into bus_bookings (bus_id, guest_id)
                   select bus_id, $2 from bus_bookings where guest_id = $1
                   on conflict do nothing`,
                  [primary.id, companionId],
                )
              } catch (error) {
                if (isCheckViolation(error, 'bus_taken_bounded')) throw busFullForPlusOne()
                throw error
              }
            }
          } else if (!body.plusOne && placeholder) {
            await client.query('delete from guests where id = $1', [placeholder.id])
          }
        }

        const requested = body.members ?? [{
          guestId: guest.guestId,
          status: body.status!,
          ...(has(body, 'diet') ? { diet: body.diet } : {}),
          ...(has(body, 'dietNote') ? { dietNote: body.dietNote } : {}),
          ...(has(body, 'transfer') ? { transfer: body.transfer } : {}),
        }]
        const ids = new Set(locked.map((m) => m.id))
        const seen = new Set<string>()
        for (const item of requested) {
          if (!ids.has(item.guestId)) throw new AppError(404, 'not_found', 'Человек не входит в это приглашение')
          if (seen.has(item.guestId)) throw new AppError(422, 'validation_failed', 'Один человек указан дважды')
          seen.add(item.guestId)

          if (item.status === 'no') {
            await client.query(
              `delete from bus_bookings b using bus_routes r
                where b.bus_id = r.id and b.guest_id = $1 and r.wedding_id = $2`,
              [item.guestId, guest.weddingId],
            )
          }
          await client.query(
            `update guests set rsvp = $3, rsvp_at = now(),
                    comment = case when $4 then $5 else comment end,
                    diet = case when $6 then $7 else diet end,
                    diet_note = case when $8 then $9 else diet_note end,
                    transfer = case when $10 then $11 else transfer end,
                    plus_one = false
              where id = $1 and party_id = $2`,
            [
              item.guestId,
              guest.partyId,
              item.status,
              item.guestId === guest.guestId && has(body, 'comment'),
              body.comment ?? null,
              has(item, 'diet'),
              item.diet ?? null,
              has(item, 'diet') || has(item, 'dietNote'),
              item.dietNote ?? null,
              has(item, 'transfer'),
              item.transfer ?? null,
            ],
          )
        }

        /* Room belongs to the invitation, not to every person. Keep it while
         * at least one family member still attends. */
        const { rows: attending } = await client.query<{ n: string }>(
          "select count(*)::text as n from guests where party_id = $1 and rsvp = 'yes'",
          [guest.partyId],
        )
        if (Number(attending[0]!.n) === 0) {
          await client.query('delete from hotel_bookings where party_id = $1', [guest.partyId])
        }

        const { rows: counters } = await client.query<{ yes: string }>(
          "select count(*)::text as yes from guests where wedding_id = $1 and rsvp = 'yes'",
          [guest.weddingId],
        )
        await noteVendorUpdate(client, guest.weddingId, 'guests', `Гостей «приду»: ${counters[0]!.yes}`)

        const { rows: members } = await client.query<{
          id: string
          name: string
          rsvp: string
          diet: string | null
          diet_note: string | null
          transfer: string | null
        }>(
          `select id, name, rsvp, diet, diet_note, transfer
             from guests where party_id = $1 order by party_position, created_at, id`,
          [guest.partyId],
        )
        return members
      })

      const primary = result[0]!
      return {
        status: primary.rsvp,
        guestName: primary.name,
        members: result.map((m) => ({
          guestId: m.id,
          name: m.name,
          status: m.rsvp,
          diet: m.diet,
          dietNote: m.diet_note,
          transfer: m.transfer,
        })),
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
      const table = await db().tx(async (client) => {
        await lockSeatingAccess(client, request)
        const { rows: last } = await client.query<{ n: number }>(
          'select coalesce(max(sort), -1) + 1 as n from tables where wedding_id = $1',
          [weddingId],
        )
        const sort = last[0]!.n
        const id = uuidv7()
        await client.query('insert into tables (id, wedding_id, name, capacity, sort) values ($1,$2,$3,$4,$5)', [
          id, weddingId, body.name ?? `Стол ${sort + 1}`, body.capacity ?? 8, sort,
        ])
        const { rows } = await client.query<{ id: string; name: string; capacity: number }>(
          'select id, name, capacity from tables where id = $1', [id],
        )
        await assertSeatingToken(request)
        return { ...rows[0]!, guestIds: [] }
      })
      return reply.code(201).send(table)
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
        await lockSeatingAccess(client, request)
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
        await assertSeatingToken(request)
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
      await lockSeatingAccess(client, request)
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
      await assertSeatingToken(request)
    })
    return reply.code(204).send()
  })
}
