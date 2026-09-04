import { useCallback, useEffect, useState } from 'react'
import { ApiError } from './client'
import { t } from '../i18n'

/*
 * Один способ показывать серверные данные на экране.
 *
 * До этого хука каждый экран изобретал бы свои три состояния — грузится,
 * ошибка, данные — и они разъехались бы по формулировкам и поведению уже на
 * третьем экране. Здесь они заданы один раз, вместе с правилом: пока данных
 * нет, экран честно говорит, что происходит, а не показывает пустоту.
 */

export interface AsyncData<T> {
  data: T | null
  /** Первая загрузка. Обновление уже показанных данных сюда не попадает. */
  loading: boolean
  /** Текст для человека, не код ошибки. Null — всё в порядке. */
  error: string | null
  /** Отказ по правам: раздел закрыт роли. Повторять бессмысленно. */
  forbidden: boolean
  reload: () => void
}

/** Сообщение для человека: «сервер лежит» и «сервер отказал» — разные вещи. */
export function explainError(e: unknown): string {
  if (e instanceof ApiError) return e.isDown ? t('Сервер недоступен. Попробуйте позже') : e.message
  return t('Что-то пошло не так')
}

/**
 * Загрузка данных с сервера.
 *
 * `deps` перечисляет то, от чего зависит запрос: сменился город или категория —
 * данные перезапрашиваются. Ответ устаревшего запроса отбрасывается: без этого
 * быстрый перебор фильтров оставляет на экране результат того запроса, который
 * ушёл раньше, но вернулся позже.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: readonly unknown[]): AsyncData<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [tick, setTick] = useState(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setForbidden(false)
    run()
      .then(v => { if (alive) { setData(v); setLoading(false) } })
      .catch(e => {
        if (!alive) return
        if (e instanceof ApiError && e.status === 403) setForbidden(true)
        else setError(explainError(e))
        setLoading(false)
      })
    return () => { alive = false }
  }, [run, tick])

  const reload = useCallback(() => setTick(n => n + 1), [])
  return { data, loading, error, forbidden, reload }
}
