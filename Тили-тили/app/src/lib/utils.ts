import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

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

