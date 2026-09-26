import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'

/**
 * Ограничение частоты на токен — §13.4 и раздел 6 плана.
 *
 * Требование было записано в двух документах и не реализовано нигде.
 * Считается в Redis: счётчик в памяти процесса за балансировщиком означал
 * бы лимит, умноженный на число процессов.
 */
const REDIS = process.env.TEST_REDIS_URL
const live = Boolean(REDIS)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('ограничение частоты', () => {
  let app: FastifyInstance
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: null,
      redisUrl: REDIS ?? null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      rateLimitPerSecond: 3,
    })
    await app.ready()
    // Подключение к Redis идёт параллельно старту — дожидаемся его здесь,
    // иначе первая пачка теста может застать момент 'connecting' и словить
    // фиктивный пропуск лимитера через таймаут (см. integration.test.ts:28-36).
    await new Promise<void>((resolve, reject) => {
      const redis = app.redis!
      if (redis.status === 'ready') return resolve()
      const timer = setTimeout(() => reject(new Error('Redis не поднялся за 10 с')), 10_000)
      redis.once('ready', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  })

  afterAll(async () => {
    await app?.close()
  })

  /** Ждём начала свежей секунды: пачка обязана попасть целиком в одно окно лимитера. */
  const alignWindow = () => new Promise<void>((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 20))

  const hit = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/geo/cities?q=Ка', headers, remoteAddress: IP })

  it('поток свыше предела упирается в 429 с Retry-After', async () => {
    const token = `Bearer ${'x'.repeat(40)}-${randomInt(1, 1_000_000)}`
    /* Запросы идут ПАЧКОЙ, а не по очереди: окно — одна секунда, и
     * последовательный цикл может перешагнуть её границу, обнулив счётчик.
     * Тест на времени должен укладываться в окно сам, а не надеяться. */
    await alignWindow()
    const burst = await Promise.all(Array.from({ length: 8 }, () => hit({ authorization: token })))

    const refused = burst.filter((r) => r.statusCode === 429)
    expect(burst.filter((r) => r.statusCode !== 429).length).toBeLessThanOrEqual(3)
    expect(refused.length).toBeGreaterThan(0)
    // Отказ ВРЕМЕННЫЙ, значит с заголовком: клиент должен знать, что повтор
    // поможет (ERR-0051 про эту разницу).
    expect(refused[0]!.json().error.code).toBe('rate_limited')
    expect(Number(refused[0]!.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('счёт идёт по подписанному токену, а не по адресу', async () => {
    /* Токены НАСТОЯЩИЕ, подписанные секретом сервера. До 2026-09-11 здесь
     * стояли случайные строки, и тест сертифицировал обход: ключом был хеш
     * сырого заголовка, и любой мусор в `Authorization` заводил новый счётчик. */
    const one = `Bearer ${await signAccessToken(SECRET_A, { sub: randomUUID(), sid: randomUUID() })}`
    const two = `Bearer ${await signAccessToken(SECRET_A, { sub: randomUUID(), sid: randomUUID() })}`
    // Сосед идёт в той же пачке: иначе он попадёт в следующее окно
    // и проверка ничего не докажет.
    await alignWindow()
    const [, neighbour] = await Promise.all([
      Promise.all(Array.from({ length: 6 }, () => hit({ authorization: one }))),
      hit({ authorization: two }),
    ])

    // За одним адресом сидит целый свадебный чат с общим Wi-Fi: сосед
    // не должен получать отказ из-за чужой активности.
    expect(neighbour.statusCode).not.toBe(429)
  })

  it('мусорные токены счётчик адреса не обходят', async () => {
    // Каждый запрос — с новым выдуманным Bearer, все с одного адреса.
    await alignWindow()
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) => hit({ authorization: `Bearer ${'z'.repeat(40)}-${i}-${randomInt(1, 1_000_000)}` })),
    )
    // До фикса все восемь проходили: ключ считался от сырого заголовка (D6-02).
    expect(burst.filter((r) => r.statusCode === 429).length).toBeGreaterThan(0)
    expect(burst.filter((r) => r.statusCode !== 429).length).toBeLessThanOrEqual(3)
  })

  it('проверки здоровья не ограничиваются', async () => {
    const codes: number[] = []
    for (let i = 0; i < 8; i++) {
      codes.push((await app.inject({ method: 'GET', url: '/health', remoteAddress: IP })).statusCode)
    }
    // Их зовёт балансировщик, и отказ ему означает вывод живой машины
    // из ротации.
    expect(codes.every((c) => c === 200)).toBe(true)
  })

  describe('раздельные счётчики: гостевой потолок по адресу ≠ анонимный счётчик адреса (F-RL-1-03)', () => {
    // Свой адрес: общий с другими тестами счётчик по адресу искажал бы и
    // гостевой потолок, и анонимный счёт — каждый тест должен видеть
    // только собственную нагрузку.
    const ADDR = `198.19.${randomInt(0, 255)}.${randomInt(1, 254)}`
    const guestHit = (token: string) => app.inject({ method: 'GET', url: `/rsvp/${token}`, remoteAddress: ADDR })
    const anonHit = () => app.inject({ method: 'GET', url: '/geo/cities?q=Ка', remoteAddress: ADDR })

    it('гостевая пачка не съедает анонимный лимит того же адреса', async () => {
      // До фикса гостевой потолок по адресу и анонимный счётчик адреса —
      // одна и та же строка ключа в Redis: 20 гостевых с разных токенов уже
      // поднимают её до 20, и следующий анонимный запрос получает
      // INCR = 21 > лимита 3 → 429 не по своей вине (F-RL-1-03).
      let held = false
      let anonStatus = -1
      let guestBurst: Awaited<ReturnType<typeof guestHit>>[] = []
      for (let attempt = 0; attempt < 3 && !held; attempt++) {
        await alignWindow()
        const before = Math.floor(Date.now() / 1000)
        const tokens = Array.from({ length: 20 }, (_, i) => `t1-${attempt}-${i}-${randomUUID()}`)
        guestBurst = await Promise.all(tokens.map((t) => guestHit(t)))
        anonStatus = (await anonHit()).statusCode
        held = before === Math.floor(Date.now() / 1000)
      }
      if (!held) throw new Error('окно не удержано')
      expect(anonStatus).not.toBe(429)
      // Потолок гостя по адресу — не ниже 20: раньше пачка отбрасывалась без
      // проверки (F3-G5-03), и подмена множителя обычным личным лимитом
      // осталась бы незамеченной.
      expect(guestBurst.filter((r) => r.statusCode === 429).length).toBe(0)
    })

    it('8 анонимных + 1 гостевой в одном окне: гостевой не получает 429', async () => {
      await alignWindow()
      const [, guestOne] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => anonHit())),
        guestHit(`t2-${randomUUID()}`),
      ])
      expect(guestOne.statusCode).not.toBe(429)
    })

    it('10 анонимных, затем 30 гостевых в одном окне: гостевые не платят чужой лимит', async () => {
      // Направление наоборот предыдущего теста: до фикса общий ключ адреса
      // поднимался анонимными запросами первым, и первые из тридцати
      // гостевых уже находили счётчик частично занятым — часть получала 429
      // не по своей вине (F3-G5-02/F3-G6-02; воспроизводит верификацию
      // F3-G6, случай A2a: 10 анонимных съедали 10 гостевых мест).
      let held = false
      let guestBurst: Awaited<ReturnType<typeof guestHit>>[] = []
      for (let attempt = 0; attempt < 3 && !held; attempt++) {
        await alignWindow()
        const before = Math.floor(Date.now() / 1000)
        await Promise.all(Array.from({ length: 10 }, () => anonHit()))
        const tokens = Array.from({ length: 30 }, (_, i) => `t2b-${attempt}-${i}-${randomUUID()}`)
        guestBurst = await Promise.all(tokens.map((t) => guestHit(t)))
        held = before === Math.floor(Date.now() / 1000)
      }
      if (!held) throw new Error('окно не удержано')
      expect(guestBurst.filter((r) => r.statusCode === 429).length).toBe(0)
    })

    it('потолок limit × GUEST_IP_FACTOR держит ровно 30: 31-й гостевой получает 429', async () => {
      // Раньше здесь проверялось только «хоть один 429» на пачке из 70 —
      // тест проходил бы и с потолком, ошибочно равным личному лимиту (3),
      // и с любым другим числом меньше 70 (F3-G5-03/F3-G6-03). Потолок
      // закреплён числом: лимит 3 × фактор 10 = 30 (см. случай A3 в
      // верификации F3-G6) — тот же приём удержания окна, что и выше.
      let held = false
      let burst: Awaited<ReturnType<typeof guestHit>>[] = []
      for (let attempt = 0; attempt < 3 && !held; attempt++) {
        await alignWindow()
        const before = Math.floor(Date.now() / 1000)
        const tokens = Array.from({ length: 31 }, (_, i) => `t3-${attempt}-${i}-${randomUUID()}`)
        burst = await Promise.all(tokens.map((t) => guestHit(t)))
        held = before === Math.floor(Date.now() / 1000)
      }
      if (!held) throw new Error('окно не удержано')
      const refused = burst.filter((r) => r.statusCode === 429)
      const passed = burst.filter((r) => r.statusCode !== 429)
      expect(passed.length).toBe(30)
      expect(refused.length).toBe(1)
      expect(refused[0]!.json().error.code).toBe('rate_limited')
      expect(refused[0]!.json().error.message).toBe('Не больше 30 запросов в секунду')
    })
  })
})

describe('без Redis ограничителя нет — и это видно', () => {
  it('приложение поднимается и работает', async () => {
    const app = await buildApp({
      env: 'test',
      databaseUrl: null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      rateLimitPerSecond: 1,
    })
    await app.ready()
    try {
      // Счётчик в памяти процесса за балансировщиком был бы ложью:
      // лимит умножился бы на число процессов. Лучше честно без него.
      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
      }
    } finally {
      await app.close()
    }
  })
})
