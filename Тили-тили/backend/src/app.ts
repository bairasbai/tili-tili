import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { loadConfig, type Config } from './config.js'
import { AppError, toErrorBody } from './errors.js'
import { registerDb } from './plugins/db.js'
import { registerRedis } from './plugins/redis.js'
import { CONTRACT_SCHEMAS } from './contract/schemas.generated.js'
import { healthRoutes } from './routes/health.js'
import { makeNotImplementedRoutes, routeKey } from './routes/not-implemented.js'

export async function buildApp(overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...overrides }

  const app = Fastify({
    logger: config.env === 'test' ? false : { level: config.env === 'production' ? 'info' : 'debug' },
    // Идентификатор запроса попадает и в лог, и в тело ошибки 500 — по нему
    // жалоба пользователя находится в логах за один grep.
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    bodyLimit: 1_048_576,
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

  // Всё, что нельзя разобрать, обязано выглядеть одинаково — иначе фронт
  // разбирает три разных формы ошибки вместо одной.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
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

  await app.register(healthRoutes)
  await app.register(makeNotImplementedRoutes(taken))

  return app
}
