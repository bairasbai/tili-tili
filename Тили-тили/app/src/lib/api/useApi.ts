import { useCallback, useEffect, useRef, useState } from 'react'
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
  /* Какой запрос уже показан: по нему отличаем смену адреса от перечитывания. */
  const lastRun = useRef<typeof run | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setForbidden(false)
    /*
     * Сменился запрос — старые данные сбрасываем: они относятся к другому
     * адресу. Без этого экран подрядчика, открытый по ссылке на удалённую
     * анкету, показывал карточку того, кого смотрели до неё, вместе с живой
     * кнопкой «Добавить в свадьбу»: проверка «анкета не пришла» не срабатывала,
     * потому что в состоянии лежала чужая.
     *
     * А вот на `reload()` того же запроса данные остаются: список перечитывают
     * после каждой галочки, и очистка давала бы мигание на ровном месте.
     */
    if (lastRun.current !== run) {
      lastRun.current = run
      setData(null)
    }
    run()
      .then(v => { if (alive) { setData(v); setLoading(false) } })
      .catch(e => {
        if (!alive) return
        /* И при отказе тоже: показывать данные рядом с сообщением об ошибке
           значит утверждать, что они актуальны. */
        setData(null)
        if (e instanceof ApiError && e.status === 403) setForbidden(true)
        else setError(explainError(e))
        setLoading(false)
      })
    return () => { alive = false }
  }, [run, tick])

  const reload = useCallback(() => setTick(n => n + 1), [])
  return { data, loading, error, forbidden, reload }
}
