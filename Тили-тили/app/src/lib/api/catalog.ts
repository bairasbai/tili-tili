import { api, url } from './client'
import { t } from '../i18n'
import { plural } from '../utils'

/*
 * Каталог: категории, подрядчики, избранное.
 *
 * Мок в `lib/data.ts` держал 35 категорий и шесть подрядчиков, при этом
 * счётчики в категориях обещали 865 специалистов. На сервере их 1467
 * опубликованных — расхождение видно глазами с первого экрана.
 */

export interface Category { id?: string; title?: string; icon?: string }

/**
 * Отзывы есть, а оценки ещё нет: «2 отзыва · оценка с третьего».
 *
 * Сервер прячет рейтинг до третьего отзыва (`rating: null`, `reviewsCount`
 * честный), а три экрана — карточка в выдаче, анкета и сравнение — ветвились
 * по числу отзывов и печатали «★ null (2)» буквами (ревью D5-02). Ветвиться
 * надо по самой оценке; эта фраза — общий ответ на случай «отзывы без оценки»,
 * чтобы три экрана не разошлись в словах.
 */
export const reviewsPendingRating = (reviewsCount: number): string =>
  `${reviewsCount} ${plural(reviewsCount, t('отзыв'), t('отзыва'), t('отзывов'))} ${t('· оценка с третьего')}`

export interface Vendor {
  id?: string
  name?: string
  categoryId?: string
  city?: string
  priceFrom?: { amount?: number; currency?: string } | null
  rating?: number | null
  reviewsCount?: number
  photoUrl?: string | null
  verified?: boolean
  hasVideo?: boolean
  /** Километры от города поиска до города анкеты (фича 011): 0 — свой город, null — нет города или координат. */
  distanceKm?: number | null
}

export interface VendorFilters {
  q?: string
  categoryId?: string
  city?: string
  date?: string | null
  /** Верхняя граница «цены от», в копейках. */
  priceMax?: number
  ratingMin?: number
  hasVideo?: boolean
  sort?: 'rating' | 'price_asc' | 'price_desc' | 'popular'
  limit?: number
  /**
   * Курсор следующей страницы из `nextCursor` прошлого ответа. Без него список
   * категории обрывался на первой странице: в `decor` общей базы две тысячи
   * анкет, пара видела тридцать и остальных увидеть не могла (ревью D5-05).
   */
  cursor?: string | null
  /**
   * Радиус от города в километрах (фича 011): 0 — только город, без поля —
   * умолчание сервера (100). Сервер и раньше искал в 100 км молча — экран
   * этого не знал и не давал ни сузить, ни расширить.
   */
  radiusKm?: number
}

/** Строка запроса из фильтров: пустые значения не отправляем. */
function query(f: VendorFilters): string {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.categoryId) p.set('categoryId', f.categoryId)
  if (f.city) p.set('city', f.city)
  /* Ноль — значение, а не «не задано»: «только город» уходит как radiusKm=0. */
  if (f.radiusKm !== undefined) p.set('radiusKm', String(f.radiusKm))
  /* Дата свадьбы убирает из выдачи занятых: иначе пара пишет тому, кто
     заведомо не сможет (описание параметра в контракте). */
  if (f.date) p.set('date', f.date)
  /* Отбор считает сервер, а не браузер. Фильтровать загруженную страницу из
     тридцати записей значит показывать «дешевле 100 тысяч» из случайной
     тридцатки, а не из всего каталога: чип обещал бы то, чего не делает. */
  if (f.priceMax !== undefined) p.set('priceMax', String(f.priceMax))
  if (f.ratingMin !== undefined) p.set('ratingMin', String(f.ratingMin))
  if (f.hasVideo) p.set('hasVideo', 'true')
  if (f.sort) p.set('sort', f.sort)
  p.set('limit', String(f.limit ?? 30))
  if (f.cursor) p.set('cursor', f.cursor)
  return p.toString()
}

export const getCategories = () => api.get('/catalog/categories')

export function getVendors(f: VendorFilters) {
  /* Адрес собирается вручную, а не через `url()`: тот подставляет значения в
     фигурные скобки пути, а здесь строка запроса. Ключ в типах остаётся
     прежним — `/catalog/vendors`, — поэтому проверка контракта не теряется. */
  return api.get(`/catalog/vendors?${query(f)}` as '/catalog/vendors')
}

export const getVendor = (vendorId: string) =>
  api.get(url('/catalog/vendors/{vendorId}', { vendorId }))

/**
 * Заявка консьержу при пустой выдаче (План §18.12, фича 008).
 *
 * Путь был в контракте с самого начала, а экрана к нему не было: пустая
 * категория предлагала только «спросить Тиля». Бюджет — в копейках, как
 * везде (`rub()` на экране); город — город поиска из стора, сервер сам его
 * не выводит и без него заявка лежит без города. Вторая заявка по той же
 * категории, пока первая в работе, — 409 `concierge_pending` словами сервера.
 * Ответ 201 без тела: экран говорит ровно то, что обещает контракт —
 * «свяжемся в течение суток», и ничего сверх.
 */
export const requestConcierge = (categoryId: string, draft: { budget?: number; comment?: string; city?: string }) =>
  api.post('/catalog/concierge', {
    categoryId,
    ...(draft.budget !== undefined ? { budget: { amount: draft.budget, currency: 'RUB' } } : {}),
    ...(draft.comment ? { comment: draft.comment } : {}),
    ...(draft.city ? { city: draft.city } : {}),
  })

export const getFavorites = () => api.get('/me/favorites')

export const addFavorite = (vendorId: string) =>
  api.put(url('/me/favorites/{vendorId}', { vendorId }))

export const removeFavorite = (vendorId: string) =>
  api.delete(url('/me/favorites/{vendorId}', { vendorId }))

/** Занятые даты подрядчика на месяц `YYYY-MM`: по ним рисуется календарь. */
export function getAvailability(vendorId: string, month: string) {
  const path = url('/catalog/vendors/{vendorId}/availability', { vendorId })
  return api.get(`${path}?month=${encodeURIComponent(month)}` as typeof path)
}

/*
 * Отметки историй вдохновения.
 *
 * Сами истории живут во фронте — контракт говорит это прямо; на сервере
 * только идентификаторы отмеченных. Раньше отметки лежали в
 * `tt_inspo_likes`: на втором устройстве сердечки были пустые.
 */
export const getInspoLikes = () => api.get('/inspiration/likes')

export const likeStory = (storyId: string) =>
  api.put(url('/inspiration/likes/{storyId}', { storyId }), {})

export const unlikeStory = (storyId: string) =>
  api.delete(url('/inspiration/likes/{storyId}', { storyId }))
