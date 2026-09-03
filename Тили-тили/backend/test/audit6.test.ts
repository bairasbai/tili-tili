import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { CONTRACT_OPERATIONS } from '../src/contract/paths.generated.js'

/**
 * Перепроверка этапа 6: проход по ОПИСАНИЮ, а не по критериям «Готово, когда»
 * (R-56). Вопросы задаются к тому, что происходит ПОСЛЕ обычного пути:
 * гостя удалили, свадьбу отменили, взносов стало много, экран мока просит
 * поле, которого в контракте нет.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe('состав этапа 6 — без базы', () => {
  it('все девять путей подарков объявлены в контракте', () => {
    const paths = new Set(CONTRACT_OPERATIONS.map((p) => p.openapi))
    for (const p of [
      '/weddings/{weddingId}/wishlist',
      '/weddings/{weddingId}/wishlist/{giftId}',
      '/weddings/{weddingId}/anti-gifts',
      '/weddings/{weddingId}/funds',
      '/weddings/{weddingId}/funds/{fundId}',
      '/gifts/{guestToken}',
      '/gifts/{guestToken}/{giftId}/reserve',
      '/gifts/{guestToken}/{giftId}/fund',
      '/gifts/{guestToken}/funds/{fundId}',
    ]) {
      expect(paths).toContain(p)
    }
  })

  it('маркетплейс и выплата фондов не обещаны — они вне MVP', () => {
    // Заглушка, которая притворяется работающей, хуже отсутствия пути:
    // «Купить в приложении» без платежей списало бы деньги в никуда.
    const suspicious = CONTRACT_OPERATIONS.filter((p) => /buy|purchase|payout|withdraw/i.test(p.openapi))
    expect(suspicious).toEqual([])
  })
})

describe.skipIf(!live)('перепроверка этапа 6', () => {
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
  const key = () => ({ 'idempotency-key': randomUUID() })
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
        date: '2027-09-11',
        city: { name: 'Пермь', region: 'Пермский край' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    return { token, weddingId: w.json().id as string }
  }

  async function newGuest(w: { token: string; weddingId: string }, name = 'Ольга') {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name },
    })
    const guestId = created.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    return { guestId, token: exchanged.json().guestToken as string }
  }

  async function newGift(w: { token: string; weddingId: string }, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/wishlist`,
      headers: auth(w.token),
      payload,
    })
    expect(res.statusCode).toBe(201)
    return res.json() as { id: string; icon?: string | null }
  }

  const wishlist = (w: { token: string; weddingId: string }) =>
    app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/wishlist`, headers: auth(w.token) })

  /* ── пустое тело у POST без тела ──────────────────────────────────── */
  it('POST без тела не отвергается из-за заголовка content-type', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Пётр' },
    })

    // Контракт объявляет этот путь без requestBody, а клиент, который ставит
    // content-type на все запросы подряд (обычная настройка fetch-обёртки),
    // получал 400 FST_ERR_CTP_EMPTY_JSON_BODY — отказ за то, чего мы
    // не просили. Нашлось живым HTTP-прогоном: inject заголовок сам
    // не подставляет и потому молчал.
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${created.json().id}/invite-link`,
      headers: { ...auth(w.token), 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)

    // Битое тело по-прежнему отказ — но в нашем формате, а не внутренним
    // кодом Fastify.
    const broken = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: { ...auth(w.token), 'content-type': 'application/json' },
      payload: '{не json',
    })
    expect(broken.statusCode).toBe(422)
    expect(broken.json().error.code).toBe('invalid_json')
  })

  /* ── подмена гостя парой ──────────────────────────────────────────── */
  it('пара не читает резервы гостя, перевыпустив его ссылку', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Тостер', price: rub(700_000) })
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Тихон' },
    })
    const guestId = created.json().id as string
    const issue = async () => {
      const link = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
        headers: auth(w.token),
      })
      const code = (link.json().url as string).split('/').pop()!
      const opened = await app.inject({ method: 'GET', url: `/invite/${code}` })
      return opened.json().guestToken as string
    }

    const guestToken = await issue()
    await app.inject({ method: 'POST', url: `/gifts/${guestToken}/${gift.id}/reserve`, headers: key() })

    // Ссылку выдаёт пара — значит, обменять её на токен она может и сама.
    // Раньше перевыпуск отдавал ТОТ ЖЕ токен: открыв гостевую страницу,
    // пара видела `mine: true` и узнавала дарителя, а гость об этом даже
    // не догадывался. Правило §9 держалось только на том, что так делать
    // не принято.
    const stolen = await issue()
    expect(stolen).not.toBe(guestToken)

    const asGuest = await app.inject({ method: 'GET', url: `/gifts/${stolen}` })
    const seen = (asGuest.json().gifts as { id: string; mine: boolean; reserved: boolean }[]).find(
      (g) => g.id === gift.id,
    )
    expect(seen?.mine).toBe(false)

    // Прежний токен мёртв — гость это заметит и попросит новую ссылку.
    expect((await app.inject({ method: 'GET', url: `/gifts/${guestToken}` })).statusCode).toBe(401)
    // А его резерв освободился: занятым мёртвой ссылкой подарок не остаётся.
    expect(seen?.reserved).toBe(false)
  })

  /* ── удалённый гость ──────────────────────────────────────────────── */
  it('удаление гостя освобождает его резерв', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Миксер', price: rub(800_000) })
    const guest = await newGuest(w, 'Аркадий')
    await app.inject({ method: 'POST', url: `/gifts/${guest.token}/${gift.id}/reserve`, headers: key() })

    const removed = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/guests/${guest.guestId}`,
      headers: auth(w.token),
    })
    expect(removed.statusCode).toBe(204)

    // Резерв держится на токене, а у токена нет внешнего ключа на гостя:
    // без уборки подарок остаётся «занят» человеком, которого больше нет,
    // и подарить его уже никто не сможет.
    const after = (await wishlist(w)).json().gifts as { id: string; reserved: boolean }[]
    expect(after.find((g) => g.id === gift.id)?.reserved).toBe(false)

    const other = await newGuest(w, 'Белла')
    const retry = await app.inject({
      method: 'POST',
      url: `/gifts/${other.token}/${gift.id}/reserve`,
      headers: key(),
    })
    expect(retry.statusCode).toBe(200)
  })

  /* ── поток взносов ────────────────────────────────────────────────── */
  it('гость не может завалить фонд бесконечными взносами', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: 'На мебель', target: rub(100_000_000) },
    })
    const fundId = created.json().id as string
    const guest = await newGuest(w)

    // Ключ придумывает клиент, значит идемпотентность потоку не мешает:
    // взнос по рублю с новым ключом растит таблицу без предела (ERR-0042
    // про ровно это, только в альбоме).
    const codes: number[] = []
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/gifts/${guest.token}/funds/${fundId}`,
        headers: key(),
        payload: { amount: rub(100) },
      })
      codes.push(res.statusCode)
    }
    expect(codes).toContain(429)
  })

  /* ── значок подарка ───────────────────────────────────────────────── */
  it('значок подарка сохраняется — он есть и в §9, и на экране', async () => {
    const w = await newWedding()
    // Мок хранит у каждого подарка свой значок: 📺 у телевизора, ☕ у
    // кофемашины. Без поля весь вишлист превращается в одинаковые коробки.
    const gift = await newGift(w, { name: 'Кофемашина', price: rub(6_200_000), icon: '☕' })
    expect(gift.icon).toBe('☕')

    const listed = (await wishlist(w)).json().gifts as { id: string; icon: string | null }[]
    expect(listed.find((g) => g.id === gift.id)?.icon).toBe('☕')

    const fund = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: 'Медовый месяц', target: rub(20_000_000), icon: '🎈' },
    })
    expect(fund.json().icon).toBe('🎈')
  })

  /* ── отменённая свадьба ───────────────────────────────────────────── */
  it('после отмены свадьбы подарки гостю недоступны', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Утюг', price: rub(500_000) })
    const guest = await newGuest(w)
    expect((await app.inject({ method: 'GET', url: `/gifts/${guest.token}` })).statusCode).toBe(200)

    await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/cancel`, headers: auth(w.token) })
    expect((await app.inject({ method: 'GET', url: `/gifts/${guest.token}` })).statusCode).toBe(401)
    const late = await app.inject({
      method: 'POST',
      url: `/gifts/${guest.token}/${gift.id}/reserve`,
      headers: key(),
    })
    expect(late.statusCode).toBe(401)
  })

  /* ── гонка на последнем рубле ─────────────────────────────────────── */
  it('два одновременных взноса не переполняют складчину', async () => {
    const w = await newWedding()
    const gift = await newGift(w, { name: 'Пианино', price: rub(10_000_000), group: true })
    const a = await newGuest(w, 'Вадим')
    const b = await newGuest(w, 'Галина')
    const pay = (t: string, amount: number) =>
      app.inject({
        method: 'POST',
        url: `/gifts/${t}/${gift.id}/fund`,
        headers: key(),
        payload: { amount: rub(amount) },
      })
    await pay(a.token, 8_000_000)

    // Оба вносят по 2 млн на остаток в 2 млн. Пройти должен ровно один.
    const both = await Promise.all([pay(a.token, 2_000_000), pay(b.token, 2_000_000)])
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(both.filter((r) => r.statusCode === 409)).toHaveLength(1)

    const { rows } = await app.db!.query<{ funded: string }>('select funded::text as funded from gifts where id = $1', [
      gift.id,
    ])
    expect(Number(rows[0]!.funded)).toBe(10_000_000)
  })

  /* ── чужие деньги ─────────────────────────────────────────────────── */
  it('гость не вносит деньги в чужой фонд', async () => {
    const mine = await newWedding()
    const theirs = await newWedding()
    const fund = await app.inject({
      method: 'POST',
      url: `/weddings/${theirs.weddingId}/funds`,
      headers: auth(theirs.token),
      payload: { name: 'Чужой', target: rub(1_000_000) },
    })
    const guest = await newGuest(mine)
    const res = await app.inject({
      method: 'POST',
      url: `/gifts/${guest.token}/funds/${fund.json().id}`,
      headers: key(),
      payload: { amount: rub(100_000) },
    })
    expect(res.statusCode).toBe(404)
  })

  /* ── границы сумм ─────────────────────────────────────────────────── */
  it('нулевые и запредельные суммы не проходят', async () => {
    const w = await newWedding()
    const zero = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/wishlist`,
      headers: auth(w.token),
      payload: { name: 'Ничто', price: rub(0) },
    })
    expect(zero.statusCode).toBe(422)

    const huge = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/funds`,
      headers: auth(w.token),
      payload: { name: 'Бесконечность', target: rub(Number.MAX_SAFE_INTEGER + 10) },
    })
    expect(huge.statusCode).toBe(422)
  })

  /* ── помощник и деньги ────────────────────────────────────────────── */
  it('помощник не видит ни вишлист, ни фонды, ни анти-подарки', async () => {
    const w = await newWedding()
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
    const helper = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(helper),
      payload: { policyVersion: '2026-09-02' },
    })
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper) })

    for (const [method, tail, payload] of [
      ['GET', '/wishlist', undefined],
      ['POST', '/funds', { name: 'Свой', target: rub(100_000) }],
      ['PUT', '/anti-gifts', ['Ничего']],
    ] as const) {
      const res = await app.inject({
        method: method as 'GET',
        url: `/weddings/${w.weddingId}${tail}`,
        headers: auth(helper),
        ...(payload ? { payload } : {}),
      })
      expect({ tail, code: res.statusCode }).toEqual({ tail, code: 403 })
    }
  })
})
