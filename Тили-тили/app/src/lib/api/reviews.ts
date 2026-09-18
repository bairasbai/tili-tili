import { api, url } from './client'

/*
 * Отзывы о подрядчиках — сторона пары.
 *
 * Отзыв гостя и отзыв пары — разные вещи и живут по разным путям: у пары
 * договор, у гостя впечатление (§15), и в рейтинге у них разный вес. Пара
 * читает отзывы своих гостей анонимно: сервер не отдаёт ни имени, ни токена.
 *
 * Раньше обе стороны лежали в браузере: свои оценки — в `tt_after_stars`,
 * гостевые — в `tt_guest_reviews` с пятью выдуманными записями. До подрядчика
 * не доходила ни одна, а «отзывы гостей» пара читала собственные же моки.
 */

/** Что написали гости об этой свадьбе. Автора здесь нет и быть не может. */
export const getGuestReviews = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/guest-reviews', { weddingId }))

/**
 * Публичная лента отзывов подрядчика.
 *
 * У отзыва есть источник: пара со сделкой или гость свадьбы (§15) — вес в
 * рейтинге у них разный, и смешивать их нельзя. Скрытые модератором сюда не
 * попадают.
 *
 * Раньше на карточке любого подрядчика стояли три написанных в коде отзыва —
 * «Гульнара и Тимур», «Дина и Руслан» и «Гость свадьбы Алины и Тимура» — с
 * пометкой «сделка через «Тили-тили» — отзыв подтверждён». Это худший вид
 * выдумки: поддельный знак доверия на карточке живого человека.
 *
 * `cursor` — из `nextCursor` прошлой страницы: лента листается, а не
 * обрывается на десяти. «47 отзывов» при десяти видимых и без кнопки «ещё»
 * — ревью D5-26а.
 */
export const getVendorReviews = (vendorId: string, limit = 10, cursor?: string | null) =>
  api.get(
    `${url('/catalog/vendors/{vendorId}/reviews', { vendorId })}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` as '/catalog/vendors/{vendorId}/reviews',
  )

/**
 * Отзыв пары о подрядчике.
 *
 * Право на него даёт завершённая сделка, и проверяет это сервер: у сделки
 * должно быть состояние `done`, а с момента завершения — не больше отведённого
 * окна. Текст обязателен: звёзды без слов подрядчику ничего не объясняют.
 */
export const sendCoupleReview = (vendorId: string, rating: number, text: string) =>
  api.post(url('/catalog/vendors/{vendorId}/reviews', { vendorId }), { rating, text })

/** На что жалуются (§18.2): анкета, отзыв, сообщение в чате, сделка (спор). */
export type ComplaintTarget = 'vendor' | 'review' | 'message' | 'deal'
/** Причина — из четырёх, которые знает модерация; свободный текст — отдельно. */
export type ComplaintCategory = 'fraud' | 'content' | 'no_show' | 'spam'

/**
 * Жалоба модерации (`POST /complaints`, §18.2). Сервер отвечает 201 и на
 * повтор по той же цели: человек нажал ещё раз, а не подал вторую жалобу.
 * До сверки планов 2026-09-18 путь был на сервере, а кнопки в приложении не
 * было ни одной — очередь `/admin/complaints` стояла без источника.
 */
export const sendComplaint = (targetKind: ComplaintTarget, targetId: string, category: ComplaintCategory, text?: string) =>
  api.post('/complaints', { targetKind, targetId, category, ...(text?.trim() ? { text: text.trim() } : {}) })
