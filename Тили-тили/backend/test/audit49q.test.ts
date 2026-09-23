/*
 * Ревью 016, FL-18 — SA-03 / ERR-0271 (сиблинг) / R-271: `assertNotColdOutreach`
 * (`chats/post.ts:189-230` at e67ffcf) считало «сколько новых переписок
 * подрядчик начал сегодня» на пуле, ДО транзакции вставки сообщения (TR-1
 * §3.3 F-RL3-02, `findings\RL-3\races.log` R2: 6×201 при пределе 3,
 * ROADMAP.md §6 FL-01 / findings\TR-1.md §7 FL-18).
 *
 * Залп первых сообщений непроверенного подрядчика в РАЗНЫЕ чаты видел одно
 * и то же «меньше предела» и проходил весь разом — предел §18.2/§19.4
 * (ERR-0100) не держал под параллельной нагрузкой.
 *
 * Гонка проверяется только на прогретом пуле (§2.1 ROADMAP.md). Ответы на
 * входящие (`here`-короткое замыкание) и последовательный контроль
 * остаются в `test/audit13-live.test.ts` без изменений — эта регрессия не
 * трогает их поведение, только серийность подсчёта под нагрузкой.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)
/** Маленький предел из харнесса (ROADMAP FL-18 mechanism) — залп быстрый и однозначный. */
const COLD_OUTREACH_LIMIT = 3

describe.skipIf(!live)('FL-18 / ERR-0271 (сиблинг SA-03): гонка на первое сообщение подрядчика — предел холодных переписок под замком', () => {
  let app: FastifyInstance
  let counter = 0
  /* Собственный несменяемый префикс FL-18/q: "491802" — отличается от FL-01 (490100) и FL-18/p, FL-18/r. */
  const RUN = '491802'
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUserIds: string[] = []

  /* Счёт по двум таблицам: `otp_codes` не висит на `users` внешним ключом
   * (код выдаётся ДО регистрации), поэтому `eraseUser` его не трогает —
   * без отдельного счёта и удаления здесь эти строки пережили бы прогон. */
  async function staleCount(): Promise<number> {
    const { rows: u } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from users where phone like '+79' || $1 || '%'",
      [RUN],
    )
    const { rows: o } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from otp_codes where phone like '+79' || $1 || '%'",
      [RUN],
    )
    return Number(u[0]?.n ?? 0) + Number(o[0]?.n ?? 0)
  }

  async function eraseByPrefix(): Promise<void> {
    const { rows } = await app.db!.query<{ id: string }>(
      "select id from users where phone like '+79' || $1 || '%'",
      [RUN],
    )
    for (const row of rows) {
      await app.db!.tx((client) => eraseUser(client, row.id))
    }
    await app.db!.query("delete from otp_codes where phone like '+79' || $1 || '%'", [RUN])
  }

  beforeAll(async () => {
    app = await buildApp(
      {
        env: 'test',
        databaseUrl: DB ?? null,
        redisUrl: null,
        corsOrigins: [],
        jwtAccessSecret: SECRET_A,
        jwtRefreshSecret: SECRET_R,
        policyVersion: '2026-09-02',
        otpMaxPerHourTotal: 1_000_000,
        otpMaxPerIpHour: 1_000_000,
        coldOutreachPerDay: COLD_OUTREACH_LIMIT,
      },
      [],
    )
    await app.ready()
    if ((await staleCount()) > 0) await eraseByPrefix()
  })

  afterAll(async () => {
    for (const id of createdUserIds) {
      await app.db!.tx((client) => eraseUser(client, id))
    }
    if ((await staleCount()) > 0) await eraseByPrefix()
    const left = await staleCount()
    await app?.close()
    if (left > 0) throw new Error(`FL-18/q: остались фикстуры префикса ${RUN}: ${left}`)
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
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

  async function newUser() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const { accessToken, user } = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    createdUserIds.push(user.id)
    return { token: accessToken, id: user.id }
  }

  async function newWedding() {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: { partnerName: 'Тимур', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' } },
    })
    expect(res.statusCode, res.body).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  /** Подрядчик без проверки анкеты: `publish` не выставляет `verified_at` (это отдельное модераторское действие). */
  async function newVendor() {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Подрядчик ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Уфа', region: 'Башкортостан' },
      },
    })
    expect(res.statusCode, res.body).toBeLessThan(300)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  async function openChat(couple: { token: string }, vendorId: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: `/chats/vendor/${vendorId}`, headers: auth(couple.token) })
    expect(res.statusCode, res.body).toBeLessThan(300)
    return res.json().id as string
  }

  const send = (token: string, chatId: string, text: string) =>
    app.inject({ method: 'POST', url: `/chats/${chatId}/messages`, headers: auth(token), payload: { text } })

  /** Прогрев пула (§2.1 ROADMAP.md). */
  async function warmPool() {
    await Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.2)')))
  }

  it('залп первых сообщений в разные чаты → ровно LIMIT×201 + остальные 429 cold_outreach_limit', async () => {
    const vendor = await newVendor()
    const BURST = COLD_OUTREACH_LIMIT + 3

    // Пары открывают чаты ЗАРАНЕЕ (последовательно — не часть гонки):
    // гонка — только в подсчёте «сколько новых переписок сегодня».
    const chatIds: string[] = []
    for (let i = 0; i < BURST; i++) {
      const couple = await newWedding()
      chatIds.push(await openChat(couple, vendor.vendorId))
    }

    await warmPool()
    const results = await Promise.all(
      chatIds.map((chatId, i) => send(vendor.token, chatId, `Здравствуйте, предлагаю услуги ${i}`)),
    )
    const statuses = results.map((r) => r.statusCode)
    expect(statuses.filter((s) => s === 201), JSON.stringify(statuses)).toHaveLength(COLD_OUTREACH_LIMIT)
    expect(statuses.filter((s) => s === 429), JSON.stringify(statuses)).toHaveLength(BURST - COLD_OUTREACH_LIMIT)
    for (const r of results) {
      if (r.statusCode === 429) expect(r.json().error.code).toBe('cold_outreach_limit')
    }

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from messages where sender_id = $1 and chat_id = any($2::uuid[])',
      [vendor.id, chatIds],
    )
    expect(rows[0]?.n, 'ровно LIMIT сообщений подрядчика в базе после залпа').toBe(String(COLD_OUTREACH_LIMIT))
  })
})
