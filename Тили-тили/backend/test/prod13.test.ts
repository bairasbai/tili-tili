import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Резерв на непредвиденное и напоминание молчащим гостям.
 *
 * Обе вещи были в плане и отсутствовали в ответе сервера: строку «резерв 10%»
 * показать было нечем, а полсотни приглашений пара обходила руками.
 *
 * Главное в рассылке — кому она НЕ уходит. Новая ссылка гасит токен гостя, а
 * вместе с ним теряется всё, что гость выбрал: резерв подарка в том числе.
 * Поэтому тот, кто ссылку уже открыл, из массовой рассылки исключён.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: резерв бюджета и напоминания гостям', () => {
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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function newUser() {
    const phone = `+79${RUN}${String(counter++).padStart(3, '0')}`
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const { rows } = await app.db!.query<{ code_hash: string }>(
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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token }
  }

  async function newWedding(budget?: number) {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        ...(budget ? { budgetTotal: { amount: budget, currency: 'RUB' } } : {}),
      },
    })
    expect(res.statusCode).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  const addGuest = async (w: { token: string; weddingId: string }, name: string, phone?: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name, ...(phone ? { phone } : {}) },
    })
    expect(res.statusCode).toBe(201)
    return res.json().id as string
  }

  const inviteLink = async (w: { token: string; weddingId: string }, guestId: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    expect(res.statusCode).toBe(200)
    return (res.json().url as string).split('/').pop()!
  }

  /* ── резерв ───────────────────────────────────────────────────────── */
  it('резерв — 10% от общего бюджета, отдельной строкой', async () => {
    const w = await newWedding(150_000_000)
    const budget = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/budget`,
      headers: auth(w.token),
    })
    expect(budget.statusCode).toBe(200)
    const body = budget.json() as { total: { amount: number }; reserve: { amount: number }; categories: unknown[] }
    expect(body.total.amount).toBe(150_000_000)
    expect(body.reserve.amount).toBe(15_000_000)
    // Категории делят сто процентов между собой — резерв в них не входит.
    expect(body.categories).toHaveLength(5)
  })

  it('без бюджета резерв нулевой, а не выдуманный', async () => {
    const w = await newWedding()
    const body = (
      await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/budget`, headers: auth(w.token) })
    ).json() as { reserve: { amount: number } }
    expect(body.reserve.amount).toBe(0)
  })

  /* ── напоминания ──────────────────────────────────────────────────── */
  it('напоминание уходит молчащим с телефоном и невскрытой ссылкой', async () => {
    const w = await newWedding()
    const silent = await addGuest(w, 'Ольга', '+79001112233')
    await inviteLink(w, silent)
    await addGuest(w, 'Без телефона')

    const answered = await addGuest(w, 'Пётр', '+79004445566')
    const code = await inviteLink(w, answered)
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    const token = exchanged.json().guestToken as string
    await app.inject({ method: 'POST', url: `/rsvp/${token}`, payload: { status: 'yes' } })

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/remind`,
      headers: auth(w.token),
    })
    expect(res.statusCode).toBe(200)
    // Один молчун с телефоном, один без телефона; ответивший не в счёт. `failed` — отказы провайдера и предел рассылки (ревью 015).
    expect(res.json()).toEqual({ sent: 1, skippedNoPhone: 1, skippedLinkUsed: 0, failed: 0 })
  })

  it('гостю с уже открытой ссылкой массово не пишут — иначе он потеряет свой выбор', async () => {
    const w = await newWedding()
    const guest = await addGuest(w, 'Ольга', '+79001112233')
    const code = await inviteLink(w, guest)
    // Ссылку открыли, но RSVP не ответили: перевыпуск сменил бы токен и увёл
    // за собой резерв подарка (§9).
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode).toBe(200)

    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/remind`,
      headers: auth(w.token),
    })
    expect(res.json()).toEqual({ sent: 0, skippedNoPhone: 0, skippedLinkUsed: 1, failed: 0 })
  })

  it('вторая рассылка в те же сутки отклоняется', async () => {
    const w = await newWedding()
    const guest = await addGuest(w, 'Ольга', '+79001112233')
    await inviteLink(w, guest)

    const first = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/remind`,
      headers: auth(w.token),
    })
    expect(first.json().sent).toBe(1)

    const second = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/remind`,
      headers: auth(w.token),
    })
    expect(second.statusCode).toBe(429)
  })

  it('чужим гостям напомнить нельзя', async () => {
    const mine = await newWedding()
    const guest = await addGuest(mine, 'Ольга', '+79001112233')
    await inviteLink(mine, guest)

    const stranger = await newWedding()
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${mine.weddingId}/guests/remind`,
      headers: auth(stranger.token),
    })
    expect([403, 404]).toContain(res.statusCode)
  })
})
