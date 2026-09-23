/*
 * Ревью 016, FL-18 — SA-02 / ERR-0271 (сиблинг) / R-271: `POST
 * /weddings/{id}/album` считал кадры гостя и вставлял новый без транзакции
 * и без замка на строку гостя (`routes/day.ts:1477-1493` at e67ffcf; TR-1
 * §3.3 F-RL3-01, `findings\RL-3\races.log` R1: 7×201 при пределе 4,
 * ROADMAP.md §6 FL-01 / findings\TR-1.md §7 FL-18).
 *
 * Параллельный залп вставок ОДНОГО гостя видел одно и то же «меньше
 * предела» и проходил весь разом — предел на гостя (§9, R-55/R-61) не
 * держал, ровно как у `gifts.ts` до фикса (R-49) и у `auth.ts` (FL-01).
 *
 * Гонка проверяется только на прогретом пуле (§2.1 ROADMAP.md): холодный
 * пул сам сериализует залп, открывая соединения по одному.
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
const ALBUM_MAX = 4

describe.skipIf(!live)('FL-18 / ERR-0271 (сиблинг SA-02): гонка на POST /weddings/{id}/album — предел кадров гостя под замком', () => {
  let app: FastifyInstance
  let counter = 0
  /*
   * Собственный несменяемый префикс FL-18/p (conductor ruling, GATELOG line
   * 50 + ARB-1 §C4 data-safety rules): "491801" — не производный от вывода
   * psql.exe, отличается от FL-01 (490100) и от FL-18/q, FL-18/r.
   */
  const RUN = '491801'
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
        albumMaxPerGuest: ALBUM_MAX,
      },
      [],
    )
    await app.ready()
    // Защитная предочистка: чужого не трогает, только строки этого префикса.
    if ((await staleCount()) > 0) await eraseByPrefix()
  })

  afterAll(async () => {
    for (const id of createdUserIds) {
      await app.db!.tx((client) => eraseUser(client, id))
    }
    if ((await staleCount()) > 0) await eraseByPrefix()
    const left = await staleCount()
    await app?.close()
    if (left > 0) throw new Error(`FL-18/p: остались фикстуры префикса ${RUN}: ${left}`)
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

  /** Гость: создан парой, ссылка выпущена, код обменян на личный токен — ровно путь приложения. */
  async function newGuestToken(w: { token: string; weddingId: string }): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Гость залпа' },
    })
    expect(created.statusCode, created.body).toBe(201)
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id as string}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode, link.body).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const redeemed = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(redeemed.statusCode, redeemed.body).toBe(200)
    return redeemed.json().guestToken as string
  }

  /** Прогрев пула (§2.1 ROADMAP.md): холодный пул сериализует залп сам, гонка не видна. */
  async function warmPool() {
    await Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.2)')))
  }

  it('залп вставок одного гостя → ровно ALBUM_MAX×201 + остальные 429 album_limit; в базе ровно ALBUM_MAX строк', async () => {
    const w = await newWedding()
    const token = await newGuestToken(w)
    await warmPool()

    const BURST = ALBUM_MAX + 3
    const results = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/album?guestToken=${token}`,
          payload: { fileUrl: `https://example.com/${RUN}-${i}.jpg`, consent: true },
        }),
      ),
    )
    const statuses = results.map((r) => r.statusCode)
    expect(statuses.filter((s) => s === 201), JSON.stringify(statuses)).toHaveLength(ALBUM_MAX)
    expect(statuses.filter((s) => s === 429), JSON.stringify(statuses)).toHaveLength(BURST - ALBUM_MAX)
    for (const r of results) {
      if (r.statusCode === 429) expect(r.json().error.code).toBe('album_limit')
    }

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from album_photos where wedding_id = $1',
      [w.weddingId],
    )
    expect(rows[0]?.n, 'ровно ALBUM_MAX кадров в базе после залпа').toBe(String(ALBUM_MAX))
  })
})
