import { getI18nLang } from './i18n'

/**
 * Дата свадьбы: хранение, показ и обратный отсчёт.
 *
 * Хранится строкой `YYYY-MM-DD` — тем же видом, что принимает сервер.
 * Объект `Date` в localStorage превращается в строку с часовым поясом,
 * и свадьба «14 июня» у человека восточнее Москвы читалась бы как 13-е.
 *
 * Всё здесь — чистые функции: «сейчас» приходит аргументом. Время внутри
 * рендера запрещено (правило R-04), а тесту нужен предсказуемый день.
 */
export const ISO = /^\d{4}-\d{2}-\d{2}$/

/** Границы выбора: год назад и пять лет вперёд — как на сервере. */
export const PAST_YEARS = 1
export const FUTURE_YEARS = 5

export const dateToIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Полдень, а не полночь: сдвиг пояса не перебросит дату на соседний день. */
export const isoToDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!, 12)
}

export function isRealIso(value: string): boolean {
  if (!ISO.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const probe = new Date(y!, m! - 1, d!, 12)
  return probe.getFullYear() === y && probe.getMonth() === m! - 1 && probe.getDate() === d
}

export function dateRange(now: Date): { min: Date; max: Date } {
  return {
    min: new Date(now.getFullYear() - PAST_YEARS, now.getMonth(), now.getDate(), 12),
    max: new Date(now.getFullYear() + FUTURE_YEARS, now.getMonth(), now.getDate(), 12),
  }
}

export function inRange(iso: string, now: Date): boolean {
  const { min, max } = dateRange(now)
  return iso >= dateToIso(min) && iso <= dateToIso(max)
}

/** «14 июня 2027» / «14 June 2027». Месяц даёт Intl, а не словарь: склонения. */
export function formatWeddingDate(iso: string | null): string {
  if (!iso || !isRealIso(iso)) return ''
  return new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(isoToDate(iso))
}

/** «14.06.2027» — короткая подпись для плашек и документов. */
export function shortWeddingDate(iso: string | null): string {
  if (!iso || !isRealIso(iso)) return ''
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/**
 * Сколько дней осталось. Прошедшая свадьба даёт 0, а не отрицательное:
 * «−12 дней до свадьбы» на главной читается как поломка.
 */
export function daysUntil(iso: string | null, now: Date): number {
  if (!iso || !isRealIso(iso)) return 0
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime()
  return Math.max(0, Math.round((isoToDate(iso).getTime() - start) / 86_400_000))
}

export interface Countdown {
  m: number
  d: number
  h: number
  min: number
}

/**
 * `now` плюс N календарных месяцев, БЕЗ переполнения в следующий месяц.
 *
 * `new Date(y, m, 31)` для месяца короче 31 дня уезжает вперёд: 31 февраля
 * становится 3 марта. Поэтому число дня подрезается по длине целевого месяца:
 * 31 января плюс месяц — это 28 февраля, а не 3 марта.
 */
function addMonths(now: Date, months: number): Date {
  const m = now.getMonth() + months
  // Нулевой день следующего месяца — это последний день нужного.
  const lastDay = new Date(now.getFullYear(), m + 1, 0).getDate()
  return new Date(
    now.getFullYear(), m, Math.min(now.getDate(), lastDay),
    now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds(),
  )
}

/**
 * Обратный отсчёт: месяцы, дни, часы, минуты до 16:00 дня свадьбы.
 *
 * Месяцы считаются календарём, а не делением на 30: между 14 января и
 * 14 марта ровно два месяца, а не «1 месяц 29 дней».
 *
 * Перебрали на месяц — пересчитываем якорь с меньшим числом месяцев от той же
 * исходной точки. Откатывать сам якорь через setMonth(-1) нельзя: он уже
 * переполнен, и вычитание месяца возвращает не исходное число, а смещённое
 * (3 марта − 1 месяц = 3 февраля вместо 31 января). Отсюда брались лишние
 * трое суток в отсчёте у пары, открывшей главный экран 31-го числа.
 */
export function countdownTo(iso: string | null, now: Date): Countdown {
  const zero = { m: 0, d: 0, h: 0, min: 0 }
  if (!iso || !isRealIso(iso)) return zero
  const target = isoToDate(iso)
  target.setHours(16, 0, 0, 0)
  if (target.getTime() <= now.getTime()) return zero

  let months = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth())
  let anchor = addMonths(now, months)
  if (anchor.getTime() > target.getTime()) {
    months -= 1
    anchor = addMonths(now, months)
  }
  let rest = target.getTime() - anchor.getTime()
  const d = Math.floor(rest / 86_400_000)
  rest -= d * 86_400_000
  const h = Math.floor(rest / 3_600_000)
  rest -= h * 3_600_000
  return { m: Math.max(0, months), d, h, min: Math.floor(rest / 60_000) }
}
