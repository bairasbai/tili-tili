/*
 * Ревью 016, FL-18 — SA-04 / ERR-0271 (сиблинг) / R-271: `POST
 * /deals/{id}/contract` (`routes/documents.ts:131-155` at e67ffcf) читал
 * `max(version)` и вставлял новую версию без транзакции и без замка на
 * строку сделки (TR-1 §3.3 F-RL-2-01, `findings\RL-2\repro.log`:
 * `[201,201]` при версиях `[1,1]`, ROADMAP.md §6 FL-01 / findings\TR-1.md
 * §7 FL-18).
 *
 * Залп переоформлений договора БЕЗ Idempotency-Key (контракт не объявляет
 * заголовок обязательным на этом пути, RL-6 §2 — `withIdempotency(…,
 * false)`) видел одно и то же «максимум N» и вставлял одну и ту же версию
 * N+1 дважды — история переговоров расходилась с тем, что подписано.
 *
 * Гонка проверяется только на прогретом пуле (§2.1 ROADMAP.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('FL-18 / ERR-0271 (сиблинг SA-04): гонка на POST /deals/{id}/contract — версия документа под замком', () => {
  let app: FastifyInstance
  let counter = 0
  /* Собственный несменяемый префикс FL-18/r: "491803" — отличается от FL-01 (490100) и FL-18/p, FL-18/q. */
  const RUN = '491803'
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
    if (left > 0) throw new Error(`FL-18/r: остались фикстуры префикса ${RUN}: ${left}`)
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const idem = (token: string) => ({ ...auth(token), 'idempotency-key': randomUUID() })

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
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    expect(res.statusCode, res.body).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  async function newVendor(categoryId = 'photo') {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Подрядчик ${RUN}-${counter}`,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
        priceFrom: { amount: 8_500_000, currency: 'RUB' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    return { ...user, vendorId: res.json().id as string }
  }

  const slotsOf = async (token: string, weddingId: string) =>
    (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
      deal: { id: string; state: string } | null
    }[]

  async function book(w: { token: string; weddingId: string }, slotId: string, vendorId: string, amount: number) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId, price: { amount, currency: 'RUB' } },
    })
    expect(res.statusCode, res.body).toBe(200)
  }

  /** Прогрев пула (§2.1 ROADMAP.md). */
  async function warmPool() {
    await Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.2)')))
  }

  it('залп переоформлений договора без ключа → версии 1..N без дублей', async () => {
    const vendor = await newVendor()
    const w = await newWedding()
    const slot = (await slotsOf(w.token, w.weddingId)).find((s) => s.categoryId === 'photo')!
    await book(w, slot.id, vendor.vendorId, 5_000_000)
    const dealId = (await slotsOf(w.token, w.weddingId)).find((s) => s.id === slot.id)!.deal!.id

    await warmPool()
    const BURST = 6
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        app.inject({
          method: 'POST',
          url: `/deals/${dealId}/contract`,
          headers: auth(w.token), // без Idempotency-Key — контракт его здесь не требует (RL-6 §2)
          payload: {
            templateCode: 'photographer',
            fields: { customerFullName: 'Алина Иванова', performerFullName: 'Пётр Петров' },
          },
        }),
      ),
    )
    const statuses = results.map((r) => r.statusCode)
    expect(statuses.every((s) => s === 201), JSON.stringify(statuses)).toBe(true)

    const versions = results.map((r) => r.json().version as number).sort((a, b) => a - b)
    expect(versions, JSON.stringify(versions)).toEqual(Array.from({ length: BURST }, (_, i) => i + 1))

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(distinct version)::text as n from documents where deal_id = $1',
      [dealId],
    )
    expect(rows[0]?.n, 'ровно BURST различных версий в базе — ни одна не задвоилась').toBe(String(BURST))
  })
})
