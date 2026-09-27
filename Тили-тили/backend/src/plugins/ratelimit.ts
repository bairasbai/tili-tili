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
 *
 * Окно — `config.rateLimitWindowSeconds` (по умолчанию 10 с), предел за окно —
 * лимит × окно. Секундная рамка резала обычную загрузку экрана: главная новой
 * свадьбы шлёт десяток запросов за доли секунды, и хвост получал 429 (ERR-0307).
 */

/** Проверки здоровья считает балансировщик — им ограничение только мешает. */
const SKIP = /^\/health/
/**
 * Во сколько раз потолок по адресу на гостевых путях выше личного: за одним
 * адресом на площадке сидит вся свадьба (Wi-Fi банкетного зала), и общий
 * лимит «как у одного человека» резал бы гостей разом; а без потолка вовсе
 * токен без подписи обходил бы ограничитель.
 */
const GUEST_IP_FACTOR = 10

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
   * SMS или обмене токенов, вне гостевых путей он не считается вовсе. На
   * гостевых путях счётчик по токену — не единственный: рядом считается адрес
   * с потолком в `GUEST_IP_FACTOR` раз выше (`registerRateLimit`), иначе тысяча
   * случайных токенов с одного адреса — тысяча свежих счётчиков (ревью 015). */
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
  const windowSeconds = Math.max(1, Math.floor(config.rateLimitWindowSeconds))
  const per = windowSeconds === 1 ? 'в секунду' : `за ${windowSeconds} с`

  app.addHook('onRequest', async (request) => {
    if (SKIP.test(request.url)) return
    const caller = await rateLimitKey(request, config.jwtAccessSecret ?? null)
    const now = Math.floor(Date.now() / 1000)
    const window = Math.floor(now / windowSeconds)
    /* Гостевой токен не подписан — рядом с его счётчиком считается адрес,
     * с потолком выше (см. `GUEST_IP_FACTOR`). Префикс `gip` держит этот
     * потолок отдельно от анонимного счётчика `ip`: общая строка ключа
     * отдавала бы гостям на одном Wi-Fi чужой лимит адреса — вход по SMS,
     * обмен токенов, каталог без входа — и наоборот (F-RL-1-03). */
    const checks: { key: string; max: number }[] = [{ key: `rl:${caller}:${window}`, max: limit * windowSeconds }]
    if (caller.startsWith('g:')) checks.push({ key: `rl:gip:${request.ip}:${window}`, max: limit * GUEST_IP_FACTOR * windowSeconds })

    for (const { key, max } of checks) {
      let count: number
      try {
        count = await withRedisTimeout(app.redis!.incr(key))
        // Срок ставим только на первом запросе окна: лишний EXPIRE на каждый
        // запрос — лишний поход в Redis без всякой пользы.
        if (count === 1) await withRedisTimeout(app.redis!.expire(key, windowSeconds + 1))
      } catch (err) {
        // Redis прилёг — пропускаем. Ограничитель защищает от перегрузки,
        // а не наоборот: превращать его сбой в отказ всему сервису нельзя.
        app.log.error({ err }, 'ограничитель частоты недоступен')
        return
      }
      if (count > max) {
        // Повтор — с началом следующего окна, а не через всё окно целиком.
        throw new TooManyRequests(windowSeconds - (now % windowSeconds), `Не больше ${max} запросов ${per}`, 'rate_limited')
      }
    }
  })
}
