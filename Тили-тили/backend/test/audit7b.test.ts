import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'
import { notify } from '../src/notify/notify.js'
import { announceOpenedDayChats, cleanup, remindExpiringHolds, weeklyDigest } from '../src/jobs/index.js'

/**
 * Второй проход по этапу 7 — по РАЗДЕЛУ 5 плана, а не по составу этапа.
 *
 * «Здесь же — вся очередь BullMQ из раздела 5» одной строкой прячет девять
 * задач. Три из них были сделаны, три названы заблокированными зря: они
 * шлют уведомление в приложении, а не письмо или SMS.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('второй проход по этапу 7', () => {
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
    return { token, userId: rows[0]!.id }
  }

  async function newWedding(date = '2027-06-14') {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  const notificationsOf = async (userId: string) =>
    (
      await app.db!.query<{ title: string; deliver_after: Date; kind: string }>(
        'select title, deliver_after, kind from notifications where user_id = $1 order by created_at',
        [userId],
      )
    ).rows

  /* ── день X снимает тишину и лимит ────────────────────────────────── */
  it('в день свадьбы уведомления не ждут утра и не считают лимит', async () => {
    const w = await newWedding()
    /* Свадьба сегодня — по её собственному поясу, как считает `notify()`
     * (`wedding_today`). Не `current_date`: он в поясе сессии базы (в CI — UTC),
     * а с 21:00 до 24:00 UTC в Москве уже завтра — тест краснел по часам (ERR-0310). */
    await app.db!.query(
      `update weddings set date = (now() at time zone coalesce(tz, 'Europe/Moscow'))::date where id = $1`,
      [w.weddingId],
    )
    // Ночь: 23:00 по Москве — обычно это «отложить до 09:00».
    const night = new Date()
    night.setUTCHours(20, 0, 0, 0)

    for (let i = 0; i < 6; i++) {
      await notify(app.db!, { userId: w.userId, kind: 'chat', title: `Весть ${i}`, body: 'текст' }, night)
    }

    const rows = await notificationsOf(w.userId)
    expect(rows).toHaveLength(6)
    // В день X «разбудим утром» означает «уже неважно»: свадьба идёт сейчас.
    // И лимита три-в-сутки в этот день тоже нет (План §18.6).
    const deferred = rows.filter((r) => r.deliver_after.getTime() > night.getTime() + 60_000)
    expect(deferred).toHaveLength(0)
  })

  it('не в день свадьбы ограничения на месте', async () => {
    const w = await newWedding()
    const night = new Date()
    night.setUTCHours(20, 0, 0, 0)
    await notify(app.db!, { userId: w.userId, kind: 'chat', title: 'Ночная весть', body: 'текст' }, night)

    const rows = await notificationsOf(w.userId)
    expect(rows[0]!.deliver_after.getTime()).toBeGreaterThan(night.getTime())
  })

  /* ── открытие чата дня X зовёт людей ──────────────────────────────── */
  it('об открытии чата дня X сообщают, и ровно один раз', async () => {
    const w = await newWedding()
    const { rows: chats } = await app.db!.query<{ id: string }>(
      "select id from chats where wedding_id = $1 and kind = 'day'",
      [w.weddingId],
    )
    await app.db!.query("update chats set opens_at = now() - interval '1 minute' where id = $1", [chats[0]!.id])

    // Ленивая проверка `opens_at <= now()` чат открывает, но никого не зовёт:
    // человек узнал бы, только если сам заглянет.
    expect(await announceOpenedDayChats(app)).toBeGreaterThanOrEqual(1)
    const first = (await notificationsOf(w.userId)).filter((n) => n.title === 'Чат дня X открыт')
    expect(first).toHaveLength(1)

    // Задача ежечасная: без отметки она звала бы в чат каждый час.
    await announceOpenedDayChats(app)
    const second = (await notificationsOf(w.userId)).filter((n) => n.title === 'Чат дня X открыт')
    expect(second).toHaveLength(1)
  })

  /* ── напоминание о брони ──────────────────────────────────────────── */
  it('за 12 часов до конца брони приходит напоминание, и только одно', async () => {
    const w = await newWedding()
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string }[]
    await app.db!.query(
      `insert into deals (id, wedding_id, slot_id, state, price, currency, negotiating_until, external_name)
       values ($1,$2,$3,'negotiating',1000000,'RUB', now() + interval '6 hours', 'Кто-то')`,
      [uuidv7(), w.weddingId, slots[0]!.id],
    )

    expect(await remindExpiringHolds(app)).toBeGreaterThanOrEqual(1)
    const first = (await notificationsOf(w.userId)).filter((n) => n.title === 'Бронь скоро истечёт')
    expect(first).toHaveLength(1)
    // Дата и деньги: напоминание идёт мимо тихих часов.
    expect(first[0]!.kind).toBe('deal')

    await remindExpiringHolds(app)
    expect((await notificationsOf(w.userId)).filter((n) => n.title === 'Бронь скоро истечёт')).toHaveLength(1)
  })

  it('бронь, до конца которой ещё сутки, не тревожит', async () => {
    const w = await newWedding()
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })
    ).json() as { id: string }[]
    await app.db!.query(
      `insert into deals (id, wedding_id, slot_id, state, price, currency, negotiating_until, external_name)
       values ($1,$2,$3,'negotiating',1000000,'RUB', now() + interval '48 hours', 'Не скоро')`,
      [uuidv7(), w.weddingId, slots[0]!.id],
    )
    await remindExpiringHolds(app)
    expect((await notificationsOf(w.userId)).filter((n) => n.title === 'Бронь скоро истечёт')).toHaveLength(0)
  })

  /* ── дайджест ─────────────────────────────────────────────────────── */
  it('дайджест приходит один на неделю, а не по одному на задачу', async () => {
    const w = await newWedding()
    await app.db!.query(
      "update tasks set due = current_date + 2, done_at = null where wedding_id = $1",
      [w.weddingId],
    )

    expect(await weeklyDigest(app)).toBeGreaterThanOrEqual(1)
    const first = (await notificationsOf(w.userId)).filter((n) => n.title === 'Задачи недели')
    // Десять писем про десять дел человек не читает — он их выключает.
    expect(first).toHaveLength(1)

    // Повтор задачи на той же неделе пуст: ключ по номеру недели.
    await weeklyDigest(app)
    expect((await notificationsOf(w.userId)).filter((n) => n.title === 'Задачи недели')).toHaveLength(1)
  })

  /* ── уведомления не копятся вечно ─────────────────────────────────── */
  it('прочитанные уведомления старше 90 дней убираются, непрочитанные — нет', async () => {
    const user = await newUser()
    const old = uuidv7()
    const unread = uuidv7()
    await app.db!.query(
      `insert into notifications (id, user_id, kind, title, body, read_at, created_at)
       values ($1,$2,'system','Старое','текст', now() - interval '100 days', now() - interval '100 days')`,
      [old, user.userId],
    )
    await app.db!.query(
      `insert into notifications (id, user_id, kind, title, body, created_at)
       values ($1,$2,'system','Непрочитанное','текст', now() - interval '200 days')`,
      [unread, user.userId],
    )

    // Счётчик не утверждаем: уборку на общей базе мог сделать соседний прогон (R-177). Ниже — состояние базы.
    const removed = await cleanup(app)
    expect(removed.notifications).toBeTypeOf('number')

    const { rows } = await app.db!.query<{ id: string }>('select id from notifications where id = any($1)', [
      [old, unread],
    ])
    // Непрочитанное человек ещё не видел — выбрасывать его нельзя,
    // сколько бы оно ни лежало.
    expect(rows.map((r) => r.id)).toEqual([unread])
  })
})
