/*
 * Хвост ревью 016 — бэкенд, четыре находки, оставленные владельцу с эскизами
 * (`tasks/todo.md`, раздел «Владельцу · ревью 016»).
 *
 *  T1 F-RL-1-01 — `clientIp()` пропускал зону интерфейса (`fe80::1%eth0`):
 *     `net.isIP` считает такую строку валидным IPv6, а PostgreSQL `inet` её
 *     не принимает и отвечает 22P02 — 500 на `POST /auth/otp` и на записи
 *     согласия. Проверка чистая, без базы.
 *  T2 F-RL7-04 — `rotateNewcomers` вытесняла последнюю строку основной
 *     выдачи; курсор следующей страницы берётся по последней ОСТАВШЕЙСЯ, и
 *     при пустом остатке вытесненная анкета пропадала из каталога совсем.
 *     Проверка чистая, без базы.
 *  T3 F-RL3-03 — `rsvpDigest` слал сводку без ключа задачи: два прохода
 *     фоновых задач (перезапуск, два экземпляра) давали два уведомления всей
 *     команде свадьбы. Проверка с живой базой.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { buildApp } from '../src/app.js'
import { clientIp } from '../src/routes/auth.js'
import { rotateNewcomers } from '../src/catalog/vendors.js'
import { hashCode } from '../src/auth/otp.js'
import { rsvpDigest } from '../src/jobs/index.js'
import { uuidv7 } from '../src/ids.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const asRequest = (ip: string) => ({ ip }) as FastifyRequest

describe('T1 · F-RL-1-01: адрес клиента с зоной интерфейса не должен ронять запись', () => {
  it('зона отрезается, остаётся сам адрес', () => {
    expect(clientIp(asRequest('fe80::1%eth0'))).toBe('fe80::1')
    expect(clientIp(asRequest('fe80::1%25eth0'))).toBe('fe80::1')
  })

  it('обычные адреса не меняются', () => {
    expect(clientIp(asRequest('1.2.3.4'))).toBe('1.2.3.4')
    expect(clientIp(asRequest('::1'))).toBe('::1')
  })

  it('мусор — это null, а не «почти адрес»', () => {
    expect(clientIp(asRequest('%eth0'))).toBeNull()
    expect(clientIp(asRequest('не адрес'))).toBeNull()
    expect(clientIp(asRequest(''))).toBeNull()
  })
})

describe('T2 · F-RL7-04: ротация новичков не вытесняет последнюю строку выдачи', () => {
  const v = (id: string, reviewsCount: number) => ({ id, reviewsCount })

  it('limit=1: единственная анкета основной выдачи остаётся, новичок не подставляется', () => {
    const items = [v('main', 7)]
    const got = rotateNewcomers(items, 1, [v('new', 0)])
    expect(got.items.map((x) => x.id)).toEqual(['main'])
    expect(got.keptFromMain).toBe(1)
  })

  it('limit=2: одна строка вытесняется, одна остаётся якорем курсора', () => {
    const items = [v('a', 9), v('b', 5)]
    const got = rotateNewcomers(items, 2, [v('new', 0)])
    expect(got.items.map((x) => x.id)).toEqual(['a', 'new'])
    expect(got.keptFromMain).toBe(1)
  })

  it('limit=30: поведение приложения не изменилось — три новичка в хвосте', () => {
    const items = Array.from({ length: 30 }, (_, i) => v(`m${i}`, 4))
    const pool = Array.from({ length: 5 }, (_, i) => v(`n${i}`, 0))
    const got = rotateNewcomers(items, 30, pool)
    expect(got.keptFromMain).toBe(27)
    expect(got.items.slice(27).map((x) => x.id)).toEqual(['n0', 'n1', 'n2'])
  })

  it('пустая основная выдача: терять нечего, новички идут целиком', () => {
    const got = rotateNewcomers([] as { id: string; reviewsCount: number }[], 10, [v('n', 0)])
    expect(got.items.map((x) => x.id)).toEqual(['n'])
    expect(got.keptFromMain).toBe(0)
  })
})

describe.skipIf(!live)('T3 · F-RL3-03: сводка ответов гостей не задваивается', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259). */
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

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 and consumed_at is null order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  it('два прохода фоновых задач подряд дают одну сводку, а не две', async () => {
    const phone = `+79${RUN}${String(++counter).padStart(3, '0')}`
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const me = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(me.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(me.accessToken),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    const weddingId = w.json().id as string

    // Гость, ответивший за последние сутки, — то, что ищет сводка.
    await app.db!.query(
      `insert into guests (id, wedding_id, name, rsvp, plus_one, rsvp_token, rsvp_at)
       values ($1, $2, 'Гость сводки', 'yes', false, $3, now() - interval '1 hour')`,
      [uuidv7(), weddingId, `t-${RUN}-${counter}`],
    )

    const titled = async () =>
      Number(
        (
          await app.db!.query<{ n: string }>(
            `select count(*)::text as n from notifications
              where user_id = $1 and title = 'Ответы гостей за сутки'`,
            [me.user.id],
          )
        ).rows[0]!.n,
      )

    expect(await titled()).toBe(0)
    await rsvpDigest(app)
    expect(await titled()).toBe(1)
    // Второй проход — перезапуск задач или второй экземпляр сервера.
    await rsvpDigest(app)
    expect(await titled(), 'сводка ушла дважды — ключ задачи не держит').toBe(1)
  })
})
