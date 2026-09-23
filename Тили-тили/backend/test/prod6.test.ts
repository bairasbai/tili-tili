import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Иерархия переписки: кто с кем разговаривает (Бизнес-логика §3.11 и
 * «Иерархия управления днём X»).
 *
 * Командует днём X координатор — но командовать ему было негде: чат
 * команды по документу включает забронированных подрядчиков, а в коде
 * они его не видели. Плюс решение владельца 2026-09-03: отдельный чат
 * исполнителей без пары, факт существования которого пара видит.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: чаты команды и исполнителей', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона. В дев-базе десятки тысяч тестовых номеров
   * `+79RRRRRRNNN` от прежних прогонов, и случайный RUN раз в несколько
   * сотен прогонов совпадает с уже занятым — «у вас уже есть свадьба» на
   * свежем номере. Поэтому префикс перебирается до свободного (R-259). */
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

  const chats = (token: string) => app.inject({ method: 'GET', url: '/chats', headers: auth(token) })

  /** Свадьба с двумя бронями — с этого момента есть чаты команды и исполнителей. */
  async function weddingWithCrew() {
    const user = await newUser()
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-12-04',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    const weddingId = created.json().id as string
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(user.token) })
    ).json() as { id: string; categoryId: string }[]

    const booked = []
    for (const category of ['photo', 'venue']) {
      const vendor = await newVendor()
      const slot = slots.find((s) => s.categoryId === category) ?? slots[booked.length]!
      const res = await app.inject({
        method: 'POST',
        url: `/weddings/${weddingId}/slots/${slot.id}/book`,
        headers: { ...auth(user.token), ...key() },
        payload: { vendorId: vendor.vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
      })
      expect(res.statusCode).toBe(200)
      booked.push(vendor)
    }
    return { couple: user, weddingId, vendors: booked }
  }

  async function addCoordinator(weddingId: string, coupleToken: string) {
    const person = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(coupleToken),
      payload: { role: 'coordinator' },
    })
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(person.token),
    })
    return person
  }

  /* ── чат команды ──────────────────────────────────────────────────── */
  it('забронированный подрядчик сидит в чате команды вместе с парой', async () => {
    const { couple, weddingId, vendors } = await weddingWithCrew()
    const coordinator = await addCoordinator(weddingId, couple.token)

    const mine = (await chats(vendors[0]!.token)).json() as { id: string; kind: string; title: string }[]
    /* §3.11 дословно: «team — общий чат команды свадьбы (пара + помощники
     * + забронированные подрядчики)». Подрядчик его не видел вовсе —
     * и координатору было негде командовать всеми разом. */
    const team = mine.find((c) => c.kind === 'team')
    /* Подрядчику к названию добавляется свадьба: у него их несколько, и три
       строки «Команда свадьбы» он бы не различил. */
    expect(team?.title).toMatch(/^Команда свадьбы · /)

    // Координатор пишет всем разом, подрядчик читает и отвечает.
    const order = await app.inject({
      method: 'POST',
      url: `/chats/${team!.id}/messages`,
      headers: auth(coordinator.token),
      payload: { text: 'Сбор на площадке в 12:00, вход со двора' },
    })
    expect(order.statusCode).toBe(201)

    const history = await app.inject({
      method: 'GET',
      url: `/chats/${team!.id}/messages`,
      headers: auth(vendors[0]!.token),
    })
    expect((history.json().items as { text: string }[]).map((m) => m.text)).toContain(
      'Сбор на площадке в 12:00, вход со двора',
    )

    // Пара пишет туда же: цепочка приказов организационная, а не техническая.
    const fromCouple = await app.inject({
      method: 'POST',
      url: `/chats/${team!.id}/messages`,
      headers: auth(couple.token),
      payload: { text: 'Подтверждаем' },
    })
    expect(fromCouple.statusCode).toBe(201)
  })

  it('кандидат в чат команды не входит — только забронированный', async () => {
    const { couple, weddingId } = await weddingWithCrew()
    const stranger = await newVendor()
    // Лид без брони: подрядчик ещё ничего не обещал.
    await app.inject({ method: 'POST', url: `/chats/vendor/${stranger.vendorId}`, headers: auth(couple.token) })

    const mine = (await chats(stranger.token)).json() as { kind: string }[]
    expect(mine.map((c) => c.kind)).toEqual(['vendor'])

    const { rows } = await app.db!.query<{ id: string }>(
      "select id from chats where wedding_id = $1 and kind = 'team'",
      [weddingId],
    )
    const denied = await app.inject({
      method: 'GET',
      url: `/chats/${rows[0]!.id}/messages`,
      headers: auth(stranger.token),
    })
    // Чужой чат — 404: по коду ответа не должно быть видно, что он есть.
    expect(denied.statusCode).toBe(404)
  })

  /* ── чат исполнителей ─────────────────────────────────────────────── */
  it('координатор и подрядчики говорят без пары, а пара видит факт', async () => {
    const { couple, weddingId, vendors } = await weddingWithCrew()
    const coordinator = await addCoordinator(weddingId, couple.token)

    const crewForVendor = ((await chats(vendors[0]!.token)).json() as { id: string; kind: string }[]).find(
      (c) => c.kind === 'crew',
    )
    expect(crewForVendor).toBeTruthy()

    await app.inject({
      method: 'POST',
      url: `/chats/${crewForVendor!.id}/messages`,
      headers: auth(coordinator.token),
      payload: { text: 'Свет ставим в 11:00, розетки у сцены' },
    })

    /* Пара видит строку — но не реплику и не счётчик: скрытый чат,
     * о котором не сказали, становится скандалом в день, когда о нём
     * узнают, а показанная реплика выдала бы ровно то, что решено скрыть. */
    const forCouple = ((await chats(couple.token)).json() as {
      id: string
      kind: string
      title: string
      lastMessage: string
      unread: number
    }[]).find((c) => c.kind === 'crew')
    expect(forCouple).toBeTruthy()
    expect(forCouple!.title).toBe('Чат исполнителей — ведёт координатор')
    expect(forCouple!.lastMessage).toBe('Переписку ведёт координатор')
    expect(forCouple!.unread).toBe(0)

    const peek = await app.inject({
      method: 'GET',
      url: `/chats/${forCouple!.id}/messages`,
      headers: auth(couple.token),
    })
    expect(peek.statusCode).toBe(403)
    // Отказ объясняет устройство, а не выглядит поломкой.
    expect(peek.json().error.message).toContain('координатор')

    const write = await app.inject({
      method: 'POST',
      url: `/chats/${forCouple!.id}/messages`,
      headers: auth(couple.token),
      payload: { text: 'а что вы там обсуждаете' },
    })
    expect(write.statusCode).toBe(403)
  })

  it('подрядчик читает чат исполнителей и отвечает другому подрядчику', async () => {
    const { vendors } = await weddingWithCrew()
    const crewId = ((await chats(vendors[0]!.token)).json() as { id: string; kind: string }[]).find(
      (c) => c.kind === 'crew',
    )!.id

    await app.inject({
      method: 'POST',
      url: `/chats/${crewId}/messages`,
      headers: auth(vendors[0]!.token),
      payload: { text: 'Во сколько ставите декор?' },
    })
    const answer = await app.inject({
      method: 'POST',
      url: `/chats/${crewId}/messages`,
      headers: auth(vendors[1]!.token),
      payload: { text: 'С десяти, к двенадцати закончим' },
    })
    expect(answer.statusCode).toBe(201)

    const seen = await app.inject({
      method: 'GET',
      url: `/chats/${crewId}/messages`,
      headers: auth(vendors[0]!.token),
    })
    expect((seen.json().items as { text: string }[]).map((m) => m.text)).toContain('С десяти, к двенадцати закончим')
  })

  it('помощник в чат исполнителей не ходит', async () => {
    const { couple, weddingId } = await weddingWithCrew()
    const helper = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(helper.token),
    })

    const list = (await chats(helper.token)).json() as { kind: string }[]
    // Помощник ведёт гостей, а не подрядчиков: ни строки, ни доступа.
    expect(list.map((c) => c.kind)).not.toContain('crew')

    const { rows } = await app.db!.query<{ id: string }>(
      "select id from chats where wedding_id = $1 and kind = 'crew'",
      [weddingId],
    )
    const denied = await app.inject({
      method: 'GET',
      url: `/chats/${rows[0]!.id}/messages`,
      headers: auth(helper.token),
    })
    expect(denied.statusCode).toBe(403)
  })

  it('о сообщении в чате исполнителей паре не приходит уведомление', async () => {
    const { couple, weddingId, vendors } = await weddingWithCrew()
    const coordinator = await addCoordinator(weddingId, couple.token)
    const crewId = ((await chats(vendors[0]!.token)).json() as { id: string; kind: string }[]).find(
      (c) => c.kind === 'crew',
    )!.id

    await app.inject({
      method: 'POST',
      url: `/chats/${crewId}/messages`,
      headers: auth(vendors[0]!.token),
      payload: { text: 'Кто везёт стойки?' },
    })

    const forCouple = (await app.inject({ method: 'GET', url: '/notifications', headers: auth(couple.token) }))
      .json() as { title: string; link: string }[]
    /* Уведомлять о переписке, которую не покажут, — издевательство:
     * человек тапает и получает 403. */
    expect(forCouple.some((n) => n.link === `/chats/${crewId}`)).toBe(false)

    const forCoordinator = (
      await app.inject({ method: 'GET', url: '/notifications', headers: auth(coordinator.token) })
    ).json() as { link: string }[]
    expect(forCoordinator.some((n) => n.link === `/chats/${crewId}`)).toBe(true)
  })
})
