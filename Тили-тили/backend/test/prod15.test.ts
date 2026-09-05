import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Чат глазами обеих сторон.
 *
 * Перепроверка этапа 10: подрядчик видел список, где каждая строка называлась
 * ЕГО именем — «Студия «Пион»», «Студия «Пион»», — и различить, какая пара
 * пишет, было невозможно. Общие чаты повторялись по числу свадеб с
 * одинаковым названием.
 *
 * Собеседник у пары — подрядчик, у подрядчика — пара. Это и проверяется.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: чат с двух сторон', () => {
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

  async function newUser() {
    const phone = `+79${RUN}${String(counter++).padStart(3, '0')}`
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    let code = ''
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) {
        code = c
        break
      }
    }
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token }
  }

  async function newWedding(partner: string) {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: partner, date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string, title: res.json().title as string }
  }

  async function newVendor(name: string) {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: { name, categoryId: 'florist', city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    expect(res.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string, name }
  }

  const chatsOf = async (token: string) =>
    (await app.inject({ method: 'GET', url: '/chats', headers: auth(token) })).json() as {
      id: string
      kind: string
      title: string
      unread: number
      lastMessage: string
    }[]

  it('название чата — имя собеседника, а не своё', async () => {
    const vendor = await newVendor(`Студия ${RUN}`)
    const first = await newWedding('Тимур')
    const second = await newWedding('Марк')

    for (const couple of [first, second]) {
      const opened = await app.inject({
        method: 'POST',
        url: `/chats/vendor/${vendor.vendorId}`,
        headers: auth(couple.token),
      })
      expect(opened.statusCode).toBe(200)
    }

    // Пара видит подрядчика.
    const coupleSide = await chatsOf(first.token)
    expect(coupleSide.find(c => c.kind === 'vendor')?.title).toBe(vendor.name)

    /* Подрядчик видит ПАРЫ. Раньше обе строки назывались его собственным
       именем, и понять, кто из них кто, было нельзя. */
    const vendorSide = (await chatsOf(vendor.token)).filter(c => c.kind === 'vendor')
    expect(vendorSide).toHaveLength(2)
    expect(vendorSide.map(c => c.title).sort()).toEqual([first.title, second.title].sort())
    expect(vendorSide.some(c => c.title === vendor.name)).toBe(false)
  })

  it('непрочитанное считается у того, кто не писал, и гаснет при чтении', async () => {
    const vendor = await newVendor(`Студия ${RUN}-2`)
    const couple = await newWedding('Тимур')
    const chat = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(couple.token) })
    ).json() as { id: string }

    await app.inject({
      method: 'POST',
      url: `/chats/${chat.id}/messages`,
      headers: auth(vendor.token),
      payload: { text: 'Дата свободна, обсудим детали' },
    })

    const before = (await chatsOf(couple.token)).find(c => c.id === chat.id)
    expect(before?.unread).toBe(1)
    // Своё сообщение непрочитанным не считается.
    expect((await chatsOf(vendor.token)).find(c => c.id === chat.id)?.unread).toBe(0)

    // Открыл историю — значит прочитал.
    await app.inject({ method: 'GET', url: `/chats/${chat.id}/messages`, headers: auth(couple.token) })
    expect((await chatsOf(couple.token)).find(c => c.id === chat.id)?.unread).toBe(0)
  })

  it('история длиннее страницы отдаёт курсор, а не обрывается молча', async () => {
    const vendor = await newVendor(`Студия ${RUN}-3`)
    const couple = await newWedding('Тимур')
    const chat = (
      await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(couple.token) })
    ).json() as { id: string }

    await app.db!.query(
      `insert into messages (id, chat_id, sender_id, text, created_at)
       select gen_random_uuid(), $1, null, 'Сообщение ' || g, now() - (g || ' minutes')::interval
         from generate_series(1, 12) g`,
      [chat.id],
    )

    const page = await app.inject({
      method: 'GET',
      url: `/chats/${chat.id}/messages?limit=5`,
      headers: auth(couple.token),
    })
    const body = page.json() as { items: unknown[]; nextCursor: string | null }
    expect(body.items).toHaveLength(5)
    /* Курсор — единственный признак, по которому экран понимает, что переписка
       началась не здесь. Без него человек видит середину и считает её началом. */
    expect(body.nextCursor).toBeTruthy()

    const all = await app.inject({
      method: 'GET',
      url: `/chats/${chat.id}/messages?limit=50`,
      headers: auth(couple.token),
    })
    expect((all.json() as { items: unknown[] }).items).toHaveLength(12)
    expect((all.json() as { nextCursor: string | null }).nextCursor).toBeNull()
  })
})
