import { useStore } from './store'

/*
 * i18n: ключ = русская строка. t() работает без хуков (читает модульный текущий язык),
 * перерендер при смене языка обеспечивается key={lang} на уровне Shell в App.tsx.
 * Строки без перевода отображаются на русском (fallback).
 */
export type Lang = 'ru' | 'en'
let cur: Lang = 'ru'
export function setI18nLang(l: Lang) { cur = l }
export function getI18nLang(): Lang { return cur }

const EN: Record<string, string> = {
  /* DICT */
}

export function t(s: string): string {
  return cur === 'en' ? (EN[s] ?? s) : s
}

export function useT() {
  const { lang } = useStore()
  return (s: string) => (lang === 'en' ? (EN[s] ?? s) : s)
}
