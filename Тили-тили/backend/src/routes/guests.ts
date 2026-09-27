import type { FastifyInstance } from 'fastify'
import { AppError, conflict, gone, notFound } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import { plural } from '../text/plural.js'
import type { Queryable } from '../plugins/db.js'
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
  name: string
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
  g.id, g.name, g.plus_one, g.group_name, g.phone, g.comment, g.rsvp, g.table_id, g.diet, g.diet_note,
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
 *
 * Телефон и комментарий из RSVP — тоже только паре (фича 005, В6; 152-ФЗ,
 * минимизация): напоминания шлёт пара, а помощнику и координатору сам
 * номер не нужен — им приходит `hasPhone`, чтобы видеть, кому напоминание
 * не уйдёт. Комментарий гость пишет паре, а не команде.
 */
export function toGuest(r: GuestRow, asCouple: boolean) {
  return {
    id: r.id,
    name: r.name,
    plusOne: r.plus_one,
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

/** 020: одна строка guests = одна реальная персона. plusOne больше не множит счётчики. */
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
            group: { type: 'string', maxLength: 120 },
            phone: { type: 'string', maxLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; plusOne?: boolean; group?: string; phone?: string }
      assertPhoneByCouple(request.member!.role, body.phone !== undefined)
      /* Телефон — к виду `+7XXXXXXXXXX`, как у импорта: сырой «8 917 000-55-66»
       * не совпадал с нормализованным у дедупликации импорта и уходил
       * провайдеру SMS как есть (ревью 015). Не российский или неполный — 422. */
      const phone = normalizedPhoneOr422(body.phone)
      const id = uuidv7()
      await db().tx(async (client) => {
        const { rows } = await client.query<{ invitation_id: string }>(
          `insert into guests (id, wedding_id, name, plus_one, group_name, phone, rsvp_token)
           values ($1, $2, $3, false, $4, $5, $6)
           returning invitation_id`,
          [id, request.member!.weddingId, body.name, body.group ?? null, phone, newGuestToken()],
        )
        /* 020 compatibility: old clients can still send plusOne=true, but it
         * becomes a visible second person in the same invitation instead of a
         * hidden multiplier. Personal menu/seat/transport/hotel are not copied. */
        if (body.plusOne === true) {
          await client.query(
            `insert into guests (id, wedding_id, name, plus_one, group_name, rsvp_token, invitation_id)
             values ($1, $2, $3, false, $4, $5, $6)`,
            [uuidv7(), request.member!.weddingId, `Гость ${body.name}`, body.group ?? null, newGuestToken(), rows[0]!.invitation_id],
          )
        }
      })
      return reply.code(201).send(await loadGuest(db(), id, request.member!.role))
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
        guests: { name: string; phone?: string; plusOne?: boolean; group?: string }[]
      }
      assertPhoneByCouple(request.member!.role, guests.some((g) => g.phone !== undefined))
      const skipped: { index: number; name: string; reason: 'duplicate' | 'invalid' }[] = []
      const createdIds: string[] = []

      /* Одна транзакция под замком строки свадьбы: два одновременных импорта
       * одного списка иначе прошли бы обе проверки на дубликаты и завели гостей
       * дважды (R-49). Дубликат — совпадение имени без регистра и лишних пробелов
       * или телефона: с уже заведёнными гостями и с более ранней строкой того же
       * списка. Дубликаты пропускаются, не обновляются: импорт заводит, а не
       * правит — правка у каждого гостя своя (`PATCH …/guests/{id}`). */
      await db().tx(async (client) => {
        await client.query('select id from weddings where id = $1 for update', [weddingId])
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
          if (nameKey.length < 2 || names.has(nameKey) || (phone && phones.has(phone))) {
            skipped.push({ index, name: row.name, reason: nameKey.length < 2 ? 'invalid' : 'duplicate' })
            continue
          }
          names.add(nameKey)
          if (phone) phones.add(phone)
          const id = uuidv7()
          const normalizedName = row.name.trim().replace(/\s+/g, ' ')
          const { rows: inserted } = await client.query<{ invitation_id: string }>(
            `insert into guests (id, wedding_id, name, plus_one, group_name, phone, rsvp_token)
             values ($1, $2, $3, false, $4, $5, $6)
             returning invitation_id`,
            [id, weddingId, normalizedName, row.group ?? null, phone ?? null, newGuestToken()],
          )
          createdIds.push(id)
          if (row.plusOne === true) {
            const companionId = uuidv7()
            await client.query(
              `insert into guests (id, wedding_id, name, plus_one, group_name, rsvp_token, invitation_id)
               values ($1, $2, $3, false, $4, $5, $6)`,
              [companionId, weddingId, `Гость ${normalizedName}`, row.group ?? null, newGuestToken(), inserted[0]!.invitation_id],
            )
            createdIds.push(companionId)
          }
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
      assertPhoneByCouple(request.member!.role, has('phone'))
      // Телефон — к одному виду (см. POST); `null` — стереть, как и было.
      const phone = body.phone === null ? null : normalizedPhoneOr422(body.phone as string | undefined)

      /* Правка гостя, посадка и освобождение мест — одна транзакция (R-122):
       * «не придёт» с сиденьем в автобусе, оставшимся за гостем, — состояние,
       * которого не бывает в норме. */
      return db().tx(async (client) => {
        /* Строка гостя — первой, до стола и до броней: тот же порядок замков,
         * что у посадки в автобус (гость → маршрут, RF-BE-06). Заодно 404
         * до любых проверок: чужого гостя дальше не пускаем. */
        const { rows: locked } = await client.query('select 1 from guests where id = $1 and wedding_id = $2 for update', [
          guestId,
          weddingId,
        ])
        if (locked.length === 0) throw notFound('Гость не найден')

        /* Вместимость стола проверяется и при пересадке, и при «+1» без
         * пересадки: гость уже сидит, а «+1» добавляет за столом персону
         * (ревью 015) — стол заявляется сразу с текущим `table_id`. */
        const tableToCheck = body.tableId as string | undefined
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

          /* Вместимость считается в персонах, а не в записях (R-29): «Ольга
           * и Денис» с плюс-одним — двое за столом, как их считает кейтеринг
           * на соседнем экране. Сам гость исключается из уже сидящих (он мог
           * пересаживаться в пределах этого же стола) и добавляется с тем
           * `plusOne`, который придёт вместе с посадкой. */
          const { rows: seated } = await client.query<{ persons: string }>(
            `select count(*) filter (where o.id <> $3)::text as persons
               from guests o
              where o.wedding_id = $2 and o.table_id = $1`,
            [tableToCheck, weddingId, guestId],
          )
          const total = Number(seated[0]!.persons) + 1
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
          await client.query(
            `delete from hotel_bookings b using hotel_blocks h
              where b.hotel_id = h.id and b.guest_id = $1 and h.wedding_id = $2`,
            [guestId, weddingId],
          )
        }

        const res = await client.query(
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
        if (res.rowCount === 0) throw notFound('Гость не найден')

        if (body.plusOne === true) {
          const { rows: invitation } = await client.query<{ invitation_id: string; n: string }>(
            `select g.invitation_id,
                    (select count(*)::text from guests x where x.invitation_id = g.invitation_id) as n
               from guests g where g.id = $1`,
            [guestId],
          )
          if (invitation[0] && Number(invitation[0].n) === 1) {
            const { rows: current } = await client.query<{ name: string; group_name: string | null }>(
              'select name, group_name from guests where id = $1',
              [guestId],
            )
            await client.query(
              `insert into guests (id, wedding_id, name, plus_one, group_name, rsvp_token, invitation_id)
               values ($1, $2, $3, false, $4, $5, $6)`,
              [uuidv7(), weddingId, `Гость ${current[0]!.name}`, current[0]!.group_name, newGuestToken(), invitation[0].invitation_id],
            )
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

    const { rows } = await db().query('select 1 from guests where id = $1 and wedding_id = $2', [guestId, weddingId])
    if (rows.length === 0) throw notFound('Гость не найден')

    return db().tx(async (client) => {
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
       * попросит новую, и подмена станет видна.
       *
       * Отзыв гостя ключуется самим гостем (`reviews.guest_id`, фича 005), а
       * не токеном: переносить его за новой ссылкой больше не нужно — пара,
       * выпускающая ссылки, гостевых голосов в рейтинг не множит (D3-09). */
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
    const claimed = await db().query<{ guest_id: string }>(
      `update guest_invite_codes c set used_at = coalesce(c.used_at, now())
        from guests g join weddings w on w.id = g.wedding_id
        where c.code = $1 and c.expires_at > now() and g.id = c.guest_id
          and w.cancelled_at is null and w.archived_at is null
          and (c.used_at is null or c.used_at > now() - make_interval(mins => $2))
        returning c.guest_id`,
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
      tz: string
    }>(
      `select g.rsvp, g.plus_one, g.diet, g.diet_note, g.transfer,
              w.title, w.date::text as date, c.name as city, c.region,
              w.invite_text, w.invite_theme_id, w.venue, w.dress_code, w.dress_note,
              coalesce(w.tz, 'Europe/Moscow') as tz
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
        /* Пояс места (`WeddingPublic.tz`): раздел «День свадьбы» на экране гостя
         * появляется с кануна по нему, а не по поясу телефона (фича 009); пустой
         * пояс — Москва, как у остальных гостевых путей. */
        tz: r.tz,
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
        /* Строка гостя — первой: тот же порядок замков, что у посадки в
         * автобус (гость → маршрут, RF-BE-06). «Не приду» — значит держать
         * под него сиденье и номер незачем; освобождаются ДО записи ответа:
         * с «+1» в том же теле у гостя из полного автобуса база иначе
         * отказала бы тому, кто место как раз освобождает. Счётчики
         * поправит триггер: он считает по факту строк. */
        await client.query('select 1 from guests where id = $1 for update', [guest.guestId])
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
        await client.query(
          `update guests set rsvp = $2, rsvp_at = now(),
                  plus_one = false,
                  comment = coalesce($3, comment),
                  diet = case when $4 then $5 else diet end,
                  diet_note = case when $6 then $7 else diet_note end,
                  transfer = coalesce($8, transfer)
            where id = $1`,
          [
            guest.guestId,
            body.status,
            (body.comment as string) ?? null,
            has('diet'),
            (body.diet as string) ?? null,
            has('diet') || has('dietNote'),
            (body.dietNote as string) ?? null,
            (body.transfer as string) ?? null,
          ],
        )

        if (body.plusOne === true) {
          const { rows: invitation } = await client.query<{ invitation_id: string; n: string; name: string; group_name: string | null }>(
            `select g.invitation_id, g.name, g.group_name,
                    (select count(*)::text from guests x where x.invitation_id = g.invitation_id) as n
               from guests g where g.id = $1`,
            [guest.guestId],
          )
          if (invitation[0] && Number(invitation[0].n) === 1) {
            await client.query(
              `insert into guests (id, wedding_id, name, plus_one, group_name, rsvp_token, invitation_id)
               values ($1, $2, $3, false, $4, $5, $6)`,
              [uuidv7(), guest.weddingId, `Гость ${invitation[0].name}`, invitation[0].group_name, newGuestToken(), invitation[0].invitation_id],
            )
          }
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
