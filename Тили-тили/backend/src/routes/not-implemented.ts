import type { FastifyInstance } from 'fastify'
import { CONTRACT_OPERATIONS } from '../contract/paths.generated.js'
import { notImplemented } from '../errors.js'

/**
 * Заглушки на всё, что описано в контракте, но ещё не написано.
 *
 * Смысл не в вежливости, а в различимости: 404 значит «такого адреса нет
 * и не будет» — фронт по нему ищет опечатку в своём коде. 501 значит «адрес
 * согласован, обработчика пока нет» — фронт ждёт этап из плана. Пока разница
 * не проведена, каждая ошибка фронта выглядит как отставание бэкенда.
 *
 * Регистрируется ПОСЛЕ настоящих маршрутов; уже занятые пары метод+путь
 * пропускаются, поэтому реализованный эндпоинт заглушку не получает.
 */
export function makeNotImplementedRoutes(taken: ReadonlySet<string>) {
  return async function notImplementedRoutes(app: FastifyInstance): Promise<void> {
    for (const op of CONTRACT_OPERATIONS) {
      if (taken.has(`${op.method} ${op.url}`)) continue
      app.route({
        method: op.method as 'GET',
        url: op.url,
        handler: async () => {
          throw notImplemented(op.operationId ?? `${op.method} ${op.openapi}`)
        },
      })
    }
  }
}

export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`
}
