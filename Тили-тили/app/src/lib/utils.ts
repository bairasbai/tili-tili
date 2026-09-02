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
