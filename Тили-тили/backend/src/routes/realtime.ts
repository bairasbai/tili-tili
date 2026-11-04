import type { FastifyInstance } from 'fastify'
import { AppError, unauthorized } from '../errors.js'
import { authorizeChatToken, withChatDeliveryAccess } from '../realtime/access.js'

/**
 * Живой канал чата.
 *
 * Токен приходит СТРОКОЙ ЗАПРОСА, а не заголовком: браузерный WebSocket
 * заголовки ставить не умеет. Значит, он попадает в адрес — и маскируется
 * в логе наравне с гостевыми токенами (ERR-0050).
 */
export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
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
    /* Комната хаба — по строке, база сравнивает uuid без регистра: адрес с
     * заглавными проходил проверки, а событий не получал (ревью 015). */
    const chatId = (request.params as { chatId: string }).chatId.toLowerCase()
    const { token } = request.query as { token?: string }
    /* Клиент мог закрыть сокет, пока шли проверки (три обращения к базе):
     * `close` уже прозвучал, слушатель ниже его не услышит, и сокет остался
     * бы в комнате навсегда — мёртвая рассылка на каждое сообщение (ревью 015). */
    let closedEarly = false
    let expiry: ReturnType<typeof setTimeout> | undefined
    socket.once('close', () => {
      closedEarly = true
      clearTimeout(expiry)
      app.realtime.leave(chatId, socket)
    })

    const reject = (error: unknown) => {
      clearTimeout(expiry)
      app.realtime.leave(chatId, socket)
      if (closedEarly || socket.readyState !== socket.OPEN) return
      const status = error instanceof AppError ? error.statusCode : 500
      const code = error instanceof AppError ? error.code : 'internal'
      try { socket.send(JSON.stringify({ type: 'error', status, code })) } catch { /* Closed while checking access. */ }
      try { socket.close(4000 + (status % 1000)) } catch { /* Already closed. */ }
    }

    try {
      if (!token) throw unauthorized('Нужен токен доступа в параметре token')
      // Те же проверки, что и у обычного запроса: живая сессия и согласие
      // на ПДн. Своя копия проверок разошлась бы с основной на первой правке.
      const { claims } = await authorizeChatToken(app, chatId, token)

      if (closedEarly) return
      // Хаб запоминает, чьё соединение: своё «печатает» автору не доставляется.
      app.realtime.join(chatId, socket, claims.sub, {
        token,
        withAccess: (currentToken, write) => withChatDeliveryAccess(app, chatId, currentToken, write),
        denied: reject,
      })

      /* Соединение не должно переживать токен.
       *
       * Открытый сокет живёт часами, а токен — 15 минут. Без этого помощник,
       * которого пара только что убрала из команды, продолжал бы читать чат,
       * пока не закроет вкладку. Клиент переподключается со свежим токеном —
       * это его обычный цикл, а не ошибка. */
      const msLeft = claims.exp * 1000 - Date.now()
      expiry = setTimeout(() => {
        reject(new AppError(401, 'token_expired', 'Срок действия токена истёк'))
      }, Math.max(msLeft, 0))

      socket.send(JSON.stringify({ type: 'ready', chatId, expiresAt: new Date(claims.exp * 1000).toISOString() }))
    } catch (error) {
      /* Отказ приходит в самом соединении и закрывает его с кодом.
       * Молча оборвать рукопожатие значило бы «сеть барахлит» вместо
       * «ссылка устарела»: клиент будет переподключаться бесконечно. */
      reject(error)
    }
    },
  })
}
