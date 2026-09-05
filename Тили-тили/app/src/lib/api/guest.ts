import { api, newIdempotencyKey, url } from './client'
import { safeGet, safeSet } from '../usePersist'

/*
 * Гость без аккаунта.
 *
 * Гость не входит в приложение и членом свадьбы не является: его опознаёт
 * персональный токен, полученный по ссылке из приглашения. Поэтому здесь свой
 * слой запросов — он ходит по путям `/rsvp/{token}` и `/join/{token}/…`,
 * которым заголовок `Authorization` не нужен и не помогает.
 *
 * Обмен происходит один раз: пара присылает одноразовый код, браузер меняет
 * его на токен, код гаснет. Повторный переход по той же ссылке отдаёт 410 —
 * и это не поломка, а защита: ссылка, попавшая в общий чат, не пустит второго.
 */

const TOKEN_KEY = 'tt_guest_token'

/** Токен этого гостя на этом устройстве. Null — ссылку ещё не открывали. */
export function guestToken(): string | null {
  return safeGet(TOKEN_KEY)
}

export function saveGuestToken(token: string | null): void {
  safeSet(TOKEN_KEY, token ?? '')
}

export interface GuestWedding {
  title?: string
  date?: string | null
  city?: { name?: string; region?: string }
  inviteText?: string
  inviteThemeId?: number
  venue?: string | null
}

/**
 * Обменять код из ссылки на постоянный токен гостя.
 *
 * Код одноразовый: сервер гасит его в этот же момент. Токен возвращается
 * ровно один раз, поэтому сохраняем его сразу — иначе гость, закрывший
 * вкладку, потеряет доступ к своей странице навсегда.
 */
export async function redeemInvite(shareCode: string): Promise<{ guestName?: string; wedding?: GuestWedding }> {
  const res = await api.get(url('/invite/{shareCode}', { shareCode }))
  if (res?.guestToken) saveGuestToken(res.guestToken)
  return { guestName: res?.guestName, wedding: res?.wedding }
}

/** Страница гостя: имя, свадьба и его текущий ответ. */
export const getRsvp = (token: string) =>
  api.get(url('/rsvp/{guestToken}', { guestToken: token }))

/** Ответ гостя. `plusOne` — приедет ли он с парой. */
export const sendRsvp = (token: string, status: 'yes' | 'no', plusOne?: boolean, comment?: string) =>
  api.post(url('/rsvp/{guestToken}', { guestToken: token }), {
    status,
    ...(plusOne !== undefined ? { plusOne } : {}),
    ...(comment ? { comment } : {}),
  })

/** Отельные блоки, доступные гостю. */
export const getGuestHotels = (token: string) =>
  api.get(url('/join/{guestToken}/hotels', { guestToken: token }))

/*
 * Место в автобусе и номер в отеле занимаются атомарно: при переполнении
 * сервер отвечает 409. Ключ идемпотентности обязателен — без него повторное
 * нажатие на плохой связи занимает два места одному человеку.
 */
export const joinShuttle = (token: string, busId: string) =>
  api.post(url('/join/{guestToken}/shuttle', { guestToken: token }), { busId }, { idempotencyKey: newIdempotencyKey() })

export const bookHotelRoom = (token: string, hotelId: string) =>
  api.post(url('/join/{guestToken}/hotels', { guestToken: token }), { hotelId }, { idempotencyKey: newIdempotencyKey() })

/** Выбор горячего в опросе меню. */
export const voteMenu = (token: string, optionId: string) =>
  api.post(url('/join/{guestToken}/menu-vote', { guestToken: token }), { optionId })

/** Маршруты трансфера и место, которое гость уже занял. */
export const getGuestShuttle = (token: string) =>
  api.get(url('/join/{guestToken}/shuttle', { guestToken: token }))

/** Опрос по горячему: вопрос, варианты и выбор самого гостя. */
export const getGuestMenu = (token: string) =>
  api.get(url('/join/{guestToken}/menu-vote', { guestToken: token }))

/** Кто работал на свадьбе: нужен, чтобы гость выбрал, кого оценивает. */
export const getGuestTeam = (token: string) =>
  api.get(url('/join/{guestToken}/team', { guestToken: token }))

/**
 * Отзыв гостя о подрядчике.
 *
 * Токен идёт параметром строки запроса — так описан этот путь в контракте
 * (у него нет заголовка авторизации вовсе). Один отзыв на подрядчика: повтор
 * редактирует прежний, а не заводит второй.
 */
export const sendGuestReview = (weddingId: string, token: string, vendorId: string, stars: number, text?: string) =>
  api.post(
    `${url('/weddings/{weddingId}/guest-reviews', { weddingId })}?guestToken=${encodeURIComponent(token)}` as '/weddings/{weddingId}/guest-reviews',
    { vendorId, stars, ...(text ? { text } : {}) },
  )
