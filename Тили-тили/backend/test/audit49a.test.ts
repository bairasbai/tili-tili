/*
 * Ревью 016, FL-01 — SA-01 / ERR-0271 / R-271: `POST /auth/otp` читал окно
 * выдач и лимиты, а затем вставлял код без транзакции и без замка на номер
 * (scout A `evidence\scout-A-backend.md` §1, `scratch\scout-A\otp-race.log`,
 * ROADMAP.md §6 FL-01). Шесть параллельных запросов на один номер видели
 * одно и то же пустое окно и проходили все лимиты разом — шесть SMS и
 * шесть живых кодов на один номер (счёт наш, а «неверных» попыток при
 * проверке впятеро больше положенного).
 *
 * Гонка проверяется только на прогретом пуле (§2.1 ROADMAP.md): холодный
 * пул сам сериализует залп, открывая соединения по одному, и «проходит»
 * даже без фикса — это не отклонение находки.
 *
 * T1 — залп на один номер: ровно 1×200 + 5×429, в базе одна строка.
 * T3 — продолжение T1: седьмой (последовательный) запрос тоже 429, а
 *      единственный живой код проверяется штатно (verify → 200).
 * T2 — замок держит номер, а не таблицу: шесть РАЗНЫХ номеров с одного
 *      IP проходят все шесть (лимит по IP в харнессе снят, как в audit48).
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

describe.skipIf(!live)('FL-01 / ERR-0271 / R-271: гонка на POST /auth/otp — лимит на номер под замком', () => {
  let app: FastifyInstance
  let counter = 0
  /*
   * Собственный несменяемый префикс лейна FL-01 (conductor ruling, GATELOG
   * line 50): "fl01_490100" — не производный от вывода psql.exe, не
   * время-случайный. `otp_codes.phone` хранит только цифры (`normalizePhone`
   * снимает всё нецифровое), поэтому в базе префикс — цифровой хвост токена:
   * номера этого файла все вида `+79490100NNN`. Уборка ниже трогает только
   * строки с этим префиксом, ничего чужого.
   */
  const RUN = '490100'
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUserIds: string[] = []

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
        // Общий потолок и лимит по адресу измеряются в audit12 — здесь они
        // мешали бы наблюдать лимит по номеру; per-phone лимиты на значениях
        // по умолчанию (§5.6 ROADMAP.md харнесс).
        otpMaxPerHourTotal: 1_000_000,
        otpMaxPerIpHour: 1_000_000,
      },
      [],
    )
    await app.ready()

    // Защитная предочистка: если прошлый прогон этого файла упал до своей
    // afterAll, его же fl01_490100-строки не должны портить счёт нового
    // прогона. Dry-run count сначала, delete — только если что-то нашлось.
    const { rows: stale } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from otp_codes where phone like '+79' || $1 || '%'",
      [RUN],
    )
    if (Number(stale[0]?.n ?? 0) > 0) {
      await app.db!.query("delete from otp_codes where phone like '+79' || $1 || '%'", [RUN])
    }
  })

  afterAll(async () => {
    // Уборка — только фикстуры этого лейна (ruling GATELOG line 50): dry-run
    // select count по своему префиксу, потом delete в порядке eraseUser для
    // созданных пользователей, затем прямой delete оставшихся otp_codes.
    for (const id of createdUserIds) {
      await app.db!.tx((client) => eraseUser(client, id))
    }
    const { rows: left } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from otp_codes where phone like '+79' || $1 || '%'",
      [RUN],
    )
    if (Number(left[0]?.n ?? 0) > 0) {
      await app.db!.query("delete from otp_codes where phone like '+79' || $1 || '%'", [RUN])
    }
    await app?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`

  /** Прогрев пула (§2.1): холодный пул сериализует залп сам, гонка не видна. */
  async function warmPool() {
    await Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.2)')))
  }

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

  it('T1+T3: залп на один номер → 1×200+5×429 и одна строка; седьмой (последовательно) → 429; verify живого кода → 200', async () => {
    const phone = nextPhone()
    await warmPool()

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP }),
      ),
    )
    const statuses = results.map((r) => r.statusCode)
    expect(statuses.filter((s) => s === 200), JSON.stringify(statuses)).toHaveLength(1)
    expect(statuses.filter((s) => s === 429), JSON.stringify(statuses)).toHaveLength(5)
    for (const r of results) {
      if (r.statusCode === 429) {
        expect(r.headers['retry-after']).toBeDefined()
        expect(r.json().error.code).toBe('too_many_requests')
      }
    }

    const { rows: rowCount } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from otp_codes where phone = $1',
      [phone],
    )
    expect(rowCount[0]?.n, 'ровно одна живая строка кода на номер после залпа').toBe('1')

    // T3: последовательный седьмой запрос на тот же номер — тоже 429.
    const seventh = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(seventh.statusCode).toBe(429)
    expect(Number(seventh.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(seventh.headers['retry-after'])).toBeLessThanOrEqual(60)

    // Единственный живой код всё ещё проверяется штатно.
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(verify.statusCode, verify.body.slice(0, 200)).toBe(200)
    createdUserIds.push((verify.json() as { user: { id: string } }).user.id)
  })

  it('T2: замок держит номер, а не таблицу — шесть разных номеров с одного IP → 6×200, шесть строк', async () => {
    const phones = Array.from({ length: 6 }, () => nextPhone())
    await warmPool()

    const results = await Promise.all(
      phones.map((phone) => app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })),
    )
    expect(
      results.map((r) => r.statusCode),
      results.map((r) => r.body.slice(0, 120)).join(' | '),
    ).toEqual([200, 200, 200, 200, 200, 200])

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from otp_codes where phone = any($1::text[])',
      [phones],
    )
    expect(rows[0]?.n).toBe('6')
  })
})
