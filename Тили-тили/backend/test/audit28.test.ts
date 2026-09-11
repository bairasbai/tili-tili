import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import * as Sentry from '@sentry/node'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { uuidv7 } from '../src/ids.js'
import { createDb } from '../src/plugins/db.js'
import * as ratelimit from '../src/plugins/ratelimit.js'
import { notify, notifyWedding } from '../src/notify/notify.js'
import { announceDealEvents, eraseDeletedUsers, rsvpDigest } from '../src/jobs/index.js'

/* Подменяется весь модуль: в ESM пространство имён неизменяемо, и шпионить
 * за отдельным экспортом нельзя. Нужен ради `reportJobFailure` (D4-12). */
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  flush: vi.fn(async () => true),
  captureException: vi.fn(() => 'id'),
  withScope: vi.fn((fn: (scope: { setTag: () => void }) => void) => fn({ setTag: () => undefined })),
}))

/**
 * Регрессии ревью старого кода 2026-09-11 — вход, профиль, команда, экспорт,
 * приглашения, уведомления, фоновые задачи, каркас (D1/D2/D3/D4/D5/D6).
 *
 * Каждый тест здесь был красным на коде до фикса — цитаты в отчёте
 * `FIX-BE-A.md`. База общая с соседними наборами (R-177/R-226/R-227): состояние
 * утверждается по своим строкам и своим ключам, а не по счётчикам.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('D6-02: ключ ограничителя по токену — только по токену с верной подписью', () => {
  const fake = (authorization?: string) =>
    ({
      headers: authorization ? { authorization } : {},
      ip: '198.18.7.7',
      params: {},
      query: {},
    }) as unknown as FastifyRequest

  it('мусорные Bearer делят ключ адреса, подписанные токены получают свой', async () => {
    const bare = await ratelimit.rateLimitKey(fake(), SECRET_A)
    expect(bare).toBe('ip:198.18.7.7')
    /* До фикса ключом был sha256 от СЫРОГО заголовка: каждый случайный
     * Bearer — новый ключ, и лимит на адрес не срабатывал никогда. */
    expect(await ratelimit.rateLimitKey(fake(`Bearer ${'x'.repeat(40)}`), SECRET_A)).toBe(bare)
    expect(await ratelimit.rateLimitKey(fake(`Bearer ${'y'.repeat(40)}-${randomInt(1, 1_000_000)}`), SECRET_A)).toBe(bare)

    const one = await signAccessToken(SECRET_A, { sub: randomUUID(), sid: randomUUID() })
    const two = await signAccessToken(SECRET_A, { sub: randomUUID(), sid: randomUUID() })
    const keyOne = await ratelimit.rateLimitKey(fake(`Bearer ${one}`), SECRET_A)
    const keyTwo = await ratelimit.rateLimitKey(fake(`Bearer ${two}`), SECRET_A)
    expect(keyOne.startsWith('u:')).toBe(true)
    expect(keyOne).not.toBe(keyTwo)
    expect(keyOne).not.toBe(bare)
    // Тот же токен — тот же ключ: счёт идёт по человеку, а не по запросу.
    expect(await ratelimit.rateLimitKey(fake(`Bearer ${one}`), SECRET_A)).toBe(keyOne)

    // Подпись чужим секретом — тот же мусор, что случайная строка.
    const forged = await signAccessToken('z'.repeat(48), { sub: randomUUID(), sid: randomUUID() })
    expect(await ratelimit.rateLimitKey(fake(`Bearer ${forged}`), SECRET_A)).toBe(bare)
  })
})

