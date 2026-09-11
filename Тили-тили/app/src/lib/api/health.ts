import { useEffect, useState } from 'react'
import { api, ApiError } from './client'

/*
 * Доступность сервера — отдельно от доступности сети.
 *
 * `navigator.onLine` отвечает только на вопрос «есть ли у устройства сеть»:
 * при живом Wi-Fi и лежащем бэкенде он говорит «онлайн», и приложение молча
 * показывает пустые экраны. Поэтому спрашиваем сам сервер.
 *
 * `/health` выбран намеренно: он отвечает 200, пока жив процесс, и не зависит
 * от базы. Готовность базы — это `/health/ready`, и по нему выводят машину из
 * ротации, а не рисуют плашку пользователю (см. RUNBOOK §1).
 */

export type ServerState = 'unknown' | 'up' | 'down'

/** Как часто перепроверяем, когда сервер лежит. Чаще — бессмысленно долбим. */
const RETRY_MS = 15_000
/**
 * Как часто перепроверяем живой сервер. Реже, чем лежащий: плашка нужна,
 * когда он упал, а падение между двумя проверками покажет первый же обычный
 * запрос экрана. До ревью D6-12 живой сервер опрашивался так же, как
 * лежащий, — каждая открытая вкладка раз в 15 секунд.
 */
const UP_RECHECK_MS = 60_000

export function useServerHealth(): ServerState {
  const [state, setState] = useState<ServerState>('unknown')

  useEffect(() => {
    let alive = true
    /* Таймер один. Каждая проверка сначала снимает прежний, потом ставит свой:
       иначе `online` (смена Wi-Fi↔LTE) добавлял параллельную цепочку опроса,
       и на размонтировании отменялась только последняя (D6-12). */
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer)
      if (alive) timer = setTimeout(() => { void check() }, ms)
    }

    const check = async () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      let next: ServerState
      try {
        await api.get('/health')
        next = 'up'
      } catch (e) {
        /* Сервер ответил ошибкой приложения — значит он жив, и плашка не нужна. */
        next = e instanceof ApiError && !e.isDown ? 'up' : 'down'
      }
      if (!alive) return
      setState(next)
      schedule(next === 'up' ? UP_RECHECK_MS : RETRY_MS)
    }

    void check()
    /* Вернулась сеть — не ждём очередной круг, спрашиваем сразу. */
    const onOnline = () => { void check() }
    window.addEventListener('online', onOnline)

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  return state
}
