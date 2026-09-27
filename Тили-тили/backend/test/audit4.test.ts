import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Перепроверка после этапа 4 — всей работы.
 * Вопросы прежние: кто что видит в теле, что при двух одновременных запросах,
 * сколько строк через месяц, что вернётся с чистого устройства, что копится,
 * какое поле принимается на веру, что стоит денег.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('перепроверка после этапа 4', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259): в общей
   * дев-базе сотня тысяч номеров `+79RRRRRRNNN` от прежних
   * прогонов, и случайный RUN иногда совпадает с занятым — тогда на
   * свежем номере прилетает 409 «wedding_exists». */
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
  const idem = (token: string) => ({ ...auth(token), 'idempotency-key': randomUUID() })

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

  async function newUser() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const { accessToken, user } = v.json()
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: accessToken as string, id: user.id as string }
  }

  async function newWedding(date = '2027-06-14') {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    return { ...user, weddingId: res.json().id as string }
  }

  async function newVendor(categoryId = 'photo') {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Подрядчик ${RUN}-${counter}`,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  const slotsOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
      deal: { id: string } | null
    }[]

  async function bookOne(categoryId = 'photo', price = 8_500_000) {
    const vendor = await newVendor(categoryId)
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === categoryId)!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: idem(w.token),
      payload: { vendorId: vendor.vendorId, price: { amount: price, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id
    return { vendor, w, slotId: slot.id, dealId }
  }

  /* ── две одновременные брони в ОДИН слот ──────────────────────────── */
  it('два одновременных «Забронировать» в один слот не вешают на него две сделки', async () => {
    const vendorA = await newVendor('cake')
    const vendorB = await newVendor('cake')
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!

    const call = (vendorId: string) =>
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
        headers: idem(w.token),
        payload: { vendorId, price: { amount: 1_000_000, currency: 'RUB' } },
      })

    const [a, b] = await Promise.all([call(vendorA.vendorId), call(vendorB.vendorId)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])

    // У слота ровно одна живая сделка — иначе бюджет считает обе.
    const { rows } = await app.db!.query<{ n: number }>(
      "select count(*)::int as n from deals where slot_id = $1 and state <> 'cancelled'",
      [slot.id],
    )
    expect(rows[0]!.n).toBe(1)
  })

  /* ── та же гонка, когда обе брони успели сослаться на слот ────────── */
  it.each(['book', 'external'] as const)(
    'две брони через %s, обе дошедшие до слота раньше захвата, — 200 и 409, а не взаимная блокировка и 500 (ERR-0312)',
    async (door) => {
      const vendorA = await newVendor('cake')
      const vendorB = await newVendor('cake')
      const w = await newWedding()
      const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
      const book = (vendorId: string) =>
        app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
          headers: idem(w.token),
          payload: { vendorId, price: { amount: 1_000_000, currency: 'RUB' } },
        })
      // Свой подрядчик — вторая дверь, которая заводит сделку в слот. Каждая
      // дверь сталкивается сама с собой: дверь с замком до вставки не держит
      // `FOR KEY SHARE`, и пара из разных дверей блокировку ловила бы не всегда.
      const external = (vendorName: string) =>
        app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
          headers: auth(w.token),
          payload: { vendorName, price: { amount: 1_000_000, currency: 'RUB' } },
        })

      /* Тест выше ловит только удачное чередование. Здесь оно задано: «третий»
       * держит на слоте `FOR KEY SHARE` — тот же замок, что берёт вставка сделки
       * по внешнему ключу `deals.slot_id`. Обе брони упираются в него на захвате
       * слота; без замка слота до вставки к этому моменту обе уже вставили
       * сделку и держат такой же замок — и, когда «третий» уходит, ждут друг
       * друга на `FOR UPDATE` (уникальный индекс `slots.deal_id`). */
      let both!: Promise<Awaited<ReturnType<typeof book>>[]>
      await app.db!.tx(async (client) => {
        await client.query('select 1 from slots where id = $1 for key share', [slot.id])
        const { rows: pidRows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
        const pid = pidRows[0]!.pid
        both = Promise.all(
          door === 'book'
            ? [book(vendorA.vendorId), book(vendorB.vendorId)]
            : [external('Кондитерская «Первая»'), external('Кондитерская «Вторая»')],
        )

        let waiting = 0
        for (let waited = 0; waited < 5000 && waiting < 2; waited += 20) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          await client.query('select pg_stat_clear_snapshot()') // снимок pg_stat_activity кэшируется в транзакции (audit26)
          // Ждущие на слоте: прямо за «третьим» или в очереди за первой бронью.
          const { rows } = await client.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity a
              where $1 = any(pg_blocking_pids(a.pid))
                 or exists (select 1 from pg_stat_activity b
                             where $1 = any(pg_blocking_pids(b.pid)) and b.pid = any(pg_blocking_pids(a.pid)))`,
            [pid],
          )
          waiting = rows[0]!.n
        }
        expect(waiting, 'обе брони должны дойти до слота и ждать').toBe(2)
      })

      const [a, b] = await both
      expect([a.statusCode, b.statusCode].sort(), `${a.body.slice(0, 120)} | ${b.body.slice(0, 120)}`).toEqual([200, 409])
      const { rows } = await app.db!.query<{ n: number }>(
        "select count(*)::int as n from deals where slot_id = $1 and state <> 'cancelled'",
        [slot.id],
      )
      expect(rows[0]!.n).toBe(1)
    },
  )

  /* ── отменённый слот можно занять снова ───────────────────────────── */
  it('после отмены слот занимается снова', async () => {
    const { w, slotId } = await bookOne('dj', 3_000_000)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`,
      headers: idem(w.token),
    })
    const other = await newVendor('dj')
    const again = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId: other.vendorId, price: { amount: 4_000_000, currency: 'RUB' } },
    })
    expect(again.statusCode).toBe(200)
  })

  /* ── деньги и роли ────────────────────────────────────────────────── */
  it('в ответе для помощника нет ни цены сделки, ни суммы договора', async () => {
    const { w, slotId, dealId } = await bookOne('venue', 25_000_000)
    await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: idem(w.token),
      payload: {
        templateCode: 'venue',
        fields: { customerFullName: 'Алина Иванова', performerFullName: 'Пётр Петров' },
      },
    })
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'coordinator' },
    })
    const coordinator = await newUser()
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(coordinator.token),
    })

    const slots = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/slots`,
      headers: auth(coordinator.token),
    })
    expect(slots.statusCode).toBe(200)
    expect(slots.body).not.toContain('25000000')
    expect(slots.body).not.toContain('"price"')
    void slotId

    // Договоры — тоже деньги и паспортные данные сторон.
    const docs = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/documents`,
      headers: auth(coordinator.token),
    })
    expect(docs.statusCode).toBe(403)
  })

  /* ── что видит гость-подрядчик ────────────────────────────────────── */
  it('кабинет своего подрядчика не отдаёт цену чужой сделки и команду', async () => {
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId))[0]!
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Свой мастер', price: { amount: 7_000_000, currency: 'RUB' } },
    })
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/external/invite`,
      headers: auth(w.token),
    })
    const cabinet = await app.inject({ method: 'GET', url: `/guest-vendor/${invite.json().token}` })
    expect(cabinet.statusCode).toBe(200)
    // Свою цену он знает и так — это их договорённость. А вот идентификаторов
    // свадьбы, команды и остальных слотов быть не должно.
    expect(cabinet.body).not.toContain(w.weddingId)
    expect(cabinet.body).not.toContain('members')
    expect(cabinet.body).not.toContain('budget')
  })

  /* ── ключ идемпотентности чужой не подходит ───────────────────────── */
  it('чужой Idempotency-Key не подменяет ответ', async () => {
    const key = randomUUID()
    const first = await bookOne('florist', 4_000_000)
    void first

    const other = await newWedding()
    const slot = (await slotsOf(other.token, other.weddingId)).find((s) => s.categoryId === 'florist')!
    const vendor = await newVendor('florist')

    // Тот же ключ, но другой пользователь: ключ привязан к (пользователь, путь),
    // иначе один клиент подменял бы ответы другому.
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${other.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(other.token), 'idempotency-key': key },
      payload: { vendorId: vendor.vendorId, price: { amount: 4_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['idempotent-replay']).toBeUndefined()
  })

  it('после неудачи тот же ключ можно использовать снова', async () => {
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'photo')!
    const key = randomUUID()
    const headers = { ...auth(w.token), 'idempotency-key': key }

    // Первый запрос падает: подрядчика нет.
    const failed = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers,
      payload: { vendorId: '01a06426-0000-7000-8000-000000000000', price: { amount: 1000, currency: 'RUB' } },
    })
    expect(failed.statusCode).toBe(404)

    // Ключ не должен «залипнуть»: иначе повтор после сбоя невозможен вообще.
    const vendor = await newVendor('photo')
    const retry = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers,
      payload: { vendorId: vendor.vendorId, price: { amount: 1000, currency: 'RUB' } },
    })
    expect(retry.statusCode).toBe(200)
  })

  /* ── бюджет не врёт ───────────────────────────────────────────────── */
  it('«потрачено» совпадает с суммой строк бюджета', async () => {
    const { w } = await bookOne('venue', 25_000_000)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/budget/items`,
      headers: auth(w.token),
      payload: { title: 'Кольца', categoryId: 'b3', amount: { amount: 9_000_000, currency: 'RUB' } },
    })
    const budget = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/budget`, headers: auth(w.token) })
    ).json() as {
      spent: { amount: number }
      categories: { fromSlots: number; items: { amount: { amount: number } }[] }[]
    }

    // Ровно та ошибка, которая уже случалась во фронте (ERR-0012): общая сумма
    // и сумма по строкам должны сходиться, иначе пара видит два разных ответа.
    const byRows = budget.categories.reduce(
      (a, c) => a + c.fromSlots + c.items.reduce((x, i) => x + i.amount.amount, 0),
      0,
    )
    expect(byRows).toBe(budget.spent.amount)
    expect(budget.spent.amount).toBe(34_000_000)
  })

  it('чужую статью расхода удалить нельзя', async () => {
    const mine = await newWedding()
    const other = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${other.weddingId}/budget/items`,
      headers: auth(other.token),
      payload: { title: 'Чужое', categoryId: 'b5', amount: { amount: 1000, currency: 'RUB' } },
    })
    const res = await app.inject({
      method: 'DELETE',
      url: `/weddings/${mine.weddingId}/budget/items/${created.json().id}`,
      headers: auth(mine.token),
    })
    expect(res.statusCode).toBe(404)

    const stillThere = (
      await app.inject({ method: 'GET', url: `/weddings/${other.weddingId}/budget`, headers: auth(other.token) })
    ).json() as { spent: { amount: number } }
    expect(stillThere.spent.amount).toBe(1000)
  })

  /* ── отменённая свадьба ───────────────────────────────────────────── */
  it('отмена свадьбы освобождает даты подрядчиков', async () => {
    const { vendor, w } = await bookOne('host', 6_000_000)
    const before = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1',
      [vendor.vendorId],
    )
    expect(before.rows[0]!.n).toBe(1)

    await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })

    // Иначе подрядчик остаётся занятым на свадьбу, которой не будет.
    const after = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from vendor_busy_dates where vendor_id = $1',
      [vendor.vendorId],
    )
    expect(after.rows[0]!.n).toBe(0)
  })

  /* ── ключи идемпотентности не копятся вечно ───────────────────────── */
  it('ключи идемпотентности не хранятся дольше суток', async () => {
    const { w, slotId } = await bookOne('decor', 2_000_000)

    /* F6-i (ROADMAP:1301-1302): «сосед» — свой пользователь и свой живой
       ключ (столбцы — как у старого ключа в тесте «уборка сносит просроченное
       и не трогает живое», jobs.test.ts), нужен как отрицательный контроль
       для правки ниже: она старит ключи только владельца своей свадьбы
       (`update … set created_at = now() - interval '30 days' where user_id
       = …` сразу ниже) и только их же считает (последний `select count(*)
       … and user_id = …` теста) — оба с `where` по владельцу (F6-G5r6-07),
       поэтому живой ключ соседа не тронет и не снесёт зачистка просроченных
       ключей в `replayOrClaim()` (deals/idempotency.ts) — проверяется ниже
       (F6-G5-04/F6-G6-03). */
    const neighbor = await newUser()
    const liveKey = `f6i-live-${randomUUID()}`
    await app.db!.query(
      `insert into idempotency_keys (key, user_id, route, request_hash) values ($1,$2,'f6i-neighbor','h')`,
      [liveKey, neighbor.id],
    )

    // F6-i: старит и считает только СВОИ ключи (по владельцу своей свадьбы),
    // а не всю таблицу — сосед выше эту правку больше не задевает.
    await app.db!.query(
      "update idempotency_keys set created_at = now() - interval '30 days' where user_id = (select owner_id from weddings where id = $1)",
      [w.weddingId],
    )

    // Любой следующий запрос с ключом подметает просроченные: таблица иначе
    // растёт линейно от числа действий и никогда не уменьшается.
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`,
      headers: idem(w.token),
    })

    // F6-i (ROADMAP:1301-1302): живой ключ соседа не «состарен» правкой выше
    // (она трогает только владельца своей свадьбы) — подметание сработавшего
    // запроса его не находит и не удаляет.
    const { rows: liveRows } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from idempotency_keys where key = $1',
      [liveKey],
    )
    expect(liveRows[0]!.n, 'живой ключ соседа должен остаться на месте').toBe(1)

    // «Сосед» у себя завёл ключ трёхдневной давности (как jobs.test.ts) —
    // легитимно старый, но никакой чужой прогон его пока не подметал.
    await app.db!.query(
      `insert into idempotency_keys (key, user_id, route, request_hash, created_at)
       values ($1,$2,'f6i-neighbor','h', now() - interval '3 days')`,
      [`f6i-old-${randomUUID()}`, neighbor.id],
    )

    const { rows } = await app.db!.query<{ n: number }>(
      "select count(*)::int as n from idempotency_keys where created_at < now() - interval '1 day' and user_id = (select owner_id from weddings where id = $1)",
      [w.weddingId],
    )
    expect(rows[0]!.n).toBe(0)

    await app.db!.query('delete from idempotency_keys where user_id = $1', [neighbor.id])
  })

  /* ── старые этапы не сломались ────────────────────────────────────── */
  it('каталог, приглашения и профиль продолжают работать', async () => {
    const user = await newUser()
    expect(
      (await app.inject({ method: 'GET', url: '/catalog/categories', headers: auth(user.token) })).statusCode,
    ).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/weddings', headers: auth(user.token) })).statusCode).toBe(200)
  })
})
