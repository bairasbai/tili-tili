import type { FastifyInstance } from 'fastify'
import { AppError, unauthorized } from '../errors.js'
import { chatForUser, assertOpen } from '../chats/access.js'

/**
 * Живой канал чата.
 *
 * Токен приходит СТРОКОЙ ЗАПРОСА, а не заголовком: браузерный WebSocket
 * заголовки ставить не умеет. Значит, он попадает в адрес — и маскируется
 * в логе наравне с гостевыми токенами (ERR-0050).
 */
export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.route({
    method: 'GET',
    url: '/chats/:chatId/ws',
    /* Обычный GET без апгрейда — 426, а не 404.
     *
     * Путь в контракте есть, и 404 сказал бы «такого адреса нет», отправив
     * клиента искать опечатку вместо заголовка Upgrade. */
    handler: async (_request, reply) =>
      reply
        .code(426)
        .header('upgrade', 'websocket')
        .send({ error: { code: 'upgrade_required', message: 'Этот путь работает только по WebSocket' } }),
    wsHandler: async (socket, request) => {
    const { chatId } = request.params as { chatId: string }
    const { token } = request.query as { token?: string }

    try {
      if (!token) throw unauthorized('Нужен токен доступа в параметре token')
      // Те же проверки, что и у обычного запроса: живая сессия и согласие
      // на ПДн. Своя копия проверок разошлась бы с основной на первой правке.
      const claims = await app.authorizeToken(token)
      const { chat } = await chatForUser(db(), chatId, claims.sub)
      assertOpen(chat)

      // Хаб запоминает, чьё соединение: своё «печатает» автору не доставляется.
      app.realtime.join(chatId, socket, claims.sub)

      /* Соединение не должно переживать токен.
       *
       * Открытый сокет живёт часами, а токен — 15 минут. Без этого помощник,
       * которого пара только что убрала из команды, продолжал бы читать чат,
       * пока не закроет вкладку. Клиент переподключается со свежим токеном —
       * это его обычный цикл, а не ошибка. */
      const msLeft = claims.exp * 1000 - Date.now()
      const expiry = setTimeout(() => {
        socket.send(JSON.stringify({ type: 'error', status: 401, code: 'token_expired' }))
        socket.close(4401)
      }, Math.max(msLeft, 0))

      socket.on('close', () => {
        clearTimeout(expiry)
        app.realtime.leave(chatId, socket)
      })
      socket.send(JSON.stringify({ type: 'ready', chatId, expiresAt: new Date(claims.exp * 1000).toISOString() }))
    } catch (error) {
      /* Отказ приходит в самом соединении и закрывает его с кодом.
       * Молча оборвать рукопожатие значило бы «сеть барахлит» вместо
       * «ссылка устарела»: клиент будет переподключаться бесконечно. */
      const status = error instanceof AppError ? error.statusCode : 500
      const code = error instanceof AppError ? error.code : 'internal'
      socket.send(JSON.stringify({ type: 'error', status, code }))
      // 4000+ — пространство кодов приложения: 4401, 4403, 4404, 4423.
      socket.close(4000 + (status % 1000))
    }
    },
  })
}
