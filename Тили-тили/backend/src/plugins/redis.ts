import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import type { Config } from '../config.js'

/** Сколько ждём ответа Redis, прежде чем считать его недоступным. */
export const REDIS_CALL_TIMEOUT_MS = 250

/**
 * Ожидание с потолком.
 *
 * Одних настроек клиента мало. Пока соединение НИ РАЗУ не установилось,
 * ioredis держит команду в очереди офлайна и не отклоняет её: счётчик
 * повторов относится к разрывам, а не к первому подключению. Команда
 * ждёт вечно, и вместе с ней ждёт обработчик — то есть весь сервер,
 * потому что ограничитель частоты стоит на каждом запросе.
 *
 * Очередь при этом нужна: команда, поданная в первые миллисекунды жизни
 * процесса, должна дождаться соединения, а не пройти мимо ограничителя.
 * Поэтому ждём — но не дольше четверти секунды.
 */
export async function withRedisTimeout<T>(action: Promise<T>, ms = REDIS_CALL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('redis не ответил вовремя')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis | null
  }
}

export async function registerRedis(app: FastifyInstance, config: Config): Promise<void> {
  if (!config.redisUrl) {
    app.decorate('redis', null)
    app.log.warn('REDIS_URL не задан — очереди BullMQ работать не будут')
    return
  }

  const redis = new Redis(config.redisUrl, {
    /* Команда обязана ЗАВЕРШИТЬСЯ — успехом или отказом.
     *
     * `maxRetriesPerRequest: null` вместе с очередью офлайна означает, что
     * при мёртвом Redis команда не падает, а ждёт бесконечно. Ограничитель
     * частоты стоит на КАЖДОМ запросе и ловит ошибку, чтобы пропустить
     * поток дальше, — но ошибки не будет: обработчик просто повиснет,
     * и вместе с ним повиснет весь сервер. Отказ здесь — это работающий
     * сайт без ограничителя; ожидание — недоступный сайт.
     *
     * Требования BullMQ это не нарушает: очередь поднимает СВОИ соединения
     * из `REDIS_URL` (см. registerJobs) и этот клиент не трогает.
     *
     * Очередь офлайна при этом остаётся включённой: команда, поданная
     * в первые миллисекунды жизни процесса, должна дождаться соединения,
     * а не пройти мимо ограничителя. Ограничивает ожидание именно число
     * попыток — после них команда отклоняется с ошибкой.
     */
    maxRetriesPerRequest: 2,
    // lazyConnect здесь был бы ошибкой: клиент не подключается до первой
    // команды, статус навсегда остаётся 'wait', и /health/ready никогда
    // не отдаст 200 — балансировщик не пустит трафик на живую машину.
    lazyConnect: false,
  })
  // Без обработчика ioredis роняет процесс на первом же обрыве соединения.
  // Подключение не ждём: сервер обязан подняться и при мёртвом Redis,
  // честно показав это в /health/ready.
  redis.on('error', (err: Error) => app.log.error({ err }, 'redis'))

  app.decorate('redis', redis)
  app.addHook('onClose', async () => {
    redis.disconnect()
  })
}
