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
