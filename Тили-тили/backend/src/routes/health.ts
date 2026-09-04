import type { FastifyInstance } from 'fastify'

/**
 * Два разных вопроса, поэтому два разных адреса.
 *
 * /health       — процесс жив. Всегда 200. По нему перезапускают контейнер:
 *                 если ронять его из-за упавшей базы, приложение уйдёт в цикл
 *                 перезапусков и не поднимется, даже когда база вернётся.
 * /health/ready — можно ли слать трафик. 503, если база или Redis недоступны.
 *                 По нему балансировщик выводит машину из ротации.
 *
 * В контракте пути есть, хотя они и не часть продукта: фронт спрашивает
 * /health, чтобы отличить «нет сети» от «сервер лежит» — при живом Wi-Fi
 * navigator.onLine говорит «онлайн», а приложение показывает пустоту.
 * Раз путь вызывается из клиента, он идёт через тот же типизированный слой
 * запросов, что и остальные, а слой знает только пути контракта.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }))

  app.get('/health/ready', async (_request, reply) => {
    const db = app.db ? await app.db.ping() : false
    // Только 'ready'. 'connecting' — это ещё не работает: отдать по нему 200
    // значит впустить трафик на машину, которая на первой же команде упадёт.
    const redis = app.redis ? app.redis.status === 'ready' : false
    const ready = db && redis
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      db: db ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
    })
  })
}
