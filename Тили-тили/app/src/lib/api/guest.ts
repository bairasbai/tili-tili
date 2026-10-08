import { api, ApiError, newIdempotencyKey, url } from './client'
import { safeGet, safeSet } from '../usePersist'
import { acceptGuestDayRead, guestDayGeneration, guestDayIsCurrent, guestDayTokenChanged, refuseGuestDay, rememberGuestDay } from '../guestDayOffline'

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
  const previous = guestToken()
  safeSet(TOKEN_KEY, token ?? '')
  guestDayTokenChanged(previous, guestToken())
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
  const res = await api.get(url('/invite/{shareCode}', { shareCode }), { auth: false })
  if (res?.guestToken) saveGuestToken(res.guestToken)
  return { guestName: res?.guestName, wedding: res?.wedding }
}

/** Страница гостя: имя, свадьба и его текущий ответ. */
function assertGuestReadCurrent(token: string, generation: number, active: boolean): void {
  if (active && !guestDayIsCurrent(token, generation)) throw new ApiError('http', 410, 'guest_link_changed', 'Ссылка больше не действует')
}

function refuseGuestCopy(token: string, generation: number, error: unknown): void {
  if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status) && guestDayIsCurrent(token, generation)) refuseGuestDay(token, error)
}

export async function getRsvp(token: string) {
  const generation = guestDayGeneration()
  const active = guestToken() === token
  try {
    const page = await api.get(url('/rsvp/{guestToken}', { guestToken: token }), { auth: false, assertCurrent: () => assertGuestReadCurrent(token, generation, active) })
    return page
  } catch (error) { refuseGuestCopy(token, generation, error); throw error }
}

/** Еда и трансфер гостя — то, что он сам сообщает в RSVP (контракт v0.24). */
export interface RsvpExtra {
  diet?: string | null
  dietNote?: string
  transfer?: 'need' | 'own'
}

export interface FamilyRsvpMember {
  guestId: string
  status: 'yes' | 'no'
  diet?: string | null
  dietNote?: string | null
  transfer?: 'need' | 'own' | null
}

/** 020: отдельный ответ каждой персоны одной семейной ссылки. */
export const sendFamilyRsvp = (token: string, members: FamilyRsvpMember[]) =>
  api.post(url('/rsvp/{guestToken}', { guestToken: token }), { members })

/** Ответ гостя. `plusOne` — приедет ли он с парой; `extra` — еда и трансфер. */
export const sendRsvp = (token: string, status: 'yes' | 'no', plusOne?: boolean, comment?: string, extra: RsvpExtra = {}) =>
  api.post(url('/rsvp/{guestToken}', { guestToken: token }), {
    status,
    ...(plusOne !== undefined ? { plusOne } : {}),
    ...(comment ? { comment } : {}),
    ...(extra.diet !== undefined ? { diet: extra.diet } : {}),
    ...(extra.dietNote ? { dietNote: extra.dietNote } : {}),
    ...(extra.transfer ? { transfer: extra.transfer } : {}),
  })

/** Отельные блоки, доступные гостю. */
export const getGuestHotels = (token: string) =>
  api.get(url('/join/{guestToken}/hotels', { guestToken: token }))

/*
 * Место в автобусе и номер в отеле занимаются атомарно: при переполнении
 * сервер отвечает 409. Ключ идемпотентности обязателен — без него повторное
 * нажатие на плохой связи занимает два места одному человеку.
 */
export const joinShuttle = (token: string, busId: string, guestId?: string) =>
  api.post(
    url('/join/{guestToken}/shuttle', { guestToken: token }),
    { busId, ...(guestId ? { guestId } : {}) },
    { idempotencyKey: newIdempotencyKey() },
  )

export const bookHotelRoom = (token: string, hotelId: string) =>
  api.post(url('/join/{guestToken}/hotels', { guestToken: token }), { hotelId }, { idempotencyKey: newIdempotencyKey() })

/** Выбор горячего в опросе меню. */
export const voteMenu = (token: string, optionId: string, guestId?: string) =>
  api.post(
    url('/join/{guestToken}/menu-vote', { guestToken: token }),
    { optionId, ...(guestId ? { guestId } : {}) },
  )

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

/*
 * День X глазами гостя (фича 009, контракт v0.32.0).
 *
 * Одним запросом всё, что нужно гостю в день свадьбы: программа (только блоки,
 * которые пара пометила «для гостей»), адрес и дресс-код, свой стол, свой
 * автобус с перевозчиком, координатор с телефоном и окно чата дня. Телефона
 * пары здесь нет — «звонить координатору, не жениху» (План §8.8). 410 —
 * ссылка отозвана.
 */
export async function getGuestDaySnapshot(token: string) {
  const generation = guestDayGeneration()
  const active = guestToken() === token
  try {
    const snapshot = await api.getSnapshot(url('/join/{guestToken}/day', { guestToken: token }), { auth: false, assertCurrent: () => assertGuestReadCurrent(token, generation, active) })
    acceptGuestDayRead(token, generation)
    await rememberGuestDay(token, snapshot.data, snapshot.etag, generation)
    assertGuestReadCurrent(token, generation, active)
    return snapshot
  } catch (error) { refuseGuestCopy(token, generation, error); throw error }
}

/** Existing callers retain the body-only result. */
export const getGuestDay = async (token: string) => (await getGuestDaySnapshot(token)).data

/**
 * Хвост чата дня X по токену гостя — та же лента, что у пары и команды.
 * Вне окна (с 09:00 кануна по конец дня после свадьбы) сервер отвечает 423
 * `chat_closed_for_guests`, и его текст годится на экран как есть.
 */
export const getGuestDayMessages = (token: string, limit = 50) =>
  api.get(`${url('/join/{guestToken}/day-chat/messages', { guestToken: token })}?limit=${limit}` as '/join/{guestToken}/day-chat/messages')

/** Реплика гостя в общий чат дня: сервер подписывает её именем гостя (`guestName`). */
export const postGuestDayMessage = (token: string, text: string) =>
  api.post(url('/join/{guestToken}/day-chat/messages', { guestToken: token }), { text })
