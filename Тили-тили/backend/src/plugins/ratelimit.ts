import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import type { Config } from '../config.js'
import { TooManyRequests } from '../errors.js'
import { readGuestToken } from '../guests/access.js'
import { withRedisTimeout } from './redis.js'

/**
 * Ограничение частоты на токен — требование §13.4 и раздела 6 плана.
 *
 * Считаем в Redis, а не в памяти процесса: за балансировщиком процессов
 * несколько, и счётчик в памяти означал бы лимит, умноженный на их число.
 * Без Redis ограничителя нет вовсе — и об этом сказано в логе, чтобы это
 * не выглядело как «работает».
 *
 * Ключ — токен, а не адрес: за одним адресом сидит целый свадебный чат
 * с общим Wi-Fi, а токен принадлежит одному человеку.
 */
const WINDOW_SECONDS = 1

/** Проверки здоровья считает балансировщик — им ограничение только мешает. */
const SKIP = /^\/health/

function callerKey(request: FastifyRequest): string {
  // Гость ходит по токену в адресе, пользователь — по заголовку.
  const guest = readGuestToken(request)
  if (guest) return `g:${createHash('sha256').update(guest).digest('base64url').slice(0, 22)}`

  const auth = request.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    // Хешируем: сырой токен не должен оказаться ни в Redis, ни в логе.
    return `u:${createHash('sha256').update(auth.slice(7)).digest('base64url').slice(0, 22)}`
  }
  return `ip:${request.ip}`
}

export async function registerRateLimit(app: FastifyInstance, config: Config): Promise<void> {
  if (!app.redis) {
    app.log.warn('REDIS_URL не задан — ограничение частоты запросов выключено')
    return
  }
  const limit = config.rateLimitPerSecond
  if (limit <= 0) return

  app.addHook('onRequest', async (request) => {
    if (SKIP.test(request.url)) return
    const key = `rl:${callerKey(request)}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`

    let count: number
    try {
      count = await withRedisTimeout(app.redis!.incr(key))
      // Срок ставим только на первом запросе окна: лишний EXPIRE на каждый
      // запрос — лишний поход в Redis без всякой пользы.
      if (count === 1) await withRedisTimeout(app.redis!.expire(key, WINDOW_SECONDS + 1))
    } catch (err) {
      // Redis прилёг — пропускаем. Ограничитель защищает от перегрузки,
      // а не наоборот: превращать его сбой в отказ всему сервису нельзя.
      app.log.error({ err }, 'ограничитель частоты недоступен')
      return
    }

    if (count > limit) {
      throw new TooManyRequests(WINDOW_SECONDS, `Не больше ${limit} запросов в секунду`, 'rate_limited')
    }
  })
}
