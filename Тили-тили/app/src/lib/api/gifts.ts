import { api, newIdempotencyKey, url } from './client'

/*
 * Подарки: список желаний пары и то же самое глазами гостя.
 *
 * Две стороны читают одни данные разными путями, и разница между ними — не
 * техническая, а обещание из §9: пара видит, что подарок занят, но никогда не
 * видит, кем. Поэтому у пары свой путь с авторизацией, у гостя — свой по
 * персональному токену, и поле `mine` («это мой резерв») есть только в
 * гостевом ответе.
 *
 * Резерв и складчина необратимы для чужого глаза: занятый подарок пропадает из
 * выбора остальных, а внесённая сумма уходит в общий счёт. Поэтому каждое
 * такое действие идёт с ключом идемпотентности — повтор на плохой связи не
 * должен занять два подарка или списать сумму дважды.
 */

/* ── Сторона пары ── */

/** Весь список одним ответом: подарки, денежные фонды и «просим не дарить». */
export const getWishlist = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/wishlist', { weddingId }))

export interface GiftDraft {
  name: string
  /** Цена в копейках. */
  price: number
  group?: boolean
  icon?: string
  desc?: string
}

export const addGift = (weddingId: string, draft: GiftDraft) =>
  api.post(url('/weddings/{weddingId}/wishlist', { weddingId }), {
    name: draft.name,
    price: { amount: draft.price, currency: 'RUB' },
    ...(draft.group !== undefined ? { group: draft.group } : {}),
    ...(draft.icon ? { icon: draft.icon } : {}),
    ...(draft.desc ? { desc: draft.desc } : {}),
  })

export const deleteGift = (weddingId: string, giftId: string) =>
  api.delete(url('/weddings/{weddingId}/wishlist/{giftId}', { weddingId, giftId }))

/**
 * Список «просим не дарить» заменяется целиком.
 *
 * Отдельного пути «добавить строку» контракт не знает, поэтому отправлять надо
 * весь список: пропущенная строка читается как удалённая.
 */
export const putAntiGifts = (weddingId: string, items: string[]) =>
  /* Тело — голый массив строк, а не объект с полем: так описано в контракте,
     и сервер отвечает «must be array» на обёртку. */
  api.put(url('/weddings/{weddingId}/anti-gifts', { weddingId }), items)

/** Денежный фонд: цель, к которой скидываются («на медовый месяц»). */
export const addFund = (weddingId: string, name: string, target: number, icon?: string) =>
  api.post(url('/weddings/{weddingId}/funds', { weddingId }), {
    name,
    target: { amount: target, currency: 'RUB' },
    ...(icon ? { icon } : {}),
  })

export const deleteFund = (weddingId: string, fundId: string) =>
  api.delete(url('/weddings/{weddingId}/funds/{fundId}', { weddingId, fundId }))

/* ── Сторона гостя ── */

/**
 * То же самое глазами гостя: у подарков видно, занят ли он, и свой ли это
 * резерв. `fairPrice` — деликатный ориентир «во сколько паре обходится один
 * гость»; он приходит пустым, пока бюджета или списка гостей нет, и
 * подставлять вместо него число нельзя.
 */
export const getGuestGifts = (token: string) =>
  api.get(url('/gifts/{guestToken}', { guestToken: token }))

export const reserveGift = (token: string, giftId: string) =>
  api.post(url('/gifts/{guestToken}/{giftId}/reserve', { guestToken: token, giftId }), {}, { idempotencyKey: newIdempotencyKey() })

/** Снять СВОЙ резерв. Чужой снять нельзя — сервер об этом и не спрашивает. */
export const releaseGift = (token: string, giftId: string) =>
  api.delete(url('/gifts/{guestToken}/{giftId}/reserve', { guestToken: token, giftId }))

/** Складчина: часть суммы подарка. Сумма — в копейках. */
export const fundGift = (token: string, giftId: string, amount: number) =>
  api.post(
    url('/gifts/{guestToken}/{giftId}/fund', { guestToken: token, giftId }),
    { amount: { amount, currency: 'RUB' } },
    { idempotencyKey: newIdempotencyKey() },
  )

/** Перевод в денежный фонд. */
export const contributeToFund = (token: string, fundId: string, amount: number) =>
  api.post(
    url('/gifts/{guestToken}/funds/{fundId}', { guestToken: token, fundId }),
    { amount: { amount, currency: 'RUB' } },
    { idempotencyKey: newIdempotencyKey() },
  )

/* ── Общий фотоальбом ── */

/**
 * Кадры гостей. Пара читает по своему токену, гость — по своему параметром
 * `guestToken`: один и тот же путь, разные ключи.
 */
export const getAlbum = (weddingId: string) =>
  api.get(url('/weddings/{weddingId}/album', { weddingId }))

/** Одобрить или скрыть кадр. Скрытый виден только паре. */
export const setPhotoApproved = (weddingId: string, photoId: string, approved: boolean) =>
  api.patch(url('/weddings/{weddingId}/album/{photoId}', { weddingId, photoId }), { approved })
