import { useCallback, useState } from 'react'

/*
 * Обращение к localStorage может БРОСИТЬ, а не вернуть null.
 *
 * При заблокированных данных сайта (Chrome «блокировать все cookie», iframe
 * без allow-same-origin) само чтение свойства бросает SecurityError, а при
 * переполнении квоты бросает запись. Эти инициализаторы выполняются в фазе
 * рендера StoreProvider — необработанное исключение там кладёт приложение
 * на экран ErrorBoundary, из которого перезагрузка не выводит: провайдер
 * падает снова. Поэтому доступ к хранилищу идёт только через эти две функции.
 */

/** Чтение строки из localStorage. Хранилище недоступно — как будто ключа нет. */
export function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** Запись в localStorage. Недоступное хранилище и переполненная квота — не ошибка. */
export function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* хранилище заблокировано или квота */ }
}

/** useState с автосохранением в localStorage (мок до появления бэкенда). */
export function usePersist<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = safeGet(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch { return initial }
  })
  /* Сеттер стабилен между рендерами: иначе useMemo/useCallback, которые от него
     зависят, пересобирались бы на каждый рендер и мемоизация теряла бы смысл. */
  const set = useCallback((v: T | ((p: T) => T)) =>
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      safeSet(key, JSON.stringify(next))
      return next
    }), [key])
  return [value, set]
}
