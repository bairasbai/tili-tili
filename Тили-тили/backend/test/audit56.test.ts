import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { maskUrl } from '../src/redact.js'

/**
 * Третий проход по этапам 5 и 6. Вопросы задаются не к обработчику, а к тому,
 * что вокруг него: что попадает в лог, что обещает контракт на отказ, в каком
 * порядке идут проверки внутри одной транзакции.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('секреты в адресе не попадают в лог', () => {
  it('гостевой токен закрывается во всех гостевых путях', () => {
    // Токен стоит В АДРЕСЕ, а адрес пишется в лог каждого запроса. Лог
    // уезжает к хостеру и в сборщик ошибок: без маскировки это список
    // рабочих ключей от чужих страниц.
    expect(maskUrl('/gifts/AbCd-1234')).toBe('/gifts/***')
    expect(maskUrl('/gifts/AbCd-1234/g1/reserve')).toBe('/gifts/***/g1/reserve')
    expect(maskUrl('/rsvp/AbCd-1234')).toBe('/rsvp/***')
    expect(maskUrl('/join/AbCd-1234/shuttle')).toBe('/join/***/shuttle')
    expect(maskUrl('/invite/ABCD-EFGH')).toBe('/invite/***')
  })

  it('токен в строке запроса тоже закрывается', () => {
    expect(maskUrl('/weddings/w1/album?guestToken=AbCd-1234')).toBe('/weddings/w1/album?guestToken=***')
    expect(maskUrl('/weddings/w1/album?guestToken=AbCd&limit=5')).toBe('/weddings/w1/album?guestToken=***&limit=5')
  })

  it('обычные адреса не портятся', () => {
    expect(maskUrl('/weddings/w1/wishlist')).toBe('/weddings/w1/wishlist')
    expect(maskUrl('/health/ready')).toBe('/health/ready')
    expect(maskUrl('/gifts')).toBe('/gifts')
    expect(maskUrl('/catalog?city=1&limit=20')).toBe('/catalog?city=1&limit=20')
  })
})

describe.skipIf(!live)('третий проход по этапам 5 и 6', () => {
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
      contributionsMaxPerGuest: 3,
      albumMaxPerGuest: 2,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const rub = (amount: number) => ({ amount, currency: 'RUB' })

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

  async function newWedding() {
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
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-10-02',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    return { token, weddingId: w.json().id as string }
  }

  async function newGuest(w: { token: string; weddingId: string }, name = 'Ольга') {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name },
    })
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const opened = await app.inject({ method: 'GET', url: `/invite/${code}` })
    return { guestId: created.json().id as string, token: opened.json().guestToken as string }
  }

  async function addHelper(w: { token: string; weddingId: string }) {
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/invites`,
      headers: auth(w.token),
      payload: { role: 'helper', label: 'Катя' },
    })
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
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(token),
    })
    expect(accepted.statusCode).toBe(200)
    return token
  }

  /* ── удостоверение гостя выдаёт только пара ───────────────────────── */
  it('помощник ведёт список гостей, но ссылку-приглашение не выдаёт', async () => {
    const w = await newWedding()
    const helper = await addHelper(w)

    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(helper),
      payload: { name: 'Родион' },
    })
    // Список гостей — работа помощника, её никто не отнимал.
    expect(created.statusCode).toBe(201)
    const guestId = created.json().id as string

    expect(
      (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/guests`, headers: auth(helper) })).statusCode,
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/weddings/${w.weddingId}/guests/${guestId}`,
          headers: auth(helper),
          payload: { name: 'Родион Петрович' },
        })
      ).statusCode,
    ).toBe(200)

    // А ссылка — удостоверение: кто её выдаёт, тот может обменять её сам
    // и действовать от имени гостя. Для пары это неизбежно, для помощника
    // это лишние права (решение владельца 2026-09-03).
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(helper),
    })
    expect(link.statusCode).toBe(403)

    const byCouple = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    expect(byCouple.statusCode).toBe(200)
  })

  /* ── отказ по пределу — не «повторите позже» ───────────────────────── */
  it('исчерпанный предел взносов отвечает без Retry-After', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: 'На мебель', target: rub(100_000_000) },
    })
    const fundId = created.json().id as string
    const guest = await newGuest(w)
    const pay = (k: string) =>
      app.inject({
        method: 'POST',
        url: `/gifts/${guest.token}/funds/${fundId}`,
        headers: { 'idempotency-key': k },
        payload: { amount: rub(100_000) },
      })

    const keys = [randomUUID(), randomUUID(), randomUUID()]
    for (const k of keys) expect((await pay(k)).statusCode).toBe(200)

    const refused = await pay(randomUUID())
    expect(refused.statusCode).toBe(429)
    expect(refused.json().error.code).toBe('contribution_limit')
    // Контракт обещает Retry-After у TooManyRequests. Здесь предел
    // постоянный: заголовок означал бы «повторите позже», а повтор
    // не поможет никогда — поэтому ответ описан отдельным QuotaExceeded.
    expect(refused.headers['retry-after']).toBeUndefined()

    // Повтор УЖЕ ЗАСЧИТАННОГО взноса обязан вернуть свой ответ, а не отказ:
    // иначе идемпотентность перестаёт работать ровно на пределе, где
    // клиент как раз и повторяет запросы.
    const again = await pay(keys[2]!)
    expect(again.statusCode).toBe(200)
    expect(again.json().collected.amount).toBe(300_000)
  })

  it('исчерпанный предел альбома отвечает так же', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    const add = () =>
      app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/album?guestToken=${guest.token}`,
        payload: { fileUrl: 'https://cdn.tili-tili.ru/a.jpg', consent: true },
      })
    expect((await add()).statusCode).toBe(201)
    expect((await add()).statusCode).toBe(201)

    const refused = await add()
    expect(refused.statusCode).toBe(429)
    expect(refused.json().error.code).toBe('album_limit')
    expect(refused.headers['retry-after']).toBeUndefined()
  })

  it('временный отказ по-прежнему говорит, когда повторить', async () => {
    const phone = nextPhone()
    const first = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(first.statusCode).toBe(200)
    const soon = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(soon.statusCode).toBe(429)
    // Здесь повтор ПОМОЖЕТ — значит, клиенту нужно сказать когда.
    expect(Number(soon.headers['retry-after'])).toBeGreaterThan(0)
  })

  /* ── ключ на пределе ──────────────────────────────────────────────── */
  it('повтор взноса в подарок на пределе возвращает свой ответ', async () => {
    const w = await newWedding()
    const gift = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/wishlist`,
      headers: auth(w.token),
      payload: { name: 'Пианино', price: rub(9_000_000), group: true },
    })
    const giftId = gift.json().id as string
    const guest = await newGuest(w)
    const pay = (k: string) =>
      app.inject({
        method: 'POST',
        url: `/gifts/${guest.token}/${giftId}/fund`,
        headers: { 'idempotency-key': k },
        payload: { amount: rub(1_000_000) },
      })

    const last = randomUUID()
    expect((await pay(randomUUID())).statusCode).toBe(200)
    expect((await pay(randomUUID())).statusCode).toBe(200)
    expect((await pay(last)).statusCode).toBe(200)
    expect((await pay(randomUUID())).statusCode).toBe(429)

    const repeat = await pay(last)
    expect(repeat.statusCode).toBe(200)
    expect(repeat.json().funded.amount).toBe(3_000_000)
  })
})
