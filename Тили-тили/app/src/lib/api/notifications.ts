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
export function notificationRoute(link?: string | null, opts: { vendor?: boolean } = {}): string | null {
  if (!link) return null
  const vendor = !!opts.vendor
  const chat = /^\/chats\/([\w-]+)$/.exec(link)
  if (chat) return `/us/chats/${chat[1]}`
  /* У подрядчика экрана одной сделки нет — его сделки списком в кабинете.
     Раньше подрядчика вели на `/deal/{id}` пары, где ему показывалось
     «сделка не найдена» (аудит 2026-09-07, блок 8). */
  const deal = /^\/deal\/([\w-]+)$/.exec(link)
  if (deal) return vendor ? '/vendor-app/deals' : `/deal/${deal[1]}`
  if (link === '/guests') return vendor ? null : '/wedding/guests'
  if (link === '/checklist') return vendor ? null : '/wedding/checklist'
  if (link === '/dayx') return vendor ? '/vendor-app' : '/dayx'
  /* Перенос даты (`/wedding`) и обновления кабинета (`/vendor-app`) сервер
     шлёт с блока 2 — без перевода уведомление некуда было вести. */
  if (link === '/wedding') return vendor ? '/vendor-app' : '/wedding'
  if (link === '/vendor-app') return '/vendor-app'
  /* `/deal` без идентификатора приходит от старых записей: конкретную сделку
     по нему не открыть, поэтому ведём в мозаику — там все сделки видны. */
  if (link === '/deal') return vendor ? '/vendor-app/deals' : '/wedding'
  return null
}
