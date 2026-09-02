import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import type { Config } from '../config.js'

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
    // Требование BullMQ: очередь сама решает, когда повторять.
    maxRetriesPerRequest: null,
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
