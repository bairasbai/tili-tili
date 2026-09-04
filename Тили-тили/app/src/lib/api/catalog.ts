import { api, url } from './client'

/*
 * Каталог: категории, подрядчики, избранное.
 *
 * Мок в `lib/data.ts` держал 35 категорий и шесть подрядчиков, при этом
 * счётчики в категориях обещали 865 специалистов. На сервере их 1467
 * опубликованных — расхождение видно глазами с первого экрана.
 */

export interface Category { id?: string; title?: string; icon?: string }

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
}

export interface VendorFilters {
  q?: string
  categoryId?: string
  city?: string
  date?: string | null
  sort?: 'rating' | 'price_asc' | 'price_desc' | 'popular'
  limit?: number
}

/** Строка запроса из фильтров: пустые значения не отправляем. */
function query(f: VendorFilters): string {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.categoryId) p.set('categoryId', f.categoryId)
  if (f.city) p.set('city', f.city)
  /* Дата свадьбы убирает из выдачи занятых: иначе пара пишет тому, кто
     заведомо не сможет (описание параметра в контракте). */
  if (f.date) p.set('date', f.date)
  if (f.sort) p.set('sort', f.sort)
  p.set('limit', String(f.limit ?? 30))
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
