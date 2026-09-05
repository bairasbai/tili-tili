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
  packages?: { name: string; price: number }[]
}

export const saveVendorProfile = (draft: VendorDraft) =>
  api.put('/vendor/profile', {
    name: draft.name,
    categoryId: draft.categoryId,
    city: draft.city,
    ...(draft.about ? { about: draft.about } : {}),
    ...(draft.phone ? { phone: draft.phone } : {}),
    ...(draft.priceFrom ? { priceFrom: { amount: draft.priceFrom, currency: 'RUB' } } : {}),
    ...(draft.packages?.length
      ? { packages: draft.packages.map(p => ({ name: p.name, price: { amount: p.price, currency: 'RUB' } })) }
      : {}),
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

/* ── сделки, обновления, аналитика ── */

export const getVendorDeals = () => api.get('/vendor/deals')

/** Что поменяли пары по забронированным свадьбам: рассадка, меню, тайминг, гости. */
export const getVendorUpdates = () => api.get('/vendor/updates')

/** Подтверждение убирает строку из списка; повтор ничего не меняет. */
export const ackVendorUpdate = (updateId: string) =>
  api.post(url('/vendor/updates/{updateId}/ack', { updateId }), {})

export const getVendorAnalytics = (period: 'month' | 'season' | 'year' = 'season') =>
  api.get(`/vendor/analytics?period=${period}` as '/vendor/analytics')

/*
 * Отправки документов на верификацию здесь пока нет намеренно.
 *
 * `POST /vendor/verification` требует ссылку на файл, а файл кладётся в
 * объектное хранилище, которого нет. Запрос без ссылки отвечает «не прошёл
 * проверку» — правда про формат и ложь про причину. Экран верификации
 * объясняет словами, чего ждать; функция появится вместе с хранилищем.
 */
