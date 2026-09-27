/**
 * 019 / US1: кандидаты места.
 *
 * Здесь собраны именно границы истории: три позиции, гонка за слот,
 * роли, стирание подрядчика, открытый запрос, независимость брони и занятость.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'
import { readReplaceEntryId } from '../src/routes/shortlist.js'

// Keep wedding fixtures inside the API's rolling five-year limit.
const TEST_YEAR = new Date().getUTCFullYear() + 1
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface UserFixture {
  id: string
  token: string
}

interface WeddingFixture extends UserFixture {
  weddingId: string
}

interface VendorFixture extends UserFixture {
  vendorId: string
  name: string
}

interface ShortlistEntry {
  id: string
  slotId: string
  position: number
  available: boolean | null
  occupancy: 'free' | 'held' | 'busy' | null
  vendor: {
    id: string
    name: string
    categoryId: string
    photoUrl: string | null
    priceFrom: { amount: number; currency: string } | null
    rating: number | null
    packages: { id: string; name: string; price: { amount: number } | null; includes: string[] }[]
  } | null
}

describe('019 / US1: тело атомарной замены', () => {
  it('сохраняет PUT без body и принимает только replaceEntryId UUID', () => {
    const id = randomUUID()
    expect(readReplaceEntryId(undefined)).toBeUndefined()
    expect(readReplaceEntryId({})).toBeUndefined()
    expect(readReplaceEntryId({ replaceEntryId: id })).toBe(id)
    expect(() => readReplaceEntryId(null)).toThrowError('Запрос не прошёл проверку')
    expect(() => readReplaceEntryId({ replaceEntryId: 'stale' })).toThrowError('Запрос не прошёл проверку')
    expect(() => readReplaceEntryId({ entryId: id })).toThrowError('Запрос не прошёл проверку')
  })
})

describe.skipIf(!live)('019 / US1: шорт-лист кандидатов', () => {
  let app: FastifyInstance
  let counter = 0
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUsers = new Set<string>()

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const idem = (token: string) => ({ ...auth(token), 'idempotency-key': randomUUID() })
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`

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
    for (const id of createdUsers) await app.db!.tx((client) => eraseUser(client, id))
    await app.db!.query('delete from otp_codes where phone like $1', [`+79${RUN}%`])
    await app?.close()
  })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10_000; i++) {
      const code = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, code) === rows[0]!.code_hash) return code
    }
    throw new Error('код не подобрался')
  }

  async function newUser(): Promise<UserFixture> {
    const phone = nextPhone()
    const requested = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(requested.statusCode, requested.body).toBe(200)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(verified.statusCode, verified.body).toBe(200)
    const body = verified.json() as { accessToken: string; user: { id: string } }
    const consent = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    expect(consent.statusCode, consent.body).toBe(201)
    createdUsers.add(body.user.id)
    return { id: body.user.id, token: body.accessToken }
  }

  async function newWedding(date: string | null = '2029-06-14'): Promise<WeddingFixture> {
    const user = await newUser()
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        ...(date === null ? {} : { date }),
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    return { ...user, weddingId: created.json().id as string }
  }

  async function newVendor(
    categoryId = 'photo',
    options: { packagePrice?: number | null; packageName?: string } = {},
  ): Promise<VendorFixture> {
    const user = await newUser()
    const name = `Кандидат ${RUN}-${counter}`
    const packageName = options.packageName ?? 'Полный день'
    const saved = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
        portfolioUrls: [`https://example.com/${RUN}-${counter}.jpg`],
        priceFrom: { amount: 8_000_000, currency: 'RUB' },
        packages: [
          {
            name: packageName,
            ...(options.packagePrice === null
              ? {}
              : { price: { amount: options.packagePrice ?? 10_000_000, currency: 'RUB' } }),
            includes: ['8 часов', 'Ретушь'],
          },
        ],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const published = await app.inject({
      method: 'POST',
      url: '/vendor/profile/publish',
      headers: auth(user.token),
    })
    expect(published.statusCode, published.body).toBe(200)
    return { ...user, vendorId: saved.json().id as string, name }
  }

  async function member(wedding: WeddingFixture, role: 'helper' | 'coordinator'): Promise<UserFixture> {
    const user = await newUser()
    const issued = await app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/invites`,
      headers: auth(wedding.token),
      payload: { role, label: `019-${role}` },
    })
    expect(issued.statusCode, issued.body).toBe(201)
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${issued.json().code as string}/accept`,
      headers: auth(user.token),
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    return user
  }

  async function slotsOf(wedding: WeddingFixture): Promise<{ id: string; categoryId: string; deal: unknown }[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/weddings/${wedding.weddingId}/slots`,
      headers: auth(wedding.token),
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
  }

  async function slotOf(wedding: WeddingFixture, categoryId: string): Promise<string> {
    const slot = (await slotsOf(wedding)).find((item) => item.categoryId === categoryId)
    if (!slot) throw new Error(`нет слота ${categoryId}`)
    return slot.id
  }

  const add = (token: string, weddingId: string, vendorId: string, replaceEntryId?: string) =>
    app.inject({
      method: 'PUT',
      url: `/weddings/${weddingId}/shortlist/${vendorId}`,
      headers: auth(token),
      ...(replaceEntryId ? { payload: { replaceEntryId } } : {}),
    })

  const read = async (token: string, weddingId: string, slotId: string): Promise<ShortlistEntry[]> => {
    const response = await app.inject({
      method: 'GET',
      url: `/weddings/${weddingId}/slots/${slotId}/shortlist`,
      headers: auth(token),
    })
    expect(response.statusCode, response.body).toBe(200)
    return response.json()
  }

  const remove = (token: string, weddingId: string, slotId: string, entryId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/weddings/${weddingId}/slots/${slotId}/shortlist/${entryId}`,
      headers: auth(token),
    })

  const book = (wedding: WeddingFixture, slotId: string, vendorId: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/slots/${slotId}/book`,
      headers: idem(wedding.token),
      payload: { vendorId, price: { amount: 9_000_000, currency: 'RUB' } },
    })

  async function warmPool(): Promise<void> {
    await Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.2)')))
  }

  /** Ждём фактического ожидания за замком, а не угадываем его таймером. */
  async function blockedBy(pid: number, timeoutMs = 5000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { rows } = await app.db!.query<{ query: string }>(
        "select query from pg_stat_activity where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))",
        [pid],
      )
      if (rows.length > 0) return rows.map((row) => row.query)
      if (Date.now() > deadline) throw new Error(`за замком транзакции ${pid} никто не встал за ${timeoutMs} мс`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('держит ровно три позиции, PUT идемпотентен, а shortlist_full возвращает текущих', async () => {
    const wedding = await newWedding()
    const vendors = await Promise.all([
      newVendor('photo', { packagePrice: null }),
      newVendor('photo'),
      newVendor('photo'),
      newVendor('photo'),
    ])

    const first = await add(wedding.token, wedding.weddingId, vendors[0]!.vendorId)
    const repeated = await add(wedding.token, wedding.weddingId, vendors[0]!.vendorId)
    expect(first.statusCode, first.body).toBe(200)
    expect(repeated.statusCode, repeated.body).toBe(200)
    expect(repeated.json().id).toBe(first.json().id)

    expect((await add(wedding.token, wedding.weddingId, vendors[1]!.vendorId)).statusCode).toBe(200)
    expect((await add(wedding.token, wedding.weddingId, vendors[2]!.vendorId)).statusCode).toBe(200)
    const fourth = await add(wedding.token, wedding.weddingId, vendors[3]!.vendorId)
    expect(fourth.statusCode, fourth.body).toBe(409)
    expect(fourth.json().error.code).toBe('shortlist_full')
    expect(fourth.json().error.details.shortlist).toHaveLength(3)

    const slotId = first.json().slotId as string
    const before = await read(wedding.token, wedding.weddingId, slotId)
    expect(before.map((entry) => entry.position)).toEqual([1, 2, 3])
    expect(before[0]!.vendor!.packages[0]!.price).toBeNull()
    expect(before[0]!.vendor!.packages[0]!.includes).toEqual(['8 часов', 'Ретушь'])

    expect((await remove(wedding.token, wedding.weddingId, slotId, before[1]!.id)).statusCode).toBe(204)
    const replacement = await add(wedding.token, wedding.weddingId, vendors[3]!.vendorId)
    expect(replacement.statusCode, replacement.body).toBe(200)
    expect(replacement.json().position).toBe(2)
  })

  it('атомарная замена не удаляет при свободном месте, existing/stale id и гонке', async () => {
    const wedding = await newWedding()
    const vendors = await Promise.all([
      newVendor('photo'),
      newVendor('photo'),
      newVendor('photo'),
      newVendor('photo'),
      newVendor('photo'),
      newVendor('video'),
    ])
    const first = await add(wedding.token, wedding.weddingId, vendors[0]!.vendorId)
    const second = await add(wedding.token, wedding.weddingId, vendors[1]!.vendorId)
    expect(first.statusCode, first.body).toBe(200)
    expect(second.statusCode, second.body).toBe(200)

    // Свободная позиция важнее replaceEntryId: никого не удаляем.
    const third = await add(wedding.token, wedding.weddingId, vendors[2]!.vendorId, first.json().id as string)
    expect(third.statusCode, third.body).toBe(200)
    const slotId = first.json().slotId as string
    expect((await read(wedding.token, wedding.weddingId, slotId)).map((entry) => entry.vendor!.id)).toEqual(
      vendors.slice(0, 3).map((vendor) => vendor!.vendorId),
    )

    // Входящий уже есть: возвращаем его и игнорируем просьбу удалить другого.
    const existing = await add(wedding.token, wedding.weddingId, vendors[1]!.vendorId, first.json().id as string)
    expect(existing.statusCode, existing.body).toBe(200)
    expect(existing.json().id).toBe(second.json().id)
    expect(await read(wedding.token, wedding.weddingId, slotId)).toHaveLength(3)

    // Id другого места не может снести запись из полной тройки.
    const foreign = await add(wedding.token, wedding.weddingId, vendors[5]!.vendorId)
    expect(foreign.statusCode, foreign.body).toBe(200)
    const crossed = await add(wedding.token, wedding.weddingId, vendors[3]!.vendorId, foreign.json().id as string)
    expect(crossed.statusCode, crossed.body).toBe(409)
    expect(crossed.json().error.code).toBe('shortlist_full')
    expect(crossed.json().error.details.shortlist).toHaveLength(3)

    // Два chooser заменяют один entry: ровно один успевает, второй видит свежую тройку.
    await warmPool()
    const raced = await Promise.all([
      add(wedding.token, wedding.weddingId, vendors[3]!.vendorId, first.json().id as string),
      add(wedding.token, wedding.weddingId, vendors[4]!.vendorId, first.json().id as string),
    ])
    expect(raced.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const rejected = raced.find((response) => response.statusCode === 409)!
    expect(rejected.json().error.code).toBe('shortlist_full')
    expect(rejected.json().error.details.shortlist).toHaveLength(3)

    const after = await read(wedding.token, wedding.weddingId, slotId)
    expect(after).toHaveLength(3)
    expect(after.map((entry) => entry.position)).toEqual([1, 2, 3])
    expect(after.map((entry) => entry.vendor!.id)).not.toContain(vendors[0]!.vendorId)
    expect(
      after.filter((entry) => [vendors[3]!.vendorId, vendors[4]!.vendorId].includes(entry.vendor!.id)),
    ).toHaveLength(1)
  }, 60_000)

  it('откатывает закрытие запроса, если входящая анкета стала недоступна перед заменой', async () => {
    const wedding = await newWedding()
    const [requested, second, third, incoming] = await Promise.all([
      newVendor('photo'),
      newVendor('photo'),
      newVendor('photo'),
      newVendor('photo'),
    ])
    const oldEntry = await add(wedding.token, wedding.weddingId, requested!.vendorId)
    expect(oldEntry.statusCode, oldEntry.body).toBe(200)
    expect((await add(wedding.token, wedding.weddingId, second!.vendorId)).statusCode).toBe(200)
    expect((await add(wedding.token, wedding.weddingId, third!.vendorId)).statusCode).toBe(200)
    const slotId = oldEntry.json().slotId as string
    const requestId = randomUUID()
    await app.db!.query(
      `insert into offer_requests (id, slot_id, vendor_id, created_by)
       values ($1, $2, $3, $4)`,
      [requestId, slotId, requested!.vendorId, wedding.id],
    )

    await warmPool()
    let pending: ReturnType<typeof add> | undefined
    await app.db!.tx(async (client) => {
      await client.query('select id from offer_requests where id = $1 for update', [requestId])
      const { rows: [holder] } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      pending = add(wedding.token, wedding.weddingId, incoming!.vendorId, oldEntry.json().id as string)
      const waiting = await blockedBy(holder!.pid)
      expect(waiting.some((query) => query.includes('offer_requests'))).toBe(true)

      /* PUT уже прочёл hint и ждёт request FOR UPDATE. Теперь
       * финальная проверка анкеты должна откатить уже выполненное
       * в той же транзакции закрытие старого запроса. */
      await app.db!.query('update vendors set blocked_at = now() where id = $1', [incoming!.vendorId])
    })

    const response = await pending!
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('vendor_unavailable')
    const after = await read(wedding.token, wedding.weddingId, slotId)
    expect(after).toHaveLength(3)
    expect(after.map((entry) => entry.id)).toContain(oldEntry.json().id)
    expect(after.map((entry) => entry.vendor?.id)).not.toContain(incoming!.vendorId)
    const { rows: [request] } = await app.db!.query<{
      status: string
      close_reason: string | null
      closed_at: Date | null
    }>('select status, close_reason, closed_at from offer_requests where id = $1', [requestId])
    expect(request).toEqual({ status: 'open', close_reason: null, closed_at: null })
  }, 60_000)

  it('скрытую анкету не добавляет, а после стирания оставляет удаляемый tombstone без личных данных', async () => {
    const wedding = await newWedding()
    const existing = await newVendor('photo')
    const denied = await newVendor('photo')
    const added = await add(wedding.token, wedding.weddingId, existing.vendorId)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string

    await app.db!.query('update vendors set blocked_at = now() where id = any($1::uuid[])', [
      [existing.vendorId, denied.vendorId],
    ])
    const hidden = (await read(wedding.token, wedding.weddingId, slotId))[0]!
    expect(hidden.available).toBe(false)
    expect(hidden.vendor?.name).toBe(existing.name)
    expect(hidden.vendor?.photoUrl).toBeNull()
    expect(hidden.vendor?.priceFrom).toBeNull()
    expect(hidden.vendor?.packages).toEqual([])

    const rejected = await add(wedding.token, wedding.weddingId, denied.vendorId)
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('vendor_unavailable')

    await app.db!.tx((client) => eraseUser(client, existing.id))
    const erased = (await read(wedding.token, wedding.weddingId, slotId))[0]!
    expect(erased.id).toBe(entryId)
    expect(erased.vendor).toBeNull()
    expect(erased.available).toBeNull()
    expect(erased.occupancy).toBeNull()
    expect(JSON.stringify(erased)).not.toContain(existing.vendorId)
    expect(JSON.stringify(erased)).not.toContain(existing.name)

    expect((await remove(wedding.token, wedding.weddingId, slotId, entryId)).statusCode).toBe(204)
    expect(await read(wedding.token, wedding.weddingId, slotId)).toEqual([])
  })

  it('пара при гонке заводит одно место; helper ведёт кандидатов, coordinator только читает', async () => {
    const wedding = await newWedding()
    const helper = await member(wedding, 'helper')
    const coordinator = await member(wedding, 'coordinator')
    const vendors = await Promise.all([
      newVendor('photobooth'),
      newVendor('photobooth'),
      newVendor('photobooth'),
      newVendor('photobooth'),
    ])

    const missing = await add(helper.token, wedding.weddingId, vendors[0]!.vendorId)
    expect(missing.statusCode, missing.body).toBe(409)
    expect(missing.json().error.code).toBe('slot_missing')

    await warmPool()
    const raced = await Promise.all([
      add(wedding.token, wedding.weddingId, vendors[0]!.vendorId),
      add(wedding.token, wedding.weddingId, vendors[1]!.vendorId),
    ])
    expect(raced.map((response) => response.statusCode)).toEqual([200, 200])
    const { rows: slots } = await app.db!.query<{ id: string }>(
      `select id from slots where wedding_id = $1 and category_id = 'photobooth'`,
      [wedding.weddingId],
    )
    expect(slots).toHaveLength(1)
    const slotId = slots[0]!.id
    expect(await read(wedding.token, wedding.weddingId, slotId)).toHaveLength(2)

    const helperAdded = await add(helper.token, wedding.weddingId, vendors[2]!.vendorId)
    expect(helperAdded.statusCode, helperAdded.body).toBe(200)
    const coordinatorRead = await app.inject({
      method: 'GET',
      url: `/weddings/${wedding.weddingId}/slots/${slotId}/shortlist`,
      headers: auth(coordinator.token),
    })
    expect(coordinatorRead.statusCode, coordinatorRead.body).toBe(200)
    const coordinatorWrite = await add(coordinator.token, wedding.weddingId, vendors[3]!.vendorId)
    expect(coordinatorWrite.statusCode, coordinatorWrite.body).toBe(403)

    const vendorRead = await app.inject({
      method: 'GET',
      url: `/weddings/${wedding.weddingId}/slots/${slotId}/shortlist`,
      headers: auth(vendors[0]!.token),
    })
    expect(vendorRead.statusCode, vendorRead.body).toBe(404)

    const otherWedding = await newWedding()
    const foreignSlot = await slotOf(otherWedding, 'photo')
    const crossed = await app.inject({
      method: 'GET',
      url: `/weddings/${wedding.weddingId}/slots/${foreignSlot}/shortlist`,
      headers: auth(wedding.token),
    })
    expect(crossed.statusCode, crossed.body).toBe(404)
  }, 60_000)

  it('помощник не отзывает запрос при удалении/замене, а шорт-лист не трогает бронь', async () => {
    const wedding = await newWedding()
    const helper = await member(wedding, 'helper')
    const requested = await newVendor('photo')
    const fillers = await Promise.all([newVendor('photo'), newVendor('photo')])
    const incoming = await newVendor('photo')
    const added = await add(wedding.token, wedding.weddingId, requested.vendorId)
    expect(added.statusCode, added.body).toBe(200)
    const slotId = added.json().slotId as string
    const entryId = added.json().id as string
    for (const filler of fillers) {
      expect((await add(wedding.token, wedding.weddingId, filler.vendorId)).statusCode).toBe(200)
    }
    const requestId = randomUUID()
    await app.db!.query(
      `insert into offer_requests (id, slot_id, vendor_id, created_by)
       values ($1, $2, $3, $4)`,
      [requestId, slotId, requested.vendorId, wedding.id],
    )

    const helperDenied = await remove(helper.token, wedding.weddingId, slotId, entryId)
    expect(helperDenied.statusCode, helperDenied.body).toBe(409)
    expect(helperDenied.json().error.code).toBe('request_open')
    expect((await read(wedding.token, wedding.weddingId, slotId)).map((entry) => entry.id)).toContain(entryId)

    const helperReplaceDenied = await add(helper.token, wedding.weddingId, incoming.vendorId, entryId)
    expect(helperReplaceDenied.statusCode, helperReplaceDenied.body).toBe(409)
    expect(helperReplaceDenied.json().error.code).toBe('request_open')
    expect((await read(wedding.token, wedding.weddingId, slotId)).map((entry) => entry.id)).toContain(entryId)

    const pairReplacement = await add(wedding.token, wedding.weddingId, incoming.vendorId, entryId)
    expect(pairReplacement.statusCode, pairReplacement.body).toBe(200)
    expect(pairReplacement.json().position).toBe(added.json().position)
    const { rows: closed } = await app.db!.query<{ status: string; close_reason: string; closed: boolean }>(
      `select status, close_reason, closed_at is not null as closed
         from offer_requests where id = $1`,
      [requestId],
    )
    expect(closed[0]).toEqual({ status: 'closed', close_reason: 'removed', closed: true })

    for (const entry of await read(wedding.token, wedding.weddingId, slotId)) {
      expect((await remove(wedding.token, wedding.weddingId, slotId, entry.id)).statusCode).toBe(204)
    }

    const bookedVendor = await newVendor('photo')
    const bookedCandidate = await add(wedding.token, wedding.weddingId, bookedVendor.vendorId)
    expect(bookedCandidate.statusCode, bookedCandidate.body).toBe(200)
    expect((await book(wedding, slotId, bookedVendor.vendorId)).statusCode).toBe(200)
    const { rows: before } = await app.db!.query<{ deal_id: string }>('select deal_id from slots where id = $1', [slotId])
    expect(before[0]?.deal_id).toBeTruthy()
    expect(
      (await remove(wedding.token, wedding.weddingId, slotId, bookedCandidate.json().id as string)).statusCode,
    ).toBe(204)
    const { rows: after } = await app.db!.query<{ deal_id: string }>('select deal_id from slots where id = $1', [slotId])
    expect(after[0]?.deal_id).toBe(before[0]?.deal_id)
  })

  it('различает free своей свадьбы, held чужих переговоров, busy чужой брони и null без даты', async () => {
    const date = `${TEST_YEAR}-08-16`
    const wedding = await newWedding(date)
    const own = await newVendor('photo')
    const held = await newVendor('photo')
    const busy = await newVendor('photo')
    for (const vendor of [own, held, busy]) {
      const response = await add(wedding.token, wedding.weddingId, vendor.vendorId)
      expect(response.statusCode, response.body).toBe(200)
    }
    const slotId = await slotOf(wedding, 'photo')

    const heldWedding = await newWedding(date)
    const heldSlot = await slotOf(heldWedding, 'photo')
    const heldDeal = randomUUID()
    await app.db!.query(
      `insert into deals (id, wedding_id, slot_id, vendor_id, state, price, currency, negotiating_until)
       values ($1, $2, $3, $4, 'negotiating', 1000000, 'RUB', now() + interval '2 days')`,
      [heldDeal, heldWedding.weddingId, heldSlot, held.vendorId],
    )
    await app.db!.query('update slots set deal_id = $2 where id = $1', [heldSlot, heldDeal])

    const busyWedding = await newWedding(date)
    const busySlot = await slotOf(busyWedding, 'photo')
    expect((await book(busyWedding, busySlot, busy.vendorId)).statusCode).toBe(200)
    expect((await book(wedding, slotId, own.vendorId)).statusCode).toBe(200)

    const occupancy = Object.fromEntries(
      (await read(wedding.token, wedding.weddingId, slotId)).map((entry) => [entry.vendor!.id, entry.occupancy]),
    )
    expect(occupancy).toEqual({
      [own.vendorId]: 'free',
      [held.vendorId]: 'held',
      [busy.vendorId]: 'busy',
    })

    const undated = await newWedding(null)
    const undatedCandidate = await add(undated.token, undated.weddingId, held.vendorId)
    expect(undatedCandidate.statusCode, undatedCandidate.body).toBe(200)
    expect(undatedCandidate.json().occupancy).toBeNull()
  })
})
