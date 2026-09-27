/**
 * Разведка 019 (ERR-0317): две одновременные брони одного места.
 *
 * Бронь вставляла сделку раньше, чем захватывала слот: внешний ключ ставил на строку
 * слота KEY SHARE, а `update slots set deal_id` требует FOR UPDATE — обе брони ждали
 * друг друга, одна падала «deadlock detected», пара получала 500 вместо 409. На этой
 * машине — 14 пар из 40; одиночный тест audit4 проходил в двух случаях из трёх.
 * Здесь двадцать повторов: вероятность ни разу не поймать дефект при 35 % — 0,65^20 ≈ 0,02 %.
 *
 * 019, FR-006: сохранение анкеты стирало все пакеты и вставляло их заново с новыми id — каждое
 * «Далее» мастера, и брони теряли пакет (`deals.package_id` — `on delete set null`). Пакеты
 * теперь сохраняются по id: присланный с id — обновляется, без id — новый, неприсланный — удаляется.
 */
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

describe.skipIf(!live)('разведка 019: бронь места без взаимной блокировки (ERR-0317)', () => {
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
      deal: { id: string; packageName: string | null } | null
    }[]

  type Pkg = { id: string; name: string; price: { amount: number; currency: string } | null; includes: string[] }
  const saveProfile = (v: { token: string }, packages: unknown[], extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(v.token),
      payload: { name: `Кондитер ${RUN}`, categoryId: 'cake', city: { name: 'Уфа', region: 'Башкортостан' }, packages, ...extra },
    })
  /** Пакет обратно в анкету — как его вернёт мастер: с id и составом, без цены, если её нет. */
  const asInput = (p: Pkg) => ({ id: p.id, name: p.name, ...(p.price ? { price: p.price } : {}), includes: p.includes })
  const packagesOf = async (v: { token: string }) =>
    (await app.inject({ method: 'GET', url: '/vendor/profile', headers: auth(v.token) })).json().packages as Pkg[]
  const vendorDealPackages = async (v: { token: string }) =>
    ((await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(v.token) })).json().items as { packageName: string | null }[])
      .map((d) => d.packageName)
  const dealSnapshot = async (dealId: string) =>
    (await app.db!.query<{
      package_id: string | null
      package_title_snapshot: string | null
      package_includes_snapshot: string[] | null
    }>(
      `select package_id, package_title_snapshot, package_includes_snapshot
         from deals where id = $1`,
      [dealId],
    )).rows[0]!


  const book = (w: { token: string; weddingId: string }, slotId: string, vendorId: string, packageId?: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId, price: { amount: 1_000_000, currency: 'RUB' }, ...(packageId ? { packageId } : {}) },
    })
  const external = (w: { token: string; weddingId: string }, slotId: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
      headers: auth(w.token),
      payload: { vendorName: 'Свой кондитер', price: { amount: 900_000, currency: 'RUB' } },
    })
  const liveDeals = async (slotId: string) =>
    (await app.db!.query<{ n: number }>("select count(*)::int as n from deals where slot_id = $1 and state <> 'cancelled'", [slotId]))
      .rows[0]!.n
  const openRequest = async (slotId: string, vendorId: string, createdBy: string) => {
    const id = randomUUID()
    await app.db!.query(
      `insert into offer_requests (id, slot_id, vendor_id, created_by)
       values ($1, $2, $3, $4)`,
      [id, slotId, vendorId, createdBy],
    )
    return id
  }

  it('двадцать раз по две одновременные брони одного места — 200 и 409, ни одного 500', async () => {
    const vendorA = await newVendor('cake')
    const vendorB = await newVendor('cake')
    const seen: string[] = []
    for (let i = 0; i < 20; i++) {
      // Своя свадьба на каждый повтор и своя дата: даты подрядчиков не мешают друг другу.
      const w = await newWedding(`2028-0${1 + (i % 9)}-${String(10 + Math.floor(i / 9)).padStart(2, '0')}`)
      const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
      const [a, b] = await Promise.all([book(w, slot.id, vendorA.vendorId), book(w, slot.id, vendorB.vendorId)])
      seen.push([a.statusCode, b.statusCode].sort().join('/'))
      expect(await liveDeals(slot.id)).toBe(1)
    }
    expect(seen).toEqual(Array(20).fill('200/409'))
  }, 120_000)

  it('двадцать раз по два одновременных «свой подрядчик» в одно место — 200 и 409, ни одного 500', async () => {
    const seen: string[] = []
    for (let i = 0; i < 20; i++) {
      const w = await newWedding()
      const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
      const [a, b] = await Promise.all([external(w, slot.id), external(w, slot.id)])
      seen.push([a.statusCode, b.statusCode].sort().join('/'))
      expect(await liveDeals(slot.id)).toBe(1)
    }
    expect(seen).toEqual(Array(20).fill('200/409'))
  }, 120_000)

  it('бронь из каталога закрывает запрос выбранного как booked, остальных — booked_other без раскрытия победителя', async () => {
    const selected = await newVendor('cake')
    const other = await newVendor('cake')
    const w = await newWedding('2030-03-03')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    const selectedRequest = await openRequest(slot.id, selected.vendorId, w.id)
    const otherRequest = await openRequest(slot.id, other.vendorId, w.id)

    const booked = await book(w, slot.id, selected.vendorId)
    expect(booked.statusCode, booked.body).toBe(200)
    const { rows } = await app.db!.query<{ id: string; status: string; close_reason: string; closed: boolean }>(
      `select id, status, close_reason, closed_at is not null as closed
         from offer_requests where id = any($1::uuid[]) order by id`,
      [[selectedRequest, otherRequest]],
    )
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.close_reason, r.closed]]))).toEqual({
      [selectedRequest]: ['closed', 'booked', true],
      [otherRequest]: ['closed', 'booked_other', true],
    })

    const { rows: notices } = await app.db!.query<{ user_id: string; title: string; body: string }>(
      `select user_id, title, body from notifications
        where user_id = any($1::uuid[]) and title = 'Пара выбрала другого исполнителя'
        order by user_id`,
      [[selected.id, other.id]],
    )
    expect(notices).toEqual([
      {
        user_id: other.id,
        title: 'Пара выбрала другого исполнителя',
        body: 'Запрос предложения закрыт: пара выбрала другого исполнителя.',
      },
    ])
    expect(JSON.stringify(notices)).not.toContain(selected.vendorId)
    expect(JSON.stringify(notices)).not.toContain('1000000')
  }, 60_000)

  it('бронь своего подрядчика закрывает все открытые запросы как booked_other', async () => {
    const first = await newVendor('cake')
    const second = await newVendor('cake')
    const w = await newWedding('2030-04-04')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    const requestIds = [
      await openRequest(slot.id, first.vendorId, w.id),
      await openRequest(slot.id, second.vendorId, w.id),
    ]

    const booked = await external(w, slot.id)
    expect(booked.statusCode, booked.body).toBe(200)
    const { rows } = await app.db!.query<{ id: string; close_reason: string }>(
      'select id, close_reason from offer_requests where id = any($1::uuid[]) order by id',
      [requestIds],
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.close_reason === 'booked_other')).toBe(true)
    const { rows: notices } = await app.db!.query<{ user_id: string }>(
      `select user_id from notifications
        where user_id = any($1::uuid[]) and title = 'Пара выбрала другого исполнителя'
        order by user_id`,
      [[first.id, second.id]],
    )
    expect(notices.map((n) => n.user_id).sort()).toEqual([first.id, second.id].sort())
  }, 60_000)

  it('пакет удаляют, пока бронь по нему в пути, — 422 unknown_package, а не 500', async () => {
    const vendor = await newVendor('cake')
    const saved = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendor.token),
      payload: { name: `Кондитер ${RUN}`, categoryId: 'cake', city: { name: 'Уфа', region: 'Башкортостан' },
        packages: [{ name: 'Торт на 50 гостей', price: { amount: 2_000_000, currency: 'RUB' } }] },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const { rows: [pkg] } = await app.db!.query<{ id: string }>('select id from vendor_packages where vendor_id = $1', [vendor.vendorId])
    const w = await newWedding('2030-05-05')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    let blocked = false
    let pending!: Promise<{ statusCode: number; json: () => { error?: { code?: string } } }>
    await app.db!.tx(async (client) => {
      // «Сохранение анкеты» удаляет пакет и ещё не зафиксировано.
      await client.query('delete from vendor_packages where id = $1', [pkg!.id])
      const { rows: [me] } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      pending = book(w, slot.id, vendor.vendorId, pkg!.id)
      for (let waited = 0; waited < 5000 && !blocked; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await client.query('select pg_stat_clear_snapshot()')
        const { rows } = await client.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [me!.pid])
        blocked = rows[0]!.n > 0
      }
    })
    const res = await pending
    // До фикса бронь не ждала пакет: читала его живым, а внешний ключ сделки падал после коммита удаления — 500.
    expect(blocked, 'бронь не ждала пакет под замком').toBe(true)
    expect(res.statusCode).toBe(422)
    expect(res.json().error?.code).toBe('unknown_package')
    expect(await liveDeals(slot.id)).toBe(0)
  }, 60_000)

  it('FR-006/FR-018: бронь фиксирует название и состав — правка и удаление живого пакета её не меняют', async () => {
    const vendor = await newVendor('cake')
    const first = await saveProfile(vendor, [
      { name: 'Торт на 50 гостей', price: { amount: 2_000_000, currency: 'RUB' }, includes: ['три яруса', 'доставка'] },
      { name: 'Капкейки', includes: ['60 штук'] },
    ])
    expect(first.statusCode, first.body).toBe(200)
    const before = first.json().packages as Pkg[]
    expect(before.map((p) => p.includes)).toEqual([['три яруса', 'доставка'], ['60 штук']])
    const w = await newWedding('2030-06-06')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    const booked = await book(w, slot.id, vendor.vendorId, before[0]!.id)
    expect(booked.statusCode, booked.body).toBe(200)
    const dealId = booked.json().deal.id as string
    expect(await dealSnapshot(dealId)).toEqual({
      package_id: before[0]!.id,
      package_title_snapshot: 'Торт на 50 гостей',
      package_includes_snapshot: ['три яруса', 'доставка'],
    })

    // «Далее» мастера на шаге «О себе»: пакеты уходят как пришли — с id и составом.
    const again = await saveProfile(vendor, before.map(asInput), { about: 'Торты на заказ' })
    expect(again.statusCode, again.body).toBe(200)
    // До исправления: 422 на поле id, а без id — новые id и пустой состав у брони.
    expect(again.json().packages).toEqual(before)
    expect((await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.packageName).toBe('Торт на 50 гостей')
    expect(await vendorDealPackages(vendor)).toEqual(['Торт на 50 гостей'])

    // Правка самого пакета меняет витрину, но не уже принятую бронь.
    const renamed = await saveProfile(vendor, [{ ...asInput(before[0]!), name: 'Торт на 60 гостей', includes: ['три яруса'] }, asInput(before[1]!)])
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect((renamed.json().packages as Pkg[]).map((p) => [p.id, p.name, p.includes])).toEqual([
      [before[0]!.id, 'Торт на 60 гостей', ['три яруса']],
      [before[1]!.id, 'Капкейки', ['60 штук']],
    ])
    expect((await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.packageName).toBe('Торт на 50 гостей')
    expect(await vendorDealPackages(vendor)).toEqual(['Торт на 50 гостей'])
    expect(await dealSnapshot(dealId)).toEqual({
      package_id: before[0]!.id,
      package_title_snapshot: 'Торт на 50 гостей',
      package_includes_snapshot: ['три яруса', 'доставка'],
    })

    // Снятие пакета с витрины обнуляет только живую ссылку; условия сделки остаются.
    const removed = await saveProfile(vendor, [asInput(before[1]!)])
    expect(removed.statusCode, removed.body).toBe(200)
    expect((await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.packageName).toBe('Торт на 50 гостей')
    expect(await vendorDealPackages(vendor)).toEqual(['Торт на 50 гостей'])
    expect(await dealSnapshot(dealId)).toEqual({
      package_id: null,
      package_title_snapshot: 'Торт на 50 гостей',
      package_includes_snapshot: ['три яруса', 'доставка'],
    })
  }, 60_000)

  it('FR-006: новый пакет без id получает id, порядок — как прислан, неприсланный удаляется и не воскресает', async () => {
    const vendor = await newVendor('cake')
    const [a, b] = (await saveProfile(vendor, [{ name: 'A' }, { name: 'B' }])).json().packages as Pkg[]
    const w = await newWedding('2030-07-07')
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'cake')!
    expect((await book(w, slot.id, vendor.vendorId, b!.id)).statusCode).toBe(200)

    // B убран, C добавлен в начало: у A прежний id, у C — новый, порядок как прислан.
    const saved = await saveProfile(vendor, [{ name: 'C' }, asInput(a!)])
    expect(saved.statusCode, saved.body).toBe(200)
    const after = saved.json().packages as Pkg[]
    expect(after.map((p) => p.name)).toEqual(['C', 'A'])
    expect(after[1]!.id).toBe(a!.id)
    expect([a!.id, b!.id]).not.toContain(after[0]!.id)
    // Убранный пакет пропадает с витрины, но снимок уже заключённой сделки остаётся.
    expect((await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.packageName).toBe('B')

    // Устаревший черновик с id удалённого пакета: 422, пакет не воскресает, ничего не записано.
    const stale = await saveProfile(vendor, [asInput(a!), asInput(b!)], { about: 'не должно записаться' })
    expect(stale.statusCode, stale.body).toBe(422)
    expect(stale.json().error?.code).toBe('unknown_package')
    expect((await packagesOf(vendor)).map((p) => p.name)).toEqual(['C', 'A'])
    const { rows } = await app.db!.query<{ about: string | null }>('select about from vendors where id = $1', [vendor.vendorId])
    expect(rows[0]!.about).toBeNull()
  }, 60_000)

  it('FR-006: чужой id пакета — 422 unknown_package, чужой пакет не тронут; один id дважды — 422 поля', async () => {
    const owner = await newVendor('cake')
    const [theirs] = (await saveProfile(owner, [{ name: 'Свадебный торт', price: { amount: 3_000_000, currency: 'RUB' }, includes: ['ярус'] }]))
      .json().packages as Pkg[]
    const intruder = await newVendor('cake')

    const foreign = await saveProfile(intruder, [{ id: theirs!.id, name: 'Переименовал чужой', includes: [] }])
    expect(foreign.statusCode, foreign.body).toBe(422)
    expect(foreign.json().error?.code).toBe('unknown_package')
    expect(await packagesOf(owner)).toEqual([theirs])

    const [mine] = (await saveProfile(intruder, [{ name: 'Свой' }])).json().packages as Pkg[]
    const twice = await saveProfile(intruder, [asInput(mine!), { ...asInput(mine!), name: 'Второй раз' }])
    expect(twice.statusCode, twice.body).toBe(422)
    expect(twice.json().error).toMatchObject({ code: 'validation_failed', fields: { 'packages/1/id': 'пакет указан дважды' } })
    expect(await packagesOf(intruder)).toEqual([mine])

    // Не uuid вместо id — тот же 422, а не 500 из приведения типа в базе.
    const garbage = await saveProfile(intruder, [{ id: 'не-uuid', name: 'X' }])
    expect(garbage.statusCode, garbage.body).toBe(422)
    expect(garbage.json().error?.code).toBe('unknown_package')
  }, 60_000)
})
