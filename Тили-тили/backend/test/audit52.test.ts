/*
 * F2 (review016-tail6, F-RL-2-03) — `CHECK (currency = 'RUB')` на всех денежных
 * таблицах. На `c24d211` в схеме 13 таблиц с колонкой `currency`; проверенная
 * CHECK стоит только у четырёх (`weddings`, `vendors`, `gifts`, `funds`) —
 * девять остаются без неё: `referral_uses`, `vendor_packages`,
 * `concierge_requests`, `deals`, `payments`, `budget_items`, `hotel_blocks`,
 * `gift_contributions`, `fund_contributions` (ROADMAP.md F2). Живая база и
 * API уже держат только RUB — правило добавляется в схему, а не в код.
 *
 * T1 — сторож схемы: список таблиц с `currency` выводится из
 * `information_schema` (а не зашит явно — ловит и будущую таблицу), и его
 * длина обязана быть 15. На каждой из них обязана быть РОВНО ОДНА проверенная
 * (`convalidated`) CHECK с ТОЧНЫМ определением `currency = 'RUB'`
 * (`pg_get_constraintdef(...) = "CHECK ((currency = 'RUB'::bpchar))"`),
 * завязанная только на колонку `currency` (`conkey`), и названная
 * `<table>_currency_rub`. Точное совпадение — не `LIKE '%currency = ''RUB''%'`
 * (G6 evidence F2-G6.txt P3b): слабую проверку вида `... OR ...` или на
 * другой колонке такой LIKE пропустил бы, а точное сравнение — нет.
 * T2 — поведение на живых данных: строки своих `deals`/`payments`/
 * `budget_items`, заведённые через API, не дают подмену валюты прямым SQL —
 * база отвечает `23514`. Обновление всегда идёт в транзакции, которая
 * откатывается сама (см. `updateRolledBack`) — до миграции запрос ещё
 * проходит без ошибки, и голый неоформленный запрос в этом случае просто
 * закоммитился бы, оставив чужую валюту в общей базе навсегда.
 * T3 — то же поведение на всех 15 (G6 evidence F2-G6.txt P3c: T2 покрывал
 * только 3/15). Минимальный `INSERT` с `currency = 'USD'` на каждой из 15
 * таблиц, внутри одной внешней транзакции с SAVEPOINT на таблицу. Внешние
 * ключи — заведомо несуществующие uuid: PostgreSQL проверяет их
 * AFTER-триггером ПОСЛЕ `ExecConstraints` (NOT NULL/CHECK), так что
 * настоящие родительские строки (свадьба, пользователь, подрядчик, слот…)
 * не нужны — CHECK по валюте обрывает INSERT первым. Остальные колонки
 * подобраны так, чтобы упасть могла только эта проверка: любая другая
 * ложная CHECK замаскировала бы результат под чужой код ошибки.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/*
 * `| undefined` явно в типе поля — не ослабление, а точность под
 * `exactOptionalPropertyTypes: true` (backend/tsconfig.json): без него
 * `{ code: e.code, constraint: e.constraint }` не компилируется (TS2375),
 * потому что `e.code`/`e.constraint` читаются как `string | undefined`
 * (объект — не обязательно настоящая pg-ошибка), а поле `code?: string`
 * запрещает присвоить туда именно `undefined`, разрешая только отсутствие
 * ключа целиком. Тот же приём — `errorCode(): string | undefined` в
 * `src/plugins/db.ts` (G6 evidence F2-G6.txt P3a).
 */
