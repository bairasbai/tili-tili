/*
 * Ревью 016, FL-10 — F-RL7-05 / ERR-0280 / R-280: `weddingContext`
 * (`src/tilly/context.ts`, блок «## Тайминг дня» :204-213 на e67ffcf)
 * печатал модели время каждого блока тайминга через `timeIn(e.starts_at,
 * tz)` без проверки на `null`. Для свадьбы без даты `timeline_events
 * .starts_at`/`.ends_at` заводятся `NULL` намеренно (`routes/weddings.ts
 * :294-306` — дата не выбрана, местное время блока посчитать не из чего;
 * не в границах этого лейна). `Intl.DateTimeFormat.prototype.format(null)`
 * не бросает исключение — `null` приводится к числу через `ToNumber` (0) и
 * печатается эпоха `1970-01-01T00:00:00Z` в поясе свадьбы: Тиль «узнаёт»,
 * что все шесть блоков `TIMELINE_TEMPLATE` начинаются в одно и то же
 * время, хотя дата свадьбы ещё не выбрана (findings\TR-1.md §7 FL-10).
 *
 * Фикс (TR-1, решённый механизм): построчно `starts_at === null` →
 * «(время не задано) <название>» вместо вызова `timeIn`; когда у свадьбы
 * нет даты — перед списком блоков вставляется «Тайминг без времени: дата
 * свадьбы ещё не выбрана»; `timeIn(null, …)` не вызывается никогда.
 * Датированная свадьба сохраняет настоящее время блоков (не регрессия).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'
import { weddingContext } from '../src/tilly/context.js'
import { TIMELINE_TEMPLATE } from '../src/wedding/templates.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('FL-10 / ERR-0280 / R-280: свадьба без даты — тайминг без выдуманного времени', () => {
  let app: FastifyInstance
  let counter = 0
  /*
   * Собственный несменяемый префикс лейна FL-10 (conductor ruling —
   * GATELOG.md, ARB-1.md §C4 data-safety rules): "491000", не производный
   * от вывода psql.exe, отличается от FL-01 (490100), FL-6 (490600), FL-9
   * (490900/490901), FL-18/p,q,r (491801/491802/491803).
   */
  const RUN = '491000'
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUserIds: string[] = []

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
    if (left > 0) throw new Error(`FL-10/audit49k: остались фикстуры префикса ${RUN}: ${left}`)
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

  async function login(phone: string) {
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    expect(v.statusCode, v.body.slice(0, 200)).toBe(200)
    return v.json() as { accessToken: string; user: { id: string } }
  }

  async function newUser() {
    const phone = nextPhone()
    const body = await login(phone)
    createdUserIds.push(body.user.id)
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  /** `date` не передаётся — свадьба без даты (схема `POST /weddings` не требует поле). */
  async function newWedding(date?: string) {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        ...(date ? { date } : {}),
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  it('свадьба без даты: ни одного блока с выдуманным временем — «время не задано» плюс шапка про отсутствие даты', async () => {
    const w = await newWedding()
    const ctx = await weddingContext(app.db!, w.weddingId)

    expect(ctx.text, 'ни одной строки с временем эпохи вида «0X:00 Название»').not.toMatch(/\b0\d:00 Сборы/)
    expect(ctx.text, 'шапка «тайминг без времени» на свадьбе без даты').toContain('Тайминг без времени: дата свадьбы ещё не выбрана')
    for (const e of TIMELINE_TEMPLATE) {
      expect(ctx.text, `блок «${e.name}» размечен как без времени, не как 05:00`).toContain(`- (время не задано) ${e.name}`)
    }
    // Ровно по одному «время не задано» на каждый блок шаблона — ничего не потеряно и не задвоено.
    expect(ctx.text.match(/время не задано/g)?.length).toBe(TIMELINE_TEMPLATE.length)
  })

  it('датированная свадьба: тайминг показывает настоящее время блоков — не регрессия', async () => {
    const w = await newWedding('2027-06-14')
    const ctx = await weddingContext(app.db!, w.weddingId)

    expect(ctx.text, 'у датированной свадьбы шапки «без времени» нет').not.toContain('Тайминг без времени')
    expect(ctx.text, 'у датированной свадьбы «время не задано» не появляется').not.toContain('время не задано')
    for (const e of TIMELINE_TEMPLATE) {
      expect(ctx.text, `блок «${e.name}» — настоящее время шаблона, не выдуманное`).toContain(`- ${e.startsAt}–${e.endsAt} ${e.name}`)
    }
  })
})
