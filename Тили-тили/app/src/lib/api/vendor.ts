import { api, url } from './client'

/*
 * Кабинет подрядчика.
 *
 * Вторая сторона рынка: пока анкета живёт в браузере, пара бронирует пустоту.
 * Прежний кабинет был витриной целиком — «Елена Смирнова», 7 заявок, 4.9
 * звезды и календарь в `tt_vendor_busy` — и ни одна цифра не относилась к тому,
 * кто на него смотрел.
 *
 * Здесь всё идёт на сервер: анкета, публикация, занятость, заявки, отзывы,
 * сделки, обновления от пар и аналитика.
 */

/** Своя анкета. 404 — анкеты ещё нет, это нормальный ответ для нового подрядчика. */
export const getVendorProfile = () => api.get('/vendor/profile')

export interface VendorDraft {
  name: string
  categoryId: string
  city: { name: string; region?: string }
  about?: string
  /** Рабочий телефон: отдельное поле анкеты, а не номер входа. */
  phone?: string
  /** Цена «от» в копейках. */
  priceFrom?: number
  /** Пакеты услуг. Цена — копейки; `null` — цена не названа (пакет заведён вне
   *  мастера: сервер хранит и отдаёт его без цены). Мастер `null` не подменяет
   *  нулём и сам пакет без цены не заводит (ERR-0281, R-281). */
  packages?: { name: string; price: number | null }[]
  /**
   * Права на фото и видео портфолио и согласие снятых (152-ФЗ, план бэкенда §7).
   * Только `true` что-то значит — сервер ставит момент и не снимает его;
   * `false` не отправляем: подтверждение не отзывается сохранением имени.
   */
  mediaRights?: boolean
}

export const saveVendorProfile = (draft: VendorDraft) =>
  api.put('/vendor/profile', {
    name: draft.name,
    categoryId: draft.categoryId,
    city: draft.city,
    ...(draft.about ? { about: draft.about } : {}),
    ...(draft.phone ? { phone: draft.phone } : {}),
    ...(draft.priceFrom ? { priceFrom: { amount: draft.priceFrom, currency: 'RUB' } } : {}),
    ...(draft.mediaRights ? { mediaRights: true } : {}),
    /* Пакеты отправляем всегда, даже пустым списком: правило сервера —
       «поля нет, значит не трогай». Без этого удалённый последний пакет
       остался бы жить в анкете. Портфолио, наоборот, не отправляем вовсе —
       мастер им не занимается, и стирать его нечем. */
    /* Пакет без цены уходит без поля `price`: контракт `VendorUpsert` знает
       только отсутствие цены (`price?: Money`, openapi.yaml:4652), а `null`
       сервер отвергает 422 (`MONEY_SCHEMA` без `nullable`, routes/vendor.ts:22-30).
       Отсутствующее поле он хранит как `null` (routes/vendor.ts:293) — цена
       остаётся не названной, а не становится «0 ₽» (ERR-0281, R-281). */
    packages: (draft.packages ?? []).map(p => ({
      name: p.name,
      ...(p.price === null ? {} : { price: { amount: p.price, currency: 'RUB' } }),
    })),
  })

/** Публикация: анкета появляется в каталоге, модерация идёт следом (пост-модерация). */
export const publishVendorProfile = () => api.post('/vendor/profile/publish', {})

/* ── занятость ── */

/** Месяц в виде `2027-06`. Ответ — только те дни, у которых есть состояние. */
export const getVendorCalendar = (month: string) =>
  api.get(`/vendor/calendar?month=${encodeURIComponent(month)}` as '/vendor/calendar')

/**
 * Закрыть или открыть даты.
 *
 * Занятость от сделки сервер ставит сам и руками её не снять: `source` у такой
 * записи — `deal`, и подрядчик, «открывший» забронированный день, увёл бы у
 * пары дату, о которой они договорились.
 */
export const setVendorBusy = (dates: string[], status: 'busy' | 'free') =>
  api.post('/vendor/calendar/busy', { dates, status })

/* ── заявки ── */

export const getVendorLeads = () => api.get('/vendor/leads')

/**
 * Действие по заявке: ответить, взять дату на 72 часа, отклонить, вернуть.
 *
 * `hold` — не пометка в списке: он держит дату в календаре и виден паре.
 */
export const leadAction = (leadId: string, action: 'reply' | 'hold' | 'decline' | 'reopen', text?: string) =>
  api.post(url('/vendor/leads/{leadId}', { leadId }), { action, ...(text ? { text } : {}) })

/* ── отзывы ── */

export const getVendorReviews = () => api.get('/vendor/reviews')

export const replyToReview = (reviewId: string, text: string) =>
  api.post(url('/vendor/reviews/{reviewId}/reply', { reviewId }), { text })

/* ── запросы предложений (019) ── */

export type VendorOfferRequest = components['schemas']['OfferRequest']
export type VendorOfferInput = components['schemas']['OfferInput']

/** Только запросы текущего подрядчика; чужие кандидаты в ответ не входят. */
export const getVendorOfferRequests = () => api.get('/vendor/offer-requests')

/** Одна попытка ответа. Ключ приходит с формы и переживает сетевой повтор. */
export const sendVendorOffer = (
  requestId: string,
  body: VendorOfferInput,
  idempotencyKey: string,
) => api.post(
  url('/vendor/offer-requests/{requestId}/offers', { requestId }),
  body,
  { idempotencyKey },
)


/* ── сделки, обновления, аналитика ── */

export const getVendorDeals = () => api.get('/vendor/deals')

/** Что поменяли пары по забронированным свадьбам: рассадка, меню, тайминг, гости. */
export const getVendorUpdates = () => api.get('/vendor/updates')

/** Подтверждение убирает строку из списка; повтор ничего не меняет. */
export const ackVendorUpdate = (updateId: string) =>
  api.post(url('/vendor/updates/{updateId}/ack', { updateId }), {})

export const getVendorAnalytics = (period: 'month' | 'season' | 'year' = 'season') =>
  api.get(`/vendor/analytics?period=${period}` as '/vendor/analytics')

/* ── верификация ── */

/**
 * Состояние последней заявки на верификацию.
 *
 * Отвечает на вопрос, на который галочка не отвечает: дошли ли документы и
 * что с ними решили. Ни ссылки на документ, ни ИНН в ответе нет — они свои,
 * но экрану не нужны, и на устройстве им не место.
 *
 * Без анкеты — 403, как и остальные пути кабинета: заявки просто не может
 * быть. Экран читает это как «заявки нет», а не как поломку.
 */
export const getVerificationStatus = () => api.get('/vendor/verification')

/*
 * Отправки документов на верификацию здесь пока нет намеренно.
 *
 * `POST /vendor/verification` требует ссылку на файл, а файл кладётся в
 * объектное хранилище, которого нет. Запрос без ссылки отвечает «не прошёл
 * проверку» — правда про формат и ложь про причину. Экран верификации
 * объясняет словами, чего ждать; функция появится вместе с хранилищем.
 */