interface PgError {
  code?: string | undefined
  constraint?: string | undefined
}
describe.skipIf(!live)("F2 · F-RL-2-03: CHECK (currency = 'RUB') на всех денежных таблицах", () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259). */
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
    for (let i = 0; i < 20; i++) {
      const { rows } = await app.db!.query('select 1 from users where phone like $1 limit 1', [`+79${RUN}%`])
      if (rows.length === 0) break
      RUN = String(randomInt(100_000, 1_000_000))
    }
  })

  afterAll(async () => {
    await app?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  /**
   * Обновление в транзакции, которая ВСЕГДА откатывается — и при ошибке,
   * и при успехе.
   *
   * Этот тест обязан покраснеть ДО миграции (§4.1 — red-first): пока
   * проверки в схеме нет, `update … set currency = 'USD'` проходит без
   * ошибки. Голый нео́рамленный запрос (как в audit33/audit38, где проверка
   * уже есть в коде на момент их написания) в этом случае просто
   * коммитится сам по себе — implicit-транзакция одного запроса откатывает
   * только НЕУДАЧУ, а удачную подмену валюты оставляет в общей базе
   * навсегда. Откат здесь обязателен независимо от исхода запроса.
   */
  async function updateRolledBack(sql: string, params: unknown[]): Promise<PgError> {
    let result: PgError = {}
    const rollbackSentinel = new Error('audit52: intentional rollback')
    try {
      await app.db!.tx(async (client) => {
        try {
          await client.query(sql, params)
        } catch (error) {
          const e = error as PgError
          result = { code: e.code, constraint: e.constraint }
        }
        throw rollbackSentinel
      })
    } catch (error) {
      if (error !== rollbackSentinel) throw error
    }
    return result
  }

  async function newUser() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: body.accessToken, userId: body.user.id }
  }

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  describe("T1 · сторож схемы: каждая таблица с currency несёт проверенную CHECK currency = 'RUB'", () => {
    it('информационная схема: ровно 15 таблиц с currency, у каждой — ровно одна точная CHECK', async () => {
      const { rows: tables } = await app.db!.query<{ table_name: string }>(
        `select table_name
           from information_schema.columns
          where table_schema = 'public' and column_name = 'currency'
          order by table_name`,
      )
      // Список выводится из схемы, а не зашит явно — сам подхватит будущую
      // таблицу. Но количество — часть проверки: молчаливое появление новой
      // денежной таблицы обязано остановить тест, а не проскочить незамеченным.
      // 14-я и 15-я — offer_requests и offers из 019.
      expect(tables.map((r) => r.table_name)).toHaveLength(15)

      const EXACT_DEF = "CHECK ((currency = 'RUB'::bpchar))"
      const { rows: allChecks } = await app.db!.query<{
        table_name: string
        conname: string
        convalidated: boolean
        def: string
        columns: string[] | null
      }>(
        `select u.table_name,
                con.conname,
                con.convalidated,
                pg_get_constraintdef(con.oid) as def,
                -- ::text обязателен: array_agg(a.attname) без него — это name[] (OID 1003),
                -- для которого у node-postgres нет типового парсера (есть только для text[],
                -- OID 1009) — драйвер вернул бы '{currency}' СТРОКОЙ, а не JS-массивом, и
                -- cols.length/cols[0] ниже никогда бы не совпали ни на одной таблице.
                (select array_agg(a.attname::text order by a.attnum)
                   from pg_attribute a
                  where a.attrelid = con.conrelid and a.attnum = any(con.conkey)) as columns
           from unnest($1::text[]) as u(table_name)
           join pg_constraint con
             on con.conrelid = ('public.' || u.table_name)::regclass
            and con.contype = 'c'
          order by u.table_name, con.conname`,
        [tables.map((r) => r.table_name)],
      )

      const byTable = new Map<string, typeof allChecks>()
      for (const row of allChecks) {
        byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row])
      }

      // Точное совпадение определения, конвалидированность и то, что CHECK
      // держит ТОЛЬКО колонку currency (conkey) — слабая проверка вида
      // `... OR ...`, составной CHECK или CHECK на другой колонке сюда не
      // попадёт (прежний `LIKE '%currency = ''RUB''%'` такую принял бы).
      const actual = tables.map((t) => {
        const matches = (byTable.get(t.table_name) ?? []).filter((c) => {
          const cols = c.columns ?? []
          return c.def === EXACT_DEF && c.convalidated && cols.length === 1 && cols[0] === 'currency'
        })
        return { table: t.table_name, matchCount: matches.length, conname: matches[0]?.conname ?? null }
      })
      expect(actual).toEqual(
        tables.map((t) => ({ table: t.table_name, matchCount: 1, conname: `${t.table_name}_currency_rub` })),
      )
    })
  })

  describe("T2 · поведение: свои строки deals/payments/budget_items не принимают валюту не RUB", () => {
    it('прямой UPDATE currency = USD по своим строкам — 23514, ничего не меняется', async () => {
      const w = await newWedding()

      // Статья бюджета — через API.
      const item = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/budget/items`,
        headers: auth(w.token),
        payload: { title: 'Аренда лимузина', categoryId: 'b4', amount: { amount: 1_500_000, currency: 'RUB' } },
      })
      expect(item.statusCode, item.body.slice(0, 200)).toBe(201)
      const budgetItemId = item.json().id as string

      // Слот «Фотограф» — из шаблона мозаики, заведённого автоматически при создании свадьбы.
      const { rows: slotRows } = await app.db!.query<{ id: string }>(
        `select id from slots where wedding_id = $1 and category_id = 'photo'`,
        [w.weddingId],
      )
      expect(slotRows).toHaveLength(1)
      const slotId = slotRows[0]!.id

      // Бронь своего подрядчика — через API (создаёт строку deals).
      const booked = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
        headers: auth(w.token),
        payload: { vendorName: 'Свой фотограф', price: { amount: 5_000_000, currency: 'RUB' } },
      })
      expect(booked.statusCode, booked.body.slice(0, 200)).toBe(200)
      const { rows: dealRows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [
        slotId,
      ])
      expect(dealRows).toHaveLength(1)
      const dealId = dealRows[0]!.id

      // Оплата — через API (создаёт строку payments).
      const paid = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slotId}/pay`,
        headers: { ...auth(w.token), 'idempotency-key': randomUUID() },
        payload: {},
      })
      expect(paid.statusCode, paid.body.slice(0, 200)).toBe(200)
      const { rows: paymentRows } = await app.db!.query<{ id: string }>(
        'select id from payments where deal_id = $1',
        [dealId],
      )
      expect(paymentRows).toHaveLength(1)
      const paymentId = paymentRows[0]!.id

      expect(
        await updateRolledBack('update deals set currency = $1 where id = $2', ['USD', dealId]),
      ).toEqual({ code: '23514', constraint: 'deals_currency_rub' })
      expect(
        await updateRolledBack('update payments set currency = $1 where id = $2', ['USD', paymentId]),
      ).toEqual({ code: '23514', constraint: 'payments_currency_rub' })
      expect(
        await updateRolledBack('update budget_items set currency = $1 where id = $2', ['USD', budgetItemId]),
      ).toEqual({ code: '23514', constraint: 'budget_items_currency_rub' })

      // Ни один UPDATE не остался в силе: транзакция откатывается всегда,
      // независимо от того, упал запрос или прошёл (см. updateRolledBack).
      const after = await app.db!.query<{ currency: string }>(
        `select (select currency from deals where id = $1) as deal_cur,
                (select currency from payments where id = $2) as pay_cur,
                (select currency from budget_items where id = $3) as item_cur`,
        [dealId, paymentId, budgetItemId],
      )
      const row = after.rows[0] as unknown as { deal_cur: string; pay_cur: string; item_cur: string }
      expect(row.deal_cur.trim()).toBe('RUB')
      expect(row.pay_cur.trim()).toBe('RUB')
      expect(row.item_cur.trim()).toBe('RUB')
    })
  })

  describe('T3 · поведение на всех 15: минимальный INSERT с валютой ≠ RUB — своя CHECK, ничего не остаётся', () => {
    /**
     * Одна минимальная строка на каждую из 15 таблиц: `currency` сразу
     * 'USD', остальные колонки — ровно то, что нужно, чтобы упасть могла
     * ТОЛЬКО проверка валюты (амаунты положительные, kind/category —
     * допустимые, `deals_has_performer` закрыт через `external_name`).
     * Внешние ключи — заведомо несуществующие uuid/тексты: если бы CHECK не
     * сработал первым, INSERT упал бы с чужим кодом ошибки (FK), а не 23514 —
     * тест это отличил бы. Каждая попытка — свой SAVEPOINT внутри одной
     * внешней транзакции, которая сама всегда откатывается (тот же приём,
     * что в `updateRolledBack`) — ни одна строка не остаётся в базе.
     */
    function probes(): Array<{ table: string; sql: string; params: unknown[] }> {
      const id = () => randomUUID()
      const token = () => randomUUID()
      return [
        {
          table: 'weddings',
          sql: `insert into weddings (id, owner_id, title, currency, invite_code) values ($1, $2, 'F2 probe', 'USD', $3)`,
          params: [id(), id(), `f2-probe-${token()}`],
        },
        {
          table: 'vendors',
          sql: `insert into vendors (id, user_id, category_id, name, currency) values ($1, $2, 'f2-probe-category', 'F2 probe', 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'gifts',
          sql: `insert into gifts (id, wedding_id, name, price, currency) values ($1, $2, 'F2 probe', 100, 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'funds',
          sql: `insert into funds (id, wedding_id, name, target, currency) values ($1, $2, 'F2 probe', 100, 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'budget_items',
          sql: `insert into budget_items (id, wedding_id, title, category_id, amount, currency) values ($1, $2, 'F2 probe', 'b4', 100, 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'concierge_requests',
          sql: `insert into concierge_requests (id, user_id, category_id, currency) values ($1, $2, 'f2-probe-category', 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'deals',
          sql: `insert into deals (id, wedding_id, slot_id, external_name, currency) values ($1, $2, $3, 'F2 probe vendor', 'USD')`,
          params: [id(), id(), id()],
        },
        {
          table: 'payments',
          sql: `insert into payments (id, deal_id, kind, amount, currency) values ($1, $2, 'deposit', 100, 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'hotel_blocks',
          sql: `insert into hotel_blocks (id, wedding_id, name, rooms, currency) values ($1, $2, 'F2 probe', 5, 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'gift_contributions',
          sql: `insert into gift_contributions (id, gift_id, guest_token, amount, currency, idempotency_key) values ($1, $2, $3, 100, 'USD', $4)`,
          params: [id(), id(), token(), token()],
        },
        {
          table: 'fund_contributions',
          sql: `insert into fund_contributions (id, fund_id, guest_token, amount, currency, idempotency_key) values ($1, $2, $3, 100, 'USD', $4)`,
          params: [id(), id(), token(), token()],
        },
        {
          table: 'referral_uses',
          sql: `insert into referral_uses (invited_id, code, currency) values ($1, $2, 'USD')`,
          params: [id(), `f2-probe-${token()}`],
        },
        {
          table: 'vendor_packages',
          sql: `insert into vendor_packages (id, vendor_id, name, currency) values ($1, $2, 'F2 probe', 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'offer_requests',
          sql: `insert into offer_requests (id, slot_id, status, budget_hint, currency) values ($1, $2, 'open', 100, 'USD')`,
          params: [id(), id()],
        },
        {
          table: 'offers',
          sql: `insert into offers (id, request_id, kind, title, price, currency, valid_until) values ($1, $2, 'offer', 'F2 probe', 100, 'USD', '2027-01-01')`,
          params: [id(), id()],
        },
      ]
    }

    it('на каждой из 15 таблиц — 23514 и своя CHECK, вся транзакция откатывается', async () => {
      const list = probes()
      expect(list).toHaveLength(15)
      const rollbackSentinel = new Error('audit52: intentional rollback (T3)')
      const results: Array<{ table: string; result: PgError }> = []
      try {
        await app.db!.tx(async (client) => {
          for (const probe of list) {
            await client.query(`savepoint sp_${probe.table}`)
            let result: PgError = {}
            try {
              await client.query(probe.sql, probe.params)
            } catch (error) {
              const e = error as PgError
              result = { code: e.code, constraint: e.constraint }
            }
            await client.query(`rollback to savepoint sp_${probe.table}`)
            await client.query(`release savepoint sp_${probe.table}`)
            results.push({ table: probe.table, result })
          }
          throw rollbackSentinel
        })
      } catch (error) {
        if (error !== rollbackSentinel) throw error
      }

      expect(results).toEqual(
        list.map((p) => ({ table: p.table, result: { code: '23514', constraint: `${p.table}_currency_rub` } })),
      )
    })
  })
})
