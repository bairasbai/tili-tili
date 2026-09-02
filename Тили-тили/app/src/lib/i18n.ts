import { EN } from './i18n.en'

/*
 * i18n: ключ = русская строка. t() работает без хуков (читает модульный текущий язык),
 * перерендер при смене языка обеспечивается key={lang} на уровне Shell в App.tsx.
 * Строки без перевода отображаются на русском (fallback).
 */
export type Lang = 'ru' | 'en'
let cur: Lang = (() => { try { return localStorage.getItem('tt_lang') === 'en' ? 'en' : 'ru' } catch { return 'ru' } })()
export function setI18nLang(l: Lang) { cur = l }
export function getI18nLang(): Lang { return cur }

export function t(s: string): string {
  return cur === 'en' ? (EN[s] ?? s) : s
}

/*
 * Перезагрузка с сохранением текущего роута — работает на любом статическом хостинге:
 * уходим на корень приложения (вычисляется из URL модуля, устойчиво к подпапкам превью),
 * а main.tsx восстанавливает путь из tt_redirect через history.replaceState.
 */
// Корень приложения вычисляется при загрузке модуля (до того, как клиентский роутер
// перепишет URL) — по относительному src entry-скрипта: устойчиво к подпапкам превью.
const APP_ROOT: string = (() => {
  try {
    const src = document.querySelector('script[type="module"]')?.getAttribute('src')
    if (src) return new URL('../', new URL(src, location.href)).pathname
  } catch { /* noop */ }
  return '/'
})()

/** Корень приложения: базовый путь без привязки к абсолютному '/'. */
export function appRoot(): string { return APP_ROOT }

export function reloadToRoot(): void {
  try {
    sessionStorage.setItem('tt_redirect', location.pathname + location.search + location.hash)
  } catch { /* noop */ }
  location.replace(APP_ROOT)
}
