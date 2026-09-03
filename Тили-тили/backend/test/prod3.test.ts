import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Волна 4: как сервер держится, когда что-то отваливается.
 *
 * Проверка не про «есть ли функция», а про поведение под отказом: заголовки
 * в каждом ответе, живой сервер при мёртвом Redis, честный /health/ready.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/** Порт, на котором заведомо ничего не слушает. */
const DEAD_REDIS = 'redis://127.0.0.1:16399'

describe.skipIf(!live)('прод: заголовки и поведение под отказом', () => {
  let app: FastifyInstance
  let counter = 0
  const RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    /* Приложение поднимается с мёртвым Redis — это и есть проверка.
     * Раньше сборка ждала подписки на канал чата и не заканчивалась
     * никогда: сервер не стартовал вообще. */
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: DEAD_REDIS,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
  }, 20_000)

  afterAll(async () => {
    await app?.close()
  })

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`

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

  /* ── заголовки ────────────────────────────────────────────────────── */
  it('каждый ответ несёт заголовки безопасности', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    /* Токен гостя стоит В АДРЕСЕ: без этого заголовка он уезжает в Referer
     * на любой сайт, куда гость перейдёт по ссылке из приглашения. */
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    /* Ответ по личной ссылке, осевший в кеше промежуточного узла, — это
     * чужие данные, выданные следующему за тем же адресом. */
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('заголовки стоят и на ошибке, а не только на успехе', async () => {
    const res = await app.inject({ method: 'GET', url: '/чего-тут-нет' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  /* ── мёртвый Redis ────────────────────────────────────────────────── */
  it('/health/ready честно говорит, что Redis лежит', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'not_ready', db: 'up', redis: 'down' })
    // Процесс при этом жив: по /health контейнер не перезапускают зря.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
  })

  it('запросы проходят и отвечают, а не висят в ожидании Redis', async () => {
    const user = await newUser()
    const started = Date.now()
    const res = await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })
    /* Ограничитель частоты стоит на КАЖДОМ запросе и ходит в Redis.
     * С бесконечными попытками команда не падала, а ждала — и вместе
     * с ней ждал весь сервер. Ограничитель защищает от перегрузки,
     * а не создаёт её. */
    expect(res.statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('сообщение в чат уходит и без живого канала между процессами', async () => {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-09-01',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)

    const chats = (await app.inject({ method: 'GET', url: '/chats', headers: auth(user.token) })).json() as {
      id: string
      kind: string
    }[]
    // Чат Тиль заводится вместе со свадьбой — командный ждёт второй сделки.
    const team = chats.find((c) => c.kind === 'tilly')!
    const sent = await app.inject({
      method: 'POST',
      url: `/chats/${team.id}/messages`,
      headers: auth(user.token),
      payload: { text: 'Проверка связи' },
    })
    /* Публикация события шла в Redis без обработки ошибки: с мёртвым Redis
     * отправка сообщения падала целиком, хотя само сообщение сохранить
     * ничто не мешает. Живой канал переживёт, переписка — нет. */
    expect(sent.statusCode).toBe(201)
    const history = await app.inject({
      method: 'GET',
      url: `/chats/${team.id}/messages`,
      headers: auth(user.token),
    })
    expect((history.json().items as { text: string }[]).map((m) => m.text)).toContain('Проверка связи')
  })
})
