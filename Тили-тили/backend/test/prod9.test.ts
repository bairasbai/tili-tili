import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Дата свадьбы: часовой пояс тайминга и первая простановка даты.
 *
 * Две ошибки, найденные при переводе фронта на сервер.
 *
 * Первая: время блоков тайминга собиралось строкой `${дата}T08:00:00Z` — то
 * есть шаблонные «сборы невесты в 08:00» записывались как 08:00 UTC. У пары в
 * Казани (+3) экран показывал 11:00, в Уфе (+5) — 13:00. Ровно на разницу
 * поясов, и одинаково незаметно: время выглядит правдоподобным.
 *
 * Вторая: квиз разрешает ответ «пока не знаем», и такая свадьба заводилась с
 * пустыми сроками задач и пустым таймингом. Перенос умел только сдвигать
 * существующие сроки на разницу дат, поэтому у пары, выбравшей дату позже,
 * чек-лист навсегда оставался без дедлайнов, а день X — без часов.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: пояс тайминга и первая дата', () => {
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
  const key = () => ({ 'idempotency-key': `k8-${RUN}-${++counter}` })
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`

  async function newUser() {
    const phone = nextPhone()
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

  /** Уфа — пояс +5, разница с UTC заметна и не совпадает с московской. */
  async function newWedding(date: string | null) {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        ...(date ? { date } : {}),
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  /** Час и минуты события в поясе свадьбы — так же, как их читает экран. */
  const localTime = (iso: string, tz: string) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(iso))

  it('сборы начинаются в 08:00 по месту свадьбы, а не по UTC', async () => {
    const { token, weddingId } = await newWedding('2027-06-14')
    const res = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/timeline`, headers: auth(token) })
    expect(res.statusCode).toBe(200)
    const first = res.json()[0] as { name: string; startsAt: string }
    expect(first.name).toBe('Сборы невесты')
    // До фикса здесь было 13:00: 08:00 UTC, прочитанные в поясе Уфы.
    expect(localTime(first.startsAt, 'Asia/Yekaterinburg')).toBe('08:00')
  })

  it('первая дата заводит сроки задач, а не оставляет их пустыми', async () => {
    const { token, weddingId } = await newWedding(null)

    const before = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/tasks`, headers: auth(token) })
    expect((before.json() as { due: string | null }[]).every(t => !t.due)).toBe(true)

    const patch = await app.inject({
      method: 'PATCH',
      url: `/weddings/${weddingId}`,
      headers: { ...auth(token), ...key() },
      payload: { date: '2027-06-14' },
    })
    expect(patch.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/tasks`, headers: auth(token) })
    const tasks = after.json() as { title: string; period: string; due: string | null }[]
    const nine = tasks.find(t => t.period === '9')
    expect(nine).toBeDefined()
    // «За 9 месяцев до 14 июня 2027» — сентябрь 2026.
    expect(nine!.due).toBe('2026-09-14')
    expect(tasks.every(t => t.due)).toBe(true)
  })

  it('первая дата заводит и часы тайминга — в поясе свадьбы', async () => {
    const { token, weddingId } = await newWedding(null)

    const before = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/timeline`, headers: auth(token) })
    expect((before.json() as { startsAt: string | null }[]).every(e => !e.startsAt)).toBe(true)

    await app.inject({
      method: 'PATCH',
      url: `/weddings/${weddingId}`,
      headers: { ...auth(token), ...key() },
      payload: { date: '2027-06-14' },
    })

    const after = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/timeline`, headers: auth(token) })
    const events = after.json() as { name: string; startsAt: string }[]
    expect(events.every(e => e.startsAt)).toBe(true)
    expect(localTime(events[0]!.startsAt, 'Asia/Yekaterinburg')).toBe('08:00')
    // Банкет по шаблону в 18:00 — проверяем не только первый блок.
    const banquet = events.find(e => e.name === 'Банкет')
    expect(localTime(banquet!.startsAt, 'Asia/Yekaterinburg')).toBe('18:00')
  })
})
