/*
 * Заполненность анкеты подрядчика (План §8.2 «процент заполненности + подсказки»).
 *
 * Одно правило на кабинет и на панель: до сверки планов 2026-09-18 кабинет
 * считал шесть полей на клиенте (имя, категория, город, о себе, телефон,
 * пакеты), а панель — четыре в SQL (о себе, телефон, цена «от», пакеты), и
 * одна анкета получала два разных процента (класс ERR-0012). Имя, категория
 * и город обязательны при сохранении — их «незаполненность» невозможна,
 * считать их — раздувать процент. Фотографии не считаются, пока нет
 * хранилища (RELEASE-BLOCKERS №3): иначе «не хватает: фотографий» стояло бы
 * у каждой анкеты навсегда.
 *
 * Панель считает то же самое в SQL (`routes/admin.ts`, метрика `profiles`):
 * тест сверяет оба пути на одной анкете.
 */
export const COMPLETENESS_FIELDS = ['about', 'phone', 'priceFrom', 'packages'] as const
export type CompletenessField = (typeof COMPLETENESS_FIELDS)[number]

export interface CompletenessInput {
  about: string | null
  phone: string | null
  priceFrom: number | null
  packagesCount: number
}

export function profileCompleteness(v: CompletenessInput): { pct: number; missing: CompletenessField[] } {
  const filled: Record<CompletenessField, boolean> = {
    about: (v.about ?? '').trim() !== '',
    phone: v.phone !== null && v.phone !== '',
    priceFrom: v.priceFrom !== null,
    packages: v.packagesCount > 0,
  }
  const missing = COMPLETENESS_FIELDS.filter((f) => !filled[f])
  return { pct: Math.round(((COMPLETENESS_FIELDS.length - missing.length) / COMPLETENESS_FIELDS.length) * 100), missing }
}
