import { useEffect, useState } from 'react'
import { todayIn } from './weddingDate'

/** Same fallback as the API; update at midnight and after returning to the tab. */
export function useOfferDay(weddingTz?: string | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const update = () => setNow(Date.now())
    const timer = window.setInterval(update, 30_000)
    document.addEventListener('visibilitychange', update)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [])
  return todayIn(weddingTz || 'Europe/Moscow', now)
}
