import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { CONTRACT_FILE } from '../scripts/gen-contract.mjs'

const require = createRequire(import.meta.url)

/*
 * Схемы маршрутов Fastify снаружи не отдаёт (`findRoute` возвращает только
 * обработчик), а хук `onRoute` из теста не видит маршруты, зарегистрированные
 * до него. Поэтому перехватываем регистрацию в самом маршрутизаторе: у
 * find-my-way `on(method, path, opts, handler, store)`, и в `store` лежит
 * контекст маршрута вместе со схемой. Патч живёт в этом файле: vitest даёт
 * каждому файлу свой реестр модулей.
 */
interface RecordedRoute {
  method: string
  path: string
  store: { schema?: { body?: Record<string, unknown>; querystring?: Record<string, unknown> } }
}
const recorded: RecordedRoute[] = []
{
  const FMW = require('find-my-way') as { prototype: { on: (...args: unknown[]) => unknown } }
  const original = FMW.prototype.on
  FMW.prototype.on = function (this: unknown, ...args: unknown[]) {
    recorded.push({ method: args[0] as string, path: args[1] as string, store: args[4] as RecordedRoute['store'] })
    return original.apply(this, args)
  }
}

interface SchemaNode {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  readOnly?: boolean
  $ref?: string
  security?: unknown
}
interface ContractOp {
  security?: unknown[]
  requestBody?: { content?: { 'application/json'?: { schema?: SchemaNode } } }
  responses?: Record<string, unknown>
}

describe('контракт против обработчиков: тела, security, коды (блок 1 аудита)', () => {
  /*
   * Сверка путей есть с этапа 0 и ловит «пути нет». Она не ловила три вещи,
   * которые нашлись 2026-09-06 механическим проходом: обработчик принимал
   * поля, о которых контракт молчал (телефон гостя, RSVP+ в ответе гостя,
   * город у консьержа), отвечал кодами, которых контракт не объявлял
   * (пятнадцать 409/429/501), и шестнадцать гостевых путей числились
   * за входом, хотя работают по токену в адресе.
   */
  const yaml = require('js-yaml') as { load: (s: string) => { paths: Record<string, Record<string, ContractOp>>; components: { schemas: Record<string, SchemaNode> } } }
  const doc = yaml.load(fs.readFileSync(CONTRACT_FILE, 'utf8'))
  const deref = (node: SchemaNode | undefined): SchemaNode | undefined =>
    node?.$ref ? deref(doc.components.schemas[node.$ref.split('/').pop()!]) : node
  const toFastify = (p: string) => p.replace(/\{([^}]+)\}/g, ':$1')
  const ops: { method: string; url: string; openapi: string; op: ContractOp }[] = []
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      if (item[m]) ops.push({ method: m.toUpperCase(), url: toFastify(p), openapi: p, op: item[m]! })
    }
  }

  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp(TEST_CONFIG)
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('поля тела запроса у обработчика те же, что в контракте (readOnly не в счёт)', () => {
    /* Заглушка загрузки не разбирает тело — она отвечает 501 до хранилища. */
    const STUBS = new Set(['POST /media/upload-url'])
    const drift: string[] = []
    for (const o of ops) {
      const key = `${o.method} ${o.openapi}`
      if (STUBS.has(key)) continue
      const contractBody = deref(o.op.requestBody?.content?.['application/json']?.schema)
      const route = recorded.find((r) => r.method === o.method && r.path === o.url)
      const handlerBody = route?.store.schema?.body as SchemaNode | undefined
      if (!contractBody && !handlerBody) continue
      if (contractBody && !handlerBody) { drift.push(`${key}: у обработчика нет схемы тела`); continue }
      if (!contractBody && handlerBody) { drift.push(`${key}: контракт без тела, обработчик его ждёт`); continue }
      if (handlerBody!.$ref) continue
      const cAll = Object.keys(contractBody!.properties ?? {})
      const cWritable = Object.entries(contractBody!.properties ?? {})
        .filter(([, v]) => !deref(v)?.readOnly)
        .map(([k]) => k)
      const hProps = Object.keys(handlerBody!.properties ?? {})
      for (const p of hProps) if (!cAll.includes(p)) drift.push(`${key}: обработчик принимает «${p}», контракт о нём молчит`)
      for (const p of cWritable) if (!hProps.includes(p)) drift.push(`${key}: контракт объявляет «${p}», обработчик не принимает`)
      for (const r of contractBody!.required ?? []) {
        if (!(handlerBody!.required ?? []).includes(r)) drift.push(`${key}: контракт требует «${r}», обработчик — нет`)
      }
    }
    expect(drift).toEqual([])
  })

  it('security контракта совпадает с тем, что делает сервер без токена', async () => {
    const drift: string[] = []
    const fill = (url: string) => url.split('/').map((s) => (s.startsWith(':') ? '00000000-0000-4000-8000-000000000000' : s)).join('/')
    for (const o of ops) {
      const key = `${o.method} ${o.openapi}`
      const isPublic = Array.isArray(o.op.security) && o.op.security.length === 0
      const res = await app.inject({ method: o.method as 'GET', url: fill(o.url) })
      let code = ''
      try { code = (res.json() as { error?: { code?: string } }).error?.code ?? '' } catch { /* без тела */ }
      if (isPublic && res.statusCode === 401 && code !== 'unauthorized_guest') {
        /* Альбом — исключение по замыслу: он открыт гостю по токену И команде
           по Bearer; без обоих 401 честнее, чем 200 с пустотой. */
        if (key !== 'GET /weddings/{weddingId}/album') drift.push(`${key}: security: [], а без токена 401`)
      }
      /* За входом: 401, либо 422/400 от валидации, которая у Fastify идёт
         раньше preHandler, либо 426/501 у каналов и заглушек. Всё прочее —
         значит, обработчик добрался до дела без токена. */
      if (!isPublic && ![401, 422, 400, 426, 501].includes(res.statusCode)) drift.push(`${key}: за входом, а без токена ${res.statusCode} ${code}`)
    }
    expect(drift).toEqual([])
  })

  it('коды ответов, которые обработчик выдаёт сам, объявлены в контракте', () => {
    /* Проход по исходникам маршрутов: `conflict(`/`AppError(409` в куске
       файла между двумя объявлениями маршрутов относится к первому из них.
       Коды из общих помощников (reschedule, claimContribution, доступ к
       чатам) сюда не попадают — они сверены руками и записаны в аудите. */
    const known = new Map<string, Set<number>>()
    for (const f of fs.readdirSync(new URL('../src/routes/', import.meta.url))) {
      const src = fs.readFileSync(new URL(`../src/routes/${f}`, import.meta.url), 'utf8')
      const starts = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*\n?\s*'([^']+)'/g)].map((m) => ({
        key: `${m[1]!.toUpperCase()} ${m[2]!}`,
        idx: m.index!,
      }))
      starts.forEach((s, i) => {
        const text = src.slice(s.idx, starts[i + 1]?.idx ?? src.length)
        const codes = new Set<number>()
        for (const m of text.matchAll(/AppError\(\s*(\d{3})/g)) codes.add(Number(m[1]))
        if (/\bconflict\(/.test(text)) codes.add(409)
        if (/\bquotaExceeded\(|new TooManyRequests\(/.test(text)) codes.add(429)
        if (/\bgone\(/.test(text)) codes.add(410)
        known.set(s.key, codes)
      })
    }
    const drift: string[] = []
    for (const o of ops) {
      const codes = known.get(`${o.method} ${o.url}`)
      if (!codes) continue
      const declared = new Set(Object.keys(o.op.responses ?? {}).map(Number))
      for (const c of [409, 410, 423, 429, 501]) {
        if (codes.has(c) && !declared.has(c)) drift.push(`${o.method} ${o.openapi}: обработчик отвечает ${c}, контракт не объявляет`)
      }
    }
    expect(drift).toEqual([])
  })
})

