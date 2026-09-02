import 'dotenv/config'

export const ENVS = ['development', 'test', 'production'] as const
export type Env = (typeof ENVS)[number]

export interface Config {
  env: Env
  port: number
  host: string
  corsOrigins: string[]
  databaseUrl: string | null
  redisUrl: string | null
  jwtAccessSecret: string | null
  jwtRefreshSecret: string | null
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new ConfigError(`Переменная окружения ${name} обязательна в production. См. .env.example`)
  return value
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3000
  const n = Number(raw)
  // Number('три') — это NaN, и listen({ port: NaN }) падает где-то глубоко
  // внутри Node сообщением, по которому опечатку в переменной не найти.
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`PORT должен быть целым числом 1..65535, получено: ${JSON.stringify(raw)}`)
  }
  return n
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const rawEnv = source.NODE_ENV ?? 'development'
  // Опечатка вроде NODE_ENV=prod тихо переводит сервер в режим разработки:
  // секреты перестают быть обязательными, и он поднимается в проде без них.
  if (!(ENVS as readonly string[]).includes(rawEnv)) {
    throw new ConfigError(`NODE_ENV должен быть одним из: ${ENVS.join(', ')}. Получено: ${JSON.stringify(rawEnv)}`)
  }
  const env = rawEnv as Env
  const production = env === 'production'

  const corsOrigins = (source.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Пустой список в проде означает «браузеру запрещено всё»: приложение
  // поднимется и будет отвечать на curl, а фронт получит ошибку CORS
  // на каждый запрос. Такое лучше поймать на старте.
  if (production && corsOrigins.length === 0) {
    throw new ConfigError('CORS_ORIGINS обязателен в production, иначе фронт не сможет обратиться к API')
  }

  const config: Config = {
    env,
    port: parsePort(source.PORT),
    host: source.HOST ?? '0.0.0.0',
    corsOrigins,
    // В production подключения обязательны: сервер без базы поднимется и будет
    // отдавать 200 на /health, притворяясь живым. Лучше не стартовать вовсе.
    databaseUrl: production ? required('DATABASE_URL', source.DATABASE_URL) : (source.DATABASE_URL ?? null),
    redisUrl: production ? required('REDIS_URL', source.REDIS_URL) : (source.REDIS_URL ?? null),
    jwtAccessSecret: production
      ? required('JWT_ACCESS_SECRET', source.JWT_ACCESS_SECRET)
      : (source.JWT_ACCESS_SECRET ?? null),
    jwtRefreshSecret: production
      ? required('JWT_REFRESH_SECRET', source.JWT_REFRESH_SECRET)
      : (source.JWT_REFRESH_SECRET ?? null),
  }

  if (production) {
    // Один секрет на оба типа токенов означает, что refresh-токен принимается
    // там, где ждут access. Пара минут на генерацию второго — против кражи
    // сессии по протухшему токену.
    if (config.jwtAccessSecret === config.jwtRefreshSecret) {
      throw new ConfigError('JWT_ACCESS_SECRET и JWT_REFRESH_SECRET должны различаться')
    }
    for (const [name, value] of [
      ['JWT_ACCESS_SECRET', config.jwtAccessSecret],
      ['JWT_REFRESH_SECRET', config.jwtRefreshSecret],
    ] as const) {
      if ((value ?? '').length < 32) {
        throw new ConfigError(`${name} короче 32 символов. Сгенерировать: openssl rand -base64 48`)
      }
    }
  }

  return config
}
