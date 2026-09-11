import type { Queryable } from '../plugins/db.js'

/**
 * Рейтинг подрядчика: взвешенное среднее с затуханием по времени.
 *
 * Свежий отзыв весит больше старого — иначе мастер, собравший пятёрки три
 * года назад, вечно стоит выше того, кто хорошо работает сейчас. Период
 * полураспада — год: отзыв двухлетней давности весит вчетверо меньше
 * вчерашнего, но не исчезает совсем.
 */
const HALF_LIFE_DAYS = 365

/**
 * Сколько отзывов ПАР нужно, чтобы показать число (План §18.2; фича 005, В4).
 *
 * Один отзыв от знакомого — это 5,0 и первое место в выдаче. До трёх
 * отзывов в каталоге стоит «Новый на платформе», а не цифра, которой
 * нельзя верить. Считаются только отзывы пар: за парой подтверждённая
 * сделка, а трёх гостей одной свадьбы хватало, чтобы открыть «5,0» без
 * единого нарушенного правила. Гостевые отзывы остаются в среднем и в
 * `reviewsCount` — открыть число они не могут.
 */
export const MIN_REVIEWS_TO_SHOW = 3

export function decayWeight(ageDays: number): number {
  return 0.5 ** (Math.max(ageDays, 0) / HALF_LIFE_DAYS)
}

/**
 * Вес источника (§15): у пары подтверждённая сделка и договор, у гостя —
 * впечатление участника. Оба сигнала полезны, но равными их считать нельзя:
 * гостей на свадьбе полторы сотни, а сделка одна.
 */
export const SOURCE_WEIGHT = { couple: 1, guest: 0.5 } as const

export type ReviewSource = keyof typeof SOURCE_WEIGHT

export function weightedRating(reviews: { stars: number; ageDays: number; source?: ReviewSource }[]): number | null {
  if (reviews.length === 0) return null
  let sum = 0
  let weight = 0
  for (const review of reviews) {
    const w = decayWeight(review.ageDays) * SOURCE_WEIGHT[review.source ?? 'couple']
    sum += review.stars * w
    weight += w
  }
  if (weight === 0) return null
  return Math.round((sum / weight) * 10) / 10
}

/**
 * Пересчитывает рейтинг и число отзывов у подрядчика.
 *
 * Скрытые модератором отзывы не считаются вовсе: скрыть оскорбление и
 * оставить его звёзды в рейтинге значило бы наказать подрядчика за то,
 * что уже признано недопустимым.
 *
 * Число отзывов пар ведётся той же строкой: по нему каталог решает, показывать
 * ли рейтинг, и в сортировке с фильтром оно стоит на каждой строке выдачи —
 * подзапросом там было бы дорого.
 */
export async function recomputeRating(db: Queryable, vendorId: string): Promise<void> {
  const { rows } = await db.query<{ stars: number; age_days: string; source: ReviewSource }>(
    `select stars, source, extract(epoch from (now() - created_at)) / 86400 as age_days
       from reviews where vendor_id = $1 and hidden_at is null`,
    [vendorId],
  )
  const rating = weightedRating(
    rows.map((r) => ({ stars: r.stars, ageDays: Number(r.age_days), source: r.source })),
  )
  await db.query('update vendors set rating = $2, reviews_count = $3, couple_reviews_count = $4 where id = $1', [
    vendorId,
    rating,
    rows.length,
    rows.filter((r) => r.source === 'couple').length,
  ])
}

/**
 * Пересчёт всех рейтингов: затухание идёт по времени, а не по событиям.
 *
 * Без него у подрядчика без новых отзывов рейтинг застывает: он пересчитан
 * в день последнего отзыва и с тех пор не менялся, хотя веса давно уплыли.
 */
export async function recomputeAllRatings(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ id: string }>('select id from vendors where reviews_count > 0')
  for (const vendor of rows) await recomputeRating(db, vendor.id)
  return rows.length
}

/** Число, которое можно показать: до трёх отзывов ПАР его нет — гостевые число не открывают. */
export function publicRating(rating: number | null, coupleReviewsCount: number): number | null {
  return coupleReviewsCount >= MIN_REVIEWS_TO_SHOW ? rating : null
}
