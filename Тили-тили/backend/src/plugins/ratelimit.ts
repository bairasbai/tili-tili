import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import type { Config } from '../config.js'
import { TooManyRequests } from '../errors.js'
import { GUEST_ACCESSIBLE_WEDDING_PATHS, readGuestToken } from '../guests/access.js'
import { verifyAccessToken } from '../auth/tokens.js'
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

/** Путь, где гостевой токен что-то значит: в адресе или в списке гостевых путей свадьбы. */
function isGuestRoute(request: FastifyRequest): boolean {
  const url = request.routeOptions?.url
  if (!url) return false
  return url.includes(':guestToken') || GUEST_ACCESSIBLE_WEDDING_PATHS.has(`${request.method} ${url}`)
}

/**
 * Ключ счётчика: по человеку, по гостю или по адресу.
 *
 * Токен даёт свой ключ ТОЛЬКО с верной подписью. Ключ от сырого заголовка
 * означал бы, что любой клиент без входа шлёт `Bearer <случайная строка>`
 * и каждый его запрос попадает в новый счётчик — лимит на адрес для входа
 * по SMS, обмена токенов и всех путей без токена не срабатывал бы никогда
 * (D6-02). Подпись проверяется здесь без базы: `onRequest` идёт раньше
 * `requireAuth`, а поход в базу ради счётчика превратил бы защиту от
 * перегрузки в её источник. Просроченный или чужой токен — тот же мусор:
 * счёт по адресу.
 */
export async function rateLimitKey(request: FastifyRequest, secret: string | null): Promise<string> {
  /* Гость ходит по токену в адресе — но только на СВОИХ путях. Токен гостя
   * подписи не имеет и проверяется лишь по базе, поэтому здесь он берётся
   * на веру; чтобы `?guestToken=мусор` не заводил новый счётчик на входе по
   * SMS или обмене токенов, вне гостевых путей он не считается вовсе. */
  const guest = readGuestToken(request)
  if (guest && isGuestRoute(request)) return `g:${createHash('sha256').update(guest).digest('base64url').slice(0, 22)}`

  const auth = request.headers.authorization
  if (secret && auth?.startsWith('Bearer ')) {
    try {
      const claims = await verifyAccessToken(secret, auth.slice(7).trim())
      return `u:${claims.sub}`
    } catch {
      // Подпись не сошлась — заголовок ничего не доказывает.
    }
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
    const caller = await rateLimitKey(request, config.jwtAccessSecret ?? null)
    const key = `rl:${caller}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`

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
