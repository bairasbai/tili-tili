import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'
import { announceDealEvents, remindExpiringHolds, weeklyDigest } from '../src/jobs/index.js'

/**
 * Регрессии аудита 2026-09-07, блок 4 (попутная находка на бэкенде).
 *
 * Фоновые задачи устроены одинаково: пометить строки как обработанные,
 * пройти по ним и разослать. Первый же сбой в цикле — стёртый между выборкой
 * и записью аккаунт, упавшая вставка уведомления — выбрасывал исключение из
 * задачи целиком, а помеченные строки после него не получали ничего и уже
 * никогда. Нашлось на общей базе: `weeklyDigest` падал на внешнем ключе
 * `digest_sent`, пока `eraseDeletedUsers` из соседнего теста стирал аккаунт.
 *
 * Сбой воспроизводится триггером в базе, а не подменой функции: задача
 * должна пережить настоящую ошибку Postgres, а не её имитацию (R-166 —
 * без опоры на соседей, каждый сценарий на своих пользователях).
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('блок 4: сбой одной строки не глушит фоновую задачу', () => {
  let app: FastifyInstance
  let counter = 0
  const RUN = String(randomInt(100_000, 1_000_000))
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
  })
  afterAll(async () => {
    await app?.close()
  })

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`

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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, userId: body.user.id, phone }
  }
  async function newWedding(token: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', date: '2027-11-06', city: { name: 'Казань', region: 'Татарстан' }, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }
  async function firstSlot(token: string, weddingId: string) {
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as { id: string }[]
    return slots[0]!.id
  }
  async function countTitled(userId: string, title: string): Promise<number> {
    const { rows } = await app.db!.query<{ n: number }>(
      'select count(*)::int as n from notifications where user_id = $1 and title = $2',
      [userId, title],
    )
    return rows[0]!.n
  }

  /** Настоящая ошибка Postgres посреди задачи: триггер выполняет `body` перед строкой. */
  async function withTrigger(table: string, event: 'insert' | 'update' | 'delete', body: string, fn: () => Promise<void>) {
    const name = `audit17_fault_${RUN}_${++counter}`
    await app.db!.query(
      `create function ${name}() returns trigger language plpgsql as $$
         begin ${body} return coalesce(new, old); end $$`,
    )
    await app.db!.query(`create trigger ${name} before ${event} on ${table} for each row execute function ${name}()`)
    try {
      await fn()
    } finally {
      await app.db!.query(`drop trigger if exists ${name} on ${table}`)
      await app.db!.query(`drop function if exists ${name}()`)
    }
  }

  it('дайджест недели: аккаунт, стёртый между выборкой и записью, не роняет рассылку остальным', async () => {
    const gone = await newUser()
    const goneWedding = await newWedding(gone.token)
    const alive = await newUser()
    const aliveWedding = await newWedding(alive.token)
    await app.db!.query('update tasks set due = current_date + 2, done_at = null where wedding_id = any($1)', [
      [goneWedding, aliveWedding],
    ])

    /* Гонка с `eraseDeletedUsers` в один шаг: аккаунт исчезает ровно перед
       записью его ключа недели — вставка падает на внешнем ключе. */
    await withTrigger(
      'digest_sent',
      'insert',
      `if new.user_id = '${gone.userId}' then delete from users where id = '${gone.userId}'; end if;`,
      async () => {
        await expect(weeklyDigest(app)).resolves.toBeGreaterThanOrEqual(1)
      },
    )
    expect(await countTitled(alive.userId, 'Задачи недели')).toBe(1)
    /* Упавшая вставка откатывается целиком — вместе с удалением из триггера:
       у сбойного ни ключа недели, ни уведомления, и повтор задачи его
       возьмёт заново. */
    expect(await countTitled(gone.userId, 'Задачи недели')).toBe(0)
    const { rows } = await app.db!.query('select 1 from digest_sent where user_id = $1', [gone.userId])
    expect(rows).toHaveLength(0)
  })

  it('события сделок: сбой на одном событии не оставляет следующие без уведомления', async () => {
    const a = await newUser()
    const aWedding = await newWedding(a.token)
    const b = await newUser()
    const bWedding = await newWedding(b.token)
    /* Два события, наше первое по времени — старше всего, что могло остаться
       в окне двух суток от других тестов: порядок обхода известен. */
    for (const [user, weddingId, hoursAgo] of [[a, aWedding, 47], [b, bWedding, 46]] as const) {
      const dealId = uuidv7()
      await app.db!.query(
        `insert into deals (id, wedding_id, slot_id, state, price, currency, external_name)
         values ($1,$2,$3,'booked',1000000,'RUB','Свой подрядчик')`,
        [dealId, weddingId, await firstSlot(user.token, weddingId)],
      )
      await app.db!.query(
        `insert into deal_events (id, deal_id, from_state, to_state, note, at)
         values ($1,$2,'negotiating','booked','аудит', now() - make_interval(hours => $3))`,
        [uuidv7(), dealId, hoursAgo],
      )
    }

    await withTrigger(
      'notifications',
      'insert',
      `if new.user_id = '${a.userId}' then raise exception 'fault injected by audit17'; end if;`,
      async () => {
        await expect(announceDealEvents(app)).resolves.toBeGreaterThanOrEqual(2)
      },
    )
    expect(await countTitled(b.userId, 'Дата забронирована')).toBe(1)
    expect(await countTitled(a.userId, 'Дата забронирована')).toBe(0)
  })

  it('напоминание об истечении брони: сбой на одной сделке не глушит остальные', async () => {
    const a = await newUser()
    const aWedding = await newWedding(a.token)
    const b = await newUser()
    const bWedding = await newWedding(b.token)
    for (const [user, weddingId] of [[a, aWedding], [b, bWedding]] as const) {
      await app.db!.query(
        `insert into deals (id, wedding_id, slot_id, state, price, currency, negotiating_until, external_name)
         values ($1,$2,$3,'negotiating',1000000,'RUB', now() + interval '6 hours', 'Кто-то')`,
        [uuidv7(), weddingId, await firstSlot(user.token, weddingId)],
      )
    }

    await withTrigger(
      'notifications',
      'insert',
      `if new.user_id = '${a.userId}' then raise exception 'fault injected by audit17'; end if;`,
      async () => {
        await expect(remindExpiringHolds(app)).resolves.toBeGreaterThanOrEqual(2)
      },
    )
    expect(await countTitled(b.userId, 'Бронь скоро истечёт')).toBe(1)
    expect(await countTitled(a.userId, 'Бронь скоро истечёт')).toBe(0)
  })
})