/**
 * Регрессии аудита 2026-09-06, блок 1 (контракт против бэкенда).
 *
 * Каждый набор краснел до своего исправления — проверено снятием фикса.
 */
const TEST_CONFIG = { env: 'test' as const, databaseUrl: null, redisUrl: null, corsOrigins: [] }

describe('NUL-байт в запросе — 422, а не 500 (R-111)', () => {
  /*
   * PostgreSQL не принимает ` ` ни в одной текстовой колонке. До фикса
   * строка с ним доходила до базы, драйвер отвечал «invalid byte sequence»,
   * и любой гость одним адресом `/rsvp/a%00b` писал в лог аварию. Проверено
   * живым прогоном: 500 давали имя гостя, имя партнёра, поиск города,
   * поиск в каталоге и три гостевых токена в адресе.
   */
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp(TEST_CONFIG)
    await app.ready()
  })
  afterAll(async () => {
    await app.close()
  })

  it('в теле запроса', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone: '+7917 000001' } })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('invalid_character')
  })

  it('в строке запроса', async () => {
    const res = await app.inject({ method: 'GET', url: '/geo/cities?q=%D0%A3%D1%84%D0%B0%00' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('invalid_character')
  })

  it('в сегменте адреса (гостевой токен)', async () => {
    const res = await app.inject({ method: 'GET', url: '/rsvp/a%00b' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('invalid_character')
  })

  it('во вложенном объекте тела', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: { authorization: 'Bearer x' },
      payload: { partnerName: 'Тимур', city: { name: 'Уфа ', region: 'Башкортостан' } },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('invalid_character')
  })

  it('обычные строки проходят дальше хука', async () => {
    // Без базы гео отвечает 503 из обработчика — значит, хук его пропустил.
    const res = await app.inject({ method: 'GET', url: '/geo/cities?q=%D0%A3%D1%84%D0%B0' })
    expect(res.statusCode).not.toBe(422)
  })
})

/* ── живая база ─────────────────────────────────────────────────────── */

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('блок 1: телефон гостя и удаление аккаунта с живой сделкой', () => {
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
  const key = () => ({ 'idempotency-key': `k-${RUN}-${++counter}` })
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
    const token = v.json().accessToken as string
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(token), payload: { policyVersion: '2026-09-02' } })
    return { token, phone }
  }

  async function newWedding(token: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-11-06',
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }

  it('телефон гостя: принимается, возвращается, правится и стирается (контракт v0.24)', async () => {
    /* До фикса обработчик принимал `phone`, но контракт о нём не знал, ответ
     * его не отдавал, а PATCH не принимал: пара не могла ни увидеть, ни
     * поправить номер — и `POST …/guests/remind` был обречён на
     * «телефона нет» у каждого гостя. */
    const user = await newUser()
    const weddingId = await newWedding(user.token)
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests`,
      headers: auth(user.token),
      payload: { name: 'Марина', phone: '+79170001122' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().phone).toBe('+79170001122')
    const guestId = created.json().id as string

    const list = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/guests`, headers: auth(user.token) })
    expect((list.json() as { id: string; phone: string | null }[]).find((g) => g.id === guestId)?.phone).toBe('+79170001122')

    const patched = await app.inject({
      method: 'PATCH',
      url: `/weddings/${weddingId}/guests/${guestId}`,
      headers: auth(user.token),
      payload: { phone: '+79170003344' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().phone).toBe('+79170003344')

    // Пропуск поля номер не трогает (R-165), явный null — стирает (R-17).
    const untouched = await app.inject({
      method: 'PATCH',
      url: `/weddings/${weddingId}/guests/${guestId}`,
      headers: auth(user.token),
      payload: { name: 'Марина К.' },
    })
    expect(untouched.json().phone).toBe('+79170003344')
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/weddings/${weddingId}/guests/${guestId}`,
      headers: auth(user.token),
      payload: { phone: null },
    })
    expect(cleared.json().phone).toBeNull()
  })

  it('удалить аккаунт с забронированной сделкой нельзя — 409 обеим сторонам, после отмены можно', async () => {
    /* Контракт с v0.2 обещал: «активные сделки — 409 со списком». До фикса
     * аккаунт стирался молча: у подрядчика дата оставалась занятой
     * призраком, у пары — сделка с исчезнувшим исполнителем. */
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const owner = await newUser()
    const profile = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Студия ${RUN}`, categoryId: 'photo', city: { name: 'Казань', region: 'Татарстан' } },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(couple.token) })).json() as {
      id: string
      categoryId: string
    }[]
    const slot = slots.find((s) => s.categoryId === 'photo')!
    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(couple.token), ...key() },
      payload: { vendorId: profile.json().id, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(booked.statusCode).toBe(200)

    const coupleTry = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(couple.token) })
    expect(coupleTry.statusCode).toBe(409)
    expect(coupleTry.json().error.code).toBe('active_deals')
    expect(coupleTry.json().error.message).toContain(`Студия ${RUN}`)

    const ownerTry = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(owner.token) })
    expect(ownerTry.statusCode).toBe(409)
    expect(ownerTry.json().error.code).toBe('active_deals')

    // Аккаунты живы: удаление не прошло наполовину.
    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from users where phone = any($1) and deleted_at is null',
      [[couple.phone, owner.phone]],
    )
    expect(rows[0]!.n).toBe('2')

    const cancelled = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slot.id}/cancel`,
      headers: { ...auth(couple.token), ...key() },
    })
    expect(cancelled.statusCode).toBe(200)
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(owner.token) })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(couple.token) })).statusCode).toBe(204)
  })

  it('партнёр, уходящий не последним из «пары», сделки не бросает — 204', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const owner = await newUser()
    const profile = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `Декор ${RUN}`, categoryId: 'decor', city: { name: 'Казань', region: 'Татарстан' } },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(couple.token) })).json() as {
      id: string
      categoryId: string
    }[]
    const slot = slots.find((s) => s.categoryId === 'decor')!
    await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(couple.token), ...key() },
      payload: { vendorId: profile.json().id, price: { amount: 1_000_000, currency: 'RUB' } },
    })

    // Второй партнёр входит по приглашению с ролью «пара».
    const partner = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role: 'couple' },
    })
    expect(invite.statusCode).toBe(201)
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code as string}/accept`,
      headers: auth(partner.token),
    })
    expect(accepted.statusCode).toBe(200)

    // Первый уходит — второй остаётся, сделка при хозяине.
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(couple.token) })).statusCode).toBe(204)
    // Последний из пары уже не может.
    expect((await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(partner.token) })).statusCode).toBe(409)
  })
})
