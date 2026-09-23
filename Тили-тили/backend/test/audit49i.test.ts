/*
 * Ревью 016, FL-9 — F-RL-1-01 / ERR-0279 / R-279: `POST /users/me/consent`
 * писал `request.ip` в колонку `inet` без проверки (`routes/users.ts:110`).
 * При `TRUST_PROXY >= 1` заголовку `X-Forwarded-For` верят как есть — мусор
 * оттуда (не-IP строка) уходил прямо в параметр запроса и падал уже в
 * драйвере PostgreSQL: 500 `internal` сразу после платной SMS (TR-1 §7 FL-9,
 * `repro-consent-inet.out`). `/auth/otp` от того же класса ошибки уже
 * защищён `clientIp()` (ревью 015) — здесь тот же щит не стоял.
 *
 * T1 — подделанный `X-Forwarded-For: not-an-ip` → 201, `consents.ip is null`
 *      (не 500, как на HEAD).
 * T2 — контроль без заголовка → 201, `consents.ip` = адрес сокета.
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
const POLICY = '2026-09-02'

describe.skipIf(!live)('FL-9 / ERR-0279 / R-279: мусор в X-Forwarded-For не роняет POST /users/me/consent', () => {
  let app: FastifyInstance
  let counter = 0
  /*
   * Собственный несменяемый префикс лейна FL-9 / файла audit49i (conductor
   * ruling): "490900" — не пересекается с занятыми (FL-01 490100, FL-6
   * 490600, верификаторы 490690/490695, FL-18 491801-491803). Уборка ниже
   * трогает только строки с этим префиксом.
   */
  const RUN = '490900'
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUserIds: string[] = []

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: POLICY,
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
      // Без доверия к X-Forwarded-For мусор в заголовке не попал бы в
      // request.ip вообще — сценарий требует именно доверенного прокси.
      trustProxy: 1,
    })
    await app.ready()

    // Защитная предочистка (dry-run count сначала, delete — только если что-то нашлось).
    const { rows: stale } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from otp_codes where phone like '+79' || $1 || '%'",
      [RUN],
    )
    if (Number(stale[0]?.n ?? 0) > 0) {
      await app.db!.query("delete from otp_codes where phone like '+79' || $1 || '%'", [RUN])
    }
  })

  afterAll(async () => {
    // Уборка — только фикстуры этого файла: delete в порядке eraseUser для
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

  async function login() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(v.statusCode, v.body.slice(0, 200)).toBe(200)
    const body = v.json() as { accessToken: string; user: { id: string } }
    createdUserIds.push(body.user.id)
    return body
  }

  async function consentIp(userId: string): Promise<string | null> {
    const { rows } = await app.db!.query<{ ip: string | null }>(
      'select host(ip) as ip from consents where user_id = $1 order by given_at desc limit 1',
      [userId],
    )
    return rows[0]?.ip ?? null
  }

  it('T1: подделанный X-Forwarded-For — 201 и ip = null, а не 500 (красный на HEAD)', async () => {
    const u = await login()
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: { ...auth(u.accessToken), 'x-forwarded-for': 'not-an-ip' },
      payload: { policyVersion: POLICY },
    })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201)
    expect(await consentIp(u.user.id)).toBeNull()
  })

  it('T2: контроль без заголовка — 201 и ip = адрес сокета', async () => {
    const u = await login()
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(u.accessToken),
      payload: { policyVersion: POLICY },
      remoteAddress: IP,
    })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201)
    expect(await consentIp(u.user.id)).toBe(IP)
  })
})
