import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { RealtimeHub } from '../src/realtime/hub.js'
import { maskUrl } from '../src/redact.js'

/**
 * Живой канал чата и фоновые задачи.
 *
 * Критерий этапа — «сообщение доходит второму соединению меньше чем
 * за секунду». Проверяется настоящим WebSocket против поднятого сервера:
 * `app.inject` апгрейд соединения не делает и молчал бы (ERR-0049 — та же
 * история про заголовки).
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('хаб живого канала', () => {
  it('«печатает» уходит подписчикам чата, кроме самого автора, и только им', async () => {
    const hub = new RealtimeHub()
    const seen: Record<string, string[]> = { a: [], b: [], other: [] }
    hub.join('чат-1', { send: (d) => seen.a!.push(d) }, 'u1')
    hub.join('чат-1', { send: (d) => seen.b!.push(d) }, 'u2')
    hub.join('чат-2', { send: (d) => seen.other!.push(d) }, 'u3')

    /* Раньше тест закреплял доставку автору — и под полем ввода у того,
     * кто печатает сам, на четыре секунды вставало «собеседник печатает»
     * (D4-08). Своё событие о наборе автору не новость. */
    await hub.publish({ chatId: 'чат-1', type: 'typing', actorId: 'u1' })
    expect({ a: seen.a!.length, b: seen.b!.length, other: seen.other!.length }).toEqual({ a: 0, b: 1, other: 0 })
    expect(JSON.parse(seen.b![0]!)).toMatchObject({ type: 'typing', chatId: 'чат-1', actorId: 'u1' })
  })

  it('сообщение доходит и автору: у него может быть открыта вторая вкладка', async () => {
    const hub = new RealtimeHub()
    const seen: Record<string, string[]> = { a: [], b: [] }
    hub.join('чат-1', { send: (d) => seen.a!.push(d) }, 'u1')
    hub.join('чат-1', { send: (d) => seen.b!.push(d) }, 'u2')

    await hub.publish({ chatId: 'чат-1', type: 'message', actorId: 'u1', payload: { message: { text: 'привет' } } })
    expect({ a: seen.a!.length, b: seen.b!.length }).toEqual({ a: 1, b: 1 })
    expect(JSON.parse(seen.a![0]!)).toMatchObject({ type: 'message', actorId: 'u1', message: { text: 'привет' } })
  })

  it('соединение без имени владельца получает всё — исключать некого', async () => {
    const hub = new RealtimeHub()
    const seen: string[] = []
    hub.join('чат-1', { send: (d) => seen.push(d) })
    await hub.publish({ chatId: 'чат-1', type: 'typing', actorId: 'u1' })
    expect(seen).toHaveLength(1)
  })

  it('отписка убирает соединение, обрыв не роняет рассылку', async () => {
    const hub = new RealtimeHub()
    const alive: string[] = []
    const broken = {
      send() {
        throw new Error('соединение оборвалось')
      },
    }
    const good = { send: (d: string) => alive.push(d) }
    hub.join('чат', broken)
    hub.join('чат', good)

    // Одно мёртвое соединение не должно лишать сообщения остальных.
    await hub.publish({ chatId: 'чат', type: 'message', actorId: 'u1' })
    expect(alive).toHaveLength(1)

    hub.leave('чат', good)
    hub.leave('чат', broken)
    expect(hub.size('чат')).toBe(0)
  })

  it('токен живого канала маскируется в логе', () => {
    // Он стоит в адресе, потому что браузерный WebSocket заголовки
    // ставить не умеет — значит, попадёт в лог каждого запроса.
    expect(maskUrl('/chats/c1/ws?token=eyJhbGciOi')).toBe('/chats/c1/ws?token=***')
  })
})

