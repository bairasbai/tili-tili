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

/** Задержка перед новой попыткой подключиться. */
const RECONNECT_MS = 3000

/**
 * Живой канал чата.
 *
 * Токен уходит строкой запроса: браузерный WebSocket заголовки ставить не
 * умеет — так устроен протокол, и контракт это оговаривает отдельно.
 *
 * **Канал недолговечен по устройству.** Сервер закрывает соединение вместе с
 * истечением токена (15 минут): открытый сокет не должен переживать право
 * доступа. Значит обрыв — это норма, а не авария, и клиент обязан
 * переподключаться сам. Без этого чат, открытый дольше пятнадцати минут,
 * тихо оставался бы на одном опросе, продолжая писать «связь живая».
 *
 * `onStatus` сообщает, есть ли канал прямо сейчас: экран показывает это
 * человеку, а не гадает. Возвращённая функция закрывает канал насовсем —
 * после неё попыток переподключения нет.
 */
export function openChatSocket(
  chatId: string,
  onEvent: (e: ChatEvent) => void,
  onStatus?: (live: boolean) => void,
): () => void {
  if (typeof WebSocket === 'undefined') return () => undefined

  let closedByUs = false
  let socket: WebSocket | null = null
  let retry: number | undefined

  const connect = () => {
    if (closedByUs) return
    const token = accessTokenForWs()
    if (!token) return

    const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api'
    const httpUrl = new URL(`${base}/chats/${chatId}/ws`, window.location.origin)
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    httpUrl.searchParams.set('token', token)

    try {
      socket = new WebSocket(httpUrl.toString())
    } catch {
      /* Небезопасный адрес или заблокированный протокол — остаётся опрос. */
      onStatus?.(false)
      return
    }

    socket.onopen = () => onStatus?.(true)
    socket.onmessage = (e: MessageEvent<string>) => {
      try { onEvent(JSON.parse(e.data) as ChatEvent) } catch { /* чужой формат — не наше дело */ }
    }
    socket.onclose = () => {
      onStatus?.(false)
      if (closedByUs) return
      /* Токен к этому времени уже обновлён обычными запросами: опрос истории
         идёт своим чередом и продлевает сессию. Берём его заново при каждой
         попытке — старый закрыли именно потому, что он истёк. */
      retry = window.setTimeout(connect, RECONNECT_MS)
    }
  }

  connect()

  return () => {
    closedByUs = true
    if (retry) window.clearTimeout(retry)
    const s = socket
    if (!s) return
    s.onmessage = null
    s.onclose = null
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
