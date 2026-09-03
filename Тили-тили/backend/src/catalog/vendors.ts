import type { Db } from '../plugins/db.js'
import { publicRating } from '../reviews/rating.js'

/**
 * Сборка карточек подрядчика в один слой.
 *
 * Здесь же проходит граница «что видно снаружи»: в ответ попадают только эти
 * поля. Документы верификации (`vendor_verifications.file_url`) не выбираются
 * ни одним запросом каталога — наружу выходит только признак `verified`
 * (план §6). Это условие закреплено тестом, который ищет `file_url` в теле.
 */
export interface VendorRow {
  id: string
  name: string
  category_id: string
  city: string | null
  price_from: string | null
  currency: string
  rating: string | null
  reviews_count: number
  photo_url: string | null
  verified_at: Date | null
  has_video: boolean
  created_at: Date
}

/**
 * Анкета видна в каталоге, только пока её владелец в сервисе.
 *
 * Удаление аккаунта мягкое — строка остаётся на 30 дней, — но человек уже
 * ушёл: показывать его анкету и принимать по ней заявки нельзя. Условие
 * живёт здесь, рядом с набором колонок, чтобы его нельзя было забыть
 * в очередном запросе каталога.
 */
/* Живая анкета: аккаунт не удалён и подрядчик не заблокирован модерацией.
 * Блокировка — крайняя санкция §18.2, и она означает «нет в выдаче»,
 * а не «есть, но с пометкой». */
export const VENDOR_LIVE_JOIN =
  'join users u on u.id = v.user_id and u.deleted_at is null and v.blocked_at is null'

export const VENDOR_COLUMNS = `
  v.id, v.name, v.category_id, c.name as city, v.price_from::text as price_from, v.currency,
  v.rating::text as rating, v.reviews_count, v.photo_url, v.verified_at, v.created_at,
  exists (select 1 from vendor_media m where m.vendor_id = v.id and m.kind = 'video') as has_video`

export function toVendor(r: VendorRow) {
  return {
    id: r.id,
    name: r.name,
    categoryId: r.category_id,
    city: r.city,
    priceFrom: r.price_from === null ? null : { amount: Number(r.price_from), currency: r.currency },
    /* До трёх отзывов числа нет — в выдаче стоит «Новый на платформе»
     * (План §18.2). Один отзыв от знакомого это 5,0 и первое место, и
     * прятать цифру надо здесь, в одном месте на все ответы каталога. */
    rating: publicRating(r.rating === null ? null : Number(r.rating), r.reviews_count),
    reviewsCount: r.reviews_count,
    photoUrl: r.photo_url,
    verified: r.verified_at !== null,
    hasVideo: r.has_video,
  }
}

export interface PackageRow {
  id: string
  name: string
  price: string | null
  currency: string
  items: string[]
}

export interface MediaRow {
  kind: 'photo' | 'video'
  url: string
  duration_s: number | null
}

export async function loadDetail(db: Db, vendorId: string, row: VendorRow) {
  const { rows: packages } = await db.query<PackageRow>(
    `select id, name, price::text as price, currency, items from vendor_packages
      where vendor_id = $1 order by sort, name`,
    [vendorId],
  )
  const { rows: media } = await db.query<MediaRow>(
    'select kind, url, duration_s from vendor_media where vendor_id = $1 order by sort, url',
    [vendorId],
  )
  return {
    ...toVendor(row),
    about: row_about(row),
    gallery: media.filter((m) => m.kind === 'photo').map((m) => m.url),
    media: media.map((m) => ({ kind: m.kind, url: m.url, durationS: m.duration_s })),
    packages: packages.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price === null ? null : { amount: Number(p.price), currency: p.currency },
      includes: p.items,
    })),
    // Отзывы приходят на этапе 8 вместе с их таблицей; сейчас список пуст,
    // а не отсутствует — фронт рисует «отзывов пока нет», а не падает.
    reviews: [],
  }
}

/** `about` живёт в той же строке, но не входит в карточку выдачи. */
function row_about(row: VendorRow & { about?: string | null }): string | null {
  return row.about ?? null
}

/**
 * Ротация новичков: доля первой страницы отдана анкетам без отзывов.
 *
 * Без неё каталог зарастает: у кого есть отзывы, тот получает показы, получает
 * ещё отзывы и вытесняет новых навсегда. План §19.2 требует 10 %.
 *
 * Применяется только к первой странице. На страницах с курсором подмена
 * привела бы к повторам и пропускам: строка, вставленная в середину, сдвигает
 * всё, что идёт после неё.
 */
export interface Rotated<T> {
  items: T[]
  /** Сколько строк основной выдачи осталось. По ним считается курсор. */
  keptFromMain: number
}

export function rotateNewcomers<T extends { reviewsCount: number }>(
  items: T[],
  limit: number,
  pool: T[],
): Rotated<T> {
  const need = Math.ceil(limit / 10)
  const have = items.filter((v) => v.reviewsCount === 0).length
  if (have >= need || pool.length === 0) return { items, keptFromMain: items.length }

  const missing = Math.min(need - have, pool.length)
  const known = new Set(items.map((v) => (v as unknown as { id: string }).id))
  const additions = pool.filter((v) => !known.has((v as unknown as { id: string }).id)).slice(0, missing)
  if (additions.length === 0) return { items, keptFromMain: items.length }

  // Новички занимают места в хвосте: верх выдачи остаётся у тех, кого
  // выбрала сортировка, а вытесняются самые слабые из показанных.
  const kept = items.slice(0, Math.max(0, items.length - additions.length))
  return { items: [...kept, ...additions], keptFromMain: kept.length }
}