describe.skipIf(!live)('ревью старого кода: вход, профиль, команда, уведомления, задачи, каркас', () => {
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
  const key = () => ({ 'idempotency-key': randomUUID() })
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const KAZAN = { name: 'Казань', region: 'Татарстан' }

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
  /** Повторный код на тот же номер раньше минуты не выдаётся — отматываем прежний. */
  async function pretendMinutePassed(phone: string) {
    await app.db!.query("update otp_codes set created_at = created_at - interval '2 minutes' where phone = $1", [phone])
  }
  async function signIn(phone: string, device?: string) {
    const otp = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(otp.statusCode).toBe(200)
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone), ...(device ? { device } : {}) },
    })
    expect(v.statusCode).toBe(200)
    return v.json() as { accessToken: string; refreshToken: string; user: { id: string } }
  }
  async function consent(token: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    expect(res.statusCode).toBe(201)
  }
  async function newUser() {
    const phone = nextPhone()
    const s = await signIn(phone)
    await consent(s.accessToken)
    return { token: s.accessToken, refresh: s.refreshToken, userId: s.user.id, phone }
  }
  async function newWedding(token: string, date = '2027-11-06', city = KAZAN) {
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', date, city, budgetTotal: { amount: 100_000_000, currency: 'RUB' } },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }
  async function invite(couple: { token: string }, weddingId: string, role: 'couple' | 'helper' | 'coordinator') {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role },
    })
    expect(res.statusCode).toBe(201)
    return res.json().code as string
  }
  async function join(couple: { token: string }, weddingId: string, role: 'couple' | 'helper' | 'coordinator') {
    const member = await newUser()
    const code = await invite(couple, weddingId, role)
    const accepted = await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(member.token) })
    expect(accepted.statusCode).toBe(200)
    return member
  }
  async function newVendor(categoryId: string) {
    const owner = await newUser()
    const profile = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `${categoryId} ${RUN}-${++counter}`, categoryId, city: KAZAN },
    })
    expect(profile.statusCode).toBe(200)
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    return { owner, vendorId: profile.json().id as string, name: profile.json().name as string }
  }
  async function firstSlot(token: string, weddingId: string, categoryId: string) {
    const slots = (
      await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })
    ).json() as { id: string; categoryId: string }[]
    return slots.find((s) => s.categoryId === categoryId)!.id
  }
  async function book(token: string, weddingId: string, categoryId: string, vendorId: string) {
    const slotId = await firstSlot(token, weddingId, categoryId)
    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slotId}/book`,
      headers: { ...auth(token), ...key() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(booked.statusCode).toBe(200)
    return { slotId, dealId: booked.json().deal.id as string }
  }
  /** Настоящая ошибка Postgres посреди задачи: триггер выполняет `body` перед строкой. */
  async function withTrigger(table: string, event: 'insert' | 'update' | 'delete', body: string, fn: () => Promise<void>) {
    const name = `audit28_fault_${RUN}_${++counter}`
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
  /**
   * Разбирает журнал сделок до СВОЕЙ сделки: задача берёт старейшие события
   * пачкой, а в общей базе их накопилось от соседних наборов.
   */
  async function drainDealEvents(dealId: string) {
    for (let pass = 0; pass < 50; pass++) {
      await announceDealEvents(app)
      const { rows } = await app.db!.query('select 1 from deal_events where deal_id = $1 and notified_at is null', [dealId])
      if (rows.length === 0) return
    }
    throw new Error('события сделки не разобраны за 50 проходов')
  }
  const linked = async (userId: string, link: string) =>
    (
      await app.db!.query<{ title: string; body: string }>(
        'select title, body from notifications where user_id = $1 and link = $2 order by created_at',
        [userId, link],
      )
    ).rows
  /**
   * Гонка требует тёплого пула: на холодном соединения открываются по
   * очереди, и параллельные запросы выстраиваются друг за другом — тогда
   * второй читает уже записанное первым, и дефекта «оба прочитали одно» не
   * видно. Десять параллельных запросов открывают все соединения пула.
   */
  const warmPool = () => Promise.all(Array.from({ length: 10 }, () => app.db!.query('select pg_sleep(0.05)')))
  const memberRole = async (weddingId: string, userId: string) =>
    (
      await app.db!.query<{ role: string }>('select role from wedding_members where wedding_id = $1 and user_id = $2', [
        weddingId,
        userId,
      ])
    ).rows[0]?.role ?? null

  /* ── вход и сессии ────────────────────────────────────────────────── */

  it('D1-01: выгнанное устройство со своим же текущим refresh получает 401, остальные сессии живы', async () => {
    const phone = nextPhone()
    const kicked = await signIn(phone, 'Старый телефон')
    await consent(kicked.accessToken)
    await pretendMinutePassed(phone)
    const keeper = await signIn(phone, 'Новый телефон')

    // «Выйти везде» с нового устройства: старое погашено.
    expect(
      (await app.inject({ method: 'DELETE', url: '/users/me/sessions', headers: auth(keeper.accessToken) })).statusCode,
    ).toBe(204)

    // Старое устройство штатно идёт обновлять пару своим текущим refresh.
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: kicked.refreshToken } })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')

    /* До фикса это считалось кражей и гасило ВСЕ сессии — включая ту,
     * с которой человек только что «выгнал постороннего». */
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: auth(keeper.accessToken) })).statusCode).toBe(200)
    const { rows } = await app.db!.query("select 1 from audit_log where actor_id = $1 and action = 'auth.refresh_reuse'", [
      kicked.user.id,
    ])
    expect(rows).toHaveLength(0)
  })

  it('D1-06: три одновременных refresh одним токеном — одна пара выдана, остальным refresh_superseded, ничего не погашено', async () => {
    const user = await newUser()
    await warmPool()
    const burst = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refresh } }),
      ),
    )
    const won = burst.filter((r) => r.statusCode === 200)
    // До фикса ротация шла `update … where id = $1` без условия на прежний хеш — обе вкладки получали по паре, и одна из них была не из базы.
    expect(won).toHaveLength(1)
    for (const lost of burst.filter((r) => r.statusCode !== 200)) {
      expect(lost.statusCode).toBe(401)
      expect(lost.json().error.code).toBe('refresh_superseded')
    }
    const { rows: alive } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from sessions where user_id = $1 and revoked_at is null',
      [user.userId],
    )
    expect(alive[0]!.n).toBe('1')
    // Выданная пара рабочая: следующий обмен проходит.
    const next = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: won[0]!.json().refreshToken as string },
    })
    expect(next.statusCode).toBe(200)
  })

  it('D1-07: восемь параллельных неверных кодов — только 401 и 429, без 500; попыток ровно пять', async () => {
    const phone = nextPhone()
    expect((await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })).statusCode).toBe(200)
    const right = await readCode(phone)
    const wrong = right === '0000' ? '0001' : '0000'
    await warmPool()
    const burst = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: wrong } }),
      ),
    )
    const codes = burst.map((r) => r.statusCode)
    // До фикса шестой инкремент упирался в CHECK attempts <= 5 → 500 и авария в логе.
    expect(codes).not.toContain(500)
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true)
    const { rows } = await app.db!.query<{ attempts: number }>(
      'select attempts from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    expect(rows[0]!.attempts).toBe(5)
  })

  it('D1-19: уже погашенную сессию не погасить второй раз — 404; свою — можно, так выходит приложение', async () => {
    const phone = nextPhone()
    const first = await signIn(phone, 'Телефон')
    await consent(first.accessToken)
    const mine = (
      (await app.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(first.accessToken) })).json() as {
        id: string
        current: boolean
      }[]
    ).find((s) => s.current)!.id
    /* Своя сессия гасится этим же путём — последним шагом выхода из приложения
       (ERR-0233): после неё токен мёртв на сервере, а не только стёрт на устройстве. */
    const self = await app.inject({ method: 'DELETE', url: `/users/me/sessions/${mine}`, headers: auth(first.accessToken) })
    expect(self.statusCode).toBe(204)
    expect(
      (await app.inject({ method: 'GET', url: '/users/me', headers: auth(first.accessToken) })).statusCode,
      'токен погашенной сессии обязан умереть',
    ).toBe(401)

    await pretendMinutePassed(phone)
    const second = await signIn(phone, 'Ноутбук')
    const other = (
      (await app.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(second.accessToken) })).json() as {
        id: string
        current: boolean
      }[]
    ).find((s) => s.current)!.id
    await pretendMinutePassed(phone)
    const third = await signIn(phone, 'Планшет')
    expect(
      (await app.inject({ method: 'DELETE', url: `/users/me/sessions/${other}`, headers: auth(third.accessToken) })).statusCode,
    ).toBe(204)
    // Повторное завершение уже погашенной — 404, а не 204 с перезаписью revoked_at.
    expect(
      (await app.inject({ method: 'DELETE', url: `/users/me/sessions/${other}`, headers: auth(third.accessToken) })).statusCode,
    ).toBe(404)
  })

  it('D6-05: refresh мягко удалённого аккаунта — 401', async () => {
    const phone = nextPhone()
    const s = await signIn(phone)
    await consent(s.accessToken)
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(s.accessToken) })).statusCode).toBe(204)
    /* Фича 005 (В2): вход в 30-дневном окне ВОССТАНАВЛИВАЕТ аккаунт, и refresh
     * после него — 200 (`audit34`). Здесь окно уже прошло: строка ждёт уборки,
     * вход по-прежнему выдаёт токены, и обмен обязан отвечать 401. */
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [s.user.id])
    await pretendMinutePassed(phone)
    const again = await signIn(phone)
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: again.refreshToken } })
    expect(res.statusCode).toBe(401)
  })

  /* ── профиль ──────────────────────────────────────────────────────── */

  it('D1-24: тихие часы «25:00» — 422 от схемы, а не 500 от приведения к time', async () => {
    const user = await newUser()
    const res = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(user.token),
      payload: { quietHours: { from: '25:00', to: '09:00' } },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
  })

  /* ── команда свадьбы ──────────────────────────────────────────────── */

  it('D1-09: понижение себя до helper при мягко удалённом партнёре — 409 last_couple', async () => {
    const owner = await newUser()
    const weddingId = await newWedding(owner.token)
    const partner = await join(owner, weddingId, 'couple')
    await app.db!.query('update users set deleted_at = now() where id = $1', [partner.userId])

    const res = await app.inject({
      method: 'PATCH',
      url: `/weddings/${weddingId}/members/${owner.userId}`,
      headers: auth(owner.token),
      payload: { role: 'helper' },
    })
    // До фикса «другой couple» считался без users.deleted_at — мёртвый партнёр сходил за живого.
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('last_couple')
    expect(await memberRole(weddingId, owner.userId)).toBe('couple')
  })

  it('D1-09: удаление себя из команды при мягко удалённом партнёре — 409 last_couple', async () => {
    const owner = await newUser()
    const weddingId = await newWedding(owner.token)
    const partner = await join(owner, weddingId, 'couple')
    await app.db!.query('update users set deleted_at = now() where id = $1', [partner.userId])

    const res = await app.inject({
      method: 'DELETE',
      url: `/weddings/${weddingId}/members/${owner.userId}`,
      headers: auth(owner.token),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('last_couple')
    expect(await memberRole(weddingId, owner.userId)).toBe('couple')
  })

  it('D1-10: мягко удалённый участник не отдаётся ни списком команды, ни в карточке свадьбы', async () => {
    const owner = await newUser()
    const weddingId = await newWedding(owner.token)
    const helper = await join(owner, weddingId, 'helper')
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(helper.token) })).statusCode).toBe(204)

    const list = (
      await app.inject({ method: 'GET', url: `/weddings/${weddingId}/members`, headers: auth(owner.token) })
    ).json() as { user: { id: string } }[]
    expect(list.map((m) => m.user.id)).not.toContain(helper.userId)
    const card = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}`, headers: auth(owner.token) })).json() as {
      members: { user: { id: string } }[]
    }
    expect(card.members.map((m) => m.user.id)).not.toContain(helper.userId)
    expect(card.members.map((m) => m.user.id)).toContain(owner.userId)
  })

  /* ── приглашения ──────────────────────────────────────────────────── */

  it('D1-13: помощник принимает ПАРА-ссылку — роль повышается, код гасится; пара по ссылке помощника — 409, код жив', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const helper = await join(couple, weddingId, 'helper')

    const up = await invite(couple, weddingId, 'couple')
    const accepted = await app.inject({ method: 'POST', url: `/invites/${up}/accept`, headers: auth(helper.token) })
    expect(accepted.statusCode).toBe(200)
    // До фикса `on conflict do nothing`: код сгорал, роль оставалась helper.
    expect(accepted.json().role).toBe('couple')
    expect(await memberRole(weddingId, helper.userId)).toBe('couple')
    expect((await app.inject({ method: 'GET', url: `/invites/${up}` })).statusCode).toBe(410)

    const down = await invite(couple, weddingId, 'helper')
    const refused = await app.inject({ method: 'POST', url: `/invites/${down}/accept`, headers: auth(couple.token) })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('already_member')
    expect(await memberRole(weddingId, couple.userId)).toBe('couple')
    // Код не погашен: ссылка ещё годится тому, кому её выдали.
    expect((await app.inject({ method: 'GET', url: `/invites/${down}` })).statusCode).toBe(200)
  })

  it('D1-26: приглашение отменённой свадьбы — 410 и на просмотр, и на приём', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const code = await invite(couple, weddingId, 'helper')
    const cancelled = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/cancel`,
      headers: { ...auth(couple.token), ...key() },
    })
    expect(cancelled.statusCode).toBe(200)

    expect((await app.inject({ method: 'GET', url: `/invites/${code}` })).statusCode).toBe(410)
    const other = await newUser()
    expect((await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(other.token) })).statusCode).toBe(410)
    expect(await memberRole(weddingId, other.userId)).toBeNull()
  })

  /* ── свадьба ──────────────────────────────────────────────────────── */

  it('D2-11: срок шаблонной задачи при создании — календарём базы: 31 мая минус 3 месяца это 28 февраля', async () => {
    const user = await newUser()
    const weddingId = await newWedding(user.token, '2027-05-31')
    const { rows } = await app.db!.query<{ due: string | null }>(
      "select due::text as due from tasks where wedding_id = $1 and period = '3' limit 1",
      [weddingId],
    )
    // До фикса JS-арифметика `setUTCMonth` давала «31 февраля» → 3 марта; перенос той же свадьбы даёт 28 февраля.
    expect(rows[0]!.due).toBe('2027-02-28')
  })

  it('D3-11: дресс-код и пожелание снимаются null, пропущенное поле не трогается', async () => {
    const user = await newUser()
    const weddingId = await newWedding(user.token)
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/weddings/${weddingId}`, headers: auth(user.token), payload })

    const set = await patch({ dressCode: 'd2', dressNote: 'Дамы — без белого' })
    expect(set.statusCode).toBe(200)
    expect(set.json().dressCode).toBe('d2')

    const cleared = await patch({ dressNote: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().dressNote).toBeNull()
    expect(cleared.json().dressCode).toBe('d2')

    const untouched = await patch({ venue: 'Усадьба' })
    expect(untouched.json().dressCode).toBe('d2')
    expect((await patch({ dressCode: null })).json().dressCode).toBeNull()
  })

  /* ── экспорт данных (152-ФЗ) ──────────────────────────────────────── */

  it('D1-02: экспорт помощника — без цен сделок, платежей, статей бюджета и сумм подарков', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const helper = await join(couple, weddingId, 'helper')
    const vendor = await newVendor('photo')
    const { slotId } = await book(couple.token, weddingId, 'photo', vendor.vendorId)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/weddings/${weddingId}/slots/${slotId}/pay`,
          headers: { ...auth(couple.token), ...key() },
          payload: { amount: { amount: 1_000_000, currency: 'RUB' } },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/weddings/${weddingId}/budget/items`,
          headers: auth(couple.token),
          payload: { title: 'Фейерверк', categoryId: 'b5', amount: { amount: 5_000_000, currency: 'RUB' } },
        })
      ).statusCode,
    ).toBe(201)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/weddings/${weddingId}/wishlist`,
          headers: auth(couple.token),
          payload: { name: 'Тостер', price: { amount: 500_000, currency: 'RUB' } },
        })
      ).statusCode,
    ).toBe(201)

    type Export = {
      deals: Record<string, unknown>[]
      payments: unknown[]
      budget: unknown[]
      gifts: Record<string, unknown>[]
    }
    const asHelper = (await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(helper.token) })).json() as Export
    const helperDeals = asHelper.deals.filter((d) => d['wedding_id'] === weddingId)
    expect(helperDeals.length).toBeGreaterThan(0)
    // До фикса помощник получал `price` каждой сделки, платежи, статьи и суммы подарков одним GET.
    expect(Object.keys(helperDeals[0]!)).not.toContain('price')
    expect(asHelper.payments).toEqual([])
    expect(asHelper.budget).toEqual([])
    for (const gift of asHelper.gifts) {
      expect(Object.keys(gift)).not.toContain('price')
      expect(Object.keys(gift)).not.toContain('funded')
    }

    const asCouple = (await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(couple.token) })).json() as Export
    expect(asCouple.deals.find((d) => d['wedding_id'] === weddingId)?.['price']).toBe('5000000')
    expect(asCouple.payments.length).toBeGreaterThan(0)
    expect(asCouple.budget.length).toBeGreaterThan(0)
    expect(asCouple.gifts.find((g) => g['name'] === 'Тостер')?.['price']).toBe('500000')
  })

  it('D1-11: экспорт содержит анкету целиком, верификацию, избранное, отметки, подписки, рефералы, приглашения, журнал сделок и архивную свадьбу', async () => {
    const user = await newUser()
    const weddingId = await newWedding(user.token)
    const inviteCode = await invite(user, weddingId, 'helper')
    const other = await newVendor('photo')
    expect((await app.inject({ method: 'PUT', url: `/me/favorites/${other.vendorId}`, headers: auth(user.token) })).statusCode).toBe(204)
    const { dealId } = await book(user.token, weddingId, 'photo', other.vendorId)
    expect((await app.inject({ method: 'PUT', url: `/inspiration/likes/story-${RUN}`, headers: auth(user.token) })).statusCode).toBe(204)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/complaints',
          headers: auth(user.token),
          payload: { targetKind: 'vendor', targetId: other.vendorId, category: 'spam', text: 'рассылка' },
        })
      ).statusCode,
    ).toBe(201)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/catalog/concierge',
          headers: auth(user.token),
          payload: { categoryId: 'photo', comment: 'нужен фотограф' },
        })
      ).statusCode,
    ).toBe(201)
    const referral = await app.inject({ method: 'GET', url: '/users/me/referral', headers: auth(user.token) })
    expect(referral.statusCode).toBe(200)
    const own = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `Декор ${RUN}-${++counter}`,
        categoryId: 'decor',
        city: KAZAN,
        phone: '+79990000001',
        packages: [{ name: 'Базовый', price: { amount: 1_000_000, currency: 'RUB' } }],
      },
    })
    expect(own.statusCode).toBe(200)
    const ownVendorId = own.json().id as string
    await app.db!.query(
      `insert into vendor_verifications (id, vendor_id, kind, inn, file_url, status) values ($1, $2, 'ip', '123456789012', 'https://s3.example/secret', 'pending')`,
      [uuidv7(), ownVendorId],
    )
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/vendor/calendar/busy',
          headers: auth(user.token),
          payload: { dates: ['2027-12-24'], status: 'busy' },
        })
      ).statusCode,
    ).toBe(204)
    const endpoint = `https://push.example/${RUN}-${++counter}`
    await app.db!.query(
      `insert into push_subscriptions (id, user_id, endpoint, keys) values ($1, $2, $3, '{"p256dh":"secret","auth":"secret"}')`,
      [uuidv7(), user.userId, endpoint],
    )
    // Свадьба уходит в архив — данные человека от этого чужими не становятся.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/weddings/${weddingId}/cancel`,
          headers: { ...auth(user.token), ...key() },
        })
      ).statusCode,
    ).toBe(200)

    const out = (await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(user.token) })).json() as Record<
      string,
      unknown
    >
    const rows = (name: string) => out[name] as Record<string, unknown>[]
    // До фикса ни одной из этих таблиц в выгрузке не было.
    expect(rows('vendorVerifications')).toHaveLength(1)
    expect(rows('vendorVerifications')[0]).toMatchObject({ kind: 'ip', status: 'pending', inn: '123456789012' })
    expect(Object.keys(rows('vendorVerifications')[0]!)).not.toContain('file_url')
    const profile = out['vendorProfile'] as Record<string, unknown>
    expect(profile['phone']).toBe('+79990000001')
    expect(profile['city']).toBe('Казань')
    expect(Object.keys(profile)).toContain('photo_url')
    expect(rows('vendorPackages').map((p) => p['name'])).toContain('Базовый')
    expect(Array.isArray(out['vendorMedia'])).toBe(true)
    expect(rows('vendorBusyDates')).toEqual([{ date: '2027-12-24' }])
    expect(rows('favorites').map((f) => f['vendor_id'])).toContain(other.vendorId)
    expect(rows('inspirationLikes').map((l) => l['story_id'])).toContain(`story-${RUN}`)
    expect(rows('pushSubscriptions')).toEqual([{ endpoint }])
    expect((out['referral'] as Record<string, unknown>)['code']).toBe(referral.json().code)
    expect(Array.isArray(out['referralUses'])).toBe(true)
    expect(rows('invites').map((i) => i['code'])).toContain(inviteCode)
    expect(rows('complaints').map((c) => c['text'])).toContain('рассылка')
    // Санкция на третье лицо и заметка модератора — не данные жалобщика (RF-BE-07).
    for (const c of rows('complaints')) {
      expect(c).not.toHaveProperty('resolution')
      expect(c).not.toHaveProperty('note')
    }
    expect(rows('conciergeRequests').map((c) => c['comment'])).toContain('нужен фотограф')
    expect(rows('dealEvents').some((e) => e['deal_id'] === dealId)).toBe(true)
    const archived = rows('weddings').find((w) => w['id'] === weddingId)
    expect(archived).toBeDefined()
    expect(archived!['archived_at']).not.toBeNull()
  })

  /* ── уведомления ──────────────────────────────────────────────────── */

  it('D1-05/D4-02: события сделки идут только паре и подрядчику — помощник и координатор не получают ничего', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const partner = await join(couple, weddingId, 'couple')
    const helper = await join(couple, weddingId, 'helper')
    const coordinator = await join(couple, weddingId, 'coordinator')
    const vendor = await newVendor('photo')
    const { dealId } = await book(couple.token, weddingId, 'photo', vendor.vendorId)
    const changed = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: { ...auth(couple.token), ...key() },
      payload: { price: { amount: 8_000_000, currency: 'RUB' } },
    })
    expect(changed.statusCode).toBe(200)
    await drainDealEvents(dealId)

    const link = `/deal/${dealId}`
    // До фикса помощник получал «Изменилась сумма сделки: 50 000 ₽ → 80 000 ₽» — деньги, которых ему не положено нигде (§6).
    expect(await linked(helper.userId, link)).toEqual([])
    expect(await linked(coordinator.userId, link)).toEqual([])
    const partnerTitles = (await linked(partner.userId, link)).map((r) => r.title)
    expect(partnerTitles).toContain('Дата забронирована')
    expect(partnerTitles).toContain('Изменилась сумма сделки')
    expect((await linked(vendor.owner.userId, link)).map((r) => r.title)).toContain('Изменилась сумма сделки')
  })

  it('D4-04: тихие часы считаются по поясу свадьбы, если у человека пояс не задан', async () => {
    const user = await newUser()
    const weddingId = await newWedding(user.token, '2027-11-06', { name: 'Владивосток', region: 'Приморский край' })
    // 02:00 по Владивостоку (+10) = 16:00 UTC накануне. По Москве это 19:00 — не тихие часы.
    const at = new Date('2026-10-05T16:00:00Z')
    const title = `Пояс свадьбы ${RUN}-${++counter}`
    await notifyWedding(app.db!, weddingId, null, { kind: 'task', title, body: 'проверка пояса' }, at)
    const { rows } = await app.db!.query<{ deliver_after: Date }>(
      'select deliver_after from notifications where user_id = $1 and title = $2',
      [user.userId, title],
    )
    // До фикса `users.tz` пуст → Москва → push уходил немедленно, в два ночи по местному.
    expect(rows[0]!.deliver_after.toISOString()).toBe('2026-10-05T23:00:00.000Z')
  })

  it('D4-16: 43-е некритичное уведомление за две недели помечается доставленным без push, а не откладывается на 14 суток', async () => {
    const user = await newUser()
    // 12:30 по Москве — не тихие часы, пояс у человека не задан.
    const at = new Date('2026-10-01T09:30:00Z')
    for (let i = 1; i <= 43; i++) {
      await notify(app.db!, { userId: user.userId, kind: 'task', title: `Переполнение ${i}`, body: 'x' }, at)
    }
    const { rows } = await app.db!.query<{ title: string; deliver_after: Date; pushed_at: Date | null }>(
      'select title, deliver_after, pushed_at from notifications where user_id = $1',
      [user.userId],
    )
    const last = rows.find((r) => r.title === 'Переполнение 43')!
    // До фикса: `pushed_at` пуст, `deliver_after` = +14 суток — push о двухнедельной новости.
    expect(last.pushed_at).not.toBeNull()
    expect(last.deliver_after.getTime()).toBeLessThan(at.getTime() + 13 * 86_400_000)
    expect(rows.find((r) => r.title === 'Переполнение 42')!.pushed_at).toBeNull()
  })

  /* ── фоновые задачи ───────────────────────────────────────────────── */

  it('D4-25: событие сделки старше двух суток помечается без рассылки', async () => {
    const user = await newUser()
    const weddingId = await newWedding(user.token)
    const dealId = uuidv7()
    await app.db!.query(
      `insert into deals (id, wedding_id, slot_id, state, price, currency, external_name)
       values ($1, $2, $3, 'booked', 1000000, 'RUB', 'Свой подрядчик')`,
      [dealId, weddingId, await firstSlot(user.token, weddingId, 'photo')],
    )
    const eventId = uuidv7()
    await app.db!.query(
      `insert into deal_events (id, deal_id, from_state, to_state, note, at)
       values ($1, $2, 'negotiating', 'booked', 'аудит28', now() - interval '3 days')`,
      [eventId, dealId],
    )
    await announceDealEvents(app)
    const { rows } = await app.db!.query<{ notified_at: Date | null }>('select notified_at from deal_events where id = $1', [eventId])
    // До фикса задача брала только окно двух суток, и старое событие висело в очереди навсегда.
    expect(rows[0]!.notified_at).not.toBeNull()
    expect(await linked(user.userId, `/deal/${dealId}`)).toEqual([])
  })

  it('D4-12: сбои внутри прохода фоновой задачи доходят до Sentry числом', async () => {
    vi.mocked(Sentry.captureException).mockClear()
    const user = await newUser()
    const weddingId = await newWedding(user.token)
    const guest = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests`,
      headers: auth(user.token),
      payload: { name: 'Аня' },
    })
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests/${guest.json().id as string}/invite-link`,
      headers: auth(user.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const guestToken = (await app.inject({ method: 'GET', url: `/invite/${code}` })).json().guestToken as string
    expect((await app.inject({ method: 'POST', url: `/rsvp/${guestToken}`, payload: { status: 'yes' } })).statusCode).toBe(200)

    await withTrigger(
      'notifications',
      'insert',
      `if new.user_id = '${user.userId}' then raise exception 'fault injected by audit28'; end if;`,
      async () => {
        await rsvpDigest(app)
      },
    )
    const sent = vi.mocked(Sentry.captureException).mock.calls.map((c) => c[0] as Error)
    // До фикса `isolated()` писал ошибку в лог и молчал: систематический сбой рассылки не доходил никуда.
    expect(sent.length).toBeGreaterThan(0)
    expect(sent[sent.length - 1]!.message).toMatch(/rsvp-digest/)
    expect(sent[sent.length - 1]!.message).toMatch(/\b1\b/)
  })

  it('D5-01/D6-04: пара-одиночка с отзывом по завершённой сделке стирается через 30 дней — отзыв уходит, дата подрядчика освобождается', async () => {
    const owner = await newUser()
    const weddingId = await newWedding(owner.token)
    const vendor = await newVendor('photo')
    const { dealId } = await book(owner.token, weddingId, 'photo', vendor.vendorId)
    await app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [dealId])
    const review = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(owner.token),
      payload: { rating: 5, text: 'Отлично отработали' },
    })
    expect(review.statusCode).toBe(201)
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(owner.token) })).statusCode).toBe(204)
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [owner.userId])

    for (let pass = 0; pass < 3; pass++) {
      await eraseDeletedUsers(app)
      const { rows } = await app.db!.query('select 1 from users where id = $1', [owner.userId])
      if (rows.length === 0) break
    }
    const { rows: users } = await app.db!.query('select 1 from users where id = $1', [owner.userId])
    /* До фикса: каскад `weddings → deals` обнулял `reviews.deal_id`, CHECK
     * `reviews_key_matches_source` откатывал транзакцию — аккаунт с телефоном
     * оставался в базе навсегда, каждый час с той же ошибкой в логе. */
    expect(users).toHaveLength(0)
    const { rows: busy } = await app.db!.query("select 1 from vendor_busy_dates where vendor_id = $1 and date = '2027-11-06'", [
      vendor.vendorId,
    ])
    expect(busy).toHaveLength(0)
    const { rows: v } = await app.db!.query<{ reviews_count: number }>('select reviews_count from vendors where id = $1', [
      vendor.vendorId,
    ])
    expect(v[0]!.reviews_count).toBe(0)
  })

  /* ── каркас ───────────────────────────────────────────────────────── */

  it('D6-01: обрыв простаивающего соединения пула пишется в лог и не роняет процесс', async () => {
    const log = { error: vi.fn() }
    const db = createDb(DB!, log as never)
    const { rows } = await db.query<{ pid: number }>('select pg_backend_pid() as pid')
    const uncaught = vi.fn()
    const saved = process.rawListeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    process.on('uncaughtException', uncaught)
    try {
      await app.db!.query('select pg_terminate_backend($1)', [rows[0]!.pid])
      const until = Date.now() + 5000
      while (Date.now() < until && uncaught.mock.calls.length === 0 && log.error.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } finally {
      process.removeListener('uncaughtException', uncaught)
      for (const listener of saved) process.on('uncaughtException', listener as (...args: unknown[]) => void)
      await db.close()
    }
    // До фикса у `pg.Pool` не было слушателя `error`: ошибка простаивающего клиента шла в uncaughtException.
    expect(uncaught).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalled()
  })

  it('D6-15: слишком большое тело и чужой тип содержимого — свои коды и русский текст, не FST_ERR_*', async () => {
    const big = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone: 'x'.repeat(1_100_000) } })
    expect(big.statusCode).toBe(413)
    expect(big.json().error.code).toBe('payload_too_large')
    expect(big.json().error.message).toMatch(/[а-яё]/i)

    /* Форма вместо JSON — обычная ошибка чужого клиента. Тип именно
     * `x-www-form-urlencoded`: для `text/plain` у Fastify есть встроенный
     * разборщик, и такое тело доходит до схемы (422), а не до 415. */
    const form = await app.inject({
      method: 'POST',
      url: '/auth/otp',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'phone=1',
    })
    expect(form.statusCode).toBe(415)
    expect(form.json().error.code).toBe('unsupported_media_type')
    expect(form.json().error.message).toMatch(/[а-яё]/i)
  })
})
