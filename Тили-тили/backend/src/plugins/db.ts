import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import type { Config } from '../config.js'

/**
 * Пул подключений к PostgreSQL.
 *
 * Обработчики получают `app.db.query(...)` и ничего не знают ни про pg, ни про
 * Fastify глубже request/reply — условие дешёвого разворота из раздела 1 плана.
 */
export interface Db {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>
  ping(): Promise<boolean>
  close(): Promise<void>
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db | null
  }
}

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })

  return {
    query: (text, values) => pool.query(text, values as unknown[]),
    async ping() {
      try {
        await pool.query('select 1')
        return true
      } catch {
        return false
      }
    },
    close: () => pool.end(),
  }
}

export async function registerDb(app: FastifyInstance, config: Config): Promise<void> {
  if (!config.databaseUrl) {
    // Разработка и тесты без базы: сервер поднимается, /health/ready честно
    // отвечает 503. Молча притворяться живым нельзя.
    app.decorate('db', null)
    app.log.warn('DATABASE_URL не задан — обработчики с базой работать не будут')
    return
  }
  const db = createDb(config.databaseUrl)
  app.decorate('db', db)
  app.addHook('onClose', () => db.close())
}
