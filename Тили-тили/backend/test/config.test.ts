import { describe, it, expect } from 'vitest'
import { loadConfig, ConfigError } from '../src/config.js'

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv

/** Полный набор для production — от него отнимаем по одному. */
const PROD = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://tili-tili.ru',
  DATABASE_URL: 'postgres://u:p@h:5432/d',
  REDIS_URL: 'redis://h:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
}

describe('конфигурация: разработка', () => {
  it('поднимается без подключений и секретов', () => {
    const c = loadConfig(env({ NODE_ENV: 'development' }))
    expect(c.databaseUrl).toBeNull()
    expect(c.redisUrl).toBeNull()
    expect(c.port).toBe(3000)
  })

  it('источники CORS разбираются списком, пустые отбрасываются', () => {
    expect(loadConfig(env({ CORS_ORIGINS: 'http://a.ru, http://b.ru ,' })).corsOrigins).toEqual([
      'http://a.ru',
      'http://b.ru',
    ])
  })
})

describe('конфигурация: ловушки, которые иначе всплывут в проде', () => {
  it('нечисловой PORT отвергается на старте, а не внутри listen', () => {
    expect(() => loadConfig(env({ PORT: 'три' }))).toThrow(ConfigError)
    expect(() => loadConfig(env({ PORT: '70000' }))).toThrow(/1\.\.65535/)
    expect(() => loadConfig(env({ PORT: '8080' })).port).not.toThrow()
  })

  it('опечатка в NODE_ENV не переводит прод в режим разработки', () => {
    // NODE_ENV=prod прошёл бы как «не production» и снял все обязательные
    // проверки: сервер поднялся бы в проде вообще без секретов.
    expect(() => loadConfig(env({ NODE_ENV: 'prod' }))).toThrow(/NODE_ENV/)
    expect(() => loadConfig(env({ NODE_ENV: 'PRODUCTION' }))).toThrow(/NODE_ENV/)
  })
})

describe('конфигурация: production требует всё', () => {
  it('полный набор проходит', () => {
    const c = loadConfig(env(PROD))
    expect(c.env).toBe('production')
    expect(c.corsOrigins).toEqual(['https://tili-tili.ru'])
  })

  it.each([
    ['DATABASE_URL', /DATABASE_URL/],
    ['REDIS_URL', /REDIS_URL/],
    ['JWT_ACCESS_SECRET', /JWT_ACCESS_SECRET/],
    ['JWT_REFRESH_SECRET', /JWT_REFRESH_SECRET/],
    ['CORS_ORIGINS', /CORS_ORIGINS/],
  ])('без %s не стартует', (key, message) => {
    const partial = { ...PROD } as Record<string, string>
    delete partial[key]
    expect(() => loadConfig(env(partial))).toThrow(message)
  })

  it('одинаковые секреты access и refresh отвергаются', () => {
    const same = { ...PROD, JWT_REFRESH_SECRET: PROD.JWT_ACCESS_SECRET }
    expect(() => loadConfig(env(same))).toThrow(/различаться/)
  })

  it('короткий секрет отвергается', () => {
    const short = { ...PROD, JWT_ACCESS_SECRET: 'коротко' }
    expect(() => loadConfig(env(short))).toThrow(/32/)
  })
})
