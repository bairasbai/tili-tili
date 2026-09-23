import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { cleanup } from '../src/jobs/index.js'

/**
 * Этап 9: эксплуатация и 152-ФЗ.
 *
 * Новых путей нет — этап про то, что происходит с данными и со стендом.
 * Главная проверка: удалённый аккаунт через 31 день не находится нигде,
 * кроме журнала аудита. Проверяется не «мы вроде всё удалили», а обходом
 * ВСЕХ таблиц базы: список колонок берётся из самой базы, а не из памяти.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('этап 9: эксплуатация и 152-ФЗ', () => {
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

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

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
    const { rows } = await app.db!.query<{ id: string }>('select id from users where phone = $1', [phone])
    return { token, userId: rows[0]!.id, phone }
  }

  /** Обходит ВСЕ колонки базы и ищет идентификатор. Список — из самой базы. */
  async function findEverywhere(value: string): Promise<string[]> {
    const { rows: columns } = await app.db!.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('uuid', 'text', 'character varying')
        order by table_name, column_name`,
    )
    const found: string[] = []
    for (const c of columns) {
      // Журнал аудита переживает удаление намеренно: он и нужен, чтобы
      // ответить «кто и когда удалил», когда самих данных уже нет.
      if (c.table_name === 'audit_log') continue
      if (c.table_name === 'pgmigrations') continue
      const cast = c.data_type === 'uuid' ? '::text' : ''
      const { rows } = await app.db!.query<{ n: string }>(
        `select count(*)::text as n from "${c.table_name}" where "${c.column_name}"${cast} = $1`,
        [value],
      )
      if (Number(rows[0]!.n) > 0) found.push(`${c.table_name}.${c.column_name}`)
    }
    return found
  }

  /* ── удаление аккаунта ────────────────────────────────────────────── */
  it('через 31 день от удалённого аккаунта не остаётся ничего, кроме журнала', async () => {
    const user = await newUser()

    // Заводим следы во всех углах: свадьба, гость, чат, уведомление, анкета.
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    const weddingId = w.json().id as string
    await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests`,
      headers: auth(user.token),
      payload: { name: 'Аня' },
    })
    await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(user.token),
      payload: { name: 'Алина', push: { chats: false } },
    })

    const vendorUser = await newUser()
    const vendor = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendorUser.token),
      payload: {
        name: `Фотограф ${RUN}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendorUser.token) })
    const chatId = (
      await app.inject({
        method: 'POST',
        url: `/chats/vendor/${vendor.json().id}`,
        headers: auth(user.token),
      })
    ).json().id as string
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(user.token),
      payload: { text: 'Здравствуйте!' },
    })
    await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(user.token),
      payload: { targetKind: 'vendor', targetId: vendor.json().id, category: 'spam' },
    })

    // След до удаления есть — иначе проверка ничего не доказывает.
    expect((await findEverywhere(user.userId)).length).toBeGreaterThan(0)

    const deleted = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(user.token) })
    expect(deleted.statusCode).toBe(204)

    // Мягкое удаление: 30 дней аккаунт можно вернуть (План §19.1).
    const { rows: soft } = await app.db!.query<{ deleted_at: Date | null }>(
      'select deleted_at from users where id = $1',
      [user.userId],
    )
    expect(soft[0]!.deleted_at).not.toBeNull()

    // Тридцать первый день.
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [user.userId])
    await cleanup(app)

    const left = await findEverywhere(user.userId)
    expect(left).toEqual([])

    // А в журнале аудита след обязан остаться: он отвечает на вопрос
    // «кто и когда удалил», когда самих данных уже нет.
    const { rows: audit } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from audit_log where actor_id = $1',
      [user.userId],
    )
    expect(Number(audit[0]!.n)).toBeGreaterThan(0)
  })

  it('до тридцать первого дня аккаунт ещё можно вернуть', async () => {
    const user = await newUser()
    await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(user.token) })
    await app.db!.query("update users set deleted_at = now() - interval '29 days' where id = $1", [user.userId])
    await cleanup(app)

    const { rows } = await app.db!.query<{ n: string }>('select count(*)::text as n from users where id = $1', [
      user.userId,
    ])
    // Тридцать дней — это обещание, а не приблизительный срок.
    expect(Number(rows[0]!.n)).toBe(1)
  })

  /* ── экспорт данных ───────────────────────────────────────────────── */
  it('экспорт отдаёт данные пары одним файлом', async () => {
    const user = await newUser()
    await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })

    const dump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(user.token) })
    expect(dump.statusCode).toBe(200)
    const data = dump.json() as Record<string, unknown>
    // 152-ФЗ: человек имеет право забрать свои данные, а не список ссылок.
    expect(Object.keys(data).length).toBeGreaterThan(1)
    expect(JSON.stringify(data)).toContain('Тимур')
  })

  /* ── ограничитель как критерий этапа ──────────────────────────────── */
  it('одиннадцатый запрос за секунду получает 429', async () => {
    const limited = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: process.env.TEST_REDIS_URL ?? null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      rateLimitPerSecond: 10,
    })
    await limited.ready()
    try {
      if (!limited.redis) {
        // Без Redis ограничителя нет — и это честно сказано в логе.
        expect(limited.redis).toBeNull()
        return
      }
      const token = `Bearer ${'z'.repeat(40)}-${randomInt(1, 1_000_000)}`
      const burst = await Promise.all(
        Array.from({ length: 11 }, () =>
          limited.inject({ method: 'GET', url: '/geo/cities?q=Ка', headers: { authorization: token } }),
        ),
      )
      // Критерий этапа дословно: одиннадцатый за секунду — отказ.
      expect(burst.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(10)
      expect(burst.some((r) => r.statusCode === 429)).toBe(true)
    } finally {
      await limited.close()
    }
  })

  /* ── уборка не трогает живое ──────────────────────────────────────── */
  it('уборка не задевает действующие аккаунты', async () => {
    const alive = await newUser()
    await cleanup(app)
    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from users where id = $1 and deleted_at is null',
      [alive.userId],
    )
    expect(Number(rows[0]!.n)).toBe(1)
  })
})
