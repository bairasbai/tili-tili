/*
 * Ревью 016, FL-12 — F-RL7-03 / ERR-0282 / R-282: повторный `approve` живой
 * анкеты (`POST /admin/moderation/vendors/:vendorId`, src/routes/admin.ts)
 * слал подрядчику вторую новость «Анкета проверена» на то же самое решение.
 * Причина: `for update`-выборка перед решением (:288-291 на e67ffcf) не
 * читала `moderated_at`, и условие пропуска новости (:326) знало только про
 * `verify`+`wasVerified` — для `approve` оно было истинным всегда, сколько
 * бы раз подряд решение ни повторялось (findings\TR-1.md §7 FL-12).
 *
 * Фикс (TR-1, решённый механизм): `for update`-выборка получает
 * `moderated_at`; решение о новости получает второе условие —
 * `wasModerated` (поле было НЕ пустым ДО этой транзакции) — та же схема,
 * что уже работает для `verify`/`wasVerified` (ревью 015). Второй `approve`
 * подряд остаётся 200 и пишет решение в журнал аудита (R-122 не меняется),
 * но не шлёт вторую новость.
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

describe.skipIf(!live)('FL-12 / ERR-0282 / R-282: повторный approve живой анкеты — одна новость, не две', () => {
  let app: FastifyInstance
  let counter = 0
  /*
   * Собственный несменяемый префикс лейна FL-12 (conductor ruling —
   * GATELOG.md, ARB-1.md §C4 data-safety rules): "491200", не производный
   * от вывода psql.exe, отличается от FL-01 (490100), FL-6 (490600), FL-9
   * (490900/490901), FL-10 (491000), FL-18/p,q,r (491801/491802/491803).
   */
  const RUN = '491200'
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
    if (left > 0) throw new Error(`FL-12/audit49m: остались фикстуры префикса ${RUN}: ${left}`)
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
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  /** Права сотрудника ставятся руками в базе при найме — пути для этого нет и не будет. */
  async function newStaff() {
    const user = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    return user
  }

  /** Подрядчик с опубликованной анкетой — тем же путём, каким он приходит сам. */
  async function newVendor(name: string) {
    const user = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `${name} ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        about: 'Снимаю свадьбы',
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    const published = await app.inject({
      method: 'POST',
      url: '/vendor/profile/publish',
      headers: auth(user.token),
    })
    expect(published.statusCode, published.body.slice(0, 200)).toBe(200)
    return { ...user, vendorId: created.json().id as string }
  }

  const vendorRow = async (vendorId: string) =>
    (
      await app.db!.query<{ published_at: Date | null; moderated_at: Date | null }>(
        'select published_at, moderated_at from vendors where id = $1',
        [vendorId],
      )
    ).rows[0]!

  /** Уведомления одного человека — свежие сверху. */
  const notesOf = async (userId: string) =>
    (
      await app.db!.query<{ kind: string; title: string; body: string }>(
        'select kind, title, body from notifications where user_id = $1 order by created_at desc',
        [userId],
      )
    ).rows

  /** Сколько раз это решение легло в журнал аудита — новость может не уйти, запись уходит всегда. */
  const auditCount = async (vendorId: string, action: string) =>
    Number(
      (
        await app.db!.query<{ n: string }>(
          "select count(*)::text as n from audit_log where entity = 'vendor' and entity_id = $1 and action = $2",
          [vendorId, action],
        )
      ).rows[0]!.n,
    )

  const decideVendor = (token: string, vendorId: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/admin/moderation/vendors/${vendorId}`, headers: auth(token), payload })

  it('повторный approve живой анкеты: 200 дважды, «Анкета проверена» — одна новость, решение в журнале — дважды', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Одобряемая FL-12')

    const first = await decideVendor(staff.token, vendor.vendorId, { action: 'approve' })
    expect(first.statusCode, first.body.slice(0, 200)).toBe(200)

    const second = await decideVendor(staff.token, vendor.vendorId, { action: 'approve' })
    expect(second.statusCode, second.body.slice(0, 200)).toBe(200)

    const row = await vendorRow(vendor.vendorId)
    expect(row.published_at, 'анкета остаётся в каталоге').not.toBeNull()
    expect(row.moderated_at, 'решение отмечено').not.toBeNull()

    // F-RL7-03: до фикса здесь оказывалось 2 — второе «Анкета проверена»
    // на то же самое решение читалось бы подрядчиком как сбой.
    const approved = (await notesOf(vendor.userId)).filter((n) => n.title === 'Анкета проверена')
    expect(approved, 'вторая новость про то же решение не рождается').toHaveLength(1)

    // Unhappy path (TR-1 §7 FL-12): решение журналируется каждый раз, даже
    // когда новости про него нет.
    expect(await auditCount(vendor.vendorId, 'vendor.approve'), 'оба решения остались в audit_log').toBe(2)
  })

  it('повторный reject снятой анкеты остаётся 409 — правка approve не трогает reject', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Снимаемая FL-12')
    const reason = `Не то фото ${RUN}`

    const first = await decideVendor(staff.token, vendor.vendorId, { action: 'reject', reason })
    expect(first.statusCode, first.body.slice(0, 200)).toBe(200)

    const again = await decideVendor(staff.token, vendor.vendorId, { action: 'reject', reason })
    expect(again.statusCode, again.body.slice(0, 200)).toBe(409)
    expect(again.json().error.code).toBe('vendor_not_live')

    const notes = (await notesOf(vendor.userId)).filter((n) => n.title === 'Анкета снята с публикации')
    expect(notes, 'снятие с публикации тоже не задваивает новость (не регрессия)').toHaveLength(1)
  })
})
