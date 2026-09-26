import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { CONTRACT_OPERATIONS } from '../src/contract/paths.generated.js'
import { allowedRoles } from '../src/wedding/access.js'
import { GUEST_ACCESSIBLE_WEDDING_PATHS } from '../src/guests/access.js'
import { cleanup, eraseDeletedUsers } from '../src/jobs/index.js'

/**
 * Регрессии аудита 2026-09-06, блок 3 (права и 152-ФЗ).
 *
 * Матрица ролей проверяется ОТКАЗОМ: посторонний, чужой подрядчик и гость
 * по токену на каждом пути со свадьбой в адресе; помощник и координатор —
 * на деньгах. Стирание аккаунта — на графе внешних ключей, который раньше
 * ронял уборку.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('блок 3: отказ по ролям, журнал сделки, стирание аккаунта', () => {
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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const key = () => ({ 'idempotency-key': `k-${RUN}-${++counter}` })
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`

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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id, phone }
  }
  async function newWedding(token: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', date: '2027-11-06', city: { name: 'Казань', region: 'Татарстан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }
  async function join(couple: { token: string }, weddingId: string, role: 'couple' | 'helper' | 'coordinator') {
    const member = await newUser()
    const invite = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/invites`, headers: auth(couple.token), payload: { role } })
    const accepted = await app.inject({ method: 'POST', url: `/invites/${invite.json().code as string}/accept`, headers: auth(member.token) })
    expect(accepted.statusCode).toBe(200)
    return member
  }
  async function newVendor(categoryId: string) {
    const owner = await newUser()
    const profile = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `${categoryId} ${RUN}-${++counter}`, categoryId, city: { name: 'Казань', region: 'Татарстан' } },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    return { owner, vendorId: profile.json().id as string, name: profile.json().name as string }
  }
  async function book(token: string, weddingId: string, categoryId: string, vendorId: string) {
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === categoryId)!
    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(booked.statusCode).toBe(200)
    return { slotId: slot.id, dealId: booked.json().deal.id as string }
  }
  async function guestToken(couple: { token: string }, weddingId: string) {
    const guest = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests`, headers: auth(couple.token), payload: { name: 'Гость' } })
    const link = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests/${guest.json().id as string}/invite-link`, headers: auth(couple.token) })
    const code = (link.json().url as string).split('/').pop()!
    return (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string
  }

  it('гость по токену на GET …/guest-reviews получает 401, а не 500', async () => {
    /* Список гостевых путей был по адресу, без метода: хук пускал гостя
       и на GET, обработчик ждал участника свадьбы — и падал. */
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const token = await guestToken(couple, weddingId)
    const res = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/guest-reviews?guestToken=${encodeURIComponent(token)}` })
    expect(res.statusCode).toBe(401)
    // Свой путь у гостя по-прежнему открыт: до свадьбы — 403 по сроку, но не 401.
    const post = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guest-reviews?guestToken=${encodeURIComponent(token)}`,
      payload: { vendorId: '00000000-0000-4000-8000-000000000000', stars: 5 },
    })
    expect(post.statusCode).toBe(403)
  })

  it('журнал сделки с суммами закрыт помощнику и координатору, открыт паре и подрядчику', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const helper = await join(couple, weddingId, 'helper')
    const coordinator = await join(couple, weddingId, 'coordinator')
    const vendor = await newVendor('photo')
    const { dealId } = await book(couple.token, weddingId, 'photo', vendor.vendorId)
    const outsider = await newUser()

    const status = async (token: string) => (await app.inject({ method: 'GET', url: `/deals/${dealId}/events`, headers: auth(token) })).statusCode
    expect(await status(couple.token)).toBe(200)
    expect(await status(vendor.owner.token)).toBe(200)
    // До фикса — 200 у обоих: проверка спрашивала «участник ли», а не «пара ли».
    expect(await status(helper.token)).toBe(403)
    expect(await status(coordinator.token)).toBe(403)
    expect(await status(outsider.token)).toBe(404)
  })

  it('на каждом пути со свадьбой в адресе: посторонний и чужой подрядчик — 404, гость — 401, помощник на деньгах — 403', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const helper = await join(couple, weddingId, 'helper')
    const outsider = await newUser()
    const vendor = await newVendor('video')
    const token = await guestToken(couple, weddingId)
    const fill = (url: string) => url.replace(/:weddingId/, weddingId).replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000')

    const drift: string[] = []
    for (const op of CONTRACT_OPERATIONS) {
      if (!op.url.startsWith('/weddings/:weddingId') || op.method !== 'GET') continue
      const url = fill(op.url)
      const asOutsider = await app.inject({ method: 'GET', url, headers: auth(outsider.token) })
      if (asOutsider.statusCode !== 404) drift.push(`${op.openapi}: посторонний → ${asOutsider.statusCode}`)
      const asVendor = await app.inject({ method: 'GET', url, headers: auth(vendor.owner.token) })
      if (asVendor.statusCode !== 404) drift.push(`${op.openapi}: чужой подрядчик → ${asVendor.statusCode}`)
      const guestUrl = `${url}?guestToken=${encodeURIComponent(token)}`
      const asGuest = await app.inject({ method: 'GET', url: guestUrl })
      const guestAllowed = GUEST_ACCESSIBLE_WEDDING_PATHS.has(`GET ${op.url}`)
      if (!guestAllowed && asGuest.statusCode !== 401) drift.push(`${op.openapi}: гость по токену → ${asGuest.statusCode}`)
      if (guestAllowed && asGuest.statusCode !== 200) drift.push(`${op.openapi}: гость на своём пути → ${asGuest.statusCode}`)
      const asHelper = await app.inject({ method: 'GET', url, headers: auth(helper.token) })
      const helperAllowed = allowedRoles(op.url, 'GET').includes('helper')
      if (!helperAllowed && asHelper.statusCode !== 403) drift.push(`${op.openapi}: помощник → ${asHelper.statusCode}, ожидался 403`)
      if (helperAllowed && [401, 403].includes(asHelper.statusCode)) drift.push(`${op.openapi}: помощник → ${asHelper.statusCode}, а матрица пускает`)
    }
    expect(drift).toEqual([])
  })

  it('стирание через 30 дней: свадьба остаётся партнёру, ссылки на человека обнуляются, аккаунт исчезает', async () => {
    /* Голый `delete from users` падал на `invites.created_by` (NO ACTION)
       у любого, кто выдавал приглашения, а каскад по `weddings.owner_id`
       снёс бы свадьбу у второго партнёра. */
    const owner = await newUser()
    const weddingId = await newWedding(owner.token)
    const partner = await join(owner, weddingId, 'couple')
    const helper = await join(owner, weddingId, 'helper')
    await app.db!.query('update weddings set cancel_requested_by = $2, cancel_requested_at = now() where id = $1', [weddingId, owner.userId])
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(owner.token) })).statusCode).toBe(204)
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [owner.userId])

    // Уборка целиком: раньше сбой на пользователях останавливал и всё после них.
    // Счётчик не утверждаем: уборку на общей базе мог сделать соседний прогон (R-177). Ниже — состояние базы.
    const report = await cleanup(app)
    expect(report['users']).toBeTypeOf('number')

    const { rows: users } = await app.db!.query('select 1 from users where id = $1', [owner.userId])
    expect(users).toHaveLength(0)
    const { rows: w } = await app.db!.query<{ owner_id: string; cancel_requested_by: string | null }>(
      'select owner_id, cancel_requested_by from weddings where id = $1',
      [weddingId],
    )
    expect(w[0]).toEqual({ owner_id: partner.userId, cancel_requested_by: null })
    const { rows: members } = await app.db!.query<{ user_id: string }>('select user_id from wedding_members where wedding_id = $1', [weddingId])
    expect(members.map((m) => m.user_id).sort()).toEqual([helper.userId, partner.userId].sort())
    // Партнёр продолжает работать со свадьбой.
    expect((await app.inject({ method: 'GET', url: `/weddings/${weddingId}`, headers: auth(partner.token) })).statusCode).toBe(200)
  })

  it('стирание подрядчика: сделка остаётся паре историей с именем исполнителя', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const vendor = await newVendor('decor')
    const { dealId, slotId } = await book(couple.token, weddingId, 'decor', vendor.vendorId)
    await app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [dealId])
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(vendor.owner.token) })).statusCode).toBe(204)
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [vendor.owner.userId])

    // F6-f: «проход соседа» — тот же слив, что в cleanup (jobs/index.ts:52),
    // вставлен здесь напрямую, чтобы гонка была детерминированной, а не
    // случайной. До 5 повторов, до 0 — как остаток общей базы, так и наша
    // только что состаренная строка.
    for (let i = 0; i < 5 && (await eraseDeletedUsers(app)) > 0; i++);

    // F6-f (FP-1): не счётчик прохода уборки (соседний проход мог стереть
    // строку первым — вот он и стёр, выше), а состояние СВОЕГО аккаунта.
    await eraseDeletedUsers(app)
    const { rows: erased } = await app.db!.query('select 1 from users where id = $1', [vendor.owner.userId])
    expect(erased).toHaveLength(0)

    const { rows } = await app.db!.query<{ vendor_id: string | null; external_name: string | null; state: string }>(
      'select vendor_id, external_name, state from deals where id = $1',
      [dealId],
    )
    expect(rows[0]).toEqual({ vendor_id: null, external_name: vendor.name, state: 'done' })
    const slot = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(couple.token) })
    expect(slot.statusCode).toBe(200)
    const mine = (slot.json() as { id: string; deal?: { vendor?: unknown; externalName?: string | null } | null }[]).find((s) => s.id === slotId)
    expect(mine?.deal?.vendor ?? null).toBeNull()
    expect(mine?.deal?.externalName).toBe(vendor.name)
  })
})
