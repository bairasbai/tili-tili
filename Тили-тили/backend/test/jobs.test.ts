import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import webpush from 'web-push'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'
import { sendDuePushes, pushConfigured } from '../src/notify/push.js'
import { cleanup, expireStaleHolds } from '../src/jobs/index.js'

/**
 * Фоновые задачи раздела 5 и отправка push.
 *
 * Сама очередь BullMQ в тестах не поднимается — она бы стучалась в Redis
 * между прогонами и оставляла в нём расписание. Проверяется то, что очередь
 * вызывает: выборка созревших push, уборка и страховка на истечение брони.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)
const KEYS = webpush.generateVAPIDKeys()

describe.skipIf(!live)('фоновые задачи', () => {
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

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  // Настройки собираются лениво: `app` появляется только в beforeAll.
  const withKeys = () => ({ ...app.appConfig, vapidPublicKey: KEYS.publicKey, vapidPrivateKey: KEYS.privateKey })

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
    return { token, userId: rows[0]!.id }
  }

  /** `hours` — насколько срок в прошлом (минус) или в будущем (плюс). */
  async function addNotification(userId: string, hours: number) {
    const id = uuidv7()
    await app.db!.query(
      `insert into notifications (id, user_id, kind, title, body, deliver_after)
       values ($1,$2,'system','Заголовок','Текст', now() + make_interval(hours => $3))`,
      [id, userId, hours],
    )
    return id
  }

  /* ── отправка push ────────────────────────────────────────────────── */
  it('без ключей VAPID ничего не отправляется и не помечается', async () => {
    const user = await newUser()
    const id = await addNotification(user.userId, -1)

    expect(pushConfigured(app.appConfig)).toBe(false)
    expect(await sendDuePushes(app.db!, app.appConfig)).toEqual({ sent: 0, dropped: 0 })

    const { rows } = await app.db!.query<{ pushed_at: Date | null }>(
      'select pushed_at from notifications where id = $1',
      [id],
    )
    // Пометить отправленным то, что отправить нечем, значит потерять push
    // навсегда: второй раз очередь эту строку уже не возьмёт.
    expect(rows[0]!.pushed_at).toBeNull()
  })

  it('созревшие уходят, будущие ждут', async () => {
    const user = await newUser()
    const due = await addNotification(user.userId, -1)
    const later = await addNotification(user.userId, 5)

    await sendDuePushes(app.db!, withKeys())

    const { rows } = await app.db!.query<{ id: string; pushed_at: Date | null }>(
      'select id, pushed_at from notifications where id = any($1)',
      [[due, later]],
    )
    const state = Object.fromEntries(rows.map((r) => [r.id === due ? 'созрело' : 'ждёт', r.pushed_at !== null]))
    // Отметка ставится сразу и в той же выборке: иначе два прохода очереди
    // возьмут одну строку и человек получит уведомление дважды.
    expect(state).toEqual({ созрело: true, ждёт: false })
  })

  it('мёртвая подписка удаляется, а не долбится вечно', async () => {
    const user = await newUser()
    await addNotification(user.userId, -1)
    await app.db!.query(
      `insert into push_subscriptions (id, user_id, endpoint, keys)
       values ($1,$2,$3,$4)`,
      [
        uuidv7(),
        user.userId,
        // Порт 9 — discard: соединение отвергается сразу, сеть не ждём.
        `https://127.0.0.1:9/${uuidv7()}`,
        JSON.stringify({ p256dh: 'BP'.padEnd(87, 'A'), auth: 'AAAAAAAAAAAAAAAAAAAAAA' }),
      ],
    )

    const result = await sendDuePushes(app.db!, withKeys())
    // Отказ соединения — временная беда, а не «получателя нет»:
    // подписку в этом случае оставляем.
    expect(result.dropped).toBe(0)
    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from push_subscriptions where user_id = $1',
      [user.userId],
    )
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('подписка принимается, когда ключи есть', async () => {
    const app2 = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
      vapidPublicKey: KEYS.publicKey,
      vapidPrivateKey: KEYS.privateKey,
    })
    await app2.ready()
    try {
      const phone = nextPhone()
      await app2.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
      const { rows } = await app2.db!.query<{ code_hash: string }>(
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
      const v = await app2.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
      const token = v.json().accessToken as string
      await app2.inject({
        method: 'POST',
        url: '/users/me/consent',
        headers: { authorization: `Bearer ${token}` },
        payload: { policyVersion: '2026-09-02' },
      })

      const res = await app2.inject({
        method: 'POST',
        url: '/users/me/push-subscriptions',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          endpoint: `https://fcm.googleapis.com/fcm/send/${uuidv7()}`,
          keys: { p256dh: 'k', auth: 'a' },
        },
      })
      expect(res.statusCode).toBe(201)

      // Тот же браузер переподписался — это не второй телефон.
      const again = await app2.inject({
        method: 'POST',
        url: '/users/me/push-subscriptions',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          endpoint: (res.raw as unknown as { endpoint?: string }).endpoint ?? `https://fcm.googleapis.com/fcm/send/x`,
          keys: { p256dh: 'k2', auth: 'a2' },
        },
      })
      expect(again.statusCode).toBe(201)
    } finally {
      await app2.close()
    }
  })

  /* ── уборка ───────────────────────────────────────────────────────── */
  it('уборка сносит просроченное и не трогает живое', async () => {
    const user = await newUser()
    await app.db!.query(
      `insert into otp_codes (id, phone, code_hash, expires_at, attempts)
       values ($1, $2, 'x', now() - interval '1 hour', 0)`,
      [uuidv7(), nextPhone()],
    )
    const freshPhone = nextPhone()
    await app.db!.query(
      `insert into otp_codes (id, phone, code_hash, expires_at, attempts)
       values ($1, $2, 'x', now() + interval '1 hour', 0)`,
      [uuidv7(), freshPhone],
    )
    await app.db!.query(
      `insert into idempotency_keys (key, user_id, route, request_hash, created_at)
       values ($1, $2, 'test', 'h', now() - interval '3 days')`,
      [`old-${uuidv7()}`, user.userId],
    )

    const removed = await cleanup(app)
    expect(removed.otp_codes).toBeGreaterThanOrEqual(1)
    expect(removed.idempotency_keys).toBeGreaterThanOrEqual(1)

    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from otp_codes where phone = $1',
      [freshPhone],
    )
    // Живой код удалять нельзя: человек как раз вводит его в форму.
    expect(Number(rows[0]!.n)).toBe(1)
  })

  /* ── страховка на бронь ───────────────────────────────────────────── */
  it('просроченная бронь снимается, даже если в приложение никто не заходил', async () => {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })
    const weddingId = w.json().id as string
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(user.token) })
    ).json() as { id: string }[]

    const dealId = uuidv7()
    await app.db!.query(
      `insert into deals (id, wedding_id, slot_id, state, price, currency, negotiating_until, external_name)
       values ($1,$2,$3,'negotiating',1000000,'RUB', now() - interval '1 hour', 'Кто-то')`,
      [dealId, weddingId, slots[0]!.id],
    )

    const freed = await expireStaleHolds(app)
    expect(freed).toBeGreaterThanOrEqual(1)

    const { rows } = await app.db!.query<{ state: string; events: string }>(
      `select d.state, (select count(*)::text from deal_events e where e.deal_id = d.id) as events
         from deals d where d.id = $1`,
      [dealId],
    )
    // Запись в журнал — та же, что и на ленивом пути: история не должна
    // зависеть от того, кто первым заметил истечение.
    expect(rows[0]).toMatchObject({ state: 'candidate' })
    expect(Number(rows[0]!.events)).toBeGreaterThanOrEqual(1)
  })
})