describe.skipIf(!live)('живой канал против поднятого сервера', () => {
  let app: FastifyInstance
  let base: string
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
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    base = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '127.0.0.1:0'
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
    return token
  }

  async function newChat() {
    const couple = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(couple),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })
    const vendorToken = await newUser()
    const vendor = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendorToken),
      payload: {
        name: `Фотограф ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendorToken) })
    const chat = await app.inject({
      method: 'POST',
      url: `/chats/vendor/${vendor.json().id}`,
      headers: auth(couple),
    })
    expect(chat.statusCode).toBe(200)
    return { couple, vendorToken, chatId: chat.json().id as string, weddingId: w.json().id as string }
  }

  /** Подключается и ждёт первое событие нужного вида. */
  function listen(chatId: string, token: string) {
    const socket = new WebSocket(`ws://${base}/chats/${chatId}/ws?token=${encodeURIComponent(token)}`)
    const events: Record<string, unknown>[] = []
    const ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener('message', (e) => {
        const parsed = JSON.parse(String(e.data)) as Record<string, unknown>
        events.push(parsed)
        if (parsed.type === 'ready') resolve()
        if (parsed.type === 'error') reject(new Error(String(parsed.code)))
      })
      socket.addEventListener('error', () => reject(new Error('соединение не открылось')))
    })
    const waitFor = (type: string, ms = 1000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const found = events.find((e) => e.type === type)
        if (found) return resolve(found)
        const timer = setTimeout(() => reject(new Error(`не дождались ${type} за ${ms} мс`)), ms)
        socket.addEventListener('message', (e) => {
          const parsed = JSON.parse(String(e.data)) as Record<string, unknown>
          if (parsed.type === type) {
            clearTimeout(timer)
            resolve(parsed)
          }
        })
      })
    return { socket, ready, waitFor, events }
  }

  it('сообщение доходит второму соединению меньше чем за секунду', async () => {
    const { couple, vendorToken, chatId } = await newChat()
    const listener = listen(chatId, vendorToken)
    await listener.ready

    const started = Date.now()
    const sent = await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(couple),
      payload: { text: 'Здравствуйте!' },
    })
    expect(sent.statusCode).toBe(201)

    const event = await listener.waitFor('message')
    expect(Date.now() - started).toBeLessThan(1000)
    expect((event.message as { text: string }).text).toBe('Здравствуйте!')
    listener.socket.close()
  })

  it('«печатает…» доходит до собеседника и ничего не сохраняет', async () => {
    const { couple, vendorToken, chatId } = await newChat()
    const listener = listen(chatId, vendorToken)
    await listener.ready

    const res = await app.inject({ method: 'POST', url: `/chats/${chatId}/typing`, headers: auth(couple) })
    expect(res.statusCode).toBe(204)
    const event = await listener.waitFor('typing')
    expect(event.chatId).toBe(chatId)

    // «Печатает» живёт секунды — в истории его быть не должно.
    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from messages where chat_id = $1',
      [chatId],
    )
    expect(Number(rows[0]!.n)).toBe(0)
    listener.socket.close()
  })

  it('D4-08: своё «печатает…» автору не приходит, собеседнику — приходит', async () => {
    const { couple, vendorToken, chatId } = await newChat()
    const author = listen(chatId, couple)
    const peer = listen(chatId, vendorToken)
    await Promise.all([author.ready, peer.ready])

    const res = await app.inject({ method: 'POST', url: `/chats/${chatId}/typing`, headers: auth(couple) })
    expect(res.statusCode).toBe(204)
    await peer.waitFor('typing')
    await new Promise((r) => setTimeout(r, 150))
    // Человек печатает сам — «собеседник печатает» под его полем ввода ложь.
    expect(author.events.filter((e) => e.type === 'typing')).toHaveLength(0)
    expect(peer.events.filter((e) => e.type === 'typing')).toHaveLength(1)
    author.socket.close()
    peer.socket.close()
  })

  it('без токена канал не открывается, а объясняет причину', async () => {
    const { chatId } = await newChat()
    const socket = new WebSocket(`ws://${base}/chats/${chatId}/ws`)
    const closed = await new Promise<{ code: number; error?: string }>((resolve) => {
      let error: string | undefined
      socket.addEventListener('message', (e) => {
        error = (JSON.parse(String(e.data)) as { code?: string }).code
      })
      socket.addEventListener('close', (e) => resolve({ code: e.code, error }))
    })
    // Молча оборвать рукопожатие значило бы «сеть барахлит» вместо
    // «нужен токен»: клиент переподключался бы бесконечно.
    expect(closed).toEqual({ code: 4401, error: 'unauthorized' })
  })

  it('соединение не переживает срок токена', async () => {
    const { vendorToken, chatId } = await newChat()
    const listener = listen(chatId, vendorToken)
    await listener.ready
    const ready = listener.events.find((e) => e.type === 'ready')!
    // Сокет живёт часами, токен — 15 минут. Без явного закрытия помощник,
    // которого только что убрали из команды, читал бы чат до конца дня.
    const left = new Date(String(ready.expiresAt)).getTime() - Date.now()
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThanOrEqual(15 * 60_000 + 5_000)
    listener.socket.close()
  })

  it('без согласия на ПДн канал не открывается', async () => {
    const { chatId } = await newChat()
    // Пользователь вошёл, но согласия не давал: обычные пути отвечают 403,
    // и канал обязан вести себя так же, а не пускать в обход.
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const token = v.json().accessToken as string

    const socket = new WebSocket(`ws://${base}/chats/${chatId}/ws?token=${encodeURIComponent(token)}`)
    const closed = await new Promise<{ code: number; error?: string }>((resolve) => {
      let error: string | undefined
      socket.addEventListener('message', (e) => {
        error = (JSON.parse(String(e.data)) as { code?: string }).code
      })
      socket.addEventListener('close', (e) => resolve({ code: e.code, error }))
    })
    expect(closed).toEqual({ code: 4403, error: 'forbidden' })
  })

  it('«печатает…» прореживается, а не заливает канал', async () => {
    const { couple, vendorToken, chatId } = await newChat()
    const listener = listen(chatId, vendorToken)
    await listener.ready

    // Клавиатура шлёт событие на каждое нажатие: десять подряд — это одно
    // «печатает», а не десять публикаций в общий канал.
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: `/chats/${chatId}/typing`, headers: auth(couple) })
      expect(res.statusCode).toBe(204)
    }
    await listener.waitFor('typing')
    await new Promise((r) => setTimeout(r, 150))
    expect(listener.events.filter((e) => e.type === 'typing')).toHaveLength(1)
    listener.socket.close()
  })

  it('в чужой чат канал не пускает', async () => {
    const { chatId } = await newChat()
    const stranger = await newUser()
    const socket = new WebSocket(`ws://${base}/chats/${chatId}/ws?token=${encodeURIComponent(stranger)}`)
    const closed = await new Promise<number>((resolve) => {
      socket.addEventListener('close', (e) => resolve(e.code))
    })
    expect(closed).toBe(4404)
  })
})
