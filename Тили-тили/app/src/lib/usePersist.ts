import { useCallback, useRef, useState } from 'react'

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
export function usePersist<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void, () => void] {
  const revision = useRef(0)
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = safeGet(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch { return initial }
  })
  /* Сеттер стабилен между рендерами: иначе useMemo/useCallback, которые от него
     зависят, пересобирались бы на каждый рендер и мемоизация теряла бы смысл. */
  const set = useCallback((v: T | ((p: T) => T)) => {
    const captured = revision.current
    setValue(prev => {
      if (captured !== revision.current) return prev
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      if (captured !== revision.current) return prev
      safeSet(key, JSON.stringify(next))
      return next
    })
  }, [key])
  /* Logout clears storage at invocation. Its state reset must never enqueue a
     persistence write: React can replay that update after the logout cleanup. */
  const clear = useCallback(() => {
    revision.current += 1
    try { localStorage.removeItem(key) } catch { /* storage disabled */ }
    setValue(initial)
  }, [key, initial])
  return [value, set, clear]
}
