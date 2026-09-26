import Fastify, { type FastifyError, type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { loadConfig, type Config } from './config.js'
import { AppError, TooManyRequests, toErrorBody } from './errors.js'
import { maskUrl } from './redact.js'
import { registerDb } from './plugins/db.js'
import { registerRedis } from './plugins/redis.js'
import { registerRateLimit } from './plugins/ratelimit.js'
import { registerSentry } from './plugins/sentry.js'
import { CONTRACT_SCHEMAS } from './contract/schemas.generated.js'
import { registerAuth } from './plugins/auth.js'
import { authRoutes } from './routes/auth.js'
import { paymentScheduleRoutes } from './routes/paymentSchedule.js'
import { budgetRoutes } from './routes/budget.js'
import { catalogRoutes } from './routes/catalog.js'
import { dayRoutes } from './routes/day.js'
import { dealRoutes } from './routes/deals.js'
import { documentRoutes } from './routes/documents.js'
import { guestRoutes } from './routes/guests.js'
import { slotRoutes } from './routes/slots.js'
import { weddingLifecycleRoutes } from './routes/weddingLifecycle.js'
import { chatRoutes } from './routes/chats.js'
import { realtimeRoutes } from './routes/realtime.js'
import { vendorCabinetRoutes } from './routes/vendorCabinet.js'
import { reviewRoutes } from './routes/reviews.js'
import { adminRoutes } from './routes/admin.js'
import { RealtimeHub } from './realtime/hub.js'
import { registerJobs } from './jobs/index.js'
import { dayxRoutes } from './routes/dayx.js'
import { geoRoutes } from './routes/geo.js'
import { notificationRoutes } from './routes/notifications.js'
import { noteRoutes } from './routes/notes.js'
import { giftRoutes } from './routes/gifts.js'
import { healthRoutes } from './routes/health.js'
import { legalRoutes } from './routes/legal.js'
import { inspirationRoutes } from './routes/inspiration.js'
import { inviteRoutes } from './routes/invites.js'
import { vendorRoutes } from './routes/vendor.js'
import { weddingRoutes } from './routes/weddings.js'
import { weddingAccessHook } from './wedding/access.js'
import { userRoutes } from './routes/users.js'
import { makeNotImplementedRoutes, routeKey } from './routes/not-implemented.js'
import { createTillyModel, type TillyModel } from './tilly/model.js'
import { TillyService } from './tilly/service.js'

/**
 * Внешние службы, которые тест подменяет своей реализацией того же интерфейса.
 * `tillyModel`: не задано — модель из конфигурации (`TILLY_*`); `null` — Тиль
 * без модели (заглушка); объект — подставная модель (фича 010).
 */
export interface AppServices {
  tillyModel?: TillyModel | null
}

/**
 * Ошибки разбора тела, которые Fastify выдаёт до обработчика, — в формате
 * контракта. Ключ — внутренний код Fastify (`FST_ERR_CTP_*`).
 */
const BODY_PARSE_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', message: 'Тело запроса слишком большое' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: 'unsupported_media_type',
    message: 'Такой тип содержимого не принимается — нужен application/json',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    status: 400,
    code: 'bad_content_length',
    message: 'Длина тела запроса не совпадает с заголовком Content-Length',
  },
}

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
  services: AppServices = {},
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
    /* Ждать тело запроса вечно нельзя: соединение, которое присылает по
     * байту в минуту, занимает место в пуле и не платит за это ничем.
     * По умолчанию у Fastify таймаута нет вовсе.
     *
     * Таймаут соединения (`connectionTimeout`) здесь НЕ ставится: он режет
     * сокет целиком, а живой канал чата молчит между сообщениями минутами
     * и был бы разорван как «зависший». */
    requestTimeout: 30_000,
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

  /* Заголовки безопасности — своим хуком, а не пакетом.
   *
   * Здесь отдаётся только JSON, и из всего набора helmet осмысленны пять
   * заголовков. Отдельная зависимость ради пяти строк — это ещё один
   * пакет в цепочке поставки и ещё одно обновление раз в квартал.
   *
   * `no-store` важнее прочего: гость ходит по личному токену В АДРЕСЕ,
   * и ответ, осевший в кеше промежуточного узла, — это чужие данные,
   * выданные следующему за тем же адресом. */
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    // Токен гостя стоит в адресе: без этого он уедет в Referer чужому сайту.
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    reply.header('Cache-Control', 'no-store')
    if (config.env === 'production' && request.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
  })

  // Схемы контракта — тот же документ, что и openapi.yaml, а не вторая копия
  // правил рядом. Обработчик пишет ref('Wedding'), и при правке контракта
  // валидатор меняется вместе с ним.
  app.addSchema(CONTRACT_SCHEMAS)

  // Раньше базы и маршрутов: падение при старте — тоже инцидент.
  registerSentry(app, config)

  await registerDb(app, config)
  await registerRedis(app, config)
  await app.register(websocket)
  // Ограничитель ставится ДО маршрутов и до разбора тела: смысл в том,
  // чтобы поток запросов не доходил до работы, а не в том, чтобы
  // отказывать после неё.
  await registerRateLimit(app, config)

  /* Один хаб на процесс. Если Redis есть, событие идёт через него: за
   * балансировщиком процессов несколько, и без общего канала сообщение
   * доходило бы только тем, кто попал на тот же сервер. */
  const realtime = new RealtimeHub()
  app.decorate('realtime', realtime)
  if (app.redis) {
    // Подписчику нужен ОТДЕЛЬНЫЙ клиент: соединение в режиме подписки
    // обычных команд больше не принимает.
    const subscriber = app.redis.duplicate()
    subscriber.on('error', (err: Error) => app.log.error({ err }, 'redis подписка'))
    realtime.bridge(app.redis, subscriber)
    app.addHook('onClose', async () => {
      await subscriber.quit()
    })
  }
  await registerAuth(app, config)

  /* Тиль (фича 010): модель — из конфигурации или подставная из теста; без
   * неё служба отвечает честной заглушкой. Остановка сервера дожидается
   * фоновых ответов — иначе реплика Тиля терялась бы вместе с процессом. */
  const tillyModel = services.tillyModel === undefined ? createTillyModel(config.tilly, app.log) : services.tillyModel
  app.decorate('tilly', new TillyService(app, tillyModel, config.tilly))
  if (!tillyModel) app.log.warn('TILLY_PROVIDER не задан — Тиль отвечает без ИИ честной заглушкой (см. .env.example)')
  else app.log.info({ provider: tillyModel.provider, model: tillyModel.model }, 'Тиль: модель подключена')
  app.addHook('onClose', async () => {
    await app.tilly.settle()
  })

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
    /* Отказы Fastify на разборе тела — своими кодами и по-русски.
     *
     * `FST_ERR_CTP_BODY_TOO_LARGE` и «Request body is too large» уходили
     * клиенту как есть: фронт показывает `message` человеку, а `code`
     * разбирает по своему словарю, в котором внутренних кодов Fastify нет. */
    const parsed = BODY_PARSE_ERRORS[error.code ?? '']
    if (parsed) return reply.code(parsed.status).send(toErrorBody(parsed.code, parsed.message))
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

  /**
   * NUL-байт (`\u0000`) — единственный символ, который PostgreSQL не принимает
   * ни в одной текстовой колонке: драйвер отвечает «invalid byte sequence»,
   * обработчик переводит это в 500 и пишет в лог как о падении сервера.
   * Прилететь он может откуда угодно — телом, строкой запроса, сегментом
   * адреса (`/rsvp/a%00b`), и ни одна схема поля его не отсекает: для JSON
   * Schema это обычная строка. Одна проверка на входе вместо шаблона
   * в каждом из трёхсот строковых полей (R-111: формат проверяется ДО базы).
   */
  app.addHook('preValidation', async (request) => {
    const hasNul = (value: unknown): boolean => {
      if (typeof value === 'string') return value.includes('\u0000')
      if (Array.isArray(value)) return value.some(hasNul)
      /* Ключи обходятся наравне со значениями: там, где объект — это словарь,
       * слово стоит именно КЛЮЧОМ (`synonyms` в справочнике категорий), и такое
       * тело доходило до `insert` и падало 500-й в обход этого сторожа. */
      if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).some(
          ([key, item]) => key.includes('\u0000') || hasNul(item),
        )
      }
      return false
    }
    if (hasNul(request.params) || hasNul(request.query) || hasNul(request.body)) {
      throw new AppError(422, 'invalid_character', 'В запросе недопустимый символ (NUL)')
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
  // Редакция политики — до входа: галочку согласия человек видит раньше токенов.
  await app.register(legalRoutes)
  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(geoRoutes)
  await app.register(weddingRoutes)
  await app.register(inviteRoutes)
  await app.register(inspirationRoutes)
  await app.register(catalogRoutes)
  await app.register(vendorRoutes)
  await app.register(slotRoutes)
  await app.register(dealRoutes)
  await app.register(budgetRoutes)
  await app.register(paymentScheduleRoutes)
  await app.register(documentRoutes)
  await app.register(weddingLifecycleRoutes)
  await app.register(guestRoutes)
  await app.register(dayRoutes)
  await app.register(giftRoutes)
  await app.register(chatRoutes)
  await app.register(notificationRoutes)
  await app.register(noteRoutes)
  await app.register(dayxRoutes)
  await app.register(realtimeRoutes)
  await app.register(vendorCabinetRoutes)
  await app.register(reviewRoutes)
  await app.register(adminRoutes)
  for (const routes of extraRoutes) await app.register(routes)
  await app.register(makeNotImplementedRoutes(taken))
  await registerJobs(app)

  return app
}
