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

export function useServerHealth(): ServerState {
  const [state, setState] = useState<ServerState>('unknown')

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const check = async () => {
      try {
        await api.get('/health')
        if (alive) setState('up')
      } catch (e) {
        /* Сервер ответил ошибкой приложения — значит он жив, и плашка не нужна. */
        if (alive) setState(e instanceof ApiError && !e.isDown ? 'up' : 'down')
      }
      if (alive) timer = setTimeout(check, RETRY_MS)
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
