import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import type { Config } from '../config.js'

/**
 * Пул подключений к PostgreSQL.
 *
 * Обработчики получают `app.db.query(...)` и ничего не знают ни про pg, ни про
 * Fastify глубже request/reply — условие дешёвого разворота из раздела 1 плана.
 */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>
}

export interface Db extends Queryable {
  /**
   * Действие в одной транзакции на ОДНОМ соединении.
   *
   * Без этого «вставить сделку, занять слот, захватить дату» — три отдельных
   * запроса из пула: между ними другая пара успевает занять ту же дату,
   * и половина изменений остаётся в базе. Ограничения ловят конфликт, но
   * откатить недоделанное может только транзакция.
   */
  tx<T>(action: (client: Queryable) => Promise<T>): Promise<T>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/** Коды нарушений ограничений в PostgreSQL. */
export const UNIQUE_VIOLATION = '23505'
export const CHECK_VIOLATION = '23514'

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined

export function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === UNIQUE_VIOLATION
}

/**
 * Нарушение CHECK — это сработавшая защита, а не поломка сервера.
 * Переполнение автобуса приходит именно так, когда триггер увеличил счётчик
 * выше числа мест: транзакция откатывается, и человеку нужен внятный 409.
 */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  if (errorCode(error) !== CHECK_VIOLATION) return false
  if (!constraint) return true
  return (error as { constraint?: string }).constraint === constraint
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
    /* Запрос без потолка держит соединение из десяти, пока база его не
     * добьёт сама, — а она не добьёт. Один тяжёлый запрос по каталогу
     * при неудачном плане останавливает весь сервер: свободных соединений
     * в пуле не остаётся, и ждут ВСЕ.
     *
     * Второй потолок — про открытую транзакцию: обработчик, упавший между
     * `begin` и `commit`, держал бы блокировки строк до перезапуска. */
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 10_000,
  })

  return {
    query: (text, values) => pool.query(text, values as unknown[]),
    async tx(action) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await action({
          query: (text, values) => client.query(text, values as unknown[]),
        })
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
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
