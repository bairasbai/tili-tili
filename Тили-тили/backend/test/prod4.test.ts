import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

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
  const RUN = String(randomInt(100_000, 1_000_000))
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
    await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
      payload: [{ name: 'Банкет', startsAt: '2027-10-02T15:00:00.000Z' }],
    })

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
    await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
      payload: [{ name: 'Сборы', startsAt: '2027-10-02T09:00:00.000Z' }],
    })

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
    await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
      payload: [{ name: 'Сборы', startsAt: '2027-10-02T09:00:00.000Z' }],
    })
    /* §13.2 говорит про подрядчика, «чья сделка в статусе booked».
     * Кандидату чужой тайминг не нужен, а знать его он не должен. */
    expect((await app.inject({ method: 'GET', url: '/vendor/updates', headers: auth(vendor.token) })).json()).toEqual([])
  })
})
