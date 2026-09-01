import { useState } from 'react'

/** useState с автосохранением в localStorage (мок до появления бэкенда). */
export function usePersist<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch { return initial }
  })
  const set = (v: T | ((p: T) => T)) =>
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  return [value, set]
}
