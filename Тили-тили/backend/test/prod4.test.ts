import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { hashRefreshToken, signAccessToken, verifyAccessToken } from '../src/auth/tokens.js'
import { programDigest, signProgramRead } from '../src/vendor/program-token.js'
import { signExternalProgramRead, verifyExternalProgramRead } from '../src/vendor/external-program-token.js'

/**
 * Волна 4: сквозной проход глазами подрядчика (план §9.2).
 *
 * Этапы 5–8 проходили по нескольку раз, но именно ролью подрядчика их
 * никто не проходил — и нашлись две дыры: договор он оформить не мог,
 * а изменений пары не видел вовсе, хотя §13.2 требует обратного.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: сквозной сценарий подрядчика', () => {
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
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token }
  }

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-10-02',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  async function newVendor() {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Студия ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })
    expect(res.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  /** Пара бронирует подрядчика: с этой минуты он сторона сделки. */
  async function book(w: { token: string; weddingId: string }, vendorId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string; categoryId: string }[]
    const slot = slots.find((s) => s.categoryId === 'photo') ?? slots[0]!
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    const { rows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [slot.id])
    return rows[0]!.id
  }

  /* ── договор ──────────────────────────────────────────────────────── */
  it('договор оформляет и подрядчик, а не только пара', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const dealId = await book(w, vendor.vendorId)

    /* План §9.2 шаг 3 дословно: «Ирина генерирует договор из шаблона
     * платформы, отправляет PDF». Раньше подрядчик получал 403 —
     * то есть описанный в плане сценарий не проходил вовсе. */
    const made = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: { ...auth(vendor.token), ...key() },
      payload: {
        templateCode: 'photographer',
        fields: { customerFullName: 'Алина Смирнова', performerFullName: 'Ирина Петрова' },
      },
    })
    expect(made.statusCode).toBe(201)
    expect(made.json().templateCode).toBe('photographer')

    // Помощнику договор не положен: там суммы и данные сторон.
    const helper = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'helper' },
    })
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(helper.token),
    })
    const denied = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: { ...auth(helper.token), ...key() },
      payload: { templateCode: 'photographer', fields: {} },
    })
    expect(denied.statusCode).toBe(403)

    // Посторонний не узнаёт даже того, что сделка существует.
    const stranger = await newUser()
    const hidden = await app.inject({
      method: 'POST',
      url: `/deals/${dealId}/contract`,
      headers: { ...auth(stranger.token), ...key() },
      payload: { templateCode: 'photographer', fields: {} },
    })
    expect(hidden.statusCode).toBe(404)
  })

  /* ── обновления от пар ────────────────────────────────────────────── */
  it('подрядчик видит изменения пары: рассадка, меню, тайминг, гости', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)

    // Рассадка: пара сажает гостя за стол.
    const table = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name: 'Стол 4', capacity: 8 },
    })
    const guest = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Марина' },
    })
    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/guests/${guest.json().id}`,
      headers: auth(w.token),
      payload: { tableId: table.json().id },
    })

    // Меню и тайминг.
    await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }] },
    })
    const snapshot = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const saved = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': snapshot.headers.etag! },
      payload: [{ name: 'Банкет', startsAt: '2027-10-02T15:00:00.000Z' }],
    })
    expect(saved.statusCode, saved.body).toBe(200)

    const updates = await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })
    expect(updates.statusCode).toBe(200)
    const kinds = (updates.json() as { kind: string; text: string }[]).map((u) => u.kind)
    /* §13.2: «Изменения рассадки, меню-опроса, тайминга и гостевых
     * счётчиков мгновенно видны подрядчику, чья сделка booked».
     * На сервере не было ни строки — карточка в кабинете жила на моках. */
    expect(kinds).toContain('seating')
    expect(kinds).toContain('menu')
    expect(kinds).toContain('timeline')
  })

  it('правки одного вида сливаются в одну строку, пока её не подтвердили', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    await book(w, vendor.vendorId)

    const table = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name: 'Стол 1', capacity: 8 },
    })
    for (const name of ['Аня', 'Борис', 'Вера']) {
      const g = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/guests`,
        headers: auth(w.token),
        payload: { name },
      })
      await app.inject({
        method: 'PATCH',
        url: `/weddings/${w.weddingId}/guests/${g.json().id}`,
        headers: auth(w.token),
        payload: { tableId: table.json().id },
      })
    }

    const list = (await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })).json() as {
      id: string
      kind: string
      text: string
      ackAt: string | null
    }[]
    // Рассадку двигают мышью: три пересадки — одна новость, а не три.
    const seating = list.filter((u) => u.kind === 'seating')
    expect(seating).toHaveLength(1)
    expect(seating[0]!.text).toContain('3')

    const ack = await app.inject({
      method: 'POST',
      url: `/vendor/updates/${seating[0]!.id}/ack`,
      headers: auth(vendor.token),
    })
    expect(ack.statusCode).toBe(204)
    const after = (await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })).json() as {
      kind: string
      ackAt: string | null
    }[]
    expect(after.find((u) => u.kind === 'seating')?.ackAt).not.toBeNull()
  })

  it('чужие обновления не видны и не подтверждаются', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    const other = await newVendor()
    await book(w, vendor.vendorId)
    const snapshot = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const saved = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': snapshot.headers.etag! },
      payload: [{ name: 'Сборы', startsAt: '2027-10-02T09:00:00.000Z' }],
    })
    expect(saved.statusCode, saved.body).toBe(200)

    const mine = (await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })).json() as {
      id: string
    }[]
    expect(mine.length).toBeGreaterThan(0)
    // Чужая свадьба — не его дело: ни в списке, ни по прямому адресу.
    expect((await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(other.token) })).json()).toEqual([])
    const stolen = await app.inject({
      method: 'POST',
      url: `/vendor/updates/${mine[0]!.id}/ack`,
      headers: auth(other.token),
    })
    expect(stolen.statusCode).toBe(404)
  })

  it('подрядчик-кандидат чужой рассадки не видит', async () => {
    const w = await newWedding()
    const vendor = await newVendor()
    // Лид, а не бронь: подрядчик ещё ничего не обещал.
    await app.inject({
      method: 'POST',
      url: `/chats/vendor/${vendor.vendorId}`,
      headers: auth(w.token),
    })
    const snapshot = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const saved = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': snapshot.headers.etag! },
      payload: [{ name: 'Сборы', startsAt: '2027-10-02T09:00:00.000Z' }],
    })
    expect(saved.statusCode, saved.body).toBe(200)
    /* §13.2 говорит про подрядчика, «чья сделка в статусе booked».
     * Кандидату чужой тайминг не нужен, а знать его он не должен. */
    expect((await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })).json()).toEqual([])
  })

  async function updateFixture() {
    const w = await newWedding()
    const vendor = await newVendor()
    const dealId = await book(w, vendor.vendorId)
    const snapshot = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const saved = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': snapshot.headers.etag! },
      payload: [{ name: 'Private program', startsAt: '2027-10-02T09:00:00.000Z' }] })
    expect(saved.statusCode, saved.body).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })
    expect(list.statusCode, list.body).toBe(200)
    const update = (list.json() as { id: string; kind: string }[]).find(u => u.kind === 'timeline')!
    expect(update).toBeDefined()
    return { w, vendor, dealId, update }
  }

  async function externalProgramFixture() {
    const w = await newWedding()
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json()
    const slot = slots.find((s: { categoryId: string }) => s.categoryId === 'photo')
    const booked = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot.id}/external`, headers: auth(w.token),
      payload: { vendorName: 'External actual service', phone: '+79170000000', price: { amount: 5000000, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200)
    const dealId = booked.json().deal.id as string
    const invite = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot.id}/external/invite`, headers: auth(w.token) })
    expect(invite.statusCode, invite.body).toBe(201)
    const token = invite.json().token as string
    const path = `/weddings/${w.weddingId}/timeline`
    const before = await app.inject({ method: 'GET', url: path, headers: auth(w.token) })
    const saved = await app.inject({ method: 'PUT', url: path, headers: { ...auth(w.token), 'if-match': before.headers.etag! }, payload: [
      { name: 'Own external ceremony', startsAt: '2027-10-02T09:00:12.125Z', durationMinutes: 30,
        responsible: { kind: 'deal', id: dealId }, who: 'PRIVATE LEGACY NOTES', forGuests: false },
      { name: 'SECRET INTERNAL BLOCK', forGuests: false },
    ] })
    expect(saved.statusCode, saved.body).toBe(200)
    return { w, slotId: slot.id as string, dealId, token, path: `/guest-vendor/${token}/timeline`, version: saved.headers.etag! }
  }

  const legacyDoors = ['cabinet', 'read', 'write'] as const
  type LegacyDoor = typeof legacyDoors[number]
  function legacyRequest(f: { token: string }, door: LegacyDoor) {
    return app.inject({ method: door === 'write' ? 'POST' : 'GET',
      url: `/guest-vendor/${f.token}${door === 'cabinet' ? '' : '/messages'}`,
      ...(door === 'write' ? { payload: { text: 'MUST NOT BE SENT AFTER CANCEL' } } : {}) })
  }

  it.each(legacyDoors)('legacy external %s refuses a cancelled actual deal without link-only assumptions', async door => {
    const f = await externalProgramFixture()
    await app.db!.query("update deals set state='cancelled' where id=$1 and wedding_id=$2", [f.dealId, f.w.weddingId])
    const before = (await app.db!.query('select id from messages where chat_id in (select id from chats where deal_id=$1)', [f.dealId])).rowCount
    const response = await legacyRequest(f, door)
    expect(response.statusCode, response.body).toBe(410)
    expect(response.body).not.toContain('Own external ceremony')
    expect((await app.db!.query('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at).toBeNull()
    expect((await app.db!.query('select id from messages where chat_id in (select id from chats where deal_id=$1)', [f.dealId])).rowCount).toBe(before)
  })

  it.each(legacyDoors)('legacy external %s never follows a bound link into a replacement deal', async door => {
    const f = await externalProgramFixture()
    // Explicit stale-slot fixture: simulate a mutation path that did not revoke the old link.
    await app.db!.query('update slots set deal_id=null where id=$1 and wedding_id=$2', [f.slotId, f.w.weddingId])
    const replacement = await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${f.slotId}/external`, headers: auth(f.w.token),
      payload: { vendorName: 'SECRET REPLACEMENT CONTRACTOR', price: { amount: 10000, currency: 'RUB' } } })
    expect(replacement.statusCode, replacement.body).toBe(200)
    const response = await legacyRequest(f, door)
    expect(response.statusCode, response.body).toBe(410)
    expect(response.body).not.toContain('SECRET REPLACEMENT CONTRACTOR')
    expect((await app.db!.query('select id from messages where chat_id in (select id from chats where deal_id=$1)', [replacement.json().deal.id])).rowCount).toBe(0)
    expect((await app.db!.query('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at).toBeNull()
  })

  it.each(legacyDoors)('legacy external %s requires a new issued binding instead of guessing historical access', async door => {
    const f = await externalProgramFixture()
    await app.db!.query('update deals set current_program_invite_id=null where id=$1 and wedding_id=$2', [f.dealId, f.w.weddingId])
    await app.db!.query('update external_invites set program_deal_id=null where token=$1 and wedding_id=$2', [f.token, f.w.weddingId])
    const response = await legacyRequest(f, door)
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().error.code).toBe('program_link_unbound')
    expect((await app.db!.query('select accepted_at,program_deal_id from external_invites where token=$1', [f.token])).rows[0]).toMatchObject({ accepted_at: null, program_deal_id: null })
    expect((await app.db!.query('select id from messages where chat_id in (select id from chats where deal_id=$1)', [f.dealId])).rowCount).toBe(0)
  })

  it.each(legacyDoors.flatMap(door =>
    (['revoked', 'expired', 'archived_at', 'cancelled_at', 'slot_changed', 'deal_cancelled', 'deal_expiry', 'natural_expiry', 'late_chat_expiry'] as const).map(change => ({ door, change })),
  ))('legacy external $door rechecks $change after actual PostgreSQL lock waits', async ({ door, change }) => {
    const f = await externalProgramFixture()
    const chat = (await app.db!.query<{ id: string }>("select id from chats where deal_id=$1 and kind='external'", [f.dealId])).rows[0]!
    const natural = change === 'natural_expiry' || change === 'late_chat_expiry' || change === 'deal_expiry'
    if (natural) await app.db!.query("update external_invites set expires_at=clock_timestamp()+interval '1 second' where token=$1 and wedding_id=$2", [f.token, f.w.weddingId])
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(resolve => { held = resolve })
    const entering = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      if (change === 'late_chat_expiry') await client.query('select id from chats where id=$1 for update', [chat.id])
      else if (change === 'slot_changed') await client.query('select id from slots where id=$1 for update', [f.slotId])
      else if (change === 'deal_expiry') await client.query('select id from deals where id=$1 for update', [f.dealId])
      else await client.query('select id from weddings where id=$1 for update', [f.w.weddingId])
      held(); await released
      if (change === 'revoked') await client.query('update external_invites set revoked_at=clock_timestamp() where token=$1 and wedding_id=$2', [f.token, f.w.weddingId])
      else if (change === 'expired') await client.query("update external_invites set expires_at=clock_timestamp()-interval '1 second' where token=$1 and wedding_id=$2", [f.token, f.w.weddingId])
      else if (change === 'slot_changed') await client.query('update slots set deal_id=null where id=$1 and wedding_id=$2', [f.slotId, f.w.weddingId])
      else if (change === 'deal_cancelled') await client.query("update deals set state='cancelled' where id=$1 and wedding_id=$2", [f.dealId, f.w.weddingId])
      else if (change === 'archived_at' || change === 'cancelled_at') await client.query(`update weddings set ${change}=clock_timestamp() where id=$1`, [f.w.weddingId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      const observed = change === 'late_chat_expiry' ? sql.startsWith('insert into chats')
        : change === 'slot_changed' ? sql.startsWith('select deal_id from slots')
        : change === 'deal_expiry' ? sql.startsWith('select vendor_id,external_name,state from deals')
        : sql.includes('timeline_version::text') && /for share/.test(sql)
      if (observed) entered()
      return client.query(sql, values)
    } }))
    const published: unknown[] = []
    const publish = app.realtime.publish
    app.realtime.publish = async event => { published.push(event); await publish.call(app.realtime, event) }
    let response: ReturnType<typeof legacyRequest> | undefined
    try {
      response = legacyRequest(f, door)
      await entering
      if (natural) await new Promise(resolve => setTimeout(resolve, 1200))
      release(); await blocker
      const denied = await response
      expect(denied.statusCode, denied.body).toBe(410)
      expect(denied.body).not.toContain('Own external ceremony')
    } finally {
      release()
      try { await blocker } finally { app.db!.tx = original; app.realtime.publish = publish }
      await response
    }
    expect(published).toEqual([])
    expect((await app.db!.query('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at).toBeNull()
    expect((await app.db!.query('select id from messages where chat_id=$1', [chat.id])).rowCount).toBe(0)
    expect((await app.db!.query('select id from notifications where link=$1', [`/chats/${chat.id}`])).rowCount).toBe(0)
  })

  it('legacy concurrent cabinet reads retain one chat/accepted timestamp without shared-lock upgrade deadlock', async () => {
    const f = await externalProgramFixture()
    const results = await Promise.all([legacyRequest(f, 'cabinet'), legacyRequest(f, 'cabinet'), legacyRequest(f, 'read')])
    for (const response of results) { expect(response.statusCode, response.body).toBe(200); expect(response.headers['cache-control']).toBe('no-store') }
    expect(results[0]!.json().chatId).toBe(results[1]!.json().chatId)
    expect((await app.db!.query('select id from chats where deal_id=$1', [f.dealId])).rowCount).toBe(1)
    const accepted = (await app.db!.query('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at
    expect(accepted).not.toBeNull()
    expect((await legacyRequest(f, 'cabinet')).statusCode).toBe(200)
    expect((await app.db!.query('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at).toEqual(accepted)
  })

  it.each(['cabinet', 'write'] as const)('legacy external %s timestamp reflects actual post-wait action, not transaction start', async door => {
    const f = await externalProgramFixture()
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(resolve => { held = resolve }), entering = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    let releasedAt!: Date
    const blocker = original(async client => {
      await client.query('select id from weddings where id=$1 for update', [f.w.weddingId]); held(); await released
      releasedAt = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes('timeline_version::text') && /for share/.test(sql)) entered()
      return client.query(sql, values)
    } }))
    let response: ReturnType<typeof legacyRequest> | undefined
    try {
      response = legacyRequest(f, door); await entering
      await new Promise(resolve => setTimeout(resolve, 50)); release(); await blocker
      const allowed = await response
      expect(allowed.statusCode, allowed.body).toBe(door === 'cabinet' ? 200 : 201)
      const actedAt = door === 'cabinet'
        ? (await app.db!.query<{ accepted_at: Date }>('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at
        : new Date(allowed.json().sentAt)
      expect(actedAt.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime())
      if (door === 'write') expect(allowed.json()).toMatchObject({ senderId: null, mine: true, system: false })
    } finally { release(); await blocker; app.db!.tx = original; await response }
  })

  it('legacy chat publishes an actual committed message without acknowledging or revising the program', async () => {
    const f = await externalProgramFixture()
    const publish = app.realtime.publish
    let delivered = 0
    app.realtime.publish = async event => {
      const payload = event.payload as { message: { id: string } }
      expect((await app.db!.query('select id from messages where id=$1 and chat_id=$2', [payload.message.id, event.chatId])).rowCount).toBe(1)
      delivered++
      await publish.call(app.realtime, event)
    }
    try {
      const response = await legacyRequest(f, 'write')
      expect(response.statusCode, response.body).toBe(201)
      expect(response.json()).toMatchObject({ senderId: null, mine: true, system: false })
      expect(delivered).toBe(1)
      const program = await app.inject({ method: 'GET', url: f.path })
      expect(program.headers.etag).toBe(f.version)
      expect(program.json()).toMatchObject({ requiresAcknowledgment: true, acknowledgedAt: null })
      expect((await app.db!.query('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at).toBeNull()
    } finally { app.realtime.publish = publish }
  })

  it('legacy cabinet failure rolls back actual lazy chat and accepted_at together', async () => {
    const f = await externalProgramFixture()
    await app.db!.query("delete from chats where deal_id=$1 and kind='external'", [f.dealId])
    const original = app.db!.tx
    let created = false
    app.db!.tx = action => original(client => action({ query: async (sql, values) => {
      const result = await client.query(sql, values)
      if (sql.startsWith('insert into chats')) created = true
      if (sql === 'update external_invites set accepted_at=coalesce(accepted_at,clock_timestamp()) where token=$1 and wedding_id=$2') await client.query('select 1/0')
      return result
    } }))
    try {
      const response = await legacyRequest(f, 'cabinet')
      expect(response.statusCode).toBe(500)
      expect(created).toBe(true)
    } finally { app.db!.tx = original }
    expect((await app.db!.query('select id from chats where deal_id=$1', [f.dealId])).rowCount).toBe(0)
    expect((await app.db!.query('select accepted_at from external_invites where token=$1', [f.token])).rows[0]!.accepted_at).toBeNull()
    expect((await app.db!.query('select wedding_id from external_program_acknowledgments where deal_id=$1', [f.dealId])).rowCount).toBe(0)
  })

  it('external link читает только назначенные блоки точной версии без тайных полей и GET ack', async () => {
    const { w, path, version } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    expect(snapshot.headers.etag).toBe(version)
    expect(snapshot.headers['cache-control']).toBe('no-store')
    expect(snapshot.json()).toMatchObject({ sourceVersion: version.slice(1, -1), requiresAcknowledgment: true, acknowledgedAt: null })
    expect(snapshot.json().blocks).toHaveLength(1)
    expect(snapshot.json().blocks[0]).toMatchObject({ name: 'Own external ceremony', startsAt: '2027-10-02T09:00:12.125Z', endsAt: '2027-10-02T09:30:12.125Z' })
    expect(snapshot.body).not.toMatch(/SECRET INTERNAL|PRIVATE LEGACY|phone|price|currency|userId|sessionId/)
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('external exact-version POST сохраняет реальный receipt и повтор не меняет время', async () => {
    const { w, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const acknowledge = () => app.inject({ method: 'POST', url: path + '/ack', headers: { 'if-match': snapshot.headers.etag! }, payload: { readToken: snapshot.json().readToken } })
    const first = await acknowledge()
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toEqual({ sourceVersion: snapshot.json().sourceVersion, acknowledgedAt: expect.any(String) })
    expect(Number.isFinite(Date.parse(first.json().acknowledgedAt))).toBe(true)
    const retry = await acknowledge()
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual(first.json())
    expect((await app.inject({ method: 'GET', url: path })).json()).toMatchObject({ requiresAcknowledgment: false, acknowledgedAt: first.json().acknowledgedAt })
    const rows = await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0].deal_id).toBeDefined()
    expect(rows.rows[0].program_snapshot.blocks).toHaveLength(1)
  })

  const externalAck = (path: string, snapshot: { headers: { etag?: string | string[] }; json: () => { readToken: string } }) =>
    app.inject({ method: 'POST', url: path + '/ack', headers: { 'if-match': snapshot.headers.etag! }, payload: { readToken: snapshot.json().readToken } })

  it('legacy external cabinet не обходит assigned-only program и не раскрывает who', async () => {
    const { token } = await externalProgramFixture()
    const cabinet = await app.inject({ method: 'GET', url: `/guest-vendor/${token}` })
    expect(cabinet.statusCode, cabinet.body).toBe(200)
    expect(cabinet.json().timeline).toHaveLength(1)
    expect(cabinet.json().timeline[0]).toMatchObject({ name: 'Own external ceremony', who: null })
    expect(cabinet.body).not.toMatch(/SECRET INTERNAL|PRIVATE LEGACY/)
  })

  it('external ack требует If-Match, действующий proof, отдельный purpose и ту же ссылку', async () => {
    const { w, slotId, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    expect(snapshot.statusCode).toBe(200)
    const missing = await app.inject({ method: 'POST', url: path + '/ack', payload: { readToken: snapshot.json().readToken } })
    expect(missing.statusCode).toBe(428)
    const malformed = await app.inject({ method: 'POST', url: path + '/ack', headers: { 'if-match': snapshot.headers.etag! }, payload: { readToken: 'fake' } })
    expect(malformed.statusCode).toBe(422)
    const caller = await verifyAccessToken(SECRET_A, w.token)
    const wrongPurpose = await signProgramRead(SECRET_A, { weddingId: w.weddingId, vendorId: randomUUID(), userId: caller.sub,
      sessionId: caller.sid, version: snapshot.json().sourceVersion, digest: 'a'.repeat(64) }, new Date())
    expect((await app.inject({ method: 'POST', url: path + '/ack', headers: { 'if-match': snapshot.headers.etag! }, payload: { readToken: wrongPurpose } })).statusCode).toBe(422)
    const nextLink = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`, headers: auth(w.token) })
    expect(nextLink.statusCode).toBe(201)
    expect((await externalAck(`/guest-vendor/${nextLink.json().token}/timeline`, snapshot)).statusCode).toBe(422)
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('external новая редакция оставляет историю, но старый proof не подтверждает её', async () => {
    const { w, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    expect((await externalAck(path, snapshot)).statusCode).toBe(200)
    const ownerPath = `/weddings/${w.weddingId}/timeline`
    const current = await app.inject({ method: 'GET', url: ownerPath, headers: auth(w.token) })
    const saved = await app.inject({ method: 'PUT', url: ownerPath, headers: { ...auth(w.token), 'if-match': current.headers.etag! },
      payload: current.json().map((r: { name: string }) => ({ ...r, name: r.name + ' revised' })) })
    expect(saved.statusCode).toBe(200)
    const stale = await externalAck(path, snapshot)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('timeline_conflict')
    const fresh = await app.inject({ method: 'GET', url: path })
    expect(fresh.json()).toMatchObject({ acknowledgedAt: null, requiresAcknowledgment: true })
    expect((await externalAck(path, fresh)).statusCode).toBe(200)
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(2)
  })

  it('external visible content change без revision отвергает digest, новый link не наследует ack', async () => {
    const { w, slotId, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    expect((await externalAck(path, snapshot)).statusCode).toBe(200)
    await app.db!.query("update weddings set title=title||' revised title' where id=$1", [w.weddingId])
    const stale = await externalAck(path, snapshot)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('program_snapshot_changed')
    const fresh = await app.inject({ method: 'GET', url: path })
    expect(fresh.json().requiresAcknowledgment).toBe(true)
    expect((await externalAck(path, fresh)).statusCode).toBe(200)
    const link = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`, headers: auth(w.token) })
    expect(link.statusCode).toBe(201)
    const other = await app.inject({ method: 'GET', url: `/guest-vendor/${link.json().token}/timeline` })
    expect(other.json()).toMatchObject({ acknowledgedAt: null, requiresAcknowledgment: true })
    expect((await externalAck(`/guest-vendor/${link.json().token}/timeline`, fresh)).statusCode).toBe(422)
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(2)
  })

  it('external simultaneous ack сохраняет один original receipt и audit без секретов/выдуманного user', async () => {
    const { w, token, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    const [a, b] = await Promise.all([externalAck(path, snapshot), externalAck(path, snapshot)])
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200)
    expect(a.json()).toEqual(b.json())
    const receipts = await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])
    expect(receipts.rowCount).toBe(1)
    const audit = await app.db!.query("select * from audit_log where entity_id=$1 and action='timeline.external_acknowledged'", [w.weddingId])
    expect(audit.rowCount).toBe(1)
    expect(audit.rows[0].actor_id).toBeNull()
    expect(audit.rows[0].diff).toMatchObject({ actorKind: 'external_link', inviteId: receipts.rows[0].invite_id })
    expect(JSON.stringify([...receipts.rows, ...audit.rows])).not.toContain(token)
    expect(JSON.stringify([...receipts.rows, ...audit.rows])).not.toContain(snapshot.json().readToken)
  })

  it('external ошибка настоящего SQL на audit откатывает receipt, retry работает', async () => {
    const { w, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    const original = app.db!.tx
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes("'timeline.external_acknowledged'")) return client.query('select 1/0')
      return client.query(sql, values)
    } }))
    try { expect((await externalAck(path, snapshot)).statusCode).toBe(500) }
    finally { app.db!.tx = original }
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
    expect((await app.db!.query("select * from audit_log where entity_id=$1 and action='timeline.external_acknowledged'", [w.weddingId])).rowCount).toBe(0)
    expect((await externalAck(path, snapshot)).statusCode).toBe(200)
  })

  it('external historical link без доказанной deal binding требует новую ссылку, expired/revoked gone', async () => {
    const { w, token, path, dealId } = await externalProgramFixture()
    await app.db!.query('update deals set current_program_invite_id=null where id=$1', [dealId])
    await app.db!.query('update external_invites set program_deal_id=null where token=$1', [token])
    const legacy = await app.inject({ method: 'GET', url: path })
    expect(legacy.statusCode).toBe(409)
    expect(legacy.json().error.code).toBe('program_link_unbound')
    await app.db!.query("update external_invites set expires_at=clock_timestamp()-interval '1 second' where token=$1", [token])
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(410)
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('external without assignments не выдаёт proof или фиктивное ожидание', async () => {
    const { w, path } = await externalProgramFixture()
    const ownerPath = `/weddings/${w.weddingId}/timeline`
    const before = await app.inject({ method: 'GET', url: ownerPath, headers: auth(w.token) })
    expect((await app.inject({ method: 'PUT', url: ownerPath, headers: { ...auth(w.token), 'if-match': before.headers.etag! }, payload: [] })).statusCode).toBe(200)
    const snapshot = await app.inject({ method: 'GET', url: path })
    expect(snapshot.statusCode).toBe(200)
    expect(snapshot.json()).toMatchObject({ blocks: [], readToken: null, expiresAt: null, requiresAcknowledgment: false, acknowledgedAt: null })
  })

  it('external cancellation/rebooking закрывает прежнюю ссылку и сохраняет её историю', async () => {
    const { w, slotId, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    expect((await externalAck(path, snapshot)).statusCode).toBe(200)
    const cancelled = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`, headers: { ...auth(w.token), ...key() } })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(410)
    expect((await externalAck(path, snapshot)).statusCode).toBe(410)
    const next = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/external`, headers: auth(w.token),
      payload: { vendorName: 'Replacement actual external', price: { amount: 5000, currency: 'RUB' } } })
    expect(next.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(410)
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
  })

  it.each((['GET', 'POST'] as const).flatMap(method =>
    (['revoked', 'expired', 'deal', 'archived_at', 'cancelled_at'] as const).map(revoked => ({ method, revoked })),
  ))('external $method проверяет $revoked после реального ожидания wedding lock', async ({ method, revoked }) => {
    const { w, token, dealId, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(resolve => { held = resolve })
    const entering = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      await client.query('select id from weddings where id=$1 for update', [w.weddingId])
      held(); await released
      if (revoked === 'revoked') await client.query('update external_invites set revoked_at=clock_timestamp() where token=$1', [token])
      else if (revoked === 'expired') await client.query("update external_invites set expires_at=clock_timestamp()-interval '1 millisecond' where token=$1", [token])
      else if (revoked === 'deal') await client.query("update deals set state='cancelled' where id=$1", [dealId])
      else await client.query(`update weddings set ${revoked}=clock_timestamp() where id=$1`, [w.weddingId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes('timeline_version::text') && /for (share|update)/.test(sql)) entered()
      return client.query(sql, values)
    } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = method === 'GET' ? app.inject({ method: 'GET', url: path }) : externalAck(path, snapshot)
      await entering; release(); await blocker
      const denied = await response
      expect(denied.statusCode, denied.body).toBe(410)
      expect(denied.body).not.toContain('Own external ceremony')
    } finally { release(); await blocker; app.db!.tx = original; await response }
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('external proof TTL проверяется actual clock после ожидания, не transaction now', async () => {
    const { w, path } = await externalProgramFixture()
    const snapshot = await app.inject({ method: 'GET', url: path })
    const now = (await app.db!.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
    const claims = await verifyExternalProgramRead(SECRET_A, snapshot.json().readToken, now)
    const almostExpired = await signExternalProgramRead(SECRET_A, claims, new Date(now.getTime() - 598000))
    await verifyExternalProgramRead(SECRET_A, almostExpired, now)
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(resolve => { held = resolve })
    const entering = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      await client.query('select id from weddings where id=$1 for update', [w.weddingId]); held(); await released
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes('timeline_version::text') && /for update/.test(sql)) entered()
      return client.query(sql, values)
    } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = app.inject({ method: 'POST', url: path + '/ack', headers: { 'if-match': snapshot.headers.etag! }, payload: { readToken: almostExpired } })
      await entering; await new Promise(resolve => setTimeout(resolve, 2200)); release(); await blocker
      const denied = await response
      expect(denied.statusCode).toBe(409); expect(denied.json().error.code).toBe('program_read_expired')
    } finally { release(); await blocker; app.db!.tx = original; await response }
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('external issuance cannot publish HTTP201 before the real transaction commits', async () => {
    const { w, slotId } = await externalProgramFixture()
    const original = app.db!.tx
    await original(client => client.query('select id from weddings where id=$1 for update', [w.weddingId]))
    const before = (await app.db!.query('select program_identity from external_invites where wedding_id=$1', [w.weddingId])).rows.length
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const commitAllowed = new Promise<void>(resolve => { release = resolve })
    let insideCount = 0, finished = false
    app.db!.tx = action => original(async client => {
      const result = await action(client)
      insideCount = (await client.query('select program_identity from external_invites where wedding_id=$1', [w.weddingId])).rows.length
      entered(); await commitAllowed
      return result
    })
    const response = app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`, headers: auth(w.token) })
      .then(value => { finished = true; return value })
    try {
      await ready
      expect(insideCount).toBe(before + 1)
      expect((await app.db!.query('select program_identity from external_invites where wedding_id=$1', [w.weddingId])).rows).toHaveLength(before)
      expect(finished, 'HTTP response must stay pending until PostgreSQL commit, not just INSERT').toBe(false)
      release()
      const issued = await response
      expect(issued.statusCode, issued.body).toBe(201)
      const stored = await app.db!.query('select program_deal_id from external_invites where wedding_id=$1 and token=$2', [w.weddingId, issued.json().token])
      expect(stored.rowCount).toBe(1)
    } finally { release(); await response; app.db!.tx = original }
  })

  it('external issuance SQL rollback never publishes HTTP201 or changes the current invitation', async () => {
    const { w, slotId, dealId } = await externalProgramFixture()
    const original = app.db!.tx
    await original(client => client.query('select id from weddings where id=$1 for update', [w.weddingId]))
    const before = (await app.db!.query('select program_identity from external_invites where wedding_id=$1 order by program_identity', [w.weddingId])).rows
    const pointer = (await app.db!.query('select current_program_invite_id from deals where id=$1', [dealId])).rows
    app.db!.tx = action => original(async client => {
      const result = await action(client)
      expect((await client.query('select program_identity from external_invites where wedding_id=$1', [w.weddingId])).rowCount).toBe(before.length + 1)
      await client.query('select 1/0')
      return result
    })
    try {
      const issued = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`, headers: auth(w.token) })
      expect(issued.statusCode, issued.body).toBe(500)
    } finally { app.db!.tx = original }
    await original(client => client.query('select id from weddings where id=$1 for update', [w.weddingId]))
    expect((await app.db!.query('select program_identity from external_invites where wedding_id=$1 order by program_identity', [w.weddingId])).rows).toEqual(before)
    expect((await app.db!.query('select current_program_invite_id from deals where id=$1', [dealId])).rows).toEqual(pointer)
  })

  it('external issuance created_at отражает реальную выдачу после wedding wait, не transaction now', async () => {
    const { w, slotId } = await externalProgramFixture()
    let held!: () => void, entered!: () => void, release!: () => void
    let releasedAt!: Date
    const locked = new Promise<void>(resolve => { held = resolve })
    const entering = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      await client.query('select id from weddings where id=$1 for update', [w.weddingId]); held(); await released
      releasedAt = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes('timeline_version::text') && /for update/.test(sql)) entered()
      return client.query(sql, values)
    } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`, headers: auth(w.token) })
      await entering; await new Promise(resolve => setTimeout(resolve, 50)); release(); await blocker
      const issued = await response
      expect(issued.statusCode, issued.body).toBe(201)
      const row = (await app.db!.query<{ created_at: Date; expires_at: Date }>('select created_at,expires_at from external_invites where token=$1', [issued.json().token])).rows[0]!
      expect(row.created_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime())
      expect(row.expires_at.getTime() - row.created_at.getTime()).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000)
    } finally { release(); await blocker; app.db!.tx = original; await response }
  })

  it.each(['role', 'session', 'account', 'archived_at', 'cancelled_at'] as const)(
    'external issuance повторяет %s после actual wedding wait без новой ссылки', async revoked => {
    const { w, slotId } = await externalProgramFixture()
    const caller = await verifyAccessToken(SECRET_A, w.token)
    const before = (await app.db!.query('select token from external_invites where wedding_id=$1', [w.weddingId])).rows
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(resolve => { held = resolve })
    const entering = new Promise<void>(resolve => { entered = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      await client.query('select id from weddings where id=$1 for update', [w.weddingId]); held(); await released
      if (revoked === 'role') await client.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [w.weddingId, caller.sub])
      else if (revoked === 'session') await client.query('update sessions set revoked_at=clock_timestamp() where id=$1', [caller.sid])
      else if (revoked === 'account') await client.query('update users set deleted_at=clock_timestamp() where id=$1', [caller.sub])
      else await client.query(`update weddings set ${revoked}=clock_timestamp() where id=$1`, [w.weddingId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes('timeline_version::text') && /for update/.test(sql)) entered()
      return client.query(sql, values)
    } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`, headers: auth(w.token) })
      await entering; release(); await blocker
      const denied = await response
      expect(denied.statusCode, denied.body).toBe(revoked === 'role' ? 403 : revoked === 'session' || revoked === 'account' ? 401 : 404)
      expect(denied.json().token).toBeUndefined()
    } finally { release(); await blocker; app.db!.tx = original; await response }
    expect((await app.db!.query('select token from external_invites where wedding_id=$1', [w.weddingId])).rows).toEqual(before)
  })

  async function programFixture() {
    const fixture = await updateFixture()
    const { w, dealId } = fixture
    const path = `/weddings/${w.weddingId}/timeline`
    const before = await app.inject({ method: 'GET', url: path, headers: auth(w.token) })
    const created = await app.inject({ method: 'PUT', url: path,
      headers: { ...auth(w.token), 'if-match': before.headers.etag! }, payload: [
        { name: 'Own ceremony service', location: 'Service location', startsAt: '2027-10-02T09:00:12.125Z',
          durationMinutes: 30, fixed: true, responsible: { kind: 'deal', id: dealId }, who: 'PRIVATE LEGACY NOTES', forGuests: false },
        { name: 'Own reception service', startsAt: '2027-10-02T10:00:00Z', durationMinutes: 60,
          participants: [{ kind: 'deal', id: dealId }], travelMinutes: 10, bufferMinutes: 5 },
        { name: 'SECRET INTERNAL BLOCK', startsAt: '2027-10-02T08:00:00Z', durationMinutes: 20, forGuests: false },
      ] })
    expect(created.statusCode, created.body).toBe(200)
    const rows = created.json() as { id: string; dependsOn: string[] }[]
    rows[1]!.dependsOn = [rows[0]!.id, rows[2]!.id]
    const saved = await app.inject({ method: 'PUT', url: path,
      headers: { ...auth(w.token), 'if-match': created.headers.etag! }, payload: rows })
    expect(saved.statusCode, saved.body).toBe(200)
    return { ...fixture, rows: saved.json() as { id: string; name: string }[], version: saved.headers.etag! }
  }

  const programPath = (w: { weddingId: string }) => `/vendor/weddings/${w.weddingId}/timeline`
  const readProgram = (w: { weddingId: string }, token: string) => app.inject({ method: 'GET', url: programPath(w), headers: auth(token) })
  const teamProgramState = (w: { weddingId: string }, token: string) => app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline/acknowledgments`, headers: auth(token) })
  async function externalReceipt(path: string) {
    const read = await app.inject({ method: 'GET', url: path })
    expect(read.statusCode, read.body).toBe(200)
    const ack = await app.inject({ method: 'POST', url: path + '/ack', headers: { 'if-match': read.headers.etag! }, payload: { readToken: read.json().readToken } })
    expect(ack.statusCode, ack.body).toBe(200)
    return ack.json() as { sourceVersion: string; acknowledgedAt: string }
  }

  it('external team pending принадлежит actual current invite, GET не создаёт receipt и не раскрывает секреты', async () => {
    const f = await externalProgramFixture()
    const pointer = (await app.db!.query<{ current_program_invite_id: string; program_identity: string }>(
      'select d.current_program_invite_id,i.program_identity from deals d join external_invites i on i.token=$2 where d.id=$1', [f.dealId, f.token])).rows[0]!
    expect(pointer.current_program_invite_id).toBe(pointer.program_identity)
    const result = await teamProgramState(f.w, f.w.token)
    expect(result.statusCode, result.body).toBe(200)
    expect(result.headers.etag).toBe(f.version); expect(result.headers['cache-control']).toBe('no-store')
    expect(result.json().items).toEqual([{ kind: 'external', id: f.dealId, name: 'External actual service', blockCount: 1,
      status: 'pending', acknowledgedAt: null, acknowledgedBy: null, previousAcknowledgment: null }])
    expect(result.body).not.toMatch(/readToken|digest|sessionId|program_identity|current_program_invite|79170000000|5000000|PRIVATE|SECRET/)
    expect(result.body).not.toContain(f.token)
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [f.w.weddingId])).rowCount).toBe(0)
  })

  it('external team exact receipt — actual time, anonymous source, не имя владельца свадьбы или услуги', async () => {
    const f = await externalProgramFixture(), ack = await externalReceipt(f.path)
    expect((await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(f.w.token), payload: { name: 'Unrelated owner name' } })).statusCode).toBe(200)
    const result = await teamProgramState(f.w, f.w.token)
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().items[0]).toMatchObject({ status: 'acknowledged', acknowledgedAt: ack.acknowledgedAt, acknowledgedBy: null, previousAcknowledgment: null })
    expect(result.body).not.toContain('Unrelated owner name')
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [f.w.weddingId])).rowCount).toBe(1)
  })

  it('новая ссылка current без наследования даже при nonmonotonic created_at; старая остаётся живой и только историей', async () => {
    const f = await externalProgramFixture(), first = await externalReceipt(f.path)
    await app.db!.query("update external_invites set created_at=clock_timestamp()+interval '1 day' where token=$1", [f.token])
    const second = await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${f.slotId}/external/invite`, headers: auth(f.w.token) })
    expect(second.statusCode, second.body).toBe(201)
    const state = await teamProgramState(f.w, f.w.token)
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json().items[0]).toMatchObject({ status: 'pending', acknowledgedAt: null, previousAcknowledgment: { ...first, acknowledgedBy: null } })
    expect((await externalReceipt(f.path)).acknowledgedAt).toBe(first.acknowledgedAt)
    expect((await teamProgramState(f.w, f.w.token)).json().items[0].status).toBe('pending')
    const current = await externalReceipt(`/guest-vendor/${second.json().token}/timeline`)
    expect((await teamProgramState(f.w, f.w.token)).json().items[0]).toMatchObject({ status: 'acknowledged', acknowledgedAt: current.acknowledgedAt,
      previousAcknowledgment: { ...first, acknowledgedBy: null } })
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [f.w.weddingId])).rowCount).toBe(2)
  })

  it('external новая revision оставляет старое время только в history, fresh receipt подтверждает новую', async () => {
    const f = await externalProgramFixture(), old = await externalReceipt(f.path)
    const owner = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/timeline`, headers: auth(f.w.token) })
    const rows = owner.json(); rows[0].name = 'Revised own external program'
    const saved = await app.inject({ method: 'PUT', url: `/weddings/${f.w.weddingId}/timeline`, headers: { ...auth(f.w.token), 'if-match': owner.headers.etag! }, payload: rows })
    expect(saved.statusCode).toBe(200)
    const pending = await teamProgramState(f.w, f.w.token)
    expect(pending.headers.etag).toBe(saved.headers.etag)
    expect(pending.json().items[0]).toMatchObject({ status: 'pending', acknowledgedAt: null, previousAcknowledgment: { ...old, acknowledgedBy: null } })
    const current = await externalReceipt(f.path)
    expect(current.sourceVersion).not.toBe(old.sourceVersion)
    expect((await teamProgramState(f.w, f.w.token)).json().items[0]).toMatchObject({ status: 'acknowledged', acknowledgedAt: current.acknowledgedAt, previousAcknowledgment: { ...old, acknowledgedBy: null } })
  })

  it('external same-version visible digest change cannot leave current green', async () => {
    const f = await externalProgramFixture(), old = await externalReceipt(f.path)
    await app.db!.query("update weddings set title='External changed visible content' where id=$1", [f.w.weddingId])
    const pending = await teamProgramState(f.w, f.w.token)
    expect(pending.statusCode, pending.body).toBe(200); expect(pending.headers.etag).toBe(f.version)
    expect(pending.json().items[0]).toMatchObject({ status: 'pending', acknowledgedAt: null, previousAcknowledgment: { ...old, acknowledgedBy: null } })
  })

  it('expired external history выбирается по PG microseconds, не по равным JS millisecond timestamps', async () => {
    const f = await externalProgramFixture(), old = await externalReceipt(f.path)
    const owner = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/timeline`, headers: auth(f.w.token) })
    const rows = owner.json(); rows[0].name = 'New revision for history precision'
    expect((await app.inject({ method: 'PUT', url: `/weddings/${f.w.weddingId}/timeline`, headers: { ...auth(f.w.token), 'if-match': owner.headers.etag! }, payload: rows })).statusCode).toBe(200)
    const issued = await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${f.slotId}/external/invite`, headers: auth(f.w.token) })
    expect(issued.statusCode).toBe(201)
    const current = await externalReceipt(`/guest-vendor/${issued.json().token}/timeline`)
    expect(current.sourceVersion).not.toBe(old.sourceVersion)
    await app.db!.query(`update external_program_acknowledgments set acknowledged_at=
      case when invite_id=(select program_identity from external_invites where token=$2)
        then '2026-09-30T08:14:15.123999Z'::timestamptz else '2026-09-30T08:14:15.123001Z'::timestamptz end
      where wedding_id=$1`, [f.w.weddingId, f.token])
    await app.db!.query("update external_invites set expires_at=clock_timestamp()-interval '1 second' where token=$1", [issued.json().token])
    const state = await teamProgramState(f.w, f.w.token)
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json().items[0]).toMatchObject({ status: 'unavailable', acknowledgedAt: null,
      previousAcknowledgment: { sourceVersion: old.sourceVersion, acknowledgedAt: '2026-09-30T08:14:15.123Z', acknowledgedBy: null } })
  })

  it.each(['revoked', 'expired', 'unknown_pointer', 'slot_changed'] as const)('external $revoked unavailable не возвращает старую current отметку', async change => {
    const f = await externalProgramFixture(), old = await externalReceipt(f.path)
    if (change === 'revoked') await app.db!.query('update external_invites set revoked_at=clock_timestamp() where token=$1', [f.token])
    else if (change === 'expired') await app.db!.query("update external_invites set expires_at=clock_timestamp()-interval '1 second' where token=$1", [f.token])
    else if (change === 'unknown_pointer') await app.db!.query('update deals set current_program_invite_id=null where id=$1', [f.dealId])
    else await app.db!.query('update slots set deal_id=null where id=$1', [f.slotId])
    const state = await teamProgramState(f.w, f.w.token)
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json().items[0]).toMatchObject({ status: 'unavailable', acknowledgedAt: null, acknowledgedBy: null, previousAcknowledgment: { ...old, acknowledgedBy: null } })
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [f.w.weddingId])).rowCount).toBe(1)
  })

  it('external без назначенных блоков unassigned, не waiting даже с issued link', async () => {
    const f = await externalProgramFixture()
    const owner = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/timeline`, headers: auth(f.w.token) })
    expect((await app.inject({ method: 'PUT', url: `/weddings/${f.w.weddingId}/timeline`, headers: { ...auth(f.w.token), 'if-match': owner.headers.etag! }, payload: owner.json().map((b: object) => ({ ...b, responsible: null, participants: [] })) })).statusCode).toBe(200)
    expect((await teamProgramState(f.w, f.w.token)).json().items[0]).toMatchObject({ status: 'unassigned', blockCount: 0, acknowledgedAt: null })
  })

  it('public external cancel/rebook removes current actor but preserves history without inheritance', async () => {
    const f = await externalProgramFixture(); await externalReceipt(f.path)
    expect((await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${f.slotId}/cancel`, headers: { ...auth(f.w.token), ...key() } })).statusCode).toBe(200)
    expect((await teamProgramState(f.w, f.w.token)).json().items).toEqual([])
    const rebook = await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${f.slotId}/external`, headers: auth(f.w.token), payload: { vendorName: 'External actual service', price: { amount: 5000, currency: 'RUB' } } })
    expect(rebook.statusCode, rebook.body).toBe(200)
    const state = await teamProgramState(f.w, f.w.token)
    expect(state.json().items).toHaveLength(1)
    expect(state.json().items[0]).toMatchObject({ id: rebook.json().deal.id, status: 'unassigned', previousAcknowledgment: null })
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [f.w.weddingId])).rowCount).toBe(1)
  })

  it('две внешние сделки с одинаковым именем имеют независимые current receipt', async () => {
    const f = await externalProgramFixture()
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/slots`, headers: auth(f.w.token) })).json() as { id: string; categoryId: string }[]
    const slot = slots.find(s => s.categoryId === 'rings')!
    const second = await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${slot.id}/external`, headers: auth(f.w.token), payload: { vendorName: 'External actual service', price: { amount: 5000, currency: 'RUB' } } })
    expect(second.statusCode, second.body).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${slot.id}/external/invite`, headers: auth(f.w.token) })).statusCode).toBe(201)
    const owner = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/timeline`, headers: auth(f.w.token) })
    const rows = owner.json(); rows[0].participants = [{ kind: 'deal', id: second.json().deal.id }]
    expect((await app.inject({ method: 'PUT', url: `/weddings/${f.w.weddingId}/timeline`, headers: { ...auth(f.w.token), 'if-match': owner.headers.etag! }, payload: rows })).statusCode).toBe(200)
    const ack = await externalReceipt(f.path)
    const state = await teamProgramState(f.w, f.w.token)
    expect(state.json().items).toHaveLength(2)
    expect(state.json().items.find((i: { id: string }) => i.id === f.dealId)).toMatchObject({ status: 'acknowledged', acknowledgedAt: ack.acknowledgedAt })
    expect(state.json().items.find((i: { id: string }) => i.id === second.json().deal.id)).toMatchObject({ status: 'pending', acknowledgedAt: null })
  })

  it.each(['helper', 'coordinator'] as const)('external current receipt доступен своему $role без token/авторства человека', async role => {
    const f = await externalProgramFixture(), ack = await externalReceipt(f.path), member = await programTeamMember(f.w, role)
    const state = await teamProgramState(f.w, member.token)
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json().items[0]).toMatchObject({ status: 'acknowledged', acknowledgedAt: ack.acknowledgedAt, acknowledgedBy: null })
    expect(state.body).not.toContain(f.token); expect(state.body).not.toMatch(/readToken|digest|program_identity|phone|price|currency/)
  })

  it('external link, vendor account и чужая пара не читают external team receipt', async () => {
    const f = await externalProgramFixture(); await externalReceipt(f.path)
    const vendor = await newVendor(), stranger = await newWedding()
    for (const token of [vendor.token, stranger.token]) expect((await teamProgramState(f.w, token)).statusCode).toBe(404)
    const denied = await app.inject({ method: 'GET', url: `/weddings/${f.w.weddingId}/timeline/acknowledgments?token=${f.token}` })
    expect(denied.statusCode).toBe(401); expect(denied.body).not.toContain('acknowledgedAt')
  })

  it.each(['revoked', 'expired', 'natural_expiry', 'slot_changed', 'pointer_changed', 'late_receipt_expiry'] as const)('external team повторяет $change после реального ожидания lock', async change => {
    const f = await externalProgramFixture(), old = await externalReceipt(f.path)
    const natural = change === 'natural_expiry' || change === 'late_receipt_expiry'
    if (natural) await app.db!.query("update external_invites set expires_at=clock_timestamp()+interval '1 second' where token=$1", [f.token])
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(r => { held = r }), entering = new Promise<void>(r => { entered = r }), released = new Promise<void>(r => { release = r })
    const original = app.db!.tx
    const blocker = original(async client => {
      if (change === 'late_receipt_expiry') await client.query('lock table external_program_acknowledgments in access exclusive mode')
      else if (change === 'slot_changed') await client.query('select id from slots where id=$1 for update', [f.slotId])
      else if (change === 'pointer_changed') await client.query('select id from deals where id=$1 for update', [f.dealId])
      else await client.query('select program_identity from external_invites where token=$1 for update', [f.token])
      held(); await released
      if (change === 'revoked') await client.query('update external_invites set revoked_at=clock_timestamp() where token=$1', [f.token])
      else if (change === 'expired') await client.query("update external_invites set expires_at=clock_timestamp()-interval '1 second' where token=$1", [f.token])
      else if (change === 'slot_changed') await client.query('update slots set deal_id=null where id=$1', [f.slotId])
      else if (change === 'pointer_changed') await client.query('update deals set current_program_invite_id=null where id=$1', [f.dealId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      const waiting = change === 'late_receipt_expiry' ? sql.includes('from external_program_acknowledgments a')
        : change === 'slot_changed' ? sql.startsWith('select id,deal_id from slots')
        : change === 'pointer_changed' ? sql.startsWith('select id,slot_id,vendor_id,external_name,current_program_invite_id from deals') && sql.includes('for share')
        : sql.startsWith('select program_identity,program_deal_id,slot_id,expires_at,revoked_at from external_invites')
      if (waiting) entered()
      return client.query(sql, values)
    } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = Promise.resolve(teamProgramState(f.w, f.w.token))
      expect(await Promise.race([entering.then(() => 'lock'), response.then(() => 'early')])).toBe('lock')
      if (natural) await new Promise(r => setTimeout(r, 1200))
      release(); await blocker
      const state = await response
      if (change === 'pointer_changed') {
        expect(state.statusCode, state.body).toBe(409); expect(state.json().error.code).toBe('program_actors_changed')
        expect(state.body).not.toContain('acknowledgedAt')
      } else {
        expect(state.statusCode, state.body).toBe(200)
        expect(state.json().items[0]).toMatchObject({ status: 'unavailable', acknowledgedAt: null, previousAcknowledgment: { ...old, acknowledgedBy: null } })
      }
    } finally { release(); await blocker; if (response) await response; app.db!.tx = original }
    expect((await app.db!.query('select * from external_program_acknowledgments where wedding_id=$1', [f.w.weddingId])).rowCount).toBe(1)
  })

  it('SQL failure recording current link rolls new invite back atomically, keeps old current/history', async () => {
    const f = await externalProgramFixture(), old = await externalReceipt(f.path)
    const original = app.db!.tx
    app.db!.tx = action => original(client => action({ query: (sql, values) =>
      sql === 'update deals set current_program_invite_id=$3 where wedding_id=$1 and id=$2' ? client.query('select 1/0') : client.query(sql, values) }))
    try {
      const failed = await app.inject({ method: 'POST', url: `/weddings/${f.w.weddingId}/slots/${f.slotId}/external/invite`, headers: auth(f.w.token) })
      expect(failed.statusCode, failed.body).toBe(500)
    } finally { app.db!.tx = original }
    expect((await app.db!.query('select * from external_invites where wedding_id=$1', [f.w.weddingId])).rowCount).toBe(1)
    expect((await teamProgramState(f.w, f.w.token)).json().items[0]).toMatchObject({ status: 'acknowledged', acknowledgedAt: old.acknowledgedAt })
  })
  const ackProgram = (w: { weddingId: string }, token: string, snapshot: { headers: { etag?: string | string[] }; json: () => { readToken: string } }) =>
    app.inject({ method: 'POST', url: programPath(w) + '/ack', headers: { ...auth(token), 'if-match': snapshot.headers.etag! }, payload: { readToken: snapshot.json().readToken } })

  it('пара видит реальное ожидание подрядчика, team GET не подтверждает и не раскрывает доказательство', async () => {
    const { w, vendor, version } = await programFixture()
    const state = await teamProgramState(w, w.token)
    expect(state.statusCode).toBe(200)
    expect(state.headers.etag).toBe(version)
    expect(state.headers['cache-control']).toBe('no-store')
    expect(state.json().items).toHaveLength(1)
    expect(state.json().items[0]).toMatchObject({ kind: 'registered', id: vendor.vendorId, status: 'pending', blockCount: 2, acknowledgedAt: null, acknowledgedBy: null, previousAcknowledgment: null })
    expect(state.body).not.toMatch(/readToken|sessionId|digest|program_snapshot|phone|price|amount|currency|PRIVATE/)
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('пара видит подтверждение точной версии и реального автора, редакция оставляет только отдельную историю', async () => {
    const { w, vendor } = await programFixture()
    const me = await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(vendor.token), payload: { name: 'Автор подтверждения' } })
    expect(me.statusCode).toBe(200)
    const snapshot = await readProgram(w, vendor.token)
    const ack = await ackProgram(w, vendor.token, snapshot)
    expect(ack.statusCode).toBe(200)
    const seen = await teamProgramState(w, w.token)
    expect(seen.statusCode).toBe(200)
    expect(seen.json().items[0]).toMatchObject({ status: 'acknowledged', acknowledgedAt: ack.json().acknowledgedAt, acknowledgedBy: 'Автор подтверждения' })
    const owner = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const edited = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`, headers: { ...auth(w.token), 'if-match': owner.headers.etag! }, payload: owner.json().map((b: { name: string }) => ({ ...b, name: b.name + ' новая редакция' })) })
    expect(edited.statusCode).toBe(200)
    const fresh = await teamProgramState(w, w.token)
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().items[0]).toMatchObject({ status: 'pending', acknowledgedAt: null, acknowledgedBy: null, previousAcknowledgment: { sourceVersion: snapshot.json().sourceVersion, acknowledgedAt: ack.json().acknowledgedAt, acknowledgedBy: 'Автор подтверждения' } })
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
  })

  it('разрешённый vendor snapshot не раскрывает служебные блоки и скрытые зависимости, GET не подтверждает', async () => {
    const { w, vendor, rows, version } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const body = snapshot.json()
    expect(snapshot.headers.etag).toBe(version)
    expect(snapshot.headers['cache-control']).toBe('no-store')
    expect(body.sourceVersion).toBe(version.slice(1, -1))
    expect(body.requiresAcknowledgment).toBe(true)
    expect(body.acknowledgedAt).toBeNull()
    expect(body.blocks.map((b: { id: string }) => b.id)).toEqual([rows[0]!.id, rows[1]!.id])
    expect(body.blocks[1].dependsOn).toEqual([rows[0]!.id])
    expect(body.blocks[0]).toMatchObject({ roles: ['responsible'], startsAt: '2027-10-02T09:00:12.125Z', endsAt: '2027-10-02T09:30:12.125Z' })
    expect(body.blocks[1]).toMatchObject({ roles: ['participant'], travelMinutes: 10, bufferMinutes: 5 })
    expect(body.blocks[0].event.timeZone).toBe('Europe/Moscow')
    expect(body.blocks[0].event.date).toBe('2027-10-02')
    for (const secret of ['SECRET INTERNAL BLOCK', 'PRIVATE LEGACY NOTES', rows[2]!.id, '5000000', 'refreshToken']) expect(snapshot.body).not.toContain(secret)
    const list = await app.inject({ method: 'GET', url: '/vendor/programs?limit=1', headers: auth(vendor.token) })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().items).toEqual([expect.objectContaining({ weddingId: w.weddingId, blockCount: 2, requiresAcknowledgment: true })])
    const stored = await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])
    expect(stored.rowCount).toBe(0)
  })

  async function programTeamMember(w: { token: string; weddingId: string }, role: 'helper' | 'coordinator') {
    const user = await newUser()
    const invite = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/invites`, headers: auth(w.token), payload: { role } })
    expect(invite.statusCode).toBe(201)
    const joined = await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(user.token) })
    expect(joined.statusCode).toBe(200)
    return user
  }

  it.each(['helper', 'coordinator'] as const)('свой $role читает точное состояние, но не proof/деньги', async role => {
    const { w, vendor } = await programFixture()
    const member = await programTeamMember(w, role)
    const state = await teamProgramState(w, member.token)
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json().items[0]).toMatchObject({ id: vendor.vendorId, status: 'pending' })
    expect(state.body).not.toMatch(/readToken|sessionId|digest|price|amount|currency|phone/)
  })

  it('подрядчик, чужая пара и гостевой token не читают team-сводку', async () => {
    const { w, vendor } = await programFixture()
    const stranger = await newUser()
    for (const token of [vendor.token, stranger.token]) {
      const denied = await teamProgramState(w, token)
      expect(denied.statusCode).toBe(404)
      expect(denied.body).not.toContain(vendor.vendorId)
    }
    const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w.token), payload: { name: 'Guest state privacy' } })
    const link = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests/${guest.json().id}/invite-link`, headers: auth(w.token) })
    const code = String(link.json().url).split('/').pop()!
    const redeemed = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(redeemed.statusCode).toBe(200)
    const denied = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline/acknowledgments?guestToken=${encodeURIComponent(redeemed.json().guestToken)}` })
    expect(denied.statusCode).toBe(401)
    expect(denied.body).not.toContain(vendor.vendorId)
  })

  it('изменение видимого содержания без revision не оставляет ложное подтверждение в team-сводке', async () => {
    const { w, vendor } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    const ack = await ackProgram(w, vendor.token, snapshot)
    expect(ack.statusCode).toBe(200)
    await app.db!.query('update weddings set title=$1 where id=$2', ['New title same timeline version', w.weddingId])
    const state = await teamProgramState(w, w.token)
    expect(state.statusCode).toBe(200)
    expect(state.headers.etag).toBe(snapshot.headers.etag)
    expect(state.json().items[0]).toMatchObject({ status: 'pending', acknowledgedAt: null, previousAcknowledgment: { acknowledgedAt: ack.json().acknowledgedAt } })
  })

  it('новый владелец анкеты не наследует green status прежнего автора', async () => {
    const { w, vendor } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    const first = await ackProgram(w, vendor.token, snapshot)
    const next = await newUser()
    const caller = await verifyAccessToken(SECRET_A, next.token)
    await app.db!.query('update vendors set user_id=$1 where id=$2', [caller.sub, vendor.vendorId])
    const fresh = await teamProgramState(w, w.token)
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().items[0]).toMatchObject({ status: 'pending', acknowledgedAt: null, previousAcknowledgment: { acknowledgedAt: first.json().acknowledgedAt } })
    const own = await readProgram(w, next.token)
    const second = await ackProgram(w, next.token, own)
    expect(second.statusCode).toBe(200)
    expect((await teamProgramState(w, w.token)).json().items[0]).toMatchObject({ status: 'acknowledged', acknowledgedAt: second.json().acknowledgedAt, previousAcknowledgment: { acknowledgedAt: first.json().acknowledgedAt } })
  })

  it('unassigned и unavailable не считаются pending/acknowledged', async () => {
    const { w, vendor } = await programFixture()
    const caller = await verifyAccessToken(SECRET_A, vendor.token)
    await app.db!.query('update users set deleted_at=now() where id=$1', [caller.sub])
    expect((await teamProgramState(w, w.token)).json().items[0]).toMatchObject({ status: 'unavailable', acknowledgedAt: null, acknowledgedBy: null })
    const owner = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const saved = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`, headers: { ...auth(w.token), 'if-match': owner.headers.etag! }, payload: owner.json().map((b: object) => ({ ...b, responsible: null, participants: [] })) })
    expect(saved.statusCode, saved.body).toBe(200)
    expect((await teamProgramState(w, w.token)).json().items[0]).toMatchObject({ status: 'unassigned', blockCount: 0, acknowledgedAt: null })
  })

  it('внешний assigned deal без выданной program ссылки unavailable, не выдуманное подтверждение или ожидание', async () => {
    const w = await newWedding()
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json() as { id: string; categoryId: string }[]
    const external = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slots.find(s => s.categoryId === 'rings')!.id}/external`, headers: auth(w.token), payload: { vendorName: 'Внешний исполнитель', phone: '+79170000000', price: { amount: 5000, currency: 'RUB' } } })
    expect(external.statusCode).toBe(200)
    const current = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const saved = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`, headers: { ...auth(w.token), 'if-match': current.headers.etag! }, payload: [{ name: 'External service', responsible: { kind: 'deal', id: external.json().deal.id } }] })
    expect(saved.statusCode, saved.body).toBe(200)
    const state = await teamProgramState(w, w.token)
    expect(state.statusCode).toBe(200)
    expect(state.json().items).toEqual([{ kind: 'external', id: external.json().deal.id, name: 'Внешний исполнитель', blockCount: 1, status: 'unavailable', acknowledgedAt: null, acknowledgedBy: null, previousAcknowledgment: null }])
    expect(state.body).not.toMatch(/79170000000|5000|phone|currency/)
  })

  it('две committed сделки одной анкеты дают одну строку и тот же program digest', async () => {
    const { w, vendor } = await programFixture()
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json() as { id: string; deal: { id: string } | null }[]
    const second = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slots.find(s => !s.deal)!.id}/book`, headers: { ...auth(w.token), ...key() }, payload: { vendorId: vendor.vendorId, price: { amount: 5000000, currency: 'RUB' } } })
    expect(second.statusCode, second.body).toBe(200)
    const current = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const rows = current.json(); rows[1].participants.push({ kind: 'deal', id: second.json().deal.id })
    expect((await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`, headers: { ...auth(w.token), 'if-match': current.headers.etag! }, payload: rows })).statusCode).toBe(200)
    const snapshot = await readProgram(w, vendor.token)
    const ack = await ackProgram(w, vendor.token, snapshot)
    expect(ack.statusCode).toBe(200)
    const state = await teamProgramState(w, w.token)
    expect(state.json().items).toHaveLength(1)
    expect(state.json().items[0]).toMatchObject({ id: vendor.vendorId, blockCount: 2, status: 'acknowledged', acknowledgedAt: ack.json().acknowledgedAt })
  })

  it('реальная отмена последней брони убирает current строку, не стирая историю ack', async () => {
    const { w, vendor, dealId } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect((await ackProgram(w, vendor.token, snapshot)).statusCode).toBe(200)
    const slot = (await app.db!.query<{ slot_id: string }>('select slot_id from deals where id=$1', [dealId])).rows[0]!.slot_id
    expect((await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot}/cancel`, headers: { ...auth(w.token), ...key() } })).statusCode).toBe(200)
    const state = await teamProgramState(w, w.token)
    expect(state.statusCode).toBe(200)
    expect(state.json().items).toEqual([])
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
  })

  it.each(['member', 'role', 'session', 'account', 'archived_at', 'cancelled_at'])('team state повторяет $revoked после ожидания wedding lock', async revoked => {
    const { w } = await programFixture()
    const member = await programTeamMember(w, 'helper')
    const caller = await verifyAccessToken(SECRET_A, member.token)
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(r => { held = r }), entering = new Promise<void>(r => { entered = r }), released = new Promise<void>(r => { release = r })
    const original = app.db!.tx
    const blocker = original(async client => {
      await client.query('select id from weddings where id=$1 for update', [w.weddingId]); held(); await released
      if (revoked === 'member') await client.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, caller.sub])
      else if (revoked === 'role') await client.query("update wedding_members set role='vendor' where wedding_id=$1 and user_id=$2", [w.weddingId, caller.sub])
      else if (revoked === 'session') await client.query('update sessions set revoked_at=now() where id=$1', [caller.sid])
      else if (revoked === 'account') await client.query('update users set deleted_at=now() where id=$1', [caller.sub])
      else await client.query(`update weddings set ${revoked}=now() where id=$1`, [w.weddingId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => { if (sql.includes('timeline_version::text') && /for share/.test(sql)) entered(); return client.query(sql, values) } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = Promise.resolve(teamProgramState(w, member.token))
      expect(await Promise.race([entering.then(() => 'lock'), response.then(() => 'early')])).toBe('lock')
      release(); await blocker
      const denied = await response
      expect(denied.statusCode, denied.body).toBe(revoked === 'role' ? 403 : revoked === 'session' || revoked === 'account' ? 401 : 404)
      expect(denied.body).not.toMatch(/previousAcknowledgment|acknowledgedBy|blockCount/)
    } finally { release(); await blocker; if (response) await response; app.db!.tx = original }
  })

  it('смена owner во время ожидания vendor lock отвергает неполный actor snapshot', async () => {
    const { w, vendor } = await programFixture()
    const next = await newUser(), nextCaller = await verifyAccessToken(SECRET_A, next.token)
    const snapshot = await readProgram(w, vendor.token)
    expect((await ackProgram(w, vendor.token, snapshot)).statusCode).toBe(200)
    let held!: () => void, entered!: () => void, release!: () => void
    const locked = new Promise<void>(r => { held = r }), entering = new Promise<void>(r => { entered = r }), released = new Promise<void>(r => { release = r })
    const original = app.db!.tx
    const blocker = original(async client => {
      await client.query('select id from vendors where id=$1 for update', [vendor.vendorId]); held(); await released
      await client.query('update vendors set user_id=$1 where id=$2', [nextCaller.sub, vendor.vendorId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => { if (sql.startsWith('select id,user_id,name from vendors')) entered(); return client.query(sql, values) } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = Promise.resolve(teamProgramState(w, w.token))
      expect(await Promise.race([entering.then(() => 'lock'), response.then(() => 'early')])).toBe('lock')
      release(); await blocker
      const rejected = await response
      expect(rejected.statusCode, rejected.body).toBe(409)
      expect(rejected.json().error.code).toBe('program_actors_changed')
      expect(rejected.body).not.toContain('acknowledgedAt')
    } finally { release(); await blocker; if (response) await response; app.db!.tx = original }
    expect((await teamProgramState(w, w.token)).json().items[0].status).toBe('pending')
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
  })

  it('legacy Учтено не подтверждает программу; точное ack сохраняет снимок и не наследуется новой редакцией', async () => {
    const { w, vendor, update } = await programFixture()
    const legacy = await app.inject({ method: 'POST', url: `/vendor/updates/${update.id}/ack`, headers: auth(vendor.token), payload: {} })
    expect(legacy.statusCode, legacy.body).toBe(204)
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    expect(snapshot.json().requiresAcknowledgment).toBe(true)
    const accepted = await ackProgram(w, vendor.token, snapshot)
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json()).toEqual({ sourceVersion: snapshot.json().sourceVersion, acknowledgedAt: expect.any(String) })
    const after = await readProgram(w, vendor.token)
    expect(after.json().requiresAcknowledgment).toBe(false)
    expect(after.json().acknowledgedAt).toBe(accepted.json().acknowledgedAt)
    const owner = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
    const changed = owner.json()
    changed[0].name = 'New service time plan'
    const saved = await app.inject({ method: 'PUT', url: `/weddings/${w.weddingId}/timeline`, headers: { ...auth(w.token), 'if-match': owner.headers.etag! }, payload: changed })
    expect(saved.statusCode, saved.body).toBe(200)
    const stale = await ackProgram(w, vendor.token, snapshot)
    expect(stale.statusCode, stale.body).toBe(409)
    const current = await readProgram(w, vendor.token)
    expect(current.json().requiresAcknowledgment).toBe(true)
    expect(current.json().acknowledgedAt).toBeNull()
    const history = await app.db!.query<{ program_snapshot: { blocks: { name: string }[] } }>('select program_snapshot from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])
    expect(history.rows).toHaveLength(1)
    expect(history.rows[0]!.program_snapshot.blocks[0]!.name).toBe('Own ceremony service')
    expect(JSON.stringify(history.rows)).not.toContain('SECRET INTERNAL BLOCK')
  })

  it('program ack требует исходную версию и действительный read proof, не принимает чужую сессию или access JWT', async () => {
    const { w, vendor } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const missing = await app.inject({ method: 'POST', url: programPath(w) + '/ack', headers: auth(vendor.token), payload: { readToken: snapshot.json().readToken } })
    expect(missing.statusCode, missing.body).toBe(428)
    for (const payload of [{}, { readToken: vendor.token }, { readToken: snapshot.json().readToken, force: true }]) {
      const invalid = await app.inject({ method: 'POST', url: programPath(w) + '/ack', headers: { ...auth(vendor.token), 'if-match': snapshot.headers.etag! }, payload })
      expect(invalid.statusCode, invalid.body).toBe(422)
    }
    const caller = await verifyAccessToken(SECRET_A, vendor.token)
    const sessionId = randomUUID()
    await app.db!.query('insert into sessions(id,user_id,refresh_hash,device) values($1,$2,$3,$4)', [sessionId, caller.sub, hashRefreshToken(randomUUID()), 'program-second-session'])
    const secondToken = await signAccessToken(SECRET_A, { sub: caller.sub, sid: sessionId })
    const crossSession = await ackProgram(w, secondToken, snapshot)
    expect(crossSession.statusCode, crossSession.body).toBe(422)
    const other = await newVendor()
    const stolen = await ackProgram(w, other.token, snapshot)
    expect(stolen.statusCode, stolen.body).toBe(404)
    const hidden = await readProgram(w, other.token)
    expect(hidden.statusCode, hidden.body).toBe(404)
    expect(hidden.body).not.toContain('Own ceremony service')
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
    const fresh = await readProgram(w, secondToken)
    expect((await ackProgram(w, secondToken, fresh)).statusCode).toBe(200)
  })

  it('program ack проверяет actual expiry и same-version content; отказ не пишет историю', async () => {
    const { w, vendor } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const caller = await verifyAccessToken(SECRET_A, vendor.token)
    const payload = { ...snapshot.json() }
    for (const key of ['acknowledgedAt', 'requiresAcknowledgment', 'readToken', 'expiresAt']) delete payload[key]
    const expired = await signProgramRead(SECRET_A, { weddingId: w.weddingId, vendorId: vendor.vendorId,
      userId: caller.sub, sessionId: caller.sid, version: snapshot.json().sourceVersion, digest: programDigest(payload) }, new Date(Date.now() - 601000))
    const refused = await app.inject({ method: 'POST', url: programPath(w) + '/ack', headers: { ...auth(vendor.token), 'if-match': snapshot.headers.etag! }, payload: { readToken: expired } })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.code).toBe('program_read_expired')
    await app.db!.query("update weddings set title='Changed visible wedding title' where id=$1", [w.weddingId])
    const changed = await readProgram(w, vendor.token)
    expect(changed.headers.etag).toBe(snapshot.headers.etag)
    const staleContent = await ackProgram(w, vendor.token, snapshot)
    expect(staleContent.statusCode, staleContent.body).toBe(409)
    expect(staleContent.json().error.code).toBe('program_snapshot_changed')
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
    expect((await ackProgram(w, vendor.token, changed)).statusCode).toBe(200)
  })

  it('parallel ack/retry сохраняют один снимок, время и audit event без изменения programme version', async () => {
    const { w, vendor } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const [a, b] = await Promise.all([ackProgram(w, vendor.token, snapshot), ackProgram(w, vendor.token, snapshot)])
    expect(a.statusCode, a.body).toBe(200)
    expect(b.statusCode, b.body).toBe(200)
    expect(a.json()).toEqual(b.json())
    const retry = await ackProgram(w, vendor.token, snapshot)
    expect(retry.json()).toEqual(a.json())
    const current = await readProgram(w, vendor.token)
    expect(current.headers.etag).toBe(snapshot.headers.etag)
    expect(current.json().requiresAcknowledgment).toBe(false)
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
    expect((await app.db!.query("select * from audit_log where entity_id=$1 and action='timeline.acknowledged'", [w.weddingId])).rowCount).toBe(1)
  })

  it('реальный DB отказ audit записи откатывает program ack, а следующая попытка сохраняет его', async () => {
    const { w, vendor } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const original = app.db!.tx
    let forced = false
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes('timeline.acknowledged')) {
        forced = true
        return client.query('select 1/0')
      }
      return client.query(sql, values)
    } }))
    try {
      const failed = await ackProgram(w, vendor.token, snapshot)
      expect(failed.statusCode, failed.body).toBe(500)
      expect(forced).toBe(true)
    } finally { app.db!.tx = original }
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
    expect((await app.db!.query("select * from audit_log where entity_id=$1 and action='timeline.acknowledged'", [w.weddingId])).rowCount).toBe(0)
    expect((await readProgram(w, vendor.token)).json().requiresAcknowledgment).toBe(true)
    expect((await ackProgram(w, vendor.token, snapshot)).statusCode).toBe(200)
  })

  it('booked vendor без назначений не получает фиктивного ожидания и readToken', async () => {
    const { w, vendor } = await updateFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    expect(snapshot.json()).toMatchObject({ blocks: [], requiresAcknowledgment: false, acknowledgedAt: null, readToken: null, expiresAt: null })
    const list = await app.inject({ method: 'GET', url: '/vendor/programs?limit=1', headers: auth(vendor.token) })
    expect(list.json().items[0]).toMatchObject({ blockCount: 0, requiresAcknowledgment: false })
  })

  it('token другой собственной свадьбы не подходит; programmes pagination не теряет заказы', async () => {
    const { w, vendor } = await programFixture()
    const first = await readProgram(w, vendor.token)
    expect(first.statusCode, first.body).toBe(200)
    const other = await newWedding()
    const rescheduled = await app.inject({ method: 'PATCH', url: `/weddings/${other.weddingId}`, headers: auth(other.token), payload: { date: '2027-10-03' } })
    expect(rescheduled.statusCode, rescheduled.body).toBe(200)
    await book(other, vendor.vendorId)
    const second = await readProgram(other, vendor.token)
    expect(second.statusCode, second.body).toBe(200)
    const wrongWedding = await app.inject({ method: 'POST', url: programPath(other) + '/ack',
      headers: { ...auth(vendor.token), 'if-match': second.headers.etag! }, payload: { readToken: first.json().readToken } })
    expect(wrongWedding.statusCode, wrongWedding.body).toBe(422)
    const page1 = await app.inject({ method: 'GET', url: '/vendor/programs?limit=1', headers: auth(vendor.token) })
    expect(page1.statusCode, page1.body).toBe(200)
    expect(page1.json().items).toHaveLength(1)
    expect(page1.json().nextCursor).toEqual(expect.any(String))
    const page2 = await app.inject({ method: 'GET', url: '/vendor/programs?limit=1&cursor=' + encodeURIComponent(page1.json().nextCursor), headers: auth(vendor.token) })
    expect(page2.statusCode, page2.body).toBe(200)
    expect(page2.json().items).toHaveLength(1)
    expect(page2.json().nextCursor).toBeNull()
    expect([page1.json().items[0].weddingId, page2.json().items[0].weddingId].sort()).toEqual([w.weddingId, other.weddingId].sort())
    const bad = await app.inject({ method: 'GET', url: '/vendor/programs?cursor=bad', headers: auth(vendor.token) })
    expect(bad.statusCode, bad.body).toBe(400)
    expect((await app.db!.query('select * from vendor_program_acknowledgments where vendor_id=$1', [vendor.vendorId])).rowCount).toBe(0)
  })

  it('actual independent event с неизвестной датой/поясом/окончанием остаётся неизвестным в разрешённом снимке', async () => {
    const { w, vendor } = await programFixture()
    const path = `/weddings/${w.weddingId}/timeline`
    const before = await app.inject({ method: 'GET', url: path, headers: auth(w.token) })
    const event = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/events`, headers: { ...auth(w.token), 'if-match': before.headers.etag! },
      payload: { name: 'Actual independent event', kind: 'other' } })
    expect(event.statusCode, event.body).toBe(201)
    const current = await app.inject({ method: 'GET', url: path, headers: auth(w.token) })
    const blocks = current.json()
    blocks[0] = { ...blocks[0], eventId: event.json().id, fixed: false, startsAt: null, endsAt: null, durationMinutes: null, travelMinutes: 10.5, bufferMinutes: 5.25 }
    const saved = await app.inject({ method: 'PUT', url: path, headers: { ...auth(w.token), 'if-match': current.headers.etag! }, payload: blocks })
    expect(saved.statusCode, saved.body).toBe(200)
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    expect(snapshot.json().blocks[0]).toMatchObject({ startsAt: null, endsAt: null, travelMinutes: 10.5, bufferMinutes: 5.25,
      event: { id: event.json().id, name: 'Actual independent event', date: null, timeZone: null, location: null } })
    expect((await ackProgram(w, vendor.token, snapshot)).statusCode).toBe(200)
  })

  it('новый владелец анкеты не наследует ознакомление прежнего пользователя', async () => {
    const { w, vendor } = await programFixture()
    const first = await readProgram(w, vendor.token)
    expect(first.statusCode, first.body).toBe(200)
    expect((await ackProgram(w, vendor.token, first)).statusCode).toBe(200)
    const next = await newUser()
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(next.token) })
    expect(me.statusCode, me.body).toBe(200)
    // Ownership transfer is a DB fixture, not a newly exposed transfer API.
    await app.db!.query('update vendors set user_id=$1 where id=$2', [me.json().id, vendor.vendorId])
    expect((await readProgram(w, vendor.token)).statusCode).toBe(404)
    const snapshot = await readProgram(w, next.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    expect(snapshot.json().requiresAcknowledgment).toBe(true)
    expect(snapshot.json().acknowledgedAt).toBeNull()
    expect((await ackProgram(w, next.token, first)).statusCode).toBe(422)
    expect((await ackProgram(w, next.token, snapshot)).statusCode).toBe(200)
    expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(2)
  })

  it.each((['GET', 'POST'] as const).flatMap(method =>
    (['deal', 'session', 'account', 'archived_at', 'cancelled_at'] as const).map(revoked => ({ method, revoked })),
  ))('program $method повторяет $revoked после ожидания wedding lock', async ({ method, revoked }) => {
    const { w, vendor, dealId } = await programFixture()
    const snapshot = await readProgram(w, vendor.token)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const caller = await verifyAccessToken(SECRET_A, vendor.token)
    let held!: () => void
    const locked = new Promise<void>(resolve => { held = resolve })
    let entered!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      await client.query('select id from weddings where id=$1 for update', [w.weddingId])
      held()
      await released
      if (revoked === 'deal') await client.query("update deals set state='cancelled' where id=$1", [dealId])
      else if (revoked === 'session') await client.query('update sessions set revoked_at=now() where id=$1', [caller.sid])
      else if (revoked === 'account') await client.query('update users set deleted_at=now() where id=$1', [caller.sub])
      else await client.query(`update weddings set ${revoked}=now() where id=$1`, [w.weddingId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (sql.includes('timeline_version::text') && /for (share|update)/.test(sql)) entered()
      return client.query(sql, values)
    } }))
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = Promise.resolve(method === 'GET' ? readProgram(w, vendor.token) : ackProgram(w, vendor.token, snapshot))
      expect(await Promise.race([entering.then(() => 'lock'), response.then(() => 'early')])).toBe('lock')
      release()
      await blocker
      const denied = await response
      expect(denied.statusCode, denied.body).toBe(revoked === 'session' || revoked === 'account' ? 401 : 404)
      expect(denied.body).not.toContain('Own ceremony service')
      expect((await app.db!.query('select * from vendor_program_acknowledgments where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
    } finally {
      release()
      await blocker
      if (response) await response
      app.db!.tx = original
    }
  })

  it('отмена последней брони скрывает старые обновления и запрещает их подтверждение', async () => {
    const { w, vendor, dealId, update } = await updateFixture()
    const slot = await app.db!.query<{ slot_id: string }>('select slot_id from deals where id=$1', [dealId])
    const cancelled = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot.rows[0]!.slot_id}/cancel`,
      headers: { ...auth(w.token), ...key() } })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })
    const ack = await app.inject({ method: 'POST', url: `/vendor/updates/${update.id}/ack`, headers: auth(vendor.token), payload: {} })
    const stored = await app.db!.query<{ ack_at: Date | null }>('select ack_at from vendor_updates where id=$1', [update.id])
    expect({ status: list.statusCode, rows: list.json(), ack: ack.statusCode, stored: stored.rows[0]!.ack_at })
      .toEqual({ status: 200, rows: [], ack: 404, stored: null })
  })

  it.each(['archived_at', 'cancelled_at'] as const)('%s не позволяет подтвердить прежнюю карточку', async field => {
    const { w, vendor, update } = await updateFixture()
    await app.db!.query(`update weddings set ${field}=now() where id=$1`, [w.weddingId])
    const list = await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })
    const ack = await app.inject({ method: 'POST', url: `/vendor/updates/${update.id}/ack`, headers: auth(vendor.token), payload: {} })
    const stored = await app.db!.query<{ ack_at: Date | null }>('select ack_at from vendor_updates where id=$1', [update.id])
    expect({ rows: list.json(), ack: ack.statusCode, stored: stored.rows[0]!.ack_at })
      .toEqual({ rows: [], ack: 404, stored: null })
  })

  it('оставшаяся бронь той же свадьбы сохраняет доступ, повтор ack не меняет время', async () => {
    const { w, vendor, dealId, update } = await updateFixture()
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json() as { id: string; deal: { id: string } | null }[]
    const slot = slots.find(s => !s.deal)!
    expect(slot).toBeDefined()
    const second = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(w.token), ...key() }, payload: { vendorId: vendor.vendorId, price: { amount: 1_000_000, currency: 'RUB' } } })
    expect(second.statusCode, second.body).toBe(200)
    const original = await app.db!.query<{ slot_id: string }>('select slot_id from deals where id=$1', [dealId])
    const cancelled = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${original.rows[0]!.slot_id}/cancel`,
      headers: { ...auth(w.token), ...key() } })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })
    expect(list.json().some((u: { id: string }) => u.id === update.id)).toBe(true)
    const ack = () => app.inject({ method: 'POST', url: `/vendor/updates/${update.id}/ack`, headers: auth(vendor.token), payload: {} })
    expect((await ack()).statusCode).toBe(204)
    const before = await app.db!.query<{ ack_at: Date }>('select ack_at from vendor_updates where id=$1', [update.id])
    expect(before.rows[0]!.ack_at).toBeInstanceOf(Date)
    expect((await ack()).statusCode).toBe(204)
    const after = await app.db!.query<{ ack_at: Date }>('select ack_at from vendor_updates where id=$1', [update.id])
    expect(after.rows).toEqual(before.rows)
  })

  it.each(['deal', 'session', 'account', 'archived_at', 'cancelled_at'] as const)(
    'ack перечитывает %s после ожидания wedding lock', async revoked => {
      const { w, vendor, dealId, update } = await updateFixture()
      const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(vendor.token) })
      expect(me.statusCode, me.body).toBe(200)
      let held!: () => void
      const locked = new Promise<void>(resolve => { held = resolve })
      let entered!: () => void
      const entering = new Promise<void>(resolve => { entered = resolve })
      let release!: () => void
      const released = new Promise<void>(resolve => { release = resolve })
      const original = app.db!.tx
      const blocker = original(async client => {
        await client.query('select id from weddings where id=$1 for update', [w.weddingId])
        held()
        await released
        if (revoked === 'deal') await client.query("update deals set state='cancelled' where id=$1", [dealId])
        else if (revoked === 'session') await client.query('update sessions set revoked_at=now() where user_id=$1', [me.json().id])
        else if (revoked === 'account') await client.query('update users set deleted_at=now() where id=$1', [me.json().id])
        else await client.query(`update weddings set ${revoked}=now() where id=$1`, [w.weddingId])
      })
      await locked
      // Observe the actual locking query; all responses come from PostgreSQL.
      app.db!.tx = action => original(client => action({ query: (sql, values) => {
        if (sql.includes('timeline_version::text') && sql.includes('for share')) entered()
        return client.query(sql, values)
      } }))
      let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
      try {
        response = Promise.resolve(app.inject({ method: 'POST', url: `/vendor/updates/${update.id}/ack`, headers: auth(vendor.token), payload: {} }))
        const reached = await Promise.race([entering.then(() => 'lock'), response.then(() => 'early')])
        expect(reached).toBe('lock')
        release()
        await blocker
        const denied = await response
        expect(denied.statusCode, denied.body).toBe(revoked === 'session' || revoked === 'account' ? 401 : 404)
        const stored = await app.db!.query<{ ack_at: Date | null }>('select ack_at from vendor_updates where id=$1', [update.id])
        expect(stored.rows[0]!.ack_at).toBeNull()
      } finally {
        release()
        await blocker
        if (response) await response
        app.db!.tx = original
      }
    },
  )
})
