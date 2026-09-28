import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, forbidden, notFound, quotaExceeded } from '../errors.js'
import { isCheckViolation, type Queryable } from '../plugins/db.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { readKeyHeader } from '../deals/idempotency.js'
import { guestByToken } from '../guests/access.js'
import { expireHolds } from '../deals/repo.js'
import { COMMITTED_WITH_HOLD } from '../deals/state.js'
import { BUDGET_BY_VENDOR_CATEGORY, BUDGET_FALLBACK } from '../wedding/templates.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER
const rub = (amount: number) => ({ amount, currency: 'RUB' })

/**
 * Идентификаторы из адреса обязаны быть UUID — почему именно схемой и почему
 * 422, а не 404, написано у `UUID_ID` в `ids.ts`.
 *
 * Здесь важно одно: ненайденный подарок остаётся 404, но уже после обращения
 * к базе. 422 — про формат, 404 — про содержимое.
 */
const giftIdParam = { type: 'object', required: ['giftId'], properties: { giftId: UUID_ID } } as const
const fundIdParam = { type: 'object', required: ['fundId'], properties: { fundId: UUID_ID } } as const

/** Строка бюджета, куда попадает площадка: ориентир «банкет на гостя» считается по ней. */
const VENUE_BUDGET_ID = BUDGET_BY_VENDOR_CATEGORY['venue'] ?? BUDGET_FALLBACK

const money = {
  type: 'object',
  required: ['amount', 'currency'],
  additionalProperties: false,
  properties: {
    amount: { type: 'integer', minimum: 1, maximum: MONEY_MAX },
    currency: { type: 'string', enum: ['RUB'] },
  },
} as const

interface GiftRow {
  id: string
  name: string
  icon: string | null
  descr: string | null
  price: string
  currency: string
  is_group: boolean
  funded: string
  reserved: boolean
  mine: boolean
}

/**
 * Колонки подарка, которые уходят наружу.
 *
 * `guest_token` из `gift_reservations` здесь не читается ВООБЩЕ: резерв
 * сводится к `exists(...)`. Анонимность §9 держится не на том, что поле
 * забыли положить в ответ, а на том, что его значение не покидает базу.
 */
const GIFT_COLUMNS = `g.id, g.name, g.icon, g.descr, g.price::text as price, g.currency,
  g.is_group, g.funded::text as funded,
  exists(select 1 from gift_reservations r where r.gift_id = g.id) as reserved`

const toGift = (r: GiftRow, forGuest: boolean) => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  desc: r.descr,
  price: { amount: Number(r.price), currency: r.currency },
  group: r.is_group,
  funded: { amount: Number(r.funded), currency: r.currency },
  // Закрытая складчина — тот же «занято» для гостя: подарок больше не берут.
  reserved: r.reserved || Number(r.funded) >= Number(r.price),
  ...(forGuest ? { mine: r.mine } : {}),
})

interface FundRow {
  id: string
  name: string
  icon: string | null
  target: string
  collected: string
  currency: string
}

const toFund = (r: FundRow) => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  target: { amount: Number(r.target), currency: r.currency },
  collected: { amount: Number(r.collected), currency: r.currency },
})

async function loadWishlist(db: Queryable, weddingId: string, guestToken: string | null) {
  const { rows: gifts } = await db.query<GiftRow>(
    `select ${GIFT_COLUMNS},
            ($2::text is not null and exists(
               select 1 from gift_reservations r
                where r.gift_id = g.id and r.guest_token = $2)) as mine
       from gifts g where g.wedding_id = $1 order by g.created_at`,
    [weddingId, guestToken],
  )
  const { rows: funds } = await db.query<FundRow>(
    `select id, name, icon, target::text as target, collected::text as collected, currency
       from funds where wedding_id = $1 order by created_at`,
    [weddingId],
  )
  const { rows: anti } = await db.query<{ text: string }>(
    'select text from anti_gifts where wedding_id = $1 order by text',
    [weddingId],
  )
  return {
    gifts: gifts.map((g) => toGift(g, guestToken !== null)),
    funds: funds.map(toFund),
    antiGifts: anti.map((a) => a.text),
  }
}

