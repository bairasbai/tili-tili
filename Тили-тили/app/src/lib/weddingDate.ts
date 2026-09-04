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

/*
 * Смещение часового пояса в минутах на конкретный момент.
 *
 * Готового способа «собрать метку времени в чужом поясе» в стандартной
 * библиотеке нет: Date умеет только UTC и пояс машины. Поэтому спрашиваем у
 * Intl, который час в нужном поясе в этот момент, и считаем разницу.
 */
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return (asIfUtc - utcMs) / 60_000
}

/**
 * Метка времени для «14 июня, 13:00 по месту свадьбы».
 *
 * Пояс берётся у свадьбы, а не у зрителя: пара может ставить тайминг из другого
 * города, но 13:00 означает 13:00 на площадке. Без пояса считаем время
 * локальным для UTC — иначе пришлось бы молча подставить пояс зрителя.
 */
export function isoAtWeddingTime(date: string, time: string, tz?: string): string | null {
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const hm = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!d || !hm) return null
  const [h, min] = [Number(hm[1]), Number(hm[2])]
  if (h > 23 || min > 59) return null
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, min)
  if (!tz) return new Date(guess).toISOString()
  return new Date(guess - tzOffsetMinutes(guess, tz) * 60_000).toISOString()
}

/**
 * Сетка месяца `YYYY-MM`: сколько в нём дней и сколько пустых клеток слева.
 *
 * Календарь рисовался как «тридцать клеток подряд, первая под понедельником».
 * Февраль получал тридцать дней, тридцать первое число пропадало, а числа
 * стояли не под своими днями недели — и человек читал «занят в субботу» по
 * чужой колонке.
 */
export function monthGrid(month: string): { days: number; blanks: number } {
  const m = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/)
  if (!m) return { days: 0, blanks: 0 }
  const [y, mo] = [Number(m[1]), Number(m[2])]
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  /* getUTCDay(): 0 — воскресенье, а неделя в календаре начинается с
     понедельника. Сдвигаем, иначе весь месяц уезжает на день. */
  const blanks = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7
  return { days, blanks }
}

/** «Июнь 2027» — заголовок месяца в календаре. */
export function monthTitle(month: string): string {
  const m = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/)
  if (!m) return ''
  const label = new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)))
  /* Русская локаль дописывает «г.» — в заголовке календаря он лишний. */
  return label.replace(/\s*г\.$/, '').replace(/^./, c => c.toUpperCase())
}

