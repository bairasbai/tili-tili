import { api, url } from './client'

/*
 * Центр уведомлений.
 *
 * Экран был витриной из пяти выдуманных строк: «Артём Краснов получил
 * 30 000 ₽», «Ольга и Денис Соколовы подтвердили приезд с +1», «Студия
 * «Пион»: мягкая бронь истекает через 12 часов». Ни одного из этих людей не
 * существовало, а «прочитано» копилось в `tt_notif_read` номерами строк —
 * на другом устройстве всё снова горело непрочитанным.
 *
 * Теперь список ведёт сервер: он же решает, что критично, а что ждёт конца
 * тихих часов (§18.6).
 */

export const getNotifications = () => api.get('/notifications')

export const markNotificationRead = (id: string) =>
  api.post(url('/notifications/{id}/read', { id }), {})

/**
 * Куда ведёт уведомление.
 *
 * Сервер называет место смыслом, а не маршрутом приложения: `/deal/{id}`,
 * `/guests`, `/checklist`, `/chats/{id}`, `/dayx`. У пары и у подрядчика эти
 * места лежат по разным адресам, поэтому перевод — дело клиента.
 *
 * Незнакомый адрес — не повод никуда вести: `null` значит «просто отметить
 * прочитанным». Пускать человека по адресу, которого в приложении нет, хуже,
 * чем не пускать никуда: он попадёт на «страница не найдена».
 */
export function notificationRoute(link?: string | null): string | null {
  if (!link) return null
  const chat = /^\/chats\/([\w-]+)$/.exec(link)
  if (chat) return `/us/chats/${chat[1]}`
  const deal = /^\/deal\/([\w-]+)$/.exec(link)
  if (deal) return `/deal/${deal[1]}`
  if (link === '/guests') return '/wedding/guests'
  if (link === '/checklist') return '/wedding/checklist'
  if (link === '/dayx') return '/dayx'
  /* `/deal` без идентификатора приходит от старых записей: конкретную сделку
     по нему не открыть, поэтому ведём в мозаику — там все сделки видны. */
  if (link === '/deal') return '/wedding'
  return null
}
