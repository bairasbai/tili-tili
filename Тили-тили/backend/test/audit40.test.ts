/*
 * Фича 011 — радиус поиска в каталоге: `Vendor.distanceKm` и `radiusKm` по делу.
 *
 * Три анкеты одной категории: Уфа, Бирск (≈80 км от Уфы) и Стерлитамак
 * (≈123 км). Выдача «Уфа» без радиуса (умолчание 100) содержит Бирск с
 * расстоянием 75…85 и не содержит Стерлитамак; `radiusKm=0` — только Уфа с
 * нулём; 300 — все три с километрами; без `city` расстояния нет (null);
 * анкета (детали) — тоже null. Красный без фикса: поля `distanceKm` в ответе
 * не было — `undefined`, не число и не null.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

type Vendor = { id: string; name: string; city: string | null; distanceKm?: number | null }

describe.skipIf(!live)('фича 011: радиус поиска и расстояние до города анкеты', () => {
  let app: FastifyInstance
  let counter = 0
  const RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const CATEGORY = 'cake'
  const names = { ufa: `Торты Уфа ${RUN}`, birsk: `Торты Бирск ${RUN}`, sterl: `Торты Стерлитамак ${RUN}` }

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
    return { token: body.accessToken, userId: body.user.id }
  }

  /** Опубликованная анкета в городе справочника (с координатами у всех трёх). */
  async function vendorIn(name: string, city: string) {
    const owner = await newUser()
    const put = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name, categoryId: CATEGORY, city: { name: city, region: 'Башкортостан' }, priceFrom: { amount: 500_000, currency: 'RUB' } },
    })
    expect(put.statusCode, put.body.slice(0, 200)).toBe(200)
    const pub = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    expect(pub.statusCode, pub.body.slice(0, 200)).toBe(200)
    return put.json().id as string
  }

  let viewer: { token: string }
  let ids: { ufa: string; birsk: string; sterl: string }

  /** Вся выдача категории по запросу — страницами, пока есть курсор. */
  async function all(params: string): Promise<Vendor[]> {
    const items: Vendor[] = []
    let cursor: string | null = null
    for (let page = 0; page < 30; page++) {
      /* `q=RUN` — только свои три анкеты: в общей базе категории тысячи строк, и листать их все незачем. */
      const url = `/catalog/vendors?categoryId=${CATEGORY}&q=${RUN}&limit=100${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await app.inject({ method: 'GET', url, headers: auth(viewer.token) })
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200)
      const body = res.json() as { items: Vendor[]; nextCursor: string | null }
      items.push(...body.items)
      cursor = body.nextCursor
      if (!cursor) break
    }
    return items
  }
  const mine = (list: Vendor[]) => list.filter((v) => [ids.ufa, ids.birsk, ids.sterl].includes(v.id))
  const byId = (list: Vendor[], id: string) => list.find((v) => v.id === id)

  beforeAll(async () => {
    viewer = await newUser()
    ids = {
      ufa: await vendorIn(names.ufa, 'Уфа'),
      birsk: await vendorIn(names.birsk, 'Бирск'),
      sterl: await vendorIn(names.sterl, 'Стерлитамак'),
    }
  })

  it('«Уфа» без радиуса (умолчание 100): своя анкета с distanceKm 0, Бирск ≈ 80 км, Стерлитамака нет', async () => {
    const list = await all('&city=' + encodeURIComponent('Уфа'))
    const found = mine(list)
    expect(found.map((v) => v.id).sort()).toEqual([ids.ufa, ids.birsk].sort())
    expect(byId(found, ids.ufa)!.distanceKm, 'у анкеты своего города расстояние — ноль, а не пусто').toBe(0)
    const birsk = byId(found, ids.birsk)!.distanceKm
    expect(typeof birsk, 'distanceKm у соседнего города должен быть числом').toBe('number')
    expect(birsk).toBeGreaterThanOrEqual(75)
    expect(birsk).toBeLessThanOrEqual(85)
  })

  it('radiusKm=0 — только точное совпадение города; 300 — все три с километрами по возрастанию', async () => {
    const strict = mine(await all('&city=' + encodeURIComponent('Уфа') + '&radiusKm=0'))
    expect(strict.map((v) => v.id)).toEqual([ids.ufa])
    expect(strict[0]!.distanceKm).toBe(0)

    const wide = mine(await all('&city=' + encodeURIComponent('Уфа') + '&radiusKm=300'))
    expect(wide.map((v) => v.id).sort()).toEqual([ids.ufa, ids.birsk, ids.sterl].sort())
    const sterl = byId(wide, ids.sterl)!.distanceKm!
    expect(sterl).toBeGreaterThanOrEqual(115)
    expect(sterl).toBeLessThanOrEqual(130)
    expect(sterl).toBeGreaterThan(byId(wide, ids.birsk)!.distanceKm!)
  })

  it('без city расстояния нет (null у всех); у анкеты (детали) — null; из Бирска Уфа видна в 100 км, Стерлитамак — нет', async () => {
    const any = mine(await all(''))
    expect(any).toHaveLength(3)
    for (const v of any) expect(v.distanceKm, `без города у ${v.name} расстояние должно быть null`).toBeNull()

    const detail = await app.inject({ method: 'GET', url: `/catalog/vendors/${ids.birsk}`, headers: auth(viewer.token) })
    expect(detail.statusCode).toBe(200)
    expect((detail.json() as Vendor).distanceKm).toBeNull()

    const fromBirsk = mine(await all('&city=' + encodeURIComponent('Бирск')))
    expect(fromBirsk.map((v) => v.id).sort()).toEqual([ids.ufa, ids.birsk].sort())
    expect(byId(fromBirsk, ids.birsk)!.distanceKm).toBe(0)
  })
})
