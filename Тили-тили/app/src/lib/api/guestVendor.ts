import { api, url } from './client'

/*
 * Свой подрядчик слота — без регистрации, по ссылке из приглашения.
 *
 * Пара приглашает уже знакомого им подрядчика в свой слот отдельной ссылкой
 * (`POST /weddings/{weddingId}/slots/{slotId}/external/invite`, `Wedding.tsx`,
 * карточка «Пригласить в приложение»). Подрядчик открывает её без аккаунта —
 * его опознаёт токен в самой ссылке, как гостя. Экран (`pages/GuestVendor.tsx`)
 * видит только дату свадьбы, свой слот, назначенную программу и чат с парой
 * (план §11) — ни гостей, ни бюджета, ни остальной команды здесь нет.
 */

/** Кабинет гостя-подрядчика: дата свадьбы, слот, срок мягкой брони, тайминг дня. 410 — ссылка истекла или отозвана. */
export const getGuestVendor = (token: string) =>
  api.get(url('/guest-vendor/{token}', { token }), { auth: false })

export const getExternalProgram = (token: string) =>
  api.getSnapshot(url('/guest-vendor/{token}/timeline', { token }), { auth: false })

export const acknowledgeExternalProgram = (token: string, readToken: string, etag: string) =>
  api.post(url('/guest-vendor/{token}/timeline/ack', { token }), { readToken }, { auth: false, ifMatch: etag })

/** Переписка своего подрядчика с парой; `cursor` — курсор следующей страницы (контракт: `nextCursor`). */
export const getGuestVendorMessages = (token: string, cursor?: string) =>
  api.get(`${url('/guest-vendor/{token}/messages', { token })}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}` as '/guest-vendor/{token}/messages', { auth: false })

/*
 * Написать паре. Контракт не объявляет `Idempotency-Key` для этого пути (в
 * отличие от `joinShuttle`/`bookHotelRoom` в `lib/api/guest.ts`) — повторный
 * тап на плохой связи в худшем случае дублирует одну реплику, а не бронь или
 * платёж, поэтому ключ здесь не нужен и не посылается.
 */
export const postGuestVendorMessage = (token: string, text: string) =>
  api.post(url('/guest-vendor/{token}/messages', { token }), { text }, { auth: false })
