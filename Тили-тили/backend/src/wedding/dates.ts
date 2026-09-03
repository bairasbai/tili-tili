import { AppError } from '../errors.js'

/**
 * Проверка дат на входе.
 *
 * Шаблон `^\d{4}-\d{2}-\d{2}$` пропускает 30 февраля и тринадцатый месяц:
 * такая строка доходит до PostgreSQL и роняет запрос — человек получает
 * 500 вместо внятного отказа, а в Sentry летит ложный инцидент. Формат
 * `date` в JSON Schema это ловит, но он стоял только у свадьбы; перенос,
 * календарь подрядчика, дедлайн брони отеля и фильтр каталога принимали
 * что угодно.
 */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Календарная ли дата. `2027-02-30` — нет, хотя по форме похожа. */
export function isRealDate(value: string): boolean {
  const m = SHAPE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Год ноль в календаре есть только у астрономов, а в PostgreSQL его нет.
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return false
  const probe = new Date(Date.UTC(y, mo - 1, d))
  // Перескок «31 апреля → 1 мая» ловится сравнением обратно по частям.
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
}

export function assertRealDate(value: string, field = 'date'): void {
  if (isRealDate(value)) return
  throw new AppError(422, 'bad_date', `Такой даты не существует: ${value}`, {
    [field]: 'ожидается календарная дата вида 2027-06-14',
  })
}

/**
 * Насколько далеко назад и вперёд бывает свадьба (решение владельца
 * 2026-09-03).
 *
 * Назад — год: раздел «После свадьбы» и отзывы нужны и тем, кто пришёл
 * в приложение уже после праздника. Вперёд — пять лет: дальше площадки
 * бронь не держат, а дата в 9999 году ломает расчёт сроков задач молча.
 */
export const PAST_YEARS = 1
export const FUTURE_YEARS = 5

/** Границы диапазона на сегодня — в виде `YYYY-MM-DD`. */
export function weddingDateRange(now = new Date()): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const from = new Date(Date.UTC(now.getUTCFullYear() - PAST_YEARS, now.getUTCMonth(), now.getUTCDate()))
  const to = new Date(Date.UTC(now.getUTCFullYear() + FUTURE_YEARS, now.getUTCMonth(), now.getUTCDate()))
  return { from: iso(from), to: iso(to) }
}

/**
 * Дата свадьбы: календарная и в разумных пределах.
 *
 * Сравниваем строки, а не объекты `Date`: обе в формате `YYYY-MM-DD`,
 * где лексикографический порядок совпадает с календарным, и никакой
 * часовой пояс в сравнение не вмешивается.
 */
export function assertWeddingDate(value: string, now = new Date()): void {
  assertRealDate(value)
  const { from, to } = weddingDateRange(now)
  if (value < from || value > to) {
    throw new AppError(422, 'date_out_of_range', `Дата свадьбы бывает с ${from} по ${to}`, {
      date: `ожидается дата между ${from} и ${to}`,
    })
  }
}
