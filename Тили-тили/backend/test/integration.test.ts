import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createDb } from '../src/plugins/db.js'

/**
 * Проверки против настоящих PostgreSQL и Redis.
 *
 * Идут только когда заданы TEST_DATABASE_URL и TEST_REDIS_URL — локально это
 * `docker compose up -d db redis`, в CI это сервисы workflow. Без них набор
 * пропускается, а не падает: разработчику не нужен docker, чтобы починить опечатку.
 *
 * Пропуск виден в выводе vitest, поэтому «зелёный прогон без базы» нельзя
 * спутать с «база проверена».
 */
const DB = process.env.TEST_DATABASE_URL
const REDIS = process.env.TEST_REDIS_URL
const live = Boolean(DB && REDIS)

describe.skipIf(!live)('живые PostgreSQL и Redis', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: REDIS ?? null, corsOrigins: [] })
    await app.ready()
    // Подключение к Redis идёт параллельно старту — дожидаемся его здесь,
    // иначе проверка /health/ready ловит момент 'connecting' и мигает.
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

  it('/health/ready отвечает 200, когда база и Redis на месте', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.json()).toMatchObject({ status: 'ready', db: 'up', redis: 'up' })
    expect(res.statusCode).toBe(200)
  })

  it('миграция накатана: расширения на месте', async () => {
    const { rows } = await app.db!.query<{ extname: string }>(
      "select extname from pg_extension where extname in ('pgcrypto','citext') order by 1",
    )
    expect(rows.map((r) => r.extname)).toEqual(['citext', 'pgcrypto'])
  })

  it('citext делает адрес почты нечувствительным к регистру', async () => {
    // Ради этого расширение и заводилось: иначе Ivan@ и ivan@ — два аккаунта.
    const { rows } = await app.db!.query<{ same: boolean }>(
      "select ('Ivan@Mail.ru'::citext = 'ivan@mail.ru'::citext) as same",
    )
    expect(rows[0]?.same).toBe(true)
  })

  it('gen_random_uuid доступен', async () => {
    const { rows } = await app.db!.query<{ id: string }>('select gen_random_uuid() as id')
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('ping отличает живую базу от мёртвой', async () => {
    expect(await app.db!.ping()).toBe(true)
    const dead = createDb('postgres://нет:нет@127.0.0.1:1/нет')
    expect(await dead.ping()).toBe(false)
    await dead.close().catch(() => undefined)
  })

  it('Redis отвечает и переживает запись-чтение', async () => {
    const key = `tili:test:${Date.now()}`
    await app.redis!.set(key, 'значение', 'EX', 10)
    expect(await app.redis!.get(key)).toBe('значение')
    await app.redis!.del(key)
  })
})

describe.skipIf(live)('без живых служб', () => {
  it('набор с базой пропущен намеренно', () => {
    expect(live).toBe(false)
  })
})
