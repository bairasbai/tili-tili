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
    lazyConnect: true,
  })
  // Без обработчика ioredis роняет процесс на первом же обрыве соединения.
  redis.on('error', (err: Error) => app.log.error({ err }, 'redis'))

  app.decorate('redis', redis)
  app.addHook('onClose', async () => {
    redis.disconnect()
  })
}