/**
 * Гость идемпотентен по своему ключу, а не по общей таблице ключей.
 *
 * Общая таблица привязывает ключ к `userId`, которого у гостя нет: он ходит
 * по токену и аккаунта не имеет. Ключ лежит в самой таблице взносов и
 * уникален В ПРЕДЕЛАХ ГОСТЯ — глобальная уникальность означала бы, что
 * первый выбравший ключ «1» закрывает его всем остальным.
 */
function guestKey(request: FastifyRequest): string {
  return readKeyHeader(request, true)!
}

export async function giftRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /* ── вишлист глазами пары ─────────────────────────────────────────── */

  app.get('/weddings/:weddingId/wishlist', async (request) =>
    loadWishlist(db(), request.member!.weddingId, null),
  )

  app.post(
    '/weddings/:weddingId/wishlist',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'price'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            price: money,
            group: { type: 'boolean' },
            icon: { type: 'string', maxLength: 16 },
            desc: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string
        price: { amount: number }
        group?: boolean
        icon?: string
        desc?: string
      }
      const id = uuidv7()
      const { rows } = await db().query<Omit<GiftRow, 'reserved' | 'mine'>>(
        `insert into gifts (id, wedding_id, name, icon, descr, price, is_group)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, name, icon, descr, price::text as price, currency, is_group, funded::text as funded`,
        [
          id,
          request.member!.weddingId,
          body.name,
          body.icon ?? null,
          body.desc ?? null,
          body.price.amount,
          body.group ?? false,
        ],
      )
      // Новый подарок никем не занят и ни на рубль не собран — узнавать это
      // запросом незачем.
      return reply.code(201).send(toGift({ ...rows[0]!, reserved: false, mine: false }, false))
    },
  )

  app.patch(
    '/weddings/:weddingId/wishlist/:giftId',
    {
      schema: {
        params: giftIdParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            price: money,
            icon: { type: 'string', maxLength: 16 },
            desc: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (request) => {
      const { giftId } = request.params as { giftId: string }
      const body = request.body as { name?: string; price?: { amount: number }; icon?: string; desc?: string }
      try {
        const { rows } = await db().query<GiftRow>(
          `update gifts g set name = coalesce($3, name),
                              descr = coalesce($4, descr),
                              price = coalesce($5, price),
                              icon = coalesce($6, icon)
            where g.id = $2 and g.wedding_id = $1
            returning ${GIFT_COLUMNS}`,
          [
            request.member!.weddingId,
            giftId,
            body.name ?? null,
            body.desc ?? null,
            body.price?.amount ?? null,
            body.icon ?? null,
          ],
        )
        if (rows.length === 0) throw notFound('Подарок не найден')
        return toGift({ ...rows[0]!, mine: false }, false)
      } catch (error) {
        // Цена ниже собранного означала бы, что часть чужих денег исчезла.
        if (isCheckViolation(error, 'gifts_funded_bounded')) {
          throw conflict('gift_price_below_funded', 'В подарок уже сложились на большую сумму — цену ниже не поставить')
        }
        throw error
      }
    },
  )

  app.delete('/weddings/:weddingId/wishlist/:giftId', { schema: { params: giftIdParam } }, async (request, reply) => {
    const { giftId } = request.params as { giftId: string }
    /* Удаление унесло бы взносы каскадом. Деньги гостей пара не выбрасывает
     * одним тапом — сначала разбирается со складчиной (то же и у фонда).
     *
     * Условие «взносов нет» стоит в самом `delete`, а не в отдельном
     * `select` перед ним: между проверкой и удалением успевает прийти взнос,
     * и он уходил каскадом (D3-13). PostgreSQL перепроверяет `where` по
     * свежей версии строки — гонка закрывается одним оператором (R-49). */
    const removed = await db().query('delete from gifts where id = $1 and wedding_id = $2 and funded = 0', [
      giftId,
      request.member!.weddingId,
    ])
    if (removed.rowCount === 0) {
      const { rows } = await db().query('select 1 from gifts where id = $1 and wedding_id = $2', [
        giftId,
        request.member!.weddingId,
      ])
      if (rows.length === 0) throw notFound('Подарок не найден')
      throw conflict('gift_has_contributions', 'В подарок уже сложились — сначала верните взносы')
    }
    return reply.code(204).send()
  })

  app.put(
    '/weddings/:weddingId/anti-gifts',
    {
      schema: {
        body: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
    async (request) => {
      const weddingId = request.member!.weddingId
      // Список приходит целиком: он и есть значение. Повторы убирает Set,
      // порядок не хранится — на экране пункты стоят по алфавиту.
      const wanted = [...new Set((request.body as string[]).map((t) => t.trim()).filter(Boolean))]
      await db().tx(async (client) => {
        await client.query('delete from anti_gifts where wedding_id = $1', [weddingId])
        if (wanted.length > 0) {
          await client.query(
            'insert into anti_gifts (wedding_id, text) select $1, unnest($2::text[])',
            [weddingId, wanted],
          )
        }
      })
      return [...wanted].sort((a, b) => a.localeCompare(b, 'ru'))
    },
  )

  /* ── денежные фонды ───────────────────────────────────────────────── */

  app.post(
    '/weddings/:weddingId/funds',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'target'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            target: money,
            icon: { type: 'string', maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; target: { amount: number }; icon?: string }
      const id = uuidv7()
      const { rows } = await db().query<FundRow>(
        `insert into funds (id, wedding_id, name, icon, target) values ($1,$2,$3,$4,$5)
         returning id, name, icon, target::text as target, collected::text as collected, currency`,
        [id, request.member!.weddingId, body.name, body.icon ?? null, body.target.amount],
      )
      return reply.code(201).send(toFund(rows[0]!))
    },
  )

  app.delete('/weddings/:weddingId/funds/:fundId', { schema: { params: fundIdParam } }, async (request, reply) => {
    const { fundId } = request.params as { fundId: string }
    // То же, что у подарка: условие по деньгам — в самом `delete`.
    const removed = await db().query('delete from funds where id = $1 and wedding_id = $2 and collected = 0', [
      fundId,
      request.member!.weddingId,
    ])
    if (removed.rowCount === 0) {
      const { rows } = await db().query('select 1 from funds where id = $1 and wedding_id = $2', [
        fundId,
        request.member!.weddingId,
      ])
      if (rows.length === 0) throw notFound('Фонд не найден')
      throw conflict('fund_has_contributions', 'В фонд уже внесены деньги — удалить его нельзя')
    }
    return reply.code(204).send()
  })

  /* ── вишлист глазами гостя ────────────────────────────────────────── */

  app.get('/gifts/:guestToken', async (request) => {
    const { guestToken } = request.params as { guestToken: string }
    const guest = await guestByToken(db(), guestToken)
    const list = await loadWishlist(db(), guest.weddingId, guestToken)
    return { ...list, fairPrice: await fairPrice(guest.weddingId) }
  })

  /**
   * «Банкет на гостя» — деликатный ориентир из §10.10: расходы по строке
   * «Площадка и кейтеринг», делённые на число отдельных персон.
   *
   * Считается тем же способом, что и бюджет пары (мягкая бронь входит в
   * обязательства): два экрана про одни деньги не должны показывать разные
   * числа — ровно это уже случилось во фронте (ERR-0012).
   */
  async function fairPrice(weddingId: string): Promise<{ amount: number; currency: string } | null> {
    await expireHolds(db(), weddingId)
    const { rows: deals } = await db().query<{ category_id: string; amount: string }>(
      `select s.category_id, sum(d.price)::text as amount
         from deals d join slots s on s.id = d.slot_id
        where d.wedding_id = $1 and d.state = any($2) and d.price is not null
        group by s.category_id`,
      [weddingId, COMMITTED_WITH_HOLD],
    )
    const fromSlots = deals
      .filter((r) => (BUDGET_BY_VENDOR_CATEGORY[r.category_id] ?? BUDGET_FALLBACK) === VENUE_BUDGET_ID)
      .reduce((sum, r) => sum + Number(r.amount), 0)

    const { rows } = await db().query<{ items: string; guests: string }>(
      `select coalesce((select sum(amount) from budget_items
                         where wedding_id = $1 and category_id = $2), 0)::text as items,
              (select count(*) from guests where wedding_id = $1)::text as guests`,
      [weddingId, VENUE_BUDGET_ID],
    )
    const venue = fromSlots + Number(rows[0]!.items)
    const guests = Number(rows[0]!.guests)
    // 020: guests are real persons; a family invitation is never added again.
    // Нет расходов или некому делить — подсказки нет. Ноль на экране гостя
    // читался бы как «дарить нечего», а выдуманное число — хуже молчания.
    if (venue <= 0 || guests <= 0) return null
    return rub(Math.round(venue / guests))
  }

  /* ── резерв ───────────────────────────────────────────────────────── */

  app.post('/gifts/:guestToken/:giftId/reserve', { schema: { params: giftIdParam } }, async (request, reply) => {
    const { guestToken, giftId } = request.params as { guestToken: string; giftId: string }
    // Контракт объявляет заголовок обязательным. Повтор здесь безопасен и
    // без него — резерв держит первичный ключ, — но обещанное проверяем.
    guestKey(request)
    const guest = await guestByToken(db(), guestToken)

    const body = await db().tx(async (client) => {
      /* Gift identity belongs to the family invitation. Lock the party
       * before counting its reservations so two tabs (or two family members)
       * cannot spend separate quotas under one shared invite token. */
      await client.query('select 1 from guest_parties where id = $1 for update', [guest.partyId])
      const { rows } = await client.query<{ funded: string; price: string }>(
        'select funded::text as funded, price::text as price from gifts where id = $1 and wedding_id = $2 for update',
        [giftId, guest.weddingId],
      )
      if (rows.length === 0) throw notFound('Подарок не найден')
      // Резерв и складчина исключают друг друга: иначе один гость забирает
      // подарок, в который уже сложились двое, и их деньги повисают.
      if (Number(rows[0]!.funded) > 0) {
        throw conflict('gift_has_contributions', 'В этот подарок уже складываются — его нельзя забрать целиком')
      }

      // Подарок под блокировкой, так что чей он сейчас — уже известно точно.
      const { rows: held } = await client.query<{ guest_token: string }>(
        'select guest_token from gift_reservations where gift_id = $1',
        [giftId],
      )
      if (held[0]) {
        // Тот же гость нажал второй раз — подарок его, это не отказ и не новый резерв.
        if (held[0].guest_token === guestToken) return { giftId, reserved: true, mine: true }
        throw conflict('gift_reserved', 'Этот подарок уже выбрал другой гость')
      }

      /* Предел резервов на семейное приглашение — по образцу взносов.
       * Без него одна семья забирала весь список: пара видела «Зарезервирован»
       * у всего, снять чужой резерв не могла (§9) и не знала, кто это. */
      const { rows: mine } = await client.query<{ n: string }>(
        `select count(*)::text as n from gift_reservations r join gifts g on g.id = r.gift_id
          where g.wedding_id = $1 and r.guest_token = $2`,
        [guest.weddingId, guestToken],
      )
      // Предел — из конфигурации (`RESERVATIONS_MAX_PER_GUEST`), как у альбома и взносов (фича 014, A17).
      const maxReservations = app.appConfig.reservationsMaxPerGuest
      if (Number(mine[0]!.n) >= maxReservations) {
        throw quotaExceeded(
          'reservation_limit',
          `Больше ${maxReservations} подарков одно приглашение не резервирует — снимите лишний резерв`,
        )
      }

      const taken = await client.query(
        'insert into gift_reservations (gift_id, guest_token) values ($1,$2) on conflict (gift_id) do nothing',
        [giftId, guestToken],
      )
      // Ноль строк при блокировке подарка — только чужая запись мимо кода.
      if (taken.rowCount === 0) throw conflict('gift_reserved', 'Этот подарок уже выбрал другой гость')
      return { giftId, reserved: true, mine: true }
    })
    return reply.code(200).send(body)
  })

  app.delete('/gifts/:guestToken/:giftId/reserve', { schema: { params: giftIdParam } }, async (request, reply) => {
    const { guestToken, giftId } = request.params as { guestToken: string; giftId: string }
    const guest = await guestByToken(db(), guestToken)
    /* Владелец резерва — условие в самом `delete`, а не в `select` перед
     * ним: пока запрос ждал блокировки, резерв мог сменить хозяина (тот же
     * гость снял его в другой вкладке, подарок занял другой), и удаление
     * «по подарку» стирало чужой резерв (D3-13). */
    const removed = await db().query(
      `delete from gift_reservations r using gifts g
        where r.gift_id = g.id and r.gift_id = $1 and g.wedding_id = $2 and r.guest_token = $3`,
      [giftId, guest.weddingId, guestToken],
    )
    if (removed.rowCount === 0) {
      const { rows } = await db().query<{ guest_token: string }>(
        `select r.guest_token from gift_reservations r join gifts g on g.id = r.gift_id
          where r.gift_id = $1 and g.wedding_id = $2`,
        [giftId, guest.weddingId],
      )
      // Резерва нет — снимать нечего, и это не ошибка: повтор отмены проходит.
      if (rows[0] && rows[0].guest_token !== guestToken) throw forbidden('Этот резерв поставил другой гость')
    }
    return reply.code(204).send()
  })

  /* ── складчина и фонды ────────────────────────────────────────────── */

  app.post(
    '/gifts/:guestToken/:giftId/fund',
    {
      schema: {
        params: giftIdParam,
        body: { type: 'object', required: ['amount'], additionalProperties: false, properties: { amount: money } },
      },
    },
    async (request) => {
      const { guestToken, giftId } = request.params as { guestToken: string; giftId: string }
      const amount = (request.body as { amount: { amount: number } }).amount.amount
      const key = guestKey(request)
      const guest = await guestByToken(db(), guestToken)

      return db().tx(async (client) => {
        const { rows } = await client.query<{ is_group: boolean; funded: string; price: string }>(
          `select is_group, funded::text as funded, price::text as price
             from gifts where id = $1 and wedding_id = $2 for update`,
          [giftId, guest.weddingId],
        )
        if (rows.length === 0) throw notFound('Подарок не найден')
        const gift = rows[0]!
        if (!gift.is_group) throw conflict('gift_not_group', 'В этот подарок нельзя складываться — он дарится целиком')

        const { rows: held } = await client.query('select 1 from gift_reservations where gift_id = $1', [giftId])
        if (held.length > 0) throw conflict('gift_reserved', 'Подарок уже выбрал другой гость')
        if (Number(gift.funded) >= Number(gift.price)) throw conflict('gift_closed', 'На подарок уже собрали всю сумму')

        await claimContribution(client, 'gift', giftId, guestToken, amount, key)

        const { rows: after } = await client.query<GiftRow>(
          `select ${GIFT_COLUMNS},
                  exists(select 1 from gift_reservations r
                          where r.gift_id = g.id and r.guest_token = $2) as mine
             from gifts g where g.id = $1`,
          [giftId, guestToken],
        )
        return toGift(after[0]!, true)
      }).catch(overfunded('gifts_funded_bounded', 'gift_overfunded', 'Столько уже не нужно — до цены осталось меньше'))
    },
  )

  app.post(
    '/gifts/:guestToken/funds/:fundId',
    {
      schema: {
        params: fundIdParam,
        body: { type: 'object', required: ['amount'], additionalProperties: false, properties: { amount: money } },
      },
    },
    async (request) => {
      const { guestToken, fundId } = request.params as { guestToken: string; fundId: string }
      const amount = (request.body as { amount: { amount: number } }).amount.amount
      const key = guestKey(request)
      const guest = await guestByToken(db(), guestToken)

      return db().tx(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'select id from funds where id = $1 and wedding_id = $2 for update',
          [fundId, guest.weddingId],
        )
        if (rows.length === 0) throw notFound('Фонд не найден')

        await claimContribution(client, 'fund', fundId, guestToken, amount, key)

        const { rows: after } = await client.query<FundRow>(
          `select id, name, icon, target::text as target, collected::text as collected, currency
             from funds where id = $1`,
          [fundId],
        )
        return toFund(after[0]!)
      })
    },
  )

  /**
   * Записывает взнос ровно один раз.
   *
   * Порядок шагов важен. Сначала повтор по ключу: гость, упёршийся в предел,
   * на повторе своего же запроса должен получить свой ответ, а не отказ —
   * иначе идемпотентность перестаёт работать ровно там, где она нужнее
   * всего. Только потом счёт взносов, и лишь затем запись.
   *
   * Предел нужен, потому что ключ придумывает клиент: новый ключ на каждый
   * рубль растит таблицу без предела (ERR-0042 — то же самое в альбоме).
   */
  async function claimContribution(
    client: Queryable,
    kind: 'gift' | 'fund',
    targetId: string,
    guestToken: string,
    amount: number,
    key: string,
  ): Promise<void> {
    const table = kind === 'gift' ? 'gift_contributions' : 'fund_contributions'
    const column = kind === 'gift' ? 'gift_id' : 'fund_id'

    const sameKey = async () => {
      const { rows } = await client.query<{ target: string; amount: string }>(
        `select ${column} as target, amount::text as amount from ${table}
          where guest_token = $1 and idempotency_key = $2`,
        [guestToken, key],
      )
      return rows[0] ?? null
    }

    // Тот же ключ на ДРУГОЙ взнос — ошибка клиента: молча вернуть старый
    // ответ значило бы потерять второй взнос.
    const seen = await sameKey()
    if (seen) {
      if (seen.target !== targetId || Number(seen.amount) !== amount) {
        throw new AppError(409, 'idempotency_key_reused', 'Этот Idempotency-Key уже использован для другого взноса')
      }
      return
    }

    const { rows: count } = await client.query<{ n: string }>(
      `select count(*)::text as n from ${table} where ${column} = $1 and guest_token = $2`,
      [targetId, guestToken],
    )
    if (Number(count[0]!.n) >= app.appConfig.contributionsMaxPerGuest) {
      throw quotaExceeded(
        'contribution_limit',
        `Больше ${app.appConfig.contributionsMaxPerGuest} взносов от одного гостя не принимаем`,
      )
    }

    const added = await client.query(
      `insert into ${table} (id, ${column}, guest_token, amount, idempotency_key)
       values ($1,$2,$3,$4,$5) on conflict (guest_token, idempotency_key) do nothing`,
      [uuidv7(), targetId, guestToken, amount, key],
    )
    // Ноль строк здесь — гонка: тот же ключ успел записаться параллельно.
    if (added.rowCount === 0) {
      const race = await sameKey()
      if (!race || race.target !== targetId || Number(race.amount) !== amount) {
        throw new AppError(409, 'idempotency_key_reused', 'Этот Idempotency-Key уже использован для другого взноса')
      }
    }
  }

  /** Переполнение ловит ограничение базы — обработчик переводит его в 409. */
  function overfunded(constraint: string, code: string, message: string) {
    return (error: unknown): never => {
      if (isCheckViolation(error, constraint)) throw conflict(code, message)
      throw error
    }
  }
}
