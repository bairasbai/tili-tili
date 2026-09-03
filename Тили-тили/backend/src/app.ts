import Fastify, { type FastifyError, type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import { loadConfig, type Config } from './config.js'
import { AppError, TooManyRequests, toErrorBody } from './errors.js'
import { maskUrl } from './redact.js'
import { registerDb } from './plugins/db.js'
import { registerRedis } from './plugins/redis.js'
import { CONTRACT_SCHEMAS } from './contract/schemas.generated.js'
import { registerAuth } from './plugins/auth.js'
import { authRoutes } from './routes/auth.js'
import { budgetRoutes } from './routes/budget.js'
import { catalogRoutes } from './routes/catalog.js'
import { dayRoutes } from './routes/day.js'
import { dealRoutes } from './routes/deals.js'
import { documentRoutes } from './routes/documents.js'
import { guestRoutes } from './routes/guests.js'
import { slotRoutes } from './routes/slots.js'
import { weddingLifecycleRoutes } from './routes/weddingLifecycle.js'
import { geoRoutes } from './routes/geo.js'
import { giftRoutes } from './routes/gifts.js'
import { healthRoutes } from './routes/health.js'
import { inviteRoutes } from './routes/invites.js'
import { vendorRoutes } from './routes/vendor.js'
import { weddingRoutes } from './routes/weddings.js'
import { weddingAccessHook } from './wedding/access.js'
import { userRoutes } from './routes/users.js'
import { makeNotImplementedRoutes, routeKey } from './routes/not-implemented.js'

/**
 * @param overrides    точечная подмена конфигурации (тесты, отладка)
 * @param extraRoutes  модули с РЕАЛИЗОВАННЫМИ маршрутами. Регистрируются до
 *                     заглушек, поэтому путь контракта, у которого появился
 *                     обработчик, заглушку не получает. Сюда этап 1 и дальше
 *                     складывают свои маршруты.
 */
export async function buildApp(
  overrides: Partial<Config> = {},
  extraRoutes: FastifyPluginAsync[] = [],
): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...overrides }

  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : {
            level: config.env === 'production' ? 'info' : 'debug',
            serializers: {
              // Гостевой токен стоит в адресе, а адрес пишется в лог каждого
              // запроса. Без маскировки лог — это список рабочих ключей от
              // чужих страниц и готовый ответ на «кто что подарил» (§9).
              req: (request) => ({
                method: request.method,
                url: maskUrl(request.url),
                host: request.host,
                remoteAddress: request.ip,
                remotePort: request.socket?.remotePort ?? 0,
              }),
            },
          },
    // Идентификатор запроса попадает и в лог, и в тело ошибки 500 — по нему
    // жалоба пользователя находится в логах за один grep.
    genReqId: () => crypto.randomUUID(),
    // Не `true`: безусловное доверие X-Forwarded-For позволяет любому клиенту
    // назначить себе адрес и обойти ограничитель. За балансировщиком Timeweb
    // в TRUST_PROXY ставится число прыжков; функция ниже — ровно эта семантика
    // («доверяю первым N звеньям цепочки»), потому что типы Fastify числа
    // не принимают, хотя proxy-addr его понимает.
    trustProxy:
      typeof config.trustProxy === 'number'
        ? (_address: string, hop: number) => hop < (config.trustProxy as number)
        : config.trustProxy,
    bodyLimit: 1_048_576,
    ajv: {
      customOptions: {
        // Fastify по умолчанию МОЛЧА выбрасывает неописанные поля. Для нас это
        // хуже отказа: опечатка `quiteHours` вместо `quietHours` просто ничего
        // не сделает, и искать её придётся по факту «настройка не сохраняется».
        // Пусть лучше приходит 422 с именем поля.
        removeAdditional: false,
        // Параметры строки запроса приходят строками — без приведения
        // `?lat=54.7` не пройдёт проверку `type: number`.
        coerceTypes: true,
      },
    },
  })

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
  })

  // Схемы контракта — тот же документ, что и openapi.yaml, а не вторая копия
  // правил рядом. Обработчик пишет ref('Wedding'), и при правке контракта
  // валидатор меняется вместе с ним.
  app.addSchema(CONTRACT_SCHEMAS)

  await registerDb(app, config)
  await registerRedis(app, config)
  await registerAuth(app, config)

  // Всё, что нельзя разобрать, обязано выглядеть одинаково — иначе фронт
  // разбирает три разных формы ошибки вместо одной.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      // Контракт обещает Retry-After при 429 — без него клиент не знает,
      // когда повторить, и либо долбится, либо ждёт наугад.
      if (error instanceof TooManyRequests) reply.header('retry-after', String(error.retryAfter))
      return reply.code(error.statusCode).send(toErrorBody(error.code, error.message, error.fields))
    }
    if (error.validation) {
      const fields: Record<string, string> = {}
      for (const v of error.validation) {
        fields[v.instancePath.replace(/^\//, '') || (v.params['missingProperty'] as string) || '_'] = v.message ?? 'неверное значение'
      }
      return reply.code(422).send(toErrorBody('validation_failed', 'Запрос не прошёл проверку', fields))
    }
    const status = error.statusCode ?? 500
    if (status >= 500) {
      request.log.error({ err: error }, 'необработанная ошибка')
      return reply.code(status).send(toErrorBody('internal', `Внутренняя ошибка. Идентификатор запроса: ${request.id}`))
    }
    return reply.code(status).send(toErrorBody(error.code ?? 'error', error.message))
  })

  /**
   * Пустое тело у POST без тела — не ошибка.
   *
   * Контракт объявляет `POST …/invite-link` и `POST …/reserve` без
   * requestBody, но клиент, который ставит `content-type: application/json`
   * на все запросы подряд (обычная настройка axios/fetch-обёртки), получал
   * от Fastify 400 FST_ERR_CTP_EMPTY_JSON_BODY — отказ за то, чего мы
   * не просили. Найдено живым HTTP-прогоном: app.inject заголовок
   * не подставляет и потому молчал.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = (body as string).trim()
    if (raw === '') return done(null, undefined)
    try {
      done(null, JSON.parse(raw))
    } catch {
      done(new AppError(422, 'invalid_json', 'Тело запроса — не JSON'), undefined)
    }
  })

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(toErrorBody('not_found', `Нет такого адреса: ${request.method} ${request.url}`)),
  )

  // Занятые маршруты собираются хуком, а не списком в коде: список пришлось бы
  // держать в согласии с реальностью руками, а хук не забудет.
  const taken = new Set<string>()
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const m of methods) taken.add(routeKey(m, route.url))
  })

  // Матрица доступа — один хук на все пути со свадьбой в адресе, включая те,
  // обработчиков у которых ещё нет. Иначе путь следующего этапа открывается
  // помощнику просто потому, что про проверку забыли.
  app.addHook('preHandler', weddingAccessHook(app))

  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(geoRoutes)
  await app.register(weddingRoutes)
  await app.register(inviteRoutes)
  await app.register(catalogRoutes)
  await app.register(vendorRoutes)
  await app.register(slotRoutes)
  await app.register(dealRoutes)
  await app.register(budgetRoutes)
  await app.register(documentRoutes)
  await app.register(weddingLifecycleRoutes)
  await app.register(guestRoutes)
  await app.register(dayRoutes)
  await app.register(giftRoutes)
  for (const routes of extraRoutes) await app.register(routes)
  await app.register(makeNotImplementedRoutes(taken))

  return app
}
