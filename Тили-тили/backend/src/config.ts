import 'dotenv/config'

export type Env = 'development' | 'test' | 'production'

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

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Переменная окружения ${name} обязательна в production. См. .env.example`)
  return value
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = (source.NODE_ENV ?? 'development') as Env
  const production = env === 'production'

  return {
    env,
    port: Number(source.PORT ?? 3000),
    host: source.HOST ?? '0.0.0.0',
    corsOrigins: (source.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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
}
