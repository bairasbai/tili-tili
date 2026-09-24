import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { getI18nLang } from './i18n'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/* Копирование с фолбэком: navigator.clipboard недоступен в не-HTTPS и части WebView */
export function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
  } else legacyCopy(text)
}
function legacyCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
  document.body.appendChild(ta)
  ta.focus(); ta.select()
  try { document.execCommand('copy') } catch { /* noop */ }
  ta.remove()
}

/* Назад с фолбэком: при прямом заходе по ссылке истории нет — ведём на главную */
export function goBack(nav: (n: number) => void, go: (to: string, opts?: { replace?: boolean }) => void, fallback = '/home') {
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  if (idx > 0) nav(-1); else go(fallback, { replace: true })
}

/*
 * Русское число: «1 гость», «2 гостя», «5 гостей».
 *
 * Английский обходится двумя формами, русский — тремя, и правило зависит от
 * последних двух цифр: 11–14 всегда берут третью форму, иначе решает последняя.
 * Подставлять одну форму на все числа значит писать «1 гостей» на каждом
 * экране, где есть счётчик.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  /* В английском интерфейсе формы приходят уже переведёнными (`t('гость')` →
     «guest»), а правило — русское: 21 давало «21 guest». Категорию считает
     `Intl.PluralRules` текущего языка (сверка планов 2026-09-18, ICU): у
     английского две формы — «one» и всё остальное. Русское правило оставлено
     руками: оно и раньше было верным, а `Intl` в нём не нужен. */
  if (getI18nLang() === 'en') return new Intl.PluralRules('en').select(n) === 'one' ? one : many
  const mod100 = Math.abs(n) % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  const mod10 = mod100 % 10
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/**
 * Доля в процентах.
 *
 * Пустой список — это 0%, а не «NaN%»: деление на ноль давало на экране
 * буквальное «NaN%» в прогрессе чек-листа и в занятости автобуса.
 */
export const pct = (part: number | undefined, total: number | undefined) =>
  total && total > 0 ? Math.round(((part ?? 0) / total) * 100) : 0

/**
 * Экранирование HTML для генераторов документов (R-273, CLAUDE.md §5.5:
 * «генераторы документов интерполируют строки, а не вставляют код»).
 *
 * Значение может прийти из чужой анкеты (имя подрядчика — F-RL5-01) или из
 * формы пользователя (ФИО, паспорт) и подставляется в HTML, который уходит в
 * `document.write` или в файл — сток без автоэкранирования React. `&`
 * заменяется первым: иначе `&lt;`, появившийся на следующем шаге, превратился
 * бы в `&amp;lt;` при последующей замене `&`.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Текущий месяц вида `2027-06` — МЕСТНЫЙ, а не UTC (F-RL-8-06, ревью 016).
 *
 * Дашборд подрядчика открывался через `toISOString().slice(0, 7)`. Первого
 * числа ночью подрядчик в Москве видел выручку и занятые даты ЗА ПРОШЛЫЙ
 * месяц, в Камчатке — почти весь первый день. Ошибка тихая: цифры
 * настоящие, просто не за тот месяц.
 *
 * Живёт здесь, а не рядом с экраном: файл с компонентами не экспортирует
 * ничего, кроме компонентов (`react-refresh/only-export-components`) — правило
 * поймало эту же правку на гейте сразу после того, как гейт свели с CI.
 */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Какая вкладка подсвечена: ОДНА, самая точная из подходящих (F-RL-8-05).
 *
 * Нижняя навигация пары сравнивала путь через `startsWith`, а `/us/chats`
 * лежит внутри `/us` — на экране чатов горели сразу две вкладки, «Чаты» и
 * «Мы», и человек не видел, где он на самом деле. Навигация кабинета
 * подрядчика обходила то же самое отдельным условием только для своей
 * корневой вкладки — теперь правило одно на обе навигации.
 *
 * Совпадение — по границе сегмента (`/us` не подсвечивается на `/uslugi`),
 * побеждает самый длинный префикс.
 */
export function activeTab(tabs: readonly { to: string }[], pathname: string): string | null {
  let best: string | null = null
  for (const tb of tabs) {
    if (pathname !== tb.to && !pathname.startsWith(`${tb.to}/`)) continue
    if (best === null || tb.to.length > best.length) best = tb.to
  }
  return best
}
