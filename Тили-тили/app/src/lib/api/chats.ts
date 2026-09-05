import { accessTokenForWs, api, url } from './client'

/*
 * Чаты: список, история, отправка, «печатает…» и живой канал.
 *
 * До этого переписка жила в `tt_chat_{id}` браузера, а собеседник был
 * таймером: через 1,6 секунды после отправки экран сам дописывал «Отлично,
 * принято! Отвечу подробно чуть позже сегодня 🙌». Человек был уверен, что
 * подрядчик ответил, — и ждал того, чего не было.
 *
 * Доставка идёт двумя путями. Живой канал (WebSocket) отдаёт события сразу;
 * если его нет — Redis не поднят, сеть режет соединение, вкладка в фоне —
 * клиент опрашивает историю раз в 30 секунд (§13.4). Отправка в обоих
 * случаях обычным POST: канал только доставляет.
 */

export const getChats = () => api.get('/chats')

/** Последние сообщения чата. `423` — чат ещё закрыт (день X до срока). */
export const getMessages = (chatId: string, limit = 50) =>
  api.get(`${url('/chats/{chatId}/messages', { chatId })}?limit=${limit}` as '/chats/{chatId}/messages')

export const sendMessage = (chatId: string, text: string) =>
  api.post(url('/chats/{chatId}/messages', { chatId }), { text })

/**
 * «Печатает…» — событие без записи: живёт секунды и никуда не сохраняется.
 * Отправляется обычным запросом, чтобы работать и без живого канала.
 */
export const sendTyping = (chatId: string) =>
  api.post(url('/chats/{chatId}/typing', { chatId }), {})

/** «Написать» подрядчику: чат создаётся один на пару и подрядчика. */
export const openVendorChat = (vendorId: string) =>
  api.post(url('/chats/vendor/{vendorId}', { vendorId }), {})

export interface ChatEvent {
  type: 'message' | 'typing' | 'error'
  chatId?: string
  actorId?: string
  status?: number
  code?: string
}

/**
 * Живой канал чата.
 *
 * Токен уходит строкой запроса: браузерный WebSocket заголовки ставить не
 * умеет — так устроен протокол, и контракт это оговаривает отдельно.
 *
 * Возвращает функцию закрытия. Отказы приходят внутрь соединения событием
 * `error` и закрывают его: клиент должен понимать разницу между «ссылка
 * устарела» и «сеть барахлит», иначе он переподключается бесконечно.
 */
export function openChatSocket(chatId: string, onEvent: (e: ChatEvent) => void): () => void {
  const token = accessTokenForWs()
  if (!token || typeof WebSocket === 'undefined') return () => undefined

  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api'
  const httpUrl = new URL(`${base}/chats/${chatId}/ws`, window.location.origin)
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  httpUrl.searchParams.set('token', token)

  let socket: WebSocket | null = null
  try {
    socket = new WebSocket(httpUrl.toString())
  } catch {
    /* Небезопасный адрес или заблокированный протокол — остаётся опрос. */
    return () => undefined
  }

  socket.onmessage = (e: MessageEvent<string>) => {
    try { onEvent(JSON.parse(e.data) as ChatEvent) } catch { /* чужой формат — не наше дело */ }
  }

  const s = socket
  return () => {
    s.onmessage = null
    try { s.close() } catch { /* уже закрыт */ }
  }
}

/**
 * Открыть переписку с подрядчиком и получить адрес её экрана.
 *
 * Кнопка «Написать» стоит в четырёх местах — карточка каталога, слот команды,
 * экран сделки и сравнение. Раньше все они вели на выдуманный `ch1`; теперь
 * путь один: чат создаётся (или находится) на сервере, и человек попадает
 * именно в свою переписку.
 *
 * У своего подрядчика (§11) идентификатора в каталоге нет, и открыть чат по
 * нему нельзя: возвращаем список чатов — его переписка там строкой.
 */
export async function chatRouteForVendor(vendorId?: string | null): Promise<string> {
  if (!vendorId) return '/us/chats'
  const chat = await openVendorChat(vendorId)
  return chat?.id ? `/us/chats/${chat.id}` : '/us/chats'
}

/** Чат дня X: он один, и адрес его знает только сервер. */
export async function dayChatRoute(): Promise<string> {
  const chats = await getChats()
  const day = (chats ?? []).find(c => c.kind === 'day')
  return day?.id ? `/us/chats/${day.id}` : '/us/chats'
}

/** Командный чат свадьбы: пара, помощники и забронированные подрядчики. */
export async function teamChatRoute(): Promise<string> {
  const chats = await getChats()
  const team = (chats ?? []).find(c => c.kind === 'team')
  return team?.id ? `/us/chats/${team.id}` : '/us/chats'
}
